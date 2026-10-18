// UI state shared by the menus (Preact) and the flight (main thread game loop): which screen is shown, the
// flight overlay phase, and the callbacks the flight registers (restart, exit, live settings).
import { signal } from '@preact/signals';
import type { DronePreset } from '../../sim/presets';
import type { RateProfile } from '../../sim/rates';
import type { LessonResult } from '../../game/academy/runner';

export type Screen = 'main' | 'play' | 'maps' | 'drones' | 'hangar' | 'academy' | 'settings' | 'credits' | 'flight';

export type FlightPhase = 'loading' | 'ready' | 'running' | 'paused' | 'result';
export interface FlightUi {
  phase: FlightPhase;
  /** loading step text */
  status: string;
  title: string; sub: string;
  /** pause sub-pages */
  page: 'menu' | 'settings' | 'help';
  /** flying a GPS drone / plane (help text, pause buttons) */
  kind: 'fpv' | 'gps' | 'plane';
  /** kamikaze preset: the drone carries a charge (detonate control in the help) */
  warhead?: boolean;
}

/** What the flight lets the menus do while it runs (set by game/flight.ts). */
export interface FlightHooks {
  start(): void;
  restart(): void;
  /** reloads the page into the main menu */
  exit(): void;
  /** touch: open the stick layout editor */
  editLayout?(): void;
  applyRates(droneId: string, r: RateProfile | null): void;
  setUptilt(deg: number): void;
  setSound(volume: number, muted: boolean): void;
  /** academy: start the lesson over / open the next one */
  retry?(): void;
  next?(): void;
}

/** free flight, the gate race (time trial with splits and the ghost), or an academy lesson */
export type PlayMode = 'free' | 'race';
export interface LaunchConfig { map: string; drone: string; lesson?: string; mode?: PlayMode }

/** Academy lesson shown over the flight (game/flight.ts keeps it current). */
export interface LessonUi {
  id: string; title: string; brief: string;
  /** star criteria for the briefing: label, ★★ and ★★★ thresholds */
  goals: { label: string; two: string; three: string }[];
  step: number; total: number; text: string; sub: string; progress: number;
  stick?: 'left' | 'right' | 'both';
  result: LessonResult | null;
  /** previous best stars, next lesson id */
  best: number; next?: string;
}

export const ui = {
  screen: signal<Screen>('main'),
  presets: signal<DronePreset[]>([]),
  flight: signal<FlightUi>({ phase: 'loading', status: 'Загрузка…', title: '', sub: '', page: 'menu', kind: 'fpv' }),
  lesson: signal<LessonUi | null>(null),
  /** mode picked on the play screen (the map / drone screens launch it) */
  playMode: signal<PlayMode>('free'),
  hooks: null as FlightHooks | null,
  /** set by main.ts: start a flight with the chosen map / drone */
  launch: null as ((c: LaunchConfig) => void) | null,
  touch: false,
};

const history: Screen[] = [];
export function go(s: Screen) { if (ui.screen.value !== s) { history.push(ui.screen.value); ui.screen.value = s; } }
export function back() {
  const f = ui.flight.value;
  if (ui.screen.value === 'flight') { if (f.page !== 'menu') setFlight({ page: 'menu' }); return; }
  ui.screen.value = history.pop() ?? 'main';
}
export function setFlight(p: Partial<FlightUi>) { ui.flight.value = { ...ui.flight.value, ...p }; }

export const ASSETS = './assets/';
