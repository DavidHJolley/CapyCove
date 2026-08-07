import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { BOT_ZONES } from '../../../shared/constants.js';

/**
 * Driftwood Beach: a golden sand cove with an animated low-poly sea to the
 * west and south, a walkable dock out over the water (Reel Rush lives at the
 * end of it), palms, umbrellas, a sandcastle, crabs and circling gulls.
 *
 * Ground layout is polar around COVE: land where r < shoreR(theta).
 * The BOT_ZONES.beach circle is guaranteed dead flat (see sandY()).
 */

// ---------------------------------------------------------------- geometry math
const TAU = Math.PI * 2;
const CX = 1, CZ = 1;              // cove centre (land radius is measured from here)
const ZONE = BOT_ZONES.beach;      // {x:0, z:2, r:5} - must stay flat + prop free
const WATER_Y = -0.30;
const DECK_Y = 0.62;
const DOCK_Z = -2.4;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Distance from the cove centre to the shoreline at angle `th`.
 *  Minimum value is 8.4 which keeps the whole bot zone (max r 6.42) inland. */
function shoreR(th) {
  return 11.3 + 2.5 * Math.cos(th + 0.45) + 0.4 * Math.sin(3 * th + 0.7);
}

/** Sand height. Flat (0) everywhere inside r=8, so the bot zone is dead flat. */
function sandY(x, z) {
  const dx = x - CX, dz = z - CZ;
  const r = Math.hypot(dx, dz);
  const R = shoreR(Math.atan2(dz, dx));
  const k = clamp01((r - 8) / 3.2);
  let y = k * (0.26 * Math.sin(x * 0.42 + 0.6) * Math.cos(z * 0.38) + 0.18 * Math.sin(z * 0.66 - x * 0.21));
  y += clamp01((r - 9.8) / 3.2) * 1.1;          // back dunes
  const lip = clamp01((r - (R - 1.7)) / 1.7);   // shore slope into the surf
  return y * (1 - lip) - lip * lip * 0.72;
}

// Swell: three crossed sine trains. Amplitude sums to 0.28, which keeps the
// surface above the sand lip (-0.72) and below the dry beach at all times.
const W1A = 0.13, W1K = 0.62, W1S = 1.15;
const W2A = 0.09, W2K = 0.85, W2S = -0.9;
const W3A = 0.06, W3K = 0.40, W3S = 1.9;

/** Sea surface offset at (x,z) and time t. Shared by water, foam, boat, floats. */
function waveY(x, z, t) {
  return W1A * Math.sin(x * W1K + t * W1S)
    + W2A * Math.sin(z * W2K + t * W2S)
    + W3A * Math.sin((x + z) * W3K + t * W3S);
}

/** Pull a point inland so props never end up standing in the surf. */
function toLand(x, z, margin = 2.2) {
  let dx = x - CX, dz = z - CZ;
  const r = Math.hypot(dx, dz) || 1e-4;
  const max = shoreR(Math.atan2(dz, dx)) - margin;
  if (r > max) { const s = max / r; dx *= s; dz *= s; }
  return { x: CX + dx, z: CZ + dz };
}

/** Push a point out of the guaranteed-walkable bot circle. */
function outOfZone(x, z, clear) {
  const dx = x - ZONE.x, dz = z - ZONE.z;
  const d = Math.hypot(dx, dz) || 1e-4;
  const need = ZONE.r + clear;
  if (d >= need) return { x, z };
  return { x: ZONE.x + (dx / d) * need, z: ZONE.z + (dz / d) * need };
}

/** Final prop placement: clear of the bot circle, clear of the water. */
function spot(x, z, clear = 0.9, margin = 2.2) {
  const a = outOfZone(x, z, clear);
  return toLand(a.x, a.z, margin);
}

// ---------------------------------------------------------------- scratch
const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s3 = new THREE.Vector3(1, 1, 1);
const _eu = new THREE.Euler(0, 0, 0, 'YXZ');
const _col = new THREE.Color();

function instAt(mesh, i, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _eu.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_eu);
  _v3.set(x, y, z);
  _s3.set(sx, sy, sz);
  mesh.setMatrixAt(i, _m4.compose(_v3, _q, _s3));
}

/** Transform a throwaway geometry in place (used for merging). */
function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _eu.set(rx, ry, rz, 'YXZ');
  g.applyMatrix4(_m4.compose(_v3.set(x, y, z), _q.setFromEuler(_eu), _s3.set(sx, sy, sz)));
  return g;
}

/**
 * Merge throwaway geometries into one buffer, optionally baking a per-part
 * colour into a vertex-colour attribute. Lets a whole prop cluster (sandcastle,
 * rod rack, beach clutter) render as a single draw call.
 * parts: [{ g, c }] - c is an sRGB hex, omitted means white.
 */
function merge(parts) {
  const src = parts.map((p) => (p.g.index ? p.g.toNonIndexed() : p.g));
  let n = 0;
  for (const g of src) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (let i = 0; i < src.length; i++) {
    const g = src[i];
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    _col.set(parts[i].c ?? 0xffffff);
    for (let k = 0; k < c; k++) {
      col[(o + k) * 3] = _col.r; col[(o + k) * 3 + 1] = _col.g; col[(o + k) * 3 + 2] = _col.b;
    }
    o += c;
  }
  for (const p of parts) p.g.dispose();
  for (const g of src) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Toon material carrying a canvas texture (always unique so it gets disposed). */
function toonTex(color, tex, extra = {}) {
  const m = makeToon(color, { unique: true, ...extra });
  m.map = tex;
  m.needsUpdate = true;
  return m;
}

/** Unlit material carrying a canvas texture. */
function glowTex(color, tex, extra = {}) {
  const m = makeGlow(color, { unique: true });
  m.map = tex;
  Object.assign(m, extra);
  m.needsUpdate = true;
  return m;
}

/** Quad strip that follows the shoreline. inner/outer return {x,y,z} rel. to cove. */
function shoreRibbon(seg, inner, outer, uRepeat = 9) {
  const count = (seg + 1) * 2;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const idx = new Uint16Array(seg * 6);
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * TAU;
    const a = inner(th), b = outer(th);
    const k = i * 2;
    pos[k * 3] = a.x; pos[k * 3 + 1] = a.y; pos[k * 3 + 2] = a.z;
    pos[k * 3 + 3] = b.x; pos[k * 3 + 4] = b.y; pos[k * 3 + 5] = b.z;
    const u = (i / seg) * uRepeat;
    uv[k * 2] = u; uv[k * 2 + 1] = 1;
    uv[k * 2 + 2] = u; uv[k * 2 + 3] = 0;
    if (i < seg) {
      const o = i * 6;
      idx[o] = k; idx[o + 1] = k + 2; idx[o + 2] = k + 1;
      idx[o + 3] = k + 1; idx[o + 4] = k + 2; idx[o + 5] = k + 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- canvas art
function texSand() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#f2dca6'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 1100; i++) {
      const s = Math.random() * 1.7 + 0.4;
      c.fillStyle = Math.random() < 0.5 ? 'rgba(212,180,122,0.45)' : 'rgba(255,247,219,0.5)';
      c.fillRect(Math.random() * w, Math.random() * h, s, s);
    }
    const k = (Math.PI * 4) / w;
    c.lineWidth = 1.3;
    for (let i = 0; i < 7; i++) {
      c.strokeStyle = 'rgba(203,169,111,0.3)';
      c.beginPath();
      const y0 = i * (h / 7) + 5;
      c.moveTo(0, y0 + Math.sin(i) * 3);
      for (let x = 0; x <= w; x += 6) c.lineTo(x, y0 + Math.sin(x * k + i) * 3);
      c.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texPlanks(rx, ry) {
  const t = canvasTexture(256, 128, (c, w, h) => {
    const rows = 4, rh = h / rows;
    const shades = ['#c99a5f', '#bd8b50', '#d2a26b', '#c19158'];
    for (let r = 0; r < rows; r++) {
      c.fillStyle = shades[r % 4];
      c.fillRect(0, r * rh, w, rh);
      c.strokeStyle = 'rgba(118,78,40,0.22)'; c.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        const y = r * rh + 4 + Math.random() * (rh - 8);
        c.beginPath(); c.moveTo(0, y);
        for (let x = 0; x <= w; x += 16) c.lineTo(x, y + Math.sin(x * 0.05 + i) * 1.1);
        c.stroke();
      }
      c.fillStyle = 'rgba(86,54,28,0.55)'; c.fillRect(0, r * rh, w, 2);
      c.fillStyle = 'rgba(72,46,26,0.45)';
      for (const nx of [12, w * 0.5 - 6, w - 16]) {
        c.beginPath(); c.arc(nx, r * rh + rh * 0.5, 2.2, 0, TAU); c.fill();
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

function texBark() {
  const t = canvasTexture(64, 128, (c, w, h) => {
    c.fillStyle = '#b0804f'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) {
      const y = (i / 16) * h;
      c.fillStyle = i % 2 ? 'rgba(140,98,58,0.5)' : 'rgba(206,164,110,0.4)';
      c.fillRect(0, y, w, h / 32);
    }
    for (let i = 0; i < 220; i++) {
      c.fillStyle = 'rgba(122,86,50,0.35)';
      c.fillRect(Math.random() * w, Math.random() * h, 2, 1.5);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texStripes(a, b, bands) {
  const t = canvasTexture(128, 16, (c, w, h) => {
    const bw = w / bands;
    for (let i = 0; i < bands; i++) {
      c.fillStyle = i % 2 ? a : b;
      c.fillRect(i * bw, 0, bw + 1, h);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texTowel(a, b) {
  const t = canvasTexture(64, 64, (c, w, h) => {
    c.fillStyle = a; c.fillRect(0, 0, w, h);
    c.fillStyle = b;
    for (let i = 0; i < 4; i++) c.fillRect(0, i * 16 + 4, w, 7);
    c.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 4; i++) c.fillRect(0, i * 16 + 12, w, 2);
  });
  return t;
}

function texBall() {
  return canvasTexture(128, 64, (c, w, h) => {
    const cols = ['#fff1d6', '#e8657a', '#fff1d6', '#4fb3e8', '#fff1d6', '#f2b64a'];
    const bw = w / cols.length;
    for (let i = 0; i < cols.length; i++) { c.fillStyle = cols[i]; c.fillRect(i * bw, 0, bw + 1, h); }
  });
}

function texFoam() {
  return canvasTexture(256, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      c.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.5})`;
      c.beginPath(); c.arc(x, y, 2 + Math.random() * 7, 0, TAU); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgba(255,255,255,0.85)';
    for (let i = 0; i < 40; i++) {
      c.beginPath(); c.arc(Math.random() * w, h * (0.4 + Math.random() * 0.3), 1 + Math.random() * 3, 0, TAU); c.fill();
    }
  });
}

function texWet() {
  return canvasTexture(16, 64, (c, w, h) => {
    // uv.y 1 = inland edge (canvas top), uv.y 0 = water edge (canvas bottom)
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(190,156,102,0)');
    g.addColorStop(0.45, 'rgba(168,133,84,0.4)');
    g.addColorStop(1, 'rgba(146,112,66,0.66)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
}

function texPath() {
  const t = canvasTexture(64, 64, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(214,176,116,0)');
    g.addColorStop(0.25, 'rgba(222,187,127,0.7)');
    g.addColorStop(0.5, 'rgba(228,196,139,0.85)');
    g.addColorStop(0.75, 'rgba(222,187,127,0.7)');
    g.addColorStop(1, 'rgba(214,176,116,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      c.fillStyle = `rgba(180,146,96,${0.2 + Math.random() * 0.3})`;
      const y = 10 + Math.random() * (h - 20);
      c.beginPath(); c.arc(Math.random() * w, y, 0.8 + Math.random() * 1.8, 0, TAU); c.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function texGlint() {
  return canvasTexture(64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,246,214,0.55)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    c.fillStyle = g; c.beginPath(); c.arc(32, 32, 30, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2.5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(4, 32); c.lineTo(60, 32); c.moveTo(32, 6); c.lineTo(32, 58); c.stroke();
  });
}

function texSky() {
  return canvasTexture(16, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3f9fd8');
    g.addColorStop(0.34, '#7cc8ea');
    g.addColorStop(0.62, '#bfe3ef');
    g.addColorStop(0.83, '#ffd9a0');
    g.addColorStop(1, '#f6dcae');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
}

function texSign(title, sub, accent) {
  return canvasTexture(512, 128, (c, w, h) => {
    c.fillStyle = '#d9a662'; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(150,102,54,0.35)';
    for (let i = 0; i < 5; i++) c.fillRect(0, 8 + i * 26, w, 3);
    c.strokeStyle = '#a3703c'; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 54px Georgia, "Times New Roman", serif';
    c.lineWidth = 8; c.strokeStyle = '#fff3d8';
    c.strokeText(title, w / 2, sub ? 52 : h / 2);
    c.fillStyle = accent;
    c.fillText(title, w / 2, sub ? 52 : h / 2);
    if (sub) {
      c.font = 'bold 26px Georgia, "Times New Roman", serif';
      c.lineWidth = 5; c.strokeStyle = '#fff3d8';
      c.strokeText(sub, w / 2, 96);
      c.fillStyle = '#6b4526';
      c.fillText(sub, w / 2, 96);
    }
  });
}

// ---------------------------------------------------------------- the room
export class BeachRoom extends Room {
  id = 'beach';
  name = 'Driftwood Beach';

  build(scene, game) {
    this.t = Math.random() * 40;
    this.anim = {
      fronds: [], crabs: [], gulls: [], boats: [], clouds: [], torches: [],
      floats: [], glints: [], umbrellas: [],
    };

    scene.background = new THREE.Color(0xf3d9ac);
    scene.fog = new THREE.Fog(0xf6dcae, 42, 150);

    this._buildLight(scene);
    this._buildSky(scene);
    this._buildSand(scene);
    this._buildSea(scene);
    this._buildDock(scene);
    this._buildBoat(scene);
    this._buildPalms(scene);
    this._buildBeachStuff(scene);
    this._buildCritters(scene);
    this._buildExit(scene);

    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4),
      from_plaza: new THREE.Vector3(6.5, 0, 2), // open sand, unoccluded from the room camera
    };
    // gentle east bias: keeps the cove and dock in frame even at the eastern
    // from_plaza spawn (a stronger offset framed mostly open sea there)
    this.cameraHint = { offset: new THREE.Vector3(3.5, 13, 16), lookHeight: 1.1 };
    // static camera: the whole cove, the dock out to the fishing spot, the plaza gate
    this.staticCamera = { position: new THREE.Vector3(0, 20, 29), lookAt: new THREE.Vector3(0, 1, -1.5) };

    scene.updateMatrixWorld(true); // ground raycasts happen before the first render
  }

  // ---- lighting ------------------------------------------------------------
  _buildLight(scene) {
    scene.add(new THREE.HemisphereLight(0xffe9c4, 0xc89f68, 1.15));
    scene.add(new THREE.AmbientLight(0xffd9a8, 0.35));

    const sun = new THREE.DirectionalLight(0xffdaa0, 2.1);
    sun.position.set(-30, 16, -14); // low, from the west
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    const sc = sun.shadow.camera;
    sc.left = -24; sc.right = 24; sc.top = 24; sc.bottom = -24;
    sc.near = 1; sc.far = 90;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);
    sun.target.position.set(-2, 0, 0);
  }

  // ---- sky, sun, clouds ----------------------------------------------------
  _buildSky(scene) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(170, 32, 18, 0, TAU, 0, Math.PI * 0.58),
      glowTex(0xffffff, texSky(), { side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    dome.renderOrder = -10;
    scene.add(dome);

    // low western sun + halos
    const sunPos = new THREE.Vector3(-124, 20, -44);
    for (const [r, c, o] of [[26, 0xffca7a, 0.16], [15, 0xffdc9c, 0.3], [7.4, 0xfff3d2, 1]]) {
      const m = makeGlow(c, { unique: true });
      m.fog = false; m.depthWrite = false;
      if (o < 1) { m.transparent = true; m.opacity = o; m.blending = THREE.AdditiveBlending; }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 28), m);
      disc.position.copy(sunPos);
      disc.lookAt(0, 6, 0);
      disc.renderOrder = -9;
      scene.add(disc);
    }

    const cloudMat = makeToon(0xfff6e4, { unique: true, fog: false });
    for (let i = 0; i < 5; i++) {
      const parts = [];
      const n = 4 + (i % 3);
      for (let j = 0; j < n; j++) {
        parts.push({
          g: xf(new THREE.SphereGeometry(1, 8, 6),
            (j - n / 2) * 1.5 + Math.sin(j * 3 + i) * 0.4, Math.sin(j * 2.1 + i) * 0.35, Math.cos(j * 1.7) * 0.9,
            0, 0, 0, 2.1 + Math.sin(j + i) * 0.6, 1.1, 1.5),
        });
      }
      const cloud = new THREE.Mesh(merge(parts), cloudMat);
      cloud.position.set(-60 + i * 32, 26 + (i % 3) * 5, -70 + ((i * 37) % 90));
      cloud.scale.setScalar(2.4 + (i % 3) * 0.7);
      cloud.renderOrder = -8;
      scene.add(cloud);
      this.anim.clouds.push(cloud);
    }
  }

  // ---- sand ---------------------------------------------------------------
  _buildSand(scene) {
    const SEG = 76, RINGS = 22;
    const vCount = (SEG + 1) * (RINGS + 1);
    const pos = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx = new Uint16Array(SEG * RINGS * 6);
    let ii = 0;
    for (let j = 0; j <= RINGS; j++) {
      const rf = j / RINGS;
      for (let i = 0; i <= SEG; i++) {
        const th = (i / SEG) * TAU;
        const r = shoreR(th) * rf;
        const x = CX + Math.cos(th) * r;
        const z = CZ + Math.sin(th) * r;
        const k = j * (SEG + 1) + i;
        pos[k * 3] = x; pos[k * 3 + 1] = sandY(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = x / 6; uv[k * 2 + 1] = z / 6;
      }
    }
    for (let j = 0; j < RINGS; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * (SEG + 1) + i;
        const b = (j + 1) * (SEG + 1) + i;
        idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = a + 1; idx[ii++] = b + 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();

    const sand = new THREE.Mesh(g, toonTex(0xffffff, texSand()));
    sand.receiveShadow = true;
    scene.add(sand);
    this.groundMeshes = [sand];

    // packed-sand path out to the plaza exit
    // stops short of the shoreline (land runs out around r=13.7 from the cove centre)
    const pts = [[13.2, 3.4], [11.9, 3.0], [9.8, 2.9], [7.4, 3.4], [4.6, 4.1], [2.0, 4.4], [0.2, 4.0]];
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const N = 46;
    const pp = new Float32Array((N + 1) * 2 * 3);
    const pu = new Float32Array((N + 1) * 2 * 2);
    const pi = new Uint16Array(N * 6);
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = curve.getPointAt(u);
      const tg = curve.getTangentAt(u);
      const nx = -tg.z, nz = tg.x;
      const hw = 1.5 - Math.cos(u * Math.PI) * 0.25;
      const k = i * 2;
      for (let s = 0; s < 2; s++) {
        const sgn = s ? 1 : -1;
        const x = p.x + nx * hw * sgn, z = p.z + nz * hw * sgn;
        pp[(k + s) * 3] = x; pp[(k + s) * 3 + 1] = sandY(x, z) + 0.035; pp[(k + s) * 3 + 2] = z;
        pu[(k + s) * 2] = u * 7; pu[(k + s) * 2 + 1] = s;
      }
      if (i < N) {
        // wound so the decal faces up (the strip's +normal side is vertex k+1)
        const o = i * 6;
        pi[o] = k; pi[o + 1] = k + 1; pi[o + 2] = k + 2;
        pi[o + 3] = k + 1; pi[o + 4] = k + 3; pi[o + 5] = k + 2;
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    pg.setAttribute('uv', new THREE.BufferAttribute(pu, 2));
    pg.setIndex(new THREE.BufferAttribute(pi, 1));
    pg.computeVertexNormals();
    const path = new THREE.Mesh(pg, glowTex(0xffffff, texPath(), {
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
    }));
    path.renderOrder = 1;
    scene.add(path);
  }

  // ---- sea, foam, glints, horizon -----------------------------------------
  _buildSea(scene) {
    // deep water out to the horizon
    const deep = new THREE.Mesh(new THREE.CircleGeometry(160, 40), makeToon(0x2b7fb8));
    deep.rotation.x = -Math.PI / 2;
    deep.position.y = -0.9;
    scene.add(deep);

    // Animated swell (NOT walkable). MeshToonMaterial has no flatShading, so
    // update() rewrites analytic normals each frame; the toon ramp then bands
    // the wave faces, which is the look we want anyway.
    const WSEG = 40, WSIZE = 62;
    const wg = new THREE.PlaneGeometry(WSIZE, WSIZE, WSEG, WSEG);
    const water = new THREE.Mesh(wg, makeToon(0x3ba7dd, { unique: true }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(-3, WATER_Y, 3);
    water.frustumCulled = false;
    scene.add(water);
    const wp = wg.attributes.position;
    const wx = new Float32Array(wp.count), wz = new Float32Array(wp.count);
    for (let i = 0; i < wp.count; i++) {
      wx[i] = wp.getX(i) + water.position.x;
      wz[i] = water.position.z - wp.getY(i);
    }
    this.anim.water = water; this.anim.wx = wx; this.anim.wz = wz;

    // wet sand band
    const wet = new THREE.Mesh(
      shoreRibbon(84,
        (th) => { const r = shoreR(th) - 2.6; const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r; return { x: x - CX, y: sandY(x, z) + 0.02, z: z - CZ }; },
        (th) => { const r = shoreR(th) + 0.3; const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r; return { x: x - CX, y: sandY(x, z) + 0.02, z: z - CZ }; }, 1),
      glowTex(0xffffff, texWet(), { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    wet.position.set(CX, 0, CZ);
    wet.renderOrder = 2;
    scene.add(wet);

    // animated foam line
    const foam = new THREE.Mesh(
      shoreRibbon(96,
        (th) => { const r = shoreR(th) - 1.35; const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r; return { x: x - CX, y: sandY(x, z) + 0.05, z: z - CZ }; },
        (th) => { const r = shoreR(th) + 0.85; return { x: Math.cos(th) * r, y: 0, z: Math.sin(th) * r }; }, 11),
      glowTex(0xffffff, (() => { const t = texFoam(); t.wrapS = THREE.RepeatWrapping; return t; })(), {
        transparent: true, depthWrite: false, opacity: 0.9,
      }),
    );
    foam.position.set(CX, 0, CZ);
    foam.renderOrder = 3;
    scene.add(foam);
    this.anim.foam = foam;
    this.anim.foamOuter = [];
    const fp = foam.geometry.attributes.position;
    for (let i = 1; i < fp.count; i += 2) this.anim.foamOuter.push(i);

    // sun glints
    const gg = new THREE.PlaneGeometry(0.6, 0.6);
    gg.rotateX(-Math.PI / 2);
    const glints = new THREE.InstancedMesh(gg, glowTex(0xffffff, texGlint(), {
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }), 54);
    glints.frustumCulled = false;
    scene.add(glints);
    for (let i = 0; i < 54; i++) {
      let x, z, tries = 0;
      do {
        // bias the scatter along the glitter path toward the sun (west-north-west)
        const along = -4 - Math.random() * 26;
        const across = (Math.random() - 0.5) * (i % 3 === 0 ? 30 : 9);
        x = along * 0.94 - across * 0.34;
        z = along * 0.34 + across * 0.94 + 2;
        tries++;
      } while (tries < 10 && Math.hypot(x - CX, z - CZ) < shoreR(Math.atan2(z - CZ, x - CX)) + 1.2);
      const th = Math.atan2(z - CZ, x - CX);
      const rr = Math.hypot(x - CX, z - CZ);
      const minR = shoreR(th) + 1.4;
      if (rr < minR) { x = CX + Math.cos(th) * minR; z = CZ + Math.sin(th) * minR; }
      this.anim.glints.push({ x, z, ph: Math.random() * TAU, sp: 0.7 + Math.random() * 1.4, sc: 0.55 + Math.random() * 0.9 });
    }
    this.anim.glintMesh = glints;

    // horizon islands (single merged silhouette)
    const isl = [];
    for (const [x, z, r, h] of [[-78, -46, 22, 11], [-104, 8, 15, 7], [-62, 52, 26, 13], [-40, -74, 12, 6]]) {
      isl.push({ g: xf(new THREE.ConeGeometry(r, h, 7, 1), x, h * 0.42 - 0.6, z), c: 0x6f97a6 });
      isl.push({ g: xf(new THREE.ConeGeometry(r * 0.55, h * 0.7, 6, 1), x + r * 0.5, h * 0.3 - 0.6, z + r * 0.3), c: 0x7ea5b0 });
    }
    const islands = new THREE.Mesh(merge(isl), makeToon(0xffffff, { unique: true, vertexColors: true }));
    scene.add(islands);

    // distant sailboats
    for (const [x, z, s, sp] of [[-46, -22, 3.2, 0.32], [-64, 26, 4.0, 0.22]]) {
      const b = new THREE.Group();
      const hull = [];
      hull.push({ g: xf(new THREE.BoxGeometry(2.6, 0.42, 0.9), 0, 0, 0), c: 0xf2ede0 });
      hull.push({ g: xf(new THREE.ConeGeometry(0.45, 1.1, 4), 1.55, 0, 0, 0, 0, -Math.PI / 2, 1, 1, 0.9), c: 0xf2ede0 });
      hull.push({ g: xf(new THREE.BoxGeometry(2.4, 0.16, 0.7), 0, 0.24, 0), c: 0xe8657a });
      hull.push({ g: xf(new THREE.CylinderGeometry(0.07, 0.09, 3.6, 6), -0.1, 1.9, 0), c: 0xd8c39a });
      b.add(new THREE.Mesh(merge(hull), makeToon(0xffffff, { unique: true, vertexColors: true })));
      const sail = [];
      const s1 = new THREE.PlaneGeometry(1.9, 3.0, 1, 1);
      sail.push({ g: xf(s1, 0.85, 1.9, 0, 0, Math.PI / 2, 0) });
      const s2 = new THREE.PlaneGeometry(1.1, 2.0, 1, 1);
      sail.push({ g: xf(s2, -0.75, 1.4, 0, 0, Math.PI / 2, 0) });
      b.add(new THREE.Mesh(merge(sail), makeToon(0xfffaf0, { unique: true, side: THREE.DoubleSide })));
      b.position.set(x, 0.2, z);
      b.scale.setScalar(s);
      b.rotation.y = 0.7;
      scene.add(b);
      this.anim.boats.push({ obj: b, sp, ph: Math.random() * TAU });
    }
  }

  // ---- dock + fishing station ---------------------------------------------
  _buildDock(scene) {
    const deckSideMat = makeToon(0xb98a52);
    const deckTopMat = toonTex(0xffffff, texPlanks(7, 2));
    const platTopMat = toonTex(0xffffff, texPlanks(3, 3));
    const mats = (top) => [deckSideMat, deckSideMat, top, deckSideMat, deckSideMat, deckSideMat];

    // main run: x from -16.6 (platform) to -6.2 (ramp head)
    const deck = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.28, 3.0), mats(deckTopMat));
    deck.position.set(-11.4, DECK_Y - 0.14, DOCK_Z);
    deck.castShadow = true; deck.receiveShadow = true;
    scene.add(deck);

    // end platform
    const plat = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.28, 4.6), mats(platTopMat));
    plat.position.set(-18.4, DECK_Y - 0.14, DOCK_Z);
    plat.castShadow = true; plat.receiveShadow = true;
    scene.add(plat);

    // Sand ramp. Its top face runs A->B exactly: A is sunk below the sand so the
    // sand/ramp join is seamless, B lands flush on the deck's east edge.
    const ax = -4.15, ay = -0.14, bx = -6.22, by = DECK_Y;
    const len = Math.hypot(bx - ax, by - ay);
    const ang = -Math.atan2(by - ay, ax - bx);
    const th = 0.3;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(len, th, 2.7), mats(toonTex(0xffffff, texPlanks(3, 1))));
    ramp.position.set(
      (ax + bx) / 2 - Math.sin(-ang) * th * 0.5,
      (ay + by) / 2 - Math.cos(ang) * th * 0.5,
      DOCK_Z,
    );
    ramp.rotation.z = ang;
    ramp.receiveShadow = true;
    scene.add(ramp);

    this.groundMeshes.push(deck, plat, ramp);

    // pilings
    const postG = new THREE.CylinderGeometry(0.17, 0.2, 3.0, 7);
    const posts = new THREE.InstancedMesh(postG, makeToon(0x7d5734), 22);
    posts.castShadow = true;
    let n = 0;
    for (const x of [-7.0, -9.3, -11.6, -13.9, -16.2, -17.4, -19.4, -20.4]) {
      for (const dz of [-1.35, 1.35]) {
        if (n >= 22) break;
        const zz = DOCK_Z + dz * (x < -16.4 ? 1.65 : 1);
        instAt(posts, n++, x, DECK_Y - 1.5 + Math.sin(x) * 0.05, zz,
          Math.random() * TAU, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.05, 1, 1, 1);
      }
    }
    posts.count = n;
    scene.add(posts);

    // cross braces
    const braceG = new THREE.BoxGeometry(0.14, 0.14, 3.1);
    const braces = new THREE.InstancedMesh(braceG, makeToon(0x8b6039), 8);
    let bn = 0;
    for (const x of [-9.3, -13.9, -17.4, -20.4]) {
      instAt(braces, bn++, x, DECK_Y - 0.75, DOCK_Z, 0, 0, 0, 1, 1, x < -16.4 ? 1.6 : 1);
      instAt(braces, bn++, x, DECK_Y - 1.45, DOCK_Z, 0, 0, 0, 1, 1, x < -16.4 ? 1.6 : 1);
    }
    braces.count = bn;
    scene.add(braces);

    this._buildFishing(scene);
  }

  _buildFishing(scene) {
    const woodMat = makeToon(0xffffff, { unique: true, vertexColors: true });
    const parts = [];
    const P = (g, c) => parts.push({ g, c });

    // gateway sign frame at the mouth of the platform
    for (const z of [DOCK_Z - 2.1, DOCK_Z + 2.1]) {
      P(xf(new THREE.CylinderGeometry(0.13, 0.16, 3.0, 7), -16.5, DECK_Y + 1.5, z), 0x8b6039);
      P(xf(new THREE.BoxGeometry(0.34, 0.34, 0.34), -16.5, DECK_Y + 3.02, z), 0xc98f52);
    }
    P(xf(new THREE.BoxGeometry(0.22, 1.05, 4.5), -16.5, DECK_Y + 2.35, DOCK_Z), 0xa87844);

    // rod rack (A-frame + rods)
    const rackX = -19.9, rackZ = DOCK_Z;
    for (const dz of [-1.2, 1.2]) {
      P(xf(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6), rackX, DECK_Y + 0.6, rackZ + dz, 0, 0, 0.42), 0x9a6c3e);
      P(xf(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6), rackX, DECK_Y + 0.6, rackZ + dz, 0, 0, -0.42), 0x9a6c3e);
    }
    P(xf(new THREE.CylinderGeometry(0.06, 0.06, 2.7, 6), rackX, DECK_Y + 1.12, rackZ, Math.PI / 2, 0, 0), 0xb07c47);
    const rodTips = [];
    for (let i = 0; i < 5; i++) {
      const z = rackZ - 1.0 + i * 0.5;
      // rz > 0 leans the rod tip out west, over the water
      P(xf(new THREE.CylinderGeometry(0.018, 0.045, 2.9, 5), rackX + 0.55, DECK_Y + 1.35, z, 0, 0.1 * (i - 2), 0.44), 0x53381f);
      P(xf(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 8), rackX + 0.34, DECK_Y + 1.0, z, Math.PI / 2, 0, 0), [0xe8657a, 0x4fb3e8, 0xf2b64a, 0x7ac74f, 0xe8657a][i]);
      rodTips.push(new THREE.Vector3(rackX + 0.55 - 1.45 * Math.sin(0.44), DECK_Y + 1.35 + 1.45 * Math.cos(0.44), z));
    }

    // bait bucket, crate of fish, coiled rope, tackle box
    P(xf(new THREE.CylinderGeometry(0.34, 0.28, 0.5, 10), -17.6, DECK_Y + 0.25, DOCK_Z + 1.6), 0x4fb3e8);
    P(xf(new THREE.TorusGeometry(0.34, 0.04, 5, 12), -17.6, DECK_Y + 0.5, DOCK_Z + 1.6, Math.PI / 2, 0, 0), 0xdfe9ef);
    P(xf(new THREE.BoxGeometry(0.9, 0.6, 0.7), -19.4, DECK_Y + 0.3, DOCK_Z + 1.5), 0xb98a52);
    P(xf(new THREE.BoxGeometry(0.94, 0.1, 0.74), -19.4, DECK_Y + 0.62, DOCK_Z + 1.5), 0x8b6039);
    for (let i = 0; i < 3; i++) {
      P(xf(new THREE.SphereGeometry(0.15, 8, 6), -19.4 + (i - 1) * 0.26, DECK_Y + 0.72, DOCK_Z + 1.5, 0, 0.4 * i, 0, 1.7, 0.85, 0.7), 0xb9d7e8);
      P(xf(new THREE.ConeGeometry(0.12, 0.22, 4), -19.4 + (i - 1) * 0.26 - 0.3, DECK_Y + 0.72, DOCK_Z + 1.5, 0, 0, Math.PI / 2, 1, 1, 0.5), 0x9cc4da);
    }
    for (let i = 0; i < 3; i++) {
      P(xf(new THREE.TorusGeometry(0.36 - i * 0.06, 0.055, 5, 14), -17.4, DECK_Y + 0.06 + i * 0.1, DOCK_Z - 1.5, Math.PI / 2, 0, 0), 0xd9c08c);
    }
    P(xf(new THREE.BoxGeometry(0.62, 0.34, 0.42), -18.9, DECK_Y + 0.17, DOCK_Z - 1.7), 0xe8657a);

    // rope railing posts along the platform edge
    const railPts = [];
    for (const [x, z] of [[-16.6, -4.5], [-18.4, -4.6], [-20.3, -4.5], [-20.4, -2.4], [-20.3, -0.3], [-18.4, -0.2], [-16.6, -0.3]]) {
      P(xf(new THREE.CylinderGeometry(0.075, 0.085, 0.95, 6), x, DECK_Y + 0.44, z), 0x8b6039);
      P(xf(new THREE.SphereGeometry(0.1, 7, 5), x, DECK_Y + 0.92, z), 0xc98f52);
      railPts.push(new THREE.Vector3(x, DECK_Y + 0.78, z));
    }
    scene.add(Object.assign(new THREE.Mesh(merge(parts), woodMat), { castShadow: true, receiveShadow: true }));

    // sagging ropes between rail posts
    const ropeParts = [];
    for (let i = 0; i < railPts.length - 1; i++) {
      const a = railPts[i], b = railPts[i + 1];
      const mid = a.clone().lerp(b, 0.5); mid.y -= 0.18;
      const curve = new THREE.CatmullRomCurve3([a, mid, b]);
      ropeParts.push({ g: new THREE.TubeGeometry(curve, 6, 0.035, 4, false), c: 0xe4cd99 });
    }
    scene.add(new THREE.Mesh(merge(ropeParts), makeToon(0xffffff, { unique: true, vertexColors: true })));

    // signboards (front reads east, back reads west - neither is mirrored)
    const signTex = texSign('REEL RUSH', 'cast off at the rail', '#e8657a');
    const signTex2 = texSign('REEL RUSH', 'biggest catch wins coins', '#e8657a');
    for (const [ry, tex, off] of [[Math.PI / 2, signTex, 0.13], [-Math.PI / 2, signTex2, -0.13]]) {
      // unlit so the lettering reads even with the sun behind the board
      const s = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.92), glowTex(0xf7ead2, tex));
      s.position.set(-16.5 + off, DECK_Y + 2.35, DOCK_Z);
      s.rotation.y = ry;
      scene.add(s);
    }

    // lantern on the rail + warm fill light
    const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.5, 6), makeToon(0x7d5734));
    lampPost.position.set(-20.4, DECK_Y + 0.75, DOCK_Z);
    scene.add(lampPost);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.34), makeGlow(0xffd47a, { unique: true }));
    lamp.position.set(-20.4, DECK_Y + 1.62, DOCK_Z);
    scene.add(lamp);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.22, 4), makeToon(0x6d4a2b));
    cap.position.set(-20.4, DECK_Y + 1.93, DOCK_Z);
    cap.rotation.y = Math.PI / 4;
    scene.add(cap);
    const lampLight = new THREE.PointLight(0xffbe6a, 9, 10, 2);
    lampLight.position.set(-20.4, DECK_Y + 1.7, DOCK_Z);
    scene.add(lampLight);
    this.anim.lamp = lamp;
    this.anim.lampLight = lampLight;

    // cast lines running from the rod tips out to bobbing floats
    const floatG = merge([
      { g: new THREE.SphereGeometry(0.13, 8, 6), c: 0xe8657a },
      { g: xf(new THREE.SphereGeometry(0.132, 8, 4, 0, TAU, 0, Math.PI / 2), 0, 0.002, 0), c: 0xfff1d6 },
    ]);
    const floats = new THREE.InstancedMesh(floatG, makeToon(0xffffff, { unique: true, vertexColors: true }), 4);
    const lineParts = [];
    for (let i = 0; i < 4; i++) {
      const fx = -21.5 - i * 0.5, fz = DOCK_Z - 1.2 + i * 0.8;
      this.anim.floats.push({ x: fx, z: fz });
      const tip = rodTips[i];
      lineParts.push({
        g: new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
          tip,
          new THREE.Vector3((tip.x + fx) / 2, (tip.y + WATER_Y) / 2 - 0.15, (tip.z + fz) / 2),
          new THREE.Vector3(fx, WATER_Y + 0.05, fz),
        ]), 8, 0.014, 3, false),
        c: 0xfbf6e4,
      });
    }
    scene.add(new THREE.Mesh(merge(lineParts), makeToon(0xffffff, { unique: true, vertexColors: true })));
    floats.frustumCulled = false;
    scene.add(floats);
    this.anim.floatMesh = floats;

    this.hotspots.push({
      id: 'play-fishing',
      position: new THREE.Vector3(-18.4, DECK_Y + 0.3, DOCK_Z),
      radius: 3.2,
      label: 'Play Reel Rush',
      action: (g) => g.startMinigame('fishing'),
    });

    this.obstacles.push({ x: -19.9, z: DOCK_Z, r: 0.9 }, { x: -17.6, z: DOCK_Z + 1.6, r: 0.5 });
  }

  // ---- moored rowboat ------------------------------------------------------
  _buildBoat(scene) {
    const boat = new THREE.Group();
    const prof = [
      [0.02, 0.00], [0.34, 0.03], [0.64, 0.14], [0.85, 0.36], [0.96, 0.62], [1.00, 0.80],
      [0.93, 0.81], [0.87, 0.63], [0.76, 0.38], [0.55, 0.16], [0.02, 0.11],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const hull = new THREE.Mesh(new THREE.LatheGeometry(prof, 16), makeToon(0xfaeeda));
    hull.scale.set(2.35, 1, 1);
    hull.castShadow = true;
    boat.add(hull);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.075, 6, 22), makeToon(0xe8657a));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.79;
    rim.scale.set(2.35, 1, 1);
    boat.add(rim);

    const kit = [];
    kit.push({ g: xf(new THREE.BoxGeometry(0.5, 0.08, 1.5), -0.85, 0.6, 0), c: 0xc08b4f });
    kit.push({ g: xf(new THREE.BoxGeometry(0.5, 0.08, 1.7), 0.55, 0.6, 0), c: 0xc08b4f });
    kit.push({ g: xf(new THREE.BoxGeometry(3.6, 0.06, 0.5), 0, 0.16, 0), c: 0xd8b884 });
    for (const [ox, oz, oy] of [[0.2, 0.55, 0.62], [0.35, -0.55, 0.62]]) {
      kit.push({ g: xf(new THREE.CylinderGeometry(0.05, 0.045, 2.5, 5), ox, oy, oz, 0, 0.35, Math.PI / 2), c: 0xb98a52 });
      kit.push({ g: xf(new THREE.BoxGeometry(0.42, 0.05, 0.2), ox - 1.15, oy, oz - 0.42, 0, 0.35, 0), c: 0xd6a86a });
    }
    kit.push({ g: xf(new THREE.TorusGeometry(0.2, 0.05, 5, 12), -1.75, 0.55, 0, Math.PI / 2, 0, 0), c: 0xe4cd99 });
    boat.add(new THREE.Mesh(merge(kit), makeToon(0xffffff, { unique: true, vertexColors: true })));

    boat.position.set(-13.4, WATER_Y + 0.28, -5.9);
    boat.rotation.y = 0.42;
    scene.add(boat);
    this.anim.boat = boat;

    // mooring rope to a dock post
    const rp = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-12.7, WATER_Y + 0.85, -5.2),
      new THREE.Vector3(-12.4, WATER_Y + 0.55, -4.6),
      new THREE.Vector3(-12.3, DECK_Y - 0.55, -3.75),
    ]);
    const rope = new THREE.Mesh(new THREE.TubeGeometry(rp, 10, 0.04, 5, false), makeToon(0xe4cd99));
    scene.add(rope);

    this.obstacles.push({ x: -13.4, z: -5.9, r: 1.9 });
  }

  // ---- palms ---------------------------------------------------------------
  _buildPalms(scene) {
    const raw = [
      [6.5, -5.5, 1.00], [9.6, -2.6, 0.86], [10.0, -5.6, 1.10], [4.2, -8.2, 0.94],
      [7.6, -9.4, 1.04], [-1.6, -7.4, 0.90], [-4.6, -4.6, 1.00], [1.4, -10.0, 0.82],
      [12.2, 0.2, 0.92], [11.0, 4.2, 0.98], [7.8, 7.6, 0.88], [9.8, -8.0, 0.80],
    ];
    const palms = raw.map(([x, z, s]) => {
      const p = spot(x, z, 1.0, 2.6);
      return { x: p.x, z: p.z, y: sandY(p.x, p.z), s, yaw: Math.random() * TAU };
    });

    // trunk: tapered cylinder bent along +X in local space
    const tg = new THREE.CylinderGeometry(0.17, 0.33, 5.4, 8, 7);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const y = tp.getY(i);
      const u = (y + 2.7) / 5.4;
      tp.setX(i, tp.getX(i) + 1.25 * u * u);
      tp.setZ(i, tp.getZ(i) + 0.22 * u * u * u);
    }
    tg.translate(0, 2.7, 0);
    tg.computeVertexNormals();
    // NB: instanced tints come from instanceColor, so these materials must NOT
    // set vertexColors (their geometries carry no colour attribute).
    const trunks = new THREE.InstancedMesh(tg, toonTex(0xffffff, (() => {
      const t = texBark(); t.repeat.set(2, 3); return t;
    })()), palms.length);
    trunks.castShadow = true;

    // frond: plane deformed into a drooping, feathered leaf along +Z
    const fg = new THREE.PlaneGeometry(0.9, 3.4, 3, 14);
    const fp = fg.attributes.position;
    for (let i = 0; i < fp.count; i++) {
      const x = fp.getX(i), y = fp.getY(i);
      const u = (y + 1.7) / 3.4;
      const taper = (1 - 0.88 * u * u) * (0.62 + 0.38 * Math.sin(u * 20));
      const nx = x * taper;
      fp.setXYZ(i, nx, -Math.abs(nx) * 0.55 - u * u * 1.5, u * 3.4);
    }
    fg.computeVertexNormals();
    const frondCount = palms.length * 7;
    const fronds = new THREE.InstancedMesh(fg, makeToon(0xffffff, {
      unique: true, side: THREE.DoubleSide,
    }), frondCount);
    fronds.castShadow = true;
    fronds.frustumCulled = false;

    const cg = new THREE.SphereGeometry(0.17, 8, 6);
    const nuts = new THREE.InstancedMesh(cg, makeToon(0x6b4a2a), palms.length * 3);
    let ni = 0, fi = 0;

    for (let i = 0; i < palms.length; i++) {
      const p = palms[i];
      instAt(trunks, i, p.x, p.y, p.z, p.yaw, 0, 0, p.s);
      _col.setHex(0xa9794a).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      trunks.setColorAt(i, _col);

      // crown position = bent tip, rotated by yaw
      const lx = 1.25 * p.s, ly = 5.4 * p.s, lz = 0.22 * p.s;
      const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
      const cxw = p.x + lx * cy + lz * sy;
      const czw = p.z - lx * sy + lz * cy;
      const cyw = p.y + ly;

      for (let f = 0; f < 7; f++) {
        const yaw = p.yaw + (f / 7) * TAU + Math.random() * 0.24;
        const pitch = -0.62 + (f % 2) * 0.22 + Math.random() * 0.12;
        const sc = p.s * (0.9 + Math.random() * 0.25);
        this.anim.fronds.push({ i: fi, x: cxw, y: cyw, z: czw, yaw, pitch, sc, ph: Math.random() * TAU });
        instAt(fronds, fi, cxw, cyw, czw, yaw, pitch, 0, sc);
        _col.setHex(f % 2 ? 0x7ac74f : 0x63ad3c).offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);
        fronds.setColorAt(fi, _col);
        fi++;
      }
      if (i % 3 !== 2) {
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + i;
          instAt(nuts, ni++, cxw + Math.cos(a) * 0.3, cyw - 0.28, czw + Math.sin(a) * 0.3, 0, 0, 0, p.s);
        }
      }
      this.obstacles.push({ x: p.x, z: p.z, r: 0.62 });
    }
    nuts.count = ni;
    trunks.instanceColor.needsUpdate = true;
    fronds.instanceColor.needsUpdate = true;
    scene.add(trunks, fronds, nuts);
    this.anim.frondMesh = fronds;

    // beach grass on the back dunes
    const blade = [];
    for (let i = 0; i < 5; i++) {
      blade.push({ g: xf(new THREE.ConeGeometry(0.05, 0.75, 3), (i - 2) * 0.09, 0.36, Math.sin(i * 2) * 0.08, (Math.random() - 0.5) * 0.5, 0, (i - 2) * 0.2) });
    }
    const grassG = merge(blade);
    const grass = new THREE.InstancedMesh(grassG, makeToon(0x9dc46a, { unique: true, vertexColors: true }), 70);
    let gi = 0;
    for (let i = 0; i < 70; i++) {
      const th = Math.random() * TAU;
      const r = 9.6 + Math.random() * 2.6;
      const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
      if (r > shoreR(th) - 2.0) continue;
      instAt(grass, gi, x, sandY(x, z), z, Math.random() * TAU, 0, 0, 0.7 + Math.random() * 0.7);
      _col.setHex(Math.random() < 0.5 ? 0xa8cc74 : 0xc8c47a);
      grass.setColorAt(gi, _col);
      gi++;
    }
    grass.count = gi;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    scene.add(grass);
  }

  // ---- umbrellas, towels, sandcastle, driftwood ---------------------------
  _buildBeachStuff(scene) {
    const clutter = [];
    const C = (g, c) => clutter.push({ g, c });

    // ---------- umbrellas
    const stripeMat = toonTex(0xffffff, texStripes('#e8657a', '#fff1d6', 10), { side: THREE.DoubleSide });
    for (const [ux, uz, tilt] of [[5.8, 6.6, 0.14], [9.6, 6.9, -0.1]]) {
      const p = spot(ux, uz, 1.1, 2.4);
      const g = new THREE.Group();
      g.position.set(p.x, sandY(p.x, p.z), p.z);
      g.rotation.z = tilt;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.9, 6), makeToon(0xd6a86a));
      pole.position.y = 1.45;
      pole.castShadow = true;
      g.add(pole);
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(2.05, 0.95, 12, 1, true), stripeMat);
      canopy.position.y = 2.72;
      canopy.castShadow = true;
      g.add(canopy);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(2.02, 0.05, 4, 16), makeToon(0xe8657a));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 2.26;
      g.add(rim);
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), makeToon(0xf2b64a));
      finial.position.y = 3.28;
      g.add(finial);
      scene.add(g);
      this.anim.umbrellas.push({ obj: g, base: tilt, ph: Math.random() * TAU });
      this.obstacles.push({ x: p.x, z: p.z, r: 0.75 });
    }

    // ---------- towels
    const towels = [[7.1, 7.7, 0.5, '#4fb3e8', '#fff1d6'], [4.9, 5.5, -0.9, '#e8657a', '#ffe3b0'], [10.7, 5.5, 1.9, '#7ac74f', '#fff1d6']];
    for (const [tx, tz, rot, a, b] of towels) {
      const p = spot(tx, tz, 0.9, 2.2);
      const tg = new THREE.PlaneGeometry(1.5, 2.4, 3, 5);
      const tp = tg.attributes.position;
      for (let i = 0; i < tp.count; i++) {
        tp.setZ(i, Math.sin(tp.getX(i) * 3 + tp.getY(i) * 2) * 0.035);
      }
      tg.computeVertexNormals();
      const towel = new THREE.Mesh(tg, toonTex(0xffffff, texTowel(a, b), { side: THREE.DoubleSide }));
      towel.rotation.set(-Math.PI / 2, 0, rot);
      towel.position.set(p.x, sandY(p.x, p.z) + 0.04, p.z);
      towel.receiveShadow = true;
      scene.add(towel);
    }

    // beach bag, cooler, sunglasses, lifebuoy near the towels
    const bag = spot(6.4, 8.6, 0.9, 2.2);
    C(xf(new THREE.CylinderGeometry(0.34, 0.28, 0.55, 8), bag.x, sandY(bag.x, bag.z) + 0.27, bag.z), 0xf2b64a);
    C(xf(new THREE.TorusGeometry(0.26, 0.035, 4, 10), bag.x, sandY(bag.x, bag.z) + 0.62, bag.z, 0, 0, 0), 0xd9944a);
    const cool = spot(4.2, 6.6, 0.9, 2.2);
    C(xf(new THREE.BoxGeometry(0.85, 0.5, 0.6), cool.x, sandY(cool.x, cool.z) + 0.25, cool.z, 0, 0.4, 0), 0xdff0f6);
    C(xf(new THREE.BoxGeometry(0.9, 0.12, 0.65), cool.x, sandY(cool.x, cool.z) + 0.55, cool.z, 0, 0.4, 0), 0x4fb3e8);
    const buoy = spot(11.6, 3.0, 0.9, 2.4);
    C(xf(new THREE.CylinderGeometry(0.09, 0.11, 2.2, 6), buoy.x, sandY(buoy.x, buoy.z) + 1.1, buoy.z), 0xb98a52);
    C(xf(new THREE.TorusGeometry(0.45, 0.14, 6, 16), buoy.x, sandY(buoy.x, buoy.z) + 1.9, buoy.z + 0.14, 0.15, 0, 0), 0xe8657a);
    C(xf(new THREE.TorusGeometry(0.455, 0.145, 6, 4), buoy.x, sandY(buoy.x, buoy.z) + 1.9, buoy.z + 0.14, 0.15, 0, 0.78), 0xfff1d6);

    // ---------- sandcastle
    const cp = spot(3.6, 8.4, 2.2, 2.8);
    const cy0 = sandY(cp.x, cp.z);
    C(xf(new THREE.CylinderGeometry(1.75, 2.0, 0.3, 14), cp.x, cy0 + 0.15, cp.z), 0xe7cd94);
    C(xf(new THREE.TorusGeometry(2.25, 0.22, 5, 18), cp.x, cy0 + 0.02, cp.z, Math.PI / 2, 0, 0), 0xcaa871);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const tx = cp.x + Math.cos(a) * 1.25, tz = cp.z + Math.sin(a) * 1.25;
      C(xf(new THREE.CylinderGeometry(0.3, 0.36, 1.05, 9), tx, cy0 + 0.82, tz), 0xf0dba6);
      C(xf(new THREE.ConeGeometry(0.42, 0.55, 9), tx, cy0 + 1.62, tz), 0xe2c68d);

      // curtain wall between this tower and the next, with battlements on top
      const a2 = a + TAU / 8;
      const wx = cp.x + Math.cos(a2) * 1.16, wz = cp.z + Math.sin(a2) * 1.16;
      const yaw = -a2;                       // wall runs tangent to the ring
      const tanX = -Math.sin(a2), tanZ = Math.cos(a2);
      C(xf(new THREE.BoxGeometry(1.35, 0.62, 0.34), wx, cy0 + 0.61, wz, 0, yaw, 0), 0xecd69f);
      for (let k = -1; k <= 1; k++) {
        C(xf(new THREE.BoxGeometry(0.26, 0.22, 0.34),
          wx + tanX * k * 0.42, cy0 + 1.03, wz + tanZ * k * 0.42, 0, yaw, 0), 0xf0dba6);
      }
    }
    C(xf(new THREE.CylinderGeometry(0.5, 0.58, 1.65, 10), cp.x, cy0 + 1.12, cp.z), 0xf3dfad);
    C(xf(new THREE.ConeGeometry(0.68, 0.8, 10), cp.x, cy0 + 2.32, cp.z), 0xe2c68d);
    C(xf(new THREE.BoxGeometry(0.3, 0.45, 0.16), cp.x, cy0 + 0.52, cp.z + 0.56), 0x8a6a3e);
    C(xf(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 4), cp.x, cy0 + 3.06, cp.z), 0x8a6a3e);
    // bucket + spade
    C(xf(new THREE.CylinderGeometry(0.24, 0.19, 0.36, 9), cp.x + 2.0, cy0 + 0.18, cp.z + 1.5, 0, 0, 0.4), 0x4fb3e8);
    C(xf(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 4), cp.x - 1.9, cy0 + 0.4, cp.z + 1.4, 0, 0, 0.45), 0xf2b64a);
    C(xf(new THREE.BoxGeometry(0.24, 0.05, 0.3), cp.x - 2.08, cy0 + 0.05, cp.z + 1.4, 0, 0.3, 0.1), 0xe8657a);
    this.obstacles.push({ x: cp.x, z: cp.z, r: 1.7 });

    const castleFlag = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.26, 4, 2), makeToon(0xe8657a, { unique: true, side: THREE.DoubleSide }));
    castleFlag.position.set(cp.x + 0.22, cy0 + 3.38, cp.z);
    scene.add(castleFlag);
    this.anim.flag = castleFlag;

    // ---------- beach ball
    const bp = spot(8.4, 4.6, 1.0, 2.4);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), toonTex(0xffffff, texBall()));
    ball.position.set(bp.x, sandY(bp.x, bp.z) + 0.42, bp.z);
    ball.castShadow = true;
    scene.add(ball);
    this.anim.ball = ball;

    scene.add(Object.assign(
      new THREE.Mesh(merge(clutter), makeToon(0xffffff, { unique: true, vertexColors: true })),
      { castShadow: true, receiveShadow: true },
    ));

    // ---------- driftwood, rocks, shells, seaweed
    const logG = (() => {
      const g = new THREE.CylinderGeometry(0.24, 0.3, 2.6, 7, 4);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = (p.getY(i) + 1.3) / 2.6;
        p.setX(i, p.getX(i) + Math.sin(u * 2.4) * 0.22);
        p.setZ(i, p.getZ(i) * (0.8 + Math.sin(u * 5) * 0.15));
      }
      g.rotateZ(Math.PI / 2);
      g.computeVertexNormals();
      return g;
    })();
    const logs = new THREE.InstancedMesh(logG, makeToon(0xffffff, { unique: true }), 9);
    const logSpots = [[-2.5, 8.6], [-6.0, 3.6], [8.0, 9.2], [11.5, -3.5], [0.5, -8.5], [-3.0, -6.0], [6.2, -2.6], [-5.6, 0.2], [13.0, 5.0]];
    let li = 0;
    for (const [x, z] of logSpots) {
      const p = spot(x, z, 1.0, 1.1);
      instAt(logs, li, p.x, sandY(p.x, p.z) + 0.2, p.z, Math.random() * TAU, 0, (Math.random() - 0.5) * 0.2, 0.75 + Math.random() * 0.6);
      _col.setHex(Math.random() < 0.5 ? 0xd8c6a8 : 0xc2ab8b);
      logs.setColorAt(li, _col);
      this.obstacles.push({ x: p.x, z: p.z, r: 0.75 });
      li++;
    }
    logs.count = li;
    logs.instanceColor.needsUpdate = true;
    logs.castShadow = true;
    scene.add(logs);

    // icosahedron ships non-indexed with spherical normals; recomputing them
    // gives per-face normals, i.e. proper chunky faceted rocks
    const rockG = new THREE.IcosahedronGeometry(0.42, 0);
    rockG.computeVertexNormals();
    const rocks = new THREE.InstancedMesh(rockG, makeToon(0xffffff, { unique: true }), 34);
    let ri = 0;
    for (let i = 0; i < 34; i++) {
      const th = Math.random() * TAU;
      const r = 5.5 + Math.random() * 6.5;
      const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
      if (Math.hypot(x - ZONE.x, z - ZONE.z) < ZONE.r + 0.8) continue;
      if (r > shoreR(th) + 0.2) continue;
      instAt(rocks, ri, x, sandY(x, z) + 0.05, z, Math.random() * TAU, Math.random(), Math.random(), 0.35 + Math.random() * 0.8);
      _col.setHex(Math.random() < 0.5 ? 0xb0a394 : 0x8f8578);
      rocks.setColorAt(ri, _col);
      ri++;
    }
    rocks.count = ri;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    scene.add(rocks);

    const shellG = merge([
      { g: xf(new THREE.ConeGeometry(0.16, 0.3, 7), 0, 0.06, 0, Math.PI / 2.2, 0, 0) },
      { g: xf(new THREE.SphereGeometry(0.1, 6, 4), 0.1, 0.05, 0) },
    ]);
    const shells = new THREE.InstancedMesh(shellG, makeToon(0xffffff, { unique: true, vertexColors: true }), 40);
    let si = 0;
    for (let i = 0; i < 40; i++) {
      const th = Math.random() * TAU;
      const r = shoreR(th) - 1.4 - Math.random() * 3.4;
      const x = CX + Math.cos(th) * r, z = CZ + Math.sin(th) * r;
      if (Math.hypot(x - ZONE.x, z - ZONE.z) < ZONE.r + 0.4) continue;
      instAt(shells, si, x, sandY(x, z) + 0.02, z, Math.random() * TAU, 0, 0, 0.6 + Math.random() * 0.7);
      _col.setHex([0xfff1d6, 0xf7d6b8, 0xe8b4c0, 0xf2b64a][i % 4]);
      shells.setColorAt(si, _col);
      si++;
    }
    shells.count = si;
    shells.instanceColor.needsUpdate = true;
    scene.add(shells);
  }

  // ---- crabs + gulls -------------------------------------------------------
  _buildCritters(scene) {
    const shellMat = makeToon(0xe8657a);
    const darkMat = makeToon(0x3a2a1c);
    const clawMat = makeToon(0xf2836f);

    const bodyG = merge([
      { g: xf(new THREE.SphereGeometry(0.26, 10, 8), 0, 0, 0, 0, 0, 0, 1.25, 0.72, 1) },
      { g: xf(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 5), -0.12, 0.2, 0.06) },
      { g: xf(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 5), 0.12, 0.2, 0.06) },
    ]);
    const eyeG = merge([
      { g: xf(new THREE.SphereGeometry(0.06, 7, 5), -0.12, 0.31, 0.06) },
      { g: xf(new THREE.SphereGeometry(0.06, 7, 5), 0.12, 0.31, 0.06) },
    ]);
    const legRowG = merge([0, 1, 2].map((i) => ({
      g: xf(new THREE.BoxGeometry(0.05, 0.05, 0.3), 0.24, -0.02, (i - 1) * 0.16, 0, 0.5 - i * 0.5, -0.5),
    })));
    const clawG = merge([
      { g: xf(new THREE.SphereGeometry(0.12, 8, 6), 0.34, 0.02, 0.2, 0, 0.5, 0, 1.3, 0.8, 0.9) },
      { g: xf(new THREE.BoxGeometry(0.16, 0.05, 0.08), 0.5, 0.06, 0.3, 0, 0.5, 0) },
      { g: xf(new THREE.SphereGeometry(0.12, 8, 6), -0.34, 0.02, 0.2, 0, -0.5, 0, 1.3, 0.8, 0.9) },
      { g: xf(new THREE.BoxGeometry(0.16, 0.05, 0.08), -0.5, 0.06, 0.3, 0, -0.5, 0) },
    ]);

    for (const [cx, cz, rr] of [[-3.4, 8.4, 1.6], [5.6, 9.2, 1.9], [9.9, 4.6, 1.4]]) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyG.clone(), shellMat);
      body.castShadow = true;
      const eyes = new THREE.Mesh(eyeG.clone(), darkMat);
      const legL = new THREE.Mesh(legRowG.clone(), clawMat);
      const legR = new THREE.Mesh(legRowG.clone(), clawMat);
      legR.scale.x = -1;
      const claws = new THREE.Mesh(clawG.clone(), clawMat);
      g.add(body, eyes, legL, legR, claws);
      scene.add(g);
      this.anim.crabs.push({
        obj: g, legL, legR, claws, body,
        cx, cz, rx: rr, rz: rr * 0.7,
        a: Math.random() * TAU, sp: 0.42 + Math.random() * 0.3, ph: Math.random() * TAU,
      });
    }
    bodyG.dispose(); eyeG.dispose(); legRowG.dispose(); clawG.dispose();

    // gulls
    const gullBody = merge([
      { g: xf(new THREE.SphereGeometry(0.22, 8, 6), 0, 0, 0, 0, 0, 0, 0.8, 0.8, 1.7), c: 0xfffaf0 },
      { g: xf(new THREE.SphereGeometry(0.13, 8, 6), 0, 0.05, 0.3), c: 0xfffaf0 },
      { g: xf(new THREE.ConeGeometry(0.05, 0.22, 5), 0, 0.03, 0.46, Math.PI / 2, 0, 0), c: 0xf2b64a },
      { g: xf(new THREE.ConeGeometry(0.14, 0.42, 4), 0, 0.04, -0.42, -Math.PI / 2, 0, 0), c: 0xdfe6ea },
    ]);
    const wingG = merge([
      { g: xf(new THREE.BoxGeometry(1.05, 0.045, 0.34), 0.55, 0, 0, 0, 0.12, 0), c: 0xfffaf0 },
      { g: xf(new THREE.BoxGeometry(0.5, 0.045, 0.22), 1.28, 0, -0.06, 0, 0.3, 0), c: 0x6f7c86 },
    ]);
    const gullMat = makeToon(0xffffff, { unique: true, vertexColors: true, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(gullBody.clone(), gullMat));
      const wl = new THREE.Mesh(wingG.clone(), gullMat);
      const wr = new THREE.Mesh(wingG.clone(), gullMat);
      wr.scale.x = -1;
      g.add(wl, wr);
      g.scale.setScalar(0.9 + i * 0.14);
      scene.add(g);
      this.anim.gulls.push({
        obj: g, wl, wr,
        r: 9.5 + i * 3.2, y: 8.2 + i * 1.3, a: (i / 3) * TAU,
        sp: 0.34 - i * 0.06, ph: Math.random() * TAU,
        cx: -1 - i, cz: 0.5 + i,
      });
    }
    gullBody.dispose(); wingG.dispose();
  }

  // ---- exit to the plaza ---------------------------------------------------
  _buildExit(scene) {
    const parts = [];
    const P = (g, c) => parts.push({ g, c });

    // Everything here is snapped inland: the shoreline curls back east of x~14.
    const sign = spot(12.0, 4.5, 1.4, 2.4);
    const ey = sandY(sign.x, sign.z);
    const archA = spot(11.0, 0.7, 1.4, 2.4);
    const archB = spot(11.0, 4.6, 1.4, 2.4);
    const torchPos = [spot(9.4, 0.5, 1.4, 2.4), spot(9.4, 5.0, 1.4, 2.4)];

    // signpost
    P(xf(new THREE.CylinderGeometry(0.14, 0.17, 3.1, 7), sign.x, ey + 1.55, sign.z), 0x9a6c3e);
    P(xf(new THREE.SphereGeometry(0.2, 8, 6), sign.x, ey + 3.15, sign.z), 0xc98f52);
    P(xf(new THREE.BoxGeometry(0.5, 0.14, 0.5), sign.x, ey + 0.07, sign.z), 0xd6a86a);

    // driftwood arch over the sandy path
    const ay1 = sandY(archA.x, archA.z), ay2 = sandY(archB.x, archB.z);
    P(xf(new THREE.CylinderGeometry(0.16, 0.2, 3.4, 6), archA.x, ay1 + 1.7, archA.z, 0, 0, -0.05), 0xcfbb9a);
    P(xf(new THREE.CylinderGeometry(0.16, 0.2, 3.4, 6), archB.x, ay2 + 1.7, archB.z, 0, 0, 0.05), 0xcfbb9a);
    P(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(archA.x, ay1 + 3.3, archA.z),
      new THREE.Vector3((archA.x + archB.x) / 2 + 0.15, (ay1 + ay2) / 2 + 4.0, (archA.z + archB.z) / 2),
      new THREE.Vector3(archB.x, ay2 + 3.3, archB.z),
    ]), 16, 0.16, 6, false), 0xcfbb9a);
    // hanging shells on the arch
    for (let i = 0; i < 5; i++) {
      const u = 0.2 + i * 0.15;
      const x = archA.x + (archB.x - archA.x) * u + 0.12;
      const z = archA.z + (archB.z - archA.z) * u;
      const y = ay1 + 3.55 + Math.sin(u * Math.PI) * 0.55;
      P(xf(new THREE.CylinderGeometry(0.008, 0.008, 0.42, 3), x, y - 0.21, z), 0xe4cd99);
      P(xf(new THREE.ConeGeometry(0.11, 0.2, 7), x, y - 0.5, z, Math.PI, 0, 0), [0xfff1d6, 0xe8b4c0, 0xf2b64a][i % 3]);
    }

    // tiki torches flanking the path
    for (const t of torchPos) {
      const ty = sandY(t.x, t.z);
      P(xf(new THREE.CylinderGeometry(0.09, 0.11, 2.2, 6), t.x, ty + 1.1, t.z), 0xb08a5a);
      P(xf(new THREE.CylinderGeometry(0.2, 0.15, 0.4, 8), t.x, ty + 2.3, t.z), 0x6d4a2b);
    }
    scene.add(Object.assign(new THREE.Mesh(merge(parts), makeToon(0xffffff, { unique: true, vertexColors: true })), { castShadow: true }));

    for (const t of torchPos) {
      const ty = sandY(t.x, t.z);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 7), makeGlow(0xffa53a, { unique: true }));
      flame.position.set(t.x, ty + 2.72, t.z);
      scene.add(flame);
      this.anim.torches.push({ obj: flame, ph: Math.random() * TAU });
      this.obstacles.push({ x: t.x, z: t.z, r: 0.4 });
    }

    // Two signboards on one post. The upper one faces west (read on your way
    // out of the cove), the lower faces east (read on your way in).
    const yaw = Math.PI / 2 + 0.25;
    const nx = Math.sin(yaw), nz = Math.cos(yaw); // board facing direction
    const boards = [
      [ey + 2.46, -1, texSign('SUNNY PLAZA', 'the heart of the cove', '#4fb3e8')],
      [ey + 1.62, 1, texSign('DRIFTWOOD BEACH', 'sand, surf & fishing', '#e8657a')],
    ];
    for (const [y, dir, tex] of boards) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.66, 0.12), makeToon(0xa87844));
      plank.position.set(sign.x, y, sign.z);
      plank.rotation.y = yaw;
      plank.castShadow = true;
      scene.add(plank);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.62), glowTex(0xf7ead2, tex));
      face.position.set(sign.x + nx * dir * 0.08, y, sign.z + nz * dir * 0.08);
      face.rotation.y = dir > 0 ? yaw : yaw + Math.PI;
      scene.add(face);
    }

    this.obstacles.push({ x: sign.x, z: sign.z, r: 0.55 },
      { x: archA.x, z: archA.z, r: 0.4 }, { x: archB.x, z: archB.z, r: 0.4 });

    this.hotspots.push({
      id: 'exit-plaza',
      position: new THREE.Vector3(12, 0, 2),
      radius: 3,
      label: 'Back to Sunny Plaza',
      action: (g) => g.goToRoom('plaza', 'beach'),
    });
  }

  // ---- per-frame -----------------------------------------------------------
  update(dt, game) {
    const t = (this.t += dt);
    const a = this.anim;
    if (!a) return;

    // sea surface: height + analytic normal (plane local z is world y)
    const wpos = a.water.geometry.attributes.position;
    const wnrm = a.water.geometry.attributes.normal;
    const arr = wpos.array, narr = wnrm.array;
    for (let i = 0, n = a.wx.length; i < n; i++) {
      const x = a.wx[i], z = a.wz[i];
      const p1 = x * W1K + t * W1S, p2 = z * W2K + t * W2S, p3 = (x + z) * W3K + t * W3S;
      arr[i * 3 + 2] = W1A * Math.sin(p1) + W2A * Math.sin(p2) + W3A * Math.sin(p3);
      const d3 = W3A * W3K * Math.cos(p3);
      const dx = W1A * W1K * Math.cos(p1) + d3;
      const dz = W2A * W2K * Math.cos(p2) + d3;
      const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      narr[i * 3] = -dx * inv; narr[i * 3 + 1] = dz * inv; narr[i * 3 + 2] = inv;
    }
    wpos.needsUpdate = true;
    wnrm.needsUpdate = true;

    // foam: outer edge rides the swell, whole line breathes in and out
    const fpos = a.foam.geometry.attributes.position;
    const farr = fpos.array;
    for (const i of a.foamOuter) {
      farr[i * 3 + 1] = WATER_Y + waveY(farr[i * 3] + CX, farr[i * 3 + 2] + CZ, t) + 0.06;
    }
    fpos.needsUpdate = true;
    const tide = 1 + Math.sin(t * 0.5) * 0.014;
    a.foam.scale.set(tide, 1, tide);
    a.foam.material.map.offset.x = t * 0.014;
    a.foam.material.opacity = 0.78 + Math.sin(t * 0.85) * 0.16;

    // glints
    const gm = a.glintMesh;
    for (let i = 0; i < a.glints.length; i++) {
      const g = a.glints[i];
      const pulse = Math.sin(t * g.sp + g.ph);
      const s = pulse > 0 ? pulse * pulse * pulse * g.sc : 0;
      instAt(gm, i, g.x, WATER_Y + waveY(g.x, g.z, t) + 0.035, g.z, t * 0.4 + g.ph, 0, 0, s);
    }
    gm.instanceMatrix.needsUpdate = true;

    // palm fronds sway
    const fm = a.frondMesh;
    for (const f of a.fronds) {
      instAt(fm, f.i, f.x, f.y, f.z,
        f.yaw + Math.sin(t * 0.85 + f.ph) * 0.06,
        f.pitch + Math.sin(t * 1.25 + f.ph) * 0.075,
        Math.sin(t * 1.6 + f.ph) * 0.05, f.sc);
    }
    fm.instanceMatrix.needsUpdate = true;

    // umbrellas
    for (const u of a.umbrellas) {
      u.obj.rotation.z = u.base + Math.sin(t * 1.1 + u.ph) * 0.022;
      u.obj.rotation.x = Math.sin(t * 0.9 + u.ph * 1.7) * 0.018;
    }

    // moored rowboat
    const b = a.boat;
    const bx = b.position.x, bz = b.position.z;
    b.position.y = WATER_Y + waveY(bx, bz, t) + 0.3;
    b.rotation.x = (waveY(bx, bz + 1.2, t) - waveY(bx, bz - 1.2, t)) * 0.42;
    b.rotation.z = -(waveY(bx + 1.6, bz, t) - waveY(bx - 1.6, bz, t)) * 0.42;

    // fishing floats
    for (let i = 0; i < a.floats.length; i++) {
      const f = a.floats[i];
      instAt(a.floatMesh, i, f.x, WATER_Y + waveY(f.x, f.z, t) + 0.06, f.z, 0, 0, 0, 1);
    }
    a.floatMesh.instanceMatrix.needsUpdate = true;

    // lantern flicker
    const flick = 0.9 + Math.sin(t * 7.3) * 0.06 + Math.sin(t * 3.1) * 0.05;
    a.lamp.scale.setScalar(flick);
    a.lampLight.intensity = 8 + flick * 2.5;

    // torches
    for (const tc of a.torches) {
      const s = 0.85 + Math.sin(t * 11 + tc.ph) * 0.14 + Math.sin(t * 4.3 + tc.ph) * 0.1;
      tc.obj.scale.set(0.9 + (1 - s) * 0.3, s * 1.15, 0.9 + (1 - s) * 0.3);
      tc.obj.rotation.z = Math.sin(t * 5 + tc.ph) * 0.09;
    }

    // castle flag ripple
    if (a.flag) {
      const fp = a.flag.geometry.attributes.position;
      for (let i = 0; i < fp.count; i++) {
        const u = fp.getX(i) / 0.44 + 0.5;
        fp.setZ(i, Math.sin(u * 5 - t * 6) * 0.06 * u);
      }
      fp.needsUpdate = true;
      a.flag.rotation.y = Math.sin(t * 0.7) * 0.25;
    }

    // beach ball
    if (a.ball) {
      a.ball.rotation.y += dt * 0.35;
      a.ball.rotation.z = Math.sin(t * 1.4) * 0.12;
    }

    // crabs
    for (const c of a.crabs) {
      c.a += dt * c.sp;
      const scuttle = 0.55 + 0.45 * Math.sin(c.a * 3 + c.ph);
      const px = c.cx + Math.cos(c.a) * c.rx;
      const pz = c.cz + Math.sin(c.a) * c.rz;
      const land = toLand(px, pz, 1.0);
      const y = sandY(land.x, land.z);
      c.obj.position.set(land.x, y + 0.16 + Math.abs(Math.sin(t * 9 + c.ph)) * 0.02, land.z);
      const heading = Math.atan2(-Math.sin(c.a) * c.rx, Math.cos(c.a) * c.rz);
      c.obj.rotation.y = heading + Math.PI / 2;
      const wig = Math.sin(t * 13 + c.ph) * 0.3 * scuttle;
      c.legL.rotation.z = wig;
      c.legR.rotation.z = -wig;
      c.claws.rotation.x = Math.sin(t * 4 + c.ph) * 0.22;
      c.body.rotation.z = Math.sin(t * 13 + c.ph) * 0.05;
    }

    // gulls
    for (const g of a.gulls) {
      g.a += dt * g.sp;
      const x = g.cx + Math.cos(g.a) * g.r;
      const z = g.cz + Math.sin(g.a) * g.r;
      g.obj.position.set(x, g.y + Math.sin(t * 0.8 + g.ph) * 0.5, z);
      g.obj.rotation.set(0, -g.a, 0.2);
      const flap = Math.sin(t * 4.2 + g.ph);
      g.wl.rotation.z = 0.15 + flap * 0.55;
      g.wr.rotation.z = -0.15 - flap * 0.55;
    }

    // horizon traffic
    for (const s of a.boats) {
      s.obj.position.x += dt * s.sp;
      if (s.obj.position.x > 40) s.obj.position.x = -90;
      s.obj.position.y = 0.2 + Math.sin(t * 0.7 + s.ph) * 0.22;
      s.obj.rotation.z = Math.sin(t * 0.6 + s.ph) * 0.05;
    }
    for (const c of a.clouds) {
      c.position.x += dt * 0.35;
      if (c.position.x > 110) c.position.x = -110;
    }
  }

  dispose() {
    this.anim = null;
    this.hotspots.length = 0;
    this.obstacles.length = 0;
    this.groundMeshes.length = 0;
  }
}
