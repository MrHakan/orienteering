// Code-drawn Santa's sleigh and reindeer. Local units are pixels at scale 1
// with y down; everything faces +x. Pure functions of their arguments, so a
// frame depends only on the elapsed time passed in.

const TAU = Math.PI * 2;

/** Native size of the whole team (sleigh + 4 pairs) at scale 1. */
export const SLEIGH_TEAM = { length: 345, height: 80, pairs: 4, reindeer: 8 };

const COAT = '#c8202f';
const COAT_DARK = '#8f1420';
const GOLD = '#e8c25a';
const STEEL = '#d5dbe0';

const stroke = (ctx, style, width, cap = 'round') => {
  ctx.strokeStyle = style; ctx.lineWidth = width; ctx.lineCap = cap; ctx.lineJoin = 'round';
};

function antler(ctx, root, dir, dark) {
  // Beam sweeps up and back with three tines; drawn twice (dark backing then cream)
  // so it stays readable against any sky.
  const pts = [[0, 0], [-2, -7], [-6, -13], [-5, -20], [-8, -26]];
  const tines = [[[-2, -7], [4, -11], [6, -16]], [[-6, -13], [-13, -15], [-16, -20]], [[-5, -20], [1, -25], [2, -30]]];
  const draw = () => {
    ctx.beginPath();
    ctx.moveTo(root[0], root[1]);
    for (const p of pts.slice(1)) ctx.lineTo(root[0] + p[0] * dir, root[1] + p[1]);
    for (const t of tines) {
      ctx.moveTo(root[0] + t[0][0] * dir, root[1] + t[0][1]);
      ctx.lineTo(root[0] + t[1][0] * dir, root[1] + t[1][1]);
      ctx.lineTo(root[0] + t[2][0] * dir, root[1] + t[2][1]);
    }
    ctx.stroke();
  };
  stroke(ctx, 'rgba(25, 16, 8, 0.6)', 3.6); draw();
  stroke(ctx, dark ? '#b9a67c' : '#efdfb4', 1.7); draw();
}

/**
 * One reindeer, body centre at (0, 0), antlers up to about y = -34 and hooves
 * to about y = +18. phase drives the gallop (radians).
 */
export function drawReindeer(ctx, { x = 0, y = 0, scale = 1, phase = 0, far = false, nose = false } = {}) {
  ctx.save();
  ctx.translate(x, y + Math.sin(phase) * 2.2 * scale);
  ctx.scale(scale, scale);
  const base = far ? ['#5f3f25', '#8a6a49'] : ['#94643a', '#c59d72'];
  const line = far ? '#3b2716' : '#4d3120';

  // Legs behind the body first: far-side pair then near-side pair.
  const leg = (hx, hy, ph, dark) => {
    const a = 0.75 * Math.sin(ph);
    const k1x = hx + Math.sin(a) * 9, k1y = hy + Math.cos(a) * 9;
    const b = a * 0.35 - 0.6;
    const k2x = k1x + Math.sin(b) * 9, k2y = k1y + Math.cos(b) * 9;
    stroke(ctx, dark ? line : base[0], 2.7);
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(k1x, k1y); ctx.lineTo(k2x, k2y); ctx.stroke();
    ctx.fillStyle = '#2a1a10'; ctx.beginPath(); ctx.arc(k2x, k2y + 0.6, 1.5, 0, TAU); ctx.fill();
  };
  leg(8, 5, phase + Math.PI, true); leg(-10, 5, phase, true);

  // Tail tuft.
  ctx.fillStyle = '#f2ede3'; ctx.beginPath(); ctx.arc(-15, -4, 2.6, 0, TAU); ctx.fill();

  // Body.
  const g = ctx.createLinearGradient(0, -8, 0, 8);
  g.addColorStop(0, base[0]); g.addColorStop(1, base[1]);
  ctx.fillStyle = g; ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(0, 0, 14.5, 7.8, 0, 0, TAU); ctx.fill(); ctx.stroke();

  // Neck and head.
  stroke(ctx, base[0], 7.2); ctx.beginPath(); ctx.moveTo(10, -3); ctx.lineTo(19.5, -9.5); ctx.stroke();
  ctx.fillStyle = base[0]; ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(22.5, -10, 6.2, 4.1, 0.35, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(28, -7.6, 3.4, 2.7, 0.35, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1b1109'; ctx.beginPath(); ctx.arc(30.6, -7.4, 1.1, 0, TAU); ctx.fill(); // nostril
  ctx.beginPath(); ctx.arc(23.5, -11.4, 0.9, 0, TAU); ctx.fill();                                 // eye
  ctx.fillStyle = far ? '#4f331d' : '#7d5330';
  ctx.beginPath(); ctx.moveTo(19, -12); ctx.lineTo(15.5, -17); ctx.lineTo(21.5, -14.5); ctx.closePath(); ctx.fill(); // ear

  if (nose) { // the lead reindeer's glowing nose
    const gl = ctx.createRadialGradient(30.6, -7.4, 0, 30.6, -7.4, 8);
    gl.addColorStop(0, 'rgba(255, 70, 60, 0.85)'); gl.addColorStop(1, 'rgba(255, 70, 60, 0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(30.6, -7.4, 8, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(31.2, -7.3, 2, 0, TAU); ctx.fill();
  }

  // Antlers: near antler in front, far antler behind (slightly offset).
  antler(ctx, [20.5, -14], 1, far);
  antler(ctx, [24.5, -13.5], 0.8, true);

  // Near-side legs in front of the body.
  leg(8, 5, phase, false); leg(-10, 5, phase + Math.PI, false);
  ctx.restore();
}

/** Gift sack with two presents poking out; origin at the sack's base centre. */
function drawSack(ctx) {
  ctx.save();
  ctx.fillStyle = '#7a4f26'; ctx.strokeStyle = '#3d2711'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-11, 0);
  ctx.bezierCurveTo(-19, -10, -14, -26, -4, -30);
  ctx.lineTo(4, -30);
  ctx.bezierCurveTo(14, -26, 19, -10, 11, 0);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // Presents.
  ctx.fillStyle = '#d63b3b'; ctx.fillRect(-9, -40, 9, 9);
  ctx.fillStyle = '#2f9e57'; ctx.fillRect(0, -37, 8, 7);
  stroke(ctx, GOLD, 1.4, 'butt');
  ctx.beginPath(); ctx.moveTo(-4.5, -40); ctx.lineTo(-4.5, -31); ctx.moveTo(-9, -35.5); ctx.lineTo(0, -35.5); ctx.stroke();
  stroke(ctx, '#f4f4f4', 1.3, 'butt');
  ctx.beginPath(); ctx.moveTo(4, -37); ctx.lineTo(4, -30); ctx.stroke();
  // Tie.
  stroke(ctx, '#b0182a', 2.4); ctx.beginPath(); ctx.moveTo(-5.5, -29); ctx.lineTo(5.5, -29); ctx.stroke();
  ctx.restore();
}

/** Sleigh with Santa: origin at the runners' rear end, y = 0 at the runner base. Returns the rein anchor. */
export function drawSleigh(ctx, { scale = 1 } = {}) {
  ctx.save();
  ctx.scale(scale, scale);
  // Far runner, then the sack (behind Santa), then the body.
  stroke(ctx, '#8d969d', 2.2);
  ctx.beginPath(); ctx.moveTo(4, -5); ctx.lineTo(84, -5); ctx.quadraticCurveTo(99, -5, 97, -14); ctx.stroke();

  ctx.save(); ctx.translate(20, -12); drawSack(ctx); ctx.restore();

  // Body: tall back, curled front.
  const body = ctx.createLinearGradient(0, -34, 0, -10);
  body.addColorStop(0, COAT); body.addColorStop(1, COAT_DARK);
  ctx.fillStyle = body; ctx.strokeStyle = '#5e0d17'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(2, -36);
  ctx.quadraticCurveTo(0, -14, 12, -11);
  ctx.lineTo(76, -11);
  ctx.quadraticCurveTo(98, -13, 94, -33);
  ctx.quadraticCurveTo(90, -26, 82, -27);
  ctx.lineTo(28, -21);
  ctx.quadraticCurveTo(14, -22, 12, -32);
  ctx.quadraticCurveTo(8, -37, 2, -36);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  stroke(ctx, GOLD, 1.8);
  ctx.beginPath(); ctx.moveTo(10, -14); ctx.lineTo(76, -14); ctx.quadraticCurveTo(92, -15, 91, -27); ctx.stroke();

  // Santa.
  ctx.fillStyle = COAT; ctx.strokeStyle = '#5e0d17'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(44, -29, 10, 11, 0, 0, TAU); ctx.fill(); ctx.stroke();
  stroke(ctx, '#f3efe6', 2.4); ctx.beginPath(); ctx.moveTo(38, -24); ctx.lineTo(50, -24); ctx.stroke(); // belt fur
  stroke(ctx, '#e7c500', 1.6); ctx.beginPath(); ctx.moveTo(43, -25); ctx.lineTo(45, -25); ctx.stroke();
  ctx.fillStyle = '#f0c8a2'; ctx.beginPath(); ctx.arc(46, -45, 5.4, 0, TAU); ctx.fill();               // face
  ctx.fillStyle = '#f6f3ea'; ctx.beginPath(); ctx.ellipse(48, -41.5, 5.2, 5, 0.2, 0, TAU); ctx.fill();  // beard
  ctx.fillStyle = '#1c1c1c'; ctx.beginPath(); ctx.arc(48.5, -46, 0.8, 0, TAU); ctx.fill();             // eye
  ctx.fillStyle = COAT; ctx.beginPath();                                                               // hat
  ctx.moveTo(40.5, -48); ctx.quadraticCurveTo(43, -60, 36, -60); ctx.quadraticCurveTo(46, -63, 51, -48.5); ctx.closePath(); ctx.fill();
  stroke(ctx, '#f6f3ea', 3); ctx.beginPath(); ctx.moveTo(40, -48.5); ctx.lineTo(51.5, -49); ctx.stroke();
  ctx.fillStyle = '#f6f3ea'; ctx.beginPath(); ctx.arc(35.5, -59.5, 2.6, 0, TAU); ctx.fill();
  stroke(ctx, COAT_DARK, 3.4); ctx.beginPath(); ctx.moveTo(50, -33); ctx.lineTo(61, -31); ctx.stroke(); // arm
  ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(62.5, -30.7, 2.3, 0, TAU); ctx.fill();               // glove

  // Near runner and posts (front).
  stroke(ctx, '#5b6470', 1.8);
  ctx.beginPath(); ctx.moveTo(20, -11); ctx.lineTo(20, -1); ctx.moveTo(66, -11); ctx.lineTo(66, -1); ctx.stroke();
  stroke(ctx, STEEL, 2.8);
  ctx.beginPath(); ctx.moveTo(-1, -1); ctx.lineTo(84, -1); ctx.quadraticCurveTo(102, -1, 100, -12); ctx.stroke();
  ctx.restore();
  return { x: 62.5 * scale, y: -30.7 * scale };
}

/**
 * The whole team, drawn with the sleigh's rear-bottom at (x, y).
 * @param {number} t elapsed seconds; drives the gallop and bob (2.4 Hz).
 */
export function drawSleighTeam(ctx, { x = 0, y = 0, scale = 1, t = 0, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  const pairs = SLEIGH_TEAM.pairs;
  const px = (i) => 130 + i * 54;
  const frontY = -27, backY = -35;
  const gallop = TAU * 2.4 * t;

  // Traces (harness lines) from the sleigh to each pair, behind the reindeer.
  stroke(ctx, 'rgba(30, 18, 8, 0.75)', 1.4);
  ctx.beginPath();
  ctx.moveTo(94, -25);
  for (let i = 0; i < pairs; i++) ctx.lineTo(px(i) - 4, frontY - 2);
  ctx.stroke();
  stroke(ctx, GOLD, 0.9);
  ctx.beginPath();
  ctx.moveTo(94, -25);
  for (let i = 0; i < pairs; i++) ctx.lineTo(px(i) - 4, frontY - 2);
  ctx.stroke();

  drawSleigh(ctx, { scale: 1 });

  // Far row first (smaller, darker, higher), then the near row.
  for (let i = pairs - 1; i >= 0; i--) drawReindeer(ctx, { x: px(i) - 8, y: backY, scale: 0.92, phase: gallop + i * 0.75 + 1.3, far: true, nose: false });
  for (let i = pairs - 1; i >= 0; i--) drawReindeer(ctx, { x: px(i) + 4, y: frontY, scale: 1, phase: gallop + i * 0.75, nose: i === pairs - 1 });

  // Reins: Santa's glove to the lead reindeer's collar (slight sag).
  const lead = px(pairs - 1) + 4;
  stroke(ctx, '#f0d68a', 1.1);
  ctx.beginPath(); ctx.moveTo(62.5, -30.7); ctx.quadraticCurveTo((62.5 + lead) / 2, -20, lead + 12, -31); ctx.stroke();
  stroke(ctx, '#c8202f', 0.9);
  ctx.beginPath(); ctx.moveTo(62.5, -30.7); ctx.quadraticCurveTo((62.5 + lead) / 2, -24, lead + 10, -29); ctx.stroke();
  ctx.restore();
}
