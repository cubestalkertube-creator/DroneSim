// Model-based mixer with Betaflight-style airmode (PHYSICS.md 5.3).
// Converts collective throttle + desired FC-axis angular acceleration into per-motor commands [idle..1].
import type { DroneModel } from './presets';

export class Mixer {
  readonly n: number;
  private readonly mr: Float64Array; // roll factor per motor  (roll right  = -x)
  private readonly mp: Float64Array; // pitch factor           (nose down   = +z)
  private readonly my: Float64Array; // yaw factor             (nose right  = CCW motors up)
  private readonly sr: number; private readonly sp: number; private readonly sy: number;
  readonly out: Float64Array;
  /** failed motors (MotorBank.failed): allocation over the working ones by pseudo-inverse */
  failed: Uint8Array | null = null;
  private failMask = -1;
  private ainv = new Float64Array(4); // inverse of sum over alive motors of [mr mp]^T [mr mp]
  /** yaw direction that leaves roll, pitch and total thrust untouched (null space), and its torque gain */
  private yawPerp = new Float64Array(0); private yawGain = 0; private yawLim = 0;

  constructor(private m: DroneModel) {
    this.n = m.rotors.length;
    this.mr = new Float64Array(this.n); this.mp = new Float64Array(this.n); this.my = new Float64Array(this.n);
    m.rotors.forEach((r, i) => { this.mr[i] = -r.pos.x; this.mp[i] = r.pos.z; this.my[i] = -r.spin; });
    const ss = (a: Float64Array) => a.reduce((s, v) => s + v * v, 0);
    this.sr = ss(this.mr); this.sp = ss(this.mp); this.sy = ss(this.my);
    this.out = new Float64Array(this.n);
  }

  /** @param airmode keep authority at zero throttle by raising the collective */
  mix(throttle: number, accel: readonly [number, number, number], armed: boolean, airmode: boolean): Float64Array {
    const m = this.m, o = this.out, n = this.n;
    if (!armed) { o.fill(0); return o; }
    const idle = m.idle;
    const thr = idle + throttle * (1 - idle);
    // linearise thrust/torque vs command around the current collective with the motor's steady Ω(c) curve:
    // dT/dc = 2 kT Ω(c) Ω'(c). The FC does not know the pack voltage (no vbat sag compensation): a fresh pack
    // feels sharper, an empty one softer — like the real thing.
    const cbar = Math.max(thr, 0.25);
    const curve = m.omegaCurve, N = curve.length - 1;
    const x = Math.min(cbar, 1) * N, j = Math.min(N - 1, Math.floor(x));
    const slope = (curve[j + 1] - curve[j]) * N;
    const w = curve[j] + (curve[j + 1] - curve[j]) * (x - j);
    const g = 2 * w * Math.max(slope, 0.2 * w) * m.ductGain;
    const dTdc = m.kT0 * g;
    const dQdc = m.kQ0 * g;
    const tr = accel[0] * m.inertia.z, tp = accel[1] * m.inertia.x, ty = accel[2] * m.inertia.y;
    let lo = Infinity, hi = -Infinity;
    const fail = this.failed, degraded = !!fail && this.updateFailures(fail);
    if (degraded) {
      // minimum-norm roll/pitch allocation over the working motors, d = B^T (B B^T)^-1 tau; yaw only in the
      // null space of roll/pitch/thrust, which is weak with a motor out: the airframe turns, attitude holds
      const a = this.ainv, b0 = tr / dTdc, b1 = tp / dTdc;
      const z0 = a[0] * b0 + a[1] * b1, z1 = a[2] * b0 + a[3] * b1;
      // roll/pitch first: yaw gets at most DEGRADED_YAW_HEADROOM of command per motor
      const zy = clamp((this.yawGain * ty) / dQdc, -this.yawLim, this.yawLim);
      for (let i = 0; i < n; i++) {
        if (fail![i]) { o[i] = 0; continue; }
        const d = this.mr[i] * z0 + this.mp[i] * z1 + this.yawPerp[i] * zy;
        o[i] = d;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
    } else for (let i = 0; i < n; i++) {
      const d = (tr * this.mr[i]) / (this.sr * dTdc) + (tp * this.mp[i]) / (this.sp * dTdc) + (ty * this.my[i]) / (this.sy * dQdc);
      o[i] = d;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    // shrink the differential if it can't fit in the usable range
    const range = 1 - idle;
    const spread = hi - lo;
    const k = spread > range ? range / spread : 1;
    lo *= k; hi *= k;
    let base = thr;
    // airmode must not lift the collective to make room for a dead motor's partner: the drone would climb away
    if (airmode && !degraded) base = Math.min(Math.max(thr, idle - lo), 1 - hi);
    else base = Math.min(thr, 1 - hi);
    for (let i = 0; i < n; i++) o[i] = degraded && fail![i] ? 0 : Math.min(1, Math.max(airmode ? idle : 0, base + o[i] * k));
    return o;
  }

  /** @returns true when some motor has failed; recomputes the allocation when the set changes */
  private updateFailures(fail: Uint8Array): boolean {
    let mask = 0;
    for (let i = 0; i < this.n; i++) if (fail[i]) mask |= 1 << i;
    if (mask === this.failMask) return mask !== 0;
    this.failMask = mask;
    if (!mask) return false;
    let a = 0, b = 0, d = 0;
    for (let i = 0; i < this.n; i++) {
      if (fail[i]) continue;
      a += this.mr[i] * this.mr[i]; b += this.mr[i] * this.mp[i]; d += this.mp[i] * this.mp[i];
    }
    const det = a * d - b * b || 1e-12;
    this.ainv[0] = d / det; this.ainv[1] = -b / det; this.ainv[2] = -b / det; this.ainv[3] = a / det;
    // Gram-Schmidt: remove the roll, pitch and collective directions from the yaw vector (working motors only)
    const n = this.n, alive = (v: Float64Array) => v.map((x, i) => (fail[i] ? 0 : x));
    const basis: Float64Array[] = [];
    for (const v0 of [this.mr, this.mp, new Float64Array(n).fill(1)]) {
      const v = alive(v0);
      for (const u of basis) { const k = dotN(v, u); for (let i = 0; i < n; i++) v[i] -= k * u[i]; }
      const l = Math.sqrt(dotN(v, v));
      if (l > 1e-9) basis.push(v.map((x) => x / l));
    }
    const y = alive(this.my);
    for (const u of basis) { const k = dotN(y, u); for (let i = 0; i < n; i++) y[i] -= k * u[i]; }
    const g = dotN(y, this.my);
    this.yawPerp = y; this.yawGain = Math.abs(g) > 1e-9 ? 1 / g : 0;
    this.yawLim = DEGRADED_YAW_HEADROOM / Math.max(1e-9, ...y.map(Math.abs));
    return true;
  }

  /**
   * Betaflight "flip over after crash": the props run reversed; the motors whose reversed thrust turns the
   * quad the way the stick points get |stick|, the rest stay off. Yaw is used when roll/pitch are centred.
   * Output: negative commands (-1..0) in `out`.
   */
  mixTurtle(roll: number, pitch: number, yaw: number): Float64Array {
    const o = this.out, n = this.n;
    const dz = (v: number) => (Math.abs(v) < TURTLE_DEADBAND ? 0 : v);
    roll = dz(roll); pitch = dz(pitch); yaw = dz(yaw);
    const mag = Math.max(Math.abs(roll), Math.abs(pitch));
    for (let i = 0; i < n; i++) {
      let c: number;
      if (mag > 0) {
        // reversed thrust at (x, z) gives roll-right torque ~ +x and nose-down torque ~ -z (see drone.ts)
        const rx = -this.mr[i], rz = this.mp[i];
        const r = Math.hypot(rx, rz) || 1;
        c = ((roll * rx) / r - (pitch * rz) / r) / mag;
      } else c = Math.sign(yaw) * -this.my[i]; // reversed CW motors push the nose right
      const x = Math.min(1, Math.max(mag, Math.abs(yaw)));
      o[i] = c > 0.3 ? -(x * x * x * TURTLE_EXPO + x * (1 - TURTLE_EXPO)) : 0;
    }
    return o;
  }
}

const TURTLE_DEADBAND = 0.1;
const DEGRADED_YAW_HEADROOM = 0.25;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const TURTLE_EXPO = 0.35; // Betaflight crashflip_expo default: half stick = gentle nudge, full stick = full power

const dotN = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
