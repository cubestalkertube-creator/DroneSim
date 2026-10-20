// three.js scene: renderer, HDRI sky/IBL, sun with drone-following shadows, fog, map + props loading.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { MapLayout } from '../sim/layout';
import type { Quality } from './quality';
import { SkyDome, acesToneMap, horizonColor } from './sky';
import { buildSurroundings, fogDensity, overgrowFor, type OuterBox } from './surroundings';
import { NATURAL_GROUND, groundVariation, setGroundBlend } from './groundShader';

/** relative so the same build works from a web server root and from the Capacitor WebView */
export const ASSET_URL = './assets/';

/** JSON-ассет с понятной ошибкой: dev-сервер на отсутствующий файл отдаёт index.html (200), и без этой проверки
 *  вместо причины вылезает «JSON.parse: unexpected character». */
export class AssetMissingError extends Error {}

export async function fetchAssetJSON<T>(url: string): Promise<T> {
  const r = await fetch(ASSET_URL + url);
  if (!r.ok) throw new AssetMissingError(`Не найден ассет «${url}» (HTTP ${r.status}). Распакуйте DroneSim-assets-lite.zip из Releases в папку assets/ в корне репозитория.`);
  const text = await r.text();
  try { return JSON.parse(text) as T; }
  catch { throw new AssetMissingError(`Ассет «${url}» не найден или повреждён (вместо JSON пришёл HTML). Распакуйте DroneSim-assets-lite.zip из Releases в папку assets/ в корне репозитория.`); }
}
let texRes: '1k' | '2k' = '2k';
const manager = new THREE.LoadingManager();
// Poly Haven props reference their own *_2k.jpg maps: swap to the 1k set on the Low profile / mobile build
manager.setURLModifier((url) => (texRes === '1k' ? url.replace(/_2k\.jpg$/, '_1k.jpg') : url));
const gltfLoader = new GLTFLoader(manager);
const texLoader = new THREE.TextureLoader(manager);

export function loadGLTF(url: string): Promise<GLTF> { return gltfLoader.loadAsync(ASSET_URL + url); }

export class RenderWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sun: THREE.DirectionalLight;
  private sunDir = new THREE.Vector3(0, -1, 0);
  private texCache = new Map<string, THREE.Texture>();
  private matCache = new Map<string, THREE.MeshStandardMaterial>();
  maxAniso = 1;
  sky: SkyDome | null = null;
  /** colliders of the buildings / trees around the map (filled by loadMap) */
  readonly outerBoxes: OuterBox[] = [];

  constructor(canvas: HTMLCanvasElement, readonly quality: Quality) {
    texRes = quality.tex;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, quality.maxDpr) * quality.renderScale);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.sun = new THREE.DirectionalLight(0xfff4e5, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(quality.shadowMap, quality.shadowMap);
    const c = this.sun.shadow.camera;
    c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.near = 1; c.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.camera.layers.enableAll(); // drone (layer 1) casts shadows even when hidden from FPV
    this.scene.add(this.sun, this.sun.target);
  }

  resize(w: number, h: number) { this.renderer.setSize(w, h, false); }

  async loadEnvironment(L: MapLayout) {
    const hdr = await new HDRLoader().loadAsync(ASSET_URL + 'hdri/' + L.env.hdri);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.environment = hdr;
    this.scene.environmentIntensity = 0.85;
    const d = L.env.sun.dir;
    this.sunDir.set(d[0], d[1], d[2]).normalize();
    this.sun.intensity = L.env.sun.intensity;
    // fog takes the sky's own colour at the horizon (tone-mapped: three applies fog after tone mapping), and the
    // sky dome fades into it, so the far land dissolves into the sky without a line
    const fog = acesToneMap(horizonColor(hdr), this.renderer.toneMappingExposure);
    this.scene.fog = new THREE.FogExp2(fog, fogDensity(L));
    this.sky = new SkyDome(hdr, fog);
    this.scene.background = null;
    this.scene.add(this.sky.mesh);
  }

  /** keep the shadow frustum centred on the drone */
  followSun(target: THREE.Vector3) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, -150);
  }

  private texture(url: string, srgb: boolean): THREE.Texture {
    let t = this.texCache.get(url);
    if (!t) {
      t = texLoader.load(ASSET_URL + url);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false; // glTF UV convention (exporter wrote v' = 1 - v)
      t.anisotropy = this.maxAniso;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      this.texCache.set(url, t);
    }
    return t;
  }

  /** PBR set from assets/textures/<tex>/ (Poly Haven naming: diff / nor_gl / arm = AO,rough,metal). */
  pbrMaterial(tex: string): THREE.MeshStandardMaterial {
    let m = this.matCache.get(tex);
    if (!m) {
      const base = `textures/${tex}/${tex}`;
      const r = this.quality.tex;
      const arm = this.texture(`${base}_arm_${r}.jpg`, false);
      m = new THREE.MeshStandardMaterial({
        name: 'M_' + tex,
        map: this.texture(`${base}_diff_${r}.jpg`, true),
        normalMap: this.texture(`${base}_nor_gl_${r}.jpg`, false),
        aoMap: arm, roughnessMap: arm, metalnessMap: arm, roughness: 1, metalness: 1, aoMapIntensity: 0.8,
      });
      if (NATURAL_GROUND.test(tex)) groundVariation(m);
      this.matCache.set(tex, m);
    }
    return m;
  }

  async loadMap(L: MapLayout): Promise<THREE.Group> {
    const g = await loadGLTF(`maps/${L.id}/${L.geometry}`);
    const root = g.scene;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const tex = (mat.userData?.tex as string | undefined) ?? L.materials[mat.name]?.tex ?? undefined;
      if (tex) mesh.material = this.pbrMaterial(tex);
      const ground = /grass|asphalt|gravel|floor|pavement/i.test(tex ?? '');
      mesh.receiveShadow = true;
      mesh.castShadow = !ground;
    });
    const og = overgrowFor(L);
    if (og) setGroundBlend(this.pbrMaterial(og.tex), this.pbrMaterial(og.ground).map!, og.tile, og.from, og.to);
    this.scene.add(root);
    // hills, far range, forest / city around the map instead of an empty plane
    this.scene.add(buildSurroundings(this, L, { low: this.quality.id === 'low', boxes: this.outerBoxes }));
    return root;
  }

  /** Instantiate Poly Haven props; returns world-space boxes for colliders. */
  async loadProps(L: MapLayout, onBox: (center: THREE.Vector3, half: THREE.Vector3, q: THREE.Quaternion) => void) {
    if (!this.quality.props) return;
    const byAsset = new Map<string, typeof L.props>();
    for (const p of L.props) (byAsset.get(p.asset) ?? byAsset.set(p.asset, []).get(p.asset)!).push(p);
    await Promise.all([...byAsset].map(async ([asset, list]) => {
      let src: THREE.Object3D;
      try { src = (await loadGLTF(`props/${asset}/${asset}.gltf`)).scene; } catch { return; }
      src.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      const bb = new THREE.Box3().setFromObject(src);
      const size = bb.getSize(new THREE.Vector3()), centre = bb.getCenter(new THREE.Vector3());
      for (const p of list) {
        const o = src.clone();
        o.position.set(p.pos[0], p.pos[1], p.pos[2]);
        o.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3]);
        o.scale.setScalar(p.scale);
        this.scene.add(o);
        if (p.collide !== false && size.y > 0.15) {
          const c = centre.clone().multiplyScalar(p.scale).applyQuaternion(o.quaternion).add(o.position);
          onBox(c, size.clone().multiplyScalar(0.5 * p.scale), o.quaternion.clone());
        }
      }
    }));
  }
}
