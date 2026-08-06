import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/* ---------------------------------------------------------------------------
 * Frosty Peak: a snowy mountaintop clearing above a sea of clouds.
 * Snowbank rim, pine ring, ski lodge, chairlift, frozen pond, snow-capybara.
 * Everything procedural: geometry + canvas textures only.
 * ------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const BZ = BOT_ZONES.peak; // { x: 0, z: 5, r: 4.5 } - must stay flat + walkable

const C = {
  snow: 0xf4f9ff,
  snowLit: 0xffffff,
  snowShade: 0xd6e5f6,
  packed: 0xdde8f6,
  ice: 0x9fd4ee,
  iceLit: 0xc4e8f8,
  iceDeep: 0x63b0d8,
  pine: 0x2f6b4f,
  pineLit: 0x3f8a63,
  pineDark: 0x24523d,
  bark: 0x6b4a34,
  wood: 0x9a6640,
  woodDark: 0x5f3f28,
  woodLit: 0xc08d5c,
  cream: 0xf6e6c8,
  coral: 0xe8657a,
  coralDark: 0xc44a60,
  sky: 0x4fb3e8,
  leaf: 0x7ac74f,
  gold: 0xf2b64a,
  warm: 0xffd98a,
  ember: 0xffb45c,
  rock: 0x7e8a99,
  rockDark: 0x59636f,
  carrot: 0xf2882a,
  coal: 0x2b3038,
  steel: 0x93a1b2,
  steelDark: 0x6a7686,
  farRock: 0x9dbcda,
  cloud: 0xe6f0fa,
};

const GROUND_HALF = 20;
const GROUND_SEGS = 58;
const SUN_DIR = new THREE.Vector3(-34, 10, -44); // where the pale sun sits
const COCOA = { x: 6.2, z: 5.4 }; // barrel table outside the lodge

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

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0 inside the circle, ramping to 1 by r1. */
function ringMask(x, z, cx, cz, r0, r1) {
  return smoothstep(r0, r1, Math.hypot(x - cx, z - cz));
}

/** 0 inside [lo,hi], ramping to 1 over `blend`. */
function bandMask(v, lo, hi, blend) {
  if (v < lo) return smoothstep(0, blend, lo - v);
  if (v > hi) return smoothstep(0, blend, v - hi);
  return 0;
}

/**
 * Terrain height. Gentle wind-blown bumps, a snowbank rim around the clearing,
 * flat pads for the bot zone / lodge / pond / start gate, and a north-south
 * pass that descends into the clouds at both ends.
 */
function terrainH(x, z) {
  const r = Math.hypot(x, z);
  let h =
    0.18 * Math.sin(x * 0.52 + 0.6) * Math.cos(z * 0.44 - 1.1) +
    0.12 * Math.sin(x * 0.29 - z * 0.35 + 2.2) +
    0.07 * Math.cos(x * 0.86 + z * 0.72 + 0.4) +
    0.05 * Math.sin((x - z) * 1.35 + 0.9);
  h += 0.55 * smoothstep(7.0, 12.5, r);
  h += 3.5 * smoothstep(12.5, 17.5, r);
  h += 0.9 * smoothstep(17.5, 20.5, r); // outer lip hides the plate edge

  let mask = ringMask(x, z, BZ.x, BZ.z, BZ.r + 0.9, BZ.r + 3.4);
  mask = Math.min(mask, ringMask(x, z, 10.6, 1.0, 4.4, 8.0)); // lodge terrace
  mask = Math.min(mask, ringMask(x, z, -8.0, -1.6, 4.1, 5.8)); // pond hollow
  mask = Math.min(mask, ringMask(x, z, 0, -9, 3.4, 5.6)); // start gate apron
  mask = Math.min(mask, bandMask(x, -2.4, 2.4, 4.6)); // the pass, with soft shoulders
  h *= mask;

  // Both ends of the pass slope away into the cloud sea. Capped so the walls
  // stay climbable snowbanks rather than cliffs.
  const inPass = 1 - smoothstep(2.4, 6.5, Math.abs(x));
  h -= inPass * Math.min(1.8, 0.4 * Math.max(0, z - 13.0)); // south trail to the plaza
  h -= inPass * Math.min(2.4, 0.5 * Math.max(0, -z - 10.5)); // north race chute
  return h;
}

/* --- geometry assembly helpers -------------------------------------------- */

function paintGeo(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
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

/** A cylinder strung between two points (ropes, cables, twigs, poles). */
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

function solidMesh(parts, { shadow = true } = {}) {
  const m = new THREE.Mesh(mergeParts(parts), makeToon(0xffffff, VC));
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

function glowMesh(parts) {
  const mat = makeGlow(0xfffdf5, { unique: true });
  mat.vertexColors = true;
  mat.needsUpdate = true;
  const m = new THREE.Mesh(mergeParts(parts), mat);
  m.userData.mat = mat;
  return m;
}

/** Unique toon material carrying a canvas texture (never cache-key a texture). */
function texMat(tex, { double = false, transparent = false } = {}) {
  const m = makeToon(0xffffff, { unique: true });
  m.map = tex;
  if (double) m.side = THREE.DoubleSide;
  if (transparent) { m.transparent = true; m.alphaTest = 0.02; }
  m.needsUpdate = true;
  return m;
}

/* --- canvas textures ------------------------------------------------------ */

function skyTexture() {
  const dir = SUN_DIR.clone().normalize();
  const sunV = 0.5 + Math.asin(dir.y) / Math.PI;
  return canvasTexture(512, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.0, '#4e93d2');
    g.addColorStop(0.3, '#8dc2e9');
    g.addColorStop(0.48, '#c6e2f6');
    g.addColorStop(0.6, '#eaeef2');
    g.addColorStop(0.7, '#f7e2c6');
    g.addColorStop(0.84, '#e2e9f2');
    g.addColorStop(1.0, '#cfdcea');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    const sy = (1 - sunV) * h;
    const rg = c.createRadialGradient(w / 2, sy, 0, w / 2, sy, h * 0.5);
    rg.addColorStop(0, 'rgba(255,246,224,0.98)');
    rg.addColorStop(0.18, 'rgba(255,232,190,0.55)');
    rg.addColorStop(0.55, 'rgba(255,222,178,0.16)');
    rg.addColorStop(1, 'rgba(255,222,178,0)');
    c.fillStyle = rg;
    c.fillRect(0, 0, w, h);

    // soft high cloud streaks
    c.globalAlpha = 0.5;
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 14; i++) {
      const x = 40 + ((i * 97) % (w - 80));
      const y = 22 + ((i * 53) % 90);
      const rx = 26 + (i % 5) * 13;
      c.beginPath();
      c.ellipse(x, y, rx, 4.5 + (i % 3) * 2, 0, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  });
}

function flakeTexture() {
  return canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2 - 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(240,249,255,0.85)');
    g.addColorStop(1, 'rgba(230,244,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

function bannerTexture() {
  return canvasTexture(768, 192, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#f4879a');
    g.addColorStop(1, '#cf4f66');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.fillRect(0, 0, w, 22);
    c.strokeStyle = '#fff3e2';
    c.lineWidth = 5;
    c.setLineDash([16, 12]);
    c.strokeRect(14, 14, w - 28, h - 28);
    c.setLineDash([]);

    // little mountain glyphs either side
    c.fillStyle = '#fff3e2';
    for (const cx of [78, w - 78]) {
      c.beginPath();
      c.moveTo(cx - 42, h / 2 + 34);
      c.lineTo(cx - 8, h / 2 - 30);
      c.lineTo(cx + 26, h / 2 + 34);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(cx + 4, h / 2 + 34);
      c.lineTo(cx + 30, h / 2 - 12);
      c.lineTo(cx + 52, h / 2 + 34);
      c.closePath();
      c.fill();
    }

    c.font = '700 84px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(80,20,35,0.35)';
    c.fillText('SUMMIT SPRINT', w / 2 + 4, h / 2 + 8);
    c.fillStyle = '#fffaf0';
    c.fillText('SUMMIT SPRINT', w / 2, h / 2 + 3);
  });
}

function lodgeSignTexture() {
  return canvasTexture(512, 160, (c, w, h) => {
    c.fillStyle = '#f6e6c8';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#e5cfa8';
    c.fillRect(0, h - 18, w, 18);
    c.strokeStyle = '#7a5232';
    c.lineWidth = 8;
    c.strokeRect(10, 10, w - 20, h - 20);

    // steaming mug
    c.fillStyle = '#c44a60';
    c.beginPath();
    c.roundRect(38, 62, 52, 52, 8);
    c.fill();
    c.strokeStyle = '#c44a60';
    c.lineWidth = 8;
    c.beginPath();
    c.arc(96, 88, 16, -1.2, 1.2);
    c.stroke();
    c.strokeStyle = 'rgba(122,82,50,0.55)';
    c.lineWidth = 5;
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(52 + i * 14, 54);
      c.quadraticCurveTo(60 + i * 14, 38, 50 + i * 14, 24);
      c.stroke();
    }

    c.fillStyle = '#5f3f28';
    c.font = '700 54px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText('SUMMIT LODGE', 132, 66);
    c.font = '600 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#8a6242';
    c.fillText('hot cocoa  ·  warm paws', 134, 110);
  });
}

function trailSignTexture() {
  return canvasTexture(512, 160, (c, w, h) => {
    c.fillStyle = '#b98a5c';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < h; i += 12) c.fillRect(0, i, w, 4);
    c.strokeStyle = '#7a5232';
    c.lineWidth = 9;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#fff6e6';
    c.font = '700 60px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('SUNNY PLAZA', w / 2 + 24, h / 2 - 6);
    c.font = '600 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#ffe3bb';
    c.fillText('down the trail', w / 2 + 24, h / 2 + 42);
    // arrow
    c.fillStyle = '#fff6e6';
    c.beginPath();
    c.moveTo(30, h / 2);
    c.lineTo(74, h / 2 - 34);
    c.lineTo(74, h / 2 - 12);
    c.lineTo(104, h / 2 - 12);
    c.lineTo(104, h / 2 + 12);
    c.lineTo(74, h / 2 + 12);
    c.lineTo(74, h / 2 + 34);
    c.closePath();
    c.fill();
  });
}

function altitudeSignTexture() {
  return canvasTexture(384, 128, (c, w, h) => {
    c.fillStyle = '#3f6f96';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#d8ecfa';
    c.lineWidth = 6;
    c.strokeRect(8, 8, w - 16, h - 16);
    c.fillStyle = '#f2fbff';
    c.font = '700 44px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('FROSTY PEAK', w / 2, h / 2 - 14);
    c.font = '600 26px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#bfe0f5';
    c.fillText('2,140 m  ·  brrr', w / 2, h / 2 + 28);
  });
}

function thinIceTexture() {
  return canvasTexture(384, 256, (c, w, h) => {
    c.fillStyle = '#f6f2e4';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#e8657a';
    c.fillRect(0, 0, w, 54);
    c.fillStyle = '#fff6ea';
    c.font = '700 40px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('THIN ICE!', w / 2, 28);

    // cracked ice doodle
    c.strokeStyle = '#7fb6d8';
    c.lineWidth = 5;
    c.beginPath();
    c.ellipse(w / 2, 168, 118, 62, 0, 0, TAU);
    c.stroke();
    c.strokeStyle = '#a9cfe6';
    c.lineWidth = 3;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + 0.3;
      c.beginPath();
      c.moveTo(w / 2 + Math.cos(a) * 24, 168 + Math.sin(a) * 13);
      c.lineTo(w / 2 + Math.cos(a + 0.2) * 108, 168 + Math.sin(a + 0.2) * 56);
      c.stroke();
    }
    c.fillStyle = '#8a6242';
    c.font = '600 25px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('no skating, no snacking', w / 2, 86);
    c.font = '600 22px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#5f7c92';
    c.fillText('— peak patrol', w / 2, 238);
  });
}

function iceSheenTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,0.85)';
    c.lineWidth = 2.4;
    const cx = w / 2;
    const cy = h / 2;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + 0.4;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14);
      let r = 20;
      let ang = a;
      while (r < 118) {
        ang += (((i * 37 + r) % 17) / 17 - 0.5) * 0.5;
        r += 16;
        c.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
      }
      c.stroke();
    }
    c.globalAlpha = 0.55;
    c.strokeStyle = '#ffffff';
    c.lineWidth = 9;
    c.beginPath();
    c.ellipse(cx - 26, cy - 30, 62, 16, -0.5, 0, TAU);
    c.stroke();
    c.beginPath();
    c.ellipse(cx + 40, cy + 42, 34, 9, -0.4, 0, TAU);
    c.stroke();
    c.globalAlpha = 1;
  });
}

function liftPlateTexture() {
  return canvasTexture(256, 128, (c, w, h) => {
    c.fillStyle = '#f2b64a';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#5f3f28';
    c.font = '700 46px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('LIFT 1', w / 2, h / 2 - 16);
    c.font = '600 24px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('keep tails tucked', w / 2, h / 2 + 30);
  });
}

/* --- prop builders (module scope: no per-instance state) ------------------- */

function makeTreeGeo(tall) {
  const p = [];
  const trunkH = tall ? 1.25 : 0.95;
  part(p, new THREE.CylinderGeometry(0.13, 0.21, trunkH, 6), C.bark, { y: trunkH / 2 });
  const tiers = tall
    ? [[1.02, 1.7, 0.95], [0.82, 1.5, 1.95], [0.58, 1.35, 2.85]]
    : [[1.15, 1.5, 0.75], [0.88, 1.3, 1.7], [0.55, 1.1, 2.5]];
  for (let i = 0; i < tiers.length; i++) {
    const [r, hgt, base] = tiers[i];
    part(p, new THREE.ConeGeometry(r, hgt, 8), i % 2 ? C.pineLit : C.pine, { y: base + hgt / 2 });
    // snow dusting: same taper, top slice, nudged out so it reads as a crust
    part(p, new THREE.ConeGeometry(r * 0.5, hgt * 0.46, 8), C.snowLit, {
      y: base + hgt * 0.77,
    });
  }
  return mergeParts(p);
}

function makeRockGeo() {
  const p = [];
  const rock = new THREE.IcosahedronGeometry(0.62, 0);
  rock.scale(1.15, 0.8, 0.95);
  part(p, rock, C.rock, { y: 0.34 });
  const cap = new THREE.SphereGeometry(0.5, 8, 6, 0, TAU, 0, Math.PI * 0.55);
  part(p, cap, C.snowLit, { sx: 1.2, sy: 0.55, sz: 1.05, y: 0.62 });
  return mergeParts(p);
}

function makeSledGeo() {
  const p = [];
  const body = new THREE.BoxGeometry(0.62, 0.1, 1.5);
  part(p, body, 0xffffff, { y: 0.2 });
  part(p, new THREE.BoxGeometry(0.62, 0.1, 0.42), 0xffffff, { rx: -0.75, y: 0.32, z: -0.82 });
  part(p, new THREE.BoxGeometry(0.09, 0.16, 1.52), C.steelDark, { x: -0.27, y: 0.08 });
  part(p, new THREE.BoxGeometry(0.09, 0.16, 1.52), C.steelDark, { x: 0.27, y: 0.08 });
  part(p, new THREE.CylinderGeometry(0.035, 0.035, 0.56, 5), C.woodDark, { rz: Math.PI / 2, y: 0.3, z: 0.62 });
  return mergeParts(p);
}

function makeChairGeo() {
  const p = [];
  part(p, new THREE.CylinderGeometry(0.045, 0.045, 1.5, 6), C.steel, { y: -0.75 });
  part(p, new THREE.BoxGeometry(1.25, 0.11, 0.14), C.steel, { y: -1.5 });
  part(p, new THREE.BoxGeometry(1.2, 0.12, 0.62), C.coral, { y: -1.6, z: 0.08 });
  part(p, new THREE.BoxGeometry(1.2, 0.66, 0.11), C.coralDark, { y: -1.9, z: -0.24 });
  part(p, new THREE.BoxGeometry(1.24, 0.1, 0.1), C.steel, { y: -2.16, z: -0.22 });
  part(p, new THREE.BoxGeometry(1.05, 0.07, 0.3), C.steelDark, { y: -2.06, z: 0.5, rx: 0.28 });
  part(p, new THREE.SphereGeometry(0.12, 8, 6), C.steelDark, { y: -0.02 });
  return mergeParts(p);
}

function makePennantGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.16, 0);
  s.lineTo(0.16, 0);
  s.lineTo(0, -0.4);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  paintGeo(g, 0xffffff);
  return g;
}

function makeIcicleGeo() {
  const g = new THREE.ConeGeometry(0.06, 0.5, 5);
  g.rotateX(Math.PI);
  g.translate(0, -0.25, 0);
  paintGeo(g, 0xdff2ff);
  return g;
}

function makeSlalomGeo() {
  const p = [];
  part(p, new THREE.CylinderGeometry(0.05, 0.05, 1.9, 6), 0xffffff, { y: 0.95 });
  part(p, new THREE.BoxGeometry(0.02, 0.3, 0.42), 0xffffff, { y: 1.68, z: 0.21 });
  return mergeParts(p);
}

/* --------------------------------------------------------------------------- */

export class PeakRoom extends Room {
  id = 'peak';
  name = 'Frosty Peak';

  build(scene, game) {
    this._t = 0;
    this._dummy = new THREE.Object3D();
    this._dummy.rotation.order = 'YXZ';
    this._v = new THREE.Vector3();
    this._rng = mulberry32(0x5f0757);

    scene.background = new THREE.Color(0xc3dcf1);
    scene.fog = new THREE.Fog(0xd9e9f7, 26, 82);

    this._lights(scene);
    this._sky(scene);
    this._ground(scene);
    this._clouds(scene);
    this._distantPeaks(scene);
    this._trees(scene);
    this._rocks(scene);
    this._lodge(scene);
    this._cocoaStand(scene);
    this._chairlift(scene);
    this._pond(scene);
    this._snowCapybara(scene);
    this._sledRack(scene);
    this._startGate(scene);
    this._trailSign(scene);
    this._trailFence(scene);
    this._snowfall(scene);
    this._sparkle(scene);

    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4),
      from_plaza: new THREE.Vector3(0, 0, 11.2),
    };

    this.hotspots.push(
      {
        id: 'play-sled',
        position: new THREE.Vector3(0, 0, -8.6),
        radius: 3.2,
        label: 'Play Summit Sprint',
        action: (g) => g.startMinigame('sled'),
      },
      {
        id: 'exit-plaza',
        position: new THREE.Vector3(0, 0, 12),
        radius: 3,
        label: 'Take the trail to Sunny Plaza',
        action: (g) => g.goToRoom('plaza', 'peak'),
      },
      {
        id: 'cocoa',
        position: new THREE.Vector3(COCOA.x, 0, COCOA.z),
        radius: 2.2,
        label: 'Warm up with cocoa',
        action: (g) => {
          g.audio?.play?.('ding');
          g.toast('You cup the mug with both paws. Toasty.');
        },
      },
    );

    this.cameraHint = { offset: new THREE.Vector3(0, 11.5, 20), lookHeight: 1.8 };
  }

  /* --- lighting ----------------------------------------------------------- */

  _lights(scene) {
    scene.add(new THREE.HemisphereLight(0xdcefff, 0x93aec9, 1.15));
    scene.add(new THREE.AmbientLight(0xa9c9e8, 0.32));

    const sun = new THREE.DirectionalLight(0xffe6bd, 1.55);
    sun.position.set(-22, 14, -27);
    sun.target.position.set(0, 0, 1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.05;
    const sc = sun.shadow.camera;
    sc.left = -20; sc.right = 20; sc.top = 20; sc.bottom = -20;
    sc.near = 2; sc.far = 80;
    sc.updateProjectionMatrix();
    scene.add(sun.target);
    scene.add(sun);

    // warm fill spilling out of the lodge
    this._lodgeLight = new THREE.PointLight(0xffc178, 26, 14, 2);
    this._lodgeLight.position.set(8.4, 2.4, 1.0);
    scene.add(this._lodgeLight);

    const lantern = new THREE.PointLight(0xffd08a, 9, 8, 2);
    lantern.position.set(2.0, 2.5, 11.8);
    scene.add(lantern);
  }

  _sky(scene) {
    const mat = makeGlow(0xffffff, { unique: true });
    mat.map = skyTexture();
    mat.side = THREE.BackSide;
    mat.fog = false;
    mat.depthWrite = false;
    mat.needsUpdate = true;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 24, 16), mat);
    const d = SUN_DIR.clone().normalize();
    sky.rotation.y = Math.atan2(-d.z, d.x);
    sky.renderOrder = -2;
    scene.add(sky);

    // pale sun disc + halo, parked at the painted glow
    const pos = SUN_DIR.clone().normalize().multiplyScalar(96);
    const discMat = makeGlow(0xfff6dc, { unique: true });
    discMat.fog = false;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.6, 26), discMat);
    disc.position.copy(pos);
    disc.lookAt(0, 8, 0);
    disc.renderOrder = -1;
    scene.add(disc);

    const haloMat = makeGlow(0xffffff, { unique: true });
    haloMat.map = canvasTexture(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2 - 1);
      g.addColorStop(0, 'rgba(255,244,214,0.75)');
      g.addColorStop(0.3, 'rgba(255,232,186,0.34)');
      g.addColorStop(1, 'rgba(255,226,178,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
    haloMat.transparent = true;
    haloMat.depthWrite = false;
    haloMat.blending = THREE.AdditiveBlending;
    haloMat.fog = false;
    haloMat.needsUpdate = true;
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), haloMat);
    halo.position.copy(pos).multiplyScalar(0.985);
    halo.lookAt(0, 8, 0);
    halo.renderOrder = -1;
    scene.add(halo);
    this._halo = halo;
  }

  /* --- terrain ------------------------------------------------------------ */

  _ground(scene) {
    const geo = new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2, GROUND_SEGS, GROUND_SEGS);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const col = new Float32Array(p.count * 3);
    const lit = new THREE.Color(C.snowLit);
    const shade = new THREE.Color(C.snowShade);
    const packed = new THREE.Color(C.packed);
    const tmp = new THREE.Color();

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const h = terrainH(x, z);
      p.setY(i, h);

      tmp.copy(shade).lerp(lit, 0.42 + 0.58 * smoothstep(-1.2, 2.4, h));
      const trail = 1 - smoothstep(1.5, 2.9, Math.abs(x));
      const clearing = 1 - smoothstep(BZ.r - 0.6, BZ.r + 2.0, Math.hypot(x - BZ.x, z - BZ.z));
      tmp.lerp(packed, Math.max(trail, clearing * 0.8) * 0.6);
      const grain = 0.965 + 0.07 * ((Math.sin(x * 7.3 + z * 4.1) + 1) * 0.5);
      col[i * 3] = tmp.r * grain;
      col[i * 3 + 1] = tmp.g * grain;
      col[i * 3 + 2] = tmp.b * grain;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();

    const ground = new THREE.Mesh(geo, makeToon(0xffffff, { vertexColors: true, steps: 4 }));
    ground.receiveShadow = true;
    scene.add(ground);
    this.groundMeshes = [ground];
  }

  _clouds(scene) {
    const rng = this._rng;
    const p = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * TAU + rng() * 0.16;
      const r = 24 + rng() * 8;
      const blob = new THREE.SphereGeometry(1, 8, 6);
      part(p, blob, i % 3 ? C.cloud : 0xffffff, {
        sx: 3.0 + rng() * 3.5,
        sy: 0.9 + rng() * 0.8,
        sz: 3.0 + rng() * 3.5,
        x: Math.cos(a) * r,
        y: -2.4 + rng() * 1.7,
        z: Math.sin(a) * r,
      });
    }
    const mesh = new THREE.Mesh(mergeParts(p), makeToon(0xffffff, VC));
    scene.add(mesh);
  }

  _distantPeaks(scene) {
    const rng = this._rng;
    const p = [];
    for (let i = 0; i < 15; i++) {
      const a = (i / 15) * TAU + rng() * 0.2;
      const r = 30 + rng() * 14;
      const hgt = 7.7 + rng() * 3.5;
      const rad = 4 + rng() * 3;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      part(p, new THREE.ConeGeometry(rad, hgt, 5), C.farRock, { ry: rng() * TAU, x, y: -4.2 + hgt / 2, z });
      part(p, new THREE.ConeGeometry(rad * 0.42, hgt * 0.4, 5), 0xf2f8ff, {
        ry: rng() * TAU, x, y: -4.2 + hgt * 0.8, z,
      });
    }
    const mat = makeToon(0xffffff, { vertexColors: true, unique: true });
    mat.fog = false;
    const mesh = new THREE.Mesh(mergeParts(p), mat);
    mesh.renderOrder = -1;
    scene.add(mesh);
  }

  /* --- vegetation --------------------------------------------------------- */

  _trees(scene) {
    const rng = this._rng;
    const towers = [[-12, 8.5], [12, -8]];
    const spots = [];
    const tries = 190;
    for (let i = 0; i < tries && spots.length < 58; i++) {
      const a = rng() * TAU;
      const r = i % 5 === 0 ? 8.6 + rng() * 3.4 : 12.4 + rng() * 4.9;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < 3.6) continue; // keep the pass clear
      if (Math.hypot(x - BZ.x, z - BZ.z) < BZ.r + 2.6) continue;
      if (Math.hypot(x - 10.6, z - 1.0) < 6.4) continue; // lodge terrace
      if (Math.hypot(x + 8.0, z + 1.6) < 5.2) continue; // pond
      if (Math.hypot(x, z + 9) < 5.4) continue; // start gate
      let clash = false;
      for (const t of towers) if (Math.hypot(x - t[0], z - t[1]) < 3.0) clash = true;
      for (const s of spots) if (Math.hypot(x - s[0], z - s[1]) < 1.7) clash = true;
      if (clash) continue;
      spots.push([x, z]);
    }

    const geos = [makeTreeGeo(true), makeTreeGeo(false)];
    const mat = makeToon(0xffffff, VC);
    // alternate the two silhouettes so the ring never reads as a repeat
    const buckets = [[], []];
    for (let i = 0; i < spots.length; i++) buckets[i % 3 === 2 ? 1 : 0].push(spots[i]);

    const d = this._dummy;
    for (let b = 0; b < 2; b++) {
      const list = buckets[b];
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geos[b], mat, list.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      for (let i = 0; i < list.length; i++) {
        const [x, z] = list[i];
        const s = 0.85 + rng() * 0.65;
        d.position.set(x, terrainH(x, z) - 0.08, z);
        d.rotation.set(0, rng() * TAU, 0);
        d.scale.setScalar(s);
        d.updateMatrix();
        inst.setMatrixAt(i, d.matrix);
        const rad = Math.hypot(x, z);
        if (rad < 13.4) this.obstacles.push({ x, z, r: 0.8 * s });
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      scene.add(inst);
    }
    d.scale.setScalar(1);
  }

  _rocks(scene) {
    const rng = this._rng;
    const inst = new THREE.InstancedMesh(makeRockGeo(), makeToon(0xffffff, VC), 18);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const d = this._dummy;
    let n = 0;
    for (let i = 0; i < 60 && n < 18; i++) {
      const a = rng() * TAU;
      const r = 6.5 + rng() * 10;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < 3.2) continue;
      if (Math.hypot(x - BZ.x, z - BZ.z) < BZ.r + 1.6) continue;
      if (Math.hypot(x - 10.6, z - 1.0) < 5.4) continue;
      if (Math.hypot(x + 8.0, z + 1.6) < 4.4) continue;
      const s = 0.55 + rng() * 1.05;
      d.position.set(x, terrainH(x, z) - 0.14, z);
      d.rotation.set(rng() * 0.2, rng() * TAU, rng() * 0.2);
      d.scale.setScalar(s);
      d.updateMatrix();
      inst.setMatrixAt(n++, d.matrix);
      if (s > 0.95 && r < 13) this.obstacles.push({ x, z, r: 0.62 * s });
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
    d.scale.setScalar(1);
  }

  /* --- ski lodge ---------------------------------------------------------- */

  _lodge(scene) {
    const g = new THREE.Group();
    g.position.set(10.6, 0, 1.0);
    g.rotation.y = -Math.PI / 2; // local +z faces west, out over the clearing
    scene.add(g);

    const solid = [];
    const glow = [];

    // plinth + walls
    part(solid, new THREE.BoxGeometry(8.6, 0.5, 6.6), C.rockDark, { y: 0.25 });
    part(solid, new THREE.BoxGeometry(8, 3.2, 6), C.wood, { y: 2.1 });
    // snow drift banked against the base
    part(solid, new THREE.SphereGeometry(1, 10, 7), C.snowLit, { sx: 4.6, sy: 0.7, sz: 1.1, y: 0.1, z: 3.1 });
    part(solid, new THREE.SphereGeometry(1, 10, 7), C.snowLit, { sx: 1.1, sy: 0.7, sz: 3.4, y: 0.1, x: -4.0 });

    // stacked log detail on the facade
    for (let i = 0; i < 5; i++) {
      part(solid, new THREE.CylinderGeometry(0.3, 0.3, 8.05, 8), i % 2 ? C.woodLit : C.wood, {
        rz: Math.PI / 2, y: 0.78 + i * 0.62, z: 2.94,
      });
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        part(solid, new THREE.CylinderGeometry(0.24, 0.26, 3.5, 7), C.woodDark, {
          x: sx * 3.96, y: 1.9, z: sz * 2.96,
        });
      }
    }

    // gable roof (ridge runs along local x)
    const slope = 0.538;
    for (const s of [1, -1]) {
      part(solid, new THREE.BoxGeometry(9.2, 0.26, 4.5), C.coralDark, {
        rx: s * slope, y: 4.63, z: s * 1.8,
      });
      part(solid, new THREE.BoxGeometry(9.34, 0.15, 4.16), C.snowLit, {
        rx: s * slope, y: 4.63 + 0.17, z: s * (1.8 + 0.1),
      });
      // gable end wall
      const tri = new THREE.Shape();
      tri.moveTo(-3.62, 0);
      tri.lineTo(3.62, 0);
      tri.lineTo(0, 2.16);
      tri.closePath();
      part(solid, new THREE.ShapeGeometry(tri), C.cream, { ry: s * Math.PI / 2, x: s * 4.03, y: 3.58 });
    }
    part(solid, new THREE.CylinderGeometry(0.22, 0.22, 9.3, 7), C.snowLit, { rz: Math.PI / 2, y: 5.76 });
    // round gable windows
    for (const s of [1, -1]) {
      part(glow, new THREE.CircleGeometry(0.4, 14), C.warm, { ry: s * Math.PI / 2, x: s * 4.08, y: 4.42 });
      part(solid, new THREE.TorusGeometry(0.46, 0.08, 5, 14), C.woodDark, { ry: s * Math.PI / 2, x: s * 4.09, y: 4.42 });
    }

    // door
    part(solid, new THREE.BoxGeometry(1.4, 2.4, 0.16), C.woodDark, { y: 1.7, z: 3.06 });
    part(glow, new THREE.CircleGeometry(0.26, 12), C.warm, { y: 2.42, z: 3.15 });
    part(solid, new THREE.SphereGeometry(0.09, 8, 6), C.gold, { x: 0.5, y: 1.66, z: 3.17 });
    part(glow, new THREE.PlaneGeometry(2.2, 0.06), C.warm, { rx: -Math.PI / 2, y: 0.6, z: 3.9 });

    // facade + side windows
    const win = (x, y, z, ry) => {
      part(solid, new THREE.BoxGeometry(1.4, 1.6, 0.12), C.woodLit, { ry, x, y, z });
      const gx = Math.sin(ry) * 0.08;
      const gz = Math.cos(ry) * 0.08;
      part(glow, new THREE.PlaneGeometry(1.1, 1.28), C.warm, { ry, x: x + gx, y, z: z + gz });
      part(solid, new THREE.BoxGeometry(0.08, 1.34, 0.06), C.woodDark, { ry, x: x + gx * 1.4, y, z: z + gz * 1.4 });
      part(solid, new THREE.BoxGeometry(1.16, 0.08, 0.06), C.woodDark, { ry, x: x + gx * 1.4, y, z: z + gz * 1.4 });
      part(solid, new THREE.BoxGeometry(1.6, 0.14, 0.34), C.snowLit, {
        ry, x: x + gx * 2.2, y: y + 0.88, z: z + gz * 2.2,
      });
    };
    win(-2.3, 2.25, 3.02, 0);
    win(2.3, 2.25, 3.02, 0);
    win(4.03, 2.25, 1.5, Math.PI / 2);
    win(4.03, 2.25, -1.5, Math.PI / 2);

    // porch deck, posts + rail
    part(solid, new THREE.BoxGeometry(6.0, 0.28, 2.0), C.woodLit, { y: 0.44, z: 4.0 });
    for (const s of [-1, 1]) {
      part(solid, new THREE.BoxGeometry(0.18, 2.9, 0.18), C.woodDark, { x: s * 2.7, y: 2.0, z: 4.8 });
      part(solid, new THREE.BoxGeometry(0.14, 0.5, 1.7), C.woodDark, { x: s * 2.7, y: 1.05, z: 4.1 });
      part(solid, new THREE.CylinderGeometry(0.06, 0.06, 1.7, 5), C.woodLit, { rx: Math.PI / 2, x: s * 2.7, y: 1.28, z: 4.1 });
    }
    part(solid, new THREE.BoxGeometry(6.2, 0.2, 2.6), C.coralDark, { rx: 0.4, y: 3.62, z: 4.5 });
    part(solid, new THREE.BoxGeometry(6.3, 0.12, 2.4), C.snowLit, { rx: 0.4, y: 3.76, z: 4.55 });

    // chimney
    part(solid, new THREE.BoxGeometry(0.95, 2.8, 0.95), C.rockDark, { x: 2.6, y: 4.6, z: -0.9 });
    part(solid, new THREE.BoxGeometry(1.14, 0.2, 1.14), C.rock, { x: 2.6, y: 5.95, z: -0.9 });
    part(solid, new THREE.BoxGeometry(1.2, 0.16, 1.2), C.snowLit, { x: 2.6, y: 6.1, z: -0.9 });

    // skis + poles leaning by the door
    part(solid, new THREE.BoxGeometry(0.14, 2.1, 0.05), C.sky, { rz: 0.22, rx: -0.16, x: -1.45, y: 1.55, z: 3.3 });
    part(solid, new THREE.BoxGeometry(0.14, 2.1, 0.05), C.gold, { rz: 0.3, rx: -0.16, x: -1.15, y: 1.55, z: 3.3 });
    link(solid, [1.35, 0.5, 3.25], [1.62, 2.0, 3.05], 0.035, C.steel);
    link(solid, [1.6, 0.5, 3.25], [1.86, 2.0, 3.05], 0.035, C.steel);

    const solidMeshLodge = solidMesh(solid);
    g.add(solidMeshLodge);
    const glowMeshLodge = glowMesh(glow);
    g.add(glowMeshLodge);
    this._windowMat = glowMeshLodge.userData.mat;

    // hanging sign
    const signMat = texMat(lodgeSignTexture(), { double: true });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.75), signMat);
    sign.position.set(0, 3.05, 3.62);
    g.add(sign);
    const chains = [];
    link(chains, [-1.0, 3.44, 3.62], [-1.0, 3.9, 3.5], 0.03, C.steelDark);
    link(chains, [1.0, 3.44, 3.62], [1.0, 3.9, 3.5], 0.03, C.steelDark);
    g.add(solidMesh(chains, { shadow: false }));

    // icicles along the eaves and the porch roof
    const ice = new THREE.InstancedMesh(makeIcicleGeo(), makeToon(0xffffff, VC), 34);
    const d = this._dummy;
    const rng = this._rng;
    let n = 0;
    for (let i = 0; i < 17; i++) {
      const x = -4.1 + (i / 16) * 8.2;
      d.position.set(x, 3.5, 3.62);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, 0.5 + rng() * 1.2, 1);
      d.updateMatrix();
      ice.setMatrixAt(n++, d.matrix);
    }
    for (let i = 0; i < 13; i++) {
      const x = -3.0 + (i / 12) * 6.0;
      d.position.set(x, 3.09, 5.7);
      d.scale.set(0.9, 0.4 + rng() * 0.9, 0.9);
      d.updateMatrix();
      ice.setMatrixAt(n++, d.matrix);
    }
    ice.count = n;
    ice.instanceMatrix.needsUpdate = true;
    ice.computeBoundingSphere();
    g.add(ice);
    d.scale.setScalar(1);

    // chimney smoke origin, in world space
    g.updateMatrixWorld(true);
    this._smokeAt = g.localToWorld(new THREE.Vector3(2.6, 6.3, -0.9));

    this.obstacles.push(
      { x: 11.0, z: -2.4, r: 3.4 },
      { x: 11.0, z: 1.0, r: 3.4 },
      { x: 11.0, z: 4.4, r: 3.4 },
      { x: 6.9, z: -0.6, r: 1.9 }, // porch deck
      { x: 6.9, z: 2.6, r: 1.9 },
    );

    this._puffs(scene);
  }

  /** One instanced puff cloud shared by the chimney and the cocoa mugs. */
  _puffs(scene) {
    const geo = new THREE.SphereGeometry(0.34, 7, 5);
    paintGeo(geo, 0xf0f4f8);
    const mat = makeToon(0xffffff, { vertexColors: true, unique: true });
    mat.transparent = true;
    mat.opacity = 0.62;
    mat.depthWrite = false;
    const inst = new THREE.InstancedMesh(geo, mat, 16);
    inst.frustumCulled = false;
    scene.add(inst);
    this._puffMesh = inst;
    this._puffData = [];
    const rng = this._rng;
    for (let i = 0; i < 10; i++) {
      this._puffData.push({ src: 0, t: rng(), speed: 0.34 + rng() * 0.14, drift: 0.5 + rng() * 0.7, size: 1 });
    }
    for (let i = 0; i < 6; i++) {
      this._puffData.push({ src: 1, t: rng(), speed: 0.8 + rng() * 0.3, drift: 0.12, size: 0.3 });
    }
    this._cocoaAt = new THREE.Vector3(COCOA.x, terrainH(COCOA.x, COCOA.z) + 1.45, COCOA.z);
  }

  _cocoaStand(scene) {
    const p = [];
    const x = COCOA.x;
    const z = COCOA.z;
    const y = terrainH(x, z);
    // barrel table
    part(p, new THREE.CylinderGeometry(0.62, 0.55, 1.05, 12), C.woodDark, { y: 0.52 });
    part(p, new THREE.TorusGeometry(0.6, 0.06, 5, 14), C.steelDark, { rx: Math.PI / 2, y: 0.28 });
    part(p, new THREE.TorusGeometry(0.63, 0.06, 5, 14), C.steelDark, { rx: Math.PI / 2, y: 0.84 });
    part(p, new THREE.CylinderGeometry(0.78, 0.78, 0.1, 14), C.woodLit, { y: 1.09 });
    part(p, new THREE.CylinderGeometry(0.8, 0.8, 0.07, 14), C.snowLit, { y: 1.16 });
    // three mugs
    const mugColors = [C.coral, C.sky, C.gold];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      const mx = Math.cos(a) * 0.36;
      const mz = Math.sin(a) * 0.36;
      part(p, new THREE.CylinderGeometry(0.14, 0.12, 0.24, 9), mugColors[i], { x: mx, y: 1.32, z: mz });
      part(p, new THREE.TorusGeometry(0.08, 0.025, 4, 8), mugColors[i], { x: mx + 0.16, y: 1.32, z: mz });
      part(p, new THREE.CylinderGeometry(0.115, 0.115, 0.03, 9), 0xd6a06a, { x: mx, y: 1.44, z: mz });
    }
    // a stack of firewood beside it
    for (let i = 0; i < 5; i++) {
      const row = i < 3 ? 0 : 1;
      const idx = i < 3 ? i : i - 3;
      part(p, new THREE.CylinderGeometry(0.11, 0.11, 0.86, 7), i % 2 ? C.bark : C.woodDark, {
        rz: Math.PI / 2, x: 1.35, y: 0.12 + row * 0.21, z: -0.55 + idx * 0.24 + row * 0.12,
      });
    }
    const mesh = solidMesh(p);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    this.obstacles.push({ x, z, r: 1.0 });
  }

  /* --- chairlift ---------------------------------------------------------- */

  _chairlift(scene) {
    const ax = -12;
    const az = 8.5;
    const bx = 12;
    const bz = -8;
    const ay = terrainH(ax, az) + 7.2;
    const by = terrainH(bx, bz) + 6.9;
    this._lift = {
      a: new THREE.Vector3(ax, ay, az),
      b: new THREE.Vector3(bx, by, bz),
      sag: 2.3,
    };
    const dir = new THREE.Vector3(bx - ax, 0, bz - az).normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    this._lift.perp = perp;
    this._lift.yaw = Math.atan2(dir.x, dir.z);

    // towers
    const towers = [];
    const mk = (x, z, top) => {
      const base = terrainH(x, z);
      const g = [];
      part(g, new THREE.CylinderGeometry(0.26, 0.46, top, 8), C.steel, { y: top / 2 });
      part(g, new THREE.CylinderGeometry(0.62, 0.7, 0.5, 9), C.rockDark, { y: 0.2 });
      for (let i = 1; i < 4; i++) {
        part(g, new THREE.TorusGeometry(0.34 - i * 0.03, 0.05, 4, 9), C.steelDark, { rx: Math.PI / 2, y: (top / 4) * i });
      }
      part(g, new THREE.BoxGeometry(2.0, 0.2, 0.24), C.steel, { y: top - 0.1, ry: this._lift.yaw });
      for (const s of [-1, 1]) {
        part(g, new THREE.CylinderGeometry(0.2, 0.2, 0.16, 10), C.gold, {
          rz: Math.PI / 2, ry: this._lift.yaw,
          x: s * perp.x * 0.72, y: top - 0.26, z: s * perp.z * 0.72,
        });
      }
      part(g, new THREE.SphereGeometry(0.5, 8, 6, 0, TAU, 0, Math.PI * 0.5), C.snowLit, { sx: 1.1, sy: 0.5, sz: 1.1, y: top - 0.02 });
      const m = solidMesh(g);
      m.position.set(x, base, z);
      scene.add(m);
      towers.push(m);
      this.obstacles.push({ x, z, r: 1.05 });
      return base;
    };
    const baseA = mk(ax, az, 7.2);
    mk(bx, bz, 6.9);

    // sign plate on the west tower
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.55), texMat(liftPlateTexture(), { double: true }));
    plate.position.set(ax + 0.34, baseA + 2.4, az);
    plate.rotation.y = Math.PI / 2;
    scene.add(plate);

    // cables (two, one each way)
    const cableMat = makeToon(C.steelDark);
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 22; i++) {
        const t = i / 22;
        this._liftPoint(t, this._v);
        pts.push(new THREE.Vector3(
          this._v.x + perp.x * 0.72 * s,
          this._v.y,
          this._v.z + perp.z * 0.72 * s,
        ));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.05, 4, false), cableMat);
      scene.add(tube);
    }

    // chairs
    const chairs = new THREE.InstancedMesh(makeChairGeo(), makeToon(0xffffff, VC), 5);
    chairs.castShadow = true;
    chairs.frustumCulled = false;
    scene.add(chairs);
    this._chairs = chairs;
    this._chairData = [
      { t: 0.12, side: 1, dir: 1 },
      { t: 0.46, side: 1, dir: 1 },
      { t: 0.8, side: 1, dir: 1 },
      { t: 0.3, side: -1, dir: -1 },
      { t: 0.68, side: -1, dir: -1 },
    ];
  }

  _liftPoint(t, out) {
    const { a, b, sag } = this._lift;
    out.set(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t - sag * Math.sin(Math.PI * t),
      a.z + (b.z - a.z) * t,
    );
    return out;
  }

  /* --- frozen pond -------------------------------------------------------- */

  _pond(scene) {
    const px = -8.0;
    const pz = -1.6;
    const p = [];
    const ice = new THREE.CircleGeometry(3.4, 34);
    part(p, ice, C.ice, { rx: -Math.PI / 2, y: 0.05 });
    part(p, new THREE.CircleGeometry(2.3, 26), C.iceLit, { rx: -Math.PI / 2, y: 0.06 });
    part(p, new THREE.CircleGeometry(1.1, 20), C.iceDeep, { rx: -Math.PI / 2, y: 0.055 });
    part(p, new THREE.TorusGeometry(3.5, 0.3, 6, 30), C.snowLit, { rx: -Math.PI / 2, y: 0.1 });
    const mesh = solidMesh(p, { shadow: false });
    mesh.position.set(px, 0, pz);
    scene.add(mesh);

    const sheenMat = makeGlow(0xffffff, { unique: true });
    sheenMat.map = iceSheenTexture();
    sheenMat.transparent = true;
    sheenMat.depthWrite = false;
    sheenMat.opacity = 0.45;
    sheenMat.needsUpdate = true;
    const sheen = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 6.6), sheenMat);
    sheen.rotation.x = -Math.PI / 2;
    sheen.position.set(px, 0.09, pz);
    scene.add(sheen);
    this._sheenMat = sheenMat;

    this.obstacles.push({ x: px, z: pz, r: 3.85 });

    // warning sign on the near shore
    const sx = -5.0;
    const sz = 0.2;
    const posts = [];
    part(posts, new THREE.CylinderGeometry(0.09, 0.1, 1.9, 7), C.woodDark, { y: 0.95 });
    part(posts, new THREE.SphereGeometry(0.12, 7, 5), C.snowLit, { sy: 0.6, y: 1.9 });
    const sPost = solidMesh(posts);
    sPost.position.set(sx, terrainH(sx, sz), sz);
    scene.add(sPost);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.78), texMat(thinIceTexture(), { double: true }));
    board.position.set(sx, terrainH(sx, sz) + 1.62, sz + 0.06);
    board.rotation.y = 0.55;
    board.castShadow = true;
    scene.add(board);
    this.obstacles.push({ x: sx, z: sz, r: 0.45 });

    // a lonely sled parked at the shore, plus scattered snowballs
    const bits = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      part(bits, new THREE.SphereGeometry(0.16 + (i % 3) * 0.05, 7, 5), C.snowLit, {
        x: -4.0 + Math.cos(a) * 0.55, y: 0.12, z: 2.0 + Math.sin(a) * 0.4,
      });
    }
    const pile = solidMesh(bits, { shadow: false });
    scene.add(pile);
  }

  /* --- snow capybara ------------------------------------------------------ */

  _snowCapybara(scene) {
    const x = -6.2;
    const z = 7.5;
    const g = new THREE.Group();
    g.position.set(x, terrainH(x, z), z);
    g.rotation.y = 0.5;
    g.scale.setScalar(0.85);
    scene.add(g);

    const p = [];
    part(p, new THREE.SphereGeometry(1.0, 14, 11), C.snowLit, { sy: 0.88, y: 0.86 });
    part(p, new THREE.SphereGeometry(0.72, 13, 10), C.snow, { sy: 0.94, y: 2.02 });
    part(p, new THREE.SphereGeometry(0.56, 13, 10), C.snowLit, { sz: 1.06, y: 2.86, z: 0.05 });
    // capybara muzzle + ears
    part(p, new THREE.SphereGeometry(0.3, 10, 8), C.snow, { sy: 0.82, y: 2.74, z: 0.44 });
    for (const s of [-1, 1]) {
      part(p, new THREE.SphereGeometry(0.15, 8, 6), C.snow, { sz: 0.6, x: s * 0.37, y: 3.24, z: -0.02 });
      part(p, new THREE.SphereGeometry(0.075, 8, 6), C.coal, { x: s * 0.2, y: 2.98, z: 0.44 });
    }
    part(p, new THREE.ConeGeometry(0.12, 0.62, 8), C.carrot, { rx: Math.PI / 2, y: 2.72, z: 1.0 });
    for (let i = 0; i < 3; i++) {
      part(p, new THREE.SphereGeometry(0.09, 8, 6), C.coal, { y: 1.62 + i * 0.34, z: 0.62 - i * 0.06 });
    }
    // twig arms
    link(p, [-0.68, 1.9, 0], [-1.7, 2.55, 0.1], 0.055, C.bark);
    link(p, [-1.42, 2.38, 0.06], [-1.72, 2.82, -0.14], 0.04, C.bark);
    link(p, [0.68, 1.9, 0], [1.68, 2.3, -0.08], 0.055, C.bark);
    link(p, [1.42, 2.19, -0.05], [1.86, 2.02, -0.3], 0.04, C.bark);
    // scarf collar
    part(p, new THREE.TorusGeometry(0.5, 0.15, 6, 16), C.coral, { rx: Math.PI / 2, y: 2.42 });
    const body = solidMesh(p);
    g.add(body);

    // scarf tail, animated
    const tailParts = [];
    part(tailParts, new THREE.BoxGeometry(0.26, 0.62, 0.12), C.coral, { y: -0.31 });
    part(tailParts, new THREE.BoxGeometry(0.26, 0.5, 0.12), C.coralDark, { y: -0.86 });
    part(tailParts, new THREE.BoxGeometry(0.26, 0.16, 0.12), C.cream, { y: -1.18 });
    const tail = solidMesh(tailParts);
    tail.position.set(-0.42, 2.44, 0.3);
    g.add(tail);
    this._scarf = tail;

    // a tiny snow-capy friend beside it
    const mini = [];
    part(mini, new THREE.SphereGeometry(0.34, 10, 8), C.snowLit, { sy: 0.9, y: 0.3 });
    part(mini, new THREE.SphereGeometry(0.24, 10, 8), C.snow, { y: 0.74 });
    part(mini, new THREE.SphereGeometry(0.13, 8, 6), C.snow, { sy: 0.8, y: 0.68, z: 0.2 });
    for (const s of [-1, 1]) {
      part(mini, new THREE.SphereGeometry(0.07, 6, 5), C.snow, { x: s * 0.16, y: 0.92, z: -0.01 });
      part(mini, new THREE.SphereGeometry(0.035, 6, 5), C.coal, { x: s * 0.09, y: 0.78, z: 0.21 });
    }
    part(mini, new THREE.ConeGeometry(0.055, 0.26, 7), C.carrot, { rx: Math.PI / 2, y: 0.68, z: 0.42 });
    const miniMesh = solidMesh(mini);
    miniMesh.position.set(1.5, 0, 0.9);
    miniMesh.rotation.y = -0.7;
    g.add(miniMesh);

    this.obstacles.push({ x, z, r: 1.35 });
  }

  /* --- sled rack ---------------------------------------------------------- */

  _sledRack(scene) {
    const x = 4.6;
    const z = -4.6;
    const y = terrainH(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = -0.55;
    scene.add(g);

    const p = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        part(p, new THREE.BoxGeometry(0.13, 1.7, 0.13), C.woodDark, {
          rz: sx * 0.02, rx: sz * 0.3, x: sx * 1.35, y: 0.85, z: sz * 0.5,
        });
      }
      part(p, new THREE.BoxGeometry(0.12, 0.12, 1.3), C.woodDark, { x: sx * 1.35, y: 0.45 });
    }
    part(p, new THREE.CylinderGeometry(0.09, 0.09, 3.0, 7), C.woodLit, { rz: Math.PI / 2, y: 1.62 });
    part(p, new THREE.CylinderGeometry(0.1, 0.1, 3.0, 7), C.snowLit, { rz: Math.PI / 2, y: 1.72, sy: 1, sx: 0.55, sz: 0.55 });
    part(p, new THREE.BoxGeometry(2.9, 0.1, 0.6), C.wood, { y: 0.2 });
    g.add(solidMesh(p));

    const sleds = new THREE.InstancedMesh(makeSledGeo(), makeToon(0xffffff, VC), 6);
    sleds.castShadow = true;
    sleds.receiveShadow = true;
    const cols = [C.coral, C.sky, C.gold, C.leaf, 0x9b6bd4, C.ember];
    const d = this._dummy;
    const col = new THREE.Color();
    for (let i = 0; i < 5; i++) {
      d.position.set(-1.1 + i * 0.56, 0.14, 0.2);
      d.rotation.set(-1.16, 0.06 * (i - 2), 0);
      d.updateMatrix();
      sleds.setMatrixAt(i, d.matrix);
      sleds.setColorAt(i, col.set(cols[i]));
    }
    // one abandoned on the snow
    d.position.set(2.4, 0.02, 1.5);
    d.rotation.set(0, 1.1, 0);
    d.updateMatrix();
    sleds.setMatrixAt(5, d.matrix);
    sleds.setColorAt(5, col.set(cols[5]));
    sleds.instanceMatrix.needsUpdate = true;
    if (sleds.instanceColor) sleds.instanceColor.needsUpdate = true;
    sleds.computeBoundingSphere();
    g.add(sleds);
    d.rotation.set(0, 0, 0);

    this.obstacles.push({ x, z, r: 1.7 });
  }

  /* --- race start gate ---------------------------------------------------- */

  _startGate(scene) {
    const gz = -9;
    const g = new THREE.Group();
    g.position.set(0, 0, gz);
    scene.add(g);

    const p = [];
    for (const s of [-1, 1]) {
      part(p, new THREE.CylinderGeometry(0.17, 0.22, 4.2, 9), C.cream, { x: s * 2.7, y: 2.1 });
      for (let i = 0; i < 4; i++) {
        part(p, new THREE.TorusGeometry(0.2, 0.06, 5, 11), C.coral, { rx: Math.PI / 2, x: s * 2.7, y: 0.6 + i * 0.85 });
      }
      part(p, new THREE.CylinderGeometry(0.34, 0.42, 0.36, 10), C.rockDark, { x: s * 2.7, y: 0.16 });
      part(p, new THREE.SphereGeometry(0.26, 9, 7), C.gold, { x: s * 2.7, y: 4.3 });
      part(p, new THREE.SphereGeometry(0.3, 8, 6, 0, TAU, 0, Math.PI * 0.55), C.snowLit, { sx: 1.2, sy: 0.6, sz: 1.2, x: s * 2.7, y: 4.46 });
      this.obstacles.push({ x: s * 2.7, z: gz, r: 0.5 });
    }
    part(p, new THREE.CylinderGeometry(0.09, 0.09, 5.6, 7), C.woodDark, { rz: Math.PI / 2, y: 3.9 });
    // start line stripes on the snow
    for (let i = 0; i < 9; i++) {
      part(p, new THREE.BoxGeometry(0.56, 0.04, 0.5), i % 2 ? C.coral : C.cream, {
        x: -2.24 + i * 0.56, y: 0.03, z: 0.45,
      });
    }
    g.add(solidMesh(p));

    // waving banner
    const bGeo = new THREE.PlaneGeometry(5.2, 1.24, 22, 3);
    const banner = new THREE.Mesh(bGeo, texMat(bannerTexture(), { double: true }));
    banner.position.set(0, 3.28, 0);
    banner.castShadow = false;
    g.add(banner);
    this._banner = {
      attr: bGeo.attributes.position,
      base: Float32Array.from(bGeo.attributes.position.array),
    };

    // pennant string under the banner
    const pen = new THREE.InstancedMesh(makePennantGeo(), makeToon(0xffffff, VC2), 11);
    pen.frustumCulled = false;
    g.add(pen);
    this._pennants = pen;
    const col = new THREE.Color();
    const penCols = [C.coral, C.sky, C.gold, C.leaf];
    for (let i = 0; i < 11; i++) pen.setColorAt(i, col.set(penCols[i % 4]));
    if (pen.instanceColor) pen.instanceColor.needsUpdate = true;

    // slalom poles running down the north chute
    const slalom = new THREE.InstancedMesh(makeSlalomGeo(), makeToon(0xffffff, VC), 10);
    slalom.castShadow = true;
    const d = this._dummy;
    for (let i = 0; i < 10; i++) {
      const sx = (i % 2 ? 1.5 : -1.5) + (i % 3) * 0.1;
      const sz = gz - 2.2 - i * 1.15;
      d.position.set(sx, terrainH(sx, sz), sz);
      d.rotation.set(0.05 * (i % 3), i * 0.7, 0.04 * (i % 2 ? 1 : -1));
      d.updateMatrix();
      slalom.setMatrixAt(i, d.matrix);
      slalom.setColorAt(i, col.set(i % 2 ? C.sky : C.coral));
    }
    slalom.instanceMatrix.needsUpdate = true;
    if (slalom.instanceColor) slalom.instanceColor.needsUpdate = true;
    slalom.computeBoundingSphere();
    scene.add(slalom);
    d.rotation.set(0, 0, 0);

    // hay-bale style padding of packed snow beside the gate
    const pads = [];
    for (const s of [-1, 1]) {
      part(pads, new THREE.BoxGeometry(1.5, 0.55, 0.7), C.packed, { x: s * 4.0, y: 0.28, z: 0.2, ry: s * 0.2 });
      part(pads, new THREE.BoxGeometry(1.5, 0.12, 0.74), C.snowLit, { x: s * 4.0, y: 0.6, z: 0.2, ry: s * 0.2 });
      this.obstacles.push({ x: s * 4.0, z: gz + 0.2, r: 0.85 });
    }
    g.add(solidMesh(pads));
  }

  /* --- trail signpost + fence --------------------------------------------- */

  _trailSign(scene) {
    const x = 2.0;
    const z = 11.8;
    const g = new THREE.Group();
    g.position.set(x, terrainH(x, z), z);
    g.rotation.y = -0.35;
    scene.add(g);

    const p = [];
    part(p, new THREE.CylinderGeometry(0.13, 0.16, 3.1, 8), C.woodDark, { y: 1.55 });
    part(p, new THREE.SphereGeometry(0.2, 8, 6, 0, TAU, 0, Math.PI * 0.55), C.snowLit, { sx: 1.2, sy: 0.7, sz: 1.2, y: 3.08 });
    part(p, new THREE.CylinderGeometry(0.5, 0.55, 0.3, 10), C.snowLit, { y: 0.14 });
    // lantern on a bracket
    part(p, new THREE.BoxGeometry(0.06, 0.06, 0.6), C.steelDark, { y: 2.72, z: 0.3 });
    part(p, new THREE.BoxGeometry(0.3, 0.36, 0.3), C.steelDark, { y: 2.5, z: 0.56 });
    part(p, new THREE.ConeGeometry(0.26, 0.18, 4), C.coralDark, { ry: Math.PI / 4, y: 2.76, z: 0.56 });
    g.add(solidMesh(p));

    const lampMat = makeGlow(0xffd894, { unique: true });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.22), lampMat);
    lamp.position.set(0, 2.5, 0.56);
    g.add(lamp);
    this._lampMat = lampMat;

    const big = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.66), texMat(trailSignTexture(), { double: true }));
    big.position.set(0.35, 2.05, 0.09);
    big.castShadow = true;
    g.add(big);

    const small = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.5), texMat(altitudeSignTexture(), { double: true }));
    small.position.set(-0.3, 1.34, 0.09);
    small.rotation.z = 0.05;
    small.castShadow = true;
    g.add(small);

    this.obstacles.push({ x, z, r: 0.5 });
  }

  _trailFence(scene) {
    const p = [];
    for (const s of [-1, 1]) {
      const px = s * 3.05;
      let prev = null;
      // starts past the bot zone so server bots never meet a collider
      for (let i = 0; i < 6; i++) {
        const z = 9.0 + i * 1.5;
        const y = terrainH(px, z);
        part(p, new THREE.CylinderGeometry(0.09, 0.1, 1.3, 6), C.woodDark, { x: px, y: y + 0.65, z });
        part(p, new THREE.SphereGeometry(0.13, 7, 5), C.snowLit, { sy: 0.55, x: px, y: y + 1.32, z });
        this.obstacles.push({ x: px, z, r: 0.28 });
        const top = [px, y + 1.05, z];
        if (prev) {
          const midZ = (prev[2] + top[2]) / 2;
          const midY = (prev[1] + top[1]) / 2 - 0.16;
          link(p, prev, [px, midY, midZ], 0.035, C.cream);
          link(p, [px, midY, midZ], top, 0.035, C.cream);
        }
        prev = top;
      }
    }
    scene.add(solidMesh(p));
  }

  /* --- weather ------------------------------------------------------------ */

  _snowfall(scene) {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const meta = new Float32Array(N * 3);
    const rng = this._rng;
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rng() - 0.5) * 46;
      pos[i * 3 + 1] = rng() * 19 - 3;
      pos[i * 3 + 2] = (rng() - 0.5) * 46;
      meta[i * 3] = 0.7 + rng() * 1.3;
      meta[i * 3 + 1] = rng() * TAU;
      meta[i * 3 + 2] = 0.6 + rng() * 1.4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.19,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    mat.map = flakeTexture();
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    this._snow = { attr: geo.attributes.position, meta, n: N };
  }

  _sparkle(scene) {
    const N = 260;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const meta = new Float32Array(N * 2);
    const rng = this._rng;
    let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const a = rng() * TAU;
      const r = rng() * 15;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos[n * 3] = x;
      pos[n * 3 + 1] = terrainH(x, z) + 0.05;
      pos[n * 3 + 2] = z;
      meta[n * 2] = 1.4 + rng() * 3.4;
      meta[n * 2 + 1] = rng() * TAU;
      n++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16,
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
    });
    mat.map = flakeTexture();
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);
    this._sparkles = { attr: geo.attributes.color, arr: col, meta, n };
  }

  /* --- per-frame ---------------------------------------------------------- */

  update(dt) {
    const t = (this._t += dt);

    // falling snow
    const snow = this._snow;
    if (snow) {
      const a = snow.attr.array;
      const m = snow.meta;
      for (let i = 0; i < snow.n; i++) {
        const i3 = i * 3;
        a[i3 + 1] -= m[i3] * dt;
        a[i3] += Math.sin(t * m[i3 + 2] + m[i3 + 1]) * 0.6 * dt;
        a[i3 + 2] += Math.cos(t * m[i3 + 2] * 0.7 + m[i3 + 1]) * 0.35 * dt;
        if (a[i3 + 1] < -3) {
          a[i3 + 1] = 15.5 + (i % 7) * 0.5;
          a[i3] = ((a[i3] + 23) % 46) - 23;
          a[i3 + 2] = ((a[i3 + 2] + 23) % 46) - 23;
        }
      }
      snow.attr.needsUpdate = true;
    }

    // snow sparkle
    const sp = this._sparkles;
    if (sp) {
      const arr = sp.arr;
      const m = sp.meta;
      for (let i = 0; i < sp.n; i++) {
        const s = Math.sin(t * m[i * 2] + m[i * 2 + 1]);
        const v = s > 0.86 ? (s - 0.86) * 7.1 : 0;
        arr[i * 3] = v;
        arr[i * 3 + 1] = v * 0.97;
        arr[i * 3 + 2] = v;
      }
      sp.attr.needsUpdate = true;
    }

    // chairlift
    if (this._chairs) {
      const d = this._dummy;
      const perp = this._lift.perp;
      for (let i = 0; i < this._chairData.length; i++) {
        const c = this._chairData[i];
        c.t += dt * 0.028 * c.dir;
        if (c.t > 1) c.t -= 1;
        if (c.t < 0) c.t += 1;
        this._liftPoint(c.t, this._v);
        d.position.set(
          this._v.x + perp.x * 0.72 * c.side,
          this._v.y - 0.04,
          this._v.z + perp.z * 0.72 * c.side,
        );
        d.rotation.set(
          Math.sin(t * 1.5 + i * 1.9) * 0.07,
          this._lift.yaw + (c.dir < 0 ? Math.PI : 0),
          Math.sin(t * 1.1 + i) * 0.03,
        );
        d.updateMatrix();
        this._chairs.setMatrixAt(i, d.matrix);
      }
      this._chairs.instanceMatrix.needsUpdate = true;
    }

    // banner ripple
    const b = this._banner;
    if (b) {
      const arr = b.attr.array;
      const base = b.base;
      for (let i = 0; i < b.attr.count; i++) {
        const i3 = i * 3;
        const x = base[i3];
        const y = base[i3 + 1];
        arr[i3 + 2] = Math.sin(x * 1.5 - t * 3.4) * 0.14 + Math.sin(y * 2.2 + t * 2.1) * 0.04;
        arr[i3 + 1] = y + Math.sin(x * 1.5 - t * 3.4) * 0.03;
      }
      b.attr.needsUpdate = true;
    }

    // pennants fluttering under the banner
    if (this._pennants) {
      const d = this._dummy;
      for (let i = 0; i < 11; i++) {
        const x = -2.5 + i * 0.5;
        const sagY = 2.6 - Math.cos((i / 10 - 0.5) * 2.6) * 0.18;
        d.position.set(x, sagY, 0.02);
        d.rotation.set(Math.sin(t * 4 + i * 0.9) * 0.35, Math.sin(t * 2.2 + i) * 0.5, Math.sin(t * 3.1 + i * 0.6) * 0.16);
        d.updateMatrix();
        this._pennants.setMatrixAt(i, d.matrix);
      }
      this._pennants.instanceMatrix.needsUpdate = true;
    }

    // chimney smoke + cocoa steam
    if (this._puffMesh) {
      const d = this._dummy;
      const src = [this._smokeAt, this._cocoaAt];
      for (let i = 0; i < this._puffData.length; i++) {
        const p = this._puffData[i];
        p.t += dt * p.speed * 0.28;
        if (p.t > 1) p.t -= 1;
        const o = src[p.src];
        if (!o) continue;
        const rise = p.t * (p.src === 0 ? 5.4 : 1.5);
        const spread = p.src === 0 ? 1 : 0.28;
        d.position.set(
          o.x + Math.sin(p.t * 4 + i) * 0.35 * spread + p.t * p.drift,
          o.y + rise,
          o.z + Math.cos(p.t * 3.4 + i) * 0.3 * spread,
        );
        const s = p.size * (0.35 + p.t * 1.5) * Math.max(0, 1 - Math.pow(p.t, 3));
        d.rotation.set(p.t * 2, i, 0);
        d.scale.setScalar(Math.max(0.001, s));
        d.updateMatrix();
        this._puffMesh.setMatrixAt(i, d.matrix);
      }
      d.scale.setScalar(1);
      this._puffMesh.instanceMatrix.needsUpdate = true;
    }

    // scarf sway
    if (this._scarf) {
      this._scarf.rotation.z = Math.sin(t * 1.7) * 0.22 - 0.08;
      this._scarf.rotation.x = Math.sin(t * 2.3 + 1) * 0.12;
    }

    // ice shimmer, hearth flicker, sun breathing
    if (this._sheenMat) this._sheenMat.opacity = 0.32 + 0.18 * (0.5 + 0.5 * Math.sin(t * 0.7));
    if (this._windowMat) {
      const f = 0.93 + 0.07 * Math.sin(t * 3.1) * Math.sin(t * 1.7 + 0.6);
      this._windowMat.color.setRGB(1 * f, 0.965 * f, 0.9 * f);
    }
    if (this._lodgeLight) this._lodgeLight.intensity = 24 + Math.sin(t * 2.6) * 2.4;
    if (this._lampMat) {
      const f = 0.9 + 0.1 * Math.sin(t * 4.2 + 1.3);
      this._lampMat.color.setRGB(1 * f, 0.85 * f, 0.58 * f);
    }
    if (this._halo) {
      const s = 1 + Math.sin(t * 0.5) * 0.03;
      this._halo.scale.set(s, s, s);
    }
  }

  dispose() {
    this._snow = null;
    this._sparkles = null;
    this._banner = null;
    this._chairs = null;
    this._pennants = null;
    this._puffMesh = null;
    this._puffData = null;
    this._scarf = null;
    this._sheenMat = null;
    this._windowMat = null;
    this._lampMat = null;
    this._lodgeLight = null;
    this._halo = null;
  }
}
