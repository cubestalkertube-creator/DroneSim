// Camera rigs (PLAN.md 6): FPV (body-fixed, uptilt, wide FOV), Chase (3rd person), LOS (pilot on the ground).
import * as THREE from 'three';
import { DRONE_LAYER } from '../render/droneView';

export type CamMode = 'fpv' | 'chase' | 'los';
export const CAM_ORDER: CamMode[] = ['fpv', 'chase', 'los'];
export const CAM_LABEL: Record<CamMode, string> = { fpv: 'FPV', chase: 'От 3-го лица', los: 'С земли (LOS)' };

const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.03, 4000);
  mode: CamMode = 'fpv';
  fpvHFov = 120;   // rectilinear; fisheye (150-155) comes with the stage-4 distortion shader
  showDroneInFpv = false;
  /** GPS camera drones: stabilised gimbal camera instead of a body-fixed FPV camera */
  gimbal = false;
  gimbalPitch = -10; gimbalRange: [number, number] = [-90, 30];
  private gq = new THREE.Quaternion(); private gInit = false;
  pilot = new THREE.Vector3();
  private chasePos = new THREE.Vector3();
  private chaseInit = false;
  aspect = 1;
  /** after a kamikaze blast the FPV feed is gone: a fixed observer camera looks at the explosion instead */
  blast: { from: THREE.Vector3; at: THREE.Vector3 } | null = null;
  /** camera shake 0..1 (blast), applied on top of any view */
  shake = 0;

  setAspect(a: number) { this.aspect = a; }

  private setHFov(h: number) {
    const v = 2 * Math.atan(Math.tan((h * Math.PI) / 360) / this.aspect) * (180 / Math.PI);
    if (Math.abs(this.camera.fov - v) > 1e-3) { this.camera.fov = v; }
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, pos: THREE.Vector3, rot: THREE.Quaternion, eye: THREE.Vector3, uptiltDeg: number, size: number) {
    const cam = this.camera;
    if (this.mode === 'fpv' && !this.showDroneInFpv) cam.layers.disable(DRONE_LAYER); else cam.layers.enable(DRONE_LAYER);
    if (this.blast) {
      this.setHFov(85);
      cam.position.copy(this.blast.from);
      cam.lookAt(this.blast.at);
      cam.near = 0.1;
      this.chaseInit = false; this.gInit = false;
    } else if (this.mode === 'fpv' && this.gimbal) {
      // 3-axis gimbal: follows the drone's heading only, pitch from the tilt control, smooth like a real one
      this.setHFov(this.fpvHFov);
      cam.position.copy(eye).applyQuaternion(rot).add(pos);
      const f = tmpV.set(0, 0, -1).applyQuaternion(rot);
      const yaw = Math.atan2(-f.x, -f.z);
      tmpQ.setFromEuler(tmpE.set((this.gimbalPitch * Math.PI) / 180, yaw, 0, 'YXZ'));
      if (!this.gInit) { this.gq.copy(tmpQ); this.gInit = true; }
      this.gq.slerp(tmpQ, 1 - Math.exp(-dt * 10));
      cam.quaternion.copy(this.gq);
      cam.near = 0.05;
      this.chaseInit = false;
    } else if (this.mode === 'fpv') {
      this.setHFov(this.fpvHFov);
      cam.position.copy(eye).applyQuaternion(rot).add(pos);
      tmpQ.setFromEuler(tmpE.set((uptiltDeg * Math.PI) / 180, 0, 0)); // tilt up about body X
      cam.quaternion.copy(rot).multiply(tmpQ);
      cam.near = 0.02;
      this.chaseInit = false;
    } else if (this.mode === 'chase') {
      this.gInit = false;
      this.setHFov(95);
      // yaw-only frame of the drone, camera behind and above, spring-smoothed
      const fwd = tmpV.set(0, 0, -1).applyQuaternion(rot); fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      const dist = Math.max(1.2, size * 5), h = Math.max(0.5, size * 1.8);
      const desired = new THREE.Vector3().copy(pos).addScaledVector(fwd, -dist); desired.y += h;
      if (!this.chaseInit) { this.chasePos.copy(desired); this.chaseInit = true; }
      this.chasePos.lerp(desired, 1 - Math.exp(-dt * 6));
      cam.position.copy(this.chasePos);
      cam.lookAt(pos);
      cam.near = 0.05;
    } else {
      const d = this.pilot.distanceTo(pos);
      this.setHFov(THREE.MathUtils.clamp(4000 / Math.max(d, 1), 18, 75)); // pilot "eyes": zoom with distance
      cam.position.copy(this.pilot);
      cam.lookAt(pos);
      cam.near = 0.1;
      this.chaseInit = false;
    }
    if (this.shake > 0.002) {
      const s = this.shake * 0.35;
      cam.position.x += (Math.random() - 0.5) * s; cam.position.y += (Math.random() - 0.5) * s; cam.position.z += (Math.random() - 0.5) * s;
      cam.rotateZ((Math.random() - 0.5) * s * 0.15);
    }
    cam.updateProjectionMatrix();
  }
}
