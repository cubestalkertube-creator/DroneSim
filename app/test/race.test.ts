import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GHOST_HZ, GhostPlayer, MISS_PENALTY_S, Race, decodeGhost, encodeGhost, type LapResult } from '../src/game/race';
import { layout } from './helpers';

const L = layout('training_field');
const N = L.gates.length;

/** Scripted flight: straight segments through the gate centres along each gate's normal, constant speed per lap. */
function course(laps: number[][], speeds: number[], finish = true) {
  const pts: THREE.Vector3[] = [], segV: number[] = [];
  const centres: { gate: number; vi: number }[] = [];
  const g0 = L.gates[0], f0 = new THREE.Vector3(...g0.forward).normalize();
  pts.push(new THREE.Vector3(...g0.c).addScaledVector(f0, -8));
  const through = (gi: number, v: number) => {
    const g = L.gates[gi], c = new THREE.Vector3(...g.c), f = new THREE.Vector3(...g.forward).normalize();
    pts.push(c.clone().addScaledVector(f, -2)); segV.push(v);
    pts.push(c); segV.push(v); centres.push({ gate: gi, vi: pts.length - 1 });
    pts.push(c.clone().addScaledVector(f, 2)); segV.push(v);
  };
  laps.forEach((order, k) => order.forEach((gi) => through(gi, speeds[k])));
  if (finish) through(0, speeds[speeds.length - 1]); // finish of the last lap
  const tv = [0];
  for (let i = 1; i < pts.length; i++) tv.push(tv[i - 1] + pts[i].distanceTo(pts[i - 1]) / segV[i - 1]);
  const at = (t: number, out: THREE.Vector3) => {
    let i = 1;
    while (i < tv.length - 1 && tv[i] < t) i++;
    const f = Math.min(1, Math.max(0, (t - tv[i - 1]) / (tv[i] - tv[i - 1])));
    return out.lerpVectors(pts[i - 1], pts[i], f);
  };
  return { at, T: tv[tv.length - 1], centres: centres.map((c) => ({ gate: c.gate, t: tv[c.vi] })) };
}
const AXIS = new THREE.Vector3(1, 1, 0).normalize();
const rotAt = (t: number, q = new THREE.Quaternion()) => q.setFromAxisAngle(AXIS, t * 0.7);
const ORDER = [...Array(N).keys()];

/** fly a course through the race with a frame time that jitters around `dt` */
function run(race: Race, c: ReturnType<typeof course>, dt = 1 / 60, jitter = 0) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion();
  let k = 0;
  for (let t = 0; t <= c.T + dt; k++) {
    race.update(t, c.at(t, p), rotAt(t, q));
    t += dt * (1 + jitter * Math.sin(k * 1.7));
  }
}

describe('race gates', () => {
  it('every training_field gate faces the course (normal within 15° of the loop tangent)', () => {
    for (let i = 0; i < N; i++) {
      const prev = new THREE.Vector3(...L.gates[(i + N - 1) % N].c), next = new THREE.Vector3(...L.gates[(i + 1) % N].c);
      const t = next.sub(prev).normalize(), f = new THREE.Vector3(...L.gates[i].forward).normalize();
      expect(Math.abs(f.dot(t)), `gate ${i + 1}`).toBeGreaterThan(Math.cos(THREE.MathUtils.degToRad(15)));
    }
  });

  it('passing through gates in order counts, lap completes on gate 1', () => {
    const race = new Race(L.gates);
    const laps: LapResult[] = [];
    race.onLap = (r) => laps.push(r);
    let t = 0;
    const flyThrough = (i: number) => {
      const g = L.gates[i];
      const c = new THREE.Vector3(...g.c);
      const f = new THREE.Vector3(...g.forward).normalize();
      for (let k = -10; k <= 10; k++) { t += 0.05; race.update(t, c.clone().addScaledVector(f, k * 0.2)); }
    };
    for (let i = 0; i < N; i++) { flyThrough(i); expect(race.next).toBe((i + 1) % N); }
    flyThrough(0);
    expect(laps.length).toBe(1);
    expect(laps[0].valid).toBe(true);
    expect(laps[0].time).toBeGreaterThan(0);
  });

  it('flying around a gate (outside the frame) does not count', () => {
    const race = new Race(L.gates);
    const g = L.gates[0];
    const c = new THREE.Vector3(...g.c).add(new THREE.Vector3(0, 3, 0)); // above the frame
    const f = new THREE.Vector3(...g.forward).normalize();
    for (let k = -10; k <= 10; k++) race.update(k, c.clone().addScaledVector(f, k * 0.2));
    expect(race.next).toBe(0);
  });
});

describe('race splits', () => {
  it('lap and split times are the exact (sub-frame) crossing times, delta to the best lap per gate', () => {
    const c = course([ORDER, ORDER], [10, 12]);
    const race = new Race(L.gates);
    const laps: LapResult[] = [], deltas: (number | null)[] = [];
    race.onLap = (r) => laps.push(r);
    race.onGate = (i, d) => { if (race.laps === 1 && i > 0) deltas.push(d); };
    run(race, c, 1 / 30); // coarse frames: 0.33-0.4 m per frame
    expect(laps.length).toBe(2);
    const tc = c.centres.map((x) => x.t); // gate 0, 1…9, gate 0, 1…9, gate 0
    const lap1 = tc[N] - tc[0], lap2 = tc[2 * N] - tc[N];
    expect(laps[0].time).toBeCloseTo(lap1, 6);
    expect(laps[1].time).toBeCloseTo(lap2, 6);
    expect(laps[0].best && laps[1].best).toBe(true);
    for (let j = 0; j < N - 1; j++) {
      expect(laps[0].splits[j]).toBeCloseTo(tc[j + 1] - tc[0], 6);
      expect(laps[1].splits[j]).toBeCloseTo(tc[N + j + 1] - tc[N], 6);
    }
    expect(laps[0].splits[N - 1]).toBeCloseTo(lap1, 6);
    // lap 2 is 20 % faster: every split is ahead of the best (lap 1) by its own margin
    expect(deltas.length).toBe(N - 1);
    deltas.forEach((d, j) => expect(d!).toBeCloseTo(laps[1].splits[j] - laps[0].splits[j], 6));
    expect(deltas.every((d) => d! < 0)).toBe(true);
    expect(race.lastDelta!).toBeCloseTo(lap2 - lap1, 6);
    expect(race.best).toBeCloseTo(lap2, 6);
    expect(race.bestSplits).toEqual(laps[1].splits);
  });

  it('a slower lap is not the best: positive deltas, no ghost', () => {
    const race = new Race(L.gates);
    const laps: LapResult[] = [];
    race.onLap = (r) => laps.push(r);
    run(race, course([ORDER, ORDER], [12, 10]));
    expect(laps[1].best).toBe(false);
    expect(laps[1].ghost).toBeNull();
    expect(race.lastDelta!).toBeGreaterThan(0);
    expect(race.best).toBeCloseTo(laps[0].time, 9);
  });
});

describe('race ghost', () => {
  it('records the lap at 50 Hz and plays it back along the flown path', () => {
    const c = course([ORDER], [11]);
    const race = new Race(L.gates);
    let lap: LapResult | null = null;
    race.onLap = (r) => (lap = r);
    run(race, c, 1 / 60, 0.4); // uneven frame times
    expect(lap).not.toBeNull();
    const g = lap!.ghost!;
    expect(g.hz).toBe(GHOST_HZ);
    const frames = g.frames.length / 7;
    expect(Math.abs(frames - (lap!.time * GHOST_HZ + 1))).toBeLessThan(2);
    const player = new GhostPlayer(g);
    expect(player.duration).toBeGreaterThan(lap!.time - 0.03);
    const t0 = c.centres[0].t, p = new THREE.Vector3(), q = new THREE.Quaternion(), ref = new THREE.Vector3();
    let maxErr = 0, maxAng = 0, sumErr = 0, n = 0;
    for (let t = 0; t < lap!.time; t += 0.013) {
      expect(player.sample(t, p, q)).toBe(true);
      const e = p.distanceTo(c.at(t0 + t, ref));
      maxErr = Math.max(maxErr, e); sumErr += e; n++;
      maxAng = Math.max(maxAng, q.angleTo(rotAt(t0 + t)));
    }
    expect(maxErr).toBeLessThan(0.12); // corners of the scripted path are cut by < one frame
    expect(sumErr / n).toBeLessThan(0.01);
    expect(maxAng).toBeLessThan(0.01);
    expect(player.sample(-0.1, p, q)).toBe(false);
    expect(player.sample(player.duration + 0.1, p, q)).toBe(false);
  });

  it('plays back in sync with the current lap (same pace = same place)', () => {
    const c = course([ORDER, ORDER], [10, 10]);
    const race = new Race(L.gates);
    let player: GhostPlayer | null = null;
    race.onLap = (r) => { if (r.ghost) player = new GhostPlayer(r.ghost); };
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), gp = new THREE.Vector3(), gq = new THREE.Quaternion();
    let maxErr = 0, n = 0;
    for (let t = 0; t <= c.T; t += 1 / 60) {
      race.update(t, c.at(t, p), rotAt(t, q));
      const lt = race.lapTime(t);
      if (player && race.laps === 1 && (player as GhostPlayer).sample(lt, gp, gq)) { maxErr = Math.max(maxErr, gp.distanceTo(p)); n++; }
    }
    expect(n).toBeGreaterThan(1000);
    expect(maxErr).toBeLessThan(0.12);
  });

  it('survives storage: compact delta-coded integers, < 1 mm / 1e-4 error', () => {
    const race = new Race(L.gates);
    let g = null as LapResult['ghost'];
    race.onLap = (r) => (g = r.ghost);
    run(race, course([ORDER], [12]));
    const json = JSON.stringify(encodeGhost(g!));
    const back = decodeGhost(JSON.parse(json))!;
    expect(back.frames.length).toBe(g!.frames.length);
    let e = 0;
    g!.frames.forEach((v, i) => (e = Math.max(e, Math.abs(v - back.frames[i]))));
    expect(e).toBeLessThan(6e-4);
    expect(back.lap).toBe(g!.lap);
    expect(back.splits[3]).toBeCloseTo(g!.splits[3], 3);
    expect(json.length / (g!.frames.length / 7)).toBeLessThan(40); // bytes per 50 Hz frame
    expect(decodeGhost({ v: 1, hz: 50, lap: 1, splits: [], d: [1, 2, 3] })).toBeNull();
    expect(decodeGhost(null)).toBeNull();
  });
});

describe('race missed gates', () => {
  const skip3 = ORDER.filter((i) => i !== 3);

  it('penalty: flying past a gate to the next one adds the penalty to the splits and the lap', () => {
    const c = course([skip3], [10]);
    const race = new Race(L.gates);
    const missed: number[][] = [];
    let lap: LapResult | null = null;
    race.onMiss = (g) => missed.push(g);
    race.onLap = (r) => (lap = r);
    run(race, c);
    expect(missed).toEqual([[3]]);
    const r = lap!;
    const raw = c.centres[N - 1].t - c.centres[0].t;
    expect(r.valid).toBe(true);
    expect(r.missed).toBe(1);
    expect(r.penalty).toBe(MISS_PENALTY_S);
    expect(r.raw).toBeCloseTo(raw, 6);
    expect(r.time).toBeCloseTo(raw + MISS_PENALTY_S, 6);
    expect(Number.isNaN(r.splits[2])).toBe(true); // gate 4 (index 3) has no split
    expect(r.splits[3]).toBeCloseTo(c.centres[3].t - c.centres[0].t + MISS_PENALTY_S, 6); // gate 5 carries the penalty
    expect(r.best).toBe(true);
  });

  it('dnf: a lap with a missed gate does not count (no best lap, no ghost)', () => {
    const race = new Race(L.gates);
    race.rule = 'dnf';
    const laps: LapResult[] = [];
    race.onLap = (r) => laps.push(r);
    run(race, course([skip3, ORDER], [10, 10]));
    expect(laps.length).toBe(2);
    expect(laps[0].valid).toBe(false);
    expect(laps[0].best).toBe(false);
    expect(laps[0].ghost).toBeNull();
    expect(Number.isNaN(laps[0].time)).toBe(true);
    // the next clean lap counts and becomes the best
    expect(laps[1].valid && laps[1].best).toBe(true);
    expect(laps[1].ghost).not.toBeNull();
    expect(race.best).toBeCloseTo(laps[1].time, 9);
  });

  it('gates far ahead or behind do not count (no huge cuts, no backwards finish)', () => {
    const fly = (race: Race, gi: number, t0: number) => {
      const g = L.gates[gi], c = new THREE.Vector3(...g.c), f = new THREE.Vector3(...g.forward).normalize();
      for (let k = -10; k <= 10; k++) race.update(t0 + k * 0.02, c.clone().addScaledVector(f, k * 0.2));
    };
    const race = new Race(L.gates);
    const missed: number[][] = [];
    race.onMiss = (g) => missed.push(g);
    fly(race, 0, 1);
    expect(race.next).toBe(1);
    fly(race, 1 + race.maxSkip + 1, 2); // gate 7: would skip 6 gates
    expect(race.next).toBe(1);
    fly(race, 0, 3); // back through the start gate
    expect(race.next).toBe(1);
    expect(race.laps).toBe(0);
    fly(race, 1 + race.maxSkip, 4); // gate 6: skips 1…5 (= maxSkip) — counted as a cut
    expect(race.next).toBe(race.maxSkip + 2);
    expect(missed).toEqual([[1, 2, 3, 4, 5]]);
    expect(race.penalty).toBe(5 * MISS_PENALTY_S);
  });

  it('reset clears the lap, the penalty and the recording', () => {
    const race = new Race(L.gates);
    run(race, course([skip3.slice(0, 6)], [10], false));
    expect(race.missed).toBe(1);
    expect(race.recorder.recording).toBe(true);
    race.reset();
    expect(race.next).toBe(0);
    expect(race.lapStart).toBe(-1);
    expect(race.missed + race.penalty).toBe(0);
    expect(race.recorder.recording).toBe(false);
  });
});
