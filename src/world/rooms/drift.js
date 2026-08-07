import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon } from '../../core/materials.js';

// PLACEHOLDER: to be replaced with the full Drift build (wave 7,
// docs/LIVING-COVE.md section C). Boots and exits so the dive bell works.
// NOTE: the real room has NO groundMeshes (swimming); this placeholder keeps
// a floor so the walker functions until the swim controller lands.
export class DriftRoom extends Room {
  id = 'drift';
  name = 'The Drift';

  build(scene, game) {
    scene.background = new THREE.Color(0x0d3a52);
    scene.fog = new THREE.FogExp2(0x0d3a52, 0.03);
    scene.add(new THREE.HemisphereLight(0x7ec8e8, 0x062030, 0.9));

    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 36), makeToon(0x1a4a62));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    this.groundMeshes = [ground];

    this.spawnPoints = { default: new THREE.Vector3(0, 0, 4), from_beach: new THREE.Vector3(0, 0, 5) };
    this.hotspots.push({
      id: 'exit-beach', position: new THREE.Vector3(0, 0, 7), radius: 2.6,
      label: 'Ride the dive bell up', action: (g) => g.goToRoom('beach', 'drift'),
    });
    this.staticCamera = {
      position: new THREE.Vector3(0, 14, 18),
      lookAt: new THREE.Vector3(0, 1, -1),
    };
  }
}
