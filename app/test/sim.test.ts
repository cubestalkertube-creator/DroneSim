import { beforeAll, describe, expect, it } from 'vitest';
import { actualRate, betaflightRate } from '../src/sim/rates';
import { Mixer } from '../src/sim/mixer';
import { buildModel } from '../src/sim/presets';
import { SimWorld, initPhysics } from '../src/sim/world';
import { DEG, quatFromAxisAngle, q4 } from '../src/sim/math';
import type { Sticks } from '../src/sim/fc/betaflight';
import { layout, preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const P5 = () => preset('fpv_5in_freestyle');
const sticks = (throttle = 0, roll = 0, pitch = 0, yaw = 0): Sticks => ({ throttle, roll, pitch, yaw });

function flatWorld(id = 'fpv_5in_freestyle', y = 10) {
  const w = new SimWorld();
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 500, y: 0.5, z: 500 });
  w.spawnDrone(preset(id), { x: 0, y, z: 0 });
  return w;
}
const run = (w: SimWorld, s: Sticks, seconds: number) => { for (let i = 0; i < seconds * 1000; i++) w.step(s); };
const rollDeg = (w: SimWorld) => { // roll right positive
  const r = w.state.rot; const ux = 2 * (r.x * r.y - r.w * r.z), uy = 1 - 2 * (r.x * r.x + r.z * r.z);
  return Math.atan2(ux, uy) / DEG;
};

describe('rates (Betaflight rc.c)', () => {
  it('actual rates hit max at full stick and center sensitivity near zero', () => {
    expect(actualRate(1, 70, 670, 0.54)).toBeCloseTo(670, 6);
    expect(actualRate(-1, 70, 670, 0.54)).toBeCloseTo(-670, 6);
    expect(actualRate(0.001, 70, 670, 0.54) / 0.001).toBeCloseTo(70, 0);
  });
  it('betaflight rates: rc 1.0, super 0.7 -> 666.7 deg/s', () => {
    expect(betaflightRate(1, 1.0, 0.7, 0)).toBeCloseTo(666.67, 1);
    expect(betaflightRate(0.5, 1.0, 0, 0)).toBeCloseTo(100, 6);
  });
});

describe('mixer', () => {
  const m = buildModel(P5());
  const mix = new Mixer(m);
  it('roll right raises left motors (2 RL, 3 FL)', () => {
    const o = mix.mix(0.3, [50, 0, 0], true, true);
    expect(o[2]).toBeGreaterThan(o[0]); expect(o[3]).toBeGreaterThan(o[1]);
  });
  it('nose down raises rear motors; yaw right raises CCW motors (1, 2)', () => {
    const p = Array.from(mix.mix(0.3, [0, 50, 0], true, true));
    expect(p[0]).toBeGreaterThan(p[1]);
    const y = Array.from(mix.mix(0.3, [0, 0, 20], true, true));
    expect(y[1]).toBeGreaterThan(y[0]);
  });
  it('airmode keeps differential at zero throttle and stays in range', () => {
    const o = Array.from(mix.mix(0, [200, 0, 0], true, true));
    expect(Math.max(...o) - Math.min(...o)).toBeGreaterThan(0.05);
    o.forEach((c) => { expect(c).toBeGreaterThanOrEqual(m.idle - 1e-9); expect(c).toBeLessThanOrEqual(1); });
  });
});

describe('5" freestyle flight (PHYSICS.md 8)', () => {
  it('hover throttle is realistic (~0.21, accept 0.10-0.35)', () => {
    let lo = 0.0, hi = 0.8;
    for (let k = 0; k < 14; k++) {
      const t = (lo + hi) / 2;
      const w = flatWorld();
      w.drone.fc.mode = 'angle';
      w.drone.fc.setArmed(true, 0);
      run(w, sticks(t), 1.5);
      if (w.state.vel.y > 0) hi = t; else lo = t;
    }
    const hover = (lo + hi) / 2;
    console.log('hover throttle', hover.toFixed(3));
    expect(hover).toBeGreaterThan(0.10);
    expect(hover).toBeLessThan(0.35);
  });

  it('angle mode self-levels from 30 deg roll', () => {
    const w = flatWorld();
    w.resetDrone({ x: 0, y: 20, z: 0 }, quatFromAxisAngle(q4(), 0, 0, -1, 30 * DEG));
    w.drone.fc.mode = 'angle';
    w.drone.fc.setArmed(true, 0);
    expect(Math.abs(rollDeg(w))).toBeGreaterThan(25);
    run(w, sticks(0.25), 1.0);
    expect(Math.abs(rollDeg(w))).toBeLessThan(3);
  });

  it('acro full roll stick tracks 670 deg/s quickly', () => {
    const w = flatWorld('fpv_5in_freestyle', 50);
    w.drone.fc.mode = 'acro';
    w.drone.fc.setArmed(true, 0);
    run(w, sticks(0.4), 0.3);
    let t90 = -1;
    for (let i = 0; i < 300; i++) {
      w.step(sticks(0.4, 1));
      const r = -w.drone['wb'].z / DEG; // roll rate (deg/s), roll right positive
      if (t90 < 0 && r > 0.9 * 670) t90 = i;
    }
    const r = -w.drone['wb'].z / DEG;
    console.log('roll rate after 0.3 s', r.toFixed(0), 'deg/s; 90% at', t90, 'ms');
    expect(r).toBeGreaterThan(600); expect(r).toBeLessThan(740);
    expect(t90).toBeGreaterThan(0); expect(t90).toBeLessThan(150);
  });

  it('level full-throttle dash reaches a plausible top speed (100-180 km/h)', () => {
    const w = flatWorld('fpv_5in_freestyle', 30);
    w.drone.fc.mode = 'angle';
    w.drone.fc.maxAngle = 62 * DEG;
    w.drone.fc.setArmed(true, 0);
    run(w, sticks(1, 0, 1), 12);
    const v = Math.hypot(w.state.vel.x, w.state.vel.z) * 3.6;
    console.log('speed after 12 s', v.toFixed(0), 'km/h, alt', w.state.pos.y.toFixed(0), 'm');
    expect(v).toBeGreaterThan(100); expect(v).toBeLessThan(180);
  });

  it('disarmed drone falls and rests on the ground', () => {
    const w = flatWorld('fpv_5in_freestyle', 3);
    run(w, sticks(0), 2);
    expect(w.state.pos.y).toBeLessThan(0.2);
    expect(Math.abs(w.state.vel.y)).toBeLessThan(0.05);
  });
});

describe('map colliders', () => {
  it('heightfield matches map_builder heights at grid points', () => {
    const L = layout('training_field');
    const w = new SimWorld();
    w.loadMap(L);
    const T = L.terrain!;
    const n = T.res + 1;
    for (const [i, j] of [[1, 1], [5, 3], [97, 2], [50, 98], [3, 88], [99, 99]]) {
      const x = -T.size / 2 + (T.size * i) / T.res, z = T.size / 2 - (T.size * j) / T.res;
      const expected = T.heights_rowmajor_blenderY[j * n + i];
      const d = w.env.ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }, 400);
      expect(200 - d).toBeCloseTo(expected, 1);
    }
  });
  it('gate frame blocks the drone path (box colliders loaded)', () => {
    const L = layout('training_field');
    const w = new SimWorld();
    w.loadMap(L);
    expect(w.world.colliders.len()).toBeGreaterThan(500);
  });
});
