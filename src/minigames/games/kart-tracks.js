import * as THREE from 'three';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';

/**
 * Capy Karts: the track registry, the 3D spline sampler and every mesh that is
 * not a kart.
 *
 * Built to docs/KARTS.md GRAND PRIX AMENDMENT (FROZEN). Read §A1-§A3 first;
 * this file is the AUTHOR of every number in the registry and server/kart.js
 * copies the metadata subset out of it by hand (§A1: duplication is the pattern,
 * neither file imports the other).
 *
 * WHAT LIVES HERE
 *   TRACKS            the four registry rows, `points` included
 *   buildTrack(id)    the arc-length LUT: position, tangent, pitch, bank and
 *                     half-width at any `s`, plus q/lat -> world with elevation
 *   buildTrackWorld() road/kerb/apron ribbons, barriers, themed decor, sky,
 *                     lights, gantry and the moving hazards, as one Group
 *   hazardPose()      §A2's frozen phase formula, shared with the server
 *
 * WHAT DOES NOT LIVE HERE
 *   Karts, items, boxes, particles, the camera, the HUD, any wire frame. GP2
 *   owns kart.js and GP3 owns kart-hud.js; this module never touches the DOM
 *   except through `canvasTexture`, and has NO import-time side effects.
 *
 * ELEVATION IS CLIENT GEOMETRY. `y` never rides the wire: it is derived here
 * from the track table, so the server needs the metadata subset and nothing
 * more (§A intro). q/lat/yaw stay the only position values on the wire.
 */

// ============================================================== registry ====

/** §A5 — the vote's rotation order. */
export const TRACK_ORDER = Object.freeze(['sunny', 'summit', 'tangle', 'glimmer']);
export const DEFAULT_TRACK = 'sunny';

/** §A1.3 — the physical ceiling the per-track wire clamp defends, in u/s. */
export const Q_CLAMP_U_PER_S = 40.9;

/** §A2 — a static-hazard bonk, and the immunity that stops a chain-bonk. */
export const HAZ_HIT_MS = 900;
export const HAZ_IMMUNE_MS = 1200;
export const HAZ_SPEED_MUL = 0.45;

/** §A3 — client physics constants the geometry implies. GP2 applies them. */
export const G_SLOPE = 9.0;
export const DOWNHILL_CEIL_MUL = 1.15;
export const GRAVITY_AIR = 18.0;
export const AIR_STEER = 0.5;
export const AIR_MIN_MS = 450;
export const LAND_BOOST_MS = 400;
export const LAND_BOOST_TARGET = 25;
export const LAND_HARD_YAW = 0.9;

/** §A1.3 — grid rows, generalised off LAP_UNITS. */
const GRID_ROWS_U = Object.freeze([6, 13, 20]);
const GRID_LAT = Object.freeze([-0.47, 0.47]);

/**
 * Palette + weather bundle per theme (§A1). Every colour is an existing Capy
 * Cove anchor or a shade of one: DESIGN.md's rule is cohesion over variety, so
 * each track reuses its home room's temperature rather than inventing one.
 */
export const THEMES = Object.freeze({
  beach: {
    id: 'beach',
    road: 0x5b5568, roadDark: 0x4b4658, roadLight: 0x6a6377,
    line: 0xf7f2e6, checkA: 0xf7f2e6, checkB: 0x38343f,
    kerbA: 0xe8657a, kerbB: 0xfff6e2,
    apron: 0xf0dca0, apronAlt: 0xe4cd90,
    slick: 0x9fc4e0, launch: 0xf2b64a,
    ground: 0xf0dca0, rim: 0x4fb3e8,
    skyTop: 0x3f9fdd, skyMid: 0xa9dcf2, skyLow: 0xffeecb,
    fog: 0xcfe6f2, fogNear: 120, fogFar: 460,
    hemiSky: 0xfff3d8, hemiGround: 0x9ec8b0, hemi: 1.15,
    sun: 0xfff2d4, sunI: 1.55, fill: 0xa8dcff, fillI: 0.4,
    dust: 0xe4cd90, accent: 0xf2b64a, trim: 0xfff6e2,
  },
  snow: {
    id: 'snow',
    road: 0x585264, roadDark: 0x484254, roadLight: 0x6a6377,
    line: 0xfdfbf4, checkA: 0xfdfbf4, checkB: 0x36323d,
    kerbA: 0x4fb3e8, kerbB: 0xfff6e2,
    apron: 0xdfeaf5, apronAlt: 0xcbdcec,
    slick: 0xbfe4f7, launch: 0xf2b64a,
    ground: 0xdfeaf5, rim: 0x9fc4e0,
    skyTop: 0x76a9d8, skyMid: 0xbcd8ee, skyLow: 0xfdf1dc,
    fog: 0xdce9f4, fogNear: 90, fogFar: 380,
    hemiSky: 0xeaf4ff, hemiGround: 0xc6d6e4, hemi: 1.3,
    sun: 0xfff0d8, sunI: 1.3, fill: 0x9fc4e0, fillI: 0.5,
    dust: 0xf4fbff, accent: 0xf2b64a, trim: 0xdfeaf5,
  },
  jungle: {
    id: 'jungle',
    road: 0x574f5e, roadDark: 0x463f4d, roadLight: 0x685f70,
    line: 0xf4eeda, checkA: 0xf4eeda, checkB: 0x33303a,
    kerbA: 0x7ac74f, kerbB: 0xfff6e2,
    apron: 0x6d8a4a, apronAlt: 0x5b7a3e,
    slick: 0x8fa88d, launch: 0xf2b64a,
    ground: 0x4f7a3a, rim: 0x2f5a2c,
    skyTop: 0x4f9a5c, skyMid: 0x9ed08a, skyLow: 0xf6e6b0,
    fog: 0xc7dfae, fogNear: 80, fogFar: 340,
    hemiSky: 0xe8f6d2, hemiGround: 0x486b34, hemi: 1.05,
    sun: 0xfff4c8, sunI: 1.45, fill: 0x8fd68a, fillI: 0.45,
    dust: 0x9c8a5e, accent: 0xf2b64a, trim: 0xd9cbaa,
  },
  mine: {
    id: 'mine',
    road: 0x4c4657, roadDark: 0x3d3847, roadLight: 0x5d5668,
    line: 0xf1e7cf, checkA: 0xf1e7cf, checkB: 0x2c2833,
    kerbA: 0x42d6c8, kerbB: 0xfff6e2,
    apron: 0x4a4150, apronAlt: 0x3c3442,
    slick: 0x6f6455, launch: 0xf2b64a,
    ground: 0x3a3342, rim: 0x2a2038,
    skyTop: 0x241d33, skyMid: 0x39304a, skyLow: 0x53415c,
    fog: 0x2e2740, fogNear: 60, fogFar: 300,
    hemiSky: 0x9b6bd4, hemiGround: 0x2a2038, hemi: 0.9,
    sun: 0xffe6b4, sunI: 0.95, fill: 0x42d6c8, fillI: 0.55,
    dust: 0x8c7f6a, accent: 0x42d6c8, trim: 0xd9cbaa,
  },
});

/**
 * §A1 — one row per track. `points` is [x, y, z, fullWidth]; y IS elevation and
 * the scale lock in buildTrack multiplies all four by LAP_UNITS / Lraw, so the
 * authored y column is deliberately pre-divided by that factor and the FINAL
 * elevation range is the one the amendment names.
 *
 * `grip`, `jumps` and `banks` are CLIENT ONLY and never copied to the server.
 * `itemBoxes`, `hazards`, `aiSectors`, `checkpoints`, `floors`, `LAP_UNITS` and
 * `minRunMs` are the metadata subset server/kart.js keeps its own copy of.
 */
export const TRACKS = Object.freeze([
  {
    id: 'sunny',
    name: 'Sunny Shores',
    theme: 'beach',
    blurb: 'Sun-bleached tarmac, warm sand and a lighthouse on the coastal run.',
    // SHIPPED, unchanged to the digit (§A1.1) — the 18 control points of §2 with
    // y = 0 inserted. A run of sunny after this wave must feel identical.
    points: [
      [-60, 0, -80, 15], [-20, 0, -84, 15], [20, 0, -84, 15], [56, 0, -76, 14],
      [84, 0, -58, 13], [95, 0, -30, 13], [92, 0, 2, 12], [82, 0, 30, 11],
      [62, 0, 48, 10], [36, 0, 50, 10], [18, 0, 36, 9], [-4, 0, 44, 9],
      [-30, 0, 50, 11], [-56, 0, 40, 12], [-74, 0, 14, 13], [-80, 0, -16, 13],
      [-76, 0, -48, 14], [-70, 0, -68, 15],
    ],
    LAP_UNITS: 545,
    sFin: 30.0,
    checkpoints: 6,
    floors: 1,
    laps: 3,
    gridSlots: 'standard',
    itemBoxes: [
      [0.220, -0.62], [0.220, -0.21], [0.220, 0.21], [0.220, 0.62],
      [0.550, -0.45], [0.550, 0.00], [0.550, 0.45],
      [0.790, -0.62], [0.790, -0.21], [0.790, 0.21], [0.790, 0.62],
    ],
    hazards: [],
    grip: [],
    jumps: [],
    banks: [],
    minRunMs: 36_000,
    aiSectors: [22, 22, 22, 22, 18, 19, 20, 20, 19, 16, 12, 13, 15, 14, 17, 16, 18, 20, 21, 21, 21, 19, 21, 22],
  },
  {
    id: 'summit',
    name: 'Frosty Peak',
    theme: 'snow',
    blurb: 'A long climb, a hairpin over the drop, then all the way back down.',
    // A sustained climb from q 0.05 to q 0.35, the hairpin hanging over a drop
    // at q 0.42, then a descent with two compressions. Ice (§A3 grip) is the
    // hazard: nothing to hit, just grip to respect.
    points: [
      [-60, 0.000, -70, 13], [-26, -0.918, -76, 13], [8, 0.000, -78, 13],
      [40, 2.754, -70, 12.5], [64, 6.426, -52, 12], [76, 10.098, -26, 11.5],
      [74, 13.771, 2, 11], [58, 17.443, 26, 10], [34, 19.279, 36, 8.5],
      [16, 20.197, 26, 8], [14, 18.361, 6, 9], [2, 14.689, -10, 10],
      [-16, 11.934, -8, 10.5], [-28, 13.771, 8, 11], [-38, 10.098, 30, 11],
      [-56, 5.508, 44, 11.5], [-78, 1.836, 38, 12], [-92, -1.836, 18, 12.5],
      [-96, -4.590, -8, 13], [-92, -5.508, -34, 13], [-84, -2.754, -56, 13],
      [-72, -0.918, -68, 13],
    ],
    LAP_UNITS: 600,
    sFin: 30.0,
    checkpoints: 8,
    floors: 1,
    laps: 3,
    gridSlots: 'standard',
    itemBoxes: [
      [0.185, -0.60], [0.185, -0.20], [0.185, 0.20], [0.185, 0.60],
      [0.500, -0.44], [0.500, 0.00], [0.500, 0.44],
      [0.760, -0.60], [0.760, -0.20], [0.760, 0.20], [0.760, 0.60],
    ],
    hazards: [],
    grip: [
      { q0: 0.12, q1: 0.20, mul: 0.45 },
      { q0: 0.38, q1: 0.44, mul: 0.40 },
      { q0: 0.63, q1: 0.72, mul: 0.45 },
      { q0: 0.86, q1: 0.91, mul: 0.50 },
    ],
    jumps: [],
    banks: [],
    minRunMs: 39_000,
    aiSectors: [22, 22, 21, 20, 19, 19, 18, 18, 17, 14, 12, 14, 16, 16, 17, 18, 19, 19, 20, 21, 21, 20, 21, 22],
  },
  {
    id: 'tangle',
    name: 'Tangle Ruins',
    theme: 'jungle',
    blurb: 'Never flat for forty units. Mind the vines, the boulders and the dark.',
    // Rolling all the way round, two swinging vine gates, two rolling boulders,
    // the narrow unlit ruin at q 0.61-0.66 that steps down as it opens onto the
    // viaduct at q ~0.68, and that viaduct carries the road back over the main
    // straight seven units below (floors: 2).
    points: [
      [-60, -2.320, -56, 13], [-42, -1.856, -64, 13], [-14, 0.580, -66, 12.5],
      [14, 3.248, -62, 12], [40, 5.800, -50, 11.5], [58, 8.120, -30, 11],
      [66, 10.440, -4, 11], [62, 12.760, 24, 10.5], [46, 14.500, 48, 10],
      [22, 15.080, 62, 10], [-6, 13.920, 64, 10], [-32, 12.180, 56, 10],
      [-52, 11.600, 38, 10.5], [-64, 12.760, 14, 11], [-62, 14.500, -12, 10.5],
      [-50, 16.240, -34, 10.5], [-32, 15.080, -48, 8.5], [-6, 11.600, -50, 6.4],
      [20, 14.500, -44, 7.5], [36, 12.760, -66, 10.5], [24, 8.120, -80, 11],
      [-6, 4.640, -88, 11.5], [-38, 2.320, -92, 12], [-60, 0.580, -86, 12.5],
      [-71, -0.580, -82, 13], [-75, -1.740, -71, 13], [-71, -2.320, -60, 13],
    ],
    LAP_UNITS: 575,
    sFin: 30.0,
    checkpoints: 8,
    floors: 2,
    laps: 3,
    gridSlots: 'standard',
    itemBoxes: [
      [0.140, -0.58], [0.140, -0.19], [0.140, 0.19], [0.140, 0.58],
      [0.430, -0.42], [0.430, 0.00], [0.430, 0.42],
      [0.820, -0.58], [0.820, -0.19], [0.820, 0.19], [0.820, 0.58],
    ],
    // §A2, frozen: a pure function of race time, so no extra byte on the wire.
    hazards: [
      { i: 0, kind: 'vine', q: 0.180, lat: 0.00, dqAmp: 0, latAmp: 0.85, psi: 0, wave: 'sin', period: 3000, off: 0, hq: 0.006, hl: 0.34 },
      { i: 1, kind: 'vine', q: 0.205, lat: 0.00, dqAmp: 0, latAmp: 0.85, psi: Math.PI, wave: 'sin', period: 3000, off: 0, hq: 0.006, hl: 0.34 },
      { i: 2, kind: 'boulder', q: 0.470, lat: -0.35, dqAmp: 0.055, latAmp: 0, psi: 0, wave: 'saw', period: 5200, off: 0, hq: 0.006, hl: 0.40 },
      { i: 3, kind: 'boulder', q: 0.470, lat: 0.40, dqAmp: 0.055, latAmp: 0, psi: 0, wave: 'saw', period: 5200, off: 2600, hq: 0.006, hl: 0.40 },
      { i: 4, kind: 'vine', q: 0.720, lat: 0.00, dqAmp: 0, latAmp: 0.70, psi: 0, wave: 'sin', period: 2400, off: 1200, hq: 0.006, hl: 0.30 },
    ],
    grip: [{ q0: 0.61, q1: 0.66, mul: 0.70 }],
    jumps: [],
    banks: [],
    minRunMs: 37_500,
    aiSectors: [22, 22, 21, 20, 18, 18, 19, 19, 18, 17, 16, 15, 17, 16, 14, 12, 14, 17, 19, 20, 21, 21, 22, 22],
  },
  {
    id: 'glimmer',
    name: 'Glimmer Deep',
    theme: 'mine',
    blurb: 'Banked crystal galleries, mine carts on the crossings, and one big jump.',
    // The deep gallery holds the start straight; the lap climbs the banked
    // curves to the crystal roof, launches at q 0.505 and flies back over the
    // straight it started on (floors: 2), then winds down to the deep again.
    points: [
      [16, -10.649, -46, 13], [46, -11.329, -42, 13], [76, -10.196, -38, 12.5],
      [102, -7.930, -22, 12], [112, -4.532, 6, 11.5], [106, -1.133, 36, 11],
      [86, 2.266, 60, 11], [58, 4.532, 72, 10.5], [28, 5.665, 72, 10],
      [0, 6.798, 62, 10], [-16, 7.930, 38, 10], [-14, 9.063, 10, 10],
      [-2, 7.930, -22, 10], [6, 4.532, -46, 10], [-14, 3.399, -68, 10.5],
      [-42, 2.266, -80, 11], [-72, 1.133, -78, 11], [-96, 0.000, -62, 11.5],
      [-104, -2.266, -36, 12], [-94, -4.532, -12, 12], [-70, -6.798, 0, 12.5],
      [-42, -9.063, -8, 13], [-14, -10.196, -44, 13],
    ],
    LAP_UNITS: 620,
    sFin: 30.0,
    checkpoints: 8,
    floors: 2,
    laps: 3,
    gridSlots: 'standard',
    itemBoxes: [
      [0.230, -0.60], [0.230, -0.20], [0.230, 0.20], [0.230, 0.60],
      [0.580, -0.45], [0.580, 0.00], [0.580, 0.45],
      [0.860, -0.60], [0.860, -0.20], [0.860, 0.20], [0.860, 0.60],
    ],
    hazards: [
      { i: 0, kind: 'cart', q: 0.310, lat: 0.00, dqAmp: 0, latAmp: 1.30, psi: 0, wave: 'sin', period: 4000, off: 0, hq: 0.007, hl: 0.42 },
      { i: 1, kind: 'cart', q: 0.315, lat: 0.00, dqAmp: 0, latAmp: 1.30, psi: Math.PI, wave: 'sin', period: 4000, off: 2000, hq: 0.007, hl: 0.42 },
      { i: 2, kind: 'cart', q: 0.660, lat: 0.00, dqAmp: 0, latAmp: 1.10, psi: 0, wave: 'sin', period: 3200, off: 800, hq: 0.007, hl: 0.42 },
    ],
    grip: [{ q0: 0.44, q1: 0.49, mul: 0.60 }],
    jumps: [{ q0: 0.505, q1: 0.520, launch: 7.5 }],
    // Geometry + camera roll only, never a physics term (§A1.1).
    banks: [
      { q0: 0.155, q1: 0.250, roll: 0.30 },
      { q0: 0.705, q1: 0.800, roll: 0.30 },
    ],
    minRunMs: 40_500,
    aiSectors: [22, 22, 21, 20, 18, 18, 19, 16, 19, 20, 16, 16, 20, 19, 18, 16, 16, 18, 19, 20, 21, 21, 22, 22],
  },
]);

const BY_ID = new Map(TRACKS.map((t) => [t.id, t]));

/** A row for `id`, coerced to the shipped track for anything unknown (§A5). */
export function getTrack(id) {
  return BY_ID.get(String(id || '')) || BY_ID.get(DEFAULT_TRACK);
}

export function isTrackId(id) { return BY_ID.has(String(id || '')); }

/** §A1.3 — the per-track wire clamp. The ceiling it defends is 40.9 u/s. */
export function maxQPerS(idOrRow) {
  const row = typeof idOrRow === 'string' ? getTrack(idOrRow) : idOrRow;
  return Q_CLAMP_U_PER_S / row.LAP_UNITS;
}

/**
 * §A1 — the ONLY shape the server is allowed to know about. No spline, no mesh,
 * no theme. GP4 keeps a hand-copied literal of exactly these fields; this
 * function exists so a test can prove the two copies still agree.
 */
export function trackMeta(idOrRow) {
  const t = typeof idOrRow === 'string' ? getTrack(idOrRow) : idOrRow;
  return {
    id: t.id,
    LAP_UNITS: t.LAP_UNITS,
    checkpoints: t.checkpoints,
    floors: t.floors,
    laps: t.laps,
    minRunMs: t.minRunMs,
    gridSlots: t.gridSlots,
    itemBoxes: t.itemBoxes.map((b) => [b[0], b[1]]),
    hazards: t.hazards.map((h) => ({ ...h })),
    aiSectors: t.aiSectors.slice(),
  };
}

/** Metadata for all four, in TRACK_ORDER. */
export function allTrackMeta() { return TRACK_ORDER.map((id) => trackMeta(id)); }

// =============================================================== helpers ====
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
export const frac1 = (v) => v - Math.floor(v);

export function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
export function angLerp(a, b, t) { return a + wrapPi(b - a) * t; }
/** Forward lap distance from a to b, both in 0..1, wrapped to -0.5..0.5. */
export function dq(a, b) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}
/** Smooth 0..1 ramp; nothing in this file steps a value discontinuously. */
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Deterministic 32-bit PRNG, so a track dresses itself the same way twice. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _m4 = new THREE.Matrix4();
const _q4 = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _col = new THREE.Color();
const _colB = new THREE.Color();

/**
 * Merge primitive parts into one vertex-coloured BufferGeometry so a multi-colour
 * prop still costs a single draw call through InstancedMesh. Inputs are consumed.
 */
export function mergeParts(parts) {
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
  out.computeBoundingSphere();
  return out;
}

// ================================================================ hazards ====
const _hz = { q: 0, lat: 0, ph: 0, w: 0 };

/**
 * §A2, FROZEN. A moving hazard is a pure function of race time, so the client,
 * the server and every other client agree without a single extra byte.
 * `T` is race time in ms (client: raceMs; server: now - race.startAt). NEVER
 * Date.now(): two machines must feed this the same number.
 */
export function hazardPose(h, T, out = {}) {
  const ph = frac1((T + h.off) / h.period);
  const w = h.wave === 'saw' ? (1 - 2 * ph) : Math.sin(2 * Math.PI * ph);
  out.ph = ph;
  out.w = w;
  out.q = frac1(h.q + h.dqAmp * w);
  out.lat = h.lat + h.latAmp * (h.psi ? Math.sin(2 * Math.PI * ph + h.psi) : w);
  return out;
}

/**
 * The hit test, identical on both sides. `qSlack`/`latSlack` are the server's
 * staleness allowance (§A2 uses hq*2 / hl*1.3); the client passes 1/1 for its
 * own cosmetic bonk, which never applies a penalty on its own (§4 decision 1).
 *
 * ARGUMENT ORDER DIFFERS FROM THE SERVER'S (§A1.4.8). server/kart.js declares
 * `hazardHits(h, T, q, lat, slackQ, slackLat)`. Same behaviour, different order:
 * code moved between the two files must be re-ordered, or race time is silently
 * read as lap progress.
 */
export function hazardHits(h, q, lat, T, qSlack = 1, latSlack = 1) {
  if (!Number.isFinite(q) || !Number.isFinite(lat)) return false;
  hazardPose(h, T, _hz);
  return Math.abs(dq(q, _hz.q)) <= h.hq * qSlack && Math.abs(lat - _hz.lat) <= h.hl * latSlack;
}

// ================================================================= spline ====
/**
 * Centripetal Catmull-Rom through (x, y, z, width). Knot spacing uses the full
 * 3D distance, so width and elevation ride exactly the same parameterisation as
 * the centreline and a wide corner never gets a narrow apex. With y = 0 this is
 * bit-for-bit the shipped 2D evaluator, which is why `sunny` is unchanged.
 */
function crEval(P0, P1, P2, P3, t, out) {
  const d3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const t0 = 0;
  const t1 = t0 + (Math.sqrt(d3(P0, P1)) || 1e-4);
  const t2 = t1 + (Math.sqrt(d3(P1, P2)) || 1e-4);
  const t3 = t2 + (Math.sqrt(d3(P2, P3)) || 1e-4);
  const tt = t1 + (t2 - t1) * t;
  for (let k = 0; k < 4; k++) {
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
 * Build the arc-length LUT for one track. Everything downstream (ribbons,
 * decor, item boxes, grid, minimap, physics) reads the circuit through this one
 * object, so the scale lock lives in exactly one place.
 *
 * @param {string|object} idOrRow a registry id or a registry row
 * @returns {object} the sampler, documented field by field on the return
 */
export function buildTrack(idOrRow) {
  const row = typeof idOrRow === 'string' ? getTrack(idOrRow) : idOrRow;
  const LAP = row.LAP_UNITS;
  const sFin = row.sFin;
  const pal = THEMES[row.theme] || THEMES.beach;

  const CTRL = row.points;
  const n = CTRL.length;
  const SUB = 48;
  const raw = [];
  const tmp = [0, 0, 0, 0];
  let len = 0;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const P0 = CTRL[(i - 1 + n) % n];
    const P1 = CTRL[i];
    const P2 = CTRL[(i + 1) % n];
    const P3 = CTRL[(i + 2) % n];
    for (let j = 0; j < SUB; j++) {
      const p = crEval(P0, P1, P2, P3, j / SUB, tmp).slice();
      if (prev) len += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      raw.push(p);
      prev = p;
    }
  }
  len += Math.hypot(raw[0][0] - prev[0], raw[0][1] - prev[1], raw[0][2] - prev[2]);

  // SCALE LOCK (§A1): one uniform factor on x, y, z and width, so the lap
  // measures exactly LAP_UNITS in 3D and the road keeps its authored proportion
  // to the corners AND to the hills.
  const k = LAP / len;
  for (const p of raw) { p[0] *= k; p[1] *= k; p[2] *= k; p[3] *= k; }

  // Resample to a fixed ~2u step, walking the fine samples and interpolating.
  const step = 2;
  const N = Math.round(LAP / step);
  const stepR = LAP / N;
  const xs = new Float32Array(N + 1);
  const ys = new Float32Array(N + 1);
  const zs = new Float32Array(N + 1);
  const hws = new Float32Array(N + 1);
  const angs = new Float32Array(N + 1);
  const pitches = new Float32Array(N + 1);
  const curv = new Float32Array(N + 1);
  const bank = new Float32Array(N + 1);

  let acc = 0;
  let ri = 0;
  for (let i = 0; i <= N; i++) {
    const want = Math.min(i * stepR, LAP - 1e-4);
    while (ri < raw.length) {
      const a = raw[ri];
      const b = raw[(ri + 1) % raw.length];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (acc + d >= want || ri === raw.length - 1) {
        const f = d > 1e-9 ? clamp((want - acc) / d, 0, 1) : 0;
        xs[i] = lerp(a[0], b[0], f);
        ys[i] = lerp(a[1], b[1], f);
        zs[i] = lerp(a[2], b[2], f);
        hws[i] = lerp(a[3], b[3], f) * 0.5; // the table is FULL width
        break;
      }
      acc += d;
      ri++;
    }
  }
  xs[N] = xs[0]; ys[N] = ys[0]; zs[N] = zs[0]; hws[N] = hws[0];

  for (let i = 0; i <= N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    angs[i] = Math.atan2(zs[b] - zs[a], xs[b] - xs[a]);
    // §A1: pitch = atan2(dy, ds_horizontal). Positive is uphill in the driving
    // direction, so GP2's along-track term is -G_SLOPE * sin(pitch).
    const dh = Math.hypot(xs[b] - xs[a], zs[b] - zs[a]);
    pitches[i] = Math.atan2(ys[b] - ys[a], Math.max(1e-4, dh));
  }
  for (let i = 0; i <= N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    curv[i] = wrapPi(angs[b] - angs[a]) / (2 * stepR);
  }

  // ---- zone lookups, all client-only (§A3) --------------------------------
  const qOfIndex = (i) => frac1((i * stepR - sFin) / LAP);
  const zoneAt = (rows, q, base, pick) => {
    let v = base;
    for (const r of rows) {
      const w = windowAt(r.q0, r.q1, q);
      if (w > 0) v = pick(v, r, w);
    }
    return v;
  };
  /** A smooth 0..1 window over a wrapping q range, so nothing pops. */
  function windowAt(q0, q1, q) {
    let a = frac1(q0);
    let b = frac1(q1);
    let t = frac1(q - a);
    let span = frac1(b - a);
    if (span < 1e-6) return 0;
    if (t > span) return 0;
    const edge = Math.min(0.25, 0.35 * span);
    return Math.min(smooth(t / edge), smooth((span - t) / edge));
  }

  const gripAt = (q) => zoneAt(row.grip, q, 1, (v, r, w) => v * lerp(1, r.mul, w));
  const jumpAt = (q) => zoneAt(row.jumps, q, 0, (v, r, w) => Math.max(v, r.launch * (w > 0.15 ? 1 : 0)));
  const bankAmpAt = (q) => zoneAt(row.banks, q, 0, (v, r, w) => v + r.roll * w);

  // Banking is baked into the LUT so the ribbon, the karts and the camera all
  // read one number. Sign follows the corner: the OUTSIDE edge lifts. The
  // smoothing pass matters: sign(curv) can flip across an inflection, and an
  // un-smoothed flip would snap the road (and the camera roll) in one sample.
  if (row.banks.length) {
    const rawBank = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const amp = bankAmpAt(qOfIndex(i));
      rawBank[i] = amp === 0 ? 0 : -Math.sign(curv[i] || 1) * amp;
    }
    for (let i = 0; i <= N; i++) {
      let acc2 = 0;
      for (let d = -3; d <= 3; d++) acc2 += rawBank[((i + d) % N + N) % N];
      bank[i] = acc2 / 7;
    }
    bank[N] = bank[0];
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < N; i++) { if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i]; }

  /**
   * An offset path folds through its own centre of curvature once
   * |lat*hw| > 1/|curv|, so every world offset is squeezed to stay on the
   * outside of the tightest hairpins. `lat` on the wire is untouched: this only
   * shapes geometry.
   */
  function safeOffset(d, c) {
    if (d * c > 0.72) return 0.72 / c;
    return d;
  }

  const at = (s, out = {}) => {
    let u = s % LAP;
    if (u < 0) u += LAP;
    const f = u / stepR;
    const i = Math.floor(f);
    const t = f - i;
    const j = i + 1;
    out.x = lerp(xs[i], xs[j], t);
    out.y = lerp(ys[i], ys[j], t);
    out.z = lerp(zs[i], zs[j], t);
    out.hw = lerp(hws[i], hws[j], t);
    out.ang = angLerp(angs[i], angs[j], t);
    out.pitch = lerp(pitches[i], pitches[j], t);
    out.curv = lerp(curv[i], curv[j], t);
    out.bank = lerp(bank[i], bank[j], t);
    return out;
  };

  const _t = {};
  /** (q, lat) -> world. `y` is the road surface INCLUDING the banking lift. */
  const worldOf = (q, lat, out = {}) => {
    at(frac1(q) * LAP + sFin, _t);
    const d = safeOffset(lat * _t.hw, _t.curv);
    const sa = Math.sin(_t.ang);
    const ca = Math.cos(_t.ang);
    out.x = _t.x - sa * d;
    out.z = _t.z + ca * d;
    out.y = _t.y + d * _t.bank;
    out.ang = _t.ang;
    out.hw = _t.hw;
    out.pitch = _t.pitch;
    out.bank = _t.bank;
    out.curv = _t.curv;
    return out;
  };

  const track = {
    // ---- identity + contract numbers
    row,
    id: row.id,
    name: row.name,
    theme: row.theme,
    palette: pal,
    LAP_UNITS: LAP,
    sFin,
    checkpoints: row.checkpoints,
    floors: row.floors,
    laps: row.laps,
    minRunMs: row.minRunMs,
    aiSectors: row.aiSectors,
    maxQPerS: Q_CLAMP_U_PER_S / LAP,
    scale: k,

    // ---- the LUT itself (read-only; GP2 walks these for decor and the map)
    step: stepR,
    n: N,
    x: xs, y: ys, z: zs, hw: hws, ang: angs, pitch: pitches, curv, bank,
    yMin, yMax,

    // ---- sampling
    at, worldOf, safeOffset,
    angleAt(s) { return at(s, _t).ang; },
    pitchAt(q) { return at(frac1(q) * LAP + sFin, _t).pitch; },
    bankAt(q) { return at(frac1(q) * LAP + sFin, _t).bank; },
    halfWidthAt(q) { return at(frac1(q) * LAP + sFin, _t).hw; },
    heightAt(q, lat) { return worldOf(q, lat, _t).y; },
    qOfIndex,
    indexOfQ(q) { return Math.round((frac1(q) * LAP + sFin) / stepR) % N; },

    // ---- client-only zones (§A3). Never on the wire, never a hit.
    gripAt, jumpAt,
    grip: row.grip,
    jumps: row.jumps,
    banks: row.banks,

    /**
     * Centreline point for LUT index `i`, offset laterally by `d` world units.
     * `out[0] = x, out[1] = z, out[2] = y` — the first two keep the shipped
     * 2D convention so existing call sites are untouched; use edgeXYZ for the
     * natural order.
     */
    edge(i, d, out) {
      const c = curv[i];
      const dd = d * c > 0.72 ? 0.72 / c : d;
      out[0] = xs[i] - Math.sin(angs[i]) * dd;
      out[1] = zs[i] + Math.cos(angs[i]) * dd;
      out[2] = ys[i] + dd * bank[i];
      return out;
    },
    edgeXYZ(i, d, out) {
      const c = curv[i];
      const dd = d * c > 0.72 ? 0.72 / c : d;
      out[0] = xs[i] - Math.sin(angs[i]) * dd;
      out[1] = ys[i] + dd * bank[i];
      out[2] = zs[i] + Math.cos(angs[i]) * dd;
      return out;
    },

    // ---- §A1.3 grid + checkpoints
    gridSlot(slot, out = {}) {
      const s = clamp(Math.round(slot) || 0, 0, 5);
      const u = LAP - GRID_ROWS_U[Math.min(GRID_ROWS_U.length - 1, Math.floor(s / 2))];
      out.q = frac1(u / LAP);
      out.lat = GRID_LAT[s % 2];
      return out;
    },
    checkpointQ(c) { return (c % row.checkpoints) / row.checkpoints; },

    // ---- item boxes, in the order the amendment writes them (ids 0..10)
    boxes: row.itemBoxes.map((b, i) => ({ i, q: b[0], lat: b[1] })),
    hazards: row.hazards,

    /** §A2 pose in track space, and the same pose in world space. */
    hazardPose(h, T, out) { return hazardPose(h, T, out); },
    hazardWorld(h, T, out = {}) {
      hazardPose(h, T, _hz);
      return worldOf(_hz.q, _hz.lat, out);
    },

    /** §A7 — the payload kart-hud.js takes for its elevation-shaded minimap. */
    hudTrack(maxPoints = 132) { return hudTrack(track, maxPoints); },
  };
  return track;
}

/**
 * §A7 — `{ id, name, theme, road, yMin, yMax, points:[{x,z,y}] }`. The polyline
 * is decimated so the HUD paints ~130 segments, not 300, and it is CLOSED (the
 * first point is repeated at the end) so the shading has no seam.
 */
export function hudTrack(track, maxPoints = 132) {
  const stride = Math.max(1, Math.round(track.n / maxPoints));
  const points = [];
  for (let i = 0; i < track.n; i += stride) {
    points.push({ x: track.x[i], z: track.z[i], y: track.y[i] });
  }
  points.push({ x: track.x[0], z: track.z[0], y: track.y[0] });
  const fi = track.indexOfQ(0);
  return {
    id: track.id,
    name: track.name,
    theme: track.theme,
    road: track.palette.road,
    yMin: track.yMin,
    yMax: track.yMax,
    laps: track.laps,
    finish: { x: track.x[fi], z: track.z[fi], ang: track.ang[fi] },
    points,
  };
}

// ========================================================= surface ribbons ====
/**
 * Road, kerbs and run-off are THREE merged ribbons (§6), never per-segment
 * meshes. Each is a closed strip walked once around the LUT with a baked vertex
 * colour and a real per-quad normal, so a banked or climbing surface still
 * catches the light correctly and the whole circuit costs 3 draw calls.
 */
function buildRibbon(track, bands) {
  const N = track.n;
  const pos = [];
  const nor = [];
  const cols = [];
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const d = [0, 0, 0];
  const e1 = [0, 0, 0];
  const e2 = [0, 0, 0];
  const nrm = [0, 0, 0];
  for (const band of bands) {
    const dy = band.y ?? 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const hwI = track.hw[i];
      const hwJ = track.hw[j];
      track.edgeXYZ(i, band.inner * hwI, a);
      track.edgeXYZ(i, band.outer * hwI, b);
      track.edgeXYZ(j, band.outer * hwJ, c);
      track.edgeXYZ(j, band.inner * hwJ, d);
      a[1] += dy; b[1] += dy; c[1] += dy; d[1] += dy;
      for (let k = 0; k < 3; k++) { e1[k] = b[k] - a[k]; e2[k] = c[k] - a[k]; }
      nrm[0] = e1[1] * e2[2] - e1[2] * e2[1];
      nrm[1] = e1[2] * e2[0] - e1[0] * e2[2];
      nrm[2] = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
      if (nrm[1] < 0) { nrm[0] = -nrm[0]; nrm[1] = -nrm[1]; nrm[2] = -nrm[2]; }
      _col.setHex(band.color(i, N));
      const quad = [a, b, c, a, c, d];
      for (const p of quad) {
        pos.push(p[0], p[1], p[2]);
        nor.push(nrm[0] / nl, nrm[1] / nl, nrm[2] / nl);
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

const mixHex = (a, b, t) => {
  _col.setHex(a);
  _colB.setHex(b);
  return _col.lerp(_colB, clamp(t, 0, 1)).getHex();
};

/**
 * Asphalt with lane shading, white edge lines, a checkered start band and the
 * surface TINT ZONES the amendment asks for: an icy sheen wherever a grip zone
 * bites, and a gold launch strip on a jump run-up. The tint is read straight
 * off the same `gripAt`/`jumpAt` the physics uses, so what you see is what you
 * are about to feel.
 */
function roadBands(track) {
  const pal = track.palette;
  const finI = track.indexOfQ(0);
  const surface = (i) => {
    const back = (finI - i + track.n) % track.n;
    if (back < 4) return (i + back) % 2 === 0 ? pal.checkA : pal.checkB;
    // gentle blotching so a 600-unit ribbon is never one flat grey
    const t = (Math.sin(i * 0.7) + Math.sin(i * 0.19 + 1.3)) * 0.25 + 0.5;
    let col = t > 0.62 ? pal.roadLight : t < 0.36 ? pal.roadDark : pal.road;
    const q = track.qOfIndex(i);
    const g = track.gripAt(q);
    if (g < 0.995) col = mixHex(col, pal.slick, clamp((1 - g) * 1.5, 0, 0.9));
    const j = track.jumpAt(q);
    if (j > 0) col = i % 3 === 0 ? pal.launch : mixHex(col, pal.launch, 0.55);
    return col;
  };
  return [
    { inner: -1.0, outer: -0.955, y: 0.012, color: () => pal.line },
    { inner: -0.955, outer: 0, y: 0.01, color: surface },
    { inner: 0, outer: 0.955, y: 0.01, color: surface },
    { inner: 0.955, outer: 1.0, y: 0.012, color: () => pal.line },
  ];
}

/** Kerbs. The stripe period is in LUT steps, so it stays even round a corner. */
function kerbBands(track) {
  const pal = track.palette;
  const stripe = (i) => (Math.floor(i / 2) % 2 === 0 ? pal.kerbA : pal.kerbB);
  return [
    { inner: -1.24, outer: -1.0, y: 0.055, color: stripe },
    { inner: 1.0, outer: 1.24, y: 0.055, color: stripe },
  ];
}

/** Run-off aprons outside the kerbs, in the theme's ground material. */
function apronBands(track) {
  const pal = track.palette;
  const grit = (i) => (Math.sin(i * 1.1) > 0.35 ? pal.apronAlt : pal.apron);
  return [
    { inner: -1.78, outer: -1.24, y: -0.02, color: grit },
    { inner: 1.24, outer: 1.78, y: -0.02, color: grit },
  ];
}

/**
 * How deep the skirt may hang at each LUT index, in world units below the
 * CENTRELINE (never below the edge, so banking cannot deepen it).
 *
 * A two-floor track drives under itself, and a fixed depth turns the upper
 * road's curtain into a dirt wall across the lower one: tangle's viaduct has
 * only 6.9-9.2u of clearance over the straight it crosses and glimmer's jump
 * 12.6-14.3u, both less than the flat 8..13.5u the relief asks for. So the
 * depth is clamped per index to the headroom above whatever road passes
 * beneath, and then slope-limited so the hem tapers instead of stepping.
 */
function skirtDrops(track, depth) {
  const N = track.n;
  const xs = track.x;
  const ys = track.y;
  const zs = track.z;
  const hw = track.hw;
  const bank = track.bank;
  const drops = new Float32Array(N);
  /** Headroom left above the lower road, so the crossing reads as a crossing. */
  const CLEAR = 1.6;
  /** A curtain shorter than this is not worth drawing, but the edge still is. */
  const MIN_DROP = 0.9;
  /** Depth change allowed per LUT step (~2u), so the hem is a taper, not a cliff. */
  const SLOPE = 0.45;
  /** Ignore anything within this much arc length: that is the same hill, not a floor below. */
  const NEAR_U = 30;
  const nearIdx = Math.max(2, Math.round(NEAR_U / track.step));

  for (let i = 0; i < N; i++) {
    let top = -Infinity;       // the highest road surface strictly below this one
    for (let j = 0; j < N; j++) {
      let d = i - j;
      if (d < 0) d = -d;
      if (d > N - d) d = N - d;
      if (d <= nearIdx) continue;
      // the lower road's own banking lifts its outer edge; respect that, not its centre
      const jTop = ys[j] + Math.abs(bank[j]) * 1.3 * hw[j];
      if (ys[i] - jTop <= 1.0) continue;
      const reach = 1.9 * hw[i] + 1.3 * hw[j];
      const dx = xs[i] - xs[j];
      const dz = zs[i] - zs[j];
      if (dx * dx + dz * dz > reach * reach) continue;
      if (jTop > top) top = jTop;
    }
    drops[i] = top === -Infinity ? depth : clamp(ys[i] - top - CLEAR, MIN_DROP, depth);
  }

  // Erosion, not a blur: a pass may only SHORTEN a column, so the clamp above
  // survives the smoothing. Three sweeps close the wrap on a closed circuit.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < N; i++) {
      const p = (i - 1 + N) % N;
      if (drops[p] + SLOPE < drops[i]) drops[i] = drops[p] + SLOPE;
    }
    for (let i = N - 1; i >= 0; i--) {
      const nx = (i + 1) % N;
      if (drops[nx] + SLOPE < drops[i]) drops[i] = drops[nx] + SLOPE;
    }
  }
  return drops;
}

/**
 * A skirt hanging off the outside of the apron. On a flat track it is invisible;
 * on an elevated one it is what stops the road reading as a paper cut-out
 * floating over the valley, and it is what makes a viaduct look like a viaduct.
 */
function skirtGeo(track, depth = 7) {
  const N = track.n;
  const pos = [];
  const nor = [];
  const cols = [];
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const pal = track.palette;
  const drops = skirtDrops(track, depth);
  _colB.setHex(pal.apron);
  // The hem is measured from the CENTRELINE (never below the road passing
  // underneath) while the top follows the banked edge, so a banked corner
  // cannot quietly lengthen the curtain. The 0.35 keeps a quad from inverting.
  const hem = (i, edgeY) => Math.min(edgeY - 0.35, track.y[i] - drops[i]);
  for (const side of [-1, 1]) {
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      track.edgeXYZ(i, side * 1.78 * track.hw[i], a);
      track.edgeXYZ(j, side * 1.78 * track.hw[j], b);
      const ay = hem(i, a[1]);
      const by = hem(j, b[1]);
      const nx = -Math.sin(track.ang[i]) * side;
      const nz = Math.cos(track.ang[i]) * side;
      const quad = [
        [a[0], a[1] - 0.02, a[2]], [a[0], ay, a[2]], [b[0], by, b[2]],
        [a[0], a[1] - 0.02, a[2]], [b[0], by, b[2]], [b[0], b[1] - 0.02, b[2]],
      ];
      const shade = 0.55 + 0.2 * Math.sin(i * 0.6);
      _col.setHex(pal.ground).lerp(_colB, 0.35).multiplyScalar(shade);
      for (const p of quad) {
        pos.push(p[0], p[1], p[2]);
        nor.push(nx, 0.15, nz);
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

// ============================================================ shared props ====
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
      rx: Math.sin(a) * 0.95, rz: -Math.cos(a) * 0.95,
      color: i % 2 ? 0x5aa83c : 0x7ac74f,
    });
  }
  parts.push({ geo: new THREE.SphereGeometry(0.34, 7, 5), x: 0.6, y: 5.1, color: 0xd8a43c });
  return mergeParts(parts);
}

function tyreGeo(accent) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.55, 0.55, 0.32, 10),
      y: 0.17 + i * 0.31, ry: i * 0.5,
      color: i % 2 ? 0x3a3540 : 0x2c2833,
    });
    parts.push({
      geo: new THREE.CylinderGeometry(0.26, 0.26, 0.34, 8),
      y: 0.17 + i * 0.31, color: i === 1 ? accent : 0xfff6e2,
    });
  }
  return mergeParts(parts);
}

function baleGeo() {
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.62, 0.62, 1.5, 9), rz: Math.PI / 2, y: 0.62, color: 0xe0c274 },
    { geo: new THREE.TorusGeometry(0.63, 0.06, 4, 10), ry: Math.PI / 2, x: -0.4, y: 0.62, color: 0xb99a52 },
    { geo: new THREE.TorusGeometry(0.63, 0.06, 4, 10), ry: Math.PI / 2, x: 0.4, y: 0.62, color: 0xb99a52 },
  ]);
}

/** A bunting arch: two posts and a swagged rope of little pennants. */
function archGeo(pal) {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.CylinderGeometry(0.16, 0.2, 5.2, 6), x: side * 5.6, y: 2.6, color: 0xe6d9bd });
    parts.push({ geo: new THREE.SphereGeometry(0.26, 7, 5), x: side * 5.6, y: 5.3, color: pal.accent });
  }
  const flagCols = [pal.kerbA, pal.accent, 0x4fb3e8, 0x7ac74f, 0xfff6e2];
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

function gullGeo(body = 0xfdfbf4, beak = 0xf2b64a) {
  return mergeParts([
    { geo: new THREE.SphereGeometry(0.16, 7, 5), sz: 1.5, color: body },
    { geo: new THREE.SphereGeometry(0.1, 6, 5), z: 0.24, y: 0.06, color: body },
    { geo: new THREE.ConeGeometry(0.04, 0.14, 4), z: 0.34, y: 0.05, rx: Math.PI / 2, color: beak },
    { geo: new THREE.BoxGeometry(0.62, 0.03, 0.16), x: -0.34, y: 0.06, rz: 0.3, color: body },
    { geo: new THREE.BoxGeometry(0.62, 0.03, 0.16), x: 0.34, y: 0.06, rz: -0.3, color: body },
  ]);
}

/** Grandstand: merged steps plus a bunting roofline, one draw call. */
function standGeo(len, pal) {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    parts.push({
      geo: new THREE.BoxGeometry(len, 0.55, 1.5),
      y: 0.28 + i * 0.55, z: -i * 1.5, color: i % 2 ? 0xe6d9bd : 0xd8c8a6,
    });
  }
  parts.push({ geo: new THREE.BoxGeometry(len, 0.3, 0.4), y: 3.1, z: -6.4, color: pal.kerbA });
  return mergeParts(parts);
}

function lighthouseGeo(pal) {
  const parts = [{ geo: new THREE.CylinderGeometry(2.4, 3.4, 2.0, 12), y: 1.0, color: 0xcfc6b4 }];
  for (let i = 0; i < 6; i++) {
    parts.push({
      geo: new THREE.CylinderGeometry(1.5 - i * 0.13, 1.7 - i * 0.13, 2.2, 12),
      y: 3.1 + i * 2.2, color: i % 2 ? pal.kerbA : 0xfff6e2,
    });
  }
  parts.push({ geo: new THREE.CylinderGeometry(1.35, 1.35, 1.5, 12), y: 17.2, color: 0x6a6377 });
  parts.push({ geo: new THREE.SphereGeometry(1.0, 10, 7), y: 17.4, color: 0xfff0b0 });
  parts.push({ geo: new THREE.ConeGeometry(1.6, 1.6, 12), y: 18.7, color: 0x4a4356 });
  parts.push({ geo: new THREE.SphereGeometry(0.24, 6, 5), y: 19.7, color: pal.accent });
  return mergeParts(parts);
}

/**
 * The start gantry: five lamps on the crossbeam matching the HUD's five bulbs
 * (§A7.6), a checkered banner and a pair of legs in the theme's accent.
 */
function gantryGeo(span, pal) {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(0.7, 7.2, 0.7), x: side * span, y: 3.6, color: pal.accent });
    parts.push({ geo: new THREE.BoxGeometry(1.4, 0.4, 1.4), x: side * span, y: 0.2, color: 0xd39a2f });
    parts.push({ geo: new THREE.SphereGeometry(0.45, 8, 6), x: side * span, y: 7.4, color: pal.kerbA });
  }
  parts.push({ geo: new THREE.BoxGeometry(span * 2 + 0.7, 0.55, 0.9), y: 7.0, color: pal.accent });
  parts.push({ geo: new THREE.BoxGeometry(span * 2 - 0.6, 1.5, 0.3), y: 6.1, color: 0xfff6e2 });
  const cols = Math.max(2, Math.floor((span * 2) / 0.85));
  for (let i = 0; i < cols; i++) {
    for (let r = 0; r < 2; r++) {
      parts.push({
        geo: new THREE.BoxGeometry(0.85, 0.4, 0.12),
        x: -span + 0.6 + i * 0.85, y: 5.7 + r * 0.4, z: -0.2,
        color: (i + r) % 2 ? pal.checkB : pal.checkA,
      });
    }
  }
  for (let i = 0; i < 5; i++) {
    parts.push({
      geo: new THREE.SphereGeometry(0.28, 8, 6),
      x: (i - 2) * 1.1, y: 7.0, z: 0.5, color: 0x4a3b3b,
    });
  }
  return mergeParts(parts);
}

// ---------------------------------------------------------- summit props ----
function pineGeo() {
  const parts = [
    { geo: new THREE.CylinderGeometry(0.24, 0.34, 1.6, 6), y: 0.8, color: 0x6b4f35 },
  ];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    parts.push({
      geo: new THREE.ConeGeometry(2.0 - t * 1.25, 2.4, 7),
      y: 1.9 + i * 1.5, color: i % 2 ? 0x2f6b46 : 0x3c7c52,
    });
    parts.push({
      geo: new THREE.ConeGeometry(2.05 - t * 1.25, 0.34, 7),
      y: 2.75 + i * 1.5, color: 0xf2f8ff,
    });
  }
  return mergeParts(parts);
}

function snowBankGeo() {
  return mergeParts([
    { geo: new THREE.SphereGeometry(1.5, 8, 5), y: 0.2, sy: 0.55, color: 0xf2f8ff },
    { geo: new THREE.SphereGeometry(1.0, 8, 5), x: 1.3, y: 0.1, sy: 0.5, color: 0xe4eef8 },
    { geo: new THREE.SphereGeometry(0.8, 7, 5), x: -1.2, y: 0.1, sy: 0.5, color: 0xe4eef8 },
  ]);
}

/** The low ice wall the hairpin hangs over: a slab you can see the drop past. */
function iceWallGeo() {
  return mergeParts([
    { geo: new THREE.BoxGeometry(3.0, 1.1, 0.55), y: 0.55, color: 0xbfe4f7 },
    { geo: new THREE.BoxGeometry(3.1, 0.16, 0.7), y: 1.16, color: 0xfdfbf4 },
    { geo: new THREE.BoxGeometry(0.34, 1.3, 0.75), x: -1.4, y: 0.65, color: 0x9fc4e0 },
    { geo: new THREE.BoxGeometry(0.34, 1.3, 0.75), x: 1.4, y: 0.65, color: 0x9fc4e0 },
  ]);
}

/** A timber lodge with the peak's warm gold windows, seen once on the descent. */
function lodgeGeo() {
  const parts = [
    { geo: new THREE.BoxGeometry(9, 4.2, 7), y: 2.1, color: 0x8a6642 },
    { geo: new THREE.BoxGeometry(10.4, 0.5, 8.4), y: 4.3, color: 0x6b4f35 },
    { geo: new THREE.ConeGeometry(7.6, 3.4, 4), y: 6.2, ry: Math.PI / 4, color: 0xf2f8ff },
    { geo: new THREE.CylinderGeometry(0.5, 0.6, 2.4, 6), x: 3, y: 6.6, color: 0x9fa6b2 },
  ];
  for (let i = 0; i < 3; i++) {
    parts.push({
      geo: new THREE.BoxGeometry(1.5, 1.4, 0.2), x: (i - 1) * 2.7, y: 2.4, z: 3.55, color: 0xffd77a,
    });
  }
  parts.push({ geo: new THREE.BoxGeometry(1.5, 2.6, 0.24), y: 1.3, z: -3.6, color: 0x6b4f35 });
  return mergeParts(parts);
}

/** The cove's own peak on the skyline: three snow cones, backdrop only. */
function peakGeo() {
  return mergeParts([
    { geo: new THREE.ConeGeometry(38, 62, 8), y: 31, color: 0x8fb0cc },
    { geo: new THREE.ConeGeometry(13, 20, 8), y: 52, color: 0xf2f8ff },
    { geo: new THREE.ConeGeometry(24, 38, 7), x: 44, z: 16, y: 19, color: 0x7ea3c2 },
    { geo: new THREE.ConeGeometry(8.5, 12, 7), x: 44, z: 16, y: 32, color: 0xeaf3ff },
  ]);
}

// ---------------------------------------------------------- tangle props ----
function ruinPillarGeo() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.72 - i * 0.04, 0.78 - i * 0.04, 1.3, 8),
      y: 0.65 + i * 1.28, ry: i * 0.4, color: i % 2 ? 0x9a9683 : 0x8b8776,
    });
  }
  parts.push({ geo: new THREE.BoxGeometry(1.9, 0.34, 1.9), y: 5.4, color: 0xa8a48f });
  parts.push({ geo: new THREE.SphereGeometry(0.5, 7, 5), y: 5.7, sy: 0.5, color: 0x4f8f3a });
  return mergeParts(parts);
}

function ruinArchGeo() {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(1.5, 6.4, 1.5), x: side * 5.4, y: 3.2, color: 0x9a9683 });
    parts.push({ geo: new THREE.BoxGeometry(1.9, 0.5, 1.9), x: side * 5.4, y: 6.6, color: 0xa8a48f });
  }
  parts.push({ geo: new THREE.BoxGeometry(12.6, 1.1, 1.7), y: 7.2, color: 0x8b8776 });
  parts.push({ geo: new THREE.BoxGeometry(11.4, 0.5, 2.0), y: 7.9, color: 0xa8a48f });
  for (let i = 0; i < 6; i++) {
    parts.push({
      geo: new THREE.SphereGeometry(0.55, 6, 5), x: -4.6 + i * 1.85, y: 7.9, sy: 0.5, color: 0x4f8f3a,
    });
  }
  return mergeParts(parts);
}

function fernGeo() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    parts.push({
      geo: new THREE.ConeGeometry(0.3, 1.9, 3),
      x: Math.cos(a) * 0.55, y: 0.95, z: Math.sin(a) * 0.55,
      rx: Math.sin(a) * 0.55, rz: -Math.cos(a) * 0.55,
      color: i % 2 ? 0x5aa83c : 0x7ac74f,
    });
  }
  return mergeParts(parts);
}

/** The swinging hazard: a bundle of vines under a stone lintel, pivot at y = 0. */
function vineGeo() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * 0.46;
    const len = 3.2 + Math.sin(i * 2.1) * 0.5;
    parts.push({
      geo: new THREE.CylinderGeometry(0.09, 0.07, len, 5),
      x, y: -len / 2, color: i % 2 ? 0x4f8f3a : 0x62a844,
    });
    parts.push({
      geo: new THREE.SphereGeometry(0.3, 6, 5), x, y: -len + 0.1, sy: 0.6, color: 0x7ac74f,
    });
    if (i % 2 === 0) {
      parts.push({
        geo: new THREE.ConeGeometry(0.24, 0.7, 3), x: x + 0.2, y: -len * 0.55, rz: 0.8, color: 0xe8657a,
      });
    }
  }
  return mergeParts(parts);
}

function boulderGeo() {
  return mergeParts([
    { geo: new THREE.IcosahedronGeometry(1.5, 0), color: 0x8b8776 },
    { geo: new THREE.IcosahedronGeometry(1.1, 0), x: 0.6, y: 0.5, z: 0.4, color: 0x9a9683 },
    { geo: new THREE.SphereGeometry(0.6, 6, 5), x: -0.5, y: 0.9, sy: 0.4, color: 0x4f8f3a },
    { geo: new THREE.SphereGeometry(0.45, 6, 5), x: 0.9, y: -0.6, z: -0.5, sy: 0.4, color: 0x62a844 },
  ]);
}

function parrotGeo() {
  return mergeParts([
    { geo: new THREE.SphereGeometry(0.17, 7, 5), sz: 1.5, color: 0xe8657a },
    { geo: new THREE.SphereGeometry(0.11, 6, 5), z: 0.25, y: 0.06, color: 0xf2b64a },
    { geo: new THREE.ConeGeometry(0.05, 0.15, 4), z: 0.35, y: 0.04, rx: Math.PI / 2, color: 0xfff6e2 },
    { geo: new THREE.BoxGeometry(0.66, 0.04, 0.18), x: -0.36, y: 0.06, rz: 0.3, color: 0x4fb3e8 },
    { geo: new THREE.BoxGeometry(0.66, 0.04, 0.18), x: 0.36, y: 0.06, rz: -0.3, color: 0x7ac74f },
    { geo: new THREE.ConeGeometry(0.1, 0.5, 3), z: -0.36, rx: -Math.PI / 2, color: 0xf2b64a },
  ]);
}

// --------------------------------------------------------- glimmer props ----
function crystalGeo(color) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    parts.push({
      geo: new THREE.ConeGeometry(0.42 - i * 0.05, 2.6 - i * 0.4, 5),
      x: Math.cos(a) * 0.5, z: Math.sin(a) * 0.5, y: 1.2 - i * 0.18,
      rx: Math.sin(a) * 0.3, rz: -Math.cos(a) * 0.3, color,
    });
  }
  parts.push({ geo: new THREE.IcosahedronGeometry(0.7, 0), y: 0.2, color: 0x3a3342 });
  return mergeParts(parts);
}

function lanternGeo() {
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.05, 0.05, 0.6, 5), y: 0.3, color: 0x6b4f35 },
    { geo: new THREE.SphereGeometry(0.34, 8, 6), y: -0.1, color: 0xffd77a },
    { geo: new THREE.CylinderGeometry(0.2, 0.28, 0.16, 6), y: 0.14, color: 0x8a6642 },
  ]);
}

function timberFrameGeo(span, height) {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(0.6, height, 0.6), x: side * span, y: height / 2, color: 0x8a6642 });
    parts.push({ geo: new THREE.BoxGeometry(1.6, 0.4, 0.9), x: side * (span - 0.6), y: height - 0.5, rz: side * 0.5, color: 0x6b4f35 });
  }
  parts.push({ geo: new THREE.BoxGeometry(span * 2 + 0.8, 0.6, 0.8), y: height, color: 0x8a6642 });
  return mergeParts(parts);
}

/** The mine cart hazard: a wooden tub on four little iron wheels. */
function cartGeo() {
  const parts = [
    { geo: new THREE.BoxGeometry(2.0, 1.1, 1.5), y: 0.95, color: 0x8a6642 },
    { geo: new THREE.BoxGeometry(2.1, 0.18, 1.6), y: 1.5, color: 0x6b4f35 },
    { geo: new THREE.BoxGeometry(1.6, 0.3, 1.1), y: 1.5, color: 0x42d6c8 },
  ];
  for (const sx of [-0.72, 0.72]) {
    for (const sz of [-0.62, 0.62]) {
      parts.push({
        geo: new THREE.CylinderGeometry(0.36, 0.36, 0.16, 8),
        x: sx, y: 0.36, z: sz, rz: Math.PI / 2, color: 0x3a3540,
      });
    }
  }
  return mergeParts(parts);
}

function railGeo(len) {
  const parts = [
    { geo: new THREE.BoxGeometry(len, 0.12, 0.16), z: -0.62, y: 0.16, color: 0x6f6455 },
    { geo: new THREE.BoxGeometry(len, 0.12, 0.16), z: 0.62, y: 0.16, color: 0x6f6455 },
  ];
  const ties = Math.max(2, Math.round(len / 1.6));
  for (let i = 0; i < ties; i++) {
    parts.push({
      geo: new THREE.BoxGeometry(0.32, 0.1, 1.7),
      x: -len / 2 + (i + 0.5) * (len / ties), y: 0.06, color: 0x5a4a38,
    });
  }
  return mergeParts(parts);
}

function stalactiteGeo() {
  return mergeParts([
    { geo: new THREE.ConeGeometry(1.1, 5.2, 6), y: -2.6, rx: Math.PI, color: 0x4a4150 },
    { geo: new THREE.ConeGeometry(0.5, 2.4, 5), x: 1.3, y: -1.2, rx: Math.PI, color: 0x3d3847 },
  ]);
}

// ================================================================== sky ======
/** Vertical gradient dome. Follows the camera, ignores fog, never lit. */
function buildSky(pal) {
  const geo = new THREE.SphereGeometry(600, 20, 14);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const top = new THREE.Color(pal.skyTop);
  const mid = new THREE.Color(pal.skyMid);
  const low = new THREE.Color(pal.skyLow);
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

// ============================================================== the world ====
/**
 * Build every mesh a track needs into one Group and return the handle.
 *
 *   const world = buildTrackWorld(scene, track, { vcMat, rng, lights: true });
 *   world.update(dt, time, raceMs, camera.position);   // every frame
 *   world.dispose();                                   // once, in dispose()
 *
 * Everything is parented to `world.group`, so a caller that would rather sweep
 * the scene graph itself can just remove that one node. Geometries, unique
 * materials and textures are collected on `world.geos/mats/texs` for the same
 * reason: GP2 can push them onto its own lists or call `world.dispose()`.
 *
 * Budget: 3 ribbons + 1 skirt + ground + sky + 6-9 instanced families + one
 * landmark + the hazard families. Well inside the room budget of ~120 draw
 * calls, and one draw call per instanced family exactly as §6 demands.
 */
export function buildTrackWorld(scene, track, opts = {}) {
  const pal = track.palette;
  const rng = opts.rng || mulberry32(0xca9b0a ^ track.id.length * 2654435761);
  const geos = [];
  const mats = [];
  const texs = [];
  const anim = [];
  // Where the action is. Ambient systems (snowfall, the sky dome, the sun) ride
  // this instead of the origin, so a 600-unit lap is dressed everywhere.
  const focus = new THREE.Vector3();
  const group = new THREE.Group();
  group.name = `kart-track-${track.id}`;
  scene.add(group);

  // A caller that already owns a vertex-colour toon material passes it in; we
  // never dispose a material we did not make.
  const vc = opts.vcMat || makeToon(0xffffff, { vertexColors: true });

  const own = (g) => { geos.push(g); return g; };
  const family = (geo, cap, mat = vc) => {
    const im = new THREE.InstancedMesh(own(geo), mat, Math.max(1, cap));
    im.count = 0;
    im.frustumCulled = false;
    group.add(im);
    return im;
  };
  const put = (im, x, y, z, ry, s, rx = 0, rz = 0) => {
    if (im.count >= im.instanceMatrix.count) return;
    _eu.set(rx, ry, rz, 'YXZ');
    _q4.setFromEuler(_eu);
    _v3b.set(x, y, z);
    _sc.set(s, s, s);
    _m4.compose(_v3b, _q4, _sc);
    im.setMatrixAt(im.count++, _m4);
  };
  const solid = (geo, x, y, z, ry, castShadow = false) => {
    const m = new THREE.Mesh(own(geo), vc);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = castShadow;
    group.add(m);
    return m;
  };
  const edge = [0, 0, 0];
  /** World point at LUT index i, `d` world units to the side, plus `dy` up. */
  const side = (i, d, dy = 0) => {
    track.edgeXYZ(i, d, edge);
    edge[1] += dy;
    return edge;
  };
  const atQ = (q, out = {}) => track.at(frac1(q) * track.LAP_UNITS + track.sFin, out);

  // ---- surfaces -----------------------------------------------------------
  const ribbons = [];
  for (const bands of [apronBands(track), kerbBands(track), roadBands(track)]) {
    const m = new THREE.Mesh(own(buildRibbon(track, bands)), vc);
    m.receiveShadow = true;
    m.frustumCulled = false;
    group.add(m);
    ribbons.push(m);
  }
  // A flat track needs no skirt; an elevated one is unreadable without it.
  if (track.yMax - track.yMin > 1.5) {
    const skirt = new THREE.Mesh(own(skirtGeo(track, Math.max(8, (track.yMax - track.yMin) * 0.75))), vc);
    skirt.frustumCulled = false;
    group.add(skirt);
  }

  // ---- ground and sky -----------------------------------------------------
  const fin = atQ(0, {});
  let sky = null;
  if (opts.sky !== false) {
    sky = buildSky(pal);
    geos.push(sky.geometry);
    mats.push(sky.material);
    group.add(sky);
  }
  if (opts.ground !== false) {
    // A flat track's ground sits just under the apron, exactly as sunny shipped.
    // An elevated one drops its ground well below the lowest road so the skirt
    // has something to stand on and the hills read as hills.
    const relief = track.yMax - track.yMin;
    const floorY = relief < 1.5 ? track.yMin - 0.06 : track.yMin - relief * 0.55 - 3;
    const plate = new THREE.Mesh(own(new THREE.CircleGeometry(320, 40)), makeToon(pal.ground));
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(fin.x * 0.2, floorY, fin.z * 0.2);
    plate.receiveShadow = true;
    group.add(plate);
    const ring = new THREE.Mesh(own(new THREE.RingGeometry(318, 900, 48)), makeToon(pal.rim));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(fin.x * 0.2, floorY - 0.6, fin.z * 0.2);
    group.add(ring);
  }

  // ---- lights -------------------------------------------------------------
  let sun = null;
  let hemi = null;
  if (opts.lights !== false) {
    hemi = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemi);
    group.add(hemi);
    sun = new THREE.DirectionalLight(pal.sun, pal.sunI);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;                  // §6: exactly one shadow caster
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 300;
    sun.shadow.camera.left = -75;
    sun.shadow.camera.right = 75;
    sun.shadow.camera.top = 75;
    sun.shadow.camera.bottom = -75;
    sun.shadow.bias = -0.0012;
    group.add(sun);
    group.add(sun.target);
    const fill = new THREE.DirectionalLight(pal.fill, pal.fillI);
    fill.position.set(-40, 30, -60);
    group.add(fill);
  }

  // ---- barriers: one instanced family down both edges, every theme ---------
  const barrierGeo = track.theme === 'snow' ? iceWallGeo()
    : track.theme === 'jungle' ? ruinPillarGeo()
      : track.theme === 'mine' ? timberFrameGeo(1.3, 3.2)
        : tyreGeo(pal.kerbA);
  // Snow packs tight: the hairpin at q 0.42 hangs over a drop and the ice wall
  // behind it has to read as a wall, not a row of posts.
  const barrierEvery = track.theme === 'beach' ? 7 : track.theme === 'snow' ? 3.4 : 9;
  const barrierScale = track.theme === 'jungle' ? 0.75 : 1;
  const stepI = Math.max(2, Math.round(barrierEvery / track.step));
  const barriers = family(barrierGeo, Math.ceil((track.n / stepI) * 2) + 4);
  for (let i = 0; i < track.n; i += stepI) {
    for (const s of [-1, 1]) {
      const p = side(i, s * 1.85 * track.hw[i]);
      // a wall panel lies ALONG the edge: local +x on the tangent is ry = -ang
      put(barriers, p[0], p[1], p[2], -track.ang[i], barrierScale);
    }
  }
  barriers.castShadow = true;
  barriers.instanceMatrix.needsUpdate = true;

  // ---- the start gantry, shared by every theme ----------------------------
  const gantry = solid(gantryGeo(fin.hw * 1.6, pal), fin.x, fin.y, fin.z, Math.PI / 2 - fin.ang);
  gantry.castShadow = true;
  // ...and the track's own name painted on its banner, so a screenshot always
  // says which circuit it is.
  const nameTex = signTexture(track.name, pal.trim);
  texs.push(nameTex);
  const nameMat = new THREE.MeshBasicMaterial({ map: nameTex, transparent: true, side: THREE.DoubleSide });
  mats.push(nameMat);
  const nameGeo = new THREE.PlaneGeometry(fin.hw * 2.0, fin.hw * 0.5);
  geos.push(nameGeo);
  const board = new THREE.Mesh(nameGeo, nameMat);
  board.position.set(fin.x, fin.y + 6.1, fin.z);
  // The gantry's local +z is the driving direction, so the banner face an
  // approaching kart reads is the one turned back down the road.
  board.rotation.y = Math.PI / 2 - fin.ang + Math.PI;
  board.translateZ(0.4);
  group.add(board);

  // ---- per-theme dressing -------------------------------------------------
  const ctx = { track, pal, rng, family, put, solid, side, atQ, group, geos, mats, texs, anim, vc, focus };
  if (track.theme === 'beach') dressBeach(ctx);
  else if (track.theme === 'snow') dressSnow(ctx);
  else if (track.theme === 'jungle') dressJungle(ctx);
  else dressMine(ctx);

  // ---- hazards: one instanced family per kind (§A2) ------------------------
  const hazFamilies = new Map();
  const kinds = [...new Set(track.hazards.map((h) => h.kind))];
  for (const kind of kinds) {
    const rows = track.hazards.filter((h) => h.kind === kind);
    const geo = kind === 'vine' ? vineGeo() : kind === 'boulder' ? boulderGeo() : cartGeo();
    const im = family(geo, rows.length);
    im.count = rows.length;
    im.castShadow = kind !== 'vine';
    hazFamilies.set(kind, { im, rows });
  }
  // Static furniture that explains each moving hazard: a lintel over a vine, a
  // rail under a cart. Placed once, never animated.
  if (kinds.includes('vine')) {
    for (const h of track.hazards.filter((x) => x.kind === 'vine')) {
      const p = atQ(h.q, {});
      const a = solid(ruinArchGeo(), p.x, p.y, p.z, Math.PI / 2 - p.ang);
      a.scale.setScalar(clamp(p.hw / 5.4, 0.75, 1.4));
    }
  }
  if (kinds.includes('cart')) {
    // The rail lies ACROSS the road, along the cart's travel: local +x is the
    // lateral normal at ry = pi/2 - ang, the same convention as the gantry.
    for (const h of track.hazards.filter((x) => x.kind === 'cart')) {
      const p = atQ(h.q, {});
      solid(railGeo(p.hw * (2 * Math.abs(h.latAmp) + 1.4)), p.x, p.y + 0.03, p.z, Math.PI / 2 - p.ang);
    }
  }
  const hazPose = {};
  const hazWorld = {};
  /** Every moving hazard is a pure function of race time, so this is a redraw. */
  function updateHazards(raceMs, time) {
    const T = Number.isFinite(raceMs) ? raceMs : 0;
    for (const [kind, fam] of hazFamilies) {
      for (let n = 0; n < fam.rows.length; n++) {
        const h = fam.rows[n];
        hazardPose(h, T, hazPose);
        track.worldOf(hazPose.q, hazPose.lat, hazWorld);
        let y = hazWorld.y;
        let ry = Math.PI / 2 - hazWorld.ang;
        let rx = 0;
        let rz = 0;
        let s = 1;
        if (kind === 'vine') {
          // hangs from the lintel and swings; the tilt reads the phase, so the
          // curtain leans the way it is travelling
          y += 4.9;
          rz = -hazPose.w * 0.45;
          s = clamp(hazWorld.hw / 5.4, 0.8, 1.35);
        } else if (kind === 'boulder') {
          y += 1.4;
          // rolls: one turn per 2*pi*r of travel along the road
          rx = (hazPose.q * track.LAP_UNITS) / 1.5;
          s = 1;
        } else {
          // the cart runs ACROSS the road, so its long axis is already aimed
          // down the rail by the default ry; it just rattles a little
          y += 0.06;
          rz = Math.sin(time * 6 + n) * 0.03;
        }
        _eu.set(rx, ry, rz, 'YXZ');
        _q4.setFromEuler(_eu);
        _v3b.set(hazWorld.x, y, hazWorld.z);
        _sc.set(s, s, s);
        _m4.compose(_v3b, _q4, _sc);
        fam.im.setMatrixAt(n, _m4);
      }
      fam.im.instanceMatrix.needsUpdate = true;
    }
  }
  updateHazards(0, 0);

  const world = {
    group, geos, mats, texs, ribbons, sky, sun, hemi, gantry, barriers, focus,
    hazards: hazFamilies,
    palette: pal,
    /** Scatter the ambient birds; GP2 calls it on a lap and at the flag. */
    scareFlock: ctx.scareFlock || (() => {}),
    /** Fog values the caller should set on its own scene. */
    fog: { color: pal.fog, near: pal.fogNear, far: pal.fogFar },

    updateHazards,
    /**
     * One call per frame. `raceMs` drives the hazards (never Date.now(): the
     * server computes from its own race clock and both must agree); `time` is
     * any monotonic seconds counter for ambient life; `camPos` keeps the sky
     * dome and the sun centred on the action.
     */
    update(dt, time, raceMs, camPos) {
      if (camPos) focus.copy(camPos);
      updateHazards(raceMs, time);
      for (const fn of anim) fn(dt, time);
      if (sky && camPos) sky.position.copy(camPos);
      if (sun && camPos) {
        sun.position.set(camPos.x + 60, camPos.y + 90, camPos.z + 30);
        sun.target.position.set(camPos.x, camPos.y - 3, camPos.z);
        sun.target.updateMatrixWorld();
      }
    },

    dispose() {
      group.removeFromParent();
      for (const g of geos) g.dispose?.();
      geos.length = 0;
      for (const m of mats) m.dispose?.();
      mats.length = 0;
      for (const t of texs) t.dispose?.();
      texs.length = 0;
      if (sun) sun.shadow?.dispose?.();
      anim.length = 0;
      hazFamilies.clear();
      group.clear();
    },
  };
  return world;
}

// =========================================================== theme dressing ==
/** Palms, tyre walls, bunting, a crowd, gulls and the lighthouse (unchanged). */
function dressBeach(ctx) {
  const { track: t, pal, rng, family, put, solid, side, atQ, vc } = ctx;
  const palms = family(palmGeo(), 90);
  const bales = family(baleGeo(), 60);
  for (let i = 0; i < t.n; i += 5) {
    const s = rng() < 0.5 ? -1 : 1;
    if (rng() < 0.55) {
      const p = side(i, s * (1.85 * t.hw[i] + 4 + rng() * 9));
      put(palms, p[0], p[1], p[2], rng() * 6.28, 0.8 + rng() * 0.5);
    }
    if (rng() < 0.22) {
      const p = side(i, s * (1.85 * t.hw[i] + 2.2));
      put(bales, p[0], p[1], p[2], t.ang[i] + Math.PI / 2, 1);
    }
  }
  palms.castShadow = true;
  palms.instanceMatrix.needsUpdate = true;
  bales.castShadow = true;
  bales.instanceMatrix.needsUpdate = true;

  const arches = family(archGeo(pal), 10);
  for (const q of [0.08, 0.3, 0.47, 0.63, 0.86]) {
    const s = atQ(q, {});
    put(arches, s.x, s.y, s.z, Math.PI / 2 - s.ang, clamp(s.hw / 5.6, 0.8, 1.4));
  }
  arches.instanceMatrix.needsUpdate = true;

  crowdRows(ctx, [[0.90, 0.06, 30, -1], [0.50, 0.60, 22, 1], [0.27, 0.34, 16, -1]]);

  // Grandstand steps under the main-straight crowd. standGeo runs along local
  // +x and steps back in -z, so it is aimed along the tangent: ry = -ang.
  const sMain = atQ(0.96, {});
  const off = t.safeOffset(-(sMain.hw * 1.85 + 3.4), sMain.curv);
  const stand = solid(standGeo(64, pal),
    sMain.x - Math.sin(sMain.ang) * off, sMain.y, sMain.z + Math.cos(sMain.ang) * off, -sMain.ang);
  stand.receiveShadow = true;

  const coast = atQ(0.15, {});
  const lhOff = t.safeOffset(-34, coast.curv);
  solid(lighthouseGeo(pal),
    coast.x - Math.sin(coast.ang) * lhOff, coast.y, coast.z + Math.cos(coast.ang) * lhOff, 0, true);

  flock(ctx, gullGeo(0xfdfbf4, pal.accent), 14, 14, 16, vc);
}

/** Pines, snow banks, the lodge and the cove's own peak on the skyline. */
function dressSnow(ctx) {
  const { track: t, rng, family, put, solid, side, atQ, anim, group, geos } = ctx;
  const pines = family(pineGeo(), 150);
  const banks = family(snowBankGeo(), 90);
  for (let i = 0; i < t.n; i += 4) {
    for (const s of [-1, 1]) {
      if (rng() < 0.5) {
        const p = side(i, s * (1.85 * t.hw[i] + 3.5 + rng() * 11));
        put(pines, p[0], p[1] - 0.4, p[2], rng() * 6.28, 0.75 + rng() * 0.6);
      }
    }
    if (rng() < 0.35) {
      const s = rng() < 0.5 ? -1 : 1;
      const p = side(i, s * (1.85 * t.hw[i] + 1.6));
      put(banks, p[0], p[1] - 0.25, p[2], t.ang[i], 0.9 + rng() * 0.5);
    }
  }
  pines.castShadow = true;
  pines.instanceMatrix.needsUpdate = true;
  banks.instanceMatrix.needsUpdate = true;

  crowdRows(ctx, [[0.92, 0.05, 22, -1], [0.40, 0.46, 14, 1]], 0xd6c2a0);

  const lodgeAt = atQ(0.78, {});
  const lOff = t.safeOffset(-(lodgeAt.hw * 1.85 + 12), lodgeAt.curv);
  solid(lodgeGeo(),
    lodgeAt.x - Math.sin(lodgeAt.ang) * lOff, lodgeAt.y - 1.2,
    lodgeAt.z + Math.cos(lodgeAt.ang) * lOff, Math.PI / 2 - lodgeAt.ang, true);

  // The cove's peak on the skyline: backdrop only, never lit by the sun's
  // shadow camera and never in the way.
  const far = atQ(0.30, {});
  const peak = solid(peakGeo(), far.x + 140, t.yMin - 24, far.z + 120, 0.6);
  peak.receiveShadow = false;

  // Falling snow: one instanced family recycled in a column that follows the
  // camera, ~450 flakes, nothing allocated per frame (DESIGN.md particle rule).
  const flakeGeo = new THREE.OctahedronGeometry(0.16, 0);
  const flakeMat = makeGlow(0xffffff, { unique: true });
  flakeMat.transparent = true;
  flakeMat.opacity = 0.85;
  flakeMat.depthWrite = false;
  ctx.mats.push(flakeMat);
  const flakes = new THREE.InstancedMesh(flakeGeo, flakeMat, 450);
  flakes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  flakes.frustumCulled = false;
  flakes.count = 450;
  group.add(flakes);
  geos.push(flakeGeo);
  const seeds = [];
  for (let i = 0; i < 450; i++) {
    seeds.push({ x: rng() * 160 - 80, y: rng() * 60, z: rng() * 160 - 80, sp: 2 + rng() * 3, a: rng() * 6.28 });
  }
  const centre = ctx.focus;
  anim.push((dt, time) => {
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      s.y -= s.sp * dt;
      if (s.y < -14) { s.y = 46; s.x = rng() * 160 - 80; s.z = rng() * 160 - 80; }
      _eu.set(time + s.a, s.a, 0);
      _q4.setFromEuler(_eu);
      _v3b.set(centre.x + s.x, centre.y + s.y, centre.z + s.z);
      _sc.set(1, 1, 1);
      _m4.compose(_v3b, _q4, _sc);
      flakes.setMatrixAt(i, _m4);
    }
    flakes.instanceMatrix.needsUpdate = true;
  });
}

/** Ruins, ferns, gold light shafts, parrots and the viaduct's stone piers. */
function dressJungle(ctx) {
  const { track: t, rng, family, put, side, group, geos, mats, vc } = ctx;
  const pillars = family(ruinPillarGeo(), 120);
  const ferns = family(fernGeo(), 200);
  for (let i = 0; i < t.n; i += 3) {
    if (rng() < 0.4) {
      const s = rng() < 0.5 ? -1 : 1;
      const p = side(i, s * (1.85 * t.hw[i] + 3 + rng() * 8));
      put(pillars, p[0], p[1] - 0.5, p[2], rng() * 6.28, 0.8 + rng() * 0.7);
    }
    for (const s of [-1, 1]) {
      if (rng() < 0.55) {
        const p = side(i, s * (1.85 * t.hw[i] + 1.6 + rng() * 5));
        put(ferns, p[0], p[1] - 0.2, p[2], rng() * 6.28, 0.7 + rng() * 0.8);
      }
    }
  }
  pillars.castShadow = true;
  pillars.instanceMatrix.needsUpdate = true;
  ferns.instanceMatrix.needsUpdate = true;

  crowdRows(ctx, [[0.93, 0.06, 20, -1], [0.72, 0.78, 12, 1]], 0x9a7a52);

  // Piers under whatever section runs highest above the ground: on tangle that
  // is the viaduct that carries the road back over the main straight.
  const piers = family(timberFrameGeo(2.2, 6), 40);
  for (let i = 0; i < t.n; i += 5) {
    const drop = t.y[i] - t.yMin;
    if (drop < 5) continue;
    const p = side(i, 0);
    // a pier straddles the deck, so its span runs across the road (pi/2 - ang),
    // and the uniform scale is chosen so the 6-unit frame reaches the ground
    put(piers, p[0], p[1] - drop, p[2], Math.PI / 2 - t.ang[i], clamp(drop / 6, 0.9, 2.4));
  }
  piers.instanceMatrix.needsUpdate = true;

  // Gold light shafts: unlit cones, no depth write, so they read as air and
  // never z-fight with the canopy.
  const shaftMat = makeGlow(0xfff0b0, { unique: true });
  shaftMat.transparent = true;
  shaftMat.opacity = 0.16;
  shaftMat.depthWrite = false;
  shaftMat.side = THREE.DoubleSide;
  mats.push(shaftMat);
  const shaftGeo = new THREE.ConeGeometry(5.5, 34, 7, 1, true);
  geos.push(shaftGeo);
  const shafts = new THREE.InstancedMesh(shaftGeo, shaftMat, 14);
  shafts.frustumCulled = false;
  shafts.count = 0;
  group.add(shafts);
  for (let n = 0; n < 14; n++) {
    const i = Math.floor((n / 14) * t.n);
    const p = side(i, (rng() - 0.5) * 3 * t.hw[i]);
    _eu.set(0.12, rng() * 6.28, 0.1, 'YXZ');
    _q4.setFromEuler(_eu);
    _v3b.set(p[0], p[1] + 17, p[2]);
    _sc.set(1, 1, 1);
    _m4.compose(_v3b, _q4, _sc);
    shafts.setMatrixAt(shafts.count++, _m4);
  }
  shafts.instanceMatrix.needsUpdate = true;

  flock(ctx, parrotGeo(), 12, 18, 20, vc);
}

/** Crystal clusters, lantern strings, timber frames and a rock ceiling. */
function dressMine(ctx) {
  const { track: t, rng, family, put, solid, side, atQ, anim } = ctx;
  const crystalA = family(crystalGeo(0x42d6c8), 90, glowMat(ctx, 0x9ff0e8));
  const crystalB = family(crystalGeo(0x9b6bd4), 70, glowMat(ctx, 0xd0b4f2));
  const rocks = family(stalactiteGeo(), 90);
  for (let i = 0; i < t.n; i += 4) {
    for (const s of [-1, 1]) {
      if (rng() < 0.45) {
        const p = side(i, s * (1.85 * t.hw[i] + 2.4 + rng() * 7));
        put(rng() < 0.6 ? crystalA : crystalB, p[0], p[1] - 0.3, p[2], rng() * 6.28, 0.8 + rng() * 1.1);
      }
    }
    if (rng() < 0.5) {
      const s = rng() < 0.5 ? -1 : 1;
      const p = side(i, s * (1.85 * t.hw[i] + 1 + rng() * 4));
      put(rocks, p[0], p[1] + 16 + rng() * 6, p[2], rng() * 6.28, 0.7 + rng() * 1.0);
    }
  }
  for (const im of [crystalA, crystalB, rocks]) im.instanceMatrix.needsUpdate = true;

  crowdRows(ctx, [[0.94, 0.05, 18, -1], [0.20, 0.26, 12, 1]], 0x8a6642);

  // Lantern strings over the road: warm, close, and the reason this reads as a
  // cozy cave rather than a dungeon.
  const lamps = family(lanternGeo(), 160, glowMat(ctx, 0xffd77a));
  const ropeStep = Math.max(2, Math.round(6 / t.step));
  for (let i = 0; i < t.n; i += ropeStep) {
    const sway = Math.sin(i * 0.9) * 0.35;
    const p = side(i, sway * t.hw[i]);
    put(lamps, p[0], p[1] + 6.2 + Math.sin(i * 0.5) * 0.5, p[2], 0, 1);
  }
  lamps.instanceMatrix.needsUpdate = true;
  anim.push((dt, time) => {
    // a slow warm pulse on the crystal glow; nothing moves, only the tint
    const k = 0.86 + 0.14 * Math.sin(time * 1.3);
    crystalA.material.color.setHex(0x9ff0e8).multiplyScalar(k);
    crystalB.material.color.setHex(0xd0b4f2).multiplyScalar(2 - k);
  });

  // Timber support frames straddling the road at intervals, plus the jump ramp
  // furniture: a lip you can see coming. The geometry is built at the track's
  // OWN average half-width, so the family scales at 1 and a uniform instance
  // scale never stretches a 5.4-unit post into a 40-unit one.
  let hwSum = 0;
  for (let i = 0; i < t.n; i++) hwSum += t.hw[i];
  const frames = family(timberFrameGeo((hwSum / t.n) * 1.5, 5.4), 40);
  for (let i = 0; i < t.n; i += Math.max(4, Math.round(26 / t.step))) {
    const p = side(i, 0);
    put(frames, p[0], p[1], p[2], Math.PI / 2 - t.ang[i], 1);
  }
  frames.instanceMatrix.needsUpdate = true;

  for (const j of t.jumps) {
    const lip = atQ(j.q1, {});
    const ramp = solid(rampGeo(lip.hw * 2.1), lip.x, lip.y, lip.z, Math.PI / 2 - lip.ang);
    ramp.castShadow = true;
  }
}

/** A takeoff lip: a wedge in the launch gold, wide as the road. */
function rampGeo(width) {
  return mergeParts([
    { geo: new THREE.BoxGeometry(width, 0.6, 3.2), y: 0.3, rx: -0.16, color: 0x8a6642 },
    { geo: new THREE.BoxGeometry(width, 0.22, 0.9), y: 0.72, z: 1.3, color: 0xf2b64a },
    { geo: new THREE.BoxGeometry(0.7, 1.1, 0.7), x: -width / 2 + 0.4, y: 0.55, color: 0x6b4f35 },
    { geo: new THREE.BoxGeometry(0.7, 1.1, 0.7), x: width / 2 - 0.4, y: 0.55, color: 0x6b4f35 },
  ]);
}

function glowMat(ctx, color) {
  const m = makeGlow(color, { unique: true });
  ctx.mats.push(m);
  return m;
}

/**
 * Rows of cheering capys behind the barrier. A spectator must FACE the road, so
 * local +z is aimed along -side*N: ry = pi - ang on the +N side, -ang on the -N.
 */
function crowdRows(ctx, spots, color = 0xb08a5a) {
  const { track: t, rng, family, put } = ctx;
  const cap = spots.reduce((n, s) => n + s[2], 0) + 4;
  const crowd = family(crowdGeo(color), cap);
  for (const [qa, qb, n, s] of spots) {
    for (let i = 0; i < n; i++) {
      const q = frac1(qa + (qb - qa) * (i / n));
      const idx = t.indexOfQ(q);
      const row = i % 4;
      const p = ctx.side(idx, s * (t.hw[idx] * 1.85 + 3.6 + row * 1.5), 0.28 + row * 0.55);
      put(crowd, p[0] + rng() - 0.5, p[1], p[2] + rng() - 0.5,
        s > 0 ? Math.PI - t.ang[idx] : -t.ang[idx], 0.9 + rng() * 0.3);
    }
  }
  crowd.instanceMatrix.needsUpdate = true;
  return crowd;
}

/** Ambient birds wheeling over the circuit; `scare()` scatters them upward. */
function flock(ctx, geo, n, yLow, yHigh, mat) {
  const { rng, family, anim, track: t } = ctx;
  const im = family(geo, n, mat);
  im.count = n;
  const seeds = [];
  const cx = t.x[0];
  const cz = t.z[0];
  for (let i = 0; i < n; i++) {
    seeds.push({
      x: cx + rng() * 240 - 120, z: cz + rng() * 220 - 110,
      y: t.yMax + yLow + rng() * yHigh,
      r: 12 + rng() * 26, a: rng() * 6.28, sp: 0.25 + rng() * 0.4,
      flap: rng() * 6.28, base: t.yMax + yLow + rng() * yHigh, scare: 0,
    });
  }
  anim.push((dt) => {
    for (let i = 0; i < seeds.length; i++) {
      const g = seeds[i];
      if (g.scare > 0) { g.scare -= dt; g.y += dt * 7; } else if (g.y > g.base) g.y -= dt * 2.4;
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
  });
  ctx.scareFlock = () => { for (const g of seeds) g.scare = 0.4 + rng() * 0.8; };
  return im;
}

// The one texture helper a track uses: a painted board for the pit-lane sign.
// Kept here (not in kart.js) so a theme can letter its own furniture later.
export function signTexture(text, bg = 0xfff6e2, ink = '#2d2417') {
  return canvasTexture(256, 64, (c, w, h) => {
    c.fillStyle = `#${((bg >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
    c.fillRect(0, 0, w, h);
    c.fillStyle = ink;
    c.font = '900 34px Trebuchet MS, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(text), w / 2, h / 2 + 2);
  });
}
