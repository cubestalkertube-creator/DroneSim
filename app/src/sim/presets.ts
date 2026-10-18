// Types for assets/presets/drones.json and the derived per-rotor model used by the simulation.
// Body axes: +X right, +Y up (thrust), -Z nose. Betaflight quad-X order: 0 RR, 1 FR, 2 RL, 3 FL.
import { DEG, type V3 } from './math';
import type { RateProfile } from './rates';
import { MotorBank } from './motor';

export interface DronePreset {
  id: string; name: string; class: string; model: string; difficulty: number;
  mass: number;
  inertia: { pitch: number; yaw: number; roll: number };
  frame: {
    layout: string; wheelbase?: number; cdA: [number, number, number]; ducted?: boolean; duct_thrust_gain?: number;
    /** fixed wing / VTOL: span, fuselage length, height (collider), wing area (m^2), mean aerodynamic chord (m) */
    span?: number; length?: number; height?: number; wing_area?: number; mac?: number;
  };
  rotors: {
    /** blades per propeller (acoustics: blade-pass frequency) */
    blades?: number;
    count: number; arm?: number; diameter?: number; kT0?: number; kQ0?: number; J0?: number; kH?: number; Jr?: number;
    max_rad_s?: number; tau_up?: number; tau_down?: number; simple_motor_model?: boolean;
    /** thrust of a reversed (turtle mode) prop relative to forward, 0..1 */
    reverse_eff?: number;
    /** quadplane: the vertical lift rotors (same keys as above, override them) */
    lift?: Partial<Omit<DronePreset['rotors'], 'lift' | 'pusher'>> & { count: number };
    /** pusher / tractor propeller along the body -Z axis (fixed wing, VTOL) */
    pusher?: PusherSpec;
  };
  /** piston engine driving the pusher (no battery); otherwise the pusher is an electric motor on the pack */
  engine?: EngineSpec;
  /** wing aerodynamics (PHYSICS.md 5.5) */
  aero?: AeroSpec;
  launch?: { type: string; booster_thrust_n: number; booster_time_s: number; rail_length_m: number; rail_elev_deg: number; rail_height_m: number };
  /** recovery parachute: drag area when open (m^2), opening time (s), riser attachment point in body axes (m) */
  recovery?: { parachute_cdA: number; deploy_s: number; attach: [number, number, number] };
  motor?: {
    kv: number; Rm: number; I0: number; idle: number; active_braking: boolean; esc_eff?: number;
    /** magnet poles (14 for most 22xx-31xx outrunners), phase inductance (uH), ESC phase current limit (A) */
    poles?: number; L_uH?: number; i_max?: number;
  } | null;
  battery: {
    chem: string; cells: number; capacity_mah: number; r_cell: number; mass: number;
    rp_cp_s?: number; rp_ratio?: number; avionics_a?: number;
  } | null;
  fc: {
    type: string; modes: string[]; default_mode: string; airmode?: boolean;
    rates?: RateProfile;
    pid?: { roll: [number, number, number, number]; pitch: [number, number, number, number]; yaw: [number, number, number, number] };
    /** [tpa_rate 0..1, tpa_breakpoint throttle 0..1] */
    tpa?: [number, number];
    tpa_mode?: 'D' | 'PD';
    anti_gravity?: number;
    filters?: { gyro_lpf_hz?: number; dterm_lpf_hz?: number };
    max_angle?: number;
    /** fixed wing (and VTOL in FW): airspeeds (m/s), attitude limits, default route [dx east, dz south, alt] from home */
    cruise_airspeed?: number; stall_airspeed?: number; max_airspeed?: number; transition_airspeed?: number;
    /** VTOL: lift motors ramp-down time after reaching the transition airspeed, back-transition time limit (s) */
    transition_ramp_s?: number; back_transition_s?: number;
    fw_limits?: { bank_deg: number; pitch_up_deg: number; pitch_down_deg: number; climb_ms: number; sink_ms: number };
    route?: [number, number, number][];
    /** FW return-to-launch: altitude above home (m) and loiter radius (m) */
    rtl_alt_m?: number; loiter_radius_m?: number;
  };
  /** gyro sensor model: white noise sigma and residual motor vibration at full speed (deg/s, after the RPM filter) */
  sensors?: { gyro_noise_dps?: number; vibration_dps?: number };
  camera: { type: string; uptilt_deg?: number; fov_deg: number; latency_ms: number };
  reference?: { top_speed_kmh?: number; hover_throttle?: number; twr?: number };
  damage?: { J_prop: number; J_arm: number };
  /** kamikaze charge (included in `mass`): goes off on command or on a contact faster than fuse_speed_ms with an
   *  impulse over fuse_impulse_ns while armed; blast_radius_m only sizes the visual fireball. No targets / damage. */
  warhead?: WarheadSpec;
}

export interface WarheadSpec { mass: number; fuse_speed_ms: number; fuse_impulse_ns: number; blast_radius_m: number }

export interface PusherSpec {
  diameter: number; kT0: number; kQ0: number; J0: number; max_rad_s: number;
  /** position of the prop in body axes (m) and spin seen from behind the aircraft looking forward */
  pos: [number, number, number]; spin: 'cw' | 'ccw';
  /** rotating inertia (prop + crank / rotor), kg*m^2 */
  J_rot: number;
  /** electric pusher: first-order speed response (s) */
  tau_up?: number; tau_down?: number;
}
export interface EngineSpec {
  type: string; power_kw: number; throttle_tau_s: number;
  /** idle throttle fraction, fuel (l), consumption at full power (l/h) */
  idle: number; fuel_l: number; burn_l_per_h: number;
}
export interface AeroSpec {
  CL0: number; CLa: number; alpha_stall_deg: number; CL_max?: number; CLa_stall?: number;
  /** post-stall lift floor (fraction of the stall CL, flat-plate shape), lift drop width (deg), drag of the wing broadside */
  CL_post_ratio: number; stall_width_deg: number; CD90: number;
  CD0: number; k: number; CYb: number;
  Cm0?: number; Cma: number; Cmq: number; Cmde: number;
  Clb: number; Clp: number; Clda: number; Cnb: number; Cnr: number;
  elevon_max_deg: number; elevon_rate_dps: number;
}

export interface RotorModel {
  pos: V3;          // body-frame position (m)
  spin: 1 | -1;     // +1 = CW seen from above (angular velocity along -Y), -1 = CCW
}

export interface DroneModel {
  preset: DronePreset;
  mass: number;
  inertia: V3;      // principal inertia about body X (pitch), Y (yaw), Z (roll)
  rotors: RotorModel[];
  diameter: number;
  kT0: number; kQ0: number; J0: number; kH: number; Jr: number;
  /** rad/s at full command and nominal loaded voltage (mixer normalisation; simple motor model) */
  omegaMax: number;
  /** steady rotor speed (rad/s) vs ESC command at nominal voltage, sampled at c = k/(n-1): the mixer's plant model */
  omegaCurve: Float64Array;
  vNominal: number; // V
  // electromechanical motor (PHYSICS.md 2.1); simpleMotor -> first-order tauUp/tauDown instead
  simpleMotor: boolean;
  ke: number; rm: number; i0: number; braking: boolean; escEff: number;
  xL: number;       // winding reactance per rad/s of rotor speed: pole pairs * L (ohm*s/rad)
  iMax: number;     // phase current limit (A)
  tauUp: number; tauDown: number;
  reverseEff: number;
  idle: number;
  cdA: V3;          // body drag areas (m^2) along X (side), Y (top), Z (front)
  halfExtents: V3;  // collider half sizes
  ductGain: number;
  /** wing aerodynamics (fixed wing, VTOL), null for multirotors */
  wing: WingModel | null;
  /** pusher propeller (fixed wing, VTOL), null for multirotors */
  pusher: PusherModel | null;
}

export interface WingModel {
  aero: AeroSpec;
  S: number; b: number; c: number;
  /** stall angle, lift at the stall for positive / negative alpha, width of the lift drop (rad) */
  alphaStall: number; clStallPos: number; clStallNeg: number; stallWidth: number;
  elevMax: number; elevRate: number; // rad, rad/s
}

export interface PusherModel extends PusherSpec {
  posV: V3;
  /** +1: the prop turns clockwise seen from behind (angular velocity along the flight direction, -Z) */
  spinS: 1 | -1;
  engine: EngineSpec | null;
}

const NOMINAL_LOADED_CELL_V = 3.8; // mid-pack cell voltage under load: the mixer's idea of "full throttle"
const PROP_LOAD_FACTOR = 0.85;     // loaded RPM / no-load RPM at full throttle (simple motor model)
const DEFAULT_ESC_EFF = 0.95;
export const OMEGA_CURVE_N = 41;

/** Rotor positions for the supported layouts, matching the GLB rotor_<i> node order. */
export function rotorLayout(p: DronePreset): RotorModel[] {
  const r = liftRotors(p);
  if (!r) return [];
  const n = r.count;
  const arm = r.arm ?? (p.frame.wheelbase ?? 0.25) / 2;
  if (n === 4) {
    const a = arm / Math.SQRT2;
    // BF props-in: RR CW, FR CCW, RL CCW, FL CW
    return [
      { pos: { x: a, y: 0, z: a }, spin: 1 },
      { pos: { x: a, y: 0, z: -a }, spin: -1 },
      { pos: { x: -a, y: 0, z: a }, spin: -1 },
      { pos: { x: -a, y: 0, z: -a }, spin: 1 },
    ];
  }
  // hex / others: evenly spaced, alternating directions, first rotor front-right
  return Array.from({ length: n }, (_, i) => {
    const ang = Math.PI / n + (i * 2 * Math.PI) / n;
    return { pos: { x: Math.sin(ang) * arm, y: 0, z: -Math.cos(ang) * arm }, spin: (i % 2 === 0 ? -1 : 1) as 1 | -1 };
  });
}

/** The rotors that carry the airframe in hover: all of them on a multirotor, `rotors.lift` on a quadplane,
 *  none on a fixed wing (its only propeller is the pusher). */
export function liftRotors(p: DronePreset): DronePreset['rotors'] | null {
  const r = p.rotors;
  if (r.lift) return { ...r, ...r.lift };
  return r.pusher ? null : r;
}

function wingModel(p: DronePreset): WingModel | null {
  const a = p.aero;
  if (!a) return null;
  const S = p.frame.wing_area!, b = p.frame.span!, c = p.frame.mac!;
  const as = a.alpha_stall_deg * DEG;
  const lin = a.CLa * as;
  return {
    aero: a, S, b, c, alphaStall: as,
    clStallPos: Math.min(a.CL_max ?? Infinity, a.CL0 + lin), clStallNeg: Math.min(a.CL_max ?? Infinity, lin - a.CL0),
    stallWidth: a.stall_width_deg * DEG, elevMax: a.elevon_max_deg * DEG, elevRate: a.elevon_rate_dps * DEG,
  };
}

function pusherModel(p: DronePreset): PusherModel | null {
  const s = p.rotors.pusher;
  if (!s) return null;
  return { ...s, posV: { x: s.pos[0], y: s.pos[1], z: s.pos[2] }, spinS: s.spin === 'cw' ? 1 : -1, engine: p.engine ?? null };
}

export function buildModel(p: DronePreset): DroneModel {
  const r = liftRotors(p) ?? p.rotors;
  const mot = p.motor ?? undefined;
  const kv = mot?.kv ?? 1000;
  const vNominal = (p.battery?.cells ?? 1) * NOMINAL_LOADED_CELL_V;
  const simpleMotor = !!r.simple_motor_model || !mot || !p.battery;
  const ke = 60 / (2 * Math.PI * kv); // V*s/rad = N*m/A
  const rm = mot?.Rm ?? 0.1, i0 = mot?.I0 ?? 0.5;
  const xL = ((mot?.poles ?? 14) / 2) * (mot?.L_uH ?? 0) * 1e-6, iMax = mot?.i_max ?? Infinity;
  const kQ0 = r.kQ0 ?? 2e-8;
  const omegaMax = r.max_rad_s ?? (simpleMotor
    ? (kv * vNominal * Math.PI) / 30 * PROP_LOAD_FACTOR
    : MotorBank.steadyOmega({ ke, rm, xL, i0, iMax, kQ0 }, vNominal));
  const Jr = r.Jr ?? 2e-5;
  // simple model: spin-up time constant estimated from rotor inertia (PHYSICS.md 2.1: 5" ~25 ms, 10" ~100 ms)
  const tauUp = r.tau_up ?? 0.012 + Jr * 800;
  const braking = mot?.active_braking ?? false;
  const tauDown = r.tau_down ?? (braking ? 0.6 : 1.5) * tauUp;
  const wb = p.frame.wheelbase ?? 0.25;
  const ductGain = p.frame.ducted ? p.frame.duct_thrust_gain ?? 1.1 : 1;
  const kT0 = r.kT0 ?? 1.5e-6;
  // the ESC sets duty, not speed: Ω(duty) is steep at light load and flattens near full throttle (droop)
  const omegaCurve = new Float64Array(OMEGA_CURVE_N);
  for (let k = 0; k < OMEGA_CURVE_N; k++) {
    const c = k / (OMEGA_CURVE_N - 1);
    omegaCurve[k] = simpleMotor ? c * omegaMax : MotorBank.steadyOmega({ ke, rm, xL, i0, iMax, kQ0 }, vNominal, c);
  }
  return {
    preset: p,
    mass: p.mass,
    inertia: { x: p.inertia.pitch, y: p.inertia.yaw, z: p.inertia.roll },
    rotors: rotorLayout(p),
    diameter: r.diameter ?? 0.13,
    kT0, kQ0, J0: r.J0 ?? 0.8, kH: r.kH ?? 1e-5, Jr,
    omegaMax, omegaCurve, vNominal, simpleMotor, ke, rm, xL, iMax, i0, braking, escEff: mot?.esc_eff ?? DEFAULT_ESC_EFF,
    tauUp, tauDown, reverseEff: r.reverse_eff ?? 0.3,
    idle: mot?.idle ?? 0.05,
    cdA: { x: p.frame.cdA[0], y: p.frame.cdA[1], z: p.frame.cdA[2] },
    halfExtents: p.frame.span
      ? { x: p.frame.span / 2, y: (p.frame.height ?? 0.2) / 2, z: (p.frame.length ?? p.frame.span / 2) / 2 }
      : { x: wb * 0.5, y: 0.03 + wb * 0.08, z: wb * 0.5 },
    ductGain,
    wing: wingModel(p),
    pusher: pusherModel(p),
  };
}
