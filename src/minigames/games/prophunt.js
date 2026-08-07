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
 *   { k:'clk', r, ph, t, x, z, ry }  seeker @5Hz: round, phase ('hide'|'seek'|
 *                                    'over'), seconds left, and their pose so
 *                                    hiders watch them coming
 *   { k:'hid', r, p, x, z, ry }      hider locks in ONE frame at hide-phase end:
 *                                    prop index + nudge offset + prop yaw
 *   { k:'cat', r, p }                seeker caught whoever is in prop p
 *   { k:'mis', r, x, z }             seeker's wrong click (dust puff everywhere)
 *   { k:'snf', r, x, z }             seeker sniffed here (ripple ring)
 *   { k:'sc',  r, s }                sender's own score for round r
 * The seeker's client is authoritative for catches and for the round clock
 * inside their own round; hiders slave their timer to 'clk'.
 * ---------------------------------------------------------------------------
 *
 * DEVIATIONS from the spec, all deliberate:
 *  - Solo hide phase is 6s, not 25s: the AI hide instantly, so the curtain is
 *    pure theatre and 25s of staring at planks is not a game.
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
const PROP_COUNT = 30;
const SOLO_HIDERS = 5;
const LEASH = 3;             // how far a hider may nudge a prop from its origin
const NUDGE_SPEED = 2.6;
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
        { geo: box(0.36, 0.44, 0.36), color: IRON, y: 1.7 },
        { geo: cone(0.32, 0.22, 8), color: IRON_D, y: 2.03 },
        { geo: cyl(0.03, 0.03, 0.3, 6), color: IRON_D, y: 1.7, x: 0.19, z: 0.19 },
      ],
      glow: [{ geo: sph(0.17, 10, 8), color: AMBER, y: 1.7 }],
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

// Which kinds get drawn more often: a room of nothing but minecarts is not a
// mine, and the tall silhouettes make the best hiding spots so they stay rare.
const KIND_WEIGHTS = [14, 8, 13, 7, 12, 8, 10, 6, 7, 5, 10];

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
    return { seed, players, seekIdx, meIdx };
  }

  /** Match roster: the party, or me plus five AI hiders with capy names. */
  _buildRoster() {
    const mk = (p) => ({
      ...p, score: 0, roundScore: 0, role: 'hider', prop: -1, ox: 0, oz: 0, ry: 0,
      caught: false, aliveT: 0, ticks: 0, hidden: false, finds: 0, misses: 0,
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
            <div class="mg-ph-rline"><span class="mg-ph-key">WASD</span><span>shuffle it up to ${LEASH} steps from home.</span></div>
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
    if (play) play.onclick = () => this._beginRound(0);
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.quit();
    };
    // A party cannot wait for six people to read: the seeker's clock is already
    // ticking, so the splash counts itself down and any key skips it.
    this.splashT = party ? 6 : Infinity;
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
    for (const [x, z, c] of [[-9, -7, 0xffb060], [9, -6, 0xffb060], [0, 7, 0xffc27a]]) {
      const pl = new THREE.PointLight(c, 26, 26, 1.6);
      pl.position.set(x, 5.4, z);
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
    this.leashRing = this._ring(0x4fb3e8, 0.35);
    this.hoverRing.visible = false;
    this.leashRing.visible = false;
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
   * The chamber: rock shell, timbers, rails, rubble and stalactites merged into
   * ONE vertex-coloured mesh (plus one unlit mesh for every glowing bit), so the
   * whole set dressing is four draw calls and the prop budget goes on props.
   */
  _buildChamber() {
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const solid = [];
    const glow = [];

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
      c.globalAlpha = 1;
      for (let i = 0; i < 26; i++) { // scuffed cart tracks
        c.strokeStyle = '#57462f';
        c.lineWidth = 1 + Math.random() * 2;
        c.beginPath();
        const y = Math.random() * h;
        c.moveTo(0, y);
        c.lineTo(w, y + (Math.random() - 0.5) * 26);
        c.stroke();
      }
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
    // Kept as their own meshes: the hider's free cam flies ABOVE the chamber,
    // and a roof you cannot see through is not much of a hiding view. Both are
    // hidden whenever the camera climbs over them (see _updateCamera).
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_X * 2 + 8, HALF_Z * 2 + 8),
      makeToon(0x231a11),
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = CEIL_Y;
    this.scene.add(ceil);
    this.ceilMeshes = [ceil];
    const stal = [];
    for (let i = 0; i < 34; i++) {
      const x = (rng() * 2 - 1) * (HALF_X + 2);
      const z = (rng() * 2 - 1) * (HALF_Z + 2);
      // capped at 2.3 long so the lowest tip sits at y 6.3: the walk camera
      // tops out at 5.75 and must never sweep through a stalactite
      const len = 0.7 + rng() * 1.6;
      stal.push({
        geo: cone(0.24 + rng() * 0.3, len, 7), color: rng() < 0.5 ? ROCK_D : ROCK,
        x, y: CEIL_Y - len / 2 + 0.1, z, rx: Math.PI,
      });
    }
    const stalGeo = mergeParts(stal);
    if (stalGeo) {
      const sm = new THREE.Mesh(stalGeo, makeToon(0xffffff, { vertexColors: true }));
      this.scene.add(sm);
      this.ceilMeshes.push(sm);
    }

    // ---- rock shell: chunky boulders all the way round, plus a solid backing
    const wallAt = (x, z, s, tone) => solid.push({
      geo: dodec(s), color: tone, x, y: rng() * 1.4 - 0.2, z,
      s: 1, sy: 1.5 + rng() * 1.4, ry: rng() * 3,
    });
    for (let i = 0; i < 30; i++) {
      const t = (i / 30) * (HALF_X * 2 + 3) - (HALF_X + 1.5);
      wallAt(t, -HALF_Z - 1.1 - rng() * 0.7, 1.1 + rng() * 0.9, i % 3 ? ROCK : ROCK_D);
      wallAt(t, HALF_Z + 1.1 + rng() * 0.7, 1.1 + rng() * 0.9, i % 3 ? ROCK_D : ROCK);
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

    // ---- timber support frames along both long walls ----------------------
    const frameZ = [-9.6, -3.2, 3.2, 9.6];
    for (const z of frameZ) {
      for (const sx of [-1, 1]) {
        const x = sx * (HALF_X - 0.9);
        solid.push({ geo: box(0.42, 5.2, 0.42), color: WOOD, x, y: 2.6, z });
        solid.push({ geo: box(0.5, 0.34, 1.9), color: WOOD_D, x, y: 5.3, z });
        solid.push({ geo: box(0.32, 1.2, 0.32), color: WOOD_L, x: x - sx * 0.5, y: 4.7, z, rz: sx * 0.7 });
      }
      // lintel beam across the ceiling ties the two posts together
      solid.push({ geo: box(HALF_X * 2 - 1, 0.4, 0.5), color: WOOD_D, y: 5.35, z });
    }

    // ---- rail line down the west side with sleepers -----------------------
    const railX = -7.6;
    for (const dx of [-0.55, 0.55]) {
      solid.push({ geo: box(0.14, 0.14, HALF_Z * 2 + 4), color: IRON, x: railX + dx, y: 0.16 });
    }
    for (let i = 0; i < 22; i++) {
      solid.push({
        geo: box(1.7, 0.12, 0.34), color: WOOD_D,
        x: railX, y: 0.06, z: -HALF_Z - 1.6 + i * 1.25,
      });
    }
    // and a short spur east, for the eye
    for (const dx of [-0.55, 0.55]) {
      solid.push({ geo: box(0.14, 0.14, 12), color: IRON, x: 9.4 + dx, y: 0.16, z: 3 });
    }
    for (let i = 0; i < 10; i++) {
      solid.push({ geo: box(1.7, 0.12, 0.34), color: WOOD_D, x: 9.4, y: 0.06, z: -2.4 + i * 1.25 });
    }

    // ---- an old elevator cage in the north-east corner (pure decor) -------
    const cx = HALF_X - 2.6;
    const cz = -HALF_Z + 2.4;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      solid.push({ geo: box(0.2, 3.4, 0.2), color: IRON, x: cx + ox * 1.1, y: 1.7, z: cz + oz * 1.1 });
    }
    solid.push({ geo: box(2.6, 0.2, 2.6), color: IRON_D, x: cx, y: 0.1, z: cz });
    solid.push({ geo: box(2.8, 0.24, 2.8), color: IRON_D, x: cx, y: 3.5, z: cz });
    solid.push({ geo: cyl(0.06, 0.06, 5, 6), color: IRON, x: cx, y: 6, z: cz });

    // ---- glowing crystal seams pressed into the walls --------------------
    for (let i = 0; i < 22; i++) {
      const side = (rng() * 4) | 0;
      const along = (rng() * 2 - 1);
      let x; let z;
      if (side === 0) { x = along * HALF_X; z = -HALF_Z - 0.5; }
      else if (side === 1) { x = along * HALF_X; z = HALF_Z + 0.5; }
      else if (side === 2) { x = -HALF_X - 0.5; z = along * HALF_Z; }
      else { x = HALF_X + 0.5; z = along * HALF_Z; }
      const y = 0.6 + rng() * 3.4;
      const c = rng() < 0.55 ? AMBER : TEAL;
      for (let j = 0; j < 3; j++) {
        glow.push({
          geo: oct(0.16 + rng() * 0.22), color: c,
          x: x + (rng() - 0.5) * 1.5, y: y + (rng() - 0.5) * 1.1, z: z + (rng() - 0.5) * 1.5,
          sy: 1.3 + rng(), ry: rng() * 3, rz: rng() * 1.4,
        });
      }
    }

    // ---- two lantern strings slung across the ceiling ---------------------
    // Hung high with a shallow sag: the deepest bulb sits at y 6.1, above the
    // 5.75 the seeker camera can reach, so the boom never swings through one.
    for (const [z0, z1, yTop] of [[-8, -5, 7.4], [5, 8, 7.2]]) {
      const bulbs = 11;
      for (let i = 0; i < bulbs; i++) {
        const t = i / (bulbs - 1);
        const x = -HALF_X + 1 + t * (HALF_X * 2 - 2);
        const sag = Math.sin(t * Math.PI) * 1.1;
        const z = z0 + (z1 - z0) * t;
        const y = yTop - sag;
        glow.push({ geo: sph(0.19, 8, 6), color: i % 3 === 1 ? CORAL : AMBER, x, y, z });
        solid.push({ geo: cyl(0.035, 0.035, 0.34, 5), color: IRON_D, x, y: y + 0.24, z });
        if (i < bulbs - 1) {
          const t2 = (i + 1) / (bulbs - 1);
          const x2 = -HALF_X + 1 + t2 * (HALF_X * 2 - 2);
          const y2 = yTop - Math.sin(t2 * Math.PI) * 1.1;
          const z2 = z0 + (z1 - z0) * t2;
          const dx = x2 - x; const dy = y2 - y; const dz = z2 - z;
          const len = Math.hypot(dx, dy, dz);
          solid.push({
            geo: cyl(0.022, 0.022, len, 4), color: IRON_D,
            x: x + dx / 2, y: y + dy / 2 + 0.4, z: z + dz / 2,
            rz: Math.atan2(dx, dy) * -1, rx: Math.atan2(dz, dy),
          });
        }
      }
    }

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
      });
      this.pickables.push(body, glow);
    }
  }

  /**
   * Seeded prop layout. Anchors hug the walls and cluster in a few pockets so
   * the room reads as a working mine, with a scatter of decoys in the open: a
   * hider by the wall must not be a certainty.
   */
  _layoutProps(seed) {
    const rng = mulberry32((seed ^ 0x2f6e2b1) >>> 0);
    const weightTotal = KIND_WEIGHTS.reduce((a, b) => a + b, 0);
    const pickKind = () => {
      let r = rng() * weightTotal;
      for (let i = 0; i < KIND_WEIGHTS.length; i++) {
        r -= KIND_WEIGHTS[i];
        if (r <= 0) return i;
      }
      return 0;
    };

    const anchors = [];
    for (let i = 0; i < 13; i++) {
      const side = (rng() * 4) | 0;
      const along = (rng() * 2 - 1) * 0.86;
      const inset = 1.5 + rng() * 2.2;
      if (side === 0) anchors.push({ x: along * HALF_X, z: -HALF_Z + inset });
      else if (side === 1) anchors.push({ x: along * HALF_X, z: HALF_Z - inset });
      else if (side === 2) anchors.push({ x: -HALF_X + inset, z: along * HALF_Z });
      else anchors.push({ x: HALF_X - inset, z: along * HALF_Z });
    }
    for (let i = 0; i < 4; i++) {
      anchors.push({ x: (rng() * 2 - 1) * (HALF_X - 5), z: (rng() * 2 - 1) * (HALF_Z - 4.5) });
    }

    const placed = [];
    const spawn = { x: 0, z: HALF_Z - 2.4 };
    for (const p of this.props) {
      const kind = pickKind();
      const k = PROP_KINDS[kind];
      const scale = 0.88 + rng() * 0.3;
      const rad = k.r * scale;
      let x = 0; let z = 0; let ok = false;
      for (let tries = 0; tries < 80 && !ok; tries++) {
        if (rng() < 0.68) {
          const a = anchors[(rng() * anchors.length) | 0];
          x = a.x + (rng() * 2 - 1) * 2.4;
          z = a.z + (rng() * 2 - 1) * 2.4;
        } else {
          x = (rng() * 2 - 1) * (HALF_X - 1.6);
          z = (rng() * 2 - 1) * (HALF_Z - 1.6);
        }
        if (Math.abs(x) > HALF_X - rad - 0.9 || Math.abs(z) > HALF_Z - rad - 0.9) continue;
        if (Math.hypot(x - spawn.x, z - spawn.z) < 4.2) continue; // never in the seeker's lap
        ok = true;
        for (const q of placed) {
          if (Math.hypot(x - q.x, z - q.z) < rad + q.r + 0.75 + LEASH * 0.1) { ok = false; break; }
        }
      }
      if (!ok) { x = (rng() * 2 - 1) * (HALF_X - 3); z = (rng() * 2 - 1) * (HALF_Z - 3); }
      placed.push({ x, z, r: rad });

      p.kind = kind;
      p.scale = scale;
      p.r = rad;
      p.h = k.h * scale;
      p.ox = x; p.oz = z;
      p.x = x; p.z = z;
      p.ry0 = rng() * Math.PI * 2;
      p.ry = p.ry0;
      p.holder = null;
      p.pulse = 0;
      p.body.geometry = this.kindGeo[kind].body || this.kindGeo[0].body;
      const gl = this.kindGeo[kind].glow;
      p.glow.visible = !!gl;
      if (gl) p.glow.geometry = gl;
      p.group.position.set(x, 0, z);
      p.group.rotation.y = p.ry;
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
      x: 0, z: HALF_Z - 2.4, ry: Math.PI, anim: 'idle', moveTo: null,
      netX: 0, netZ: HALF_Z - 2.4, netRy: Math.PI, seen: false, sniffCd: 0,
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
  /** Kick off round `n` (0-based): assign roles, reset props, start hiding. */
  _beginRound(n) {
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
      p.ox = 0; p.oz = 0; p.ry = 0;
      p.caught = false;
      p.aliveT = 0;
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
      p.hiddenByCatch = false;
      p.group.visible = true;
      p.group.position.set(p.x, 0, p.z);
      p.group.rotation.y = p.ry;
      p.group.scale.setScalar(p.scale);
    }

    const seekerPlayer = this.roster[seekIdx];
    this.iAmSeeker = this.me === seekerPlayer;
    this.round = {
      n, seekIdx, seekerPlayer,
      phase: 'hide',
      t: this.party ? HIDE_SECS : HIDE_SECS_SOLO,
      total: this.party ? HIDE_SECS : HIDE_SECS_SOLO,
      clkAcc: 0, grace: 3,
    };
    this.seekerAv.setColor(seekerPlayer.color);
    this.seekerAv.setHat(seekerPlayer.hat);
    this.seeker.x = 0;
    this.seeker.z = HALF_Z - 2.4;
    this.seeker.ry = Math.PI;
    this.seeker.netX = this.seeker.x;
    this.seeker.netZ = this.seeker.z;
    this.seeker.netRy = this.seeker.ry;
    this.seeker.seen = false;
    this.seeker.moveTo = null;
    this.seeker.sniffCd = 0;
    this.seekerAv.group.position.set(this.seeker.x, 0, this.seeker.z);
    this.seekerAv.group.rotation.y = this.seeker.ry;
    this.myProp = null;

    if (!this.party) this._aiHide();

    this.phase = 'intro';
    this.introT = 2.4; // three beats of 0.8s: "3", "2", "1"
    this.introStep = 0;
    this.f.hud.classList.add('on');
    this.f.count.textContent = '';
    this._setCamMode(this.iAmSeeker ? 'walk' : 'free');
    this.cam.tx = 0;
    this.cam.tz = 0;
    this.game.audio?.play?.('whoosh');
  }

  /** AI hiders claim the best-covered props, spread out, with a plausible nudge. */
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
      const a = rng() * Math.PI * 2;
      const d = rng() * 1.1;
      who.prop = chosen.i;
      who.ox = Math.cos(a) * d;
      who.oz = Math.sin(a) * d;
      who.ry = chosen.ry0 + (rng() - 0.5) * 1.4;
      who.hidden = true;
      chosen.holder = who;
      this._applyHide(who);
    }
  }

  /** Move a prop to the offset/yaw its hider settled on. */
  _applyHide(who) {
    const p = this.props[who.prop];
    if (!p) return;
    const nx = clamp(p.ox + who.ox, -HALF_X + p.r + 0.5, HALF_X - p.r - 0.5);
    const nz = clamp(p.oz + who.oz, -HALF_Z + p.r + 0.5, HALF_Z - p.r - 0.5);
    p.x = nx; p.z = nz;
    p.ry = who.ry;
    p.group.position.set(nx, 0, nz);
    p.group.rotation.y = p.ry;
  }

  _startSeek() {
    const r = this.round;
    if (!r || r.phase !== 'hide') return;
    r.phase = 'seek';
    this.phase = 'seek';
    r.t = SEEK_SECS;
    r.total = SEEK_SECS;
    r.grace = 3;
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
        this.me.prop = this.myProp.i;
        this.me.hidden = true;
        this._send({
          k: 'hid', r: r.n, p: this.myProp.i,
          x: +this.me.ox.toFixed(2), z: +this.me.oz.toFixed(2), ry: +this.me.ry.toFixed(2),
        });
      }
    }
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
    if (!r || r.phase === 'over') return;
    r.phase = 'over';
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
    this.cardT = 6;
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
          <button class="mg-ph-btn" data-a="next">Next round</button>
        </div>
        <div class="mg-ph-blink" data-f="cardgo">starting on its own shortly...</div>
      </div>`);
    this.card.querySelector('[data-a="next"]').onclick = () => {
      this.game.audio?.play?.('click');
      this._beginRound(r.n + 1);
    };
    this.game.audio?.play?.(swept && this.iAmSeeker ? 'success' : 'ding');
  }

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
    this._buildRoster();
    this._layoutProps(this.seed);
    this._beginRound(0);
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
        this._beginRound(0);
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
    // hider: click a prop to become it (hide phase only)
    if (this.phase !== 'hide' || !hit.prop) return;
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
      old.pulse = 0;
    }
    this.myProp = prop;
    prop.holder = this.me;
    this.me.prop = prop.i;
    this.me.ox = 0; this.me.oz = 0;
    this.me.ry = prop.ry;
    this.me.hidden = true;
    this.particles.burst(prop.x, prop.h * 0.5, prop.z, 16, {
      colors: [CREAM, 0xe0cba4, this.me.color], spread: 2, up: 2.6, size: 0.9,
    });
    this.game.audio?.play?.('pop');
    if (!auto) this._popupAt(prop.x, prop.h + 0.5, prop.z, 'possessed!', 'teal');
    this._setCamMode('prop');
    this.leashRing.position.set(prop.ox, 0.05, prop.oz);
    this.leashRing.scale.setScalar(LEASH);
  }

  /** WASD shuffles the possessed prop, Q/E turns it, both inside the leash. */
  _nudgeProp(dt) {
    const p = this.myProp;
    if (!p || this.phase !== 'hide') return;
    const k = this.keys;
    let ix = 0; let iz = 0;
    if (k.has('w') || k.has('arrowup')) iz -= 1;
    if (k.has('s') || k.has('arrowdown')) iz += 1;
    if (k.has('a') || k.has('arrowleft')) ix -= 1;
    if (k.has('d') || k.has('arrowright')) ix += 1;
    if (k.has('q')) { p.ry += dt * 2.1; this.me.ry = p.ry; p.group.rotation.y = p.ry; }
    if (k.has('e')) { p.ry -= dt * 2.1; this.me.ry = p.ry; p.group.rotation.y = p.ry; }
    if (!ix && !iz) return;
    const len = Math.hypot(ix, iz) || 1;
    const yaw = this.cam.yaw;
    const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
    const rx = -fz; const rz = fx;
    let nx = p.x + (fx * (-iz) + rx * ix) / len * NUDGE_SPEED * dt;
    let nz = p.z + (fz * (-iz) + rz * ix) / len * NUDGE_SPEED * dt;
    // leash: never further than LEASH from where the mine put this prop
    const dx = nx - p.ox; const dz = nz - p.oz;
    const d = Math.hypot(dx, dz);
    if (d > LEASH) { nx = p.ox + (dx / d) * LEASH; nz = p.oz + (dz / d) * LEASH; }
    nx = clamp(nx, -HALF_X + p.r + 0.5, HALF_X - p.r - 0.5);
    nz = clamp(nz, -HALF_Z + p.r + 0.5, HALF_Z - p.r - 0.5);
    for (const q of this.props) {
      if (q === p) continue;
      if (Math.hypot(nx - q.x, nz - q.z) < p.r + q.r + 0.15) return; // blocked
    }
    p.x = nx; p.z = nz;
    p.group.position.set(nx, 0, nz);
    this.me.ox = nx - p.ox;
    this.me.oz = nz - p.oz;
  }

  _accuse(prop) {
    const r = this.round;
    if (!r || r.phase !== 'seek') return;
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
    if (this.seeker.sniffCd > 0) { this.game.audio?.play?.('click'); return; }
    this.seeker.sniffCd = SNIFF_CD;
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
    // walk and prop stay UNDER the 8.5 ceiling; free flies over it
    if (mode === 'walk') { this.cam.dist = 9.5; this.cam.pitch = 0.5; this.cam.yaw = 0; }
    if (mode === 'prop') { this.cam.dist = 9; this.cam.pitch = 0.52; }
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
     * Above the ceiling the spring is off: the free cam is meant to fly over
     * the roof (which we hide) and look down at the floor.
     */
    if (wantY < CEIL_Y - 0.3) {
      const limX = HALF_X + 0.6;
      const limZ = HALF_Z + 0.6;
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
      // that gets close AND low (seeker spawns 2.4 from the south wall) reads
      // as jammed; sliding up the wall reads as an over-shoulder shot
      wantY = c.ty + (wantY - c.ty) * Math.max(f, 0.7);
    }

    const kk = Math.min(1, dt * 7);
    const n = this.camNow;
    n.x = lerp(n.x, wantX, kk);
    n.y = lerp(n.y, clamp(wantY, 1.5, 30), kk);
    n.z = lerp(n.z, wantZ, kk);
    n.tx = lerp(n.tx, c.tx, kk);
    n.ty = lerp(n.ty, c.ty, kk);
    n.tz = lerp(n.tz, c.tz, kk);
    // over the roof, the roof goes away
    const overhead = n.y > CEIL_Y - 0.3;
    for (const m of this.ceilMeshes || []) m.visible = !overhead;
    this.camera.position.set(n.x, n.y, n.z);
    this.camera.lookAt(n.tx, n.ty, n.tz);
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
    this.particles.update(dt);
    this._updateAmbient(dt);

    switch (this.phase) {
      case 'splash':
        this.splashT -= dt;
        if (this.f.go && this.party) {
          const s = Math.max(0, Math.ceil(this.splashT));
          this.f.go.textContent = `the lanterns go out in ${s}...`;
        }
        if (this.splashT <= 0) this._beginRound(0);
        break;
      case 'intro': {
        this.introT -= dt;
        const n = Math.ceil(this.introT / 0.8); // 3, 2, 1
        if (n >= 1 && n <= 3 && n !== this.introStep) {
          this.introStep = n;
          this._countNumber(String(n), false);
          this.game.audio?.play?.('tick');
        }
        if (this.introT <= 0) {
          this.phase = 'hide';
          this._countNumber(this.iAmSeeker ? 'COVER YOUR EYES' : 'HIDE!', true);
          this.game.audio?.play?.('whoosh');
          if (this.iAmSeeker) this.f.curtain.classList.add('on');
        }
        break;
      }
      case 'hide': this._updateHide(dt); break;
      case 'seek': this._updateSeek(dt); break;
      case 'roundcard':
        this.cardT -= dt;
        if (this.cardT <= 0 && this.round) this._beginRound(this.round.n + 1);
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

  _updateHide(dt) {
    const r = this.round;
    if (!r) return;
    r.t -= dt;
    if (this.iAmSeeker) {
      this.f.cnum.textContent = String(Math.max(0, Math.ceil(r.t)));
      this._broadcastClock(dt, 'hide');
    } else {
      this._nudgeProp(dt);
      this._updateHoverRing();
      if (!this.myProp) {
        this._hint('Click any prop to become it. Somewhere nobody would look twice.');
      } else {
        this._hint('WASD to shuffle it, Q/E to turn it. Then freeze.');
      }
    }
    if (r.t <= 0) this._startSeek();
  }

  _updateSeek(dt) {
    const r = this.round;
    if (!r) return;
    r.t -= dt;
    if (this.iAmSeeker) {
      this._updateSeekerWalk(dt);
      this._broadcastClock(dt, 'seek');
      this.seeker.sniffCd = Math.max(0, this.seeker.sniffCd - dt);
      this._updateHoverRing();
    } else {
      this._updateHoverRing(true);
    }

    // survival ticks for every hider still pretending to be furniture
    for (const h of this._activeHiders()) {
      if (h.caught) continue;
      h.aliveT += dt;
      const t = Math.floor(h.aliveT / TICK_SECS);
      if (t > h.ticks) {
        h.ticks = t;
        if (h === this.me && this.myProp) {
          this._popupAt(this.myProp.x, this.myProp.h + 0.6, this.myProp.z, '+1', 'teal');
          this.game.audio?.play?.('tick');
        }
      }
    }

    const active = this._activeHiders();
    if (active.length && active.every((h) => h.caught)) { this._endRound('sweep'); return; }
    if (!active.length) {
      r.grace -= dt;
      if (r.grace <= 0) { this._endRound('empty'); return; }
    }
    if (r.t <= 0) this._endRound('time');
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
      // slide around props instead of walking through the furniture
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
    }
    const showLeash = !!this.myProp && this.phase === 'hide';
    this.leashRing.visible = showLeash;
    if (showLeash) {
      this.leashRing.position.set(this.myProp.ox, 0.05, this.myProp.oz);
      this.leashRing.scale.setScalar(LEASH);
      this.leashRing.material.opacity = 0.25 + Math.sin(t * 3) * 0.08;
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
    const secs = Math.max(0, Math.ceil(r.t));
    if (c.secs !== secs) {
      c.secs = secs;
      this.f.clock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      this.f.clock.classList.toggle('warn', secs <= 10 && live);
      if (secs <= 5 && secs > 0 && live) this.game.audio?.play?.('tick');
    }
    this.f.bar.style.width = `${clamp((r.t / r.total) * 100, 0, 100)}%`;

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
      const cd = this.seeker.sniffCd;
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

  /** The seeker owns the round clock and their own pose, at CLK_HZ. */
  _broadcastClock(dt, ph) {
    if (!this.party) return;
    const r = this.round;
    r.clkAcc += dt;
    if (r.clkAcc < 1 / CLK_HZ) return;
    r.clkAcc = 0;
    this._send({
      k: 'clk', r: r.n, ph, t: +Math.max(0, r.t).toFixed(2),
      x: +this.seeker.x.toFixed(2), z: +this.seeker.z.toFixed(2), ry: +this.seeker.ry.toFixed(2),
    });
  }

  /**
   * One relayed frame. The envelope may arrive as {id, m:{...}} or flattened;
   * either way nothing is trusted: the sender must be on the roster, and only
   * this round's seeker may move the clock, call catches or report misses.
   */
  _onRelay(m) {
    if (!this.party || this.disposed || !this.round) return;
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
        const t = Number(p.t);
        if (Number.isFinite(t)) {
          // slave our clock to the seeker's: snap on a big gap, ease otherwise
          if (Math.abs(t - r.t) > 1.2) r.t = t;
          else r.t = lerp(r.t, t, 0.25);
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
        if (p.ph === 'seek' && this.phase === 'hide') this._startSeek();
        break;
      }
      case 'hid': {
        if (who === r.seekerPlayer || who.prop >= 0) return;
        const pi = Number(p.p) | 0;
        const prop = this.props[pi];
        if (!prop) return;
        who.prop = pi;
        // the leash is a circle, not a square: a client claiming (3, 3) gets
        // pulled back onto the ring rather than 4.2 units out
        let ox = Number(p.x) || 0;
        let oz = Number(p.z) || 0;
        const d = Math.hypot(ox, oz);
        if (d > LEASH) { ox = (ox / d) * LEASH; oz = (oz / d) * LEASH; }
        who.ox = ox;
        who.oz = oz;
        who.ry = Number.isFinite(p.ry) ? Number(p.ry) : prop.ry0;
        who.hidden = true;
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
    this.ceilMeshes = null;
    this.hoverRing = null;
    this.leashRing = null;
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
