// Kamikaze charge (presets with `warhead`): contact fuse above fuse_speed_ms while armed, the detonate command,
// what is left after the blast (motors stopped, body frozen) and the reset. Visual effect only: no targets.
import { beforeAll, describe, expect, it } from 'vitest';
import { SimWorld, initPhysics } from '../src/sim/world';
import { SimHost } from '../src/sim/host';
import { buildModel } from '../src/sim/presets';
import type { Sticks } from '../src/sim/fc/betaflight';
import { layout, preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const S = (throttle = 0, roll = 0, pitch = 0, yaw = 0): Sticks => ({ throttle, roll, pitch, yaw });
function flat(id: string, y: number) {
  const w = new SimWorld();
  w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 500, y: 0.5, z: 500 });
  w.spawnDrone(preset(id), { x: 0, y, z: 0 });
  return w;
}
const run = (w: SimWorld, s: Sticks, sec: number) => { for (let i = 0; i < sec / w.dt; i++) w.step(s); };

describe('kamikaze presets', () => {
  it('FPV kamikaze still hovers with the payload (TWR > 2)', () => {
    for (const id of ['fpv_7in_kamikaze', 'fpv_10in_kamikaze']) {
      const p = preset(id), m = buildModel(p);
      expect(p.warhead!.mass).toBeLessThan(p.mass);
      const maxThrust = 4 * m.kT0 * m.omegaMax ** 2;
      expect(maxThrust / (p.mass * 9.81)).toBeGreaterThan(2);
    }
  });
});

describe('contact fuse', () => {
  it('a dive into the ground at speed sets the charge off', () => {
    const w = flat('fpv_7in_kamikaze', 30);
    expect(w.drone.setArmed(true, 0)).toBe(true);
    expect(w.fuseArmed).toBe(true);
    run(w, S(0.05), 4); // falls from 30 m: ~20 m/s at the ground
    expect(w.blast).not.toBeNull();
    expect(w.blast!.cause).toBe('impact');
    expect(w.blast!.speed).toBeGreaterThan(preset('fpv_7in_kamikaze').warhead!.fuse_speed_ms);
    expect(w.drone.fc.armed).toBe(false);
    expect(Math.max(...w.drone.visOmega)).toBe(0);
    const p = { ...w.state.pos };
    run(w, S(1), 0.5); // nothing left to fly
    expect(w.state.pos).toEqual(p);
  });

  it('a soft landing does not', () => {
    const w = flat('fpv_7in_kamikaze', 0.1);
    w.drone.setArmed(true, 0);
    run(w, S(0.3), 2);
    expect(w.blast).toBeNull();
  });

  it('disarmed: the charge is safe even at speed', () => {
    const w = flat('fpv_7in_kamikaze', 30);
    run(w, S(0), 4);
    expect(w.blast).toBeNull();
    expect(w.crash).not.toBeNull();
  });

  it('drones without a warhead never explode', () => {
    const w = flat('fpv_7in_longrange', 30);
    w.drone.setArmed(true, 0);
    run(w, S(0.05), 4);
    expect(w.blast).toBeNull();
    expect(w.detonate('command')).toBe(false);
  });
});

describe('detonate command (SimHost)', () => {
  const host = () => {
    const h = new SimHost({ preset: preset('fpv_7in_kamikaze'), layout: layout('training_field'), seed: 1, dt: 0.001 });
    h.apply({ t: 'spawn', pos: { x: 0, y: 5, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } });
    return h;
  };
  it('needs the motors armed, then goes off at once; reset brings the drone back', () => {
    const h = host();
    let s = h.handle({ cmds: [{ t: 'detonate' }], sticks: S(), steps: 1 });
    expect(s.blast).toBeNull();
    expect(s.toasts.some((t) => /не взведён/.test(t.text))).toBe(true);
    s = h.handle({ cmds: [{ t: 'arm', throttle: 0 }], sticks: S(), steps: 1 });
    expect(s.fuse).toBe(true);
    s = h.handle({ cmds: [{ t: 'detonate' }], sticks: S(), steps: 1 });
    expect(s.blast?.cause).toBe('command');
    expect(s.blastNew).toBe(true);
    expect(s.armed).toBe(false);
    s = h.handle({ cmds: [{ t: 'arm', throttle: 0 }], sticks: S(), steps: 1 });
    expect(s.armed).toBe(false);
    expect(s.blastNew).toBe(false);
    s = h.handle({ cmds: [{ t: 'reset', pos: { x: 0, y: 0.5, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } }], sticks: S(), steps: 10 });
    expect(s.blast).toBeNull();
    expect(s.pos.y).toBeLessThan(0.6);
  });
});

describe('Shahed strike', () => {
  it('rail launch, then a dive into the ground at speed sets it off; no parachute', () => {
    const w = new SimWorld(5, 0.002);
    w.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20000, y: 0.5, z: 20000 });
    w.world.step();
    w.spawnDrone(preset('shahed_136_strike'), { x: 0, y: 0.3, z: 0 });
    expect(preset('shahed_136_strike').recovery).toBeUndefined();
    expect(w.drone.setArmed(true, 0)).toBe(true);
    run(w, S(0), 1);
    expect(w.fuseArmed).toBe(false); // on the rail
    run(w, S(1), 4);
    expect(w.fuseArmed).toBe(true);
    run(w, S(0.8, 0, 1), 30); // stick forward: nose down
    expect(w.blast?.cause).toBe('impact');
    expect(w.blast!.speed).toBeGreaterThan(15);
  });
});
