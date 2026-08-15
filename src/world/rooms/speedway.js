import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';
import { getOverrides } from '../layout.js';

/* ---------------------------------------------------------------------------
 * Capy Speedway: a sun-bleached beachside circuit on the cove's south shore,
 * run like a village fete that happens to own a racetrack. Bunting, deck
 * chairs, a snack cart, a grandstand full of capybaras, gulls, and one very
 * large jumbotron.
 *
 * THE ROOM IS THE PADDOCK ONLY (docs/KARTS.md section 1). The circuit itself
 * lives entirely inside src/minigames/games/kart.js and is never built here;
 * all this room shows of it is one decorative stretch of the main straight
 * along the north edge, behind the pit wall. Nothing north of z = -10 is
 * walkable, because nothing north of z = -10 is in groundMeshes.
 *
 * Race lobby (protocol in docs/KARTS.md section 4, relayed by
 * src/net/client.js):
 *   out  {t:'kart-join'} {t:'kart-leave'}
 *   in   'kart-lobby' {players:[{id,name,color,hat}], starting, startsAt, max}
 *        'kart-grid'   the six-slot grid, ~1.2s before the lights
 *        'kart-resume' a reconnect landing back into a live race
 *        'kart-board'  2 Hz standings for the jumbotron (spectators too)
 * On 'kart-grid' we stash game.__kartCtx and launch the kart minigame, exactly
 * the way the peak stashes __raceCtx for the sled; a solo/practice run launches
 * with game.__kartCtx = null.
 *
 * Everything is procedural: primitives, merged geometry, vertex tints and
 * canvas textures. One draw call per instanced family (see DESIGN.md budget).
 * ------------------------------------------------------------------------- */

const TAU = Math.PI * 2;

// shared/constants.js gains this entry when the orchestrator registers the room
// (docs/KARTS.md section 8); the literal keeps a pre-registration build honest.
const BZ = BOT_ZONES.speedway || { x: 0, z: 3, r: 4.5 };

/* --- palette (DESIGN.md anchors + the two speedway-only greys) ------------ */
const C = {
  sand: 0xf0dca0,
  sandLit: 0xfae7b8,
  sandDark: 0xd9c084,
  sandWet: 0xc9ab78,
  path: 0xf7e7bc,
  grass: 0x9dbd6e,
  grassDark: 0x7ba554,
  leaf: 0x7ac74f,
  leafDark: 0x53953a,
  asphalt: 0x5b5568,
  asphaltLit: 0x6d667c,
  asphaltDark: 0x4a4557,
  rubber: 0x413d4d,
  line: 0xfff6e3,
  cream: 0xfff6e3,
  creamShade: 0xe9d9bb,
  coral: 0xe8657a,
  coralDark: 0xc44a60,
  sky: 0x4fb3e8,
  skyDeep: 0x2b7fb8,
  gold: 0xf2b64a,
  goldDark: 0xc9913a,
  wood: 0x9a6640,
  woodDark: 0x5f3f28,
  woodLit: 0xc08d5c,
  fur: 0xb08a5a,
  furDark: 0x6b4f35,
  ink: 0x2d2417,
  tyre: 0x3a3742,
  steel: 0x93a1b2,
  steelDark: 0x6a7686,
  sea: 0x4fb3e8,
  seaDeep: 0x2b7fb8,
  foam: 0xf2fbff,
  rock: 0x9a8f86,
  rockDark: 0x6e655e,
};

/* --- the frozen box (docs/KARTS.md section 1) ------------------------------
 * Walkable x in [-17, 17], z in [-10, 16]. The paddock ground mesh IS that
 * rectangle and nothing else is in groundMeshes, so the walk controller's
 * "off the ground -> stop" rule is the barrier: no amount of collider tuning
 * can put a visitor on the racing surface.
 */
const PAD = { x0: -17, x1: 17, z0: -10, z1: 16 };
const PAD_W = PAD.x1 - PAD.x0;
const PAD_D = PAD.z1 - PAD.z0;
const PAD_CX = (PAD.x0 + PAD.x1) / 2;
const PAD_CZ = (PAD.z0 + PAD.z1) / 2;

// The decorative main straight: 9 deep, centred z = -13, x -22..22. Its top
// sits a hair BELOW the paddock so the 1.5 units of tarmac that reach south of
// the walkable edge slide under the sand instead of z-fighting with it.
const TRK = { x0: -22, x1: 22, z0: -17.5, z1: -8.5, y: -0.03 };
const WALL_Z = -10.6;          // pit wall centreline: the obstacle line
const WALL_X = 18;             // tyre stacks run x -18..18 every 3 units
const WALL_H = 0.95;
const FIN_Z = -12.4;           // start/finish line, under the gantry
const GANTRY_X = 7.5;          // tower centres, straddling the straight

// The jumbotron: 9 x 5, hung on the gantry, facing SOUTH into the paddock.
const JUMBO = { x: 0, y: 6.2, z: -12.4, w: 9, h: 5 };

// The grandstand, angled so the crowd faces the start line to the north-east
// and still shows its face to the play camera looking north.
const STAND = { x: -13.2, z: -4.6, yaw: -0.55, rows: 7 };

/* --- hotspot + landmark table (dev layout editor, Ctrl+E) -----------------
 * Every draggable number in this room, in one place. `build()` folds any
 * published/session handle overrides on top before reading it, so a designer
 * drags a pin, the room rebuilds, and the sign post, prompt zone, glow ring
 * and collider derived from that number all move together (the lounge's
 * STATIONS pattern). The shipped values are the frozen contract numbers.
 */
const SPOTS = [
  { id: 'race-join', at: [0, -7.2], r: 3.0 },
  { id: 'play-kart', at: [5.6, -6.2], r: 2.6 },
  { id: 'records', at: [-6.4, -6.2], r: 2.2 },
  { id: 'exit-plaza', at: [0, 13], r: 3.0 },
  { id: 'jumbotron', at: [JUMBO.x, JUMBO.z], y: JUMBO.y },
  { id: 'grandstand', at: [STAND.x, STAND.z], yaw: STAND.yaw },
  { id: 'snack-cart', at: [11.9, -2.2], yaw: -0.62 },
];
const SPOT_BY_ID = new Map(SPOTS.map((s) => [s.id, s]));
const SPOTS_BASE = SPOTS.map((s) => ({ at: s.at.slice(), y: s.y, yaw: s.yaw, r: s.r }));

/** Fold dev-editor overrides into SPOTS before a build reads them. */
function applySpotOverrides() {
  const ov = getOverrides('speedway');
  SPOTS.forEach((s, i) => {
    const base = SPOTS_BASE[i];
    const p = ov?.get(s.id) || null;
    s.at = (p?.at || base.at).slice();
    s.y = p?.y !== undefined ? p.y : base.y;
    s.yaw = p?.yaw !== undefined ? p.yaw : base.yaw;
    s.r = p?.r !== undefined ? p.r : base.r;
  });
}

const spotAt = (id) => SPOT_BY_ID.get(id).at;
const spotR = (id) => SPOT_BY_ID.get(id).r;

/* --- AI/idle roster copy --------------------------------------------------- */
// Purely cosmetic: what the jumbotron shows when no race is running. Real
// rosters arrive on 'kart-lobby'; these are the fete's own regulars.
const IDLE_TICKER = [
  'NEXT RACE  ·  sign on at the pit wall',
  'SIX KARTS  ·  THREE LAPS  ·  ONE VERY SMUG CAPYBARA',
  'MIND THE MELON PEEL',
  'FREE PRACTICE LAPS ALL DAY',
];

/* --- tiny math ------------------------------------------------------------- */

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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, u) => a + (b - a) * u;

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Distance from (x,z) to the segment (ax,az)-(bx,bz). Used for worn paths. */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = dx * dx + dz * dz;
  let t = len > 1e-6 ? ((x - ax) * dx + (z - az) * dz) / len : 0;
  t = clamp01(t);
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** Push a point out of the guaranteed-flat, prop-free bot circle. */
function outOfZone(x, z, clear = 0.8) {
  const dx = x - BZ.x;
  const dz = z - BZ.z;
  const d = Math.hypot(dx, dz) || 1e-4;
  const need = BZ.r + clear;
  if (d >= need) return { x, z };
  return { x: BZ.x + (dx / d) * need, z: BZ.z + (dz / d) * need };
}

/* --- geometry assembly (the peak's kit, verbatim in shape) ----------------- */

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

/** A cylinder strung between two points (cables, bunting cords, rails). */
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

function solidMesh(parts, { shadow = true, receive = true } = {}) {
  const m = new THREE.Mesh(mergeParts(parts), makeToon(0xffffff, VC));
  m.castShadow = shadow;
  m.receiveShadow = receive;
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

/** Unique unlit material carrying a canvas texture (screens, lit signs). */
function screenMat(tex, { transparent = false } = {}) {
  const m = makeGlow(0xffffff, { unique: true });
  m.map = tex;
  if (transparent) { m.transparent = true; m.alphaTest = 0.02; }
  m.needsUpdate = true;
  return m;
}

/* --- canvas textures ------------------------------------------------------ */

function skyTexture() {
  return canvasTexture(512, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0.0, '#2f8fd0');
    g.addColorStop(0.26, '#6fbde8');
    g.addColorStop(0.46, '#aedcf3');
    g.addColorStop(0.58, '#e4f2f6');
    g.addColorStop(0.68, '#fdeccb');
    g.addColorStop(0.82, '#dfeef4');
    g.addColorStop(1.0, '#bfdff0');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    // fat cotton-wool clouds: chunky, low-poly-adjacent, never wispy
    c.globalAlpha = 0.85;
    c.fillStyle = '#fffaf0';
    for (let i = 0; i < 16; i++) {
      const x = 28 + ((i * 113) % (w - 56));
      const y = 26 + ((i * 61) % 74);
      const r = 12 + (i % 4) * 6;
      for (let k = 0; k < 4; k++) {
        c.beginPath();
        c.ellipse(x + k * r * 0.72, y + ((k % 2) ? 5 : 0), r * (1 - k * 0.14), r * 0.6, 0, 0, TAU);
        c.fill();
      }
    }
    c.globalAlpha = 1;
  });
}

/** Soft round dot: rain drops, sparkles, sun halo. */
function dotTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  return canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2 - 1);
    g.addColorStop(0, inner);
    g.addColorStop(0.45, inner);
    g.addColorStop(1, outer);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** The scalloped surf line that rides the beach berm north of the circuit. */
function foamTexture() {
  return canvasTexture(512, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.92)';
    for (let i = 0; i < 26; i++) {
      const x = (i / 26) * w + 8;
      const r = 16 + ((i * 37) % 13);
      c.beginPath();
      c.ellipse(x, h * 0.55 + ((i % 3) - 1) * 7, r, r * 0.42, 0, 0, TAU);
      c.fill();
    }
    c.fillStyle = 'rgba(242,251,255,0.55)';
    c.fillRect(0, h * 0.62, w, h * 0.38);
  });
}

/**
 * THE JUMBOTRON. 9 x 5 board on the start gantry, repainted into ONE canvas
 * whenever a 'kart-board' frame lands (2 Hz) or the idle ticker turns over, so
 * the room owns exactly one texture no matter how many races run.
 *
 * `s` is the whole board state:
 *   { live, title, lap, laps, rows:[{s,n,lap,q,ai,place}], over,
 *     roster:[{name,color}], starting, tick }
 */
function drawBoard(c, w, h, s) {
  // cabinet
  c.fillStyle = '#12101c';
  c.fillRect(0, 0, w, h);
  const glowG = c.createLinearGradient(0, 0, 0, h);
  glowG.addColorStop(0, 'rgba(79,179,232,0.20)');
  glowG.addColorStop(0.5, 'rgba(20,18,32,0.0)');
  glowG.addColorStop(1, 'rgba(232,101,122,0.14)');
  c.fillStyle = glowG;
  c.fillRect(0, 0, w, h);

  // header band
  const HDR = 62;
  c.fillStyle = s.live ? '#e8657a' : '#f2b64a';
  c.fillRect(0, 0, w, HDR);
  c.fillStyle = 'rgba(255,255,255,0.18)';
  c.fillRect(0, 0, w, 10);
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillStyle = '#2d2417';
  c.font = '900 40px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(s.title || 'CAPY SPEEDWAY', 22, HDR / 2 + 2);

  c.textAlign = 'right';
  if (s.live) {
    c.fillStyle = '#fff6e3';
    c.font = '900 40px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(s.over ? 'FINISHED' : `LAP ${Math.max(1, s.lap)}/${s.laps || 3}`, w - 22, HDR / 2 + 2);
  } else {
    c.fillStyle = '#2d2417';
    c.font = '900 36px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(`${s.roster.length}/6 SIGNED ON`, w - 22, HDR / 2 + 2);
  }

  if (s.live) {
    // six standings rows: P1  Nibbles  L2, AI dimmed
    const top = HDR + 14;
    const rowH = (h - top - 16) / 6;
    for (let i = 0; i < 6; i++) {
      const r = s.rows[i];
      const y = top + i * rowH;
      c.fillStyle = i % 2 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.09)';
      c.fillRect(14, y, w - 28, rowH - 5);
      if (!r) continue;
      const dim = r.ai;
      c.textAlign = 'left';
      c.fillStyle = dim ? '#8d8aa2' : '#f2b64a';
      c.font = '900 33px system-ui, "Segoe UI", Verdana, sans-serif';
      c.fillText(`P${r.place}`, 28, y + rowH / 2 - 2);
      c.fillStyle = dim ? '#9c99b0' : '#fff6e3';
      c.font = `${dim ? 700 : 800} 32px system-ui, "Segoe UI", Verdana, sans-serif`;
      c.fillText(String(r.n || 'Capybara').slice(0, 14), 96, y + rowH / 2 - 2);
      // lap pill
      c.textAlign = 'right';
      c.fillStyle = dim ? '#6f6c84' : '#4fb3e8';
      c.font = '800 30px system-ui, "Segoe UI", Verdana, sans-serif';
      c.fillText(`L${Math.min(s.laps || 3, (r.lap || 0) + 1)}`, w - 34, y + rowH / 2 - 2);
      // progress bar for the lap in hand
      const bx = w - 250;
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(bx, y + rowH / 2 + 14, 170, 7);
      c.fillStyle = dim ? '#5d5a70' : '#7ac74f';
      c.fillRect(bx, y + rowH / 2 + 14, 170 * clamp01(r.q || 0), 7);
    }
    return;
  }

  // idle: the ticker over the sign-on sheet
  c.textAlign = 'center';
  c.fillStyle = '#fff6e3';
  c.font = '900 54px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(IDLE_TICKER[s.tick % IDLE_TICKER.length], w / 2, HDR + 62);

  const cols = 3;
  const cw = (w - 60) / cols;
  for (let i = 0; i < 6; i++) {
    const p = s.roster[i];
    const cx = 30 + (i % cols) * cw;
    const cy = HDR + 118 + Math.floor(i / cols) * 78;
    c.fillStyle = p ? 'rgba(122,199,79,0.18)' : 'rgba(255,255,255,0.06)';
    c.fillRect(cx, cy, cw - 16, 62);
    c.beginPath();
    c.arc(cx + 34, cy + 31, 20, 0, TAU);
    c.fillStyle = p ? `#${(p.color >>> 0).toString(16).padStart(6, '0')}` : '#3a3748';
    c.fill();
    c.textAlign = 'left';
    c.fillStyle = p ? '#fff6e3' : '#5d5a70';
    c.font = '800 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(p ? String(p.name).slice(0, 11) : 'open seat', cx + 66, cy + 33);
  }

  if (s.starting) {
    c.textAlign = 'center';
    c.fillStyle = '#7ac74f';
    c.font = '900 44px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('KARTS TO THE GRID!', w / 2, h - 30);
  }
}

function boardTexture() {
  return canvasTexture(720, 400, (c, w, h) =>
    drawBoard(c, w, h, { live: false, roster: [], rows: [], tick: 0, laps: 3 }));
}

/**
 * The sign-on sheet on its easel by the pit wall: six pips, filled in the
 * signers' own fur colours, plus the live count. Repainted in place.
 */
function drawSignOn(c, w, h, roster, starting) {
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#fff6e3';
  c.beginPath();
  c.roundRect(6, 6, w - 12, h - 12, 24);
  c.fill();
  c.fillStyle = starting ? '#7ac74f' : '#e8657a';
  c.beginPath();
  c.roundRect(6, 6, w - 12, 54, [24, 24, 0, 0]);
  c.fill();
  c.strokeStyle = '#5f3f28';
  c.lineWidth = 7;
  c.beginPath();
  c.roundRect(6, 6, w - 12, h - 12, 24);
  c.stroke();

  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = '#fffaf0';
  c.font = '800 32px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(starting ? 'KARTS TO THE GRID!' : 'SIGN-ON SHEET', w / 2, 33);

  c.fillStyle = '#2d2417';
  c.font = '900 50px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(`${roster.length}/6`, 74, 100);

  for (let i = 0; i < 6; i++) {
    const cx = 148 + i * 54;
    const p = roster[i];
    c.beginPath();
    c.arc(cx, 100, 21, 0, TAU);
    c.fillStyle = p ? `#${((p.color >>> 0) || 0xb08a5a).toString(16).padStart(6, '0')}` : '#e6dcc4';
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = '#2d2417';
    c.stroke();
    if (p) {
      c.fillStyle = '#2d2417';
      c.beginPath();
      c.arc(cx - 6, 96, 2.6, 0, TAU);
      c.arc(cx + 6, 96, 2.6, 0, TAU);
      c.fill();
    }
  }

  c.fillStyle = '#8a6242';
  c.font = '700 24px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText('empty seats are filled by the fete regulars', w / 2, h - 30);
}

function signOnTexture() {
  return canvasTexture(512, 192, (c, w, h) => drawSignOn(c, w, h, [], false));
}

/** The lap-records board: a nailed-up sheet of cream card. */
function recordsTexture(best) {
  return canvasTexture(384, 256, (c, w, h) => {
    c.fillStyle = '#fff6e3';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#f2b64a';
    c.fillRect(0, 0, w, 56);
    c.strokeStyle = '#5f3f28';
    c.lineWidth = 9;
    c.strokeRect(6, 6, w - 12, h - 12);

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#3a2a18';
    c.font = '800 34px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('LAP RECORDS', w / 2, 30);

    c.fillStyle = '#2d2417';
    c.font = '900 60px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(best > 0 ? String(best) : '—', w / 2, 118);
    c.fillStyle = '#8a6242';
    c.font = '700 26px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(best > 0 ? 'your best race score' : 'no race on the sheet yet', w / 2, 166);
    c.font = '700 22px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#a08360';
    c.fillText('three laps · six karts · no biting', w / 2, 212);
  });
}

/** The plaza gate signpost, two-faced so it reads coming and going. */
function gateSignTexture() {
  return canvasTexture(512, 160, (c, w, h) => {
    c.fillStyle = '#b98a5c';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < h; i += 12) c.fillRect(0, i, w, 4);
    c.strokeStyle = '#7a5232';
    c.lineWidth = 9;
    c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#fff6e6';
    c.font = '700 58px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('SUNNY PLAZA', w / 2 + 26, h / 2 - 8);
    c.font = '600 28px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#ffe3bb';
    c.fillText('back over the dunes', w / 2 + 26, h / 2 + 38);
    c.fillStyle = '#fff6e6';
    c.beginPath();
    c.moveTo(28, h / 2);
    c.lineTo(72, h / 2 - 34);
    c.lineTo(72, h / 2 - 12);
    c.lineTo(102, h / 2 - 12);
    c.lineTo(102, h / 2 + 12);
    c.lineTo(72, h / 2 + 12);
    c.lineTo(72, h / 2 + 34);
    c.closePath();
    c.fill();
  });
}

/** The welcome arch board over the paddock gate. */
function archSignTexture() {
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

    // a chequered flag either side
    for (const cx of [76, w - 76]) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          c.fillStyle = (i + j) % 2 ? '#fff3e2' : '#2d2417';
          c.fillRect(cx - 38 + i * 19, h / 2 - 28 + j * 19, 19, 19);
        }
      }
    }

    c.font = '700 78px system-ui, "Segoe UI", Verdana, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(80,20,35,0.35)';
    c.fillText('CAPY SPEEDWAY', w / 2 + 4, h / 2 + 8);
    c.fillStyle = '#fffaf0';
    c.fillText('CAPY SPEEDWAY', w / 2, h / 2 + 3);
  });
}

/** The snack cart's menu board. Melon, obviously. */
function snackSignTexture() {
  return canvasTexture(384, 256, (c, w, h) => {
    c.fillStyle = '#2d2417';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#f2b64a';
    c.lineWidth = 8;
    c.strokeRect(8, 8, w - 16, h - 16);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff6e3';
    c.font = '800 40px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('PIT SNACKS', w / 2, 44);
    c.font = '700 27px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillStyle = '#f2b64a';
    const menu = ['melon slices', 'seaweed crisps', 'fizzy pondwater', 'one (1) nap'];
    menu.forEach((line, i) => c.fillText(line, w / 2, 96 + i * 38));
  });
}

/** The item-box display plinth labels: what is actually in those boxes. */
function itemPlaqueTexture(title, sub, hex) {
  return canvasTexture(256, 128, (c, w, h) => {
    c.fillStyle = '#fff6e3';
    c.fillRect(0, 0, w, h);
    c.fillStyle = `#${hex.toString(16).padStart(6, '0')}`;
    c.fillRect(0, 0, w, 12);
    c.strokeStyle = '#5f3f28';
    c.lineWidth = 6;
    c.strokeRect(4, 4, w - 8, h - 8);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#2d2417';
    c.font = '800 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(title, w / 2, 50);
    c.fillStyle = '#8a6242';
    c.font = '700 21px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText(sub, w / 2, 88);
  });
}

/* --- instanced prop geometries (module scope: no per-instance state) ------- */

/** One palm: leaning trunk rings + six drooping fronds + a coconut cluster. */
function makePalmGeo() {
  const p = [];
  const lean = 0.16;
  let x = 0;
  let y = 0;
  for (let i = 0; i < 7; i++) {
    const r = 0.22 - i * 0.017;
    const seg = 0.52;
    part(p, new THREE.CylinderGeometry(r * 0.92, r, seg, 7), i % 2 ? C.wood : C.woodLit, {
      x: x + lean * i * 0.5, y: y + seg / 2, rz: -lean * 0.5,
    });
    y += seg * 0.94;
  }
  const topX = x + lean * 3.4;
  const topY = y + 0.1;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.35;
    const frond = new THREE.SphereGeometry(0.62, 7, 4, 0, TAU, 0, Math.PI * 0.5);
    part(p, frond, i % 2 ? C.leaf : C.leafDark, {
      sx: 1.7, sy: 0.28, sz: 0.55,
      rz: -0.42, ry: a,
      x: topX + Math.cos(a) * 0.72, y: topY - 0.06, z: Math.sin(a) * 0.72,
    });
  }
  part(p, new THREE.SphereGeometry(0.28, 8, 6), C.leafDark, { x: topX, y: topY - 0.04 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    part(p, new THREE.SphereGeometry(0.12, 7, 5), C.woodDark, {
      x: topX + Math.cos(a) * 0.2, y: topY - 0.22, z: Math.sin(a) * 0.2,
    });
  }
  return mergeParts(p);
}

/** A stack of four tyres, coral-and-cream banded like every fete's kerbing. */
function makeTyreStackGeo() {
  const p = [];
  for (let i = 0; i < 4; i++) {
    part(p, new THREE.CylinderGeometry(0.44, 0.44, 0.24, 12, 1, true), C.tyre, { y: 0.13 + i * 0.24 });
    part(p, new THREE.TorusGeometry(0.36, 0.11, 6, 12), i % 2 ? C.tyre : C.tyre, {
      rx: Math.PI / 2, y: 0.13 + i * 0.24,
    });
  }
  // a bright cap so a wall of these still reads at distance
  part(p, new THREE.CylinderGeometry(0.4, 0.4, 0.1, 12), C.coral, { y: 1.06 });
  part(p, new THREE.CylinderGeometry(0.16, 0.16, 0.14, 8), C.cream, { y: 1.14 });
  return mergeParts(p);
}

/**
 * A spectator capybara, echoing createAvatar's chibi proportions but built from
 * primitives so forty of them cost one draw call. Body parts are painted near
 * white so the per-instance colour does the tinting; eyes and nose stay ink.
 */
function makeCrowdCapyGeo() {
  const p = [];
  part(p, new THREE.SphereGeometry(0.34, 10, 8), 0xdedede, { sx: 1.0, sy: 0.92, sz: 1.12, y: 0.34 });
  part(p, new THREE.SphereGeometry(0.26, 10, 8), 0xeaeaea, { sx: 1.05, sy: 0.94, sz: 0.98, y: 0.8 });
  part(p, new THREE.SphereGeometry(0.15, 8, 6), 0xffffff, { sx: 1.0, sy: 0.72, sz: 0.9, y: 0.74, z: 0.21 });
  part(p, new THREE.SphereGeometry(0.055, 6, 5), C.ink, { y: 0.79, z: 0.34 });
  for (const sx of [-1, 1]) {
    part(p, new THREE.SphereGeometry(0.085, 7, 5), 0xc9c9c9, { sx: 0.8, sy: 1, sz: 0.6, x: sx * 0.2, y: 0.97, z: -0.02 });
    part(p, new THREE.SphereGeometry(0.042, 6, 5), C.ink, { x: sx * 0.11, y: 0.85, z: 0.2 });
    part(p, new THREE.SphereGeometry(0.1, 7, 5), 0xd4d4d4, { sx: 0.8, sy: 0.7, sz: 1.1, x: sx * 0.22, y: 0.16, z: 0.16 });
  }
  return mergeParts(p);
}

/** A striped deck chair: the fete's seating plan in its entirety. */
function makeDeckChairGeo() {
  const p = [];
  for (const sx of [-1, 1]) {
    part(p, new THREE.BoxGeometry(0.06, 0.9, 0.06), C.wood, { x: sx * 0.3, y: 0.45, z: 0.26, rx: 0.22 });
    part(p, new THREE.BoxGeometry(0.06, 0.62, 0.06), C.wood, { x: sx * 0.3, y: 0.31, z: -0.2, rx: -0.3 });
  }
  part(p, new THREE.BoxGeometry(0.66, 0.05, 0.62), C.coral, { y: 0.42, z: 0.02, rx: -0.12 });
  part(p, new THREE.BoxGeometry(0.2, 0.055, 0.62), C.cream, { y: 0.425, z: 0.02, rx: -0.12 });
  part(p, new THREE.BoxGeometry(0.66, 0.62, 0.05), C.coral, { y: 0.7, z: 0.26, rx: 0.24 });
  part(p, new THREE.BoxGeometry(0.2, 0.62, 0.055), C.cream, { y: 0.7, z: 0.262, rx: 0.24 });
  return mergeParts(p);
}

/** Straw bale: soft trackside furniture, doubles as a bench. */
function makeBaleGeo() {
  const p = [];
  part(p, new THREE.BoxGeometry(1.0, 0.56, 0.6), C.gold, { y: 0.28 });
  part(p, new THREE.BoxGeometry(1.02, 0.08, 0.62), C.goldDark, { y: 0.2 });
  part(p, new THREE.BoxGeometry(1.02, 0.08, 0.62), C.goldDark, { y: 0.38 });
  return mergeParts(p);
}

/** Marker cone: coral with a cream band, because traffic orange is not cozy. */
function makeConeGeo() {
  const p = [];
  part(p, new THREE.BoxGeometry(0.34, 0.05, 0.34), C.cream, { y: 0.025 });
  part(p, new THREE.ConeGeometry(0.15, 0.46, 7), C.coral, { y: 0.27 });
  part(p, new THREE.CylinderGeometry(0.1, 0.115, 0.07, 7), C.cream, { y: 0.29 });
  return mergeParts(p);
}

/** A gull: wedge body, two swept wings, permanently smug. */
function makeGullGeo() {
  const p = [];
  part(p, new THREE.SphereGeometry(0.17, 8, 6), C.cream, { sx: 1, sy: 0.85, sz: 1.7 });
  part(p, new THREE.SphereGeometry(0.1, 7, 5), C.cream, { z: 0.24, y: 0.05 });
  part(p, new THREE.ConeGeometry(0.045, 0.16, 5), C.gold, { rx: Math.PI / 2, z: 0.36, y: 0.03 });
  for (const sx of [-1, 1]) {
    part(p, new THREE.BoxGeometry(0.7, 0.03, 0.2), C.cream, { x: sx * 0.42, y: 0.06, z: -0.02, rz: sx * 0.16 });
    part(p, new THREE.BoxGeometry(0.24, 0.035, 0.16), C.steelDark, { x: sx * 0.7, y: 0.1, z: -0.04, rz: sx * 0.16 });
  }
  part(p, new THREE.BoxGeometry(0.16, 0.03, 0.2), C.cream, { z: -0.28 });
  return mergeParts(p);
}

/** One bunting flag, hinged at its top edge (origin) so it can swing. */
function makeBuntingFlagGeo() {
  const p = [];
  const g = new THREE.ConeGeometry(0.17, 0.34, 3);
  part(p, g, 0xffffff, { rx: Math.PI, ry: Math.PI / 4, y: -0.17 });
  return mergeParts(p);
}

/** The floating item box: a rounded cube with a glowing paw sigil on each face. */
function makeItemBoxGeo() {
  const p = [];
  part(p, new THREE.BoxGeometry(0.62, 0.62, 0.62), 0xfff2c8, {});
  part(p, new THREE.OctahedronGeometry(0.4, 0), C.gold, {});
  for (const [ax, ay, az] of [[0, 0, 0.33], [0, 0, -0.33], [0.33, 0, 0], [-0.33, 0, 0]]) {
    part(p, new THREE.SphereGeometry(0.085, 7, 5), C.coral, { x: ax * 1.02, y: ay, z: az * 1.02 });
    for (let i = 0; i < 3; i++) {
      const a = -0.7 + i * 0.7;
      part(p, new THREE.SphereGeometry(0.038, 6, 4), C.coral, {
        x: (ax * 1.04) + (az ? Math.sin(a) * 0.11 : 0),
        y: ay + 0.12,
        z: (az * 1.04) + (ax ? Math.sin(a) * 0.11 : 0),
      });
    }
  }
  return mergeParts(p);
}

/** Display plinth for one item box, with a plaque slot cut by geometry. */
function makePlinthGeo() {
  const p = [];
  part(p, new THREE.CylinderGeometry(0.5, 0.6, 0.18, 10), C.creamShade, { y: 0.09 });
  part(p, new THREE.CylinderGeometry(0.3, 0.36, 0.9, 10), C.cream, { y: 0.6 });
  part(p, new THREE.CylinderGeometry(0.44, 0.38, 0.12, 10), C.gold, { y: 1.09 });
  return mergeParts(p);
}

/* --- day/night palette (LIVING-COVE section A) ----------------------------
 * Four stops, wrapping: dawn (dayT 0.0), noon (0.25), dusk (0.5), night
 * (0.75). Everything lerps into preallocated colours in _relight, so the world
 * clock costs zero allocations per frame. `hemiI` never drops below the 0.45
 * playability floor: a paddock at midnight still has to be walkable.
 */
const SKY = [
  { // dawn
    top: 0x35639e, mid: 0xf3a583, hor: 0xffd9a8, fog: 0xf4cba6,
    sun: 0xffb478, sunI: 1.2, hemiS: 0xffd3b0, hemiG: 0xc09a70, hemiI: 0.95,
    amb: 0xffd0b0, ambI: 0.32, sea: 0x3f95c8, deep: 0x2a6f9e, lamp: 0.55,
  },
  { // noon: the light this room was authored under
    top: 0x2f8fd0, mid: 0x8ccbec, hor: 0xdff0f2, fog: 0xcfe9f2,
    sun: 0xffe9c0, sunI: 2.0, hemiS: 0xffeccb, hemiG: 0xc9a771, hemiI: 1.15,
    amb: 0xffdcae, ambI: 0.34, sea: 0x4fb3e8, deep: 0x2b7fb8, lamp: 0.0,
  },
  { // dusk: the cove's signature golden hour, off the western sea
    top: 0x4a3f86, mid: 0xe8657a, hor: 0xffb257, fog: 0xf0a06e,
    sun: 0xff9455, sunI: 1.7, hemiS: 0xffc194, hemiG: 0x7a648e, hemiI: 1.0,
    amb: 0xffc79a, ambI: 0.48, sea: 0x3c82bc, deep: 0x2d6b9c, lamp: 0.8,
  },
  { // night
    top: 0x101833, mid: 0x1c2749, hor: 0x2e3f66, fog: 0x1c2646,
    sun: 0xa8c4f0, sunI: 0.55, hemiS: 0x42568c, hemiG: 0x1a1f31, hemiI: 0.5,
    amb: 0x92a8d8, ambI: 0.3, sea: 0x1d3f68, deep: 0x16324f, lamp: 1.0,
  },
];

// how dark each stop reads (dawn, noon, dusk, night), for lamps/stars/beacon
const NIGHTNESS = [0.35, 0, 0.4, 1];

const DAY_SECONDS = 40 * 60;     // one cove day; the server's dayMs is the truth
const DEFAULT_DAY_T = 0.3;       // early afternoon: the authored look
const SUN_R = 62;
const NOON_AZ = -2.2;            // sun bearing at noon: north-west, raking the sea

/** Weather can arrive as a word or a per-family map; take either. */
function readWeather(w) {
  if (typeof w === 'string') return w === 'rain' || w === 'breeze' ? w : 'clear';
  if (w && typeof w === 'object') return readWeather(w.speedway ?? w.beach ?? w.coast ?? w.outdoor);
  return 'clear';
}

// relight scratch: nothing below may allocate
const _mix = new THREE.Color();
const _mixB = new THREE.Color();
const _col = new THREE.Color();
const _v3 = new THREE.Vector3();

function mixHex(a, b, f, out) {
  return out.setHex(a).lerp(_mixB.setHex(b), f);
}

/* ========================================================================== */

export class SpeedwayRoom extends Room {
  id = 'speedway';
  name = 'Capy Speedway';

  build(scene, game) {
    applySpotOverrides();     // dev layout editor (Ctrl+E); a no-op normally

    this._game = game;
    this.t = 0;
    this._dummy = new THREE.Object3D();
    this.tagged = new Map();

    // ---- lobby + jumbotron state -------------------------------------------
    this._roster = [];        // [{ id, name, color, hat }] from 'kart-lobby'
    this._starting = false;
    this._signedOn = false;   // is the local capybara on the sheet?
    this._boardLive = false;  // a race is running: standings, not the ticker
    this._board = { live: false, title: 'CAPY SPEEDWAY', lap: 1, laps: 3, rows: [], over: false, roster: [], starting: false, tick: 0 };
    this._boardDirty = true;
    this._tickT = 0;
    this._liveT = 0;          // seconds since the last 'kart-board' frame
    this._offLobby = null;
    this._offGrid = null;
    this._offResume = null;
    this._offBoard = null;
    this._offEnd = null;
    this._joinSpot = null;

    // ---- world clock state (dormant until the first onClock frame) ---------
    this._hasClock = false;
    this._litOnce = false;
    this._dayT = DEFAULT_DAY_T;
    this._nightK = 0;
    this._lampK = 0;
    this._weather = 'clear';
    this._rainWant = 0;
    this._rainNow = 0;
    this._windK = 1;

    scene.background = new THREE.Color(0xbfe0f4);
    scene.fog = new THREE.Fog(0xcfe9f2, 34, 150);
    this._bgColor = scene.background;
    this._fog = scene.fog;

    this._lights(scene);
    this._sky(scene);
    this._sea(scene);
    this._headland(scene);
    this._ground(scene);
    this._track(scene);
    this._pitWall(scene);
    this._gantry(scene);
    this._grandstand(scene);
    this._fetePavilion(scene);
    this._itemDisplay(scene);
    this._signOnEasel(scene);
    this._recordsBoard(scene);
    this._plazaGate(scene);
    this._palms(scene);
    this._bunting(scene);
    this._scatter(scene);
    this._gulls(scene);
    this._rain(scene);

    /* --- the frozen contract numbers (docs/KARTS.md section 1) ------------ */
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 3.5),
      // A step inside the paddock gate, south of the exit ring (0,13) r 3.0, so
      // arriving from the plaza does not immediately pop the "go back" prompt.
      from_plaza: new THREE.Vector3(0, 0, 9.6),
    };

    const join = spotAt('race-join');
    const play = spotAt('play-kart');
    const recs = spotAt('records');
    const exit = spotAt('exit-plaza');

    this._joinSpot = {
      id: 'race-join',
      position: new THREE.Vector3(join[0], 0, join[1]),
      radius: spotR('race-join'),
      label: this._joinLabel(),
      action: (g) => {
        if (g.net?.connected) {
          // grand prix: the sign-on carries this capy's kart pick and track
          // vote (kart.js's own localStorage keys, §A4/§A5); the server
          // coerces unknown ids to coco/sunny, so this is safe standalone
          if (this._signedOn) {
            g.net.send({ t: 'kart-leave' });
          } else {
            let kart = 'coco'; let track = 'sunny';
            try {
              kart = localStorage.getItem('cove.kart.pick') || kart;
              track = localStorage.getItem('cove.kart.track') || track;
            } catch { /* storage off: race the defaults */ }
            g.net.send({ t: 'kart-join', kart, track });
          }
        } else {
          // offline: no sheet to sign, so the pit wall just starts a solo race
          g.__kartCtx = null;
          g.startMinigame('kart');
        }
      },
    };

    this.hotspots.push(
      this._joinSpot,
      {
        id: 'play-kart',
        position: new THREE.Vector3(play[0], 0, play[1]),
        radius: spotR('play-kart'),
        label: 'Take a practice lap',
        action: (g) => {
          g.__kartCtx = null;
          g.startMinigame('kart');
        },
      },
      {
        id: 'records',
        position: new THREE.Vector3(recs[0], 0, recs[1]),
        radius: spotR('records'),
        label: 'Read the lap records',
        action: (g) => {
          const best = Number(g.state?.bests?.kart) || 0;
          g.audio?.play?.('ding');
          g.toast?.(best > 0
            ? `Best race on the sheet: ${best} points. The chalk is smudged but proud.`
            : 'The board is blank. Someone has to be first, and it may as well be you.');
        },
      },
      {
        id: 'exit-plaza',
        position: new THREE.Vector3(exit[0], 0, exit[1]),
        radius: spotR('exit-plaza'),
        label: 'Back to Sunny Plaza',
        action: (g) => g.goToRoom('plaza', 'speedway'),
      },
    );

    // Play camera: a touch higher and further back than the default, because
    // the star attraction (gantry + jumbotron) stands 12 units north of the
    // walkable edge and has to stay in frame from the middle of the paddock.
    this.cameraHint = { offset: new THREE.Vector3(0, 12.5, 20), lookHeight: 1.6 };
    // Static (wide) camera: the whole paddock, the pit wall and the board.
    this.staticCamera = {
      position: new THREE.Vector3(0, 18.5, 25),
      lookAt: new THREE.Vector3(0, 1.6, -1.5),
    };

    // Live only while this room is: every handle is dropped in dispose().
    if (game?.events?.on) {
      this._offLobby = game.events.on('kart-lobby', (m) => this._onLobby(m));
      this._offGrid = game.events.on('kart-grid', (m) => this._onGrid(m));
      this._offResume = game.events.on('kart-resume', (m) => this._onResume(m));
      this._offBoard = game.events.on('kart-board', (m) => this._onBoard(m));
      this._offEnd = game.events.on('kart-end', () => this._boardIdle());
    }

    /* Dev layout editor (Ctrl+E), "Numbers" tab: one draggable pin per landmark.
     * Every pin writes back into SPOTS, which build() reads at the top, so the
     * prop, its prompt zone, its sign and its collider all move together. */
    this.editable('race-join', [this.tagged.get('sign-on')], { table: 'SPOTS' });
    this.editable('play-kart', [this.tagged.get('practice-kart'), this.tagged.get('item-plinths')], { table: 'SPOTS' });
    this.editable('records', [this.tagged.get('records')], { table: 'SPOTS' });
    this.editable('exit-plaza', [this.tagged.get('plaza-gate')], { table: 'SPOTS' });
    this.editable('jumbotron', [this.tagged.get('gantry'), this.tagged.get('jumbotron')], { table: 'SPOTS' });
    this.editable('grandstand', [this.tagged.get('grandstand')], { table: 'SPOTS' });
    this.editable('snack-cart', [this.tagged.get('snack-cart')], { table: 'SPOTS' });

    this._paintBoard();
    this._paintSignOn();
  }

  /* --- lobby -------------------------------------------------------------- */

  _joinLabel() {
    if (!this._game?.net?.connected) return 'Line up on the grid';
    if (this._signedOn) return 'Leave the sign-on sheet';
    return `Sign on for a race (${this._roster.length}/6)`;
  }

  /**
   * Push the label onto the prompt. The engine writes textContent once, when
   * it spawns the button, so a live label has to patch the element in place.
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

  /** Server -> room: 'kart-lobby' {players, starting, startsAt, max}. */
  _onLobby(m) {
    const players = Array.isArray(m?.players) ? m.players.slice(0, 6) : [];
    const selfId = this._game?.net?.selfId ?? null;
    const was = this._signedOn;
    this._roster = players.map((p) => ({
      id: p?.id ?? null,
      name: typeof p?.name === 'string' ? p.name : 'Capybara',
      color: Number.isFinite(p?.color) ? p.color : C.fur,
      hat: p?.hat || 'none',
    }));
    this._signedOn = selfId !== null && this._roster.some((p) => p.id === selfId);
    this._starting = !!m?.starting;

    if (this._signedOn && !was) {
      this._game?.audio?.play?.('whoosh');
      this._game?.toast?.('Signed on! Empty seats fill with the fete regulars.');
    } else if (!this._signedOn && was) {
      this._game?.audio?.play?.('click');
    } else if (this._roster.length) {
      this._game?.audio?.play?.('pop');
    }

    this._paintSignOn();
    this._refreshJoinLabel();
    if (!this._boardLive) this._boardIdle();
  }

  /**
   * Server -> racer: 'kart-grid'. Stash the handoff and launch the race, the
   * way the peak stashes __raceCtx for the sled. `startAt` is not known yet
   * (it rides 'kart-go', ~1.2s later): the minigame builds the grid meanwhile.
   */
  _onGrid(m) {
    const game = this._game;
    if (!game || !m) return;
    this._boardLive = true;
    // Already inside a minigame (a practice lap started while the sheet
    // filled): startMinigame would no-op and the ctx would sit there waiting to
    // turn some later practice run into a phantom race. Bow out loudly instead,
    // so the rest of the grid is not left waiting on the finish grace.
    if (game.activeMinigame) {
      game.net?.send?.({ t: 'kart-leave' });
      game.toast?.('The race left without you: you were already out on track!');
      return;
    }
    game.__kartCtx = { race: m.race, grid: m, startAt: null, you: m.you || null };
    game.toast?.('Karts to the grid!');
    game.startMinigame('kart');
  }

  /** Server -> racer: 'kart-resume', a reconnect landing back into a live race. */
  _onResume(m) {
    const game = this._game;
    if (!game || !m || game.activeMinigame) return;
    this._boardLive = true;
    game.__kartCtx = {
      race: m.race,
      grid: m.grid || null,
      startAt: Number.isFinite(m.startAt) ? m.startAt : null,
      you: m.you || null,
      resume: m,
    };
    game.toast?.('Back in the seat!');
    game.startMinigame('kart');
  }

  /* --- the jumbotron ------------------------------------------------------ */

  /** Server -> the whole room: 'kart-board', 2 Hz while a race runs. */
  _onBoard(m) {
    if (!m) return;
    const rows = Array.isArray(m.rows) ? m.rows.slice(0, 6) : [];
    rows.sort((a, b) => (a?.place ?? 9) - (b?.place ?? 9));
    const b = this._board;
    b.live = true;
    b.over = !!m.over;
    b.laps = Number(m.laps) || 3;
    b.rows = rows.map((r, i) => ({
      s: r?.s ?? i,
      n: typeof r?.n === 'string' ? r.n : 'Capybara',
      lap: Number(r?.lap) || 0,
      q: Number(r?.q) || 0,
      ai: !!r?.ai,
      place: Number(r?.place) || i + 1,
    }));
    b.lap = Math.min(b.laps, (rows[0]?.lap || 0) + 1);
    b.title = 'CAPY SPEEDWAY';
    this._boardLive = !m.over;
    this._liveT = 0;
    this._boardDirty = true;
  }

  /** Drop back to the ticker + sign-on sheet. */
  _boardIdle() {
    this._boardLive = false;
    const b = this._board;
    b.live = false;
    b.over = false;
    b.rows = [];
    b.roster = this._roster;
    b.starting = this._starting;
    this._boardDirty = true;
  }

  _paintBoard() {
    const tex = this._boardTex;
    const cv = tex?.image;
    if (!cv?.getContext) return;
    const b = this._board;
    b.roster = this._roster;
    b.starting = this._starting;
    drawBoard(cv.getContext('2d'), cv.width, cv.height, b);
    tex.needsUpdate = true;
    this._boardDirty = false;
  }

  _paintSignOn() {
    const tex = this._signTex;
    const cv = tex?.image;
    if (!cv?.getContext) return;
    drawSignOn(cv.getContext('2d'), cv.width, cv.height, this._roster, this._starting);
    tex.needsUpdate = true;
    if (!this._boardLive) this._boardDirty = true;
  }

  /* --- lighting ----------------------------------------------------------- */

  _lights(scene) {
    this._hemi = new THREE.HemisphereLight(0xffeccb, 0xc9a771, 1.15);
    scene.add(this._hemi);
    this._amb = new THREE.AmbientLight(0xffdcae, 0.34);
    scene.add(this._amb);

    // the room's ONE shadow caster (CONTRACT.md performance budget)
    const sun = new THREE.DirectionalLight(0xffe9c0, 2.0);
    this._sun = sun;
    sun.position.set(Math.cos(NOON_AZ) * SUN_R, 34, Math.sin(NOON_AZ) * SUN_R);
    sun.target.position.set(0, 0, -2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.05;
    const sc = sun.shadow.camera;
    sc.left = -22; sc.right = 22; sc.top = 20; sc.bottom = -20;
    sc.near = 2; sc.far = 120;
    sc.updateProjectionMatrix();
    scene.add(sun.target);
    scene.add(sun);

    // warm fills: the gantry floods and the snack cart's string lamp. Both come
    // up after dusk (see _relight) and sit dark at noon.
    this._gantryLight = new THREE.PointLight(0xffd08a, 0, 22, 2);
    this._gantryLight.position.set(0, 7.4, -11.2);
    scene.add(this._gantryLight);
    const cart = spotAt('snack-cart');
    this._cartLight = new THREE.PointLight(0xffc178, 0, 11, 2);
    this._cartLight.position.set(cart[0], 2.4, cart[1] + 0.6);
    scene.add(this._cartLight);
  }

  _sky(scene) {
    const mat = makeGlow(0xffffff, { unique: true });
    mat.map = skyTexture();
    mat.side = THREE.BackSide;
    mat.fog = false;
    mat.depthWrite = false;
    mat.needsUpdate = true;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(220, 24, 16), mat);
    sky.rotation.y = -NOON_AZ;
    sky.renderOrder = -2;
    scene.add(sky);
    this._skyMesh = sky;
    this._skyMat = mat;

    const discMat = makeGlow(0xfff6dc, { unique: true });
    discMat.fog = false;
    discMat.transparent = true;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(6.5, 26), discMat);
    disc.renderOrder = -1;
    scene.add(disc);
    this._sunDisc = disc;
    this._sunDiscMat = discMat;

    // a pinch of stars, invisible until it is properly night
    const rng = mulberry32(20260814);
    const n = 220;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const e = 0.12 + rng() * 0.8;
      const r = 190;
      pos[i * 3] = Math.cos(a) * r * Math.cos(e);
      pos[i * 3 + 1] = r * Math.sin(e);
      pos[i * 3 + 2] = Math.sin(a) * r * Math.cos(e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const starMat = new THREE.PointsMaterial({
      size: 2.4, map: dotTexture(), transparent: true, opacity: 0,
      depthWrite: false, fog: false, sizeAttenuation: false,
    });
    const stars = new THREE.Points(geo, starMat);
    stars.renderOrder = -1;
    stars.visible = false;
    scene.add(stars);
    this._stars = stars;
    this._starMat = starMat;
  }

  /**
   * The sea, north beyond the circuit: the camera looks north from the paddock,
   * so the frame reads paddock -> pit wall -> tarmac -> dunes -> surf -> horizon.
   * Three crossed sine trains on a coarse grid; nothing allocates per frame.
   */
  _sea(scene) {
    const geo = new THREE.PlaneGeometry(340, 150, 46, 18);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -95);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    const base = new Float32Array(n);
    const posArr = geo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const z = posArr[i * 3 + 2];
      const k = clamp01((-z - 22) / 70);
      _col.setHex(C.sea).lerp(_mixB.setHex(C.seaDeep), k);
      col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
      base[i] = 0;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = makeToon(0xffffff, { unique: true, vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.55;
    mesh.receiveShadow = false;
    scene.add(mesh);
    this._sea3 = { mesh, geo, mat, base, attr: geo.attributes.position };

    // the beach berm between the circuit and the water, plus a surf line
    const berm = [];
    part(berm, new THREE.PlaneGeometry(340, 10, 1, 1), C.sandWet, { rx: -Math.PI / 2, y: -0.34, z: -23.6 });
    part(berm, new THREE.PlaneGeometry(340, 8, 1, 1), C.sandDark, { rx: -Math.PI / 2, y: -0.06, z: -19.4 });
    part(berm, new THREE.BoxGeometry(340, 0.5, 2.6), C.sandLit, { y: -0.06, z: -18.2 });
    scene.add(solidMesh(berm, { shadow: false }));

    const foamMat = screenMat(foamTexture(), { transparent: true });
    foamMat.opacity = 0.9;
    foamMat.depthWrite = false;
    const foamGeo = new THREE.PlaneGeometry(340, 5.2);
    foamGeo.rotateX(-Math.PI / 2);
    const foam = new THREE.Mesh(foamGeo, foamMat);
    foam.position.set(0, -0.3, -23.2);
    foam.renderOrder = 1;
    scene.add(foam);
    this._foam = foam;
    this._foamMat = foamMat;
    if (foamMat.map) {
      foamMat.map.wrapS = THREE.RepeatWrapping;
      foamMat.map.repeat.set(24, 1);
    }
  }

  /** A headland with a lighthouse away to the north-west: the horizon anchor. */
  _headland(scene) {
    const p = [];
    const rng = mulberry32(7788);
    for (let i = 0; i < 9; i++) {
      const x = -150 + i * 15 + rng() * 8;
      const z = -128 - rng() * 22;
      const h = 8 + rng() * 16;
      const g = new THREE.ConeGeometry(11 + rng() * 8, h, 6);
      part(p, g, i % 2 ? C.rock : C.rockDark, { x, y: h / 2 - 1.5, z });
    }
    for (let i = 0; i < 6; i++) {
      const x = 96 + i * 17;
      const h = 6 + rng() * 10;
      part(p, new THREE.ConeGeometry(10 + rng() * 6, h, 6), i % 2 ? C.rockDark : C.rock, {
        x, y: h / 2 - 1.5, z: -120 - rng() * 20,
      });
    }
    // the lighthouse, cream with coral bands
    const LX = -84; const LZ = -118;
    part(p, new THREE.CylinderGeometry(2.6, 3.6, 4, 10), C.rockDark, { x: LX, y: 6, z: LZ });
    for (let i = 0; i < 5; i++) {
      part(p, new THREE.CylinderGeometry(1.5 - i * 0.12, 1.66 - i * 0.12, 2.4, 10),
        i % 2 ? C.coral : C.cream, { x: LX, y: 9 + i * 2.4, z: LZ });
    }
    part(p, new THREE.CylinderGeometry(2.1, 1.9, 0.5, 10), C.woodDark, { x: LX, y: 21.4, z: LZ });
    part(p, new THREE.ConeGeometry(1.9, 2.2, 10), C.coralDark, { x: LX, y: 23.6, z: LZ });
    const mesh = solidMesh(p, { shadow: false, receive: false });
    mesh.renderOrder = -1;
    scene.add(mesh);

    const beaconMat = makeGlow(0xfff2c0, { unique: true });
    beaconMat.transparent = true;
    beaconMat.opacity = 0.85;
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.25, 10, 8), beaconMat);
    beacon.position.set(LX, 21.7, LZ);
    scene.add(beacon);
    this._beacon = beacon;
    this._beaconMat = beaconMat;
  }

  /* --- the paddock -------------------------------------------------------- */

  /**
   * The walkable rectangle, and the ONLY thing in groundMeshes: the walk
   * controller stops anyone who steps off it, which is what keeps visitors out
   * of the racing surface no matter what the colliders are doing.
   *
   * Dead flat, deliberately. A fete field IS flat, the bot circle has to be,
   * and a flat paddock means every spawn, hotspot and prompt sits at y = 0. The
   * interest comes from vertex tints instead: worn desire paths between the
   * gate and the pit wall, dry-grass verges, and sun-bleached patches.
   */
  _ground(scene) {
    const geo = new THREE.PlaneGeometry(PAD_W, PAD_D, 68, 52);
    geo.rotateX(-Math.PI / 2);
    geo.translate(PAD_CX, 0, PAD_CZ);
    const pos = geo.attributes.position.array;
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);

    // the desire paths a season of capybaras has worn into the sand
    const play = spotAt('play-kart');
    const recs = spotAt('records');
    const cart = spotAt('snack-cart');
    const stand = spotAt('grandstand');
    const PATHS = [
      [0, 15.4, 0, -8.6],
      [0, -3.5, play[0], play[1]],
      [0, -3.5, recs[0], recs[1]],
      [1.6, 1.2, cart[0] - 1.2, cart[1] + 0.4],
      [-3.2, -0.6, stand[0] + 2.2, stand[1] - 0.4],
    ];

    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      // dry-grass verges along the south and the two long edges
      const edge = Math.max(
        smoothstep(9.5, 15.0, z),
        smoothstep(11.5, 16.2, Math.abs(x)),
      );
      const grassK = edge * (0.55 + 0.45 * Math.sin(x * 0.51 + z * 0.37));
      mixHex(C.sand, C.grass, clamp01(grassK), _col);
      // sun bleach + a little tonal noise so 34x26 units never looks like lino
      const noise = 0.5 + 0.5 * Math.sin(x * 0.74 + 1.1) * Math.cos(z * 0.63 - 0.4);
      _col.lerp(_mixB.setHex(C.sandLit), noise * 0.16);
      _col.lerp(_mixB.setHex(C.sandDark), (1 - noise) * 0.12);
      // worn paths on top of everything
      let pk = 0;
      for (const s of PATHS) {
        pk = Math.max(pk, 1 - smoothstep(0.5, 1.7, segDist(x, z, s[0], s[1], s[2], s[3])));
      }
      // the paddock apron in front of the pit wall is packed hard and pale
      pk = Math.max(pk, 1 - smoothstep(1.6, 3.4, Math.abs(z + 8.6)) * 0.9);
      _col.lerp(_mixB.setHex(C.path), pk * 0.8);
      col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const ground = new THREE.Mesh(geo, makeToon(0xffffff, VC));
    ground.receiveShadow = true;
    ground.name = 'speedway-paddock';
    ground.userData.tagId = 'speedway/paddock';
    scene.add(ground);
    this.groundMeshes = [ground];
    this.tagged.set('paddock', ground);

    // Everything past the walkable rectangle: dune sand, so the room never
    // shows a void edge. Unwalkable purely by not being in groundMeshes.
    const apron = [];
    part(apron, new THREE.PlaneGeometry(150, 130, 1, 1), C.sandDark, { rx: -Math.PI / 2, y: -0.07, z: -12 });
    part(apron, new THREE.BoxGeometry(2.0, 0.7, PAD_D + 6), C.sandLit, { x: PAD.x0 - 0.9, y: -0.06, z: PAD_CZ });
    part(apron, new THREE.BoxGeometry(2.0, 0.7, PAD_D + 6), C.sandLit, { x: PAD.x1 + 0.9, y: -0.06, z: PAD_CZ });
    part(apron, new THREE.BoxGeometry(PAD_W + 8, 0.7, 2.2), C.sandLit, { y: -0.06, z: PAD.z1 + 1.0 });
    // low dunes behind the fete so the south edge has a horizon of its own
    const rng = mulberry32(4242);
    for (let i = 0; i < 14; i++) {
      const a = -1 + i * 0.16;
      const x = Math.sin(a * 2.1) * 34 + (rng() - 0.5) * 8;
      const z = 20 + rng() * 16;
      const s = 3.4 + rng() * 4.2;
      part(apron, new THREE.SphereGeometry(s, 8, 5, 0, TAU, 0, Math.PI * 0.5),
        i % 2 ? C.sandDark : C.sandWet, { sy: 0.32, x, y: -0.4, z });
    }
    const skirt = solidMesh(apron, { shadow: false });
    skirt.renderOrder = -1;
    scene.add(skirt);
  }

  /**
   * One decorative stretch of the main straight, north of the pit wall. Three
   * merged ribbons in one mesh (tarmac, kerbs, paint), never per-segment.
   * Sits 3 cm below the paddock so the 1.5 units that reach south of the
   * walkable edge slide under the sand instead of z-fighting it.
   */
  _track(scene) {
    const segX = 88;
    const segZ = 18;
    const geo = new THREE.PlaneGeometry(TRK.x1 - TRK.x0, TRK.z1 - TRK.z0, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate((TRK.x0 + TRK.x1) / 2, TRK.y, (TRK.z0 + TRK.z1) / 2);
    const pos = geo.attributes.position.array;
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3];
      const z = pos[i * 3 + 2];
      _col.setHex(C.asphalt);
      // sun-bleached tarmac near the edges, darker in the middle
      const mid = 1 - smoothstep(0.5, 3.6, Math.abs(z + 13.0));
      _col.lerp(_mixB.setHex(C.asphaltLit), (1 - mid) * 0.5);
      // THE RACING LINE: rubbered-in, drifting a touch across the straight so
      // it reads as a line somebody drove rather than a stripe somebody painted
      const lineZ = -14.2 + Math.sin(x * 0.045) * 0.9;
      const lk = 1 - smoothstep(0.9, 2.6, Math.abs(z - lineZ));
      _col.lerp(_mixB.setHex(C.rubber), lk * 0.62);
      // braking marks approaching the start line
      const brake = (1 - smoothstep(0, 7, Math.abs(x - 9))) * (1 - smoothstep(1.4, 3.0, Math.abs(z - lineZ)));
      _col.lerp(_mixB.setHex(C.asphaltDark), brake * 0.35);
      col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const tarmac = new THREE.Mesh(geo, makeToon(0xffffff, VC));
    tarmac.receiveShadow = true;
    tarmac.userData.tagId = 'speedway/tarmac';
    scene.add(tarmac);
    this.tagged.set('tarmac', tarmac);

    // paint + kerbs, one merged mesh
    const p = [];
    const paintY = TRK.y + 0.012;
    // white edge lines
    part(p, new THREE.BoxGeometry(TRK.x1 - TRK.x0, 0.02, 0.22), C.line, { y: paintY, z: TRK.z0 + 0.55 });
    part(p, new THREE.BoxGeometry(TRK.x1 - TRK.x0, 0.02, 0.22), C.line, { y: paintY, z: WALL_Z + 0.7 });
    // the chequered start/finish band, under the gantry
    for (let i = 0; i < 44; i++) {
      const x = TRK.x0 + 0.5 + i;
      for (let j = 0; j < 3; j++) {
        part(p, new THREE.BoxGeometry(1.0, 0.02, 0.42), (i + j) % 2 ? C.line : C.ink, {
          x, y: paintY, z: FIN_Z - 0.42 + j * 0.42,
        });
      }
    }
    // kerbs: alternating coral and cream blocks, the fete's own banding
    for (let i = 0; i < 56; i++) {
      const x = TRK.x0 + 0.4 + i * 0.79;
      const hex = i % 2 ? C.coral : C.cream;
      part(p, new THREE.BoxGeometry(0.75, 0.11, 1.0), hex, { x, y: TRK.y + 0.055, z: TRK.z0 + 0.42, rz: 0 });
      part(p, new THREE.BoxGeometry(0.75, 0.11, 0.8), hex, { x, y: TRK.y + 0.055, z: WALL_Z + 0.95 });
    }
    const paint = solidMesh(p, { shadow: false });
    scene.add(paint);

    // the far barrier: a low wall of hoardings closing the track's north side
    const b = [];
    for (let i = 0; i < 30; i++) {
      const x = -21.7 + i * 1.5;
      part(b, new THREE.BoxGeometry(1.42, 1.0, 0.22), i % 3 === 0 ? C.gold : (i % 3 === 1 ? C.cream : C.sky), {
        x, y: 0.5, z: TRK.z0 - 0.5,
      });
      part(b, new THREE.BoxGeometry(1.46, 0.12, 0.28), C.creamShade, { x, y: 1.02, z: TRK.z0 - 0.5 });
    }
    scene.add(solidMesh(b, { shadow: false }));
  }

  /**
   * The pit wall: the contract's obstacle line at z = -10.6. Tyre stacks stand
   * on it every 3 units from x -18..18, and the collider circles (r 0.9) sit at
   * every 1.5 units so the line is CONTINUOUS: 0.9 * 2 > 1.5, so no gap between
   * two circles is wide enough for a capybara to squeeze through and get a nose
   * over the tarmac before the ground runs out under them.
   */
  _pitWall(scene) {
    const p = [];
    for (let i = 0; i < 24; i++) {
      const x = -18 + i * 1.5 + 0.75;
      part(p, new THREE.BoxGeometry(1.42, WALL_H, 0.34), i % 2 ? C.cream : C.creamShade, {
        x, y: WALL_H / 2, z: WALL_Z,
      });
      part(p, new THREE.BoxGeometry(1.46, 0.14, 0.42), C.coral, { x, y: WALL_H, z: WALL_Z });
    }
    // catch fence: thin posts and three rails, open enough to see the track
    for (let i = 0; i <= 12; i++) {
      const x = -18 + i * 3;
      part(p, new THREE.CylinderGeometry(0.055, 0.055, 1.0, 6), C.steelDark, { x, y: WALL_H + 0.5, z: WALL_Z - 0.12 });
    }
    for (const y of [WALL_H + 0.3, WALL_H + 0.66, WALL_H + 0.98]) {
      link(p, [-18, y, WALL_Z - 0.12], [18, y, WALL_Z - 0.12], 0.03, C.steel, 4);
    }
    const wall = solidMesh(p);
    wall.userData.tagId = 'speedway/pit-wall';
    scene.add(wall);
    this.tagged.set('pit-wall', wall);

    // the tyre stacks themselves: one instanced family
    const xs = [];
    for (let x = -WALL_X; x <= WALL_X + 0.001; x += 3) xs.push(x);
    const tyres = new THREE.InstancedMesh(makeTyreStackGeo(), makeToon(0xffffff, VC), xs.length);
    tyres.castShadow = true;
    tyres.receiveShadow = true;
    const d = this._dummy;
    for (let i = 0; i < xs.length; i++) {
      d.position.set(xs[i], 0, WALL_Z - 0.62);
      d.rotation.set(0, (i * 0.7) % TAU, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      tyres.setMatrixAt(i, d.matrix);
    }
    tyres.instanceMatrix.needsUpdate = true;
    tyres.computeBoundingSphere();
    tyres.userData.tagId = 'speedway/tyres';
    scene.add(tyres);
    this.tagged.set('tyres', tyres);
    d.rotation.set(0, 0, 0);

    // THE obstacle line. Continuous by construction (spacing 1.5 < 2 * 0.9).
    for (let x = -18; x <= 18.001; x += 1.5) this.obstacles.push({ x, z: WALL_Z, r: 0.9 });
  }

  /**
   * The start gantry, and hanging from it THE JUMBOTRON: this room's star
   * attraction and the entire spectator experience. Racers keep racing inside
   * the minigame; everyone left in the paddock watches the board.
   */
  _gantry(scene) {
    const jz = spotAt('jumbotron');
    const jy = SPOT_BY_ID.get('jumbotron').y ?? JUMBO.y;
    const p = [];
    for (const sx of [-1, 1]) {
      const x = sx * GANTRY_X;
      part(p, new THREE.BoxGeometry(1.5, 0.4, 1.5), C.creamShade, { x, y: 0.2, z: jz[1] });
      // lattice tower: four legs and a ladder of braces
      for (const [ox, oz] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) {
        part(p, new THREE.CylinderGeometry(0.1, 0.1, 9.2, 6), C.gold, { x: x + ox, y: 4.7, z: jz[1] + oz });
      }
      for (let i = 0; i < 9; i++) {
        const y = 0.9 + i;
        link(p, [x - 0.42, y, jz[1] - 0.42], [x + 0.42, y + 0.5, jz[1] - 0.42], 0.05, C.goldDark, 4);
        link(p, [x - 0.42, y, jz[1] + 0.42], [x + 0.42, y + 0.5, jz[1] + 0.42], 0.05, C.goldDark, 4);
        part(p, new THREE.BoxGeometry(0.96, 0.07, 0.07), C.goldDark, { x, y, z: jz[1] - 0.42 });
        part(p, new THREE.BoxGeometry(0.96, 0.07, 0.07), C.goldDark, { x, y, z: jz[1] + 0.42 });
      }
    }
    // cross beam + banner fascia
    part(p, new THREE.BoxGeometry(GANTRY_X * 2 + 1.4, 0.5, 0.9), C.gold, { y: 9.3, z: jz[1] });
    part(p, new THREE.BoxGeometry(GANTRY_X * 2 + 1.4, 0.16, 1.0), C.coral, { y: 9.62, z: jz[1] });
    // the board's cabinet
    part(p, new THREE.BoxGeometry(JUMBO.w + 0.7, JUMBO.h + 0.7, 0.5), C.ink, { y: jy, z: jz[1] - 0.06 });
    part(p, new THREE.BoxGeometry(JUMBO.w + 0.9, 0.28, 0.6), C.gold, { y: jy + JUMBO.h / 2 + 0.3, z: jz[1] - 0.06 });
    part(p, new THREE.BoxGeometry(JUMBO.w + 0.9, 0.22, 0.6), C.goldDark, { y: jy - JUMBO.h / 2 - 0.28, z: jz[1] - 0.06 });
    // hangers up to the beam
    for (const sx of [-1, 1]) {
      link(p, [sx * 3.4, jy + JUMBO.h / 2 + 0.3, jz[1]], [sx * 3.4, 9.05, jz[1]], 0.07, C.steelDark, 5);
    }
    const gantry = solidMesh(p);
    gantry.userData.tagId = 'speedway/gantry';
    scene.add(gantry);
    this.tagged.set('gantry', gantry);

    // the screen itself
    this._boardTex = boardTexture();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(JUMBO.w, JUMBO.h), screenMat(this._boardTex));
    face.position.set(jz[0], jy, jz[1] + 0.21);
    scene.add(face);
    this._boardFace = face;
    this.tagged.set('jumbotron', face);

    // five starting lamps under the beam: decorative, and they breathe at night
    const lamps = [];
    for (let i = 0; i < 5; i++) {
      part(lamps, new THREE.SphereGeometry(0.3, 10, 8), i < 3 ? C.coral : C.gold, {
        x: -2.4 + i * 1.2, y: 8.5, z: jz[1] + 0.34,
      });
    }
    const lampMesh = glowMesh(lamps);
    scene.add(lampMesh);
    this._gantryLamps = lampMesh;
    this._gantryLampMat = lampMesh.userData.mat;

    // the towers stand on the tarmac, north of the walkable edge: no colliders
    // are needed, but the paddock-side feet of the board's shadow are.
  }

  /** Local (lx, lz) in the grandstand's frame -> world (x, z). */
  _standWorld(lx, lz, out) {
    const c = Math.cos(STAND.yaw);
    const s = Math.sin(STAND.yaw);
    out.x = STAND.x + lx * c + lz * s;
    out.z = STAND.z - lx * s + lz * c;
    return out;
  }

  /**
   * The grandstand: seven tiers of cream steps under a striped fete awning,
   * angled north-east so the crowd faces the start line AND still shows the
   * play camera its face instead of its back.
   */
  _grandstand(scene) {
    const at = spotAt('grandstand');
    const yaw = SPOT_BY_ID.get('grandstand').yaw ?? STAND.yaw;
    STAND.x = at[0]; STAND.z = at[1]; STAND.yaw = yaw;

    const g = new THREE.Group();
    g.position.set(STAND.x, 0, STAND.z);
    g.rotation.y = yaw;
    scene.add(g);

    const p = [];
    const W = 6.8;
    for (let i = 0; i < STAND.rows; i++) {
      const z = -3.0 + i * 0.9;
      const h = 0.34 + i * 0.34;
      part(p, new THREE.BoxGeometry(W, h, 0.92), i % 2 ? C.cream : C.creamShade, { y: h / 2, z });
      part(p, new THREE.BoxGeometry(W, 0.12, 0.98), C.coral, { y: h + 0.02, z });
      part(p, new THREE.BoxGeometry(W + 0.24, 0.1, 0.2), C.woodLit, { y: h + 0.06, z: z - 0.44 });
    }
    // side cheeks and a front rail
    for (const sx of [-1, 1]) {
      part(p, new THREE.BoxGeometry(0.28, 2.6, 6.4), C.creamShade, { x: sx * (W / 2 + 0.1), y: 1.3, z: -0.3 });
    }
    for (let i = 0; i <= 8; i++) {
      part(p, new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6), C.steelDark, { x: -W / 2 + i * (W / 8), y: 0.5, z: -3.6 });
    }
    link(p, [-W / 2, 0.95, -3.6], [W / 2, 0.95, -3.6], 0.045, C.steel, 5);
    // awning over the back rows only: the front three stay open to the camera
    for (const sx of [-1, 1]) {
      part(p, new THREE.CylinderGeometry(0.09, 0.09, 4.4, 6), C.wood, { x: sx * (W / 2 - 0.2), y: 2.2, z: 3.0 });
      part(p, new THREE.CylinderGeometry(0.09, 0.09, 3.4, 6), C.wood, { x: sx * (W / 2 - 0.2), y: 1.7, z: 0.9 });
    }
    for (let i = 0; i < 10; i++) {
      part(p, new THREE.BoxGeometry(W / 10 + 0.02, 0.1, 2.6), i % 2 ? C.coral : C.cream, {
        x: -W / 2 + (i + 0.5) * (W / 10), y: 3.9, z: 1.95, rx: 0.24,
      });
    }
    part(p, new THREE.BoxGeometry(W + 0.3, 0.24, 0.14), C.gold, { y: 3.62, z: 0.78, rx: 0.24 });
    g.add(solidMesh(p));
    g.userData.tagId = 'speedway/grandstand';
    this.tagged.set('grandstand', g);
    this._stand = g;

    // colliders: four fat circles along the block, in world space
    for (let i = -1; i <= 2; i++) {
      this._standWorld(i * 1.9 - 0.9, -0.2, _v3);
      this.obstacles.push({ x: _v3.x, z: _v3.z, r: 2.35 });
    }

    // ---- the crowd (one instanced family, stand + pit wall together) ------
    const rng = mulberry32(90210);
    const FUR = [0xb08a5a, 0x8a6642, 0x6b4f35, 0xc9a06a, 0xa2795a, 0xd8b98a];
    const seats = [];
    for (let r = 0; r < STAND.rows; r++) {
      const y = 0.34 + r * 0.34 + 0.1;
      const lz = -3.0 + r * 0.9 + 0.12;
      const cols = 7;
      for (let i = 0; i < cols; i++) {
        if (rng() < 0.22) continue; // a few empty seats: a full house is a wall
        const lx = -2.7 + i * 0.9 + (rng() - 0.5) * 0.16;
        this._standWorld(lx, lz, _v3);
        seats.push({
          x: _v3.x, y, z: _v3.z, yaw: STAND.yaw + Math.PI + (rng() - 0.5) * 0.35,
          col: FUR[(rng() * FUR.length) | 0], ph: rng() * TAU, sc: 0.9 + rng() * 0.22,
        });
      }
    }
    // watchers leaning on the pit wall, spread so they never block a prompt
    for (let i = 0; i < 9; i++) {
      const x = -16 + i * 4 + (rng() - 0.5) * 1.2;
      if (Math.abs(x) < 3.2) continue;           // keep the sign-on easel clear
      if (Math.abs(x - spotAt('play-kart')[0]) < 2.4) continue;
      if (Math.abs(x - spotAt('records')[0]) < 2.4) continue;
      seats.push({
        x, y: 0, z: WALL_Z + 1.35 + rng() * 0.4, yaw: Math.PI + (rng() - 0.5) * 0.4,
        col: FUR[(rng() * FUR.length) | 0], ph: rng() * TAU, sc: 0.95 + rng() * 0.2,
      });
    }

    const crowd = new THREE.InstancedMesh(makeCrowdCapyGeo(), makeToon(0xffffff, VC), seats.length);
    crowd.castShadow = true;
    crowd.receiveShadow = true;
    const d = this._dummy;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      d.position.set(s.x, s.y, s.z);
      d.rotation.set(0, s.yaw, 0);
      d.scale.setScalar(s.sc);
      d.updateMatrix();
      crowd.setMatrixAt(i, d.matrix);
      crowd.setColorAt(i, _col.setHex(s.col));
    }
    crowd.instanceMatrix.needsUpdate = true;
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    crowd.computeBoundingSphere();
    crowd.userData.tagId = 'speedway/crowd';
    scene.add(crowd);
    this.tagged.set('crowd', crowd);
    this._crowd = crowd;
    this._crowdData = seats;
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);
  }

  /** Snack cart, marquee and deck chairs: the fete half of the paddock. */
  _fetePavilion(scene) {
    const cart = spotAt('snack-cart');
    const cyaw = SPOT_BY_ID.get('snack-cart').yaw ?? -0.62;

    const p = [];
    // --- the cart itself, in world space, yawed by hand so it keeps one mesh
    const cx = cart[0];
    const cz = cart[1];
    const cs = Math.cos(cyaw);
    const sn = Math.sin(cyaw);
    const at = (lx, lz) => [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
    const body = at(0, 0);
    part(p, new THREE.BoxGeometry(2.6, 1.1, 1.3), C.coral, { x: body[0], y: 0.85, z: body[1], ry: cyaw });
    part(p, new THREE.BoxGeometry(2.66, 0.16, 1.36), C.cream, { x: body[0], y: 1.44, z: body[1], ry: cyaw });
    part(p, new THREE.BoxGeometry(2.2, 0.5, 0.1), C.woodLit, { x: body[0], y: 1.62, z: body[1], ry: cyaw });
    for (const s of [-1, 1]) {
      const w = at(s * 1.15, 0.72);
      part(p, new THREE.TorusGeometry(0.34, 0.1, 6, 12), C.woodDark, { x: w[0], y: 0.34, z: w[1], ry: cyaw + Math.PI / 2 });
    }
    // striped canopy on four posts
    for (const [lx, lz] of [[-1.2, -0.7], [1.2, -0.7], [-1.2, 0.7], [1.2, 0.7]]) {
      const q = at(lx, lz);
      part(p, new THREE.CylinderGeometry(0.06, 0.06, 2.5, 6), C.wood, { x: q[0], y: 1.25, z: q[1] });
    }
    for (let i = 0; i < 8; i++) {
      const q = at(-1.4 + (i + 0.5) * 0.35, 0);
      part(p, new THREE.BoxGeometry(0.36, 0.1, 2.0), i % 2 ? C.coral : C.cream, {
        x: q[0], y: 2.55, z: q[1], ry: cyaw,
      });
    }
    const cartMesh = solidMesh(p);
    cartMesh.userData.tagId = 'speedway/snack-cart';
    scene.add(cartMesh);
    this.tagged.set('snack-cart', cartMesh);
    this.obstacles.push({ x: cx, z: cz, r: 1.7 });

    // the menu board, hung on the canopy front and facing the paddock
    const menu = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.86), texMat(snackSignTexture(), { double: true }));
    const mq = at(0, -0.76);
    menu.position.set(mq[0], 1.95, mq[1]);
    menu.rotation.y = cyaw;
    scene.add(menu);

    // --- deck chairs and picnic blankets, instanced / merged
    const rng = mulberry32(31337);
    const chairs = [];
    const blanket = [];
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      const rr = 5.5 + rng() * 8;
      let x = Math.cos(a) * rr + 2.5;
      let z = Math.sin(a) * rr * 0.7 + 4.0;
      const o = outOfZone(x, z, 1.4);
      x = Math.max(PAD.x0 + 1.6, Math.min(PAD.x1 - 1.6, o.x));
      z = Math.max(PAD.z0 + 2.2, Math.min(PAD.z1 - 1.6, o.z));
      if (Math.abs(x) < 2.0 && z < 14) continue;           // keep the main path clear
      chairs.push({ x, z, yaw: Math.atan2(0 - x, -9 - z) + (rng() - 0.5) * 0.8 });
      if (i % 3 === 0) {
        part(blanket, new THREE.PlaneGeometry(2.0, 1.6), i % 2 ? C.sky : C.gold, {
          rx: -Math.PI / 2, x: x + 1.3, y: 0.015, z: z + 0.9, ry: rng() * TAU,
        });
      }
    }
    const chairMesh = new THREE.InstancedMesh(makeDeckChairGeo(), makeToon(0xffffff, VC), chairs.length);
    chairMesh.castShadow = true;
    chairMesh.receiveShadow = true;
    const d = this._dummy;
    for (let i = 0; i < chairs.length; i++) {
      d.position.set(chairs[i].x, 0, chairs[i].z);
      d.rotation.set(0, chairs[i].yaw, 0);
      d.updateMatrix();
      chairMesh.setMatrixAt(i, d.matrix);
      this.obstacles.push({ x: chairs[i].x, z: chairs[i].z, r: 0.62 });
    }
    chairMesh.instanceMatrix.needsUpdate = true;
    chairMesh.computeBoundingSphere();
    chairMesh.userData.tagId = 'speedway/deck-chairs';
    scene.add(chairMesh);
    this.tagged.set('deck-chairs', chairMesh);
    d.rotation.set(0, 0, 0);
    if (blanket.length) scene.add(solidMesh(blanket, { shadow: false }));
  }

  /**
   * Three plinths by the practice prompt showing what actually comes out of the
   * item boxes, so a first-timer meets the melon peel BEFORE it meets them.
   */
  _itemDisplay(scene) {
    const play = spotAt('play-kart');
    const slots = [
      { dx: -1.7, dz: -1.7, title: 'MELON PEEL', sub: 'drop it. giggle.', hex: C.leaf },
      { dx: 0.0, dz: -2.1, title: 'SPLASH BUBBLE', sub: 'fire it forward', hex: C.sky },
      { dx: 1.7, dz: -1.7, title: 'ZOOM BERRY', sub: 'a short, silly boost', hex: C.coral },
    ];
    const plinths = [];
    const geo = makePlinthGeo();
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const x = play[0] + s.dx;
      const z = play[1] + s.dz;
      const g = geo.clone();
      g.translate(x, 0, z);
      plinths.push(g);
      this.obstacles.push({ x, z, r: 0.66 });
      const plaque = new THREE.Mesh(
        new THREE.PlaneGeometry(0.8, 0.4),
        texMat(itemPlaqueTexture(s.title, s.sub, s.hex), { double: true }),
      );
      plaque.position.set(x, 0.72, z + 0.37);
      plaque.rotation.x = -0.26;
      scene.add(plaque);
    }
    geo.dispose();
    const mesh = new THREE.Mesh(mergeParts(plinths), makeToon(0xffffff, VC));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.tagId = 'speedway/item-plinths';
    scene.add(mesh);
    this.tagged.set('item-plinths', mesh);

    const boxes = new THREE.InstancedMesh(makeItemBoxGeo(), makeGlow(0xffffff, { unique: true }), slots.length);
    boxes.material.vertexColors = true;
    boxes.material.needsUpdate = true;
    const d = this._dummy;
    const data = [];
    for (let i = 0; i < slots.length; i++) {
      const x = play[0] + slots[i].dx;
      const z = play[1] + slots[i].dz;
      data.push({ x, y: 1.55, z, ph: i * 2.1 });
      d.position.set(x, 1.55, z);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      boxes.setMatrixAt(i, d.matrix);
      boxes.setColorAt(i, _col.setHex(slots[i].hex));
    }
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    boxes.computeBoundingSphere();
    scene.add(boxes);
    this._itemBoxes = boxes;
    this._itemBoxData = data;

    // and a parked practice kart beside them, so the prompt has a prop. Built
    // in its own group at the origin and yawed by the GROUP, because `part()`
    // applies rx/ry/rz in that order and a wheel needs its rz (lay it on its
    // side) to happen before any yaw.
    const p = [];
    const kx = play[0] + 2.6;
    const kz = play[1] + 0.5;
    part(p, new THREE.BoxGeometry(1.1, 0.42, 1.6), C.gold, { y: 0.42 });
    part(p, new THREE.BoxGeometry(0.72, 0.4, 0.62), C.cream, { y: 0.78, z: -0.3 });
    part(p, new THREE.BoxGeometry(0.9, 0.12, 0.5), C.coral, { y: 0.66, z: 0.62 });
    part(p, new THREE.CylinderGeometry(0.05, 0.05, 0.42, 6), C.steelDark, { rx: 0.5, y: 0.84, z: 0.24 });
    part(p, new THREE.TorusGeometry(0.16, 0.05, 5, 10), C.coral, { rx: 1.1, y: 1.0, z: 0.32 });
    part(p, new THREE.CylinderGeometry(0.2, 0.2, 0.03, 12), C.cream, { rx: Math.PI / 2, y: 0.52, z: 0.82 });
    for (const [ox, oz] of [[-0.55, -0.52], [0.55, -0.52], [-0.55, 0.52], [0.55, 0.52]]) {
      part(p, new THREE.CylinderGeometry(0.3, 0.3, 0.22, 10), C.tyre, { rz: Math.PI / 2, x: ox, y: 0.3, z: oz });
    }
    const kart = solidMesh(p);
    kart.position.set(kx, 0, kz);
    kart.rotation.y = -0.55;
    kart.userData.tagId = 'speedway/practice-kart';
    scene.add(kart);
    this.tagged.set('practice-kart', kart);
    this.obstacles.push({ x: kx, z: kz, r: 1.0 });
  }

  /** The sign-on sheet on its easel: the prop the race-join prompt belongs to. */
  _signOnEasel(scene) {
    const at = spotAt('race-join');
    const x = at[0];
    const z = at[1] - 2.1;
    const p = [];
    for (const sx of [-1, 1]) {
      part(p, new THREE.CylinderGeometry(0.07, 0.09, 2.2, 6), C.wood, { x: x + sx * 0.9, y: 1.1, z, rz: sx * 0.1 });
    }
    part(p, new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6), C.woodDark, { x, y: 0.75, z: z - 0.5, rx: 0.5 });
    part(p, new THREE.BoxGeometry(2.9, 1.25, 0.14), C.woodLit, { x, y: 1.75, z });
    part(p, new THREE.BoxGeometry(3.05, 0.16, 0.2), C.coral, { x, y: 2.44, z });
    part(p, new THREE.BoxGeometry(2.0, 0.14, 0.5), C.woodDark, { x, y: 1.02, z });
    const easel = solidMesh(p);
    easel.userData.tagId = 'speedway/sign-on';
    scene.add(easel);
    this.tagged.set('sign-on', easel);
    this.obstacles.push({ x, z, r: 0.8 });

    this._signTex = signOnTexture();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(2.72, 1.06), texMat(this._signTex));
    face.position.set(x, 1.76, z + 0.08);
    scene.add(face);
    this._signFace = face;
  }

  /** The lap-records board, nailed to a post by the pit wall. */
  _recordsBoard(scene) {
    const at = spotAt('records');
    const x = at[0];
    const z = at[1] - 1.1;
    const p = [];
    part(p, new THREE.CylinderGeometry(0.09, 0.11, 2.0, 7), C.wood, { x, y: 1.0, z });
    part(p, new THREE.BoxGeometry(1.7, 1.2, 0.12), C.woodDark, { x, y: 1.85, z });
    part(p, new THREE.BoxGeometry(1.86, 0.18, 0.22), C.gold, { x, y: 2.52, z });
    part(p, new THREE.BoxGeometry(0.5, 0.06, 0.5), C.woodLit, { x, y: 0.03, z });
    const post = solidMesh(p);
    post.userData.tagId = 'speedway/records';
    scene.add(post);
    this.tagged.set('records', post);
    this.obstacles.push({ x, z, r: 0.55 });

    const best = Number(this._game?.state?.bests?.kart) || 0;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), texMat(recordsTexture(best)));
    face.position.set(x, 1.85, z + 0.07);
    scene.add(face);
  }

  /** The paddock gate: a bunting-draped arch back over the dunes to the plaza. */
  _plazaGate(scene) {
    const at = spotAt('exit-plaza');
    const x = at[0];
    const z = at[1] + 1.3;
    const p = [];
    for (const sx of [-1, 1]) {
      part(p, new THREE.CylinderGeometry(0.19, 0.24, 4.0, 8), C.wood, { x: x + sx * 3.1, y: 2.0, z });
      part(p, new THREE.BoxGeometry(0.7, 0.22, 0.7), C.woodDark, { x: x + sx * 3.1, y: 0.11, z });
      part(p, new THREE.SphereGeometry(0.24, 8, 6), C.gold, { x: x + sx * 3.1, y: 4.1, z });
    }
    part(p, new THREE.BoxGeometry(7.0, 0.3, 0.34), C.wood, { x, y: 3.9, z });
    part(p, new THREE.BoxGeometry(6.2, 1.0, 0.16), C.coralDark, { x, y: 3.3, z });
    const arch = solidMesh(p);
    arch.userData.tagId = 'speedway/plaza-gate';
    scene.add(arch);
    this.tagged.set('plaza-gate', arch);
    for (const sx of [-1, 1]) this.obstacles.push({ x: x + sx * 3.1, z, r: 0.5 });

    const banner = new THREE.Mesh(new THREE.PlaneGeometry(6.0, 0.94), texMat(archSignTexture(), { double: true }));
    banner.position.set(x, 3.3, z - 0.1);
    banner.rotation.y = Math.PI;    // faces south, into the paddock
    scene.add(banner);

    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), texMat(gateSignTexture(), { double: true }));
    sign.position.set(x + 3.9, 1.9, z - 0.4);
    sign.rotation.y = 0.25;
    scene.add(sign);
    const p2 = [];
    part(p2, new THREE.CylinderGeometry(0.08, 0.1, 2.0, 6), C.wood, { x: x + 3.9, y: 1.0, z: z - 0.4 });
    scene.add(solidMesh(p2));
  }

  /** Palm rows: the fete's shade, and the frame of every wide shot. */
  _palms(scene) {
    const rng = mulberry32(1607);
    const spots = [];
    // two rows flanking the paddock
    for (let i = 0; i < 6; i++) {
      const z = -6 + i * 4.2 + (rng() - 0.5) * 1.2;
      spots.push({ x: PAD.x0 + 0.9 + (rng() - 0.5) * 0.8, z, s: 0.9 + rng() * 0.5 });
      spots.push({ x: PAD.x1 - 0.9 + (rng() - 0.5) * 0.8, z, s: 0.9 + rng() * 0.5 });
    }
    // a back row along the south dunes, and a sparse row beyond the circuit
    for (let i = 0; i < 5; i++) {
      spots.push({ x: -13 + i * 6.5 + (rng() - 0.5) * 2, z: PAD.z1 + 2.4 + rng() * 2.4, s: 1.0 + rng() * 0.5 });
    }
    for (let i = 0; i < 6; i++) {
      spots.push({ x: -26 + i * 10 + (rng() - 0.5) * 3, z: -19.6 - rng() * 2.2, s: 1.1 + rng() * 0.6 });
    }

    const palms = new THREE.InstancedMesh(makePalmGeo(), makeToon(0xffffff, VC), spots.length);
    palms.castShadow = true;
    palms.receiveShadow = true;
    const d = this._dummy;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      s.yaw = rng() * TAU;
      s.ph = rng() * TAU;
      d.position.set(s.x, 0, s.z);
      d.rotation.set(0, s.yaw, 0);
      d.scale.setScalar(s.s);
      d.updateMatrix();
      palms.setMatrixAt(i, d.matrix);
      // only the ones standing on walkable sand need a collider
      if (s.x > PAD.x0 && s.x < PAD.x1 && s.z > PAD.z0 && s.z < PAD.z1) {
        this.obstacles.push({ x: s.x, z: s.z, r: 0.55 * s.s });
      }
    }
    palms.instanceMatrix.needsUpdate = true;
    palms.computeBoundingSphere();
    palms.userData.tagId = 'speedway/palms';
    scene.add(palms);
    this.tagged.set('palms', palms);
    this._palmMesh = palms;
    this._palmData = spots;
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);
  }

  /**
   * Bunting: the single prop that turns a racetrack into a village fete. Cords
   * and poles merge into one mesh; the flags are one instanced family that
   * swings with the wind (see _relight for where the wind comes from).
   */
  _bunting(scene) {
    const posts = [];
    const flags = [];
    const rng = mulberry32(555);
    // a run along each long edge and one across the paddock gate
    const runs = [
      { x0: PAD.x0 + 1.2, z0: PAD.z0 + 1.6, x1: PAD.x0 + 1.2, z1: PAD.z1 - 1.2, n: 5 },
      { x0: PAD.x1 - 1.2, z0: PAD.z0 + 1.6, x1: PAD.x1 - 1.2, z1: PAD.z1 - 1.2, n: 5 },
      { x0: -3.1, z0: PAD.z1 - 1.7, x1: 3.1, z1: PAD.z1 - 1.7, n: 2 },
    ];
    for (const r of runs) {
      for (let i = 0; i <= r.n; i++) {
        const u = i / r.n;
        const x = lerp(r.x0, r.x1, u);
        const z = lerp(r.z0, r.z1, u);
        if (i < r.n) {
          const x2 = lerp(r.x0, r.x1, (i + 1) / r.n);
          const z2 = lerp(r.z0, r.z1, (i + 1) / r.n);
          // sag the cord in three chords so it hangs rather than points
          const h = 2.9;
          for (let k = 0; k < 3; k++) {
            const a = k / 3;
            const b = (k + 1) / 3;
            const ya = h - 0.42 * Math.sin(a * Math.PI);
            const yb = h - 0.42 * Math.sin(b * Math.PI);
            link(posts, [lerp(x, x2, a), ya, lerp(z, z2, a)], [lerp(x, x2, b), yb, lerp(z, z2, b)], 0.025, C.creamShade, 4);
          }
          const per = 7;
          for (let f = 1; f < per; f++) {
            const a = f / per;
            flags.push({
              x: lerp(x, x2, a),
              y: h - 0.42 * Math.sin(a * Math.PI) - 0.04,
              z: lerp(z, z2, a),
              hex: [C.coral, C.gold, C.sky, C.leaf, C.cream][f % 5],
              ph: rng() * TAU,
              yaw: Math.atan2(x2 - x, z2 - z),
            });
          }
        }
        if (r.n > 2 || i === 0 || i === r.n) {
          part(posts, new THREE.CylinderGeometry(0.08, 0.1, 3.0, 6), C.wood, { x, y: 1.5, z });
          part(posts, new THREE.SphereGeometry(0.14, 7, 5), C.gold, { x, y: 3.05, z });
          if (x > PAD.x0 && x < PAD.x1 && z > PAD.z0 && z < PAD.z1) {
            this.obstacles.push({ x, z, r: 0.34 });
          }
        }
      }
    }
    // pennant poles either side of the gantry approach
    for (const sx of [-1, 1]) {
      const x = sx * 12.5;
      const z = -8.9;
      part(posts, new THREE.CylinderGeometry(0.07, 0.09, 4.6, 6), C.cream, { x, y: 2.3, z });
      part(posts, new THREE.SphereGeometry(0.13, 7, 5), C.coral, { x, y: 4.66, z });
      for (let i = 0; i < 4; i++) {
        flags.push({
          x, y: 4.2 - i * 0.42, z, hex: i % 2 ? C.coral : C.gold, ph: rng() * TAU, yaw: Math.PI / 2,
        });
      }
      this.obstacles.push({ x, z, r: 0.35 });
    }

    const cordMesh = solidMesh(posts, { shadow: false });
    cordMesh.userData.tagId = 'speedway/bunting-cords';
    scene.add(cordMesh);

    const mesh = new THREE.InstancedMesh(makeBuntingFlagGeo(), makeToon(0xffffff, VC), flags.length);
    mesh.castShadow = false;
    const d = this._dummy;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      d.position.set(f.x, f.y, f.z);
      d.rotation.set(0, f.yaw, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      mesh.setColorAt(i, _col.setHex(f.hex));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData.tagId = 'speedway/bunting';
    scene.add(mesh);
    this.tagged.set('bunting', mesh);
    this._flagMesh = mesh;
    this._flagData = flags;
    d.rotation.set(0, 0, 0);
  }

  /** Straw bales and marker cones: the trackside furniture, two families. */
  _scatter(scene) {
    const rng = mulberry32(8080);
    const bales = [];
    for (let i = 0; i < 12; i++) {
      const a = rng();
      let x; let z; let yaw;
      if (i < 7) {                       // a run along the pit apron
        x = -15 + i * 4.6 + (rng() - 0.5) * 1.4;
        z = -9.3 + (rng() - 0.5) * 0.5;
        yaw = 0;
        if (Math.abs(x) < 3.6) continue;              // the sign-on easel's space
        if (Math.abs(x - spotAt('play-kart')[0]) < 3.0) continue;
        if (Math.abs(x - spotAt('records')[0]) < 2.8) continue;
      } else {                           // a cluster by the fete
        const ang = a * TAU;
        const o = outOfZone(Math.cos(ang) * 9 - 3, Math.sin(ang) * 7 + 8, 1.4);
        x = Math.max(PAD.x0 + 1.4, Math.min(PAD.x1 - 1.4, o.x));
        z = Math.max(PAD.z0 + 1.8, Math.min(PAD.z1 - 1.4, o.z));
        yaw = rng() * TAU;
        if (Math.abs(x) < 1.8) continue;
      }
      bales.push({ x, z, yaw, s: 0.9 + rng() * 0.35 });
    }
    const baleMesh = new THREE.InstancedMesh(makeBaleGeo(), makeToon(0xffffff, VC), bales.length);
    baleMesh.castShadow = true;
    baleMesh.receiveShadow = true;
    const d = this._dummy;
    for (let i = 0; i < bales.length; i++) {
      const b = bales[i];
      d.position.set(b.x, 0, b.z);
      d.rotation.set(0, b.yaw, 0);
      d.scale.setScalar(b.s);
      d.updateMatrix();
      baleMesh.setMatrixAt(i, d.matrix);
      this.obstacles.push({ x: b.x, z: b.z, r: 0.62 * b.s });
    }
    baleMesh.instanceMatrix.needsUpdate = true;
    baleMesh.computeBoundingSphere();
    baleMesh.userData.tagId = 'speedway/bales';
    scene.add(baleMesh);
    this.tagged.set('bales', baleMesh);

    // cones: on the tarmac side of the wall, marking the pit entry. No colliders
    // (nobody can reach them) and no shadows (they are set dressing).
    const cones = [];
    for (let i = 0; i < 16; i++) cones.push({ x: -13 + i * 1.8, z: WALL_Z - 1.5 - Math.sin(i * 0.5) * 0.4 });
    const coneMesh = new THREE.InstancedMesh(makeConeGeo(), makeToon(0xffffff, VC), cones.length);
    coneMesh.receiveShadow = true;
    for (let i = 0; i < cones.length; i++) {
      d.position.set(cones[i].x, 0, cones[i].z);
      d.rotation.set(0, i * 0.4, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      coneMesh.setMatrixAt(i, d.matrix);
    }
    coneMesh.instanceMatrix.needsUpdate = true;
    coneMesh.computeBoundingSphere();
    scene.add(coneMesh);
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(1);
  }

  /** Gulls, circling the paddock exactly as gulls do at a seaside fete. */
  _gulls(scene) {
    const rng = mulberry32(2468);
    const n = 7;
    const mesh = new THREE.InstancedMesh(makeGullGeo(), makeToon(0xffffff, VC), n);
    const data = [];
    for (let i = 0; i < n; i++) {
      data.push({
        cx: -6 + rng() * 14, cz: -2 + rng() * 10,
        r: 5 + rng() * 7, y: 6.5 + rng() * 4.5,
        sp: 0.22 + rng() * 0.2, ph: rng() * TAU, s: 0.8 + rng() * 0.5,
      });
    }
    mesh.frustumCulled = false;
    scene.add(mesh);
    this._gullMesh = mesh;
    this._gullData = data;
  }

  /** Rain: dormant until the world clock says so, then a light seaside veil. */
  _rain(scene) {
    const n = 420;
    const rng = mulberry32(999);
    const pos = new Float32Array(n * 3);
    const spd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = PAD.x0 - 4 + rng() * (PAD_W + 8);
      pos[i * 3 + 1] = rng() * 14;
      pos[i * 3 + 2] = PAD.z0 - 6 + rng() * (PAD_D + 10);
      spd[i] = 9 + rng() * 7;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.15, map: dotTexture('rgba(214,238,255,0.9)', 'rgba(214,238,255,0)'),
      transparent: true, opacity: 0.65, depthWrite: false, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.visible = false;
    geo.setDrawRange(0, 0);
    scene.add(pts);
    this._rain3 = { pts, geo, mat, attr: geo.attributes.position, spd, n };
  }

  /* --- per-frame ---------------------------------------------------------- */

  update(dt, _game) {
    const t = (this.t += dt);
    this._relight(dt);

    const d = this._dummy;

    // sea swell: three crossed sine trains, written straight into the buffer
    const sea = this._sea3;
    if (sea) {
      const arr = sea.attr.array;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i];
        const z = arr[i + 2];
        arr[i + 1] = 0.22 * Math.sin(x * 0.06 + t * 0.9)
          + 0.16 * Math.sin(z * 0.09 - t * 0.7)
          + 0.1 * Math.sin((x + z) * 0.04 + t * 1.6);
      }
      sea.attr.needsUpdate = true;
    }
    if (this._foamMat?.map) {
      this._foamMat.map.offset.x = (t * 0.035) % 1;
      this._foamMat.opacity = 0.72 + 0.16 * Math.sin(t * 0.9);
    }

    // gulls, riding their own lazy circles
    const gulls = this._gullMesh;
    if (gulls) {
      for (let i = 0; i < this._gullData.length; i++) {
        const g = this._gullData[i];
        const a = g.ph + t * g.sp;
        d.position.set(g.cx + Math.cos(a) * g.r, g.y + Math.sin(t * 0.7 + g.ph) * 0.5, g.cz + Math.sin(a) * g.r * 0.72);
        d.rotation.set(0, -a + Math.PI / 2, Math.sin(a * 2 + g.ph) * 0.28);
        d.scale.setScalar(g.s);
        d.updateMatrix();
        gulls.setMatrixAt(i, d.matrix);
      }
      gulls.instanceMatrix.needsUpdate = true;
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
    }

    // palms lean on the sea breeze
    const palms = this._palmMesh;
    if (palms) {
      for (let i = 0; i < this._palmData.length; i++) {
        const s = this._palmData[i];
        const sway = Math.sin(t * 0.8 + s.ph) * 0.045 * this._windK;
        d.position.set(s.x, 0, s.z);
        d.rotation.set(sway * 0.7, s.yaw + sway, sway);
        d.scale.setScalar(s.s);
        d.updateMatrix();
        palms.setMatrixAt(i, d.matrix);
      }
      palms.instanceMatrix.needsUpdate = true;
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
    }

    // bunting flutters harder than the palms: it is lighter
    const flags = this._flagMesh;
    if (flags) {
      for (let i = 0; i < this._flagData.length; i++) {
        const f = this._flagData[i];
        const w = Math.sin(t * 2.6 + f.ph) * 0.34 * this._windK;
        d.position.set(f.x, f.y, f.z);
        d.rotation.set(w * 0.8, f.yaw, w);
        d.scale.set(1, 1, 1);
        d.updateMatrix();
        flags.setMatrixAt(i, d.matrix);
      }
      flags.instanceMatrix.needsUpdate = true;
      d.rotation.set(0, 0, 0);
    }

    // the crowd: nothing organic is ever perfectly still (DESIGN.md)
    const crowd = this._crowd;
    if (crowd) {
      const hype = this._boardLive ? 1.9 : 1.0;
      for (let i = 0; i < this._crowdData.length; i++) {
        const s = this._crowdData[i];
        const bob = Math.sin(t * (1.6 + (i % 5) * 0.11) + s.ph) * 0.035 * hype;
        d.position.set(s.x, s.y + Math.max(0, bob) * 1.6, s.z);
        d.rotation.set(0, s.yaw + bob * 0.5, 0);
        d.scale.set(s.sc, s.sc * (1 + bob * 0.12), s.sc);
        d.updateMatrix();
        crowd.setMatrixAt(i, d.matrix);
      }
      crowd.instanceMatrix.needsUpdate = true;
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
    }

    // the display item boxes spin and bob, exactly like the ones on track
    const boxes = this._itemBoxes;
    if (boxes) {
      for (let i = 0; i < this._itemBoxData.length; i++) {
        const b = this._itemBoxData[i];
        d.position.set(b.x, b.y + Math.sin(t * 1.5 + b.ph) * 0.12, b.z);
        d.rotation.set(0.3, t * 1.1 + b.ph, 0.2);
        d.scale.setScalar(1);
        d.updateMatrix();
        boxes.setMatrixAt(i, d.matrix);
      }
      boxes.instanceMatrix.needsUpdate = true;
      d.rotation.set(0, 0, 0);
    }

    // the lighthouse sweeps, and the gantry lamps breathe after dark
    if (this._beaconMat) {
      this._beaconMat.opacity = (0.25 + 0.75 * Math.pow(Math.max(0, Math.sin(t * 0.8)), 6)) * (0.35 + 0.65 * this._nightK);
    }
    if (this._gantryLampMat) {
      this._gantryLampMat.opacity = 1;
      const k = this._boardLive ? 0.75 + 0.25 * Math.sin(t * 6) : 0.55 + 0.45 * Math.sin(t * 1.3);
      this._gantryLampMat.color.setRGB(k, k * 0.85, k * 0.7);
    }

    // rain
    const rain = this._rain3;
    if (rain && this._rainNow > 0.002) {
      const arr = rain.attr.array;
      const shown = Math.round(rain.n * Math.min(1, this._rainNow));
      for (let i = 0; i < shown; i++) {
        let y = arr[i * 3 + 1] - rain.spd[i] * dt;
        if (y < -0.2) {
          y = 12 + Math.random() * 3;
          arr[i * 3] = PAD.x0 - 4 + Math.random() * (PAD_W + 8);
          arr[i * 3 + 2] = PAD.z0 - 6 + Math.random() * (PAD_D + 10);
        }
        arr[i * 3 + 1] = y;
      }
      rain.attr.needsUpdate = true;
    }

    // ---- the jumbotron ----------------------------------------------------
    // A race that stops sending board frames (server restart, everyone quit)
    // must not leave stale standings hanging over the paddock forever.
    if (this._boardLive) {
      this._liveT += dt;
      if (this._liveT > 8) this._boardIdle();
    } else {
      this._tickT += dt;
      if (this._tickT > 6) {
        this._tickT = 0;
        this._board.tick++;
        this._boardDirty = true;
      }
    }
    if (this._boardDirty) this._paintBoard();
  }

  /* --- world clock (LIVING-COVE section A) -------------------------------- */

  /**
   * Server clock frame, plus one call right after build so a night arrival
   * never flashes noon first. `weather` is a WORD from the outdoor family;
   * anything unrecognised is a clear day.
   */
  onClock(dayT, weather, _aurora) {
    const t = Number(dayT);
    if (Number.isFinite(t)) {
      const next = ((t % 1) + 1) % 1;
      // The local phase runs on between the server's 10s frames, so a frame
      // that agrees to within ~30 cove-seconds is left alone: only a real
      // disagreement (reconnect, restart, first frame) moves the hands.
      const drift = Math.abs(((next - this._dayT + 1.5) % 1) - 0.5);
      if (!this._hasClock || drift > 0.012) this._dayT = next;
    }
    this._weather = readWeather(weather);
    this._rainWant = this._weather === 'rain' ? 1 : 0;
    this._hasClock = true;
  }

  /**
   * The whole paddock on the day curve: sky, fog, sun, fills, lamps, sea and
   * weather. Runs every frame off a locally advanced dayT (never Date), lerping
   * into preallocated colours so the clock allocates nothing per frame.
   */
  _relight(dt) {
    this._dayT = (this._dayT + dt / DAY_SECONDS) % 1;
    // four stops, wrapping: dawn 0.0, noon 0.25, dusk 0.5, night 0.75
    const u = this._dayT * 4;
    const i0 = Math.floor(u) % 4;
    const i1 = (i0 + 1) % 4;
    const f = u - Math.floor(u);
    const w = f * f * (3 - 2 * f);
    const a = SKY[i0];
    const b = SKY[i1];
    // how "night" each stop reads, for the lamps, stars and beacon
    const night = clamp01(lerp(NIGHTNESS[i0], NIGHTNESS[i1], w));
    this._nightK = night;

    // first frame lands on the phase; after that everything eases (~0.4s)
    const k = this._litOnce ? Math.min(1, dt * 2.5) : 1;
    this._litOnce = true;

    if (this._skyMat) this._skyMat.color.lerp(mixHex(a.mid, b.mid, w, _mix), k);
    if (this._bgColor) this._bgColor.lerp(mixHex(a.hor, b.hor, w, _mix), k);
    if (this._fog) this._fog.color.lerp(mixHex(a.fog, b.fog, w, _mix), k);

    const sun = this._sun;
    if (sun) {
      // one arc across the sky, keeping the authored noon bearing so dayT 0.25
      // reproduces the look this room was dressed under
      const az = NOON_AZ + (this._dayT - 0.25) * TAU;
      const elev = Math.cos((this._dayT - 0.25) * TAU);
      sun.position.set(
        Math.cos(az) * SUN_R,
        Math.max(6, 16 + 30 * elev),
        Math.sin(az) * SUN_R,
      );
      sun.color.lerp(mixHex(a.sun, b.sun, w, _mix), k);
      sun.intensity += (lerp(a.sunI, b.sunI, w) - sun.intensity) * k;
      if (this._sunDisc) {
        _v3.copy(sun.position).normalize().multiplyScalar(180);
        this._sunDisc.position.copy(_v3);
        this._sunDisc.lookAt(0, 10, 0);
      }
      if (this._skyMesh) {
        _v3.copy(sun.position).normalize();
        this._skyMesh.rotation.y = Math.atan2(-_v3.z, _v3.x);
      }
    }
    if (this._sunDiscMat) {
      this._sunDiscMat.color.lerp(mixHex(a.sun, b.sun, w, _mix), k);
      this._sunDiscMat.opacity = 0.35 + 0.5 * (1 - night);
    }
    if (this._hemi) {
      this._hemi.color.lerp(mixHex(a.hemiS, b.hemiS, w, _mix), k);
      this._hemi.groundColor.lerp(mixHex(a.hemiG, b.hemiG, w, _mix), k);
      this._hemi.intensity += (lerp(a.hemiI, b.hemiI, w) - this._hemi.intensity) * k;
    }
    if (this._amb) {
      this._amb.color.lerp(mixHex(a.amb, b.amb, w, _mix), k);
      this._amb.intensity += (lerp(a.ambI, b.ambI, w) - this._amb.intensity) * k;
    }
    if (this._sea3?.mat) this._sea3.mat.color.lerp(mixHex(a.sea, b.sea, w, _mix), k);

    // lamps: dark at noon, full after dusk, eased so nothing snaps on
    const lampWant = lerp(a.lamp, b.lamp, w);
    this._lampK += (lampWant - this._lampK) * Math.min(1, dt * 0.8);
    if (this._gantryLight) this._gantryLight.intensity = 26 * this._lampK;
    if (this._cartLight) this._cartLight.intensity = 12 * this._lampK;

    if (this._stars) {
      const op = Math.max(0, (night - 0.4) / 0.6) * 0.9;
      this._stars.visible = op > 0.01;
      if (this._starMat) this._starMat.opacity = op;
    }

    // weather: rain fades in and out, and the wind picks up with it
    this._rainNow += (this._rainWant - this._rainNow) * Math.min(1, dt * 0.5);
    const rain = this._rain3;
    if (rain) {
      const shown = Math.round(rain.n * Math.min(1, this._rainNow));
      rain.geo.setDrawRange(0, shown);
      rain.pts.visible = shown > 0;
      rain.mat.opacity = 0.65 * Math.min(1, this._rainNow * 1.4);
    }
    const windWant = this._weather === 'breeze' ? 2.1 : (this._weather === 'rain' ? 1.6 : 1);
    this._windK += (windWant - this._windK) * Math.min(1, dt * 0.6);
  }

  /* --- dev layout editor (Ctrl+E) ----------------------------------------- */

  /**
   * Every draggable number of a landmark, as a labelled pin. Each one is a real
   * coordinate in the SPOTS table, so dropping a pin and rebuilding moves the
   * prop, its prompt zone, its collider and its sign together.
   */
  editorHandles(id) {
    const s = SPOT_BY_ID.get(id);
    if (!s) return [];
    const out = [{ key: 'at', label: `${id}: spot`, xz: s.at, color: 0xf2b64a, y: s.y ?? 0 }];
    if (s.yaw !== undefined) out[0].yaw = s.yaw;
    return out;
  }

  editorPatch(id, key, xz) {
    return SPOT_BY_ID.has(id) ? { [key]: xz } : null;
  }

  editorPatchAll(id, dx, dz) {
    const s = SPOT_BY_ID.get(id);
    if (!s) return null;
    return { at: [+(s.at[0] + dx).toFixed(2), +(s.at[1] + dz).toFixed(2)] };
  }

  /** The pasteable SPOTS row, as the room currently stands. */
  editorExport(id) {
    const s = SPOT_BY_ID.get(id);
    if (!s) return null;
    const bits = [`at: [${s.at[0].toFixed(2)}, ${s.at[1].toFixed(2)}]`];
    if (s.r !== undefined) bits.push(`r: ${s.r}`);
    if (s.y !== undefined) bits.push(`y: ${s.y}`);
    if (s.yaw !== undefined) bits.push(`yaw: ${s.yaw.toFixed(3)}`);
    return `${id} (SPOTS row):\n  { id: '${id}', ${bits.join(', ')} },`;
  }

  /* --- teardown ----------------------------------------------------------- */

  dispose() {
    // Walking out while signed on must not leave a ghost holding a grid slot.
    // Harmless if the server already dropped us on the room change.
    if (this._signedOn && this._game?.net?.connected) {
      this._game.net.send({ t: 'kart-leave' });
    }
    this._signedOn = false;

    this._offLobby?.();
    this._offGrid?.();
    this._offResume?.();
    this._offBoard?.();
    this._offEnd?.();
    this._offLobby = this._offGrid = this._offResume = this._offBoard = this._offEnd = null;

    // The engine auto-disposes the scene graph (materials created with
    // {unique:true} and their canvas maps included); everything here is just
    // the references that would otherwise outlive the room.
    this._joinSpot = null;
    this._game = null;
    this._roster = [];
    this._board = null;
    this._boardTex = null;
    this._boardFace = null;
    this._signTex = null;
    this._signFace = null;
    this._sea3 = null;
    this._rain3 = null;
    this._foam = null;
    this._foamMat = null;
    this._crowd = null;
    this._crowdData = null;
    this._palmMesh = null;
    this._palmData = null;
    this._flagMesh = null;
    this._flagData = null;
    this._gullMesh = null;
    this._gullData = null;
    this._itemBoxes = null;
    this._itemBoxData = null;
    this._gantryLamps = null;
    this._gantryLampMat = null;
    this._gantryLight = null;
    this._cartLight = null;
    this._beacon = null;
    this._beaconMat = null;
    this._stand = null;
    this._stars = null;
    this._starMat = null;
    this._sun = null;
    this._hemi = null;
    this._amb = null;
    this._skyMesh = null;
    this._skyMat = null;
    this._sunDisc = null;
    this._sunDiscMat = null;
    this._bgColor = null;
    this._fog = null;
    this._dummy = null;
    this.tagged = null;
  }
}
