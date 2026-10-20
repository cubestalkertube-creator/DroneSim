// Natural ground (grass, dirt, gravel): break up the tiled PBR texture - a second, rotated sample at a larger scale
// against visible repetition, and world-space noise patches (drier / darker areas) like a real field from above.
import * as THREE from 'three';

const NOISE = /* glsl */ `
varying vec3 vGroundPos;
uniform vec3 uDryTint;
uniform sampler2D uBlendMap;
uniform vec4 uBlend; // on, tile (m), from, to (m, square distance from the map centre)
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
}
float gFbm(vec2 p) { return 0.5 * gNoise(p) + 0.3 * gNoise(p * 2.07 + 13.1) + 0.2 * gNoise(p * 4.3 + 7.7); }
`;

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;
interface GroundUniforms { uDryTint: { value: THREE.Color }; uBlendMap: { value: THREE.Texture }; uBlend: { value: THREE.Vector4 } }
const PATCHED = new WeakMap<THREE.Material, GroundUniforms>();

/** patch a MeshStandardMaterial with a map; `dry` is the tint of the dry patches (sRGB hex) */
export function groundVariation(mat: THREE.MeshStandardMaterial, dry = 0xc9c088) {
  if (PATCHED.has(mat)) return;
  const u: GroundUniforms = { uDryTint: { value: new THREE.Color(dry) }, uBlendMap: { value: WHITE }, uBlend: { value: new THREE.Vector4() } };
  PATCHED.set(mat, u);
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
      #ifdef USE_MAP
        // anti-tiling: blend in a rotated, 3.4x larger sample of the same texture
        vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.29 + 0.37;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * texture2D(map, uv2).rgb, 0.4);
      #endif
        float gm = gFbm(vGroundPos.xz * 0.011);
        if (uBlend.x > 0.5) {
          // outskirts of the map overgrown: another ground texture with a ragged edge
          float r = max(abs(vGroundPos.x), abs(vGroundPos.z)) + (gFbm(vGroundPos.xz * 0.03) - 0.5) * 60.0;
          vec3 g2 = texture2D(uBlendMap, vGroundPos.xz / uBlend.y).rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, g2, smoothstep(uBlend.z, uBlend.w, r));
        }
        float gd = gFbm(vGroundPos.xz * 0.075 + 31.0);
        diffuseColor.rgb *= mix(vec3(1.0), uDryTint, smoothstep(0.45, 0.72, gm) * 0.9);
        diffuseColor.rgb *= mix(vec3(0.72, 0.82, 0.66), vec3(1.0), smoothstep(0.18, 0.4, gm)); // lush, darker hollows
        diffuseColor.rgb *= 0.82 + 0.34 * gd;`);
  };
  mat.customProgramCacheKey = () => 'ground-variation';
  mat.needsUpdate = true;
}

/** fade a patched ground material into another texture (diffuse) beyond `from`..`to` m from the map centre */
export function setGroundBlend(mat: THREE.MeshStandardMaterial, map: THREE.Texture, tile: number, from: number, to: number) {
  const u = PATCHED.get(mat);
  if (!u) return;
  u.uBlendMap.value = map;
  u.uBlend.value.set(1, tile, from, to);
}

/** textures treated as natural ground */
export const NATURAL_GROUND = /grass|ground|dirt|mud|gravel|burned|forest|soil|sand/i;
