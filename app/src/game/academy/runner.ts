// Academy lesson engine (PLAN.md 8.1): a lesson is an ordered list of steps (instruction + condition + optional
// hold time + 3D targets); the runner feeds them one frame of flight state at a time, collects the metrics
// (time, collisions, altitude RMSE, battery, lesson-specific values) and grades the result in stars.
// Pure game logic (three.js math only, no rendering / DOM) — tested in test/academy.test.ts.
import * as THREE from 'three';
import type { MapLayout, QuatT } from '../../sim/layout';
import { TrickDetector, type TrickEvent } from './tricks';

export interface LessonFrame {
  /** sim time, s */
  t: number;
  pos: THREE.Vector3; vel: THREE.Vector3; rot: THREE.Quaternion;
  armed: boolean;
  /** pilot-facing mode label (SimSnapshot.mode) */
  mode: string;
  crashed: boolean;
  /** largest contact impulse since the last frame, N·s */
  hit: number;
  /** resting on the ground (GPS: the FC's landed flag; others: close to the ground and still) */
  landed: boolean;
  sticks: { throttle: number; roll: number; pitch: number; yaw: number };
  /** pack: drawn mAh, state of charge, ESC low-voltage limiter active */
  mAh: number; soc: number; cutoff: boolean;
  /** quadplane phase (mc / trans_fw / fw / trans_mc) */
  vtolPhase: string | null;
}

/** Things drawn in the world for the current step (game/academy/view.ts). */
export type Target =
  /** checkpoint sphere to fly through */
  | { kind: 'point'; c: THREE.Vector3; r: number }
  /** ground circle with a light beam: landing spot / hover area */
  | { kind: 'pad'; c: THREE.Vector3; r: number }
  /** gate frame to fly through (layout gate or lesson-made) */
  | { kind: 'gate'; c: THREE.Vector3; q: THREE.Quaternion; w: number; h: number }
  /** marker pole without collision (orbit subject, figure-eight posts) */
  | { kind: 'pole'; c: THREE.Vector3; h: number };

export interface Metrics {
  /** s since the first arm */
  time: number;
  /** collisions (impulse > HIT_IMPULSE while moving sideways, 0.4 s apart) */
  hits: number;
  /** RMS altitude error over the steps that track an altitude, m (0 if none) */
  altRmse: number;
  /** pack used, mAh, and state of charge left */
  mAh: number; soc: number;
  /** lesson-specific values written by the steps */
  x: Record<string, number>;
}

export interface Criterion {
  label: string;
  get(m: Metrics): number;
  fmt(v: number): string;
  /** thresholds for ★★ and ★★★ (all criteria must pass) */
  two: number; three: number;
  /** larger is better (default: smaller is better) */
  higher?: boolean;
}

export interface LessonCtx {
  readonly home: THREE.Vector3;
  /** height above the start point, m */
  alt(f: LessonFrame): number;
  /** time the current step started (sim time) */
  stepT0: number;
  /** step scratch values (reset on every step) */
  mem: Record<string, number>;
  readonly m: Metrics;
  /** tricks recognised during the current step */
  tricks: TrickEvent[];
  /** position and time of the previous frame (gate crossings, path integrals) */
  readonly prevPos: THREE.Vector3;
  prevT: number;
  hasPrev: boolean;
}

export interface Step {
  text: string;
  /** live detail line (distance, timer, what to fix) */
  sub?(f: LessonFrame, c: LessonCtx): string;
  /** which stick to highlight on the stick view */
  stick?: 'left' | 'right' | 'both';
  targets?: Target[];
  begin?(f: LessonFrame, c: LessonCtx): void;
  /** the step's condition this frame */
  done(f: LessonFrame, c: LessonCtx): boolean;
  /** seconds the condition has to accumulate (progress bar); a gap resets it if `continuous` */
  hold?: number;
  continuous?: boolean;
  /** altitude above home to hold during this step (metric altRmse) */
  trackAlt?: number;
  /** reason to fail the lesson right now (left the area, touched the ground…) */
  fail?(f: LessonFrame, c: LessonCtx): string | null;
}

export interface LessonEnv {
  layout: MapLayout;
  /** start point on the ground (spawn) */
  home: THREE.Vector3;
  /** ground height of the map at x, z (heightfield) */
  ground(x: number, z: number): number;
}

export interface LessonDef {
  id: string;
  title: string;
  /** briefing on the "ready" screen */
  brief: string;
  drone: string; map: string;
  /** spawn index of the map, or an own start pose on the ground (yaw: degrees from -Z towards -X) */
  spawn?: number | { x: number; z: number; yaw: number };
  /** wind for the lesson (null = calm); default: the map's */
  wind?: { mean_ms: number; dir_deg: number } | null;
  /** flight mode forced at the start and after restarts (preset fc.modes id) */
  mode?: string;
  /** mode switches are ignored during the lesson */
  lockMode?: boolean;
  camera?: 'fpv' | 'chase' | 'los';
  /** show the transmitter sticks on screen */
  showSticks?: boolean;
  build(env: LessonEnv): { steps: Step[]; props?: Target[] };
  criteria: Criterion[];
}

export type LessonState = 'running' | 'done' | 'failed';
export interface LessonResult {
  state: 'done' | 'failed';
  reason?: string;
  stars: number;
  lines: { label: string; value: string; two: string; three: string; ok2: boolean; ok3: boolean }[];
  time: number;
}

const HIT_IMPULSE = 0.15;
const HIT_MIN_SPEED = 1;   // m/s horizontal
const CUTOFF_FAIL_S = 3;

export class LessonRunner {
  state: LessonState = 'running';
  index = 0;
  /** accumulated hold time of the current step */
  held = 0;
  steps: Step[] = [];
  props: Target[] = [];
  result: LessonResult | null = null;
  failReason = '';
  readonly tricks = new TrickDetector();
  private ctx!: LessonCtx;
  private t0 = -1;
  private lastHit = -1;
  private altSq = 0; private altN = 0;
  private mAh0 = -1;
  private cutT = 0;
  private prevHs = 0;
  private began = false;
  onStep?: (index: number) => void;

  constructor(readonly def: LessonDef, readonly env: LessonEnv) { this.restart(); }

  get step(): Step | undefined { return this.steps[this.index]; }
  get progress() { const h = this.step?.hold; return h ? Math.min(1, this.held / h) : 0; }

  restart() {
    const built = this.def.build(this.env);
    this.steps = built.steps; this.props = built.props ?? [];
    this.state = 'running'; this.index = 0; this.held = 0; this.result = null; this.failReason = '';
    this.t0 = -1; this.lastHit = -1; this.altSq = 0; this.altN = 0; this.mAh0 = -1; this.cutT = 0; this.prevHs = 0; this.began = false;
    this.tricks.reset();
    const home = this.env.home;
    this.ctx = {
      home, stepT0: 0, mem: {}, tricks: [], prevPos: new THREE.Vector3(), prevT: 0, hasPrev: false,
      alt: (f) => f.pos.y - home.y,
      m: { time: 0, hits: 0, altRmse: 0, mAh: 0, soc: 1, x: {} },
    };
  }

  /** One frame of flight (only while the flight runs, not paused). */
  update(f: LessonFrame) {
    if (this.state !== 'running') return;
    const c = this.ctx, m = c.m;
    if (this.t0 < 0 && f.armed) this.t0 = f.t;
    if (this.mAh0 < 0) this.mAh0 = f.mAh;
    m.time = this.t0 < 0 ? 0 : f.t - this.t0;
    m.mAh = f.mAh - this.mAh0; m.soc = f.soc;
    // a touchdown is not a collision: count contacts while moving sideways (speed of the frame before the hit)
    const hs = Math.hypot(f.vel.x, f.vel.z);
    if (f.hit > HIT_IMPULSE && Math.max(hs, this.prevHs) > HIT_MIN_SPEED && f.t - this.lastHit > 0.4) { m.hits++; this.lastHit = f.t; }
    this.prevHs = hs;
    const tr = this.tricks.update(f.t, f.rot, f.vel, c.alt(f));
    if (tr) c.tricks.push(tr);

    const st = this.step;
    if (!st) return;
    if (!this.began) { this.began = true; c.stepT0 = f.t; c.mem = {}; c.tricks = []; st.begin?.(f, c); }
    if (st.trackAlt !== undefined && f.armed && !f.landed) { const e = c.alt(f) - st.trackAlt; this.altSq += e * e; this.altN++; }
    m.altRmse = this.altN ? Math.sqrt(this.altSq / this.altN) : 0;

    const dt = c.hasPrev ? Math.max(0, f.t - c.prevT) : 0;
    // the ESC limiter also dips briefly on current spikes (spin-up, punch): only a lasting cutoff is an empty pack
    this.cutT = f.cutoff ? this.cutT + dt : 0;
    const why = f.crashed ? 'Краш' : this.cutT > CUTOFF_FAIL_S ? 'Батарея разряжена' : st.fail?.(f, c) ?? null;
    if (why) { this.finish('failed', why); return; }

    if (c.hasPrev && st.done(f, c)) {
      this.held += dt;
      if (!st.hold || this.held >= st.hold) this.next(f);
    } else if (st.continuous) this.held = 0;
    c.prevPos.copy(f.pos); c.prevT = f.t; c.hasPrev = true;
  }

  private next(f: LessonFrame) {
    this.index++; this.held = 0; this.began = false;
    if (this.index >= this.steps.length) { this.finish('done'); return; }
    this.onStep?.(this.index);
    // start the next step on this frame so instantly-true conditions do not wait a frame each
    const st = this.step!, c = this.ctx;
    this.began = true; c.stepT0 = f.t; c.mem = {}; c.tricks = []; st.begin?.(f, c);
  }

  private finish(state: 'done' | 'failed', reason?: string) {
    this.state = state; this.failReason = reason ?? '';
    this.result = grade(this.def, this.ctx.m, state, reason);
  }

  /** current live detail line */
  sub(f: LessonFrame | null): string { return f && this.step?.sub ? this.step.sub(f, this.ctx) : ''; }
  get metrics(): Metrics { return this.ctx.m; }
}

/** Stars: 1 for finishing, 2 if every criterion meets `two`, 3 if every one meets `three`. */
export function grade(def: LessonDef, m: Metrics, state: 'done' | 'failed', reason?: string): LessonResult {
  const lines = def.criteria.map((k) => {
    const v = k.get(m), ok = (th: number) => (k.higher ? v >= th : v <= th);
    return { label: k.label, value: k.fmt(v), two: k.fmt(k.two), three: k.fmt(k.three), ok2: ok(k.two), ok3: ok(k.three) };
  });
  const stars = state !== 'done' ? 0 : lines.every((l) => l.ok3) ? 3 : lines.every((l) => l.ok2) ? 2 : 1;
  return { state, reason, stars, lines, time: m.time };
}

// ---------------------------------------------------------------------------------------------- helpers for steps

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), qInv = new THREE.Quaternion();

/** horizontal distance */
export const distH = (a: THREE.Vector3Like, b: THREE.Vector3Like) => Math.hypot(a.x - b.x, a.z - b.z);
export const dist3 = (a: THREE.Vector3Like, b: THREE.Vector3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** heading of the nose in the horizontal plane, rad (0 = -Z, positive towards -X, i.e. yaw left) */
export function heading(rot: THREE.Quaternion): number {
  tmp.set(0, 0, -1).applyQuaternion(rot);
  return Math.atan2(-tmp.x, -tmp.z);
}
/** smallest signed angle a - b, rad */
export function angDiff(a: number, b: number) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

/** cosine between the nose (horizontal) and the direction to a point */
export function noseTo(f: LessonFrame, p: THREE.Vector3Like): number {
  tmp.set(0, 0, -1).applyQuaternion(f.rot).setY(0);
  tmp2.set(p.x - f.pos.x, 0, p.z - f.pos.z);
  const l = tmp.length() * tmp2.length();
  return l > 1e-6 ? tmp.dot(tmp2) / l : 0;
}

/** true when the segment prev → cur crosses the gate plane inside the frame */
export function crossedGate(prev: THREE.Vector3, cur: THREE.Vector3, g: { c: THREE.Vector3; q: THREE.Quaternion; w: number; h: number }): boolean {
  qInv.copy(g.q).invert();
  const a = tmp.copy(prev).sub(g.c).applyQuaternion(qInv), b = tmp2.copy(cur).sub(g.c).applyQuaternion(qInv);
  if (Math.sign(a.z) === Math.sign(b.z) || a.z === b.z) return false;
  const k = a.z / (a.z - b.z), x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
  return Math.abs(x) < g.w / 2 && Math.abs(y) < g.h / 2;
}

/** gate quaternion facing along a horizontal direction (frame normal = local Z) */
export function gateQuat(dirX: number, dirZ: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dirX, -dirZ));
}
export const quatT = (q: QuatT) => new THREE.Quaternion(q[0], q[1], q[2], q[3]);

/** ground height from the map heightfield (bilinear), 0 without terrain */
export function groundHeight(layout: MapLayout, x: number, z: number): number {
  const t = layout.terrain;
  if (!t) return 0;
  const n = t.res + 1, h = t.heights_rowmajor_blenderY;
  const fi = Math.max(0, Math.min(t.res, ((x + t.size / 2) / t.size) * t.res));
  const fj = Math.max(0, Math.min(t.res, ((t.size / 2 - z) / t.size) * t.res));
  const i = Math.min(t.res - 1, Math.floor(fi)), j = Math.min(t.res - 1, Math.floor(fj)), u = fi - i, v = fj - j;
  const at = (a: number, b: number) => h[b * n + a];
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
}
