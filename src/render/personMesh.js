// A metre-scale low-poly walker: boots, separate legs, orange jacket, arms,
// neck, head and cap. No screen-space sizing or always-visible billboard.
export function personVertices(person, { wave = 0, time = 0 } = {}) {
  const out = [], scale = person.height / 1.8;
  wave = Number.isFinite(wave) ? Math.max(0, Math.min(1, wave)) : 0;
  time = Number.isFinite(time) ? time : 0;
  const az = person.heading * Math.PI / 180, c = Math.cos(az), s = Math.sin(az);
  const vertex = (p, normal, color) => {
    const [x, y, z] = p;
    out.push(person.x + (x * c + z * s) * scale, person.z + y * scale,
      -person.y + (x * s - z * c) * scale,
      normal[0] * c + normal[2] * s, normal[1], normal[0] * s - normal[2] * c, ...color);
  };
  const box = (x0, y0, z0, x1, y1, z1, color, transform = null) => {
    const p = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
      [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
    const faces = [[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[0,1,5,4],[3,7,6,2]];
    const normals = [[0,0,-1],[0,0,1],[-1,0,0],[1,0,0],[0,-1,0],[0,1,0]];
    faces.forEach((f,i) => { for (const k of [0,1,2,0,2,3]) {
      const point = p[f[k]], normal = normals[i];
      vertex(transform ? transform(point) : point, transform ? transform(normal, true) : normal, color);
    } });
  };
  // Rotate each arm segment and its normals about the shoulder/elbow. Feet,
  // body and head keep their original world positions throughout the wave.
  const joint = (angle, x, y) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return ([px, py, pz], normal = false) => [px * c - py * s + (normal ? 0 : x),
      px * s + py * c + (normal ? 0 : y), pz];
  };
  const trousers = [0.055,0.10,0.16], jacket = [1,0.22,0.045], skin = [0.88,0.64,0.43];
  for (const side of [-1,1]) {
    const x = side * 0.115;
    box(x-.075,.08,-.065,x+.075,.87,.065,trousers);
    box(x-.09,.015,-.08,x+.09,.12,.15,[0.025,0.03,0.035]);
    if (side > 0 && wave > 0) {
      const upperAngle = 2 * wave;
      const upper = joint(upperAngle, .29, 1.39);
      const [elbowX, elbowY] = upper([0, -.25, 0]);
      const foreAngle = wave * (Math.PI + .5 * Math.sin(time * Math.PI * 2 * 1.8));
      const fore = joint(foreAngle, elbowX, elbowY);
      box(-.05,-.25,-.095,.05,0,.095,jacket,upper);
      box(-.05,-.25,-.095,.05,0,.095,jacket,fore);
      box(-.04,-.31,-.08,.04,-.21,.08,skin,fore);
    } else {
      box(side < 0 ? -.34 : .24,.89,-.095,side < 0 ? -.24 : .34,1.39,.095,jacket);
      box(side < 0 ? -.33 : .25,.83,-.08,side < 0 ? -.25 : .33,.93,.08,skin);
    }
  }
  box(-.235,.82,-.13,.235,1.46,.13,jacket);
  box(-.07,1.45,-.06,.07,1.53,.06,skin);
  // Octahedral head gives a readable round silhouette with just eight faces.
  const head = [[0,1.77,0],[0,1.5,0],[-.115,1.635,0],[.115,1.635,0],[0,1.635,-.11],[0,1.635,.11]];
  for (const f of [[0,2,4],[0,4,3],[0,3,5],[0,5,2],[1,4,2],[1,3,4],[1,5,3],[1,2,5]]) {
    const a = head[f[0]], b = head[f[1]], d = head[f[2]];
    const u = b.map((v,i) => v-a[i]), v = d.map((val,i) => val-a[i]);
    const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], len = Math.hypot(...n);
    for (const k of f) vertex(head[k], n.map((val) => val/len), skin);
  }
  box(-.12,1.74,-.11,.12,1.8,.14,[1,0.55,0.07]);
  return new Float32Array(out);
}
