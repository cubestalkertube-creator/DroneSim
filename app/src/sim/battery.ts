// Battery pack, Thevenin model (PHYSICS.md 2.2): V_bus = cells*OCV(SoC) - I*R_int - V_rc, polarization RC branch.
// The pack is solved together with the motors each step (see motor.ts): the bus current is linear in V_bus,
// so the terminal voltage has a closed-form solution and there is no algebraic loop.
import type { DronePreset } from './presets';

interface Chemistry {
  /** resting open-circuit voltage per cell at SoC 0, 0.05 … 1 (load sag is modelled separately by R_int and the RC branch) */
  ocv: number[];
  /** OSD "LOW BATTERY" (per cell, filtered, under load) and ESC low-voltage cutoff (per cell) */
  warn: number; cutoff: number;
}

// Resting OCV curves of common cells. LiPo: 4.20 V full, flat ~3.8 V plateau, knee below 10 %. Li-ion (21700
// NMC/NCA): lower plateau and a long tail down to 2.8 V — it sags hard under a punch and keeps flying lower.
const LIPO: Chemistry = {
  ocv: [3.30, 3.61, 3.69, 3.71, 3.73, 3.75, 3.77, 3.79, 3.80, 3.82, 3.84, 3.85, 3.87, 3.91, 3.95, 3.98, 4.02, 4.08, 4.11, 4.15, 4.20],
  warn: 3.5, cutoff: 3.0,
};
const LIION: Chemistry = {
  ocv: [2.80, 3.20, 3.35, 3.42, 3.47, 3.51, 3.55, 3.59, 3.62, 3.66, 3.69, 3.73, 3.77, 3.81, 3.86, 3.90, 3.95, 4.00, 4.06, 4.13, 4.20],
  warn: 3.1, cutoff: 2.7,
};
const CHEM: Record<string, Chemistry> = { lipo: LIPO, liion: LIION, liion_smart: LIION };

/** V_bus low-pass for the OSD voltage and, slower, for the LVC warning (Betaflight filters vbat too) */
const V_FILTER_S = 0.5, V_WARN_FILTER_S = 3;
/** cutoff limiter: how fast the ESC throttles back below the cutoff voltage and recovers above it (1/s) */
const LIMIT_DOWN = 4, LIMIT_UP = 0.5;
/** internal resistance rises towards the end of the pack: x(1 + R_EMPTY_RISE) at SoC 0, from SoC R_EMPTY_SOC down */
const R_EMPTY_RISE = 1.5, R_EMPTY_SOC = 0.15;

export function ocvPerCell(chem: string, soc: number): number {
  const t = (CHEM[chem] ?? LIPO).ocv;
  const x = Math.min(1, Math.max(0, soc)) * (t.length - 1);
  const i = Math.min(t.length - 2, Math.floor(x));
  return t[i] + (t[i + 1] - t[i]) * (x - i);
}

export class Battery {
  readonly cells: number;
  readonly capacityAh: number;
  readonly rInt: number;   // pack internal resistance (ohm)
  readonly rP: number;     // polarization resistance (ohm)
  readonly tauP: number;   // R_p*C_p (s)
  readonly avionicsA: number;
  readonly chem: Chemistry; readonly chemName: string;
  /** false for presets without a battery (combustion engine): constant nominal voltage, nothing drains */
  readonly present: boolean;
  soc = 1; vrc = 0;
  vbus = 0; current = 0; mAh = 0; vFilt = 0; vWarn = 0;
  /** 0..1 duty multiplier applied by the ESC when the cell voltage falls below cutoff */
  limit = 1;

  constructor(p: DronePreset, readonly nominalV = 0) {
    const b = p.battery;
    this.present = !!b;
    this.chemName = b?.chem ?? 'lipo';
    this.chem = CHEM[this.chemName] ?? LIPO;
    this.cells = b?.cells ?? 1;
    this.capacityAh = (b?.capacity_mah ?? 1000) / 1000;
    this.rInt = b ? b.r_cell * b.cells : 0;
    this.rP = this.rInt * (b?.rp_ratio ?? 1);
    this.tauP = b?.rp_cp_s ?? 3;
    this.avionicsA = b?.avionics_a ?? 1;
    this.reset();
  }

  reset(soc = 1) {
    this.soc = soc; this.vrc = 0; this.current = 0; this.mAh = 0; this.limit = 1;
    this.vbus = this.vFilt = this.vWarn = this.ocv();
  }

  ocv(): number { return this.present ? this.cells * ocvPerCell(this.chemName, this.soc) : this.nominalV; }

  /** Terminal voltage for a bus current that is linear in it: I(V) = a*V + b. */
  solve(a: number, b: number): number {
    if (!this.present) return this.nominalV;
    const r = this.rNow();
    const v = (this.ocv() - this.vrc - r * b) / (1 + r * a);
    return Math.max(0, v);
  }

  /** internal resistance at the current state of charge */
  rNow(): number { return this.rInt * (1 + (R_EMPTY_RISE * Math.max(0, R_EMPTY_SOC - this.soc)) / R_EMPTY_SOC); }

  /** Commit the step: current I (A) drawn at terminal voltage v for dt seconds. */
  integrate(v: number, I: number, dt: number) {
    this.vbus = v; this.current = I;
    if (!this.present) return;
    this.soc = Math.max(0, this.soc - (I * dt) / (3600 * this.capacityAh));
    this.mAh += (I * dt) / 3.6;
    // exact solution of V_rc' = I/C_p - V_rc/(R_p C_p) for constant I over the step
    const ss = I * this.rP;
    this.vrc = ss + (this.vrc - ss) * Math.exp(-dt / this.tauP);
    this.vFilt += (v - this.vFilt) * (dt / (V_FILTER_S + dt));
    this.vWarn += (v - this.vWarn) * (dt / (V_WARN_FILTER_S + dt));
    // ESC low-voltage cutoff: pull the duty back while the loaded cell voltage is under the cutoff; an empty
    // pack (resting OCV below cutoff) cannot recover -> "the pack is dead, we are falling"
    const cell = v / this.cells;
    if (this.soc <= 0) this.limit = 0;
    else if (cell < this.chem.cutoff) this.limit = Math.max(0, this.limit - LIMIT_DOWN * dt);
    else this.limit = Math.min(1, this.limit + LIMIT_UP * dt);
  }

  get cellV() { return this.vbus / this.cells; }
  get cellFilt() { return this.vFilt / this.cells; }
  /** OSD warning: filtered loaded cell voltage below the chemistry's LVC */
  get low() { return this.present && this.vWarn / this.cells < this.chem.warn; }
  get cutoff() { return this.present && this.limit < 0.999; }
}
