import * as THREE from 'three';
import { Minigame } from '../minigame.js';
import { makeToon, makeGlow, canvasTexture, disposeObject } from '../../core/materials.js';
import { MINIGAMES } from '../../../shared/constants.js';

/**
 * Summit Sprint: an endless downhill sled dash on Frosty Peak.
 *
 * The world scrolls toward the camera in "track space": every prop carries a
 * track distance `s`, and its world z is (travel - s). Ground segments recycle
 * to the back of the queue, obstacles/pickups live in InstancedMesh pools, and
 * a single instanced particle system covers snow spray, coin sparkles, impact
 * puffs and boost streaks.
 */

// ---------------------------------------------------------------- tuning ----
const SEG_LEN = 40;          // length of one ground segment (track units)
const SEG_COUNT = 7;         // ground segments in the recycle queue
const TRACK_W = 76;          // ground mesh width
const GRID_X = 16;           // ground grid divisions
const GRID_Z = 16;
const PLAY_HALF = 9.2;       // props stay inside this half width
const CLAMP_X = 12.4;        // how far the sled may wander
const VIEW_AHEAD = 240;      // spawn horizon (track units)
const STEER_MAX = 15;        // lateral units/sec at full lock
const GRAVITY = 23;
const DIST_SCALE = 0.35;     // track units -> displayed metres
const INVULN = 1.6;          // seconds of mercy after a hit
const BOOST_TIME = 2.3;
const BOOST_MUL = 1.55;

const SKY_TOP = 0x4e9fd6;
const SKY_MID = 0xa9d8f2;
const SKY_LOW = 0xe6f3fc;
const FOG_COL = 0xd7e9f7;
const SNOW_COL = 0xf6faff;

const HIT = {
  pine: { r: 0.8, clear: 3.6 },
  rock: { r: 0.95, clear: 1.25 },
  bump: { r: 1.05, clear: 1.0 },
};

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

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/**
 * Merge a list of primitive parts into one vertex-coloured BufferGeometry so a
 * multi-colour prop (trunk + foliage + snow cap) still costs a single draw
 * call through InstancedMesh. Input geometries are consumed and disposed.
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
      _v.fromBufferAttribute(gn, i).applyNormalMatrix(_nm).normalize();
      nor.push(_v.x, _v.y, _v.z);
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

/** Rolling snow field. Pure function of lateral x and track distance s. */
function heightAt(x, s) {
  const bank = Math.min(Math.max(0, Math.abs(x) - 9.6), 7);
  return (
    Math.sin(s * 0.041) * 1.15 +
    Math.sin(s * 0.0165 + x * 0.06) * 0.85 +
    Math.cos(x * 0.1 - s * 0.028) * 0.4 +
    bank * bank * 0.1
  );
}

/** Thin cylinder spanning two points (rope, flag pole guys). */
function strut(ax, ay, az, bx, by, bz, r, mat) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 0.001;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 5), mat);
  m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  m.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx / len, dy / len, dz / len),
  );
  return m;
}

// ------------------------------------------------------------ prop shapes ---
function pineGeo() {
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.15, 0.22, 1.1, 6), y: 0.55, color: 0x6b4a2e },
    { geo: new THREE.ConeGeometry(1.05, 1.5, 7), y: 1.5, color: 0x2c6b3f },
    { geo: new THREE.ConeGeometry(0.84, 1.4, 7), y: 2.35, color: 0x367a48 },
    { geo: new THREE.ConeGeometry(0.6, 1.3, 7), y: 3.2, color: 0x45914f },
    { geo: new THREE.ConeGeometry(0.3, 0.55, 7), y: 3.6, color: 0xf4faff },
  ]);
}

function rockGeo() {
  return mergeParts([
    { geo: new THREE.IcosahedronGeometry(0.78, 0), y: 0.46, sy: 0.86, rz: 0.35, color: 0x8892a0 },
    { geo: new THREE.IcosahedronGeometry(0.5, 0), x: 0.6, y: 0.28, z: 0.22, ry: 1.1, color: 0x717c8b },
    { geo: new THREE.IcosahedronGeometry(0.44, 0), x: -0.55, y: 0.26, z: -0.3, ry: 2.3, color: 0x9aa6b4 },
    {
      geo: new THREE.SphereGeometry(0.66, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.44),
      y: 0.7, sy: 0.55, color: 0xf4faff,
    },
  ]);
}

function bumpGeo() {
  return mergeParts([
    {
      geo: new THREE.SphereGeometry(1.05, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
      y: 0, sy: 0.6, color: 0xe9f3fd,
    },
    { geo: new THREE.ConeGeometry(0.26, 1.05, 5), x: 0.34, y: 0.6, z: -0.12, rz: 0.24, color: 0x8fd8f0 },
    { geo: new THREE.ConeGeometry(0.19, 0.7, 5), x: -0.38, y: 0.42, z: 0.2, rz: -0.3, color: 0xa9e6f7 },
  ]);
}

function coinGeo() {
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.42, 0.42, 0.1, 12), rx: Math.PI / 2, color: 0xe0952f },
    { geo: new THREE.CylinderGeometry(0.29, 0.29, 0.16, 10), rx: Math.PI / 2, color: 0xffd77a },
  ]);
}

function boostGeo() {
  return mergeParts([
    { geo: new THREE.OctahedronGeometry(0.46, 0), y: 1.25, sy: 1.5, color: 0xa8f2ff },
    { geo: new THREE.OctahedronGeometry(0.24, 0), y: 1.25, sy: 1.6, color: 0xffffff },
    { geo: new THREE.TorusGeometry(0.95, 0.1, 4, 14), y: 0.12, rx: Math.PI / 2, color: 0x4fb3e8 },
    { geo: new THREE.ConeGeometry(0.42, 0.5, 4), y: 0.3, z: -0.5, rx: -Math.PI / 2, color: 0x7fe3ff },
  ]);
}

function rampGeo() {
  return mergeParts([
    { geo: new THREE.BoxGeometry(4.2, 1.4, 3.4), y: 0.5, z: 0.5, color: 0xdceaf7 },
    { geo: new THREE.BoxGeometry(4.4, 0.3, 4.2), y: 1.0, z: -0.15, rx: 0.44, color: 0xf7fbff },
    { geo: new THREE.BoxGeometry(4.5, 0.2, 0.55), y: 1.82, z: -1.9, rx: 0.44, color: 0xe8657a },
    { geo: new THREE.ConeGeometry(0.16, 1.0, 6), x: -2.25, y: 1.7, z: -1.6, color: 0xe8657a },
    { geo: new THREE.ConeGeometry(0.16, 1.0, 6), x: 2.25, y: 1.7, z: -1.6, color: 0xe8657a },
  ]);
}

function flagGeo(color) {
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5), y: 1.3, color: 0xf3f7fc },
    { geo: new THREE.BoxGeometry(0.72, 0.5, 0.05), x: 0.36, y: 2.2, color },
    { geo: new THREE.BoxGeometry(0.72, 0.5, 0.05), x: 0.36, y: 1.6, color },
    { geo: new THREE.SphereGeometry(0.11, 6, 5), y: 2.62, color: 0xf2b64a },
  ]);
}

/** Far backdrop: fogged peaks plus a few cloud shelves. One draw call. */
function mountainsGeo() {
  const rng = mulberry32(90210);
  const parts = [];
  for (let i = 0; i < 24; i++) {
    const a = -1.25 + (i / 23) * 2.5 + (rng() - 0.5) * 0.06;
    const dist = 122 + rng() * 66;
    const x = Math.sin(a) * dist * 1.4;
    const z = -Math.cos(a) * dist;
    const h = 30 + rng() * 48;
    const r = h * (0.52 + rng() * 0.3);
    const seg = 5 + (i % 3);
    parts.push({ geo: new THREE.ConeGeometry(r, h, seg, 1), x, y: h / 2 - 9, z, ry: rng() * 3, color: 0x9dc0dd });
    parts.push({ geo: new THREE.ConeGeometry(r * 0.43, h * 0.36, seg, 1), x, y: h * 0.82 - 9, z, ry: rng() * 3, color: 0xffffff });
  }
  for (let i = 0; i < 12; i++) {
    const x = (rng() - 0.5) * 300;
    const z = -95 - rng() * 70;
    const y = 26 + rng() * 26;
    const s = 7 + rng() * 9;
    parts.push({ geo: new THREE.SphereGeometry(s, 7, 5), x, y, z, sy: 0.42, color: 0xffffff });
    parts.push({ geo: new THREE.SphereGeometry(s * 0.7, 7, 5), x: x + s, y: y - 1, z, sy: 0.4, color: 0xf2f8ff });
  }
  return mergeParts(parts);
}

/** Vertical gradient sky dome. Follows the camera, ignores fog. */
function buildSky() {
  const geo = new THREE.SphereGeometry(420, 20, 14);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const top = new THREE.Color(SKY_TOP);
  const mid = new THREE.Color(SKY_MID);
  const low = new THREE.Color(SKY_LOW);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const t = clamp(p.getY(i) / 420, -1, 1);
    if (t > 0.12) c.copy(mid).lerp(top, clamp((t - 0.12) / 0.7, 0, 1));
    else c.copy(low).lerp(mid, clamp((t + 0.35) / 0.47, 0, 1));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

// ------------------------------------------------------------- sled + rider -
/**
 * Little red sled with a chibi capybara aboard, built from primitives so the
 * minigame stays independent of the player modules. Modelled facing +Z; the
 * caller flips the inner group so it looks down the hill.
 */
function buildSledRig(bodyColor) {
  const rig = new THREE.Group();

  const red = makeToon(0xd8433f);
  const redDark = makeToon(0xa5302c);
  const runner = makeToon(0xe6eef7);
  const ropeMat = makeToon(0xf2b64a);
  const body = makeToon(bodyColor);
  const belly = makeToon(new THREE.Color(bodyColor).lerp(new THREE.Color(0xfff2d6), 0.28).getHex());
  const dark = makeToon(0x241a12);
  const nose = makeToon(0x3a2a1c);
  const scarfMat = makeToon(0xe8657a);
  const scarfDark = makeToon(0xc94e64);

  // --- sled ---------------------------------------------------------------
  const sled = new THREE.Group();
  rig.add(sled);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.15, 2.05), red);
  deck.position.y = 0.3;
  sled.add(deck);

  for (let i = -1; i <= 1; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.07, 0.22), redDark);
    slat.position.set(0, 0.39, i * 0.6);
    sled.add(slat);
  }
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.24, 1.9), redDark);
    rail.position.set(side * 0.58, 0.4, -0.04);
    sled.add(rail);

    const skid = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 2.0), runner);
    skid.position.set(side * 0.44, 0.09, 0);
    sled.add(skid);

    const curl = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 5, 9, Math.PI * 0.8), runner);
    curl.rotation.y = -Math.PI / 2;
    curl.position.set(side * 0.44, 0.09, 0.74);
    sled.add(curl);

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.24, 5), runner);
    post.position.set(side * 0.44, 0.2, -0.7);
    sled.add(post);
  }
  sled.add(strut(0, 0.34, 0.98, 0, 0.86, 0.34, 0.035, ropeMat));

  // --- rider --------------------------------------------------------------
  const rider = new THREE.Group();
  rider.position.set(0, 0.36, -0.16);
  rider.scale.setScalar(0.86);
  rig.add(rider);

  const bob = new THREE.Group();
  rider.add(bob);

  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 14), body);
  torso.scale.set(1, 1.02, 0.88);
  torso.position.set(0, 0.5, -0.02);
  torso.rotation.x = 0.22;
  bob.add(torso);

  const tum = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), belly);
  tum.scale.set(0.86, 0.94, 0.6);
  tum.position.set(0, 0.46, 0.2);
  bob.add(tum);

  const head = new THREE.Group();
  head.position.set(0, 1.08, 0.14);
  bob.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), body);
  skull.scale.set(1, 0.92, 0.95);
  head.add(skull);

  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.34), body);
  muzzle.position.set(0, -0.08, 0.32);
  head.add(muzzle);

  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.06), nose);
  snout.position.set(0, 0.02, 0.5);
  head.add(snout);

  const ears = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), dark);
    eye.position.set(side * 0.21, 0.12, 0.36);
    head.add(eye);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.04), dark);
    brow.position.set(side * 0.21, 0.21, 0.36);
    brow.rotation.z = side * 0.25;
    head.add(brow);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), body);
    ear.scale.set(1, 0.8, 0.5);
    ear.position.set(side * 0.26, 0.36, -0.02);
    head.add(ear);
    ears.push(ear);
  }

  // cosy scarf: collar ring plus two trailing tails that flap
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.11, 5, 12), scarfMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.86, 0.05);
  bob.add(collar);

  const scarf = new THREE.Group();
  scarf.position.set(0, 0.84, -0.14);
  bob.add(scarf);
  const tails = [];
  for (const side of [-1, 1]) {
    const t = new THREE.Group();
    t.position.set(side * 0.13, 0, 0);
    scarf.add(t);
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.46), scarfMat);
    a.position.set(0, -0.02, -0.24);
    t.add(a);
    const b = new THREE.Group();
    b.position.set(0, -0.02, -0.46);
    t.add(b);
    const bm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.44), scarfDark);
    bm.position.set(0, 0, -0.22);
    b.add(bm);
    tails.push({ root: t, tip: b, side });
  }

  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.42, 0.66, 0.08);
    bob.add(pivot);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.3, 3, 7), body);
    arm.position.set(0, -0.2, 0.12);
    arm.rotation.x = 0.75;
    pivot.add(arm);
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), belly);
    paw.position.set(0, -0.34, 0.32);
    pivot.add(paw);
    arms.push(pivot);
  }

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.3, 3, 7), body);
    leg.position.set(side * 0.22, 0.16, 0.42);
    leg.rotation.x = Math.PI / 2 - 0.25;
    bob.add(leg);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), belly);
    foot.scale.set(1, 0.8, 1.2);
    foot.position.set(side * 0.22, 0.14, 0.68);
    bob.add(foot);
  }

  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.09, 7, 6), body);
  tail.position.set(0, 0.42, -0.42);
  bob.add(tail);

  return { rig, sled, rider, bob, head, arms, ears, tails, scarf };
}

// ------------------------------------------------------------------- css ----
const CSS = `
.mg-sled-wrap{position:absolute;inset:0;overflow:hidden;font-family:var(--font);
  color:var(--ink);user-select:none;-webkit-user-select:none;background:#cfe6f7;}
.mg-sled-wrap canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.mg-sled-vig{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .3s ease;
  background:radial-gradient(ellipse 62% 58% at 50% 52%,rgba(0,0,0,0) 40%,rgba(26,52,78,.55) 100%);}
.mg-sled-flash{position:absolute;inset:0;pointer-events:none;opacity:0;}
.mg-sled-flash.hit{animation:mg-sled-fhit .42s ease-out;background:radial-gradient(ellipse at 50% 55%,rgba(232,64,64,0) 35%,rgba(216,50,50,.85) 100%);}
.mg-sled-flash.boost{animation:mg-sled-fboost .5s ease-out;background:radial-gradient(ellipse at 50% 60%,rgba(126,227,255,0) 30%,rgba(126,227,255,.6) 100%);}
@keyframes mg-sled-fhit{from{opacity:1}to{opacity:0}}
@keyframes mg-sled-fboost{from{opacity:.9}to{opacity:0}}

.mg-sled-hud{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .35s ease;}
.mg-sled-hud.on{opacity:1;}
.mg-sled-panel{position:absolute;background:rgba(255,253,246,.92);border-radius:16px;
  padding:9px 15px;box-shadow:var(--shadow);font-weight:800;}
.mg-sled-tl{top:16px;left:16px;min-width:150px;}
.mg-sled-tr{top:16px;right:16px;display:flex;gap:9px;align-items:center;font-size:19px;}
.mg-sled-tc{top:16px;left:50%;translate:-50% 0;display:flex;gap:7px;padding:8px 14px;}
.mg-sled-lbl{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9b8a6c;}
.mg-sled-dist{font-size:26px;line-height:1.05;letter-spacing:.01em;}
.mg-sled-dist span{font-size:13px;color:#9b8a6c;margin-left:3px;}
.mg-sled-spd{font-size:12px;color:#6d7f92;margin-top:3px;}
.mg-sled-bar{margin-top:5px;height:7px;border-radius:99px;background:#e7ecf2;overflow:hidden;}
.mg-sled-bar i{display:block;height:100%;width:0%;border-radius:99px;
  background:linear-gradient(90deg,#4fb3e8,#7ac74f 55%,#f2b64a 78%,#e8657a);transition:width .12s linear;}
.mg-sled-heart{width:27px;height:25px;fill:var(--accent);filter:drop-shadow(0 2px 0 rgba(45,36,23,.18));
  transition:transform .2s ease;}
.mg-sled-heart.gone{fill:#d7cfc0;transform:scale(.72);}
.mg-sled-coin{width:22px;height:22px;}
.mg-sled-tr.bump{animation:mg-sled-bump .28s ease;}
@keyframes mg-sled-bump{50%{scale:1.16}}

.mg-sled-pops{position:absolute;left:50%;top:58%;translate:-50% 0;width:0;pointer-events:none;}
.mg-sled-pop{position:absolute;left:0;top:0;translate:-50% 0;white-space:nowrap;font-weight:900;
  font-size:26px;color:#fff;text-shadow:0 3px 0 rgba(45,36,23,.35);animation:mg-sled-pop 1s ease-out forwards;}
.mg-sled-pop.gold{color:var(--gold);} .mg-sled-pop.air{color:#7fe3ff;} .mg-sled-pop.bad{color:#ff8f8f;}
@keyframes mg-sled-pop{from{opacity:0;translate:-50% 18px;scale:.6}
  25%{opacity:1;translate:-50% -6px;scale:1.12}to{opacity:0;translate:-50% -70px;scale:1}}

.mg-sled-count{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  pointer-events:none;}
.mg-sled-num{font-size:130px;font-weight:900;color:#fff;text-shadow:0 6px 0 rgba(45,36,23,.3);
  animation:mg-sled-num .85s ease-out forwards;}
.mg-sled-num.go{color:var(--gold);font-size:104px;}
@keyframes mg-sled-num{from{opacity:0;scale:2.1}18%{opacity:1;scale:1}to{opacity:0;scale:.72}}

.mg-sled-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:13px;padding:22px;text-align:center;
  background:linear-gradient(180deg,rgba(20,32,44,.34),rgba(20,32,44,.72));}
.mg-sled-card.out{animation:mg-sled-out .28s ease forwards;}
@keyframes mg-sled-out{to{opacity:0;scale:1.05;pointer-events:none}}
.mg-sled-box{background:var(--cream);border-radius:28px;padding:26px 32px;width:min(470px,92vw);
  box-shadow:var(--shadow);animation:mg-sled-in .3s ease;}
@keyframes mg-sled-in{from{opacity:0;translate:0 20px;scale:.94}}
.mg-sled-title{font-size:40px;font-weight:900;color:var(--accent);letter-spacing:.02em;line-height:1;}
.mg-sled-sub{font-weight:700;color:#8a7a5a;font-size:13px;margin-top:6px;}
.mg-sled-keys{display:flex;gap:8px;justify-content:center;margin:16px 0 12px;flex-wrap:wrap;}
.mg-sled-key{background:#fff;border:2px solid #e3d9c4;border-radius:9px;padding:5px 11px;
  font-weight:900;font-size:14px;box-shadow:0 2px 0 #e3d9c4;}
.mg-sled-rules{display:flex;flex-direction:column;gap:7px;text-align:left;margin:4px 0 4px;}
.mg-sled-rule{display:flex;gap:10px;align-items:center;font-size:13.5px;font-weight:700;color:#5c5140;}
.mg-sled-dot{width:22px;height:22px;border-radius:7px;flex:none;box-shadow:inset 0 -3px 0 rgba(0,0,0,.16);}
.mg-sled-best{margin-top:14px;font-weight:800;font-size:13px;color:#8a7a5a;}
.mg-sled-btns{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;}
.mg-sled-btn{background:var(--accent);color:#fff;border:3px solid #fff;font-family:var(--font);
  font-weight:900;font-size:16px;padding:11px 24px;border-radius:999px;cursor:pointer;
  box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-sled-btn:hover{scale:1.06;} .mg-sled-btn:active{scale:.96;}
.mg-sled-btn.alt{background:var(--accent2);}
.mg-sled-btn.ghost{background:transparent;color:var(--ink);border-color:#d8ccb4;box-shadow:none;}
.mg-sled-hint{margin-top:12px;font-size:12px;font-weight:700;color:#a99a80;}
.mg-sled-blink{margin-top:12px;font-size:12.5px;font-weight:800;color:#a99a80;
  animation:mg-sled-blink 1.5s ease-in-out infinite;}
@keyframes mg-sled-blink{50%{opacity:.35}}

.mg-sled-rows{margin:16px 0 4px;display:flex;flex-direction:column;gap:6px;}
.mg-sled-row{display:flex;justify-content:space-between;align-items:center;background:var(--card);
  border-radius:12px;padding:8px 14px;font-weight:800;font-size:14px;}
.mg-sled-row b{font-size:16px;}
.mg-sled-row.total{background:#2d2417;color:#fff;}
.mg-sled-row.pay{background:var(--gold);}
.mg-sled-tag{display:inline-block;background:var(--accent);color:#fff;font-size:11px;font-weight:900;
  padding:3px 9px;border-radius:99px;margin-left:7px;letter-spacing:.06em;vertical-align:middle;
  animation:mg-sled-tag .8s ease-in-out infinite;}
@keyframes mg-sled-tag{50%{scale:1.12}}

.mg-sled-quit{position:absolute;right:16px;bottom:16px;background:rgba(255,253,246,.9);border:0;
  font-family:var(--font);font-weight:800;font-size:13px;padding:9px 16px;border-radius:999px;
  cursor:pointer;box-shadow:var(--shadow);transition:scale .12s ease;}
.mg-sled-quit:hover{scale:1.07;}
.mg-sled-tip{position:absolute;left:50%;bottom:18px;translate:-50% 0;background:rgba(45,36,23,.7);
  color:#fff;font-size:12.5px;font-weight:700;padding:7px 16px;border-radius:999px;
  transition:opacity .6s ease;}
`;

const HEART = '<svg class="mg-sled-heart" viewBox="0 0 24 22"><path d="M12 20.8S1.6 14 1.6 7.5C1.6 4 4.4 1.4 7.5 1.4c1.9 0 3.6 1 4.5 2.5.9-1.5 2.6-2.5 4.5-2.5 3.1 0 5.9 2.6 5.9 6.1 0 6.5-10.4 13.3-10.4 13.3z"/></svg>';
const COIN_ICO = '<svg class="mg-sled-coin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#e0952f"/><circle cx="12" cy="12" r="7.4" fill="#f2b64a"/><circle cx="12" cy="12" r="3.6" fill="#ffd77a"/></svg>';

// ================================================================== game ====
export class SledGame extends Minigame {
  static id = 'sled';
  static name = 'Summit Sprint';

  constructor(game) {
    super(game);
    this.phase = 'splash';
    this.raf = 0;
    this.time = 0;
    this.disposed = false;
    this.geos = [];        // geometries we own outside the scene graph churn
    this.listeners = [];
    this.props = [];
    this.parts = [];       // live particles
    this.keys = new Set();
  }

  // -------------------------------------------------------------- lifecycle -
  mount(root) {
    super.mount(root);
    this._buildDom(root);
    this._buildScene();
    this._resetWorld();
    this._bindInput();
    this._last = performance.now();
    this.raf = requestAnimationFrame(this._tick);
  }

  coinsForScore(score) { return Math.round(score / 20); }

  // ------------------------------------------------------------------- dom -
  _buildDom(root) {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    this.styleEl = style;

    const wrap = document.createElement('div');
    wrap.className = 'mg-sled-wrap';
    root.appendChild(wrap);
    this.wrap = wrap;

    const vig = document.createElement('div');
    vig.className = 'mg-sled-vig';
    wrap.appendChild(vig);
    this.vig = vig;

    const flash = document.createElement('div');
    flash.className = 'mg-sled-flash';
    wrap.appendChild(flash);
    this.flash = flash;
    flash.addEventListener('animationend', () => { flash.className = 'mg-sled-flash'; });

    const hud = document.createElement('div');
    hud.className = 'mg-sled-hud';
    hud.innerHTML = `
      <div class="mg-sled-panel mg-sled-tl">
        <div class="mg-sled-lbl">Descent</div>
        <div class="mg-sled-dist"><b data-f="dist">0</b><span>m</span></div>
        <div class="mg-sled-spd"><b data-f="spd">0</b> km/h</div>
        <div class="mg-sled-bar"><i data-f="bar"></i></div>
      </div>
      <div class="mg-sled-panel mg-sled-tc" data-f="hearts"></div>
      <div class="mg-sled-panel mg-sled-tr" data-f="coinbox">${COIN_ICO}<b data-f="coins">0</b></div>
      <div class="mg-sled-pops" data-f="pops"></div>`;
    wrap.appendChild(hud);
    this.hud = hud;
    this.f = {};
    hud.querySelectorAll('[data-f]').forEach((el) => { this.f[el.dataset.f] = el; });
    this.f.hearts.innerHTML = HEART + HEART + HEART;
    this.heartEls = [...this.f.hearts.querySelectorAll('.mg-sled-heart')];

    const tip = document.createElement('div');
    tip.className = 'mg-sled-tip';
    tip.textContent = 'A / D or mouse to carve  .  Space to hop  .  ramps launch you';
    tip.style.opacity = '0';
    wrap.appendChild(tip);
    this.tip = tip;

    const count = document.createElement('div');
    count.className = 'mg-sled-count';
    wrap.appendChild(count);
    this.countEl = count;

    const quit = document.createElement('button');
    quit.className = 'mg-sled-quit';
    quit.textContent = 'Quit run';
    quit.onclick = () => { this.game.audio?.play?.('click'); this.quit(); };
    wrap.appendChild(quit);
    this.quitBtn = quit;

    this.cardHost = document.createElement('div');
    this.cardHost.style.cssText = 'position:absolute;inset:0;';
    wrap.appendChild(this.cardHost);

    this._showSplash();
  }

  _showSplash() {
    const best = this.game.state.bests?.sled || 0;
    const card = document.createElement('div');
    card.className = 'mg-sled-card';
    card.innerHTML = `
      <div class="mg-sled-box">
        <div class="mg-sled-title">Summit Sprint</div>
        <div class="mg-sled-sub">Point the sled downhill and do not look back</div>
        <div class="mg-sled-keys">
          <span class="mg-sled-key">A</span><span class="mg-sled-key">D</span>
          <span class="mg-sled-key">&#8592;</span><span class="mg-sled-key">&#8594;</span>
          <span class="mg-sled-key">mouse</span><span class="mg-sled-key">space = hop</span>
        </div>
        <div class="mg-sled-rules">
          <div class="mg-sled-rule"><span class="mg-sled-dot" style="background:#f2b64a"></span>
            Snowcoins are worth 10 points each.</div>
          <div class="mg-sled-rule"><span class="mg-sled-dot" style="background:#7fe3ff"></span>
            Blue crystals blast you forward for a burst of speed.</div>
          <div class="mg-sled-rule"><span class="mg-sled-dot" style="background:#f7fbff"></span>
            Kickers send you flying. Longer air, bigger bonus.</div>
          <div class="mg-sled-rule"><span class="mg-sled-dot" style="background:#367a48"></span>
            Pines, rocks and ice cost a heart. You have three.</div>
        </div>
        <div class="mg-sled-best">Best run: <b>${best.toLocaleString()}</b></div>
        <div class="mg-sled-btns">
          <button class="mg-sled-btn" data-a="play">Drop in</button>
          <button class="mg-sled-btn ghost" data-a="back">Back to the peak</button>
        </div>
        <div class="mg-sled-blink">or press any key</div>
      </div>`;
    this.cardHost.appendChild(card);
    this.card = card;
    card.querySelector('[data-a="play"]').onclick = () => this._beginCountdown();
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    };
  }

  _clearCard() {
    if (!this.card) return;
    const c = this.card;
    this.card = null;
    c.classList.add('out');
    c.addEventListener('animationend', () => c.remove());
  }

  _popup(text, cls = '') {
    if (!this.f?.pops) return;
    const el = document.createElement('div');
    el.className = `mg-sled-pop ${cls}`;
    el.textContent = text;
    el.style.left = `${(Math.random() - 0.5) * 120}px`;
    el.style.top = `${(Math.random() - 0.5) * 40}px`;
    this.f.pops.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  _countNumber(text, go) {
    const el = document.createElement('div');
    el.className = `mg-sled-num${go ? ' go' : ''}`;
    el.textContent = text;
    this.countEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  // ----------------------------------------------------------------- scene -
  _buildScene() {
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.wrap.insertBefore(this.renderer.domElement, this.vig);

    const scene = new THREE.Scene();
    this.scene = scene;
    scene.background = new THREE.Color(FOG_COL);
    scene.fog = new THREE.Fog(FOG_COL, 58, 218);

    this.camera = new THREE.PerspectiveCamera(56, w / h, 0.5, 900);
    this.camera.position.set(0, 6, 9);

    scene.add(new THREE.HemisphereLight(0xf2f8ff, 0x8fa6bd, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4de, 1.5);
    sun.position.set(9, 20, 7);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x9fd0f5, 0.45);
    rim.position.set(-7, 6, -12);
    scene.add(rim);

    this.sky = buildSky();
    scene.add(this.sky);

    const mg = mountainsGeo();
    this.mountains = new THREE.Mesh(mg, makeToon(0xffffff, { vertexColors: true, flatShading: true }));
    this.mountains.frustumCulled = false;
    scene.add(this.mountains);

    // ---- ground segments --------------------------------------------------
    const groundMat = makeToon(0xffffff, { vertexColors: true, flatShading: true });
    this.segs = [];
    for (let i = 0; i < SEG_COUNT; i++) {
      const geo = this._segGeo();
      const mesh = new THREE.Mesh(geo, groundMat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.segs.push({ mesh, geo, nearS: 0 });
    }

    // ---- instanced prop pools --------------------------------------------
    const vcToon = makeToon(0xffffff, { vertexColors: true, flatShading: true });
    const vcGlow = makeGlow(0xffffff, { unique: true });
    vcGlow.vertexColors = true;
    this.glowMat = vcGlow;

    const pools = [
      ['pine', pineGeo(), 170, vcToon],
      ['rock', rockGeo(), 26, vcToon],
      ['bump', bumpGeo(), 26, vcToon],
      ['coin', coinGeo(), 84, vcToon],
      ['ramp', rampGeo(), 6, vcToon],
      ['boost', boostGeo(), 6, vcGlow],
      ['flagA', flagGeo(0xe8657a), 22, vcToon],
      ['flagB', flagGeo(0x4fb3e8), 22, vcToon],
    ];
    this.im = {};
    this.imCount = {};
    for (const [key, geo, cap, mat] of pools) {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.userData.cap = cap;
      scene.add(m);
      this.im[key] = m;
      this.imCount[key] = 0;
      this.geos.push(geo);
    }

    // ---- particles (spray, sparkles, puffs, streaks) ----------------------
    const pGeo = new THREE.OctahedronGeometry(0.5, 0);
    const pMat = makeGlow(0xffffff, { unique: true });
    pMat.transparent = true;
    pMat.opacity = 0.95;
    pMat.depthWrite = false;
    this.pfx = new THREE.InstancedMesh(pGeo, pMat, 230);
    this.pfx.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pfx.frustumCulled = false;
    this.pfx.count = 0;
    this.pfx.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(230 * 3).fill(1), 3);
    this.pfx.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.pfx);
    this.geos.push(pGeo);

    // ---- ambient snowfall -------------------------------------------------
    const flakeTex = canvasTexture(48, 48, (c, cw, ch) => {
      const g = c.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, cw / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, cw, ch);
    });
    const N = 280;
    const fg = new THREE.BufferGeometry();
    const fpos = new Float32Array(N * 3);
    this.flakeSpeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      fpos[i * 3] = rand(-34, 34);
      fpos[i * 3 + 1] = rand(-6, 26);
      fpos[i * 3 + 2] = rand(-70, 12);
      this.flakeSpeed[i] = rand(1.4, 3.6);
    }
    fg.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    this.snowfall = new THREE.Points(fg, new THREE.PointsMaterial({
      map: flakeTex, size: 0.44, transparent: true, depthWrite: false,
      opacity: 0.8, sizeAttenuation: true, fog: false,
    }));
    this.snowfall.frustumCulled = false;
    scene.add(this.snowfall);
    this.geos.push(fg);

    // ---- sled rig ---------------------------------------------------------
    this.rigRoot = new THREE.Group();     // world position + lean + yaw
    this.rigFace = new THREE.Group();     // flips the model to face downhill
    this.rigFace.rotation.y = Math.PI;
    this.rigRoot.add(this.rigFace);
    scene.add(this.rigRoot);
    this.rig = buildSledRig(this.game.state.color ?? 0xb08a5a);
    this.rigFace.add(this.rig.rig);

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.95, 18),
      new THREE.MeshBasicMaterial({ color: 0x2c4a68, transparent: true, opacity: 0.26, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);
  }

  _segGeo() {
    const g = new THREE.BufferGeometry();
    const nv = (GRID_X + 1) * (GRID_Z + 1);
    const pos = new Float32Array(nv * 3);
    for (let j = 0; j <= GRID_Z; j++) {
      for (let i = 0; i <= GRID_X; i++) {
        const k = (j * (GRID_X + 1) + i) * 3;
        pos[k] = -TRACK_W / 2 + (i / GRID_X) * TRACK_W;
        pos[k + 1] = 0;
        pos[k + 2] = -(j / GRID_Z) * SEG_LEN;
      }
    }
    const idx = [];
    for (let j = 0; j < GRID_Z; j++) {
      for (let i = 0; i < GRID_X; i++) {
        const a = j * (GRID_X + 1) + i;
        const b = a + 1;
        const c = a + GRID_X + 1;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * Rebuild a recycled segment: heights from the terrain function, plus a cool
   * blue tint that deepens toward the side banks so the run corridor reads as
   * a groomed lane instead of a featureless white field.
   */
  _reshapeSegment(seg) {
    const pos = seg.geo.attributes.position;
    const col = seg.geo.attributes.color;
    const arr = pos.array;
    const carr = col.array;
    const snow = new THREE.Color(SNOW_COL);
    const cool = new THREE.Color(0xbcd4ea);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const k = i * 3;
      const x = arr[k];
      const y = heightAt(x, seg.nearS - arr[k + 2]);
      arr[k + 1] = y;
      const edge = clamp((Math.abs(x) - 8.4) / 6.5, 0, 1);
      const dip = clamp(0.32 - y * 0.12, 0, 0.32);
      c.copy(snow).lerp(cool, clamp(edge * 0.62 + dip, 0, 0.8));
      carr[k] = c.r; carr[k + 1] = c.g; carr[k + 2] = c.b;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    seg.geo.computeVertexNormals();
  }

  // ----------------------------------------------------------------- input -
  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  _bindInput() {
    const STEER = ['a', 'A', 'd', 'D', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar'];

    this._on(window, 'keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Swallow our control keys before the world hotkeys (D = dance) see them.
      if (STEER.includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
      if (this.phase === 'splash' && !e.repeat) { this._beginCountdown(); return; }
      this.keys.add(e.key);
      this.mouseSteer = false;
      if ((e.key === ' ' || e.key === 'Spacebar') && !e.repeat) this._hop();
    }, true);

    this._on(window, 'keyup', (e) => {
      if (STEER.includes(e.key)) e.stopPropagation();
      this.keys.delete(e.key);
    }, true);

    this._on(this.wrap, 'pointermove', (e) => {
      const r = this.wrap.getBoundingClientRect();
      const t = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
      this.mouseX = t * (PLAY_HALF + 1.6);
      this.mouseSteer = true;
    });

    this._on(this.wrap, 'pointerdown', (e) => {
      if (e.target !== this.renderer.domElement) return;
      if (this.phase === 'splash') { this._beginCountdown(); return; }
      this._hop();
    });

    this._on(window, 'resize', () => this._resize());
  }

  _resize() {
    if (!this.renderer) return;
    const w = this.wrap.clientWidth || innerWidth;
    const h = this.wrap.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ run control -
  _resetWorld() {
    this.travel = 0;
    this.prevTravel = 0;
    this.dist = 0;
    this.speed = 5;
    this.runTime = 0;
    this.sledX = 0;
    this.sledVX = 0;
    this.airY = 0;
    this.airVY = 0;
    this.airTime = 0;
    this.hearts = 3;
    this.coins = 0;
    this.combo = 0;
    this.airBonus = 0;
    this.invuln = 0;
    this.boost = 0;
    this.shake = 0;
    this.tumble = 0;
    this.endT = 0;
    this.mouseSteer = false;
    this.mouseX = 0;
    this.fov = 56;
    this.smoothY = 0;
    this.props.length = 0;
    this.parts.length = 0;
    this.spawnS = 60;
    this.flagS = 40;
    this.sceneS = -10;

    for (let i = 0; i < SEG_COUNT; i++) {
      const seg = this.segs[i];
      seg.nearS = -SEG_LEN + i * SEG_LEN;
      this._reshapeSegment(seg);
    }
    this._spawnAhead();

    if (this.heartEls) this.heartEls.forEach((el) => el.classList.remove('gone'));
    this.rigRoot.rotation.set(0, 0, 0);
    this.rigRoot.visible = true;
    this._hudCache = {};
    this._refreshHud(true);
  }

  _beginCountdown() {
    if (this.phase !== 'splash') return;
    this.game.audio?.play?.('click');
    this._clearCard();
    this.phase = 'countdown';
    this.countT = 0;
    this.countStep = -1;
    this.spawnS = this.travel + 78; // hazards stream in as the flag drops
    this.hud.classList.add('on');
    this.tip.style.opacity = '1';
    this._done = false; // each replay reports its own run
  }

  _startRun() {
    this.phase = 'run';
    this.runTime = 0;
    this.dist = 0;
    this.game.audio?.play?.('whoosh');
  }

  _hop() {
    if (this.phase !== 'run' || this.airY > 0.02) return;
    this.airVY = 6.4;
    this.airY = 0.01;
    this.game.audio?.play?.('pop');
    this._burst(this.sledX, this.groundY, 0.4, 9, 0xffffff, 0.3, 3);
  }

  // ----------------------------------------------------------- prop spawning -
  _addProp(type, s, x, opts = {}) {
    const h = opts.h || 0;
    this.props.push({
      type,
      s,
      x,
      h,
      y: heightAt(x, s) + h,
      rot: opts.rot ?? Math.random() * Math.PI * 2,
      sc: opts.sc ?? 1,
      phase: Math.random() * 6.283,
      taken: false,
      deco: !!opts.deco,
    });
  }

  get difficulty() { return clamp(this.runTime / 78, 0, 1); }

  _spawnAhead() {
    const horizon = this.travel + VIEW_AHEAD;
    const d = this.difficulty;

    // The splash sits on a clean groomed run: scenery only, no hazards.
    while (this.phase !== 'splash' && this.spawnS < horizon) {
      this._spawnChunk(this.spawnS, d);
      this.spawnS += lerp(32, 17, d) * rand(0.85, 1.15);
    }
    while (this.flagS < horizon) {
      const key = ((this.flagS / 34) | 0) % 2 === 0 ? 'flagA' : 'flagB';
      this._addProp(key, this.flagS, -10.4, { rot: 0.35, deco: true });
      this._addProp(key, this.flagS, 10.4, { rot: Math.PI - 0.35, deco: true });
      this.flagS += 34;
    }
    while (this.sceneS < horizon) {
      const n = 2 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const x = side * rand(12.6, 26);
        this._addProp('pine', this.sceneS + rand(-2.2, 2.2), x, { sc: rand(0.95, 1.7), deco: true });
      }
      this.sceneS += 5.2;
    }
  }

  _spawnChunk(s, d) {
    const r = Math.random();
    if (r < 0.36 + d * 0.10) this._spawnObstacles(s, d);
    else if (r < 0.61) this._spawnCoins(s, d);
    else if (r < 0.78) this._spawnRamp(s);
    else if (r < 0.87) this._addProp('boost', s, pick([-7.5, -3.8, 0, 3.8, 7.5]));
    else { this._spawnObstacles(s, d * 0.5); this._spawnCoins(s + 14, d); }
  }

  _spawnObstacles(s, d) {
    const lanes = [-8.4, -4.2, 0, 4.2, 8.4];
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    const n = Math.min(3, 1 + ((Math.random() * (0.7 + d * 2.4)) | 0));
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      const type = roll < 0.42 ? 'pine' : roll < 0.75 ? 'rock' : 'bump';
      this._addProp(type, s + rand(-5, 5), clamp(lanes[i] + rand(-0.9, 0.9), -PLAY_HALF, PLAY_HALF), {
        sc: type === 'pine' ? rand(0.85, 1.15) : rand(0.85, 1.25),
      });
    }
  }

  _spawnCoins(s, d) {
    const style = Math.random();
    if (style < 0.4) {
      const x = clamp(rand(-7.5, 7.5), -PLAY_HALF, PLAY_HALF);
      for (let i = 0; i < 5; i++) this._addProp('coin', s + i * 3.4, x, { h: 1.0 });
    } else if (style < 0.78) {
      const x0 = rand(-6, 6);
      const amp = rand(3, 5.5) * (Math.random() < 0.5 ? -1 : 1);
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        this._addProp('coin', s + i * 3.2, clamp(x0 + Math.sin(t * Math.PI) * amp, -PLAY_HALF, PLAY_HALF), { h: 1.0 });
      }
    } else {
      const x = clamp(rand(-6, 6), -PLAY_HALF, PLAY_HALF);
      for (let i = 0; i < 4; i++) {
        for (let k = -1; k <= 1; k += 2) {
          this._addProp('coin', s + i * 3.4, clamp(x + k * 1.5, -PLAY_HALF, PLAY_HALF), { h: 1.0 });
        }
      }
    }
    if (d > 0.35 && Math.random() < 0.35) this._spawnObstacles(s + 22, d * 0.6);
  }

  _spawnRamp(s) {
    const x = clamp(rand(-6.5, 6.5), -PLAY_HALF, PLAY_HALF);
    this._addProp('ramp', s, x);
    // Coin arc traced along the launch parabola so a clean kicker pays out.
    for (let i = 0; i < 6; i++) {
      this._addProp('coin', s + 9 + i * 3.6, x, { h: 1.3 + Math.sin(((i + 0.7) / 6.8) * Math.PI) * 3.9 });
    }
  }

  // ------------------------------------------------------------- particles -
  _spawnParticle(x, y, z, vx, vy, vz, size, color, life, grav = 12) {
    if (this.parts.length >= 230) return;
    _col.setHex(color);
    this.parts.push({
      x, y, z, vx, vy, vz, size, life, max: life, grav,
      r: _col.r, g: _col.g, b: _col.b,
      rx: Math.random() * 6.28, ry: Math.random() * 6.28,
      sx: 1, sz: 1,
    });
  }

  _burst(x, y, z, n, color, size, spread, up = 4) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283;
      const r = Math.random() * spread;
      this._spawnParticle(
        x, y + 0.3, z,
        Math.cos(a) * r, up * rand(0.4, 1.3), Math.sin(a) * r + rand(1, 4),
        size * rand(0.7, 1.4), color, rand(0.4, 0.75),
      );
    }
  }

  _updateParticles(dt) {
    const list = this.parts;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt + this.speed * dt; // carried back by the scrolling world
      p.rx += dt * 4;
      p.ry += dt * 3;
      list[w++] = p;
    }
    list.length = w;

    const im = this.pfx;
    const colAttr = im.instanceColor;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const t = p.life / p.max;
      const s = p.size * (0.35 + t * 0.75);
      _e.set(p.rx, p.ry, 0);
      _q.setFromEuler(_e);
      _v2.set(p.x, p.y, p.z);
      _sc.set(s * p.sx, s, s * p.sz);
      _m4.compose(_v2, _q, _sc);
      im.setMatrixAt(i, _m4);
      colAttr.setXYZ(i, p.r, p.g, p.b);
    }
    im.count = list.length;
    im.instanceMatrix.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  // ------------------------------------------------------------- main loop -
  _tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._tick);
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    this.time += dt;

    this._step(dt);
    this.renderer.render(this.scene, this.camera);
  };

  _step(dt) {
    // ---- phase timing ----------------------------------------------------
    if (this.phase === 'countdown') {
      this.countT += dt;
      const step = Math.floor(this.countT / 0.9);
      if (step !== this.countStep && step <= 3) {
        this.countStep = step;
        if (step < 3) {
          this._countNumber(String(3 - step), false);
          this.game.audio?.play?.('ding');
        } else {
          this._countNumber('GO', true);
          this.game.audio?.play?.('success');
          this._startRun();
        }
      }
    } else if (this.phase === 'run') {
      this.runTime += dt;
      if (this.runTime > 6.5 && this.tip.style.opacity !== '0') this.tip.style.opacity = '0';
    } else if (this.phase === 'crash') {
      this.endT += dt;
      if (this.endT > 1.9) this._showResults();
    }

    // ---- speed -----------------------------------------------------------
    let target;
    if (this.phase === 'run') {
      const base = 18 + Math.min(this.runTime, 92) * 0.325;
      target = base * (this.boost > 0 ? BOOST_MUL : 1);
    } else if (this.phase === 'crash') {
      target = 0;
    } else if (this.phase === 'results') {
      target = 3;
    } else {
      target = 5.5;
    }
    this.speed = lerp(this.speed, target, Math.min(1, dt * (this.phase === 'crash' ? 2.4 : 3.2)));
    if (this.boost > 0) this.boost -= dt;

    this.prevTravel = this.travel;
    this.travel += this.speed * dt;
    if (this.phase === 'run') this.dist += this.speed * dt;

    // ---- steering --------------------------------------------------------
    if (this.phase === 'run') {
      const k = this.keys;
      const left = k.has('a') || k.has('A') || k.has('ArrowLeft');
      const right = k.has('d') || k.has('D') || k.has('ArrowRight');
      let want = 0;
      if (this.mouseSteer && !left && !right) {
        want = clamp((this.mouseX - this.sledX) * 4.2, -STEER_MAX, STEER_MAX);
      } else {
        want = (right ? 1 : 0) - (left ? 1 : 0);
        want *= STEER_MAX;
      }
      if (this.airY > 0.02) want *= 0.55;
      this.sledVX = lerp(this.sledVX, want, Math.min(1, dt * 8));
    } else {
      this.sledVX = lerp(this.sledVX, 0, Math.min(1, dt * 3));
    }
    this.sledX = clamp(this.sledX + this.sledVX * dt, -CLAMP_X, CLAMP_X);
    if (Math.abs(this.sledX) >= CLAMP_X - 0.01) this.sledVX *= 0.4;

    // ---- terrain + air ---------------------------------------------------
    this.groundY = heightAt(this.sledX, this.travel);
    if (this.airY > 0) {
      this.airVY -= GRAVITY * dt;
      this.airY += this.airVY * dt;
      this.airTime += dt;
      if (this.airY <= 0) this._land();
    }

    if (this.phase === 'run') this._collide();
    this._spawnAhead();
    this._recycleGround();
    this._layoutProps();
    this._emitSpray(dt);
    this._updateParticles(dt);
    this._animateRig(dt);
    this._updateCamera(dt);
    this._updateSnowfall(dt);
    this._refreshHud(false);

    if (this.invuln > 0) {
      this.invuln -= dt;
      this.rigRoot.visible = this.invuln <= 0 || Math.floor(this.time * 18) % 2 === 0;
    }
  }

  _land() {
    this.airY = 0;
    this.airVY = 0;
    if (this.phase === 'run' && this.airTime > 0.28) {
      const bonus = Math.floor(this.airTime * 45);
      this.airBonus += bonus;
      this._popup(`AIR +${bonus}`, 'air');
      this.game.audio?.play?.(this.airTime > 0.85 ? 'ding' : 'pop');
      this.shake = Math.min(0.5, this.airTime * 0.35);
    }
    this.airTime = 0;
    this._burst(this.sledX, this.groundY, 0.2, 12, 0xffffff, 0.32, 4, 3);
  }

  // ------------------------------------------------------------- collisions -
  _collide() {
    const props = this.props;
    const t = this.travel;
    const pt = this.prevTravel;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (p.taken || p.deco) continue;
      if (p.s > t + 4 || p.s < pt - 4) continue;
      const dx = Math.abs(p.x - this.sledX);

      if (p.type === 'coin') {
        if (dx < 1.5 && p.s <= t + 1.4 && p.s >= pt - 1.4 && Math.abs(this.airY + 0.95 - p.h) < 2.0) {
          p.taken = true;
          this.coins++;
          this.combo++;
          this.game.audio?.play?.('coin');
          this._burst(p.x, p.y, this.travel - p.s, 7, 0xffd77a, 0.22, 2.4, 3);
          this.f.coinbox.classList.remove('bump');
          void this.f.coinbox.offsetWidth;
          this.f.coinbox.classList.add('bump');
          if (this.combo > 0 && this.combo % 10 === 0) this._popup(`${this.combo} in a row!`, 'gold');
        }
        continue;
      }

      if (p.type === 'boost') {
        if (dx < 1.7 && p.s <= t + 1.6 && p.s >= pt - 1.6 && this.airY < 1.9) {
          p.taken = true;
          this.boost = BOOST_TIME;
          this.game.audio?.play?.('whoosh');
          this._popup('BOOST!', 'air');
          this._flash('boost');
          for (let n = 0; n < 18; n++) {
            this._spawnParticle(
              this.sledX + rand(-1.4, 1.4), this.groundY + rand(0.3, 2.2), rand(-2, 1),
              rand(-1, 1), rand(0, 2), rand(14, 26), 0.3, 0x9ff0ff, rand(0.3, 0.6), 0,
            );
          }
        }
        continue;
      }

      if (p.type === 'ramp') {
        if (!p.used && dx < 2.3 && p.s <= t + 1.2 && p.s >= pt - 1.2 && this.airY < 0.4) {
          p.used = true;
          this.airVY = 9.2 + this.speed * 0.14;
          this.airY = 0.05;
          this.airTime = 0;
          this.game.audio?.play?.('pop');
          this._popup('LAUNCH', 'air');
          this._burst(this.sledX, this.groundY + 1, 0, 14, 0xffffff, 0.3, 3.5, 6);
        }
        continue;
      }

      const hit = HIT[p.type];
      if (!hit) continue;
      if (this.invuln > 0) continue;
      const rz = hit.r * p.sc * 0.9 + 0.7;
      if (dx < hit.r * p.sc + 0.62 && p.s <= t + rz && p.s >= pt - rz && this.airY < hit.clear * p.sc) {
        this._takeHit(p);
      }
    }
  }

  _takeHit(p) {
    p.taken = true;
    this.hearts--;
    this.combo = 0;
    this.invuln = INVULN;
    this.shake = 1;
    this.speed *= 0.55;
    this.sledVX *= -0.35;
    this.game.audio?.play?.('fail');
    this._flash('hit');
    this._burst(p.x, p.y + 0.4, this.travel - p.s, 20, p.type === 'pine' ? 0xdfeadf : 0xdfe6ef, 0.36, 5, 6);
    if (this.heartEls[this.hearts]) this.heartEls[this.hearts].classList.add('gone');
    if (this.hearts <= 0) {
      this.phase = 'crash';
      this.endT = 0;
      this.tumble = 0;
      this.hud.classList.remove('on');
      this.tip.style.opacity = '0';
      this.airVY = 7;
      this.airY = 0.1;
    } else {
      this._popup(`${this.hearts} left`, 'bad');
    }
  }

  _flash(kind) {
    this.flash.className = 'mg-sled-flash';
    void this.flash.offsetWidth;
    this.flash.className = `mg-sled-flash ${kind}`;
  }

  // ------------------------------------------------------------ world scroll -
  _recycleGround() {
    for (const seg of this.segs) {
      let z = this.travel - seg.nearS;
      if (z > SEG_LEN + 18) {
        seg.nearS += SEG_LEN * SEG_COUNT;
        this._reshapeSegment(seg);
        z = this.travel - seg.nearS;
      }
      seg.mesh.position.z = z;
    }
  }

  _layoutProps() {
    for (const k in this.imCount) this.imCount[k] = 0;
    const props = this.props;
    const t = this.travel;
    let w = 0;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      const z = t - p.s;
      if (z > 24) continue;         // behind the camera: retire it
      props[w++] = p;
      if (p.taken || z < -VIEW_AHEAD - 20) continue;
      const im = this.im[p.type];
      if (!im) continue;
      const idx = this.imCount[p.type];
      if (idx >= im.userData.cap) continue;

      let y = p.y;
      let rotY = p.rot;
      let sc = p.sc;
      if (p.type === 'coin') {
        rotY = this.time * 3.4 + p.phase;
        y = p.y + Math.sin(this.time * 2.4 + p.phase) * 0.09;
      } else if (p.type === 'boost') {
        rotY = this.time * 1.9 + p.phase;
        y = p.y + Math.sin(this.time * 2.8 + p.phase) * 0.14;
        sc = p.sc * (1 + Math.sin(this.time * 6 + p.phase) * 0.05);
      } else if (p.type === 'flagA' || p.type === 'flagB') {
        rotY = p.rot + Math.sin(this.time * 5 + p.phase) * 0.28;
      }

      _e.set(0, rotY, 0);
      _q.setFromEuler(_e);
      _v2.set(p.x, y, z);
      _sc.set(sc, sc, sc);
      _m4.compose(_v2, _q, _sc);
      im.setMatrixAt(idx, _m4);
      this.imCount[p.type] = idx + 1;
    }
    props.length = w;
    for (const k in this.im) {
      const im = this.im[k];
      im.count = this.imCount[k];
      im.instanceMatrix.needsUpdate = true;
    }
  }

  _emitSpray(dt) {
    if (this.phase === 'splash' && this.speed < 3) return;
    if (this.airY > 0.15 && this.phase !== 'crash') return;
    const rate = this.phase === 'crash' ? 26 : clamp(this.speed * 0.55, 0, 30);
    this._sprayAcc = (this._sprayAcc || 0) + rate * dt;
    const boosting = this.boost > 0;
    while (this._sprayAcc >= 1) {
      this._sprayAcc -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      this._spawnParticle(
        this.sledX + side * 0.44 + rand(-0.1, 0.1),
        this.groundY + 0.08,
        0.55 + rand(-0.2, 0.2),
        -this.sledVX * 0.16 + side * rand(0.4, 1.8),
        rand(1.8, 4.6),
        rand(2.5, 6.5),
        rand(0.16, 0.34),
        boosting ? 0xcdf3ff : 0xffffff,
        rand(0.35, 0.62),
        10,
      );
    }
  }

  // ----------------------------------------------------------- rig + camera -
  _animateRig(dt) {
    const g = this.rigRoot;
    const y = this.groundY + this.airY;
    g.position.set(this.sledX, y, 0);

    const lean = clamp(this.sledVX / STEER_MAX, -1, 1);
    const ahead = heightAt(this.sledX, this.travel + 2.5);
    const behind = heightAt(this.sledX, this.travel - 2.5);
    const slope = (ahead - behind) / 5;

    if (this.phase === 'crash') {
      this.tumble += dt;
      g.rotation.x += dt * 7.5;
      g.rotation.z += dt * 4.2;
      g.rotation.y += dt * 2.1;
      g.position.y = y + Math.max(0, Math.sin(this.tumble * 3.4)) * 0.9;
      if (Math.random() < 0.4) {
        this._burst(this.sledX + rand(-0.6, 0.6), this.groundY, rand(-0.5, 0.8), 3, 0xffffff, 0.3, 3, 4);
      }
    } else {
      g.rotation.z = lerp(g.rotation.z, -lean * 0.55, Math.min(1, dt * 9));
      g.rotation.y = lerp(g.rotation.y, -lean * 0.22, Math.min(1, dt * 7));
      g.rotation.x = lerp(g.rotation.x, slope * 0.9 + clamp(this.airVY, -9, 9) * 0.035, Math.min(1, dt * 8));
    }

    // rider: crouch with speed, lean into the turn, ears and scarf in the wind
    const r = this.rig;
    const spd = clamp(this.speed / 55, 0, 1);
    const buzz = Math.sin(this.time * 22) * 0.012 * (0.3 + spd);
    r.bob.position.y = buzz + (this.airY > 0.05 ? 0.05 : 0);
    r.bob.rotation.z = lean * 0.42;
    r.bob.rotation.x = -0.12 * spd + (this.airY > 0.05 ? -0.12 : 0);
    r.head.rotation.y = lean * 0.4;
    r.head.rotation.z = -lean * 0.18;
    r.head.rotation.x = clamp(-this.airVY * 0.02, -0.25, 0.25);
    for (const a of r.arms) {
      a.rotation.x = -0.1 + (this.airY > 0.05 ? -0.7 : 0) + buzz * 6;
      a.rotation.z = lean * 0.25;
    }
    for (let i = 0; i < r.ears.length; i++) {
      r.ears[i].rotation.z = Math.sin(this.time * 17 + i) * 0.12 * (0.4 + spd) - lean * 0.2;
    }
    const flap = 0.55 + spd * 0.7;
    for (const t of r.tails) {
      t.root.rotation.x = -0.35 - flap * 0.5 + Math.sin(this.time * 13 + t.side) * 0.18;
      t.root.rotation.y = lean * 0.9 + Math.sin(this.time * 9 + t.side * 2) * 0.22;
      t.tip.rotation.x = Math.sin(this.time * 15 + t.side * 3) * 0.35;
      t.tip.rotation.y = Math.sin(this.time * 11 + t.side) * 0.3;
    }

    // blob shadow
    this.shadow.position.set(this.sledX, this.groundY + 0.06, 0);
    const s = clamp(1 - this.airY * 0.11, 0.42, 1);
    this.shadow.scale.setScalar(s);
    this.shadow.material.opacity = 0.26 * s;
    this.shadow.visible = this.phase !== 'crash';
  }

  _updateCamera(dt) {
    const cam = this.camera;
    this.smoothY = lerp(this.smoothY, this.groundY, Math.min(1, dt * 2.6));
    const followY = this.smoothY + 4.5 + this.airY * 0.55;
    const back = 9.2 + clamp(this.speed * 0.045, 0, 1.4);
    cam.position.x = lerp(cam.position.x, this.sledX * 0.62, Math.min(1, dt * 5));
    cam.position.y = lerp(cam.position.y, followY, Math.min(1, dt * 5.5));
    cam.position.z = lerp(cam.position.z, back, Math.min(1, dt * 4));
    cam.lookAt(this.sledX * 0.74, this.smoothY + 1.5 + this.airY * 0.6, -12);

    if (this.shake > 0.001) {
      this.shake *= Math.exp(-dt * 5.5);
      const k = this.shake;
      cam.position.x += rand(-1, 1) * k * 0.55;
      cam.position.y += rand(-1, 1) * k * 0.45;
      cam.rotation.z += rand(-1, 1) * k * 0.05;
    }

    const wantFov = 56 + clamp((this.speed - 18) * 0.42, 0, 12) + (this.boost > 0 ? 7 : 0);
    this.fov = lerp(this.fov, wantFov, Math.min(1, dt * 3.5));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    this.sky.position.copy(cam.position);
    this.mountains.position.set(this.sledX * 0.12, this.smoothY * 0.5, 0);
  }

  _updateSnowfall(dt) {
    const pos = this.snowfall.geometry.attributes.position;
    const arr = pos.array;
    const drift = Math.sin(this.time * 0.4) * 1.2;
    const zPush = this.speed * dt * 0.85;
    for (let i = 0; i < this.flakeSpeed.length; i++) {
      const k = i * 3;
      arr[k] += (drift - this.sledVX * 0.05) * dt;
      arr[k + 1] -= this.flakeSpeed[i] * dt;
      arr[k + 2] += zPush;
      if (arr[k + 1] < this.groundY - 4) { arr[k + 1] = this.groundY + 24; arr[k + 2] -= 30; }
      if (arr[k + 2] > 14) { arr[k + 2] -= 82; arr[k] = this.sledX + rand(-34, 34); }
      if (Math.abs(arr[k] - this.sledX) > 40) arr[k] = this.sledX + rand(-34, 34);
    }
    pos.needsUpdate = true;
    this.snowfall.position.y = 0;
  }

  // ------------------------------------------------------------------- hud -
  _refreshHud(force) {
    const c = this._hudCache || (this._hudCache = {});
    const m = Math.floor(this.dist * DIST_SCALE);
    if (force || m !== c.m) { c.m = m; this.f.dist.textContent = m.toLocaleString(); }
    const kmh = Math.round(this.speed * 3);
    if (force || kmh !== c.kmh) { c.kmh = kmh; this.f.spd.textContent = kmh; }
    const bar = Math.round(clamp((this.speed - 14) / 42, 0, 1) * 100);
    if (force || bar !== c.bar) { c.bar = bar; this.f.bar.style.width = `${bar}%`; }
    if (force || this.coins !== c.coins) { c.coins = this.coins; this.f.coins.textContent = this.coins; }
    const vg = clamp((this.speed - 24) / 40, 0, 1) * 0.85 + (this.boost > 0 ? 0.15 : 0);
    if (force || Math.abs(vg - (c.vg ?? -1)) > 0.03) { c.vg = vg; this.vig.style.opacity = vg.toFixed(2); }
  }

  // --------------------------------------------------------------- results -
  _showResults() {
    if (this.phase === 'results') return;
    this.phase = 'results';
    this.hud.classList.remove('on');
    this.quitBtn.style.display = 'none';

    const metres = Math.floor(this.dist * DIST_SCALE);
    const coinPts = this.coins * 10;
    const score = metres + coinPts + this.airBonus;
    const prevBest = this.game.state.bests?.sled || 0;
    const isBest = score > prevBest;
    const payout = Math.min(this.coinsForScore(score), MINIGAMES.sled.maxCoinsPerRun);

    this.finish(score);
    this.game.audio?.play?.(isBest ? 'success' : 'ding');

    const title = score > 2200 ? 'Powder legend'
      : score > 1400 ? 'Clean lines'
        : score > 700 ? 'Nice carve'
          : 'Bunny slope';

    const card = document.createElement('div');
    card.className = 'mg-sled-card';
    card.innerHTML = `
      <div class="mg-sled-box">
        <div class="mg-sled-title">${title}</div>
        <div class="mg-sled-sub">You wiped out at the bottom of the run</div>
        <div class="mg-sled-rows">
          <div class="mg-sled-row"><span>Distance</span><b>${metres.toLocaleString()} m</b></div>
          <div class="mg-sled-row"><span>Snowcoins &times; 10</span><b>${this.coins} &rarr; ${coinPts}</b></div>
          <div class="mg-sled-row"><span>Air time bonus</span><b>${this.airBonus}</b></div>
          <div class="mg-sled-row total"><span>Score</span><b>${score.toLocaleString()}</b></div>
          <div class="mg-sled-row pay"><span>Coins earned</span><b>+${payout}</b></div>
        </div>
        <div class="mg-sled-best">Best run: <b>${Math.max(prevBest, score).toLocaleString()}</b>${
  isBest ? '<span class="mg-sled-tag">NEW BEST</span>' : ''}</div>
        <div class="mg-sled-btns">
          <button class="mg-sled-btn" data-a="again">Play again</button>
          <button class="mg-sled-btn alt" data-a="back">Back to the peak</button>
        </div>
      </div>`;
    this.cardHost.appendChild(card);
    this.card = card;
    card.querySelector('[data-a="again"]').onclick = () => {
      this.game.audio?.play?.('click');
      this._clearCard();
      this.phase = 'splash';
      this.quitBtn.style.display = '';
      this._resetWorld();
      this._beginCountdown();
    };
    card.querySelector('[data-a="back"]').onclick = () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    };
  }

  // --------------------------------------------------------------- teardown -
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const [target, type, fn, opts] of this.listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this.listeners.length = 0;
    this.keys.clear();

    if (this.scene) {
      disposeObject(this.scene);
      this.scene.background = null;
      this.scene.clear();
      this.scene = null;
    }
    for (const g of this.geos) g.dispose?.();
    this.geos.length = 0;
    for (const seg of this.segs || []) seg.geo.dispose();
    this.segs = null;
    this.props.length = 0;
    this.parts.length = 0;

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss?.();
      this.renderer.domElement?.remove();
      this.renderer = null;
    }
    this.styleEl?.remove();
    this.wrap?.remove();
    this.im = null;
    this.pfx = null;
    this.rig = null;
  }
}
