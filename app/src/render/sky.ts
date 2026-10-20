// Sky dome: the map's HDRI drawn on a camera-centred sphere that melts into the fog colour at the horizon, so the
// fogged far terrain and the sky meet without a seam (scene.background ignores fog and leaves a hard line).
import * as THREE from 'three';

/** Average HDRI radiance just above the horizon (linear RGB): the colour the fog fades into. */
export function horizonColor(tex: THREE.DataTexture, elevLoDeg = 0.5, elevHiDeg = 4): THREE.Color {
  const img = tex.image as { data: ArrayLike<number>; width: number; height: number };
  const { width: w, height: h, data } = img;
  const half = tex.type === THREE.HalfFloatType;
  const ch = data.length / (w * h); // 4 (RGBA)
  // image row 0 is the top of the sky with flipY = true (HDRLoader default): v = 0.5 + elev / 180
  const rowOf = (deg: number) => Math.round((0.5 - deg / 180) * (h - 1));
  const r0 = rowOf(elevHiDeg), r1 = rowOf(elevLoDeg);
  const val = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i] as number) : (data[i] as number));
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(1, Math.floor(w / 256));
  for (let y = r0; y <= r1; y++) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * ch;
      r += val(i); g += val(i + 1); b += val(i + 2); n++;
    }
  }
  if (!n) return new THREE.Color(0.7, 0.75, 0.8);
  return new THREE.Color(r / n, g / n, b / n);
}

/** three.js ACESFilmicToneMapping on a linear colour (fog colours are mixed in after tone mapping) */
export function acesToneMap(c: THREE.Color, exposure = 1): THREE.Color {
  const k = exposure / 0.6, r = c.r * k, g = c.g * k, b = c.b * k;
  const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const f = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const fr = f(ir), fg = f(ig), fb = f(ib);
  const sat = (v: number) => Math.max(0, Math.min(1, v));
  return new THREE.Color(
    sat(1.60475 * fr - 0.53108 * fg - 0.07367 * fb),
    sat(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb),
    sat(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb),
  );
}

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); // r = 100 m, drawn first without depth
}`;

const frag = /* glsl */ `
uniform sampler2D map;
uniform vec3 fogCol;
uniform float band;
uniform float intensity;
varying vec3 vDir;
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
  gl_FragColor = vec4(texture2D(map, uv).rgb * intensity, 1.0);
  #include <tonemapping_fragment>
  // below the horizon: fog; a thin band above it fades from fog into the sky (fogCol is already tone-mapped,
  // like three's fog, which is applied after tone mapping)
  float k = smoothstep(-0.01, band, d.y);
  gl_FragColor.rgb = mix(fogCol, gl_FragColor.rgb, k * k);
  #include <colorspace_fragment>
}`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(tex: THREE.Texture, fog: THREE.Color, band = 0.09) {
    tex.generateMipmaps = false; // the atan seam would pick a tiny mip and draw a line
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, fogCol: { value: fog.clone() }, band: { value: band }, intensity: { value: 1 } },
      vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    this.mat.toneMapped = true;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.layers.enableAll();
    // follow the camera: the sky is infinitely far
    this.mesh.onBeforeRender = (_r, _s, cam) => { this.mesh.position.copy(cam.position); this.mesh.updateMatrixWorld(); };
  }

  setFog(c: THREE.Color) { (this.mat.uniforms.fogCol.value as THREE.Color).copy(c); }
}
