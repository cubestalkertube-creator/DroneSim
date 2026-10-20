// The world beyond the map square: terrain that continues the map edge into hills and a far range (shape from
// sim/outer.ts, the same the physics collides with), plus what stands on it - a forest, a city of panel blocks or
// an industrial outskirt - so the map never ends in an empty plane. Everything is generated from a fixed seed.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapLayout } from '../sim/layout';
import { fbm, outerHeight, outerSpec, outsideDist, type OuterSpec } from '../sim/outer';
import type { RenderWorld } from './world';
import { groundVariation } from './groundShader';

type Kind = 'forest' | 'city' | 'industrial';
interface Look {
  kind: Kind;
  /** PBR set of the outer ground and its tile (m) */
  ground: string; tile: number;
  /** macro tints multiplied over the ground texture (sRGB hex): base, patches, dry */
  tints: [number, number, number];
  rock: number; snow?: number;
  /** tree count multiplier, tree colour */
  trees: number; leaves?: number;
  ruined?: boolean;
  /** fog density for the render (the map's own value is tuned for the old plane backdrop) */
  fog?: number;
  /** the map's own ground texture that turns into the outer ground towards the map edge (m from the centre) */
  overgrow?: { tex: string; from: number; to: number };
  /** colour the map's own natural ground is multiplied with (sRGB hex) */
  groundTint?: number;
}

const LOOK: Record<string, Look> = {
  training_field: { kind: 'forest', ground: 'acg_grass001', tile: 4, tints: [0xffffff, 0xd6e0a8, 0xa9b986], rock: 0x8f8a80, snow: 0xeef1f4, trees: 1, fog: 0.00045 },
  abandoned_factory: { kind: 'industrial', ground: 'acg_grass004', tile: 4, tints: [0xe6d6a8, 0xc8bc90, 0xa8a07c], rock: 0x9a8a74, trees: 0.55, leaves: 0x3b4a26, fog: 0.0017, overgrow: { tex: 'gravel_concrete_03', from: 150, to: 215 } },
  ruined_district: { kind: 'city', ground: 'acg_grass004', tile: 4, tints: [0xd8d8c0, 0xbfc2a6, 0xa3a68e], rock: 0x8c8a84, trees: 0.45, ruined: true, fog: 0.0014, groundTint: 0xd8cf9e },
  parking_garage: { kind: 'city', ground: 'acg_grass004', tile: 4, tints: [0xffffff, 0xd8e0b8, 0xb7c29a], rock: 0x8c8a84, trees: 0.55, fog: 0.0011 },
};

function lookFor(L: MapLayout): Look {
  const known = LOOK[L.id];
  if (known) return known;
  const grass = Object.values(L.materials).map((m) => m.tex).find((t) => t && /grass/i.test(t));
  return { kind: 'forest', ground: grass ?? 'acg_grass004', tile: 4, tints: [0xffffff, 0xd6e0a8, 0xa9b986], rock: 0x8f8a80, trees: 0.8 };
}

/** small deterministic PRNG (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** map ground material blended into the outer ground near the map edge */
export function overgrowFor(L: MapLayout) { const l = lookFor(L); return l.overgrow ? { ...l.overgrow, ground: l.ground, tile: l.tile } : null; }

/** tint of the map's own grass / dirt (null: as authored) */
export function groundTintFor(L: MapLayout): number | null { return lookFor(L).groundTint ?? null; }

/** fog density the renderer uses on this map */
export function fogDensity(L: MapLayout): number { return lookFor(L).fog ?? Math.min(L.env.fog.density, 0.002); }

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** static box collider in game space (centre, half extents, rotation) for the physics */
export interface OuterBox { c: { x: number; y: number; z: number }; h: { x: number; y: number; z: number }; q: { x: number; y: number; z: number; w: number } }
export interface SurroundingsOpts { low: boolean; boxes: OuterBox[] }
const yawQ = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
/** trees and buildings this close to the map collide (further out nobody flies at ground level) */
const COLLIDE_D = 700;

export function buildSurroundings(rw: RenderWorld, L: MapLayout, opts: SurroundingsOpts): THREE.Group {
  const g = new THREE.Group();
  g.name = 'surroundings';
  const spec = outerSpec(L), look = lookFor(L);
  g.add(terrainMesh(rw, spec, look, opts));
  const r = rng(spec.seed * 7919 + 1);
  if (look.kind === 'city') g.add(city(spec, look, r, opts), roads(rw, spec, opts));
  if (look.kind === 'industrial') g.add(industry(spec, r, opts));
  const trees = forest(spec, look, r, opts);
  if (trees) g.add(trees);
  return g;
}

// ---------------------------------------------------------------- terrain

/** Polar ring mesh from the map square's border out to 8 km: dense near the map, coarse far away. */
function terrainMesh(rw: RenderWorld, s: OuterSpec, look: Look, { low }: SurroundingsOpts): THREE.Mesh {
  const A = low ? 160 : 256, R = low ? 96 : 140, far = 8000, first = 5;
  const ratio = Math.pow(far / first, 1 / (R - 3));
  const off: number[] = [-3, 0];
  for (let k = 2; k < R; k++) off.push(first * Math.pow(ratio, k - 2));
  const n = R * A;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  const tint = look.tints.map((h) => new THREE.Color(h)), rock = new THREE.Color(look.rock), snow = look.snow != null ? new THREE.Color(look.snow) : null;
  const c = new THREE.Color();
  for (let k = 0; k < R; k++) {
    for (let a = 0; a < A; a++) {
      const th = (a / A) * Math.PI * 2, dx = Math.cos(th), dz = Math.sin(th);
      const b = s.half / Math.max(Math.abs(dx), Math.abs(dz)); // border of the square along this direction
      const x = dx * (b + off[k]), z = dz * (b + off[k]);
      const y = k === 0 ? s.edge(dx * b, dz * b) - 2 : outerHeight(s, x, z);
      const i = k * A + a;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      uv[i * 2] = x / look.tile; uv[i * 2 + 1] = z / look.tile;
      // macro colour: two noise layers over the tints, rock and snow with altitude on the far range
      const n1 = fbm(x / 380, z / 380, 3, s.seed + 3) * 0.5 + 0.5, n2 = fbm(x / 70, z / 70, 2, s.seed + 9) * 0.5 + 0.5;
      c.copy(tint[0]).lerp(tint[1], smooth(0.35, 0.75, n1)).lerp(tint[2], smooth(0.55, 0.9, n2) * 0.6);
      const alt = y - s.base;
      if (s.mountains > 0) {
        c.lerp(rock, smooth(0.28, 0.55, alt / s.mountains));
        if (snow) c.lerp(snow, smooth(0.62, 0.8, alt / s.mountains));
      }
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
  }
  const idx: number[] = [];
  for (let k = 0; k < R - 1; k++) {
    for (let a = 0; a < A; a++) {
      const a1 = (a + 1) % A, p = k * A + a, q = k * A + a1, p2 = (k + 1) * A + a, q2 = (k + 1) * A + a1;
      idx.push(p, q, p2, q, q2, p2); // counter-clockwise seen from above
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = rw.pbrMaterial(look.ground).clone();
  mat.vertexColors = true;
  mat.name = 'M_outer_ground';
  groundVariation(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'outer_terrain';
  return mesh;
}

// ---------------------------------------------------------------- trees

/** low-poly pine like the map's own (tools/blender/map_builder.py tree()): trunk + 3 cones, unit height */
function pineGeometry(leaves: THREE.Color): THREE.BufferGeometry {
  const bark = new THREE.Color(0.2, 0.13, 0.08);
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.025, 0.03, 0.4, 5, 1, true);
  trunk.translate(0, 0.2, 0);
  parts.push(paint(trunk, bark));
  for (let k = 0; k < 3; k++) {
    const r = 0.24 - 0.06 * k, z = 0.3 + 0.22 * k;
    const cone = new THREE.ConeGeometry(r, 0.32, 7, 1, false);
    cone.translate(0, z + 0.16, 0);
    // a little darker inside the crown, lighter on top
    parts.push(paint(cone, leaves.clone().multiplyScalar(0.85 + 0.12 * k)));
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  return g;
}

function forest(s: OuterSpec, look: Look, r: () => number, { low, boxes }: SurroundingsOpts): THREE.InstancedMesh | null {
  const count = Math.round((low ? 2600 : 9000) * look.trees);
  if (count <= 0) return null;
  const leaves = look.leaves != null ? new THREE.Color(look.leaves) : new THREE.Color(0.07, 0.16, 0.06); // map_builder pine_needles
  const geo = pineGeometry(leaves);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, name: 'M_outer_pine' });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'outer_forest';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  const city = look.kind === 'city';
  const dMin = city ? 20 : 8, dMax = city ? 2600 : 2200;
  let i = 0;
  for (let tries = 0; i < count && tries < count * 25; tries++) {
    const th = r() * Math.PI * 2, dx = Math.cos(th), dz = Math.sin(th);
    const b = s.half / Math.max(Math.abs(dx), Math.abs(dz));
    const d = dMin + (dMax - dMin) * Math.pow(r(), 1.7);
    const x = dx * (b + d), z = dz * (b + d);
    const od = outsideDist(s, x, z);
    if (od < dMin) continue;
    // clusters (forest patches); a dense tree line right behind the map edge hides the border
    const mask = fbm(x / 240, z / 240, 3, s.seed + 5);
    const near = od < 120 && !city ? 0.85 : 0;
    const keep = Math.max(near, smooth(city ? 0.25 : -0.05, city ? 0.45 : 0.25, mask));
    if (r() > keep) continue;
    if (city && cityDensity(s, x, z) > 0.15) continue; // trees in the city's outskirts and parks only
    const y = outerHeight(s, x, z);
    if (s.mountains > 0 && (y - s.base) / s.mountains > 0.42) continue; // tree line on the far range
    const h = (8 + r() * 9) * (od > 900 ? 1.35 : 1);
    p.set(x, y - 0.3, z);
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    sc.set(h * (0.85 + r() * 0.3), h, h * (0.85 + r() * 0.3));
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    // trunk + lower crown as one box (the map's own trees collide with trunk and bottom cone too)
    if (od < COLLIDE_D) boxes.push({ c: { x, y: y + h * 0.4, z }, h: { x: h * 0.13, y: h * 0.4, z: h * 0.13 }, q: { x: q.x, y: q.y, z: q.z, w: q.w } });
    const v = 0.75 + r() * 0.5;
    mesh.setColorAt(i, c.setRGB(v * (0.92 + r() * 0.16), v, v * (0.85 + r() * 0.2)));
    i++;
  }
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------- buildings

/** how built-up the city is at (x, z): full near the map, thinning out into the countryside */
function cityDensity(s: OuterSpec, x: number, z: number): number {
  const d = outsideDist(s, x, z);
  return (1 - smooth(500, 1700, d)) * (0.7 + 0.3 * (fbm(x / 600, z / 600, 2, s.seed + 77) * 0.5 + 0.5));
}

/** facade texture: a grid of windows (8 × 8 cells), some lit / curtained / dark */
function facadeTexture(kind: 'panel' | 'industrial', seed: number, ruined: boolean): THREE.CanvasTexture {
  const S = 512, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  const r = rng(seed);
  x.fillStyle = '#d9d4ca';
  x.fillRect(0, 0, S, S);
  // panel seams / grime
  for (let i = 0; i < 900; i++) {
    x.fillStyle = `rgba(60,55,50,${0.03 + r() * 0.05})`;
    x.fillRect(r() * S, r() * S, 2 + r() * 30, 2 + r() * 30);
  }
  const N = 8, cell = S / N;
  if (kind === 'industrial') {
    // corrugated cladding: vertical ribs, a band of high windows
    for (let i = 0; i < S; i += 8) { x.fillStyle = i % 16 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.08)'; x.fillRect(i, 0, 4, S); }
    for (let c = 0; c < N; c++) {
      x.fillStyle = r() < 0.2 ? '#2b2f33' : '#5d6b75';
      x.fillRect(c * cell + 8, 10, cell - 16, cell * 0.35);
    }
  } else {
    for (let row = 0; row < N; row++) {
      x.fillStyle = 'rgba(0,0,0,.18)';
      x.fillRect(0, row * cell + cell - 3, S, 3); // floor slab seam
      for (let c = 0; c < N; c++) {
        const wx = c * cell + cell * 0.2, wy = row * cell + cell * 0.22, ww = cell * 0.6, wh = cell * 0.5;
        const v = r();
        x.fillStyle = ruined && v < 0.35 ? '#141210' : v < 0.08 ? '#d9b46a' : v < 0.3 ? '#8a8f8e' : v < 0.6 ? '#4f6070' : '#36414b';
        x.fillRect(wx, wy, ww, wh);
        x.fillStyle = 'rgba(255,255,255,.18)';
        x.fillRect(wx, wy, ww, 3); // frame / sill light
        x.fillRect(wx + ww / 2 - 1, wy, 2, wh);
        if (ruined && v < 0.2) { x.fillStyle = 'rgba(20,18,15,.45)'; x.fillRect(wx - 6, wy - 14, ww + 12, 16); } // soot
      }
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** merged box buildings: walls with facade UVs in metres (one texture repeat = 8 floors × 8 windows), flat roofs */
class Blocks {
  private walls = { pos: [] as number[], uv: [] as number[], col: [] as number[] };
  private roofs = { pos: [] as number[], col: [] as number[] };
  constructor(private cellW: number, private cellH: number, private boxes: OuterBox[], private s: OuterSpec) {}

  /** box: centre (x, z), base y, size (w along local x, d along local z), height, yaw, tint */
  box(x: number, z: number, y: number, w: number, d: number, h: number, yaw: number, tint: THREE.Color) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    // P() turns by -yaw about +Y in three's convention
    if (outsideDist(this.s, x, z) < COLLIDE_D) this.boxes.push({ c: { x, y: y + h / 2, z }, h: { x: w / 2, y: h / 2, z: d / 2 }, q: yawQ(-yaw) });
    const P = (lx: number, lz: number): [number, number] => [x + lx * cs - lz * sn, z + lx * sn + lz * cs];
    // corners in the order that makes the walls face outwards (and the roof up)
    const c = [P(-w / 2, -d / 2), P(-w / 2, d / 2), P(w / 2, d / 2), P(w / 2, -d / 2)];
    const len = [d, w, d, w];
    const W = this.walls;
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      const u1 = len[k] / this.cellW, v1 = h / this.cellH;
      const quad = [[a, 0, 0, 0], [b, 0, u1, 0], [b, h, u1, v1], [a, 0, 0, 0], [b, h, u1, v1], [a, h, 0, v1]] as const;
      for (const [p, yy, u, v] of quad) {
        W.pos.push(p[0], y + yy, p[1]); W.uv.push(u, v); W.col.push(tint.r, tint.g, tint.b);
      }
    }
    const R = this.roofs, top = y + h;
    for (const k of [0, 1, 2, 0, 2, 3]) { R.pos.push(c[k][0], top, c[k][1]); R.col.push(tint.r * 0.55, tint.g * 0.55, tint.b * 0.55); }
  }

  build(facade: THREE.Texture, name: string): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    const W = this.walls, R = this.roofs;
    const nW = W.pos.length / 3, nR = R.pos.length / 3;
    const pos = new Float32Array([...W.pos, ...R.pos]);
    const uv = new Float32Array(nW * 2 + nR * 2); uv.set(W.uv);
    const col = new Float32Array([...W.col, ...R.col]);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.addGroup(0, nW, 0); g.addGroup(nW, nR, 1);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const wall = new THREE.MeshStandardMaterial({ map: facade, vertexColors: true, roughness: 0.88, metalness: 0, name: `M_${name}_wall` });
    const roof = new THREE.MeshStandardMaterial({ color: 0x8a8c8e, vertexColors: true, roughness: 0.95, metalness: 0, name: `M_${name}_roof` });
    const mesh = new THREE.Mesh(g, [wall, roof]);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = name;
    return mesh;
  }
}

/** base of a footprint on the outer land: the lowest corner, sunk a little */
function baseY(s: OuterSpec, x: number, z: number, rad: number) {
  return Math.min(outerHeight(s, x - rad, z - rad), outerHeight(s, x + rad, z - rad), outerHeight(s, x - rad, z + rad), outerHeight(s, x + rad, z + rad)) - 0.8;
}

const BLOCK = 96, ROAD_W = 11;
const cityExt = (low: boolean) => (low ? 19 : 25) * BLOCK; // whole blocks: streets run between the block centres

/** asphalt streets between the outer city blocks, draped over the land in 24 m pieces */
function roads(rw: RenderWorld, s: OuterSpec, { low }: SurroundingsOpts): THREE.Mesh {
  const ext = cityExt(low), seg = 24, tile = 6, hw = ROAD_W / 2;
  const pos: number[] = [], uv: number[] = [];
  const put = (x: number, z: number) => { pos.push(x, outerHeight(s, x, z) + 0.12, z); uv.push(x / tile, z / tile); };
  for (const axis of [0, 1]) {
    for (let l = -ext - BLOCK / 2; l <= ext + BLOCK / 2; l += BLOCK) {
      for (let t = -ext; t < ext; t += seg) {
        const mx = axis ? t + seg / 2 : l, mz = axis ? l : t + seg / 2;
        if (outsideDist(s, mx, mz) < 25 || cityDensity(s, mx, mz) < 0.3) continue;
        const P = (a: number, w: number) => (axis ? put(a, l + w) : put(l + w, a));
        // two triangles facing up
        if (axis) { P(t, -hw); P(t, hw); P(t + seg, hw); P(t, -hw); P(t + seg, hw); P(t + seg, -hw); }
        else { P(t, -hw); P(t + seg, -hw); P(t + seg, hw); P(t, -hw); P(t + seg, hw); P(t, hw); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mat = rw.pbrMaterial('asphalt_02').clone();
  mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4;
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true; mesh.name = 'outer_roads';
  return mesh;
}

const PANEL_TINTS = [0xe8e2d6, 0xd8d6d0, 0xe6dcc0, 0xcfd3d6, 0xdcc8b0, 0xc9b9a4].map((h) => new THREE.Color(h));

function city(s: OuterSpec, look: Look, r: () => number, opts: SurroundingsOpts): THREE.Mesh {
  const low = opts.low;
  const B = new Blocks(3.2 * 8, 2.9 * 8, opts.boxes, s);
  const block = BLOCK, ext = cityExt(low);
  for (let gx = -ext; gx <= ext; gx += block) {
    for (let gz = -ext; gz <= ext; gz += block) {
      const cx = gx + (r() - 0.5) * 10, cz = gz + (r() - 0.5) * 10;
      if (outsideDist(s, cx, cz) < 40 + block * 0.5) continue;
      if (r() > cityDensity(s, cx, cz)) continue;
      const yaw = (Math.floor(r() * 2) * Math.PI) / 2 + (r() - 0.5) * 0.08;
      const kind = r();
      const tint = PANEL_TINTS[Math.floor(r() * PANEL_TINTS.length)].clone().multiplyScalar(look.ruined ? 0.82 : 1);
      if (kind < 0.55) {
        // two parallel panel slabs (5-12 floors) with a yard between
        for (const side of [-1, 1]) {
          const floors = 5 + Math.floor(r() * (r() < 0.4 ? 12 : 5));
          const w = 50 + r() * 26, d = 12 + r() * 2, h = floors * 2.9;
          const ox = 0, oz = side * 24;
          const px = cx + ox * Math.cos(yaw) - oz * Math.sin(yaw), pz = cz + ox * Math.sin(yaw) + oz * Math.cos(yaw);
          const y = baseY(s, px, pz, w / 2);
          if (look.ruined && r() < 0.3) {
            // half-collapsed: a lower section and a broken stump
            B.box(px - Math.cos(yaw) * w * 0.2, pz - Math.sin(yaw) * w * 0.2, y, w * 0.6, d, h, yaw, tint);
            B.box(px + Math.cos(yaw) * w * 0.3, pz + Math.sin(yaw) * w * 0.3, y, w * 0.4, d, h * (0.25 + r() * 0.3), yaw, tint);
          } else B.box(px, pz, y, w, d, h, yaw, tint);
        }
      } else if (kind < 0.8) {
        // tower block
        const floors = 9 + Math.floor(r() * 14), w = 18 + r() * 6, h = floors * 2.9;
        B.box(cx, cz, baseY(s, cx, cz, w / 2), w, w, look.ruined && r() < 0.25 ? h * 0.55 : h, yaw, tint);
      } else {
        // low shops / garages
        for (let k = 0; k < 3; k++) {
          const w = 16 + r() * 22, d = 12 + r() * 10, h = 3.2 + r() * 5;
          const px = cx + (r() - 0.5) * 50, pz = cz + (r() - 0.5) * 50;
          B.box(px, pz, baseY(s, px, pz, w / 2), w, d, h, yaw, tint.clone().multiplyScalar(0.92));
        }
      }
    }
  }
  return B.build(facadeTexture('panel', s.seed, !!look.ruined), 'outer_city');
}

function industry(s: OuterSpec, r: () => number, opts: SurroundingsOpts): THREE.Group {
  const low = opts.low;
  const g = new THREE.Group();
  const B = new Blocks(6 * 8, 7 * 8, opts.boxes, s);
  const n = low ? 40 : 70;
  const tints = [0xb9b2a4, 0x9fa6a8, 0xa89a86, 0x8e8a80].map((h) => new THREE.Color(h));
  const chim: { x: number; z: number; y: number; h: number; r: number }[] = [];
  const tanks: { x: number; z: number; y: number; h: number; r: number }[] = [];
  for (let i = 0, tries = 0; i < n && tries < n * 30; tries++) {
    const th = r() * Math.PI * 2, dx = Math.cos(th), dz = Math.sin(th);
    const b = s.half / Math.max(Math.abs(dx), Math.abs(dz));
    const d = 45 + Math.pow(r(), 1.4) * 1400;
    const x = dx * (b + d), z = dz * (b + d);
    if (fbm(x / 500, z / 500, 2, s.seed + 13) < -0.05) continue; // industrial zones, fields between
    const w = 30 + r() * 70, dd = 20 + r() * 40, h = 8 + r() * 12, yaw = (Math.floor(r() * 4) * Math.PI) / 2 + (r() - 0.5) * 0.3;
    B.box(x, z, baseY(s, x, z, w / 2), w, dd, h, yaw, tints[Math.floor(r() * tints.length)]);
    if (r() < 0.18) chim.push({ x: x + w * 0.6, z, y: baseY(s, x + w * 0.6, z, 3), h: 40 + r() * 40, r: 1.8 + r() * 1.5 });
    if (r() < 0.25) for (let k = 0; k < 2 + Math.floor(r() * 3); k++) tanks.push({ x: x - w * 0.7 - k * 20, z: z + dd, y: baseY(s, x - w * 0.7 - k * 20, z + dd, 8), h: 10 + r() * 6, r: 7 + r() * 3 });
    i++;
  }
  g.add(B.build(facadeTexture('industrial', s.seed + 1, false), 'outer_industry'));
  const cyl = (list: typeof chim, color: number, top: number, name: string) => {
    if (!list.length) return;
    const geo = new THREE.CylinderGeometry(top, 1, 1, 14, 1, false);
    geo.translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.1 }), list.length);
    const m = new THREE.Matrix4();
    list.forEach((c, i) => {
      mesh.setMatrixAt(i, m.compose(new THREE.Vector3(c.x, c.y, c.z), new THREE.Quaternion(), new THREE.Vector3(c.r, c.h, c.r)));
      if (outsideDist(s, c.x, c.z) < COLLIDE_D) opts.boxes.push({ c: { x: c.x, y: c.y + c.h / 2, z: c.z }, h: { x: c.r * 0.85, y: c.h / 2, z: c.r * 0.85 }, q: yawQ(0) });
    });
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = name;
    mesh.computeBoundingSphere();
    g.add(mesh);
  };
  cyl(chim, 0x8a6a58, 0.75, 'outer_chimneys');
  cyl(tanks, 0xb8b4aa, 1, 'outer_tanks');
  return g;
}
