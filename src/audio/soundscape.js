// Synthesised sound for the game and the video exports — no audio files.
// Everything is scheduled on a BaseAudioContext, so the same code drives the
// live AudioContext and an OfflineAudioContext that renders a Reels
// soundtrack. Noise comes from a seeded generator, so exports are repeatable.

import { Random } from '../engine/rng.js';

/** A loopable noise buffer (white, or "pink-ish" by one-pole filtering). */
export function noiseBuffer(ctx, seconds = 2, seed = 'noise', colour = 'white') {
  const rng = new Random(`sound|${seed}`), length = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = rng.next() * 2 - 1;
      last = colour === 'pink' ? last * 0.97 + white * 0.03 : white;
      data[i] = colour === 'pink' ? last * 6 : white;
    }
  }
  return buffer;
}

/** Wind and rain beds for a weather state ({ wind: [e, n] m/s, precipitation, storm }). */
export function ambience(ctx, destination, weather = {}, { start = 0, duration = Infinity, seed = 'ambience', level = 1 } = {}) {
  const speed = Math.hypot(...(weather.wind || [0, 0])), rain = weather.precipitation ?? (weather.rain ? 0.7 : 0);
  const nodes = [];
  const bed = (colour, setup) => {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 3, `${seed}|${colour}`, colour); src.loop = true;
    const out = setup(src); out.connect(destination);
    src.start(start); if (Number.isFinite(duration)) src.stop(start + duration);
    nodes.push(src); return out;
  };
  // Wind: band-passed noise with a slow gusting swell.
  bed('pink', (src) => {
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.frequency.value = 380 + speed * 25; band.Q.value = 0.7;
    const gain = ctx.createGain(); gain.gain.value = level * Math.min(0.32, 0.03 + speed * 0.028);
    const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.frequency.value = 0.11; depth.gain.value = gain.gain.value * 0.45;
    lfo.connect(depth); depth.connect(gain.gain); lfo.start(start); if (Number.isFinite(duration)) lfo.stop(start + duration);
    src.connect(band); band.connect(gain); nodes.push(lfo); return gain;
  });
  if (rain > 0) bed('white', (src) => {
    const high = ctx.createBiquadFilter(); high.type = 'highpass'; high.frequency.value = 1800;
    const gain = ctx.createGain(); gain.gain.value = level * 0.09 * rain;
    src.connect(high); high.connect(gain); return gain;
  });
  return { stop: () => nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } }) };
}

function tone(ctx, destination, at, freq, length, { type = 'sine', gain = 0.2, to = null } = {}) {
  const osc = ctx.createOscillator(), env = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, at + length);
  env.gain.setValueAtTime(0.0001, at); env.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(env); env.connect(destination); osc.start(at); osc.stop(at + length + 0.02);
}

function burst(ctx, destination, at, length, { filter = 'lowpass', freq = 1200, gain = 0.6, seed = 'burst' } = {}) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, Math.max(0.2, length), seed);
  const f = ctx.createBiquadFilter(); f.type = filter; f.frequency.value = freq;
  const env = ctx.createGain(); env.gain.setValueAtTime(gain, at); env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  src.connect(f); f.connect(env); env.connect(destination); src.start(at); src.stop(at + length + 0.02);
}

/** One-shot cues: correct, wrong, reveal, scope (rifle raised), shot (with a valley echo), thunder. */
export function cue(ctx, destination, kind, at = ctx.currentTime) {
  switch (kind) {
    case 'correct': tone(ctx, destination, at, 660, 0.18, { gain: 0.16 }); tone(ctx, destination, at + 0.12, 990, 0.32, { gain: 0.16 }); break;
    case 'wrong': tone(ctx, destination, at, 220, 0.38, { type: 'triangle', gain: 0.18, to: 140 }); break;
    case 'reveal': tone(ctx, destination, at, 523, 0.5, { gain: 0.1 }); tone(ctx, destination, at + 0.09, 784, 0.6, { gain: 0.08 }); break;
    case 'scope': burst(ctx, destination, at, 0.05, { filter: 'highpass', freq: 2500, gain: 0.35, seed: 'scope' }); tone(ctx, destination, at + 0.03, 1800, 0.05, { gain: 0.05 }); break;
    case 'shot':
      burst(ctx, destination, at, 0.35, { freq: 2200, gain: 0.9, seed: 'shot' });
      tone(ctx, destination, at, 90, 0.4, { gain: 0.5, to: 40 });
      for (const [delay, g] of [[0.45, 0.22], [0.9, 0.1], [1.5, 0.05]]) burst(ctx, destination, at + delay, 0.6, { freq: 600, gain: g, seed: `echo${delay}` });
      break;
    case 'thunder': burst(ctx, destination, at, 2.8, { freq: 220, gain: 0.45, seed: 'thunder' }); break;
    default: break;
  }
}

/** Cues of a 15 s export clip, by mode (times in seconds). */
export function clipCues(quiz, duration, { reveal = true } = {}) {
  const cues = [];
  if (quiz.mode === 'sniper') cues.push({ t: 5, kind: 'scope' });
  if (reveal) cues.push({ t: Math.max(0, duration - 3), kind: quiz.mode === 'sniper' ? 'shot' : 'reveal' });
  return cues;
}

/** Render a mixed soundtrack offline (48 kHz stereo) for a video export. */
export async function renderSoundtrack({ duration, weather = {}, cues = [], seed = 'export' }) {
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtx) return null;
  const ctx = new OfflineCtx(2, Math.ceil(48000 * duration), 48000);
  const master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
  ambience(ctx, master, weather, { start: 0, duration, seed });
  if (weather.storm) cue(ctx, master, 'thunder', Math.min(duration - 3, 3.2));
  for (const c of cues) cue(ctx, master, c.kind, c.t);
  // Fade in and out so loops and cuts never click.
  master.gain.setValueAtTime(0, 0); master.gain.linearRampToValueAtTime(0.9, 0.4);
  master.gain.setValueAtTime(0.9, Math.max(0.5, duration - 0.5)); master.gain.linearRampToValueAtTime(0, duration);
  return ctx.startRendering();
}
