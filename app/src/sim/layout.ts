// Types of assets/maps/<id>/<id>.json produced by tools/blender/map_builder.py (game space: +Y up, -Z forward).
export type Vec3T = [number, number, number];
export type QuatT = [number, number, number, number]; // x y z w

export interface BoxCollider { type: 'box'; c: Vec3T; half: Vec3T; q: QuatT }
export interface CylCollider { type: 'cylinder'; c: Vec3T; r: number; h: number; q: QuatT }
export interface Heightfield {
  type: 'heightfield'; size: number; res: number;
  /** heights[j*(res+1)+i] at game x = -size/2 + size*i/res, game z = +size/2 - size*j/res */
  heights_rowmajor_blenderY: number[];
}
export interface Gate { c: Vec3T; q: QuatT; w: number; h: number; forward: Vec3T }
export interface Spawn { pos: Vec3T; q: QuatT; kind: string }
export interface PropInstance { asset: string; pos: Vec3T; q: QuatT; scale: number; collide: string | boolean }
export interface MapMaterial { tex: string | null; tile_m: number | null; color: number[] | null; emissive: number }

export interface MapLayout {
  id: string; title: string; geometry: string;
  env: {
    hdri: string; sun: { dir: Vec3T; intensity: number }; fog: { color: Vec3T; density: number };
    wind?: { mean_ms: number; gust_ms: number; dir_deg: number }; description?: string;
    /** covered map (parking garage, factory hall): reverb on the drone sound */
    indoor_reverb?: boolean;
  };
  spawns: Spawn[]; gates: Gate[]; props: PropInstance[];
  /** trick lines, no-fly boundary, turbulence volumes ({kind: 'turbulence', c, r, gain}) … */
  zones?: { kind: string; [k: string]: unknown }[];
  colliders: (BoxCollider | CylCollider)[];
  terrain: Heightfield | null;
  materials: Record<string, MapMaterial>;
}

/** map ground height at game (x, z): bilinear over the heightfield, clamped to its edge; 0 without terrain */
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
