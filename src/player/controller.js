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
    this.target = v3.clone();
  }

  stop() {
    this.target = null;
    if (this.moving) { this.moving = false; this.avatar.setAnim('idle'); }
  }

  /** Snap y to ground under (x, z). Returns false if off the ground meshes. */
  snapToGround(room, pos) {
    this.ray.set(new THREE.Vector3(pos.x, pos.y + 5, pos.z), DOWN);
    const hits = this.ray.intersectObjects(room.groundMeshes, false);
    if (!hits.length) return false;
    pos.y = hits[0].point.y;
    return true;
  }

  update(dt, room) {
    const g = this.avatar.group;
    if (this.target) {
      const to = new THREE.Vector3(this.target.x - g.position.x, 0, this.target.z - g.position.z);
      const dist = to.length();
      if (dist < 0.12) {
        this.stop();
      } else {
        to.normalize();
        const step = Math.min(this.speed * dt, dist);
        const next = g.position.clone().addScaledVector(to, step);

        // circle-obstacle slide
        for (const o of room.obstacles) {
          const dx = next.x - o.x, dz = next.z - o.z;
          const d = Math.hypot(dx, dz);
          if (d < o.r && d > 1e-4) {
            next.x = o.x + (dx / d) * o.r;
            next.z = o.z + (dz / d) * o.r;
          }
        }

        if (this.snapToGround(room, next)) {
          g.position.copy(next);
          const yaw = Math.atan2(to.x, to.z);
          const delta = ((((yaw - g.rotation.y) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          g.rotation.y += delta * Math.min(1, dt * 14);
          if (!this.moving) { this.moving = true; this.avatar.setAnim('walk'); }
        } else {
          this.stop(); // walked off the walkable area
        }
      }
    }
  }
}
