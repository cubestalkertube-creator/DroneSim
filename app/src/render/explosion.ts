// Kamikaze blast effect (presets with `warhead`): flash light, fireball, sparks, ground shockwave, rising smoke and a
// scorch mark. Procedural (canvas textures, sprites, points) — no assets. Pure visuals: nothing in the world is hit.
import * as THREE from 'three';

let puffTex: THREE.Texture | null = null, cloudTex: THREE.Texture | null = null, scorchTex: THREE.Texture | null = null;

/** soft round puff: white centre fading to transparent */
function puff(): THREE.Texture {
  if (puffTex) return puffTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,.75)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  puffTex = new THREE.CanvasTexture(c); puffTex.colorSpace = THREE.SRGBColorSpace;
  return puffTex;
}

/** clumpy smoke puff: overlapping soft blobs, denser in the middle */
function cloud(): THREE.Texture {
  if (cloudTex) return cloudTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * 34, x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d, rr = 14 + Math.random() * 22;
    const r = g.createRadialGradient(x, y, 0, x, y, rr), v = 200 + Math.floor(Math.random() * 55);
    r.addColorStop(0, `rgba(${v},${v},${v},.5)`); r.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  }
  cloudTex = new THREE.CanvasTexture(c); cloudTex.colorSpace = THREE.SRGBColorSpace;
  return cloudTex;
}

/** blackened ground: dark irregular disc with a soft edge */
function scorch(): THREE.Texture {
  if (scorchTex) return scorchTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * 60, x = 128 + Math.cos(a) * d, y = 128 + Math.sin(a) * d, rr = 30 + Math.random() * 60;
    const r = g.createRadialGradient(x, y, 0, x, y, rr);
    r.addColorStop(0, 'rgba(12,10,8,.55)'); r.addColorStop(1, 'rgba(12,10,8,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  }
  scorchTex = new THREE.CanvasTexture(c); scorchTex.colorSpace = THREE.SRGBColorSpace;
  return scorchTex;
}

interface Puff { s: THREE.Sprite; v: THREE.Vector3; t0: number; life: number; s0: number; s1: number }

const FIRE_HOT = new THREE.Color(1, 0.78, 0.4), FIRE_MID = new THREE.Color(1, 0.38, 0.06), FIRE_END = new THREE.Color(0.3, 0.06, 0.01);
const tmpC = new THREE.Color();
/** additive puffs pile up: keep each one dim so the core stays orange instead of clipping to white */
const FIRE_OPACITY = 0.42;

export class Explosion {
  readonly root = new THREE.Group();
  t = 0;
  private light: THREE.PointLight;
  private flash: THREE.Sprite;
  private fire: Puff[] = [];
  private smoke: Puff[] = [];
  private sparks: THREE.Points; private sparkV: Float32Array; private sparkMat: THREE.PointsMaterial;
  private ring: THREE.Mesh | null = null;
  private mark: THREE.Mesh | null = null;
  private disposables: { dispose(): void }[] = [];

  /**
   * @param pos blast point, @param radius visual fireball radius (m, from the preset)
   * @param groundY terrain height under the blast (scorch mark and shockwave when the blast is near the ground)
   * @param detail 0.4..1 particle budget (quality profile)
   */
  constructor(pos: THREE.Vector3, readonly radius: number, groundY: number, detail = 1) {
    const R = radius;
    this.root.position.copy(pos);
    const low = pos.y - groundY < R * 1.2; // near enough to the ground to leave a mark

    this.light = new THREE.PointLight(0xffa850, 60 * R * R, R * 14, 1.6);
    this.root.add(this.light);

    const mat = (color: number, additive: boolean, opacity = 1) => {
      const m = new THREE.SpriteMaterial({ map: additive ? puff() : cloud(), color, transparent: true, opacity, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
      this.disposables.push(m); return m;
    };
    this.flash = new THREE.Sprite(mat(0xfff2d0, true));
    this.flash.scale.setScalar(R * 4);
    this.flash.renderOrder = 6;
    this.root.add(this.flash);

    const nFire = Math.round(14 * detail), nSmoke = Math.round(22 * detail);
    for (let i = 0; i < nFire; i++) {
      const s = new THREE.Sprite(mat(0xffffff, true)); s.renderOrder = 5;
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + (low ? 0.2 : -0.3), Math.random() - 0.5).normalize().multiplyScalar(R * (1.5 + Math.random() * 2.5));
      this.fire.push({ s, v, t0: Math.random() * 0.06, life: 0.7 + Math.random() * 0.5, s0: R * 0.3, s1: R * (0.9 + Math.random() * 0.7) });
      this.root.add(s);
    }
    for (let i = 0; i < nSmoke; i++) {
      const g = 0.05 + Math.random() * 0.09; // dark, sooty
      const s = new THREE.Sprite(mat(new THREE.Color(g, g * 0.95, g * 0.9).getHex(), false, 0)); s.renderOrder = 4;
      s.material.rotation = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.6 + Math.random() * 0.9, (Math.random() - 0.5) * 1.2).multiplyScalar(R * 0.35);
      s.position.set((Math.random() - 0.5) * R, (Math.random() - 0.2) * R * 0.6, (Math.random() - 0.5) * R);
      this.smoke.push({ s, v, t0: 0.12 + Math.random() * 0.5, life: 7 + Math.random() * 5, s0: R * 0.8, s1: R * (2.6 + Math.random() * 1.6) });
      this.root.add(s);
    }

    // sparks / debris: ballistic points, gravity, fade
    const nSpark = Math.round(160 * detail);
    const geo = new THREE.BufferGeometry(), p = new Float32Array(nSpark * 3);
    this.sparkV = new Float32Array(nSpark * 3);
    for (let i = 0; i < nSpark; i++) {
      const a = Math.random() * Math.PI * 2, up = low ? Math.random() * 0.95 + 0.05 : Math.random() * 2 - 1, h = Math.sqrt(1 - up * up);
      const sp = R * (3 + Math.random() * 6);
      this.sparkV.set([Math.cos(a) * h * sp, up * sp, Math.sin(a) * h * sp], i * 3);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    this.sparkMat = new THREE.PointsMaterial({ map: puff(), color: 0xffb040, size: Math.max(0.06, R * 0.06), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.sparks = new THREE.Points(geo, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.root.add(this.sparks);
    this.disposables.push(geo, this.sparkMat);

    if (low) {
      const gy = groundY - pos.y;
      const ringM = new THREE.MeshBasicMaterial({ map: puff(), color: 0xd8c8a8, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
      const ringG = new THREE.RingGeometry(0.75, 1, 48);
      this.ring = new THREE.Mesh(ringG, ringM);
      this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = gy + 0.08;
      const markM = new THREE.MeshBasicMaterial({ map: scorch(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
      const markG = new THREE.PlaneGeometry(R * 2.2, R * 2.2);
      this.mark = new THREE.Mesh(markG, markM);
      this.mark.rotation.x = -Math.PI / 2; this.mark.rotation.z = Math.random() * Math.PI; this.mark.position.y = gy + 0.03;
      this.root.add(this.ring, this.mark);
      this.disposables.push(ringM, ringG, markM, markG);
    }
  }

  /** Advance the effect; false once only the scorch mark is left. */
  update(dt: number): boolean {
    const t = (this.t += dt), R = this.radius;
    this.light.intensity = 60 * R * R * Math.exp(-t * 7) * (1 + 0.3 * Math.sin(t * 90));
    const fm = this.flash.material;
    fm.opacity = 0.8 * Math.max(0, 1 - t / 0.15);
    this.flash.scale.setScalar(R * (4 + t * 10));
    this.flash.visible = fm.opacity > 0;

    for (const f of this.fire) {
      const k = (t - f.t0) / f.life, m = f.s.material;
      f.s.visible = k > 0 && k < 1;
      if (!f.s.visible) continue;
      const e = 1 - Math.exp(-k * 6);              // fast expansion, then hangs
      f.s.position.copy(f.v).multiplyScalar(e * 0.35);
      f.s.position.y += k * R * 0.6;               // hot gas rises
      f.s.scale.setScalar(f.s0 + (f.s1 - f.s0) * e);
      if (k < 0.3) tmpC.copy(FIRE_HOT).lerp(FIRE_MID, k / 0.3); else tmpC.copy(FIRE_MID).lerp(FIRE_END, (k - 0.3) / 0.7);
      m.color.copy(tmpC);
      m.opacity = FIRE_OPACITY * (k < 0.1 ? 1 : Math.max(0, 1 - (k - 0.1) / 0.9) ** 1.5);
    }

    let alive = t < 2;
    for (const s of this.smoke) {
      const k = (t - s.t0) / s.life, m = s.s.material;
      s.s.visible = k > 0 && k < 1;
      if (!s.s.visible) continue;
      alive = true;
      s.s.position.addScaledVector(s.v, dt * (1.6 - k));
      s.s.scale.setScalar(s.s0 + (s.s1 - s.s0) * Math.sqrt(k));
      m.rotation += dt * 0.08;
      m.opacity = 0.8 * Math.min(1, k / 0.06) * (1 - k) ** 1.4;
    }

    const pos = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute, a = pos.array as Float32Array, v = this.sparkV;
    const drag = Math.exp(-dt * 1.2);
    for (let i = 0; i < a.length; i += 3) {
      v[i] *= drag; v[i + 1] = v[i + 1] * drag - 9.81 * dt; v[i + 2] *= drag;
      a[i] += v[i] * dt; a[i + 1] += v[i + 1] * dt; a[i + 2] += v[i + 2] * dt;
    }
    pos.needsUpdate = true;
    this.sparkMat.opacity = Math.max(0, 1 - t / 1.8);
    this.sparks.visible = this.sparkMat.opacity > 0;

    if (this.ring) {
      const k = t / 0.7;
      this.ring.visible = k < 1;
      this.ring.scale.setScalar(R * (0.5 + 5 * (1 - (1 - Math.min(1, k)) ** 3)));
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.7 * Math.max(0, 1 - k);
    }
    if (this.mark) (this.mark.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, t * 4);
    return alive;
  }

  /** camera shake strength at a distance d from the blast (0..1) */
  shakeAt(d: number) { return Math.min(1, (this.radius * 3) / Math.max(1, d)) * Math.exp(-this.t * 2.5); }

  dispose() {
    this.root.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
