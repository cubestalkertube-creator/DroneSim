// Wing aerodynamics of the fixed wing and of the quadplane's FW half (PHYSICS.md 5.5).
//   alpha = atan2(-v_y, -v_z), beta = asin(v_x/|v|)  (air-relative velocity in body axes, nose = -Z)
//   L = q S C_L(alpha), D = q S (C_D0 + max(k C_L^2, C_D90 sin^2 alpha)), Y = q S C_Ybeta beta
//   C_L: linear (C_L0 + C_La alpha) up to the stall (capped at C_Lmax), then it falls — with the post-stall
//   slope C_La_stall (PX4 LiftDrag) or linearly by (1 - CL_post_ratio) over stall_width — down to the
//   flat-plate floor CL_post_ratio * C_Ls * sin(2 alpha) (delta wing: soft vortex-lift stall, 0.6 C_Lmax).
//   moments about the CG (aero axes: p roll right, q nose up, r nose right):
//     C_m = C_m0 + C_ma sin(alpha) + C_mde de + C_mq q c/2V
//     C_l = C_lb sin(beta) + C_lda da + C_lp p b/2V,   C_n = C_nb sin(beta) + C_nr r b/2V
//   elevons: de = (dL + dR)/2, da = (dL - dR)/2 (dL = de + da, dR = de - da), trailing edge down positive,
//   limited to +-elevon_max and slewed at elevon_rate like a servo.
import { clamp, type V3 } from './math';
import type { WingModel } from './presets';

/** Lift coefficient over the full circle of angle of attack (rad). */
export function liftCoef(w: WingModel, alpha: number): number {
  const a = w.aero, x = Math.abs(alpha), s = alpha < 0 ? -1 : 1;
  const cls = s > 0 ? w.clStallPos : w.clStallNeg;
  const floor = a.CL_post_ratio * cls * Math.sin(2 * x); // flat plate: 0 at 90 deg, negative when flying backwards
  if (x > Math.PI / 2) return s * floor;
  if (x <= w.alphaStall) return clamp(a.CL0 + a.CLa * alpha, -w.clStallNeg, w.clStallPos);
  const slope = a.CLa_stall ?? (-(1 - a.CL_post_ratio) * cls) / w.stallWidth;
  return s * Math.max(cls + slope * (x - w.alphaStall), floor);
}

/** Drag coefficient: induced drag while attached, the flat plate broadside once the flow has separated. */
export function dragCoef(w: WingModel, alpha: number, cl: number): number {
  const a = w.aero, sa = Math.sin(alpha);
  return a.CD0 + Math.max(a.k * cl * cl, a.CD90 * sa * sa);
}

export class WingAero {
  /** elevon commands from the FC and the actual (servo) deflections, rad, trailing edge down + */
  cmdL = 0; cmdR = 0; defL = 0; defR = 0;
  /** last step: angle of attack / sideslip (rad), airspeed (m/s), lift coefficient, flow separated */
  alpha = 0; beta = 0; airspeed = 0; cl = 0; stalled = false;

  constructor(readonly w: WingModel) {}

  reset() { this.cmdL = this.cmdR = this.defL = this.defR = 0; this.alpha = this.beta = this.airspeed = this.cl = 0; this.stalled = false; }

  /** Servo model: move towards the commands at the elevon rate, within the travel. */
  actuate(dt: number) {
    const w = this.w, r = w.elevRate * dt;
    this.defL += clamp(clamp(this.cmdL, -w.elevMax, w.elevMax) - this.defL, -r, r);
    this.defR += clamp(clamp(this.cmdR, -w.elevMax, w.elevMax) - this.defR, -r, r);
  }

  /**
   * Adds the wing's force and moment (body axes) to F and T.
   * @param vb air-relative velocity of the airframe in body axes (m/s)
   * @param wb body angular velocity (rad/s)
   */
  apply(F: V3, T: V3, vb: V3, wb: V3, rho: number) {
    const w = this.w, a = w.aero;
    const V = Math.hypot(vb.x, vb.y, vb.z);
    this.airspeed = V;
    if (V < 0.05) { this.alpha = this.beta = this.cl = 0; this.stalled = false; return; }
    const alpha = Math.atan2(-vb.y, -vb.z), beta = Math.asin(clamp(vb.x / V, -1, 1));
    const cl = liftCoef(w, alpha), cd = dragCoef(w, alpha, cl), cy = a.CYb * beta;
    this.alpha = alpha; this.beta = beta; this.cl = cl;
    this.stalled = Math.abs(alpha) > w.alphaStall && Math.abs(alpha) < Math.PI / 2;
    const q = 0.5 * rho * V * V, qS = q * w.S;
    // drag along -v, lift perpendicular to v in the symmetry plane, side force along body X
    F.x -= (qS * cd * vb.x) / V; F.y -= (qS * cd * vb.y) / V; F.z -= (qS * cd * vb.z) / V;
    const n = Math.hypot(vb.y, vb.z);
    if (n > 1e-6) { F.y += (qS * cl * -vb.z) / n; F.z += (qS * cl * vb.y) / n; }
    F.x += qS * cy;
    // moments; damping terms q S c Cmq (q c / 2V) = rho V S c^2 Cmq q / 4 stay finite at low speed
    const de = 0.5 * (this.defL + this.defR), da = 0.5 * (this.defL - this.defR);
    const p = -wb.z, qr = wb.x, r = -wb.y;
    const damp = 0.25 * rho * V * w.S;
    const M = qS * w.c * ((a.Cm0 ?? 0) + a.Cma * Math.sin(alpha) + a.Cmde * de) + damp * w.c * w.c * a.Cmq * qr;
    const L = qS * w.b * (a.Clb * Math.sin(beta) + a.Clda * da) + damp * w.b * w.b * a.Clp * p;
    const N = qS * w.b * a.Cnb * Math.sin(beta) + damp * w.b * w.b * a.Cnr * r;
    T.x += M; T.z -= L; T.y -= N;
  }
}
