// Sample the same two planar triangles per cell that WebGL draws. Bilinear
// heights are useful for analysis, but a person needs to stand on the mesh.
export function surfaceElevation(model, x, y) {
  if (!model.inside(x, y)) return model.getElevation(x, y);
  const gx = x / model.cell, gy = y / model.cell;
  const i = Math.min(model.n - 2, Math.floor(gx)), j = Math.min(model.n - 2, Math.floor(gy));
  const u = gx - i, v = gy - j, k = j * model.n + i, h = model.heights;
  const a = h[k], b = h[k + 1], c = h[k + model.n], d = h[k + model.n + 1];
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

/** Conservative visibility against rendered ground, including narrow crests. */
export function surfaceLineOfSight(model, from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.ceil(distance / Math.min(0.75, model.cell / 8));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (surfaceElevation(model, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)
      > from.z + (to.z - from.z) * t - 0.04) return false;
  }
  return true;
}
