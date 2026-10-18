// Persistent game settings (PLAN.md 9): last map / drone, flight conditions, controls (RC/gamepad calibration
// profiles per device id, dead zone, expo), per-drone overrides (rates, uptilt), gameplay. One JSON document in
// localStorage, versioned; unknown/corrupted fields fall back to the defaults. Graphics quality, sound and the
// touch layout keep their own keys (render/quality.ts, audio/engine.ts, input/touch.ts).
import { signal } from '@preact/signals';
import type { RateProfile } from '../sim/rates';

export type StickAxis = 'throttle' | 'yaw' | 'pitch' | 'roll';
export const STICK_AXES: StickAxis[] = ['throttle', 'yaw', 'pitch', 'roll'];

/** One calibrated stick axis: which raw Gamepad API axis, its travel and direction. */
export interface AxisCal { index: number; invert: boolean; min: number; center: number; max: number }

/**
 * A switch or button bound to a function. Axis switches are levels (raw value on the `on` side of zero = ON);
 * a button is ON while pressed (`on` 1) or released (`on` 0); a multi-position switch that a radio reports as a
 * group of buttons (FlySky "emulator": one button per position) is `buttons`: `states` are the patterns of the
 * `group` buttons ('1' pressed) in position order, `on` the ON position.
 */
export interface SwitchCal { kind: 'axis' | 'button' | 'buttons'; index: number; on: number; group?: number[]; states?: string[] }

/** Functions a transmitter switch / gamepad button can drive (like Betaflight's Modes tab). */
export type AuxFn = 'arm' | 'mode' | 'turtle' | 'reset' | 'camera' | 'rth' | 'land' | 'pause' | 'next_spawn' | 'fov' | 'mute' | 'detonate';
export const AUX_FNS: AuxFn[] = ['arm', 'mode', 'turtle', 'rth', 'land', 'reset', 'camera', 'fov', 'next_spawn', 'pause', 'mute', 'detonate'];

/** Analog functions of knobs / sliders (VrA, VrB, S1, S2): camera tilt (FPV uptilt or gimbal pitch), volume. */
export type KnobFn = 'tilt' | 'volume';
export const KNOB_FNS: KnobFn[] = ['tilt', 'volume'];

export interface PadProfile {
  /** Gamepad.id the profile was made for */
  id: string;
  axes: Record<StickAxis, AxisCal>;
  aux: Partial<Record<AuxFn, SwitchCal>>;
  /** knob travel (min..max of the raw axis -> 0..1) */
  knobs?: Partial<Record<KnobFn, AxisCal>>;
}

export interface DroneOverrides { rates?: RateProfile; uptilt?: number }

export type Difficulty = 'arcade' | 'realism' | 'hardcore';

export interface Settings {
  v: 1;
  map: string;
  drone: string;
  /** flight conditions on top of the map's env: wind (null = the map's own) */
  wind: { mean_ms: number; dir_deg: number } | null;
  controls: {
    /** centre dead zone and cubic expo applied to roll / pitch / yaw of gamepads and transmitters */
    deadzone: number; expo: number;
    /** standard gamepads: the left stick's vertical axis self-centres -> throttle centre = 50 % */
    pads: Record<string, PadProfile>;
  };
  drones: Record<string, DroneOverrides>;
  /** race: a skipped gate costs a time penalty or voids the lap (game/race.ts) */
  gameplay: { difficulty: Difficulty; hints: boolean; gateMiss: 'penalty' | 'dnf' };
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  map: 'training_field',
  drone: 'fpv_5in_freestyle',
  wind: null,
  controls: { deadzone: 0.02, expo: 0, pads: {} },
  drones: {},
  gameplay: { difficulty: 'realism', hints: true, gateMiss: 'penalty' },
};

const KEY = 'ds.settings';

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Deep merge of a stored document over the defaults (only keys/types the defaults know; maps taken as is). */
export function mergeSettings(stored: unknown): Settings {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!isObj(stored) || stored.v !== 1) return out;
  const s = stored as Partial<Settings>;
  if (typeof s.map === 'string') out.map = s.map;
  if (typeof s.drone === 'string') out.drone = s.drone;
  if (s.wind === null || (isObj(s.wind) && Number.isFinite(s.wind.mean_ms) && Number.isFinite(s.wind.dir_deg))) out.wind = s.wind ?? null;
  if (isObj(s.controls)) {
    const c = s.controls;
    if (Number.isFinite(c.deadzone)) out.controls.deadzone = Math.min(0.3, Math.max(0, c.deadzone));
    if (Number.isFinite(c.expo)) out.controls.expo = Math.min(1, Math.max(0, c.expo));
    if (isObj(c.pads)) for (const [id, p] of Object.entries(c.pads)) if (validPad(p)) out.controls.pads[id] = p;
  }
  if (isObj(s.drones)) for (const [id, d] of Object.entries(s.drones)) if (isObj(d)) out.drones[id] = d as DroneOverrides;
  if (isObj(s.gameplay)) {
    const g = s.gameplay;
    if (g.difficulty === 'arcade' || g.difficulty === 'realism' || g.difficulty === 'hardcore') out.gameplay.difficulty = g.difficulty;
    if (typeof g.hints === 'boolean') out.gameplay.hints = g.hints;
    if (g.gateMiss === 'penalty' || g.gateMiss === 'dnf') out.gameplay.gateMiss = g.gateMiss;
  }
  return out;
}

function validPad(p: unknown): p is PadProfile {
  if (!isObj(p) || typeof p.id !== 'string' || !isObj(p.axes) || !isObj(p.aux)) return false;
  return STICK_AXES.every((a) => {
    const x = (p.axes as Record<string, unknown>)[a];
    return isObj(x) && Number.isInteger(x.index) && Number.isFinite(x.min) && Number.isFinite(x.max) && Number.isFinite(x.center);
  });
}

function load(): Settings {
  try { return mergeSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return structuredClone(DEFAULT_SETTINGS); }
}

/** The live settings (UI subscribes); replace the value through `updateSettings`. */
export const settings = signal<Settings>(typeof localStorage === 'undefined' ? structuredClone(DEFAULT_SETTINGS) : load());

/** Mutate a copy, publish it and save. */
export function updateSettings(fn: (s: Settings) => void) {
  const next = structuredClone(settings.value);
  fn(next);
  settings.value = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked: settings live for this session */ }
}
