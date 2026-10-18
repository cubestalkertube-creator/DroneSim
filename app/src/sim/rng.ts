// Deterministic randomness for the simulation (PHYSICS.md 0): no Math.random() in physics, only seeded PRNGs.

/** mulberry32: tiny fast 32-bit PRNG, uniform [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples (Box-Muller) from a uniform source; caches the second value. */
export class Gauss {
  private spare = 0; private has = false;
  constructor(private u: () => number) {}
  next(): number {
    if (this.has) { this.has = false; return this.spare; }
    let a = this.u(); if (a < 1e-12) a = 1e-12;
    const r = Math.sqrt(-2 * Math.log(a)), th = 2 * Math.PI * this.u();
    this.spare = r * Math.sin(th); this.has = true;
    return r * Math.cos(th);
  }
}

/**
 * Smooth band-limited noise in [-1, 1] advanced by a fixed time step: random knots every 1/f seconds joined
 * with a C1 Hermite curve, two octaves (f and 2.1 f). Used for prop-wash buffeting (PHYSICS.md 3.4: 15–60 Hz).
 */
export class SmoothNoise {
  private t = [0, 0]; private k0 = [0, 0]; private k1 = [0, 0];
  private readonly f: [number, number];
  constructor(private u: () => number, freq: number) {
    this.f = [freq, freq * 2.1];
    for (let o = 0; o < 2; o++) { this.k0[o] = u() * 2 - 1; this.k1[o] = u() * 2 - 1; }
  }
  step(dt: number): number {
    let v = 0;
    for (let o = 0; o < 2; o++) {
      this.t[o] += dt * this.f[o];
      while (this.t[o] >= 1) { this.t[o] -= 1; this.k0[o] = this.k1[o]; this.k1[o] = this.u() * 2 - 1; }
      const s = this.t[o], h = s * s * (3 - 2 * s);
      v += (o === 0 ? 0.7 : 0.3) * (this.k0[o] + (this.k1[o] - this.k0[o]) * h);
    }
    return v;
  }
}
