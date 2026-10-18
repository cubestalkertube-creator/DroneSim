// Fixed-wing fly-by-wire controller (PHYSICS.md 5.2 FBW-A / Cruise / Auto, 5.5): delta wing and the FW half
// of the quadplane. Cascade like ArduPlane/PX4 FW:
//   guidance (course / L1 path / loiter circle, altitude) -> bank and pitch setpoints (TECS-lite: pitch flies
//   the climb rate, the autothrottle flies the airspeed) -> attitude P -> body-rate P+I -> required moment ->
//   elevons through the wing model (dynamic pressure scaling + trim feed-forward) -> elevon mixer dL/dR.
// Envelope protection (not in MANUAL): bank and pitch limits, low-airspeed protection lowers the nose.
// Rail launch (booster), parachute recovery and belly landing are flight phases of the delta wing.
// Flight dynamics and navigation only — there is nothing else in this airframe model (CLAUDE.md).
import { DEG, clamp, rotate, v3, type Q4, type V3 } from '../math';
import type { DroneModel, WingModel } from '../presets';
import type { Sticks } from './betaflight';

export type PlaneBehavior = 'manual' | 'fbw' | 'cruise' | 'wp' | 'rtl';
export type PlanePhase = 'rail' | 'boost' | 'flight' | 'chute' | 'landed';

const BEHAVIOR: Record<string, PlaneBehavior> = {
  manual: 'manual', fbw_a: 'fbw', cruise: 'cruise', waypoints: 'wp', fw_position: 'cruise', mission: 'wp', rtl: 'rtl',
};
export const PLANE_LABEL: Record<string, string> = {
  manual: 'MANUAL', fbw_a: 'FBW-A', cruise: 'CRUISE', waypoints: 'AUTO', fw_position: 'FW POSCTL', mission: 'MISSION', rtl: 'RTL',
};

const G = 9.80665, RHO = 1.225;
// controller tuning (firmware defaults, not airframe physics)
const STICK_DB = 0.06;
const K_PHI = 2.5, P_MAX = 90 * DEG, K_P = 6, KI_P = 3, I_P_MAX = 3;          // roll: 1/s, rad/s, 1/s, 1/s^2, rad/s^2
const K_THETA = 2.5, Q_MAX = 40 * DEG, K_Q = 6, KI_Q = 3, I_Q_MAX = 3;      // pitch
const K_ALT = 0.25;            // 1/s  altitude error -> climb rate
const K_VZ = 0.04, KI_VZ = 0.04, I_VZ_MAX = 8 * DEG; // climb-rate error -> pitch (rad per m/s), its integral
const K_V = 0.08, KI_V = 0.05, K_GAMMA = 1.2; // autothrottle: 1/(m/s), 1/(m/s*s), per rad of path angle
const K_CHI = 0.6;             // 1/s  course error -> turn rate
const L1_PERIOD = 20;          // s    L1 guidance distance = period * V / (2 pi) * 1.5 (PX4 NAV_L1_PERIOD ~ 20 s)
const PROTECT_SPEED = 1.15, PROTECT_BAND = 0.15; // low-speed protection starts at 1.15 V_stall, full at 1.0
const PROTECT_PITCH = -4 * DEG;
const FLARE_HEIGHT = 8, FLARE_PROTECT = 0.3; // m: close to the ground the pilot may flare through the low-speed protection
const BOOST_MIN_SPEED = 1.1;   // x V_stall: the booster phase ends after burn-out once this fast
const LAUNCH_THROTTLE = 0.9;   // throttle stick above this on the rail fires the booster
const CLIMB_OUT_ALT = 40, CLIMB_OUT_GAMMA = 4 * DEG; // after the launch: climb at this path angle up to this height
const CHUTE_SPEED = 1.15;      // x V_stall: the parachute opens once slowed down to this (engine cut, nose up)
const LANDED_SPEED = 0.6, LANDED_TIME = 1.5, LANDED_GROUND = 0.4;
const ROUTE_ACCEPT_MIN = 40;   // m

export interface PlaneInput {
  pos: V3; vel: V3; rot: Q4;
  /** body angular velocity, air-relative body velocity */
  wb: V3; vb: V3;
  /** belly height above the ground (m) */
  groundDist: number;
}

export interface PlaneOutput { elevL: number; elevR: number; throttle: number }

/** Physical systems the FC operates (Drone implements them). */
export interface PlaneActuators {
  fireBooster(): void;
  deployChute(): void;
  readonly onRail: boolean;
  readonly boosting: boolean;
}

export class PlaneFC {
  readonly modes: string[];
  mode: string;
  phase: PlanePhase = 'flight';
  /** pilot-facing telemetry */
  airspeed = 0; altitude = 0; course = 0; heading = 0; climb = 0; distHome = 0;
  /** waypoint mission: index of the active waypoint, distance to it */
  wpIndex = 0; wpDist = 0;
  /** envelope protection active / airspeed below the stall speed (HUD) */
  protecting = false; lowSpeed = false;
  /** reached the end of the route (VTOL mission -> RTL) */
  routeDone = false;
  home = v3(); homeSet = false;
  readonly vStall: number; readonly vCruise: number; readonly vMax: number; readonly vMin: number;
  readonly route: V3[] = [];
  private readonly w: WingModel;
  private readonly lim: { bank: number; up: number; down: number; climb: number; sink: number };
  private readonly rtlAlt: number; private readonly loiterR: number;
  private ip = 0; private iq = 0; private ivz = 0; private ithr = 0.6;
  private holdAlt = 0; private altHeld = false; private holdCourse = 0; private courseHeld = false;
  private landedT = 0; private chuteWanted = false; private climbOut = false;
  private wpFrom = v3();
  private f = v3(); private r = v3(); private u = v3();
  private out: PlaneOutput = { elevL: 0, elevR: 0, throttle: 0 };
  private wasArmed = false;
  armed = false;
  armBlockReason = '';

  constructor(private readonly model: DroneModel, private readonly act: PlaneActuators | null, modes?: string[]) {
    const fc = model.preset.fc;
    this.w = model.wing!;
    this.modes = (modes ?? fc.modes).filter((m) => m in BEHAVIOR);
    this.mode = this.modes.includes(fc.default_mode) ? fc.default_mode : this.modes[0];
    this.vStall = fc.stall_airspeed ?? 12;
    this.vCruise = fc.cruise_airspeed ?? this.vStall * 1.5;
    this.vMax = fc.max_airspeed ?? this.vCruise * 1.2;
    this.vMin = Math.min(this.vCruise, this.vStall * 1.25);
    const l = fc.fw_limits ?? { bank_deg: 35, pitch_up_deg: 20, pitch_down_deg: 20, climb_ms: 5, sink_ms: 5 };
    this.lim = { bank: l.bank_deg * DEG, up: l.pitch_up_deg * DEG, down: l.pitch_down_deg * DEG, climb: l.climb_ms, sink: l.sink_ms };
    this.rtlAlt = fc.rtl_alt_m ?? 60;
    this.loiterR = fc.loiter_radius_m ?? 2 * (this.vCruise * this.vCruise) / (G * Math.tan(this.lim.bank));
    this.phase = act?.onRail ? 'rail' : 'flight';
  }

  get behavior(): PlaneBehavior { return BEHAVIOR[this.mode] ?? 'fbw'; }
  get label() {
    if (this.phase === 'rail') return 'RAIL';
    if (this.phase === 'boost') return 'BOOST';
    if (this.phase === 'chute') return 'PARACHUTE';
    if (this.phase === 'landed') return 'LANDED';
    return PLANE_LABEL[this.mode] ?? this.mode.toUpperCase();
  }

  setMode(m: string) {
    if (!(m in BEHAVIOR) || m === this.mode) return;
    if (!this.modes.includes(m) && m !== 'manual') return;
    this.mode = m; this.altHeld = false; this.courseHeld = false;
    if (BEHAVIOR[m] === 'wp') this.startRoute();
  }
  nextMode() { this.setMode(this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length]); }

  setArmed(want: boolean, throttle: number): boolean {
    if (want === this.armed) return false;
    if (want && this.phase === 'landed') { this.armBlockReason = 'Посадка завершена — рестарт (R)'; return false; }
    if (want && throttle > 0.05) { this.armBlockReason = 'Газ не в нуле'; return false; }
    this.armBlockReason = '';
    this.armed = want;
    this.ip = this.iq = this.ivz = 0; this.ithr = 0.6;
    return true;
  }

  reset() {
    this.phase = this.act?.onRail ? 'rail' : 'flight';
    this.armed = false; this.wasArmed = false; this.homeSet = false; this.chuteWanted = false; this.landedT = 0;
    this.ip = this.iq = this.ivz = 0; this.ithr = 0.6; this.altHeld = this.courseHeld = false;
    this.routeDone = false; this.wpIndex = 0; this.climbOut = false;
  }

  /** Parachute recovery (delta wing): engine cut, slow down, open the canopy. */
  requestChute() { if (this.act && (this.phase === 'flight' || this.phase === 'boost')) this.chuteWanted = true; }

  /** Set home / reset the mission at take-off (VTOL calls this when it arms). */
  setHome(p: V3) { this.home.x = p.x; this.home.y = p.y; this.home.z = p.z; this.homeSet = true; }

  /** Restart the route from the current position (first waypoint). */
  startRoute(from?: V3) {
    const rt = this.model.preset.fc.route ?? [];
    this.route.length = 0;
    for (const [dx, dz, alt] of rt) this.route.push(v3(this.home.x + dx, this.home.y + alt, this.home.z + dz));
    this.wpIndex = 0; this.routeDone = false;
    if (from) { this.wpFrom.x = from.x; this.wpFrom.z = from.z; } else this.wpFromCur = true;
  }
  private wpFromCur = true;

  /** Take over in flight (VTOL front transition): hold the current altitude and course. */
  engage(inp: PlaneInput) {
    this.altHeld = false; this.courseHeld = false;
    this.iq = this.ip = 0; this.ivz = 0;
    this.measure(inp);
    this.holdAlt = inp.pos.y; this.altHeld = true;
    this.holdCourse = this.course; this.courseHeld = true;
  }

  /**
   * @param centredThrottle the throttle stick is spring-centred (VTOL): 0.5 = cruise airspeed
   */
  step(dt: number, sticks: Sticks, inp: PlaneInput, centredThrottle = false): PlaneOutput {
    const o = this.out, act = this.act;
    this.measure(inp);
    if (this.armed && !this.wasArmed && !this.homeSet) this.setHome(inp.pos);
    this.wasArmed = this.armed;
    this.altitude = inp.pos.y - this.home.y;
    this.distHome = Math.hypot(inp.pos.x - this.home.x, inp.pos.z - this.home.z);
    o.throttle = 0;
    if (!this.armed) { o.elevL = o.elevR = 0; return o; }
    const V = this.airspeed;

    // ---- flight phases of the delta wing: rail -> boost -> flight -> (chute) -> landed
    if (this.phase === 'rail') {
      o.elevL = o.elevR = 0; this.ip = this.iq = 0;
      o.throttle = sticks.throttle;
      if (sticks.throttle > LAUNCH_THROTTLE && act) { act.fireBooster(); this.phase = 'boost'; this.setHome(inp.pos); }
      return o;
    }
    if (this.phase === 'boost') {
      // hold the rail attitude, wings level, full power until burn-out and flying speed
      const elev = (this.model.preset.launch?.rail_elev_deg ?? 10) * DEG;
      this.attitude(dt, 0, elev, inp, V);
      o.throttle = 1;
      if (!act?.boosting && !act?.onRail && V > BOOST_MIN_SPEED * this.vStall) { this.phase = 'flight'; this.altHeld = false; this.courseHeld = false; this.climbOut = true; }
      if (this.chuteWanted) this.phase = 'flight';
      return o;
    }
    if (this.phase === 'chute' || this.phase === 'landed') {
      o.elevL = o.elevR = 0; o.throttle = 0;
      if (this.phase === 'chute' && this.onGround(dt, inp)) { this.phase = 'landed'; this.armed = false; }
      return o;
    }
    if (this.chuteWanted) {
      // cut the engine, pitch up to bleed speed, open the canopy once slow enough
      this.attitude(dt, 0, 8 * DEG, inp, V);
      if (V < CHUTE_SPEED * this.vStall || this.altitude < 15) { act!.deployChute(); this.phase = 'chute'; this.chuteWanted = false; }
      return o;
    }

    // ---- guidance -> bank / pitch setpoints, airspeed
    const b = this.behavior, L = this.lim;
    let bank = 0, pitch = 0, vsp = this.vCruise, idle = false, vzSp: number | null = null;
    const roll = Math.abs(sticks.roll) < STICK_DB ? 0 : sticks.roll, pst = Math.abs(sticks.pitch) < STICK_DB ? 0 : sticks.pitch;
    // throttle stick -> airspeed (centred stick: 0.5 = cruise); bottom = idle in FBW (glide / belly landing)
    const thr = sticks.throttle;
    if (centredThrottle) vsp = thr >= 0.5 ? this.vCruise + (thr - 0.5) * 2 * (this.vMax - this.vCruise) : this.vCruise - (0.5 - thr) * 2 * (this.vCruise - this.vMin);
    else { vsp = this.vMin + clamp((thr - 0.05) / 0.9, 0, 1) * (this.vMax - this.vMin); idle = thr < 0.05; }

    if (b === 'manual') {
      const em = this.w.elevMax;
      const de = sticks.pitch * em, da = sticks.roll * em;
      o.elevL = clamp(de + da, -em, em); o.elevR = clamp(de - da, -em, em);
      o.throttle = thr;
      this.protecting = false;
      this.onGround(dt, inp);
      return o;
    }
    // after the launch: wings-level climb-out to a safe height unless the pilot takes over
    if (this.climbOut && (this.altitude > CLIMB_OUT_ALT || roll || pst)) { this.climbOut = false; this.altHeld = false; }
    if (this.climbOut) {
      vzSp = Math.max(V, this.vMin) * Math.sin(CLIMB_OUT_GAMMA);
      pitch = this.pitchForClimb(dt, vzSp, V, inp, 0);
      if (b !== 'fbw') vsp = this.vCruise;
    } else if (b === 'fbw') {
      // stick = bank angle and flight-path angle (centred: wings level, level flight at any airspeed)
      bank = roll * L.bank;
      const gam = pst > 0 ? -pst * L.down : -pst * L.up;
      vzSp = Math.max(V, this.vMin) * Math.sin(gam);
      pitch = this.pitchForClimb(dt, vzSp, V, inp, bank);
    } else {
      // course / altitude
      let chiDes: number | null = null;
      if (b === 'cruise') {
        if (roll) { bank = roll * L.bank; this.courseHeld = false; } else {
          if (!this.courseHeld) { this.holdCourse = this.course; this.courseHeld = true; }
          chiDes = this.holdCourse;
        }
        if (pst) { vzSp = pst > 0 ? -pst * L.sink : -pst * L.climb; this.altHeld = false; } else if (!this.altHeld) { this.holdAlt = inp.pos.y + inp.vel.y * 2; this.altHeld = true; }
      } else if (b === 'wp') {
        if (!this.route.length) this.startRoute();
        if (this.routeDone || !this.route.length) chiDes = this.loiter(inp, this.home, this.loiterR);
        else chiDes = this.followRoute(inp);
        vsp = this.vCruise;
      } else { // rtl: fly home, circle above it
        const hx = this.home.x - inp.pos.x, hz = this.home.z - inp.pos.z;
        this.holdAlt = Math.max(this.altHeld ? this.holdAlt : inp.pos.y, this.home.y + this.rtlAlt); this.altHeld = true;
        chiDes = Math.hypot(hx, hz) > 2 * this.loiterR ? Math.atan2(hx, -hz) : this.loiter(inp, this.home, this.loiterR);
        vsp = this.vCruise;
      }
      if (chiDes !== null) bank = this.bankForCourse(chiDes, inp);
      if (vzSp === null) vzSp = clamp(K_ALT * (this.holdAlt - inp.pos.y), -L.sink, L.climb);
      pitch = this.pitchForClimb(dt, vzSp, V, inp, bank);
    }

    // ---- envelope protection: low airspeed -> nose down, less bank
    const k = clamp((PROTECT_SPEED * this.vStall - V) / (PROTECT_BAND * this.vStall), 0, 1) * (inp.groundDist < FLARE_HEIGHT ? FLARE_PROTECT : 1);
    this.protecting = k > 0; this.lowSpeed = V < this.vStall;
    if (k > 0) { pitch = pitch * (1 - k) + Math.min(pitch, PROTECT_PITCH) * k; bank *= 1 - 0.7 * k; }
    bank = clamp(bank, -L.bank, L.bank); pitch = clamp(pitch, -L.down, L.up);
    this.attitude(dt, bank, pitch, inp, V);
    o.throttle = idle ? 0 : this.autothrottle(dt, vsp, V, vzSp ?? 0, k);
    if (this.onGround(dt, inp) && idle) { this.phase = 'landed'; this.armed = false; }
    return o;
  }

  // ---------------------------------------------------------------------------------------------------------
  private measure(inp: PlaneInput) {
    const f = rotate(this.f, inp.rot, FWD);
    this.airspeed = Math.max(0, -inp.vb.z); // pitot along the nose
    this.heading = Math.atan2(f.x, -f.z);
    const gs = Math.hypot(inp.vel.x, inp.vel.z);
    this.course = gs > 2 ? Math.atan2(inp.vel.x, -inp.vel.z) : this.heading;
    this.climb = inp.vel.y;
  }

  /** belly on the ground and stopped (belly landing / parachute touchdown) */
  private onGround(dt: number, inp: PlaneInput): boolean {
    const sp = Math.hypot(inp.vel.x, inp.vel.y, inp.vel.z);
    if (inp.groundDist < LANDED_GROUND && sp < LANDED_SPEED) this.landedT += dt; else this.landedT = 0;
    return this.landedT > LANDED_TIME;
  }

  /** bank angle for a turn towards the desired course (ground track, so the wind drift is corrected) */
  private bankForCourse(chi: number, inp: PlaneInput): number {
    const err = wrap(chi - this.course);
    const gs = Math.max(Math.hypot(inp.vel.x, inp.vel.z), 1);
    const turnRate = clamp(K_CHI * err, -1, 1);
    return Math.atan((gs * turnRate) / G);
  }

  private l1() { return (L1_PERIOD * Math.max(this.airspeed, this.vMin) * 1.5) / (2 * Math.PI); }

  /** L1-style path following along the leg from the previous waypoint to the active one */
  private followRoute(inp: PlaneInput): number {
    const p = inp.pos;
    if (this.wpFromCur) { this.wpFrom.x = p.x; this.wpFrom.z = p.z; this.wpFromCur = false; }
    const B = this.route[this.wpIndex], A = this.wpFrom;
    this.holdAlt = B.y; this.altHeld = true;
    const dx = B.x - A.x, dz = B.z - A.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
    const dist = Math.hypot(B.x - p.x, B.z - p.z);
    this.wpDist = dist;
    const along = (p.x - A.x) * ux + (p.z - A.z) * uz;
    const accept = Math.max(ROUTE_ACCEPT_MIN, (this.airspeed * this.airspeed) / (G * Math.tan(this.lim.bank)));
    if (dist < accept || along > len) {
      this.wpFrom.x = B.x; this.wpFrom.z = B.z;
      this.wpIndex++;
      if (this.wpIndex >= this.route.length) {
        this.routeDone = true; this.wpIndex = this.route.length - 1;
        if (this.model.preset.fc.type === 'fixed_wing_fbw') { this.wpIndex = 0; this.routeDone = false; } // patrol loop
      }
      return this.course;
    }
    const ahead = Math.min(len, Math.max(0, along) + this.l1());
    const ax = A.x + ux * ahead - p.x, az = A.z + uz * ahead - p.z;
    return Math.atan2(ax, -az);
  }

  /** desired course to circle (clockwise from above) around c at radius R */
  private loiter(inp: PlaneInput, c: V3, R: number): number {
    const dx = inp.pos.x - c.x, dz = inp.pos.z - c.z, d = Math.hypot(dx, dz) || 1;
    const ux = dx / d, uz = dz / d;
    const k = clamp((1.5 * (R - d)) / R, -1.5, 1.5);
    const vx = -uz + k * ux, vz = ux + k * uz;
    this.wpDist = d;
    return Math.atan2(vx, -vz);
  }

  /** TECS-lite: path angle for the climb rate + estimated angle of attack for the load + integral */
  private pitchForClimb(dt: number, vzSp: number, V: number, inp: PlaneInput, bank: number): number {
    const w = this.w, a = w.aero;
    const Vc = Math.max(V, this.vMin * 0.7);
    const gamma = Math.asin(clamp(vzSp / Vc, -0.6, 0.6));
    const q = 0.5 * RHO * Vc * Vc;
    const cl = (this.model.mass * G * Math.cos(gamma)) / Math.max(0.2, Math.cos(bank)) / (q * w.S);
    const aEst = clamp((cl - a.CL0) / a.CLa, -w.alphaStall, w.alphaStall * 0.9);
    this.ivz = clamp(this.ivz + KI_VZ * (vzSp - inp.vel.y) * dt, -I_VZ_MAX, I_VZ_MAX);
    return gamma + aEst * Math.cos(bank) + K_VZ * (vzSp - inp.vel.y) + this.ivz;
  }

  private autothrottle(dt: number, vsp: number, V: number, vzSp: number, protect: number): number {
    const e = vsp - V;
    const gamma = Math.asin(clamp(vzSp / Math.max(V, 1), -0.5, 0.5));
    const thr = clamp(this.ithr + K_V * e + K_GAMMA * gamma, 0, 1);
    if (!((thr >= 1 && e > 0) || (thr <= 0 && e < 0))) this.ithr = clamp(this.ithr + KI_V * e * dt, 0, 1); // anti-windup
    return protect > 0 ? Math.max(thr, protect) : thr;
  }

  /** attitude -> body rates -> required moments -> elevons (model inversion with dynamic pressure) */
  private attitude(dt: number, bankSp: number, pitchSp: number, inp: PlaneInput, V: number) {
    const w = this.w, a = w.aero, m = this.model, o = this.out;
    const f = rotate(this.f, inp.rot, FWD), r = rotate(this.r, inp.rot, RIGHT), u = rotate(this.u, inp.rot, UP);
    const theta = Math.asin(clamp(f.y, -1, 1)), phi = Math.atan2(-r.y, u.y);
    const p = -inp.wb.z, q = inp.wb.x;
    const Vc = Math.max(V, 0.6 * this.vStall);
    // coordinated turn: the body pitch rate a level turn needs
    const ph = clamp(phi, -70 * DEG, 70 * DEG);
    const qTurn = ((G * Math.tan(ph)) / Vc) * Math.sin(ph);
    const pSp = clamp(K_PHI * wrap(bankSp - phi), -P_MAX, P_MAX);
    const qSp = clamp(K_THETA * (pitchSp - theta), -Q_MAX, Q_MAX) * Math.cos(ph) + qTurn;
    const ep = pSp - p, eq = qSp - q;
    this.ip = clamp(this.ip + KI_P * ep * dt, -I_P_MAX, I_P_MAX);
    this.iq = clamp(this.iq + KI_Q * eq * dt, -I_Q_MAX, I_Q_MAX);
    const accP = K_P * ep + this.ip, accQ = K_Q * eq + this.iq;
    const qS = 0.5 * RHO * Vc * Vc * w.S;
    const da = (m.inertia.z * accP) / (qS * w.b * a.Clda);
    // trim: elevator that cancels the static pitching moment at the angle of attack this load needs
    const cl = (m.mass * G * Math.max(0.3, Math.cos(theta))) / Math.max(0.3, Math.cos(ph)) / qS;
    const aEst = clamp((cl - a.CL0) / a.CLa, -w.alphaStall, w.alphaStall);
    const deTrim = -((a.Cm0 ?? 0) + a.Cma * Math.sin(aEst)) / a.Cmde;
    const de = (m.inertia.x * accQ) / (qS * w.c * a.Cmde) + deTrim; // Cmde < 0: nose up = trailing edge up
    const em = w.elevMax;
    const dE = clamp(de, -em, em), dA = clamp(da, -em, em);
    o.elevL = clamp(dE + dA, -em, em); o.elevR = clamp(dE - dA, -em, em);
  }
}

const FWD = v3(0, 0, -1), RIGHT = v3(1, 0, 0), UP = v3(0, 1, 0);
/** wrap an angle to (-pi, pi] */
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
