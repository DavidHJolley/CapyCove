import * as THREE from 'three';
import { makeToon, makeGlow, canvasTexture } from '../core/materials.js';
import { FURNITURE } from '../../shared/constants.js';

// ---------------------------------------------------------------------------
// Player-house furniture. One procedural builder per id in the shared
// FURNITURE catalog; `buildFurniture(id)` hands back a THREE.Group with:
//   - y = 0 at the floor, authored facing +Z (the front looks at the camera
//     when rot = 0, so pushing something against the north wall is rot = 0)
//   - userData.footprint = { w, d } in local units (the editor's placement ring)
//   - userData.furnId, and optionally userData.update = (t) => {} for props
//     with life in them (fish, flames, twinkles, steam). Animated children are
//     named 'anim' so the room can find them.
// Every piece is built from primitives, painted into vertex colours and merged
// so a fully furnished den still costs ~2 draw calls per item. Budget is under
// ~400 triangles each; see the header comment on each builder.
// ---------------------------------------------------------------------------

/** Convenience re-export so UI code can read names/prices from one import. */
export const FURNITURE_META = FURNITURE;
export const FURNITURE_IDS = Object.keys(FURNITURE);

const PAL = {
  wood: 0x8a6642,
  woodLight: 0xb08a5a,
  woodDark: 0x6b4f35,
  cream: 0xfff6e3,
  linen: 0xf6e7c8,
  sand: 0xf0dca0,
  coral: 0xe8657a,
  blush: 0xf29ab0,
  sky: 0x4fb3e8,
  deep: 0x2f7fb0,
  teal: 0x42d6c8,
  leaf: 0x7ac74f,
  leafDark: 0x4d8c39,
  gold: 0xf2b64a,
  amber: 0xf2a541,
  plum: 0x9b6bd4,
  ink: 0x3a2f22,
  stone: 0xd8cdb6,
  stoneDark: 0xb2a58a,
  metal: 0xbcc6cd,
  fur: 0xb08a5a,
};

/* --- geometry assembly ----------------------------------------------------- */

const _col = new THREE.Color();

function paintGeo(geo, hex) {
  _col.set(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _col.r;
    arr[i * 3 + 1] = _col.g;
    arr[i * 3 + 2] = _col.b;
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
    if (tf.rz) geo.rotateZ(tf.rz);
    if (tf.rx) geo.rotateX(tf.rx);
    if (tf.ry) geo.rotateY(tf.ry);
    if (tf.x || tf.y || tf.z) geo.translate(tf.x || 0, tf.y || 0, tf.z || 0);
  }
  paintGeo(geo, hex);
  list.push(geo);
  return geo;
}

const box = (L, hex, w, h, d, tf) => part(L, new THREE.BoxGeometry(w, h, d), hex, tf);
const cyl = (L, hex, rt, rb, h, seg, tf, open) =>
  part(L, new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!open), hex, tf);
const sph = (L, hex, r, ws, hs, tf) => part(L, new THREE.SphereGeometry(r, ws, hs), hex, tf);
const cone = (L, hex, r, h, seg, tf) => part(L, new THREE.ConeGeometry(r, h, seg), hex, tf);
const disc = (L, hex, r, seg, tf) => part(L, new THREE.CircleGeometry(r, seg), hex, tf);

/** Concatenate coloured parts into one geometry (one draw call). Empties list. */
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

/** Merged toon mesh (lit, shadowed) from a parts list. */
function solid(list, { shadow = true } = {}) {
  const m = new THREE.Mesh(mergeParts(list), makeToon(0xffffff, VC));
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

/** Merged unlit mesh for glowy bits. Material is unique so it can be pulsed.
 *  `fade: true` opts into alpha fading: dimming a basic material's colour walks
 *  it toward black (soot), which is not what steam and bubbles should do. */
function glow(list, { fade = false } = {}) {
  const mat = makeGlow(0xfffdf5, { unique: true });
  mat.vertexColors = true;
  if (fade) {
    mat.transparent = true;
    mat.depthWrite = false;
  }
  mat.needsUpdate = true;
  const m = new THREE.Mesh(mergeParts(list), mat);
  if (fade) m.renderOrder = 3;
  m.userData.mat = mat;
  return m;
}

/** Translucent merged mesh (aquarium glass, display cabinet front). */
function glass(list, hex = 0xbfe6f5, opacity = 0.3) {
  const mat = makeToon(hex, { unique: true, transparent: true, opacity, depthWrite: false });
  const m = new THREE.Mesh(mergeParts(list), mat);
  m.renderOrder = 2;
  return m;
}

/* --- canvas-textured materials (cached: built once, reused by every house) -- */

const _texMats = new Map();

/** Cached textured material. Marked shared so the room dispose sweep skips it. */
function texMat(key, w, h, draw, { flat = false, double = false } = {}) {
  let mat = _texMats.get(key);
  if (mat) return mat;
  const tex = canvasTexture(w, h, draw);
  mat = flat ? makeGlow(0xffffff, { unique: true }) : makeToon(0xffffff, { unique: true });
  mat.map = tex;
  if (double) mat.side = THREE.DoubleSide;
  mat.userData.shared = true;
  mat.needsUpdate = true;
  _texMats.set(key, mat);
  return mat;
}

function plate(w, h, mat, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

const BOOK_COLS = ['#e8657a', '#4fb3e8', '#7ac74f', '#f2b64a', '#9b6bd4', '#fff6e3', '#42d6c8'];

function texBooks() {
  return texMat('books', 160, 64, (g, w, h) => {
    g.fillStyle = '#4a3524';
    g.fillRect(0, 0, w, h);
    let x = 3;
    let i = 0;
    while (x < w - 5) {
      const bw = 7 + ((i * 5) % 9);
      const bh = h - 5 - ((i * 7) % 11);
      g.fillStyle = BOOK_COLS[i % BOOK_COLS.length];
      g.fillRect(x, h - bh, bw, bh);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.fillRect(x + 1, h - bh + 4, bw - 2, 2);
      g.fillRect(x + 1, h - 9, bw - 2, 2);
      g.fillStyle = 'rgba(60,40,20,0.35)';
      g.fillRect(x + bw, h - bh, 2, bh);
      x += bw + 2;
      i++;
    }
  });
}

function texStone() {
  return texMat('stone', 128, 128, (g, w, h) => {
    g.fillStyle = '#c2b294';
    g.fillRect(0, 0, w, h);
    const tones = ['#e2d8c0', '#d5c8ac', '#eae0ca', '#cdbfa2'];
    for (let r = 0; r < 5; r++) {
      const y = r * 26 + 3;
      const off = (r % 2) * 18;
      for (let c = -1; c < 4; c++) {
        const x = c * 38 + off + 3;
        g.fillStyle = tones[(r + c + 8) % tones.length];
        g.beginPath();
        g.roundRect ? g.roundRect(x, y, 33, 20, 6) : g.rect(x, y, 33, 20);
        g.fill();
      }
    }
    g.fillStyle = 'rgba(150,132,104,0.25)';
    for (let i = 0; i < 40; i++) g.fillRect((i * 53) % w, (i * 31) % h, 3, 2);
  });
}

function texRugRound() {
  return texMat('rug_round', 256, 256, (g, w) => {
    const c = w / 2;
    const rings = ['#e8657a', '#fff6e3', '#f2b64a', '#fff6e3', '#4fb3e8', '#fff6e3'];
    for (let i = 0; i < rings.length; i++) {
      g.fillStyle = rings[i];
      g.beginPath();
      g.arc(c, c, c * (1 - i * 0.15), 0, 7);
      g.fill();
    }
    // capy paw in the middle, because of course
    g.fillStyle = '#b08a5a';
    g.beginPath();
    g.ellipse(c, c + 7, 15, 12, 0, 0, 7);
    g.fill();
    for (let i = 0; i < 4; i++) {
      const a = -2.5 + i * 0.55;
      g.beginPath();
      g.ellipse(c + Math.cos(a) * 20, c + Math.sin(a) * 20 + 4, 6, 7, a + 1.57, 0, 7);
      g.fill();
    }
    g.strokeStyle = 'rgba(120,86,50,0.3)';
    g.lineWidth = 2;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * c * 0.92, c + Math.sin(a) * c * 0.92);
      g.lineTo(c + Math.cos(a) * c, c + Math.sin(a) * c);
      g.stroke();
    }
  });
}

function texRugStripe() {
  return texMat('rug_stripe', 256, 160, (g, w, h) => {
    g.fillStyle = '#fff6e3';
    g.fillRect(0, 0, w, h);
    const cols = ['#7ac74f', '#fff6e3', '#f2b64a', '#fff6e3', '#e8657a', '#fff6e3', '#4fb3e8', '#fff6e3'];
    for (let i = 0; i < cols.length; i++) {
      g.fillStyle = cols[i];
      g.fillRect(0, (i * h) / cols.length, w, h / cols.length);
    }
    g.fillStyle = 'rgba(120,86,50,0.16)';
    for (let x = 0; x < w; x += 5) g.fillRect(x, 0, 2, h);
    g.strokeStyle = '#d9c49a';
    g.lineWidth = 8;
    g.strokeRect(4, 4, w - 8, h - 8);
  });
}

function texPortrait() {
  return texMat('portrait', 192, 160, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#ffe6b8');
    bg.addColorStop(1, '#f7c98c');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.58;
    // ears
    g.fillStyle = '#8a6642';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * 44, cy - 34, 13, 11, 0, 0, 7);
      g.fill();
    }
    // head
    g.fillStyle = '#b08a5a';
    g.beginPath();
    g.ellipse(cx, cy, 52, 44, 0, 0, 7);
    g.fill();
    // muzzle
    g.fillStyle = '#c9a271';
    g.beginPath();
    g.ellipse(cx, cy + 22, 26, 18, 0, 0, 7);
    g.fill();
    g.fillStyle = '#3a2f22';
    g.beginPath();
    g.ellipse(cx, cy + 14, 9, 6, 0, 0, 7);
    g.fill();
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(cx + s * 22, cy - 8, 6, 0, 7);
      g.fill();
    }
    g.fillStyle = '#fff6e3';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(cx + s * 22 + 2, cy - 10, 2, 0, 7);
      g.fill();
    }
    // smile
    g.strokeStyle = '#3a2f22';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy + 22, 12, 0.3, 2.84);
    g.stroke();
    // tiny hat, gold trim
    g.fillStyle = '#e8657a';
    g.fillRect(cx - 30, cy - 58, 60, 8);
    g.fillRect(cx - 20, cy - 78, 40, 22);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(cx - 20, cy - 66, 40, 5);
    g.strokeStyle = 'rgba(180,140,80,0.5)';
    g.lineWidth = 10;
    g.strokeRect(5, 5, w - 10, h - 10);
  });
}

function texArcadeScreen() {
  return texMat('arcade_screen', 128, 96, (g, w, h) => {
    g.fillStyle = '#141a2e';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(79,179,232,0.22)';
    g.lineWidth = 1;
    for (let y = 4; y < h; y += 6) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.fillStyle = '#fff6e3';
    g.fillRect(8, h / 2 - 14, 5, 28);
    g.fillRect(w - 13, h / 2 - 2, 5, 28);
    g.fillStyle = 'rgba(255,246,227,0.35)';
    for (let y = 6; y < h - 6; y += 12) g.fillRect(w / 2 - 1, y, 3, 6);
    g.fillStyle = '#f2b64a';
    g.font = 'bold 13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('1UP  0420', w / 2, 15);
    g.fillStyle = '#7ac74f';
    g.font = 'bold 10px system-ui, sans-serif';
    g.fillText('CAPY CLASH', w / 2, h - 8);
  });
}

function texMarquee() {
  return texMat(
    'arcade_marquee',
    256,
    72,
    (g, w, h) => {
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#e8657a');
      bg.addColorStop(1, '#9b6bd4');
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff6e3';
      g.font = 'bold 32px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('CAPY CLASH', w / 2, 44);
      g.fillStyle = '#f2b64a';
      for (let i = 0; i < 14; i++) {
        g.beginPath();
        g.arc(10 + i * 18, 8, 3, 0, 7);
        g.arc(10 + i * 18, h - 8, 3, 0, 7);
        g.fill();
      }
    },
    { flat: true },
  );
}

function texCocoaSign() {
  return texMat('cocoa_sign', 256, 112, (g, w, h) => {
    g.fillStyle = '#fff6e3';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#e8657a';
    g.lineWidth = 8;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#6b4f35';
    g.font = 'bold 30px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('HOT COCOA', w / 2 + 14, 44);
    g.fillStyle = '#e8657a';
    g.font = 'italic 20px "Trebuchet MS", system-ui, sans-serif';
    g.fillText('always free, always warm', w / 2 + 14, 78);
    // mug doodle
    g.fillStyle = '#4fb3e8';
    g.fillRect(20, 42, 34, 34);
    g.fillStyle = '#8a5a3a';
    g.fillRect(23, 45, 28, 8);
    g.strokeStyle = '#4fb3e8';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(56, 58, 10, -1.2, 1.2);
    g.stroke();
  });
}

/* --- builders -------------------------------------------------------------- */
// Each builder fills the group and sets userData.footprint. Triangle counts in
// the comments are the merged totals (verified by counting position/3).

/** Squashy Sofa: rolled arms, two fat cushions, one lopsided pillow. ~292 tris */
function buildSofa(g) {
  const S = [];
  const body = PAL.coral;
  box(S, body, 2.5, 0.34, 1.0, { y: 0.42, z: 0.02 });
  box(S, body, 2.5, 0.72, 0.26, { y: 0.86, z: -0.44 });
  cyl(S, body, 0.15, 0.15, 2.5, 8, { rz: Math.PI / 2, y: 1.2, z: -0.44 });
  for (const s of [-1, 1]) {
    box(S, body, 0.3, 0.5, 1.06, { x: s * 1.1, y: 0.6, z: 0.0 });
    cyl(S, body, 0.15, 0.15, 1.06, 8, { rx: Math.PI / 2, x: s * 1.1, y: 0.85 });
    box(S, PAL.linen, 1.1, 0.22, 0.86, { x: s * 0.6, y: 0.68, z: 0.06 });
    cyl(S, PAL.linen, 0.11, 0.11, 1.1, 8, { rz: Math.PI / 2, x: s * 0.6, y: 0.66, z: 0.47 });
    for (const t of [-1, 1]) box(S, PAL.woodDark, 0.14, 0.22, 0.14, { x: s * 1.05, y: 0.11, z: t * 0.4 });
  }
  box(S, PAL.gold, 0.4, 0.4, 0.15, { rz: 0.42, x: 0.78, y: 1.02, z: -0.28 });
  g.add(solid(S));
  g.userData.footprint = { w: 2.65, d: 1.3 };
}

/** Snug Armchair: sofa's little sibling with a blanket over one arm. ~260 tris */
function buildArmchair(g) {
  const S = [];
  const body = PAL.sky;
  box(S, body, 1.05, 0.34, 0.95, { y: 0.42 });
  box(S, body, 1.05, 0.68, 0.24, { y: 0.84, z: -0.4 });
  cyl(S, body, 0.14, 0.14, 1.05, 8, { rz: Math.PI / 2, y: 1.16, z: -0.4 });
  for (const s of [-1, 1]) {
    box(S, body, 0.26, 0.46, 1.0, { x: s * 0.62, y: 0.58 });
    cyl(S, body, 0.14, 0.14, 1.0, 8, { rx: Math.PI / 2, x: s * 0.62, y: 0.81 });
    for (const t of [-1, 1]) box(S, PAL.woodDark, 0.13, 0.22, 0.13, { x: s * 0.58, y: 0.11, z: t * 0.36 });
  }
  box(S, PAL.linen, 0.86, 0.22, 0.8, { y: 0.68, z: 0.04 });
  cyl(S, PAL.linen, 0.1, 0.1, 0.86, 8, { rz: Math.PI / 2, y: 0.66, z: 0.42 });
  // knitted blanket slung over the right arm
  box(S, PAL.coral, 0.26, 0.05, 0.56, { x: 0.66, y: 0.9, z: 0.08 });
  box(S, PAL.coral, 0.05, 0.36, 0.56, { x: 0.775, y: 0.7, z: 0.08 });
  g.add(solid(S));
  g.userData.footprint = { w: 1.7, d: 1.2 };
}

/** Nap Beanbag: two squashed spheres and a button. ~196 tris */
function buildBeanbag(g) {
  const S = [];
  sph(S, PAL.gold, 0.62, 10, 6, { sx: 1.18, sy: 0.7, sz: 1.18, y: 0.42 });
  sph(S, PAL.gold, 0.42, 8, 5, { sx: 1.05, sy: 0.6, sz: 1.05, y: 0.72, z: 0.05 });
  cyl(S, PAL.coral, 0.075, 0.075, 0.06, 8, { y: 0.85, z: 0.05 });
  g.add(solid(S));
  g.userData.footprint = { w: 1.6, d: 1.5 };
}

/** Round Rug: painted rings + a fringed border. ~72 tris */
function buildRugRound(g) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(1.25, 24), texRugRound());
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.014;
  m.receiveShadow = true;
  g.add(m);
  const S = [];
  part(S, new THREE.RingGeometry(1.25, 1.38, 24), PAL.linen, { rx: -Math.PI / 2, y: 0.012 });
  g.add(solid(S, { shadow: false }));
  g.userData.footprint = { w: 2.85, d: 2.85 };
}

/** Stripy Rug: woven bands with tasselled ends. ~26 tris */
function buildRugStripe(g) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.7), texRugStripe());
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.014;
  m.receiveShadow = true;
  g.add(m);
  const S = [];
  for (const s of [-1, 1]) box(S, PAL.linen, 2.6, 0.03, 0.12, { y: 0.012, z: s * 0.9 });
  g.add(solid(S, { shadow: false }));
  g.userData.footprint = { w: 2.75, d: 2.05 };
}

/** Low Table: plank top, under-shelf, a mug and two books. ~140 tris */
function buildLowTable(g) {
  const S = [];
  box(S, PAL.woodLight, 1.5, 0.12, 0.8, { y: 0.44 });
  box(S, PAL.wood, 1.3, 0.06, 0.6, { y: 0.16 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) box(S, PAL.wood, 0.1, 0.44, 0.1, { x: sx * 0.64, y: 0.22, z: sz * 0.31 });
  }
  cyl(S, PAL.cream, 0.09, 0.08, 0.15, 8, { x: 0.42, y: 0.575, z: 0.1 });
  box(S, PAL.cream, 0.05, 0.07, 0.03, { x: 0.53, y: 0.58, z: 0.1 });
  box(S, PAL.coral, 0.34, 0.05, 0.24, { x: -0.35, y: 0.525, z: -0.05 });
  box(S, PAL.sky, 0.3, 0.05, 0.22, { ry: 0.28, x: -0.35, y: 0.575, z: -0.05 });
  g.add(solid(S));
  g.userData.footprint = { w: 1.65, d: 0.95 };
}

/** Dining Set: pedestal table plus two chairs, places laid. ~336 tris */
function buildDiningSet(g) {
  const S = [];
  cyl(S, PAL.woodLight, 0.62, 0.62, 0.1, 14, { y: 0.72 });
  cyl(S, PAL.wood, 0.1, 0.14, 0.66, 8, { y: 0.39 });
  cyl(S, PAL.wood, 0.42, 0.46, 0.08, 12, { y: 0.04 });
  const chair = (z, ry) => {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const at = (lx, lz) => ({ x: lx * c + lz * s, z: -lx * s + lz * c });
    const p = at(0, 0);
    box(S, PAL.coral, 0.5, 0.1, 0.5, { ry, x: p.x, y: 0.45, z: z + p.z });
    const b = at(0, -0.22);
    box(S, PAL.coral, 0.5, 0.62, 0.09, { ry, x: b.x, y: 0.78, z: z + b.z });
    for (const lx of [-0.19, 0.19]) {
      for (const lz of [-0.19, 0.19]) {
        const l = at(lx, lz);
        box(S, PAL.wood, 0.09, 0.44, 0.09, { x: l.x, y: 0.22, z: z + l.z });
      }
    }
  };
  chair(0.98, Math.PI);
  chair(-0.98, 0);
  for (const z of [0.34, -0.34]) disc(S, PAL.cream, 0.16, 10, { rx: -Math.PI / 2, y: 0.775, z });
  cyl(S, PAL.sky, 0.06, 0.05, 0.1, 6, { x: 0.3, y: 0.82, z: 0.12 });
  g.add(solid(S));
  g.userData.footprint = { w: 1.4, d: 2.6 };
}

/** Dreamy Bed: headboard, duvet with a fold, pillows, one capy plush. ~296 tris */
function buildBed(g) {
  const S = [];
  box(S, PAL.wood, 1.9, 0.24, 2.7, { y: 0.3 });
  box(S, PAL.cream, 1.8, 0.26, 2.6, { y: 0.55 });
  box(S, PAL.coral, 1.86, 0.2, 1.9, { y: 0.76, z: 0.32 });
  box(S, PAL.blush, 1.86, 0.12, 0.26, { y: 0.86, z: -0.61 });
  for (const s of [-1, 1]) box(S, PAL.linen, 0.76, 0.18, 0.42, { x: s * 0.46, y: 0.77, z: -1.05 });
  box(S, PAL.woodLight, 2.0, 0.9, 0.14, { y: 1.0, z: -1.42 });
  cyl(S, PAL.woodLight, 0.09, 0.09, 2.0, 8, { rz: Math.PI / 2, y: 1.45, z: -1.42 });
  box(S, PAL.woodLight, 2.0, 0.4, 0.12, { y: 0.55, z: 1.42 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) box(S, PAL.woodDark, 0.16, 0.3, 0.16, { x: sx * 0.85, y: 0.15, z: sz * 1.22 });
  }
  // plush capy tucked against the pillows
  sph(S, PAL.fur, 0.17, 7, 4, { sx: 1.2, sy: 0.9, sz: 1.0, y: 0.98, z: -0.72 });
  sph(S, PAL.fur, 0.13, 7, 4, { y: 1.06, z: -0.52 });
  box(S, 0xc9a271, 0.12, 0.08, 0.1, { y: 1.03, z: -0.42 });
  for (const s of [-1, 1]) cone(S, PAL.woodDark, 0.05, 0.06, 3, { x: s * 0.09, y: 1.16, z: -0.55 });
  g.add(solid(S));
  g.userData.footprint = { w: 2.15, d: 3.15 };
}

/** Bookshelf: three loaded shelves plus a leaning pair and a top plant. ~190 tris */
function buildBookshelf(g) {
  const S = [];
  box(S, PAL.wood, 1.6, 1.9, 0.06, { y: 1.0, z: -0.19 });
  for (const s of [-1, 1]) box(S, PAL.woodLight, 0.08, 1.9, 0.42, { x: s * 0.8, y: 1.0 });
  box(S, PAL.woodLight, 1.72, 0.09, 0.46, { y: 1.98 });
  box(S, PAL.woodLight, 1.72, 0.12, 0.46, { y: 0.06 });
  for (const y of [0.55, 1.05, 1.55]) box(S, PAL.woodLight, 1.55, 0.06, 0.4, { y });
  // two strays leaning on the top board, next to the little plant
  box(S, PAL.sky, 0.16, 0.34, 0.2, { rz: 0.34, x: -0.28, y: 2.21, z: 0.02 });
  box(S, PAL.coral, 0.14, 0.3, 0.18, { rz: -0.2, x: -0.54, y: 2.19, z: 0.02 });
  cyl(S, PAL.amber, 0.11, 0.09, 0.14, 6, { x: 0.52, y: 2.09 });
  cone(S, PAL.leaf, 0.14, 0.32, 5, { x: 0.52, y: 2.3 });
  g.add(solid(S));
  // one merged, spine-painted block per shelf: one draw call for the lot
  const B = [];
  for (const [y, h] of [[0.79, 0.42], [1.29, 0.42], [1.76, 0.36]]) box(B, 0xffffff, 1.3, h, 0.24, { y });
  const books = new THREE.Mesh(mergeParts(B), texBooks());
  books.castShadow = true;
  books.receiveShadow = true;
  g.add(books);
  g.userData.footprint = { w: 1.85, d: 0.6 };
}

/** Floor Lamp: weighted base, thin stem, glowing drum shade. ~144 tris */
function buildFloorLamp(g) {
  const S = [];
  cyl(S, PAL.woodDark, 0.3, 0.34, 0.07, 12, { y: 0.035 });
  cyl(S, PAL.metal, 0.035, 0.035, 1.5, 6, { y: 0.8 });
  g.add(solid(S));
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.34, 0.42, 12, 1, true),
    makeToon(PAL.linen, { side: THREE.DoubleSide }),
  );
  shade.position.y = 1.66;
  shade.castShadow = true;
  g.add(shade);
  const G = [];
  disc(G, 0xffe3ac, 0.32, 12, { rx: Math.PI / 2, y: 1.47 });
  sph(G, 0xfff2cf, 0.1, 6, 4, { y: 1.62 });
  g.add(glow(G));
  g.userData.footprint = { w: 0.8, d: 0.8 };
}

/** String Lights: festoon strung between two slim poles, twinkling. ~320 tris */
function buildStringLights(g) {
  const S = [];
  for (const s of [-1, 1]) {
    cyl(S, PAL.woodLight, 0.04, 0.05, 1.7, 6, { x: s * 1.34, y: 0.85 });
    cyl(S, PAL.woodDark, 0.19, 0.21, 0.07, 6, { x: s * 1.34, y: 0.035 });
  }
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector3(-1.34 + t * 2.68, 1.64 - 0.4 * (1 - (2 * t - 1) ** 2), 0));
  }
  part(S, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.016, 3, false), PAL.ink);
  g.add(solid(S));

  const strands = [[], []];
  const bulbCols = [0xffe3ac, 0xffb9c6, 0xbfe6f5, 0xd9f7b0];
  for (let i = 1; i <= 7; i++) {
    const t = i / 8;
    const x = -1.34 + t * 2.68;
    const y = 1.64 - 0.4 * (1 - (2 * t - 1) ** 2) - 0.12;
    sph(strands[i % 2], bulbCols[i % bulbCols.length], 0.075, 5, 3, { x, y });
  }
  const bulbs = strands.map((L) => {
    const m = glow(L);
    m.name = 'anim';
    g.add(m);
    return m;
  });
  g.userData.update = (t) => {
    for (let i = 0; i < bulbs.length; i++) {
      const k = 0.72 + 0.28 * Math.sin(t * 2.4 + i * Math.PI);
      bulbs[i].userData.mat.color.setScalar(k);
    }
  };
  g.userData.footprint = { w: 3.15, d: 0.55 };
}

/** Potted Palm: chunky pot, kinked trunk, swaying fronds. ~250 tris */
function buildPlantPalm(g) {
  const S = [];
  cyl(S, PAL.amber, 0.3, 0.22, 0.42, 10, { y: 0.21 });
  cyl(S, 0xd98f52, 0.33, 0.33, 0.08, 10, { y: 0.44 });
  disc(S, PAL.woodDark, 0.28, 10, { rx: -Math.PI / 2, y: 0.475 });
  cyl(S, PAL.woodLight, 0.085, 0.1, 0.44, 6, { rz: 0.06, y: 0.68 });
  cyl(S, PAL.woodLight, 0.075, 0.085, 0.44, 6, { rz: -0.09, x: 0.03, y: 1.1 });
  cyl(S, PAL.woodLight, 0.065, 0.075, 0.42, 6, { rz: 0.05, x: 0.02, y: 1.51 });
  g.add(solid(S));

  const crown = new THREE.Group();
  crown.name = 'anim';
  crown.position.set(0.02, 1.7, 0);
  const F = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const geo = new THREE.ConeGeometry(0.15, 0.78, 4);
    geo.scale(1, 1, 0.28);
    geo.translate(0, 0.38, 0);
    geo.rotateZ(-1.12 - (i % 2) * 0.14);
    geo.rotateY(a);
    part(F, geo, i % 2 ? PAL.leaf : PAL.leafDark);
  }
  sph(F, PAL.woodDark, 0.09, 5, 3, { x: 0.12, y: -0.04, z: 0.08 });
  sph(F, PAL.woodDark, 0.08, 5, 3, { x: -0.1, y: -0.06, z: -0.05 });
  crown.add(solid(F));
  g.add(crown);
  g.userData.update = (t) => {
    crown.rotation.z = Math.sin(t * 1.1) * 0.045;
    crown.rotation.x = Math.sin(t * 0.83 + 1.4) * 0.035;
  };
  g.userData.footprint = { w: 1.5, d: 1.5 };
}

/** Flower Pot: two blooms, one bud, gently bobbing. ~302 tris */
function buildPlantFlower(g) {
  const S = [];
  cyl(S, PAL.coral, 0.24, 0.17, 0.3, 10, { y: 0.15 });
  cyl(S, PAL.blush, 0.27, 0.27, 0.06, 10, { y: 0.31 });
  disc(S, PAL.woodDark, 0.22, 10, { rx: -Math.PI / 2, y: 0.345 });
  const stems = [
    [0, 0.55, 0, 0],
    [-0.11, 0.44, 0.05, -0.12],
    [0.1, 0.36, -0.06, 0.14],
  ];
  for (const [x, h, z, rz] of stems) cyl(S, PAL.leafDark, 0.02, 0.026, h, 5, { rz, x, y: 0.34 + h / 2, z });
  for (const s of [-1, 1]) cone(S, PAL.leaf, 0.09, 0.26, 3, { sz: 0.4, rz: s * 1.1, x: s * 0.12, y: 0.5, z: 0.02 });
  g.add(solid(S));

  const blooms = new THREE.Group();
  blooms.name = 'anim';
  const B = [];
  const heads = [
    [0, 0.9, 0, PAL.gold, 0xfff2cf],
    [-0.15, 0.79, 0.05, PAL.plum, PAL.gold],
  ];
  for (const [x, y, z, petal, core] of heads) {
    for (let i = 0; i < 5; i++) {
      // rotateY(a) sends local +X to (cos a, 0, -sin a): the offset must match
      // the tilt direction or the petals detach from the flower head
      const a = (i / 5) * Math.PI * 2;
      cone(B, petal, 0.07, 0.15, 4, {
        rz: -1.25,
        ry: a,
        x: x + Math.cos(a) * 0.075,
        y,
        z: z - Math.sin(a) * 0.075,
      });
    }
    sph(B, core, 0.055, 5, 3, { x, y: y + 0.02, z });
  }
  sph(B, PAL.coral, 0.06, 5, 3, { sy: 1.4, x: 0.11, y: 0.73, z: -0.06 });
  blooms.add(solid(B));
  g.add(blooms);
  g.userData.update = (t) => {
    blooms.rotation.z = Math.sin(t * 1.6) * 0.06;
    blooms.position.y = Math.sin(t * 2.1) * 0.012;
  };
  g.userData.footprint = { w: 0.7, d: 0.7 };
}

/** Cozy Fireplace: stone surround, mantel clutter, flickering fire. ~222 tris */
function buildFireplace(g) {
  const S = [];
  box(S, PAL.ink, 1.4, 0.08, 0.56, { y: 0.16, z: 0.02 });
  for (const s of [-1, 1]) cyl(S, PAL.woodDark, 0.09, 0.09, 0.9, 6, { rz: Math.PI / 2, y: 0.26 + (s > 0 ? 0.13 : 0), z: s * 0.09 });
  box(S, PAL.cream, 0.24, 0.2, 0.12, { x: -0.72, y: 1.92, z: 0.06 });
  cyl(S, PAL.coral, 0.05, 0.05, 0.22, 6, { x: 0.66, y: 1.93 });
  cone(S, PAL.gold, 0.045, 0.11, 4, { x: 0.66, y: 2.09 });
  g.add(solid(S));

  const M = [];
  box(M, 0xffffff, 2.0, 0.12, 0.9, { y: 0.06, z: 0.1 });
  box(M, 0xffffff, 1.5, 1.3, 0.12, { y: 0.72, z: -0.32 });
  for (const s of [-1, 1]) box(M, 0xffffff, 0.34, 1.42, 0.62, { x: s * 0.86, y: 0.71, z: -0.02 });
  box(M, 0xffffff, 2.06, 0.28, 0.62, { y: 1.56, z: -0.02 });
  box(M, 0xffffff, 2.24, 0.12, 0.76, { y: 1.76 });
  const masonry = new THREE.Mesh(mergeParts(M), texStone());
  masonry.castShadow = true;
  masonry.receiveShadow = true;
  g.add(masonry);

  const F = [];
  const flames = [];
  for (const [x, h, c] of [[-0.24, 0.44, PAL.amber], [0.02, 0.58, PAL.gold], [0.26, 0.4, PAL.coral]]) {
    cone(F, c, 0.16, h, 6, { y: h / 2 });
    const m = glow(F);
    m.name = 'anim';
    m.position.set(x, 0.2, 0.0);
    g.add(m);
    flames.push(m);
  }
  const E = [];
  disc(E, 0xff9a4a, 0.42, 10, { rx: -Math.PI / 2 });
  const embers = glow(E);
  embers.name = 'anim';
  embers.position.set(0, 0.21, 0.02);
  g.add(embers);

  g.userData.update = (t) => {
    for (let i = 0; i < flames.length; i++) {
      const s = 0.82 + 0.26 * Math.sin(t * 6.1 + i * 2.2) + 0.08 * Math.sin(t * 13 + i);
      flames[i].scale.set(1.08 - (s - 1) * 0.4, s, 1.08 - (s - 1) * 0.4);
      flames[i].rotation.z = Math.sin(t * 4.3 + i * 1.7) * 0.13;
    }
    embers.userData.mat.color.setScalar(0.8 + 0.2 * Math.sin(t * 3.4));
  };
  g.userData.footprint = { w: 2.4, d: 1.05 };
}

/** Bubbly Aquarium: lit hood, gravel, castle, two fish doing laps. ~322 tris */
function buildAquarium(g) {
  const S = [];
  box(S, PAL.wood, 1.5, 0.1, 0.65, { y: 0.75 });
  box(S, PAL.wood, 1.3, 0.06, 0.5, { y: 0.2 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) box(S, PAL.woodDark, 0.1, 0.72, 0.1, { x: sx * 0.66, y: 0.36, z: sz * 0.25 });
  }
  box(S, 0xd8c79a, 1.34, 0.1, 0.5, { y: 0.85 });
  for (const [x, h] of [[-0.42, 0.34], [-0.28, 0.24], [0.5, 0.3]]) {
    cone(S, PAL.leafDark, 0.07, h, 4, { x, y: 0.9 + h / 2, z: -0.05 });
  }
  cyl(S, PAL.stone, 0.1, 0.12, 0.22, 6, { x: 0.2, y: 1.01, z: -0.02 });
  cone(S, PAL.coral, 0.12, 0.14, 5, { x: 0.2, y: 1.19, z: -0.02 });
  box(S, PAL.metal, 1.46, 0.1, 0.6, { y: 1.55 });
  g.add(solid(S));

  const T = [];
  box(T, 0xbfe6f5, 1.4, 0.7, 0.55, { y: 1.15 });
  g.add(glass(T, 0xbfe6f5, 0.26));

  const L = [];
  box(L, 0xfff2cf, 1.2, 0.03, 0.42, { y: 1.485 });
  g.add(glow(L));

  const fish = [];
  for (const [c, y, ph] of [[PAL.amber, 1.18, 0], [PAL.coral, 1.02, 2.4]]) {
    const F = [];
    sph(F, c, 0.09, 6, 4, { sx: 1.5, sy: 1, sz: 0.6 });
    cone(F, c, 0.06, 0.12, 3, { sz: 0.4, rz: Math.PI / 2, x: -0.15 });
    const m = solid(F, { shadow: false });
    m.name = 'anim';
    m.position.set(0, y, 0);
    m.userData.ph = ph;
    m.userData.baseY = y;
    g.add(m);
    fish.push(m);
  }
  const B = [];
  for (const [x, y, r] of [[0.44, 0, 0.035], [0.5, 0.1, 0.028], [0.4, 0.19, 0.032]]) {
    sph(B, 0xeaf9ff, r, 5, 3, { x, y });
  }
  const bubbles = glow(B, { fade: true });
  bubbles.name = 'anim';
  bubbles.position.y = 0.92; // update() drives this; seed it so frame 0 is right
  bubbles.scale.setScalar(0.6);
  g.add(bubbles);

  g.userData.update = (t) => {
    for (const f of fish) {
      const p = t * 0.55 + f.userData.ph;
      f.position.x = Math.sin(p) * 0.45;
      f.position.z = Math.sin(p * 0.7) * 0.11;
      f.position.y = f.userData.baseY + Math.sin(p * 1.9) * 0.045;
      f.rotation.y = Math.cos(p) >= 0 ? 0 : Math.PI;
    }
    const rise = (t * 0.3) % 1;
    bubbles.position.y = 0.92 + rise * 0.26;
    bubbles.scale.setScalar(0.6 + rise * 0.4);
    bubbles.userData.mat.opacity = Math.min(1, rise * 6) * (1 - rise * 0.8);
  };
  g.userData.footprint = { w: 1.65, d: 0.8 };
}

/** Mini Arcade: lit marquee, attract-mode screen, one bouncing blip. ~254 tris */
function buildArcadeCab(g) {
  const S = [];
  box(S, PAL.plum, 0.7, 1.5, 0.66, { y: 0.78 });
  box(S, PAL.ink, 0.74, 0.12, 0.7, { y: 0.06 });
  // control shelf tilts toward the player; screen bay leans back over it
  box(S, PAL.coral, 0.66, 0.1, 0.34, { rx: 0.35, y: 1.0, z: 0.3 });
  box(S, PAL.ink, 0.62, 0.5, 0.1, { rx: -0.18, y: 1.3, z: 0.3 });
  box(S, PAL.plum, 0.7, 0.1, 0.6, { y: 1.53 });
  box(S, PAL.ink, 0.7, 0.26, 0.2, { rx: 0.22, y: 1.7, z: 0.22 });
  cyl(S, PAL.metal, 0.03, 0.03, 0.14, 6, { rx: 0.35, x: -0.16, y: 1.09, z: 0.33 });
  sph(S, PAL.coral, 0.055, 6, 4, { x: -0.16, y: 1.16, z: 0.35 });
  for (let i = 0; i < 3; i++) {
    cyl(S, [PAL.gold, PAL.sky, PAL.leaf][i], 0.045, 0.045, 0.03, 6, {
      rx: 0.35,
      x: 0.05 + i * 0.12,
      y: 1.07,
      z: 0.32,
    });
  }
  box(S, PAL.metal, 0.16, 0.05, 0.02, { y: 0.66, z: 0.34 });
  g.add(solid(S));

  g.add(plate(0.5, 0.36, texArcadeScreen(), { y: 1.3, z: 0.355, rx: -0.18 }));
  g.add(plate(0.66, 0.24, texMarquee(), { y: 1.678, z: 0.32, rx: 0.22 }));

  const P = [];
  box(P, 0xfff2cf, 0.035, 0.035, 0.01);
  const blip = glow(P);
  blip.name = 'anim';
  blip.rotation.x = -0.18;
  blip.position.set(0, 1.3, 0.36); // seeded for frame 0; update() takes over
  g.add(blip);
  g.userData.update = (t) => {
    // the attract-mode ball, rallying against a painted-on opponent
    const bx = Math.sin(t * 2.6) * 0.17;
    const by = Math.sin(t * 3.9 + 1) * 0.11;
    blip.position.set(bx, 1.3 + by * 0.98, 0.36 - by * 0.18);
    blip.userData.mat.color.setScalar(0.85 + 0.15 * Math.sin(t * 9));
  };
  g.userData.footprint = { w: 0.9, d: 0.95 };
}

/** Trophy Case: glass front, two cups, a medal and a star. ~232 tris */
function buildTrophyCase(g) {
  const S = [];
  box(S, PAL.wood, 1.2, 1.5, 0.05, { y: 0.85, z: -0.22 });
  for (const s of [-1, 1]) box(S, PAL.woodLight, 0.06, 1.5, 0.44, { x: s * 0.6, y: 0.85 });
  box(S, PAL.woodLight, 1.3, 0.1, 0.5, { y: 1.65 });
  box(S, PAL.woodLight, 1.3, 0.16, 0.5, { y: 0.08 });
  for (const y of [0.62, 1.1]) box(S, PAL.woodLight, 1.1, 0.05, 0.4, { y });
  // big cup
  box(S, PAL.woodDark, 0.18, 0.07, 0.18, { x: -0.3, y: 1.165, z: -0.02 });
  cyl(S, PAL.gold, 0.04, 0.05, 0.13, 6, { x: -0.3, y: 1.265, z: -0.02 });
  cyl(S, PAL.gold, 0.14, 0.07, 0.2, 8, { x: -0.3, y: 1.43, z: -0.02 });
  for (const s of [-1, 1]) cone(S, PAL.gold, 0.05, 0.12, 4, { rz: s * 1.5, x: -0.3 + s * 0.17, y: 1.43, z: -0.02 });
  // runner-up cup
  box(S, PAL.woodDark, 0.14, 0.06, 0.14, { x: 0.3, y: 1.16, z: -0.02 });
  cyl(S, PAL.gold, 0.035, 0.045, 0.1, 6, { x: 0.3, y: 1.24, z: -0.02 });
  cyl(S, PAL.metal, 0.1, 0.05, 0.14, 8, { x: 0.3, y: 1.36, z: -0.02 });
  // medal hanging from the shelf above, star propped beside it
  box(S, PAL.coral, 0.07, 0.3, 0.02, { x: -0.18, y: 0.92, z: 0.0 });
  disc(S, PAL.gold, 0.075, 10, { x: -0.18, y: 0.73, z: 0.015 });
  cone(S, PAL.gold, 0.09, 0.06, 5, { rx: Math.PI / 2, x: 0.24, y: 0.735, z: 0.0 });
  g.add(solid(S));
  const G = [];
  box(G, 0xd8f0fa, 1.16, 1.42, 0.02, { y: 0.86, z: 0.2 });
  g.add(glass(G, 0xd8f0fa, 0.22));
  g.userData.footprint = { w: 1.45, d: 0.65 };
}

/** Wall Surfboard: extruded board silhouette on a little rack. ~118 tris */
function buildWallSurfboard(g) {
  const S = [];
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.02);
  shape.lineTo(0.17, 0.5);
  shape.lineTo(0.22, -0.12);
  shape.lineTo(0.17, -0.72);
  shape.lineTo(0.08, -0.98);
  shape.lineTo(-0.08, -0.98);
  shape.lineTo(-0.17, -0.72);
  shape.lineTo(-0.22, -0.12);
  shape.lineTo(-0.17, 0.5);
  shape.closePath();
  const board = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
  board.rotateX(-0.1);
  board.translate(0, 1.06, -0.04);
  part(S, board, PAL.cream);
  box(S, PAL.coral, 0.075, 1.6, 0.02, { rx: -0.1, x: -0.045, y: 1.09, z: 0.05 });
  box(S, PAL.sky, 0.05, 1.6, 0.02, { rx: -0.1, x: 0.06, y: 1.09, z: 0.05 });
  cone(S, PAL.coral, 0.09, 0.2, 3, { sz: 0.35, rx: Math.PI, x: 0, y: 0.18, z: -0.12 });
  for (const s of [-1, 1]) box(S, PAL.wood, 0.1, 0.5, 0.26, { x: s * 0.3, y: 0.25, z: -0.02 });
  box(S, PAL.woodDark, 0.9, 0.08, 0.36, { y: 0.04 });
  g.add(solid(S));
  g.userData.footprint = { w: 1.0, d: 0.5 };
}

/** Capy Portrait: painted canvas on a chunky easel. ~122 tris */
function buildCapyPortrait(g) {
  const S = [];
  // canvas plane basis: (u across, v up the tilted canvas, n out of it)
  const TH = 0.11;
  const ct = Math.cos(TH);
  const st = Math.sin(TH);
  const at = (u, v, n) => ({ x: u, y: 1.06 + v * ct - n * st, z: 0.02 + v * st + n * ct });
  for (const s of [-1, 1]) box(S, PAL.woodLight, 0.055, 1.34, 0.055, { rx: TH, x: s * 0.28, y: 0.67, z: 0.06 });
  box(S, PAL.woodLight, 0.055, 1.28, 0.055, { rx: -0.24, y: 0.64, z: -0.18 });
  box(S, PAL.wood, 0.62, 0.05, 0.05, { y: 0.56, z: 0.02 });
  box(S, PAL.wood, 0.72, 0.07, 0.15, { y: 0.75, z: 0.06 });
  box(S, PAL.woodDark, 0.68, 0.56, 0.04, { rx: TH, ...at(0, 0, 0) });
  for (const v of [0.31, -0.31]) box(S, PAL.gold, 0.72, 0.06, 0.05, { rx: TH, ...at(0, v, 0.01) });
  for (const s of [-1, 1]) box(S, PAL.gold, 0.06, 0.62, 0.05, { rx: TH, ...at(s * 0.33, 0, 0.01) });
  g.add(solid(S));
  g.add(plate(0.6, 0.5, texPortrait(), { rx: TH, ...at(0, 0, 0.028) }));
  g.userData.footprint = { w: 0.85, d: 0.65 };
}

/** Cocoa Station: urn, mugs, marshmallow jar, curling steam. ~308 tris */
function buildCocoaStation(g) {
  const S = [];
  box(S, PAL.coral, 1.3, 0.9, 0.6, { y: 0.47 });
  box(S, PAL.cream, 1.42, 0.1, 0.7, { y: 0.97 });
  box(S, PAL.woodDark, 1.2, 0.1, 0.5, { y: 0.05 });
  box(S, PAL.cream, 1.34, 0.07, 0.06, { y: 0.62, z: 0.31 });
  cyl(S, PAL.metal, 0.19, 0.21, 0.42, 12, { x: -0.34, y: 1.23 });
  cone(S, PAL.metal, 0.2, 0.12, 8, { x: -0.34, y: 1.5 });
  sph(S, PAL.coral, 0.045, 5, 3, { x: -0.34, y: 1.57 });
  box(S, PAL.woodDark, 0.07, 0.11, 0.09, { x: -0.34, y: 1.09, z: 0.21 });
  box(S, PAL.gold, 0.05, 0.03, 0.07, { x: -0.34, y: 1.16, z: 0.23 });
  for (const [x, z, c] of [[0.16, 0.12, PAL.sky], [0.34, -0.06, PAL.leaf]]) {
    cyl(S, c, 0.06, 0.05, 0.1, 6, { x, y: 1.07, z });
  }
  cyl(S, PAL.stone, 0.11, 0.11, 0.2, 8, { x: 0.56, y: 1.12 });
  box(S, PAL.cream, 0.15, 0.09, 0.15, { ry: 0.4, x: 0.56, y: 1.26 });
  cyl(S, PAL.woodLight, 0.03, 0.03, 0.4, 5, { x: 0.3, y: 1.22, z: -0.24 });
  g.add(solid(S));

  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.32, 0.04), texCocoaSign());
  sign.position.set(0.3, 1.5, -0.24);
  sign.castShadow = true;
  g.add(sign);

  const P = [];
  for (const [x, y, r] of [[0, 0, 0.055], [0.045, 0.14, 0.045], [-0.03, 0.26, 0.038]]) {
    sph(P, 0xfff6e3, r, 5, 3, { x, y });
  }
  const steam = glow(P, { fade: true });
  steam.name = 'anim';
  steam.position.set(-0.34, 1.58, 0);
  steam.scale.setScalar(0.5);
  g.add(steam);
  g.userData.update = (t) => {
    const p = (t * 0.42) % 1;
    steam.position.y = 1.58 + p * 0.3;
    steam.position.x = -0.34 + Math.sin(t * 1.6) * 0.05;
    steam.scale.setScalar(0.5 + p * 0.6);
    steam.userData.mat.opacity = Math.min(1, p * 5) * (1 - p) * 0.9;
  };
  g.userData.footprint = { w: 1.55, d: 0.85 };
}

const BUILDERS = {
  sofa: buildSofa,
  armchair: buildArmchair,
  beanbag: buildBeanbag,
  rug_round: buildRugRound,
  rug_stripe: buildRugStripe,
  low_table: buildLowTable,
  dining_set: buildDiningSet,
  bed: buildBed,
  bookshelf: buildBookshelf,
  floor_lamp: buildFloorLamp,
  string_lights: buildStringLights,
  plant_palm: buildPlantPalm,
  plant_flower: buildPlantFlower,
  fireplace: buildFireplace,
  aquarium: buildAquarium,
  arcade_cab: buildArcadeCab,
  trophy_case: buildTrophyCase,
  wall_surfboard: buildWallSurfboard,
  capy_portrait: buildCapyPortrait,
  cocoa_station: buildCocoaStation,
};

/**
 * Build one furniture item.
 * @param {string} id an id from the shared FURNITURE catalog
 * @returns {THREE.Group|null} group with userData.footprint {w,d}, userData.furnId
 *   and (for lively pieces) userData.update(t). null for unknown ids.
 */
export function buildFurniture(id) {
  const make = Object.prototype.hasOwnProperty.call(BUILDERS, id) ? BUILDERS[id] : null;
  if (!make) return null;
  const g = new THREE.Group();
  g.name = `furn:${id}`;
  g.userData.furnId = id;
  make(g);
  if (!g.userData.footprint) g.userData.footprint = { w: 1, d: 1 };
  return g;
}

/** Footprint without building the mesh (editor grids, collision radii). */
export function furnitureFootprint(id) {
  return Object.prototype.hasOwnProperty.call(FOOTPRINTS, id) ? FOOTPRINTS[id] : { w: 1, d: 1 };
}

// Kept in sync with the builders above; buildFurniture is the source of truth
// and the verification script asserts these match.
const FOOTPRINTS = {
  sofa: { w: 2.65, d: 1.3 },
  armchair: { w: 1.7, d: 1.2 },
  beanbag: { w: 1.6, d: 1.5 },
  rug_round: { w: 2.85, d: 2.85 },
  rug_stripe: { w: 2.75, d: 2.05 },
  low_table: { w: 1.65, d: 0.95 },
  dining_set: { w: 1.4, d: 2.6 },
  bed: { w: 2.15, d: 3.15 },
  bookshelf: { w: 1.85, d: 0.6 },
  floor_lamp: { w: 0.8, d: 0.8 },
  string_lights: { w: 3.15, d: 0.55 },
  plant_palm: { w: 1.5, d: 1.5 },
  plant_flower: { w: 0.7, d: 0.7 },
  fireplace: { w: 2.4, d: 1.05 },
  aquarium: { w: 1.65, d: 0.8 },
  arcade_cab: { w: 0.9, d: 0.95 },
  trophy_case: { w: 1.45, d: 0.65 },
  wall_surfboard: { w: 1.0, d: 0.5 },
  capy_portrait: { w: 0.85, d: 0.65 },
  cocoa_station: { w: 1.55, d: 0.85 },
};
