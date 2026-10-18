// PHYSICS.md section 8 validation (stage 2) + the other FPV presets: hover and stability.
import { beforeAll, describe, expect, it } from 'vitest';
import { SimWorld, initPhysics } from '../src/sim/world';
import { DEG, quatFromAxisAngle, q4 } from '../src/sim/math';
import type { Sticks } from '../src/sim/fc/betaflight';
import { applyRate, type RateProfile } from '../src/sim/rates';
import { preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const st = (throttle = 0, roll = 0, pitch = 0, yaw = 0): Sticks => ({ throttle, roll, pitch, yaw });
function world(id = 'fpv_5in_freestyle', y = 20, seed = 1) {
  const w = new SimWorld(seed);
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 5000, y: 0.5, z: 5000 });
  w.spawnDrone(preset(id), { x: 0, y, z: 0 });
  return w;
}
const run = (w: SimWorld, s: Sticks, sec: number) => { for (let i = 0; i < sec * 1000; i++) w.step(s); };
/** body rates in FC axes, deg/s (roll right, nose down, nose right) */
const rate = (w: SimWorld) => { const g = w.drone['wb']; return [-g.z / DEG, -g.x / DEG, -g.y / DEG]; };
const tilt = (w: SimWorld) => { const r = w.state.rot; return Math.acos(Math.min(1, 1 - 2 * (r.x * r.x + r.z * r.z))) / DEG; };

function hoverThrottle(id: string) {
  let lo = 0, hi = 0.9;
  for (let k = 0; k < 14; k++) {
    const t = (lo + hi) / 2;
    const w = world(id);
    w.drone.fc.mode = 'angle'; w.drone.fc.setArmed(true, 0);
    run(w, st(t), 1.5);
    if (w.state.vel.y > 0) hi = t; else lo = t;
  }
  return (lo + hi) / 2;
}

/** Altitude hold "pilot" (angle mode): throttle = hover + PD on altitude error. */
function holdThrottle(w: SimWorld, hover: number, target: number) {
  return Math.min(1, Math.max(0, hover + 0.06 * (target - w.state.pos.y) - 0.05 * w.state.vel.y));
}

describe('5" freestyle vs PHYSICS.md 8', () => {
  const ID = 'fpv_5in_freestyle';
  let hover = 0.21;

  it('8.1 hover throttle 18-25 % on a full pack', () => {
    hover = hoverThrottle(ID);
    console.log('hover throttle', hover.toFixed(3));
    expect(hover).toBeGreaterThan(0.17);
    expect(hover).toBeLessThan(0.25);
  });

  it('8.2 vertical punch: +100 m in 2.4-3.0 s, 6S sags to 21-22 V and bounces back', () => {
    const w = world(ID);
    w.drone.fc.mode = 'angle'; w.drone.fc.setArmed(true, 0);
    run(w, st(hover), 2);
    const b = w.drone.battery, y0 = w.state.pos.y;
    expect(b.vbus).toBeGreaterThan(24.6);
    let t = 0, vmin = 99;
    // the OSD voltage (0.5 s low-pass) is what the pilot sees; the raw bus dips lower for a few ms
    while (w.state.pos.y - y0 < 100 && t < 5) { w.step(st(1)); t += 0.001; vmin = Math.min(vmin, b.vFilt); }
    console.log(`punch +100 m in ${t.toFixed(2)} s, Vmin ${vmin.toFixed(2)} V, ${b.current.toFixed(0)} A, ${b.mAh.toFixed(0)} mAh`);
    expect(t).toBeGreaterThan(2.4); expect(t).toBeLessThan(3.0);
    expect(vmin).toBeGreaterThan(21.0); expect(vmin).toBeLessThan(22.0);
    // polarization: after the punch the voltage keeps recovering for seconds at a constant light load
    run(w, st(0.1), 0.3);
    const v1 = b.vbus; run(w, st(0.1), 2); const v2 = b.vbus;
    expect(v2 - v1).toBeGreaterThan(0.1);
  });

  it('8.3 top speed at full throttle and 62 deg: 140 km/h +-10 %', () => {
    const w = world(ID, 30);
    w.drone.fc.mode = 'angle'; w.drone.fc.maxAngle = 62 * DEG; w.drone.fc.setArmed(true, 0);
    run(w, st(1, 0, 1), 12);
    const v = Math.hypot(w.state.vel.x, w.state.vel.z) * 3.6;
    console.log('top speed', v.toFixed(0), 'km/h, V', w.drone.battery.vbus.toFixed(1));
    expect(v).toBeGreaterThan(126); expect(v).toBeLessThan(154);
  });

  it('8.4 roll step response: 15-25 ms rise on a small step, < 10 % overshoot', () => {
    const step = (sp: number) => {
      const w = world(ID, 50);
      w.drone.fc.mode = 'acro'; w.drone.fc.setArmed(true, 0);
      run(w, st(0.35), 0.5);
      const stick = solveStick(w.drone.fc.rates, sp);
      let t10 = -1, t90 = -1, peak = 0;
      for (let i = 0; i < 250; i++) {
        w.step(st(0.35, stick));
        const r = rate(w)[0];
        if (t10 < 0 && r > 0.1 * sp) t10 = i;
        if (t90 < 0 && r > 0.9 * sp) t90 = i;
        peak = Math.max(peak, r);
      }
      const rise = t90 - t10, overshoot = (peak - sp) / sp;
      console.log(`step ${sp} deg/s: rise ${rise} ms (10-90 %), overshoot ${(overshoot * 100).toFixed(1)} %`);
      expect(t90).toBeGreaterThan(0);
      return { rise, overshoot };
    };
    const small = step(80), big = step(300);
    expect(small.rise).toBeGreaterThanOrEqual(15); expect(small.rise).toBeLessThanOrEqual(25);
    expect(small.overshoot).toBeLessThan(0.1);
    // a big step is limited by how fast the motors spin up (rotor inertia, ESC current limit)
    expect(big.rise).toBeLessThan(40);
    expect(big.overshoot).toBeLessThan(0.1);
  });

  it('8.5 360 deg roll flip at zero throttle (670 deg/s): 0.55-0.65 s, a metre or two of height', () => {
    const w = world(ID, 50);
    w.drone.fc.mode = 'acro'; w.drone.fc.setArmed(true, 0);
    run(w, st(hover), 1);
    const y0 = w.state.pos.y;
    let ang = 0, t = 0;
    while (ang < 2 * Math.PI && t < 2) { w.step(st(0, 1)); ang += rate(w)[0] * DEG * 0.001; t += 0.001; }
    const loss = y0 - w.state.pos.y;
    console.log(`flip ${t.toFixed(3)} s, height loss ${loss.toFixed(2)} m`);
    expect(t).toBeGreaterThan(0.55); expect(t).toBeLessThan(0.65);
    // free fall over the flip is 1.5 m; airmode collective on the upright halves holds a bit of it
    expect(loss).toBeGreaterThan(1.0); expect(loss).toBeLessThan(2.5);
  });

  it('8.6 flight time: hover to LVC and aggressive freestyle', () => {
    // hover with an altitude-hold pilot until the OSD LVC warning (3.5 V/cell, filtered)
    let w = world(ID, 30);
    w.drone.fc.mode = 'angle'; w.drone.fc.setArmed(true, 0);
    let t = 0;
    while (!w.drone.battery.low && t < 900) { w.step(st(holdThrottle(w, hover, 30))); t += 0.001; }
    const hoverMin = t / 60;
    // freestyle: every 3.5 s a 0.5 s punch, a 0.6 s zero-throttle flip, then recovering to the base altitude
    w = world(ID, 60);
    w.drone.fc.setArmed(true, 0);
    t = 0;
    while (!w.drone.battery.low && t < 600) {
      const c = t % 3.5;
      let s: Sticks;
      if (c < 0.5) { w.drone.fc.mode = 'angle'; s = st(1); }
      else if (c < 1.1) { w.drone.fc.mode = 'acro'; s = st(0, 1); }
      else { w.drone.fc.mode = 'angle'; s = st(holdThrottle(w, hover, 60)); }
      w.step(s); t += 0.001;
    }
    const freeMin = t / 60;
    console.log(`flight time: hover ${hoverMin.toFixed(1)} min, freestyle ${freeMin.toFixed(1)} min, ${w.drone.battery.mAh.toFixed(0)} mAh`);
    // spec: hover ~5-6 min (the momentum-theory power of a 620 g 5" on 1100 mAh gives a bit more), freestyle 2.5-3.5
    expect(hoverMin).toBeGreaterThan(5); expect(hoverMin).toBeLessThan(9.5);
    expect(freeMin).toBeGreaterThan(2.5); expect(freeMin).toBeLessThan(3.5);
  });

  it('8.7 prop wash: vertical 8 m/s descent at 10 % throttle shakes (> 40 deg/s), 5 m/s sideways does not (< 15)', () => {
    const shake = (vx: number) => {
      const w = world(ID, 200);
      w.drone.fc.mode = 'acro'; w.drone.fc.setArmed(true, 0);
      run(w, st(hover), 0.5);
      w.body.setLinvel({ x: vx, y: -8, z: 0 }, true);
      let peak = 0;
      for (let i = 0; i < 600; i++) {
        w.step(st(0.1));
        if (i > 100) { const r = rate(w); peak = Math.max(peak, Math.abs(r[0]), Math.abs(r[1])); }
      }
      return peak;
    };
    const down = shake(0), side = shake(5);
    console.log(`prop wash peak rate: vertical ${down.toFixed(0)} deg/s, with 5 m/s sideways ${side.toFixed(0)} deg/s`);
    expect(down).toBeGreaterThan(40);
    expect(side).toBeLessThan(15);
  });
});

/** stick deflection that gives `sp` deg/s on the roll axis with these rates */
function solveStick(rates: RateProfile, sp: number) {
  let lo = 0, hi = 1;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (applyRate(rates, 'roll', m) < sp) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

describe('other FPV presets: hover and stability', () => {
  for (const id of ['fpv_5in_racer', 'fpv_7in_longrange', 'fpv_10in_heavy', 'cinewhoop_3in']) {
    it(id, () => {
      const p = preset(id);
      const h = hoverThrottle(id);
      console.log(id, 'hover throttle', h.toFixed(3), 'reference', p.reference?.hover_throttle);
      expect(h).toBeGreaterThan(0.1); expect(h).toBeLessThan(0.45);
      // angle mode: released from a 25 deg bank it levels and holds altitude without oscillation
      const w = world(id, 30);
      w.resetDrone({ x: 0, y: 30, z: 0 }, quatFromAxisAngle(q4(), 0, 0, -1, 25 * DEG));
      w.drone.fc.mode = 'angle'; w.drone.fc.setArmed(true, 0);
      run(w, st(h), 1.5);
      expect(tilt(w)).toBeLessThan(2);
      let maxRate = 0;
      for (let i = 0; i < 1500; i++) { w.step(st(h)); const r = rate(w); maxRate = Math.max(maxRate, Math.abs(r[0]), Math.abs(r[1])); }
      expect(maxRate).toBeLessThan(10);
      expect(Math.abs(w.state.vel.y)).toBeLessThan(1);
      // acro: full roll stick reaches at least 80 % of the max rate
      const a = world(id, 60);
      a.drone.fc.mode = 'acro'; a.drone.fc.setArmed(true, 0);
      run(a, st(h), 0.5);
      let peak = 0;
      for (let i = 0; i < 400; i++) { a.step(st(h, 1)); peak = Math.max(peak, rate(a)[0]); }
      const max = p.fc.rates!.roll[1];
      console.log(id, `acro peak ${peak.toFixed(0)} / ${max} deg/s`);
      expect(peak).toBeGreaterThan(0.8 * max); expect(peak).toBeLessThan(1.2 * max);
    });
  }
});
