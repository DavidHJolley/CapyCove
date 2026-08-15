/**
 * server/layouts.js — the level-editor v2 persistence spine
 * (docs/research/level-editor.md sections 4, 5.1-5.4).
 *
 * ONE job: own the room layout documents. Every `rlo/1` document lives in
 * `<dataDir>/layouts/<roomId>.json`, is written atomically through
 * server/store.js, is validated all-or-nothing before it is ever stored, and
 * can only be written by an account holding the `editor` capability
 * (server/admin.js). The editor UI never touches disk and never decides what is
 * legal; it asks, this file answers.
 *
 * Contract with index.js — the SAME shape server/admin.js and server/progress.js
 * already prove:
 *   - install(ctx) once at boot, with
 *       { sendTo, broadcastAll, recordFor, audit, dataDir?, dir?, propIds? }
 *   - handleMessage(p, m) gets first refusal on every ws frame from a live
 *     player and returns true to consume it. It must run AFTER
 *     admin.handleMessage (so a ban closes the socket and a mute is enforced
 *     before anything here looks at the frame) and BEFORE the main switch.
 *   - httpGet(req, res) serves `GET /api/layout/:room` with an ETag.
 *   - flush() on shutdown, beside the store's own flush.
 *
 * ---------------------------------------------------------------------------
 * TWO READ PATHS, ON PURPOSE (spec 5.2)
 *
 *   HTTP  GET /api/layout/:room  -> the PUBLISHED ops, for everyone including
 *         guests, with `ETag: W/"<rev>"` so a warm reload is a 304. Editor-only
 *         ops (`group`, `cam:bm_*`) and the editor-only `lock` flag are
 *         stripped here: a layout document must not leak the owner's working
 *         notes to every visitor. A known room that has never been published
 *         answers 200 with `{rev:0, ops:[]}` (a real, cacheable document);
 *         only an unknown room or a den is a 404.
 *   ws    layout-get -> the WHOLE document (published + my draft + history
 *         summary), admin only.
 *
 * A missing or corrupt layout is never fatal and never blocks a room: the HTTP
 * route answers `{rev:0, ops:[]}` and the room builds from pure code.
 *
 * ---------------------------------------------------------------------------
 * FRAMES THIS MODULE OWNS (register in the CLAUDE.md protocol registry)
 *
 *   client -> server            (every one requires the `editor` capability)
 *     {t:'layout-get',     room}
 *     {t:'layout-save',    room, ops, base?}      save MY draft
 *     {t:'layout-publish', room, ops?, rev?}      draft (or ops) -> published
 *     {t:'layout-discard', room}                  drop MY draft
 *     {t:'layout-revert',  room, toRev}           republish out of history
 *   server -> the actor
 *     {t:'layout-doc', room, rev, base, updated, by, ops, draft, history,
 *                      others, limits}
 *     {t:'layout-ack', room, ok, what, rev?, msg?, code?}
 *   server -> EVERYONE
 *     {t:'layout-rev', room, rev, by}
 *
 * `layout-rev` goes island-wide, not room-wide, because a client caches the
 * layouts of every room it has visited (spec 5.3). Clients in that room refetch
 * and rebuild; everyone else evicts the cache entry.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (judgment calls marked DECISION)
 *
 * DECISION - validation is ALL-OR-NOTHING and REBUILDS every op from a
 * whitelist. One bad op rejects the whole document, and no key the client sent
 * that this file does not name ever reaches the disk. Storing a partially
 * cleaned layout is how an editor ends up showing something the server did not
 * keep (spec 5.4, modelled on validatePlacements in index.js).
 *
 * DECISION - a layout document can never express a function, a colour or a URL.
 * Hotspots carry `kind` + a `to` validated against ROOM_IDS / MINIGAMES, tints
 * are palette INDICES, and nothing is ever eval'd. Same reasoning that
 * palette-locks the plaza mural.
 *
 * DECISION - drafts are per admin key, so two admins never clobber each other,
 * and `layout-publish` takes an OPTIONAL `rev` guard: pass the published rev you
 * were looking at and a publish that would land on top of someone else's is
 * refused as stale rather than silently winning.
 *
 * DECISION - history is capped at 10 published documents and is the entire
 * rollback story. It is worth more than any confirmation dialog (spec 5.1).
 *
 * DECISION - an unauthorised `layout-*` frame from a player with NO caps at all
 * gets silence plus one audit line (`layout.probe`), exactly like admin.js.
 * Staff who hold some caps but not `editor` get a real `layout-ack` refusal,
 * because that is a UI bug rather than an attack.
 *
 * DECISION - draft saves are write-behind (1s trailing debounce, flushed on
 * publish and on shutdown); publishes, reverts and discards write through
 * immediately. The editor autosaves every 1.5s and there is no reason to pay an
 * fsync for each keystroke of a drag.
 *
 * Robustness: every entry point is wrapped. A throw in here must never cost a
 * player their frame and must never take the socket down.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, readJsonSafe } from './store.js';
import { requireCap, actorFrom, rankOf } from './admin.js';
import { ROOM_IDS, MINIGAMES } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// format + limits
// ---------------------------------------------------------------------------

/** Document version. Bump only for a shape change that needs a migration. */
export const LAYOUT_V = 1;
/** Format id, written into every file so a stray document identifies itself. */
export const LAYOUT_FMT = 'rlo/1';

/** The op vocabulary (spec 4.1). An unknown kind is REJECTED, never skipped. */
export const OP_KINDS = Object.freeze([
  'prop', 'xform', 'hide', 'handle', 'collider', 'hotspot', 'spawn', 'cam', 'group',
]);

/**
 * Every cap in one frozen table, exported so the editor can show the budget and
 * refuse before the round trip (spec 5.4). If these ever move to
 * shared/constants.js the editor imports them from there and this table reads
 * them through install(ctx.limits).
 */
export const LIMITS = Object.freeze({
  ops: 400,          // total ops in one document
  props: 120,        // `prop` ops
  colliders: 60,     // `collider` ops
  hotspots: 24,      // `hotspot` ops
  groups: 32,        // `group` ops (editor-only)
  bytes: 64 * 1024,  // serialised ops, on the wire and on disk
  history: 10,       // published documents kept for rollback
  drafts: 8,         // per-admin drafts kept per room
  tints: 16,         // palette indices a `tint` may name
  members: 64,       // ids in one `group`
  handleKeys: 24,    // keys in one `handle.set`
  label: 40,         // hotspot label
  name: 24,          // bookmark / group name
});

/** A live, mutable copy of LIMITS so install(ctx.limits) can tune it. */
const limits = { ...LIMITS };

/** Hotspot kinds. `action` is never data: the client resolves these itself. */
const HOTSPOT_KINDS = Object.freeze(['exit', 'game', 'sign']);

/**
 * Ids: `roomId/tag`, `plaza/bench.3`, `p_7f3a91`, `c_04`, `bm_1`.
 * The spec's charset is `[a-z0-9_./-]`, but it has to START on a word character
 * and must never contain `..`. Nothing here is ever used as a filename — the
 * only value that touches a path is the room id, which is checked against
 * ROOM_IDS — but an id that reads like `../../users` has no legitimate meaning
 * and would be a gift to whatever future code forgets that.
 */
const ID_RE = /^[a-z0-9_](?!.*\.\.)[a-z0-9_./-]{0,47}$/i;
/** Catalog ids and spawn names are plainer still. */
const PLAIN_RE = /^[a-z0-9_]{1,32}$/i;
/** `plaza@3`: the room-file layout signature at authoring time (spec 4.2). */
const BASE_RE = /^[\w.@:-]{1,32}$/;
/** Camera op ids: the one authored camera, or a numbered editor bookmark. */
const CAM_RE = /^(static|bm_[a-z0-9_]{1,16})$/i;

/** Write-behind window for draft saves. Publishes never wait on it. */
const SAVE_DEBOUNCE_MS = 1_000;
/**
 * Per-connection budgets. The editor's own traffic is a debounced autosave plus
 * the odd get/publish, so this is generous on purpose: the cost of being tight
 * is an owner whose publish bounces off "slow down" in the middle of a session,
 * and the real bound on abuse is the per-op cooldown below plus the 64KB cap.
 */
const FRAME_BURST = 10;
const FRAME_WINDOW_MS = 1_000;
const SAVE_EVERY_MS = 750;
const PUBLISH_EVERY_MS = 2_000;

/** Audit op vocabulary (audit.js OPS-style dotted names). */
const AUDIT = Object.freeze({
  SAVE: 'layout.save',
  PUBLISH: 'layout.publish',
  DISCARD: 'layout.discard',
  REVERT: 'layout.revert',
  PROBE: 'layout.probe',
  LOAD_FAIL: 'layout.load.fail',
  WRITE_FAIL: 'layout.write.fail',
});

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let ctx = null;
/** Where the documents live. install() may point this at a sandbox. */
let dir = '';
/** roomId -> document (lazily loaded, then authoritative in memory). */
const docs = new Map();
/** roomId -> pending write timer (draft write-behind). */
const pending = new Map();
/** Per-connection budgets. */
const scratch = new WeakMap();
/** Optional catalog whitelist for `prop.cat`, from install(ctx.propIds). */
let propIds = null;

const stats = {
  loads: 0, loadFails: 0, writes: 0, writeFails: 0,
  saves: 0, publishes: 0, reverts: 0, discards: 0,
  gets: 0, http: 0, http304: 0, refused: 0, probes: 0, rejected: 0, errors: 0,
};

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * @param {object} c
 *   sendTo(p, msg)          required for any ws reply
 *   broadcastAll(msg)       required for the layout-rev fan-out
 *   recordFor(p)            used by admin.actorFrom; index.js already has it
 *   audit                   the audit module, or its log function (either works)
 *   dataDir?                data root (default: COVE_DATA_DIR or <repo>/data)
 *   dir?                    exact directory, overriding dataDir (tests)
 *   propIds?                iterable of legal `prop.cat` ids; omit to accept any
 *                           plain catalog id (the catalog ships in a later phase)
 *   limits?                 partial override of LIMITS (tests, tuning)
 */
export function install(c = {}) {
  ctx = c || {};
  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.join(ROOT, 'data'));
  dir = c.dir ? path.resolve(c.dir) : path.join(dataDir, 'layouts');
  docs.clear();
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  propIds = c.propIds ? new Set([...c.propIds].map(String)) : null;
  // Always back to the shipped caps first: a second install() (a test sandbox)
  // must not inherit the previous one's tuning.
  Object.assign(limits, LIMITS);
  if (c.limits && typeof c.limits === 'object') {
    for (const k of Object.keys(LIMITS)) {
      if (Number.isFinite(Number(c.limits[k]))) limits[k] = Math.max(0, Math.floor(Number(c.limits[k])));
    }
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.warn('[layouts] cannot create', dir, e?.message || e); }
  const missing = ['sendTo', 'broadcastAll'].filter((k) => typeof ctx?.[k] !== 'function');
  if (missing.length) console.warn('[layouts] install() missing from ctx:', missing.join(', '));
  if (!auditFn()) console.warn('[layouts] no ctx.audit hook: layout publishes will NOT be logged');
  console.log(`[layouts] ready (${dir})`);
}

export function layoutStats() {
  return { ...stats, rooms: docs.size, dir };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/**
 * ctx.audit may be the audit MODULE (`import * as audit`) or its `log`
 * function. index.js passes the module to admin.install today, and a namespace
 * object is not callable, so accepting both here is not politeness: it is the
 * difference between an audited publish and a silent one.
 */
function auditFn() {
  const a = ctx?.audit;
  if (typeof a === 'function') return a;
  if (a && typeof a.log === 'function') return a.log.bind(a);
  if (typeof ctx?.auditLog === 'function') return ctx.auditLog;
  return null;
}

/** One shape, every mutation. Never throws: a logging failure costs nothing. */
function audit(op, actor, args, extra = {}) {
  const fn = auditFn();
  if (!fn) return;
  try {
    fn({
      op,
      ts: Date.now(),
      via: actor?.via || 'ingame',
      actor: actor
        ? { uid: actor.uid || null, name: actor.name || '', role: actor.role || 'player', ipH: actor.ipH || '', id: actor.p?.id || '' }
        : null,
      target: null,
      args: { ...(args || {}), ...(extra.deny ? { deny: extra.deny } : {}) },
      ...(extra.before ? { before: extra.before } : {}),
      ...(extra.after ? { after: extra.after } : {}),
      ok: extra.ok !== false,
    }, op);
  } catch (e) {
    console.error('[layouts] audit hook threw:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const bad = (msg, code = 'invalid') => ({ ok: false, msg, code });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

/** A finite number, or null. `null`, `''` and `[]` all coerce to 0: reject them. */
function num(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Strip control characters and collapse whitespace before any length check. */
function text(v, max) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** `[x, y, z]` in room units: |x|,|z| <= 200, |y| <= 40, 2dp (spec 4.2). */
function vec3(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const x = num(v[0]); const y = num(v[1]); const z = num(v[2]);
  if (x === null || y === null || z === null) return null;
  return [r2(clamp(x, -200, 200)), r2(clamp(y, -40, 40)), r2(clamp(z, -200, 200))];
}

/** Yaw only. Everything in this world stands on the floor (spec 4.2). */
function yaw(v) {
  const n = num(v);
  return n === null ? null : r3(clamp(n, -Math.PI * 2, Math.PI * 2));
}

/** Uniform scale, 0.25 to 4. */
function scale(v) {
  const n = num(v);
  return n === null ? null : r3(clamp(n, 0.25, 4));
}

/** A radius: 0 disables, 8 is the whole of a small room. */
function radius(v) {
  const n = num(v);
  return n === null ? null : r2(clamp(n, 0, 8));
}

const isRoom = (r) => typeof r === 'string' && ROOM_IDS.includes(r);

// ---------------------------------------------------------------------------
// validation (spec 5.4) — all-or-nothing, whitelist-rebuilt
// ---------------------------------------------------------------------------

/**
 * Clean one op, or explain why not. Every cleaner BUILDS A NEW OBJECT from
 * named fields: a key the client invented cannot survive this.
 * @returns {{ok:true, op:object}|{ok:false, msg:string}}
 */
const CLEANERS = {
  prop(o) {
    const cat = String(o.cat ?? '');
    if (!PLAIN_RE.test(cat)) return bad('prop needs a catalog id');
    if (propIds && !propIds.has(cat)) return bad(`unknown prop '${cat}'`);
    const p = vec3(o.p);
    if (!p) return bad(`prop ${o.id}: position must be [x, y, z]`);
    const out = { op: 'prop', id: o.id, cat, p };
    if (own(o, 'ry')) { const y = yaw(o.ry); if (y === null) return bad(`prop ${o.id}: bad rotation`); out.ry = y; }
    if (own(o, 's')) { const s = scale(o.s); if (s === null) return bad(`prop ${o.id}: bad scale`); out.s = s; }
    if (own(o, 'tint')) {
      const t = num(o.tint);
      if (t === null) return bad(`prop ${o.id}: tint must be a palette index`);
      out.tint = clamp(Math.floor(t), 0, limits.tints - 1);
    }
    if (own(o, 'col')) { const c = radius(o.col); if (c === null) return bad(`prop ${o.id}: bad collider radius`); out.col = c; }
    if (o.yLock) out.yLock = true;
    if (o.lock) out.lock = true;
    return { ok: true, op: out };
  },

  xform(o) {
    const out = { op: 'xform', id: o.id };
    if (own(o, 'p')) { const p = vec3(o.p); if (!p) return bad(`xform ${o.id}: position must be [x, y, z]`); out.p = p; }
    if (own(o, 'ry')) { const y = yaw(o.ry); if (y === null) return bad(`xform ${o.id}: bad rotation`); out.ry = y; }
    if (own(o, 's')) { const s = scale(o.s); if (s === null) return bad(`xform ${o.id}: bad scale`); out.s = s; }
    if (out.p === undefined && out.ry === undefined && out.s === undefined) return bad(`xform ${o.id}: nothing to change`);
    return { ok: true, op: out };
  },

  hide(o) {
    return { ok: true, op: { op: 'hide', id: o.id } };
  },

  /**
   * A room's published layout numbers (Tier B). `set` is a bag of named
   * numbers: a scalar (`yaw`), a pair (`at: [x, z]`) or a short list of pairs
   * (`seats: [[x, z], [x, z]]`), which is exactly the shape lounge.js's
   * STATIONS table publishes.
   */
  handle(o) {
    const src = o.set;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return bad(`handle ${o.id}: 'set' must be an object`);
    const keys = Object.keys(src);
    if (!keys.length) return bad(`handle ${o.id}: nothing to set`);
    if (keys.length > limits.handleKeys) return bad(`handle ${o.id}: too many keys`);
    const set = {};
    for (const k of keys) {
      if (!PLAIN_RE.test(k)) return bad(`handle ${o.id}: bad key '${k}'`);
      const v = src[k];
      const cleaned = handleValue(v);
      if (cleaned === null) return bad(`handle ${o.id}.${k}: numbers only`);
      set[k] = cleaned;
    }
    return { ok: true, op: { op: 'handle', id: o.id, set } };
  },

  collider(o) {
    const r = radius(o.r);
    if (r === null) return bad(`collider ${o.id}: needs a radius`);
    const out = { op: 'collider', id: o.id, r };
    // r:0 on a tagged id disables a code-authored circle and carries no centre.
    if (own(o, 'x') || own(o, 'z')) {
      const x = num(o.x); const z = num(o.z);
      if (x === null || z === null) return bad(`collider ${o.id}: bad centre`);
      out.x = r2(clamp(x, -200, 200));
      out.z = r2(clamp(z, -200, 200));
    }
    return { ok: true, op: out };
  },

  /**
   * A prompt zone. `kind` present = a new zone and the destination is checked
   * against the real tables; `kind` absent = adjusting an existing tagged
   * hotspot, where only the geometry may move (spec 4.1).
   */
  hotspot(o) {
    const out = { op: 'hotspot', id: o.id };
    if (own(o, 'kind')) {
      const kind = String(o.kind ?? '');
      if (!HOTSPOT_KINDS.includes(kind)) return bad(`hotspot ${o.id}: kind must be exit, game or sign`);
      out.kind = kind;
      if (kind === 'exit' || kind === 'game') {
        const to = String(o.to ?? '');
        const okTo = kind === 'exit' ? isRoom(to) : own(MINIGAMES, to);
        if (!okTo) return bad(`hotspot ${o.id}: '${to}' is not a ${kind === 'exit' ? 'room' : 'minigame'}`);
        out.to = to;
      }
      const x = num(o.x); const z = num(o.z);
      if (x === null || z === null) return bad(`hotspot ${o.id}: needs x and z`);
      out.x = r2(clamp(x, -200, 200));
      out.z = r2(clamp(z, -200, 200));
    } else if (own(o, 'x') || own(o, 'z')) {
      const x = num(o.x); const z = num(o.z);
      if (x === null || z === null) return bad(`hotspot ${o.id}: bad position`);
      out.x = r2(clamp(x, -200, 200));
      out.z = r2(clamp(z, -200, 200));
    }
    if (own(o, 'r')) { const r = radius(o.r); if (r === null) return bad(`hotspot ${o.id}: bad radius`); out.r = r; }
    if (own(o, 'label')) out.label = text(o.label, limits.label);
    if (out.kind && out.r === undefined) return bad(`hotspot ${o.id}: needs a radius`);
    if (out.kind === undefined && out.r === undefined && out.x === undefined && out.label === undefined) {
      return bad(`hotspot ${o.id}: nothing to change`);
    }
    return { ok: true, op: out };
  },

  spawn(o) {
    if (!PLAIN_RE.test(String(o.id))) return bad(`spawn '${o.id}': bad name`);
    const p = vec3(o.p);
    if (!p) return bad(`spawn ${o.id}: position must be [x, y, z]`);
    return { ok: true, op: { op: 'spawn', id: o.id, p } };
  },

  /**
   * `cam:static` authors room.staticCamera. `cam:bm_*` are editor bookmarks and
   * are stripped from what non-admin clients are served (spec 4.1, 6.8).
   */
  cam(o) {
    const id = String(o.id ?? '');
    if (!CAM_RE.test(id)) return bad(`cam '${id}': must be 'static' or 'bm_*'`);
    const out = { op: 'cam', id };
    if (id === 'static') {
      const p = vec3(o.p); const look = vec3(o.look);
      if (!p) return bad('cam static: position must be [x, y, z]');
      out.p = p;
      out.look = look || [0, 1, 0];
      return { ok: true, op: out };
    }
    const target = vec3(o.target);
    if (!target) return bad(`cam ${id}: target must be [x, y, z]`);
    const dist = num(o.dist); const y = yaw(o.yaw); const pitch = num(o.pitch);
    if (dist === null || y === null || pitch === null) return bad(`cam ${id}: needs dist, yaw and pitch`);
    out.target = target;
    out.dist = r2(clamp(dist, 0.5, 200));
    out.yaw = y;
    out.pitch = r3(clamp(pitch, -1.55, 1.55));
    if (own(o, 'name')) out.name = text(o.name, limits.name);
    return { ok: true, op: out };
  },

  group(o) {
    const src = o.members;
    if (!Array.isArray(src) || !src.length) return bad(`group ${o.id}: needs members`);
    if (src.length > limits.members) return bad(`group ${o.id}: too many members`);
    const members = [];
    for (const m of src) {
      const s = String(m ?? '');
      if (!ID_RE.test(s)) return bad(`group ${o.id}: bad member id`);
      if (!members.includes(s)) members.push(s);
    }
    const out = { op: 'group', id: o.id, members };
    if (own(o, 'name')) out.name = text(o.name, limits.name);
    return { ok: true, op: out };
  },
};

/** number | [n, n, ...] | [[n, n], [n, n]] — nothing else. */
function handleValue(v) {
  const n = num(v);
  if (n !== null && !Array.isArray(v)) return r3(clamp(n, -200, 200));
  if (!Array.isArray(v) || !v.length || v.length > 8) return null;
  if (Array.isArray(v[0])) {
    const rows = [];
    for (const row of v) {
      if (!Array.isArray(row) || !row.length || row.length > 4) return null;
      const clean = [];
      for (const c of row) {
        const q = num(c);
        if (q === null) return null;
        clean.push(r3(clamp(q, -200, 200)));
      }
      rows.push(clean);
    }
    return rows;
  }
  const out = [];
  for (const c of v) {
    const q = num(c);
    if (q === null) return null;
    out.push(r3(clamp(q, -200, 200)));
  }
  return out;
}

/**
 * Validate and normalise a whole op list. ALL-OR-NOTHING: one bad op rejects
 * the document (spec 5.4). Duplicates on the same `opKey` (`op + ':' + id`)
 * normalise last-wins, so a naive append-only draft cleans up by itself
 * (spec 4.1).
 *
 * @param {any} raw           the client's ops array
 * @param {{room?:string}} o
 * @returns {{ok:true, ops:object[], bytes:number}|{ok:false, msg:string, code:string}}
 */
export function validateOps(raw, o = {}) {
  if (o.room !== undefined && !isRoom(o.room)) return bad(`'${o.room}' is not an editable room`, 'room');
  if (!Array.isArray(raw)) return bad('ops must be a list', 'shape');
  if (raw.length > limits.ops * 2) return bad(`too many ops (max ${limits.ops})`, 'cap');

  const byKey = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return bad('every op must be an object', 'shape');
    const kind = String(item.op ?? '');
    if (!OP_KINDS.includes(kind)) return bad(`unknown op '${kind}'`, 'kind');
    const id = String(item.id ?? '');
    if (!ID_RE.test(id)) return bad(`op ${kind}: bad id '${id}'`, 'id');
    const res = CLEANERS[kind]({ ...item, id, op: kind });
    if (!res.ok) return { ...res, code: res.code || 'invalid' };
    byKey.set(`${kind}:${id}`, res.op); // last op with a key wins
  }

  const ops = [...byKey.values()];
  if (ops.length > limits.ops) return bad(`too many ops (${ops.length}, max ${limits.ops})`, 'cap');
  const count = (k) => ops.reduce((n, x) => n + (x.op === k ? 1 : 0), 0);
  if (count('prop') > limits.props) return bad(`too many props (max ${limits.props})`, 'cap');
  if (count('collider') > limits.colliders) return bad(`too many colliders (max ${limits.colliders})`, 'cap');
  if (count('hotspot') > limits.hotspots) return bad(`too many hotspots (max ${limits.hotspots})`, 'cap');
  if (count('group') > limits.groups) return bad(`too many groups (max ${limits.groups})`, 'cap');

  const bytes = Buffer.byteLength(JSON.stringify(ops));
  if (bytes > limits.bytes) return bad(`layout too big (${bytes} bytes, max ${limits.bytes})`, 'cap');
  return { ok: true, ops, bytes };
}

/** `plaza@3` or ''. Never rejects a document: a mismatch is the editor's banner. */
function cleanBase(v) {
  const s = String(v ?? '').trim();
  return BASE_RE.test(s) ? s : '';
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const fileFor = (room) => path.join(dir, `${room}.json`);

function blankDoc(room) {
  return {
    v: LAYOUT_V,
    fmt: LAYOUT_FMT,
    room,
    published: { rev: 0, base: '', by: '', updated: 0, ops: [] },
    history: [],
    drafts: {},
  };
}

/**
 * Normalise whatever is on disk. Anything a client could never have produced is
 * dropped here rather than trusted, exactly as db.js normalises accounts on
 * load: the file is editable by hand and by a restore, so it is INPUT.
 */
function normalizeDoc(room, raw) {
  const doc = blankDoc(room);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return doc;

  const pub = raw.published;
  if (pub && typeof pub === 'object') {
    const v = validateOps(pub.ops, { room });
    doc.published = {
      rev: Math.max(0, Math.floor(Number(pub.rev) || 0)),
      base: cleanBase(pub.base),
      by: text(pub.by, 32),
      updated: Math.max(0, Math.floor(Number(pub.updated) || 0)),
      ops: v.ok ? v.ops : [],
    };
    if (!v.ok) console.warn(`[layouts] ${room}: published ops rejected on load (${v.msg}); serving pure code`);
  }

  if (Array.isArray(raw.history)) {
    for (const h of raw.history.slice(0, limits.history)) {
      if (!h || typeof h !== 'object') continue;
      const v = validateOps(h.ops, { room });
      if (!v.ok) continue;
      doc.history.push({
        rev: Math.max(0, Math.floor(Number(h.rev) || 0)),
        base: cleanBase(h.base),
        by: text(h.by, 32),
        updated: Math.max(0, Math.floor(Number(h.updated) || 0)),
        ops: v.ops,
      });
    }
  }

  if (raw.drafts && typeof raw.drafts === 'object') {
    let n = 0;
    for (const key of Object.keys(raw.drafts)) {
      if (n >= limits.drafts) break;
      if (!PLAIN_RE.test(key)) continue;
      const d = raw.drafts[key];
      if (!d || typeof d !== 'object') continue;
      const v = validateOps(d.ops, { room });
      if (!v.ok) continue;
      doc.drafts[key] = {
        rev: Math.max(0, Math.floor(Number(d.rev) || 0)),
        base: cleanBase(d.base),
        updated: Math.max(0, Math.floor(Number(d.updated) || 0)),
        ops: v.ops,
      };
      n++;
    }
  }
  return doc;
}

/** Load a room's document, cached. Never throws; never blocks a room. */
function load(room) {
  if (docs.has(room)) return docs.get(room);
  let doc = blankDoc(room);
  const file = fileFor(room);
  const read = readJsonSafe(file);
  if (!read.ok) {
    // A layout that will not parse is EVIDENCE. Move it aside rather than
    // overwrite it, and carry on with pure code (store.js does the same for
    // users.json).
    stats.loadFails++;
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* best effort */ }
    console.error(`[layouts] ${room}: unreadable layout moved to ${path.basename(aside)}`);
    audit(AUDIT.LOAD_FAIL, null, { room, file: path.basename(aside), why: String(read.error?.message || read.error || 'parse') }, { ok: false });
  } else if (read.value) {
    doc = normalizeDoc(room, read.value);
    stats.loads++;
  }
  docs.set(room, doc);
  return doc;
}

/** Write one room through, atomically. Returns true on success. */
function writeNow(room) {
  const t = pending.get(room);
  if (t) { clearTimeout(t); pending.delete(room); }
  const doc = docs.get(room);
  if (!doc) return false;
  try {
    writeJsonAtomic(fileFor(room), doc, 1);
    stats.writes++;
    return true;
  } catch (e) {
    stats.writeFails++;
    console.error(`[layouts] ${room}: write failed:`, e?.message || e);
    audit(AUDIT.WRITE_FAIL, null, { room, why: String(e?.message || e) }, { ok: false });
    return false;
  }
}

/** Trailing debounce for draft saves: the editor autosaves, disk does not. */
function writeSoon(room) {
  if (pending.has(room)) return;
  const t = setTimeout(() => { pending.delete(room); writeNow(room); }, SAVE_DEBOUNCE_MS);
  if (typeof t.unref === 'function') t.unref();
  pending.set(room, t);
}

/** Flush every pending draft write. Call from the shutdown hook. */
export function flush() {
  let n = 0;
  for (const room of [...pending.keys()]) { if (writeNow(room)) n++; }
  return n;
}

// ---------------------------------------------------------------------------
// read API (for the HTTP route and for anything else server-side)
// ---------------------------------------------------------------------------

/** The published revision of a room, 0 when it has never been published. */
export function revOf(room) {
  return isRoom(room) ? load(room).published.rev : 0;
}

/**
 * What a NON-ADMIN may see: the published ops with the editor's own furniture
 * removed — bookmarks (`cam:bm_*`), groups, and the `lock` flag are the
 * owner's working notes, not the room (spec 4.1, 6.8).
 */
export function publicOps(room) {
  if (!isRoom(room)) return [];
  return load(room).published.ops
    .filter((o) => o.op !== 'group' && !(o.op === 'cam' && o.id !== 'static'))
    .map((o) => {
      if (!o.lock) return o;
      const { lock, ...rest } = o;
      return rest;
    });
}

/**
 * `W/"37"` — the published revision, weak because the body is regenerated (and
 * key-ordered) per request rather than byte-stable. Exactly the shape spec 5.2
 * names, and the shape the client's layout store revalidates with.
 */
const etagFor = (rev) => `W/"${rev}"`;

/**
 * The framework-free core of `GET /api/layout/:room`, so a headless test can
 * exercise the whole path without express.
 * @returns {{status:number, etag?:string, body:object}}
 */
export function serve(room, ifNoneMatch = '') {
  if (!isRoom(room)) return { status: 404, body: { ok: false, msg: 'No such room' } };
  const doc = load(room);
  const rev = doc.published.rev;
  const etag = etagFor(rev);
  stats.http++;
  // A revalidation is the common case on a warm reload; answer it for free.
  if (ifNoneMatch && String(ifNoneMatch).split(/,\s*/).some((t) => t.trim() === etag)) {
    stats.http304++;
    return { status: 304, etag, body: null };
  }
  return {
    status: 200,
    etag,
    body: {
      ok: true,
      v: LAYOUT_V,
      room,
      rev,
      base: doc.published.base,
      updated: doc.published.updated,
      ops: publicOps(room),
    },
  };
}

/**
 * Express handler for `GET /api/layout/:room`. Public on purpose: guests get
 * the dressed room with no auth path and no ws dependency (spec 5.2).
 */
export function httpGet(req, res) {
  try {
    const room = String(req?.params?.room || '');
    const out = serve(room, req?.headers?.['if-none-match'] || '');
    if (out.etag) res.set('ETag', out.etag);
    // Revalidate every time: layouts change rarely but must land immediately
    // when they do, and the ETag makes the check cost one round trip and no body.
    res.set('Cache-Control', 'no-cache');
    if (out.status === 304) return res.status(304).end();
    return res.status(out.status).json(out.body);
  } catch (e) {
    stats.errors++;
    console.error('[layouts] httpGet failed:', e?.message || e);
    try { return res.status(500).json({ ok: false, msg: 'Layout unavailable' }); } catch { return undefined; }
  }
}

// ---------------------------------------------------------------------------
// the ws write path
// ---------------------------------------------------------------------------

const FRAMES = new Set(['layout-get', 'layout-save', 'layout-publish', 'layout-discard', 'layout-revert']);

function sched(p) {
  let s = scratch.get(p);
  if (!s) { s = { w: 0, n: 0, saveAt: 0, pubAt: 0 }; scratch.set(p, s); }
  return s;
}

/**
 * The burst counter is charged on every frame; the per-op cooldowns are only
 * CHECKED here and are stamped by the op itself, and only when it succeeded.
 * A refusal that the owner has to retry (a stale publish, a rejected document)
 * must not also lock them out of the retry for two seconds.
 */
function limited(p, now, kind) {
  const s = sched(p);
  if (now - s.w > FRAME_WINDOW_MS) { s.w = now; s.n = 0; }
  if (++s.n > FRAME_BURST) return true;
  if (kind === 'save' && now - s.saveAt < SAVE_EVERY_MS) return true;
  if (kind === 'publish' && now - s.pubAt < PUBLISH_EVERY_MS) return true;
  return false;
}

/** Charge a per-op cooldown. Called only after the op actually did something. */
function charge(p, kind) {
  const s = sched(p);
  if (kind === 'save') s.saveAt = Date.now();
  else s.pubAt = Date.now();
}

function send(p, msg) {
  try { ctx?.sendTo?.(p, msg); } catch { /* socket died mid-reply */ }
}

const ack = (p, room, what, ok, extra = {}) => send(p, { t: 'layout-ack', room, what, ok, ...extra });

/** The admin key a draft is filed under: their account key, lowercased. */
function draftKey(actor) {
  const k = String(actor?.key || actor?.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return k.slice(0, 32) || 'unknown';
}

/** Everything the editor needs to open a room, in one frame. */
function docFrame(room, actor) {
  const doc = load(room);
  const key = draftKey(actor);
  const mine = own(doc.drafts, key) ? doc.drafts[key] : null;
  return {
    t: 'layout-doc',
    room,
    v: LAYOUT_V,
    rev: doc.published.rev,
    base: doc.published.base,
    updated: doc.published.updated,
    by: doc.published.by,
    ops: doc.published.ops,
    draft: mine ? { rev: mine.rev, base: mine.base, updated: mine.updated, ops: mine.ops } : null,
    // Summary only: nobody needs ten op lists to draw a rollback menu.
    history: doc.history.map((h) => ({ rev: h.rev, by: h.by, updated: h.updated, ops: h.ops.length })),
    // The soft "someone else is in here" signal, without a lock protocol.
    others: Object.keys(doc.drafts).filter((k) => k !== key).map((k) => ({ by: k, updated: doc.drafts[k].updated })),
    limits: { ...limits },
  };
}

// ---- the ops --------------------------------------------------------------

function opGet(p, m, actor) {
  const room = String(m.room || '');
  if (!isRoom(room)) return ack(p, room, 'get', false, { msg: 'No such room', code: 'room' });
  stats.gets++;
  send(p, docFrame(room, actor));
  return true;
}

function opSave(p, m, actor) {
  const room = String(m.room || '');
  const v = validateOps(m.ops, { room });
  if (!v.ok) {
    stats.rejected++;
    return ack(p, room, 'save', false, { msg: v.msg, code: v.code || 'invalid' });
  }
  const doc = load(room);
  const key = draftKey(actor);
  if (!own(doc.drafts, key) && Object.keys(doc.drafts).length >= limits.drafts) {
    return ack(p, room, 'save', false, { msg: 'Too many open drafts on this room', code: 'cap' });
  }
  const draft = {
    rev: doc.published.rev + 1,
    base: cleanBase(m.base),
    updated: Date.now(),
    ops: v.ops,
  };
  doc.drafts[key] = draft;
  stats.saves++;
  charge(p, 'save');
  writeSoon(room); // write-behind: a drag is not worth an fsync
  ack(p, room, 'save', true, { rev: draft.rev, ops: v.ops.length, bytes: v.bytes });
  audit(AUDIT.SAVE, actor, { room, ops: v.ops.length, bytes: v.bytes, base: draft.base });
  return true;
}

function opPublish(p, m, actor) {
  const room = String(m.room || '');
  if (!isRoom(room)) return ack(p, room, 'publish', false, { msg: 'No such room', code: 'room' });
  const doc = load(room);
  const key = draftKey(actor);
  const mine = own(doc.drafts, key) ? doc.drafts[key] : null;

  // Optional optimistic-concurrency guard: pass the published rev you were
  // looking at and a publish that would land on top of someone else's is
  // refused instead of silently winning.
  if (m.rev !== undefined && m.rev !== null) {
    const seen = Math.floor(Number(m.rev));
    if (!Number.isFinite(seen) || seen !== doc.published.rev) {
      return ack(p, room, 'publish', false, {
        msg: `This room moved on (now revision ${doc.published.rev}). Reload before publishing.`,
        code: 'stale', rev: doc.published.rev,
      });
    }
  }

  // Publish the ops in the frame if it carries any, otherwise my draft.
  const source = own(m, 'ops') && m.ops !== undefined && m.ops !== null ? m.ops : mine?.ops;
  if (source === undefined) return ack(p, room, 'publish', false, { msg: 'Nothing to publish', code: 'nodraft' });
  const v = validateOps(source, { room });
  if (!v.ok) {
    stats.rejected++;
    return ack(p, room, 'publish', false, { msg: v.msg, code: v.code || 'invalid' });
  }

  const prev = doc.published;
  const next = {
    rev: prev.rev + 1,
    base: cleanBase(m.base) || mine?.base || prev.base,
    by: actor?.name || '',
    updated: Date.now(),
    ops: v.ops,
  };
  // History is the whole rollback story: keep the document we are replacing.
  // The old array is held whole, so a failed write restores it exactly even if
  // pushing `prev` had rotated the oldest entry out.
  const prevHistory = doc.history;
  doc.history = (prev.rev > 0 || prev.ops.length > 0 ? [prev, ...prevHistory] : [...prevHistory]).slice(0, limits.history);
  doc.published = next;
  delete doc.drafts[key];

  if (!writeNow(room)) {
    // Roll the in-memory state back so what everyone renders and what is on
    // disk can never disagree.
    doc.published = prev;
    doc.history = prevHistory;
    if (mine) doc.drafts[key] = mine;
    return ack(p, room, 'publish', false, { msg: 'Could not write the layout to disk', code: 'io' });
  }

  stats.publishes++;
  charge(p, 'publish');
  ack(p, room, 'publish', true, { rev: next.rev, ops: v.ops.length });
  // Island-wide: a client caches the layout of every room it has visited.
  try { ctx?.broadcastAll?.({ t: 'layout-rev', room, rev: next.rev, by: next.by }); } catch { /* nobody home */ }
  audit(AUDIT.PUBLISH, actor, { room, rev: next.rev, ops: v.ops.length, bytes: v.bytes, base: next.base },
    { before: { rev: prev.rev, ops: prev.ops.length }, after: { rev: next.rev, ops: v.ops.length } });
  return true;
}

function opDiscard(p, m, actor) {
  const room = String(m.room || '');
  if (!isRoom(room)) return ack(p, room, 'discard', false, { msg: 'No such room', code: 'room' });
  const doc = load(room);
  const key = draftKey(actor);
  if (!own(doc.drafts, key)) return ack(p, room, 'discard', false, { msg: 'You have no draft here', code: 'nodraft' });
  const had = doc.drafts[key].ops.length;
  delete doc.drafts[key];
  writeNow(room); // a discard is a decision: make it durable immediately
  stats.discards++;
  ack(p, room, 'discard', true, { rev: doc.published.rev, ops: doc.published.ops.length });
  audit(AUDIT.DISCARD, actor, { room, dropped: had });
  return true;
}

/**
 * Republish a document out of history. A revert is itself a publish: it takes
 * the next rev and pushes what it replaced onto history, so reverting a revert
 * is one more click and nothing is ever lost (spec 6.9 step 7).
 */
function opRevert(p, m, actor) {
  const room = String(m.room || '');
  if (!isRoom(room)) return ack(p, room, 'revert', false, { msg: 'No such room', code: 'room' });
  const doc = load(room);
  const toRev = Math.floor(Number(m.toRev));
  const from = doc.history.find((h) => h.rev === toRev);
  if (!from) return ack(p, room, 'revert', false, { msg: `Revision ${m.toRev} is not in the history`, code: 'norev' });

  const prev = doc.published;
  const next = { rev: prev.rev + 1, base: from.base, by: actor?.name || '', updated: Date.now(), ops: from.ops };
  const prevHistory = doc.history;
  doc.history = [prev, ...prevHistory].slice(0, limits.history);
  doc.published = next;

  if (!writeNow(room)) {
    doc.published = prev;
    doc.history = prevHistory;
    return ack(p, room, 'revert', false, { msg: 'Could not write the layout to disk', code: 'io' });
  }

  stats.reverts++;
  charge(p, 'publish');
  ack(p, room, 'revert', true, { rev: next.rev, from: toRev, ops: next.ops.length });
  try { ctx?.broadcastAll?.({ t: 'layout-rev', room, rev: next.rev, by: next.by }); } catch { /* nobody home */ }
  audit(AUDIT.REVERT, actor, { room, rev: next.rev, from: toRev, ops: next.ops.length },
    { before: { rev: prev.rev }, after: { rev: next.rev } });
  return true;
}

const HANDLERS = {
  'layout-get': opGet,
  'layout-save': opSave,
  'layout-publish': opPublish,
  'layout-discard': opDiscard,
  'layout-revert': opRevert,
};

/**
 * First-refusal hook. Called by index.js for every frame from a live player,
 * AFTER admin.handleMessage (bans and mutes pre-empt everything) and BEFORE the
 * main switch. Returns true to consume the frame.
 *
 * The capability check is the security boundary. The editor's own gate on
 * `game.state.caps` is UX, and this matters far more in v2 than it ever did
 * before, because for the first time the editor writes data everybody renders.
 */
export function handleMessage(p, m) {
  if (!ctx || !p || !m || typeof m.t !== 'string') return false;
  if (!FRAMES.has(m.t)) return false;
  try {
    const actor = actorFrom(p, 'ingame');
    // A guest sending layout-*: consumed, answered with nothing.
    if (!actor) { stats.probes++; return true; }

    if (!requireCap(actor, 'editor')) {
      stats.refused++;
      if (rankOf(actor.role) === 0) {
        // A player with no capabilities at all is probing. Silence, one log line.
        stats.probes++;
        audit(AUDIT.PROBE, actor, { frame: m.t, room: String(m.room || '').slice(0, 32) }, { ok: false });
        return true;
      }
      // Staff without the cap: a real refusal, because that is a UI bug.
      audit(AUDIT.PROBE, actor, { frame: m.t, room: String(m.room || '').slice(0, 32) }, { ok: false, deny: 'no-capability' });
      ack(p, String(m.room || ''), m.t.slice(7), false, { msg: 'You do not have the layout editor', code: 'cap' });
      return true;
    }

    const now = Date.now();
    const kind = m.t === 'layout-save' ? 'save' : (m.t === 'layout-publish' || m.t === 'layout-revert' ? 'publish' : 'get');
    if (limited(p, now, kind)) {
      stats.refused++;
      ack(p, String(m.room || ''), m.t.slice(7), false, { msg: 'Slow down a moment', code: 'slow' });
      return true;
    }

    HANDLERS[m.t](p, m, actor);
    return true;
  } catch (e) {
    stats.errors++;
    console.error(`[layouts] ${m.t} failed:`, e?.message || e);
    try { ack(p, String(m.room || ''), 'error', false, { msg: 'That did not work', code: 'error' }); } catch { /* gone */ }
    return true; // the frame is ours: never let it fall through to the switch
  }
}

// ---------------------------------------------------------------------------
// test seam
// ---------------------------------------------------------------------------

/** Forget every cached document (a test that rewrites files by hand). */
export function _reset() {
  flush();
  docs.clear();
}
