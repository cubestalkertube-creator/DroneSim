// RC / gamepad calibration (PLAN.md 5.3): raw Gamepad API axes -> calibrated channels, and the wizard that builds a
// PadProfile ("move all sticks to the extremes" -> centre -> which axis is throttle / yaw / pitch / roll and its
// direction -> arm and mode switches -> camera-tilt knob), like the Receiver/Modes tabs of Betaflight Configurator.
// Switches may come as axes (a channel), as buttons, or as a group of buttons, one per position (FlySky "emulator").
// Pure logic, no DOM.
import type { AuxFn, AxisCal, KnobFn, PadProfile, StickAxis, SwitchCal } from '../core/settings';

/** While the wizard (or switch assignment) listens, the flight and the menus must not react to the pad. */
export const calState = { active: false };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Calibrated stick value: throttle 0..1 (min..max of travel), the others -1..1 around the centre. */
export function axisValue(raw: number, a: AxisCal, throttle: boolean): number {
  if (throttle) {
    const t = a.max > a.min ? (raw - a.min) / (a.max - a.min) : 0;
    return clamp(a.invert ? 1 - t : t, 0, 1);
  }
  const d = raw - a.center;
  const span = d >= 0 ? a.max - a.center : a.center - a.min;
  const v = span > 1e-6 ? clamp(d / span, -1, 1) : 0;
  return a.invert ? -v : v;
}

/** Knob / slider value 0..1 over its calibrated travel. */
export const knobValue = (raw: number, a: AxisCal) => axisValue(raw, a, true);

/** Centre dead zone (rescaled so the travel stays 0..1) and cubic expo, as RC "expo" in the radio. */
export function shape(v: number, deadzone: number, expo: number): number {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const x = (Math.sign(v) * (a - deadzone)) / (1 - deadzone);
  return x * (1 - expo) + x * x * x * expo;
}

const pattern = (buttons: readonly boolean[], group: readonly number[]) => group.map((i) => (buttons[i] ? '1' : '0')).join('');

/**
 * Position of a multi-position switch: an axis -> 0 / 1 / 2 (towards `on`); a button group -> the index of the
 * matching pattern in `states` (-1 while between positions); a single button -> 0 released / 1 pressed.
 */
export function switchPos(s: SwitchCal, axes: readonly number[], buttons: readonly boolean[] = []): number {
  if (s.kind === 'buttons') return s.states && s.group ? s.states.indexOf(pattern(buttons, s.group)) : -1;
  if (s.kind === 'button') return buttons[s.index] ? 1 : 0;
  const v = (axes[s.index] ?? 0) * Math.sign(s.on || 1);
  return v < -0.33 ? 0 : v < 0.33 ? 1 : 2;
}

/** Is the switch ON: axis on the `on` side of zero, button pressed (released if `on` is 0), group in position `on`. */
export function switchOn(s: SwitchCal, axes: readonly number[], buttons: readonly boolean[]): boolean {
  if (s.kind === 'button') return !!buttons[s.index] === (s.on !== 0);
  if (s.kind === 'buttons') return switchPos(s, axes, buttons) === s.on;
  return (axes[s.index] ?? 0) * Math.sign(s.on || 1) > 0;
}

/**
 * The control (axis or button) that changed most since `base`, if it changed enough to be a deliberate flip.
 * A pressed button wins, then a released one (radios that hold a button while a switch is in a position).
 * Axes in `exclude` (the sticks) are ignored.
 */
export function detectSwitch(base: readonly number[], baseBtn: readonly boolean[], axes: readonly number[], buttons: readonly boolean[],
  exclude: ReadonlySet<number>, minDelta = 0.9): SwitchCal | null {
  for (let i = 0; i < buttons.length; i++) if (buttons[i] && !baseBtn[i]) return { kind: 'button', index: i, on: 1 };
  for (let i = 0; i < buttons.length; i++) if (!buttons[i] && baseBtn[i]) return { kind: 'button', index: i, on: 0 };
  let best = -1, bd = 0;
  for (let i = 0; i < axes.length; i++) {
    if (exclude.has(i)) continue;
    const d = Math.abs(axes[i] - (base[i] ?? 0));
    if (d > bd) { bd = d; best = i; }
  }
  if (best < 0 || bd < minDelta) return null;
  const v = axes[best];
  // an axis switch: ON is the side it was flipped to (a 3-position mode switch: the end it moves towards)
  return { kind: 'axis', index: best, on: Math.sign(v - base[best]) || 1 };
}

/** a button pattern must hold this many samples (~100 ms at 30 Hz) to count as a switch position */
const STABLE = 3;
const key = (b: readonly boolean[]) => b.map((x) => (x ? '1' : '0')).join('');

/**
 * Learns a multi-position (mode) switch: an axis that moves (3-position channel), or a group of buttons whose
 * stable patterns are the positions in the order the pilot flips through them (first = the starting one).
 * With `groups` off (standard gamepads) a button stays a plain button: the mode steps on every press.
 */
export class SwitchLearner {
  private changed = new Set<number>();
  private seen: string[];
  private cand = ''; private candN = 0;

  constructor(private base: readonly number[], private baseBtn: readonly boolean[], private exclude: ReadonlySet<number>, private groups = true) {
    this.seen = [key(baseBtn)];
  }

  /** @returns the switch once it is certain (an axis, a gamepad button, three button positions), else null */
  feed(axes: readonly number[], buttons: readonly boolean[]): SwitchCal | null {
    if (!this.changed.size) {
      const ax = detectSwitch(this.base, [], axes, [], this.exclude, 0.7);
      if (ax) return ax;
    }
    if (!this.groups) {
      const b = detectSwitch(this.base, this.baseBtn, [], buttons, this.exclude);
      return b?.on === 1 ? b : null;
    }
    for (let i = 0; i < buttons.length; i++) if (!!buttons[i] !== !!this.baseBtn[i]) this.changed.add(i);
    const k = key(buttons);
    if (k === this.cand) this.candN++; else { this.cand = k; this.candN = 1; }
    if (this.candN === STABLE && !this.seen.includes(k)) this.seen.push(k);
    const r = this.result();
    return r?.states && r.states.length >= 3 ? r : null;
  }

  /** What was learned so far (the pilot confirms a 2-position switch), or null. */
  result(): SwitchCal | null {
    if (!this.changed.size) return null;
    const group = [...this.changed].sort((a, b) => a - b);
    const states: string[] = [];
    for (const s of this.seen) { const p = group.map((i) => s[i] ?? '0').join(''); if (!states.includes(p)) states.push(p); }
    if (states.length < 2) return null;
    return { kind: 'buttons', index: group[0], on: states.length - 1, group, states };
  }
}

/** Learns a knob / slider: the free axis with the largest travel while the pilot turns it end to end. */
export class KnobLearner {
  private min: number[] = []; private max: number[] = [];
  constructor(private exclude: ReadonlySet<number>) {}
  feed(axes: readonly number[]) {
    for (let i = 0; i < axes.length; i++) {
      this.min[i] = Math.min(this.min[i] ?? axes[i], axes[i]);
      this.max[i] = Math.max(this.max[i] ?? axes[i], axes[i]);
    }
  }
  /** travel of the best candidate so far (raw units, full = 2) */
  get range(): number { const r = this.result(); return r ? r.max - r.min : 0; }
  result(): AxisCal | null {
    let best = -1, br = 0;
    for (let i = 0; i < this.min.length; i++) {
      if (this.exclude.has(i)) continue;
      const r = this.max[i] - this.min[i];
      if (r > br) { br = r; best = i; }
    }
    if (best < 0 || br < 0.5) return null;
    return { index: best, invert: false, min: this.min[best], max: this.max[best], center: (this.min[best] + this.max[best]) / 2 };
  }
}

/** Raw axes a profile already uses (sticks, axis switches, knobs): never a switch / knob candidate. */
export function usedAxes(p: { axes: Partial<Record<StickAxis, AxisCal>>; aux: PadProfile['aux']; knobs?: PadProfile['knobs'] }): Set<number> {
  const s = new Set<number>();
  for (const a of Object.values(p.axes)) if (a) s.add(a.index);
  for (const a of Object.values(p.aux)) if (a?.kind === 'axis') s.add(a.index);
  for (const a of Object.values(p.knobs ?? {})) if (a) s.add(a.index);
  return s;
}

export type CalStep = 'extremes' | 'center' | StickAxis | 'arm' | 'mode' | 'tilt' | 'done';
export const CAL_STEPS: CalStep[] = ['extremes', 'center', 'throttle', 'yaw', 'pitch', 'roll', 'arm', 'mode', 'tilt', 'done'];
/** a stick axis must travel at least this much (raw units, -1..1 range = 2) to count as a stick */
const MIN_RANGE = 0.8;
/** a requested stick move must cover this fraction of half the travel (centre -> end) to be detected */
const DETECT = 0.6;

/**
 * Step-by-step calibration. Feed `sample()` every frame; stick, arm and 3-position steps complete by themselves,
 * `next()` confirms the extremes / centre steps, saves a 2-position mode switch or a knob, or skips the step.
 */
export class CalibrationWizard {
  step: CalStep = 'extremes';
  min: number[] = []; max: number[] = [];
  center: number[] = [];
  last: number[] = []; lastBtn: boolean[] = [];
  private base: number[] = []; private baseBtn: boolean[] = [];
  readonly axes: Partial<Record<StickAxis, AxisCal>> = {};
  readonly aux: Partial<Record<AuxFn, SwitchCal>> = {};
  readonly knobs: Partial<Record<KnobFn, AxisCal>> = {};
  private learner: SwitchLearner | null = null;
  private knob: KnobLearner | null = null;

  /** `groups`: a switch may come as a group of buttons (transmitters; off for standard gamepads) */
  constructor(readonly id: string, private groups = true) {}

  /** axes that moved enough during the extremes step */
  get sticks(): number[] { return this.min.map((_, i) => i).filter((i) => this.max[i] - this.min[i] >= MIN_RANGE); }
  get canNext(): boolean {
    if (this.step === 'extremes') return this.sticks.length >= 4;
    return this.step === 'center' || this.step === 'arm' || this.step === 'mode' || this.step === 'tilt';
  }
  /** an optional step learned something: «Далее» saves it instead of skipping */
  get pending(): boolean {
    return this.step === 'mode' ? !!this.learner?.result() : this.step === 'tilt' ? !!this.knob?.result() : false;
  }
  /** knob travel seen in the tilt step (raw units, full = 2) */
  get knobRange(): number { return this.knob?.range ?? 0; }

  /** @returns true if the step changed */
  sample(axes: readonly number[], buttons: readonly boolean[]): boolean {
    this.last = [...axes]; this.lastBtn = [...buttons];
    for (let i = 0; i < axes.length; i++) {
      this.min[i] = Math.min(this.min[i] ?? axes[i], axes[i]);
      this.max[i] = Math.max(this.max[i] ?? axes[i], axes[i]);
    }
    const st = this.step;
    if (st === 'throttle' || st === 'yaw' || st === 'pitch' || st === 'roll') {
      const used = new Set(Object.values(this.axes).map((a) => a.index));
      let best = -1, bf = 0, bd = 0;
      for (const i of this.sticks) {
        if (used.has(i)) continue;
        const d = axes[i] - this.base[i], f = (2 * Math.abs(d)) / (this.max[i] - this.min[i]);
        if (f > bf) { bf = f; best = i; bd = d; }
      }
      if (best >= 0 && bf >= DETECT) {
        // requested direction: throttle up, yaw right, pitch forward (nose down), roll right -> positive channel
        const i = best;
        this.axes[st] = { index: i, invert: bd < 0, min: this.min[i], max: this.max[i], center: st === 'throttle' ? (this.min[i] + this.max[i]) / 2 : this.center[i] };
        this.advance();
        return true;
      }
    } else if (st === 'arm') {
      const sw = detectSwitch(this.base, this.baseBtn, axes, buttons, this.used());
      if (sw) { this.aux.arm = sw; this.advance(); return true; }
    } else if (st === 'mode') {
      const sw = this.learner?.feed(axes, buttons);
      if (sw) { this.aux.mode = sw; this.advance(); return true; }
    } else if (st === 'tilt') this.knob?.feed(axes);
    return false;
  }

  private used() { return usedAxes({ axes: this.axes, aux: this.aux, knobs: this.knobs }); }

  /** Confirm the extremes / centre step, save what the mode / tilt step learned, or skip it. */
  next() {
    if (!this.canNext) return;
    if (this.step === 'center') this.center = [...this.last];
    if (this.step === 'mode') { const r = this.learner?.result(); if (r) this.aux.mode = r; }
    if (this.step === 'tilt') { const r = this.knob?.result(); if (r) this.knobs.tilt = r; }
    this.advance();
  }

  private advance() {
    this.step = CAL_STEPS[CAL_STEPS.indexOf(this.step) + 1] ?? 'done';
    this.base = [...this.last]; this.baseBtn = [...this.lastBtn];
    // stick ranges keep growing while the pilot moves them: refresh the travel of already detected axes
    for (const a of Object.values(this.axes)) { a.min = Math.min(a.min, this.min[a.index]); a.max = Math.max(a.max, this.max[a.index]); }
    if (this.step === 'mode') this.learner = new SwitchLearner(this.base, this.baseBtn, this.used(), this.groups);
    if (this.step === 'tilt') this.knob = new KnobLearner(this.used());
  }

  /** The finished profile (all four stick axes found), else null. */
  result(): PadProfile | null {
    const { throttle, yaw, pitch, roll } = this.axes;
    if (!throttle || !yaw || !pitch || !roll) return null;
    return { id: this.id, axes: { throttle, yaw, pitch, roll }, aux: { ...this.aux }, knobs: { ...this.knobs } };
  }
}
