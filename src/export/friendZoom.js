// Deterministic optical zoom for the 15-second friend video. Frame-by-frame
// encoding, real-time recording and the preview all use the same timeline.
const ease = (t) => t * t * (3 - 2 * t);

export function friendVideoZoom(time) {
  if (!Number.isFinite(time) || time <= 3 || time >= 12) return 1;
  if (time < 5) return 1 + 2 * ease((time - 3) / 2);
  if (time <= 10) return 3;
  return 3 - 2 * ease((time - 10) / 2);
}

export function exportCamera(quiz, time, animated) {
  const camera = quiz.camera;
  const zoom = animated && quiz.mode === 'friend' ? friendVideoZoom(time) : 1;
  if (zoom === 1) return camera;
  // Zoom the focal length rather than linearly dividing an angle. Observer
  // position, heading and pitch stay fixed, so the terrain clue is preserved.
  const radians = Math.PI / 180;
  return { ...camera, fov: 2 * Math.atan(Math.tan(camera.fov * radians / 2) / zoom) / radians };
}
