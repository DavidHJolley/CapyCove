import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { createAvatar } from '../../player/avatar.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/* ---------------------------------------------------------------------------
 * The Glimmer Mine (docs/PARTY-GAMES.md, wave 6).
 *
 * A cozy-dark cavern under Frosty Peak. Layout looking north (-Z is deep):
 *   -Z   rock end wall, the round PROP HUNT door, six join pads on a timber
 *        deck, the HUNTERS n/6 board hanging over it
 *    0   rail spur running west into the rickety elevator cage
 *   +Z   the mess: spool table, crates, lantern strings  ->  BOT_ZONES.mine
 *        (flat, clear, obstacle-free) -> the timbered adit back up to the peak
 *  sides amber + teal crystal seams at the wall base, ore carts on rails
 *
 * Two live systems, both driven by the server and both room-scoped (their
 * handlers are registered in build() and dropped in dispose()):
 *
 * 1. PASSIVE PROSPECTING. The server ticks coins to everyone standing in the
 *    room; we make that visible. On 'dig-tick' the local capybara pulls out a
 *    pickaxe, turns to the nearest seam and chips at it: shards fly, the seam
 *    twinkles, a "+2" (or "gem!") mote floats up. The payout itself arrives on
 *    the normal 'coins' frame with reason 'mining', so the mote reads its
 *    number from there and is only spawned at the first swing impact, by which
 *    point both frames have landed whichever order they came in. Other
 *    capybaras in the room chip away on their own decorative loop so the place
 *    reads as a colony of contented miners rather than a waiting room.
 *
 * 2. PROP HUNT LOBBY, at the round door, using the peak's race-lobby pattern.
 *      out  {t:'ph-join'} {t:'ph-leave'}
 *      in   'ph-lobby' {players:[{id,name}], starting}   'ph-start' {seed, players}
 *    Joined players stand on the six lit pads; the board counts them. On
 *    'ph-start' we park the roster on game.__partyCtx in the shape
 *    src/minigames/games/prophunt.js documents ({game, seed, players,
 *    seekerId, youAre}) and launch 'prophunt'; the "Seek alone" prompt on the
 *    east floor launches the same game with a null ctx. __huntCtx is kept as
 *    an alias of the same object for anything reading the room-side name.
 *
 * No shadow-casting light: this is a lantern-lit cave, and a directional sun
 * with a shadow map reads as daylight leaking through the rock (same call the
 * Groove Grotto makes). Depth comes from the fog, the point lights and the
 * glow materials instead.
 *
 * THE CAMERA CORRIDOR (read before adding anything overhead). The follow camera
 * sits at the player + (0, 11.5, 17.5), i.e. SOUTH of them and up, so every prop
 * with a bigger z than the player stands between the two. The sight line to a
 * capybara's body d paces south of them runs from 0.7 + 0.62*d (shins) to
 * 1.9 + 0.55*d (hat). A prop is safe when it sits entirely under the first or
 * over the second at its own z; anything in between is pasted over the player.
 * That is why the stalactite field stops at the rim and skips the southern arc,
 * why the adit has rock shoulders but no crown, why the spine frames carry one
 * slim lintel instead of a lintel + cap + roof boarding, and why the lantern
 * strings run high and across rather than down the middle of the room. Keep it
 * that way: the mine reads as crowded the moment something tall lands in here.
 * ------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const BZ = BOT_ZONES.mine; // { x: 0, z: 3, r: 4 } - must stay flat and clear

const C = {
  rock: 0x4a3a2c,
  rockLit: 0x5d4a37,
  rockDark: 0x33261c,
  rockDeep: 0x241a13,
  floor: 0x54402c,
  floorLit: 0x66503a,
  floorDark: 0x3b2c1e,
  dirt: 0x6b543a,
  wood: 0x8a6642,
  woodLit: 0xb08a5a,
  woodDark: 0x5c4028,
  iron: 0x6a6f78,
  ironDark: 0x474c55,
  ironLit: 0x8f96a2,
  amber: 0xf2b64a,
  amberHot: 0xffd06a,
  teal: 0x42d6c8,
  tealDeep: 0x2aa89c,
  warm: 0xffd08a,
  ember: 0xffb45c,
  coral: 0xe8657a,
  cream: 0xfff6e3,
  day: 0xcfe6ff,
  leaf: 0x7ac74f,
};

const FLOOR_R = 14;
const SHELL_R = 17;
const SHELL_SXZ = 1.12;
const SHELL_SY = 0.42;
const SHELL_Y = 1.6;

// timber deck in front of the round door: the hunt lobby stands on this
const DECK = { x0: -6.6, x1: 6.6, z0: -10.4, z1: -5.2, y: 0.34 };
const WALL_Z = -10.9;              // rock end wall face
const DOOR = { y: 2.5, z: -11.0, r: 1.9 };
const SLOT_Z = -7.0;
const HUNT_SLOTS = [-5.125, -3.075, -1.025, 1.025, 3.075, 5.125].map((x) => ({ x, z: SLOT_Z }));
const SLOT_YAW = 0;                // face +Z: the lineup looks out at the room
const DEFAULT_FUR = 0xb08a5a;      // the lobby frame is id+name only

const RAIL = { x: 6.6, z0: -9.2, z1: 6.2 };
const SPUR = { z: -3.2, x0: -8.4, x1: 5.2 };
const LIFT = { x: -9.4, z: -3.2 };
const MESS = { x: -6.8, z: 3.6 };
const ADIT_Z = 11.3;

// Crystal seams at the wall base: [x, z, teal?, count]. Amber and teal, the
// Groove Grotto's crystals warmed up for a working mine.
const WALL_SEAMS = [
  [-12.8, -0.2, 0, 7], [-11.8, 6.2, 1, 6], [-8.4, 10.4, 0, 5], [8.6, 10.2, 1, 5],
  [11.9, 6.0, 0, 6], [12.6, -1.4, 1, 6], [11.2, -8.0, 0, 6], [-11.0, -8.2, 1, 6],
];
// Veined boulders ringing the mess, and low nubs just outside the bot zone.
// Between them nobody standing in the chatting area is ever more than a couple
// of paces from something worth swinging a pick at.
const BOULDER_SEAMS = [[-5.4, -0.4, 0, 1.0], [5.2, 0.6, 1, 0.9], [-2.6, 7.6, 1, 0.9], [8.8, 4.8, 0, 1.0]];
const NUB_SEAMS = [[-4.5, 5.6, 0], [4.3, 5.4, 1], [-4.2, 0.6, 1], [4.0, 0.4, 0], [0.2, -1.7, 0]];

const CHIP_N = 54;   // shard particles, recycled
const PICK_MAX = 6;  // concurrent diggers (one local + a few neighbours)

/* --- small math ----------------------------------------------------------- */

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

/* --- geometry assembly (same toolkit the peak and the den use) ------------- */

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

/** A cylinder strung between two points (cables, wires, rails, pipes). */
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

function solidMesh(parts) {
  return new THREE.Mesh(mergeParts(parts), makeToon(0xffffff, VC));
}

function glowMesh(parts) {
  const mat = makeGlow(0xfffdf5, { unique: true });
  mat.vertexColors = true;
  mat.needsUpdate = true;
  const m = new THREE.Mesh(mergeParts(parts), mat);
  m.userData.mat = mat;
  return m;
}

/** Unlit material carrying a canvas texture: signs stay legible in the dark. */
function signMat(tex, { double = false, transparent = false } = {}) {
  const m = makeGlow(0xffffff, { unique: true });
  m.map = tex;
  if (double) m.side = THREE.DoubleSide;
  if (transparent) { m.transparent = true; m.depthWrite = false; }
  m.needsUpdate = true;
  return m;
}

/** Hard-edged low-poly look: MeshToonMaterial has no flatShading flag. */
function faceted(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

function caveNoise(x, y, z) {
  return (
    Math.sin(x * 0.58 + y * 0.85) * 0.55 +
    Math.sin(z * 0.74 - y * 0.5) * 0.45 +
    Math.sin((x + z) * 1.2 + 1.4) * 0.28 +
    Math.sin((x - z) * 2.0 - y * 1.25) * 0.16
  );
}

/** Push every vertex along its own direction by noise: lumpy low-poly rock. */
function displaceRadial(geo, amp) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const len = v.length();
    if (len < 1e-4) continue;
    v.multiplyScalar(1 + (caveNoise(v.x, v.y, v.z) * amp) / len);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** instanceColor only reaches the shader when the geometry has a colour attr. */
function whiteVertexColors(geo) {
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geo;
}

/** InstancedMesh whose per-instance colour we drive from update(). */
function instancedGlow(geo, count) {
  const mat = makeGlow(0xffffff, { unique: true });
  mat.vertexColors = true;
  const im = new THREE.InstancedMesh(whiteVertexColors(geo), mat, count);
  const c = new THREE.Color(0xffffff);
  for (let i = 0; i < count; i++) im.setColorAt(i, c);
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  return im;
}

/* --- canvas textures ------------------------------------------------------ */

function dotTexture() {
  return canvasTexture(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,244,214,1)');
    g.addColorStop(0.45, 'rgba(255,206,130,0.5)');
    g.addColorStop(1, 'rgba(255,180,92,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

function glowPoolTexture() {
  return canvasTexture(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2 - 1);
    g.addColorStop(0, 'rgba(255,214,150,0.95)');
    g.addColorStop(0.45, 'rgba(255,196,120,0.34)');
    g.addColorStop(1, 'rgba(255,190,110,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
}

/** The slice of daylight at the top of the adit, seen from inside. */
function daylightTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#8fb6d8');
    g.addColorStop(0.4, '#cfe6ff');
    g.addColorStop(1, '#ffffff');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < 5; i++) {
      c.beginPath();
      c.ellipse(40 + i * 46, 44 + (i % 3) * 26, 34, 12, 0, 0, TAU);
      c.fill();
    }
    // a hint of snow banked at the bottom of the opening
    c.fillStyle = '#eef6ff';
    c.beginPath();
    c.ellipse(w / 2, h + 26, w * 0.72, 54, 0, 0, TAU);
    c.fill();
  });
}

/** The warm tunnel you see through the adit's timber frame from outside... */
function aditSignTexture() {
  return canvasTexture(512, 200, (c, w, h) => {
    c.fillStyle = '#fff6e3';
    c.beginPath();
    c.roundRect(6, 6, w - 12, h - 12, 22);
    c.fill();
    c.strokeStyle = '#5c4028';
    c.lineWidth = 10;
    c.beginPath();
    c.roundRect(6, 6, w - 12, h - 12, 22);
    c.stroke();

    // up-arrow, the way out
    c.fillStyle = '#4fb3e8';
    c.beginPath();
    c.moveTo(74, 60);
    c.lineTo(112, 108);
    c.lineTo(92, 108);
    c.lineTo(92, 148);
    c.lineTo(56, 148);
    c.lineTo(56, 108);
    c.lineTo(36, 108);
    c.closePath();
    c.fill();

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(90,60,35,0.24)';
    c.font = '900 60px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('FROSTY PEAK', w / 2 + 44, 84);
    c.fillStyle = '#2d2417';
    c.fillText('FROSTY PEAK', w / 2 + 40, 80);
    c.fillStyle = '#8a6242';
    c.font = '700 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('mind your head on the way up', w / 2 + 40, 138);
  });
}

function messSignTexture() {
  return canvasTexture(512, 256, (c, w, h) => {
    c.fillStyle = '#f6e6c8';
    c.beginPath();
    c.roundRect(6, 6, w - 12, h - 12, 20);
    c.fill();
    c.fillStyle = '#f2b64a';
    c.beginPath();
    c.roundRect(6, 6, w - 12, 66, [20, 20, 0, 0]);
    c.fill();
    c.strokeStyle = '#5c4028';
    c.lineWidth = 10;
    c.beginPath();
    c.roundRect(6, 6, w - 12, h - 12, 20);
    c.stroke();

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#3a2a18';
    c.font = '900 42px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('THE GLIMMER MINE', w / 2, 40);

    c.fillStyle = '#5c4028';
    c.font = '700 32px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('every 30 seconds:', w / 2, 108);
    c.fillStyle = '#2d2417';
    c.font = '900 62px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('+2 coins', w / 2, 158);
    c.fillStyle = '#8a6242';
    c.font = '700 27px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('just for standing about. chat away.', w / 2, 210);
  });
}

function doorPlateTexture() {
  return canvasTexture(512, 176, (c, w, h) => {
    c.fillStyle = '#2d2417';
    c.beginPath();
    c.roundRect(4, 4, w - 8, h - 8, 18);
    c.fill();
    c.strokeStyle = '#f2b64a';
    c.lineWidth = 7;
    c.beginPath();
    c.roundRect(14, 14, w - 28, h - 28, 14);
    c.stroke();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffe9b8';
    c.font = '900 66px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('PROP HUNT', w / 2, 62);
    c.fillStyle = '#f2b64a';
    c.font = '700 30px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('six capys · one seeker · hold still', w / 2, 124);
  });
}

function soloPosterTexture() {
  return canvasTexture(384, 288, (c, w, h) => {
    c.fillStyle = '#f6e6c8';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(120,88,52,0.12)';
    for (let i = 0; i < h; i += 14) c.fillRect(0, i, w, 5);
    c.strokeStyle = '#5c4028';
    c.lineWidth = 8;
    c.strokeRect(8, 8, w - 16, h - 16);

    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#c44a60';
    c.font = '900 52px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('SEEK', w / 2, 58);
    c.fillText('ALONE', w / 2, 112);

    // a crate with two ears poking out of it
    c.fillStyle = '#8a6642';
    c.fillRect(w / 2 - 62, 158, 124, 84);
    c.strokeStyle = '#5c4028';
    c.lineWidth = 6;
    c.strokeRect(w / 2 - 62, 158, 124, 84);
    c.beginPath();
    c.moveTo(w / 2 - 62, 158);
    c.lineTo(w / 2 + 62, 242);
    c.moveTo(w / 2 + 62, 158);
    c.lineTo(w / 2 - 62, 242);
    c.stroke();
    c.fillStyle = '#b08a5a';
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(w / 2 + s * 26, 150, 15, 19, 0, 0, TAU);
      c.fill();
    }
    c.fillStyle = '#8a6242';
    c.font = '700 22px system-ui, "Segoe UI", Verdana, sans-serif';
    c.fillText('five AI hiders. good luck.', w / 2, 266);
  });
}

/**
 * The live HUNTERS board over the round door. Redrawn into the SAME canvas on
 * every roster change, so the room only ever owns one texture for it.
 */
function drawHuntersSign(c, w, h, n, starting) {
  c.clearRect(0, 0, w, h);
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
  c.fillText(starting ? 'LIGHTS OUT!' : 'HUNTERS', w / 2, 33);

  c.fillStyle = '#2d2417';
  c.font = '900 50px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(`${n}/6`, 86, 92);

  // six lamp pips, filled left to right
  for (let i = 0; i < 6; i++) {
    const cx = 176 + i * 54;
    c.beginPath();
    c.arc(cx, 92, 20, 0, TAU);
    c.fillStyle = i < n ? (starting ? '#7ac74f' : '#f2b64a') : '#e6dcc4';
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = '#2d2417';
    c.stroke();
    if (i < n) {
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

function huntersSignTexture() {
  return canvasTexture(512, 128, (c, w, h) => drawHuntersSign(c, w, h, 0, false));
}

/** The floating "+2" / "gem!" mote, repainted per payout into one canvas. */
function drawMote(c, w, h, text, gem) {
  c.clearRect(0, 0, w, h);
  c.fillStyle = gem ? '#f2b64a' : '#fff6e3';
  c.beginPath();
  c.roundRect(8, 10, w - 16, h - 20, 26);
  c.fill();
  c.strokeStyle = gem ? '#7a5232' : '#2d2417';
  c.lineWidth = 7;
  c.beginPath();
  c.roundRect(8, 10, w - 16, h - 20, 26);
  c.stroke();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = gem ? '#5f3f28' : '#2d2417';
  c.font = '900 46px system-ui, "Segoe UI", Verdana, sans-serif';
  c.fillText(text, w / 2, h / 2 + 2);
}

/* --- prop geometry (module scope: no per-instance state) ------------------- */

/** A stubby pickaxe, grip at the origin, head at the top of the haft. */
function makePickGeo() {
  const p = [];
  part(p, new THREE.CylinderGeometry(0.045, 0.05, 0.78, 6), C.woodLit, { y: 0.39 });
  part(p, new THREE.BoxGeometry(0.09, 0.09, 0.52), C.ironDark, { y: 0.8 });
  part(p, new THREE.ConeGeometry(0.075, 0.26, 4), C.iron, { rx: Math.PI / 2, y: 0.8, z: 0.38 });
  part(p, new THREE.ConeGeometry(0.075, 0.2, 4), C.iron, { rx: -Math.PI / 2, y: 0.8, z: -0.35 });
  part(p, new THREE.SphereGeometry(0.05, 7, 5), C.amber, { y: 0.02 });
  return mergeParts(p);
}

function makeCrystalGeo() {
  const g = new THREE.ConeGeometry(0.26, 1.15, 5);
  g.translate(0, 0.575, 0);
  return g;
}

/** One ore cart: box body, iron bands, four wheels. */
function makeCartGeo() {
  const p = [];
  part(p, new THREE.BoxGeometry(1.05, 0.62, 1.5), C.wood, { y: 0.72 });
  part(p, new THREE.BoxGeometry(0.92, 0.5, 1.36), C.rockDeep, { y: 0.82 });
  for (const s of [-1, 1]) {
    part(p, new THREE.BoxGeometry(1.12, 0.09, 0.12), C.ironDark, { y: 0.98, z: s * 0.7 });
    part(p, new THREE.BoxGeometry(0.12, 0.09, 1.56), C.ironDark, { x: s * 0.52, y: 0.98 });
  }
  part(p, new THREE.BoxGeometry(1.14, 0.14, 1.58), C.ironDark, { y: 0.44 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      part(p, new THREE.CylinderGeometry(0.19, 0.19, 0.1, 10), C.iron, {
        rz: Math.PI / 2, x: sx * 0.56, y: 0.22, z: sz * 0.48,
      });
    }
    part(p, new THREE.CylinderGeometry(0.05, 0.05, 1.12, 6), C.ironDark, { rz: Math.PI / 2, y: 0.22, z: sx * 0.48 });
  }
  return mergeParts(p);
}

function makeCrateGeo() {
  const p = [];
  part(p, new THREE.BoxGeometry(0.9, 0.86, 0.9), C.wood, { y: 0.43 });
  for (const s of [-1, 1]) {
    part(p, new THREE.BoxGeometry(0.94, 0.1, 0.1), C.woodDark, { y: 0.43, z: s * 0.44 });
    part(p, new THREE.BoxGeometry(0.1, 0.1, 0.94), C.woodDark, { x: s * 0.44, y: 0.43 });
  }
  part(p, new THREE.BoxGeometry(0.94, 0.09, 0.94), C.woodLit, { y: 0.87 });
  return mergeParts(p);
}

function makeBarrelGeo() {
  const p = [];
  part(p, new THREE.CylinderGeometry(0.36, 0.32, 0.92, 12), C.wood, { y: 0.46 });
  part(p, new THREE.TorusGeometry(0.37, 0.045, 5, 14), C.ironDark, { rx: Math.PI / 2, y: 0.24 });
  part(p, new THREE.TorusGeometry(0.37, 0.045, 5, 14), C.ironDark, { rx: Math.PI / 2, y: 0.7 });
  part(p, new THREE.CylinderGeometry(0.34, 0.34, 0.05, 12), C.woodLit, { y: 0.93 });
  return mergeParts(p);
}

/* -------------------------------------------------------------------------- */

export class MineRoom extends Room {
  id = 'mine';
  name = 'The Glimmer Mine';

  build(scene, game) {
    this._t = 0;
    this._game = game;
    this._dummy = new THREE.Object3D();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._col = new THREE.Color();
    this._rng = mulberry32(0x6d1e5a);
    this._instanced = [];
    this._seams = [];
    this._digs = [];
    this._pickPool = [];
    this._pendingDelta = 0;
    this._pendingAt = -99;
    this._pendingGem = false;
    this._botDigT = 3.5;

    // hunt lobby state (see the header note for the wire protocol)
    this._hunters = new Map(); // playerId -> { avatar, slot, tag, hidden }
    this._lobbyCount = 0;
    this._lobbyStarting = false;
    this._localSlot = null;
    this._wasOnline = !!game?.net?.connected;
    this._reconcileT = 0;

    scene.background = new THREE.Color(0x120c08);
    scene.fog = new THREE.FogExp2(0x1a120b, 0.0145);

    this._lights(scene);
    this._cave(scene);
    this._crystals(scene);
    this._timbers(scene);
    this._rails(scene);
    this._elevator(scene);
    this._chamber(scene);
    this._mess(scene);
    this._adit(scene);
    this._rubble(scene); // last: it dodges every collider the others placed
    this._atmosphere(scene);
    this._digFx(scene);

    // Arrivals stand a step beyond the adit's fire ring (radius * 0.8 = 1.92)
    // and outside its arming distance (radius + 0.75 = 3.15), so walking in
    // from the peak does not bounce straight back out; both look north down
    // the room at the round door. Both also stand clear (north) of the one
    // stretch of the camera corridor the entrance cannot avoid: z 6.5 to 9.5,
    // where the adit's own lintel and way-out board cross a capybara's body.
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 5.5),
      from_peak: new THREE.Vector3(0, 0, 6.1),
    };

    this._joinSpot = {
      id: 'hunt-join',
      position: new THREE.Vector3(0, DECK.y, -4.9),
      radius: 3.0,
      label: this._joinLabel(),
      action: (g) => {
        if (g.net?.connected) {
          g.net.send({ t: this._localSlot === null ? 'ph-join' : 'ph-leave' });
        } else {
          // offline: no lobby to join, so the door just runs a solo hunt
          g.__partyCtx = null;
          g.__huntCtx = null;
          g.startMinigame('prophunt');
        }
      },
    };
    this.hotspots.push(
      this._joinSpot,
      {
        // The solo door, out on the east floor: far enough from the lineup that
        // the two prompts never stack on screen.
        id: 'hunt-solo',
        position: new THREE.Vector3(8.2, 0, -4.2),
        radius: 2.4,
        label: 'Seek alone',
        action: (g) => {
          g.__partyCtx = null;
          g.__huntCtx = null;
          g.startMinigame('prophunt');
        },
      },
      {
        id: 'mess-rest',
        // anchored a pace south of the coals, on open floor: the prompt hangs
        // beside the brazier rather than inside it
        position: new THREE.Vector3(MESS.x + 2.0, 0, MESS.z + 3.0),
        radius: 2.2,
        label: 'Warm your paws at the brazier',
        action: (g) => {
          g.audio?.play?.('ding');
          g.toast('You hold both paws out. The coals crackle approvingly.');
        },
      },
      {
        id: 'exit-peak',
        position: new THREE.Vector3(0, 0, 11.0),
        radius: 2.4,
        label: 'Head back up to Frosty Peak',
        action: (g) => g.goToRoom('peak', 'mine'),
      },
    );

    this.cameraHint = { offset: new THREE.Vector3(0, 11.5, 17.5), lookHeight: 1.4 };
    // Whole-room vantage: high and south, framing the chamber - the round door,
    // the six pads and the HUNTERS board - with the mess and the adit in shot.
    // Above the shell's apex (8.7), which is fine: the ceiling is BackSide, so
    // from up here it simply is not drawn.
    // Re-framed by eye at 960x540: the adit (z 11) used to sit at 534px, all
    // but off the bottom of the frame, so the way out of the room was invisible
    // from the whole-room view. Swinging the look point 6.5 south brings it to
    // 424px, and the shorter throw takes a capy from 35px to 36px.
    // Worst hotspot/spawn NDC 0.57.
    this.staticCamera = {
      position: new THREE.Vector3(0, 18.5, 24.5),
      lookAt: new THREE.Vector3(0, 1.5, 3.5),
    };

    // Live only while this room is: every handle is dropped in dispose().
    if (game?.events?.on) {
      this._offLobby = game.events.on('ph-lobby', (m) => this._onLobby(m));
      this._offStart = game.events.on('ph-start', (m) => this._onHuntStart(m));
      this._offDig = game.events.on('dig-tick', (m) => this._onDigTick(m));
      this._offCoins = game.events.on('coins', (total, delta, reason) => this._onCoins(delta, reason));
    }
    this._paintHunters();
  }

  /* --- lighting ----------------------------------------------------------- */

  _lights(scene) {
    scene.add(new THREE.AmbientLight(0x6b4e30, 1.15));
    scene.add(new THREE.HemisphereLight(0xffc078, 0x1d140d, 0.85));

    // the lantern strings over the mess: the warmest thing down here
    this._messLight = new THREE.PointLight(0xffc178, 34, 20, 2);
    this._messLight.position.set(0, 4.6, 3.2);
    scene.add(this._messLight);

    // the round door, so the lobby end never falls dark
    this._doorLight = new THREE.PointLight(0xffb45c, 26, 16, 2);
    this._doorLight.position.set(0, 3.4, -8.4);
    scene.add(this._doorLight);

    // cold spill down the adit, the one daylight in the room
    const day = new THREE.PointLight(0xbcdcff, 20, 14, 2);
    day.position.set(0, 3.0, 12.0);
    scene.add(day);

    // Seam accents: one amber west (which also lights the elevator it sits
    // beside), one teal east. Six point lights is the whole rig: every other
    // glow in here is an unlit material, which costs nothing per fragment.
    this._seamLightA = new THREE.PointLight(0xf7bf62, 18, 16, 2);
    this._seamLightA.position.set(-10.2, 2.4, -1.0);
    scene.add(this._seamLightA);
    this._seamLightB = new THREE.PointLight(0x42d6c8, 14, 15, 2);
    this._seamLightB.position.set(10.6, 2.2, 1.2);
    scene.add(this._seamLightB);
  }

  /** Approximate ceiling height of the shell above (x, z). */
  _ceilY(x, z) {
    const rad = Math.hypot(x, z) / SHELL_SXZ;
    const inner = Math.max(0, SHELL_R * SHELL_R - rad * rad);
    return SHELL_Y + Math.sqrt(inner) * SHELL_SY - 0.35;
  }

  /* --- cave shell, floor, rubble ------------------------------------------ */

  _cave(scene) {
    const rng = this._rng;

    const shellGeo = faceted(displaceRadial(new THREE.SphereGeometry(SHELL_R, 34, 18), 0.95));
    const shell = new THREE.Mesh(shellGeo, makeToon(C.rock, { side: THREE.BackSide }));
    shell.scale.set(SHELL_SXZ, SHELL_SY, SHELL_SXZ);
    shell.position.y = SHELL_Y;
    scene.add(shell);

    // Walkable floor: one disc, vertex-shaded from a warm lantern-lit middle to
    // a dark rim. Detail (lanes, spills, puddles) is dressed on top of it.
    const geo = new THREE.CircleGeometry(FLOOR_R, 56);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const lit = new THREE.Color(C.floorLit);
    const dark = new THREE.Color(C.floorDark);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i)) / FLOOR_R;
      tmp.copy(lit).lerp(dark, Math.min(1, r * r * 1.15));
      col[i * 3] = tmp.r;
      col[i * 3 + 1] = tmp.g;
      col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const floor = new THREE.Mesh(geo, makeToon(0xffffff, { vertexColors: true, steps: 4 }));
    scene.add(floor);
    this.groundMeshes.push(floor);

    // unwalkable apron so the rock reads as solid all the way to the wall base
    const apron = new THREE.Mesh(new THREE.RingGeometry(FLOOR_R - 0.2, 20.5, 56, 1), makeToon(C.rockDark));
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.03;
    scene.add(apron);

    // ---- floor dressing: trodden lane, spoil, puddles ----------------------
    const p = [];
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const lz = 10.4 - t * 15.6;
      const lx = Math.sin(t * 2.6) * 0.7;
      part(p, new THREE.BoxGeometry(2.6 + rng() * 0.8, 0.05, 1.5), C.dirt, {
        ry: (rng() - 0.5) * 0.24, x: lx, y: 0.018, z: lz,
      });
    }
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      part(p, new THREE.BoxGeometry(1.5, 0.05, 2.0 + rng() * 0.7), C.dirt, {
        ry: (rng() - 0.5) * 0.2, x: -7.4 + t * 12.0, y: 0.016, z: SPUR.z + Math.sin(t * 3) * 0.4,
      });
    }
    // loose spoil heaps and dropped rock, well outside the bot zone
    for (const [hx, hz, hs] of [[-7.9, -6.4, 1.2], [8.6, -6.9, 1.0], [-8.6, 8.0, 1.1], [9.4, 8.4, 0.9], [12.2, 2.4, 1.0], [-12.4, 3.0, 0.9]]) {
      for (let k = 0; k < 5; k++) {
        const a = rng() * TAU;
        const rr = rng() * 0.8 * hs;
        part(p, new THREE.IcosahedronGeometry(0.2 + rng() * 0.18, 0), rng() > 0.5 ? C.rockDark : C.rock, {
          sy: 0.7, x: hx + Math.cos(a) * rr, y: 0.1, z: hz + Math.sin(a) * rr,
        });
      }
    }
    scene.add(solidMesh(p));

    // dark puddles with a glinting rim (the drips land in these)
    this._puddles = [[-3.2, 9.0], [7.9, -1.2], [-8.0, 0.4]];
    const pud = [];
    for (const [px, pz] of this._puddles) {
      part(pud, new THREE.CircleGeometry(0.72, 16), 0x1c1a18, { rx: -Math.PI / 2, x: px, y: 0.025, z: pz });
    }
    scene.add(solidMesh(pud));
    const ring = [];
    for (const [px, pz] of this._puddles) {
      part(ring, new THREE.TorusGeometry(0.6, 0.035, 4, 18), C.warm, { rx: -Math.PI / 2, x: px, y: 0.035, z: pz });
    }
    const rings = glowMesh(ring);
    rings.material.transparent = true;
    rings.material.opacity = 0.5;
    scene.add(rings);
    this._puddleMat = rings.material;

    // ---- stalactites (instanced) -------------------------------------------
    // Hung around the rim only, short, and never in the southern arc: a spike
    // over the middle of the floor lands square on the camera corridor (see the
    // header) and reads as a black smear pasted across the room. Out here the
    // ceiling is low, so even the longest tip stays above the sight line.
    const dripGeo = faceted(new THREE.ConeGeometry(0.32, 1.5, 6));
    dripGeo.rotateX(Math.PI);
    dripGeo.translate(0, -0.75, 0);
    // mid-tone, not rockDeep: these hang above the lantern lights and a
    // near-black material up there renders as flat cut-outs
    const TITE_N = 22;
    const tites = new THREE.InstancedMesh(dripGeo, makeToon(0x4d3a2a), TITE_N);
    const d = this._dummy;
    let tn = 0;
    for (let i = 0; i < 300 && tn < TITE_N; i++) {
      const a = rng() * TAU;
      const rad = 10.8 + rng() * 3.9;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (z > 2.6 && Math.abs(x) < 10.6) continue;         // the camera corridor
      if (z < WALL_Z + 1.2 && Math.abs(x) < 11) continue;  // behind the end wall
      d.position.set(x, this._ceilY(x, z) + 0.25, z);
      d.rotation.set((rng() - 0.5) * 0.2, rng() * TAU, (rng() - 0.5) * 0.2);
      d.scale.set(0.55 + rng() * 0.55, 0.5 + rng() * 0.75, 0.55 + rng() * 0.55);
      d.updateMatrix();
      tites.setMatrixAt(tn++, d.matrix);
    }
    tites.count = tn;
    tites.instanceMatrix.needsUpdate = true;
    tites.computeBoundingSphere();
    scene.add(tites);
    this._instanced.push(tites);

    d.scale.setScalar(1);
  }

  /**
   * Fallen rock around the rim. Built LAST, after every other collider exists,
   * because a boulder dropped on top of one would leave a re-entrant notch
   * between the two circles for the walk controller's slide to jam in (the
   * lesson the ski lodge's collider capsule was rebuilt around).
   */
  _rubble(scene) {
    const rng = this._rng;
    const d = this._dummy;
    const rocks = new THREE.InstancedMesh(
      faceted(new THREE.IcosahedronGeometry(0.8, 0)), makeToon(C.rockDark), 22,
    );
    let n = 0;
    for (let i = 0; i < 140 && n < 22; i++) {
      const a = rng() * TAU;
      const rad = FLOOR_R - 1.4 + rng() * 4.5;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (z < WALL_Z + 1.4 && Math.abs(x) < 11) continue; // behind the end wall
      const walkable = rad < FLOOR_R - 0.2;
      if (walkable) {
        let clash = false;
        for (const o of this.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + 1.1) { clash = true; break; }
        if (clash) continue;
      }
      d.position.set(x, -0.2 + rng() * 0.25, z);
      d.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      d.scale.set(0.6 + rng() * 1.2, 0.5 + rng() * 0.8, 0.6 + rng() * 1.2);
      d.updateMatrix();
      rocks.setMatrixAt(n++, d.matrix);
      if (walkable) this.obstacles.push({ x, z, r: 0.9 });
    }
    rocks.count = n;
    rocks.instanceMatrix.needsUpdate = true;
    rocks.computeBoundingSphere();
    scene.add(rocks);
    this._instanced.push(rocks);
    d.scale.setScalar(1);
  }

  /* --- crystal seams ------------------------------------------------------ */

  /**
   * Every glowing crystal in the room lives in one instanced draw. Each seam
   * remembers its slice of that buffer so a pick-swing can make exactly the
   * seam being chipped flare (see _startDig / _pulseSeam).
   */
  _crystals(scene) {
    const rng = this._rng;
    const d = this._dummy;
    let total = 0;
    for (const s of WALL_SEAMS) total += s[3];
    for (const _ of BOULDER_SEAMS) total += 3;
    total += NUB_SEAMS.length * 2;

    const crystals = instancedGlow(makeCrystalGeo(), total);
    const bases = [];
    this._cHue = new Float32Array(total);
    this._cPhase = new Float32Array(total);
    this._cPulse = new Float32Array(total);

    let i = 0;
    /**
     * `cap`, where given, is the highest the tip of a crystal in this seam may
     * reach: a seam growing up through the camera corridor hides whoever is
     * standing north of it, so the ones out on the floor and along the southern
     * wall are kept below the sight line rather than left to spike through it.
     */
    const push = (x, z, teal, count, scale, y, cap) => {
      const i0 = i;
      for (let k = 0; k < count; k++, i++) {
        const a = rng() * TAU;
        const rad = rng() * 0.95 * scale;
        const s = (0.5 + rng() * 0.95) * scale;
        let sy = s * (0.8 + rng() * 1.3);
        if (cap !== undefined) sy = Math.min(sy, Math.max(0.2, (cap - y) / 1.15));
        d.position.set(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad);
        d.rotation.set((rng() - 0.5) * 0.55, rng() * TAU, (rng() - 0.5) * 0.55);
        d.scale.set(s * (0.7 + rng() * 0.5), sy, s * (0.7 + rng() * 0.5));
        d.updateMatrix();
        crystals.setMatrixAt(i, d.matrix);
        this._cHue[i] = (teal ? 0.47 : 0.105) + (rng() - 0.5) * 0.03;
        this._cPhase[i] = rng() * TAU;
      }
      this._seams.push({ x, z, y: y + 0.5 * scale, i0, n: count, teal: !!teal });
    };

    for (const [x, z, teal, count] of WALL_SEAMS) {
      // the southern seams are the ones a capybara can end up standing behind
      push(x, z, teal, count, 1.15, -0.12, z > 4 ? 2.9 : undefined);
      for (let k = 0; k < 3; k++) {
        const a = rng() * TAU;
        part(bases, new THREE.IcosahedronGeometry(0.62 + rng() * 0.3, 0), C.rockDeep, {
          sy: 0.7, x: x + Math.cos(a) * 1.15, y: 0.06, z: z + Math.sin(a) * 1.15,
        });
      }
      this.obstacles.push({ x, z, r: 1.6 });
    }
    for (const [x, z, teal, r] of BOULDER_SEAMS) {
      part(bases, new THREE.IcosahedronGeometry(r * 0.95, 0), C.rock, { sy: 0.78, x, y: r * 0.42, z });
      part(bases, new THREE.IcosahedronGeometry(r * 0.55, 0), C.rockDark, { x: x + r * 0.5, y: r * 0.3, z: z - r * 0.4 });
      push(x, z, teal, 3, 0.62, r * 0.55, 1.85);
      this.obstacles.push({ x, z, r });
    }
    // Low nubs just outside the bot zone: no colliders, ankle height, and the
    // reason a capybara standing in the mess is always a pace from a seam.
    for (const [x, z, teal] of NUB_SEAMS) {
      part(bases, new THREE.IcosahedronGeometry(0.34, 0), C.rockDark, { sy: 0.6, x, y: 0.1, z });
      push(x, z, teal, 2, 0.34, 0.12);
    }

    scene.add(solidMesh(bases));
    scene.add(crystals);
    this._crystalMesh = crystals;
    this._instanced.push(crystals);
  }

  /* --- timber supports + lantern strings ---------------------------------- */

  /**
   * One portal frame: two posts, a lintel, corner braces, a snow of dust.
   * `slim` drops the cap plate and thins the lintel: a frame that spans the
   * room puts its whole depth across the camera corridor, and 0.26 of timber
   * crosses a capybara for half a pace where 0.7 of stacked timber crossed
   * them for two (and the roof boarding, which triples it, is skipped too).
   */
  _frame(p, x, z, halfW, h, yaw = 0, slim = false) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const sx of [-1, 1]) {
      const px = x + sx * halfW * c;
      const pz = z - sx * halfW * s;
      part(p, new THREE.BoxGeometry(0.34, h, 0.34), sx > 0 ? C.wood : C.woodDark, { ry: yaw, x: px, y: h / 2, z: pz });
      part(p, new THREE.BoxGeometry(0.46, 0.16, 0.46), C.woodDark, { ry: yaw, x: px, y: 0.08, z: pz });
      // corner brace
      part(p, new THREE.BoxGeometry(0.2, 0.8, 0.2), C.woodLit, {
        rz: sx * 0.72, ry: yaw, x: px - sx * 0.28 * c, y: h - 0.42, z: pz + sx * 0.28 * s,
      });
      this.obstacles.push({ x: px, z: pz, r: 0.42 });
    }
    part(p, new THREE.BoxGeometry(halfW * 2 + 0.8, slim ? 0.26 : 0.34, slim ? 0.34 : 0.36), C.woodLit, {
      ry: yaw, x, y: h + 0.09, z,
    });
    if (!slim) part(p, new THREE.BoxGeometry(halfW * 2 + 0.3, 0.18, 0.5), C.woodDark, { ry: yaw, x, y: h + 0.33, z });
    return { x, z, h, halfW, yaw, slim };
  }

  _timbers(scene) {
    const p = [];
    // Spine frames. These are the only things in here that cross the whole room,
    // so both are slim and sit at heights whose sight line lands on floor nobody
    // stands on: f2 clears the six join pads, f3 clears the elevator walk, the
    // deck approach and the join prompt (see the camera corridor in the header).
    // There is deliberately no third frame over the entrance half: the arrival
    // walk and the mess share their floor with the bot zone, so every height a
    // frame at z 8.6 could take put its lintel across somebody's head. The adit
    // portal carries the timbering up there on its own.
    //
    // f2's posts stand off the deck's front corners: a 12-wide lane onto the
    // stage, and both posts clear of the cart parked on the spur behind them
    const f2 = this._frame(p, 0, -4.4, 6.0, 3.7, 0, true);
    const f3 = this._frame(p, 0, 2.2, 8.4, 3.4, 0, true);
    // rail frames on the east run
    const f4 = this._frame(p, RAIL.x, -7.6, 1.5, 3.0);
    const f5 = this._frame(p, RAIL.x, 3.4, 1.5, 3.0);
    // West, over the spur into the elevator: slim and low, because it stands
    // between the camera and the two western join pads and a full-fat header
    // here crossed a waiting capybara from the knees to the chin.
    const f6 = this._frame(p, -5.0, SPUR.z, 1.6, 2.7, 0, true);

    // ceiling boarding, so the roof reads as held up: only over the two rail
    // frames, whose lintels are 3.8 wide and well off every walking lane
    for (const f of [f2, f3, f4, f5, f6]) {
      if (f.slim) continue;
      for (let i = -1; i <= 1; i++) {
        part(p, new THREE.BoxGeometry(f.halfW * 2 + 0.6, 0.12, 0.3), i ? C.wood : C.woodLit, {
          ry: f.yaw, x: f.x + Math.sin(f.yaw) * i * 0.55, y: f.h + 0.5, z: f.z + Math.cos(f.yaw) * i * 0.55,
        });
      }
    }
    scene.add(solidMesh(p));

    // ---- lantern strings ---------------------------------------------------
    // Hung across the room and high, never down the middle of it: a run along
    // the camera axis put a bulb on every capybara's face for its whole length,
    // and a sag at 3.0 is exactly where the sight line to a standing capybara
    // passes four paces out. These clear the tallest hat by a good margin.
    const wire = [];
    const bulbs = [];
    const runs = [
      [[-4.2, 4.85, 8.2], [4.2, 4.85, 8.2], 5],
      [[-8.6, 4.5, 5.4], [-3.0, 4.85, 8.2], 4],
      [[-8.4, 4.7, 2.2], [8.4, 4.7, 2.2], 8],
      [[-8.2, 3.5, 2.2], [-5.0, 3.1, -3.0], 4],
      [[8.2, 3.5, 2.2], [6.6, 3.1, 3.4], 3],
      [[-6.2, 4.35, -1.2], [-2.0, 4.6, 1.2], 3],
    ];
    this._bulbSeed = [];
    let total = 0;
    for (const r of runs) total += r[2];
    const bulbMesh = instancedGlow(new THREE.SphereGeometry(0.115, 8, 6), total);
    const d = this._dummy;
    let bi = 0;
    for (const [a, b, count] of runs) {
      let prev = a;
      for (let i = 1; i <= count + 1; i++) {
        const t = i / (count + 1);
        const sag = Math.sin(Math.PI * t) * 0.42;
        const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag, a[2] + (b[2] - a[2]) * t];
        link(wire, prev, pt, 0.018, C.ironDark, 4);
        prev = pt;
        if (i <= count) {
          const y = pt[1] - 0.2;
          part(bulbs, new THREE.ConeGeometry(0.16, 0.2, 6), C.ironDark, { x: pt[0], y: y + 0.16, z: pt[2] });
          d.position.set(pt[0], y, pt[2]);
          d.rotation.set(0, 0, 0);
          d.scale.setScalar(1);
          d.updateMatrix();
          bulbMesh.setMatrixAt(bi, d.matrix);
          this._bulbSeed.push((bi * 2.399) % TAU);
          bi++;
        }
      }
    }
    bulbMesh.count = bi;
    bulbMesh.instanceMatrix.needsUpdate = true;
    bulbMesh.computeBoundingSphere();
    for (const g of bulbs) wire.push(g);
    scene.add(solidMesh(wire));
    scene.add(bulbMesh);
    this._bulbs = bulbMesh;
    this._instanced.push(bulbMesh);
  }

  /* --- rails, carts ------------------------------------------------------- */

  _rails(scene) {
    const p = [];
    const gauge = 0.46;

    // main north-south run on the east side
    for (const s of [-1, 1]) {
      part(p, new THREE.BoxGeometry(0.1, 0.11, RAIL.z1 - RAIL.z0), C.iron, {
        x: RAIL.x + s * gauge, y: 0.13, z: (RAIL.z0 + RAIL.z1) / 2,
      });
    }
    for (let z = RAIL.z0; z <= RAIL.z1; z += 0.9) {
      part(p, new THREE.BoxGeometry(1.4, 0.1, 0.28), C.woodDark, { x: RAIL.x, y: 0.05, z });
    }
    // west spur into the elevator
    for (const s of [-1, 1]) {
      part(p, new THREE.BoxGeometry(SPUR.x1 - SPUR.x0, 0.11, 0.1), C.iron, {
        x: (SPUR.x0 + SPUR.x1) / 2, y: 0.13, z: SPUR.z + s * gauge,
      });
    }
    for (let x = SPUR.x0; x <= SPUR.x1; x += 0.9) {
      part(p, new THREE.BoxGeometry(0.28, 0.1, 1.4), C.woodDark, { x, y: 0.05, z: SPUR.z });
    }
    // junction plate + buffer stops
    part(p, new THREE.BoxGeometry(1.7, 0.12, 1.7), C.ironDark, { x: 5.6, y: 0.07, z: SPUR.z });
    for (const [bx, bz, ry] of [[RAIL.x, RAIL.z1 + 0.2, 0], [RAIL.x, RAIL.z0 - 0.2, 0], [SPUR.x0 - 0.2, SPUR.z, Math.PI / 2]]) {
      part(p, new THREE.BoxGeometry(1.3, 0.42, 0.24), C.woodDark, { ry, x: bx, y: 0.28, z: bz });
      part(p, new THREE.BoxGeometry(1.36, 0.14, 0.3), C.coral, { ry, x: bx, y: 0.53, z: bz });
    }

    // a short stub of rail running out through the adit, ending in the drift
    for (const s of [-1, 1]) {
      part(p, new THREE.BoxGeometry(0.1, 0.11, 4.4), C.iron, { x: s * gauge, y: 0.13, z: 10.6 });
    }
    for (let z = 8.6; z <= 12.6; z += 0.9) {
      part(p, new THREE.BoxGeometry(1.4, 0.1, 0.28), C.woodDark, { x: 0, y: 0.05, z });
    }
    scene.add(solidMesh(p));

    // ---- the carts ---------------------------------------------------------
    const carts = new THREE.InstancedMesh(makeCartGeo(), makeToon(0xffffff, VC), 3);
    const d = this._dummy;
    const spots = [
      [RAIL.x, -1.6, 0],
      [RAIL.x, 4.4, 0],
      // clear of the elevator's collider: two overlapping circles here would
      // notch the only lane along the spur
      [-5.0, SPUR.z, Math.PI / 2],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [x, z, ry] = spots[i];
      d.position.set(x, 0, z);
      d.rotation.set(0, ry, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      carts.setMatrixAt(i, d.matrix);
      this.obstacles.push({ x, z, r: 1.1 });
    }
    carts.computeBoundingSphere();
    scene.add(carts);
    this._instanced.push(carts);

    // ore heaped in the parked carts, glinting
    const ore = [];
    const rng = this._rng;
    for (const [x, z] of [[RAIL.x, -1.6], [-5.0, SPUR.z]]) {
      for (let k = 0; k < 7; k++) {
        const a = rng() * TAU;
        const rr = rng() * 0.34;
        part(ore, new THREE.IcosahedronGeometry(0.13 + rng() * 0.08, 0), k % 3 ? C.amber : C.teal, {
          x: x + Math.cos(a) * rr, y: 1.06 + rng() * 0.1, z: z + Math.sin(a) * rr,
        });
      }
    }
    const oreMesh = glowMesh(ore);
    scene.add(oreMesh);
    this._oreMat = oreMesh.userData.mat;
  }

  /* --- the rickety elevator ----------------------------------------------- */

  _elevator(scene) {
    const g = new THREE.Group();
    g.position.set(LIFT.x, 0, LIFT.z);
    scene.add(g);

    const p = [];
    const H = 6.4;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        part(p, new THREE.BoxGeometry(0.3, H, 0.3), sx * sz > 0 ? C.wood : C.woodDark, {
          x: sx * 1.2, y: H / 2, z: sz * 1.2,
        });
        part(p, new THREE.BoxGeometry(0.44, 0.2, 0.44), C.woodDark, { x: sx * 1.2, y: 0.1, z: sz * 1.2 });
      }
      // cross bracing, both faces
      link(p, [sx * 1.2, 0.4, -1.2], [sx * 1.2, 3.2, 1.2], 0.07, C.woodLit, 4);
      link(p, [sx * 1.2, 3.2, -1.2], [sx * 1.2, 0.4, 1.2], 0.07, C.woodLit, 4);
      link(p, [-1.2, 4.2, sx * 1.2], [1.2, 5.6, sx * 1.2], 0.07, C.woodLit, 4);
    }
    // head beams + winding gear
    for (const sz of [-1, 1]) {
      part(p, new THREE.BoxGeometry(3.1, 0.28, 0.3), C.woodLit, { y: H + 0.1, z: sz * 1.2 });
    }
    part(p, new THREE.CylinderGeometry(0.07, 0.07, 2.7, 6), C.ironDark, { rx: Math.PI / 2, y: H + 0.42 });
    for (const sz of [-1, 1]) {
      part(p, new THREE.CylinderGeometry(0.44, 0.44, 0.16, 14), C.iron, { rx: Math.PI / 2, y: H + 0.42, z: sz * 0.62 });
      part(p, new THREE.TorusGeometry(0.44, 0.06, 5, 16), C.ironDark, { rx: Math.PI / 2, y: H + 0.42, z: sz * 0.62 });
    }
    // the cable, hanging slack over the drum
    link(p, [0, H + 0.42, 0.62], [0.62, 2.6, 0.62], 0.035, C.ironDark, 4);
    link(p, [0, H + 0.42, -0.62], [-0.62, 2.6, -0.62], 0.035, C.ironDark, 4);
    // spoil chute and a heap of ore at the foot
    part(p, new THREE.BoxGeometry(1.6, 0.16, 2.4), C.woodDark, { rx: 0.34, x: 1.5, y: 1.5, z: 0 });
    g.add(solidMesh(p));

    // ---- the cage itself: bobs gently on its cable -------------------------
    const cage = new THREE.Group();
    cage.position.set(0, 0.5, 0);
    g.add(cage);
    const cp = [];
    part(cp, new THREE.BoxGeometry(1.7, 0.14, 1.7), C.woodLit, { y: 0.07 });
    part(cp, new THREE.BoxGeometry(1.8, 0.16, 1.8), C.ironDark, { y: 2.16 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        part(cp, new THREE.BoxGeometry(0.12, 2.1, 0.12), C.iron, { x: sx * 0.79, y: 1.1, z: sz * 0.79 });
      }
    }
    for (let i = 0; i < 5; i++) {
      const x = -0.68 + i * 0.34;
      part(cp, new THREE.CylinderGeometry(0.035, 0.035, 2.0, 5), C.iron, { x, y: 1.1, z: -0.79 });
    }
    for (let i = 0; i < 4; i++) {
      part(cp, new THREE.BoxGeometry(1.7, 0.07, 0.07), C.ironDark, { y: 0.4 + i * 0.52, z: 0.79 });
    }
    link(cp, [-0.79, 2.2, -0.79], [0, 2.9, 0], 0.03, C.ironDark, 4);
    link(cp, [0.79, 2.2, 0.79], [0, 2.9, 0], 0.03, C.ironDark, 4);
    link(cp, [-0.79, 2.2, 0.79], [0, 2.9, 0], 0.03, C.ironDark, 4);
    link(cp, [0.79, 2.2, -0.79], [0, 2.9, 0], 0.03, C.ironDark, 4);
    cage.add(solidMesh(cp));

    const lampMat = makeGlow(0xffd08a, { unique: true });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), lampMat);
    lamp.position.set(0.5, 1.82, 0.5);
    cage.add(lamp);
    this._liftLampMat = lampMat;
    this._cage = cage;

    // "out of order, sort of" board, hung on the frame facing the room
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 0.62),
      signMat(canvasTexture(384, 140, (c, w, h) => {
        c.fillStyle = '#f6e6c8';
        c.fillRect(0, 0, w, h);
        c.strokeStyle = '#c44a60';
        c.lineWidth = 9;
        c.strokeRect(8, 8, w - 16, h - 16);
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = '#c44a60';
        c.font = '900 46px system-ui, "Segoe UI", Verdana, sans-serif';
        c.fillText('OUT OF ORDER', w / 2, 52);
        c.fillStyle = '#8a6242';
        c.font = '700 26px system-ui, "Segoe UI", Verdana, sans-serif';
        c.fillText('(the capy who fixes it is on a nap)', w / 2, 100);
      }), { double: true }),
    );
    board.position.set(0.2, 2.9, 1.35);
    board.rotation.y = 0.32;
    g.add(board);

    this.obstacles.push({ x: LIFT.x, z: LIFT.z, r: 2.3 });
  }

  /* --- the hunt chamber: end wall, round door, deck, join pads ------------ */

  _chamber(scene) {
    const rng = this._rng;

    // ---- rock end wall -----------------------------------------------------
    const wall = [];
    for (let i = 0; i < 11; i++) {
      const x = -10.5 + i * 2.1;
      const h = 5.2 + Math.abs(Math.sin(i * 1.7)) * 2.2;
      part(wall, faceted(new THREE.BoxGeometry(2.3, h, 1.6 + (i % 3) * 0.4)), i % 2 ? C.rockDark : C.rock, {
        ry: (rng() - 0.5) * 0.12, x, y: h / 2, z: WALL_Z - 0.9 - (i % 3) * 0.14,
      });
    }
    // lumps and a boulder skirt so the wall never reads as a flat slab
    for (let i = 0; i < 14; i++) {
      const x = -10.4 + rng() * 20.8;
      part(wall, faceted(new THREE.IcosahedronGeometry(0.5 + rng() * 0.8, 0)), rng() > 0.5 ? C.rockDeep : C.rockDark, {
        sy: 0.8, x, y: 0.2 + rng() * 3.4, z: WALL_Z + 0.02 - rng() * 0.3,
      });
    }
    scene.add(solidMesh(wall));

    // ---- the timber deck (a real ground mesh: a 0.34 step up) -------------
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(DECK.x1 - DECK.x0, DECK.y, DECK.z1 - DECK.z0),
      makeToon(C.wood),
    );
    deck.position.set((DECK.x0 + DECK.x1) / 2, DECK.y / 2, (DECK.z0 + DECK.z1) / 2);
    scene.add(deck);
    this.groundMeshes.push(deck);

    const dp = [];
    // plank lines + a pale nosing along the front edge, so the step reads
    for (let i = 0; i < 13; i++) {
      part(dp, new THREE.BoxGeometry(DECK.x1 - DECK.x0 - 0.1, 0.03, 0.06), C.woodDark, {
        y: DECK.y + 0.01, x: (DECK.x0 + DECK.x1) / 2, z: DECK.z0 + 0.4 + i * 0.4,
      });
    }
    part(dp, new THREE.BoxGeometry(DECK.x1 - DECK.x0 + 0.2, 0.1, 0.22), C.woodLit, {
      x: (DECK.x0 + DECK.x1) / 2, y: DECK.y - 0.02, z: DECK.z1,
    });
    // corner posts with lamps, the deck's four bollards
    for (const cx of [DECK.x0 + 0.4, DECK.x1 - 0.4]) {
      for (const cz of [DECK.z0 + 0.5, DECK.z1 - 0.5]) {
        part(dp, new THREE.BoxGeometry(0.26, 1.5, 0.26), C.woodDark, { x: cx, y: DECK.y + 0.75, z: cz });
        part(dp, new THREE.ConeGeometry(0.22, 0.2, 4), C.ironDark, { ry: Math.PI / 4, x: cx, y: DECK.y + 1.58, z: cz });
        this.obstacles.push({ x: cx, z: cz, r: 0.35 });
      }
    }

    // ---- the round door ----------------------------------------------------
    part(dp, new THREE.TorusGeometry(DOOR.r + 0.26, 0.3, 6, 26), C.rockDeep, { y: DOOR.y, z: WALL_Z - 0.02 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      part(dp, new THREE.BoxGeometry(0.34, 0.34, 0.42), C.rockDark, {
        rz: a, x: Math.cos(a) * (DOOR.r + 0.5), y: DOOR.y + Math.sin(a) * (DOOR.r + 0.5), z: WALL_Z - 0.06,
      });
    }
    // planked disc, iron bands, a big wheel handle
    part(dp, new THREE.CylinderGeometry(DOOR.r, DOOR.r, 0.3, 22), C.wood, { rx: Math.PI / 2, y: DOOR.y, z: DOOR.z });
    for (let i = 0; i < 9; i++) {
      const x = -DOOR.r + 0.22 + i * ((DOOR.r * 2 - 0.44) / 8);
      const half = Math.sqrt(Math.max(0, DOOR.r * DOOR.r - x * x)) - 0.05;
      part(dp, new THREE.BoxGeometry(0.05, half * 2, 0.06), C.woodDark, { x, y: DOOR.y, z: DOOR.z + 0.18 });
    }
    for (const s of [-1, 1]) {
      const off = s * 0.95;
      const half = Math.sqrt(Math.max(0, DOOR.r * DOOR.r - off * off)) - 0.06;
      part(dp, new THREE.BoxGeometry(half * 2, 0.2, 0.1), C.ironDark, { y: DOOR.y + off, z: DOOR.z + 0.2 });
      part(dp, new THREE.SphereGeometry(0.09, 7, 5), C.iron, { x: half - 0.1, y: DOOR.y + off, z: DOOR.z + 0.26 });
      part(dp, new THREE.SphereGeometry(0.09, 7, 5), C.iron, { x: -half + 0.1, y: DOOR.y + off, z: DOOR.z + 0.26 });
    }
    part(dp, new THREE.TorusGeometry(0.46, 0.075, 6, 18), C.iron, { y: DOOR.y, z: DOOR.z + 0.24 });
    for (let i = 0; i < 4; i++) {
      part(dp, new THREE.BoxGeometry(0.9, 0.09, 0.09), C.iron, { rz: (i / 4) * Math.PI, y: DOOR.y, z: DOOR.z + 0.24 });
    }
    part(dp, new THREE.SphereGeometry(0.15, 9, 7), C.amber, { y: DOOR.y, z: DOOR.z + 0.3 });

    // braziers either side of the door, on the deck
    for (const s of [-1, 1]) {
      const bx = s * 3.4;
      part(dp, new THREE.CylinderGeometry(0.1, 0.14, 1.1, 7), C.ironDark, { x: bx, y: DECK.y + 0.55, z: DOOR.z + 0.9 });
      part(dp, new THREE.CylinderGeometry(0.42, 0.26, 0.42, 10), C.iron, { x: bx, y: DECK.y + 1.28, z: DOOR.z + 0.9 });
      part(dp, new THREE.TorusGeometry(0.42, 0.05, 5, 12), C.ironDark, { rx: Math.PI / 2, x: bx, y: DECK.y + 1.47, z: DOOR.z + 0.9 });
      this.obstacles.push({ x: bx, z: DOOR.z + 0.9, r: 0.5 });
    }
    scene.add(solidMesh(dp));

    // glowing bits of the chamber: door seams, brazier coals, door halo
    const dg = [];
    part(dg, new THREE.CircleGeometry(DOOR.r + 0.2, 24), C.ember, { y: DOOR.y, z: WALL_Z - 0.34 });
    for (const s of [-1, 1]) {
      part(dg, new THREE.SphereGeometry(0.3, 9, 7), C.ember, { sy: 0.5, x: s * 3.4, y: DECK.y + 1.42, z: DOOR.z + 0.9 });
    }
    const glow = glowMesh(dg);
    scene.add(glow);
    this._chamberGlowMat = glow.userData.mat;

    // the plate under the door naming the game
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.0), signMat(doorPlateTexture()));
    plate.position.set(0, DECK.y + 0.62, DOOR.z + 0.42);
    plate.rotation.x = -0.22;
    scene.add(plate);

    // ---- join pads ---------------------------------------------------------
    const pads = [];
    for (const s of HUNT_SLOTS) {
      part(pads, new THREE.CylinderGeometry(0.62, 0.66, 0.08, 14), C.woodDark, { x: s.x, y: DECK.y + 0.04, z: s.z });
      part(pads, new THREE.CylinderGeometry(0.5, 0.5, 0.05, 14), C.dirt, { x: s.x, y: DECK.y + 0.09, z: s.z });
    }
    scene.add(solidMesh(pads));

    const ringGeo = new THREE.TorusGeometry(0.6, 0.055, 5, 18);
    ringGeo.rotateX(-Math.PI / 2);
    this._padRings = instancedGlow(ringGeo, HUNT_SLOTS.length);
    const d = this._dummy;
    for (let i = 0; i < HUNT_SLOTS.length; i++) {
      d.position.set(HUNT_SLOTS[i].x, DECK.y + 0.1, HUNT_SLOTS[i].z);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      this._padRings.setMatrixAt(i, d.matrix);
    }
    this._padRings.computeBoundingSphere();
    scene.add(this._padRings);
    this._instanced.push(this._padRings);

    // hunters stand in their own group so dispose() can empty it without hunting
    this._hunterGroup = new THREE.Group();
    scene.add(this._hunterGroup);

    // ---- the HUNTERS n/6 board, hung over the door -------------------------
    // Hung at 5.1: high enough to clear the door's arch (4.66) and low enough
    // that its top edge is still inside the frame from the arrival spawn, which
    // is the first thing anyone walking in from the peak looks at.
    const sign = new THREE.Group();
    sign.position.set(0, 5.1, DOOR.z + 0.5);
    scene.add(sign);
    const backing = [];
    part(backing, new THREE.BoxGeometry(3.5, 1.0, 0.14), C.woodDark, {});
    part(backing, new THREE.SphereGeometry(0.14, 8, 6), C.amber, { x: -1.66, z: 0.03 });
    part(backing, new THREE.SphereGeometry(0.14, 8, 6), C.amber, { x: 1.66, z: 0.03 });
    link(backing, [-1.4, 0.5, 0], [-1.4, 1.5, -0.5], 0.03, C.ironDark, 4);
    link(backing, [1.4, 0.5, 0], [1.4, 1.5, -0.5], 0.03, C.ironDark, 4);
    sign.add(solidMesh(backing));
    this._huntersTex = huntersSignTexture();
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.32, 0.83), signMat(this._huntersTex));
    face.position.z = 0.09;
    sign.add(face);
    this._huntersSign = sign;
    this._signBaseY = 5.1;

    // ---- the solo corner, out east ----------------------------------------
    const sp = [];
    part(sp, new THREE.BoxGeometry(0.18, 2.6, 0.18), C.woodDark, { x: 8.9, y: 1.3, z: -4.2 });
    part(sp, new THREE.BoxGeometry(0.9, 0.14, 0.14), C.woodDark, { x: 8.5, y: 2.5, z: -4.2 });
    part(sp, new THREE.ConeGeometry(0.24, 0.2, 4), C.ironDark, { ry: Math.PI / 4, x: 8.15, y: 2.36, z: -4.2 });
    // a pickaxe left stuck in a boulder, waiting for a volunteer
    part(sp, new THREE.IcosahedronGeometry(0.62, 0), C.rock, { sy: 0.8, x: 8.9, y: 0.3, z: -3.2 });
    part(sp, new THREE.CylinderGeometry(0.05, 0.055, 0.9, 6), C.woodLit, { rz: 0.5, x: 9.05, y: 1.0, z: -3.2 });
    part(sp, new THREE.BoxGeometry(0.09, 0.09, 0.5), C.ironDark, { rz: 0.5, x: 9.26, y: 1.4, z: -3.2 });
    scene.add(solidMesh(sp));

    const soloLamp = [];
    part(soloLamp, new THREE.BoxGeometry(0.2, 0.26, 0.2), C.warm, { x: 8.15, y: 2.18, z: -4.2 });
    const sl = glowMesh(soloLamp);
    scene.add(sl);
    this._soloLampMat = sl.userData.mat;

    const poster = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9), signMat(soloPosterTexture(), { double: true }));
    poster.position.set(8.86, 1.6, -4.1);
    poster.rotation.y = -0.9;
    scene.add(poster);
    this.obstacles.push({ x: 8.95, z: -3.6, r: 0.7 });
  }

  /* --- the mess: crates, spool table, brazier, notice board --------------- */

  _mess(scene) {
    const rng = this._rng;
    const p = [];

    // cable-spool table with mugs and a lantern, west of the bot zone
    part(p, new THREE.CylinderGeometry(1.05, 1.05, 0.12, 16), C.woodLit, { x: MESS.x, y: 0.84, z: MESS.z });
    part(p, new THREE.CylinderGeometry(0.34, 0.34, 0.84, 10), C.woodDark, { x: MESS.x, y: 0.42, z: MESS.z });
    part(p, new THREE.CylinderGeometry(1.0, 1.0, 0.14, 16), C.wood, { x: MESS.x, y: 0.07, z: MESS.z });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.6;
      const mx = MESS.x + Math.cos(a) * 0.5;
      const mz = MESS.z + Math.sin(a) * 0.5;
      const hue = [C.coral, C.teal, C.amber][i];
      part(p, new THREE.CylinderGeometry(0.13, 0.11, 0.22, 9), hue, { x: mx, y: 1.01, z: mz });
      part(p, new THREE.TorusGeometry(0.075, 0.022, 4, 8), hue, { x: mx + 0.15, y: 1.01, z: mz });
    }
    this.obstacles.push({ x: MESS.x, z: MESS.z, r: 1.5 });

    // barrel stools around it
    const stools = new THREE.InstancedMesh(makeBarrelGeo(), makeToon(0xffffff, VC), 5);
    const d = this._dummy;
    const stoolAt = [
      [MESS.x + 1.7, MESS.z - 0.9], [MESS.x + 0.6, MESS.z + 1.8], [MESS.x - 1.7, MESS.z + 0.7],
      [MESS.x - 0.9, MESS.z - 1.7], [4.9, 7.7],
    ];
    for (let i = 0; i < stoolAt.length; i++) {
      const [x, z] = stoolAt[i];
      d.position.set(x, 0, z);
      d.rotation.set(0, rng() * TAU, 0);
      d.scale.setScalar(0.92 + rng() * 0.16);
      d.updateMatrix();
      stools.setMatrixAt(i, d.matrix);
      this.obstacles.push({ x, z, r: 0.55 });
    }
    stools.computeBoundingSphere();
    scene.add(stools);
    this._instanced.push(stools);

    // crate stacks: the pantry, the tool store and the spare props
    const crates = new THREE.InstancedMesh(makeCrateGeo(), makeToon(0xffffff, VC), 11);
    // ...and two up at the back of the hunt deck, where the spare props live
    const crateAt = [
      [5.8, 6.4, 0], [5.9, 6.5, 0.9], [6.6, 7.1, 0], [-7.2, 7.3, 0], [-7.9, 7.9, 0],
      [-7.3, 7.4, 0.9], [9.8, 1.2, 0], [9.9, 1.3, 0.9], [-9.2, 6.0, 0], [4.9, -9.9, 0], [-4.9, -9.9, 0],
    ];
    for (let i = 0; i < crateAt.length; i++) {
      const [x, z, y] = crateAt[i];
      d.position.set(x, y + (z < -5 ? DECK.y : 0), z);
      d.rotation.set(0, rng() * 0.7 - 0.35, 0);
      d.scale.setScalar(0.9 + rng() * 0.25);
      d.updateMatrix();
      crates.setMatrixAt(i, d.matrix);
      if (y === 0) this.obstacles.push({ x, z, r: 0.8 });
    }
    crates.computeBoundingSphere();
    scene.add(crates);
    this._instanced.push(crates);
    d.scale.setScalar(1);

    // The brazier the mess gathers round, set a clear pace off the spool table
    // so their two colliders never cross into a notch.
    const bx = MESS.x + 2.0;
    const bz = MESS.z + 1.6;
    part(p, new THREE.CylinderGeometry(0.52, 0.34, 0.5, 12), C.iron, { x: bx, y: 0.42, z: bz });
    part(p, new THREE.TorusGeometry(0.52, 0.06, 5, 14), C.ironDark, { rx: Math.PI / 2, x: bx, y: 0.66, z: bz });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU;
      part(p, new THREE.CylinderGeometry(0.055, 0.055, 0.4, 5), C.ironDark, {
        rz: Math.cos(a) * 0.3, rx: Math.sin(a) * 0.3, x: bx + Math.cos(a) * 0.3, y: 0.2, z: bz + Math.sin(a) * 0.3,
      });
    }
    this.obstacles.push({ x: bx, z: bz, r: 0.75 });

    // Notice board on two posts, square to the play camera. Stood beside the
    // stores rather than out on the open floor: a 2.4-high board anywhere south
    // of the mess sits chest-high across whoever is standing at the brazier,
    // and out here the only sight lines through it are the crate corner's.
    const nx = -6.4;
    const nz = 9.4;
    for (const s of [-1, 1]) {
      // posts sit a step NORTH of the face: at z = nz their 0.11 radius poked
      // 0.09 through the sign plane (nz + 0.02) and guillotined the title's
      // edge letters from the play camera (seen: "HE GLIMMER MIN")
      part(p, new THREE.CylinderGeometry(0.09, 0.11, 2.3, 7), C.woodDark, { x: nx + s * 0.85, y: 1.15, z: nz - 0.18 });
    }
    part(p, new THREE.BoxGeometry(2.15, 1.15, 0.1), C.woodDark, { x: nx, y: 1.85, z: nz - 0.06 });
    this.obstacles.push({ x: nx, z: nz, r: 0.9 });

    // shovels and picks left leaning on the west support post, which is what a
    // support post is for. No collider: the post already has one.
    for (let i = 0; i < 4; i++) {
      const tx = -8.9 - i * 0.3;
      link(p, [tx, 0.05, 0.95], [tx - 0.3, 1.75, 0.55], 0.05, i % 2 ? C.woodLit : C.wood);
      part(p, new THREE.BoxGeometry(0.09, 0.42, 0.09), C.ironDark, { rz: 0.2, x: tx - 0.32, y: 1.82, z: 0.5 });
    }
    scene.add(solidMesh(p));

    const coals = [];
    part(coals, new THREE.SphereGeometry(0.4, 10, 7), C.ember, { sy: 0.42, x: bx, y: 0.62, z: bz });
    const coalMesh = glowMesh(coals);
    scene.add(coalMesh);
    this._coalMat = coalMesh.userData.mat;
    this._brazierLight = new THREE.PointLight(0xff9a4c, 12, 8, 2);
    this._brazierLight.position.set(bx, 1.1, bz);
    scene.add(this._brazierLight);

    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.0), signMat(messSignTexture()));
    board.position.set(nx, 1.85, nz + 0.02);
    scene.add(board);
  }

  /* --- the adit: the timbered way back up to the peak --------------------- */

  _adit(scene) {
    const p = [];
    const HW = 1.9;
    const H = 3.1;

    // three receding frames, the deepest ones darker: instant depth
    for (let i = 0; i < 3; i++) {
      const z = ADIT_Z + i * 1.05;
      const hue = i === 0 ? C.woodLit : i === 1 ? C.wood : C.woodDark;
      for (const s of [-1, 1]) {
        part(p, new THREE.BoxGeometry(0.36, H, 0.34), hue, { x: s * HW, y: H / 2, z });
      }
      part(p, new THREE.BoxGeometry(HW * 2 + 0.9, 0.34, 0.34), hue, { y: H + 0.14, z });
      part(p, new THREE.BoxGeometry(HW * 2 + 0.4, 0.16, 0.4), C.woodDark, { y: H + 0.36, z });
      if (i === 0) {
        for (const s of [-1, 1]) this.obstacles.push({ x: s * (HW + 0.3), z, r: 0.55 });
      }
    }
    // Rock throat around the opening: two shoulders, and deliberately no crown.
    // An arch over the way out sits at 4-5 up in the one place every arrival
    // looks through, which is dead centre of the camera corridor for the whole
    // entrance half of the room - it was the single worst occluder down here.
    // Shouldered, the portal still reads as cut through rock and the sight line
    // to anyone walking in passes clean over it.
    for (let i = 0; i < 8; i++) {
      const s = i < 4 ? -1 : 1;
      const k = i % 4;
      part(p, faceted(new THREE.IcosahedronGeometry(0.78 + (k % 3) * 0.26, 0)), k % 2 ? C.rockDark : C.rockDeep, {
        sz: 0.7, x: s * (HW + 1.15 + Math.sin(k * 1.3) * 0.3), y: 0.2 + k * 0.6, z: ADIT_Z + 0.4,
      });
    }
    // snow blown in over the threshold, and a shovel stood against the frame
    part(p, new THREE.SphereGeometry(1, 10, 7), 0xe8eef6, { sx: 2.0, sy: 0.3, sz: 0.9, x: 0, y: 0.02, z: ADIT_Z + 1.4 });
    part(p, new THREE.SphereGeometry(1, 9, 6), 0xdfe7f2, { sx: 1.0, sy: 0.22, sz: 0.6, x: 1.2, y: 0.02, z: ADIT_Z + 0.4 });
    link(p, [HW + 0.2, 0.1, ADIT_Z - 0.3], [HW + 0.55, 1.6, ADIT_Z - 0.5], 0.05, C.woodLit);
    part(p, new THREE.BoxGeometry(0.44, 0.5, 0.08), C.iron, { rz: 0.2, rx: 0.25, x: HW + 0.22, y: 0.3, z: ADIT_Z - 0.28 });
    scene.add(solidMesh(p));

    // the daylight card at the top of the drift, plus its cold pool on the floor
    const day = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2 - 0.3, H - 0.2), signMat(daylightTexture()));
    day.position.set(0, H / 2 - 0.1, ADIT_Z + 2.9);
    day.rotation.y = Math.PI;
    scene.add(day);

    const poolMat = makeGlow(0xbcdcff, { unique: true });
    poolMat.map = glowPoolTexture();
    poolMat.transparent = true;
    poolMat.opacity = 0.3;
    poolMat.depthWrite = false;
    poolMat.blending = THREE.AdditiveBlending;
    poolMat.needsUpdate = true;
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.6), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.05, ADIT_Z - 1.6);
    pool.renderOrder = 1;
    scene.add(pool);
    this._dayPoolMat = poolMat;

    // hanging lantern each side of the mouth, and the way-out board
    const lp = [];
    for (const s of [-1, 1]) {
      part(lp, new THREE.BoxGeometry(0.22, 0.28, 0.22), C.warm, { x: s * (HW - 0.3), y: 2.5, z: ADIT_Z - 0.24 });
    }
    const lampMesh = glowMesh(lp);
    scene.add(lampMesh);
    this._aditLampMat = lampMesh.userData.mat;
    const hoods = [];
    for (const s of [-1, 1]) {
      part(hoods, new THREE.ConeGeometry(0.26, 0.22, 4), C.ironDark, {
        ry: Math.PI / 4, x: s * (HW - 0.3), y: 2.74, z: ADIT_Z - 0.24,
      });
      link(hoods, [s * (HW - 0.3), 2.85, ADIT_Z - 0.24], [s * (HW - 0.05), 3.1, ADIT_Z - 0.05], 0.025, C.ironDark, 4);
    }
    scene.add(solidMesh(hoods));

    // Nailed across the header rather than hung above it: up at 3.9 the board
    // floated in the sight line of anyone in the entrance half of the room, and
    // down here it shares the lintel's slice of it instead of adding its own.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.8), signMat(aditSignTexture()));
    sign.position.set(0, 3.0, ADIT_Z - 0.3);
    sign.rotation.x = 0.16;
    scene.add(sign);
  }

  /* --- dust and drips ----------------------------------------------------- */

  _atmosphere(scene) {
    const rng = this._rng;

    // dust motes hanging in the lantern light
    const N = 190;
    const pts = new Float32Array(N * 3);
    const meta = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const a = rng() * TAU;
      const rad = Math.sqrt(rng()) * 12.5;
      pts[i * 3] = Math.cos(a) * rad;
      pts[i * 3 + 1] = 0.25 + rng() * 5.4;
      pts[i * 3 + 2] = Math.sin(a) * rad;
      meta[i * 2] = 0.1 + rng() * 0.22;   // rise speed
      meta[i * 2 + 1] = rng() * TAU;      // sway phase
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.13,
      map: dotTexture(),
      color: 0xffcf90,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const dust = new THREE.Points(geo, mat);
    dust.frustumCulled = false;
    scene.add(dust);
    this._dust = { attr: geo.attributes.position, meta, n: N };

    // drips: one instanced drop per source, falling from the ceiling forever
    const dripGeo = new THREE.SphereGeometry(0.06, 6, 5);
    dripGeo.scale(1, 1.7, 1);
    const drips = new THREE.InstancedMesh(dripGeo, makeGlow(0x9fd8e8, { unique: true }), 24);
    drips.frustumCulled = false;
    scene.add(drips);
    this._drips = [];
    for (let i = 0; i < 24; i++) {
      const use = i < 3 ? this._puddles[i] : null;
      const a = rng() * TAU;
      const rad = 3 + rng() * 9.5;
      const x = use ? use[0] : Math.cos(a) * rad;
      const z = use ? use[1] : Math.sin(a) * rad;
      this._drips.push({ x, z, top: this._ceilY(x, z) - 0.4, y: rng() * 6, v: 1.6 + rng() * 1.6 });
    }
    this._dripMesh = drips;
    this._instanced.push(drips);
  }

  /* --- prospecting: picks, shards, motes ---------------------------------- */

  _digFx(scene) {
    // shards: one recycled instanced draw for every swing in the room
    const chipGeo = new THREE.IcosahedronGeometry(0.075, 0);
    this._chips = instancedGlow(chipGeo, CHIP_N);
    this._chips.frustumCulled = false;
    scene.add(this._chips);
    this._instanced.push(this._chips);
    this._chipData = [];
    const d = this._dummy;
    d.scale.setScalar(0.0001);
    d.position.set(0, -50, 0);
    d.rotation.set(0, 0, 0);
    d.updateMatrix();
    for (let i = 0; i < CHIP_N; i++) {
      this._chips.setMatrixAt(i, d.matrix);
      this._chipData.push({ life: 0, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
    }
    this._chips.instanceMatrix.needsUpdate = true;
    d.scale.setScalar(1);

    this._pickGeo = makePickGeo();
    this._pickMat = makeToon(0xffffff, VC); // cached + shared: never disposed here

    // one floating payout mote, repainted per payout
    this._moteTex = canvasTexture(160, 84, (c, w, h) => drawMote(c, w, h, '+2', false));
    const moteMat = makeGlow(0xffffff, { unique: true });
    moteMat.map = this._moteTex;
    moteMat.transparent = true;
    moteMat.depthWrite = false;
    moteMat.opacity = 0;
    moteMat.needsUpdate = true;
    const mote = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.5), moteMat);
    mote.position.set(0, -50, 0);
    mote.renderOrder = 2;
    scene.add(mote);
    this._mote = { mesh: mote, mat: moteMat, t: 99, base: new THREE.Vector3() };
  }

  /**
   * The coins frame that pays a tick: remember it for the next swing impact.
   * The server sends reason 'mining' for the ordinary +2 and 'gem!' for the
   * rare 25 (server/index.js digTick), and pays nothing at all once the hourly
   * backstop bites - which is exactly why the mote reads the delta from here
   * rather than assuming one.
   */
  _onCoins(delta, reason) {
    const r = String(reason || '');
    if (delta > 0 && (r === 'mining' || r === 'mine' || r === 'dig' || r.startsWith('gem'))) {
      this._pendingDelta = delta;
      this._pendingGem = r.startsWith('gem') || delta >= 10;
      this._pendingAt = this._t;
    }
  }

  /**
   * Server->client 'dig-tick': our capybara has just been paid for standing
   * around, so show the work that supposedly earned it. The payout number is
   * resolved at the first swing impact (see _updateDigs), which is late enough
   * that the accompanying 'coins' frame has landed whichever order they arrive.
   */
  _onDigTick(m) {
    const game = this._game;
    if (!game || game.roomId !== this.id || game.activeMinigame) return;
    const av = game.engine?.playerAvatar;
    if (!av) return;
    if (m && (m.gem === true || Number(m.delta) >= 10)) {
      this._pendingGem = true;
      this._pendingDelta = Number(m.delta) || 25;
      this._pendingAt = this._t;
    }
    // mid-walk there is no room for a swing: float the payout and let them go
    if (game.engine?.controller?.target) {
      this._spawnMote(av.group.position, this._resolveDelta());
      return;
    }
    this._startDig(av, true);
  }

  _resolveDelta() {
    const fresh = this._t - this._pendingAt < 3;
    const delta = fresh ? this._pendingDelta : 2;
    const gem = fresh ? this._pendingGem : false;
    this._pendingGem = false;
    return { delta, gem: gem || delta >= 10 };
  }

  /** Nearest crystal seam to a point on the floor. */
  _nearestSeam(x, z) {
    let best = null;
    let bd = Infinity;
    for (const s of this._seams) {
      const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  _takePick() {
    const p = this._pickPool.pop();
    return p || new THREE.Mesh(this._pickGeo, this._pickMat);
  }

  _freePick(p) {
    if (!p) return;
    p.parent?.remove(p);
    if (this._pickPool.length < PICK_MAX) this._pickPool.push(p);
  }

  /**
   * Start one chipping bout. `isLocal` runs the payout mote and the sfx; the
   * decorative loop that keeps the neighbours busy passes false.
   */
  _startDig(av, isLocal) {
    if (!av?.group || this._digs.length >= PICK_MAX) return;
    for (const dg of this._digs) if (dg.av === av) return; // already swinging
    const p = av.group.position;
    const seam = this._nearestSeam(p.x, p.z);
    if (isLocal && seam) {
      // turn to the seam: the controller only writes rotation while walking, so
      // a standing capybara keeps whatever we set here
      av.group.rotation.y = Math.atan2(seam.x - p.x, seam.z - p.z);
    }
    const pick = this._takePick();
    pick.position.set(0.52, 0.74, 0.18);
    pick.rotation.set(-0.9, 0.1, -0.42);
    av.body.add(pick);
    this._digs.push({ av, pick, seam, t: 0, dur: isLocal ? 2.9 : 2.3, hits: 0, local: !!isLocal });
    if (isLocal) this._game?.audio?.play?.('pop');
  }

  _endDig(dg) {
    this._freePick(dg.pick);
    const i = this._digs.indexOf(dg);
    if (i >= 0) this._digs.splice(i, 1);
  }

  /** Shards off the rock face, thrown back toward the digger. */
  _burst(at, count, teal, hot) {
    const rng = this._rng;
    const col = this._col;
    let spawned = 0;
    for (let i = 0; i < CHIP_N && spawned < count; i++) {
      const c = this._chipData[i];
      if (c.life > 0) continue;
      c.life = 0.55 + rng() * 0.5;
      c.max = c.life;
      c.x = at.x + (rng() - 0.5) * 0.14;
      c.y = at.y + (rng() - 0.5) * 0.14;
      c.z = at.z + (rng() - 0.5) * 0.14;
      const a = rng() * TAU;
      const sp = 0.9 + rng() * 1.5;
      c.vx = Math.cos(a) * sp * 0.5;
      c.vz = Math.sin(a) * sp * 0.5;
      c.vy = 1.4 + rng() * 1.9;
      c.spin = (rng() - 0.5) * 14;
      col.setHex(hot ? C.amberHot : teal ? C.teal : C.amber);
      if (!hot && rng() > 0.6) col.setHex(C.rockLit);
      this._chips.setColorAt(i, col);
      spawned++;
    }
    this._chips.instanceColor.needsUpdate = true;
  }

  /** Make the seam being worked flare for a moment. */
  _pulseSeam(seam, amount) {
    if (!seam) return;
    for (let k = 0; k < seam.n; k++) this._cPulse[seam.i0 + k] = Math.min(1.4, this._cPulse[seam.i0 + k] + amount);
  }

  _spawnMote(pos, { delta, gem }) {
    const mote = this._mote;
    if (!mote) return;
    const cv = this._moteTex?.image;
    if (cv?.getContext) {
      drawMote(cv.getContext('2d'), cv.width, cv.height, gem ? 'gem!' : `+${delta}`, gem);
      this._moteTex.needsUpdate = true;
    }
    mote.base.set(pos.x, pos.y + 2.35, pos.z);
    mote.t = 0;
    mote.gem = gem;
    mote.mesh.scale.setScalar(gem ? 1.35 : 1);
    if (gem) this._game?.audio?.play?.('success');
  }

  _updateDigs(dt) {
    const game = this._game;
    // keep the neighbours busy: one random idle capybara picks up a pick
    this._botDigT -= dt;
    if (this._botDigT <= 0) {
      this._botDigT = 4 + this._rng() * 7;
      const remotes = game?.net?.remotes;
      if (remotes?.size && !game.activeMinigame) {
        const pool = [];
        for (const [id, r] of remotes) {
          if (!r?.avatar?.group?.parent) continue;
          if (r.avatar.state.anim !== 'idle') continue;
          if (this._hunters.has(id)) continue; // they are in the lineup
          pool.push(r.avatar);
        }
        if (pool.length) this._startDig(pool[Math.floor(this._rng() * pool.length)], false);
      }
    }

    // swings
    for (const dg of [...this._digs]) {
      if (!dg.av.group.parent) { this._endDig(dg); continue; }
      dg.t += dt;
      const phase = dg.t / 0.72;
      dg.pick.rotation.x = -1.05 + 1.45 * (0.5 - 0.5 * Math.cos(phase * TAU));
      const hits = Math.floor(phase + 0.5);
      if (hits > dg.hits) {
        dg.hits = hits;
        const g = dg.av.group;
        const at = this._v.set(
          g.position.x + Math.sin(g.rotation.y) * 0.92,
          g.position.y + 0.6,
          g.position.z + Math.cos(g.rotation.y) * 0.92,
        );
        const gem = dg.local && dg.hits === 1 && this._pendingGem;
        this._burst(at, dg.local ? (gem ? 13 : 7) : 5, dg.seam?.teal, gem);
        this._pulseSeam(dg.seam, dg.local ? 0.9 : 0.5);
        if (dg.local && dg.hits === 1) this._spawnMote(g.position, this._resolveDelta());
        if (dg.local && dg.hits > 1) this._game?.audio?.play?.('click');
      }
      if (dg.t >= dg.dur) this._endDig(dg);
    }

    // shards
    const d = this._dummy;
    let dirty = false;
    for (let i = 0; i < CHIP_N; i++) {
      const c = this._chipData[i];
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vy -= 9.2 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      if (c.y < 0.05) { c.y = 0.05; c.vy *= -0.32; c.vx *= 0.6; c.vz *= 0.6; }
      const k = c.life <= 0 ? 0 : Math.min(1, c.life / (c.max * 0.55));
      d.position.set(c.x, c.y, c.z);
      d.rotation.set(c.spin * c.life, c.spin * c.life * 0.7, 0);
      d.scale.setScalar(Math.max(0.0001, k));
      d.updateMatrix();
      this._chips.setMatrixAt(i, d.matrix);
      dirty = true;
      if (c.life <= 0) { c.life = 0; c.y = -50; }
    }
    if (dirty) this._chips.instanceMatrix.needsUpdate = true;
    d.scale.setScalar(1);

    // the payout mote drifting up over whoever earned it
    const mote = this._mote;
    if (mote && mote.t < 1.6) {
      mote.t += dt;
      const k = mote.t / 1.6;
      mote.mesh.position.set(mote.base.x, mote.base.y + k * 1.15, mote.base.z);
      const cam = game?.engine?.camera;
      if (cam) mote.mesh.quaternion.copy(cam.quaternion);
      mote.mat.opacity = k < 0.12 ? k / 0.12 : Math.max(0, 1 - (k - 0.12) / 0.88) ** 0.7;
      if (mote.t >= 1.6) { mote.mat.opacity = 0; mote.mesh.position.set(0, -50, 0); }
    }
  }

  /* --- prop hunt lobby ---------------------------------------------------- */

  _joinLabel() {
    if (!this._game?.net?.connected) return 'Start the hunt alone';
    if (this._localSlot !== null) return 'Step out of the hunt';
    return `Join the hunt (${this._lobbyCount}/6)`;
  }

  /** Repaint the board in place (one canvas, one texture, forever). */
  _paintHunters() {
    const tex = this._huntersTex;
    const cv = tex?.image;
    if (cv?.getContext) {
      drawHuntersSign(cv.getContext('2d'), cv.width, cv.height, this._lobbyCount, this._lobbyStarting);
      tex.needsUpdate = true;
    }
    // the pads light up under the capybaras standing on them
    const rings = this._padRings;
    if (rings) {
      const col = this._col;
      for (let i = 0; i < HUNT_SLOTS.length; i++) {
        const taken = i < this._lobbyCount;
        col.setHex(taken ? (this._lobbyStarting ? 0x7ac74f : C.amberHot) : 0x3a3a3e);
        rings.setColorAt(i, col);
      }
      rings.instanceColor.needsUpdate = true;
    }
  }

  /** Server->client 'ph-lobby': {players:[{id,name}], starting}. */
  _onLobby(m) {
    const game = this._game;
    const players = Array.isArray(m?.players) ? m.players.slice(0, HUNT_SLOTS.length) : [];
    const selfId = game?.net?.selfId ?? null;
    const seen = new Set();
    let localSlot = null;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.id === undefined || p.id === null) continue;
      if (selfId !== null && p.id === selfId) { localSlot = i; continue; }
      seen.add(p.id);
      this._addHunter(p.id, p.name, i);
    }
    for (const id of [...this._hunters.keys()]) if (!seen.has(id)) this._removeHunter(id);

    this._lobbyCount = players.length;
    this._lobbyStarting = !!m?.starting;
    this._setLocalSlot(localSlot);
    this._paintHunters();
    this._refreshJoinLabel();
  }

  /** Stand a remote lobby member on their pad. */
  _addHunter(id, name, slot) {
    const existing = this._hunters.get(id);
    if (existing) {
      if (existing.slot === slot) return;
      this._removeHunter(id);
    }
    const s = HUNT_SLOTS[slot];
    if (!s || !this._hunterGroup) return;
    const game = this._game;
    const remote = game?.net?.remotes?.get?.(id) || null;
    const avatar = createAvatar({
      color: remote?.p?.color ?? DEFAULT_FUR,
      hat: remote?.p?.hat ?? 'none',
    });
    avatar.group.position.set(s.x, DECK.y + 0.12, s.z);
    avatar.group.rotation.y = SLOT_YAW;
    this._hunterGroup.add(avatar.group);

    // The same capybara is also drawn by the net client wherever they happen to
    // be standing. Park their networked body offscreen while they hold a pad so
    // the room never shows the same player twice; _restoreRemote puts it (and
    // its name tag, which hides itself once unparented) straight back.
    let hidden = null;
    if (remote?.avatar?.group?.parent) {
      hidden = remote.avatar.group;
      hidden.parent.remove(hidden);
    }
    const tag = game?.engine?.attachNameTag?.(avatar.group, name || 'Capybara') || null;
    this._hunters.set(id, { avatar, slot, tag, hidden });
    game?.audio?.play?.('pop');
  }

  _removeHunter(id) {
    const h = this._hunters.get(id);
    if (!h) return;
    this._hunters.delete(id);
    h.tag?.remove?.();
    this._hunterGroup?.remove(h.avatar.group);
    h.avatar.dispose();
    this._restoreRemote(id, h.hidden);
  }

  /** Late-bind hunters to their networked record: real fur, real hat, no double. */
  _reconcileHunters() {
    const remotes = this._game?.net?.remotes;
    if (!remotes?.get) return;
    for (const [id, h] of this._hunters) {
      if (h.hidden) continue;
      const remote = remotes.get(id);
      const g = remote?.avatar?.group;
      if (!g?.parent) continue;
      h.hidden = g;
      g.parent.remove(g);
      if (typeof remote.p?.color === 'number') h.avatar.setColor(remote.p.color);
      if (remote.p?.hat) h.avatar.setHat(remote.p.hat);
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

  /**
   * Walk the local capybara onto (or off) their pad. Six slots shuffle every
   * time somebody ahead of you leaves, so only the first one greets you: being
   * re-toasted for a sideways step reads as a bug.
   */
  _setLocalSlot(slot) {
    if (slot === this._localSlot) return;
    const game = this._game;
    const engine = game?.engine;
    const wasOut = this._localSlot === null;
    if (slot !== null) {
      const s = HUNT_SLOTS[slot];
      if (s && engine?.controller) engine.controller.setTarget(this._v.set(s.x, DECK.y, s.z));
      if (wasOut) {
        game?.audio?.play?.('whoosh');
        game?.toast?.('You are in the hunt! Step out any time.');
      }
    } else {
      game?.audio?.play?.('click');
    }
    this._localSlot = slot;
  }

  /** Server->client 'ph-start': stash the ctx, then launch the hunt. */
  _onHuntStart(m) {
    const game = this._game;
    if (!game || !m) return;
    this._clearLobby();
    // Already inside a minigame (a solo hunt started while the lobby filled):
    // startMinigame would no-op and the ctx would sit there waiting to turn some
    // later solo run into a phantom round. Bow out loudly instead.
    if (game.activeMinigame) {
      game.net?.send?.({ t: 'ph-done', score: 0 });
      game.toast?.('The hunt started without you: you were already down a tunnel!');
      return;
    }
    // The shape src/minigames/games/prophunt.js documents. Anything malformed
    // degrades to a solo hunt on that side rather than breaking the round.
    const selfId = game.net?.selfId ?? null;
    const ctx = {
      game: 'prophunt',
      seed: Number(m.seed) || 0,
      players: Array.isArray(m.players) ? m.players : [],
      seekerId: m.seekerId ?? null,
      youAre: selfId !== null && m.seekerId === selfId ? 'seeker' : 'hider',
    };
    game.__partyCtx = ctx;
    game.__huntCtx = ctx; // alias, for anything reading the room-side name
    game.toast?.(ctx.youAre === 'seeker' ? 'You are the SEEKER. Count to ten!' : 'Lights out. Find a prop!');
    game.startMinigame('prophunt');
  }

  /** Empty every pad (the hunt launched, or the room is going away). */
  _clearLobby() {
    for (const id of [...this._hunters.keys()]) this._removeHunter(id);
    this._lobbyCount = 0;
    this._lobbyStarting = false;
    this._setLocalSlot(null);
    this._paintHunters();
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

  /* --- per-frame ---------------------------------------------------------- */

  update(dt, game) {
    const t = (this._t += dt);
    if (game) this._game = game;
    const col = this._col;

    // crystal seams breathing, plus the flare from anything being chipped
    if (this._crystalMesh) {
      for (let i = 0; i < this._cHue.length; i++) {
        const p = 0.5 + 0.5 * Math.sin(t * 1.15 + this._cPhase[i]);
        const pulse = this._cPulse[i];
        if (pulse > 0) this._cPulse[i] = Math.max(0, pulse - dt * 1.7);
        col.setHSL(this._cHue[i], 0.86, 0.3 + p * 0.2 + pulse * 0.35, THREE.SRGBColorSpace);
        this._crystalMesh.setColorAt(i, col);
      }
      this._crystalMesh.instanceColor.needsUpdate = true;
    }

    // lantern strings flicker, each bulb on its own clock
    if (this._bulbs) {
      for (let i = 0; i < this._bulbs.count; i++) {
        const f = 0.82 + 0.18 * Math.sin(t * 3.1 + this._bulbSeed[i]) * Math.sin(t * 1.7 + this._bulbSeed[i] * 2);
        col.setRGB(f, f * 0.85, f * 0.58);
        this._bulbs.setColorAt(i, col);
      }
      this._bulbs.instanceColor.needsUpdate = true;
    }

    // dust drifting up through the light
    const dust = this._dust;
    if (dust) {
      const a = dust.attr.array;
      const m = dust.meta;
      for (let i = 0; i < dust.n; i++) {
        const i3 = i * 3;
        a[i3 + 1] += m[i * 2] * dt;
        a[i3] += Math.sin(t * 0.6 + m[i * 2 + 1]) * 0.12 * dt;
        a[i3 + 2] += Math.cos(t * 0.5 + m[i * 2 + 1]) * 0.12 * dt;
        if (a[i3 + 1] > 6.2) a[i3 + 1] = 0.2;
      }
      dust.attr.needsUpdate = true;
    }

    // drips falling into the puddles
    if (this._dripMesh) {
      const d = this._dummy;
      for (let i = 0; i < this._drips.length; i++) {
        const dr = this._drips[i];
        dr.y -= dr.v * dt;
        dr.v += 5.5 * dt;
        if (dr.y < 0.06) { dr.y = dr.top; dr.v = 1.4 + this._rng() * 1.4; }
        d.position.set(dr.x, dr.y, dr.z);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this._dripMesh.setMatrixAt(i, d.matrix);
      }
      this._dripMesh.instanceMatrix.needsUpdate = true;
    }

    // firelight, coals, lamps and the daylight pool all breathing
    if (this._coalMat) {
      const f = 0.82 + 0.18 * Math.sin(t * 5.4) * Math.sin(t * 2.3 + 0.7);
      this._coalMat.color.setRGB(f, f * 0.55, f * 0.28);
    }
    if (this._brazierLight) this._brazierLight.intensity = 11 + Math.sin(t * 4.6) * 2.2;
    if (this._messLight) this._messLight.intensity = 32 + Math.sin(t * 2.2) * 2.6;
    if (this._doorLight) this._doorLight.intensity = 24 + Math.sin(t * 1.8 + 1.2) * 3.2;
    if (this._chamberGlowMat) {
      const f = 0.85 + 0.15 * Math.sin(t * 1.9);
      this._chamberGlowMat.color.setRGB(f, f * 0.68, f * 0.36);
    }
    if (this._aditLampMat || this._soloLampMat || this._liftLampMat) {
      const f = 0.88 + 0.12 * Math.sin(t * 4.4 + 0.6);
      for (const mat of [this._aditLampMat, this._soloLampMat, this._liftLampMat]) {
        mat?.color.setRGB(f, f * 0.84, f * 0.58);
      }
    }
    if (this._dayPoolMat) this._dayPoolMat.opacity = 0.24 + 0.08 * (0.5 + 0.5 * Math.sin(t * 0.9));
    if (this._puddleMat) this._puddleMat.opacity = 0.36 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.4));
    if (this._oreMat) {
      const f = 0.86 + 0.14 * Math.sin(t * 1.6 + 2.0);
      this._oreMat.color.setRGB(f, f * 0.92, f * 0.8);
    }
    if (this._seamLightA) this._seamLightA.intensity = 14 + Math.sin(t * 1.1) * 4;
    if (this._seamLightB) this._seamLightB.intensity = 12 + Math.sin(t * 1.1 + 2.2) * 4;

    // the elevator cage swaying on its cable, forever about to be repaired
    if (this._cage) {
      this._cage.position.y = 0.5 + Math.sin(t * 0.9) * 0.05;
      this._cage.rotation.z = Math.sin(t * 0.7) * 0.012;
      this._cage.rotation.x = Math.sin(t * 0.55 + 1) * 0.01;
    }

    this._updateLobby(dt, t);
    this._updateDigs(dt);
  }

  _updateLobby(dt, t) {
    for (const h of this._hunters.values()) h.avatar.update(dt);

    // A 'ph-lobby' frame can beat the 'pjoin' that introduces the same
    // capybara, so a hunter may start out brown and un-deduplicated. Catch up
    // twice a second: cheap, and the pad always ends up wearing their hat.
    this._reconcileT += dt;
    if (this._reconcileT > 0.5) {
      this._reconcileT = 0;
      if (this._hunters.size) this._reconcileHunters();
    }

    // the board bobs, and pulses once the round is nearly full
    const sign = this._huntersSign;
    if (sign) {
      sign.position.y = this._signBaseY + Math.sin(t * 1.2) * 0.08;
      sign.rotation.z = Math.sin(t * 0.85) * 0.012;
      const eager = this._lobbyCount >= 2 || this._lobbyStarting;
      const s = eager ? 1 + Math.abs(Math.sin(t * 4.0)) * 0.07 : 1;
      sign.scale.set(s, s, s);
    }

    // keep the local capybara settled on their pad while they wait
    const engine = this._game?.engine;
    const avatar = engine?.playerAvatar;
    if (this._localSlot !== null && avatar) {
      const slot = HUNT_SLOTS[this._localSlot];
      const g = avatar.group;
      const walking = !!engine.controller?.target;
      if (slot && !walking && Math.hypot(g.position.x - slot.x, g.position.z - slot.z) < 0.6) {
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
    // Standing in the lineup and walking out must not leave a ghost holding a
    // pad. Harmless if the server already dropped us on the room change.
    if (this._localSlot !== null && this._game?.net?.connected) {
      this._game.net.send({ t: 'ph-leave' });
    }
    for (const id of [...this._hunters.keys()]) this._removeHunter(id);
    this._hunters.clear();

    // Picks live on avatars, and avatars outlive the room: the engine unparents
    // the player and the remote group BEFORE disposing the scene, so nothing
    // here is swept up for us. Detach every pick, then free the one geometry
    // they all share (the material is the cached toon one: leave it alone).
    for (const dg of [...this._digs]) this._freePick(dg.pick);
    this._digs.length = 0;
    for (const p of this._pickPool) p.parent?.remove(p);
    this._pickPool.length = 0;
    this._pickGeo?.dispose();
    this._pickGeo = null;
    this._pickMat = null;

    for (const im of this._instanced) im.dispose?.();
    this._instanced.length = 0;

    this._offLobby?.();
    this._offStart?.();
    this._offDig?.();
    this._offCoins?.();
    this._offLobby = this._offStart = this._offDig = this._offCoins = null;

    this._localSlot = null;
    this._hunterGroup = null;
    this._huntersSign = null;
    this._huntersTex = null; // the sign material is unique; disposeObject frees it
    this._joinSpot = null;
    this._crystalMesh = null;
    this._padRings = null;
    this._bulbs = null;
    this._chips = null;
    this._chipData = null;
    this._dripMesh = null;
    this._drips = null;
    this._dust = null;
    this._mote = null;
    this._moteTex = null;
    this._seams = null;
    this._cage = null;
    this._coalMat = null;
    this._oreMat = null;
    this._puddleMat = null;
    this._dayPoolMat = null;
    this._aditLampMat = null;
    this._soloLampMat = null;
    this._liftLampMat = null;
    this._chamberGlowMat = null;
    this._messLight = null;
    this._doorLight = null;
    this._brazierLight = null;
    this._seamLightA = null;
    this._seamLightB = null;
    this._game = null;
  }
}
