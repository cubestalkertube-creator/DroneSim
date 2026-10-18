// Input -> ControlFrame (PLAN.md 5). Keyboard with analog emulation, mouse-as-right-stick, gamepads and
// RC transmitters in USB-joystick mode (Gamepad API). Edge-triggered actions are queued for the game.
import type { Sticks } from '../sim/fc/betaflight';
import type { TouchControls } from './touch';
import { settings, type AuxFn, type KnobFn, type PadProfile } from '../core/settings';
import { axisValue, calState, knobValue, shape, switchOn, switchPos } from './calibration';
import { builtinProfile, isRC as rcPad } from './radios';

export type Action = 'arm' | 'reset' | 'camera' | 'mode_acro' | 'mode_angle' | 'mode_horizon' | 'pause' | 'next_spawn'
  | 'uptilt_up' | 'uptilt_down' | 'fov' | 'debug' | 'help' | 'mouse' | 'props' | 'turtle' | 'mode_next' | 'mute' | 'mode_4' | 'rth' | 'land' | 'motor_fail'
  /** kamikaze presets: set the charge off */
  | 'detonate'
  /** transmitter switches are levels: the game arms / flips turtle / returns home only if the state differs */
  | 'arm_on' | 'arm_off' | 'turtle_on' | 'turtle_off' | 'rth_on' | 'rth_off'
  /** a multi-position camera switch: FPV / chase / from the ground by position */
  | 'cam_0' | 'cam_1' | 'cam_2';

export type Device = 'keyboard' | 'mouse' | 'gamepad' | 'rc' | 'touch';

const KEY_ACTIONS: Record<string, Action> = {
  Space: 'arm', KeyR: 'reset', KeyC: 'camera', Digit1: 'mode_acro', Digit2: 'mode_angle', Digit3: 'mode_horizon',
  Escape: 'pause', KeyN: 'next_spawn', KeyV: 'uptilt_up', KeyB: 'uptilt_down', KeyF: 'fov', F3: 'debug', KeyH: 'help', KeyM: 'mouse', KeyP: 'props', KeyT: 'turtle', KeyU: 'mute', Digit4: 'mode_4', KeyG: 'land', KeyK: 'motor_fail', KeyE: 'detonate',
};
/** edge-triggered functions of switches / buttons (arm, mode and on a transmitter turtle / RTH are levels) */
const AUX_ACTION: Partial<Record<AuxFn, Action>> = {
  turtle: 'turtle', reset: 'reset', camera: 'camera', rth: 'rth', land: 'land', pause: 'pause', next_spawn: 'next_spawn', fov: 'fov', mute: 'mute', detonate: 'detonate',
};
const LEVEL: Partial<Record<AuxFn, [Action, Action]>> = { arm: ['arm_on', 'arm_off'], turtle: ['turtle_on', 'turtle_off'], rth: ['rth_on', 'rth_off'] };
const MODE_ACTIONS: Action[] = ['mode_acro', 'mode_angle', 'mode_horizon'];
const CAM_ACTIONS: Action[] = ['cam_0', 'cam_1', 'cam_2'];

/** Text fields (rates CLI, settings) keep their keys. */
const typing = (e: Event) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };

const approach = (v: number, target: number, rate: number, dt: number) =>
  v < target ? Math.min(target, v + rate * dt) : Math.max(target, v - rate * dt);

export class InputManager {
  readonly sticks: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  device: Device = 'keyboard';
  gamepadName = '';
  mouseMode = false;
  /** throttle for keyboard; self-centering (GPS-style) is not needed in stage 1 */
  private keys = new Set<string>();
  private actions: Action[] = [];
  private mouse = { x: 0, y: 0 };
  private padPrev: boolean[] = [];
  rawAxes: number[] = [];
  rawButtons: boolean[] = [];
  /** id of the connected gamepad / transmitter and whether a calibration profile is applied */
  padId = ''; calibrated = false;
  /** name of the built-in transmitter profile in use (no calibration yet), else '' */
  builtin = '';
  /** last level of switches (arm / mode) and edge state of the others */
  private aux: Partial<Record<AuxFn, number>> = {};
  /** knob functions 0..1 (camera tilt, volume) of the active profile; absent when not assigned */
  knobs: Partial<Record<KnobFn, number>> = {};
  /** GPS drones: the throttle stick is a self-centring climb-rate stick (0.5 = hold altitude) */
  throttleCentered = false;
  /** mouse wheel ticks since the last read (gimbal tilt when the mouse is not a stick) */
  wheel = 0;
  /** virtual sticks on phones/tablets (hidden while a gamepad / RC is in use) */
  touch: TouchControls | null = null;

  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat || typing(e)) return;
      this.keys.add(e.code);
      const a = KEY_ACTIONS[e.code];
      if (a) { this.actions.push(a); e.preventDefault(); }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      this.device = this.mouseMode ? 'mouse' : 'keyboard';
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('mousemove', (e) => {
      if (!this.mouseMode || document.pointerLockElement !== el) return;
      this.mouse.x += e.movementX * 0.004;
      this.mouse.y += e.movementY * 0.004;
    });
    el.addEventListener('wheel', (e) => {
      if (this.mouseMode && !this.throttleCentered) this.sticks.throttle = Math.min(1, Math.max(0, this.sticks.throttle - e.deltaY * 0.0006));
      else this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== el) this.mouseMode = false; });
  }

  takeActions(): Action[] { const a = this.actions; this.actions = []; return a; }
  /** re-send position switches (mode, camera) on the next poll: the flight follows the switch again after a pause */
  resyncSwitches(fns: AuxFn[]) { for (const f of fns) delete this.aux[f]; }
  push(a: Action) { this.actions.push(a); }

  toggleMouse() {
    this.mouseMode = !this.mouseMode;
    if (this.mouseMode) this.el.requestPointerLock?.(); else document.exitPointerLock?.();
    this.mouse.x = this.mouse.y = 0;
  }

  update(dt: number) {
    const pad = this.pollGamepads();
    const t = this.touch;
    if (t?.enabled && !pad) { t.apply(this.sticks); this.device = 'touch'; return; }
    if (pad) return;
    const k = this.keys, s = this.sticks;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 2 : 1;
    const fine = k.has('ControlLeft') || k.has('ControlRight') ? 0.45 : 1;
    const axis = (neg: string[], pos: string[]) => (pos.some((c) => k.has(c)) ? 1 : 0) - (neg.some((c) => k.has(c)) ? 1 : 0);
    // throttle: W/S move it and it stays (non-centering like a real FPV throttle)
    const thr = axis(['KeyS'], ['KeyW']);
    if (this.throttleCentered) {
      // GPS: spring-centred stick, W/S = climb / descend
      s.throttle = approach(s.throttle, 0.5 + 0.5 * thr * fine, thr ? 2.5 * fast : 4, dt);
    } else {
      s.throttle = Math.min(1, Math.max(0, s.throttle + thr * 0.75 * fast * fine * dt));
      if (k.has('KeyX')) s.throttle = 0; // throttle cut
    }
    const rate = 5 * fast * fine, back = 7;
    const yaw = axis(['KeyA'], ['KeyD']) * fine;
    s.yaw = approach(s.yaw, yaw, yaw ? rate : back, dt);
    if (this.mouseMode) {
      this.mouse.x *= Math.exp(-dt * 2.5); // spring back to centre
      this.mouse.y *= Math.exp(-dt * 2.5);
      this.mouse.x = Math.max(-1, Math.min(1, this.mouse.x));
      this.mouse.y = Math.max(-1, Math.min(1, this.mouse.y));
      s.roll = this.mouse.x; s.pitch = -this.mouse.y;
      this.device = 'mouse';
    } else {
      const pitch = axis(['ArrowDown', 'KeyK'], ['ArrowUp', 'KeyI']) * fine;
      const roll = axis(['ArrowLeft', 'KeyJ'], ['ArrowRight', 'KeyL']) * fine;
      s.pitch = approach(s.pitch, pitch, pitch ? rate : back, dt);
      s.roll = approach(s.roll, roll, roll ? rate : back, dt);
    }
  }

  /** Returns true when a gamepad/RC is the active device this frame. */
  private pollGamepads(): boolean {
    const pad = activePad();
    if (!pad) { this.gamepadName = ''; this.padId = ''; this.calibrated = false; return false; }
    this.rawAxes = Array.from(pad.axes);
    this.rawButtons = pad.buttons.map((b) => b.pressed);
    this.padId = pad.id;
    this.gamepadName = padName(pad.id);
    if (calState.active) return false;
    const moved = pad.axes.some((a) => Math.abs(a) > 0.2) || pad.buttons.some((b) => b.pressed);
    if (!moved && this.device !== 'gamepad' && this.device !== 'rc') return false;
    const isRC = rcPad(pad);
    this.device = isRC ? 'rc' : 'gamepad';
    const ctl = settings.value.controls, own = ctl.pads[pad.id];
    const builtin = own ? null : builtinProfile(pad);
    const prof = own ?? builtin?.profile;
    this.calibrated = !!own; this.builtin = builtin?.name ?? '';
    const s = this.sticks;
    if (prof) {
      // calibrated (settings -> Controls -> Calibrate) or a built-in transmitter profile: any channel order / direction
      const ax = this.rawAxes, A = prof.axes;
      s.throttle = axisValue(ax[A.throttle.index] ?? 0, A.throttle, true);
      s.yaw = shape(axisValue(ax[A.yaw.index] ?? 0, A.yaw, false), ctl.deadzone, ctl.expo);
      s.pitch = shape(axisValue(ax[A.pitch.index] ?? 0, A.pitch, false), ctl.deadzone, ctl.expo);
      s.roll = shape(axisValue(ax[A.roll.index] ?? 0, A.roll, false), ctl.deadzone, ctl.expo);
      this.applySwitches(prof, isRC);
      this.knobs = {};
      for (const [fn, k] of Object.entries(prof.knobs ?? {}) as [KnobFn, NonNullable<PadProfile['axes']['yaw']>][]) this.knobs[fn] = knobValue(ax[k.index] ?? 0, k);
      if (pad.mapping === 'standard') this.padButtons(pad, new Set(Object.values(prof.aux).filter((x) => x.kind === 'button').map((x) => x.index)));
      return true;
    }
    // Standard gamepad, Mode 2: left stick throttle (centre = 50%) / yaw, right stick pitch / roll
    const dz = (v: number, d: number) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
    s.yaw = dz(pad.axes[0], 0.08); s.throttle = Math.min(1, Math.max(0, (1 - pad.axes[1]) / 2));
    s.roll = dz(pad.axes[2], 0.06); s.pitch = dz(-pad.axes[3], 0.06);
    this.knobs = {};
    this.padButtons(pad, new Set());
    return true;
  }

  /**
   * Switch / button functions. Levels (arm, mode; turtle and RTH on a transmitter) send their state when it changes,
   * the rest fire when switched ON. Nothing fires on the first poll: a switch left ON must be flipped again.
   */
  private applySwitches(prof: PadProfile, levels: boolean) {
    const ax = this.rawAxes, bt = this.rawButtons;
    for (const [fn, sw] of Object.entries(prof.aux) as [AuxFn, NonNullable<PadProfile['aux']['arm']>][]) {
      const prev = this.aux[fn];
      // position switches: the mode (any switch but a plain button), the camera view (a transmitter switch)
      if ((fn === 'mode' && sw.kind !== 'button') || (fn === 'camera' && levels && sw.kind === 'buttons')) {
        const pos = switchPos(sw, ax, bt);
        if (pos < 0) continue; // between the positions of a button group
        if (pos !== prev) this.actions.push((fn === 'mode' ? MODE_ACTIONS : CAM_ACTIONS)[Math.min(pos, 2)]);
        this.aux[fn] = pos; continue;
      }
      const on = switchOn(sw, ax, bt) ? 1 : 0;
      const lv = LEVEL[fn];
      if (lv && (fn === 'arm' || levels)) { if (on !== prev && prev !== undefined) this.actions.push(on ? lv[0] : lv[1]); }
      else if (on && !prev && prev !== undefined) { const a = fn === 'mode' ? 'mode_next' : AUX_ACTION[fn]; if (a) this.actions.push(a); }
      this.aux[fn] = on;
    }
  }

  /** Standard gamepad buttons: A arm, B restart, X Angle, Y camera, RB detonate (kamikaze), Start pause, Select next spawn (minus `skip`). */
  private padButtons(pad: Gamepad, skip: Set<number>) {
    const map: [number, Action][] = [[0, 'arm'], [1, 'reset'], [3, 'camera'], [2, 'mode_angle'], [9, 'pause'], [8, 'next_spawn'], [5, 'detonate']];
    for (const [b, a] of map) {
      const p = !!pad.buttons[b]?.pressed && !skip.has(b);
      if (p && !this.padPrev[b]) this.actions.push(a);
      this.padPrev[b] = p;
    }
  }
}

/** First connected gamepad with at least 4 axes (sticks). */
export function activePad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  return Array.from(pads).find((p): p is Gamepad => !!p && p.connected && p.axes.length >= 4) ?? null;
}

export const padName = (id: string) => id.replace(/\(.*?\)/g, '').trim().slice(0, 40) || 'Геймпад';

/** The profile a pad is read with: its own calibration, else the built-in transmitter profile (gamepads: none). */
export function padProfile(pad: Pick<Gamepad, 'id' | 'axes' | 'buttons' | 'mapping'>): PadProfile | undefined {
  return settings.value.controls.pads[pad.id] ?? builtinProfile(pad)?.profile;
}
