// Rapier world: static map colliders + the drone rigid body. Fixed 1 kHz step (PHYSICS.md 0, 7).
import RAPIER from '@dimforge/rapier3d-compat';
import { Drone, type BodyState, type Environment } from './drone';
import type { Sticks } from './fc/betaflight';
import type { MapLayout } from './layout';
import { DEG, q4, qmul, quatFromAxisAngle, rotate, v3, type Q4, type V3 } from './math';
import type { DronePreset } from './presets';
import { WindField } from './wind';

export const SIM_DT = 1 / 1000;
export const GRAVITY = 9.80665;
/** ground outside the map (fixed wings fly kilometres): matches the render backdrop plane at y = -1 */
const FAR_GROUND_HALF = 20000, FAR_GROUND_TOP = -1;

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export interface CrashEvent { impulse: number; speed: number }
/** kamikaze charge went off: where, how (contact fuse / command) and the speed just before it */
export interface BlastEvent { pos: V3; cause: 'impact' | 'command'; speed: number; radius: number }

export class SimWorld {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  drone!: Drone;
  body!: RAPIER.RigidBody;
  droneCollider!: RAPIER.Collider;
  readonly state: BodyState = { pos: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, vel: v3(), angVel: v3() };
  readonly env: Environment;
  readonly wind: WindField;
  time = 0;
  crash: CrashEvent | null = null;
  /** the charge went off (sticky until reset): the airframe is gone, the body is disabled */
  blast: BlastEvent | null = null;
  /** largest contact impulse in the last step (N*s) */
  lastImpulse = 0;
  private fw = v3(); private tw = v3();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  /**
   * @param seed session seed for every random process in the physics (wind, prop wash, sensor noise)
   * @param dt physics step (s): 1 ms reference, 2 ms on the Low (phone) profile
   */
  constructor(readonly seed = 1, readonly dt = SIM_DT) {
    this.wind = new WindField(seed);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = dt;
    this.events = new RAPIER.EventQueue(true);
    const self = this;
    this.env = {
      wind: v3(),
      ray(origin: V3, dir: V3, max: number) {
        self.ray.origin = origin; self.ray.dir = dir;
        const hit = self.world.castRay(self.ray, max, true, undefined, undefined, undefined, self.body);
        return hit ? hit.timeOfImpact : Infinity;
      },
    };
  }

  addStaticBox(c: V3, half: V3, q = { x: 0, y: 0, z: 0, w: 1 }, friction = 0.8) {
    const d = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(c.x, c.y, c.z).setRotation(q).setFriction(friction).setRestitution(0.15);
    return this.world.createCollider(d);
  }

  loadMap(L: MapLayout) {
    this.wind.configure(L.env.wind, L.zones ?? []);
    for (const c of L.colliders) {
      const q = { x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] };
      if (c.type === 'box') {
        this.addStaticBox({ x: c.c[0], y: c.c[1], z: c.c[2] }, { x: c.half[0], y: c.half[1], z: c.half[2] }, q);
      } else {
        const d = RAPIER.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.c[0], c.c[1], c.c[2]).setRotation(q).setFriction(0.8).setRestitution(0.15);
        this.world.createCollider(d);
      }
    }
    if (L.terrain) {
      this.world.createCollider(heightfieldDesc(L.terrain.size, L.terrain.res, L.terrain.heights_rowmajor_blenderY));
      this.addStaticBox({ x: 0, y: FAR_GROUND_TOP - 0.5, z: 0 }, { x: FAR_GROUND_HALF, y: 0.5, z: FAR_GROUND_HALF });
    } else this.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: FAR_GROUND_HALF, y: 0.5, z: FAR_GROUND_HALF });
    this.world.step(); // builds the broad-phase so ray queries work before the first simulation step
  }

  spawnDrone(preset: DronePreset, pos: V3, rot = { x: 0, y: 0, z: 0, w: 1 }) {
    this.drone = new Drone(preset, this.seed);
    const m = this.drone.model;
    ({ pos, rot } = this.launchPose(pos, rot));
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z).setRotation(rot)
      .setCcdEnabled(true).setCanSleep(false)
      .setAdditionalMassProperties(m.mass, { x: 0, y: 0, z: 0 }, m.inertia, { x: 0, y: 0, z: 0, w: 1 });
    this.body = this.world.createRigidBody(bd);
    const he = m.halfExtents;
    const cd = RAPIER.ColliderDesc.cuboid(he.x, he.y, he.z).setDensity(0).setFriction(0.6).setRestitution(0.25)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0);
    this.droneCollider = this.world.createCollider(cd, this.body);
    this.readState();
  }

  resetDrone(pos: V3, rot = { x: 0, y: 0, z: 0, w: 1 }) {
    this.drone.reset();
    ({ pos, rot } = this.launchPose(pos, rot));
    this.body.setTranslation(pos, true); this.body.setRotation(rot, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true); this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.wind.configure(this.windSpec(), this.wind.zones);
    this.crash = null;
    this.blast = null;
    this.body.setEnabled(true);
    this.readState();
  }

  /** The charge is live: motors armed (and the wing off its launch rail). */
  get fuseArmed(): boolean {
    const d = this.drone;
    if (!d.model.preset.warhead || this.blast) return false;
    return d.plane ? d.plane.armed && !d.rail.active && d.plane.phase !== 'rail' : d.fc.armed;
  }

  /** Set the charge off: the airframe is destroyed, motors stop, the body leaves the world. */
  detonate(cause: BlastEvent['cause'], speed = Math.hypot(this.state.vel.x, this.state.vel.y, this.state.vel.z)): boolean {
    const w = this.drone.model.preset.warhead;
    if (!w || this.blast) return false;
    const d = this.drone;
    this.blast = { pos: { ...this.state.pos }, cause, speed, radius: w.blast_radius_m };
    d.fc.setArmed(false, 0);
    if (d.plane) d.plane.armed = false;
    d.visOmega.fill(0); d.visThrust.fill(0);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, false); this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.body.setEnabled(false);
    this.readState();
    return true;
  }

  /** Rail launcher (delta wing): the airframe sits on a rail inclined by rail_elev above the spawn point. */
  private launchPose(pos: V3, rot: Q4): { pos: V3; rot: Q4 } {
    const l = this.drone.model.preset.launch, r = this.drone.rail;
    if (!l || l.type !== 'rail_booster') return { pos, rot };
    const q = qmul(q4(), rot, quatFromAxisAngle(q4(), 1, 0, 0, l.rail_elev_deg * DEG)); // nose up about body X
    r.start.x = pos.x; r.start.y = pos.y + l.rail_height_m; r.start.z = pos.z;
    rotate(r.dir, q, v3(0, 0, -1));
    r.rot.x = q.x; r.rot.y = q.y; r.rot.z = q.z; r.rot.w = q.w;
    return { pos: { ...r.start }, rot: q };
  }

  /** On the rail: one degree of freedom along it; held until the booster fires, released at its end. */
  private stepRail(sticks: Sticks) {
    const d = this.drone, r = d.rail, l = d.model.preset.launch!;
    d.step(this.dt, sticks, this.state, this.env);
    if (r.fired) {
      rotate(this.fw, this.state.rot, d.force);
      const a = (this.fw.x * r.dir.x + this.fw.y * r.dir.y + this.fw.z * r.dir.z) / d.model.mass - GRAVITY * r.dir.y;
      r.sDot = Math.max(0, r.sDot + a * this.dt);
      r.s += r.sDot * this.dt;
      if (r.s >= l.rail_length_m) r.active = false;
    }
    const b = this.body;
    b.setTranslation({ x: r.start.x + r.dir.x * r.s, y: r.start.y + r.dir.y * r.s, z: r.start.z + r.dir.z * r.s }, true);
    b.setRotation(r.rot, true);
    b.setLinvel({ x: r.dir.x * r.sDot, y: r.dir.y * r.sDot, z: r.dir.z * r.sDot }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.lastImpulse = 0;
    this.readState();
    this.time += this.dt;
  }

  private readState() {
    const s = this.state;
    const t = this.body.translation(), r = this.body.rotation(), v = this.body.linvel(), w = this.body.angvel();
    s.pos.x = t.x; s.pos.y = t.y; s.pos.z = t.z;
    s.rot.x = r.x; s.rot.y = r.y; s.rot.z = r.z; s.rot.w = r.w;
    s.vel.x = v.x; s.vel.y = v.y; s.vel.z = v.z;
    s.angVel.x = w.x; s.angVel.y = w.y; s.angVel.z = w.z;
  }

  private windSpec() { return { mean_ms: this.wind.mean, gust_ms: this.wind.gust, dir_deg: this.wind.dir }; }

  step(sticks: Sticks) {
    const d = this.drone;
    if (this.blast) { this.lastImpulse = 0; this.time += this.dt; return; } // nothing left to fly
    this.wind.update(this.dt, this.state.pos, d.tele.airspeed, this.env.wind);
    if (d.rail.active) { this.stepRail(sticks); return; }
    const preSpeed = Math.hypot(this.state.vel.x, this.state.vel.y, this.state.vel.z), fuse = this.fuseArmed;
    d.step(this.dt, sticks, this.state, this.env);
    rotate(this.fw, this.state.rot, d.force);
    rotate(this.tw, this.state.rot, d.torque);
    this.body.resetForces(false); this.body.resetTorques(false);
    this.body.addForce(this.fw, true); this.body.addTorque(this.tw, true);
    this.world.step(this.events);
    this.lastImpulse = 0;
    this.events.drainContactForceEvents((e) => {
      const imp = e.totalForceMagnitude() * this.dt;
      if (imp > this.lastImpulse) this.lastImpulse = imp;
    });
    // contact fuse: any surface touched at speed (the speed before the contact, the impact has already slowed us)
    const wh = d.model.preset.warhead;
    if (fuse && wh && preSpeed >= wh.fuse_speed_ms && this.lastImpulse > wh.fuse_impulse_ns) {
      this.detonate('impact', preSpeed);
      this.time += this.dt;
      return;
    }
    const speed = Math.hypot(this.state.vel.x, this.state.vel.y, this.state.vel.z);
    const crashImpulse = 0.5 * (d.model.preset.damage?.J_arm ?? 6);
    if (!this.crash && this.lastImpulse > crashImpulse) {
      this.crash = { impulse: this.lastImpulse, speed };
      d.fc.setArmed(false, 0);
      if (d.plane) d.plane.armed = false;
    }
    this.readState();
    this.time += this.dt;
  }
}

/** Build a Rapier heightfield from map_builder's row-major (Blender Y) grid. Rapier wants column-major
 *  (nrows+1)x(ncols+1) with rows along Z and columns along X, centred at the origin. */
export function heightfieldDesc(size: number, res: number, h: number[]) {
  const n = res + 1;
  const hf = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {        // row along game +Z
    const j = res - row;                     // game z = -blender y
    for (let col = 0; col < n; col++) hf[row + col * n] = h[j * n + col];
  }
  return RAPIER.ColliderDesc.heightfield(res, res, hf, { x: size, y: 1, z: size }).setFriction(0.9).setRestitution(0.1);
}
