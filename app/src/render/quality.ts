// Graphics/physics quality profiles (PLAN.md 11). Low = phones: 1k textures, one 1024 shadow map, no MSAA,
// 0.75x render scale, 500 Hz physics. Choice: ?q=low|medium|high > saved setting > auto (touch device -> low).
import { isTouch } from '../platform/platform';

export type QualityId = 'low' | 'medium' | 'high';

export interface Quality {
  id: QualityId;
  /** device-pixel-ratio cap and render scale on top of it */
  maxDpr: number; renderScale: number;
  antialias: boolean;
  shadowMap: number; softShadows: boolean;
  tex: '1k' | '2k';
  /** physics rate (Hz); 1000 is the reference, 500 keeps phones real-time */
  simHz: number;
  /** load decorative props (Poly Haven models) */
  props: boolean;
}

/** the mobile (Capacitor) build ships only 1k textures */
export const MOBILE_BUILD = import.meta.env.VITE_MOBILE === '1';

const PROFILES: Record<QualityId, Omit<Quality, 'id'>> = {
  low: { maxDpr: 1.5, renderScale: 0.75, antialias: false, shadowMap: 1024, softShadows: false, tex: '1k', simHz: 500, props: true },
  medium: { maxDpr: 1.5, renderScale: 1, antialias: true, shadowMap: 2048, softShadows: false, tex: '2k', simHz: 1000, props: true },
  high: { maxDpr: 2, renderScale: 1, antialias: true, shadowMap: 2048, softShadows: true, tex: '2k', simHz: 1000, props: true },
};

const KEY = 'ds.quality';

export function pickQuality(): Quality {
  const q = new URLSearchParams(location.search).get('q');
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  const id = ([q, saved].find((x) => x && x in PROFILES) as QualityId | undefined) ?? (isTouch ? 'low' : 'high');
  const p = { id, ...PROFILES[id] };
  if (MOBILE_BUILD) p.tex = '1k';
  return p;
}

export function saveQuality(id: QualityId) { try { localStorage.setItem(KEY, id); } catch { /* ignore */ } }
