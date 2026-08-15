import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BOT_ZONES } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// THE TROPHY LOFT: the quiet upper storey of the Frosty Peak ski lodge, over
// the Game Den. Its own room ('loft'), reached by walking up the den's stair
// and back down the one in here, so the noisy floor and the thinking floor
// never share a frame.
//
//   Plan (the camera sits south, 10 up, looking north):
//     NORTH  the grand stone fireplace on the gable wall, the mantel of gold
//            capy trophies over it, the Hall of Champions either side, two
//            deep armchairs and the round hearth rug in front of it.
//     WINGS  GRAND CAPY CHESS east, CAPY CLASH west: two two-seat tables with
//            their chairs, sign posts and live status chips, exactly the
//            wave-4 station pattern they had downstairs (see STATIONS).
//     MIDDLE plain planks, the bot circle, the through route between the
//            wings and the way to the fire.
//     SOUTH  a low balustrade along the open edge with one gap in it: the
//            stair DOWN to the den, boxed into its own well, with a warm
//            doorway and a sign at the bottom. Walking down it crosses
//            'exit-lounge'.
//
// Rules this room obeys, all inherited from the den's two-floor experiment
// (which is what this room replaces):
//   * NOTHING OVERHEAD. The camera rides 9.5 above the player, so a ceiling,
//     a rafter or a ridge beam would render between it and anybody standing
//     up here. The lodge is a cutaway: walls, eaves and snow OUTSIDE, open
//     sky above. The upper storey means the roof of the floor below wraps the
//     room just under the windows, which is the view: snow-loaded slopes,
//     then the mountainside.
//   * signs face the camera, never their own wall (it always looks due north,
//     so a face with no +z in its normal is a sliver);
//   * every walkable edge that has air beyond it carries overlapping obstacle
//     circles: WalkController slides along a rim, so a fence has to be a solid
//     union of circles (0.45 apart), not a row of touching ones;
//   * the BOT_ZONES circle (0, 0.6, r 2.6) is plain flat planks, no rug seam,
//     no collider, and it stops short of the stairwell mouth at z 3.8.
//
// The two tables are the multiplayer half of the room (wave 4 protocol, see
// CLAUDE.md / src/net/client.js):
//   out  {t:'table-join', game} {t:'table-leave'}
//   in   'table' {game, players:[{id,name}]}
//        'match-start' {game, players, youAre, seed} -> game.__matchCtx + start
// The server gates a table-join on the game's own room (MINIGAMES[game].room),
// so chess and Capy Clash can only be joined from up here.
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
  steel: 0xb9c3cb,
  cocoa: 0x5b3521,
  terracotta: 0xcf7649,
  leaf: 0x7ac74f,
  leafDark: 0x4d8c39,
  sky: 0x4fb3e8,
  plum: 0x9b6bd4,
  // the mountain outside, straight from Frosty Peak's palette
  snow: 0xf4f9ff,
  snowShade: 0xdde8f6,
  pine: 0x2f6b4f,
  pineDark: 0x24523d,
};

// room shell
const HW = 9;         // half width in x
const ZN = -7;        // north gable (inner face)
const ZS = 7;         // south edge of the floor: open to the camera
const WALL_H = 5.6;   // side walls
const WALL_N = 7.4;   // north gable: the fireplace is a two-storey stack
const FZ = -6.5;      // centre plane of the fireplace stonework
const ZONE = BOT_ZONES.loft; // { x: 0, z: 0.6, r: 2.6 }

// --- the stair DOWN --------------------------------------------------------
// It hangs off the south edge in its own boxed well, so the loft floor stays
// one plain rectangle. Four treads at 0.4 (a third of the 1.2 step-up range,
// so it walks as one continuous ramp), then a landing and the door.
const WELL_HW = 1.9;             // half width of the well / the gap in the rail
const ST_Z0 = ZS;                // top of the flight, at the floor edge
const ST_N = 4;
const ST_RISE = 0.4;
const ST_GOING = 0.78;
const ST_BOTTOM = -ST_N * ST_RISE;                 // -1.6
const ST_Z1 = ST_Z0 + ST_N * ST_GOING;             // 10.12: foot of the flight
const LAND_Z = ST_Z1 + 1.25;                       // landing centre-ish
const DOOR_Z = ST_Z1 + 2.3;                        // the lit doorway at the end

const RAIL_Y = 0.95;   // balustrade height
const RAIL_R = 0.6;    // railing collider radius
const RAIL_STEP = 0.45; // see the header: a fence is a UNION of circles

// How far a painted sign face stands proud of its own post (radius 0.09).
const SIGN_OUT = 0.13;
// Where the two bracket lanterns hang, in z. NOT their table's z, which is
// where they started: at |x| 8.3 a wall lantern and a sign post at |x| 7.75
// project into the same narrow column of a camera that converges on x = 0, and
// the coral shade ate the C of CAPY CLASH from the arrival spawn. Four metres
// south of the tables pulls them apart by a third of the sign's own width, and
// puts the light over the spot you stand on to take a seat.
const LAMP_Z = 2.2;

// window openings, given in WORLD z and mirrored onto both side walls. Tall:
// up here the glass starts above the wainscot and runs to just under the eaves,
// because the whole point of the top floor is the view.
const WINZ = [[-4.8, -1.9], [0.5, 3.9]];
const WIN_LO = 1.75, WIN_HI = 4.4;

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const OUTLINE = '#2d2417';

// Both stations in one table, same shape as the den's: where the prop stands,
// where each of its two prompts fires, where its sign post goes, and where its
// two chairs sit. `ai` is the opponent each minigame names in its own code.
//
// Layout rules the numbers obey:
//   * one wing each, mirrored about x = 0, so neither table's cluster shares a
//     band of frame with the other from the arrival spawn;
//   * `hs` (sit down) and `aiAt` (play the house) are ~1.2 apart with all of it
//     in z, because the camera trails 14 south: two prompts separated in x land
//     on top of each other, separated in z they stack neatly;
//   * both clusters keep their whole collider footprint out of the bot circle
//     and out of the walk from the stair head to the fire.
const STATIONS = [
  {
    id: 'chess', label: 'Play Grand Capy Chess', name: 'GRAND CAPY CHESS',
    sub: 'think before you nibble', ai: 'Grandmaster Pebble',
    at: [5.4, -2.0], hs: [5.4, -0.55], aiAt: [5.4, 0.65], sign: [7.75, -2.7],
    seats: [[3.75, -2.0], [7.05, -2.0]],
  },
  {
    id: 'cards', label: 'Play Capy Clash', name: 'CAPY CLASH',
    sub: 'elements at dawn', ai: 'Grandmaster Pebble',
    at: [-5.4, -2.0], hs: [-5.4, -0.55], aiAt: [-5.4, 0.65], sign: [-7.75, -2.7],
    seats: [[-7.05, -2.0], [-3.75, -2.0]],
  },
];
const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));

const TAU = Math.PI * 2;
// Chair cushions top out at 0.68; a capybara's rear sits 0.12 under its root
// once the sit pose drops the body, so this parks it on the cushion.
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
// world clock (wave 7): interiors keep their layout and only swap the
// mountainside past the glass, then reverse the glow (daylight out, fire in).
// ---------------------------------------------------------------------------

/** dayT: 0 dawn, 0.25 noon, 0.5 dusk, 0.75 midnight -> which view to hang. */
function clockPhase(dayT) {
  const t = ((dayT % 1) + 1) % 1;
  if (t < 0.06 || (t >= 0.42 && t < 0.6) || t >= 0.9) return 'dusk';
  return t < 0.42 ? 'day' : 'night';
}

/** 1 at noon, 0 at midnight, 0.5 at dawn and dusk. */
function daylight(dayT) {
  return 0.5 + 0.5 * Math.cos(((((dayT % 1) + 1) % 1) - 0.25) * Math.PI * 2);
}

/** Wash laid over a daytime painted view. */
function washPhase(g, w, h, phase) {
  if (phase === 'day') return;
  const night = phase === 'night';
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = night ? '#3c4a7e' : '#f0a072';
  g.fillRect(0, 0, w, h);
  if (night) {
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#fdf6e0';
    g.beginPath();
    g.arc(w * 0.78, h * 0.15, Math.max(6, h * 0.055), 0, 7);
    g.fill();
    for (let i = 0; i < 46; i++) {
      const s = 1 + (i % 2);
      g.globalAlpha = 0.4 + (i % 3) * 0.2;
      g.fillRect((i * 173) % w, (i * 59) % Math.round(h * 0.46), s, s);
    }
    g.globalAlpha = 1;
  } else {
    g.globalCompositeOperation = 'lighter';
    const gl = g.createLinearGradient(0, h * 0.62, 0, 0);
    gl.addColorStop(0, 'rgba(255,120,40,0.34)');
    gl.addColorStop(1, 'rgba(255,80,110,0.08)');
    g.fillStyle = gl;
    g.fillRect(0, 0, w, h * 0.62);
  }
  g.globalCompositeOperation = 'source-over';
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

/**
 * The mountainside past the glass, as the TOP floor sees it: the same ridges
 * and pines as the den downstairs, but the horizon sits lower in the frame and
 * the lodge's own snow-loaded roof runs along the bottom, because up here you
 * are looking out over it.
 */
function texAlps(flip, phase = 'day') {
  return canvasTexture(512, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#84c0e8');
    sky.addColorStop(0.5, '#cfe6f7');
    sky.addColorStop(0.72, '#eaf4fb');
    sky.addColorStop(1, '#f4f9ff');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    g.fillStyle = 'rgba(255,255,255,0.82)';
    for (const [cx, cy, s] of [[96, 34, 1], [268, 22, 0.7], [412, 46, 0.9]]) {
      const x = flip ? w - cx : cx;
      g.beginPath();
      g.arc(x, cy, 17 * s, 0, 7);
      g.arc(x + 20 * s, cy + 5 * s, 12 * s, 0, 7);
      g.arc(x - 18 * s, cy + 6 * s, 11 * s, 0, 7);
      g.fill();
    }

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
    ridge(h * 0.5, [[62, 44, 66], [206, 20, 84], [352, 48, 72], [470, 32, 60]], '#9dbcda', '#e8f3ff');
    ridge(h * 0.63, [[128, 84, 78], [300, 70, 92], [446, 92, 70]], '#7e8a99', '#f4f9ff');

    // the snowfield far below
    g.fillStyle = '#f4f9ff';
    g.beginPath();
    g.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 64) g.quadraticCurveTo(x + 32, h * 0.62 - 14, x + 64, h * 0.62);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();

    // pines, seen from above the treeline: smaller and further down the frame
    for (let i = 0; i < 9; i++) {
      const x = 22 + i * 58 + (flip ? 18 : 0);
      const y = h * 0.72 + ((i * 29) % 26);
      const s = 0.55 + ((i * 37) % 40) / 100;
      g.strokeStyle = '#6b4a34';
      g.lineWidth = 6 * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - 18 * s);
      g.stroke();
      for (let k = 0; k < 3; k++) {
        const ty = y - 16 * s - k * 20 * s;
        const tw = (27 - k * 6) * s;
        g.fillStyle = k % 2 ? '#2f6b4f' : '#24523d';
        g.beginPath();
        g.moveTo(x, ty - 27 * s);
        g.lineTo(x + tw, ty);
        g.lineTo(x - tw, ty);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.moveTo(x, ty - 27 * s);
        g.lineTo(x + tw * 0.52, ty - 11 * s);
        g.lineTo(x - tw * 0.52, ty - 11 * s);
        g.closePath();
        g.fill();
      }
    }

    // the lodge's own roof, banked with snow, running along the bottom: this is
    // the "you are upstairs" cue, and it hides the join between glass and world
    g.fillStyle = '#e7eefb';
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, h * 0.9);
    for (let x = 0; x <= w; x += 48) g.quadraticCurveTo(x + 24, h * 0.86, x + 48, h * 0.9);
    g.lineTo(w, h);
    g.closePath();
    g.fill();
    g.strokeStyle = '#c9d8ee';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(0, h * 0.95);
    for (let x = 0; x <= w; x += 96) g.quadraticCurveTo(x + 48, h * 0.92, x + 96, h * 0.95);
    g.stroke();

    // flakes hanging in the air, so the view never reads as a still photo
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 30; i++) {
      const x = (i * 71) % w;
      const y = 12 + ((i * 53) % (h - 40));
      g.beginPath();
      g.arc(x, y, 2 + (i % 3), 0, 7);
      g.fill();
    }
    g.fillStyle = 'rgba(214,236,255,0.12)';
    g.fillRect(0, 0, w, h);

    washPhase(g, w, h, phase);
  });
}

/** The painted board used for the station signs and the way down. */
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

/** The loft's crest, over the fireplace: the den's own, one storey up. */
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
    fitFont(g, 'LOFT', 50, 25, '900');
    g.fillText('LOFT', S / 2, S * 0.48);
    fitFont(g, 'QUIET, GENIUS AT WORK', 168, 19, 'normal');
    g.fillText('QUIET, GENIUS AT WORK', S / 2, S * 0.84);
  });
}

/** The brass wall clock over the stair head: hands are drawn, the pendulum swings. */
function texClockFace() {
  const S = 192;
  return canvasTexture(S, S, (g) => {
    g.clearRect(0, 0, S, S);
    g.fillStyle = '#fdf0d5';
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 8, 0, 7);
    g.fill();
    g.strokeStyle = '#8a6320';
    g.lineWidth = 9;
    g.stroke();
    g.strokeStyle = OUTLINE;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.lineWidth = i % 3 ? 3 : 6;
      g.beginPath();
      g.moveTo(S / 2 + Math.cos(a) * (S / 2 - 22), S / 2 + Math.sin(a) * (S / 2 - 22));
      g.lineTo(S / 2 + Math.cos(a) * (S / 2 - 34), S / 2 + Math.sin(a) * (S / 2 - 34));
      g.stroke();
    }
    g.lineCap = 'round';
    g.strokeStyle = '#5b3a1e';
    g.lineWidth = 8;
    g.beginPath();
    g.moveTo(S / 2, S / 2);
    g.lineTo(S / 2 + 34, S / 2 - 22);
    g.stroke();
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(S / 2, S / 2);
    g.lineTo(S / 2 - 12, S / 2 - 52);
    g.stroke();
    g.fillStyle = '#e8657a';
    g.beginPath();
    g.arc(S / 2, S / 2, 8, 0, 7);
    g.fill();
    g.fillStyle = 'rgba(90,58,30,0.6)';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, 'COVE TIME', 84, 16, '900');
    g.fillText('COVE TIME', S / 2, S * 0.7);
  });
}

// ===========================================================================
export class LoftRoom extends Room {
  id = 'loft';
  name = 'The Trophy Loft';

  build(scene, game) {
    this.t = 0;
    this._d = new THREE.Object3D();
    this._col = new THREE.Color();
    this._mA = new THREE.Matrix4();
    this._mB = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._game = game;
    this._scene = scene; // the two wall lanterns hang their own meshes
    const rand = rng(51724);

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

    this._phase = 'day';
    this._glowK = 1;

    scene.background = new THREE.Color(0x2b1e14);
    scene.fog = new THREE.Fog(0xd8e8f6, 46, 112);
    this._fog = scene.fog;

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
    this._buildStair(scene, B);
    this._buildFireplace(scene, B, rand);
    this._buildStations(scene, B);
    this._buildSeating(scene, B, rand);
    this._buildDecor(scene, B, rand);

    B.box.build(scene, true, true);
    B.boxFlat.build(scene, false, true);
    B.cyl.build(scene, true, true);
    B.cyl8.build(scene, true, true);
    B.ball.build(scene, true, true);
    B.bead.build(scene, false, true);
    B.cone.build(scene, true, true);

    // --- navigation ---------------------------------------------------------
    // One way out: back down the stair. `from_lounge` stands at the head of it,
    // 3 clear of the exit zone (so arriving never re-fires it) and looking
    // straight up the room at the fire.
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4.4),
      from_lounge: new THREE.Vector3(0, 0, 5.6),
    };
    // Lower and closer than the den's: this room is 4 shallower and its
    // landmark stands on the floor rather than a storey up, so the same 3/4
    // read wants less elevation or the fire slides off the top of the frame.
    this.cameraHint = { offset: new THREE.Vector3(0, 9.0, 13.5), lookHeight: 1.5 };
    // Whole-room vantage: far enough south that the stair well and the doorway
    // at the bottom of it are both in shot, high enough that the two tables and
    // the hearth read at once.
    this.staticCamera = {
      position: new THREE.Vector3(0, 16.5, 21.5),
      lookAt: new THREE.Vector3(0, 2.4, 0.5),
    };

    // Two prompts per station: sit down at the real table, or play the house.
    // Solo runs always clear __matchCtx first, so a match that never started
    // can never turn a later solo run into a phantom duel.
    for (const s of STATIONS) {
      const sit = {
        id: `sit-${s.id}`,
        position: new THREE.Vector3(s.hs[0], 0, s.hs[1]),
        radius: 1.7,
        label: this._sitLabel(s),
        action: (g) => this._onSit(g, s),
      };
      this.hotspots.push(sit);
      this._sitSpots.set(s.id, sit);
      this.hotspots.push({
        id: `play-${s.id}`,
        position: new THREE.Vector3(s.aiAt[0], 0, s.aiAt[1]),
        radius: 1.4,
        label: `Play vs ${s.ai}`,
        action: (g) => {
          g.__matchCtx = null;
          g.startMinigame(s.id);
        },
      });
    }
    // The way down, on the third tread: walking into it travels (the engine
    // auto-fires 'exit-' zones you walk toward). It sits 3.0 south of the
    // stair-head spawn and 1.6 south of the floor edge, so nobody standing on
    // the loft floor is ever inside it.
    this.hotspots.push({
      id: 'exit-lounge',
      position: new THREE.Vector3(0, ST_BOTTOM + 0.8, ST_Z0 + 1.6),
      radius: 1.7,
      label: 'Down to the Game Den',
      action: (g) => g.goToRoom('lounge', 'loft'),
    });

    // Live only while this room is: both handles are dropped in dispose().
    if (game?.events?.on) {
      this._offTable = game.events.on('table', (m) => this._onTable(m));
      this._offMatchStart = game.events.on('match-start', (m) => this._onMatchStart(m));
    }
    for (const s of STATIONS) this._paintChip(s.id);
    // The server sends this room's boards the moment we join, which is ~220ms
    // before this room exists to hear them. The net client keeps the last frame
    // of each table, so read them straight off it rather than starting blank.
    const cached = this._game?.net?.lastTables;
    if (cached?.values) for (const row of cached.values()) this._applyTable(row);
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
      this._leaveSeat('stand');
      return;
    }
    // the server would drop a join at a full table on the floor, and a prompt
    // that does nothing at all feels broken
    if ((this._tables?.get(s.id) || []).length >= s.seats.length) {
      g.toast?.('Both chairs are taken. Watch the duel, or start one of your own!');
      return;
    }
    // One table at a time, so hopping to the other game gives up the old chair
    // first: leave locally as well, or the capybara walks to the new station
    // still folded into the sit pose and still holding the old seat's label.
    if (this._localTable) this._leaveSeat('switch');
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

  /**
   * Give the chair up locally and tell the server. Used by the walk-away guard
   * and by dispose(); the authoritative 'table' broadcast that follows just
   * agrees with what we already did, so the label and the chip never lag.
   */
  _leaveSeat(reason) {
    const game = this._game;
    if (!this._localTable) return;
    game?.net?.send?.({ t: 'table-leave' });
    this._setLocalTable(null, 0);
    this._refreshLabels();
    if (reason === 'walk') game?.toast?.('You wander off, so the chair goes back on offer.');
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

    // pale sky, so a peek past a wall never shows the void
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(75, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xc3dcf1, side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);
    this._skyMat = sky.material;

    // We are one storey up: the ground is a long way down, and what wraps the
    // room is the lodge's own snow-loaded roof.
    const snowfield = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), makeToon(PAL.snow));
    snowfield.rotation.x = -Math.PI / 2;
    snowfield.position.y = -7.2;
    scene.add(snowfield);
    for (const sx of [-1, 1]) {
      box.add(PAL.snow, sx * (HW + 3.4), -0.9, 0, 7.4, 0.4, ZS - ZN + 5, 0, 0, sx * 0.34);
      box.add(PAL.woodMid, sx * (HW + 3.4), -1.16, 0, 7.4, 0.3, ZS - ZN + 5.2, 0, 0, sx * 0.34);
    }
    box.add(PAL.snow, 0, -0.9, ZN - 3.6, 2 * HW + 8, 0.4, 7.2, -0.34, 0, 0);
    box.add(PAL.woodMid, 0, -1.16, ZN - 3.7, 2 * HW + 8, 0.3, 7.4, -0.34, 0, 0);
    // ...and the SOUTH pitch, either side of the stair well. This one is not
    // dressing: the arrival spawn looks down the open south edge, and with the
    // pitch missing the bottom two corners of that first frame were the
    // snowfield seven metres below, which reads as a hole in the world rather
    // than as being upstairs. It starts at |x| 2.6, clear of the well's own
    // walls (outer face 2.34), and falls away from the floor edge.
    for (const sx of [-1, 1]) {
      const x0 = sx * 2.6, x1 = sx * (HW + 3.4);
      const cx = (x0 + x1) / 2, w = Math.abs(x1 - x0);
      box.add(PAL.snow, cx, -1.9, ZS + 3.4, w, 0.4, 7.2, 0.34, 0, 0);
      box.add(PAL.woodMid, cx, -2.16, ZS + 3.5, w, 0.3, 7.4, 0.34, 0, 0);
      // Drifts and icicles on it. A bare pitch is only half the fix: seven
      // metres of unbroken white is still a slab, and this one lands in the
      // bottom quarter of the arrival frame where a slab is most obvious.
      // `roofY` is the pitch's own top surface, so a drift sits ON the roof
      // rather than inside it (the first pass put them all under the snow).
      const roofY = (z) => -0.84 - 0.354 * (z - 8);
      for (let i = 0; i < 4; i++) {
        const dz = ZS + 1.2 + i * 1.6;
        const dx = sx * (3.6 + ((i * 5) % 7) * 0.7);
        ball.add(PAL.snow, dx, roofY(dz) + 0.12, dz, 2.3 + i * 0.3, 0.46, 1.5);
        ball.add(PAL.snowShade, dx + sx * 1.5, roofY(dz + 0.7) + 0.06, dz + 0.7, 1.3, 0.3, 1.0);
      }
      // icicles along the fascia at the floor edge, where the pitch meets the
      // balustrade: the one place on it the camera looks at square-on
      for (let i = 0; i < 5; i++) {
        const ix = sx * (3.1 + i * 1.35);
        cone.add(PAL.snow, ix, roofY(ZS + 0.35) - 0.28, ZS + 0.35, 0.2, 0.62 + (i % 3) * 0.2, 0.2,
          Math.PI, 0, 0);
      }
    }

    // --- the floor ---------------------------------------------------------
    const floorTex = texPlanks();
    floorTex.repeat.set(5, (ZS - ZN) * 0.3125);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * HW, ZS - ZN), this._toonMap(floorTex));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = (ZN + ZS) / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.groundMeshes = [floor];

    // --- walls, with the window openings punched clean through -------------
    const wallMat = makeToon(PAL.wall);
    const mkWall = (width, height, holes) => {
      const s = new THREE.Shape();
      s.moveTo(-width / 2, 0);
      s.lineTo(width / 2, 0);
      s.lineTo(width / 2, height);
      s.lineTo(-width / 2, height);
      s.closePath();
      for (const [x0, x1, lo, hi] of holes) {
        const p = new THREE.Path();
        p.moveTo(x0, lo);
        p.lineTo(x1, lo);
        p.lineTo(x1, hi);
        p.lineTo(x0, hi);
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

    const north = mkWall(2 * HW + 1, WALL_N, []);
    north.position.z = ZN;
    // Wall-local +x maps to world -z on the west and +z on the east, so the
    // west openings are mirrored.
    const holesE = WINZ.map(([a, b]) => [a, b, WIN_LO, WIN_HI]);
    const holesW = holesE.map(([a, b, c, d]) => [-b, -a, c, d]);
    const west = mkWall(ZS - ZN + 0.8, WALL_H, holesW);
    west.rotation.y = Math.PI / 2;
    west.position.set(-HW, 0, 0);
    const east = mkWall(ZS - ZN + 0.8, WALL_H, holesE);
    east.rotation.y = -Math.PI / 2;
    east.position.set(HW, 0, 0);

    // the painted mountainside, hung just outside each run of glass
    this._views = [];
    for (const s of [-1, 1]) {
      const v = new THREE.Mesh(new THREE.PlaneGeometry(16.4, 6.4), this._flat(texAlps(s > 0)));
      v.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      v.position.set(s * (HW + 0.8), 3.1, 0.4);
      scene.add(v);
      this._views.push([v.material, (p) => texAlps(s > 0, p)]);
    }

    // frames, sills, mullions, sill plants
    for (const s of [-1, 1]) {
      for (const [z0, z1] of WINZ) {
        const midY = (WIN_LO + WIN_HI) / 2, h = WIN_HI - WIN_LO;
        const cz = (z0 + z1) / 2, len = z1 - z0;
        const wx = s * (HW - 0.14);
        boxFlat.add(PAL.cream, wx, WIN_HI + 0.1, cz, 0.36, 0.2, len + 0.4);
        boxFlat.add(PAL.cream, wx, WIN_LO - 0.1, cz, 0.36, 0.2, len + 0.4);
        boxFlat.add(PAL.cream, wx, midY, cz - len / 2, 0.36, h, 0.2);
        boxFlat.add(PAL.cream, wx, midY, cz + len / 2, 0.36, h, 0.2);
        boxFlat.add(PAL.cream, wx, midY, cz, 0.28, h, 0.12);
        boxFlat.add(PAL.cream, wx, midY, cz, 0.28, 0.12, len);
        box.add(PAL.woodLight, s * (HW - 0.34), WIN_LO - 0.16, cz, 0.62, 0.16, len + 0.5);
        for (let i = 0; i < 3; i++) {
          ball.add(i % 2 ? PAL.leaf : PAL.leafDark, s * (HW - 0.42), WIN_LO + 0.1,
            cz - len / 3 + i * (len / 3), 0.52, 0.36, 0.52);
        }
      }
    }

    // wainscot, chair rail, top plate, corner posts
    const runs = [
      [0, ZN + 0.1, 2 * HW, 0.2, WALL_N],
      [-HW + 0.1, 0, 0.2, ZS - ZN, WALL_H],
      [HW - 0.1, 0, 0.2, ZS - ZN, WALL_H],
    ];
    for (const [x, z, sx, sz, top] of runs) {
      boxFlat.add(PAL.wainscot, x, 0.62, z, sx, 1.24, sz);
      boxFlat.add(PAL.woodLight, x, 1.3, z, sx + 0.08, 0.16, sz + 0.08);
      boxFlat.add(PAL.wood, x, top - 0.22, z, sx + 0.08, 0.34, sz + 0.08);
      boxFlat.add(PAL.coral, x, 1.5, z, sx, 0.1, sz);
    }
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * (HW - 0.2), WALL_N / 2, ZN + 0.2, 0.4, WALL_N, 0.4);
      box.add(PAL.wood, sx * (HW - 0.2), WALL_H / 2, ZS - 0.24, 0.4, WALL_H, 0.4);
    }

    // Eaves and snow, all of it OUTSIDE the walls: the room stays open to the
    // sky, because the camera rides 9.5 above whoever it is following.
    for (const sx of [-1, 1]) {
      box.add(PAL.woodMid, sx * (HW + 0.42), WALL_H + 0.08, 0, 1.1, 0.22, ZS - ZN + 1.2, 0, 0, sx * 0.12);
      box.add(PAL.snow, sx * (HW + 0.52), WALL_H + 0.28, 0, 1.15, 0.22, ZS - ZN + 1.0, 0, 0, sx * 0.12);
      box.add(PAL.woodLight, sx * (HW + 0.18), WALL_H - 0.08, 0, 0.44, 0.2, ZS - ZN + 1.2);
    }
    box.add(PAL.woodMid, 0, WALL_N + 0.1, ZN - 0.42, 2 * HW + 2.2, 0.24, 1.1, 0.12, 0, 0);
    box.add(PAL.snow, 0, WALL_N + 0.32, ZN - 0.56, 2 * HW + 1.9, 0.22, 1.1, 0.12, 0, 0);
    for (let i = 0; i < 5; i++) {
      ball.add(PAL.snow, -7 + i * 3.5, WALL_N + 0.42, ZN - 0.8, 1.5, 0.42, 0.8);
    }

    // The mountainside OUTSIDE. The walls are 5.6 and the camera rides 9.5 up,
    // so you look straight over them from anywhere near the glass: empty white
    // out there would be a third of the frame. All of it lives beyond |x| 14 /
    // z -12 and BELOW the floor, so it can never come between camera and capy.
    for (let i = 0; i < 26; i++) {
      const a = (i * 2.3999) % TAU;                 // golden-angle scatter
      const rad = 22 + ((i * 7) % 18) + (i % 3) * 2.5;
      const px = Math.cos(a) * rad * 1.3;
      const pz = Math.sin(a) * rad - 5;
      if (Math.abs(px) < 16 || pz > 19) continue;
      const s = 1.6 + ((i * 13) % 9) * 0.3;
      for (let k = 0; k < 3; k++) {
        cone.add(k % 2 ? PAL.pine : PAL.pineDark, px, -7 + s * (0.9 + k * 0.62), pz, s * 1.25, s * 1.1, s * 1.25);
        cone.add(PAL.snow, px, -7 + s * (1.14 + k * 0.62), pz, s * 0.66, s * 0.46, s * 0.66);
      }
      cyl.add(PAL.cocoa, px, -7 + s * 0.45, pz, s * 0.24, s * 0.9, s * 0.24);
      ball.add(PAL.snowShade, px, -7.1, pz, s * 3.2, 0.5, s * 2.6);
    }
    // far ridges, big and hazy, closing the horizon on three sides
    for (const [rx, rz, rs] of [
      [-36, -34, 16], [-14, -44, 20], [14, -48, 18], [35, -30, 15], [44, 0, 13], [-46, 2, 14],
    ]) {
      cone.add(PAL.snowShade, rx, -7 + rs * 0.42, rz, rs * 2.0, rs * 0.9, rs * 1.6);
      cone.add(PAL.snow, rx, -7 + rs * 0.72, rz, rs * 0.9, rs * 0.36, rs * 0.72);
    }

    // --- the balustrade along the open south edge --------------------------
    // One gap in it, WELL_HW either side of centre: the stair. The rail is a
    // union of overlapping circles (see the header) because a walker slides
    // along a rim, so touching circles are a gate, not a fence.
    for (const sx of [-1, 1]) {
      const x0 = sx * WELL_HW, x1 = sx * HW;
      const cx = (x0 + x1) / 2, len = Math.abs(x1 - x0);
      box.add(PAL.wainscot, cx, 0.44, ZS + 0.16, len, 0.88, 0.4);
      box.add(PAL.woodLight, cx, 0.94, ZS + 0.16, len + 0.1, 0.16, 0.56);
      box.add(PAL.coral, cx, 0.56, ZS - 0.06, len - 0.3, 0.22, 0.06);
      const n = Math.max(2, Math.round(len / 1.6));
      for (let i = 0; i <= n; i++) {
        const px = x0 + (x1 - x0) * (i / n);
        box.add(PAL.wood, px, RAIL_Y / 2, ZS + 0.16, 0.2, RAIL_Y + 0.1, 0.44);
        bead.add(PAL.gold, px, RAIL_Y + 0.2, ZS + 0.16, 0.22, 0.22, 0.22);
      }
      const steps = Math.max(1, Math.round(len / RAIL_STEP));
      for (let i = 0; i <= steps; i++) {
        this.obstacles.push({ x: x0 + (x1 - x0) * (i / steps), z: ZS, r: RAIL_R });
      }
    }
  }

  // -------------------------------------------------------------------------
  _buildLights(scene) {
    this._hemi = new THREE.HemisphereLight(0xffe3ba, 0x5a3c24, 0.5);
    scene.add(this._hemi);
    this._amb = new THREE.AmbientLight(0xffeacd, 0.26);
    scene.add(this._amb);

    this._lamps = [];
    // One warm fill per table, one over the middle, one down the stair well.
    // The hearth light (in _buildFireplace) covers the north end.
    for (const [x, y, z, col, i, dist] of [
      [0, 4.0, 1.0, 0xffd8a4, 14, 14],
      [-5.4, 2.6, -1.4, 0xffc890, 12, 11],
      [5.4, 2.6, -1.4, 0xffc890, 12, 11],
      [0, 1.2, ST_Z0 + 1.6, 0xffcf9a, 8, 8],
    ]) {
      const p = new THREE.PointLight(col, i, dist, 2);
      p.position.set(x, y, z);
      p.userData.base = i;
      scene.add(p);
      this._lamps.push(p);
    }

    // one sun raking in through the west windows
    const sun = new THREE.DirectionalLight(0xffe2b4, 0.75);
    sun.position.set(-14, 14, 10);
    sun.target.position.set(1, 0, -2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 16;
    sun.shadow.camera.bottom = -12;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 58;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);
    this._sun = sun;
  }

  // -------------------------------------------------------------------------
  /** World clock (wave 7): the mountainside past the glass goes from afternoon
   *  to alpenglow to moonlit snow, the daylight fades with it, and the hearth,
   *  the lamps and the string lights carry the room after dusk. */
  onClock(dayT) {
    const lit = daylight(dayT);
    const phase = clockPhase(dayT);
    if (phase !== this._phase) {
      this._phase = phase;
      for (const [mat, paint] of this._views) {
        mat.map?.dispose();      // the engine only ever disposes the current one
        mat.map = paint(phase);
        mat.needsUpdate = true;
      }
      const sky = phase === 'night' ? 0x1d2748 : phase === 'dusk' ? 0xe6a074 : 0xc3dcf1;
      this._skyMat.color.setHex(sky);
      if (this._fog) this._fog.color.setHex(phase === 'night' ? 0x2b3a5e : phase === 'dusk' ? 0xe0ae8c : 0xd8e8f6);
    }
    this._sun.intensity = 0.08 + 0.67 * lit;
    this._sun.color.setHex(
      phase === 'night' ? 0xa8bcea : phase === 'dusk' ? 0xffb279 : 0xffe2b4,
    );
    this._hemi.intensity = 0.2 + 0.3 * lit;
    this._amb.intensity = 0.14 + 0.12 * lit;
    for (const p of this._lamps) p.intensity = p.userData.base * (1.55 - 0.55 * lit);
    this._glowK = 1.3 - 0.5 * lit;
  }

  // -------------------------------------------------------------------------
  // THE WAY DOWN: four boxed treads off the south edge into their own well,
  // a landing, and a warm doorway at the bottom with the den's name on it.
  // Every tread is a solid block from the landing up, so the ground snap sees
  // one continuous falling surface (0.4 a step, a third of the 1.2 step range)
  // and walks a capybara down it without a single special case.
  // -------------------------------------------------------------------------
  _buildStair(scene, B) {
    const { box, boxFlat, cyl, bead } = B;
    const W = WELL_HW * 2;

    const steps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(W, 1, ST_GOING), makeToon(PAL.woodMid), ST_N,
    );
    const d = new THREE.Object3D();
    for (let i = 0; i < ST_N; i++) {
      const top = -(i + 1) * ST_RISE;           // walking surface of this tread
      const h = top - (ST_BOTTOM - 0.6);        // solid all the way to the well floor
      d.position.set(0, top - h / 2, ST_Z0 + (i + 0.5) * ST_GOING);
      d.scale.set(1, h, 1);
      d.updateMatrix();
      steps.setMatrixAt(i, d.matrix);
      // pale nosing on the lip of each tread, so the flight reads as steps and
      // not as a ramp from the camera above
      boxFlat.add(PAL.woodLight, 0, top - 0.02, ST_Z0 + i * ST_GOING + 0.07, W - 0.12, 0.08, 0.2);
    }
    steps.castShadow = true;
    steps.receiveShadow = true;
    scene.add(steps);
    this.groundMeshes.push(steps);

    // the landing at the foot, and the well floor under the door
    const land = new THREE.Mesh(new THREE.PlaneGeometry(W, 2.9), makeToon(PAL.wood));
    land.rotation.x = -Math.PI / 2;
    land.position.set(0, ST_BOTTOM, LAND_Z + 0.2);
    land.receiveShadow = true;
    scene.add(land);
    this.groundMeshes.push(land);
    box.add(PAL.woodMid, 0, ST_BOTTOM - 0.4, LAND_Z + 0.2, W + 0.3, 0.8, 3.1);

    // well walls either side, and the fence that keeps a walker on the flight
    for (const sx of [-1, 1]) {
      box.add(PAL.wainscot, sx * (WELL_HW + 0.22), ST_BOTTOM + 0.7, (ST_Z0 + DOOR_Z) / 2,
        0.44, 3.2, DOOR_Z - ST_Z0 + 0.6);
      box.add(PAL.woodLight, sx * (WELL_HW + 0.22), ST_BOTTOM + 2.3, (ST_Z0 + DOOR_Z) / 2,
        0.6, 0.16, DOOR_Z - ST_Z0 + 0.6);
      // raked handrail down the flight
      const run = ST_Z1 - ST_Z0, rise = -ST_BOTTOM;
      const len = Math.hypot(run, rise), rake = -Math.atan2(rise, run);
      box.add(PAL.woodMid, sx * (WELL_HW - 0.12), ST_BOTTOM / 2 + RAIL_Y - 0.05, (ST_Z0 + ST_Z1) / 2,
        0.14, 0.14, len, rake, 0, 0);
      for (let i = 0; i <= ST_N; i++) {
        const pz = ST_Z0 + i * ST_GOING;
        const py = -i * ST_RISE;
        box.add(PAL.wood, sx * (WELL_HW - 0.12), py + RAIL_Y / 2, pz, 0.12, RAIL_Y, 0.12);
        this.obstacles.push({ x: sx * WELL_HW, z: pz, r: 0.5 });
        if (i < ST_N) this.obstacles.push({ x: sx * WELL_HW, z: pz + ST_GOING / 2, r: 0.5 });
      }
      // newel at the head of the flight, where the balustrade stops
      box.add(PAL.wood, sx * WELL_HW, 0.75, ST_Z0 - 0.02, 0.32, 1.5, 0.32);
      bead.add(PAL.gold, sx * WELL_HW, 1.62, ST_Z0 - 0.02, 0.3, 0.32, 0.3);
    }

    // --- the doorway at the bottom -----------------------------------------
    // Faces SOUTH, at the camera: a board turned back into the room would only
    // ever show the camera its back.
    box.add(PAL.wood, 0, ST_BOTTOM + 2.1, DOOR_Z, W + 1.0, 0.42, 0.5);
    for (const sx of [-1, 1]) box.add(PAL.wood, sx * (WELL_HW + 0.1), ST_BOTTOM + 1.0, DOOR_Z, 0.4, 2.2, 0.5);
    // warm light spilling up out of the den below
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(W - 0.1, 2.0),
      new THREE.MeshBasicMaterial({ color: 0xffc477, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    // The camera trails the walker DOWN the flight, so it ends up south of this
    // door too and larger z is nearer. The dark panel is the room beyond and
    // belongs behind the lamplight; in front of it (where it started) it is a
    // black slab with the glow hidden behind it.
    glow.position.set(0, ST_BOTTOM + 1.0, DOOR_Z - 0.10);
    scene.add(glow);
    this._doorGlow = glow;
    boxFlat.add(0x2a1a0e, 0, ST_BOTTOM + 1.0, DOOR_Z - 0.32, W - 0.05, 2.0, 0.2);
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 22),
      new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.2, depthWrite: false }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, ST_BOTTOM + 0.02, DOOR_Z - 1.1);
    scene.add(pool);
    this._doorPool = pool;
    // The den's own lamplight, at the door rather than up the flight. Without
    // it the glow panel is 50% of a warm colour over black, which comes out a
    // dead sage grey in a capture: the doorway has to look like a lit room, not
    // a hole. (The den's matching door upstairs has had this light all along.)
    const lamp = new THREE.PointLight(0xffb968, 9, 8, 2);
    lamp.position.set(0, ST_BOTTOM + 1.5, DOOR_Z - 0.6);
    scene.add(lamp);

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 0.8),
      this._flat(texSign('THE GAME DEN', 'arcade, shuffleboard, cocoa')),
    );
    // south of the lintel (0.5 deep about DOOR_Z), not behind it
    sign.position.set(0, ST_BOTTOM + 2.1, DOOR_Z + 0.28);
    scene.add(sign);
    for (const sx of [-1, 1]) {
      cyl.add(PAL.brass, sx * 0.9, ST_BOTTOM + 2.55, DOOR_Z + 0.28, 0.12, 0.3, 0.12);
      bead.add(0xffe0a8, sx * 0.62, ST_BOTTOM + 1.72, DOOR_Z + 0.24, 0.24, 0.24, 0.24);
    }
  }

  // -------------------------------------------------------------------------
  // THE STAR: the grand stone fireplace on the gable wall, live flames, and
  // the mantel of gold capy trophies over it. It came up here from the den's
  // floor when the loft became its own room, and it is what you see through
  // the stair head from the moment you arrive.
  // -------------------------------------------------------------------------
  _buildFireplace(scene, B, rand) {
    const { box, boxFlat, cyl, cyl8, ball, bead, cone } = B;
    const Y = 0;
    const OPEN_HW = 1.6, OPEN_TOP = Y + 1.75;
    this._fireY = Y;

    // chunky coursed stonework, opening left hollow
    for (let row = 0; row < 6; row++) {
      const y = Y + 0.3 + row * 0.58;
      let x = -3.2;
      while (x < 3.2) {
        const w = 0.66 + rand() * 0.5;
        const inOpening = y < OPEN_TOP && x + w > -OPEN_HW && x < OPEN_HW;
        if (!inOpening) {
          const tone = [PAL.stone, PAL.stoneMid, PAL.stoneDark][(row + ((x * 3) | 0) + 9) % 3];
          box.add(tone, x + w / 2, y, FZ, w, 0.54, 1.2);
        }
        x += w + 0.04;
      }
    }
    // arch across the opening
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * (0.06 + (i / 10) * 0.88);
      box.add(i % 2 ? PAL.stone : PAL.stoneMid,
        Math.cos(a) * 1.85, Y + 1.62 + Math.sin(a) * 0.6, FZ,
        0.42, 0.5, 1.24, 0, 0, -(a - Math.PI / 2) * 0.55);
    }
    // dark firebox behind, so the opening reads as depth not a painted panel
    boxFlat.add(0x21150c, 0, Y + 0.95, -6.9, 3.3, 2.0, 0.9);
    box.add(PAL.stoneDark, 0, Y + 0.09, -6.4, 3.4, 0.18, 1.0);

    // logs and ash, sitting proud of the dark so the firelight catches them
    cyl8.add(PAL.wood, -0.45, Y + 0.3, -6.3, 0.34, 1.5, 0.34, Math.PI / 2, 0.28, 0);
    cyl8.add(PAL.wood, 0.45, Y + 0.3, -6.32, 0.34, 1.5, 0.34, Math.PI / 2, -0.3, 0);
    cyl8.add(PAL.woodMid, 0, Y + 0.5, -6.2, 0.3, 1.3, 0.3, Math.PI / 2, 0.1, 0);
    bead.add(0x54483a, 0, Y + 0.16, -6.24, 2.6, 0.24, 0.8);

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
    fireLight.position.set(0, Y + 1.0, -6.0);
    scene.add(fireLight);
    this._fireLight = fireLight;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.1, 1.9),
      new THREE.MeshBasicMaterial({ color: 0xff9c46, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    glow.position.set(0, Y + 0.95, -6.42);
    scene.add(glow);
    this._fireGlow = glow;

    // dust and sparks turning over in the updraught: the room's ambient loop
    const motes = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.05, 5, 4),
      new THREE.MeshBasicMaterial({ color: 0xffe6b8, transparent: true, opacity: 0.5, depthWrite: false }),
      20,
    );
    this._moteData = [];
    for (let i = 0; i < 20; i++) {
      this._moteData.push({
        t: rand(), sp: 0.06 + rand() * 0.08, x: (rand() - 0.5) * 5.2,
        z: -5.4 + rand() * 2.6, ph: rand() * 6.28,
      });
      d.position.set(0, -9, 0);
      d.updateMatrix();
      motes.setMatrixAt(i, d.matrix);
    }
    motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    motes.frustumCulled = false;
    scene.add(motes);
    this._motes = motes;

    // hearth apron, fire irons, log basket
    box.add(PAL.stoneDark, 0, Y + 0.09, -5.5, 5.6, 0.18, 1.3);
    box.add(PAL.stone, 0, Y + 0.2, -5.5, 5.3, 0.1, 1.1);
    for (const [ix, lean] of [[-2.4, 0.12], [-2.22, -0.1]]) {
      cyl8.add(PAL.steel, ix, Y + 0.6, -5.4, 0.07, 1.2, 0.07, 0, 0, lean);
      bead.add(PAL.brass, ix, Y + 1.24, -5.4, 0.16, 0.16, 0.16);
    }
    cyl.add(PAL.woodMid, 2.5, Y + 0.34, -5.4, 1.1, 0.66, 1.1);
    for (let i = 0; i < 5; i++) {
      cyl8.add(PAL.wood, 2.5 + (i % 2 ? 0.16 : -0.16), Y + 0.62 + i * 0.1, -5.4 + ((i % 3) - 1) * 0.14,
        0.2, 0.9, 0.2, Math.PI / 2, i * 0.5, 0);
    }

    // --- mantel + trophy shelf ---------------------------------------------
    box.add(PAL.wood, 0, Y + 2.35, -6.1, 7.0, 0.4, 1.9);
    box.add(PAL.woodLight, 0, Y + 2.6, -6.1, 7.2, 0.1, 2.0);
    const band = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 0.28), this._flat(texMantelBand()));
    band.position.set(0, Y + 2.35, -5.14);
    scene.add(band);

    // One little gold capy per den game, echoing the avatar's proportions in
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
    for (let i = 0; i < 5; i++) this._trophyAt.push([-2.6 + i * 1.3, Y + 2.65, -5.8]);
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

    // chimney breast + crest, running up the gable to just under the eaves
    box.add(PAL.stoneMid, 0, Y + 3.65, -6.6, 2.6, 2.2, 1.0);
    box.add(PAL.stone, 0, Y + 4.85, -6.6, 2.9, 0.3, 1.2);
    const crest = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), this._flat(texCrest()));
    crest.position.set(0, Y + 3.7, -6.08);
    scene.add(crest);
    for (const s of [-1, 1]) {
      cone.add(PAL.brass, s * 1.55, Y + 3.3, -6.05, 0.28, 0.42, 0.28, Math.PI, 0, 0);
      bead.add(0xffe0a8, s * 1.55, Y + 3.06, -6.05, 0.24, 0.24, 0.24);
    }

    // The hearth's footprint. The flanks are 0.85, not 1.25, and that is
    // load-bearing: at 1.25 they bit into the armchair circles, and the lens
    // where two obstacle circles overlap is a trap (WalkController pushes you
    // onto one rim, the other pushes you back, and you walk on the spot).
    // 0.85 is the smallest circle that still covers the stonework corners
    // (hypot(0.6, 0.6) = 0.849).
    this.obstacles.push(
      { x: 0, z: -6.5, r: 2.0 },
      { x: -2.6, z: -6.5, r: 0.85 },
      { x: 2.6, z: -6.5, r: 0.85 },
      { x: 0, z: -5.5, r: 1.05 },
    );
  }

  // -------------------------------------------------------------------------
  // the two duel tables
  // -------------------------------------------------------------------------
  _buildStations(scene, B) {
    this._rings = [];
    this._chess(scene, B, STATION_BY_ID.get('chess'));
    this._cards(scene, B, STATION_BY_ID.get('cards'));

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
      const h = 2.3;
      const yaw = Math.atan2(-sx, 12 - sz);
      const nx = Math.sin(yaw), nz = Math.cos(yaw);
      cyl.add(PAL.wood, sx, (h + 0.35) / 2, sz, 0.18, h + 0.35, 0.18);
      box.add(PAL.woodMid, sx, h, sz, 1.86, 0.74, 0.1, 0, yaw, 0);
      bead.add(PAL.gold, sx, h + 0.46, sz, 0.22, 0.22, 0.22);
      // SIGN_OUT, not the 0.07 this was copied from downstairs: the post is
      // 0.09 of radius about the board's own centre line, so a face standing
      // 0.07 proud of it had the post's front growing straight through the
      // middle of the lettering (every board read "CAPY C|LASH" from the play
      // camera). 0.13 puts the canvas in front of the post it hangs on.
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.76, 0.66), this._flat(texSign(s.name, s.sub)));
      face.position.set(sx + nx * SIGN_OUT, h, sz + nz * SIGN_OUT);
      face.rotation.y = yaw;
      scene.add(face);

      // the chip hangs off the bottom of the board on two little brass hooks
      box.add(PAL.woodMid, sx, h - 0.56, sz, 1.6, 0.44, 0.09, 0, yaw, 0);
      for (const hx of [-0.62, 0.62]) {
        bead.add(PAL.brass, sx + Math.cos(yaw) * hx, h - 0.37, sz - Math.sin(yaw) * hx, 0.1, 0.16, 0.1);
      }
      const tex = texChip();
      const chip = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 0.375),
        this._flat(tex, { transparent: true, depthWrite: false }),
      );
      chip.position.set(sx + nx * (SIGN_OUT + 0.005), h - 0.56, sz + nz * (SIGN_OUT + 0.005));
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
        cyl.add(PAL.wood, gx, 0.25, gz, 0.1, 0.5, 0.1);
      }
    }
    for (const lx of [-0.3, 0.3]) {
      const [gx, gz] = at(lx, -0.32);
      cyl.add(PAL.wood, gx, pad + 0.5, gz, 0.11, 1.0, 0.11, 0, yaw, 0);
    }
    for (const [ly, h] of [[0.62, 0.2], [0.9, 0.16]]) {
      const [gx, gz] = at(0, -0.32);
      box.add(PAL.woodMid, gx, pad + ly, gz, 0.68, h, 0.08, 0, yaw, 0);
    }
  }

  /** CARDS: round green felt, a fanned hand, element tokens, wall lantern. */
  _cards(scene, B, s) {
    const { cyl, bead } = B;
    const [x, z] = s.at;
    const TOP = 0.8;
    cyl.add(PAL.wood, x, TOP - 0.06, z, 2.4, 0.14, 2.4);
    cyl.add(PAL.woodMid, x, 0.4, z, 0.5, 0.8, 0.5);
    cyl.add(PAL.wood, x, 0.07, z, 1.4, 0.14, 1.4);
    const felt = new THREE.Mesh(new THREE.CircleGeometry(1.1, 30), this._toonMap(texFelt()));
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
      fan.push([x + Math.sin(a) * 0.6, TOP + 0.03 + i * 0.003, z + 0.66 - Math.cos(a) * 0.12, -a]);
    }
    for (let i = 0; i < 4; i++) deck.push([x - 0.56, TOP + 0.03 + i * 0.012, z - 0.44, 0.3 + i * 0.04]);
    lay(this._flat(texCard(), { side: THREE.DoubleSide }), fan);
    lay(this._flat(texCardBack(), { side: THREE.DoubleSide }), deck);
    for (const [col, dx, dz] of [[PAL.coral, -0.3, 0], [PAL.sky, 0.1, -0.24], [PAL.gold, 0.3, 0.16], [PAL.plum, -0.1, 0.3]]) {
      cyl.add(col, x + dx, TOP + 0.06, z + dz, 0.3, 0.1, 0.3);
      bead.add(0xfff6e3, x + dx, TOP + 0.12, z + dz, 0.14, 0.04, 0.14);
    }
    // A lantern on a bracket off the west wall, not a pendant: there is no
    // ceiling to hang one from, and anything tall enough to see over the table
    // would stand between the camera and whoever walks past it. It hangs at
    // LAMP_Z rather than beside the table: see the note on that constant.
    this._wallLamp(B, -HW, LAMP_Z, 2.35, PAL.coral, 1);

    this.obstacles.push({ x, z, r: 1.3 });
  }

  /** Bracket lantern on a side wall. `side` is +1 for the west wall, -1 east. */
  _wallLamp(B, wallX, z, y, col, side) {
    const { box, bead } = B;
    const dx = side * 0.9;
    box.add(PAL.wood, wallX + dx * 0.38, y + 0.34, z, 1.0, 0.09, 0.09);
    box.add(PAL.wood, wallX + dx * 0.12, y + 0.62, z, 0.09, 0.56, 0.09);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.46, 0.4, 12, 1, true),
      makeToon(col, { side: THREE.DoubleSide }),
    );
    shade.position.set(wallX + dx * 0.75, y + 0.2, z);
    this._scene.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), makeGlow(0xffe2ac));
    bulb.position.set(wallX + dx * 0.75, y + 0.06, z);
    this._scene.add(bulb);
    bead.add(PAL.brass, wallX + dx * 0.75, y + 0.42, z, 0.14, 0.14, 0.14);
  }

  /** CHESS: heavy table, oversized pieces caught mid-game. */
  _chess(scene, B, s) {
    const { box, cyl, cone, ball, bead } = B;
    const [x, z] = s.at;
    const TOP = 0.72;
    box.add(PAL.wood, x, TOP - 0.08, z, 2.2, 0.18, 2.2);
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        box.add(PAL.woodMid, x + dx * 0.82, (0.72 - 0.16) / 2, z + dz * 0.82, 0.22, 0.72 - 0.16, 0.22);
      }
    }
    box.add(PAL.woodMid, x, 0.24, z, 1.7, 0.12, 0.16);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.86, 1.86), this._toonMap(texChessBoard()));
    board.rotation.x = -Math.PI / 2;
    board.position.set(x, TOP + 0.02, z);
    board.receiveShadow = true;
    scene.add(board);
    this._wallLamp(B, HW, LAMP_Z, 2.35, PAL.sky, -1);

    const cell = 1.86 / 8;
    const light = 0xf4e2bb, dark = 0x53331d;
    const piece = (cx, cz, col, kind) => {
      const px = x - 0.93 + (cx + 0.5) * cell;
      const pz = z - 0.93 + (cz + 0.5) * cell;
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
    cyl.add(light, x + 1.24, TOP + 0.06, z + 0.4, 0.2, 0.12, 0.2, 0.3, 0, 1.3);
    cyl.add(dark, x + 1.24, TOP + 0.06, z - 0.3, 0.2, 0.12, 0.2, 0.2, 0, 1.4);

    this.obstacles.push({ x, z, r: 1.3 });
  }

  // -------------------------------------------------------------------------
  // rugs, armchairs by the fire, cushions, the cocoa table
  // -------------------------------------------------------------------------
  _buildSeating(scene, B, rand) {
    const { box, cyl, ball, bead } = B;

    // rugs stay flat decoration: never in groundMeshes, so the bot zone floor
    // stays exactly one raycast surface
    const hearthRug = new THREE.Mesh(new THREE.CircleGeometry(2.3, 32), this._toonMap(texRug(1)));
    hearthRug.rotation.x = -Math.PI / 2;
    hearthRug.position.set(0, 0.012, -4.2);
    hearthRug.receiveShadow = true;
    scene.add(hearthRug);
    for (const sx of [-1, 1]) {
      const tableRug = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.0), this._toonMap(texRug(0)));
      tableRug.rotation.set(-Math.PI / 2, 0, sx * 0.06);
      tableRug.position.set(sx * 5.4, 0.01, -2.0);
      scene.add(tableRug);
    }

    // two leather-look armchairs pulled up to the fire. Built on the SHARED
    // batches (the den built them from loose meshes, which was 22 draw calls
    // for the pair): local space faces +z and is rotated into place.
    for (const sx of [-1, 1]) {
      const x = sx * 2.6, z = -3.9;
      const yaw = Math.atan2(0 - x, -6.6 - z);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
      const put = (batch, col, lx, ly, lz, w, h, dp) => {
        const [gx, gz] = at(lx, lz);
        batch.add(col, gx, ly, gz, w, h, dp, 0, yaw, 0);
      };
      put(box, PAL.leatherDark, 0, 0.36, 0, 1.24, 0.34, 1.16);
      put(ball, PAL.leather, 0, 0.58, 0.04, 1.24, 0.34, 1.1);
      put(box, PAL.leather, 0, 1.02, -0.52, 1.3, 1.1, 0.3);
      for (const ax of [-1, 1]) {
        put(box, PAL.leather, ax * 0.62, 0.82, 0.02, 0.26, 0.4, 1.06);
        put(ball, PAL.leatherDark, ax * 0.62, 1.02, 0.02, 0.26, 0.26, 1.02);
        for (const az of [-1, 1]) put(cyl, PAL.wood, ax * 0.5, 0.1, az * 0.45, 0.18, 0.2, 0.18);
      }
      this.obstacles.push({ x, z, r: 0.75 });
    }

    // floor cushions on the hearth rug
    for (const [cx, cz, col] of [[-1.3, -4.4, PAL.gold], [1.3, -4.4, PAL.plum]]) {
      ball.add(col, cx, 0.19, cz, 0.98, 0.38, 0.98, 0, rand() * 3, 0);
      bead.add(0xfff6e3, cx, 0.34, cz, 0.12, 0.06, 0.12);
    }

    // The cocoa table, in the south-east corner where the loft's own hangout
    // spot is: the middle has to stay a through route between the wings.
    const [tx, tz] = [5.6, 4.4];
    cyl.add(PAL.woodMid, tx, 0.44, tz, 1.7, 0.12, 1.7);
    cyl.add(PAL.wood, tx, 0.22, tz, 0.34, 0.44, 0.34);
    cyl.add(PAL.wood, tx, 0.05, tz, 1.0, 0.1, 1.0);
    for (let i = 0; i < 3; i++) {
      box.add([PAL.coral, PAL.sky, PAL.gold][i], tx - 0.24, 0.56 + i * 0.11, tz,
        0.72, 0.1, 0.52, 0, i * 0.25, 0);
    }
    this._mugs = [];
    for (const [mx, mz] of [[tx + 0.44, tz - 0.2], [tx + 0.2, tz + 0.42]]) {
      cyl.add(PAL.cream, mx, 0.6, mz, 0.3, 0.2, 0.3);
      cyl.add(PAL.cocoa, mx, 0.7, mz, 0.25, 0.02, 0.25);
      bead.add(0xfff6e3, mx + 0.09, 0.72, mz, 0.09, 0.07, 0.09);
      this._mugs.push([mx, 0.74, mz]);
    }
    this.obstacles.push({ x: tx, z: tz, r: 0.9 });

    // steam curling off the cocoa
    const steam = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.09, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xfff4e2, transparent: true, opacity: 0.3, depthWrite: false }),
      12,
    );
    this._steamData = [];
    const d = new THREE.Object3D();
    for (let i = 0; i < 12; i++) {
      this._steamData.push({ t: i / 12, sp: 0.4 + (i % 4) * 0.07, ph: i * 1.9, mug: i % 2 });
      d.position.set(0, -9, 0);
      d.updateMatrix();
      steam.setMatrixAt(i, d.matrix);
    }
    steam.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    steam.frustumCulled = false;
    scene.add(steam);
    this._steam = steam;

    // two stools by the cocoa table
    for (const [ox, oz] of [[-1.5, 0.5], [-1.4, -0.9]]) {
      const px = tx + ox, pz = tz + oz;
      cyl.add(PAL.woodLight, px, 0.62, pz, 0.76, 0.12, 0.76);
      ball.add(PAL.gold, px, 0.72, pz, 0.7, 0.18, 0.7);
      for (let l = 0; l < 3; l++) {
        const a = (l / 3) * Math.PI * 2 + 0.6;
        cyl.add(PAL.wood, px + Math.cos(a) * 0.2, 0.31, pz + Math.sin(a) * 0.2, 0.09, 0.62, 0.09,
          Math.sin(a) * 0.16, 0, -Math.cos(a) * 0.16);
      }
    }
  }

  // -------------------------------------------------------------------------
  // bookshelves, champion portraits, string lights, the cove clock
  // -------------------------------------------------------------------------
  _buildDecor(scene, B, rand) {
    const { box, boxFlat, cyl, bead, cone } = B;

    // --- bookshelves in the solid stretches of the side walls ---------------
    // Local +z faces into the room for both yaws, so one builder does all four.
    // z picked to clear the window runs AND to keep their collider circles from
    // overlapping the balustrade's (two circle rims that cross make a lens a
    // walker can stand in and shuffle on the spot).
    for (const [x, z, yaw] of [
      [-HW + 0.55, -4.4, Math.PI / 2], [HW - 0.55, -4.4, -Math.PI / 2],
      [-HW + 0.55, 4.6, Math.PI / 2], [HW - 0.55, 4.6, -Math.PI / 2],
    ]) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
      const put = (batch, col, lx, ly, lz, w, h, dp, roll = 0) => {
        const [gx, gz] = at(lx, lz);
        batch.add(col, gx, ly, gz, w, h, dp, 0, yaw, roll);
      };
      put(box, PAL.wood, 0, 1.15, 0, 2.4, 2.3, 0.7);
      put(boxFlat, 0x5d3a1e, 0, 1.2, 0.02, 2.1, 2.05, 0.66);
      for (let sh = 0; sh < 3; sh++) {
        const sy = 0.34 + sh * 0.62;
        put(boxFlat, PAL.woodLight, 0, sy, 0.06, 2.2, 0.1, 0.66);
        let bx = -0.92;
        while (bx < 0.78) {
          const w = 0.16 + rand() * 0.12;
          const hgt = 0.4 + rand() * 0.16;
          const col = [PAL.coral, PAL.sky, PAL.gold, PAL.leaf, PAL.plum, PAL.cream][(rand() * 6) | 0];
          put(box, col, bx + w / 2, sy + 0.06 + hgt / 2, 0.06, w, hgt, 0.52, (rand() - 0.5) * 0.12);
          bx += w + 0.03;
        }
      }
      put(box, PAL.woodLight, 0, 2.34, 0, 2.6, 0.14, 0.86);
      const [gx, gz] = at(-0.8, 0);
      cyl.add(PAL.terracotta, gx, 2.52, gz, 0.4, 0.28, 0.4);
      cone.add(PAL.leafDark, gx, 2.82, gz, 0.5, 0.54, 0.5);
      // two circles down the 2.4 of carcass, not one: a single fat bubble here
      // would reach 0.9 into the room at the ends and nothing in the middle
      for (const lx of [-0.6, 0.6]) {
        const [ox, oz] = at(lx, 0);
        this.obstacles.push({ x: ox, z: oz, r: 0.8 });
      }
    }

    // --- the wall of framed champions, on the gable either side of the fire --
    for (const side of [0, 1]) {
      const sx = side ? 1 : -1;
      for (let i = 0; i < 3; i++) {
        const x = sx * (4.8 + i * 1.25);
        const cfg = CHAMPIONS[side * 3 + i];
        const y = i === 1 ? 3.9 : 3.4;
        boxFlat.add(0x6b4a2c, x, y, ZN + 0.2, 1.16, 1.34, 0.1);   // frame
        boxFlat.add(PAL.brass, x, y, ZN + 0.26, 1.02, 1.2, 0.08); // mat
        const p = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 1.08), this._flat(texPortrait(cfg)));
        p.position.set(x, y, ZN + 0.32);
        scene.add(p);
        cyl.add(PAL.brass, x, y + 0.86, ZN + 0.42, 0.14, 0.3, 0.14, 0.9, 0, 0);
        bead.add(0xffe0a8, x, y + 0.74, ZN + 0.54, 0.15, 0.15, 0.15);
      }
    }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), this._flat(texBanner('HALL OF CHAMPIONS')));
    banner.position.set(0, 6.1, ZN + 0.3);
    scene.add(banner);

    // --- the cove clock over the stair head ---------------------------------
    // It ticks: the pendulum below it swings on the room's own timer, which is
    // the quiet loop this floor gets instead of the arcade downstairs.
    const clock = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1),
      this._flat(texClockFace(), { transparent: true }));
    clock.position.set(-HW + 0.36, 3.5, 2.6);
    clock.rotation.y = Math.PI / 2;
    scene.add(clock);
    box.add(PAL.wood, -HW + 0.28, 3.5, 2.6, 0.14, 1.3, 1.3);
    box.add(PAL.wood, -HW + 0.28, 2.5, 2.6, 0.14, 0.9, 0.5);
    const pend = new THREE.Group();
    pend.position.set(-HW + 0.4, 2.9, 2.6);
    scene.add(pend);
    const rod = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), makeToon(PAL.brass));
    rod.position.y = -0.35;
    pend.add(rod);
    const bob = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 12), makeToon(PAL.gold));
    bob.rotation.z = Math.PI / 2;
    bob.rotation.y = Math.PI / 2;
    bob.position.y = -0.68;
    pend.add(bob);
    this._pendulum = pend;

    // --- potted plants in the two north corners ------------------------------
    // Clear of both the bookshelf circles (nearest is 1.64 away, they need 1.5)
    // and the hearth's, so no walker ever finds an overlap lens up here.
    for (const [x, z] of [[-HW + 0.9, -6.6], [HW - 0.9, -6.6]]) {
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

    // --- string lights: two runs down the walls and one over the stair head --
    const bulbs = [], cord = [];
    for (const [x0, y0, z0, x1, y1, z1] of [
      [-HW + 0.5, 4.6, -6.0, -HW + 0.5, 4.6, 6.0],
      [HW - 0.5, 4.6, -6.0, HW - 0.5, 4.6, 6.0],
      [-HW + 0.5, 4.4, 6.2, HW - 0.5, 4.4, 6.2],
    ]) {
      const n = 16;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = [
          x0 + (x1 - x0) * u,
          y0 + (y1 - y0) * u - Math.abs(Math.sin(u * Math.PI * 4)) * 0.2,
          z0 + (z1 - z0) * u,
        ];
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
  update(dt) {
    const t = (this.t += dt);
    const d = this._d;

    // fire
    for (let i = 0; i < this._flameData.length; i++) {
      const f = this._flameData[i];
      const k = 0.62 + 0.32 * Math.sin(t * f.sp + f.ph) + 0.12 * Math.sin(t * f.sp * 2.7 + f.ph);
      const hgt = f.s * (0.7 + k * 0.75);
      d.position.set(f.x + Math.sin(t * 1.7 + f.ph) * 0.05, this._fireY + 0.3 + hgt / 2, f.z);
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
      d.position.set(e.x + Math.sin(f * 6 + e.ph) * 0.3, this._fireY + 0.5 + f * 2.2,
        -6.35 + Math.cos(f * 4 + e.ph) * 0.14);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(Math.max(0, 1 - f) * (0.7 + Math.sin(f * 12 + e.ph) * 0.3));
      d.updateMatrix();
      this._embers.setMatrixAt(i, d.matrix);
    }
    this._embers.instanceMatrix.needsUpdate = true;

    // dust turning over in the firelight
    for (let i = 0; i < this._moteData.length; i++) {
      const m = this._moteData[i];
      m.t += dt * m.sp;
      if (m.t > 1) m.t -= 1;
      const f = m.t;
      d.position.set(m.x + Math.sin(f * 4 + m.ph) * 0.5, 0.3 + f * 3.2, m.z + Math.cos(f * 3 + m.ph) * 0.4);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(0.6 + Math.sin(f * Math.PI) * 0.7);
      d.updateMatrix();
      this._motes.setMatrixAt(i, d.matrix);
    }
    this._motes.instanceMatrix.needsUpdate = true;

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

    // string lights twinkle (harder after dusk: see onClock)
    for (let i = 0; i < this._bulbSeed.length; i++) {
      const k = (0.7 + 0.3 * Math.sin(t * 2.0 + this._bulbSeed[i])) * this._glowK;
      this._col.setRGB(k, k * 0.86, k * 0.6);
      this._bulbs.setColorAt(i, this._col);
    }
    this._bulbs.instanceColor.needsUpdate = true;

    // the cove clock keeps time
    this._pendulum.rotation.z = Math.sin(t * 2.2) * 0.28;

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

    // prompt markers breathe. Rings alternate sit / house-opponent, and the
    // house ring stays the quieter of the two so the real table reads first.
    for (let i = 0; i < this._rings.length; i++) {
      const p = Math.sin(t * 2.1 + i * 1.3);
      const base = i % 2 ? 0.2 : 0.34;
      this._rings[i].material.opacity = base + p * (i % 2 ? 0.09 : 0.16);
      this._rings[i].scale.setScalar(1 + p * 0.05);
    }
    // the den's warmth coming up the stair
    const q = Math.sin(t * 1.7);
    this._doorGlow.material.opacity = 0.44 + q * 0.08;
    this._doorPool.material.opacity = 0.18 + q * 0.06;
    this._doorPool.scale.setScalar(1 + q * 0.04);

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

    // Keep the local capybara settled in their chair while they wait, and take
    // the chair back off them the moment they wander off it. A walk whose
    // destination IS the chair is exempt, because that is exactly what
    // _setLocalTable orders up when the seat is granted.
    const engine = this._game?.engine;
    const avatar = engine?.playerAvatar;
    const st = this._localTable ? STATION_BY_ID.get(this._localTable) : null;
    const seat = st?.seats[this._localSeat];
    if (seat && avatar) {
      const g = avatar.group;
      const tgt = engine.controller?.target;
      const away = Math.hypot(g.position.x - seat[0], g.position.z - seat[1]);
      const bound = !!tgt && Math.hypot(tgt.x - seat[0], tgt.z - seat[1]) < 0.7;
      if (away > 1.6 && !bound) {
        this._leaveSeat('walk');
      } else if (!tgt && away < 0.6) {
        if (avatar.state.anim !== 'sit') avatar.setAnim('sit');
        g.position.y = SEAT_Y;
        const yaw = seatYaw(st, this._localSeat);
        const dy = ((((yaw - g.rotation.y) % TAU) + Math.PI * 3) % TAU) - Math.PI;
        g.rotation.y += dy * Math.min(1, dt * 6);
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
    this._scene = null;
    this._flames = null;
    this._flameData = null;
    this._embers = null;
    this._emberData = null;
    this._motes = null;
    this._moteData = null;
    this._fireLight = null;
    this._fireGlow = null;
    this._trophy = null;
    this._trophyAt = null;
    this._bulbs = null;
    this._bulbSeed = null;
    this._pendulum = null;
    this._views = null;
    this._skyMat = null;
    this._fog = null;
    this._sun = null;
    this._lamps = null;
    this._steam = null;
    this._steamData = null;
    this._mugs = null;
    this._rings = null;
    this._doorGlow = null;
    this._doorPool = null;
    this._toonMap = null;
    this._flat = null;
  }
}
