// Betaflight-like flight controller (PHYSICS.md 5.2-5.3): rates, Acro/Angle/Horizon, PID+FF rate loop, arming,
// gyro + D-term low-pass filters, TPA, anti-gravity, iterm relax, turtle mode (flip over after crash).
// FC axes (stick convention): roll+ = roll right, pitch+ = nose down (stick forward), yaw+ = nose right.
// The PID outputs a desired angular ACCELERATION (rad/s^2); the mixer turns it into motor commands using the
// drone model, so gains mean the same thing on every airframe.
import { DEG, clamp, pt1k } from '../math';
import { applyRate, type RateProfile } from '../rates';
import type { DronePreset } from '../presets';

export type FlightMode = 'acro' | 'angle' | 'horizon';

export interface Sticks { throttle: number; roll: number; pitch: number; yaw: number } // throttle 0..1, others -1..1

export interface FcOutput { throttle: number; accel: [number, number, number] } // collective 0..1, FC-axis rad/s^2

// Mapping from Betaflight-style PID numbers (as in drones.json) to physical gains.
const KP_SCALE = 0.8;    // 45 -> 36 1/s
const KI_SCALE = 1.5;    // 80 -> 120 1/s^2
const KD_SCALE = 0.016;  // 30 -> 0.48 s: D/P time ~13 ms, like BF (P x0.032, D x0.00053 -> ~11 ms)
const KFF_SCALE = 1 / 120; // 120 -> 1.0 x the setpoint acceleration
const ANGLE_GAIN = 6.0;  // (rad/s) per rad of attitude error in Angle mode
const ANGLE_RATE_LIMIT = 400 * DEG;
const I_LIMIT = 40;      // rad/s^2
const FF_LPF_HZ = 40;
// iterm_relax (BF setpoint mode): I accumulation x max(0, 1 - |hp(setpoint)|/threshold), hp = sp - PT1(sp, cutoff)
const ITERM_RELAX_HZ = 15, ITERM_RELAX_DPS = 30;
// anti-gravity: |d(throttle)/dt| is low-passed and saturates at AG_FULL_RATE (1/s) -> Ki *= 1 + gain
const AG_LPF_HZ = 15, AG_FULL_RATE = 5;
// Betaflight firmware defaults when the preset does not override them
const DEFAULT_GYRO_LPF_HZ = 250, DEFAULT_DTERM_LPF_HZ = 120, DEFAULT_TPA: [number, number] = [0.65, 0.35], DEFAULT_AG = 2.5;

class AxisPid {
  i = 0; prevSp = 0; prevGyro = 0; ffF = 0; dF = 0; spLp = 0;
  constructor(public kp: number, public ki: number, public kd: number, public kff: number, private dLpfHz: number) {}
  reset() { this.i = 0; this.ffF = 0; this.dF = 0; this.spLp = this.prevSp; }
  /**
   * @param tpaP TPA multiplier on P
   * @param tpaD TPA multiplier on D
   * @param iBoost anti-gravity multiplier on the I-term accumulation
   */
  step(sp: number, gyro: number, dt: number, iRelax: boolean, tpaP: number, tpaD: number, iBoost: number): number {
    const e = sp - gyro;
    const spDot = (sp - this.prevSp) / dt;
    this.prevSp = sp;
    this.ffF += pt1k(FF_LPF_HZ, dt) * (spDot - this.ffF);
    // D on measurement through the D-term low-pass (gyro noise and motor vibration end up here)
    const gyroDot = (gyro - this.prevGyro) / dt;
    this.prevGyro = gyro;
    this.dF += pt1k(this.dLpfHz, dt) * (gyroDot - this.dF);
    // iterm_relax: don't integrate while the setpoint moves (flips/rolls, stick snaps), like BF iterm_relax=RP
    this.spLp += pt1k(ITERM_RELAX_HZ, dt) * (sp - this.spLp);
    const relax = iRelax ? Math.max(0, 1 - Math.abs(sp - this.spLp) / (ITERM_RELAX_DPS * DEG)) : 1;
    this.i = clamp(this.i + this.ki * iBoost * relax * e * dt, -I_LIMIT, I_LIMIT);
    return tpaP * this.kp * e - tpaD * this.kd * this.dF + this.i + this.kff * this.ffF;
  }
}

export class BetaflightFC {
  mode: FlightMode;
  armed = false;
  airmode: boolean;
  rates: RateProfile;
  maxAngle: number;
  pids: [AxisPid, AxisPid, AxisPid];
  private out: FcOutput = { throttle: 0, accel: [0, 0, 0] };
  setpoint: [number, number, number] = [0, 0, 0]; // rad/s, FC axes (for HUD/tests)
  /** filtered gyro (rad/s, FC axes) as the PID sees it */
  gyroF: [number, number, number] = [0, 0, 0];
  armBlockReason = '';
  /** turtle mode switch ("flip over after crash"): when armed, the motors run reversed from the sticks */
  turtle = false;
  /** TPA rate and breakpoint (throttle 0..1); mode 'D' (Betaflight 4.3+ default) or 'PD' */
  readonly tpa: [number, number];
  readonly tpaMode: 'D' | 'PD';
  antiGravity: number;
  /** last TPA multiplier and anti-gravity boost (telemetry/tests) */
  tpaFactor = 1; agBoost = 1;
  private gyroLpfHz: number;
  private prevThr = 0; private thrRate = 0;

  constructor(p: DronePreset) {
    this.mode = (p.fc.default_mode as FlightMode) ?? 'acro';
    if (!['acro', 'angle', 'horizon'].includes(this.mode)) this.mode = 'angle';
    this.airmode = p.fc.airmode ?? true;
    this.rates = p.fc.rates ?? { type: 'actual', roll: [70, 670, 0.54], pitch: [70, 670, 0.54], yaw: [70, 500, 0.2] };
    this.maxAngle = (p.fc.max_angle ?? 55) * DEG;
    const g = p.fc.pid ?? { roll: [45, 80, 30, 120], pitch: [47, 84, 34, 125], yaw: [45, 80, 0, 120] };
    const dLpf = p.fc.filters?.dterm_lpf_hz ?? DEFAULT_DTERM_LPF_HZ;
    const mk = (v: number[]) => new AxisPid(v[0] * KP_SCALE, v[1] * KI_SCALE, v[2] * KD_SCALE, v[3] * KFF_SCALE, dLpf);
    this.pids = [mk(g.roll), mk(g.pitch), mk(g.yaw)];
    this.gyroLpfHz = p.fc.filters?.gyro_lpf_hz ?? DEFAULT_GYRO_LPF_HZ;
    this.tpa = p.fc.tpa ?? DEFAULT_TPA;
    this.tpaMode = p.fc.tpa_mode ?? 'D';
    this.antiGravity = p.fc.anti_gravity ?? DEFAULT_AG;
  }

  /** Arming like BF: only with throttle low. Returns true if state changed. */
  setArmed(want: boolean, throttle: number): boolean {
    if (want === this.armed) return false;
    if (want && throttle > 0.05) { this.armBlockReason = 'Газ не в нуле'; return false; }
    this.armBlockReason = '';
    this.armed = want;
    this.pids.forEach((p) => p.reset());
    this.prevThr = throttle; this.thrRate = 0;
    return true;
  }

  /**
   * @param gyro measured body rates in FC axes (rad/s), with sensor noise; filtered here like BF's gyro LPF
   * @param upBody world-up expressed in body axes (for self-levelling)
   */
  step(dt: number, sticks: Sticks, gyroRaw: readonly number[], upBody: { x: number; y: number; z: number }): FcOutput {
    const gk = pt1k(this.gyroLpfHz, dt), gyro = this.gyroF;
    for (let a = 0; a < 3; a++) gyro[a] += gk * (gyroRaw[a] - gyro[a]);
    const acro: [number, number, number] = [
      applyRate(this.rates, 'roll', sticks.roll) * DEG,
      applyRate(this.rates, 'pitch', sticks.pitch) * DEG,
      applyRate(this.rates, 'yaw', sticks.yaw) * DEG,
    ];
    const sp = this.setpoint;
    if (this.mode === 'acro') {
      sp[0] = acro[0]; sp[1] = acro[1];
    } else {
      // current attitude from the gravity direction (roll right / nose down positive)
      const roll = Math.atan2(-upBody.x, upBody.y);
      const pitch = Math.atan2(upBody.z, upBody.y);
      const lvl0 = clamp(ANGLE_GAIN * (sticks.roll * this.maxAngle - roll), -ANGLE_RATE_LIMIT, ANGLE_RATE_LIMIT);
      const lvl1 = clamp(ANGLE_GAIN * (sticks.pitch * this.maxAngle - pitch), -ANGLE_RATE_LIMIT, ANGLE_RATE_LIMIT);
      if (this.mode === 'angle') {
        sp[0] = lvl0; sp[1] = lvl1;
      } else {
        const h = clamp((Math.max(Math.abs(sticks.roll), Math.abs(sticks.pitch)) - 0.3) / 0.6, 0, 1);
        sp[0] = lvl0 * (1 - h) + acro[0] * h;
        sp[1] = lvl1 * (1 - h) + acro[1] * h;
      }
    }
    sp[2] = acro[2];
    const out = this.out;
    out.accel[0] = out.accel[1] = out.accel[2] = 0; out.throttle = 0;
    if (!this.armed || this.turtle) return out;
    // TPA: D (and P in 'PD' mode) fall off linearly above the breakpoint: motor noise and authority grow with throttle
    const [tpaRate, tpaBp] = this.tpa;
    this.tpaFactor = 1 - tpaRate * clamp((sticks.throttle - tpaBp) / (1 - tpaBp), 0, 1);
    // anti-gravity: fast throttle moves change the motor load -> boost the I-term to hold attitude
    const thrDot = Math.abs(sticks.throttle - this.prevThr) / dt;
    this.prevThr = sticks.throttle;
    this.thrRate += pt1k(AG_LPF_HZ, dt) * (thrDot - this.thrRate);
    this.agBoost = 1 + this.antiGravity * Math.min(1, this.thrRate / AG_FULL_RATE);
    const lowThrottle = sticks.throttle < 0.03 && !this.airmode;
    for (let a = 0; a < 3; a++) {
      out.accel[a] = this.pids[a].step(sp[a], gyro[a], dt, a < 2, this.tpaMode === 'PD' ? this.tpaFactor : 1, this.tpaFactor, this.agBoost);
      if (lowThrottle) { this.pids[a].i = 0; out.accel[a] = 0; }
    }
    out.throttle = sticks.throttle;
    return out;
  }
}
