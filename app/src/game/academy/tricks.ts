// Trick detector (PLAN.md 8.1, lesson 9): recognises flips, rolls, power loops and split-S from the attitude
// history. Every frame the body-frame rotation since the last frame is integrated per axis over a sliding window;
// a trick is a window whose accumulated rotation (plus the path: speed, height, heading) matches its pattern.
import * as THREE from 'three';

export type TrickName = 'flip' | 'roll' | 'power_loop' | 'split_s';
export const TRICK_LABEL: Record<TrickName, string> = { flip: 'Flip', roll: 'Roll', power_loop: 'Power loop', split_s: 'Split-S' };
export interface TrickEvent { name: TrickName; t: number }

interface Sample { t: number; roll: number; pitch: number; yaw: number; alt: number; vx: number; vz: number; upY: number }

const FULL = (2 * Math.PI) * 0.9;      // 324°: a full rotation with some slop at the ends
const HALF_LO = Math.PI * 0.65, HALF_HI = Math.PI * 1.35; // ~180° (117…243°)
const WINDOW = 4;                      // s of history kept
const FLIP_MAX_T = 2.5;                // a flip / roll must close within this time

const dq = new THREE.Quaternion(), qPrevInv = new THREE.Quaternion(), up = new THREE.Vector3();

export class TrickDetector {
  private hist: Sample[] = [];
  private prev = new THREE.Quaternion();
  private hasPrev = false;
  onTrick?: (e: TrickEvent) => void;

  reset() { this.hist.length = 0; this.hasPrev = false; }

  /** One frame: sim time, attitude, velocity, height above home. */
  update(t: number, rot: THREE.Quaternion, vel: THREE.Vector3Like, alt: number): TrickEvent | null {
    if (!this.hasPrev) { this.prev.copy(rot); this.hasPrev = true; return null; }
    // body-frame delta rotation: q_prev⁻¹ · q_now, as a rotation vector (x = pitch, y = yaw, z = roll; game axes)
    dq.copy(qPrevInv.copy(this.prev).invert()).multiply(rot);
    if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
    const s = Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
    const ang = 2 * Math.atan2(s, dq.w), k = s > 1e-9 ? ang / s : 2;
    this.prev.copy(rot);
    up.set(0, 1, 0).applyQuaternion(rot);
    this.hist.push({ t, pitch: dq.x * k, yaw: dq.y * k, roll: dq.z * k, alt, vx: vel.x, vz: vel.z, upY: up.y });
    while (this.hist.length && this.hist[0].t < t - WINDOW) this.hist.shift();
    const e = this.detect(t);
    if (e) { this.hist.length = 0; this.onTrick?.(e); }
    return e;
  }

  private detect(t: number): TrickEvent | null {
    const h = this.hist, n = h.length;
    if (n < 3) return null;
    const last = h[n - 1];
    if (last.upY < 0.3) return null; // judge a trick once the quad is upright again
    let roll = 0, pitch = 0, maxAlt = last.alt;
    for (let i = n - 1; i >= 0; i--) {
      const a = h[i], dt = t - a.t;
      roll += a.roll; pitch += a.pitch;
      maxAlt = Math.max(maxAlt, a.alt);
      const first = a; // window entry
      const sp0 = Math.hypot(first.vx, first.vz), sp1 = Math.hypot(last.vx, last.vz);
      if (dt <= FLIP_MAX_T) {
        if (Math.abs(roll) >= FULL && Math.abs(pitch) < Math.PI / 2) return { name: 'roll', t };
        if (Math.abs(pitch) >= FULL && Math.abs(roll) < Math.PI / 2) {
          // power loop: nose-up loop carried by speed, climbing well above the entry
          const loop = pitch > 0 && sp0 > 5 && maxAlt - first.alt > 3;
          return { name: loop ? 'power_loop' : 'flip', t };
        }
      }
      // split-S: half roll + half loop down, the flight direction reverses and height is lost
      if (Math.abs(roll) > HALF_LO && Math.abs(roll) < HALF_HI && Math.abs(pitch) > HALF_LO && sp0 > 3 && sp1 > 3) {
        const cos = (first.vx * last.vx + first.vz * last.vz) / (sp0 * sp1);
        if (cos < -0.6 && first.alt - last.alt > 2) return { name: 'split_s', t };
      }
    }
    return null;
  }
}
