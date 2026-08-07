import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture, disposeObject } from '../../core/materials.js';
import { buildFurniture } from '../furniture.js';
import { openHouseEditor } from '../../ui/houseEditor.js';
import { HOUSE_ACCESS_MODES, HOUSE_MAX_ITEMS } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// A player's den. One class serves every 'house:<owner>' room id: the engine
// resolves them all here and game.__houseCtx carries who we are visiting.
//
//   game.__houseCtx = { owner, isOwner, furniture:[{f,x,z,rot}], access }
//
// The shell is a warm plank cottage room, 18 x 14 walkable (x -9..9, z -7..7,
// matching the server's house-save bounds), three solid walls, a big garden
// window to the west, a stone hearth opposite the door and a front door south
// with a doormat that carries the owner's name.
//
// Furniture is built by src/world/furniture.js; this file only places it,
// ticks its userData.update hooks and turns userData.footprint into obstacles.
// The decorating UI lives in src/ui/houseEditor.js and drives this room through
// the small API under "editor API" below.
// ---------------------------------------------------------------------------

const HX = 9;            // floor half-width  (server validates |x| <= 9)
const HZ = 7;            // floor half-depth  (server validates |z| <= 7)
const WALL_H = 5.4;
const WX = 9.3;          // wall inner faces sit just outside the floor
const WZN = -7.3;
const WZS = 7.3;
const DOOR_W = 3.2;      // clear doorway width
const HALF_WALL_H = 0.95; // south half walls: low enough to see over from the play camera

const PAL = {
  floor: 0xb98450,
  wall: 0xf4e3c3,
  wainscot: 0xd8b184,
  wood: 0x7a4e2a,
  woodMid: 0xa9703c,
  woodLight: 0xd39a5c,
  cream: 0xfdf0d5,
  coral: 0xe8657a,
  gold: 0xf2b64a,
  sky: 0x4fb3e8,
  leaf: 0x7ac74f,
  leafDark: 0x4d8c39,
  stone: 0xcdb89b,
  stoneDark: 0xa89073,
  straw: 0xe0b46a,
  ember: 0xff8a3c,
  grass: 0x86bf58,
};

const ACCESS_MODES = HOUSE_ACCESS_MODES;
const ACCESS_LABEL = {
  open: 'Anyone may visit',
  friends: 'Friends only',
  invite: 'Invited guests only',
};

// Pieces that lie flat on the floor: they never block a waddle and nothing
// blocks them, so a rug tucks under a sofa the way a rug should. Everything
// else in the catalog stands on its own feet (the surfboard is on a rack, the
// portrait is on an easel) and gets a collider.
const FLAT_IDS = new Set(['rug_round', 'rug_stripe']);

// Keep the way in walkable no matter how enthusiastically the owner decorates.
const KEEP_CLEAR = [
  { x: 0, z: 6.4, r: 2.6 },     // the door and its mat
  { x: -3.7, z: 5.9, r: 0.95 }, // decorating stand
  { x: 3.7, z: 5.9, r: 0.95 },  // visitor board
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One draw call per repeated primitive. Same recipe the other rooms use. */
class Batch {
  constructor(geo, mat) {
    this.geo = geo;
    this.mat = mat;
    this.rows = [];
  }

  add(color, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
    this.rows.push([color, x, y, z, sx, sy, sz, rx, ry, rz]);
  }

  build(parent, cast = true, receive = true) {
    if (!this.rows.length) return null;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, this.rows.length);
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

/**
 * userData.footprint -> a {w, d} box. furniture.js writes {w, d}; a bare number
 * or an {r} is read as a circle so a future builder cannot break placement.
 */
function fpBox(fp) {
  if (typeof fp === 'number') return { w: fp * 2, d: fp * 2 };
  if (!fp || typeof fp !== 'object') return { w: 1.4, d: 1.4 };
  const w = typeof fp.w === 'number' ? fp.w : fp.x;
  const d = typeof fp.d === 'number' ? fp.d : fp.z;
  if (typeof w === 'number' && typeof d === 'number') return { w, d };
  const r = typeof fp.r === 'number' ? fp.r : fp.radius;
  if (typeof r === 'number') return { w: r * 2, d: r * 2 };
  if (typeof w === 'number') return { w, d: w };
  return { w: 1.4, d: 1.4 };
}

/** Build one catalog piece, tolerating a builder that does not know the id. */
function makeFurniture(id) {
  let obj = null;
  try {
    obj = buildFurniture(id);
  } catch (e) {
    console.warn(`[house] furniture '${id}' failed to build`, e);
    return null;
  }
  if (!obj || !obj.isObject3D) return null;
  obj.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return obj;
}

/**
 * Two radii per piece, because one circle cannot be both honest and pleasant:
 *  - r     : the turning circle (longest half-extent). Keeps a piece inside the
 *            room at ANY rotation, and is what the placement ring draws.
 *  - solid : the collider, averaged across the box. A 2.65 x 1.3 sofa gets a
 *            0.99 bubble rather than a 1.48 one, so you can brush past its ends
 *            instead of bumping an invisible barrel.
 */
function metricsFor(id, obj) {
  const fp = obj?.userData?.footprint;
  const { w, d } = fpBox(fp);
  const r = Math.max(0.28, Math.min(3.2, Math.max(w, d) / 2));
  const flat = FLAT_IDS.has(id) || (fp && (fp.solid === false || fp.walkable === true));
  return { r, solid: flat ? 0 : Math.max(0.25, Math.min(2.6, (w + d) / 4)) };
}

// ---------------------------------------------------------------------------
// canvas painters
// ---------------------------------------------------------------------------

function texPlanks() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    const rows = 5;
    const rh = h / rows;
    const tones = ['#c68c53', '#bb8149', '#cf9660', '#b87d47', '#c48a51'];
    g.fillStyle = '#ac7440';
    g.fillRect(0, 0, w, h);
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      g.fillStyle = tones[r % tones.length];
      g.fillRect(0, y + 1.5, w, rh - 3);
      g.strokeStyle = 'rgba(120,78,40,0.26)';
      g.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        const gy = y + 5 + ((i * 8 + r * 5) % (rh - 10));
        g.beginPath();
        g.moveTo(0, gy);
        g.bezierCurveTo(w * 0.3, gy - 2, w * 0.7, gy + 2, w, gy);
        g.stroke();
      }
      const jx = ((r * 83) % 180) + 40;
      g.fillStyle = 'rgba(96,60,26,0.5)';
      g.fillRect(jx, y + 1.5, 2, rh - 3);
      g.fillStyle = 'rgba(80,50,22,0.4)';
      for (const [nx, ny] of [[jx - 14, 0.32], [jx + 16, 0.7]]) {
        g.beginPath();
        g.arc(nx, y + rh * ny, 1.6, 0, 7);
        g.fill();
      }
    }
    g.fillStyle = 'rgba(88,54,22,0.6)';
    for (let r = 0; r <= rows; r++) g.fillRect(0, r * rh - 1, w, 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4.5, 3.5);
  return t;
}

/** The world outside a window: hedges, blooms, a lazy afternoon. */
function texGarden(flip) {
  return canvasTexture(512, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#7fc9ef');
    sky.addColorStop(0.42, '#bfe6f5');
    sky.addColorStop(0.58, '#dff0cf');
    sky.addColorStop(1, '#7fb95a');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // sun + clouds
    const sx = flip ? w * 0.22 : w * 0.78;
    const sun = g.createRadialGradient(sx, h * 0.17, 6, sx, h * 0.17, 70);
    sun.addColorStop(0, 'rgba(255,246,208,0.95)');
    sun.addColorStop(1, 'rgba(255,238,180,0)');
    g.fillStyle = sun;
    g.fillRect(sx - 80, h * 0.17 - 80, 160, 160);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (const [cx, cy, s] of [[90, 44, 1], [230, 28, 0.68], [400, 56, 0.85]]) {
      const x = flip ? w - cx : cx;
      g.beginPath();
      g.arc(x, cy, 17 * s, 0, 7);
      g.arc(x + 19 * s, cy + 5 * s, 12 * s, 0, 7);
      g.arc(x - 18 * s, cy + 6 * s, 11 * s, 0, 7);
      g.fill();
    }

    // rolling hills
    g.fillStyle = '#8fc46a';
    g.beginPath();
    g.moveTo(0, h * 0.62);
    g.quadraticCurveTo(w * 0.3, h * 0.5, w * 0.55, h * 0.61);
    g.quadraticCurveTo(w * 0.8, h * 0.7, w, h * 0.56);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();

    // a friendly tree
    const tx = flip ? w * 0.76 : w * 0.24;
    g.fillStyle = '#7a5334';
    g.fillRect(tx - 7, h * 0.55, 14, h * 0.24);
    for (const [ox, oy, rr, col] of [[0, -14, 46, '#4d8c39'], [-30, 6, 34, '#5ea043'], [30, 4, 32, '#63aa47']]) {
      g.fillStyle = col;
      g.beginPath();
      g.arc(tx + ox, h * 0.55 + oy, rr, 0, 7);
      g.fill();
    }

    // hedge along the bottom
    g.fillStyle = '#4d8c39';
    for (let i = 0; i < 18; i++) {
      g.beginPath();
      g.arc(i * 30 + 12, h * 0.87, 26, 0, 7);
      g.fill();
    }
    g.fillStyle = '#5ea043';
    for (let i = 0; i < 18; i++) {
      g.beginPath();
      g.arc(i * 30 + 24, h * 0.9, 18, 0, 7);
      g.fill();
    }

    // flower beds
    for (let i = 0; i < 22; i++) {
      const x = ((i * 137) % w);
      const y = h * 0.78 + ((i * 53) % 34);
      g.fillStyle = ['#e8657a', '#f2b64a', '#fdf0d5', '#e8657a'][i % 4];
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * 4.5, y + Math.sin(a) * 4.5, 3.4, 3.4, 0, 0, 7);
        g.fill();
      }
      g.fillStyle = '#ffe9a8';
      g.beginPath();
      g.arc(x, y, 2.4, 0, 7);
      g.fill();
    }

    // a butterfly, because it is that kind of afternoon
    const bx = flip ? w * 0.36 : w * 0.64;
    g.fillStyle = '#f6dc55';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(bx + s * 7, h * 0.44, 7, 10, s * 0.5, 0, 7);
      g.fill();
    }
  });
}

/** The doormat: a coir slab with the owner's name stamped into it. */
function texMat(name) {
  return canvasTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#8f6b3f';
    g.fillRect(0, 0, w, h);
    // coir weave
    g.strokeStyle = 'rgba(60,40,18,0.30)';
    g.lineWidth = 3;
    for (let x = 0; x < w; x += 9) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 4, h);
      g.stroke();
    }
    g.strokeStyle = 'rgba(215,178,120,0.22)';
    for (let y = 0; y < h; y += 9) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y + 3);
      g.stroke();
    }
    // border
    g.strokeStyle = '#6b4f2a';
    g.lineWidth = 16;
    g.strokeRect(8, 8, w - 16, h - 16);
    g.strokeStyle = '#e8657a';
    g.lineWidth = 5;
    g.strokeRect(26, 26, w - 52, h - 52);

    const label = (name || 'a cozy capybara').toUpperCase();
    g.textAlign = 'center';
    g.fillStyle = '#fdf0d5';
    let size = 62;
    g.font = `900 ${size}px "Trebuchet MS", system-ui, sans-serif`;
    while (g.measureText(label).width > w - 110 && size > 24) {
      size -= 3;
      g.font = `900 ${size}px "Trebuchet MS", system-ui, sans-serif`;
    }
    g.fillText(label, w / 2, h / 2 + size * 0.18);
    g.fillStyle = '#f2b64a';
    g.font = 'italic 26px "Trebuchet MS", system-ui, sans-serif';
    g.fillText('wipe your paws', w / 2, h - 44);
  });
}

/** The little board by the door telling everyone the house rules. */
function texAccessBoard() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#e9cfa0';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(122,78,42,0.55)';
    g.lineWidth = 3;
    for (let y = 10; y < h; y += 22) {
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y - 3, w * 0.7, y + 3, w, y);
      g.stroke();
    }
    g.fillStyle = '#7a4e2a';
    g.fillRect(0, 0, w, 54);
    g.fillStyle = '#fdf0d5';
    g.textAlign = 'center';
    g.font = '900 27px "Trebuchet MS", system-ui, sans-serif';
    g.fillText('WHO CAN VISIT', w / 2, 36);

    const rows = ['OPEN HOUSE', 'FRIENDS ONLY', 'INVITED ONLY'];
    const subs = ['everyone welcome', 'pals get the key', 'on the list, please'];
    g.textAlign = 'left';
    rows.forEach((r, i) => {
      const y = 96 + i * 56;
      g.fillStyle = 'rgba(253,240,213,0.55)';
      g.fillRect(52, y - 30, w - 66, 46);
      g.fillStyle = '#2d2417';
      g.font = '900 24px "Trebuchet MS", system-ui, sans-serif';
      g.fillText(r, 62, y - 6);
      g.fillStyle = '#8a7a5a';
      g.font = 'italic 17px "Trebuchet MS", system-ui, sans-serif';
      g.fillText(subs[i], 62, y + 12);
    });
  });
}

/** Two small framed paintings, drawn from one seed. */
function texArt(kind) {
  return canvasTexture(256, 200, (g, w, h) => {
    if (kind === 'sea') {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#f2b64a');
      sky.addColorStop(0.5, '#f0a07a');
      sky.addColorStop(1, '#3f9bd0');
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffe9a8';
      g.beginPath();
      g.arc(w * 0.68, h * 0.42, 26, 0, 7);
      g.fill();
      g.fillStyle = '#2f7fae';
      g.fillRect(0, h * 0.58, w, h * 0.42);
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 3;
      for (let i = 0; i < 9; i++) {
        const y = h * 0.63 + i * 9;
        g.beginPath();
        g.moveTo(10 + ((i * 37) % 60), y);
        g.quadraticCurveTo(40 + ((i * 37) % 60), y - 5, 70 + ((i * 37) % 60), y);
        g.stroke();
      }
    } else {
      g.fillStyle = '#dff0cf';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#7ac74f';
      g.beginPath();
      g.arc(w / 2, h * 1.05, w * 0.6, Math.PI, 0);
      g.fill();
      // a chibi capy silhouette on the hill
      g.fillStyle = '#8a6642';
      g.beginPath();
      g.ellipse(w / 2, h * 0.62, 34, 24, 0, 0, 7);
      g.fill();
      g.beginPath();
      g.arc(w / 2 + 28, h * 0.5, 20, 0, 7);
      g.fill();
      g.fillStyle = '#2d2417';
      g.beginPath();
      g.arc(w / 2 + 36, h * 0.47, 3, 0, 7);
      g.fill();
      g.fillStyle = '#f2b64a';
      g.beginPath();
      g.arc(w * 0.2, h * 0.2, 16, 0, 7);
      g.fill();
    }
    g.strokeStyle = 'rgba(45,36,23,0.25)';
    g.lineWidth = 10;
    g.strokeRect(5, 5, w - 10, h - 10);
  });
}

function texSky() {
  return canvasTexture(256, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#57a9df');
    sky.addColorStop(0.42, '#a4d9f0');
    sky.addColorStop(0.72, '#ffe2b6');
    sky.addColorStop(1, '#ffcf95');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.82)';
    for (let i = 0; i < 11; i++) {
      const x = (i * 71) % w;
      const y = 34 + ((i * 59) % 96);
      const s = 0.55 + (i % 4) * 0.3;
      g.beginPath();
      g.arc(x, y, 19 * s, 0, 7);
      g.arc(x + 21 * s, y + 5 * s, 14 * s, 0, 7);
      g.arc(x - 19 * s, y + 6 * s, 12 * s, 0, 7);
      g.fill();
    }
  });
}

/** Soft round dot for the dust motes. */
function texDot() {
  return canvasTexture(64, 64, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(255,244,214,1)');
    r.addColorStop(0.45, 'rgba(255,236,190,0.55)');
    r.addColorStop(1, 'rgba(255,230,170,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, w, h);
  });
}

// ---------------------------------------------------------------------------
export class HouseRoom extends Room {
  id = 'house';
  name = 'A Cozy Den';

  build(scene, game) {
    this.t = 0;
    this.game = game;
    this.scene = scene;
    this._items = [];
    this._ticking = [];
    this._unsubs = [];
    this._editing = false;
    this._editor = null;

    // ---- who lives here ----------------------------------------------------
    const ctx = (game && game.__houseCtx) || null;
    this._ctxRef = ctx; // cleared on dispose only if nobody queued a new visit
    const fromId = typeof game?.roomId === 'string' && game.roomId.startsWith('house:')
      ? game.roomId.slice(6) : '';
    const owner = String(ctx?.owner || fromId || 'Someone').slice(0, 16) || 'Someone';
    this.owner = owner;
    this.ownerLower = owner.toLowerCase();
    this.isOwner = ctx
      ? !!ctx.isOwner
      : !!game?.state?.registered && String(game.state.name || '').toLowerCase() === this.ownerLower;
    this.access = ACCESS_MODES.includes(ctx?.access) ? ctx.access : 'friends';
    this.name = `${owner}'s Den`;
    this.id = `house:${this.ownerLower}`;
    this.keepClear = KEEP_CLEAR;
    this.bounds = { hx: HX, hz: HZ };
    this.maxItems = HOUSE_MAX_ITEMS;

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._rand = rng(this.ownerLower.length * 7919 + this.ownerLower.charCodeAt(0) * 131 || 4242);

    scene.background = new THREE.Color(0x9ed6ef);

    // ---- instanced prop batches -------------------------------------------
    const white = () => makeToon(0xffffff, { unique: true });
    const box = new Batch(new THREE.BoxGeometry(1, 1, 1), white());
    const boxFlat = new Batch(new THREE.BoxGeometry(1, 1, 1), white()); // no shadow casting
    const cyl = new Batch(new THREE.CylinderGeometry(0.5, 0.5, 1, 12), white());
    const ball = new Batch(new THREE.SphereGeometry(0.5, 12, 9), white());
    const cone = new Batch(new THREE.ConeGeometry(0.5, 1, 10), white());
    this._batches = [box, boxFlat, cyl, ball, cone];

    this._buildOutside(scene, box, ball, cone);
    this._buildShell(scene, box, boxFlat, ball);
    this._buildHearth(scene, box, boxFlat, cyl, ball);
    this._buildDoorArea(scene, box, boxFlat, cyl, ball);
    this._buildDressing(scene, box, boxFlat, cyl, ball);
    this._buildLights(scene);
    this._buildParticles(scene);

    for (const b of this._batches) b.build(scene, b !== boxFlat, true);

    // ---- editing aids (hidden until the owner decorates) -------------------
    this._buildEditAids(scene);

    // ---- navigation --------------------------------------------------------
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 3.0),
      from_plaza: new THREE.Vector3(0, 0, 3.0),
    };
    this.cameraHint = { offset: new THREE.Vector3(0, 11.5, 15), lookHeight: 1.1 };
    // static camera: the whole den floor, both shelf walls and the doormat
    this.staticCamera = { position: new THREE.Vector3(0, 13.5, 16.5), lookAt: new THREE.Vector3(0, 1.15, -1) };

    this._buildHotspots();

    // ---- contents ----------------------------------------------------------
    this.setLayout(Array.isArray(ctx?.furniture) ? ctx.furniture : []);
    this.setAccess(this.access);

    // Everyone standing in the den sees the owner's saves land: the server
    // refreshes house-info to the whole room after every house-save.
    if (game?.events) {
      this._unsubs.push(game.events.on('house-info', (m) => this._onHouseInfo(m)));
    }
    // Arrived without a context (reload straight into a den, or a UI that
    // forgot): ask the server who lives here and what is in it.
    if (!ctx) game?.net?.send?.({ t: 'house-info', owner });
  }

  // -------------------------------------------------------------------------
  // shell: floor, walls, windows, ceiling
  // -------------------------------------------------------------------------
  _buildShell(scene, box, boxFlat, ball) {
    const grad = makeToon(0xffffff).gradientMap;
    const toonMap = (map, color = 0xffffff, extra = {}) =>
      new THREE.MeshToonMaterial({ color, map, gradientMap: grad, ...extra });
    const flat = (map, extra = {}) => new THREE.MeshBasicMaterial({ map, ...extra });

    // the only walkable surface in the den
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HX * 2, HZ * 2), toonMap(texPlanks()));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.groundMeshes = [floor];
    this._floor = floor;

    // --- walls with punched window openings ---------------------------------
    const wallMat = makeToon(PAL.wall);
    const mkWall = (width, holes) => {
      const s = new THREE.Shape();
      s.moveTo(-width / 2, 0);
      s.lineTo(width / 2, 0);
      s.lineTo(width / 2, WALL_H);
      s.lineTo(-width / 2, WALL_H);
      s.closePath();
      for (const [x0, y0, x1, y1] of holes) {
        const p = new THREE.Path();
        p.moveTo(x0, y0);
        p.lineTo(x1, y0);
        p.lineTo(x1, y1);
        p.lineTo(x0, y1);
        p.closePath();
        s.holes.push(p);
      }
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.36, bevelEnabled: false });
      geo.translate(0, 0, -0.36);
      const m = new THREE.Mesh(geo, wallMat);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      return m;
    };

    // north: solid, the hearth leans on it
    const north = mkWall(HX * 2 + 0.9, []);
    north.position.z = WZN;
    // west: the big garden window (local +x runs -z .. +z)
    const west = mkWall(HZ * 2 + 0.9, [[-2.7, 1.25, 2.7, 3.65]]);
    west.rotation.y = Math.PI / 2;
    west.position.x = -WX;
    // east: a smaller square window over the shelf
    const east = mkWall(HZ * 2 + 0.9, [[-2.3, 1.55, -0.1, 3.35]]);
    east.rotation.y = -Math.PI / 2;
    east.position.x = WX;

    // south: two stubs either side of the doorway, kept low so the play camera
    // looks straight over them into the room
    const segW = HX - DOOR_W / 2 + 0.45;
    for (const s of [-1, 1]) {
      const cx = s * (DOOR_W / 2 + segW / 2);
      boxFlat.add(PAL.wainscot, cx, HALF_WALL_H / 2, WZS, segW, HALF_WALL_H, 0.36);
      boxFlat.add(PAL.wood, cx, HALF_WALL_H + 0.06, WZS, segW + 0.12, 0.14, 0.5);
    }

    // painted garden hung just outside each window
    const gw = new THREE.Mesh(new THREE.PlaneGeometry(8.6, 4.3), flat(texGarden(false)));
    gw.rotation.y = Math.PI / 2;
    gw.position.set(-WX - 0.6, 2.55, 0);
    scene.add(gw);
    const ge = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), flat(texGarden(true)));
    ge.rotation.y = -Math.PI / 2;
    ge.position.set(WX + 0.6, 2.5, -1.2);
    scene.add(ge);

    // skirting, chair rail, picture rail on the three solid walls
    const runs = [
      [0, WZN + 0.2, HX * 2 + 0.9, 0.2],
      [-WX + 0.2, 0, 0.2, HZ * 2 + 0.9],
      [WX - 0.2, 0, 0.2, HZ * 2 + 0.9],
    ];
    for (const [x, z, sx, sz] of runs) {
      boxFlat.add(PAL.cream, x, 0.16, z, sx, 0.32, sz);          // skirting
      boxFlat.add(PAL.wainscot, x, 0.72, z, sx - 0.02, 0.8, sz - 0.02);
      boxFlat.add(PAL.wood, x, 1.16, z, sx + 0.04, 0.12, sz + 0.04); // chair rail
      boxFlat.add(PAL.cream, x, 4.15, z, sx + 0.04, 0.14, sz + 0.04); // picture rail
      boxFlat.add(PAL.wood, x, WALL_H - 0.18, z, sx + 0.06, 0.3, sz + 0.06);
    }
    // corner posts
    for (const s of [-1, 1]) {
      box.add(PAL.woodMid, s * (WX - 0.18), WALL_H / 2, WZN + 0.18, 0.34, WALL_H, 0.34);
      box.add(PAL.woodMid, s * (WX - 0.18), WALL_H / 2, WZS - 0.22, 0.34, WALL_H, 0.34);
    }

    // window frames + sills
    const frameZ = (x, cy, cz, wide, high) => {
      const t = 0.16;
      boxFlat.add(PAL.cream, x, cy + high / 2, cz, t + 0.2, t, wide + 0.34);
      boxFlat.add(PAL.cream, x, cy - high / 2, cz, t + 0.2, t, wide + 0.34);
      boxFlat.add(PAL.cream, x, cy, cz - wide / 2, t + 0.2, high, t);
      boxFlat.add(PAL.cream, x, cy, cz + wide / 2, t + 0.2, high, t);
      boxFlat.add(PAL.cream, x, cy, cz, t + 0.14, high, 0.1); // mullion
      boxFlat.add(PAL.cream, x, cy, cz, t + 0.14, 0.1, wide); // transom
    };
    frameZ(-WX + 0.1, 2.45, 0, 5.4, 2.4);
    frameZ(WX - 0.1, 2.45, -1.2, 2.2, 1.8);

    // deep sill on the big window with a row of little pots
    box.add(PAL.woodLight, -WX + 0.34, 1.2, 0, 0.6, 0.14, 5.6);
    for (let i = 0; i < 5; i++) {
      const z = -2.1 + i * 1.05;
      box.add(0xcf7649, -WX + 0.42, 1.44, z, 0.36, 0.34, 0.36);
      ball.add(i % 2 ? PAL.leaf : PAL.coral, -WX + 0.42, 1.68, z, 0.42, 0.36, 0.42);
    }

    // curtains either side of the big window
    for (const s of [-1, 1]) {
      boxFlat.add(PAL.coral, -WX + 0.5, 2.6, s * 3.1, 0.16, 2.9, 0.9, 0, 0, s * 0.04);
      boxFlat.add(PAL.gold, -WX + 0.5, 4.02, s * 3.1, 0.2, 0.16, 1.0);
    }
    boxFlat.add(PAL.wood, -WX + 0.52, 4.12, 0, 0.12, 0.12, 7.2);

    // --- ceiling: a few beams over the FAR half only ------------------------
    // A beam near the camera lies across the middle of the frame; the same beam
    // at the back reads as depth against the north wall. So the south half of
    // the ceiling stays empty.
    for (let i = 0; i < 4; i++) {
      const z = -6.2 + i * 1.75;
      boxFlat.add(PAL.woodMid, 0, 5.08, z, HX * 2 + 0.4, 0.2, 0.26);
    }
    boxFlat.add(PAL.wood, 0, 5.25, -3.6, 0.3, 0.26, 7.4);
  }

  // -------------------------------------------------------------------------
  // the hearth: this den's star attraction, opposite the door
  // -------------------------------------------------------------------------
  _buildHearth(scene, box, boxFlat, cyl, ball) {
    const bz = WZN + 0.5;

    // chimney breast
    box.add(PAL.stone, 0, 2.6, bz, 4.6, 5.2, 0.7);
    boxFlat.add(PAL.stoneDark, 0, 0.06, bz + 0.45, 5.0, 0.12, 1.1); // hearthstone
    // stacked stones around the opening
    const rand = this._rand;
    for (let row = 0; row < 6; row++) {
      const y = 0.3 + row * 0.42;
      const half = row < 4 ? 2.35 : 2.2;
      for (let i = 0; i < 7; i++) {
        const x = -half + (i / 6) * half * 2;
        if (Math.abs(x) < 1.25 && y < 1.75) continue; // the fire opening
        box.add(rand() > 0.5 ? PAL.stone : PAL.stoneDark,
          x, y, bz + 0.38, 0.62 + rand() * 0.12, 0.38, 0.28);
      }
    }
    // opening back + logs + embers
    boxFlat.add(0x3a2c1e, 0, 0.9, bz + 0.2, 2.5, 1.8, 0.2);
    for (const [x, y, rz] of [[-0.35, 0.3, 0.16], [0.4, 0.3, -0.2], [0, 0.62, 0.06]]) {
      cyl.add(PAL.wood, x, y, bz + 0.42, 0.24, 1.7, 0.24, 0, Math.PI / 2, rz);
    }
    for (let i = 0; i < 7; i++) {
      ball.add(i % 2 ? PAL.ember : PAL.gold,
        -0.9 + i * 0.3, 0.2 + (i % 3) * 0.05, bz + 0.42, 0.24, 0.18, 0.24);
    }

    // mantel + what lives on it
    box.add(PAL.wood, 0, 2.02, bz + 0.5, 5.2, 0.24, 0.86);
    box.add(PAL.woodMid, 0, 1.88, bz + 0.5, 4.9, 0.1, 0.78);
    for (const s of [-1, 1]) {
      cyl.add(PAL.cream, s * 1.75, 2.36, bz + 0.5, 0.16, 0.44, 0.16);
      ball.add(PAL.gold, s * 1.75, 2.62, bz + 0.5, 0.16, 0.22, 0.16);
    }
    // a little clock
    cyl.add(PAL.woodMid, 0, 2.42, bz + 0.5, 0.62, 0.2, 0.62, Math.PI / 2, 0, 0);
    const clockFace = new THREE.Mesh(
      new THREE.CircleGeometry(0.24, 16),
      makeGlow(PAL.cream, { unique: true }),
    );
    clockFace.position.set(0, 2.42, bz + 0.62);
    scene.add(clockFace);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.18, 0.02), makeToon(0x2d2417));
    hand.position.set(0, 0.07, 0.02);
    const handPivot = new THREE.Group();
    handPivot.position.copy(clockFace.position);
    handPivot.position.z += 0.02;
    handPivot.add(hand);
    scene.add(handPivot);
    this._clockHand = handPivot;

    // the fire's own light: warm, low and always flickering
    const fire = new THREE.PointLight(0xff9440, 14, 15, 2);
    fire.position.set(0, 0.85, bz + 0.7);
    scene.add(fire);
    this._fire = fire;

    // rising embers, recycled forever
    const emberGeo = new THREE.SphereGeometry(0.045, 6, 4);
    const embers = new THREE.InstancedMesh(emberGeo, makeGlow(0xffb257, { unique: true }), 10);
    scene.add(embers);
    this._embers = embers;
    this._emberData = [];
    for (let i = 0; i < 10; i++) {
      this._emberData.push({
        x: (rand() - 0.5) * 1.6, y: rand() * 1.6, z: bz + 0.4 + (rand() - 0.5) * 0.3,
        sp: 0.35 + rand() * 0.4, ph: rand() * 6.28,
      });
    }

    // obstacle circles across the breast so nobody stands in the fire
    this._fixedObstacles = [];
    for (let i = -2; i <= 2; i++) {
      this._fixedObstacles.push({ x: i * 0.95, z: bz - 0.25, r: 0.8 });
    }
  }

  // -------------------------------------------------------------------------
  // the way in: door, porch, mat, decorating stand, visitor board
  // -------------------------------------------------------------------------
  _buildDoorArea(scene, box, boxFlat, cyl, ball) {
    const grad = makeToon(0xffffff).gradientMap;
    const toonMap = (map) => new THREE.MeshToonMaterial({ map, gradientMap: grad });

    // Door frame. Kept slim in z: the play camera looks down on its top faces,
    // so every extra centimetre of depth becomes a slab across the near edge
    // of the frame.
    for (const s of [-1, 1]) {
      box.add(PAL.wood, s * (DOOR_W / 2 + 0.16), 1.45, WZS, 0.32, 2.9, 0.34);
    }
    box.add(PAL.wood, 0, 2.98, WZS, DOOR_W + 0.64, 0.3, 0.34);
    box.add(PAL.coral, 0, 3.2, WZS, DOOR_W + 0.9, 0.16, 0.4);

    // Propped wide open, swung almost straight out onto the porch: at any
    // gentler angle the panel lies across the doorway from the play camera.
    const door = new THREE.Group();
    door.position.set(-DOOR_W / 2 - 0.05, 0, WZS - 0.2);
    door.rotation.y = -1.48;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W - 0.2, 2.75, 0.14), makeToon(0xc4703f));
    panel.position.set((DOOR_W - 0.2) / 2, 1.38, 0);
    panel.castShadow = true;
    door.add(panel);
    const win = new THREE.Mesh(new THREE.CircleGeometry(0.42, 14), makeGlow(0xd8f0ff, { unique: true }));
    win.position.set((DOOR_W - 0.2) / 2, 2.05, 0.08);
    door.add(win);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), makeToon(PAL.gold));
    knob.position.set(DOOR_W - 0.5, 1.25, 0.12);
    door.add(knob);
    scene.add(door);

    // the mat, with the owner's name in it
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 1.65), toonMap(texMat(this.owner)));
    mat.rotation.x = -Math.PI / 2;
    mat.position.set(0, 0.012, 6.05);
    mat.receiveShadow = true;
    scene.add(mat);

    // porch outside: steps and a path only. Anything with height out here sits
    // between the play camera and the door and swallows the whole doorway.
    boxFlat.add(PAL.woodLight, 0, -0.06, WZS + 0.75, DOOR_W + 1.6, 0.16, 1.5);
    boxFlat.add(PAL.woodMid, 0, -0.2, WZS + 1.7, DOOR_W + 2.2, 0.16, 0.9);
    boxFlat.add(0xd9c08a, 0, -0.24, WZS + 5, 2.6, 0.12, 6.4);
    for (const s of [-1, 1]) {
      boxFlat.add(PAL.leafDark, s * 3.1, 0.2, WZS + 1.9, 0.7, 0.5, 0.7); // planters
      ball.add(PAL.coral, s * 3.1, 0.5, WZS + 1.9, 0.8, 0.5, 0.8);
    }

    // --- decorating stand (owner only prompt sits here) ---------------------
    const dz = 5.9;
    box.add(PAL.woodMid, -3.7, 0.42, dz, 0.9, 0.84, 0.9);
    box.add(PAL.woodLight, -3.7, 0.88, dz, 1.06, 0.12, 1.06);
    cyl.add(0xdff0ff, -3.9, 1.08, dz, 0.34, 0.28, 0.34);
    cyl.add(PAL.coral, -3.9, 1.24, dz, 0.3, 0.06, 0.3);
    cyl.add(PAL.woodLight, -3.5, 1.24, dz + 0.1, 0.07, 0.62, 0.07, 0.2, 0, 0.3);
    cyl.add(PAL.gold, -3.4, 1.5, dz + 0.16, 0.1, 0.16, 0.1, 0.2, 0, 0.3);
    const spark = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.16, 0),
      makeGlow(0xffe6a8, { unique: true }),
    );
    spark.position.set(-3.7, 1.75, dz);
    scene.add(spark);
    this._spark = spark;

    // --- visitor board -------------------------------------------------------
    const bx = 3.7;
    box.add(PAL.wood, bx, 0.95, dz, 0.16, 1.9, 0.16);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), toonMap(texAccessBoard()));
    board.position.set(bx, 2.2, dz - 0.1);
    board.rotation.y = Math.PI;
    scene.add(board);
    boxFlat.add(PAL.wood, bx, 2.2, dz - 0.02, 1.66, 1.66, 0.08, 0, Math.PI, 0);
    // the peg that marks the current mode
    const peg = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), makeGlow(PAL.coral, { unique: true }));
    peg.position.set(bx + 0.6, 2.2, dz - 0.16);
    scene.add(peg);
    this._accessPeg = peg;

    ball.add(PAL.gold, bx, 3.12, dz, 0.3, 0.3, 0.3);

    // coat pegs on the west wall, past the window: a scarf and a sun hat
    const pegZ = 5.2;
    box.add(PAL.wood, -WX + 0.3, 1.98, pegZ, 0.2, 0.22, 2.2);
    for (let i = 0; i < 3; i++) {
      cyl.add(PAL.woodMid, -WX + 0.46, 1.9, pegZ - 0.7 + i * 0.7, 0.1, 0.32, 0.1, 0, 0, Math.PI / 2);
    }
    boxFlat.add(PAL.coral, -WX + 0.5, 1.32, pegZ - 0.7, 0.12, 1.16, 0.34);
    boxFlat.add(PAL.cream, -WX + 0.5, 0.76, pegZ - 0.7, 0.12, 0.2, 0.34);
    ball.add(PAL.straw, -WX + 0.52, 1.78, pegZ + 0.7, 0.16, 0.62, 0.62);
  }

  // -------------------------------------------------------------------------
  // wall dressing, shelf, hanging lantern, bunting
  // -------------------------------------------------------------------------
  _buildDressing(scene, box, boxFlat, cyl, ball) {
    const grad = makeToon(0xffffff).gradientMap;
    const toonMap = (map) => new THREE.MeshToonMaterial({ map, gradientMap: grad });

    // paintings on the north wall, either side of the chimney
    for (const [s, kind] of [[-1, 'sea'], [1, 'hill']]) {
      const art = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.35), toonMap(texArt(kind)));
      art.position.set(s * 5.2, 2.9, WZN + 0.2);
      scene.add(art);
      boxFlat.add(PAL.gold, s * 5.2, 2.9, WZN + 0.14, 1.9, 1.55, 0.1);
      boxFlat.add(PAL.wood, s * 5.2, 3.72, WZN + 0.14, 0.06, 0.5, 0.06, -0.3, 0, 0);
    }

    // east wall shelf with jars, books and a plant
    const shelfZ = 2.6;
    box.add(PAL.woodLight, WX - 0.42, 1.85, shelfZ, 0.6, 0.14, 3.6);
    box.add(PAL.woodLight, WX - 0.42, 2.85, shelfZ, 0.6, 0.14, 3.6);
    for (const s of [-1, 1]) {
      boxFlat.add(PAL.wood, WX - 0.3, 2.35, shelfZ + s * 1.7, 0.34, 1.2, 0.14);
    }
    const bookCols = [PAL.coral, PAL.gold, PAL.sky, PAL.leaf, 0xfdf0d5, 0x9b6bd4];
    for (let i = 0; i < 9; i++) {
      box.add(bookCols[i % bookCols.length],
        WX - 0.44, 2.16, shelfZ - 1.5 + i * 0.19, 0.42, 0.5, 0.14, 0, 0, (i % 4 === 3 ? 0.2 : 0));
    }
    for (let i = 0; i < 4; i++) {
      cyl.add(0xdff0ff, WX - 0.44, 3.06, shelfZ - 1.2 + i * 0.7, 0.3, 0.3, 0.3);
      ball.add([PAL.coral, PAL.gold, PAL.leaf, PAL.sky][i], WX - 0.44, 3.24, shelfZ - 1.2 + i * 0.7, 0.26, 0.16, 0.26);
    }

    // hanging lantern over the middle of the room
    const lantern = new THREE.Group();
    lantern.position.set(0, 4.8, -0.4);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 6), makeToon(0x4a3a2c));
    cord.position.y = -0.4;
    lantern.add(cord);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.78, 0.62, 14, 1, true),
      makeToon(PAL.cream, { side: THREE.DoubleSide }),
    );
    shade.position.y = -1.05;
    lantern.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8), makeGlow(0xffe6b0, { unique: true }));
    bulb.position.y = -1.22;
    lantern.add(bulb);
    scene.add(lantern);
    this._lantern = lantern;

    // Bunting, strung high and well back: below this line it hangs across the
    // middle of the room from the play camera instead of behind it.
    const FLAG_Z = 1.2;
    const cols = [PAL.coral, PAL.gold, PAL.sky, PAL.leaf, PAL.cream];
    this._flags = [];
    const flagGeo = new THREE.ConeGeometry(0.24, 0.5, 3);
    const flagMesh = new THREE.InstancedMesh(flagGeo, makeToon(0xffffff, { unique: true }), 13);
    const d = new THREE.Object3D();
    const c = new THREE.Color();
    for (let i = 0; i < 13; i++) {
      const tt = i / 12;
      const x = -7.6 + tt * 15.2;
      const y = 4.85 - 0.5 * (1 - (2 * tt - 1) ** 2);
      this._flags.push({ x, y, z: FLAG_Z, ph: i * 0.6 });
      d.position.set(x, y - 0.25, FLAG_Z);
      d.rotation.set(0, 0, Math.PI);
      d.scale.setScalar(1);
      d.updateMatrix();
      flagMesh.setMatrixAt(i, d.matrix);
      flagMesh.setColorAt(i, c.setHex(cols[i % cols.length]));
    }
    flagMesh.instanceMatrix.needsUpdate = true;
    if (flagMesh.instanceColor) flagMesh.instanceColor.needsUpdate = true;
    flagMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(flagMesh);
    this._flagMesh = flagMesh;
    this._flagDummy = d;
  }

  // -------------------------------------------------------------------------
  // the garden the windows look out on, so no edge of frame is empty
  // -------------------------------------------------------------------------
  _buildOutside(scene, box, ball, cone) {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(80, 16, 10),
      new THREE.MeshBasicMaterial({ map: texSky(), side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);

    const grass = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), makeToon(PAL.grass));
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.3;
    scene.add(grass);

    const rand = this._rand;
    // hedge ring, well clear of the walls
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      const rr = 17 + rand() * 1.4;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr * 0.8;
      ball.add(i % 3 ? PAL.leafDark : PAL.leaf, x, 0.4 + rand() * 0.2, z, 2.6, 2.0, 2.6);
    }
    // a few trees behind the hedge
    for (let i = 0; i < 7; i++) {
      const a = 0.4 + (i / 7) * Math.PI * 2;
      const rr = 23 + rand() * 6;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr * 0.85;
      box.add(0x6b4f35, x, 1.6, z, 0.7, 3.2, 0.7);
      cone.add(PAL.leafDark, x, 4.2, z, 3.6, 3.4, 3.6);
      cone.add(PAL.leaf, x, 5.5, z, 2.7, 2.8, 2.7);
    }
    // outside walls of the cottage, so peeking players see a house not a shell
    box.add(0xe6d0a8, 0, 2.7, WZN - 0.5, HX * 2 + 1.4, 5.4, 0.5);
    for (const s of [-1, 1]) {
      box.add(0xe6d0a8, s * (WX + 0.35), 2.7, 0, 0.5, 5.4, HZ * 2 + 1.4);
    }
    // Eaves only, hugging the outside of each wall. A roof spanning the room
    // would hang its dark underside across the top of every frame.
    box.add(0xb0503f, 0, 5.7, WZN - 1.3, HX * 2 + 3.4, 0.42, 2.6, -0.34, 0, 0);
    for (const s of [-1, 1]) {
      box.add(0xb0503f, s * (WX + 1.15), 5.7, 0, 2.6, 0.42, HZ * 2 + 3.4, 0, 0, s * -0.34);
    }
    box.add(0x8f4133, 0, 6.35, WZN - 0.25, HX * 2 + 3.6, 0.36, 0.6);
  }

  // -------------------------------------------------------------------------
  _buildLights(scene) {
    scene.add(new THREE.HemisphereLight(0xfff1da, 0x7d6144, 0.66));
    scene.add(new THREE.AmbientLight(0xfff4e2, 0.28));

    // afternoon light leaning in through the big west window
    const sun = new THREE.DirectionalLight(0xffe4bd, 0.95);
    sun.position.set(-17, 13, 5);
    sun.target.position.set(1, 0.6, -1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -13;
    sun.shadow.camera.right = 13;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -11;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 52;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);

    // lamp fills: one under the lantern, one by the door
    const lamp = new THREE.PointLight(0xffd6a0, 11, 20, 2);
    lamp.position.set(0, 3.6, -0.4);
    scene.add(lamp);
    const porch = new THREE.PointLight(0xffcf9a, 6, 12, 2);
    porch.position.set(0, 2.7, 6.2);
    scene.add(porch);
  }

  // -------------------------------------------------------------------------
  _buildParticles(scene) {
    const rand = this._rand;
    const count = 90;
    const pos = new Float32Array(count * 3);
    this._moteData = [];
    for (let i = 0; i < count; i++) {
      const x = -HX + rand() * HX * 2;
      const y = 0.6 + rand() * 3.4;
      const z = -HZ + rand() * HZ * 2;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      this._moteData.push({ x, y, z, ph: rand() * 6.28, sp: 0.06 + rand() * 0.12 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const motes = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.13,
      map: texDot(),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    scene.add(motes);
    this._motes = motes;
    this._motePos = pos;
  }

  // -------------------------------------------------------------------------
  // editing aids: half-unit grid + the keep-clear ring by the door
  // -------------------------------------------------------------------------
  _buildEditAids(scene) {
    const aids = new THREE.Group();
    aids.visible = false;
    scene.add(aids);
    this._aids = aids;

    const pts = [];
    for (let x = -HX; x <= HX + 1e-6; x += 0.5) pts.push(x, 0.02, -HZ, x, 0.02, HZ);
    for (let z = -HZ; z <= HZ + 1e-6; z += 0.5) pts.push(-HX, 0.02, z, HX, 0.02, z);
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    aids.add(new THREE.LineSegments(gGeo, new THREE.LineBasicMaterial({
      color: 0xfff6e3, transparent: true, opacity: 0.21, depthWrite: false,
    })));

    for (const kc of KEEP_CLEAR) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.1, kc.r - 0.09), kc.r, 40),
        new THREE.MeshBasicMaterial({
          color: PAL.coral, transparent: true, opacity: 0.42, depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(kc.x, 0.03, kc.z);
      aids.add(ring);
    }

    // the ring that marks whichever piece the owner has hold of
    this._selMat = new THREE.MeshBasicMaterial({
      color: PAL.gold, transparent: true, opacity: 0.9, depthWrite: false,
      side: THREE.DoubleSide,
    });
    const sel = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), this._selMat);
    sel.rotation.x = -Math.PI / 2;
    sel.position.y = 0.045;
    sel.visible = false;
    scene.add(sel); // outside `aids`: it has its own visibility
    this._selRing = sel;
  }

  /** Ring the piece being moved. `ok=false` turns it coral to say "not there". */
  highlight(item, ok = true) {
    const ring = this._selRing;
    if (!ring) return;
    if (!item) { ring.visible = false; return; }
    ring.visible = true;
    ring.position.set(item.x, 0.045, item.z);
    ring.scale.setScalar(Math.max(0.45, item.r + 0.16));
    this._selMat.color.setHex(ok ? PAL.gold : PAL.coral);
  }

  // -------------------------------------------------------------------------
  _buildHotspots() {
    const exit = {
      id: 'exit-plaza',
      position: new THREE.Vector3(0, 0, 6.4),
      radius: 2.1,
      label: 'Out to Sunny Plaza',
      action: (g) => g.goToRoom('plaza', null),
    };
    this._hotspotsAll = [exit];

    if (this.isOwner) {
      this._decorateSpot = {
        id: 'decorate',
        position: new THREE.Vector3(-3.7, 0, 5.9),
        radius: 2.0,
        label: 'Decorate your den',
        action: (g) => this.openEditor(g),
      };
      this._accessSpot = {
        id: 'house-access',
        position: new THREE.Vector3(3.7, 0, 5.9),
        radius: 2.0,
        label: `Access: ${this.access}`,
        action: (g) => this.openEditor(g, 'access'),
      };
      this._hotspotsAll.push(this._decorateSpot, this._accessSpot);
    }
    this.hotspots = this._editing ? [] : this._hotspotsAll;
  }

  /** Opens the decorating drawer (owner only). */
  openEditor(game, tab) {
    if (!this.isOwner) return;
    try {
      this._editor = openHouseEditor(game || this.game, this, tab ? { tab } : undefined);
    } catch (e) {
      console.error('[house] could not open the decorator', e);
      (game || this.game)?.toast?.('The decorating drawer is stuck. Try again in a moment.');
    }
  }

  // -------------------------------------------------------------------------
  // server sync
  // -------------------------------------------------------------------------
  _onHouseInfo(m) {
    if (!m || String(m.owner || '').toLowerCase() !== this.ownerLower) return;
    if (ACCESS_MODES.includes(m.access)) this.setAccess(m.access);
    // `allowed:false` refreshes carry no layout by design (a den you cannot walk
    // into does not leak its contents), and the owner tightening the door while
    // a guest is standing here sends exactly that. Applying it would empty the
    // room around them; they keep what they walked in on until they leave.
    if (m.allowed === false) return;
    // While the owner is mid-decorate the local layout is the live one: the
    // editor applies the server's copy itself once the save is acknowledged.
    if (Array.isArray(m.furniture) && !this._editing) this.setLayout(m.furniture);
  }

  setAccess(mode) {
    if (!ACCESS_MODES.includes(mode)) return;
    this.access = mode;
    if (this._accessSpot) {
      this._accessSpot.label = `Access: ${ACCESS_LABEL[mode] || mode}`;
      // a prompt already on screen keeps its old text otherwise
      const el = this.game?.engine?.hotspotEls?.get?.(this._accessSpot);
      if (el) el.textContent = this._accessSpot.label;
    }
    if (this._accessPeg) {
      this._accessPeg.position.y = 2.2 + [0.42, 0.09, -0.24][ACCESS_MODES.indexOf(mode)];
    }
  }

  // -------------------------------------------------------------------------
  // editor API (src/ui/houseEditor.js drives the room through these)
  // -------------------------------------------------------------------------

  /** The current layout in wire format. */
  getLayout() {
    return this._items.map((it) => ({ f: it.f, x: it.x, z: it.z, rot: it.rot }));
  }

  /** Replace everything on the floor with `list`. */
  setLayout(list) {
    for (const it of this._items) this._destroyItem(it);
    this._items.length = 0;
    this._ticking.length = 0;
    const arr = Array.isArray(list) ? list.slice(0, HOUSE_MAX_ITEMS) : [];
    for (const raw of arr) this.addItem(raw, true);
    this._syncObstacles();
  }

  /** Place one piece. Returns the item record, or null if it could not build. */
  addItem(raw, quiet = false) {
    if (!raw || this._items.length >= HOUSE_MAX_ITEMS) return null;
    const f = String(raw.f || '');
    const obj = makeFurniture(f);
    if (!obj) return null;
    const { r, solid } = metricsFor(f, obj);
    const item = {
      f,
      x: Number.isFinite(raw.x) ? raw.x : 0,
      z: Number.isFinite(raw.z) ? raw.z : 0,
      rot: Number.isFinite(raw.rot) ? raw.rot : 0,
      obj, r, solid,
    };
    obj.position.set(item.x, 0, item.z);
    obj.rotation.y = item.rot;
    this.scene.add(obj);
    if (typeof obj.userData?.update === 'function') this._ticking.push(obj);
    this._items.push(item);
    if (!quiet) this._syncObstacles();
    return item;
  }

  removeItem(item) {
    const i = this._items.indexOf(item);
    if (i < 0) return;
    this._items.splice(i, 1);
    this._destroyItem(item);
    this._syncObstacles();
  }

  /** Move / turn a placed piece. */
  poseItem(item, x, z, rot) {
    if (!item) return;
    if (Number.isFinite(x)) item.x = x;
    if (Number.isFinite(z)) item.z = z;
    if (Number.isFinite(rot)) item.rot = rot;
    item.obj.position.set(item.x, 0, item.z);
    item.obj.rotation.y = item.rot;
    this._syncObstacles();
  }

  get items() {
    return this._items;
  }

  /**
   * A translucent copy of `fid` plus its footprint ring, following the pointer.
   * Materials are cloned so the shared toon cache is never mutated.
   */
  makeGhost(fid) {
    const obj = makeFurniture(fid);
    if (!obj) return null;
    const { r, solid } = metricsFor(fid, obj);
    const clones = [];
    obj.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const next = mats.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.7;
        c.depthWrite = false;
        // shared: disposeObject must not free the texture the original still uses
        c.userData = { ...(c.userData || {}), shared: true };
        clones.push(c);
        return c;
      });
      o.material = Array.isArray(o.material) ? next : next[0];
      o.castShadow = false;
      o.receiveShadow = false;
    });

    const group = new THREE.Group();
    group.add(obj);
    const ringMat = new THREE.MeshBasicMaterial({
      color: PAL.leaf, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.14, r - 0.14), r, 36), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    group.add(ring);
    this.scene.add(group);

    const ghost = {
      f: fid, r, solid, group, valid: true,
      setPose: (x, z, rot) => {
        group.position.set(x, 0, z);
        obj.rotation.y = rot;
      },
      setValid: (ok) => {
        if (ghost.valid === ok) return;
        ghost.valid = ok;
        ringMat.color.setHex(ok ? PAL.leaf : PAL.coral);
        for (const c of clones) c.opacity = ok ? 0.7 : 0.38;
      },
      dispose: () => {
        this.scene.remove(group);
        disposeObject(group); // frees geometry; skips the shared-marked clones
        for (const c of clones) c.dispose(); // ...which we free here, maps untouched
        ringMat.dispose();
      },
    };
    return ghost;
  }

  /** Pointer -> floor position, or null when the pointer is off the floor. */
  pickFloor(clientX, clientY) {
    const cam = this.game?.engine?.camera;
    if (!cam || !this._floor) return null;
    this._ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this._ray.setFromCamera(this._ndc, cam);
    const hit = this._ray.intersectObject(this._floor, false);
    return hit.length ? { x: hit[0].point.x, z: hit[0].point.z } : null;
  }

  /** Pointer -> the placed piece under it, if any. */
  pickItem(clientX, clientY) {
    const cam = this.game?.engine?.camera;
    if (!cam || !this._items.length) return null;
    this._ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    this._ray.setFromCamera(this._ndc, cam);
    const objs = this._items.map((it) => it.obj);
    const hits = this._ray.intersectObjects(objs, true);
    if (!hits.length) return null;
    let root = hits[0].object;
    while (root.parent && !objs.includes(root)) root = root.parent;
    return this._items.find((it) => it.obj === root) || null;
  }

  /**
   * Grid + keep-clear rings on, room hotspots off (and back again). Emptying
   * hotspots is what stops the door auto-firing mid-decorate; the engine only
   * removes a prompt element while its hotspot is still in the list, so any
   * prompt currently on screen is swept here (it re-appears on close).
   */
  setEditing(on) {
    this._editing = !!on;
    if (this._aids) this._aids.visible = this._editing;
    if (!this._editing) this.highlight(null);
    this.hotspots = this._editing ? [] : (this._hotspotsAll || []);
    const els = this.game?.engine?.hotspotEls;
    if (els) {
      for (const [, el] of els) el.remove();
      els.clear();
    }
  }

  // -------------------------------------------------------------------------
  _destroyItem(item) {
    const ti = this._ticking.indexOf(item.obj);
    if (ti >= 0) this._ticking.splice(ti, 1);
    this.scene.remove(item.obj);
    disposeObject(item.obj);
  }

  _syncObstacles() {
    const list = (this._fixedObstacles || []).slice();
    for (const it of this._items) {
      if (it.solid > 0) list.push({ x: it.x, z: it.z, r: it.solid });
    }
    this.obstacles = list;
  }

  // -------------------------------------------------------------------------
  update(dt) {
    this.t += dt;
    const t = this.t;

    // hearth: two detuned sines never repeat into a visible loop
    if (this._fire) {
      this._fire.intensity = 13 + Math.sin(t * 8.3) * 1.9 + Math.sin(t * 13.7) * 1.1;
    }
    if (this._embers) {
      const d = this._flagDummy || (this._flagDummy = new THREE.Object3D());
      for (let i = 0; i < this._emberData.length; i++) {
        const e = this._emberData[i];
        e.y += e.sp * dt;
        if (e.y > 2.1) { e.y = 0.15; e.x = (Math.random() - 0.5) * 1.5; }
        d.position.set(e.x + Math.sin(t * 2 + e.ph) * 0.12, e.y, e.z);
        d.scale.setScalar(Math.max(0.2, 1 - e.y / 2.4));
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        this._embers.setMatrixAt(i, d.matrix);
      }
      this._embers.instanceMatrix.needsUpdate = true;
    }

    // dust motes drifting through the window light
    if (this._motes) {
      const p = this._motePos;
      for (let i = 0; i < this._moteData.length; i++) {
        const m = this._moteData[i];
        m.y += m.sp * dt;
        if (m.y > 4.3) m.y = 0.4;
        p[i * 3] = m.x + Math.sin(t * 0.5 + m.ph) * 0.35;
        p[i * 3 + 1] = m.y;
        p[i * 3 + 2] = m.z + Math.cos(t * 0.4 + m.ph) * 0.3;
      }
      this._motes.geometry.attributes.position.needsUpdate = true;
    }

    if (this._lantern) {
      this._lantern.rotation.z = Math.sin(t * 0.7) * 0.035;
      this._lantern.rotation.x = Math.cos(t * 0.55) * 0.03;
    }
    if (this._spark) {
      this._spark.rotation.y += dt * 1.4;
      this._spark.position.y = 1.75 + Math.sin(t * 2.2) * 0.12;
    }
    if (this._clockHand) this._clockHand.rotation.z = -t * 0.35;
    if (this._selRing?.visible) this._selMat.opacity = 0.6 + Math.sin(t * 5) * 0.28;

    if (this._flagMesh) {
      const d = this._flagDummy;
      for (let i = 0; i < this._flags.length; i++) {
        const f = this._flags[i];
        d.position.set(f.x, f.y - 0.25 + Math.sin(t * 1.6 + f.ph) * 0.045, f.z);
        d.rotation.set(0, 0, Math.PI + Math.sin(t * 1.9 + f.ph) * 0.1);
        d.scale.setScalar(1);
        d.updateMatrix();
        this._flagMesh.setMatrixAt(i, d.matrix);
      }
      this._flagMesh.instanceMatrix.needsUpdate = true;
    }

    // furniture animations. The hook takes elapsed time (see furniture.js);
    // dt rides along second. One broken piece drops out instead of taking the
    // whole room's update loop down with it.
    for (let i = this._ticking.length - 1; i >= 0; i--) {
      const o = this._ticking[i];
      try {
        o.userData.update(t, dt);
      } catch (e) {
        this._ticking.splice(i, 1);
        console.warn('[house] furniture update hook failed; disabled', e);
      }
    }
  }

  dispose() {
    this._editor?.close?.();
    this._editor = null;
    for (const off of this._unsubs) { try { off(); } catch { /* already gone */ } }
    this._unsubs.length = 0;
    // Only clear the context we actually consumed: a den-to-den visit has
    // already parked the NEXT context here before this room is torn down.
    if (this.game && this._ctxRef && this.game.__houseCtx === this._ctxRef) {
      this.game.__houseCtx = null;
    }
    this._items.length = 0;
    this._ticking.length = 0;
    this.game = null;
    this.scene = null;
  }
}
