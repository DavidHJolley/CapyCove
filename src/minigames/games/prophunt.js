import * as THREE from 'three';
import { Minigame } from '../minigame.js';
import { makeToon, canvasTexture, disposeObject } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { MINIGAMES } from '../../../shared/constants.js';

/**
 * Prop Hunt: the Glimmer Mine's party game (docs/PARTY-GAMES.md, wave 6).
 *
 * One SEEKER walks a dressed mine chamber; every other player possesses one of
 * ~30 props and holds very still. Two rounds, seeker rotates. 2-6 players over
 * the wire, or "Seek alone" against 5 AI hiders.
 *
 * DETERMINISM. The chamber and the prop layout are drawn entirely from
 * `seed` (mulberry32), so every client in a match walks byte-identical
 * furniture and a prop index means the same crate on all six screens. Cosmetic
 * randomness (dust motes, particle jitter, popup offsets) stays on Math.random
 * on purpose: it never touches the seeded stream.
 *
 * MULTIPLAYER HANDSHAKE. The mine room parks
 *   game.__partyCtx = { game:'prophunt', seed, players:[{id,name,color,hat}],
 *                       seekerId, youAre:'seeker'|'hider' }
 * on 'ph-start' and then calls startMinigame('prophunt'). Anything malformed
 * (wrong game, <2 players, no socket) degrades to a solo run rather than
 * breaking the minigame. Round r's seeker is roster[(seekIdx + r) % n] with the
 * roster sorted by id, so nobody has to negotiate the rotation.
 *
 * ---------------------------------------------------------------------------
 * PH RELAY FRAMES (mirror of the server agent's relay; opaque to the server)
 * ---------------------------------------------------------------------------
 * Client -> server:  { t:'ph-msg', m:<payload> }        server stamps sender id
 * Server -> client:  { t:'ph-state', id:<senderId>, m:<payload> }
 * Client -> server:  { t:'ph-done', score }             at the end of the match
 * Server -> client:  { t:'ph-end', standings:[{id,name,score}] }
 *
 * Payloads (`k` tags the kind; every field is validated on arrival, unknown
 * kinds are ignored, and only the round's seeker may send clk/cat/mis/snf):
 *   { k:'clk', r, ph, t, ms, x, z, ry }  seeker @5Hz: round, phase ('hide'|
 *                                    'seek'), MILLISECONDS left in that phase
 *                                    (`t` is the same number in seconds, kept
 *                                    for readability), and their pose so hiders
 *                                    watch them coming
 *   { k:'hid', r, p, x, z, ry }      hider locks in ONE frame at hide-phase end:
 *                                    prop index + where they parked it (ABSOLUTE
 *                                    chamber coords, since a possessed prop may
 *                                    glide anywhere walkable) + prop yaw
 *   { k:'cat', r, p }                seeker caught whoever is in prop p
 *   { k:'mis', r, x, z }             seeker's wrong click (dust puff everywhere)
 *   { k:'snf', r, x, z }             seeker sniffed here (ripple ring)
 *   { k:'sc',  r, s }                sender's own score for round r
 * The seeker's client is authoritative for catches and for the round clock
 * inside their own round; hiders slave their timer to 'clk'.
 *
 * CLOCKS ARE WALL CLOCKS. Every phase owns an absolute Date.now() deadline
 * (r.introEnd / r.hideEnd / r.seekEnd, this.splashEnd, this.cardEnd) agreed the
 * moment the hunt starts and re-agreed from the seeker's 'clk' frames. NOTHING
 * counts down by accumulating rAF dt: a browser freezes rAF in a background
 * tab, so a tabbed-out capybara would come back minutes behind the round they
 * are standing in. _advance() walks the machine forward to whatever phase the
 * wall clock says we are in, one idempotent transition at a time, which is also
 * why the cave-in curtain can only ever be raised once per round (r.curtain).
 * ---------------------------------------------------------------------------
 *
 * DEVIATIONS from the spec, all deliberate:
 *  - Solo hide phase is 6s, not 25s: the AI hide instantly, so the curtain is
 *    pure theatre and 25s of staring at planks is not a game.
 *  - A possessed prop is not leashed to its shelf: click anywhere walkable and
 *    it glides there (gently: a crate that sprints is a crate that gets found).
 *    The spec's 3-unit nudge made half the chamber unusable and every hider
 *    findable by elimination.
 *  - The seeker must be within REACH (5.5u) to accuse a prop. Clicking a prop
 *    further away walks them to it instead of costing 5 points, so the -5 is
 *    always a real guess and never a misjudged pixel at 30 metres.
 *  - Space "sniffs": a free warm/cold count of hiders within 8u on a 6s
 *    cooldown. With 30 props and a -5 penalty, seeking without any read on the
 *    room is flailing; the sniff makes the sweep systematic (and the ripple
 *    tells hiders they have been smelled, which is half the fun).
 *  - Two hiders may possess the same prop (nobody can see the others' choices
 *    during the hide phase). Catching that prop catches both, +25 each.
 *  - Seeker rotation runs at 2 players too: with two of you, "rotate" is a
 *    swap, and swapping is strictly fairer than seeking twice in a row.
 */

// ---------------------------------------------------------------- tuning ----
const ROUNDS = 2;
const HIDE_SECS = 25;        // party hide phase
const HIDE_SECS_SOLO = 6;    // solo: AI hide instantly, this is just the curtain
const SEEK_SECS = 90;
const SPLASH_SECS = 6;       // party: the splash counts itself down
const INTRO_SECS = 2.4;      // three countdown beats of 0.8s
const CARD_SECS = 6;         // the between-rounds interstitial
const PROP_COUNT = 30;
const SOLO_HIDERS = 5;
const GLIDE_SPEED = 2.4;     // a possessed prop creeps; it never sprints
const GLIDE_TURN = 2.1;
const REACH = 5.5;           // seeker must be this close to accuse
const FIND_POINTS = 25;
const WRONG_PENALTY = 5;
const TICK_SECS = 5;         // +1 survival point per this many seconds alive
const SNIFF_CD = 6;
const SNIFF_R = 8;
const SEEK_SPEED = 6.2;
const CLK_HZ = 5;            // seeker clock/pose broadcasts per second
const HALF_X = 15.5;         // walkable half-extent of the chamber
const HALF_Z = 12.5;
const CEIL_Y = 8.5;
// The seeker starts here, a few paces in from the door: any closer to the wall
// and the camera boom has nowhere to stand and the first frame is all floor.
const SPAWN_Z = HALF_Z - 4.2;
// Nothing structural hangs below this: the walk/prop cameras top out under it,
// and anything above it is registered as fadeable overhead (see _overhead).
const OVERHEAD_Y = 6.3;

const ROCK = 0x6b5b46;
const ROCK_D = 0x4a3d2e;
const ROCK_L = 0x8a785c;
const WOOD = 0x8a6642;
const WOOD_L = 0xb08a5a;
const WOOD_D = 0x6b4f35;
const IRON = 0x5b5750;
const IRON_D = 0x3c3833;
const AMBER = 0xf2b64a;
const TEAL = 0x42d6c8;
const CORAL = 0xe8657a;
const CREAM = 0xfff6e3;

// ---------------------------------------------------------------- helpers ---
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _col = new THREE.Color();

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

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const hex6 = (c) => `#${((c >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;

/** Shortest signed angle from a to b. */
function angDelta(a, b) {
  return ((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

/**
 * Does the segment p->q pass through box `b` (grown by margin m)? Slab test,
 * used to spot the ceiling beam that has parked itself between the camera and
 * whatever the player is trying to watch.
 */
function segHitsBox(px, py, pz, qx, qy, qz, b, m) {
  let t0 = 0;
  let t1 = 1;
  const lo = [b.x0 - m, b.y0 - m, b.z0 - m];
  const hi = [b.x1 + m, b.y1 + m, b.z1 + m];
  const p = [px, py, pz];
  const d = [qx - px, qy - py, qz - pz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-6) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
      continue;
    }
    let a = (lo[i] - p[i]) / d[i];
    let c = (hi[i] - p[i]) / d[i];
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return false;
  }
  return true;
}

/** Squared distance from a point to an axis-aligned box. */
function distToBox2(x, y, z, b) {
  const dx = Math.max(b.x0 - x, 0, x - b.x1);
  const dy = Math.max(b.y0 - y, 0, y - b.y1);
  const dz = Math.max(b.z0 - z, 0, z - b.z1);
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Merge primitive parts into one vertex-coloured BufferGeometry so a
 * multi-colour prop still costs a single draw call. Inputs are consumed.
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
    _e.set(p.rx || 0, p.ry || 0, p.rz || 0);
    _q.setFromEuler(_e);
    _v2.set(p.x || 0, p.y || 0, p.z || 0);
    _sc.set(p.sx ?? p.s ?? 1, p.sy ?? p.s ?? 1, p.sz ?? p.s ?? 1);
    _m4.compose(_v2, _q, _sc);
    _nm.getNormalMatrix(_m4);
    _col.setHex(p.color ?? 0xffffff);
    for (let i = 0; i < gp.count; i++) {
      _v.fromBufferAttribute(gp, i).applyMatrix4(_m4);
      pos.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(gn, i).applyMatrix3(_nm).normalize();
      nor.push(_v.x, _v.y, _v.z);
      cols.push(_col.r, _col.g, _col.b);
    }
    if (g !== src) g.dispose();
    src.dispose();
  }
  if (!pos.length) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return out;
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);
const sph = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const oct = (r) => new THREE.OctahedronGeometry(r, 0);
const dodec = (r) => new THREE.DodecahedronGeometry(r, 0);
const cone = (r, h, s = 8) => new THREE.ConeGeometry(r, h, s);

// ================================================================ props =====
// Eight families from the spec's pool, a couple with a second silhouette so 30
// props on one floor never read as wallpaper. Each builder returns solid parts
// (toon-lit) and glow parts (unlit), merged once per kind and shared by every
// instance, so the whole prop set costs ~40 draw calls.

const PROP_KINDS = [
  {
    id: 'crate', label: 'crate', r: 0.8, h: 1.15,
    build: () => ({
      parts: [
        { geo: box(1.14, 1.04, 1.14), color: WOOD, y: 0.53 },
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({
          geo: box(0.15, 1.08, 0.15), color: WOOD_D, x: sx * 0.53, y: 0.53, z: sz * 0.53,
        })),
        { geo: box(1.2, 0.13, 0.13), color: WOOD_L, y: 0.84, z: 0.57 },
        { geo: box(1.2, 0.13, 0.13), color: WOOD_L, y: 0.84, z: -0.57 },
        { geo: box(0.13, 0.13, 1.2), color: WOOD_L, x: 0.57, y: 0.84 },
        { geo: box(0.13, 0.13, 1.2), color: WOOD_L, x: -0.57, y: 0.84 },
      ],
      glow: [],
    }),
  },
  {
    id: 'crate_stack', label: 'crate stack', r: 0.86, h: 1.85,
    build: () => ({
      parts: [
        { geo: box(1.14, 1.04, 1.14), color: WOOD, y: 0.53 },
        { geo: box(1.2, 0.13, 0.13), color: WOOD_L, y: 0.84, z: 0.57 },
        { geo: box(1.2, 0.13, 0.13), color: WOOD_L, y: 0.84, z: -0.57 },
        { geo: box(0.86, 0.78, 0.86), color: WOOD_L, y: 1.45, ry: 0.42 },
        { geo: box(0.92, 0.1, 0.1), color: WOOD_D, y: 1.68, z: 0.42, ry: 0.42 },
        { geo: box(0.24, 0.06, 0.5), color: WOOD_D, y: 1.87, ry: 0.42 },
      ],
      glow: [],
    }),
  },
  {
    id: 'barrel', label: 'barrel', r: 0.6, h: 1.3,
    build: () => ({
      parts: [
        { geo: cyl(0.5, 0.43, 1.2, 12), color: WOOD, y: 0.6 },
        { geo: cyl(0.53, 0.53, 0.13, 12), color: IRON, y: 0.3 },
        { geo: cyl(0.51, 0.51, 0.13, 12), color: IRON, y: 0.94 },
        { geo: cyl(0.46, 0.46, 0.07, 12), color: WOOD_L, y: 1.22 },
      ],
      glow: [],
    }),
  },
  {
    id: 'lantern', label: 'lantern', r: 0.45, h: 2.05,
    build: () => ({
      parts: [
        { geo: cyl(0.3, 0.36, 0.1, 10), color: IRON_D, y: 0.05 },
        { geo: cyl(0.06, 0.08, 1.5, 8), color: IRON_D, y: 0.8 },
        // an open cage, not a sealed box: the flame has to be SEEN, or a lit
        // lantern reads as a black post with a hat on
        { geo: box(0.34, 0.06, 0.34), color: IRON, y: 1.47 },
        { geo: box(0.34, 0.06, 0.34), color: IRON, y: 1.93 },
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({
          geo: cyl(0.035, 0.035, 0.46, 5), color: IRON, x: sx * 0.14, y: 1.7, z: sz * 0.14,
        })),
        { geo: cone(0.32, 0.22, 8), color: IRON_D, y: 2.06 },
        { geo: cyl(0.03, 0.03, 0.3, 6), color: IRON_D, y: 1.7, x: 0.19, z: 0.19 },
      ],
      glow: [{ geo: sph(0.16, 10, 8), color: AMBER, y: 1.7 }],
    }),
  },
  {
    id: 'rock', label: 'boulder', r: 0.85, h: 1.05,
    build: () => ({
      parts: [
        { geo: dodec(0.74), color: ROCK, y: 0.5, sy: 0.82 },
        { geo: dodec(0.34), color: ROCK_D, x: 0.58, y: 0.24, z: 0.3 },
        { geo: dodec(0.22), color: ROCK_L, x: -0.5, y: 0.16, z: -0.36 },
      ],
      glow: [],
    }),
  },
  {
    id: 'rock_pile', label: 'rubble pile', r: 1.05, h: 1.25,
    build: () => ({
      parts: [
        { geo: dodec(0.62), color: ROCK_D, y: 0.42, sy: 0.9 },
        { geo: dodec(0.5), color: ROCK, x: 0.66, y: 0.3, z: -0.2, sy: 0.85 },
        { geo: dodec(0.42), color: ROCK_L, x: -0.6, y: 0.26, z: 0.34 },
        { geo: dodec(0.36), color: ROCK, y: 0.92, x: 0.16, z: 0.14 },
      ],
      glow: [],
    }),
  },
  {
    id: 'mushroom', label: 'glowcap', r: 0.62, h: 1.25,
    build: () => ({
      parts: [
        { geo: cyl(0.15, 0.22, 0.82, 8), color: CREAM, y: 0.41 },
        { geo: sph(0.52, 12, 8), color: CORAL, y: 0.86, sy: 0.66 },
        { geo: sph(0.1, 8, 6), color: CREAM, x: 0.22, y: 1.06, z: 0.14, sy: 0.5 },
        { geo: sph(0.08, 8, 6), color: CREAM, x: -0.24, y: 1.02, z: -0.1, sy: 0.5 },
      ],
      glow: [{ geo: sph(0.3, 10, 8), color: TEAL, y: 0.72, sy: 0.28 }],
    }),
  },
  {
    id: 'mushroom_cluster', label: 'glowcap cluster', r: 0.92, h: 1.4,
    build: () => ({
      parts: [
        { geo: cyl(0.14, 0.2, 0.9, 8), color: CREAM, y: 0.45, x: -0.28 },
        { geo: sph(0.46, 12, 8), color: CORAL, y: 0.92, x: -0.28, sy: 0.62 },
        { geo: cyl(0.12, 0.17, 0.62, 8), color: CREAM, y: 0.31, x: 0.4, z: 0.22 },
        { geo: sph(0.36, 12, 8), color: TEAL, y: 0.66, x: 0.4, z: 0.22, sy: 0.6 },
        { geo: cyl(0.09, 0.13, 0.42, 8), color: CREAM, y: 0.21, x: 0.1, z: -0.44 },
        { geo: sph(0.26, 10, 8), color: AMBER, y: 0.46, x: 0.1, z: -0.44, sy: 0.6 },
      ],
      glow: [{ geo: sph(0.42, 10, 8), color: TEAL, y: 0.5, sy: 0.24 }],
    }),
  },
  {
    id: 'pickaxe', label: 'propped pickaxe', r: 0.58, h: 1.55,
    build: () => ({
      parts: [
        { geo: dodec(0.32), color: ROCK_D, y: 0.2, sy: 0.72 },
        { geo: cyl(0.06, 0.07, 1.55, 8), color: WOOD_L, y: 0.76, z: 0.2, rx: 0.26 },
        { geo: box(0.94, 0.13, 0.15), color: IRON, y: 1.44, z: 0.4, rz: 0.12 },
        { geo: box(0.18, 0.22, 0.22), color: IRON_D, y: 1.42, z: 0.4 },
      ],
      glow: [],
    }),
  },
  {
    id: 'minecart', label: 'minecart', r: 1.2, h: 1.5,
    build: () => ({
      parts: [
        { geo: box(1.72, 0.88, 1.06), color: IRON, y: 0.86 },
        { geo: box(1.5, 0.72, 0.86), color: IRON_D, y: 1.02 },
        { geo: box(1.82, 0.12, 1.16), color: WOOD_D, y: 1.32 },
        { geo: box(1.5, 0.14, 0.2), color: IRON_D, y: 0.4 },
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => ({
          geo: cyl(0.26, 0.26, 0.11, 10), color: IRON_D,
          x: sx * 0.62, y: 0.27, z: sz * 0.5, rz: Math.PI / 2,
        })),
      ],
      glow: [
        { geo: oct(0.2), color: TEAL, y: 1.36, x: -0.3, sy: 1.3 },
        { geo: oct(0.15), color: AMBER, y: 1.34, x: 0.28, z: 0.12, sy: 1.2 },
      ],
    }),
  },
  {
    id: 'crystal', label: 'crystal cluster', r: 0.78, h: 1.55,
    build: () => ({
      parts: [
        { geo: dodec(0.52), color: ROCK_D, y: 0.2, sy: 0.55 },
        { geo: dodec(0.24), color: ROCK, x: 0.44, y: 0.12, z: -0.3 },
      ],
      glow: [
        { geo: oct(0.34), color: TEAL, y: 0.94, sy: 1.9, rz: 0.12 },
        { geo: oct(0.24), color: AMBER, x: 0.42, y: 0.62, z: 0.16, sy: 1.5, rz: -0.3 },
        { geo: oct(0.19), color: TEAL, x: -0.38, y: 0.52, z: 0.24, sy: 1.4, rz: 0.36 },
      ],
    }),
  },
];

const KIND_IX = {};
PROP_KINDS.forEach((k, i) => { KIND_IX[k.id] = i; });

/**
 * WHERE THE PROPS LIVE.
 *
 * A prop hunt is only fun if every prop could plausibly be furniture, so the
 * 30 possessables are not scattered: they fill hand-authored spots in the
 * chamber that a mining crew would actually use. Crates stack by the walls and
 * the pantry, barrels ring the mess, lanterns stand at the posts and junctions,
 * pickaxes lean on the working face, minecarts sit ON the rails, glowcaps grow
 * in the damp south-west corner, crystal clusters break out of the seams.
 *
 * There are more spots than props, so each match's seed picks a subset (and,
 * where a spot lists alternatives, which of them turns up) with a small jitter:
 * the same room, arranged by a different shift. `ry` is a fixed yaw for things
 * that must line up (carts on rails, crates squared to a wall); everything else
 * gets a seeded angle.
 */
const PROP_SLOTS = [
  // --- the entrance end: crates and barrels dumped just inside the door -----
  { x: -4.9, z: 11.0, ry: 0.08, k: ['crate_stack'] },
  { x: -6.3, z: 10.4, ry: -0.2, k: ['crate'] },
  { x: 5.2, z: 11.1, k: ['barrel'] },
  { x: 6.5, z: 10.4, k: ['barrel', 'crate'] },
  { x: 4.6, z: 8.5, k: ['lantern'] },
  { x: -4.3, z: 7.8, ry: 0.22, k: ['pickaxe'] },
  { x: 8.4, z: 10.8, k: ['crate'] },
  // --- the damp south-west corner: puddle, moss, glowcaps ------------------
  { x: -13.9, z: 10.7, k: ['mushroom_cluster'] },
  { x: -12.2, z: 11.6, k: ['mushroom'] },
  { x: -14.4, z: 7.4, k: ['mushroom'] },
  { x: -11.0, z: 9.1, k: ['rock_pile', 'rock'] },
  { x: -9.7, z: 11.6, k: ['crate'] },
  // --- the rail line down the west side ------------------------------------
  { x: -7.6, z: 5.6, ry: 0, j: 0.1, k: ['minecart'] },
  { x: -7.6, z: -4.0, ry: 0, j: 0.1, k: ['minecart'] },
  { x: -9.7, z: 1.6, k: ['rock_pile'] },
  { x: -5.7, z: -0.6, ry: -0.12, k: ['crate'] },
  { x: -5.5, z: 7.6, k: ['lantern'] },
  { x: -9.9, z: -5.6, k: ['barrel'] },
  { x: -12.9, z: -2.2, ry: 0.05, k: ['crate_stack'] },
  { x: -13.7, z: 3.4, k: ['crystal'] },
  // --- the working face along the north wall -------------------------------
  { x: -3.2, z: -10.5, ry: 0.18, k: ['pickaxe'] },
  { x: 2.4, z: -10.7, ry: -0.15, k: ['pickaxe'] },
  { x: -0.7, z: -9.4, k: ['rock'] },
  { x: 5.4, z: -10.3, k: ['rock_pile'] },
  { x: 7.9, z: -10.9, k: ['crystal'] },
  { x: -6.7, z: -10.8, k: ['crystal'] },
  { x: -1.7, z: -7.3, ry: 0.1, k: ['crate_stack'] },
  // --- the hoist corner, north-east ----------------------------------------
  { x: 10.2, z: -11.2, k: ['barrel'] },
  { x: 14.0, z: -5.4, ry: -0.06, k: ['crate_stack'] },
  { x: 9.0, z: -6.3, k: ['lantern'] },
  // --- the shelving and the mess, east -------------------------------------
  { x: 13.8, z: -1.2, ry: 0.04, k: ['crate'] },
  { x: 13.6, z: 2.6, ry: -0.05, k: ['crate_stack', 'crate'] },
  { x: 8.5, z: 4.2, k: ['barrel'] },
  { x: 12.4, z: 9.7, k: ['barrel', 'crate'] },
  { x: 14.4, z: 6.0, k: ['mushroom_cluster'] },
  // --- a few out in the open, so hugging a wall is never a certainty -------
  { x: 0.6, z: 2.4, k: ['crate', 'barrel'] },
  { x: -2.7, z: 4.6, k: ['rock'] },
  { x: 3.7, z: -3.2, ry: 0.3, k: ['crate_stack'] },
  { x: -3.1, z: -1.0, k: ['lantern'] },
];

const AI_NAMES = ['Pebble', 'Nibbles', 'Marzipan', 'Twig', 'Coco', 'Bramble',
  'Yuzu', 'Dumpling', 'Sprout', 'Waffle', 'Pickle', 'Mochi'];
const AI_COLORS = [0xb08a5a, 0x8a6642, 0xc9a06b, 0x6b4f35, 0xe8657a, 0xf2a541,
  0x7ac74f, 0x4fb3e8, 0x9b6bd4, 0x42d6c8];
const AI_HATS = ['none', 'beanie', 'cap', 'flower', 'chef', 'none'];

// =============================================================== particles ==
/** Pooled instanced confetti / dust / sparkle. One draw call, never allocates. */
class Puffs {
  constructor(scene, cap = 260) {
    this.cap = cap;
    this.geo = box(0.17, 0.17, 0.17);
    this.mat = new THREE.MeshBasicMaterial({ vertexColors: false, transparent: true, opacity: 1 });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.list = [];
    for (let i = 0; i < cap; i++) {
      this.list.push({ live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 9, life: 0, max: 1, s: 1, spin: 0, rot: 0 });
      this.mesh.setColorAt(i, _col.setHex(0xffffff));
    }
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  burst(x, y, z, n, opts = {}) {
    const { color = 0xfff6e3, colors = null, spread = 2.4, up = 3.2, size = 1, g = 9, life = 0.9 } = opts;
    let made = 0;
    for (let i = 0; i < this.cap && made < n; i++) {
      const p = this.list[i];
      if (p.live) continue;
      p.live = true;
      made++;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * r;
      p.vz = Math.sin(a) * r;
      p.vy = up * (0.5 + Math.random());
      p.g = g;
      p.max = life * (0.7 + Math.random() * 0.6);
      p.life = p.max;
      p.s = size * (0.6 + Math.random() * 0.7);
      p.rot = Math.random() * 6.28;
      p.spin = (Math.random() - 0.5) * 9;
      const c = colors ? colors[(Math.random() * colors.length) | 0] : color;
      this.mesh.setColorAt(i, _col.setHex(c));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.cap; i++) {
      const p = this.list[i];
      if (!p.live) continue;
      dirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.live = false;
        this.mesh.setMatrixAt(i, this._hidden);
        continue;
      }
      p.vy -= p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.06) { p.y = 0.06; p.vy *= -0.34; p.vx *= 0.6; p.vz *= 0.6; }
      p.rot += p.spin * dt;
      const k = clamp(p.life / p.max, 0, 1);
      const s = p.s * (0.35 + k * 0.75);
      _e.set(p.rot * 0.6, p.rot, p.rot * 0.4);
      _q.setFromEuler(_e);
      _v2.set(p.x, p.y, p.z);
      _sc.set(s, s, s);
      _m4.compose(_v2, _q, _sc);
      this.mesh.setMatrixAt(i, _m4);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ==================================================================== css ===
const CSS = `
.mg-ph-wrap{position:absolute;inset:0;overflow:hidden;font-family:var(--font);color:var(--ink);
  user-select:none;-webkit-user-select:none;background:#120e0a;}
.mg-ph-wrap canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.mg-ph-wrap.seek canvas{cursor:crosshair;}
.mg-ph-wrap.aim canvas{cursor:pointer;}
.mg-ph-wrap.grab canvas{cursor:grabbing;}

.mg-ph-vig{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .35s ease;
  background:radial-gradient(ellipse 60% 56% at 50% 52%,rgba(0,0,0,0) 38%,rgba(120,20,20,.6) 100%);}
.mg-ph-flash{position:absolute;inset:0;pointer-events:none;opacity:0;}
.mg-ph-flash.bad{animation:mg-ph-fbad .4s ease-out;
  background:radial-gradient(ellipse at 50% 55%,rgba(150,80,40,0) 40%,rgba(150,80,40,.7) 100%);}
.mg-ph-flash.good{animation:mg-ph-fgood .5s ease-out;
  background:radial-gradient(ellipse at 50% 55%,rgba(242,182,74,0) 32%,rgba(242,182,74,.55) 100%);}
@keyframes mg-ph-fbad{from{opacity:1}to{opacity:0}}
@keyframes mg-ph-fgood{from{opacity:.9}to{opacity:0}}

.mg-ph-hud{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .35s ease;}
.mg-ph-hud.on{opacity:1;}
.mg-ph-panel{position:absolute;background:rgba(255,253,246,.92);border-radius:16px;padding:9px 15px;
  box-shadow:var(--shadow);font-weight:800;}
.mg-ph-tl{top:16px;left:16px;min-width:148px;}
.mg-ph-tc{top:16px;left:50%;translate:-50% 0;text-align:center;min-width:120px;}
.mg-ph-tr{top:16px;right:16px;text-align:right;min-width:118px;}
.mg-ph-bl{bottom:16px;left:16px;max-width:230px;}
.mg-ph-lbl{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9b8a6c;}
.mg-ph-big{font-size:27px;line-height:1.05;}
.mg-ph-clock{font-size:32px;line-height:1;letter-spacing:.02em;}
.mg-ph-clock.warn{color:#c95c5c;animation:mg-ph-pulse .6s ease-in-out infinite;}
@keyframes mg-ph-pulse{50%{scale:1.1}}
.mg-ph-role{display:inline-block;margin-top:4px;padding:3px 11px;border-radius:99px;font-size:12px;
  font-weight:900;letter-spacing:.05em;color:#fff;background:var(--accent2);}
.mg-ph-role.seeker{background:var(--accent);}
.mg-ph-role.ghost{background:#8a7a9a;}
.mg-ph-bar{margin-top:6px;height:7px;border-radius:99px;background:#e7e0d0;overflow:hidden;}
.mg-ph-bar i{display:block;height:100%;width:0%;border-radius:99px;background:var(--gold);
  transition:width .12s linear;}
.mg-ph-list{display:flex;flex-direction:column;gap:4px;margin-top:6px;}
.mg-ph-who{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:800;color:#5c5140;}
.mg-ph-who i{width:11px;height:11px;border-radius:99px;flex:none;box-shadow:inset 0 -3px 0 rgba(0,0,0,.18);}
.mg-ph-who b{margin-left:auto;font-size:11px;color:#9b8a6c;font-weight:900;}
.mg-ph-who.out{opacity:.45;text-decoration:line-through;}
.mg-ph-who.me span{color:var(--accent);}

.mg-ph-hint{position:absolute;left:50%;bottom:74px;translate:-50% 0;background:rgba(45,36,23,.76);
  color:#fff;font-size:13px;font-weight:800;padding:8px 18px;border-radius:999px;pointer-events:none;
  opacity:0;transition:opacity .25s ease;max-width:78vw;text-align:center;}
.mg-ph-hint.on{opacity:1;}
.mg-ph-sniff{position:absolute;left:50%;bottom:18px;translate:-50% 0;display:none;align-items:center;
  gap:9px;background:rgba(255,253,246,.92);border-radius:999px;padding:7px 16px;font-weight:800;
  font-size:12.5px;box-shadow:var(--shadow);pointer-events:none;}
.mg-ph-sniff.on{display:flex;}
.mg-ph-sniff u{text-decoration:none;background:#efe6d2;border-radius:8px;padding:2px 8px;font-weight:900;}
.mg-ph-sniff.cool{opacity:.45;}

.mg-ph-tags{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.mg-ph-tag{position:absolute;left:0;top:0;translate:-50% -100%;display:none;align-items:center;gap:6px;
  background:rgba(255,253,246,.92);border-radius:999px;padding:3px 11px 3px 5px;font-size:12px;
  font-weight:800;white-space:nowrap;box-shadow:0 3px 10px rgba(20,12,6,.4);}
.mg-ph-tag.on{display:flex;}
.mg-ph-tag i{width:13px;height:13px;border-radius:99px;box-shadow:inset 0 -3px 0 rgba(0,0,0,.18);}
.mg-ph-tag u{text-decoration:none;font-size:10.5px;color:#8a7a5a;font-weight:900;}
.mg-ph-tag.ghost{background:rgba(226,220,240,.8);}

.mg-ph-pops{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.mg-ph-pop{position:absolute;left:0;top:0;translate:-50% -50%;white-space:nowrap;font-weight:900;
  font-size:25px;color:#fff;text-shadow:0 3px 0 rgba(20,12,6,.45);animation:mg-ph-pop 1.05s ease-out forwards;}
.mg-ph-pop.gold{color:var(--gold);} .mg-ph-pop.bad{color:#ff9c8c;} .mg-ph-pop.teal{color:#7fe8dc;}
@keyframes mg-ph-pop{from{opacity:0;scale:.55}22%{opacity:1;scale:1.15}
  to{opacity:0;translate:-50% -160%;scale:1}}

.mg-ph-curtain{position:absolute;inset:0;z-index:5;display:none;flex-direction:column;
  align-items:center;justify-content:center;gap:10px;color:var(--cream);text-align:center;padding:24px;
  background:
    linear-gradient(180deg,rgba(10,7,4,.9),rgba(10,7,4,.82)),
    repeating-linear-gradient(97deg,#5a4229 0 46px,#6b4f35 46px 52px,#42301d 52px 96px);
  box-shadow:inset 0 0 140px rgba(0,0,0,.9);}
.mg-ph-curtain.on{display:flex;}
.mg-ph-curtain h2{font-size:34px;color:var(--gold);letter-spacing:.03em;text-shadow:0 4px 0 rgba(0,0,0,.4);}
.mg-ph-curtain p{font-size:14px;font-weight:700;color:#e6d6b6;max-width:420px;}
.mg-ph-cnum{font-size:96px;font-weight:900;color:#fff;line-height:1;text-shadow:0 6px 0 rgba(0,0,0,.35);}
.mg-ph-dust{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(ellipse 70% 40% at 50% 100%,rgba(180,150,110,.35),rgba(0,0,0,0) 70%);
  animation:mg-ph-drift 6s ease-in-out infinite alternate;}
@keyframes mg-ph-drift{to{opacity:.5;transform:translateY(-14px)}}

.mg-ph-count{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  pointer-events:none;z-index:4;}
.mg-ph-num{font-size:128px;font-weight:900;color:#fff;text-shadow:0 6px 0 rgba(20,12,6,.4);
  animation:mg-ph-num .9s ease-out forwards;}
.mg-ph-num.go{color:var(--gold);font-size:100px;}
@keyframes mg-ph-num{from{opacity:0;scale:2.1}18%{opacity:1;scale:1}to{opacity:0;scale:.72}}

.mg-ph-cards{position:absolute;inset:0;z-index:6;pointer-events:none;}
.mg-ph-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;gap:13px;
  padding:22px;text-align:center;pointer-events:auto;overflow-y:auto;
  background:linear-gradient(180deg,rgba(18,12,7,.5),rgba(18,12,7,.8));}
.mg-ph-card>*{margin:auto 0;}
.mg-ph-card.out{animation:mg-ph-out .28s ease forwards;pointer-events:none;}
@keyframes mg-ph-out{to{opacity:0;scale:1.05}}
.mg-ph-box{background:var(--cream);border-radius:28px;padding:24px 30px;width:min(520px,93vw);
  box-shadow:var(--shadow);animation:mg-ph-in .3s ease;}
@keyframes mg-ph-in{from{opacity:0;translate:0 20px;scale:.94}}
.mg-ph-title{font-size:38px;font-weight:900;color:var(--accent);letter-spacing:.02em;line-height:1;}
.mg-ph-sub{font-weight:700;color:#8a7a5a;font-size:13px;margin-top:6px;}
.mg-ph-roles{display:flex;gap:10px;margin:16px 0 6px;flex-wrap:wrap;}
.mg-ph-rcard{flex:1 1 180px;background:var(--card);border-radius:18px;padding:12px 14px;text-align:left;
  border:3px solid #efe4cc;}
.mg-ph-rcard h3{font-size:15px;font-weight:900;color:var(--accent2);margin-bottom:6px;letter-spacing:.03em;}
.mg-ph-rcard.seek h3{color:var(--accent);}
.mg-ph-rline{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;font-weight:700;color:#5c5140;
  margin-bottom:5px;line-height:1.35;}
.mg-ph-key{background:#fff;border:2px solid #e3d9c4;border-radius:8px;padding:1px 8px;font-weight:900;
  font-size:11.5px;box-shadow:0 2px 0 #e3d9c4;flex:none;}
.mg-ph-score-note{font-size:12px;font-weight:800;color:#8a7a5a;margin-top:4px;line-height:1.5;}
.mg-ph-rows{margin:14px 0 4px;display:flex;flex-direction:column;gap:6px;}
.mg-ph-row{display:flex;justify-content:space-between;align-items:center;gap:9px;background:var(--card);
  border-radius:12px;padding:8px 14px;font-weight:800;font-size:14px;}
.mg-ph-row i{width:14px;height:14px;border-radius:99px;flex:none;box-shadow:inset 0 -3px 0 rgba(0,0,0,.18);}
.mg-ph-row .n{width:24px;color:#9b8a6c;font-size:12px;text-align:left;}
.mg-ph-row .s{margin-left:auto;font-size:15px;}
.mg-ph-row.total{background:#2d2417;color:#fff;}
.mg-ph-row.pay{background:var(--gold);}
.mg-ph-row.win{background:var(--gold);}
.mg-ph-row.me{outline:3px solid var(--accent);outline-offset:-3px;}
.mg-ph-badge{display:inline-block;background:var(--accent);color:#fff;font-size:10.5px;font-weight:900;
  padding:2px 8px;border-radius:99px;margin-left:6px;letter-spacing:.05em;vertical-align:middle;}
.mg-ph-badge.b2{background:var(--accent2);}
.mg-ph-tagnew{display:inline-block;background:var(--accent);color:#fff;font-size:11px;font-weight:900;
  padding:3px 9px;border-radius:99px;margin-left:7px;letter-spacing:.06em;animation:mg-ph-pulse .8s ease-in-out infinite;}
.mg-ph-best{margin-top:12px;font-weight:800;font-size:13px;color:#8a7a5a;}
.mg-ph-btns{display:flex;gap:10px;justify-content:center;margin-top:15px;flex-wrap:wrap;}
.mg-ph-btn{background:var(--accent);color:#fff;border:3px solid #fff;font-family:var(--font);
  font-weight:900;font-size:16px;padding:11px 24px;border-radius:999px;cursor:pointer;
  box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-ph-btn:hover{scale:1.06;} .mg-ph-btn:active{scale:.96;}
.mg-ph-btn.alt{background:var(--accent2);}
.mg-ph-btn.ghost{background:transparent;color:var(--ink);border-color:#d8ccb4;box-shadow:none;}
.mg-ph-blink{margin-top:11px;font-size:12.5px;font-weight:800;color:#a99a80;
  animation:mg-ph-blink 1.5s ease-in-out infinite;}
@keyframes mg-ph-blink{50%{opacity:.35}}
.mg-ph-wait{margin:12px 0 2px;font-size:13px;font-weight:800;color:#8a7a5a;
  animation:mg-ph-blink 1.5s ease-in-out infinite;}

.mg-ph-quit{position:absolute;right:16px;bottom:16px;z-index:7;background:rgba(255,253,246,.9);border:0;
  font-family:var(--font);font-weight:800;font-size:13px;padding:9px 16px;border-radius:999px;
  cursor:pointer;box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-ph-quit:hover{scale:1.07;}
.mg-ph-quit b{font-weight:900;opacity:.5;margin-left:6px;font-size:11px;}
`;

const CROWN = '<svg viewBox="0 0 24 20" style="width:18px;height:15px;fill:#a5700f"><path d="M2 6l4.6 3.6L12 2l5.4 7.6L22 6l-2 12H4L2 6z"/></svg>';

// ================================================================== game ====
export class PropHuntGame extends Minigame {
  static id = 'prophunt';
  static name = 'Prop Hunt';

  constructor(game) {
    super(game);
    this.phase = 'splash';   // splash|intro|hide|seek|roundcard|results
    this.raf = 0;
    this.time = 0;
    this._last = 0;
    // every deadline below is an absolute Date.now() stamp (see the header)
    this.t0 = Date.now();
    this.splashEnd = Infinity;
    this.cardEnd = Infinity;
    this.now = this.t0;
    this.overhead = [];
    this.blockers = [];
    this.disposed = false;
    this.listeners = [];
    this.subs = [];
    this.geos = [];
    this.mats = [];
    this.keys = new Set();
    this.party = null;
    this.ctxRef = null;
    this.selfId = null;
    this.seed = 1;
    this.props = [];
    this.pickables = [];
    this.roster = [];
    this.me = null;
    this.ghosts = [];
    this.rings = [];
    this.tagEls = new Map();
    this.round = null;
    this.standings = null;
    this.boardSfx = false;
    this.matchOver = false;
    this.doneSent = false;
    this.vw = 1;
    this.vh = 1;
    this._tick = this._tick.bind(this);
  }

  // -------------------------------------------------------------- lifecycle -
  mount(root) {
    super.mount(root);
    this.party = this._readParty();
    this.seed = this.party ? this.party.seed : (Date.now() >>> 0);
    // The anchor every phase deadline hangs off. In a party this is the moment
    // 'ph-start' landed, which is the same instant (give or take the wire) on
    // all six screens, so nobody's splash, hide or seek runs on its own clock.
    this.t0 = this.party?.t0 || Date.now();
    this.now = Date.now();
    this._buildDom(root);
    this._buildScene();
    this._buildRoster();
    this._layoutProps(this.seed);
    this._bindInput();
    this._bindNet();
    this._showSplash();
    this._last = performance.now();
    this.raf = requestAnimationFrame(this._tick);
  }

  /**
   * Honest payout for the 90-coin cap. 14 for turning up (in a party game being
   * found in the first ten seconds is not a skill failure), then a point-per-
   * coin slope that tapers above 300 so even a two-round clean sweep (~500)
   * lands under 90 instead of visibly truncating.
   */
  coinsForScore(score) {
    const s = Math.max(0, Math.round(Number(score) || 0));
    const coins = 14 + Math.min(s, 300) / 5.5 + Math.max(0, s - 300) / 30;
    return Math.min(MINIGAMES.prophunt.maxCoinsPerRun, Math.round(coins));
  }

  /** Read the mine room's handshake; anything odd degrades to a solo hunt. */
  _readParty() {
    const ctx = this.game.__partyCtx;
    this.ctxRef = ctx || null;
    this.selfId = this.game.net?.selfId ?? null;
    if (!ctx || ctx.game !== 'prophunt' || !this.game.net?.connected) return null;
    const raw = Array.isArray(ctx.players) ? ctx.players.filter((p) => p && typeof p === 'object') : [];
    if (raw.length < 2) return null;
    const players = raw.slice(0, 6).map((p, i) => ({
      id: p.id ?? `p${i}`,
      name: String(p.name || 'Capy').slice(0, 16),
      color: Number.isFinite(p.color) ? p.color : 0xb08a5a,
      hat: typeof p.hat === 'string' ? p.hat : 'none',
      ai: false,
    }));
    // stable order so every client rotates the seeker to the same capybara
    players.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const seed = (Number(ctx.seed) || 0) >>> 0;
    let seekIdx = players.findIndex((p) => p.id === ctx.seekerId);
    if (seekIdx < 0) seekIdx = seed % players.length;
    const meIdx = players.findIndex((p) => p.id === this.selfId);
    if (meIdx < 0) return null; // we are not on the roster: hunt alone instead
    // The lobby may stamp the moment 'ph-start' landed; we only trust it if it
    // reads as OUR clock (a server-side stamp from a skewed machine would put
    // every deadline in the wrong century). Missing or odd falls back to now,
    // which is within a frame of it anyway: we mount on that same message.
    const stamped = Number(ctx.t0 ?? ctx.at ?? ctx.startedAt);
    const now = Date.now();
    const t0 = Number.isFinite(stamped) && Math.abs(now - stamped) < 30000 ? stamped : now;
    return { seed, players, seekIdx, meIdx, t0 };
  }

  /** Match roster: the party, or me plus five AI hiders with capy names. */
  _buildRoster() {
    const mk = (p) => ({
      // px/pz: where this capy parked their prop, in ABSOLUTE chamber coords
      ...p, score: 0, roundScore: 0, role: 'hider', prop: -1, px: 0, pz: 0, ry: 0,
      caught: false, caughtAt: 0, ticks: 0, hidden: false, finds: 0, misses: 0,
      // rounds[i] is the banked score for round i; reported[i] is what that
      // player's own client said it was, which always wins over our guess
      rounds: [], reported: [],
    });
    if (this.party) {
      this.roster = this.party.players.map(mk);
      this.me = this.roster[this.party.meIdx];
      return;
    }
    const rng = mulberry32(this.seed ^ 0x51ed);
    const names = [...AI_NAMES];
    this.roster = [mk({
      id: this.selfId ?? 'me',
      name: this.game.state.name || 'You',
      color: Number.isFinite(this.game.state.color) ? this.game.state.color : 0xb08a5a,
      hat: typeof this.game.state.hat === 'string' ? this.game.state.hat : 'none',
      ai: false,
    })];
    for (let i = 0; i < SOLO_HIDERS; i++) {
      const n = names.splice((rng() * names.length) | 0, 1)[0] || `Capy ${i + 1}`;
      this.roster.push(mk({
        id: `ai${i}`,
        name: n,
        color: AI_COLORS[(rng() * AI_COLORS.length) | 0],
        hat: AI_HATS[(rng() * AI_HATS.length) | 0],
        ai: true,
      }));
    }
    this.me = this.roster[0];
  }

  /** Roster index of the seeker for a given round (0-based). */
  _seekerIdxFor(round) {
    const n = this.roster.length;
    if (!this.party) return 0; // solo: you seek every round
    return (this.party.seekIdx + round) % n;
  }

  // ------------------------------------------------------------------- dom --
  _buildDom(root) {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    this.styleEl = style;

    const wrap = document.createElement('div');
    wrap.className = 'mg-ph-wrap';
    root.appendChild(wrap);
    this.wrap = wrap;

    wrap.insertAdjacentHTML('beforeend', `
      <div class="mg-ph-vig" data-f="vig"></div>
      <div class="mg-ph-flash" data-f="flash"></div>
      <div class="mg-ph-tags" data-f="tags"></div>
      <div class="mg-ph-pops" data-f="pops"></div>
      <div class="mg-ph-hud" data-f="hud">
        <div class="mg-ph-panel mg-ph-tl">
          <div class="mg-ph-lbl" data-f="roundlbl">Round 1 of 2</div>
          <div class="mg-ph-big" data-f="scoreval">0</div>
          <div class="mg-ph-role" data-f="role">HIDER</div>
        </div>
        <div class="mg-ph-panel mg-ph-tc">
          <div class="mg-ph-lbl" data-f="phaselbl">Hiding</div>
          <div class="mg-ph-clock" data-f="clock">0:25</div>
          <div class="mg-ph-bar"><i data-f="bar"></i></div>
        </div>
        <div class="mg-ph-panel mg-ph-tr">
          <div class="mg-ph-lbl">Still hidden</div>
          <div class="mg-ph-big" data-f="left">0</div>
          <div class="mg-ph-lbl" data-f="extra">&nbsp;</div>
        </div>
        <div class="mg-ph-panel mg-ph-bl">
          <div class="mg-ph-lbl">The hiders</div>
          <div class="mg-ph-list" data-f="list"></div>
        </div>
      </div>
      <div class="mg-ph-hint" data-f="hint"></div>
      <div class="mg-ph-sniff" data-f="sniff"><span>Sniff</span><u>SPACE</u><b data-f="sniffst">ready</b></div>
      <div class="mg-ph-curtain" data-f="curtain">
        <div class="mg-ph-dust"></div>
        <h2>Cave-in!</h2>
        <div class="mg-ph-cnum" data-f="cnum">25</div>
        <p data-f="ctext">Rubble is blocking the tunnel while the others find their spots. No peeking.</p>
      </div>
      <div class="mg-ph-count" data-f="count"></div>
      <div class="mg-ph-cards" data-f="cards"></div>
      <button class="mg-ph-quit" data-f="quit">Leave the hunt<b>ESC</b></button>`);

    this.f = {};
    wrap.querySelectorAll('[data-f]').forEach((el) => { this.f[el.dataset.f] = el; });
    this.f.flash.addEventListener('animationend', () => { this.f.flash.className = 'mg-ph-flash'; });
    this.f.quit.onclick = () => { this.game.audio?.play?.('click'); this.quit(); };
  }

  _card(html) {
    const card = document.createElement('div');
    card.className = 'mg-ph-card';
    card.innerHTML = html;
    this.f.cards.appendChild(card);
    this.card = card;
    return card;
  }

  _clearCard() {
    if (!this.card) return;
    const c = this.card;
    this.card = null;
    if (this.f) { this.f.cardgo = null; this.f.go = null; }
    c.classList.add('out');
    c.addEventListener('animationend', () => c.remove());
  }

  _showSplash() {
    this.phase = 'splash';
    const best = this.game.state.bests?.prophunt || 0;
    const party = this.party;
    const roster = party ? `
      <div class="mg-ph-rows">${this.roster.map((p) => {
    const seek = p === this.roster[this._seekerIdxFor(0)];
    return `<div class="mg-ph-row${p === this.me ? ' me' : ''}"><i style="background:${hex6(p.color)}"></i>`
          + `<span>${esc(p.name)}${p === this.me ? ' (you)' : ''}</span>`
          + `<span class="s">${seek ? '<span class="mg-ph-badge">SEEKER</span>' : '<span class="mg-ph-badge b2">HIDER</span>'}</span></div>`;
  }).join('')}</div>` : '';

    const card = this._card(`
      <div class="mg-ph-box">
        <div class="mg-ph-title">Prop Hunt</div>
        <div class="mg-ph-sub">${party
    ? 'One seeker. Everyone else is furniture. Two rounds, then you swap.'
    : 'Five capybaras are pretending to be crates. Find every one of them.'}</div>
        <div class="mg-ph-roles">
          <div class="mg-ph-rcard">
            <h3>IF YOU HIDE</h3>
            <div class="mg-ph-rline"><span class="mg-ph-key">CLICK</span><span>a prop to become it, puff and all.</span></div>
            <div class="mg-ph-rline"><span class="mg-ph-key">CLICK</span><span>the floor and glide anywhere in the chamber.</span></div>
            <div class="mg-ph-rline"><span class="mg-ph-key">Q / E</span><span>turn it. Then hold very, very still.</span></div>
            <div class="mg-ph-rline"><span class="mg-ph-key">+1</span><span>every ${TICK_SECS} seconds you stay undiscovered.</span></div>
          </div>
          <div class="mg-ph-rcard seek">
            <h3>IF YOU SEEK</h3>
            <div class="mg-ph-rline"><span class="mg-ph-key">WASD</span><span>walk the chamber (or click the floor).</span></div>
            <div class="mg-ph-rline"><span class="mg-ph-key">CLICK</span><span>a prop you are close to, to accuse it.</span></div>
            <div class="mg-ph-rline"><span class="mg-ph-key">SPACE</span><span>sniff: counts hiders within ${SNIFF_R} steps.</span></div>
            <div class="mg-ph-rline"><span class="mg-ph-key">+${FIND_POINTS}</span><span>per capy found, &minus;${WRONG_PENALTY} for a wrong guess.</span></div>
          </div>
        </div>
        <div class="mg-ph-score-note">Find every hider before the ${SEEK_SECS}s runs out and your round score doubles.</div>
        ${roster}
        <div class="mg-ph-best">Best hunt: <b>${best.toLocaleString()}</b></div>
        <div class="mg-ph-btns">
          ${party ? '' : '<button class="mg-ph-btn" data-a="play">Seek alone</button>'}
          <button class="mg-ph-btn ghost" data-a="back">Back to the mine</button>
        </div>
        <div class="mg-ph-blink" data-f="go">${party
    ? 'the lanterns go out in a moment...' : 'or press any key'}</div>
      </div>`);
    this.f.go = card.querySelector('[data-f="go"]');
    const play = card.querySelector('[data-a="play"]');
    if (play) play.onclick = () => this._beginRound(0, Date.now());
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.quit();
    };
    // A party cannot wait for six people to read: the seeker's clock is already
    // ticking, so the splash counts itself down and any key skips it. The
    // deadline is absolute, so a client that mounts with its tab in the
    // background still drops into round 1 with everybody else.
    this.splashEnd = party ? this.t0 + SPLASH_SECS * 1000 : Infinity;
  }

  _popupAt(x, y, z, text, cls = '') {
    if (!this.f?.pops || !this.camera) return;
    _v.set(x, y, z).project(this.camera);
    if (_v.z > 1) return;
    const el = document.createElement('div');
    el.className = `mg-ph-pop ${cls}`;
    el.textContent = text;
    el.style.left = `${(_v.x * 0.5 + 0.5) * this.vw + (Math.random() - 0.5) * 30}px`;
    el.style.top = `${(-_v.y * 0.5 + 0.5) * this.vh}px`;
    this.f.pops.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  _countNumber(text, go) {
    const el = document.createElement('div');
    el.className = `mg-ph-num${go ? ' go' : ''}`;
    el.textContent = text;
    this.f.count.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  _hint(text) {
    const el = this.f?.hint;
    if (!el || el.__t === text) return;
    el.__t = text;
    el.textContent = text || '';
    el.classList.toggle('on', !!text);
  }

  _flash(kind) {
    this.f.flash.className = `mg-ph-flash ${kind}`;
  }

  // ----------------------------------------------------------------- scene --
  _buildScene() {
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;
    this.vw = w; this.vh = h;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // FIRST child: the HUD, tags, popups and cards are all position:absolute
    // with auto z-index, so a canvas appended last would paint straight over
    // every one of them
    this.wrap.insertBefore(this.renderer.domElement, this.wrap.firstChild);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x120e0a);
    // far plane sits past the overhead free-cam distance: the hide view looks
    // down from ~19 units up and must not fade the far wall to soup
    this.scene.fog = new THREE.Fog(0x120e0a, 30, 78);

    this.camera = new THREE.PerspectiveCamera(46, w / h, 0.1, 220);
    this.cam = { tx: 0, ty: 1, tz: 0, yaw: 0, pitch: 0.86, dist: 22, mode: 'free' };
    this.camNow = { x: 0, y: 14, z: 20, tx: 0, ty: 1, tz: 0 };

    this.scene.add(new THREE.AmbientLight(0x6a5238, 0.55));
    this.scene.add(new THREE.HemisphereLight(0x9a7a4a, 0x241a12, 0.55));
    const sun = new THREE.DirectionalLight(0xffd9a8, 0.85);
    sun.position.set(11, 22, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 64;
    sun.shadow.bias = -0.0009;
    this.scene.add(sun);
    // one warm fill per landmark: the working face, the rail line, the mess
    // brazier, and a cold one over the damp corner so it reads as damp
    for (const [x, y, z, c, i, d] of [
      [0, 4.6, -10.4, 0xffc27a, 26, 22],
      [-7.6, 5.0, -1.0, 0xffb060, 22, 22],
      [12.8, 3.2, 7.6, 0xff9a4c, 26, 18],
      [-12.6, 3.4, 8.6, 0x6fd8d0, 14, 14],
    ]) {
      const pl = new THREE.PointLight(c, i, d, 1.6);
      pl.position.set(x, y, z);
      this.scene.add(pl);
    }

    this._buildChamber();
    this._buildProps();
    this._buildActors();
    this.particles = new Puffs(this.scene);

    // reusable rings: hover highlight, leash circle, sniff/miss ripples
    const ringGeo = new THREE.RingGeometry(0.84, 1, 30);
    ringGeo.rotateX(-Math.PI / 2);
    this.geos.push(ringGeo);
    this.ringGeo = ringGeo;
    this.hoverRing = this._ring(0xf2b64a, 0.85);
    this.moveRing = this._ring(0x4fb3e8, 0.5); // where a possessed prop is gliding
    this.hoverRing.visible = false;
    this.moveRing.visible = false;
    for (let i = 0; i < 5; i++) {
      const r = this._ring(0xfff6e3, 0);
      r.visible = false;
      r.userData.life = 0;
      this.rings.push(r);
    }
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
  }

  _ring(color, opacity) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mats.push(mat);
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.y = 0.05;
    m.renderOrder = 1;
    this.scene.add(m);
    return m;
  }

  /** Ripple a ring outward at a spot (sniff, wrong click). */
  _ripple(x, z, color) {
    const r = this.rings.find((q) => !q.visible) || this.rings[0];
    r.visible = true;
    r.userData.life = 1;
    r.material.color.setHex(color);
    r.position.set(x, 0.06, z);
    r.scale.setScalar(0.6);
  }

  /**
   * Register a merged mesh that hangs OVER the play space (lintels, ceiling
   * boarding, lantern strings, the roof itself). Each gets its own material and
   * its own world-space AABB so _updateOcclusion can fade it out of the way the
   * instant it comes between the camera and whatever the camera is watching.
   * `roof` pieces simply vanish once the camera climbs above them.
   */
  _overhead(parts, opts = {}) {
    const geo = mergeParts(parts);
    if (!geo) return null;
    geo.computeBoundingBox();
    const mat = opts.glow
      ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true })
      : makeToon(0xffffff, { unique: true, vertexColors: true, transparent: true });
    this.geos.push(geo);
    this.mats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = !opts.glow;
    this.scene.add(mesh);
    const b = geo.boundingBox;
    this.overhead.push({
      mesh, mat, fade: 1, roof: !!opts.roof,
      x0: b.min.x, x1: b.max.x, y0: b.min.y, y1: b.max.y, z0: b.min.z, z1: b.max.z,
    });
    return mesh;
  }

  /**
   * The chamber: a working corner of the Glimmer Mine in the room's own
   * language (timber portal frames, lantern strings, a rail line with a spur to
   * the hoist, a cable-spool mess, shelving, crystal seams, a damp corner). All
   * of the standing dressing merges into ONE vertex-coloured mesh plus one
   * unlit mesh for the glowing bits; everything overhead is split out per piece
   * so it can get out of the camera's way.
   */
  _buildChamber() {
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const solid = [];
    const glow = [];
    this.overhead = [];
    this.blockers = [];

    const RAIL_X = -7.6;          // the main rail run, down the west side
    const SPUR_Z = -8.6;          // the spur that feeds the hoist
    const MESS = { x: 10.8, z: 6.4 };
    const LIFT = { x: 12.7, z: -8.7 };
    const POOL = { x: -12.4, z: 9.2 };
    const DOOR_Z = HALF_Z + 1.0;  // the way in, cut through the south wall
    /** Static furniture the seeker walks around (props do their own thing). */
    const block = (x, z, r) => this.blockers.push({ x, z, r });

    // ---- floor: one plane with a canvas speckle so it is not a flat slab ----
    const tex = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#6d573c';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 420; i++) {
        const s = 2 + Math.random() * 9;
        c.fillStyle = ['#5d4a32', '#7d6647', '#4f3f2b', '#8a7255'][(Math.random() * 4) | 0];
        c.globalAlpha = 0.25 + Math.random() * 0.4;
        c.fillRect(Math.random() * w, Math.random() * h, s, s * (0.4 + Math.random()));
      }
      // a few scuffed cart tracks, faint: any more and packed mine dirt starts
      // to read as decking
      c.globalAlpha = 0.35;
      for (let i = 0; i < 7; i++) {
        c.strokeStyle = '#5f4d34';
        c.lineWidth = 1 + Math.random() * 2;
        c.beginPath();
        const y = Math.random() * h;
        c.moveTo(0, y);
        c.lineTo(w, y + (Math.random() - 0.5) * 40);
        c.stroke();
      }
      c.globalAlpha = 1;
      for (let i = 0; i < 220; i++) { // grit
        c.fillStyle = ['#5a482f', '#847053'][(Math.random() * 2) | 0];
        c.globalAlpha = 0.3 + Math.random() * 0.35;
        const r = 1 + Math.random() * 2.5;
        c.beginPath();
        c.arc(Math.random() * w, Math.random() * h, r, 0, 6.283);
        c.fill();
      }
      c.globalAlpha = 1;
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(5, 4);
    const floorMat = new THREE.MeshToonMaterial({
      color: 0xffffff, map: tex, gradientMap: makeToon(0xffffff).gradientMap,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALF_X * 2 + 8, HALF_Z * 2 + 8), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floor = floor;

    // ---- ceiling + stalactites -------------------------------------------
    // Their own fadeable meshes: the hider's free cam flies ABOVE the chamber,
    // and a roof you cannot see through is not much of a hiding view.
    this._overhead([{
      geo: box(HALF_X * 2 + 8, 0.4, HALF_Z * 2 + 8), color: 0x231a11, y: CEIL_Y + 0.2,
    }], { roof: true });
    const stal = [];
    for (let i = 0; i < 34; i++) {
      const x = (rng() * 2 - 1) * (HALF_X + 2);
      const z = (rng() * 2 - 1) * (HALF_Z + 2);
      // capped at 2.0 long so the lowest tip sits at y 6.6, clear of OVERHEAD_Y
      // and well clear of the walk camera: the boom never sweeps through one
      const len = 0.7 + rng() * 1.3;
      stal.push({
        geo: cone(0.24 + rng() * 0.3, len, 7), color: rng() < 0.5 ? ROCK_D : ROCK,
        x, y: CEIL_Y - len / 2 + 0.1, z, rx: Math.PI,
      });
    }
    this._overhead(stal, { roof: true });

    // ---- rock shell: chunky boulders all the way round, plus a solid backing
    const wallAt = (x, z, s, tone) => solid.push({
      geo: dodec(s), color: tone, x, y: rng() * 1.4 - 0.2, z,
      s: 1, sy: 1.5 + rng() * 1.4, ry: rng() * 3,
    });
    for (let i = 0; i < 30; i++) {
      const t = (i / 30) * (HALF_X * 2 + 3) - (HALF_X + 1.5);
      wallAt(t, -HALF_Z - 1.1 - rng() * 0.7, 1.1 + rng() * 0.9, i % 3 ? ROCK : ROCK_D);
      // the south wall opens: that gap is the tunnel the seeker walks in from
      if (Math.abs(t) > 3.8) wallAt(t, HALF_Z + 1.1 + rng() * 0.7, 1.1 + rng() * 0.9, i % 3 ? ROCK_D : ROCK);
    }
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * (HALF_Z * 2 + 3) - (HALF_Z + 1.5);
      wallAt(-HALF_X - 1.1 - rng() * 0.7, t, 1.1 + rng() * 0.9, i % 3 ? ROCK_L : ROCK);
      wallAt(HALF_X + 1.1 + rng() * 0.7, t, 1.1 + rng() * 0.9, i % 3 ? ROCK : ROCK_L);
    }
    // backing slabs so a gap between boulders never shows the void
    const bw = HALF_X * 2 + 10;
    const bd = HALF_Z * 2 + 10;
    solid.push({ geo: box(bw, 11, 1.6), color: ROCK_D, y: 4, z: -HALF_Z - 2.6 });
    solid.push({ geo: box(bw, 11, 1.6), color: ROCK_D, y: 4, z: HALF_Z + 2.6 });
    solid.push({ geo: box(1.6, 11, bd), color: ROCK_D, y: 4, x: -HALF_X - 2.6 });
    solid.push({ geo: box(1.6, 11, bd), color: ROCK_D, y: 4, x: HALF_X + 2.6 });

    // corner rubble mounds so the corners are not empty right angles
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      for (let i = 0; i < 5; i++) {
        solid.push({
          geo: dodec(0.5 + rng() * 0.7), color: i % 2 ? ROCK : ROCK_L,
          x: sx * (HALF_X - 0.4 - rng() * 2.6), y: 0.1 + rng() * 0.4,
          z: sz * (HALF_Z - 0.4 - rng() * 2.6), sy: 0.7, ry: rng() * 3,
        });
      }
    }

    // ---- the way in: a timbered door frame cut through the south wall ------
    // It sits OUTSIDE the walkable floor: the camera boom stops at z 13.1, so
    // the seeker cam can never end up behind the frame staring at planks.
    for (const sx of [-1, 1]) {
      solid.push({ geo: box(0.44, 4.1, 0.52), color: sx > 0 ? WOOD : WOOD_D, x: sx * 2.9, y: 2.05, z: DOOR_Z });
      solid.push({ geo: box(0.62, 0.24, 0.7), color: WOOD_D, x: sx * 2.9, y: 0.12, z: DOOR_Z });
      solid.push({ geo: box(0.24, 0.94, 0.24), color: WOOD_L, x: sx * 2.52, y: 3.56, z: DOOR_Z, rz: sx * 0.72 });
    }
    solid.push({ geo: box(7.0, 0.44, 0.62), color: WOOD_L, y: 4.32, z: DOOR_Z });
    solid.push({ geo: box(6.3, 0.24, 0.74), color: WOOD_D, y: 4.62, z: DOOR_Z });
    // two receding frames and then darkness: the tunnel back up to the mine
    for (let i = 1; i <= 2; i++) {
      const w = 2.45 - i * 0.28;
      const h = 3.5 - i * 0.34;
      for (const sx of [-1, 1]) {
        solid.push({ geo: box(0.3, h, 0.3), color: i % 2 ? WOOD_D : ROCK_D, x: sx * w, y: h / 2, z: DOOR_Z + 0.62 * i });
      }
      solid.push({ geo: box(w * 2 + 0.5, 0.26, 0.3), color: WOOD_D, y: h, z: DOOR_Z + 0.62 * i });
    }
    solid.push({ geo: box(6.2, 4.4, 0.4), color: 0x150f0a, y: 2.2, z: DOOR_Z + 1.9 });

    // ---- timber support frames: four bays down the hall --------------------
    // Posts merge into the room mesh; everything from the lintel up is its own
    // fadeable piece, because a beam is the most reliable way in all of scenery
    // to fill a camera with wood.
    const frame = (z, halfW, h) => {
      const up = [];
      for (const sx of [-1, 1]) {
        const x = sx * halfW;
        solid.push({ geo: box(0.4, h, 0.4), color: sx > 0 ? WOOD : WOOD_D, x, y: h / 2, z });
        solid.push({ geo: box(0.56, 0.2, 0.56), color: WOOD_D, x, y: 0.1, z });
        solid.push({ geo: box(0.24, 1.0, 0.24), color: WOOD_L, x: x - sx * 0.34, y: h - 0.52, z, rz: sx * 0.72 });
        block(x, z, 0.5);
      }
      up.push({ geo: box(halfW * 2 + 0.9, 0.38, 0.44), color: WOOD_L, y: h + 0.19, z });
      up.push({ geo: box(halfW * 2 + 0.4, 0.2, 0.6), color: WOOD_D, y: h + 0.48, z });
      for (let i = -1; i <= 1; i++) {
        up.push({
          geo: box(halfW * 2 + 0.6, 0.14, 0.34), color: i ? WOOD : WOOD_L,
          y: h + 0.72, z: z + i * 0.62,
        });
      }
      this._overhead(up);
    };
    // posts hug the walls: a support post standing a metre INTO the hall is a
    // post the camera ends up peering through
    for (const z of [-9.2, -3.6, 2.0, 7.6]) frame(z, HALF_X - 0.45, 6.4);

    // ---- the rail line: main run west, spur east to the hoist --------------
    const gauge = 0.55;
    for (const dx of [-gauge, gauge]) {
      solid.push({ geo: box(0.12, 0.14, HALF_Z * 2 + 2.6), color: IRON, x: RAIL_X + dx, y: 0.17 });
    }
    for (let i = 0; i < 24; i++) {
      solid.push({ geo: box(1.8, 0.12, 0.32), color: WOOD_D, x: RAIL_X, y: 0.06, z: -HALF_Z - 1 + i * 1.15 });
    }
    for (const dz of [-gauge, gauge]) {
      solid.push({ geo: box(18.2, 0.12, 0.14), color: IRON, x: RAIL_X + 9.1, y: 0.17, z: SPUR_Z + dz });
    }
    for (let i = 0; i < 15; i++) {
      solid.push({ geo: box(0.32, 0.12, 1.8), color: WOOD_D, x: RAIL_X + 0.6 + i * 1.2, y: 0.06, z: SPUR_Z });
    }
    solid.push({ geo: box(1.9, 0.14, 1.9), color: IRON_D, x: RAIL_X, y: 0.08, z: SPUR_Z });
    // buffer stops, coral-tipped exactly like the ones in the room upstairs
    for (const [bx, bz, ry] of [
      [RAIL_X, HALF_Z - 0.4, 0], [RAIL_X, -HALF_Z + 0.4, 0], [RAIL_X + 18.4, SPUR_Z, Math.PI / 2],
    ]) {
      solid.push({ geo: box(1.4, 0.44, 0.26), color: WOOD_D, x: bx, y: 0.3, z: bz, ry });
      solid.push({ geo: box(1.46, 0.15, 0.32), color: CORAL, x: bx, y: 0.56, z: bz, ry });
      block(bx, bz, 0.7);
    }
    // ore spilled at the junction, still glinting
    for (let i = 0; i < 9; i++) {
      const a = rng() * 6.283;
      const d = 0.6 + rng() * 1.5;
      glow.push({
        geo: oct(0.1 + rng() * 0.08), color: i % 3 ? AMBER : TEAL,
        x: RAIL_X + Math.cos(a) * d, y: 0.12, z: SPUR_Z + Math.sin(a) * d,
      });
    }

    // ---- the hoist in the north-east corner --------------------------------
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      solid.push({
        geo: box(0.28, 4.8, 0.28), color: ox * oz > 0 ? WOOD : WOOD_D,
        x: LIFT.x + ox * 1.25, y: 2.4, z: LIFT.z + oz * 1.25,
      });
      solid.push({ geo: box(0.42, 0.2, 0.42), color: WOOD_D, x: LIFT.x + ox * 1.25, y: 0.1, z: LIFT.z + oz * 1.25 });
      solid.push({ geo: box(0.14, 2.3, 0.14), color: IRON, x: LIFT.x + ox * 0.92, y: 1.35, z: LIFT.z + oz * 0.92 });
    }
    for (const sz of [-1, 1]) {
      solid.push({ geo: box(3.2, 0.26, 0.28), color: WOOD_L, x: LIFT.x, y: 4.92, z: LIFT.z + sz * 1.25 });
    }
    solid.push({ geo: cyl(0.07, 0.07, 2.7, 6), color: IRON_D, x: LIFT.x, y: 5.18, z: LIFT.z, rx: Math.PI / 2 });
    solid.push({ geo: cyl(0.4, 0.4, 0.16, 12), color: IRON, x: LIFT.x, y: 5.18, z: LIFT.z + 0.6, rx: Math.PI / 2 });
    solid.push({ geo: box(2.0, 0.16, 2.0), color: WOOD_L, x: LIFT.x, y: 0.2, z: LIFT.z });
    solid.push({ geo: box(2.12, 0.18, 2.12), color: IRON_D, x: LIFT.x, y: 2.5, z: LIFT.z });
    for (let i = 0; i < 5; i++) {
      solid.push({ geo: cyl(0.04, 0.04, 2.2, 5), color: IRON, x: LIFT.x - 0.72 + i * 0.36, y: 1.35, z: LIFT.z - 0.92 });
    }
    glow.push({ geo: box(0.2, 0.26, 0.2), color: 0xffd08a, x: LIFT.x + 0.62, y: 2.12, z: LIFT.z + 0.62 });
    block(LIFT.x, LIFT.z, 1.9);

    // ---- shelving along the east wall --------------------------------------
    for (const sz of [-2.6, 1.8]) {
      const sx = HALF_X - 0.5;
      for (const dz of [-1.5, 1.5]) {
        solid.push({ geo: box(0.24, 2.7, 0.24), color: WOOD_D, x: sx, y: 1.35, z: sz + dz });
      }
      for (let i = 0; i < 3; i++) {
        solid.push({ geo: box(0.8, 0.12, 3.3), color: i === 1 ? WOOD : WOOD_L, x: sx, y: 0.55 + i * 0.95, z: sz });
      }
      for (let i = 0; i < 5; i++) {
        solid.push({
          geo: box(0.44, 0.42, 0.44), color: i % 2 ? WOOD_L : WOOD,
          x: sx - 0.08, y: 0.82 + (i % 3) * 0.95, z: sz - 1.2 + rng() * 2.4, ry: rng() * 0.5,
        });
      }
      glow.push({ geo: oct(0.16), color: rng() < 0.5 ? TEAL : AMBER, x: sx - 0.12, y: 1.68, z: sz + 0.9 });
      block(sx + 0.3, sz, 1.5);
    }

    // ---- the mess: cable-spool table, mugs, stools, a brazier --------------
    solid.push({ geo: cyl(1.1, 1.1, 0.14, 16), color: WOOD_L, x: MESS.x, y: 0.86, z: MESS.z });
    solid.push({ geo: cyl(0.36, 0.36, 0.86, 10), color: WOOD_D, x: MESS.x, y: 0.43, z: MESS.z });
    solid.push({ geo: cyl(1.05, 1.05, 0.15, 16), color: WOOD, x: MESS.x, y: 0.07, z: MESS.z });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * 6.283 + 0.6;
      const mx = MESS.x + Math.cos(a) * 0.52;
      const mz = MESS.z + Math.sin(a) * 0.52;
      solid.push({ geo: cyl(0.13, 0.11, 0.22, 9), color: [CORAL, TEAL, AMBER][i], x: mx, y: 1.04, z: mz });
    }
    // somebody has to make the tea
    solid.push({ geo: cyl(0.26, 0.3, 0.3, 10), color: IRON, x: MESS.x - 0.24, y: 1.08, z: MESS.z + 0.12 });
    solid.push({ geo: cyl(0.1, 0.06, 0.24, 6), color: IRON_D, x: MESS.x - 0.52, y: 1.16, z: MESS.z + 0.18, rz: 0.7 });
    block(MESS.x, MESS.z, 1.5);
    // barrel stools: the same silhouette as the barrels you can BE, on purpose
    for (const [sx2, sz2] of [
      [MESS.x + 1.9, MESS.z - 1.0], [MESS.x - 0.5, MESS.z + 2.0], [MESS.x - 1.9, MESS.z - 0.7],
    ]) {
      solid.push({ geo: cyl(0.44, 0.38, 0.86, 12), color: WOOD, x: sx2, y: 0.43, z: sz2 });
      solid.push({ geo: cyl(0.47, 0.47, 0.1, 12), color: IRON, x: sx2, y: 0.62, z: sz2 });
      block(sx2, sz2, 0.55);
    }
    const BRZ = { x: MESS.x + 2.2, z: MESS.z + 1.4 };
    solid.push({ geo: cyl(0.54, 0.36, 0.52, 12), color: IRON, x: BRZ.x, y: 0.44, z: BRZ.z });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * 6.283;
      solid.push({
        geo: cyl(0.06, 0.06, 0.42, 5), color: IRON_D,
        x: BRZ.x + Math.cos(a) * 0.3, y: 0.2, z: BRZ.z + Math.sin(a) * 0.3,
        rz: Math.cos(a) * 0.3, rx: Math.sin(a) * 0.3,
      });
    }
    glow.push({ geo: sph(0.4, 10, 7), color: 0xff8a3c, x: BRZ.x, y: 0.64, z: BRZ.z, sy: 0.42 });
    block(BRZ.x, BRZ.z, 0.75);

    // ---- the damp corner, which is why the glowcaps grow down here ---------
    solid.push({ geo: cyl(1.9, 1.9, 0.1, 20), color: 0x33473f, x: POOL.x, y: 0.04, z: POOL.z });
    glow.push({ geo: cyl(1.55, 1.55, 0.02, 20), color: 0x1d5f66, x: POOL.x, y: 0.1, z: POOL.z });
    for (let i = 0; i < 8; i++) {
      const a = rng() * 6.283;
      const d = 1.9 + rng() * 1.7;
      solid.push({
        geo: dodec(0.26 + rng() * 0.3), color: rng() < 0.5 ? 0x5c6b46 : ROCK_D,
        x: POOL.x + Math.cos(a) * d, y: 0.12, z: POOL.z + Math.sin(a) * d, sy: 0.6, ry: rng() * 3,
      });
    }
    // moss, kept dim: bright green splats on a mine floor read as spilled paint
    for (let i = 0; i < 6; i++) {
      const r = 0.3 + rng() * 0.35;
      solid.push({
        geo: cyl(r, r, 0.03, 9), color: 0x33513c,
        x: POOL.x + (rng() * 2 - 1) * 2.8, y: 0.03, z: POOL.z + (rng() * 2 - 1) * 2.4,
      });
    }

    // ---- the working face: the seam this whole chamber is chasing ----------
    for (let i = 0; i < 8; i++) {
      const x = -12.4 + i * 3.4 + (rng() - 0.5) * 0.8;
      const h = 0.9 + rng() * 0.8;
      solid.push({
        geo: box(3.0, h, 1.3), color: i % 2 ? ROCK : ROCK_L,
        x, y: h / 2, z: -HALF_Z - 0.25, ry: (rng() - 0.5) * 0.14,
      });
    }
    // the seam itself: crystal breaking OUT of the rock, every cluster socketed
    // in its own lump of stone so it reads as a vein and not as floating gems
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const x = -11 + t * 21;
      const y = 0.9 + Math.sin(t * 3.4) * 0.7 + t * 0.5;
      const z = -HALF_Z - 0.5 + rng() * 0.3;
      solid.push({
        geo: dodec(0.5 + rng() * 0.4), color: i % 2 ? ROCK_D : ROCK,
        x, y: y - 0.3, z: z - 0.4, sy: 0.9, ry: rng() * 3,
      });
      for (let j = 0; j < 2; j++) {
        glow.push({
          geo: oct(0.2 + rng() * 0.22), color: (i + j) % 3 === 0 ? AMBER : TEAL,
          x: x + (rng() - 0.5) * 0.8, y: y + (rng() - 0.5) * 0.5, z: z + (rng() - 0.5) * 0.3,
          sy: 1.3 + rng() * 0.8, ry: rng() * 3, rz: (rng() - 0.5) * 0.9,
        });
      }
    }
    // the scaffold the last shift left leaning on the face
    for (const sx of [-1, 1]) {
      solid.push({ geo: box(0.22, 2.7, 0.22), color: WOOD, x: -9.5 + sx * 1.5, y: 1.35, z: -HALF_Z + 0.95 });
    }
    solid.push({ geo: box(3.5, 0.16, 0.9), color: WOOD_L, x: -9.5, y: 1.42, z: -HALF_Z + 0.95 });
    solid.push({ geo: box(3.5, 0.16, 0.9), color: WOOD, x: -9.5, y: 2.62, z: -HALF_Z + 0.95 });
    block(-9.5, -HALF_Z + 0.95, 1.7);

    // ---- lanterns bracketed to the walls: where the warm light comes from --
    for (const [bx, bz, ix, iz] of [
      [-HALF_X + 0.2, -4.0, 1, 0], [-HALF_X + 0.2, 6.4, 1, 0],
      [HALF_X - 0.2, -2.0, -1, 0], [HALF_X - 0.2, 9.4, -1, 0],
      [-2.4, -HALF_Z + 0.2, 0, 1], [7.6, HALF_Z - 0.2, 0, -1],
    ]) {
      solid.push({
        geo: box(ix ? 0.62 : 0.16, 0.14, ix ? 0.16 : 0.62), color: IRON_D,
        x: bx + ix * 0.3, y: 3.5, z: bz + iz * 0.3,
      });
      solid.push({ geo: box(0.34, 0.44, 0.34), color: IRON, x: bx + ix * 0.56, y: 3.24, z: bz + iz * 0.56 });
      glow.push({ geo: sph(0.17, 8, 6), color: AMBER, x: bx + ix * 0.56, y: 3.24, z: bz + iz * 0.56 });
    }

    // ---- glowing crystal seams pressed into the walls --------------------
    for (let i = 0; i < 22; i++) {
      const side = (rng() * 4) | 0;
      const along = (rng() * 2 - 1);
      let x; let z;
      if (side === 0) { x = along * HALF_X; z = -HALF_Z - 0.5; }
      else if (side === 1) { x = along * HALF_X; z = HALF_Z + 0.5; }
      else if (side === 2) { x = -HALF_X - 0.5; z = along * HALF_Z; }
      else { x = HALF_X + 0.5; z = along * HALF_Z; }
      const y = 0.6 + rng() * 3.0;
      const c = rng() < 0.55 ? AMBER : TEAL;
      // a knuckle of rock behind every seam: crystals hanging in mid-air on a
      // dark wall read as bugs, not geology
      solid.push({
        geo: dodec(0.7 + rng() * 0.5), color: rng() < 0.5 ? ROCK_D : ROCK,
        x: x * 1.03, y: y - 0.2, z: z * 1.03, sy: 0.9, ry: rng() * 3,
      });
      for (let j = 0; j < 3; j++) {
        glow.push({
          geo: oct(0.16 + rng() * 0.22), color: c,
          x: x + (rng() - 0.5) * 1.5, y: y + (rng() - 0.5) * 1.1, z: z + (rng() - 0.5) * 1.5,
          sy: 1.3 + rng(), ry: rng() * 3, rz: rng() * 1.4,
        });
      }
    }

    // ---- two lantern strings, slung frame to frame ------------------------
    // Hung at 7.35 with a shallow sag (lowest bulb 6.8), well over every
    // camera; registered as overhead so that if one ever does cross the shot
    // it fades instead of dangling in front of the seeker's face.
    const yTop = 7.35;
    const sagOf = (t) => yTop - Math.sin(t * Math.PI) * 0.55;
    for (const [z0, z1] of [[-9.2, -3.6], [2.0, 7.6]]) {
      const wire = [];
      const bulbs = [];
      const n = 11;
      const xAt = (t) => -HALF_X + 1.2 + t * (HALF_X * 2 - 2.4);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const x = xAt(t);
        const z = z0 + (z1 - z0) * t;
        const y = sagOf(t);
        bulbs.push({ geo: sph(0.19, 8, 6), color: i % 3 === 1 ? CORAL : AMBER, x, y, z });
        wire.push({ geo: cone(0.13, 0.2, 6), color: IRON_D, x, y: y + 0.22, z });
        if (i < n - 1) {
          const t2 = (i + 1) / (n - 1);
          const dx = xAt(t2) - x;
          const dy = sagOf(t2) - y;
          const dz = (z0 + (z1 - z0) * t2) - z;
          const len = Math.hypot(dx, dy, dz);
          wire.push({
            geo: cyl(0.022, 0.022, len, 4), color: IRON_D,
            x: x + dx / 2, y: y + dy / 2 + 0.33, z: z + dz / 2,
            rz: -Math.atan2(dx, dy), rx: Math.atan2(dz, dy),
          });
        }
      }
      this._overhead(wire);
      this._overhead(bulbs, { glow: true });
    }

    // ---- the board over the door, for anyone who wandered in by mistake ---
    const boardTex = canvasTexture(512, 160, (c, w, h) => {
      c.fillStyle = '#f4e3c0';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#8a6642';
      c.lineWidth = 10;
      c.strokeRect(9, 9, w - 18, h - 18);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#8a4a3c';
      c.font = '900 54px "Trebuchet MS", system-ui, sans-serif';
      c.fillText('CHAMBER THREE', w / 2, 58);
      c.fillStyle = '#7a6242';
      c.font = '700 27px "Trebuchet MS", system-ui, sans-serif';
      c.fillText('mind the crates', w / 2, 112);
    });
    const boardMat = new THREE.MeshBasicMaterial({ map: boardTex });
    this.mats.push(boardMat);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.0), boardMat);
    this.geos.push(board.geometry);
    board.position.set(0, 3.5, DOOR_Z - 0.38);
    board.rotation.y = Math.PI; // faces into the chamber
    this.scene.add(board);

    const solidGeo = mergeParts(solid);
    if (solidGeo) {
      const mesh = new THREE.Mesh(solidGeo, makeToon(0xffffff, { vertexColors: true }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
    const glowGeo = mergeParts(glow);
    if (glowGeo) {
      const gm = new THREE.MeshBasicMaterial({ vertexColors: true });
      this.mats.push(gm);
      this.scene.add(new THREE.Mesh(glowGeo, gm));
    }

    // ---- dust motes -------------------------------------------------------
    const N = 260;
    const pts = new Float32Array(N * 3);
    this.motes = new Float32Array(N); // per-mote drift phase
    for (let i = 0; i < N; i++) {
      pts[i * 3] = (rng() * 2 - 1) * HALF_X;
      pts[i * 3 + 1] = rng() * 6 + 0.3;
      pts[i * 3 + 2] = (rng() * 2 - 1) * HALF_Z;
      this.motes[i] = rng() * 6.28;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const mm = new THREE.PointsMaterial({
      color: 0xffd9a0, size: 0.075, transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.mats.push(mm);
    this.moteMesh = new THREE.Points(mg, mm);
    this.moteMesh.frustumCulled = false;
    this.scene.add(this.moteMesh);
  }

  /** Build the 11 shared prop geometries and 30 reusable prop shells. */
  _buildProps() {
    this.kindGeo = PROP_KINDS.map((k) => {
      const { parts, glow } = k.build();
      const body = mergeParts(parts);
      const gl = mergeParts(glow);
      if (body) this.geos.push(body);
      if (gl) this.geos.push(gl);
      return { body, glow: gl };
    });
    this.propBodyMat = makeToon(0xffffff, { vertexColors: true });
    this.propGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.mats.push(this.propGlowMat);

    for (let i = 0; i < PROP_COUNT; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(this.kindGeo[0].body, this.propBodyMat);
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.pi = i;
      group.add(body);
      const glow = new THREE.Mesh(this.kindGeo[0].glow || this.kindGeo[0].body, this.propGlowMat);
      glow.userData.pi = i;
      glow.visible = false;
      group.add(glow);
      this.scene.add(group);
      this.props.push({
        i, kind: 0, group, body, glow, ox: 0, oz: 0, x: 0, z: 0, ry0: 0, ry: 0,
        scale: 1, r: 1, h: 1, holder: null, cover: 0, pulse: 0,
        goto: null, bob: 0, moving: 0, dustT: 0,
      });
      this.pickables.push(body, glow);
    }
  }

  /**
   * Seeded prop layout, dealt from the authored PROP_SLOTS table so every prop
   * lands somewhere a mining crew would plausibly have left one. There are more
   * slots than props: the seed picks which spots this match uses, which kind
   * fills a slot that lists alternatives, and a small jitter on each. Same
   * room, arranged by a different shift, identical on all six screens.
   */
  _layoutProps(seed) {
    const rng = mulberry32((seed ^ 0x2f6e2b1) >>> 0);
    const order = PROP_SLOTS.map((s, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    // sorted back into table order so the deal never bunches the used slots
    const chosen = order.slice(0, Math.min(PROP_COUNT, order.length)).sort((a, b) => a - b);

    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      const slot = PROP_SLOTS[chosen[i % chosen.length]];
      const kind = KIND_IX[slot.k[(rng() * slot.k.length) | 0]] ?? 0;
      const k = PROP_KINDS[kind];
      const scale = 0.9 + rng() * 0.24;
      const rad = k.r * scale;
      const j = slot.j ?? 0.42;
      const x = clamp(slot.x + (rng() * 2 - 1) * j, -HALF_X + rad + 0.4, HALF_X - rad - 0.4);
      const z = clamp(slot.z + (rng() * 2 - 1) * j, -HALF_Z + rad + 0.4, HALF_Z - rad - 0.4);

      p.kind = kind;
      p.scale = scale;
      p.r = rad;
      p.h = k.h * scale;
      p.ox = x; p.oz = z;   // home: where the mine left it, and where it resets
      p.x = x; p.z = z;
      // things that must line up (carts on rails, crates squared to a wall)
      // carry a yaw in the table; everything else gets a seeded angle
      p.ry0 = slot.ry != null ? slot.ry + (rng() - 0.5) * 0.12 : rng() * Math.PI * 2;
      p.ry = p.ry0;
      p.holder = null;
      p.pulse = 0;
      p.goto = null;
      p.body.geometry = this.kindGeo[kind].body || this.kindGeo[0].body;
      const gl = this.kindGeo[kind].glow;
      p.glow.visible = !!gl;
      if (gl) p.glow.geometry = gl;
      p.group.position.set(x, 0, z);
      p.group.rotation.set(0, p.ry, 0);
      p.group.scale.setScalar(scale);
    }

    // cover rating for the AI: hugging a wall, tucked in a cluster, and NOT
    // standing alone in the middle of the floor like a nervous lamp
    for (const p of this.props) {
      const wall = Math.min(HALF_X - Math.abs(p.x), HALF_Z - Math.abs(p.z));
      let near = 0;
      for (const q of this.props) {
        if (q === p) continue;
        if (Math.hypot(q.x - p.x, q.z - p.z) < 4) near++;
      }
      const mid = clamp(1 - Math.hypot(p.x, p.z) / 9, 0, 1);
      p.cover = clamp(1 - wall / 6, 0, 1) * 2.2 + Math.min(near, 4) * 0.55 - mid * 2.4;
    }
  }

  // ---------------------------------------------------------------- actors --
  _buildActors() {
    // one capybara rig for whoever is seeking this round (local or remote), and
    // one for the "pop back into a capy" moment when somebody is found
    this.seekerAv = createAvatar({ color: 0xb08a5a, hat: 'none' });
    this.scene.add(this.seekerAv.group);
    this.seeker = {
      x: 0, z: SPAWN_Z, ry: Math.PI, anim: 'idle', moveTo: null,
      netX: 0, netZ: SPAWN_Z, netRy: Math.PI, seen: false, sniffReady: 0,
    };
    this.seekerAv.group.position.set(this.seeker.x, 0, this.seeker.z);

    // ghost body: a wispy capy-blob for spectators, merged into one draw call
    const ghostGeo = mergeParts([
      { geo: sph(0.46, 12, 10), color: 0xffffff, y: 0.5, sy: 1.1 },
      { geo: sph(0.3, 10, 8), color: 0xffffff, y: 1.0, z: 0.06 },
      { geo: box(0.3, 0.2, 0.2), color: 0xf4f0ff, y: 0.94, z: 0.28 },
      { geo: sph(0.07, 8, 6), color: 0x3a3050, x: 0.14, y: 1.05, z: 0.24 },
      { geo: sph(0.07, 8, 6), color: 0x3a3050, x: -0.14, y: 1.05, z: 0.24 },
      { geo: sph(0.09, 8, 6), color: 0xffffff, x: 0.24, y: 1.28, z: -0.02, sy: 0.7 },
      { geo: sph(0.09, 8, 6), color: 0xffffff, x: -0.24, y: 1.28, z: -0.02, sy: 0.7 },
      { geo: cone(0.3, 0.5, 8), color: 0xffffff, y: 0.06, rx: Math.PI },
    ]);
    this.ghostGeo = ghostGeo;
    if (ghostGeo) this.geos.push(ghostGeo);
    this.ghostMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false,
    });
    this.mats.push(this.ghostMat);
  }

  _spawnGhost(who, x, z) {
    if (!this.ghostGeo) return;
    const mesh = new THREE.Mesh(this.ghostGeo, this.ghostMat);
    mesh.position.set(x, 0.6, z);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.ghosts.push({ who, mesh, t: Math.random() * 6, x, z, drift: Math.random() * 6.28 });
  }

  _clearGhosts() {
    for (const g of this.ghosts) this.scene.remove(g.mesh);
    this.ghosts.length = 0;
    this._clearTags();
  }

  /** Drop every world-anchored tag: the seeker changes between rounds, and a
   *  tag nobody updates any more would hang on screen forever. */
  _clearTags() {
    for (const el of this.tagEls.values()) el.remove();
    this.tagEls.clear();
  }

  /** The found-you flourish: a capybara pops out of the prop, waves, poofs. */
  _popCapy(who, x, z) {
    const av = createAvatar({ color: who.color, hat: who.hat });
    av.group.position.set(x, 0, z);
    av.group.rotation.y = Math.atan2(this.seeker.x - x, this.seeker.z - z);
    av.setAnim('idle');
    av.playWave();
    this.scene.add(av.group);
    this.pops = this.pops || [];
    this.pops.push({ av, t: 0, who, x, z });
  }

  // ------------------------------------------------------------ round flow --
  /**
   * Kick off round `n` (0-based): assign roles, reset props, hand the round its
   * absolute deadlines. `startAt` is the wall-clock ms the round is meant to
   * begin (the splash deadline, or the previous round card's) so every client
   * runs the same schedule even if one of them was tabbed out; it may be in the
   * past, in which case _advance simply catches that client up.
   *
   * Idempotent: calling it twice for the round already running (the card button
   * racing the card timer, a relayed frame arriving mid-transition) is a no-op,
   * which is what keeps the cave-in curtain to exactly one appearance a round.
   */
  _beginRound(n, startAt) {
    if (this.matchOver || n >= ROUNDS) return;
    const r0 = this.round;
    if (r0 && r0.n === n && !r0.over && this.phase !== 'splash' && this.phase !== 'results') return;
    this._clearCard();
    this._clearGhosts();
    for (const p of this.pops || []) { this.scene.remove(p.av.group); p.av.dispose(); }
    this.pops = [];

    const seekIdx = this._seekerIdxFor(n);
    for (let i = 0; i < this.roster.length; i++) {
      const p = this.roster[i];
      p.role = i === seekIdx ? 'seeker' : 'hider';
      p.roundScore = 0;
      p.prop = -1;
      p.px = 0; p.pz = 0; p.ry = 0;
      p.caught = false;
      p.caughtAt = 0;
      p.ticks = 0;
      p.hidden = false;
      p.finds = 0;
      p.misses = 0;
      p.swept = false;
    }
    for (const p of this.props) {
      p.holder = null;
      p.x = p.ox; p.z = p.oz;
      p.ry = p.ry0;
      p.pulse = 0;
      p.goto = null;
      p.bob = 0;
      p.moving = 0;
      p.hiddenByCatch = false;
      p.group.visible = true;
      p.group.position.set(p.x, 0, p.z);
      p.group.rotation.set(0, p.ry, 0);
      p.group.scale.setScalar(p.scale);
    }

    const seekerPlayer = this.roster[seekIdx];
    this.iAmSeeker = this.me === seekerPlayer;
    const at = Number.isFinite(startAt) ? startAt : Date.now();
    const hideSecs = this.party ? HIDE_SECS : HIDE_SECS_SOLO;
    this.round = {
      n, seekIdx, seekerPlayer, hideSecs,
      at,
      introEnd: at + INTRO_SECS * 1000,
      hideEnd: at + (INTRO_SECS + hideSecs) * 1000,
      seekEnd: at + (INTRO_SECS + hideSecs + SEEK_SECS) * 1000,
      introStep: 0, curtain: false, over: false, clkAt: 0, grace: this._graceSecs(),
      t: hideSecs, total: hideSecs,
    };
    this.seekerAv.setColor(seekerPlayer.color);
    this.seekerAv.setHat(seekerPlayer.hat);
    this.seeker.x = 0;
    this.seeker.z = SPAWN_Z;
    this.seeker.ry = Math.PI;
    this.seeker.netX = this.seeker.x;
    this.seeker.netZ = this.seeker.z;
    this.seeker.netRy = this.seeker.ry;
    this.seeker.seen = false;
    this.seeker.moveTo = null;
    this.seeker.sniffReady = 0;
    this.seekerAv.group.position.set(this.seeker.x, 0, this.seeker.z);
    this.seekerAv.group.rotation.y = this.seeker.ry;
    this.myProp = null;

    if (!this.party) this._aiHide();

    this.phase = 'intro';
    this.f.curtain.classList.remove('on');
    this.f.hud.classList.add('on');
    this.f.count.textContent = '';
    this._setCamMode(this.iAmSeeker ? 'walk' : 'free');
    this.cam.tx = 0;
    this.cam.tz = 0;
    this.game.audio?.play?.('whoosh');
  }

  /** AI hiders claim the best-covered props, spread out, and settle in. */
  _aiHide() {
    const rng = mulberry32((this.seed + this.round?.n * 977 + 31) >>> 0);
    const pool = [...this.props].sort((a, b) => (b.cover + rng() * 1.2) - (a.cover + rng() * 1.2));
    const taken = [];
    for (const who of this.roster) {
      if (who.role !== 'hider') continue;
      let chosen = null;
      for (const p of pool) {
        if (p.holder) continue;
        if (taken.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 2.4)) continue;
        chosen = p;
        break;
      }
      if (!chosen) chosen = pool.find((p) => !p.holder) || null;
      if (!chosen) continue;
      taken.push(chosen);
      // AI shuffle their prop a pace or two, never out into the middle of the
      // floor: a barrel that has wandered somewhere daft gives itself away
      const a = rng() * Math.PI * 2;
      const d = rng() * 1.1;
      who.prop = chosen.i;
      who.px = chosen.ox + Math.cos(a) * d;
      who.pz = chosen.oz + Math.sin(a) * d;
      who.ry = chosen.ry0 + (rng() - 0.5) * 1.4;
      who.hidden = true;
      chosen.holder = who;
      this._applyHide(who);
    }
  }

  /** Park a prop where its hider left it (absolute chamber coords) + yaw. */
  _applyHide(who) {
    const p = this.props[who.prop];
    if (!p) return;
    const nx = clamp(who.px, -HALF_X + p.r + 0.4, HALF_X - p.r - 0.4);
    const nz = clamp(who.pz, -HALF_Z + p.r + 0.4, HALF_Z - p.r - 0.4);
    p.x = nx; p.z = nz;
    p.ry = who.ry;
    p.goto = null;
    p.group.position.set(nx, 0, nz);
    p.group.rotation.y = p.ry;
  }

  /** Idempotent: intro -> hide. The curtain drops HERE and only here. */
  _enterHide(now) {
    const r = this.round;
    if (!r || this.phase !== 'intro') return;
    this.phase = 'hide';
    this._countNumber(this.iAmSeeker ? 'COVER YOUR EYES' : 'HIDE!', true);
    this.game.audio?.play?.('whoosh');
    // No curtain for a hide phase that is already over (a client coming back
    // from a frozen tab): a blindfold you see for one frame reads as a bug.
    if (this.iAmSeeker && !r.curtain && r.hideEnd - now > 1200) {
      r.curtain = true;
      this.f.curtain.classList.add('on');
    }
  }

  /** Idempotent: hide -> seek. Everyone's prop choice locks in right here. */
  _startSeek(now = Date.now()) {
    const r = this.round;
    if (!r || (this.phase !== 'hide' && this.phase !== 'intro')) return;
    if (this.phase === 'intro') this._enterHide(now);
    this.phase = 'seek';
    r.curtain = true;                 // spent for this round, whatever happens
    r.grace = this._graceSecs();
    if (r.hideEnd > now) r.hideEnd = now;
    if (r.seekEnd <= now) r.seekEnd = now + SEEK_SECS * 1000;
    this.f.curtain.classList.remove('on');

    if (this.party && !this.iAmSeeker) {
      // no spot picked in time? the mine picks for you rather than leaving you
      // standing in the open with nothing to be
      if (!this.myProp) {
        const free = [...this.props].filter((p) => !p.holder).sort((a, b) => b.cover - a.cover);
        const pick = free[(Math.random() * Math.min(6, free.length)) | 0] || this.props[0];
        this._possess(pick, true);
      }
      if (this.myProp) {
        this.myProp.goto = null;
        this.me.prop = this.myProp.i;
        this.me.px = this.myProp.x;
        this.me.pz = this.myProp.z;
        this.me.ry = this.myProp.ry;
        this.me.hidden = true;
        this._send({
          k: 'hid', r: r.n, p: this.myProp.i,
          x: +this.myProp.x.toFixed(2), z: +this.myProp.z.toFixed(2), ry: +this.myProp.ry.toFixed(2),
        });
      }
    }
    // props freeze the moment seeking starts: no drifting, no waddle
    if (this.myProp) { this.myProp.goto = null; this.myProp.moving = 0; }
    if (this.iAmSeeker) {
      this._setCamMode('walk');
      this._hint('Walk up to anything that looks too pleased with itself, then click it.');
    } else if (this.myProp) {
      this._setCamMode('prop');
      this._hint('Hold still. Every 5 seconds undiscovered is a point.');
    }
    this.game.audio?.play?.('unlock');
    this._countNumber('SEEK!', true);
  }

  /** Round over: bank everyone's round score and show the interstitial. */
  _endRound(reason) {
    const r = this.round;
    if (!r || r.over) return;
    r.over = true;
    r.reason = reason;

    const active = this._activeHiders();
    const swept = active.length > 0 && active.every((h) => h.caught);
    for (const p of this.roster) {
      if (p.role === 'hider') {
        p.roundScore = p.ticks;
      } else {
        let s = p.finds * FIND_POINTS - p.misses * WRONG_PENALTY;
        if (swept && s > 0) s *= 2; // clean sweep doubles the seeker's round
        p.roundScore = s;
        p.swept = swept;
      }
      // a player's own client counted its own round better than we can
      if (Number.isFinite(p.reported[r.n])) p.roundScore = p.reported[r.n];
      p.rounds[r.n] = Math.round(p.roundScore);
      p.score = p.rounds.reduce((a, b) => a + (b || 0), 0);
    }
    if (this.party) this._send({ k: 'sc', r: r.n, s: Math.round(this.me.roundScore) });

    const last = r.n >= ROUNDS - 1;
    this.f.hud.classList.remove('on');
    this._hint('');
    this.f.sniff.classList.remove('on');
    this.f.curtain.classList.remove('on');
    if (last) this._finishMatch();
    else this._showRoundCard();
  }

  _showRoundCard() {
    this.phase = 'roundcard';
    // absolute again: the next round starts at this stamp on every screen
    this.cardEnd = Date.now() + CARD_SECS * 1000;
    const r = this.round;
    const swept = this.roster[r.seekIdx].swept;
    const found = this.roster.filter((p) => p.role === 'hider' && p.caught);
    const survived = this.roster.filter((p) => p.role === 'hider' && !p.caught && p.prop >= 0);
    const title = swept ? 'Clean sweep!' : found.length ? 'Round over' : 'Nobody found!';
    const nextSeek = this.roster[this._seekerIdxFor(r.n + 1)];
    this._card(`
      <div class="mg-ph-box">
        <div class="mg-ph-title">${title}</div>
        <div class="mg-ph-sub">${swept
    ? `${esc(this.roster[r.seekIdx].name)} found every single one, so that round score doubled.`
    : `${found.length} found, ${survived.length} still pretending to be scenery.`}</div>
        <div class="mg-ph-rows">
          ${[...this.roster].sort((a, b) => b.score - a.score).map((p) => `
            <div class="mg-ph-row${p === this.me ? ' me' : ''}"><i style="background:${hex6(p.color)}"></i>
              <span>${esc(p.name)}${p === this.me ? ' (you)' : ''}</span>
              <span class="mg-ph-badge${p.role === 'seeker' ? '' : ' b2'}">${p.role === 'seeker' ? 'SOUGHT' : p.caught ? 'FOUND' : 'HID'}</span>
              <span class="s">${p.score.toLocaleString()}<u style="text-decoration:none;color:#9b8a6c;font-size:11px"> (${p.roundScore >= 0 ? '+' : ''}${p.roundScore})</u></span></div>`).join('')}
        </div>
        <div class="mg-ph-score-note">Round ${r.n + 2} of ${ROUNDS}: <b>${esc(nextSeek.name)}</b> takes the lantern.</div>
        <div class="mg-ph-btns">
          ${this.party ? '' : '<button class="mg-ph-btn" data-a="next">Next round</button>'}
        </div>
        <div class="mg-ph-blink" data-f="cardgo">starting on its own shortly...</div>
      </div>`);
    // Solo only: in a party the next round begins on the shared deadline, or
    // one impatient capybara would be hiding while everyone else reads.
    const next = this.card.querySelector('[data-a="next"]');
    if (next) {
      next.onclick = () => {
        this.game.audio?.play?.('click');
        this._beginRound(r.n + 1, Date.now());
      };
    }
    this.f.cardgo = this.card.querySelector('[data-f="cardgo"]');
    this.game.audio?.play?.(swept && this.iAmSeeker ? 'success' : 'ding');
  }

  /**
   * How long the seeker waits in an apparently empty chamber before calling the
   * round off. Solo needs no patience (the AI are in their crates before the
   * curtain lifts); a party needs plenty, because a hider whose tab is in the
   * background has NO animation frames and only sends their 'hid' the moment
   * somebody looks at that tab again. Ending the round while a real capybara is
   * still hiding in a barrel is the worst possible outcome.
   */
  _graceSecs() { return this.party ? 15 : 3; }

  /** Hiders who actually got into a prop this round (the catchable set). */
  _activeHiders() {
    return this.roster.filter((p) => p.role === 'hider' && p.prop >= 0);
  }

  _finishMatch() {
    if (this.matchOver) return;
    this.matchOver = true;
    this.phase = 'results';
    this._setCamMode('free');
    this.cam.tx = 0; this.cam.tz = 0; this.cam.dist = 26;

    const score = Math.max(0, Math.round(this.me.score));
    const prevBest = this.game.state.bests?.prophunt || 0;
    const isBest = score > prevBest;
    const payout = this.coinsForScore(score);
    this.finish(score);
    this._sendDone(score);
    this.game.audio?.play?.(isBest ? 'success' : 'ding');

    const rows = [...this.roster].sort((a, b) => b.score - a.score);
    const won = rows[0] === this.me;
    const title = won ? 'Top of the mine!'
      : score > 220 ? 'Sharp eyes' : score > 90 ? 'Not bad at all' : 'Dusty but happy';

    const card = this._card(`
      <div class="mg-ph-box">
        <div class="mg-ph-title">${title}</div>
        <div class="mg-ph-sub">${this.party
    ? 'Two rounds of crates, capybaras and terrible acting.'
    : 'The chamber is quiet again. Every capy has been accounted for.'}</div>
        <div data-a="board"></div>
        <div class="mg-ph-rows">
          <div class="mg-ph-row total"><span>Your score</span><b>${score.toLocaleString()}</b></div>
          <div class="mg-ph-row pay"><span>Coins earned</span><b>+${payout}</b></div>
        </div>
        <div class="mg-ph-best">Best hunt: <b>${Math.max(prevBest, score).toLocaleString()}</b>${
  isBest ? '<span class="mg-ph-tagnew">NEW BEST</span>' : ''}</div>
        <div class="mg-ph-btns">
          <button class="mg-ph-btn" data-a="again">${this.party ? 'Hunt alone' : 'Play again'}</button>
          <button class="mg-ph-btn alt" data-a="back">Back to the mine</button>
        </div>
      </div>`);
    this.boardEl = card.querySelector('[data-a="board"]');
    this._renderBoard();
    card.querySelector('[data-a="again"]').onclick = () => {
      this.game.audio?.play?.('click');
      this._replaySolo();
    };
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    };
  }

  /** Final table: server standings when they land, our own tally until then. */
  _renderBoard() {
    const el = this.boardEl;
    if (!el) return;
    let rows;
    if (this.standings?.length) {
      rows = this.standings.map((s) => {
        const known = this.roster.find((p) => p.id === s.id);
        return {
          name: s.name || known?.name || 'Capy',
          color: known?.color ?? 0xb08a5a,
          score: Math.round(Number(s.score) || 0),
          me: this.selfId != null ? s.id === this.selfId : s.name === this.game.state.name,
        };
      });
    } else {
      rows = this.roster.map((p) => ({
        name: p.name, color: p.color, score: Math.round(p.score), me: p === this.me,
      }));
    }
    rows.sort((a, b) => b.score - a.score);
    el.innerHTML = `<div class="mg-ph-rows">${rows.map((s, i) => `
      <div class="mg-ph-row${i === 0 ? ' win' : ''}${s.me ? ' me' : ''}">
        <span class="n">${i + 1}</span>${i === 0 ? CROWN : ''}
        <i style="background:${hex6(s.color)}"></i>
        <span>${esc(s.name)}${s.me ? ' (you)' : ''}</span>
        <span class="s">${s.score.toLocaleString()}</span></div>`).join('')}</div>`;
    if (this.boardSfx) return;
    this.boardSfx = true;
    if (rows[0]?.me && this.party) this.game.toast?.('You won the prop hunt!');
  }

  /** "Play again": always a solo hunt, the party has moved on. */
  _replaySolo() {
    this._clearCard();
    this._leaveParty();
    this.matchOver = false;
    this.doneSent = false;
    this.boardSfx = false;
    this.standings = null;
    this.boardEl = null;
    this._done = false; // Minigame.finish() guard: a fresh run pays again
    this.seed = (Date.now() >>> 0);
    this.round = null;  // so _beginRound's "already running" guard lets us in
    this.t0 = Date.now();
    this.splashEnd = Infinity;
    this.cardEnd = Infinity;
    this._buildRoster();
    this._layoutProps(this.seed);
    this._beginRound(0, Date.now());
  }

  _leaveParty() {
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this.party = null;
    this._clearCtx();
  }

  _clearCtx() {
    if (this.ctxRef && this.game.__partyCtx === this.ctxRef) this.game.__partyCtx = null;
    this.ctxRef = null;
  }

  // ----------------------------------------------------------------- input --
  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  _bindInput() {
    const canvas = this.renderer.domElement;

    this._on(window, 'keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'escape') { this.quit(); return; }
      if (this.phase === 'splash') {
        // any key drops in, exactly like the other games' splashes: modifiers
        // and Tab do not count, or reaching for a shortcut starts the hunt
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (['tab', 'shift', 'control', 'alt', 'meta', 'capslock', 'os', 'contextmenu'].includes(k)) return;
        e.preventDefault();
        this._beginRound(0, Date.now());
        return;
      }
      if (e.repeat) return;
      this.keys.add(k);
      if (k === ' ' || k === 'spacebar') { e.preventDefault(); this._sniff(); }
    });
    this._on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this._on(window, 'blur', () => this.keys.clear());

    this._on(canvas, 'contextmenu', (e) => e.preventDefault());
    this._on(canvas, 'pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, btn: e.button, id: e.pointerId };
      canvas.setPointerCapture?.(e.pointerId);
    });
    this._on(canvas, 'pointermove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.moved > 5) {
        this.wrap.classList.add('grab');
        // right button (or any drag while free-flying) pans; left orbits
        if (this.cam.mode === 'free' && d.btn !== 2) {
          const c = Math.cos(this.cam.yaw);
          const s = Math.sin(this.cam.yaw);
          const px = -dx * 0.035;
          const pz = -dy * 0.035;
          this.cam.tx = clamp(this.cam.tx + px * c + pz * s, -HALF_X, HALF_X);
          this.cam.tz = clamp(this.cam.tz - px * s + pz * c, -HALF_Z, HALF_Z);
        } else {
          this.cam.yaw += dx * 0.006;
          this.cam.pitch = clamp(this.cam.pitch - dy * 0.004, 0.22, 1.32);
        }
      }
    });
    this._on(canvas, 'pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      this.wrap.classList.remove('grab');
      canvas.releasePointerCapture?.(e.pointerId);
      if (!d || d.moved > 5 || d.btn === 2) return;
      this._click(e.clientX, e.clientY);
    });
    this._on(canvas, 'wheel', (e) => {
      e.preventDefault();
      this.cam.dist = clamp(this.cam.dist + Math.sign(e.deltaY) * 1.6, 5, 34);
    }, { passive: false });
    this._on(window, 'resize', () => this._resize());
  }

  _resize() {
    if (!this.renderer || !this.wrap) return;
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;
    this.vw = w; this.vh = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
  }

  /** Raycast the pointer against the props (and the floor for walk orders). */
  _pick(cx, cy) {
    if (!this.camera) return null;
    const rect = this.wrap.getBoundingClientRect();
    this._ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    const hits = this._ray.intersectObjects(this.pickables, false);
    for (const h of hits) {
      const pi = h.object.userData.pi;
      const prop = pi != null ? this.props[pi] : null;
      // a popped prop is gone from the room, so it must be gone from the cursor
      if (prop && !prop.hiddenByCatch) return { prop, point: h.point };
    }
    const g = this._ray.intersectObject(this.floor, false);
    return g.length ? { prop: null, point: g[0].point } : null;
  }

  _click(cx, cy) {
    if (this.phase !== 'hide' && this.phase !== 'seek') return;
    const hit = this._pick(cx, cy);
    if (!hit) return;
    if (this.iAmSeeker) {
      if (this.phase !== 'seek') return;
      if (hit.prop) {
        const d = Math.hypot(hit.prop.x - this.seeker.x, hit.prop.z - this.seeker.z);
        if (d <= REACH + hit.prop.r) { this._accuse(hit.prop); return; }
        // out of reach: walk there instead of burning 5 points on a squint
        this.seeker.moveTo = { x: hit.prop.x, z: hit.prop.z };
        this._hint('Too far to be sure. Getting closer...');
        return;
      }
      this.seeker.moveTo = { x: clamp(hit.point.x, -HALF_X + 0.6, HALF_X - 0.6), z: clamp(hit.point.z, -HALF_Z + 0.6, HALF_Z - 0.6) };
      return;
    }
    // hider: click a prop to become it, or click the floor to glide there
    if (this.phase !== 'hide') return;
    if (!hit.prop) {
      const p = this.myProp;
      if (!p) return;
      p.goto = {
        x: clamp(hit.point.x, -HALF_X + p.r + 0.4, HALF_X - p.r - 0.4),
        z: clamp(hit.point.z, -HALF_Z + p.r + 0.4, HALF_Z - p.r - 0.4),
      };
      this.game.audio?.play?.('click');
      return;
    }
    if (this.myProp === hit.prop) return;
    if (this.party && hit.prop.holder && hit.prop.holder !== this.me) return;
    this._possess(hit.prop, false);
  }

  // -------------------------------------------------------------- gameplay --
  _possess(prop, auto) {
    if (!prop) return;
    if (this.myProp) {
      // stepping out of the old one: put it back where the mine left it
      const old = this.myProp;
      if (old.holder === this.me) old.holder = null;
      old.x = old.ox; old.z = old.oz; old.ry = old.ry0;
      old.group.position.set(old.x, 0, old.z);
      old.group.rotation.y = old.ry;
      old.group.rotation.z = 0;
      old.pulse = 0;
      old.goto = null;
      old.bob = 0;
      // stop the waddle dead: a crate left bobbing on its own is a giveaway
      old.moving = 0;
    }
    this.myProp = prop;
    prop.holder = this.me;
    prop.goto = null;
    this.me.prop = prop.i;
    this.me.px = prop.x; this.me.pz = prop.z;
    this.me.ry = prop.ry;
    this.me.hidden = true;
    this.particles.burst(prop.x, prop.h * 0.5, prop.z, 16, {
      colors: [CREAM, 0xe0cba4, this.me.color], spread: 2, up: 2.6, size: 0.9,
    });
    this.game.audio?.play?.('pop');
    if (!auto) this._popupAt(prop.x, prop.h + 0.5, prop.z, 'possessed!', 'teal');
    this._setCamMode('prop');
  }

  /**
   * Free prop movement. Click anywhere walkable and the prop glides there at a
   * strolling pace; WASD steers it directly (camera-relative) and cancels the
   * click order; Q/E turn it on the spot. No leash and no prop-prop collision:
   * the chamber is the only boundary, and two crates overlapping for a moment
   * matters far less than a hider who cannot reach the corner they want.
   */
  _updateGlide(dt) {
    const p = this.myProp;
    if (!p || this.phase !== 'hide') return;
    const k = this.keys;
    if (k.has('q')) { p.ry += dt * GLIDE_TURN; p.group.rotation.y = p.ry; }
    if (k.has('e')) { p.ry -= dt * GLIDE_TURN; p.group.rotation.y = p.ry; }
    this.me.ry = p.ry;

    let ix = 0; let iz = 0;
    if (k.has('w') || k.has('arrowup')) iz -= 1;
    if (k.has('s') || k.has('arrowdown')) iz += 1;
    if (k.has('a') || k.has('arrowleft')) ix -= 1;
    if (k.has('d') || k.has('arrowright')) ix += 1;
    let vx = 0; let vz = 0;
    if (ix || iz) {
      p.goto = null;
      const len = Math.hypot(ix, iz);
      const yaw = this.cam.yaw;
      const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
      vx = (fx * -iz + -fz * ix) / len;
      vz = (fz * -iz + fx * ix) / len;
    } else if (p.goto) {
      const dx = p.goto.x - p.x;
      const dz = p.goto.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.18) { p.goto = null; } else { vx = dx / d; vz = dz / d; }
    }
    if (!vx && !vz) { p.moving = Math.max(0, p.moving - dt * 4); return; }

    p.moving = Math.min(1, p.moving + dt * 5);
    p.x = clamp(p.x + vx * GLIDE_SPEED * dt, -HALF_X + p.r + 0.4, HALF_X - p.r - 0.4);
    p.z = clamp(p.z + vz * GLIDE_SPEED * dt, -HALF_Z + p.r + 0.4, HALF_Z - p.r - 0.4);
    p.group.position.set(p.x, p.group.position.y, p.z);
    this.me.px = p.x;
    this.me.pz = p.z;
    // a sneaking crate scuffs up dust, which is the whole joke
    p.dustT -= dt;
    if (p.dustT <= 0) {
      p.dustT = 0.22;
      this.particles.burst(p.x, 0.12, p.z, 2, {
        colors: [0xa5906c, 0x8a785c], spread: 0.5, up: 0.7, size: 0.5, life: 0.5, g: 4,
      });
    }
  }

  _accuse(prop) {
    const r = this.round;
    if (!r || this.phase !== 'seek' || r.over) return;
    const victims = this.roster.filter((p) => p.role === 'hider' && !p.caught && p.prop === prop.i);
    if (victims.length) {
      if (this.party) this._send({ k: 'cat', r: r.n, p: prop.i });
      this._resolveCatch(prop.i);
      return;
    }
    this.roster[r.seekIdx].misses++;
    this.particles.burst(prop.x, prop.h * 0.6, prop.z, 12, {
      colors: [0x8a785c, 0x6b5b46, 0xa5906c], spread: 1.6, up: 2.2, size: 0.85, life: 0.7,
    });
    this._ripple(prop.x, prop.z, 0xb08a5a);
    this._popupAt(prop.x, prop.h + 0.4, prop.z, `-${WRONG_PENALTY}`, 'bad');
    this._flash('bad');
    this.game.audio?.play?.('thud');
    this._hint(`Just a ${PROP_KINDS[prop.kind].label}. -${WRONG_PENALTY} points.`);
    if (this.party) this._send({ k: 'mis', r: r.n, x: +prop.x.toFixed(2), z: +prop.z.toFixed(2) });
  }

  /** Apply a catch on prop index `pi` (local or relayed): everyone in it pops. */
  _resolveCatch(pi) {
    const r = this.round;
    const prop = this.props[pi];
    if (!r || !prop) return;
    const victims = this.roster.filter((p) => p.role === 'hider' && !p.caught && p.prop === pi);
    if (!victims.length) return;
    for (const v of victims) {
      v.caught = true;
      // stamped, not accumulated: survival points are (caughtAt - seekStart)
      v.caughtAt = Date.now();
      this.roster[r.seekIdx].finds++;
      this._popCapy(v, prop.x, prop.z);
      if (v === this.me) {
        this.myProp = null;
        this._setCamMode('free');
        this.cam.tx = prop.x;
        this.cam.tz = prop.z;
        this.game.toast?.('Found! Drift about as a ghost and watch the rest.');
      }
    }
    prop.holder = null;
    prop.group.visible = false;
    prop.hiddenByCatch = true;
    this.particles.burst(prop.x, prop.h * 0.6, prop.z, 26, {
      colors: [AMBER, CORAL, TEAL, CREAM, 0x7ac74f], spread: 3, up: 4.4, size: 1.1, life: 1.2,
    });
    this._popupAt(prop.x, prop.h + 0.8, prop.z,
      victims.length > 1 ? `DOUBLE! +${FIND_POINTS * victims.length}` : `+${FIND_POINTS}`, 'gold');
    this._flash('good');
    this.game.audio?.play?.('success');
    if (this.iAmSeeker) {
      this._hint(victims.length > 1
        ? 'Two in one crate! Nobody tell them.'
        : `Got ${victims[0].name}!`);
    }
  }

  /** Free warm/cold read: how many hiders are within SNIFF_R of the seeker. */
  _sniff() {
    if (!this.iAmSeeker || this.phase !== 'seek') return;
    const now = Date.now();
    if (now < this.seeker.sniffReady) { this.game.audio?.play?.('click'); return; }
    this.seeker.sniffReady = now + SNIFF_CD * 1000;
    const n = this._activeHiders().filter((h) => !h.caught
      && Math.hypot(this.props[h.prop].x - this.seeker.x, this.props[h.prop].z - this.seeker.z) < SNIFF_R).length;
    this._ripple(this.seeker.x, this.seeker.z, n ? 0xf2b64a : 0x7f92a5);
    this.particles.burst(this.seeker.x, 1.4, this.seeker.z, 8, {
      color: n ? AMBER : 0xbfae90, spread: 1.2, up: 1.6, size: 0.7, life: 0.7, g: 3,
    });
    this._popupAt(this.seeker.x, 2.4, this.seeker.z,
      n === 0 ? 'nothing...' : n === 1 ? '1 nearby!' : `${n} nearby!`, n ? 'gold' : '');
    this.game.audio?.play?.(n ? 'sparkle' : 'tick');
    this._hint(n === 0
      ? 'Nothing but rock dust around here.'
      : `Your nose says ${n} capybara${n > 1 ? 's' : ''} within ${SNIFF_R} steps.`);
    if (this.party) {
      this._send({ k: 'snf', r: this.round.n, x: +this.seeker.x.toFixed(2), z: +this.seeker.z.toFixed(2) });
    }
  }

  // ---------------------------------------------------------------- camera --
  _setCamMode(mode) {
    this.cam.mode = mode;
    // walk and prop sit well UNDER the timbers (eye ~5.0 against a 6.4 post);
    // free flies over the roof, which fades away when it does
    if (mode === 'walk') { this.cam.dist = 9.5; this.cam.pitch = 0.44; this.cam.yaw = 0; }
    if (mode === 'prop') { this.cam.dist = 9; this.cam.pitch = 0.46; }
    if (mode === 'free') { this.cam.dist = 22; this.cam.pitch = 0.95; }
    this.wrap.classList.toggle('seek', mode === 'walk');
  }

  _updateCamera(dt) {
    const c = this.cam;
    if (c.mode === 'walk') {
      c.tx = this.seeker.x; c.ty = 1.2; c.tz = this.seeker.z;
    } else if (c.mode === 'prop' && this.myProp) {
      c.tx = this.myProp.x; c.ty = this.myProp.h * 0.6 + 0.4; c.tz = this.myProp.z;
      // once you are hidden the keys stop nudging and start looking around, so
      // you can watch the seeker close in from behind your own crate
      if (this.phase !== 'hide') {
        const k = this.keys;
        if (k.has('a') || k.has('arrowleft') || k.has('q')) c.yaw += dt * 1.5;
        if (k.has('d') || k.has('arrowright') || k.has('e')) c.yaw -= dt * 1.5;
        if (k.has('w') || k.has('arrowup')) c.pitch = clamp(c.pitch + dt * 0.8, 0.16, 1.3);
        if (k.has('s') || k.has('arrowdown')) c.pitch = clamp(c.pitch - dt * 0.8, 0.16, 1.3);
      }
    } else if (this.phase === 'splash' || this.phase === 'results') {
      // slow showpiece orbit, kept inside the chamber so the lanterns and the
      // timbers sweep past instead of a bird's eye view of a dark rectangle
      c.tx = 0; c.ty = 1.4; c.tz = 0;
      c.yaw += dt * 0.07;
      c.dist = 12;
      c.pitch = 0.34;
    } else {
      c.ty = 0.8;
      // free cursor: WASD pans the view over the chamber
      const k = this.keys;
      let ix = 0; let iz = 0;
      if (k.has('w') || k.has('arrowup')) iz -= 1;
      if (k.has('s') || k.has('arrowdown')) iz += 1;
      if (k.has('a') || k.has('arrowleft')) ix -= 1;
      if (k.has('d') || k.has('arrowright')) ix += 1;
      if (ix || iz) {
        const yaw = c.yaw;
        const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
        const sp = 15 * dt;
        c.tx = clamp(c.tx + (fx * -iz + -fz * ix) * sp, -HALF_X, HALF_X);
        c.tz = clamp(c.tz + (fz * -iz + fx * ix) * sp, -HALF_Z, HALF_Z);
      }
      if (k.has('q')) c.yaw += dt * 1.4;
      if (k.has('e')) c.yaw -= dt * 1.4;
    }
    if (c.mode === 'walk') {
      const k = this.keys;
      if (k.has('q')) c.yaw += dt * 1.6;
      if (k.has('e')) c.yaw -= dt * 1.6;
    }

    const cy = Math.cos(c.pitch);
    let wantX = c.tx + Math.sin(c.yaw) * cy * c.dist;
    let wantZ = c.tz + Math.cos(c.yaw) * cy * c.dist;
    let wantY = c.ty + Math.sin(c.pitch) * c.dist;

    /*
     * Boom spring. The chamber has a roof and four opaque rock walls, so a
     * camera that simply sat `dist` behind the seeker would end up outside the
     * room looking at the back of a wall the moment they hugged one. Instead
     * the whole boom (horizontal AND vertical) shortens by the same factor
     * until the camera is back inside, which reads as the camera politely
     * stepping in for a close shot rather than snapping overhead.
     * Only ABOVE the roof is the spring off: the free cam is meant to fly over
     * the ceiling (which fades) and look down at the floor. Below that the
     * camera stays inside the timber line, so it can never end up outside the
     * chamber peering in between the support posts.
     */
    let lookX = c.tx;
    let lookY = c.ty;
    let lookZ = c.tz;
    if (wantY < CEIL_Y + 0.5) {
      const limX = HALF_X - 0.7;
      const limZ = HALF_Z - 0.7;
      const ox = wantX - c.tx;
      const oz = wantZ - c.tz;
      let f = 1;
      if (Math.abs(wantX) > limX && Math.abs(ox) > 0.001) {
        f = Math.min(f, ((ox > 0 ? limX : -limX) - c.tx) / ox);
      }
      if (Math.abs(wantZ) > limZ && Math.abs(oz) > 0.001) {
        f = Math.min(f, ((oz > 0 ? limZ : -limZ) - c.tz) / oz);
      }
      f = clamp(f, 0.3, 1);
      wantX = c.tx + ox * f;
      wantZ = c.tz + oz * f;
      // keep most of the height while the horizontal boom compresses: a camera
      // that gets close AND low reads as jammed; sliding up the wall reads as
      // an over-shoulder shot
      wantY = c.ty + (wantY - c.ty) * Math.max(f, 0.72);
      // ...and look PAST the subject by as much as the boom lost. Without this
      // the shot at a wall collapses into a top-down of the seeker's hat: the
      // spawn frame was all floor and no chamber.
      if (f < 0.95) {
        const push = (1 - f) * 5.5;
        const dl = Math.hypot(ox, oz) || 1;
        lookX = c.tx - (ox / dl) * push;
        lookZ = c.tz - (oz / dl) * push;
        lookY = c.ty + (1 - f) * 0.5;
      }
    }

    const kk = Math.min(1, dt * 7);
    const n = this.camNow;
    n.x = lerp(n.x, wantX, kk);
    n.y = lerp(n.y, clamp(wantY, 1.5, 30), kk);
    n.z = lerp(n.z, wantZ, kk);
    n.tx = lerp(n.tx, lookX, kk);
    n.ty = lerp(n.ty, lookY, kk);
    n.tz = lerp(n.tz, lookZ, kk);
    this.camera.position.set(n.x, n.y, n.z);
    this.camera.lookAt(n.tx, n.ty, n.tz);
    this._updateOcclusion(dt);
  }

  /**
   * Nothing that hangs from the roof may EVER sit between the camera and what
   * the camera is watching: the playtester's seeker cam was a screenful of
   * ceiling beam. Every overhead piece keeps its own world AABB; if the eye ->
   * look-target segment passes through it, or the eye is right up against it,
   * it fades to a whisper and stops writing depth. Roof pieces (the ceiling and
   * its stalactites) simply go away once the free cam climbs above them.
   */
  _updateOcclusion(dt) {
    const n = this.camNow;
    const above = n.y > CEIL_Y - 0.3;
    const k = Math.min(1, dt * 9);
    for (const o of this.overhead) {
      let want = 1;
      // Looking down from over the roof, the WHOLE ceiling structure clears
      // out, not just the ceiling: a hider picking a spot has to see the floor,
      // not four support beams and a bunting of lanterns lying across it.
      if (above && n.y > o.y0) want = 0;
      else if (segHitsBox(n.x, n.y, n.z, n.tx, n.ty, n.tz, o, 0.35)) want = 0.05;
      else if (distToBox2(n.x, n.y, n.z, o) < 9) want = 0.05; // 3 units of nose
      o.fade = lerp(o.fade, want, k);
      const vis = o.fade > 0.02;
      o.mesh.visible = vis;
      if (!vis) continue;
      o.mat.opacity = o.fade;
      o.mat.transparent = o.fade < 0.995;
      o.mat.depthWrite = o.fade > 0.9;
    }
  }

  // ------------------------------------------------------------ per frame ---
  _tick(now) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this.time += dt;
    this._update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  _update(dt) {
    const now = Date.now();
    this.now = now;
    this.particles.update(dt);
    this._updateAmbient(dt);
    this._advance(now);

    switch (this.phase) {
      case 'splash':
        if (this.f.go && this.party) {
          const s = Math.max(0, Math.ceil((this.splashEnd - now) / 1000));
          this.f.go.textContent = `the lanterns go out in ${s}...`;
        }
        break;
      case 'hide': this._updateHide(dt, now); break;
      case 'seek': this._updateSeek(dt, now); break;
      case 'roundcard':
        if (this.f.cardgo) {
          const s = Math.max(0, Math.ceil((this.cardEnd - now) / 1000));
          this.f.cardgo.textContent = s > 0 ? `next round in ${s}...` : 'here we go...';
        }
        break;
      default: break;
    }

    this._updateProps(dt);
    this._updateActors(dt);
    this._updateRings(dt);
    this._updateCamera(dt);
    this._updateTags();
    this._updateHud();
  }

  /**
   * The phase machine, driven entirely by the wall clock. Each step is
   * idempotent and each one is CHECKED, not chained, so a client returning from
   * a frozen tab walks intro -> hide -> seek -> card in as many frames as it
   * takes and lands in the phase everyone else is already in. Nothing here
   * counts down: `now` is Date.now(), and the deadlines were agreed at the
   * start of the hunt (and re-agreed from the seeker's 'clk' frames).
   */
  _advance(now) {
    if (this.phase === 'splash') {
      if (now >= this.splashEnd) this._beginRound(0, this.splashEnd);
      return;
    }
    const r = this.round;
    if (!r) return;
    if (this.phase === 'intro') {
      const beat = (INTRO_SECS / 3) * 1000;
      const step = Math.ceil((r.introEnd - now) / beat); // 3, 2, 1
      if (step >= 1 && step <= 3 && step !== r.introStep) {
        r.introStep = step;
        this._countNumber(String(step), false);
        this.game.audio?.play?.('tick');
      }
      if (now >= r.introEnd) this._enterHide(now);
    }
    if (this.phase === 'hide' && now >= r.hideEnd) this._startSeek(now);
    if (this.phase === 'seek' && now >= r.seekEnd) this._endRound('time');
    if (this.phase === 'roundcard' && now >= this.cardEnd) this._beginRound(r.n + 1, this.cardEnd);
  }

  _updateHide(dt, now) {
    const r = this.round;
    if (!r) return;
    r.t = Math.max(0, (r.hideEnd - now) / 1000);
    r.total = r.hideSecs;
    if (this.iAmSeeker) {
      this.f.cnum.textContent = String(Math.max(0, Math.ceil(r.t)));
      this._broadcastClock(now, 'hide');
    } else {
      this._updateGlide(dt);
      this._updateHoverRing();
      if (!this.myProp) {
        this._hint('Click any prop to become it. Somewhere nobody would look twice.');
      } else {
        this._hint('Click the floor to glide anywhere. Q/E turn it. Then freeze.');
      }
    }
  }

  _updateSeek(dt, now) {
    const r = this.round;
    if (!r) return;
    r.t = Math.max(0, (r.seekEnd - now) / 1000);
    r.total = SEEK_SECS;
    if (this.iAmSeeker) {
      this._updateSeekerWalk(dt);
      this._broadcastClock(now, 'seek');
      this._updateHoverRing();
    } else {
      this._updateHoverRing(true);
    }

    // Survival ticks, measured between wall-clock stamps rather than added up
    // frame by frame: a hider whose tab was in the background still earns every
    // point they sat still for.
    const start = r.seekEnd - SEEK_SECS * 1000;
    for (const h of this._activeHiders()) {
      const end = Math.min(h.caught ? (h.caughtAt || now) : now, r.seekEnd);
      const t = Math.floor(clamp((end - start) / 1000, 0, SEEK_SECS) / TICK_SECS);
      if (t > h.ticks) {
        const jump = t - h.ticks;
        h.ticks = t;
        // only cheer for a tick we were actually present for
        if (h === this.me && this.myProp && jump === 1) {
          this._popupAt(this.myProp.x, this.myProp.h + 0.6, this.myProp.z, '+1', 'teal');
          this.game.audio?.play?.('tick');
        }
      }
    }

    const active = this._activeHiders();
    if (active.length && active.every((h) => h.caught)) { this._endRound('sweep'); return; }
    if (!active.length) {
      r.grace -= dt;
      if (r.grace <= 0) this._endRound('empty');
    }
  }

  /** Seeker movement: WASD (camera-relative) or a click-to-walk order. */
  _updateSeekerWalk(dt) {
    const s = this.seeker;
    const k = this.keys;
    let ix = 0; let iz = 0;
    if (k.has('w') || k.has('arrowup')) iz -= 1;
    if (k.has('s') || k.has('arrowdown')) iz += 1;
    if (k.has('a') || k.has('arrowleft')) ix -= 1;
    if (k.has('d') || k.has('arrowright')) ix += 1;
    let vx = 0; let vz = 0;
    if (ix || iz) {
      s.moveTo = null;
      const yaw = this.cam.yaw;
      const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
      const len = Math.hypot(ix, iz);
      vx = (fx * -iz + -fz * ix) / len;
      vz = (fz * -iz + fx * ix) / len;
    } else if (s.moveTo) {
      const dx = s.moveTo.x - s.x;
      const dz = s.moveTo.z - s.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) s.moveTo = null;
      else { vx = dx / d; vz = dz / d; }
    }
    const moving = !!(vx || vz);
    if (moving) {
      let nx = s.x + vx * SEEK_SPEED * dt;
      let nz = s.z + vz * SEEK_SPEED * dt;
      nx = clamp(nx, -HALF_X + 0.6, HALF_X - 0.6);
      nz = clamp(nz, -HALF_Z + 0.6, HALF_Z - 0.6);
      // slide around props and the standing furniture instead of walking
      // through the mess table
      for (const p of this.props) {
        if (p.hiddenByCatch) continue;
        const dx = nx - p.x; const dz = nz - p.z;
        const min = p.r + 0.5;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 0.0001) {
          nx = p.x + (dx / d) * min;
          nz = p.z + (dz / d) * min;
        }
      }
      for (const b of this.blockers) {
        const dx = nx - b.x; const dz = nz - b.z;
        const min = b.r + 0.45;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 0.0001) {
          nx = b.x + (dx / d) * min;
          nz = b.z + (dz / d) * min;
        }
      }
      s.x = clamp(nx, -HALF_X + 0.6, HALF_X - 0.6);
      s.z = clamp(nz, -HALF_Z + 0.6, HALF_Z - 0.6);
      const want = Math.atan2(vx, vz);
      s.ry += angDelta(s.ry, want) * Math.min(1, dt * 11);
    }
    s.anim = moving ? 'walk' : 'idle';
  }

  /**
   * Highlight whatever the cursor is over: gold in reach, grey out of it.
   * Throttled to ~20Hz because it is a full raycast across 30 merged props and
   * nobody can see the difference between that and every frame.
   */
  _updateHoverRing(passive = false) {
    const m = this.mouse;
    if (!m || this.phase === 'splash') { this.hoverRing.visible = false; return; }
    if (this.time - (this._hoverT || -9) < 0.05) return;
    this._hoverT = this.time;
    const hit = this._pick(m.x, m.y);
    const prop = hit?.prop || null;
    if (!prop || (passive && this.phase !== 'hide')) {
      this.hoverRing.visible = false;
      this.wrap.classList.remove('aim');
      return;
    }
    const inReach = !this.iAmSeeker
      || Math.hypot(prop.x - this.seeker.x, prop.z - this.seeker.z) <= REACH + prop.r;
    this.hoverRing.visible = true;
    this.hoverRing.position.set(prop.x, 0.06, prop.z);
    this.hoverRing.scale.setScalar(prop.r * 1.5);
    this.hoverRing.material.color.setHex(inReach ? 0xf2b64a : 0x7f92a5);
    this.hoverRing.material.opacity = inReach ? 0.85 : 0.35;
    this.wrap.classList.toggle('aim', inReach);
  }

  _updateProps(dt) {
    const t = this.time;
    for (const p of this.props) {
      if (p.hiddenByCatch) continue;
      // your own prop breathes, and only on your screen
      const mine = p === this.myProp;
      p.pulse = lerp(p.pulse, mine ? 1 : 0, Math.min(1, dt * 6));
      const s = p.scale * (1 + p.pulse * (0.035 + Math.sin(t * 4) * 0.025));
      p.group.scale.setScalar(s);
      // a gliding prop waddles: two dozen kilos of crate, walking
      if (p.moving > 0.001 || p.group.position.y > 0.001) {
        p.bob = p.moving > 0.01 ? Math.abs(Math.sin(t * 7)) * 0.075 * p.moving : lerp(p.group.position.y, 0, Math.min(1, dt * 8));
        p.group.position.set(p.x, p.bob, p.z);
        p.group.rotation.z = Math.sin(t * 7) * 0.03 * p.moving;
      }
    }
    // where a possessed prop has been told to go
    const p2 = this.myProp;
    const showMove = !!(p2 && p2.goto && this.phase === 'hide');
    this.moveRing.visible = showMove;
    if (showMove) {
      this.moveRing.position.set(p2.goto.x, 0.05, p2.goto.z);
      this.moveRing.scale.setScalar(0.55 + Math.sin(t * 5) * 0.06);
      this.moveRing.material.opacity = 0.4 + Math.sin(t * 5) * 0.14;
    }
  }

  _updateActors(dt) {
    // the seeker: driven locally, or interpolated from the relay
    const s = this.seeker;
    if (!this.iAmSeeker && this.party) {
      const k = Math.min(1, dt * 8);
      const moved = Math.hypot(s.netX - s.x, s.netZ - s.z) > 0.05;
      s.x = lerp(s.x, s.netX, k);
      s.z = lerp(s.z, s.netZ, k);
      s.ry += angDelta(s.ry, s.netRy) * k;
      s.anim = moved ? 'walk' : 'idle';
    }
    this.seekerAv.group.position.set(s.x, 0, s.z);
    this.seekerAv.group.rotation.y = s.ry;
    this.seekerAv.setAnim(this.phase === 'hide' ? 'idle' : s.anim);
    this.seekerAv.group.visible = this.phase !== 'splash' && this.phase !== 'results';
    this.seekerAv.update(dt);

    // pop-out capybaras fade into ghosts after their moment in the lantern light
    for (let i = (this.pops?.length || 0) - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.t += dt;
      p.av.update(dt);
      p.av.group.position.y = Math.max(0, Math.sin(p.t * 3) * 0.12);
      if (p.t > 1.7) {
        this.particles.burst(p.x, 0.9, p.z, 12, { color: 0xe6e0f2, spread: 1.4, up: 2.4, size: 0.8, g: 3 });
        this.scene.remove(p.av.group);
        p.av.dispose();
        this.pops.splice(i, 1);
        this._spawnGhost(p.who, p.x, p.z);
        this.game.audio?.play?.('pop');
      }
    }

    // ghosts drift about the chamber, watching
    for (const g of this.ghosts) {
      g.t += dt;
      g.drift += dt * 0.35;
      g.mesh.position.set(
        clamp(g.x + Math.cos(g.drift) * 1.6, -HALF_X + 1, HALF_X - 1),
        1.5 + Math.sin(g.t * 1.5) * 0.28,
        clamp(g.z + Math.sin(g.drift * 0.8) * 1.6, -HALF_Z + 1, HALF_Z - 1),
      );
      g.mesh.rotation.y = Math.sin(g.t * 0.7) * 0.5;
    }
  }

  _updateRings(dt) {
    for (const r of this.rings) {
      if (!r.visible) continue;
      r.userData.life -= dt * 1.4;
      if (r.userData.life <= 0) { r.visible = false; continue; }
      const k = 1 - r.userData.life;
      r.scale.setScalar(0.6 + k * (SNIFF_R * 0.9));
      r.material.opacity = r.userData.life * 0.55;
    }
  }

  _updateAmbient(dt) {
    const pos = this.moteMesh?.geometry.attributes.position;
    if (!pos) return;
    const t = this.time;
    for (let i = 0; i < pos.count; i++) {
      const ph = this.motes[i];
      pos.array[i * 3] += Math.sin(t * 0.3 + ph) * dt * 0.22;
      pos.array[i * 3 + 1] -= dt * 0.14;
      if (pos.array[i * 3 + 1] < 0.2) pos.array[i * 3 + 1] = 6.4;
    }
    pos.needsUpdate = true;
  }

  // ------------------------------------------------------------------- hud --
  _updateHud() {
    const r = this.round;
    if (!r || this.phase === 'splash') return;
    const c = this._hudCache || (this._hudCache = {});
    const live = this.phase === 'hide' || this.phase === 'seek';

    const roundTxt = `Round ${r.n + 1} of ${ROUNDS}`;
    if (c.round !== roundTxt) { c.round = roundTxt; this.f.roundlbl.textContent = roundTxt; }

    const sc = Math.round(this.me.score + (live ? this._liveRoundScore() : 0));
    if (c.score !== sc) { c.score = sc; this.f.scoreval.textContent = sc.toLocaleString(); }

    const ghost = this.me.role === 'hider' && this.me.caught;
    const role = this.iAmSeeker ? 'SEEKER' : ghost ? 'GHOST' : 'HIDER';
    if (c.role !== role) {
      c.role = role;
      this.f.role.textContent = role;
      this.f.role.className = `mg-ph-role${this.iAmSeeker ? ' seeker' : ghost ? ' ghost' : ''}`;
    }

    const phaseTxt = this.phase === 'hide' ? 'Hiding' : this.phase === 'seek' ? 'Seeking' : 'Round over';
    if (c.phase !== phaseTxt) { c.phase = phaseTxt; this.f.phaselbl.textContent = phaseTxt; }
    // straight off the wall clock: no accumulator to drift or freeze
    const end = this.phase === 'seek' ? r.seekEnd : r.hideEnd;
    const total = this.phase === 'seek' ? SEEK_SECS : r.hideSecs;
    const left = clamp((end - this.now) / 1000, 0, total);
    const secs = Math.max(0, Math.ceil(left));
    if (c.secs !== secs) {
      c.secs = secs;
      this.f.clock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      this.f.clock.classList.toggle('warn', secs <= 10 && live);
      if (secs <= 5 && secs > 0 && live) this.game.audio?.play?.('tick');
    }
    this.f.bar.style.width = `${clamp((left / total) * 100, 0, 100)}%`;

    const active = this._activeHiders();
    const leftN = active.filter((h) => !h.caught).length;
    if (c.left !== leftN) { c.left = leftN; this.f.left.textContent = String(leftN); }

    let extra = '&nbsp;';
    if (this.iAmSeeker) extra = `${this.roster[r.seekIdx].finds} found`;
    else if (ghost) extra = 'spectating';
    else if (this.me.prop >= 0) extra = `${this.me.ticks} survival pts`;
    if (c.extra !== extra) { c.extra = extra; this.f.extra.innerHTML = extra; }

    const sig = this.roster.map((p) => `${p.id}${p.caught ? 1 : 0}${p.role[0]}`).join('|');
    if (c.list !== sig) {
      c.list = sig;
      this.f.list.innerHTML = this.roster.filter((p) => p.role === 'hider').map((p) => `
        <div class="mg-ph-who${p.caught ? ' out' : ''}${p === this.me ? ' me' : ''}">
          <i style="background:${hex6(p.color)}"></i><span>${esc(p.name)}</span>
          <b>${p.caught ? 'found' : 'hidden'}</b></div>`).join('')
        || '<div class="mg-ph-who"><span>nobody is hiding!</span></div>';
    }

    // sniff pill (seeker only) and the "they are close" vignette (hider only)
    const showSniff = this.iAmSeeker && this.phase === 'seek';
    this.f.sniff.classList.toggle('on', showSniff);
    if (showSniff) {
      const cd = Math.max(0, (this.seeker.sniffReady - this.now) / 1000);
      this.f.sniff.classList.toggle('cool', cd > 0);
      const txt = cd > 0 ? `${cd.toFixed(1)}s` : 'ready';
      if (c.sniff !== txt) { c.sniff = txt; this.f.sniffst.textContent = txt; }
    }
    let dread = 0;
    if (!this.iAmSeeker && this.myProp && this.phase === 'seek') {
      const d = Math.hypot(this.myProp.x - this.seeker.x, this.myProp.z - this.seeker.z);
      dread = clamp(1 - (d - 2.5) / 7, 0, 1);
    }
    this.f.vig.style.opacity = String(dread * 0.9);
  }

  /** Score the current round would be worth right now (for the live readout). */
  _liveRoundScore() {
    if (this.iAmSeeker) {
      return this.me.finds * FIND_POINTS - this.me.misses * WRONG_PENALTY;
    }
    return this.me.ticks;
  }

  /** World-anchored name tags for the seeker and every drifting ghost. */
  _updateTags() {
    if (this.phase === 'splash' || this.phase === 'results') {
      for (const el of this.tagEls.values()) el.classList.remove('on');
      return;
    }
    const place = (key, who, x, y, z, note, ghost) => {
      let el = this.tagEls.get(key);
      if (!el) {
        el = document.createElement('div');
        el.className = `mg-ph-tag${ghost ? ' ghost' : ''}`;
        el.innerHTML = `<i style="background:${hex6(who.color)}"></i><span>${esc(who.name)}</span><u>${note}</u>`;
        this.f.tags.appendChild(el);
        this.tagEls.set(key, el);
      }
      _v.set(x, y, z).project(this.camera);
      if (_v.z > 1 || Math.abs(_v.x) > 1.25 || Math.abs(_v.y) > 1.25) {
        el.classList.remove('on');
        return;
      }
      el.classList.add('on');
      el.style.left = `${(_v.x * 0.5 + 0.5) * this.vw}px`;
      el.style.top = `${(-_v.y * 0.5 + 0.5) * this.vh}px`;
    };
    const r = this.round;
    if (r && this.seekerAv.group.visible && !this.iAmSeeker) {
      place(`seek:${r.seekerPlayer.id}`, r.seekerPlayer, this.seeker.x, 2.5, this.seeker.z, 'seeking', false);
    }
    for (const g of this.ghosts) {
      place(g.who.id, g.who, g.mesh.position.x, g.mesh.position.y + 1.6, g.mesh.position.z, 'found', true);
    }
  }

  // ------------------------------------------------------------------- net --
  _bindNet() {
    if (!this.party) return;
    const ev = this.game.events;
    if (!ev?.on) return;
    this.subs.push(ev.on('ph-state', (m) => this._onRelay(m)));
    this.subs.push(ev.on('ph-end', (m) => this._onPartyEnd(m)));
  }

  _send(payload) {
    if (!this.party) return;
    this.game.net?.send?.({ t: 'ph-msg', m: payload });
  }

  _sendDone(score) {
    if (!this.party || this.doneSent) return;
    this.doneSent = true;
    this.game.net?.send?.({ t: 'ph-done', score: Math.max(0, Math.round(score) || 0) });
  }

  /**
   * The seeker owns the round clock and their own pose, at CLK_HZ. What goes on
   * the wire is TIME REMAINING, never a timestamp: the receiver turns it back
   * into its own Date.now() deadline, so two capybaras whose system clocks
   * disagree by an hour still hide for the same twenty-five seconds.
   */
  _broadcastClock(now, ph) {
    if (!this.party) return;
    const r = this.round;
    if (now - r.clkAt < 1000 / CLK_HZ) return;
    r.clkAt = now;
    const ms = Math.max(0, Math.round((ph === 'seek' ? r.seekEnd : r.hideEnd) - now));
    this._send({
      k: 'clk', r: r.n, ph, ms, t: +(ms / 1000).toFixed(2),
      x: +this.seeker.x.toFixed(2), z: +this.seeker.z.toFixed(2), ry: +this.seeker.ry.toFixed(2),
    });
  }

  /**
   * One relayed frame. The envelope may arrive as {id, m:{...}} or flattened;
   * either way nothing is trusted: the sender must be on the roster, and only
   * this round's seeker may move the clock, call catches or report misses.
   */
  _onRelay(m) {
    if (!this.party || this.disposed) return;
    if (!this.round) {
      // somebody is already playing while we are still reading the splash (a
      // tab that mounted in the background): drop in, the clock frames below
      // will pull our deadlines onto theirs within the frame
      if (this.phase === 'splash') this._beginRound(0, Date.now());
      if (!this.round) return;
    }
    const from = m?.id ?? m?.from ?? null;
    const p = (m && typeof m.m === 'object' && m.m) ? m.m : m;
    if (from == null || from === this.selfId || !p || typeof p !== 'object') return;
    const who = this.roster.find((q) => q.id === from);
    if (!who) return;
    const r = this.round;
    const rn = Number(p.r);

    if (p.k === 'sc') {
      // a player's own round tally, which may land either side of our own
      // round end: bank it now if we already closed that round, otherwise
      // _endRound picks it up out of `reported`
      const s = Number(p.s);
      if (!Number.isFinite(s) || rn < 0 || rn >= ROUNDS) return;
      if (Number.isFinite(who.reported[rn])) return; // one report per round
      who.reported[rn] = Math.round(s);
      if (who.rounds[rn] != null) {
        who.rounds[rn] = who.reported[rn];
        who.score = who.rounds.reduce((a, b) => a + (b || 0), 0);
        if (this.phase === 'results') this._renderBoard();
      }
      return;
    }
    // the server's leave note, relayed when a capy walks out of the mine or
    // drops off the world: {left:true}, carried on no round in particular
    if (p.left === true) { this._onPartyLeave(who); return; }
    if (rn !== r.n) return;

    switch (p.k) {
      case 'clk': {
        if (who !== r.seekerPlayer) return;
        const now = Date.now();
        // ms remaining -> our own absolute deadline. Only correct on real drift
        // (>400ms), or every frame would jitter the countdown by the ping.
        let ms = Number(p.ms);
        if (!Number.isFinite(ms)) ms = Number(p.t) * 1000;
        if (Number.isFinite(ms) && ms >= 0 && ms < 10 * 60 * 1000) {
          const end = now + ms;
          if (p.ph === 'seek') {
            if (Math.abs(end - r.seekEnd) > 400) r.seekEnd = end;
          } else if (p.ph === 'hide' && this.phase !== 'seek') {
            if (Math.abs(end - r.hideEnd) > 400) {
              r.hideEnd = end;
              r.seekEnd = end + SEEK_SECS * 1000;
            }
          }
        }
        if (Number.isFinite(p.x) && Number.isFinite(p.z)) {
          this.seeker.netX = clamp(Number(p.x), -HALF_X, HALF_X);
          this.seeker.netZ = clamp(Number(p.z), -HALF_Z, HALF_Z);
          if (!this.seeker.seen) {
            this.seeker.seen = true;
            this.seeker.x = this.seeker.netX;
            this.seeker.z = this.seeker.netZ;
          }
        }
        if (Number.isFinite(p.ry)) this.seeker.netRy = Number(p.ry);
        // the seeker is already hunting and we are not: catch up at once
        // (idempotent, and _startSeek walks us out of the intro if need be)
        if (p.ph === 'seek' && (this.phase === 'hide' || this.phase === 'intro')) this._startSeek(now);
        break;
      }
      case 'hid': {
        if (who === r.seekerPlayer || who.prop >= 0) return;
        const pi = Number(p.p) | 0;
        const prop = this.props[pi];
        if (!prop) return;
        who.prop = pi;
        // absolute chamber coords now that props roam freely: clamped to the
        // walkable box, so a client claiming (900, 900) parks against the wall
        who.px = clamp(Number(p.x) || 0, -HALF_X + prop.r + 0.4, HALF_X - prop.r - 0.4);
        who.pz = clamp(Number(p.z) || 0, -HALF_Z + prop.r + 0.4, HALF_Z - prop.r - 0.4);
        who.ry = Number.isFinite(p.ry) ? Number(p.ry) : prop.ry0;
        who.hidden = true;
        // a late check-in refills the patience: whatever kept this capy's tab
        // asleep must not also cost the next one their round
        r.grace = this._graceSecs();
        // first claimant owns the prop's pose; a second hider squeezes in silently
        if (!prop.holder) { prop.holder = who; this._applyHide(who); }
        break;
      }
      case 'cat':
        if (who !== r.seekerPlayer) return;
        this._resolveCatch(Number(p.p) | 0);
        break;
      case 'mis': {
        if (who !== r.seekerPlayer) return;
        const x = clamp(Number(p.x) || 0, -HALF_X, HALF_X);
        const z = clamp(Number(p.z) || 0, -HALF_Z, HALF_Z);
        this.roster[r.seekIdx].misses++;
        this.particles.burst(x, 0.7, z, 10, {
          colors: [0x8a785c, 0x6b5b46], spread: 1.5, up: 2, size: 0.8, life: 0.7,
        });
        this.game.audio?.play?.('thud');
        break;
      }
      case 'snf': {
        if (who !== r.seekerPlayer) return;
        this._ripple(clamp(Number(p.x) || 0, -HALF_X, HALF_X), clamp(Number(p.z) || 0, -HALF_Z, HALF_Z), 0xf2b64a);
        this.game.audio?.play?.('tick');
        break;
      }
      default: break;
    }
  }

  /**
   * A capy abandoned the round. Give their prop back to the scenery rather
   * than leaving the seeker to hunt something nobody is inside, and drop them
   * out of the catchable set so a sweep is not held open by a ghost.
   */
  _onPartyLeave(who) {
    if (who.left) return;
    who.left = true;
    const prop = this.props[who.prop];
    who.prop = -1;
    who.hidden = false;
    if (prop && prop.holder === who) {
      prop.holder = null;
      // back to where the layout put it, unpossessed and unremarkable
      prop.x = prop.ox;
      prop.z = prop.oz;
      prop.ry = prop.ry0;
      prop.group.position.set(prop.ox, 0, prop.oz);
      prop.group.rotation.y = prop.ry0;
    }
    if (who === this.round?.seekerPlayer) {
      // no clock owner left: ours has been free-running all along, so it simply
      // stops being corrected and the round still ends on time
      this._hint('The seeker wandered off. Sit tight until the round runs out.');
    }
  }

  /** Server says the match is done: take its standings as the final word. */
  _onPartyEnd(m) {
    if (!this.party || this.disposed) return;
    const st = Array.isArray(m) ? m : (m?.standings || m?.scores);
    if (Array.isArray(st)) this.standings = st.filter((s) => s && typeof s === 'object');
    if (this.phase === 'results') this._renderBoard();
    else this._finishMatch();
  }

  // -------------------------------------------------------------- teardown --
  quit() {
    if (this.disposed) return;
    // never leave a party waiting on a capybara who has already walked out
    if (this.party && !this.matchOver) this._sendDone(Math.max(0, Math.round(this.me?.score || 0)));
    super.quit();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const [target, type, fn, opts] of this.listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this.listeners.length = 0;
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this._clearCtx(); // the hunt is over: never leak into the next run
    this.keys.clear();

    for (const p of this.pops || []) { p.av.dispose(); }
    this.pops = null;
    this.seekerAv?.dispose();
    this.seekerAv = null;
    for (const el of this.tagEls.values()) el.remove();
    this.tagEls.clear();
    this.ghosts.length = 0;
    this.props.length = 0;
    this.pickables.length = 0;
    this.rings.length = 0;
    this.particles?.dispose();
    this.particles = null;

    if (this.scene) {
      disposeObject(this.scene);
      this.scene.background = null;
      this.scene.fog = null;
      this.scene.clear();
      this.scene = null;
    }
    for (const g of this.geos) g.dispose?.();
    this.geos.length = 0;
    for (const m of this.mats) m.dispose?.();
    this.mats.length = 0;
    this.kindGeo = null;
    this.overhead.length = 0;
    this.blockers.length = 0;
    this.hoverRing = null;
    this.moveRing = null;
    this.myProp = null;
    this.round = null;

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      this.renderer.domElement?.remove();
      this.renderer = null;
    }
    this.styleEl?.remove();
    this.wrap?.remove();
    this.f = null;
    this.card = null;
    this.boardEl = null;
    this.floor = null;
    this.moteMesh = null;
  }
}
