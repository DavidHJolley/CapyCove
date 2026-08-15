import * as THREE from 'three';
import { Minigame } from '../minigame.js';
import { makeToon, makeGlow, canvasTexture, disposeObject } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BODY_COLORS } from '../../../shared/constants.js';

/**
 * Capy Karts: six capybaras, three laps, one beachside circuit.
 *
 * Built to docs/KARTS.md (FROZEN). Read that first; this file is the racer
 * client and follows it number for number.
 *
 * TRACK SPACE. The circuit is a closed centripetal Catmull-Rom loop scale-locked
 * to LAP_UNITS = 545, and every kart is stored as (q, lat, yaw):
 *   q    normalised lap progress, 0 at the finish line, wraps 1 -> 0
 *   lat  lateral offset as a fraction of the local half-width (0 centre,
 *        +-1 the white line, +-1.85 the barrier)
 *   yaw  heading MINUS the track tangent, wrapped to -pi..pi
 * x/z never touch the wire: they are `posAt(s)` plus `lat * halfWidth`, which is
 * why server/kart.js needs no track data at all. Driving integrates in world
 * space and is projected back into track space every frame (§2).
 *
 * TWO MODES, ONE SIMULATION.
 *   practice (`game.__kartCtx == null`): we own the boxes, the hazards, the hit
 *     verdicts and five locally simulated AI karts (§3.5, §5). Zero net frames.
 *   race (`game.__kartCtx = {race, grid, startAt, you}` set by speedway.js on
 *     kart-grid): the server owns the lifecycle, the items and every hit
 *     verdict; we simulate only our own kart, relay it at 10Hz through
 *     `kart-in`, and render everyone else from `kart-state` with a 120ms
 *     interpolation buffer. A hit is NEVER applied on prediction: we may splash
 *     cosmetically the instant we drive through something, but no speed or
 *     control penalty lands until `kart-hit` says so (§4 decision 1).
 */

// ============================================================== contract ====
const LAP_UNITS = 545;         // §2 scale lock
const S_FIN = 30.0;            // finish line, units along the spline from CTRL[0]
const LAPS = 3;
const KART_LIGHTS_MS = 3200;   // §3.4
const RACE_MAX_MS = 360000;
const LOCAL_GRACE_MS = 15000;  // practice only; a race ends on the server's word
const SEND_HZ = 10;            // kart-in
const INTERP_MS = 120;         // remote kart render delay

/** [x, z, fullWidth] — §2. Scaled uniformly at build so the lap is 545 units. */
const CTRL = [
  [-60, -80, 15], [-20, -84, 15], [20, -84, 15], [56, -76, 14],
  [84, -58, 13], [95, -30, 13], [92, 2, 12], [82, 30, 11],
  [62, 48, 10], [36, 50, 10], [18, 36, 9], [-4, 44, 9],
  [-30, 50, 11], [-56, 40, 12], [-74, 14, 13], [-80, -16, 13],
  [-76, -48, 14], [-70, -68, 15],
];

// ---- §3.1 driving
const V_MAX = 22.0;
const ACCEL = 26;
const BRAKE = 30;
const COAST_DRAG = 6;
const REVERSE_MAX = 6.0;
const REVERSE_ACCEL = 12;
const OFF_MUL = 0.55;          // off-road top speed multiplier
const OFF_DRAG = 10;
const WALL_LAT = 1.85;
const STEER_EASE = 8;          // per second toward the key/pointer
const GRIP = 9;                // velocity direction -> facing
const GRIP_DRIFT = 3.2;

// ---- §3.2 drift and mini-turbo. Palette colours, never another game's items.
const DRIFT_TIERS = [
  { charge: 0.9, color: 0x4fb3e8, name: 'sky',   ms: 550,  target: 26 },
  { charge: 2.0, color: 0xf2b64a, name: 'gold',  ms: 1000, target: 29 },
  { charge: 3.4, color: 0xe8657a, name: 'coral', ms: 1600, target: 32 },
];
const DRIFT_MIN_V = 8;
const DRIFT_MIN_STEER = 0.25;
const BOOST_ACCEL_MUL = 2.2;
const BOOST_CEIL = 34;

// ---- §3.3 items
const ITEMS = {
  peel: { name: 'Melon Peel', color: 0x7ac74f, blurb: 'Drop it behind you. One spin, coming up.' },
  bubble: { name: 'Splash Bubble', color: 0x4fb3e8, blurb: 'Fires forward and soaks whoever it finds.' },
  berry: { name: 'Zoom Berry', color: 0xe8657a, blurb: 'Eat it. Go fast. No notes.' },
};
const ITEM_ORDER = ['peel', 'bubble', 'berry'];
const ITEM_WEIGHTS = [
  [0.55, 0.30, 0.15], // place 1-2
  [0.35, 0.35, 0.30], // place 3-4
  [0.20, 0.35, 0.45], // place 5-6
];
const ROULETTE_MS = 600;
const BOX_RESPAWN_MS = 5000;
const PEEL_TTL_MS = 25000;
const PEEL_DQ = 0.004;
const PEEL_DLAT = 0.30;
const PEEL_SELF_MS = 800;
const PEEL_BEHIND = 3.5;       // units dropped behind the dropper
const SPIN_MS = 1100;
const BUBBLE_SPEED = 34;
const BUBBLE_TTL_MS = 4000;
const BUBBLE_HOME = 1.4;       // lat units per second
const BUBBLE_DLAT = 0.34;
const SOAK_MS = 2000;
const SOAK_MUL = 0.5;
const BERRY_MS = 1300;
const BERRY_TARGET = 30;

/** §2 — frozen in (q, lat) so both sides agree without the spline. */
const BOXES = [
  [0.220, -0.62], [0.220, -0.21], [0.220, 0.21], [0.220, 0.62],
  [0.550, -0.45], [0.550, 0.00], [0.550, 0.45],
  [0.790, -0.62], [0.790, -0.21], [0.790, 0.21], [0.790, 0.62],
];
const BOX_DQ = 0.006;
const BOX_DLAT = 0.22;

// ---- §3.4 starts
const BOG_HOLD_MS = 200;
const BOG_MS = 1200;
const BOG_V = 4;
const ROCKET_WINDOW_MS = 220;
const ROCKET_MS = 600;
const ROCKET_TARGET = 26;

// ---- §3.5 AI
const AI_SECTORS = [22, 22, 22, 22, 18, 19, 20, 20, 19, 16, 12, 13, 15, 14, 17, 16, 18, 20, 21, 21, 21, 19, 21, 22];
const AI_MIN = 16.0;
const AI_MAX = 21.8;
const AI_NAMES = ['Nibbles', 'Pebble', 'Marzipan', 'Waffles', 'Juniper', 'Tumble', 'Sprout', 'Biscuit', 'Clover', 'Poppy'];
const AI_HATS = ['none', 'beanie', 'cap', 'flower', 'chef'];

// ---- §4.8 payouts
const PLACE_COINS = { 1: 110, 2: 92, 3: 78, 4: 66, 5: 56, 6: 48 };

// ---- palette (§1)
const SAND = 0xf0dca0;
const SEA = 0x4fb3e8;
const ASPHALT = 0x5b5568;
const KERB_A = 0xe8657a;
const KERB_B = 0xfff6e2;
const GOLD = 0xf2b64a;
const CREAM = 0xfff6e2;
const SKY_TOP = 0x3f9fdd;
const SKY_LOW = 0xffeecb;
const FOG_COL = 0xcfe6f2;

// ================================================================ helpers ====
const _m4 = new THREE.Matrix4();
const _q4 = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _col = new THREE.Color();
// scratch reused by the hot render path: nothing in _step allocates (§6)
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _euB = new THREE.Euler();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisX = new THREE.Vector3(1, 0, 0);
const _ghostCol = new THREE.Color(0xbfc6cf);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
/** Exponential smoothing that is frame-rate independent. */
const ease = (dt, k) => 1 - Math.exp(-k * dt);

/** Wrap an angle into -pi..pi. */
function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
/** Shortest-way interpolation between two angles. */
function angLerp(a, b, t) { return a + wrapPi(b - a) * t; }
/** Forward lap distance from a to b, both in 0..1. */
function dq(a, b) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}
const frac1 = (v) => v - Math.floor(v);

const ORD = ['th', 'st', 'nd', 'rd'];
function ordinal(n) {
  const v = n % 100;
  return `${n}${ORD[(v - 20) % 10] || ORD[v] || ORD[0]}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
const hex6 = (c) => `#${((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
/** 74210 -> "1:14.21" */
function lapTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const t = Math.max(0, Math.round(ms / 10) / 100);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Merge primitive parts into one vertex-coloured BufferGeometry so a multi-colour
 * prop still costs a single draw call through InstancedMesh. Inputs are consumed.
 */
function mergeParts(parts) {
  const pos = [];
  const nor = [];
  const cols = [];
  for (const p of parts) {
    const src = p.geo;
    const g = src.index ? src.toNonIndexed() : src;
    const gp = g.attributes.position;
    const gn = g.attributes.normal;
    _eu.set(p.rx || 0, p.ry || 0, p.rz || 0);
    _q4.setFromEuler(_eu);
    _v3b.set(p.x || 0, p.y || 0, p.z || 0);
    _sc.set(p.sx ?? p.s ?? 1, p.sy ?? p.s ?? 1, p.sz ?? p.s ?? 1);
    _m4.compose(_v3b, _q4, _sc);
    _nm.getNormalMatrix(_m4);
    _col.setHex(p.color ?? 0xffffff);
    for (let i = 0; i < gp.count; i++) {
      _v3.fromBufferAttribute(gp, i).applyMatrix4(_m4);
      pos.push(_v3.x, _v3.y, _v3.z);
      _v3.fromBufferAttribute(gn, i).applyNormalMatrix(_nm).normalize();
      nor.push(_v3.x, _v3.y, _v3.z);
      cols.push(_col.r, _col.g, _col.b);
    }
    if (g !== src) g.dispose();
    src.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return out;
}

// ================================================================== track ====
/**
 * Centripetal Catmull-Rom through (x, z, width). The knots come from the 2D
 * distance only, so the width rides exactly the same parameterisation as the
 * centreline and a wide corner never gets a narrow apex.
 */
function crEval(P0, P1, P2, P3, t, out) {
  const d2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const t0 = 0;
  const t1 = t0 + (Math.sqrt(d2(P0, P1)) || 1e-4);
  const t2 = t1 + (Math.sqrt(d2(P1, P2)) || 1e-4);
  const t3 = t2 + (Math.sqrt(d2(P2, P3)) || 1e-4);
  const tt = t1 + (t2 - t1) * t;
  for (let k = 0; k < 3; k++) {
    const a1 = ((t1 - tt) * P0[k] + (tt - t0) * P1[k]) / (t1 - t0);
    const a2 = ((t2 - tt) * P1[k] + (tt - t1) * P2[k]) / (t2 - t1);
    const a3 = ((t3 - tt) * P2[k] + (tt - t2) * P3[k]) / (t3 - t2);
    const b1 = ((t2 - tt) * a1 + (tt - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - tt) * a2 + (tt - t1) * a3) / (t3 - t1);
    out[k] = ((t2 - tt) * b1 + (tt - t1) * b2) / (t2 - t1);
  }
  return out;
}

/**
 * Build the arc-length LUT. Everything downstream (road ribbon, item boxes,
 * grid, minimap, physics) reads the circuit through this one object, so the
 * scale lock lives in exactly one place.
 *
 * @returns {{ step:number, n:number, x:Float32Array, z:Float32Array,
 *   ang:Float32Array, hw:Float32Array, curv:Float32Array,
 *   at(s, out):object, worldOf(q, lat, out):object, angleAt(s):number }}
 */
function buildTrack() {
  const n = CTRL.length;
  const SUB = 48;
  const raw = [];
  const tmp = [0, 0, 0];
  let len = 0;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const P0 = CTRL[(i - 1 + n) % n];
    const P1 = CTRL[i];
    const P2 = CTRL[(i + 1) % n];
    const P3 = CTRL[(i + 2) % n];
    for (let j = 0; j < SUB; j++) {
      const p = crEval(P0, P1, P2, P3, j / SUB, tmp).slice();
      if (prev) len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      raw.push(p);
      prev = p;
    }
  }
  len += Math.hypot(raw[0][0] - prev[0], raw[0][1] - prev[1]);

  // SCALE LOCK: one uniform factor on x, z and width, so the lap measures
  // exactly LAP_UNITS and the road keeps its authored proportion to the corners.
  const k = LAP_UNITS / len;
  for (const p of raw) { p[0] *= k; p[1] *= k; p[2] *= k; }

  // Resample to a fixed 2u step, walking the fine samples and interpolating.
  const step = 2;
  const N = Math.round(LAP_UNITS / step); // 272.5 -> 273 slots + wrap
  const stepR = LAP_UNITS / N;
  const xs = new Float32Array(N + 1);
  const zs = new Float32Array(N + 1);
  const hws = new Float32Array(N + 1);
  const angs = new Float32Array(N + 1);
  const curv = new Float32Array(N + 1);

  let acc = 0;
  let ri = 0;
  for (let i = 0; i <= N; i++) {
    const want = Math.min(i * stepR, LAP_UNITS - 1e-4);
    while (ri < raw.length) {
      const a = raw[ri];
      const b = raw[(ri + 1) % raw.length];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + d >= want || ri === raw.length - 1) {
        const f = d > 1e-9 ? clamp((want - acc) / d, 0, 1) : 0;
        xs[i] = lerp(a[0], b[0], f);
        zs[i] = lerp(a[1], b[1], f);
        hws[i] = lerp(a[2], b[2], f) * 0.5; // table is FULL width
        break;
      }
      acc += d;
      ri++;
    }
  }
  xs[N] = xs[0]; zs[N] = zs[0]; hws[N] = hws[0];

  for (let i = 0; i <= N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    angs[i] = Math.atan2(zs[b] - zs[a], xs[b] - xs[a]);
  }
  for (let i = 0; i <= N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    curv[i] = wrapPi(angs[b] - angs[a]) / (2 * stepR);
  }

  /**
   * An offset path folds through its own centre of curvature once
   * |lat*hw| > 1/|curv|. The hairpin at q~0.55 is tight enough for the barrier
   * line to reach that far, so every world offset is squeezed to stay on the
   * outside of it. `lat` on the wire is untouched: this only shapes geometry.
   */
  function safeOffset(d, c) {
    if (d * c > 0.72) return 0.72 / c;
    return d;
  }

  const at = (s, out = {}) => {
    let u = s % LAP_UNITS;
    if (u < 0) u += LAP_UNITS;
    const f = u / stepR;
    const i = Math.floor(f);
    const t = f - i;
    const j = i + 1;
    out.x = lerp(xs[i], xs[j], t);
    out.z = lerp(zs[i], zs[j], t);
    out.hw = lerp(hws[i], hws[j], t);
    out.ang = angLerp(angs[i], angs[j], t);
    out.curv = lerp(curv[i], curv[j], t);
    return out;
  };

  const _t = {};
  const worldOf = (q, lat, out = {}) => {
    at(frac1(q) * LAP_UNITS + S_FIN, _t);
    const d = safeOffset(lat * _t.hw, _t.curv);
    const sa = Math.sin(_t.ang);
    const ca = Math.cos(_t.ang);
    out.x = _t.x - sa * d;
    out.z = _t.z + ca * d;
    out.ang = _t.ang;
    out.hw = _t.hw;
    return out;
  };

  return {
    step: stepR, n: N, x: xs, z: zs, hw: hws, ang: angs, curv,
    at, worldOf, safeOffset,
    angleAt(s) { return at(s, _t).ang; },
    /** Centreline point for index i, offset laterally by d world units. */
    edge(i, d, out) {
      const c = curv[i];
      const dd = d * c > 0.72 ? 0.72 / c : d;
      out[0] = xs[i] - Math.sin(angs[i]) * dd;
      out[1] = zs[i] + Math.cos(angs[i]) * dd;
      return out;
    },
  };
}

// ========================================================= circuit meshes ====
/**
 * Road, kerbs and run-off are THREE merged ribbons (§6), never per-segment
 * meshes. Each is a closed triangle strip walked once around the LUT with a
 * baked vertex colour, so the whole circuit surface is 3 draw calls.
 */
function buildRibbon(track, bands) {
  const N = track.n;
  const pos = [];
  const nor = [];
  const cols = [];
  const a = [0, 0];
  const b = [0, 0];
  const c = [0, 0];
  const d = [0, 0];
  for (const band of bands) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const hwI = track.hw[i];
      const hwJ = track.hw[j];
      const inner = band.inner;
      const outer = band.outer;
      track.edge(i, inner * hwI, a);
      track.edge(i, outer * hwI, b);
      track.edge(j, outer * hwJ, c);
      track.edge(j, inner * hwJ, d);
      const y = band.y ?? 0;
      const col = band.color(i, N);
      _col.setHex(col);
      // two triangles, flat up-normal (everything is y = const per band)
      const quad = [a, b, c, a, c, d];
      for (const p of quad) {
        pos.push(p[0], y, p[1]);
        nor.push(0, 1, 0);
        cols.push(_col.r, _col.g, _col.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeBoundingSphere();
  return g;
}

/** Asphalt with lane shading, white edge lines and a checkered start band. */
function roadBands(track) {
  const finI = Math.round((S_FIN / LAP_UNITS) * track.n) % track.n;
  const dark = 0x4b4658;
  const mid = ASPHALT;
  const light = 0x6a6377;
  const road = (i, N) => {
    // start/finish: 5 rows of checker just before the line
    const back = (finI - i + N) % N;
    if (back < 4) return (i + Math.floor(back)) % 2 === 0 ? 0xf7f2e6 : 0x38343f;
    // gentle blotching so a 545-unit ribbon is not one flat grey
    const t = (Math.sin(i * 0.7) + Math.sin(i * 0.19 + 1.3)) * 0.25 + 0.5;
    return t > 0.62 ? light : t < 0.36 ? dark : mid;
  };
  return [
    { inner: -1.0, outer: -0.955, y: 0.012, color: () => 0xf7f2e6 },
    { inner: -0.955, outer: 0, y: 0.01, color: road },
    { inner: 0, outer: 0.955, y: 0.01, color: road },
    { inner: 0.955, outer: 1.0, y: 0.012, color: () => 0xf7f2e6 },
  ];
}

/** Coral/cream kerbs. The stripe period is in LUT steps, so it stays even. */
function kerbBands() {
  const stripe = (i) => (Math.floor(i / 2) % 2 === 0 ? KERB_A : KERB_B);
  return [
    { inner: -1.24, outer: -1.0, y: 0.055, color: stripe },
    { inner: 1.0, outer: 1.24, y: 0.055, color: stripe },
  ];
}

/** Sandy run-off aprons outside the kerbs. */
function apronBands() {
  const grit = (i) => (Math.sin(i * 1.1) > 0.35 ? 0xe4cd90 : SAND);
  return [
    { inner: -1.78, outer: -1.24, y: -0.02, color: grit },
    { inner: 1.24, outer: 1.78, y: -0.02, color: grit },
  ];
}

// ---------------------------------------------------------------- props ----
function palmGeo() {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    parts.push({
      geo: new THREE.CylinderGeometry(0.16 - t * 0.05, 0.2 - t * 0.05, 1.1, 6),
      x: Math.sin(t * 1.5) * 0.5, y: 0.55 + i * 1.02, rz: -0.16,
      color: i % 2 ? 0x9a7a52 : 0x8a6c46,
    });
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    parts.push({
      geo: new THREE.ConeGeometry(0.42, 2.5, 4),
      x: Math.sin(1.5) * 0.5 + Math.cos(a) * 1.1, y: 5.5, z: Math.sin(a) * 1.1,
      rx: Math.sin(a) * 0.95, rz: -Math.cos(a) * 0.95, sy: 1,
      color: i % 2 ? 0x5aa83c : 0x7ac74f,
    });
  }
  parts.push({ geo: new THREE.SphereGeometry(0.34, 7, 5), x: 0.6, y: 5.1, color: 0xd8a43c });
  return mergeParts(parts);
}

function tyreGeo() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.55, 0.55, 0.32, 10),
      y: 0.17 + i * 0.31, ry: i * 0.5,
      color: i % 2 ? 0x3a3540 : 0x2c2833,
    });
    parts.push({
      geo: new THREE.CylinderGeometry(0.26, 0.26, 0.34, 8),
      y: 0.17 + i * 0.31, color: i === 1 ? KERB_A : CREAM,
    });
  }
  return mergeParts(parts);
}

function baleGeo() {
  const parts = [
    { geo: new THREE.CylinderGeometry(0.62, 0.62, 1.5, 9), rz: Math.PI / 2, y: 0.62, color: 0xe0c274 },
    { geo: new THREE.TorusGeometry(0.63, 0.06, 4, 10), ry: Math.PI / 2, x: -0.4, y: 0.62, color: 0xb99a52 },
    { geo: new THREE.TorusGeometry(0.63, 0.06, 4, 10), ry: Math.PI / 2, x: 0.4, y: 0.62, color: 0xb99a52 },
  ];
  return mergeParts(parts);
}

/** A bunting arch: two posts and a swagged rope of little pennants. */
function archGeo() {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.CylinderGeometry(0.16, 0.2, 5.2, 6), x: side * 5.6, y: 2.6, color: 0xe6d9bd });
    parts.push({ geo: new THREE.SphereGeometry(0.26, 7, 5), x: side * 5.6, y: 5.3, color: GOLD });
  }
  const flagCols = [KERB_A, GOLD, SEA, 0x7ac74f, CREAM];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const x = -5.6 + t * 11.2;
    const y = 5.1 - Math.sin(t * Math.PI) * 0.85;
    parts.push({ geo: new THREE.BoxGeometry(0.78, 0.09, 0.09), x, y, rz: Math.cos(t * Math.PI) * 0.28, color: 0xd9cbaa });
    if (i < 14) {
      parts.push({
        geo: new THREE.ConeGeometry(0.26, 0.5, 3), x: x + 0.38, y: y - 0.3,
        rx: Math.PI, color: flagCols[i % flagCols.length],
      });
    }
  }
  return mergeParts(parts);
}

/** A cheering capybara in the stands: one merged blob, not a full avatar. */
function crowdGeo(color) {
  return mergeParts([
    { geo: new THREE.SphereGeometry(0.42, 8, 6), y: 0.44, sy: 1.05, color },
    { geo: new THREE.SphereGeometry(0.33, 8, 6), y: 1.0, color },
    { geo: new THREE.BoxGeometry(0.3, 0.2, 0.2), y: 0.94, z: 0.28, color },
    { geo: new THREE.SphereGeometry(0.09, 6, 5), x: -0.24, y: 1.24, sz: 0.6, color },
    { geo: new THREE.SphereGeometry(0.09, 6, 5), x: 0.24, y: 1.24, sz: 0.6, color },
    { geo: new THREE.SphereGeometry(0.05, 5, 4), x: -0.12, y: 1.04, z: 0.3, color: 0x241a12 },
    { geo: new THREE.SphereGeometry(0.05, 5, 4), x: 0.12, y: 1.04, z: 0.3, color: 0x241a12 },
    { geo: new THREE.CapsuleGeometry(0.08, 0.3, 3, 6), x: -0.44, y: 0.86, rz: 0.9, color },
    { geo: new THREE.CapsuleGeometry(0.08, 0.3, 3, 6), x: 0.44, y: 0.86, rz: -0.9, color },
  ]);
}

function gullGeo() {
  return mergeParts([
    { geo: new THREE.SphereGeometry(0.16, 7, 5), sz: 1.5, color: 0xfdfbf4 },
    { geo: new THREE.SphereGeometry(0.1, 6, 5), z: 0.24, y: 0.06, color: 0xfdfbf4 },
    { geo: new THREE.ConeGeometry(0.04, 0.14, 4), z: 0.34, y: 0.05, rx: Math.PI / 2, color: GOLD },
    { geo: new THREE.BoxGeometry(0.62, 0.03, 0.16), x: -0.34, y: 0.06, rz: 0.3, color: 0xe9e4d6 },
    { geo: new THREE.BoxGeometry(0.62, 0.03, 0.16), x: 0.34, y: 0.06, rz: -0.3, color: 0xe9e4d6 },
  ]);
}

/** Item box: a floating cube with a glowing capy-paw sigil on every face. */
function boxGeo() {
  const parts = [{ geo: new THREE.BoxGeometry(1.15, 1.15, 1.15), color: 0xfff3d2 }];
  for (const [ax, sx, sy, sz] of [[0, 0.03, 0.6, 0.6], [1, 0.6, 0.03, 0.6], [2, 0.6, 0.6, 0.03]]) {
    for (const s of [-1, 1]) {
      const off = [0, 0, 0];
      off[ax] = s * 0.59;
      // pad
      parts.push({
        geo: new THREE.SphereGeometry(0.19, 7, 5), x: off[0], y: off[1], z: off[2],
        sx, sy, sz, color: KERB_A,
      });
      // four toes
      for (let i = 0; i < 4; i++) {
        const a = -0.9 + i * 0.6;
        const p = [Math.cos(a) * 0.3, 0.3 + Math.sin(a) * 0.06, Math.sin(a) * 0.3];
        const q = [0, 0, 0];
        q[ax] = s * 0.6;
        q[(ax + 1) % 3] = p[0];
        q[(ax + 2) % 3] = p[1] - 0.14;
        parts.push({
          geo: new THREE.SphereGeometry(0.085, 6, 5), x: q[0], y: q[1], z: q[2], color: KERB_A,
        });
      }
    }
  }
  return mergeParts(parts);
}

/** Melon peel: a green rind arc with a pink inside, lying flat. */
function peelGeo() {
  return mergeParts([
    { geo: new THREE.TorusGeometry(0.5, 0.16, 5, 10, Math.PI * 1.2), rx: Math.PI / 2, y: 0.14, color: 0x4f8f3a },
    { geo: new THREE.TorusGeometry(0.5, 0.1, 5, 10, Math.PI * 1.2), rx: Math.PI / 2, y: 0.2, color: 0xf58a9c },
    { geo: new THREE.SphereGeometry(0.14, 6, 5), x: 0.5, y: 0.16, color: 0x4f8f3a },
  ]);
}

function bubbleGeo() {
  return mergeParts([
    { geo: new THREE.SphereGeometry(0.62, 12, 9), y: 0.62, color: 0xbfe9ff },
    { geo: new THREE.SphereGeometry(0.2, 7, 5), x: -0.22, y: 0.9, z: 0.28, color: 0xffffff },
    { geo: new THREE.SphereGeometry(0.1, 6, 5), x: 0.28, y: 0.42, z: 0.3, color: 0xffffff },
  ]);
}

/** Start gantry straddling the main straight, with a checkered banner. */
function gantryGeo(span) {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(0.7, 7.2, 0.7), x: side * span, y: 3.6, color: GOLD });
    parts.push({ geo: new THREE.BoxGeometry(1.4, 0.4, 1.4), x: side * span, y: 0.2, color: 0xd39a2f });
    parts.push({ geo: new THREE.SphereGeometry(0.45, 8, 6), x: side * span, y: 7.4, color: KERB_A });
  }
  parts.push({ geo: new THREE.BoxGeometry(span * 2 + 0.7, 0.55, 0.9), y: 7.0, color: GOLD });
  parts.push({ geo: new THREE.BoxGeometry(span * 2 - 0.6, 1.5, 0.3), y: 6.1, color: CREAM });
  const cols = Math.floor(span * 2 / 0.85);
  for (let i = 0; i < cols; i++) {
    for (let r = 0; r < 2; r++) {
      parts.push({
        geo: new THREE.BoxGeometry(0.85, 0.4, 0.12),
        x: -span + 0.6 + i * 0.85, y: 5.7 + r * 0.4, z: -0.2,
        color: (i + r) % 2 ? 0x2f2b36 : 0xf7f2e6,
      });
    }
  }
  // five start lights on the crossbeam
  for (let i = 0; i < 5; i++) {
    parts.push({
      geo: new THREE.SphereGeometry(0.28, 8, 6),
      x: (i - 2) * 1.1, y: 7.0, z: 0.5, color: 0x4a3b3b,
    });
  }
  return mergeParts(parts);
}

function lighthouseGeo() {
  const parts = [
    { geo: new THREE.CylinderGeometry(2.4, 3.4, 2.0, 12), y: 1.0, color: 0xcfc6b4 },
  ];
  for (let i = 0; i < 6; i++) {
    parts.push({
      geo: new THREE.CylinderGeometry(1.5 - i * 0.13, 1.7 - i * 0.13, 2.2, 12),
      y: 3.1 + i * 2.2, color: i % 2 ? KERB_A : CREAM,
    });
  }
  parts.push({ geo: new THREE.CylinderGeometry(1.35, 1.35, 1.5, 12), y: 17.2, color: 0x6a6377 });
  parts.push({ geo: new THREE.SphereGeometry(1.0, 10, 7), y: 17.4, color: 0xfff0b0 });
  parts.push({ geo: new THREE.ConeGeometry(1.6, 1.6, 12), y: 18.7, color: 0x4a4356 });
  parts.push({ geo: new THREE.SphereGeometry(0.24, 6, 5), y: 19.7, color: GOLD });
  return mergeParts(parts);
}

/** Grandstand: merged steps plus a bunting roofline, one draw call. */
function standGeo(len) {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    parts.push({
      geo: new THREE.BoxGeometry(len, 0.55, 1.5),
      y: 0.28 + i * 0.55, z: -i * 1.5, color: i % 2 ? 0xe6d9bd : 0xd8c8a6,
    });
  }
  parts.push({ geo: new THREE.BoxGeometry(len, 0.3, 0.4), y: 3.1, z: -6.4, color: KERB_A });
  return mergeParts(parts);
}

// ------------------------------------------------------------- the kart ----
/** Racer-coloured shell. White vertex colour: the tint rides instanceColor. */
function kartBodyGeo() {
  return mergeParts([
    { geo: new THREE.BoxGeometry(1.1, 0.3, 1.5), y: 0.34 },
    { geo: new THREE.BoxGeometry(0.78, 0.26, 0.5), y: 0.55, z: 0.52 },
    { geo: new THREE.ConeGeometry(0.46, 0.6, 4), y: 0.42, z: 0.92, rx: Math.PI / 2, ry: Math.PI / 4 },
    { geo: new THREE.BoxGeometry(1.34, 0.18, 0.62), y: 0.3, z: 0.12 },
    { geo: new THREE.BoxGeometry(0.9, 0.5, 0.42), y: 0.62, z: -0.6 },
    { geo: new THREE.BoxGeometry(1.02, 0.1, 0.36), y: 1.02, z: -0.78 },
    { geo: new THREE.BoxGeometry(0.1, 0.3, 0.14), x: -0.4, y: 0.87, z: -0.74 },
    { geo: new THREE.BoxGeometry(0.1, 0.3, 0.14), x: 0.4, y: 0.87, z: -0.74 },
  ]);
}

/** Everything that is NOT the racer's colour, so the tint never touches it. */
function kartTrimGeo() {
  return mergeParts([
    { geo: new THREE.BoxGeometry(0.66, 0.12, 0.44), y: 0.5, z: -0.18, color: 0x8a6642 },
    { geo: new THREE.BoxGeometry(0.62, 0.34, 0.1), y: 0.68, z: -0.36, color: 0x8a6642 },
    { geo: new THREE.TorusGeometry(0.2, 0.045, 5, 10), y: 0.78, z: 0.42, rx: 1.15, color: 0x3a3540 },
    { geo: new THREE.CylinderGeometry(0.04, 0.04, 0.24, 5), y: 0.66, z: 0.46, rx: 0.42, color: 0x3a3540 },
    { geo: new THREE.BoxGeometry(0.9, 0.12, 0.12), y: 0.24, z: 0.98, color: CREAM },
    { geo: new THREE.BoxGeometry(0.86, 0.12, 0.12), y: 0.24, z: -0.86, color: CREAM },
    { geo: new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6), x: -0.3, y: 0.9, z: -0.86, rx: 1.2, color: 0x9aa2ad },
    { geo: new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6), x: 0.3, y: 0.9, z: -0.86, rx: 1.2, color: 0x9aa2ad },
  ]);
}

function wheelGeo() {
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.32, 0.32, 0.26, 10), rz: Math.PI / 2, color: 0x2f2b36 },
    { geo: new THREE.CylinderGeometry(0.15, 0.15, 0.29, 8), rz: Math.PI / 2, color: 0xf3ead4 },
    { geo: new THREE.BoxGeometry(0.3, 0.06, 0.5), color: 0xd9cbaa },
    { geo: new THREE.BoxGeometry(0.3, 0.5, 0.06), color: 0xd9cbaa },
  ]);
}

/** Wheel mounts in kart space: [x, y, z, isFront]. */
const WHEELS = [
  [-0.66, 0.32, 0.52, 1], [0.66, 0.32, 0.52, 1],
  [-0.7, 0.32, -0.55, 0], [0.7, 0.32, -0.55, 0],
];

/** Number roundel: two quads (nose + tail) sharing one canvas texture. */
function roundelGeo() {
  const g1 = new THREE.PlaneGeometry(0.44, 0.44);
  g1.translate(0, 0.62, 0.79);
  const g2 = new THREE.PlaneGeometry(0.44, 0.44);
  g2.rotateY(Math.PI);
  g2.translate(0, 1.06, -0.84);
  const pos = [];
  const uv = [];
  const nor = [];
  for (const g of [g1, g2]) {
    const ng = g.toNonIndexed();
    const p = ng.attributes.position;
    const u = ng.attributes.uv;
    const nn = ng.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      uv.push(u.getX(i), u.getY(i));
      nor.push(nn.getX(i), nn.getY(i), nn.getZ(i));
    }
    ng.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

function roundelTex(n, color) {
  return canvasTexture(64, 64, (c, w, h) => {
    c.fillStyle = hex6(color);
    c.beginPath();
    c.arc(w / 2, h / 2, w / 2 - 1, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff6e2';
    c.beginPath();
    c.arc(w / 2, h / 2, w / 2 - 6, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#2d2417';
    c.font = '900 44px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(n), w / 2, h / 2 + 2);
  });
}

/** Vertical gradient sky dome. Follows the camera, ignores fog. */
function buildSky() {
  const geo = new THREE.SphereGeometry(600, 20, 14);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const top = new THREE.Color(SKY_TOP);
  const mid = new THREE.Color(0xa9dcf2);
  const low = new THREE.Color(SKY_LOW);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const t = clamp(p.getY(i) / 600, -1, 1);
    if (t > 0.1) c.copy(mid).lerp(top, clamp((t - 0.1) / 0.7, 0, 1));
    else c.copy(low).lerp(mid, clamp((t + 0.3) / 0.4, 0, 1));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

// ==================================================================== css ====
const CSS = `
.mg-kart-wrap{position:absolute;inset:0;overflow:hidden;font-family:var(--font);color:var(--ink);
  user-select:none;-webkit-user-select:none;background:#bfe3f2;cursor:default;}
.mg-kart-wrap canvas.mg-kart-gl{position:absolute;inset:0;width:100%;height:100%;display:block;}
.mg-kart-vig{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .25s ease;
  background:radial-gradient(ellipse 64% 60% at 50% 52%,rgba(0,0,0,0) 42%,rgba(24,38,58,.5) 100%);}
.mg-kart-flash{position:absolute;inset:0;pointer-events:none;opacity:0;}
.mg-kart-flash.hit{animation:mg-kart-fx .45s ease-out;
  background:radial-gradient(ellipse at 50% 55%,rgba(232,101,122,0) 32%,rgba(232,101,122,.85) 100%);}
.mg-kart-flash.soak{animation:mg-kart-fx .55s ease-out;
  background:radial-gradient(ellipse at 50% 55%,rgba(79,179,232,0) 25%,rgba(120,205,245,.9) 100%);}
.mg-kart-flash.boost{animation:mg-kart-fx .5s ease-out;
  background:radial-gradient(ellipse at 50% 62%,rgba(255,235,170,0) 28%,rgba(255,226,140,.7) 100%);}
@keyframes mg-kart-fx{from{opacity:1}to{opacity:0}}

.mg-kart-hud{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .3s ease;}
.mg-kart-hud.on{opacity:1;}
.mg-kart-panel{position:absolute;background:rgba(255,253,246,.92);border-radius:16px;padding:9px 14px;
  box-shadow:var(--shadow);font-weight:800;}
.mg-kart-pos{top:16px;left:16px;min-width:168px;}
.mg-kart-place{font-size:44px;line-height:.95;color:var(--accent);letter-spacing:-.01em;}
.mg-kart-place span{font-size:15px;color:#9b8a6c;margin-left:5px;letter-spacing:0;}
.mg-kart-lbl{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:#9b8a6c;}
.mg-kart-order{margin-top:7px;display:flex;flex-direction:column;gap:2px;}
.mg-kart-orow{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;color:#5c5140;
  padding:1px 3px;border-radius:6px;}
.mg-kart-orow.me{background:rgba(232,101,122,.16);}
.mg-kart-orow.ghost{opacity:.45;}
.mg-kart-orow i{width:9px;height:9px;border-radius:99px;flex:none;box-shadow:inset 0 -2px 0 rgba(0,0,0,.2);}
.mg-kart-orow u{text-decoration:none;color:#9b8a6c;font-size:10px;width:16px;}
.mg-kart-orow b{margin-left:auto;font-size:10px;color:#a2937a;font-weight:900;}

.mg-kart-lap{top:16px;right:16px;text-align:right;min-width:132px;}
.mg-kart-lapn{font-size:32px;line-height:1;}
.mg-kart-lapn span{font-size:15px;color:#9b8a6c;}
.mg-kart-time{font-size:15px;color:#5c5140;margin-top:3px;font-variant-numeric:tabular-nums;}
.mg-kart-best{font-size:11px;color:#9b8a6c;margin-top:2px;font-variant-numeric:tabular-nums;}

.mg-kart-item{position:absolute;top:16px;left:50%;translate:-50% 0;width:96px;height:96px;
  border-radius:22px;background:rgba(255,253,246,.9);box-shadow:var(--shadow);display:flex;
  align-items:center;justify-content:center;transition:scale .16s ease;}
.mg-kart-item.spin{animation:mg-kart-spin .6s linear;}
.mg-kart-item.pop{scale:1.14;}
@keyframes mg-kart-spin{50%{rotate:8deg}}
.mg-kart-icon{width:62px;height:62px;opacity:0;transition:opacity .12s ease;}
.mg-kart-icon.on{opacity:1;}
.mg-kart-use{position:absolute;bottom:-9px;left:50%;translate:-50% 0;background:var(--accent);color:#fff;
  font-size:10px;font-weight:900;padding:3px 10px;border-radius:99px;letter-spacing:.06em;opacity:0;
  transition:opacity .15s ease;white-space:nowrap;}
.mg-kart-use.on{opacity:1;}

.mg-kart-map{position:absolute;right:16px;bottom:16px;width:160px;height:160px;border-radius:20px;
  background:rgba(255,253,246,.88);box-shadow:var(--shadow);padding:6px;}
.mg-kart-map canvas{width:148px;height:148px;display:block;}

.mg-kart-lights{position:absolute;top:14%;left:50%;translate:-50% 0;display:none;gap:12px;
  padding:14px 20px;border-radius:99px;background:rgba(35,28,42,.6);}
.mg-kart-lights.on{display:flex;}
.mg-kart-bulb{width:26px;height:26px;border-radius:99px;background:#4a3b3b;
  box-shadow:inset 0 -4px 0 rgba(0,0,0,.3);transition:background .12s ease;}
.mg-kart-bulb.lit{background:#e8657a;box-shadow:0 0 16px rgba(232,101,122,.9),inset 0 -4px 0 rgba(0,0,0,.2);}
.mg-kart-bulb.go{background:#7ac74f;box-shadow:0 0 18px rgba(122,199,79,.95),inset 0 -4px 0 rgba(0,0,0,.2);}

.mg-kart-big{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  pointer-events:none;}
.mg-kart-num{font-size:132px;font-weight:900;color:#fff;text-shadow:0 7px 0 rgba(45,36,23,.32);
  animation:mg-kart-num .8s ease-out forwards;}
.mg-kart-num.go{color:var(--gold);font-size:108px;}
@keyframes mg-kart-num{from{opacity:0;scale:2.2}18%{opacity:1;scale:1}to{opacity:0;scale:.7}}
.mg-kart-banner{position:absolute;top:34%;left:0;right:0;text-align:center;font-size:52px;
  font-weight:900;color:#fff;text-shadow:0 6px 0 rgba(45,36,23,.32);letter-spacing:.04em;
  animation:mg-kart-ban 1.9s ease-out forwards;pointer-events:none;}
@keyframes mg-kart-ban{0%{opacity:0;translate:-40px 0}
  14%{opacity:1;translate:0 0}72%{opacity:1;translate:0 0}to{opacity:0;translate:40px 0}}

.mg-kart-pops{position:absolute;left:50%;top:56%;translate:-50% 0;width:0;pointer-events:none;}
.mg-kart-pop{position:absolute;left:0;top:0;translate:-50% 0;white-space:nowrap;font-weight:900;
  font-size:26px;color:#fff;text-shadow:0 3px 0 rgba(45,36,23,.35);animation:mg-kart-pop 1s ease-out forwards;}
.mg-kart-pop.gold{color:var(--gold);}.mg-kart-pop.sky{color:#8fdcff;}.mg-kart-pop.bad{color:#ff9bab;}
@keyframes mg-kart-pop{from{opacity:0;translate:-50% 16px;scale:.6}
  25%{opacity:1;translate:-50% -6px;scale:1.14}to{opacity:0;translate:-50% -66px;scale:1}}

.mg-kart-tags{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden;}
.mg-kart-tag{position:absolute;left:0;top:0;translate:-50% -100%;display:none;align-items:center;gap:6px;
  background:rgba(255,253,246,.9);border-radius:999px;padding:2px 9px 2px 4px;font-size:11.5px;
  font-weight:800;white-space:nowrap;box-shadow:0 3px 10px rgba(26,52,78,.28);}
.mg-kart-tag.on{display:flex;}
.mg-kart-tag i{width:12px;height:12px;border-radius:99px;box-shadow:inset 0 -3px 0 rgba(0,0,0,.2);}
.mg-kart-tag u{text-decoration:none;font-size:10px;color:#8a7a5a;font-weight:900;}

.mg-kart-cards{position:absolute;inset:0;z-index:4;pointer-events:none;}
.mg-kart-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;gap:13px;
  padding:22px;text-align:center;pointer-events:auto;overflow-y:auto;
  background:linear-gradient(180deg,rgba(20,32,44,.3),rgba(20,32,44,.72));}
.mg-kart-card>*{margin:auto 0;}
.mg-kart-card.out{animation:mg-kart-out .28s ease forwards;pointer-events:none;}
@keyframes mg-kart-out{to{opacity:0;scale:1.05}}
.mg-kart-box{background:var(--cream);border-radius:28px;padding:24px 30px;width:min(500px,93vw);
  box-shadow:var(--shadow);animation:mg-kart-in .3s ease;}
@keyframes mg-kart-in{from{opacity:0;translate:0 20px;scale:.94}}
.mg-kart-title{font-size:40px;font-weight:900;color:var(--accent);line-height:1;}
.mg-kart-sub{font-weight:700;color:#8a7a5a;font-size:13px;margin-top:6px;}
.mg-kart-keys{display:flex;gap:7px;justify-content:center;margin:14px 0 10px;flex-wrap:wrap;}
.mg-kart-key{background:#fff;border:2px solid #e3d9c4;border-radius:9px;padding:4px 10px;
  font-weight:900;font-size:13px;box-shadow:0 2px 0 #e3d9c4;}
.mg-kart-key u{text-decoration:none;color:#a2937a;font-weight:800;margin-left:5px;font-size:11px;}
.mg-kart-rules{display:flex;flex-direction:column;gap:7px;text-align:left;margin:6px 0;}
.mg-kart-rule{display:flex;gap:10px;align-items:center;font-size:13px;font-weight:700;color:#5c5140;}
.mg-kart-swatch{width:26px;height:26px;border-radius:8px;flex:none;box-shadow:inset 0 -3px 0 rgba(0,0,0,.18);}
.mg-kart-btns{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;}
.mg-kart-btn{background:var(--accent);color:#fff;border:3px solid #fff;font-family:var(--font);
  font-weight:900;font-size:16px;padding:11px 24px;border-radius:999px;cursor:pointer;
  box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-kart-btn:hover{scale:1.06;}.mg-kart-btn:active{scale:.96;}
.mg-kart-btn.alt{background:var(--accent2);}
.mg-kart-btn.ghost{background:transparent;color:var(--ink);border-color:#d8ccb4;box-shadow:none;}
.mg-kart-blink{margin-top:12px;font-size:12.5px;font-weight:800;color:#a99a80;
  animation:mg-kart-blink 1.5s ease-in-out infinite;}
@keyframes mg-kart-blink{50%{opacity:.35}}
.mg-kart-grid{display:flex;flex-direction:column;gap:5px;margin:12px 0 4px;}
.mg-kart-grow{display:flex;align-items:center;gap:9px;background:var(--card);border-radius:11px;
  padding:6px 12px;font-weight:800;font-size:13px;}
.mg-kart-grow i{width:14px;height:14px;border-radius:99px;box-shadow:inset 0 -3px 0 rgba(0,0,0,.2);}
.mg-kart-grow .n{width:26px;color:#9b8a6c;font-size:11px;}
.mg-kart-grow b{margin-left:auto;font-size:11px;color:#a2937a;}
.mg-kart-grow.me{outline:3px solid var(--accent);outline-offset:-3px;}
.mg-kart-rows{margin:14px 0 4px;display:flex;flex-direction:column;gap:6px;}
.mg-kart-row{display:flex;justify-content:space-between;align-items:center;background:var(--card);
  border-radius:12px;padding:8px 14px;font-weight:800;font-size:14px;}
.mg-kart-row.total{background:#2d2417;color:#fff;}
.mg-kart-row.pay{background:var(--gold);font-size:16px;}
.mg-kart-tag2{display:inline-block;background:var(--accent);color:#fff;font-size:11px;font-weight:900;
  padding:3px 9px;border-radius:99px;margin-left:7px;letter-spacing:.06em;vertical-align:middle;
  animation:mg-kart-tag 0.8s ease-in-out infinite;}
@keyframes mg-kart-tag{50%{scale:1.12}}
.mg-kart-wait{margin:14px 0 2px;font-size:13px;font-weight:800;color:#8a7a5a;
  animation:mg-kart-blink 1.5s ease-in-out infinite;}

.mg-kart-quit{position:absolute;right:16px;top:16px;z-index:6;background:rgba(255,253,246,.9);border:0;
  font-family:var(--font);font-weight:800;font-size:13px;padding:9px 16px;border-radius:999px;
  cursor:pointer;box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-kart-quit:hover{scale:1.07;}
.mg-kart-quit b{font-weight:900;opacity:.5;margin-left:6px;font-size:11px;}
.mg-kart-tip{position:absolute;left:50%;bottom:18px;translate:-50% 0;background:rgba(45,36,23,.7);
  color:#fff;font-size:12.5px;font-weight:700;padding:7px 16px;border-radius:999px;
  transition:opacity .6s ease;pointer-events:none;}
`;

const COIN_ICO = '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#e0952f"/><circle cx="12" cy="12" r="7.4" fill="#f2b64a"/><circle cx="12" cy="12" r="3.6" fill="#ffd77a"/></svg>';

/** Item card art, drawn as inline SVG so the HUD needs no textures. */
const ITEM_SVG = {
  peel: '<svg class="mg-kart-icon" viewBox="0 0 64 64"><path d="M8 44a26 26 0 0 0 48 0z" fill="#4f8f3a"/><path d="M13 44a21 21 0 0 0 38 0z" fill="#f58a9c"/><circle cx="26" cy="38" r="2.2" fill="#3b2a1c"/><circle cx="38" cy="38" r="2.2" fill="#3b2a1c"/><circle cx="32" cy="30" r="2.2" fill="#3b2a1c"/></svg>',
  bubble: '<svg class="mg-kart-icon" viewBox="0 0 64 64"><circle cx="32" cy="34" r="22" fill="#bfe9ff"/><circle cx="32" cy="34" r="22" fill="none" stroke="#4fb3e8" stroke-width="3"/><circle cx="24" cy="26" r="6" fill="#fff"/><circle cx="41" cy="42" r="3" fill="#fff"/></svg>',
  berry: '<svg class="mg-kart-icon" viewBox="0 0 64 64"><circle cx="32" cy="38" r="18" fill="#e8657a"/><circle cx="25" cy="32" r="5" fill="#ff9bab"/><path d="M32 20c0-6 5-9 9-9-1 6-4 9-9 9z" fill="#7ac74f"/><rect x="30.5" y="12" width="3" height="10" rx="1.5" fill="#7a5a3a"/></svg>',
};

// =================================================================== game ====
export class KartGame extends Minigame {
  static id = 'kart';
  static name = 'Capy Karts';

  constructor(game) {
    super(game);
    this.phase = 'splash';   // splash | count | race | done | results
    this.raf = 0;
    this.time = 0;
    this.disposed = false;
    this.listeners = [];
    this.subs = [];
    this._timers = [];
    this.geos = [];
    this.mats = [];
    this.texs = [];
    this.keys = new Set();
    this.karts = [];
    this.me = null;
    this.net = null;          // race context, null in practice
    this.ctxRef = null;
    this.boxes = [];
    this.hazards = new Map();
    this.projectiles = new Map();
    this.parts = [];
    this.sparks = [];
    this.confetti = [];
    this.hazSeq = 1;
    this.startAt = 0;         // local performance-clock ms of the green light
    this.skew = 0;            // serverNow - Date.now() at kart-go receipt
    this.raceMs = 0;
    this.results = null;
    this.podium = null;
    this._payout = null;
    this.vw = 1;
    this.vh = 1;
    this.rng = mulberry32((Date.now() ^ 0x5f3a) >>> 0);
    this._tmp = {};
    this._tmp2 = {};
  }

  // ------------------------------------------------------------- lifecycle -
  mount(root) {
    super.mount(root);
    this.track = buildTrack();
    this.net = this._readCtx();
    this._buildDom(root);
    this._buildScene();
    this._buildKarts();
    this._resetRace();
    this._bindInput();
    this._bindNet();
    // A reconnect: speedway.js parked the server's kart-resume payload on the
    // handshake before starting us. Without this the resume position was read
    // by nobody and the rider restarted the race from the grid.
    if (this.net && this.ctxRef?.resume) this._onResume(this.ctxRef.resume);
    this._last = performance.now();
    this.raf = requestAnimationFrame(this._tick);
  }

  /**
   * §4.8 — placement-based, generous, and never capped for an honest run: the
   * honest ceiling is 152 against the orchestrator's maxCoinsPerRun of 160.
   * `_payout` is stamped immediately before finish(), so the coin road sees the
   * run we actually drove; a stray call falls back to the place the score band
   * encodes (the place term steps by 1000 and everything else tops out at 650).
   */
  coinsForScore(score) {
    const r = this._payout;
    if (r && r.score === score) {
      return PLACE_COINS[r.place] + 6 * r.laps + (r.fastest ? 12 : 0) + 2 * Math.min(r.boxes, 6);
    }
    const place = clamp(7 - Math.floor(Math.max(0, score) / 1000), 1, 6);
    return PLACE_COINS[place];
  }

  /**
   * §5 — read the handshake speedway.js parked on the game object. Anything
   * malformed degrades to a practice run rather than breaking the minigame.
   */
  _readCtx() {
    const ctx = this.game.__kartCtx;
    this.ctxRef = ctx || null;
    const grid = ctx && (Array.isArray(ctx.grid) ? ctx.grid : ctx.grid?.slots);
    if (!ctx || !Array.isArray(grid) || !grid.length) return null;
    const you = Number(ctx.you?.slot ?? ctx.grid?.you?.slot ?? ctx.slot);
    if (!Number.isFinite(you)) return null;
    const startAt = Number(ctx.startAt ?? ctx.grid?.startAt);
    return {
      race: String(ctx.race ?? ctx.grid?.race ?? ''),
      slots: grid.slice(0, 6),
      you: clamp(Math.round(you), 0, 5),
      startAt: Number.isFinite(startAt) ? startAt : 0,
      // skew is refined the moment our own kart-go lands
      skew: Number.isFinite(ctx.skew) ? ctx.skew : 0,
      goSeen: false,
      ended: false,
      sendAcc: 0,
      tick: -1,
    };
  }

  /** Roster rows, from the server grid in a race or rolled locally otherwise. */
  _roster() {
    if (this.net) {
      return this.net.slots.map((s, i) => ({
        slot: Number.isFinite(s?.slot) ? s.slot : i,
        id: s?.id ?? null,
        ai: !!s?.ai,
        name: String(s?.name || AI_NAMES[i % AI_NAMES.length]).slice(0, 16),
        color: Number.isFinite(s?.color) ? s.color : BODY_COLORS[i % BODY_COLORS.length],
        hat: typeof s?.hat === 'string' ? s.hat : 'none',
        skill: clamp(Math.round(Number(s?.skill) || 0), 0, 4),
      }));
    }
    // practice: pole is ours, the rest are five cozy locals on descending skill
    const me = {
      slot: 0, id: 'me', ai: false,
      name: String(this.game.state.name || 'You').slice(0, 16),
      color: this.game.state.color ?? BODY_COLORS[0],
      hat: this.game.state.hat ?? 'none',
      skill: 0,
    };
    const pool = AI_NAMES.filter((n) => n.toLowerCase() !== me.name.toLowerCase());
    const rows = [me];
    for (let i = 0; i < 5; i++) {
      const pick = Math.floor(this.rng() * pool.length);
      rows.push({
        slot: i + 1,
        id: null,
        ai: true,
        name: pool.splice(pick, 1)[0] || AI_NAMES[i],
        color: BODY_COLORS[(2 + i * 3) % BODY_COLORS.length],
        hat: AI_HATS[(i + 1) % AI_HATS.length],
        skill: 4 - i,
      });
    }
    return rows;
  }

  // -------------------------------------------------------------------- dom -
  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  _buildDom(root) {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    this.styleEl = style;

    const wrap = document.createElement('div');
    wrap.className = 'mg-kart-wrap';
    root.appendChild(wrap);
    this.wrap = wrap;

    const vig = document.createElement('div');
    vig.className = 'mg-kart-vig';
    wrap.appendChild(vig);
    this.vig = vig;

    const flash = document.createElement('div');
    flash.className = 'mg-kart-flash';
    wrap.appendChild(flash);
    this.flash = flash;
    this._on(flash, 'animationend', () => { flash.className = 'mg-kart-flash'; });

    const hud = document.createElement('div');
    hud.className = 'mg-kart-hud';
    hud.innerHTML = `
      <div class="mg-kart-panel mg-kart-pos">
        <div class="mg-kart-lbl">Position</div>
        <div class="mg-kart-place"><b data-f="place">1st</b><span>of 6</span></div>
        <div class="mg-kart-order" data-f="order"></div>
      </div>
      <div class="mg-kart-panel mg-kart-lap">
        <div class="mg-kart-lbl">Lap</div>
        <div class="mg-kart-lapn"><b data-f="lap">1</b><span>/${LAPS}</span></div>
        <div class="mg-kart-time" data-f="time">0:00.00</div>
        <div class="mg-kart-best" data-f="bestlap">best --:--</div>
      </div>
      <div class="mg-kart-item" data-f="item">
        <div data-f="icon"></div>
        <div class="mg-kart-use" data-f="use">E to use</div>
      </div>
      <div class="mg-kart-map"><canvas data-f="map" width="148" height="148"></canvas></div>
      <div class="mg-kart-lights" data-f="lights"></div>
      <div class="mg-kart-pops" data-f="pops"></div>`;
    wrap.appendChild(hud);
    this.hud = hud;
    this.f = {};
    hud.querySelectorAll('[data-f]').forEach((el) => { this.f[el.dataset.f] = el; });
    this.bulbs = [];
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('div');
      b.className = 'mg-kart-bulb';
      this.f.lights.appendChild(b);
      this.bulbs.push(b);
    }
    this.mapCtx = this.f.map.getContext('2d');

    const tags = document.createElement('div');
    tags.className = 'mg-kart-tags';
    wrap.appendChild(tags);
    this.tagHost = tags;

    const big = document.createElement('div');
    big.className = 'mg-kart-big';
    wrap.appendChild(big);
    this.bigEl = big;

    const tip = document.createElement('div');
    tip.className = 'mg-kart-tip';
    tip.textContent = 'W to go  .  A/D to steer  .  hold Shift into a corner to drift  .  E throws your item';
    tip.style.opacity = '0';
    wrap.appendChild(tip);
    this.tip = tip;

    const quit = document.createElement('button');
    quit.className = 'mg-kart-quit';
    quit.type = 'button';
    quit.innerHTML = 'Quit race<b>ESC</b>';
    // pointerdown, not click: the one control that must never miss a press
    this._on(quit, 'pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._confirmQuit();
    });
    wrap.appendChild(quit);
    this.quitBtn = quit;

    this.cardHost = document.createElement('div');
    this.cardHost.className = 'mg-kart-cards';
    wrap.appendChild(this.cardHost);
  }

  /**
   * Remove on animationend OR after `ms`, whichever lands first. `animationend`
   * alone is not enough: a backgrounded tab, a compositor stall or a
   * reduced-motion setting can swallow it, and a leftover `.mg-kart-card` spans
   * the whole screen with pointer-events on — it would eat every click,
   * including Quit. The timer is the guarantee; the event is the polish.
   */
  _autoRemove(el, ms) {
    let gone = false;
    const kill = () => {
      if (gone) return;
      gone = true;
      clearTimeout(id);
      el.remove();
      const i = this._timers.indexOf(id);
      if (i >= 0) this._timers.splice(i, 1);
    };
    const id = setTimeout(kill, ms);
    this._timers.push(id);
    el.addEventListener('animationend', kill);
  }

  _clearCard() {
    if (!this.card) return;
    const c = this.card;
    this.card = null;
    c.classList.add('out');
    this._autoRemove(c, 500);
  }

  _popup(text, cls = '') {
    if (!this.f?.pops) return;
    const el = document.createElement('div');
    el.className = `mg-kart-pop ${cls}`;
    el.textContent = text;
    el.style.left = `${(Math.random() - 0.5) * 130}px`;
    el.style.top = `${(Math.random() - 0.5) * 40}px`;
    this.f.pops.appendChild(el);
    this._autoRemove(el, 1400);
  }

  _big(text, go) {
    const el = document.createElement('div');
    el.className = `mg-kart-num${go ? ' go' : ''}`;
    el.textContent = text;
    this.bigEl.appendChild(el);
    this._autoRemove(el, 1200);
  }

  _banner(text) {
    const el = document.createElement('div');
    el.className = 'mg-kart-banner';
    el.textContent = text;
    this.bigEl.appendChild(el);
    this._autoRemove(el, 2300);
  }

  _flashFx(kind) {
    this.flash.className = 'mg-kart-flash';
    void this.flash.offsetWidth;
    this.flash.className = `mg-kart-flash ${kind}`;
  }

  /** §6 — instructions splash with a visual legend. */
  _showSplash() {
    const racing = !!this.net;
    const best = this.game.state.bests?.kart || 0;
    const rows = this.karts.map((k) => `
      <div class="mg-kart-grow${k === this.me ? ' me' : ''}">
        <span class="n">P${k.slot + 1}</span><i style="background:${hex6(k.color)}"></i>
        <span>${esc(k.name)}</span><b>${k === this.me ? 'you' : k.ai ? 'local racer' : ''}</b>
      </div>`).join('');
    const card = document.createElement('div');
    card.className = 'mg-kart-card';
    card.innerHTML = `
      <div class="mg-kart-box">
        <div class="mg-kart-title">${racing ? 'Grid is set' : 'Capy Karts'}</div>
        <div class="mg-kart-sub">Three laps of Capy Speedway. Mind the melon.</div>
        <div class="mg-kart-keys">
          <span class="mg-kart-key">W<u>go</u></span>
          <span class="mg-kart-key">S<u>brake</u></span>
          <span class="mg-kart-key">A D<u>steer</u></span>
          <span class="mg-kart-key">SHIFT<u>drift</u></span>
          <span class="mg-kart-key">E<u>item</u></span>
          <span class="mg-kart-key">Q<u>look back</u></span>
        </div>
        <div class="mg-kart-rules">
          <div class="mg-kart-rule"><span class="mg-kart-swatch" style="background:#4fb3e8"></span>
            Hold drift through a corner. Sparks go sky blue, then gold, then coral:
            let go on coral for the longest boost.</div>
          <div class="mg-kart-rule"><span class="mg-kart-swatch" style="background:#7ac74f"></span>
            Drive through a paw box for a melon peel, a splash bubble or a zoom berry.</div>
          <div class="mg-kart-rule"><span class="mg-kart-swatch" style="background:#f0dca0"></span>
            The sand slows you down. The tyres are softer than they look.</div>
        </div>
        ${racing ? `<div class="mg-kart-grid">${rows}</div>` : ''}
        <div class="mg-kart-sub">Best race score: <b>${best.toLocaleString()}</b></div>
        <div class="mg-kart-btns">
          ${racing ? '' : '<button class="mg-kart-btn" data-a="go">Roll out</button>'}
          <button class="mg-kart-btn ghost" data-a="back">${racing ? 'Withdraw' : 'Back to the paddock'}</button>
        </div>
        <div class="mg-kart-blink">${racing ? 'the lights are coming on' : 'or press any key'}</div>
      </div>`;
    this.cardHost.appendChild(card);
    this.card = card;
    const go = card.querySelector('[data-a="go"]');
    if (go) go.onclick = () => this._beginCountdown();
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.quit();
    };
  }

  // ------------------------------------------------------------------ scene -
  _buildScene() {
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'mg-kart-gl';
    this.wrap.insertBefore(this.renderer.domElement, this.vig);

    const scene = new THREE.Scene();
    this.scene = scene;
    scene.background = new THREE.Color(FOG_COL);
    scene.fog = new THREE.Fog(FOG_COL, 120, 460);

    this.camera = new THREE.PerspectiveCamera(62, w / h, 0.4, 1200);
    this.fov = 62;

    scene.add(new THREE.HemisphereLight(0xfff3d8, 0x9ec8b0, 1.15));
    const sun = new THREE.DirectionalLight(0xfff2d4, 1.55);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;                    // §6: exactly one shadow caster
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 260;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0012;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;
    const rim = new THREE.DirectionalLight(0xa8dcff, 0.4);
    rim.position.set(-40, 30, -60);
    scene.add(rim);

    this.sky = buildSky();
    scene.add(this.sky);

    const vc = makeToon(0xffffff, { vertexColors: true });
    this.vcMat = vc;

    // ---- ground: sand plate + a sea ring beyond it -------------------------
    const sand = new THREE.Mesh(new THREE.CircleGeometry(300, 40), makeToon(SAND));
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(7, -0.06, -17);
    sand.receiveShadow = true;
    scene.add(sand);
    this.geos.push(sand.geometry);

    const sea = new THREE.Mesh(new THREE.RingGeometry(298, 900, 48), makeToon(SEA));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(7, -0.6, -17);
    scene.add(sea);
    this.geos.push(sea.geometry);
    this.sea = sea;

    // ---- the circuit: three merged ribbons (§6) ----------------------------
    const t = this.track;
    for (const bands of [apronBands(), kerbBands(), roadBands(t)]) {
      const g = buildRibbon(t, bands);
      const m = new THREE.Mesh(g, vc);
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      this.geos.push(g);
    }

    this._buildDecor();
    this._buildPools();
  }

  /** Everything trackside, one InstancedMesh per family (§2). */
  _buildDecor() {
    const t = this.track;
    const scene = this.scene;
    const vc = this.vcMat;
    const rng = mulberry32(0xca9b0a);
    const p = [0, 0];

    const family = (geo, cap, mat = vc) => {
      const im = new THREE.InstancedMesh(geo, mat, cap);
      im.count = 0;
      im.frustumCulled = false;
      scene.add(im);
      this.geos.push(geo);
      return im;
    };
    const put = (im, x, y, z, ry, s) => {
      if (im.count >= im.instanceMatrix.count) return;
      _eu.set(0, ry, 0);
      _q4.setFromEuler(_eu);
      _v3b.set(x, y, z);
      _sc.set(s, s, s);
      _m4.compose(_v3b, _q4, _sc);
      im.setMatrixAt(im.count++, _m4);
    };

    // barrier tyre stacks along both edges, every 7 units
    const tyres = family(tyreGeo(), 220);
    const stepI = Math.max(2, Math.round(7 / t.step));
    for (let i = 0; i < t.n; i += stepI) {
      for (const side of [-1, 1]) {
        t.edge(i, side * WALL_LAT * t.hw[i], p);
        put(tyres, p[0], 0, p[1], t.ang[i], 1);
      }
    }
    tyres.castShadow = true;
    tyres.instanceMatrix.needsUpdate = true;

    // palms and hay bales scattered outside the barrier
    const palms = family(palmGeo(), 90);
    const bales = family(baleGeo(), 60);
    for (let i = 0; i < t.n; i += 5) {
      const side = rng() < 0.5 ? -1 : 1;
      if (rng() < 0.55) {
        t.edge(i, side * (WALL_LAT * t.hw[i] + 4 + rng() * 9), p);
        put(palms, p[0], 0, p[1], rng() * 6.28, 0.8 + rng() * 0.5);
      }
      if (rng() < 0.22) {
        t.edge(i, side * (WALL_LAT * t.hw[i] + 2.2), p);
        put(bales, p[0], 0, p[1], t.ang[i] + Math.PI / 2, 1);
      }
    }
    palms.castShadow = true;
    palms.instanceMatrix.needsUpdate = true;
    bales.castShadow = true;
    bales.instanceMatrix.needsUpdate = true;

    // bunting arches over the road at a handful of landmarks
    const arches = family(archGeo(), 10);
    for (const q of [0.08, 0.3, 0.47, 0.63, 0.86]) {
      const s = t.at(q * LAP_UNITS + S_FIN, this._tmp);
      const scale = s.hw / 5.6;
      put(arches, s.x, 0, s.z, Math.PI / 2 - s.ang, clamp(scale, 0.8, 1.4));
    }
    arches.instanceMatrix.needsUpdate = true;

    // Crowd rows. A spectator must FACE the road, so local +z is aimed along
    // -side*N: ry = pi - ang on the +N side, -ang on the -N side.
    const crowd = family(crowdGeo(0xb08a5a), 130);
    const crowdSpots = [[0.90, 0.06, 30, -1], [0.50, 0.60, 22, 1], [0.27, 0.34, 16, -1]];
    for (const [qa, qb, n, side] of crowdSpots) {
      for (let i = 0; i < n; i++) {
        const q = qa + (qb - qa) * (i / n);
        const s = t.at(frac1(q) * LAP_UNITS + S_FIN, this._tmp);
        const row = i % 4;
        const dd = t.safeOffset(side * (s.hw * WALL_LAT + 3.6 + row * 1.5), s.curv);
        put(crowd, s.x - Math.sin(s.ang) * dd + rng() - 0.5,
          0.28 + row * 0.55, s.z + Math.cos(s.ang) * dd + rng() - 0.5,
          side > 0 ? Math.PI - s.ang : -s.ang, 0.9 + rng() * 0.3);
      }
    }
    crowd.instanceMatrix.needsUpdate = true;
    this.crowd = crowd;

    // Grandstand steps under the main-straight crowd. standGeo runs along local
    // +x and steps back in -z, so it is aimed along the tangent: ry = -ang.
    const stand = new THREE.Mesh(standGeo(64), vc);
    const sMain = t.at(0.96 * LAP_UNITS + S_FIN, this._tmp);
    const standOff = t.safeOffset(-(sMain.hw * WALL_LAT + 3.4), sMain.curv);
    stand.position.set(
      sMain.x - Math.sin(sMain.ang) * standOff, 0,
      sMain.z + Math.cos(sMain.ang) * standOff,
    );
    stand.rotation.y = -sMain.ang;
    stand.receiveShadow = true;
    scene.add(stand);
    this.geos.push(stand.geometry);

    // gulls, animated in _updateDecor
    const gulls = family(gullGeo(), 16, makeToon(0xffffff, { vertexColors: true }));
    gulls.count = 14;
    this.gulls = gulls;
    this.gullSeeds = [];
    for (let i = 0; i < 14; i++) {
      this.gullSeeds.push({
        x: rng() * 260 - 120, z: rng() * 220 - 110, y: 14 + rng() * 16,
        r: 12 + rng() * 26, a: rng() * 6.28, sp: 0.25 + rng() * 0.4, flap: rng() * 6.28,
        scare: 0,
      });
    }

    // start gantry over the line, and the lighthouse out on the coastal run
    const fin = t.at(S_FIN, this._tmp);
    const gantry = new THREE.Mesh(gantryGeo(fin.hw * 1.6), vc);
    gantry.position.set(fin.x, 0, fin.z);
    gantry.rotation.y = Math.PI / 2 - fin.ang;
    scene.add(gantry);
    this.geos.push(gantry.geometry);

    const coast = t.at(0.15 * LAP_UNITS + S_FIN, this._tmp);
    const lhOff = t.safeOffset(-34, coast.curv);
    const lh = new THREE.Mesh(lighthouseGeo(), vc);
    lh.position.set(
      coast.x - Math.sin(coast.ang) * lhOff, 0,
      coast.z + Math.cos(coast.ang) * lhOff,
    );
    lh.castShadow = true;
    scene.add(lh);
    this.geos.push(lh.geometry);
    this.lighthouse = lh;
  }

  /** Item boxes, hazards, projectiles and every particle pool. */
  _buildPools() {
    const scene = this.scene;
    const vc = this.vcMat;

    const glow = (cap, geo) => {
      const mat = makeGlow(0xffffff, { unique: true });
      mat.vertexColors = true;
      mat.transparent = true;
      mat.opacity = 0.95;
      mat.depthWrite = false;
      this.mats.push(mat);
      const im = new THREE.InstancedMesh(geo, mat, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      scene.add(im);
      this.geos.push(geo);
      return im;
    };

    this.boxIM = new THREE.InstancedMesh(boxGeo(), vc, BOXES.length);
    this.boxIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxIM.count = 0;
    this.boxIM.frustumCulled = false;
    scene.add(this.boxIM);
    this.geos.push(this.boxIM.geometry);

    this.hazIM = new THREE.InstancedMesh(peelGeo(), vc, 30);
    this.hazIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.hazIM.count = 0;
    this.hazIM.frustumCulled = false;
    scene.add(this.hazIM);
    this.geos.push(this.hazIM.geometry);

    const bubMat = makeToon(0xffffff, { vertexColors: true, transparent: true, opacity: 0.7, unique: true });
    this.mats.push(bubMat);
    this.projIM = new THREE.InstancedMesh(bubbleGeo(), bubMat, 10);
    this.projIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projIM.count = 0;
    this.projIM.frustumCulled = false;
    scene.add(this.projIM);
    this.geos.push(this.projIM.geometry);

    this.pfx = glow(240, new THREE.OctahedronGeometry(0.5, 0));
    this.sparkIM = glow(60, new THREE.TetrahedronGeometry(0.4, 0));
    this.confIM = glow(120, new THREE.BoxGeometry(0.3, 0.3, 0.06));

    // speed lines live in camera space so they always streak past the lens
    const lineGeo = new THREE.PlaneGeometry(0.03, 1.6);
    const lineMat = makeGlow(0xffffff, { unique: true });
    lineMat.transparent = true;
    lineMat.opacity = 0;
    lineMat.depthWrite = false;
    lineMat.depthTest = false;
    lineMat.fog = false;
    this.mats.push(lineMat);
    this.lineMat = lineMat;
    this.lines = new THREE.InstancedMesh(lineGeo, lineMat, 24);
    this.lines.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 9;
    this.camera.add(this.lines);
    this.scene.add(this.camera);
    this.geos.push(lineGeo);
    this.lineSeeds = [];
    for (let i = 0; i < 24; i++) {
      this.lineSeeds.push({ a: Math.random() * 6.28, r: 0.5 + Math.random() * 1.5, z: Math.random() });
    }
  }

  // ------------------------------------------------------------------ karts -
  /**
   * One geometry set, six instances per part (§6). The racer's colour rides
   * `instanceColor` on the shell family only, so wheels, seats and bumpers keep
   * their own palette. The driver is a real avatar parented to a per-kart anchor
   * whose transform also feeds the instanced parts.
   */
  _buildKarts() {
    const scene = this.scene;
    const roster = this._roster();
    const N = roster.length;

    const shellMat = makeToon(0xffffff, { unique: true });
    this.mats.push(shellMat);
    this.bodyIM = new THREE.InstancedMesh(kartBodyGeo(), shellMat, N);
    this.bodyIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3).fill(1), 3);
    this.trimIM = new THREE.InstancedMesh(kartTrimGeo(), this.vcMat, N);
    this.wheelIM = new THREE.InstancedMesh(wheelGeo(), this.vcMat, N * 4);
    for (const im of [this.bodyIM, this.trimIM, this.wheelIM]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = true;
      im.count = 0;
      scene.add(im);
      this.geos.push(im.geometry);
    }

    const roundG = roundelGeo();
    this.geos.push(roundG);
    this.roundGeo = roundG;

    this.karts = [];
    for (const r of roster) {
      const anchor = new THREE.Group();      // world transform of the kart
      const tilt = new THREE.Group();        // lean + drift roll
      anchor.add(tilt);
      scene.add(anchor);

      const driver = createAvatar({ color: r.color, hat: r.hat });
      driver.group.scale.setScalar(0.85);
      driver.group.position.set(0, 0.5, -0.18);
      driver.setAnim('sit');
      tilt.add(driver.group);

      const tex = roundelTex(r.slot + 1, r.color);
      const rMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
      this.texs.push(tex);
      this.mats.push(rMat);
      const roundel = new THREE.Mesh(roundG, rMat);
      tilt.add(roundel);

      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.95, 14),
        new THREE.MeshBasicMaterial({ color: 0x4a3a2a, transparent: true, opacity: 0.24, depthWrite: false }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.03;
      anchor.add(shadow);
      this.geos.push(shadow.geometry);
      this.mats.push(shadow.material);

      const tag = document.createElement('div');
      tag.className = 'mg-kart-tag';
      tag.innerHTML = `<i style="background:${hex6(r.color)}"></i><span>${esc(r.name)}</span><u data-f="g"></u>`;
      this.tagHost.appendChild(tag);

      this.karts.push({
        ...r,
        anchor, tilt, driver, roundel, shadow, tag, tagGap: tag.querySelector('[data-f="g"]'),
        // track-space state
        q: 0, lat: 0, yaw: 0, v: 0, laps: 0, heading: 0, velAng: 0,
        // control + feel
        steer: 0, drift: 0, driftDir: 0, charge: 0, tier: 0, lowT: 0, offT: 0,
        boostT: 0, boostTarget: 0, spinT: 0, soakT: 0, wallT: 0, wheelSpin: 0,
        item: null, itemAt: 0, boxes: 0, cp: 0, crossed: false, _pq: 0,
        ghost: false, finished: false, place: 0, onPodium: false,
        lapMs: [], lapStart: 0, bestLap: 0, finishMs: 0,
        // ai
        bias: 0, biasTo: 0, biasAt: 0, aiItem: null, aiUseAt: 0,
        // remote interpolation buffer
        buf: [], seen: false, engine: null,
      });
    }
    this.me = this.karts[this.net ? this.net.you : 0] || this.karts[0];
    this.me.tag.remove();
    this.me.tag = null;
    // our own kart never needs a shadow blob drawn under the camera-facing hood
    this._buildMinimapBase();
  }

  /** §2 grid: three staggered rows just behind the line. */
  _resetRace() {
    const rows = [LAP_UNITS - 6, LAP_UNITS - 13, LAP_UNITS - 20];
    for (const k of this.karts) {
      const u = rows[Math.floor(k.slot / 2)] ?? rows[2];
      k.q = u / LAP_UNITS;
      k.lat = k.slot % 2 === 0 ? -0.47 : 0.47;
      k.yaw = 0;
      k.v = 0;
      k.laps = 0;
      k.heading = this.track.angleAt(k.q * LAP_UNITS + S_FIN);
      k.velAng = k.heading;
      k.steer = 0; k.drift = 0; k.driftDir = 0; k.charge = 0; k.tier = 0;
      k.lowT = 0; k.offT = 0; k.boostT = 0; k.boostTarget = 0;
      k.spinT = 0; k.soakT = 0; k.wallT = 0; k.wheelSpin = 0;
      k.item = null; k.itemAt = 0; k.boxes = 0;
      k.finished = false; k.place = 0; k.lapMs = []; k.lapStart = 0;
      k.bestLap = 0; k.finishMs = 0; k.buf.length = 0; k.seen = !this.net;
      k.bias = 0; k.biasTo = (this.rng() - 0.5) * 0.9; k.biasAt = 0;
      k.aiItem = null; k.aiUseAt = 0;
      k.cp = 0;
      k.crossed = false;
      k._pq = k.q;
      k.onPodium = false;
      k.anchor.visible = true;
    }
    this.boxes = BOXES.map((b, i) => ({ i, q: b[0], lat: b[1], live: true, respawnAt: 0, cool: 0 }));
    this.hazards.clear();
    this.projectiles.clear();
    this.parts.length = 0;
    this.sparks.length = 0;
    this.confetti.length = 0;
    this.results = null;
    this._payout = null;
    this.raceMs = 0;
    this.preHold = 0;
    this.bogT = 0;
    this.rocketArmed = false;
    this.finalLapShown = false;
    this.shake = 0;
    this.roll = 0;
    this.lookBack = false;
    this.hudCache = {};
    this.spinLock = 0;
    this._camInit = false;
    this._placeOf = new Map();
    this._layoutKarts(0);
    this._showSplash();
  }

  // ------------------------------------------------------------------ input -
  _bindInput() {
    // every key we own is swallowed before the world hotkeys (D = dance) see it
    const OWNED = new Set(['w', 'a', 's', 'd', 'q', 'e', 'W', 'A', 'S', 'D', 'Q', 'E',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'Shift']);

    this._on(window, 'keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        this._confirmQuit();
        return;
      }
      if (OWNED.has(e.key)) { e.preventDefault(); e.stopPropagation(); }
      if (this.phase === 'splash' && !e.repeat && !this.net) { this._beginCountdown(); return; }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.add(k);
      if (k === 'e' && !e.repeat) this._useItem();
      if (k === 'q') this.lookBack = true;
      this.pointerSteer = false;
    }, true);

    this._on(window, 'keyup', (e) => {
      if (OWNED.has(e.key)) e.stopPropagation();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
      if (k === 'q') this.lookBack = false;
    }, true);

    // a held modifier that is released while the tab is hidden never fires keyup
    this._on(window, 'blur', () => this.keys.clear());

    this._on(this.wrap, 'pointermove', (e) => {
      const r = this.wrap.getBoundingClientRect();
      const t = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
      this.pointerX = Math.abs(t) < 0.06 ? 0 : clamp(t, -1, 1); // 6% deadzone
      this.pointerSteer = true;
    });
    this._on(this.wrap, 'pointerdown', (e) => {
      if (e.target !== this.renderer.domElement) return;
      if (this.phase === 'splash') { if (!this.net) this._beginCountdown(); return; }
      if (e.button === 0) this.mouseGas = true;
      if (e.button === 2) this._useItem();
    });
    this._on(window, 'pointerup', (e) => { if (e.button === 0) this.mouseGas = false; });
    this._on(this.wrap, 'contextmenu', (e) => e.preventDefault());
    this._on(window, 'resize', () => this._resize());
  }

  _resize() {
    if (!this.renderer) return;
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;
    this.vw = w;
    this.vh = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _confirmQuit() {
    this.game.audio?.play?.('click');
    if (this.phase === 'splash' || this.phase === 'results' || this._quitAsked) {
      this.quit();
      return;
    }
    this._quitAsked = true;
    this.game.toast?.('Press Esc again to leave the race.', 2600);
    setTimeout(() => { this._quitAsked = false; }, 2600);
  }

  // -------------------------------------------------------------------- net -
  /**
   * The client re-emits every kart-* frame through `game.events` (see the
   * orchestrator insertion in src/net/client.js); this is the only place that
   * reads them, exactly the way sled.js reads race-state.
   */
  _bindNet() {
    if (!this.net) return;
    const ev = this.game.events;
    if (!ev?.on) return;
    const sub = (name, fn) => this.subs.push(ev.on(name, (m) => {
      if (this.disposed) return;
      try { fn(m); } catch { /* one bad frame must never stop the race */ }
    }));
    sub('kart-go', (m) => this._onGo(m));
    sub('kart-state', (m) => this._onState(m));
    sub('kart-item', (m) => this._onItem(m));
    sub('kart-box', (m) => this._onBox(m));
    sub('kart-haz', (m) => this._onHaz(m));
    sub('kart-hit', (m) => this._onHit(m));
    sub('kart-fx', (m) => this._onFx(m));
    sub('kart-lap', (m) => this._onLap(m));
    sub('kart-fin', (m) => this._onFin(m));
    sub('kart-end', (m) => this._onEnd(m));
    sub('kart-resume', (m) => this._onResume(m));
    if (this.net.startAt) this._armStart(this.net.startAt, Date.now() + this.net.skew);
  }

  _mine(m) { return !this.net || !m?.race || m.race === this.net.race; }
  _bySlot(s) { return this.karts.find((k) => k.slot === s) || null; }

  /**
   * §4.3 — count down to `startAt` on the SERVER clock. `now` is the server's
   * stamp at send, so `now - Date.now()` at receipt is our skew estimate and the
   * green light lands within one round trip of everyone else's.
   */
  _armStart(startAt, serverNow) {
    const skew = Number(serverNow) - Date.now();
    this.skew = Number.isFinite(skew) ? skew : 0;
    const inMs = Number(startAt) - (Date.now() + this.skew);
    this.startAt = performance.now() + inMs;
    if (this.phase === 'splash') this._beginCountdown(true);
  }

  _onGo(m) {
    if (!this._mine(m) || !this.net) return;
    this.net.goSeen = true;
    this._armStart(m.startAt, m.now);
  }

  /** §4.4 — 10Hz snapshot. `s` (the grid slot) is the in-race identity. */
  _onState(m) {
    if (!this._mine(m) || !Array.isArray(m.k)) return;
    const now = performance.now();
    if (Number.isFinite(m.tick)) {
      if (m.tick <= this.net.tick) return;   // a late duplicate must not rewind
      this.net.tick = m.tick;
    }
    for (const row of m.k) {
      const k = this._bySlot(row?.s);
      if (!k) continue;
      k.ghost = !!row.ghost;
      k.item = k === this.me ? k.item : (row.it || null);
      if (Number.isFinite(row.l)) k.laps = Math.max(k.laps, row.l);
      if (k === this.me) continue;           // our own kart is client-simulated
      if (!Number.isFinite(row.q) || !Number.isFinite(row.lat)) continue;
      k.buf.push({
        t: now, q: frac1(row.q), lat: clamp(row.lat, -2, 2),
        yaw: Number.isFinite(row.yaw) ? row.yaw : 0,
        v: Number.isFinite(row.v) ? row.v : 0,
        d: row.d | 0,
      });
      if (k.buf.length > 8) k.buf.shift();
      k.seen = true;
    }
    // hazards and projectiles are server-owned in a race: mirror them wholesale
    if (Array.isArray(m.hz)) this._syncHazards(m.hz);
    if (Array.isArray(m.pr)) this._syncProjectiles(m.pr);
  }

  _syncHazards(list) {
    const keep = new Set();
    for (const h of list) {
      if (!h || !Number.isFinite(h.q)) continue;
      keep.add(h.i);
      const cur = this.hazards.get(h.i);
      if (cur) { cur.q = h.q; cur.lat = h.lat; } else {
        this.hazards.set(h.i, { i: h.i, kind: 'peel', q: frac1(h.q), lat: h.lat || 0, by: h.by, at: this.time });
      }
    }
    // hz only carries peels within dq <= 0.25 ahead of us, so a hazard falling
    // out of the window is out of sight, not gone: age it out rather than
    // deleting, or a peel behind us would pop back into existence on approach.
    for (const [i, h] of this.hazards) if (!keep.has(i)) h.stale = true; else h.stale = false;
  }

  _syncProjectiles(list) {
    const keep = new Set();
    for (const p of list) {
      if (!p || !Number.isFinite(p.q)) continue;
      keep.add(p.i);
      const cur = this.projectiles.get(p.i);
      if (cur) { cur.q = frac1(p.q); cur.lat = p.lat || 0; } else {
        this.projectiles.set(p.i, { i: p.i, q: frac1(p.q), lat: p.lat || 0, by: p.by, at: this.time });
      }
    }
    for (const i of [...this.projectiles.keys()]) if (!keep.has(i)) this.projectiles.delete(i);
  }

  _onItem(m) {
    if (!this._mine(m)) return;
    const item = ITEM_ORDER.includes(m.item) ? m.item : null;
    if (!item) return;
    this._grantItem(item, m.box);
  }

  _onBox(m) {
    if (!this._mine(m) || !Number.isFinite(m.box)) return;
    const b = this.boxes[m.box];
    if (!b) return;
    b.live = !m.taken;
    b.cool = 0;
    if (m.taken) this._puff(b, 0xfff3d2);
  }

  _onHaz(m) {
    if (!this._mine(m) || !Number.isFinite(m.i)) return;
    if (m.gone) { this.hazards.delete(m.i); this.projectiles.delete(m.i); return; }
    if (m.kind === 'peel') {
      this.hazards.set(m.i, {
        i: m.i, kind: 'peel', q: frac1(Number(m.q) || 0), lat: Number(m.lat) || 0,
        by: m.by, at: this.time,
      });
    }
  }

  /** §4 decision 1 — the ONLY place a penalty is applied in a race. */
  _onHit(m) {
    if (!this._mine(m)) return;
    const k = this._bySlot(m.s);
    if (!k) return;
    this.hazards.delete(m.i);
    this.projectiles.delete(m.i);
    this._applyHit(k, m.kind === 'bubble' ? 'bubble' : 'peel', Number(m.ms) || 0);
  }

  _onFx(m) {
    if (!this._mine(m)) return;
    const k = this._bySlot(m.s);
    if (!k) return;
    if (m.kind === 'boost') {
      if (k === this.me) this._applyBoost((Number(m.ms) || BERRY_MS) / 1000, BERRY_TARGET);
      this._boostFx(k);
    }
  }

  _onLap(m) {
    if (!this._mine(m)) return;
    const k = this._bySlot(m.s);
    if (!k) return;
    const lap = clamp(Math.round(Number(m.lap) || 0), 1, LAPS);
    k.laps = Math.max(k.laps, lap);
    const ms = Number(m.ms) || 0;
    const split = ms - (k.lapMs.length ? k.lapMs[k.lapMs.length - 1] : 0);
    k.lapMs.push(ms);
    if (split > 0 && (!k.bestLap || split < k.bestLap)) k.bestLap = split;
    if (k === this.me) this._onMyLap(lap, split, !!m.best);
  }

  _onFin(m) {
    if (!this._mine(m)) return;
    const k = this._bySlot(m.s);
    if (!k) return;
    k.finished = true;
    k.place = clamp(Math.round(Number(m.place) || 6), 1, 6);
    k.finishMs = Number(m.ms) || this.raceMs;
    if (k === this.me) this._onMyFinish();
  }

  _onEnd(m) {
    if (!this._mine(m)) return;
    if (this.net) this.net.ended = true;
    const rows = Array.isArray(m.results) ? m.results : [];
    this.results = rows
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        slot: r.s, name: String(r.name || 'Capy').slice(0, 16), ai: !!r.ai,
        place: clamp(Math.round(Number(r.place) || 6), 1, 6),
        ms: Number(r.ms) || 0, laps: clamp(Math.round(Number(r.laps) || 0), 0, LAPS),
        best: Number(r.best) || 0,
      }))
      .sort((a, b) => a.place - b.place);
    this._showResults();
  }

  /** §4.7 — same account, same race, inside 45s: control comes back. */
  _onResume(m) {
    if (!this.net || !m || (m.race && m.race !== this.net.race)) return;
    const slot = Number(m.you?.slot);
    if (Number.isFinite(slot)) {
      const k = this._bySlot(slot);
      if (k) this.me = k;
    }
    if (Number.isFinite(m.q)) this.me.q = frac1(m.q);
    // Contract §4.2: `lap` is laps COMPLETED, `laps` is the race total (3).
    // Reading m.laps here would teleport a resumer to the chequered flag.
    if (Number.isFinite(m.lap)) this.me.laps = clamp(Math.round(m.lap), 0, LAPS);
    this.me.ghost = false;
    this.me.v = 0;
    this.me.heading = this.track.angleAt(this.me.q * LAP_UNITS + S_FIN);
    this.me.velAng = this.me.heading;
    if (Number.isFinite(m.startAt)) {
      this.startAt = performance.now() + (Number(m.startAt) - (Date.now() + this.skew));
    }
    this._clearCard();
    this.phase = 'race';
    this.hud.classList.add('on');
    this.f.lights.classList.remove('on');
    this.game.toast?.('Back in the seat. Go go go!');
  }

  /** §4.4 — our own kart, 10Hz, on its own budget. */
  _sendIn(force) {
    const n = this.net;
    if (!n || this.phase !== 'race' || this.me.ghost) return;
    if (!force) {
      n.sendAcc += this.dtLast;
      if (n.sendAcc < 1 / SEND_HZ) return;
    }
    n.sendAcc = 0;
    const k = this.me;
    this.game.net?.send?.({
      t: 'kart-in',
      q: +k.q.toFixed(5),
      lat: +k.lat.toFixed(3),
      yaw: +k.yaw.toFixed(3),
      v: +k.v.toFixed(2),
      d: k.drift ? k.tier || 1 : 0,
      air: false,
    });
  }

  // ------------------------------------------------------------- lifecycle --
  _beginCountdown(fromServer = false) {
    if (this.phase !== 'splash') return;
    this.game.audio?.play?.('click');
    this._clearCard();
    this.phase = 'count';
    this.hud.classList.add('on');
    this.f.lights.classList.add('on');
    this.tip.style.opacity = '1';
    this._done = false;                       // each run reports itself
    this.lightStep = -1;
    if (!fromServer) this.startAt = performance.now() + KART_LIGHTS_MS;
    this._startEngines();
  }

  _startRace() {
    this.phase = 'race';
    this.raceMs = 0;
    for (const k of this.karts) k.lapStart = 0;
    this.f.lights.classList.remove('on');
    this._big('GO!', true);
    this.game.audio?.play?.('success');
    if (this.preHold > BOG_HOLD_MS / 1000) {
      // §3.4 bog: silly, not punishing
      this.bogT = BOG_MS / 1000;
      this._popup('bogged down!', 'bad');
      this.game.audio?.play?.('fail');
    } else {
      this.rocketArmed = true;
    }
  }

  _onMyLap(lap, split, personalBest) {
    if (lap >= LAPS) return;
    this.game.audio?.play?.('ding');
    this._popup(`Lap ${lap} . ${lapTime(split)}`, personalBest ? 'gold' : '');
    if (lap === LAPS - 1 && !this.finalLapShown) {
      this.finalLapShown = true;
      this._banner('FINAL LAP');
      this.game.audio?.play?.('whoosh');
      this._scareGulls();
    }
  }

  _onMyFinish() {
    if (this.phase !== 'race') return;
    this.phase = 'done';
    this.tip.style.opacity = '0';
    this._banner(`${ordinal(this.me.place)} PLACE`);
    this.game.audio?.play?.('success');
    this._confettiBurst(60);
    this._scareGulls();
    // practice has nobody to wait for once the field is home
    if (!this.net) this._maybeEndLocal(true);
  }

  /** Local (practice) finish bookkeeping — the server owns this in a race. */
  _localFinish(k) {
    if (k.finished) return;
    k.finished = true;
    k.finishMs = this.raceMs;
    k.place = this.karts.filter((o) => o.finished).length;
    if (k === this.me) this._onMyFinish();
  }

  /**
   * Practice has no server grace clock, so the board waits for the rostrum to
   * fill: as soon as three karts are home the podium is complete and there is
   * nothing left to see. A long tail still gets LOCAL_GRACE seconds before the
   * flag drops on it, and everyone home ends it instantly.
   */
  _maybeEndLocal(force) {
    if (this.net || this.results) return;
    const home = this.karts.filter((k) => k.finished).length;
    if (home >= this.karts.length) { this._endLocal(); return; }
    if (!this.me.finished && !force) return;
    if (home >= 3) { this._endLocal(); return; }
    if (!this._endTimer) {
      this._endTimer = setTimeout(() => { this._endTimer = 0; this._endLocal(); }, LOCAL_GRACE_MS);
    }
  }

  _endLocal() {
    if (this.results) return;
    const unfinished = this.karts.filter((k) => !k.finished)
      .sort((a, b) => this._progress(b) - this._progress(a));
    let next = this.karts.filter((k) => k.finished).length;
    for (const k of unfinished) { k.place = ++next; k.finishMs = this.raceMs; }
    this.results = this.karts.slice().sort((a, b) => a.place - b.place).map((k) => ({
      slot: k.slot, name: k.name, ai: k.ai, place: k.place,
      ms: k.finishMs, laps: k.laps, best: k.bestLap,
    }));
    this._showResults();
  }

  // ---------------------------------------------------------------- driving -
  _gasDown() {
    return this.keys.has('w') || this.keys.has('ArrowUp') || !!this.mouseGas;
  }

  /** Read throttle/brake/steer for this frame. Only called once racing. */
  _readInput() {
    const k = this.keys;
    let steer = (k.has('d') || k.has('ArrowRight') ? 1 : 0) - (k.has('a') || k.has('ArrowLeft') ? 1 : 0);
    if (!steer && this.pointerSteer) steer = this.pointerX || 0;
    return {
      gas: this._gasDown(),
      brake: k.has('s') || k.has('ArrowDown'),
      steer: clamp(steer, -1, 1),
      driftKey: k.has('Shift') || k.has(' ') || k.has('Spacebar'),
    };
  }

  /**
   * The player's kart. §3.1/§3.2 verbatim: the body chases the steering angle,
   * the velocity chases the body (slowly while drifting, which IS the slide),
   * and the world-space step is projected back into (q, lat, yaw).
   */
  _stepMe(dt) {
    const k = this.me;
    const inp = this._readInput();

    // ---- rocket start: only the first press inside the window counts --------
    if (this.rocketArmed && inp.gas) {
      this.rocketArmed = false;
      if (performance.now() - this.startAt <= ROCKET_WINDOW_MS) {
        this._applyBoost(ROCKET_MS / 1000, ROCKET_TARGET);
        this._popup('ROCKET START!', 'gold');
        this.game.audio?.play?.('whoosh');
      }
    }
    if (this.bogT > 0) this.bogT -= dt;
    if (this.rocketArmed && performance.now() - this.startAt > ROCKET_WINDOW_MS) this.rocketArmed = false;

    // ---- steering -----------------------------------------------------------
    const spun = k.spinT > 0;
    const want = spun ? 0 : inp.steer;
    k.steer = lerp(k.steer, want, ease(dt, STEER_EASE));
    const frac = Math.min(1, k.v / V_MAX);
    const steerMax = 2.6 * (1 - 0.55 * frac);

    // ---- drift entry / charge / release --------------------------------------
    this._stepDrift(k, dt, inp);

    let yawRate;
    if (k.drift) {
      yawRate = (0.55 + 0.45 * Math.abs(k.steer)) * 2.0 * k.driftDir;
    } else {
      yawRate = k.steer * steerMax;
    }
    if (spun) {
      // §3.3 peel: two full turns over the spin, steering locked
      k.spinT -= dt;
      yawRate = (Math.PI * 4) / (SPIN_MS / 1000);
      if (k.spinT <= 0) { k.spinT = 0; this._popup('recovered', ''); }
    }
    k.heading = wrapPi(k.heading + yawRate * dt);

    // ---- speed --------------------------------------------------------------
    const off = Math.abs(k.lat) > 1.0;
    let target = V_MAX;
    if (k.boostT > 0) { target = k.boostTarget; k.boostT -= dt; }
    if (k.soakT > 0) { target = Math.min(target, V_MAX * SOAK_MUL); k.soakT -= dt; }
    if (off) target *= OFF_MUL;
    if (this.bogT > 0) target = Math.min(target, BOG_V);

    let a;
    if (k.v > target + 0.05) {
      a = -COAST_DRAG;                                  // decay back to target
      if (inp.brake) a = -BRAKE;
    } else if (inp.gas && !spun) {
      a = ACCEL * (1 - k.v / Math.max(1, target));
      if (k.boostT > 0) a *= BOOST_ACCEL_MUL;
    } else if (inp.brake) {
      a = k.v > 0 ? -BRAKE : -REVERSE_ACCEL;
    } else {
      a = k.v > 0 ? -COAST_DRAG : COAST_DRAG;
    }
    if (off) a -= Math.sign(k.v || 1) * OFF_DRAG;
    k.v += a * dt;
    const floor = inp.brake ? -REVERSE_MAX : 0;
    k.v = clamp(k.v, floor, BOOST_CEIL);
    if (!inp.gas && !inp.brake && Math.abs(k.v) < 0.05) k.v = 0;

    // ---- grip: the velocity direction chases the facing ---------------------
    k.velAng = angLerp(k.velAng, k.heading, ease(dt, k.drift ? GRIP_DRIFT : GRIP));

    this._advance(k, dt, k.velAng, k.v);
    this._wall(k, dt, off);

    // ---- feel dressing -------------------------------------------------------
    k.wheelSpin += k.v * dt * 3;
    if (off && k.v > 3) {
      this.shake = Math.max(this.shake, 0.25 * clamp(k.v / V_MAX, 0, 1));
      if (Math.random() < dt * 26) this._dust(k, 0xe4cd90);
    }
    if (k.drift && k.v > 6 && Math.random() < dt * 30) this._dust(k, 0xdcd3c4);
  }

  /** §3.2 — direction locks at entry and cannot flip; three tiers, no fourth. */
  _stepDrift(k, dt, inp) {
    if (!k.drift) {
      if (inp.driftKey && k.v >= DRIFT_MIN_V && Math.abs(k.steer) >= DRIFT_MIN_STEER && !k.spinT) {
        k.drift = 1;
        k.driftDir = Math.sign(k.steer) || 1;
        k.charge = 0;
        k.tier = 0;
        k.lowT = 0;
        k.offT = 0;
      }
      return;
    }
    if (k.v >= DRIFT_MIN_V) k.charge = Math.min(DRIFT_TIERS[2].charge, k.charge + dt);
    let tier = 0;
    for (let i = 0; i < DRIFT_TIERS.length; i++) if (k.charge >= DRIFT_TIERS[i].charge - 1e-6) tier = i + 1;
    if (tier !== k.tier) {
      k.tier = tier;
      if (tier > 0) {
        this.game.audio?.play?.('pop');
        this._sparkBurst(k, DRIFT_TIERS[tier - 1].color, 14);
      }
    }
    // cancels: too slow, off-road too long, or knocked about
    k.lowT = k.v < 6 ? k.lowT + dt : 0;
    k.offT = Math.abs(k.lat) > 1.0 ? k.offT + dt : 0;
    if (k.lowT > 0.35 || k.offT > 0.5 || k.spinT > 0 || k.soakT > 0) { this._cancelDrift(k); return; }
    if (!inp.driftKey) this._releaseDrift(k);
  }

  _cancelDrift(k) {
    k.drift = 0;
    k.charge = 0;
    k.tier = 0;
  }

  _releaseDrift(k) {
    const tier = k.tier;
    this._cancelDrift(k);
    if (!tier) return;
    const T = DRIFT_TIERS[tier - 1];
    this._applyBoost(T.ms / 1000, T.target);
    this._sparkBurst(k, T.color, 26);
    this._boostFx(k);
    this.game.audio?.play?.('whoosh');
    // Capy Cove's own vocabulary, per the contract: never another game's terms
    this._popup(['', 'ZIP!', 'ZOOM!', 'COVE TURBO!'][tier], tier === 3 ? 'bad' : tier === 2 ? 'gold' : 'sky');
  }

  /** §3.2/§3.3 — boosts take the BETTER of the two, never the sum. */
  _applyBoost(sec, target) {
    const k = this.me;
    k.boostTarget = Math.min(BOOST_CEIL, Math.max(k.boostT > 0 ? k.boostTarget : 0, target));
    k.boostT = Math.max(k.boostT, sec);
    this.fovKick = 1;
  }

  _boostFx(k) {
    if (k === this.me) this._flashFx('boost');
    for (let i = 0; i < 14; i++) {
      this._spawnPart(k, rand(-0.5, 0.5), rand(0.2, 0.9), rand(-1.6, -0.9),
        0xffe28c, rand(0.22, 0.42), rand(0.3, 0.6));
    }
  }

  /**
   * Move a kart one step along `ang` at `v` and project the result back into
   * track space. The curvature term is the arc-length ratio of an offset path:
   * a kart on the inside line covers less centreline than one on the outside.
   */
  _advance(k, dt, ang, v) {
    const t = this.track;
    const s = t.at(k.q * LAP_UNITS + S_FIN, this._tmp);
    const dxw = Math.cos(ang) * v * dt;
    const dzw = Math.sin(ang) * v * dt;
    const ca = Math.cos(s.ang);
    const sa = Math.sin(s.ang);
    const along = dxw * ca + dzw * sa;
    const across = -dxw * sa + dzw * ca;
    const latW = k.lat * s.hw + across;
    const fold = clamp(1 - latW * s.curv, 0.25, 2.2);
    const prevQ = k.q;
    k.q = frac1(k.q + (along / fold) / LAP_UNITS);
    const s2 = t.at(k.q * LAP_UNITS + S_FIN, this._tmp2);
    k.lat = latW / Math.max(0.5, s2.hw);
    k.yaw = wrapPi(k.heading - s2.ang);
    // lap rollover, local arbitration only (the server owns it in a race)
    if (!this.net && this.phase === 'race' && along > 0) this._lapCheck(k, prevQ);
  }

  /**
   * §4.4's anti-cut rule, mirrored locally for practice: crossing `q = k/6`
   * forward sets bit k, and a wrap only counts a lap once all six are set. It is
   * also what stops the grid — which sits at q ~ 0.96..0.99, BEHIND the line —
   * from banking a free lap in the first second of the race.
   */
  _lapCheck(k, prevQ) {
    for (let c = 0; c < 6; c++) {
      const cq = c / 6;
      const toC = dq(prevQ, cq);
      if (toC >= 0 && toC <= dq(prevQ, k.q)) k.cp |= (1 << c);
    }
    if (prevQ > 0.85 && k.q < 0.15) {
      if (k.cp === 0b111111) { k.cp = 0; this._localLap(k); }
    }
  }

  _localLap(k) {
    k.laps = Math.min(LAPS, k.laps + 1);
    const split = this.raceMs - (k.lapMs.length ? k.lapMs[k.lapMs.length - 1] : 0);
    k.lapMs.push(this.raceMs);
    const isBest = split > 0 && (!k.bestLap || split < k.bestLap);
    if (isBest) k.bestLap = split;
    if (k.laps >= LAPS) { this._localFinish(k); return; }
    if (k === this.me) this._onMyLap(k.laps, split, isBest);
  }

  /** §3.1 — the barrier is soft: clamp, scrub speed, nudge back in. Never stop. */
  _wall(k, dt, off) {
    if (Math.abs(k.lat) < WALL_LAT) { k.wallT = 0; return; }
    k.lat = clamp(k.lat, -WALL_LAT, WALL_LAT);
    const inward = -Math.sign(k.lat);
    if (k.wallT <= 0) {
      k.v *= 0.55;
      if (k === this.me) {
        this.shake = Math.max(this.shake, 0.4);
        this.game.audio?.play?.('pop');
        this._cancelDrift(k);
        for (let i = 0; i < 8; i++) {
          this._spawnPart(k, rand(-0.4, 0.4), rand(0.2, 1), 0, 0x3a3540, rand(0.2, 0.4), rand(0.25, 0.5));
        }
      }
    }
    k.wallT = 0.35;
    // steer the nose back toward the road instead of pinning it to the wall
    const s = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp);
    k.lat += inward * 0.9 * dt;
    k.heading = angLerp(k.heading, s.ang + inward * 0.25, ease(dt, 4));
    k.velAng = angLerp(k.velAng, k.heading, ease(dt, 6));
    k.wallT -= dt;
  }

  // ------------------------------------------------------------------- ai ---
  /**
   * §3.5, practice only — in a race the server simulates these and we render
   * from kart-state. Effective speed is hard-clamped to [16.0, 21.8] u/s, which
   * is BELOW the player's V_MAX of 22: there is no catch-up that beats skill.
   */
  _stepAI(k, dt) {
    const leader = this.me;                       // the only human in practice
    const dHuman = (this._progress(leader) - this._progress(k)) * LAP_UNITS;
    let mult;
    if (dHuman > 0) mult = 1 + Math.min(0.12, dHuman / 700);
    else mult = 1 - Math.min(0.10, -dHuman / 900);

    const base = 19.0 + 0.55 * k.skill;
    const sector = AI_SECTORS[Math.min(AI_SECTORS.length - 1, Math.floor(k.q * AI_SECTORS.length))];
    let vTarget = Math.min(base * mult, sector);
    vTarget = clamp(vTarget, AI_MIN, AI_MAX);
    if (k.soakT > 0) { vTarget = Math.min(vTarget, V_MAX * SOAK_MUL); k.soakT -= dt; }
    if (k.spinT > 0) { vTarget = Math.min(vTarget, 5); k.spinT -= dt; }
    k.v = lerp(k.v, vTarget, ease(dt, 2.2));

    // lateral bias, re-rolled every 60 units and lerped at 0.6/s
    k.biasAt += k.v * dt;
    if (k.biasAt > 60) { k.biasAt = 0; k.biasTo = (this.rng() - 0.5) * 0.9; }
    k.bias += clamp(k.biasTo - k.bias, -0.6 * dt, 0.6 * dt);
    const wantLat = clamp(k.bias, -0.45, 0.45);
    const prevLat = k.lat;
    k.lat += clamp(wantLat - k.lat, -1.4 * dt, 1.4 * dt);

    const prevQ = k.q;
    const s = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp);
    k.q = frac1(k.q + (k.v * dt) / LAP_UNITS);
    const s2 = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp2);
    // yaw comes out of the lateral drift, so an AI leans into its own line
    const latRate = dt > 0 ? ((k.lat - prevLat) * s2.hw) / dt : 0;
    k.yaw = wrapPi(Math.atan2(latRate, Math.max(1, k.v)) + (s.ang - s2.ang) * 0.4);
    k.heading = wrapPi(s2.ang + k.yaw);
    k.velAng = k.heading;
    k.wheelSpin += k.v * dt * 3;
    // sparks on the slow sectors are pure flavour: no boost (§3.5)
    k.drift = sector < 17 && k.v > 9 ? 1 : 0;
    k.tier = k.drift ? 1 + (Math.floor(this.time * 0.7 + k.slot) % 2) : 0;

    if (this.phase === 'race') this._lapCheck(k, prevQ);
    this._aiItems(k, dt);
  }

  /** AI box pickups and item use, inside the §3.5 courtesy rules. */
  _aiItems(k, dt) {
    if (!k.aiItem) {
      for (const b of this.boxes) {
        if (!b.live) continue;
        if (Math.abs(dq(k.q, b.q)) > BOX_DQ || Math.abs(k.lat - b.lat) > BOX_DLAT) continue;
        b.live = false;
        b.respawnAt = this.time + BOX_RESPAWN_MS / 1000;
        this._puff(b, 0xfff3d2);
        k.aiItem = this._rollItem(this._placeOf.get(k) || 3);
        k.aiUseAt = this.time + rand(1.5, 5);
        break;
      }
      return;
    }
    if (this.time < k.aiUseAt) return;
    const item = k.aiItem;
    k.aiItem = null;
    if (item === 'berry') {
      k.v = Math.min(BOOST_CEIL, k.v + 4);
      this._boostFx(k);
      return;
    }
    if (item === 'peel') {
      // never dropped within 20u ahead of a human
      const ahead = dq(this.me.q, k.q) * LAP_UNITS + (k.laps - this.me.laps) * LAP_UNITS;
      if (ahead > 0 && ahead < 20) return;
      this._dropPeel(k);
      return;
    }
    // never fired at a kart more than 45u ahead
    const tgt = this._nearestAhead(k, 45 / LAP_UNITS);
    if (tgt) this._fireBubble(k);
  }

  // ---------------------------------------------------------------- items ---
  _rollItem(place) {
    const band = place <= 2 ? 0 : place <= 4 ? 1 : 2;
    const w = ITEM_WEIGHTS[band];
    const r = this.rng();
    let acc = 0;
    for (let i = 0; i < ITEM_ORDER.length; i++) {
      acc += w[i];
      if (r < acc) return ITEM_ORDER[i];
    }
    return ITEM_ORDER[ITEM_ORDER.length - 1];
  }

  /** §4.5 — drive over a live box holding nothing. A refusal costs no box. */
  _checkBoxes(dt) {
    const k = this.me;
    for (const b of this.boxes) {
      if (b.cool > 0) b.cool -= dt;
      if (!b.live) {
        if (!this.net && b.respawnAt && this.time >= b.respawnAt) { b.live = true; b.respawnAt = 0; }
        continue;
      }
      if (k.item || this.spinLock > 0 || b.cool > 0) continue;
      if (Math.abs(dq(k.q, b.q)) > BOX_DQ || Math.abs(k.lat - b.lat) > BOX_DLAT) continue;
      b.cool = 0.5;                              // one attempt per pass
      if (this.net) {
        this.game.net?.send?.({ t: 'kart-box', box: b.i });
        this._sendIn(true);
      } else {
        b.live = false;
        b.respawnAt = this.time + BOX_RESPAWN_MS / 1000;
        this._puff(b, 0xfff3d2);
        this._grantItem(this._rollItem(this._placeOf.get(k) || 1), b.i);
      }
      break;
    }
  }

  /** §3.3 — 0.6s roulette on the HUD, then it locks. */
  _grantItem(item, box) {
    const k = this.me;
    if (k.item) return;
    k.boxes++;
    k.item = item;
    k.itemAt = this.time;
    this.spinLock = ROULETTE_MS / 1000;
    this.f.item.classList.remove('spin');
    void this.f.item.offsetWidth;
    this.f.item.classList.add('spin');
    this.game.audio?.play?.('pop');
    this._popup('+10', 'gold');
    if (Number.isFinite(box)) {
      const b = this.boxes[box];
      if (b && !this.net) b.live = false;
    }
  }

  _useItem() {
    const k = this.me;
    if (this.phase !== 'race' || !k.item || this.spinLock > 0) return;
    const item = k.item;
    if (this.net) {
      k.item = null;                       // the server decides from what it knows
      this.game.net?.send?.({ t: 'kart-use' });
      this._sendIn(true);
      this._useFx(item);
      return;
    }
    k.item = null;
    this._useFx(item);
    if (item === 'peel') this._dropPeel(k);
    else if (item === 'bubble') this._fireBubble(k);
    else {
      this._applyBoost(BERRY_MS / 1000, BERRY_TARGET);
      this._boostFx(k);
    }
  }

  _useFx(item) {
    this.game.audio?.play?.(item === 'bubble' ? 'splash' : item === 'berry' ? 'whoosh' : 'pop');
  }

  _dropPeel(k) {
    const id = this.hazSeq++;
    this.hazards.set(id, {
      i: id, kind: 'peel', q: frac1(k.q - PEEL_BEHIND / LAP_UNITS), lat: k.lat,
      by: k.slot, at: this.time, die: this.time + PEEL_TTL_MS / 1000,
    });
  }

  _fireBubble(k) {
    const id = this.hazSeq++;
    this.projectiles.set(id, {
      i: id, q: frac1(k.q + 1.2 / LAP_UNITS), lat: k.lat, by: k.slot,
      at: this.time, die: this.time + BUBBLE_TTL_MS / 1000,
    });
  }

  _nearestAhead(from, maxDq) {
    let best = null;
    let bestD = maxDq;
    for (const o of this.karts) {
      if (o === from || o.finished) continue;
      const d = dq(from.q, o.q);
      if (d > 0 && d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Local arbitration of hazards + projectiles. Practice only (§4 decision 1). */
  _stepHazardsLocal(dt) {
    for (const [id, h] of this.hazards) {
      if (h.die && this.time > h.die) { this.hazards.delete(id); continue; }
      for (const k of this.karts) {
        if (k.finished || k.spinT > 0) continue;
        if (k.slot === h.by && this.time - h.at < PEEL_SELF_MS / 1000) continue;
        if (Math.abs(dq(h.q, k.q)) > PEEL_DQ || Math.abs(k.lat - h.lat) > PEEL_DLAT) continue;
        this.hazards.delete(id);
        this._applyHit(k, 'peel', SPIN_MS);
        break;
      }
    }
    for (const [id, p] of this.projectiles) {
      if (this.time > p.die) { this.projectiles.delete(id); continue; }
      const prevQ = p.q;
      p.q = frac1(p.q + (BUBBLE_SPEED * dt) / LAP_UNITS);
      const tgt = this._nearestAhead(p, 60 / LAP_UNITS);
      if (tgt) p.lat += clamp(tgt.lat - p.lat, -BUBBLE_HOME * dt, BUBBLE_HOME * dt);
      for (const k of this.karts) {
        if (k.finished || k.slot === p.by) continue;
        // "hits as it passes": the projectile crossed this kart's q this frame
        if (dq(prevQ, k.q) > 0 && dq(p.q, k.q) <= 0 && Math.abs(k.lat - p.lat) <= BUBBLE_DLAT) {
          this.projectiles.delete(id);
          this._applyHit(k, 'bubble', SOAK_MS);
          break;
        }
      }
    }
  }

  /** The one penalty path. In a race only kart-hit reaches here. */
  _applyHit(k, kind, ms) {
    const sec = (Number(ms) || (kind === 'bubble' ? SOAK_MS : SPIN_MS)) / 1000;
    if (kind === 'bubble') {
      k.soakT = Math.max(k.soakT, sec);
      if (k === this.me) {
        this._flashFx('soak');
        this.game.audio?.play?.('splash');
        this._popup('SOAKED', 'sky');
      }
    } else {
      k.spinT = Math.max(k.spinT, sec);
      k.v *= 0.35;
      if (k === this.me) {
        this._flashFx('hit');
        this.game.audio?.play?.('fail');
        this._popup('SPUN OUT', 'bad');
      }
    }
    this._cancelDrift(k);
    if (k === this.me) this.shake = Math.max(this.shake, 0.5);
    for (let i = 0; i < 16; i++) {
      this._spawnPart(k, rand(-0.8, 0.8), rand(0.2, 1.4), rand(-0.6, 0.6),
        kind === 'bubble' ? 0xbfe9ff : 0x7ac74f, rand(0.2, 0.45), rand(0.35, 0.7));
    }
  }

  // ------------------------------------------------------------- main loop --
  _tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._tick);
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    this.dtLast = dt;
    this.time += dt;
    this._step(dt);
    this.renderer.render(this.scene, this.camera);
  };

  _step(dt) {
    // ---- lights ------------------------------------------------------------
    if (this.phase === 'count') {
      const left = this.startAt - performance.now();
      const step = left > 2400 ? 0 : left > 1600 ? 1 : left > 800 ? 2 : left > 0 ? 3 : 4;
      if (step !== this.lightStep) {
        this.lightStep = step;
        for (let i = 0; i < this.bulbs.length; i++) {
          this.bulbs[i].className = `mg-kart-bulb${i < step + 1 && step < 4 ? ' lit' : step === 4 ? ' go' : ''}`;
        }
        if (step >= 1 && step <= 3) {
          this._big(String(4 - step), false);
          this.game.audio?.play?.('ding');
        }
      }
      // §3.4: the throttle is dead here, but sitting on it is what bogs you.
      // Polled in the count phase because _readInput only runs once racing.
      this.preHold = this._gasDown() ? this.preHold + dt : 0;
      if (left <= 0) this._startRace();
    } else if (this.phase === 'race' || this.phase === 'done') {
      this.raceMs += dt * 1000;
      if (this.phase === 'race' && this.raceMs > 7000 && this.tip.style.opacity !== '0') {
        this.tip.style.opacity = '0';
      }
      if (!this.net && this.raceMs > RACE_MAX_MS) this._endLocal();
    }
    if (this.spinLock > 0) this.spinLock -= dt;

    // ---- simulate ----------------------------------------------------------
    if (this.phase === 'race' && !this.me.ghost) this._stepMe(dt);
    else if (this.phase === 'done') this._coast(dt);

    if (!this.net) {
      if (this.phase === 'race' || this.phase === 'done') {
        for (const k of this.karts) if (k !== this.me && !k.finished) this._stepAI(k, dt);
        this._stepHazardsLocal(dt);
      }
      this._maybeEndLocal(false);
    } else {
      this._interpolate();
      this._sendIn(false);
    }

    if (this.phase === 'race') this._checkBoxes(dt);
    this._updatePlaces();
    this._layoutKarts(dt);
    this._layoutBoxes(dt);
    this._layoutHazards();
    this._updateParticles(dt);
    this._updateDecor(dt);
    this._updateCamera(dt);
    this._updateEngines();
    this._updateTags();
    this._refreshHud(dt);
  }

  /** After the flag: the kart rolls to a stop while the board comes up. */
  _coast(dt) {
    const k = this.me;
    k.v = Math.max(0, k.v - COAST_DRAG * 1.4 * dt);
    k.steer = lerp(k.steer, 0, ease(dt, 3));
    k.heading = wrapPi(k.heading + k.steer * 0.6 * dt);
    k.velAng = angLerp(k.velAng, k.heading, ease(dt, GRIP));
    this._cancelDrift(k);
    if (k.v > 0.02) this._advance(k, dt, k.velAng, k.v);
  }

  /**
   * §4 decision 2 — remote karts (and, in a race, the AI) are rendered from the
   * 10Hz stream on a fixed delay, so a lost packet reads as a smooth line
   * instead of a teleport. Anything newer than the render clock is held back.
   */
  _interpolate() {
    const now = performance.now() - INTERP_MS;
    for (const k of this.karts) {
      if (k === this.me || !k.seen || k.buf.length === 0) continue;
      const b = k.buf;
      while (b.length > 2 && b[1].t <= now) b.shift();
      const a = b[0];
      const c = b.length > 1 ? b[1] : null;
      if (!c) {
        // starved: keep rolling at the last reported speed rather than freeze
        const dt = Math.max(0, (now - a.t) / 1000);
        k.q = frac1(a.q + (a.v * Math.min(dt, 0.5)) / LAP_UNITS);
        k.lat = a.lat;
        k.yaw = a.yaw;
        k.v = a.v;
        k.drift = a.d ? 1 : 0;
        k.tier = a.d;
      } else {
        const span = Math.max(1, c.t - a.t);
        const t = clamp((now - a.t) / span, 0, 1);
        k.q = frac1(a.q + dq(a.q, c.q) * t);
        k.lat = lerp(a.lat, c.lat, t);
        k.yaw = angLerp(a.yaw, c.yaw, t);
        k.v = lerp(a.v, c.v, t);
        k.drift = c.d ? 1 : 0;
        k.tier = c.d;
      }
      k.wheelSpin += k.v * this.dtLast * 3;
      const s = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp);
      k.heading = wrapPi(s.ang + k.yaw);
      k.velAng = k.heading;
    }
  }

  /**
   * Total distance covered, in laps. The grid sits at q ~ 0.96..0.99 BEHIND the
   * line, so a kart that has not yet taken its first crossing counts as
   * `q - 1` — otherwise the moment the leader wraps to q = 0.01 the whole grid
   * would sort ahead of them.
   */
  _progress(k) { return k.laps + k.q - (k.crossed ? 0 : 1); }

  /** Live 1st..6th, by distance covered; finishers keep the place they took. */
  _updatePlaces() {
    for (const k of this.karts) {
      if (!k.crossed && (k.laps > 0 || (k._pq > 0.8 && k.q < 0.2))) k.crossed = true;
      k._pq = k.q;
    }
    const order = this.karts.slice().sort((a, b) => {
      if (a.finished && b.finished) return a.place - b.place;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return this._progress(b) - this._progress(a);
    });
    this._order = order;
    this._placeOf.clear();
    for (let i = 0; i < order.length; i++) this._placeOf.set(order[i], i + 1);
  }

  // ------------------------------------------------------------- rendering --
  /**
   * One transform per kart drives the anchor (driver + roundel + shadow) AND the
   * three instanced families, so six karts cost three draw calls of hardware
   * plus one avatar each.
   */
  _layoutKarts(dt) {
    const t = this.track;
    const body = this.bodyIM;
    const trim = this.trimIM;
    const wheel = this.wheelIM;
    let n = 0;
    let wn = 0;
    for (const k of this.karts) {
      const p = t.worldOf(k.q, k.lat, this._tmp);
      const ry = Math.PI / 2 - k.heading;
      k.anchor.position.set(p.x, 0, p.z);
      k.anchor.rotation.y = ry;

      // lean: into the corner, harder while drifting, plus a squash on a hit
      const slip = wrapPi(k.heading - k.velAng);
      const wantRoll = clamp(-slip * (k.drift ? 1.1 : 0.7), -0.32, 0.32);
      k.tilt.rotation.z = lerp(k.tilt.rotation.z, wantRoll, ease(dt || 0.016, 8));
      k.tilt.rotation.x = lerp(k.tilt.rotation.x, k.spinT > 0 ? 0.12 : 0, ease(dt || 0.016, 6));
      k.tilt.position.y = k.spinT > 0 ? Math.abs(Math.sin(this.time * 22)) * 0.06 : 0;
      if (!k.onPodium) k.driver.update(dt || 0.016);
      k.shadow.visible = !k.ghost && !k.onPodium;

      _eu.set(k.tilt.rotation.x, ry, k.tilt.rotation.z, 'YXZ');
      _q4.setFromEuler(_eu);
      _v3b.set(p.x, k.tilt.position.y, p.z);
      _sc.set(1, 1, 1);
      _m4.compose(_v3b, _q4, _sc);
      body.setMatrixAt(n, _m4);
      trim.setMatrixAt(n, _m4);
      _col.setHex(k.color);
      if (k.ghost) _col.lerp(_ghostCol, 0.6);
      body.instanceColor.setXYZ(n, _col.r, _col.g, _col.b);
      n++;

      // wheels: fronts steer with the wheel, all four spin with road speed
      for (const [wx, wy, wz, front] of WHEELS) {
        _v3.set(wx, wy, wz).applyQuaternion(_q4).add(_v3b);
        _euB.set(0, ry + (front ? -k.steer * 0.5 : 0), 0, 'YXZ');
        _qA.setFromEuler(_euB);
        _qB.setFromAxisAngle(_axisX, k.wheelSpin);
        _qA.multiply(_qB);
        _m4.compose(_v3, _qA, _sc);
        wheel.setMatrixAt(wn++, _m4);
      }

      if (k.drift && k.tier > 0 && k.v > 6) this._driftSparks(k, dt);
    }
    body.count = n;
    trim.count = n;
    wheel.count = wn;
    body.instanceMatrix.needsUpdate = true;
    body.instanceColor.needsUpdate = true;
    trim.instanceMatrix.needsUpdate = true;
    wheel.instanceMatrix.needsUpdate = true;
  }

  _layoutBoxes(dt) {
    const im = this.boxIM;
    let n = 0;
    for (const b of this.boxes) {
      if (!b.live) continue;
      const p = this.track.worldOf(b.q, b.lat, this._tmp);
      _eu.set(this.time * 0.9 + b.i, this.time * 1.6 + b.i, 0);
      _q4.setFromEuler(_eu);
      _v3b.set(p.x, 1.15 + Math.sin(this.time * 2.2 + b.i) * 0.12, p.z);
      const s = 1 + Math.sin(this.time * 5 + b.i) * 0.04;
      _sc.set(s, s, s);
      _m4.compose(_v3b, _q4, _sc);
      im.setMatrixAt(n++, _m4);
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
  }

  _layoutHazards() {
    const hz = this.hazIM;
    let n = 0;
    for (const h of this.hazards.values()) {
      if (h.stale) continue;
      const p = this.track.worldOf(h.q, h.lat, this._tmp);
      _eu.set(0, h.i * 1.7, 0);
      _q4.setFromEuler(_eu);
      _v3b.set(p.x, 0.06, p.z);
      _sc.set(1, 1, 1);
      _m4.compose(_v3b, _q4, _sc);
      if (n < hz.instanceMatrix.count) hz.setMatrixAt(n++, _m4);
    }
    hz.count = n;
    hz.instanceMatrix.needsUpdate = true;

    const pr = this.projIM;
    let m = 0;
    for (const p of this.projectiles.values()) {
      const w = this.track.worldOf(p.q, p.lat, this._tmp);
      _eu.set(0, this.time * 6, 0);
      _q4.setFromEuler(_eu);
      const s = 1 + Math.sin(this.time * 12 + p.i) * 0.08;
      _v3b.set(w.x, 0.2, w.z);
      _sc.set(s, s, s);
      _m4.compose(_v3b, _q4, _sc);
      if (m < pr.instanceMatrix.count) pr.setMatrixAt(m++, _m4);
    }
    pr.count = m;
    pr.instanceMatrix.needsUpdate = true;
  }

  _updateDecor(dt) {
    // gulls wheel over the bay, and scatter when something loud happens
    const im = this.gulls;
    for (let i = 0; i < this.gullSeeds.length; i++) {
      const g = this.gullSeeds[i];
      if (g.scare > 0) { g.scare -= dt; g.y += dt * 7; }
      else if (g.y > 14 + (i % 12)) g.y -= dt * 2.4;
      g.a += g.sp * dt;
      g.flap += dt * 9;
      _eu.set(Math.sin(g.flap) * 0.5, -g.a, 0, 'YXZ');
      _q4.setFromEuler(_eu);
      _v3b.set(g.x + Math.cos(g.a) * g.r, g.y, g.z + Math.sin(g.a) * g.r);
      _sc.set(1.6, 1.6, 1.6);
      _m4.compose(_v3b, _q4, _sc);
      im.setMatrixAt(i, _m4);
    }
    im.instanceMatrix.needsUpdate = true;
    if (this.sky) this.sky.position.copy(this.camera.position);
    this.sun.position.set(this.me.anchor.position.x + 60, 90, this.me.anchor.position.z + 30);
    this.sun.target.position.copy(this.me.anchor.position);
    this.sun.target.updateMatrixWorld();
  }

  _scareGulls() {
    for (const g of this.gullSeeds) g.scare = rand(0.4, 1.2);
  }

  // ------------------------------------------------------------- particles --
  _spawnPart(k, ox, oy, oz, color, size, life, glow = false) {
    if (this.parts.length >= 240) return;
    const p = k.anchor ? k.anchor.position : k;
    _col.setHex(color);
    this.parts.push({
      x: p.x + ox, y: oy, z: p.z + oz,
      vx: rand(-1.5, 1.5), vy: rand(0.6, 3.4), vz: rand(-1.5, 1.5),
      size, life, max: life, r: _col.r, g: _col.g, b: _col.b,
      rx: Math.random() * 6.28, ry: Math.random() * 6.28, glow,
    });
  }

  _dust(k, color) {
    this._spawnPart(k, rand(-0.7, 0.7), 0.14, rand(-0.9, -0.2), color, rand(0.24, 0.5), rand(0.35, 0.7));
  }

  _puff(box, color) {
    const p = this.track.worldOf(box.q, box.lat, this._tmp);
    for (let i = 0; i < 10; i++) {
      this.parts.push({
        x: p.x, y: 1.15, z: p.z,
        vx: rand(-3, 3), vy: rand(1, 5), vz: rand(-3, 3),
        size: rand(0.16, 0.34), life: 0.5, max: 0.5,
        r: 1, g: 0.95, b: 0.82, rx: 0, ry: 0, glow: true,
      });
    }
    void color;
  }

  /** §3.2 — sparks behind the inside rear wheel, pulsing at 6Hz. */
  _driftSparks(k, dt) {
    this._sparkAcc = (this._sparkAcc || 0) + dt * 46;
    while (this._sparkAcc >= 1) {
      this._sparkAcc -= 1;
      if (this.sparks.length >= 60) break;
      const T = DRIFT_TIERS[Math.max(0, k.tier - 1)];
      const side = -k.driftDir || 1;
      _euB.set(0, k.anchor.rotation.y, 0);
      _v3.set(side * 0.66, 0.3, -0.6).applyEuler(_euB);
      _col.setHex(T.color);
      const pulse = 0.75 + 0.25 * Math.sin(this.time * Math.PI * 12);
      this.sparks.push({
        x: k.anchor.position.x + _v3.x, y: 0.28, z: k.anchor.position.z + _v3.z,
        vx: rand(-2.6, 2.6) - Math.cos(k.heading) * 4,
        vy: rand(1.4, 4.2),
        vz: rand(-2.6, 2.6) - Math.sin(k.heading) * 4,
        life: rand(0.16, 0.34), max: 0.34, size: rand(0.5, 1.1) * pulse,
        r: _col.r, g: _col.g, b: _col.b,
      });
    }
  }

  _sparkBurst(k, color, n) {
    _col.setHex(color);
    for (let i = 0; i < n && this.sparks.length < 60; i++) {
      this.sparks.push({
        x: k.anchor.position.x, y: 0.4, z: k.anchor.position.z,
        vx: rand(-6, 6), vy: rand(2, 7), vz: rand(-6, 6),
        life: rand(0.25, 0.5), max: 0.5, size: rand(0.6, 1.3),
        r: _col.r, g: _col.g, b: _col.b,
      });
    }
  }

  _confettiBurst(n, over) {
    const p = over || (this.podium ? this.podium.root.position : this.me.anchor.position);
    for (let i = 0; i < n && this.confetti.length < 120; i++) {
      const c = [KERB_A, GOLD, SEA, 0x7ac74f, CREAM][i % 5];
      _col.setHex(c);
      this.confetti.push({
        x: p.x + rand(-6, 6), y: rand(6, 14), z: p.z + rand(-6, 6),
        vx: rand(-2.5, 2.5), vy: rand(-1, 2), vz: rand(-2.5, 2.5),
        life: rand(2.4, 4.2), max: 4.2, size: rand(0.7, 1.5),
        r: _col.r, g: _col.g, b: _col.b, spin: rand(-6, 6), rx: Math.random() * 6.28,
      });
    }
  }

  _updateParticles(dt) {
    const write = (list, im, grav, drag) => {
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.life -= dt;
        if (p.life <= 0) continue;
        p.vy -= grav * dt;
        if (drag) { p.vx *= 1 - drag * dt; p.vz *= 1 - drag * dt; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < 0.05) { p.y = 0.05; p.vy = Math.abs(p.vy) * 0.3; }
        p.rx = (p.rx || 0) + (p.spin || 4) * dt;
        p.ry = (p.ry || 0) + 3 * dt;
        list[w++] = p;
      }
      list.length = w;
      const col = im.instanceColor;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const t = p.life / p.max;
        const s = p.size * (0.35 + t * 0.75);
        _eu.set(p.rx, p.ry, 0);
        _q4.setFromEuler(_eu);
        _v3b.set(p.x, p.y, p.z);
        _sc.set(s, s, s);
        _m4.compose(_v3b, _q4, _sc);
        im.setMatrixAt(i, _m4);
        col.setXYZ(i, p.r, p.g, p.b);
      }
      im.count = list.length;
      im.instanceMatrix.needsUpdate = true;
      col.needsUpdate = true;
    };
    write(this.parts, this.pfx, 10, 1.5);
    write(this.sparks, this.sparkIM, 16, 2.2);
    write(this.confetti, this.confIM, 3.2, 0.6);

    // speed lines: camera-space streaks that fade in with speed and boost
    const spd = clamp((this.me.v - 16) / 18, 0, 1) + (this.me.boostT > 0 ? 0.5 : 0);
    this.lineMat.opacity = lerp(this.lineMat.opacity, Math.min(0.55, spd * 0.5), ease(dt, 5));
    if (this.lineMat.opacity > 0.01) {
      for (let i = 0; i < this.lineSeeds.length; i++) {
        const s = this.lineSeeds[i];
        s.z += dt * (2 + spd * 5);
        if (s.z > 1) { s.z = 0; s.a = Math.random() * 6.28; s.r = 0.5 + Math.random() * 1.5; }
        const z = -1.4 - (1 - s.z) * 5;
        _eu.set(0, 0, s.a + Math.PI / 2);
        _q4.setFromEuler(_eu);
        _v3b.set(Math.cos(s.a) * s.r * 1.6, Math.sin(s.a) * s.r, z);
        _sc.set(1, 0.6 + s.z * 1.6, 1);
        _m4.compose(_v3b, _q4, _sc);
        this.lines.setMatrixAt(i, _m4);
      }
      this.lines.count = this.lineSeeds.length;
      this.lines.instanceMatrix.needsUpdate = true;
    } else {
      this.lines.count = 0;
    }
  }

  // ----------------------------------------------------------------- camera -
  /** §6 — chase cam that leans into a drift, with an FOV punch on boost. */
  _updateCamera(dt) {
    const cam = this.camera;
    const k = this.me;
    if (this._podiumCam && this.podium) { this._updatePodiumCam(dt); return; }
    const back = this.lookBack;
    const yawK = k.drift ? 12 : 6;

    if (!this._camInit) {
      this._camYaw = k.heading;
      this._camInit = true;
    }
    this._camYaw = angLerp(this._camYaw, k.heading + (back ? Math.PI : 0), ease(dt, yawK));
    const ry = Math.PI / 2 - this._camYaw;

    _v3.set(0, 3.2, -7.0).applyAxisAngle(_axisY, ry);
    const want = _v3b.set(
      k.anchor.position.x + _v3.x,
      3.2,
      k.anchor.position.z + _v3.z,
    );
    const kk = ease(dt, 9);
    cam.position.lerp(want, kk);

    _v3.set(Math.cos(this._camYaw), 0, Math.sin(this._camYaw)).multiplyScalar(back ? -4 : 4);
    cam.lookAt(
      k.anchor.position.x + _v3.x,
      1.3,
      k.anchor.position.z + _v3.z,
    );

    // roll into the drift, then shake on top of everything
    const wantRoll = k.drift ? -k.driftDir * 0.05 : 0;
    this.roll = lerp(this.roll, wantRoll, ease(dt, 5));
    if (Math.abs(this.roll) > 0.0005) cam.rotateZ(this.roll);
    if (this.shake > 0.001) {
      this.shake *= Math.exp(-dt * 5.5);
      cam.position.x += rand(-1, 1) * this.shake * 0.5;
      cam.position.y += rand(-1, 1) * this.shake * 0.4;
      cam.rotateZ(rand(-1, 1) * this.shake * 0.04);
    }

    const wantFov = 62 + (k.boostT > 0 ? 10 : 0) + clamp((k.v - V_MAX) * 0.4, 0, 4);
    this.fov = lerp(this.fov, wantFov, ease(dt, 6));
    if (Math.abs(cam.fov - this.fov) > 0.02) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    const vg = clamp((k.v - 14) / 24, 0, 1) * 0.8 + (k.boostT > 0 ? 0.2 : 0);
    if (Math.abs(vg - (this.hudCache.vg ?? -1)) > 0.03) {
      this.hudCache.vg = vg;
      this.vig.style.opacity = vg.toFixed(2);
    }
  }

  /** Slow orbit around the rostrum while the top three hop and the coins count. */
  _updatePodiumCam(dt) {
    const cam = this.camera;
    const p = this.podium;
    const a = this.time * 0.22;
    _v3b.set(
      p.root.position.x + Math.cos(a) * 9.5,
      4.6 + Math.sin(this.time * 0.5) * 0.5,
      p.root.position.z + Math.sin(a) * 9.5,
    );
    cam.position.lerp(_v3b, ease(dt, 3));
    cam.lookAt(p.root.position.x, 2.1, p.root.position.z);
    if (Math.abs(cam.fov - 55) > 0.05) {
      cam.fov = lerp(cam.fov, 55, ease(dt, 3));
      this.fov = cam.fov;
      cam.updateProjectionMatrix();
    }
    for (const h of p.hops) {
      const t = this.time * 3 + h.phase;
      h.seat.position.y = h.base + Math.max(0, Math.sin(t)) * 0.45;
      h.seat.rotation.y = Math.sin(t * 0.4) * 0.3;
      h.driver.update(dt);
    }
    if (this.confetti.length < 40 && Math.random() < dt * 4) this._confettiBurst(12);
  }

  // -------------------------------------------------------------------- hud -
  _refreshHud(dt) {
    const c = this.hudCache;
    const k = this.me;
    const place = this._placeOf.get(k) || 1;
    if (place !== c.place) {
      c.place = place;
      this.f.place.textContent = ordinal(place);
    }
    const lap = clamp(k.laps + (this.phase === 'race' ? 1 : 0), 1, LAPS);
    if (lap !== c.lap) {
      c.lap = lap;
      this.f.lap.textContent = lap;
    }
    const lapStart = k.lapMs.length ? k.lapMs[k.lapMs.length - 1] : 0;
    const live = this.phase === 'race' ? this.raceMs - lapStart : (k.finishMs - lapStart);
    const shown = Math.floor(live / 10);
    if (shown !== c.t) {
      c.t = shown;
      this.f.time.textContent = lapTime(live);
    }
    if (k.bestLap !== c.best) {
      c.best = k.bestLap;
      this.f.bestlap.textContent = k.bestLap ? `best ${lapTime(k.bestLap)}` : 'best --:--';
    }

    // item card: the roulette spins for 0.6s, then the real card locks in
    const showing = this.spinLock > 0
      ? ITEM_ORDER[Math.floor(this.time * 14) % ITEM_ORDER.length]
      : k.item;
    if (showing !== c.item) {
      c.item = showing;
      this.f.icon.innerHTML = showing ? ITEM_SVG[showing] : '';
      const ic = this.f.icon.firstElementChild;
      if (ic) requestAnimationFrame(() => ic.classList.add('on'));
    }
    const canUse = !!k.item && this.spinLock <= 0 && this.phase === 'race';
    if (canUse !== c.canUse) {
      c.canUse = canUse;
      this.f.use.classList.toggle('on', canUse);
      this.f.item.classList.toggle('pop', canUse);
    }

    // the six-name order, rebuilt only when it actually changes
    let sig = '';
    for (const o of this._order) sig += `${o.slot}${o.ghost ? 'g' : ''}|`;
    if (sig !== c.order) {
      c.order = sig;
      this.f.order.innerHTML = this._order.map((o, i) => `
        <div class="mg-kart-orow${o === k ? ' me' : ''}${o.ghost ? ' ghost' : ''}">
          <u>${i + 1}</u><i style="background:${hex6(o.color)}"></i>
          <span>${esc(o.name)}</span><b>L${clamp(o.laps + 1, 1, LAPS)}</b>
        </div>`).join('');
    }

    this._mapAcc = (this._mapAcc || 0) + dt;
    if (this._mapAcc >= 0.05) { this._mapAcc = 0; this._drawMinimap(); }
  }

  /** The centreline is painted once into an offscreen canvas; only dots move. */
  _buildMinimapBase() {
    const size = 148;
    const pad = 12;
    const t = this.track;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < t.n; i++) {
      minX = Math.min(minX, t.x[i]); maxX = Math.max(maxX, t.x[i]);
      minZ = Math.min(minZ, t.z[i]); maxZ = Math.max(maxZ, t.z[i]);
    }
    const sc = Math.min((size - pad * 2) / (maxX - minX), (size - pad * 2) / (maxZ - minZ));
    const ox = (size - (maxX - minX) * sc) / 2 - minX * sc;
    const oz = (size - (maxZ - minZ) * sc) / 2 - minZ * sc;
    this.mapT = { sc, ox, oz, size };

    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const g = off.getContext('2d');
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i <= t.n; i++) {
      const j = i % t.n;
      const x = t.x[j] * sc + ox;
      const y = t.z[j] * sc + oz;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokeStyle = '#cfc2a8';
    g.lineWidth = 9;
    g.stroke();
    g.strokeStyle = '#5b5568';
    g.lineWidth = 6;
    g.stroke();
    // finish line marker
    const fi = Math.round((S_FIN / LAP_UNITS) * t.n) % t.n;
    g.strokeStyle = '#fff6e2';
    g.lineWidth = 4;
    g.beginPath();
    const a = t.ang[fi];
    const fx = t.x[fi] * sc + ox;
    const fy = t.z[fi] * sc + oz;
    g.moveTo(fx - Math.sin(a) * 5, fy + Math.cos(a) * 5);
    g.lineTo(fx + Math.sin(a) * 5, fy - Math.cos(a) * 5);
    g.stroke();
    this.mapBase = off;
  }

  _drawMinimap() {
    const g = this.mapCtx;
    const m = this.mapT;
    if (!g || !m) return;
    g.clearRect(0, 0, m.size, m.size);
    g.drawImage(this.mapBase, 0, 0);
    for (const b of this.boxes) {
      if (!b.live) continue;
      const p = this.track.worldOf(b.q, b.lat, this._tmp);
      g.fillStyle = 'rgba(255,243,210,.95)';
      g.fillRect(p.x * m.sc + m.ox - 1.5, p.z * m.sc + m.oz - 1.5, 3, 3);
    }
    for (const k of this.karts) {
      const p = this.track.worldOf(k.q, k.lat, this._tmp);
      const x = p.x * m.sc + m.ox;
      const y = p.z * m.sc + m.oz;
      g.beginPath();
      g.arc(x, y, k === this.me ? 5 : 4, 0, Math.PI * 2);
      g.fillStyle = hex6(k.color);
      g.globalAlpha = k.ghost ? 0.45 : 1;
      g.fill();
      if (k === this.me) {
        g.lineWidth = 2;
        g.strokeStyle = '#fff';
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  /** Name tags over rival karts, projected from the live camera. */
  _updateTags() {
    this.camera.updateMatrixWorld();
    for (const k of this.karts) {
      if (!k.tag) continue;
      if (!k.seen || this.phase === 'results') { k.tag.classList.remove('on'); continue; }
      _v3.copy(k.anchor.position);
      _v3.y = 2.4;
      _v3.project(this.camera);
      if (_v3.z > 1 || Math.abs(_v3.x) > 1.2 || Math.abs(_v3.y) > 1.2) {
        k.tag.classList.remove('on');
        continue;
      }
      k.tag.classList.add('on');
      k.tag.style.left = `${(_v3.x * 0.5 + 0.5) * this.vw}px`;
      k.tag.style.top = `${(-_v3.y * 0.5 + 0.5) * this.vh}px`;
      const gap = Math.round((this._progress(k) - this._progress(this.me)) * LAP_UNITS);
      if (k._gap !== gap) {
        k._gap = gap;
        k.tagGap.textContent = k.ghost ? 'away' : gap > 0 ? `+${gap}m` : `${gap}m`;
      }
    }
  }

  // ------------------------------------------------------------------ audio -
  /**
   * §6 — one sawtooth drone per kart through a shared lowpass, ours loudest.
   * A room-local WebAudio graph, exactly the pattern drift.js uses, built after
   * the first gesture (the splash) so no context is ever created at import time.
   */
  _startEngines() {
    if (this.actx || this.game.audio?.muted) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    try { this.actx = new AC(); } catch { this.actx = null; return; }
    const ctx = this.actx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const master = ctx.createGain();
    master.gain.value = 0.16;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.7;
    lp.connect(master);
    master.connect(ctx.destination);
    this.engineBus = { master, lp };
    for (const k of this.karts) {
      try {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = 80;
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(lp);
        osc.start();
        k.engine = { osc, gain: g };
      } catch { k.engine = null; }
    }
  }

  _updateEngines() {
    const ctx = this.actx;
    if (!ctx || this.game.audio?.muted) return;
    const now = ctx.currentTime;
    for (const k of this.karts) {
      const e = k.engine;
      if (!e) continue;
      const mine = k === this.me;
      const d = mine ? 0 : Math.hypot(
        k.anchor.position.x - this.me.anchor.position.x,
        k.anchor.position.z - this.me.anchor.position.z,
      );
      const near = mine ? 1 : clamp(1 - d / 42, 0, 1);
      const vol = (this.phase === 'count' || this.phase === 'race' || this.phase === 'done')
        ? (mine ? 0.5 : 0.16) * near * (0.35 + 0.65 * clamp(k.v / V_MAX, 0, 1.3))
        : 0;
      const idle = this.phase === 'count' ? 0.25 + Math.sin(this.time * 9 + k.slot) * 0.12 : 0;
      try {
        e.osc.frequency.setTargetAtTime(80 + (k.v + idle * 20) * 11, now, 0.05);
        e.gain.gain.setTargetAtTime(vol, now, 0.08);
      } catch { /* a stalled context must never break the frame */ }
    }
    if (this.engineBus) {
      try {
        this.engineBus.lp.frequency.setTargetAtTime(
          700 + clamp(this.me.v / V_MAX, 0, 1.5) * 1600, now, 0.1,
        );
      } catch { /* ignore */ }
    }
  }

  _stopEngines() {
    for (const k of this.karts) {
      const e = k.engine;
      if (!e) continue;
      try { e.osc.stop(); } catch { /* already stopped */ }
      try { e.osc.disconnect(); e.gain.disconnect(); } catch { /* ignore */ }
      k.engine = null;
    }
    if (this.engineBus) {
      try { this.engineBus.lp.disconnect(); this.engineBus.master.disconnect(); } catch { /* ignore */ }
      this.engineBus = null;
    }
    if (this.actx) {
      try { this.actx.close(); } catch { /* ignore */ }
      this.actx = null;
    }
  }

  // --------------------------------------------------------------- results --
  /** §6 — checkered flag, podium, confetti, and the payout counting up. */
  _showResults() {
    if (this.phase === 'results') { this._renderBoard(); return; }
    this.phase = 'results';
    this.hud.classList.remove('on');
    this.tip.style.opacity = '0';
    this.f.lights.classList.remove('on');
    for (const k of this.karts) k.tag?.classList.remove('on');

    const rows = this.results || [];
    const mine = rows.find((r) => r.slot === this.me.slot);
    const place = mine ? mine.place : (this._placeOf.get(this.me) || 6);
    const laps = this.me.laps;
    const bestOfRace = rows.reduce((b, r) => (r.best > 0 && (!b || r.best < b) ? r.best : b), 0);
    const fastest = !!(this.me.bestLap && bestOfRace && this.me.bestLap <= bestOfRace);
    const boxes = this.me.boxes;
    const score = 1000 * (7 - place) + 40 * laps + (fastest ? 200 : 0) + 10 * boxes;

    // §4.8: a ghost or a DNF never calls finish() and is paid nothing
    const paid = this.me.finished && !this.me.ghost;
    let payout = 0;
    if (paid) {
      this._payout = { score, place, laps, fastest, boxes };
      payout = this.coinsForScore(score);
      this.finish(score);
    }
    const prevBest = this.game.state.bests?.kart || 0;
    const isBest = paid && score > prevBest;

    this._buildPodium(rows);
    this._confettiBurst(90);
    this.game.audio?.play?.(place === 1 ? 'success' : 'ding');

    const title = place === 1 ? 'Chequered flag!'
      : place <= 3 ? 'On the podium' : paid ? 'Good scrap out there' : 'Race over';
    const card = document.createElement('div');
    card.className = 'mg-kart-card';
    card.innerHTML = `
      <div class="mg-kart-box">
        <div class="mg-kart-title">${title}</div>
        <div class="mg-kart-sub">${
  paid ? `You finished ${ordinal(place)} of 6 at Capy Speedway.` : 'You did not take the flag, so no coins this time.'}</div>
        <div data-a="board"></div>
        <div class="mg-kart-rows">
          <div class="mg-kart-row"><span>Finishing place</span><b>${ordinal(place)}</b></div>
          <div class="mg-kart-row"><span>Laps completed</span><b>${laps} / ${LAPS}</b></div>
          <div class="mg-kart-row"><span>Paw boxes</span><b>${boxes}</b></div>
          <div class="mg-kart-row"><span>Best lap</span><b>${lapTime(this.me.bestLap)}${
  fastest ? '<span class="mg-kart-tag2">FASTEST</span>' : ''}</b></div>
          <div class="mg-kart-row total"><span>Score</span><b>${score.toLocaleString()}</b></div>
          <div class="mg-kart-row pay"><span>Coins earned</span><b>${COIN_ICO}<span data-a="coins">0</span></b></div>
        </div>
        <div class="mg-kart-sub">Best race score: <b>${Math.max(prevBest, paid ? score : 0).toLocaleString()}</b>${
  isBest ? '<span class="mg-kart-tag2">NEW BEST</span>' : ''}</div>
        <div class="mg-kart-btns">
          <button class="mg-kart-btn" data-a="again">Race again</button>
          <button class="mg-kart-btn alt" data-a="back">Back to the paddock</button>
        </div>
      </div>`;
    this.cardHost.appendChild(card);
    this.card = card;
    this.boardEl = card.querySelector('[data-a="board"]');
    this._renderBoard();
    this._countCoins(card.querySelector('[data-a="coins"]'), payout);
    card.querySelector('[data-a="again"]').onclick = () => {
      this.game.audio?.play?.('click');
      this._playAgain();
    };
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    };
  }

  _renderBoard() {
    const el = this.boardEl;
    if (!el) return;
    const rows = this.results;
    if (!rows || !rows.length) {
      el.innerHTML = '<div class="mg-kart-wait">waiting for the rest of the field...</div>';
      return;
    }
    el.innerHTML = `<div class="mg-kart-grid">${rows.map((r) => {
      const k = this._bySlot(r.slot);
      const me = r.slot === this.me.slot;
      return `<div class="mg-kart-grow${me ? ' me' : ''}">
        <span class="n">${ordinal(r.place)}</span>
        <i style="background:${hex6(k ? k.color : 0xb08a5a)}"></i>
        <span>${esc(r.name)}${me ? ' (you)' : ''}</span>
        <b>${r.laps >= LAPS ? lapTime(r.ms) : `${r.laps} laps`}</b></div>`;
    }).join('')}</div>`;
  }

  _countCoins(el, total) {
    if (!el) return;
    if (total <= 0) { el.textContent = '0'; return; }
    let shown = 0;
    const stepN = Math.max(1, Math.round(total / 26));
    const tick = () => {
      if (this.disposed || !el.isConnected) return;
      shown = Math.min(total, shown + stepN);
      el.textContent = String(shown);
      if (shown < total) {
        this._coinTimer = setTimeout(tick, 34);
      } else {
        this.game.audio?.play?.('coin');
      }
    };
    this._coinTimer = setTimeout(tick, 340);
  }

  /**
   * The top three hop on tiered blocks beside the start straight. The drivers
   * are the avatars we already built, reparented off their karts: nothing new is
   * allocated and the field's cosmetics carry straight onto the rostrum.
   */
  _buildPodium(rows) {
    const t = this.track;
    const fin = t.at(S_FIN + 26, this._tmp);
    const off = t.safeOffset(-(fin.hw * WALL_LAT + 7), fin.curv);
    const root = new THREE.Group();
    root.position.set(fin.x - Math.sin(fin.ang) * off, 0, fin.z + Math.cos(fin.ang) * off);
    root.rotation.y = Math.PI / 2 - fin.ang + Math.PI / 2;
    this.scene.add(root);
    this.podium = { root, hops: [] };

    const heights = [2.0, 1.4, 0.9];
    const order = [1, 0, 2];        // 2nd, 1st, 3rd left to right
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const x = (order.indexOf(i) - 1) * 2.4;
      parts.push({ geo: new THREE.BoxGeometry(2.2, heights[i], 2.2), x, y: heights[i] / 2, color: i === 0 ? GOLD : i === 1 ? 0xd6dbe2 : 0xd39a6a });
      parts.push({ geo: new THREE.BoxGeometry(2.36, 0.16, 2.36), x, y: heights[i] + 0.08, color: CREAM });
    }
    const blocks = new THREE.Mesh(mergeParts(parts), this.vcMat);
    blocks.receiveShadow = true;
    root.add(blocks);
    this.geos.push(blocks.geometry);

    const top = (rows && rows.length ? rows : this._order.map((k, i) => ({ slot: k.slot, place: i + 1 })))
      .slice()
      .sort((a, b) => a.place - b.place)
      .slice(0, 3);
    for (let i = 0; i < top.length; i++) {
      const k = this._bySlot(top[i].slot);
      if (!k) continue;
      k.onPodium = true;              // its kart stays parked where it finished
      const seat = new THREE.Group();
      seat.position.set((order.indexOf(i) - 1) * 2.4, heights[i] + 0.16, 0);
      root.add(seat);
      k.driver.group.position.set(0, 0, 0);
      k.driver.group.rotation.set(0, 0, 0);
      k.driver.group.scale.setScalar(1);
      k.driver.setAnim('dance');
      seat.add(k.driver.group);
      this.podium.hops.push({ seat, driver: k.driver, phase: i * 0.6, base: heights[i] + 0.16 });
    }
    this._podiumCam = true;
  }

  _playAgain() {
    this._clearCard();
    this.boardEl = null;
    if (this.podium) {
      // hand the drivers back to their karts before the podium is torn down
      for (const h of this.podium.hops) h.seat.remove(h.driver.group);
      this.scene.remove(this.podium.root);
      disposeObject(this.podium.root);
      this.podium = null;
      this._podiumCam = false;
    }
    for (const k of this.karts) {
      k.driver.group.scale.setScalar(0.85);
      k.driver.group.position.set(0, 0.5, -0.18);
      k.driver.group.rotation.set(0, 0, 0);
      k.driver.setAnim('sit');
      k.tilt.add(k.driver.group);
      k.anchor.visible = true;
    }
    // a replay is always a practice run: the race we joined is over (§5)
    this._leaveRace();
    this.phase = 'splash';
    this._resetRace();
    this._clearCard();
    this._beginCountdown();
  }

  /** Drop out of race mode but keep the circuit, exactly like sled.js. */
  _leaveRace() {
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this.net = null;
    this._clearCtx();
  }

  /** Drop the handshake we consumed, without stomping a newer one (§5). */
  _clearCtx() {
    if (this.ctxRef && this.game.__kartCtx === this.ctxRef) this.game.__kartCtx = null;
    this.ctxRef = null;
  }

  // -------------------------------------------------------------- teardown --
  quit() {
    if (this.disposed) return;
    if (this.net && !this.net.ended) this.game.net?.send?.({ t: 'kart-leave' });
    super.quit();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this._endTimer) clearTimeout(this._endTimer);
    if (this._coinTimer) clearTimeout(this._coinTimer);
    this._endTimer = 0;
    this._coinTimer = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.length = 0;
    for (const [target, type, fn, opts] of this.listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this.listeners.length = 0;
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this._stopEngines();
    this._clearCtx();
    this.keys.clear();

    for (const k of this.karts) {
      k.tag?.remove();
      k.tag = null;
      k.driver?.dispose?.();
      k.driver = null;
    }
    this.karts.length = 0;
    this.me = null;

    if (this.scene) {
      disposeObject(this.scene);
      this.scene.background = null;
      this.scene.clear();
      this.scene = null;
    }
    for (const g of this.geos) g.dispose?.();
    this.geos.length = 0;
    for (const m of this.mats) m.dispose?.();
    this.mats.length = 0;
    for (const t of this.texs) t.dispose?.();
    this.texs.length = 0;

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      this.renderer.domElement?.remove();
      this.renderer = null;
    }
    this.styleEl?.remove();
    this.wrap?.remove();
    this.boxIM = null;
    this.hazIM = null;
    this.projIM = null;
    this.pfx = null;
    this.sparkIM = null;
    this.confIM = null;
    this.lines = null;
    this.podium = null;
    this.mapBase = null;
    this.mapCtx = null;
  }
}
