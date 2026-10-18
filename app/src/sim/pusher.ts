// Pusher propeller along the body -Z axis (PHYSICS.md 5.5): the same propeller model as the rotors (3.1:
// advance ratio J = V_axial/(nD), k_T(J) = k_T0 (1 - J/J_0), k_Q(J) = k_Q0 (1 - 0.6 J/J_0)), driven by
//   * a piston engine (fixed wing): torque ~ throttle * P_max/Omega_max (power rises with rpm, peak at the
//     rated speed), rev limiter above it, throttle lag tau, idle when running, fuel burn ~ power;
//     J_rot Omega' = tau_engine - Q_prop
//   * or an electric motor on the pack (quadplane): first-order speed response like the Gazebo motor model,
//     Omega_max scales with the bus voltage, current from the mechanical power.
import { SIMPLE_MOTOR_EFF } from './motor';
import type { V3 } from './math';
import type { PusherModel } from './presets';

/** rev limiter: engine torque fades to zero over this fraction above the rated speed */
const REV_LIMIT_BAND = 0.03;
const FUEL_ENGINE_STOP_L = 0;

export class Pusher {
  omega = 0; omegaDot = 0;
  thrust = 0; torque = 0;
  /** engine: effective (lagged) throttle 0..1 and remaining fuel (l) */
  throttle = 0; fuel: number;
  /** electrical pusher: pack current of the last step (A) */
  current = 0;

  constructor(readonly m: PusherModel) { this.fuel = m.engine?.fuel_l ?? 0; }

  reset() { this.omega = this.omegaDot = this.thrust = this.torque = this.throttle = this.current = 0; this.fuel = this.m.engine?.fuel_l ?? 0; }

  get running() { return !!this.m.engine && this.fuel > FUEL_ENGINE_STOP_L && this.throttle > 0; }

  /**
   * @param cmd throttle 0..1 (engine: above idle)
   * @param on engine running / ESC armed
   * @param vAxial airspeed along the thrust axis, forward positive (m/s)
   * @param vbus pack voltage for the electric pusher, nominal voltage
   */
  step(dt: number, cmd: number, on: boolean, vAxial: number, vbus = 0, vNominal = 1) {
    const m = this.m, e = m.engine, w0 = this.omega;
    const n = Math.abs(w0) / (2 * Math.PI);
    const J = n > 1 ? vAxial / (n * m.diameter) : 0;
    const kt = m.kT0 * Math.max(0, Math.min(1.25, 1 - J / m.J0));
    const kq = m.kQ0 * Math.max(0.2, Math.min(1.3, 1 - (0.6 * J) / m.J0));
    const Q = kq * w0 * Math.abs(w0);
    let w1: number;
    if (e) {
      const want = on && this.fuel > FUEL_ENGINE_STOP_L ? e.idle + Math.min(1, Math.max(0, cmd)) * (1 - e.idle) : 0;
      this.throttle += (want - this.throttle) * (1 - Math.exp(-dt / e.throttle_tau_s));
      if (!on || this.fuel <= FUEL_ENGINE_STOP_L) this.throttle = 0;
      const tMax = (e.power_kw * 1000) / m.max_rad_s;
      const limiter = Math.max(0, Math.min(1, 1 - (w0 - m.max_rad_s) / (REV_LIMIT_BAND * m.max_rad_s)));
      const te = this.throttle * tMax * limiter;
      w1 = Math.max(0, w0 + (dt * (te - Q)) / m.J_rot);
      this.fuel = Math.max(0, this.fuel - (e.burn_l_per_h * (te * w0) / (e.power_kw * 1000) * dt) / 3600);
      this.current = 0;
    } else {
      const target = on ? Math.min(1, Math.max(0, cmd)) * m.max_rad_s * (vbus > 0 ? vbus / vNominal : 1) : 0;
      const tau = target > w0 ? m.tau_up ?? 0.05 : m.tau_down ?? 0.08;
      w1 = target + (w0 - target) * Math.exp(-dt / tau);
      this.throttle = on ? cmd : 0;
      this.current = vbus > 1 ? (Math.abs(Q * w1) + Math.abs(m.J_rot * ((w1 - w0) / dt) * w1)) / (SIMPLE_MOTOR_EFF * vbus) : 0;
    }
    this.omegaDot = (w1 - w0) / dt;
    this.omega = w1;
    this.thrust = kt * w1 * w1;
    this.torque = kq * w1 * w1;
  }

  /** Thrust along -Z at the prop, reaction and gyroscopic torques (body axes). */
  apply(F: V3, T: V3, wb: V3) {
    const m = this.m, p = m.posV, th = this.thrust;
    F.z -= th;
    // r x (0, 0, -T)
    T.x += -p.y * th; T.y += p.x * th;
    // reaction of the prop drag + acceleration torque about the thrust axis (spin +1: angular velocity along -Z)
    T.z += m.spinS * (this.torque + m.J_rot * this.omegaDot);
    // gyroscopic: -wb x h, h = (0, 0, -spin J Omega)
    const hz = -m.spinS * m.J_rot * this.omega;
    T.x -= wb.y * hz; T.y += wb.x * hz;
  }
}
