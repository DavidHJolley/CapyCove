import * as THREE from 'three';
import { makeToon, canvasTexture } from '../core/materials.js';
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
//  4. World fx (footstep dust, shoreline ripples) are POOLED and LAZY. Nothing
//     is built until a capybara first kicks something up, the two objects hide
//     themselves the moment their pool empties (an invisible object costs no
//     draw call), and the pools are fixed-size typed arrays, so a frame of
//     animation allocates nothing. A standing capy is still 16 draw calls; a
//     walking one is 17; a walker in the shallows is 18 for about a second.
//     Both fx objects hang off `group` (so the avatar owns and disposes them,
//     and a room teardown can never free them out from under a live capy) with
//     a counter-transform on their parent that cancels the avatar's own motion,
//     which is what lets a puff stay behind where the paw actually left it.

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
const WAVE_TAIL = 0.75;  // the arm swings past rest and springs back after it
const GROOVE_DUR = 0.38; // one groove pop (before combo speed-up)
const PULSE_DUR = 0.34;  // squash-and-stretch on animation changes
const ANTIC_DUR = 0.26;  // gather-and-lean before the first stride
const SETTLE_DUR = 0.6;  // damped rock when the feet stop
const LOOK_DUR = 2.4;    // one idle look-around
const DOZE_AT = 32;      // seconds of unbroken idle before a capy settles down

// Pool sizes. A walk cycle keeps ~5 puffs alive and a wade ~2 rings, so these
// are roughly 3x headroom; when a pool wraps, the oldest particle is recycled.
const DUST_N = 16;
const RING_N = 4;
const DUST_LIFE = 0.6;
const RING_LIFE = 1.0;

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
const _c = new THREE.Color();

const HALF_PI = Math.PI / 2;

/** Reduced motion, polled at most once a second for the whole world (matchMedia
 *  is not free and there can be sixteen capybaras asking). Everything that
 *  spawns, shakes or lurches checks this; breathing and blinking do not. */
let _rmAt = -1e9;
let _rm = false;
function calm() {
  const now = typeof performance === 'object' ? performance.now() : Date.now();
  if (now - _rmAt > 1000) {
    _rmAt = now;
    try {
      _rm = globalThis.capyReducedMotion
        ? !!globalThis.capyReducedMotion()
        : (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch { _rm = false; }
  }
  return _rm;
}

/** Particles and ripples are not clickable: the engine picks players out of
 *  remoteGroup and the layout editor picks props, and neither wants a puff. */
function noRaycast() {}

// Shared fx assets: one soft dot, one flat ring, one material each, for every
// capybara in the world. Built on the first puff, never at import time.
let DUST_MAT = null;
let RING_GEO = null;
let RING_MAT = null;
function fxAssets() {
  if (DUST_MAT) return;
  const tex = canvasTexture(32, 32, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  // Additive + vertexColors: fading a particle's colour to black IS its fade,
  // which is the only way to give a Points cloud a per-particle alpha without
  // a custom shader. Same trick on the rings via instanceColor.
  DUST_MAT = new THREE.PointsMaterial({
    size: 0.34, map: tex, vertexColors: true, transparent: true,
    opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  DUST_MAT.userData.shared = true;
  RING_GEO = new THREE.RingGeometry(0.74, 1, 22, 1);
  RING_GEO.rotateX(-HALF_PI);
  RING_GEO.userData.shared = true;
  RING_MAT = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  RING_MAT.userData.shared = true;
}

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
    grooveT: -1, grooveMove: 0, grooveCombo: 0, grooveLast: -9, grooveLanded: false,
    blinkIn: 1 + Math.random() * 4, blinkT: 0,
    twitchIn: 2 + Math.random() * 5, twitchT: 0, twitchEar: 0,
    stretchIn: 6 + Math.random() * 9, stretchT: 0,
    pulse: 0, spinner: null,
    // walk-start anticipation / walk-stop settle, and the stride phase sign we
    // watch for footfalls
    antic: 0, settle: 0, scuff: false, walkS: 0,
    // idle life: an occasional look-around, and a slow settle after a long wait
    lookIn: 5 + Math.random() * 9, lookT: 0, lookDir: 1,
    idleT: 0, doze: 0, everWalked: false,
    // follow-through: the head/ears trail the body's swing by a beat
    lagY: 0, lagZ: 0,
    // world-space bookkeeping for the fx (previous position, ground tint, wade)
    px: 0, pz: 0, seeded: false, wading: false,
  };

  // ---- world fx pool (see note 4 at the top of the file) -------------------
  let fxRoot = null;
  let dustPts = null;
  let dustGeo = null;
  let dustPos = null;
  let dustCol = null;
  let rings = null;
  const dustVel = new Float32Array(DUST_N * 3);
  const dustLife = new Float32Array(DUST_N);
  const dustSpan = new Float32Array(DUST_N);
  const dustTint = new Float32Array(DUST_N * 3);
  const ringPos = new Float32Array(RING_N * 3);
  const ringLife = new Float32Array(RING_N);
  let dustHead = 0;
  let ringHead = 0;
  let dustLive = false;
  let ringLive = false;
  // ground-matched puff tint, kept low: additive dust is a lift of light off
  // the floor, not a splat of paint. Warm cream until a floor says otherwise.
  let tintR = 0.40;
  let tintG = 0.35;
  let tintB = 0.27;

  function ensureFx() {
    if (fxRoot) return;
    fxAssets();
    fxRoot = new THREE.Group();
    fxRoot.matrixAutoUpdate = false;   // we write the counter-transform by hand
    fxRoot.frustumCulled = false;
    group.add(fxRoot);

    dustGeo = new THREE.BufferGeometry();
    dustPos = new Float32Array(DUST_N * 3);
    dustCol = new Float32Array(DUST_N * 3);
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
    dustPts = new THREE.Points(dustGeo, DUST_MAT);
    dustPts.frustumCulled = false;
    dustPts.raycast = noRaycast;
    dustPts.visible = false;
    fxRoot.add(dustPts);

    rings = new THREE.InstancedMesh(RING_GEO, RING_MAT, RING_N);
    rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    rings.frustumCulled = false;
    rings.raycast = noRaycast;
    rings.visible = false;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < RING_N; i++) {
      rings.setMatrixAt(i, _m);
      rings.setColorAt(i, _c.setRGB(0, 0, 0));
    }
    fxRoot.add(rings);
  }

  /** n puffs at a world (parent-space) point. `power` scales the kick. */
  function puff(x, y, z, n, power, r, g, b) {
    ensureFx();
    for (let k = 0; k < n; k++) {
      const i = dustHead;
      dustHead = (dustHead + 1) % DUST_N;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.3 + Math.random() * 0.45) * power;
      const o = 0.05 + Math.random() * 0.07;
      dustPos[i * 3] = x + Math.cos(a) * o;
      dustPos[i * 3 + 1] = y + 0.04 + Math.random() * 0.03;
      dustPos[i * 3 + 2] = z + Math.sin(a) * o;
      dustVel[i * 3] = Math.cos(a) * sp;
      dustVel[i * 3 + 1] = (0.3 + Math.random() * 0.4) * power;
      dustVel[i * 3 + 2] = Math.sin(a) * sp;
      const life = DUST_LIFE * (0.75 + Math.random() * 0.5);
      dustLife[i] = life;
      dustSpan[i] = life;
      dustTint[i * 3] = r;
      dustTint[i * 3 + 1] = g;
      dustTint[i * 3 + 2] = b;
    }
    dustLive = true;
    dustPts.visible = true;
  }

  /** One expanding ripple ring, flat on the water film at (x, y, z). */
  function ripple(x, y, z) {
    ensureFx();
    const i = ringHead;
    ringHead = (ringHead + 1) % RING_N;
    ringPos[i * 3] = x;
    ringPos[i * 3 + 1] = y;
    ringPos[i * 3 + 2] = z;
    ringLife[i] = RING_LIFE;
    ringLive = true;
    rings.visible = true;
  }

  /** Kill everything in flight (a teleport: the puffs belonged to another
   *  floor, in another room, possibly in another scene). */
  function flushFx() {
    if (!fxRoot) return;
    dustLife.fill(0);
    dustCol.fill(0);
    ringLife.fill(0);
    dustGeo.attributes.color.needsUpdate = true;
    // a ring that was mid-flight still holds a lit colour and an open scale,
    // and updateFx only ever rewrites LIVE slots: clear them here or the next
    // ripple brings a ghost of this one back with it
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < RING_N; i++) {
      rings.setMatrixAt(i, _m);
      rings.setColorAt(i, _c.setRGB(0, 0, 0));
    }
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    dustLive = false;
    ringLive = false;
    dustPts.visible = false;
    rings.visible = false;
  }

  function updateFx(dt) {
    if (!fxRoot) return;
    // Cancel the avatar's own transform so everything below lives in the
    // parent's space: a puff dropped at the paw then stays on the ground while
    // the capy walks on. Composed from position/quaternion/scale rather than
    // read off group.matrix so it is this frame's transform, not last frame's,
    // and so a room's own wobble (the peak's boop writes the root's rotation
    // and scale) is cancelled too.
    _m.compose(group.position, group.quaternion, group.scale).invert();
    fxRoot.matrix.copy(_m);
    fxRoot.matrixWorldNeedsUpdate = true;

    if (dustLive) {
      const drag = 1 - Math.min(0.9, dt * 3.2);
      let live = 0;
      for (let i = 0; i < DUST_N; i++) {
        const rem = dustLife[i];
        if (rem <= 0) continue;
        const n = rem - dt;
        dustLife[i] = n > 0 ? n : 0;
        const b = i * 3;
        if (n <= 0) {
          dustCol[b] = dustCol[b + 1] = dustCol[b + 2] = 0;
          continue;
        }
        live++;
        dustVel[b] *= drag;
        dustVel[b + 2] *= drag;
        dustVel[b + 1] = dustVel[b + 1] * drag - dt * 0.5;
        dustPos[b] += dustVel[b] * dt;
        dustPos[b + 1] += dustVel[b + 1] * dt;
        dustPos[b + 2] += dustVel[b + 2] * dt;
        const u = 1 - n / dustSpan[i];
        // snap in over the first sixth of the life, then ease out squared
        const f = Math.sin(Math.min(1, u * 6) * HALF_PI) * (1 - u) * (1 - u);
        dustCol[b] = dustTint[b] * f;
        dustCol[b + 1] = dustTint[b + 1] * f;
        dustCol[b + 2] = dustTint[b + 2] * f;
      }
      dustGeo.attributes.position.needsUpdate = true;
      dustGeo.attributes.color.needsUpdate = true;
      if (!live) { dustLive = false; dustPts.visible = false; }
    }

    if (ringLive) {
      let live = 0;
      for (let i = 0; i < RING_N; i++) {
        const rem = ringLife[i];
        if (rem <= 0) continue;
        const n = rem - dt;
        ringLife[i] = n > 0 ? n : 0;
        const u = 1 - Math.max(0, n) / RING_LIFE;
        const s = 0.2 + u * 0.8;
        _m.makeScale(s, 1, s);
        _m.setPosition(ringPos[i * 3], ringPos[i * 3 + 1], ringPos[i * 3 + 2]);
        rings.setMatrixAt(i, _m);
        const f = n > 0 ? (1 - u) * (1 - u) * 0.9 : 0;
        rings.setColorAt(i, _c.setRGB(0.62 * f, 0.8 * f, 0.88 * f));
        if (n > 0) live++;
      }
      rings.instanceMatrix.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
      if (!live) { ringLive = false; rings.visible = false; }
    }
  }

  /** Where the planted paw is, in the parent's space. `side` is -1 or 1. */
  function pawX(side) {
    return group.position.x + side * LEG_X * Math.cos(group.rotation.y) - 0.14 * Math.sin(group.rotation.y);
  }
  function pawZ(side) {
    return group.position.z - side * LEG_X * Math.sin(group.rotation.y) - 0.14 * Math.cos(group.rotation.y);
  }

  /** One footfall: dust off dry ground, a ripple ring plus pale spray in the
   *  shallows. Cheap enough to run twice a stride; skipped entirely when the
   *  player has asked for calm animations. */
  function footfall(side, power) {
    if (calm()) return;
    const x = pawX(side);
    const z = pawZ(side);
    const y = group.position.y;
    if (state.wading) {
      ripple(x, y + 0.03, z);
      puff(x, y, z, 2, power * 0.8, 0.5, 0.62, 0.68);
    } else {
      puff(x, y, z, 2, power, tintR, tintG, tintB);
    }
  }

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
    const was = state.anim;
    state.anim = anim;
    state.pulse = PULSE_DUR; // little squash so a state change reads as a beat
    // A walk that begins on the exact frame the click lands reads as a teleport
    // into a gait. It gathers itself first, and when the feet stop the weight
    // keeps going for a beat and rocks back.
    if (anim === 'walk') {
      if (was !== 'walk') { state.antic = ANTIC_DUR; state.walkS = 0; }
      state.everWalked = true;
    } else if (was === 'walk') {
      state.settle = SETTLE_DUR;
      state.scuff = true; // one small kick of dust as the paws brake
    }
    state.idleT = 0; // which unwinds any doze, over a fifth of a second
  }

  function playWave() {
    state.waveT = 0;
    state.pulse = Math.max(state.pulse, PULSE_DUR * 0.8);
    state.idleT = 0;
  }

  /** Ground colour under the paws, so a puff belongs to the room it is kicked
   *  up in (sand on the beach, warm plank in the den, cold grit in the mine).
   *  Takes a live THREE.Color: values are linear, hence the sqrt back to
   *  something eye-shaped before it is dimmed into an additive tint.
   *  WalkController picks the colour (see DUST_TINT in controller.js): most
   *  cove floors are a white base material carrying a map or vertex colours, so
   *  this is rarely the floor material's own colour. */
  function setGroundTint(c) {
    if (!c) return;
    tintR = 0.14 + Math.sqrt(Math.min(1, Math.max(0, c.r))) * 0.4;
    tintG = 0.14 + Math.sqrt(Math.min(1, Math.max(0, c.g))) * 0.4;
    tintB = 0.14 + Math.sqrt(Math.min(1, Math.max(0, c.b))) * 0.4;
  }

  /** True while the paws are in the shoreline shallows: footfalls ring the
   *  water instead of raising dust. Set by WalkController from room.minWalkY. */
  function setWading(on) {
    state.wading = !!on;
  }

  function update(dt) {
    state.t += dt;
    const t = state.t;
    const arms = limbs.arms;
    const legs = limbs.legs;

    // How far the capy actually travelled through the world this frame. The
    // walk cycle runs off the clock, not off distance, so this is what tells a
    // real stride apart from a remote jogging on the spot against a wall.
    let speed = 0;
    if (state.seeded) {
      speed = Math.hypot(group.position.x - state.px, group.position.z - state.pz) / Math.max(dt, 1e-4);
      if (speed > 25) {
        // a room change is a teleport, not a sprint: no stride, no shoreline
        // (the new floor has not told us about itself yet) and no trail of
        // puffs stretched across the world from wherever we used to be
        speed = 0;
        state.wading = false;
        flushFx();
      }
    } else {
      state.seeded = true;
    }
    state.px = group.position.x;
    state.pz = group.position.z;

    if (state.scuff) {
      state.scuff = false;
      footfall(state.walkS < 0 ? -1 : 1, 0.5); // the paws brake
    }

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
      // springy waddle: bounce with a squash at each footfall, ears lag behind.
      // The first quarter-second is an anticipation: the capy gathers down and
      // leans into the walk, and the stride opens up out of the crouch.
      let gait = 1;   // stride amplitude: opens out of the crouch
      let crouch = 0; // the anticipation dip itself
      if (state.antic > 0) {
        state.antic = Math.max(0, state.antic - dt);
        const u = 1 - state.antic / ANTIC_DUR;
        gait = 0.35 + 0.65 * u;
        crouch = calm() ? 0 : Math.sin(u * Math.PI);
      }
      const p = t * 9.2;
      const s = Math.sin(p);
      const hop = Math.abs(s) * gait;
      body.position.y = hop * 0.105 - crouch * 0.055;
      body.scale.y = 1 - 0.025 + hop * 0.05 - crouch * 0.085;
      body.scale.x = body.scale.z = 1 + 0.018 - hop * 0.035 + crouch * 0.055;
      body.rotation.z = s * 0.075 * gait;
      body.rotation.x = 0.05 + crouch * 0.14;
      legs[0].rotation.x = s * 0.62 * gait;
      legs[1].rotation.x = -s * 0.62 * gait;
      arms[0].rotation.x = -s * 0.55 * gait;
      arms[1].rotation.x = s * 0.55 * gait;
      headG.rotation.x = -hop * 0.06;
      headG.position.y += hop * 0.012;
      const bob = -Math.sin(p - 0.9) * 0.26 * gait - crouch * 0.22;
      ears[0].rotation.x = bob;
      ears[1].rotation.x = bob;
      tail.rotation.x = -0.2 + s * 0.2 * gait - crouch * 0.3;

      // Footfall = the stride phase crossing zero, which is exactly where the
      // bounce bottoms out, so the puff lands on the beat the paw does. Only
      // for a capy that is really covering ground: a walker pressed against a
      // wall should not sand-blast it.
      const was = state.walkS;
      state.walkS = s;
      if (was * s < 0 && speed > 0.6) footfall(s < 0 ? -1 : 1, 1);
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

      // Follow-through on the landings: the hop used to stop dead at the floor.
      // Now the whole body takes the impact - squash down, splay wide, chin
      // drops - which is what turns a bobbing capy into a dancing one.
      const land = (1 - bH) * (1 - bH) * (1 - bH) * m + (1 - aB) * (1 - aB) * 0.35 * n;
      body.scale.y -= land * 0.075;
      body.scale.x = body.scale.z = 1 + land * 0.05;
      body.position.y -= land * 0.02;
      headG.rotation.x += land * 0.09;
      headG.position.y -= land * 0.015;
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
      // idle: breathe, tail sway, and every ~10s a big satisfied stretch.
      // A capy left alone long enough sinks into a settled, half-dozing slump
      // (state.doze); it never touches state.anim, so nothing on the wire and
      // nothing that reads a pose ('sit' chairs, the beach's cozy check) sees
      // anything change.
      state.idleT += dt;
      const dz = state.doze; // integrated below, once, for every state

      const br = Math.sin(t * 2.1) * (1 - dz * 0.45);
      body.scale.y = 1 + br * 0.02;
      body.scale.x = body.scale.z = 1 - br * 0.012;
      headG.position.y += br * 0.012;
      tail.rotation.x = Math.sin(t * 1.5) * 0.16;

      // the weight keeps travelling for a beat after the paws stop, then rocks
      // back onto them: this is what makes a stop feel like a stop
      if (state.settle > 0) {
        state.settle = Math.max(0, state.settle - dt);
        if (!calm()) {
          const u = 1 - state.settle / SETTLE_DUR;
          const d = Math.exp(-u * 4.2) * (1 - u);
          const w = Math.cos(u * 15);
          body.rotation.x += w * 0.11 * d;
          body.position.y += (1 - w) * 0.02 * d;
          body.scale.y -= w * 0.045 * d;
          body.scale.x = body.scale.z = body.scale.x + w * 0.03 * d;
          headG.rotation.x += w * 0.09 * d;
          ears[0].rotation.x -= w * 0.3 * d;
          ears[1].rotation.x -= w * 0.3 * d;
          tail.rotation.x -= w * 0.25 * d;
        }
      }

      state.stretchIn -= dt;
      if (state.stretchIn <= 0) {
        state.stretchIn = 9 + Math.random() * 8;
        // a settled capy has stopped stretching and started dozing; it also
        // keeps the two poses from fighting over the same arms
        if (dz < 0.3) state.stretchT = 1.3;
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

    // ---- the long-idle settle ----------------------------------------------
    // A capy left alone long enough sinks onto its haunches: weight down, paws
    // in, chin low, breathing slower. It never touches state.anim, so nothing
    // on the wire and nothing that reads a pose (chairs use 'sit'; the beach's
    // cozy-bonfire check reads state.anim) sees anything change - and because
    // it only starts for a capy that has walked at least once, the shop and
    // profile turntables never do it.
    // Integrated OUT here rather than inside the idle branch so that leaving
    // idle unwinds the slump over a fifth of a second instead of snapping a
    // slumped rig straight into a stride.
    {
      const want = state.anim === 'idle' && state.everWalked && !calm()
        && state.waveT < 0 && state.grooveT < 0 && state.idleT > DOZE_AT ? 1 : 0;
      state.doze += (want - state.doze) * Math.min(1, dt * (want ? 0.9 : 5));
      const dz = state.doze;
      if (dz > 0.002) {
        body.position.y -= dz * 0.11;
        body.rotation.x -= dz * 0.05;
        for (let i = 0; i < 2; i++) {
          const side = i === 0 ? -1 : 1;
          legs[i].rotation.x -= dz * 0.8;
          legs[i].position.z += dz * 0.055;
          arms[i].rotation.x -= dz * 0.22;
          arms[i].rotation.z = side * ARM_SPLAY * (1 - dz * 0.55);
          ears[i].rotation.x += dz * 0.16;
        }
        headG.rotation.x += dz * 0.1;
        tail.rotation.x += dz * 0.35;
      }
    }

    // ---- idle life: a look-around, every so often --------------------------
    // Only where standing still is the point (idle and sit). Turns the head,
    // holds the look, brings it back; the near ear cocks toward whatever it is.
    const still = state.anim === 'idle' || state.anim === 'sit';
    if (still) {
      state.lookIn -= dt;
      if (state.lookIn <= 0) {
        state.lookIn = 6 + Math.random() * 10;
        if (!calm()) {
          state.lookT = LOOK_DUR;
          state.lookDir = Math.random() < 0.5 ? -1 : 1;
        }
      }
    }
    if (state.lookT > 0) {
      state.lookT = Math.max(0, state.lookT - dt * (still ? 1 : 3.5));
      const u = 1 - state.lookT / LOOK_DUR;
      const k = Math.min(1, Math.sin(u * Math.PI) * 2.3); // ramp, hold, ramp back
      const d = state.lookDir;
      headG.rotation.y += d * 0.52 * k;
      headG.rotation.z += d * 0.07 * k;
      headG.rotation.x -= 0.04 * k;
      ears[d < 0 ? 0 : 1].rotation.x -= 0.14 * k;
    }

    // ---- follow-through: the head and ears trail the body ------------------
    // A one-pole lag on the body's swing, fed back as a counter-rotation on the
    // head. Costs two floats and one lerp, and it is the whole difference
    // between a rig that moves and a body that carries a head around.
    const lagK = Math.min(1, dt * 9);
    state.lagY += (body.rotation.y - state.lagY) * lagK;
    state.lagZ += (body.rotation.z - state.lagZ) * lagK;
    if (!calm() && (state.anim === 'dance' || state.grooveT >= 0)) {
      // clamped so a groove's full 360 spin whips the head instead of snapping
      // it round backwards on the wrap
      let dy = body.rotation.y - state.lagY;
      let dz = body.rotation.z - state.lagZ;
      if (dy > 0.5) dy = 0.5; else if (dy < -0.5) dy = -0.5;
      if (dz > 0.4) dz = 0.4; else if (dz < -0.4) dz = -0.4;
      headG.rotation.y -= dy * 0.42;
      headG.rotation.z -= dz * 0.35;
      ears[0].rotation.z -= dy * 0.3;
      ears[1].rotation.z -= dy * 0.3;
      tail.rotation.z -= dy * 0.5;
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
      // Follow-through: the envelope reaches zero four fifths of the way in and
      // the arm used to be simply gone. Now it drops past rest, swings back and
      // settles, and the head and ears ride the last of it down.
      if (w > WAVE_DUR * 0.8 && !calm()) {
        const v = (w - WAVE_DUR * 0.8) / WAVE_TAIL;
        if (v < 1) {
          const d = Math.exp(-v * 4) * (1 - v);
          const osc = Math.sin(v * 13);
          arms[1].rotation.z = ARM_SPLAY + osc * 0.42 * d;
          arms[1].rotation.x = -0.05 * d;
          arms[0].rotation.z -= osc * 0.09 * d;
          headG.rotation.z -= osc * 0.05 * d;
          ears[1].rotation.x -= osc * 0.16 * d;
          ears[0].rotation.x -= osc * 0.1 * d;
        }
      }
      if (w > WAVE_DUR * 0.8 + WAVE_TAIL) state.waveT = -1;
    }

    // ---- groove pops: one-shot mash moves (the D key), stack-friendly ------
    if (state.grooveT >= 0) {
      const speed = 1 + Math.min(state.grooveCombo, 10) * 0.13; // mash = faster
      state.grooveT += dt * speed;
      const u = Math.min(1, state.grooveT / GROOVE_DUR);
      const k = Math.sin(u * Math.PI);
      const squash = u < 0.18 ? (1 - u / 0.18) * 0.12 : 0; // anticipation dip
      body.scale.y += k * 0.06 - squash;
      body.scale.x += squash * 0.6;
      body.scale.z += squash * 0.6;
      const m = state.grooveMove;
      if (m === 0) { // full spin with a hop
        body.rotation.y += u * Math.PI * 2;
        body.position.y += k * 0.34;
        arms[0].rotation.z -= k * 1.2;
        arms[1].rotation.z += k * 1.2;
      } else if (m === 1) { // star jump
        body.position.y += k * 0.42;
        arms[0].rotation.z -= k * 2.2;
        arms[1].rotation.z += k * 2.2;
        legs[0].rotation.z = -k * 0.7;
        legs[1].rotation.z = k * 0.7;
        ears[0].rotation.z += k * 0.5;
        ears[1].rotation.z -= k * 0.5;
      } else if (m === 2) { // hip shake, tail going wild
        body.rotation.z += Math.sin(u * Math.PI * 4) * 0.22 * (1 - u * 0.4);
        headG.rotation.z -= Math.sin(u * Math.PI * 4) * 0.14;
        tail.rotation.z = Math.sin(u * Math.PI * 6) * 0.6;
        body.position.y += Math.abs(Math.sin(u * Math.PI * 2)) * 0.1;
      } else { // the backflip
        body.rotation.x -= u * Math.PI * 2;
        body.position.y += k * 0.55;
        arms[0].rotation.x = -k * 2.4;
        arms[1].rotation.x = -k * 2.4;
      }
      // the three airborne moves get a landing: a ring of dust off both paws as
      // the capy comes back down, once per pop
      if (!state.grooveLanded && u > 0.82 && m !== 2) {
        state.grooveLanded = true;
        footfall(-1, 1.5);
        footfall(1, 1.5);
      }
      if (u >= 1) state.grooveT = -1;
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

    updateFx(dt);
  }

  function dispose() {
    // Body geometry + the blob material are module-level singletons shared by
    // every avatar alive, so freeing them here would blank out everyone else.
    // Only the hat subtree and this avatar's own fx pools own anything.
    rings?.dispose?.();
    group.traverse((o) => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
  }

  /** One-shot mash move (the D key): each call fires the next pop; presses
   *  within 0.75s of each other build combo, which speeds the moves up. */
  function playGroove() {
    const now = state.t;
    state.grooveCombo = now - state.grooveLast < 0.75 ? Math.min(state.grooveCombo + 1, 12) : 0;
    state.grooveLast = now;
    state.grooveMove = (state.grooveMove + 1 + (state.grooveCombo === 0 ? Math.floor(Math.random() * 2) : 0)) % 4;
    state.grooveT = 0;
    state.grooveLanded = false;
    state.idleT = 0;
  }

  return {
    group, body, headG, hatAnchor, state,
    setHat, setColor, setAnim, setGroundTint, setWading,
    playWave, playGroove, update, dispose,
  };
}
