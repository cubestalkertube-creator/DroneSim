// Rotor aerodynamics helpers (PHYSICS.md 3.4 vortex ring / prop wash, 3.5 rotor-wake interference).
import { clamp } from './math';

export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// PHYSICS.md 3.4 coefficients
export const VRS_THRUST_LOSS = 0.35;   // mean thrust loss at full VRS
export const VRS_THRUST_NOISE = 0.25;  // relative thrust buffeting amplitude
export const VRS_TORQUE_NOISE = 0.02;  // buffeting torque per rotor = this (m) * hover thrust of one rotor
export const VRS_NOISE_HZ = 22;        // base frequency of the buffeting noise (two octaves -> ~15-60 Hz)
// The ring only forms when the rotor sinks into its own wake: in-plane speed blows the wake away.
// Not in the spec formula; fraction of v_h where the effect fades out (5 m/s sideways kills it on a 5").
const VRS_MU_FADE: [number, number] = [0.35, 0.75];

/** Hover induced velocity v_h = sqrt(T / (2 rho A)) for one rotor of diameter D carrying thrust T. */
export const inducedVelocity = (thrust: number, diameter: number, rho: number) =>
  Math.sqrt(Math.max(0, thrust) / (2 * rho * Math.PI * diameter * diameter * 0.25));

/**
 * VRS / prop-wash intensity 0..1.
 * @param lambda descent rate into the own wake along the thrust axis / v_h (>0 = sinking)
 * @param mu in-plane airspeed / v_h
 */
export function vrsIntensity(lambda: number, mu: number): number {
  if (lambda <= 0.3) return 0;
  return smoothstep(0.3, 0.8, lambda) * (1 - smoothstep(1.5, 2.2, lambda)) * (1 - smoothstep(VRS_MU_FADE[0], VRS_MU_FADE[1], mu));
}

// PHYSICS.md 3.5: k_T_rear *= 1 - 0.1 * smoothstep(3, 12, v_forward)
export const WAKE_LOSS = 0.1;
/**
 * Thrust factor of a rotor at in-plane position (rx, rz) when the body moves through the air with in-plane
 * velocity (vx, vz): rotors downstream of the others ingest their wake.
 */
export function wakeFactor(rx: number, rz: number, vx: number, vz: number): number {
  const v = Math.hypot(vx, vz), r = Math.hypot(rx, rz);
  if (v < 3 || r < 1e-6) return 1;
  // -cos(angle) between rotor position and motion: 1 directly behind, 0 abeam; quad-X rear pair at 45° -> 1
  const behind = clamp((-(rx * vx + rz * vz) / (r * v)) * Math.SQRT2, 0, 1);
  return 1 - WAKE_LOSS * smoothstep(3, 12, v) * behind;
}
