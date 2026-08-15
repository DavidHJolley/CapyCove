import * as THREE from 'three';
import * as layoutStore from './layout.js';
// namespace import on purpose: a MISSING named export is a link-time error, and
// this module has to keep working while shared/constants.js grows PALETTE and
// friends in a later phase of the editor wave.
import * as SHARED from '../../shared/constants.js';

/**
 * src/world/overlay.js — published room layouts, applied over the code-built room.
 *
 * The room file stays the source of truth. A layout is a PATCH the owner
 * authored in the editor, stored server-side, fetched over HTTP and folded in
 * at build time so every player sees the same cove. Format `rlo/1`, spec in
 * docs/research/level-editor.md sections 4 and 5.
 *
 * The engine wires ONE line, immediately after `room.build(scene, game)`:
 *
 *     attachOverlay(this.room, this.scene, this.game, id);
 *
 * Everything else is this module's problem: fetching, caching, revalidating,
 * applying, animating data props, and tearing all of it down again. It hooks
 * the room INSTANCE's `update`/`dispose` (never the prototype) so the engine
 * needs no lifecycle changes: when the engine disposes the room, the overlay
 * goes with it.
 *
 * Cost when a room has no layout: after the first visit, one Map lookup and an
 * early `return null`. Nothing is allocated, nothing is wrapped, no second
 * request is made. That is deliberate — nine of ten rooms will have no layout
 * for a long time yet.
 *
 * Order of application (spec 4.3). `handle` ops are the odd one out: rooms read
 * them at the TOP of build() out of src/world/layout.js, so they cannot be
 * applied afterwards. They are pushed into that store the moment a document
 * lands, and a document that arrives after the build asks the engine for one
 * `rebuildRoom()`; everything else is applied in place:
 *
 *   spawn -> xform -> hide -> prop -> collider -> hotspot -> cam
 *
 * What this module will never do, and the reasons are in spec section 9:
 *  - evaluate a string, or accept a callable off the wire. A hotspot carries a
 *    `kind` + a validated `to`, resolved here from a fixed table.
 *  - persist free-mode (child-index path) edits. Only tags, handles and catalog
 *    props have durable identity.
 *  - touch player dens. `house:<owner>` rooms have their own editor and their
 *    own trust model; they are rejected by the room-id test below.
 */

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const LAYOUT_V = 1;

/** Read-side ceilings. The server owns the real ones; these bound the damage a
 *  bad/hostile response can do to a client that trusted it. */
export const LAYOUT_CAPS = {
  ops: 400, props: 120, animated: 24, colliders: 60, hotspots: 24,
};

const OP_KINDS = ['handle', 'spawn', 'xform', 'hide', 'prop', 'collider', 'hotspot', 'cam', 'group'];
const HOTSPOT_KINDS = ['exit', 'game', 'sign'];

// A layout id must survive being pasted into a URL path and a file name.
const ROOM_RE = /^[a-z0-9_-]{1,24}$/i;
const OP_ID_RE = /^[a-z0-9_./-]{1,48}$/i;
const CAT_RE = /^[a-z0-9_-]{1,32}$/i;
const SPAWN_RE = /^[a-z0-9_]{1,32}$/i;

const cfg = {
  enabled: true,
  endpoint: (roomId) => `/api/layout/${encodeURIComponent(roomId)}`,
  fetchImpl: null,      // defaults to globalThis.fetch, late-bound (tests inject)
  budgetMs: 250,        // preload deadline; the fetch keeps going in the background
  retryMs: 30_000,      // after a network/5xx failure
  quiet: false,         // silence the "layout unavailable" warn (tests)
};

/**
 * Test/dev seam. `configureOverlay({ enabled:false })` turns the whole
 * subsystem off for the session (a lever worth having on launch day).
 */
export function configureOverlay(opts = {}) {
  if (typeof opts.enabled === 'boolean') cfg.enabled = opts.enabled;
  if (typeof opts.endpoint === 'function') cfg.endpoint = opts.endpoint;
  if (typeof opts.fetchImpl === 'function') cfg.fetchImpl = opts.fetchImpl;
  if (Number.isFinite(opts.budgetMs)) cfg.budgetMs = Math.max(0, opts.budgetMs);
  if (Number.isFinite(opts.retryMs)) cfg.retryMs = Math.max(0, opts.retryMs);
  if (typeof opts.quiet === 'boolean') cfg.quiet = opts.quiet;
  return { ...cfg };
}

// ---------------------------------------------------------------------------
// caches
// ---------------------------------------------------------------------------

/** roomId -> { doc|null, etag|null, none:boolean, until:number } */
const cache = new Map();
/** roomId -> Promise<doc|null> while a request is in the air. */
const inflight = new Map();
/** roomId -> counter, bumped whenever handle ops in layout.js change. */
const handleSeq = new Map();
/** roomIds whose handle ops WE wrote into layout.js (so we may clear them). */
const handleOwned = new Set();
/** The live overlay per room, so a late fetch knows whether anyone is home. */
const live = new Map();

let propBuilder = null;      // (catId) => THREE.Object3D | null
let propBuilderTried = false;

/**
 * Supply the catalog builder. Phase 2 registers `src/world/props/index.js`
 * here from main.js; until then the module lazy-loads it, and falls back to
 * `furniture.js` (21 props, shipped) so the `prop` op is useful on day one.
 */
export function registerPropBuilder(fn) {
  if (typeof fn === 'function') { propBuilder = fn; propBuilderTried = true; }
  return propBuilder;
}

async function ensurePropBuilder() {
  if (propBuilder || propBuilderTried) return propBuilder;
  propBuilderTried = true;
  try {
    // phase 2 module; does not exist yet, so keep the bundler from trying to
    // resolve it at build time (the catch below handles the runtime 404)
    const propsPath = './props/index.js';
    const m = await import(/* @vite-ignore */ propsPath);
    if (typeof m.buildProp === 'function') { propBuilder = m.buildProp; return propBuilder; }
  } catch { /* phase 2 has not landed; fall through */ }
  try {
    const m = await import('./furniture.js');
    if (typeof m.buildFurniture === 'function') propBuilder = m.buildFurniture;
  } catch (e) { console.warn('[overlay] no prop builder available:', e?.message || e); }
  return propBuilder;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round = (v, dp) => +v.toFixed(dp);

function numOr(v, lo, hi, dp, dflt) {
  if (!isNum(v)) return dflt;
  return round(clamp(v, lo, hi), dp);
}

/** `[x,z]`, `[x,y,z]` or `{x,y,z}` -> `{x,y,z}` clamped to the world box. */
function readPos(v) {
  let x, y, z;
  if (Array.isArray(v)) {
    if (v.length === 2) { x = v[0]; y = 0; z = v[1]; }
    else if (v.length >= 3) { x = v[0]; y = v[1]; z = v[2]; }
    else return null;
  } else if (v && typeof v === 'object') {
    x = v.x; y = v.y ?? 0; z = v.z;
  } else return null;
  if (!isNum(x) || !isNum(y) || !isNum(z)) return null;
  return {
    x: round(clamp(x, -200, 200), 2),
    y: round(clamp(y, -40, 40), 2),
    z: round(clamp(z, -200, 200), 2),
  };
}

const opKey = (op) => `${op.op}:${op.id}`;

/** Tag/hotspot ids travel prefixed (`plaza/fountain`); rooms register bare. */
function stripRoom(id, roomId) {
  const p = `${roomId}/`;
  return id.startsWith(p) ? id.slice(p.length) : id;
}

// ---------------------------------------------------------------------------
// document normalisation
//
// The server validates all-or-nothing on the WRITE path (spec 5.4). Here, on
// the read path, one bad op is dropped and the rest of the room still gets its
// layout: a client that refuses the whole document because of one unknown key
// turns a typo into an outage for everybody.
// ---------------------------------------------------------------------------

/** Accepts `{ops}`, `{rev,base,ops}` or the on-disk `{published:{...}}` shape. */
export function normalizeDoc(raw, roomId) {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw.published && typeof raw.published === 'object' ? raw.published : raw;
  const room = typeof raw.room === 'string' ? raw.room : (typeof body.room === 'string' ? body.room : roomId);
  if (roomId && room !== roomId) return null; // answered about a different room
  const v = isNum(body.v) ? body.v : (isNum(raw.v) ? raw.v : LAYOUT_V);
  if (v !== LAYOUT_V) return null;            // a future format is not ours to guess at
  const src = Array.isArray(body.ops) ? body.ops : [];

  const seen = new Map();
  const counts = { prop: 0, collider: 0, hotspot: 0 };
  for (const raw2 of src) {
    if (seen.size >= LAYOUT_CAPS.ops) break;
    const op = normalizeOp(raw2, roomId || room, counts);
    if (!op) continue;
    seen.set(opKey(op), op); // last op with a key wins (spec 4.1)
  }
  return {
    v: LAYOUT_V,
    room,
    rev: isNum(body.rev) ? body.rev : 0,
    base: typeof body.base === 'string' ? body.base.slice(0, 48) : '',
    updated: isNum(body.updated) ? body.updated : 0,
    ops: [...seen.values()],
  };
}

function normalizeOp(o, roomId, counts) {
  if (!o || typeof o !== 'object') return null;
  const kind = typeof o.op === 'string' ? o.op : '';
  if (!OP_KINDS.includes(kind)) return null;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id || !OP_ID_RE.test(id)) return null;

  switch (kind) {
    case 'handle': {
      if (!o.set || typeof o.set !== 'object') return null;
      const set = {};
      for (const k of Object.keys(o.set)) {
        if (!/^[a-z0-9_.]{1,24}$/i.test(k)) continue;
        set[k] = cleanHandleValue(o.set[k]);
        if (set[k] === undefined) delete set[k];
      }
      if (!Object.keys(set).length) return null;
      return { op: kind, id, set };
    }
    case 'spawn': {
      const bare = stripRoom(id, roomId);
      if (!SPAWN_RE.test(bare)) return null;
      const p = readPos(o.p);
      return p ? { op: kind, id: bare, p } : null;
    }
    case 'xform': {
      const p = readPos(o.p);
      const out = { op: kind, id, rel: o.rel === true };
      if (p) out.p = p;
      if (isNum(o.ry)) out.ry = numOr(o.ry, -Math.PI * 4, Math.PI * 4, 3);
      if (isNum(o.s)) out.s = numOr(o.s, 0.25, 4, 3);
      return out.p || out.ry !== undefined || out.s !== undefined ? out : null;
    }
    case 'hide':
      return { op: kind, id };
    case 'prop': {
      if (counts.prop >= LAYOUT_CAPS.props) return null;
      const cat = typeof o.cat === 'string' ? o.cat.trim() : '';
      if (!CAT_RE.test(cat)) return null;
      const p = readPos(o.p);
      if (!p) return null;
      counts.prop++;
      const out = { op: kind, id, cat, p, ry: numOr(o.ry, -Math.PI * 4, Math.PI * 4, 3, 0), s: numOr(o.s, 0.25, 4, 3, 1) };
      if (isNum(o.tint)) out.tint = clamp(Math.round(o.tint), 0, 63);
      if (isNum(o.col)) out.col = numOr(o.col, 0, 8, 2, 0);
      if (o.yLock === true) out.yLock = true;
      if (o.lock === true) out.lock = true;
      return out;
    }
    case 'collider': {
      if (counts.collider >= LAYOUT_CAPS.colliders) return null;
      const r = numOr(o.r, 0, 8, 2, null);
      if (r === null) return null;
      counts.collider++;
      const out = { op: kind, id, r };
      if (isNum(o.x)) out.x = numOr(o.x, -200, 200, 2);
      if (isNum(o.z)) out.z = numOr(o.z, -200, 200, 2);
      return out;
    }
    case 'hotspot': {
      if (counts.hotspot >= LAYOUT_CAPS.hotspots) return null;
      const out = { op: kind, id };
      if (typeof o.kind === 'string' && HOTSPOT_KINDS.includes(o.kind)) out.kind = o.kind;
      if (typeof o.to === 'string' && OP_ID_RE.test(o.to)) out.to = o.to;
      if (typeof o.label === 'string') out.label = o.label.trim().slice(0, 40);
      if (isNum(o.x)) out.x = numOr(o.x, -200, 200, 2);
      if (isNum(o.z)) out.z = numOr(o.z, -200, 200, 2);
      if (isNum(o.r)) out.r = numOr(o.r, 0.5, 8, 2);
      if (o.noAuto === true) out.noAuto = true;
      // a NEW hotspot needs a kind, a destination and a place to stand
      const fresh = out.kind !== undefined;
      if (fresh && (out.x === undefined || out.z === undefined)) return null;
      if (fresh && out.kind !== 'sign' && !out.to) return null;
      counts.hotspot++;
      return out;
    }
    case 'cam': {
      if (id === 'static') {
        const p = readPos(o.p);
        const look = readPos(o.look);
        return p && look ? { op: kind, id, p, look } : null;
      }
      // bookmarks are editor furniture: carried, never applied
      return { op: kind, id, keep: true };
    }
    case 'group': {
      const members = Array.isArray(o.members)
        ? o.members.filter((m) => typeof m === 'string' && OP_ID_RE.test(m)).slice(0, 64) : [];
      return { op: kind, id, name: typeof o.name === 'string' ? o.name.slice(0, 24) : '', members, keep: true };
    }
    default:
      return null;
  }
}

/** A handle value is a number, an [x,z] pair, or a list of [x,z] pairs. */
function cleanHandleValue(v) {
  if (isNum(v)) return round(clamp(v, -200, 200), 3);
  if (!Array.isArray(v)) return undefined;
  if (v.length && Array.isArray(v[0])) {
    const out = [];
    for (const q of v.slice(0, 16)) {
      const c = cleanHandleValue(q);
      if (Array.isArray(c)) out.push(c);
    }
    return out.length ? out : undefined;
  }
  if (v.length === 2 && isNum(v[0]) && isNum(v[1])) {
    return [round(clamp(v[0], -200, 200), 2), round(clamp(v[1], -200, 200), 2)];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// fetch + cache
// ---------------------------------------------------------------------------

/**
 * Only the fixed cove rooms have layouts. Dens are excluded by construction
 * (spec 5.4): `house:<owner>` fails the id shape AND is absent from ROOM_IDS,
 * and `HouseRoom.id` is the bare 'house', which is not a cove room either — so
 * a den never asks the layout service anything, on entry or on rebuild.
 */
function usable(roomId) {
  if (!cfg.enabled || typeof roomId !== 'string' || !ROOM_RE.test(roomId)) return false;
  return Array.isArray(SHARED.ROOM_IDS) ? SHARED.ROOM_IDS.includes(roomId) : true;
}

/** The cached document for a room, or null. Never triggers a request. */
export function peekLayout(roomId) {
  const e = cache.get(roomId);
  return e && !e.none ? e.doc : null;
}

/** Published revision in hand, 0 when there is no layout. */
export function layoutRev(roomId) {
  return peekLayout(roomId)?.rev || 0;
}

/**
 * Drop what we hold for a room (the `layout-rev` broadcast calls this). The
 * ETag survives so the refetch can still come back 304 when nothing that
 * concerns us actually moved.
 */
export function evictLayout(roomId) {
  const e = cache.get(roomId);
  if (!e) return;
  cache.set(roomId, { doc: e.doc, etag: e.etag, none: false, stale: true, until: 0 });
}

export function evictAllLayouts() {
  for (const k of [...cache.keys()]) evictLayout(k);
}

/**
 * Install a document by hand: the editor's draft preview (`primeLayout(id,
 * draft)` then `engine.rebuildRoom()`) and the headless tests both use this.
 * Pass `null` to install "this room has no layout".
 */
export function primeLayout(roomId, raw) {
  const doc = raw ? normalizeDoc(raw, roomId) : null;
  adopt(roomId, doc, cache.get(roomId)?.etag || null);
  // the fetch path resolves the catalog builder before adopting; this one is
  // synchronous, so warm it for the NEXT build and carry on
  if (doc?.ops.some((o) => o.op === 'prop')) ensurePropBuilder();
  return doc;
}

/** Fold a fresh document into the caches and into the handle store. */
function adopt(roomId, doc, etag) {
  cache.set(roomId, { doc, etag, none: !doc || !doc.ops.length, stale: false, until: 0 });
  primeHandles(roomId, doc);
  return doc;
}

/**
 * Handle ops are read by the room at the top of build(), so they live in
 * src/world/layout.js — the same store the live editor writes. We only ever
 * clear what we ourselves wrote.
 */
function primeHandles(roomId, doc) {
  const ops = (doc?.ops || []).filter((o) => o.op === 'handle');
  const had = handleOwned.has(roomId);
  if (!ops.length && !had) return;

  if (had && typeof layoutStore.clearOverrides === 'function') layoutStore.clearOverrides(roomId);
  handleOwned.delete(roomId);

  for (const o of ops) {
    const propId = stripRoom(o.id, doc.room || roomId);
    try {
      if (typeof layoutStore.setHandles === 'function') layoutStore.setHandles(roomId, propId, o.set);
      else if (typeof layoutStore.setOverride === 'function') layoutStore.setOverride(roomId, propId, o.set);
    } catch (e) { console.warn('[overlay] handle op failed', o.id, e?.message || e); }
  }
  if (ops.length) handleOwned.add(roomId);
  handleSeq.set(roomId, (handleSeq.get(roomId) || 0) + 1);
}

/**
 * Fetch (or revalidate) a room's layout. Memoised per room for the session;
 * resolves null when the room has none. Never throws.
 */
export function ensureLayout(roomId) {
  if (!usable(roomId)) return Promise.resolve(null);
  const hit = cache.get(roomId);
  if (hit && !hit.stale && (!hit.none || !hit.until || Date.now() < hit.until)) {
    return Promise.resolve(hit.none ? null : hit.doc);
  }
  const pending = inflight.get(roomId);
  if (pending) return pending;

  const p = (async () => {
    const f = cfg.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) { cache.set(roomId, { doc: null, etag: null, none: true, stale: false, until: 0 }); return null; }
    const etag = hit?.etag || null;
    try {
      const res = await f(cfg.endpoint(roomId), {
        headers: etag ? { 'If-None-Match': etag } : undefined,
        cache: 'no-cache',
      });
      if (res.status === 304 && hit?.doc) return adopt(roomId, hit.doc, etag);
      if (res.status === 404 || res.status === 204) {
        cache.set(roomId, { doc: null, etag: null, none: true, stale: false, until: 0 });
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = String(res.headers?.get?.('content-type') || '');
      if (ct && !ct.includes('json')) throw new Error(`content-type ${ct}`); // dev proxy served index.html
      const body = await res.json();
      const doc = normalizeDoc(body, roomId);
      if (doc && doc.ops.length) {
        if (doc.ops.some((o) => o.op === 'prop')) await ensurePropBuilder();
      }
      return adopt(roomId, doc, res.headers?.get?.('etag') || null);
    } catch (e) {
      // Soft failure: no layout this time, try again in a while. A room must
      // never fail to open because a JSON file did not arrive (spec 5.2).
      cache.set(roomId, { doc: hit?.doc || null, etag: hit?.etag || null, none: true, stale: false, until: Date.now() + cfg.retryMs });
      if (!cfg.quiet) console.warn(`[overlay] layout '${roomId}' unavailable:`, e?.message || e);
      return null;
    } finally {
      inflight.delete(roomId);
    }
  })();
  inflight.set(roomId, p);
  return p;
}

/**
 * Boot/room-switch warm: resolves with the document if it beats the budget,
 * null otherwise. The request keeps going either way, so the room that opens
 * without a layout gets one moments later (see the rebuild path in attach).
 */
export function preloadLayout(roomId, { budgetMs = cfg.budgetMs } = {}) {
  const p = ensureLayout(roomId);
  if (!budgetMs) return p;
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((res) => { t = setTimeout(() => res(null), budgetMs); }),
  ]);
}

// ---------------------------------------------------------------------------
// attach: the engine's one line
// ---------------------------------------------------------------------------

/**
 * Apply the published layout for `roomId` over a freshly built room.
 *
 * Call immediately after `room.build(scene, game)` and before the engine reads
 * `getSpawn()` / resolves the static camera. Returns the overlay handle (also
 * on `room.__overlay`), or null when there is nothing to do.
 */
export function attachOverlay(room, scene, game, roomId = room?.id) {
  if (!room || !scene || !cfg.enabled) return null;
  const rid = typeof roomId === 'string' ? roomId : room.id;
  if (!usable(rid)) return null; // dens ('house:<owner>') and junk ids opt out here

  const hit = cache.get(rid);
  // The cheap path, and the common one: we already know this room has no
  // layout. One Map lookup, no allocation, no wrapping, no request.
  if (hit && hit.none && !hit.stale && (!hit.until || Date.now() < hit.until)) return null;

  if (room.__overlay?.active) room.__overlay.dispose(); // never wrap a wrap
  const ov = new RoomOverlay(room, scene, game, rid);
  live.set(rid, ov);
  room.__overlay = ov;

  const doc = hit && !hit.stale ? hit.doc : null;
  if (doc) ov.apply(doc);
  else {
    ensureLayout(rid).then((fresh) => {
      if (!ov.active || !fresh) return;
      // Handle ops only bite at the top of build(): if the store changed under
      // us, the honest way to show them is to build the room again. Everything
      // else lands in place. Once, guarded on still being in the same room.
      if ((handleSeq.get(rid) || 0) !== ov.seq && !ov.rebuilt) ov.requestRebuild();
      else ov.apply(fresh);
    }).catch(() => {});
  }
  return ov;
}

/** Layout data a room build produced, for the editor and the tests. */
class RoomOverlay {
  constructor(room, scene, game, roomId) {
    this.room = room;
    this.scene = scene;
    this.game = game;
    this.roomId = roomId;
    this.active = true;
    this.applied = false;
    this.rebuilt = false;
    this.seq = handleSeq.get(roomId) || 0;
    this.doc = null;
    this.rev = 0;
    this.orphans = [];
    this.props = [];       // { id, cat, obj, op }
    this.anim = [];        // props with userData.update
    this.mats = [];        // materials we cloned for tint (ours to free)
    this.group = null;     // THREE.Group holding every data prop
    this.t = 0;
    this._ray = null;
    this._tags = null;
    this._world = false;
    this._prevUpdate = null;
    this._prevDispose = null;
    this._ownUpdate = false;
    this._ownDispose = false;
    this._hook();
  }

  /**
   * Hook the room INSTANCE so the engine needs no lifecycle wiring: dispose
   * runs ours after the room's own, update ticks animated data props. The
   * prototype is never touched, and both are restored on dispose.
   */
  _hook() {
    const room = this.room;
    this._ownDispose = Object.prototype.hasOwnProperty.call(room, 'dispose');
    this._prevDispose = room.dispose?.bind(room) || null;
    room.dispose = () => {
      try { this._prevDispose?.(); } finally { this.dispose(); }
    };
  }

  _hookUpdate() {
    if (this._prevUpdate) return;
    const room = this.room;
    this._ownUpdate = Object.prototype.hasOwnProperty.call(room, 'update');
    this._prevUpdate = room.update?.bind(room) || (() => {});
    room.update = (dt, g) => {
      this._prevUpdate(dt, g);
      this.tick(dt);
    };
  }

  /** Put a hooked method back exactly as we found it: the room's own property
   *  if it had one, otherwise off the instance so the prototype shows through. */
  _unhook(key, prev, wasOwn) {
    if (!prev) return;
    if (wasOwn) this.room[key] = prev;
    else delete this.room[key];
  }

  tick(dt) {
    if (!this.anim.length) return;
    this.t += dt;
    for (const o of this.anim) {
      try { o.userData.update(this.t, dt); }
      catch (e) { console.warn('[overlay] prop update threw, dropping it:', e?.message || e); this.anim = this.anim.filter((x) => x !== o); }
    }
  }

  requestRebuild() {
    this.rebuilt = true;
    const e = this.game?.engine;
    // only if the player is still standing in the room we built
    if (e && e.room === this.room && typeof e.rebuildRoom === 'function') {
      try { e.rebuildRoom(); } catch (err) { console.error('[overlay] rebuild failed:', err); }
    }
  }

  // -- application ---------------------------------------------------------
  apply(doc) {
    if (!this.active || this.applied || !doc) return this;
    this.applied = true;
    this.doc = doc;
    this.rev = doc.rev || 0;
    const room = this.room;
    room.layoutDoc = doc;
    room.layoutOps = doc.ops;

    const by = { spawn: [], xform: [], hide: [], prop: [], collider: [], hotspot: [], cam: [] };
    for (const o of doc.ops) if (by[o.op]) by[o.op].push(o);

    for (const o of by.spawn) this._guard(o, () => this._spawn(o));
    for (const o of by.xform) this._guard(o, () => this._xform(o));
    for (const o of by.hide) this._guard(o, () => this._hide(o));
    if (by.prop.length) {
      this.group = new THREE.Group();
      this.group.name = 'layout-props';
      this.scene.add(this.group);
      const built = new Map();
      for (const o of by.prop) this._guard(o, () => this._prop(o, built));
    }
    for (const o of by.collider) this._guard(o, () => this._collider(o));
    for (const o of by.hotspot) this._guard(o, () => this._hotspot(o));
    for (const o of by.cam) this._guard(o, () => this._cam(o));

    if (this.anim.length) this._hookUpdate();
    room.dataProps = this.props;
    room.layoutOrphans = this.orphans;
    if (this.orphans.length) {
      console.warn(`[overlay] ${this.roomId}: ${this.orphans.length} op(s) name something this room no longer builds:`, this.orphans.join(', '));
    }
    try {
      this.game?.events?.emit?.('layout-applied', {
        room: this.roomId, rev: this.rev, props: this.props.length,
        orphans: [...this.orphans], ops: doc.ops.length,
      });
    } catch { /* an overlay never breaks a room build */ }
    return this;
  }

  /** One throwing op is skipped with a console error; the room still opens. */
  _guard(op, fn) {
    try { fn(); } catch (e) { console.error(`[overlay] ${this.roomId} ${op.op}:${op.id} failed:`, e); }
  }

  // -- op handlers ---------------------------------------------------------
  _spawn(o) {
    const sp = this.room.spawnPoints || (this.room.spawnPoints = {});
    const v = sp[o.id];
    if (v && v.isVector3) v.set(o.p.x, o.p.y, o.p.z);
    else sp[o.id] = new THREE.Vector3(o.p.x, o.p.y, o.p.z);
  }

  _xform(o) {
    const obj = this._tag(o.id);
    if (!obj) return this.orphans.push(o.id);
    if (o.p) {
      if (o.rel) obj.position.set(obj.position.x + o.p.x, obj.position.y + o.p.y, obj.position.z + o.p.z);
      else obj.position.set(o.p.x, o.p.y, o.p.z);
    }
    if (o.ry !== undefined) obj.rotation.y = o.rel ? obj.rotation.y + o.ry : o.ry;
    if (o.s !== undefined) obj.scale.setScalar(o.rel ? obj.scale.x * o.s : o.s);
    obj.updateMatrixWorld?.(true);
  }

  _hide(o) {
    const obj = this._tag(o.id);
    if (!obj) return this.orphans.push(o.id);
    obj.visible = false; // visual only: a code collider is disabled with `collider r:0`
  }

  _prop(o, built) {
    if (!propBuilder) { this.orphans.push(o.id); return; }
    let obj = null;
    const first = built.get(o.cat);
    // Object3D.clone() shares geometry and materials (one build per catalog id,
    // many placements) but JSON-copies userData, which drops update(). Animated
    // pieces are therefore built fresh, and capped.
    if (first && !first.userData?.update) obj = first.clone(true);
    else if (first && this.anim.length >= LAYOUT_CAPS.animated) obj = first.clone(true);
    else {
      obj = propBuilder(o.cat);
      if (obj) built.set(o.cat, obj);
    }
    if (!obj || !obj.isObject3D) { this.orphans.push(o.id); return; }

    const y = o.yLock ? o.p.y : this._groundY(o.p.x, o.p.z) + o.p.y;
    obj.position.set(o.p.x, y, o.p.z);
    obj.rotation.y = o.ry || 0;
    obj.scale.setScalar(o.s || 1);
    obj.userData.layoutId = o.id;
    obj.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    if (o.tint !== undefined) this._tint(obj, o.tint);
    this.group.add(obj);
    this.props.push({ id: o.id, cat: o.cat, obj, op: o });
    if (typeof obj.userData.update === 'function' && this.anim.length < LAYOUT_CAPS.animated) this.anim.push(obj);

    const r = o.col !== undefined ? o.col : this._footprintR(obj) * (o.s || 1);
    if (r > 0) this.room.obstacles?.push({ x: o.p.x, z: o.p.z, r, id: o.id });
  }

  /** The house editor's collider maths: a 2.65 x 1.3 sofa gets a 0.99 bubble,
   *  not a 1.48 barrel, so you can brush past its ends. Flat things (rugs) are
   *  marked walkable by their footprint and get nothing. */
  _footprintR(obj) {
    const fp = obj.userData?.footprint;
    if (fp && (fp.solid === false || fp.walkable === true)) return 0;
    let w = 1.4, d = 1.4;
    if (typeof fp === 'number') { w = d = fp * 2; }
    else if (fp && typeof fp === 'object') {
      if (isNum(fp.w) && isNum(fp.d)) { w = fp.w; d = fp.d; }
      else if (isNum(fp.r)) { w = d = fp.r * 2; }
    }
    return clamp((w + d) / 4, 0.25, 2.6);
  }

  _tint(obj, idx) {
    const pal = Array.isArray(SHARED.PALETTE) ? SHARED.PALETTE : null;
    const hex = pal ? pal[idx % pal.length] : null;
    if (hex === undefined || hex === null) return;
    const c = new THREE.Color(typeof hex === 'string' ? hex : Number(hex));
    obj.traverse((m) => {
      if (!m.isMesh || !m.material) return;
      const list = Array.isArray(m.material) ? m.material : [m.material];
      const out = list.map((src) => {
        const cl = src.clone();
        cl.color?.multiply?.(c);
        // shared: keep disposeObject away from it (the clone still points at the
        // original's texture). We free the material ourselves in dispose().
        cl.userData = { ...(cl.userData || {}), shared: true };
        this.mats.push(cl);
        return cl;
      });
      m.material = Array.isArray(m.material) ? out : out[0];
    });
  }

  _collider(o) {
    const list = this.room.obstacles;
    if (!Array.isArray(list)) return;
    const bare = stripRoom(o.id, this.roomId);
    let hit = list.find((c) => c.id === o.id || c.id === bare);
    if (!hit) {
      const obj = this._tag(o.id);
      if (obj) {
        // A tagged prop's code-authored circle has no id; the nearest circle to
        // its footing is it. Anything further than a metre is somebody else's.
        const p = new THREE.Vector3();
        obj.getWorldPosition(p);
        let best = null, bd = 1.0;
        for (const c of list) {
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if (d < bd) { bd = d; best = c; }
        }
        hit = best;
      }
    }
    if (hit) {
      if (o.r === 0) list.splice(list.indexOf(hit), 1);
      else {
        hit.r = o.r;
        if (o.x !== undefined) hit.x = o.x;
        if (o.z !== undefined) hit.z = o.z;
      }
      return;
    }
    if (o.r > 0 && o.x !== undefined && o.z !== undefined) list.push({ x: o.x, z: o.z, r: o.r, id: o.id });
    else if (o.r > 0) this.orphans.push(o.id);
  }

  _hotspot(o) {
    const list = this.room.hotspots;
    if (!Array.isArray(list)) return;
    const bare = stripRoom(o.id, this.roomId);
    const hit = list.find((h) => h.id === o.id || h.id === bare || h.opId === o.id);
    if (hit) {
      if (o.r !== undefined) hit.radius = o.r;
      if (o.label) hit.label = o.label;
      if (o.x !== undefined && o.z !== undefined && hit.position?.set) {
        hit.position.set(o.x, this._groundY(o.x, o.z), o.z);
      }
      return;
    }
    if (!o.kind) return this.orphans.push(o.id); // an adjust op for a zone that is gone

    // `to` is validated here as well as server-side, and `action` is looked up
    // from a fixed table: a layout document can never express a function.
    const rooms = Array.isArray(SHARED.ROOM_IDS) ? SHARED.ROOM_IDS : [];
    const games = SHARED.MINIGAMES && typeof SHARED.MINIGAMES === 'object' ? Object.keys(SHARED.MINIGAMES) : [];
    const to = o.to;
    const roomId = this.roomId;
    let id = o.id, action = null;
    if (o.kind === 'exit') {
      if (!rooms.includes(to) || to === roomId) return this.orphans.push(o.id);
      // Named like every other exit so the engine gives it the approach cue and
      // the walk-through fire (an exit you have to click is not an archway).
      id = o.noAuto ? o.id : `exit-${to}`;
      action = (gm) => gm.goToRoom(to, roomId);
    } else if (o.kind === 'game') {
      if (!games.includes(to)) return this.orphans.push(o.id);
      action = (gm) => gm.startMinigame(to);
    } else {
      const msg = o.label || 'A sign.';
      action = (gm) => gm.toast(msg);
    }
    list.push({
      id,
      opId: o.id,
      position: new THREE.Vector3(o.x, this._groundY(o.x, o.z), o.z),
      radius: o.r || 2.5,
      label: o.label || (o.kind === 'exit' ? `Go to ${to}` : to),
      noAuto: o.noAuto === true ? true : undefined,
      action,
    });
  }

  _cam(o) {
    if (o.id !== 'static') return;
    this.room.staticCamera = {
      position: new THREE.Vector3(o.p.x, o.p.y, o.p.z),
      lookAt: new THREE.Vector3(o.look.x, o.look.y, o.look.z),
    };
    // late arrival: the engine already framed the shot, so ask it again
    const e = this.game?.engine;
    if (this.rebuilt || !e || e.room !== this.room) return;
    if (typeof e.resolveStaticCam === 'function') e.resolveStaticCam(false);
    else if (typeof e._resolveStaticCam === 'function') e._resolveStaticCam(false);
  }

  // -- lookups -------------------------------------------------------------
  /**
   * Tagged objects, by whatever route the room offers: `room.tagged` (Map or
   * object, the phase-4 `room.tag(id, obj)` registry) first, then a one-off
   * scan for `userData.tagId` / `userData.tag`. Built lazily, so a room with no
   * tag ops never pays for the traversal.
   */
  _tag(id) {
    if (!this._tags) {
      this._syncWorld();
      const map = new Map();
      const put = (k, v) => { if (typeof k === 'string' && k && v?.isObject3D && !map.has(k)) map.set(k, v); };
      const t = this.room.tagged;
      if (t instanceof Map) for (const [k, v] of t) put(k, v);
      else if (t && typeof t === 'object') for (const k of Object.keys(t)) put(k, t[k]);
      this.scene.traverse((o) => {
        const k = o.userData?.tagId || o.userData?.tag;
        if (typeof k === 'string') put(k, o);
      });
      this._tags = map;
    }
    const bare = stripRoom(id, this.roomId);
    return this._tags.get(id) || this._tags.get(bare) || this._tags.get(`${this.roomId}/${bare}`) || null;
  }

  /** Matrices are computed at render time, and we run before the first frame:
   *  one traversal, once per build, or every raycast below misses the floor. */
  _syncWorld() {
    if (this._world) return;
    this._world = true;
    this.scene.updateMatrixWorld(true);
  }

  /** Ground height under (x, z): the same downward ray the walker uses. */
  _groundY(x, z) {
    const meshes = this.room.groundMeshes;
    if (!meshes?.length) return 0;
    this._syncWorld();
    if (!this._ray) this._ray = new THREE.Raycaster();
    this._ray.set(new THREE.Vector3(x, 40, z), new THREE.Vector3(0, -1, 0));
    const hits = this._ray.intersectObjects(meshes, false);
    return hits.length ? hits[0].point.y : 0;
  }

  // -- teardown ------------------------------------------------------------
  /** Runs from the room's own dispose(), so the engine tears us down for free. */
  dispose() {
    if (!this.active) return;
    this.active = false;
    if (live.get(this.roomId) === this) live.delete(this.roomId);
    this._unhook('dispose', this._prevDispose, this._ownDispose);
    this._unhook('update', this._prevUpdate, this._ownUpdate);
    this._prevDispose = this._prevUpdate = null;
    // The scene graph is the engine's to free (disposeObject walks it); ours is
    // everything that would otherwise outlive it.
    if (this.group?.parent) this.group.parent.remove(this.group);
    for (const m of this.mats) { try { m.dispose(); } catch { /* already gone */ } }
    this.mats.length = 0;
    this.anim.length = 0;
    this.props.length = 0;
    this.group = null;
    this._tags = null;
    this._ray = null;
    if (this.room) {
      this.room.__overlay = null;
      this.room.layoutDoc = null;
    }
    this.room = null;
    this.scene = null;
    this.game = null;
  }
}

/** The overlay currently applied to a room, if any (the editor asks). */
export function overlayFor(roomId) {
  const ov = live.get(roomId);
  return ov?.active ? ov : null;
}

/** Test seam: forget every cached document, handle prime and live overlay. */
export function resetOverlayState() {
  for (const ov of [...live.values()]) ov.dispose();
  live.clear();
  cache.clear();
  inflight.clear();
  handleSeq.clear();
  for (const rid of handleOwned) layoutStore.clearOverrides?.(rid);
  handleOwned.clear();
}
