import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Groove Grotto build.
export class ClubRoom extends Room {
  id = 'club';
  name = 'Groove Grotto';

  build(scene, game) {
    scene.background = new THREE.Color(0x14101e);
    scene.add(new THREE.AmbientLight(0x8060c0, 0.5));
    const spot = new THREE.PointLight(0xff60c0, 80, 50);
    spot.position.set(0, 8, 0);
    scene.add(spot);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), makeToon(0x3a3050));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    const tile = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), makeGlow(0xe860c0));
    tile.rotation.x = -Math.PI / 2;
    tile.position.y = 0.01;
    scene.add(tile);

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 6), from_plaza: new THREE.Vector3(0, 0, 7) };

    this.hotspots.push({
      id: 'exit-plaza', position: new THREE.Vector3(0, 0, 8), radius: 3,
      label: 'Back to Sunny Plaza', action: (g) => g.goToRoom('plaza', 'club'),
    });
  }
}
