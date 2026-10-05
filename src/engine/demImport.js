// Real terrain import: turn an elevation file into the engine's square grid.
// Supported: ESRI ASCII grids (.asc), SRTM tiles (.hgt) and greyscale
// heightmap images (decoded by the page, scaled with user-given width and
// height range). The centre of the data is cropped to the map size (2 km by
// default, or the data's own extent when smaller) and resampled bilinearly.

const NAMES = ['ncols', 'nrows', 'xllcorner', 'yllcorner', 'xllcenter', 'yllcenter', 'cellsize', 'dx', 'dy', 'nodata_value'];

/** ESRI ASCII grid. Rows run north → south. */
export function parseAsc(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const [key, value] = lines[i].trim().split(/\s+/);
    if (!key || !NAMES.includes(key.toLowerCase())) break;
    header[key.toLowerCase()] = Number(value);
  }
  const cols = header.ncols, rows = header.nrows, dx = header.cellsize ?? header.dx, dy = header.cellsize ?? header.dy ?? dx;
  if (!(cols > 1 && rows > 1 && dx > 0)) throw new Error('Not an ESRI ASCII grid (ncols / nrows / cellsize missing).');
  const values = new Float32Array(cols * rows), nodata = header.nodata_value ?? -9999;
  let k = 0;
  for (; i < lines.length && k < values.length; i++) {
    for (const token of lines[i].trim().split(/\s+/)) {
      if (!token) continue;
      const v = Number(token);
      values[k++] = v === nodata || !Number.isFinite(v) ? NaN : v;
    }
  }
  if (k < values.length) throw new Error(`ASCII grid ends early (${k} of ${values.length} values).`);
  // Degrees (geographic grids) → metres at the grid's latitude.
  const geographic = dx < 0.1 && Math.abs(header.yllcorner ?? header.yllcenter ?? 0) <= 90;
  const lat = (header.yllcorner ?? header.yllcenter ?? 0) + rows * dy / 2;
  return { cols, rows, values, dx: geographic ? dx * 111320 * Math.cos(lat * Math.PI / 180) : dx, dy: geographic ? dy * 110574 : dy, source: 'ESRI ASCII grid' };
}

/** SRTM .hgt: big-endian int16, 1201² (3″) or 3601² (1″); the name gives the latitude (N37E032.hgt). */
export function parseHgt(buffer, name = '') {
  const count = buffer.byteLength / 2, side = Math.round(Math.sqrt(count));
  if (side * side !== count || ![1201, 3601].includes(side)) throw new Error('Not an SRTM .hgt tile (expected 1201² or 3601² samples).');
  const view = new DataView(buffer), values = new Float32Array(count);
  for (let k = 0; k < count; k++) { const v = view.getInt16(k * 2, false); values[k] = v === -32768 ? NaN : v; }
  const m = /([NS])(\d{1,2})/i.exec(name), lat = m ? (m[1].toUpperCase() === 'S' ? -1 : 1) * (Number(m[2]) + 0.5) : 40;
  const step = 1 / (side - 1);
  return { cols: side, rows: side, values, dx: step * 111320 * Math.cos(lat * Math.PI / 180), dy: step * 110574, source: `SRTM ${side === 3601 ? '1″' : '3″'} tile` };
}

/** Greyscale heightmap from RGBA pixels (top row = north). */
export function parseHeightmap({ width, height, data }, { metresWide = 2000, minHeight = 0, maxHeight = 200 } = {}) {
  if (!(width > 1 && height > 1)) throw new Error('Heightmap image is empty.');
  const values = new Float32Array(width * height);
  for (let k = 0; k < values.length; k++) {
    const lum = (0.299 * data[k * 4] + 0.587 * data[k * 4 + 1] + 0.114 * data[k * 4 + 2]) / 255;
    values[k] = minHeight + lum * (maxHeight - minHeight);
  }
  const d = metresWide / (width - 1);
  return { cols: width, rows: height, values, dx: d, dy: d, source: 'heightmap image' };
}

/** Fill missing samples (voids, nodata) from their neighbours, outwards. */
function fillVoids(values, cols, rows) {
  for (let pass = 0; pass < 64; pass++) {
    let missing = 0;
    const next = values.slice();
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!Number.isNaN(values[k])) continue;
      let sum = 0, n = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < cols && jj < rows && !Number.isNaN(values[jj * cols + ii])) { sum += values[jj * cols + ii]; n++; }
      }
      if (n) next[k] = sum / n; else missing++;
    }
    values.set(next);
    if (!missing) return values;
  }
  if (values.some(Number.isNaN)) throw new Error('The file has no elevation values.');
  return values;
}

/**
 * Crop the centre `size` metres (or the data extent) and resample to n × n.
 * Returns a terrain object the engine accepts (heights row j = northing).
 */
export function gridToTerrain(grid, { size = 2000, n = 257, name = 'Uploaded map' } = {}) {
  const { cols, rows, dx, dy } = grid;
  const values = fillVoids(Float32Array.from(grid.values), cols, rows);
  const width = (cols - 1) * dx, height = (rows - 1) * dy;
  const span = Math.min(size, width, height);
  if (span < 500) throw new Error(`The area is too small (${Math.round(span)} m); at least 500 m is needed.`);
  const x0 = (width - span) / 2, y0 = (height - span) / 2, cell = span / (n - 1);
  const sample = (x, y) => { // x east from the west edge, y south from the north edge (data rows)
    const fx = Math.min(cols - 1.0001, x / dx), fy = Math.min(rows - 1.0001, y / dy), i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const at = (a, b) => values[b * cols + a];
    return at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
  };
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = sample(x0 + i * cell, y0 + (n - 1 - j) * cell);
  // Keep the lowest ground above sea level, as generated terrain does.
  let min = Infinity, max = -Infinity;
  for (const h of heights) { if (h < min) min = h; if (h > max) max = h; }
  if (min < 15) { const shift = Math.ceil(15 - min); for (let k = 0; k < heights.length; k++) heights[k] += shift; min += shift; max += shift; }
  if (max - min < 15) throw new Error(`The area is almost flat (${(max - min).toFixed(1)} m of relief); choose hillier ground.`);
  return { size: Math.round(span), n, cell, heights, meta: { world: 'custom', name, source: grid.source, archetypes: [], noiseShare: 0, min, max } };
}

/** Compact storage of an imported terrain (base64 float32). */
export function packTerrain(t) {
  const bytes = new Uint8Array(t.heights.buffer.slice(0));
  let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { size: t.size, n: t.n, name: t.meta.name, source: t.meta.source, heights: btoa(s) };
}

export function unpackTerrain(p) {
  const bin = atob(p.heights), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const heights = new Float32Array(bytes.buffer);
  if (heights.length !== p.n * p.n) throw new Error('Stored terrain is damaged.');
  let min = Infinity, max = -Infinity; for (const h of heights) { if (h < min) min = h; if (h > max) max = h; }
  return { size: p.size, n: p.n, cell: p.size / (p.n - 1), heights, meta: { world: 'custom', name: p.name, source: p.source, archetypes: [], noiseShare: 0, min, max } };
}
