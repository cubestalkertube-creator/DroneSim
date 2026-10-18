// Built-in profiles of transmitters in USB-joystick mode (PLAN.md 5.3): the radio works out of the box, a calibration
// from Settings -> Controls replaces the profile. Unknown radios get the EdgeTX/OpenTX default (AETR, AUX1 arm,
// AUX2 3-position mode). Pure data + logic, no DOM.
import type { KnobFn, PadProfile, SwitchCal } from '../core/settings';

interface PadLike { id: string; axes: readonly unknown[]; buttons: readonly unknown[]; mapping: string }

/** Transmitters in USB HID mode (Gamepad.id), told apart from gamepads with a non-standard mapping. */
export const RC_ID = /tx\d|radiomaster|edgetx|opentx|jumper|frsky|tbs|tango|radio|joystick|betaflight|expresslrs|elrs|fs-i6|flysky|fs-th9x|fs-i10|turnigy|futaba|spektrum|radiolink|walksnail|emulator|simulator/i;

export const isRC = (pad: Pick<PadLike, 'id' | 'mapping'>) => pad.mapping !== 'standard' && RC_ID.test(pad.id);

/** Full stick travel `t` (raw units) around the centre. */
const axis = (index: number, t: number, invert = false) => ({ index, invert, min: -t, center: 0, max: t });

/** A 3-position switch reported as two buttons: `up` pressed, none in the middle, `down` pressed. */
const pos3 = (up: number, down: number): SwitchCal => {
  const group = [Math.min(up, down), Math.max(up, down)];
  const st = (b: number) => group.map((i) => (i === b ? '1' : '0')).join('');
  return { kind: 'buttons', index: group[0], on: 2, group, states: [st(up), '00', st(down)] };
};

export interface Builtin {
  name: string; profile: PadProfile; notes: string;
  /** what the pilot sees on the radio for a raw axis / button (switch names) */
  axisNames?: Record<number, string>; buttonNames?: Record<number, string>;
  /** spare channels that become knobs once they show analog values (a knob assigned to them in the radio) */
  autoKnobs?: Partial<Record<number, KnobFn>>;
}

/**
 * Spare channels seen carrying a knob: a value held between the switch levels (-1 / 0 / +1 of the travel) for
 * ~100 ms. A switch only passes through such values, a knob stays there. Kept for the session, per device.
 */
const analog = new Set<string>();
const run = new Map<string, { v: number; n: number }>();
const LEVELS = [-0.835, 0, 0.827];
export function observeAnalog(pad: Pick<PadLike, 'id' | 'axes'>, axes: Iterable<number>) {
  for (const i of axes) {
    const k = `${pad.id}#${i}`, v = Number(pad.axes[i] ?? 0);
    if (analog.has(k)) continue;
    const r = run.get(k);
    const off = LEVELS.every((l) => Math.abs(v - l) > 0.08);
    if (off && r && Math.abs(r.v - v) < 0.02) { if (++r.n >= 6) analog.add(k); } else run.set(k, { v, n: off ? 1 : 0 });
  }
}

/**
 * FlySky FS-i6S, System -> USB function -> emulator ("FS-i6S emulator", VID 284e PID 7fff): 6 axes with 8-bit
 * values where 1000..2000 us maps to about -0.835..+0.827, and 10 buttons that mirror the switch positions:
 *   axes 0..3 = CH1..CH4 (aileron, elevator, throttle, rudder; elevator forward and rudder right go negative),
 *   4 = CH5 (by default SwC, 3-pos), 5 = CH6 (SwD, 2-pos) — whatever the radio's Aux channels put there;
 *   buttons: 0 SwA (pressed = up), 1/2 SwB (2 = up, none = middle, 1 = down), 3/4 SwC (4 up, 3 down),
 *   5 SwD down, 6 Key1, 7 Key2 (momentary). Measured on a real radio (winmm + Gamepad API).
 * The switches are read from the buttons (always there, whatever CH5/CH6 carry), left to right:
 * SwA arm, SwB flight mode, SwC camera view, SwD turtle / RTH; the keys on the back restart and pause.
 */
function flyskyI6S(id: string): Builtin {
  const T = 0.82; // 21..233 of 0..255 = -0.835..+0.827: a bit less, so the stick ends always reach full travel
  return {
    name: 'FlySky FS-i6S',
    notes: 'SwA вниз — ARM (газ в ноль). SwB — режим: вверх Acro · середина Angle · вниз Horizon (у GPS-дронов — их режимы). SwC — камера: вверх FPV · середина 3-е лицо · вниз с земли. SwD вниз — Turtle (FPV) / домой (GPS). Сзади: Key1 — рестарт, Key2 — пауза.',
    axisNames: { 4: 'CH5', 5: 'CH6' },
    autoKnobs: { 4: 'tilt', 5: 'volume' },
    buttonNames: { 0: 'SwA', 1: 'SwB', 2: 'SwB', 3: 'SwC', 4: 'SwC', 5: 'SwD', 6: 'Key1', 7: 'Key2' },
    profile: {
      id,
      axes: { roll: axis(0, T), pitch: axis(1, T, true), throttle: axis(2, T), yaw: axis(3, T, true) },
      aux: {
        arm: { kind: 'button', index: 0, on: 0 },
        mode: pos3(2, 1),
        camera: pos3(4, 3),
        turtle: { kind: 'button', index: 5, on: 1 },
        rth: { kind: 'button', index: 5, on: 1 },
        reset: { kind: 'button', index: 6, on: 1 },
        pause: { kind: 'button', index: 7, on: 1 },
      },
    },
  };
}

/** EdgeTX / OpenTX "USB Joystick (HID)" default: CH1..CH4 = AETR, CH5 = arm, CH6 = 3-position mode. */
function edgeTx(pad: PadLike): Builtin {
  return {
    name: 'EdgeTX / OpenTX',
    notes: 'Раскладка по умолчанию: AETR, CH5 (AUX1) — ARM, CH6 (AUX2) — режимы. Если оси перепутаны — откалибруй.',
    profile: {
      id: pad.id,
      axes: { roll: axis(0, 1), pitch: axis(1, 1, true), throttle: axis(2, 1), yaw: axis(3, 1) },
      aux: {
        ...(pad.axes.length > 4 ? { arm: { kind: 'axis' as const, index: 4, on: 1 } } : {}),
        ...(pad.axes.length > 5 ? { mode: { kind: 'axis' as const, index: 5, on: 1 } } : {}),
      },
    },
  };
}

/** Built-in profile for a transmitter (null for gamepads: they keep the Mode 2 gamepad layout). */
export function builtinProfile(pad: PadLike): Builtin | null {
  if (!isRC(pad)) return null;
  const b = /fs-i6s/i.test(pad.id) && pad.axes.length >= 6 ? flyskyI6S(pad.id) : edgeTx(pad);
  if (b.autoKnobs) {
    const spare = Object.keys(b.autoKnobs).map(Number);
    observeAnalog(pad, spare);
    for (const i of spare) {
      if (!analog.has(`${pad.id}#${i}`)) continue;
      (b.profile.knobs ??= {})[b.autoKnobs[i]!] = { index: i, invert: false, min: -0.82, center: 0, max: 0.82 };
    }
  }
  return b;
}

/** Human name of a bound control: the radio's switch name when known, else channel / button number. */
export function controlName(pad: PadLike, sw: SwitchCal): string {
  const b = builtinProfile(pad);
  if (sw.kind === 'axis') return b?.axisNames?.[sw.index] ?? `канал ${sw.index + 1}`;
  if (sw.kind === 'buttons') return (sw.group ?? []).map((i) => b?.buttonNames?.[i]?.split(' ')[0] ?? `кн. ${i}`).filter((x, i, a) => a.indexOf(x) === i).join('/');
  const n = b?.buttonNames?.[sw.index] ?? `кнопка ${sw.index}`;
  if (!b?.buttonNames?.[sw.index]) return sw.on === 0 ? `${n} (отпущена)` : n;
  return /^Key/.test(n) ? n : `${n} вниз`; // a radio switch: ON away from its pressed "up" button / at its "down" button
}
