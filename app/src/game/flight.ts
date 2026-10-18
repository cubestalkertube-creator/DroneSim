// One flight: map + drone loaded, fixed-step 1 kHz simulation in a Web Worker (core/simClient.ts) + interpolated
// rendering, input, sound and the OSD on the main thread. Multirotors (FPV / GPS), the fixed wing and the quadplane.
// Started from the menus (ui/app) or directly with ?map=&drone=; leaving it reloads the page into the menu.
import * as THREE from 'three';
import type { DronePreset } from '../sim/presets';
import { buildModel } from '../sim/presets';
import type { MapLayout } from '../sim/layout';
import type { SimSnapshot } from '../sim/host';
import { RenderWorld, ASSET_URL } from '../render/world';
import { DroneView } from '../render/droneView';
import { Explosion } from '../render/explosion';
import { CameraRig, CAM_ORDER, CAM_LABEL } from '../camera/cameras';
import { InputManager } from '../input/input';
import { Hud } from '../ui/hud';
import { Race, GhostPlayer, MISS_PENALTY_S, type GhostData } from './race';
import { ratesFromCli, ratesToCli } from '../sim/cli';
import { TouchControls } from '../input/touch';
import { pickQuality } from '../render/quality';
import { haptic, keepAwake, enterImmersive, lifecycle } from '../platform/platform';
import { AudioEngine } from '../audio/engine';
import { createSim, MAX_PENDING_STEPS } from '../core/simClient';
import { settings } from '../core/settings';
import { recordLap, bestLap, loadGhost, saveGhost } from '../core/progress';
import { setFlight, ui, type LaunchConfig } from '../ui/app/store';
import { MAPS, droneTitle } from '../ui/catalog';
import { lessonDef, nextLesson } from './academy/lessons';
import { LessonRunner, groundHeight, type LessonFrame } from './academy/runner';
import { LessonView } from './academy/view';
import { TRICK_LABEL } from './academy/tricks';
import { progress, updateProgress } from '../core/progress';
import { StickArming, armGesture } from '../input/gestures';

const Q = new URLSearchParams(location.search);
/** ?worker=0: physics on the main thread (debugging, `__ds.host` for direct access) */
const USE_WORKER = Q.get('worker') !== '0';
const DEVICE_LABEL = { keyboard: 'Клавиатура', mouse: 'Мышь + клавиатура', gamepad: 'Геймпад', rc: 'RC-пульт', touch: 'Тач' };
const RTH_PHASE: Record<string, string> = { climb: 'RTH: набор высоты', fly: 'RTH: возврат домой', descend: 'Посадка', idle: '' };
/** actions that still work while paused / before take-off; everything else (arm, restart…) waits for the flight */
const IDLE_ACTIONS = new Set(['pause', 'mute', 'debug']);

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(ASSET_URL + url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

/** Back to the main menu: a fresh page (frees the renderer, the worker and every listener of the flight).
 *  `screen`: menu screen to open (main.ts reads it from sessionStorage), `lesson`: start that lesson instead. */
export function exitToMenu(screen?: string, lesson?: string) {
  const p = new URLSearchParams(location.search);
  p.delete('map'); p.delete('drone'); p.delete('lesson'); p.delete('mode');
  if (lesson) p.set('lesson', lesson);
  try { if (screen) sessionStorage.setItem('ds.screen', screen); } catch { /* ignore */ }
  const q = p.toString();
  location.href = location.pathname + (q ? `?${q}` : '');
}

export async function runFlight(cfg: LaunchConfig, presets: DronePreset[]) {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui')!;
  const TOUCH = ui.touch;
  const quality = pickQuality();
  const simDt = 1 / quality.simHz;
  const st = settings.value;
  const lesson = cfg.lesson ? lessonDef(cfg.lesson) : undefined;
  if (lesson) cfg = { ...cfg, map: lesson.map, drone: lesson.drone };
  const preset = presets.find((d) => d.id === cfg.drone) ?? presets[0];
  const mapName = MAPS.find((m) => m.id === cfg.map)?.name ?? cfg.map;
  const kind = preset.launch || preset.aero ? 'plane' : preset.fc.type === 'betaflight' ? 'fpv' : 'gps';
  /** the gate race (PLAN.md 8.2): time trial with splits, the ghost of the best lap and missed-gate rules */
  let raceMode = cfg.mode === 'race' && !lesson;
  setFlight({
    phase: 'loading', status: 'Карта и пресеты…', title: lesson ? `Урок: ${lesson.title}` : raceMode ? `Гонка · ${mapName}` : mapName,
    sub: lesson ? `${droneTitle(preset)} · ${mapName}` : droneTitle(preset), page: 'menu', kind, warhead: !!preset.warhead,
  });
  ui.screen.value = 'flight';

  const hud = new Hud(uiRoot);
  hud.setVisible(false);
  const rw = new RenderWorld(canvas, quality);
  const rig = new CameraRig();
  const input = new InputManager(canvas);
  if (TOUCH) {
    input.touch = new TouchControls(uiRoot, (a) => input.push(a));
    input.touch.setVisible(false);
  }

  const layout = await getJSON<MapLayout>(`maps/${cfg.map}/${cfg.map}.json`);
  if (!layout.gates.length) raceMode = false;
  if (st.wind && layout.env.wind) {
    // conditions from the map screen: mean wind and direction; gusts keep the map's gust/mean ratio
    const w = layout.env.wind, ratio = w.mean_ms > 0 ? w.gust_ms / w.mean_ms : 1.75;
    layout.env.wind = { mean_ms: st.wind.mean_ms, gust_ms: st.wind.mean_ms * ratio, dir_deg: st.wind.dir_deg };
  } else if (st.wind) layout.env.wind = { mean_ms: st.wind.mean_ms, gust_ms: st.wind.mean_ms * 1.75, dir_deg: st.wind.dir_deg };
  if (lesson && lesson.wind !== undefined) {
    // lessons fly in their own conditions: calm, or a set wind with moderate gusts
    layout.env.wind = lesson.wind ? { mean_ms: lesson.wind.mean_ms, gust_ms: lesson.wind.mean_ms * 1.4, dir_deg: lesson.wind.dir_deg } : undefined;
  }
  const model = buildModel(preset);
  const over = st.drones[preset.id] ?? {};

  // spawn points (fixed wings start from the runway spawn if the map has one)
  const spawns = preset.launch ? [...layout.spawns].sort((a, b) => +(b.kind === 'runway') - +(a.kind === 'runway')) : layout.spawns;
  let spawnIdx = typeof lesson?.spawn === 'number' ? lesson.spawn : 0;
  const own = typeof lesson?.spawn === 'object' ? lesson.spawn : null; // lesson start pose on the ground
  const ownQ = own ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (own.yaw * Math.PI) / 180) : null;
  /** spawn point on the ground (the lesson's home) */
  const spawnGround = () => {
    if (own) return { x: own.x, y: groundHeight(layout, own.x, own.z), z: own.z };
    const s = spawns[spawnIdx % spawns.length];
    return { x: s.pos[0], y: s.pos[1], z: s.pos[2] };
  };
  const spawnPose = () => {
    const g = spawnGround(), s = spawns[spawnIdx % spawns.length];
    return {
      pos: { x: g.x, y: g.y + model.halfExtents.y + 0.03, z: g.z },
      rot: ownQ ? { x: ownQ.x, y: ownQ.y, z: ownQ.z, w: ownQ.w } : { x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] },
    };
  };

  setFlight({ status: 'Карта, небо, текстуры…' });
  await Promise.all([rw.loadEnvironment(layout), rw.loadMap(layout)]);
  setFlight({ status: 'Пропсы и дрон…' });
  const view = new DroneView();
  const ghostView = raceMode ? new DroneView() : null;
  const boxes: { c: THREE.Vector3Like; h: THREE.Vector3Like; q: { x: number; y: number; z: number; w: number } }[] = [];
  await Promise.all([
    rw.loadProps(layout, (c, h, q) => boxes.push({ c: { x: c.x, y: c.y, z: c.z }, h: { x: h.x, y: h.y, z: h.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } })),
    view.load(preset.model, over.uptilt ?? preset.camera.uptilt_deg ?? 30),
    ghostView?.load(preset.model, 0),
  ]);
  if (preset.warhead && !preset.aero) view.addCharge(preset.frame.wheelbase ?? 0.3);
  rw.scene.add(view.root);
  const ghostMats = ghostView ? ghostify(ghostView.root) : [];
  if (ghostView) { ghostView.root.visible = false; rw.scene.add(ghostView.root); }
  setFlight({ status: USE_WORKER ? 'Физика (Rapier WASM, Web Worker)…' : 'Физика (Rapier WASM)…' });
  const sim = await createSim({ preset, layout, seed: 1, dt: simDt, boxes, spawn: spawnPose() }, USE_WORKER);
  if (over.rates) sim.command({ t: 'rates', rates: over.rates });
  const info = sim.info;
  const gps = info.gps, plane = info.plane || info.vtol;
  const audio = new AudioEngine(preset.rotors.blades ?? 3, (preset.motor?.poles ?? 14) / 2, !!layout.env.indoor_reverb);
  const railMesh = preset.launch ? makeRail(preset) : null;
  if (railMesh) rw.scene.add(railMesh);
  const placeRail = () => {
    if (!railMesh) return;
    const p = spawnPose();
    railMesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    railMesh.quaternion.set(p.rot.x, p.rot.y, p.rot.z, p.rot.w);
  };
  placeRail();

  const setPilot = () => { const sp = spawnPose().pos; rig.pilot.set(sp.x + 3, sp.y + 1.6, sp.z + 4); };
  setPilot();
  const thr0 = () => (sim.snap.centredThrottle ? 0.5 : 0);
  input.sticks.throttle = thr0();
  const gimbal = gps && /gimbal|stab/.test(preset.camera.type);
  if (gimbal) {
    rig.gimbal = true; rig.fpvHFov = preset.camera.fov_deg;
    const pr = (preset.camera as { pitch_range?: [number, number] }).pitch_range;
    if (pr) rig.gimbalRange = pr;
  } else if (plane) rig.fpvHFov = preset.camera.fov_deg;
  input.touch?.configure(gps, gimbal, !!preset.warhead);
  const tiltGimbal = (d: number) => {
    rig.gimbalPitch = Math.max(rig.gimbalRange[0], Math.min(rig.gimbalRange[1], rig.gimbalPitch + d));
    hud.toast(`Подвес ${rig.gimbalPitch}°`, 700);
  };

  // GPS drones start / stop the motors with the sticks like the real ones: CSC (DJI) or throttle down + yaw (PX4, ArduPilot)
  const gesture = armGesture(preset.fc.type);
  const stickArm = new StickArming(gesture.kind, gesture.hold);
  const ARM_HOW = gesture.kind === 'csc' ? 'оба стика вниз и внутрь (или наружу)' : gesture.kind === 'yaw' ? `газ вниз + рыскание вправо ${gesture.hold} с` : '';

  // transmitter knobs (Settings -> Controls): camera tilt = FPV uptilt 0..60° or the gimbal over its range, volume
  const knobPrev: { tilt?: number; volume?: number } = {};
  const applyKnobs = () => {
    const k = input.knobs;
    if (k.tilt !== undefined && Math.abs(k.tilt - (knobPrev.tilt ?? -1)) > 0.01) {
      const quiet = knobPrev.tilt === undefined;
      knobPrev.tilt = k.tilt;
      if (gimbal) {
        const [lo, hi] = rig.gimbalRange;
        rig.gimbalPitch = Math.round(lo + (hi - lo) * k.tilt);
        if (!quiet) hud.toast(`Подвес ${rig.gimbalPitch}°`, 700);
      } else {
        view.uptiltDeg = Math.round(60 * k.tilt);
        if (!quiet) hud.toast(`Уптилт ${view.uptiltDeg}°`, 700);
      }
    }
    if (k.volume !== undefined && Math.abs(k.volume - (knobPrev.volume ?? -1)) > 0.02) {
      knobPrev.volume = k.volume;
      audio.setVolume(Math.round(k.volume * 100) / 100);
    }
  };

  const race = new Race(lesson ? [] : layout.gates); // lessons draw their own targets
  race.best = bestLap(cfg.map, preset.id);
  race.rule = st.gameplay.gateMiss;
  race.recordGhost = !lesson;
  rw.scene.add(race.marker);
  // ghost of the best lap: played back in sync with the current lap (race mode)
  let ghost: GhostPlayer | null = null;
  const setGhost = (g: GhostData | null) => { ghost = g ? new GhostPlayer(g) : null; if (g) race.bestSplits = g.splits; };
  if (raceMode) setGhost(loadGhost(cfg.map, preset.id));

  // academy lesson: runner (steps, metrics, stars) + world markers + the lesson panel (ui.lesson)
  const g0 = spawnGround();
  const runner = lesson ? new LessonRunner(lesson, { layout, home: new THREE.Vector3(g0.x, g0.y, g0.z), ground: (x, z) => groundHeight(layout, x, z) }) : null;
  const lview = runner ? new LessonView() : null;
  if (lview && runner) { rw.scene.add(lview.root); lview.setProps(runner.props); }
  const modeIdx = lesson?.mode ? preset.fc.modes.indexOf(lesson.mode) : -1;
  const applyLessonMode = () => { if (modeIdx >= 0) sim.command({ t: 'mode_index', i: modeIdx }); };
  applyLessonMode();
  if (lesson?.camera) rig.mode = lesson.camera;
  if (runner) {
    runner.tricks.onTrick = (e) => { hud.toast(`${TRICK_LABEL[e.name]} ✓`, 1400); haptic('medium'); };
    runner.onStep = () => haptic('light');
  }
  const lessonStars = (id: string) => progress.value.lessons[id]?.stars ?? 0;
  const lessonUi = lesson ? {
    id: lesson.id, title: lesson.title, brief: lesson.brief,
    goals: lesson.criteria.map((k) => ({ label: k.label, two: `${k.higher ? '≥' : '≤'} ${k.fmt(k.two)}`, three: `${k.higher ? '≥' : '≤'} ${k.fmt(k.three)}` })),
    next: nextLesson(lesson.id),
  } : null;
  let lessonKey = '';
  const lframe: LessonFrame = {
    t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Quaternion(), armed: false, mode: '', crashed: false, hit: 0,
    landed: true, sticks: input.sticks, mAh: 0, soc: 1, cutoff: false, vtolPhase: null,
  };
  /** push the lesson panel state and the markers (only when something visible changed) */
  const syncLessonUi = () => {
    if (!runner || !lessonUi || !lview) return;
    const st = runner.step;
    const sub = runner.sub(lframe), pr = Math.round(runner.progress * 50) / 50;
    const how = input.device === 'touch' ? 'свайп ARM вправо' : input.device === 'rc' ? (ARM_HOW ? `${ARM_HOW} или тумблер ARM` : 'тумблер ARM') : input.device === 'gamepad' ? (ARM_HOW || 'кнопка A') : 'Пробел';
    const text = (st?.text ?? '').replace('{arm}', how);
    const key = `${runner.state}|${runner.index}|${sub}|${pr}|${text}`;
    if (key === lessonKey) return;
    lessonKey = key;
    ui.lesson.value = {
      ...lessonUi, step: runner.index, total: runner.steps.length, text, sub, progress: pr, stick: st?.stick,
      result: runner.result, best: lessonStars(lessonUi.id),
    };
    // a step without targets (arm, climb, trick) previews where the next one goes
    const nextT = runner.steps[runner.index + 1]?.targets;
    if (runner.state === 'running') lview.setTargets(st?.targets ?? nextT ?? [], String(runner.index), !st?.targets);
    else lview.setTargets([], 'end');
  };
  const finishLesson = () => {
    const r = runner!.result!;
    if (r.state === 'done') {
      updateProgress((p) => {
        const old = p.lessons[lesson!.id];
        p.lessons[lesson!.id] = { stars: Math.max(old?.stars ?? 0, r.stars), best: Math.min(old?.best ?? Infinity, r.time) };
      });
      haptic('medium');
    }
    lessonKey = ''; syncLessonUi();
    paused = true;
    hud.setVisible(false); hud.sticks(null);
    setFlight({ phase: 'result', page: 'menu' });
    void keepAwake(false); audio.suspend();
  };
  const fmtD = (d: number) => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
  let missedNow = false; // the miss toast of this gate pass stays on screen
  race.onMiss = (g) => {
    missedNow = true;
    hud.toast(`Пропущены ворота ${g.map((i) => i + 1).join(', ')} · ${race.rule === 'penalty' ? `+${g.length * race.penaltyPerGate} с` : 'круг не засчитан'}`, 2000);
    haptic('heavy');
  };
  race.onGate = (i, delta) => {
    const quiet = missedNow; missedNow = false;
    if (i === 0) { if (race.laps === 0 && !quiet) hud.toast('СТАРТ КРУГА', 900); return; } // a finished lap has its own toast
    if (!quiet && !raceMode) hud.toast(`GATE ${i + 1} ✓${delta != null ? ` ${fmtD(delta)}` : ''}`, 700); // race: the delta is in the OSD
  };
  race.onLap = (r) => {
    if (r.best) {
      recordLap(cfg.map, preset.id, r.time);
      if (r.ghost) { saveGhost(cfg.map, preset.id, r.ghost); if (raceMode) setGhost(r.ghost); }
    }
    const d = race.lastDelta;
    hud.toast(!r.valid ? `КРУГ НЕ ЗАСЧИТАН · пропущено ворот: ${r.missed}`
      : `${r.best ? 'BEST ' : ''}LAP ${r.time.toFixed(2)} s${r.penalty ? ` (штраф +${r.penalty} s)` : ''}${d != null ? ` · ${fmtD(d)}` : ''}`, 2600);
    haptic(r.best ? 'medium' : 'light');
  };

  // interpolation between the last two physics states of the snapshot
  const prevPos = new THREE.Vector3(), curPos = new THREE.Vector3();
  const prevRot = new THREE.Quaternion(), curRot = new THREE.Quaternion();
  const drawPos = new THREE.Vector3(), drawRot = new THREE.Quaternion();
  const camFwd = new THREE.Vector3(), camUp = new THREE.Vector3();

  /** energy left: recent average current (A), fuel burn rate (l/s), pack capacity (Ah), tank (l) */
  let ampsAvg = 0, fuelRate = 0, fuelPrev: number | null = null, energyT = 0;
  const packAh = (preset.battery?.capacity_mah ?? 0) / 1000, fuelMax = preset.engine?.fuel_l ?? 0;
  let running = false, paused = false, flightTime = 0, armedAt = 0, lastHitAt = -1, wasArmed = false, startedAt = 0;
  let acc = 0, last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0, stepsAcc = 0, simHz = 0;
  const baseAlt = () => spawnPose().pos.y;
  const flying = () => running && !paused;

  // kamikaze blast: effect in the world, the FPV feed cut, an observer camera on the explosion
  let blast: Explosion | null = null;
  const lastVel = new THREE.Vector3(), blastAt = new THREE.Vector3();
  const startBlast = (s: SimSnapshot) => {
    const b = s.blast!;
    blastAt.set(b.pos.x, b.pos.y, b.pos.z);
    const gy = isFinite(s.groundDist) && s.groundDist < 50 ? b.pos.y - s.groundDist : groundHeight(layout, b.pos.x, b.pos.z);
    blast?.dispose();
    blast = new Explosion(blastAt, b.radius, gy, quality.simHz < 1000 ? 0.5 : 1);
    rw.scene.add(blast.root);
    view.root.visible = false;
    // observer: behind the approach direction, above the fireball (the ground pilot keeps his own view)
    if (rig.mode !== 'los') {
      const dir = lastVel.lengthSq() > 1 ? lastVel.clone().setY(0) : rig.camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
      dir.normalize();
      const R = b.radius, from = blastAt.clone().addScaledVector(dir, -R * 3.5);
      from.y = Math.max(blastAt.y + R * 1.3, gy + 2);
      rig.blast = { from, at: blastAt.clone().setY(blastAt.y + R * 0.5) };
    }
    if (rig.mode === 'fpv') hud.noSignal(true);
    audio.explosion(rig.mode === 'fpv' ? b.radius * 3.5 : rig.camera.position.distanceTo(blastAt), b.radius);
    haptic('heavy');
  };
  const endBlast = () => {
    blast?.dispose(); blast = null;
    view.root.visible = true; rig.blast = null; rig.shake = 0;
    hud.noSignal(false); hud.flash(0);
  };

  sim.onSnapshot = (s: SimSnapshot) => {
    for (const t of s.toasts) { hud.toast(t.text, t.ms); if (t.haptic) haptic(t.haptic); }
    if (s.blastNew && s.blast) startBlast(s);
    else if (!s.blast) lastVel.set(s.vel.x, s.vel.y, s.vel.z);
    if (s.crashNew && s.crash) { haptic('heavy'); audio.impact(s.crash.impulse); }
    else if (s.hit > 0.08 && s.time - lastHitAt > 0.25) { audio.impact(s.hit); haptic(s.hit > 0.5 ? 'medium' : 'light'); }
    if (s.hit > 0.08) lastHitAt = s.time;
    if (s.armed && !wasArmed) armedAt = s.time;
    if (s.armed !== wasArmed) { wasArmed = s.armed; audio.armed(wasArmed); }
    if (s.armed) flightTime = s.time - armedAt;
    stepsAcc += s.steps;
  };

  const reset = () => {
    sim.command({ t: 'reset', ...spawnPose() });
    endBlast();
    applyLessonMode();
    input.sticks.throttle = thr0();
    input.touch?.setThrottle(thr0());
    race.reset(); flightTime = 0; ampsAvg = 0; fuelRate = 0; fuelPrev = null;
    hud.message('');
    if (runner) { runner.restart(); lessonKey = ''; syncLessonUi(); }
  };

  const start = () => {
    running = true; paused = false; startedAt = performance.now();
    // follow the mode / camera switches (they may have moved before the start or in the pause), unless the lesson fixes them
    input.resyncSwitches([...(lesson?.lockMode ? [] : ['mode' as const]), ...(lesson?.camera ? [] : ['camera' as const])]);
    setFlight({ phase: 'running', page: 'menu' });
    hud.setVisible(true);
    canvas.focus();
    last = performance.now();
    void enterImmersive(); void keepAwake(true);
    void audio.start();
  };
  const pause = () => {
    paused = true;
    setFlight({ phase: 'paused', page: 'menu', sub: `${mapName} · ${droneTitle(preset)}` });
    void keepAwake(false); audio.suspend();
  };
  ui.hooks = {
    start, restart: reset, exit: exitToMenu,
    editLayout: TOUCH ? () => {
      const t = input.touch!, phase = ui.flight.value.phase;
      setFlight({ phase: 'running' }); hud.setVisible(false); t.setVisible(true); t.edit(true);
      t.onEditDone = () => { setFlight({ phase }); };
    } : undefined,
    applyRates: (id, r) => { if (id === preset.id) sim.command({ t: 'rates', rates: r }); },
    setUptilt: (deg) => { view.uptiltDeg = deg; },
    setSound: (v, muted) => audio.setVolume(v, muted),
    retry: runner ? () => { reset(); start(); } : undefined,
    next: lessonUi?.next ? () => exitToMenu(undefined, lessonUi.next) : undefined,
  };
  if (lesson) ui.hooks.exit = () => exitToMenu('academy');
  if (raceMode) ui.hooks.exit = () => exitToMenu('play');
  syncLessonUi();
  const fmtLap = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  setFlight({
    phase: 'ready',
    sub: raceMode ? `${droneTitle(preset)} · time trial, ${race.total} ворот по порядку · пропуск ворот: ${race.rule === 'penalty' ? `+${MISS_PENALTY_S} с` : 'круг не засчитан'}` +
      (isFinite(race.best) ? ` · лучший круг ${fmtLap(race.best)}${ghost ? ' (призрак)' : ''}` : '')
      : `${droneTitle(preset)} · ${layout.env.description ?? ''}`,
  });
  addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (e.code === 'Enter' && ui.flight.value.phase === 'ready' && !(a instanceof HTMLButtonElement)) start();
  });
  // Android back = pause / resume; leaving the app pauses the flight
  lifecycle(() => input.push('pause'), () => { if (flying()) input.push('pause'); });

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    rw.resize(w, h); rig.setAspect(w / h);
  };
  addEventListener('resize', resize); resize();

  // Betaflight CLI rates: paste `set roll_rc_rate = …` lines (from `diff` / `dump`) anywhere in the flight
  addEventListener('paste', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.tagName === 'TEXTAREA' || t?.tagName === 'INPUT') return;
    sim.command({ t: 'rates_cli', text: e.clipboardData?.getData('text') ?? '' });
  });

  const MODE_KEYS = ['mode_acro', 'mode_angle', 'mode_horizon', 'mode_4'];
  /** what a lesson with a fixed mode does not allow: mode switches, RTH / landing automation */
  const LOCKED = new Set(['mode_next', 'mode_acro', 'mode_angle', 'mode_horizon', 'mode_4', 'rth', 'rth_on', 'rth_off', 'land']);
  const RTH_MODE = /rth|rtl|home/;
  const handleActions = () => {
    // a click / A-button that started the flight must not also arm or restart it
    const fresh = performance.now() - startedAt < 250;
    for (const a of input.takeActions()) {
      if ((!flying() || (fresh && !MODE_KEYS.includes(a) && !a.startsWith('cam_'))) && !IDLE_ACTIONS.has(a)) continue;
      if (lesson && (a === 'next_spawn' || (lesson.lockMode && (LOCKED.has(a) || (a === 'help' && (gps || plane)))))) {
        hud.toast(a === 'next_spawn' ? 'В уроке старт фиксирован' : 'В этом уроке режим фиксирован', 1100);
        continue;
      }
      switch (a) {
        case 'arm': sim.command({ t: 'arm', throttle: input.sticks.throttle }); break;
        case 'arm_on': if (!sim.snap.armed) sim.command({ t: 'arm', throttle: input.sticks.throttle }); break;
        case 'arm_off': if (sim.snap.armed) sim.command({ t: 'arm', throttle: input.sticks.throttle }); break;
        case 'reset': reset(); break;
        case 'next_spawn': spawnIdx = (spawnIdx + 1) % spawns.length; setPilot(); placeRail(); reset(); hud.toast(`Старт: ${spawns[spawnIdx].kind}`); break;
        case 'camera': rig.mode = CAM_ORDER[(CAM_ORDER.indexOf(rig.mode) + 1) % CAM_ORDER.length]; hud.toast(gimbal && rig.mode === 'fpv' ? 'Камера на подвесе' : CAM_LABEL[rig.mode], 900); break;
        case 'mode_next': sim.command({ t: 'mode_next' }); break;
        case 'mode_acro': case 'mode_angle': case 'mode_horizon': case 'mode_4': sim.command({ t: 'mode_index', i: MODE_KEYS.indexOf(a) }); break;
        case 'rth': sim.command({ t: 'rth' }); break;
        case 'land': sim.command({ t: 'land' }); break;
        case 'uptilt_up':
          if (gimbal) { tiltGimbal(5); break; }
          view.uptiltDeg = Math.min(60, view.uptiltDeg + 5); hud.toast(`Уптилт ${view.uptiltDeg}°`, 900); break;
        case 'uptilt_down':
          if (gimbal) { tiltGimbal(-5); break; }
          view.uptiltDeg = Math.max(-20, view.uptiltDeg - 5); hud.toast(`Уптилт ${view.uptiltDeg}°`, 900); break;
        case 'fov': rig.fpvHFov = rig.fpvHFov >= 130 ? 60 : rig.fpvHFov + 20; hud.toast(`FOV ${rig.fpvHFov}°`, 900); break;
        case 'debug': hud.toggleDebug(); break;
        case 'props': rig.showDroneInFpv = !rig.showDroneInFpv; hud.toast(rig.showDroneInFpv ? 'Пропеллеры в кадре FPV' : 'Без пропеллеров в FPV', 1100); break;
        case 'mouse': input.toggleMouse(); hud.toast(input.mouseMode ? 'Мышь = правый стик' : 'Мышь выкл.', 1200); break;
        case 'pause': {
          if (!running || ui.flight.value.phase === 'result') break;
          const f = ui.flight.value;
          if (paused && f.page !== 'menu') { setFlight({ page: 'menu' }); break; } // Esc in a pause sub-page: back
          if (paused) start(); else pause();
          break;
        }
        case 'help':
          if (gps || plane) { sim.command({ t: 'rth' }); break; } // GPS drones / planes: H = return to home (PLAN.md 5.2)
          pause(); setFlight({ page: 'help' }); break;
        // training scenario: one motor stops (hex with failure handling stays flyable, a quad goes down)
        case 'detonate': if (preset.warhead) sim.command({ t: 'detonate' }); break;
        case 'motor_fail': if (!plane) sim.command({ t: 'motor_fail', index: Math.floor(Math.random() * info.rotors) }); break;
        case 'mute': { const m = audio.toggleMute(); hud.toast(m ? 'Звук выкл.' : 'Звук вкл.', 900); break; }
        case 'turtle': sim.command({ t: 'turtle' }); break;
        case 'cam_0': case 'cam_1': case 'cam_2': {
          const m = CAM_ORDER[+a.slice(4)];
          if (m && m !== rig.mode) { rig.mode = m; hud.toast(gimbal && m === 'fpv' ? 'Камера на подвесе' : CAM_LABEL[m], 900); }
          break;
        }
        // transmitter switches are levels: act only when the drone is not already in that state
        case 'turtle_on': case 'turtle_off': if (!gps && !plane && sim.snap.turtle !== (a === 'turtle_on')) sim.command({ t: 'turtle' }); break;
        case 'rth_on': case 'rth_off': if ((gps || plane) && RTH_MODE.test(sim.snap.mode) !== (a === 'rth_on')) sim.command({ t: 'rth' }); break;
      }
    }
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.throttleCentered = sim.snap.centredThrottle;
    input.update(dt);
    if (gimbal && input.wheel) { tiltGimbal(-input.wheel * 2); input.wheel = 0; }
    applyKnobs();
    if (flying() && input.device !== 'keyboard' && input.device !== 'mouse') {
      const g = stickArm.update(dt, input.sticks, sim.snap.armed, sim.snap.nav?.landed ?? false);
      if (g) { input.push(g === 'arm' ? 'arm_on' : 'arm_off'); hud.toast(g === 'arm' ? 'Моторы запущены' : 'Моторы остановлены', 1000); }
    }
    if (input.touch) input.touch.setVisible(input.device === 'touch' && (ui.flight.value.phase === 'running' || input.touch.editing));
    handleActions();

    let steps = 0;
    if (flying()) {
      acc += dt;
      steps = Math.min(MAX_PENDING_STEPS, Math.floor(acc / simDt));
      acc -= steps * simDt;
      if (steps === MAX_PENDING_STEPS) acc = 0; // > 40 ms behind -> slow motion instead of a spiral of death
    }
    sim.advance(input.sticks, steps); // also delivers queued commands while paused
    const s = sim.snap;
    prevPos.set(s.prevPos.x, s.prevPos.y, s.prevPos.z); curPos.set(s.pos.x, s.pos.y, s.pos.z);
    prevRot.set(s.prevRot.x, s.prevRot.y, s.prevRot.z, s.prevRot.w); curRot.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
    race.rule = settings.value.gameplay.gateMiss; // may change from the pause settings
    if (race.active && flying()) race.update(s.time, curPos, curRot);
    if (runner && flying() && runner.state === 'running') {
      const f = lframe, nav = s.nav, pl = s.plane;
      f.t = s.time; f.pos.copy(curPos); f.vel.set(s.vel.x, s.vel.y, s.vel.z); f.rot.copy(curRot);
      f.armed = s.armed; f.mode = s.mode; f.crashed = !!s.crash || !!s.blast; f.hit = s.hit;
      f.landed = nav ? nav.landed : pl ? pl.phase === 'landed' : s.groundDist < 0.15 && Math.hypot(s.vel.x, s.vel.y, s.vel.z) < 0.4;
      f.mAh = s.bat.mAh; f.soc = s.bat.soc; f.cutoff = s.bat.cutoff && s.bat.present; f.vtolPhase = pl?.vtolPhase ?? null;
      runner.update(f);
      syncLessonUi();
      if (runner.state !== 'running') finishLesson();
    }
    lview?.update(dt);
    const alpha = Math.min(1, acc / simDt);
    drawPos.lerpVectors(prevPos, curPos, alpha);
    drawRot.slerpQuaternions(prevRot, curRot, alpha);
    view.root.position.copy(drawPos);
    view.root.quaternion.copy(drawRot);
    view.update(dt, s.omega);
    if (ghostView) updateGhost(dt, s.time);
    if (s.plane) view.setElevons(s.plane.elevL, s.plane.elevR);
    if (blast) {
      blast.update(dt);
      const t = blast.t, d = rig.camera.position.distanceTo(blastAt), fpvCut = rig.mode === 'fpv' ? BLAST_NO_SIGNAL_S : 0;
      rig.shake = blast.shakeAt(d);
      if (t > fpvCut) hud.noSignal(false); // the feed is gone: cut to the observer camera
      hud.flash(t < fpvCut ? 0 : Math.max(0, 1 - (t - fpvCut) / 0.35) * Math.min(0.85, (blast.radius * 4) / Math.max(1, d)));
    }
    rig.update(dt, drawPos, drawRot, view.eye, view.uptiltDeg, view.size);
    rw.followSun(drawPos);
    rw.renderer.render(rw.scene, rig.camera);
    const cam = rig.camera, fwd = camFwd.set(0, 0, -1).applyQuaternion(cam.quaternion), up = camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    audio.update(dt, {
      omega: s.omega, thrust: s.thrust, omegaMax: info.visOmegaMax, kT0: info.visKT0,
      vrs: s.vrs, airspeed: s.airspeed, pos: drawPos, vel: s.vel,
      cam: cam.position, camFwd: fwd, camUp: up, fpv: rig.mode === 'fpv', lowBattery: s.bat.low && s.armed,
    });

    // OSD
    fpsAcc += dt; fpsN++;
    if (fpsAcc >= 0.5) { fps = Math.round(fpsN / fpsAcc); simHz = Math.round(stepsAcc / fpsAcc); fpsAcc = 0; fpsN = 0; stepsAcc = 0; }
    const v = s.vel, b = s.bat, nav = s.nav, pl = s.plane;
    // time left at the recent average draw / burn rate, in simulated time (a pause or slow motion changes nothing)
    const sdt = s.time - energyT;
    if (sdt > 0) {
      const k = 1 - Math.exp(-sdt / ENERGY_AVG_S);
      ampsAvg += ((s.armed ? b.current : 0) - ampsAvg) * k;
      if (pl?.fuel != null) { if (fuelPrev != null) fuelRate += (Math.max(0, (fuelPrev - pl.fuel) / sdt) - fuelRate) * k; fuelPrev = pl.fuel; }
    }
    energyT = s.time;
    if (input.touch) { input.touch.setArmed(s.armed); input.touch.setMode(s.mode.toUpperCase()); }
    const deg = (r: number) => Math.round(((r * 180) / Math.PI + 360) % 360).toString().padStart(3, '0');
    hud.update({
      armed: s.armed, mode: s.mode, throttle: input.sticks.throttle,
      alt: nav ? nav.altitude : pl ? pl.altitude : curPos.y - baseAlt(),
      nav: nav ? `D ${nav.distHome.toFixed(0)} m · H.S ${nav.hSpeed.toFixed(1)} · V.S ${nav.vSpeed.toFixed(1)} m/s`
        : pl ? `IAS ${Math.round(pl.airspeed * 3.6)} · HDG ${deg(pl.heading)}° · D ${(pl.distHome / 1000).toFixed(2)} km${pl.wpCount && /AUTO|MISSION/.test(s.mode) ? ` · WP ${pl.wp + 1}/${pl.wpCount} ${(pl.wpDist / 1000).toFixed(2)} km` : ''}` : undefined,
      warn: s.motorFailed ? 'ОТКАЗ МОТОРА — САДИСЬ' : pl?.stalled && s.armed ? 'STALL — ОТДАЙ РУЧКУ' : pl?.protecting && s.armed && pl.phase === 'flight' ? 'МАЛАЯ СКОРОСТЬ — ЗАЩИТА'
        : nav?.obstacle ? 'ПРЕПЯТСТВИЕ — ТОРМОЖЕНИЕ' : nav && nav.rthPhase !== 'idle' ? RTH_PHASE[nav.rthPhase] : undefined,
      bat: b.present ? {
        volts: b.vFilt, cell: b.cellFilt, amps: b.current, mah: b.mAh, low: b.low, cutoff: b.cutoff, soc: b.soc,
        remainS: s.armed && ampsAvg > 0.3 ? (packAh * 3600 * b.soc) / ampsAvg : null,
      } : null,
      fuel: pl?.fuel != null && fuelMax ? { l: pl.fuel, max: fuelMax, remainS: s.armed && fuelRate > 1e-5 ? pl.fuel / fuelRate : null } : null,
      charge: preset.warhead && !s.blast ? { live: s.fuse, key: input.device === 'touch' ? '✸ ПОДРЫВ' : input.device === 'gamepad' ? 'RB' : input.device === 'rc' ? 'тумблер / E' : 'E' } : null,
      speedKmh: Math.hypot(v.x, v.y, v.z) * 3.6, flightTime, camera: gimbal && rig.mode === 'fpv' ? `Подвес ${rig.gimbalPitch}°` : CAM_LABEL[rig.mode],
      device: input.device === 'gamepad' || input.device === 'rc' ? `${DEVICE_LABEL[input.device]} · ${input.gamepadName}${input.calibrated ? '' : ' (по умолч.)'}` : DEVICE_LABEL[input.device],
      fps, simHz, fpv: rig.mode === 'fpv',
      lap: race.active && (raceMode || !plane) && !runner ? {
        next: race.next, total: race.total, current: race.lapStart >= 0 ? s.time - race.lapStart : 0, last: race.lastLap, best: race.best,
        delta: s.time - race.lastDeltaAt < 3 ? race.lastDelta : null, missed: race.missed, penalty: race.penalty,
      } : null,
    });
    hud.sticks(lesson?.showSticks && flying() && input.device !== 'touch' ? input.sticks : null, runner?.step?.stick); // touch sticks are on screen anyway
    const hints = settings.value.gameplay.hints;
    const how = input.device === 'touch' ? 'Свайп ARM вправо' : input.device === 'rc' ? (ARM_HOW ? `${ARM_HOW[0].toUpperCase()}${ARM_HOW.slice(1)} или тумблер ARM` : 'Тумблер ARM') : input.device === 'gamepad' ? (ARM_HOW ? `${ARM_HOW[0].toUpperCase()}${ARM_HOW.slice(1)} или A` : 'A') : 'Пробел';
    if (s.blast) hud.message(`<span style="color:var(--danger)">ПОДРЫВ</span><small>${s.blast.cause === 'impact' ? `контактный взрыватель · удар на ${(s.blast.speed * 3.6).toFixed(0)} км/ч` : 'подрыв по команде'} · ${input.device === 'touch' ? '⟲' : 'R'} — рестарт</small>`);
    else if (s.crash) hud.message(`CRASH<small>удар ${s.crash.impulse.toFixed(1)} Н·с на ${(s.crash.speed * 3.6).toFixed(0)} км/ч · ${input.device === 'touch' ? '⟲' : 'R'} — рестарт</small>`);
    else if (pl?.phase === 'landed') hud.message('<small>Посадка завершена · R — рестарт</small>');
    else if (!hints || !flying()) hud.message('');
    else if (!s.armed) {
      hud.message(info.plane ? `<small>${how} — запуск двигателя (газ в ноль), затем газ до упора — старт с направляющей</small>`
        : gps ? `<small>${how} — запуск моторов, затем газ вверх — взлёт</small>`
        : input.sticks.throttle > 0.05 ? '<small>Опусти газ в ноль, чтобы армить</small>' : `<small>${how} — арм</small>`);
    } else if (pl?.phase === 'rail') hud.message('<small>Газ до упора — пуск ускорителя</small>');
    else if (raceMode && race.lapStart < 0 && !nav?.landed) hud.message('<small>Лети в подсвеченные ворота 1 — старт круга</small>');
    else if (nav?.landed && s.armed) hud.message(info.vtol ? '<small>Газ вверх — взлёт · 2/3 — переход в самолёт в воздухе · газ вниз 1 с — стоп</small>' : '<small>Газ вверх — взлёт · газ вниз 1 с — остановить моторы</small>');
    else hud.message('');
    if (hud.debugVisible) {
      const rpm = Array.from(s.omega, (w) => Math.round((w * 60) / (2 * Math.PI)).toString().padStart(6));
      const sp = s.setpoint.map((x) => ((x * 180) / Math.PI).toFixed(0).padStart(5));
      const stk = input.sticks;
      hud.debug(`RPM   ${rpm.join(' ')}\nCMD   ${Array.from(s.cmd, (c) => c.toFixed(2)).join('  ')}\n` +
        `SP°/s ${sp.join(' ')}\nSTICK T ${stk.throttle.toFixed(2)} R ${stk.roll.toFixed(2)} P ${stk.pitch.toFixed(2)} Y ${stk.yaw.toFixed(2)}\n` +
        `AXES  ${input.rawAxes.map((a) => a.toFixed(2)).join(' ')}\nPOS   ${curPos.toArray().map((x) => x.toFixed(1)).join(' ')}\n` +
        `IMPULSE ${s.hit.toFixed(3)} N·s  GROUND ${isFinite(s.groundDist) ? s.groundDist.toFixed(2) : '—'} m  SIM ${sim.kind}\n` +
        `BAT ${b.vbus.toFixed(2)} V  ${b.current.toFixed(1)} A  SoC ${(b.soc * 100).toFixed(1)} %  PHASE ${Array.from(s.phaseA, (a) => a.toFixed(0)).join(' ')} A\n` +
        `WIND ${s.wind.x.toFixed(1)} ${s.wind.y.toFixed(1)} ${s.wind.z.toFixed(1)} m/s  PROPWASH ${(s.vrs * 100).toFixed(0)} %  TPA ${s.tpa.toFixed(2)}  AG ${s.ag.toFixed(2)}` +
        (pl ? `\nWING α ${((pl.alpha * 180) / Math.PI).toFixed(1)}°  ELEVON ${((pl.elevL * 180) / Math.PI).toFixed(1)} ${((pl.elevR * 180) / Math.PI).toFixed(1)}°  PHASE ${pl.phase}${pl.vtolPhase ? ' / ' + pl.vtolPhase : ''}  CHUTE ${(pl.chute * 100).toFixed(0)} %` : ''));
    }
  };
  // the ghost: pose from the best lap at the current lap time; fades out near the camera (FPV through it)
  const GHOST_OMEGA = new Float32Array(info.rotors).fill(400), ghostPos = new THREE.Vector3();
  const updateGhost = (dt: number, time: number) => {
    const g = ghostView!;
    const on = !!ghost && running && ghost.sample(race.lapTime(time), g.root.position, g.root.quaternion);
    g.root.visible = on;
    if (!on) return;
    const d = ghostPos.copy(g.root.position).distanceTo(rig.camera.position);
    const a = GHOST_ALPHA * Math.min(1, Math.max(0, (d - 0.4) / 1.6));
    for (const m of ghostMats) m.opacity = a;
    g.update(dt, GHOST_OMEGA);
    for (const r of g.rotors) if (r.blur) (r.blur.material as THREE.Material).opacity *= a;
  };
  requestAnimationFrame(frame);
  // dev-only handle for automated checks in the browser (window.__ds.sim / input / rig / race / start / reset)
  if (import.meta.env.DEV) {
    Object.assign(window, { __ds: { blast: () => blast, ghost: () => ghost, ghostView, sim, host: sim.kind === 'local' ? (sim as unknown as { host: unknown }).host : null, input, rig, race, view, rw, start, reset, pause, lesson: runner, ratesFromCli, ratesToCli, quality, audio } });
  }
}

const GHOST_ALPHA = 0.55;
/** averaging time of the current / fuel burn behind the OSD "time left" (s) */
const ENERGY_AVG_S = 4;
/** FPV view of a blast: static before the cut to the observer camera (s) */
const BLAST_NO_SIGNAL_S = 0.5;
/** Ghost look: translucent cyan copy of the drone, visible to every camera (FPV too), no shadows. */
function ghostify(root: THREE.Object3D): THREE.Material[] {
  const mats: THREE.Material[] = [];
  root.traverse((o) => {
    o.layers.set(0);
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = false; m.receiveShadow = false; m.renderOrder = 4;
    const src = Array.isArray(m.material) ? m.material : [m.material];
    const out = src.map((x) => {
      const c = new THREE.MeshBasicMaterial({ color: 0x3dd9ff, transparent: true, opacity: GHOST_ALPHA, depthWrite: false, fog: false, side: x.side });
      mats.push(c); return c;
    });
    m.material = Array.isArray(m.material) ? out : out[0];
  });
  return mats;
}

/** Launch rail of the delta wing: an inclined beam from the start point forward, on two legs (spawn axes). */
function makeRail(p: DronePreset): THREE.Object3D {
  const l = p.launch!, g = new THREE.Group(), L = l.rail_length_m;
  const mat = new THREE.MeshStandardMaterial({ color: 0x5a6068, metalness: 0.6, roughness: 0.5 });
  const el = (l.rail_elev_deg * Math.PI) / 180, top = l.rail_height_m - 0.3; // beam top just under the belly
  const at = (d: number) => ({ y: top + Math.sin(el) * d, z: -Math.cos(el) * d }); // point d metres along the rail
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, L + 1), mat);
  const c = at(L / 2 - 0.5);
  beam.position.set(0, c.y - 0.1, c.z);
  beam.rotation.x = el;
  const leg = (d: number) => {
    const q = at(d), m = new THREE.Mesh(new THREE.BoxGeometry(0.2, q.y, 0.2), mat);
    m.position.set(0, q.y / 2 - 0.1, q.z); return m;
  };
  g.add(beam, leg(0), leg(L * 0.85));
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  return g;
}
