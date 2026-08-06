import * as THREE from 'three';

/**
 * Base class for every location. Subclasses live in src/world/rooms/<id>.js and
 * are registered in src/world/index.js.
 *
 * Contract (see CONTRACT.md at repo root):
 *  - build(scene, game): add ALL meshes + lights to `scene`. Must set:
 *      this.groundMeshes = [meshes]   // walkable surfaces; clicks + foot height raycast these
 *      this.spawnPoints = { default: THREE.Vector3, from_<roomId>: ... }
 *    Optionally:
 *      this.hotspots = [{ id, position: V3, radius, label, action(game) }]
 *      this.obstacles = [{ x, z, r }]  // circle colliders the player slides around
 *      this.cameraHint = { offset: THREE.Vector3, lookHeight: number }
 *  - update(dt, game): per-frame animation (water, particles, props).
 *  - dispose(): free anything build() created OUTSIDE the scene graph
 *    (the engine auto-disposes everything added to the scene).
 *  - Floor height can vary (ramps/hills): the player raycasts down onto
 *    groundMeshes each frame, so shape ground geometry accordingly.
 *  - No import-time side effects. No DOM access at import time. No external
 *    assets: geometry, canvas textures and code only.
 */
export class Room {
  id = 'room';
  name = 'Room';

  constructor() {
    this.groundMeshes = [];
    this.spawnPoints = { default: new THREE.Vector3(0, 0, 0) };
    this.hotspots = [];
    this.obstacles = [];
    this.cameraHint = null;
  }

  build(_scene, _game) {}
  update(_dt, _game) {}
  dispose() {}

  getSpawn(fromRoomId) {
    return (fromRoomId && this.spawnPoints[`from_${fromRoomId}`]) || this.spawnPoints.default;
  }
}
