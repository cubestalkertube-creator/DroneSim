// PX4-like quadplane controller (PHYSICS.md 5.2 "VTOL Transition"): standard_vtol = 4 lift rotors + pusher + wing.
//   mc        multicopter: PositionFC (GPS position/altitude cascade) over the Betaflight-style rate loop
//   trans_fw  front transition: lift rotors hold altitude and a level attitude, the pusher runs at full power;
//             once the airspeed passes transition_airspeed the FW controller takes over and the lift rotors
//             ramp down over transition_ramp_s; no airspeed within the timeout -> back to MC (PX4 behaviour)
//   fw        fixed wing: PlaneFC (FW position = cruise, mission = waypoints, RTL = home, then back-transition)
//   trans_mc  back transition: pusher off, lift rotors on, the position controller brakes from the current
//             velocity (nose-up braking tilt) and hovers; "quad-chute" if the FW airspeed decays below the stall
import { DEG } from '../math';
import type { DroneModel } from '../presets';
import type { Sticks } from './betaflight';
import type { PlaneFC, PlaneInput } from './plane';
import type { NavInput, PositionFC } from './position';

export type VtolPhase = 'mc' | 'trans_fw' | 'fw' | 'trans_mc';

const FW_MODES = ['fw_position', 'mission', 'transition'];
const TRANSITION_TIMEOUT = 15;     // s: no transition airspeed by then -> abort (PX4 VT_TRANS_TIMEOUT)
const TRANSITION_TILT = 0.15;      // fraction of the MC tilt the pilot keeps for roll during the transition
const BACK_DONE_SPEED = 2.5;       // m/s ground speed: back transition finished
const RTL_BACK_DIST_K = 1.6;       // back-transition this many braking distances before home
const QUADCHUTE_SPEED = 0.85;      // x V_stall in FW -> emergency back transition
const BACK_TILT = 30 * DEG;        // back transition: nose-up braking tilt allowed once slow (none at V_trans:
                                   // the wing would balloon), PX4 decelerates on drag first (VT_B_DEC_MSS)

export interface VtolOutput {
  /** virtual sticks for the lift rotors' rate loop, null when the lift rotors are off */
  mc: Sticks | null;
  /** lift rotor command multiplier 0..1 (ramp-down during the front transition) */
  lift: number;
  pusher: number; elevL: number; elevR: number;
}

export class VtolFC {
  readonly modes: string[];
  mode: string;
  phase: VtolPhase = 'mc';
  /** front transition progress: time since start, lift ramp 0..1 (1 = lift rotors off) */
  transT = 0; ramp = 0;
  /** HUD note of the last automatic event (abort, quad-chute) */
  event = '';
  private readonly vTrans: number; private readonly rampS: number; private readonly backS: number;
  private backT = 0;
  private out: VtolOutput = { mc: null, lift: 1, pusher: 0, elevL: 0, elevR: 0 };
  private mcIn: Sticks = { throttle: 0.5, roll: 0, pitch: 0, yaw: 0 };
  private wasArmed = false;

  constructor(private readonly model: DroneModel, readonly nav: PositionFC, readonly plane: PlaneFC) {
    const fc = model.preset.fc;
    this.modes = fc.modes.filter((m) => m !== 'transition');
    this.mode = this.modes.includes(fc.default_mode) ? fc.default_mode : this.modes[0];
    this.vTrans = fc.transition_airspeed ?? 15;
    this.rampS = fc.transition_ramp_s ?? 2;
    this.backS = fc.back_transition_s ?? 8;
  }

  get label() {
    if (this.phase === 'trans_fw') return 'TRANSITION';
    if (this.phase === 'trans_mc') return 'BACK TRANSITION';
    return this.phase === 'fw' ? this.plane.label : this.nav.label;
  }
  get centredThrottle() { return true; }
  get inFw() { return this.phase === 'fw' || this.phase === 'trans_fw'; }

  reset() { this.nav.pitchUpLimit = null; this.nav.override = null; this.phase = 'mc'; this.mode = this.modes.includes(this.model.preset.fc.default_mode) ? this.model.preset.fc.default_mode : this.modes[0]; this.transT = this.ramp = this.backT = 0; this.event = ''; this.wasArmed = false; }

  setMode(m: string) {
    if (m === 'transition') m = 'fw_position';
    if (!this.modes.includes(m)) return;
    const fw = FW_MODES.includes(m);
    if (fw && this.phase === 'mc') {
      if (this.nav.landed) { this.event = 'Сначала взлёт'; return; }
      this.startFront();
    } else if (!fw && m !== 'rtl' && this.inFw) this.startBack();
    this.mode = m;
    if (m === 'rtl') {
      if (this.phase === 'mc' || this.phase === 'trans_mc') this.nav.setMode('rtl'); else this.plane.setMode('rtl');
    } else if (m === 'mc_position') this.nav.setMode('mc_position');
    else this.plane.setMode(m);
  }
  nextMode() { this.setMode(this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length]); }

  private startFront() { this.phase = 'trans_fw'; this.transT = 0; this.ramp = 0; this.event = ''; }
  private startBack() { this.phase = 'trans_mc'; this.backT = 0; this.backStart = true; }
  private backStart = false;

  step(dt: number, sticks: Sticks, nav: NavInput, pin: PlaneInput, armed: boolean): VtolOutput {
    const o = this.out, nv = this.nav, pl = this.plane;
    if (armed && !this.wasArmed) { pl.setHome(nav.pos); pl.armed = true; }
    if (!armed) pl.armed = false;
    this.wasArmed = armed;
    o.elevL = o.elevR = 0; o.pusher = 0; o.lift = 1; o.mc = null;

    if (this.phase === 'trans_fw') {
      this.transT += dt;
      nv.override = 'alt';
      const s = this.mcIn;
      s.throttle = 0.5; s.roll = sticks.roll * TRANSITION_TILT; s.pitch = 0; s.yaw = 0;
      o.mc = nv.step(dt, s, nav);
      o.pusher = 1;
      const fwOut = pl.step(dt, sticks, pin, true);
      // the wing takes over gradually: control surfaces fade in with the airspeed
      const k = Math.min(1, Math.max(0, pl.airspeed / this.vTrans));
      o.elevL = fwOut.elevL * k; o.elevR = fwOut.elevR * k;
      if (pl.airspeed >= this.vTrans) {
        if (this.ramp === 0) pl.engage(pin);
        this.ramp = Math.min(1, this.ramp + dt / this.rampS);
        o.lift = 1 - this.ramp;
        o.pusher = fwOut.throttle * this.ramp + (1 - this.ramp);
        o.elevL = fwOut.elevL; o.elevR = fwOut.elevR;
        if (this.ramp >= 1) { this.phase = 'fw'; nv.override = null; if (this.mode === 'mc_position') this.mode = 'fw_position'; }
      } else if (this.transT > TRANSITION_TIMEOUT) {
        this.event = 'Переход прерван: нет скорости'; this.mode = 'mc_position'; this.startBack();
      }
      return o;
    }
    if (this.phase === 'fw') {
      o.lift = 0;
      const fwOut = pl.step(dt, sticks, pin, true);
      o.elevL = fwOut.elevL; o.elevR = fwOut.elevR; o.pusher = fwOut.throttle;
      // mission end / RTL near home -> back transition, MC return and landing
      const brake = (pl.airspeed * pl.airspeed) / (2 * 9.80665 * Math.tan(25 * DEG));
      if (this.mode === 'mission' && pl.routeDone) { this.mode = 'rtl'; pl.setMode('rtl'); }
      if (this.mode === 'rtl' && pl.distHome < RTL_BACK_DIST_K * brake + 30) { this.startBack(); nv.setMode('rtl'); }
      if (pl.airspeed < QUADCHUTE_SPEED * pl.vStall) { this.event = 'Quad-chute: скорость ниже сваливания'; this.mode = 'mc_position'; nv.setMode('mc_position'); this.startBack(); }
      return o;
    }
    if (this.phase === 'trans_mc') {
      if (this.backStart) { nv.resume(nav.vel); nv.override = null; this.backStart = false; }
      this.backT += dt;
      pl.step(dt, sticks, pin, true); // keeps the FW telemetry (airspeed) current
      // pilot sticks centred for the brake; the wing keeps level-ish attitude through the rate loop
      const s = this.mcIn;
      s.throttle = 0.5; s.roll = 0; s.pitch = 0; s.yaw = 0;
      const r = Math.min(1, pl.airspeed / this.vTrans);
      nv.pitchUpLimit = BACK_TILT * (1 - r * r);
      o.mc = nv.step(dt, s, nav);
      if (Math.hypot(nav.vel.x, nav.vel.z) < BACK_DONE_SPEED || this.backT > this.backS) {
        this.phase = 'mc'; nv.pitchUpLimit = null;
        if (this.mode !== 'rtl') this.mode = 'mc_position';
      }
      return o;
    }
    nv.override = null;
    o.mc = nv.step(dt, sticks, nav);
    return o;
  }
}
