// GPS / position flight controller (PHYSICS.md 5.2, 5.4): DJI-like consumer modes (Cine/Normal/Sport/ATTI/RTH),
// PX4 (Position/Altitude/Stabilized/Acro/RTL) and ArduPilot (Loiter/AltHold/Stabilize/RTL/Land) as one cascade:
//   sticks -> velocity command (accel + jerk limited S-curve) -> velocity PI -> tilt (limited) and collective
//   -> virtual sticks of the inner Betaflight-style attitude/rate controller (angle mode) -> mixer.
// Sensors: GPS position with slow drift, baro altitude with noise, compass heading; "landed" detection,
// auto-disarm, home point, return-to-home, obstacle braking (APAS-lite) and an altitude geofence.
import { DEG, clamp, rotate, v3, type Q4, type V3 } from '../math';
import { SmoothNoise, mulberry32 } from '../rng';
import type { DroneModel } from '../presets';
import type { RateProfile } from '../rates';
import type { BetaflightFC, Sticks } from './betaflight';

export type NavBehavior = 'pos' | 'alt' | 'stab' | 'acro' | 'rth' | 'land';

/** what each firmware's mode does (modes not listed here, e.g. mission/auto, are not pilot-selectable yet) */
const BEHAVIOR: Record<string, NavBehavior> = {
  cine: 'pos', normal: 'pos', sport: 'pos', position: 'pos', loiter: 'pos', angle: 'pos', smart: 'pos',
  atti: 'alt', altitude: 'alt', althold: 'alt', stabilized: 'stab', stabilize: 'stab', acro: 'acro',
  rth: 'rth', rtl: 'rth', home: 'rth', land: 'land', mc_position: 'pos',
};
export const NAV_LABEL: Record<string, string> = {
  cine: 'C', normal: 'N', sport: 'S', atti: 'ATTI', rth: 'RTH', position: 'POSCTL', altitude: 'ALTCTL', stabilized: 'STAB',
  acro: 'ACRO', loiter: 'LOITER', althold: 'ALT HOLD', stabilize: 'STABILIZE', rtl: 'RTL', land: 'LAND', angle: 'ANGLE',
  smart: 'SMART', home: 'HOME', mc_position: 'MC POSCTL',
};

export interface NavLimits { v_xy: number; v_up: number; v_down: number; tilt: number }

const G = 9.80665;
// controller tuning (firmware defaults, not airframe physics)
const STICK_DB = 0.08;          // centre dead band of the sticks in GPS modes
const KP_POS = 1.0;             // 1/s  position error -> velocity (hold / RTH)
const KP_VEL = 2.2, KI_VEL = 0.6, I_VEL_MAX = 3; // velocity loop (1/s, 1/s^2, m/s^2)
const KP_ALT = 1.2;             // 1/s  altitude error -> climb rate
const KP_VZ = 3.0, KI_VZ = 2.0, I_VZ_MAX = 4;
const CMD_RESPONSE = 2.0;       // 1/s  velocity command follows the stick target at most this fast
const INNER_MAX_ANGLE = 60 * DEG;
const YAW_MAX_DPS = 200;        // inner yaw rate at full virtual stick
/** yaw rate at full stick, accel and jerk limits of the velocity command per mode flavour */
const FEEL = {
  cine: { yaw: 30, jerk: 2 }, normal: { yaw: 90, jerk: 8 }, sport: { yaw: 150, jerk: 18 },
} as const;
/** braking (command slowing down) may tilt further than the cruise limit, like DJI's hard stop */
const BRAKE_TILT_GAIN = 2, BRAKE_TILT_MAX = 40, BRAKE_JERK_GAIN = 2.5;
const RTH_MIN_ALT = 30;         // m above home
const RTH_DIRECT_DIST = 8;      // closer than this: no climb, land straight away
const LAND_SPEED = 0.8;         // m/s final descent
const OBSTACLE_MARGIN = 1.5;    // m (PHYSICS.md 5.4: d = v^2/(2 a_brake) + 1.5 m)
const OBSTACLE_RANGE = 30;
const DOWN_RANGE = 10;          // m, downward vision sensors
const DESCENT_SLOW_K = 0.8;     // 1/s  near the ground the manual descent rate is limited to K·height (landing protection)
const GPS_DRIFT_M = 0.35, GPS_DRIFT_HZ = 0.08, BARO_NOISE_M = 0.25, BARO_HZ = 0.5;

export interface NavInput {
  pos: V3; vel: V3; rot: Q4;
  /** world-up in body axes (tilt) */
  up: V3;
  groundDist: number;
  ray(origin: V3, dir: V3, max: number): number;
}

export class PositionFC {
  readonly modes: string[];
  mode: string;
  /** current flight phase for the HUD */
  landed = true;
  home = v3(); homeSet = false;
  /** RTH phase */
  rthPhase: 'climb' | 'fly' | 'descend' | 'idle' = 'idle';
  /** obstacle braking active (HUD warning) */
  obstacle = false;
  /** last measured (sensor) altitude above home and horizontal / vertical speed (HUD) */
  altitude = 0; hSpeed = 0; vSpeed = 0; distHome = 0;
  readonly limits: Record<string, NavLimits>;
  readonly obstacleAvoidance: boolean;
  private readonly fence: number;
  private readonly navRates: RateProfile;
  private readonly acroRates: RateProfile;
  // velocity command state (world x/z) and its acceleration (S-curve)
  private vc = v3(); private ac = v3();
  private iv = v3(); private ivz = 0;
  private altTarget = 0; private holding = false;
  private hold = v3(); private holdXY = false;
  private landT = 0; private downT = 0;
  private gx: SmoothNoise; private gz: SmoothNoise; private gb: SmoothNoise;
  private mPos = v3(); private fwd = v3(); private tmp = v3();
  private rayCount = 0; private rayDist = Infinity;
  private downCount = 7; private downDist = Infinity;
  private out: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  private wasArmed = false;

  constructor(private readonly model: DroneModel, private readonly inner: BetaflightFC, seed = 1) {
    const fc = model.preset.fc as DroneModel['preset']['fc'] & {
      limits?: Record<string, NavLimits>; obstacle_avoidance?: boolean; geofence_alt_m?: number;
    };
    this.modes = fc.modes.filter((m) => m in BEHAVIOR);
    this.mode = this.modes.includes(fc.default_mode) ? fc.default_mode : this.modes[0];
    const base: NavLimits = fc.limits?.[fc.default_mode] ?? Object.values(fc.limits ?? {})[0] ?? { v_xy: 10, v_up: 4, v_down: 3, tilt: 30 };
    this.limits = {};
    for (const m of this.modes) this.limits[m] = fc.limits?.[m] ?? base;
    this.obstacleAvoidance = !!fc.obstacle_avoidance;
    this.fence = fc.geofence_alt_m ?? Infinity;
    this.acroRates = inner.rates;
    // nav modes drive the inner loop with a linear yaw rate (virtual stick 1 = YAW_MAX_DPS)
    this.navRates = { ...inner.rates, type: 'actual', yaw: [YAW_MAX_DPS, YAW_MAX_DPS, 0] };
    const u = mulberry32(seed * 7919 + 17);
    this.gx = new SmoothNoise(u, GPS_DRIFT_HZ); this.gz = new SmoothNoise(u, GPS_DRIFT_HZ); this.gb = new SmoothNoise(u, BARO_HZ);
  }

  /** VTOL transitions: altitude hold with the attitude given by the transition logic, whatever the mode */
  override: NavBehavior | null = null;
  /** VTOL back transition: limit on the nose-up (braking) tilt, rad — a fast wing would balloon */
  pitchUpLimit: number | null = null;
  get behavior(): NavBehavior { return this.override ?? BEHAVIOR[this.mode]; }
  get label() { return NAV_LABEL[this.mode] ?? this.mode.toUpperCase(); }
  /** GPS throttle stick is self-centring (climb rate) except in Stabilized/Acro (manual collective) */
  get centredThrottle() { const b = this.behavior; return b !== 'stab' && b !== 'acro'; }

  setMode(m: string) {
    if (!this.modes.includes(m) || m === this.mode) return;
    this.mode = m;
    this.holding = false; this.holdXY = false; this.rthPhase = 'idle';
  }
  nextMode() { this.setMode(this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length]); }

  /** DJI-like arming: motors start with the throttle stick at or below centre. */
  setArmed(want: boolean, throttle: number): boolean {
    if (want && this.centredThrottle && throttle > 0.5 + STICK_DB) { this.inner.armBlockReason = 'Газ выше центра'; return false; }
    if (want && !this.centredThrottle && throttle > 0.05) { this.inner.armBlockReason = 'Газ не в нуле'; return false; }
    return this.inner.setArmed(want, 0);
  }

  reset() {
    this.landed = true; this.homeSet = false; this.rthPhase = 'idle';
    this.vc.x = this.vc.z = this.ac.x = this.ac.z = 0; this.iv.x = this.iv.z = 0; this.ivz = 0;
    this.holding = false; this.holdXY = false; this.wasArmed = false;
  }

  /** Take over in flight (VTOL back transition): brake from the current velocity, then hold. */
  resume(vel: V3) {
    this.landed = false; this.landT = 0; this.rthPhase = 'idle';
    this.vc.x = vel.x; this.vc.z = vel.z; this.ac.x = this.ac.z = 0; this.iv.x = this.iv.z = 0; this.ivz = 0;
    this.holding = false; this.holdXY = false;
  }

  private limitsNow(): NavLimits {
    if (this.behavior === 'rth' || this.behavior === 'land') {
      const n = this.modes.find((m) => BEHAVIOR[m] === 'pos');
      return this.limits[n ?? this.mode];
    }
    return this.limits[this.mode];
  }
  private feel() { return this.mode === 'cine' ? FEEL.cine : this.mode === 'sport' ? FEEL.sport : FEEL.normal; }

  /**
   * One control step: returns the virtual sticks for the inner attitude/rate loop and sets its mode.
   * @param sticks pilot sticks (throttle 0..1, 0.5 = hold altitude in GPS modes)
   */
  step(dt: number, sticks: Sticks, nav: NavInput): Sticks {
    const inner = this.inner, o = this.out, b = this.behavior, L = this.limitsNow();
    // ---- sensors: GPS (slow drift), baro, compass
    const p = this.mPos;
    p.x = nav.pos.x + GPS_DRIFT_M * this.gx.step(dt);
    p.z = nav.pos.z + GPS_DRIFT_M * this.gz.step(dt);
    p.y = nav.pos.y + BARO_NOISE_M * this.gb.step(dt);
    const v = nav.vel;
    if (inner.armed && !this.wasArmed) {
      // arming sets the home point (GPS fix assumed) and starts on the ground
      this.home.x = p.x; this.home.y = p.y; this.home.z = p.z; this.homeSet = true;
      this.landed = true; this.landT = 0; this.downT = 0; this.ivz = 0; this.iv.x = this.iv.z = 0;
      this.vc.x = this.vc.z = this.ac.x = this.ac.z = 0;
      if (this.behavior === 'rth' || this.behavior === 'land') this.mode = this.modes.find((m) => BEHAVIOR[m] === 'pos') ?? this.mode;
    }
    this.wasArmed = inner.armed;
    this.altitude = p.y - this.home.y;
    this.hSpeed = Math.hypot(v.x, v.z); this.vSpeed = v.y;
    this.distHome = Math.hypot(p.x - this.home.x, p.z - this.home.z);
    // heading frame: forward/right on the horizontal plane
    const f = rotate(this.fwd, nav.rot, FWD);
    f.y = 0;
    const fl = Math.hypot(f.x, f.z) || 1; f.x /= fl; f.z /= fl;
    const rx = -f.z, rz = f.x;

    inner.maxAngle = INNER_MAX_ANGLE;
    if (b === 'acro') {
      inner.mode = 'acro'; inner.rates = this.acroRates;
      return this.copy(sticks);
    }
    inner.mode = 'angle'; inner.rates = this.navRates;
    if (b === 'stab') {
      // manual collective, stick = tilt
      o.throttle = sticks.throttle;
      o.roll = (sticks.roll * L.tilt * DEG) / INNER_MAX_ANGLE; o.pitch = (sticks.pitch * L.tilt * DEG) / INNER_MAX_ANGLE;
      o.yaw = (sticks.yaw * this.feel().yaw) / YAW_MAX_DPS;
      return o;
    }

    // ---- vertical: climb-rate stick with altitude hold
    const c = sticks.throttle - 0.5;
    let vzDes = Math.abs(c) < STICK_DB ? 0 : c > 0 ? (L.v_up * (c - STICK_DB)) / (0.5 - STICK_DB) : (L.v_down * (c + STICK_DB)) / (0.5 - STICK_DB);
    let yawStick = Math.abs(sticks.yaw) < STICK_DB ? 0 : sticks.yaw;
    let vx = 0, vz = 0, manualTilt = false;
    const feel = this.feel();

    if (b === 'rth' || b === 'land') {
      vzDes = 0; yawStick = 0;
      const dx = this.home.x - p.x, dz = this.home.z - p.z, dist = Math.hypot(dx, dz);
      if (b === 'land') this.rthPhase = 'descend';
      else if (this.rthPhase === 'idle') this.rthPhase = dist < RTH_DIRECT_DIST ? 'descend' : this.altitude < RTH_MIN_ALT - 1 ? 'climb' : 'fly';
      if (this.rthPhase === 'climb') {
        this.holdHere(p); vzDes = L.v_up;
        if (this.altitude >= RTH_MIN_ALT) this.rthPhase = 'fly';
      } else if (this.rthPhase === 'fly') {
        const sp = Math.min(L.v_xy, KP_POS * 0.6 * dist);
        vx = (dx / (dist || 1)) * sp; vz = (dz / (dist || 1)) * sp;
        this.holdXY = false;
        // turn the nose towards home
        const err = Math.atan2(dx * rx + dz * rz, dx * f.x + dz * f.z);
        yawStick = clamp(err * 1.5, -1, 1);
        if (dist < 1.5) { this.rthPhase = 'descend'; this.holdHere(p); }
      }
      if (this.rthPhase === 'descend') {
        if (!this.holdXY) this.holdHere(p);
        vzDes = -(nav.groundDist < 3 ? LAND_SPEED : Math.min(L.v_down, 3));
      }
    } else if (b === 'pos') {
      const sx = Math.abs(sticks.roll) < STICK_DB ? 0 : sticks.roll, sy = Math.abs(sticks.pitch) < STICK_DB ? 0 : sticks.pitch;
      vx = (f.x * sy + rx * sx) * L.v_xy; vz = (f.z * sy + rz * sx) * L.v_xy;
      if (sx || sy) this.holdXY = false;
    } else manualTilt = true; // ATTI / AltHold: stick = tilt, the wind drifts the drone

    // downward vision (PHYSICS 5.4, DJI landing protection): a full-down stick slows to a soft touchdown near the ground
    if (this.obstacleAvoidance && this.mode !== 'sport' && vzDes < 0 && !this.landed) {
      if (++this.downCount >= 8) { this.downCount = 0; this.downDist = nav.ray(nav.pos, DOWN, DOWN_RANGE); }
      vzDes = Math.max(vzDes, -Math.max(LAND_SPEED, DESCENT_SLOW_K * this.downDist));
    } else this.downCount = 7;

    // ---- on the ground: idle until the pilot climbs
    if (this.landed) {
      this.ivz = 0; this.iv.x = this.iv.z = 0; this.vc.x = this.vc.z = this.ac.x = this.ac.z = 0;
      o.roll = o.pitch = 0; o.yaw = 0; o.throttle = 0;
      if (vzDes > 0.2 && inner.armed) { this.landed = false; this.altTarget = p.y; this.holding = false; this.holdHere(p); }
      // DJI: throttle stick held down on the ground stops the motors — not while the yaw stick is out: that is the
      // start gesture (CSC / PX4 throttle down + yaw right, input/gestures.ts) still being held
      this.downT = inner.armed && sticks.throttle < 0.1 && Math.abs(sticks.yaw) < 0.5 ? this.downT + dt : 0;
      if (inner.armed && (this.downT > 1 || b === 'rth' || b === 'land')) { inner.setArmed(false, 0); this.mode = this.modes.find((m) => BEHAVIOR[m] === 'pos') ?? this.mode; }
      return o;
    }

    // ---- horizontal: velocity command with accel/jerk limits, obstacle braking, position hold
    const brakeTilt = Math.min(BRAKE_TILT_GAIN * L.tilt, Math.max(L.tilt, BRAKE_TILT_MAX)) * DEG;
    const aMax = G * Math.tan(L.tilt * DEG) * 0.8, aBrake = G * Math.tan(brakeTilt);
    this.obstacle = false;
    let braking = false;
    if (!manualTilt) {
      if (this.obstacleAvoidance && this.mode !== 'sport' && b === 'pos') {
        const sp = Math.hypot(vx, vz);
        if (sp > 0.3) {
          const dir = this.tmp;
          dir.x = vx / sp; dir.y = 0; dir.z = vz / sp;
          if (++this.rayCount >= 8) { this.rayCount = 0; this.rayDist = nav.ray(nav.pos, dir, OBSTACLE_RANGE); }
          // stop at the margin with half the braking authority in reserve (the drone lags the command)
          const vAllow = Math.sqrt(aBrake * Math.max(0, this.rayDist - OBSTACLE_MARGIN - Math.hypot(v.x, v.z) * 0.3));
          if (sp > vAllow) {
            vx *= vAllow / sp; vz *= vAllow / sp; this.obstacle = true;
            const along = this.vc.x * dir.x + this.vc.z * dir.z;
            if (along > vAllow) { this.vc.x -= dir.x * (along - vAllow); this.vc.z -= dir.z * (along - vAllow); }
          }
        } else this.rayDist = Infinity;
      }
      braking = Math.hypot(vx, vz) < Math.hypot(this.vc.x, this.vc.z) - 0.3 || this.obstacle;
      const jerk = feel.jerk * (b === 'rth' ? 0.5 : braking ? BRAKE_JERK_GAIN : 1);
      const aLim = braking ? aBrake : aMax;
      for (const k of ['x', 'z'] as const) {
        const aDes = clamp(CMD_RESPONSE * (braking ? 1.5 : 1) * ((k === 'x' ? vx : vz) - this.vc[k]), -aLim, aLim);
        this.ac[k] += clamp(aDes - this.ac[k], -jerk * dt, jerk * dt);
        this.vc[k] += this.ac[k] * dt;
      }
      // sticks centred and the command has settled: hold the position where the drone stopped
      const settled = vx === 0 && vz === 0 && Math.hypot(this.vc.x, this.vc.z) < 0.3;
      if (settled && !this.holdXY && this.hSpeed < 0.5) this.holdHere(p);
      let tx = this.vc.x, tz = this.vc.z;
      if (this.holdXY) { tx = KP_POS * (this.hold.x - p.x); tz = KP_POS * (this.hold.z - p.z); }
      const ax = KP_VEL * (tx - v.x) + this.iv.x + (this.holdXY ? 0 : this.ac.x);
      const az = KP_VEL * (tz - v.z) + this.iv.z + (this.holdXY ? 0 : this.ac.z);
      this.iv.x = clamp(this.iv.x + KI_VEL * (tx - v.x) * dt, -I_VEL_MAX, I_VEL_MAX);
      this.iv.z = clamp(this.iv.z + KI_VEL * (tz - v.z) * dt, -I_VEL_MAX, I_VEL_MAX);
      // world accel -> heading frame -> tilt (pitch+ nose down = forward, roll+ = right)
      let th = Math.atan2(ax * f.x + az * f.z, G), ph = Math.atan2(ax * rx + az * rz, G);
      const tilt = Math.hypot(th, ph), tmax = braking || this.holdXY ? brakeTilt : L.tilt * DEG;
      if (tilt > tmax) { th *= tmax / tilt; ph *= tmax / tilt; }
      if (this.pitchUpLimit !== null && th < -this.pitchUpLimit) th = -this.pitchUpLimit;
      o.pitch = th / INNER_MAX_ANGLE; o.roll = ph / INNER_MAX_ANGLE;
    } else {
      o.roll = (sticks.roll * L.tilt * DEG) / INNER_MAX_ANGLE; o.pitch = (sticks.pitch * L.tilt * DEG) / INNER_MAX_ANGLE;
    }
    o.yaw = (yawStick * feel.yaw) / YAW_MAX_DPS;

    // ---- altitude: hold when the stick is centred, geofence ceiling
    let vzCmd: number;
    const ceiling = this.home.y + this.fence;
    if (vzDes === 0) {
      if (!this.holding) { this.altTarget = p.y + v.y * 0.4; this.holding = true; }
      this.altTarget = Math.min(this.altTarget, ceiling);
      vzCmd = clamp(KP_ALT * (this.altTarget - p.y), -L.v_down, L.v_up);
    } else {
      this.holding = false;
      vzCmd = p.y >= ceiling && vzDes > 0 ? 0 : vzDes;
    }
    const azv = KP_VZ * (vzCmd - v.y) + this.ivz;
    this.ivz = clamp(this.ivz + KI_VZ * (vzCmd - v.y) * dt, -I_VZ_MAX, I_VZ_MAX);
    const cosT = Math.max(0.5, nav.up.y);
    const T = (this.model.mass * Math.max(0.15 * G, G + azv)) / cosT;
    o.throttle = throttleForThrust(this.model, T / this.model.rotors.length);

    // ---- touchdown: descending, barely moving, close to the ground
    const desc = vzCmd < -0.1 || b === 'land' || this.rthPhase === 'descend';
    if (desc && Math.abs(v.y) < 0.25 && nav.groundDist < 0.35) this.landT += dt; else this.landT = 0;
    if (this.landT > 0.6) { this.landed = true; this.landT = 0; this.rthPhase = 'idle'; }
    return o;
  }

  private holdHere(p: V3) { this.hold.x = p.x; this.hold.z = p.z; this.holdXY = true; this.vc.x = this.vc.z = this.ac.x = this.ac.z = 0; }
  private copy(s: Sticks): Sticks { const o = this.out; o.throttle = s.throttle; o.roll = s.roll; o.pitch = s.pitch; o.yaw = s.yaw; return o; }
}

const FWD = v3(0, 0, -1), DOWN = v3(0, -1, 0);

/** Collective throttle (0..1, before the mixer's idle offset) that makes one rotor produce `thrust` N at the
 *  nominal pack voltage: inverse of the motor's steady Ω(command) curve (the velocity loop's I-term absorbs sag). */
export function throttleForThrust(m: DroneModel, thrust: number): number {
  const w = Math.sqrt(Math.max(0, thrust) / (m.kT0 * m.ductGain));
  const c = m.omegaCurve, N = c.length - 1;
  let cmd = 1;
  if (w <= c[0]) cmd = 0;
  else for (let k = 0; k < N; k++) {
    if (w <= c[k + 1]) { cmd = (k + (w - c[k]) / (c[k + 1] - c[k] || 1)) / N; break; }
  }
  return clamp((cmd - m.idle) / (1 - m.idle), 0, 1);
}
