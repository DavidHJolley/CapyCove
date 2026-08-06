import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Smoothie Shack interior.
export class CafeRoom extends Room {
  id = 'cafe';
  name = 'The Smoothie Shack';

  build(scene, game) {
    scene.background = new THREE.Color(0x3a2f28);
    scene.add(new THREE.HemisphereLight(0xffe0b0, 0x5a4a3a, 1.0));
    const lamp = new THREE.PointLight(0xffc880, 60, 40);
    lamp.position.set(0, 6, 0);
    scene.add(lamp);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), makeToon(0xa07850));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 5), from_plaza: new THREE.Vector3(0, 0, 6) };

    this.hotspots.push(
      {
        id: 'exit-plaza', position: new THREE.Vector3(0, 0, 7), radius: 3,
        label: 'Back to Sunny Plaza', action: (g) => g.goToRoom('plaza', 'cafe'),
      },
      {
        id: 'play-smoothie', position: new THREE.Vector3(0, 0, -5), radius: 3,
        label: 'Play Smoothie Scramble', action: (g) => g.startMinigame('smoothie'),
      },
    );
    const blender = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8), makeToon(0x7ac74f));
    blender.position.set(0, 0.5, -5);
    scene.add(blender);
  }
}
