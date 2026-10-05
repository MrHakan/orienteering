// Minimal MP4 (ISO BMFF) muxer: one video track and an optional audio track.
// Writes a "fast start" file (moov before mdat) with one chunk per track.
// Video: H.264 (avc1 + avcC from the encoder's decoderConfig.description) or
// VP9 (vp09 + vpcC). Audio: AAC (mp4a + esds) or Opus (Opus + dOps). No dependencies.

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

/** MPEG-4 descriptor with a one-byte length (all ours are < 128 bytes). */
const descriptor = (tag, ...parts) => { const body = parts.flat(); const len = body.reduce((a, p) => a + p.length, 0); return [u8(tag, len), ...body]; };

/** Audio sample entry for AAC (esds) or Opus (dOps). */
function audioEntry({ codec, sampleRate, channels, description }) {
  const head = [zeros(6), u16(1), zeros(8), u16(channels, 16), u16(0, 0), u32((codec === 'opus' ? 48000 : sampleRate) * 65536)];
  if (codec === 'opus') {
    return box('Opus', ...head, box('dOps', u8(0, channels), u16(312), u32(sampleRate), u16(0), u8(0)));
  }
  const asc = description?.length ? description : u8(0x11, 0x90); // AAC-LC, 48 kHz, stereo
  const es = descriptor(0x03, u16(2), u8(0),
    descriptor(0x04, u8(0x40, 0x15), u8(0, 0, 0), u32(192000, 128000), descriptor(0x05, asc)),
    descriptor(0x06, u8(0x02)));
  return box('mp4a', ...head, fullBox('esds', 0, 0, ...es));
}

/** Run-length time-to-sample table. */
function sttsEntries(durations) {
  const out = [];
  for (const d of durations) { const last = out[out.length - 1]; if (last && last[1] === d) last[0]++; else out.push([1, d]); }
  return out;
}

/**
 * @param {{codec:string, width:number, height:number, fps:number,
 *          description?:Uint8Array, samples:Array<{data:Uint8Array,key:boolean}>,
 *          audio?:{codec:'mp4a.40.2'|'opus', sampleRate:number, channels:number, description?:Uint8Array,
 *                  samples:Array<{data:Uint8Array, duration:number}>}}} t
 * @returns {Blob} video/mp4
 */
export function muxMp4({ codec, width, height, fps, description, samples, audio = null }) {
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

  const videoBytes = samples.reduce((a, s) => a + s.data.length, 0);
  const audioTrak = (offset) => {
    if (!audio?.samples.length) return [];
    const total = audio.samples.reduce((a, s) => a + s.duration, 0), ms = Math.round(total / audio.sampleRate * 1000);
    const stts = sttsEntries(audio.samples.map((s) => s.duration));
    return [box('trak',
      fullBox('tkhd', 0, 3, u32(0, 0, 2, 0, ms), zeros(8), u16(0, 1, 0x0100, 0), MATRIX, u32(0, 0)),
      box('mdia',
        fullBox('mdhd', 0, 0, u32(0, 0, audio.sampleRate, total), u16(0x55c4, 0)),
        fullBox('hdlr', 0, 0, u32(0), enc.encode('soun'), zeros(12), enc.encode('SoundHandler\0')),
        box('minf',
          fullBox('smhd', 0, 0, u16(0, 0)),
          box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
          box('stbl',
            fullBox('stsd', 0, 0, u32(1), audioEntry(audio)),
            fullBox('stts', 0, 0, u32(stts.length, ...stts.flat())),
            fullBox('stsc', 0, 0, u32(1, 1, audio.samples.length, 1)),
            fullBox('stsz', 0, 0, u32(0, audio.samples.length, ...audio.samples.map((s) => s.data.length))),
            fullBox('stco', 0, 0, u32(1, offset))))))];
  };
  const build = (dataOffset) => box('moov',
    fullBox('mvhd', 0, 0, u32(0, 0, 1000, durationMs, 0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(audio?.samples.length ? 3 : 2)),
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
            fullBox('stco', 0, 0, u32(1, dataOffset)))))),
    ...audioTrak(dataOffset + videoBytes));

  const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode(isAvc ? 'isomiso2avc1mp41' : 'isomiso2mp41'));
  const audioSamples = audio?.samples || [];
  const mdatSize = 8 + videoBytes + audioSamples.reduce((a, s) => a + s.data.length, 0);
  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, mdatSize);
  mdatHeader.set(enc.encode('mdat'), 4);
  return new Blob([ftyp, moov, mdatHeader, ...samples.map((s) => s.data), ...audioSamples.map((s) => s.data)], { type: 'video/mp4' });
}
