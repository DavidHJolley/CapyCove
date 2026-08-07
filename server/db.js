import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FURNITURE, HOUSE_MAX_ITEMS, HOUSE_ACCESS_MODES } from '../shared/constants.js';

// Tiny flat-file persistence: data/users.json + data/secret.txt.
// Fine for a small community server; swap for a real DB if it grows.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });

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

export const users = new Map(); // usernameLower -> record
try {
  if (fs.existsSync(USERS_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')))) {
      users.set(k, normalizeHouse(normalizeFriends(v)));
    }
  }
} catch (e) {
  console.error('[db] failed to load users:', e.message);
}

let saveTimer = null;
export function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 1));
    } catch (e) {
      console.error('[db] save failed:', e.message);
    }
  }, 500);
}

export function getSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {}
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  try { fs.writeFileSync(SECRET_FILE, secret); } catch (e) { console.error('[db] secret save failed:', e.message); }
  return secret;
}
