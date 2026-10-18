// Low (phone) profile: the physics at 500 Hz must fly like the 1 kHz reference. Touch stick maths.
import { beforeAll, describe, expect, it } from 'vitest';
import { SimWorld, initPhysics } from '../src/sim/world';
import type { Sticks } from '../src/sim/fc/betaflight';
import { stickFromOffset } from '../src/input/touch';
import { preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

function fly(dt: number, id: string, sec: number, sticks: (t: number) => Sticks) {
  const w = new SimWorld(1, dt);
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 5000, y: 0.5, z: 5000 });
  w.spawnDrone(preset(id), { x: 0, y: 20, z: 0 });
  w.drone.fc.mode = 'angle'; w.drone.fc.setArmed(true, 0);
  let maxRate = 0;
  for (let i = 0; i < sec / dt; i++) {
    w.step(sticks(i * dt));
    const a = w.state.angVel;
    if (i * dt > 0.5) maxRate = Math.max(maxRate, Math.hypot(a.x, a.y, a.z));
  }
  return { w, maxRate };
}

describe('500 Hz physics (Low profile)', () => {
  for (const id of ['fpv_5in_freestyle', 'cinewhoop_3in', 'fpv_10in_heavy']) {
    it(`${id}: hover and a stick step match 1 kHz`, () => {
      const hover = (t: number): Sticks => ({ throttle: 0.3, roll: t > 1 && t < 1.4 ? 0.5 : 0, pitch: 0, yaw: 0 });
      const ref = fly(0.001, id, 3, hover), lo = fly(0.002, id, 3, hover);
      // no oscillation blow-up: body rates stay in the commanded range, same trajectory within a few %
      expect(lo.maxRate).toBeLessThan(ref.maxRate * 1.3 + 0.5);
      const dy = Math.abs(lo.w.state.pos.y - ref.w.state.pos.y), dx = Math.abs(lo.w.state.pos.x - ref.w.state.pos.x);
      console.log(id, 'dy', dy.toFixed(2), 'dx', dx.toFixed(2), 'maxRate', ref.maxRate.toFixed(2), lo.maxRate.toFixed(2));
      expect(dy).toBeLessThan(0.08 * Math.abs(ref.w.state.pos.y - 20) + 0.5);
      expect(dx).toBeLessThan(0.1 * Math.abs(ref.w.state.pos.x) + 0.5);
    });
  }
});

describe('touch stick', () => {
  it('maps finger offset to -1..1 with dead zone and clamping', () => {
    expect(stickFromOffset(0, 60, 0.04)).toBe(0);
    expect(stickFromOffset(2, 60, 0.04)).toBe(0);
    expect(stickFromOffset(60, 60, 0.04)).toBeCloseTo(1);
    expect(stickFromOffset(-120, 60, 0.04)).toBeCloseTo(-1);
    expect(stickFromOffset(30, 60, 0.04)).toBeGreaterThan(0.45);
    expect(stickFromOffset(30, 60, 0.04)).toBeLessThan(0.5);
  });
});
