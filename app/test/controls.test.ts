// Settings store and RC/gamepad calibration (stage 4: UI, PLAN.md 5.3).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/core/settings';
import { CalibrationWizard, KnobLearner, SwitchLearner, axisValue, detectSwitch, knobValue, shape, switchOn, switchPos } from '../src/input/calibration';
import { builtinProfile, isRC } from '../src/input/radios';
import { StickArming, armGesture } from '../src/input/gestures';

describe('settings', () => {
  it('falls back to defaults on garbage and keeps valid fields', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ v: 2, map: 'x' })).toEqual(DEFAULT_SETTINGS);
    const s = mergeSettings({ v: 1, map: 'parking_garage', drone: 42, controls: { deadzone: 5, expo: 0.3, pads: { bad: { id: 'bad' } } }, gameplay: { difficulty: 'nope', hints: false } });
    expect(s.map).toBe('parking_garage');
    expect(s.drone).toBe(DEFAULT_SETTINGS.drone);
    expect(s.controls.deadzone).toBe(0.3); // clamped
    expect(s.controls.expo).toBe(0.3);
    expect(s.controls.pads).toEqual({});
    expect(s.gameplay).toEqual({ difficulty: 'realism', hints: false, gateMiss: 'penalty' });
  });
});

describe('calibration math', () => {
  const a = { index: 0, invert: false, min: -0.8, center: 0.1, max: 0.9 };
  it('maps asymmetric travel to -1..1 around the centre', () => {
    expect(axisValue(0.1, a, false)).toBe(0);
    expect(axisValue(0.9, a, false)).toBeCloseTo(1);
    expect(axisValue(-0.8, a, false)).toBeCloseTo(-1);
    expect(axisValue(0.5, a, false)).toBeCloseTo(0.5);
    expect(axisValue(1.5, a, false)).toBe(1);
    expect(axisValue(0.9, { ...a, invert: true }, false)).toBeCloseTo(-1);
  });
  it('throttle is 0..1 over the full travel, inverted for a gamepad stick (up = -1)', () => {
    expect(axisValue(-0.8, a, true)).toBe(0);
    expect(axisValue(0.9, a, true)).toBe(1);
    const pad = { index: 1, invert: true, min: -1, center: 0, max: 1 };
    expect(axisValue(-1, pad, true)).toBe(1);
    expect(axisValue(0, pad, true)).toBeCloseTo(0.5);
  });
  it('dead zone keeps full travel, expo softens the centre', () => {
    expect(shape(0.01, 0.02, 0)).toBe(0);
    expect(shape(1, 0.02, 0)).toBeCloseTo(1);
    expect(shape(-1, 0.1, 0.5)).toBeCloseTo(-1);
    expect(shape(0.5, 0, 0.5)).toBeCloseTo(0.5 * 0.5 + 0.125 * 0.5);
  });
  it('switches: level, 3-position, button', () => {
    const sw = { kind: 'axis' as const, index: 4, on: -1 };
    expect(switchOn(sw, [0, 0, 0, 0, -1], [])).toBe(true);
    expect(switchOn(sw, [0, 0, 0, 0, 1], [])).toBe(false);
    const mode = { kind: 'axis' as const, index: 5, on: 1 };
    expect([-1, 0, 1].map((v) => switchPos(mode, [0, 0, 0, 0, 0, v]))).toEqual([0, 1, 2]);
    expect(switchOn({ kind: 'button', index: 2, on: 1 }, [], [false, false, true])).toBe(true);
    expect(detectSwitch([0, 0, -1], [false], [0.2, 0, 1], [false], new Set([0]))).toEqual({ kind: 'axis', index: 2, on: 1 });
    expect(detectSwitch([0, 0, -1], [false], [0.2, 0, -0.5], [false], new Set())).toBeNull();
    expect(detectSwitch([0], [false, false], [0], [false, true], new Set())).toEqual({ kind: 'button', index: 1, on: 1 });
  });
});

describe('calibration wizard', () => {
  // RadioMaster in USB joystick mode, but with a non-default channel order (TAER) and reversed elevator:
  // axes 0 throttle, 1 aileron, 2 elevator (reversed), 3 rudder, 4 arm switch, 5 mode switch
  const raw = (thr: number, roll: number, pitch: number, yaw: number, arm = -1, mode = -1) => [thr, roll, -pitch, yaw, arm, mode];
  it('finds every stick, its direction, and the arm / mode switches', () => {
    const w = new CalibrationWizard('TX12');
    w.sample(raw(-1, 0, 0, 0), []);
    expect(w.canNext).toBe(false);
    for (const v of [-1, 1]) for (let k = 0; k < 4; k++) w.sample(raw(k === 0 ? v : -1, k === 1 ? v : 0, k === 2 ? v : 0, k === 3 ? v : 0), []);
    expect(w.canNext).toBe(true);
    w.next(); expect(w.step).toBe('center');
    w.sample(raw(-1, 0.02, -0.01, 0), []); w.next(); expect(w.step).toBe('throttle');
    w.sample(raw(-0.5, 0, 0, 0), []); expect(w.step).toBe('throttle'); // a quarter of the travel: not yet
    w.sample(raw(0.2, 0, 0, 0), []); expect(w.step).toBe('yaw');
    w.sample(raw(0.2, 0, 0, 0.9), []); expect(w.step).toBe('pitch');
    w.sample(raw(0.2, 0.1, 0.8, 0), []); expect(w.step).toBe('roll');
    w.sample(raw(0.2, 0.8, 0, 0), []); expect(w.step).toBe('arm');
    w.sample(raw(0.2, 0, 0, 0, 1), []); expect(w.step).toBe('mode');
    w.sample(raw(0.2, 0, 0, 0, 1, 0), []); expect(w.step).toBe('tilt');
    w.next(); expect(w.step).toBe('done'); // no knob: skipped
    const p = w.result()!;
    expect(p.axes.throttle).toMatchObject({ index: 0, invert: false });
    expect(p.axes.roll).toMatchObject({ index: 1, invert: false });
    expect(p.axes.pitch).toMatchObject({ index: 2, invert: true });
    expect(p.axes.yaw).toMatchObject({ index: 3, invert: false });
    expect(p.aux.arm).toEqual({ kind: 'axis', index: 4, on: 1 });
    expect(p.aux.mode).toEqual({ kind: 'axis', index: 5, on: 1 });
    // the profile reproduces the pilot's sticks
    const v = raw(0.5, -0.4, 0.6, 0.3);
    expect(axisValue(v[0], p.axes.throttle, true)).toBeCloseTo(0.75);
    expect(axisValue(v[1], p.axes.roll, false)).toBeCloseTo(-0.4, 1);
    expect(axisValue(v[2], p.axes.pitch, false)).toBeCloseTo(0.6, 1);
    expect(axisValue(v[3], p.axes.yaw, false)).toBeCloseTo(0.3, 1);
  });
  it('switch steps can be skipped', () => {
    const w = new CalibrationWizard('pad');
    for (const v of [-1, 1, 0]) w.sample([v, v, v, v], []);
    w.next(); w.sample([1, 0, 0, 0], []); w.next(); // centre with the self-centring throttle stick released
    w.sample([1, 0, 0, 0], []);
    w.sample([-1, 0, 0, 0], []); expect(w.step).toBe('yaw'); // gamepad: stick up = -1 -> inverted throttle
    w.sample([0, 1, 0, 0], []); w.sample([0, 0, 1, 0], []); w.sample([0, 0, 0, 1], []);
    expect(w.step).toBe('arm');
    w.next(); w.next(); w.next();
    expect(w.step).toBe('done');
    const p = w.result()!;
    expect(p.axes.throttle.invert).toBe(true);
    expect(p.aux).toEqual({});
  });
});

// FlySky FS-i6S in USB "emulator" mode, values recorded from a real radio: 8-bit axes (21 / 127 / 233 of 0..255 ->
// -0.835 / 0 / +0.835) and buttons that mirror switch positions. Base state: SwA up (b0), SwB up (b2), SwC up (b4).
const RAW = (v: number) => (v - 127.5) / 127.5;
const btn = (...on: number[]) => Array.from({ length: 10 }, (_, i) => on.includes(i));

describe('switches reported as buttons', () => {
  it('detects a released button as a switch flip', () => {
    expect(detectSwitch([], btn(0, 2, 4), [], btn(2, 4), new Set())).toEqual({ kind: 'button', index: 0, on: 0 });
    expect(switchOn({ kind: 'button', index: 0, on: 0 }, [], btn(2, 4))).toBe(true);
    expect(switchOn({ kind: 'button', index: 0, on: 0 }, [], btn(0, 2, 4))).toBe(false);
  });
  it('learns a 3-position switch from button patterns (b2 up, none middle, b1 down), ignoring transients', () => {
    const l = new SwitchLearner([0, 0, 0, 0, RAW(21), RAW(21)], btn(0, 2, 4), new Set([0, 1, 2, 3]));
    const feed = (b: boolean[], n = 3) => { let r = null; for (let i = 0; i < n; i++) r = l.feed([0, 0, 0, 0, RAW(21), RAW(21)], b); return r; };
    expect(feed(btn(0, 4, 9), 1)).toBeNull(); // one-sample glitch: not a position
    expect(feed(btn(0, 4))).toBeNull(); // middle
    const sw = feed(btn(0, 1, 4))!; // down -> three positions: done
    expect(sw).toMatchObject({ kind: 'buttons', group: [1, 2, 9], states: ['010', '000', '100'] });
    expect([btn(0, 2, 4), btn(0, 4), btn(0, 1, 4)].map((b) => switchPos(sw, [], b))).toEqual([0, 1, 2]);
  });
  it('a 2-position switch is confirmed by the pilot; an axis switch completes at once', () => {
    const l = new SwitchLearner([], btn(0), new Set());
    for (let i = 0; i < 3; i++) expect(l.feed([], btn())).toBeNull();
    expect(l.result()).toMatchObject({ kind: 'buttons', group: [0], states: ['1', '0'], on: 1 });
    const a = new SwitchLearner([0, 0, 0, 0, 0, RAW(21)], [], new Set([0, 1, 2, 3]));
    expect(a.feed([0, 0, 0, 0, 0, RAW(127)], [])).toEqual({ kind: 'axis', index: 5, on: 1 });
    const g = new SwitchLearner([], [false], new Set(), false); // standard gamepad: a plain button
    expect(g.feed([], [true])).toEqual({ kind: 'button', index: 0, on: 1 });
  });
  it('knob learner picks the free axis with the largest travel', () => {
    const k = new KnobLearner(new Set([0, 1, 2, 3]));
    for (const v of [-0.9, 0.2, 0.95]) k.feed([v, v, v, v, 0.1, v / 3]);
    const r = k.result()!;
    expect(r.index).toBe(5);
    expect(knobValue(r.max, r)).toBe(1);
    expect(knobValue(r.min, r)).toBe(0);
    expect(new KnobLearner(new Set()).result()).toBeNull();
  });
});

describe('built-in transmitter profiles', () => {
  const i6s = { id: 'FS-i6S emulator (Vendor: 284e Product: 7fff)', mapping: '', axes: [0, 0, 0, 0, 0, 0], buttons: btn() };
  it('recognises transmitters, not gamepads', () => {
    expect(isRC(i6s)).toBe(true);
    expect(isRC({ id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', mapping: 'standard' })).toBe(false);
    expect(builtinProfile({ ...i6s, id: 'Generic USB Joystick', mapping: 'standard' })).toBeNull();
    expect(builtinProfile({ ...i6s, id: 'RadioMaster TX12 Joystick' })!.name).toBe('EdgeTX / OpenTX');
  });
  it('FS-i6S: full stick travel, directions and switches as measured', () => {
    const p = builtinProfile(i6s)!.profile, A = p.axes;
    expect(axisValue(RAW(21), A.throttle, true)).toBeCloseTo(0, 2);
    expect(axisValue(RAW(233), A.throttle, true)).toBeCloseTo(1, 2);
    expect(axisValue(RAW(233), A.roll, false)).toBeCloseTo(1, 2); // roll right
    expect(axisValue(RAW(21), A.pitch, false)).toBeCloseTo(1, 2); // pitch forward
    expect(axisValue(RAW(21), A.yaw, false)).toBeCloseTo(1, 2); // yaw right
    expect(axisValue(RAW(124), A.roll, false)).toBeCloseTo(-0.03, 1); // centre
    const axes = (swd: number, swc: number) => [0, 0, 0, 0, RAW(swd), RAW(swc)];
    // switches from the buttons, left to right: SwA arm (down), SwB mode, SwC camera, SwD turtle / RTH (down)
    expect(switchOn(p.aux.arm!, axes(21, 21), btn(0, 2, 4))).toBe(false);
    expect(switchOn(p.aux.arm!, axes(21, 21), btn(2, 4))).toBe(true);
    expect([btn(0, 2, 4), btn(0, 4), btn(0, 1, 4)].map((b) => switchPos(p.aux.mode!, [], b))).toEqual([0, 1, 2]);
    expect([btn(0, 2, 4), btn(0, 2), btn(0, 2, 3)].map((b) => switchPos(p.aux.camera!, [], b))).toEqual([0, 1, 2]);
    expect(switchOn(p.aux.turtle!, axes(21, 233), btn(0, 2, 4, 5))).toBe(true);
    expect(switchOn(p.aux.reset!, axes(21, 21), btn(0, 2, 4, 6))).toBe(true); // Key1
    expect(switchOn(p.aux.pause!, axes(21, 21), btn(0, 2, 4, 7))).toBe(true); // Key2
  });
  it('FS-i6S: a knob put on CH5 / CH6 in the radio becomes camera tilt / volume; switches there do not', () => {
    const pad = (a4: number, a5: number) => ({ ...i6s, id: 'FS-i6S emulator knob test', axes: [0, 0, 0, 0, a4, a5] });
    for (let k = 0; k < 10; k++) builtinProfile(pad(k % 2 ? RAW(233) : RAW(21), RAW(127))); // switches flipping
    expect(builtinProfile(pad(0, 0))!.profile.knobs).toBeUndefined();
    for (let k = 0; k < 6; k++) builtinProfile(pad(0.4, 0));
    const p = builtinProfile(pad(0.4, 0))!.profile;
    expect(p.knobs?.tilt?.index).toBe(4);
    expect(p.knobs?.volume).toBeUndefined();
    expect(knobValue(0.82, p.knobs!.tilt!)).toBe(1);
  });
});

describe('arming with the sticks (GPS drones)', () => {
  const S = (throttle: number, yaw: number, pitch: number, roll: number) => ({ throttle, yaw, pitch, roll });
  const hold = (a: StickArming, s: ReturnType<typeof S>, sec: number, armed: boolean, landed = true) => {
    const out: string[] = [];
    for (let t = 0; t < sec; t += 0.02) { const g = a.update(0.02, s, armed, landed); if (g) out.push(g); }
    return out;
  };
  it('DJI CSC: both sticks down-inward or down-outward starts the motors, again on the ground stops them', () => {
    expect(armGesture('gps_consumer').kind).toBe('csc');
    expect(armGesture('betaflight').kind).toBeNull(); // Betaflight arms with a switch only
    const a = new StickArming('csc', 0.4);
    expect(hold(a, S(0, 1, -1, -1), 0.3, false)).toEqual([]); // too short
    expect(hold(a, S(0, 1, -1, -1), 0.3, false)).toEqual(['arm']); // inner corners, 0.6 s in total
    expect(hold(a, S(0, 1, -1, -1), 2, true)).toEqual([]); // still held after the start: nothing more
    expect(hold(a, S(0.5, 0, 0, 0), 0.1, true)).toEqual([]); // released
    expect(hold(a, S(0, -1, -1, 1), 1, true, false)).toEqual([]); // outer corners in the air: never stops
    expect(hold(a, S(0, -1, -1, 1), 1, true)).toEqual(['disarm']); // on the ground: stop
    expect(hold(new StickArming('csc', 0.4), S(0, 1, -1, 1), 1, false)).toEqual([]); // both to the right: not a CSC
  });
  it('PX4 / ArduPilot: throttle down + yaw right arms, + yaw left disarms on the ground', () => {
    expect(armGesture('px4')).toEqual({ kind: 'yaw', hold: 1 });
    expect(armGesture('ardupilot').hold).toBe(2);
    const a = new StickArming('yaw', 1);
    expect(hold(a, S(0, 1, 0, 0), 0.9, false)).toEqual([]);
    expect(hold(new StickArming('yaw', 1), S(0, 1, 0, 0), 1.1, false)).toEqual(['arm']);
    expect(hold(a, S(0, -1, 0, 0), 1.1, true, false)).toEqual([]); // in the air: no
    expect(hold(a, S(0, 0, 0, 0), 0.1, true)).toEqual([]);
    expect(hold(a, S(0, -1, 0, 0), 1.1, true)).toEqual(['disarm']);
  });
});
