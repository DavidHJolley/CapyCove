import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Frosty Peak build.
export class PeakRoom extends Room {
  id = 'peak';
  name = 'Frosty Peak';

  build(scene, game) {
    scene.background = new THREE.Color(0xc8dcf0);
    scene.add(new THREE.HemisphereLight(0xeef5ff, 0x8a9ab0, 1.2));
    const sun = new THREE.DirectionalLight(0xfff8e8, 1.3);
    sun.position.set(6, 20, 6);
    sun.castShadow = true;
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(15, 40), makeToon(0xf4f8ff));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 4), from_plaza: new THREE.Vector3(0, 0, 10) };

    this.hotspots.push(
      {
        id: 'exit-plaza', position: new THREE.Vector3(0, 0, 12), radius: 3,
        label: 'Back to Sunny Plaza', action: (g) => g.goToRoom('plaza', 'peak'),
      },
      {
        id: 'play-sled', position: new THREE.Vector3(0, 0, -9), radius: 3,
        label: 'Play Summit Sprint', action: (g) => g.startMinigame('sled'),
      },
    );
    const gate = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8), makeToon(0xe8657a));
    gate.position.set(0, 0.5, -9);
    scene.add(gate);
  }
}
