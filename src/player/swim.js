import * as THREE from 'three';

/**
 * SwimController: the movement model for The Drift (docs/LIVING-COVE.md C).
 *
 * The Drift has no floor, so `WalkController` cannot drive it: the room sets
 * `engine.controller.enabled = false` and runs this instead. Differences from
 * the walker, all deliberate:
 *  - Full 3D. The click target is a point in the water volume, not on a mesh.
 *  - Velocity, not position, is steered: water has momentum and drag, so the
 *    capy glides to a stop instead of snapping. Time constant ~0.3s.
 *  - Banked turns: the body rolls INTO a turn and pitches with vertical speed,
 *    which is what sells "swimming" over "sliding through fog".
 *  - Bounds are a soft AABB. Pushing the edge eases you back ("the current");
 *    there are no walls to bump, and a hard clamp only exists as a backstop
 *    well outside the soft margin.
 *  - A slow buoyancy bob is added on top of the physics position for the
 *    visual only. It is deliberately gentle: `net/client.js` gates move frames
 *    at 0.02 units of y, and a bigger bob would make a motionless swimmer
 *    stream position updates at the full tick rate forever.
 *
 * No DOM, no import-time side effects. The room owns the pointer handling and
 * hands us world-space targets.
 */

const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _want = new THREE.Vector3();
const _acc = new THREE.Vector3();

export const SWIM_SPEED = 6.6;      // units/sec cruise (walker is 5.2)
const ARRIVE = 0.4;                 // close enough: drop the target and coast
const EASE_IN = 4.6;                // start braking this far from the target
const RESPONSE = 3.6;               // 1/s: how hard we chase the desired velocity
const TURN_RATE = 4.6;              // 1/s yaw lerp
const BANK = 0.85;                  // roll per radian of remaining turn
const MAX_BANK = 0.72;
const MAX_PITCH = 0.78;

/** Shortest signed angle from a to b, in (-PI, PI]. */
function angleDelta(a, b) {
  return ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

/** Inward acceleration for one axis of the soft bounds. 0 well inside. */
function edgePush(p, lo, hi, margin, strength) {
  if (p < lo + margin) return ((lo + margin - p) / margin) * strength;
  if (p > hi - margin) return -((p - (hi - margin)) / margin) * strength;
  return 0;
}

export class SwimController {
  /**
   * @param {object} avatar        createAvatar() result
   * @param {object} opts
   * @param {THREE.Box3} opts.bounds  soft water volume
   * @param {number} opts.margin      soft-edge thickness (the current)
   * @param {number} opts.current     inward acceleration at full penetration
   */
  constructor(avatar, {
    bounds = null, speed = SWIM_SPEED, margin = 5, marginY = 1.6,
    current = 11, drag = 2.1,
  } = {}) {
    this.avatar = avatar;
    this.bounds = bounds || new THREE.Box3(
      new THREE.Vector3(-25, 1, -25), new THREE.Vector3(25, 18, 25),
    );
    this.speed = speed;
    this.margin = margin;
    // The water column is far shorter than it is wide, so the vertical current
    // gets its own thin margin: sharing the horizontal one would leave a free
    // band a couple of units tall and shove every swimmer off the seabed.
    this.marginY = marginY;
    this.current = current;
    this.drag = drag;

    this.pos = avatar.group.position.clone(); // physics position (bob excluded)
    this.vel = new THREE.Vector3();
    this.target = null;
    this.enabled = true;
    this.mounted = false;   // riding Big Blue: the room owns the transform

    this.yaw = avatar.group.rotation.y;
    this.pitch = 0;
    this.roll = 0;
    this.bobT = Math.random() * 10;
    this.bobY = 0;
    this.speedNow = 0;
  }

  /** Swim toward a world point (clamped into the volume). */
  setTarget(v3) {
    this.target = (this.target || new THREE.Vector3()).copy(v3);
    this.bounds.clampPoint(this.target, this.target);
  }

  /** Drop the target; drag brings us to a stop. */
  stop() {
    this.target = null;
  }

  /** Hard-place the capy (spawn, dismount). Clears momentum and the target. */
  teleport(v3) {
    this.pos.copy(v3);
    this.vel.set(0, 0, 0);
    this.target = null;
    this.avatar.group.position.copy(v3);
  }

  /** Re-read the avatar transform after something else moved it. */
  syncFromAvatar() {
    this.pos.copy(this.avatar.group.position);
    this.pos.y -= this.bobY;
    this.yaw = this.avatar.group.rotation.y;
  }

  /** Push the swimmer away from a sphere (Big Blue's flanks, boulders). */
  repel(cx, cy, cz, radius, dt) {
    const dx = this.pos.x - cx;
    const dy = this.pos.y - cy;
    const dz = this.pos.z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d >= radius || d < 1e-4) return;
    const k = ((radius - d) / radius) * 14 * dt;
    this.pos.x += (dx / d) * k;
    this.pos.y += (dy / d) * k;
    this.pos.z += (dz / d) * k;
  }

  update(dt) {
    if (!this.enabled || this.mounted) {
      // riding: the room writes the transform, we just keep the pose upright
      this.speedNow = 0;
      return;
    }
    const g = this.avatar.group;

    // ---- steering: chase a desired velocity, never a position --------------
    _want.set(0, 0, 0);
    if (this.target) {
      _to.copy(this.target).sub(this.pos);
      const dist = _to.length();
      if (dist < ARRIVE) {
        this.target = null;
      } else {
        _dir.copy(_to).divideScalar(dist);
        // ease into the last few units so arrival is a glide, not a stop
        _want.copy(_dir).multiplyScalar(this.speed * Math.min(1, dist / EASE_IN));
      }
    }
    _acc.copy(_want).sub(this.vel).multiplyScalar(this.target ? RESPONSE : this.drag);

    // ---- the current: a soft AABB, no walls -------------------------------
    // unrolled per axis: an ['x','y','z'] loop would allocate every frame
    const lo = this.bounds.min;
    const hi = this.bounds.max;
    const m = this.margin;
    const my = this.marginY;
    const c = this.current;
    _acc.x += edgePush(this.pos.x, lo.x, hi.x, m, c);
    _acc.y += edgePush(this.pos.y, lo.y, hi.y, my, c);
    _acc.z += edgePush(this.pos.z, lo.z, hi.z, m, c);

    this.vel.addScaledVector(_acc, dt);
    const sp = this.vel.length();
    if (sp > this.speed * 1.6) this.vel.multiplyScalar((this.speed * 1.6) / sp);
    this.pos.addScaledVector(this.vel, dt);
    this.speedNow = sp;

    // backstop only: the current above should always win before we get here
    this.pos.x = Math.max(lo.x - m, Math.min(hi.x + m, this.pos.x));
    this.pos.y = Math.max(lo.y, Math.min(hi.y + my, this.pos.y));
    this.pos.z = Math.max(lo.z - m, Math.min(hi.z + m, this.pos.z));

    // ---- orientation: yaw follows the swim, roll banks into the turn ------
    if (sp > 0.35) {
      const wantYaw = Math.atan2(this.vel.x, this.vel.z);
      const d = angleDelta(this.yaw, wantYaw);
      this.yaw += d * Math.min(1, dt * TURN_RATE);
      const lean = Math.max(-1, Math.min(1, sp / 3.2));
      const wantRoll = Math.max(-MAX_BANK, Math.min(MAX_BANK, -d * BANK)) * lean;
      const wantPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH,
        -Math.asin(Math.max(-1, Math.min(1, this.vel.y / Math.max(sp, 1e-4)))) * 0.85));
      this.roll += (wantRoll - this.roll) * Math.min(1, dt * 4);
      this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 4);
    } else {
      this.roll -= this.roll * Math.min(1, dt * 2);
      this.pitch -= this.pitch * Math.min(1, dt * 2);
    }

    // ---- buoyancy bob (visual only, see the header note) -------------------
    this.bobT += dt;
    this.bobY = Math.sin(this.bobT * 1.25) * 0.075 + Math.sin(this.bobT * 0.57) * 0.04;

    g.position.set(this.pos.x, this.pos.y + this.bobY, this.pos.z);
    // YXZ so rotation.y stays the yaw the net client puts on the wire
    g.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
  }
}
