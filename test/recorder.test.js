import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_FPS, encodeCanvasVideo } from '../src/export/recorder.js';

// A slow encoder retains frames until its asynchronous worker consumes them.
// This reproduces the backlog that previously exhausted memory on full exports.
function slowEncoder(t, { fail = false } = {}) {
  const originals = { VideoEncoder: globalThis.VideoEncoder, VideoFrame: globalThis.VideoFrame };
  const state = { peak: 0, timestamps: [], closedFrames: 0, closed: false };
  let instance;
  globalThis.VideoFrame = class {
    constructor(canvas, options) { this.timestamp = options.timestamp; }
    close() { state.closedFrames++; }
  };
  globalThis.VideoEncoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) { this.callbacks = callbacks; this.queue = []; this.state = 'unconfigured'; instance = this; }
    get encodeQueueSize() { return this.queue.length; }
    configure(config) {
      state.config = config;
      this.state = 'configured';
      this.worker = setInterval(() => {
        const sample = this.queue.shift();
        if (!sample) return;
        if (fail) { this.callbacks.error(new Error('encoder failed')); this.close(); return; }
        this.callbacks.output({ byteLength: 1, type: sample.key ? 'key' : 'delta', copyTo: a => { a[0] = 1; } },
          { decoderConfig: { description: new Uint8Array([1, 100, 0, 40]) } });
      }, 4);
    }
    encode(frame, options) {
      this.queue.push({ key: options.keyFrame });
      state.timestamps.push(frame.timestamp);
      state.peak = Math.max(state.peak, this.queue.length);
    }
    async flush() { while (this.queue.length) await new Promise(r => setTimeout(r, 4)); }
    close() { clearInterval(this.worker); this.state = 'closed'; state.closed = true; }
  };
  t.after(() => {
    instance?.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return state;
}

test('slow encoding stays bounded and awaits each drawn frame at the exact clip time', async t => {
  const state = slowEncoder(t), times = [];
  const result = await encodeCanvasVideo({ width: 1080, height: 1920 }, async time => {
    await Promise.resolve();
    assert.equal(state.timestamps.length, times.length, 'capture must wait for drawing');
    times.push(time);
  }, { duration: 2, fps: 30 });
  assert.equal(times.length, 60);
  assert.deepEqual(times, Array.from({ length: 60 }, (_, i) => i / 30));
  assert.deepEqual(state.timestamps, times.map(time => Math.round(time * 1e6)));
  assert.ok(state.peak <= 8, `slow worker retained ${state.peak} frames`);
  assert.equal(state.closedFrames, 60);
  assert.equal(state.closed, true);
  assert.equal(result.blob.type, 'video/mp4');
  assert.ok(result.blob.size > 60);
});

test('default export is 900 frames at 60 fps with an H.264 level that allows 1080p60', async t => {
  const state = slowEncoder(t), times = [];
  const result = await encodeCanvasVideo({ width: 1080, height: 1920 }, async time => { times.push(time); });
  assert.equal(EXPORT_FPS, 60);
  assert.equal(times.length, 900);
  assert.equal(times.at(-1), 899 / 60);
  assert.equal(state.config.framerate, 60);
  assert.equal(state.config.codec, 'avc1.64002A');
  assert.ok(state.config.bitrate > 10_000_000);
  assert.equal(result.codec, 'avc1.64002A');
});

test('a failed source frame closes the encoder and rejects export', async t => {
  const state = slowEncoder(t);
  await assert.rejects(encodeCanvasVideo({ width: 1080, height: 1920 }, async () => {
    throw new Error('source frame failed');
  }), /source frame failed/);
  assert.equal(state.closed, true);
});

test('an asynchronous encoder error exits the capacity wait and rejects export', async t => {
  const state = slowEncoder(t, { fail: true });
  await assert.rejects(encodeCanvasVideo({ width: 1080, height: 1920 }, async () => {}), /encoder failed/);
  assert.equal(state.closed, true);
  assert.ok(state.peak <= 8);
});

test('the muxer writes an AAC or Opus audio track beside the video', async () => {
  const { muxMp4 } = await import('../src/export/mp4.js');
  const video = Array.from({ length: 30 }, (_, i) => ({ data: new Uint8Array([0, 0, 0, 1, i]), key: i === 0 }));
  for (const codec of ['mp4a.40.2', 'opus']) {
    const audio = { codec, sampleRate: 48000, channels: 2, samples: Array.from({ length: 47 }, () => ({ data: new Uint8Array(12), duration: codec === 'opus' ? 960 : 1024 })) };
    const bytes = new Uint8Array(await muxMp4({ codec: 'vp09.00.41.08', width: 16, height: 16, fps: 30, samples: video, audio }).arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    assert.ok(text.includes('soun') && text.includes('smhd'), 'audio handler');
    assert.ok(text.includes(codec === 'opus' ? 'dOps' : 'esds'), codec);
    // Top-level boxes tile the file exactly and mdat holds video + audio payloads.
    let off = 0; const boxes = {};
    while (off < bytes.length) { const size = new DataView(bytes.buffer, off).getUint32(0); boxes[text.slice(off + 4, off + 8)] = size; off += size; }
    assert.equal(off, bytes.length);
    assert.equal(boxes.mdat, 8 + 30 * 5 + 47 * 12);
  }
  const silent = new TextDecoder('latin1').decode(new Uint8Array(await muxMp4({ codec: 'vp09.00.41.08', width: 16, height: 16, fps: 30, samples: video }).arrayBuffer()));
  assert.ok(!silent.includes('soun'));
});
