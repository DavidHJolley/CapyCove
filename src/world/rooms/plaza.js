import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';

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

function noticeTex() {
  const w = 512, h = 384;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = '#d9b98a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(120,80,40,0.10)';
    for (let i = 0; i < 300; i++) ctx.fillRect((i * 97) % w, (i * 151) % h, 3, 3);
    ctx.fillStyle = '#5b3a1e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, 'COVE NOTICES', w - 60, 52);
    ctx.fillText('COVE NOTICES', w / 2, 42);
    ctx.strokeStyle = '#8a5c2c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(60, 72);
    ctx.lineTo(w - 60, 72);
    ctx.stroke();

    const notes = [
      ['#fffbe8', -0.03, 'Fishing derby', 'Driftwood Beach, all day'],
      ['#eaf6ff', 0.04, 'Sled races', 'Frosty Peak, hourly'],
      ['#ffeef2', -0.02, 'Kelpberry Crush', 'smoothie of the week'],
      ['#f2ffe8', 0.03, 'Hat sale!', 'wardrobe, east side'],
    ];
    notes.forEach((n, i) => {
      ctx.save();
      ctx.translate(140 + (i % 2) * 232, 165 + ((i / 2) | 0) * 128);
      ctx.rotate(n[1]);
      ctx.fillStyle = 'rgba(60,40,20,0.18)';
      rrect(ctx, -96, -50, 196, 104, 6);
      ctx.fill();
      ctx.fillStyle = n[0];
      rrect(ctx, -100, -54, 196, 104, 6);
      ctx.fill();
      ctx.fillStyle = '#4a2f16';
      fitFont(ctx, n[2], 172, 32);
      ctx.fillText(n[2], -2, -18);
      ctx.fillStyle = '#7a5836';
      fitFont(ctx, n[3], 176, 21, 'normal');
      ctx.fillText(n[3], -2, 18);
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
  }

  build(scene) {
    const rand = rng(20260806);
    this.t = 0;
    this.groundMeshes = [];
    this.hotspots = [];
    this.obstacles = [];
    this.anim = {};

    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(FOG, 42, 118);

    scene.add(new THREE.HemisphereLight(0xfff6e2, 0x8fae6a, 1.0));
    scene.add(new THREE.AmbientLight(0xdfefff, 0.2));
    const sun = new THREE.DirectionalLight(0xfff3d2, 1.55);
    sun.position.set(14, 22, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -21;
    sun.shadow.camera.right = 21;
    sun.shadow.camera.top = 21;
    sun.shadow.camera.bottom = -21;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 62;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    this._buildGround(scene, rand);
    this._buildHorizon(scene, rand);
    this._buildFountain(scene, rand);
    this._buildLamps(scene);
    this._buildBenches(scene);
    this._buildFlowerBeds(scene, rand);
    this._buildTopiary(scene);
    this._buildNoticeBoard(scene);
    this._buildShop(scene);
    this._buildGates(scene);
    this._buildClubEntrance(scene);
    this._buildScatter(scene, rand);
    this._buildCritters(scene, rand);

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
    const pts = [
      [7.27, 4.2], [-7.27, 4.2], [-4.2, -7.27], [4.2, -7.27], [5.99, -2.2], [-5.99, -2.2],
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
    const globeMesh = inst(scene, new THREE.SphereGeometry(0.26, 12, 9), makeGlow(C.lampGlow), globe, false, false);
    const haloMesh = inst(scene, new THREE.SphereGeometry(0.44, 10, 8), glowFade(C.lampGlow, 0.2), halo, false, false);
    this.anim.lamps = { pts, globeMesh, haloMesh };

    // bunting strung between neighbouring lamps
    const spans = [[1, 5], [5, 2], [2, 3], [3, 4], [4, 0]];
    const cordPts = [];
    const flagCols = [C.coral, C.cream];
    const flags = [[], []];
    const flagData = [];
    for (const [ia, ib] of spans) {
      const a = pts[ia], b = pts[ib];
      const top = 3.25, sag = 0.7; // low point 2.55: clears avatar + name tags
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
        }
      }
    }
    const cordGeo = new THREE.BufferGeometry();
    cordGeo.setAttribute('position', new THREE.Float32BufferAttribute(cordPts, 3));
    scene.add(new THREE.LineSegments(cordGeo, new THREE.LineBasicMaterial({ color: 0x6b4f35 })));
    const flagGeo = new THREE.ConeGeometry(0.19, 0.4, 3);
    const flagMeshes = flagCols.map((c, i) => inst(scene, flagGeo, makeGlow(c), flags[i], false, false));
    this.anim.bunting = { flagMeshes, flagData };
  }

  // ------------------------------------------------------------- benches --
  _buildBenches(scene) {
    const spots = [[4.9, -3.4], [-4.9, -3.4], [-2.6, -7.6], [2.6, -7.6], [7.0, 1.4]];
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
    const beds = [[-7.27, -4.2], [-3.4, -10.6], [3.4, -10.6], [9.6, 5.6]];
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

    const plaqueTex = woodSignTex('Do not nibble', 'he is a friend', '#eadfc2', '#4a6b30', '#8bb45e');
    put(g, new THREE.BoxGeometry(1.5, 0.62, 0.1), makeToon(C.woodDark), 0, 0.74, 1.6, { rot: [-0.3, 0, 0] });
    put(g, new THREE.PlaneGeometry(1.4, 0.56), toonMap(0xffffff, plaqueTex), 0, 0.75, 1.66,
      { rot: [-0.3, 0, 0], cast: false });

    this.obstacles.push({ x, z, r: 1.7 });
    this.anim.topiary = sway;
  }

  // -------------------------------------------------------- notice board --
  _buildNoticeBoard(scene) {
    const x = -8.6, z = 3.0;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = Math.atan2(-x, 1 - z);
    scene.add(g);

    const wood = makeToon(C.wood), woodD = makeToon(C.woodDark);
    inst(g, new THREE.BoxGeometry(0.17, 2.5, 0.17), woodD,
      [T([-1.15, 1.25, 0]), T([1.15, 1.25, 0])], true, true);
    put(g, new THREE.BoxGeometry(2.7, 1.75, 0.14), woodD, 0, 1.85, 0);
    put(g, new THREE.PlaneGeometry(2.42, 1.5), toonMap(0xffffff, noticeTex()), 0, 1.85, 0.09, { cast: false });
    put(g, new THREE.BoxGeometry(3.1, 0.12, 0.62), wood, 0, 2.84, 0.12, { rot: [0.34, 0, 0] });
    put(g, new THREE.BoxGeometry(0.6, 0.5, 0.5), wood, 0, 0.28, 0.34, { recv: true });

    const papers = [], pdata = [];
    [[-1.02, 0.95], [1.05, 1.15], [-0.9, 2.85]].forEach((s, i) => {
      pdata.push({ x: s[0], y: s[1], phase: i * 1.7 });
      papers.push(T([s[0], s[1], 0.12]));
    });
    const mesh = inst(g, new THREE.PlaneGeometry(0.42, 0.55), makeGlow(0xfffaf0), papers, false, false);
    this.anim.papers = { mesh, data: pdata };

    this.obstacles.push({ x, z, r: 1.1 });
    this.hotspots.push({
      id: 'notice-board',
      position: new THREE.Vector3(x + Math.sin(g.rotation.y) * 1.7, 0, z + Math.cos(g.rotation.y) * 1.7),
      radius: 2.4,
      label: 'Read the Notice Board',
      action: (gm) => {
        gm.toast(NOTICES[this.noticeIdx % NOTICES.length]);
        this.noticeIdx++;
      },
    });
  }

  // ---------------------------------------------------------------- shop --
  _buildShop(scene) {
    const cx = 10.6, cz = -4.8;   // building centre
    const fw = -2.6;              // local x of the west-facing wall
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
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
    put(g, new THREE.PlaneGeometry(1.4, 2.15), glowFade(0xffdca8, 0.85), fw - 0.14, 1.25, 0,
      { rot: [0, -Math.PI / 2, 0], cast: false });
    put(g, new THREE.BoxGeometry(1.1, 0.14, 2.1), makeToon(C.stone), fw - 0.6, 0.09, 0, { recv: true });

    // windows + flower boxes (instanced across both windows)
    const frame = makeToon(C.woodDark);
    const frames = [], glasses = [], boxes = [], dots = [];
    for (const wz of [-2.2, 2.2]) {
      frames.push(T([fw, 2.2, wz]));
      glasses.push(T([fw - 0.12, 2.2, wz], [0, -Math.PI / 2, 0]));
      boxes.push(T([fw - 0.22, 1.34, wz]));
      for (let i = 0; i < 5; i++) dots.push(T([fw - 0.24, 1.56, wz - 0.55 + i * 0.28], null, 0.15));
    }
    inst(g, new THREE.BoxGeometry(0.2, 1.5, 1.7), frame, frames);
    inst(g, new THREE.PlaneGeometry(1.4, 1.24), glowFade(0x9fdcf5, 0.9), glasses, false, false);
    inst(g, new THREE.BoxGeometry(0.42, 0.3, 1.5), makeToon(C.wood), boxes);
    inst(g, new THREE.IcosahedronGeometry(1, 0), makeToon(C.coral), dots, false, false);

    // striped awning with a scalloped valance
    const stripes = stripeTex();
    stripes.wrapS = stripes.wrapT = THREE.RepeatWrapping;
    stripes.repeat.set(1, 7);
    put(g, new THREE.BoxGeometry(1.95, 0.13, 6.6), toonMap(0xffffff, stripes), fw - 0.92, 3.06, 0,
      { rot: [0, 0, 0.3] });
    put(g, new THREE.BoxGeometry(0.16, 0.16, 6.7), frame, fw - 1.83, 2.79, 0, { cast: false });
    const scallop = [];
    for (let i = 0; i < 11; i++) scallop.push(T([fw - 1.86, 2.78, -3.0 + i * 0.6], null, [0.16, 0.3, 0.3]));
    inst(g, new THREE.SphereGeometry(1, 8, 6), makeToon(C.coral), scallop, false, false);

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

    this.obstacles.push(
      { x: cx, z: cz - 2.4, r: 2.2 },
      { x: cx, z: cz, r: 2.2 },
      { x: cx, z: cz + 2.4, r: 2.2 },
      { x: cx + sx, z: cz + sz, r: 1.3 },
    );
    this.hotspots.push({
      id: 'shop',
      position: new THREE.Vector3(7.2, 0, cz),
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
    const planters = [], bushes = [];

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
      boards.push(L([0, 5.0, 0]));
      poles.push(L([0, 5.9, 0]));
      pennants.push(L([0.26, 6.2, 0], [0, 0, -Math.PI / 2]));
      planters.push(L([2.5, 0.28, 0]), L([-2.5, 0.28, 0]));
      bushes.push(L([2.5, 0.74, 0]), L([-2.5, 0.74, 0]));

      // name board, painted on both faces so it reads coming and going
      const signMat = toonMap(0xffffff, woodSignTex(gt.name, ''));
      put(g, planeGeo, signMat, 0, 5.0, 0.09, { cast: false });
      put(g, planeGeo, signMat, 0, 5.0, -0.09, { rot: [0, Math.PI, 0], cast: false });

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
    inst(scene, new THREE.SphereGeometry(0.2, 10, 8), makeGlow(C.lampGlow), lamps, false, false);
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
    put(g, new THREE.BoxGeometry(3.5, 1.25, 0.18), makeToon(0x2b2038), 0, 3.9, -0.05);
    put(g, new THREE.PlaneGeometry(3.32, 1.14), glowMap(neonTex('GROOVE GROTTO')), 0, 3.9, -0.16,
      { rot: [0, Math.PI, 0], cast: false });

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
      { x: -6.9, z: 6.9, r: 3.0 }, { x: -8.6, z: 3.0, r: 3.0 },
      { x: -9.4, z: 6.6, r: 2.4 }, { x: 9.6, z: 5.6, r: 2.4 },
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
    const flies = [], wingsA = [], wingsB = [];
    for (let i = 0; i < 14; i++) {
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
    const wingGeo = new THREE.BoxGeometry(0.34, 0.02, 0.24);
    this.anim.flies = {
      flies,
      meshA: inst(scene, wingGeo, makeGlow(0xffd6e8), wingsA, false, false),
      meshB: inst(scene, wingGeo, makeGlow(0xfff0a8), wingsB, false, false),
    };

    // petals on the breeze
    const petals = [], pdata = [];
    for (let i = 0; i < 26; i++) {
      pdata.push({
        x: -20 + rand() * 40, y: 0.6 + rand() * 3.4, z: -16 + rand() * 32,
        sp: 1.1 + rand() * 1.3, ph: rand() * 6.28, spin: 0.6 + rand() * 1.4,
      });
      petals.push(T([0, -9, 0]));
    }
    this.anim.petals = {
      mesh: inst(scene, new THREE.CircleGeometry(0.11, 5), glowFade(0xffd7e2, 0.95), petals, false, false),
      data: pdata,
    };
  }

  // --------------------------------------------------------------- frame --
  update(dt) {
    const a = this.anim;
    if (!a) return;
    this.t += dt;
    const t = this.t;

    if (a.sea) a.sea.position.y = -1.35 + Math.sin(t * 0.5) * 0.05;
    if (a.foam) {
      a.foam.rotation.z += dt * 0.05;
      a.foam.position.y = -0.95 + Math.sin(t * 0.8) * 0.06;
    }
    if (a.clouds) a.clouds.rotation.y += dt * 0.006;

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

    // lamps breathe
    if (a.lamps) {
      const pts = a.lamps.pts;
      for (let i = 0; i < pts.length; i++) {
        const p = Math.sin(t * 1.6 + i * 1.1);
        _o2.position.set(pts[i][0], 3.28, pts[i][1]);
        _o2.rotation.set(0, 0, 0);
        _o2.scale.setScalar(1 + p * 0.05);
        _o2.updateMatrix();
        a.lamps.globeMesh.setMatrixAt(i, _o2.matrix);
        _o2.scale.setScalar(1 + p * 0.14);
        _o2.updateMatrix();
        a.lamps.haloMesh.setMatrixAt(i, _o2.matrix);
      }
      a.lamps.globeMesh.instanceMatrix.needsUpdate = true;
      a.lamps.haloMesh.instanceMatrix.needsUpdate = true;
    }

    // bunting
    if (a.bunting) {
      for (const f of a.bunting.flagData) {
        const s = Math.sin(t * 2.1 + f.phase) * 0.22;
        _o2.position.set(f.p[0], f.p[1] - 0.2, f.p[2]);
        _o2.rotation.set(Math.PI + s * 0.5, 0, s);
        _o2.scale.setScalar(1);
        _o2.updateMatrix();
        const m = a.bunting.flagMeshes[f.k];
        if (m) m.setMatrixAt(f.i, _o2.matrix);
      }
      for (const m of a.bunting.flagMeshes) if (m) m.instanceMatrix.needsUpdate = true;
    }

    // topiary + pinned papers
    if (a.topiary) {
      a.topiary.rotation.z = Math.sin(t * 0.9) * 0.035;
      a.topiary.rotation.x = Math.sin(t * 0.7 + 1.0) * 0.025;
    }
    if (a.papers) {
      for (let i = 0; i < a.papers.data.length; i++) {
        const p = a.papers.data[i];
        _o2.position.set(p.x, p.y, 0.12);
        _o2.rotation.set(0, Math.sin(t * 2.4 + p.phase) * 0.35, Math.sin(t * 1.7 + p.phase) * 0.12);
        _o2.scale.setScalar(1);
        _o2.updateMatrix();
        a.papers.mesh.setMatrixAt(i, _o2.matrix);
      }
      a.papers.mesh.instanceMatrix.needsUpdate = true;
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

    // drifting petals
    if (a.petals) {
      const d = a.petals.data;
      for (let i = 0; i < d.length; i++) {
        const p = d[i];
        p.x += dt * p.sp;
        if (p.x > 20) {
          p.x = -20;
          p.z += 7.3;
          if (p.z > 16) p.z -= 32;
        }
        _o2.position.set(p.x, p.y + Math.sin(t * 1.4 + p.ph) * 0.5, p.z + Math.sin(t * 0.8 + p.ph) * 1.2);
        _o2.rotation.set(t * p.spin, t * p.spin * 0.7 + p.ph, 0);
        _o2.scale.setScalar(1);
        _o2.updateMatrix();
        a.petals.mesh.setMatrixAt(i, _o2.matrix);
      }
      a.petals.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.anim = null;
    this.groundMeshes = [];
    this.hotspots = [];
    this.obstacles = [];
  }
}
