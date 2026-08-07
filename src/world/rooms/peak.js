import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/* ---------------------------------------------------------------------------
 * Frosty Peak: a snowy mountaintop clearing above a sea of clouds.
 * Snowbank rim, pine ring, ski lodge, chairlift, frozen pond, snow-capybara.
 * Everything procedural: geometry + canvas textures only.
 *
 * This room also owns the Summit Sprint race lobby: three parked sleds behind
 * the start gate, one per lobby slot, a live RIDERS n/3 sign, and the hotspots
 * that join/leave the lobby. Protocol (server <-> src/net/client.js):
 *   out  {t:'lobby-join'} {t:'lobby-leave'}
 *   in   'lobby' {players:[{id,name}], starting}   'race-start' {seed, players}
 * On 'race-start' we stash game.__raceCtx and launch the sled minigame; solo
 * runs launch with game.__raceCtx = null.
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

/**
 * The ski lodge is the Game Den's front door. The lodge body group sits at
 * (LODGE.x, 0, LODGE.z) yawed -PI/2, so local +Z points west into the clearing
 * and local +X points south: world = (LODGE.x - lz, LODGE.z + lx).
 *
 * The entrance is on the SOUTH gable end. The follow camera looks north from
 * +Z (offset (0, 11.5, 20)), so the west face the doorway used to occupy is
 * exactly edge-on from every spawn: it read as a sliver and nobody could find
 * the way in. The gable end is the one wall of this building that is square to
 * the play camera, from the clearing, the trail and the forecourt alike.
 *
 * Entrance geometry therefore lives in its own group (see _denPorch), parked at
 * the lodge centre with NO yaw: inside it +X is east and +Z is south, so +Z
 * points straight out of the doorway and straight down the camera's barrel.
 * The gable wall is 6 wide (world x 7.6 .. 13.6) and its outer face is at
 * porch-frame z = WALL_Z (world z 5.0).
 */
const LODGE = { x: 10.6, z: 1.0 };
const FLOOR_Y = 0.5;    // lodge plinth top: the doorway sill
const DOOR_HW = 1.15;   // doorway half width, porch-frame x
const DOOR_HEAD = 2.96; // top of the opening, just under the gable
const WALL_Z = 4.0;     // gable wall outer face, porch-frame z (world z 5.0)
const WALL_T = 0.4;     // face-plate thickness: the depth of the doorway reveal
const DOOR_Z = WALL_Z + 0.04; // jamb plane, a hair proud of the wall
// The walk-in exit, out on the steps. Its auto-fire ring (radius * 0.8 = 1.76)
// reaches world z 7.51, so you trigger it 0.75 short of the bottom tread: the
// prompt and the hand-off both happen on open, shovelled snow.
const DEN_DOOR = { x: LODGE.x, z: LODGE.z + 4.75 }; // (10.60, 5.75)
const DEN_RADIUS = 2.2;
// Barrel table, standing ON the west veranda deck (top = FLOOR_Y). It used to
// sit out on the snow south-west of the lodge, which is exactly the corridor
// walkers now use to get between the den door and the gate: its collider and
// the lodge's pinched together into a notch that jammed them. On the deck it
// needs no collider of its own at all.
const COCOA = { x: 6.6, z: 2.6 };

/**
 * The Glimmer Mine's front door, cut into the mountainside on the WEST flank of
 * the clearing. Its group sits at (MINE.x, terrain, MINE.z) yawed MINE_YAW, so
 * local +Z is the way OUT of the adit: the mouth faces south-east, 35 degrees
 * off the play camera's axis, which is close enough to square that the opening,
 * its lit throat and the board above it all read from the clearing (the ski
 * lodge learned this the hard way with a west-facing door).
 *
 * The pocket it lives in is tight: the frozen pond's collider (r 3.85) is to
 * the north, the snow capybara (r 1.35) to the east and the chairlift's west
 * tower (r 1.05) to the south-west. The bluff therefore carries ONE collider,
 * a single circle behind the door face - convex, so the walk controller's
 * slide can never wedge in a notch - and it clears all three:
 *   pond 6.58 (needs 6.25) · snow capy 5.26 (3.75) · lift tower 4.29 (3.45)
 * The exit's fire ring (radius * 0.8 = 1.76 around the threshold) reaches to
 * 2.54 of the rock, so you always hand over before you touch the mountain.
 */
const MINE = { x: -9.0, z: 6.6 };
const MINE_YAW = 0.62;
const MINE_DOOR = { x: -8.01, z: 7.98 };  // local (0, 1.7): the threshold
const MINE_RADIUS = 2.2;

const GATE_Z = -9; // the start gate group sits here; the chute runs to -Z

/**
 * The three race lobby seats, in protocol order: lobby.players[i] rides slot i.
 * They sit on the start line under the gate, on the flat apron (terrainH is 0
 * inside r=3.4 of the gate) and inside the join hotspot's radius so the "Hop
 * out" prompt stays reachable while seated. They carry NO obstacle circles: a
 * collider here would shove the local player straight back out of their seat.
 */
const RACE_SLOTS = [
  { x: -1.75, z: -9.3 },
  { x: 0, z: -9.3 },
  { x: 1.75, z: -9.3 },
];
const SLOT_YAW = Math.PI; // sled + rider face -Z, down the chute
const SLED_SCALE = 1.4; // rack sleds are props; a race sled has to fit a capybara
const SLED_DZ = -0.35; // sled sits a nose ahead of the seat, backrest at the rider's back
// Deck top is 0.25 * SLED_SCALE. Sitting this high tucks the narrow bottom of
// the capybara inside the bed while its wide middle clears the sides, so nothing
// clips through the sled walls.
const SEAT_LIFT = 0.38;
const SLOT_COLORS = [0xe8657a, 0x4fb3e8, 0xf2b64a];
const DEFAULT_FUR = 0xb08a5a; // lobby payload is id+name only; brown until we know better

/* --- the social cove (wave 7): clock, aurora, snowballs -------------------
 * docs/LIVING-COVE.md sections A (world clock) and A2 (ambient play toys).
 * Everything below is dormant until the first onClock frame arrives: a room
 * built against a server with no clock looks exactly as it shipped.
 * ------------------------------------------------------------------------- */

const DAY_SECONDS = 40 * 60;           // one cove day, matching the server clock
const SUN_R = Math.hypot(22, 27);      // keep the shipped noon sun's distance...
const NOON_AZ = Math.atan2(-27, -22);  // ...and its shipped noon bearing, so
                                       // dayT 0.25 reproduces the authored look
const SNOW_N = 900;                    // snowfall particle pool (drawRange scales it)

// Day palette. Everything is lerped into preallocated colours in _relight, so
// the clock costs zero allocations per frame (LIVING-COVE "budgets and safety").
const P = {
  bgDay: new THREE.Color(0xc3dcf1), bgNight: new THREE.Color(0x151d33),
  bgDawn: new THREE.Color(0xefbcb2), bgDusk: new THREE.Color(0xe9a276),
  fogDay: new THREE.Color(0xd9e9f7), fogNight: new THREE.Color(0x1c2540),
  fogDawn: new THREE.Color(0xf2c9c2), fogDusk: new THREE.Color(0xefb68c),
  skyDay: new THREE.Color(0xffffff), skyNight: new THREE.Color(0x2c3c66),
  skyDawn: new THREE.Color(0xffcac1), skyDusk: new THREE.Color(0xffb584),
  sunDay: new THREE.Color(0xffe6bd), sunWarm: new THREE.Color(0xffa864),
  moon: new THREE.Color(0xaec6ff),
  hemiSkyDay: new THREE.Color(0xdcefff), hemiSkyNight: new THREE.Color(0x44578a),
  hemiGndDay: new THREE.Color(0x93aec9), hemiGndNight: new THREE.Color(0x2f3d5c),
  ambDay: new THREE.Color(0xa9c9e8), ambNight: new THREE.Color(0x6b86bd),
  discDay: new THREE.Color(0xfff6dc), discNight: new THREE.Color(0xe6eeff),
};
const _lc = new THREE.Color();  // scratch colour + vector for _relight
const _lv = new THREE.Vector3();

// Aurora ribbons: three bands hung across the north sky, additive, vertex-waved.
const AUR_COLS = 40;   // columns per band (vertices are COLS+1 wide)
const AUR_ROWS = 4;    // rows per band (ROWS+1 tall); row 0 and ROWS fade to black
const AUR_BANDS = 3;

// Snowball toy, on the RIGHT mouse button. It used to share the left button
// with walking, which playtested badly: every attempt to cross the clearing
// wound up a throw instead. Left click is now pure walking, exactly as in every
// other room. (A right button is a mouse thing: there is no snowball on touch
// any more, which is the price of never stealing the walk tap again.)
// The server allows one throw a second; the local cooldown sits a beat outside
// that so a throw is never eaten by the rate limiter.
const SNOW_HOLD_CAP = 1.0;    // seconds of hold = full power
const SNOW_RANGE_MIN = 3.5;   // a quick right-click lobs this far; hold for more
const SNOW_RANGE_MAX = 13.0;
const SNOW_COOLDOWN = 1.15;
const SNOW_HIT_R = 0.8;       // LIVING-COVE: a capy within 0.8 of the landing
const SNOW_MAX_BALLS = 10;
const SNOW_PUFFS = 44;        // landing puff particle pool
const AIM_BEADS = 16;
const BOOP_DUR = 0.9;
const CAP_LIFE = 4.2;         // seconds of snowcap before it melts off
const _ndc = new THREE.Vector2();
const _aimV = new THREE.Vector3();

// Shown once per session, the first time someone stands around in the snow:
// nobody discovers a right-click hold-to-aim toy on their own (module scope so
// a second visit to the peak does not nag).
let _hintShown = false;

/** Flight time and apex of a thrown snowball. Every client runs these on the
 *  same endpoints, so everybody watches the same arc. */
function flightTime(dist) { return Math.min(1.5, 0.5 + dist * 0.055); }
function arcHeight(dist) { return 1.1 + dist * 0.26; }
function arcPoint(b, u, out) {
  out.x = b.ox + (b.tx - b.ox) * u;
  out.z = b.oz + (b.tz - b.oz) * u;
  out.y = b.oy + (b.ty - b.oy) * u + b.h * 4 * u * (1 - u);
  return out;
}
// the preview arc reuses one throw record rather than allocating per frame
const _pv = { ox: 0, oy: 0, oz: 0, tx: 0, ty: 0, tz: 0, h: 0 };

/**
 * Peak weather is snowfall intensity 0..2 (LIVING-COVE section A). Numbers pass
 * through; a word from the outdoor-family vocabulary, or a {snow:n} envelope,
 * is understood too, so one server dialect can serve every room. Anything
 * unrecognised means "the usual snow".
 */
const SNOW_WORDS = { clear: 0.25, calm: 0.4, breeze: 0.9, snow: 1.3, rain: 1.3, storm: 2, blizzard: 2 };
function snowIntensity(w) {
  if (typeof w === 'number') return Number.isFinite(w) ? Math.max(0, Math.min(2, w)) : 1;
  if (typeof w === 'string') {
    const n = Number(w);
    if (w.trim() !== '' && Number.isFinite(n)) return Math.max(0, Math.min(2, n));
    return Object.prototype.hasOwnProperty.call(SNOW_WORDS, w) ? SNOW_WORDS[w] : 1;
  }
  if (w && typeof w === 'object') {
    const n = Number(w.snow ?? w.peak ?? w.intensity);
    if (Number.isFinite(n)) return Math.max(0, Math.min(2, n));
  }
  return 1;
}

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
  // Forecourt in front of the den door, stretched south into a sightline
  // saddle (the z distance counts 0.62, so the flat pad blends out over ~11
  // units south but only 7 sideways). Two jobs: the approach to a south-facing
  // entrance would otherwise climb the shoulder of the snowbank rim, and the
  // follow camera looks back THROUGH that rim. Its sightline climbs 0.575 per
  // unit (11.5 up, 20 back) and the untouched crest outruns it, so a capybara
  // standing at the door vanished behind snow - verified at (10.6, 8.6), then
  // re-verified visible with this saddle in.
  mask = Math.min(mask, ringMask(x, 6.2 + (z - 6.2) * 0.62, 10.6, 6.2, 3.2, 7.2));
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

/** Soft warm puddle, used for the light lying on the snow along the den path. */
function glowPoolTexture() {
  return canvasTexture(128, 128, (c, w, h) => {
    const rg = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2 - 1);
    rg.addColorStop(0, 'rgba(255,214,150,0.95)');
    rg.addColorStop(0.45, 'rgba(255,196,120,0.36)');
    rg.addColorStop(1, 'rgba(255,190,110,0)');
    c.fillStyle = rg;
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

/**
 * The trailhead board, hung on the gallows where the clearing meets the
 * shovelled path. Its faces point along world +/-Z, straight down the barrel of
 * the follow camera (offset (0, 11.5, 20)), so it is never seen edge-on. Big
 * ink on cream, one glyph, one subtitle: legible at a 960px capture.
 */
function denSignTexture() {
  return canvasTexture(512, 256, (c, w, h) => {
    c.fillStyle = '#fff6e3';
    c.beginPath();
    c.roundRect(6, 6, w - 12, h - 12, 26);
    c.fill();
    c.fillStyle = '#e8657a';
    c.beginPath();
    c.roundRect(6, 6, w - 12, 62, [26, 26, 0, 0]);
    c.fill();
    c.strokeStyle = '#5f3f28';
    c.lineWidth = 9;
    c.beginPath();
    c.roundRect(6, 6, w - 12, h - 12, 26);
    c.stroke();

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fffaf0';
    c.font = '800 34px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('INSIDE THE LODGE', w / 2, 38);

    c.fillStyle = 'rgba(90,60,35,0.28)';
    c.font = '900 92px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('GAME DEN', w / 2 + 5, 133);
    c.fillStyle = '#2d2417';
    c.fillText('GAME DEN', w / 2, 128);

    // a die and a pawn either side of the subtitle
    c.fillStyle = '#f2b64a';
    c.beginPath();
    c.roundRect(46, 168, 54, 54, 12);
    c.fill();
    c.fillStyle = '#2d2417';
    for (const [dx, dy] of [[16, 16], [38, 16], [16, 38], [38, 38], [27, 27]]) {
      c.beginPath();
      c.arc(46 + dx, 168 + dy, 5.5, 0, TAU);
      c.fill();
    }
    c.fillStyle = '#4fb3e8';
    c.beginPath();
    c.arc(w - 73, 184, 15, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(w - 95, 222);
    c.lineTo(w - 51, 222);
    c.lineTo(w - 62, 196);
    c.lineTo(w - 84, 196);
    c.closePath();
    c.fill();

    c.fillStyle = '#8a6242';
    c.font = '700 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('pong · chess · cards', w / 2, 196);
  });
}

/**
 * The board bolted to the gable straight above the doorway: the close-range
 * confirmation that this lit hole is the Game Den. Wide and short because it
 * has to live between the door hood and the roof, so it is one line of ink with
 * a die and a pawn for company, sized to still read at a 960px capture.
 */
function denShingleTexture() {
  return canvasTexture(512, 184, (c, w, h) => {
    c.fillStyle = '#fff6e3';
    c.beginPath();
    c.roundRect(5, 5, w - 10, h - 10, 22);
    c.fill();
    c.strokeStyle = '#5f3f28';
    c.lineWidth = 10;
    c.beginPath();
    c.roundRect(5, 5, w - 10, h - 10, 22);
    c.stroke();

    // a die on the left, a pawn on the right, both well clear of the word
    c.fillStyle = '#f2b64a';
    c.beginPath();
    c.roundRect(28, 62, 58, 58, 13);
    c.fill();
    c.fillStyle = '#2d2417';
    for (const [dx, dy] of [[16, 16], [42, 16], [16, 42], [42, 42], [29, 29]]) {
      c.beginPath();
      c.arc(28 + dx, 62 + dy, 6, 0, TAU);
      c.fill();
    }
    c.fillStyle = '#4fb3e8';
    c.beginPath();
    c.arc(w - 57, 74, 16, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(w - 80, 122);
    c.lineTo(w - 34, 122);
    c.lineTo(w - 46, 94);
    c.lineTo(w - 68, 94);
    c.closePath();
    c.fill();

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(90,60,35,0.26)';
    c.font = '900 86px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('GAME DEN', w / 2 + 5, h / 2 + 5);
    c.fillStyle = '#2d2417';
    c.fillText('GAME DEN', w / 2, h / 2);
  });
}

/** The lit slice of den you see through the open double doors. */
function denDoorwayTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#ffd08a');
    g.addColorStop(0.55, '#f7b463');
    g.addColorStop(1, '#c9793c');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // a hint of table and lamp inside, kept blobby so it reads as depth not detail
    c.fillStyle = 'rgba(120,66,30,0.45)';
    c.fillRect(0, 176, w, 80);
    c.fillStyle = 'rgba(90,48,22,0.5)';
    c.beginPath();
    c.roundRect(46, 140, 164, 22, 10);
    c.fill();
    c.fillRect(70, 158, 16, 40);
    c.fillRect(170, 158, 16, 40);
    c.fillStyle = 'rgba(255,246,224,0.75)';
    c.beginPath();
    c.arc(w / 2, 62, 26, 0, TAU);
    c.fill();
    c.fillStyle = 'rgba(255,246,224,0.28)';
    c.beginPath();
    c.moveTo(w / 2 - 62, 150);
    c.lineTo(w / 2 + 62, 150);
    c.lineTo(w / 2 + 30, 62);
    c.lineTo(w / 2 - 30, 62);
    c.closePath();
    c.fill();
  });
}

/**
 * The board bolted to the rock over the mineshaft door. Same job as the den's
 * gable shingle: the close-range confirmation that this lit hole in the
 * mountain is a place, not scenery. Big ink on cream, one glyph, one subtitle.
 */
function mineSignTexture() {
  return canvasTexture(512, 232, (c, w, h) => {
    c.fillStyle = '#fff6e3';
    c.beginPath();
    c.roundRect(5, 5, w - 10, h - 10, 22);
    c.fill();
    c.fillStyle = '#f2b64a';
    c.beginPath();
    c.roundRect(5, 5, w - 10, 54, [22, 22, 0, 0]);
    c.fill();
    c.strokeStyle = '#5f3f28';
    c.lineWidth = 10;
    c.beginPath();
    c.roundRect(5, 5, w - 10, h - 10, 22);
    c.stroke();

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#3a2a18';
    c.font = '800 32px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('INTO THE MOUNTAIN', w / 2, 31);

    c.fillStyle = 'rgba(90,60,35,0.26)';
    c.font = '900 78px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('GLIMMER MINE', w / 2 + 5, 117);
    c.fillStyle = '#2d2417';
    c.fillText('GLIMMER MINE', w / 2, 112);

    // a crossed pick and shovel either side of the strapline
    c.strokeStyle = '#8a6242';
    c.lineWidth = 9;
    c.lineCap = 'round';
    for (const cx of [62, w - 62]) {
      c.beginPath();
      c.moveTo(cx - 26, 186);
      c.lineTo(cx + 26, 146);
      c.moveTo(cx - 26, 146);
      c.lineTo(cx + 26, 186);
      c.stroke();
    }
    c.lineCap = 'butt';
    c.fillStyle = '#8a6242';
    c.font = '700 29px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('coins in the walls · warm lanterns', w / 2, 172);
  });
}

/** The lit throat you see through the mineshaft frame: rails, lamps, a glint. */
function mineThroatTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3a2415');
    g.addColorStop(0.42, '#6d431f');
    g.addColorStop(0.75, '#c07a34');
    g.addColorStop(1, '#e8a659');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    // two receding timber frames, painted so the throat has depth
    c.strokeStyle = 'rgba(58,36,20,0.85)';
    for (const [inset, lw] of [[34, 16], [70, 11]]) {
      c.lineWidth = lw;
      c.strokeRect(inset, inset * 0.8, w - inset * 2, h - inset * 1.1);
    }
    // rails running away into the dark
    c.strokeStyle = 'rgba(255,214,150,0.5)';
    c.lineWidth = 7;
    c.beginPath();
    c.moveTo(70, h);
    c.lineTo(112, 128);
    c.moveTo(w - 70, h);
    c.lineTo(w - 112, 128);
    c.stroke();
    // a hanging lantern and one amber glint in the wall
    c.fillStyle = 'rgba(255,222,160,0.92)';
    c.beginPath();
    c.arc(w / 2, 74, 15, 0, TAU);
    c.fill();
    c.fillStyle = 'rgba(255,238,200,0.35)';
    c.beginPath();
    c.moveTo(w / 2 - 44, 168);
    c.lineTo(w / 2 + 44, 168);
    c.lineTo(w / 2 + 20, 74);
    c.lineTo(w / 2 - 20, 74);
    c.closePath();
    c.fill();
    c.fillStyle = '#7ce0d4';
    c.beginPath();
    c.moveTo(190, 150);
    c.lineTo(202, 128);
    c.lineTo(210, 152);
    c.closePath();
    c.fill();
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

/**
 * The live lobby board above the start gate. Redrawn into the SAME canvas every
 * time the roster changes (see _paintRiders), so the room only ever owns one
 * texture no matter how many capybaras hop in and out.
 */
function drawRidersSign(c, w, h, n, starting) {
  c.clearRect(0, 0, w, h);
  // cream card with a coral header band
  c.fillStyle = '#fff6e3';
  c.beginPath();
  c.roundRect(6, 6, w - 12, h - 12, 26);
  c.fill();
  c.fillStyle = starting ? '#7ac74f' : '#e8657a';
  c.beginPath();
  c.roundRect(6, 6, w - 12, 52, [26, 26, 0, 0]);
  c.fill();
  c.strokeStyle = '#ffffff';
  c.lineWidth = 7;
  c.beginPath();
  c.roundRect(6, 6, w - 12, h - 12, 26);
  c.stroke();

  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#fffaf0';
  c.font = '800 30px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(starting ? 'LAUNCHING!' : 'RIDERS', w / 2, 33);

  // big count
  c.fillStyle = '#2d2417';
  c.font = '900 52px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(`${n}/3`, w / 2 - 74, 92);

  // three seat pips, filled left to right
  for (let i = 0; i < 3; i++) {
    const cx = w / 2 + 6 + i * 52;
    c.beginPath();
    c.arc(cx, 92, 20, 0, TAU);
    c.fillStyle = i < n ? (starting ? '#7ac74f' : '#f2b64a') : '#e6dcc4';
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = '#2d2417';
    c.stroke();
    if (i < n) {
      // a little seated capy blob so the pip reads as an occupied sled
      c.fillStyle = '#6b4f35';
      c.beginPath();
      c.arc(cx, 96, 9, 0, TAU);
      c.fill();
      c.beginPath();
      c.arc(cx, 84, 6, 0, TAU);
      c.fill();
    }
  }
}

function ridersSignTexture() {
  return canvasTexture(512, 128, (c, w, h) => drawRidersSign(c, w, h, 0, false));
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

/**
 * One chairlift bench, hung from the cable at the geometry origin (y = 0).
 *
 * Read top-to-bottom it must say "bench": grip on the cable -> vertical hanger
 * bar -> snow-capped shoulder rail -> backrest panel standing UP behind the
 * seat -> horizontal seat -> armrests, lap bar and a footrest out front.
 * Local +Z is the direction of travel (the instance is yawed to the cable
 * heading), so the rider faces forward and the backrest is behind them at -Z;
 * the two cables run opposite ways so their chairs end up back-to-back.
 * The old version hung its backrest BELOW the seat, which is what made the
 * whole lift read upside down from the play camera.
 */
function makeChairGeo() {
  const p = [];
  const BACK_Z = -0.28; // hanger + backrest plane, behind the seat
  const RAIL_Y = -1.02; // shoulder rail: the top of the backrest
  const SEAT_Y = -1.91; // seat cushion centre
  const ARM_Y = -1.42;

  // cable grip, clamp and the hanger bar dropping straight down
  part(p, new THREE.SphereGeometry(0.13, 8, 6), C.steelDark, { y: -0.03 });
  part(p, new THREE.BoxGeometry(0.26, 0.16, 0.4), C.steel, { y: -0.18, z: BACK_Z * 0.5 });
  part(p, new THREE.CylinderGeometry(0.055, 0.06, 0.96, 6), C.steel, { y: -0.54, z: BACK_Z });

  // shoulder rail with a crust of snow on top: the strongest "this way up" cue
  part(p, new THREE.BoxGeometry(1.34, 0.12, 0.2), C.steel, { y: RAIL_Y, z: BACK_Z });
  part(p, new THREE.BoxGeometry(1.32, 0.07, 0.23), C.snowLit, { y: RAIL_Y + 0.09, z: BACK_Z });

  // backrest panel: a chunky slab standing up off the back edge of the seat
  part(p, new THREE.BoxGeometry(1.22, 0.82, 0.14), C.coralDark, { y: RAIL_Y - 0.44, z: BACK_Z });

  // seat: cushion on a steel frame, extending forward into +Z
  part(p, new THREE.BoxGeometry(1.22, 0.15, 0.7), C.coral, { y: SEAT_Y, z: 0.04 });
  part(p, new THREE.BoxGeometry(1.28, 0.09, 0.76), C.steel, { y: SEAT_Y - 0.11, z: 0.04 });

  // armrests down each side + the lap bar closing them off at the front
  for (const s of [-1, 1]) {
    part(p, new THREE.BoxGeometry(0.09, 0.09, 0.82), C.steel, { x: s * 0.63, y: ARM_Y, z: 0.03 });
    part(p, new THREE.BoxGeometry(0.08, 0.42, 0.08), C.steel, { x: s * 0.63, y: -1.63, z: 0.4 });
    link(p, [s * 0.46, SEAT_Y - 0.15, 0.34], [s * 0.46, -2.26, 0.52], 0.032, C.steelDark);
  }
  part(p, new THREE.BoxGeometry(1.34, 0.085, 0.085), C.steel, { y: ARM_Y, z: 0.42 });

  // footrest bar, tilted slightly so boots sit on it
  part(p, new THREE.BoxGeometry(1.08, 0.08, 0.28), C.steelDark, { rx: 0.18, y: -2.28, z: 0.54 });
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
    this._game = game;

    // race lobby state (see the header note for the wire protocol)
    this._riders = new Map(); // playerId -> { avatar, slot, tag, hidden }
    this._lobbyCount = 0;
    this._lobbyStarting = false;
    this._localSlot = null;
    this._offLobby = null;
    this._offRaceStart = null;
    this._offSnow = null;
    this._wasOnline = !!game?.net?.connected;
    this._reconcileT = 0;

    // ---- world clock state (dormant until the first onClock frame) ---------
    this._hasClock = false;
    this._litOnce = false;   // first relight lands on the phase, then it eases
    this._dayT = 0.25;       // noon: the light the room was authored under
    this._dayness = 1;       // 1 full day .. 0 deep night
    this._nightK = 0;
    this._auroraOn = false;
    this._auroraK = 0;       // eased 0..1 curtain opacity
    this._snowWant = 1;      // weather intensity 0..2 the server last asked for
    this._snowNow = 2;       // ...eased; 2 is the full pool the room ships with
    this._snowShown = SNOW_N;
    this._snowSpeedK = 1;
    // Lamp channels ease onto their night level with different lags, so the
    // lodge, the den lanterns, the gallows and the mine do not all come up as
    // one switch (LIVING-COVE asks for a per-lamp stagger).
    this._lampK = [1, 1, 1, 1];
    this._lampLag = [0.9, 1.6, 0.5, 1.2];

    // ---- snowball toy state ------------------------------------------------
    this._ray = new THREE.Raycaster();
    this._aim = null;        // { t, x, z, cx, cz } while a throw is charging
    this._cool = 0;          // seconds left of the 1/s rate limit
    this._hintT = _hintShown ? -1 : 0;

    scene.background = new THREE.Color(0xc3dcf1);
    scene.fog = new THREE.Fog(0xd9e9f7, 26, 82);
    this._bgColor = scene.background; // mutated in place by the clock
    this._fog = scene.fog;

    this._lights(scene);
    this._sky(scene);
    this._ground(scene);
    this._clouds(scene);
    this._distantPeaks(scene);
    this._trees(scene);
    this._rocks(scene);
    this._lodge(scene);
    this._denPorch(scene);
    this._denApproach(scene);
    this._cocoaStand(scene);
    this._chairlift(scene);
    this._pond(scene);
    this._snowCapybara(scene);
    this._mineAdit(scene);
    this._sledRack(scene);
    this._startGate(scene);
    this._raceLobby(scene);
    this._trailSign(scene);
    this._trailFence(scene);
    this._snowfall(scene);
    this._sparkle(scene);
    this._aurora(scene);
    this._snowToy(scene);

    // arrival spots sit a step BEYOND the exit hotspot's radius, so walking in
    // from the plaza does not immediately pop the "go back" prompt over you
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4),
      from_plaza: new THREE.Vector3(0, 0, 8.5), // exit-plaza is (0,12) r=3
      // Out of the den and a step off the shovelled forecourt, south-west of
      // the doorway with the lit gable behind you and the clearing ahead.
      // exit-lounge is (10.60, 5.75) r=2.20, and engine._updateHotspots only
      // arms a walk-through exit once the player has been more than
      // radius + 0.75 (2.95) away from it: this spot is 3.09 out, so the exit
      // arms on the first frame instead of bouncing the arrival back inside.
      // It also stays north of z 8: past that the south snowbank crest rises
      // into the camera's sightline and clips the capybara's feet.
      from_lounge: new THREE.Vector3(8.2, 0, 7.7),
      // Out of the mine and a step down its shovelled path, with the lit adit
      // behind you and the clearing ahead. 3.40 from 'exit-mine' (arming needs
      // > 2.95, re-entry fires at 1.76), 7.70 clear of the bluff's collider and
      // 3.32 clear of the snow capybara, so nothing is in reach on arrival.
      from_mine: new THREE.Vector3(-6.14, 0, 10.82),
    };

    // The gate offers the multiplayer lobby; the sled rack a few steps east is
    // the "just let me ride" door. Two props, two prompts: they never overlap
    // on screen the way two prompts on one spot would.
    this._joinSpot = {
      id: 'race-join',
      position: new THREE.Vector3(0, 0, -7.6),
      radius: 3.0,
      label: this._joinLabel(),
      action: (g) => {
        if (g.net?.connected) {
          g.net.send({ t: this._localSlot === null ? 'lobby-join' : 'lobby-leave' });
        } else {
          // offline: no lobby to join, so the gate just starts a solo run
          g.__raceCtx = null;
          g.startMinigame('sled');
        }
      },
    };
    this.hotspots.push(
      this._joinSpot,
      {
        // twin prompt AT the gate: playtest showed nobody discovers the rack,
        // so solo riding must be offered where everyone already walks
        id: 'play-sled-gate',
        position: new THREE.Vector3(-2.9, 0, -6.6),
        radius: 2.8,
        label: 'Sled alone',
        action: (g) => {
          g.__raceCtx = null;
          g.startMinigame('sled');
        },
      },
      {
        id: 'play-sled',
        position: new THREE.Vector3(4.6, 0, -4.6),
        radius: 2.6,
        label: 'Sled alone',
        action: (g) => {
          g.__raceCtx = null;
          g.startMinigame('sled');
        },
      },
      {
        // The lodge is the Game Den now: walk up the steps and you are in.
        id: 'exit-lounge',
        position: new THREE.Vector3(DEN_DOOR.x, 0, DEN_DOOR.z),
        radius: DEN_RADIUS,
        label: 'Step into the Game Den',
        action: (g) => g.goToRoom('lounge', 'peak'),
      },
      {
        // the mountain is hollow: a timbered adit on the west of the clearing
        id: 'exit-mine',
        position: new THREE.Vector3(MINE_DOOR.x, 0, MINE_DOOR.z),
        radius: MINE_RADIUS,
        label: 'Duck into the Glimmer Mine',
        action: (g) => g.goToRoom('mine', 'peak'),
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
    // static camera: the sled gate up top, the lodge door east, the frozen pond west
    this.staticCamera = { position: new THREE.Vector3(0, 24, 31), lookAt: new THREE.Vector3(0, 1.5, -2) };

    // Live only while this room is: every handle is dropped in dispose().
    if (game?.events?.on) {
      this._offLobby = game.events.on('lobby', (m) => this._onLobby(m));
      this._offRaceStart = game.events.on('race-start', (m) => this._onRaceStart(m));
      this._offSnow = game.events.on('snow', (m) => this._onSnowFrame(m));
    }

    /*
     * Aiming lives on the RIGHT button, so it can never collide with walking:
     * engine._onPointer bails on any button but 0, which means a right press is
     * not a walk target and we have nothing to swallow. Left clicks, clicks on
     * other capybaras (profile cards), hotspot prompt buttons and every HUD
     * element are therefore untouched by this room.
     *
     * The listeners sit on window in the CAPTURE phase so a drag that wanders
     * off the canvas (or over a HUD panel) still tracks and still lands.
     *
     * The one thing that has to go is the browser context menu: it pops on the
     * very press-and-release that throws the ball. _contextMenu kills it over
     * the world canvas (and while a throw is charging) and nowhere else, and
     * the listener leaves with the room in dispose(), so right-click is back to
     * normal the moment you walk out of the peak.
     */
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
    this._onCancel = () => this._cancelAim();
    this._onContext = (e) => this._contextMenu(e);
    addEventListener('pointerdown', this._onDown, true);
    addEventListener('pointermove', this._onMove, true);
    addEventListener('pointerup', this._onUp, true);
    addEventListener('pointercancel', this._onCancel, true);
    addEventListener('blur', this._onCancel);
    addEventListener('contextmenu', this._onContext, true);
  }

  /* --- race lobby --------------------------------------------------------- */

  _joinLabel() {
    if (!this._game?.net?.connected) return 'Sled down the chute';
    if (this._localSlot !== null) return 'Hop out';
    return `Join the race (${this._lobbyCount}/3)`;
  }

  /** Three parked sleds in their launch grooves, plus the floating tally sign. */
  _raceLobby(scene) {
    // packed-snow launch grooves so an empty slot still reads as "your lane".
    // Kept clear of the gate's start-line stripes at z = GATE_Z + 0.45.
    const pads = [];
    for (const s of RACE_SLOTS) {
      part(pads, new THREE.BoxGeometry(1.36, 0.08, 1.6), C.packed, { x: s.x, y: 0, z: s.z - 0.45 });
      for (const sx of [-1, 1]) {
        part(pads, new THREE.BoxGeometry(0.12, 0.16, 1.6), C.snowLit, { x: s.x + sx * 0.68, y: 0.04, z: s.z - 0.45 });
      }
    }
    scene.add(solidMesh(pads, { shadow: false }));

    const sleds = new THREE.InstancedMesh(makeSledGeo(), makeToon(0xffffff, VC), RACE_SLOTS.length);
    sleds.castShadow = true;
    sleds.receiveShadow = true;
    const d = this._dummy;
    const col = new THREE.Color();
    for (let i = 0; i < RACE_SLOTS.length; i++) {
      const s = RACE_SLOTS[i];
      d.position.set(s.x, 0, s.z + SLED_DZ);
      d.rotation.set(0, SLOT_YAW, 0);
      d.scale.setScalar(SLED_SCALE);
      d.updateMatrix();
      sleds.setMatrixAt(i, d.matrix);
      sleds.setColorAt(i, col.set(SLOT_COLORS[i]));
    }
    sleds.instanceMatrix.needsUpdate = true;
    if (sleds.instanceColor) sleds.instanceColor.needsUpdate = true;
    sleds.computeBoundingSphere();
    scene.add(sleds);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);

    // riders get their own group so dispose() can empty it without hunting
    this._riderGroup = new THREE.Group();
    scene.add(this._riderGroup);

    // floating RIDERS n/3 board, hanging over the gate facing the play camera
    const sign = new THREE.Group();
    sign.position.set(0, 5.3, GATE_Z - 0.02);
    scene.add(sign);
    const backing = [];
    part(backing, new THREE.BoxGeometry(3.16, 0.94, 0.14), C.coralDark, {});
    part(backing, new THREE.SphereGeometry(0.14, 8, 6), C.gold, { x: -1.5, z: 0.02 });
    part(backing, new THREE.SphereGeometry(0.14, 8, 6), C.gold, { x: 1.5, z: 0.02 });
    sign.add(solidMesh(backing, { shadow: false }));
    this._ridersTex = ridersSignTexture();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 0.78), texMat(this._ridersTex));
    face.position.z = 0.09;
    sign.add(face);
    this._ridersSign = sign;
    this._signBaseY = 5.3;
  }

  /** Repaint the tally board in place (one canvas, one texture, forever). */
  _paintRiders() {
    const tex = this._ridersTex;
    const cv = tex?.image;
    if (!cv?.getContext) return;
    drawRidersSign(cv.getContext('2d'), cv.width, cv.height, this._lobbyCount, this._lobbyStarting);
    tex.needsUpdate = true;
  }

  /** Server->client 'lobby': {players:[{id,name}], starting}. */
  _onLobby(m) {
    const game = this._game;
    const players = Array.isArray(m?.players) ? m.players.slice(0, RACE_SLOTS.length) : [];
    const selfId = game?.net?.selfId ?? null;
    const seen = new Set();
    let localSlot = null;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.id === undefined || p.id === null) continue;
      if (selfId !== null && p.id === selfId) { localSlot = i; continue; }
      seen.add(p.id);
      this._addRider(p.id, p.name, i);
    }
    for (const id of [...this._riders.keys()]) if (!seen.has(id)) this._removeRider(id);

    this._lobbyCount = players.length;
    this._lobbyStarting = !!m?.starting;
    this._setLocalSlot(localSlot);
    this._paintRiders();
    this._refreshJoinLabel();
  }

  /** Seat a remote lobby member in their sled. */
  _addRider(id, name, slot) {
    const existing = this._riders.get(id);
    if (existing) {
      if (existing.slot === slot) return;
      this._removeRider(id);
    }
    const s = RACE_SLOTS[slot];
    if (!s || !this._riderGroup) return;
    const game = this._game;
    const remote = game?.net?.remotes?.get?.(id) || null;
    const avatar = createAvatar({
      color: remote?.p?.color ?? DEFAULT_FUR,
      hat: remote?.p?.hat ?? 'none',
    });
    avatar.setAnim('sit');
    avatar.group.position.set(s.x, SEAT_LIFT, s.z);
    avatar.group.rotation.y = SLOT_YAW;
    this._riderGroup.add(avatar.group);

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
    this._riders.set(id, { avatar, slot, tag, hidden });
    game?.audio?.play?.('pop');
  }

  _removeRider(id) {
    const r = this._riders.get(id);
    if (!r) return;
    this._riders.delete(id);
    r.tag?.remove?.();
    this._riderGroup?.remove(r.avatar.group);
    r.avatar.dispose();
    this._restoreRemote(id, r.hidden);
  }

  /** Late-bind riders to their networked record: real fur, real hat, no double. */
  _reconcileRiders() {
    const remotes = this._game?.net?.remotes;
    if (!remotes?.get) return;
    for (const [id, r] of this._riders) {
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
    if (!remoteGroup || remote?.avatar?.group !== group) return; // they left; net client owns it now
    if (!group.parent) remoteGroup.add(group);
  }

  /** Walk the local capybara into (or out of) their seat. */
  _setLocalSlot(slot) {
    if (slot === this._localSlot) return;
    if (slot !== null) this._cancelAim?.(); // being seated ends any wind-up
    const game = this._game;
    const engine = game?.engine;
    const avatar = engine?.playerAvatar;
    if (slot !== null) {
      const s = RACE_SLOTS[slot];
      if (s && engine?.controller) engine.controller.setTarget(this._v.set(s.x, 0, s.z));
      game?.audio?.play?.('whoosh');
      game?.toast?.('You are in the lineup! Hop out any time.');
    } else if (avatar) {
      if (avatar.state.anim === 'sit') avatar.setAnim('idle');
      engine?.snapY?.(avatar.group.position, this);
      game?.audio?.play?.('click');
    }
    this._localSlot = slot;
  }

  /** Server->client 'race-start': stash the ctx, then launch the sled game. */
  _onRaceStart(m) {
    const game = this._game;
    if (!game || !m) return;
    // the room stops updating while a minigame owns the screen, so a throw left
    // charging here would sit frozen and fire itself on the way back
    this._cancelAim();
    // The server started the race either way, so the board is empty now.
    this._clearLobby();
    // Already inside a minigame (a solo run started from the rack while the
    // lobby filled): startMinigame would no-op and the ctx would sit there
    // waiting to turn some later solo run into a phantom race. Bow out loudly
    // instead, so the other two are not left waiting on the 150s timeout.
    if (game.activeMinigame) {
      game.net?.send?.({ t: 'race-done', score: 0 });
      game.toast?.('The race left without you: you were already on the slope!');
      return;
    }
    game.__raceCtx = { seed: Number(m.seed) || 0, players: Array.isArray(m.players) ? m.players : [] };
    game.toast?.('Three, two, one... GO!');
    game.startMinigame('sled');
  }

  /** Empty every seat (race launched, or the room is going away). */
  _clearLobby() {
    for (const id of [...this._riders.keys()]) this._removeRider(id);
    this._lobbyCount = 0;
    this._lobbyStarting = false;
    this._setLocalSlot(null);
    this._paintRiders();
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
    // the clock keeps these three (colour + intensity) on the day curve; the
    // hemisphere never drops below the ~0.45 playability floor
    this._hemi = new THREE.HemisphereLight(0xdcefff, 0x93aec9, 1.15);
    scene.add(this._hemi);
    this._amb = new THREE.AmbientLight(0xa9c9e8, 0.32);
    scene.add(this._amb);

    const sun = new THREE.DirectionalLight(0xffe6bd, 1.55);
    this._sun = sun; // sun by day, moon by night: still the only shadow caster
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

    // warm fill spilling out of the lodge, parked off the south gable so the
    // entrance and its forecourt are the warmest thing in a blue-white room
    this._lodgeLight = new THREE.PointLight(0xffc178, 26, 14, 2);
    this._lodgeLight.position.set(10.6, 2.6, 6.2);
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
    // the painted glow in the dome tracks the light: the clock spins the dome
    // and walks the disc round with it, so the sky's warm spot is always where
    // the sun (or the moon) actually is
    this._skyMesh = sky;
    this._skyMat = mat;

    // pale sun disc + halo, parked at the painted glow
    const pos = SUN_DIR.clone().normalize().multiplyScalar(96);
    const discMat = makeGlow(0xfff6dc, { unique: true });
    discMat.fog = false;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.6, 26), discMat);
    disc.position.copy(pos);
    disc.lookAt(0, 8, 0);
    disc.renderOrder = -1;
    scene.add(disc);
    this._sunDisc = disc;
    this._sunDiscMat = discMat;

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
    this._haloMat = haloMat;
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
      // The den's viewing corridor. The camera sits 20 south of whoever is
      // walking here, so a pine anywhere in this band stands between it and the
      // doorway (playtest: three of them hid the entrance and the capybara from
      // the forecourt). Rocks are still allowed through: at 1.0 tall nothing
      // that low can reach the sightline.
      if (x > 5.0 && x < 13.8 && z > 5.0) continue;
      // The mineshaft door and its viewing corridor, by the same argument: the
      // camera sits 20 south of anyone on that path, so a pine in this band
      // stands between it and the lit adit. Excluding candidates only removes
      // trees from the list (the rng stream is consumed before these tests, so
      // every other tree keeps its spot).
      if (Math.hypot(x - MINE.x, z - MINE.z) < 5.6) continue;
      if (x > -11.6 && x < -6.4 && z > 6.0) continue;
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
    const inst = new THREE.InstancedMesh(makeRockGeo(), makeToon(0xffffff, VC), 24);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const d = this._dummy;
    let n = 0;
    // The saddle south of the den forecourt is a pine-free zone (they would
    // stand in the doorway's sightline), so it gets boulders: under a metre
    // tall, they read as terrain detail and never cross the camera's line to a
    // capybara on the steps.
    for (const [x, z] of [[6.4, 11.3], [8.7, 12.6], [11.0, 11.5], [12.9, 13.1], [9.7, 14.4], [13.6, 10.3]]) {
      const s = 0.7 + rng() * 0.4;
      d.position.set(x, terrainH(x, z) - 0.14, z);
      d.rotation.set(rng() * 0.2, rng() * TAU, rng() * 0.2);
      d.scale.setScalar(s);
      d.updateMatrix();
      inst.setMatrixAt(n++, d.matrix);
      this.obstacles.push({ x, z, r: 0.6 * s });
    }
    for (let i = 0; i < 60 && n < 24; i++) {
      const a = rng() * TAU;
      const r = 6.5 + rng() * 10;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < 3.2) continue;
      if (Math.hypot(x - BZ.x, z - BZ.z) < BZ.r + 1.6) continue;
      if (Math.hypot(x - 10.6, z - 1.0) < 5.4) continue;
      if (x > 4.0 && x < 14.4 && z > 5.2 && z < 10.6) continue; // den approach
      if (Math.hypot(x - MINE.x, z - MINE.z) < 4.2) continue; // mine forecourt
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

  /* --- ski lodge: the Game Den's front door ------------------------------- */

  // ROUTE AUDIT for the den entrance (world units; obstacle radii are already
  // the walkable rim, the controller treats the player as a point). Numbers
  // below come from a headless replay of WalkController.update over the real
  // obstacle list, spawn -> hotspot and hotspot -> hotspot, every pair.
  //
  // The doorway is a 2.30 hole in the south gable at z 5.04, world x 9.45 ..
  // 11.75. 'exit-lounge' sits on the steps at (10.60, 5.75) r 2.20, so it
  // auto-fires at 1.76: from z <= 7.51 on the door axis, or from x >= 9.27
  // walking east along the shovelled path at z 6.90.
  // Colliders anywhere near the approach:
  //   lodge + veranda  (8.4, 1.0) (10.6, 1.0) (12.8, 1.0) r 4.0, one capsule
  //   step lanterns    (8.3, 6.6) and (12.9, 6.6) r 0.30
  //   gallows posts    (4.9, 5.7) and (7.9, 5.7) r 0.30
  //   saddle boulders  six, z >= 10.3, all south of everything that matters
  // Nothing at all sits inside x 8.6..12.6, z 5.8..9.4: that block of shovelled
  // snow is the forecourt, and every route into the den ends inside it.
  //
  // Route 1, default spawn (0, 4) -> fire ring: 1.7s, threading between the
  // east gallows post (0.09 off the line) and the lodge capsule (0.42).
  // Route 2, from_plaza (0, 8.5) -> fire ring: 1.8s. The straight line clips the
  // west step lantern by 0.05, i.e. you brush past a lamp post and the slide
  // carries you round it; every other collider is over a metre off the line.
  // Route 3, from_lounge (8.2, 7.7) -> anywhere: the spawn is 3.09 from the
  // hotspot (arming needs > 2.95, and re-entry needs 1.76 + 0.5 of margin: it
  // has 0.83), 0.80 clear of the west step lantern, 1.72 clear of the east
  // gallows post, and 7.95 out from the bot zone rim, so server bots wandering
  // BZ (0, 5) r 4.5 blind never meet a collider of mine.
  // Route 4, gate (0, -7) -> the door: the straight line runs through the
  // building, so this one is all slide - 2.6s down the west flank and round the
  // veranda. It only works because the lodge's colliders are a convex capsule;
  // the grid of small circles tried first jammed walkers in the notches where
  // two rims crossed, both here and coming back out of the den.
  //
  // Deliberate dead nook, which no route is funnelled into: the 1.3 slot
  // between each step lantern and the lodge capsule.
  _lodge(scene) {
    const g = new THREE.Group();
    g.position.set(LODGE.x, 0, LODGE.z);
    g.rotation.y = -Math.PI / 2; // local +z faces west, out over the clearing
    scene.add(g);

    const solid = [];
    const glow = [];

    // Plinth + walls. The body stops 0.4 short of the south gable face: that
    // last slice is built as a pierced plate in _denPorch so the doorway is a
    // real hole with a reveal, not a dark rectangle painted on a solid box.
    part(solid, new THREE.BoxGeometry(8.6, 0.5, 6.6), C.rockDark, { y: 0.25 });
    part(solid, new THREE.BoxGeometry(7.6, 3.2, 6), C.wood, { x: -0.2, y: 2.1 });
    // snow drift banked against the base
    part(solid, new THREE.SphereGeometry(1, 10, 7), C.snowLit, { sx: 4.6, sy: 0.7, sz: 1.1, y: 0.1, z: 3.1 });
    part(solid, new THREE.SphereGeometry(1, 10, 7), C.snowLit, { sx: 1.1, sy: 0.7, sz: 3.4, y: 0.1, x: -4.0 });

    // Stacked log detail on the west facade. It runs unbroken now: the entrance
    // it used to be split around lives on the south gable.
    for (let i = 0; i < 5; i++) {
      const y = 0.78 + i * 0.62;
      const hex = i % 2 ? C.woodLit : C.wood;
      part(solid, new THREE.CylinderGeometry(0.3, 0.3, 8.05, 8), hex, { rz: Math.PI / 2, y, z: 2.94 });
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
    // Round gable window, north end only: the south gable carries the GAME DEN
    // board at that height instead, and two things in one gable is a jumble.
    part(glow, new THREE.CircleGeometry(0.4, 14), C.warm, { ry: -Math.PI / 2, x: -4.08, y: 4.42 });
    part(solid, new THREE.TorusGeometry(0.46, 0.08, 5, 14), C.woodDark, { ry: -Math.PI / 2, x: -4.09, y: 4.42 });

    // facade + side windows. `s` shrinks a pane: the two flanking the den
    // doorway have 1.5 of gable wall each and a full-size window would butt
    // straight into the jambs.
    const win = (x, y, z, ry, s = 1) => {
      part(solid, new THREE.BoxGeometry(1.4 * s, 1.6 * s, 0.12), C.woodLit, { ry, x, y, z });
      const gx = Math.sin(ry) * 0.08;
      const gz = Math.cos(ry) * 0.08;
      part(glow, new THREE.PlaneGeometry(1.1 * s, 1.28 * s), C.warm, { ry, x: x + gx, y, z: z + gz });
      part(solid, new THREE.BoxGeometry(0.08, 1.34 * s, 0.06), C.woodDark, { ry, x: x + gx * 1.4, y, z: z + gz * 1.4 });
      part(solid, new THREE.BoxGeometry(1.16 * s, 0.08, 0.06), C.woodDark, { ry, x: x + gx * 1.4, y, z: z + gz * 1.4 });
      part(solid, new THREE.BoxGeometry(1.6 * s, 0.14, 0.34), C.snowLit, {
        ry, x: x + gx * 2.2, y: y + 0.88 * s, z: z + gz * 2.2,
      });
    };
    win(-2.3, 2.25, 3.02, 0);
    win(2.3, 2.25, 3.02, 0);
    win(4.03, 2.15, 2.2, Math.PI / 2, 0.72);
    win(4.03, 2.15, -2.2, Math.PI / 2, 0.72);

    // West veranda: one unbroken deck again. It was split into two wings to let
    // players walk between them to a west-facing door; with the entrance on the
    // south gable this is purely the cocoa terrace, and a deck with a gap in the
    // middle and no door behind it just reads as missing geometry.
    part(solid, new THREE.BoxGeometry(6.0, 0.36, 2.0), C.woodLit, { y: 0.32, z: 4.0 });
    part(solid, new THREE.BoxGeometry(6.04, 0.1, 1.1), C.snowLit, { y: 0.53, z: 4.5 });
    for (const s of [-1, 1]) {
      part(solid, new THREE.BoxGeometry(0.2, 0.5, 2.04), C.woodDark, { x: s * 2.94, y: 0.3, z: 4.0 });
    }
    // beam across the porch: the cocoa shingle hangs off this
    part(solid, new THREE.BoxGeometry(5.7, 0.22, 0.26), C.woodDark, { y: 3.1, z: 4.8 });
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

    // skis and poles left leaning on the veranda posts, which is what a ski
    // lodge deck is for
    part(solid, new THREE.BoxGeometry(0.14, 2.1, 0.05), C.sky, { rz: 0.22, rx: -0.16, x: -2.5, y: 1.6, z: 4.62 });
    part(solid, new THREE.BoxGeometry(0.14, 2.1, 0.05), C.gold, { rz: 0.3, rx: -0.16, x: -2.2, y: 1.6, z: 4.62 });
    link(solid, [2.3, 0.55, 4.66], [2.56, 2.05, 4.84], 0.035, C.steel);
    link(solid, [2.55, 0.55, 4.66], [2.81, 2.05, 4.84], 0.035, C.steel);

    const solidMeshLodge = solidMesh(solid);
    g.add(solidMeshLodge);
    const glowMeshLodge = glowMesh(glow);
    g.add(glowMeshLodge);
    this._windowMat = glowMeshLodge.userData.mat;

    // The cocoa shingle hangs dead centre on the veranda beam. It faces west and
    // is read at a slant; that is fine for flavour, and the two boards that
    // actually have to be READ (the gallows and the gable shingle) are both
    // square to the camera.
    const signMat = texMat(lodgeSignTexture(), { double: true });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.69), signMat);
    sign.position.set(0, 2.4, 4.7);
    g.add(sign);
    const chains = [];
    link(chains, [-0.8, 2.74, 4.7], [-0.8, 2.99, 4.78], 0.03, C.steelDark);
    link(chains, [0.8, 2.74, 4.7], [0.8, 2.99, 4.78], 0.03, C.steelDark);
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

    // Lodge body + veranda, as ONE convex capsule: three equal circles with
    // collinear centres, so the union has no re-entrant corner anywhere for the
    // controller's push-out-and-slide to jam in. That matters more here than it
    // used to: with the door on the south face, walking between the den and the
    // gate means rounding the building, and a grid of circles (tried first)
    // deadlocked walkers in the notches where two rims crossed.
    //
    // It stops at z 5.0, three centimetres short of the gable face, so the
    // whole forecourt is open and the exit's fire ring (to z 7.51) is reached
    // with 2.5 to spare, while the doorway itself still cannot be walked into.
    for (const bx of [8.4, 10.6, 12.8]) this.obstacles.push({ x: bx, z: 1.0, r: 4.0 });

    this._puffs(scene);
  }

  /**
   * The Game Den entrance, on the lodge's SOUTH gable.
   *
   * This group sits at the lodge centre with NO yaw, so inside it +X is east
   * and +Z is south: +Z points out through the doorway and straight down the
   * follow camera's barrel. Every face built here is square to the play view,
   * which is the whole point of the move - on the west face, where this used to
   * live, the opening was edge-on from every spawn and simply could not be seen.
   *
   * The gable is pierced for real: the lodge body stops 0.4 short of the face
   * and that last slice is three plates around a 2.30 x 2.46 hole, so the dark
   * recess and its lit card are visible through a genuine reveal instead of
   * being buried inside a solid wall box the way the old ones were.
   */
  _denPorch(scene) {
    const g = new THREE.Group();
    g.position.set(LODGE.x, 0, LODGE.z);
    scene.add(g);

    const solid = [];
    const glow = [];
    const DOOR_H = DOOR_HEAD - FLOOR_Y;
    const PLATE_Z = WALL_Z - WALL_T / 2;

    // ---- the pierced gable plate: two panes and a header ------------------
    for (const s of [-1, 1]) {
      part(solid, new THREE.BoxGeometry(1.85, 3.2, WALL_T), C.wood, {
        x: s * 2.075, y: 2.1, z: PLATE_Z,
      });
    }
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2, 3.7 - DOOR_HEAD, WALL_T), C.wood, {
      y: (DOOR_HEAD + 3.7) / 2, z: PLATE_Z,
    });

    // the dark slice of den behind the hole, with a lit card standing in the
    // reveal so the doorway reads as depth rather than as a painted rectangle
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 0.3, DOOR_H + 0.2, 0.12), 0x3a2617, {
      y: FLOOR_Y + DOOR_H / 2, z: WALL_Z - WALL_T - 0.02,
    });
    const innerMat = makeGlow(0xffffff, { unique: true });
    innerMat.map = denDoorwayTexture();
    innerMat.needsUpdate = true;
    const innerCard = new THREE.Mesh(
      new THREE.PlaneGeometry(DOOR_HW * 2 - 0.06, DOOR_H - 0.06),
      innerMat,
    );
    innerCard.position.set(0, FLOOR_Y + DOOR_H / 2, WALL_Z - WALL_T + 0.06);
    g.add(innerCard);

    // jambs, lintel and a snow-capped hood over the whole thing
    for (const s of [-1, 1]) {
      part(solid, new THREE.BoxGeometry(0.34, DOOR_H + 0.5, 0.52), C.woodDark, {
        x: s * (DOOR_HW + 0.17), y: FLOOR_Y + (DOOR_H + 0.5) / 2, z: DOOR_Z,
      });
      part(solid, new THREE.SphereGeometry(0.11, 8, 6), C.gold, {
        x: s * (DOOR_HW + 0.17), y: DOOR_HEAD + 0.42, z: DOOR_Z + 0.04,
      });
    }
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 1.0, 0.4, 0.62), C.woodDark, {
      y: DOOR_HEAD + 0.2, z: DOOR_Z + 0.12,
    });
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 1.4, 0.16, 0.86), C.coralDark, {
      rx: -0.3, y: DOOR_HEAD + 0.52, z: DOOR_Z + 0.4,
    });
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 1.5, 0.11, 0.8), C.snowLit, {
      rx: -0.3, y: DOOR_HEAD + 0.64, z: DOOR_Z + 0.44,
    });

    // Both leaves stand open at 1.25 rad: swung far enough that their tips are
    // 1.70 apart, so the doorway never pinches under the 1.2 walk clearance.
    const AJAR = 1.25;
    const LEAF_W = DOOR_HW - 0.2;
    for (const s of [-1, 1]) {
      const hx = s * DOOR_HW;
      const cx = hx - s * (LEAF_W / 2) * Math.cos(AJAR);
      const cz = DOOR_Z + (LEAF_W / 2) * Math.sin(AJAR);
      const ry = s < 0 ? -AJAR : Math.PI + AJAR;
      part(solid, new THREE.BoxGeometry(LEAF_W, DOOR_H - 0.06, 0.13), C.woodLit, { ry, x: cx, y: FLOOR_Y + DOOR_H / 2, z: cz });
      part(solid, new THREE.BoxGeometry(LEAF_W - 0.26, 0.62, 0.18), C.coralDark, { ry, x: cx, y: FLOOR_Y + 0.62, z: cz });
      part(solid, new THREE.BoxGeometry(LEAF_W - 0.26, 0.1, 0.18), C.gold, { ry, x: cx, y: FLOOR_Y + DOOR_H - 0.78, z: cz });
      // porthole as a short cylinder, not a circle: an open leaf shows the
      // camera whichever face it likes, and a one-sided disc vanishes on half
      part(glow, new THREE.CylinderGeometry(0.19, 0.19, 0.22, 12), C.warm, {
        rx: Math.PI / 2, ry, x: cx, y: FLOOR_Y + DOOR_H - 0.44, z: cz,
      });
      // ring handle on the free edge
      const fx = hx - s * LEAF_W * Math.cos(AJAR);
      const fz = DOOR_Z + LEAF_W * Math.sin(AJAR);
      part(solid, new THREE.TorusGeometry(0.1, 0.03, 4, 10), C.gold, { ry, x: fx - s * 0.14 * Math.cos(AJAR), y: FLOOR_Y + 1.28, z: fz + 0.14 * Math.sin(AJAR) });
    }

    // stone landing + two treads down to the forecourt
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 0.5, FLOOR_Y, 0.9), C.rock, { y: FLOOR_Y / 2, z: DOOR_Z + 0.41 });
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 0.5, 0.34, 0.42), C.rockDark, { y: 0.17, z: DOOR_Z + 1.07 });
    part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 0.5, 0.18, 0.42), C.rock, { y: 0.09, z: DOOR_Z + 1.49 });
    // snow left on the nosings; the treads themselves are shovelled clean
    for (const [ny, nz] of [[0.53, 0.88], [0.37, 1.3], [0.21, 1.72]]) {
      part(solid, new THREE.BoxGeometry(DOOR_HW * 2 + 0.54, 0.06, 0.14), C.snowLit, { y: ny, z: DOOR_Z + nz });
    }

    // ---- step lanterns, one each side of the bottom tread ------------------
    // North of the shovelled path on purpose: anything on its south side would
    // stand between the camera and a capybara walking in.
    for (const s of [-1, 1]) {
      const lx = s * 2.3;
      part(solid, new THREE.CylinderGeometry(0.3, 0.36, 0.22, 9), C.snowLit, { x: lx, y: 0.11, z: 5.6 });
      part(solid, new THREE.CylinderGeometry(0.1, 0.12, 1.05, 7), C.woodDark, { x: lx, y: 0.68, z: 5.6 });
      part(solid, new THREE.BoxGeometry(0.32, 0.05, 0.32), C.steelDark, { x: lx, y: 1.2, z: 5.6 });
      part(solid, new THREE.BoxGeometry(0.32, 0.05, 0.32), C.steelDark, { x: lx, y: 1.52, z: 5.6 });
      part(solid, new THREE.ConeGeometry(0.28, 0.22, 4), C.coralDark, { ry: Math.PI / 4, x: lx, y: 1.65, z: 5.6 });
      part(solid, new THREE.SphereGeometry(0.08, 7, 5), C.gold, { x: lx, y: 1.79, z: 5.6 });
      part(glow, new THREE.BoxGeometry(0.24, 0.3, 0.24), C.warm, { x: lx, y: 1.36, z: 5.6 });
      this.obstacles.push({ x: LODGE.x + lx, z: LODGE.z + 5.6, r: 0.3 });
    }

    // ---- GAME DEN board, bolted flat to the gable above the hood -----------
    // Its bottom edge clears the hood by 0.13 and its snow cap clears the
    // roofline by 0.13; more to the point it starts 0.6 ABOVE the sightline
    // that grazes the lintel from 20 units out, so it never covers the doorway
    // it is advertising. The gable's round window moved to the north end.
    part(solid, new THREE.BoxGeometry(2.62, 1.0, 0.1), C.woodDark, { y: 4.22, z: 4.26 });
    part(solid, new THREE.BoxGeometry(2.72, 0.12, 0.26), C.snowLit, { y: 4.78, z: 4.28 });
    for (const s of [-1, 1]) {
      link(solid, [s * 1.14, 4.74, 4.24], [s * 1.14, 4.92, 4.06], 0.035, C.steelDark);
      part(solid, new THREE.SphereGeometry(0.1, 8, 6), C.gold, { x: s * 1.31, y: 4.22, z: 4.32 });
    }
    const shingle = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.9), texMat(denShingleTexture()));
    shingle.position.set(0, 4.22, 4.32);
    g.add(shingle);

    // ---- warm spill: threshold strip plus a pool on the trodden snow -------
    part(glow, new THREE.PlaneGeometry(DOOR_HW * 2 - 0.1, 0.09), C.warm, { rx: -Math.PI / 2, y: FLOOR_Y + 0.01, z: DOOR_Z + 0.2 });
    this._doorGlowMat = makeGlow(0xffcf8a, { unique: true });
    this._doorGlowMat.transparent = true;
    this._doorGlowMat.opacity = 0.42;
    this._doorGlowMat.depthWrite = false;
    this._doorGlowMat.blending = THREE.AdditiveBlending;
    this._doorGlowMat.map = glowPoolTexture();
    this._doorGlowMat.needsUpdate = true;
    // sits above the forecourt slab (top 0.06) and its flagstones, or the path
    // would z-fight the light it is supposed to be lying under
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), this._doorGlowMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.12, DOOR_Z + 2.3);
    pool.renderOrder = 1;
    g.add(pool);

    g.add(solidMesh(solid));
    g.add(glowMesh(glow));

    // hearth light in the doorway itself, so a capybara at the steps is lit
    this._doorLight = new THREE.PointLight(0xffc98c, 11, 9, 2);
    this._doorLight.position.set(0, 1.7, DOOR_Z + 0.3);
    g.add(this._doorLight);
  }

  /**
   * The shovelled forecourt in front of the den door, the gallows sign that
   * names it at the clearing end, and the lantern light lying on the snow in
   * between: sign -> lit path -> lit doorway, all of it read from one camera.
   *
   * The path runs east-west, so a gallows straddling it would face east-west
   * too and be edge-on to the play camera. It therefore stands beside the path
   * with its boards along world +/-Z - and on the NORTH edge, which is the only
   * side that works: a board south of the path is between the camera and
   * everyone walking it (playtest: standing at the west end of the path put the
   * capybara completely behind the sign). North of the path it can only ever
   * cover the dead pocket between the veranda and the lane, which nobody walks.
   * It also stops at x 7.6, short of the sightline from the clearing into the
   * doorway, and its west post is 4.95 out from the bot zone centre (r 4.5), so
   * server bots wandering blind never meet a collider.
   */
  _denApproach(scene) {
    const rng = this._rng;
    const p = [];

    // ---- shovelled path, slabs snapped to the ground they cross ------------
    // Each slab's top comes from the HIGHEST of its corners, so it never sinks
    // into the hillside on the uphill side; the spoil berms cover the lip it
    // leaves downhill.
    const NODES = [[4.6, 6.8], [6.0, 7.0], [7.4, 7.2], [8.8, 7.3], [10.2, 7.3], [11.6, 7.1]];
    const topAt = (cx, cz, hw = 1.0, hz = 1.3) => Math.max(
      terrainH(cx - hw, cz - hz), terrainH(cx + hw, cz - hz),
      terrainH(cx - hw, cz + hz), terrainH(cx + hw, cz + hz),
    ) + 0.06;
    for (let i = 0; i < NODES.length; i++) {
      const [nx, nz] = NODES[i];
      part(p, new THREE.BoxGeometry(2.0, 0.34, 2.6), C.packed, {
        ry: 0.05 * ((i % 3) - 1), x: nx, y: topAt(nx, nz) - 0.17, z: nz,
      });
    }
    // the apron at the foot of the steps: where every route ends up
    part(p, new THREE.BoxGeometry(4.6, 0.34, 3.0), C.packed, {
      x: 10.6, y: topAt(10.6, 6.9, 2.3, 1.5) - 0.17, z: 6.9,
    });

    // flagstones, nudged off-grid so it reads shovelled rather than paved
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const fx = 5.1 + t * 5.4;
      const fz = 6.95 + Math.sin(t * 2.4) * 0.45;
      part(p, new THREE.BoxGeometry(0.5, 0.06, 0.88 + (i % 3) * 0.16), i % 2 ? C.rock : C.snowShade, {
        ry: 0.1 * ((i % 3) - 1), x: fx, y: topAt(fx, fz) + 0.02, z: fz,
      });
    }

    // shovel spoil banked along the edges (no colliders: they are ankle high)
    for (let i = 0; i < 13; i++) {
      const t = i / 12;
      const bx = 4.3 + t * 7.6;
      const bz = 6.95 + Math.sin(t * 2.0) * 0.3;
      for (const s of [-1, 1]) {
        if (s < 0 && bx > 8.0) continue; // north side is wall, steps and lanterns
        const pz = bz + s * 1.62;
        part(p, new THREE.SphereGeometry(0.34, 8, 6), i % 2 ? C.snowLit : C.snow, {
          sx: 0.9 + rng() * 0.5, sy: 0.42 + rng() * 0.3, sz: 0.8,
          x: bx, y: terrainH(bx, pz) + 0.02, z: pz,
        });
      }
    }
    // wind-drifted humps out on the saddle, so the ground the camera looks over
    // on the way in is not one flat sheet of white (they are 0.4 tall: the
    // sightline to the doorway clears them by a metre and a half)
    for (const [dx, dz, sx, sz] of [[7.6, 10.6, 2.2, 1.1], [11.9, 12.4, 2.6, 1.2], [9.3, 13.6, 1.8, 0.9], [14.0, 11.4, 1.6, 1.0]]) {
      part(p, new THREE.SphereGeometry(1, 10, 7), rng() > 0.5 ? C.snowLit : C.snow, {
        sx, sy: 0.34 + rng() * 0.12, sz, x: dx, y: terrainH(dx, dz) - 0.06, z: dz,
      });
    }
    scene.add(solidMesh(p));

    // ---- the light lying on the path: one merged sheet of warm puddles -----
    const pud = [];
    for (let i = 0; i < NODES.length; i++) {
      const [nx, nz] = NODES[i];
      const size = 1.5 + i * 0.22;
      part(pud, new THREE.PlaneGeometry(size, size), 0xffffff, {
        rx: -Math.PI / 2, x: nx, y: topAt(nx, nz) + 0.03, z: nz,
      });
    }
    this._trailGlowMat = makeGlow(0xffcf8a, { unique: true });
    this._trailGlowMat.map = glowPoolTexture();
    this._trailGlowMat.transparent = true;
    this._trailGlowMat.opacity = 0.3;
    this._trailGlowMat.depthWrite = false;
    this._trailGlowMat.blending = THREE.AdditiveBlending;
    this._trailGlowMat.needsUpdate = true;
    const puddles = new THREE.Mesh(mergeParts(pud), this._trailGlowMat);
    puddles.renderOrder = 1;
    scene.add(puddles);

    // ---- gallows sign on the path's north shoulder -------------------------
    const SX = 6.4, SZ = 5.7; // posts land at world x 4.9 and 7.9
    const sg = new THREE.Group();
    sg.position.set(SX, Math.min(terrainH(SX - 1.5, SZ), terrainH(SX + 1.5, SZ)) - 0.12, SZ);
    scene.add(sg);

    const post = [];
    for (const s of [-1, 1]) {
      part(post, new THREE.CylinderGeometry(0.14, 0.17, 3.8, 8), C.woodDark, { x: s * 1.5, y: 1.9 });
      part(post, new THREE.CylinderGeometry(0.42, 0.48, 0.28, 10), C.snowLit, { x: s * 1.5, y: 0.26 });
      part(post, new THREE.SphereGeometry(0.18, 9, 7), C.gold, { x: s * 1.5, y: 3.88 });
      // lantern hood on a stub bracket, one each end
      part(post, new THREE.BoxGeometry(0.06, 0.06, 0.34), C.steelDark, { x: s * 1.5, y: 3.42, z: 0.2 });
      part(post, new THREE.ConeGeometry(0.2, 0.16, 4), C.coralDark, { ry: Math.PI / 4, x: s * 1.5, y: 3.34, z: 0.36 });
      this.obstacles.push({ x: SX + s * 1.5, z: SZ, r: 0.3 });
    }
    part(post, new THREE.BoxGeometry(3.2, 0.22, 0.28), C.woodDark, { y: 3.7 });
    part(post, new THREE.BoxGeometry(3.26, 0.12, 0.32), C.snowLit, { y: 3.84 });
    part(post, new THREE.BoxGeometry(2.56, 1.3, 0.13), C.coralDark, { y: 2.75 });
    link(post, [-0.9, 3.4, 0], [-0.9, 3.6, 0], 0.03, C.steelDark);
    link(post, [0.9, 3.4, 0], [0.9, 3.6, 0], 0.03, C.steelDark);
    // the shovel that cut the path, leaning on the west post. Parked INSIDE
    // that post's collider so it is scenery you look at, not a handle you walk
    // through.
    part(post, new THREE.BoxGeometry(0.42, 0.5, 0.08), C.steel, { rz: 0.19, rx: -0.22, x: -1.35, y: 0.5, z: 0.2 });
    link(post, [-1.35, 0.28, 0.2], [-1.62, 1.9, -0.04], 0.05, C.woodLit);
    part(post, new THREE.BoxGeometry(0.05, 0.24, 0.05), C.woodDark, { x: -1.62, y: 1.98, z: -0.04 });
    sg.add(solidMesh(post));

    // two faces, never one double-sided plane: the back would read mirrored
    const faceMat = texMat(denSignTexture());
    for (const s of [-1, 1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), faceMat);
      face.position.set(0, 2.75, s * 0.075);
      face.rotation.y = s < 0 ? Math.PI : 0;
      sg.add(face);
    }

    // the two lanterns actually burn (one draw call, one flickering material)
    const bulbs = [];
    for (const s of [-1, 1]) {
      part(bulbs, new THREE.BoxGeometry(0.16, 0.22, 0.16), C.warm, { x: s * 1.5, y: 3.16, z: 0.36 });
    }
    const bulbMesh = glowMesh(bulbs);
    sg.add(bulbMesh);
    this._denLampMat = bulbMesh.userData.mat;
    this._denLight = new THREE.PointLight(0xffc98c, 6, 7, 2);
    this._denLight.position.set(0, 3.2, 0.4);
    sg.add(this._denLight);
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
    this._cocoaAt = new THREE.Vector3(COCOA.x, FLOOR_Y + 1.45, COCOA.z);
  }

  _cocoaStand(scene) {
    const p = [];
    const x = COCOA.x;
    const z = COCOA.z;
    const y = FLOOR_Y; // it stands on the veranda deck, not on the snow
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
    // a stack of firewood beside it, stacked along the deck rather than across
    // it: the deck is only 2.0 wide and logs sticking off the edge read as bugs
    for (let i = 0; i < 5; i++) {
      const row = i < 3 ? 0 : 1;
      const idx = i < 3 ? i : i - 3;
      part(p, new THREE.CylinderGeometry(0.11, 0.11, 0.86, 7), i % 2 ? C.bark : C.woodDark, {
        rz: Math.PI / 2, x: 0.05, y: 0.12 + row * 0.21, z: -1.55 + idx * 0.24 + row * 0.12,
      });
    }
    const mesh = solidMesh(p);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    // no collider: the veranda it stands on is already inside the lodge capsule
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

  /* --- the mineshaft door ------------------------------------------------- */

  /**
   * A timbered adit into the mountainside on the west of the clearing: rock
   * bluff, pierced frame, two burning lanterns, a board over the lintel and a
   * stub of rail running out of the mouth into the snow. See the MINE constants
   * for the collider audit; the shovelled path is dressed here too so the
   * approach reads sign -> lit path -> lit hole, the same grammar as the den.
   */
  _mineAdit(scene) {
    const rng = this._rng;
    const baseY = terrainH(MINE.x, MINE.z);
    const g = new THREE.Group();
    g.position.set(MINE.x, baseY, MINE.z);
    g.rotation.y = MINE_YAW; // local +Z points out of the mouth
    scene.add(g);

    const solid = [];
    const glow = [];
    const HW = 1.2;   // opening half width
    const H = 2.75;   // opening height

    // ---- the bluff: lumps of rock heaped around and over the opening -------
    const lumps = [
      [-2.6, 0.9, -0.2, 1.6], [-3.4, 1.9, -1.3, 1.9], [-2.2, 2.4, -1.9, 1.5],
      [2.6, 0.9, -0.2, 1.6], [3.3, 1.8, -1.2, 1.9], [2.2, 2.5, -2.0, 1.5],
      [0, 3.7, -1.1, 2.0], [-1.3, 4.0, -2.1, 1.7], [1.3, 3.9, -2.2, 1.7],
      [0, 2.2, -3.7, 2.8], [-2.4, 2.6, -4.0, 2.2], [2.5, 2.5, -4.1, 2.2], [0, 4.5, -3.5, 2.0],
    ];
    for (let i = 0; i < lumps.length; i++) {
      const [lx, ly, lz, r] = lumps[i];
      const geo = new THREE.IcosahedronGeometry(r, 0);
      geo.scale(1, 0.86, 1);
      part(solid, geo, i % 3 ? C.rock : C.rockDark, { ry: rng() * TAU, x: lx, y: ly, z: lz });
      // snow lying on everything that faces the sky
      if (ly > 2.0) {
        part(solid, new THREE.SphereGeometry(r * 0.72, 9, 6, 0, TAU, 0, Math.PI * 0.5), C.snowLit, {
          sy: 0.42, x: lx, y: ly + r * 0.72, z: lz,
        });
      }
    }
    // drift banked against the foot of the bluff, outside the doorway
    part(solid, new THREE.SphereGeometry(1, 10, 7), C.snowLit, { sx: 3.4, sy: 0.42, sz: 0.9, x: 0, y: 0.02, z: 0.85 });
    for (const s of [-1, 1]) {
      part(solid, new THREE.SphereGeometry(1, 9, 6), C.snow, { sx: 1.1, sy: 0.34, sz: 0.7, x: s * 2.6, y: 0.02, z: 0.7 });
    }

    // ---- the throat: two receding frames behind a dark slot ----------------
    part(solid, new THREE.BoxGeometry(HW * 2 + 0.5, H + 0.4, 0.14), 0x2a1c12, { y: (H + 0.4) / 2, z: -2.55 });
    const throatMat = makeGlow(0xffffff, { unique: true });
    throatMat.map = mineThroatTexture();
    throatMat.needsUpdate = true;
    const throat = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2 - 0.05, H - 0.05), throatMat);
    throat.position.set(0, H / 2, -2.42);
    g.add(throat);
    for (let i = 1; i <= 2; i++) {
      const z = -i * 0.95;
      const hue = i === 1 ? C.woodDark : 0x4a3222;
      for (const s of [-1, 1]) {
        part(solid, new THREE.BoxGeometry(0.28, H - i * 0.1, 0.26), hue, { x: s * (HW - 0.06), y: (H - i * 0.1) / 2, z });
      }
      part(solid, new THREE.BoxGeometry(HW * 2 + 0.36, 0.3, 0.28), hue, { y: H - i * 0.1 + 0.1, z });
    }

    // ---- the mouth frame: chunky posts, lintel, snow-capped cap beam -------
    for (const s of [-1, 1]) {
      part(solid, new THREE.BoxGeometry(0.36, H, 0.44), s < 0 ? C.wood : C.woodLit, { x: s * HW, y: H / 2, z: 0.02 });
      part(solid, new THREE.BoxGeometry(0.5, 0.22, 0.56), C.woodDark, { x: s * HW, y: 0.11, z: 0.02 });
      part(solid, new THREE.SphereGeometry(0.1, 8, 6), C.gold, { x: s * HW, y: H - 0.18, z: 0.26 });
      // strut wedged between post and rock
      part(solid, new THREE.BoxGeometry(0.18, 0.9, 0.18), C.woodDark, {
        rz: s * 0.8, x: s * (HW + 0.42), y: H - 0.5, z: 0.02,
      });
    }
    part(solid, new THREE.BoxGeometry(HW * 2 + 1.0, 0.4, 0.52), C.woodDark, { y: H + 0.2, z: 0.04 });
    part(solid, new THREE.BoxGeometry(HW * 2 + 1.5, 0.18, 0.78), C.wood, { rx: -0.26, y: H + 0.56, z: 0.3 });
    part(solid, new THREE.BoxGeometry(HW * 2 + 1.6, 0.12, 0.72), C.snowLit, { rx: -0.26, y: H + 0.7, z: 0.34 });

    // ---- lanterns hung under the cap beam ----------------------------------
    for (const s of [-1, 1]) {
      const lx = s * (HW + 0.28);
      link(solid, [lx, H + 0.36, 0.24], [lx, H - 0.02, 0.24], 0.028, C.steelDark);
      part(solid, new THREE.ConeGeometry(0.24, 0.2, 4), C.coralDark, { ry: Math.PI / 4, x: lx, y: H - 0.12, z: 0.24 });
      part(solid, new THREE.SphereGeometry(0.06, 7, 5), C.gold, { x: lx, y: H - 0.02, z: 0.24 });
      part(glow, new THREE.BoxGeometry(0.2, 0.26, 0.2), C.warm, { x: lx, y: H - 0.34, z: 0.24 });
    }

    // ---- the board over the lintel -----------------------------------------
    part(solid, new THREE.BoxGeometry(2.5, 1.14, 0.12), C.woodDark, { y: H + 1.42, z: -0.16 });
    part(solid, new THREE.BoxGeometry(2.6, 0.12, 0.26), C.snowLit, { y: H + 2.04, z: -0.14 });
    for (const s of [-1, 1]) {
      part(solid, new THREE.SphereGeometry(0.09, 8, 6), C.gold, { x: s * 1.08, y: H + 1.42, z: -0.09 });
    }
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.38, 1.08), texMat(mineSignTexture()));
    board.position.set(0, H + 1.42, -0.09);
    g.add(board);

    // ---- rails running out of the mouth, ending in the drift ---------------
    for (const s of [-1, 1]) {
      part(solid, new THREE.BoxGeometry(0.09, 0.1, 3.6), C.steelDark, { x: s * 0.42, y: 0.08, z: 1.2 });
    }
    for (let i = 0; i < 5; i++) {
      part(solid, new THREE.BoxGeometry(1.24, 0.09, 0.24), C.woodDark, { x: 0, y: 0.04, z: -0.3 + i * 0.78 });
    }
    part(solid, new THREE.BoxGeometry(1.16, 0.34, 0.2), C.woodDark, { y: 0.21, z: 2.9 });
    part(solid, new THREE.BoxGeometry(1.2, 0.12, 0.26), C.coralDark, { y: 0.42, z: 2.9 });
    // spilled ore beside the rails, still glinting under the snow
    for (let i = 0; i < 6; i++) {
      const ox = (rng() - 0.5) * 2.6;
      const oz = 1.2 + rng() * 1.9;
      part(solid, new THREE.IcosahedronGeometry(0.13 + rng() * 0.1, 0), i % 3 ? C.rockDark : C.rock, { x: ox, y: 0.08, z: oz });
      if (i % 2) part(glow, new THREE.OctahedronGeometry(0.09), i % 4 ? C.gold : 0x42d6c8, { x: ox + 0.16, y: 0.1, z: oz + 0.1 });
    }

    // ---- a lamp post out on the path, west of the mouth --------------------
    const px = -1.9;
    const pz = 2.6;
    part(solid, new THREE.CylinderGeometry(0.3, 0.36, 0.2, 9), C.snowLit, { x: px, y: 0.1, z: pz });
    part(solid, new THREE.CylinderGeometry(0.1, 0.12, 1.6, 7), C.woodDark, { x: px, y: 0.95, z: pz });
    part(solid, new THREE.BoxGeometry(0.32, 0.05, 0.32), C.steelDark, { x: px, y: 1.75, z: pz });
    part(solid, new THREE.ConeGeometry(0.28, 0.22, 4), C.coralDark, { ry: Math.PI / 4, x: px, y: 2.05, z: pz });
    part(solid, new THREE.SphereGeometry(0.08, 7, 5), C.gold, { x: px, y: 2.19, z: pz });
    part(glow, new THREE.BoxGeometry(0.24, 0.3, 0.24), C.warm, { x: px, y: 1.9, z: pz });

    g.add(solidMesh(solid));
    const glowMeshMine = glowMesh(glow);
    g.add(glowMeshMine);
    this._mineLampMat = glowMeshMine.userData.mat;

    // hearth light in the mouth: a capybara on the threshold is lit warm
    this._mineLight = new THREE.PointLight(0xffc07a, 9, 8, 2);
    this._mineLight.position.set(0, 1.6, 0.1);
    g.add(this._mineLight);

    // the warm pool the mouth throws onto the snow
    this._mineGlowMat = makeGlow(0xffcf8a, { unique: true });
    this._mineGlowMat.transparent = true;
    this._mineGlowMat.opacity = 0.38;
    this._mineGlowMat.depthWrite = false;
    this._mineGlowMat.blending = THREE.AdditiveBlending;
    this._mineGlowMat.map = glowPoolTexture();
    this._mineGlowMat.needsUpdate = true;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), this._mineGlowMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.1, 1.9);
    pool.renderOrder = 1;
    g.add(pool);

    // ---- world-space bits: the collider and the shovelled path stub --------
    g.updateMatrixWorld(true);
    const w = new THREE.Vector3();
    g.localToWorld(w.set(0, 0, -2.6));
    this.obstacles.push({ x: w.x, z: w.z, r: 2.4 });
    g.localToWorld(w.set(px, 0, pz));
    this.obstacles.push({ x: w.x, z: w.z, r: 0.3 });

    const p = [];
    const topAt = (cx, cz, hw = 0.9, hz = 1.1) => Math.max(
      terrainH(cx - hw, cz - hz), terrainH(cx + hw, cz - hz),
      terrainH(cx - hw, cz + hz), terrainH(cx + hw, cz + hz),
    ) + 0.06;
    const NODES = [[-4.7, 6.9], [-5.8, 7.2], [-6.9, 7.6], [-7.9, 8.0]];
    for (let i = 0; i < NODES.length; i++) {
      const [nx, nz] = NODES[i];
      part(p, new THREE.BoxGeometry(1.9, 0.34, 2.2), C.packed, {
        ry: 0.4 + 0.06 * ((i % 3) - 1), x: nx, y: topAt(nx, nz) - 0.17, z: nz,
      });
    }
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const fx = -4.5 - t * 3.3;
      const fz = 6.85 + t * 1.15 + Math.sin(t * 2.6) * 0.16;
      part(p, new THREE.BoxGeometry(0.46, 0.06, 0.8 + (i % 3) * 0.14), i % 2 ? C.rock : C.snowShade, {
        ry: 0.5 + 0.1 * ((i % 3) - 1), x: fx, y: topAt(fx, fz) + 0.02, z: fz,
      });
    }
    // shovel spoil banked along the path edges (ankle high: no colliders)
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const bx = -4.3 - t * 3.4;
      const bz = 6.8 + t * 1.2;
      for (const s of [-1, 1]) {
        const sx = bx + s * 0.42;
        const sz = bz + s * -1.3;
        part(p, new THREE.SphereGeometry(0.32, 8, 6), i % 2 ? C.snowLit : C.snow, {
          sx: 0.85 + rng() * 0.45, sy: 0.4 + rng() * 0.26, sz: 0.8,
          x: sx, y: terrainH(sx, sz) + 0.02, z: sz,
        });
      }
    }
    scene.add(solidMesh(p));

    // the light lying along that path, breathing with the lanterns
    const pud = [];
    for (let i = 0; i < NODES.length; i++) {
      const [nx, nz] = NODES[i];
      part(pud, new THREE.PlaneGeometry(1.5 + i * 0.24, 1.5 + i * 0.24), 0xffffff, {
        rx: -Math.PI / 2, x: nx, y: topAt(nx, nz) + 0.03, z: nz,
      });
    }
    this._minePathGlowMat = makeGlow(0xffcf8a, { unique: true });
    this._minePathGlowMat.map = glowPoolTexture();
    this._minePathGlowMat.transparent = true;
    this._minePathGlowMat.opacity = 0.28;
    this._minePathGlowMat.depthWrite = false;
    this._minePathGlowMat.blending = THREE.AdditiveBlending;
    this._minePathGlowMat.needsUpdate = true;
    const puddles = new THREE.Mesh(mergeParts(pud), this._minePathGlowMat);
    puddles.renderOrder = 1;
    scene.add(puddles);
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
    const N = SNOW_N;
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
    // Weather scales the flakes with the geometry's draw range rather than by
    // rebuilding the buffer: the pool is allocated once and a blizzard is just
    // more of it drawn, falling faster.
    this._snow = { attr: geo.attributes.position, meta, n: N, geo, mat };
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

  /**
   * The aurora (LIVING-COVE section A): three additive ribbons hung across the
   * north sky, waved in the vertex shader's input rather than by any shader of
   * our own (custom GLSL is sanctioned in The Drift only). Green at the hem,
   * pink at the crown, black at every edge - additive blending turns black into
   * "not there", so the curtains fade out instead of ending in a hard line.
   *
   * Built once, hidden until the server says `aurora` AND it is night; the
   * per-frame wave only runs while it is on screen. One draw call, fog off (at
   * 58-72 units out the room's fog would otherwise erase it).
   */
  _aurora(scene) {
    const list = [];
    for (let b = 0; b < AUR_BANDS; b++) {
      const geo = new THREE.PlaneGeometry(1, 1, AUR_COLS, AUR_ROWS);
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      // The play camera looks DOWN (follow: 3/4 from 11.5 up; static: from 24
      // up), so the visible sky is a low band just above the horizon: measured
      // by projecting test points, anything above y ~7 at 34 out, or y ~4 at 60
      // out, is off the top of the frame in both modes. The curtains therefore
      // hang low and near, rising out of the cloud sea behind the tree ring and
      // through the distant peaks, instead of high overhead where a real one
      // would be and nobody in this game would ever see it.
      const R = 34 + b * 5;
      const baseY = -3 + b * 0.8;
      const H = 11 - b * 0.8;
      const span = 1.7 + b * 0.3;        // radians of sky the band covers
      const centre = -Math.PI / 2;       // due north: -Z, straight up the camera
      const phase = b * 2.1;
      let i = 0;
      for (let row = 0; row <= AUR_ROWS; row++) {
        for (let cx = 0; cx <= AUR_COLS; cx++, i++) {
          const u = cx / AUR_COLS;
          const v = row / AUR_ROWS;
          const a = centre + (u - 0.5) * span;
          const sag = Math.sin(u * 5.6 + phase) * 1.7 + Math.sin(u * 11 - phase) * 0.6;
          pos.setXYZ(i, Math.cos(a) * R, baseY + sag + v * H, Math.sin(a) * R);
          // vertical gradient: hem green -> teal -> pink crown, zero at both
          // edges; horizontal envelope tapers each band to nothing at its ends
          const env = Math.pow(Math.sin(Math.PI * u), 0.7) * (0.62 - b * 0.11);
          const fade = Math.sin(Math.PI * v);
          const g = Math.max(0, 1 - Math.abs(v - 0.3) * 2.1);
          const p = Math.max(0, (v - 0.45) * 1.8);
          col[i * 3] = (0.22 * g + 0.95 * p) * env * fade;
          col[i * 3 + 1] = (1.0 * g + 0.36 * p) * env * fade;
          col[i * 3 + 2] = (0.62 * g + 0.72 * p) * env * fade;
        }
      }
      pos.needsUpdate = true;
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      list.push(geo);
    }

    const mat = makeGlow(0xffffff, { unique: true });
    mat.vertexColors = true;
    mat.transparent = true;
    mat.opacity = 0;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.side = THREE.DoubleSide;
    mat.fog = false;
    mat.needsUpdate = true;

    const mesh = new THREE.Mesh(mergeParts(list), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1; // after the sky dome, before everything on the ground
    mesh.visible = false;
    scene.add(mesh);
    const attr = mesh.geometry.attributes.position;
    this._aur = {
      mesh, mat, attr,
      base: Float32Array.from(attr.array), // the still pose the wave rides on
    };
  }

  /* --- snowballs (LIVING-COVE A2: ambient play toys) ---------------------- */

  /**
   * Hold the RIGHT button on the snow, an arc preview grows out of your
   * capybara, let go and it flies (left click stays plain old walking).
   * The frame that goes out is {t:'snow', to:[x,z]}; every client
   * in the room (the thrower included, locally, so their own throw never waits
   * on the round trip) runs the SAME arc from the sender's feet to that point,
   * so everyone watches one snowball, not their own guess at one.
   *
   * Five pooled objects, five draw calls, all of them idle until someone plays:
   * balls in flight, landing puffs, the aim beads, the landing ring, and the
   * snowcap geometry a booped capybara wears for a few seconds.
   */
  _snowToy(scene) {
    // 0.22 rather than a realistic 0.12: white on white at 20 units out, a
    // smaller ball simply did not read in a night capture
    const ballGeo = new THREE.SphereGeometry(0.22, 9, 7);
    paintGeo(ballGeo, C.snowLit);
    const balls = new THREE.InstancedMesh(ballGeo, makeToon(0xffffff, VC), SNOW_MAX_BALLS);
    balls.castShadow = true;
    balls.frustumCulled = false;
    balls.count = 0;
    scene.add(balls);
    this._ballMesh = balls;
    this._balls = [];

    const puffGeo = new THREE.SphereGeometry(0.17, 7, 5);
    paintGeo(puffGeo, C.snowLit);
    const puffMat = makeToon(0xffffff, { vertexColors: true, unique: true });
    puffMat.transparent = true;
    puffMat.opacity = 0.9;
    puffMat.depthWrite = false;
    const puffs = new THREE.InstancedMesh(puffGeo, puffMat, SNOW_PUFFS);
    puffs.frustumCulled = false;
    puffs.count = 0;
    scene.add(puffs);
    this._hitPuffMesh = puffs;
    this._hitPuffs = [];

    // gold, not cream: the prompt colour reads on white snow at noon and in a
    // blue midnight alike, and it ties the beads to the landing ring
    const beadMat = makeGlow(C.gold, { unique: true });
    beadMat.transparent = true;
    beadMat.opacity = 0.95;
    beadMat.depthWrite = false;
    const beads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 6, 5), beadMat, AIM_BEADS);
    beads.frustumCulled = false;
    beads.count = 0;
    scene.add(beads);
    this._aimBeads = beads;

    const ringMat = makeGlow(C.gold, { unique: true });
    ringMat.transparent = true;
    ringMat.opacity = 0.85;
    ringMat.depthWrite = false;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.075, 5, 20), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 2;
    ring.visible = false;
    scene.add(ring);
    this._aimRing = ring;

    // The snowcap worn by whoever just got booped. Flagged shared so neither
    // avatar.dispose() nor disposeObject() frees it out from under the other
    // capybaras wearing one: this room owns it and drops it in dispose().
    // Sized to the skull it sits on (radius 0.47, crown at y 0.437 in head
    // space): a 0.44 dome squashed to 0.68 tucks its rim just inside the fur at
    // y 0.16 and clears the crown by 0.02. The first pass at 0.5 wide swallowed
    // the whole face and read as a helmet, not as snow.
    const cap = [];
    part(cap, new THREE.SphereGeometry(0.44, 12, 7, 0, TAU, 0, Math.PI * 0.55), C.snowLit, { sy: 0.68 });
    part(cap, new THREE.SphereGeometry(0.12, 7, 5), C.snowLit, { sx: 1.3, sy: 0.8, x: -0.27, y: -0.02, z: 0.12 });
    part(cap, new THREE.SphereGeometry(0.1, 7, 5), C.snowLit, { sx: 1.2, sy: 0.9, x: 0.26, y: -0.05, z: -0.14 });
    this._capGeo = mergeParts(cap);
    this._capGeo.userData.shared = true;
    this._caps = [];
    this._booped = [];
  }

  /* --- per-frame ---------------------------------------------------------- */

  update(dt, game) {
    const t = (this._t += dt);
    if (game) this._game = game;

    // time of day first: everything below reads the factors it leaves behind
    if (this._hasClock) this._relight(dt);

    // falling snow. Weather scales how many of the pool are drawn (and how hard
    // they come down); without a clock the whole pool falls, as it always has.
    const snow = this._snow;
    if (snow) {
      const a = snow.attr.array;
      const m = snow.meta;
      const speed = this._snowSpeedK;
      const count = Math.min(snow.n, Math.round(this._snowShown));
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        a[i3 + 1] -= m[i3] * speed * dt;
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

    // snow sparkle: it is sunlight caught on the crust, so it goes out at night
    const sp = this._sparkles;
    if (sp) {
      const arr = sp.arr;
      const m = sp.meta;
      const day = 0.18 + 0.82 * this._dayness;
      for (let i = 0; i < sp.n; i++) {
        const s = Math.sin(t * m[i * 2] + m[i * 2 + 1]);
        const v = s > 0.86 ? (s - 0.86) * 7.1 * day : 0;
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

    // Every warm thing in the room breathes on its own timer, and the clock
    // rides on top of that as a multiplier per lamp channel (windows, den door,
    // gallows path, mine): at noon they sit exactly where they always did, and
    // dusk-to-dawn each channel eases up to its night level on its own lag.
    const kWin = this._lampK[0];
    const kDen = this._lampK[1];
    const kPath = this._lampK[2];
    const kMine = this._lampK[3];

    // ice shimmer, hearth flicker, sun breathing
    if (this._sheenMat) this._sheenMat.opacity = (0.32 + 0.18 * (0.5 + 0.5 * Math.sin(t * 0.7))) * (0.45 + 0.55 * this._dayness);
    if (this._windowMat) {
      const f = (0.93 + 0.07 * Math.sin(t * 3.1) * Math.sin(t * 1.7 + 0.6)) * kWin;
      this._windowMat.color.setRGB(1 * f, 0.965 * f, 0.9 * f);
    }
    if (this._lodgeLight) this._lodgeLight.intensity = (24 + Math.sin(t * 2.6) * 2.4) * kWin;
    if (this._lampMat) {
      const f = (0.9 + 0.1 * Math.sin(t * 4.2 + 1.3)) * kPath;
      this._lampMat.color.setRGB(1 * f, 0.85 * f, 0.58 * f);
    }
    if (this._halo) {
      const s = (1 + Math.sin(t * 0.5) * 0.03) * (0.42 + 0.58 * this._dayness);
      this._halo.scale.set(s, s, s);
    }

    // den doorway: hearth spilling onto the steps, lanterns on the sign
    if (this._doorLight) this._doorLight.intensity = (10 + Math.sin(t * 2.6 + 1.1) * 1.7) * kDen;
    if (this._doorGlowMat) this._doorGlowMat.opacity = (0.34 + 0.11 * (0.5 + 0.5 * Math.sin(t * 1.9))) * kDen;
    // the puddles along the path breathe a beat behind the doorway they lead to
    if (this._trailGlowMat) this._trailGlowMat.opacity = (0.24 + 0.09 * (0.5 + 0.5 * Math.sin(t * 1.9 - 0.9))) * kPath;
    if (this._denLampMat) {
      // vertex colours already carry C.warm; this only breathes on top of them
      const f = (0.88 + 0.12 * Math.sin(t * 5.1 + 2.2)) * kDen;
      this._denLampMat.color.setRGB(1 * f, 0.94 * f, 0.82 * f);
    }
    if (this._denLight) this._denLight.intensity = (5.4 + Math.sin(t * 3.4) * 0.9) * kDen;

    // the mineshaft: two lanterns burning at the mouth, warm light on the snow
    if (this._mineLampMat) {
      const f = (0.87 + 0.13 * Math.sin(t * 4.7 + 0.4)) * kMine;
      this._mineLampMat.color.setRGB(1 * f, 0.9 * f, 0.7 * f);
    }
    if (this._mineLight) this._mineLight.intensity = (8.4 + Math.sin(t * 3.0 + 0.7) * 1.4) * kMine;
    if (this._mineGlowMat) this._mineGlowMat.opacity = (0.3 + 0.1 * (0.5 + 0.5 * Math.sin(t * 1.6))) * kMine;
    if (this._minePathGlowMat) this._minePathGlowMat.opacity = (0.22 + 0.08 * (0.5 + 0.5 * Math.sin(t * 1.6 - 0.8))) * kMine;

    this._updateAurora(dt, t);
    this._updateAim(dt, t);
    this._updateBalls(dt);
    this._updateHitPuffs(dt);
    this._updateBoops(dt);
    this._updateCaps(dt);

    // one nudge per session, once someone has stood in the snow long enough to
    // wonder what there is to do out here
    if (this._hintT >= 0) {
      this._hintT += dt;
      if (this._hintT > 7) {
        this._hintT = -1;
        _hintShown = true;
        this._game?.toast?.('Right-click and hold on the snow to lob a snowball at someone.');
      }
    }

    this._updateLobby(dt, t);
  }

  /* --- world clock (LIVING-COVE section A) -------------------------------- */

  /**
   * Server clock frame, and one call right after build so a night arrival never
   * flashes noon first. `weather` on the peak is snowfall intensity 0..2; a
   * word from the outdoor-family vocabulary is understood too, in case the
   * server speaks one dialect for every room.
   */
  onClock(dayT, weather, aurora) {
    const t = Number(dayT);
    if (Number.isFinite(t)) {
      const next = ((t % 1) + 1) % 1;
      // The local phase runs on between the server's 10s frames, so a frame
      // that agrees with us to within ~30 cove-seconds is left alone: only a
      // real disagreement (reconnect, restart, first frame) moves the hands.
      const drift = Math.abs(((next - this._dayT + 1.5) % 1) - 0.5);
      if (!this._hasClock || drift > 0.012) this._dayT = next;
    }
    this._snowWant = snowIntensity(weather);
    this._auroraOn = !!aurora;
    this._hasClock = true;
  }

  /**
   * The whole room on the day curve: sky, fog, sun/moon, fills, lamps, snow.
   * Runs every frame off a locally advanced dayT (never Date), lerping into
   * preallocated colours so the clock allocates nothing per frame.
   */
  _relight(dt) {
    this._dayT = (this._dayT + dt / DAY_SECONDS) % 1;
    const h = Math.cos((this._dayT - 0.25) * TAU); // sun elevation: 1 noon, -1 midnight
    const day = smoothstep(-0.22, 0.16, h);
    const night = 1 - day;
    const rising = this._dayT < 0.25 || this._dayT > 0.75;
    const warm = Math.max(0, 1 - Math.abs(h) / 0.34) * (0.35 + 0.65 * day);
    this._dayness = day;
    this._nightK = night;

    // first frame lands on the phase; after that everything eases (~0.4s)
    const k = this._litOnce ? Math.min(1, dt * 2.5) : 1;
    this._litOnce = true;
    const warmK = warm * 0.7;

    _lc.copy(P.skyNight).lerp(P.skyDay, day).lerp(rising ? P.skyDawn : P.skyDusk, warmK);
    if (this._skyMat) this._skyMat.color.lerp(_lc, k);
    _lc.copy(P.bgNight).lerp(P.bgDay, day).lerp(rising ? P.bgDawn : P.bgDusk, warmK);
    if (this._bgColor) this._bgColor.lerp(_lc, k);
    _lc.copy(P.fogNight).lerp(P.fogDay, day).lerp(rising ? P.fogDawn : P.fogDusk, warmK);
    if (this._fog) this._fog.color.lerp(_lc, k);

    // sun by day, moon by night: the same single shadow caster, walked round
    // the sky by dayT. At dayT 0.25 it lands exactly on the authored noon pose.
    const sun = this._sun;
    if (sun) {
      const az = NOON_AZ + (this._dayT - 0.25) * TAU;
      const ah = Math.abs(h);
      sun.position.set(Math.cos(az) * SUN_R, 14 * (0.35 + 0.65 * ah), Math.sin(az) * SUN_R);
      _lc.copy(P.moon).lerp(P.sunDay, day).lerp(P.sunWarm, warm * 0.8);
      sun.color.lerp(_lc, k);
      sun.intensity += ((0.42 + 1.13 * day) * (1 - 0.22 * warm) - sun.intensity) * k;
    }
    if (this._hemi) {
      _lc.copy(P.hemiSkyNight).lerp(P.hemiSkyDay, day);
      this._hemi.color.lerp(_lc, k);
      _lc.copy(P.hemiGndNight).lerp(P.hemiGndDay, day);
      this._hemi.groundColor.lerp(_lc, k);
      // 0.50 floor: a snowfield at midnight still has to be walkable
      this._hemi.intensity += (0.5 + 0.65 * day - this._hemi.intensity) * k;
    }
    if (this._amb) {
      _lc.copy(P.ambNight).lerp(P.ambDay, day);
      this._amb.color.lerp(_lc, k);
      this._amb.intensity += (0.24 + 0.08 * day - this._amb.intensity) * k;
    }

    // the dome's painted glow, the disc and its halo all follow the same bearing
    if (sun && this._skyMesh) {
      _lv.copy(sun.position).normalize();
      this._skyMesh.rotation.y = Math.atan2(-_lv.z, _lv.x);
      if (this._sunDisc) {
        this._sunDisc.position.copy(_lv).multiplyScalar(96);
        this._sunDisc.lookAt(0, 8, 0);
      }
      if (this._halo) {
        this._halo.position.copy(_lv).multiplyScalar(94.6);
        this._halo.lookAt(0, 8, 0);
      }
    }
    if (this._sunDiscMat) {
      _lc.copy(P.discNight).lerp(P.discDay, day);
      this._sunDiscMat.color.lerp(_lc, k);
    }
    if (this._haloMat) this._haloMat.opacity += (0.35 + 0.65 * day - this._haloMat.opacity) * k;

    // lamps: one night target, four lags, so the peak lights up in a ripple
    const lampWant = 1 + 0.5 * night;
    for (let i = 0; i < this._lampK.length; i++) {
      this._lampK[i] += (lampWant - this._lampK[i]) * Math.min(1, dt / this._lampLag[i]);
    }

    // snowfall: intensity 0..2 scales how much of the pool falls, and how hard
    const step = 0.5 * dt;
    this._snowNow += Math.max(-step, Math.min(step, this._snowWant - this._snowNow));
    this._snowShown = SNOW_N * Math.min(1, 0.08 + 0.46 * this._snowNow);
    this._snow?.geo.setDrawRange(0, Math.max(0, Math.round(this._snowShown)));
    this._snowSpeedK += (0.75 + 0.35 * this._snowNow - this._snowSpeedK) * Math.min(1, dt * 1.5);
  }

  /** Curtains: on only while the server says aurora AND it is properly night. */
  _updateAurora(dt, t) {
    const a = this._aur;
    if (!a) return;
    const want = this._auroraOn && this._hasClock
      ? Math.min(1, Math.max(0, (this._nightK - 0.35) / 0.45))
      : 0;
    this._auroraK += (want - this._auroraK) * Math.min(1, dt * 0.5); // ~2s either way
    if (this._auroraK < 0.012) {
      if (a.mesh.visible) { a.mesh.visible = false; a.mat.opacity = 0; }
      return;
    }
    a.mesh.visible = true;
    // subtle, not a rave: the bands breathe between roughly a third and a half
    a.mat.opacity = this._auroraK * (0.4 + 0.1 * Math.sin(t * 0.31) + 0.05 * Math.sin(t * 0.77 + 1.4));
    const arr = a.attr.array;
    const base = a.base;
    for (let i = 0; i < arr.length; i += 3) {
      const p = base[i] * 0.075 + base[i + 2] * 0.055;
      arr[i + 1] = base[i + 1] + Math.sin(p + t * 0.5) * 1.9 + Math.sin(p * 2.4 - t * 0.29) * 0.85;
    }
    a.attr.needsUpdate = true;
  }

  /* --- snowballs: aiming and input ---------------------------------------- */

  _setRay(e) {
    const cam = this._game?.engine?.camera;
    if (!cam) return false;
    _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this._ray.setFromCamera(_ndc, cam);
    return true;
  }

  /**
   * Where the pointer meets the snow. Solved against terrainH() instead of
   * raycasting the ground mesh, because this runs on every pointermove while
   * aiming and that mesh is 6.7k triangles: two iterations land within a
   * couple of centimetres of it (the mesh IS terrainH, sampled on a grid).
   */
  _groundPoint(out) {
    const o = this._ray.ray.origin;
    const d = this._ray.ray.direction;
    if (d.y > -1e-3) return false; // aimed at the sky
    let y = this._game?.engine?.playerAvatar?.group?.position.y ?? 0;
    let x = 0;
    let z = 0;
    for (let i = 0; i < 2; i++) {
      const k = (y - o.y) / d.y;
      x = o.x + d.x * k;
      z = o.z + d.z * k;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      y = terrainH(x, z);
    }
    if (Math.abs(x) > GROUND_HALF || Math.abs(z) > GROUND_HALF) return false;
    out.set(x, y, z);
    return true;
  }

  /**
   * The browser menu would land on top of the aim (and on Windows it pops on
   * the very release that throws), so it is suppressed over the world canvas
   * and while a throw is charging. Anywhere else - the HUD, the chat box, a
   * name tag - right-click keeps its normal menu, and once this room is
   * disposed the listener goes with it.
   */
  _contextMenu(e) {
    const engine = this._game?.engine;
    if (this._aim || (engine?.canvas && e.target === engine.canvas)) e.preventDefault();
  }

  _pointerDown(e) {
    // RIGHT button only: the left button walks, and this room never touches it.
    if (e.button !== 2 || this._aim) return;
    const game = this._game;
    const engine = game?.engine;
    if (!engine || engine.paused || game.activeMinigame) return;
    if (e.target !== engine.canvas) return;   // a HUD or prompt click: not ours
    if (this._cool > 0) return;               // still packing the last one
    if (this._localSlot !== null) return;     // seated in the race lineup
    if (!this._setRay(e)) return;
    if (!this._groundPoint(_aimV)) return;
    this._aim = { t: 0, x: _aimV.x, z: _aimV.z, cx: _aimV.x, cz: _aimV.z };
    // A release before the first update() must still throw somewhere sane, so
    // the landing point is clamped into range now, at zero power.
    this._clampAim(this._aim, 0);
    engine.controller?.stop?.(); // plant your feet to throw
  }

  _pointerMove(e) {
    if (!this._aim) return;
    // The button came up somewhere we never heard about (the window lost the
    // pointer, another listener ate the event): the first buttonless move is
    // the release, rather than leaving the capybara wound up forever.
    if (e.buttons !== undefined && !(e.buttons & 2)) { this._release(); return; }
    if (!this._setRay(e)) return;
    if (this._groundPoint(_aimV)) {
      this._aim.x = _aimV.x;
      this._aim.z = _aimV.z;
    }
  }

  _pointerUp(e) {
    if (!this._aim) return;
    if (e && e.button !== undefined && e.button !== 2) return; // a left click, mid-aim
    this._release();
  }

  /** Let the wound-up throw go. */
  _release() {
    const a = this._aim;
    if (!a) return;
    this._cancelAim();
    this._throw(a.cx, a.cz);
  }

  _cancelAim() {
    this._aim = null;
    if (this._aimBeads) this._aimBeads.count = 0;
    if (this._aimRing) this._aimRing.visible = false;
  }

  /**
   * Pull the aim point into throwing range for a given power (0..1): hold
   * longer, throw further. Aiming at your own feet throws where you look.
   */
  _clampAim(a, pow) {
    const avatar = this._game?.engine?.playerAvatar;
    const p = avatar?.group?.position;
    if (!p) return;
    let dx = a.x - p.x;
    let dz = a.z - p.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-3) {
      dx = Math.sin(avatar.group.rotation.y);
      dz = Math.cos(avatar.group.rotation.y);
      d = 1;
    }
    const range = SNOW_RANGE_MIN + (SNOW_RANGE_MAX - SNOW_RANGE_MIN) * pow;
    const s = Math.min(1, range / d);
    a.cx = Math.max(-GROUND_HALF, Math.min(GROUND_HALF, p.x + dx * s));
    a.cz = Math.max(-GROUND_HALF, Math.min(GROUND_HALF, p.z + dz * s));
  }

  /** Let go: fly it locally at once, and tell the room. */
  _throw(x, z) {
    const game = this._game;
    const p = game?.engine?.playerAvatar?.group?.position;
    if (!p) return;
    this._cool = SNOW_COOLDOWN;
    this._launch(p.x, p.y, p.z, x, z);
    // Never wait on the round trip for your own throw; the echo of this frame
    // is dropped in _onSnowFrame. The local cooldown is a beat longer than the
    // server's 1/s, so a throw that flew here is a throw everyone else saw.
    game.net?.send?.({ t: 'snow', to: [Math.round(x * 100) / 100, Math.round(z * 100) / 100] });
    game.audio?.play?.('whoosh');
    this._hintT = -1;
    _hintShown = true; // they found the toy; no need to nag next visit
  }

  /** Server relay: somebody else's snowball, on the same arc they are watching. */
  _onSnowFrame(m) {
    const to = m?.to;
    let tx = NaN;
    let tz = NaN;
    if (Array.isArray(to)) { tx = Number(to[0]); tz = Number(to[1]); }
    else if (to && typeof to === 'object') { tx = Number(to.x); tz = Number(to.z); }
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
    tx = Math.max(-GROUND_HALF, Math.min(GROUND_HALF, tx));
    tz = Math.max(-GROUND_HALF, Math.min(GROUND_HALF, tz));

    // `from` is the sender: an id to look up, or a launch point if the server
    // relays coordinates instead. Both shapes are handled; neither is required.
    const from = m.from ?? m.id ?? m.by ?? null;
    let ox = NaN;
    let oy = 0;
    let oz = NaN;
    if (Array.isArray(from) && from.length >= 2) {
      ox = Number(from[0]);
      oz = Number(from[from.length - 1]);
      oy = from.length > 2 ? Number(from[1]) : terrainH(ox, oz);
    } else if (from && typeof from === 'object') {
      ox = Number(from.x);
      oz = Number(from.z);
      oy = Number.isFinite(Number(from.y)) ? Number(from.y) : terrainH(ox, oz);
    } else if (from !== null && from !== undefined) {
      const self = this._game?.net?.selfId ?? null;
      if (self !== null && from === self) return; // our own throw already flew
      const g = this._game?.net?.remotes?.get?.(from)?.avatar?.group
        || this._riders.get(from)?.avatar?.group;
      if (g) { ox = g.position.x; oy = g.position.y; oz = g.position.z; }
    }
    if (!Number.isFinite(ox) || !Number.isFinite(oz)) {
      // thrower already gone (or unnamed): land it anyway, so the puff and the
      // boop still happen where everyone else in the room saw them happen
      this._impact(tx, terrainH(tx, tz) + 0.12, tz);
      return;
    }
    this._launch(ox, oy, oz, tx, tz);
  }

  _launch(ox, oy, oz, tx, tz) {
    if (!this._balls) return;
    const dist = Math.hypot(tx - ox, tz - oz);
    if (this._balls.length >= SNOW_MAX_BALLS) this._balls.shift();
    this._balls.push({
      ox, oy: oy + 1.2, oz,                    // leaves at about shoulder height
      tx, ty: terrainH(tx, tz) + 0.12, tz,
      t: 0, dur: flightTime(dist), h: arcHeight(dist),
      spin: 6 + Math.random() * 6,
    });
  }

  _updateBalls(dt) {
    const mesh = this._ballMesh;
    const list = this._balls;
    if (!mesh || !list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.t += dt;
      if (b.t >= b.dur) {
        list.splice(i, 1);
        this._impact(b.tx, b.ty, b.tz);
      }
    }
    const d = this._dummy;
    let n = 0;
    for (let i = 0; i < list.length && n < SNOW_MAX_BALLS; i++) {
      const b = list[i];
      arcPoint(b, b.t / b.dur, _aimV);
      d.position.copy(_aimV);
      d.rotation.set(b.t * b.spin, b.t * b.spin * 0.7, 0);
      d.updateMatrix();
      mesh.setMatrixAt(n++, d.matrix);
    }
    d.rotation.set(0, 0, 0);
    if (n || mesh.count) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Landing: a puff of snow, and a boop for anyone standing in it. */
  _impact(x, y, z) {
    const game = this._game;
    const list = this._hitPuffs;
    if (list) {
      for (let i = 0; i < 12; i++) {
        if (list.length >= SNOW_PUFFS) list.shift();
        const a = Math.random() * TAU;
        const sp = 0.7 + Math.random() * 2.2;
        list.push({
          x, y: y + 0.06, z,
          vx: Math.cos(a) * sp, vy: 1.5 + Math.random() * 2.4, vz: Math.sin(a) * sp,
          t: 0, life: 0.45 + Math.random() * 0.4, size: 0.5 + Math.random() * 0.9,
        });
      }
    }
    game?.audio?.play?.('pop');
    let hit = false;
    this._forEachCapy((avatar, pos) => {
      if (Math.hypot(pos.x - x, pos.z - z) > SNOW_HIT_R) return;
      hit = true;
      this._boop(avatar);
    });
    // the 'boop': audio.js has no cue by that name, and it is not our file, so
    // the softest body-thump it does have stands in
    if (hit) game?.audio?.play?.('thud');
  }

  /** Every capybara standing in this room: the player, remotes, seated riders. */
  _forEachCapy(fn) {
    const game = this._game;
    const mine = game?.engine?.playerAvatar;
    if (mine?.group) fn(mine, mine.group.position);
    const remotes = game?.net?.remotes;
    if (remotes) {
      for (const [, r] of remotes) {
        // a remote parked offscreen is one of ours, seated in a sled below
        if (r?.avatar?.group?.parent) fn(r.avatar, r.avatar.group.position);
      }
    }
    if (this._riders) {
      for (const r of this._riders.values()) fn(r.avatar, r.avatar.group.position);
    }
  }

  /**
   * Booped: a wobble and a snowcap, no damage and no score. The wobble rides on
   * the avatar's ROOT group (rotation x/z and scale), which is the one part of
   * the rig neither avatar.update() nor the net client's interpolation rewrites
   * every frame - a wobble on the body would be wiped for remotes.
   */
  _boop(avatar) {
    if (!avatar?.group || !this._booped) return;
    let w = null;
    for (const b of this._booped) if (b.avatar === avatar) { w = b; break; }
    if (w) w.t = 0;
    else this._booped.push({ avatar, t: 0 });
    this._capOn(avatar);
  }

  _updateBoops(dt) {
    const list = this._booped;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      const g = b.avatar?.group;
      b.t += dt;
      if (!g) { list.splice(i, 1); continue; }
      if (b.t >= BOOP_DUR) {
        g.rotation.x = 0;
        g.rotation.z = 0;
        g.scale.set(1, 1, 1);
        list.splice(i, 1);
        continue;
      }
      const damp = Math.exp(-b.t * 4.2) * (1 - b.t / BOOP_DUR);
      g.rotation.z = Math.sin(b.t * 26) * 0.24 * damp;
      g.rotation.x = Math.sin(b.t * 21 + 1) * 0.14 * damp;
      const sq = Math.sin(b.t * 22) * 0.1 * damp;
      g.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
    }
  }

  _capOn(avatar) {
    const head = avatar?.headG;
    if (!head || !this._capGeo) return;
    for (const c of this._caps) if (c.avatar === avatar) { c.t = 0; return; } // refresh, never stack
    const m = new THREE.Mesh(this._capGeo, makeToon(0xffffff, VC));
    m.position.set(0, 0.16, 0.02);
    m.rotation.set(-0.1, Math.random() * TAU, 0.08);
    m.scale.setScalar(0.2);
    head.add(m);
    this._caps.push({ mesh: m, avatar, t: 0 });
  }

  _updateCaps(dt) {
    const list = this._caps;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      c.t += dt;
      const m = c.mesh;
      if (c.t >= CAP_LIFE || !m.parent) {
        m.parent?.remove(m);
        list.splice(i, 1);
        continue;
      }
      const pop = Math.min(1, c.t / 0.22);
      const melt = Math.max(0, (c.t - (CAP_LIFE - 0.7)) / 0.7);
      const s = Math.max(0.001, (0.25 + 0.75 * pop) * (1 + Math.sin(pop * Math.PI) * 0.22) * (1 - melt));
      m.scale.set(s, Math.max(0.001, s * (1 - melt * 0.55)), s);
      m.position.y = 0.16 - melt * 0.12; // it slumps off as it goes
    }
  }

  _updateHitPuffs(dt) {
    const mesh = this._hitPuffMesh;
    const list = this._hitPuffs;
    if (!mesh || !list) return;
    const drag = Math.max(0, 1 - 3 * dt);
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.t += dt;
      if (p.t >= p.life) { list.splice(i, 1); continue; }
      p.vy -= 9 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= drag;
      p.vz *= drag;
    }
    const d = this._dummy;
    let n = 0;
    for (let i = 0; i < list.length && n < SNOW_PUFFS; i++) {
      const p = list[i];
      const u = p.t / p.life;
      d.position.set(p.x, p.y, p.z);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(Math.max(0.001, p.size * (1 - u * u)));
      d.updateMatrix();
      mesh.setMatrixAt(n++, d.matrix);
    }
    d.scale.setScalar(1);
    if (n || mesh.count) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The aim preview: beads along the arc your throw would take, plus a ring. */
  _updateAim(dt, t) {
    if (this._cool > 0) this._cool = Math.max(0, this._cool - dt);
    const a = this._aim;
    const beads = this._aimBeads;
    const ring = this._aimRing;
    if (!a) {
      if (beads?.count) beads.count = 0;
      if (ring?.visible) ring.visible = false;
      return;
    }
    const engine = this._game?.engine;
    const avatar = engine?.playerAvatar;
    const p = avatar?.group?.position;
    if (!p || !beads || !ring) return;
    a.t += dt;
    const pow = Math.min(1, a.t / SNOW_HOLD_CAP);

    // power caps the range: hold longer, throw further
    this._clampAim(a, pow);

    // Plant, face the throw and wind up. avatar.update() has already rebuilt
    // its rest pose this frame (the engine runs it before room.update), so the
    // lean written here paints on top instead of being wiped.
    const yaw = Math.atan2(a.cx - p.x, a.cz - p.z);
    const g = avatar.group;
    const delta = ((((yaw - g.rotation.y) % TAU) + Math.PI * 3) % TAU) - Math.PI;
    g.rotation.y += delta * Math.min(1, dt * 12);
    avatar.body.rotation.x = -0.1 - 0.2 * pow;
    avatar.body.rotation.y = -0.3 * pow;

    // the preview is the flight: same endpoints, same apex, same curve
    _pv.ox = p.x; _pv.oy = p.y + 1.2; _pv.oz = p.z;
    _pv.tx = a.cx; _pv.tz = a.cz;
    _pv.ty = terrainH(a.cx, a.cz) + 0.12;
    _pv.h = arcHeight(Math.hypot(a.cx - p.x, a.cz - p.z));

    const dmy = this._dummy;
    for (let i = 0; i < AIM_BEADS; i++) {
      const u = (i + 1) / (AIM_BEADS + 1);
      arcPoint(_pv, u, _aimV);
      dmy.position.copy(_aimV);
      dmy.rotation.set(0, 0, 0);
      dmy.scale.setScalar((0.5 + 0.9 * pow) * (1 - u * 0.3) * (0.88 + 0.24 * Math.sin(t * 9 - i * 0.7)));
      dmy.updateMatrix();
      beads.setMatrixAt(i, dmy.matrix);
    }
    dmy.scale.setScalar(1);
    beads.count = AIM_BEADS;
    beads.instanceMatrix.needsUpdate = true;

    ring.visible = true;
    ring.position.set(a.cx, _pv.ty + 0.02, a.cz);
    const rs = (0.8 + 0.5 * pow) * (1 + Math.sin(t * 7) * 0.05);
    ring.scale.set(rs, rs, rs);

    // A pointer released outside the window never reports back, and a stuck aim
    // would leave the capybara wound up forever: four seconds is three past the
    // power cap, so let it fly.
    if (a.t > 4) this._release();
  }

  /* --- race lobby, per frame ---------------------------------------------- */

  _updateLobby(dt, t) {
    // seated riders keep breathing (nothing organic is ever perfectly still)
    for (const r of this._riders.values()) r.avatar.update(dt);

    // A 'lobby' frame can beat the 'pjoin' that introduces the same capybara,
    // so a rider may start out brown and un-deduplicated. Catch up twice a
    // second: cheap, and it means the seat always ends up wearing their hat.
    this._reconcileT += dt;
    if (this._reconcileT > 0.5) {
      this._reconcileT = 0;
      if (this._riders.size) this._reconcileRiders();
    }

    // the board bobs, and pulses once two of the three seats are taken
    const sign = this._ridersSign;
    if (sign) {
      sign.position.y = this._signBaseY + Math.sin(t * 1.3) * 0.09;
      sign.rotation.z = Math.sin(t * 0.9) * 0.015;
      const eager = this._lobbyCount === 2 || this._lobbyStarting;
      const s = eager ? 1 + Math.abs(Math.sin(t * 4.2)) * 0.09 : 1;
      sign.scale.set(s, s, s);
    }

    // keep the local capybara settled in their sled while they wait
    const engine = this._game?.engine;
    const avatar = engine?.playerAvatar;
    if (this._localSlot !== null && avatar) {
      const slot = RACE_SLOTS[this._localSlot];
      const g = avatar.group;
      const walking = !!engine.controller?.target;
      if (slot && !walking && Math.hypot(g.position.x - slot.x, g.position.z - slot.z) < 0.55) {
        if (avatar.state.anim !== 'sit') avatar.setAnim('sit');
        g.position.y = SEAT_LIFT;
        const d = ((((SLOT_YAW - g.rotation.y) % TAU) + Math.PI * 3) % TAU) - Math.PI;
        g.rotation.y += d * Math.min(1, dt * 6);
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
    // Input first: these live on window, and a press landing between here and
    // the next room's build would have nothing left to aim with.
    removeEventListener('pointerdown', this._onDown, true);
    removeEventListener('pointermove', this._onMove, true);
    removeEventListener('pointerup', this._onUp, true);
    removeEventListener('pointercancel', this._onCancel, true);
    removeEventListener('blur', this._onCancel);
    // ...and the browser's own right-click menu is handed back to the page
    removeEventListener('contextmenu', this._onContext, true);
    this._onDown = this._onMove = this._onUp = this._onCancel = null;
    this._onContext = null;
    this._aim = null;

    // The player's avatar (and the remotes') outlive this room, so anything we
    // hung on them or bent out of shape has to be put back before we go.
    for (const c of this._caps || []) c.mesh.parent?.remove(c.mesh);
    for (const b of this._booped || []) {
      const g = b.avatar?.group;
      if (!g) continue;
      g.rotation.x = 0;
      g.rotation.z = 0;
      g.scale.set(1, 1, 1);
    }
    this._caps = null;
    this._booped = null;
    // shared-flagged so the avatar/scene sweeps skip it: ours to free
    this._capGeo?.dispose();
    this._capGeo = null;
    this._balls = null;
    this._hitPuffs = null;
    this._ballMesh = null;
    this._hitPuffMesh = null;
    this._aimBeads = null;
    this._aimRing = null;
    this._aur = null;
    this._sun = null;
    this._hemi = null;
    this._amb = null;
    this._skyMesh = null;
    this._skyMat = null;
    this._sunDisc = null;
    this._sunDiscMat = null;
    this._haloMat = null;
    this._bgColor = null;
    this._fog = null;
    this._offSnow?.();
    this._offSnow = null;

    // Walking out of the room while seated must not leave a ghost holding one of
    // the three slots. Harmless if the server already dropped us on room change.
    if (this._localSlot !== null && this._game?.net?.connected) {
      this._game.net.send({ t: 'lobby-leave' });
    }
    // riders next: they hold engine-owned name tags and may be sitting on top
    // of networked avatars we un-parented, which have to go back in the room
    for (const id of [...this._riders.keys()]) this._removeRider(id);
    this._riders.clear();
    this._offLobby?.();
    this._offRaceStart?.();
    this._offLobby = null;
    this._offRaceStart = null;
    this._localSlot = null;
    this._riderGroup = null;
    this._ridersSign = null;
    this._ridersTex = null; // the sign material is unique; disposeObject frees it
    this._joinSpot = null;
    this._game = null;
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
    this._doorLight = null;
    this._doorGlowMat = null;
    this._trailGlowMat = null;
    this._denLampMat = null;
    this._denLight = null;
    this._mineLampMat = null;
    this._mineLight = null;
    this._mineGlowMat = null;
    this._minePathGlowMat = null;
    this._halo = null;
  }
}
