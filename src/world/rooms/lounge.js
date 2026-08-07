import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BOT_ZONES } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// The Game Den: the warm timber games room INSIDE the Frosty Peak ski lodge.
// Floor plus three walls, the south side open to the camera; the door leads
// back out onto the mountain, so every window looks at snow, pines and the far
// ridges. The star attraction is the grand stone fireplace on the north wall
// with a shelf of little gold capy trophies across its mantel, set opposite the
// door so players walk toward it. Five game stations ring the room, each with a
// different silhouette, its own painted sign and TWO chairs.
//
// Those chairs are the multiplayer half of the room (wave 4). Every station is
// a two-seat table on the server (protocol in CLAUDE.md / src/net/client.js):
//   out  {t:'table-join', game} {t:'table-leave'}
//   in   'table' {game, players:[{id,name}]}
//        'match-start' {game, players, youAre, seed}  -> game.__matchCtx + start
// Seated capybaras are drawn here from the table roster (their networked body
// is un-parented while they sit, exactly like the peak race lobby), and each
// sign carries a live status chip: OPEN / "<name> waits a rival!" / MATCH LIVE.
//
// Everything is procedural: canvas textures for signs, boards, felts, rugs and
// the champion portraits; InstancedMesh batches for the hundreds of small
// props, which keeps the room near 60 draw calls.
//
// Three framing rules drove the layout, all of them found by screenshot:
//   * the room is 16 deep, not 18: with this camera the whole north wall
//     compresses into the top ~20px of frame, and at 18 the fire itself was
//     hidden behind the HUD from the arrival spawn;
//   * nothing overhead reaches south of z = 0.5, because the camera's line to
//     the player crosses head-height ceilings about 6.5 units south of them —
//     side-bay rafters put three beams across the player at every west station;
//   * the doorway has posts but NO lintel (the cafe's lesson): with the camera
//     13.5 behind the player, a lintel at z 8.3 lands exactly on the head of
//     anyone standing on the default spawn.
// ---------------------------------------------------------------------------

const PAL = {
  wall: 0xf0d7a8,
  wainscot: 0x9a6238,
  wood: 0x7a4e2a,
  woodMid: 0xa9703c,
  woodLight: 0xd39a5c,
  cream: 0xfdf0d5,
  coral: 0xe8657a,
  gold: 0xf2b64a,
  brass: 0xd7a44b,
  leather: 0xa9542c,
  leatherDark: 0x7d3a1c,
  stone: 0xcfc0a4,
  stoneMid: 0xb5a58a,
  stoneDark: 0x8f8067,
  ember: 0xff6a1f,
  flame: 0xffb038,
  cobalt: 0x2f6fd0,
  cobaltDark: 0x2153a2,
  red: 0xe04a4a,
  yellow: 0xf5c33b,
  leaf: 0x7ac74f,
  leafDark: 0x4d8c39,
  terracotta: 0xcf7649,
  steel: 0xb9c3cb,
  capy: 0xb08a5a,
  capyDark: 0x8a6642,
  cocoa: 0x5b3521,
  sky: 0x4fb3e8,
  plum: 0x9b6bd4,
  // the mountain outside, borrowed straight from Frosty Peak's palette so the
  // view through the windows matches the room you just walked in from
  snow: 0xf4f9ff,
  snowShade: 0xdde8f6,
  pine: 0x2f6b4f,
  pineDark: 0x24523d,
};

// room shell
const HW = 11;        // half width in x
// 16 deep, matching the shack: with the follow camera 13.5 back and 10.5 up,
// the whole north wall compresses into the top ~20px of the frame, so a room
// any deeper than this hides its own landmark from the arrival spawn.
const ZN = -7;        // north wall (inner face)
const ZS = 9;         // south edge of the floor
const WALL_H = 6.4;
const RAFT_Y = 5.5;
const FZ = -6.5;      // centre plane of the fireplace stonework
const DZ = 8.3;       // doorway posts
const ZONE = BOT_ZONES.lounge; // { x: 0, z: 2, r: 4 }

// window openings, given in WORLD z and mirrored onto both side walls
const WINZ = [[-1.2, 2.0], [3.8, 7.0]];
const WIN_LO = 2.2, WIN_HI = 4.5;

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const OUTLINE = '#2d2417';

// Every station in one table so the floor plan is auditable at a glance: where
// the prop stands, where each of its two prompts fires, where its sign post
// goes, and where its two chairs sit. Sign posts sit off to one side of the
// approach line, never on it.
//
// Layout rules the numbers obey, all of them checked against the obstacle list:
//   * chairs sit clear of every collider (+0.15) and at least 0.9 from their
//     own sign post, so nothing grows through a capybara's hat;
//   * `hs` (sit down) and `aiAt` (play the house) are ~1.5 apart with most of
//     that in z, because the camera trails 13.5 south: two prompts separated in
//     x land on top of each other, separated in z they stack neatly;
//   * neighbouring stations keep their prompts >=2.2 apart, which is as far as
//     chess and four-in-a-row can get from each other and still face the room.
// `ai` is the opponent each minigame actually names in its own code.
const STATIONS = [
  {
    id: 'pong', label: 'Play Paddle Panic', name: 'PADDLE PANIC',
    sub: 'out-volley the house bot', ai: 'Blip',
    at: [-8.6, -4.8], hs: [-5.6, -3.4], aiAt: [-5.35, -1.95], sign: [-8.35, -3.1],
    seats: [[-6.59, -4.74], [-7.27, -3.29]],
  },
  {
    id: 'shuffle', label: 'Play Shuffle Showdown', name: 'SHUFFLE SHOWDOWN',
    sub: 'slide it, do not shove it', ai: 'Waxwell',
    at: [-9.2, 0.8], hs: [-7.0, 0.8], aiAt: [-6.7, 2.25], sign: [-7.95, 2.25],
    seats: [[-9.45, -3.6], [-9.2, 5.25]],
  },
  {
    id: 'cards', label: 'Play Capy Clash', name: 'CAPY CLASH',
    sub: 'elements at dawn', ai: 'Grandmaster Pebble',
    at: [-7.4, 5.8], hs: [-5.2, 5.2], aiAt: [-4.8, 3.75], sign: [-5.3, 7.1],
    seats: [[-6.25, 7.35], [-8.3, 4.35]],
  },
  {
    id: 'chess', label: 'Play Grand Capy Chess', name: 'GRAND CAPY CHESS',
    sub: 'think before you nibble', ai: 'Grandmaster Pebble',
    at: [8.2, -4.8], hs: [6.0, -3.3], aiAt: [6.2, -1.85], sign: [8.05, -2.4],
    seats: [[6.4, -4.55], [8.55, -3.15]],
  },
  {
    id: 'connect4', label: 'Play Four in a Row', name: 'FOUR IN A ROW',
    sub: 'drop, stack, gloat', ai: 'Dizzy',
    at: [9.7, -1.0], hs: [6.75, 0.5], aiAt: [7.0, 1.95], sign: [8.7, 1.85],
    seats: [[8.3, -1.85], [8.3, 0.55]],
  },
];
const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));

const TAU = Math.PI * 2;
// Chair cushions top out at 0.68; a capybara's rear sits 0.12 under its root
// once the sit pose drops the body, so this parks it on the cushion with a
// little squish rather than hovering over it.
const SEAT_Y = 0.74;
const DEFAULT_FUR = 0xb08a5a; // table payload is id+name only; brown until 'pjoin' knows better

/** Which way a seat looks: always straight at the game it belongs to. */
function seatYaw(s, i) {
  const p = s.seats[i];
  return Math.atan2(s.at[0] - p[0], s.at[1] - p[1]);
}

/** Long names get elbowed out of a chip that is only so wide. */
function shortName(n) {
  const t = String(n || 'Someone');
  return t.length > 14 ? `${t.slice(0, 13)}…` : t;
}

const CHAMPIONS = [
  { name: 'Nutmeg', color: 0xb08a5a, hat: 'crown', expr: 'beam' },
  { name: 'Biscuit', color: 0xc9a06b, hat: 'cap', expr: 'idle' },
  { name: 'Pudding', color: 0x8a6642, hat: 'none', expr: 'smug' },
  { name: 'Tugboat', color: 0xe8657a, hat: 'visor', expr: 'idle' },
  { name: 'Marzipan', color: 0x9b6bd4, hat: 'crown', expr: 'beam' },
  { name: 'Old Bramble', color: 0x6b4f35, hat: 'none', expr: 'smug' },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One draw call for every prop sharing a primitive. Per-instance colour needs
 *  no material.vertexColors: three defines USE_COLOR in the fragment prefix
 *  whenever instanceColor is present. */
class Batch {
  constructor(geo) {
    this.geo = geo;
    this.rows = [];
  }

  add(color, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
    this.rows.push([color, x, y, z, sx, sy, sz, rx, ry, rz]);
  }

  build(parent, cast = true, receive = true) {
    if (!this.rows.length) return null;
    const mesh = new THREE.InstancedMesh(this.geo, makeToon(0xffffff, { unique: true }), this.rows.length);
    const d = new THREE.Object3D();
    const c = new THREE.Color();
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      d.position.set(r[1], r[2], r[3]);
      d.scale.set(r[4], r[5], r[6]);
      d.rotation.set(r[7], r[8], r[9]);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      mesh.setColorAt(i, c.set(r[0]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  }
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitFont(g, text, maxW, start, weight = 'bold') {
  let s = start;
  g.font = `${weight} ${s}px ${FONT}`;
  while (s > 8 && g.measureText(text).width > maxW) {
    s -= 2;
    g.font = `${weight} ${s}px ${FONT}`;
  }
}

function ink(g, w) {
  g.lineWidth = w;
  g.strokeStyle = OUTLINE;
  g.stroke();
}

/** css colour from a 0xrrggbb tint, for the canvas painters. */
function tint(hex, amt) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const f = (v) => Math.max(0, Math.min(255, Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

// ---------------------------------------------------------------------------
// canvas painters
// ---------------------------------------------------------------------------
function texPlanks() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    const rows = 5, rh = h / rows;
    const tones = ['#b07f4d', '#a97648', '#bb8a56', '#a06f43', '#b48252'];
    g.fillStyle = '#8f6339';
    g.fillRect(0, 0, w, h);
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      g.fillStyle = tones[r % tones.length];
      g.fillRect(0, y + 1.5, w, rh - 3);
      g.strokeStyle = 'rgba(96,62,30,0.22)';
      g.lineWidth = 1.2;
      for (let i = 0; i < 7; i++) {
        const gy = y + 5 + ((i * 8 + r * 5) % (rh - 10));
        g.beginPath();
        g.moveTo(0, gy);
        g.bezierCurveTo(w * 0.3, gy - 3, w * 0.7, gy + 3, w, gy);
        g.stroke();
      }
      const jx = ((r * 83) % 200) + 26;
      g.fillStyle = 'rgba(70,44,18,0.55)';
      g.fillRect(jx, y + 1.5, 2, rh - 3);
      g.fillStyle = 'rgba(74,46,20,0.4)';
      for (const [nx, ny] of [[jx - 12, 0.32], [jx + 15, 0.7]]) {
        g.beginPath();
        g.arc(nx, y + rh * ny, 2, 0, 7);
        g.fill();
      }
    }
    g.fillStyle = 'rgba(64,40,16,0.6)';
    for (let r = 0; r <= rows; r++) g.fillRect(0, r * rh - 1, w, 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 5);
  return t;
}

/** Woven rug. kind 0: diamond runner. kind 1: round medallion. */
function texRug(kind) {
  return canvasTexture(256, 256, (g, w, h) => {
    const base = kind ? '#8d3a4c' : '#3f6e77';
    const band = kind ? '#c46f5c' : '#d99a52';
    const light = '#f3e0bb';
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = band;
    g.lineWidth = 12;
    g.strokeRect(16, 16, w - 32, h - 32);
    g.strokeStyle = light;
    g.lineWidth = 4;
    g.strokeRect(28, 28, w - 56, h - 56);
    if (kind) {
      for (let r = 0; r < 4; r++) {
        g.beginPath();
        g.arc(w / 2, h / 2, 92 - r * 22, 0, 7);
        g.strokeStyle = r % 2 ? light : band;
        g.lineWidth = r % 2 ? 5 : 12;
        g.stroke();
      }
      g.fillStyle = light;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.beginPath();
        g.ellipse(w / 2 + Math.cos(a) * 58, h / 2 + Math.sin(a) * 58, 9, 6, a, 0, 7);
        g.fill();
      }
    } else {
      for (let i = 0; i < 5; i++) {
        const cy = 40 + i * 44;
        g.beginPath();
        g.moveTo(w / 2, cy - 22);
        g.lineTo(w / 2 + 46, cy);
        g.lineTo(w / 2, cy + 22);
        g.lineTo(w / 2 - 46, cy);
        g.closePath();
        g.fillStyle = i % 2 ? band : light;
        g.fill();
        g.strokeStyle = 'rgba(30,20,10,0.25)';
        g.lineWidth = 3;
        g.stroke();
      }
      g.fillStyle = band;
      for (let i = 0; i < 16; i++) {
        g.fillRect(6, 12 + i * 15, 10, 8);
        g.fillRect(w - 16, 12 + i * 15, 10, 8);
      }
    }
    g.fillStyle = 'rgba(40,24,10,0.10)';
    for (let i = 0; i < 500; i++) g.fillRect((i * 137) % w, (i * 91) % h, 2, 2);
  });
}

/** The mountainside past the glass: ridges, pines, drifts, drifting flakes. */
function texAlps(flip) {
  return canvasTexture(512, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#8fc7ea');
    sky.addColorStop(0.46, '#cfe6f7');
    sky.addColorStop(0.6, '#eaf4fb');
    sky.addColorStop(1, '#f4f9ff');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (const [cx, cy, s] of [[96, 40, 1], [268, 26, 0.7], [412, 52, 0.9]]) {
      const x = flip ? w - cx : cx;
      g.beginPath();
      g.arc(x, cy, 17 * s, 0, 7);
      g.arc(x + 20 * s, cy + 5 * s, 12 * s, 0, 7);
      g.arc(x - 18 * s, cy + 6 * s, 11 * s, 0, 7);
      g.fill();
    }

    // two ridges: the far one hazy blue, the near one rock with snow caps
    const ridge = (base, peaks, fill, cap) => {
      g.fillStyle = fill;
      g.beginPath();
      g.moveTo(-10, base);
      for (const [px, py, pw] of peaks) {
        const x = flip ? w - px : px;
        g.lineTo(x - pw, base);
        g.lineTo(x, py);
        g.lineTo(x + pw, base);
      }
      g.lineTo(w + 10, base);
      g.lineTo(w + 10, h);
      g.lineTo(-10, h);
      g.closePath();
      g.fill();
      if (!cap) return;
      g.fillStyle = cap;
      for (const [px, py, pw] of peaks) {
        const x = flip ? w - px : px;
        const k = (base - py) * 0.34;
        g.beginPath();
        g.moveTo(x, py);
        g.lineTo(x + (pw * k) / (base - py) + 8, py + k);
        g.lineTo(x + 2, py + k * 0.72);
        g.lineTo(x - 5, py + k);
        g.lineTo(x - (pw * k) / (base - py) - 7, py + k);
        g.closePath();
        g.fill();
      }
    };
    ridge(h * 0.58, [[62, 58, 66], [206, 34, 84], [352, 62, 72], [470, 46, 60]], '#9dbcda', '#e8f3ff');
    ridge(h * 0.7, [[128, 96, 78], [300, 82, 92], [446, 104, 70]], '#7e8a99', '#f4f9ff');

    // the snowfield, with two soft drift lines
    g.fillStyle = '#f4f9ff';
    g.beginPath();
    g.moveTo(0, h * 0.69);
    for (let x = 0; x <= w; x += 64) g.quadraticCurveTo(x + 32, h * 0.69 - 14, x + 64, h * 0.69);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();
    g.strokeStyle = '#dde8f6';
    g.lineWidth = 9;
    for (const dy of [0.8, 0.92]) {
      g.beginPath();
      g.moveTo(0, h * dy);
      for (let x = 0; x <= w; x += 96) g.quadraticCurveTo(x + 48, h * dy - 12, x + 96, h * dy);
      g.stroke();
    }

    // pines, snow on every branch
    for (let i = 0; i < 8; i++) {
      const x = 30 + i * 64 + (flip ? 22 : 0);
      const y = h * 0.74 + ((i * 31) % 34);
      const s = 0.8 + ((i * 37) % 40) / 100;
      g.strokeStyle = '#6b4a34';
      g.lineWidth = 7 * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - 22 * s);
      g.stroke();
      for (let k = 0; k < 3; k++) {
        const ty = y - 20 * s - k * 22 * s;
        const tw = (30 - k * 7) * s;
        g.fillStyle = k % 2 ? '#2f6b4f' : '#24523d';
        g.beginPath();
        g.moveTo(x, ty - 30 * s);
        g.lineTo(x + tw, ty);
        g.lineTo(x - tw, ty);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.moveTo(x, ty - 30 * s);
        g.lineTo(x + tw * 0.52, ty - 12 * s);
        g.lineTo(x - tw * 0.52, ty - 12 * s);
        g.closePath();
        g.fill();
      }
    }

    // flakes hanging in the air, so the view never reads as a still photo
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 34; i++) {
      const x = (i * 71) % w;
      const y = 18 + ((i * 53) % (h - 40));
      g.beginPath();
      g.arc(x, y, 2 + (i % 3), 0, 7);
      g.fill();
    }
    g.fillStyle = 'rgba(214,236,255,0.14)';
    g.fillRect(0, 0, w, h);
  });
}

/** The painted board used for every station sign and the way out. */
function texSign(title, sub, bg = '#f6e3bb', fg = '#5b3a1e', edge = '#a06a30') {
  const w = 512, h = 192;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    rrect(g, 8, 8, w - 16, h - 16, 26);
    g.fill();
    g.strokeStyle = edge;
    g.lineWidth = 12;
    g.stroke();
    g.strokeStyle = 'rgba(120,80,36,0.10)';
    g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const y = 26 + i * 28;
      g.beginPath();
      g.moveTo(20, y);
      g.bezierCurveTo(w * 0.35, y - 6, w * 0.7, y + 6, w - 20, y);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, title, w - 70, sub ? 66 : 82, '900');
    g.fillStyle = 'rgba(90,58,30,0.22)';
    g.fillText(title, w / 2 + 3, (sub ? h * 0.42 : h * 0.5) + 3);
    g.fillStyle = fg;
    g.fillText(title, w / 2, sub ? h * 0.42 : h * 0.5);
    if (sub) {
      fitFont(g, sub, w - 90, 32, 'normal');
      g.globalAlpha = 0.72;
      g.fillText(sub, w / 2, h * 0.74);
      g.globalAlpha = 1;
    }
  });
}

/**
 * The live status chip under a station sign. Repainted into the SAME canvas on
 * every 'table' frame (one texture per station, forever), like the peak lobby
 * board. `state` is one of open / waiting / live / solo.
 */
const CHIP_W = 384, CHIP_H = 96;
function paintChip(g, w, h, state, text) {
  g.clearRect(0, 0, w, h);
  const fill = state === 'live' ? '#e8657a'
    : state === 'waiting' ? '#f2b64a'
      : state === 'solo' ? '#c9b79a' : '#7ac74f';
  rrect(g, 7, 10, w - 14, h - 20, (h - 20) / 2);
  g.fillStyle = fill;
  g.fill();
  ink(g, 7);
  // the little lamp: dark when the seat is nobody's business, bright when it is
  g.beginPath();
  g.arc(46, h / 2, 13, 0, 7);
  g.fillStyle = state === 'open' || state === 'live' ? '#fff6e3' : 'rgba(255,246,227,0.55)';
  g.fill();
  ink(g, 5);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, text, w - 120, 40, '900');
  g.fillStyle = state === 'waiting' || state === 'solo' ? '#4a3316' : '#fff6e3';
  g.fillText(text, w / 2 + 20, h / 2 + 2);
}

function texChip() {
  return canvasTexture(CHIP_W, CHIP_H, (g, w, h) => paintChip(g, w, h, 'open', 'OPEN'));
}

function texMarquee() {
  const w = 512, h = 160;
  return canvasTexture(w, h, (g) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#2b1450');
    bg.addColorStop(1, '#4a1f6b');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = i % 2 ? '#ffd76a' : '#ff8fc0';
      g.beginPath();
      g.arc(16 + i * 19.4, 14, 6, 0, 7);
      g.fill();
      g.beginPath();
      g.arc(16 + i * 19.4, h - 14, 6, 0, 7);
      g.fill();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, 'PADDLE PANIC', w - 90, 72, '900');
    g.shadowColor = '#ff9be8';
    g.shadowBlur = 24;
    g.fillStyle = '#fff3ff';
    g.fillText('PADDLE PANIC', w / 2, h * 0.5);
    g.fillText('PADDLE PANIC', w / 2, h * 0.5);
    g.shadowBlur = 0;
  });
}

function texPongScreen() {
  const w = 256, h = 200;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#0d1226';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(120,220,255,0.35)';
    g.lineWidth = 4;
    g.setLineDash([10, 10]);
    g.beginPath();
    g.moveTo(w / 2, 8);
    g.lineTo(w / 2, h - 8);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#8ff0ff';
    g.fillRect(14, 66, 10, 48);
    g.fillStyle = '#ffd76a';
    g.fillRect(w - 24, 96, 10, 48);
    g.beginPath();
    g.arc(w * 0.62, 88, 7, 0, 7);
    g.fillStyle = '#fff';
    g.fill();
    g.font = `bold 30px ${FONT}`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(180,240,255,0.8)';
    g.fillText('3', w * 0.3, 40);
    g.fillText('2', w * 0.7, 40);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 2);
  });
}

function texShuffleTop() {
  const w = 256, h = 1024;
  return canvasTexture(w, h, (g) => {
    const wood = g.createLinearGradient(0, 0, w, 0);
    wood.addColorStop(0, '#e2b57c');
    wood.addColorStop(0.5, '#f0cd9c');
    wood.addColorStop(1, '#dfae74');
    g.fillStyle = wood;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(130,88,44,0.2)';
    g.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      const x = 8 + ((i * 37) % (w - 16));
      g.beginPath();
      g.moveTo(x, 0);
      g.bezierCurveTo(x + 12, h * 0.33, x - 12, h * 0.66, x + 4, h);
      g.stroke();
    }
    const zones = [['3', 60, '#e8657a'], ['2', 190, '#f2b64a'], ['1', 330, '#4fb3e8']];
    for (const [label, y, col] of zones) {
      g.fillStyle = col;
      g.globalAlpha = 0.34;
      g.fillRect(10, y, w - 20, 118);
      g.globalAlpha = 1;
      g.strokeStyle = col;
      g.lineWidth = 7;
      g.strokeRect(10, y, w - 20, 118);
      g.fillStyle = OUTLINE;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `900 74px ${FONT}`;
      g.fillText(label, w / 2, y + 59);
    }
    g.fillStyle = OUTLINE;
    g.globalAlpha = 0.5;
    g.fillRect(10, 470, w - 20, 6);
    g.globalAlpha = 1;
    g.font = `bold 30px ${FONT}`;
    g.textAlign = 'center';
    g.fillStyle = 'rgba(90,58,30,0.55)';
    g.fillText('FOUL LINE', w / 2, 502);
    g.fillText('· · · slide from here · · ·', w / 2, h - 40);
  });
}

function texChessBoard() {
  const S = 512;
  return canvasTexture(S, S, (g) => {
    const c = S / 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? '#8a5a30' : '#f0dcae';
        g.fillRect(x * c, y * c, c, c);
      }
    }
    g.strokeStyle = 'rgba(60,36,14,0.35)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, S - 3, S - 3);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 700; i++) g.fillRect((i * 173) % S, (i * 97) % S, 3, 2);
  });
}

function texFelt() {
  const S = 256;
  return canvasTexture(S, S, (g) => {
    g.fillStyle = '#2f8f52';
    g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(0,0,0,0.06)';
    for (let i = 0; i < 900; i++) g.fillRect((i * 149) % S, (i * 101) % S, 2, 2);
    g.strokeStyle = 'rgba(242,182,74,0.6)';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(S / 2, S / 2, 92, 0, 7);
    g.stroke();
    g.setLineDash([8, 10]);
    g.lineWidth = 3;
    g.beginPath();
    g.arc(S / 2, S / 2, 74, 0, 7);
    g.stroke();
    g.setLineDash([]);
    ['#e8657a', '#4fb3e8', '#f2b64a', '#9b6bd4'].forEach((col, i) => {
      const a = (i / 4) * Math.PI * 2 + 0.78;
      const x = S / 2 + Math.cos(a) * 92, y = S / 2 + Math.sin(a) * 92;
      g.fillStyle = col;
      g.beginPath();
      g.arc(x, y, 17, 0, 7);
      g.fill();
      g.fillStyle = 'rgba(255,246,227,0.85)';
      g.beginPath();
      g.arc(x, y, 8, 0, 7);
      g.fill();
    });
    g.fillStyle = 'rgba(242,182,74,0.75)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 34px ${FONT}`;
    g.fillText('CAPY CLASH', S / 2, S / 2);
  });
}

function texCard() {
  const w = 128, h = 180;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#fffaf0';
    rrect(g, 3, 3, w - 6, h - 6, 12);
    g.fill();
    ink(g, 4);
    g.fillStyle = '#e8657a';
    rrect(g, 12, 12, w - 24, 40, 8);
    g.fill();
    g.fillStyle = '#fff6e3';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 26px ${FONT}`;
    g.fillText('7', w / 2, 33);
    g.fillStyle = '#4fb3e8';
    g.beginPath();
    g.arc(w / 2, h * 0.6, 26, 0, 7);
    g.fill();
    ink(g, 4);
    g.fillStyle = '#f2b64a';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(30 + i * 34, h - 26, 9, 0, 7);
      g.fill();
    }
  });
}

function texCardBack() {
  const w = 128, h = 180;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#8e4f9e';
    rrect(g, 3, 3, w - 6, h - 6, 12);
    g.fill();
    ink(g, 4);
    g.save();
    rrect(g, 6, 6, w - 12, h - 12, 10);
    g.clip();
    g.strokeStyle = 'rgba(255,246,227,0.55)';
    g.lineWidth = 3;
    for (let i = -3; i < 8; i++) {
      g.beginPath();
      g.moveTo(i * 24, 0);
      g.lineTo(i * 24 + h, h);
      g.stroke();
      g.beginPath();
      g.moveTo(i * 24, h);
      g.lineTo(i * 24 + h, 0);
      g.stroke();
    }
    g.restore();
    g.fillStyle = '#f2b64a';
    g.beginPath();
    g.arc(w / 2, h / 2, 24, 0, 7);
    g.fill();
    ink(g, 4);
  });
}

/** Champion portrait, in the art language of the smoothie customers. */
function texPortrait(cfg) {
  const w = 224, h = 264;
  return canvasTexture(w, h, (g) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#fff3d8');
    bg.addColorStop(1, '#eccf9e');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.save();
    g.translate(w / 2, h * 0.46);
    g.scale(w / 215, w / 215);
    g.translate(-100, -100);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    const body = cfg.color;
    const dark = tint(body, -0.24);
    const muzzle = tint(body, 0.22);

    rrect(g, 46, 152, 108, 66, 30);
    g.fillStyle = dark; g.fill(); ink(g, 5);

    for (const ex of [46, 154]) {
      g.beginPath();
      g.ellipse(ex, 48, 20, 17, ex < 100 ? 0.3 : -0.3, 0, 7);
      g.fillStyle = dark; g.fill(); ink(g, 5);
      g.beginPath();
      g.ellipse(ex, 50, 9, 7, 0, 0, 7);
      g.fillStyle = '#e2a3a8'; g.fill();
    }

    rrect(g, 38, 36, 124, 104, 42);
    g.fillStyle = tint(body, 0.06); g.fill(); ink(g, 5.5);

    rrect(g, 58, 96, 84, 58, 26);
    g.fillStyle = muzzle; g.fill(); ink(g, 4.5);

    g.fillStyle = OUTLINE;
    for (const nx of [86, 114]) {
      g.save(); g.translate(nx, 116); g.rotate(nx < 100 ? 0.5 : -0.5);
      g.beginPath(); g.ellipse(0, 0, 3.2, 6, 0, 0, 7); g.fill();
      g.restore();
    }

    g.lineWidth = 4.5; g.strokeStyle = OUTLINE;
    if (cfg.expr === 'beam') {
      g.beginPath();
      g.moveTo(84, 130); g.quadraticCurveTo(100, 148, 116, 130); g.closePath();
      g.fillStyle = '#5c3327'; g.fill(); ink(g, 4);
    } else if (cfg.expr === 'smug') {
      g.beginPath(); g.moveTo(86, 132); g.quadraticCurveTo(100, 142, 116, 126); g.stroke();
    } else {
      g.beginPath(); g.moveTo(88, 130); g.quadraticCurveTo(100, 140, 112, 130); g.stroke();
    }

    for (const ex of [70, 130]) {
      if (cfg.expr === 'beam') {
        g.lineWidth = 5; g.strokeStyle = OUTLINE;
        g.beginPath();
        g.moveTo(ex - 11, 78); g.quadraticCurveTo(ex, 62, ex + 11, 78);
        g.stroke();
      } else if (cfg.expr === 'smug') {
        g.lineWidth = 5; g.strokeStyle = OUTLINE;
        g.beginPath();
        g.moveTo(ex - 12, 70); g.lineTo(ex + 12, 72);
        g.stroke();
        g.beginPath(); g.ellipse(ex, 80, 7, 6, 0, 0, 7);
        g.fillStyle = OUTLINE; g.fill();
      } else {
        g.beginPath(); g.ellipse(ex, 76, 10, 11.5, 0, 0, 7);
        g.fillStyle = OUTLINE; g.fill();
        g.beginPath(); g.arc(ex - 3.4, 72, 3.4, 0, 7);
        g.fillStyle = '#fff'; g.fill();
      }
    }

    g.fillStyle = 'rgba(232,101,122,0.3)';
    g.beginPath(); g.ellipse(52, 104, 13, 8, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(148, 104, 13, 8, 0, 0, 7); g.fill();

    if (cfg.hat === 'crown') {
      g.beginPath();
      g.moveTo(64, 40); g.lineTo(72, 14); g.lineTo(86, 32); g.lineTo(100, 8);
      g.lineTo(114, 32); g.lineTo(128, 14); g.lineTo(136, 40);
      g.closePath();
      g.fillStyle = '#f2b64a'; g.fill(); ink(g, 5);
    } else if (cfg.hat === 'cap') {
      g.beginPath(); g.ellipse(100, 40, 52, 30, 0, Math.PI, 7); g.closePath();
      g.fillStyle = '#4fb3e8'; g.fill(); ink(g, 5);
      g.beginPath(); g.ellipse(132, 42, 34, 10, 0, 0, 7);
      g.fillStyle = tint(0x4fb3e8, -0.2); g.fill(); ink(g, 4);
    } else if (cfg.hat === 'visor') {
      g.beginPath(); g.arc(100, 46, 50, Math.PI * 1.12, Math.PI * 1.88);
      g.lineWidth = 16; g.strokeStyle = '#e8657a'; g.stroke();
      g.beginPath(); g.ellipse(100, 32, 62, 16, 0, Math.PI, 7); g.closePath();
      g.fillStyle = tint(0xe8657a, 0.3); g.fill(); ink(g, 5);
    }
    g.restore();

    g.fillStyle = '#d7a44b';
    rrect(g, w * 0.16, h - 42, w * 0.68, 30, 8);
    g.fill();
    g.strokeStyle = '#8a6320';
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = '#3a2a12';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, cfg.name, w * 0.6, 21, '900');
    g.fillText(cfg.name, w / 2, h - 27);
  });
}

function texBanner(text) {
  const w = 512, h = 128;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#e8657a';
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(w, 0); g.lineTo(w, h * 0.72);
    g.lineTo(w / 2, h); g.lineTo(0, h * 0.72);
    g.closePath();
    g.fill();
    g.strokeStyle = '#f2b64a';
    g.lineWidth = 8;
    g.stroke();
    g.fillStyle = '#fff6e3';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, text, w - 70, 52, '900');
    g.fillText(text, w / 2, h * 0.42);
  });
}

function texCrest() {
  const S = 256;
  return canvasTexture(S, S, (g) => {
    g.fillStyle = '#e9d7ad';
    g.beginPath();
    g.moveTo(S / 2, 14);
    g.lineTo(S - 26, 62);
    g.lineTo(S - 26, 160);
    g.quadraticCurveTo(S / 2, S - 12, 26, 160);
    g.lineTo(26, 62);
    g.closePath();
    g.fill();
    g.strokeStyle = '#8a5a2c';
    g.lineWidth = 10;
    g.stroke();
    g.save();
    g.translate(S / 2, S * 0.54);
    for (const rot of [-0.7, 0.7]) {
      g.save();
      g.rotate(rot);
      g.fillStyle = rot < 0 ? '#b07a4a' : '#e8657a';
      rrect(g, -9, -74, 18, 116, 8);
      g.fill();
      ink(g, 5);
      g.restore();
    }
    g.restore();
    g.fillStyle = '#f2b64a';
    g.beginPath();
    g.arc(S / 2, S * 0.48, 30, 0, 7);
    g.fill();
    ink(g, 6);
    g.fillStyle = '#5b3a1e';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, 'DEN', 46, 27, '900');
    g.fillText('DEN', S / 2, S * 0.48);
    fitFont(g, 'PLAY NICE', 150, 21, 'normal');
    g.fillText('PLAY NICE', S / 2, S * 0.84);
  });
}

/** The brass band across the mantel front, naming each trophy. */
function texMantelBand() {
  const w = 1024, h = 64;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#7a4e2a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#d7a44b';
    rrect(g, 6, 8, w - 12, h - 16, 10);
    g.fill();
    g.strokeStyle = '#8a6320';
    g.lineWidth = 3;
    g.stroke();
    const names = ['PADDLE PANIC', 'SHUFFLE SHOWDOWN', 'GRAND CAPY CHESS', 'FOUR IN A ROW', 'CAPY CLASH'];
    g.fillStyle = '#3a2a12';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    names.forEach((n, i) => {
      fitFont(g, n, 180, 23, '900');
      g.fillText(n, (i + 0.5) * (w / 5), h / 2);
    });
  });
}

function texZ() {
  return canvasTexture(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#fff6e3';
    g.font = `900 52px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('z', 32, 48);
  });
}

function texCocoa() {
  const w = 384, h = 192;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#3d2416';
    rrect(g, 8, 8, w - 16, h - 16, 22);
    g.fill();
    g.strokeStyle = '#d7a44b';
    g.lineWidth = 8;
    g.stroke();
    g.fillStyle = '#ffe7bd';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, 'COCOA BAR', w - 70, 56, '900');
    g.fillText('COCOA BAR', w / 2, h * 0.38);
    g.fillStyle = '#f2b64a';
    const sub = 'straight off the mountain, marshmallows extra';
    fitFont(g, sub, w - 60, 24, 'normal');
    g.fillText(sub, w / 2, h * 0.72);
  });
}

function texScoreboard() {
  const w = 256, h = 192;
  return canvasTexture(w, h, (g) => {
    g.fillStyle = '#24301f';
    rrect(g, 6, 6, w - 12, h - 12, 14);
    g.fill();
    g.strokeStyle = '#c8b48a';
    g.lineWidth = 6;
    g.stroke();
    g.fillStyle = '#e9f2dc';
    g.textAlign = 'center';
    g.font = `900 26px ${FONT}`;
    g.fillText('HOUSE   YOU', w / 2, 40);
    g.font = `900 62px ${FONT}`;
    g.fillStyle = '#f2b64a';
    g.fillText('11', w * 0.28, 110);
    g.fillStyle = '#8ff0ff';
    g.fillText('9', w * 0.72, 110);
    g.strokeStyle = 'rgba(233,242,220,0.5)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(w / 2, 60);
    g.lineTo(w / 2, 130);
    g.stroke();
    g.fillStyle = 'rgba(233,242,220,0.7)';
    g.font = `bold 20px ${FONT}`;
    g.fillText('best of fifteen', w / 2, 162);
  });
}

// ===========================================================================
export class LoungeRoom extends Room {
  id = 'lounge';
  name = 'The Game Den';

  build(scene, game) {
    this.t = 0;
    this._d = new THREE.Object3D();
    this._col = new THREE.Color();
    this._mA = new THREE.Matrix4();
    this._mB = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._game = game;
    const rand = rng(70415);

    // --- table state (see the header note for the wire protocol) ------------
    this._tables = new Map();   // gameId -> [{id,name}, ...] as the server sees it
    this._seated = new Map();   // playerId -> { avatar, tag, hidden, game, slot }
    this._chips = new Map();    // gameId -> { tex, mesh, state }
    this._sitSpots = new Map(); // gameId -> hotspot, so labels can be repainted
    this._localTable = null;
    this._localSeat = 0;
    this._offTable = null;
    this._offMatchStart = null;
    this._wasOnline = !!game?.net?.connected;
    this._reconcileT = 0;

    const grad = makeToon(0xffffff).gradientMap;
    this._toonMap = (map, color = 0xffffff, extra = {}) =>
      new THREE.MeshToonMaterial({ color, map, gradientMap: grad, ...extra });
    this._flat = (map, extra = {}) => new THREE.MeshBasicMaterial({ map, ...extra });

    scene.background = new THREE.Color(0x2b1e14);
    scene.fog = new THREE.Fog(0x3a2a1c, 34, 78);

    const B = {
      box: new Batch(new THREE.BoxGeometry(1, 1, 1)),
      boxFlat: new Batch(new THREE.BoxGeometry(1, 1, 1)),
      cyl: new Batch(new THREE.CylinderGeometry(0.5, 0.5, 1, 14)),
      cyl8: new Batch(new THREE.CylinderGeometry(0.5, 0.5, 1, 8)),
      ball: new Batch(new THREE.SphereGeometry(0.5, 12, 9)),
      bead: new Batch(new THREE.SphereGeometry(0.5, 8, 6)),
      cone: new Batch(new THREE.ConeGeometry(0.5, 1, 10)),
    };

    this._buildShell(scene, B);
    this._buildLights(scene);
    this._buildCeiling(scene, B);
    this._buildFireplace(scene, B, rand);
    this._buildStations(scene, B);
    this._buildSeating(scene, B, rand);
    this._buildBar(scene, B);
    this._buildDecor(scene, B, rand);
    this._buildEntrance(scene, B);

    B.box.build(scene, true, true);
    B.boxFlat.build(scene, false, true);
    B.cyl.build(scene, true, true);
    B.cyl8.build(scene, true, true);
    B.ball.build(scene, true, true);
    B.bead.build(scene, false, true);
    B.cone.build(scene, true, true);

    // --- navigation ---------------------------------------------------------
    // The den is a room inside the peak's ski lodge, so the only door leads back
    // out onto the mountain. Both spawns sit 3.0 / 2.0 short of that door,
    // outside its 1.9 prompt radius, so arriving does not pop "back outside"
    // over your head; both look straight up the room at the fireplace.
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 5),
      from_peak: new THREE.Vector3(0, 0, 6),
    };
    this.cameraHint = { offset: new THREE.Vector3(0, 10.5, 13.5), lookHeight: 1 };

    // Two prompts per station: sit down at the real table, or play the house.
    // Solo runs always clear __matchCtx first, so a match that never started
    // can never turn a later solo run into a phantom duel.
    for (const s of STATIONS) {
      const sit = {
        id: `sit-${s.id}`,
        position: new THREE.Vector3(s.hs[0], 0, s.hs[1]),
        radius: 1.9,
        label: this._sitLabel(s),
        action: (g) => this._onSit(g, s),
      };
      this.hotspots.push(sit);
      this._sitSpots.set(s.id, sit);
      this.hotspots.push({
        id: `play-${s.id}`,
        position: new THREE.Vector3(s.aiAt[0], 0, s.aiAt[1]),
        radius: 1.6,
        label: `Play vs ${s.ai}`,
        action: (g) => { g.__matchCtx = null; g.startMinigame(s.id); },
      });
    }
    this.hotspots.push({
      id: 'exit-peak',
      position: new THREE.Vector3(0, 0, 8),
      radius: 1.9,
      label: 'Back out to Frosty Peak',
      action: (g) => g.goToRoom('peak', 'lounge'),
    });

    // Live only while this room is: both handles are dropped in dispose().
    if (game?.events?.on) {
      this._offTable = game.events.on('table', (m) => this._onTable(m));
      this._offMatchStart = game.events.on('match-start', (m) => this._onMatchStart(m));
    }
    for (const s of STATIONS) this._paintChip(s.id);
  }

  /* --- tables: prompts ----------------------------------------------------- */

  /** The sit-down prompt reads the table it belongs to. */
  _sitLabel(s) {
    if (!this._game?.net?.connected) return s.label; // offline: the house is all there is
    if (this._localTable === s.id) return 'Stand up';
    const n = (this._tables?.get(s.id) || []).length;
    return `Challenge: sit down (${n}/2)`;
  }

  /**
   * Push the labels onto the prompts. The engine writes textContent once, when
   * it spawns the button, so a live label has to patch the element in place.
   */
  _refreshLabels() {
    if (!this._sitSpots) return;
    for (const s of STATIONS) {
      const spot = this._sitSpots.get(s.id);
      if (!spot) continue;
      const label = this._sitLabel(s);
      if (label === spot.label) continue;
      spot.label = label;
      const el = this._game?.engine?.hotspotEls?.get?.(spot);
      if (el) el.textContent = label;
    }
  }

  /** Sit down, stand up, or (offline) just play the house. */
  _onSit(g, s) {
    if (!g?.net?.connected) {
      g.__matchCtx = null;
      g.startMinigame(s.id);
      return;
    }
    if (this._localTable === s.id) {
      g.net.send({ t: 'table-leave' });
      return;
    }
    // the server would drop a join at a full table on the floor, and a prompt
    // that does nothing at all feels broken
    if ((this._tables?.get(s.id) || []).length >= s.seats.length) {
      g.toast?.('Both chairs are taken. Watch the duel, or start one of your own!');
      return;
    }
    // one table at a time, so hopping across the room gives up the old chair
    // first. Two frames back to back sit well inside the server's social budget.
    if (this._localTable) g.net.send({ t: 'table-leave' });
    g.net.send({ t: 'table-join', game: s.id });
  }

  /* --- tables: server state ------------------------------------------------ */

  /** Server->client 'table': {game, players:[{id,name}]}, one board at a time. */
  _onTable(m) {
    if (!m || !this._tables) return;
    const rows = Array.isArray(m.tables) ? m.tables : [m];
    for (const row of rows) this._applyTable(row);
  }

  _applyTable(row) {
    const s = STATION_BY_ID.get(row?.game);
    if (!s) return;
    const players = Array.isArray(row.players) ? row.players.slice(0, s.seats.length) : [];
    this._tables.set(s.id, players);

    const selfId = this._game?.net?.selfId ?? null;
    const seen = new Set();
    let localSeat = null;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.id === undefined || p.id === null) continue;
      if (selfId !== null && p.id === selfId) { localSeat = i; continue; }
      seen.add(p.id);
      this._seatRemote(p.id, p.name, s, i);
    }
    for (const [id, r] of [...this._seated]) {
      if (r.game === s.id && !seen.has(id)) this._unseat(id);
    }

    if (localSeat !== null) this._setLocalTable(s.id, localSeat);
    else if (this._localTable === s.id) this._setLocalTable(null, 0);

    this._paintChip(s.id);
    this._refreshLabels();
  }

  /** Put a remote challenger in their chair. */
  _seatRemote(id, name, s, slot) {
    const existing = this._seated.get(id);
    if (existing) {
      if (existing.game === s.id && existing.slot === slot) return;
      this._unseat(id);
    }
    const seat = s.seats[slot];
    if (!seat || !this._seatGroup) return;
    const game = this._game;
    const remote = game?.net?.remotes?.get?.(id) || null;
    const avatar = createAvatar({
      color: remote?.p?.color ?? DEFAULT_FUR,
      hat: remote?.p?.hat ?? 'none',
    });
    avatar.setAnim('sit');
    avatar.group.position.set(seat[0], SEAT_Y, seat[1]);
    avatar.group.rotation.y = seatYaw(s, slot);
    this._seatGroup.add(avatar.group);

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
    this._seated.set(id, { avatar, tag, hidden, game: s.id, slot });
    game?.audio?.play?.('pop');
  }

  _unseat(id) {
    const r = this._seated.get(id);
    if (!r) return;
    this._seated.delete(id);
    r.tag?.remove?.();
    this._seatGroup?.remove(r.avatar.group);
    r.avatar.dispose();
    this._restoreRemote(id, r.hidden);
  }

  /** Late-bind seats to their networked record: real fur, real hat, no double. */
  _reconcileSeats() {
    const remotes = this._game?.net?.remotes;
    if (!remotes?.get) return;
    for (const [id, r] of this._seated) {
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

  /** Walk the local capybara into (or out of) their chair. */
  _setLocalTable(id, slot) {
    if (id === this._localTable && slot === this._localSeat) return;
    const game = this._game;
    const engine = game?.engine;
    const avatar = engine?.playerAvatar;
    const s = id ? STATION_BY_ID.get(id) : null;
    const seat = s?.seats[slot];
    this._localTable = id;
    this._localSeat = slot;
    if (seat) {
      engine?.controller?.setTarget(this._v.set(seat[0], 0, seat[1]));
      game?.audio?.play?.('whoosh');
      game?.toast?.(`You take a chair at ${s.name.toLowerCase()}. Waiting for a rival!`);
    } else if (avatar) {
      if (avatar.state.anim === 'sit') avatar.setAnim('idle');
      engine?.snapY?.(avatar.group.position, this);
      game?.audio?.play?.('click');
    }
  }

  /** Server->client 'match-start': stash the ctx, then launch the duel. */
  _onMatchStart(m) {
    const game = this._game;
    if (!game || !m || !STATION_BY_ID.has(m.game)) return;
    const players = Array.isArray(m.players) ? m.players : [];
    const selfId = game.net?.selfId ?? null;
    const mine = this._localTable === m.game
      || (selfId !== null && players.some((p) => p?.id === selfId));
    if (!mine) return;

    // Already inside a minigame (a solo run started from the house prompt while
    // the table filled): startMinigame would no-op and the ctx would sit there
    // waiting to turn some later solo run into a phantom duel. Bow out loudly
    // instead, which forfeits and pays the capy who did show up.
    if (game.activeMinigame) {
      game.net?.send?.({ t: 'table-leave' });
      game.toast?.('Your rival sat down while you were mid-game: the table went to them!');
      return;
    }
    game.__matchCtx = {
      game: m.game,
      players,
      youAre: Number(m.youAre) === 1 ? 1 : 0,
      seed: Number(m.seed) || 0,
    };
    const foe = players[Number(m.youAre) === 1 ? 0 : 1];
    game.toast?.(`${foe?.name || 'A challenger'} sits down opposite you. Play!`);
    game.startMinigame(m.game);
  }

  /** Repaint one station's status chip from whatever the server last said. */
  _paintChip(id) {
    const c = this._chips?.get(id);
    const cv = c?.tex?.image;
    if (!cv?.getContext) return;
    const players = this._tables?.get(id) || [];
    let state = 'open', text = 'OPEN';
    if (!this._game?.net?.connected) { state = 'solo'; text = 'PLAY THE HOUSE'; }
    else if (players.length >= 2) { state = 'live'; text = 'MATCH LIVE'; }
    else if (players.length === 1) {
      state = 'waiting';
      text = `${shortName(players[0]?.name)} waits a rival!`;
    }
    paintChip(cv.getContext('2d'), cv.width, cv.height, state, text);
    c.tex.needsUpdate = true;
    c.state = state;
  }

  /** Empty every chair (the connection went away, or the room is going away). */
  _clearTables() {
    for (const id of [...this._seated.keys()]) this._unseat(id);
    this._tables?.clear();
    this._setLocalTable(null, 0);
    this._refreshLabels();
  }

  // -------------------------------------------------------------------------
  // floor, walls, windows, the mountainside beyond them
  // -------------------------------------------------------------------------
  _buildShell(scene, B) {
    const { box, boxFlat, cyl, ball, bead, cone } = B;

    // pale sky and snowfield outside, so a peek past a wall never shows the void
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(70, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xc3dcf1, side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);
    const snowfield = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), makeToon(PAL.snow));
    snowfield.rotation.x = -Math.PI / 2;
    snowfield.position.y = -0.06;
    scene.add(snowfield);

    // the plank floor: the only walkable surface
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * HW, ZS - ZN), this._toonMap(texPlanks()));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = (ZN + ZS) / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.groundMeshes = [floor];

    // Decking beyond the door: the lodge's swept porch, snow banked up either
    // side of it. Not walkable, but it fills the bottom third of the frame
    // whenever a player heads for the exit, so it gets real boards and an edge
    // rather than one flat slab of brown.
    const deckTex = texPlanks();
    deckTex.repeat.set(7, 2.4);
    const porch = new THREE.Mesh(new THREE.PlaneGeometry(2 * HW + 3, 7), this._toonMap(deckTex, 0xe0b483));
    porch.rotation.x = -Math.PI / 2;
    porch.position.set(0, 0.004, ZS + 3.4);
    porch.receiveShadow = true;
    scene.add(porch);
    box.add(PAL.wood, 0, 0.07, ZS + 0.15, 2 * HW + 3, 0.16, 0.5);
    box.add(PAL.woodMid, 0, 0.05, ZS + 6.7, 2 * HW + 3, 0.14, 0.5);
    box.add(PAL.snow, 0, 0.12, ZS + 7.3, 2 * HW + 6, 0.34, 1.2);
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * (HW + 1.3), 0.05, ZS + 3.4, 0.4, 0.14, 7);
      box.add(PAL.snow, sx * (HW + 1.3), 0.14, ZS + 3.4, 0.46, 0.14, 7);
      cyl.add(PAL.wood, sx * (HW + 1.1), 0.7, ZS + 1.2, 0.3, 1.4, 0.3);
      bead.add(0xffd489, sx * (HW + 1.1), 1.5, ZS + 1.2, 0.34, 0.36, 0.34);
      // snowy pines banked in the drifts either side of the steps
      for (let i = 0; i < 3; i++) {
        cone.add(i % 2 ? PAL.pine : PAL.pineDark, sx * (HW + 0.6), 0.6 + i * 0.1, ZS + 3.2 + i * 0.5,
          0.5, 1.1, 0.5, 0.2, i, 0.15);
        cone.add(PAL.snow, sx * (HW + 0.6), 0.98 + i * 0.1, ZS + 3.24 + i * 0.5,
          0.26, 0.4, 0.26, 0.2, i, 0.15);
      }
      ball.add(PAL.snowShade, sx * (HW + 1.9), 0.16, ZS + 5.2, 2.4, 0.5, 2.0);
    }

    // --- walls, with the window openings punched clean through -------------
    const wallMat = makeToon(PAL.wall);
    const mkWall = (width, holes) => {
      const s = new THREE.Shape();
      s.moveTo(-width / 2, 0);
      s.lineTo(width / 2, 0);
      s.lineTo(width / 2, WALL_H);
      s.lineTo(-width / 2, WALL_H);
      s.closePath();
      for (const [x0, x1] of holes) {
        const p = new THREE.Path();
        p.moveTo(x0, WIN_LO);
        p.lineTo(x1, WIN_LO);
        p.lineTo(x1, WIN_HI);
        p.lineTo(x0, WIN_HI);
        p.closePath();
        s.holes.push(p);
      }
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.36, bevelEnabled: false });
      geo.translate(0, 0, -0.36);
      const m = new THREE.Mesh(geo, wallMat);
      m.receiveShadow = true;
      scene.add(m);
      return m;
    };

    const north = mkWall(2 * HW + 1, []);
    north.position.z = ZN;
    // Side walls carry the same world-z openings. Wall-local +x maps to world
    // -z on the west and +z on the east, so the west holes are mirrored.
    const west = mkWall(ZS - ZN + 0.8, WINZ.map(([a, b]) => [-b, -a]));
    west.rotation.y = Math.PI / 2;
    west.position.set(-HW, 0, 0);
    const east = mkWall(ZS - ZN + 0.8, WINZ.map(([a, b]) => [a, b]));
    east.rotation.y = -Math.PI / 2;
    east.position.set(HW, 0, 0);

    // the painted mountainside, hung just outside each run of glass
    for (const s of [-1, 1]) {
      const v = new THREE.Mesh(new THREE.PlaneGeometry(15, 5.6), this._flat(texAlps(s > 0)));
      v.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      v.position.set(s * (HW + 0.8), 3.4, 2.4);
      scene.add(v);
    }

    // frames, sills, mullions, sill plants
    const midY = (WIN_LO + WIN_HI) / 2;
    for (const s of [-1, 1]) {
      for (const [z0, z1] of WINZ) {
        const cz = (z0 + z1) / 2, len = z1 - z0;
        const wx = s * (HW - 0.14);
        boxFlat.add(PAL.cream, wx, WIN_HI + 0.1, cz, 0.36, 0.2, len + 0.4);
        boxFlat.add(PAL.cream, wx, WIN_LO - 0.1, cz, 0.36, 0.2, len + 0.4);
        boxFlat.add(PAL.cream, wx, midY, cz - len / 2, 0.36, WIN_HI - WIN_LO, 0.2);
        boxFlat.add(PAL.cream, wx, midY, cz + len / 2, 0.36, WIN_HI - WIN_LO, 0.2);
        boxFlat.add(PAL.cream, wx, midY, cz, 0.28, WIN_HI - WIN_LO, 0.12);
        boxFlat.add(PAL.cream, wx, midY, cz, 0.28, 0.12, len);
        box.add(PAL.woodLight, s * (HW - 0.34), WIN_LO - 0.16, cz, 0.62, 0.16, len + 0.5);
        for (let i = 0; i < 3; i++) {
          ball.add(i % 2 ? PAL.leaf : PAL.leafDark, s * (HW - 0.42), WIN_LO + 0.1,
            cz - len / 3 + i * (len / 3), 0.52, 0.36, 0.52);
        }
      }
    }

    // wainscot, chair rail, top plate
    const runs = [
      [0, ZN + 0.1, 2 * HW, 0.2],
      [-HW + 0.1, 0, 0.2, ZS - ZN],
      [HW - 0.1, 0, 0.2, ZS - ZN],
    ];
    for (const [x, z, sx, sz] of runs) {
      boxFlat.add(PAL.wainscot, x, 0.62, z, sx, 1.24, sz);
      boxFlat.add(PAL.woodLight, x, 1.3, z, sx + 0.08, 0.16, sz + 0.08);
      boxFlat.add(PAL.wood, x, WALL_H - 0.22, z, sx + 0.08, 0.34, sz + 0.08);
      boxFlat.add(PAL.coral, x, 5.05, z, sx, 0.1, sz);
    }
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * (HW - 0.2), WALL_H / 2, ZN + 0.2, 0.4, WALL_H, 0.4);
      box.add(PAL.wood, sx * (HW - 0.2), WALL_H / 2, ZS - 0.24, 0.4, WALL_H, 0.4);
    }
  }

  // -------------------------------------------------------------------------
  _buildLights(scene) {
    scene.add(new THREE.HemisphereLight(0xffe3ba, 0x5a3c24, 0.5));
    scene.add(new THREE.AmbientLight(0xffeacd, 0.24));

    for (const [x, y, z, col, i, dist] of [
      [0, 4.2, -2.2, 0xffd8a4, 16, 15],
      [-7.4, 3.6, 3.6, 0xffcf9a, 13, 13],
      [7.4, 3.6, 3.6, 0xffd6a8, 13, 13],
      [-8.4, 3.4, -4.6, 0xffc890, 11, 12],
      [8.4, 3.4, -4.6, 0xffc890, 11, 12],
      // no sixth fill by the door: daylight through the opening covers it, and
      // toon shading pays for every extra point light
    ]) {
      const p = new THREE.PointLight(col, i, dist, 2);
      p.position.set(x, y, z);
      scene.add(p);
    }

    // one sun raking in through the west windows
    const sun = new THREE.DirectionalLight(0xffe2b4, 0.75);
    sun.position.set(-16, 15, 11);
    sun.target.position.set(1, 0, -3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -13;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 55;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);
  }

  // -------------------------------------------------------------------------
  // Boarded ceiling and truss over the NORTH end only, plus string lights.
  //
  // The first cut ran rafters down both side bays and they were a disaster:
  // the camera sits 10.5 up and 13.5 back, so its line to the player crosses
  // y = 5.5 about 6.4 units south of wherever the player stands. Walk to the
  // pong cabinet or the shuffleboard and you are looking at the player through
  // three beams. Everything overhead therefore stops at z = CEIL_S: for any
  // reachable spot (the fireplace mass blocks past z = -6.6) that crossing
  // lands south of the boards, so nothing up here can ever come between the
  // camera and a player again.
  // -------------------------------------------------------------------------
  _buildCeiling(scene, B) {
    const { boxFlat, bead } = B;
    const CEIL_S = 0.5;

    const deck = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * HW, CEIL_S - ZN),
      makeToon(PAL.woodMid),
    );
    deck.rotation.x = Math.PI / 2; // faces down into the room
    deck.position.set(0, WALL_H, (ZN + CEIL_S) / 2);
    scene.add(deck);
    // truss under the boards, and the transverse beam that ends them
    for (const z of [-6.2, -4.8, -3.4, -2.0, -0.6]) {
      boxFlat.add(PAL.wood, 0, RAFT_Y + 0.4, z, 2 * HW, 0.24, 0.34);
    }
    for (const x of [-5.5, 5.5]) {
      boxFlat.add(PAL.woodLight, x, RAFT_Y + 0.62, (ZN + CEIL_S) / 2, 0.26, 0.26, CEIL_S - ZN);
    }
    boxFlat.add(PAL.wood, 0, WALL_H - 0.3, CEIL_S, 2 * HW, 0.6, 0.5);

    // three runs of string lights sagging along the walls
    const bulbs = [], cord = [];
    for (const [x0, z0, x1, z1] of [
      [-10.4, -6.2, -10.4, 8.2], [10.4, -6.2, 10.4, 8.2], [-10.4, 8.2, 10.4, 8.2],
    ]) {
      const n = 16;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = [x0 + (x1 - x0) * u, 4.6 - Math.abs(Math.sin(u * Math.PI * 4)) * 0.18, z0 + (z1 - z0) * u];
        if (prev) cord.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
        prev = p;
        if (i % 2 === 0) bulbs.push(p);
      }
    }
    const cordGeo = new THREE.BufferGeometry();
    cordGeo.setAttribute('position', new THREE.Float32BufferAttribute(cord, 3));
    scene.add(new THREE.LineSegments(cordGeo, new THREE.LineBasicMaterial({ color: 0x5a4028 })));

    const bulbMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.1, 8, 6), makeGlow(0xffffff, { unique: true }), bulbs.length,
    );
    const d = new THREE.Object3D();
    const c = new THREE.Color(0xffd489);
    this._bulbSeed = [];
    bulbs.forEach((p, i) => {
      d.position.set(p[0], p[1] - 0.15, p[2]);
      d.updateMatrix();
      bulbMesh.setMatrixAt(i, d.matrix);
      bulbMesh.setColorAt(i, c);
      this._bulbSeed.push((i * 2.399) % 6.283); // deterministic: same every visit
      bead.add(0x5a4028, p[0], p[1] - 0.04, p[2], 0.08, 0.14, 0.08);
    });
    bulbMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(bulbMesh);
    this._bulbs = bulbMesh;
  }

  // -------------------------------------------------------------------------
  // THE STAR: grand stone fireplace, live flames, trophy shelf on the mantel.
  // Heights are deliberately low-slung: from the default spawn the camera
  // frames down to about 14 degrees below level, and a taller mantel would put
  // the trophies off the top of the shot on arrival.
  // -------------------------------------------------------------------------
  _buildFireplace(scene, B, rand) {
    const { box, boxFlat, cyl, cyl8, ball, bead, cone } = B;
    const OPEN_HW = 1.7, OPEN_TOP = 2.0;

    // chunky coursed stonework, opening left hollow
    for (let row = 0; row < 7; row++) {
      const y = 0.32 + row * 0.62;
      let x = -3.2;
      while (x < 3.2) {
        const w = 0.66 + rand() * 0.5;
        const inOpening = y < OPEN_TOP && x + w > -OPEN_HW && x < OPEN_HW;
        if (!inOpening) {
          const tone = [PAL.stone, PAL.stoneMid, PAL.stoneDark][(row + ((x * 3) | 0) + 9) % 3];
          box.add(tone, x + w / 2, y, FZ, w, 0.58, 1.2);
        }
        x += w + 0.04;
      }
    }
    // arch across the opening
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * (0.06 + (i / 10) * 0.88);
      box.add(i % 2 ? PAL.stone : PAL.stoneMid,
        Math.cos(a) * 1.95, 1.85 + Math.sin(a) * 0.62, FZ,
        0.42, 0.5, 1.24, 0, 0, -(a - Math.PI / 2) * 0.55);
    }
    // dark firebox behind, so the opening reads as depth not a painted panel
    boxFlat.add(0x21150c, 0, 1.0, -6.9, 3.5, 2.2, 0.9);
    box.add(PAL.stoneDark, 0, 0.09, -6.4, 3.6, 0.18, 1.0);

    // logs and ash, sitting proud of the dark so the firelight catches them
    cyl8.add(PAL.wood, -0.45, 0.3, -6.3, 0.34, 1.5, 0.34, Math.PI / 2, 0.28, 0);
    cyl8.add(PAL.wood, 0.45, 0.3, -6.32, 0.34, 1.5, 0.34, Math.PI / 2, -0.3, 0);
    cyl8.add(PAL.woodMid, 0, 0.5, -6.2, 0.3, 1.3, 0.3, Math.PI / 2, 0.1, 0);
    bead.add(0x54483a, 0, 0.16, -6.24, 2.6, 0.24, 0.8);

    // nine flame tongues, driven per frame
    const flames = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.5, 1, 8), makeGlow(0xffffff, { unique: true }), 9,
    );
    const fc = new THREE.Color(PAL.flame);
    const d = new THREE.Object3D();
    this._flameData = [];
    for (let i = 0; i < 9; i++) {
      this._flameData.push({
        x: -0.85 + (i % 5) * 0.42 + (rand() - 0.5) * 0.16,
        z: -6.35 + ((i / 5) | 0) * 0.26,
        s: 0.5 + rand() * 0.6, ph: rand() * 6.28, sp: 2.4 + rand() * 2.6,
      });
      d.position.set(0, -9, 0);
      d.updateMatrix();
      flames.setMatrixAt(i, d.matrix);
      flames.setColorAt(i, fc);
    }
    flames.instanceColor.setUsage(THREE.DynamicDrawUsage);
    flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // every instance starts parked at (0,-9,0); the bounds three caches from
    // that would cull the whole batch once the flames move up into the firebox
    flames.frustumCulled = false;
    scene.add(flames);
    this._flames = flames;

    const emberMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.055, 6, 4), makeGlow(0xffb057, { unique: true }), 14,
    );
    this._emberData = [];
    for (let i = 0; i < 14; i++) {
      this._emberData.push({ t: rand(), sp: 0.35 + rand() * 0.4, x: (rand() - 0.5) * 1.6, ph: rand() * 6.28 });
      d.position.set(0, -9, 0);
      d.updateMatrix();
      emberMesh.setMatrixAt(i, d.matrix);
    }
    emberMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    emberMesh.frustumCulled = false;
    scene.add(emberMesh);
    this._embers = emberMesh;

    const fireLight = new THREE.PointLight(PAL.ember, 24, 17, 2);
    fireLight.position.set(0, 1.0, -6.0);
    scene.add(fireLight);
    this._fireLight = fireLight;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.3, 2.0),
      new THREE.MeshBasicMaterial({ color: 0xff9c46, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    glow.position.set(0, 1.0, -6.42);
    scene.add(glow);
    this._fireGlow = glow;

    // hearth apron, fire irons, log basket
    box.add(PAL.stoneDark, 0, 0.09, -5.4, 6.0, 0.18, 1.5);
    box.add(PAL.stone, 0, 0.2, -5.4, 5.7, 0.1, 1.3);
    for (const [ix, lean] of [[-2.5, 0.12], [-2.32, -0.1]]) {
      cyl8.add(PAL.steel, ix, 0.6, -5.3, 0.07, 1.2, 0.07, 0, 0, lean);
      bead.add(PAL.brass, ix, 1.24, -5.3, 0.16, 0.16, 0.16);
    }
    cyl.add(PAL.woodMid, 2.6, 0.34, -5.3, 1.1, 0.66, 1.1);
    for (let i = 0; i < 5; i++) {
      cyl8.add(PAL.wood, 2.6 + (i % 2 ? 0.16 : -0.16), 0.62 + i * 0.1, -5.3 + ((i % 3) - 1) * 0.14,
        0.2, 0.9, 0.2, Math.PI / 2, i * 0.5, 0);
    }

    // --- mantel + trophy shelf ---------------------------------------------
    box.add(PAL.wood, 0, 2.62, -6.1, 7.0, 0.4, 1.9);
    box.add(PAL.woodLight, 0, 2.87, -6.1, 7.2, 0.1, 2.0);
    const band = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 0.28), this._flat(texMantelBand()));
    band.position.set(0, 2.62, -5.14);
    scene.add(band);

    // One little gold capy per minigame, echoing the avatar's proportions in
    // miniature. Five trophies of nine parts each would be 45 draw calls, so
    // the parts are instanced across all five and their matrices recomposed
    // per frame from the parent trophy transform: four draw calls instead.
    const gold = makeToon(PAL.gold);
    const goldD = makeToon(PAL.brass);
    const trophyKinds = [
      { geo: new THREE.BoxGeometry(1, 1, 1), mat: goldD, parts: [[0, 0.05, 0, 0.44, 0.1, 0.36, 0]] },
      { geo: new THREE.CylinderGeometry(0.5, 0.7, 1, 10), mat: goldD, parts: [[0, 0.18, 0, 0.28, 0.18, 0.28, 0]] },
      {
        geo: new THREE.SphereGeometry(0.5, 10, 8),
        mat: gold,
        parts: [
          [0, 0.42, 0, 0.42, 0.34, 0.38, 0],      // barrel
          [0, 0.6, 0.1, 0.3, 0.28, 0.28, 0],      // head
          [0, 0.56, 0.22, 0.17, 0.14, 0.16, 0],   // snout
          [-0.11, 0.72, 0.07, 0.11, 0.11, 0.11, 0],
          [0.11, 0.72, 0.07, 0.11, 0.11, 0.11, 0],
        ],
      },
      {
        geo: new THREE.TorusGeometry(0.08, 0.022, 5, 10),
        mat: goldD,
        parts: [[-0.16, 0.3, 0, 1, 1, 1, Math.PI / 2], [0.16, 0.3, 0, 1, 1, 1, Math.PI / 2]],
      },
    ];
    this._trophyAt = [];
    for (let i = 0; i < 5; i++) this._trophyAt.push([-2.6 + i * 1.3, 2.92, -5.8]);
    this._trophy = [];
    for (const k of trophyKinds) {
      const locals = k.parts.map((p) => {
        const o = new THREE.Object3D();
        o.position.set(p[0], p[1], p[2]);
        o.scale.set(p[3], p[4], p[5]);
        o.rotation.y = p[6];
        o.updateMatrix();
        return o.matrix.clone();
      });
      const im = new THREE.InstancedMesh(k.geo, k.mat, locals.length * 5);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = true;
      im.frustumCulled = false;
      scene.add(im);
      this._trophy.push({ mesh: im, locals });
    }

    // chimney breast + crest
    box.add(PAL.stoneMid, 0, 4.8, -6.6, 2.6, 3.6, 1.0);
    box.add(PAL.stone, 0, 6.45, -6.6, 2.9, 0.3, 1.2);
    const crest = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), this._flat(texCrest()));
    crest.position.set(0, 4.4, -6.08);
    scene.add(crest);
    for (const s of [-1, 1]) {
      cone.add(PAL.brass, s * 1.6, 4.0, -6.05, 0.28, 0.42, 0.28, Math.PI, 0, 0);
      bead.add(0xffe0a8, s * 1.6, 3.76, -6.05, 0.24, 0.24, 0.24);
    }

    this.obstacles.push(
      { x: 0, z: -6.5, r: 2.3 },
      { x: -2.6, z: -6.5, r: 1.4 },
      { x: 2.6, z: -6.5, r: 1.4 },
      { x: 0, z: -5.4, r: 1.2 },
    );
  }

  // -------------------------------------------------------------------------
  // the five game stations
  // -------------------------------------------------------------------------
  _buildStations(scene, B) {
    this._rings = [];
    this._pong(scene, B, STATIONS[0]);
    this._shuffle(scene, B, STATIONS[1]);
    this._cards(scene, B, STATIONS[2]);
    this._chess(scene, B, STATIONS[3]);
    this._connect4(scene, B, STATIONS[4]);

    // Seated challengers get their own group so dispose() can empty it without
    // hunting through the scene graph.
    this._seatGroup = new THREE.Group();
    scene.add(this._seatGroup);

    const { box, cyl, bead } = B;
    for (const s of STATIONS) {
      // two chairs per station, both looking at the game they belong to
      for (let i = 0; i < s.seats.length; i++) {
        this._chair(B, s.seats[i][0], s.seats[i][1], seatYaw(s, i), i ? PAL.leather : PAL.coral);
      }

      // Sign post, turned to face the room camera rather than its own wall.
      // Post, backer and finial ride the shared batches; only the painted face
      // and the live status chip need meshes of their own, because only they
      // carry a canvas nobody else shares.
      const [sx, sz] = s.sign;
      const yaw = Math.atan2(-sx, 12 - sz);
      const nx = Math.sin(yaw), nz = Math.cos(yaw);
      cyl.add(PAL.wood, sx, 1.25, sz, 0.18, 2.5, 0.18);
      box.add(PAL.woodMid, sx, 2.42, sz, 1.86, 0.74, 0.1, 0, yaw, 0);
      bead.add(PAL.gold, sx, 2.88, sz, 0.22, 0.22, 0.22);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.76, 0.66), this._flat(texSign(s.name, s.sub)));
      face.position.set(sx + nx * 0.07, 2.42, sz + nz * 0.07);
      face.rotation.y = yaw;
      scene.add(face);

      // the chip hangs off the bottom of the board on two little brass hooks
      box.add(PAL.woodMid, sx, 1.86, sz, 1.6, 0.44, 0.09, 0, yaw, 0);
      for (const hx of [-0.62, 0.62]) {
        bead.add(PAL.brass, sx + Math.cos(yaw) * hx, 2.05, sz - Math.sin(yaw) * hx, 0.1, 0.16, 0.1);
      }
      const tex = texChip();
      const chip = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 0.375),
        this._flat(tex, { transparent: true, depthWrite: false }),
      );
      chip.position.set(sx + nx * 0.075, 1.86, sz + nz * 0.075);
      chip.rotation.y = yaw;
      scene.add(chip);
      this._chips.set(s.id, { tex, mesh: chip, state: 'open' });

      // glowing rings on the floor where each prompt fires: gold for the table
      // you can sit at, a smaller cool one for the house opponent
      this._rings.push(this._ring(scene, s.hs, 0.9, 1.24, 0xffd489, 0.42));
      this._rings.push(this._ring(scene, s.aiAt, 0.5, 0.76, 0x8fd8ff, 0.3));
    }
  }

  /** Pulsing prompt marker on the boards. */
  _ring(scene, at, r0, r1, color, opacity) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r0, r1, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at[0], 0.018, at[1]);
    scene.add(ring);
    return ring;
  }

  /**
   * A station chair: pad, cushion, four splayed legs and a slatted back, all on
   * the shared batches. Local space is built facing +z and rotated into place,
   * so `yaw` is the direction the sitter looks. No obstacle circle: a collider
   * here would shove the local player straight back out of their own seat.
   */
  _chair(B, x, z, yaw, cushion) {
    const { box, cyl, ball } = B;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const pad = 0.5;

    const [px, pz] = at(0, 0);
    box.add(PAL.woodLight, px, pad + 0.05, pz, 0.78, 0.1, 0.74, 0, yaw, 0);
    // cushion tops out at 0.68, which is SEAT_Y minus the 0.06 of squish a
    // capybara's rear makes when the sit pose drops it onto the pad
    ball.add(cushion, px, pad + 0.11, pz, 0.72, 0.14, 0.68, 0, yaw, 0);
    for (const lx of [-0.28, 0.28]) {
      for (const lz of [-0.26, 0.26]) {
        const [gx, gz] = at(lx, lz);
        cyl.add(PAL.wood, gx, pad / 2, gz, 0.1, pad, 0.1);
      }
    }
    // back: two posts and two slats, high enough to frame a seated capy
    for (const lx of [-0.3, 0.3]) {
      const [gx, gz] = at(lx, -0.32);
      cyl.add(PAL.wood, gx, pad + 0.5, gz, 0.11, 1.0, 0.11, 0, yaw, 0);
    }
    for (const [ly, h] of [[0.62, 0.2], [0.9, 0.16]]) {
      const [gx, gz] = at(0, -0.32);
      box.add(PAL.woodMid, gx, pad + ly, gz, 0.68, h, 0.08, 0, yaw, 0);
    }
  }

  /** PONG: upright arcade cabinet, glowing marquee, joystick. */
  _pong(scene, B, s) {
    const g = new THREE.Group();
    g.position.set(s.at[0], 0, s.at[1]);
    g.rotation.y = Math.atan2(s.hs[0] - s.at[0], s.hs[1] - s.at[1]);
    scene.add(g);
    // cabinet carcass, control deck and bezel: one instanced batch in the
    // cabinet's own frame, so the whole thing costs three draw calls of solids
    const cab = new Batch(new THREE.BoxGeometry(1, 1, 1));
    cab.add(0x3b2350, 0, 1.25, 0, 1.7, 2.5, 1.15);
    cab.add(0x2a1839, 0, 0.11, 0, 1.78, 0.22, 1.24);
    cab.add(0x50306c, 0, 1.06, 0.62, 1.66, 0.2, 0.72, -0.42, 0, 0);
    cab.add(0x2a1839, 0, 0.82, 0.86, 1.66, 0.5, 0.16);
    cab.add(0x1b1026, 0, 1.86, 0.55, 1.5, 1.24, 0.1);
    cab.add(0x2a1839, 0, 2.72, 0.28, 1.74, 0.62, 0.5);
    cab.add(PAL.brass, 0.62, 0.78, 0.62, 0.3, 0.06, 0.06);
    cab.build(g, true, true);
    const knobs = new Batch(new THREE.CylinderGeometry(0.5, 0.5, 1, 10));
    knobs.add(PAL.steel, -0.42, 1.24, 0.6, 0.1, 0.34, 0.1);
    knobs.add(0x7ee0ff, 0.24, 1.19, 0.58, 0.18, 0.07, 0.18);
    knobs.add(PAL.gold, 0.52, 1.19, 0.58, 0.18, 0.07, 0.18);
    knobs.build(g, true, false);
    const topBall = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), makeToon(PAL.coral));
    topBall.position.set(-0.42, 1.42, 0.6);
    topBall.castShadow = true;
    g.add(topBall);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.02), this._flat(texPongScreen()));
    screen.position.set(0, 1.86, 0.61);
    g.add(screen);
    const marquee = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), this._flat(texMarquee()));
    marquee.position.set(0, 2.72, 0.54);
    g.add(marquee);
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 1.15),
      new THREE.MeshBasicMaterial({ color: 0xff7fe0, transparent: true, opacity: 0.2, depthWrite: false }),
    );
    halo.position.set(0, 2.72, 0.5);
    g.add(halo);
    this._halo = halo;
    const pl = new THREE.PointLight(0xd678ff, 8, 7, 2);
    pl.position.set(0, 2.5, 0.9);
    g.add(pl);
    this._haloLight = pl;

    // seating is the station's own pair of challenger chairs (_buildStations)
    this.obstacles.push({ x: s.at[0], z: s.at[1], r: 1.15 });
  }

  /** SHUFFLEBOARD: long waxed table with the scoring zones painted on it. */
  _shuffle(scene, B, s) {
    const { box, cyl, boxFlat } = B;
    const [x, z] = s.at;
    const LEN = 6.6, WID = 1.25, TOP = 0.78;
    box.add(PAL.woodMid, x, TOP - 0.11, z, WID + 0.34, 0.22, LEN + 0.3);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(WID, LEN), this._toonMap(texShuffleTop()));
    top.rotation.x = -Math.PI / 2;
    top.position.set(x, TOP + 0.01, z);
    top.receiveShadow = true;
    scene.add(top);
    for (const sx of [-1, 1]) box.add(PAL.wood, x + sx * (WID / 2 + 0.14), TOP + 0.05, z, 0.24, 0.28, LEN + 0.3);
    for (const sz of [-1, 1]) box.add(PAL.wood, x, TOP + 0.05, z + sz * (LEN / 2 + 0.12), WID + 0.5, 0.28, 0.24);
    for (const lz of [-1, 1]) {
      for (const lx of [-1, 1]) {
        box.add(PAL.wood, x + lx * 0.62, TOP / 2 - 0.06, z + lz * (LEN / 2 - 0.5), 0.24, TOP - 0.12, 0.24);
      }
    }
    for (const [px, pz, col] of [
      [-0.28, -2.5, PAL.coral], [0.22, -2.2, PAL.coral], [-0.1, -1.5, PAL.sky],
      [0.3, -0.9, PAL.sky], [-0.36, 2.6, PAL.coral], [0.34, 2.7, PAL.sky],
    ]) {
      cyl.add(col, x + px, TOP + 0.06, z + pz, 0.34, 0.1, 0.34);
      cyl.add(0xfff6e3, x + px, TOP + 0.115, z + pz, 0.2, 0.02, 0.2);
    }
    // scoreboard on the solid stretch of wall north of the windows
    const sb = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.12), this._flat(texScoreboard()));
    sb.rotation.y = Math.PI / 2;
    sb.position.set(-HW + 0.3, 2.9, -2.9);
    scene.add(sb);
    boxFlat.add(PAL.wood, -HW + 0.24, 2.9, -2.9, 0.12, 1.3, 1.7);
    cyl.add(PAL.brass, x + 1.06, 0.94, z + 3.5, 0.28, 0.3, 0.28);

    this.obstacles.push(
      { x, z: z - 2.4, r: 1.15 }, { x, z, r: 1.15 }, { x, z: z + 2.4, r: 1.15 },
    );
  }

  /** CARDS: round green felt, a fanned hand, element tokens, low pendant. */
  _cards(scene, B, s) {
    const { box, cyl, bead } = B;
    const [x, z] = s.at;
    const TOP = 0.8;
    cyl.add(PAL.wood, x, TOP - 0.06, z, 2.7, 0.14, 2.7);
    cyl.add(PAL.woodMid, x, TOP / 2, z, 0.5, TOP, 0.5);
    cyl.add(PAL.wood, x, 0.07, z, 1.5, 0.14, 1.5);
    const felt = new THREE.Mesh(new THREE.CircleGeometry(1.24, 30), this._toonMap(texFelt()));
    felt.rotation.x = -Math.PI / 2;
    felt.position.set(x, TOP + 0.02, z);
    felt.receiveShadow = true;
    scene.add(felt);

    // a hand fanned out on the near edge, plus a face-down deck: two instanced
    // meshes rather than nine little planes
    const cardGeo = new THREE.PlaneGeometry(0.34, 0.48);
    const o = new THREE.Object3D();
    const lay = (mat, rows) => {
      const im = new THREE.InstancedMesh(cardGeo, mat, rows.length);
      rows.forEach((r, i) => {
        o.position.set(r[0], r[1], r[2]);
        o.rotation.set(-Math.PI / 2, 0, r[3]);
        o.updateMatrix();
        im.setMatrixAt(i, o.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      scene.add(im);
    };
    const fan = [], deck = [];
    for (let i = 0; i < 5; i++) {
      const a = -0.5 + i * 0.25;
      fan.push([x + Math.sin(a) * 0.66, TOP + 0.03 + i * 0.003, z + 0.74 - Math.cos(a) * 0.12, -a]);
    }
    for (let i = 0; i < 4; i++) deck.push([x - 0.62, TOP + 0.03 + i * 0.012, z - 0.5, 0.3 + i * 0.04]);
    lay(this._flat(texCard(), { side: THREE.DoubleSide }), fan);
    lay(this._flat(texCardBack(), { side: THREE.DoubleSide }), deck);
    for (const [col, dx, dz] of [[PAL.coral, -0.3, 0], [PAL.sky, 0.1, -0.24], [PAL.gold, 0.3, 0.16], [PAL.plum, -0.1, 0.3]]) {
      cyl.add(col, x + dx, TOP + 0.06, z + dz, 0.3, 0.1, 0.3);
      bead.add(0xfff6e3, x + dx, TOP + 0.12, z + dz, 0.14, 0.04, 0.14);
    }
    box.add(0x4a3524, x, 3.2, z, 0.06, 1.6, 0.06);
    const shadeMesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.52, 0.44, 12, 1, true),
      makeToon(PAL.coral, { side: THREE.DoubleSide }),
    );
    shadeMesh.position.set(x, 2.4, z);
    scene.add(shadeMesh);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), makeGlow(0xffe2ac));
    bulb.position.set(x, 2.26, z);
    scene.add(bulb);

    this.obstacles.push({ x, z, r: 1.45 });
  }

  /** CHESS: heavy table, oversized pieces caught mid-game. */
  _chess(scene, B, s) {
    const { box, cyl, cone, ball, bead } = B;
    const [x, z] = s.at;
    const TOP = 0.72;
    box.add(PAL.wood, x, TOP - 0.08, z, 2.5, 0.18, 2.5);
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        box.add(PAL.woodMid, x + dx * 0.95, (TOP - 0.16) / 2, z + dz * 0.95, 0.22, TOP - 0.16, 0.22);
      }
    }
    box.add(PAL.woodMid, x, 0.24, z, 2.0, 0.12, 0.16);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1), this._toonMap(texChessBoard()));
    board.rotation.x = -Math.PI / 2;
    board.position.set(x, TOP + 0.02, z);
    board.receiveShadow = true;
    scene.add(board);

    const cell = 2.1 / 8;
    const light = 0xf4e2bb, dark = 0x53331d;
    const piece = (cx, cz, col, kind) => {
      const px = x - 1.05 + (cx + 0.5) * cell;
      const pz = z - 1.05 + (cz + 0.5) * cell;
      cyl.add(col, px, TOP + 0.05, pz, 0.2, 0.1, 0.2);
      cyl.add(col, px, TOP + 0.16, pz, 0.12, 0.22, 0.12);
      if (kind === 'pawn') ball.add(col, px, TOP + 0.32, pz, 0.16, 0.16, 0.16);
      else if (kind === 'rook') box.add(col, px, TOP + 0.34, pz, 0.2, 0.2, 0.2);
      else if (kind === 'bishop') cone.add(col, px, TOP + 0.36, pz, 0.2, 0.32, 0.2);
      else {
        cone.add(col, px, TOP + 0.34, pz, 0.24, 0.3, 0.24);
        bead.add(PAL.gold, px, TOP + 0.52, pz, 0.1, 0.1, 0.1);
      }
    };
    piece(2, 6, light, 'pawn'); piece(4, 5, light, 'pawn'); piece(0, 7, light, 'rook');
    piece(3, 7, light, 'king'); piece(5, 6, light, 'bishop');
    piece(3, 1, dark, 'pawn'); piece(5, 2, dark, 'pawn'); piece(7, 0, dark, 'rook');
    piece(4, 0, dark, 'king'); piece(2, 1, dark, 'bishop');
    // two captured pieces lying on the rim
    cyl.add(light, x + 1.4, TOP + 0.06, z + 0.4, 0.2, 0.12, 0.2, 0.3, 0, 1.3);
    cyl.add(dark, x + 1.4, TOP + 0.06, z - 0.3, 0.2, 0.12, 0.2, 0.2, 0, 1.4);

    this.obstacles.push({ x, z, r: 1.5 });
  }

  /** CONNECT 4: big standing blue grid with red and yellow discs. */
  _connect4(scene, B, s) {
    const [x, z] = s.at;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = -Math.PI / 2; // faces west, into the room
    scene.add(g);

    const COLS = 7, ROWS = 6, STEP = 0.44;
    const GW = COLS * STEP + 0.3, GH = ROWS * STEP + 0.4;
    const y0 = 1.0;
    // frame, trims, legs, feet and trays: one instanced batch in the stand's
    // own frame
    const frame = new Batch(new THREE.BoxGeometry(1, 1, 1));
    frame.add(PAL.cobalt, 0, y0 + GH / 2, 0, GW, GH, 0.22);
    for (const sy of [-1, 1]) {
      frame.add(PAL.cobaltDark, 0, y0 + GH / 2 + sy * (GH / 2 + 0.05), 0, GW + 0.24, 0.2, 0.34);
    }
    for (const sx of [-1, 1]) {
      frame.add(PAL.cobaltDark, sx * (GW / 2 + 0.05), y0 + GH / 2, 0, 0.2, GH + 0.3, 0.34);
      frame.add(PAL.wood, sx * (GW / 2 - 0.2), y0 / 2, 0, 0.22, y0, 0.5);
      frame.add(PAL.woodMid, sx * (GW / 2 - 0.2), 0.08, 0, 0.4, 0.16, 1.4);
      frame.add(PAL.woodMid, sx * (GW / 2 + 0.5), 0.9, 0, 0.5, 0.16, 1.0);
      frame.add(PAL.wood, sx * (GW / 2 + 0.5), 0.45, 0, 0.16, 0.9, 0.16);
    }
    frame.build(g, true, true);

    const filled = new Map([
      [[3, 0], 1], [[3, 1], 2], [[4, 0], 2], [[2, 0], 2], [[2, 1], 1],
      [[4, 1], 1], [[5, 0], 1], [[3, 2], 2], [[1, 0], 1], [[4, 2], 2],
    ].map(([k, v]) => [`${k[0]},${k[1]}`, v]));
    const holeGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.26, 12);
    const discGeo = new THREE.CylinderGeometry(0.165, 0.165, 0.3, 14);
    const buckets = [[], [], []];
    const o = new THREE.Object3D();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        o.position.set((c - (COLS - 1) / 2) * STEP, y0 + 0.25 + r * STEP, 0);
        o.rotation.set(Math.PI / 2, 0, 0);
        o.updateMatrix();
        buckets[filled.get(`${c},${r}`) || 0].push(o.matrix.clone());
      }
    }
    // spare discs waiting in the trays, folded into the same two batches
    for (const [sx, mi] of [[-1, 1], [1, 2]]) {
      for (let i = 0; i < 4; i++) {
        o.position.set(sx * (GW / 2 + 0.5), 1.04 + i * 0.02, -0.3 + i * 0.2);
        o.rotation.set(0, 0, 0);
        o.updateMatrix();
        buckets[mi].push(o.matrix.clone());
      }
    }
    const mats = [makeToon(0x1b3a6b), makeToon(PAL.red), makeToon(PAL.yellow)];
    buckets.forEach((mm, i) => {
      if (!mm.length) return;
      const im = new THREE.InstancedMesh(i ? discGeo : holeGeo, mats[i], mm.length);
      mm.forEach((m, k) => im.setMatrixAt(k, m));
      im.instanceMatrix.needsUpdate = true;
      g.add(im);
    });

    // a disc hovering over the drop slot, waiting for someone to play
    const hover = new THREE.Mesh(discGeo, mats[2]);
    hover.rotation.x = Math.PI / 2;
    hover.position.set(-0.44, y0 + GH + 0.45, 0);
    hover.castShadow = true;
    g.add(hover);
    this._c4Disc = hover;
    this._c4Base = y0 + GH + 0.45;

    // the grid is 3.4 long: one collider at its centre would leave both ends
    // walkable-through
    this.obstacles.push({ x, z, r: 1.35 }, { x, z: z - 1.5, r: 1.0 }, { x, z: z + 1.5, r: 1.0 });
  }

  /** Padded three-legged stool: the cocoa bar's seating. */
  _stool(B, x, z, cushion) {
    const { cyl, ball } = B;
    const h = 0.62;
    cyl.add(PAL.woodLight, x, h, z, 0.76, 0.12, 0.76);
    ball.add(cushion, x, h + 0.1, z, 0.7, 0.18, 0.7);
    for (let l = 0; l < 3; l++) {
      const a = (l / 3) * Math.PI * 2 + 0.6;
      cyl.add(PAL.wood, x + Math.cos(a) * 0.2, h / 2, z + Math.sin(a) * 0.2, 0.09, h, 0.09,
        Math.sin(a) * 0.16, 0, -Math.cos(a) * 0.16);
    }
  }

  // -------------------------------------------------------------------------
  // rugs, armchairs, cushions, low table, the sleeping regular
  // -------------------------------------------------------------------------
  _buildSeating(scene, B, rand) {
    const { box, cyl, ball, bead } = B;

    // rugs stay flat decoration: never in groundMeshes, so the bot zone floor
    // stays exactly one raycast surface
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(9.0, 6.4), this._toonMap(texRug(0)));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.012, 1.6);
    rug.receiveShadow = true;
    scene.add(rug);
    const hearthRug = new THREE.Mesh(new THREE.CircleGeometry(2.5, 32), this._toonMap(texRug(1)));
    hearthRug.rotation.x = -Math.PI / 2;
    hearthRug.position.set(0, 0.012, -3.2);
    hearthRug.receiveShadow = true;
    scene.add(hearthRug);
    const cardRug = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), this._toonMap(texRug(1)));
    cardRug.rotation.set(-Math.PI / 2, 0, 0.4);
    cardRug.position.set(-7.4, 0.01, 5.8);
    scene.add(cardRug);

    // two leather-look armchairs pulled up to the fire
    for (const sx of [-1, 1]) {
      const x = sx * 3.1, z = -3.4;
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = Math.atan2(0 - x, -6.4 - z);
      scene.add(g);
      const hide = makeToon(PAL.leather);
      const hideD = makeToon(PAL.leatherDark);
      const add = (geo, mat, px, py, pz, rot, sc) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(px, py, pz);
        if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
        if (sc) m.scale.set(sc[0], sc[1], sc[2]);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
        return m;
      };
      add(new THREE.BoxGeometry(1.24, 0.34, 1.16), hideD, 0, 0.36, 0);
      add(new THREE.SphereGeometry(0.5, 12, 9), hide, 0, 0.58, 0.04, null, [1.24, 0.34, 1.1]);
      add(new THREE.BoxGeometry(1.3, 1.1, 0.3), hide, 0, 1.02, -0.52, [0.2, 0, 0]);
      for (const ax of [-1, 1]) {
        add(new THREE.BoxGeometry(0.26, 0.4, 1.06), hide, ax * 0.62, 0.82, 0.02);
        add(new THREE.CylinderGeometry(0.13, 0.13, 1.02, 10), hideD, ax * 0.62, 1.02, 0.02, [Math.PI / 2, 0, 0]);
        for (const az of [-1, 1]) {
          add(new THREE.CylinderGeometry(0.09, 0.07, 0.2, 8), makeToon(PAL.wood), ax * 0.5, 0.1, az * 0.45);
        }
      }
      this.obstacles.push({ x, z, r: 0.85 });
    }

    // low table between them, with a leaning stack of games
    cyl.add(PAL.woodMid, 0, 0.44, -3.4, 1.7, 0.12, 1.7);
    cyl.add(PAL.wood, 0, 0.22, -3.4, 0.34, 0.44, 0.34);
    cyl.add(PAL.wood, 0, 0.05, -3.4, 1.0, 0.1, 1.0);
    for (let i = 0; i < 3; i++) {
      box.add([PAL.coral, PAL.sky, PAL.gold][i], -0.24, 0.56 + i * 0.11, -3.4,
        0.72, 0.1, 0.52, 0, i * 0.25, 0);
    }
    cyl.add(PAL.cream, 0.42, 0.6, -3.28, 0.24, 0.2, 0.24);
    this.obstacles.push({ x: 0, z: -3.4, r: 0.9 });

    // floor cushions between the hearth and the chairs
    for (const [cx, cz, col] of [[-1.6, -2.2, PAL.coral], [1.7, -2.3, PAL.sky], [-1.3, -4.4, PAL.gold], [1.4, -4.5, PAL.plum]]) {
      ball.add(col, cx, 0.19, cz, 0.98, 0.38, 0.98, 0, rand() * 3, 0);
      bead.add(0xfff6e3, cx, 0.34, cz, 0.12, 0.06, 0.12);
    }

    // The regular: a capybara fast asleep on a beanbag. Parked in the cocoa
    // corner rather than by the fire, where the hearth, chairs, bookshelf and
    // pong cabinet already leave no gap wide enough to nap in.
    const bx = 6.3, bz = 6.6;
    ball.add(0x8e6f4e, bx, 0.32, bz, 2.0, 0.72, 1.8);
    const sleeper = new THREE.Group();
    sleeper.position.set(bx, 0.52, bz);
    sleeper.rotation.y = 0.9; // snout toward the room camera, so the face reads
    scene.add(sleeper);
    // body in two instanced batches inside the group, so the breathing scale
    // still animates the whole capy for two draw calls
    const nap = new Batch(new THREE.SphereGeometry(0.5, 12, 9));
    nap.add(PAL.capy, 0, 0.2, 0, 1.5, 0.9, 1.05);          // barrel
    nap.add(PAL.capy, 0, 0.3, 0.62, 0.86, 0.72, 0.8);      // head
    nap.add(PAL.capy, 0, 0.22, 0.98, 0.5, 0.4, 0.46);      // snout
    nap.build(sleeper, true, false);
    const napD = new Batch(new THREE.SphereGeometry(0.5, 8, 6));
    napD.add(PAL.capyDark, -0.22, 0.58, 0.5, 0.24, 0.24, 0.24);
    napD.add(PAL.capyDark, 0.22, 0.58, 0.5, 0.24, 0.24, 0.24);
    napD.add(PAL.capyDark, 0, 0.2, 1.18, 0.16, 0.12, 0.12);
    for (const ex of [-0.18, 0.18]) napD.add(PAL.capyDark, ex, 0.36, 0.92, 0.14, 0.04, 0.06);
    napD.build(sleeper, false, false);
    this._sleeper = sleeper;
    this._sleepAt = [bx, bz];

    const zTex = texZ();
    this._zs = [];
    for (let i = 0; i < 3; i++) {
      const zz = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.34),
        this._flat(zTex.clone(), { transparent: true, depthWrite: false }),
      );
      zz.position.set(bx, 1.2, bz);
      scene.add(zz);
      this._zs.push(zz);
    }
    this.obstacles.push({ x: bx, z: bz, r: 1.05 });
  }

  // -------------------------------------------------------------------------
  // cocoa bar with steaming mugs
  // -------------------------------------------------------------------------
  _buildBar(scene, B) {
    const { box, boxFlat, cyl, bead, cone } = B;
    const BX = 8.8, Z0 = 3.0, Z1 = 6.6;
    const cz = (Z0 + Z1) / 2, len = Z1 - Z0;

    box.add(PAL.wainscot, BX, 0.56, cz, 1.1, 1.12, len);
    box.add(PAL.woodLight, BX, 1.18, cz, 1.36, 0.14, len + 0.24);
    boxFlat.add(PAL.coral, BX - 0.58, 0.66, cz, 0.06, 0.32, len - 0.3);
    // back shelf against the east wall, below the window sill
    boxFlat.add(PAL.wood, HW - 0.36, 1.5, cz, 0.44, 0.1, len);
    for (let i = 0; i < 7; i++) {
      cyl.add([PAL.cream, PAL.gold, PAL.coral][i % 3], HW - 0.36, 1.72, Z0 + 0.4 + i * 0.5, 0.3, 0.34, 0.3);
    }
    cyl.add(PAL.brass, BX, 1.55, cz - 0.9, 0.62, 0.6, 0.62);
    cone.add(PAL.brass, BX, 1.95, cz - 0.9, 0.66, 0.34, 0.66);
    bead.add(PAL.gold, BX, 2.16, cz - 0.9, 0.16, 0.16, 0.16);
    boxFlat.add(0x3a2a18, BX - 0.34, 1.42, cz - 0.9, 0.14, 0.1, 0.1);

    this._mugs = [];
    [cz + 0.1, cz + 0.6, cz + 1.1, cz - 0.4].forEach((mz, i) => {
      const mx = BX + (i % 2 ? 0.16 : -0.16);
      cyl.add(PAL.cream, mx, 1.38, mz, 0.34, 0.3, 0.34);
      cyl.add(PAL.cocoa, mx, 1.53, mz, 0.28, 0.02, 0.28);
      bead.add(0xfff6e3, mx + 0.1, 1.55, mz, 0.1, 0.08, 0.1);
      if (i < 2) this._mugs.push([mx, 1.57, mz]);
    });

    const steam = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xfff4e2, transparent: true, opacity: 0.3, depthWrite: false }),
      14,
    );
    this._steamData = [];
    const d = new THREE.Object3D();
    for (let i = 0; i < 14; i++) {
      this._steamData.push({ t: i / 14, sp: 0.4 + (i % 4) * 0.07, ph: i * 1.9, mug: i % 2 });
      d.position.set(0, -9, 0);
      d.updateMatrix();
      steam.setMatrixAt(i, d.matrix);
    }
    steam.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    steam.frustumCulled = false;
    scene.add(steam);
    this._steam = steam;

    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.95), this._flat(texCocoa()));
    sign.rotation.y = -0.7;
    sign.position.set(BX + 0.46, 3.0, cz - 0.5);
    scene.add(sign);
    boxFlat.add(PAL.wood, BX + 0.52, 3.0, cz - 0.5, 0.1, 1.1, 2.1, 0, -0.7, 0);

    this._stool(B, BX - 1.6, Z0 + 0.6, PAL.gold);
    this._stool(B, BX - 1.6, Z0 + 2.0, PAL.gold);

    this.obstacles.push(
      { x: BX, z: Z0 + 0.4, r: 1.05 }, { x: BX, z: cz, r: 1.05 }, { x: BX, z: Z1 - 0.4, r: 1.05 },
    );
  }

  // -------------------------------------------------------------------------
  // bookshelves, champion portraits, plants
  // -------------------------------------------------------------------------
  _buildDecor(scene, B, rand) {
    const { box, boxFlat, cyl, bead, cone } = B;

    // --- bookshelves of board game boxes, flanking the fireplace -----------
    for (const sx of [-1, 1]) {
      const x = sx * 5.9, z = ZN + 0.55;
      box.add(PAL.wood, x, 1.85, z, 2.7, 3.7, 0.9);
      boxFlat.add(0x5d3a1e, x, 1.85, z + 0.02, 2.4, 3.5, 0.86);
      for (let s = 0; s < 4; s++) {
        const sy = 0.45 + s * 0.86;
        boxFlat.add(PAL.woodLight, x, sy, z + 0.06, 2.5, 0.1, 0.86);
        let bx = x - 1.06;
        while (bx < x + 0.9) {
          const w = 0.16 + rand() * 0.12;
          const hgt = 0.5 + rand() * 0.2;
          const col = [PAL.coral, PAL.sky, PAL.gold, PAL.leaf, PAL.plum, PAL.cream][(rand() * 6) | 0];
          box.add(col, bx + w / 2, sy + 0.06 + hgt / 2, z + 0.06, w, hgt, 0.68, 0, 0, (rand() - 0.5) * 0.12);
          bx += w + 0.03;
        }
        if (s % 2 === 0) {
          for (let k = 0; k < 3; k++) {
            box.add([PAL.leaf, PAL.coral, PAL.sky][k], x + 0.86, sy + 0.14 + k * 0.11, z + 0.06,
              0.62, 0.1, 0.62, 0, 0.2 * k, 0);
          }
        }
      }
      box.add(PAL.woodLight, x, 3.78, z, 2.9, 0.16, 1.0);
      cyl.add(PAL.terracotta, x - 0.9, 3.98, z, 0.44, 0.3, 0.44);
      cone.add(PAL.leafDark, x - 0.9, 4.32, z, 0.56, 0.6, 0.56);
      this.obstacles.push({ x, z: z + 0.2, r: 1.5 });
    }

    // --- the wall of framed champions, in both north corners ---------------
    const banners = ['HALL OF CHAMPIONS', "TONIGHT'S CHALLENGERS"];
    for (const side of [0, 1]) {
      const sx = side ? 1 : -1;
      for (let i = 0; i < 3; i++) {
        const x = sx * (7.7 + i * 1.35);
        const cfg = CHAMPIONS[side * 3 + i];
        boxFlat.add(0x6b4a2c, x, 3.3, ZN + 0.2, 1.3, 1.5, 0.1);   // frame
        boxFlat.add(PAL.brass, x, 3.3, ZN + 0.26, 1.14, 1.34, 0.08); // mat
        const p = new THREE.Mesh(new THREE.PlaneGeometry(1.02, 1.2), this._flat(texPortrait(cfg)));
        p.position.set(x, 3.3, ZN + 0.32);
        scene.add(p);
        if (i < 2) {
          cyl.add(PAL.brass, sx * (8.4 + i * 1.35), 4.16, ZN + 0.42, 0.16, 0.34, 0.16, 0.9, 0, 0);
          bead.add(0xffe0a8, sx * (8.4 + i * 1.35), 4.04, ZN + 0.54, 0.16, 0.16, 0.16);
        }
      }
      const b = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 0.98), this._flat(texBanner(banners[side])));
      b.position.set(sx * 9.05, 4.72, ZN + 0.3);
      scene.add(b);
    }

    // --- potted plants in the corners --------------------------------------
    for (const [x, z] of [[-10.3, -6.1], [-10.3, 7.9], [10.3, 7.9], [10.3, -6.1]]) {
      cyl.add(PAL.terracotta, x, 0.32, z, 0.86, 0.64, 0.86);
      cyl.add(0x6b4b32, x, 0.62, z, 0.74, 0.06, 0.74);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rand();
        const lean = 0.4 + rand() * 0.3;
        cone.add(i % 2 ? PAL.leaf : PAL.leafDark,
          x + Math.cos(a) * 0.34, 1.05 + rand() * 0.4, z + Math.sin(a) * 0.34,
          0.34, 1.3, 0.34, Math.sin(a) * lean, 0, -Math.cos(a) * lean);
      }
      this.obstacles.push({ x, z, r: 0.7 });
    }

    // a trophy plaque on the solid stretch of the west wall
    boxFlat.add(PAL.wood, -HW + 0.24, 3.2, -4.9, 0.14, 1.3, 1.3);
    cyl.add(PAL.cream, -HW + 0.34, 3.2, -4.9, 0.9, 0.06, 0.9, 0, 0, Math.PI / 2);
    cyl.add(PAL.coral, -HW + 0.38, 3.2, -4.9, 0.5, 0.04, 0.5, 0, 0, Math.PI / 2);
    bead.add(PAL.gold, -HW + 0.42, 3.2, -4.9, 0.14, 0.14, 0.14);
  }

  // -------------------------------------------------------------------------
  // the way out. Posts and finials only: a lintel here sits exactly on the
  // camera's line to the head of anyone standing on the default spawn.
  // -------------------------------------------------------------------------
  _buildEntrance(scene, B) {
    const { box, cyl, ball, bead } = B;

    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * 1.75, 1.55, DZ, 0.36, 3.1, 0.4);
      box.add(PAL.woodLight, sx * 1.75, 3.18, DZ, 0.5, 0.18, 0.54);
      ball.add(PAL.gold, sx * 1.75, 3.4, DZ, 0.34, 0.38, 0.34);
      this.obstacles.push({ x: sx * 1.75, z: DZ, r: 0.5 });

      // Half wall out to the corner. It is the nearest thing to the camera in
      // the whole room, so it gets planting rather than a bench on top: a
      // second solid bar at this distance reads as a barricade.
      const x0 = sx * 2.4, x1 = sx * (HW - 0.3);
      const cx = (x0 + x1) / 2, w = Math.abs(x1 - x0);
      box.add(PAL.wainscot, cx, 0.5, DZ + 0.25, w, 1.0, 0.55);
      box.add(PAL.woodLight, cx, 1.06, DZ + 0.25, w + 0.16, 0.14, 0.72);
      box.add(PAL.coral, cx, 0.64, DZ - 0.04, w - 0.3, 0.28, 0.06);
      for (let i = 0; i < 7; i++) {
        const x = x0 + ((i + 0.5) / 7) * (x1 - x0);
        ball.add(i % 3 ? PAL.leaf : PAL.leafDark, x, 1.2, DZ + 0.22, 0.66, 0.36, 0.62, 0, i * 0.7, 0.2);
        if (i % 3 === 1) ball.add(i % 2 ? PAL.coral : PAL.gold, x + 0.16, 1.34, DZ + 0.16, 0.24, 0.22, 0.24);
      }
      for (let i = 0; i < 4; i++) this.obstacles.push({ x: sx * (3.3 + i * 1.8), z: DZ + 0.25, r: 0.95 });
    }

    // The sign hangs off the west post, clear of the centre sight line, and
    // faces SOUTH. It is tempting to point it back into the room at the player
    // walking toward it, but the camera always trails 13.5 south of them, so a
    // north-facing board only ever shows the camera its back.
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.78),
      this._flat(texSign('FROSTY PEAK', 'boots on, mind the icicles', '#dff0fb', '#215c86', '#4fb3e8')),
    );
    sign.rotation.y = -0.22;
    sign.position.set(-2.95, 2.5, DZ + 0.16);
    scene.add(sign);
    box.add(PAL.cream, -2.95, 2.5, DZ + 0.1, 2.44, 0.9, 0.1, 0, -0.22, 0);

    // daylight pooling on the boards just inside the door
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(2.0, 24),
      new THREE.MeshBasicMaterial({ color: 0xdcf0ff, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.016, DZ - 1.3);
    scene.add(pool);
    this._exitRing = pool;

    // snow boots by the door and a coat on a peg
    for (let i = 0; i < 3; i++) {
      cyl.add(PAL.leatherDark, -3.1 + i * 0.34, 0.24, DZ - 1.15, 0.3, 0.48, 0.3, 0.12, 0, 0);
    }
    bead.add(PAL.coral, 2.55, 2.3, DZ - 0.22, 0.4, 0.5, 0.36);

    // Skis and poles propped against the half wall: the one prop that says
    // "you are inside the ski lodge" from the arrival spawn, where the door
    // fills the bottom of the frame.
    for (let i = 0; i < 2; i++) {
      const x = 3.9 + i * 0.34;
      box.add(i ? PAL.sky : PAL.coral, x, 1.0, DZ - 0.5, 0.16, 2.0, 0.06, -0.24, 0, 0.05);
      box.add(PAL.cream, x, 1.94, DZ - 0.72, 0.16, 0.22, 0.07, -0.24, 0, 0.05);
    }
    for (let i = 0; i < 2; i++) {
      const x = 4.62 + i * 0.2;
      cyl.add(PAL.steel, x, 0.9, DZ - 0.46, 0.05, 1.8, 0.05, -0.2, 0, 0.04);
      cyl.add(PAL.gold, x, 0.32, DZ - 0.34, 0.2, 0.05, 0.2, -0.2, 0, 0.04);
    }
  }

  // -------------------------------------------------------------------------
  update(dt) {
    const t = (this.t += dt);
    const d = this._d;

    // fire
    for (let i = 0; i < this._flameData.length; i++) {
      const f = this._flameData[i];
      const k = 0.62 + 0.32 * Math.sin(t * f.sp + f.ph) + 0.12 * Math.sin(t * f.sp * 2.7 + f.ph);
      const hgt = f.s * (0.7 + k * 0.75);
      d.position.set(f.x + Math.sin(t * 1.7 + f.ph) * 0.05, 0.3 + hgt / 2, f.z);
      d.rotation.set(0, t * 0.6 + f.ph, Math.sin(t * 2.1 + f.ph) * 0.12);
      d.scale.set(f.s * (0.42 + k * 0.16), hgt, f.s * (0.42 + k * 0.16));
      d.updateMatrix();
      this._flames.setMatrixAt(i, d.matrix);
      this._col.setRGB(1, 0.42 + k * 0.34, 0.06 + k * 0.22);
      this._flames.setColorAt(i, this._col);
    }
    this._flames.instanceMatrix.needsUpdate = true;
    this._flames.instanceColor.needsUpdate = true;

    for (let i = 0; i < this._emberData.length; i++) {
      const e = this._emberData[i];
      e.t += dt * e.sp;
      if (e.t > 1) e.t -= 1;
      const f = e.t;
      d.position.set(e.x + Math.sin(f * 6 + e.ph) * 0.3, 0.5 + f * 2.2, -8.3 + Math.cos(f * 4 + e.ph) * 0.14);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(Math.max(0, 1 - f) * (0.7 + Math.sin(f * 12 + e.ph) * 0.3));
      d.updateMatrix();
      this._embers.setMatrixAt(i, d.matrix);
    }
    this._embers.instanceMatrix.needsUpdate = true;

    this._fireLight.intensity = 22 + Math.sin(t * 7.3) * 4 + Math.sin(t * 2.9) * 3;
    this._fireGlow.material.opacity = 0.22 + Math.sin(t * 5.1) * 0.07;

    // trophies catch the light as they turn
    const mA = this._mA, mB = this._mB;
    for (let i = 0; i < 5; i++) {
      const at = this._trophyAt[i];
      mA.makeRotationY(Math.sin(t * 0.5 + i * 1.1) * 0.35);
      mA.setPosition(at[0], at[1] + Math.sin(t * 1.3 + i * 0.8) * 0.012, at[2]);
      for (const k of this._trophy) {
        for (let p = 0; p < k.locals.length; p++) {
          mB.multiplyMatrices(mA, k.locals[p]);
          k.mesh.setMatrixAt(i * k.locals.length + p, mB);
        }
      }
    }
    for (const k of this._trophy) k.mesh.instanceMatrix.needsUpdate = true;

    // string lights twinkle
    for (let i = 0; i < this._bulbSeed.length; i++) {
      const k = 0.7 + 0.3 * Math.sin(t * 2.0 + this._bulbSeed[i]);
      this._col.setRGB(k, k * 0.86, k * 0.6);
      this._bulbs.setColorAt(i, this._col);
    }
    this._bulbs.instanceColor.needsUpdate = true;

    // arcade marquee pulse
    this._halo.material.opacity = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(t * 3.1));
    this._haloLight.intensity = 6 + Math.sin(t * 3.1) * 3;

    // the connect-4 disc waits to be dropped
    this._c4Disc.position.y = this._c4Base + Math.sin(t * 1.8) * 0.12;
    this._c4Disc.rotation.z = Math.sin(t * 0.9) * 0.25;

    // steam curling off the cocoa
    for (let i = 0; i < this._steamData.length; i++) {
      const s = this._steamData[i];
      s.t += dt * s.sp;
      if (s.t > 1) s.t -= 1;
      const m = this._mugs[s.mug];
      const f = s.t;
      d.position.set(
        m[0] + Math.sin(f * 5 + s.ph) * 0.14 * f,
        m[1] + f * 0.85,
        m[2] + Math.cos(f * 4 + s.ph) * 0.1 * f,
      );
      d.rotation.set(0, 0, 0);
      d.scale.setScalar((0.5 + f * 2.2) * Math.max(0, 1 - f));
      d.updateMatrix();
      this._steam.setMatrixAt(i, d.matrix);
    }
    this._steam.instanceMatrix.needsUpdate = true;

    // the sleeper breathes and lets off the occasional z
    this._sleeper.scale.set(1, 1 + Math.sin(t * 1.15) * 0.045, 1);
    this._sleeper.position.y = 0.52 + Math.sin(t * 1.15) * 0.02;
    for (let i = 0; i < this._zs.length; i++) {
      const k = (t * 0.26 + i / 3) % 1;
      const zz = this._zs[i];
      zz.position.set(this._sleepAt[0] + 0.5 + k * 0.5, 1.0 + k * 1.1, this._sleepAt[1] + 0.7);
      zz.scale.setScalar(0.4 + k);
      zz.material.opacity = Math.max(0, 1 - k) * 0.9;
    }

    // prompt markers breathe. Rings alternate sit / house-opponent, and the
    // house ring stays the quieter of the two so the real table reads first.
    for (let i = 0; i < this._rings.length; i++) {
      const p = Math.sin(t * 2.1 + i * 1.3);
      const base = i % 2 ? 0.2 : 0.34;
      this._rings[i].material.opacity = base + p * (i % 2 ? 0.09 : 0.16);
      this._rings[i].scale.setScalar(1 + p * 0.05);
    }
    const q = Math.sin(t * 1.7);
    this._exitRing.material.opacity = 0.14 + q * 0.06;
    this._exitRing.scale.setScalar(1 + q * 0.04);

    this._updateTables(dt, t);
  }

  // -------------------------------------------------------------------------
  // tables + matches, per frame
  // -------------------------------------------------------------------------
  _updateTables(dt, t) {
    // seated challengers keep breathing (nothing organic is ever perfectly still)
    for (const r of this._seated.values()) r.avatar.update(dt);

    // A 'table' frame can beat the 'pjoin' that introduces the same capybara,
    // so a seat may start out brown and un-deduplicated. Catch up twice a
    // second: cheap, and it means the chair always ends up wearing their hat.
    this._reconcileT += dt;
    if (this._reconcileT > 0.5) {
      this._reconcileT = 0;
      if (this._seated.size) this._reconcileSeats();
    }

    // a chip with somebody waiting on it nudges for attention
    for (const c of this._chips.values()) {
      const k = c.state === 'waiting' ? 1 + Math.abs(Math.sin(t * 3.6)) * 0.07 : 1;
      c.mesh.scale.set(k, k, k);
    }

    // keep the local capybara settled in their chair while they wait
    const engine = this._game?.engine;
    const avatar = engine?.playerAvatar;
    const st = this._localTable ? STATION_BY_ID.get(this._localTable) : null;
    const seat = st?.seats[this._localSeat];
    if (seat && avatar) {
      const g = avatar.group;
      const walking = !!engine.controller?.target;
      if (!walking && Math.hypot(g.position.x - seat[0], g.position.z - seat[1]) < 0.6) {
        if (avatar.state.anim !== 'sit') avatar.setAnim('sit');
        g.position.y = SEAT_Y;
        const yaw = seatYaw(st, this._localSeat);
        const d = ((((yaw - g.rotation.y) % TAU) + Math.PI * 3) % TAU) - Math.PI;
        g.rotation.y += d * Math.min(1, dt * 6);
      }
    }

    // the prompts have to follow the connection coming and going
    const online = !!this._game?.net?.connected;
    if (online !== this._wasOnline) {
      this._wasOnline = online;
      if (!online) this._clearTables();
      else this._refreshLabels();
      for (const s of STATIONS) this._paintChip(s.id);
    }
  }

  dispose() {
    // Walking out while seated must not leave a ghost holding a chair. Harmless
    // if the server already dropped us on the room change.
    if (this._localTable && this._game?.net?.connected) {
      this._game.net.send({ t: 'table-leave' });
    }
    // seats next: they hold engine-owned name tags and may be sitting on top of
    // networked avatars we un-parented, which have to go back in the room
    for (const id of [...this._seated.keys()]) this._unseat(id);
    this._seated.clear();
    this._offTable?.();
    this._offMatchStart?.();
    this._offTable = null;
    this._offMatchStart = null;
    this._localTable = null;
    this._seatGroup = null;
    this._sitSpots = null;
    this._tables = null;
    this._chips = null; // chip materials are unique; disposeObject frees them
    this._game = null;
    this._flames = null;
    this._flameData = null;
    this._embers = null;
    this._emberData = null;
    this._fireLight = null;
    this._fireGlow = null;
    this._trophies = null;
    this._bulbs = null;
    this._bulbSeed = null;
    this._halo = null;
    this._haloLight = null;
    this._c4Disc = null;
    this._steam = null;
    this._steamData = null;
    this._mugs = null;
    this._sleeper = null;
    this._zs = null;
    this._rings = null;
    this._exitRing = null;
    this._toonMap = null;
    this._flat = null;
  }
}
