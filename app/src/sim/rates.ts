// Stick -> angular-rate curves, ported from Betaflight src/main/fc/rc.c (PHYSICS.md 5.1). Output in deg/s.
// Profiles keep the numbers as the Betaflight Configurator shows them; cli.ts converts to/from `set …` lines.

const SETPOINT_RATE_LIMIT = 1998;
const cube = (x: number) => x * x * x;

/** Betaflight "Actual" rates: center sensitivity (deg/s), max rate (deg/s), expo (0..1). */
export function actualRate(x: number, center: number, max: number, expo: number): number {
  const ax = Math.abs(x);
  const e = ax * (Math.pow(x, 5) * expo + x * (1 - expo));
  return x * center + Math.max(0, max - center) * e;
}

/** Classic Betaflight rates: rc_rate, super_rate, rc_expo (all as in the configurator, e.g. 1.0 / 0.7 / 0.0). */
export function betaflightRate(x: number, rcRate: number, superRate: number, expo: number): number {
  const ax = Math.abs(x);
  if (expo) x = x * ax * ax * ax * expo + x * (1 - expo);
  const rr = rcRate > 2 ? rcRate + 14.54 * (rcRate - 2) : rcRate;
  let rate = 200 * rr * x;
  if (superRate) rate *= 1 / Math.min(1, Math.max(0.01, 1 - ax * superRate));
  return rate;
}

/** Quick rates: rc_rate (1.0 = 200 deg/s centre), max rate (deg/s), expo (0..1). BF quickRatesRcExpo = off. */
export function quickRate(x: number, rcRate: number, max: number, expo: number): number {
  const rc = rcRate * 200;
  const maxDps = Math.max(max, rc);
  const sfc = (maxDps / rc - 1) / (maxDps / rc);
  const ax = Math.abs(x);
  const curve = cube(ax) * expo + ax * (1 - expo);
  const sf = 1 / Math.min(1, Math.max(0.01, 1 - curve * sfc));
  return Math.max(-SETPOINT_RATE_LIMIT, Math.min(SETPOINT_RATE_LIMIT, x * rc * sf));
}

/** KISS rates: rc_rate, rate, rc_curve (configurator values, e.g. 1.0 / 0.7 / 0.0). */
export function kissRate(x: number, rcRate: number, rate: number, curve: number): number {
  const ax = Math.abs(x);
  const use = 1 / Math.min(1, Math.max(0.01, 1 - ax * rate));
  const cmd = (cube(x) * curve + x * (1 - curve)) * (rcRate / 10);
  return Math.max(-SETPOINT_RATE_LIMIT, Math.min(SETPOINT_RATE_LIMIT, 2000 * use * cmd));
}

/** RaceFlight rates: rate (deg/s), acro+ (0..2.55), expo (0..1). */
export function raceflightRate(x: number, rate: number, acroPlus: number, expo: number): number {
  const c = (1 + expo * (x * x - 1)) * x;
  return rate * c * (1 + Math.abs(x) * acroPlus);
}

export type RateType = 'actual' | 'betaflight' | 'quick' | 'kiss' | 'raceflight';
export type RateTriple = [number, number, number];
export interface RateProfile { type: RateType; roll: RateTriple; pitch: RateTriple; yaw: RateTriple }

const FN: Record<RateType, (x: number, a: number, b: number, c: number) => number> = {
  actual: actualRate, betaflight: betaflightRate, quick: quickRate, kiss: kissRate, raceflight: raceflightRate,
};

export function applyRate(profile: RateProfile, axis: 'roll' | 'pitch' | 'yaw', x: number): number {
  const [a, b, c] = profile[axis];
  return (FN[profile.type] ?? actualRate)(x, a, b, c);
}
