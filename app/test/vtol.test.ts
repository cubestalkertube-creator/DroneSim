// Quadplane (standard_vtol, PX4 VTOL): MC take-off and hover, front transition at 15 m/s, FW cruise,
// back transition with braking, aborted transition, mission -> RTL -> vertical landing.
import { beforeAll, describe, expect, it } from 'vitest';
import { SimWorld, initPhysics } from '../src/sim/world';
import type { Sticks } from '../src/sim/fc/betaflight';
import { preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const C = (pitch = 0, roll = 0, throttle = 0.5, yaw = 0): Sticks => ({ throttle, roll, pitch, yaw });
function world(wind = 0) {
  const w = new SimWorld(7);
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20000, y: 0.5, z: 20000 });
  w.world.step();
  w.spawnDrone(preset('standard_vtol'), { x: 0, y: 0.3, z: 0 });
  if (wind) w.wind.configure({ mean_ms: wind, gust_ms: 0, dir_deg: 90 }, []);
  return w;
}
const run = (w: SimWorld, s: Sticks | ((t: number) => Sticks), sec: number, each?: () => void) => {
  const n = Math.round(sec / w.dt);
  for (let i = 0; i < n; i++) { w.step(typeof s === 'function' ? s(i * w.dt) : s); each?.(); }
};
const hspeed = (w: SimWorld) => Math.hypot(w.state.vel.x, w.state.vel.z);
function takeoff(w: SimWorld, climb = 6) {
  expect(w.drone.setArmed(true, 0.5)).toBe(true);
  run(w, C(), 0.5);
  run(w, C(0, 0, 1), climb);
  run(w, C(), 3);
}

describe('standard_vtol (px4_vtol)', () => {
  it('MC: takes off and holds position like a quad', () => {
    const w = world();
    takeoff(w);
    const v = w.drone.vtol!;
    expect(v.phase).toBe('mc');
    const p = { ...w.state.pos };
    run(w, C(), 5);
    const err = Math.hypot(w.state.pos.x - p.x, w.state.pos.y - p.y, w.state.pos.z - p.z);
    console.log('VTOL MC hover: alt', p.y.toFixed(1), 'hold err', err.toFixed(2), 'lift cmd', Array.from(w.drone.mixer.out, (c) => c.toFixed(2)).join(' '));
    expect(p.y).toBeGreaterThan(12);
    expect(err).toBeLessThan(1.5);
  });

  it('front transition above 15 m/s, FW cruise, back transition brakes to a hover', () => {
    const w = world();
    takeoff(w);
    const v = w.drone.vtol!, pl = w.drone.plane!;
    const y0 = w.state.pos.y;
    v.setMode('fw_position');
    expect(v.phase).toBe('trans_fw');
    let t = 0, dyT = 0;
    while (v.phase === 'trans_fw' && t < 20) { run(w, C(), 0.05, () => { dyT = Math.max(dyT, Math.abs(w.state.pos.y - y0)); }); t += 0.05; }
    console.log('front transition:', t.toFixed(1), 's, airspeed', pl.airspeed.toFixed(1), 'alt dev', dyT.toFixed(1), 'm');
    expect(v.phase).toBe('fw');
    expect(t).toBeLessThan(12);
    expect(dyT).toBeLessThan(6);
    // FW cruise: lift rotors stopped, wing carries the airframe
    const y1 = w.state.pos.y;
    let dyF = 0;
    run(w, C(), 15, () => { dyF = Math.max(dyF, Math.abs(w.state.pos.y - y1)); });
    const lift = Math.max(...Array.from(w.drone.omega));
    console.log('FW cruise: airspeed', pl.airspeed.toFixed(1), 'alt dev', dyF.toFixed(1), 'm, lift rotors', lift.toFixed(0), 'rad/s, pusher', w.drone.pusher!.omega.toFixed(0), 'rad/s, alpha', (w.drone.wing!.alpha * 57.3).toFixed(1), 'deg, bat', w.drone.battery.current.toFixed(1), 'A');
    expect(Math.abs(pl.airspeed - 18)).toBeLessThan(2.5);
    expect(dyF).toBeLessThan(4);
    expect(lift).toBeLessThan(20);
    // faster with the throttle stick up (centred stick = cruise)
    run(w, C(0, 0, 1), 15);
    console.log('FW full stick: airspeed', (pl.airspeed * 3.6).toFixed(0), 'km/h');
    expect(pl.airspeed).toBeGreaterThan(22);
    run(w, C(), 10);
    // back transition
    const y2 = w.state.pos.y;
    v.setMode('mc_position');
    expect(v.phase).toBe('trans_mc');
    t = 0; let dyB = 0;
    while (v.phase === 'trans_mc' && t < 20) { run(w, C(), 0.05, () => { dyB = Math.max(dyB, Math.abs(w.state.pos.y - y2)); }); t += 0.05; }
    console.log('back transition:', t.toFixed(1), 's, ground speed', hspeed(w).toFixed(1), 'alt dev', dyB.toFixed(1), 'm');
    expect(v.phase).toBe('mc');
    expect(t).toBeLessThan(10);
    expect(dyB).toBeLessThan(8);
    run(w, C(), 6);
    const p = { ...w.state.pos };
    run(w, C(), 4);
    expect(Math.hypot(w.state.pos.x - p.x, w.state.pos.z - p.z)).toBeLessThan(1.5);
    expect(w.crash).toBeNull();
  });

  it('transition aborts back to MC when the airspeed does not come (pusher failure)', () => {
    const w = world();
    takeoff(w);
    const v = w.drone.vtol!;
    (w.drone.pusher!.m as { max_rad_s: number }).max_rad_s = 300; // weak pusher: never reaches 15 m/s
    v.setMode('fw_position');
    run(w, C(), 22);
    console.log('aborted transition:', v.event, 'phase', v.phase, 'airspeed', w.drone.plane!.airspeed.toFixed(1));
    expect(v.phase).toBe('mc');
    expect(v.event).toMatch(/прерван/);
    expect(w.crash).toBeNull();
  });

  it('mission: route in FW, then RTL: back transition near home and a vertical landing', () => {
    const w = world(4);
    takeoff(w, 8);
    const v = w.drone.vtol!, pl = w.drone.plane!;
    v.setMode('mission');
    let t = 0, maxWp = 0;
    while (w.drone.fc.armed && t < 300) { run(w, C(), 0.5); t += 0.5; maxWp = Math.max(maxWp, pl.wpIndex); }
    const nav = w.drone.nav!;
    console.log('mission: done in', t.toFixed(0), 's, max wp', maxWp, 'landed', nav.distHome.toFixed(1), 'm from home, crash', w.crash);
    expect(maxWp).toBe(3);
    expect(w.crash).toBeNull();
    expect(w.drone.fc.armed).toBe(false);
    expect(nav.distHome).toBeLessThan(3);
    expect(w.state.pos.y).toBeLessThan(0.6);
  });
});
