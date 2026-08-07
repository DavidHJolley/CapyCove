import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Tangle Jungle build (wave 6,
// docs/PARTY-GAMES.md). Boots, lights, and exits so the map link works.
export class JungleRoom extends Room {
  id = 'jungle';
  name = 'The Tangle Jungle';

  build(scene, game) {
    scene.background = new THREE.Color(0x2e4a2a);
    scene.add(new THREE.HemisphereLight(0xcfe8b0, 0x2a3a20, 1.1));
    const sun = new THREE.DirectionalLight(0xf2ffd0, 1.0);
    sun.position.set(6, 16, 6);
    sun.castShadow = true;
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(13, 36), makeToon(0x5a7a3a));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 4), from_beach: new THREE.Vector3(0, 0, 6) };
    this.hotspots.push({
      id: 'exit-beach', position: new THREE.Vector3(0, 0, 8), radius: 2.6,
      label: 'Back to Driftwood Beach', action: (g) => g.goToRoom('beach', 'jungle'),
    });
    this.staticCamera = {
      position: new THREE.Vector3(0, 15, 19),
      lookAt: new THREE.Vector3(0, 0.5, -1),
    };
  }
}
