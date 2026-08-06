import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Driftwood Beach build.
export class BeachRoom extends Room {
  id = 'beach';
  name = 'Driftwood Beach';

  build(scene, game) {
    scene.background = new THREE.Color(0x87ceeb);
    scene.add(new THREE.HemisphereLight(0xfff5e0, 0xd2b48c, 1.2));
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.4);
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(15, 40), makeToon(0xf0dca0));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 4), from_plaza: new THREE.Vector3(10, 0, 2) };

    this.hotspots.push(
      {
        id: 'exit-plaza', position: new THREE.Vector3(12, 0, 2), radius: 3,
        label: 'Back to Sunny Plaza', action: (g) => g.goToRoom('plaza', 'beach'),
      },
      {
        id: 'play-fishing', position: new THREE.Vector3(-8, 0, -6), radius: 3,
        label: 'Play Reel Rush', action: (g) => g.startMinigame('fishing'),
      },
    );
    const rod = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8), makeToon(0x4fb3e8));
    rod.position.set(-8, 0.5, -6);
    scene.add(rod);
  }
}
