// Wind (PHYSICS.md 4): power-law mean profile + Dryden gusts (MIL-F-8785C, low altitude) + map turbulence zones.
// Map convention (env.wind.dir_deg): the direction the wind blows FROM, clockwise from north; north = -Z
// (forward in game space), east = +X. W_20 (wind at 20 ft that sets the gust intensity) := env.wind.gust_ms.
import { Gauss, mulberry32 } from './rng';
import { smoothstep } from './aero';
import { DEG, type V3 } from './math';

export interface WindSpec { mean_ms: number; gust_ms: number; dir_deg: number }
/** map.zones entry: spherical region where the gust intensity is multiplied by `gain` (lee of buildings, roofs) */
export interface TurbulenceZone { kind: 'turbulence'; c: [number, number, number]; r: number; gain: number }

const PROFILE_EXP = 0.143;   // W(h) = W10 * (h/10)^0.143
const FT = 3.28084;
const GUST_DT = 0.01;        // Dryden filters run at 100 Hz
const H_MIN = 1, H_MAX = 300;

export class WindField {
  mean = 0; gust = 0; dir = 0;
  zones: TurbulenceZone[] = [];
  /** gust state along (u: downwind, v: crosswind, w: vertical), m/s */
  readonly g = { u: 0, v: 0, w: 0 };
  private gauss: Gauss;
  private acc = 0;
  private ex = 0; private ez = 1; // unit downwind direction (x, z)

  constructor(seed = 1) { this.gauss = new Gauss(mulberry32(seed ^ 0x5bd1e995)); }

  configure(spec: WindSpec | undefined, zones: unknown[] = []) {
    this.mean = spec?.mean_ms ?? 0; this.gust = spec?.gust_ms ?? 0; this.dir = spec?.dir_deg ?? 0;
    const d = this.dir * DEG;
    this.ex = -Math.sin(d); this.ez = Math.cos(d); // blowing FROM dir -> towards the opposite
    this.zones = zones.filter((z): z is TurbulenceZone => (z as TurbulenceZone)?.kind === 'turbulence');
    this.g.u = this.g.v = this.g.w = 0; this.acc = 0;
  }

  get active() { return this.mean > 0 || this.gust > 0; }

  /** Mean wind speed at height h (m) above ground. */
  meanAt(h: number) { return this.mean * Math.pow(Math.min(H_MAX, Math.max(H_MIN, h)) / 10, PROFILE_EXP); }

  /** Gust intensity multiplier of the turbulence zones at p. */
  zoneGain(p: V3): number {
    let k = 1;
    for (const z of this.zones) {
      const d = Math.hypot(p.x - z.c[0], p.y - z.c[1], p.z - z.c[2]);
      k = Math.max(k, 1 + (z.gain - 1) * (1 - smoothstep(0.6 * z.r, z.r, d)));
    }
    return k;
  }

  /**
   * Advance the gust filters and write the wind velocity at p into out.
   * @param airspeed speed of the drone through the air (the Dryden spatial model is swept at this speed)
   */
  update(dt: number, p: V3, airspeed: number, out: V3): V3 {
    if (!this.active) { out.x = out.y = out.z = 0; return out; }
    const h = Math.min(H_MAX, Math.max(H_MIN, p.y));
    const W = this.meanAt(h);
    this.acc += dt;
    while (this.acc >= GUST_DT) {
      this.acc -= GUST_DT;
      // MIL-F-8785C low altitude (h in ft): L_u = L_v = h/(0.177+0.000823h)^1.2, L_w = h,
      // sigma_w = 0.1 W20, sigma_u = sigma_v = sigma_w/(0.177+0.000823h)^0.4
      const hf = h * FT, k = 0.177 + 0.000823 * hf;
      const Lu = hf / Math.pow(k, 1.2) / FT, Lw = h;
      const sw = 0.1 * this.gust * this.zoneGain(p), su = sw / Math.pow(k, 0.4);
      const V = Math.max(1, airspeed, W);
      // exact discretisation of the first-order shaping filter (stationary variance sigma^2)
      const au = Math.exp((-V * GUST_DT) / Lu), aw = Math.exp((-V * GUST_DT) / Lw);
      this.g.u = au * this.g.u + su * Math.sqrt(1 - au * au) * this.gauss.next();
      this.g.v = au * this.g.v + su * Math.sqrt(1 - au * au) * this.gauss.next();
      this.g.w = aw * this.g.w + sw * Math.sqrt(1 - aw * aw) * this.gauss.next();
    }
    const u = W + this.g.u;
    out.x = this.ex * u - this.ez * this.g.v;
    out.z = this.ez * u + this.ex * this.g.v;
    out.y = this.g.w;
    return out;
  }
}
