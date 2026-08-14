import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/* ---------------------------------------------------------------------------
 * The Tangle Jungle: a clearing under a closed canopy, lit in shafts of green
 * gold. A waterfall drops off a mossy escarpment into an unwalkable pool west,
 * ruin stones carved with capy glyphs ring a raised terrace north, and eight
 * drum-log seats face the stone easel that hosts Capy Doodles.
 * Everything procedural: geometry + canvas textures only.
 *
 * This room owns the Capy Doodles lobby, built on the Frosty Peak race-lobby
 * pattern (see src/world/rooms/peak.js). Protocol (server <-> net/client.js):
 *   out  {t:'dd-join'} {t:'dd-leave'}
 *   in   'dd-lobby' {players:[{id,name}], starting}  'dd-start' {seed, players}
 * On 'dd-start' we stash game.__partyCtx and launch the doodle minigame; solo
 * runs (the guessing stone east of the ruin) launch with __partyCtx = null.
 * ------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const BZ = BOT_ZONES.jungle; // { x: 0, z: 3, r: 4.5 } - must stay flat + walkable

const C = {
  leaf: 0x7ac74f,
  leafLit: 0x9fdc63,
  leafDark: 0x4e8a34,
  jade: 0x3f6b2c,
  moss: 0x6f9e42,
  mossLit: 0x8fc25a,
  bark: 0x8a6642,
  barkDark: 0x5d4529,
  barkLit: 0xb08a5a,
  stone: 0xbcb49a,
  stoneLit: 0xd8d2ba,
  stoneDark: 0x8d876f,
  mud: 0x6b5636,
  water: 0x4fb3e8,
  waterDeep: 0x2f86b4,
  foam: 0xfff6e3,
  cream: 0xfff6e3,
  coral: 0xe8657a,
  coralDark: 0xc44a60,
  gold: 0xf2b64a,
  petal: 0xffffff,
  glow: 0xffe9a8,
  ink: 0x2d2417,
};

const CLEAR = { x: 0, z: 1 };      // the open clearing (holds the whole bot zone)
// The floor runs well past the tree line: the follow camera sits 18.5 behind the
// player, so at the beach spawn it hovers around z 27 and would otherwise look
// straight off the edge of the plate.
const GROUND_R = 23;
const POOL = { x: -9.6, z: -3.4, r: 3.1 };
const POOL_Y = -0.55;
const EASEL = { x: 0, z: -8 };     // the stone easel: Capy Doodles lives here
const DAIS = { x: 0, z: -9.2, r: 3.1, h: 0.42 };
// the walk-out corridor to Driftwood Beach, kept flat by groundH()
const PATH_A = { x: 0.4, z: 5.5 };
const PATH_B = { x: 1.1, z: 18.5 };
// the escarpment: a wall running SW -> NE, face normal (0.6, 0.8) (south-east)
const SIGN = { x: 4.4, z: 10.2 };  // the trail signpost, east of the path mouth
const CLIFF_A = new THREE.Vector2(-15.5, -3.5);
const CLIFF_DIR = new THREE.Vector2(0.8, -0.6);
const CLIFF_N = new THREE.Vector2(0.6, 0.8);
const CLIFF_LEN = 10.4;
const CLIFF_HALF_D = 1.7;          // block depth / 2: where the rock face lands
const FALL_T = 5.2;                // distance along the wall to the waterfall notch
const FALL_TOP = 5.4;

/**
 * The eight doodle-circle seats, in protocol order: dd-lobby.players[i] sits on
 * seat i. They ride an arc of drum logs around the easel with the middle left
 * open, so the aisle from the clearing to the ruin never pinches shut. Filling
 * order is front-first so a two-capy lobby still reads as a circle.
 * They carry NO obstacle circles: a collider here would shove the local player
 * straight back out of their own seat.
 */
const SEAT_R = 4.3;
const SEAT_DEG = [-35, 35, -60, 60, -85, 85, -110, 110];
const SEATS = SEAT_DEG.map((deg) => {
  const a = (deg * Math.PI) / 180;
  const x = EASEL.x + Math.sin(a) * SEAT_R;
  const z = EASEL.z + Math.cos(a) * SEAT_R;
  return { x, z, yaw: Math.atan2(EASEL.x - x, EASEL.z - z) };
});
const LOG_H = 0.62;
const SEAT_Y = LOG_H - 0.03; // settled a hair into the drum skin
const DEFAULT_FUR = 0xb08a5a; // dd-lobby carries id+name only; brown until we know

/* --- tiny math helpers ---------------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World clock (wave 7): 1 at noon, 0 at midnight, 0.5 at dawn and dusk.
 *  dayT is 0 dawn, 0.25 noon, 0.5 dusk, 0.75 midnight. */
function daylight(dayT) {
  return 0.5 + 0.5 * Math.cos(((((dayT % 1) + 1) % 1) - 0.25) * Math.PI * 2);
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function distToSeg(x, z, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const L = vx * vx + vz * vz;
  let t = L > 0 ? ((x - a.x) * vx + (z - a.z) * vz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
}

/** A point on the escarpment: `t` along the wall, `out` from its centre line. */
function cliffPoint(t, out = 0) {
  return {
    x: CLIFF_A.x + CLIFF_DIR.x * t + CLIFF_N.x * out,
    z: CLIFF_A.y + CLIFF_DIR.y * t + CLIFF_N.y * out,
  };
}

const FALL_FACE = cliffPoint(FALL_T, CLIFF_HALF_D);
const CLIFF_YAW = Math.atan2(CLIFF_N.x, CLIFF_N.y); // face normal -> +Z of a group

/**
 * Ground height. Dead flat across the clearing (the whole bot zone), the ruin
 * terrace, the pool shelf and the beach corridor; gentle bumps between them, a
 * berm that closes the room off, and the pool basin dug out west.
 */
function groundH(x, z) {
  const rc = Math.hypot(x - CLEAR.x, z - CLEAR.z);
  const de = Math.hypot(x - EASEL.x, z - EASEL.z);
  const dp = Math.hypot(x - POOL.x, z - POOL.z);
  const flat = Math.min(
    smoothstep(6.6, 10.6, rc),
    smoothstep(5.2, 7.6, de),
    smoothstep(4.6, 6.6, dp),
    smoothstep(2.8, 4.6, distToSeg(x, z, PATH_A, PATH_B)),
  );
  const bumps =
    0.17 * Math.sin(x * 0.47 + 0.6) * Math.cos(z * 0.41 - 0.9) +
    0.11 * Math.sin(x * 0.3 - z * 0.26 + 1.7) +
    0.06 * Math.cos((x + z) * 0.83 + 0.4);
  const berm = 1.2 * smoothstep(12.4, 16.2, rc) + 3.0 * smoothstep(16.2, 19.4, rc);
  // Basin: the water disc (r 3.1) meets the shore where the dig passes POOL_Y,
  // so the pool reads as full rather than as a puddle in a crater.
  return (bumps + berm) * flat - 1.55 * (1 - smoothstep(0.4, 4.6, dp));
}

/* --- geometry assembly helpers -------------------------------------------- */

function paintGeo(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Transform + colour a geometry and queue it for merging. Takes ownership. */
function part(list, geo, hex, tf) {
  if (tf) {
    if (tf.s !== undefined) geo.scale(tf.s, tf.s, tf.s);
    if (tf.sx !== undefined || tf.sy !== undefined || tf.sz !== undefined) {
      geo.scale(tf.sx ?? 1, tf.sy ?? 1, tf.sz ?? 1);
    }
    if (tf.rx) geo.rotateX(tf.rx);
    if (tf.ry) geo.rotateY(tf.ry);
    if (tf.rz) geo.rotateZ(tf.rz);
    if (tf.x || tf.y || tf.z) geo.translate(tf.x || 0, tf.y || 0, tf.z || 0);
  }
  paintGeo(geo, hex);
  list.push(geo);
  return geo;
}

const _qa = new THREE.Vector3();
const _qb = new THREE.Vector3(0, 1, 0);
const _qq = new THREE.Quaternion();
const _qm = new THREE.Matrix4();
const _qs = new THREE.Vector3(1, 1, 1);
const _qp = new THREE.Vector3();

/** A cylinder strung between two points (roots, rails, hanging ropes). */
function link(list, a, b, radius, hex, seg = 5) {
  _qa.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _qa.length();
  if (len < 1e-5) return;
  const geo = new THREE.CylinderGeometry(radius, radius, len, seg, 1);
  _qq.setFromUnitVectors(_qb, _qa.divideScalar(len));
  _qp.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  geo.applyMatrix4(_qm.compose(_qp, _qq, _qs));
  paintGeo(geo, hex);
  list.push(geo);
}

/** Concatenate coloured parts into one geometry (one draw call). */
function mergeParts(list) {
  const src = [];
  let count = 0;
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    src.push(ng);
    count += ng.attributes.position.count;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of src) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  list.length = 0;
  return out;
}

const VC = { vertexColors: true };
const VC2 = { vertexColors: true, side: THREE.DoubleSide };

function solidMesh(parts, { shadow = true, double = false } = {}) {
  const m = new THREE.Mesh(mergeParts(parts), makeToon(0xffffff, double ? VC2 : VC));
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

/** Unique toon material carrying a canvas texture (never cache-key a texture). */
function texMat(tex, { double = false, transparent = false, vc = false } = {}) {
  const m = makeToon(0xffffff, { unique: true });
  m.map = tex;
  if (double) m.side = THREE.DoubleSide;
  if (vc) m.vertexColors = true;
  if (transparent) { m.transparent = true; m.alphaTest = 0.04; }
  m.needsUpdate = true;
  return m;
}

/** Unlit material for glowy or always-legible surfaces (signs, decals, water). */
function flatMat(tex, {
  opacity = 1, additive = false, double = false, decal = false, vc = false,
} = {}) {
  const m = makeGlow(0xffffff, { unique: true });
  if (tex) m.map = tex;
  if (vc) m.vertexColors = true;
  if (double) m.side = THREE.DoubleSide;
  if (opacity < 1 || additive || decal) { m.transparent = true; m.opacity = opacity; }
  if (additive) { m.blending = THREE.AdditiveBlending; m.depthWrite = false; }
  if (decal) { m.depthWrite = false; m.polygonOffset = true; m.polygonOffsetFactor = -3; }
  m.needsUpdate = true;
  return m;
}

/** Plane whose UVs point at one cell of a 2x2 atlas. */
function atlasPlane(w, h, col, row) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) + col) * 0.5, (uv.getY(i) + row) * 0.5);
  }
  uv.needsUpdate = true;
  return g;
}

/* --- canvas textures ------------------------------------------------------ */

function texFloor() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#4a6b34';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      c.fillStyle = `rgba(97,76,46,${0.16 + Math.random() * 0.22})`;
      c.beginPath();
      c.ellipse(Math.random() * w, Math.random() * h, 6 + Math.random() * 15,
        4 + Math.random() * 11, Math.random() * 3, 0, TAU);
      c.fill();
    }
    for (let i = 0; i < 30; i++) {
      c.fillStyle = `rgba(126,178,74,${0.14 + Math.random() * 0.24})`;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, 3 + Math.random() * 9, 0, TAU);
      c.fill();
    }
    const litter = ['rgba(196,170,88,0.5)', 'rgba(150,120,60,0.45)', 'rgba(122,199,79,0.42)', 'rgba(88,128,54,0.5)'];
    for (let i = 0; i < 130; i++) {
      c.save();
      c.translate(Math.random() * w, Math.random() * h);
      c.rotate(Math.random() * TAU);
      c.fillStyle = litter[i % 4];
      c.beginPath();
      c.ellipse(0, 0, 3.4, 1.3, 0, 0, TAU);
      c.fill();
      c.restore();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texBark() {
  const t = canvasTexture(64, 128, (c, w, h) => {
    c.fillStyle = '#8a6642';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 13; i++) {
      c.fillStyle = i % 2 ? 'rgba(93,69,41,0.5)' : 'rgba(176,138,90,0.38)';
      c.fillRect((i / 13) * w, 0, w / 26, h);
    }
    for (let i = 0; i < 60; i++) { // moss creeping up the trunk
      c.fillStyle = 'rgba(111,158,66,0.3)';
      c.beginPath();
      c.arc(Math.random() * w, h * (0.55 + Math.random() * 0.45), 1.5 + Math.random() * 4, 0, TAU);
      c.fill();
    }
    for (let i = 0; i < 150; i++) {
      c.fillStyle = 'rgba(72,52,30,0.35)';
      c.fillRect(Math.random() * w, Math.random() * h, 1.6, 2.4);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texStone() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#bcb49a';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(141,135,111,${0.15 + Math.random() * 0.25})`;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, 2 + Math.random() * 10, 0, TAU);
      c.fill();
    }
    c.strokeStyle = 'rgba(120,114,92,0.5)';
    c.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      let x = Math.random() * w, y = Math.random() * h;
      c.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (Math.random() - 0.5) * 40;
        y += (Math.random() - 0.5) * 40;
        c.lineTo(x, y);
      }
      c.stroke();
    }
    for (let i = 0; i < 26; i++) { // moss patches
      c.fillStyle = `rgba(111,158,66,${0.18 + Math.random() * 0.3})`;
      c.beginPath();
      c.ellipse(Math.random() * w, Math.random() * h, 5 + Math.random() * 12,
        4 + Math.random() * 8, Math.random() * 3, 0, TAU);
      c.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Bare rock: pale, cracked, no moss. The cliff needs to read as stone under
 *  a hemisphere light this green. */
function texRock() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#cfc9b4';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 34; i++) {
      c.fillStyle = `rgba(168,160,140,${0.14 + Math.random() * 0.22})`;
      c.beginPath();
      c.ellipse(Math.random() * w, Math.random() * h, 6 + Math.random() * 20,
        4 + Math.random() * 12, Math.random() * 3, 0, TAU);
      c.fill();
    }
    c.strokeStyle = 'rgba(126,118,98,0.55)';
    c.lineWidth = 2.4;
    for (let i = 0; i < 7; i++) {
      c.beginPath();
      let x = Math.random() * w, y = 0;
      c.moveTo(x, y);
      while (y < h) { x += (Math.random() - 0.5) * 26; y += 14 + Math.random() * 18; c.lineTo(x, y); }
      c.stroke();
    }
    for (let i = 0; i < 90; i++) {
      c.fillStyle = `rgba(240,236,222,${0.1 + Math.random() * 0.25})`;
      c.fillRect(Math.random() * w, Math.random() * h, 2.5, 1.6);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The closed canopy overhead: dark leaves with bright gaps of sky. */
function texCanopy() {
  return canvasTexture(512, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1f3a1c');
    g.addColorStop(0.34, '#2c5124');
    g.addColorStop(0.62, '#3f6b2c');
    g.addColorStop(0.84, '#4e7d38');
    g.addColorStop(1, '#33502c');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // bright gaps: sunlight punching through, thickest straight overhead
    for (let i = 0; i < 90; i++) {
      const y = Math.random() * Math.random() * h * 0.72;
      const r = 4 + Math.random() * 16;
      const a = 0.5 * (1 - y / (h * 0.8));
      const rg = c.createRadialGradient(0, 0, 0, 0, 0, r);
      rg.addColorStop(0, `rgba(255,247,206,${0.35 + a})`);
      rg.addColorStop(0.5, `rgba(206,236,140,${0.2 + a * 0.5})`);
      rg.addColorStop(1, 'rgba(160,210,110,0)');
      c.save();
      c.translate(Math.random() * w, y);
      c.fillStyle = rg;
      c.beginPath();
      c.arc(0, 0, r, 0, TAU);
      c.fill();
      c.restore();
    }
    for (let i = 0; i < 320; i++) { // leaf silhouettes
      c.save();
      c.translate(Math.random() * w, Math.random() * h * 0.92);
      c.rotate(Math.random() * TAU);
      c.fillStyle = ['rgba(24,48,22,0.55)', 'rgba(47,85,38,0.5)', 'rgba(78,122,52,0.42)'][i % 3];
      const s = 5 + Math.random() * 16;
      c.beginPath();
      c.ellipse(0, 0, s, s * 0.42, 0, 0, TAU);
      c.fill();
      c.restore();
    }
  });
}

/** 2x2 atlas of carved capy glyphs. Alpha: only the carving shows on stone. */
function texGlyphs() {
  return canvasTexture(256, 256, (c, w) => {
    c.clearRect(0, 0, w, w);
    const cell = w / 2;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const at = (cx, cy, draw) => {
      c.save();
      c.translate(cx, cy);
      c.strokeStyle = 'rgba(74,66,48,0.75)'; // the cut
      c.lineWidth = 7;
      draw();
      c.strokeStyle = 'rgba(255,246,227,0.5)'; // the lit lip of the cut
      c.lineWidth = 2.6;
      draw();
      c.restore();
    };
    at(cell * 0.5, cell * 0.5, () => { // capybara head
      c.beginPath();
      c.ellipse(0, 4, 34, 26, 0, 0, TAU);
      c.moveTo(-34, -16); c.lineTo(-24, -30);
      c.moveTo(34, -16); c.lineTo(24, -30);
      c.moveTo(-14, 2); c.lineTo(-8, 2);
      c.moveTo(14, 2); c.lineTo(8, 2);
      c.moveTo(-9, 20); c.lineTo(9, 20);
      c.stroke();
    });
    at(cell * 1.5, cell * 0.5, () => { // paw print
      c.beginPath();
      c.ellipse(0, 14, 22, 17, 0, 0, TAU);
      for (let i = 0; i < 4; i++) {
        c.moveTo(-24 + i * 16 + 8, -14);
        c.ellipse(-24 + i * 16, -16, 8, 10, 0, 0, TAU);
      }
      c.stroke();
    });
    at(cell * 0.5, cell * 1.5, () => { // sun over the river
      c.beginPath();
      c.arc(0, -22, 16, 0, TAU);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        c.moveTo(Math.cos(a) * 22, -22 + Math.sin(a) * 22);
        c.lineTo(Math.cos(a) * 32, -22 + Math.sin(a) * 32);
      }
      c.moveTo(-38, 26);
      for (let x = -38; x <= 38; x += 6) c.lineTo(x, 26 + Math.sin(x * 0.18) * 8);
      c.stroke();
    });
    at(cell * 1.5, cell * 1.5, () => { // leaf and spiral
      c.beginPath();
      c.moveTo(0, 36);
      c.quadraticCurveTo(-34, 4, 0, -36);
      c.quadraticCurveTo(34, 4, 0, 36);
      c.moveTo(0, 30); c.lineTo(0, -30);
      c.stroke();
      c.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * 3.6 * Math.PI;
        const r = 1 + i * 0.25;
        const x = Math.cos(a) * r, y = 4 + Math.sin(a) * r;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    });
  });
}

/** The chalk doodle left on the easel slab (drawn straight onto the stone). */
function texEaselSlab() {
  return canvasTexture(320, 256, (c, w, h) => {
    c.fillStyle = '#c9c2a6';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      c.fillStyle = `rgba(141,135,111,${0.1 + Math.random() * 0.2})`;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, 3 + Math.random() * 14, 0, TAU);
      c.fill();
    }
    c.lineCap = 'round';
    c.lineJoin = 'round';
    // a chalk capybara, drawn like a five-year-old means it
    c.strokeStyle = 'rgba(255,250,235,0.92)';
    c.lineWidth = 7;
    c.beginPath();
    c.ellipse(150, 152, 74, 46, 0, 0, TAU);
    c.stroke();
    c.beginPath();
    c.ellipse(92, 104, 40, 33, -0.2, 0, TAU);
    c.stroke();
    c.beginPath();
    c.moveTo(66, 78); c.lineTo(58, 62);
    c.moveTo(112, 72); c.lineTo(112, 54);
    c.moveTo(150, 196); c.lineTo(150, 218);
    c.moveTo(196, 190); c.lineTo(202, 216);
    c.moveTo(104, 190); c.lineTo(98, 216);
    c.stroke();
    c.lineWidth = 10;
    c.beginPath();
    c.moveTo(78, 100); c.lineTo(80, 100);
    c.moveTo(106, 98); c.lineTo(108, 98);
    c.stroke();
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(74, 122);
    c.quadraticCurveTo(92, 136, 108, 120); // grin
    c.stroke();
    c.strokeStyle = 'rgba(255,230,160,0.9)';
    c.lineWidth = 6;
    c.beginPath();
    c.arc(268, 52, 20, 0, TAU);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      c.moveTo(268 + Math.cos(a) * 27, 52 + Math.sin(a) * 27);
      c.lineTo(268 + Math.cos(a) * 36, 52 + Math.sin(a) * 36);
    }
    c.stroke();
    c.strokeStyle = 'rgba(190,232,255,0.9)';
    c.beginPath();
    c.ellipse(256, 198, 32, 19, 0, 0, TAU);
    c.moveTo(288, 198); c.lineTo(308, 180); c.lineTo(308, 216);
    c.closePath();
    c.stroke();
  });
}

/** The live DOODLERS n/8 board. Repainted into the same canvas, forever. */
function drawBoard(c, w, h, n, starting) {
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#fff6e3';
  c.beginPath();
  c.roundRect(6, 6, w - 12, h - 12, 24);
  c.fill();
  c.strokeStyle = '#4e8a34';
  c.lineWidth = 7;
  c.stroke();
  c.fillStyle = '#4e8a34';
  c.beginPath();
  c.roundRect(9, 9, w - 18, 48, [21, 21, 0, 0]);
  c.fill();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#fff6e3';
  c.font = 'bold 32px Trebuchet MS, Verdana, sans-serif';
  c.fillText('DOODLERS', w / 2, 34);
  c.fillStyle = starting ? '#e8657a' : '#2d2417';
  c.font = 'bold 58px Trebuchet MS, Verdana, sans-serif';
  c.fillText(`${n}/8`, w / 2, 97);
  c.fillStyle = '#6b5b3e';
  c.font = 'bold 21px Trebuchet MS, Verdana, sans-serif';
  const sub = starting ? 'crayons up, starting!'
    : n === 0 ? 'grab a log, grab a crayon'
      : n === 1 ? 'one more and we draw'
        : 'the more the merrier';
  c.fillText(sub, w / 2, 136);
}

function texSign(title, sub, accent) {
  return canvasTexture(512, 128, (c, w, h) => {
    c.fillStyle = '#a8783f';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(120,84,44,0.4)';
    for (let i = 0; i < 5; i++) c.fillRect(0, 8 + i * 26, w, 3);
    c.strokeStyle = '#6f4d26';
    c.lineWidth = 8;
    c.strokeRect(4, 4, w - 8, h - 8);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold 52px Georgia, "Times New Roman", serif';
    c.lineWidth = 8;
    c.strokeStyle = '#fff3d8';
    c.strokeText(title, w / 2, sub ? 50 : h / 2);
    c.fillStyle = accent;
    c.fillText(title, w / 2, sub ? 50 : h / 2);
    if (sub) {
      c.font = 'bold 26px Georgia, "Times New Roman", serif';
      c.lineWidth = 5;
      c.strokeStyle = '#fff3d8';
      c.strokeText(sub, w / 2, 96);
      c.fillStyle = '#4a3418';
      c.fillText(sub, w / 2, 96);
    }
  });
}

/** Soft vertical bar: one shaft of light coming through the canopy. */
function texShaft() {
  return canvasTexture(64, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,247,206,0)');
    g.addColorStop(0.14, 'rgba(255,247,206,0.85)');
    g.addColorStop(0.6, 'rgba(214,240,150,0.4)');
    g.addColorStop(1, 'rgba(180,220,120,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const s = c.createLinearGradient(0, 0, w, 0);
    s.addColorStop(0, 'rgba(0,0,0,1)');
    s.addColorStop(0.5, 'rgba(0,0,0,0)');
    s.addColorStop(1, 'rgba(0,0,0,1)');
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = s;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  });
}

/** Falling water: vertical streaks that tile top to bottom. */
function texFall() {
  const t = canvasTexture(128, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(206,238,252,0.5)';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * w;
      const len = 40 + Math.random() * 150;
      const y = Math.random() * h;
      const bw = 2 + Math.random() * 5;
      const g = c.createLinearGradient(0, y, 0, y + len);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.4, `rgba(255,255,255,${0.35 + Math.random() * 0.5})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(x, y, bw, len);
      if (y + len > h) c.fillRect(x, y - h, bw, len); // keep the tile seamless
    }
    const edge = c.createLinearGradient(0, 0, w, 0);
    edge.addColorStop(0, 'rgba(0,0,0,1)');
    edge.addColorStop(0.16, 'rgba(0,0,0,0)');
    edge.addColorStop(0.84, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,1)');
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = edge;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texPool() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#3fa8c9';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 34; i++) {
      c.strokeStyle = `rgba(200,244,255,${0.1 + Math.random() * 0.22})`;
      c.lineWidth = 1 + Math.random() * 3;
      c.beginPath();
      c.ellipse(Math.random() * w, Math.random() * h, 6 + Math.random() * 22,
        3 + Math.random() * 12, Math.random() * 3, 0, TAU);
      c.stroke();
    }
    for (let i = 0; i < 14; i++) {
      c.fillStyle = `rgba(24,84,110,${0.1 + Math.random() * 0.18})`;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, 6 + Math.random() * 16, 0, TAU);
      c.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texRing() {
  return canvasTexture(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.62, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.86, 'rgba(214,244,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

function texDot() {
  return canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2 - 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,250,210,0.7)');
    g.addColorStop(1, 'rgba(255,240,170,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

function texPath() {
  const t = canvasTexture(64, 64, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(120,96,58,0)');
    g.addColorStop(0.25, 'rgba(134,108,66,0.72)');
    g.addColorStop(0.5, 'rgba(146,118,72,0.85)');
    g.addColorStop(0.75, 'rgba(134,108,66,0.72)');
    g.addColorStop(1, 'rgba(120,96,58,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      c.fillStyle = `rgba(96,76,46,${0.16 + Math.random() * 0.3})`;
      c.beginPath();
      c.arc(Math.random() * w, 8 + Math.random() * (h - 16), 0.8 + Math.random() * 2.4, 0, TAU);
      c.fill();
    }
    for (let i = 0; i < 18; i++) {
      c.fillStyle = `rgba(122,199,79,${0.12 + Math.random() * 0.2})`;
      c.beginPath();
      c.arc(Math.random() * w, Math.random() * h, 2 + Math.random() * 5, 0, TAU);
      c.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* --------------------------------------------------------------------------- */

export class JungleRoom extends Room {
  id = 'jungle';
  name = 'The Tangle Jungle';

  build(scene, game) {
    this._t = 0;
    this._game = game;
    this._rng = mulberry32(0x7a41e5);
    this._dummy = new THREE.Object3D();
    this._v = new THREE.Vector3();

    // doodle lobby state (see the header note for the wire protocol)
    this._doodlers = new Map(); // playerId -> { avatar, slot, tag, hidden }
    this._lobbyCount = 0;
    this._lobbyStarting = false;
    this._localSeat = null;
    this._offLobby = null;
    this._offStart = null;
    this._wasOnline = !!game?.net?.connected;
    this._reconcileT = 0;

    scene.background = new THREE.Color(0x2a4426);
    scene.fog = new THREE.Fog(0x33502c, 20, 64);
    // world clock (wave 7): the canopy light dims after dusk and the fireflies
    // take the clearing over. Preallocated so onClock never allocates.
    this._bg = scene.background;
    this._fog = scene.fog;
    // all three neutral until a clock frame lands, so an offline visit looks
    // exactly like it always has
    this._dayK = 1;   // god rays / shafts
    this._lampK = 1;  // the ruin uplight
    this._flyK = 1;   // firefly brightness (onClock makes them shy by day)
    this._dayCol = new THREE.Color(0x2a4426);
    this._nightCol = new THREE.Color(0x0c1620);
    this._fogDay = new THREE.Color(0x33502c);
    this._fogNight = new THREE.Color(0x11202a);

    this._lights(scene);
    this._sky(scene);
    this._ground(scene);
    this._paths(scene);
    this._cliff(scene);
    this._pool(scene);
    this._ruin(scene);
    this._circle(scene);
    this._trees(scene);
    this._undergrowth(scene);
    this._vines(scene);
    this._flowers(scene);
    this._critters(scene);
    this._motes(scene);
    this._godRays(scene);
    this._exit(scene);

    // Arrivals land south of the clearing, facing the ruin: the easel, the
    // board and the waterfall are all in the first frame you ever see.
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 6),
      from_beach: new THREE.Vector3(0.7, 0, 8.6), // exit-beach is (0.7, 12.6) r=3
    };

    this._joinSpot = {
      id: 'doodle-join',
      position: new THREE.Vector3(EASEL.x, DAIS.h, EASEL.z),
      radius: 5.0, // reaches every drum log, so "Hop off" is always in reach
      label: this._joinLabel(),
      action: (g) => {
        if (g.net?.connected) {
          g.net.send({ t: this._localSeat === null ? 'dd-join' : 'dd-leave' });
        } else {
          // offline: no circle to join, so the easel just starts a solo round
          g.__partyCtx = null;
          g.startMinigame('doodle');
        }
      },
    };
    this.hotspots.push(
      this._joinSpot,
      {
        // the guessing stone: its own prop a few steps east, so the solo prompt
        // and the lobby prompt never stack on top of each other on screen
        id: 'doodle-solo',
        position: new THREE.Vector3(6.4, 0, -3.6),
        radius: 2.6,
        label: "Guess the bot's doodles",
        action: (g) => {
          g.__partyCtx = null;
          g.startMinigame('doodle');
        },
      },
      {
        // stands on the dry shelf south-east of the pool: the water collider
        // (r 3.35) reaches 3.35 out, this sits 3.94 out and reads from the bank
        id: 'falls',
        position: new THREE.Vector3(-6.0, 0, -1.8),
        radius: 2.4,
        label: 'Dip your paws in the falls',
        action: (g) => {
          g.audio?.play?.('splash');
          g.toast('Cold! Wonderful. A butterfly lands on your nose.');
        },
      },
      {
        id: 'exit-beach',
        position: new THREE.Vector3(0.7, 0, 12.6),
        radius: 3,
        label: 'Take the path back to Driftwood Beach',
        action: (g) => g.goToRoom('beach', 'jungle'),
      },
    );

    this.cameraHint = { offset: new THREE.Vector3(0, 12.5, 18.5), lookHeight: 1.4 };
    // Static camera: down the hole in the canopy at the clearing, the ruin
    // terrace north and the falls west. The near-top-down pass (0,36,17) paid
    // for that with the room: a capy came out 10px tall and the beach exit
    // prompt projected clean off the bottom of the frame (NDC -1.09), so from
    // the whole-room view you could neither see yourself nor find the way out.
    // Standing further off and much flatter (30 degrees, near the world default
    // 36) keeps the canopy as a frame instead of a lid, and does it without
    // looking through the south tree line: 34px capy, every prompt inside NDC
    // 0.56, the doodle easel clear of the top HUD band at 96px.
    this.staticCamera = {
      position: new THREE.Vector3(0, 18, 31),
      lookAt: new THREE.Vector3(0, 1.5, 2),
    };

    // Live only while this room is: both handles are dropped in dispose().
    if (game?.events?.on) {
      this._offLobby = game.events.on('dd-lobby', (m) => this._onLobby(m));
      this._offStart = game.events.on('dd-start', (m) => this._onStart(m));
    }

    scene.updateMatrixWorld(true); // ground raycasts happen before the first render
  }

  /* --- doodle lobby ------------------------------------------------------- */

  _joinLabel() {
    if (!this._game?.net?.connected) return 'Doodle at the stone easel';
    if (this._localSeat !== null) return 'Hop off the log';
    return `Join the doodle circle (${this._lobbyCount}/8)`;
  }

  /** Repaint the tally board in place (one canvas, one texture, forever). */
  _paintBoard() {
    const tex = this._boardTex;
    const cv = tex?.image;
    if (!cv?.getContext) return;
    drawBoard(cv.getContext('2d'), cv.width, cv.height, this._lobbyCount, this._lobbyStarting);
    tex.needsUpdate = true;
  }

  /** Server->client 'dd-lobby': {players:[{id,name}], starting}. */
  _onLobby(m) {
    const game = this._game;
    const players = Array.isArray(m?.players) ? m.players.slice(0, SEATS.length) : [];
    const selfId = game?.net?.selfId ?? null;
    const seen = new Set();
    let localSeat = null;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.id === undefined || p.id === null) continue;
      if (selfId !== null && p.id === selfId) { localSeat = i; continue; }
      seen.add(p.id);
      this._addDoodler(p.id, p.name, i);
    }
    for (const id of [...this._doodlers.keys()]) if (!seen.has(id)) this._removeDoodler(id);

    this._lobbyCount = players.length;
    this._lobbyStarting = !!m?.starting;
    this._setLocalSeat(localSeat);
    this._paintBoard();
    this._refreshJoinLabel();
  }

  /** Sit a remote lobby member on their drum log. */
  _addDoodler(id, name, slot) {
    const existing = this._doodlers.get(id);
    if (existing) {
      if (existing.slot === slot) return;
      this._removeDoodler(id);
    }
    const s = SEATS[slot];
    if (!s || !this._seatGroup) return;
    const game = this._game;
    const remote = game?.net?.remotes?.get?.(id) || null;
    const avatar = createAvatar({
      color: remote?.p?.color ?? DEFAULT_FUR,
      hat: remote?.p?.hat ?? 'none',
    });
    avatar.setAnim('sit');
    avatar.group.position.set(s.x, SEAT_Y, s.z);
    avatar.group.rotation.y = s.yaw;
    this._seatGroup.add(avatar.group);

    // The same capybara is also drawn by the net client wherever they happen to
    // be standing. Park their networked body offscreen while they are seated
    // here so the room never shows the same player twice; _restoreRemote puts
    // it (and its name tag, which hides itself once unparented) straight back.
    let hidden = null;
    if (remote?.avatar?.group?.parent) {
      hidden = remote.avatar.group;
      hidden.parent.remove(hidden);
    }
    const tag = game?.engine?.attachNameTag?.(avatar.group, name || 'Capybara') || null;
    this._doodlers.set(id, { avatar, slot, tag, hidden });
    game?.audio?.play?.('pop');
  }

  _removeDoodler(id) {
    const r = this._doodlers.get(id);
    if (!r) return;
    this._doodlers.delete(id);
    r.tag?.remove?.();
    this._seatGroup?.remove(r.avatar.group);
    r.avatar.dispose();
    this._restoreRemote(id, r.hidden);
  }

  /** Late-bind seats to their networked record: real fur, real hat, no double. */
  _reconcileDoodlers() {
    const remotes = this._game?.net?.remotes;
    if (!remotes?.get) return;
    for (const [id, r] of this._doodlers) {
      if (r.hidden) continue;
      const remote = remotes.get(id);
      const g = remote?.avatar?.group;
      if (!g?.parent) continue;
      r.hidden = g;
      g.parent.remove(g);
      if (typeof remote.p?.color === 'number') r.avatar.setColor(remote.p.color);
      if (remote.p?.hat) r.avatar.setHat(remote.p.hat);
    }
  }

  /** Re-parent a networked avatar we hid, but only if it is still that player's. */
  _restoreRemote(id, group) {
    if (!group) return;
    const remote = this._game?.net?.remotes?.get?.(id);
    const remoteGroup = this._game?.engine?.remoteGroup;
    if (!remoteGroup || remote?.avatar?.group !== group) return; // they left; net client owns it
    if (!group.parent) remoteGroup.add(group);
  }

  /** Walk the local capybara onto (or off) their log. */
  _setLocalSeat(slot) {
    if (slot === this._localSeat) return;
    const game = this._game;
    const engine = game?.engine;
    const avatar = engine?.playerAvatar;
    if (slot !== null) {
      const s = SEATS[slot];
      if (s && engine?.controller) engine.controller.setTarget(this._v.set(s.x, 0, s.z));
      game?.audio?.play?.('whoosh');
      game?.toast?.('You have a log and a crayon. Hop off any time.');
    } else if (avatar) {
      if (avatar.state.anim === 'sit') avatar.setAnim('idle');
      engine?.snapY?.(avatar.group.position, this);
      game?.audio?.play?.('click');
    }
    this._localSeat = slot;
  }

  /** Server->client 'dd-start': stash the ctx, then launch the doodle game. */
  _onStart(m) {
    const game = this._game;
    if (!game || !m) return;
    this._clearLobby(); // the server started the round either way
    // Already inside a minigame (a solo round started from the guessing stone
    // while the circle filled): startMinigame would no-op and the ctx would sit
    // there waiting to turn some later solo run into a phantom round. Bow out.
    if (game.activeMinigame) {
      game.net?.send?.({ t: 'dd-leave' });
      game.toast?.('The circle started without you: you were already doodling!');
      return;
    }
    // the shape doodle.js reads: `game` names which party game this is (the
    // mine parks a 'prophunt' ctx on the same key), and `youAre` is our server
    // id as a STRING, never an index into players
    const selfId = game.net?.selfId;
    game.__partyCtx = {
      game: 'doodle',
      seed: Number(m.seed) || 0,
      players: Array.isArray(m.players) ? m.players : [],
      rounds: Number(m.rounds) || undefined, // absent -> doodle.js uses players.length
      youAre: typeof selfId === 'string' ? selfId : undefined,
    };
    game.toast?.('Crayons up: the doodle circle is starting!');
    game.startMinigame('doodle');
  }

  /** Empty every log (round launched, or the room is going away). */
  _clearLobby() {
    for (const id of [...this._doodlers.keys()]) this._removeDoodler(id);
    this._lobbyCount = 0;
    this._lobbyStarting = false;
    this._setLocalSeat(null);
    this._paintBoard();
    this._refreshJoinLabel();
  }

  /**
   * Push the label onto the prompt. The engine writes textContent once, when it
   * spawns the button, so a live label has to patch the element in place.
   */
  _refreshJoinLabel() {
    const spot = this._joinSpot;
    if (!spot) return;
    const label = this._joinLabel();
    if (label === spot.label) return;
    spot.label = label;
    const el = this._game?.engine?.hotspotEls?.get?.(spot);
    if (el) el.textContent = label;
  }

  /* --- lighting ----------------------------------------------------------- */

  _lights(scene) {
    // green bounce off a million leaves, warm gold coming through the gaps
    this._hemi = new THREE.HemisphereLight(0xbdea86, 0x28401e, 1.25);
    scene.add(this._hemi);
    this._amb = new THREE.AmbientLight(0x93c86a, 0.3);
    scene.add(this._amb);

    const sun = new THREE.DirectionalLight(0xfff3c4, 1.75);
    sun.position.set(15, 26, -17); // high and north-east, with the god rays
    sun.target.position.set(0, 0, -3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.04;
    const sc = sun.shadow.camera;
    sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18;
    sc.near = 2; sc.far = 72;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);
    this._sun = sun;

    // the ruin gets its own warm uplight, the pool a cold one off the spray
    this._ruinLight = new THREE.PointLight(0xffd98a, 5.5, 15, 2);
    this._ruinLight.position.set(0, 4.4, -6.2); // in front of the easel, not on it
    scene.add(this._ruinLight);
    this._poolLight = new THREE.PointLight(0xbdefff, 11, 15, 2);
    this._poolLight.position.set(POOL.x + 0.4, 1.6, POOL.z - 0.6);
    scene.add(this._poolLight);
  }

  /* --- the canopy overhead ------------------------------------------------ */

  _sky(scene) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(44, 32, 20, 0, TAU, 0, Math.PI * 0.6),
      flatMat(texCanopy(), { double: false }),
    );
    dome.material.side = THREE.BackSide;
    dome.material.fog = false;
    dome.material.depthWrite = false;
    dome.material.needsUpdate = true;
    dome.renderOrder = -10;
    scene.add(dome);
    this._domeMat = dome.material;
  }

  /* --- world clock (wave 7) ------------------------------------------------ */

  /** What time of day changes here is the light, nothing else. The sun through
   *  the canopy fades out after dusk, the shafts go with it, and the fireflies
   *  (which have always been here, blinking at the rim) come up to carry the
   *  clearing. Deliberate scope note: this pass is a light touch, so the
   *  `weather` argument is ignored: no rain streaks, no puddles, no new props
   *  and no layout changes under the canopy. */
  onClock(dayT) {
    const lit = daylight(dayT);
    const night = 1 - lit;
    this._sun.intensity = 0.08 + 1.67 * lit;
    this._sun.color.setHex(lit > 0.55 ? 0xfff3c4 : lit > 0.25 ? 0xffc98a : 0xb9c8ee);
    // hemisphere fill never falls past the playability floor: the clearing has
    // to stay readable at 2am (LIVING-COVE budgets, "never fully dark")
    this._hemi.intensity = 0.5 + 0.75 * lit;
    this._amb.intensity = 0.16 + 0.14 * lit;
    this._bg.copy(this._nightCol).lerp(this._dayCol, lit);
    this._fog.color.copy(this._fogNight).lerp(this._fogDay, lit);
    // the canopy is unlit (flatMat), so it only darkens if we tint it
    const k = 0.28 + 0.72 * lit;
    this._domeMat.color.setRGB(k * 0.86, k, k * 0.94);
    this._dayK = 0.08 + 0.92 * lit;      // update() rides these two
    this._lampK = 1 + 0.8 * night;
    // fireflies: shy and few by day, the whole swarm out and burning at night
    this._flyK = 0.22 + 1.4 * night;
    if (this._fireflies) {
      const n = Math.max(6, Math.round(this._fireflyData.length * (0.25 + 0.75 * night)));
      this._fireflies.geometry.setDrawRange(0, n);
    }
  }

  /* --- ground ------------------------------------------------------------- */

  _ground(scene) {
    const SEG = 76, RINGS = 28;
    const vCount = (SEG + 1) * (RINGS + 1);
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx = new Uint16Array(SEG * RINGS * 6);
    for (let j = 0; j <= RINGS; j++) {
      // rings bunch up toward the middle where the play space is
      const rf = (j / RINGS) ** 1.25;
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * TAU;
        const r = GROUND_R * rf;
        const x = CLEAR.x + Math.cos(th) * r;
        const z = CLEAR.z + Math.sin(th) * r;
        const k = j * (SEG + 1) + i;
        pos[k * 3] = x; pos[k * 3 + 1] = groundH(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = x / 6.5; uv[k * 2 + 1] = z / 6.5;
      }
    }
    let ii = 0;
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * (SEG + 1) + i;
        const b = (j + 1) * (SEG + 1) + i;
        idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = a + 1; idx[ii++] = b + 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();

    const floor = new THREE.Mesh(g, texMat(texFloor()));
    floor.receiveShadow = true;
    scene.add(floor);
    this.groundMeshes = [floor];

    // Skirt: the plate ends at r 23 on a 4.2 berm crest, and the follow camera
    // can get high enough to peek over it. This wall means the peek lands on
    // dark undergrowth instead of on the void.
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(GROUND_R - 0.1, GROUND_R - 0.1, 15, 48, 1, true),
      makeToon(0x24401e, { unique: true, side: THREE.DoubleSide }),
    );
    skirt.position.set(CLEAR.x, 4.2 - 7.5, CLEAR.z);
    scene.add(skirt);
  }

  /** The trodden path in from the beach, and flagstones up to the ruin. */
  _paths(scene) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.9, 0, 16.5),
      new THREE.Vector3(0.6, 0, 12.5),
      new THREE.Vector3(0.2, 0, 8.0),
      new THREE.Vector3(-0.4, 0, 4.4),
      new THREE.Vector3(0, 0, 0.6),
      new THREE.Vector3(0.1, 0, -2.8),
    ]);
    const N = 40;
    const pp = new Float32Array((N + 1) * 2 * 3);
    const pu = new Float32Array((N + 1) * 2 * 2);
    const pi = new Uint16Array(N * 6);
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u);
      const tg = curve.getTangentAt(u);
      const nx = -tg.z, nz = tg.x;
      const hw = 1.35 + Math.sin(u * 5.3) * 0.18;
      const k = i * 2;
      for (let s = 0; s < 2; s++) {
        const sgn = s ? 1 : -1;
        const x = p.x + nx * hw * sgn, z = p.z + nz * hw * sgn;
        pp[(k + s) * 3] = x;
        pp[(k + s) * 3 + 1] = groundH(x, z) + 0.04;
        pp[(k + s) * 3 + 2] = z;
        pu[(k + s) * 2] = u * 9;
        pu[(k + s) * 2 + 1] = s;
      }
      if (i < N) {
        const o = i * 6;
        pi[o] = k; pi[o + 1] = k + 1; pi[o + 2] = k + 2;
        pi[o + 3] = k + 1; pi[o + 4] = k + 3; pi[o + 5] = k + 2;
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    pg.setAttribute('uv', new THREE.BufferAttribute(pu, 2));
    pg.setIndex(new THREE.BufferAttribute(pi, 1));
    pg.computeVertexNormals();
    const path = new THREE.Mesh(pg, flatMat(texPath(), { decal: true }));
    path.renderOrder = 1;
    scene.add(path);

    // flagstones from the clearing up to the terrace steps
    const stoneG = new THREE.CylinderGeometry(0.62, 0.66, 0.1, 9);
    const flags = new THREE.InstancedMesh(stoneG, texMat(texStone()), 16);
    flags.receiveShadow = true;
    const d = this._dummy;
    const col = new THREE.Color();
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const u = i / 7;
      const x = 0.1 + Math.sin(u * 2.6) * 0.5;
      const z = -2.6 - u * 3.2;
      for (const sx of [-0.62, 0.62]) {
        if (n >= 16) break;
        d.position.set(x + sx, groundH(x + sx, z) + 0.05, z + (sx > 0 ? 0.34 : 0));
        d.rotation.set(0, this._rng() * TAU, 0);
        d.scale.setScalar(0.8 + this._rng() * 0.35);
        d.updateMatrix();
        flags.setMatrixAt(n, d.matrix);
        col.setHex(0xffffff).offsetHSL(0, 0, (this._rng() - 0.5) * 0.1);
        flags.setColorAt(n, col);
        n++;
      }
    }
    flags.count = n;
    d.scale.setScalar(1);
    flags.instanceMatrix.needsUpdate = true;
    if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
    flags.computeBoundingSphere();
    scene.add(flags);
  }

  /* --- the escarpment and the waterfall ----------------------------------- */

  _cliff(scene) {
    const rock = [];
    const yaw = CLIFF_YAW;
    // front wall: seven blocks along the line, the one at the notch cut low so
    // the stream has somewhere to spill from
    for (let i = 0; i < 7; i++) {
      const t = 0.3 + i * 1.65;
      const p = cliffPoint(t, (this._rng() - 0.5) * 0.5);
      const notch = Math.abs(t - FALL_T) < 0.9;
      const h = notch ? FALL_TOP + 1.5 : 7.2 + this._rng() * 1.6;
      part(rock, new THREE.BoxGeometry(2.1, h, 3.4), i % 2 ? C.stoneLit : C.stone, {
        ry: yaw + (this._rng() - 0.5) * 0.12, x: p.x, y: h / 2 - 1.7, z: p.z,
      });
      // mossy cap slab
      part(rock, new THREE.BoxGeometry(2.3, 0.34, 3.6), notch ? C.jade : C.moss, {
        ry: yaw, x: p.x, y: h - 1.7, z: p.z,
      });
    }
    // back row: taller, so the wall reads as a ridge and not a fence
    for (let i = 0; i < 5; i++) {
      const p = cliffPoint(0.6 + i * 2.4, -2.9);
      const h = 9.4 + this._rng() * 2.2;
      part(rock, new THREE.BoxGeometry(3.0, h, 3.2), i % 2 ? C.stone : C.stoneDark, {
        ry: yaw + (this._rng() - 0.5) * 0.3, x: p.x, y: h / 2 - 2.4, z: p.z,
      });
      part(rock, new THREE.SphereGeometry(1.5, 8, 6), C.jade, {
        sy: 0.5, x: p.x, y: h - 2.5, z: p.z,
      });
    }
    // boulders tumbled at the foot of the face
    for (let i = 0; i < 10; i++) {
      const p = cliffPoint(this._rng() * CLIFF_LEN, CLIFF_HALF_D + 0.4 + this._rng() * 0.9);
      if (Math.hypot(p.x - POOL.x, p.z - POOL.z) < POOL.r + 0.5) continue; // not in the water
      const s = 0.5 + this._rng() * 0.9;
      const g = new THREE.IcosahedronGeometry(s, 0);
      g.computeVertexNormals();
      part(rock, g, i % 3 ? C.stone : C.moss, {
        ry: this._rng() * TAU, rx: this._rng() * 0.5,
        x: p.x, y: groundH(p.x, p.z) + s * 0.55, z: p.z,
      });
    }
    const cliff = new THREE.Mesh(mergeParts(rock), texMat(texRock(), { vc: true }));
    cliff.castShadow = true;
    cliff.receiveShadow = true;
    scene.add(cliff);

    for (let i = 0; i <= 4; i++) {
      const p = cliffPoint((i / 4) * CLIFF_LEN, 0);
      this.obstacles.push({ x: p.x, z: p.z, r: 2.3 });
    }

    // ---- the fall itself: a scrolling sheet in a group yawed to the face
    const fg = new THREE.Group();
    fg.position.set(FALL_FACE.x, 0, FALL_FACE.z);
    fg.rotation.y = yaw;
    scene.add(fg);

    this._fallTex = texFall();
    this._fallTex.repeat.set(1, 2.2);
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 6.4, 1, 7),
      flatMat(this._fallTex, { opacity: 0.92, double: true }),
    );
    sheet.position.set(0, 1.85, 0.14); // top 5.05, tucked under the lip below
    sheet.rotation.x = -0.05;
    fg.add(sheet);

    // overhanging lip: hides the top edge of the sheet and gives the water
    // something to pour off
    const ledge = [];
    part(ledge, new THREE.BoxGeometry(2.9, 0.5, 1.3), C.stoneLit, { y: 5.2, z: 0.45 });
    part(ledge, new THREE.BoxGeometry(3.1, 0.22, 1.4), C.moss, { y: 5.46, z: 0.45 });
    part(ledge, new THREE.SphereGeometry(0.3, 7, 5), C.leafDark, { sy: 0.5, x: -1.2, y: 5.6, z: 0.6 });
    part(ledge, new THREE.SphereGeometry(0.26, 7, 5), C.leaf, { sy: 0.5, x: 1.3, y: 5.6, z: 0.5 });
    fg.add(solidMesh(ledge));

    // the lip: water bending over the edge before it falls
    const lipTex = texFall();
    lipTex.repeat.set(1, 0.5);
    const lip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 2.3, 10, 1, true, Math.PI * 0.5, Math.PI * 0.6),
      flatMat(lipTex, { opacity: 0.9, double: true }),
    );
    lip.rotation.z = Math.PI / 2;
    lip.position.set(0, FALL_TOP + 0.42, -0.42);
    fg.add(lip);
    this._lipTex = lipTex;

    // ---- impact: foam disc, expanding rings, drifting mist
    const foam = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 20),
      flatMat(texRing(), { additive: true, opacity: 0.85 }),
    );
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(FALL_FACE.x + 0.1, POOL_Y + 0.05, FALL_FACE.z + 0.14);
    scene.add(foam);
    this._foam = foam;

    const ringG = new THREE.PlaneGeometry(1, 1);
    ringG.rotateX(-Math.PI / 2);
    this._rings = new THREE.InstancedMesh(ringG, flatMat(texRing(), { additive: true, opacity: 0.75 }), 3);
    this._rings.frustumCulled = false;
    scene.add(this._rings);

    const MIST = 64;
    const mp = new Float32Array(MIST * 3);
    const mc = new Float32Array(MIST * 3);
    this._mist = [];
    for (let i = 0; i < MIST; i++) {
      this._mist.push({
        a: this._rng() * TAU,
        r: this._rng() * 1.3,
        t: this._rng(),
        sp: 0.35 + this._rng() * 0.5,
        drift: (this._rng() - 0.5) * 0.5,
      });
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('color', new THREE.BufferAttribute(mc, 3));
    const mmat = new THREE.PointsMaterial({
      size: 0.7, map: texDot(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true, opacity: 0.5,
    });
    this._mistPts = new THREE.Points(mg, mmat);
    this._mistPts.frustumCulled = false;
    scene.add(this._mistPts);
  }

  /* --- the pool ----------------------------------------------------------- */

  _pool(scene) {
    this._poolTex = texPool();
    const wg = new THREE.CircleGeometry(POOL.r, 30, 0, TAU);
    const water = new THREE.Mesh(wg, texMat(this._poolTex));
    water.material.transparent = true;
    water.material.opacity = 0.88;
    water.rotation.x = -Math.PI / 2;
    water.position.set(POOL.x, POOL_Y, POOL.z);
    scene.add(water);
    this._water = water;
    this._waterBase = Float32Array.from(wg.attributes.position.array);

    // NOT walkable: the basin under it is, so a click on the water walks you to
    // the shore and this collider is what actually stops you going in
    this.obstacles.push({ x: POOL.x, z: POOL.z, r: POOL.r + 0.25 });

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(POOL.r - 0.06, 0.09, 5, 30),
      flatMat(null, { opacity: 0.6, additive: true }),
    );
    rim.material.color.setHex(C.foam);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(POOL.x, POOL_Y + 0.03, POOL.z);
    scene.add(rim);
    this._poolRim = rim;

    // mossy stones around the waterline, and reeds on the south shore
    const stones = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU + this._rng() * 0.2;
      const r = POOL.r + 0.6 + this._rng() * 0.8;
      const x = POOL.x + Math.cos(a) * r;
      const z = POOL.z + Math.sin(a) * r;
      const s = 0.26 + this._rng() * 0.34;
      const g = new THREE.IcosahedronGeometry(s, 0);
      g.computeVertexNormals();
      part(stones, g, i % 4 ? C.stoneLit : C.moss, {
        ry: this._rng() * TAU, rx: this._rng() * 0.6,
        x, y: groundH(x, z) + s * 0.4, z,
      });
    }
    for (let i = 0; i < 9; i++) {
      const a = 0.55 + (i / 9) * 2.1;
      const r = POOL.r + 0.9;
      const x = POOL.x + Math.cos(a) * r;
      const z = POOL.z + Math.sin(a) * r;
      for (let k = 0; k < 4; k++) {
        part(stones, new THREE.ConeGeometry(0.05, 1.1 + this._rng() * 0.7, 4),
          k % 2 ? C.leaf : C.leafDark, {
            rz: (this._rng() - 0.5) * 0.5, rx: (this._rng() - 0.5) * 0.4,
            x: x + (this._rng() - 0.5) * 0.5, y: groundH(x, z) + 0.55, z: z + (this._rng() - 0.5) * 0.5,
          });
      }
    }
    scene.add(solidMesh(stones));
  }

  /* --- the ruin terrace, the easel and the board -------------------------- */

  _ruin(scene) {
    const stoneTex = texStone();

    // ---- terrace + steps: all walkable, all in groundMeshes
    const dais = new THREE.Mesh(
      new THREE.CylinderGeometry(DAIS.r, DAIS.r + 0.16, DAIS.h, 20),
      texMat(stoneTex),
    );
    dais.position.set(DAIS.x, DAIS.h / 2, DAIS.z);
    dais.receiveShadow = true;
    dais.castShadow = true;
    scene.add(dais);

    const stepMat = texMat(stoneTex);
    const stepA = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.14, 0.9), stepMat);
    stepA.position.set(0, 0.07, -5.1);
    const stepB = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.28, 0.8), stepMat);
    stepB.position.set(0, 0.14, -5.8);
    for (const s of [stepA, stepB]) { s.receiveShadow = true; scene.add(s); }
    this.groundMeshes.push(dais, stepA, stepB);

    // ---- standing stones, broken arch, toppled column
    const ruin = [];
    const menhir = [[-2.35, -8.9, 0.09], [2.35, -8.9, -0.07]];
    for (const [x, z, tilt] of menhir) {
      part(ruin, new THREE.BoxGeometry(0.95, 3.4, 0.62), C.stone, {
        rz: tilt, x, y: DAIS.h + 1.65, z,
      });
      part(ruin, new THREE.BoxGeometry(1.05, 0.26, 0.72), C.moss, {
        rz: tilt, x, y: DAIS.h + 3.4, z,
      });
      this.obstacles.push({ x, z, r: 0.6 });
    }
    for (const sx of [-1.9, 1.9]) { // arch legs behind the easel
      part(ruin, new THREE.BoxGeometry(0.8, 4.2, 0.8), C.stoneDark, {
        x: sx, y: DAIS.h + 2.1, z: -11.1,
      });
      this.obstacles.push({ x: sx, z: -11.1, r: 0.6 });
    }
    part(ruin, new THREE.BoxGeometry(5.0, 0.7, 0.9), C.stone, { x: 0, y: DAIS.h + 4.55, z: -11.1 });
    part(ruin, new THREE.BoxGeometry(1.5, 0.5, 1.0), C.moss, { x: -1.1, y: DAIS.h + 5.0, z: -11.1 });
    part(ruin, new THREE.BoxGeometry(0.9, 0.36, 1.0), C.mossLit, { x: 1.5, y: DAIS.h + 4.95, z: -11.1 });
    // a leg that lost its arch: broken stub + the lintel it dropped
    part(ruin, new THREE.BoxGeometry(0.8, 1.5, 0.8), C.stoneDark, { rz: 0.08, x: 4.6, y: 0.7, z: -10.4 });
    part(ruin, new THREE.CylinderGeometry(0.42, 0.46, 3.6, 9), C.stone, {
      rz: Math.PI / 2, ry: 0.5, x: 5.4, y: 0.44, z: -8.6,
    });
    this.obstacles.push({ x: 4.6, z: -10.4, r: 0.6 }, { x: 5.4, z: -8.6, r: 1.1 });
    // moss-furred rubble scattered off the terrace
    for (let i = 0; i < 12; i++) {
      const a = this._rng() * TAU;
      const r = DAIS.r + 0.7 + this._rng() * 2.4;
      const x = DAIS.x + Math.cos(a) * r, z = DAIS.z + Math.sin(a) * r;
      const s = 0.24 + this._rng() * 0.34;
      const g = new THREE.IcosahedronGeometry(s, 0);
      g.computeVertexNormals();
      part(ruin, g, i % 2 ? C.stone : C.moss, {
        ry: this._rng() * TAU, x, y: groundH(x, z) + s * 0.5, z,
      });
    }
    const ruinMesh = new THREE.Mesh(mergeParts(ruin), texMat(stoneTex, { vc: true }));
    ruinMesh.castShadow = true;
    ruinMesh.receiveShadow = true;
    scene.add(ruinMesh);

    // ---- capy glyphs, carved into the south faces so the camera reads them
    const glyphs = [];
    part(glyphs, atlasPlane(0.72, 0.72, 0, 1), 0xffffff, { x: -2.35, y: DAIS.h + 1.9, z: -8.57 });
    part(glyphs, atlasPlane(0.72, 0.72, 1, 1), 0xffffff, { x: 2.35, y: DAIS.h + 2.05, z: -8.57 });
    part(glyphs, atlasPlane(0.62, 0.62, 1, 0), 0xffffff, { x: -1.4, y: DAIS.h + 4.55, z: -11.55 });
    part(glyphs, atlasPlane(0.62, 0.62, 0, 0), 0xffffff, { x: 1.4, y: DAIS.h + 4.55, z: -11.55 });
    part(glyphs, atlasPlane(0.6, 0.6, 0, 0), 0xffffff, { rx: -Math.PI / 2, ry: 0.5, x: 5.2, y: 0.9, z: -8.2 });
    const glyphMesh = new THREE.Mesh(mergeParts(glyphs), flatMat(texGlyphs(), { double: true }));
    glyphMesh.material.alphaTest = 0.05;
    glyphMesh.material.needsUpdate = true;
    scene.add(glyphMesh);

    // ---- the easel: a slab of slate in a stone frame, leaning back a touch
    const easel = new THREE.Group();
    easel.position.set(EASEL.x, DAIS.h, EASEL.z);
    easel.rotation.x = -0.12;
    scene.add(easel);
    const frame = [];
    part(frame, new THREE.BoxGeometry(3.5, 0.36, 0.9), C.stone, { y: 0.18 });
    for (const sx of [-1.55, 1.55]) {
      part(frame, new THREE.BoxGeometry(0.34, 2.9, 0.42), C.stone, { y: 1.5, x: sx });
    }
    part(frame, new THREE.BoxGeometry(3.5, 0.42, 0.5), C.stoneLit, { y: 2.9 });
    part(frame, new THREE.BoxGeometry(0.9, 0.3, 0.34), C.moss, { y: 3.11, x: -0.9 });
    part(frame, new THREE.BoxGeometry(2.9, 0.22, 0.36), C.stoneDark, { y: 0.5, z: 0.22 }); // chalk ledge
    easel.add(solidMesh(frame));
    // unlit: the ruin uplight was blowing the chalk clean off the slab
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.15), flatMat(texEaselSlab()));
    slab.position.set(0, 1.72, 0.24);
    easel.add(slab);
    // crayon pot on the ledge
    const pot = [];
    part(pot, new THREE.CylinderGeometry(0.2, 0.17, 0.3, 9), C.bark, { y: 0.76, x: 1.02, z: 0.24 });
    for (let i = 0; i < 5; i++) {
      part(pot, new THREE.CylinderGeometry(0.045, 0.045, 0.5, 5),
        [C.coral, C.gold, C.leaf, C.water, C.cream][i], {
          rz: (i - 2) * 0.13, x: 1.02 + (i - 2) * 0.05, y: 1.06, z: 0.24,
        });
    }
    easel.add(solidMesh(pot, { shadow: false }));
    this.obstacles.push({ x: EASEL.x, z: EASEL.z, r: 1.15 });

    // ---- the live DOODLERS board, hanging over the easel facing the camera
    const board = new THREE.Group();
    board.position.set(0, 4.7, EASEL.z + 0.2);
    scene.add(board);
    const backing = [];
    part(backing, new THREE.BoxGeometry(3.3, 1.72, 0.16), C.bark, {});
    part(backing, new THREE.BoxGeometry(3.5, 0.2, 0.24), C.barkLit, { y: 0.82 });
    part(backing, new THREE.SphereGeometry(0.15, 8, 6), C.gold, { x: -1.55, y: 0.9, z: 0.02 });
    part(backing, new THREE.SphereGeometry(0.15, 8, 6), C.gold, { x: 1.55, y: 0.9, z: 0.02 });
    board.add(solidMesh(backing, { shadow: false }));
    this._boardTex = canvasTexture(320, 160, (c, w, h) => drawBoard(c, w, h, 0, false));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.5), flatMat(this._boardTex));
    face.position.z = 0.1;
    board.add(face);
    this._board = board;
    this._boardY = 4.7;
    // vines lashing the board to the arch above it
    const rope = [];
    link(rope, [-1.3, 0.86, 0], [-0.9, 2.4, -0.5], 0.05, C.leafDark);
    link(rope, [1.3, 0.86, 0], [0.9, 2.4, -0.5], 0.05, C.leafDark);
    board.add(solidMesh(rope, { shadow: false }));

    // ---- the guessing stone: the solo door, its own prop east of the ruin
    const gs = new THREE.Group();
    gs.position.set(6.4, 0, -3.6);
    scene.add(gs);
    const gsParts = [];
    part(gsParts, new THREE.CylinderGeometry(0.85, 1.0, 0.9, 10), C.stone, { y: 0.45 });
    part(gsParts, new THREE.BoxGeometry(1.5, 0.22, 1.1), C.stoneLit, { rx: -0.34, y: 1.02 });
    part(gsParts, new THREE.SphereGeometry(0.4, 8, 6), C.moss, { sy: 0.4, x: -0.7, y: 0.3, z: 0.5 });
    gs.add(solidMesh(gsParts));
    const gsFace = new THREE.Mesh(atlasPlane(0.8, 0.8, 0, 0), flatMat(texGlyphs(), { double: true }));
    gsFace.material.alphaTest = 0.05;
    gsFace.material.needsUpdate = true;
    gsFace.position.set(0, 1.16, 0.16);
    gsFace.rotation.x = -1.22;
    gs.add(gsFace);
    this.obstacles.push({ x: 6.4, z: -3.6, r: 1.15 });
  }

  /* --- the doodle circle: eight drum logs ---------------------------------- */

  _circle(scene) {
    const logParts = [];
    part(logParts, new THREE.CylinderGeometry(0.56, 0.6, LOG_H, 12), C.bark, { y: LOG_H / 2 });
    part(logParts, new THREE.CylinderGeometry(0.5, 0.5, 0.07, 12), C.barkLit, { y: LOG_H + 0.02 });
    part(logParts, new THREE.TorusGeometry(0.55, 0.05, 5, 14), C.leafDark, { rx: Math.PI / 2, y: LOG_H - 0.12 });
    part(logParts, new THREE.TorusGeometry(0.58, 0.05, 5, 14), C.leaf, { rx: Math.PI / 2, y: 0.16 });
    part(logParts, new THREE.SphereGeometry(0.16, 7, 5), C.moss, { sy: 0.5, x: 0.46, y: 0.22, z: 0.3 });

    const logs = new THREE.InstancedMesh(mergeParts(logParts), makeToon(0xffffff, VC), SEATS.length);
    logs.castShadow = true;
    logs.receiveShadow = true;
    const d = this._dummy;
    const col = new THREE.Color();
    for (let i = 0; i < SEATS.length; i++) {
      const s = SEATS[i];
      d.position.set(s.x, 0, s.z);
      d.rotation.set(0, s.yaw + (i % 3) * 0.4, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      logs.setMatrixAt(i, d.matrix);
      col.setHex(0xffffff).offsetHSL(0, 0, (i % 2 ? 1 : -1) * 0.04);
      logs.setColorAt(i, col);
    }
    d.rotation.set(0, 0, 0);
    logs.instanceMatrix.needsUpdate = true;
    if (logs.instanceColor) logs.instanceColor.needsUpdate = true;
    logs.computeBoundingSphere();
    scene.add(logs);

    // seated capybaras get their own group so dispose() can empty it in one go
    this._seatGroup = new THREE.Group();
    scene.add(this._seatGroup);
  }

  /* --- scatter helper ------------------------------------------------------ */

  /**
   * Random ground spots that dodge everything that matters: the bot circle, the
   * beach corridor, the pool, the doodle circle, the cliff and the solo stone.
   */
  _scatter(n, r0, r1, clear = 1.2) {
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 14) {
      const a = this._rng() * TAU;
      const r = r0 + this._rng() * (r1 - r0);
      const x = CLEAR.x + Math.cos(a) * r;
      const z = CLEAR.z + Math.sin(a) * r;
      if (Math.hypot(x - BZ.x, z - BZ.z) < BZ.r + clear) continue;
      if (distToSeg(x, z, PATH_A, PATH_B) < 2.5) continue;
      if (Math.hypot(x - POOL.x, z - POOL.z) < POOL.r + 0.8) continue;
      if (Math.hypot(x - EASEL.x, z - EASEL.z) < SEAT_R + 1.0) continue;
      if (Math.hypot(x - 6.4, z + 3.6) < 2.9) continue; // the guessing stone
      if (Math.hypot(x - SIGN.x, z - SIGN.z) < 3.2) continue; // the signpost, kept readable
      if (Math.hypot(x - 0.7, z - 12.6) < 3.2) continue; // the path mouth
      const t = (x - CLIFF_A.x) * CLIFF_DIR.x + (z - CLIFF_A.y) * CLIFF_DIR.y;
      const perp = (x - CLIFF_A.x) * CLIFF_N.x + (z - CLIFF_A.y) * CLIFF_N.y;
      if (t > -2.5 && t < CLIFF_LEN + 2.5 && perp < 3.2) continue;
      out.push({ x, z, y: groundH(x, z) });
    }
    return out;
  }

  /* --- big trees ----------------------------------------------------------- */

  _trees(scene) {
    // Trees south of the clearing get a trunk but NO crown: the follow camera
    // flies at y 12.5 roughly 18 behind the player, which is exactly where a
    // crown down there would sit, and a screen full of leaves is not a room.
    // Bare trunks vanishing into the canopy dome frame the shot instead.
    // Nothing tall may stand in the follow camera's corridor: it flies at y 12.5
    // some 18 behind the player, so a trunk anywhere south of the clearing and
    // near the middle fills the screen the moment anyone walks west or east.
    // The south keeps its trees only out at the corners, where they frame.
    const spots = this._scatter(36, 12.0, 21.0, 4.0)
      .filter((p) => p.z < 4.5 || Math.abs(p.x) > 12)
      .map((p) => ({ ...p, crown: p.z <= 3.5 }));
    this._treeTops = [];

    // trunk: tapered, leaning a little, with buttress roots flaring at the base
    const trunkParts = [];
    const tg = new THREE.CylinderGeometry(0.32, 0.62, 9, 9, 5);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const u = (tp.getY(i) + 4.5) / 9;
      tp.setX(i, tp.getX(i) + 0.5 * u * u);
      tp.setZ(i, tp.getZ(i) + 0.2 * u * u * u);
    }
    tg.translate(0, 4.5, 0);
    tg.computeVertexNormals();
    part(trunkParts, tg, 0xffffff, null);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      part(trunkParts, new THREE.ConeGeometry(0.3, 1.5, 4), 0xf0e8dc, {
        rx: 0.42, ry: -a, x: Math.cos(a) * 0.45, y: 0.72, z: Math.sin(a) * 0.45,
      });
    }
    const trunks = new THREE.InstancedMesh(
      mergeParts(trunkParts), texMat(texBark(), { vc: true }), spots.length,
    );
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    // canopy: a cluster of squashed blobs, instanced separately so the greens
    // can vary per tree without touching the bark
    const blobParts = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      const r = i === 4 ? 0 : 1.5;
      part(blobParts, new THREE.SphereGeometry(1.5 + (i % 2) * 0.35, 9, 7), 0xffffff, {
        sy: 0.62, x: Math.cos(a) * r, y: (i === 4 ? 0.55 : 0) + Math.sin(i * 2.1) * 0.2, z: Math.sin(a) * r,
      });
    }
    const canopies = new THREE.InstancedMesh(
      mergeParts(blobParts), makeToon(0xffffff, VC), spots.length,
    );
    canopies.castShadow = true;

    const d = this._dummy;
    const col = new THREE.Color();
    let cn = 0;
    for (let i = 0; i < spots.length; i++) {
      const p = spots[i];
      // Southern trunks run tall: their crowns end up at y 15+, well clear of
      // the camera's 12.5, and dark enough to read as the canopy ceiling rather
      // than as a bush parked in front of the lens.
      const s = p.crown ? 0.85 + this._rng() * 0.55 : 1.7 + this._rng() * 0.45;
      // tall trunks stay SLIM: scaled up uniformly they turn into columns that
      // wall the spawn view in
      const g1 = p.crown ? s : 0.72 + this._rng() * 0.2;
      const yaw = this._rng() * TAU;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, yaw, 0);
      d.scale.set(g1, s, g1);
      d.updateMatrix();
      trunks.setMatrixAt(i, d.matrix);
      col.setHex(0xffffff).offsetHSL(0, 0, (this._rng() - 0.5) * 0.14);
      trunks.setColorAt(i, col);
      this.obstacles.push({ x: p.x, z: p.z, r: 0.85 * g1 });

      // crown sits on the bent tip of the trunk
      const lx = 0.5 * g1, lz = 0.2 * g1;
      const cx = p.x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
      const cz = p.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
      const cy = p.y + 9 * s;
      if (p.crown) this._treeTops.push({ x: cx, y: cy, z: cz, s });
      d.position.set(cx, cy, cz);
      d.rotation.set((this._rng() - 0.5) * 0.2, this._rng() * TAU, (this._rng() - 0.5) * 0.2);
      d.scale.setScalar(p.crown ? s * (1.1 + this._rng() * 0.4) : 1.7 + this._rng() * 0.5);
      d.updateMatrix();
      canopies.setMatrixAt(cn, d.matrix);
      col.setHex(p.crown ? [C.leaf, C.leafDark, C.jade, C.leafLit][cn % 4] : 0x2c5124)
        .offsetHSL(0, 0, (this._rng() - 0.5) * 0.07);
      canopies.setColorAt(cn, col);
      cn++;
    }
    canopies.count = cn;
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    trunks.computeBoundingSphere();
    canopies.computeBoundingSphere();
    scene.add(trunks, canopies);
  }

  /* --- bushes, ferns, mushrooms, rocks ------------------------------------ */

  _undergrowth(scene) {
    const d = this._dummy;
    const col = new THREE.Color();

    // ---- bushes: blobby, dense, filling the gaps between trunks
    const bushParts = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      part(bushParts, new THREE.SphereGeometry(0.62, 8, 6), 0xffffff, {
        sy: 0.8, x: Math.cos(a) * 0.42, y: 0.42 + (i % 2) * 0.18, z: Math.sin(a) * 0.42,
      });
    }
    const bushSpots = this._scatter(44, 8.4, 20.5, 2.0);
    const bushes = new THREE.InstancedMesh(mergeParts(bushParts), makeToon(0xffffff, VC), bushSpots.length);
    bushes.castShadow = true;
    bushes.receiveShadow = true;
    for (let i = 0; i < bushSpots.length; i++) {
      const p = bushSpots[i];
      const s = 0.8 + this._rng() * 1.1;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, this._rng() * TAU, 0);
      d.scale.set(s, s * (0.8 + this._rng() * 0.4), s);
      d.updateMatrix();
      bushes.setMatrixAt(i, d.matrix);
      col.setHex([C.leaf, C.leafDark, C.jade][i % 3]).offsetHSL(0, 0, (this._rng() - 0.5) * 0.1);
      bushes.setColorAt(i, col);
      if (s > 1.2) this.obstacles.push({ x: p.x, z: p.z, r: 0.6 * s });
    }
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    bushes.computeBoundingSphere();
    scene.add(bushes);

    // ---- ferns: seven drooping fronds, cheap and everywhere
    const fernParts = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const g = new THREE.PlaneGeometry(0.34, 1.5, 1, 5);
      const fp = g.attributes.position;
      for (let k = 0; k < fp.count; k++) {
        const u = (fp.getY(k) + 0.75) / 1.5;
        fp.setXYZ(k, fp.getX(k) * (1 - 0.75 * u * u), u * 1.1 - u * u * 0.75, u * 0.95);
      }
      g.computeVertexNormals();
      part(fernParts, g, i % 2 ? 0xffffff : 0xdfeed0, { ry: a });
    }
    const fernSpots = this._scatter(56, 6.6, 19.5, 1.4);
    const ferns = new THREE.InstancedMesh(
      mergeParts(fernParts), makeToon(0xffffff, VC2), fernSpots.length,
    );
    ferns.castShadow = true;
    for (let i = 0; i < fernSpots.length; i++) {
      const p = fernSpots[i];
      const s = 0.75 + this._rng() * 0.85;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, this._rng() * TAU, 0);
      d.scale.setScalar(s);
      d.updateMatrix();
      ferns.setMatrixAt(i, d.matrix);
      col.setHex([C.leaf, C.leafLit, C.leafDark][i % 3]).offsetHSL(0, 0, (this._rng() - 0.5) * 0.08);
      ferns.setColorAt(i, col);
    }
    ferns.instanceMatrix.needsUpdate = true;
    if (ferns.instanceColor) ferns.instanceColor.needsUpdate = true;
    ferns.computeBoundingSphere();
    scene.add(ferns);

    // ---- glow mushrooms in the shade, and mossy rocks
    const shroom = [];
    part(shroom, new THREE.CylinderGeometry(0.06, 0.09, 0.4, 6), 0xf6efd8, { y: 0.2 });
    part(shroom, new THREE.SphereGeometry(0.24, 9, 6, 0, TAU, 0, Math.PI / 2), 0xffffff, { sy: 0.72, y: 0.4 });
    part(shroom, new THREE.CylinderGeometry(0.05, 0.07, 0.28, 6), 0xf6efd8, { x: 0.2, y: 0.14, z: 0.12 });
    part(shroom, new THREE.SphereGeometry(0.15, 8, 6, 0, TAU, 0, Math.PI / 2), 0xffffff, { sy: 0.7, x: 0.2, y: 0.28, z: 0.12 });
    const shroomSpots = this._scatter(16, 7.4, 17.5, 1.6);
    const mat = makeGlow(0xffffff, { unique: true });
    mat.vertexColors = true;
    mat.needsUpdate = true;
    const shrooms = new THREE.InstancedMesh(mergeParts(shroom), mat, shroomSpots.length);
    for (let i = 0; i < shroomSpots.length; i++) {
      const p = shroomSpots[i];
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, this._rng() * TAU, 0);
      d.scale.setScalar(0.8 + this._rng() * 0.9);
      d.updateMatrix();
      shrooms.setMatrixAt(i, d.matrix);
      col.setHex([0xc9f7d8, 0xa8e8ff, 0xfff0b0][i % 3]);
      shrooms.setColorAt(i, col);
    }
    shrooms.instanceMatrix.needsUpdate = true;
    if (shrooms.instanceColor) shrooms.instanceColor.needsUpdate = true;
    shrooms.computeBoundingSphere();
    scene.add(shrooms);
    this._shrooms = shrooms;
    this._shroomMat = mat;

    const rockG = new THREE.IcosahedronGeometry(0.5, 0);
    rockG.computeVertexNormals();
    const rockSpots = this._scatter(20, 7.0, 18.5, 1.5);
    const rocks = new THREE.InstancedMesh(rockG, makeToon(0xffffff, { unique: true }), rockSpots.length);
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    for (let i = 0; i < rockSpots.length; i++) {
      const p = rockSpots[i];
      const s = 0.5 + this._rng() * 1.0;
      d.position.set(p.x, p.y + s * 0.22, p.z);
      d.rotation.set(this._rng(), this._rng() * TAU, this._rng() * 0.4);
      d.scale.setScalar(s);
      d.updateMatrix();
      rocks.setMatrixAt(i, d.matrix);
      col.setHex(i % 3 ? C.stone : C.moss).offsetHSL(0, 0, (this._rng() - 0.5) * 0.1);
      rocks.setColorAt(i, col);
      if (s > 0.9) this.obstacles.push({ x: p.x, z: p.z, r: s * 0.7 });
    }
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.computeBoundingSphere();
    scene.add(rocks);
  }

  /* --- hanging vines ------------------------------------------------------- */

  _vines(scene) {
    // origin at the TOP of the vine, so a per-instance tilt swings the tail
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.2, -1.3, 0.08),
      new THREE.Vector3(-0.14, -2.6, 0.03),
      new THREE.Vector3(0.12, -4, 0),
    ]);
    const vp = [];
    part(vp, new THREE.TubeGeometry(curve, 14, 0.055, 5, false), C.leafDark, null);
    for (let i = 0; i < 8; i++) {
      const u = 0.1 + i * 0.11;
      const p = curve.getPointAt(u);
      part(vp, new THREE.SphereGeometry(0.16, 6, 4), i % 2 ? C.leaf : C.leafLit, {
        sx: 1.7, sy: 0.35, ry: i * 1.27, x: p.x + 0.14, y: p.y, z: p.z,
      });
    }
    part(vp, new THREE.SphereGeometry(0.13, 7, 5), C.coral, { sy: 1.4, x: 0.12, y: -4.05, z: 0 });

    const anchors = [];
    for (const t of this._treeTops) {
      const n = t.s > 1.15 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const a = this._rng() * TAU;
        const r = 1.6 * t.s;
        anchors.push({
          x: t.x + Math.cos(a) * r,
          y: t.y - 0.6,
          z: t.z + Math.sin(a) * r,
          s: 0.7 + this._rng() * 0.9,
        });
      }
    }
    // four more off the ruin arch, framing the easel
    for (const x of [-2.2, -1.2, 1.3, 2.4]) {
      anchors.push({ x, y: DAIS.h + 4.3, z: -11.4, s: 0.5 + this._rng() * 0.35 });
    }

    const vines = new THREE.InstancedMesh(mergeParts(vp), makeToon(0xffffff, VC), anchors.length);
    vines.castShadow = false;
    vines.frustumCulled = false;
    const d = this._dummy;
    this._vineData = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      this._vineData.push({
        ...a, yaw: this._rng() * TAU, ph: this._rng() * TAU, amp: 0.03 + this._rng() * 0.05,
      });
      d.position.set(a.x, a.y, a.z);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(a.s);
      d.updateMatrix();
      vines.setMatrixAt(i, d.matrix);
    }
    d.scale.setScalar(1);
    vines.instanceMatrix.needsUpdate = true;
    vines.computeBoundingSphere();
    scene.add(vines);
    this._vines = vines;
  }

  /* --- giant flowers ------------------------------------------------------- */

  _flowers(scene) {
    const spots = this._scatter(14, 7.2, 16.4, 1.8);
    const d = this._dummy;
    const col = new THREE.Color();

    // stem + leaves, all one green
    const stemParts = [];
    part(stemParts, new THREE.CylinderGeometry(0.07, 0.1, 1.9, 6), C.leafDark, { y: 0.95 });
    part(stemParts, new THREE.SphereGeometry(0.36, 7, 5), C.leaf, { sy: 0.16, ry: 0.6, x: 0.3, y: 0.45, z: 0.1 });
    part(stemParts, new THREE.SphereGeometry(0.3, 7, 5), C.leafLit, { sy: 0.16, ry: -0.8, x: -0.28, y: 0.8, z: -0.12 });
    const stems = new THREE.InstancedMesh(mergeParts(stemParts), makeToon(0xffffff, VC), spots.length);
    stems.castShadow = true;

    // head: six petals around a boss
    const headParts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      part(headParts, new THREE.SphereGeometry(0.34, 8, 6), 0xffffff, {
        sy: 0.24, sx: 1.5, ry: -a, rz: 0.28,
        x: Math.cos(a) * 0.42, y: Math.sin(a * 2) * 0.03, z: Math.sin(a) * 0.42,
      });
    }
    const heads = new THREE.InstancedMesh(mergeParts(headParts), makeToon(0xffffff, VC2), spots.length);
    heads.castShadow = true;

    const coreMat = makeGlow(0xffffff, { unique: true });
    coreMat.vertexColors = true;
    coreMat.needsUpdate = true;
    const coreParts = [];
    part(coreParts, new THREE.SphereGeometry(0.19, 9, 7), 0xffffff, { sy: 0.7 });
    const cores = new THREE.InstancedMesh(mergeParts(coreParts), coreMat, spots.length);

    const tints = [C.coral, C.gold, 0xd98ce8, 0xffb0c4, 0x8fd8ff];
    this._flowerData = [];
    for (let i = 0; i < spots.length; i++) {
      const p = spots[i];
      const s = 0.9 + this._rng() * 0.7;
      const yaw = this._rng() * TAU;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, yaw, 0);
      d.scale.setScalar(s);
      d.updateMatrix();
      stems.setMatrixAt(i, d.matrix);
      col.setHex(0xffffff).offsetHSL(0, 0, (this._rng() - 0.5) * 0.08);
      stems.setColorAt(i, col);

      const hx = p.x, hy = p.y + 1.9 * s, hz = p.z;
      this._flowerData.push({ x: hx, y: hy, z: hz, s, yaw, ph: this._rng() * TAU });
      d.position.set(hx, hy, hz);
      d.scale.setScalar(s);
      d.updateMatrix();
      heads.setMatrixAt(i, d.matrix);
      cores.setMatrixAt(i, d.matrix);
      col.setHex(tints[i % tints.length]);
      heads.setColorAt(i, col);
      col.setHex(0xfff2c0);
      cores.setColorAt(i, col);
    }
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);
    for (const m of [stems, heads, cores]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
      scene.add(m);
    }
    this._flowerHeads = heads;
    this._flowerCores = cores;
  }

  /* --- butterflies and the bird -------------------------------------------- */

  _critters(scene) {
    // ---- butterflies: two instanced wing sets, mirrored, flapping in step
    const wp = [];
    part(wp, new THREE.CircleGeometry(0.17, 10), 0xffffff, { sy: 1.25, rx: -Math.PI / 2, x: 0.17 });
    part(wp, new THREE.CircleGeometry(0.11, 8), 0xffffff, { sy: 0.95, rx: -Math.PI / 2, x: 0.3, z: -0.13 });
    const wingGeo = mergeParts(wp);
    const wingMat = makeToon(0xffffff, VC2);
    const N = 6;
    this._wingL = new THREE.InstancedMesh(wingGeo, wingMat, N);
    this._wingR = new THREE.InstancedMesh(wingGeo.clone(), wingMat, N);
    for (const m of [this._wingL, this._wingR]) { m.frustumCulled = false; scene.add(m); }

    const tints = [C.coral, C.gold, 0xfff1d6, 0x9fd8ff, 0xd98ce8, C.leafLit];
    const col = new THREE.Color();
    this._flutter = [];
    for (let i = 0; i < N; i++) {
      // each butterfly loops a lazy ellipse around one of the flower patches
      const f = this._flowerData[i % this._flowerData.length];
      this._flutter.push({
        cx: f ? f.x : 0, cz: f ? f.z : 0,
        rx: 1.6 + this._rng() * 1.8, rz: 1.2 + this._rng() * 1.6,
        y: 0.9 + this._rng() * 1.3, a: this._rng() * TAU,
        sp: 0.5 + this._rng() * 0.5, ph: this._rng() * TAU,
      });
      col.setHex(tints[i % tints.length]);
      this._wingL.setColorAt(i, col);
      this._wingR.setColorAt(i, col);
    }
    if (this._wingL.instanceColor) this._wingL.instanceColor.needsUpdate = true;
    if (this._wingR.instanceColor) this._wingR.instanceColor.needsUpdate = true;

    // ---- one very bright bird, flying a slow loop under the canopy
    const bird = new THREE.Group();
    const body = [];
    part(body, new THREE.SphereGeometry(0.32, 10, 8), C.coral, { sz: 1.6 });
    part(body, new THREE.SphereGeometry(0.22, 9, 7), 0xf2a541, { y: 0.16, z: 0.4 });
    part(body, new THREE.ConeGeometry(0.13, 0.52, 7), C.gold, { rx: Math.PI / 2, y: 0.12, z: 0.78 });
    part(body, new THREE.ConeGeometry(0.1, 0.3, 6), 0xfff6e3, { rx: Math.PI / 2, y: 0.05, z: 0.86 });
    part(body, new THREE.SphereGeometry(0.05, 6, 5), C.ink, { x: 0.13, y: 0.24, z: 0.52 });
    part(body, new THREE.SphereGeometry(0.05, 6, 5), C.ink, { x: -0.13, y: 0.24, z: 0.52 });
    part(body, new THREE.ConeGeometry(0.2, 0.9, 5), 0x4fb3e8, { rx: -Math.PI / 2, sy: 1, y: 0.06, z: -0.72 });
    bird.add(solidMesh(body, { shadow: false }));
    const wingParts = [];
    part(wingParts, new THREE.CircleGeometry(0.5, 9), 0x4fb3e8, { sy: 0.6, rx: -Math.PI / 2, x: 0.5 });
    part(wingParts, new THREE.CircleGeometry(0.28, 8), C.gold, { sy: 0.6, rx: -Math.PI / 2, x: 0.92 });
    const wl = new THREE.Mesh(mergeParts(wingParts), makeToon(0xffffff, VC2));
    const wr = new THREE.Mesh(wl.geometry.clone(), wl.material);
    wr.scale.x = -1;
    bird.add(wl, wr);
    bird.scale.setScalar(1.1);
    scene.add(bird);
    this._bird = { obj: bird, wl, wr, a: 0.7 };
  }

  /* --- dust in the light, fireflies at the edges --------------------------- */

  _motes(scene) {
    const dot = texDot();

    const M = 70;
    this._moteData = [];
    for (let i = 0; i < M; i++) {
      this._moteData.push({
        x: (this._rng() - 0.5) * 20, z: -12 + this._rng() * 20,
        y: 0.6 + this._rng() * 6.5, ph: this._rng() * TAU,
        sp: 0.1 + this._rng() * 0.25, sw: 0.4 + this._rng() * 0.8,
      });
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * 3), 3));
    const mm = new THREE.PointsMaterial({
      size: 0.16, map: dot, transparent: true, opacity: 0.7, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0xffeeb8,
    });
    this._motes = new THREE.Points(mg, mm);
    this._motes.frustumCulled = false;
    scene.add(this._motes);

    const F = 56;
    this._fireflyData = [];
    for (let i = 0; i < F; i++) {
      const a = this._rng() * TAU;
      const r = 9.5 + this._rng() * 7;
      this._fireflyData.push({
        cx: CLEAR.x + Math.cos(a) * r, cz: CLEAR.z + Math.sin(a) * r,
        rr: 0.6 + this._rng() * 1.6, y: 0.4 + this._rng() * 2.6,
        a: this._rng() * TAU, sp: 0.3 + this._rng() * 0.7,
        blink: 0.8 + this._rng() * 1.8, ph: this._rng() * TAU,
      });
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(F * 3), 3));
    fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(F * 3), 3));
    const fm = new THREE.PointsMaterial({
      size: 0.3, map: dot.clone(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true,
    });
    fm.map.needsUpdate = true;
    this._fireflies = new THREE.Points(fg, fm);
    this._fireflies.frustumCulled = false;
    scene.add(this._fireflies);
  }

  /* --- shafts of light through the canopy ---------------------------------- */

  _godRays(scene) {
    const parts = [];
    const shafts = [
      [-6.5, 2.5, 3.2, 15], [-2.2, -4.5, 2.2, 14], [1.8, 5.0, 2.6, 15],
      [4.6, -2.0, 3.0, 14.5], [-8.5, -8.0, 2.0, 13], [7.5, 6.5, 2.4, 15],
      [0.4, -10.5, 2.8, 13.5], [10.0, -6.0, 2.2, 14],
    ];
    for (const [x, z, w, len] of shafts) {
      const g = new THREE.PlaneGeometry(w, len);
      g.translate(0, -len / 2, 0); // hang from the canopy down
      part(parts, g, 0xffffff, { rz: 0.2, rx: -0.16, x, y: len - 1.5, z });
    }
    const mat = flatMat(texShaft(), { additive: true, opacity: 0.34, double: true, vc: true });
    const rays = new THREE.Mesh(mergeParts(parts), mat);
    rays.frustumCulled = false;
    rays.renderOrder = 4;
    scene.add(rays);
    this._rayMat = mat;
  }

  /* --- the way back to the beach ------------------------------------------- */

  _exit(scene) {
    const sx = SIGN.x, sz = SIGN.z;
    const sy = groundH(sx, sz);
    const post = [];
    part(post, new THREE.CylinderGeometry(0.15, 0.19, 3.2, 8), C.bark, { x: sx, y: sy + 1.6, z: sz });
    part(post, new THREE.SphereGeometry(0.22, 8, 6), C.moss, { x: sx, y: sy + 3.24, z: sz });
    part(post, new THREE.CylinderGeometry(0.5, 0.55, 0.16, 10), C.stone, { x: sx, y: sy + 0.06, z: sz });
    // two mossy gateposts framing the path mouth
    for (const gx of [-1.5, 2.2]) {
      const gy = groundH(gx, 12.6);
      part(post, new THREE.BoxGeometry(0.7, 2.4, 0.7), C.stone, { rz: gx < 0 ? 0.06 : -0.05, x: gx, y: gy + 1.2, z: 12.6 });
      part(post, new THREE.BoxGeometry(0.86, 0.3, 0.86), C.moss, { x: gx, y: gy + 2.5, z: 12.6 });
      this.obstacles.push({ x: gx, z: 12.6, r: 0.6 });
    }
    // A leaning log gateway over the path mouth. It carries the vertical the
    // south lost when the tall trunks moved out to the corners, and at 4.4 high
    // it ducks under the camera instead of standing in front of it.
    const gate = [];
    for (const gx of [-1.9, 2.6]) {
      const gy = groundH(gx, 13.4);
      part(gate, new THREE.CylinderGeometry(0.24, 0.34, 5.0, 8), C.bark, {
        rz: gx < 0 ? 0.16 : -0.16, x: gx, y: gy + 2.5, z: 13.4,
      });
    }
    link(gate, [-1.5, 4.5, 13.4], [2.2, 4.6, 13.3], 0.22, C.barkDark, 6);
    part(gate, new THREE.SphereGeometry(0.5, 8, 6), C.moss, { sy: 0.45, x: -0.4, y: 4.8, z: 13.3 });
    part(gate, new THREE.SphereGeometry(0.4, 8, 6), C.leafDark, { sy: 0.45, x: 1.4, y: 4.75, z: 13.4 });
    for (let i = 0; i < 5; i++) {
      const x = -1.2 + i * 0.85;
      part(gate, new THREE.CylinderGeometry(0.04, 0.04, 0.9 + (i % 3) * 0.5, 5), C.leafDark, {
        x, y: 4.1 - (i % 3) * 0.25, z: 13.35,
      });
      part(gate, new THREE.SphereGeometry(0.14, 6, 4), i % 2 ? C.leaf : C.leafLit, {
        sx: 1.6, sy: 0.4, x, y: 3.6 - (i % 3) * 0.5, z: 13.35,
      });
    }
    scene.add(solidMesh(gate));
    this.obstacles.push({ x: -1.9, z: 13.4, r: 0.5 }, { x: 2.6, z: 13.4, r: 0.5 });

    scene.add(solidMesh(post));
    this.obstacles.push({ x: sx, z: sz, r: 0.6 });

    // Two boards on one post: the upper faces the play camera (read on the way
    // in), the lower faces north (read on the way out to the beach).
    const yaw = -0.3;
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    const boards = [
      [sy + 2.5, 1, texSign('TANGLE JUNGLE', 'doodles at the old stones', '#7ac74f')],
      [sy + 1.66, -1, texSign('DRIFTWOOD BEACH', 'sand, surf & fishing', '#e8657a')],
    ];
    for (const [y, dir, tex] of boards) {
      // Both the plank and its lettering stand clear of the post: hung on the
      // post's centre line the 0.16 post split the board straight down the middle.
      const plank = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.66, 0.12), makeToon(C.barkDark));
      plank.position.set(sx + nx * dir * 0.2, y, sz + nz * dir * 0.2);
      plank.rotation.y = yaw;
      plank.castShadow = true;
      scene.add(plank);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.62), flatMat(tex));
      face.position.set(sx + nx * dir * 0.28, y, sz + nz * dir * 0.28);
      face.rotation.y = dir > 0 ? yaw : yaw + Math.PI;
      scene.add(face);
    }
  }

  /* --- per frame ----------------------------------------------------------- */

  update(dt) {
    const t = (this._t += dt);
    const d = this._dummy;
    const col = new THREE.Color();

    // ---- the falls: sheet scrolls, lip trickles, impact breathes
    if (this._fallTex) this._fallTex.offset.y -= dt * 1.15;
    if (this._lipTex) this._lipTex.offset.y -= dt * 0.7;
    if (this._foam) {
      const s = 1 + Math.sin(t * 3.1) * 0.09 + Math.sin(t * 7.7) * 0.04;
      this._foam.scale.set(s, 1, s);
      this._foam.material.opacity = 0.62 + Math.sin(t * 4.3) * 0.16;
    }
    if (this._rings) {
      for (let i = 0; i < 3; i++) {
        const u = ((t * 0.42 + i / 3) % 1);
        const s = 1.4 + u * 4.6;
        d.position.set(FALL_FACE.x + 0.1, POOL_Y + 0.04, FALL_FACE.z + 0.14);
        d.rotation.set(0, 0, 0);
        d.scale.set(s, 1, s);
        d.updateMatrix();
        this._rings.setMatrixAt(i, d.matrix);
        const f = (1 - u) * 0.7;
        this._rings.setColorAt(i, col.setRGB(f, f, f));
      }
      this._rings.instanceMatrix.needsUpdate = true;
      if (this._rings.instanceColor) this._rings.instanceColor.needsUpdate = true;
    }
    if (this._mistPts) {
      const pos = this._mistPts.geometry.attributes.position.array;
      const cols = this._mistPts.geometry.attributes.color.array;
      for (let i = 0; i < this._mist.length; i++) {
        const m = this._mist[i];
        m.t += dt * m.sp * 0.4;
        if (m.t > 1) m.t -= 1;
        const rise = m.t * 3.4;
        pos[i * 3] = FALL_FACE.x + Math.cos(m.a) * (m.r + m.t * 1.5) + m.drift * rise;
        pos[i * 3 + 1] = POOL_Y + rise;
        pos[i * 3 + 2] = FALL_FACE.z + Math.sin(m.a) * (m.r + m.t * 1.5);
        const f = Math.sin(m.t * Math.PI) * 0.85;
        cols[i * 3] = f; cols[i * 3 + 1] = f; cols[i * 3 + 2] = f;
      }
      this._mistPts.geometry.attributes.position.needsUpdate = true;
      this._mistPts.geometry.attributes.color.needsUpdate = true;
    }

    // ---- pool surface
    if (this._water) {
      const wp = this._water.geometry.attributes.position;
      const arr = wp.array, base = this._waterBase;
      for (let i = 0; i < wp.count; i++) {
        const x = base[i * 3], y = base[i * 3 + 1];
        arr[i * 3 + 2] = Math.sin(x * 1.4 + t * 1.7) * 0.05 + Math.sin(y * 1.9 - t * 1.3) * 0.04;
      }
      wp.needsUpdate = true;
      this._poolTex.offset.x += dt * 0.014;
      this._poolTex.offset.y -= dt * 0.022;
    }
    if (this._poolRim) {
      this._poolRim.material.opacity = 0.45 + Math.sin(t * 1.9) * 0.15;
      this._poolRim.position.y = POOL_Y + 0.03 + Math.sin(t * 1.4) * 0.02;
    }

    // ---- vines swing, flowers nod, mushrooms breathe
    if (this._vines) {
      for (let i = 0; i < this._vineData.length; i++) {
        const v = this._vineData[i];
        d.position.set(v.x, v.y, v.z);
        d.rotation.set(
          Math.sin(t * 0.7 + v.ph) * v.amp,
          v.yaw,
          Math.sin(t * 0.9 + v.ph * 1.7) * v.amp * 1.3,
        );
        d.scale.setScalar(v.s);
        d.updateMatrix();
        this._vines.setMatrixAt(i, d.matrix);
      }
      this._vines.instanceMatrix.needsUpdate = true;
      d.scale.setScalar(1);
    }
    if (this._flowerHeads) {
      for (let i = 0; i < this._flowerData.length; i++) {
        const f = this._flowerData[i];
        d.position.set(f.x, f.y + Math.sin(t * 1.1 + f.ph) * 0.05, f.z);
        d.rotation.set(
          Math.sin(t * 0.9 + f.ph) * 0.12,
          f.yaw + t * 0.1,
          Math.cos(t * 1.2 + f.ph) * 0.12,
        );
        d.scale.setScalar(f.s);
        d.updateMatrix();
        this._flowerHeads.setMatrixAt(i, d.matrix);
        this._flowerCores.setMatrixAt(i, d.matrix);
      }
      this._flowerHeads.instanceMatrix.needsUpdate = true;
      this._flowerCores.instanceMatrix.needsUpdate = true;
      d.scale.setScalar(1);
    }
    if (this._shroomMat) {
      const f = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.6));
      this._shroomMat.color.setRGB(f, f, f);
    }

    // ---- motes drifting in the light, fireflies blinking at the rim
    if (this._motes) {
      const pos = this._motes.geometry.attributes.position.array;
      for (let i = 0; i < this._moteData.length; i++) {
        const m = this._moteData[i];
        m.y += dt * m.sp;
        if (m.y > 8) m.y = 0.3;
        pos[i * 3] = m.x + Math.sin(t * m.sw + m.ph) * 0.6;
        pos[i * 3 + 1] = m.y;
        pos[i * 3 + 2] = m.z + Math.cos(t * m.sw * 0.7 + m.ph) * 0.5;
      }
      this._motes.geometry.attributes.position.needsUpdate = true;
    }
    if (this._fireflies) {
      const pos = this._fireflies.geometry.attributes.position.array;
      const cols = this._fireflies.geometry.attributes.color.array;
      for (let i = 0; i < this._fireflyData.length; i++) {
        const f = this._fireflyData[i];
        f.a += dt * f.sp;
        pos[i * 3] = f.cx + Math.cos(f.a) * f.rr;
        pos[i * 3 + 1] = f.y + Math.sin(t * 0.8 + f.ph) * 0.35;
        pos[i * 3 + 2] = f.cz + Math.sin(f.a * 1.3) * f.rr;
        const blink = Math.sin(t * f.blink + f.ph);
        const g = (blink > 0 ? blink * blink : 0) * this._flyK; // brighter at night
        cols[i * 3] = g * 0.95; cols[i * 3 + 1] = g; cols[i * 3 + 2] = g * 0.4;
      }
      this._fireflies.geometry.attributes.position.needsUpdate = true;
      this._fireflies.geometry.attributes.color.needsUpdate = true;
    }

    // ---- butterflies
    if (this._wingL) {
      for (let i = 0; i < this._flutter.length; i++) {
        const b = this._flutter[i];
        b.a += dt * b.sp;
        const x = b.cx + Math.cos(b.a) * b.rx;
        const z = b.cz + Math.sin(b.a * 1.4) * b.rz;
        const y = b.y + Math.sin(t * 1.6 + b.ph) * 0.28;
        const yaw = b.a * 1.2;
        const flap = 0.35 + Math.sin(t * 13 + b.ph) * 0.75;
        d.position.set(x, y, z);
        d.scale.set(1, 1, 1);
        d.rotation.set(0, yaw, flap);
        d.updateMatrix();
        this._wingL.setMatrixAt(i, d.matrix);
        d.scale.set(-1, 1, 1);
        d.rotation.set(0, yaw, -flap);
        d.updateMatrix();
        this._wingR.setMatrixAt(i, d.matrix);
      }
      d.scale.set(1, 1, 1);
      d.rotation.set(0, 0, 0);
      this._wingL.instanceMatrix.needsUpdate = true;
      this._wingR.instanceMatrix.needsUpdate = true;
    }

    // ---- the bird, on its lap of the clearing
    const bird = this._bird;
    if (bird) {
      bird.a += dt * 0.2;
      const x = Math.cos(bird.a) * 10.5;
      const z = CLEAR.z + Math.sin(bird.a) * 7.5;
      bird.obj.position.set(x, 6.8 + Math.sin(t * 0.6) * 0.55, z);
      bird.obj.rotation.y = Math.atan2(-Math.sin(bird.a) * 10.5, Math.cos(bird.a) * 7.5);
      bird.obj.rotation.z = -0.22;
      const flap = 0.25 + Math.sin(t * 5.2) * 0.6;
      bird.wl.rotation.z = flap;
      bird.wr.rotation.z = -flap;
    }

    // ---- light: the shafts drift, the ruin lamp and pool bounce breathe
    // (_dayK fades the shafts out after dusk, _lampK turns the ruin lamp up)
    if (this._rayMat) this._rayMat.opacity = (0.26 + 0.1 * (0.5 + 0.5 * Math.sin(t * 0.5))) * this._dayK;
    if (this._ruinLight) this._ruinLight.intensity = (8.4 + Math.sin(t * 1.7) * 1.1) * this._lampK;
    if (this._poolLight) this._poolLight.intensity = 6.4 + Math.sin(t * 2.9) * 1.3;

    this._updateLobby(dt, t);
  }

  /* --- doodle lobby, per frame --------------------------------------------- */

  _updateLobby(dt, t) {
    // seated doodlers keep breathing (nothing organic is ever perfectly still)
    for (const r of this._doodlers.values()) r.avatar.update(dt);

    // A 'dd-lobby' frame can beat the 'pjoin' that introduces the same capybara,
    // so a seat may start out brown and un-deduplicated. Catch up twice a
    // second: cheap, and it means the log always ends up wearing their hat.
    this._reconcileT += dt;
    if (this._reconcileT > 0.5) {
      this._reconcileT = 0;
      if (this._doodlers.size) this._reconcileDoodlers();
    }

    // the board bobs, and pulses once there are enough capys to draw
    const board = this._board;
    if (board) {
      board.position.y = this._boardY + Math.sin(t * 1.2) * 0.09;
      board.rotation.z = Math.sin(t * 0.85) * 0.014;
      const eager = this._lobbyCount >= 2 || this._lobbyStarting;
      const s = eager ? 1 + Math.abs(Math.sin(t * 4.0)) * 0.07 : 1;
      board.scale.set(s, s, s);
    }

    // keep the local capybara settled on their log while they wait
    const engine = this._game?.engine;
    const avatar = engine?.playerAvatar;
    if (this._localSeat !== null && avatar) {
      const seat = SEATS[this._localSeat];
      const g = avatar.group;
      const walking = !!engine.controller?.target;
      if (seat && !walking && Math.hypot(g.position.x - seat.x, g.position.z - seat.z) < 0.55) {
        if (avatar.state.anim !== 'sit') avatar.setAnim('sit');
        g.position.y = SEAT_Y;
        const delta = ((((seat.yaw - g.rotation.y) % TAU) + Math.PI * 3) % TAU) - Math.PI;
        g.rotation.y += delta * Math.min(1, dt * 6);
      }
    }

    // the prompt has to follow the connection coming and going
    const online = !!this._game?.net?.connected;
    if (online !== this._wasOnline) {
      this._wasOnline = online;
      if (!online) this._clearLobby();
      else this._refreshJoinLabel();
    }
  }

  dispose() {
    // Walking out while seated must not leave a ghost holding a log. Harmless
    // if the server already dropped us on the room change.
    if (this._localSeat !== null && this._game?.net?.connected) {
      this._game.net.send({ t: 'dd-leave' });
    }
    // seats next: they hold engine-owned name tags and may be sitting on top of
    // networked avatars we un-parented, which have to go back in the room
    for (const id of [...this._doodlers.keys()]) this._removeDoodler(id);
    this._doodlers.clear();
    this._offLobby?.();
    this._offStart?.();
    this._offLobby = null;
    this._offStart = null;
    this._localSeat = null;
    this._seatGroup = null;
    this._board = null;
    this._boardTex = null; // the board material is unique; disposeObject frees it
    this._joinSpot = null;
    this._game = null;
    this._water = null;
    this._waterBase = null;
    this._poolTex = null;
    this._poolRim = null;
    this._fallTex = null;
    this._lipTex = null;
    this._foam = null;
    this._rings = null;
    this._mist = null;
    this._mistPts = null;
    this._vines = null;
    this._vineData = null;
    this._flowerHeads = null;
    this._flowerCores = null;
    this._flowerData = null;
    this._shrooms = null;
    this._shroomMat = null;
    this._motes = null;
    this._moteData = null;
    this._fireflies = null;
    this._fireflyData = null;
    this._wingL = null;
    this._wingR = null;
    this._flutter = null;
    this._bird = null;
    this._rayMat = null;
    this._domeMat = null;
    this._sun = null;
    this._hemi = null;
    this._amb = null;
    this._bg = null;
    this._fog = null;
    this._ruinLight = null;
    this._poolLight = null;
    this._treeTops = null;
    this.hotspots.length = 0;
    this.obstacles.length = 0;
    this.groundMeshes.length = 0;
  }
}
