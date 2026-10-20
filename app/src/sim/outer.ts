// Land around the map (outside its heightfield square): continues the map's edge height, settles to a base level
// and rolls into hills and a far mountain range. Pure and deterministic: the physics builds heightfield colliders
// from it (sim/world.ts) and the renderer the surrounding terrain mesh (render/surroundings.ts) - one shape for both.
import { groundHeight, type MapLayout } from './layout';

export interface OuterSpec {
  /** half size of the map square (m); the outer land starts at its edge */
  half: number;
  /** map edge height at a point of the square's border */
  edge: (x: number, z: number) => number;
  /** level the land settles to beyond the edge berm (m) */
  base: number;
  /** amplitude of the rolling hills (m) and their wavelength (m) */
  hills: number; hillScale: number;
  /** height of the far mountain range (m), the distance it starts to rise (m) and reaches full height */
  mountains: number; mountainFrom: number; mountainTo: number;
  seed: number;
}

/** per map: shape of the surrounding land (visual biome is in render/surroundings.ts) */
const SHAPE: Record<string, Partial<OuterSpec>> = {
  training_field: { base: 3, hills: 14, hillScale: 300, mountains: 340, mountainFrom: 900, mountainTo: 2600, seed: 11 },
  abandoned_factory: { base: 4, hills: 10, hillScale: 260, mountains: 160, mountainFrom: 900, mountainTo: 2400, seed: 23 },
  ruined_district: { base: 1, hills: 5, hillScale: 420, mountains: 120, mountainFrom: 1100, mountainTo: 2800, seed: 37 },
  parking_garage: { base: 0, hills: 3, hillScale: 500, mountains: 140, mountainFrom: 1200, mountainTo: 3000, seed: 41 },
};

export function outerSpec(L: MapLayout): OuterSpec {
  const half = L.terrain ? L.terrain.size / 2 : 200;
  return {
    half, edge: (x, z) => groundHeight(L, x, z), base: 2, hills: 10, hillScale: 300, mountains: 220, mountainFrom: 1000, mountainTo: 2600, seed: 7,
    ...SHAPE[L.id],
  };
}

// --- value noise (hash on the integer lattice, quintic fade), fbm and ridged fbm in [-1, 1] / [0, 1]
function hash(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed), c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
/** fractal noise in about [-1, 1] */
export function fbm(x: number, z: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * (vnoise(x * f, z * f, seed + i * 17) * 2 - 1); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
function ridged(x: number, z: number, oct: number, seed: number): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { const r = 1 - Math.abs(vnoise(x * f, z * f, seed + i * 31) * 2 - 1); s += a * r * r; n += a; a *= 0.5; f *= 2.1; }
  return s / n;
}
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** distance from (x, z) to the map square (0 inside) */
export function outsideDist(s: OuterSpec, x: number, z: number): number {
  const dx = Math.max(0, Math.abs(x) - s.half), dz = Math.max(0, Math.abs(z) - s.half);
  return Math.hypot(dx, dz);
}

/** height of the outer land at (x, z); inside the map square it is the map edge continued (hidden under the map) */
export function outerHeight(s: OuterSpec, x: number, z: number): number {
  const bx = Math.max(-s.half, Math.min(s.half, x)), bz = Math.max(-s.half, Math.min(s.half, z));
  const d = Math.hypot(x - bx, z - bz);
  const e = s.edge(bx, bz);
  if (d <= 0) return e;
  const w = smooth(0, 240, d);
  let h = e + (s.base - e) * w;
  // hills grow in away from the edge so the map border stays clean
  const hw = smooth(20, 420, d);
  h += s.hills * hw * (0.55 * fbm(x / s.hillScale, z / s.hillScale, 4, s.seed) + 0.45);
  // far range: ridged noise, rising with distance
  const mw = smooth(s.mountainFrom, s.mountainTo, d);
  if (mw > 0) {
    const r = ridged(x / 1100, z / 1100, 5, s.seed + 101);
    const m = 0.65 + 0.35 * fbm(x / 2300, z / 2300, 2, s.seed + 202);
    h += s.mountains * mw * r * m;
  }
  return Math.max(h, s.base - 0.5);
}

/** Heightfield grid of the outer land, Rapier layout (column-major, row along +Z, centred on the origin).
 *  Samples inside `holeHalf` are pushed down to `holeY` (the map / a finer grid covers that square). */
export function outerGrid(s: OuterSpec, size: number, res: number, holeHalf: number, holeY: number): Float32Array {
  const n = res + 1, hf = new Float32Array(n * n), eps = 1e-6;
  for (let row = 0; row < n; row++) {
    const z = -size / 2 + (size * row) / res;
    for (let col = 0; col < n; col++) {
      const x = -size / 2 + (size * col) / res;
      hf[row + col * n] = Math.abs(x) < holeHalf - eps && Math.abs(z) < holeHalf - eps ? holeY : outerHeight(s, x, z);
    }
  }
  return hf;
}

/** physics grids: a fine one around the map and a coarse one out to the far range (cells line up with the squares) */
export const OUTER_NEAR = { half: 1200, cell: 10 };
export const OUTER_FAR = { half: 8000, cell: 80 };
