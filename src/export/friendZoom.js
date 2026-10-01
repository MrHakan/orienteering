// Deterministic optical zoom for the 15-second friend video. Frame-by-frame
// encoding, real-time recording and the preview all use the same timeline.
import { conquestArrival, normaliseFriendSkin } from '../engine/friendAppearance.js';
import { usesSunWatch, sunWatchFrame, sunFriendZoom } from '../engine/sunWatch.js';
const ease = (t) => t * t * (3 - 2 * t);

export function friendVideoZoom(time) {
  if (!Number.isFinite(time) || time <= 3 || time >= 10) return 1;
  if (time < 5) return 1 + 2 * ease((time - 3) / 2);
  if (time <= 8) return 3;
  return 3 - 2 * ease((time - 8) / 2);
}

export function friendSceneFrame(quiz, time, animated, { camera = quiz.camera, person = quiz.friend } = {}) {
  const conquest = quiz.mode === 'friend' && normaliseFriendSkin(person?.skin) === 'conquest';
  if (quiz.mode === 'friend' && usesSunWatch(quiz)) {
    const frame = sunWatchFrame(quiz, time, { camera, active: animated });
    // In this difficulty the entrance lands before the wrist is raised, so
    // the watch never hides the character's descent. Ordinary clips retain
    // their original 15-second Conquest entrance.
    const arrivalTime = time <= 5 ? time : Math.min(11, 5 + (time - 5) * 6);
    const arrival = conquest && animated ? conquestArrival(arrivalTime) : null;
    if (arrival) {
      arrival.focus *= 1 - ease(Math.max(0, Math.min(1, (time - 5.7) / .3)));
      frame.camera = focusCamera(camera, frame.camera, person, arrival);
    }
    return { ...frame, personMotion: conquest ? arrival || { sprite: true, altitude: 0, opacity: 1, focus: 0 }
      : { wave: animated ? (sunFriendZoom(time) - 1) / 2 : 0 } };
  }
  const arrival = conquest && animated ? conquestArrival(time) : null;
  const zoom = arrival ? arrival.zoom : animated && quiz.mode === 'friend' ? friendVideoZoom(time) : 1;
  const personMotion = conquest ? arrival || { sprite: true, altitude: 0, opacity: 1, focus: 0 } : {};
  personMotion.wave = !personMotion.sprite ? (zoom - 1) / 2 : 0;
  let view = camera;
  // Optical zoom keeps the observer fixed. Conquest's arrival separately turns
  // the view toward the descending cutout, then restores the original bearing.
  const radians = Math.PI / 180;
  if (zoom !== 1) view = { ...camera, fov: 2 * Math.atan(Math.tan(camera.fov * radians / 2) / zoom) / radians };
  view = focusCamera(camera, view, person, arrival);
  return { camera: view, personMotion };
}

function focusCamera(camera, view, person, arrival) {
  if (arrival?.focus > 0) {
    const radians = Math.PI / 180;
    const dx = person.x - camera.x, dy = person.y - camera.y;
    const heading = Math.atan2(dx, dy) / radians;
    const turn = ((heading - camera.heading + 540) % 360) - 180;
    const pitch = Math.atan2(person.z + arrival.altitude + person.height / 2 - camera.z, Math.hypot(dx, dy)) / radians;
    view = { ...view, heading: (camera.heading + turn * arrival.focus + 360) % 360,
      pitch: camera.pitch + (pitch - camera.pitch) * arrival.focus };
  }
  return view;
}

export function exportCamera(quiz, time, animated) {
  return friendSceneFrame(quiz, time, animated).camera;
}
