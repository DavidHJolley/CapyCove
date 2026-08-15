import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  FURNITURE, HOUSE_MAX_ITEMS, HOUSE_ACCESS_MODES, NAME_MIN_LEN, NAME_MAX_LEN,
} from '../shared/constants.js';
import { createStore, readTextSafe, writeFileAtomic } from './store.js';

// Flat-file persistence for a small community server. Everything that touches
// the disk lives in server/store.js (atomic writes, hourly gzip backups,
// restore); this file owns the SHAPE of an account and the operations that
// have to move a whole record at once. When SQLite arrives, store.js gets a
// second implementation and nothing here changes.
//
// Wave 9A additions: ensureAccount() backfills uid/role/tokenV/lastSeen/
// mute/ban on load exactly the way ensureFriends/ensureHouse already backfill
// their fields, and renameAccount() is the ONE function that moves a record
// between keys (spec: accounts-admin.md §1, §5.4).

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** COVE_DATA_DIR exists so a test (or a restore drill) can run against a
 *  sandbox copy of data/ without any other file knowing. */
const DATA_DIR = process.env.COVE_DATA_DIR
  ? path.resolve(process.env.COVE_DATA_DIR)
  : path.join(ROOT, 'data');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');

/** Most friends anyone can hoard. Both sides of a pair are checked against it. */
export const FRIEND_CAP = 100;

/**
 * A record's friend list: lowercase usernames, always an array.
 * Records written before friends existed (and every fresh signup, since auth.js
 * does not know about them) arrive without the field, so nothing may read
 * `rec.friends` directly.
 */
export function ensureFriends(rec) {
  if (!rec || typeof rec !== 'object') return [];
  if (!Array.isArray(rec.friends)) rec.friends = [];
  return rec.friends;
}

/** Hand-edited or half-written entries must not reach the wire as-is. */
function normalizeFriends(rec) {
  const raw = Array.isArray(rec?.friends) ? rec.friends : [];
  const clean = [...new Set(raw.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()))];
  if (rec && typeof rec === 'object') rec.friends = clean.slice(0, FRIEND_CAP);
  return rec;
}

// ---------- player houses ----------

/** Most usernames one den may keep on its guest list. */
export const HOUSE_INVITE_CAP = 50;
/** Half-extents of the buildable floor; placement outside this is rejected. */
export const HOUSE_BOUNDS = { x: 9, z: 7 };
/** New dens start closed: nobody wakes up to strangers in their living room. */
const HOUSE_DEFAULT_ACCESS = 'invite';

/**
 * A record's den: `{ access, invites, furniture }`. Records written before
 * houses existed (and every fresh signup, since auth.js does not know about
 * them) arrive without the field, so nothing may read `rec.house` directly.
 */
export function ensureHouse(rec) {
  if (!rec || typeof rec !== 'object') return { access: HOUSE_DEFAULT_ACCESS, invites: [], furniture: [] };
  const h = rec.house && typeof rec.house === 'object' && !Array.isArray(rec.house) ? rec.house : (rec.house = {});
  if (!HOUSE_ACCESS_MODES.includes(h.access)) h.access = HOUSE_DEFAULT_ACCESS;
  if (!Array.isArray(h.invites)) h.invites = [];
  if (!Array.isArray(h.furniture)) h.furniture = [];
  return h;
}

/** A record's furniture inventory: `{ furnitureId: count }`, counts >= 1. */
export function ensureOwnedFurniture(rec) {
  if (!rec || typeof rec !== 'object') return {};
  const own = rec.ownedFurniture;
  if (!own || typeof own !== 'object' || Array.isArray(own)) rec.ownedFurniture = {};
  return rec.ownedFurniture;
}

/** Drop anything a client could never have sent: unknown ids, NaN, out of bounds. */
function cleanPlacements(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(FURNITURE, it.f)) continue;
    const x = Number(it.x), z = Number(it.z), rot = Number(it.rot);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(rot)) continue;
    if (Math.abs(x) > HOUSE_BOUNDS.x || Math.abs(z) > HOUSE_BOUNDS.z) continue;
    out.push({ f: it.f, x: +x.toFixed(2), z: +z.toFixed(2), rot: +rot.toFixed(3) });
    if (out.length >= HOUSE_MAX_ITEMS) break;
  }
  return out;
}

/** Same job as normalizeFriends, for the den blob and the furniture inventory. */
function normalizeHouse(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const h = ensureHouse(rec);
  h.invites = [...new Set(h.invites.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()))]
    .slice(0, HOUSE_INVITE_CAP);
  h.furniture = cleanPlacements(h.furniture);
  const own = ensureOwnedFurniture(rec);
  for (const id of Object.keys(own)) {
    const n = Math.floor(Number(own[id]) || 0);
    if (!Object.prototype.hasOwnProperty.call(FURNITURE, id) || n < 1) delete own[id];
    else own[id] = Math.min(n, HOUSE_MAX_ITEMS);
  }
  return rec;
}

// ---------- identity, roles, discipline (wave 9A) ----------

/**
 * The role ladder, ordered. Not booleans: `isAdmin`/`isMod` flags multiply
 * combinatorially and every call site then has to know the precedence.
 * `mod` may go unused at launch; carrying it costs nothing.
 * (When the orchestrator adds ROLES to shared/constants.js, this becomes a
 * re-export — one line, no other change.)
 */
export const ROLES = ['player', 'mod', 'admin'];
const ROLE_SET = new Set(ROLES);
export const isRole = (r) => ROLE_SET.has(r);

const NAME_RE = new RegExp(`^[a-zA-Z0-9_]{${NAME_MIN_LEN},${NAME_MAX_LEN}}$`);
/** COVE_ADMIN grants `admin` to exactly one account key, at load and at signup. */
const SEED_ADMIN = String(process.env.COVE_ADMIN || '').trim().toLowerCase();

/** `u_` + 8 random bytes: short enough to eyeball in a log line, wide enough not to collide. */
function newUid() {
  return `u_${crypto.randomBytes(8).toString('hex')}`;
}

function cleanReasonText(v, max = 200) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** `{ until, by, reason }` or null. `until` is a ms epoch. */
function normalizeMute(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const until = Math.floor(Number(v.until) || 0);
  if (!Number.isFinite(until) || until <= 0) return null;
  return { until, by: cleanReasonText(v.by, 64), reason: cleanReasonText(v.reason) };
}

/**
 * `{ until, by, reason, at }` or null. `until` is a ms epoch OR the string
 * 'forever'. A legacy `until: 0` (the other encoding the spec floats) is read
 * as permanent so no ban is ever silently downgraded by a schema change.
 */
function normalizeBan(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let until;
  if (v.until === 'forever' || v.until === 0 || v.until === '0' || v.until === null) until = 'forever';
  else {
    const n = Math.floor(Number(v.until));
    if (!Number.isFinite(n) || n <= 0) return null;
    until = n;
  }
  const at = Math.floor(Number(v.at) || 0);
  return {
    until,
    by: cleanReasonText(v.by, 64),
    reason: cleanReasonText(v.reason),
    at: Number.isFinite(at) && at > 0 ? at : 0,
  };
}

/**
 * The account fields every new subsystem depends on, backfilled the way
 * ensureFriends/ensureHouse already backfill theirs. Idempotent: safe to call
 * on every load, every signup and every insert.
 *
 *   uid      stable, generated once, NEVER reused or rewritten
 *   role     'player' | 'mod' | 'admin'
 *   tokenV   integer >= 1, bump to revoke every issued token
 *   lastSeen ms epoch
 *   mute     { until, by, reason } | null
 *   ban      { until: ms|'forever', by, reason, at } | null
 *
 * `opts.uidTaken(uid)` lets the store veto a duplicate uid (hand-edited file,
 * a record copy/pasted between environments): the LATER record is reissued, so
 * the earlier one keeps the id every audit line already refers to.
 */
export function ensureAccount(rec, opts = {}) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const taken = typeof opts.uidTaken === 'function' ? opts.uidTaken : null;

  if (typeof rec.uid !== 'string' || !/^u_[0-9a-f]{16}$/.test(rec.uid) || (taken && taken(rec.uid))) {
    let uid = newUid();
    let guard = 0;
    while (taken && taken(uid) && guard++ < 8) uid = newUid();
    rec.uid = uid;
  }
  if (!ROLE_SET.has(rec.role)) rec.role = 'player';
  const tv = Math.floor(Number(rec.tokenV));
  rec.tokenV = Number.isFinite(tv) && tv >= 1 ? tv : 1;
  const seen = Math.floor(Number(rec.lastSeen));
  if (Number.isFinite(seen) && seen > 0) rec.lastSeen = seen;
  else {
    const created = Math.floor(Number(rec.created));
    rec.lastSeen = Number.isFinite(created) && created > 0 ? created : Date.now();
  }
  rec.mute = normalizeMute(rec.mute);
  rec.ban = normalizeBan(rec.ban);
  // written by the orchestrator's connection metadata pass (N-06); shaped here
  // so a junk value can never reach the admin surfaces.
  if (rec.lastIpH !== undefined) {
    rec.lastIpH = typeof rec.lastIpH === 'string' ? rec.lastIpH.slice(0, 32) : '';
    if (!rec.lastIpH) delete rec.lastIpH;
  }
  if (rec.renamedAt !== undefined) {
    const at = Math.floor(Number(rec.renamedAt));
    if (Number.isFinite(at) && at > 0) rec.renamedAt = at; else delete rec.renamedAt;
  }
  return rec;
}

/** Ms of mute left, or 0. Never trust `rec.mute` directly. */
export function muteRemaining(rec, now = Date.now()) {
  const m = rec?.mute;
  if (!m || typeof m.until !== 'number') return 0;
  return m.until > now ? m.until - now : 0;
}
export const muteActive = (rec, now = Date.now()) => muteRemaining(rec, now) > 0;

/** The live ban record, or null when there is none / it has expired. */
export function banActive(rec, now = Date.now()) {
  const b = rec?.ban;
  if (!b) return null;
  if (b.until === 'forever') return b;
  return typeof b.until === 'number' && b.until > now ? b : null;
}

/** Revoke every token ever issued for this account. Returns the new version. */
export function bumpTokenV(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  rec.tokenV = (Math.floor(Number(rec.tokenV)) || 0) + 1;
  saveSoon();
  return rec.tokenV;
}

/** Validated role write. Returns false for an unknown role. */
export function setRole(rec, role) {
  if (!rec || typeof rec !== 'object' || !ROLE_SET.has(role)) return false;
  if (rec.role === role) return true;
  rec.role = role;
  rec.tokenV = (Math.floor(Number(rec.tokenV)) || 0) + 1; // role change logs you out everywhere
  saveSoon();
  return true;
}

export const roleOf = (rec) => (ROLE_SET.has(rec?.role) ? rec.role : 'player');

/** Stamp presence. Cheap enough to call on hello and on disconnect. */
export function markSeen(rec, at = Date.now()) {
  if (!rec || typeof rec !== 'object') return;
  rec.lastSeen = at;
  saveSoon();
}

// ---------- the store ----------

/**
 * Every record entering the map goes through here: on load, on signup
 * (auth.js's `users.set` is routed through the store's map), and on any
 * putUser/createUser. Idempotent by construction.
 */
function normalizeRecord(rec, key, store) {
  // A record that has to be backfilled must be WRITTEN BACK promptly, or the
  // uid it was just given is not stable across the next restart.
  if (typeof rec.uid !== 'string' || rec.mute === undefined || rec.ban === undefined
      || !ROLE_SET.has(rec.role) || rec.tokenV === undefined) migrated++;
  ensureAccount(rec, { uidTaken: (uid) => store.uidTaken(uid, rec) });
  normalizeFriends(rec);
  normalizeHouse(rec);
  if (typeof rec.username !== 'string' || !rec.username) rec.username = String(key || '');
  // COVE_ADMIN is applied here rather than only at boot, so an operator who
  // sets the env var before the account exists gets admin the moment they sign
  // up, with no restart and no /api/claim-admin endpoint ever existing.
  if (SEED_ADMIN && String(key).toLowerCase() === SEED_ADMIN && rec.role !== 'admin') {
    rec.role = 'admin';
    seedState.applied = true;
    seedState.uid = rec.uid;
  }
  return rec;
}

const seedState = { name: SEED_ADMIN, applied: false, missing: false, uid: '' };
/** Records the load pass had to backfill. Non-zero means "write it back now". */
let migrated = 0;

/** The persistence seam. Anything new should call these, not `users.*`. */
export const store = createStore({
  dataDir: DATA_DIR,
  fileName: 'users.json',
  normalize: normalizeRecord,
  uidOf: (rec) => (typeof rec?.uid === 'string' ? rec.uid : ''),
  log: (msg, e) => console.error(msg, e ? e.message : ''),
});

/** usernameLower -> record. Still the live Map every existing call site uses. */
export const users = store.map;

store.load();

/**
 * First load after the wave-9 fields landed: snapshot the file as it was
 * (backupRaw reads the bytes on disk, which the backfill has not touched yet),
 * then write the migrated records straight back so every uid is durable
 * immediately rather than at whatever moment the first coin is earned.
 */
export const migratedOnLoad = migrated;
if (migrated > 0) {
  store.backupRaw({ reason: 'pre-migration' });
  store.flush();
  console.log(`[db] backfilled uid/role/tokenV/mute/ban on ${migrated} record(s)`);
}

if (SEED_ADMIN) {
  const rec = store.getUser(SEED_ADMIN);
  if (!rec) {
    seedState.missing = true;
    console.warn(`[db] COVE_ADMIN=${SEED_ADMIN} has no account yet; it will be granted admin at signup`);
  } else {
    seedState.uid = rec.uid;
    if (seedState.applied) { store.saveSoon(); console.log(`[db] COVE_ADMIN=${SEED_ADMIN} granted role admin`); }
  }
}

/** What COVE_ADMIN did at boot, for the orchestrator's `role.seed` audit line. */
export const adminSeed = seedState;

/** Re-apply COVE_ADMIN (e.g. after the account is created). Idempotent. */
export function seedAdmin() {
  if (!SEED_ADMIN) return { ...seedState };
  const rec = store.getUser(SEED_ADMIN);
  if (!rec) { seedState.missing = true; return { ...seedState }; }
  seedState.missing = false;
  seedState.uid = rec.uid;
  if (rec.role !== 'admin') { rec.role = 'admin'; seedState.applied = true; store.saveSoon(); }
  return { ...seedState };
}

/** Leading-edge 500 ms debounce, unchanged in behaviour; now an atomic write. */
export function saveSoon() {
  store.saveSoon();
}

/** Write now (shutdown, restore drill, admin "force save"). */
export function flush() {
  return store.flush();
}

/** Snapshot now. Backups otherwise run hourly and once on clean shutdown. */
export function backupNow(reason = 'manual') {
  return store.backup({ force: true, reason });
}

store.startBackups();
// SIGINT/SIGTERM: flush + snapshot + exit. If index.js ever grows a
// "broadcast + drain" shutdown of its own, set COVE_DRAIN=1 and this stops
// calling process.exit, leaving the exit to the server (the flush still runs
// first, because this listener is registered at import time).
store.installShutdownHooks({ exit: process.env.COVE_DRAIN !== '1' });

// ---------- rename ----------

/**
 * Move an account from one key to another: ONE function, because the flat file
 * spreads a username across four places and doing this by hand at four call
 * sites is how friend lists get orphaned (accounts-admin.md §1, §5.4).
 *
 * It: rekeys the map (the record OBJECT and its `uid` are preserved, so every
 * audit line, ban and report still points at the same identity), rewrites the
 * display name, bumps `tokenV` (the session token embeds the username), stamps
 * `renamedAt`, and sweeps every other record's `friends` array and
 * `house.invites` list for the old key.
 *
 * It does NOT touch live server state: the caller must move the `house:<old>`
 * room set and re-send anything holding the old name. The returned
 * `houseRoom: {from, to}` is exactly what index.js needs for that.
 *
 * @returns {{ok:true, uid, oldKey, newKey, oldName, newName, friendsSwept, invitesSwept, houseRoom:{from:string,to:string}}
 *          |{ok:false, msg:string}}
 */
export function renameAccount(oldKey, newKey) {
  const from = String(oldKey || '').toLowerCase();
  const display = String(newKey || '');
  const to = display.toLowerCase();

  if (!NAME_RE.test(display)) return { ok: false, msg: `Name: ${NAME_MIN_LEN}-${NAME_MAX_LEN} letters, numbers or _` };
  const rec = store.getUser(from);
  if (!rec) return { ok: false, msg: 'No such account' };
  if (from !== to && store.hasUser(to)) return { ok: false, msg: 'That name is taken' };

  const oldName = rec.username;
  let friendsSwept = 0;
  let invitesSwept = 0;

  try {
    store.tx(() => {
      if (from !== to && !store.rekey(from, to)) throw new Error('rekey failed');
      rec.username = display;
      rec.renamedAt = Date.now();
      rec.tokenV = (Math.floor(Number(rec.tokenV)) || 0) + 1;

      if (from === to) return;
      // O(accounts), and it happens rarely: at the flat file's own ~5-10k
      // ceiling this is milliseconds. SQLite normalises it away entirely.
      for (const [, other] of store.allUsers()) {
        const friends = ensureFriends(other);
        let hit = false;
        for (let i = 0; i < friends.length; i++) {
          if (friends[i] !== from) continue;
          friends[i] = to;
          friendsSwept++;
          hit = true;
        }
        if (hit) other.friends = [...new Set(friends)].slice(0, FRIEND_CAP);

        const h = ensureHouse(other);
        hit = false;
        for (let i = 0; i < h.invites.length; i++) {
          if (h.invites[i] !== from) continue;
          h.invites[i] = to;
          invitesSwept++;
          hit = true;
        }
        if (hit) h.invites = [...new Set(h.invites)].slice(0, HOUSE_INVITE_CAP);
      }
    });
  } catch (e) {
    console.error('[db] rename failed:', e.message);
    return { ok: false, msg: 'Rename failed' };
  }

  saveSoon();
  return {
    ok: true,
    uid: rec.uid,
    oldKey: from,
    newKey: to,
    oldName,
    newName: display,
    friendsSwept,
    invitesSwept,
    houseRoom: { from: `house:${from}`, to: `house:${to}` },
  };
}

// ---------- secret ----------

export function getSecret() {
  const existing = readTextSafe(SECRET_FILE);
  if (existing && existing.trim()) return existing.trim();
  const secret = crypto.randomBytes(32).toString('hex');
  try { writeFileAtomic(SECRET_FILE, secret); } catch (e) { console.error('[db] secret save failed:', e.message); }
  return secret;
}
