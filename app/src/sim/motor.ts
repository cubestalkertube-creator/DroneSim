// ESC + BLDC motors (PHYSICS.md 2.1), solved together with the battery (2.2) every physics step.
//   I_m = (d*V_bus - Ke*Ω)/Z(Ω),  τ_m = Kt*(I_m - I_0),  J_r*Ω' = τ_m - Q_prop(Ω)
//   Z(Ω) = sqrt(R_m^2 + (p*L*Ω)^2): the winding reactance at the electrical frequency (p pole pairs) is what
//   holds a 2306 at ~30-40 A on full throttle (bench data) while R_m alone would let it draw >100 A.
//   |I_m| <= I_max: ESC current limit / iron saturation (the ESC lowers the effective duty).
// The spin-up time is not a parameter: it follows from J_r, Z, Kt and the prop load. "Active braking"
// (DShot ESCs with damped light / complementary PWM) lets the phase current reverse, so the motor brakes
// regeneratively; without it the current can only drive and the rotor coasts down on prop drag alone.
// Presets with rotors.simple_motor_model keep the cheap first-order Ω' = (Ω_cmd - Ω)/τ (Gazebo constants).
import type { Battery } from './battery';
import type { DroneModel } from './presets';

/** friction torque Kt*I_0 fades in over this speed (rad/s) to avoid chatter around Ω = 0 */
const FRICTION_SMOOTH = 20;
/** overall motor efficiency used to estimate the pack current of the simple (first-order) motor model */
export const SIMPLE_MOTOR_EFF = 0.75;

const OFF = 0, DRIVE = 1, LIMIT = 2;

export class MotorBank {
  readonly n: number;
  readonly omega: Float64Array;     // rad/s, signed (negative = reversed, turtle mode)
  readonly omegaDot: Float64Array;
  readonly phaseA: Float64Array;    // motor (phase) current, A
  readonly duty: Float64Array;      // duty commanded to the ESC, -1..1 (after the low-voltage limiter)
  /** motor failure (training scenario): the ESC stops driving it, the rotor coasts down */
  readonly failed: Uint8Array;
  private cond: Uint8Array;         // OFF: phases open / freewheeling, DRIVE: duty-driven, LIMIT: at ±I_max
  private z: Float64Array;

  constructor(private m: DroneModel, private bat: Battery) {
    this.n = m.rotors.length;
    this.omega = new Float64Array(this.n); this.omegaDot = new Float64Array(this.n);
    this.phaseA = new Float64Array(this.n); this.duty = new Float64Array(this.n); this.failed = new Uint8Array(this.n);
    this.cond = new Uint8Array(this.n); this.z = new Float64Array(this.n);
  }

  reset() { this.omega.fill(0); this.omegaDot.fill(0); this.phaseA.fill(0); this.duty.fill(0); this.failed.fill(0); }

  /**
   * @param cmd ESC command per motor, -1..1 (negative = reversed for turtle mode)
   * @param armed ESCs are driving (disarmed: phases open, rotors coast)
   * @param kq aerodynamic torque coefficient per rotor, Q = kq*Ω|Ω| (N*m/(rad/s)^2)
   * @param extraA other loads on the pack this step (A): the electric pusher of a quadplane
   */
  step(dt: number, cmd: ArrayLike<number>, armed: boolean, kq: ArrayLike<number>, extraA = 0) {
    const m = this.m, bat = this.bat, n = this.n, w = this.omega, d = this.duty;
    const lim = bat.limit;
    for (let i = 0; i < n; i++) d[i] = armed && !this.failed[i] ? cmd[i] * lim : 0;
    if (m.simpleMotor) { this.stepSimple(dt, armed, kq, extraA); return; }

    const ke = m.ke, eta = m.escEff, iMax = m.iMax, z = this.z, cond = this.cond;
    for (let i = 0; i < n; i++) {
      z[i] = Math.hypot(m.rm, m.xL * w[i]);
      // an active-braking ESC always conducts while armed; a plain one only while it drives
      cond[i] = armed && !this.failed[i] && (m.braking || d[i] !== 0) ? DRIVE : OFF;
    }
    let V = bat.vbus > 0 ? bat.vbus : bat.ocv();
    for (let pass = 0; pass < 4; pass++) {
      // bus current I = Σ_drive d*(d*V - Ke*Ω)/(Z*η) + Σ_limit d_eff*I_max/η + I_av = a*V + b
      let a = 0, b = bat.avionicsA + extraA;
      for (let i = 0; i < n; i++) {
        if (cond[i] === DRIVE) {
          a += (d[i] * d[i]) / (z[i] * eta);
          b -= (d[i] * ke * w[i]) / (z[i] * eta);
        } else if (cond[i] === LIMIT) {
          // effective duty d_eff = (I*Z + Ke*Ω)/V, with V from the previous pass
          const I = Math.sign(d[i]) * iMax;
          b += ((I * z[i] + ke * w[i]) * I) / (Math.max(V, 1) * eta);
        }
      }
      V = bat.solve(a, b);
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (cond[i] !== DRIVE) continue;
        const I = (d[i] * V - ke * w[i]) / z[i];
        if (!m.braking && I * d[i] < 0) { cond[i] = OFF; changed = true; } // freewheeling diode: no reverse current
        else if (I * d[i] > 0 && Math.abs(I) > iMax) { cond[i] = LIMIT; changed = true; }
      }
      if (!changed) break;
    }

    let busI = bat.avionicsA + extraA;
    const jr = m.Jr, kt = ke; // SI: Kt = Ke
    for (let i = 0; i < n; i++) {
      const w0 = w[i];
      const fric = kt * m.i0 * Math.max(-1, Math.min(1, w0 / FRICTION_SMOOTH));
      const Q = kq[i] * w0 * Math.abs(w0);
      let w1: number;
      if (cond[i] === DRIVE) {
        const I = (d[i] * V - ke * w0) / z[i];
        if (Math.abs(I) <= iMax) {
          this.phaseA[i] = I;
          busI += (d[i] * I) / eta;
          // semi-implicit in the back-EMF term (stiff for small rotors)
          const stiff = (kt * ke) / (z[i] * jr);
          w1 = (w0 + (dt / jr) * ((kt * d[i] * V) / z[i] - fric - Q)) / (1 + dt * stiff);
        } else { // braking current beyond the limit
          const Il = Math.sign(I) * iMax;
          this.phaseA[i] = Il;
          busI += (d[i] * Il) / eta;
          w1 = w0 + (dt / jr) * (kt * Il - fric - Q);
        }
      } else if (cond[i] === LIMIT) {
        const I = Math.sign(d[i]) * iMax;
        this.phaseA[i] = I;
        busI += ((I * z[i] + ke * w0) * I) / (Math.max(V, 1) * eta);
        w1 = w0 + (dt / jr) * (kt * I - fric - Q);
      } else {
        this.phaseA[i] = 0;
        w1 = w0 + (dt / jr) * (-fric - Q);
        if (w1 * w0 < 0) w1 = 0; // drag/friction stop the rotor, never reverse it
      }
      this.omegaDot[i] = (w1 - w0) / dt;
      w[i] = w1;
    }
    bat.integrate(V, busI, dt);
  }

  private stepSimple(dt: number, armed: boolean, kq: ArrayLike<number>, extraA: number) {
    const m = this.m, bat = this.bat, w = this.omega, d = this.duty;
    const V = bat.vbus;
    const wMax = m.omegaMax * (bat.present ? V / m.vNominal : 1);
    let P = 0;
    for (let i = 0; i < this.n; i++) {
      const target = d[i] * wMax;
      const w0 = w[i];
      const tau = Math.abs(target) > Math.abs(w0) ? m.tauUp : (armed ? m.tauDown : m.tauDown * 3);
      const w1 = target + (w0 - target) * Math.exp(-dt / tau);
      this.omegaDot[i] = (w1 - w0) / dt;
      w[i] = w1;
      P += Math.abs(kq[i] * w1 * w1 * w1) + Math.abs(m.Jr * this.omegaDot[i] * w1);
      this.phaseA[i] = 0;
    }
    const I = bat.avionicsA + extraA + (V > 1 ? P / (SIMPLE_MOTOR_EFF * V) : 0);
    bat.integrate(bat.solve(0, I), I, dt);
  }

  /** Steady static speed at bus voltage V and duty (mixer normalisation, tests). */
  static steadyOmega(m: Pick<DroneModel, 'ke' | 'rm' | 'xL' | 'i0' | 'iMax' | 'kQ0'>, V: number, duty = 1): number {
    // Kt*(min(I_max, (dV - Ke*Ω)/Z(Ω)) - I0) = kQ*Ω^2: the left side falls, the right side rises -> bisection
    const f = (w: number) => m.ke * (Math.min(m.iMax, (duty * V - m.ke * w) / Math.hypot(m.rm, m.xL * w)) - m.i0) - m.kQ0 * w * w;
    let lo = 0, hi = (duty * V) / m.ke;
    if (f(lo) <= 0) return 0;
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
    return lo;
  }
}
