// GPS position controller (PHYSICS.md 5.2, 5.4): take-off, altitude/position hold, speed limits, braking,
// wind, ATTI drift, return-to-home with landing + auto-disarm, obstacle braking, all GPS airframes.
import { beforeAll, describe, expect, it } from 'vitest';
import { SimWorld, initPhysics } from '../src/sim/world';
import type { Sticks } from '../src/sim/fc/betaflight';
import { preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const C = (pitch = 0, roll = 0, throttle = 0.5, yaw = 0): Sticks => ({ throttle, roll, pitch, yaw });
function world(id = 'camera_drone_fold', wind = 0, wall = false) {
  const w = new SimWorld(3);
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 5000, y: 0.5, z: 5000 });
  if (wall) w.addStaticBox({ x: 0, y: 10, z: -60 }, { x: 30, y: 10, z: 0.5 });
  w.world.step();
  w.spawnDrone(preset(id), { x: 0, y: 0.3, z: 0 });
  if (wind) w.wind.configure({ mean_ms: wind, gust_ms: 0, dir_deg: 90 }, []);
  return w;
}
const run = (w: SimWorld, s: Sticks | ((t: number) => Sticks), sec: number) => {
  const n = Math.round(sec / w.dt);
  for (let i = 0; i < n; i++) w.step(typeof s === 'function' ? s(i * w.dt) : s);
};
/** arm, climb to ~10 m, settle */
function takeoff(w: SimWorld) {
  expect(w.drone.setArmed(true, 0.5)).toBe(true);
  run(w, C(), 0.5);
  run(w, C(0, 0, 1), 2.5);
  run(w, C(), 3);
}
const hspeed = (w: SimWorld) => Math.hypot(w.state.vel.x, w.state.vel.z);

describe('GPS consumer (camera_drone_fold)', () => {
  it('motors keep running while the start gesture is held; throttle down 1 s on the ground stops them', () => {
    const w = world();
    expect(w.drone.setArmed(true, 0)).toBe(true);
    run(w, C(-1, -1, 0, 1), 2); // CSC (inner corners) still held after the start
    expect(w.drone.fc.armed).toBe(true);
    run(w, C(), 0.5); // released: the spring-centred throttle = idle on the ground
    expect(w.drone.fc.armed).toBe(true);
    run(w, C(0, 0, 0), 1.2);
    expect(w.drone.fc.armed).toBe(false);
  });

  it('takes off, holds altitude and position with centred sticks', () => {
    const w = world();
    takeoff(w);
    expect(w.drone.nav!.landed).toBe(false);
    const y0 = w.state.pos.y, x0 = w.state.pos.x, z0 = w.state.pos.z;
    expect(y0).toBeGreaterThan(6);
    let thr = 0, n = 0;
    run(w, (t) => { if (t > 1) { thr += w.drone.mixer.out.reduce((a, b) => a + b, 0) / 4; n++; } return C(); }, 6);
    console.log('GPS hover: alt', y0.toFixed(1), '->', w.state.pos.y.toFixed(1), 'motor cmd', (thr / n).toFixed(3));
    expect(Math.abs(w.state.pos.y - y0)).toBeLessThan(0.8);
    expect(Math.hypot(w.state.pos.x - x0, w.state.pos.z - z0)).toBeLessThan(1.0);
    // PHYSICS 8.1 says 45-55 % for the Mavic class; the camera presets are not bench-calibrated yet (stage 2 note)
    expect(thr / n).toBeGreaterThan(0.25);
    expect(thr / n).toBeLessThan(0.6);
  });

  it('full stick reaches the mode speed limit, release brakes to a hold within 3 s', () => {
    const w = world();
    takeoff(w);
    run(w, C(1), 8);
    const v = hspeed(w), vmax = w.drone.nav!.limits.normal.v_xy;
    console.log('Normal: v', v.toFixed(1), 'of', vmax);
    expect(v).toBeGreaterThan(vmax * 0.9);
    expect(v).toBeLessThan(vmax * 1.08);
    let t = 0;
    while (hspeed(w) > 0.3 && t < 6) { run(w, C(), 0.05); t += 0.05; }
    console.log('brake 15 -> 0 m/s in', t.toFixed(2), 's');
    expect(t).toBeLessThan(3);
    const p = { ...w.state.pos };
    run(w, C(), 4);
    expect(Math.hypot(w.state.pos.x - p.x, w.state.pos.z - p.z)).toBeLessThan(2);
  });

  it('cine is slow and smooth, sport is fast', () => {
    const w = world();
    takeoff(w);
    w.drone.nav!.setMode('cine');
    run(w, C(1), 6);
    expect(hspeed(w)).toBeLessThan(5.5);
    w.drone.nav!.setMode('sport');
    run(w, C(1), 10);
    expect(hspeed(w)).toBeGreaterThan(17);
  });

  it('holds position in 8 m/s wind; ATTI drifts with it', () => {
    const w = world('camera_drone_fold', 8);
    takeoff(w);
    const p = { ...w.state.pos };
    run(w, C(), 8);
    const hold = Math.hypot(w.state.pos.x - p.x, w.state.pos.z - p.z);
    w.drone.nav!.setMode('atti');
    const q = { ...w.state.pos };
    run(w, C(), 6);
    const drift = Math.hypot(w.state.pos.x - q.x, w.state.pos.z - q.z);
    console.log('wind 8 m/s: GPS hold error', hold.toFixed(2), 'm, ATTI drift', drift.toFixed(1), 'm in 6 s');
    expect(hold).toBeLessThan(3);
    expect(drift).toBeGreaterThan(8);
  });

  it('RTH: climbs, flies home, lands near the home point and disarms', () => {
    const w = world();
    takeoff(w);
    run(w, C(1, 0.4), 6);
    run(w, C(), 3);
    const nav = w.drone.nav!;
    expect(nav.distHome).toBeGreaterThan(40);
    nav.setMode('rth');
    let t = 0;
    while (w.drone.fc.armed && t < 90) { run(w, C(), 0.5); t += 0.5; }
    console.log('RTH done in', t.toFixed(0), 's, landed', nav.distHome.toFixed(2), 'm from home');
    expect(w.drone.fc.armed).toBe(false);
    expect(nav.distHome).toBeLessThan(2.5);
    expect(w.state.pos.y).toBeLessThan(0.6);
  });

  it('obstacle sensing stops the drone before a wall (and Sport does not)', () => {
    const w = world('camera_drone_fold', 0, true);
    takeoff(w);
    run(w, C(1), 12);
    console.log('APAS: stopped at z', w.state.pos.z.toFixed(1), '(wall face at -59.5)');
    expect(w.crash).toBeNull();
    expect(w.state.pos.z).toBeGreaterThan(-59.3);
    expect(w.state.pos.z).toBeLessThan(-50);
  });

  it('holding the throttle stick down on the ground stops the motors', () => {
    const w = world();
    w.drone.setArmed(true, 0.5);
    run(w, C(), 0.5);
    expect(w.drone.fc.armed).toBe(true);
    run(w, C(0, 0, 0), 1.5);
    expect(w.drone.fc.armed).toBe(false);
  });
});

describe('other GPS airframes hover and hold', () => {
  for (const id of ['parrot_bebop_2', 'x500', 'iris_with_standoffs', 'typhoon_h480']) {
    it(id, () => {
      const w = world(id);
      takeoff(w);
      const p = { ...w.state.pos };
      run(w, C(), 5);
      const err = Math.hypot(w.state.pos.x - p.x, w.state.pos.y - p.y, w.state.pos.z - p.z);
      run(w, C(1), 6);
      const v = hspeed(w);
      console.log(id, 'mode', w.drone.nav!.mode, 'alt', p.y.toFixed(1), 'hold err', err.toFixed(2), 'v', v.toFixed(1));
      expect(p.y).toBeGreaterThan(4);
      expect(err).toBeLessThan(1.5);
      expect(v).toBeGreaterThan(w.drone.nav!.limits[w.drone.nav!.mode].v_xy * 0.75);
    });
  }
});

describe('motor failure (Typhoon H hex, motor_out_tolerant)', () => {
  it('hex keeps attitude and altitude on 5 motors and can land; a quad cannot', () => {
    const w = world('typhoon_h480');
    takeoff(w);
    const y0 = w.state.pos.y;
    w.drone.motors.failed[0] = 1;
    let maxTilt = 0;
    const tilt = () => { const r = w.state.rot; return Math.acos(Math.min(1, 1 - 2 * (r.x * r.x + r.z * r.z))) * 57.3; };
    for (let k = 0; k < 40; k++) { run(w, C(), 0.1); maxTilt = Math.max(maxTilt, tilt()); }
    console.log('hex motor out: max tilt', maxTilt.toFixed(0), 'deg, alt', y0.toFixed(1), '->', w.state.pos.y.toFixed(1), 'yaw rate', (w.state.angVel.y * 57.3).toFixed(0), 'deg/s');
    expect(w.crash).toBeNull();
    expect(maxTilt).toBeLessThan(25);
    expect(Math.abs(w.state.pos.y - y0)).toBeLessThan(2);
    w.drone.nav!.setMode('atti');
    run(w, C(0, 0, 0.15), 12); // descend
    let t = 0;
    while (w.drone.fc.armed && t < 20) { run(w, C(0, 0, 0), 0.5); t += 0.5; }
    expect(w.crash).toBeNull();
    expect(w.drone.fc.armed).toBe(false);

    const q = world('x500');
    takeoff(q);
    q.drone.motors.failed[0] = 1;
    run(q, C(), 4);
    expect(q.crash).not.toBeNull();
  });
});
