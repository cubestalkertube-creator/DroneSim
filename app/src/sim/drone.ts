// Drone dynamics (PHYSICS.md 2-4): ESC/motors + battery, propellers (advance ratio, H-force, ground effect,
// VRS / prop wash, rotor-wake interference), body drag, rotor reaction/gyro torques, gyro sensor model.
// Produces body-frame force/torque; Rapier integrates the rigid body.
import { BetaflightFC, type Sticks } from './fc/betaflight';
import { PositionFC, type NavInput } from './fc/position';
import { PlaneFC, type PlaneActuators, type PlaneInput } from './fc/plane';
import { VtolFC } from './fc/vtol';
import { WingAero } from './wing';
import { Pusher } from './pusher';
import { Mixer } from './mixer';
import { MotorBank } from './motor';
import { Battery } from './battery';
import {
  VRS_NOISE_HZ, VRS_THRUST_LOSS, VRS_THRUST_NOISE, VRS_TORQUE_NOISE, inducedVelocity, vrsIntensity, wakeFactor,
} from './aero';
import { Gauss, SmoothNoise, mulberry32 } from './rng';
import { buildModel, type DroneModel, type DronePreset } from './presets';
import { DEG, type Q4, type V3, rotate, rotateInv, v3 } from './math';

export const RHO = 1.225;
export const G = 9.80665;

export interface BodyState { pos: V3; rot: Q4; vel: V3; angVel: V3 } // world frame (angVel world)

export interface Environment {
  wind: V3;
  /** distance (m) along world dir from origin to the first static surface, or Infinity */
  ray(origin: V3, dir: V3, max: number): number;
}

export interface DroneTelemetry {
  omega: Float64Array; cmd: Float64Array; thrust: Float64Array;
  airspeed: number; groundDist: number;
  /** prop-wash / VRS intensity 0..1 (max over rotors) */
  vrs: number;
}

const GE_RAY_EVERY = 4; // ground-effect raycast every N steps (4 ms)
const BELLY_RAY_MAX = 60; // m: fixed wing height-above-ground ray
const DEFAULT_GYRO_NOISE_DPS = 0.2, DEFAULT_VIBRATION_DPS = 2;
const TURTLE_UPRIGHT = 0.5; // cos(60 deg): tipped far enough to fall onto the belly by itself

export class Drone implements PlaneActuators {
  readonly model: DroneModel;
  /** attitude / rate controller (Betaflight-like) of the lift rotors; GPS drones drive it from `nav`.
   *  Its `armed` flag is the arming state of every airframe (fixed wing included). */
  readonly fc: BetaflightFC;
  /** GPS position controller (gps_consumer / px4 / ardupilot presets, VTOL in MC), null for FPV */
  readonly nav: PositionFC | null;
  /** fixed-wing FBW controller (delta wing; the FW half of the VTOL) */
  readonly plane: PlaneFC | null;
  /** quadplane transition logic over nav + plane */
  readonly vtol: VtolFC | null;
  readonly wing: WingAero | null;
  readonly pusher: Pusher | null;
  /** rotor speeds for the visual model and the sound, GLB order rotor_<i>: lift rotors, then the pusher */
  readonly visOmega: Float64Array; readonly visThrust: Float64Array;
  /** rail launch state (delta wing): held on the rail until the booster fires, slides along it, released */
  readonly rail = { active: false, fired: false, s: 0, sDot: 0, start: v3(), dir: v3(), rot: { x: 0, y: 0, z: 0, w: 1 } };
  /** booster burn time left (s), parachute opening 0..1 (-1 = released after touchdown) */
  boosterLeft = 0; chute = 0; chuteOpen = false;
  readonly mixer: Mixer;
  readonly battery: Battery;
  readonly motors: MotorBank;
  readonly omega: Float64Array;     // rad/s per rotor
  readonly omegaDot: Float64Array;
  readonly tele: DroneTelemetry;
  /** body-frame outputs of the last step */
  readonly force = v3(); readonly torque = v3();
  /** gyro as the FC reads it (rad/s, FC axes: roll right, nose down, nose right), noise + vibration included */
  readonly gyro: [number, number, number] = [0, 0, 0];
  private geFactor: Float64Array; private geCounter = 0;
  private kq: Float64Array; private kt: Float64Array;
  private readonly vh: number;          // hover induced velocity of one rotor (m/s)
  private readonly hoverThrust: number; // per rotor, N
  private readonly gyroNoise: number; private readonly vib: number; // rad/s
  private vrsT: SmoothNoise[]; private vrsX: SmoothNoise[]; private vrsZ: SmoothNoise[];
  private gauss: Gauss;
  private phase: Float64Array;
  // scratch
  private vb = v3(); private wb = v3(); private tmp = v3(); private tmp2 = v3(); private up = v3();
  private rotorWorld = v3(); private down = v3();
  private planeIn: PlaneInput = { pos: v3(), vel: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, wb: v3(), vb: v3(), groundDist: Infinity };
  private mcOff = false;
  private navIn: NavInput = { pos: v3(), vel: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, up: v3(), groundDist: Infinity, ray: () => Infinity };

  constructor(preset: DronePreset, seed = 1) {
    const m = (this.model = buildModel(preset));
    this.fc = new BetaflightFC(preset);
    const type = preset.fc.type;
    this.nav = NAV_FC.includes(type) || type === 'px4_vtol' ? new PositionFC(m, this.fc, seed) : null;
    this.wing = m.wing ? new WingAero(m.wing) : null;
    this.pusher = m.pusher ? new Pusher(m.pusher) : null;
    this.rail.active = preset.launch?.type === 'rail_booster';
    this.plane = m.wing ? new PlaneFC(m, type === 'fixed_wing_fbw' ? this : null) : null;
    this.vtol = type === 'px4_vtol' && this.nav && this.plane ? new VtolFC(m, this.nav, this.plane) : null;
    if (this.nav || this.plane) this.fc.turtle = false;
    this.mixer = new Mixer(m);
    this.battery = new Battery(preset, m.vNominal);
    this.motors = new MotorBank(m, this.battery);
    // firmware with motor-failure handling (Typhoon H) re-allocates over the working motors; others don't know
    if ((preset.fc as { motor_out_tolerant?: boolean }).motor_out_tolerant) this.mixer.failed = this.motors.failed;
    const n = m.rotors.length;
    this.omega = this.motors.omega;
    this.omegaDot = this.motors.omegaDot;
    this.geFactor = new Float64Array(n).fill(1);
    this.kq = new Float64Array(n); this.kt = new Float64Array(n);
    this.hoverThrust = (m.mass * G) / n;
    this.vh = inducedVelocity(this.hoverThrust, m.diameter, RHO);
    this.gyroNoise = (preset.sensors?.gyro_noise_dps ?? DEFAULT_GYRO_NOISE_DPS) * DEG;
    this.vib = (preset.sensors?.vibration_dps ?? DEFAULT_VIBRATION_DPS) * DEG;
    const u = mulberry32(seed);
    this.gauss = new Gauss(u);
    const mk = () => Array.from({ length: n }, () => new SmoothNoise(u, VRS_NOISE_HZ));
    this.vrsT = mk(); this.vrsX = mk(); this.vrsZ = mk();
    this.phase = new Float64Array(n).map(() => u() * 2 * Math.PI);
    this.tele = { omega: this.omega, cmd: this.mixer.out, thrust: new Float64Array(n), airspeed: 0, groundDist: Infinity, vrs: 0 };
    const nv = n + (this.pusher ? 1 : 0);
    this.visOmega = new Float64Array(nv); this.visThrust = new Float64Array(nv);
  }

  /** ---- PlaneActuators: rail launch booster and recovery parachute (delta wing) */
  get onRail() { return this.rail.active; }
  get boosting() { return this.boosterLeft > 0; }
  fireBooster() {
    const l = this.model.preset.launch;
    if (!l || this.rail.fired) return;
    this.rail.fired = true; this.boosterLeft = l.booster_time_s;
  }
  deployChute() { if (this.model.preset.recovery && !this.chuteOpen) { this.chuteOpen = true; this.chute = 0; } }

  /** rotor speed of the fastest prop relative to its maximum (sound/visual normalisation) */
  get visOmegaMax() { return this.model.rotors.length ? this.model.omegaMax : this.model.pusher?.max_rad_s ?? 1; }

  /** pilot-facing flight mode of whichever controller is in charge */
  get modeLabel(): string {
    if (this.vtol) return this.vtol.label;
    if (this.plane) return this.plane.label;
    if (this.nav) return this.nav.label;
    return this.fc.turtle ? 'Turtle' : this.fc.mode;
  }

  reset() {
    this.motors.reset(); this.geFactor.fill(1);
    this.battery.reset();
    this.fc.setArmed(false, 0);
    this.nav?.reset();
    this.wing?.reset(); this.pusher?.reset();
    this.rail.fired = false; this.rail.s = this.rail.sDot = 0; this.rail.active = this.model.preset.launch?.type === 'rail_booster';
    this.boosterLeft = 0; this.chute = 0; this.chuteOpen = false;
    this.plane?.reset(); this.vtol?.reset();
  }

  /** Arm / disarm through the outer controller when there is one (GPS: throttle at centre is fine). */
  setArmed(want: boolean, throttle: number): boolean {
    if (this.plane && !this.vtol) {
      const ok = this.plane.setArmed(want, throttle);
      this.fc.armBlockReason = this.plane.armBlockReason;
      if (ok) this.fc.setArmed(want, 0);
      return ok;
    }
    return this.nav ? this.nav.setArmed(want, throttle) : this.fc.setArmed(want, throttle);
  }

  /** Advance controller + motors by dt and compute force/torque (body frame) for the current state. */
  step(dt: number, sticks: Sticks, s: BodyState, env: Environment) {
    const m = this.model;
    const vb = rotateInv(this.vb, s.rot, subWind(this.tmp, s.vel, env.wind)); // air-relative velocity, body frame
    const wb = rotateInv(this.wb, s.rot, s.angVel);
    const up = rotateInv(this.up, s.rot, UP);
    this.readGyro(dt, wb);
    const fc = this.fc, pl = this.plane, wing = this.wing;
    // ---- controllers: GPS cascade / fixed-wing FBW / quadplane transitions -> lift-rotor sticks, pusher, elevons
    let mc: Sticks | null = sticks, lift = 1, pusherCmd = 0;
    if (pl) {
      const pin = this.planeIn;
      pin.pos = s.pos; pin.vel = s.vel; pin.rot = s.rot; pin.wb = wb; pin.vb = vb; pin.groundDist = this.tele.groundDist;
      let elevL: number, elevR: number;
      if (this.vtol) {
        const o = this.vtol.step(dt, sticks, this.fillNav(s, up, env), pin, fc.armed);
        mc = o.mc; lift = o.lift; pusherCmd = o.pusher; elevL = o.elevL; elevR = o.elevR;
      } else {
        if (!fc.armed) pl.armed = false; // crash / external disarm
        const o = pl.step(dt, sticks, pin);
        if (!pl.armed && fc.armed) fc.setArmed(false, 0); // landed
        mc = null; pusherCmd = o.throttle; elevL = o.elevL; elevR = o.elevR;
      }
      wing!.cmdL = elevL; wing!.cmdR = elevR;
    } else if (this.nav) mc = this.nav.step(dt, sticks, this.fillNav(s, up, env));
    let cmd: Float64Array = this.mixer.out;
    if (m.rotors.length) {
      if (!mc) { cmd.fill(0); this.mcOff = true; } else {
        if (this.mcOff) { fc.pids.forEach((p) => p.reset()); this.mcOff = false; } // lift rotors back on (VTOL)
        const out = fc.step(dt, mc, this.gyro, up);
        if (fc.armed && fc.turtle) {
          // like Betaflight 4.5 crashflip auto-stop: once the quad is back on its belly the reversed motors stop
          cmd = up.y > TURTLE_UPRIGHT ? this.mixer.out.fill(0) : this.mixer.mixTurtle(mc.roll, mc.pitch, mc.yaw);
        } else cmd = this.mixer.mix(out.throttle, out.accel, fc.armed, fc.airmode);
        if (lift < 1) for (let i = 0; i < cmd.length; i++) cmd[i] *= lift;
      }
    }

    // ground effect: raycast down from each rotor along -thrust axis every few steps
    if (++this.geCounter >= GE_RAY_EVERY) {
      this.geCounter = 0;
      rotate(this.down, s.rot, DOWN);
      const R = m.diameter / 2;
      let minD = Infinity;
      for (let i = 0; i < m.rotors.length; i++) {
        rotate(this.rotorWorld, s.rot, m.rotors[i].pos);
        this.rotorWorld.x += s.pos.x; this.rotorWorld.y += s.pos.y; this.rotorWorld.z += s.pos.z;
        const d = env.ray(this.rotorWorld, this.down, 4 * R + 0.5);
        minD = Math.min(minD, d);
        const z = Math.max(d, 0.5 * R);
        this.geFactor[i] = d === Infinity ? 1 : Math.min(1.4, 1 / (1 - (R / (4 * z)) ** 2));
      }
      if (!m.rotors.length) minD = env.ray(s.pos, DOWN, BELLY_RAY_MAX) - m.halfExtents.y; // fixed wing: belly height
      this.tele.groundDist = minD;
    }

    // propeller load at the current rotor speed (advance ratio uses the local inflow), then the motors
    const D = m.diameter;
    const muBody = Math.hypot(vb.x, vb.z) / this.vh;
    let vrsMax = 0;
    for (let i = 0; i < m.rotors.length; i++) {
      const r = m.rotors[i], w0 = this.omega[i];
      const lv = cross3(this.tmp2, wb, r.pos);
      lv.x += vb.x; lv.y += vb.y; lv.z += vb.z;
      // advance ratio along the thrust axis (+Y): climbing / flying into the disc lowers thrust
      const n = Math.abs(w0) / (2 * Math.PI);
      const J = n > 1 && w0 > 0 ? lv.y / (n * D) : 0;
      this.kt[i] = Math.max(0, Math.min(1.25, 1 - J / m.J0));
      this.kq[i] = m.kQ0 * Math.max(0.2, Math.min(1.3, 1 - (0.6 * J) / m.J0));
    }
    // pusher first: its pack current loads the same battery as the lift motors
    const pu = this.pusher;
    if (pu) pu.step(dt, pusherCmd, fc.armed, -vb.z, this.battery.vbus, m.vNominal);
    this.motors.step(dt, cmd, fc.armed, this.kq, pu ? pu.current : 0);

    const F = this.force, T = this.torque;
    F.x = F.y = F.z = 0; T.x = T.y = T.z = 0;
    let spinSum = 0;
    for (let i = 0; i < m.rotors.length; i++) {
      const r = m.rotors[i];
      const w = this.omega[i];
      const lv = cross3(this.tmp2, wb, r.pos);
      lv.x += vb.x; lv.y += vb.y; lv.z += vb.z;
      // VRS / prop wash: sinking into the own wake along the thrust axis (PHYSICS.md 3.4)
      const vrs = w > 0 ? vrsIntensity(-lv.y / this.vh, muBody) : 0;
      const nT = this.vrsT[i].step(dt), nX = this.vrsX[i].step(dt), nZ = this.vrsZ[i].step(dt);
      if (vrs > vrsMax) vrsMax = vrs;
      let thrust = m.kT0 * w * Math.abs(w) * this.geFactor[i] * m.ductGain;
      if (w > 0) thrust *= this.kt[i] * wakeFactor(r.pos.x, r.pos.z, vb.x, vb.z) * (1 - VRS_THRUST_LOSS * vrs) * (1 + VRS_THRUST_NOISE * vrs * nT);
      else thrust *= m.reverseEff; // reversed prop (turtle): inverted airfoil, weak and downward
      const Q = this.kq[i] * w * Math.abs(w);
      this.tele.thrust[i] = thrust;
      // thrust along +Y at rotor position: torque r x (0,T,0) = (-z T, 0, x T)
      F.y += thrust;
      T.x += -r.pos.z * thrust;
      T.z += r.pos.x * thrust;
      // buffeting torque of the wake (random in-plane axis per rotor)
      if (vrs > 0) {
        const tq = VRS_TORQUE_NOISE * this.hoverThrust * vrs;
        T.x += tq * nX; T.z += tq * nZ;
      }
      // rotor drag / H-force: opposes in-plane airflow, proportional to rotor speed
      const aw = Math.abs(w);
      F.x += -m.kH * aw * lv.x;
      F.z += -m.kH * aw * lv.z;
      // reaction torques: aerodynamic drag torque + rotor acceleration (CW rotor -> body torque +Y)
      T.y += r.spin * (Q + m.Jr * this.omegaDot[i]);
      spinSum += -r.spin * w; // rotor angular momentum along +Y (CW = -Y)
    }
    this.tele.vrs = vrsMax;
    const n = m.rotors.length;
    for (let i = 0; i < n; i++) { this.visOmega[i] = this.omega[i]; this.visThrust[i] = this.tele.thrust[i]; }
    if (pu) { pu.apply(F, T, wb); this.visOmega[n] = pu.omega; this.visThrust[n] = pu.thrust; }
    if (wing) { wing.actuate(dt); wing.apply(F, T, vb, wb, RHO); }
    this.launchAndRecovery(dt, F, T, vb);
    // gyroscopic torque of the rotors: -w x (Jr * spinSum * Y)
    const hy = m.Jr * spinSum;
    T.x += wb.z * hy;   // -(wb x (0,hy,0)).x = -(wb.y*0 - wb.z*hy)
    T.z += -wb.x * hy;  // -(wb.x*hy - wb.y*0)

    // body drag, per axis in body frame
    const q = 0.5 * RHO * Math.hypot(vb.x, vb.y, vb.z);
    F.x -= q * m.cdA.x * vb.x;
    F.y -= q * m.cdA.y * vb.y;
    F.z -= q * m.cdA.z * vb.z;
    // small aerodynamic rotational damping
    const kd = 2e-6 * (m.diameter / 0.13) ** 4;
    T.x -= kd * wb.x * Math.abs(wb.x); T.y -= kd * wb.y * Math.abs(wb.y); T.z -= kd * wb.z * Math.abs(wb.z);
    // Rapier does not integrate the gyroscopic term of the body itself: add -w x (I w)
    const I = m.inertia;
    T.x -= wb.y * (I.z * wb.z) - wb.z * (I.y * wb.y);
    T.y -= wb.z * (I.x * wb.x) - wb.x * (I.z * wb.z);
    T.z -= wb.x * (I.y * wb.y) - wb.y * (I.x * wb.x);

    this.tele.airspeed = Math.hypot(vb.x, vb.y, vb.z);
  }

  private fillNav(s: BodyState, up: V3, env: Environment): NavInput {
    const n = this.navIn;
    n.pos = s.pos; n.vel = s.vel; n.rot = s.rot; n.up = up; n.groundDist = this.tele.groundDist; n.ray = env.ray;
    return n;
  }

  /** Rail booster (thrust along the nose through the CG) and the recovery parachute (drag at the riser point,
   *  the airframe hangs below it; the canopy area grows with the square of the opening, i.e. reefed). */
  private launchAndRecovery(dt: number, F: V3, T: V3, vb: V3) {
    const p = this.model.preset;
    if (this.boosterLeft > 0) { F.z -= p.launch!.booster_thrust_n; this.boosterLeft = Math.max(0, this.boosterLeft - dt); }
    if (!this.chuteOpen || !p.recovery) return;
    if (this.plane?.phase === 'landed') { this.chute = -1; return; } // released on touchdown
    if (this.chute < 0) return;
    const r = p.recovery;
    this.chute = Math.min(1, this.chute + dt / r.deploy_s);
    const k = -0.5 * RHO * Math.hypot(vb.x, vb.y, vb.z) * r.parachute_cdA * this.chute * this.chute;
    const fx = k * vb.x, fy = k * vb.y, fz = k * vb.z, [ax, ay, az] = r.attach;
    F.x += fx; F.y += fy; F.z += fz;
    T.x += ay * fz - az * fy; T.y += az * fx - ax * fz; T.z += ax * fy - ay * fx;
  }

  /** Gyro in FC axes with white noise and residual motor vibration (harmonic at each rotor's frequency). */
  private readGyro(dt: number, wb: V3) {
    const g = this.gyro, m = this.model;
    let vx = 0, vz = 0;
    for (let i = 0; i < this.omega.length; i++) {
      const w = this.omega[i];
      this.phase[i] = (this.phase[i] + w * dt) % (2 * Math.PI);
      const a = this.vib * (w / m.omegaMax) ** 2;
      vx += a * Math.sin(this.phase[i]); vz += a * Math.cos(this.phase[i]);
    }
    // roll+ right (-wz), pitch+ nose down (-wx), yaw+ nose right (-wy)
    g[0] = -wb.z + vz + this.gyroNoise * this.gauss.next();
    g[1] = -wb.x + vx + this.gyroNoise * this.gauss.next();
    g[2] = -wb.y + this.gyroNoise * this.gauss.next();
  }
}

const UP = v3(0, 1, 0), DOWN = v3(0, -1, 0);
const NAV_FC = ['gps_consumer', 'px4', 'ardupilot'];
function subWind(o: V3, v: V3, w: V3): V3 { o.x = v.x - w.x; o.y = v.y - w.y; o.z = v.z - w.z; return o; }
function cross3(o: V3, a: V3, b: V3): V3 {
  o.x = a.y * b.z - a.z * b.y; o.y = a.z * b.x - a.x * b.z; o.z = a.x * b.y - a.y * b.x; return o;
}
