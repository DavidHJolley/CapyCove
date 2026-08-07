import * as THREE from 'three';
import { WALK_SPEED } from '../../shared/constants.js';

const DOWN = new THREE.Vector3(0, -1, 0);

/** Click-to-move controller. Owns target-seeking, obstacle slide and ground
 *  height snapping for one avatar. Used by the local player (engine feeds it
 *  click targets) and reusable by anything that walks. */
export class WalkController {
  constructor(avatar) {
    this.avatar = avatar;
    this.target = null;
    this.speed = WALK_SPEED;
    this.ray = new THREE.Raycaster();
    this.moving = false;
  }

  setTarget(v3) {
    this.queue = [];
    this._to(v3);
  }

  /** Walk through the points in order (multi-leg routes: stairs between
   *  floors). The last point is the destination. */
  setPath(points) {
    if (!points?.length) return;
    this.queue = points.slice(1).map((p) => p.clone());
    this._to(points[0]);
  }

  _to(v3) {
    this.target = v3.clone();
    this.stuckT = 0;
  }

  stop() {
    this.target = null;
    this.queue = [];
    if (this.moving) { this.moving = false; this.avatar.setAnim('idle'); }
  }

  /** Multi-floor ground snap: take the HIGHEST surface within step-up range
   *  (1.2 units), so ramps/piers that overlap lower ground lift the walker
   *  instead of sinking them through the planks; anything higher than a step
   *  (a mezzanine overhead) is ignored, so walking beneath it stays below.
   *  Returns false if off the ground meshes. */
  snapToGround(room, pos) {
    this.ray.set(new THREE.Vector3(pos.x, pos.y + 5, pos.z), DOWN);
    const hits = this.ray.intersectObjects(room.groundMeshes, false);
    if (!hits.length) return false;
    let best = null;
    for (const h of hits) {
      if (h.point.y - pos.y <= 1.2 && (!best || h.point.y > best.point.y)) best = h;
    }
    if (!best) {
      for (const h of hits) {
        if (!best || Math.abs(h.point.y - pos.y) < Math.abs(best.point.y - pos.y)) best = h;
      }
    }
    // rooms whose ground dips below a hard line (the beach's wet sand slopes
    // under the sea) refuse footing past it: walkers stop at the shoreline
    if (room.minWalkY !== undefined && best.point.y < room.minWalkY) return false;
    pos.y = best.point.y;
    return true;
  }

  update(dt, room) {
    const g = this.avatar.group;
    if (this.target) {
      const to = new THREE.Vector3(this.target.x - g.position.x, 0, this.target.z - g.position.z);
      const dist = to.length();
      if (dist < 0.12) {
        if (this.queue?.length) this._to(this.queue.shift());
        else this.stop();
      } else {
        to.normalize();
        const step = Math.min(this.speed * dt, dist);
        const next = g.position.clone().addScaledVector(to, step);

        // Circle-obstacle slide: push out to the rim, then carry the blocked
        // part of the step along it. Pushing out alone is not a slide: walking
        // due north at something due north of you (the plaza fountain sits on
        // the spawn -> peak-gate line) put the player back on the same radius
        // every frame and parked them against it forever.
        for (const o of room.obstacles) {
          const dx = next.x - o.x, dz = next.z - o.z;
          const d = Math.hypot(dx, dz);
          if (d < o.r && d > 1e-4) {
            const nx = dx / d, nz = dz / d; // outward normal
            next.x = o.x + nx * o.r;
            next.z = o.z + nz * o.r;
            if (to.x * nx + to.z * nz < 0) { // still heading into it: skirt the rim
              let tx = -nz, tz = nx;
              let td = to.x * tx + to.z * tz;
              if (td < 0) { tx = -tx; tz = -tz; td = -td; } // the side nearer the target
              if (td < 1e-3) td = 1; // dead-on: commit to a side, the next frame agrees
              next.x += tx * step * td;
              next.z += tz * step * td;
            }
          }
        }

        if (this.snapToGround(room, next)) {
          // an obstacle can absorb the whole step (pressed flat against a
          // wall): running in place looks wrong, so a walker who is not
          // actually moving goes idle and gives up on the target
          const moved = Math.hypot(next.x - g.position.x, next.z - g.position.z);
          g.position.copy(next);
          const yaw = Math.atan2(to.x, to.z);
          const delta = ((((yaw - g.rotation.y) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          g.rotation.y += delta * Math.min(1, dt * 14);
          if (moved < step * 0.15) {
            this.stuckT = (this.stuckT || 0) + dt;
            if (this.stuckT > 0.35) { this.stop(); return; }
          } else {
            this.stuckT = 0;
          }
          if (!this.moving) { this.moving = true; this.avatar.setAnim('walk'); }
        } else {
          this.stop(); // walked off the walkable area
        }
      }
    }
  }
}
