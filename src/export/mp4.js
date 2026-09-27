// Minimal MP4 (ISO BMFF) muxer for a single video track of encoded samples.
// Writes a "fast start" file (moov before mdat) with one chunk. Supports
// H.264 (avc1 + avcC from the encoder's decoderConfig.description) and VP9
// (vp09 + vpcC). No dependencies.

const enc = new TextEncoder();

function box(type, ...payloads) {
  const parts = payloads.flat();
  const size = 8 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set(enc.encode(type), 4);
  let off = 8;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function fullBox(type, version, flags, ...payloads) {
  return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payloads);
}

const u8 = (...v) => Uint8Array.from(v);
function u16(...v) { const a = new Uint8Array(v.length * 2); const d = new DataView(a.buffer); v.forEach((x, i) => d.setUint16(i * 2, x)); return a; }
function u32(...v) { const a = new Uint8Array(v.length * 4); const d = new DataView(a.buffer); v.forEach((x, i) => d.setUint32(i * 4, x >>> 0)); return a; }
const zeros = (n) => new Uint8Array(n);
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/** vpcC for 8-bit 4:2:0 BT.709 VP9. */
function vpcC(codec) {
  const [, profile = '00', level = '40'] = codec.split('.');
  return fullBox('vpcC', 1, 0, u8(+profile, +level, (8 << 4) | (1 << 1) | 0, 1, 1, 1), u16(0));
}

/**
 * @param {{codec:string, width:number, height:number, fps:number,
 *          description?:Uint8Array, samples:Array<{data:Uint8Array,key:boolean}>}} t
 * @returns {Blob} video/mp4
 */
export function muxMp4({ codec, width, height, fps, description, samples }) {
  const timescale = fps * 1000;
  const delta = 1000;
  const n = samples.length;
  const durationMs = Math.round((n / fps) * 1000);
  const isAvc = codec.startsWith('avc1');

  const sampleEntry = box(isAvc ? 'avc1' : 'vp09',
    zeros(6), u16(1),                  // reserved, data_reference_index
    zeros(16),                         // pre_defined / reserved
    u16(width, height),
    u32(0x00480000, 0x00480000, 0),    // 72 dpi, reserved
    u16(1),                            // frame_count
    zeros(32),                         // compressorname
    u16(0x0018, 0xffff),               // depth, pre_defined = -1
    isAvc ? box('avcC', description) : vpcC(codec));

  const keys = [];
  samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });

  const build = (dataOffset) => box('moov',
    fullBox('mvhd', 0, 0, u32(0, 0, 1000, durationMs, 0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2)),
    box('trak',
      fullBox('tkhd', 0, 3, u32(0, 0, 1, 0, durationMs), zeros(8), u16(0, 0, 0, 0), MATRIX, u32(width << 16, height << 16)),
      box('mdia',
        fullBox('mdhd', 0, 0, u32(0, 0, timescale, n * delta), u16(0x55c4, 0)),
        fullBox('hdlr', 0, 0, u32(0), enc.encode('vide'), zeros(12), enc.encode('VideoHandler\0')),
        box('minf',
          fullBox('vmhd', 0, 1, zeros(8)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          box('stbl',
            fullBox('stsd', 0, 0, u32(1), sampleEntry),
            fullBox('stts', 0, 0, u32(1, n, delta)),
            fullBox('stss', 0, 0, u32(keys.length, ...keys)),
            fullBox('stsc', 0, 0, u32(1, 1, n, 1)),
            fullBox('stsz', 0, 0, u32(0, n, ...samples.map((s) => s.data.length))),
            fullBox('stco', 0, 0, u32(1, dataOffset)))))));

  const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode(isAvc ? 'isomiso2avc1mp41' : 'isomiso2mp41'));
  const mdatSize = 8 + samples.reduce((a, s) => a + s.data.length, 0);
  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, mdatSize);
  mdatHeader.set(enc.encode('mdat'), 4);
  return new Blob([ftyp, moov, mdatHeader, ...samples.map((s) => s.data)], { type: 'video/mp4' });
}
