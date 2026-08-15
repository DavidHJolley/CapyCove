import * as THREE from 'three';
import { buildFurniture, furnitureFootprint } from './furniture.js';
import { makeToon, makeGlow } from '../core/materials.js';
import { ROOM_IDS, MINIGAMES, FURNITURE } from '../../shared/constants.js';

/**
 * The client layout store: room layout OVERRIDES, the prop catalog, and the
 * pass that folds a published layout onto a freshly built room.
 *
 * A room is code, not a scene file, and everything a station owns (its sign,
 * chairs, prompt zones, obstacle circles, glow rings) is derived from numbers
 * at build time. So the editor never persists meshes. It persists a small
 * document of OPS, and this module applies them:
 *
 *   1. handle ops   -> getHandles(roomId), read by the room at the TOP of
 *                      build() (lounge.js's applyStationOverrides). These have
 *                      to land before the build, because the build derives a
 *                      dozen things from them.
 *   2. everything else -> applyLayout(room, scene, game), run by the engine
 *                      straight after room.build().
 *
 * Ops (docs/research/level-editor.md section 4):
 *   {op:'prop',     id, cat, p:[x,y,z], ry, s, tint?, col?, yLock?, lock?}
 *   {op:'xform',    id:'room/tag', p?, ry?, s?}
 *   {op:'hide',     id:'room/tag'}
 *   {op:'handle',   id:'room/prop', set:{...}}
 *   {op:'collider', id, x, z, r}          r:0 disables a tagged code collider
 *   {op:'hotspot',  id, kind, to, x, z, r, label}
 *   {op:'spawn',    id, p:[x,y,z]}
 *   {op:'cam',      id:'static'|'bm_N', ...}
 *   {op:'group',    id, name, members:[]}  editor-only
 *
 * Two rules this file exists to enforce:
 *  - A LAYOUT OP CAN NEVER EXPRESS A FUNCTION. A hotspot carries `kind` + a
 *    validated `to`; the callable is resolved here from a fixed table. Same
 *    reasoning that palette-locks the mural: an op carries an index, never a
 *    colour, and never a callback.
 *  - Code wins on existence, data wins on properties. If the room stops
 *    building the fountain, the fountain is gone whatever the layout says; the
 *    op is KEPT and reported as an orphan rather than silently dropped, because
 *    silently dropping orphans is how a month of layout work evaporates with no
 *    diff to point at.
 *
 * Dens ('house:<owner>') are deliberately excluded: they have their own
 * per-player placement system in src/ui/houseEditor.js and a different trust
 * model.
 *
 * Server seam (wave: E1 owns it, docs/research/level-editor.md section 5):
 *   GET /api/layout/:room -> {room, rev, base, ops}
 *   ws layout-open/close/draft/publish/revert/reset -> layout-doc/ack/rev
 * Validation here is the SAME shape the server enforces; it exists so the
 * editor can refuse an op before the round trip, never instead of the server.
 */

// ---------------------------------------------------------------------------
// format, caps, palette
// ---------------------------------------------------------------------------

export const LAYOUT_V = 1;

export const OP_KINDS = Object.freeze([
  'prop', 'xform', 'hide', 'handle', 'collider', 'hotspot', 'spawn', 'cam', 'group',
]);

/** Mirrors the server's caps (level-editor.md 5.4). Both sides check. */
export const LAYOUT_CAPS = Object.freeze({
  ops: 400,
  props: 120,
  animated: 24,
  colliders: 60,
  hotspots: 24,
  bytes: 64 * 1024,
});

const LIMIT = Object.freeze({ xz: 200, y: 40, s: [0.25, 4], r: [0, 8], label: 40, name: 24 });

/**
 * `tint` is an INDEX, never a colour: the same 14 entries the mural paints
 * with (DESIGN.md's anchor palette plus cream and ink). Free-form colour is the
 * one thing that would let a layout leave the art style.
 */
export const TINTS = Object.freeze([
  0xfff6e3, 0x2d2417, 0xf0dca0, 0xf2b64a, 0xf2a541, 0xe8657a, 0xf29ab0,
  0x9b6bd4, 0x2a2038, 0x4fb3e8, 0x42d6c8, 0x7ac74f, 0xb08a5a, 0x6b4f35,
]);

const ID_RE = /^[a-z0-9_./-]{1,48}$/i;
const HOTSPOT_KINDS = Object.freeze(['exit', 'game', 'sign']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A room id this system may write. Dens and unknown ids are refused. */
export const isLayoutRoom = (id) => typeof id === 'string' && ROOM_IDS.includes(id);

// ---------------------------------------------------------------------------
// the prop catalog
// ---------------------------------------------------------------------------

/**
 * Tier 1 is free: src/world/furniture.js already satisfies a prop contract
 * (self-contained Group, y=0 at the floor, facing +Z, userData.footprint).
 * Tier 2 is the small outdoor set below, so the palette is useful in the plaza,
 * the beach and the peak on day one and not only in a den.
 *
 * Later tranches (level-editor.md 3.3) belong in src/world/props/<group>.js
 * behind buildProp(); this table is the registry they plug into.
 */
const DEN_GROUP = { den: 'Den & indoor' };

const ANIMATED = new Set([
  'string_lights', 'plant_palm', 'plant_flower', 'fireplace',
  'aquarium', 'arcade_cab', 'cocoa_station', 'gramophone',
]);

export const PROP_GROUPS = Object.freeze([
  { id: 'den', name: 'Den & indoor' },
  { id: 'cove', name: 'Outdoor' },
]);

/** id -> {name, group, animated, footprint}. The server-validatable half. */
export const PROPS = (() => {
  const out = {};
  for (const [id, meta] of Object.entries(FURNITURE)) {
    out[id] = {
      name: meta.name,
      group: 'den',
      animated: ANIMATED.has(id),
      footprint: furnitureFootprint(id),
    };
  }
  const cove = {
    bench_wood: { name: 'Cove Bench', footprint: { w: 2.2, d: 0.8 } },
    lamp_post: { name: 'Lamp Post', footprint: { w: 0.5, d: 0.5 } },
    planter: { name: 'Planter Box', footprint: { w: 1.3, d: 0.9 } },
    sign_post: { name: 'Sign Post', footprint: { w: 1.1, d: 0.3 } },
    crate: { name: 'Cargo Crate', footprint: { w: 1.0, d: 1.0 } },
    boulder: { name: 'Boulder', footprint: { w: 1.6, d: 1.5 } },
    pine_small: { name: 'Little Pine', footprint: { w: 1.4, d: 1.4 } },
  };
  for (const [id, meta] of Object.entries(cove)) out[id] = { ...meta, group: 'cove', animated: false };
  return Object.freeze(out);
})();

export const PROP_IDS = Object.freeze(Object.keys(PROPS));

export const isPropId = (id) => typeof id === 'string' && own(PROPS, id);

export function propMeta(id) {
  return own(PROPS, id) ? PROPS[id] : null;
}

export function propFootprint(id) {
  return propMeta(id)?.footprint || { w: 1, d: 1 };
}

// ---- the outdoor tranche --------------------------------------------------
// Same contract as furniture.js and the same assembly trick: build primitives,
// paint them into vertex colours, concatenate into ONE geometry so a placed
// prop costs one draw call whether it has three parts or twelve.

const _col = new THREE.Color();

function paint(geo, hex) {
  _col.set(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function part(list, geo, hex, tf) {
  if (tf) {
    if (tf.sx !== undefined || tf.sy !== undefined || tf.sz !== undefined) geo.scale(tf.sx ?? 1, tf.sy ?? 1, tf.sz ?? 1);
    if (tf.rz) geo.rotateZ(tf.rz);
    if (tf.rx) geo.rotateX(tf.rx);
    if (tf.ry) geo.rotateY(tf.ry);
    if (tf.x || tf.y || tf.z) geo.translate(tf.x || 0, tf.y || 0, tf.z || 0);
  }
  paint(geo, hex);
  list.push(geo);
  return geo;
}

const bx = (L, hex, w, h, d, tf) => part(L, new THREE.BoxGeometry(w, h, d), hex, tf);
const cy = (L, hex, rt, rb, h, seg, tf) => part(L, new THREE.CylinderGeometry(rt, rb, h, seg), hex, tf);
const cn = (L, hex, r, h, seg, tf) => part(L, new THREE.ConeGeometry(r, h, seg), hex, tf);
const ic = (L, hex, r, det, tf) => part(L, new THREE.IcosahedronGeometry(r, det), hex, tf);

/** Concatenate coloured parts into one geometry. Empties the list. */
function merge(list) {
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
  let o = 0;
  for (const g of src) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  list.length = 0;
  return out;
}

function solid(list) {
  const m = new THREE.Mesh(merge(list), makeToon(0xffffff, { vertexColors: true }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const P = {
  wood: 0x8a6642, woodLight: 0xb08a5a, woodDark: 0x6b4f35, cream: 0xfff6e3,
  stone: 0xd8cdb6, stoneDark: 0xb2a58a, leaf: 0x7ac74f, leafDark: 0x4d8c39,
  metal: 0xbcc6cd, gold: 0xf2b64a, coral: 0xe8657a, sand: 0xf0dca0,
};

const COVE_BUILDERS = {
  bench_wood(g) {
    const L = [];
    for (const x of [-0.85, 0.85]) {
      bx(L, P.woodDark, 0.16, 0.42, 0.6, { x, y: 0.21 });
      bx(L, P.woodDark, 0.14, 0.6, 0.14, { x, y: 0.6, z: -0.22 });
    }
    for (let i = 0; i < 3; i++) bx(L, P.woodLight, 2.1, 0.09, 0.17, { y: 0.46, z: -0.18 + i * 0.19 });
    for (let i = 0; i < 2; i++) bx(L, P.wood, 2.0, 0.16, 0.08, { y: 0.72 + i * 0.22, z: -0.26 });
    g.add(solid(L));
  },
  lamp_post(g) {
    const L = [];
    cy(L, P.stoneDark, 0.22, 0.28, 0.16, 10, { y: 0.08 });
    cy(L, P.woodDark, 0.08, 0.1, 2.5, 8, { y: 1.3 });
    bx(L, P.woodDark, 0.5, 0.07, 0.07, { y: 2.5, x: 0.2 });
    g.add(solid(L));
    const G = [];
    ic(G, 0xfff0b8, 0.2, 1, { y: 2.36, x: 0.4 });
    const bulb = new THREE.Mesh(merge(G), makeGlow(0xffffff, { unique: true }));
    bulb.material.vertexColors = true;
    g.add(bulb);
  },
  planter(g) {
    const L = [];
    bx(L, P.wood, 1.2, 0.46, 0.8, { y: 0.23 });
    bx(L, P.woodDark, 1.26, 0.09, 0.86, { y: 0.48 });
    bx(L, 0x4a3a28, 1.06, 0.06, 0.66, { y: 0.5 });
    ic(L, P.leaf, 0.3, 0, { y: 0.66, x: -0.3, sy: 0.8 });
    ic(L, P.leafDark, 0.26, 0, { y: 0.62, x: 0.12, z: 0.1, sy: 0.8 });
    ic(L, P.leaf, 0.22, 0, { y: 0.6, x: 0.38, z: -0.1, sy: 0.8 });
    g.add(solid(L));
  },
  sign_post(g) {
    const L = [];
    cy(L, P.woodDark, 0.07, 0.09, 1.5, 8, { y: 0.75 });
    bx(L, P.woodLight, 1.0, 0.44, 0.08, { y: 1.42 });
    bx(L, P.cream, 0.86, 0.3, 0.03, { y: 1.42, z: 0.05 });
    g.add(solid(L));
  },
  crate(g) {
    const L = [];
    bx(L, P.wood, 0.9, 0.9, 0.9, { y: 0.45 });
    for (const z of [-0.46, 0.46]) bx(L, P.woodDark, 0.94, 0.1, 0.03, { y: 0.24, z });
    for (const z of [-0.46, 0.46]) bx(L, P.woodDark, 0.94, 0.1, 0.03, { y: 0.68, z });
    for (const x of [-0.46, 0.46]) bx(L, P.woodDark, 0.03, 0.1, 0.94, { y: 0.24, x });
    for (const x of [-0.46, 0.46]) bx(L, P.woodDark, 0.03, 0.1, 0.94, { y: 0.68, x });
    g.add(solid(L));
  },
  boulder(g) {
    const L = [];
    ic(L, P.stone, 0.66, 0, { y: 0.5, sy: 0.82 });
    ic(L, P.stoneDark, 0.3, 0, { y: 0.28, x: 0.52, z: 0.2, sy: 0.8 });
    ic(L, P.stone, 0.22, 0, { y: 0.2, x: -0.5, z: -0.28 });
    g.add(solid(L));
  },
  pine_small(g) {
    const L = [];
    cy(L, P.woodDark, 0.12, 0.16, 0.7, 7, { y: 0.35 });
    cn(L, P.leafDark, 0.68, 1.0, 8, { y: 1.0 });
    cn(L, P.leaf, 0.52, 0.85, 8, { y: 1.55 });
    cn(L, P.leaf, 0.34, 0.6, 8, { y: 2.05 });
    g.add(solid(L));
  },
};

/**
 * Build one catalog prop.
 * @returns {THREE.Group|null} y=0 at the floor, facing +Z, userData.footprint.
 */
export function buildProp(id) {
  if (!isPropId(id)) return null;
  if (PROPS[id].group === 'den') {
    const f = buildFurniture(id);
    if (f) f.userData.propId = id;
    return f;
  }
  const make = own(COVE_BUILDERS, id) ? COVE_BUILDERS[id] : null;
  if (!make) return null;
  const g = new THREE.Group();
  g.name = `prop:${id}`;
  g.userData.propId = id;
  try { make(g); } catch (e) { console.error(`[layout] prop '${id}' failed to build:`, e); }
  g.userData.footprint = propFootprint(id);
  return g;
}

// ---------------------------------------------------------------------------
// op normalisation and validation
// ---------------------------------------------------------------------------

/** Last op with a given key wins, so an append-only draft normalises cleanly. */
export const opKey = (o) => `${o?.op}:${o?.id}`;

function cleanVec(v, { y = true } = {}) {
  // A tolerant reader: the wire shape is [x, y, z], but src/world/overlay.js
  // stores its normalised copy as {x, y, z}, and a document may come back to us
  // through either one.
  if (v && !Array.isArray(v) && typeof v === 'object' && 'x' in v && 'z' in v) {
    v = [v.x, v.y ?? 0, v.z];
  }
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = num(Number(v[0]));
  const yy = v.length >= 3 ? num(Number(v[1])) : 0;
  const z = num(Number(v.length >= 3 ? v[2] : v[1]));
  if (Number.isNaN(x) || Number.isNaN(z) || (y && Number.isNaN(yy))) return null;
  return [
    r2(clamp(x, -LIMIT.xz, LIMIT.xz)),
    r2(clamp(yy, -LIMIT.y, LIMIT.y)),
    r2(clamp(z, -LIMIT.xz, LIMIT.xz)),
  ];
}

const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Clean one op or return null. Rejection is per-op here; validateOps turns it
 * into the all-or-nothing answer the server gives, so the editor can never show
 * something the server would not have kept.
 */
export function normalizeOp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const op = String(raw.op || '');
  const id = String(raw.id || '');
  if (!OP_KINDS.includes(op) || !ID_RE.test(id)) return null;

  if (op === 'prop') {
    if (!isPropId(raw.cat)) return null;
    const p = cleanVec(raw.p);
    if (!p) return null;
    const out = { op, id, cat: raw.cat, p, ry: r3(num(Number(raw.ry)) || 0), s: r3(clamp(num(Number(raw.s)) || 1, LIMIT.s[0], LIMIT.s[1])) };
    if (raw.tint !== undefined && raw.tint !== null) {
      const t = Math.floor(Number(raw.tint));
      if (Number.isFinite(t) && t >= 0 && t < TINTS.length) out.tint = t;
    }
    if (raw.col !== undefined && raw.col !== null) {
      const c = num(Number(raw.col));
      if (!Number.isNaN(c)) out.col = r2(clamp(c, LIMIT.r[0], LIMIT.r[1]));
    }
    if (raw.yLock) out.yLock = true;
    if (raw.lock) out.lock = true;
    return out;
  }

  if (op === 'xform') {
    const out = { op, id };
    if (raw.p !== undefined) { const p = cleanVec(raw.p); if (!p) return null; out.p = p; }
    if (raw.ry !== undefined) { const v = num(Number(raw.ry)); if (Number.isNaN(v)) return null; out.ry = r3(v); }
    if (raw.s !== undefined) { const v = num(Number(raw.s)); if (Number.isNaN(v)) return null; out.s = r3(clamp(v, LIMIT.s[0], LIMIT.s[1])); }
    return out.p || out.ry !== undefined || out.s !== undefined ? out : null;
  }

  if (op === 'hide') return { op, id };

  if (op === 'handle') {
    if (!raw.set || typeof raw.set !== 'object' || Array.isArray(raw.set)) return null;
    const set = {};
    for (const [k, v] of Object.entries(raw.set)) {
      if (!/^[a-z0-9_.]{1,24}$/i.test(k)) return null;
      if (typeof v === 'number') { if (!Number.isFinite(v)) return null; set[k] = r3(v); continue; }
      if (!Array.isArray(v)) return null;
      // a pair [x,z], or an array of pairs (a station's seats)
      if (Array.isArray(v[0])) {
        const rows = v.map((q) => (Array.isArray(q) && q.length === 2
          ? [r2(clamp(num(Number(q[0])), -LIMIT.xz, LIMIT.xz)), r2(clamp(num(Number(q[1])), -LIMIT.xz, LIMIT.xz))]
          : null));
        if (rows.some((q) => !q || q.some(Number.isNaN))) return null;
        set[k] = rows;
      } else {
        if (v.length !== 2) return null;
        const pair = [r2(clamp(num(Number(v[0])), -LIMIT.xz, LIMIT.xz)), r2(clamp(num(Number(v[1])), -LIMIT.xz, LIMIT.xz))];
        if (pair.some(Number.isNaN)) return null;
        set[k] = pair;
      }
    }
    return Object.keys(set).length ? { op, id, set } : null;
  }

  if (op === 'collider') {
    const out = { op, id };
    const r = num(Number(raw.r));
    if (Number.isNaN(r)) return null;
    out.r = r2(clamp(r, LIMIT.r[0], LIMIT.r[1]));
    if (raw.x !== undefined || raw.z !== undefined) {
      const x = num(Number(raw.x)); const z = num(Number(raw.z));
      if (Number.isNaN(x) || Number.isNaN(z)) return null;
      out.x = r2(clamp(x, -LIMIT.xz, LIMIT.xz));
      out.z = r2(clamp(z, -LIMIT.xz, LIMIT.xz));
    }
    return out;
  }

  if (op === 'hotspot') {
    const out = { op, id };
    if (raw.kind !== undefined) {
      if (!HOTSPOT_KINDS.includes(raw.kind)) return null;
      out.kind = raw.kind;
    }
    if (raw.to !== undefined) {
      const to = String(raw.to || '');
      if (out.kind === 'exit' && !ROOM_IDS.includes(to)) return null;
      if (out.kind === 'game' && !own(MINIGAMES, to)) return null;
      out.to = to;
    }
    if (out.kind === 'exit' || out.kind === 'game') { if (!out.to) return null; }
    if (raw.x !== undefined || raw.z !== undefined) {
      const x = num(Number(raw.x)); const z = num(Number(raw.z));
      if (Number.isNaN(x) || Number.isNaN(z)) return null;
      out.x = r2(clamp(x, -LIMIT.xz, LIMIT.xz));
      out.z = r2(clamp(z, -LIMIT.xz, LIMIT.xz));
    }
    if (raw.r !== undefined) {
      const r = num(Number(raw.r));
      if (Number.isNaN(r)) return null;
      out.r = r2(clamp(r, LIMIT.r[0], LIMIT.r[1]));
    }
    if (raw.label !== undefined) out.label = cleanText(raw.label, LIMIT.label);
    return out;
  }

  if (op === 'spawn') {
    const p = cleanVec(raw.p);
    return p ? { op, id, p } : null;
  }

  if (op === 'cam') {
    if (id === 'static') {
      const p = cleanVec(raw.p);
      const look = cleanVec(raw.look);
      return p && look ? { op, id, p, look } : null;
    }
    const target = cleanVec(raw.target);
    if (!target) return null;
    const out = {
      op, id, target,
      dist: r2(clamp(num(Number(raw.dist)) || 18, 1.5, 240)),
      yaw: r3(num(Number(raw.yaw)) || 0),
      pitch: r3(clamp(num(Number(raw.pitch)) || 0.9, -0.2, 1.45)),
    };
    if (raw.name) out.name = cleanText(raw.name, LIMIT.name);
    return out;
  }

  if (op === 'group') {
    const members = Array.isArray(raw.members)
      ? raw.members.filter((m) => typeof m === 'string' && ID_RE.test(m)).slice(0, 64)
      : [];
    return members.length ? { op, id, name: cleanText(raw.name, LIMIT.name), members } : null;
  }

  return null;
}

/** Clean every op, last-wins per key, in a stable order. */
export function normalizeOps(ops) {
  const byKey = new Map();
  for (const raw of Array.isArray(ops) ? ops : []) {
    const o = normalizeOp(raw);
    if (o) byKey.set(opKey(o), o);
  }
  return [...byKey.values()];
}

/**
 * The all-or-nothing gate, modelled on the den's validatePlacements: one bad op
 * rejects the whole document. Never store a partially cleaned layout.
 */
export function validateOps(ops, { room } = {}) {
  if (room !== undefined && !isLayoutRoom(room)) return { ok: false, clean: [], msg: `'${room}' has no layout` };
  const list = Array.isArray(ops) ? ops : null;
  if (!list) return { ok: false, clean: [], msg: 'ops must be a list' };
  if (list.length > LAYOUT_CAPS.ops) return { ok: false, clean: [], msg: `too many ops (max ${LAYOUT_CAPS.ops})` };

  const clean = [];
  const seen = new Set();
  const count = { prop: 0, animated: 0, collider: 0, hotspot: 0 };
  for (const raw of list) {
    const o = normalizeOp(raw);
    if (!o) return { ok: false, clean: [], msg: `bad ${raw?.op || 'op'} '${raw?.id || '?'}'` };
    const k = opKey(o);
    if (seen.has(k)) return { ok: false, clean: [], msg: `duplicate op ${k}` };
    seen.add(k);
    if (o.op === 'prop') { count.prop++; if (PROPS[o.cat].animated) count.animated++; }
    if (o.op === 'collider') count.collider++;
    if (o.op === 'hotspot') count.hotspot++;
    clean.push(o);
  }
  if (count.prop > LAYOUT_CAPS.props) return { ok: false, clean: [], msg: `too many props (max ${LAYOUT_CAPS.props})` };
  if (count.animated > LAYOUT_CAPS.animated) return { ok: false, clean: [], msg: `too many animated props (max ${LAYOUT_CAPS.animated})` };
  if (count.collider > LAYOUT_CAPS.colliders) return { ok: false, clean: [], msg: `too many colliders (max ${LAYOUT_CAPS.colliders})` };
  if (count.hotspot > LAYOUT_CAPS.hotspots) return { ok: false, clean: [], msg: `too many hotspots (max ${LAYOUT_CAPS.hotspots})` };
  const bytes = JSON.stringify(clean).length;
  if (bytes > LAYOUT_CAPS.bytes) return { ok: false, clean: [], msg: `document too large (${(bytes / 1024) | 0}KB)` };
  return { ok: true, clean, msg: '' };
}

/** `b` on top of `a`, last-wins per op key. */
export function mergeOps(a, b) {
  const byKey = new Map();
  for (const o of a || []) byKey.set(opKey(o), o);
  for (const o of b || []) byKey.set(opKey(o), o);
  return [...byKey.values()];
}

/** What changed between two op lists, for the publish confirmation. */
export function diffOps(from, to) {
  const A = new Map((from || []).map((o) => [opKey(o), o]));
  const B = new Map((to || []).map((o) => [opKey(o), o]));
  const out = { added: [], changed: [], removed: [] };
  for (const [k, o] of B) {
    if (!A.has(k)) out.added.push(o);
    else if (JSON.stringify(A.get(k)) !== JSON.stringify(o)) out.changed.push(o);
  }
  for (const [k, o] of A) if (!B.has(k)) out.removed.push(o);
  return out;
}

/** One human line for a diff: "+6 props, 3 moved, 1 collider added". */
export function describeDiff(d) {
  const bits = [];
  const byKind = (list) => {
    const m = new Map();
    for (const o of list) m.set(o.op, (m.get(o.op) || 0) + 1);
    return [...m].map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ');
  };
  if (d.added.length) bits.push(`+${byKind(d.added)}`);
  if (d.changed.length) bits.push(`${byKind(d.changed)} changed`);
  if (d.removed.length) bits.push(`-${byKind(d.removed)}`);
  return bits.join(' - ') || 'no changes';
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/** roomId -> {rev, base, ops, at} as published by the server. */
const docs = new Map();
/** roomId -> ops[]: MY unpublished draft. Local only; nobody else ever sees it. */
const drafts = new Map();
/** roomId -> Map(propId -> patch): session-only handle edits (the old behaviour). */
const session = new Map();
/** roomId -> Promise, so ten callers cause one fetch. */
const inflight = new Map();
/** roomId -> report from the last applyLayout (orphans, counts). */
const reports = new Map();

let handleCache = new Map();
let refreshHook = null;

const bumpHandles = () => { handleCache = new Map(); };

/** The engine registers "the room I am standing in changed under me". */
export function setRefreshHook(fn) {
  refreshHook = typeof fn === 'function' ? fn : null;
}

function fireRefresh(roomId) {
  if (!refreshHook) return;
  try { refreshHook(roomId); } catch (e) { console.error('[layout] refresh hook:', e); }
}

/** The ops that should build right now: my draft if I have one, else published. */
export function activeOps(roomId) {
  if (drafts.has(roomId)) return drafts.get(roomId);
  return docs.get(roomId)?.ops || [];
}

export function docFor(roomId) {
  return docs.get(roomId) || null;
}

export function revOf(roomId) {
  return docs.get(roomId)?.rev || 0;
}

export function hasDraft(roomId) {
  return drafts.has(roomId);
}

export function draftOps(roomId) {
  return drafts.get(roomId) || null;
}

/** The editor's live document. Applied on the next build; never sent anywhere. */
export function setDraft(roomId, ops) {
  drafts.set(roomId, normalizeOps(ops));
  bumpHandles();
}

export function clearDraft(roomId) {
  drafts.delete(roomId);
  bumpHandles();
}

/** Store a published document (from HTTP or from a `layout-doc` frame). */
export function setDoc(roomId, doc) {
  if (!isLayoutRoom(roomId)) return null;
  const clean = normalizeOps(doc?.ops);
  const rec = {
    rev: Math.max(0, Math.floor(Number(doc?.rev) || 0)),
    base: typeof doc?.base === 'string' ? doc.base : '',
    ops: clean,
    at: Date.now(),
  };
  docs.set(roomId, rec);
  bumpHandles();
  return rec;
}

export function evict(roomId) {
  if (roomId) { docs.delete(roomId); inflight.delete(roomId); } else { docs.clear(); inflight.clear(); }
  bumpHandles();
}

/**
 * Fetch a room's published layout, once per session per room.
 *
 * Never rejects and never blocks a room: `timeout` resolves null while the
 * request keeps going in the background, and a late arrival calls the refresh
 * hook so the engine can rebuild in place (rebuildRoom keeps the player where
 * they stand, which is exactly the primitive this needs).
 */
export function ensure(roomId, { timeout = 250 } = {}) {
  if (!isLayoutRoom(roomId)) return Promise.resolve(null);
  if (docs.has(roomId)) return Promise.resolve(docs.get(roomId));

  let req = inflight.get(roomId);
  if (!req) {
    req = fetch(`/api/layout/${encodeURIComponent(roomId)}`, { credentials: 'same-origin' })
      .then((res) => {
        if (res.status === 404) return { rev: 0, base: '', ops: [] }; // no layout yet: pure code
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((doc) => {
        const rec = setDoc(roomId, doc);
        return rec;
      })
      .catch((e) => {
        // A missing layout must never block entering a room.
        console.warn(`[layout] ${roomId}: ${e?.message || e}`);
        return null;
      })
      .finally(() => { inflight.delete(roomId); });
    inflight.set(roomId, req);
    // a late arrival still lands, in the room the player is standing in
    req.then((rec) => { if (rec?.ops?.length) fireRefresh(roomId); });
  }
  if (!timeout) return req;
  return Promise.race([req, new Promise((r) => setTimeout(() => r(null), timeout))]);
}

/** `layout-rev` from the server: drop the cache, refetch, rebuild if visible. */
export function applyRev(m) {
  const roomId = m?.room;
  if (!isLayoutRoom(roomId)) return;
  const wasDraft = drafts.has(roomId);
  evict(roomId);
  ensure(roomId, { timeout: 0 }).then(() => { if (!wasDraft) fireRefresh(roomId); });
}

// ---- handles (read by rooms at the TOP of build) --------------------------

/**
 * The handle patches for a room: published/draft `handle` ops with this
 * session's unsaved pin drags on top.
 *
 * `getOverrides` is the name lounge.js has always called (its
 * applyStationOverrides), and keeping it means published handle edits reach
 * every player with NO edit to the room file at all.
 */
export function getHandles(roomId) {
  if (handleCache.has(roomId)) return handleCache.get(roomId);
  const out = new Map();
  for (const o of activeOps(roomId)) {
    if (o.op !== 'handle') continue;
    // ids are 'room/prop'; rooms know their props by the bare name
    const propId = o.id.includes('/') ? o.id.slice(o.id.indexOf('/') + 1) : o.id;
    out.set(propId, { ...(out.get(propId) || {}), ...o.set });
  }
  for (const [propId, patch] of session.get(roomId) || []) {
    out.set(propId, { ...(out.get(propId) || {}), ...patch });
  }
  const res = out.size ? out : null;
  handleCache.set(roomId, res);
  return res;
}

export const getOverrides = getHandles;

export function getOverride(roomId, propId) {
  return getHandles(roomId)?.get(propId) || null;
}

/**
 * Set one prop's handle numbers for the CURRENT session: a pin drag before it
 * is committed, or a published `handle` op pushed in by whoever applied the
 * document (src/world/overlay.js calls this by name).
 */
export function setHandles(roomId, propId, patch) {
  if (!session.has(roomId)) session.set(roomId, new Map());
  const m = session.get(roomId);
  m.set(propId, { ...(m.get(propId) || {}), ...patch });
  bumpHandles();
}

/** The name the editor has always used. */
export const setOverride = setHandles;

export function clearOverrides(roomId) {
  if (roomId) session.delete(roomId); else session.clear();
  bumpHandles();
}

export function hasOverrides(roomId) {
  return (getHandles(roomId)?.size || 0) > 0;
}

/** Fold this session's pin drags into a draft op list. */
export function handleOpsFor(roomId) {
  const out = [];
  for (const [propId, set] of session.get(roomId) || []) {
    out.push({ op: 'handle', id: `${roomId}/${propId}`, set });
  }
  return normalizeOps(out);
}

export function lastReport(roomId) {
  return reports.get(roomId) || null;
}

// ---------------------------------------------------------------------------
// applyLayout: the pass the engine runs after room.build()
// ---------------------------------------------------------------------------

/**
 * A hotspot op names a KIND and a validated destination. The callable is
 * resolved here, from this table, and nowhere else: a layout document must
 * never be able to express a function.
 */
const HOTSPOT_ACTION = {
  exit: (to) => (g) => g.goToRoom(to, g.roomId),
  game: (to) => (g) => g.startMinigame(to),
  sign: (_to, label) => (g) => g.toast(label || 'A sign.'),
};

const _down = new THREE.Vector3(0, -1, 0);
const _ray = new THREE.Raycaster();

/** Drop `p` onto the room's real ground, the same call the walker makes. */
export function groundY(room, x, z, from = 8) {
  if (!room?.groundMeshes?.length) return null;
  _ray.set(new THREE.Vector3(x, from, z), _down);
  const hits = _ray.intersectObjects(room.groundMeshes, false);
  if (!hits.length) return null;
  let best = hits[0];
  for (const h of hits) if (h.point.y > best.point.y) best = h;
  if (room.minWalkY !== undefined && best.point.y < room.minWalkY) return best.point.y;
  return best.point.y;
}

function tagged(room, id) {
  if (!(room?.tagged instanceof Map)) return null;
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return room.tagged.get(id) || room.tagged.get(bare) || null;
}

function spawnProp(room, scene, o) {
  const g = buildProp(o.cat);
  if (!g) return null;
  g.position.set(o.p[0], o.p[1], o.p[2]);
  if (!o.yLock) {
    const y = groundY(room, o.p[0], o.p[2]);
    if (y !== null) g.position.y = y + (o.p[1] || 0);
  }
  g.rotation.y = o.ry || 0;
  g.scale.setScalar(o.s || 1);
  if (o.tint !== undefined) {
    const hex = TINTS[o.tint];
    g.traverse((m) => {
      if (!m.isMesh || !m.material || Array.isArray(m.material)) return;
      // never mutate a cached material: clone before tinting
      const mat = m.material.userData?.shared ? m.material.clone() : m.material;
      mat.userData = { ...(mat.userData || {}), shared: false };
      mat.color?.setHex(hex);
      mat.vertexColors = false;
      m.material = mat;
    });
  }
  g.userData.opId = o.id;
  g.userData.layoutOp = o;
  scene.add(g);
  return g;
}

/**
 * Things you walk over, walk under or hang on a wall. A rug that pushed the
 * player around it would be worse than no rug at all.
 */
const NO_COLLIDE = new Set([
  'rug_round', 'rug_stripe', 'string_lights', 'wall_surfboard', 'capy_portrait',
]);

/** The collider a placed prop contributes, unless the op says otherwise. */
export function propCollider(o) {
  if (o.col !== undefined) return o.col > 0 ? { x: o.p[0], z: o.p[2], r: o.col } : null;
  if (NO_COLLIDE.has(o.cat)) return null;
  const fp = propFootprint(o.cat);
  const r = Math.max(0.25, Math.min(fp.w, fp.d) * 0.5 * (o.s || 1));
  return { x: o.p[0], z: o.p[2], r: r2(r) };
}

/**
 * Fold a layout onto a room the engine has just built.
 *
 * Order is fixed by KIND, never by array order, so two admins' merged
 * documents apply identically. Every op is wrapped: a throwing op is skipped
 * with a console error rather than taking the room build down with it.
 *
 * @returns {{rev, ops, applied, orphans, props, animated}} report
 */
export function applyLayout(room, scene, game) {
  const roomId = room?.id;
  const report = { rev: revOf(roomId), ops: 0, applied: 0, orphans: [], props: [], animated: [], draft: hasDraft(roomId) };
  if (!isLayoutRoom(roomId) || !scene) { reports.set(roomId, report); return report; }

  const ops = activeOps(roomId);
  report.ops = ops.length;
  if (!ops.length) { reports.set(roomId, report); return report; }

  const byKind = (k) => ops.filter((o) => o.op === k);
  const hotspotIdsBefore = new Set((room.hotspots || []).map((h) => h.id));
  room.dataProps = [];
  room.layoutOps = ops;

  const run = (o, fn) => {
    try { if (fn() !== false) report.applied++; else report.orphans.push(o.id); }
    catch (e) { console.error(`[layout] ${roomId} ${o.op}:${o.id}:`, e); report.orphans.push(o.id); }
  };

  // a. spawn points
  for (const o of byKind('spawn')) run(o, () => {
    if (!room.spawnPoints) return false;
    const key = o.id;
    const v = room.spawnPoints[key];
    const y = groundY(room, o.p[0], o.p[2]);
    const pos = new THREE.Vector3(o.p[0], y === null ? o.p[1] : y, o.p[2]);
    if (v && v.isVector3) v.copy(pos); else room.spawnPoints[key] = pos;
    return true;
  });

  // b/c. tagged objects: transform, then hide
  for (const o of byKind('xform')) run(o, () => {
    const obj = tagged(room, o.id);
    if (!obj) return false;
    if (o.p) obj.position.set(o.p[0], o.p[1], o.p[2]);
    if (o.ry !== undefined) obj.rotation.y = o.ry;
    if (o.s !== undefined) obj.scale.setScalar(o.s);
    return true;
  });
  for (const o of byKind('hide')) run(o, () => {
    const obj = tagged(room, o.id);
    if (!obj) return false;
    obj.visible = false;
    return true;
  });

  // d. catalog props
  let animatedCount = 0;
  for (const o of byKind('prop')) run(o, () => {
    const g = spawnProp(room, scene, o);
    if (!g) return false;
    room.dataProps.push(g);
    report.props.push(g);
    if (typeof g.userData.update === 'function' && animatedCount < LAYOUT_CAPS.animated) {
      animatedCount++;
      report.animated.push(g);
    }
    const c = propCollider(o);
    if (c) { room.obstacles = room.obstacles || []; room.obstacles.push({ ...c, opId: o.id }); }
    return true;
  });

  // e. colliders
  for (const o of byKind('collider')) run(o, () => {
    room.obstacles = room.obstacles || [];
    const existing = room.obstacles.find((c) => c.opId === o.id || c.id === o.id);
    if (existing) {
      if (o.x !== undefined) { existing.x = o.x; existing.z = o.z; }
      existing.r = o.r;
      if (o.r <= 0) room.obstacles.splice(room.obstacles.indexOf(existing), 1);
      return true;
    }
    if (o.x === undefined) return false;      // names nothing we know: orphan
    if (o.r <= 0) return true;                 // disabling something already gone
    room.obstacles.push({ x: o.x, z: o.z, r: o.r, opId: o.id });
    return true;
  });

  // f. hotspots
  for (const o of byKind('hotspot')) run(o, () => {
    room.hotspots = room.hotspots || [];
    const bare = o.id.includes('/') ? o.id.slice(o.id.indexOf('/') + 1) : o.id;
    const existing = room.hotspots.find((h) => h.opId === o.id || h.id === o.id || h.id === bare);
    if (existing) {
      if (o.x !== undefined) { existing.position.x = o.x; existing.position.z = o.z; }
      if (o.r !== undefined) existing.radius = o.r;
      if (o.label) existing.label = o.label;
      existing.opId = o.id;
      return true;
    }
    if (!o.kind || o.x === undefined) return false;
    const y = groundY(room, o.x, o.z);
    const make = HOTSPOT_ACTION[o.kind];
    const label = o.label || (o.kind === 'exit' ? `Go to ${o.to}` : o.kind === 'game' ? `Play ${MINIGAMES[o.to]?.name || o.to}` : 'Read the sign');
    room.hotspots.push({
      // an 'exit' behaves like an authored exit, including the engine's
      // walk-through intent firing, so it needs the id shape the engine reads
      id: o.kind === 'exit' ? `exit-${o.to}` : o.id,
      opId: o.id,
      position: new THREE.Vector3(o.x, y === null ? 0 : y, o.z),
      radius: o.r ?? 2.5,
      label,
      action: make(o.to, label),
    });
    return true;
  });

  // g. static camera (the engine resolves it right after this pass)
  for (const o of byKind('cam')) {
    if (o.id !== 'static') continue;
    run(o, () => {
      room.staticCamera = {
        position: new THREE.Vector3(o.p[0], o.p[1], o.p[2]),
        lookAt: new THREE.Vector3(o.look[0], o.look[1], o.look[2]),
      };
      return true;
    });
  }

  // Animated props need a tick, and only the room gets one. Wrapping the
  // instance's update is contained to this pass and costs the room file
  // nothing; the wrapper dies with the room.
  if (report.animated.length && !room.__layoutTick) {
    const orig = typeof room.update === 'function' ? room.update.bind(room) : () => {};
    const anim = report.animated;
    room.__layoutTick = true;
    room.__layoutT = 0;
    room.update = (dt, g) => {
      orig(dt, g);
      room.__layoutT += dt;
      for (const p of anim) {
        try { p.userData.update(room.__layoutT); } catch { /* one bad prop must not stop the room */ }
      }
    };
  }

  // A hotspot that existed in the clean build and is gone after apply is the
  // publish gate's business; record it here where both sides are visible.
  report.lostHotspots = [...hotspotIdsBefore].filter(
    (id) => !(room.hotspots || []).some((h) => h.id === id),
  );
  reports.set(roomId, report);
  return report;
}
