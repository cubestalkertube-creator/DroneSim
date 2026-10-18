// 3D markers of the academy targets (game/academy/runner.ts Target): checkpoint spheres, ground circles with a
// light beam, gate frames and marker poles. Unlit, no fog, no collision — guidance only. The first target of a
// step is the active one (accent colour, pulsing); the rest are previews (dim, secondary colour).
import * as THREE from 'three';
import type { Target } from './runner';

const ACCENT = 0xc8ff2e, NEXT = 0x3dd9ff, POLE = 0xff8a1f;

export class LessonView {
  readonly root = new THREE.Group();
  private stepGroup = new THREE.Group();
  private propGroup = new THREE.Group();
  private active: THREE.Object3D[] = [];
  private mats = {
    on: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    onLine: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, depthWrite: false, fog: false }),
    next: new THREE.MeshBasicMaterial({ color: NEXT, transparent: true, opacity: 0.18, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    nextLine: new THREE.MeshBasicMaterial({ color: NEXT, transparent: true, opacity: 0.45, depthWrite: false, fog: false }),
    beam: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.12, depthWrite: false, fog: false, side: THREE.DoubleSide }),
    pole: new THREE.MeshStandardMaterial({ color: POLE, roughness: 0.6 }),
  };
  private t = 0;
  private key = '';

  constructor() {
    this.root.add(this.stepGroup, this.propGroup);
    this.root.renderOrder = 4;
  }

  setProps(list: Target[]) {
    clear(this.propGroup);
    for (const p of list) if (p.kind === 'pole') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, p.h, 12), this.mats.pole);
      m.position.set(p.c.x, p.c.y + p.h / 2, p.c.z); m.castShadow = true;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), this.mats.onLine);
      cap.position.set(p.c.x, p.c.y + p.h, p.c.z);
      this.propGroup.add(m, cap);
    }
  }

  /** targets of the current step (rebuilt only when the step changes); `preview`: all dim (the next step's) */
  setTargets(list: Target[], key: string, preview = false) {
    if (key === this.key) return;
    this.key = key;
    clear(this.stepGroup); this.active = [];
    list.forEach((tg, i) => {
      const o = this.make(tg, i === 0 && !preview);
      this.stepGroup.add(o);
      if (i === 0) this.active.push(o);
    });
  }

  update(dt: number) {
    this.t += dt;
    const s = 1 + 0.06 * Math.sin(this.t * 5);
    for (const o of this.active) if (o.userData.pulse) o.scale.setScalar(s);
    this.mats.on.opacity = 0.28 + 0.1 * Math.sin(this.t * 5);
  }

  private make(tg: Target, on: boolean): THREE.Object3D {
    const fill = on ? this.mats.on : this.mats.next, line = on ? this.mats.onLine : this.mats.nextLine;
    const g = new THREE.Group();
    switch (tg.kind) {
      case 'point': {
        const sph = new THREE.Mesh(new THREE.SphereGeometry(tg.r, 24, 16), fill);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(tg.r, Math.max(0.04, tg.r * 0.03), 6, 48), line);
        ring.rotation.x = Math.PI / 2;
        g.add(sph, ring);
        g.position.copy(tg.c); g.userData.pulse = true;
        if (on) { // beam down to the ground so the target is easy to find from afar
          const h = 60, beam = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, h, 6, 1, true), this.mats.beam);
          beam.position.y = h / 2 + tg.r; g.add(beam);
        }
        break;
      }
      case 'pad': {
        const ring = new THREE.Mesh(new THREE.RingGeometry(tg.r * 0.94, tg.r, 48), line);
        ring.rotation.x = -Math.PI / 2;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(tg.r, 48), fill);
        disc.rotation.x = -Math.PI / 2; disc.position.y = -0.005;
        g.add(ring, disc);
        if (on) {
          const h = 30, beam = new THREE.Mesh(new THREE.CylinderGeometry(tg.r, tg.r, h, 32, 1, true), this.mats.beam);
          beam.position.y = h / 2; g.add(beam);
        }
        g.position.set(tg.c.x, tg.c.y + 0.12, tg.c.z);
        break;
      }
      case 'gate': {
        const t = 0.08, W = tg.w + t, H = tg.h + t;
        const bar = (w: number, h: number, x: number, y: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), line); m.position.set(x, y, 0); g.add(m); };
        bar(W, t, 0, H / 2); bar(W, t, 0, -H / 2); bar(t, H, -W / 2, 0); bar(t, H, W / 2, 0);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(tg.w, tg.h), on ? this.mats.beam : this.mats.next);
        g.add(pane);
        g.position.copy(tg.c); g.quaternion.copy(tg.q); g.userData.pulse = true;
        break;
      }
      case 'pole': break; // props only
    }
    g.renderOrder = 4;
    return g;
  }

  dispose() { clear(this.stepGroup); clear(this.propGroup); }
}

function clear(g: THREE.Group) {
  for (const c of [...g.children]) {
    c.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    g.remove(c);
  }
}
