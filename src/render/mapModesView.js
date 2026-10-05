// Presentation for the map-reading modes, shared by the live app and the
// Instagram exporter: titles, prompts, the 15 s clip camera, 2D overlays
// drawn over the scene, facts and the result table.

import { MAP_MODES, droneCamera, walkCamera, bearingText } from '../engine/mapModes.js';
import { resectionFrame } from '../engine/resectionQuiz.js';

const DEG = Math.PI / 180;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export const modeTitle = (q) => MAP_MODES[q.mode].title;

export function modeSubtitle(q) {
  switch (q.mode) {
    case 'resection': return q.resection.peaks.map((p) => `${p.label} ${bearingText(p.shown)}`).join(' · ');
    case 'route': return 'START ▲ → FINISH ◎ · OFF-TRAIL';
    case 'visibility': return 'YOU · 2 M FLAGS A–E';
    case 'profile': return 'FROM ▲ TO ◎ ON THE MAP';
    case 'drainage': return 'RAIN FALLS AT THE DROP';
    case 'fog': return `${q.heading.text} · VISIBILITY ${q.fog.visibility} M`;
    default: return '';
  }
}

export function modePrompt(q) {
  const list = q.options.map((o) => o.label).join(', ');
  switch (q.mode) {
    case 'resection': return q.resection.peaksMarked
      ? `Your position is unknown. Compass bearings to the marked peaks: ${modeSubtitle(q)}. Where are you: ${list}? Draw each back-bearing (±180°) from its peak; the lines cross where you stand.`
      : `Your position is unknown. Compass bearings to the labelled hills in the view: ${modeSubtitle(q)}. The peaks are not marked on the map — find each hill among the contours first, then draw its back-bearing (±180°). Where are you: ${list}?`;
    case 'route': return `Which route from the start ▲ to the finish ◎ is fastest on foot, off-trail: ${list}? Climbing costs time, and so does a long detour. Tap a route or its letter.`;
    case 'visibility': return `You stand at YOU, eyes 1.7 m above the ground. Exactly one of the 2 m flags ${list} is in sight; the others hide behind terrain. Which one can you see? Read the contours between YOU and each flag.`;
    case 'profile': return `Which elevation profile matches the straight line from ▲ to ◎ on the map: ${list}? Profiles run left to right from ▲ to ◎; heights share one vertical scale.`;
    case 'drainage': return `Rain falls at the drop. Following the steepest way down, where does the water leave the area: ${list}? Water crosses contours at right angles and runs along valleys (contours point uphill).`;
    case 'fog': return `Dense fog: you can only see about ${q.fog.visibility} m. You walk a few steps ${q.heading.text.toLowerCase()} and stop. Where are you: ${list}? Use the slope under your feet and the nearby shapes.`;
    default: return '';
  }
}

export const modeCaption = (q) => ({
  resection: `Bearings ${q.resection?.peaks.map((p) => bearingText(p.shown)).join(' / ')}: where are you?`,
  route: 'Which route is fastest: A, B or C?',
  visibility: 'Which flag can you see from YOU?',
  profile: 'Which profile matches the line?',
  drainage: 'Where does the water go?',
  fog: 'Where are you in the fog?',
})[q.mode];

/** 15 s clip camera plus render options for the scene. */
export function modeFrame(q, model, t, aspect) {
  if (q.mode === 'resection') return { camera: resectionFrame(q, t), options: {} };
  if (q.mode === 'fog') return { camera: walkCamera(model, q.camera, q.camera.heading, t), options: { fogDistance: q.fog.visibility } };
  return { camera: droneCamera(model, q.map.centre, t, q.map.drone || {}), options: {} };
}

function project(camera, x, y, z, w, h) {
  const dx = x - camera.x, dy = y - camera.y, d = Math.hypot(dx, dy);
  const bearing = Math.atan2(dx, dy) / DEG, elev = Math.atan2(z - camera.z, d) / DEG;
  const tanH = Math.tan(camera.fov * DEG / 2), tanV = tanH / (w / h);
  const ax = ((bearing - camera.heading + 540) % 360) - 180, ay = elev - camera.pitch;
  if (Math.abs(ax) >= 80) return null;
  return { x: w / 2 + Math.tan(ax * DEG) / tanH * w / 2, y: h / 2 - Math.tan(ay * DEG) / tanV * h / 2 };
}

function label(ctx, text, x, y, color = '#ffd666', size = 14) {
  ctx.font = `800 ${size}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = 'rgba(10, 14, 18, .78)';
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - size * 0.9, w, size * 1.8, 6) : ctx.rect(x - w / 2, y - size * 0.9, w, size * 1.8); ctx.fill();
  ctx.fillStyle = color; ctx.fillText(text, x, y + 0.5);
}

/** Profile charts (A–D) laid out in a grid over the scene. */
function drawProfiles(ctx, q, w, h, answered) {
  const profiles = q.options, cols = 2, rows = Math.ceil(profiles.length / cols);
  const all = profiles.flatMap((o) => o.profile), lo = Math.min(...all), hi = Math.max(...all), span = Math.max(10, hi - lo);
  ctx.fillStyle = 'rgba(14, 18, 23, .9)'; ctx.fillRect(0, 0, w, h);
  const pad = Math.max(8, w * 0.02), cw = (w - pad * (cols + 1)) / cols, ch = (h - pad * (rows + 1)) / rows;
  profiles.forEach((o, i) => {
    const x0 = pad + (i % cols) * (cw + pad), y0 = pad + Math.floor(i / cols) * (ch + pad);
    const good = answered && o.correct;
    ctx.fillStyle = good ? 'rgba(95, 208, 138, .14)' : 'rgba(255, 255, 255, .04)'; ctx.fillRect(x0, y0, cw, ch);
    ctx.strokeStyle = good ? '#5fd08a' : 'rgba(233, 228, 216, .25)'; ctx.lineWidth = good ? 2 : 1; ctx.strokeRect(x0, y0, cw, ch);
    const ix = x0 + 8, iy = y0 + 8, iw = cw - 16, ih = ch - 22;
    ctx.strokeStyle = 'rgba(233, 228, 216, .12)'; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const yy = iy + ih * k / 4; ctx.beginPath(); ctx.moveTo(ix, yy); ctx.lineTo(ix + iw, yy); ctx.stroke(); }
    const pts = o.profile.map((z, k) => [ix + iw * k / (o.profile.length - 1), iy + ih * (1 - (z - lo) / span)]);
    ctx.beginPath(); ctx.moveTo(ix, iy + ih); pts.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(ix + iw, iy + ih); ctx.closePath();
    ctx.fillStyle = good ? 'rgba(95, 208, 138, .3)' : 'rgba(255, 214, 102, .18)'; ctx.fill();
    ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = good ? '#5fd08a' : '#ffd666'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#e9e4d8'; ctx.font = `800 ${Math.max(12, ch * 0.13)}px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(o.label, x0 + 10, y0 + 6);
    ctx.font = `600 ${Math.max(9, ch * 0.075)}px ${FONT}`; ctx.fillStyle = 'rgba(233, 228, 216, .6)';
    // Shared vertical scale, labelled inside the chart.
    ctx.textAlign = 'right'; ctx.fillText(`${Math.round(hi)} m`, ix + iw - 2, iy + 1);
    ctx.textBaseline = 'bottom'; ctx.fillText(`${Math.round(lo)} m`, ix + iw - 2, iy + ih - 1);
    ctx.textAlign = 'left'; ctx.fillText('▲', ix, y0 + ch - 1); ctx.textAlign = 'right'; ctx.fillText('◎', ix + iw, y0 + ch - 1);
  });
}

/** 2D layer over the scene for the current frame. */
export function drawModeOverlay(ctx, q, frame, { x = 0, y = 0, width: w, height: h, answered = false } = {}) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.translate(x, y);
  if (q.mode === 'resection') {
    q.resection.peaks.forEach((p, i) => {
      const s = project(frame.camera, p.x, p.y, p.z, w, h);
      if (s && s.x > 20 && s.x < w - 20 && s.y > 20 && s.y < h) {
        ctx.strokeStyle = '#ffd666'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x, s.y - 22); ctx.stroke();
        label(ctx, `${p.label} · ${bearingText(p.shown)}`, s.x, s.y - 36, i === frame.camera.focus ? '#ffd666' : '#cfd3d6', Math.max(12, w / 46));
      }
    });
  }
  if (q.mode === 'profile') drawProfiles(ctx, q, w, h, answered);
  ctx.restore();
}

/** Extra rows for the facts panel. */
export function modeFacts(q, answered) {
  switch (q.mode) {
    case 'resection': return [['Bearings', modeSubtitle(q)], ['Read to', `${q.resection.rounding}°`], ['Peaks', q.resection.peaksMarked || answered ? 'marked on the map' : 'find them on the map'], ['Viewpoint', answered ? 'revealed on the map' : 'unmarked · find it from the bearings']];
    case 'route': return [['Speed model', 'Tobler hiking function, off-trail'], ['Leg', `${Math.round(q.route.straight)} m straight line`]];
    case 'visibility': return [['Eye / flags', '1.7 m / 2 m above the ground'], ['Flags', `${q.options.length} · exactly one visible`]];
    case 'profile': return [['Line', `${Math.round(q.profileLine.length)} m`], ['Profiles', `${q.options.length} · same vertical scale`]];
    case 'drainage': return [['Flow', 'steepest descent over the filled surface (D8)']];
    case 'fog': return [['Visibility', `${q.fog.visibility} m`], ['Walk', `${q.fog.walk} m ${q.heading.text.toLowerCase()}`]];
    default: return [];
  }
}

/** Result panel (the explanation section is appended by the app after it). */
export function modeResultHTML(q, label, right) {
  const verdict = `<div class="verdict ${right ? 'good' : 'bad'}">${right ? 'Correct' : 'Not quite'} — the answer is ${q.correctLabel}.</div>`;
  const row = (o, cells) => `<tr><td><strong>${o.label}</strong>${o.correct ? ' ✓' : o.label === label ? ' (your pick)' : ''}</td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  let table = '';
  if (q.mode === 'resection') table = `<table><tr><th>Point</th>${q.resection.peaks.map((p) => `<th>${p.label} error</th>`).join('')}</tr>${q.options.map((o) => row(o, o.errors.map((e) => `${e.toFixed(1)}°`))).join('')}</table>`;
  if (q.mode === 'route') table = `<table><tr><th>Route</th><th>Time</th><th>Length</th><th>Climb</th></tr>${q.options.map((o) => row(o, [`${o.minutes.toFixed(1)} min`, `${Math.round(o.length)} m`, `${Math.round(o.climb)} m`])).join('')}</table>`;
  if (q.mode === 'visibility') table = `<table><tr><th>Flag</th><th>Distance</th><th>Result</th></tr>${q.options.map((o) => row(o, [`${Math.round(o.distance)} m`, o.visible ? 'visible' : `hidden by ground ${o.blockDistance ? `at ${Math.round(o.blockDistance)} m` : ''}`])).join('')}</table>`;
  if (q.mode === 'profile') table = `<table><tr><th>Profile</th><th>What it is</th></tr>${q.options.map((o) => row(o, [o.what])).join('')}</table>`;
  if (q.mode === 'drainage') table = `<table><tr><th>Outlet</th><th>Water from the drop</th></tr>${q.options.map((o) => row(o, [o.correct ? `arrives after ${Math.round(q.drainage.length)} m` : 'no'])).join('')}</table>`;
  if (q.mode === 'fog') table = `<table><tr><th>Point</th><th>Near-view difference</th></tr>${q.options.map((o) => row(o, [o.correct ? 'what you saw' : `${o.D.toFixed(1)}°`])).join('')}</table>`;
  return `${verdict}<p>${q.explanation?.correct.summary || ''}</p>${table}
    <button type="button" class="btn ghost" id="mode-replay">Replay the view</button>
    <button type="button" class="btn primary" id="next">Next quiz (N)</button>`;
}
