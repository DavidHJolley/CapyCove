import * as THREE from 'three';
import { makeToon } from '../core/materials.js';
import { buildHat } from './hats.js';

// Chibi capybara avatar. Face points +Z. Feet at y=0, total height ~1.72 (the
// old model measured 1.71, so seats, name tags and sled rigs still line up).
// Anim states: idle | walk | dance | sit | swim | ride (+ playWave() on top of
// any of them). 'swim'/'ride' belong to The Drift; everything on the wire is
// still one of idle/walk/dance/sit (see src/world/rooms/drift.js).
// Used for the local player, remote players, server bots, den/chairlift seats,
// race riders and the shop/profile turntables, so keep this file self-contained
// and cheap (no lights, no shadows config here).
//
// PERF SHAPE OF THIS FILE (read before editing):
//  1. Body geometry is identical for every capybara in the world, so it is built
//     once at module level and shared: a room with 10 occupants used to allocate
//     150 BufferGeometries (~800KB of vertex data) and upload each as its own GPU
//     buffer. Built lazily on the first createAvatar call, never at import time
//     (see CONTRACT.md). Anything marked geometry.userData.shared is skipped by
//     every dispose path.
//  2. Detail is merged, not added. Every extra bead, patch and paw is baked into
//     one of the shared geometries, so the whole capy is 16 meshes / 16 draw
//     calls (the old plainer model was 15) and ~3.4k triangles with ~15 remotes
//     on screen.
//  3. Two-tone fur runs on ONE material: each fur geometry carries a baked
//     'color' attribute used as a tint multiplier (1 = body colour, ~2 = cream
//     belly/muzzle/paw tips, <1 = soft shading). Accents therefore track any
//     body colour for free, and adding a second material (a second draw call per
//     limb) was never needed.

const HEAD_Y = 1.24;   // head pivot height; hats, blink and sway all hang off it
const HEAD_Z = 0.02;
const EYE_Y = 0.10;    // eye mesh pivot (geometry is built around y=0 so the
                       // blink scale squashes each eye about its own centre)
const ARM_Y = 0.87;
const ARM_X = 0.455;
const ARM_SPLAY = 0.22;
const LEG_X = 0.235;
const LEG_Y = 0.225;
const LEG_Z = 0.015;
const EAR_X = 0.305;
const EAR_Y = 0.325;
const EAR_Z = -0.03;
const EAR_TILT = 0.2;
const BLINK_DUR = 0.15;
const WAVE_DUR = 1.6;
const PULSE_DUR = 0.34;  // squash-and-stretch on animation changes

// Per-vertex tint multipliers (see note 3 above).
const FUR = [1, 1, 1];
const CREAM = [2.45, 2.28, 1.98];
const SOFT = [1.45, 1.38, 1.28];

// Head/muzzle are ellipsoids; face details are placed ON their front surface so
// a proportion tweak here moves the whole face instead of leaving beads floating.
const SKULL = { c: [0, 0, 0], r: [0.47, 0.437, 0.442] };
const MUZZLE = { c: [0, -0.13, 0.28], r: [0.345, 0.185, 0.235] };
function frontZ(e, x, y, out = 0) {
  const dx = (x - e.c[0]) / e.r[0];
  const dy = (y - e.c[1]) / e.r[1];
  const k = Math.max(0, 1 - dx * dx - dy * dy);
  return e.c[2] + e.r[2] * Math.sqrt(k) + out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** One piece of a merged part: geometry + placement + per-vertex tint. */
function piece(g, tint, pos, scale, rot) {
  return { g, tint, pos, scale, rot };
}

/** Merge pieces into one indexed geometry with a baked tint attribute. */
function merge(parts) {
  let vTotal = 0;
  let iTotal = 0;
  const prep = [];
  for (const p of parts) {
    const g = p.g.clone();
    const sc = p.scale;
    _s.set(
      typeof sc === 'number' ? sc : sc[0],
      typeof sc === 'number' ? sc : sc[1],
      typeof sc === 'number' ? sc : sc[2],
    );
    _e.set(p.rot?.[0] || 0, p.rot?.[1] || 0, p.rot?.[2] || 0);
    _m.compose(_v.set(p.pos?.[0] || 0, p.pos?.[1] || 0, p.pos?.[2] || 0), _q.setFromEuler(_e), _s);
    g.applyMatrix4(_m); // three fixes the normals with the normal matrix
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    prep.push([g, p.tint || FUR]);
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const [g, tint] of prep) {
    const P = g.attributes.position;
    pos.set(P.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    for (let i = 0; i < P.count; i++) {
      col[(vo + i) * 3] = tint[0];
      col[(vo + i) * 3 + 1] = tint[1];
      col[(vo + i) * 3 + 2] = tint[2];
    }
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo;
      io += a.length;
    } else {
      for (let i = 0; i < P.count; i++) idx[io + i] = vo + i;
      io += P.count;
    }
    vo += P.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.userData.shared = true;
  return out;
}

let GEO = null;
let BLOB_MAT = null;
let INK_MAT = null;
let PINK_MAT = null;
let SHINE_MAT = null;
function geo() {
  if (GEO) return GEO;
  const sph = (w, h) => new THREE.SphereGeometry(1, w, h);
  const S16 = sph(16, 12);
  const S12 = sph(12, 9);
  const S8 = sph(8, 6);
  const S6 = sph(6, 5);
  const S4 = sph(4, 3);
  const ARM_CAP = new THREE.CapsuleGeometry(0.105, 0.17, 2, 8);
  const LEG_CAP = new THREE.CapsuleGeometry(0.115, 0.06, 2, 8);
  const SMILE = new THREE.TorusGeometry(0.042, 0.011, 3, 8, Math.PI);

  // eyes sit on the skull, but their geometry is built around y=0 so scale.y
  // blinks each eye about its own centre instead of sliding it down the face
  const eyeZ = frontZ(SKULL, 0.205, EYE_Y) - 0.035;
  const eyes = [];
  const shine = [];
  // ink/pink/shine parts keep a neutral tint: their materials are flat colours,
  // not the tinted fur material
  for (const side of [-1, 1]) {
    eyes.push(piece(S12, FUR, [side * 0.205, 0, eyeZ], [0.105, 0.113, 0.092]));
    shine.push(piece(S6, FUR, [side * 0.235, 0.042, eyeZ + 0.055], 0.036));
    shine.push(piece(S4, FUR, [side * 0.178, -0.038, eyeZ + 0.05], 0.021));
  }

  const face = [
    piece(S8, FUR, [0, -0.05, frontZ(MUZZLE, 0, -0.05) - 0.025], [0.105, 0.062, 0.078]),
  ];
  for (const side of [-1, 1]) {
    // half-smile arc per side: together they read as a soft capy grin
    face.push(piece(SMILE, FUR, [side * 0.043, -0.163, frontZ(MUZZLE, side * 0.043, -0.163) - 0.004], 1, [0.25, 0, Math.PI]));
    for (const [wx, wy] of [[0.16, -0.03], [0.19, -0.075]]) {
      face.push(piece(S4, FUR, [side * wx, wy, frontZ(MUZZLE, side * wx, wy) - 0.002], 0.013));
    }
  }

  GEO = {
    // torso egg + heavy pear bottom + one big round cream tummy
    body: merge([
      piece(S16, FUR, [0, 0.62, 0], [0.52, 0.55, 0.46]),
      piece(S12, FUR, [0, 0.34, -0.02], [0.46, 0.34, 0.42]),
      piece(S16, CREAM, [0, 0.5, 0.13], [0.42, 0.46, 0.35]),
    ]),
    head: merge([
      piece(S16, FUR, [0, 0, 0], SKULL.r),
      piece(S12, CREAM, MUZZLE.c, MUZZLE.r),
      piece(S8, CREAM, [0, -0.245, 0.2], [0.185, 0.1, 0.14]),   // chin
      piece(S8, CREAM, [-0.26, -0.115, 0.2], [0.15, 0.13, 0.12]), // cheek pads widen
      piece(S8, CREAM, [0.26, -0.115, 0.2], [0.15, 0.13, 0.12]),  // the muzzle
      piece(S8, SOFT, [0, 0.28, 0.24], [0.26, 0.12, 0.16]),     // brow highlight
    ]),
    ear: merge([piece(S8, FUR, [0, 0.03, 0], [0.135, 0.128, 0.075])]),
    earIn: merge([piece(S6, FUR, [0, -0.01, 0.045], [0.088, 0.086, 0.05])]),
    eyes: merge(eyes),
    shine: merge(shine),
    face: merge(face),
    blush: merge([-1, 1].map((side) => piece(S6, FUR,
      [side * 0.295, -0.025, frontZ(SKULL, side * 0.295, -0.025) - 0.05], [0.105, 0.08, 0.06]))),
    arm: merge([
      piece(ARM_CAP, FUR, [0, -0.16, 0], 1),
      piece(S8, CREAM, [0, -0.3, 0.025], [0.115, 0.1, 0.125]), // chunky paw
    ]),
    leg: merge([
      piece(LEG_CAP, FUR, [0, -0.055, 0], 1),
      piece(S8, CREAM, [0, -0.155, 0.045], [0.115, 0.072, 0.13]), // foot
    ]),
    tail: merge([piece(S8, FUR, [0, 0.03, -0.05], [0.085, 0.1, 0.09])]),
    blob: new THREE.CircleGeometry(0.48, 20),
  };
  GEO.blob.userData.shared = true;
  for (const g of [S16, S12, S8, S6, S4, ARM_CAP, LEG_CAP, SMILE]) g.dispose();

  BLOB_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false });
  BLOB_MAT.userData.shared = true;
  INK_MAT = makeToon(0x241a12);
  PINK_MAT = makeToon(0xf0959f);
  SHINE_MAT = makeToon(0xfffaf0);
  return GEO;
}

/** Fur material for a body colour. Cached by makeToon, shared between avatars. */
function furMat(hex) {
  return makeToon(hex, { vertexColors: true });
}

export function createAvatar({ color = 0xb08a5a, hat = 'none' } = {}) {
  const G = geo();
  const group = new THREE.Group();
  const body = new THREE.Group(); // animated (bob/rock); root stays at ground level
  group.add(body);

  let bodyMat = furMat(color);

  const torso = new THREE.Mesh(G.body, bodyMat);
  torso.castShadow = true;
  body.add(torso);

  const headG = new THREE.Group();
  headG.position.set(0, HEAD_Y, HEAD_Z);
  body.add(headG);

  const skull = new THREE.Mesh(G.head, bodyMat);
  skull.castShadow = true;
  headG.add(skull);

  // eyes blink by squashing; catchlights ride along as children so they squash too
  const eyes = new THREE.Mesh(G.eyes, INK_MAT);
  eyes.position.y = EYE_Y;
  headG.add(eyes);
  eyes.add(new THREE.Mesh(G.shine, SHINE_MAT));

  headG.add(new THREE.Mesh(G.face, INK_MAT));   // nose + grin + whisker dots
  headG.add(new THREE.Mesh(G.blush, PINK_MAT));

  const ears = [];
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(G.ear, bodyMat);
    ear.position.set(side * EAR_X, EAR_Y, EAR_Z);
    ear.rotation.z = -side * EAR_TILT;
    ear.name = 'ear';
    ear.add(new THREE.Mesh(G.earIn, PINK_MAT));
    headG.add(ear);
    ears.push(ear);
  }

  // stub arms + legs. Both pivot at the shoulder/hip (geometry hangs down from
  // the origin) so a rotation swings the limb instead of spinning it in place.
  const limbs = { arms: [], legs: [] };
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(G.arm, bodyMat);
    arm.position.set(side * ARM_X, ARM_Y, 0.03);
    arm.rotation.z = side * ARM_SPLAY;
    body.add(arm);
    limbs.arms.push(arm);

    const leg = new THREE.Mesh(G.leg, bodyMat);
    leg.position.set(side * LEG_X, LEG_Y, LEG_Z);
    body.add(leg);
    limbs.legs.push(leg);
  }

  const tail = new THREE.Mesh(G.tail, bodyMat);
  tail.position.set(0, 0.47, -0.42);
  body.add(tail);

  // blob shadow (cheap, works without shadow maps)
  const blob = new THREE.Mesh(G.blob, BLOB_MAT);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  group.add(blob);

  // hats are authored for the old smaller skull, so the anchor scales them to
  // the new head instead of every builder being re-tuned
  const hatAnchor = new THREE.Group();
  hatAnchor.position.set(0, 0.365, 0);
  hatAnchor.scale.setScalar(1.18);
  headG.add(hatAnchor);

  const fur = [torso, skull, tail, ...limbs.arms, ...limbs.legs, ...ears];

  const state = {
    anim: 'idle', hat: 'none', color, t: Math.random() * 10, waveT: -1,
    blinkIn: 1 + Math.random() * 4, blinkT: 0,
    twitchIn: 2 + Math.random() * 5, twitchT: 0, twitchEar: 0,
    stretchIn: 6 + Math.random() * 9, stretchT: 0,
    pulse: 0, spinner: null,
  };

  function setHat(id) {
    state.hat = id;
    hatAnchor.clear();
    const h = buildHat(id);
    if (h) hatAnchor.add(h);
    state.spinner = h?.getObjectByName?.('spin') || null;
  }
  setHat(hat);

  function setColor(hex) {
    state.color = hex;
    bodyMat = furMat(hex);
    for (const m of fur) m.material = bodyMat;
  }

  function setAnim(anim) {
    if (state.anim === anim) return;
    state.anim = anim;
    state.pulse = PULSE_DUR; // little squash so a state change reads as a beat
  }

  function playWave() {
    state.waveT = 0;
    state.pulse = Math.max(state.pulse, PULSE_DUR * 0.8);
  }

  function update(dt) {
    state.t += dt;
    const t = state.t;
    const arms = limbs.arms;
    const legs = limbs.legs;

    // rest pose first: every state paints onto a clean rig, so nothing leaks
    // between animations (the sit crouch used to strand legs mid-air)
    body.position.y = 0;
    body.rotation.set(0, 0, 0);
    body.scale.set(1, 1, 1);
    headG.position.set(0, HEAD_Y, HEAD_Z);
    headG.rotation.set(0, 0, 0);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      arms[i].rotation.set(0, 0, side * ARM_SPLAY);
      legs[i].rotation.set(0, 0, 0);
      legs[i].position.set(side * LEG_X, LEG_Y, LEG_Z);
      ears[i].rotation.set(0, 0, -side * EAR_TILT);
    }
    tail.rotation.set(0, 0, 0);

    // the blob shadow fakes ground contact, so it has nothing to land on in a
    // room with no floor: it would hang in the water column under a swimmer
    const afloat = state.anim === 'swim' || state.anim === 'ride';
    if (blob.visible === afloat) blob.visible = !afloat;

    if (state.anim === 'walk') {
      // springy waddle: bounce with a squash at each footfall, ears lag behind
      const p = t * 9.2;
      const s = Math.sin(p);
      const hop = Math.abs(s);
      body.position.y = hop * 0.105;
      body.scale.y = 1 - 0.025 + hop * 0.05;
      body.scale.x = body.scale.z = 1 + 0.018 - hop * 0.035;
      body.rotation.z = s * 0.075;
      body.rotation.x = 0.05;
      legs[0].rotation.x = s * 0.62;
      legs[1].rotation.x = -s * 0.62;
      arms[0].rotation.x = -s * 0.55;
      arms[1].rotation.x = s * 0.55;
      headG.rotation.x = -hop * 0.06;
      headG.position.y += hop * 0.012;
      const bob = -Math.sin(p - 0.9) * 0.26;
      ears[0].rotation.x = bob;
      ears[1].rotation.x = bob;
      tail.rotation.x = -0.2 + s * 0.2;
    } else if (state.anim === 'dance') {
      // two moves that swap every ~4s with a short crossfade: A = hip sway with
      // alternating paws, B = two-paw hop-and-spin
      const phase = t / 4.2;
      const seg = Math.floor(phase) % 2;
      const f = Math.min(1, (phase - Math.floor(phase)) / 0.18);
      const m = seg === 0 ? 1 - f : f;
      const n = 1 - m;

      const aB = Math.abs(Math.sin(t * 7));
      const aS = Math.sin(t * 7);
      const bH = Math.pow(Math.abs(Math.sin(t * 4.6)), 0.6);
      const bS = Math.sin(t * 4.6);

      body.position.y = aB * 0.16 * n + bH * 0.28 * m;
      body.rotation.y = Math.sin(t * 3.5) * 0.5 * n + Math.sin(t * 2.2) * 0.95 * m;
      body.rotation.z = aS * 0.07 * n + bS * 0.13 * m;
      body.scale.y = 1 + (0.05 * bH - 0.02) * m;
      arms[0].rotation.z = (-0.45 + aS * 0.9) * n + (-2.05 + Math.sin(t * 9.2) * 0.3) * m;
      arms[1].rotation.z = (0.45 - Math.sin(t * 7 + 1) * 0.9) * n + (2.05 - Math.sin(t * 9.2) * 0.3) * m;
      arms[0].rotation.x = -0.2 * m;
      arms[1].rotation.x = -0.2 * m;
      headG.rotation.z = aS * 0.13 * n + bS * 0.1 * m;
      headG.rotation.x = -0.06 * m;
      legs[0].rotation.x = Math.sin(t * 4.6) * 0.35 * m;
      legs[1].rotation.x = -Math.sin(t * 4.6) * 0.35 * m;
      ears[0].rotation.x = -0.25 * aB * n - 0.3 * bH * m;
      ears[1].rotation.x = ears[0].rotation.x;
      tail.rotation.z = aS * 0.3 * n + bS * 0.4 * m;
    } else if (state.anim === 'swim' || state.anim === 'ride') {
      // The Drift (docs/LIVING-COVE.md C). Both states tip the WHOLE body onto
      // its front: local +Y becomes world forward and local +Z becomes world
      // down, so the rig's existing fore/aft joints paddle underneath the chest
      // exactly like a real capybara's dog-paddle. The head counter-rotates so
      // the face still looks where the capy is going.
      // Trailing bubbles are the room's job, not the avatar's: one recycled
      // Points cloud for every swimmer in the room beats a per-capy emitter and
      // keeps this file at 16 draw calls.
      if (state.anim === 'swim') {
        const p = t * 7;
        const s = Math.sin(p);
        body.rotation.x = 1.3 + Math.sin(t * 2.1) * 0.05;   // horizontal
        body.rotation.z = Math.sin(t * 1.7) * 0.07;         // lazy roll
        body.rotation.y = Math.sin(t * 3.5) * 0.055;        // fishy wag
        body.position.y = 0.32 + Math.sin(t * 2.1) * 0.05;
        body.scale.y = 1.06;                                // streamlined
        body.scale.x = body.scale.z = 0.98;
        headG.rotation.x = -1.05 + Math.sin(t * 2.1) * 0.06;
        headG.rotation.y = Math.sin(t * 0.9) * 0.13;
        arms[0].rotation.x = -0.55 + s * 0.75;
        arms[1].rotation.x = -0.55 - s * 0.75;
        arms[0].rotation.z = -(ARM_SPLAY + 0.3);
        arms[1].rotation.z = ARM_SPLAY + 0.3;
        legs[0].rotation.x = -0.35 + Math.sin(p + 1.1) * 0.6;
        legs[1].rotation.x = -0.35 - Math.sin(p + 1.1) * 0.6;
        legs[0].rotation.z = -0.2;
        legs[1].rotation.z = 0.2;
        ears[0].rotation.x = 0.28;
        ears[1].rotation.x = 0.28;
        tail.rotation.x = Math.sin(t * 5.2) * 0.4;
      } else {
        // riding Big Blue: astride her back, paws planted, head sightseeing
        body.position.y = -0.12 + Math.sin(t * 1.7) * 0.03;
        body.rotation.x = -0.08;
        body.rotation.z = Math.sin(t * 0.85) * 0.06;
        body.scale.y = 1 + Math.sin(t * 2) * 0.012;
        legs[0].rotation.x = -0.95;
        legs[1].rotation.x = -0.95;
        legs[0].rotation.z = -0.5;
        legs[1].rotation.z = 0.5;
        legs[0].position.z += 0.06;
        legs[1].position.z += 0.06;
        arms[0].rotation.x = -1.0;
        arms[1].rotation.x = -1.0;
        arms[0].rotation.z = -0.34;
        arms[1].rotation.z = 0.34;
        headG.rotation.y = Math.sin(t * 0.7) * 0.22;
        headG.rotation.x = -0.12 + Math.sin(t * 1.9) * 0.05;
        ears[0].rotation.x = -0.12 + Math.sin(t * 2.6) * 0.06;
        ears[1].rotation.x = -0.12 + Math.sin(t * 2.6 + 1) * 0.06;
        tail.rotation.x = 0.45 + Math.sin(t * 1.1) * 0.12;
      }
    } else if (state.anim === 'sit') {
      // seated: settled low, legs forward, tail curled up, gentle look-around
      body.position.y = -0.16;
      body.rotation.x = -0.1;
      body.scale.y = 1 + Math.sin(t * 2) * 0.014;
      legs[0].rotation.x = -1.3;
      legs[1].rotation.x = -1.3;
      legs[0].position.z += 0.1;
      legs[1].position.z += 0.1;
      arms[0].rotation.x = -0.4;
      arms[1].rotation.x = -0.4;
      arms[0].rotation.z = -0.1;
      arms[1].rotation.z = 0.1;
      headG.rotation.z = Math.sin(t * 1.5) * 0.05;
      headG.rotation.y = Math.sin(t * 0.85) * 0.11;
      headG.position.y += Math.sin(t * 2) * 0.01;
      tail.rotation.x = 0.6 + Math.sin(t * 1.3) * 0.15;
      tail.rotation.z = Math.sin(t * 0.9) * 0.18;
    } else {
      // idle: breathe, tail sway, and every ~10s a big satisfied stretch
      const br = Math.sin(t * 2.1);
      body.scale.y = 1 + br * 0.02;
      body.scale.x = body.scale.z = 1 - br * 0.012;
      headG.position.y += br * 0.012;
      tail.rotation.x = Math.sin(t * 1.5) * 0.16;
      state.stretchIn -= dt;
      if (state.stretchIn <= 0) {
        state.stretchIn = 9 + Math.random() * 8;
        state.stretchT = 1.3;
      }
      if (state.stretchT > 0) {
        state.stretchT = Math.max(0, state.stretchT - dt);
        const u = 1 - state.stretchT / 1.3;
        const k = Math.sin(u * Math.PI);
        const dip = Math.sin(Math.min(1, u * 3) * Math.PI) * (u < 0.2 ? 1 : 0);
        body.scale.y += k * 0.13 - dip * 0.05;
        body.scale.x -= k * 0.045;
        body.scale.z -= k * 0.045;
        body.position.y += k * 0.05;
        headG.rotation.x = -k * 0.3;
        arms[0].rotation.x = -k * 2.1;
        arms[1].rotation.x = -k * 2.1;
        arms[0].rotation.z -= k * 0.25;
        arms[1].rotation.z += k * 0.25;
        ears[0].rotation.x = -k * 0.25;
        ears[1].rotation.x = -k * 0.25;
        tail.rotation.x += k * 0.5;
      }
    }

    // ---- always-on life: blink, ear flick (any state) ----------------------
    state.blinkIn -= dt;
    if (state.blinkIn <= 0) {
      // a quarter of blinks come in pairs, which reads far more alive than a metronome
      state.blinkIn = Math.random() < 0.22 ? 0.32 : 2.6 + Math.random() * 3.8;
      state.blinkT = BLINK_DUR;
    }
    if (state.blinkT > 0) {
      state.blinkT -= dt;
      eyes.scale.y = 1 - 0.88 * Math.sin(Math.max(0, state.blinkT) / BLINK_DUR * Math.PI);
    } else if (eyes.scale.y !== 1) {
      eyes.scale.y = 1;
    }

    state.twitchIn -= dt;
    if (state.twitchIn <= 0) {
      state.twitchIn = 3.2 + Math.random() * 4.5;
      state.twitchT = 0.42;
      state.twitchEar = Math.random() < 0.5 ? 0 : 1;
    }
    if (state.twitchT > 0) {
      state.twitchT = Math.max(0, state.twitchT - dt);
      const u = state.twitchT / 0.42;
      const k = Math.sin(u * Math.PI * 3.5) * u * 0.5;
      ears[state.twitchEar].rotation.z += k;
      ears[state.twitchEar].rotation.x += k * 0.4;
    }

    if (state.spinner) state.spinner.rotation.y += dt * 9;

    // ---- wave: whole body joins in, on top of whatever state is running ----
    if (state.waveT >= 0) {
      state.waveT += dt;
      const w = state.waveT;
      const env = Math.sin(Math.min(1, w / WAVE_DUR * 1.25) * Math.PI);
      arms[1].rotation.z = ARM_SPLAY + (2.15 + Math.sin(w * 15) * 0.4) * env;
      arms[1].rotation.x = -0.15 * env;
      arms[0].rotation.z -= 0.3 * env;
      body.position.y += Math.abs(Math.sin(w * 7.5)) * 0.07 * env;
      body.rotation.z += Math.sin(w * 7.5) * 0.05 * env;
      headG.rotation.z -= 0.12 * env;
      headG.rotation.x -= 0.07 * env;
      ears[0].rotation.x -= 0.22 * env;
      ears[1].rotation.x -= 0.22 * env;
      if (w > WAVE_DUR) state.waveT = -1;
    }

    // ---- transition squash: a damped 0.94 -> 1 pulse on every state change --
    if (state.pulse > 0) {
      state.pulse = Math.max(0, state.pulse - dt);
      const p = 1 - state.pulse / PULSE_DUR;
      const amp = 0.06 * Math.exp(-p * 4.5) * Math.cos(p * 13);
      body.scale.y *= 1 - amp;
      body.scale.x *= 1 + amp * 0.65;
      body.scale.z *= 1 + amp * 0.65;
    }
  }

  function dispose() {
    // Body geometry + the blob material are module-level singletons shared by
    // every avatar alive, so freeing them here would blank out everyone else.
    // Only the hat subtree owns geometry of its own.
    group.traverse((o) => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
  }

  return { group, body, headG, hatAnchor, state, setHat, setColor, setAnim, playWave, update, dispose };
}
