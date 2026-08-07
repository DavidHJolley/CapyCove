import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/**
 * Driftwood Beach: a golden sand cove with an animated low-poly sea to the
 * west and south, a walkable dock out over the water (Reel Rush lives at the
 * end of it), palms, umbrellas, a sandcastle, crabs and circling gulls.
 *
 * Ground layout is polar around COVE: land where r < shoreR(theta).
 * The BOT_ZONES.beach circle is guaranteed dead flat (see sandY()).
 *
 * The Social Cove (wave 7, docs/LIVING-COVE.md) adds four live systems:
 *  - onClock(dayT, weather, aurora): a full day/night relight off the world
 *    clock (the western sunset is this room's signature) plus rain.
 *  - the BONFIRE: a cold log pile by day, lit dusk-to-dawn; idling in its
 *    glow earns the server-paid cozy trickle and shows an ember halo.
 *  - the BEACH BALL: server-owned position, locally predicted, bopped by
 *    clicking it or walking into it.
 *  - the DIVE BELL at the dock end: the way down to The Drift.
 */

// ---------------------------------------------------------------- geometry math
const TAU = Math.PI * 2;
const CX = 1, CZ = 1;              // cove centre (land radius is measured from here)
const ZONE = BOT_ZONES.beach;      // {x:0, z:2, r:5} - must stay flat + prop free
const WATER_Y = -0.30;
const DECK_Y = 0.62;
const DOCK_Z = -2.4;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Distance from the cove centre to the shoreline at angle `th`.
 *  Minimum value is 8.4 which keeps the whole bot zone (max r 6.42) inland. */
function shoreR(th) {
  return 11.3 + 2.5 * Math.cos(th + 0.45) + 0.4 * Math.sin(3 * th + 0.7);
}

/** Sand height. Flat (0) everywhere inside r=8, so the bot zone is dead flat. */
function sandY(x, z) {
  const dx = x - CX, dz = z - CZ;
  const r = Math.hypot(dx, dz);
  const R = shoreR(Math.atan2(dz, dx));
  const k = clamp01((r - 8) / 3.2);
  let y = k * (0.26 * Math.sin(x * 0.42 + 0.6) * Math.cos(z * 0.38) + 0.18 * Math.sin(z * 0.66 - x * 0.21));
  y += clamp01((r - 9.8) / 3.2) * 1.1;          // back dunes
  const lip = clamp01((r - (R - 1.7)) / 1.7);   // shore slope into the surf
  return y * (1 - lip) - lip * lip * 0.72;
}

// Swell: three crossed sine trains. Amplitude sums to 0.28, which keeps the
// surface above the sand lip (-0.72) and below the dry beach at all times.
const W1A = 0.13, W1K = 0.62, W1S = 1.15;
const W2A = 0.09, W2K = 0.85, W2S = -0.9;
const W3A = 0.06, W3K = 0.40, W3S = 1.9;

/** Sea surface offset at (x,z) and time t. Shared by water, foam, boat, floats. */
function waveY(x, z, t) {
  return W1A * Math.sin(x * W1K + t * W1S)
    + W2A * Math.sin(z * W2K + t * W2S)
    + W3A * Math.sin((x + z) * W3K + t * W3S);
}

/** Pull a point inland so props never end up standing in the surf. */
function toLand(x, z, margin = 2.2) {
  let dx = x - CX, dz = z - CZ;
  const r = Math.hypot(dx, dz) || 1e-4;
  const max = shoreR(Math.atan2(dz, dx)) - margin;
  if (r > max) { const s = max / r; dx *= s; dz *= s; }
  return { x: CX + dx, z: CZ + dz };
}

/** Push a point out of the guaranteed-walkable bot circle. */
function outOfZone(x, z, clear) {
  const dx = x - ZONE.x, dz = z - ZONE.z;
  const d = Math.hypot(dx, dz) || 1e-4;
  const need = ZONE.r + clear;
  if (d >= need) return { x, z };
  return { x: ZONE.x + (dx / d) * need, z: ZONE.z + (dz / d) * need };
}

/** Final prop placement: clear of the bot circle, clear of the water. */
function spot(x, z, clear = 0.9, margin = 2.2) {
  const a = outOfZone(x, z, clear);
  return toLand(a.x, a.z, margin);
}

// ---------------------------------------------------------------- world clock
// One cove day is 40 real minutes (server owns the truth; this only keeps the
// phase ticking smoothly between the 10s 'clock' frames).
const DAY_SECONDS = 40 * 60;
const MAX_ELEV = (58 * Math.PI) / 180;   // sun height at noon: raking, not overhead
// Once the sun is down the key light keeps the sun's azimuth and sits on this
// floor instead of mirroring to the anti-sun point: a mirror would swing every
// shadow through 180 degrees in one frame at the exact moment of sunset.
const NIGHT_ELEV = (9 * Math.PI) / 180;
// Phase used until the first clock frame lands: the golden late afternoon the
// room was originally lit for, so an offline/solo boot looks authored.
const DEFAULT_DAY_T = 0.4;

/**
 * Four-stop lighting LUT: dawn (dayT 0.0), noon (0.25), dusk (0.5),
 * night (0.75), wrapping back to dawn. Every relight smoothsteps between two
 * neighbouring stops, so the cove never snaps between looks.
 *
 * Dusk is this room's signature: violet overhead, coral mid-sky and gold along
 * the horizon exactly where the sun drops into the sea to the west.
 * `hemiI` never goes below 0.45 (LIVING-COVE playability floor).
 */
const SKY = [
  { // dawn
    top: 0x2f5f9e, mid: 0xf0a07c, hor: 0xffd9a8, horC: 0xa9c2dd, fog: 0xf4cba6,
    sun: 0xffb478, sunI: 1.25, hemiS: 0xffd3b0, hemiG: 0xc09a70, hemiI: 0.95,
    amb: 0xffd0b0, ambI: 0.32, water: 0x3f95c8, deep: 0x2a6f9e,
    cloud: 0xffd9c8, unlit: 0.86,
  },
  { // noon (the room's original palette)
    top: 0x3f9fd8, mid: 0x7cc8ea, hor: 0xdff0f2, horC: 0xc9e6ef, fog: 0xbfe3ef,
    sun: 0xffdaa0, sunI: 2.1, hemiS: 0xffe9c4, hemiG: 0xc89f68, hemiI: 1.15,
    amb: 0xffd9a8, ambI: 0.35, water: 0x3ba7dd, deep: 0x2b7fb8,
    cloud: 0xfff6e4, unlit: 1,
  },
  { // dusk
    top: 0x4a3f86, mid: 0xe8657a, hor: 0xffb257, horC: 0x7a5f96, fog: 0xf0a06e,
    // golden hour: the key light is grazing the sand at this point, so the warm
    // fills carry the look (this is what makes the whole cove glow at dusk)
    sun: 0xff8f4d, sunI: 1.75, hemiS: 0xffbe8a, hemiG: 0x74608a, hemiI: 1.0,
    amb: 0xffc79a, ambI: 0.5, water: 0x3c82bc, deep: 0x2d6b9c,
    cloud: 0xffb49c, unlit: 0.9,
  },
  { // night
    top: 0x0e1630, mid: 0x1a2447, hor: 0x2c3c62, horC: 0x18213c, fog: 0x1b2544,
    sun: 0xa8c4f0, sunI: 0.55, hemiS: 0x40548a, hemiG: 0x181d2e, hemiI: 0.5,
    amb: 0x8fa6d8, ambI: 0.3, water: 0x1d3f68, deep: 0x16324f,
    cloud: 0x3b4468, unlit: 0.42,
  },
];

/** Weather can arrive as a plain string or as a per-family map; take either. */
function readWeather(w) {
  if (typeof w === 'string') return w === 'rain' || w === 'breeze' ? w : 'clear';
  if (w && typeof w === 'object') return readWeather(w.beach ?? w.coast ?? w.outdoor);
  return 'clear';
}

const smoothstep = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;

// ---------------------------------------------------------------- scratch
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s3 = new THREE.Vector3(1, 1, 1);
const _v2 = new THREE.Vector2();
const _eu = new THREE.Euler(0, 0, 0, 'YXZ');
const _col = new THREE.Color();
// relight scratch: the clock runs every frame, so nothing here may allocate
const _mix = new THREE.Color();
const _mixB = new THREE.Color();
const _dir = new THREE.Vector3();

/** hex -> hex lerp into `out` (sRGB in, working space out). No allocation. */
function mixHex(a, b, f, out) {
  return out.setHex(a).lerp(_mixB.setHex(b), f);
}

// ---------------------------------------------------------------- toy layout
/**
 * The bonfire. Open flat sand north-east of the cove centre: 3.7 clear of the
 * BOT_ZONES circle, 2.3 clear of the jungle path corridor, well east of the
 * dock ramp and well north of the plaza path, so it is a gathering spot rather
 * than a road block. Sits at r 6.5 from the cove centre, i.e. sandY() === 0.
 */
const FIRE = { x: 3.6, z: -5.0, r: 1.3 };
const COZY_R = 3.0;          // "in the glow": LIVING-COVE says 3 units
const HALO_SLOTS = 5;        // capys who can show an ember halo at once
const HALO_PER = 8;          // embers each

// Beach ball. The server owns the position and tick-integrates at 10Hz; we
// predict with the same constants so it never looks like a slideshow, then
// ease onto every authoritative frame that arrives (see _onBallFrame).
const BALL_R = 0.42;
const BALL_G = 15;           // gravity
const BALL_BOUNCE = 0.62;    // restitution off the sand
const BALL_ROLL = 1.7;       // rolling friction (per second, exponential)
const BALL_AIR = 0.16;       // air drag
const BALL_HOME = { x: 1.2, z: 3.4 }; // open sand, only used until the server speaks
const BOP_H = 5.6;           // horizontal impulse of one bop
const BOP_V = 4.6;           // and its loft
const BOP_COOLDOWN = 0.35;   // seconds between bops from one player

// Dive bell davit. South-west corner of the fishing platform with the arm
// reaching out over the open water TOWARD the camera: hung off the far edge it
// spent its life behind its own mast.
const BELL = { x: -19.4, z: -0.75, out: 1.45 };

const RAIN_N = 240;          // rain streak pool (instanced, recycled)

function instAt(mesh, i, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _eu.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_eu);
  _v3.set(x, y, z);
  _s3.set(sx, sy, sz);
  mesh.setMatrixAt(i, _m4.compose(_v3, _q, _s3));
}

/** Transform a throwaway geometry in place (used for merging). */
function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _eu.set(rx, ry, rz, 'YXZ');
  g.applyMatrix4(_m4.compose(_v3.set(x, y, z), _q.setFromEuler(_eu), _s3.set(sx, sy, sz)));
  return g;
}

/**
 * Merge throwaway geometries into one buffer, optionally baking a per-part
 * colour into a vertex-colour attribute. Lets a whole prop cluster (sandcastle,
 * rod rack, beach clutter) render as a single draw call.
 * parts: [{ g, c }] - c is an sRGB hex, omitted means white.
 */
function merge(parts) {
  const src = parts.map((p) => (p.g.index ? p.g.toNonIndexed() : p.g));
  let n = 0;
  for (const g of src) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const g = src[i];
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    _col.set(parts[i].c ?? 0xffffff);
    for (let k = 0; k < c; k++) {
      col[(o + k) * 3] = _col.r; col[(o + k) * 3 + 1] = _col.g; col[(o + k) * 3 + 2] = _col.b;
    }
    o += c;
  }
  for (const p of parts) p.g.dispose();
  for (const g of src) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Toon material carrying a canvas texture (always unique so it gets disposed). */
function toonTex(color, tex, extra = {}) {
  const m = makeToon(color, { unique: true, ...extra });
  m.map = tex;
  m.needsUpdate = true;
  return m;
}

/** Unlit material carrying a canvas texture. */
function glowTex(color, tex, extra = {}) {
  const m = makeGlow(color, { unique: true });
  m.map = tex;
  Object.assign(m, extra);
  m.needsUpdate = true;
  return m;
}

/** Quad strip that follows the shoreline. inner/outer return {x,y,z} rel. to cove. */
function shoreRibbon(seg, inner, outer, uRepeat = 9) {
  const count = (seg + 1) * 2;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const idx = new Uint16Array(seg * 6);
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * TAU;
    const a = inner(th), b = outer(th);
    const k = i * 2;
    pos[k * 3] = a.x; pos[k * 3 + 1] = a.y; pos[k * 3 + 2] = a.z;
    pos[k * 3 + 3] = b.x; pos[k * 3 + 4] = b.y; pos[k * 3 + 5] = b.z;
    const u = (i / seg) * uRepeat;
    uv[k * 2] = u; uv[k * 2 + 1] = 1;
    uv[k * 2 + 2] = u; uv[k * 2 + 3] = 0;
    if (i < seg) {
      const o = i * 6;
      idx[o] = k; idx[o + 1] = k + 2; idx[o + 2] = k + 1;
      idx[o + 3] = k + 1; idx[o + 4] = k + 2; idx[o + 5] = k + 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- canvas art
function texSand() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#f2dca6'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 1100; i++) {
      const s = Math.random() * 1.7 + 0.4;
      c.fillStyle = Math.random() < 0.5 ? 'rgba(212,180,122,0.45)' : 'rgba(255,247,219,0.5)';
      c.fillRect(Math.random() * w, Math.random() * h, s, s);
    }
    const k = (Math.PI * 4) / w;
    c.lineWidth = 1.3;
    for (let i = 0; i < 7; i++) {
      c.strokeStyle = 'rgba(203,169,111,0.3)';
      c.beginPath();
      const y0 = i * (h / 7) + 5;
      c.moveTo(0, y0 + Math.sin(i) * 3);
      for (let x = 0; x <= w; x += 6) c.lineTo(x, y0 + Math.sin(x * k + i) * 3);
      c.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texPlanks(rx, ry) {
  const t = canvasTexture(256, 128, (c, w, h) => {
    const rows = 4, rh = h / rows;
    const shades = ['#c99a5f', '#bd8b50', '#d2a26b', '#c19158'];
    for (let r = 0; r < rows; r++) {
      c.fillStyle = shades[r % 4];
      c.fillRect(0, r * rh, w, rh);
      c.strokeStyle = 'rgba(118,78,40,0.22)'; c.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        const y = r * rh + 4 + Math.random() * (rh - 8);
        c.beginPath(); c.moveTo(0, y);
        for (let x = 0; x <= w; x += 16) c.lineTo(x, y + Math.sin(x * 0.05 + i) * 1.1);
        c.stroke();
      }
      c.fillStyle = 'rgba(86,54,28,0.55)'; c.fillRect(0, r * rh, w, 2);
      c.fillStyle = 'rgba(72,46,26,0.45)';
      for (const nx of [12, w * 0.5 - 6, w - 16]) {
        c.beginPath(); c.arc(nx, r * rh + rh * 0.5, 2.2, 0, TAU); c.fill();
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

function texBark() {
  const t = canvasTexture(64, 128, (c, w, h) => {
    c.fillStyle = '#b0804f'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) {
      const y = (i / 16) * h;
      c.fillStyle = i % 2 ? 'rgba(140,98,58,0.5)' : 'rgba(206,164,110,0.4)';
      c.fillRect(0, y, w, h / 32);
    }
    for (let i = 0; i < 220; i++) {
      c.fillStyle = 'rgba(122,86,50,0.35)';
      c.fillRect(Math.random() * w, Math.random() * h, 2, 1.5);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texStripes(a, b, bands) {
  const t = canvasTexture(128, 16, (c, w, h) => {
    const bw = w / bands;
    for (let i = 0; i < bands; i++) {
      c.fillStyle = i % 2 ? a : b;
      c.fillRect(i * bw, 0, bw + 1, h);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texTowel(a, b) {
  const t = canvasTexture(64, 64, (c, w, h) => {
    c.fillStyle = a; c.fillRect(0, 0, w, h);
    c.fillStyle = b;
    for (let i = 0; i < 4; i++) c.fillRect(0, i * 16 + 4, w, 7);
    c.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 4; i++) c.fillRect(0, i * 16 + 12, w, 2);
  });
  return t;
}

function texBall() {
  return canvasTexture(128, 64, (c, w, h) => {
    const cols = ['#fff1d6', '#e8657a', '#fff1d6', '#4fb3e8', '#fff1d6', '#f2b64a'];
    const bw = w / cols.length;
    for (let i = 0; i < cols.length; i++) { c.fillStyle = cols[i]; c.fillRect(i * bw, 0, bw + 1, h); }
  });
}

function texFoam() {
  return canvasTexture(256, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      c.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.5})`;
      c.beginPath(); c.arc(x, y, 2 + Math.random() * 7, 0, TAU); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 40; i++) {
      c.beginPath(); c.arc(Math.random() * w, h * (0.4 + Math.random() * 0.3), 1 + Math.random() * 3, 0, TAU); c.fill();
    }
  });
}

function texWet() {
  return canvasTexture(16, 64, (c, w, h) => {
    // uv.y 1 = inland edge (canvas top), uv.y 0 = water edge (canvas bottom)
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(190,156,102,0)');
    g.addColorStop(0.45, 'rgba(168,133,84,0.4)');
    g.addColorStop(1, 'rgba(146,112,66,0.66)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
}

function texPath() {
  const t = canvasTexture(64, 64, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(214,176,116,0)');
    g.addColorStop(0.25, 'rgba(222,187,127,0.7)');
    g.addColorStop(0.5, 'rgba(228,196,139,0.85)');
    g.addColorStop(0.75, 'rgba(222,187,127,0.7)');
    g.addColorStop(1, 'rgba(214,176,116,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      c.fillStyle = `rgba(180,146,96,${0.2 + Math.random() * 0.3})`;
      const y = 10 + Math.random() * (h - 20);
      c.beginPath(); c.arc(Math.random() * w, y, 0.8 + Math.random() * 1.8, 0, TAU); c.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texGlint() {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,246,214,0.55)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    c.fillStyle = g; c.beginPath(); c.arc(32, 32, 30, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2.5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(4, 32); c.lineTo(60, 32); c.moveTo(32, 6); c.lineTo(32, 58); c.stroke();
  });
}

/** Soft vertical streak for rain (alpha only; the material carries the tint). */
function texStreak() {
  return canvasTexture(8, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.8, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
}

/** Wet gloss decal: a dark damp pool with a bright rim highlight. */
function texPuddle() {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(32, 32, 4, 32, 32, 31);
    g.addColorStop(0, 'rgba(120,150,170,0.85)');
    g.addColorStop(0.55, 'rgba(96,126,150,0.6)');
    g.addColorStop(0.86, 'rgba(150,180,200,0.45)');
    g.addColorStop(1, 'rgba(150,180,200,0)');
    c.fillStyle = g; c.beginPath(); c.arc(32, 32, 31, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.ellipse(26, 25, 12, 6, -0.5, 0, TAU); c.stroke();
  });
}

/** The toast-free coin mote drawn above a capy warming by the fire. */
function drawMote(c, w, h, text) {
  c.clearRect(0, 0, w, h);
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = 'bold 58px "Trebuchet MS", system-ui, sans-serif';
  c.lineWidth = 10; c.lineJoin = 'round'; c.strokeStyle = '#6b3f1d';
  c.strokeText(text, w / 2, h / 2 + 2);
  c.fillStyle = '#ffd77a';
  c.fillText(text, w / 2, h / 2 + 2);
}

function texSign(title, sub, accent) {
  return canvasTexture(512, 128, (c, w, h) => {
    c.fillStyle = '#d9a662'; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(150,102,54,0.35)';
    for (let i = 0; i < 5; i++) c.fillRect(0, 8 + i * 26, w, 3);
    c.strokeStyle = '#a3703c'; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 54px Georgia, "Times New Roman", serif';
    c.lineWidth = 8; c.strokeStyle = '#fff3d8';
    c.strokeText(title, w / 2, sub ? 52 : h / 2);
    c.fillStyle = accent;
    c.fillText(title, w / 2, sub ? 52 : h / 2);
    if (sub) {
      c.font = 'bold 26px Georgia, "Times New Roman", serif';
      c.lineWidth = 5; c.strokeStyle = '#fff3d8';
      c.strokeText(sub, w / 2, 96);
      c.fillStyle = '#6b4526';
      c.fillText(sub, w / 2, 96);
    }
  });
}

// ---------------------------------------------------------------- the room
export class BeachRoom extends Room {
  id = 'beach';
  name = 'Driftwood Beach';

  build(scene, game) {
    this.t = Math.random() * 40;
    this._game = game;
    this._scene = scene;
    this.anim = {
      fronds: [], crabs: [], gulls: [], boats: [], clouds: [], torches: [],
      floats: [], glints: [], umbrellas: [],
    };

    // ---- world clock state (see onClock; dormant-safe defaults) ------------
    this._dayT = DEFAULT_DAY_T;   // locally advanced phase, eased onto the server's
    this._srvT = DEFAULT_DAY_T;   // last phase the server told us, aged forward
    this._hasClock = false;
    this._weather = 'clear';
    this._rainAmt = 0;            // eased 0..1 rain presence
    this._windAmt = 0.35;         // sway multiplier: clear 0.35, breeze 1, rain 0.8
    this._skyDirty = 0;           // seconds until the dome gradient is rewritten
    this._sunH = { x: -1, z: 0 }; // the sun's horizontal direction (sky azimuth)
    this._unlit = [];             // [{ mat, hex }] unlit decals that follow the sky
    this._lamps = [];             // [{ delay, on }] staggered dusk-to-dawn lights
    this._fireLit = 0;            // eased 0..1: the bonfire's night presence

    scene.background = new THREE.Color(0xf3d9ac);
    scene.fog = new THREE.Fog(0xf6dcae, 42, 150);

    this._buildLight(scene);
    this._buildSky(scene);
    this._buildSand(scene);
    this._buildSea(scene);
    this._buildDock(scene);
    this._buildDiveBell(scene);
    this._buildBoat(scene);
    this._buildPalms(scene);
    this._buildBeachStuff(scene);
    this._buildBonfire(scene);
    this._buildBall(scene);
    this._buildCritters(scene);
    this._buildExit(scene);
    this._buildJungleMouth(scene);
    this._buildRain(scene);

    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4),
      from_plaza: new THREE.Vector3(6.5, 0, 2), // open sand, unoccluded from the room camera
      // just inside the fern gap: 3.95 out from exit-jungle (r 2.8), so the
      // walk-through exit arms on the first frame instead of bouncing you back.
      // West of the driftwood log at (0.5,-8.5): that log and the palm behind it
      // have overlapping colliders, so the walkable gap is the one on this side.
      from_jungle: new THREE.Vector3(-0.1, 0, -6.0),
      // stepping off the dive bell: on the fishing platform, a pace south-east
      // of the davit and clear of the rod rack
      from_drift: new THREE.Vector3(-18.7, DECK_Y, -3.3),
    };
    // gentle east bias: keeps the cove and dock in frame even at the eastern
    // from_plaza spawn (a stronger offset framed mostly open sea there)
    this.cameraHint = { offset: new THREE.Vector3(3.5, 13, 16), lookHeight: 1.1 };
    // static camera: the whole cove, the dock out to the fishing spot, the plaza gate
    this.staticCamera = { position: new THREE.Vector3(0, 20, 29), lookAt: new THREE.Vector3(0, 1, -1.5) };

    // Live only while this room is: every handle is dropped in dispose().
    if (game?.events?.on) {
      this._offBall = game.events.on('ball', (m) => this._onBallFrame(m));
      this._offCoins = game.events.on('coins', (_total, delta, reason) => this._onCoins(delta, reason));
    }
    /*
     * A press on the beach ball has to be seen BEFORE the engine turns it into
     * a walk target, and the engine listens on the canvas itself. This sits on
     * window in the CAPTURE phase so it runs first; a press we take calls
     * stopPropagation and the canvas listener never sees it. Everything else -
     * HUD buttons, hotspot prompts, clicks on other capybaras, and every press
     * that misses the ball - passes through untouched.
     */
    this._onDown = (e) => this._pointerDown(e);
    addEventListener('pointerdown', this._onDown, true);

    this._relight();               // paint the authored default before frame one
    scene.updateMatrixWorld(true); // ground raycasts happen before the first render
  }

  // ---- world clock ---------------------------------------------------------
  /**
   * Server clock frame (also replayed once right after build by the engine).
   * `dayT` is a continuous phase in [0,1): 0 dawn, 0.25 noon, 0.5 dusk,
   * 0.75 midnight. `aurora` is a peak-only affair and ignored here.
   */
  onClock(dayT, weather, _aurora) {
    if (Number.isFinite(dayT)) {
      this._srvT = ((dayT % 1) + 1) % 1;
      if (!this._hasClock) this._dayT = this._srvT; // first frame: take it whole
      this._hasClock = true;
    }
    const w = readWeather(weather);
    if (w !== this._weather) {
      this._weather = w;
      this._windAmt = w === 'breeze' ? 1 : w === 'rain' ? 0.8 : 0.35;
    }
  }

  /** Advance the local phase and creep onto the server's between frames. */
  _advanceClock(dt) {
    const step = dt / DAY_SECONDS;
    this._dayT = (this._dayT + step) % 1;
    if (!this._hasClock) return;
    this._srvT = (this._srvT + step) % 1; // the last frame ages at the same rate
    let d = this._srvT - this._dayT;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    // a big gap means a backgrounded tab or a fresh join: take it in one go
    if (Math.abs(d) > 0.02) this._dayT = this._srvT;
    else this._dayT = (this._dayT + d * Math.min(1, dt * 0.7) + 1) % 1;
  }

  /**
   * Repaint the cove for the current phase + weather. Runs every frame, so it
   * lerps into preallocated colours and never allocates. The sky dome's vertex
   * gradient is the one heavy part and is rewritten at 5Hz (see _skyDirty).
   */
  _relight(dt = 0) {
    const dayT = this._dayT;
    const seg = dayT * 4;
    const i = Math.floor(seg) % 4;
    const j = (i + 1) % 4;
    const f = smoothstep(seg - Math.floor(seg));
    const A = SKY[i], B = SKY[j];

    // rain eases in and out rather than switching; it also greys everything
    const wantRain = this._weather === 'rain' ? 1 : 0;
    this._rainAmt += (wantRain - this._rainAmt) * Math.min(1, dt * 0.5);
    const rain = this._rainAmt;
    // rain kills the key light much harder than the fills: overcast is flat
    const gloom = 1 - rain * 0.62;

    // ---- sun / moon --------------------------------------------------------
    // Elevation is a sine over the day; the horizontal swing runs east -> north
    // -> west, which is what drops the sun into the sea to the west (this
    // room's whole reason for being) and keeps the noon light raking in from
    // behind the cove.
    const elev = Math.sin(dayT * TAU) * MAX_ELEV;
    const swing = dayT * TAU;
    let hx = Math.cos(swing), hz = -0.5 * Math.sin(swing);
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl; hz /= hl;
    this._sunH.x = hx; this._sunH.z = hz;   // _paintSky burns the sky around this
    // the key light never dips below the floor, so nothing ever flips
    const el = Math.max(elev, NIGHT_ELEV);
    const ce = Math.cos(el);
    _dir.set(hx * ce, Math.sin(el), hz * ce);

    const sun = this._sun;
    sun.position.copy(sun.target.position).addScaledVector(_dir, 44);
    mixHex(A.sun, B.sun, f, _mix);
    sun.color.copy(_mix);
    sun.intensity = lerp(A.sunI, B.sunI, f) * gloom;

    // The moon hangs where the light comes from; it fades up as the sun goes
    // down and is the only thing in the sky at midnight.
    const moon = this._moon;
    const moonK = clamp01((0.16 - elev) / 0.3);
    moon.visible = moonK > 0.02;
    if (moon.visible) {
      moon.position.copy(_dir).multiplyScalar(128);
      moon.lookAt(0, 6, 0);
      moon.material.opacity = moonK * 0.95 * gloom;
    }

    // The sun disc rides its TRUE elevation, so it actually sets into the sea
    // instead of hovering on the light's floor.
    const orb = this._orb;
    const ceRaw = Math.cos(elev);
    orb.group.position.set(hx * ceRaw, Math.sin(elev), hz * ceRaw).multiplyScalar(132);
    orb.group.lookAt(0, 6, 0);
    orb.group.visible = elev > -0.22;      // below that it is under the sea
    if (orb.group.visible) {
      // low sun = fat warm halo, high sun = small bright bead
      const low = 1 - Math.min(1, Math.max(0, elev) / MAX_ELEV);
      const dip = clamp01((elev + 0.22) / 0.22);   // fades out as it sinks
      orb.group.scale.setScalar(0.75 + low * 0.6);
      for (const d of orb.discs) {
        d.mat.color.copy(_mix).lerp(_mixB.setHex(0xffffff), low * 0.12);
        if (d.base < 1) d.mat.opacity = d.base * (0.55 + low * 0.8) * gloom * dip;
        else d.mat.opacity = dip;
      }
    }

    // ---- fills -------------------------------------------------------------
    const hemi = this._hemi;
    mixHex(A.hemiS, B.hemiS, f, _mix); hemi.color.copy(_mix);
    mixHex(A.hemiG, B.hemiG, f, _mix); hemi.groundColor.copy(_mix);
    // the sky fill barely dims in rain (that is what makes it read as overcast
    // rather than as dusk), and never drops below the playability floor
    hemi.intensity = Math.max(0.45, lerp(A.hemiI, B.hemiI, f) * (1 - rain * 0.12));
    const amb = this._amb;
    mixHex(A.amb, B.amb, f, _mix); amb.color.copy(_mix);
    amb.intensity = lerp(A.ambI, B.ambI, f);

    // ---- sky, fog, water ---------------------------------------------------
    const scene = this._scene;
    mixHex(A.fog, B.fog, f, _mix);
    if (rain > 0.01) _mix.lerp(_mixB.setHex(0x8fa0ac), rain * 0.55);
    scene.fog.color.copy(_mix);
    scene.background.copy(_mix);
    mixHex(A.water, B.water, f, _mix);
    this._waterMat.color.copy(_mix).multiplyScalar(gloom);
    mixHex(A.deep, B.deep, f, _mix);
    this._deepMat.color.copy(_mix).multiplyScalar(gloom);
    mixHex(A.cloud, B.cloud, f, _mix);
    this._cloudMat.color.copy(_mix).lerp(_mixB.setHex(0x9aa3ad), rain * 0.6);

    // unlit decals (foam, wet sand, paths, sign faces) have no light to dim
    // them, so they follow the sky by hand or they glow like paper at midnight
    const un = lerp(A.unlit, B.unlit, f) * gloom;
    for (const u of this._unlit) u.mat.color.setHex(u.hex).multiplyScalar(un);

    // Sun glitter belongs to the sun. The scatter is baked along the western
    // path, so it comes up through the morning, peaks into the sunset and
    // leaves a thinner moon trail behind it.
    const up = smoothstep(clamp01((elev + 0.14) / 0.4));
    const west = smoothstep(clamp01((dayT - 0.06) / 0.16));
    this._glintAmt = (0.3 + 0.8 * up * west) * (1 - rain * 0.8);

    if (this._skyDirty <= 0) { this._paintSky(A, B, f, rain); this._skyDirty = 0.2; }
    else this._skyDirty -= dt;

    // ---- lamps: on from dusk to dawn, each with its own lazy start ----------
    const want = elev < 0.1 ? 1 : 0;
    for (const l of this._lamps) {
      if (want && l.wait > 0) { l.wait -= dt; continue; }
      if (!want) l.wait = l.delay;
      l.on += (want - l.on) * Math.min(1, dt * 0.6);
    }
    this._fireLit = this._fireLamp ? this._fireLamp.on : want;
  }

  /**
   * Rewrite the dome's vertex gradient for the phase. Three stops up (horizon /
   * mid / zenith) and one across: the horizon burns toward the sun's azimuth
   * and cools away from it, so a sunset reads as a place in the sky rather than
   * a gold ring around the whole cove.
   */
  _paintSky(A, B, f, rain) {
    const dome = this._dome;
    if (!dome) return;
    const col = dome.geometry.attributes.color;
    const arr = col.array;
    const ts = this._domeT;
    const hs = this._domeH;
    const sx = this._sunH.x, sz = this._sunH.z;
    mixHex(A.top, B.top, f, _mix); if (rain > 0.01) _mix.lerp(_mixB.setHex(0x6d7c8a), rain * 0.6);
    const tr = _mix.r, tg = _mix.g, tb = _mix.b;
    mixHex(A.mid, B.mid, f, _mix); if (rain > 0.01) _mix.lerp(_mixB.setHex(0x8b98a4), rain * 0.6);
    const mr = _mix.r, mg = _mix.g, mb = _mix.b;
    mixHex(A.hor, B.hor, f, _mix); if (rain > 0.01) _mix.lerp(_mixB.setHex(0xa6b1ba), rain * 0.55);
    const hr = _mix.r, hg = _mix.g, hb = _mix.b;
    mixHex(A.horC, B.horC, f, _mix); if (rain > 0.01) _mix.lerp(_mixB.setHex(0x93a0ab), rain * 0.6);
    const cr = _mix.r, cg = _mix.g, cb = _mix.b;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      // 1 facing the sun, 0 facing away; squared so the glow stays local
      let w = hs[i * 2] * sx + hs[i * 2 + 1] * sz;
      w = w * 0.5 + 0.5;
      w *= w;
      const br = cr + (hr - cr) * w, bg = cg + (hg - cg) * w, bb = cb + (hb - cb) * w;
      let r, g, b;
      if (t < 0.36) {           // horizon -> mid
        const u = t / 0.36;
        r = br + (mr - br) * u; g = bg + (mg - bg) * u; b = bb + (mb - bb) * u;
      } else {                  // mid -> zenith
        const u = (t - 0.36) / 0.64;
        r = mr + (tr - mr) * u; g = mg + (tg - mg) * u; b = mb + (tb - mb) * u;
      }
      arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b;
    }
    col.needsUpdate = true;
  }

  /** Register an unlit material so the clock can dim it with the sky. */
  _followSky(mat, hex) {
    this._unlit.push({ mat, hex });
    return mat;
  }

  /** A dusk-to-dawn light with its own lazy start, so nothing lights in sync. */
  _addLamp(delay) {
    const l = { delay, wait: delay, on: 0 };
    this._lamps.push(l);
    return l;
  }

  // ---- lighting ------------------------------------------------------------
  // The whole rig is clock-driven (see _relight): one shadow-casting key that
  // swings from east to west and doubles as the moon, plus hemisphere/ambient
  // fills that dim but never go dark.
  _buildLight(scene) {
    this._hemi = new THREE.HemisphereLight(0xffe9c4, 0xc89f68, 1.15);
    scene.add(this._hemi);
    this._amb = new THREE.AmbientLight(0xffd9a8, 0.35);
    scene.add(this._amb);

    const sun = new THREE.DirectionalLight(0xffdaa0, 2.1);
    sun.position.set(-30, 16, -14); // low, from the west
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    const sc = sun.shadow.camera;
    sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24;
    sc.near = 1; sc.far = 90;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);
    sun.target.position.set(-2, 0, 0);
    this._sun = sun;
  }

  // ---- sky, sun, clouds ----------------------------------------------------
  _buildSky(scene) {
    // The dome carries its gradient in vertex colours rather than a baked
    // texture: the clock rewrites three stops (horizon / mid / zenith) into it,
    // which is what makes the sunset actually change colour instead of tint.
    const dg = new THREE.SphereGeometry(170, 32, 18, 0, TAU, 0, Math.PI * 0.58);
    const dp = dg.attributes.position;
    const dcol = new Float32Array(dp.count * 3);
    this._domeT = new Float32Array(dp.count);
    this._domeH = new Float32Array(dp.count * 2); // horizontal unit dir per vertex
    for (let i = 0; i < dp.count; i++) {
      this._domeT[i] = clamp01(dp.getY(i) / 170);   // 0 at the horizon, 1 overhead
      const hx = dp.getX(i), hz = dp.getZ(i);
      const hl = Math.hypot(hx, hz) || 1;
      this._domeH[i * 2] = hx / hl;
      this._domeH[i * 2 + 1] = hz / hl;
      dcol[i * 3] = dcol[i * 3 + 1] = dcol[i * 3 + 2] = 1;
    }
    dg.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
    const domeMat = makeGlow(0xffffff, { unique: true });
    domeMat.vertexColors = true;
    domeMat.side = THREE.BackSide;
    domeMat.fog = false;
    domeMat.depthWrite = false;
    const dome = new THREE.Mesh(dg, domeMat);
    dome.renderOrder = -10;
    scene.add(dome);
    this._dome = dome;

    // Sun/moon: one group the clock swings around the sky. The discs face the
    // cove (the group's +Z looks at it) and are stacked a hair apart so the
    // depth-write-free stack always paints core over halo.
    const orb = new THREE.Group();
    orb.position.set(-124, 20, -44);
    orb.renderOrder = -9;
    scene.add(orb);
    this._orb = { group: orb, discs: [] };
    let zoff = 0;
    for (const [r, c, o] of [[26, 0xffca7a, 0.16], [15, 0xffdc9c, 0.3], [7.4, 0xfff3d2, 1]]) {
      const m = makeGlow(c, { unique: true });
      m.fog = false; m.depthWrite = false;
      m.transparent = true; m.opacity = o;   // the core fades too as the sun sets
      if (o < 1) m.blending = THREE.AdditiveBlending;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 28), m);
      disc.position.z = (zoff += 0.4);
      disc.renderOrder = -9;
      orb.add(disc);
      this._orb.discs.push({ mat: m, base: o });
    }

    // the moon: one soft disc that lives where the night light comes from
    const moon = new THREE.Mesh(new THREE.CircleGeometry(9, 24), glowTex(0xdfe9ff, canvasTexture(64, 64, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      const rg = c.createRadialGradient(32, 32, 2, 32, 32, 31);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.34, 'rgba(240,246,255,0.95)');
      rg.addColorStop(0.42, 'rgba(210,226,255,0.35)');
      rg.addColorStop(1, 'rgba(180,205,255,0)');
      c.fillStyle = rg; c.beginPath(); c.arc(32, 32, 31, 0, TAU); c.fill();
      // a couple of lazy craters so it is not a sticker
      c.fillStyle = 'rgba(196,210,238,0.55)';
      c.beginPath(); c.arc(26, 26, 4.5, 0, TAU); c.fill();
      c.beginPath(); c.arc(38, 35, 3, 0, TAU); c.fill();
    }), { transparent: true, depthWrite: false, opacity: 0, fog: false, blending: THREE.AdditiveBlending }));
    moon.renderOrder = -9;
    moon.visible = false;
    scene.add(moon);
    this._moon = moon;

    const cloudMat = makeToon(0xfff6e4, { unique: true, fog: false });
    this._cloudMat = cloudMat;
    for (let i = 0; i < 5; i++) {
      const parts = [];
      const n = 4 + (i % 3);
      for (let j = 0; j < n; j++) {
        parts.push({
          g: xf(new THREE.SphereGeometry(1, 8, 6),
            (j - n / 2) * 1.5 + Math.sin(j * 3 + i) * 0.4, Math.sin(j * 2.1 + i) * 0.35, Math.cos(j * 1.7) * 0.9,
            0, 0, 0, 2.1 + Math.sin(j + i) * 0.6, 1.1, 1.5),
        });
      }
      const cloud = new THREE.Mesh(merge(parts), cloudMat);
      cloud.position.set(-60 + i * 32, 26 + (i % 3) * 5, -70 + ((i * 37) % 90));
      cloud.scale.setScalar(2.4 + (i % 3) * 0.7);
      cloud.renderOrder = -8;
      scene.add(cloud);
      this.anim.clouds.push(cloud);
    }
  }

  // ---- sand ---------------------------------------------------------------
  _buildSand(scene) {
    const SEG = 76, RINGS = 22;
    const vCount = (SEG + 1) * (RINGS + 1);
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx = new Uint16Array(SEG * RINGS * 6);
    let ii = 0;
    for (let j = 0; j <= RINGS; j++) {
      const rf = j / RINGS;
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * TAU;
        const r = shoreR(th) * rf;
        const x = CX + Math.cos(th) * r;
        const z = CZ + Math.sin(th) * r;
        const k = j * (SEG + 1) + i;
        pos[k * 3] = x; pos[k * 3 + 1] = sandY(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = x / 6; uv[k * 2 + 1] = z / 6;
      }
    }
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

    const sand = new THREE.Mesh(g, toonTex(0xffffff, texSand()));
    sand.receiveShadow = true;
    scene.add(sand);
    this.groundMeshes = [sand];

    // packed-sand path out to the plaza exit
    // stops short of the shoreline (land runs out around r=13.7 from the cove centre)
    const pts = [[13.2, 3.4], [11.9, 3.0], [9.8, 2.9], [7.4, 3.4], [4.6, 4.1], [2.0, 4.4], [0.2, 4.0]];
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const N = 46;
    const pp = new Float32Array((N + 1) * 2 * 3);
    const pu = new Float32Array((N + 1) * 2 * 2);
    const pi = new Uint16Array(N * 6);
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u);
      const tg = curve.getTangentAt(u);
      const nx = -tg.z, nz = tg.x;
      const hw = 1.5 - Math.cos(u * Math.PI) * 0.25;
      const k = i * 2;
      for (let s = 0; s < 2; s++) {
        const sgn = s ? 1 : -1;
        const x = p.x + nx * hw * sgn, z = p.z + nz * hw * sgn;
        pp[(k + s) * 3] = x; pp[(k + s) * 3 + 1] = sandY(x, z) + 0.035; pp[(k + s) * 3 + 2] = z;
        pu[(k + s) * 2] = u * 7; pu[(k + s) * 2 + 1] = s;
      }
      if (i < N) {
        // wound so the decal faces up (the strip's +normal side is vertex k+1)
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
    const path = new THREE.Mesh(pg, this._followSky(glowTex(0xffffff, texPath(), {
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
    }), 0xffffff));
    path.renderOrder = 1;
    scene.add(path);
  }

  // ---- sea, foam, glints, horizon -----------------------------------------
  _buildSea(scene) {
    // deep water out to the horizon (unique: the clock recolours it)
    this._deepMat = makeToon(0x2b7fb8, { unique: true });
    const deep = new THREE.Mesh(new THREE.CircleGeometry(160, 40), this._deepMat);
    deep.rotation.x = -Math.PI / 2;
    deep.position.y = -0.9;
    scene.add(deep);

    // Animated swell (NOT walkable). MeshToonMaterial has no flatShading, so
    // update() rewrites analytic normals each frame; the toon ramp then bands
    // the wave faces, which is the look we want anyway.
    const WSEG = 40, WSIZE = 62;
    const wg = new THREE.PlaneGeometry(WSIZE, WSIZE, WSEG, WSEG);
    this._waterMat = makeToon(0x3ba7dd, { unique: true });
    const water = new THREE.Mesh(wg, this._waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(-3, WATER_Y, 3);
    water.frustumCulled = false;
    scene.add(water);
    const wp = wg.attributes.position;
    const wx = new Float32Array(wp.count), wz = new Float32Array(wp.count);
    for (let i = 0; i < wp.count; i++) {
      wx[i] = wp.getX(i) + water.position.x;
      wz[i] = water.position.z - wp.getY(i);
    }
    this.anim.water = water; this.anim.wx = wx; this.anim.wz = wz;

    // wet sand band
    const wet = new THREE.Mesh(
      shoreRibbon(84,
        (th) => { const r = shoreR(th) - 2.6; const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r; return { x: x - CX, y: sandY(x, z) + 0.02, z: z - CZ }; },
        (th) => { const r = shoreR(th) + 0.3; const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r; return { x: x - CX, y: sandY(x, z) + 0.02, z: z - CZ }; }, 1),
      this._followSky(glowTex(0xffffff, texWet(), {
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
      }), 0xffffff),
    );
    wet.position.set(CX, 0, CZ);
    wet.renderOrder = 2;
    scene.add(wet);

    // animated foam line
    const foam = new THREE.Mesh(
      shoreRibbon(96,
        (th) => { const r = shoreR(th) - 1.35; const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r; return { x: x - CX, y: sandY(x, z) + 0.05, z: z - CZ }; },
        (th) => { const r = shoreR(th) + 0.85; return { x: Math.cos(th) * r, y: 0, z: Math.sin(th) * r }; }, 11),
      this._followSky(glowTex(0xffffff, (() => { const t = texFoam(); t.wrapS = THREE.RepeatWrapping; return t; })(), {
        transparent: true, depthWrite: false, opacity: 0.9,
      }), 0xffffff),
    );
    foam.position.set(CX, 0, CZ);
    foam.renderOrder = 3;
    scene.add(foam);
    this.anim.foam = foam;
    this.anim.foamOuter = [];
    const fp = foam.geometry.attributes.position;
    for (let i = 1; i < fp.count; i += 2) this.anim.foamOuter.push(i);

    // sun glints
    const gg = new THREE.PlaneGeometry(0.6, 0.6);
    gg.rotateX(-Math.PI / 2);
    const glints = new THREE.InstancedMesh(gg, this._followSky(glowTex(0xffffff, texGlint(), {
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }), 0xffffff), 54);
    glints.frustumCulled = false;
    scene.add(glints);
    for (let i = 0; i < 54; i++) {
      let x, z, tries = 0;
      do {
        // bias the scatter along the glitter path toward the sun (west-north-west)
        const along = -4 - Math.random() * 26;
        const across = (Math.random() - 0.5) * (i % 3 === 0 ? 30 : 9);
        x = along * 0.94 - across * 0.34;
        z = along * 0.34 + across * 0.94 + 2;
        tries++;
      } while (tries < 10 && Math.hypot(x - CX, z - CZ) < shoreR(Math.atan2(z - CZ, x - CX)) + 1.2);
      const th = Math.atan2(z - CZ, x - CX);
      const rr = Math.hypot(x - CX, z - CZ);
      const minR = shoreR(th) + 1.4;
      if (rr < minR) { x = CX + Math.cos(th) * minR; z = CZ + Math.sin(th) * minR; }
      this.anim.glints.push({ x, z, ph: Math.random() * TAU, sp: 0.7 + Math.random() * 1.4, sc: 0.55 + Math.random() * 0.9 });
    }
    this.anim.glintMesh = glints;

    // horizon islands (single merged silhouette)
    const isl = [];
    for (const [x, z, r, h] of [[-78, -46, 22, 11], [-104, 8, 15, 7], [-62, 52, 26, 13], [-40, -74, 12, 6]]) {
      isl.push({ g: xf(new THREE.ConeGeometry(r, h, 7, 1), x, h * 0.42 - 0.6, z), c: 0x6f97a6 });
      isl.push({ g: xf(new THREE.ConeGeometry(r * 0.55, h * 0.7, 6, 1), x + r * 0.5, h * 0.3 - 0.6, z + r * 0.3), c: 0x7ea5b0 });
    }
    const islands = new THREE.Mesh(merge(isl), makeToon(0xffffff, { unique: true, vertexColors: true }));
    scene.add(islands);

    // distant sailboats
    for (const [x, z, s, sp] of [[-46, -22, 3.2, 0.32], [-64, 26, 4.0, 0.22]]) {
      const b = new THREE.Group();
      const hull = [];
      hull.push({ g: xf(new THREE.BoxGeometry(2.6, 0.42, 0.9), 0, 0, 0), c: 0xf2ede0 });
      hull.push({ g: xf(new THREE.ConeGeometry(0.45, 1.1, 4), 1.55, 0, 0, 0, 0, -Math.PI / 2, 1, 1, 0.9), c: 0xf2ede0 });
      hull.push({ g: xf(new THREE.BoxGeometry(2.4, 0.16, 0.7), 0, 0.24, 0), c: 0xe8657a });
      hull.push({ g: xf(new THREE.CylinderGeometry(0.07, 0.09, 3.6, 6), -0.1, 1.9, 0), c: 0xd8c39a });
      b.add(new THREE.Mesh(merge(hull), makeToon(0xffffff, { unique: true, vertexColors: true })));
      const sail = [];
      const s1 = new THREE.PlaneGeometry(1.9, 3.0, 1, 1);
      sail.push({ g: xf(s1, 0.85, 1.9, 0, 0, Math.PI / 2, 0) });
      const s2 = new THREE.PlaneGeometry(1.1, 2.0, 1, 1);
      sail.push({ g: xf(s2, -0.75, 1.4, 0, 0, Math.PI / 2, 0) });
      b.add(new THREE.Mesh(merge(sail), makeToon(0xfffaf0, { unique: true, side: THREE.DoubleSide })));
      b.position.set(x, 0.2, z);
      b.scale.setScalar(s);
      b.rotation.y = 0.7;
      scene.add(b);
      this.anim.boats.push({ obj: b, sp, ph: Math.random() * TAU });
    }
  }

  // ---- dock + fishing station ---------------------------------------------
  _buildDock(scene) {
    const deckSideMat = makeToon(0xb98a52);
    const deckTopMat = toonTex(0xffffff, texPlanks(7, 2));
    const platTopMat = toonTex(0xffffff, texPlanks(3, 3));
    const mats = (top) => [deckSideMat, deckSideMat, top, deckSideMat, deckSideMat, deckSideMat];

    // main run: x from -16.6 (platform) to -6.2 (ramp head)
    const deck = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.28, 3.0), mats(deckTopMat));
    deck.position.set(-11.4, DECK_Y - 0.14, DOCK_Z);
    deck.castShadow = true; deck.receiveShadow = true;
    scene.add(deck);

    // end platform
    const plat = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.28, 4.6), mats(platTopMat));
    plat.position.set(-18.4, DECK_Y - 0.14, DOCK_Z);
    plat.castShadow = true; plat.receiveShadow = true;
    scene.add(plat);

    // Sand ramp. Its top face runs A->B exactly: A is sunk below the sand so the
    // sand/ramp join is seamless, B lands flush on the deck's east edge.
    const ax = -4.15, ay = -0.14, bx = -6.22, by = DECK_Y;
    const len = Math.hypot(bx - ax, by - ay);
    const ang = -Math.atan2(by - ay, ax - bx);
    const th = 0.3;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(len, th, 2.7), mats(toonTex(0xffffff, texPlanks(3, 1))));
    ramp.position.set(
      (ax + bx) / 2 - Math.sin(-ang) * th * 0.5,
      (ay + by) / 2 - Math.cos(ang) * th * 0.5,
      DOCK_Z,
    );
    ramp.rotation.z = ang;
    ramp.receiveShadow = true;
    scene.add(ramp);

    this.groundMeshes.push(deck, plat, ramp);

    // pilings
    const postG = new THREE.CylinderGeometry(0.17, 0.2, 3.0, 7);
    const posts = new THREE.InstancedMesh(postG, makeToon(0x7d5734), 22);
    posts.castShadow = true;
    let n = 0;
    for (const x of [-7.0, -9.3, -11.6, -13.9, -16.2, -17.4, -19.4, -20.4]) {
      for (const dz of [-1.35, 1.35]) {
        if (n >= 22) break;
        const zz = DOCK_Z + dz * (x < -16.4 ? 1.65 : 1);
        instAt(posts, n++, x, DECK_Y - 1.5 + Math.sin(x) * 0.05, zz,
          Math.random() * TAU, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05, 1, 1, 1);
      }
    }
    posts.count = n;
    scene.add(posts);

    // cross braces
    const braceG = new THREE.BoxGeometry(0.14, 0.14, 3.1);
    const braces = new THREE.InstancedMesh(braceG, makeToon(0x8b6039), 8);
    let bn = 0;
    for (const x of [-9.3, -13.9, -17.4, -20.4]) {
      instAt(braces, bn++, x, DECK_Y - 0.75, DOCK_Z, 0, 0, 0, 1, 1, x < -16.4 ? 1.6 : 1);
      instAt(braces, bn++, x, DECK_Y - 1.45, DOCK_Z, 0, 0, 0, 1, 1, x < -16.4 ? 1.6 : 1);
    }
    braces.count = bn;
    scene.add(braces);

    this._buildFishing(scene);
  }

  _buildFishing(scene) {
    const woodMat = makeToon(0xffffff, { unique: true, vertexColors: true });
    const parts = [];
    const P = (g, c) => parts.push({ g, c });

    // gateway sign frame at the mouth of the platform
    for (const z of [DOCK_Z - 2.1, DOCK_Z + 2.1]) {
      P(xf(new THREE.CylinderGeometry(0.13, 0.16, 3.0, 7), -16.5, DECK_Y + 1.5, z), 0x8b6039);
      P(xf(new THREE.BoxGeometry(0.34, 0.34, 0.34), -16.5, DECK_Y + 3.02, z), 0xc98f52);
    }
    P(xf(new THREE.BoxGeometry(0.22, 1.05, 4.5), -16.5, DECK_Y + 2.35, DOCK_Z), 0xa87844);

    // rod rack (A-frame + rods)
    const rackX = -19.9, rackZ = DOCK_Z;
    for (const dz of [-1.2, 1.2]) {
      P(xf(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6), rackX, DECK_Y + 0.6, rackZ + dz, 0, 0, 0.42), 0x9a6c3e);
      P(xf(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6), rackX, DECK_Y + 0.6, rackZ + dz, 0, 0, -0.42), 0x9a6c3e);
    }
    P(xf(new THREE.CylinderGeometry(0.06, 0.06, 2.7, 6), rackX, DECK_Y + 1.12, rackZ, Math.PI / 2, 0, 0), 0xb07c47);
    const rodTips = [];
    for (let i = 0; i < 5; i++) {
      const z = rackZ - 1.0 + i * 0.5;
      // rz > 0 leans the rod tip out west, over the water
      P(xf(new THREE.CylinderGeometry(0.018, 0.045, 2.9, 5), rackX + 0.55, DECK_Y + 1.35, z, 0, 0.1 * (i - 2), 0.44), 0x53381f);
      P(xf(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 8), rackX + 0.34, DECK_Y + 1.0, z, Math.PI / 2, 0, 0), [0xe8657a, 0x4fb3e8, 0xf2b64a, 0x7ac74f, 0xe8657a][i]);
      rodTips.push(new THREE.Vector3(rackX + 0.55 - 1.45 * Math.sin(0.44), DECK_Y + 1.35 + 1.45 * Math.cos(0.44), z));
    }

    // bait bucket, crate of fish, coiled rope, tackle box
    P(xf(new THREE.CylinderGeometry(0.34, 0.28, 0.5, 10), -17.6, DECK_Y + 0.25, DOCK_Z + 1.6), 0x4fb3e8);
    P(xf(new THREE.TorusGeometry(0.34, 0.04, 5, 12), -17.6, DECK_Y + 0.5, DOCK_Z + 1.6, Math.PI / 2, 0, 0), 0xdfe9ef);
    P(xf(new THREE.BoxGeometry(0.9, 0.6, 0.7), -19.4, DECK_Y + 0.3, DOCK_Z + 1.5), 0xb98a52);
    P(xf(new THREE.BoxGeometry(0.94, 0.1, 0.74), -19.4, DECK_Y + 0.62, DOCK_Z + 1.5), 0x8b6039);
    for (let i = 0; i < 3; i++) {
      P(xf(new THREE.SphereGeometry(0.15, 8, 6), -19.4 + (i - 1) * 0.26, DECK_Y + 0.72, DOCK_Z + 1.5, 0, 0.4 * i, 0, 1.7, 0.85, 0.7), 0xb9d7e8);
      P(xf(new THREE.ConeGeometry(0.12, 0.22, 4), -19.4 + (i - 1) * 0.26 - 0.3, DECK_Y + 0.72, DOCK_Z + 1.5, 0, 0, Math.PI / 2, 1, 1, 0.5), 0x9cc4da);
    }
    for (let i = 0; i < 3; i++) {
      P(xf(new THREE.TorusGeometry(0.36 - i * 0.06, 0.055, 5, 14), -17.4, DECK_Y + 0.06 + i * 0.1, DOCK_Z - 1.5, Math.PI / 2, 0, 0), 0xd9c08c);
    }
    P(xf(new THREE.BoxGeometry(0.62, 0.34, 0.42), -18.9, DECK_Y + 0.17, DOCK_Z - 1.7), 0xe8657a);

    // rope railing posts along the platform edge
    const railPts = [];
    for (const [x, z] of [[-16.6, -4.5], [-18.4, -4.6], [-20.3, -4.5], [-20.4, -2.4], [-20.3, -0.3], [-18.4, -0.2], [-16.6, -0.3]]) {
      P(xf(new THREE.CylinderGeometry(0.075, 0.085, 0.95, 6), x, DECK_Y + 0.44, z), 0x8b6039);
      P(xf(new THREE.SphereGeometry(0.1, 7, 5), x, DECK_Y + 0.92, z), 0xc98f52);
      railPts.push(new THREE.Vector3(x, DECK_Y + 0.78, z));
    }
    scene.add(Object.assign(new THREE.Mesh(merge(parts), woodMat), { castShadow: true, receiveShadow: true }));

    // sagging ropes between rail posts
    const ropeParts = [];
    for (let i = 0; i < railPts.length - 1; i++) {
      const a = railPts[i], b = railPts[i + 1];
      const mid = a.clone().lerp(b, 0.5); mid.y -= 0.18;
      const curve = new THREE.CatmullRomCurve3([a, mid, b]);
      ropeParts.push({ g: new THREE.TubeGeometry(curve, 6, 0.035, 4, false), c: 0xe4cd99 });
    }
    scene.add(new THREE.Mesh(merge(ropeParts), makeToon(0xffffff, { unique: true, vertexColors: true })));

    // signboards (front reads east, back reads west - neither is mirrored)
    const signTex = texSign('REEL RUSH', 'cast off at the rail', '#e8657a');
    const signTex2 = texSign('REEL RUSH', 'biggest catch wins coins', '#e8657a');
    for (const [ry, tex, off] of [[Math.PI / 2, signTex, 0.13], [-Math.PI / 2, signTex2, -0.13]]) {
      // unlit so the lettering reads even with the sun behind the board
      const s = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.92), this._followSky(glowTex(0xf7ead2, tex), 0xf7ead2));
      s.position.set(-16.5 + off, DECK_Y + 2.35, DOCK_Z);
      s.rotation.y = ry;
      scene.add(s);
    }

    // lantern on the rail + warm fill light
    const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.5, 6), makeToon(0x7d5734));
    lampPost.position.set(-20.4, DECK_Y + 0.75, DOCK_Z);
    scene.add(lampPost);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.34), makeGlow(0xffd47a, { unique: true }));
    lamp.position.set(-20.4, DECK_Y + 1.62, DOCK_Z);
    scene.add(lamp);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 4), makeToon(0x6d4a2b));
    cap.position.set(-20.4, DECK_Y + 1.93, DOCK_Z);
    cap.rotation.y = Math.PI / 4;
    scene.add(cap);
    const lampLight = new THREE.PointLight(0xffbe6a, 9, 10, 2);
    lampLight.position.set(-20.4, DECK_Y + 1.7, DOCK_Z);
    scene.add(lampLight);
    this.anim.lamp = lamp;
    this.anim.lampLight = lampLight;
    // the dock lantern is the first thing lit at dusk (someone works out here)
    this._lampDock = this._addLamp(0.3);

    // cast lines running from the rod tips out to bobbing floats
    const floatG = merge([
      { g: new THREE.SphereGeometry(0.13, 8, 6), c: 0xe8657a },
      { g: xf(new THREE.SphereGeometry(0.132, 8, 4, 0, TAU, 0, Math.PI / 2), 0, 0.002, 0), c: 0xfff1d6 },
    ]);
    const floats = new THREE.InstancedMesh(floatG, makeToon(0xffffff, { unique: true, vertexColors: true }), 4);
    const lineParts = [];
    for (let i = 0; i < 4; i++) {
      const fx = -21.5 - i * 0.5, fz = DOCK_Z - 1.2 + i * 0.8;
      this.anim.floats.push({ x: fx, z: fz });
      const tip = rodTips[i];
      lineParts.push({
        g: new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
          tip,
          new THREE.Vector3((tip.x + fx) / 2, (tip.y + WATER_Y) / 2 - 0.15, (tip.z + fz) / 2),
          new THREE.Vector3(fx, WATER_Y + 0.05, fz),
        ]), 8, 0.014, 3, false),
        c: 0xfbf6e4,
      });
    }
    scene.add(new THREE.Mesh(merge(lineParts), makeToon(0xffffff, { unique: true, vertexColors: true })));
    floats.frustumCulled = false;
    scene.add(floats);
    this.anim.floatMesh = floats;

    this.hotspots.push({
      id: 'play-fishing',
      position: new THREE.Vector3(-18.4, DECK_Y + 0.3, DOCK_Z),
      radius: 3.2,
      label: 'Play Reel Rush',
      action: (g) => g.startMinigame('fishing'),
    });

    this.obstacles.push({ x: -19.9, z: DOCK_Z, r: 0.9 }, { x: -17.6, z: DOCK_Z + 1.6, r: 0.5 });
  }

  // ---- moored rowboat ------------------------------------------------------
  _buildBoat(scene) {
    const boat = new THREE.Group();
    const prof = [
      [0.02, 0.00], [0.34, 0.03], [0.64, 0.14], [0.85, 0.36], [0.96, 0.62], [1.00, 0.80],
      [0.93, 0.81], [0.87, 0.63], [0.76, 0.38], [0.55, 0.16], [0.02, 0.11],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const hull = new THREE.Mesh(new THREE.LatheGeometry(prof, 16), makeToon(0xfaeeda));
    hull.scale.set(2.35, 1, 1);
    hull.castShadow = true;
    boat.add(hull);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.075, 6, 22), makeToon(0xe8657a));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.79;
    rim.scale.set(2.35, 1, 1);
    boat.add(rim);

    const kit = [];
    kit.push({ g: xf(new THREE.BoxGeometry(0.5, 0.08, 1.5), -0.85, 0.6, 0), c: 0xc08b4f });
    kit.push({ g: xf(new THREE.BoxGeometry(0.5, 0.08, 1.7), 0.55, 0.6, 0), c: 0xc08b4f });
    kit.push({ g: xf(new THREE.BoxGeometry(3.6, 0.06, 0.5), 0, 0.16, 0), c: 0xd8b884 });
    for (const [ox, oz, oy] of [[0.2, 0.55, 0.62], [0.35, -0.55, 0.62]]) {
      kit.push({ g: xf(new THREE.CylinderGeometry(0.05, 0.045, 2.5, 5), ox, oy, oz, 0, 0.35, Math.PI / 2), c: 0xb98a52 });
      kit.push({ g: xf(new THREE.BoxGeometry(0.42, 0.05, 0.2), ox - 1.15, oy, oz - 0.42, 0, 0.35, 0), c: 0xd6a86a });
    }
    kit.push({ g: xf(new THREE.TorusGeometry(0.2, 0.05, 5, 12), -1.75, 0.55, 0, Math.PI / 2, 0, 0), c: 0xe4cd99 });
    boat.add(new THREE.Mesh(merge(kit), makeToon(0xffffff, { unique: true, vertexColors: true })));

    boat.position.set(-13.4, WATER_Y + 0.28, -5.9);
    boat.rotation.y = 0.42;
    scene.add(boat);
    this.anim.boat = boat;

    // mooring rope to a dock post
    const rp = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-12.7, WATER_Y + 0.85, -5.2),
      new THREE.Vector3(-12.4, WATER_Y + 0.55, -4.6),
      new THREE.Vector3(-12.3, DECK_Y - 0.55, -3.75),
    ]);
    const rope = new THREE.Mesh(new THREE.TubeGeometry(rp, 10, 0.04, 5, false), makeToon(0xe4cd99));
    scene.add(rope);

    this.obstacles.push({ x: -13.4, z: -5.9, r: 1.9 });
  }

  // ---- palms ---------------------------------------------------------------
  _buildPalms(scene) {
    const raw = [
      [6.5, -5.5, 1.00], [9.6, -2.6, 0.86], [10.0, -5.6, 1.10], [4.2, -8.2, 0.94],
      [7.6, -9.4, 1.04], [-1.6, -7.4, 0.90], [-4.6, -4.6, 1.00], [1.4, -10.0, 0.82],
      [12.2, 0.2, 0.92], [11.0, 4.2, 0.98], [7.8, 7.6, 0.88], [9.8, -8.0, 0.80],
    ];
    const palms = raw.map(([x, z, s]) => {
      const p = spot(x, z, 1.0, 2.6);
      return { x: p.x, z: p.z, y: sandY(p.x, p.z), s, yaw: Math.random() * TAU };
    });

    // trunk: tapered cylinder bent along +X in local space
    const tg = new THREE.CylinderGeometry(0.17, 0.33, 5.4, 8, 7);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const y = tp.getY(i);
      const u = (y + 2.7) / 5.4;
      tp.setX(i, tp.getX(i) + 1.25 * u * u);
      tp.setZ(i, tp.getZ(i) + 0.22 * u * u * u);
    }
    tg.translate(0, 2.7, 0);
    tg.computeVertexNormals();
    // NB: instanced tints come from instanceColor, so these materials must NOT
    // set vertexColors (their geometries carry no colour attribute).
    const trunks = new THREE.InstancedMesh(tg, toonTex(0xffffff, (() => {
      const t = texBark(); t.repeat.set(2, 3); return t;
    })()), palms.length);
    trunks.castShadow = true;

    // frond: plane deformed into a drooping, feathered leaf along +Z
    const fg = new THREE.PlaneGeometry(0.9, 3.4, 3, 14);
    const fp = fg.attributes.position;
    for (let i = 0; i < fp.count; i++) {
      const x = fp.getX(i), y = fp.getY(i);
      const u = (y + 1.7) / 3.4;
      const taper = (1 - 0.88 * u * u) * (0.62 + 0.38 * Math.sin(u * 20));
      const nx = x * taper;
      fp.setXYZ(i, nx, -Math.abs(nx) * 0.55 - u * u * 1.5, u * 3.4);
    }
    fg.computeVertexNormals();
    const frondCount = palms.length * 7;
    const fronds = new THREE.InstancedMesh(fg, makeToon(0xffffff, {
      unique: true, side: THREE.DoubleSide,
    }), frondCount);
    fronds.castShadow = true;
    fronds.frustumCulled = false;

    const cg = new THREE.SphereGeometry(0.17, 8, 6);
    const nuts = new THREE.InstancedMesh(cg, makeToon(0x6b4a2a), palms.length * 3);
    let ni = 0, fi = 0;

    for (let i = 0; i < palms.length; i++) {
      const p = palms[i];
      instAt(trunks, i, p.x, p.y, p.z, p.yaw, 0, 0, p.s);
      _col.setHex(0xa9794a).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      trunks.setColorAt(i, _col);

      // crown position = bent tip, rotated by yaw
      const lx = 1.25 * p.s, ly = 5.4 * p.s, lz = 0.22 * p.s;
      const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
      const cxw = p.x + lx * cy + lz * sy;
      const czw = p.z - lx * sy + lz * cy;
      const cyw = p.y + ly;

      for (let f = 0; f < 7; f++) {
        const yaw = p.yaw + (f / 7) * TAU + Math.random() * 0.24;
        const pitch = -0.62 + (f % 2) * 0.22 + Math.random() * 0.12;
        const sc = p.s * (0.9 + Math.random() * 0.25);
        this.anim.fronds.push({ i: fi, x: cxw, y: cyw, z: czw, yaw, pitch, sc, ph: Math.random() * TAU });
        instAt(fronds, fi, cxw, cyw, czw, yaw, pitch, 0, sc);
        _col.setHex(f % 2 ? 0x7ac74f : 0x63ad3c).offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);
        fronds.setColorAt(fi, _col);
        fi++;
      }
      if (i % 3 !== 2) {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + i;
          instAt(nuts, ni++, cxw + Math.cos(a) * 0.3, cyw - 0.28, czw + Math.sin(a) * 0.3, 0, 0, 0, p.s);
        }
      }
      this.obstacles.push({ x: p.x, z: p.z, r: 0.62 });
    }
    nuts.count = ni;
    trunks.instanceColor.needsUpdate = true;
    fronds.instanceColor.needsUpdate = true;
    scene.add(trunks, fronds, nuts);
    this.anim.frondMesh = fronds;

    // beach grass on the back dunes
    const blade = [];
    for (let i = 0; i < 5; i++) {
      blade.push({ g: xf(new THREE.ConeGeometry(0.05, 0.75, 3), (i - 2) * 0.09, 0.36, Math.sin(i * 2) * 0.08, (Math.random() - 0.5) * 0.5, 0, (i - 2) * 0.2) });
    }
    const grassG = merge(blade);
    const grass = new THREE.InstancedMesh(grassG, makeToon(0x9dc46a, { unique: true, vertexColors: true }), 70);
    let gi = 0;
    for (let i = 0; i < 70; i++) {
      const th = Math.random() * TAU;
      const r = 9.6 + Math.random() * 2.6;
      const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
      if (r > shoreR(th) - 2.0) continue;
      instAt(grass, gi, x, sandY(x, z), z, Math.random() * TAU, 0, 0, 0.7 + Math.random() * 0.7);
      _col.setHex(Math.random() < 0.5 ? 0xa8cc74 : 0xc8c47a);
      grass.setColorAt(gi, _col);
      gi++;
    }
    grass.count = gi;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    scene.add(grass);
  }

  // ---- umbrellas, towels, sandcastle, driftwood ---------------------------
  _buildBeachStuff(scene) {
    const clutter = [];
    const C = (g, c) => clutter.push({ g, c });

    // ---------- umbrellas
    const stripeMat = toonTex(0xffffff, texStripes('#e8657a', '#fff1d6', 10), { side: THREE.DoubleSide });
    for (const [ux, uz, tilt] of [[5.8, 6.6, 0.14], [9.6, 6.9, -0.1]]) {
      const p = spot(ux, uz, 1.1, 2.4);
      const g = new THREE.Group();
      g.position.set(p.x, sandY(p.x, p.z), p.z);
      g.rotation.z = tilt;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.9, 6), makeToon(0xd6a86a));
      pole.position.y = 1.45;
      pole.castShadow = true;
      g.add(pole);
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.05, 0.95, 12, 1, true), stripeMat);
      canopy.position.y = 2.72;
      canopy.castShadow = true;
      g.add(canopy);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(2.02, 0.05, 4, 16), makeToon(0xe8657a));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 2.26;
      g.add(rim);
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), makeToon(0xf2b64a));
      finial.position.y = 3.28;
      g.add(finial);
      scene.add(g);
      this.anim.umbrellas.push({ obj: g, base: tilt, ph: Math.random() * TAU });
      this.obstacles.push({ x: p.x, z: p.z, r: 0.75 });
    }

    // ---------- towels
    const towels = [[7.1, 7.7, 0.5, '#4fb3e8', '#fff1d6'], [4.9, 5.5, -0.9, '#e8657a', '#ffe3b0'], [10.7, 5.5, 1.9, '#7ac74f', '#fff1d6']];
    for (const [tx, tz, rot, a, b] of towels) {
      const p = spot(tx, tz, 0.9, 2.2);
      const tg = new THREE.PlaneGeometry(1.5, 2.4, 3, 5);
      const tp = tg.attributes.position;
      for (let i = 0; i < tp.count; i++) {
        tp.setZ(i, Math.sin(tp.getX(i) * 3 + tp.getY(i) * 2) * 0.035);
      }
      tg.computeVertexNormals();
      const towel = new THREE.Mesh(tg, toonTex(0xffffff, texTowel(a, b), { side: THREE.DoubleSide }));
      towel.rotation.set(-Math.PI / 2, 0, rot);
      towel.position.set(p.x, sandY(p.x, p.z) + 0.04, p.z);
      towel.receiveShadow = true;
      scene.add(towel);
    }

    // beach bag, cooler, sunglasses, lifebuoy near the towels
    const bag = spot(6.4, 8.6, 0.9, 2.2);
    C(xf(new THREE.CylinderGeometry(0.34, 0.28, 0.55, 8), bag.x, sandY(bag.x, bag.z) + 0.27, bag.z), 0xf2b64a);
    C(xf(new THREE.TorusGeometry(0.26, 0.035, 4, 10), bag.x, sandY(bag.x, bag.z) + 0.62, bag.z, 0, 0, 0), 0xd9944a);
    const cool = spot(4.2, 6.6, 0.9, 2.2);
    C(xf(new THREE.BoxGeometry(0.85, 0.5, 0.6), cool.x, sandY(cool.x, cool.z) + 0.25, cool.z, 0, 0.4, 0), 0xdff0f6);
    C(xf(new THREE.BoxGeometry(0.9, 0.12, 0.65), cool.x, sandY(cool.x, cool.z) + 0.55, cool.z, 0, 0.4, 0), 0x4fb3e8);
    const buoy = spot(11.6, 3.0, 0.9, 2.4);
    C(xf(new THREE.CylinderGeometry(0.09, 0.11, 2.2, 6), buoy.x, sandY(buoy.x, buoy.z) + 1.1, buoy.z), 0xb98a52);
    C(xf(new THREE.TorusGeometry(0.45, 0.14, 6, 16), buoy.x, sandY(buoy.x, buoy.z) + 1.9, buoy.z + 0.14, 0.15, 0, 0), 0xe8657a);
    C(xf(new THREE.TorusGeometry(0.455, 0.145, 6, 4), buoy.x, sandY(buoy.x, buoy.z) + 1.9, buoy.z + 0.14, 0.15, 0, 0.78), 0xfff1d6);

    // ---------- sandcastle
    const cp = spot(3.6, 8.4, 2.2, 2.8);
    const cy0 = sandY(cp.x, cp.z);
    C(xf(new THREE.CylinderGeometry(1.75, 2.0, 0.3, 14), cp.x, cy0 + 0.15, cp.z), 0xe7cd94);
    C(xf(new THREE.TorusGeometry(2.25, 0.22, 5, 18), cp.x, cy0 + 0.02, cp.z, Math.PI / 2, 0, 0), 0xcaa871);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const tx = cp.x + Math.cos(a) * 1.25, tz = cp.z + Math.sin(a) * 1.25;
      C(xf(new THREE.CylinderGeometry(0.3, 0.36, 1.05, 9), tx, cy0 + 0.82, tz), 0xf0dba6);
      C(xf(new THREE.ConeGeometry(0.42, 0.55, 9), tx, cy0 + 1.62, tz), 0xe2c68d);

      // curtain wall between this tower and the next, with battlements on top
      const a2 = a + TAU / 8;
      const wx = cp.x + Math.cos(a2) * 1.16, wz = cp.z + Math.sin(a2) * 1.16;
      const yaw = -a2;                       // wall runs tangent to the ring
      const tanX = -Math.sin(a2), tanZ = Math.cos(a2);
      C(xf(new THREE.BoxGeometry(1.35, 0.62, 0.34), wx, cy0 + 0.61, wz, 0, yaw, 0), 0xecd69f);
      for (let k = -1; k <= 1; k++) {
        C(xf(new THREE.BoxGeometry(0.26, 0.22, 0.34),
          wx + tanX * k * 0.42, cy0 + 1.03, wz + tanZ * k * 0.42, 0, yaw, 0), 0xf0dba6);
      }
    }
    C(xf(new THREE.CylinderGeometry(0.5, 0.58, 1.65, 10), cp.x, cy0 + 1.12, cp.z), 0xf3dfad);
    C(xf(new THREE.ConeGeometry(0.68, 0.8, 10), cp.x, cy0 + 2.32, cp.z), 0xe2c68d);
    C(xf(new THREE.BoxGeometry(0.3, 0.45, 0.16), cp.x, cy0 + 0.52, cp.z + 0.56), 0x8a6a3e);
    C(xf(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 4), cp.x, cy0 + 3.06, cp.z), 0x8a6a3e);
    // bucket + spade
    C(xf(new THREE.CylinderGeometry(0.24, 0.19, 0.36, 9), cp.x + 2.0, cy0 + 0.18, cp.z + 1.5, 0, 0, 0.4), 0x4fb3e8);
    C(xf(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 4), cp.x - 1.9, cy0 + 0.4, cp.z + 1.4, 0, 0, 0.45), 0xf2b64a);
    C(xf(new THREE.BoxGeometry(0.24, 0.05, 0.3), cp.x - 2.08, cy0 + 0.05, cp.z + 1.4, 0, 0.3, 0.1), 0xe8657a);
    this.obstacles.push({ x: cp.x, z: cp.z, r: 1.7 });

    const castleFlag = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.26, 4, 2), makeToon(0xe8657a, { unique: true, side: THREE.DoubleSide }));
    castleFlag.position.set(cp.x + 0.22, cy0 + 3.38, cp.z);
    scene.add(castleFlag);
    this.anim.flag = castleFlag;

    // NB: the beach ball used to be a static prop here. It is now the shared,
    // server-owned toy built in _buildBall().

    scene.add(Object.assign(
      new THREE.Mesh(merge(clutter), makeToon(0xffffff, { unique: true, vertexColors: true })),
      { castShadow: true, receiveShadow: true },
    ));

    // ---------- driftwood, rocks, shells, seaweed
    const logG = (() => {
      const g = new THREE.CylinderGeometry(0.24, 0.3, 2.6, 7, 4);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = (p.getY(i) + 1.3) / 2.6;
        p.setX(i, p.getX(i) + Math.sin(u * 2.4) * 0.22);
        p.setZ(i, p.getZ(i) * (0.8 + Math.sin(u * 5) * 0.15));
      }
      g.rotateZ(Math.PI / 2);
      g.computeVertexNormals();
      return g;
    })();
    const logs = new THREE.InstancedMesh(logG, makeToon(0xffffff, { unique: true }), 9);
    const logSpots = [[-2.5, 8.6], [-6.0, 3.6], [8.0, 9.2], [11.5, -3.5], [0.5, -8.5], [-3.0, -6.0], [6.2, -2.6], [-5.6, 0.2], [13.0, 5.0]];
    let li = 0;
    for (const [x, z] of logSpots) {
      const p = spot(x, z, 1.0, 1.1);
      instAt(logs, li, p.x, sandY(p.x, p.z) + 0.2, p.z, Math.random() * TAU, 0, (Math.random() - 0.5) * 0.2, 0.75 + Math.random() * 0.6);
      _col.setHex(Math.random() < 0.5 ? 0xd8c6a8 : 0xc2ab8b);
      logs.setColorAt(li, _col);
      this.obstacles.push({ x: p.x, z: p.z, r: 0.75 });
      li++;
    }
    logs.count = li;
    logs.instanceColor.needsUpdate = true;
    logs.castShadow = true;
    scene.add(logs);

    // icosahedron ships non-indexed with spherical normals; recomputing them
    // gives per-face normals, i.e. proper chunky faceted rocks
    const rockG = new THREE.IcosahedronGeometry(0.42, 0);
    rockG.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(rockG, makeToon(0xffffff, { unique: true }), 34);
    let ri = 0;
    for (let i = 0; i < 34; i++) {
      const th = Math.random() * TAU;
      const r = 5.5 + Math.random() * 6.5;
      const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
      if (Math.hypot(x - ZONE.x, z - ZONE.z) < ZONE.r + 0.8) continue;
      if (r > shoreR(th) + 0.2) continue;
      instAt(rocks, ri, x, sandY(x, z) + 0.05, z, Math.random() * TAU, Math.random(), Math.random(), 0.35 + Math.random() * 0.8);
      _col.setHex(Math.random() < 0.5 ? 0xb0a394 : 0x8f8578);
      rocks.setColorAt(ri, _col);
      ri++;
    }
    rocks.count = ri;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    scene.add(rocks);

    const shellG = merge([
      { g: xf(new THREE.ConeGeometry(0.16, 0.3, 7), 0, 0.06, 0, Math.PI / 2.2, 0, 0) },
      { g: xf(new THREE.SphereGeometry(0.1, 6, 4), 0.1, 0.05, 0) },
    ]);
    const shells = new THREE.InstancedMesh(shellG, makeToon(0xffffff, { unique: true, vertexColors: true }), 40);
    let si = 0;
    for (let i = 0; i < 40; i++) {
      const th = Math.random() * TAU;
      const r = shoreR(th) - 1.4 - Math.random() * 3.4;
      const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
      if (Math.hypot(x - ZONE.x, z - ZONE.z) < ZONE.r + 0.4) continue;
      instAt(shells, si, x, sandY(x, z) + 0.02, z, Math.random() * TAU, 0, 0, 0.6 + Math.random() * 0.7);
      _col.setHex([0xfff1d6, 0xf7d6b8, 0xe8b4c0, 0xf2b64a][i % 4]);
      shells.setColorAt(si, _col);
      si++;
    }
    shells.count = si;
    shells.instanceColor.needsUpdate = true;
    scene.add(shells);
  }

  // ---- the bonfire ---------------------------------------------------------
  /**
   * A ring of beach stones around a criss-crossed pile of driftwood, cold and
   * grey by day. At dusk it catches: flames, embers, a warm point light and a
   * glow pooled on the sand. Idling inside COZY_R earns the server-paid trickle
   * (see _onCoins) and wears an ember halo (see _updateCozy).
   *
   * Placement: see FIRE. Nothing routes through it, and the stone ring's
   * collider (r 1.3) sits 3.7 clear of the bot circle.
   */
  _buildBonfire(scene) {
    const gy = sandY(FIRE.x, FIRE.z);
    const solid = [];
    const S = (g, c) => solid.push({ g, c });

    // scooped-out pit + a low sand berm the stones sit in
    S(xf(new THREE.CylinderGeometry(1.02, 0.86, 0.18, 16), FIRE.x, gy + 0.02, FIRE.z), 0x8c6b3f);
    S(xf(new THREE.TorusGeometry(1.16, 0.2, 5, 20), FIRE.x, gy + 0.04, FIRE.z, Math.PI / 2, 0, 0), 0xdfc38c);

    // hearth stones: chunky, all slightly different, none of them upright
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * TAU + 0.2;
      const r = 1.12 + (i % 3) * 0.04;
      S(xf(new THREE.IcosahedronGeometry(0.3, 0), FIRE.x + Math.cos(a) * r, gy + 0.14, FIRE.z + Math.sin(a) * r,
        a * 1.7, i * 0.9, 0.2 + (i % 2) * 0.3, 1.05 + (i % 4) * 0.16, 0.78, 0.95), i % 2 ? 0xb0a394 : 0x93887a);
    }

    // ash bed and charred stubs under the pile
    S(xf(new THREE.CylinderGeometry(0.72, 0.8, 0.1, 14), FIRE.x, gy + 0.1, FIRE.z), 0x4a423b);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.7;
      S(xf(new THREE.CylinderGeometry(0.06, 0.08, 0.44, 5), FIRE.x + Math.cos(a) * 0.3, gy + 0.28, FIRE.z + Math.sin(a) * 0.3,
        0, a, 0.35), 0x35302b);
    }

    // the pile itself: a teepee of driftwood over two crossed base logs
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.35;
      S(xf(new THREE.CylinderGeometry(0.085, 0.115, 1.55, 6),
        FIRE.x + Math.cos(a) * 0.34, gy + 0.72, FIRE.z + Math.sin(a) * 0.34,
        0, -a + Math.PI / 2, 0.42 + (i % 2) * 0.05), i % 2 ? 0xcbb794 : 0xb59a76);
    }
    for (const [dx, dz, ry] of [[0, 0, 0.4], [0, 0, 1.9]]) {
      S(xf(new THREE.CylinderGeometry(0.13, 0.15, 1.9, 7), FIRE.x + dx, gy + 0.2, FIRE.z + dz, 0, ry, Math.PI / 2), 0xc2ab8b);
    }

    // two driftwood benches: the reason a circle forms here at all
    for (const [bx, bz, byaw] of [[FIRE.x + 0.35, FIRE.z + 2.15, 0.12], [FIRE.x - 1.9, FIRE.z - 1.1, -1.15]]) {
      const by = sandY(bx, bz);
      S(xf(new THREE.CylinderGeometry(0.26, 0.29, 2.3, 8), bx, by + 0.3, bz, 0, byaw, Math.PI / 2), 0xd8c6a8);
      for (const s of [-0.72, 0.72]) {
        S(xf(new THREE.BoxGeometry(0.3, 0.3, 0.34), bx + Math.cos(byaw) * s, by + 0.1, bz - Math.sin(byaw) * s, 0, byaw, 0), 0xb59a76);
      }
      this.obstacles.push({ x: bx, z: bz, r: 0.85 });
    }
    scene.add(Object.assign(new THREE.Mesh(merge(solid), makeToon(0xffffff, {
      unique: true, vertexColors: true,
    })), { castShadow: true, receiveShadow: true }));

    // ---- fire: flames, embers, light, the pool of glow on the sand ---------
    const flameG = new THREE.ConeGeometry(0.44, 1.15, 7, 1, true);
    const flameMat = makeGlow(0xffffff, { unique: true });
    flameMat.transparent = true;
    flameMat.depthWrite = false;
    flameMat.opacity = 0;
    flameMat.side = THREE.DoubleSide;
    flameMat.blending = THREE.AdditiveBlending;
    const flames = new THREE.InstancedMesh(flameG, flameMat, 5);
    flames.frustumCulled = false;
    flames.visible = false;
    scene.add(flames);
    const tongues = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      tongues.push({
        x: FIRE.x + Math.cos(a) * (i ? 0.3 : 0), z: FIRE.z + Math.sin(a) * (i ? 0.3 : 0),
        h: i ? 0.78 + Math.random() * 0.34 : 1.5, ph: Math.random() * TAU, sp: 5 + Math.random() * 4,
      });
      // deep orange outside, one hot core: additive blending stacks these into
      // a warm blaze rather than a pale spike
      _col.setHex(i ? [0xff6a1c, 0xffa32c, 0xff5714, 0xff8f24][i - 1] : 0xffb43e);
      flames.setColorAt(i, _col);
    }
    if (flames.instanceColor) flames.instanceColor.needsUpdate = true;

    const emberG = new THREE.SphereGeometry(0.045, 5, 4);
    const emberMat = makeGlow(0xffb15a, { unique: true });
    emberMat.transparent = true;
    emberMat.depthWrite = false;
    emberMat.blending = THREE.AdditiveBlending;
    const embers = new THREE.InstancedMesh(emberG, emberMat, 26);
    embers.frustumCulled = false;
    embers.visible = false;
    scene.add(embers);
    const emberData = [];
    for (let i = 0; i < 26; i++) emberData.push({ life: Math.random() * -2, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, sc: 1 });

    const light = new THREE.PointLight(0xff9838, 0, 13, 2);
    light.position.set(FIRE.x, gy + 1.1, FIRE.z);
    scene.add(light);

    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(3.1, 24),
      (() => {
        const m = makeGlow(0xff9a44, { unique: true });
        m.transparent = true; m.opacity = 0; m.depthWrite = false;
        m.blending = THREE.AdditiveBlending;
        return m;
      })(),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(FIRE.x, gy + 0.03, FIRE.z);
    pool.renderOrder = 2;
    pool.visible = false;
    scene.add(pool);

    // ember halo worn by everyone idling in the glow (one mesh for all of them)
    const haloMat = makeGlow(0xffc978, { unique: true });
    haloMat.transparent = true;
    haloMat.depthWrite = false;
    haloMat.blending = THREE.AdditiveBlending;
    const halo = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 5, 4), haloMat, HALO_SLOTS * HALO_PER);
    halo.frustumCulled = false;
    halo.visible = false;
    scene.add(halo);

    // the toast-free "+1" that floats off a capy the fire has just paid
    const moteTex = canvasTexture(128, 64, (c, w, h) => drawMote(c, w, h, '+1'));
    const mote = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.68), glowTex(0xffffff, moteTex, {
      transparent: true, depthWrite: false, opacity: 0,
    }));
    mote.renderOrder = 6;
    mote.visible = false;
    scene.add(mote);
    this._mote = { mesh: mote, tex: moteTex, t: 99, x: 0, y: 0, z: 0 };

    this._fire = { y: gy, flames, tongues, embers, emberData, light, pool, halo, spawn: 0 };
    this._fireLamp = this._addLamp(1.1);

    this.obstacles.push({ x: FIRE.x, z: FIRE.z, r: FIRE.r });
    this.hotspots.push({
      id: 'bonfire',
      position: new THREE.Vector3(FIRE.x, gy + 0.6, FIRE.z + 1.05),
      radius: 2.6,
      label: 'Settle in by the fire',
      action: (g) => {
        const av = g.engine?.playerAvatar;
        if (!av) return;
        g.engine.controller?.stop?.();
        av.setAnim(av.state.anim === 'sit' ? 'idle' : 'sit');
        g.audio?.play?.(av.state.anim === 'sit' ? 'ding' : 'click');
      },
    });
  }

  // ---- the beach ball ------------------------------------------------------
  /**
   * ONE ball, shared by the room. The server owns it and integrates at 10Hz;
   * this predicts locally with the same constants and eases onto every
   * authoritative frame, so it never stutters and never disagrees for long.
   * Bop it by clicking it (_pointerDown) or walking into it (_updateBall).
   *
   * Frames are read tolerantly: {x,y,z}/{p:[x,y,z]} for position and
   * {vx,vy,vz}/{v:[..]} for velocity, velocity derived from consecutive frames
   * when the server sends position only.
   *
   * Known gap (server-side, not fixable from here): the server's join-time
   * ball frame is sent the moment 'join' lands, which is ~220ms before this
   * room finishes building and subscribes. A ball asleep away from home
   * therefore renders at home until the next bop, which broadcasts instantly
   * and re-syncs everyone. Fixing it properly means caching the last frame in
   * src/net/client.js the way it already caches 'table'.
   */
  _buildBall(scene) {
    // pivot carries position + the world-aligned squash; the mesh inside it
    // carries the roll, so a bounce never squashes along a tumbling axis
    const pivot = new THREE.Group();
    pivot.position.set(BALL_HOME.x, sandY(BALL_HOME.x, BALL_HOME.z) + BALL_R, BALL_HOME.z);
    scene.add(pivot);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 16, 12), toonTex(0xffffff, texBall()));
    ball.castShadow = true;
    pivot.add(ball);

    // contact shadow: keeps the ball glued to the sand mid-arc
    const blob = new THREE.Mesh(new THREE.CircleGeometry(BALL_R, 14), (() => {
      const m = makeGlow(0x6b5636, { unique: true });
      m.transparent = true; m.opacity = 0.24; m.depthWrite = false;
      return m;
    })());
    blob.rotation.x = -Math.PI / 2;
    blob.renderOrder = 2;
    scene.add(blob);

    // splash droplets, recycled: the ball spends a lot of its life in the surf
    const dropMat = makeGlow(0xdff2ff, { unique: true });
    dropMat.transparent = true;
    dropMat.depthWrite = false;
    const drops = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 5, 4), dropMat, 22);
    drops.frustumCulled = false;
    drops.visible = false;
    scene.add(drops);
    const dropData = [];
    for (let i = 0; i < 22; i++) dropData.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });

    this._ball = {
      obj: ball, pivot, blob, drops, dropData,
      x: BALL_HOME.x, y: sandY(BALL_HOME.x, BALL_HOME.z) + BALL_R, z: BALL_HOME.z,
      vx: 0, vy: 0, vz: 0,
      spinX: 0, spinZ: 0, squash: 0, wet: false, cool: 0,
      // server correction: where the last frame says it is, and how much of
      // that error we have left to bleed off
      ex: 0, ey: 0, ez: 0, authAt: -99, lastNet: null,
    };
    this._ballRay = new THREE.Raycaster();
  }

  // ---- dive bell (the way down to The Drift) -------------------------------
  /**
   * A brass bell on a davit at the north edge of the fishing platform, swung
   * out over the open water. The prompt rides high above the deck so it never
   * lands on top of the Reel Rush prompt a couple of paces away.
   */
  _buildDiveBell(scene) {
    const solid = [];
    const S = (g, c) => solid.push({ g, c });
    const baseY = DECK_Y;

    // mast + angled arm out over the water, with a stay back to the deck
    S(xf(new THREE.CylinderGeometry(0.16, 0.2, 3.3, 8), BELL.x, baseY + 1.65, BELL.z), 0x8b6039);
    S(xf(new THREE.BoxGeometry(0.44, 0.2, 0.44), BELL.x, baseY + 0.08, BELL.z), 0x6d4a2b);
    const arm = BELL.out - BELL.z;                 // reach out over the sea (-z)
    S(xf(new THREE.CylinderGeometry(0.11, 0.13, Math.abs(arm) + 0.5, 7),
      BELL.x, baseY + 3.16, BELL.z + arm / 2 - 0.1, Math.PI / 2, 0, 0), 0xa87844);
    S(xf(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 5),
      BELL.x, baseY + 2.62, BELL.z + arm * 0.28, Math.sign(arm) * -0.72, 0, 0), 0x8b6039);
    // winch drum + rope coil at the mast foot
    S(xf(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 9), BELL.x + 0.3, baseY + 0.4, BELL.z - 0.12, 0, 0, Math.PI / 2), 0x6d4a2b);
    S(xf(new THREE.CylinderGeometry(0.055, 0.055, 0.62, 5), BELL.x + 0.62, baseY + 0.4, BELL.z - 0.12, 0, 0, Math.PI / 2), 0xc98f52);
    for (let i = 0; i < 3; i++) {
      S(xf(new THREE.TorusGeometry(0.3 - i * 0.05, 0.05, 4, 12), BELL.x - 0.5, baseY + 0.06 + i * 0.09, BELL.z - 0.7, Math.PI / 2, 0, 0), 0xe4cd99);
    }
    scene.add(Object.assign(new THREE.Mesh(merge(solid), makeToon(0xffffff, {
      unique: true, vertexColors: true,
    })), { castShadow: true, receiveShadow: true }));

    // the bell: a brass lathe with a porthole, hanging on a short chain
    // Hung low on purpose: from the play camera (36 degrees down) a bell up at
    // the arm reads as a golden hoop. Down here its whole silhouette sits
    // against the dark water where it reads as a bell.
    const group = new THREE.Group();
    group.position.set(BELL.x, baseY + 2.25, BELL.out);
    scene.add(group);

    const chain = [];
    for (let i = 0; i < 7; i++) {
      chain.push({ g: xf(new THREE.TorusGeometry(0.08, 0.025, 4, 8), 0, 0.9 - i * 0.14, 0, 0, (i % 2) * 1.57, Math.PI / 2), c: 0xbfae86 });
    }
    // guide chain running on down into the water: this thing GOES somewhere
    chain.push({ g: xf(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 5), 0.52, -2.7, 0), c: 0xa79572 });
    group.add(new THREE.Mesh(merge(chain), makeToon(0xffffff, { unique: true, vertexColors: true })));

    const prof = [
      [0.0, 0.0], [0.1, 0.02], [0.12, 0.16], [0.2, 0.4], [0.34, 0.72], [0.5, 1.0],
      [0.62, 1.24], [0.66, 1.34], [0.6, 1.35], [0.56, 1.25], [0.44, 1.0], [0.3, 0.68],
      [0.16, 0.36], [0.06, 0.14], [0.0, 0.1],
    ].map(([x, y]) => new THREE.Vector2(x * 1.6, -y * 1.6 + 0.02));
    const brass = makeToon(0xc9922f, { unique: true });
    const bell = new THREE.Mesh(new THREE.LatheGeometry(prof, 16), brass);
    brass.side = THREE.DoubleSide; // the lathe's return path faces inward
    bell.castShadow = true;
    group.add(bell);

    const bands = [];
    for (const [ry, rr] of [[-0.62, 0.66], [-1.02, 0.55]]) {
      bands.push({ g: xf(new THREE.TorusGeometry(rr * 1.6, 0.07, 5, 18), 0, ry * 1.6, 0, Math.PI / 2, 0, 0), c: 0xf0c463 });
    }
    group.add(new THREE.Mesh(merge(bands), makeToon(0xffffff, { unique: true, vertexColors: true })));

    // porthole facing the camera side, so you can see there is room inside
    const port = new THREE.Mesh(new THREE.CircleGeometry(0.36, 14), makeGlow(0x9fd8ec, { unique: true }));
    port.position.set(0, -1.0, 0.93);
    group.add(port);
    const portRim = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.055, 5, 14), makeToon(0xf0c463));
    portRim.position.copy(port.position);
    group.add(portRim);

    // the porthole lamp comes on with everything else at dusk
    this._bell = { group, ph: Math.random() * TAU, port: port.material, lamp: this._addLamp(0.9) };
    this.obstacles.push({ x: BELL.x, z: BELL.z, r: 0.55 });

    this.hotspots.push({
      // deliberately NOT an 'exit-' id: the dock end is where people fish, and
      // walking past a hotspot must never drop them in the sea
      id: 'dive-bell',
      // the prompt rides high so it never lands on top of the Reel Rush one
      position: new THREE.Vector3(BELL.x, DECK_Y + 2.1, BELL.z - 0.35),
      // wide enough that stepping off the bell (spawn from_drift) already shows
      // the way back down
      radius: 2.9,
      label: 'Take the dive bell down',
      action: (g) => g.goToRoom('drift', 'beach'),
    });
  }

  // ---- rain ----------------------------------------------------------------
  /**
   * Weather 'rain': instanced streaks falling in a column that follows the
   * player, plus gloss decals that darken the sand. Everything is dormant
   * (visible = false, zero cost) whenever _rainAmt is 0.
   */
  _buildRain(scene) {
    const streak = new THREE.PlaneGeometry(0.05, 0.9);
    const mat = this._followSky(glowTex(0xbcd8ea, texStreak(), {
      transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide, fog: false,
    }), 0xbcd8ea);
    const rain = new THREE.InstancedMesh(streak, mat, RAIN_N);
    rain.frustumCulled = false;
    rain.visible = false;
    scene.add(rain);
    const drops = new Float32Array(RAIN_N * 4); // x, y, z, speed
    for (let i = 0; i < RAIN_N; i++) {
      drops[i * 4] = (Math.random() - 0.5) * 22;
      drops[i * 4 + 1] = Math.random() * 13;
      drops[i * 4 + 2] = (Math.random() - 0.5) * 22;
      drops[i * 4 + 3] = 15 + Math.random() * 9;
    }
    this._rain = { mesh: rain, drops, cx: 0, cz: 0 };

    // puddles: flat decals, no colliders, so they can lie anywhere walkable
    const pud = [];
    const puddleTex = texPuddle();
    for (const [px, pz, s] of [
      [2.6, 3.9, 1.5], [-2.2, 4.6, 1.1], [5.4, 1.2, 1.3], [0.4, 0.2, 0.9],
      [7.4, 3.2, 1.2], [-1.4, -3.4, 1.0], [4.6, -3.2, 1.1], [9.2, 5.6, 0.9],
    ]) {
      const g = new THREE.CircleGeometry(0.9 * s, 14);
      g.rotateX(-Math.PI / 2);
      pud.push({ g: xf(g, px, sandY(px, pz) + 0.03, pz), c: 0xffffff });
    }
    const pm = this._followSky(glowTex(0xffffff, puddleTex, {
      transparent: true, depthWrite: false, opacity: 0, vertexColors: true,
    }), 0xffffff);
    const puddles = new THREE.Mesh(merge(pud), pm);
    puddles.renderOrder = 3;
    puddles.visible = false;
    scene.add(puddles);
    this._puddles = puddles;
  }

  // ---- crabs + gulls -------------------------------------------------------
  _buildCritters(scene) {
    const shellMat = makeToon(0xe8657a);
    const darkMat = makeToon(0x3a2a1c);
    const clawMat = makeToon(0xf2836f);

    const bodyG = merge([
      { g: xf(new THREE.SphereGeometry(0.26, 10, 8), 0, 0, 0, 0, 0, 0, 1.25, 0.72, 1) },
      { g: xf(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 5), -0.12, 0.2, 0.06) },
      { g: xf(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 5), 0.12, 0.2, 0.06) },
    ]);
    const eyeG = merge([
      { g: xf(new THREE.SphereGeometry(0.06, 7, 5), -0.12, 0.31, 0.06) },
      { g: xf(new THREE.SphereGeometry(0.06, 7, 5), 0.12, 0.31, 0.06) },
    ]);
    const legRowG = merge([0, 1, 2].map((i) => ({
      g: xf(new THREE.BoxGeometry(0.05, 0.05, 0.3), 0.24, -0.02, (i - 1) * 0.16, 0, 0.5 - i * 0.5, -0.5),
    })));
    const clawG = merge([
      { g: xf(new THREE.SphereGeometry(0.12, 8, 6), 0.34, 0.02, 0.2, 0, 0.5, 0, 1.3, 0.8, 0.9) },
      { g: xf(new THREE.BoxGeometry(0.16, 0.05, 0.08), 0.5, 0.06, 0.3, 0, 0.5, 0) },
      { g: xf(new THREE.SphereGeometry(0.12, 8, 6), -0.34, 0.02, 0.2, 0, -0.5, 0, 1.3, 0.8, 0.9) },
      { g: xf(new THREE.BoxGeometry(0.16, 0.05, 0.08), -0.5, 0.06, 0.3, 0, -0.5, 0) },
    ]);

    for (const [cx, cz, rr] of [[-3.4, 8.4, 1.6], [5.6, 9.2, 1.9], [9.9, 4.6, 1.4]]) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyG.clone(), shellMat);
      body.castShadow = true;
      const eyes = new THREE.Mesh(eyeG.clone(), darkMat);
      const legL = new THREE.Mesh(legRowG.clone(), clawMat);
      const legR = new THREE.Mesh(legRowG.clone(), clawMat);
      legR.scale.x = -1;
      const claws = new THREE.Mesh(clawG.clone(), clawMat);
      g.add(body, eyes, legL, legR, claws);
      scene.add(g);
      this.anim.crabs.push({
        obj: g, legL, legR, claws, body,
        cx, cz, rx: rr, rz: rr * 0.7,
        a: Math.random() * TAU, sp: 0.42 + Math.random() * 0.3, ph: Math.random() * TAU,
      });
    }
    bodyG.dispose(); eyeG.dispose(); legRowG.dispose(); clawG.dispose();

    // gulls
    const gullBody = merge([
      { g: xf(new THREE.SphereGeometry(0.22, 8, 6), 0, 0, 0, 0, 0, 0, 0.8, 0.8, 1.7), c: 0xfffaf0 },
      { g: xf(new THREE.SphereGeometry(0.13, 8, 6), 0, 0.05, 0.3), c: 0xfffaf0 },
      { g: xf(new THREE.ConeGeometry(0.05, 0.22, 5), 0, 0.03, 0.46, Math.PI / 2, 0, 0), c: 0xf2b64a },
      { g: xf(new THREE.ConeGeometry(0.14, 0.42, 4), 0, 0.04, -0.42, -Math.PI / 2, 0, 0), c: 0xdfe6ea },
    ]);
    const wingG = merge([
      { g: xf(new THREE.BoxGeometry(1.05, 0.045, 0.34), 0.55, 0, 0, 0, 0.12, 0), c: 0xfffaf0 },
      { g: xf(new THREE.BoxGeometry(0.5, 0.045, 0.22), 1.28, 0, -0.06, 0, 0.3, 0), c: 0x6f7c86 },
    ]);
    const gullMat = makeToon(0xffffff, { unique: true, vertexColors: true, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(gullBody.clone(), gullMat));
      const wl = new THREE.Mesh(wingG.clone(), gullMat);
      const wr = new THREE.Mesh(wingG.clone(), gullMat);
      wr.scale.x = -1;
      g.add(wl, wr);
      g.scale.setScalar(0.9 + i * 0.14);
      scene.add(g);
      this.anim.gulls.push({
        obj: g, wl, wr,
        r: 9.5 + i * 3.2, y: 8.2 + i * 1.3, a: (i / 3) * TAU,
        sp: 0.34 - i * 0.06, ph: Math.random() * TAU,
        cx: -1 - i, cz: 0.5 + i,
      });
    }
    gullBody.dispose(); wingG.dispose();
  }

  // ---- exit to the plaza ---------------------------------------------------
  _buildExit(scene) {
    const parts = [];
    const P = (g, c) => parts.push({ g, c });

    // Everything here is snapped inland: the shoreline curls back east of x~14.
    const sign = spot(12.0, 4.5, 1.4, 2.4);
    const ey = sandY(sign.x, sign.z);
    const archA = spot(11.0, 0.7, 1.4, 2.4);
    const archB = spot(11.0, 4.6, 1.4, 2.4);
    const torchPos = [spot(9.4, 0.5, 1.4, 2.4), spot(9.4, 5.0, 1.4, 2.4)];

    // signpost
    P(xf(new THREE.CylinderGeometry(0.14, 0.17, 3.1, 7), sign.x, ey + 1.55, sign.z), 0x9a6c3e);
    P(xf(new THREE.SphereGeometry(0.2, 8, 6), sign.x, ey + 3.15, sign.z), 0xc98f52);
    P(xf(new THREE.BoxGeometry(0.5, 0.14, 0.5), sign.x, ey + 0.07, sign.z), 0xd6a86a);

    // driftwood arch over the sandy path
    const ay1 = sandY(archA.x, archA.z), ay2 = sandY(archB.x, archB.z);
    P(xf(new THREE.CylinderGeometry(0.16, 0.2, 3.4, 6), archA.x, ay1 + 1.7, archA.z, 0, 0, -0.05), 0xcfbb9a);
    P(xf(new THREE.CylinderGeometry(0.16, 0.2, 3.4, 6), archB.x, ay2 + 1.7, archB.z, 0, 0, 0.05), 0xcfbb9a);
    P(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(archA.x, ay1 + 3.3, archA.z),
      new THREE.Vector3((archA.x + archB.x) / 2 + 0.15, (ay1 + ay2) / 2 + 4.0, (archA.z + archB.z) / 2),
      new THREE.Vector3(archB.x, ay2 + 3.3, archB.z),
    ]), 16, 0.16, 6, false), 0xcfbb9a);
    // hanging shells on the arch
    for (let i = 0; i < 5; i++) {
      const u = 0.2 + i * 0.15;
      const x = archA.x + (archB.x - archA.x) * u + 0.12;
      const z = archA.z + (archB.z - archA.z) * u;
      const y = ay1 + 3.55 + Math.sin(u * Math.PI) * 0.55;
      P(xf(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 3), x, y - 0.21, z), 0xe4cd99);
      P(xf(new THREE.ConeGeometry(0.11, 0.2, 7), x, y - 0.5, z, Math.PI, 0, 0), [0xfff1d6, 0xe8b4c0, 0xf2b64a][i % 3]);
    }

    // tiki torches flanking the path
    for (const t of torchPos) {
      const ty = sandY(t.x, t.z);
      P(xf(new THREE.CylinderGeometry(0.09, 0.11, 2.2, 6), t.x, ty + 1.1, t.z), 0xb08a5a);
      P(xf(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 8), t.x, ty + 2.3, t.z), 0x6d4a2b);
    }
    scene.add(Object.assign(new THREE.Mesh(merge(parts), makeToon(0xffffff, { unique: true, vertexColors: true })), { castShadow: true }));

    for (const t of torchPos) {
      const ty = sandY(t.x, t.z);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 7), makeGlow(0xffa53a, { unique: true }));
      flame.position.set(t.x, ty + 2.72, t.z);
      scene.add(flame);
      // a warm pool under each torch, alive only after dusk (no shadow caster)
      const glow = new THREE.PointLight(0xffa145, 0, 8, 2);
      glow.position.set(t.x, ty + 2.6, t.z);
      scene.add(glow);
      this.anim.torches.push({
        obj: flame, light: glow, ph: Math.random() * TAU,
        // whoever lights the torches walks from one to the other
        lamp: this._addLamp(0.6 + Math.random() * 1.4),
      });
      this.obstacles.push({ x: t.x, z: t.z, r: 0.4 });
    }

    // Two signboards on one post. The upper one faces west (read on your way
    // out of the cove), the lower faces east (read on your way in).
    const yaw = Math.PI / 2 + 0.25;
    const nx = Math.sin(yaw), nz = Math.cos(yaw); // board facing direction
    const boards = [
      [ey + 2.46, -1, texSign('SUNNY PLAZA', 'the heart of the cove', '#4fb3e8')],
      [ey + 1.62, 1, texSign('DRIFTWOOD BEACH', 'sand, surf & fishing', '#e8657a')],
    ];
    for (const [y, dir, tex] of boards) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.66, 0.12), makeToon(0xa87844));
      plank.position.set(sign.x, y, sign.z);
      plank.rotation.y = yaw;
      plank.castShadow = true;
      scene.add(plank);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.62), this._followSky(glowTex(0xf7ead2, tex), 0xf7ead2));
      face.position.set(sign.x + nx * dir * 0.08, y, sign.z + nz * dir * 0.08);
      face.rotation.y = dir > 0 ? yaw : yaw + Math.PI;
      scene.add(face);
    }

    this.obstacles.push({ x: sign.x, z: sign.z, r: 0.55 },
      { x: archA.x, z: archA.z, r: 0.4 }, { x: archB.x, z: archB.z, r: 0.4 });

    this.hotspots.push({
      id: 'exit-plaza',
      position: new THREE.Vector3(12, 0, 2),
      radius: 3,
      label: 'Back to Sunny Plaza',
      action: (g) => g.goToRoom('plaza', 'beach'),
    });
  }

  // ---- jungle path mouth (north dune) --------------------------------------
  /**
   * The way into the Tangle Jungle: a gap in a fern-and-foliage fringe along
   * the north shoreline, a packed-sand path leading into it, two vine-wrapped
   * gateposts and a signpost. The fringe doubles as a screen: it hides the open
   * sea behind the dune so the path reads as leading INTO something.
   */
  _buildJungleMouth(scene) {
    const parts = [];
    const P = (g, c) => parts.push({ g, c });
    this.anim.jFerns = [];

    // ---- packed-sand path north out of the cove
    // The corridor threads the gap between the west palm and the driftwood log,
    // then bends north-west out through the fringe.
    const curve = new THREE.CatmullRomCurve3(
      [[0.8, -4.2], [0.15, -6.2], [-0.45, -8.2], [-0.7, -9.8], [-0.85, -11.1]]
        .map(([x, z]) => new THREE.Vector3(x, 0, z)),
    );
    const N = 26;
    const pp = new Float32Array((N + 1) * 2 * 3);
    const pu = new Float32Array((N + 1) * 2 * 2);
    const pi = new Uint16Array(N * 6);
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u);
      const tg = curve.getTangentAt(u);
      const nx = -tg.z, nz = tg.x;
      const hw = 1.25 - Math.cos(u * Math.PI) * 0.2;
      const k = i * 2;
      for (let s = 0; s < 2; s++) {
        const sgn = s ? 1 : -1;
        const x = p.x + nx * hw * sgn, z = p.z + nz * hw * sgn;
        pp[(k + s) * 3] = x; pp[(k + s) * 3 + 1] = sandY(x, z) + 0.035; pp[(k + s) * 3 + 2] = z;
        pu[(k + s) * 2] = u * 5; pu[(k + s) * 2 + 1] = s;
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
    const path = new THREE.Mesh(pg, glowTex(0xffffff, texPath(), {
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
    }));
    path.renderOrder = 1;
    scene.add(path);

    // ---- gateposts: driftwood wrapped in vines, one either side of the gap
    for (const [gx, gz] of [[-2.0, -9.7], [0.55, -10.2]]) {
      const gy = sandY(gx, gz);
      P(xf(new THREE.CylinderGeometry(0.16, 0.21, 2.5, 7), gx, gy + 1.2, gz, 0, 0, (gx < 0 ? 1 : -1) * 0.06), 0xcfbb9a);
      P(xf(new THREE.SphereGeometry(0.22, 8, 6), gx, gy + 2.42, gz, 0, 0, 0, 1, 0.8, 1), 0x7ac74f);
      for (let i = 0; i < 4; i++) {
        const a = i * 1.7;
        P(xf(new THREE.TorusGeometry(0.2, 0.035, 4, 10), gx, gy + 0.5 + i * 0.45, gz, 1.35, a, 0), 0x63ad3c);
      }
      this.obstacles.push({ x: gx, z: gz, r: 0.45 });
    }

    // ---- signpost, its board square to the play camera
    const sp = spot(1.7, -6.5, 1.0, 2.6);
    const spy = sandY(sp.x, sp.z);
    P(xf(new THREE.CylinderGeometry(0.13, 0.16, 2.9, 7), sp.x, spy + 1.45, sp.z), 0x9a6c3e);
    P(xf(new THREE.SphereGeometry(0.19, 8, 6), sp.x, spy + 2.95, sp.z), 0xc98f52);
    P(xf(new THREE.BoxGeometry(0.46, 0.13, 0.46), sp.x, spy + 0.06, sp.z), 0xd6a86a);
    P(xf(new THREE.BoxGeometry(2.4, 0.62, 0.12), sp.x, spy + 2.1, sp.z, 0, -0.2, 0), 0xa87844);
    this.obstacles.push({ x: sp.x, z: sp.z, r: 0.5 });

    scene.add(Object.assign(new THREE.Mesh(merge(parts), makeToon(0xffffff, {
      unique: true, vertexColors: true,
    })), { castShadow: true, receiveShadow: true }));

    const face = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.58),
      this._followSky(glowTex(0xf7ead2, texSign('TANGLE JUNGLE', 'vines, ruins & doodles', '#4e8a34')), 0xf7ead2));
    face.position.set(sp.x + Math.sin(-0.2) * 0.08, spy + 2.1, sp.z + Math.cos(-0.2) * 0.08);
    face.rotation.y = -0.2;
    scene.add(face);

    // ---- the fringe itself: fern clumps + dark foliage along the north shore
    const clumpG = merge([0, 1, 2, 3, 4, 5, 6].map((i) => ({
      g: xf(new THREE.ConeGeometry(0.16, 1.5, 4), 0, 0.62, 0,
        0.42, (i / 7) * TAU, 0, 1, 1, 1),
      c: i % 2 ? 0x7ac74f : 0x5f9c38,
    })));
    const bushG = merge([0, 1, 2, 3].map((i) => {
      const a = (i / 4) * TAU;
      return {
        g: xf(new THREE.SphereGeometry(0.78, 8, 6), Math.cos(a) * 0.5, 0.55 + (i % 2) * 0.22, Math.sin(a) * 0.5,
          0, 0, 0, 1, 0.82, 1),
        c: [0x4e8a34, 0x3f6b2c, 0x63ad3c, 0x5f9c38][i],
      };
    }));

    const ferns = new THREE.InstancedMesh(clumpG, makeToon(0xffffff, {
      unique: true, vertexColors: true, side: THREE.DoubleSide,
    }), 20);
    ferns.castShadow = true;
    ferns.frustumCulled = false;
    const bushes = new THREE.InstancedMesh(bushG, makeToon(0xffffff, {
      unique: true, vertexColors: true,
    }), 22);
    bushes.castShadow = true;

    let fi = 0, bi = 0;
    // th sweeps the north shore; the path window is left open
    for (let i = 0; i < 30; i++) {
      const th = -2.42 + (i / 29) * 1.62;
      if (Math.abs(th + 1.725) < 0.3) continue; // the gap the path walks through
      const R = shoreR(th);
      for (const [dr, isBush] of [[-0.55, true], [-1.5, false]]) {
        const r = R + dr - Math.random() * 0.5;
        const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
        const y = sandY(x, z);
        if (isBush) {
          if (bi >= 22 || i % 3 === 1) continue;
          // tall enough to hide the open sea behind the gap: the path has to
          // read as leading INTO the jungle, not out onto the water
          instAt(bushes, bi++, x, y - 0.2, z, Math.random() * TAU, 0, 0, 1.5 + Math.random() * 1.0);
        } else {
          if (fi >= 20) continue;
          const sc = 0.85 + Math.random() * 0.6;
          this.anim.jFerns.push({ i: fi, x, y, z, yaw: Math.random() * TAU, sc, ph: Math.random() * TAU });
          instAt(ferns, fi++, x, y, z, 0, 0, 0, sc);
        }
      }
    }
    ferns.count = fi;
    bushes.count = bi;
    ferns.instanceMatrix.needsUpdate = true;
    bushes.instanceMatrix.needsUpdate = true;
    scene.add(ferns, bushes);
    this.anim.jFernMesh = ferns;

    this.hotspots.push({
      id: 'exit-jungle',
      position: new THREE.Vector3(-0.7, 0, -9.9),
      radius: 2.8,
      label: 'Follow the path to the Tangle Jungle',
      action: (g) => g.goToRoom('jungle', 'beach'),
    });
  }

  // ---- beach ball: prediction, bops, water -------------------------------
  /**
   * One integration step of the shared ball, plus the walk-into bop test.
   * The server's frames arrive at 10Hz and are eased in by _onBallFrame; with
   * no server at all (offline, solo) this is simply the whole simulation.
   */
  _updateBall(dt) {
    const b = this._ball;
    if (!b) return;
    const game = this._game;
    b.cool = Math.max(0, b.cool - dt);

    // bleed off whatever error the last authoritative frame left us with
    if (b.ex || b.ey || b.ez) {
      const k = Math.min(1, dt * 6);
      b.x += b.ex * k; b.ex -= b.ex * k;
      b.y += b.ey * k; b.ey -= b.ey * k;
      b.z += b.ez * k; b.ez -= b.ez * k;
    }

    const t = this.t;
    const th = Math.atan2(b.z - CZ, b.x - CX);
    const rr = Math.hypot(b.x - CX, b.z - CZ);
    const inSea = rr > shoreR(th) - 0.5;
    const surf = WATER_Y + waveY(b.x, b.z, t) + BALL_R * 0.45;
    const sand = sandY(b.x, b.z) + BALL_R;

    b.vy -= BALL_G * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    const air = Math.exp(-BALL_AIR * dt);
    b.vx *= air; b.vz *= air;

    if (inSea) {
      if (!b.wet && b.y <= surf + 0.1) {
        b.wet = true;
        this._splash(b.x, surf, b.z, Math.min(2.4, Math.abs(b.vy) * 0.4 + 0.6));
      }
      if (b.y < surf) {
        // buoyancy: bob up to the waterline, kill the fall, drift shoreward so
        // the toy always comes back to the people
        b.y += (surf - b.y) * Math.min(1, dt * 6);
        b.vy = Math.max(b.vy * 0.2, -0.4);
        const drag = Math.exp(-2.4 * dt);
        b.vx *= drag; b.vz *= drag;
        b.vx -= Math.cos(th) * 0.9 * dt;
        b.vz -= Math.sin(th) * 0.9 * dt;
      }
    } else {
      b.wet = false;
      if (b.y <= sand) {
        b.y = sand;
        if (b.vy < -0.8) {
          b.squash = Math.min(1, b.squash + Math.min(1, -b.vy / 7));
          const hard = b.vy < -2.6;
          b.vy = -b.vy * BALL_BOUNCE;
          if (Math.abs(b.vy) < 1.1) b.vy = 0;
          if (hard) this._game?.audio?.play?.('pop'); // only the landings you feel
        } else {
          b.vy = 0;
          const roll = Math.exp(-BALL_ROLL * dt);
          b.vx *= roll; b.vz *= roll;
          if (Math.hypot(b.vx, b.vz) < 0.08) { b.vx = 0; b.vz = 0; }
        }
      }
    }

    // nothing may knock the ball out of the cove for good
    if (rr > 26) {
      b.x = BALL_HOME.x; b.z = BALL_HOME.z; b.y = sandY(b.x, b.z) + BALL_R;
      b.vx = b.vy = b.vz = 0;
    }

    // walking into it counts as a bop: no menu, no button, just contact
    const av = game?.engine?.playerAvatar;
    if (av && !game.activeMinigame && b.cool <= 0) {
      const p = av.group.position;
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < BALL_R + 0.66 && b.y - sand < 1.1) {
        this._bopBall(p.x, p.z, game.engine.controller?.moving ? 1 : 0.5);
      }
    }

    // ---- render state ------------------------------------------------------
    b.pivot.position.set(b.x, b.y, b.z);
    const speed = Math.hypot(b.vx, b.vz);
    if (speed > 0.02) {
      _dir.set(-b.vz, 0, b.vx).normalize();
      _q.setFromAxisAngle(_dir, (speed / BALL_R) * dt);
      b.obj.quaternion.premultiply(_q);
    }
    b.squash = Math.max(0, b.squash - dt * 3.4);
    const sq = b.squash;
    // squash lives on the pivot so it stays world-aligned while the ball rolls
    b.pivot.scale.set(1 + sq * 0.3, 1 - sq * 0.34, 1 + sq * 0.3);

    const shadowY = inSea ? WATER_Y + waveY(b.x, b.z, t) + 0.03 : sandY(b.x, b.z) + 0.03;
    const drop = Math.max(0, b.y - BALL_R - shadowY);
    b.blob.position.set(b.x, shadowY, b.z);
    b.blob.scale.setScalar(Math.max(0.35, 1 - drop * 0.12));
    b.blob.material.opacity = Math.max(0.05, 0.26 - drop * 0.03);

    this._updateSplash(dt);
  }

  /**
   * Send an impulse and apply it at once. The server clamps the magnitude
   * (BALL_IMPULSE_MAX) and checks you were within arm's reach, so this is a
   * request, not an authority; one bop at power 1 is |7.25|, well inside it.
   * Applying locally first is what makes the bop feel like yours: the
   * authoritative frame lands ~a frame later and agrees.
   */
  _bopBall(fromX, fromZ, power = 1, send = true) {
    const b = this._ball;
    if (!b || b.cool > 0) return;
    let dx = b.x - fromX, dz = b.z - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) { dx = 0; dz = 1; } else { dx /= d; dz /= d; }
    const ix = dx * BOP_H * power;
    const iz = dz * BOP_H * power;
    const iy = BOP_V * power;
    b.vx += ix; b.vz += iz;
    b.vy = Math.max(b.vy, 0) + iy;
    b.cool = BOP_COOLDOWN;
    b.squash = Math.min(1, b.squash + 0.55);
    this._game?.audio?.play?.('pop');
    if (send) {
      this._game?.net?.send?.({
        t: 'ball',
        impulse: { x: +ix.toFixed(2), y: +iy.toFixed(2), z: +iz.toFixed(2) },
      });
    }
  }

  /**
   * Authoritative ball frame. Read tolerantly: position as {x,y,z} or p:[..],
   * velocity as {vx,vy,vz} or v:[..], and derived from consecutive frames when
   * the server only ships a position.
   */
  _onBallFrame(m) {
    const b = this._ball;
    if (!b || !m || this._game?.roomId !== this.id) return;
    const p = Array.isArray(m.p) ? m.p : null;
    const x = Number(p ? p[0] : m.x);
    const z = Number(p ? p[2] : m.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    let y = Number(p ? p[1] : m.y);
    if (!Number.isFinite(y)) y = b.y;

    const v = Array.isArray(m.v) ? m.v : null;
    let vx = Number(v ? v[0] : m.vx);
    let vy = Number(v ? v[1] : m.vy);
    let vz = Number(v ? v[2] : m.vz);
    if (!Number.isFinite(vx) || !Number.isFinite(vz)) {
      const last = b.lastNet;
      const dtn = last ? Math.max(0.06, this.t - last.t) : 0;
      vx = last ? (x - last.x) / dtn : 0;
      vy = last ? (y - last.y) / dtn : 0;
      vz = last ? (z - last.z) / dtn : 0;
    }
    if (!Number.isFinite(vy)) vy = 0;
    b.lastNet = { x, y, z, t: this.t };

    if (Math.hypot(x - b.x, z - b.z) > 3) {          // way off: take it whole
      b.x = x; b.y = y; b.z = z;
      b.ex = b.ey = b.ez = 0;
    } else {
      b.ex = x - b.x; b.ey = y - b.y; b.ez = z - b.z;
    }
    b.vx = vx; b.vy = vy; b.vz = vz;
    b.authAt = this.t;
    // somebody else just hit it: give the ball a squash so the bop reads
    if (Math.hypot(vx, vz) > 3.5) b.squash = Math.min(1, b.squash + 0.35);
  }

  /** Water entry: a ring of droplets plus the sfx, if anyone is near enough. */
  _splash(x, y, z, power) {
    const b = this._ball;
    if (!b) return;
    let spawned = 0;
    for (const d of b.dropData) {
      if (d.life > 0) continue;
      const a = Math.random() * TAU;
      const sp = (0.9 + Math.random() * 1.6) * power;
      d.life = 0.45 + Math.random() * 0.35;
      d.max = d.life;
      d.x = x + Math.cos(a) * 0.14; d.y = y + 0.1; d.z = z + Math.sin(a) * 0.14;
      d.vx = Math.cos(a) * sp * 0.6; d.vz = Math.sin(a) * sp * 0.6;
      d.vy = 1.6 + Math.random() * 2.2 * power;
      if (++spawned >= 12) break;
    }
    b.drops.visible = true;
    const p = this._game?.engine?.playerAvatar?.group.position;
    if (!p || Math.hypot(p.x - x, p.z - z) < 24) this._game?.audio?.play?.('splash');
  }

  _updateSplash(dt) {
    const b = this._ball;
    if (!b || !b.drops.visible) return;
    let alive = 0;
    for (let i = 0; i < b.dropData.length; i++) {
      const d = b.dropData[i];
      if (d.life <= 0) { instAt(b.drops, i, 0, -50, 0, 0, 0, 0, 0); continue; }
      d.life -= dt;
      d.vy -= 11 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const u = Math.max(0, d.life / d.max);
      instAt(b.drops, i, d.x, d.y, d.z, 0, 0, 0, 0.5 + u * 0.9);
      alive++;
    }
    b.drops.instanceMatrix.needsUpdate = true;
    b.drops.material.opacity = 0.85;
    if (!alive) b.drops.visible = false;
  }

  // ---- the fire ------------------------------------------------------------
  _updateFire(dt) {
    const f = this._fire;
    if (!f) return;
    const t = this.t;
    // rain knocks the flames down but never puts the gathering out
    const k = this._fireLit * (1 - this._rainAmt * 0.4);
    const on = k > 0.01;
    f.flames.visible = on;
    f.embers.visible = on;
    f.pool.visible = on;
    f.light.intensity = k * (17 + Math.sin(t * 9.1) * 2.4 + Math.sin(t * 3.7) * 1.7);
    f.pool.material.opacity = k * 0.26;
    if (!on) return;

    f.flames.material.opacity = 0.58 * k;
    for (let i = 0; i < f.tongues.length; i++) {
      const g = f.tongues[i];
      const w = 0.76 + Math.sin(t * g.sp + g.ph) * 0.17 + Math.sin(t * 2.3 + g.ph) * 0.07;
      const sy = g.h * w * k;
      const sx = (0.8 + (1 - w) * 0.35) * (0.7 + k * 0.3);
      instAt(f.flames, i, g.x, f.y + 0.32 + 0.575 * sy, g.z,
        t * 0.7 + g.ph, 0, Math.sin(t * 2.4 + g.ph) * 0.13, sx, sy, sx);
    }
    f.flames.instanceMatrix.needsUpdate = true;

    // embers: a steady drift of sparks going up into the dark
    f.spawn += dt * 9 * k;
    for (const e of f.emberData) {
      if (e.life <= 0 && f.spawn >= 1) {
        f.spawn -= 1;
        e.life = 1.1 + Math.random() * 1.4;
        e.max = e.life;
        e.x = FIRE.x + (Math.random() - 0.5) * 0.55;
        e.y = f.y + 0.65;
        e.z = FIRE.z + (Math.random() - 0.5) * 0.55;
        e.vx = (Math.random() - 0.5) * 0.55;
        e.vy = 1.1 + Math.random() * 1.2;
        e.vz = (Math.random() - 0.5) * 0.55;
      }
    }
    for (let i = 0; i < f.emberData.length; i++) {
      const e = f.emberData[i];
      if (e.life <= 0) { instAt(f.embers, i, 0, -50, 0, 0, 0, 0, 0); continue; }
      e.life -= dt;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      e.vy += dt * 0.3;
      e.vx += Math.sin(t * 2 + e.y) * dt * 0.35;
      const u = Math.max(0, e.life / e.max);
      instAt(f.embers, i, e.x, e.y, e.z, 0, 0, 0, 0.4 + u * 1.1);
    }
    f.embers.instanceMatrix.needsUpdate = true;
    f.embers.material.opacity = 0.9 * k;
  }

  /** Is this capybara settled in the glow? (sitting or simply standing still) */
  _cozy(pos, anim) {
    if (anim !== 'idle' && anim !== 'sit') return false;
    return Math.hypot(pos.x - FIRE.x, pos.z - FIRE.z) <= COZY_R;
  }

  /**
   * The cozy halo: a slow spiral of embers around everyone idling in the glow,
   * local and remote alike. It is the visible half of the server's trickle, and
   * the reason a stranger walks over to see what you are doing.
   */
  _updateCozy() {
    const f = this._fire;
    if (!f) return;
    const halo = f.halo;
    const lit = this._fireLit;
    const t = this.t;
    let n = 0;
    if (lit > 0.25) {
      const game = this._game;
      const av = game?.engine?.playerAvatar;
      if (av && !game.activeMinigame && this._cozy(av.group.position, av.state.anim)) {
        this._haloAt(av.group.position, n++, t);
      }
      const remotes = game?.net?.remotes;
      if (remotes) {
        // .values(), not entries: this runs every frame and the [k,v] pairs
        // would be a per-frame allocation for nothing
        for (const r of remotes.values()) {
          if (n >= HALO_SLOTS) break;
          const g = r?.avatar?.group;
          if (!g?.parent || !this._cozy(g.position, r.avatar.state.anim)) continue;
          this._haloAt(g.position, n++, t);
        }
      }
    }
    for (let s = n; s < HALO_SLOTS; s++) {
      for (let i = 0; i < HALO_PER; i++) instAt(halo, s * HALO_PER + i, 0, -50, 0, 0, 0, 0, 0);
    }
    const show = n > 0;
    if (show || this._haloWas) halo.instanceMatrix.needsUpdate = true;
    halo.visible = show;
    halo.material.opacity = 0.75 * lit;
    this._haloWas = show;
  }

  _haloAt(pos, slot, t) {
    const halo = this._fire.halo;
    const base = slot * HALO_PER;
    for (let i = 0; i < HALO_PER; i++) {
      const a = t * 0.8 + (i / HALO_PER) * TAU + slot * 1.7;
      const rad = 0.66 + Math.sin(t * 1.3 + i) * 0.14;
      const y = 0.25 + ((t * 0.4 + i * 0.37) % 1) * 1.6;
      const s = 0.75 + Math.sin(t * 3 + i * 2) * 0.4;
      instAt(halo, base + i, pos.x + Math.cos(a) * rad, pos.y + y, pos.z + Math.sin(a) * rad,
        0, 0, 0, Math.max(0.15, s));
    }
  }

  /**
   * The bonfire trickle is paid by the server; all we do is show it. No toast:
   * a cozy fire should never nag, it should just quietly hand you a coin.
   */
  _onCoins(delta, reason) {
    const game = this._game;
    if (!(delta > 0) || delta > 6) return;
    if (!game || game.roomId !== this.id || game.activeMinigame) return;
    const av = game.engine?.playerAvatar;
    if (!av) return;
    const r = String(reason || '').toLowerCase();
    const near = Math.hypot(av.group.position.x - FIRE.x, av.group.position.z - FIRE.z) <= COZY_R + 0.8;
    if (!near && !r.includes('fire') && !r.includes('cozy') && !r.includes('warm')) return;
    this._spawnMote(av.group.position, `+${delta}`);
  }

  _spawnMote(pos, text) {
    const m = this._mote;
    if (!m) return;
    const cv = m.tex.image;
    if (cv?.getContext) {
      drawMote(cv.getContext('2d'), cv.width, cv.height, text);
      m.tex.needsUpdate = true;
    }
    m.x = pos.x; m.y = pos.y + 2.1; m.z = pos.z;
    m.t = 0;
    m.mesh.visible = true;
  }

  _updateMote(dt) {
    const m = this._mote;
    if (!m || m.t > 1.5) return;
    m.t += dt;
    const u = m.t / 1.5;
    if (u >= 1) { m.mesh.visible = false; return; }
    m.mesh.position.set(m.x, m.y + u * 1.05, m.z);
    const cam = this._game?.engine?.camera;
    if (cam) m.mesh.quaternion.copy(cam.quaternion);
    m.mesh.material.opacity = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
    m.mesh.scale.setScalar(u < 0.16 ? 0.5 + (u / 0.16) * 0.6 : 1.1 - (u - 0.16) * 0.1);
  }

  // ---- rain ----------------------------------------------------------------
  _updateRain(dt) {
    const r = this._rain;
    if (!r) return;
    const amt = this._rainAmt;
    const mesh = r.mesh;
    if (amt < 0.01) {
      if (mesh.visible) { mesh.visible = false; this._puddles.visible = false; }
      return;
    }
    mesh.visible = true;
    mesh.material.opacity = 0.5 * amt;
    this._puddles.visible = true;
    this._puddles.material.opacity = 0.5 * amt;

    const p = this._game?.engine?.playerAvatar?.group.position;
    const cx = p ? p.x : 0, cz = p ? p.z : 0;
    const d = r.drops;
    const shown = Math.max(24, Math.round(RAIN_N * Math.min(1, amt * 1.3)));
    for (let i = 0; i < RAIN_N; i++) {
      if (i >= shown) { instAt(mesh, i, 0, -50, 0, 0, 0, 0, 0); continue; }
      let x = d[i * 4], y = d[i * 4 + 1], z = d[i * 4 + 2];
      const sp = d[i * 4 + 3];
      y -= sp * dt;
      x += dt * 2.4;   // slanted by the same onshore wind that bends the palms
      z += dt * 0.8;
      if (y < -1.2 || Math.abs(x - cx) > 13 || Math.abs(z - cz) > 13) {
        x = cx + (Math.random() - 0.5) * 22;
        z = cz + (Math.random() - 0.5) * 22;
        y = 9 + Math.random() * 5;
      }
      d[i * 4] = x; d[i * 4 + 1] = y; d[i * 4 + 2] = z;
      instAt(mesh, i, x, y, z, 0, 0, -0.17, 1, 1.3 + sp * 0.03, 1);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ---- input ---------------------------------------------------------------
  /**
   * Capture-phase press. We only ever take a press that lands on the ball while
   * the player is close enough to reach it; everything else falls through to
   * the engine untouched (a click on a ball across the cove walks you to it,
   * which is exactly what you wanted anyway).
   */
  _pointerDown(e) {
    const game = this._game;
    const eng = game?.engine;
    const b = this._ball;
    if (!eng || !b || e.button !== 0 || eng.paused || game.activeMinigame) return;
    if (e.target !== (eng.canvas || eng.renderer?.domElement)) return;
    const p = eng.playerAvatar?.group.position;
    if (!p || Math.hypot(p.x - b.x, p.z - b.z) > 6.5) return;
    if (b.cool > 0) return;
    _v2.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this._ballRay.setFromCamera(_v2, eng.camera);
    if (!this._ballRay.intersectObject(b.obj, false).length) return;
    e.stopPropagation();
    this._bopBall(p.x, p.z, 1);
  }

  // ---- per-frame -----------------------------------------------------------
  update(dt, game) {
    const t = (this.t += dt);
    const a = this.anim;
    if (!a) return;
    if (game) this._game = game;

    // world clock first: everything below reads the phase it paints
    this._advanceClock(dt);
    this._relight(dt);
    const wind = 1 + this._windAmt * 0.9;

    // sea surface: height + analytic normal (plane local z is world y)
    const wpos = a.water.geometry.attributes.position;
    const wnrm = a.water.geometry.attributes.normal;
    const arr = wpos.array, narr = wnrm.array;
    for (let i = 0, n = a.wx.length; i < n; i++) {
      const x = a.wx[i], z = a.wz[i];
      const p1 = x * W1K + t * W1S, p2 = z * W2K + t * W2S, p3 = (x + z) * W3K + t * W3S;
      arr[i * 3 + 2] = W1A * Math.sin(p1) + W2A * Math.sin(p2) + W3A * Math.sin(p3);
      const d3 = W3A * W3K * Math.cos(p3);
      const dx = W1A * W1K * Math.cos(p1) + d3;
      const dz = W2A * W2K * Math.cos(p2) + d3;
      const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      narr[i * 3] = -dx * inv; narr[i * 3 + 1] = dz * inv; narr[i * 3 + 2] = inv;
    }
    wpos.needsUpdate = true;
    wnrm.needsUpdate = true;

    // foam: outer edge rides the swell, whole line breathes in and out
    const fpos = a.foam.geometry.attributes.position;
    const farr = fpos.array;
    for (const i of a.foamOuter) {
      farr[i * 3 + 1] = WATER_Y + waveY(farr[i * 3] + CX, farr[i * 3 + 2] + CZ, t) + 0.06;
    }
    fpos.needsUpdate = true;
    const tide = 1 + Math.sin(t * 0.5) * 0.014;
    a.foam.scale.set(tide, 1, tide);
    a.foam.material.map.offset.x = t * 0.014;
    a.foam.material.opacity = 0.78 + Math.sin(t * 0.85) * 0.16;

    // glints: the sun's own glitter, so the clock owns their amplitude
    const gm = a.glintMesh;
    const ga = this._glintAmt;
    for (let i = 0; i < a.glints.length; i++) {
      const g = a.glints[i];
      const pulse = Math.sin(t * g.sp + g.ph);
      const s = pulse > 0 ? pulse * pulse * pulse * g.sc * ga : 0;
      instAt(gm, i, g.x, WATER_Y + waveY(g.x, g.z, t) + 0.035, g.z, t * 0.4 + g.ph, 0, 0, s);
    }
    gm.instanceMatrix.needsUpdate = true;

    // palm fronds sway (harder in a breeze, per the weather state)
    const fm = a.frondMesh;
    for (const f of a.fronds) {
      instAt(fm, f.i, f.x, f.y, f.z,
        f.yaw + Math.sin(t * 0.85 + f.ph) * 0.06 * wind,
        f.pitch + Math.sin(t * 1.25 + f.ph) * 0.075 * wind,
        Math.sin(t * 1.6 + f.ph) * 0.05 * wind, f.sc);
    }
    fm.instanceMatrix.needsUpdate = true;

    // the jungle-mouth ferns nod in the onshore breeze
    if (a.jFernMesh) {
      for (const f of a.jFerns) {
        instAt(a.jFernMesh, f.i, f.x, f.y, f.z,
          f.yaw + Math.sin(t * 0.9 + f.ph) * 0.08 * wind,
          Math.sin(t * 1.3 + f.ph) * 0.06 * wind,
          Math.sin(t * 1.05 + f.ph * 1.4) * 0.07 * wind, f.sc);
      }
      a.jFernMesh.instanceMatrix.needsUpdate = true;
    }

    // umbrellas
    for (const u of a.umbrellas) {
      u.obj.rotation.z = u.base + Math.sin(t * 1.1 + u.ph) * 0.022;
      u.obj.rotation.x = Math.sin(t * 0.9 + u.ph * 1.7) * 0.018;
    }

    // moored rowboat
    const b = a.boat;
    const bx = b.position.x, bz = b.position.z;
    b.position.y = WATER_Y + waveY(bx, bz, t) + 0.3;
    b.rotation.x = (waveY(bx, bz + 1.2, t) - waveY(bx, bz - 1.2, t)) * 0.42;
    b.rotation.z = -(waveY(bx + 1.6, bz, t) - waveY(bx - 1.6, bz, t)) * 0.42;

    // fishing floats
    for (let i = 0; i < a.floats.length; i++) {
      const f = a.floats[i];
      instAt(a.floatMesh, i, f.x, WATER_Y + waveY(f.x, f.z, t) + 0.06, f.z, 0, 0, 0, 1);
    }
    a.floatMesh.instanceMatrix.needsUpdate = true;

    // lantern flicker: a low pilot light by day, full flame after dusk
    const flick = 0.9 + Math.sin(t * 7.3) * 0.06 + Math.sin(t * 3.1) * 0.05;
    const dockOn = this._lampDock ? this._lampDock.on : 1;
    a.lamp.scale.setScalar(flick * (0.72 + dockOn * 0.28));
    a.lampLight.intensity = (1.4 + flick * 1.2) + dockOn * (7 + flick * 2.5);

    // torches: unlit sticks in daylight, proper flames once the lamps come on
    for (const tc of a.torches) {
      const on = tc.lamp ? tc.lamp.on : 1;
      const s = 0.85 + Math.sin(t * 11 + tc.ph) * 0.14 + Math.sin(t * 4.3 + tc.ph) * 0.1;
      const k = 0.28 + on * 0.72;
      tc.obj.scale.set((0.9 + (1 - s) * 0.3) * k, s * 1.15 * k, (0.9 + (1 - s) * 0.3) * k);
      tc.obj.rotation.z = Math.sin(t * 5 + tc.ph) * 0.09;
      if (tc.light) tc.light.intensity = on * (5.5 + s * 2.2);
    }

    // castle flag ripple
    if (a.flag) {
      const fp = a.flag.geometry.attributes.position;
      for (let i = 0; i < fp.count; i++) {
        const u = fp.getX(i) / 0.44 + 0.5;
        fp.setZ(i, Math.sin(u * 5 - t * 6) * 0.06 * u);
      }
      fp.needsUpdate = true;
      a.flag.rotation.y = Math.sin(t * 0.7) * 0.25;
    }

    // the social cove: shared toys, the fire, weather, the bell
    this._updateBall(dt);
    this._updateFire(dt);
    this._updateCozy();
    this._updateMote(dt);
    this._updateRain(dt);
    if (this._bell) {
      // the bell swings a little on its chain, more when the wind is up
      const sw = 0.05 + this._windAmt * 0.05;
      this._bell.group.rotation.z = Math.sin(t * 0.9 + this._bell.ph) * sw;
      this._bell.group.rotation.x = Math.sin(t * 0.7 + this._bell.ph * 1.7) * sw * 0.7;
      const bl = this._bell.lamp ? this._bell.lamp.on : 0;
      this._bell.port.color.setHex(0x9fd8ec).lerp(_mixB.setHex(0xffd489), bl * 0.85);
    }

    // crabs
    for (const c of a.crabs) {
      c.a += dt * c.sp;
      const scuttle = 0.55 + 0.45 * Math.sin(c.a * 3 + c.ph);
      const px = c.cx + Math.cos(c.a) * c.rx;
      const pz = c.cz + Math.sin(c.a) * c.rz;
      const land = toLand(px, pz, 1.0);
      const y = sandY(land.x, land.z);
      c.obj.position.set(land.x, y + 0.16 + Math.abs(Math.sin(t * 9 + c.ph)) * 0.02, land.z);
      const heading = Math.atan2(-Math.sin(c.a) * c.rx, Math.cos(c.a) * c.rz);
      c.obj.rotation.y = heading + Math.PI / 2;
      const wig = Math.sin(t * 13 + c.ph) * 0.3 * scuttle;
      c.legL.rotation.z = wig;
      c.legR.rotation.z = -wig;
      c.claws.rotation.x = Math.sin(t * 4 + c.ph) * 0.22;
      c.body.rotation.z = Math.sin(t * 13 + c.ph) * 0.05;
    }

    // gulls
    for (const g of a.gulls) {
      g.a += dt * g.sp;
      const x = g.cx + Math.cos(g.a) * g.r;
      const z = g.cz + Math.sin(g.a) * g.r;
      g.obj.position.set(x, g.y + Math.sin(t * 0.8 + g.ph) * 0.5, z);
      g.obj.rotation.set(0, -g.a, 0.2);
      const flap = Math.sin(t * 4.2 + g.ph);
      g.wl.rotation.z = 0.15 + flap * 0.55;
      g.wr.rotation.z = -0.15 - flap * 0.55;
    }

    // horizon traffic
    for (const s of a.boats) {
      s.obj.position.x += dt * s.sp;
      if (s.obj.position.x > 40) s.obj.position.x = -90;
      s.obj.position.y = 0.2 + Math.sin(t * 0.7 + s.ph) * 0.22;
      s.obj.rotation.z = Math.sin(t * 0.6 + s.ph) * 0.05;
    }
    for (const c of a.clouds) {
      c.position.x += dt * 0.35;
      if (c.position.x > 110) c.position.x = -110;
    }
  }

  dispose() {
    // event handles and the window listener are the only things living outside
    // the scene graph; everything else is disposed by the engine.
    this._offBall?.();
    this._offCoins?.();
    this._offBall = this._offCoins = null;
    if (this._onDown) removeEventListener('pointerdown', this._onDown, true);
    this._onDown = null;

    this.anim = null;
    this._fire = null;
    this._fireLamp = null;
    this._ball = null;
    this._ballRay = null;
    this._bell = null;
    this._rain = null;
    this._puddles = null;
    this._mote = null;
    this._dome = null;
    this._domeT = null;
    this._orb = null;
    this._unlit = null;
    this._lamps = null;
    this._lampDock = null;
    this._sun = this._hemi = this._amb = null;
    this._waterMat = this._deepMat = this._cloudMat = null;
    this._scene = null;
    this._game = null;
    this.hotspots.length = 0;
    this.obstacles.length = 0;
    this.groundMeshes.length = 0;
  }
}
