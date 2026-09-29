// Developer overlay: the engine's ray-marched skyline (the one the quiz is
// validated against) drawn over the rendered scene. If the GPU draws the
// terrain correctly the dashed line sits exactly on the rendered horizon.

/**
 * The engine's skyline in scene pixels: one [x, y] point every `step` px.
 * Same camera math as the WebGL renderer (horizontal FOV, pitch).
 * @param {{x:number,y:number,z:number,heading:number,fov:number,pitch:number}} camera
 * @param {import('../engine/terrainModel.js').TerrainModel} model
 * @param {number} w width of the scene in pixels
 * @param {number} h height of the scene in pixels
 */
export function skylineScreenPoints(camera, model, w, h, step = 3) {
  const DEG = Math.PI / 180;
  const f = w / 2 / Math.tan((camera.fov / 2) * DEG);
  const p = camera.pitch * DEG;
  const pts = [];
  for (let px = 0; px <= w + step - 1; px += step) {
    const x0 = Math.min(px, w);
    const daz = Math.atan((x0 - w / 2) / f);
    const ray = model.skyline.castRay(camera.x, camera.y, camera.z, camera.heading + daz / DEG);
    const a = ray.angle * DEG;
    // Direction in the heading-aligned frame, then pitched like the renderer's camera.
    const x = Math.sin(daz) * Math.cos(a), y = Math.sin(a), z = Math.cos(daz) * Math.cos(a);
    const y2 = y * Math.cos(p) - z * Math.sin(p), z2 = y * Math.sin(p) + z * Math.cos(p);
    pts.push([w / 2 + (f * x) / z2, h / 2 - (f * y2) / z2]);
    if (x0 === w) break;
  }
  return pts;
}

/**
 * @param {CanvasRenderingContext2D} ctx context already scaled to CSS pixels
 */
export function drawSkylineOverlay(ctx, camera, model, w, h) {
  const pts = skylineScreenPoints(camera, model, w, h);
  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(255, 64, 160, 0.95)';
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 64, 160, 0.95)';
  ctx.textAlign = 'right';
  ctx.fillText('computed skyline', w - 8, h - 10);
  ctx.restore();
}
