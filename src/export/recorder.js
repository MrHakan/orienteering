// Video export. Preferred path: WebCodecs VideoEncoder, frame by frame, muxed
// into MP4 — exact 60 fps (900 frames for 15 s) and exact duration regardless of machine speed, and
// H.264 where the browser can encode it (Chrome, Edge, Safari), which is what
// Instagram expects. Fallback: real-time MediaRecorder capture.

import { muxMp4 } from './mp4.js';

/** Export frame rate: a 15 s clip is 900 frames. */
export const EXPORT_FPS = 60;

// 1080×1920 at 60 fps needs H.264 level 4.2 (level 4.0 stops at ~30 fps) and
// VP9 level 4.1; the level 4.0 entries remain for low-frame-rate encodes.
const WEBCODECS_CODECS = ['avc1.64002A', 'avc1.4d002A', 'avc1.42E02A', 'avc1.640028', 'avc1.4d0028', 'avc1.42E028',
  'vp09.00.41.08', 'vp09.00.40.08'];
const RECORDER_TYPES = ['video/mp4;codecs=avc1.64002A', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** Twice the frames keep the same per-frame quality with a higher bitrate. */
export const videoBitrate = (fps) => (fps > 30 ? 16_000_000 : 10_000_000);

export async function pickVideoPath(width, height, fps = EXPORT_FPS) {
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    for (const codec of WEBCODECS_CODECS) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: videoBitrate(fps), framerate: fps });
        if (supported) return { kind: 'webcodecs', codec, h264: codec.startsWith('avc1') };
      } catch { /* try next */ }
    }
  }
  if (typeof MediaRecorder !== 'undefined') {
    const type = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (type) return { kind: 'recorder', type, h264: type.includes('avc1') };
  }
  return null;
}

/**
 * Awaits drawFrame(t) for t in [0, duration) and encodes it.
 * @returns {Promise<{blob:Blob, extension:string, h264:boolean, codec:string}>}
 */
export async function encodeCanvasVideo(canvas, drawFrame, { duration = 15, fps = EXPORT_FPS, onProgress = () => {}, audio = null } = {}) {
  const path = await pickVideoPath(canvas.width, canvas.height, fps);
  if (!path) throw new Error('This browser cannot encode video.');
  if (path.kind === 'webcodecs') {
    // Encode the soundtrack first (fast); without an audio encoder the video stays silent.
    const sound = audio ? await encodeAudio(audio, path.h264).catch(() => null) : null;
    const result = await encodeWebCodecs(canvas, drawFrame, path, { duration, fps, onProgress, sound });
    return { ...result, audio: sound?.codec || null };
  }
  return recordRealtime(canvas, drawFrame, path, { duration, fps, onProgress, audio });
}

/** AAC where available (what Instagram expects next to H.264), otherwise Opus. */
async function encodeAudio(buffer, preferAac) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const sampleRate = buffer.sampleRate, channels = Math.min(2, buffer.numberOfChannels);
  let codec = null;
  for (const c of preferAac ? ['mp4a.40.2', 'opus'] : ['opus', 'mp4a.40.2']) {
    try { if ((await AudioEncoder.isConfigSupported({ codec: c, sampleRate, numberOfChannels: channels, bitrate: 128000 })).supported) { codec = c; break; } } catch { /* next */ }
  }
  if (!codec) return null;
  const samples = []; let description = null, failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      samples.push({ data, duration: chunk.duration ? Math.round(chunk.duration * sampleRate / 1e6) : (codec === 'opus' ? 960 : 1024) });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec, sampleRate, numberOfChannels: channels, bitrate: 128000 });
  const frame = 4800, planes = Array.from({ length: channels }, (_, ch) => buffer.getChannelData(ch));
  for (let start = 0; start < buffer.length; start += frame) {
    const count = Math.min(frame, buffer.length - start), data = new Float32Array(count * channels);
    planes.forEach((plane, ch) => data.set(plane.subarray(start, start + count), ch * count));
    const chunk = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: count, numberOfChannels: channels, timestamp: Math.round(start / sampleRate * 1e6), data });
    encoder.encode(chunk); chunk.close();
  }
  await encoder.flush(); encoder.close();
  if (failure || !samples.length) return null;
  return { codec: codec === 'opus' ? 'opus' : 'mp4a.40.2', sampleRate, channels, description, samples };
}

async function encodeWebCodecs(canvas, drawFrame, { codec, h264 }, { duration, fps, onProgress, sound = null }) {
  const samples = [];
  let description;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === 'key' });
    },
    error: (e) => { failure = e; },
  });
  const config = { codec, width: canvas.width, height: canvas.height, bitrate: videoBitrate(fps), framerate: fps, latencyMode: 'quality' };
  if (h264) config.avc = { format: 'avc' };
  const frames = Math.round(duration * fps);
  const us = 1e6 / fps;
  try {
    encoder.configure(config);
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure;
      await drawFrame(i / fps);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * us), duration: Math.round(us) });
      try { encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 }); }
      finally { frame.close(); }
      onProgress((i + 1) / frames);
      // Wait for actual capacity. A single yield can enqueue hundreds of
      // full-size GPU snapshots and exhaust memory on a 15-second export.
      while (encoder.encodeQueueSize > 4 && !failure) await new Promise((r) => setTimeout(r, 10));
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (failure) throw failure;
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  if (h264 && !description) throw new Error('Encoder returned no H.264 configuration.');
  const blob = muxMp4({ codec, width: canvas.width, height: canvas.height, fps, description, samples, audio: sound });
  return { blob, extension: 'mp4', h264, codec };
}

async function recordRealtime(canvas, drawFrame, { type, h264 }, { duration, fps, onProgress, audio = null }) {
  const stream = canvas.captureStream(fps);
  // Real-time path: play the soundtrack into the recorded stream.
  let player = null;
  if (audio && typeof AudioContext !== 'undefined') {
    try {
      const ctx = new AudioContext({ sampleRate: audio.sampleRate }), dest = ctx.createMediaStreamDestination(), src = ctx.createBufferSource();
      src.buffer = audio; src.connect(dest); dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      player = { ctx, src };
    } catch { player = null; }
  }
  // With a soundtrack, ask for a matching audio codec in the same container.
  const withAudio = player && type.includes('codecs=') ? type.replace(/codecs=([^;]+)/, (m, c) => `codecs=${c},${type.startsWith('video/mp4') ? 'mp4a.40.2' : 'opus'}`) : type;
  const mimeType = player && MediaRecorder.isTypeSupported(withAudio) ? withAudio : type;
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBitrate(fps) });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  await drawFrame(0);
  rec.start(250);
  player?.src.start();
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const t = (performance.now() - start) / 1000;
        if (t >= duration) { await drawFrame(duration); resolve(); return; }
        await drawFrame(t);
        onProgress(t / duration);
        requestAnimationFrame(tick);
      } catch (error) { reject(error); }
    };
    requestAnimationFrame(tick);
  });
  await new Promise((r) => setTimeout(r, 120));
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  player?.ctx.close();
  const mime = type.split(';')[0];
  return { blob: new Blob(chunks, { type: mime }), extension: mime === 'video/mp4' ? 'mp4' : 'webm', h264, codec: type };
}
