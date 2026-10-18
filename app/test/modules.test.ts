// Unit tests of the stage-2 physics modules: battery, motor, aero, wind, rates/CLI, FC features, determinism.
import { beforeAll, describe, expect, it } from 'vitest';
import { Battery, ocvPerCell } from '../src/sim/battery';
import { MotorBank } from '../src/sim/motor';
import { buildModel } from '../src/sim/presets';
import { inducedVelocity, smoothstep, vrsIntensity, wakeFactor } from '../src/sim/aero';
import { WindField } from '../src/sim/wind';
import { Gauss, SmoothNoise, mulberry32 } from '../src/sim/rng';
import { actualRate, applyRate, betaflightRate, kissRate, quickRate, raceflightRate } from '../src/sim/rates';
import { parseCliSettings, ratesFromCli, ratesToCli } from '../src/sim/cli';
import { BetaflightFC } from '../src/sim/fc/betaflight';
import { Mixer } from '../src/sim/mixer';
import { SimWorld, initPhysics } from '../src/sim/world';
import { DEG, quatFromAxisAngle, q4, v3 } from '../src/sim/math';
import { preset } from './helpers';

beforeAll(async () => { await initPhysics(); });
const P5 = () => preset('fpv_5in_freestyle');

describe('battery (Thevenin, PHYSICS.md 2.2)', () => {
  it('OCV table: 4.20 V full, LiPo plateau, empty ~3.3 V; Li-ion lower', () => {
    expect(ocvPerCell('lipo', 1)).toBeCloseTo(4.2, 6);
    expect(ocvPerCell('lipo', 0)).toBeCloseTo(3.3, 6);
    expect(ocvPerCell('lipo', 0.5)).toBeGreaterThan(3.75); expect(ocvPerCell('lipo', 0.5)).toBeLessThan(3.9);
    expect(ocvPerCell('liion', 0.2)).toBeLessThan(ocvPerCell('lipo', 0.2));
    for (let s = 0; s < 1; s += 0.05) expect(ocvPerCell('lipo', s + 0.05)).toBeGreaterThanOrEqual(ocvPerCell('lipo', s));
  });

  it('terminal voltage = OCV - I*R for a linear load, mAh and SoC integrate the current', () => {
    const b = new Battery(P5());
    const R = b.rInt;
    expect(R).toBeCloseTo(6 * 0.0036, 6);
    // I(V) = a V + b0 -> V = (OCV - R b0)/(1 + R a); constant 50 A: a = 0
    const V = b.solve(0, 50);
    expect(V).toBeCloseTo(25.2 - 50 * R, 6);
    for (let i = 0; i < 3600; i++) b.integrate(b.solve(0, 11), 11, 1 / 1000 * 100); // 11 A for 360 s
    expect(b.mAh).toBeCloseTo(1100, 0);
    expect(b.soc).toBeCloseTo(0, 3);
  });

  it('polarization: voltage keeps sagging under constant load and recovers after it (R_p C_p)', () => {
    const b = new Battery(P5());
    const dt = 0.001;
    let v0 = 0;
    for (let i = 0; i < 3000; i++) { const v = b.solve(0, 100); if (i === 0) v0 = v; b.integrate(v, 100, dt); }
    const vEnd = b.vbus;
    expect(v0 - vEnd).toBeGreaterThan(0.3); // RC branch charged
    const vRest0 = b.solve(0, 1);
    for (let i = 0; i < 5000; i++) b.integrate(b.solve(0, 1), 1, dt);
    expect(b.vbus - vRest0).toBeGreaterThan(0.2); // bounce back
  });

  it('ESC low-voltage limiter pulls the duty back below cutoff and a dead pack stays dead', () => {
    const b = new Battery(P5());
    b.soc = 0.02;
    for (let i = 0; i < 500; i++) { const v = b.solve(0, 400); b.integrate(v, 400, 0.001); }
    expect(b.cellV).toBeLessThan(3.0);
    expect(b.limit).toBeLessThan(0.1);
    b.soc = 0;
    for (let i = 0; i < 2000; i++) b.integrate(b.solve(0, 0), 0, 0.001);
    expect(b.limit).toBe(0);
  });
});

describe('motor electromechanics (PHYSICS.md 2.1)', () => {
  const m = buildModel(P5());
  const kq = new Float64Array(4).fill(m.kQ0);
  const spin = (cmd: number, seconds: number, bank: MotorBank, armed = true) => {
    const c = new Float64Array(4).fill(cmd);
    for (let i = 0; i < seconds * 1000; i++) bank.step(0.001, c, armed, kq);
  };

  it('steady speed matches the torque balance Kt(I - I0) = kQ Ω^2', () => {
    const bank = new MotorBank(m, new Battery(P5()));
    spin(0.5, 1, bank);
    const w = bank.omega[0], I = bank.phaseA[0];
    expect(m.ke * (I - m.i0)).toBeCloseTo(m.kQ0 * w * w, 3);
    expect(w).toBeGreaterThan(1500); expect(w).toBeLessThan(2500);
  });

  it('full-throttle speed follows the bus voltage (sagging pack = fewer RPM)', () => {
    const full = MotorBank.steadyOmega(m, 25.2), sag = MotorBank.steadyOmega(m, 21);
    expect(sag / full).toBeGreaterThan(0.75); expect(sag / full).toBeLessThan(0.9);
    // the winding reactance keeps the full-throttle phase current at bench-like values (~40-45 A for a 2306 on 6S)
    const I = (25.2 - m.ke * full) / Math.hypot(m.rm, m.xL * full);
    expect(I).toBeGreaterThan(30); expect(I).toBeLessThan(50);
  });

  it('small-signal time constant 15-25 ms around hover (5")', () => {
    const bank = new MotorBank(m, new Battery(P5()));
    spin(0.25, 1, bank);
    const w0 = bank.omega[0];
    const target = MotorBank.steadyOmega(m, bank['bat'].vbus, 0.3);
    let t63 = 0;
    for (let i = 1; i <= 300; i++) {
      bank.step(0.001, new Float64Array(4).fill(0.3), true, kq);
      if (!t63 && bank.omega[0] - w0 > 0.63 * (target - w0)) t63 = i;
    }
    console.log('motor tau', t63, 'ms');
    expect(t63).toBeGreaterThanOrEqual(15); expect(t63).toBeLessThanOrEqual(25);
  });

  it('active braking slows the rotor much faster than coasting on prop drag', () => {
    const decel = (braking: boolean) => {
      const mm = { ...m, braking };
      const bank = new MotorBank(mm, new Battery(P5()));
      spin(0.8, 0.5, bank);
      const w0 = bank.omega[0];
      spin(m.idle, 0.03, bank);
      return w0 - bank.omega[0];
    };
    const withBrake = decel(true), coast = decel(false);
    expect(withBrake).toBeGreaterThan(1.5 * coast);
  });

  it('disarmed rotors coast down and never reverse; turtle (negative command) spins them backwards', () => {
    const bank = new MotorBank(m, new Battery(P5()));
    spin(0.5, 0.5, bank);
    spin(0, 3, bank, false);
    expect(bank.omega[0]).toBeGreaterThanOrEqual(0);
    expect(bank.omega[0]).toBeLessThan(50);
    spin(-0.5, 0.5, bank);
    expect(bank.omega[0]).toBeLessThan(-500);
  });

  it('simple (first-order) model for Gazebo presets still drains the battery', () => {
    const p = preset('x500');
    const mm = buildModel(p);
    expect(mm.simpleMotor).toBe(true);
    const b = new Battery(p, mm.vNominal);
    const bank = new MotorBank(mm, b);
    const c = new Float64Array(4).fill(0.6), k = new Float64Array(4).fill(mm.kQ0);
    for (let i = 0; i < 2000; i++) bank.step(0.001, c, true, k);
    expect(bank.omega[0]).toBeCloseTo(0.6 * mm.omegaMax * (b.vbus / mm.vNominal), -1);
    expect(b.current).toBeGreaterThan(5);
    expect(b.mAh).toBeGreaterThan(1);
  });
});

describe('rotor aerodynamics (PHYSICS.md 3.4, 3.5)', () => {
  it('induced velocity of a 5" in hover is 6-7 m/s', () => {
    const v = inducedVelocity((0.62 * 9.80665) / 4, 0.1295, 1.225);
    expect(v).toBeGreaterThan(6); expect(v).toBeLessThan(7.5);
  });
  it('VRS window: none when climbing or windmilling, full at ~1 v_h descent, killed by sideways speed', () => {
    expect(vrsIntensity(-1, 0)).toBe(0);
    expect(vrsIntensity(0.2, 0)).toBe(0);
    expect(vrsIntensity(1.1, 0)).toBeCloseTo(1, 6);
    expect(vrsIntensity(2.5, 0)).toBe(0);
    expect(vrsIntensity(1.1, 0.8)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 6);
  });
  it('rear rotors lose up to 10 % thrust in the front rotors\' wake at speed', () => {
    // flying forward (-Z): rotors at +z are behind
    expect(wakeFactor(0.08, 0.08, 0, -15)).toBeCloseTo(0.9, 6);
    expect(wakeFactor(0.08, -0.08, 0, -15)).toBe(1);
    expect(wakeFactor(0.08, 0.08, 0, -2)).toBe(1);
  });
});

describe('wind (PHYSICS.md 4)', () => {
  it('mean wind: power-law profile and "from" direction (240 deg blows towards +X/-Z... north-east)', () => {
    const w = new WindField(7);
    w.configure({ mean_ms: 4, gust_ms: 0, dir_deg: 270 }); // from the west -> blows towards +X (east)
    const o = v3();
    w.update(0.001, v3(0, 10, 0), 0, o);
    expect(o.x).toBeCloseTo(4, 6); expect(Math.abs(o.z)).toBeLessThan(1e-9);
    expect(w.meanAt(40) / w.meanAt(10)).toBeCloseTo(Math.pow(4, 0.143), 6);
    w.configure({ mean_ms: 4, gust_ms: 0, dir_deg: 0 }); // from the north (-Z) -> towards +Z
    w.update(0.001, v3(0, 10, 0), 0, o);
    expect(o.z).toBeCloseTo(4, 6);
  });

  it('Dryden gusts: zero mean, sigma_w = 0.1 W20, horizontal sigma larger near the ground, deterministic', () => {
    const stats = (seed: number) => {
      const w = new WindField(seed);
      w.configure({ mean_ms: 0, gust_ms: 5, dir_deg: 0 });
      const o = v3(); const p = v3(0, 10, 0);
      let sw = 0, su = 0, mu = 0; const n = 600000;
      for (let i = 0; i < n; i++) { w.update(0.001, p, 10, o); sw += o.y * o.y; su += o.z * o.z; mu += o.z; }
      return { sw: Math.sqrt(sw / n), su: Math.sqrt(su / n), mu: mu / n, last: o.z };
    };
    const a = stats(3), b = stats(3), c = stats(4);
    expect(a.last).toBe(b.last);
    expect(a.last).not.toBe(c.last);
    expect(a.sw).toBeGreaterThan(0.35); expect(a.sw).toBeLessThan(0.65);
    expect(a.su).toBeGreaterThan(a.sw);
    expect(Math.abs(a.mu)).toBeLessThan(0.3);
  });

  it('turbulence zones multiply the gust intensity inside', () => {
    const w = new WindField(1);
    w.configure({ mean_ms: 2, gust_ms: 4, dir_deg: 0 }, [{ kind: 'turbulence', c: [0, 5, 0], r: 10, gain: 3 }, { kind: 'trick_line' }]);
    expect(w.zoneGain(v3(0, 5, 0))).toBeCloseTo(3, 6);
    expect(w.zoneGain(v3(50, 5, 0))).toBe(1);
  });

  it('a map wind pushes a hovering drone downwind', () => {
    const s = new SimWorld(5);
    s.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 500, y: 0.5, z: 500 });
    s.wind.configure({ mean_ms: 5, gust_ms: 0, dir_deg: 270 });
    s.spawnDrone(P5(), { x: 0, y: 20, z: 0 });
    s.drone.fc.mode = 'angle'; s.drone.fc.setArmed(true, 0);
    for (let i = 0; i < 3000; i++) s.step({ throttle: 0.19, roll: 0, pitch: 0, yaw: 0 });
    expect(s.state.pos.x).toBeGreaterThan(2);
  });
});

describe('rates (Betaflight rc.c) and CLI import/export', () => {
  it('quick, KISS and RaceFlight curves', () => {
    expect(quickRate(1, 1, 670, 0)).toBeCloseTo(670, 6);
    expect(quickRate(0.001, 1, 670, 0) / 0.001).toBeCloseTo(200, 0);
    expect(kissRate(1, 1, 0.7, 0)).toBeCloseTo(666.67, 1);
    expect(kissRate(0.5, 1, 0, 0)).toBeCloseTo(100, 6);
    expect(raceflightRate(1, 370, 0.8, 0.5)).toBeCloseTo(666, 6);
    expect(applyRate({ type: 'kiss', roll: [1, 0.7, 0], pitch: [1, 0.7, 0], yaw: [1, 0.7, 0] }, 'roll', 1)).toBeCloseTo(666.67, 1);
    expect(betaflightRate(1, 1, 0.7, 0)).toBeCloseTo(kissRate(1, 1, 0.7, 0), 6);
  });

  it('parses a Betaflight diff (actual rates) and gets the same curve', () => {
    const diff = `# diff rateprofile
rateprofile 0
set rates_type = ACTUAL
set roll_rc_rate = 7
set pitch_rc_rate = 7
set yaw_rc_rate = 7
set roll_expo = 54
set pitch_expo = 54
set yaw_expo = 20
set roll_srate = 67
set pitch_srate = 67
set yaw_srate = 50
set throttle_limit_type = OFF`;
    expect(parseCliSettings(diff).get('roll_srate')).toBe('67');
    const p = ratesFromCli(diff, { type: 'betaflight', roll: [1, 0.7, 0], pitch: [1, 0.7, 0], yaw: [1, 0.7, 0] })!;
    expect(p.type).toBe('actual');
    expect(p.roll[0]).toBeCloseTo(70, 6); expect(p.roll[1]).toBeCloseTo(670, 6); expect(p.roll[2]).toBeCloseTo(0.54, 6);
    expect(p.yaw).toEqual([70, 500, 0.2]);
    expect(applyRate(p, 'roll', 0.7)).toBeCloseTo(actualRate(0.7, 70, 670, 0.54), 9);
  });

  it('export -> import round trip, legacy BF 4.0 names, no rates -> null', () => {
    const p = { type: 'betaflight' as const, roll: [1.2, 0.75, 0.1] as [number, number, number], pitch: [1.1, 0.7, 0] as [number, number, number], yaw: [1, 0.6, 0] as [number, number, number] };
    const text = ratesToCli(p);
    expect(text).toContain('set rates_type = BETAFLIGHT');
    expect(text).toContain('set roll_rc_rate = 120');
    expect(ratesFromCli(text, { type: 'actual', roll: [1, 1, 0], pitch: [1, 1, 0], yaw: [1, 1, 0] })).toEqual(p);
    const legacy = ratesFromCli('set rc_rate = 110\nset rc_expo = 10\nset rc_rate_yaw = 100\nset roll_srate = 70', p)!;
    expect(legacy.roll).toEqual([1.1, 0.7, 0.1]); expect(legacy.pitch[0]).toBeCloseTo(1.1, 9); expect(legacy.yaw[0]).toBeCloseTo(1, 9);
    expect(ratesFromCli('set gyro_lpf1_static_hz = 250', p)).toBeNull();
  });
});

describe('flight controller features (PHYSICS.md 5.3)', () => {
  const up = { x: 0, y: 1, z: 0 };
  it('TPA attenuates D above the breakpoint (P too in PD mode)', () => {
    const fc = new BetaflightFC(P5());
    fc.setArmed(true, 0);
    fc.step(0.001, { throttle: 0.3, roll: 0, pitch: 0, yaw: 0 }, [0, 0, 0], up);
    expect(fc.tpaFactor).toBe(1);
    fc.step(0.001, { throttle: 1, roll: 0, pitch: 0, yaw: 0 }, [0, 0, 0], up);
    expect(fc.tpaFactor).toBeCloseTo(1 - 0.65, 6);
  });

  it('anti-gravity boosts the I-term on fast throttle moves only', () => {
    const fc = new BetaflightFC(P5());
    fc.setArmed(true, 0);
    for (let i = 0; i < 200; i++) fc.step(0.001, { throttle: 0.3, roll: 0, pitch: 0, yaw: 0 }, [0, 0, 0], up);
    expect(fc.agBoost).toBeCloseTo(1, 3);
    for (let i = 0; i < 100; i++) fc.step(0.001, { throttle: 0.3 + i * 0.007, roll: 0, pitch: 0, yaw: 0 }, [0, 0, 0], up);
    expect(fc.agBoost).toBeGreaterThan(2);
  });

  it('gyro low-pass passes body motion and attenuates high-frequency vibration', () => {
    const fc = new BetaflightFC(P5());
    for (let i = 0; i < 1000; i++) fc.step(0.001, { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, [1, 0, 0], up);
    expect(fc.gyroF[0]).toBeCloseTo(1, 6);
    let peak = 0;
    for (let i = 0; i < 1000; i++) {
      fc.step(0.001, { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, [Math.sin(i * 2 * Math.PI * 0.45), 0, 0], up); // 450 Hz
      if (i > 100) peak = Math.max(peak, Math.abs(fc.gyroF[0]));
    }
    expect(peak).toBeLessThan(0.7);
  });

  it('turtle mixer: roll right spins the right motors reversed, the others stay off', () => {
    const m = buildModel(P5());
    const mix = new Mixer(m);
    const o = Array.from(mix.mixTurtle(1, 0, 0));
    // 0 RR, 1 FR are on the right (+x)
    expect(o[0]).toBeLessThan(-0.9); expect(o[1]).toBeLessThan(-0.9);
    expect(o[2]).toBe(0); expect(o[3]).toBe(0);
    const d = Array.from(mix.mixTurtle(0.7, 0.7, 0)); // diagonal: front-right only
    expect(d.filter((c) => c < 0).length).toBe(1); expect(d[1]).toBeLessThan(0);
    expect(Array.from(mix.mixTurtle(0.05, 0, 0)).every((c) => c === 0)).toBe(true); // deadband
  });

  it('turtle mode flips an upside-down drone back onto its belly', () => {
    const w = new SimWorld(2);
    w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 50, y: 0.5, z: 50 });
    w.spawnDrone(P5(), { x: 0, y: 0.1, z: 0 }, quatFromAxisAngle(q4(), 0, 0, 1, Math.PI));
    for (let i = 0; i < 1000; i++) w.step({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
    const upY = () => { const r = w.state.rot; return 1 - 2 * (r.x * r.x + r.z * r.z); };
    expect(upY()).toBeLessThan(-0.9);
    w.drone.fc.turtle = true;
    expect(w.drone.fc.setArmed(true, 0)).toBe(true);
    // hold the stick like a pilot does; the motors stop by themselves once the quad tips over
    let t = 0;
    while (upY() < 0.5 && t < 4) { w.step({ throttle: 0, roll: 0.7, pitch: 0, yaw: 0 }); t += 0.001; }
    for (let i = 0; i < 1500; i++) w.step({ throttle: 0, roll: 0.7, pitch: 0, yaw: 0 });
    w.drone.fc.setArmed(false, 0);
    console.log('turtle flip-over in', t.toFixed(2), 's');
    expect(upY()).toBeGreaterThan(0.9);
    expect(w.crash).toBeNull();
  });
});

describe('determinism and noise', () => {
  it('mulberry32 / Gauss / SmoothNoise are reproducible and bounded', () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
    const g = new Gauss(mulberry32(1)); let s = 0, s2 = 0; const n = 50000;
    for (let i = 0; i < n; i++) { const x = g.next(); s += x; s2 += x * x; }
    expect(Math.abs(s / n)).toBeLessThan(0.03); expect(Math.sqrt(s2 / n)).toBeCloseTo(1, 1);
    const sn = new SmoothNoise(mulberry32(9), 22);
    for (let i = 0; i < 5000; i++) { const v = sn.step(0.001); expect(Math.abs(v)).toBeLessThanOrEqual(1); }
  });

  it('same seed + same sticks -> identical flight (gyro noise, prop wash, gusts); other seed differs', () => {
    const fly = (seed: number) => {
      const w = new SimWorld(seed);
      w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 500, y: 0.5, z: 500 });
      w.wind.configure({ mean_ms: 3, gust_ms: 6, dir_deg: 120 });
      w.spawnDrone(P5(), { x: 0, y: 30, z: 0 });
      w.drone.fc.setArmed(true, 0);
      for (let i = 0; i < 2000; i++) w.step({ throttle: i < 1000 ? 0.4 : 0.05, roll: Math.sin(i / 200) * 0.3, pitch: 0.2, yaw: 0 });
      return [w.state.pos.x, w.state.pos.y, w.state.pos.z, w.drone.battery.vbus];
    };
    expect(fly(11)).toEqual(fly(11));
    expect(fly(11)).not.toEqual(fly(12));
  });

  it('gyro sees vibration that grows with motor speed', () => {
    const w = new SimWorld(1);
    w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 500, y: 0.5, z: 500 });
    w.spawnDrone(P5(), { x: 0, y: 50, z: 0 });
    w.drone.fc.setArmed(true, 0);
    const noise = (thr: number) => {
      let s = 0;
      for (let i = 0; i < 500; i++) { w.step({ throttle: thr, roll: 0, pitch: 0, yaw: 0 }); const d = w.drone.gyro[1] + w.drone['wb'].x; s += d * d; }
      return Math.sqrt(s / 500) / DEG;
    };
    const low = noise(0.05), high = noise(0.8);
    expect(high).toBeGreaterThan(2 * low);
  });
});
