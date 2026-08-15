import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BOT_ZONES } from '../../../shared/constants.js';
import { getOverrides } from '../layout.js';

// ---------------------------------------------------------------------------
// The Game Den: the warm timber games room INSIDE the Frosty Peak ski lodge.
// Floor plus three walls, the south side open to the camera; the door leads
// back out onto the mountain, so every window looks at snow, pines and the far
// ridges.
//
//   THE FLOOR (loud): four corner territories around one open middle. The
//   arcade cabinet is hard against the west wall, the four-in-a-row stand is
//   angled across the south-west, the shuffleboard runs down the east wall and
//   the cocoa bar is tucked into the south-east behind the stair foot; the rug,
//   the door and the walking lanes between them are everything else. See the
//   STATIONS table for the plan and the rules it obeys.
//   THE NORTH WALL: the room's landmark. A painted map of the whole cove on a
//   hanging tapestry, the den crest over it, the long console under it, and
//   the game-box shelves either side.
//   THE STAIR, up the east wall, leads to a lit doorway and 'THE TROPHY LOFT':
//   its own room ('loft', src/world/rooms/loft.js) with the fireplace, the
//   trophies, the Hall of Champions, chess and Capy Clash in it. Walking up
//   the flight crosses 'exit-loft' and travels; you come back out at the foot.
//
// It used to be one room on two floors: a timber mezzanine at y 3.2 with the
// hearth and the two quiet tables on it. That is gone, and this is why. A
// balcony is opaque from a 3/4 camera 14 south and 9.5 up, so the whole north
// third of the ground floor was scenery under a deck nobody could see into;
// the rail circles that stopped people falling off the deck also walled the
// floor below off at the same line (obstacle circles are 2D); and the two
// storeys had to share one camera, one static vantage and one set of prompts.
// Splitting the loft into its own instance gave BOTH halves their whole room
// back: the north end down here is walkable ground with a landmark on it, and
// upstairs is composed for its own camera.
//
// The chairs are the multiplayer half of the room (wave 4). Every station is
// a two-seat table on the server (protocol in CLAUDE.md / src/net/client.js):
//   out  {t:'table-join', game} {t:'table-leave'}
//   in   'table' {game, players:[{id,name}]}
//        'match-start' {game, players, youAre, seed}  -> game.__matchCtx + start
// Seated capybaras are drawn here from the table roster (their networked body
// is un-parented while they sit, exactly like the peak race lobby), and each
// sign carries a live status chip: OPEN / "<name> waits a rival!" / MATCH LIVE.
// A seated capy who simply walks away gives the chair up (see _updateTables).
//
// Everything is procedural: canvas textures for signs, boards, felts, rugs and
// the champion portraits; InstancedMesh batches for the hundreds of small
// props, which keeps the room at about 105 draw calls.
//
// Framing rules the layout obeys, all of them found by screenshot:
//   * NOTHING overhead. The camera rides 9.5 above the player: a ceiling, a
//     rafter or a roof at lodge height would put itself between the two. The
//     lodge is a cutaway: walls, eaves and snow on the OUTSIDE, open sky above;
//   * the doorway has posts but NO lintel (the cafe's lesson): with the camera
//     14 behind the player, a lintel at z 8.3 lands exactly on the head of
//     anyone standing on the default spawn;
//   * the stair is the one thing in the room that climbs, and it climbs up the
//     east wall away from every sight line; its treads stay real ground meshes
//     so you walk up them into the loft door rather than teleporting.
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
// 16 deep, matching the shack: with the follow camera 14 back and 9.5 up,
// the whole north wall compresses into the top ~20px of the frame, so a room
// any deeper than this hides its own landmark from the arrival spawn.
const ZN = -7;        // north wall (inner face)
const ZS = 9;         // south edge of the floor
const WALL_H = 6.4;   // side walls
const WALL_N = 8.8;   // north gable: it carries the cove tapestry and the crest
const DZ = 8.3;       // doorway posts
const ZONE = BOT_ZONES.lounge; // { x: 0, z: 2, r: 4 }

// --- the stair to the Trophy Loft ------------------------------------------
// It boxes up the east wall and climbs north to a landing and a lit doorway.
// Rise 0.4 a step is well inside the 1.2 ground snap, so it walks as one
// continuous ramp; the landing is the only walkable ground up here, and
// 'exit-loft' fires on the way up it.
const LOFT_Y = 3.2;              // landing / doorway threshold
const ST_X0 = 8.7, ST_X1 = HW;   // west rail / east wall
const ST_Z0 = 3.6;               // bottom tread, at the foot by the cocoa bar
const ST_N = 8;
const ST_RISE = LOFT_Y / ST_N;   // 0.4
const ST_TOP_Z = -2.2;           // top tread
const ST_GOING = (ST_Z0 - ST_TOP_Z) / ST_N; // 0.725
const LAND_Z = -3.4;             // landing, between the top tread and the door
const DOOR_Z = -4.15;            // the loft doorway itself
// Collider spacing. "Just overlap them" is NOT enough to make a wall out of
// circles: WalkController pushes you onto a circle's rim and then slides you
// along it toward your target, so two circles 0.9 apart squeeze you onto their
// centre line, where the rim normal is sideways and the slide tangent points
// straight through the fence. At 0.45 every point of the line is deep inside
// three or more circles and the push-out always has a component back the way
// you came.
const RAIL_STEP = 0.45;
const RAIL_Y = 0.92;
const RAIL_R = 0.6;

// How far a painted sign face stands proud of its own post (radius 0.09).
const SIGN_OUT = 0.13;

// Window openings, given in WORLD z and mirrored onto both side walls. Tall:
// with the mezzanine gone the side walls are 6.4 of plaster from the wainscot
// up, and the room's whole reason to be inside a ski lodge is the mountain
// past the glass, so the openings run from just over the chair rail to the
// eaves and the north end got a run of its own.
const WINZ = [[-6.3, -3.4], [-1.2, 2.0], [3.8, 7.0]];
const WIN_LO = 1.85, WIN_HI = 4.75;
// A clerestory over the whole run, above the tall glass. Not for the view, for
// the frame: at the top of the stair the camera sits a metre off the east wall,
// and blank plaster up there filled a third of the shot until the daylight went
// through it.
const WINZ_UP = [[-6.0, 6.6, 5.25, 6.05]];

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const OUTLINE = '#2d2417';

// Every station in one table so the floor plan is auditable at a glance: where
// the prop stands, where each of its two prompts fires, where its sign post
// goes, and where its two chairs sit. Chess and Capy Clash are NOT here any
// more: they are upstairs in src/world/rooms/loft.js, with the same table.
//
// FLOOR PLAN (playtest note: "the games are too close and it is hard to tell
// what game is what"). Four corner territories around the open rug, with a
// walking lane between every pair:
//
//        x -11 ..................... 0 ..................... x +11
//   z -2  [ PADDLE PANIC ]        (open rug / bot circle)   [ SHUFFLE ]
//         cabinet on the west      the room's crossroads     board on the
//   z  1  wall, chairs and         stays plain floor         east wall, chairs
//         prompts facing east                                facing east
//   ---- west lane (z 1..3) ------------------- east lane (z 3.5..4.8) -------
//   z  4  [ FOUR IN A ROW ]                                 [ COCOA BAR ]
//   z  6  angled across the        the door and the          tucked into the
//         south-west corner        beanbag are the middle    south-east corner
//
// Layout rules the numbers obey, all of them checked against the obstacle list:
//   * chairs sit clear of every collider (+0.15) and at least 0.9 from their
//     own sign post, so nothing grows through a capybara's hat;
//   * `hs` (sit down) and `aiAt` (play the house) are ~1.4 apart with most of
//     that in z, because the camera trails 14 south: two prompts separated in
//     x land on top of each other, separated in z they stack neatly;
//   * ONE named sign per station, and no two stations' signs, chairs or prompt
//     rings may overlap on screen from the arrival spawn. The camera trades
//     height against depth (a 4-high board four metres nearer the lens paints
//     over a 3-high cabinet behind it), so stations are separated by ANGLE:
//     a station's whole cluster keeps its own |x| / depth band;
//   * nothing a player needs to read sits south of z ~6.8: the planted half
//     wall by the door cuts the camera's line to the floor beyond that;
//   * every station keeps its whole collider footprint outside the bot circle
//     (0, 2, r 4), which stays plain open floor.
// `ai` is the opponent each minigame actually names in its own code.
const STATIONS = [
  {
    // Hard against the west wall (cabinet spans x -10.5..-8.5, plaster at
    // -10.8) and as far north as the balcony rail allows, so the whole
    // south-west quarter belongs to the four-in-a-row stand instead.
    id: 'pong', label: 'Play Paddle Panic', name: 'PADDLE PANIC',
    sub: 'out-volley the house bot', ai: 'Blip', yaw: 0.95,
    // The sign stands at the MOUTH of the corner, not back by the wall beside
    // the cabinet: from the follow camera the four-in-a-row stand fills the
    // left edge of the frame out to about a sixth of the screen width, and a
    // board tucked behind it at x -9.9 was invisible from the arrival spawn
    // (checked by raycasting the camera at all nine points of the board).
    // Playtester layout pass (2026-08-07, dev editor): the cabinet came off the
    // wall into the room and its board moved west behind it, so the arcade and
    // the four-in-a-row stand stopped sharing a strip of frame.
    at: [-6.98, -0.93], hs: [-5.43, 0.03], aiAt: [-5.28, 1.43], sign: [-8.55, 0.24],
    seats: [[-5.15, -1.06], [-6.50, 0.89]],
  },
  {
    // Along the east wall, north of the stair foot: the board's south end and
    // the cocoa counter are 1.4 apart, which is the lane everyone walks to get
    // upstairs. Shorter than it was (5.4, see _shuffle) for exactly that.
    id: 'shuffle', label: 'Play Shuffle Showdown', name: 'SHUFFLE SHOWDOWN',
    sub: 'slide it, do not shove it', ai: 'Waxwell',
    at: [5.63, 1.04], hs: [3.58, 0.69], aiAt: [3.48, 2.09], sign: [7.47, -0.36],
    seats: [[4.03, -0.41], [4.03, 3.04]],
  },
  {
    // Angled across the south-west corner with its back to the west wall and
    // its face turned into the room. The angle is walkability as much as looks:
    // 3.4 metres of stand is a wall a click-to-move walker has to slide down,
    // so it lies ALONG the west side rather than across the diagonal everyone
    // walks to reach the arcade, and its far end is pushed into the plaster
    // rather than leaving a metre-wide slot beside it (a walker wall-follows to
    // an open tip, turns for its target, re-enters the tip and stalls there:
    // sealed, the north-west corner is simply entered around the open end).
    // Every station-to-station route on this floor was walked to pick it.
    // signH: this is the station nearest the lens, so its board is a low one,
    // out at the mouth of the corner like a sandwich board. At the standard
    // 2.42 it rode up into the same strip of frame as the arcade's prompt rings
    // three metres behind it (the camera trades height against depth), which is
    // the exact "signs reading over each other" the playtest called out.
    id: 'connect4', label: 'Play Four in a Row', name: 'FOUR IN A ROW',
    sub: 'drop, stack, gloat', ai: 'Dizzy', yaw: 1.15, signH: 1.5,
    at: [-9.48, 4.15], hs: [-8.29, 4.68], aiAt: [-8.19, 6.08], sign: [-10.06, 6.44],
    seats: [[-7.73, 3.67], [-8.67, 5.77]],
  },
];
const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));

// Pristine copy of every coordinate the dev layout editor may move. The editor
// stores its changes in src/world/layout.js and this file re-applies them onto
// STATIONS at the top of build(); mutating the module table in place is
// deliberate, because a dozen call sites read STATIONS/STATION_BY_ID and this
// way none of them need to know the editor exists. Reset restores from here.
const STATIONS_BASE = STATIONS.map((s) => ({
  at: s.at.slice(), hs: s.hs.slice(), aiAt: s.aiAt.slice(), sign: s.sign.slice(),
  seats: s.seats.map((q) => q.slice()), yaw: s.yaw,
}));

/** Fold any dev-editor overrides into STATIONS before a build reads them. */
function applyStationOverrides() {
  const ov = getOverrides('lounge');
  STATIONS.forEach((s, i) => {
    const base = STATIONS_BASE[i];
    const p = ov?.get(s.id) || null;
    s.at = (p?.at || base.at).slice();
    s.hs = (p?.hs || base.hs).slice();
    s.aiAt = (p?.aiAt || base.aiAt).slice();
    s.sign = (p?.sign || base.sign).slice();
    s.seats = (p?.seats || base.seats).map((q) => q.slice());
    s.yaw = p?.yaw !== undefined ? p.yaw : base.yaw;
  });
}

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
// world clock (wave 7). LIVING-COVE.md interiors rule: the lodge keeps its
// layout and only swaps the mountainside past its glass, then reverses the
// window glow (daylight out, hearth and string lights in).
// ---------------------------------------------------------------------------

/** dayT: 0 dawn, 0.25 noon, 0.5 dusk, 0.75 midnight -> which view to hang. */
function clockPhase(dayT) {
  const t = ((dayT % 1) + 1) % 1;
  if (t < 0.06 || (t >= 0.42 && t < 0.6) || t >= 0.9) return 'dusk'; // low sun, both ends
  return t < 0.42 ? 'day' : 'night';
}

/** 1 at noon, 0 at midnight, 0.5 at dawn and dusk. */
function daylight(dayT) {
  return 0.5 + 0.5 * Math.cos(((((dayT % 1) + 1) % 1) - 0.25) * Math.PI * 2);
}

/** Wash laid over a daytime painted view: multiply the art down to the right
 *  key, then add back the low sun (dusk) or a moon and stars (night). */
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

/** The mountainside past the glass: ridges, pines, drifts, drifting flakes. */
function texAlps(flip, phase = 'day') {
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

    washPhase(g, w, h, phase);
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

/**
 * The cabinet's marquee. It used to spell PADDLE PANIC in neon, two metres from
 * the station sign post that spells PADDLE PANIC in paint: from the follow
 * camera the two boards land on top of each other and the corner reads as two
 * different games shouting the same name. Every station gets exactly ONE name,
 * on its sign, so the neon is a wordless glyph now: two paddles, a ball and its
 * trail, which says "bat-and-ball machine" at a glance and repeats nothing.
 */
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
    // the glyph: paddle, ball, paddle, all of it glowing the same neon pink
    g.shadowColor = '#ff9be8';
    g.shadowBlur = 26;
    g.fillStyle = '#fff3ff';
    for (const [px, py] of [[96, h * 0.5 - 14], [w - 96, h * 0.5 + 14]]) {
      rrect(g, px - 15, py - 34, 30, 68, 15);
      g.fill();
    }
    g.beginPath();
    g.arc(w / 2, h * 0.5, 17, 0, 7);
    g.fill();
    // the volley: a dashed arc from one paddle past the ball to the other
    g.strokeStyle = 'rgba(255,214,255,0.85)';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.setLineDash([16, 20]);
    g.beginPath();
    g.moveTo(126, h * 0.5 - 10);
    g.quadraticCurveTo(w / 2, h * 0.5 - 52, w - 126, h * 0.5 + 18);
    g.stroke();
    g.setLineDash([]);
    // three sparks off the far paddle, so the still frame still reads as motion
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(w - 60 - i * 4, h * 0.5 + 14 - 30 + i * 30, 5 - i, 0, 7);
      g.fill();
    }
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

/**
 * THE COVE TAPESTRY: the den's new landmark, hung on the north gable where the
 * fireplace used to stand before it went upstairs. A hand-painted map of the
 * whole island on a strip of linen, with a big red X on the lodge, because the
 * one thing a games room wall should say is "here is everywhere you could be
 * instead, and you chose to be here".
 */
function texCoveMap() {
  const w = 768, h = 460;
  return canvasTexture(w, h, (g) => {
    // linen, then the sea
    g.fillStyle = '#f3e3bc';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(120,86,40,0.07)';
    for (let i = 0; i < 900; i++) g.fillRect((i * 149) % w, (i * 233) % h, 3, 2);
    g.fillStyle = '#bfe0f2';
    rrect(g, 26, 26, w - 52, h - 52, 10);
    g.fill();
    g.strokeStyle = '#a06a30';
    g.lineWidth = 9;
    g.stroke();
    // swell lines
    g.strokeStyle = 'rgba(90,150,190,0.45)';
    g.lineWidth = 3;
    for (let i = 0; i < 9; i++) {
      const y = 52 + i * 44;
      g.beginPath();
      g.moveTo(40, y);
      for (let x = 40; x < w - 40; x += 40) g.quadraticCurveTo(x + 20, y - 7, x + 40, y);
      g.stroke();
    }

    // the island: sand ring, then grass
    const cx = w * 0.5, cy = h * 0.54;
    const blob = (rx, ry, fill, wob) => {
      g.beginPath();
      for (let a = 0; a <= 64; a++) {
        const th = (a / 64) * Math.PI * 2;
        const r = 1 + Math.sin(th * 3 + 0.6) * wob + Math.sin(th * 5 + 2.1) * (wob * 0.6);
        const px = cx + Math.cos(th) * rx * r;
        const py = cy + Math.sin(th) * ry * r;
        if (a === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    blob(268, 168, '#efd9a4', 0.05);
    blob(246, 150, '#8fc866', 0.05);
    g.strokeStyle = 'rgba(70,110,50,0.4)';
    g.lineWidth = 3;
    g.stroke();

    // the peak, with the lodge on its shoulder
    g.fillStyle = '#dbe7f4';
    g.beginPath();
    g.moveTo(cx - 92, cy - 52);
    g.lineTo(cx - 6, cy - 158);
    g.lineTo(cx + 84, cy - 52);
    g.closePath();
    g.fill();
    g.strokeStyle = '#8fa4bd';
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(cx - 6, cy - 158);
    g.lineTo(cx + 34, cy - 108);
    g.lineTo(cx - 40, cy - 108);
    g.closePath();
    g.fill();

    // landmark pins, in the same order the map card in the HUD paints them
    const pins = [
      ['Sunny Plaza', cx + 8, cy + 6, '#f2b64a'],
      ['Driftwood Beach', cx - 176, cy + 52, '#4fb3e8'],
      ['Frosty Peak', cx - 4, cy - 96, '#dff0fb'],
      ['Smoothie Shack', cx + 170, cy - 12, '#e8657a'],
      ['Groove Grotto', cx + 118, cy + 108, '#9b6bd4'],
      ['Tangle Jungle', cx - 96, cy + 96, '#7ac74f'],
    ];
    for (const [name, px, py, col] of pins) {
      g.beginPath();
      g.arc(px, py, 10, 0, 7);
      g.fillStyle = col;
      g.fill();
      ink(g, 4);
      g.fillStyle = '#3a2a12';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      fitFont(g, name, 150, 19, '900');
      g.fillText(name, px, py + 24);
    }

    // the lodge, with the X on it
    const lx = cx - 96, ly = cy - 74;
    g.strokeStyle = '#c03a3a';
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(lx - 18, ly - 18); g.lineTo(lx + 18, ly + 18);
    g.moveTo(lx + 18, ly - 18); g.lineTo(lx - 18, ly + 18);
    g.stroke();
    // The caption reads back WEST off the X, into open water. To its east is
    // the Frosty Peak pin, whose own label is drawn 24 under it and 92 to the
    // right of the lodge: "YOU ARE HERE" set left-aligned from the X ran
    // straight through the words "Frosty Peak" (found in a wall capture, not in
    // the code). Everything west of the lodge is sea, so the caption gets it.
    g.fillStyle = '#c03a3a';
    g.textAlign = 'right';
    fitFont(g, 'YOU ARE HERE', 190, 24, '900');
    g.fillText('YOU ARE HERE', lx - 30, ly - 6);
    g.fillStyle = 'rgba(90,58,30,0.75)';
    fitFont(g, 'the game den, upstairs and down', 210, 18, 'normal');
    g.fillText('the game den, upstairs and down', lx - 30, ly + 18);

    // compass rose and title
    const rx = w - 96, ry = h - 96;
    g.strokeStyle = '#8a5a2c';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(rx, ry, 40, 0, 7);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      g.beginPath();
      g.moveTo(rx + Math.cos(a) * 40, ry + Math.sin(a) * 40);
      g.lineTo(rx + Math.cos(a + 0.35) * 12, ry + Math.sin(a + 0.35) * 12);
      g.lineTo(rx + Math.cos(a - 0.35) * 12, ry + Math.sin(a - 0.35) * 12);
      g.closePath();
      g.fillStyle = i % 2 ? '#e8657a' : '#f2b64a';
      g.fill();
      ink(g, 3);
    }
    g.fillStyle = '#5b3a1e';
    g.textAlign = 'center';
    fitFont(g, 'N', 24, 24, '900');
    g.fillText('N', rx, ry - 54);

    g.fillStyle = '#5b3a1e';
    fitFont(g, 'CAPY COVE', 300, 46, '900');
    g.fillText('CAPY COVE', 190, 62);
    g.fillStyle = 'rgba(90,58,30,0.7)';
    fitFont(g, 'every last inch of it, more or less', 300, 20, 'normal');
    g.fillText('every last inch of it, more or less', 190, 92);
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
    applyStationOverrides(); // dev layout editor (Ctrl+E); a no-op normally
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

    this._phase = 'day';   // world clock: repainted by onClock (wave 7)
    this._glowK = 1;       // how hard the string lights burn

    scene.background = new THREE.Color(0x2b1e14);
    // Per-room colour grade (src/core/postfx.js; -1..+1). A loud games floor
    // under festoon bulbs: warm, and lifted a little because the corners this
    // room's fixtures never reach are where the seating is.
    this.grade = { warmth: 0.35, lift: 0.15 };
    // Snow haze, not the old brown murk. Nothing indoors is more than ~30 from
    // the camera so the room never sees it; everything the camera catches over
    // the walls is mountainside, and brown fog turned the far snowfield into a
    // slab of mud.
    scene.fog = new THREE.Fog(0xd8e8f6, 44, 108);
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
    this._buildNorthWall(scene, B);
    this._buildFestoon(scene, B);
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
    // Two ways out: the door back onto the mountain, and the stair up to the
    // Trophy Loft. The peak spawns sit 3.0 / 2.0 short of the door, outside its
    // 1.9 prompt radius, so arriving does not pop "back outside" over your head;
    // both look straight up the room at the cove tapestry. `from_loft` puts you
    // at the foot of the stair, facing back into the room.
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 5),
      from_peak: new THREE.Vector3(0, 0, 6),
      from_loft: new THREE.Vector3(9.85, 0, 4.6),
    };
    // 9.5/14: the same camera distance and 3/4 read as the rest of the world.
    // The room's landmark is the north wall now, and at this pitch the whole
    // tapestry sits in the top third of the frame from the arrival spawn.
    this.cameraHint = { offset: new THREE.Vector3(0, 9.5, 14.0), lookHeight: 1.5 };
    // Whole-room vantage: far enough south that the gable (8.8) and the porch
    // (z 9) both sit inside the 16:9 frustum, close enough that the four
    // territories read as four. Re-framed by eye at 960x540 after the loft
    // moved out: with nothing above 5 in the middle of the room any more, the
    // old 18.5/24 wasted the top fifth of the frame on snow.
    this.staticCamera = {
      position: new THREE.Vector3(0, 17.0, 22.0),
      lookAt: new THREE.Vector3(0, 2.4, 1.0),
    };

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
        action: (g) => {
          g.__matchCtx = null;
          g.startMinigame(s.id);
        },
      });
    }
    this.hotspots.push({
      id: 'exit-peak',
      position: new THREE.Vector3(0, 0, 8),
      radius: 1.9,
      label: 'Back out to Frosty Peak',
      action: (g) => g.goToRoom('peak', 'lounge'),
    });

    // The way upstairs. It fires near the TOP of the flight, so climbing is a
    // real walk rather than a hop off the bottom tread, and it is tagged with
    // the height of the landing: hotspot proximity is 2D, and without floorY
    // anyone crossing the floor below the stair (the shuffleboard's north end
    // is 2 metres away) would be dragged upstairs mid-shuffle.
    this.hotspots.push({
      id: 'exit-loft',
      position: new THREE.Vector3((ST_X0 + HW) / 2, LOFT_Y, ST_TOP_Z + 0.5),
      radius: 1.7,
      floorY: LOFT_Y,
      label: 'Up to the Trophy Loft',
      action: (g) => g.goToRoom('loft', 'lounge'),
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
    // One table at a time, so hopping to another game gives up the old chair
    // first: leave locally as well, or the capybara walks to the new station
    // still folded into the sit pose and still holding the old seat's label.
    // Two frames back to back sit well inside the server's social budget.
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

    // pale sky and snowfield outside, so a peek past a wall never shows the void
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(70, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xc3dcf1, side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);
    // The den is a cutaway with no roof, so this dome and the snow haze are in
    // frame from every seat: they follow the glass rather than staying noon-blue.
    this._skyMat = sky.material;
    const snowfield = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), makeToon(PAL.snow));
    snowfield.rotation.x = -Math.PI / 2;
    snowfield.position.y = -0.06;
    scene.add(snowfield);

    // ONE plank floor, wall to wall. It used to stop at z -3.2 because the
    // north third lived under the balcony and a click back there put a capybara
    // somewhere the camera could not see; with the loft gone that whole strip is
    // real room again, and it is where the cove tapestry and its console live.
    const walkTex = texPlanks();
    walkTex.repeat.set(6, (ZS - ZN) * 0.3125);
    // A wall-to-wall plank floor is the biggest surface in the room, and with a
    // tiling grain and nothing else it reads as one even sheet of brown from
    // the wide camera - the props sit ON it instead of IN it. This tints the
    // boards in the geometry rather than adding a light: a broad warm pool
    // under the festoon run, cooler and darker into the corners the fixtures never
    // reach, plus slow blotches so the wear is not symmetrical. Build-time
    // only, same one draw call, and the plank texture still carries the grain.
    const floorGeo = new THREE.PlaneGeometry(2 * HW, ZS - ZN, 14, 12);
    {
      const p = floorGeo.attributes.position;
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i); // un-rotated: the plane lies in XY
        const wear = Math.sin(x * 0.51 + 1.9) * Math.sin(y * 0.44 - 0.6)
          + 0.5 * Math.sin((x + y) * 0.87 + 2.2);
        const out = Math.min(1, Math.hypot(x / HW, y / ((ZS - ZN) * 0.5)));
        const t = 1 + wear * 0.045 - out * out * 0.15;
        col[i * 3] = t + wear * 0.012;
        col[i * 3 + 1] = t;
        col[i * 3 + 2] = t - wear * 0.02 - out * 0.03;
      }
      floorGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const floor = new THREE.Mesh(floorGeo, this._toonMap(walkTex, 0xffffff, { vertexColors: true }));
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
    // The north wall is a gable end: it carries the cove tapestry, the crest
    // and the banner over them, so it runs to WALL_N while the side walls stop
    // at WALL_H. Nothing bridges them overhead — see the header note.
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
    // west holes are mirrored.
    const holesE = [...WINZ.map(([a, b]) => [a, b, WIN_LO, WIN_HI]), ...WINZ_UP];
    const holesW = holesE.map(([a, b, c, d]) => [-b, -a, c, d]);
    const west = mkWall(ZS - ZN + 0.8, WALL_H, holesW);
    west.rotation.y = Math.PI / 2;
    west.position.set(-HW, 0, 0);
    const east = mkWall(ZS - ZN + 0.8, WALL_H, holesE);
    east.rotation.y = -Math.PI / 2;
    east.position.set(HW, 0, 0);

    // the painted mountainside, hung just outside each run of glass: tall and
    // long enough to fill the clerestory as well as the tall windows
    this._views = [];
    for (const s of [-1, 1]) {
      const v = new THREE.Mesh(new THREE.PlaneGeometry(17.6, 6.8), this._flat(texAlps(s > 0)));
      v.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      v.position.set(s * (HW + 0.8), 3.5, 1.6);
      scene.add(v);
      // repainted (never re-hung) when the cove clock rolls over to dusk/night
      this._views.push([v.material, (p) => texAlps(s > 0, p)]);
    }

    // frames, sills, mullions, sill plants: every run off one loop
    const winRuns = [
      ...WINZ.map(([a, b]) => [a, b, WIN_LO, WIN_HI, true]),
      ...WINZ_UP.map(([a, b, c, d]) => [a, b, c, d, false]),
    ];
    for (const s of [-1, 1]) {
      for (const [z0, z1, y0, y1, plants] of winRuns) {
        const midY = (y0 + y1) / 2, h = y1 - y0;
        const cz = (z0 + z1) / 2, len = z1 - z0;
        const wx = s * (HW - 0.14);
        boxFlat.add(PAL.cream, wx, y1 + 0.1, cz, 0.36, 0.2, len + 0.4);
        boxFlat.add(PAL.cream, wx, y0 - 0.1, cz, 0.36, 0.2, len + 0.4);
        boxFlat.add(PAL.cream, wx, midY, cz - len / 2, 0.36, h, 0.2);
        boxFlat.add(PAL.cream, wx, midY, cz + len / 2, 0.36, h, 0.2);
        boxFlat.add(PAL.cream, wx, midY, cz, 0.28, h, 0.12);
        boxFlat.add(PAL.cream, wx, midY, cz, 0.28, 0.12, len);
        box.add(PAL.woodLight, s * (HW - 0.34), y0 - 0.16, cz, 0.62, 0.16, len + 0.5);
        if (!plants) continue;
        for (let i = 0; i < 3; i++) {
          ball.add(i % 2 ? PAL.leaf : PAL.leafDark, s * (HW - 0.42), y0 + 0.1,
            cz - len / 3 + i * (len / 3), 0.52, 0.36, 0.52);
        }
      }
    }

    // wainscot, chair rail, top plate. The coral band rides at 1.55, just
    // under the sills of the tall glass.
    const runs = [
      [0, ZN + 0.1, 2 * HW, 0.2, WALL_N],
      [-HW + 0.1, 0, 0.2, ZS - ZN, WALL_H],
      [HW - 0.1, 0, 0.2, ZS - ZN, WALL_H],
    ];
    for (const [x, z, sx, sz, top] of runs) {
      boxFlat.add(PAL.wainscot, x, 0.62, z, sx, 1.24, sz);
      boxFlat.add(PAL.woodLight, x, 1.3, z, sx + 0.08, 0.16, sz + 0.08);
      boxFlat.add(PAL.wood, x, top - 0.22, z, sx + 0.08, 0.34, sz + 0.08);
      boxFlat.add(PAL.coral, x, 1.55, z, sx, 0.1, sz);
    }
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * (HW - 0.2), WALL_N / 2, ZN + 0.2, 0.4, WALL_N, 0.4);
      box.add(PAL.wood, sx * (HW - 0.2), WALL_H / 2, ZS - 0.24, 0.4, WALL_H, 0.4);
    }

    // Eaves and snow, all of it OUTSIDE the walls. The den is a cutaway: with
    // the camera 9.5 above a player, any roof over the room would render
    // between the two, so the roofline is sold from the outside edge in and
    // the room stays open to the sky.
    for (const sx of [-1, 1]) {
      box.add(PAL.woodMid, sx * (HW + 0.42), WALL_H + 0.08, 1.0, 1.1, 0.22, ZS - ZN + 1.2, 0, 0, sx * 0.12);
      box.add(PAL.snow, sx * (HW + 0.52), WALL_H + 0.28, 1.0, 1.15, 0.22, ZS - ZN + 1.0, 0, 0, sx * 0.12);
      box.add(PAL.woodLight, sx * (HW + 0.18), WALL_H - 0.08, 1.0, 0.44, 0.2, ZS - ZN + 1.2);
    }
    box.add(PAL.woodMid, 0, WALL_N + 0.1, ZN - 0.42, 2 * HW + 2.2, 0.24, 1.1, 0.12, 0, 0);
    box.add(PAL.snow, 0, WALL_N + 0.32, ZN - 0.56, 2 * HW + 1.9, 0.22, 1.1, 0.12, 0, 0);
    for (let i = 0; i < 5; i++) {
      ball.add(PAL.snow, -8 + i * 4, WALL_N + 0.42, ZN - 0.8, 1.6, 0.44, 0.8);
    }

    // The mountainside OUTSIDE, which is not scenery you can ignore: the walls
    // are 6.4 and the camera rides 9.5 above the player, so from anywhere near
    // a side wall (the stair especially) you look straight over it. Empty
    // snowfield out there filled a third of the frame with flat white until
    // this went in. All of it lives beyond |x| 12.5 / z -9, so it can never
    // come between the camera and a capybara. Deterministic: same every visit.
    for (let i = 0; i < 30; i++) {
      const a = (i * 2.3999) % TAU;                 // golden-angle scatter
      const rad = 19 + ((i * 7) % 19) + (i % 3) * 2.5;
      const px = Math.cos(a) * rad * 1.35;
      const pz = Math.sin(a) * rad - 6;
      if (Math.abs(px) < 15 || pz > 17) continue; // never over the room or the porch
      const s = 1.5 + ((i * 13) % 9) * 0.28;
      const drop = ((i * 17) % 7) * 0.12;
      for (let k = 0; k < 3; k++) {
        cone.add(k % 2 ? PAL.pine : PAL.pineDark, px, drop + s * (0.9 + k * 0.62), pz, s * 1.25, s * 1.1, s * 1.25);
        cone.add(PAL.snow, px, drop + s * (1.14 + k * 0.62), pz, s * 0.66, s * 0.46, s * 0.66);
      }
      cyl.add(PAL.cocoa, px, drop + s * 0.45, pz, s * 0.24, s * 0.9, s * 0.24);
      ball.add(PAL.snowShade, px, 0.05, pz, s * 3.2, 0.5, s * 2.6);
    }
    // far ridges, big and hazy, closing the horizon on three sides
    for (const [rx, rz, rs] of [
      [-34, -30, 15], [-14, -40, 19], [12, -44, 17], [33, -28, 14], [40, 2, 12], [-42, 4, 13],
    ]) {
      cone.add(PAL.snowShade, rx, rs * 0.42, rz, rs * 2.0, rs * 0.9, rs * 1.6);
      cone.add(PAL.snow, rx, rs * 0.72, rz, rs * 0.9, rs * 0.36, rs * 0.72);
    }
  }

  // -------------------------------------------------------------------------
  _buildLights(scene) {
    this._hemi = new THREE.HemisphereLight(0xffe3ba, 0x5a3c24, 0.5);
    scene.add(this._hemi);
    this._amb = new THREE.AmbientLight(0xffeacd, 0.24);
    scene.add(this._amb);

    this._lamps = [];
    // Five fills: one per station cluster, one over the middle of the rug, and
    // a pair washing the north wall so the cove tapestry is the brightest thing
    // in the room from the door. No fill at the door itself, where daylight
    // through the opening does the job. (The loft door has its own, next to it
    // in _buildStair, and it does not fade with the clock: the room beyond is
    // lit whatever time it is.)
    for (const [x, y, z, col, i, dist] of [
      [0, 4.2, 2.2, 0xffd8a4, 15, 15],
      [-8.4, 3.4, 2.2, 0xffcf9a, 13, 14],
      [8.5, 3.4, 4.4, 0xffd6a8, 13, 14],
      [-3.4, 4.3, -5.6, 0xffc890, 11, 10],
      [3.4, 4.3, -5.6, 0xffc890, 11, 10],
    ]) {
      const p = new THREE.PointLight(col, i, dist, 2);
      p.position.set(x, y, z);
      p.userData.base = i;
      scene.add(p);
      this._lamps.push(p);
    }

    // one sun raking in through the west windows
    const sun = new THREE.DirectionalLight(0xffe2b4, 0.75);
    sun.position.set(-16, 15, 11);
    sun.target.position.set(1, 0, -3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -16;
    sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16;   // the gable (8.8) plus room for the shadow cast
    sun.shadow.camera.bottom = -14;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 62;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);
    this._sun = sun;
  }

  // -------------------------------------------------------------------------
  /**
   * String lights: two runs down the side walls and one across the doorway.
   * They used to hang off the balcony fascia, which is the one place they can
   * no longer go. Everything is above 4.5 and inside a metre of the plaster,
   * except the door run, which is south of everybody: nothing here can land
   * between the camera and a capybara.
   */
  _buildFestoon(scene, B) {
    const { bead } = B;
    const bulbs = [], cord = [];
    for (const [x0, z0, x1, z1, by] of [
      [-HW + 0.7, -6.2, -HW + 0.7, 7.4, 4.9],
      // the east run stops short of the stair: the landing is 3.2 up, and a
      // bulb at 4.9 would be level with the ears of anyone standing on it
      [HW - 0.7, 1.5, HW - 0.7, 7.4, 4.9],
      [-10.4, 8.2, 10.4, 8.2, 4.6],
    ]) {
      const n = 16;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = [x0 + (x1 - x0) * u, by - Math.abs(Math.sin(u * Math.PI * 4)) * 0.18, z0 + (z1 - z0) * u];
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
  /** World clock (wave 7). The lodge never changes shape: the mountainside
   *  past the glass goes from afternoon to alpenglow to moonlit snow, the
   *  daylight raking in through the west windows fades with it, and the lamps
   *  and the string lights carry the room after dusk. */
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
    // the window glow reverses: daylight out, lamplight in
    this._sun.intensity = 0.08 + 0.67 * lit;
    this._sun.color.setHex(
      phase === 'night' ? 0xa8bcea : phase === 'dusk' ? 0xffb279 : 0xffe2b4,
    );
    this._hemi.intensity = 0.2 + 0.3 * lit;
    this._amb.intensity = 0.12 + 0.12 * lit;
    for (const p of this._lamps) p.intensity = p.userData.base * (1.55 - 0.55 * lit);
    this._glowK = 1.3 - 0.5 * lit;
  }

  // -------------------------------------------------------------------------
  // THE STAIR TO THE TROPHY LOFT: eight boxed treads up the east wall, a
  // landing at the top and a lit doorway off it. Every tread is a solid block
  // from the floor up, so the ground snap sees one continuous rising surface
  // (0.4 a step, a third of the 1.2 step-up range) and walks a capybara up it
  // without a single special case. The treads and the landing are real ground
  // meshes; 'exit-loft' fires up near the head of the flight.
  //
  // Everything up here stays east of x 8.7 and north of z -2.2, and the strip
  // of floor UNDER the landing is fenced off (it is the log store now): from
  // the arrival spawn the camera's line to a capybara standing back there
  // would pass straight through the landing slab.
  // -------------------------------------------------------------------------
  _buildStair(scene, B) {
    const { box, boxFlat, cyl, ball, bead } = B;
    const W = ST_X1 - ST_X0, cx = (ST_X0 + ST_X1) / 2;

    const steps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(W, 1, ST_GOING), makeToon(PAL.woodMid), ST_N,
    );
    const d = new THREE.Object3D();
    for (let i = 0; i < ST_N; i++) {
      const h = (i + 1) * ST_RISE;
      d.position.set(cx, h / 2, ST_Z0 - (i + 0.5) * ST_GOING);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, h, 1);
      d.updateMatrix();
      steps.setMatrixAt(i, d.matrix);
      // pale nosing on the lip of each tread, so the flight reads as steps and
      // not as a ramp from the camera above
      boxFlat.add(PAL.woodLight, cx, h - 0.02, ST_Z0 - i * ST_GOING - 0.07, W - 0.12, 0.08, 0.2);
    }
    steps.castShadow = true;
    steps.receiveShadow = true;
    scene.add(steps);
    this.groundMeshes.push(steps);

    // the landing: the last flat stretch before the door
    const land = new THREE.Mesh(new THREE.PlaneGeometry(W, ST_TOP_Z - LAND_Z), makeToon(PAL.woodMid));
    land.rotation.x = -Math.PI / 2;
    land.position.set(cx, LOFT_Y, (ST_TOP_Z + LAND_Z) / 2);
    land.receiveShadow = true;
    scene.add(land);
    this.groundMeshes.push(land);
    box.add(PAL.wood, cx, LOFT_Y - 0.34, (ST_TOP_Z + LAND_Z) / 2 - 0.2, W, 0.6, ST_TOP_Z - LAND_Z + 0.8);

    // skirt board down the open side, and the raked handrail above it
    const run = ST_Z0 - ST_TOP_Z, rise = LOFT_Y;
    const len = Math.hypot(run, rise), rake = Math.atan2(rise, run);
    box.add(PAL.wood, ST_X0 - 0.06, (ST_RISE + LOFT_Y) / 2 - 0.32, (ST_Z0 + ST_TOP_Z) / 2,
      0.2, 0.72, len + 0.3, rake, 0, 0);
    box.add(PAL.woodMid, ST_X0 - 0.06, (ST_RISE + LOFT_Y) / 2 + RAIL_Y - 0.1, (ST_Z0 + ST_TOP_Z) / 2,
      0.16, 0.16, len, rake, 0, 0);
    for (let i = 0; i <= ST_N; i++) {
      const pz = ST_Z0 - i * ST_GOING;
      const py = i * ST_RISE;
      box.add(PAL.wood, ST_X0 - 0.06, py + RAIL_Y / 2 + 0.1, pz, 0.14, RAIL_Y + 0.2, 0.14);
      // The fence, as overlapping circles, but NOT over the bottom two treads.
      // Those sit 0.4 and 0.8 up, which the ground snap treats as a step, so
      // their open sides are the way ON rather than a fall — and a fenced
      // bottom step would shut the only lane to the stair between the rail and
      // the cocoa bar (found by walking it).
      if (i >= 2) this.obstacles.push({ x: ST_X0, z: pz, r: RAIL_R });
    }
    // the same fence along the landing, then on north to close the strip under
    // it: that floor is scenery for the camera's sake (see the note above)
    for (let z = ST_TOP_Z; z >= ZN + 0.5; z -= RAIL_STEP) {
      this.obstacles.push({ x: ST_X0, z, r: RAIL_R });
    }
    for (let i = 0; i <= 3; i++) {
      const pz = ST_TOP_Z - i * ((ST_TOP_Z - LAND_Z) / 3);
      box.add(PAL.wood, ST_X0 - 0.06, LOFT_Y + RAIL_Y / 2 + 0.1, pz, 0.14, RAIL_Y + 0.2, 0.14);
    }
    box.add(PAL.woodMid, ST_X0 - 0.06, LOFT_Y + RAIL_Y, (ST_TOP_Z + LAND_Z) / 2,
      0.16, 0.16, ST_TOP_Z - LAND_Z, 0, 0, 0);
    // newels: a chunky one at the foot, a taller one at the head
    for (const [px, py, pz, h] of [[ST_X0 - 0.06, 0, ST_Z0 + 0.2, 1.5], [ST_X0 - 0.06, LOFT_Y, LAND_Z + 0.1, 1.3]]) {
      box.add(PAL.wood, px, py + h / 2, pz, 0.3, h, 0.3);
      bead.add(PAL.gold, px, py + h + 0.12, pz, 0.3, 0.32, 0.3);
    }

    // --- the doorway at the head -------------------------------------------
    // Posts, lintel and a warm panel of lamplight from the room beyond, which
    // is a whole other instance now. It faces SOUTH, at the camera: a board
    // turned back into the wall only ever shows the camera its back.
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, cx + sx * (W / 2 - 0.18), LOFT_Y + 1.15, DOOR_Z, 0.34, 2.3, 0.42);
    }
    box.add(PAL.wood, cx, LOFT_Y + 2.42, DOOR_Z, W + 0.3, 0.36, 0.5);
    box.add(PAL.woodLight, cx, LOFT_Y + 2.66, DOOR_Z, W + 0.5, 0.14, 0.62);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(W - 0.5, 2.2),
      new THREE.MeshBasicMaterial({ color: 0xffc477, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    // Order matters and the first pass had it backwards: the camera is SOUTH of
    // this door (it trails the climber), so larger z is nearer. The dark panel
    // is the room beyond and has to sit BEHIND the lamplight, or it is simply a
    // black slab with the glow hidden behind it, which is what a capture of the
    // stair head showed.
    glow.position.set(cx, LOFT_Y + 1.15, DOOR_Z - 0.10);
    scene.add(glow);
    this._loftGlow = glow;
    boxFlat.add(0x2a1a0e, cx, LOFT_Y + 1.15, DOOR_Z - 0.32, W - 0.45, 2.2, 0.2);
    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(1.3, 22),
      new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(cx, LOFT_Y + 0.02, DOOR_Z + 0.9);
    scene.add(pool);
    this._loftPool = pool;
    const lamp = new THREE.PointLight(0xffb968, 9, 8, 2);
    lamp.position.set(cx, LOFT_Y + 1.5, DOOR_Z + 0.4);
    scene.add(lamp);

    // the sign over the door, and its twin down at the foot of the flight
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(2.1, 0.74),
      this._flat(texSign('THE TROPHY LOFT', 'fireside, chess & cards')),
    );
    // 0.28 SOUTH of the doorway plane, not north of it: the lintel is 0.5 deep
    // about DOOR_Z, so a board tucked behind it is a board nobody ever sees.
    top.position.set(cx, LOFT_Y + 2.42, DOOR_Z + 0.28);
    scene.add(top);
    for (const sx of [-1, 1]) bead.add(0xffe0a8, cx + sx * 1.0, LOFT_Y + 2.0, DOOR_Z + 0.24, 0.26, 0.26, 0.26);

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 0.72),
      this._flat(texSign('UP TO THE LOFT', 'fireside, chess & cards')),
    );
    sign.rotation.y = -0.62;
    sign.position.set(ST_X0 - 0.3, 1.85, ST_Z0 + 1.0);
    scene.add(sign);
    box.add(PAL.woodMid, ST_X0 - 0.24, 1.85, ST_Z0 + 1.0, 1.98, 0.8, 0.1, 0, -0.62, 0);
    boxFlat.add(PAL.brass, ST_X0 - 0.3, 2.32, ST_Z0 + 1.0, 0.9, 0.12, 0.12, 0, -0.62, 0);

    // the log store in the fenced strip under the landing: scenery, built to be
    // looked at from the side rather than walked into
    box.add(PAL.wood, cx, 0.9, LAND_Z - 1.4, W - 0.2, 1.8, 1.6);
    boxFlat.add(0x4a2f18, cx, 0.95, LAND_Z - 1.3, W - 0.5, 1.5, 1.5);
    for (let i = 0; i < 8; i++) {
      cyl.add(i % 2 ? PAL.wood : PAL.woodMid, cx - 0.66 + (i % 4) * 0.44, 0.55 + ((i / 4) | 0) * 0.42,
        LAND_Z - 1.25, 0.36, 1.3, 0.36, 0, Math.PI / 2, 0);
    }
    ball.add(PAL.leafDark, cx - 0.5, 2.05, LAND_Z - 1.4, 0.9, 0.55, 0.8);
    for (let i = 0; i < 3; i++) {
      cyl.add(PAL.brass, cx - 0.6 + i * 0.6, 2.5, ZN + 0.5, 0.12, 0.5, 0.12, 0.4, 0, 0);
    }
  }

  // -------------------------------------------------------------------------
  // THE NORTH WALL: the room's landmark since the hearth went upstairs.
  //
  // A fireplace two storeys tall used to fill this gable; taking it away left
  // the biggest, best-lit surface in the room blank, and a room with no focal
  // point opposite its door reads as a corridor. So the wall got the one thing
  // a games den should hang: a painted map of the whole cove with a red X on
  // the lodge you are standing in, the den crest over it, the banner over that
  // and the long console under it. It sits dead ahead from both door spawns.
  // -------------------------------------------------------------------------
  _buildNorthWall(scene, B) {
    const { box, boxFlat, cyl, ball, bead } = B;
    const WZ = ZN + 0.22;

    // the hanging itself, on a batten top and bottom
    const map = new THREE.Mesh(new THREE.PlaneGeometry(6.0, 3.6), this._flat(texCoveMap()));
    map.position.set(0, 3.4, WZ);
    scene.add(map);
    box.add(PAL.wood, 0, 5.3, WZ - 0.06, 6.5, 0.18, 0.22);
    box.add(PAL.wood, 0, 1.56, WZ - 0.06, 6.4, 0.14, 0.2);
    for (const sx of [-1, 1]) {
      bead.add(PAL.gold, sx * 3.2, 5.3, WZ - 0.06, 0.26, 0.26, 0.26);
      cyl.add(PAL.brass, sx * 2.9, 1.4, WZ - 0.04, 0.1, 0.3, 0.1);
    }

    // the crest above it, and the banner above that
    const crest = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), this._flat(texCrest()));
    crest.position.set(0, 6.0, WZ);
    scene.add(crest);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1),
      this._flat(texBanner('TONIGHT\u2019S CHALLENGERS')));
    banner.position.set(0, 7.5, WZ);
    scene.add(banner);

    // two brass sconces, one either side of the map
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * 3.6, 4.3, ZN + 0.45, 0.09, 0.09, 0.7);
      cyl.add(PAL.brass, sx * 3.6, 4.45, ZN + 0.72, 0.34, 0.3, 0.34, Math.PI, 0, 0);
      bead.add(0xffe0a8, sx * 3.6, 4.28, ZN + 0.72, 0.3, 0.3, 0.3);
    }

    // the console under the map: the den's lost-property shelf
    const CZ = ZN + 0.85;
    box.add(PAL.wainscot, 0, 0.5, CZ, 5.4, 1.0, 0.9);
    box.add(PAL.woodLight, 0, 1.06, CZ, 5.7, 0.14, 1.1);
    box.add(PAL.coral, 0, 0.62, CZ - 0.48, 5.0, 0.24, 0.06);
    for (let i = 0; i < 4; i++) {
      box.add([PAL.coral, PAL.sky, PAL.gold, PAL.leaf][i], -2.0 + i * 0.42, 1.22, CZ,
        0.66, 0.12, 0.5, 0, i * 0.3, 0);
    }
    cyl.add(PAL.cream, 1.5, 1.26, CZ, 0.34, 0.3, 0.34);
    cyl.add(PAL.cocoa, 1.5, 1.41, CZ, 0.28, 0.02, 0.28);
    cyl.add(PAL.terracotta, 2.3, 1.2, CZ, 0.5, 0.3, 0.5);
    ball.add(PAL.leafDark, 2.3, 1.44, CZ, 0.7, 0.5, 0.6);
    boxFlat.add(PAL.brass, -2.4, 1.2, CZ, 0.5, 0.14, 0.4);
    this.obstacles.push(
      { x: -1.8, z: CZ, r: 1.0 }, { x: 0, z: CZ, r: 1.0 }, { x: 1.8, z: CZ, r: 1.0 },
    );
  }


  // -------------------------------------------------------------------------
  // the three game stations (chess and Capy Clash are upstairs in loft.js)
  // -------------------------------------------------------------------------
  _buildStations(scene, B) {
    this._rings = [];
    // Register each station's props for the dev layout editor (Ctrl+E) by
    // diffing what the builder adds to the scene, so no builder has to know
    // the editor exists. Chairs and sign posts ride shared instanced batches
    // built later and cannot move at runtime: editorExport() below hands back
    // the whole table row so they follow on the next build.
    const reg = (id, fn) => {
      const n = scene.children.length;
      fn();
      this.editable(id, scene.children.slice(n), { table: 'STATIONS' });
    };
    reg('pong', () => this._pong(scene, B, STATION_BY_ID.get('pong')));
    reg('shuffle', () => this._shuffle(scene, B, STATION_BY_ID.get('shuffle')));
    reg('connect4', () => this._connect4(scene, B, STATION_BY_ID.get('connect4')));

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
      // carry a canvas nobody else shares. A station may name its own height
      // (`signH`): the southernmost board is a low one, because this camera
      // trades height against depth and a full-height post that close to the
      // lens rides up into the frame belonging to the station three metres
      // behind it.
      const [sx, sz] = s.sign;
      const h = s.signH ?? 2.42;
      const yaw = Math.atan2(-sx, 12 - sz);
      const nx = Math.sin(yaw), nz = Math.cos(yaw);
      cyl.add(PAL.wood, sx, (h + 0.35) / 2, sz, 0.18, h + 0.35, 0.18);
      box.add(PAL.woodMid, sx, h, sz, 1.86, 0.74, 0.1, 0, yaw, 0);
      bead.add(PAL.gold, sx, h + 0.46, sz, 0.22, 0.22, 0.22);
      // SIGN_OUT, not the 0.07 this used to be: the post is 0.09 of radius
      // about the board's own centre line, so a face standing 0.07 proud of it
      // had the post's front growing straight through the middle of the
      // lettering (every board read "PADDL|PANIC" from the play camera). 0.13
      // puts the canvas in front of the post it hangs on.
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
    // cushion tops out at floor + 0.68, which is SEAT_Y minus the 0.06 of
    // squish a capybara's rear makes when the sit pose drops it onto the pad
    ball.add(cushion, px, pad + 0.11, pz, 0.72, 0.14, 0.68, 0, yaw, 0);
    for (const lx of [-0.28, 0.28]) {
      for (const lz of [-0.26, 0.26]) {
        const [gx, gz] = at(lx, lz);
        cyl.add(PAL.wood, gx, 0.25, gz, 0.1, 0.5, 0.1);
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
    // Turned toward the approach AND the camera. Facing the prompt alone put
    // the marquee and the screen nearly edge-on: the camera always looks due
    // north, so a face with no +z in its normal is a sliver.
    g.rotation.y = s.yaw ?? Math.atan2(s.hs[0] - s.at[0], s.hs[1] - s.at[1]);
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

  /**
   * SHUFFLEBOARD: long waxed table with the scoring zones painted on it, laid
   * along the east wall.
   *
   * 5.4 long, not the 6.0 it was: the board and the cocoa counter share that
   * wall with the stair between them, and the only way upstairs is the lane
   * across their ends. At 6.0 (plus 1.15 collider caps) that lane pinched to
   * half a metre and walkers ground along the counter to find it.
   */
  _shuffle(scene, B, s) {
    const { box, cyl } = B;
    const [x, z] = s.at;
    const LEN = 5.4, WID = 1.25, TOP = 0.78;
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
      [-0.28, -2.0, PAL.coral], [0.22, -1.7, PAL.coral], [-0.1, -1.15, PAL.sky],
      [0.3, -0.7, PAL.sky], [-0.36, 2.05, PAL.coral], [0.34, 2.15, PAL.sky],
    ]) {
      cyl.add(col, x + px, TOP + 0.06, z + pz, 0.34, 0.1, 0.34);
      cyl.add(0xfff6e3, x + px, TOP + 0.115, z + pz, 0.2, 0.02, 0.2);
    }
    // Scoreboard hung on the stair skirt beside the board, turned to the room.
    // It used to be on the west wall; the board lives on the east side now. The
    // stair rail keeps every walker at least 0.6 west of it, so nobody can ever
    // stand behind it and be hidden by it.
    //
    // North of the board's middle on purpose: down at the board's south end it
    // shared a patch of frame with the cocoa sign and the stair sign, which is
    // three boards in one glance. Up here it has the whole upper-right to
    // itself and still reads as this table's scoreboard.
    const sb = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.12), this._flat(texScoreboard()));
    sb.rotation.y = -1.0;
    sb.position.set(ST_X0 - 0.24, 2.05, z + 1.2);
    scene.add(sb);
    box.add(PAL.wood, ST_X0 - 0.18, 2.05, z + 1.2, 1.7, 1.3, 0.1, 0, -1.0, 0);
    // the wax tin, sat on the room-side rail near the far end, where it is not
    // standing in the lane to the stair
    cyl.add(PAL.brass, x - (WID / 2 + 0.14), 1.06, z - 1.95, 0.28, 0.3, 0.28);

    // Same rule as the four-in-a-row stand: a row of overlapping circles whose
    // union is a smooth capsule down the board, spaced well inside their own
    // radius so the rims cross at a shallow angle. The old three at 2.4 did not
    // even touch (2 x 1.15 = 2.3), so a walker could squeeze between them and
    // end up standing on the playing surface.
    for (let i = -3; i <= 3; i++) this.obstacles.push({ x, z: z + i * 0.59, r: 1.05 });
  }

  /** CONNECT 4: big standing blue grid with red and yellow discs. */
  _connect4(scene, B, s) {
    const [x, z] = s.at;
    const g = new THREE.Group();
    const yaw = s.yaw ?? Math.PI / 2;
    g.position.set(x, 0, z);
    g.rotation.y = yaw; // into the room AND toward the camera: see _pong
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

    // The grid is 3.4 long, so its collider is a ROW of circles along the long
    // axis (local +x, which the yaw swings around with the stand). Spacing
    // matters as much as coverage: the old three (1.35 in the middle, 1.0 at
    // 1.5 either side) crossed rims at a sharp angle and left a deep notch on
    // the north face. A walker aiming into that notch had both push-outs cancel
    // and the stuck timer stopped them dead two metres short of the arcade, so
    // the row is even radii at 0.42 now, which unions into a smooth capsule
    // that walkers slide along instead of jamming into. 0.95 of radius, too:
    // the stand is a slab plus its two disc trays, about a metre thick all in,
    // and every 10cm of surplus bubble here is 10cm the chairs and the sit
    // prompt in front of it have to give back to the camera's dead ground
    // behind the planted half wall (z > ~6.8).
    const ax = Math.cos(yaw) * 0.42, az = -Math.sin(yaw) * 0.42;
    for (let i = -3; i <= 3; i++) {
      this.obstacles.push({ x: x + ax * i, z: z + az * i, r: 0.95 });
    }
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
  // rugs, the reading nook under the cove map, cushions, low table, the
  // sleeping regular
  // -------------------------------------------------------------------------
  _buildSeating(scene, B, rand) {
    const { box, cyl, ball, bead } = B;

    // rugs stay flat decoration: never in groundMeshes, so the bot zone floor
    // stays exactly one raycast surface
    // centred on the bot circle, which is the room's one guaranteed patch of
    // plain open floor: the rug is how a player reads that promise
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(9.0, 6.4), this._toonMap(texRug(0)));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(ZONE.x, 0.012, ZONE.z - 0.1);
    rug.receiveShadow = true;
    scene.add(rug);
    // The reading nook's round rug, under the cove map. This end of the room
    // was the undercroft until the loft moved out; a rug and two armchairs are
    // what turn a strip of newly walkable floor into somewhere to be.
    const nookRug = new THREE.Mesh(new THREE.CircleGeometry(2.5, 32), this._toonMap(texRug(1)));
    nookRug.rotation.x = -Math.PI / 2;
    nookRug.position.set(0, 0.012, -4.1);
    nookRug.receiveShadow = true;
    scene.add(nookRug);

    // two leather-look armchairs, angled in at the map like a fire that is not
    // there any more
    for (const sx of [-1, 1]) {
      const x = sx * 2.9, z = -3.6;
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = Math.atan2(0 - x, -6.6 - z);
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
      this.obstacles.push({ x, z, r: 0.75 });
    }

    // low table with a leaning stack of games, down in the south-east corner
    // where the room's other hangout spot is: the middle of the floor has to
    // stay a through route between the four territories.
    const [tx, tz] = [2.6, 6.4];
    cyl.add(PAL.woodMid, tx, 0.44, tz, 1.7, 0.12, 1.7);
    cyl.add(PAL.wood, tx, 0.22, tz, 0.34, 0.44, 0.34);
    cyl.add(PAL.wood, tx, 0.05, tz, 1.0, 0.1, 1.0);
    for (let i = 0; i < 3; i++) {
      box.add([PAL.coral, PAL.sky, PAL.gold][i], tx - 0.24, 0.56 + i * 0.11, tz,
        0.72, 0.1, 0.52, 0, i * 0.25, 0);
    }
    cyl.add(PAL.cream, tx + 0.42, 0.6, tz - 0.12, 0.24, 0.2, 0.24);
    this.obstacles.push({ x: tx, z: tz, r: 0.9 });

    // floor cushions: two round the low table, two on the nook rug
    for (const [cx, cz, col] of [
      [1.3, 5.5, PAL.coral], [3.9, 7.1, PAL.sky],
      [-1.2, -4.4, PAL.gold], [1.2, -4.4, PAL.plum],
    ]) {
      ball.add(col, cx, 0.19, cz, 0.98, 0.38, 0.98, 0, rand() * 3, 0);
      bead.add(0xfff6e3, cx, 0.34, cz, 0.12, 0.06, 0.12);
    }

    // The regular: a capybara fast asleep on a beanbag, parked between the
    // doorway and the four-in-a-row stand, clear of the bot circle, and now
    // backed right up into the planting on the half wall. At z 6.2 his collider
    // sat square in the middle of the lane along the south wall, so a walk from
    // either spawn to the four-in-a-row house prompt ran straight into a
    // sleeping capybara and stopped dead against him.
    const bx = -3.4, bz = 7.4;
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
    // Tucked into the SOUTH-EAST corner, back from the stair foot (ST_Z0 3.6).
    // The counter, the stair and the shuffleboard all want the east wall, and
    // the lane across the counter's north end is how everybody gets upstairs:
    // at its old z 4.6 that lane was half a metre wide once the collider caps
    // of both neighbours were counted, so the bar sits south of the traffic and
    // the corner is its own territory.
    const BX = 8.9, Z0 = 5.4, Z1 = 8.0;
    const cz = (Z0 + Z1) / 2, len = Z1 - Z0;

    box.add(PAL.wainscot, BX, 0.56, cz, 1.1, 1.12, len);
    box.add(PAL.woodLight, BX, 1.18, cz, 1.36, 0.14, len + 0.24);
    boxFlat.add(PAL.coral, BX - 0.58, 0.66, cz, 0.06, 0.32, len - 0.3);
    // back shelf against the east wall, below the window sill
    boxFlat.add(PAL.wood, HW - 0.36, 1.5, cz, 0.44, 0.1, len);
    for (let i = 0; i < 6; i++) {
      cyl.add([PAL.cream, PAL.gold, PAL.coral][i % 3], HW - 0.36, 1.72, Z0 + 0.35 + i * 0.4, 0.3, 0.34, 0.3);
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

    // The sign, on its own post at the counter's north-west corner rather than
    // flat on the wall behind it. Hung on the wall at x 9.4 it projected onto
    // the very edge of a 16:9 frame and the word COCOA was sliced off; out here
    // it stands clear of the stair sign below it and reads whole.
    // 3.5 up, which is a head above the "UP TO THE LOFT" board on the stair
    // skirt just north of it: from the arrival spawn those two sit in the same
    // column of the frame, and only the height keeps them apart.
    const SGX = BX - 0.55, SGZ = Z0 - 0.1, SGY = 3.5, SGR = -0.55;
    cyl.add(PAL.wood, SGX, (SGY - 0.4) / 2, SGZ, 0.16, SGY - 0.4, 0.16);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.95), this._flat(texCocoa()));
    sign.rotation.y = SGR;
    sign.position.set(SGX + Math.sin(SGR) * 0.07, SGY, SGZ + Math.cos(SGR) * 0.07);
    scene.add(sign);
    box.add(PAL.wood, SGX, SGY, SGZ, 2.0, 1.05, 0.1, 0, SGR, 0);
    bead.add(PAL.gold, SGX, SGY + 0.62, SGZ, 0.22, 0.22, 0.22);

    this._stool(B, BX - 1.65, Z0 + 0.7, PAL.gold);
    this._stool(B, BX - 1.65, Z0 + 2.0, PAL.gold);

    this.obstacles.push(
      { x: BX, z: Z0 + 0.45, r: 1.05 }, { x: BX, z: cz, r: 1.05 }, { x: BX, z: Z1 - 0.45, r: 1.05 },
    );
  }

  // -------------------------------------------------------------------------
  // bookshelves, plants, the trophy plaque
  // -------------------------------------------------------------------------
  _buildDecor(scene, B, rand) {
    const { box, boxFlat, cyl, bead, cone } = B;

    // --- game-box shelves, flanking the cove map on the gable ---------------
    // They used to stand in the middle of the room at z -3.5, pulled forward
    // out of the balcony's shadow. With the deck gone they can go where a
    // bookcase belongs: back against the wall, flanking the map, low enough
    // (1.74) that the map, the crest and the banner above it own the whole
    // upper wall.
    //
    // Two west, one east, on purpose: the fourth would stand at x 8.2, whose
    // collider circles (7.58 / 8.82) would cross the stair fence's at x 8.7 and
    // make an overlap lens a walker can stand in and shuffle on the spot. The
    // log store already fills that corner for the camera.
    for (const [x, z] of [[-8.2, ZN + 0.55], [-5.0, ZN + 0.55], [5.0, ZN + 0.55]]) {
      box.add(PAL.wood, x, 0.85, z, 2.4, 1.7, 0.7);
      boxFlat.add(0x5d3a1e, x, 0.9, z + 0.02, 2.1, 1.5, 0.66);
      for (let s = 0; s < 2; s++) {
        const sy = 0.34 + s * 0.62;
        boxFlat.add(PAL.woodLight, x, sy, z + 0.06, 2.2, 0.1, 0.66);
        let bx = x - 0.92;
        while (bx < x + 0.78) {
          const w = 0.16 + rand() * 0.12;
          const hgt = 0.4 + rand() * 0.16;
          const col = [PAL.coral, PAL.sky, PAL.gold, PAL.leaf, PAL.plum, PAL.cream][(rand() * 6) | 0];
          box.add(col, bx + w / 2, sy + 0.06 + hgt / 2, z + 0.06, w, hgt, 0.52, 0, 0, (rand() - 0.5) * 0.12);
          bx += w + 0.03;
        }
      }
      box.add(PAL.woodLight, x, 1.74, z, 2.6, 0.14, 0.86);
      cyl.add(PAL.terracotta, x - 0.8, 1.92, z, 0.4, 0.28, 0.4);
      cone.add(PAL.leafDark, x - 0.8, 2.22, z, 0.5, 0.54, 0.5);
      // two circles down the carcass rather than one fat bubble: a single
      // circle wide enough to cover 2.4 of shelf would reach a metre into the
      // room at its ends and nothing at all in the middle
      for (const ox of [-0.62, 0.62]) this.obstacles.push({ x: x + ox, z: z + 0.1, r: 0.8 });
    }

    // --- potted plants in the two south corners -----------------------------
    for (const [x, z] of [[-10.3, 7.9], [10.3, 7.9]]) {
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

    // a trophy plaque on the solid stretch of the west wall, over the arcade
    boxFlat.add(PAL.wood, -HW + 0.24, 3.4, -2.95, 0.14, 1.3, 1.3);
    cyl.add(PAL.cream, -HW + 0.34, 3.4, -2.95, 0.9, 0.06, 0.9, 0, 0, Math.PI / 2);
    cyl.add(PAL.coral, -HW + 0.38, 3.4, -2.95, 0.5, 0.04, 0.5, 0, 0, Math.PI / 2);
    bead.add(PAL.gold, -HW + 0.42, 3.4, -2.95, 0.14, 0.14, 0.14);
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
    // walking toward it, but the camera always trails 14 south of them, so a
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

  /**
   * Dev layout editor: every number of a station that may be dragged, as a
   * labelled handle. Each one is a real coordinate in the STATIONS table, so
   * moving a handle and rebuilding puts the sign post, chair, prompt zone or
   * obstacle circle exactly where a normal visit would.
   */
  editorHandles(id) {
    const s = STATION_BY_ID.get(id);
    if (!s) return [];
    // effective yaw: stations without an explicit one face their sit prompt
    const yaw = s.yaw ?? Math.atan2(s.hs[0] - s.at[0], s.hs[1] - s.at[1]);
    const out = [
      { key: 'at', label: `${id}: prop`, xz: s.at, color: 0xf2b64a, yaw },
      { key: 'sign', label: `${id}: sign`, xz: s.sign, color: 0x7ee0ff },
      { key: 'hs', label: `${id}: sit zone`, xz: s.hs, color: 0xe8657a },
      { key: 'aiAt', label: `${id}: vs-bot zone`, xz: s.aiAt, color: 0xe8657a },
    ];
    s.seats.forEach((q, i) => out.push({
      key: `seats.${i}`, label: `${id}: chair ${i + 1}`, xz: q, color: 0x7ac74f,
    }));
    return out.map((h) => ({ ...h, y: 0 }));
  }

  /** Turn one dragged handle into a patch for src/world/layout.js. */
  editorPatch(id, key, xz) {
    const s = STATION_BY_ID.get(id);
    if (!s) return null;
    if (key.startsWith('seats.')) {
      const seats = s.seats.map((q) => q.slice());
      seats[+key.split('.')[1]] = xz;
      return { seats };
    }
    return { [key]: xz };
  }

  /** Move every number of a station together (Shift-drag on the prop handle). */
  editorPatchAll(id, dx, dz) {
    const s = STATION_BY_ID.get(id);
    if (!s) return null;
    const m = ([x, z]) => [+(x + dx).toFixed(2), +(z + dz).toFixed(2)];
    return { at: m(s.at), hs: m(s.hs), aiAt: m(s.aiAt), sign: m(s.sign), seats: s.seats.map(m) };
  }

  /** The pasteable STATIONS row, as the room currently stands. */
  editorExport(id) {
    const s = STATION_BY_ID.get(id);
    if (!s) return null;
    const p = ([x, z]) => `[${x.toFixed(2)}, ${z.toFixed(2)}]`;
    const yaw = s.yaw != null ? ` yaw: ${s.yaw.toFixed(3)},` : '';
    return `${id} (STATIONS row):\n`
      + `  at: ${p(s.at)}, hs: ${p(s.hs)}, aiAt: ${p(s.aiAt)}, sign: ${p(s.sign)},${yaw}\n`
      + `  seats: [${s.seats.map(p).join(', ')}],`;
  }

  // -------------------------------------------------------------------------
  update(dt) {
    const t = (this.t += dt);
    const d = this._d;

    // the lamplight of the loft, spilling down the stair
    const w = Math.sin(t * 1.9);
    this._loftGlow.material.opacity = 0.46 + w * 0.07;
    this._loftPool.material.opacity = 0.2 + w * 0.05;
    this._loftPool.scale.setScalar(1 + w * 0.04);

    // string lights twinkle (harder after dusk: see onClock)
    for (let i = 0; i < this._bulbSeed.length; i++) {
      const k = (0.7 + 0.3 * Math.sin(t * 2.0 + this._bulbSeed[i])) * this._glowK;
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

    // Keep the local capybara settled in their chair while they wait, and take
    // the chair back off them the moment they wander off it.
    //
    // The bug this fixes: sitting is a server-side claim, but the world lets
    // you walk out of the chair whenever you like. Anyone who clicked the floor
    // while seated strolled away still holding the table, still showing "Stand
    // up", still blocking the seat for everyone else until they left the room.
    // A walk whose destination IS the chair is exempt, because that is exactly
    // what _setLocalTable orders up when the seat is granted.
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
    this._loftGlow = null;
    this._loftPool = null;
    this._bulbs = null;
    this._bulbSeed = null;
    this._views = null;
    this._skyMat = null;
    this._fog = null;
    this._sun = null;
    this._lamps = null;
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
