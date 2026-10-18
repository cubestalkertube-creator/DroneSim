import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DronePreset } from '../src/sim/presets';
import type { MapLayout } from '../src/sim/layout';

export const ASSETS = resolve(__dirname, '../../assets');
export function preset(id: string): DronePreset {
  const all = JSON.parse(readFileSync(resolve(ASSETS, 'presets/drones.json'), 'utf-8')).drones as DronePreset[];
  const p = all.find((d) => d.id === id);
  if (!p) throw new Error('no preset ' + id);
  return p;
}
export function layout(id: string): MapLayout {
  return JSON.parse(readFileSync(resolve(ASSETS, `maps/${id}/${id}.json`), 'utf-8'));
}
