// Gate race / time trial (PLAN.md 8.2): ordered gates from the map layout, plane-crossing detection with the exact
// (sub-frame) crossing time, lap timer, splits per gate against the best lap, missed gates (time penalty or the lap
// does not count), and the "ghost" of the best lap: the pose recorded at a fixed 50 Hz during the lap and played back
// in sync with the current one. Pure logic on top of three.js maths (no scene access except the gate marker).
import * as THREE from 'three';
import type { Gate } from '../sim/layout';

interface GateRt { c: THREE.Vector3; inv: THREE.Quaternion; w: number; h: number }

/** What a skipped gate costs: seconds added to the lap, or the lap is not counted (no best lap, no ghost). */
export type MissRule = 'penalty' | 'dnf';
/** time trial rule (game design, not physics): seconds per missed gate */
export const MISS_PENALTY_S = 3;
/** ghost sample rate */
export const GHOST_HZ = 50;

/** A recorded lap: pose at GHOST_HZ from the lap start (7 numbers per frame: x y z qx qy qz qw) + its splits. */
export interface GhostData { hz: number; lap: number; splits: number[]; frames: number[] }

export interface LapResult {
  /** counted time (raw + penalty); NaN for a lap that does not count */
  time: number; raw: number; penalty: number; missed: number;
  valid: boolean; best: boolean;
  /** split times (s from the lap start, penalty included) per checkpoint; NaN = gate missed */
  splits: number[];
  /** the lap's ghost (only for a new best) */
  ghost: GhostData | null;
}

/** Fixed-rate pose recorder: raw samples at frame times in, interpolated GHOST_HZ frames out. */
export class GhostRecorder {
  private a = { t: -Infinity, p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private b = { t: -Infinity, p: new THREE.Vector3(), q: new THREE.Quaternion() };
  private t0 = 0; private k = 0;
  private frames: number[] = [];
  recording = false;
  private tp = new THREE.Vector3(); private tq = new THREE.Quaternion();

  constructor(readonly hz = GHOST_HZ) {}

  /** latest pose (call every frame, recording or not) */
  add(t: number, p: THREE.Vector3Like, q: THREE.QuaternionLike) {
    const s = this.a; this.a = this.b; this.b = s;
    s.t = t; s.p.copy(p as THREE.Vector3); s.q.set(q.x, q.y, q.z, q.w);
    if (this.recording) this.emit();
  }

  /** start a lap at time t0 (may lie between the last two samples) */
  start(t0: number) { this.recording = true; this.t0 = t0; this.k = 0; this.frames = []; this.emit(); }

  /** stop at the lap end and return the frames (the last one covers tEnd: extrapolated by < one frame if needed) */
  finish(tEnd: number): number[] {
    if (this.t0 + (this.k - 1) / this.hz < tEnd) this.emitAt(this.t0 + this.k++ / this.hz, 2);
    this.recording = false; const f = this.frames; this.frames = []; return f;
  }

  stop() { this.recording = false; this.frames = []; }

  private emit() {
    for (;;) {
      const t = this.t0 + this.k / this.hz;
      if (t > this.b.t + 1e-9) return;
      this.emitAt(t, 1);
      this.k++;
    }
  }

  /** frame at time t between the last two samples (fMax > 1: extrapolate past the latest one) */
  private emitAt(t: number, fMax: number) {
    const { a, b } = this, span = b.t - a.t;
    const f = isFinite(span) && span > 1e-9 ? Math.min(fMax, Math.max(0, (t - a.t) / span)) : 1;
    this.tp.lerpVectors(a.p, b.p, f);
    this.tq.slerpQuaternions(a.q, b.q, f);
    this.frames.push(this.tp.x, this.tp.y, this.tp.z, this.tq.x, this.tq.y, this.tq.z, this.tq.w);
  }
}

/** Plays a recorded lap back: pose at time t from the lap start (interpolated between frames). */
export class GhostPlayer {
  readonly duration: number;
  private qa = new THREE.Quaternion(); private qb = new THREE.Quaternion();
  constructor(readonly data: GhostData) { this.duration = (data.frames.length / 7 - 1) / data.hz; }

  /** false outside the recording (before the lap start or after the ghost finished) */
  sample(t: number, pos: THREE.Vector3, rot: THREE.Quaternion): boolean {
    const n = this.data.frames.length / 7;
    if (!(t >= 0) || n < 2 || t > this.duration) return false;
    const x = t * this.data.hz, i = Math.min(n - 2, Math.floor(x)), f = x - i, d = this.data.frames;
    const A = i * 7, B = A + 7;
    pos.set(d[A] + (d[B] - d[A]) * f, d[A + 1] + (d[B + 1] - d[A + 1]) * f, d[A + 2] + (d[B + 2] - d[A + 2]) * f);
    this.qa.set(d[A + 3], d[A + 4], d[A + 5], d[A + 6]);
    this.qb.set(d[B + 3], d[B + 4], d[B + 5], d[B + 6]);
    rot.slerpQuaternions(this.qa, this.qb, f);
    return true;
  }
}

/** Compact storage form: millimetres / 1e-4 quaternion units, delta-coded per channel (small JSON integers). */
export interface GhostStored { v: 1; hz: number; lap: number; splits: (number | null)[]; d: number[] }
const SCALE = [1000, 1000, 1000, 1e4, 1e4, 1e4, 1e4];
export function encodeGhost(g: GhostData): GhostStored {
  const last = [0, 0, 0, 0, 0, 0, 0], d: number[] = [];
  for (let i = 0; i < g.frames.length; i++) {
    const c = i % 7, v = Math.round(g.frames[i] * SCALE[c]);
    d.push(v - last[c]); last[c] = v;
  }
  return { v: 1, hz: g.hz, lap: g.lap, splits: g.splits.map((s) => (isFinite(s) ? Math.round(s * 1000) / 1000 : null)), d };
}
export function decodeGhost(s: unknown): GhostData | null {
  const g = s as GhostStored;
  if (!g || g.v !== 1 || !Array.isArray(g.d) || g.d.length % 7 || !(g.hz > 0) || !Array.isArray(g.splits)) return null;
  const last = [0, 0, 0, 0, 0, 0, 0], frames = new Array<number>(g.d.length);
  for (let i = 0; i < g.d.length; i++) { const c = i % 7; last[c] += g.d[i]; frames[i] = last[c] / SCALE[c]; }
  return { hz: g.hz, lap: g.lap, splits: g.splits.map((x) => (typeof x === 'number' ? x : NaN)), frames };
}

export class Race {
  readonly gates: GateRt[];
  /** gate to fly through next (0 = start / finish) */
  next = 0;
  lapStart = -1;
  lastLap = 0;
  lastValid = true;
  best = Infinity;
  laps = 0;
  rule: MissRule = 'penalty';
  penaltyPerGate = MISS_PENALTY_S;
  /** current lap: split per checkpoint (index j = (j+1)-th gate after the start, last = finish), missed gates, penalty */
  splits: number[] = [];
  missed = 0;
  penalty = 0;
  /** splits of the best lap (from the stored ghost or the best lap of this session) */
  bestSplits: number[] | null = null;
  /** the last split's difference to the best lap (s, + = slower) and when it happened (sim time) */
  lastDelta: number | null = null;
  lastDeltaAt = -Infinity;
  /** record the ghost of every lap (off for lessons) */
  recordGhost = true;
  readonly recorder = new GhostRecorder();
  readonly marker: THREE.Group;
  onGate?: (index: number, delta: number | null) => void;
  /** gates skipped by flying through a later one */
  onMiss?: (gates: number[]) => void;
  onLap?: (r: LapResult) => void;

  private prev: THREE.Vector3[];
  private prevT = 0;
  private hasPrev = false;
  private local = new THREE.Vector3();

  constructor(gates: Gate[]) {
    this.gates = gates.map((g) => ({
      c: new THREE.Vector3(...g.c),
      inv: new THREE.Quaternion(g.q[0], g.q[1], g.q[2], g.q[3]).invert(),
      w: g.w, h: g.h,
    }));
    this.prev = this.gates.map(() => new THREE.Vector3());
    // highlight frame for the next gate
    this.marker = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xc8ff2e, transparent: true, opacity: 0.85, depthWrite: false, fog: false });
    const bar = (w: number, h: number, x: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), mat); m.position.set(x, y, 0); this.marker.add(m);
    };
    const W = 1.6, H = 1.6, t = 0.05;
    bar(W, t, 0, H / 2); bar(W, t, 0, -H / 2); bar(t, H, -W / 2, 0); bar(t, H, W / 2, 0);
    this.marker.renderOrder = 3;
    this.placeMarker();
  }

  get active() { return this.gates.length > 0; }
  /** checkpoints per lap (= gates) */
  get total() { return this.gates.length; }
  /** gates that may be skipped at once: more than this is flying the course backwards / elsewhere, not a cut */
  get maxSkip() { return Math.max(1, Math.floor(this.gates.length / 2)); }
  /** time into the current lap (the ghost's clock), -1 before the first gate */
  lapTime(time: number) { return this.lapStart >= 0 ? time - this.lapStart : -1; }

  reset() {
    this.next = 0; this.lapStart = -1; this.hasPrev = false;
    this.splits = []; this.missed = 0; this.penalty = 0; this.lastDelta = null; this.lastDeltaAt = -Infinity;
    this.recorder.stop();
    this.placeMarker();
  }

  private placeMarker() {
    const g = this.gates[this.next];
    if (!g) { this.marker.visible = false; return; }
    this.marker.visible = true;
    this.marker.position.copy(g.c);
    this.marker.quaternion.copy(g.inv).invert();
  }

  /** gates that count right now: the next one, and during a lap the following ones up to the finish (a cut) */
  private candidates(): number[] {
    const N = this.gates.length, out = [this.next];
    if (this.lapStart < 0 || this.next === 0) return out;
    const toFinish = N - this.next; // steps to gate 0
    for (let s = 1; s <= Math.min(this.maxSkip, toFinish); s++) out.push((this.next + s) % N);
    return out;
  }

  /** @param pos drone position, @param rot its orientation (for the ghost; omit = no recording) */
  update(time: number, pos: THREE.Vector3, rot?: THREE.QuaternionLike) {
    if (!this.gates.length) return;
    if (rot && this.recordGhost) this.recorder.add(time, pos, rot);
    const cand = this.candidates();
    let hit = -1, hitT = time;
    for (const j of cand) {
      const g = this.gates[j], L = this.local.copy(pos).sub(g.c).applyQuaternion(g.inv); // x across, y up, z through
      const P = this.prev[j];
      if (this.hasPrev && Math.sign(L.z) !== Math.sign(P.z) && L.z !== P.z) {
        // where / when the segment pierced the gate plane
        const f = P.z / (P.z - L.z);
        const x = P.x + (L.x - P.x) * f, y = P.y + (L.y - P.y) * f;
        if (Math.abs(x) < g.w / 2 && Math.abs(y) < g.h / 2 && hit < 0) { hit = j; hitT = this.prevT + (time - this.prevT) * f; }
      }
    }
    // keep every gate's previous local position (a gate may become a candidate next frame)
    for (let j = 0; j < this.gates.length; j++) {
      const g = this.gates[j];
      this.prev[j].copy(pos).sub(g.c).applyQuaternion(g.inv);
    }
    this.prevT = time;
    this.hasPrev = true;
    if (hit >= 0) this.pass(hit, hitT);
  }

  private pass(j: number, t: number) {
    const N = this.gates.length;
    const skipped: number[] = [];
    for (let k = this.next; k !== j; k = (k + 1) % N) skipped.push(k);
    if (skipped.length) {
      this.missed += skipped.length;
      if (this.rule === 'penalty') this.penalty += skipped.length * this.penaltyPerGate;
      for (const k of skipped) this.splits[(k - 1 + N) % N] = NaN;
      this.onMiss?.(skipped);
    }
    if (j === 0) {
      if (this.lapStart >= 0) this.finishLap(t);
      this.startLap(t);
    } else {
      const ci = j - 1, split = t - this.lapStart + this.penalty;
      this.splits[ci] = split;
      const ref = this.bestSplits?.[ci];
      this.lastDelta = ref !== undefined && isFinite(ref) ? split - ref : null;
      this.lastDeltaAt = t;
    }
    this.next = (j + 1) % N;
    this.onGate?.(j, this.lastDelta);
    this.placeMarker();
  }

  private startLap(t: number) {
    this.lapStart = t; this.splits = []; this.missed = 0; this.penalty = 0;
    if (this.recordGhost) this.recorder.start(t);
  }

  private finishLap(t: number) {
    const N = this.gates.length, raw = t - this.lapStart;
    const valid = !(this.rule === 'dnf' && this.missed > 0);
    const time = valid ? raw + this.penalty : NaN;
    this.splits[N - 1] = valid ? time : NaN;
    const ref = this.bestSplits?.[N - 1];
    this.lastDelta = valid && ref !== undefined && isFinite(ref) ? time - ref : null;
    this.lastDeltaAt = t;
    const best = valid && time < this.best;
    const frames = this.recorder.recording ? this.recorder.finish(t) : [];
    const splits = this.splits.slice(0, N);
    for (let k = 0; k < N; k++) if (splits[k] === undefined) splits[k] = NaN;
    const ghost = best && frames.length >= 14 ? { hz: this.recorder.hz, lap: time, splits, frames } : null;
    if (best) { this.best = time; this.bestSplits = splits; }
    this.laps++;
    this.lastLap = valid ? time : NaN;
    this.lastValid = valid;
    this.onLap?.({ time, raw, penalty: this.penalty, missed: this.missed, valid, best, splits, ghost });
  }
}
