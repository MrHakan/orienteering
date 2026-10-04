import { surfaceElevation } from '../engine/terrainSurface.js';

const images = new Map();
function loadImage(file) {
  const url = new URL(`../assets/environment/${file}`, import.meta.url).href;
  if (!images.has(url)) images.set(url, new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => { images.delete(url); reject(new Error(`Could not load environment texture: ${file}`)); };
    image.src = url;
  }));
  return images.get(url);
}

/** Lazily loaded, local assets. Each GL context owns its textures; decoded images are shared. */
export class EnvironmentTextures {
  constructor(gl, files, onReady = () => {}) {
    this.gl = gl; this.loaded = false; this.disposed = false; this.textures = {};
    for (const key of Object.keys(files)) {
      const texture = gl.createTexture(); this.textures[key] = texture;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      const pixel = key === 'normal' ? [128, 128, 255, 255] : [100, 110, 80, 255];
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixel));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.ready = Promise.all(Object.entries(files).map(async ([key, file]) => {
      const image = await loadImage(file);
      if (this.disposed) return;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[key]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // Alpha stores roughness/AO, not opacity, in the surface atlases.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    })).then(() => { if (!this.disposed) { this.loaded = true; onReady(); } });
    // Live play can keep the standard material on a failed asset load. Exports await
    // the original promise and report the failure instead of saving a partial frame.
    this.ready.catch(error => { this.error = error; });
  }
  dispose() { this.disposed = true; for (const texture of Object.values(this.textures)) this.gl.deleteTexture(texture); }
}

/** 16-bit heights used only for lighting; geometry and the contour map stay exact. */
export function terrainHeightPixels(model, size = 256) {
  const data = new Uint8Array(size * size * 4), range = Math.max(1, model.max - model.min);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const elevation = surfaceElevation(model, x / (size - 1) * model.size, y / (size - 1) * model.size);
    const h = Math.round(Math.max(0, Math.min(1, (elevation - model.min) / range)) * 65535), k = (y * size + x) * 4;
    data[k] = h >> 8; data[k + 1] = h & 255; data[k + 3] = 255;
  }
  return data;
}

// Four scanned materials share two atlases. Eight-pixel wrap gutters protect
// mip filtering. World-space projection avoids stretched textures on cliffs.
export const TERRAIN_MATERIAL_GLSL = `
uniform sampler2D uAlbedo, uNormalMap, uTerrainHeight;
uniform float uMapSize;
uniform vec3 uGrassLow, uGrassHigh, uDry, uRock;
uniform vec4 uTextureMix;
uniform vec2 uTextureOffset;
uniform float uTextureScale;
vec3 textureTint(vec3 color, vec3 tint) {
  float detail = .55 + 1.4 * dot(color, vec3(.2126, .7152, .0722));
  return mix(color, tint * detail, uTextureMix.w);
}
vec2 materialUV(vec2 uv, vec2 slot) { return slot * .5 + .00390625 + fract(uv) * .4921875; }
vec3 materialDX, materialDY;
vec4 sampleMaterial(sampler2D atlas, vec2 uv, vec2 slot, vec2 dx, vec2 dy) {
#ifdef MATERIAL_GRADIENTS
  // Derivatives must be computed BEFORE fract: otherwise tile boundaries select
  // the coarsest mip and mix unrelated atlas cells into a visible square grid.
  dx *= .4921875; dy *= .4921875;
  float footprint = max(length(dx), length(dy));
  float cap = min(1.0, .03 / max(.000001, footprint));
  dx *= cap; dy *= cap;
  float inset = .00390625;
  vec2 mapped = slot * .5 + inset + fract(uv) * (.5 - inset * 2.0);
  return MATERIAL_GRAD(atlas, mapped, dx, dy);
#else
  return texture2D(atlas, materialUV(uv, slot), -2.0);
#endif
}
vec4 surfaceColorXZ(vec3 p, float scale, vec2 slot) { return sampleMaterial(uAlbedo, p.xz / scale, slot, materialDX.xz / scale, materialDY.xz / scale); }
vec4 surfaceColorXY(vec3 p, float scale, vec2 slot) { return sampleMaterial(uAlbedo, p.xy / scale, slot, materialDX.xy / scale, materialDY.xy / scale); }
vec4 surfaceColorZY(vec3 p, float scale, vec2 slot) { return sampleMaterial(uAlbedo, p.zy / scale, slot, materialDX.zy / scale, materialDY.zy / scale); }
vec4 surfaceNormalXZ(vec3 p, float scale, vec2 slot) { return sampleMaterial(uNormalMap, p.xz / scale, slot, materialDX.xz / scale, materialDY.xz / scale); }
vec4 surfaceNormalXY(vec3 p, float scale, vec2 slot) { return sampleMaterial(uNormalMap, p.xy / scale, slot, materialDX.xy / scale, materialDY.xy / scale); }
vec4 surfaceNormalZY(vec3 p, float scale, vec2 slot) { return sampleMaterial(uNormalMap, p.zy / scale, slot, materialDX.zy / scale, materialDY.zy / scale); }
struct SurfaceMaterial { vec3 color; vec3 normal; float roughness; float ao; };
SurfaceMaterial surfaceMaterial(vec3 p, vec3 n, float distance, float h) {
  // Materials use fixed world scales: moving/zooming never slides their UVs.
  p = p / uTextureScale + vec3(uTextureOffset.x, 0.0, uTextureOffset.y);
  vec3 detailPos = p + vec3(vnoise(p.xz / 37.0), vnoise(p.xy / 43.0), vnoise(p.zy / 39.0)) * 8.0;
#ifdef MATERIAL_GRADIENTS
  // Compute once in uniform control flow, before slope/distance material branches.
  materialDX = dFdx(detailPos); materialDY = dFdy(detailPos);
#else
  materialDX = vec3(0.0); materialDY = vec3(0.0);
#endif
  float patchNoise = vnoise(p.xz / 38.0), broad = vnoise(p.xz / 155.0);
  float bare = uTextureMix.x + (1.0 - uTextureMix.x) * smoothstep(.58, .82, patchNoise) * (.16 + .28 * smoothstep(.35, .8, h));
  float rock = clamp(uTextureMix.y + smoothstep(.025, .16, 1.0 - n.y + (patchNoise - .5) * .017) * uTextureMix.z + smoothstep(.65, .96, h) * .28, 0.0, .98);
  vec4 grass = surfaceColorXZ(detailPos, 2.5, vec2(0.0));
  if (bare > .005) grass = mix(grass, surfaceColorXZ(detailPos, 3.2, vec2(0.0, 1.0)), bare);
  vec3 vegetation = mix(grass.rgb, surfaceColorXZ(p, 95.0, vec2(1.0)).rgb, .22 + .28 * smoothstep(120.0, 1000.0, distance));
  vec3 groundTint = mix(uGrassLow, uGrassHigh, smoothstep(.1, .8, h + (broad - .5) * .3));
  vegetation = textureTint(vegetation, mix(groundTint, uDry, bare));
  vegetation *= .88 + .24 * broad;
  float strength = .48 * (1.0 - smoothstep(80.0, 450.0, distance));
  vec3 groundN = n;
  float groundAO = 1.0;
  if (strength > .001) {
    vec4 gn = surfaceNormalXZ(detailPos, 2.5, vec2(0.0));
    if (bare > .005) gn = mix(gn, surfaceNormalXZ(detailPos, 3.2, vec2(0.0, 1.0)), bare);
    groundN = normalize(n + vec3(gn.r * 2.0 - 1.0, 0.0, gn.g * 2.0 - 1.0) * .38);
    groundAO = gn.a;
  }
  vec4 stone = grass;
  vec3 rockN = n;
  float rockAO = 1.0;
  if (rock > .005) {
    vec3 weights = pow(abs(n), vec3(4.0)); weights /= weights.x + weights.y + weights.z;
    float distant = smoothstep(45.0, 400.0, distance);
    vec4 closeStone = vec4(0.0), broadStone = vec4(0.0);
    if (distant < .999) closeStone = surfaceColorZY(detailPos, 3.0, vec2(1.0, 0.0)) * weights.x
      + surfaceColorXZ(detailPos, 3.0, vec2(1.0, 0.0)) * weights.y + surfaceColorXY(detailPos, 3.0, vec2(1.0, 0.0)) * weights.z;
    if (distant > .001) broadStone = surfaceColorZY(detailPos, 80.0, vec2(1.0, 0.0)) * weights.x
      + surfaceColorXZ(detailPos, 80.0, vec2(1.0, 0.0)) * weights.y + surfaceColorXY(detailPos, 80.0, vec2(1.0, 0.0)) * weights.z;
    stone = mix(closeStone, broadStone, distant);
    if (strength > .001) {
      vec4 nx = surfaceNormalZY(detailPos, 3.0, vec2(1.0, 0.0)), ny = surfaceNormalXZ(detailPos, 3.0, vec2(1.0, 0.0)), nz = surfaceNormalXY(detailPos, 3.0, vec2(1.0, 0.0));
      vec3 dx = nx.xyz * 2.0 - 1.0, dy = ny.xyz * 2.0 - 1.0, dz = nz.xyz * 2.0 - 1.0;
      rockN = normalize(vec3(dx.z * sign(n.x), dx.y, dx.x) * weights.x
                      + vec3(dy.x, dy.z, dy.y) * weights.y + vec3(dz.x, dz.y, dz.z * sign(n.z)) * weights.z);
      rockAO = nx.a * weights.x + ny.a * weights.y + nz.a * weights.z;
    }
  }
  SurfaceMaterial m;
  m.color = pow(mix(vegetation, textureTint(stone.rgb, uRock) * (.9 + .2 * broad), rock), vec3(2.2));
  m.normal = normalize(mix(n, normalize(mix(groundN, rockN, rock)), strength));
  m.roughness = mix(grass.a, stone.a, rock);
  m.ao = mix(groundAO, rockAO, rock);
  return m;
}
float terrainHeight(vec2 world) {
  vec2 uv = (world / uMapSize * 255.0 + .5) / 256.0;
  vec2 h = texture2D(uTerrainHeight, uv).rg;
  return uHeightRange.x + dot(h, vec2(65280.0, 255.0)) / 65535.0 * max(1.0, uHeightRange.y - uHeightRange.x);
}
float terrainSunVisibility(vec3 p, vec3 sun) {
  float visible = 1.0;
  for (int i = 0; i < 4; i++) {
    float t = 28.0 * pow(2.6, float(i));
    vec3 point = p + sun * t;
    vec2 ground = vec2(point.x, -point.z);
    if (ground.x > 0.0 && ground.y > 0.0 && ground.x < uMapSize && ground.y < uMapSize)
      visible = min(visible, smoothstep(-1.0, 4.0, point.y + 2.0 - terrainHeight(ground)));
  }
  return mix(.48, 1.0, visible);
}
`;
