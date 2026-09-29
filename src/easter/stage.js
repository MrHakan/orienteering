// Where an Easter egg is allowed to draw.
//
//   sky   - the part of the 3D view above the computed skyline (minus the
//           compass tape). Objects here can disappear behind hills but can
//           never cover the terrain, which is the quiz's visual clue.
//   free  - the whole frame minus protected content: title and heading, the
//           tape, the gap with the countdown bar, the map with its markers, and
//           the caption/handle. Used for snow only. Built as a union of whole-
//           pixel rectangles that never intersect the protected ones.
//
// Everything is derived from the export layout and the engine's skyline, so
// it is deterministic and independent of the quiz's answer or options.

import { clamp } from '../engine/grid.js';

/** Tape height in scene pixels: 36 tape units at scene width / 666. */
export const tapeBand = (sceneW) => 36 * (sceneW / 666);

/** Sky/terrain safety gap (px): the computed skyline can be a few px off the mesh. */
const SKY_MARGIN = 5;

/**
 * The horizontal bands the layout reserves. The gap between scene and map
 * holds the countdown bar (8-14 px under the scene) and the rule line, which
 * sit closer to the map in the 4:5 layout than in 9:16, so its bottom edge
 * comes from those elements and not only from the map.
 */
function bands(layout) {
  const S = layout.scene, M = layout.map;
  const headerTop = layout.title.y - layout.title.size * 0.95;
  const mapTop = M.y - 20;
  const gapBottom = Math.max(mapTop, layout.rule + 2 + 4, S.y + S.h + 8 + 6 + 4);
  const footerRef = layout.caption ? layout.caption.y - layout.caption.size * 1.1 : layout.handle.y - layout.handle.size * 1.1;
  const footerTop = Math.min(M.y + M.s + 20, footerRef);
  return { headerTop, mapTop, gapBottom, footerTop };
}

export function protectedRects(layout, frame) {
  const { width: W, height: H } = frame;
  const S = layout.scene, M = layout.map;
  const { headerTop, mapTop, gapBottom, footerTop } = bands(layout);
  return [
    { name: 'header', x: 0, y: headerTop, w: W, h: S.y - headerTop },
    { name: 'tape', x: S.x, y: S.y, w: S.w, h: tapeBand(S.w) },
    { name: 'rule+countdown', x: 0, y: S.y + S.h, w: W, h: gapBottom - (S.y + S.h) },
    { name: 'map', x: M.x - 20, y: mapTop, w: M.s + 40, h: footerTop - mapTop },
    { name: 'footer', x: 0, y: footerTop, w: W, h: H - footerTop },
  ].map(snapOut);
}

/**
 * The complement of the protected rectangles as whole-pixel rectangles that
 * are safely inside the allowed area: the top band, the scene without its tape,
 * the strips beside the scene, and the strips beside the map. They are drawn as
 * a union (non-zero clip), so touching or overlapping edges cannot flip a
 * region back to "allowed" the way an even-odd cut-out would.
 */
export function freeRects(layout, frame) {
  const { width: W } = frame;
  const S = layout.scene, M = layout.map;
  const { headerTop, mapTop, gapBottom, footerTop } = bands(layout);
  const sceneTop = Math.ceil(S.y), sceneBottom = Math.floor(S.y + S.h);
  const tapeBottom = Math.ceil(S.y + tapeBand(S.w));
  const x0 = Math.floor(S.x), x1 = Math.ceil(S.x + S.w);
  const besideTop = Math.ceil(Math.max(mapTop, gapBottom));
  const rects = [
    { name: 'top band', x: 0, y: 0, w: W, h: Math.floor(headerTop) },
    { name: 'scene below tape', x: x1 - Math.floor(S.w), y: tapeBottom, w: Math.floor(S.w), h: sceneBottom - tapeBottom },
    { name: 'left of scene', x: 0, y: sceneTop, w: x0, h: sceneBottom - sceneTop },
    { name: 'right of scene', x: x1, y: sceneTop, w: W - x1, h: sceneBottom - sceneTop },
    { name: 'left of map', x: 0, y: besideTop, w: Math.floor(M.x - 20), h: Math.floor(footerTop) - besideTop },
    { name: 'right of map', x: Math.ceil(M.x + M.s + 20), y: besideTop, w: W - Math.ceil(M.x + M.s + 20), h: Math.floor(footerTop) - besideTop },
  ];
  return rects.filter((r) => r.w > 0 && r.h > 0);
}

/**
 * Round a rectangle outwards to whole pixels. A clip edge on a fractional pixel
 * is anti-aliased, which would let a little of the layer bleed into the
 * protected row.
 */
export function snapOut(r) {
  const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
  const x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
  return { ...r, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * @param {{layout:object, frame:{width:number,height:number}, skyline:number[][]}} p
 *   skyline: [x, y] points in scene pixels (see skylineScreenPoints)
 */
export function createStage({ layout, frame, skyline }) {
  const S = layout.scene;
  const top = S.y + tapeBand(S.w) + 4;
  const bottom = S.y + S.h;
  // Skyline in frame coordinates, lowered by the margin; never above the stage top.
  const xs = skyline.map((p) => S.x + p[0]);
  const ys = skyline.map((p) => clamp(S.y + p[1] - SKY_MARGIN, top, bottom));
  const rawY = skyline.map((p) => S.y + p[1]); // the computed skyline itself, for audits
  const rects = protectedRects(layout, frame);
  const free = freeRects(layout, frame);

  const stage = {
    frame, scene: S, top, bottom, rects, free,
    left: S.x, right: S.x + S.w,
    skyX: xs, skyY: ys, skyRawY: rawY,

    /** Height of free sky (px) under the stage top at frame-x. */
    headroomAt(x) {
      let best = Infinity, y = ys[0];
      for (let i = 0; i < xs.length; i++) {
        const d = Math.abs(xs[i] - x);
        if (d < best) { best = d; y = ys[i]; }
      }
      return y - top;
    },

    /** Smallest free-sky height over [x0, x1]. */
    minHeadroom(x0, x1) {
      let m = Infinity;
      for (let i = 0; i < xs.length; i++) if (xs[i] >= x0 && xs[i] <= x1) m = Math.min(m, ys[i] - top);
      return m === Infinity ? stage.headroomAt((x0 + x1) / 2) : m;
    },

    /** Percentile (0..1) of the headroom across the scene width. */
    headroomPercentile(p) {
      const v = ys.map((y) => y - top).sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(p * v.length))];
    },

    /** Sky polygon as a clip path. */
    clipSky(ctx) {
      ctx.beginPath();
      ctx.moveTo(S.x, top);
      ctx.lineTo(S.x + S.w, top);
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], ys[i]);
      ctx.closePath();
      ctx.clip();
    },

    /** Union of the free rectangles (non-zero clip). */
    clipFree(ctx) {
      ctx.beginPath();
      for (const r of free) ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    },

    /** Fade factor 0..1 as a point nears the sky boundary (top, sides). */
    edgeFade(x, y, pad = 30) {
      const a = clamp((y - top) / pad, 0, 1);
      const b = clamp((x - S.x) / pad, 0, 1);
      const c = clamp((S.x + S.w - x) / pad, 0, 1);
      return Math.min(a, b, c);
    },
  };
  return stage;
}
