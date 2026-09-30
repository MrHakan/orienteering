// Original user-supplied green-screen footage; no generated meshes or finishes.
export const KNIVES = [
  { id: 'classic', label: 'CS 1.6 · Classic', file: 'classic.mp4', duration: 8 / 3, fps: 30,
    aspect: 4 / 3, idle: [.85, 1.4], inspect: [0, 2.5] },
  { id: 'default', label: 'CS:GO · Default', file: 'default.mp4', duration: 25 / 3, fps: 60,
    aspect: 16 / 9, maxHeight: .74, idle: [.85, 1.05], inspect: [1.25, 7.8] },
  { id: 'butterfly', label: 'CS:GO · Butterfly', file: 'butterfly.mp4', duration: 35.6, fps: 30,
    aspect: 16 / 9, idle: [.55, .95], inspect: [1.05, 3.85] },
];

export function normaliseAppearance(value = {}) {
  const knife = KNIVES.some(p => p.id === value.knife) ? value.knife : 'classic';
  const scale = Number(value.scale);
  return { knife, handedness: value.handedness === 'left' ? 'left' : 'right',
    scale: Number.isFinite(scale) && scale >= .8 && scale <= 1.15 ? scale : 1 };
}

export function knifeClip(settings = {}) {
  return KNIVES.find(p => p.id === normaliseAppearance(settings).knife);
}

export function inspectElapsed(time, motion = {}) {
  if (Number.isFinite(motion.inspectElapsed)) return motion.inspectElapsed;
  if (time >= 1.2 && time < 4) return time - 1.2;
  if (time >= 7.4 && time < 10.2) return time - 7.4;
  return null;
}

/** Random access into the actual footage; live/seek/export use one schedule. */
export function knifeClipTime(time, motion = {}, settings = {}) {
  const clip = knifeClip(settings), t = Math.max(0, Number.isFinite(time) ? time : 0);
  const elapsed = inspectElapsed(t, motion);
  const inspecting = elapsed !== null && elapsed >= 0 && elapsed < 2.8;
  const [start, end] = inspecting ? clip.inspect : clip.idle;
  const source = inspecting ? start + elapsed / 2.8 * (end - start) : start + t % (end - start);
  return Math.min(clip.duration - 1 / clip.fps, Math.floor((source + 1e-6) * clip.fps) / clip.fps);
}

/** Bottom-anchored footage with its original aspect ratio and subtle bhop bob. */
export function knifeOverlayRect(width, height, time, motion = {}, settings = {}) {
  const o = normaliseAppearance(settings), clip = knifeClip(o);
  const h = Math.min(width / clip.aspect, height * (clip.maxHeight || 1)) * o.scale;
  const w = h * clip.aspect;
  const bob = Math.sin(time * 9) * .004 * Math.min(1, (motion.speed || 0) / 15);
  const lift = Math.max(-.012, Math.min(.012, (motion.vertical || 0) * -.0015)) - (motion.landing || 0) * .008;
  return { x: (width - w) / 2, y: height - h + height * (bob + lift), w, h,
    mirror: o.handedness === 'left' };
}
