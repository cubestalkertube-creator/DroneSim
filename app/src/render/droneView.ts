// Visual drone: GLB with rotor_<i> nodes spun by the simulated rotor speed; blur discs above ~1500 rpm.
import * as THREE from 'three';
import { loadGLTF } from './world';

const BLUR_OMEGA = 160; // rad/s (~1500 rpm)
export const DRONE_LAYER = 1;

interface RotorVis { node: THREE.Object3D; blades?: THREE.Object3D; blur?: THREE.Mesh; spin: number; angle: number }

export class DroneView {
  readonly root = new THREE.Group();
  rotors: RotorVis[] = [];
  /** FPV eye position in body frame (from the GLB `fpv_cam` node or a default on the nose) */
  readonly eye = new THREE.Vector3();
  uptiltDeg = 30;
  size = 0.3;
  /** fixed wing: elevon hinge nodes (rotate about their local X, trailing edge down = +) */
  private elevons: (THREE.Object3D | undefined)[] = [];
  private bottom = 0;

  async load(modelUrl: string, uptiltDeg: number) {
    const g = await loadGLTF(modelUrl);
    const scene = g.scene;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = false; }
      o.layers.set(DRONE_LAYER); // FPV camera skips this layer (props would fill the view), shadows still render
    });
    const found: RotorVis[] = [];
    scene.traverse((o) => {
      const mt = /^rotor_(\d+)$/.exec(o.name);
      if (!mt) return;
      const r: RotorVis = { node: o, spin: o.userData.spin === 'ccw' ? 1 : -1, angle: 0 };
      o.traverse((c) => {
        if (c.name.endsWith('_blades')) r.blades = c;
        if (c.name.endsWith('_blur') && (c as THREE.Mesh).isMesh) {
          r.blur = c as THREE.Mesh;
          const mat = (r.blur.material as THREE.MeshStandardMaterial).clone();
          mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide;
          r.blur.material = mat; r.blur.castShadow = false; r.blur.renderOrder = 2;
        }
      });
      found[+mt[1]] = r;
    });
    this.rotors = found.filter(Boolean);
    this.elevons = [scene.getObjectByName('elevon_L'), scene.getObjectByName('elevon_R')];
    const bb = new THREE.Box3().setFromObject(scene);
    this.size = bb.getSize(new THREE.Vector3()).length();
    this.bottom = bb.min.y;
    const cam = scene.getObjectByName('fpv_cam');
    if (cam) {
      scene.updateMatrixWorld(true);
      cam.getWorldPosition(this.eye);
      this.uptiltDeg = (cam.userData.uptilt_deg as number) ?? uptiltDeg;
    } else {
      this.eye.set(0, bb.min.y + (bb.max.y - bb.min.y) * 0.3, bb.min.z);
      this.uptiltDeg = uptiltDeg;
    }
    this.root.add(scene);
  }

  /** Kamikaze FPV: the charge strapped under the frame (olive tube with a nose cone along -Z), sized to the wheelbase. */
  addCharge(wheelbase: number) {
    const r = wheelbase * 0.1, L = wheelbase * 0.7;
    const mat = new THREE.MeshStandardMaterial({ color: 0x4b5320, roughness: 0.75, metalness: 0.1 });
    const band = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 });
    const g = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 18), mat);
    tube.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(r, r * 1.8, 18), mat);
    nose.rotation.x = -Math.PI / 2; nose.position.z = -(L / 2 + r * 0.9);
    g.add(tube, nose);
    for (const z of [-L * 0.25, L * 0.25]) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.06, r * 1.06, r * 0.35, 18), band);
      s.rotation.x = Math.PI / 2; s.position.z = z; g.add(s);
    }
    g.position.set(0, this.bottom - r * 0.6, -L * 0.12);
    g.traverse((o) => { o.layers.set(DRONE_LAYER); const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
    this.root.add(g);
  }

  /** @param l @param r elevon deflections (rad) from the simulation */
  setElevons(l: number, r: number) {
    if (this.elevons[0]) this.elevons[0].rotation.x = l;
    if (this.elevons[1]) this.elevons[1].rotation.x = r;
  }

  /** @param omega rotor speeds (rad/s) from the simulation */
  update(dt: number, omega: ArrayLike<number>) {
    for (let i = 0; i < this.rotors.length; i++) {
      const r = this.rotors[i], w = omega[i] ?? 0;
      const fast = w > BLUR_OMEGA;
      // real angle when slow; when blurred rotate the disc slowly (avoids stroboscopic aliasing)
      r.angle += (fast ? 9 : w) * dt * r.spin;
      if (r.blades) { r.blades.visible = !fast; r.blades.rotation.y = r.angle; }
      if (r.blur) {
        r.blur.visible = w > BLUR_OMEGA * 0.6;
        r.blur.rotation.y = r.angle;
        (r.blur.material as THREE.MeshStandardMaterial).opacity = Math.min(1, (w - BLUR_OMEGA * 0.6) / BLUR_OMEGA) * 0.9;
      }
    }
  }
}
