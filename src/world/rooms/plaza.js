import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Sunny Plaza build.
export class PlazaRoom extends Room {
  id = 'plaza';
  name = 'Sunny Plaza';

  build(scene, game) {
    scene.background = new THREE.Color(0x9ad6f0);
    scene.add(new THREE.HemisphereLight(0xfff5e0, 0x8a7a5a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.6);
    sun.position.set(10, 20, 8);
    sun.castShadow = true;
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(16, 40), makeToon(0x9ec86a));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];

    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4),
      from_beach: new THREE.Vector3(-12, 0, 2),
      from_peak: new THREE.Vector3(0, 0, -12),
      from_cafe: new THREE.Vector3(12, 0, 2),
      from_club: new THREE.Vector3(8, 0, 10),
    };

    const exits = [
      ['beach', -13, 0, 'Driftwood Beach'],
      ['peak', 0, -13, 'Frosty Peak'],
      ['cafe', 13, 0, 'The Smoothie Shack'],
      ['club', 9, 11, 'Groove Grotto'],
    ];
    for (const [to, x, z, label] of exits) {
      const marker = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 8), makeToon(0xe8657a));
      marker.position.set(x, 0.5, z);
      scene.add(marker);
      this.hotspots.push({
        id: `exit-${to}`,
        position: new THREE.Vector3(x, 0, z),
        radius: 3,
        label: `Go to ${label}`,
        action: (g) => g.goToRoom(to, 'plaza'),
      });
    }
  }
}
