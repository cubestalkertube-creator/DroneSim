// Physics behind the message boundary (PLAN.md 3): the worker protocol over a real MessageChannel gives the
// same, bit-identical trajectory as stepping SimWorld directly; commands, toasts and pending-step batching.
import { beforeAll, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { SimWorld, initPhysics } from '../src/sim/world';
import { serveSim, type Port, type SimStart } from '../src/sim/serve';
import { LocalSim, WorkerSim, MAX_PENDING_STEPS } from '../src/core/simClient';
import type { Sticks } from '../src/sim/fc/betaflight';
import { layout, preset } from './helpers';

beforeAll(async () => { await initPhysics(); });

const start = (id: string): SimStart => ({
  preset: preset(id), layout: layout('training_field'), seed: 3, dt: 0.001,
  boxes: [{ c: { x: 20, y: 1, z: 20 }, h: { x: 1, y: 1, z: 1 }, q: { x: 0, y: 0, z: 0, w: 1 } }],
  spawn: { pos: { x: 30, y: 0.25, z: -40 }, rot: { x: 0, y: 0, z: 0, w: 1 } },
});
/** a scripted flight: frames of (sticks, steps) like the render loop produces */
const script = (k: number): [Sticks, number] => [{ throttle: k < 20 ? 0 : 0.45, roll: k > 60 && k < 80 ? 0.4 : 0, pitch: k > 90 ? 0.2 : 0, yaw: 0 }, 16 + (k % 3)];

/** Node's MessagePort as the browser-style Port (onmessage receives {data}) */
function nodePort(p: import('node:worker_threads').MessagePort): Port {
  let handler: Port['onmessage'] = null;
  p.on('message', (data) => handler?.({ data }));
  return {
    postMessage: (m) => p.postMessage(m),
    get onmessage() { return handler; },
    set onmessage(h) { handler = h; },
  };
}

describe('simulation in a worker (message protocol)', () => {
  it('worker trajectory is bit-identical to the direct SimWorld run', async () => {
    const st = start('fpv_5in_freestyle');
    // direct reference
    const ref = new SimWorld(st.seed, st.dt);
    ref.loadMap(st.layout);
    for (const b of st.boxes) ref.addStaticBox(b.c, b.h, b.q);
    ref.spawnDrone(st.preset, st.spawn.pos, st.spawn.rot);
    ref.drone.fc.mode = 'angle';
    // worker over a MessageChannel
    const { port1, port2 } = new MessageChannel();
    serveSim(nodePort(port2));
    const w = await WorkerSim.create(nodePort(port1), st, () => { port1.close(); port2.close(); });
    w.command({ t: 'mode_index', i: 1 });
    w.command({ t: 'arm', throttle: 0 });
    ref.drone.setArmed(true, 0);
    let snap = w.snap;
    for (let k = 0; k < 120; k++) {
      const [s, n] = script(k);
      snap = await w.stepNow(s, n);
      for (let i = 0; i < n; i++) ref.step(s);
    }
    console.log('worker vs direct after', snap.time.toFixed(3), 's: pos', snap.pos.x.toFixed(4), snap.pos.y.toFixed(4), snap.pos.z.toFixed(4));
    expect(snap.armed).toBe(true);
    expect(snap.pos.y).toBeGreaterThan(1);
    expect(snap.pos).toEqual({ ...ref.state.pos });
    expect(snap.rot).toEqual({ ...ref.state.rot });
    expect(Array.from(snap.omega)).toEqual(Array.from(ref.drone.visOmega));
    expect(snap.time).toBeCloseTo(ref.time, 12);
    w.dispose();
  });

  it('local and worker clients agree; toasts and pending steps are batched', async () => {
    const st = start('delta_wing_lm');
    const local = await LocalSim.create(st);
    const { port1, port2 } = new MessageChannel();
    serveSim(nodePort(port2));
    const w = await WorkerSim.create(nodePort(port1), st, () => { port1.close(); port2.close(); });
    expect(w.info).toEqual(local.info);
    expect(w.info.plane).toBe(true);
    const toasts: string[] = [];
    w.onSnapshot = (s) => toasts.push(...s.toasts.map((t) => t.text));
    // arming with the throttle up is refused (toast), then accepted
    w.command({ t: 'arm', throttle: 1 }); local.command({ t: 'arm', throttle: 1 });
    await w.stepNow({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, 1); local.advance({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, 1);
    expect(toasts.join()).toMatch(/Арм заблокирован/);
    w.command({ t: 'arm', throttle: 0 }); local.command({ t: 'arm', throttle: 0 });
    for (let k = 0; k < 200; k++) {
      const s: Sticks = { throttle: k < 50 ? 0 : 1, roll: 0, pitch: 0, yaw: 0 };
      await w.stepNow(s, 20); local.advance(s, 20);
    }
    expect(w.snap.plane!.phase).toBe('flight');
    expect(w.snap.pos).toEqual(local.snap.pos);
    // while a request is in flight further steps accumulate (capped) and go with the next one
    const sent = w.sent;
    w.advance({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, 10);
    w.advance({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, 30);
    w.advance({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, 30);
    expect(w.sent).toBe(sent + 1);
    const t0 = w.snap.time;
    await new Promise((r) => setTimeout(r, 50));
    await w.stepNow({ throttle: 1, roll: 0, pitch: 0, yaw: 0 }, 0);
    expect(w.sent).toBe(sent + 3);
    expect(w.snap.time - t0).toBeCloseTo((10 + MAX_PENDING_STEPS) * 0.001, 9);
    w.dispose();
  });
});
