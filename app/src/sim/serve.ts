// Message protocol between the game (main thread) and the simulation (Web Worker): see host.ts.
// `serveSim` runs on the simulation side of any MessagePort-like channel (a Worker's global scope, a
// MessageChannel port in tests); the client is core/simClient.ts.
import { initPhysics } from './world';
import { SimHost, droneInfo, type SimCommand, type SimInfo, type SimInit, type SimRequest, type SimSnapshot } from './host';
import type { Q4, V3 } from './math';

export interface SimStart extends SimInit { boxes: { c: V3; h: V3; q: Q4 }[]; spawn: { pos: V3; rot: Q4 } }

export type ToSim = { type: 'init'; start: SimStart } | { type: 'req'; req: SimRequest };
export type FromSim = { type: 'ready'; info: SimInfo; snap: SimSnapshot } | { type: 'snap'; snap: SimSnapshot } | { type: 'error'; message: string };

export interface Port {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

/** Build the host: map, static boxes from the props, the drone at its spawn point. */
export async function startHost(start: SimStart): Promise<SimHost> {
  await initPhysics();
  const host = new SimHost(start);
  const cmds: SimCommand[] = [{ t: 'boxes', boxes: start.boxes }, { t: 'spawn', pos: start.spawn.pos, rot: start.spawn.rot }];
  for (const c of cmds) host.apply(c);
  return host;
}

export function serveSim(port: Port) {
  let host: SimHost | null = null;
  const post = (m: FromSim) => port.postMessage(m);
  port.onmessage = (e) => {
    const msg = e.data as ToSim;
    if (msg.type === 'init') {
      startHost(msg.start).then((h) => {
        host = h;
        post({ type: 'ready', info: droneInfo(h.drone), snap: h.handle({ cmds: [], sticks: { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, steps: 0 }) });
      }).catch((err) => post({ type: 'error', message: String(err) }));
    } else if (msg.type === 'req' && host) {
      try { post({ type: 'snap', snap: host.handle(msg.req) }); } catch (err) { post({ type: 'error', message: String(err) }); }
    }
  };
}
