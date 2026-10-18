// Academy (PLAN.md 8.1): trick detector, lesson runner logic and grading, lesson routes free of map geometry,
// and the "hover" lesson flown end-to-end by a scripted pilot on the real GPS physics.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { SimWorld, initPhysics } from '../src/sim/world';
import type { Sticks } from '../src/sim/fc/betaflight';
import { TrickDetector, type TrickName } from '../src/game/academy/tricks';
import { LessonRunner, crossedGate, gateQuat, groundHeight, heading, type LessonDef, type LessonEnv, type LessonFrame, type Target } from '../src/game/academy/runner';
import { LESSON_DEFS, lessonUnlocked, nextLesson } from '../src/game/academy/lessons';
import { LESSONS } from '../src/ui/catalog';
import { layout, preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

// ------------------------------------------------------------------------------------------------ tricks
/** feed the detector a manoeuvre: body rotation about `axis` by `deg` over `sec`, with a path function */
function manoeuvre(det: TrickDetector, parts: { axis: 'x' | 'z'; deg: number; sec: number }[], path: (t: number) => { vel: THREE.Vector3; alt: number }) {
  const q = new THREE.Quaternion(), dq = new THREE.Quaternion(), ax = { x: new THREE.Vector3(1, 0, 0), z: new THREE.Vector3(0, 0, 1) };
  const hz = 200, found: TrickName[] = [];
  let t = 0;
  const feed = () => { const p = path(t); const e = det.update(t, q, p.vel, p.alt); if (e) found.push(e.name); t += 1 / hz; };
  for (let i = 0; i < 20; i++) feed(); // level flight before
  for (const p of parts) {
    const n = Math.round(p.sec * hz), step = ((p.deg / n) * Math.PI) / 180;
    for (let i = 0; i < n; i++) { q.multiply(dq.setFromAxisAngle(ax[p.axis], step)); feed(); }
  }
  for (let i = 0; i < 40; i++) feed(); // level after
  return found;
}
const still = () => ({ vel: new THREE.Vector3(), alt: 15 });

describe('trick detector', () => {
  it('flip and roll in place', () => {
    expect(manoeuvre(new TrickDetector(), [{ axis: 'x', deg: -360, sec: 0.6 }], still)).toEqual(['flip']);
    expect(manoeuvre(new TrickDetector(), [{ axis: 'z', deg: 360, sec: 0.5 }], still)).toEqual(['roll']);
  });
  it('a nose-up loop at speed with a climb is a power loop', () => {
    const path = (t: number) => ({ vel: new THREE.Vector3(0, 0, -12), alt: 10 + 6 * Math.sin(Math.min(Math.PI, Math.max(0, (t - 0.1) / 1.5) * Math.PI)) });
    expect(manoeuvre(new TrickDetector(), [{ axis: 'x', deg: 360, sec: 1.5 }], path)).toEqual(['power_loop']);
  });
  it('half roll + half loop down that reverses the flight is a split-S', () => {
    // 0.1 s level, 0.4 s half roll, 0.8 s pull through; flying -Z before, +Z after, 8 m lost
    const path = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - 0.5) / 0.8));
      return { vel: new THREE.Vector3(0, 0, -10 * Math.cos(k * Math.PI)), alt: 20 - 8 * k };
    };
    expect(manoeuvre(new TrickDetector(), [{ axis: 'z', deg: 180, sec: 0.4 }, { axis: 'x', deg: 180, sec: 0.8 }], path)).toEqual(['split_s']);
  });
  it('wobbles and a half flip are nothing', () => {
    expect(manoeuvre(new TrickDetector(), [{ axis: 'x', deg: 40, sec: 0.3 }, { axis: 'x', deg: -80, sec: 0.5 }, { axis: 'x', deg: 40, sec: 0.3 }], still)).toEqual([]);
    expect(manoeuvre(new TrickDetector(), [{ axis: 'z', deg: 180, sec: 0.4 }], still)).toEqual([]); // half roll
  });
});

// ------------------------------------------------------------------------------------------------ runner
function frame(p: Partial<LessonFrame> = {}): LessonFrame {
  return {
    t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Quaternion(), armed: false, mode: 'normal', crashed: false, hit: 0,
    landed: true, sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, mAh: 0, soc: 1, cutoff: false, vtolPhase: null, ...p,
  };
}
const env0: LessonEnv = { layout: layout('training_field'), home: new THREE.Vector3(), ground: () => 0 };

describe('lesson runner', () => {
  const def: LessonDef = {
    id: 't', title: 'T', brief: '', drone: 'x', map: 'y',
    build: () => ({
      steps: [
        { text: 'arm', done: (f) => f.armed },
        { text: 'up', done: (f, c) => c.alt(f) > 2, hold: 1, trackAlt: 3 },
        { text: 'land', done: (f) => f.landed },
      ],
    }),
    criteria: [{ label: 'time', get: (m) => m.time, fmt: (v) => v.toFixed(0), two: 10, three: 5 }],
  };

  it('walks the steps, holds, times from the first arm and grades', () => {
    const r = new LessonRunner(def, env0);
    r.update(frame({ t: 0 })); r.update(frame({ t: 1 }));
    expect(r.index).toBe(0);
    r.update(frame({ t: 2, armed: true }));
    expect(r.index).toBe(1);
    for (let t = 2.1; t < 2.95; t += 0.1) r.update(frame({ t, armed: true, landed: false, pos: new THREE.Vector3(0, 2.5, 0) }));
    expect(r.index).toBe(1);
    expect(r.progress).toBeGreaterThan(0.6);
    for (let t = 3; t < 3.4; t += 0.1) r.update(frame({ t, armed: true, landed: false, pos: new THREE.Vector3(0, 2.5, 0) }));
    expect(r.index).toBe(2);
    r.update(frame({ t: 5.5, armed: true, landed: true }));
    expect(r.state).toBe('done');
    expect(r.result!.time).toBeCloseTo(3.5, 5);
    expect(r.result!.stars).toBe(3);
    expect(r.metrics.altRmse).toBeCloseTo(0.5, 2);
  });

  it('a continuous hold resets on a gap; a crash fails the lesson', () => {
    const d2: LessonDef = { ...def, build: () => ({ steps: [{ text: 'in', done: (f) => f.pos.x < 1, hold: 1, continuous: true }] }) };
    const r = new LessonRunner(d2, env0);
    r.update(frame({ t: 0 })); r.update(frame({ t: 0.8 }));
    expect(r.progress).toBeCloseTo(0.8, 5);
    r.update(frame({ t: 0.9, pos: new THREE.Vector3(5, 0, 0) }));
    expect(r.held).toBe(0);
    r.update(frame({ t: 1.0, crashed: true }));
    expect(r.state).toBe('failed');
    expect(r.result!.stars).toBe(0);
    expect(r.result!.reason).toBe('Краш');
    r.restart();
    expect(r.state).toBe('running');
    expect(r.index).toBe(0);
  });

  it('helpers: heading, gate crossing, heightfield', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    expect(heading(q)).toBeCloseTo(Math.PI / 2, 5); // nose to -X
    const g = { c: new THREE.Vector3(0, 2, -10), q: gateQuat(0, -1), w: 2, h: 2 };
    expect(crossedGate(new THREE.Vector3(0, 2, -9), new THREE.Vector3(0, 2.3, -11), g)).toBe(true);
    expect(crossedGate(new THREE.Vector3(0, 4, -9), new THREE.Vector3(0, 4, -11), g)).toBe(false);
    expect(crossedGate(new THREE.Vector3(0, 2, -8), new THREE.Vector3(0, 2, -9), g)).toBe(false);
    const L = layout('training_field');
    expect(Math.abs(groundHeight(L, 30, -40))).toBeLessThan(0.7);
    expect(groundHeight(L, 240, 240)).toBeGreaterThan(10); // the field's rim rises
  });

  it('lessons unlock in order', () => {
    const stars: Record<string, number> = { sticks: 2 };
    const s = (id: string) => stars[id] ?? 0;
    expect(lessonUnlocked('sticks', s)).toBe(true);
    expect(lessonUnlocked('hover', s)).toBe(true);
    expect(lessonUnlocked('orient', s)).toBe(false);
    expect(nextLesson('sticks')).toBe('hover');
    expect(nextLesson('wing')).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ routes
/** home of a lesson the way game/flight.ts computes it */
function lessonEnv(def: LessonDef): LessonEnv {
  const L = layout(def.map), sp = def.spawn ?? 0;
  const home = typeof sp === 'number' ? new THREE.Vector3(...L.spawns[sp].pos) : new THREE.Vector3(sp.x, groundHeight(L, sp.x, sp.z), sp.z);
  return { layout: L, home, ground: (x, z) => groundHeight(L, x, z) };
}
const aim = (t: Target) => (t.kind === 'pad' ? t.c.clone().add(new THREE.Vector3(0, 1.5, 0)) : t.c.clone());

describe('lesson routes', () => {
  it('every catalog lesson has a script', () => {
    for (const l of LESSONS) expect(LESSON_DEFS[l.id], l.id).toBeDefined();
  });

  for (const def of Object.values(LESSON_DEFS)) {
    it(`${def.id}: targets are in free space and the straight path between them is unobstructed`, () => {
      const env = lessonEnv(def);
      const w = new SimWorld(1);
      w.loadMap(env.layout);
      const { steps } = def.build(env);
      const pts = [env.home.clone().add(new THREE.Vector3(0, 1.5, 0))];
      for (const s of steps) if (s.targets?.length) pts.push(aim(s.targets[0]));
      const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
      for (let i = 0; i < pts.length; i++) {
        let inside = false;
        w.world.intersectionsWithPoint(pts[i], () => { inside = true; return false; });
        expect(inside, `${def.id}: point ${i} ${pts[i].toArray().map((v) => v.toFixed(1))} inside geometry`).toBe(false);
        if (!i) continue;
        const a = pts[i - 1], b = pts[i], d = b.clone().sub(a), len = d.length();
        if (len < 1e-3) continue;
        ray.origin = a; ray.dir = d.divideScalar(len);
        const hit = w.world.castRay(ray, len, true);
        expect(hit, `${def.id}: segment ${i - 1}→${i} blocked at ${hit?.timeOfImpact.toFixed(1)} of ${len.toFixed(1)} m`).toBeNull();
      }
    });
  }
});

// ------------------------------------------------------------------------------------------------ flown lesson
describe('hover lesson on the GPS physics', () => {
  it('a scripted pilot takes off, holds the circle, lands on the second pad: done with stars', () => {
    const def = LESSON_DEFS.hover, env = lessonEnv(def);
    const w = new SimWorld(5);
    w.loadMap(env.layout);
    const L = env.layout;
    w.spawnDrone(preset(def.drone), { x: env.home.x, y: env.home.y + 0.3, z: env.home.z });
    w.drone.nav!.setMode('normal');
    const r = new LessonRunner(def, env);
    const pad = new THREE.Vector3(...L.spawns[1].pos);
    const f = frame();
    const sticks: Sticks = { throttle: 0.5, roll: 0, pitch: 0, yaw: 0 };
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    let armedOnce = false;
    for (let i = 0; i < 90_000 && r.state === 'running'; i++) {
      w.step(sticks);
      if (i % 16) continue; // pilot + lesson at ~60 Hz
      const s = w.state, nav = w.drone.nav!;
      f.t = w.time; f.pos.set(s.pos.x, s.pos.y, s.pos.z); f.vel.set(s.vel.x, s.vel.y, s.vel.z); f.rot.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
      f.armed = w.drone.fc.armed; f.landed = nav.landed; f.crashed = !!w.crash; f.hit = w.lastImpulse; f.mAh = w.drone.battery.mAh; f.soc = w.drone.battery.soc;
      r.update(f);
      const alt = f.pos.y - env.home.y;
      sticks.roll = sticks.pitch = 0; sticks.throttle = 0.5;
      switch (r.index) {
        case 0: if (!armedOnce) { armedOnce = w.drone.setArmed(true, 0.5); } break;
        case 1: sticks.throttle = 0.66; break;
        case 2: sticks.throttle = alt < 1.8 ? 0.6 : alt > 2.3 ? 0.42 : 0.5; break;
        case 3: {
          const dx = pad.x - f.pos.x, dz = pad.z - f.pos.z, d = Math.hypot(dx, dz);
          sticks.roll = clamp(dx * 0.12 - f.vel.x * 0.15); sticks.pitch = clamp(-dz * 0.12 + f.vel.z * 0.15);
          sticks.throttle = d < 0.9 && Math.hypot(f.vel.x, f.vel.z) < 0.3 ? 0.1 : 0.5;
          break;
        }
        case 4: sticks.throttle = 0; break;
      }
    }
    if (!r.result) console.log('stuck at step', r.index, w.state.pos, 'alt', w.state.pos.y - env.home.y, 'held', r.held, 'landed', w.drone.nav!.landed);
    const res = r.result!;
    if (w.crash) console.log('crash at step', r.index, JSON.stringify(w.crash), w.state.pos);
    console.log('hover lesson:', res.state, res.reason ?? '', `${res.stars}★`, res.lines.map((l) => `${l.label} ${l.value}`).join(', '));
    expect(res.state).toBe('done');
    expect(res.stars).toBeGreaterThanOrEqual(2);
    expect(r.metrics.x.land).toBeLessThan(1);
  });
});
