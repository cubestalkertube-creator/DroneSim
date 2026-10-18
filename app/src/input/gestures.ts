// Arming / disarming with the sticks, as the flight controllers of real GPS drones do it (PLAN.md 5.3):
//  * DJI-style consumer drones: CSC (combination stick command) — both sticks down and to the inner or the outer
//    corners starts the motors; on the ground the CSC again stops them (as does the throttle held down for 1 s,
//    which the position controller does itself: sim/fc/position.ts);
//  * PX4 / ArduPilot: throttle down + yaw right held (1 s / 2 s) arms, throttle down + yaw left disarms on the ground.
// Betaflight quads arm only with a switch (stick arming was removed from Betaflight). Pure logic, no DOM.
import type { Sticks } from '../sim/fc/betaflight';

export type ArmGesture = 'csc' | 'yaw' | null;

/** Which gesture the flight controller understands and how long it must be held (s). */
export function armGesture(fcType: string): { kind: ArmGesture; hold: number } {
  if (fcType === 'gps_consumer') return { kind: 'csc', hold: 0.4 };
  if (fcType === 'px4' || fcType === 'px4_vtol') return { kind: 'yaw', hold: 1 };
  if (fcType === 'ardupilot') return { kind: 'yaw', hold: 2 };
  return { kind: null, hold: 0 };
}

const LOW = 0.06, END = 0.75;
/** Mode 2 CSC: left stick down-right + right stick down-left (inner) or down-left + down-right (outer). */
export const isCsc = (s: Sticks) =>
  s.throttle < LOW && s.pitch < -END && Math.abs(s.yaw) > END && Math.abs(s.roll) > END && Math.sign(s.yaw) === -Math.sign(s.roll);

/**
 * Feed every frame with the pilot's sticks and the drone state; returns 'arm' / 'disarm' once per completed gesture
 * (the sticks must leave the gesture before the next one counts).
 */
export class StickArming {
  private t = 0; private latched = false;
  constructor(readonly kind: ArmGesture, readonly hold: number) {}

  update(dt: number, s: Sticks, armed: boolean, landed: boolean): 'arm' | 'disarm' | null {
    if (!this.kind) return null;
    let want: 'arm' | 'disarm' | null = null;
    if (this.kind === 'csc') {
      if (isCsc(s)) want = armed ? (landed ? 'disarm' : null) : 'arm';
    } else if (s.throttle < LOW && Math.abs(s.yaw) > END) {
      want = s.yaw > 0 ? (armed ? null : 'arm') : armed && landed ? 'disarm' : null;
    }
    if (!want) { this.t = 0; this.latched = false; return null; }
    if (this.latched) return null;
    this.t += dt;
    if (this.t < this.hold) return null;
    this.latched = true; this.t = 0;
    return want;
  }
}
