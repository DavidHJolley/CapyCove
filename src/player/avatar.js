import * as THREE from 'three';
import { makeToon } from '../core/materials.js';
import { buildHat } from './hats.js';

// Chibi capybara avatar. Face points +Z. Feet at y=0, total height ~1.8.
// Used for the local player, remote players, server bots and the shop preview,
// so keep this file self-contained and cheap (no lights, no shadows config here).

const EYE_MAT = () => makeToon(0x241a12);
const NOSE_MAT = () => makeToon(0x3a2a1c);

function lighten(hex, amt = 0.25) {
  const c = new THREE.Color(hex);
  return c.lerp(new THREE.Color(0xfff2d6), amt).getHex();
}

export function createAvatar({ color = 0xb08a5a, hat = 'none' } = {}) {
  const group = new THREE.Group();
  const body = new THREE.Group(); // animated (bob/rock); root stays at ground level
  group.add(body);

  let bodyMat = makeToon(color);
  let bellyMat = makeToon(lighten(color));

  // torso: squat egg
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.52, 20, 16), bodyMat);
  torso.scale.set(1, 1.12, 0.88);
  torso.position.y = 0.62;
  torso.castShadow = true;
  body.add(torso);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), bellyMat);
  belly.scale.set(0.85, 1, 0.6);
  belly.position.set(0, 0.58, 0.18);
  body.add(belly);

  // head: capybara boxy muzzle
  const headG = new THREE.Group();
  headG.position.set(0, 1.28, 0.05);
  body.add(headG);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 16), bodyMat);
  skull.scale.set(1, 0.92, 0.95);
  skull.castShadow = true;
  headG.add(skull);

  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.34), bodyMat);
  muzzle.position.set(0, -0.08, 0.32);
  headG.add(muzzle);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.06), NOSE_MAT());
  nose.position.set(0, 0.02, 0.5);
  headG.add(nose);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), EYE_MAT());
    eye.position.set(side * 0.21, 0.12, 0.36);
    headG.add(eye);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), bodyMat);
    ear.scale.set(1, 0.8, 0.5);
    ear.position.set(side * 0.26, 0.36, -0.02);
    ear.name = 'ear';
    headG.add(ear);
  }

  // stub arms + legs
  const limbs = { arms: [], legs: [] };
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.22, 4, 8), bodyMat);
    arm.position.set(side * 0.5, 0.72, 0.05);
    arm.rotation.z = side * 0.5;
    body.add(arm);
    limbs.arms.push(arm);

    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.14, 4, 8), bodyMat);
    leg.position.set(side * 0.22, 0.14, 0);
    body.add(leg);
    limbs.legs.push(leg);
  }

  // tail nub
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), bodyMat);
  tail.position.set(0, 0.5, -0.44);
  body.add(tail);

  // blob shadow (cheap, works without shadow maps)
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  group.add(blob);

  const hatAnchor = new THREE.Group();
  hatAnchor.position.set(0, 0.36, 0);
  headG.add(hatAnchor);

  const state = { anim: 'idle', hat: 'none', color, t: Math.random() * 10, waveT: -1 };

  function setHat(id) {
    state.hat = id;
    hatAnchor.clear();
    const h = buildHat(id);
    if (h) hatAnchor.add(h);
    state.spinner = h?.getObjectByName('spin') || null;
  }
  setHat(hat);

  function setColor(hex) {
    state.color = hex;
    bodyMat = makeToon(hex);
    bellyMat = makeToon(lighten(hex));
    for (const m of [torso, skull, muzzle, tail, ...limbs.arms, ...limbs.legs]) m.material = bodyMat;
    headG.children.forEach((c) => { if (c.name === 'ear') c.material = bodyMat; });
    belly.material = bellyMat;
  }

  function setAnim(anim) {
    if (state.anim !== anim) state.anim = anim;
  }

  function playWave() { state.waveT = 0; }

  function update(dt) {
    state.t += dt;
    const t = state.t;
    body.rotation.set(0, 0, 0);
    body.position.y = 0;
    body.scale.setScalar(1);

    if (state.anim === 'walk') {
      body.position.y = Math.abs(Math.sin(t * 9)) * 0.09;
      body.rotation.z = Math.sin(t * 9) * 0.07; // waddle
      limbs.legs[0].position.z = Math.sin(t * 9) * 0.12;
      limbs.legs[1].position.z = -Math.sin(t * 9) * 0.12;
      limbs.arms[0].rotation.x = Math.sin(t * 9) * 0.5;
      limbs.arms[1].rotation.x = -Math.sin(t * 9) * 0.5;
    } else if (state.anim === 'dance') {
      body.position.y = Math.abs(Math.sin(t * 7)) * 0.16;
      body.rotation.y = Math.sin(t * 3.5) * 0.45;
      limbs.arms[0].rotation.z = -0.5 + Math.sin(t * 7) * 0.9;
      limbs.arms[1].rotation.z = 0.5 - Math.sin(t * 7 + 1) * 0.9;
      headG.rotation.z = Math.sin(t * 7) * 0.12;
    } else {
      // idle: breathe + occasional ear twitch
      body.scale.y = 1 + Math.sin(t * 2.2) * 0.012;
      limbs.legs[0].position.z = 0;
      limbs.legs[1].position.z = 0;
      limbs.arms[0].rotation.x = 0;
      limbs.arms[1].rotation.x = 0;
      headG.rotation.z = 0;
      const twitch = Math.sin(t * 0.7) > 0.995 ? Math.sin(t * 40) * 0.2 : 0;
      headG.children.forEach((c) => { if (c.name === 'ear') c.rotation.z = twitch; });
    }

    if (state.spinner) state.spinner.rotation.y += dt * 9;

    if (state.waveT >= 0) {
      state.waveT += dt;
      const a = limbs.arms[1];
      a.rotation.z = 2.4 + Math.sin(state.waveT * 14) * 0.4;
      if (state.waveT > 1.4) { state.waveT = -1; a.rotation.z = 0.5; }
    }
  }

  function dispose() {
    // geometries are unique per avatar; materials are shared via makeToon cache
    group.traverse((o) => o.geometry?.dispose?.());
  }

  return { group, body, headG, hatAnchor, state, setHat, setColor, setAnim, playWave, update, dispose };
}
