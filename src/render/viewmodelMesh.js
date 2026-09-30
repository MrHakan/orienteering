// Original procedural FPS hands and knife meshes. No extracted game assets.
// Camera-space coordinates: X right, Y up, -Z forward. Material in component 10.
export const KNIVES = [
  { id: 'classic', label: 'CS 1.6 style knife' },
  { id: 'default', label: 'CS:GO style default' },
  { id: 'karambit', label: 'Karambit' },
  { id: 'huntsman', label: 'Huntsman / Hunter' },
];
export const CHARACTERS = [{ id: 'classic', label: 'CS 1.6 style · fingerless' }, { id: 'tactical', label: 'CS:GO style · tactical' }];
export const FINISHES = [{ id: 'steel', label: 'Steel' }, { id: 'fade', label: 'Fade' }, { id: 'tiger', label: 'Tiger stripe' }, { id: 'night', label: 'Night' }];
export function normaliseAppearance(value = {}) {
  const choose = (key, list, fallback) => list.some((p) => p.id === value[key]) ? value[key] : fallback;
  return { knife: choose('knife', KNIVES, 'karambit'), character: choose('character', CHARACTERS, 'tactical'),
    finish: choose('finish', FINISHES, 'steel'), handedness: value.handedness === 'left' ? 'left' : 'right' };
}

function builder() {
  const data = [];
  const tri = (a, b, c, color, metal = 0) => {
    const u = b.map((v, i) => v - a[i]), v = c.map((n, i) => n - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    if (length < 1e-9) return;
    for (const p of [a, b, c]) data.push(...p, ...normal.map((v) => v / length), ...(typeof color === 'function' ? color(p) : color), metal);
  };
  const ellipsoid = (centre, radius, color, rings = 6, sectors = 12) => {
    const p = (i, j) => {
      const lat = -Math.PI / 2 + i / rings * Math.PI, az = j / sectors * Math.PI * 2;
      return [centre[0] + radius[0] * Math.cos(lat) * Math.cos(az),
        centre[1] + radius[1] * Math.sin(lat), centre[2] + radius[2] * Math.cos(lat) * Math.sin(az)];
    };
    for (let i = 0; i < rings; i++) for (let j = 0; j < sectors; j++) {
      tri(p(i, j), p(i + 1, j), p(i + 1, j + 1), color);
      tri(p(i, j), p(i + 1, j + 1), p(i, j + 1), color);
    }
  };
  const tube = (a, b, r0, r1, color, sectors = 12, metal = 0) => {
    const axis = b.map((v, i) => v - a[i]), length = Math.hypot(...axis), n = axis.map((v) => v / length);
    const reference = Math.abs(n[1]) < .9 ? [0, 1, 0] : [1, 0, 0];
    const u = [n[1] * reference[2] - n[2] * reference[1], n[2] * reference[0] - n[0] * reference[2], n[0] * reference[1] - n[1] * reference[0]];
    const ul = Math.hypot(...u); for (let i = 0; i < 3; i++) u[i] /= ul;
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const p = (c, r, angle) => c.map((x, i) => x + r * (u[i] * Math.cos(angle) + v[i] * Math.sin(angle)));
    for (let j = 0; j < sectors; j++) {
      const a0 = j / sectors * Math.PI * 2, a1 = (j + 1) / sectors * Math.PI * 2;
      const p0 = p(a, r0, a0), p1 = p(a, r0, a1), p2 = p(b, r1, a1), p3 = p(b, r1, a0);
      tri(p0, p1, p2, color, metal); tri(p0, p2, p3, color, metal);
      tri(a, p1, p0, color, metal); tri(b, p3, p2, color, metal);
    }
  };
  const blade = (outline, color) => {
    // A raised central bevel catches the light as the wrist rotates.
    const centre = [outline.reduce((s, p) => s + p[0], 0) / outline.length,
      outline.reduce((s, p) => s + p[1], 0) / outline.length];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      tri([centre[0], centre[1], .009], [a[0], a[1], .002], [b[0], b[1], .002], color, .9);
      tri([centre[0], centre[1], -.009], [b[0], b[1], -.002], [a[0], a[1], -.002], color, .9);
      tri([a[0], a[1], .002], [a[0], a[1], -.002], [b[0], b[1], -.002], [.55, .58, .6], .9);
      tri([a[0], a[1], .002], [b[0], b[1], -.002], [b[0], b[1], .002], [.55, .58, .6], .9);
    }
  };
  const torus = (cx, cy, radius, thickness, color) => {
    const p = (i, j) => {
      const a = i / 24 * Math.PI * 2, b = j / 8 * Math.PI * 2, r = radius + thickness * Math.cos(b);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a), thickness * Math.sin(b)];
    };
    for (let i = 0; i < 24; i++) for (let j = 0; j < 8; j++) {
      tri(p(i, j), p(i + 1, j), p(i + 1, j + 1), color, .5);
      tri(p(i, j), p(i + 1, j + 1), p(i, j + 1), color, .5);
    }
  };
  return { tri, tube, ellipsoid, blade, torus, finish: () => new Float32Array(data) };
}

function hand(character, side) {
  const m = builder(), classic = character === 'classic', skin = [.63, .43, .30], glove = [.055, .062, .065];
  const sleeve = classic ? [.13, .16, .12] : [.22, .24, .18], sectors = classic ? 8 : 12;
  const wrist = [0, 0, 0], elbow = [side * .24, -.28, .37];
  m.tube(elbow, wrist, .073, .045, classic ? skin : sleeve, sectors);
  m.tube([0, -.026, .015], [0, .028, -.01], .052, .049, glove, sectors);
  m.ellipsoid([0, .065, -.014], [.055, .073, .04], glove, 6, sectors);
  if (side > 0) {
    // Four articulated fingers curled around the handle, plus an opposing thumb.
    for (let i = 0; i < 4; i++) {
      const y = .105 - i * .029;
      m.tube([-.033, y, -.045], [.026, y + .008, -.056], .014, .012, glove, sectors);
      m.tube([.026, y + .008, -.056], [.042, y - .005, -.01], .012, .010, classic ? skin : glove, sectors);
      m.ellipsoid([.035, y + .007, -.03], [.016, .012, .017], classic ? skin : [.10, .11, .11], 4, sectors);
    }
    m.tube([-.047, .04, -.016], [-.018, .09, -.061], .021, .015, classic ? skin : glove, sectors);
  } else {
    for (let i = 0; i < 4; i++) {
      const x = -.032 + i * .024, y = .07 + .02 * Math.sin(i);
      m.tube([x, y, -.04], [x + .02, y + .032, -.096], .014, .011, glove, sectors);
      m.tube([x + .02, y + .032, -.096], [x + .033, y + .02, -.132], .011, .009, classic ? skin : glove, sectors);
    }
    m.tube([.047, .027, -.01], [.076, .065, -.07], .019, .012, classic ? skin : glove, sectors);
  }
  // Individual knuckle pads, rather than a box for the whole glove.
  for (let i = 0; i < 4; i++) m.ellipsoid([-.031 + .021 * i, .085, .02], [.014, .023, .016], [.09, .10, .10], 4, 8);
  return m.finish();
}

function knifeMesh(knife, finish) {
  const m = builder(), grip = [.075, .083, .086], fittings = [.40, .43, .45];
  const metal = (p) => {
    const y = Math.max(0, Math.min(1, (p[1] - .08) / .3));
    if (finish === 'fade') return [.68 + .3 * y, .16 + .46 * y, .66 - .53 * y];
    if (finish === 'tiger') return Math.sin(p[1] * 185 + p[0] * 100) > .3 ? [.12, .10, .055] : [.88, .57, .12];
    if (finish === 'night') return [.12, .16, .21];
    return [.61 + y * .12, .65 + y * .12, .69 + y * .12];
  };
  if (knife === 'karambit') {
    m.tube([0, .025, 0], [.036, .16, 0], .017, .02, grip);
    m.torus(0, .005, .026, .006, fittings);
    // Hooked blade, triangulated as a strip so the concave inside stays hollow.
    const outer = [[.032,.15],[.083,.175],[.112,.21],[.116,.252],[.093,.29],[.063,.316],[.030,.326]];
    const inner = [[.031,.181],[.059,.20],[.074,.224],[.071,.249],[.058,.271],[.043,.292],[.030,.326]];
    for(let i=0;i<outer.length-1;i++) for(const z of [-.005,.005]) {
      m.tri([...outer[i],z],[...outer[i+1],z],[...inner[i+1],z],metal,.95);
      m.tri([...outer[i],z],[...inner[i+1],z],[...inner[i],z],metal,.95);
    }
    for(let i=0;i<outer.length-1;i++) for(const edge of [outer,inner]) {
      m.tri([...edge[i],-.005],[...edge[i+1],-.005],[...edge[i+1],.005],fittings,.9);
      m.tri([...edge[i],-.005],[...edge[i+1],.005],[...edge[i],.005],fittings,.9);
    }
  } else {
    m.tube([0, .015, 0], [0, .14, 0], .016, .019, grip);
    for(let i=0;i<6;i++) m.tube([0,.025+i*.018,0],[0,.03+i*.018,0],.018,.018,[.13,.14,.14]);
    m.tube([-.043,.147,0],[.044,.147,0],.007,.007,fittings,12,.8);
    const outline = knife === 'huntsman'
      ? [[-.028,.155],[-.032,.292],[-.018,.30],[-.032,.31],[-.016,.32],[-.028,.332],[-.014,.342],[-.021,.352],[.011,.394],[.050,.345],[.052,.17]]
      : knife === 'classic'
      ? [[-.02,.155],[-.025,.31],[-.005,.366],[.025,.398],[.038,.305],[.031,.155]]
      : [[-.015,.155],[-.015,.322],[.025,.38],[.032,.34],[.028,.155]];
    m.blade(outline,metal);
    m.tube([0,.01,0],[0,.018,0],.02,.02,fittings,12,.8);
  }
  return m.finish();
}

export function viewmodelMeshes(settings = {}) {
  const o = normaliseAppearance(settings);
  return { left: hand(o.character, -1), right: hand(o.character, 1), knife: knifeMesh(o.knife, o.finish) };
}
