import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';
// The mural overlay publishes the grid size, the palette and the decoder for
// exactly this reason: the in-world wall must paint the SAME pixels the overlay
// paints, and an index is the wire contract, so a second copy of the palette
// here would be a silent recolouring bug the first time either side changed.
// (openMural comes in on the same static import: the module is already in this
// chunk because of the four helpers above, so a dynamic import of it bought
// nothing and only made the bundler warn about the double edge.)
import {
  MURAL_W, MURAL_H, MURAL_PALETTE, decodeMuralGrid, muralImageData, openMural,
} from '../../ui/mural.js';

/**
 * Sunny Plaza: the central hub of Capy Cove.
 * A cobbled plaza on a grassy island, wishing fountain just north of centre,
 * hat shop to the east, four gates out to the rest of the cove.
 */

// ----------------------------------------------------------------- palette --
const C = {
  grass: 0x8ec95c,
  grassDark: 0x6fae46,
  sand: 0xe8d3a0,
  rock: 0xc6b795,
  stone: 0xded2ba,
  stoneDark: 0xab9c81,
  wood: 0xb07a4a,
  woodDark: 0x7d5230,
  iron: 0x4d5f57,
  cream: 0xfff1da,
  coral: 0xe8657a,
  gold: 0xf2b64a,
  sky: 0x4fb3e8,
  leaf: 0x7ac74f,
  leafDark: 0x59a336,
  water: 0x66c9f0,
  seaFar: 0x3aa6dd,
  cloud: 0xfdfdff,
  hillA: 0x83c268,
  hillB: 0x6bab6f,
  hillC: 0x93bcb0,
  lampGlow: 0xffe6a3,
  clubGlow: 0xc86bff,
  hatFelt: 0x4d3b52,
};

const SKY = 0x9ed9f4;
const FOG = 0xc4e6f8;

const ISLAND_R = 18.0;   // walkable grass disc
const PLAZA_R = 9.2;     // cobbled disc
const FX = 0, FZ = -3;   // fountain centre
const ZONE = BOT_ZONES.plaza;

// ground layer heights, spaced to avoid any z-fighting
const Y_PLAZA = 0.03, Y_INLAY = 0.05, Y_APRON = 0.07, Y_PATH = 0.09;

const NOTICES = [
  'Fishing derby at Driftwood Beach — every afternoon!',
  'Sled races down Frosty Peak. Helmets optional, dignity not.',
  'Smoothie of the week: Kelpberry Crush. Free refill on Tuesdays.',
  'FOUND: one propeller cap, still spinning. Ask at the hat shop.',
  'Please do not nibble the topiary. He is a friend, not a snack.',
  'Lost sock in the fountain. Third one this week. Be better, cove.',
];

// ---------------------------------------------------------- world clock ----
// docs/LIVING-COVE.md section A. One cove day = 40 real minutes; `dayT` is a
// continuous phase in [0,1) with 0 dawn / 0.25 noon / 0.5 dusk / 0.75 midnight.
// The server owns it and broadcasts every 10s; onClock() takes the frame and
// update() interpolates between frames so the sky never steps. Every colour
// below is preallocated and lerped in place: the clock adds zero per-frame
// allocations and no new shadow casters (the one directional light doubles as
// sun by day and moon by night).
const DAY_SECONDS = 40 * 60;
const TAU = Math.PI * 2;

/** 4-stop sky/light LUT, indexed by quarter-day: dawn, noon, dusk, night.
 *  Stop 1 (noon) reproduces the room's shipped daylight look exactly. */
const SKY_LUT = [
  { // 0.00 dawn: peach haze, long warm light
    sky: new THREE.Color(0xf7c69c), fog: new THREE.Color(0xf6d9c2),
    sun: new THREE.Color(0xffcf96), sunI: 1.05,
    hemiSky: new THREE.Color(0xffe3c4), hemiGnd: new THREE.Color(0x9a9a72), hemiI: 0.86,
    ambI: 0.24,
  },
  { // 0.25 noon: the shipped look (SKY / FOG / the original sun + fills)
    sky: new THREE.Color(SKY), fog: new THREE.Color(FOG),
    sun: new THREE.Color(0xfff3d2), sunI: 1.55,
    hemiSky: new THREE.Color(0xfff6e2), hemiGnd: new THREE.Color(0x8fae6a), hemiI: 1.0,
    ambI: 0.2,
  },
  { // 0.50 dusk: coral sky, the hour the lamps come on
    sky: new THREE.Color(0xef9a72), fog: new THREE.Color(0xe8a98f),
    sun: new THREE.Color(0xff9a58), sunI: 0.95,
    hemiSky: new THREE.Color(0xffc2a0), hemiGnd: new THREE.Color(0x6f6a55), hemiI: 0.7,
    ambI: 0.26,
  },
  { // 0.75 midnight: deep blue, moonlit. Fills never drop below the ~0.45
    // playability floor called out in LIVING-COVE.md.
    sky: new THREE.Color(0x1b2747), fog: new THREE.Color(0x2a3a63),
    sun: new THREE.Color(0xa8c0f0), sunI: 0.42,
    hemiSky: new THREE.Color(0x4b5f92), hemiGnd: new THREE.Color(0x2c3a38), hemiI: 0.5,
    ambI: 0.3,
  },
];

const RAIN_TINT = new THREE.Color(0x93a3b0);
const LAMP_DAY = new THREE.Color(0xefe6cd);   // cold glass in daylight
const LAMP_NIGHT = new THREE.Color(0xffeeb0); // lit filament after dusk
const BEAD_DAY = new THREE.Color(0x7d5f42);   // unlit bulbs read as wooden beads
const BEAD_NIGHT = new THREE.Color(0xffdf9a);
const WIN_DAY = new THREE.Color(0x9fdcf5);    // shop glass reflecting the sky
const WIN_NIGHT = new THREE.Color(0xffcd7e);  // a warm room behind it
const DOOR_DAY = new THREE.Color(0xffdca8);
const DOOR_NIGHT = new THREE.Color(0xffe9bd);

// scratch colours: reused every frame, never allocated inside update()
const _cA = new THREE.Color();
const _cB = new THREE.Color();

const sm = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Lamps/bunting/windows glow level for a phase: on dusk-to-dawn, eased. */
function nightMix(u) {
  if (u < 0.07) return 1 - sm(u / 0.07);        // fading out through sunrise
  if (u < 0.40) return 0;
  if (u < 0.52) return sm((u - 0.40) / 0.12);   // coming on through sunset
  return 1;
}

// ------------------------------------------------------------ the mural ----
// docs/LIVING-COVE.md section A4: a 96x54 collaborative pixel canvas on a
// framed wall beside the quest board. The overlay (src/ui/mural.js) owns
// painting and the palette; this wall is the always-on public view of the same
// grid, so it listens to the same frames and never keeps its own copy of the
// contract data. Wire shapes (server/index.js): out {t:'mural-grid'} asks for
// the wall, in {t:'mural-grid', rle} answers, in {t:'mural', x, y, c} is one
// placed pixel broadcast to everyone. Refusals ride the same 'mural' name with
// {ok:false, wait} and NO cell, which is why _muralPaint insists on numbers.
// The A4 "report mural" affordance lives in the overlay (out {t:'mural-report'})
// rather than as a second world hotspot on the board.

// ------------------------------------------------------------------ utils --
const _o = new THREE.Object3D();
const _o2 = new THREE.Object3D();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Matrix from position / euler / scale. `r` may be null, `s` a number or [x,y,z]. */
function T(p, r, s) {
  _o.position.set(p[0], p[1], p[2]);
  if (r) _o.rotation.set(r[0], r[1], r[2]);
  else _o.rotation.set(0, 0, 0);
  if (Array.isArray(s)) _o.scale.set(s[0], s[1], s[2]);
  else _o.scale.setScalar(s === undefined ? 1 : s);
  _o.updateMatrix();
  return _o.matrix.clone();
}

function inst(parent, geo, mat, mats, cast = true, recv = false) {
  if (!mats || !mats.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = cast;
  im.receiveShadow = recv;
  parent.add(im);
  return im;
}

function put(parent, geo, mat, x, y, z, opt = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (opt.rot) m.rotation.set(opt.rot[0], opt.rot[1], opt.rot[2]);
  if (opt.scale !== undefined) {
    if (Array.isArray(opt.scale)) m.scale.set(opt.scale[0], opt.scale[1], opt.scale[2]);
    else m.scale.setScalar(opt.scale);
  }
  m.castShadow = opt.cast !== false;
  m.receiveShadow = !!opt.recv;
  parent.add(m);
  return m;
}

/** Unique material carrying a canvas map (never attach maps to cached mats). */
function toonMap(color, tex, opts = {}) {
  const m = makeToon(color, { unique: true, ...opts });
  m.map = tex;
  return m;
}
function glowMap(tex) {
  const m = makeGlow(0xffffff, { unique: true });
  m.map = tex;
  return m;
}
function glowFade(color, opacity) {
  const m = makeGlow(color, { unique: true });
  m.transparent = true;
  m.opacity = opacity;
  m.depthWrite = false;
  return m;
}
/** Additive variant for light pools: adds nothing at opacity 0, so a lamp that
 *  has not come on yet costs a blend and no visible quad. */
function glowAdd(color, opacity) {
  const m = glowFade(color, opacity);
  m.blending = THREE.AdditiveBlending;
  return m;
}

// --------------------------------------------------------- canvas helpers --
const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitFont(ctx, text, maxW, start, weight = 'bold') {
  let s = start;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > 10 && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
}

function woodSignTex(title, sub, bg = '#f3e2bc', fg = '#5b3a1e', edge = '#c08b4e') {
  const w = 512, h = 224;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = bg;
    rrect(ctx, 8, 8, w - 16, h - 16, 28);
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(90,55,20,0.07)';
    ctx.lineWidth = 4;
    for (let i = 0; i < 7; i++) {
      const y = 30 + i * 26;
      ctx.beginPath();
      ctx.moveTo(20, y);
      ctx.bezierCurveTo(w * 0.35, y - 7, w * 0.65, y + 7, w - 20, y);
      ctx.stroke();
    }
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, title, w - 76, sub ? 66 : 84);
    ctx.fillText(title, w / 2, sub ? h * 0.42 : h * 0.5);
    if (sub) {
      fitFont(ctx, sub, w - 96, 34, 'normal');
      ctx.globalAlpha = 0.72;
      ctx.fillText(sub, w / 2, h * 0.73);
      ctx.globalAlpha = 1;
    }
  });
}

function cobbleTex(rand) {
  const S = 256;
  const cols = ['#f0e4c8', '#e7d7b4', '#dcc9a3', '#f5ecd6', '#e2d3ae'];
  const stones = [];
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      stones.push({
        x: gx * 32 + (gy % 2) * 16 + (rand() - 0.5) * 5,
        y: gy * 32 + (rand() - 0.5) * 5,
        w: 26 + rand() * 4,
        h: 26 + rand() * 4,
        c: cols[(rand() * cols.length) | 0],
      });
    }
  }
  const wrap = [[0, 0], [-S, 0], [0, -S], [-S, -S]];
  return canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#bda884';
    ctx.fillRect(0, 0, S, S);
    for (const off of wrap) {
      for (const s of stones) {
        ctx.fillStyle = s.c;
        rrect(ctx, s.x + off[0] + 3, s.y + off[1] + 3, s.w, s.h, 9);
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    for (const off of wrap) {
      for (let i = 0; i < stones.length; i += 3) {
        const s = stones[i];
        rrect(ctx, s.x + off[0] + 6, s.y + off[1] + 6, s.w * 0.52, s.h * 0.4, 7);
        ctx.fill();
      }
    }
  });
}

function rippleTex(rand) {
  const S = 128;
  const rings = [];
  for (let i = 0; i < 12; i++) rings.push([rand() * S, rand() * S, 6 + rand() * 20]);
  const wrap = [[0, 0], [-S, 0], [0, -S], [-S, -S], [S, 0], [0, S]];
  return canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#7fd4f2';
    ctx.fillRect(0, 0, S, S);
    ctx.lineWidth = 3;
    for (const off of wrap) {
      for (const r of rings) {
        ctx.strokeStyle = 'rgba(255,255,255,0.34)';
        ctx.beginPath();
        ctx.arc(r[0] + off[0], r[1] + off[1], r[2], 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(40,150,205,0.22)';
        ctx.beginPath();
        ctx.arc(r[0] + off[0], r[1] + off[1], r[2] * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  });
}

function stripeTex() {
  const S = 128;
  return canvasTexture(S, S, (ctx) => {
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#e8657a' : '#fff3e0';
      ctx.fillRect(0, i * 16, S, 16);
    }
  });
}

/** Soft radial falloff for the lamp light pools. A hard-edged additive disc
 *  reads as a sticker on the cobbles and cuts a visible arc through anything it
 *  overlaps (planter rims, bench legs); a fade reads as spill from the lamp. */
function poolTex() {
  const S = 64;
  return canvasTexture(S, S, (ctx) => {
    const grad = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.42, 'rgba(255,255,255,0.66)');
    grad.addColorStop(0.76, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
  });
}

/** Poster for the shop's south wall: the side you actually walk past. */
function shopPosterTex() {
  const w = 256, h = 320;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = '#fff3e0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#e8657a';
    ctx.lineWidth = 12;
    ctx.strokeRect(11, 11, w - 22, h - 22);
    ctx.fillStyle = '#4d3b52';           // top hat
    ctx.fillRect(90, 66, 76, 70);
    ctx.fillRect(58, 128, 140, 18);
    ctx.fillStyle = '#f2b64a';
    ctx.fillRect(90, 110, 76, 18);
    ctx.fillStyle = '#e8657a';           // party cone
    ctx.beginPath();
    ctx.moveTo(128, 168);
    ctx.lineTo(98, 226);
    ctx.lineTo(158, 226);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4fb3e8';
    ctx.beginPath();
    ctx.arc(128, 168, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5b3a1e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, 'NEW HATS', w - 54, 42);
    ctx.fillText('NEW HATS', w / 2, 262);
    ctx.fillStyle = '#8a5c2c';
    fitFont(ctx, 'try one on inside', w - 60, 24, 'normal');
    ctx.fillText('try one on inside', w / 2, 294);
  });
}

// The old cove notice board, redressed as the Quest Board (LIVING-COVE.md D).
// The pinned notes keep their flavour; two of them gained tick boxes so the
// board reads as "there are things to do here" from across the plaza.
function questBoardTex() {
  const w = 512, h = 384;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = '#d9b98a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(120,80,40,0.10)';
    for (let i = 0; i < 300; i++) ctx.fillRect((i * 97) % w, (i * 151) % h, 3, 3);
    ctx.fillStyle = '#5b3a1e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, 'QUEST BOARD', w - 60, 54);
    ctx.fillText('QUEST BOARD', w / 2, 40);
    ctx.fillStyle = '#8a5c2c';
    fitFont(ctx, 'three fresh every dawn', w - 120, 22, 'normal');
    ctx.fillText('three fresh every dawn', w / 2, 72);
    ctx.strokeStyle = '#8a5c2c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(60, 90);
    ctx.lineTo(w - 60, 90);
    ctx.stroke();

    const notes = [
      ['#fffbe8', -0.03, 'Fishing derby', 'Driftwood Beach, all day', true],
      ['#eaf6ff', 0.04, 'Sled races', 'Frosty Peak, hourly', true],
      ['#ffeef2', -0.02, 'Kelpberry Crush', 'smoothie of the week', false],
      ['#f2ffe8', 0.03, 'Paint the mural', 'right next door', true],
    ];
    notes.forEach((n, i) => {
      ctx.save();
      ctx.translate(140 + (i % 2) * 232, 175 + ((i / 2) | 0) * 128);
      ctx.rotate(n[1]);
      ctx.fillStyle = 'rgba(60,40,20,0.18)';
      rrect(ctx, -96, -50, 196, 104, 6);
      ctx.fill();
      ctx.fillStyle = n[0];
      rrect(ctx, -100, -54, 196, 104, 6);
      ctx.fill();
      ctx.fillStyle = '#4a2f16';
      fitFont(ctx, n[2], 150, 30);
      ctx.fillText(n[2], 8, -18);
      ctx.fillStyle = '#7a5836';
      fitFont(ctx, n[3], 176, 21, 'normal');
      ctx.fillText(n[3], -2, 18);
      if (n[4]) {
        ctx.strokeStyle = '#7a5836';
        ctx.lineWidth = 3;
        rrect(ctx, -84, -32, 26, 26, 5);
        ctx.stroke();
        ctx.strokeStyle = '#7ac74f';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(-79, -20);
        ctx.lineTo(-72, -12);
        ctx.lineTo(-60, -30);
        ctx.stroke();
      }
      ctx.fillStyle = '#e8657a';
      ctx.beginPath();
      ctx.arc(-2, -44, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  });
}

function neonTex(text) {
  const w = 512, h = 192;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = '#1d0f2c';
    rrect(ctx, 6, 6, w - 12, h - 12, 24);
    ctx.fill();
    ctx.strokeStyle = '#c86bff';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, text, w - 70, 76);
    ctx.shadowColor = '#e79bff';
    ctx.shadowBlur = 26;
    ctx.fillStyle = '#ffe6ff';
    ctx.fillText(text, w / 2, h * 0.44);
    ctx.fillText(text, w / 2, h * 0.44);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#f2b64a';
    fitFont(ctx, 'dance floor below', w - 140, 26, 'normal');
    ctx.fillText('dance floor below', w / 2, h * 0.8);
  });
}

function hatSignTex() {
  const S = 256;
  return canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#fff3e0';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 118, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 11;
    ctx.strokeStyle = '#e8657a';
    ctx.stroke();
    ctx.fillStyle = '#4d3b52';
    ctx.fillRect(96, 66, 64, 66);
    ctx.fillRect(66, 124, 124, 18);
    ctx.fillStyle = '#f2b64a';
    ctx.fillRect(96, 108, 64, 18);
    ctx.fillStyle = '#5b3a1e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, 'HATS', 150, 48);
    ctx.fillText('HATS', S / 2, 186);
  });
}

// ------------------------------------------------------------- capybara ----
/** Chunky chibi capybara built from squashed spheres (2 draw calls).
 *  Local height ~2.0, nose at (0, 1.24, 1.72). Used for topiary + statue. */
function buildCapy(sphereGeo, bodyMat, darkMat) {
  const g = new THREE.Group();
  inst(g, sphereGeo, bodyMat, [
    T([0, 0.95, 0], null, [1.12, 0.82, 0.95]),        // barrel
    T([0, 1.34, 0.92], null, [0.62, 0.58, 0.6]),      // head
    T([0, 1.2, 1.4], null, [0.4, 0.33, 0.38]),        // snout
    T([-0.36, 1.7, 0.78], null, 0.18),                // ears
    T([0.36, 1.7, 0.78], null, 0.18),
    T([-0.62, 0.3, 0.58], null, [0.27, 0.32, 0.27]),  // legs
    T([0.62, 0.3, 0.58], null, [0.27, 0.32, 0.27]),
    T([-0.62, 0.3, -0.56], null, [0.27, 0.32, 0.27]),
    T([0.62, 0.3, -0.56], null, [0.27, 0.32, 0.27]),
    T([0, 1.0, -0.98], null, [0.3, 0.28, 0.3]),       // rump
  ], true, false);
  inst(g, sphereGeo, darkMat, [
    T([-0.26, 1.46, 1.3], null, 0.09),                // eyes
    T([0.26, 1.46, 1.3], null, 0.09),
    T([0, 1.24, 1.72], null, [0.13, 0.1, 0.1]),       // nose
  ], false, false);
  return g;
}

// =============================================================== the room ===
export class PlazaRoom extends Room {
  id = 'plaza';
  name = 'Sunny Plaza';

  constructor() {
    super();
    this.t = 0;
    this.anim = null;
    this.noticeIdx = 0;
    // world clock (LIVING-COVE.md A). null until the server's first frame: with
    // no clock the plaza keeps its shipped noon look exactly, so offline/solo
    // sessions are unchanged.
    this._dayT = null;
    this._serverT = 0;
    this.weather = 'clear';
    this.aurora = false;
    this._rainLevel = 0;
    this.mural = null;
    this._muralReqT = 0;
    this._muralTries = 0;
    this._off = [];
  }

  build(scene, game) {
    const rand = rng(20260806);
    this.t = 0;
    this.groundMeshes = [];
    this.hotspots = [];
    this.obstacles = [];
    this.anim = {};
    this.game = game || null;
    this._dayT = null;
    this._rainLevel = 0;
    this.weather = 'clear';
    this.aurora = false;
    this.mural = null;
    for (const off of this._off) { try { off(); } catch { /* already gone */ } }
    this._off = [];

    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(FOG, 42, 118);

    const hemi = new THREE.HemisphereLight(0xfff6e2, 0x8fae6a, 1.0);
    scene.add(hemi);
    const amb = new THREE.AmbientLight(0xdfefff, 0.2);
    scene.add(amb);
    const sun = new THREE.DirectionalLight(0xfff3d2, 1.55);
    sun.position.set(14, 22, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    // widened from +-21/62 for the clock: a dawn or dusk sun sits ~17 degrees
    // above the horizon and the plaza's shadows stretch well past the old
    // frustum. Still ONE shadow caster, still a 1024 map.
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 86;
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    this.anim.sun = sun;
    this.anim.hemi = hemi;
    this.anim.amb = amb;
    this.anim.skyColor = scene.background;
    this.anim.fog = scene.fog;

    this._buildGround(scene, rand);
    this._buildHorizon(scene, rand);
    this._buildFountain(scene, rand);
    this._buildLamps(scene);
    this._buildBenches(scene);
    this._buildFlowerBeds(scene, rand);
    this._buildTopiary(scene);
    this._buildQuestBoard(scene);
    this._buildMural(scene, game);
    this._buildShop(scene);
    this._buildGates(scene);
    this._buildClubEntrance(scene);
    this._buildScatter(scene, rand);
    this._buildCritters(scene, rand);
    this._buildRain(scene);

    // just inside each gate, a step beyond its hotspot radius so arriving from
    // a room does not immediately re-prompt the way back
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4),
      from_beach: new THREE.Vector3(-9.5, 0, 0),
      from_peak: new THREE.Vector3(0, 0, -9.5),
      from_cafe: new THREE.Vector3(9.44, 0, 1.45),
      from_club: new THREE.Vector3(6.72, 0, 8.21),
    };
    this.cameraHint = { offset: new THREE.Vector3(0, 15, 20), lookHeight: 1.2 };
    // static camera: the whole cobbled circle, all three gate arches and the club mouth
    this.staticCamera = { position: new THREE.Vector3(0, 23.5, 32), lookAt: new THREE.Vector3(0, 1.2, 0.6) };
  }

  // -------------------------------------------------------------- ground --
  _buildGround(scene, rand) {
    // sea + island skirt (decor, not walkable)
    const sea = put(scene, new THREE.CircleGeometry(130, 44), makeToon(C.seaFar),
      0, -1.35, 0, { rot: [-Math.PI / 2, 0, 0], cast: false });
    const foam = put(scene, new THREE.TorusGeometry(18.8, 0.34, 5, 56), glowFade(0xffffff, 0.5),
      0, -0.95, 0, { rot: [-Math.PI / 2, 0, 0], cast: false });
    put(scene, new THREE.CylinderGeometry(18.6, 15.2, 4.6, 52), makeToon(C.sand),
      0, -2.32, 0, { cast: false, recv: true });

    // walkable grass
    const grass = put(scene, new THREE.CircleGeometry(ISLAND_R, 56), makeToon(C.grass),
      0, 0, 0, { rot: [-Math.PI / 2, 0, 0], cast: false, recv: true });

    // cobbled plaza
    const cob = cobbleTex(rand);
    cob.wrapS = cob.wrapT = THREE.RepeatWrapping;
    cob.repeat.set(7, 7);
    const plaza = put(scene, new THREE.CircleGeometry(PLAZA_R, 60), toonMap(0xffffff, cob),
      0, Y_PLAZA, 0, { rot: [-Math.PI / 2, 0, 0], cast: false, recv: true });

    // inlay rings (fountain surround + plaza border)
    inst(scene, new THREE.RingGeometry(0.928, 1, 60), makeToon(C.stoneDark), [
      T([FX, Y_INLAY, FZ], [-Math.PI / 2, 0, 0], [4.15, 4.15, 1]),
      T([0, Y_INLAY, 0], [-Math.PI / 2, 0, 0], [9.15, 9.15, 1]),
    ], false, true);

    // paths out to each gate (instanced, walkable)
    const pathGeo = new THREE.PlaneGeometry(1, 1);
    pathGeo.rotateX(-Math.PI / 2);
    const pathTex = cob.clone();
    pathTex.needsUpdate = true;
    pathTex.repeat.set(1.3, 2.9);
    const seg = [];
    for (const p of [[-1, 0], [0, -1], [0.988, 0.152], [0.633, 0.774]]) {
      const a = 8.1, b = 15.6;
      seg.push(T(
        [p[0] * (a + b) / 2, Y_PATH, p[1] * (a + b) / 2],
        [0, Math.atan2(p[0], p[1]), 0],
        [3.4, 1, b - a],
      ));
    }
    const paths = inst(scene, pathGeo, toonMap(0xffffff, pathTex), seg, false, true);

    // cobbled apron in front of the shop
    const apronTex = cob.clone();
    apronTex.needsUpdate = true;
    apronTex.repeat.set(3.1, 3.3);
    const apron = put(scene, pathGeo, toonMap(0xffffff, apronTex), 10.0, Y_APRON, -4.8,
      { scale: [8.0, 1, 8.6], cast: false, recv: true });

    this.groundMeshes.push(grass, plaza, paths, apron);
    this.anim.sea = sea;
    this.anim.foam = foam;
  }

  // ------------------------------------------------------------- horizon --
  _buildHorizon(scene, rand) {
    const hillGeo = new THREE.SphereGeometry(1, 12, 8);
    const bands = [[], [], []];
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + rand() * 0.22;
      const b = i % 3;
      const r = b === 0 ? 52 + rand() * 8 : b === 1 ? 68 + rand() * 10 : 84 + rand() * 12;
      const w = 14 + rand() * 16;
      bands[b].push(T([Math.cos(a) * r, -3.5, Math.sin(a) * r], [0, rand() * 3, 0],
        [w, 6 + rand() * 9, w * 0.8]));
    }
    inst(scene, hillGeo, makeToon(C.hillA), bands[0], false, false);
    inst(scene, hillGeo, makeToon(C.hillB), bands[1], false, false);
    inst(scene, hillGeo, makeToon(C.hillC), bands[2], false, false);

    // clouds: one instanced puff field, slowly orbiting the cove
    const clouds = new THREE.Group();
    const puffs = [];
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + rand() * 0.4;
      const r = 36 + rand() * 30;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = 15 + rand() * 12;
      const n = 3 + ((rand() * 3) | 0);
      const s = 2.4 + rand() * 2.6;
      for (let j = 0; j < n; j++) {
        const u = (j / (n - 1 || 1) - 0.5) * 2;
        const k = 1 - Math.abs(u) * 0.34;
        puffs.push(T(
          [cx + u * s * 1.5, cy + (1 - u * u) * s * 0.35, cz + (rand() - 0.5) * s],
          null, [s * k, s * 0.62 * k, s * k],
        ));
      }
    }
    inst(clouds, new THREE.SphereGeometry(1, 10, 7), makeToon(C.cloud), puffs, false, false);
    scene.add(clouds);
    this.anim.clouds = clouds;
  }

  // ------------------------------------------------------------ fountain --
  _buildFountain(scene, rand) {
    const g = new THREE.Group();
    g.position.set(FX, 0, FZ);
    scene.add(g);

    const stone = makeToon(C.stone);
    const stoneD = makeToon(C.stoneDark);
    put(g, new THREE.CylinderGeometry(3.15, 3.3, 0.22, 32), stoneD, 0, 0.11, 0, { recv: true });
    put(g, new THREE.CylinderGeometry(2.92, 3.02, 0.2, 32), stone, 0, 0.3, 0, { recv: true });
    put(g, new THREE.CylinderGeometry(2.6, 2.7, 0.62, 32, 1, true),
      makeToon(C.stone, { side: THREE.DoubleSide }), 0, 0.7, 0, { recv: true });
    put(g, new THREE.TorusGeometry(2.63, 0.14, 8, 32), stone, 0, 1.0, 0, { rot: [-Math.PI / 2, 0, 0] });
    put(g, new THREE.CircleGeometry(2.62, 32), makeToon(0x2f7f9c), 0, 0.41, 0,
      { rot: [-Math.PI / 2, 0, 0], cast: false });

    // wish coins on the basin floor
    const coins = [];
    for (let i = 0; i < 11; i++) {
      const a = rand() * Math.PI * 2, r = 0.5 + rand() * 1.9;
      coins.push(T([Math.cos(a) * r, 0.44, Math.sin(a) * r], [0, rand() * 3, 0]));
    }
    inst(g, new THREE.CylinderGeometry(0.11, 0.11, 0.03, 8), makeGlow(C.gold), coins, false, false);

    // water surface
    const rip = rippleTex(rand);
    rip.wrapS = rip.wrapT = THREE.RepeatWrapping;
    rip.repeat.set(2.4, 2.4);
    const water = put(g, new THREE.CircleGeometry(2.52, 32),
      toonMap(C.water, rip, { transparent: true, opacity: 0.85 }), 0, 0.78, 0,
      { rot: [-Math.PI / 2, 0, 0], cast: false });

    // spreading ripple rings
    const ringGeo = new THREE.RingGeometry(0.42, 0.52, 24);
    const rings = [];
    for (let i = 0; i < 2; i++) {
      const mat = glowFade(0xffffff, 0.4);
      const mesh = put(g, ringGeo, mat, (rand() - 0.5) * 1.4, 0.8, (rand() - 0.5) * 1.4,
        { rot: [-Math.PI / 2, 0, 0], cast: false });
      rings.push({ mesh, mat, t: i * 0.5, sp: 0.45 + rand() * 0.2 });
    }

    // pedestal, bowl, capybara statue
    put(g, new THREE.CylinderGeometry(0.5, 0.74, 1.02, 16), stone, 0, 0.9, 0);
    put(g, new THREE.CylinderGeometry(1.0, 0.44, 0.34, 22), stone, 0, 1.55, 0);
    put(g, new THREE.TorusGeometry(1.0, 0.08, 6, 22), stoneD, 0, 1.71, 0, { rot: [-Math.PI / 2, 0, 0] });
    const statue = buildCapy(new THREE.SphereGeometry(1, 12, 9), stone, makeToon(0x6e6350));
    statue.position.set(0, 1.7, 0);
    statue.scale.setScalar(0.42);
    g.add(statue);

    // jets: bowl overflow + a spout from the statue's nose
    const jets = [];
    for (let i = 0; i < 44; i++) {
      jets.push({
        a: rand() * Math.PI * 2, r0: 1.0, y0: 1.52, vr: 0.62, vy: 0.45,
        dur: 0.44, t: rand() * 0.44, sp: 0.9 + rand() * 0.25,
      });
    }
    for (let i = 0; i < 16; i++) {
      jets.push({
        a: Math.PI / 2 + (rand() - 0.5) * 0.34, r0: 0.72, y0: 2.2, vr: 1.72, vy: 1.15,
        dur: 0.68, t: rand() * 0.68, sp: 1.0 + rand() * 0.2,
      });
    }
    const jetMesh = inst(g, new THREE.SphereGeometry(0.1, 7, 5), makeGlow(0xd6f2ff),
      jets.map(() => T([0, -9, 0])), false, false);

    this.obstacles.push({ x: FX, z: FZ, r: 2.85 });
    this.anim.water = water;
    this.anim.waterTex = rip;
    this.anim.rings = rings;
    this.anim.jets = { mesh: jetMesh, items: jets };
  }

  // --------------------------------------------------------------- lamps --
  _buildLamps(scene) {
    // The east lamp sits at z 5.1, not 4.2: the walk line from spawn (0,4) to the
    // cafe gate (13,2) passes under it, and 4.2 left only 0.8 of clearance.
    const pts = [
      [7.27, 5.1], [-7.27, 4.2], [-4.2, -7.27], [4.2, -7.27], [5.99, -2.2], [-5.99, -2.2],
    ];
    const base = [], post = [], cap = [], globe = [], halo = [];
    for (const [x, z] of pts) {
      base.push(T([x, 0.13, z]));
      post.push(T([x, 1.7, z]));
      cap.push(T([x, 3.62, z]));
      globe.push(T([x, 3.28, z]));
      halo.push(T([x, 3.28, z]));
      this.obstacles.push({ x, z, r: 0.5 });
    }
    inst(scene, new THREE.CylinderGeometry(0.34, 0.44, 0.26, 10), makeToon(C.stoneDark), base, true, true);
    inst(scene, new THREE.CylinderGeometry(0.1, 0.14, 3.4, 8), makeToon(C.iron), post);
    inst(scene, new THREE.ConeGeometry(0.36, 0.4, 6), makeToon(C.gold), cap);
    // unique (not the shared glow cache) so the clock may lerp their colour;
    // the gate lamps below reuse this same material and light with them
    const lampMat = makeGlow(C.lampGlow, { unique: true });
    const haloMat = glowFade(C.lampGlow, 0.2);
    const globeMesh = inst(scene, new THREE.SphereGeometry(0.26, 12, 9), lampMat, globe, false, false);
    const haloMesh = inst(scene, new THREE.SphereGeometry(0.44, 10, 8), haloMat, halo, false, false);

    // Warm pool on the cobbles under each lamp. LIVING-COVE.md asks for "a warm
    // point light where one already exists": the plaza's only point light is the
    // grotto mouth, so rather than add six new lights (and six more shadow-free
    // but still per-frame-lit surfaces) the spill is one additive instanced
    // decal. Same read, one draw call, no new casters.
    // The pool carries a radial falloff map (poolTex) rather than being a flat
    // disc: at full opacity a hard rim sliced a bright arc across the topiary
    // planter and the flower-bed stone it reached, which read as a decal bug.
    const poolMat = glowAdd(0xffd88f, 0);
    poolMat.map = poolTex();
    const poolGeo = new THREE.CircleGeometry(1.55, 20);
    const poolMesh = inst(scene, poolGeo, poolMat, pts.map(([x, z]) =>
      T([x, 0.11, z], [-Math.PI / 2, 0, 0], 0.25)), false, false);
    poolMesh.visible = false;

    // per-lamp 0-2s stagger so the row does not snap on in lockstep at dusk
    const lr = rng(7717); // own stream: never disturb the layout rand sequence
    const lit = pts.map(() => ({ v: 0, t: 0, delay: lr() * 2 }));
    this.anim.lamps = { pts, globeMesh, haloMesh, poolMesh, lampMat, haloMat, poolMat, lit, on: false };

    // bunting strung between neighbouring lamps
    const spans = [[1, 5], [5, 2], [2, 3], [3, 4], [4, 0]];
    const cordPts = [];
    const flagCols = [C.coral, C.cream];
    const flags = [[], []];
    const flagData = [];
    const beads = [], beadPts = [];
    for (const [ia, ib] of spans) {
      const a = pts[ia], b = pts[ib];
      // Tied to the very top of each lamp (cap tip is 3.82), not to its middle:
      // at 3.25 the cord ran straight through the glowing globe at 3.28 and the
      // three spans meeting at a lamp made a bright tangle there. Low point is
      // now 3.2, still well clear of avatars and name tags.
      const top = 3.9, sag = 0.7;
      let prev = null;
      for (let s = 0; s <= 14; s++) {
        const u = s / 14;
        const p = [a[0] + (b[0] - a[0]) * u, top - sag * 4 * u * (1 - u), a[1] + (b[1] - a[1]) * u];
        if (prev) cordPts.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
        prev = p;
        if (s > 0 && s < 14 && s % 2 === 0) {
          const k = flagData.length % 2;
          flagData.push({ p, k, i: flags[k].length, phase: flagData.length * 0.7 });
          flags[k].push(T([p[0], p[1] - 0.2, p[2]], [Math.PI, 0, 0]));
        } else if (s > 0 && s < 14) {
          // a bulb between every pair of flags: dark beads by day, the string
          // lights that come on at dusk (LIVING-COVE.md A)
          beadPts.push(p);
          beads.push(T([p[0], p[1] - 0.07, p[2]], null, 0.8));
        }
      }
    }
    const cordGeo = new THREE.BufferGeometry();
    cordGeo.setAttribute('position', new THREE.Float32BufferAttribute(cordPts, 3));
    scene.add(new THREE.LineSegments(cordGeo, new THREE.LineBasicMaterial({ color: 0x6b4f35 })));
    const flagGeo = new THREE.ConeGeometry(0.19, 0.4, 3);
    const flagMeshes = flagCols.map((c, i) => inst(scene, flagGeo, makeGlow(c), flags[i], false, false));
    const beadMat = makeGlow(BEAD_DAY.getHex(), { unique: true });
    const beadMesh = inst(scene, new THREE.SphereGeometry(0.11, 8, 6), beadMat, beads, false, false);
    const beadLit = beadPts.map((_, i) => ({ v: 0, t: 0, delay: (i * 0.29) % 2 }));
    this.anim.bunting = { flagMeshes, flagData, beadMesh, beadMat, beadPts, beadLit };
  }

  // ------------------------------------------------------------- benches --
  _buildBenches(scene) {
    // Four flank the fountain; the fifth is a lawn seat on the south-west grass,
    // well outside every gate route (it used to sit at (7.0, 1.4) and squeezed
    // the walk to the cafe gate down to a 1.26-wide gap against the east lamp).
    const spots = [[4.9, -3.4], [-4.9, -3.4], [-2.6, -7.6], [2.6, -7.6], [-4.6, 12.4]];
    const seat = [], back = [], legs = [], arms = [];
    for (const [x, z] of spots) {
      const bm = T([x, 0, z], [0, Math.atan2(FX - x, FZ - z), 0]); // face the fountain
      seat.push(_m1.multiplyMatrices(bm, T([0, 0.56, 0], null, [1.95, 0.14, 0.68])).clone());
      back.push(_m1.multiplyMatrices(bm, T([0, 0.95, -0.3], [0.22, 0, 0], [1.95, 0.62, 0.12])).clone());
      for (const sx of [-0.8, 0.8]) {
        legs.push(_m1.multiplyMatrices(bm, T([sx, 0.26, 0], null, [0.16, 0.52, 0.6])).clone());
        arms.push(_m1.multiplyMatrices(bm, T([sx, 0.78, 0.06], null, [0.12, 0.34, 0.7])).clone());
      }
      this.obstacles.push({ x, z, r: 1.05 });
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    const wood = makeToon(C.wood);
    inst(scene, box, wood, seat, true, true);
    inst(scene, box, wood, back);
    inst(scene, box, makeToon(C.iron), legs);
    inst(scene, box, makeToon(C.woodDark), arms);
  }

  // --------------------------------------------------------- flower beds --
  _buildFlowerBeds(scene, rand) {
    // The east bed sits in the grass wedge between the cafe path and the club
    // path. At (9.6, 5.6) it hugged the cafe side, leaving a thin ragged sliver
    // of grass along the club path and reaching into the east lamp's light
    // pool; (10.3, 5.9) centres it with an even ~1.15 margin off both path
    // edges and clears the lamp, so the ring reads as planted, not dropped.
    const beds = [[-7.27, -4.2], [-3.4, -10.6], [3.4, -10.6], [10.3, 5.9]];
    const rim = [], soil = [], stems = [];
    const blooms = [[], []];
    for (const [x, z] of beds) {
      rim.push(T([x, 0.24, z]));
      soil.push(T([x, 0.42, z]));
      for (let i = 0; i < 13; i++) {
        const a = rand() * Math.PI * 2, r = rand() * 0.95;
        const fx = x + Math.cos(a) * r, fz = z + Math.sin(a) * r;
        const h = 0.3 + rand() * 0.3;
        stems.push(T([fx, 0.44 + h / 2, fz],
          [(rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3], [1, h / 0.4, 1]));
        blooms[(rand() * 2) | 0].push(T([fx, 0.46 + h, fz], [rand(), rand(), rand()], 0.9 + rand() * 0.35));
      }
      this.obstacles.push({ x, z, r: 1.35 });
    }
    inst(scene, new THREE.CylinderGeometry(1.28, 1.38, 0.48, 14), makeToon(C.stone), rim, true, true);
    inst(scene, new THREE.CylinderGeometry(1.18, 1.18, 0.1, 14), makeToon(0x6b4b32), soil, false, true);
    inst(scene, new THREE.CylinderGeometry(0.035, 0.045, 0.4, 4), makeToon(C.leafDark), stems, false, false);
    const bloomGeo = new THREE.IcosahedronGeometry(0.15, 0);
    inst(scene, bloomGeo, makeToon(C.coral), blooms[0], false, false);
    inst(scene, bloomGeo, makeToon(C.gold), blooms[1], false, false);
  }

  // ------------------------------------------------------------- topiary --
  _buildTopiary(scene) {
    const x = -6.9, z = 6.9;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = Math.atan2(-x, -2 - z); // look at the plaza
    scene.add(g);

    put(g, new THREE.CylinderGeometry(1.5, 1.65, 0.34, 16), makeToon(C.stone), 0, 0.17, 0, { recv: true });
    put(g, new THREE.CylinderGeometry(1.35, 1.35, 0.16, 16), makeToon(0x5e4630), 0, 0.36, 0, { recv: true });

    const sway = new THREE.Group();
    sway.position.y = 0.42;
    sway.scale.setScalar(0.68);
    g.add(sway);
    sway.add(buildCapy(new THREE.SphereGeometry(1, 12, 9), makeToon(C.leaf), makeToon(0x2f5720)));
    const dots = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      dots.push(T([Math.cos(a) * 0.92, 1.05 + Math.sin(a * 2) * 0.45, Math.sin(a) * 0.78], null, 0.13));
    }
    inst(sway, new THREE.IcosahedronGeometry(1, 0), makeGlow(0xfff0a8), dots, false, false);

    // The leaning "Do not nibble" plaque that used to prop against this planter
    // is gone: from the plaza it read as a stray sled-shaped board tipped over
    // beside the quest board, and its joke is already one of the NOTICES the
    // board itself hands out. The topiary keeps the corner on its own.

    this.obstacles.push({ x, z, r: 1.7 });
    this.anim.topiary = sway;
  }

  // --------------------------------------------------------- quest board --
  _buildQuestBoard(scene) {
    // Set back on the west lawn: at (-8.6, 3.0) its collider reached to within
    // 0.47 of the spawn -> beach-gate walk line. Its hotspot still overlaps the
    // route, so passers-by are offered the read without being herded into it.
    // Wave 7 (LIVING-COVE.md D): the cove notice board IS the Quest Board now.
    // Playtester layout pass (dev editor, 2026-08-07): brought in off the west
    // lawn to the middle of the plaza, square to the arrival camera, so the
    // day's jobs are the first thing you read when you walk in.
    const x = 0.04, z = 1.0;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    // Facing the plaza centre (the original yaw 1.90) put its BACK to the play
    // camera; the later 0.95 fixed that but left the board sitting at a
    // different angle from the mural wall 6.6 away, so this whole civic corner
    // read as furniture dropped at random. It now shares the mural wall's yaw
    // exactly: the two faces are parallel, square-on to the static camera and
    // 9 degrees off square from the follow camera at spawn. The hotspot is
    // pinned below rather than derived from the yaw, so the walk line from
    // spawn to the beach gate still passes through it.
    g.rotation.y = -0.045;
    scene.add(g);

    const wood = makeToon(C.wood), woodD = makeToon(C.woodDark);
    inst(g, new THREE.BoxGeometry(0.17, 2.5, 0.17), woodD,
      [T([-1.15, 1.25, 0]), T([1.15, 1.25, 0])], true, true);
    put(g, new THREE.BoxGeometry(2.7, 1.75, 0.14), woodD, 0, 1.85, 0);
    put(g, new THREE.PlaneGeometry(2.42, 1.5), toonMap(0xffffff, questBoardTex()), 0, 1.85, 0.09, { cast: false });
    put(g, new THREE.BoxGeometry(3.1, 0.12, 0.62), wood, 0, 2.84, 0.12, { rot: [0.34, 0, 0] });
    put(g, new THREE.BoxGeometry(0.6, 0.5, 0.5), wood, 0, 0.28, 0.34, { recv: true });

    // gold "there is something for you here" marker, bobbing over the shingle
    const star = put(g, new THREE.OctahedronGeometry(0.3, 0), makeGlow(C.gold), 0, 3.5, 0.18, { cast: false });
    star.scale.set(1, 1.5, 1);
    this.anim.questStar = star;

    // The three loose white sheets that used to flap here are gone. They hung
    // off the left and right edges of the plank face (and one above the
    // shingle), so from the plaza they read as litter caught on the board
    // rather than as pinned notes. The four notes drawn INTO questBoardTex sit
    // squarely on the cork and say the same thing without the clutter.

    this.obstacles.push({ x, z, r: 1.1 });
    this.hotspots.push({
      id: 'quest-board',
      // Derived from the board, not pinned: a hardcoded world position stayed
      // behind on the west lawn when the board moved, leaving the prompt
      // floating in an empty corner. It sits 2.2 out from the reading face.
      position: new THREE.Vector3(x + Math.sin(g.rotation.y) * 2.2, 0, z + Math.cos(g.rotation.y) * 2.2),
      radius: 2.4,
      label: 'Quest Board',
      // The old cove-notice toast survives as the offline fallback: if the
      // quests overlay is missing or fails to load, the board still reads.
      action: (gm) => import('../../ui/quests.js')
        .then((m) => m.openQuests(gm))
        .catch(() => this._readNotice(gm)),
    });
  }

  /** Pre-wave-7 behaviour of this board: cycle a flavour notice as a toast. */
  _readNotice(gm) {
    gm.toast(NOTICES[this.noticeIdx % NOTICES.length]);
    this.noticeIdx++;
  }

  // ---------------------------------------------------------- mural wall --
  _buildMural(scene, game) {
    // Same civic corner of the west lawn as the quest board (6.6 apart, both in
    // one frame from the plaza). It faces roughly due south because that is the
    // only orientation here that reads from BOTH the follow camera and the
    // static camera; swinging it tangential to the shore would have pointed it
    // at the sea, and widening it past ~6.6 walks the far post off the grass.
    // HEIGHT IS A CAMERA CONSTRAINT, not a taste call: the follow camera sits
    // 20 back and 15 up, so the sight line to a player's feet at the quest
    // board clears y=5.36 where this wall stands. The first pass topped out at
    // 5.68 and cut the player's legs off. Everything here stays under ~5.1.
    // Playtester layout pass (dev editor, 2026-08-07): swung west and south so
    // the wall faces the arrival approach instead of standing edge-on to it.
    const x = -11.87, z = 6.63;
    const yaw = 0.740;                     // 42.4 degrees
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    scene.add(g);

    const wood = makeToon(C.wood), woodD = makeToon(C.woodDark), stone = makeToon(C.stone);
    put(g, new THREE.BoxGeometry(6.9, 0.4, 1.2), stone, 0, 0.2, 0, { recv: true });
    inst(g, new THREE.BoxGeometry(0.4, 4.6, 0.5), woodD,
      [T([-3.15, 2.4, 0]), T([3.15, 2.4, 0])], true, true);
    put(g, new THREE.BoxGeometry(6.3, 3.9, 0.3), woodD, 0, 2.5, 0, { recv: true });
    put(g, new THREE.BoxGeometry(7.2, 0.42, 0.7), wood, 0, 4.7, 0);
    put(g, new THREE.BoxGeometry(7.5, 0.2, 0.95), makeToon(C.coral), 0, 4.98, 0);

    // the canvas itself: one texel per cell, magnified with NearestFilter so the
    // pixels stay chunky and square instead of smearing into watercolour
    const tex = canvasTexture(MURAL_W, MURAL_H, (ctx, w, h) => {
      ctx.fillStyle = MURAL_PALETTE[0];
      ctx.fillRect(0, 0, w, h);
    });
    tex.magFilter = THREE.NearestFilter;
    const cells = new Uint8Array(MURAL_W * MURAL_H);
    this.mural = { cells, tex, ctx: tex.image.getContext('2d'), dirty: false, got: false };
    this._muralRepaint();
    tex.needsUpdate = true;
    // The artwork lights itself after dusk via its own emissiveMap rather than
    // an additive wash over the top: one fewer draw call, and the cove's
    // colours stay their own colours instead of bleaching toward the lamp.
    const canvasMat = toonMap(0xffffff, tex);
    canvasMat.emissiveMap = tex;
    canvasMat.emissive = new THREE.Color(0x000000);
    put(g, new THREE.PlaneGeometry(5.9, 3.32), canvasMat, 0, 2.55, 0.17, { cast: false });

    put(g, new THREE.PlaneGeometry(3.3, 0.74),
      toonMap(0xffffff, woodSignTex('The Cove Mural', 'one pixel each, be nice')),
      0, 4.7, 0.37, { cast: false });

    // hooded picture lights: they come on with the plaza lamps so the artwork
    // still reads after dusk (they share the lamp material, no extra lights)
    const lampMat = this.anim.lamps?.lampMat || makeGlow(C.lampGlow, { unique: true });
    inst(g, new THREE.CylinderGeometry(0.22, 0.3, 0.26, 8), makeToon(C.iron),
      [T([-1.9, 4.45, 0.5], [0.7, 0, 0]), T([1.9, 4.45, 0.5], [0.7, 0, 0])], false, false);
    // bulbs sit UNDER the shade rims: level with the hood they were swallowed
    inst(g, new THREE.SphereGeometry(0.13, 8, 6), lampMat,
      [T([-1.9, 4.21, 0.63]), T([1.9, 4.21, 0.63])], false, false);

    // paint pots on the plinth: the wall says "you may touch this". Instanced
    // pots + one lid mesh per colour keeps this whole prop to 4 draw calls.
    const potXs = [-2.3, -1.75, -1.2];
    inst(g, new THREE.CylinderGeometry(0.17, 0.15, 0.3, 10), makeToon(0xdedede),
      potXs.map((px) => T([px, 0.55, 0.36])), true, false);
    const lidGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.05, 10);
    [C.coral, C.sky, C.leaf].forEach((c, i) => {
      put(g, lidGeo, makeGlow(c), potXs[i], 0.71, 0.36, { cast: false });
    });
    put(g, new THREE.CylinderGeometry(0.03, 0.05, 0.7, 6), makeToon(C.wood), 2.2, 0.72, 0.36,
      { rot: [0.25, 0, 0.4] });

    this.obstacles.push(
      { x: x - 2.1, z: z + 0.66, r: 1.0 },
      { x, z, r: 1.0 },
      { x: x + 2.1, z: z - 0.66, r: 1.0 },
    );
    this.hotspots.push({
      id: 'mural',
      position: new THREE.Vector3(x + Math.sin(yaw) * 2.9, 0, z + Math.cos(yaw) * 2.9),
      radius: 2.6,
      label: 'Paint the Cove Mural',
      action: (gm) => {
        try { openMural(gm); }
        catch { gm.toast('The mural is drying. Try again in a moment.'); }
      },
    });

    // Live wiring: ops are painted straight onto this texture, so the wall shows
    // the current artwork even with nobody's overlay open. The server already
    // pushes the grid to anyone joining the plaza, so the request below is only
    // the belt to that braces, and it retries at most twice (the handler is
    // socialLimited, and burning a player's social budget on a redraw is rude).
    this._muralReqT = 3;
    this._muralTries = 0;
    if (game?.events) {
      this._off.push(game.events.on('mural', (m) => {
        if (m) this._muralPaint(m.x, m.y, m.c);
      }));
      this._off.push(game.events.on('mural-grid', (m) => this._muralApplyGrid(m)));
    }
    this._muralRequest();
    this.anim.muralMat = canvasMat;
  }

  _muralRequest() {
    try { this.game?.net?.send?.({ t: 'mural-grid' }); } catch { /* offline: the wall just stays blank */ }
  }

  /** Paint one cell. Cheap enough to call once per broadcast op. */
  _muralPaint(px, py, ci) {
    const m = this.mural;
    if (!m) return;
    // a refusal frame ({ok:false, wait}) rides the same 'mural' name and has no
    // cell at all: coercing undefined would repaint (0,0) cream on every miss
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(ci)) return;
    px = Math.floor(px); py = Math.floor(py); ci = Math.floor(ci);
    if (px < 0 || py < 0 || px >= MURAL_W || py >= MURAL_H) return;
    if (ci < 0 || ci >= MURAL_PALETTE.length) return;
    m.cells[py * MURAL_W + px] = ci;
    m.ctx.fillStyle = MURAL_PALETTE[ci];
    m.ctx.fillRect(px, py, 1, 1);
    m.dirty = true;
  }

  /** Redraw the whole texture from `cells` (one full-grid blit). */
  _muralRepaint() {
    const m = this.mural;
    if (!m) return;
    m.ctx.putImageData(muralImageData(m.cells, m.ctx), 0, 0);
    m.dirty = true;
  }

  _muralApplyGrid(msg) {
    const m = this.mural;
    if (!m || !msg) return;
    const grid = decodeMuralGrid(msg); // null on anything malformed
    if (!grid || grid.length !== m.cells.length) return;
    m.cells.set(grid);
    m.got = true;
    this._muralRepaint();
  }

  // ---------------------------------------------------------------- shop --
  _buildShop(scene) {
    // Playtester layout pass (dev editor, 2026-08-07): pushed north-east and
    // turned 45 degrees so the shop presents a corner to the plaza instead of
    // a flat wall, and its awning side faces the walk in from the fountain.
    const cx = 11.21, cz = -7.43;  // building centre
    const fw = -2.6;               // local x of the west-facing wall
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = Math.PI / 4;
    scene.add(g);

    put(g, new THREE.BoxGeometry(5.2, 4.0, 6.8), makeToon(C.cream), 0, 2.0, 0, { recv: true });
    put(g, new THREE.BoxGeometry(5.34, 0.34, 6.94), makeToon(C.stoneDark), 0, 0.17, 0, { recv: true });

    const roofGeo = new THREE.ConeGeometry(1, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    // pyramid roof: base sits exactly on the wall top (4.0), eaves overhang 0.35
    put(g, roofGeo, makeToon(C.coral), 0, 4.95, 0,
      { scale: [2.95 * Math.SQRT2, 1.9, 3.75 * Math.SQRT2] });
    put(g, new THREE.CylinderGeometry(0.035, 0.035, 1.2, 6), makeToon(C.iron), 0, 6.5, 0);
    put(g, new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10), makeToon(C.hatFelt), 0, 7.15, 0);
    put(g, new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12), makeToon(C.hatFelt), 0, 7.0, 0);

    // door
    put(g, new THREE.BoxGeometry(0.24, 2.5, 1.7), makeToon(C.woodDark), fw, 1.3, 0);
    const doorMat = glowFade(0xffdca8, 0.85);
    put(g, new THREE.PlaneGeometry(1.4, 2.15), doorMat, fw - 0.14, 1.25, 0,
      { rot: [0, -Math.PI / 2, 0], cast: false });
    put(g, new THREE.BoxGeometry(1.1, 0.14, 2.1), makeToon(C.stone), fw - 0.6, 0.09, 0, { recv: true });

    // windows + flower boxes (instanced across every window)
    const frame = makeToon(C.woodDark);
    const frames = [], glasses = [], boxes = [], dots = [];
    for (const wz of [-2.2, 2.2]) {
      frames.push(T([fw, 2.2, wz]));
      glasses.push(T([fw - 0.12, 2.2, wz], [0, -Math.PI / 2, 0]));
      boxes.push(T([fw - 0.22, 1.34, wz]));
      for (let i = 0; i < 5; i++) dots.push(T([fw - 0.24, 1.56, wz - 0.55 + i * 0.28], null, 0.15));
    }
    // South wall (sw = its local z). It is the face you walk toward from spawn,
    // and it shipped as 5.2 x 4.0 of blank plaster: a finished-looking shopfront
    // from the west and an unfinished box from the south. It gets the SAME
    // window/box/bloom instances turned a quarter turn, so dressing it costs no
    // extra draw calls and the glass still lerps warm at dusk with the others.
    const sw = 3.4, wx = 1.15;
    frames.push(T([wx, 2.2, sw], [0, Math.PI / 2, 0]));
    glasses.push(T([wx, 2.2, sw + 0.12]));
    boxes.push(T([wx, 1.34, sw + 0.22], [0, Math.PI / 2, 0]));
    for (let i = 0; i < 5; i++) dots.push(T([wx - 0.55 + i * 0.28, 1.56, sw + 0.24], null, 0.15));
    inst(g, new THREE.BoxGeometry(0.2, 1.5, 1.7), frame, frames);
    // glass reflects the sky by day and the warm shop interior after dusk
    const glassMat = glowFade(0x9fdcf5, 0.9);
    inst(g, new THREE.PlaneGeometry(1.4, 1.24), glassMat, glasses, false, false);
    this.anim.windows = { glassMat, doorMat };
    inst(g, new THREE.BoxGeometry(0.42, 0.3, 1.5), makeToon(C.wood), boxes);
    inst(g, new THREE.IcosahedronGeometry(1, 0), makeToon(C.coral), dots, false, false);

    // striped awning with a scalloped valance: the long shopfront one, plus a
    // short one over the south window. Both valance rods ride one instanced
    // mesh and both scallop runs ride another.
    const stripes = stripeTex();
    stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping;
    stripes.repeat.set(1, 7);
    put(g, new THREE.BoxGeometry(1.95, 0.13, 6.6), toonMap(0xffffff, stripes), fw - 0.92, 3.06, 0,
      { rot: [0, 0, 0.3] });
    const stripesS = stripeTex();
    stripesS.wrapS = stripesS.wrapT = THREE.RepeatWrapping;
    stripesS.repeat.set(1, 2.4);   // same stripe width as the shopfront awning
    // The quarter turn puts the 2.2 length along the wall and the 0.3 tips the
    // outer lip down toward the plaza, exactly like the west awning.
    put(g, new THREE.BoxGeometry(1.3, 0.12, 2.2), toonMap(0xffffff, stripesS), wx, 3.15, sw + 0.6,
      { rot: [0.3, Math.PI / 2, 0] });
    inst(g, new THREE.BoxGeometry(0.16, 0.16, 6.7), frame, [
      T([fw - 1.83, 2.79, 0]),
      T([wx, 2.97, sw + 1.2], [0, Math.PI / 2, 0], [1, 1, 2.2 / 6.7]),
    ], false, false);
    const scallop = [];
    for (let i = 0; i < 11; i++) scallop.push(T([fw - 1.86, 2.78, -3.0 + i * 0.6], null, [0.16, 0.3, 0.3]));
    for (let i = 0; i < 5; i++) scallop.push(T([wx - 0.9 + i * 0.45, 2.96, sw + 1.23], null, [0.3, 0.3, 0.16]));
    inst(g, new THREE.SphereGeometry(1, 8, 6), makeToon(C.coral), scallop, false, false);

    // south wall trim: corner posts, a band under the eaves and the poster
    // board, all four on one instanced box
    inst(g, new THREE.BoxGeometry(1, 1, 1), frame, [
      T([0, 3.74, sw + 0.06], null, [5.3, 0.24, 0.22]),
      T([-2.46, 2.12, sw + 0.06], null, [0.26, 3.48, 0.22]),
      T([2.46, 2.12, sw + 0.06], null, [0.26, 3.48, 0.22]),
      T([-1.2, 2.2, sw + 0.07], null, [1.32, 1.62, 0.12]),
    ], true, true);
    put(g, new THREE.PlaneGeometry(1.12, 1.4), toonMap(0xffffff, shopPosterTex()),
      -1.2, 2.2, sw + 0.15, { cast: false });

    // shop sign over the awning
    put(g, new THREE.BoxGeometry(0.18, 1.5, 4.1), frame, fw - 0.05, 4.15, 0);
    put(g, new THREE.PlaneGeometry(3.85, 1.34),
      toonMap(0xffffff, woodSignTex('Wardrobe & Hat Shop', 'hats, dyes and good vibes')),
      fw - 0.16, 4.15, 0, { rot: [0, -Math.PI / 2, 0], cast: false });

    // hanging round sign, readable from the plaza
    const iron = makeToon(C.iron);
    put(g, new THREE.BoxGeometry(0.1, 0.1, 1.6), iron, fw - 0.6, 3.5, 3.05, { cast: false });
    put(g, new THREE.CylinderGeometry(0.04, 0.04, 0.55, 5), iron, fw - 0.6, 3.24, 3.75, { cast: false });
    put(g, new THREE.CircleGeometry(0.62, 20), glowMap(hatSignTex()), fw - 0.6, 2.68, 3.78, { cast: false });
    // decorated back: from the fountain walk the single-faced sign showed a bare
    // edge floating off the bracket (DESIGN.md: backs are slabs, never voids)
    put(g, new THREE.CircleGeometry(0.64, 20), makeToon(C.coral), fw - 0.6, 2.68, 3.765,
      { rot: [0, Math.PI, 0], cast: false });

    // outdoor stall against the shop front, hats on display
    const sx = -3.6, sz = -2.6;
    const cloth = stripeTex();
    cloth.wrapS = cloth.wrapT = THREE.RepeatWrapping;
    cloth.repeat.set(1, 4);
    put(g, new THREE.BoxGeometry(1.15, 0.85, 2.3), toonMap(0xffffff, cloth), sx, 0.46, sz);
    put(g, new THREE.BoxGeometry(1.3, 0.14, 2.5), makeToon(C.wood), sx, 0.95, sz, { recv: true });
    put(g, new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12), makeToon(C.hatFelt), sx, 1.17, sz - 0.74);
    put(g, new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12), makeToon(C.hatFelt), sx, 1.04, sz - 0.74);
    put(g, new THREE.ConeGeometry(0.3, 0.44, 12), makeToon(C.coral), sx, 1.24, sz);
    put(g, new THREE.SphereGeometry(0.26, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), makeToon(C.sky),
      sx, 1.02, sz + 0.76);

    // Colliders and the counter prompt are placed in WORLD space, so they have
    // to be turned by hand to match the building's 45 degrees: the three-circle
    // spine now runs along the rotated long axis, and the shop prompt sits off
    // the counter's new corner rather than due west of the old flat wall.
    const rot = (lx, lz) => {
      const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
      return { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c };
    };
    const spine = [rot(0, -2.4), rot(0, 0), rot(0, 2.4)];
    const counter = rot(sx, sz);
    this.obstacles.push(
      { ...spine[0], r: 2.2 },
      { ...spine[1], r: 2.2 },
      { ...spine[2], r: 2.2 },
      { ...counter, r: 1.3 },
    );
    const prompt = rot(-4.0, 0);
    this.hotspots.push({
      id: 'shop',
      position: new THREE.Vector3(prompt.x, 0, prompt.z),
      radius: 2.6,
      label: 'Wardrobe & Hat Shop',
      action: (gm) => import('../../ui/shop.js').then((m) => m.openShop(gm)),
    });
  }

  // --------------------------------------------------------------- gates --
  _buildGates(scene) {
    const gates = [
      { to: 'beach', x: -13, z: 0, name: 'Driftwood Beach' },
      { to: 'peak', x: 0, z: -13, name: 'Frosty Peak' },
      { to: 'cafe', x: 13, z: 2, name: 'The Smoothie Shack' },
    ];
    const stone = makeToon(C.stone);
    const planeGeo = new THREE.PlaneGeometry(2.4, 0.8);
    const posts = [], arches = [], lamps = [], boards = [], poles = [], pennants = [];
    const planters = [], bushes = [], keystones = [];

    for (const gt of gates) {
      const yaw = Math.atan2(gt.x, gt.z);            // local +Z points out of the cove
      const px = Math.cos(yaw), pz = -Math.sin(yaw); // local +X in world space
      const gm = T([gt.x, 0, gt.z], [0, yaw, 0]);
      const L = (p, r, s) => _m1.multiplyMatrices(gm, T(p, r, s)).clone();
      const g = new THREE.Group();
      g.position.set(gt.x, 0, gt.z);
      g.rotation.y = yaw;
      scene.add(g);

      posts.push(L([1.45, 1.6, 0]), L([-1.45, 1.6, 0]));
      arches.push(L([0, 3.2, 0]));
      lamps.push(L([1.45, 3.44, 0]), L([-1.45, 3.44, 0]));
      // The name board is MOUNTED, not floated: a stone keystone straddles the
      // arch crown (torus tops out at 3.2 + 1.45 + 0.28 = 4.93) and the board
      // seats on it. The first fix lifted the board clear of the stone but
      // left it hanging off a hairline pole, which read as levitation from
      // ten metres; the keystone gives the eye the load path.
      keystones.push(L([0, 4.95, 0]));
      boards.push(L([0, 5.42, 0]));
      poles.push(L([0, 6.3, 0]));
      pennants.push(L([0.26, 6.62, 0], [0, 0, -Math.PI / 2]));
      planters.push(L([2.5, 0.28, 0]), L([-2.5, 0.28, 0]));
      bushes.push(L([2.5, 0.74, 0]), L([-2.5, 0.74, 0]));

      // name board, painted on both faces so it reads coming and going
      const signMat = toonMap(0xffffff, woodSignTex(gt.name, ''));
      put(g, planeGeo, signMat, 0, 5.42, 0.09, { cast: false });
      put(g, planeGeo, signMat, 0, 5.42, -0.09, { rot: [0, Math.PI, 0], cast: false });

      this.obstacles.push(
        { x: gt.x + px * 1.45, z: gt.z + pz * 1.45, r: 0.55 },
        { x: gt.x - px * 1.45, z: gt.z - pz * 1.45, r: 0.55 },
        { x: gt.x + px * 2.5, z: gt.z + pz * 2.5, r: 0.7 },
        { x: gt.x - px * 2.5, z: gt.z - pz * 2.5, r: 0.7 },
      );
      this.hotspots.push({
        id: `exit-${gt.to}`,
        position: new THREE.Vector3(gt.x, 0, gt.z),
        radius: 3,
        label: `Go to ${gt.name}`,
        action: (gm2) => gm2.goToRoom(gt.to, 'plaza'),
      });
    }
    inst(scene, new THREE.CylinderGeometry(0.3, 0.36, 3.2, 9), stone, posts, true, true);
    inst(scene, new THREE.TorusGeometry(1.45, 0.28, 8, 18, Math.PI), stone, arches);
    // the gate lanterns share the plaza lamp material, so they light together
    inst(scene, new THREE.SphereGeometry(0.2, 10, 8),
      this.anim.lamps?.lampMat || makeGlow(C.lampGlow), lamps, false, false);
    // keystone: a tapered wedge (box narrowed at the foot) straddling the crown
    const keyGeo = new THREE.BoxGeometry(0.56, 0.62, 0.44);
    {
      const kp = keyGeo.attributes.position;
      for (let i = 0; i < kp.count; i++) if (kp.getY(i) < 0) kp.setX(i, kp.getX(i) * 0.7);
      keyGeo.computeVertexNormals();
    }
    inst(scene, keyGeo, stone, keystones, true, true);
    inst(scene, new THREE.BoxGeometry(2.55, 0.9, 0.16), makeToon(C.woodDark), boards);
    inst(scene, new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), makeToon(C.iron), poles, false, false);
    inst(scene, new THREE.ConeGeometry(0.3, 0.55, 3), makeGlow(C.coral), pennants, false, false);
    inst(scene, new THREE.CylinderGeometry(0.5, 0.6, 0.55, 10), stone, planters, true, true);
    inst(scene, new THREE.SphereGeometry(0.55, 10, 8), makeToon(C.leafDark), bushes);
  }

  // ------------------------------------------------------- club entrance --
  _buildClubEntrance(scene) {
    const ex = 9, ez = 11;
    const dx = 0.633, dz = 0.774;     // outward from the plaza
    const g = new THREE.Group();
    g.position.set(ex + dx * 1.3, 0, ez + dz * 1.3);
    g.rotation.y = Math.atan2(dx, dz); // local +Z points into the headland
    scene.add(g);

    const sphere = new THREE.SphereGeometry(1, 14, 10);
    put(g, sphere, makeToon(C.rock), 0, -0.7, 3.6, { scale: [4.7, 4.2, 4.2], recv: true });
    put(g, sphere, makeToon(C.grassDark), 0, 1.3, 4.3, { scale: [3.4, 1.8, 3.2], cast: false });
    inst(g, new THREE.IcosahedronGeometry(1, 0), makeToon(C.stoneDark), [
      T([2.4, 0.55, 0.4], [0.2, 1, 0.1], [1.0, 1.55, 1.0]),
      T([-2.4, 0.55, 0.4], [0.2, -1, 0.1], [1.0, 1.55, 1.0]),
    ], true, true);

    // the mouth: dark interior, purple glow, stone arch
    const stone = makeToon(C.stone);
    put(g, new THREE.BoxGeometry(3.3, 2.7, 1.9), makeToon(0x271c33), 0, 1.3, 1.0, { cast: false });
    put(g, new THREE.PlaneGeometry(3.3, 2.6), glowFade(C.clubGlow, 0.7), 0, 1.3, -0.02,
      { rot: [0, Math.PI, 0], cast: false });
    put(g, new THREE.TorusGeometry(1.72, 0.22, 8, 20, Math.PI), stone, 0, 1.3, -0.1);
    inst(g, new THREE.BoxGeometry(0.44, 2.7, 0.44), stone,
      [T([1.72, 0.65, -0.1]), T([-1.72, 0.65, -0.1])], true, true);

    // steps down into the dark
    const steps = [];
    for (let i = 0; i < 5; i++) {
      steps.push(T([0, -0.02 - i * 0.17, -0.15 + i * 0.45], null, [3.0 - i * 0.14, 0.2, 0.45]));
    }
    inst(g, new THREE.BoxGeometry(1, 1, 1), makeToon(C.stoneDark), steps, false, true);

    // neon sign on a bracket above the arch
    put(g, new THREE.BoxGeometry(0.12, 0.9, 0.12), makeToon(C.iron), 0, 3.3, 0.05, { cast: false });
    put(g, new THREE.BoxGeometry(3.5, 1.25, 0.18), makeToon(0x4a4060), 0, 3.9, -0.05);
    // neon on BOTH faces so the sign reads from every camera angle
    put(g, new THREE.PlaneGeometry(3.32, 1.14), glowMap(neonTex('GROOVE GROTTO')), 0, 3.9, -0.16,
      { rot: [0, Math.PI, 0], cast: false });
    put(g, new THREE.PlaneGeometry(3.32, 1.14), glowMap(neonTex('GROOVE GROTTO')), 0, 3.9, 0.06,
      { cast: false });

    const pl = new THREE.PointLight(C.clubGlow, 24, 13, 2);
    pl.position.set(0, 1.4, 0.4);
    g.add(pl);

    // notes drifting out of the grotto
    const motes = [], moteData = [];
    for (let i = 0; i < 12; i++) {
      moteData.push({ t: i / 12, sp: 0.4 + (i % 4) * 0.08, a: i * 1.3, r: 0.3 + (i % 3) * 0.45 });
      motes.push(T([0, -9, 0]));
    }
    const moteMesh = inst(g, new THREE.TorusGeometry(0.13, 0.05, 5, 8), makeGlow(0xff9ff0), motes, false, false);

    const nx = -dz, nz = dx; // perpendicular
    this.obstacles.push(
      { x: g.position.x + nx * 2.15, z: g.position.z + nz * 2.15, r: 1.2 },
      { x: g.position.x - nx * 2.15, z: g.position.z - nz * 2.15, r: 1.2 },
      { x: g.position.x + dx * 3.6, z: g.position.z + dz * 3.6, r: 3.0 },
    );
    this.hotspots.push({
      id: 'exit-club',
      position: new THREE.Vector3(ex, 0, ez),
      radius: 3,
      label: 'Down to Groove Grotto',
      action: (gm) => gm.goToRoom('club', 'plaza'),
    });
    this.anim.club = { pl, moteMesh, moteData };
  }

  // ------------------------------------------------------------- scatter --
  _buildScatter(scene, rand) {
    const keep = [
      { x: ZONE.x, z: ZONE.z, r: ZONE.r + 1.6 },
      { x: 0, z: 0, r: 10.6 },
      { x: -13, z: 0, r: 4.2 }, { x: 0, z: -13, r: 4.2 }, { x: 13, z: 2, r: 4.2 },
      { x: 10.6, z: -4.8, r: 6.6 }, { x: 10.9, z: 13.2, r: 7.0 },
      { x: -6.9, z: 6.9, r: 3.0 }, { x: -9.9, z: 4.4, r: 3.0 },
      { x: -9.4, z: 6.6, r: 2.4 }, { x: 10.3, z: 5.9, r: 2.4 },
      { x: -4.6, z: 12.4, r: 2.2 }, // clearing around the lawn bench
      { x: -9.9, z: 11.0, r: 5.6 }, // mural wall: nothing grows in front of it
    ];
    const segs = [
      [-8, 0, -16, 0], [0, -8, 0, -16], [8, 1.2, 16, 2.5], [5.2, 6.4, 10.2, 12.4],
    ];
    const okSpot = (x, z, pad) => {
      for (const k of keep) if (Math.hypot(x - k.x, z - k.z) < k.r + pad) return false;
      for (const s of segs) {
        const ax = s[2] - s[0], az = s[3] - s[1];
        let t = ((x - s[0]) * ax + (z - s[1]) * az) / (ax * ax + az * az);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - (s[0] + ax * t), z - (s[1] + az * t)) < 2.6 + pad) return false;
      }
      return true;
    };

    const trunks = [], leafA = [], leafB = [], rocks = [], tufts = [], wildA = [];
    let trees = 0;
    for (let i = 0; i < 260 && trees < 14; i++) {
      const a = rand() * Math.PI * 2;
      const r = 11.0 + rand() * 5.4;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!okSpot(x, z, 1.4)) continue;
      let clash = false;
      for (const o of this.obstacles) {
        if (Math.hypot(x - o.x, z - o.z) < o.r + 1.6) { clash = true; break; }
      }
      if (clash) continue;
      trees++;
      const s = 0.85 + rand() * 0.5;
      trunks.push(T([x, 0.75 * s, z], [0, rand() * 3, 0], s));
      const tall = rand() > 0.5;
      const tgt = tall ? leafA : leafB;
      tgt.push(T([x, (1.55 + rand() * 0.2) * s, z], [rand(), rand(), rand()],
        [1.25 * s, (tall ? 1.5 : 1.1) * s, 1.25 * s]));
      tgt.push(T([x + (rand() - 0.5) * 0.7 * s, (2.4 + rand() * 0.3) * s, z + (rand() - 0.5) * 0.7 * s],
        [rand(), rand(), rand()], [0.9 * s, 0.85 * s, 0.9 * s]));
      this.obstacles.push({ x, z, r: 0.85 });
    }
    for (let i = 0; i < 320; i++) {
      const a = rand() * Math.PI * 2;
      const r = 9.6 + rand() * 7.6;
      if (r > 17.4) continue;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (rocks.length < 16 && rand() > 0.72 && okSpot(x, z, 0.8)) {
        rocks.push(T([x, 0.12 + rand() * 0.12, z], [rand(), rand(), rand()],
          [0.4 + rand() * 0.55, 0.32 + rand() * 0.4, 0.4 + rand() * 0.5]));
      } else if (tufts.length < 96 && okSpot(x, z, 0.2)) {
        tufts.push(T([x, 0.2, z], [0, rand() * 3, 0],
          [0.8 + rand() * 0.6, 0.7 + rand() * 0.9, 0.8 + rand() * 0.6]));
        if (rand() > 0.62) {
          wildA.push(T([x + 0.25, 0.34, z + 0.2], [rand(), rand(), rand()], 0.1 + rand() * 0.05));
        }
      }
    }
    inst(scene, new THREE.CylinderGeometry(0.17, 0.26, 1.5, 7), makeToon(C.woodDark), trunks, true, true);
    const leafGeo = new THREE.IcosahedronGeometry(1, 0);
    inst(scene, leafGeo, makeToon(C.leaf), leafA);
    inst(scene, leafGeo, makeToon(C.leafDark), leafB);
    inst(scene, new THREE.IcosahedronGeometry(1, 0), makeToon(C.rock), rocks, true, true);
    inst(scene, new THREE.ConeGeometry(0.13, 0.45, 4), makeToon(C.grassDark), tufts, false, false);
    inst(scene, new THREE.IcosahedronGeometry(1, 0), makeToon(0xfff0a8), wildA, false, false);
  }

  // ------------------------------------------------------------ critters --
  _buildCritters(scene, rand) {
    // Seven, not fourteen, and in the room's own coral/gold rather than the old
    // near-white pinks. Two unlit pale rectangles flapping over a cobbled square
    // read as a scrap of paper caught in the wind, not as a butterfly, and at
    // fourteen of them the plaza was permanently speckled with litter. Saturated
    // wings at half the count read as the critters they always were.
    const flies = [], wingsA = [], wingsB = [];
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2;
      const r = 3.5 + rand() * 11;
      flies.push({
        cx: Math.cos(a) * r, cz: Math.sin(a) * r,
        rad: 0.9 + rand() * 2.2, y: 1.0 + rand() * 1.5,
        sp: 0.5 + rand() * 0.6, ph: rand() * 6.28, bob: 0.2 + rand() * 0.35,
        set: i % 2, idx: (i / 2) | 0,
      });
      const target = i % 2 ? wingsB : wingsA;
      target.push(T([0, -9, 0]), T([0, -9, 0]));
    }
    const wingGeo = new THREE.BoxGeometry(0.26, 0.02, 0.19);
    this.anim.flies = {
      flies,
      meshA: inst(scene, wingGeo, makeGlow(C.coral), wingsA, false, false),
      meshB: inst(scene, wingGeo, makeGlow(C.gold), wingsB, false, false),
    };

    // The 26 "petals on the breeze" that used to cross the island are gone.
    // Unlit pale pentagons at head height, drifting in a straight line across
    // the whole plaza, read as loose sheets of paper blowing through a tidy
    // town square rather than as blossom, and there were enough of them to
    // speckle every frame. The butterflies above still carry the ambient
    // motion; the fountain, bunting and clouds carry the rest.
  }

  // ---------------------------------------------------------------- rain --
  _buildRain(scene) {
    // Weather 'rain' (LIVING-COVE.md A): one instanced streak field over the
    // island plus gloss decals on the cobbles. Both start hidden and cost
    // nothing until the clock says it is raining.
    const r = rng(90210);
    const drops = [], mats = [];
    for (let i = 0; i < 260; i++) {
      drops.push({
        x: -23 + r() * 46, y: r() * 17, z: -21 + r() * 42,
        sp: 15 + r() * 10, len: 0.7 + r() * 0.8,
      });
      mats.push(T([0, -99, 0]));
    }
    const mat = glowFade(0xcfeaff, 0.42);
    const mesh = inst(scene, new THREE.BoxGeometry(0.035, 1, 0.035), mat, mats, false, false);
    mesh.visible = false;
    mesh.frustumCulled = false; // the field is bigger than its origin-anchored box

    const pud = [];
    for (let i = 0; i < 40 && pud.length < 14; i++) {
      const a = r() * Math.PI * 2, rr = 1.4 + r() * 7.2;
      const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
      if (Math.hypot(px - FX, pz - FZ) < 3.5) continue; // not inside the fountain
      pud.push(T([px, 0.105, pz], [-Math.PI / 2, 0, r() * 3],
        [0.55 + r() * 0.9, 0.42 + r() * 0.8, 1]));
    }
    const pudMat = glowFade(0xdff1ff, 0);
    const pudMesh = inst(scene, new THREE.CircleGeometry(1, 14), pudMat, pud, false, false);
    pudMesh.visible = false;
    this.anim.rain = { mesh, mat, drops, pudMesh, pudMat };
  }

  // --------------------------------------------------------- world clock --
  /** Room API added in wave 7: called once right after build and on every
   *  server 'clock' frame (every 10s). Stores the target; update() eases the
   *  local phase toward it so nothing ever snaps. */
  onClock(dayT, weather, aurora) {
    if (!this.anim) return;
    const u = (((Number(dayT) || 0) % 1) + 1) % 1;
    const first = this._dayT === null;
    this._serverT = u;
    if (first) this._dayT = u;
    this.weather = weather === 'rain' || weather === 'breeze' ? weather : 'clear';
    // the plaza has no aurora (peak only, LIVING-COVE.md A); kept for the API
    this.aurora = !!aurora;
    if (first) {
      // arriving at night must not replay the dusk light-up cascade
      const lit = nightMix(u) > 0.5 ? 1 : 0;
      const L = this.anim.lamps;
      if (L) { L.on = !!lit; for (const s of L.lit) { s.v = lit; s.t = 9; } }
      const B = this.anim.bunting;
      if (B?.beadLit) for (const s of B.beadLit) { s.v = lit; s.t = 9; }
      this._rainLevel = this.weather === 'rain' ? 1 : 0;
    }
    this._applyClock();
  }

  /** Writes the current phase into the sky, fog, lights and emissive props.
   *  Every colour target below is preallocated; nothing here allocates. */
  _applyClock() {
    const a = this.anim;
    if (!a || this._dayT === null) return;
    const u = this._dayT;
    const rain = this._rainLevel;

    const f = u * 4;
    const fi = Math.floor(f);
    const kk = f - fi;
    const i = ((fi % 4) + 4) % 4;
    const A = SKY_LUT[i], B = SKY_LUT[(i + 1) % 4];
    const k = kk * kk * (3 - 2 * kk);

    if (a.skyColor) {
      _cA.copy(A.sky).lerp(B.sky, k);
      if (rain > 0) _cA.lerp(RAIN_TINT, rain * 0.55).multiplyScalar(1 - rain * 0.2);
      a.skyColor.copy(_cA);
    }
    if (a.fog) {
      _cB.copy(A.fog).lerp(B.fog, k);
      if (rain > 0) _cB.lerp(RAIN_TINT, rain * 0.6).multiplyScalar(1 - rain * 0.14);
      a.fog.color.copy(_cB);
      a.fog.near = 42 - rain * 16;   // rain closes the horizon in
      a.fog.far = 118 - rain * 44;
    }

    // One caster all day: it is the sun while it is up and the moon after, so
    // the light always comes from above and the shadow budget never changes.
    if (a.sun) {
      const s = Math.sin(u * TAU);
      const c = Math.cos(u * TAU);
      const up = Math.abs(s);
      const hx = s < 0 ? -c : c;    // the moon rises where the sun set
      a.sun.position.set(4 + hx * 15, 7 + up * 18, 8 + hx * 5);
      a.sun.color.copy(A.sun).lerp(B.sun, k);
      a.sun.intensity = (A.sunI + (B.sunI - A.sunI) * k) * (1 - rain * 0.45);
    }
    if (a.hemi) {
      a.hemi.color.copy(A.hemiSky).lerp(B.hemiSky, k);
      a.hemi.groundColor.copy(A.hemiGnd).lerp(B.hemiGnd, k);
      // playability floor: the plaza never goes darker than you can walk in
      a.hemi.intensity = Math.max(0.45, (A.hemiI + (B.hemiI - A.hemiI) * k) * (1 - rain * 0.22));
    }
    if (a.amb) a.amb.intensity = A.ambI + (B.ambI - A.ambI) * k;

    // emissives: lamps, string lights and windows come on dusk-to-dawn
    const nm = nightMix(u);
    const L = a.lamps;
    if (L) {
      L.on = nm > 0.5;
      L.lampMat.color.copy(LAMP_DAY).lerp(LAMP_NIGHT, nm);
      L.haloMat.opacity = 0.06 + nm * 0.4;
      L.poolMat.opacity = nm * 0.55;
      L.poolMesh.visible = nm > 0.01;
    }
    const Bu = a.bunting;
    if (Bu?.beadMat) {
      Bu.beadMat.color.copy(BEAD_DAY).lerp(BEAD_NIGHT, nm);
    }
    if (a.muralMat) a.muralMat.emissive.setScalar(nm * 0.42);
    if (a.windows) {
      a.windows.glassMat.color.copy(WIN_DAY).lerp(WIN_NIGHT, nm);
      a.windows.glassMat.opacity = 0.9 + nm * 0.1;
      a.windows.doorMat.color.copy(DOOR_DAY).lerp(DOOR_NIGHT, nm);
      a.windows.doorMat.opacity = 0.85 + nm * 0.15;
    }
  }

  // --------------------------------------------------------------- frame --
  update(dt) {
    const a = this.anim;
    if (!a) return;
    this.t += dt;
    const t = this.t;

    // ---- world clock: run the phase locally, ease onto the server's value.
    // Frames land every 10s; interpolating between them keeps the sky moving
    // instead of stepping (LIVING-COVE.md A).
    const clocked = this._dayT !== null;
    if (clocked) {
      let err = this._serverT - this._dayT;
      if (err > 0.5) err -= 1; else if (err < -0.5) err += 1;
      this._dayT = (this._dayT + dt / DAY_SECONDS + err * Math.min(1, dt * 0.6) + 1) % 1;
      const wantRain = this.weather === 'rain' ? 1 : 0;
      this._rainLevel += (wantRain - this._rainLevel) * Math.min(1, dt * 0.4);
      this._applyClock();
    }
    // a couple of retries in case the build-time request beat the socket open
    if (this.mural && !this.mural.got && this._muralTries < 2) {
      this._muralReqT -= dt;
      if (this._muralReqT <= 0) {
        this._muralReqT = 4;
        this._muralTries++;
        this._muralRequest();
      }
    }
    const wind = this.weather === 'breeze' ? 1.8 : this.weather === 'rain' ? 1.35 : 1;

    if (a.sea) a.sea.position.y = -1.35 + Math.sin(t * 0.5) * 0.05;
    if (a.foam) {
      a.foam.rotation.z += dt * 0.05;
      a.foam.position.y = -0.95 + Math.sin(t * 0.8) * 0.06;
    }
    if (a.clouds) a.clouds.rotation.y += dt * 0.006 * wind;

    // fountain
    if (a.waterTex) {
      a.waterTex.offset.y -= dt * 0.045;
      a.waterTex.offset.x += dt * 0.025;
    }
    if (a.water) a.water.position.y = 0.78 + Math.sin(t * 1.7) * 0.015;
    if (a.rings) {
      for (const r of a.rings) {
        r.t += dt * r.sp;
        if (r.t > 1) r.t -= 1;
        const s = 0.6 + r.t * 4.0;
        r.mesh.scale.set(s, s, 1);
        r.mat.opacity = 0.42 * (1 - r.t);
      }
    }
    if (a.jets) {
      const items = a.jets.items;
      for (let i = 0; i < items.length; i++) {
        const j = items[i];
        j.t += dt * j.sp;
        if (j.t > j.dur) j.t -= j.dur;
        const jt = j.t;
        const rr = j.r0 + j.vr * jt;
        const s = 1.05 - jt * 0.5;
        _o2.position.set(Math.cos(j.a) * rr, j.y0 + j.vy * jt - 4.9 * jt * jt, Math.sin(j.a) * rr);
        _o2.rotation.set(0, 0, 0);
        _o2.scale.set(s, s * (1 + jt * 0.5), s);
        _o2.updateMatrix();
        a.jets.mesh.setMatrixAt(i, _o2.matrix);
      }
      a.jets.mesh.instanceMatrix.needsUpdate = true;
    }

    // lamps breathe, and light up one by one after dusk
    if (a.lamps) {
      const L = a.lamps;
      const pts = L.pts;
      const want = L.on ? 1 : 0;
      const ease = Math.min(1, dt * 3.2);
      for (let i = 0; i < pts.length; i++) {
        const st = L.lit[i];
        st.t += dt;
        if (st.t >= st.delay) st.v += (want - st.v) * ease;
        const lv = clocked ? st.v : 1;
        const p = Math.sin(t * 1.6 + i * 1.1);
        _o2.position.set(pts[i][0], 3.28, pts[i][1]);
        _o2.rotation.set(0, 0, 0);
        _o2.scale.setScalar((clocked ? 0.88 + lv * 0.12 : 1) * (1 + p * 0.05));
        _o2.updateMatrix();
        L.globeMesh.setMatrixAt(i, _o2.matrix);
        _o2.scale.setScalar((clocked ? 0.25 + lv * 0.75 : 1) * (1 + p * 0.14));
        _o2.updateMatrix();
        L.haloMesh.setMatrixAt(i, _o2.matrix);
        if (L.poolMesh.visible) {
          _o2.position.set(pts[i][0], 0.11, pts[i][1]);
          _o2.rotation.set(-Math.PI / 2, 0, 0);
          _o2.scale.setScalar(lv * (0.98 + p * 0.03));
          _o2.updateMatrix();
          L.poolMesh.setMatrixAt(i, _o2.matrix);
        }
      }
      L.globeMesh.instanceMatrix.needsUpdate = true;
      L.haloMesh.instanceMatrix.needsUpdate = true;
      if (L.poolMesh.visible) L.poolMesh.instanceMatrix.needsUpdate = true;
    }

    // bunting: flags flutter, bulbs pop on one at a time at dusk
    if (a.bunting) {
      for (const f of a.bunting.flagData) {
        const s = Math.sin(t * 2.1 * wind + f.phase) * 0.22 * wind;
        _o2.position.set(f.p[0], f.p[1] - 0.2, f.p[2]);
        _o2.rotation.set(Math.PI + s * 0.5, 0, s);
        _o2.scale.setScalar(1);
        _o2.updateMatrix();
        const m = a.bunting.flagMeshes[f.k];
        if (m) m.setMatrixAt(f.i, _o2.matrix);
      }
      for (const m of a.bunting.flagMeshes) if (m) m.instanceMatrix.needsUpdate = true;
      const bm = a.bunting.beadMesh;
      if (bm && clocked) {
        const want = a.lamps?.on ? 1 : 0;
        const ease = Math.min(1, dt * 3.2);
        const pts = a.bunting.beadPts;
        for (let i = 0; i < pts.length; i++) {
          const st = a.bunting.beadLit[i];
          st.t += dt;
          if (st.t >= st.delay) st.v += (want - st.v) * ease;
          _o2.position.set(pts[i][0], pts[i][1] - 0.07, pts[i][2]);
          _o2.rotation.set(0, 0, 0);
          _o2.scale.setScalar(0.8 + st.v * (0.6 + Math.sin(t * 2.3 + i) * 0.08));
          _o2.updateMatrix();
          bm.setMatrixAt(i, _o2.matrix);
        }
        bm.instanceMatrix.needsUpdate = true;
      }
    }

    // quest board marker
    if (a.questStar) {
      a.questStar.position.y = 3.5 + Math.sin(t * 2.0) * 0.11;
      a.questStar.rotation.y += dt * 1.3;
    }

    // topiary
    if (a.topiary) {
      a.topiary.rotation.z = Math.sin(t * 0.9) * 0.035;
      a.topiary.rotation.x = Math.sin(t * 0.7 + 1.0) * 0.025;
    }

    // grotto glow + rising notes
    if (a.club) {
      a.club.pl.intensity = 22 + Math.sin(t * 3.4) * 8;
      const md = a.club.moteData;
      for (let i = 0; i < md.length; i++) {
        const m = md[i];
        m.t += dt * m.sp;
        if (m.t > 1) m.t -= 1;
        const fade = m.t < 0.15 ? m.t / 0.15 : 1 - (m.t - 0.15) / 0.85;
        _o2.position.set(Math.sin(m.a + m.t * 5) * m.r, 0.7 + m.t * 3.4, -0.2 - m.t * 1.1);
        _o2.rotation.set(0, 0, m.t * 4);
        _o2.scale.setScalar(0.25 + fade * 0.85);
        _o2.updateMatrix();
        a.club.moteMesh.setMatrixAt(i, _o2.matrix);
      }
      a.club.moteMesh.instanceMatrix.needsUpdate = true;
    }

    // butterflies
    if (a.flies) {
      for (const f of a.flies.flies) {
        const ang = t * f.sp + f.ph;
        _o.position.set(
          f.cx + Math.cos(ang) * f.rad,
          f.y + Math.sin(t * 2.2 + f.ph) * f.bob,
          f.cz + Math.sin(ang * 1.3) * f.rad,
        );
        _o.rotation.set(0, -ang - Math.PI / 2, 0);
        _o.scale.setScalar(1);
        _o.updateMatrix();
        const mesh = f.set ? a.flies.meshB : a.flies.meshA;
        const flap = Math.sin(t * 16 + f.ph) * 0.9 + 0.35;
        for (let w = 0; w < 2; w++) {
          const s = w ? 1 : -1;
          _o2.position.set(s * 0.16, 0, 0);
          _o2.rotation.set(0, 0, s * flap);
          _o2.scale.setScalar(1);
          _o2.updateMatrix();
          _m2.multiplyMatrices(_o.matrix, _o2.matrix);
          mesh.setMatrixAt(f.idx * 2 + w, _m2);
        }
      }
      a.flies.meshA.instanceMatrix.needsUpdate = true;
      a.flies.meshB.instanceMatrix.needsUpdate = true;
    }

    // rain streaks + puddle gloss (hidden and skipped entirely when dry)
    if (a.rain) {
      const R = a.rain;
      const lv = this._rainLevel;
      if (lv > 0.01) {
        R.mesh.visible = true;
        R.pudMesh.visible = true;
        R.mat.opacity = 0.42 * lv;
        R.pudMat.opacity = 0.28 * lv;
        const d = R.drops;
        for (let i = 0; i < d.length; i++) {
          const p = d[i];
          p.y -= dt * p.sp;
          p.x += dt * 1.6;
          if (p.y < 0) p.y += 17;
          if (p.x > 23) p.x -= 46;
          _o2.position.set(p.x, p.y, p.z);
          _o2.rotation.set(0, 0, 0.1);
          _o2.scale.set(1, p.len * lv, 1);
          _o2.updateMatrix();
          R.mesh.setMatrixAt(i, _o2.matrix);
        }
        R.mesh.instanceMatrix.needsUpdate = true;
      } else if (R.mesh.visible) {
        R.mesh.visible = false;
        R.pudMesh.visible = false;
      }
    }

    // mural: one texture upload per frame no matter how many ops landed
    if (this.mural?.dirty) {
      this.mural.tex.needsUpdate = true;
      this.mural.dirty = false;
    }
  }

  dispose() {
    for (const off of this._off) { try { off(); } catch { /* already gone */ } }
    this._off = [];
    this.mural = null;
    this.game = null;
    this._dayT = null;
    this.anim = null;
    this.groundMeshes = [];
    this.hotspots = [];
    this.obstacles = [];
  }
}
