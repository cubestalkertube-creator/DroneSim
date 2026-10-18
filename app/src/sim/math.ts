// Minimal allocation-free vector/quaternion helpers for the simulation core (no three.js here).
// Plain {x,y,z} / {x,y,z,w} objects are also accepted by Rapier's API.

export interface V3 { x: number; y: number; z: number }
export interface Q4 { x: number; y: number; z: number; w: number }

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const q4 = (x = 0, y = 0, z = 0, w = 1): Q4 => ({ x, y, z, w });

export function set(o: V3, x: number, y: number, z: number): V3 { o.x = x; o.y = y; o.z = z; return o; }
export function copy(o: V3, a: V3): V3 { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export function add(o: V3, a: V3, b: V3): V3 { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; }
export function sub(o: V3, a: V3, b: V3): V3 { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; }
export function scale(o: V3, a: V3, s: number): V3 { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
export function addScaled(o: V3, a: V3, s: number): V3 { o.x += a.x * s; o.y += a.y * s; o.z += a.z * s; return o; }
export const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
export function cross(o: V3, a: V3, b: V3): V3 {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z; return o;
}

/** o = q * v (rotate body vector into world). */
export function rotate(o: V3, q: Q4, v: V3): V3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  o.x = v.x + w * tx + (y * tz - z * ty);
  o.y = v.y + w * ty + (z * tx - x * tz);
  o.z = v.z + w * tz + (x * ty - y * tx);
  return o;
}

/** o = conj(q) * v (rotate world vector into body). */
export function rotateInv(o: V3, q: Q4, v: V3): V3 {
  const x = -q.x, y = -q.y, z = -q.z, w = q.w;
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  o.x = v.x + w * tx + (y * tz - z * ty);
  o.y = v.y + w * ty + (z * tx - x * tz);
  o.z = v.z + w * tz + (x * ty - y * tx);
  return o;
}

export function quatFromAxisAngle(o: Q4, ax: number, ay: number, az: number, angle: number): Q4 {
  const s = Math.sin(angle / 2);
  o.x = ax * s; o.y = ay * s; o.z = az * s; o.w = Math.cos(angle / 2);
  return o;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const DEG = Math.PI / 180;

/** First-order low-pass (PT1) coefficient for cutoff fc at step dt. */
export const pt1k = (fc: number, dt: number) => { const rc = 1 / (2 * Math.PI * fc); return dt / (rc + dt); };

/** o = a * b (Hamilton product; apply b first, then a). */
export function qmul(o: Q4, a: Q4, b: Q4): Q4 {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w; return o;
}
