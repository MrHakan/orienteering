// Developer overlay: the engine's ray-marched skyline (the one the quiz is
// validated against) drawn over the rendered scene. If the GPU draws the
// terrain correctly the dashed line sits exactly on the rendered horizon.

/**
 * @param {CanvasRenderingContext2D} ctx context already scaled to CSS pixels
 * @param {{x:number,y:number,z:number,heading:number,fov:number,pitch:number}} camera
 * @param {import('../engine/terrainModel.js').TerrainModel} model
 * @param {number} w CSS width of the scene
 * @param {number} h CSS height of the scene
 */
export function drawSkylineOverlay(ctx, camera, model, w, h) {
  const DEG = Math.PI / 180;
  const f = w / 2 / Math.tan((camera.fov / 2) * DEG);
  const p = camera.pitch * DEG;
  const pts = [];
  for (let px = 0; px <= w; px += 3) {
    const daz = Math.atan((px - w / 2) / f);
    const ray = model.skyline.castRay(camera.x, camera.y, camera.z, camera.heading + daz / DEG);
    const a = ray.angle * DEG;
    // Direction in the heading-aligned frame, then pitched like the renderer's camera.
    const x = Math.sin(daz) * Math.cos(a), y = Math.sin(a), z = Math.cos(daz) * Math.cos(a);
    const y2 = y * Math.cos(p) - z * Math.sin(p), z2 = y * Math.sin(p) + z * Math.cos(p);
    pts.push([w / 2 + (f * x) / z2, h / 2 - (f * y2) / z2]);
  }
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
