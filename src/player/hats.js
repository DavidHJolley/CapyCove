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

  // ---- milestone cosmetics (wave 7, docs/LIVING-COVE.md section D) ----------
  // Not sold anywhere: the stamp album hands these over at 5 and 30 stamps, so
  // the whole point is that they read as earned at a glance from the 3/4 camera.

  /** Snorkel: mask pushed up onto the forehead, tube arcing over one ear. ~250 tris */
  snorkel: () => {
    const g = new THREE.Group();
    // the strap, tipped forward so the mask sits where a pushed-up mask sits
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.045, 8, 20), makeToon(0xe8657a));
    strap.rotation.x = Math.PI / 2 - 0.34;
    strap.position.y = 0.03;
    g.add(strap);
    // mask frame + lens, riding the front of the strap
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.1), makeToon(0x2f89b8));
    frame.position.set(0, 0.11, 0.24);
    frame.rotation.x = -0.34;
    g.add(frame);
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.04), makeGlow(0xdff3fb));
    lens.position.set(0, 0.13, 0.3);
    lens.rotation.x = -0.34;
    g.add(lens);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.09), makeToon(0x2f89b8));
    nose.position.set(0, 0.02, 0.28);
    g.add(nose);
    // the tube: three short segments doing the classic J bend up the left side
    const tube = makeToon(0xf2b64a);
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 8), tube);
    lower.position.set(-0.29, 0.1, 0.06);
    lower.rotation.z = 0.18;
    g.add(lower);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.24, 8), tube);
    upper.position.set(-0.35, 0.33, 0.03);
    upper.rotation.z = 0.1;
    g.add(upper);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.13), makeToon(0x4fb3e8));
    mouth.position.set(-0.26, 0.0, 0.16);
    g.add(mouth);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), makeGlow(0x42d6c8));
    tip.position.set(-0.37, 0.46, 0.02);
    g.add(tip);
    return g;
  },

  /** Golden pickaxe strapped across the crown, gem winking on the haft. ~280 tris */
  golden_pick: () => {
    const g = new THREE.Group();
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.05, 8, 20), makeToon(0x6b4f35));
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.02;
    g.add(band);
    // haft lying across the head, pointing forward-left so it reads in silhouette
    const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.72, 8), makeToon(0x8a6642));
    haft.rotation.set(Math.PI / 2, 0, 0.42);
    haft.position.set(0.02, 0.16, 0.02);
    g.add(haft);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 8), makeToon(0x4a3524));
    grip.rotation.set(Math.PI / 2, 0, 0.42);
    grip.position.set(0.14, 0.16, -0.26);
    g.add(grip);
    // the head: a boss with two tapered picks, one blunt one sharp
    const gold = makeToon(0xf2c744);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.14, 8), gold);
    boss.rotation.set(Math.PI / 2, 0, 0.42);
    boss.position.set(-0.12, 0.16, 0.32);
    g.add(boss);
    for (const side of [-1, 1]) {
      const pick = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.34, 6), gold);
      pick.position.set(-0.12 + side * 0.16, 0.16 + side * 0.04, 0.32);
      pick.rotation.z = Math.PI / 2 - side * 0.25;
      pick.rotation.y = side < 0 ? Math.PI : 0;
      g.add(pick);
    }
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), makeGlow(0x42d6c8));
    gem.position.set(-0.05, 0.24, 0.16);
    g.add(gem);
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
