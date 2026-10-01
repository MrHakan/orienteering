// Video export. Preferred path: WebCodecs VideoEncoder, frame by frame, muxed
// into MP4 — exact 30 fps and exact duration regardless of machine speed, and
// H.264 where the browser can encode it (Chrome, Edge, Safari), which is what
// Instagram expects. Fallback: real-time MediaRecorder capture.

import { muxMp4 } from './mp4.js';

const WEBCODECS_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42E028', 'vp09.00.40.08'];
const RECORDER_TYPES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export async function pickVideoPath(width, height, fps = 30) {
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    for (const codec of WEBCODECS_CODECS) {
      try {
        const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 10_000_000, framerate: fps });
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
export async function encodeCanvasVideo(canvas, drawFrame, { duration = 15, fps = 30, onProgress = () => {} } = {}) {
  const path = await pickVideoPath(canvas.width, canvas.height, fps);
  if (!path) throw new Error('This browser cannot encode video.');
  if (path.kind === 'webcodecs') return encodeWebCodecs(canvas, drawFrame, path, { duration, fps, onProgress });
  return recordRealtime(canvas, drawFrame, path, { duration, fps, onProgress });
}

async function encodeWebCodecs(canvas, drawFrame, { codec, h264 }, { duration, fps, onProgress }) {
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
  const config = { codec, width: canvas.width, height: canvas.height, bitrate: 10_000_000, framerate: fps, latencyMode: 'quality' };
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
  const blob = muxMp4({ codec, width: canvas.width, height: canvas.height, fps, description, samples });
  return { blob, extension: 'mp4', h264, codec };
}

async function recordRealtime(canvas, drawFrame, { type, h264 }, { duration, fps, onProgress }) {
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 10_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  await drawFrame(0);
  rec.start(250);
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
  const mime = type.split(';')[0];
  return { blob: new Blob(chunks, { type: mime }), extension: mime === 'video/mp4' ? 'mp4' : 'webm', h264, codec: type };
}
