import * as THREE from 'three';
import { makeToon, makeGlow } from '../core/materials.js';

// Procedural hat builders. Every id in shared/constants.js HATS must have a
// builder here. Each returns a THREE.Group positioned so y=0 sits on the head
// top (the avatar's hatAnchor). Keep hats under ~300 triangles.

const builders = {
  none: () => null,

  beanie: () => {
    const g = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), makeToon(0xe8657a));
    dome.scale.y = 0.9;
    g.add(dome);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.06, 8, 20), makeToon(0xc94b60));
    rim.rotation.x = Math.PI / 2;
    g.add(rim);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), makeToon(0xfff2d6));
    pom.position.y = 0.34;
    g.add(pom);
    return g;
  },

  cap: () => {
    const g = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), makeToon(0x4fb3e8));
    dome.scale.y = 0.75;
    g.add(dome);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.04, 16, 1, false, 0, Math.PI), makeToon(0x2f89b8));
    brim.rotation.y = -Math.PI / 2;
    brim.position.set(0, 0.02, 0.3);
    g.add(brim);
    return g;
  },

  flower: () => {
    const g = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.18, 6), makeToon(0x4a8f3c));
    stem.position.y = 0.09;
    g.add(stem);
    const heart = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), makeToon(0x8a5a2a));
    heart.position.y = 0.2;
    g.add(heart);
    for (let i = 0; i < 6; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), makeToon(0xf2d541));
      p.scale.set(1.4, 0.5, 1);
      const a = (i / 6) * Math.PI * 2;
      p.position.set(Math.cos(a) * 0.11, 0.2, Math.sin(a) * 0.11);
      p.rotation.y = -a;
      g.add(p);
    }
    return g;
  },

  tophat: () => {
    const g = new THREE.Group();
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 20), makeToon(0x2a2a33));
    g.add(brim);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.42, 20), makeToon(0x2a2a33));
    tube.position.y = 0.23;
    g.add(tube);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.285, 0.29, 0.08, 20), makeToon(0xc94b60));
    band.position.y = 0.08;
    g.add(band);
    return g;
  },

  viking: () => {
    const g = new THREE.Group();
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), makeToon(0x8d99ae));
    g.add(helm);
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 10), makeToon(0xfff2d6));
      horn.position.set(side * 0.34, 0.16, 0);
      horn.rotation.z = side * -0.7;
      g.add(horn);
    }
    return g;
  },

  crown: () => {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.16, 8, 1, true), makeToon(0xf2c744));
    ring.position.y = 0.08;
    g.add(ring);
    for (let i = 0; i < 8; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 4), makeToon(0xf2c744));
      const a = (i / 8) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.28, 0.22, Math.sin(a) * 0.28);
      g.add(spike);
    }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), makeGlow(0xe8657a));
    gem.position.set(0, 0.12, 0.29);
    g.add(gem);
    return g;
  },

  propeller: () => {
    const g = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), makeToon(0xf2a541));
    dome.scale.y = 0.7;
    g.add(dome);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 6), makeToon(0x8d99ae));
    pole.position.y = 0.3;
    g.add(pole);
    const prop = new THREE.Group();
    prop.name = 'spin'; // avatar-side animation hook: spins any child named 'spin'
    prop.position.y = 0.38;
    for (const side of [-1, 1]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.08), makeToon(side < 0 ? 0x4fb3e8 : 0xe8657a));
      blade.position.x = side * 0.16;
      prop.add(blade);
    }
    g.add(prop);
    return g;
  },

  chef: () => {
    const g = new THREE.Group();
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 18), makeToon(0xffffff));
    band.position.y = 0.06;
    g.add(band);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10), makeToon(0xffffff));
    puff.scale.set(1, 0.75, 1);
    puff.position.y = 0.3;
    g.add(puff);
    return g;
  },

  pirate: () => {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), makeToon(0x2a2a33));
    base.scale.y = 0.6;
    g.add(base);
    for (const side of [-1, 1]) {
      const flap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.16, 0.05), makeToon(0x2a2a33));
      flap.position.set(0, 0.1, side * 0.26);
      flap.rotation.x = side * -0.25;
      g.add(flap);
    }
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), makeToon(0xffffff));
    skull.position.set(0, 0.12, 0.31);
    g.add(skull);
    return g;
  },
};

export function buildHat(id) {
  // own-property only: builders['__proto__'] is Object.prototype (truthy, not
  // callable) and builders['constructor'] returns a plain object, either of
  // which would throw inside createAvatar and blank out the whole room.
  const fn = Object.prototype.hasOwnProperty.call(builders, id) ? builders[id] : builders.none;
  const h = typeof fn === 'function' ? fn() : null;
  return h?.isObject3D ? h : null;
}

/** Register extra hats at runtime (shop agent may extend). */
export function registerHat(id, builderFn) {
  if (typeof id !== 'string' || typeof builderFn !== 'function') return;
  Object.defineProperty(builders, id, { value: builderFn, writable: true, enumerable: true, configurable: true });
}
