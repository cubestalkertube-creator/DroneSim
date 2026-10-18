// SimHost: the simulation behind a message boundary (PLAN.md 3 "physics in a Web Worker").
// The game sends commands (arm, modes, reset, …) and "advance N fixed steps with these sticks"; the host
// replies with a snapshot of everything rendering, sound and the HUD need. The same class runs in the worker
// (sim/worker.ts) and in the main thread (LocalSim, tests): one code path, deterministic for a given sequence
// of requests (the sticks are applied per request, the step count is decided by the caller's clock).
import { SimWorld, type BlastEvent, type CrashEvent } from './world';
import type { Drone } from './drone';
import type { DronePreset } from './presets';
import type { MapLayout } from './layout';
import type { FlightMode, Sticks } from './fc/betaflight';
import { ratesFromCli } from './cli';
import type { RateProfile } from './rates';
import type { Q4, V3 } from './math';

export interface SimInit { preset: DronePreset; layout: MapLayout; seed: number; dt: number }

export type SimCommand =
  | { t: 'boxes'; boxes: { c: V3; h: V3; q: Q4 }[] }
  | { t: 'spawn'; pos: V3; rot: Q4 }
  | { t: 'reset'; pos: V3; rot: Q4 }
  | { t: 'arm'; throttle: number }
  | { t: 'mode_next' }
  /** mode key 1..4 (index 0..3): FPV Acro/Angle/Horizon, GPS / plane / VTOL: the n-th mode of the airframe */
  | { t: 'mode_index'; i: number }
  | { t: 'rth' } | { t: 'land' } | { t: 'turtle' }
  /** index < 0: all motors working again */
  | { t: 'motor_fail'; index: number }
  /** kamikaze presets: set the charge off (only while armed) */
  | { t: 'detonate' }
  | { t: 'rates_cli'; text: string }
  /** rate profile from the settings (null: the preset's own) */
  | { t: 'rates'; rates: RateProfile | null };

export interface SimRequest { cmds: SimCommand[]; sticks: Sticks; steps: number }

export interface Toast { text: string; ms: number; haptic?: 'light' | 'medium' | 'heavy' }

export interface SimSnapshot {
  time: number; steps: number;
  /** state after the batch and one step before it (render interpolation) */
  pos: V3; rot: Q4; vel: V3; prevPos: V3; prevRot: Q4;
  /** largest contact impulse in the batch, crash (sticky until reset), crash happened in this batch */
  hit: number; crash: CrashEvent | null; crashNew: boolean;
  /** the charge went off (sticky until reset) / in this batch; warhead: the preset carries one, fuse: it is live */
  blast: BlastEvent | null; blastNew: boolean; warhead: boolean; fuse: boolean;
  armed: boolean; mode: string; centredThrottle: boolean; turtle: boolean;
  /** visual/sound rotors (GLB order: lift rotors, pusher), mixer commands, phase currents */
  omega: Float64Array; thrust: Float64Array; cmd: Float64Array; phaseA: Float64Array; motorFailed: boolean;
  vrs: number; airspeed: number; groundDist: number; wind: V3;
  setpoint: [number, number, number]; tpa: number; ag: number;
  bat: { present: boolean; vFilt: number; cellFilt: number; current: number; mAh: number; low: boolean; cutoff: boolean; vbus: number; soc: number };
  nav: { altitude: number; distHome: number; hSpeed: number; vSpeed: number; obstacle: boolean; rthPhase: string; landed: boolean } | null;
  plane: {
    airspeed: number; altitude: number; heading: number; phase: string; wp: number; wpCount: number; wpDist: number;
    alpha: number; stalled: boolean; protecting: boolean; lowSpeed: boolean; fuel: number | null;
    elevL: number; elevR: number; chute: number; vtolPhase: string | null; distHome: number;
  } | null;
  toasts: Toast[];
}

/** Static facts about the airframe the main thread needs before the first snapshot. */
export interface SimInfo { gps: boolean; plane: boolean; vtol: boolean; halfY: number; visOmegaMax: number; visKT0: number; rotors: number }

const MODE_CYCLE: FlightMode[] = ['acro', 'angle', 'horizon'];
const MODE_LABEL: Record<FlightMode, string> = { acro: 'Acro', angle: 'Angle', horizon: 'Horizon' };

export function droneInfo(d: Drone): SimInfo {
  const m = d.model;
  return {
    gps: !!d.nav, plane: !!d.plane && !d.vtol, vtol: !!d.vtol, halfY: m.halfExtents.y, visOmegaMax: d.visOmegaMax,
    visKT0: m.rotors.length ? m.kT0 : m.pusher?.kT0 ?? m.kT0, rotors: d.visOmega.length,
  };
}

export class SimHost {
  readonly sim: SimWorld;
  private toasts: Toast[] = [];
  private snap: SimSnapshot | null = null;
  private prevPos: V3 = { x: 0, y: 0, z: 0 }; private prevRot: Q4 = { x: 0, y: 0, z: 0, w: 1 };

  /** Rapier must be initialised (initPhysics) before. */
  constructor(readonly init: SimInit) {
    this.sim = new SimWorld(init.seed, init.dt);
    this.sim.loadMap(init.layout);
  }

  get drone() { return this.sim.drone; }

  /** Apply the commands, run the steps, return the snapshot (reused object: clone it to keep it). */
  handle(req: SimRequest): SimSnapshot {
    const sim = this.sim;
    const blastBefore = !!sim.blast; // a detonate command counts as new in this batch
    for (const c of req.cmds) this.apply(c);
    let hit = 0;
    const crashedBefore = !!sim.crash;
    const s = sim.state;
    for (let i = 0; i < req.steps; i++) {
      copyV(this.prevPos, s.pos); copyQ(this.prevRot, s.rot);
      sim.step(req.sticks);
      if (sim.lastImpulse > hit) hit = sim.lastImpulse;
    }
    return this.snapshot(req.steps, hit, !!sim.crash && !crashedBefore, !!sim.blast && !blastBefore);
  }

  private toast(text: string, ms = 1600, haptic?: Toast['haptic']) { this.toasts.push({ text, ms, haptic }); }

  apply(c: SimCommand) {
    const sim = this.sim, d = sim.drone;
    switch (c.t) {
      case 'boxes': for (const b of c.boxes) sim.addStaticBox(b.c, b.h, b.q); break;
      case 'spawn': sim.spawnDrone(this.init.preset, c.pos, c.rot); this.syncPrev(); break;
      case 'reset': sim.resetDrone(c.pos, c.rot); this.syncPrev(); break;
      case 'arm': {
        const fc = d.fc;
        if (sim.blast) { this.toast('Дрон уничтожен — рестарт (R)'); break; }
        if (sim.crash) {
          // after a crash the quad can be re-armed once it has come to rest (e.g. in turtle mode)
          const v = sim.state.vel;
          if (fc.armed || Math.hypot(v.x, v.y, v.z) > 0.3 || d.plane) { this.toast('Сначала рестарт (R)'); break; }
          sim.crash = null;
        }
        const ok = d.setArmed(!fc.armed, c.throttle);
        if (!ok && fc.armBlockReason) this.toast(`Арм заблокирован: ${fc.armBlockReason}`);
        break;
      }
      case 'mode_next': {
        const ctl = d.vtol ?? d.plane ?? d.nav;
        if (ctl) { ctl.nextMode(); this.modeToast(); break; }
        d.fc.mode = MODE_CYCLE[(MODE_CYCLE.indexOf(d.fc.mode) + 1) % MODE_CYCLE.length]; this.toast(MODE_LABEL[d.fc.mode], 900); break;
      }
      case 'mode_index': {
        const ctl = d.vtol ?? d.plane ?? d.nav;
        if (ctl) { const m = ctl.modes[c.i]; if (m) { ctl.setMode(m); this.modeToast(); } break; }
        if (c.i < 3) { d.fc.mode = MODE_CYCLE[c.i]; this.toast(MODE_LABEL[d.fc.mode], 900); }
        break;
      }
      case 'rth': {
        if (d.vtol) { d.vtol.setMode(d.vtol.mode === 'rtl' ? 'mc_position' : 'rtl'); this.modeToast(); break; }
        if (d.plane) { const p = d.plane; p.setMode(p.mode === 'rtl' || !p.modes.includes('rtl') ? p.modes.find((m) => m !== 'rtl')! : 'rtl'); this.modeToast(); break; }
        const nav = d.nav;
        if (!nav) break;
        nav.setMode(nav.behavior === 'rth' ? nav.modes.find((m) => m !== nav.mode && !/rth|rtl|home|land/.test(m))! : nav.modes.find((m) => /rth|rtl|home/.test(m))!);
        this.modeToast(); break;
      }
      case 'land': {
        if (d.plane && !d.vtol && !this.init.preset.recovery) { this.toast('Парашюта нет — только посадка на брюхо', 1600); break; }
        if (d.plane && !d.vtol) { d.plane.requestChute(); this.toast('Посадка на парашюте: сброс газа, торможение', 1800); break; }
        if (d.vtol) { d.vtol.setMode('rtl'); this.modeToast(); break; }
        const nav = d.nav;
        if (nav) { nav.setMode(nav.modes.find((m) => m === 'land') ?? nav.modes.find((m) => /rth|rtl|home/.test(m))!); this.modeToast(); }
        break;
      }
      case 'turtle': {
        if (d.nav || d.plane) break;
        if (d.fc.armed) { this.toast('Turtle: сначала дизарм'); break; }
        d.fc.turtle = !d.fc.turtle;
        this.toast(d.fc.turtle ? 'Turtle ВКЛ: арм, стик в сторону переворота' : 'Turtle выкл.', 1600);
        break;
      }
      case 'motor_fail': {
        const f = d.motors.failed;
        if (!f.length) break;
        if (c.index < 0 || f.some((x) => x)) { f.fill(0); this.toast('Моторы исправны', 1200); break; }
        f[c.index % f.length] = 1;
        this.toast('ОТКАЗ МОТОРА', 1600, 'heavy');
        break;
      }
      case 'detonate': {
        if (!this.init.preset.warhead || sim.blast) break;
        if (!sim.fuseArmed) { this.toast(d.plane ? 'Заряд не взведён: сначала пуск' : 'Заряд не взведён: сначала арм', 1400); break; }
        sim.detonate('command');
        break;
      }
      case 'rates': {
        const def = this.init.preset.fc.rates;
        const r = c.rates ?? def;
        if (r) d.fc.rates = { type: r.type, roll: [...r.roll], pitch: [...r.pitch], yaw: [...r.yaw] };
        break;
      }
      case 'rates_cli': {
        const fc = d.fc;
        const r = ratesFromCli(c.text, fc.rates);
        if (!r) { this.toast('В буфере нет rates Betaflight (set roll_rc_rate = …)'); break; }
        fc.rates = r;
        this.toast(`Rates ${r.type.toUpperCase()}: roll ${r.roll.join(' / ')} — применены`, 2500);
        break;
      }
    }
  }

  private modeToast() { this.toast(this.sim.drone.modeLabel, 900); }
  private syncPrev() { copyV(this.prevPos, this.sim.state.pos); copyQ(this.prevRot, this.sim.state.rot); }

  private snapshot(steps: number, hit: number, crashNew: boolean, blastNew = false): SimSnapshot {
    const sim = this.sim, d = sim.drone, s = sim.state, fc = d.fc, b = d.battery, nav = d.nav, pl = d.plane;
    const snap = (this.snap ??= {
      time: 0, steps: 0, pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 },
      prevPos: { x: 0, y: 0, z: 0 }, prevRot: { x: 0, y: 0, z: 0, w: 1 }, hit: 0, crash: null, crashNew: false,
      blast: null, blastNew: false, warhead: !!this.init.preset.warhead, fuse: false,
      armed: false, mode: '', centredThrottle: false, turtle: false,
      omega: new Float64Array(d.visOmega.length), thrust: new Float64Array(d.visOmega.length), cmd: new Float64Array(d.mixer.out.length),
      phaseA: new Float64Array(d.motors.phaseA.length), motorFailed: false, vrs: 0, airspeed: 0, groundDist: Infinity, wind: { x: 0, y: 0, z: 0 },
      setpoint: [0, 0, 0], tpa: 1, ag: 1,
      bat: { present: b.present, vFilt: 0, cellFilt: 0, current: 0, mAh: 0, low: false, cutoff: false, vbus: 0, soc: 1 },
      nav: null, plane: null, toasts: [],
    });
    snap.time = sim.time; snap.steps = steps;
    copyV(snap.pos, s.pos); copyQ(snap.rot, s.rot); copyV(snap.vel, s.vel);
    copyV(snap.prevPos, steps ? this.prevPos : s.pos); copyQ(snap.prevRot, steps ? this.prevRot : s.rot);
    snap.hit = hit; snap.crash = sim.crash ? { ...sim.crash } : null; snap.crashNew = crashNew;
    snap.blast = sim.blast ? { ...sim.blast, pos: { ...sim.blast.pos } } : null; snap.blastNew = blastNew; snap.fuse = sim.fuseArmed;
    snap.armed = fc.armed; snap.mode = d.modeLabel; snap.turtle = fc.turtle;
    snap.centredThrottle = d.vtol ? d.vtol.centredThrottle : nav ? nav.centredThrottle : false;
    snap.omega.set(d.visOmega); snap.thrust.set(d.visThrust); snap.cmd.set(d.mixer.out); snap.phaseA.set(d.motors.phaseA);
    snap.motorFailed = d.motors.failed.some((x) => x);
    snap.vrs = d.tele.vrs; snap.airspeed = d.tele.airspeed; snap.groundDist = d.tele.groundDist; copyV(snap.wind, sim.env.wind);
    snap.setpoint[0] = fc.setpoint[0]; snap.setpoint[1] = fc.setpoint[1]; snap.setpoint[2] = fc.setpoint[2];
    snap.tpa = fc.tpaFactor; snap.ag = fc.agBoost;
    const sb = snap.bat;
    sb.vFilt = b.vFilt; sb.cellFilt = b.vFilt / b.cells; sb.current = b.current; sb.mAh = b.mAh; sb.low = b.low; sb.cutoff = b.cutoff; sb.vbus = b.vbus; sb.soc = b.soc;
    const fwActive = !!pl && (!d.vtol || d.vtol.phase !== 'mc');
    if (nav && !(d.vtol && fwActive)) {
      snap.nav = { altitude: nav.altitude, distHome: nav.distHome, hSpeed: nav.hSpeed, vSpeed: nav.vSpeed, obstacle: nav.obstacle, rthPhase: nav.rthPhase, landed: nav.landed };
    } else snap.nav = null;
    if (pl) {
      const w = d.wing!;
      snap.plane = {
        airspeed: pl.airspeed, altitude: pl.altitude, heading: pl.heading, phase: pl.phase, wp: pl.wpIndex, wpCount: pl.route.length, wpDist: pl.wpDist,
        alpha: w.alpha, stalled: w.stalled, protecting: pl.protecting, lowSpeed: pl.lowSpeed, fuel: d.pusher?.m.engine ? d.pusher.fuel : null,
        elevL: w.defL, elevR: w.defR, chute: d.chuteOpen ? d.chute : 0, vtolPhase: d.vtol?.phase ?? null, distHome: pl.distHome,
      };
      if (d.vtol?.event) { this.toast(d.vtol.event, 2200); d.vtol.event = ''; }
    } else snap.plane = null;
    snap.toasts = this.toasts; this.toasts = [];
    return snap;
  }
}

function copyV(o: V3, a: V3) { o.x = a.x; o.y = a.y; o.z = a.z; }
function copyQ(o: Q4, a: Q4) { o.x = a.x; o.y = a.y; o.z = a.z; o.w = a.w; }
