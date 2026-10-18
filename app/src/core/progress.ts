// Pilot progress (PLAN.md 8.1): academy stars and best results per lesson, best laps (+ their ghosts) per map/drone.
// localStorage JSON, separate from the settings so "reset settings" never wipes progress.
import { signal } from '@preact/signals';
import { decodeGhost, encodeGhost, type GhostData } from '../game/race';

export interface LessonResult { stars: number; best: number }
export interface Progress { v: 1; lessons: Record<string, LessonResult>; laps: Record<string, number> }

const KEY = 'ds.progress';
const EMPTY: Progress = { v: 1, lessons: {}, laps: {} };

function load(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (p && p.v === 1) return { v: 1, lessons: p.lessons ?? {}, laps: p.laps ?? {} };
  } catch { /* corrupted / blocked */ }
  return structuredClone(EMPTY);
}

export const progress = signal<Progress>(typeof localStorage === 'undefined' ? structuredClone(EMPTY) : load());

export function updateProgress(fn: (p: Progress) => void) {
  const next = structuredClone(progress.value);
  fn(next);
  progress.value = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

/** Best lap (s) for a map + drone, Infinity if none. */
export const bestLap = (map: string, drone: string) => progress.value.laps[`${map}/${drone}`] ?? Infinity;
export function recordLap(map: string, drone: string, t: number): boolean {
  if (t >= bestLap(map, drone)) return false;
  updateProgress((p) => { p.laps[`${map}/${drone}`] = t; });
  return true;
}

// Ghost of the best lap per map + drone (game/race.ts): its own localStorage key per pair (tens of KB each), so the
// progress document stays small and cloning it on every update stays cheap.
const ghostKey = (map: string, drone: string) => `ds.ghost.${map}/${drone}`;
export function loadGhost(map: string, drone: string): GhostData | null {
  try { return decodeGhost(JSON.parse(localStorage.getItem(ghostKey(map, drone)) ?? 'null')); } catch { return null; }
}
export function saveGhost(map: string, drone: string, g: GhostData): boolean {
  try { localStorage.setItem(ghostKey(map, drone), JSON.stringify(encodeGhost(g))); return true; } catch { return false; }
}
export function hasGhost(map: string, drone: string): boolean {
  try { return localStorage.getItem(ghostKey(map, drone)) !== null; } catch { return false; }
}
