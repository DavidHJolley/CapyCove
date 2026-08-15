import * as THREE from 'three';
import { WALK_SPEED } from '../../shared/constants.js';

const DOWN = new THREE.Vector3(0, -1, 0);

const _n = new THREE.Vector3();
const _probe = new THREE.Vector3();

// The shallows: the strip of wet sand a walker can still stand on with the
// water washing over the paws.
//
// NEITHER HEIGHT NOR TILT FINDS IT. The beach's inland sand is dead flat at
// y = 0 and its shoreline cut-off is -0.06, so any height band wide enough to
// catch the shore also catches most of the cove. Tilt is no better: the back
// dunes rise on a constant 0.34-per-unit slope and the sand ripple on top of
// them tips whole swathes of dune toe past any cutoff steep enough to be worth
// having, while the shore itself is GENTLE wherever the cove is narrow (the
// south-west arc runs out of footing at a slope of 0.245, less than the dunes).
// Measured on the beach's real sand mesh, a height-and-tilt test fires up to
// 3.3 units inland and finds no shore at all on 45% of bearings.
//
// So the test asks the question directly: step one pace DOWNHILL (the surface
// normal's horizontal part points that way) and see whether the ground there is
// under the sea. One extra raycast, only in the sliver of ground where the
// cut-off is within reach at all, and only in a room that declares a shoreline.
// Swept over 144 bearings against the beach's own sandY(): a wet band on 138 of
// them, mean 0.48 units wide, hugging the water's edge - the whole band is
// inside the last 0.85 units of walkable sand, so there is no inland ring
// anywhere, including the dune hollows at r 8-8.5 that dip below the cut-off
// without being anywhere near the sea.
const WADE_REACH = 1.2;   // how far downhill the water may be and still count
const WADE_DEEP = 0.20;   // ...and how far under the cut-off it has to lie, so
                          // an inland hollow (which bottoms out 0.01 under it)
                          // is never mistaken for the sea

// Dust colour per room. Almost every walkable surface in the cove carries its
// colour in a canvas map or in vertex colours over a WHITE base material
// (beach sand, mine floor, peak snow, jungle floor, plaza cobble, both den
// plank floors, cafe and house planks), so reading material.color answers
// "white" on all of them and every puff in the game comes out the same flat
// grey. Where a floor material really is coloured (the plaza's grass) it is
// still used as-is; otherwise this table names the floor the room walks on,
// taken from that room's own palette or the base fill of its floor texture.
// sRGB hex, exactly as the room files write it.
const DUST_TINT = {
  plaza: 0xe7d7b4,    // cobbleTex stones
  beach: 0xf2dca6,    // texSand base
  cafe: 0xc08d5f,     // texPlanks base
  club: 0x3a2c58,     // PAL.floor
  house: 0xac7440,    // texPlanks base
  peak: 0xf4f9ff,     // PAL.snow
  mine: 0x54402c,     // PAL.floor
  jungle: 0x4a6b34,   // texFloor base
  lounge: 0x8f6339,   // texPlanks base
  loft: 0x8f6339,     // texPlanks base
  speedway: 0xf0dca0, // PAL.sand
};
// A base material this close to pure white is a texture/vertex-colour carrier,
// not a colour. Channels are linear, so this is 0xffffff and nothing else.
const BASE_WHITE = 0.985;
const _tint = new THREE.Color();

/** Click-to-move controller. Owns target-seeking, obstacle slide and ground
 *  height snapping for one avatar. Used by the local player (engine feeds it
 *  click targets) and reusable by anything that walks.
 *
 *  It is also the only thing in the game that knows what is under a walker's
 *  paws, so it feeds that to the avatar for its footfall fx (see _terrain).
 *  Callers that are not avatars (the editor's route check passes a bare stub)
 *  simply do not get asked. */
export class WalkController {
  constructor(avatar) {
    this.avatar = avatar;
    this.target = null;
    this.speed = WALK_SPEED;
    this.ray = new THREE.Raycaster();
    this.moving = false;
    this.ground = null;    // last surface snapToGround landed on
    this.groundY = 0;
    this.groundN = null;   // its face normal, in the ground object's own space
    this.groundX = 0;      // ...and where on it the paws landed
    this.groundZ = 0;
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
    this.ground = best.object;   // what the paws are actually on, for footfall fx
    this.groundY = best.point.y;
    this.groundN = best.face?.normal || null;  // object space; three already made it
    this.groundX = pos.x;
    this.groundZ = pos.z;
    return true;
  }

  /** Tell the avatar what it is standing on, so its footfalls belong to the
   *  room: the puff takes the colour of the surface underfoot, and a room that
   *  declares a shoreline (minWalkY) rings the water instead of raising dust
   *  once the paws are down in the wet band.
   *
   *  Both are edge-triggered - the ground read and the avatar call only happen
   *  when the surface or the wade state actually changes - so a walk across
   *  one floor costs one comparison a frame plus the wade test, and the wade
   *  test costs one comparison in every room that declares no shoreline. */
  _terrain(room) {
    const av = this.avatar;
    if (!av?.setGroundTint) return;   // stub walkers (the editor's route check)
    if (room !== this._terrainRoom) {
      this._terrainRoom = room;
      this._lastGround = null;
      this._wading = null;
    }
    if (this.ground !== this._lastGround) {
      this._lastGround = this.ground;
      const m = this.ground?.material;
      const c = (Array.isArray(m) ? m[0] : m)?.color;
      if (c && !(c.r > BASE_WHITE && c.g > BASE_WHITE && c.b > BASE_WHITE)) av.setGroundTint(c);
      else {
        // player dens are 'house:<owner>' and all share the den plank floor
        const hex = DUST_TINT[String(room.id ?? '').split(':')[0]];
        if (hex !== undefined) av.setGroundTint(_tint.setHex(hex));
      }
    }
    this._setWading(room, this._wadeTest(room));
  }

  /** Is the water within one pace of the paws? See the note at the top of the
   *  file for why this asks the ground rather than the height or the tilt. */
  _wadeTest(room) {
    if (room.minWalkY === undefined || !this.groundN || !this.ground) return false;
    // face normals come out of the raycast in object space, so they have to be
    // turned into the world before they mean anything
    _n.copy(this.groundN).transformDirection(this.ground.matrixWorld);
    const h = Math.hypot(_n.x, _n.z);
    if (h < 1e-3) return false;  // dead flat: no downhill, so no shore here
    // the normal's horizontal part points DOWNHILL. If the footing cut-off is
    // further down than one pace of fall, the water is out of reach and the
    // raycast below is not worth taking: this is the hot-path guard, and it is
    // false for all but a sliver of the sand.
    const slope = h / Math.max(1e-3, Math.abs(_n.y));
    if (this.groundY - room.minWalkY > slope * WADE_REACH) return false;
    this.ray.set(
      _probe.set(
        this.groundX + (_n.x / h) * WADE_REACH,
        this.groundY + 40,
        this.groundZ + (_n.z / h) * WADE_REACH,
      ),
      DOWN,
    );
    const hits = this.ray.intersectObjects(room.groundMeshes, false);
    if (!hits.length) return true; // off the edge of the world: open water
    let top = hits[0];
    for (const p of hits) if (p.point.y > top.point.y) top = p;
    return top.point.y < room.minWalkY - WADE_DEEP;
  }

  _setWading(room, wade) {
    if (wade === this._wading) return;
    this._wading = wade;
    this.avatar.setWading(wade);
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
          this._terrain(room);
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
