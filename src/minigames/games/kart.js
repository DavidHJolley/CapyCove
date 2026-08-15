import * as THREE from 'three';
import { Minigame } from '../minigame.js';
import { makeToon, makeGlow, canvasTexture, disposeObject } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BODY_COLORS } from '../../../shared/constants.js';
import {
  TRACK_ORDER, DEFAULT_TRACK, getTrack, isTrackId, buildTrack, buildTrackWorld,
  mergeParts, hazardPose, hazardHits, frac1,
  G_SLOPE, DOWNHILL_CEIL_MUL, GRAVITY_AIR, AIR_STEER, AIR_MIN_MS,
  LAND_BOOST_MS, LAND_BOOST_TARGET, LAND_HARD_YAW,
  HAZ_HIT_MS, HAZ_IMMUNE_MS, HAZ_SPEED_MUL,
} from './kart-tracks.js';
import { KartHud } from './kart-hud.js';

/**
 * Capy Karts: six capybaras, three laps, four cozy circuits.
 *
 * Built to docs/KARTS.md (FROZEN) plus its GRAND PRIX AMENDMENT. Read those
 * first; this file is the racer client and follows them number for number.
 *
 * TRACK SPACE. Each circuit is a closed centripetal Catmull-Rom loop scale-locked
 * to its own `LAP_UNITS`, and every kart is stored as (q, lat, yaw):
 *   q    normalised lap progress, 0 at the finish line, wraps 1 -> 0
 *   lat  lateral offset as a fraction of the local half-width (0 centre,
 *        +-1 the white line, +-1.85 the barrier)
 *   yaw  heading MINUS the track tangent, wrapped to -pi..pi
 * x/y/z never touch the wire: they are `posAt(s)` plus `lat * halfWidth`, which
 * is why server/kart.js needs no track geometry at all. **Elevation is CLIENT
 * geometry** (§A1): the y column rides the control points, shapes the road mesh
 * and drives the slope physics of §A3, and never travels.
 *
 * THREE MODULES, ONE RACE.
 *   `kart-tracks.js` (GP1) owns the registry: four rows of numbers plus the
 *     theme bundles. We read `TRACKS` through the frozen row shape only and
 *     never reach into its internals.
 *   `kart-hud.js` (GP3) owns every DOM node of the race UI behind the ten-method
 *     interface of §A7. This file keeps the 3D scene, the camera, the audio and
 *     the Minigame lifecycle, and hands the HUD one reused view object a frame.
 *   this file owns the driving.
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
 *     control penalty lands until `kart-hit` says so (§4 decision 1, §A2).
 */

// ============================================================== contract ====
const LAPS = 3;
const KART_LIGHTS_MS = 3200;   // §3.4
const RACE_MAX_MS = 360000;
const LOCAL_GRACE_MS = 15000;  // practice only; a race ends on the server's word
const SEND_HZ = 10;            // kart-in
const INTERP_MS = 120;         // remote kart render delay

/**
 * The ACTIVE track's numbers. The engine mounts exactly one minigame at a time,
 * so the circuit lives here rather than threading `this.` through the three
 * hundred call sites that read it; `_selectTrack` is the only writer.
 */
let LAP_UNITS = 545;           // §A1 scale lock, per track
let S_FIN = 30.0;              // finish line, units along the spline from points[0]
let CHECKPOINTS = 6;           // §A1.3 bits; crossing q = k/CHECKPOINTS sets k
let CP_MASK = 0b111111;        // all checkpoint bits set

// ---- §A3 elevation, grip and airtime. Client physics only; never on the wire.
// The constants themselves are GP1's (one source for the two files that have to
// agree); only the two numbers §A3 states in terms of V_MAX are resolved here.
const DOWNHILL_CEIL = 22.0 * DOWNHILL_CEIL_MUL;  // 25.3 — gravity's own ceiling
const LAND_CLEAN = 0.35;             // |yaw| under this lands you a boost
const LAND_HARD = LAND_HARD_YAW;     // |yaw| over this costs you 30% of your speed

// ---- §A6 wrong way
const WRONGWAY_MS = 1200;
const WRONGWAY_MIN_V = 5.0;
const WRONGWAY_CLEAR_MS = 400;
const WRONGWAY_LP_HZ = 400;

// ---- §A4 the roster: five sidegrades, four stats, every kart summing to 12.
const KARTS = {
  coco: { id: 'coco', name: 'Coconut Cruiser', blurb: 'round tub, husk fenders', acc: 3, vmax: 3, han: 3, wgt: 3, runs: 0 },
  reef: { id: 'reef', name: 'Reef Racer', blurb: 'low wedge, coral fin', acc: 4, vmax: 4, han: 3, wgt: 1, runs: 0 },
  biscuit: { id: 'biscuit', name: 'Biscuit Barrel', blurb: 'stout barrel, crumb trim', acc: 2, vmax: 2, han: 3, wgt: 5, runs: 0 },
  dart: { id: 'dart', name: 'Dune Dart', blurb: 'needle nose, sand skis', acc: 3, vmax: 5, han: 3, wgt: 1, runs: 10 },
  fern: { id: 'fern', name: 'Fernback', blurb: 'leafy buggy, frond spoiler', acc: 4, vmax: 2, han: 5, wgt: 1, runs: 25 },
};
const KART_ORDER = ['coco', 'reef', 'biscuit', 'dart', 'fern'];
const LS_RUNS = 'cove.kart.runs';
const LS_KART = 'cove.kart.pick';
const LS_TRACK = 'cove.kart.track';

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

// §A1.2 — the eleven boxes are frozen per track in (q, lat), in the registry.
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
 * §A4 — the kart pick, the track pick and the races-run count live in
 * localStorage: an unlock here is a CEREMONY, never a gate, and five
 * equal-total sidegrades are not worth a server round trip. A locked-down
 * browser (private mode, storage disabled) simply always races the default.
 */
function readLS(key, dflt) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v === null || v === undefined ? dflt : v;
  } catch { return dflt; }
}
function writeLS(key, value) {
  try { globalThis.localStorage?.setItem(key, String(value)); } catch { /* no storage, no ceremony */ }
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

// ------------------------------------------------------------- the kart ----
/**
 * §A4 — five shells, one footprint. The chassis box, the wheel mounts and the
 * seat all stay where they were, so a kart choice changes the SILHOUETTE and the
 * four stat multipliers and nothing else about how the thing drives. White
 * vertex colour throughout: the racer's tint rides instanceColor.
 */
function kartBodyGeo(style) {
  switch (style) {
    case 'reef': // low wedge with a coral dorsal fin
      return mergeParts([
        { geo: new THREE.BoxGeometry(1.16, 0.24, 1.62), y: 0.3 },
        { geo: new THREE.ConeGeometry(0.5, 1.0, 4), y: 0.34, z: 1.0, rx: Math.PI / 2, ry: Math.PI / 4 },
        { geo: new THREE.BoxGeometry(1.36, 0.14, 0.7), y: 0.26, z: 0.1 },
        { geo: new THREE.BoxGeometry(0.86, 0.36, 0.5), y: 0.5, z: -0.62 },
        { geo: new THREE.ConeGeometry(0.34, 0.9, 3), y: 0.86, z: -0.5, rx: -0.25 },
        { geo: new THREE.BoxGeometry(1.16, 0.08, 0.34), y: 0.92, z: -0.86 },
      ]);
    case 'biscuit': // a stout barrel with crumb trim
      return mergeParts([
        { geo: new THREE.CylinderGeometry(0.56, 0.56, 1.5, 12), y: 0.5, rx: Math.PI / 2 },
        { geo: new THREE.CylinderGeometry(0.6, 0.6, 0.16, 12), y: 0.5, z: 0.6, rx: Math.PI / 2 },
        { geo: new THREE.CylinderGeometry(0.6, 0.6, 0.16, 12), y: 0.5, z: -0.6, rx: Math.PI / 2 },
        { geo: new THREE.BoxGeometry(1.34, 0.2, 0.66), y: 0.3, z: 0.1 },
        { geo: new THREE.SphereGeometry(0.3, 8, 6), y: 0.98, z: -0.62 },
        { geo: new THREE.BoxGeometry(0.96, 0.12, 0.3), y: 1.06, z: -0.8 },
      ]);
    case 'dart': // needle nose on sand skis
      return mergeParts([
        { geo: new THREE.BoxGeometry(0.86, 0.24, 1.5), y: 0.32 },
        { geo: new THREE.ConeGeometry(0.34, 1.5, 6), y: 0.36, z: 1.24, rx: Math.PI / 2 },
        { geo: new THREE.BoxGeometry(1.4, 0.1, 0.5), y: 0.22, z: 0.2 },
        { geo: new THREE.BoxGeometry(0.2, 0.1, 1.5), x: -0.66, y: 0.14, z: 0.3, rz: 0.06 },
        { geo: new THREE.BoxGeometry(0.2, 0.1, 1.5), x: 0.66, y: 0.14, z: 0.3, rz: -0.06 },
        { geo: new THREE.BoxGeometry(0.82, 0.42, 0.44), y: 0.56, z: -0.6 },
        { geo: new THREE.BoxGeometry(1.0, 0.08, 0.26), y: 1.0, z: -0.84 },
      ]);
    case 'fern': // an open leafy buggy with a frond spoiler
      return mergeParts([
        { geo: new THREE.BoxGeometry(1.0, 0.22, 1.44), y: 0.32 },
        { geo: new THREE.BoxGeometry(1.36, 0.14, 0.2), y: 0.36, z: 0.74 },
        { geo: new THREE.BoxGeometry(0.12, 0.12, 1.5), x: -0.56, y: 0.5, z: 0.05 },
        { geo: new THREE.BoxGeometry(0.12, 0.12, 1.5), x: 0.56, y: 0.5, z: 0.05 },
        { geo: new THREE.ConeGeometry(0.44, 0.7, 4), y: 0.42, z: 0.94, rx: Math.PI / 2, ry: Math.PI / 4 },
        { geo: new THREE.BoxGeometry(0.86, 0.44, 0.44), y: 0.58, z: -0.58 },
        { geo: new THREE.ConeGeometry(0.5, 1.1, 4), y: 1.02, z: -0.9, rx: 1.35, sz: 0.3 },
      ]);
    default: // 'coco' — the round tub with husk fenders
      return mergeParts([
        { geo: new THREE.BoxGeometry(1.1, 0.3, 1.5), y: 0.34 },
        { geo: new THREE.SphereGeometry(0.62, 12, 8), y: 0.42, sz: 1.15, sy: 0.72 },
        { geo: new THREE.BoxGeometry(0.78, 0.26, 0.5), y: 0.55, z: 0.52 },
        { geo: new THREE.ConeGeometry(0.46, 0.6, 4), y: 0.42, z: 0.92, rx: Math.PI / 2, ry: Math.PI / 4 },
        { geo: new THREE.BoxGeometry(1.34, 0.18, 0.62), y: 0.3, z: 0.12 },
        { geo: new THREE.BoxGeometry(0.9, 0.5, 0.42), y: 0.62, z: -0.6 },
        { geo: new THREE.BoxGeometry(1.02, 0.1, 0.36), y: 1.02, z: -0.78 },
        { geo: new THREE.BoxGeometry(0.1, 0.3, 0.14), x: -0.4, y: 0.87, z: -0.74 },
        { geo: new THREE.BoxGeometry(0.1, 0.3, 0.14), x: 0.4, y: 0.87, z: -0.74 },
      ]);
  }
}

/** Everything that is NOT the racer's colour, so the tint never touches it. */
function kartTrimGeo(style) {
  const parts = [
    { geo: new THREE.BoxGeometry(0.66, 0.12, 0.44), y: 0.5, z: -0.18, color: 0x8a6642 },
    { geo: new THREE.BoxGeometry(0.62, 0.34, 0.1), y: 0.68, z: -0.36, color: 0x8a6642 },
    { geo: new THREE.TorusGeometry(0.2, 0.045, 5, 10), y: 0.78, z: 0.42, rx: 1.15, color: 0x3a3540 },
    { geo: new THREE.CylinderGeometry(0.04, 0.04, 0.24, 5), y: 0.66, z: 0.46, rx: 0.42, color: 0x3a3540 },
    { geo: new THREE.BoxGeometry(0.9, 0.12, 0.12), y: 0.24, z: 0.98, color: CREAM },
    { geo: new THREE.BoxGeometry(0.86, 0.12, 0.12), y: 0.24, z: -0.86, color: CREAM },
    { geo: new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6), x: -0.3, y: 0.9, z: -0.86, rx: 1.2, color: 0x9aa2ad },
    { geo: new THREE.CylinderGeometry(0.08, 0.1, 0.5, 6), x: 0.3, y: 0.9, z: -0.86, rx: 1.2, color: 0x9aa2ad },
  ];
  // one signature flourish each, in its own colour so it survives the tint
  if (style === 'reef') parts.push({ geo: new THREE.TorusGeometry(0.22, 0.06, 4, 8, Math.PI), y: 0.4, z: -0.95, rx: 1.2, color: 0xe8657a });
  if (style === 'biscuit') {
    for (let i = 0; i < 5; i++) {
      parts.push({ geo: new THREE.SphereGeometry(0.09, 5, 4), x: -0.4 + i * 0.2, y: 1.02, z: 0.1 + (i % 2) * 0.2, color: 0xd39a2f });
    }
  }
  if (style === 'dart') parts.push({ geo: new THREE.ConeGeometry(0.12, 0.3, 4), y: 0.42, z: 1.9, rx: Math.PI / 2, color: GOLD });
  if (style === 'fern') {
    for (const s of [-1, 1]) {
      parts.push({ geo: new THREE.ConeGeometry(0.2, 0.7, 4), x: s * 0.62, y: 0.8, z: 0.1, rz: -s * 0.5, color: 0x7ac74f });
    }
  }
  if (style === 'coco') parts.push({ geo: new THREE.SphereGeometry(0.16, 7, 5), y: 0.82, z: 0.86, color: 0x6b4f35 });
  return mergeParts(parts);
}

/** §A4 — the four stats resolved into the numbers §3.1 drives with. */
function kartStats(id) {
  const k = KARTS[id] || KARTS.coco;
  return {
    id: k.id,
    name: k.name,
    vmax: V_MAX * (0.98 + 0.02 * k.vmax),
    accel: ACCEL * (0.90 + 0.05 * k.acc),
    han: 0.92 + 0.04 * k.han,
    offMul: OFF_MUL + 0.03 * (k.wgt - 3),
    hitMul: 1 - 0.04 * (k.wgt - 3),
    landHard: LAND_HARD + 0.05 * (k.wgt - 3),
  };
}

/** The chosen kart, coerced to something real. Unknown ids become 'coco'. */
function kartIdOf(v) { return KARTS[v] ? v : 'coco'; }

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

// ==================================================================== css ====
/**
 * Only what kart.js still owns: the canvas shell, the vignette/flash overlays,
 * the world-anchored name tags, the big centre-screen callouts and the two cards
 * (the splash and its pickers). Every HUD element of A7 lives in kart-hud.js
 * with its own <style>, which is why nothing here is called `mg-kart-*` any
 * more: two modules must never race to define the same class.
 */
const CSS = `
.mg-kk-wrap{position:absolute;inset:0;overflow:hidden;font-family:var(--font);color:var(--ink);
  user-select:none;-webkit-user-select:none;background:#bfe3f2;cursor:default;}
.mg-kk-wrap canvas.mg-kk-gl{position:absolute;inset:0;width:100%;height:100%;display:block;}
.mg-kk-vig{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .25s ease;
  background:radial-gradient(ellipse 64% 60% at 50% 52%,rgba(0,0,0,0) 42%,rgba(24,38,58,.5) 100%);}
.mg-kk-vig.wrong{background:radial-gradient(ellipse 64% 60% at 50% 52%,rgba(0,0,0,0) 34%,rgba(232,101,122,.6) 100%);
  animation:mg-kk-wrong 1.1s ease-in-out infinite;}
@keyframes mg-kk-wrong{50%{opacity:.42}}
.mg-kk-flash{position:absolute;inset:0;pointer-events:none;opacity:0;}
.mg-kk-flash.hit{animation:mg-kk-fx .45s ease-out;
  background:radial-gradient(ellipse at 50% 55%,rgba(232,101,122,0) 32%,rgba(232,101,122,.85) 100%);}
.mg-kk-flash.soak{animation:mg-kk-fx .55s ease-out;
  background:radial-gradient(ellipse at 50% 55%,rgba(79,179,232,0) 25%,rgba(120,205,245,.9) 100%);}
.mg-kk-flash.boost{animation:mg-kk-fx .5s ease-out;
  background:radial-gradient(ellipse at 50% 62%,rgba(255,235,170,0) 28%,rgba(255,226,140,.7) 100%);}
.mg-kk-flash.bonk{animation:mg-kk-fx .5s ease-out;
  background:radial-gradient(ellipse at 50% 58%,rgba(122,199,79,0) 30%,rgba(150,214,110,.8) 100%);}
.mg-kk-flash.land{animation:mg-kk-fx .35s ease-out;
  background:radial-gradient(ellipse at 50% 80%,rgba(255,255,255,0) 42%,rgba(255,255,255,.55) 100%);}
@keyframes mg-kk-fx{from{opacity:1}to{opacity:0}}

.mg-kk-hud{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .3s ease;}
.mg-kk-hud.on{opacity:1;}

.mg-kk-big{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  pointer-events:none;}
.mg-kk-banner{position:absolute;top:34%;left:0;right:0;text-align:center;font-size:52px;
  font-weight:900;color:#fff;text-shadow:0 6px 0 rgba(45,36,23,.32);letter-spacing:.04em;
  animation:mg-kk-ban 1.9s ease-out forwards;pointer-events:none;}
@keyframes mg-kk-ban{0%{opacity:0;translate:-40px 0}
  14%{opacity:1;translate:0 0}72%{opacity:1;translate:0 0}to{opacity:0;translate:40px 0}}

.mg-kk-pops{position:absolute;left:50%;top:56%;translate:-50% 0;width:0;pointer-events:none;}
.mg-kk-pop{position:absolute;left:0;top:0;translate:-50% 0;white-space:nowrap;font-weight:900;
  font-size:26px;color:#fff;text-shadow:0 3px 0 rgba(45,36,23,.35);animation:mg-kk-pop 1s ease-out forwards;}
.mg-kk-pop.gold{color:var(--gold);}.mg-kk-pop.sky{color:#8fdcff;}.mg-kk-pop.bad{color:#ff9bab;}
@keyframes mg-kk-pop{from{opacity:0;translate:-50% 16px;scale:.6}
  25%{opacity:1;translate:-50% -6px;scale:1.14}to{opacity:0;translate:-50% -66px;scale:1}}

.mg-kk-tags{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden;}
.mg-kk-tag{position:absolute;left:0;top:0;translate:-50% -100%;display:none;align-items:center;gap:6px;
  background:rgba(255,253,246,.9);border-radius:999px;padding:2px 9px 2px 4px;font-size:11.5px;
  font-weight:800;white-space:nowrap;box-shadow:0 3px 10px rgba(26,52,78,.28);}
.mg-kk-tag.on{display:flex;}
.mg-kk-tag i{width:12px;height:12px;border-radius:99px;box-shadow:inset 0 -3px 0 rgba(0,0,0,.2);}
.mg-kk-tag u{text-decoration:none;font-size:10px;color:#8a7a5a;font-weight:900;}

.mg-kk-cards{position:absolute;inset:0;z-index:5;pointer-events:none;}
.mg-kk-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;gap:13px;
  padding:22px;text-align:center;pointer-events:auto;overflow-y:auto;
  background:linear-gradient(180deg,rgba(20,32,44,.3),rgba(20,32,44,.72));}
.mg-kk-card>*{margin:auto 0;}
.mg-kk-card.out{animation:mg-kk-out .28s ease forwards;pointer-events:none;}
@keyframes mg-kk-out{to{opacity:0;scale:1.05}}
.mg-kk-box{background:var(--cream);border-radius:28px;padding:24px 30px;width:min(560px,94vw);
  box-shadow:var(--shadow);animation:mg-kk-in .3s ease;}
@keyframes mg-kk-in{from{opacity:0;translate:0 20px;scale:.94}}
.mg-kk-title{font-size:40px;font-weight:900;color:var(--accent);line-height:1;}
.mg-kk-sub{font-weight:700;color:#8a7a5a;font-size:13px;margin-top:6px;}
.mg-kk-keys{display:flex;gap:7px;justify-content:center;margin:14px 0 10px;flex-wrap:wrap;}
.mg-kk-key{background:#fff;border:2px solid #e3d9c4;border-radius:9px;padding:4px 10px;
  font-weight:900;font-size:13px;box-shadow:0 2px 0 #e3d9c4;}
.mg-kk-key u{text-decoration:none;color:#a2937a;font-weight:800;margin-left:5px;font-size:11px;}
.mg-kk-rules{display:flex;flex-direction:column;gap:7px;text-align:left;margin:6px 0;}
.mg-kk-rule{display:flex;gap:10px;align-items:center;font-size:13px;font-weight:700;color:#5c5140;}
.mg-kk-swatch{width:26px;height:26px;border-radius:8px;flex:none;box-shadow:inset 0 -3px 0 rgba(0,0,0,.18);}
.mg-kk-btns{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;}
.mg-kk-btn{background:var(--accent);color:#fff;border:3px solid #fff;font-family:var(--font);
  font-weight:900;font-size:16px;padding:11px 24px;border-radius:999px;cursor:pointer;
  box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-kk-btn:hover{scale:1.06;}.mg-kk-btn:active{scale:.96;}
.mg-kk-btn.alt{background:var(--accent2);}
.mg-kk-btn.ghost{background:transparent;color:var(--ink);border-color:#d8ccb4;box-shadow:none;}
.mg-kk-blink{margin-top:12px;font-size:12.5px;font-weight:800;color:#a99a80;
  animation:mg-kk-blink 1.5s ease-in-out infinite;}
@keyframes mg-kk-blink{50%{opacity:.35}}
.mg-kk-grid{display:flex;flex-direction:column;gap:5px;margin:12px 0 4px;}
.mg-kk-grow{display:flex;align-items:center;gap:9px;background:var(--card);border-radius:11px;
  padding:6px 12px;font-weight:800;font-size:13px;}
.mg-kk-grow i{width:14px;height:14px;border-radius:99px;box-shadow:inset 0 -3px 0 rgba(0,0,0,.2);}
.mg-kk-grow .n{width:26px;color:#9b8a6c;font-size:11px;}
.mg-kk-grow b{margin-left:auto;font-size:11px;color:#a2937a;}
.mg-kk-grow.me{outline:3px solid var(--accent);outline-offset:-3px;}

.mg-kk-picks{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin:10px 0 2px;}
.mg-kk-pick{background:var(--card);border:3px solid transparent;border-radius:15px;padding:7px 11px;
  font-family:var(--font);font-weight:900;font-size:12.5px;color:#5c5140;cursor:pointer;
  transition:scale .12s ease,border-color .12s ease;min-width:100px;}
.mg-kk-pick:hover{scale:1.05;}
.mg-kk-pick.on{border-color:var(--accent);background:#fff;}
.mg-kk-pick.locked{opacity:.5;cursor:not-allowed;}
.mg-kk-pick u{display:block;text-decoration:none;font-weight:700;font-size:10.5px;color:#a2937a;margin-top:2px;}
.mg-kk-bars{display:flex;gap:3px;justify-content:center;margin-top:5px;}
.mg-kk-bar{width:5px;height:14px;border-radius:3px;background:#e3d9c4;}
.mg-kk-bar.on{background:var(--gold);}
.mg-kk-note{font-size:11.5px;font-weight:800;color:#a99a80;margin-top:8px;}

.mg-kk-quit{position:absolute;right:16px;top:16px;z-index:6;background:rgba(255,253,246,.9);border:0;
  font-family:var(--font);font-weight:800;font-size:13px;padding:9px 16px;border-radius:999px;
  cursor:pointer;box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-kk-quit:hover{scale:1.07;}
.mg-kk-quit b{font-weight:900;opacity:.5;margin-left:6px;font-size:11px;}
.mg-kk-tip{position:absolute;left:50%;bottom:18px;translate:-50% 0;background:rgba(45,36,23,.7);
  color:#fff;font-size:12.5px;font-weight:700;padding:7px 16px;border-radius:999px;
  transition:opacity .6s ease;pointer-events:none;z-index:2;}
`;

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
    this._tmp3 = {};
    this.hud = null;
    this.row = null;           // the active registry row
    this.theme = null;         // the active track's palette, from GP1's THEMES
    this.laps = LAPS;
    this.myKart = kartIdOf(readLS(LS_KART, 'coco'));
    this.runs = Math.max(0, Math.round(Number(readLS(LS_RUNS, 0))) || 0);
    this.stats = kartStats(this.myKart);
    this.wrongT = 0;           // §A6 hysteresis, both directions
    this.wrongOn = false;
    this.wrongDir = 0;
    this.hazImmune = 0;        // §A2 HAZ_IMMUNE_MS, seconds remaining
    this.hazSeen = new Map();  // hazard index -> raceMs of our last claim
    /** The one view object handed to the HUD every frame. Never reallocated. */
    this.view = {
      place: 1, of: 6, raceMs: 0, lapMs: 0, bestMs: 0, v: 0, vmax: V_MAX,
      boost: 0, drift: 0, order: [], karts: [], boxes: [], hazards: [],
      wrong: false, wrongDir: 0,
    };
  }

  // ------------------------------------------------------------- lifecycle -
  mount(root) {
    super.mount(root);
    this.net = this._readCtx();
    // §A4: races run is the only unlock currency, and it counts every mount --
    // finished, DNF or quit, practice included. Placement never matters.
    this.runs += 1;
    writeLS(LS_RUNS, this.runs);
    this._selectTrack(this.net?.track || readLS(LS_TRACK, DEFAULT_TRACK));
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
   * §A1 — resolve the registry row and stamp the module-level track numbers.
   * Everything downstream (the LUT, the grid, the boxes, the checkpoint mask,
   * the minimap, the wire clamp the server mirrors) reads them from here.
   */
  _selectTrack(id) {
    const want = isTrackId(id) ? id : DEFAULT_TRACK;
    this.track = buildTrack(want);       // GP1's LUT: position, pitch, bank, zones
    this.row = this.track.row;
    LAP_UNITS = this.track.LAP_UNITS;
    S_FIN = this.track.sFin;
    CHECKPOINTS = this.track.checkpoints;
    CP_MASK = (1 << CHECKPOINTS) - 1;
    this.theme = this.track.palette;
    this.boxDefs = this.track.boxes;     // the eleven, ids 0..10, in (q, lat)
    this.hazDefs = this.track.hazards;
    if (!this.net) writeLS(LS_TRACK, want);
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
    // §A5: kart-grid carries the track the lobby voted for, and its `laps`.
    const track = String(ctx.grid?.track ?? ctx.track ?? '');
    const laps = Math.round(Number(ctx.grid?.laps ?? ctx.laps));
    this.laps = Number.isFinite(laps) && laps >= 1 && laps <= 9 ? laps : LAPS;
    return {
      race: String(ctx.race ?? ctx.grid?.race ?? ''),
      slots: grid.slice(0, 6),
      you: clamp(Math.round(you), 0, 5),
      track: isTrackId(track) ? track : DEFAULT_TRACK,
      trackName: String(ctx.grid?.trackName || '').slice(0, 32),
      startAt: Number.isFinite(startAt) ? startAt : 0,
      // skew is refined the moment our own kart-go lands
      skew: Number.isFinite(ctx.skew) ? ctx.skew : 0,
      goSeen: false,
      ended: false,
      sendAcc: 0,
      tick: -1,
    };
  }

  /**
   * Roster rows, from the server grid in a race or rolled locally otherwise.
   * §A4: everyone's chosen kart rides the grid echo, so the whole field is
   * rendered in the shells their drivers picked, never five identical shells.
   */
  _roster() {
    if (this.net) {
      return this.net.slots.map((s, i) => {
        const slot = Number.isFinite(s?.slot) ? s.slot : i;
        return {
          slot,
          id: s?.id ?? null,
          ai: !!s?.ai,
          name: String(s?.name || AI_NAMES[i % AI_NAMES.length]).slice(0, 16),
          color: Number.isFinite(s?.color) ? s.color : BODY_COLORS[i % BODY_COLORS.length],
          hat: typeof s?.hat === 'string' ? s.hat : 'none',
          // an unknown id coerces to 'coco' exactly as the server coerces it;
          // a row with no kart at all (an older server) is dealt one by slot so
          // the field still reads as six different karts
          kart: s?.kart ? kartIdOf(s.kart) : KART_ORDER[slot % KART_ORDER.length],
          skill: clamp(Math.round(Number(s?.skill) || 0), 0, 4),
        };
      });
    }
    // practice: pole is ours, the rest are five cozy locals on descending skill
    const me = {
      slot: 0, id: 'me', ai: false,
      name: String(this.game.state.name || 'You').slice(0, 16),
      color: this.game.state.color ?? BODY_COLORS[0],
      hat: this.game.state.hat ?? 'none',
      kart: this.myKart,
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
        kart: KART_ORDER[(i + 1) % KART_ORDER.length],
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

  /**
   * The shell, and then GP3's HUD on top of it. Every element of §A7 lives in
   * kart-hud.js behind the ten-method interface; kart.js keeps only the canvas,
   * the two full-screen overlays, the world-anchored name tags, the centre-screen
   * callouts and the splash card, and never reaches into the HUD's DOM.
   */
  _buildDom(root) {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    this.styleEl = style;

    const wrap = document.createElement('div');
    wrap.className = 'mg-kk-wrap';
    root.appendChild(wrap);
    this.wrap = wrap;

    const vig = document.createElement('div');
    vig.className = 'mg-kk-vig';
    wrap.appendChild(vig);
    this.vig = vig;

    const flash = document.createElement('div');
    flash.className = 'mg-kk-flash';
    wrap.appendChild(flash);
    this.flash = flash;
    this._on(flash, 'animationend', () => { flash.className = 'mg-kk-flash'; });

    // GP3 owns everything inside this node and must leave it clean on dispose()
    const hudRoot = document.createElement('div');
    hudRoot.className = 'mg-kk-hud on';
    wrap.appendChild(hudRoot);
    this.hudRoot = hudRoot;
    this._mountHud();

    const tags = document.createElement('div');
    tags.className = 'mg-kk-tags';
    wrap.appendChild(tags);
    this.tagHost = tags;

    const big = document.createElement('div');
    big.className = 'mg-kk-big';
    wrap.appendChild(big);
    this.bigEl = big;

    const pops = document.createElement('div');
    pops.className = 'mg-kk-pops';
    wrap.appendChild(pops);
    this.popHost = pops;

    const tip = document.createElement('div');
    tip.className = 'mg-kk-tip';
    tip.textContent = 'W to go  .  A/D to steer  .  hold Shift into a corner to drift  .  E throws your item';
    tip.style.opacity = '0';
    wrap.appendChild(tip);
    this.tip = tip;

    const quit = document.createElement('button');
    quit.className = 'mg-kk-quit';
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
    this.cardHost.className = 'mg-kk-cards';
    wrap.appendChild(this.cardHost);
  }

  /**
   * §A7 — build the HUD for the CURRENT roster and track. Rebuilt (never
   * mutated) when a Play Again lands on a different circuit, which is the only
   * time either of those changes.
   */
  _mountHud() {
    try { this.hud?.dispose?.(); } catch { /* a half-built HUD must not trap us */ }
    this.hud = null;
    const t = this.track;
    // §A7's track payload comes straight from GP1 (decimated polyline, yMin/yMax
    // for the elevation shading); `posOf` and the finish-line origin let the HUD
    // put its dots exactly where we put our karts.
    const hudTrack = t.hudTrack();
    hudTrack.posOf = (q, lat, out) => t.worldOf(q, lat, out);
    hudTrack.sFin = t.sFin;
    hudTrack.LAP_UNITS = t.LAP_UNITS;
    const roster = (this.karts.length ? this.karts : this._roster()).map((k) => ({
      slot: k.slot, name: k.name, color: k.color, kart: k.kart, ai: !!k.ai, ghost: !!k.ghost,
    }));
    try {
      this.hud = new KartHud(this.hudRoot, {
        laps: this.laps,
        you: this.me ? this.me.slot : (this.net ? this.net.you : 0),
        track: hudTrack,
        roster,
        // kart.js owns the Minigame lifecycle, so the results furniture hands
        // both decisions back here; onPlay lets the HUD ask for a sound rather
        // than reaching into the audio graph itself.
        onAgain: () => this._playAgain(),
        onQuit: () => this.exitToRoom(),
        onPlay: (name) => this.game.audio?.play?.(name),
      });
      this.hud.mount();
      this.hud.setPhase(this.phase);
    } catch (err) {
      // A broken HUD must never cost the player the race: the world, the
      // controls and the payout all still work without it.
      this.hud = null;
      console.warn('[kart] HUD unavailable', err);
    }
  }

  /** Every HUD call goes through here, so one bad frame cannot stop the race. */
  _hud(fn, ...args) {
    const h = this.hud;
    if (!h || typeof h[fn] !== 'function') return;
    try { h[fn](...args); } catch { /* the HUD is decoration, the race is not */ }
  }

  /**
   * Remove on animationend OR after `ms`, whichever lands first. `animationend`
   * alone is not enough: a backgrounded tab, a compositor stall or a
   * reduced-motion setting can swallow it, and a leftover `.mg-kk-card` spans
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
    if (!this.popHost) return;
    const el = document.createElement('div');
    el.className = `mg-kk-pop ${cls}`;
    el.textContent = text;
    el.style.left = `${(Math.random() - 0.5) * 130}px`;
    el.style.top = `${(Math.random() - 0.5) * 40}px`;
    this.popHost.appendChild(el);
    this._autoRemove(el, 1400);
  }

  /**
   * A centred banner. §A7 hands the countdown numerals, GO! and FINAL LAP to
   * GP3's HUD (kart-hud.js `countdown()` / `lap()`), so this is only ever the
   * finish shout the HUD has no method for; anything the HUD draws must NOT be
   * drawn here as well, or the player reads it twice.
   */
  _banner(text) {
    const el = document.createElement('div');
    el.className = 'mg-kk-banner';
    el.textContent = text;
    this.bigEl.appendChild(el);
    this._autoRemove(el, 2300);
  }

  _flashFx(kind) {
    this.flash.className = 'mg-kk-flash';
    void this.flash.offsetWidth;
    this.flash.className = `mg-kk-flash ${kind}`;
  }

  /** §6 — instructions splash with a visual legend, plus the two pickers. */
  _showSplash() {
    const racing = !!this.net;
    const best = this.game.state.bests?.kart || 0;
    const rows = this.karts.map((k) => `
      <div class="mg-kk-grow${k === this.me ? ' me' : ''}">
        <span class="n">P${k.slot + 1}</span><i style="background:${hex6(k.color)}"></i>
        <span>${esc(k.name)}</span><b>${k === this.me ? 'you' : k.ai ? 'local racer' : ''} . ${
  esc((KARTS[k.kart] || KARTS.coco).name)}</b>
      </div>`).join('');
    const th = this.theme;
    const card = document.createElement('div');
    card.className = 'mg-kk-card';
    card.innerHTML = `
      <div class="mg-kk-box">
        <div class="mg-kk-title">${racing ? 'Grid is set' : 'Capy Karts'}</div>
        <div class="mg-kk-sub">${this.laps} laps of ${esc(this.row.name)}. ${esc(this._trackPitch())}</div>
        <div class="mg-kk-keys">
          <span class="mg-kk-key">W<u>go</u></span>
          <span class="mg-kk-key">S<u>brake</u></span>
          <span class="mg-kk-key">A D<u>steer</u></span>
          <span class="mg-kk-key">SHIFT<u>drift</u></span>
          <span class="mg-kk-key">E<u>item</u></span>
          <span class="mg-kk-key">Q<u>look back</u></span>
        </div>
        <div class="mg-kk-rules">
          <div class="mg-kk-rule"><span class="mg-kk-swatch" style="background:#4fb3e8"></span>
            Hold drift through a corner. Sparks go sky blue, then gold, then coral:
            let go on coral for the longest boost.</div>
          <div class="mg-kk-rule"><span class="mg-kk-swatch" style="background:#7ac74f"></span>
            Drive through a paw box for a melon peel, a splash bubble or a zoom berry.</div>
          <div class="mg-kk-rule"><span class="mg-kk-swatch" style="background:${hex6(th.apron)}"></span>
            ${esc(this._trackHint())}</div>
        </div>
        ${racing ? `<div class="mg-kk-grid">${rows}</div>` : this._pickersHtml()}
        <div class="mg-kk-sub">Best race score: <b>${best.toLocaleString()}</b></div>
        <div class="mg-kk-btns">
          ${racing ? '' : '<button class="mg-kk-btn" data-a="go">Roll out</button>'}
          <button class="mg-kk-btn ghost" data-a="back">${racing ? 'Withdraw' : 'Back to the paddock'}</button>
        </div>
        <div class="mg-kk-blink">${racing ? 'the lights are coming on' : 'or press any key'}</div>
      </div>`;
    this.cardHost.appendChild(card);
    this.card = card;
    if (!racing) this._bindPickers(card);
    const go = card.querySelector('[data-a="go"]');
    if (go) go.onclick = () => this._beginCountdown();
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.quit();
    };
  }

  /** One warm line per circuit, in the cove's own voice. */
  _trackPitch() {
    return {
      sunny: 'Mind the melon.',
      summit: 'Mind the ice on the way down.',
      tangle: 'Mind the vines. And the boulders.',
      glimmer: 'Mind the carts, and land the big one.',
    }[this.row.id] || 'Mind the melon.';
  }

  _trackHint() {
    return {
      sunny: 'The sand slows you down. The tyres are softer than they look.',
      summit: 'Pale patches are ice: less grip, less steering, same top speed. Climbs cost you, descents pay you back.',
      tangle: 'Vines swing and boulders roll on a rhythm. Learn the beat and you can drive straight through.',
      glimmer: 'Carts cross the road on a timer, and the ramp at half distance is worth landing straight.',
    }[this.row.id] || 'The sand slows you down.';
  }

  /** §A4/§A5 — kart and circuit pickers. Practice only; a race is already set. */
  _pickersHtml() {
    const karts = KART_ORDER.map((id) => {
      const k = KARTS[id];
      const locked = this.runs < k.runs;
      const bars = (n) => `<div class="mg-kk-bars">${
        [1, 2, 3, 4, 5].map((i) => `<div class="mg-kk-bar${i <= n ? ' on' : ''}"></div>`).join('')}</div>`;
      return `<button class="mg-kk-pick${id === this.myKart ? ' on' : ''}${locked ? ' locked' : ''}"
        type="button" data-kart="${id}" ${locked ? 'disabled' : ''}>
        ${esc(k.name)}<u>${locked ? `unlocks at ${k.runs} races (${this.runs})` : esc(k.blurb)}</u>
        ${bars(k.acc)}${bars(k.vmax)}${bars(k.han)}${bars(k.wgt)}</button>`;
    }).join('');
    const FOCUS = {
      sunny: 'the classic', summit: 'grip + gradient',
      tangle: 'dodging + nerve', glimmer: 'banking + airtime',
    };
    const tracks = TRACK_ORDER.map((id) => {
      const r = getTrack(id);
      return `<button class="mg-kk-pick${id === this.row.id ? ' on' : ''}" type="button" data-track="${id}">
        ${esc(r.name)}<u>${esc(FOCUS[id] || r.theme)}</u></button>`;
    }).join('');
    return `<div class="mg-kk-sub">Your kart</div><div class="mg-kk-picks">${karts}</div>
      <div class="mg-kk-note">Every kart adds up to the same twelve. Unlocks by playing, never by paying.</div>
      <div class="mg-kk-sub">Circuit</div><div class="mg-kk-picks">${tracks}</div>`;
  }

  _bindPickers(card) {
    for (const el of card.querySelectorAll('[data-kart]')) {
      el.onclick = () => {
        this.myKart = kartIdOf(el.dataset.kart);
        writeLS(LS_KART, this.myKart);
        this.stats = kartStats(this.myKart);
        this.game.audio?.play?.('click');
        this._restartSplash();
      };
    }
    for (const el of card.querySelectorAll('[data-track]')) {
      el.onclick = () => {
        const id = el.dataset.track;
        if (id === this.row.id) return;
        this.game.audio?.play?.('click');
        this._switchTrack(id);
      };
    }
  }

  /** A new shell for the same circuit: the pick has to be visible on the grid. */
  _restartSplash() {
    if (this.phase !== 'splash') return;
    this._rebuildWorld(this.row.id);
  }

  /**
   * A different circuit is a different world. Practice only -- a race's track
   * arrives on kart-grid and never changes under the racer.
   */
  _switchTrack(id) {
    if (this.net || this.phase !== 'splash' || id === this.row.id) return;
    this._rebuildWorld(id);
  }

  /**
   * Tear the world down and build it again on `id`. The renderer, the camera,
   * the DOM shell and the audio graph survive; everything the scene owns does
   * not. Only ever called from the splash, where nothing is in flight.
   */
  _rebuildWorld(id) {
    this._clearCard();
    if (this.podium) {
      for (const h of this.podium.hops) h.seat.remove(h.driver.group);
      this.scene?.remove(this.podium.root);
      disposeObject(this.podium.root);
      this.podium = null;
      this._podiumCam = false;
    }
    for (const k of this.karts) {
      k.tag?.remove();
      k.tag = null;
      k.driver?.dispose?.();
      k.driver = null;
    }
    this.karts.length = 0;
    this.me = null;
    if (this.camera && this.lines) this.camera.remove(this.lines);
    if (this.scene && this.camera) this.scene.remove(this.camera);
    // the circuit owns its own geometry, materials and textures (GP1)
    try { this.world?.dispose?.(); } catch { /* half-built worlds die quietly */ }
    this.world = null;
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
    this.hazards.clear();
    this.projectiles.clear();
    this.parts.length = 0;
    this.sparks.length = 0;
    this.confetti.length = 0;
    this.lines = null;
    this._camInit = false;
    this._selectTrack(id);
    this._buildScene();
    this._buildKarts();
    this._mountHud();
    this._resetRace();
  }

  // ------------------------------------------------------------------ scene -
  /**
   * The renderer and the camera outlive a track change; everything the circuit
   * owns does not. kart-tracks.js builds the whole world -- ribbons, skirt,
   * ground, sky, lights, themed decor, the gantry and the moving hazards -- into
   * one Group behind `buildTrackWorld`, so this file only has to hold the
   * handle, feed it a frame, and dispose it.
   */
  _buildScene() {
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setSize(w, h);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.domElement.className = 'mg-kk-gl';
      this.wrap.insertBefore(this.renderer.domElement, this.vig);
    }

    const scene = new THREE.Scene();
    this.scene = scene;
    if (!this.camera) this.camera = new THREE.PerspectiveCamera(62, w / h, 0.4, 1200);
    this.fov = 62;

    const vc = makeToon(0xffffff, { vertexColors: true });
    this.vcMat = vc;

    this.world = buildTrackWorld(scene, this.track, { vcMat: vc });
    scene.background = new THREE.Color(this.world.fog.color);
    scene.fog = new THREE.Fog(this.world.fog.color, this.world.fog.near, this.world.fog.far);
    this.sun = this.world.sun;
    this.floorY = this.track.yMin - 6;

    this._buildPools();
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

    this.boxIM = new THREE.InstancedMesh(boxGeo(), vc, this.boxDefs.length);
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

    // §A8 speed lines: camera-space planes laid ALONG the screen-space velocity
    const lineGeo = new THREE.PlaneGeometry(0.03, 1.0);
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
    for (let i = 0; i < 24; i++) this.lineSeeds.push(this._reseedLine({}, Math.random()));
  }

  /**
   * §A8 — a streak's own numbers. `off` is where it sits ACROSS the velocity
   * band, `j` is its slice of the +-0.18 rad of spread, and `t` is how far it
   * has travelled down that band. The direction itself is shared by all 24 and
   * recomputed every frame from the camera, which is the whole fix.
   */
  _reseedLine(s, t = 0) {
    s.t = t;
    s.off = rand(-1.7, 1.7);
    s.j = rand(-0.18, 0.18);
    s.len = 0.7 + Math.random() * 1.5;
    s.d = 1.6 + Math.random() * 3.4;
    return s;
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

    // §A4 — one geometry set per SHELL in this field (at most five), not one for
    // the whole grid, so six racers still cost at most eleven kart draw calls.
    const shellMat = makeToon(0xffffff, { unique: true });
    this.mats.push(shellMat);
    this.shells = new Map();
    for (const r of roster) {
      const id = kartIdOf(r.kart);
      if (this.shells.has(id)) { this.shells.get(id).cap++; continue; }
      this.shells.set(id, { cap: 1 });
    }
    for (const [id, sh] of this.shells) {
      sh.body = new THREE.InstancedMesh(kartBodyGeo(id), shellMat, sh.cap);
      sh.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(sh.cap * 3).fill(1), 3);
      sh.trim = new THREE.InstancedMesh(kartTrimGeo(id), this.vcMat, sh.cap);
      for (const im of [sh.body, sh.trim]) {
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.frustumCulled = false;
        im.castShadow = true;
        im.count = 0;
        scene.add(im);
        this.geos.push(im.geometry);
      }
    }
    this.wheelIM = new THREE.InstancedMesh(wheelGeo(), this.vcMat, N * 4);
    this.wheelIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheelIM.frustumCulled = false;
    this.wheelIM.castShadow = true;
    this.wheelIM.count = 0;
    scene.add(this.wheelIM);
    this.geos.push(this.wheelIM.geometry);

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
      tag.className = 'mg-kk-tag';
      tag.innerHTML = `<i style="background:${hex6(r.color)}"></i><span>${esc(r.name)}</span><u data-f="g"></u>`;
      this.tagHost.appendChild(tag);

      this.karts.push({
        ...r,
        kart: kartIdOf(r.kart),
        st: kartStats(r.kart),
        anchor, tilt, driver, roundel, shadow, tag, tagGap: tag.querySelector('[data-f="g"]'),
        // track-space state
        q: 0, lat: 0, yaw: 0, v: 0, laps: 0, heading: 0, velAng: 0,
        // §A3 vertical state: world y, vertical speed, airtime
        wy: 0, vy: 0, air: false, airMs: 0, roadVy: 0, airCool: 0,
        // §A2 hazard state: the speed penalty, the wobble and the immunity
        hazT: 0, wobT: 0, hazImmune: 0,
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
    // our own kart drives on OUR chosen stats; everyone else is rendered, not
    // simulated, so their numbers only matter in practice
    this.stats = this.me.st;
  }

  /** §A1.3 grid: three staggered rows just behind the line, off this lap. */
  _resetRace() {
    for (const k of this.karts) {
      const slot = this.track.gridSlot(k.slot, this._tmp);
      k.q = slot.q;
      k.lat = slot.lat;
      k.yaw = 0;
      k.v = 0;
      k.laps = 0;
      k.heading = this.track.angleAt(k.q * LAP_UNITS + S_FIN);
      k.velAng = k.heading;
      k.wy = this.track.worldOf(k.q, k.lat, this._tmp3).y;
      k.vy = 0;
      k.air = false;
      k.airMs = 0;
      k.roadVy = 0;
      k.airCool = 0;
      k.hazT = 0;
      k.wobT = 0;
      k.hazImmune = 0;
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
    this.boxes = this.boxDefs.map((b, i) => ({ i, q: b.q, lat: b.lat, live: true, respawnAt: 0, cool: 0 }));
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
    this.wrongT = 0;
    this.wrongOn = false;
    this.wrongDir = 0;
    this.hazImmune = 0;
    this.hazSeen.clear();
    this._placeOf = new Map();
    this._hud('setPhase', 'splash');
    this._hud('wrongWay', false);
    this.vig.classList.remove('wrong');
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
      // the results board belongs to kart-hud.js, so keep a keyboard road back
      // into a new race here: a player must never be stuck looking at a podium
      if (this.phase === 'results' && !e.repeat && (e.key === 'Enter' || e.key === ' ')) {
        this._playAgain();
        return;
      }
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
    // §A2: a static hazard rides the same frame with kind 'haz' and by: null.
    // Nobody threw it, so nobody is credited, and it is never one-shot.
    if (m.kind === 'haz') {
      const claim = k === this.me ? this.hazSeen.get(m.i) : undefined;
      const claimed = Number.isFinite(claim) && this.raceMs - claim < 600;
      this._applyHaz(k, Number(m.ms) || HAZ_HIT_MS, !claimed);
      return;
    }
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
    const lap = clamp(Math.round(Number(m.lap) || 0), 1, this.laps);
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
        ms: Number(r.ms) || 0, laps: clamp(Math.round(Number(r.laps) || 0), 0, this.laps),
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
    if (Number.isFinite(m.lap)) this.me.laps = clamp(Math.round(m.lap), 0, this.laps);
    this.me.ghost = false;
    this.me.v = 0;
    this.me.heading = this.track.angleAt(this.me.q * LAP_UNITS + S_FIN);
    this.me.velAng = this.me.heading;
    if (Number.isFinite(m.startAt)) {
      this.startAt = performance.now() + (Number(m.startAt) - (Date.now() + this.skew));
    }
    this._clearCard();
    this.phase = 'race';
    this._hud('setPhase', 'race');
    this.game.toast?.('Back in the seat. Go go go!');
  }

  /**
   * §4.4 — our own kart, 10Hz, on its own budget, plus one extra frame right
   * after a box, an item use or (§A2) a hazard clip. `hz` is the optional
   * hazard CLAIM and nothing more: the server recomputes the phase formula at
   * its own T and decides for itself.
   */
  _sendIn(force, hz) {
    const n = this.net;
    if (!n || this.phase !== 'race' || this.me.ghost) return;
    if (!force) {
      n.sendAcc += this.dtLast;
      if (n.sendAcc < 1 / SEND_HZ) return;
    }
    n.sendAcc = 0;
    const k = this.me;
    const msg = {
      t: 'kart-in',
      q: +k.q.toFixed(5),
      lat: +k.lat.toFixed(3),
      yaw: +k.yaw.toFixed(3),
      v: +k.v.toFixed(2),
      d: k.drift ? k.tier || 1 : 0,
      air: !!k.air,
    };
    if (Number.isFinite(hz)) msg.hz = hz;
    this.game.net?.send?.(msg);
  }

  // ------------------------------------------------------------- lifecycle --
  _beginCountdown(fromServer = false) {
    if (this.phase !== 'splash') return;
    this.game.audio?.play?.('click');
    this._clearCard();
    this.phase = 'count';
    this._hud('setPhase', 'count');
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
    this._hud('setPhase', 'race');
    // the GO! callout itself belongs to the HUD's countdown(4 - step, go) beat
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
    const final = lap === this.laps - 1;
    // §A7 element 2 owns the splits stack, the NEW BEST sweep and the FINAL LAP
    // banner. `lap` here is laps COMPLETED, which is exactly what kart-hud.js
    // (and `kart-lap` on the wire, §4.6) means by it: pass it through unchanged
    // or the split stack labels the first completed lap "lap 2".
    this._hud('lap', {
      lap, laps: this.laps, splitMs: split,
      bestMs: this.me.bestLap, best: !!personalBest, final,
    });
    if (lap >= this.laps) return;
    // a personal best already chimes from the HUD's NEW BEST LAP; only the
    // ordinary laps need their own ding, or the flag rings twice
    if (!personalBest) this.game.audio?.play?.('ding');
    this._popup(`Lap ${lap} . ${lapTime(split)}`, personalBest ? 'gold' : '');
    if (final && !this.finalLapShown) {
      this.finalLapShown = true;
      this.game.audio?.play?.('whoosh');
      this._scareGulls();
    }
  }

  _onMyFinish() {
    if (this.phase !== 'race') return;
    this.phase = 'done';
    this._hud('setPhase', 'done');
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
    const st = this.stats;
    const s0 = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp3);
    const grip = this.track.gripAt(k.q);   // §A3 ice, from the registry's zones
    if (k.air) { this._stepAir(k, dt, inp); return; }

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
    const frac = Math.min(1, k.v / st.vmax);
    // §A4 handling and §A3 ice both scale steering and grip, never top speed
    const steerMax = 2.6 * (1 - 0.55 * frac) * st.han * grip;

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
    let target = st.vmax;
    if (k.boostT > 0) { target = k.boostTarget; k.boostT -= dt; }
    if (k.soakT > 0) { target = Math.min(target, st.vmax * SOAK_MUL); k.soakT -= dt; }
    if (k.hazT > 0) { target = Math.min(target, st.vmax * HAZ_SPEED_MUL); k.hazT -= dt; }
    if (off) target *= st.offMul;
    if (this.bogT > 0) target = Math.min(target, BOG_V);

    let a;
    if (k.v > target + 0.05) {
      a = -COAST_DRAG;                                  // decay back to target
      if (inp.brake) a = -BRAKE;
    } else if (inp.gas && !spun) {
      a = st.accel * (1 - k.v / Math.max(1, target));
      if (k.boostT > 0) a *= BOOST_ACCEL_MUL;
    } else if (inp.brake) {
      a = k.v > 0 ? -BRAKE : -REVERSE_ACCEL;
    } else {
      a = k.v > 0 ? -COAST_DRAG : COAST_DRAG;
    }
    if (off) a -= Math.sign(k.v || 1) * OFF_DRAG;

    // §A3 GRAVITY ALONG THE TANGENT. A climb always costs you. A descent is
    // allowed to carry you PAST your top speed -- the coast drag steps aside for
    // it -- but only as far as DOWNHILL_CEIL (25.3), which is far under the
    // 40.9 u/s the wire clamp defends, so a hill can never fake a warp.
    const slopeA = -G_SLOPE * Math.sin(s0.pitch);
    if (slopeA > 0) {
      if (k.v < DOWNHILL_CEIL) {
        if (!inp.brake && a < 0) a = Math.min(0, a + COAST_DRAG);
        a += slopeA;
      }
    } else {
      a += slopeA;
    }

    k.v += a * dt;
    const floor = inp.brake ? -REVERSE_MAX : 0;
    k.v = clamp(k.v, floor, BOOST_CEIL);
    if (!inp.gas && !inp.brake && Math.abs(k.v) < 0.05) k.v = 0;

    // ---- grip: the velocity direction chases the facing ---------------------
    k.velAng = angLerp(k.velAng, k.heading, ease(dt, (k.drift ? GRIP_DRIFT : GRIP) * st.han * grip));

    this._advance(k, dt, k.velAng, k.v);
    this._wall(k, dt, off);
    this._stepVertical(k, dt);

    // ---- feel dressing -------------------------------------------------------
    k.wheelSpin += k.v * dt * 3;
    if (off && k.v > 3) {
      this.shake = Math.max(this.shake, 0.25 * clamp(k.v / V_MAX, 0, 1));
      if (Math.random() < dt * 26) this._dust(k, 0xe4cd90);
    }
    if (k.drift && k.v > 6 && Math.random() < dt * 30) this._dust(k, 0xdcd3c4);
  }

  /**
   * §A3 — leaving the ground. Two ways up: a jump zone's lip, which imparts its
   * `launch` outright, and a CREST, where the road's own vertical speed falls
   * away faster than gravity can pull the kart down after it. The second one is
   * what makes summit's compressions and every sharp brow feel right without a
   * single authored ramp.
   */
  _stepVertical(k, dt) {
    const p = this.track.worldOf(k.q, k.lat, this._tmp3);
    const roadVy = k.v * Math.sin(p.pitch);
    if (k.airCool > 0) k.airCool -= dt;
    const ready = k.airCool <= 0 && k.v > 8;
    const launch = ready ? this.track.jumpAt(k.q) : 0;
    // the vertical acceleration the road is DEMANDING of us this frame
    const need = dt > 0.0005 ? (roadVy - k.roadVy) / dt : 0;
    if (launch > 0) {
      this._takeOff(k, roadVy + launch, p.y, true);
    } else if (ready && need < -GRAVITY_AIR) {
      // The road is falling away faster than gravity can pull us after it, so
      // we keep the vertical speed we HAD and the ground goes out from under
      // us. That is a brow, and at speed it is worth real air: summit's
      // compression and tangle's ridge only launch a kart that is genuinely
      // quick, which is why `airCool` is enough to stop any chatter.
      this._takeOff(k, k.roadVy, p.y, need < -GRAVITY_AIR * 1.35);
    } else {
      k.wy = p.y;
      k.roadVy = roadVy;
    }
  }

  _takeOff(k, vy, y, big) {
    k.air = true;
    k.vy = vy;
    k.wy = y + 0.02;
    k.airMs = 0;
    this._cancelDrift(k);
    if (k === this.me && big) this.game.audio?.play?.('whoosh');
  }

  /**
   * §A3 — in the air there is no throttle, no drift and no grip: `AIR_STEER` of
   * yaw authority is the whole of it, and the landing angle decides whether the
   * jump paid.
   */
  _stepAir(k, dt, inp) {
    k.airMs += dt * 1000;
    // the clocks keep running while we are off the ground; only the throttle,
    // the drift and the grip are suspended
    if (k.boostT > 0) k.boostT -= dt;
    if (k.soakT > 0) k.soakT -= dt;
    if (k.hazT > 0) k.hazT -= dt;
    if (k.spinT > 0) k.spinT = Math.max(0, k.spinT - dt);
    k.steer = lerp(k.steer, inp.steer, ease(dt, STEER_EASE));
    k.heading = wrapPi(k.heading + k.steer * AIR_STEER * dt);
    k.velAng = angLerp(k.velAng, k.heading, ease(dt, 1.2));
    k.vy -= GRAVITY_AIR * dt;
    k.wy += k.vy * dt;
    this._advance(k, dt, k.velAng, k.v);
    k.wheelSpin += k.v * dt * 2;
    const p = this.track.worldOf(k.q, k.lat, this._tmp3);
    if (k.wy <= p.y || k.vy < -70) this._land(k, p);
  }

  _land(k, p) {
    k.air = false;
    k.wy = p.y;
    k.vy = 0;
    k.roadVy = k.v * Math.sin(p.pitch);
    k.airCool = 0.4;
    const ms = k.airMs;
    k.airMs = 0;
    const skew = Math.abs(wrapPi(k.heading - p.ang));
    const st = k === this.me ? this.stats : k.st;
    for (let i = 0; i < 10; i++) {
      this._spawnPart(k, rand(-0.8, 0.8), 0.1, rand(-0.5, 0.5), this.theme.dust, rand(0.2, 0.45), rand(0.2, 0.45));
    }
    if (ms < AIR_MIN_MS) return;   // a hop is not airtime, and earns nothing
    if (skew >= st.landHard) {
      k.v *= 0.7;
      this._cancelDrift(k);
      if (k === this.me) {
        this.shake = Math.max(this.shake, 0.4);
        this.game.audio?.play?.('fail');
        this._popup('rough landing', 'bad');
      }
    } else if (skew < LAND_CLEAN && k === this.me) {
      this._applyBoost(LAND_BOOST_MS / 1000, LAND_BOOST_TARGET);
      this._flashFx('land');
      this.game.audio?.play?.('pop');
      this._popup(`${(ms / 1000).toFixed(1)}s AIR!`, 'gold');
      this._hud('toast', 'boost', 'clean landing');
    }
    if (k === this.me) this.shake = Math.max(this.shake, 0.22);
  }

  /**
   * §A6 — wrong way. Purely a warning: no speed loss, no lap effect. Driving
   * backwards is already worthless, because a lap only counts with every
   * checkpoint bit set in sequence.
   */
  _stepWrongWay(dt) {
    const k = this.me;
    const racing = this.phase === 'race' && !k.ghost && !k.air;
    const s = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp3);
    // the projection of the velocity onto the tangent, in u/s
    const along = k.v * Math.cos(wrapPi(k.velAng - s.ang));
    const speed = Math.abs(k.v);
    if (racing && along < 0 && speed >= WRONGWAY_MIN_V) {
      this.wrongT = this.wrongOn ? 0 : this.wrongT + dt * 1000;
      if (!this.wrongOn && this.wrongT >= WRONGWAY_MS) this._setWrongWay(true);
    } else if (this.wrongOn) {
      const clearing = !racing || speed < 2.0 || along > 0;
      this.wrongT = clearing ? this.wrongT + dt * 1000 : 0;
      if (!racing || speed < 2.0 || this.wrongT >= WRONGWAY_CLEAR_MS) this._setWrongWay(false);
    } else {
      this.wrongT = 0;
    }
    if (!this.wrongOn) return;
    // the arrow points along the tangent, anchored in the world, so it reads as
    // "that way" rather than "turn left". 0 is up the screen.
    _v3.set(Math.cos(s.ang), 0, Math.sin(s.ang));
    _v3.transformDirection(this.camera.matrixWorldInverse);
    this.wrongDir = Math.atan2(_v3.x, _v3.y);
  }

  _setWrongWay(on) {
    if (this.wrongOn === on) return;
    this.wrongOn = on;
    this.wrongT = 0;
    this.vig.classList.toggle('wrong', on);
    this._hud('wrongWay', on);
    // the engine bus ducks to WRONGWAY_LP_HZ in _updateEngines while it is on,
    // so the mistake sounds wrong as well as looking wrong
    if (on) this.game.audio?.play?.('fail');
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
    for (let c = 0; c < CHECKPOINTS; c++) {
      const cq = c / CHECKPOINTS;
      const toC = dq(prevQ, cq);
      if (toC >= 0 && toC <= dq(prevQ, k.q)) k.cp |= (1 << c);
    }
    if (prevQ > 0.85 && k.q < 0.15) {
      if (k.cp === CP_MASK) { k.cp = 0; this._localLap(k); }
    }
  }

  _localLap(k) {
    k.laps = Math.min(this.laps, k.laps + 1);
    const split = this.raceMs - (k.lapMs.length ? k.lapMs[k.lapMs.length - 1] : 0);
    k.lapMs.push(this.raceMs);
    const isBest = split > 0 && (!k.bestLap || split < k.bestLap);
    if (isBest) k.bestLap = split;
    if (k.laps >= this.laps) { this._localFinish(k); return; }
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
    // §A1: the sector table is authored per track, next to the geometry that
    // justifies it, so an AI lifts for the corners the player lifts for.
    const sectors = this.track.aiSectors?.length === 24 ? this.track.aiSectors : AI_SECTORS;
    const sector = sectors[Math.min(sectors.length - 1, Math.floor(k.q * sectors.length))];
    let vTarget = Math.min(base * mult, sector);
    vTarget = clamp(vTarget, AI_MIN, AI_MAX);
    if (k.soakT > 0) { vTarget = Math.min(vTarget, V_MAX * SOAK_MUL); k.soakT -= dt; }
    if (k.hazT > 0) { vTarget = Math.min(vTarget, V_MAX * HAZ_SPEED_MUL); k.hazT -= dt; }
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
    // §A7 element 3: the roulette spins for ROULETTE_MS, then locks on `item`
    this._hud('item', { item, spinning: true, ms: ROULETTE_MS });
    this._timers.push(setTimeout(() => {
      if (!this.disposed) this._hud('item', { item: this.me.item, spinning: false, ms: 0 });
    }, ROULETTE_MS));
    this.game.audio?.play?.('pop');
    this._popup('+10', 'gold');
    this._hud('toast', 'box', ITEMS[item]?.name || 'item');
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
    this._hud('item', { item: null, spinning: false, ms: 0 });
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

  /**
   * §A2 — the static hazards: vines, boulders and mine carts. Their positions
   * are a pure function of race time, so nothing about them is ever relayed and
   * every client (and the server) already agrees on where they are.
   *
   * Who decides a hit follows §4's first frozen decision exactly:
   *   practice  we are the arbiter, and apply the penalty ourselves;
   *   race      we play a cosmetic bonk the instant we clip one and send a
   *             CLAIM on the `hz` field of the extra kart-in the client already
   *             fires after an event. The server recomputes at its own T and
   *             answers on kart-hit; no speed or control is lost until then.
   */
  _stepStaticHazards(dt) {
    if (this.hazImmune > 0) this.hazImmune -= dt;
    if (!this.hazDefs.length) return;
    const T = this.raceMs;
    const k = this.me;
    const live = this.phase === 'race';
    if (!live) return;
    for (const h of this.hazDefs) {
      if (!k.ghost && !k.air && this.hazImmune <= 0 && hazardHits(h, k.q, k.lat, T)) {
        if (this.net) {
          const last = this.hazSeen.get(h.i);
          if (!(Number.isFinite(last) && T - last < HAZ_IMMUNE_MS)) {
            this.hazSeen.set(h.i, T);
            this._bonkFx(k, h.kind);       // cosmetic ONLY until kart-hit lands
            this._sendIn(true, h.i);
          }
        } else {
          this._applyHaz(k, HAZ_HIT_MS);
        }
      }
      // practice also arbitrates for the five locals, on the same formula
      if (this.net) continue;
      for (const o of this.karts) {
        if (o === k || o.finished || o.hazImmune > 0) continue;
        if (!hazardHits(h, o.q, o.lat, T)) continue;
        this._applyHaz(o, HAZ_HIT_MS);
      }
    }
    for (const o of this.karts) if (o.hazImmune > 0) o.hazImmune -= dt;
  }

  /** The bonk everybody sees, whoever ends up ruling on it. */
  _bonkFx(k, kind) {
    if (k === this.me) {
      this._flashFx('bonk');
      this.shake = Math.max(this.shake, 0.5);
      this.game.audio?.play?.('fail');
      this._popup(kind === 'cart' ? 'CLANG!' : kind === 'boulder' ? 'THUMP!' : 'WHAP!', 'bad');
      this._hud('toast', 'hit', kind === 'vine' ? 'caught a vine' : kind === 'boulder' ? 'boulder!' : 'mine cart!');
    }
    for (let i = 0; i < 14; i++) {
      this._spawnPart(k, rand(-0.8, 0.8), rand(0.2, 1.4), rand(-0.6, 0.6),
        kind === 'cart' ? 0x9aa2ad : kind === 'boulder' ? 0x9a9186 : 0x7ac74f,
        rand(0.2, 0.45), rand(0.3, 0.6));
    }
  }

  /**
   * §A2's penalty. It must read differently from a peel spin at a glance, so
   * the steering stays yours: this is a shove and a wobble, not a spin-out.
   */
  _applyHaz(k, ms, fx = true) {
    const st = k === this.me ? this.stats : k.st;
    const sec = ((Number(ms) || HAZ_HIT_MS) / 1000) * st.hitMul;
    k.hazT = Math.max(k.hazT, sec);
    k.v *= HAZ_SPEED_MUL;
    k.wobT = 0.55 * st.hitMul;
    k.hazImmune = HAZ_IMMUNE_MS / 1000;
    this._cancelDrift(k);
    if (k === this.me) this.hazImmune = HAZ_IMMUNE_MS / 1000;
    if (fx) this._bonkFx(k, 'boulder');
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
        // §A7 element 6 owns the five bulbs AND the numeral on them; we only
        // say which beat this is, and keep the beat's sound
        if (step >= 1) this._hud('countdown', 4 - step, step >= 4);
        if (step >= 1 && step <= 3) this.game.audio?.play?.('ding');
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

    this._stepStaticHazards(dt);
    this._stepWrongWay(dt);
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
    const wheel = this.wheelIM;
    const d = dt || 0.016;
    for (const sh of this.shells.values()) { sh.body.count = 0; sh.trim.count = 0; }
    let wn = 0;
    for (const k of this.karts) {
      const p = t.worldOf(k.q, k.lat, this._tmp);
      // §A3: a kart sits ON the road, and above it while it is flying
      const y = k === this.me && k.air ? Math.max(p.y, k.wy) : p.y;
      if (k.wobT > 0) k.wobT = Math.max(0, k.wobT - d);
      const wob = k.wobT > 0 ? Math.sin(this.time * 21) * k.wobT * 1.4 : 0;
      const ry = Math.PI / 2 - k.heading + wob;
      k.anchor.position.set(p.x, y, p.z);
      k.anchor.rotation.y = ry;

      // lean: into the corner, harder while drifting, plus the road's own bank
      const slip = wrapPi(k.heading - k.velAng);
      const wantRoll = clamp(-slip * (k.drift ? 1.1 : 0.7), -0.32, 0.32) - (p.bank || 0) * 0.6;
      k.tilt.rotation.z = lerp(k.tilt.rotation.z, wantRoll, ease(d, 8));
      // pitch with the gradient, and nose up a little while airborne
      const wantPitch = (k.spinT > 0 ? 0.12 : 0) - (p.pitch || 0) + (k.air ? clamp(-k.vy * 0.02, -0.2, 0.2) : 0);
      k.tilt.rotation.x = lerp(k.tilt.rotation.x, wantPitch, ease(d, 6));
      k.tilt.position.y = k.spinT > 0 ? Math.abs(Math.sin(this.time * 22)) * 0.06 : 0;
      if (!k.onPodium) k.driver.update(d);
      k.shadow.visible = !k.ghost && !k.onPodium;
      k.shadow.position.y = 0.03 + (y > p.y ? p.y - y : 0);

      _eu.set(k.tilt.rotation.x, ry, k.tilt.rotation.z, 'YXZ');
      _q4.setFromEuler(_eu);
      _v3b.set(p.x, y + k.tilt.position.y, p.z);
      _sc.set(1, 1, 1);
      _m4.compose(_v3b, _q4, _sc);
      // every kart's shell family was built from this same roster, so the
      // lookup always hits; the guard is only here so a hot loop can never throw
      const sh = this.shells.get(k.kart);
      if (sh && sh.body.count < sh.body.instanceMatrix.count) {
        const n = sh.body.count;
        sh.body.setMatrixAt(n, _m4);
        sh.trim.setMatrixAt(n, _m4);
        _col.setHex(k.color);
        if (k.ghost) _col.lerp(_ghostCol, 0.6);
        sh.body.instanceColor.setXYZ(n, _col.r, _col.g, _col.b);
        sh.body.count = n + 1;
        sh.trim.count = n + 1;
      }

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

      if (k.drift && k.tier > 0 && k.v > 6 && !k.air) this._driftSparks(k, dt);
    }
    wheel.count = wn;
    wheel.instanceMatrix.needsUpdate = true;
    for (const sh of this.shells.values()) {
      sh.body.instanceMatrix.needsUpdate = true;
      sh.body.instanceColor.needsUpdate = true;
      sh.trim.instanceMatrix.needsUpdate = true;
    }
  }

  _layoutBoxes(dt) {
    const im = this.boxIM;
    let n = 0;
    for (const b of this.boxes) {
      if (!b.live) continue;
      const p = this.track.worldOf(b.q, b.lat, this._tmp);
      _eu.set(this.time * 0.9 + b.i, this.time * 1.6 + b.i, 0);
      _q4.setFromEuler(_eu);
      _v3b.set(p.x, p.y + 1.15 + Math.sin(this.time * 2.2 + b.i) * 0.12, p.z);
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
      _v3b.set(p.x, p.y + 0.06, p.z);
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
      _v3b.set(w.x, w.y + 0.2, w.z);
      _sc.set(s, s, s);
      _m4.compose(_v3b, _q4, _sc);
      if (m < pr.instanceMatrix.count) pr.setMatrixAt(m++, _m4);
    }
    pr.count = m;
    pr.instanceMatrix.needsUpdate = true;
  }

  /**
   * One call hands the whole circuit its frame: the hazards redraw straight off
   * A2's phase formula at `raceMs` (never Date.now(), or two machines would
   * disagree), the ambient life ticks, and the sky dome and the sun follow the
   * camera so a 600-unit lap is lit everywhere.
   */
  _updateDecor(dt) {
    this.world?.update(dt, this.time, this.raceMs, this.camera.position);
  }

  _scareGulls() {
    this.world?.scareFlock?.();
  }

  // ------------------------------------------------------------- particles --
  _spawnPart(k, ox, oy, oz, color, size, life, glow = false) {
    if (this.parts.length >= 240) return;
    const p = k.anchor ? k.anchor.position : k;
    _col.setHex(color);
    // `fy` is the ground this particle settles on: the road at its own height,
    // not y = 0, or every spark on an elevated section would rain to the floor
    this.parts.push({
      x: p.x + ox, y: p.y + oy, z: p.z + oz, fy: p.y + 0.05,
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
        x: p.x, y: p.y + 1.15, z: p.z, fy: p.y + 0.05,
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
        x: k.anchor.position.x + _v3.x, y: k.anchor.position.y + 0.28,
        z: k.anchor.position.z + _v3.z, fy: k.anchor.position.y + 0.05,
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
        x: k.anchor.position.x, y: k.anchor.position.y + 0.4, z: k.anchor.position.z,
        fy: k.anchor.position.y + 0.05,
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
        x: p.x + rand(-6, 6), y: p.y + rand(6, 14), z: p.z + rand(-6, 6), fy: p.y + 0.05,
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
        const fy = p.fy ?? 0.05;
        if (p.y < fy) { p.y = fy; p.vy = Math.abs(p.vy) * 0.3; }
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

    this._updateSpeedLines(dt);
  }

  /**
   * §A8 — THE SPEED-LINE FIX.
   *
   * The shipped emitter put each streak on a ring around the lens centre at its
   * own random angle and slid it toward the camera, so the streaks scattered
   * radially in every direction: wrong at any speed, and worst mid-corner or
   * looking behind, which is exactly what the owner reported.
   *
   * Streaks must stream OPPOSITE the kart's velocity in SCREEN space. So:
   * rotate the world-space velocity into camera space (the camera's own basis
   * is the screen basis), take its x/y, and lay every streak along `-d` -- one
   * shared direction, spawned across the band perpendicular to it, with at most
   * +-0.18 rad of spread held for the streak's life. Dead ahead the projection
   * collapses to nothing, and there we fall back to "down the screen", never to
   * a random angle. Look-behind needs no special case at all: it turns the
   * camera, the camera turns the basis, and the streaks follow.
   */
  _updateSpeedLines(dt) {
    const k = this.me;
    const spd = clamp((k.v - 16) / 18, 0, 1) + (k.boostT > 0 ? 0.5 : 0);
    this.lineMat.opacity = lerp(this.lineMat.opacity, Math.min(0.55, spd * 0.5), ease(dt, 5));
    if (this.lineMat.opacity <= 0.01) { this.lines.count = 0; return; }

    // world velocity -> camera space. transformDirection ignores translation,
    // which is what we want: this is a direction, not a point.
    _v3.set(Math.cos(k.velAng), 0, Math.sin(k.velAng)).multiplyScalar(k.v >= 0 ? 1 : -1);
    if (k.air) _v3.y = k.vy * 0.15;
    this.camera.updateMatrixWorld();
    _v3.transformDirection(this.camera.matrixWorldInverse);
    const mag = Math.hypot(_v3.x, _v3.y);
    // dead ahead: the screen-space velocity is (nearly) zero, so stream DOWN
    const ang = mag < 0.06 ? -Math.PI / 2 : Math.atan2(-_v3.y, -_v3.x);

    for (let i = 0; i < this.lineSeeds.length; i++) {
      const s = this.lineSeeds[i];
      s.t += dt * (1.6 + spd * 4.5);
      if (s.t > 1) this._reseedLine(s, 0);
      const a = ang + s.j;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const travel = -1.0 + s.t * 3.6;
      _eu.set(0, 0, a - Math.PI / 2);
      _q4.setFromEuler(_eu);
      // along the streak direction, then across it by the band offset
      _v3b.set(ca * travel - sa * s.off, sa * travel + ca * s.off, -s.d);
      _sc.set(1, s.len * (0.7 + spd), 1);
      _m4.compose(_v3b, _q4, _sc);
      this.lines.setMatrixAt(i, _m4);
    }
    this.lines.count = this.lineSeeds.length;
    this.lines.instanceMatrix.needsUpdate = true;
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

    // §A3: the chase cam rides the road's height, and looks a little further
    // down a descent so a blind brow still shows the corner behind it
    _v3.set(0, 3.2, -7.0).applyAxisAngle(_axisY, ry);
    const road = this.track.at(k.q * LAP_UNITS + S_FIN, this._tmp2);
    const base = k.anchor.position.y;
    const pitch = road.pitch;
    const want = _v3b.set(
      k.anchor.position.x + _v3.x,
      base + 3.2 - clamp(pitch, -0.5, 0.5) * 5.0,
      k.anchor.position.z + _v3.z,
    );
    const kk = ease(dt, 9);
    cam.position.lerp(want, kk);

    _v3.set(Math.cos(this._camYaw), 0, Math.sin(this._camYaw)).multiplyScalar(back ? -4 : 4);
    cam.lookAt(
      k.anchor.position.x + _v3.x,
      base + 1.3 + clamp(pitch, -0.5, 0.5) * 3.4,
      k.anchor.position.z + _v3.z,
    );

    // roll into the drift and with the banking, then shake on top of everything
    const wantRoll = (k.drift ? -k.driftDir * 0.05 : 0) - road.bank * 0.35;
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
    // §A6: the vignette normally fades in with speed, but the wrong-way pulse
    // has to be visible at ANY speed -- that is the whole point of it, and a
    // player who has turned around is usually slow.
    const vg = this.wrongOn
      ? 0.85
      : clamp((k.v - 14) / 24, 0, 1) * 0.8 + (k.boostT > 0 ? 0.2 : 0);
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
      p.root.position.y + 4.6 + Math.sin(this.time * 0.5) * 0.5,
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
  /**
   * A7 - one reused view object a frame, handed to kart-hud.js. Nothing here
   * touches a DOM node: GP3 owns every element of the race UI, and this method
   * only has to be cheap and honest.
   */
  _refreshHud(dt) {
    void dt;
    const v = this.view;
    const k = this.me;
    const lapStart = k.lapMs.length ? k.lapMs[k.lapMs.length - 1] : 0;
    v.place = this._placeOf.get(k) || 1;
    v.of = this.karts.length;
    // the frozen view model has no lap number (lap() owns it), but sending one
    // anyway is what keeps the panel honest through a mid-race reconnect
    v.lap = clamp(k.laps + (this.phase === 'race' ? 1 : 0), 1, this.laps);
    v.raceMs = this.raceMs;
    v.lapMs = this.phase === 'race' ? this.raceMs - lapStart : Math.max(0, k.finishMs - lapStart);
    v.bestMs = k.bestLap;
    v.v = Math.abs(k.v);
    v.vmax = this.stats.vmax;
    v.boost = k.boostT > 0 ? 1 : 0;
    // the roulette is still spinning until spinLock runs out (3.3)
    v.drift = k.drift ? k.tier : 0;
    v.wrong = this.wrongOn;
    v.wrongDir = this.wrongDir;
    v.air = !!k.air;
    v.item = this.spinLock > 0 ? null : k.item;
    v.track = this.row.id;

    // the standings, with the gap in seconds against the pace we are running.
    // Rows are POOLED: the arrays are truncated after the fill, never before,
    // so a frame of HUD costs no allocation at all.
    const pace = Math.max(6, Math.abs(k.v) || 12);
    for (let i = 0; i < this._order.length; i++) {
      const o = this._order[i];
      const row = v.order[i] || (v.order[i] = {});
      row.slot = o.slot;
      row.name = o.name;
      row.color = o.color;
      row.lap = clamp(o.laps + 1, 1, this.laps);
      row.gapMs = Math.round(((this._progress(o) - this._progress(k)) * LAP_UNITS / pace) * 1000);
      row.ghost = !!o.ghost;
      row.me = o === k;
    }
    v.order.length = this._order.length;

    for (let i = 0; i < this.karts.length; i++) {
      const o = this.karts[i];
      const row = v.karts[i] || (v.karts[i] = {});
      row.slot = o.slot;
      row.q = o.q;
      row.lat = o.lat;
      row.color = o.color;
      row.me = o === k;
      row.ghost = !!o.ghost;
    }
    v.karts.length = this.karts.length;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const row = v.boxes[i] || (v.boxes[i] = {});
      row.q = b.q;
      row.lat = b.lat;
      row.live = b.live;
    }
    v.boxes.length = this.boxes.length;

    // A2 statics first (they are the ones worth seeing coming), then the peels
    let n = 0;
    for (const h of this.hazDefs) {
      const at = hazardPose(h, this.raceMs, this._tmp2);
      const row = v.hazards[n] || (v.hazards[n] = {});
      row.q = at.q;
      row.lat = at.lat;
      row.kind = h.kind;
      v.hazards[n++] = row;
    }
    for (const h of this.hazards.values()) {
      if (h.stale) continue;
      const row = v.hazards[n] || (v.hazards[n] = {});
      row.q = h.q;
      row.lat = h.lat;
      row.kind = 'peel';
      v.hazards[n++] = row;
    }
    v.hazards.length = n;

    this._hud('update', v, dt);
  }

  /** Name tags over rival karts, projected from the live camera. */
  _updateTags() {
    this.camera.updateMatrixWorld();
    for (const k of this.karts) {
      if (!k.tag) continue;
      if (!k.seen || this.phase === 'results') { k.tag.classList.remove('on'); continue; }
      _v3.copy(k.anchor.position);
      _v3.y += 2.4;
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
        // §A6: the whole bus goes muffled while the wrong-way banner is up
        this.engineBus.lp.frequency.setTargetAtTime(
          this.wrongOn ? WRONGWAY_LP_HZ : 700 + clamp(this.me.v / V_MAX, 0, 1.5) * 1600,
          now, this.wrongOn ? 0.08 : 0.1,
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
  /**
   * The chequered flag. kart.js still owns the 3D rostrum, the confetti and the
   * payout arithmetic; A7 element 8/9 (the board, the count-up, Play Again and
   * Quit) belongs to kart-hud.js, which gets the whole payload in one call.
   */
  _showResults() {
    if (this.phase === 'results') { this._hud('results', this._resultsPayload()); return; }
    this.phase = 'results';
    this.tip.style.opacity = '0';
    this._hud('setPhase', 'results');
    for (const k of this.karts) k.tag?.classList.remove('on');

    const rows = this.results || [];
    const mine = rows.find((r) => r.slot === this.me.slot);
    const place = mine ? mine.place : (this._placeOf.get(this.me) || 6);
    const laps = this.me.laps;
    const bestOfRace = rows.reduce((b, r) => (r.best > 0 && (!b || r.best < b) ? r.best : b), 0);
    const fastest = !!(this.me.bestLap && bestOfRace && this.me.bestLap <= bestOfRace);
    const boxes = this.me.boxes;
    const score = 1000 * (7 - place) + 40 * laps + (fastest ? 200 : 0) + 10 * boxes;

    // 4.8: a ghost or a DNF never calls finish() and is paid nothing. The
    // payout table is unchanged on every track and by every kart (A9).
    const paid = this.me.finished && !this.me.ghost;
    let payout = 0;
    if (paid) {
      this._payout = { score, place, laps, fastest, boxes };
      payout = this.coinsForScore(score);
      this.finish(score);
    }
    const prevBest = this.game.state.bests?.kart || 0;
    this._res = {
      place, laps, boxes, fastest, score, paid, payout,
      newBest: paid && score > prevBest,
    };

    this._buildPodium(rows);
    this._confettiBurst(90);
    this.game.audio?.play?.(place === 1 ? 'success' : 'ding');
    // the count-up (and its coin ticks, through onPlay) belongs to the HUD
    this._hud('results', this._resultsPayload());
  }

  /** A7's results payload: everything the board needs, nothing it does not. */
  _resultsPayload() {
    const r = this._res || {};
    const rows = (this.results || []).map((x) => {
      const k = this._bySlot(x.slot);
      return {
        slot: x.slot,
        place: x.place,
        name: x.name,
        color: k ? k.color : 0xb08a5a,
        kart: k ? (KARTS[k.kart] || KARTS.coco).name : KARTS.coco.name,
        ai: !!x.ai,
        ghost: !!(k && k.ghost),
        laps: x.laps,
        ms: x.ms,
        best: x.best,
        me: x.slot === this.me.slot,
      };
    });
    return {
      rows,
      you: this.me.slot,
      place: r.place || 6,
      coins: r.payout || 0,
      score: r.score || 0,
      laps: r.laps || 0,               // laps COMPLETED; the total is the HUD's
      boxes: r.boxes || 0,
      bestLap: this.me.bestLap,
      fastest: !!r.fastest,
      paid: !!r.paid,
      newBest: !!r.newBest,
      best: Math.max(this.game.state.bests?.kart || 0, r.paid ? r.score : 0),
      trackName: this.row.name,
      kartName: (KARTS[this.me.kart] || KARTS.coco).name,
    };
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
    root.position.set(fin.x - Math.sin(fin.ang) * off, fin.y, fin.z + Math.cos(fin.ang) * off);
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
    this._res = null;
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
    this._mountHud();
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
    // GP3 owns every node inside hudRoot and leaves it clean behind itself
    try { this.hud?.dispose?.(); } catch { /* nothing left to do about it */ }
    this.hud = null;
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

    try { this.world?.dispose?.(); } catch { /* nothing left to do about it */ }
    this.world = null;
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
    this.shells = null;
    this.hazProps = null;
  }
}
