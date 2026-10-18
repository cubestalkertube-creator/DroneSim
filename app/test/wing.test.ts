// Fixed wing (PHYSICS.md 5.5): wing coefficients, rail launch + booster, FBW-A / cruise / waypoints,
// stall (open loop) vs envelope protection, coordinated turn, parachute and belly landing.
import { beforeAll, describe, expect, it } from 'vitest';
import { SimWorld, initPhysics } from '../src/sim/world';
import type { Sticks } from '../src/sim/fc/betaflight';
import { buildModel } from '../src/sim/presets';
import { dragCoef, liftCoef } from '../src/sim/wing';
import { DEG } from '../src/sim/math';
import { preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const S = (throttle = 0, pitch = 0, roll = 0, yaw = 0): Sticks => ({ throttle, roll, pitch, yaw });
function world(wind = 0, dt = 0.001) {
  const w = new SimWorld(5, dt);
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20000, y: 0.5, z: 20000 });
  w.world.step();
  w.spawnDrone(preset('delta_wing_lm'), { x: 0, y: 0.3, z: 0 });
  if (wind) w.wind.configure({ mean_ms: wind, gust_ms: 0, dir_deg: 90 }, []);
  return w;
}
const run = (w: SimWorld, s: Sticks | ((t: number) => Sticks), sec: number, each?: () => void) => {
  const n = Math.round(sec / w.dt);
  for (let i = 0; i < n; i++) { w.step(typeof s === 'function' ? s(i * w.dt) : s); each?.(); }
};
const speed = (w: SimWorld) => Math.hypot(w.state.vel.x, w.state.vel.y, w.state.vel.z);
/** arm on the rail, full throttle fires the booster, climb out in FBW-A and settle at cruise throttle */
function launch(w: SimWorld) {
  expect(w.drone.setArmed(true, 0)).toBe(true);
  run(w, S(0), 1);
  expect(w.drone.plane!.phase).toBe('rail');
  run(w, S(1), 4);
  run(w, S(0.6, -0.15), 10);
}

describe('wing coefficients', () => {
  it('delta: linear lift, capped at CL_max, soft stall down to 0.6 CL_max, flat-plate drag', () => {
    const m = buildModel(preset('delta_wing_lm')).wing!;
    expect(liftCoef(m, 5 * DEG)).toBeCloseTo(2.6 * 5 * DEG, 6);
    expect(liftCoef(m, 25 * DEG)).toBeCloseTo(1.0, 6);
    expect(liftCoef(m, 30 * DEG)).toBeLessThan(0.85);
    expect(liftCoef(m, 40 * DEG)).toBeCloseTo(0.6 * Math.sin(80 * DEG), 2);
    expect(Math.abs(liftCoef(m, 90 * DEG))).toBeLessThan(1e-9);
    expect(liftCoef(m, -10 * DEG)).toBeCloseTo(-liftCoef(m, 10 * DEG), 6);
    expect(dragCoef(m, 90 * DEG, 0)).toBeCloseTo(0.035 + 1.2, 6);
    // VTOL (PX4 LiftDrag): post-stall slope CLa_stall
    const v = buildModel(preset('standard_vtol')).wing!;
    const cls = 0.15 + 4.75 * 19.4 * DEG;
    expect(liftCoef(v, 19.4 * DEG)).toBeCloseTo(cls, 6);
    expect(liftCoef(v, 24.4 * DEG)).toBeCloseTo(cls - 3.85 * 5 * DEG, 6);
  });
});

describe('delta wing (fixed_wing_fbw)', () => {
  it('rail launch: booster 2 s, leaves the rail and climbs out above the stall speed', () => {
    const w = world();
    w.drone.setArmed(true, 0);
    run(w, S(0), 1);
    const y0 = w.state.pos.y;
    expect(w.drone.onRail).toBe(true);
    expect(speed(w)).toBeLessThan(0.01);
    let leftRailAt = -1, minAlt = Infinity;
    run(w, S(1), 4, () => { if (leftRailAt < 0 && !w.drone.onRail) leftRailAt = w.time; if (!w.drone.onRail) minAlt = Math.min(minAlt, w.state.pos.y); });
    const pl = w.drone.plane!;
    console.log('launch: off the rail after', (leftRailAt - 1).toFixed(2), 's, v', speed(w).toFixed(1), 'm/s, alt', w.state.pos.y.toFixed(1), 'phase', pl.phase);
    expect(leftRailAt).toBeGreaterThan(0);
    expect(w.crash).toBeNull();
    expect(minAlt).toBeGreaterThan(y0 - 1);
    expect(pl.phase).toBe('flight');
    expect(pl.airspeed).toBeGreaterThan(pl.vStall);
  });

  it('cruise: holds altitude and course; top speed ~185 km/h', () => {
    const w = world();
    launch(w);
    const pl = w.drone.plane!;
    pl.setMode('cruise');
    run(w, S(0.5), 5);
    const y0 = w.state.pos.y, c0 = pl.course;
    let dy = 0;
    run(w, S(0.5), 20, () => { dy = Math.max(dy, Math.abs(w.state.pos.y - y0)); });
    console.log('cruise: v', pl.airspeed.toFixed(1), 'alt', y0.toFixed(0), 'max dev', dy.toFixed(1), 'm, course drift', ((pl.course - c0) / DEG).toFixed(1), 'deg, alpha', (w.drone.wing!.alpha / DEG).toFixed(1));
    expect(dy).toBeLessThan(5);
    expect(Math.abs(pl.course - c0)).toBeLessThan(3 * DEG);
    run(w, S(1), 40);
    console.log('full throttle:', (pl.airspeed * 3.6).toFixed(0), 'km/h, fuel', w.drone.pusher!.fuel.toFixed(2), 'l, rpm', (w.drone.pusher!.omega * 9.549).toFixed(0));
    expect(pl.airspeed * 3.6).toBeGreaterThan(185 * 0.9);
    expect(pl.airspeed * 3.6).toBeLessThan(185 * 1.1);
  });

  it('stall: full back stick at idle stalls the wing in MANUAL; FBW-A protection keeps it flying', () => {
    const fly = (mode: string) => {
      const w = world();
      launch(w);
      const pl = w.drone.plane!, wing = w.drone.wing!;
      pl.setMode('cruise');
      run(w, S(0.5, -0.5), 12); // climb
      run(w, S(0.5), 4);
      pl.setMode(mode);
      let aMax = 0, vMin = Infinity, sinkMax = 0, stalled = false;
      const y0 = w.state.pos.y;
      run(w, S(0, -1), 12, () => {
        aMax = Math.max(aMax, wing.alpha); vMin = Math.min(vMin, pl.airspeed); sinkMax = Math.max(sinkMax, -w.state.vel.y);
        stalled ||= wing.stalled;
      });
      console.log(mode, 'alt', y0.toFixed(0), 'max alpha', (aMax / DEG).toFixed(1), 'min V', vMin.toFixed(1), 'max sink', sinkMax.toFixed(1), 'stalled', stalled, 'lost', (y0 - w.state.pos.y).toFixed(0), 'm');
      return { aMax, vMin, stalled, w };
    };
    const man = fly('manual'), fbw = fly('fbw_a');
    const as = 26 * DEG;
    expect(man.stalled).toBe(true);
    expect(man.aMax).toBeGreaterThan(as);
    expect(man.vMin).toBeLessThan(31);
    expect(fbw.stalled).toBe(false);
    expect(fbw.aMax).toBeLessThan(as);
    expect(fbw.vMin).toBeGreaterThan(31 * 0.95);
    expect(fbw.w.drone.plane!.protecting).toBe(true);
  });

  it('coordinated turn in CRUISE: 180 deg at the bank limit, altitude held, then holds the new course', () => {
    const w = world();
    launch(w);
    const pl = w.drone.plane!;
    pl.setMode('cruise');
    run(w, S(0.5, -0.5), 10);
    run(w, S(0.5), 6);
    const y0 = w.state.pos.y, c0 = pl.course;
    let turned = 0, prev = pl.course, t = 0, dy = 0, bankMax = 0;
    while (turned < Math.PI && t < 40) {
      run(w, S(0.5, 0, 1), 0.1, () => {
        const r = w.state.rot; const ry = 2 * (r.x * r.y - r.w * r.z), uy = 1 - 2 * (r.x * r.x + r.z * r.z);
        bankMax = Math.max(bankMax, Math.atan2(-ry, uy));
        dy = Math.max(dy, Math.abs(w.state.pos.y - y0));
      });
      turned += Math.atan2(Math.sin(pl.course - prev), Math.cos(pl.course - prev)); prev = pl.course; t += 0.1;
    }
    console.log('turn 180 in', t.toFixed(1), 's at', pl.airspeed.toFixed(1), 'm/s, max bank', (bankMax / DEG).toFixed(0), 'deg, alt dev', dy.toFixed(1), 'm, stalled', w.drone.wing!.stalled);
    expect(turned).toBeGreaterThanOrEqual(Math.PI);
    expect(t).toBeLessThan(30);
    expect(bankMax).toBeLessThan(45 * DEG);
    expect(bankMax).toBeGreaterThan(30 * DEG);
    expect(dy).toBeLessThan(15);
    run(w, S(0.5), 3);
    const c1 = pl.course;
    run(w, S(0.5), 10);
    expect(Math.abs(Math.atan2(Math.sin(pl.course - c1), Math.cos(pl.course - c1)))).toBeLessThan(4 * DEG);
    expect(Math.abs(Math.atan2(Math.sin(pl.course - c0 - Math.PI), Math.cos(pl.course - c0 - Math.PI)))).toBeLessThan(25 * DEG);
  });

  it('waypoints: flies the route legs with a crosswind (course corrected for drift)', () => {
    const w = world(6);
    launch(w);
    const pl = w.drone.plane!;
    pl.setMode('waypoints');
    let maxXte = 0;
    run(w, S(0.5), 90, () => {
      // first leg runs north from home: cross-track = |x - home.x| once established
      if (pl.wpIndex === 0 && w.state.pos.z < pl.home.z - 600) maxXte = Math.max(maxXte, Math.abs(w.state.pos.x - pl.home.x));
    });
    console.log('waypoints: wp', pl.wpIndex, 'alt', pl.altitude.toFixed(0), 'cross-track on leg 1', maxXte.toFixed(0), 'm, heading-course', ((pl.heading - pl.course) / DEG).toFixed(1));
    expect(pl.wpIndex).toBeGreaterThanOrEqual(2);
    expect(maxXte).toBeLessThan(60);
    expect(Math.abs(pl.altitude - 150)).toBeLessThan(20);
  });

  it('parachute landing: slows down, opens, descends ~6 m/s, drifts with the wind, lands intact', () => {
    const w = world(5);
    launch(w);
    const pl = w.drone.plane!;
    pl.setMode('cruise');
    run(w, S(0.5, -0.6), 14);
    run(w, S(0.5), 3);
    expect(pl.altitude).toBeGreaterThan(60);
    pl.requestChute();
    let t = 0, sink = 0, x0 = 0;
    while (pl.phase !== 'chute' && t < 20) { run(w, S(0.5), 0.1); t += 0.1; }
    expect(pl.phase).toBe('chute');
    x0 = w.state.pos.x;
    t = 0;
    while (pl.phase === 'chute' && t < 120) { run(w, S(0.5), 0.1); t += 0.1; if (w.drone.chute >= 1 && w.state.pos.y > 5) sink = -w.state.vel.y; }
    console.log('parachute: descent', sink.toFixed(1), 'm/s, drift', (w.state.pos.x - x0).toFixed(0), 'm in', t.toFixed(0), 's, crash', w.crash, 'phase', pl.phase);
    expect(w.crash).toBeNull();
    expect(pl.phase).toBe('landed');
    expect(w.drone.fc.armed).toBe(false);
    expect(sink).toBeGreaterThan(4); expect(sink).toBeLessThan(8);
    expect(w.state.pos.x - x0).toBeLessThan(-20); // wind from the east (dir_deg 90 = where it blows from): drifts west (-X)
  });

  it('belly landing: idle glide in FBW-A, flare, slides to a stop', () => {
    const w = world();
    launch(w);
    const pl = w.drone.plane!;
    run(w, S(0.5), 6);
    let t = 0, sinkTd = 0, touched = false;
    while (pl.phase === 'flight' && t < 120) {
      const flare = w.drone.tele.groundDist < 6 ? -0.6 : 0;
      run(w, S(0, flare), 0.05, () => { if (!touched && w.drone.tele.groundDist < 0.1) { touched = true; sinkTd = -w.state.vel.y; } });
      t += 0.05;
    }
    console.log('belly landing: touchdown sink', sinkTd.toFixed(1), 'm/s, crash', w.crash, 'phase', pl.phase, 'after', t.toFixed(0), 's');
    expect(w.crash).toBeNull();
    expect(pl.phase).toBe('landed');
    expect(sinkTd).toBeLessThan(5);
  });
});
