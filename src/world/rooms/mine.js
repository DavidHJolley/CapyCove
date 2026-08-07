import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Glimmer Mine build (wave 6,
// docs/PARTY-GAMES.md). Boots, lights, and exits so the map link works.
export class MineRoom extends Room {
  id = 'mine';
  name = 'The Glimmer Mine';

  build(scene, game) {
    scene.background = new THREE.Color(0x1a140e);
    scene.add(new THREE.AmbientLight(0x6a5238, 0.7));
    const lantern = new THREE.PointLight(0xffb060, 50, 30);
    lantern.position.set(0, 5, 0);
    scene.add(lantern);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 36), makeToon(0x4a3a28));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    const seam = new THREE.Mesh(new THREE.OctahedronGeometry(0.6), makeGlow(0xf2b64a));
    seam.position.set(-4, 0.6, -4);
    scene.add(seam);

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 4), from_peak: new THREE.Vector3(0, 0, 6) };
    this.hotspots.push({
      id: 'exit-peak', position: new THREE.Vector3(0, 0, 8), radius: 2.6,
      label: 'Ride the lift up to Frosty Peak', action: (g) => g.goToRoom('peak', 'mine'),
    });
    this.staticCamera = {
      position: new THREE.Vector3(0, 14, 18),
      lookAt: new THREE.Vector3(0, 0.5, -1),
    };
  }
}
