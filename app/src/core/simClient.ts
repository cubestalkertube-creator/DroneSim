// Main-thread side of the simulation (PLAN.md 3): the game talks to a SimClient, the physics runs either in a
// Web Worker (default: rendering, input and sound never wait for 1 kHz physics) or in the main thread
// (?worker=0, debugging, browsers without module workers).
// Transport: postMessage. Each frame the game asks for the steps its clock owes; while a request is in flight
// further steps accumulate and go with the next one (capped -> slow motion instead of a backlog). The snapshot
// carries the last two physics states, so the renderer interpolates exactly as in the single-thread loop, one
// frame later. SharedArrayBuffer would need COOP/COEP isolation, which the Capacitor WebView does not serve —
// the ~2 KB snapshot per frame is cheap to clone.
import type { Sticks } from '../sim/fc/betaflight';
import type { SimCommand, SimHost, SimInfo, SimSnapshot } from '../sim/host';
import type { FromSim, Port, SimStart } from '../sim/serve';

export interface SimClient {
  readonly kind: 'worker' | 'local';
  readonly info: SimInfo;
  /** latest snapshot; replaced (worker) or updated in place (local) after every batch */
  readonly snap: SimSnapshot;
  /** called for every new snapshot (toasts, impacts, crash) */
  onSnapshot: ((s: SimSnapshot) => void) | null;
  /** queue a command; it is applied before the next steps */
  command(c: SimCommand): void;
  /** run `steps` fixed steps with these sticks (worker: asynchronously) */
  advance(sticks: Sticks, steps: number): void;
  /** automation/tests: run now and resolve with the resulting snapshot */
  stepNow(sticks: Sticks, steps: number): Promise<SimSnapshot>;
  dispose(): void;
}

/** steps that may pile up while the worker is busy (40 ms of physics at 1 kHz) */
export const MAX_PENDING_STEPS = 40;

export class LocalSim implements SimClient {
  readonly kind = 'local' as const;
  readonly info: SimInfo;
  snap: SimSnapshot;
  onSnapshot: ((s: SimSnapshot) => void) | null = null;
  private cmds: SimCommand[] = [];

  constructor(readonly host: SimHost, droneInfo: (d: SimHost['drone']) => SimInfo) {
    this.info = droneInfo(host.drone);
    this.snap = host.handle({ cmds: [], sticks: ZERO, steps: 0 });
  }
  /** Rapier and the simulation are loaded on demand: the worker build keeps them out of the main chunk */
  static async create(start: SimStart) {
    const [{ startHost }, { droneInfo }] = await Promise.all([import('../sim/serve'), import('../sim/host')]);
    return new LocalSim(await startHost(start), droneInfo);
  }

  command(c: SimCommand) { this.cmds.push(c); }
  advance(sticks: Sticks, steps: number) {
    const cmds = this.cmds; this.cmds = [];
    this.snap = this.host.handle({ cmds, sticks, steps });
    this.onSnapshot?.(this.snap);
  }
  stepNow(sticks: Sticks, steps: number) { this.advance(sticks, steps); return Promise.resolve(this.snap); }
  dispose() {}
}

export class WorkerSim implements SimClient {
  readonly kind = 'worker' as const;
  info!: SimInfo;
  snap!: SimSnapshot;
  onSnapshot: ((s: SimSnapshot) => void) | null = null;
  /** requests sent / snapshots received, steps run by the worker (HUD / tests) */
  sent = 0; received = 0;
  private cmds: SimCommand[] = [];
  private busy = false;
  private pending = 0;
  private sticks: Sticks = { ...ZERO };
  private waiters: ((s: SimSnapshot) => void)[] = [];

  private constructor(private readonly port: Port, private readonly terminate: () => void) {}

  /** @param port a Worker running core/sim.worker.ts, or any MessagePort served by serveSim */
  static create(port: Port, start: SimStart, terminate = () => {}): Promise<WorkerSim> {
    const c = new WorkerSim(port, terminate);
    return new Promise((resolve, reject) => {
      port.onmessage = (e) => {
        const m = e.data as FromSim;
        if (m.type === 'ready') { c.info = m.info; c.snap = m.snap; port.onmessage = (ev) => c.receive(ev.data as FromSim); resolve(c); }
        else if (m.type === 'error') reject(new Error(m.message));
      };
      port.postMessage({ type: 'init', start });
    });
  }

  command(c: SimCommand) { this.cmds.push(c); }

  advance(sticks: Sticks, steps: number) {
    this.sticks.throttle = sticks.throttle; this.sticks.roll = sticks.roll; this.sticks.pitch = sticks.pitch; this.sticks.yaw = sticks.yaw;
    this.pending = Math.min(MAX_PENDING_STEPS, this.pending + steps);
    this.flush();
  }

  stepNow(sticks: Sticks, steps: number): Promise<SimSnapshot> {
    return new Promise((resolve) => {
      const go = () => { this.waiters.push(resolve); this.send(sticks, steps); };
      if (!this.busy) go(); else this.waiters.push(() => go());
    });
  }

  dispose() { this.terminate(); }

  private flush() {
    if (this.busy || (!this.pending && !this.cmds.length)) return;
    const n = this.pending; this.pending = 0;
    this.send(this.sticks, n);
  }

  private send(sticks: Sticks, steps: number) {
    const cmds = this.cmds; this.cmds = [];
    this.busy = true; this.sent++;
    this.port.postMessage({ type: 'req', req: { cmds, sticks: { ...sticks }, steps } });
  }

  private receive(m: FromSim) {
    if (m.type === 'error') { console.error('sim worker:', m.message); this.busy = false; return; }
    if (m.type !== 'snap') return;
    this.busy = false; this.received++;
    this.snap = m.snap;
    this.onSnapshot?.(m.snap);
    const w = this.waiters.shift();
    if (w) w(m.snap); else this.flush();
  }
}

const ZERO: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

/** Worker by default; `?worker=0` (or no module-worker support) keeps the physics on the main thread. */
export async function createSim(start: SimStart, useWorker: boolean): Promise<SimClient> {
  if (useWorker && typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
      return await WorkerSim.create(w as unknown as Port, start, () => w.terminate());
    } catch (e) { console.warn('sim worker unavailable, physics on the main thread:', e); }
  }
  return LocalSim.create(start);
}
