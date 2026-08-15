import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  users, saveSoon, getSecret,
  banActive, bumpTokenV, markSeen, muteRemaining, roleOf,
} from './db.js';
import { NAME_MAX_LEN, NAME_MIN_LEN } from '../shared/constants.js';
import { profileBits } from './admin.js';
import { profileBits as charmBits } from './charms.js';
import { checkName as filterCheckName } from './filter.js';

// Accounts: password hashing, session tokens, and the recovery codes that
// stand in for an email subsystem this project deliberately does not have
// (docs/research/accounts-admin.md §5.1).
//
// Wave 9B changes, all of them contract-visible:
//   * `signup()` and `login()` are ASYNC. Every scrypt call in this file now
//     goes through the promisified crypto.scrypt: scryptSync costs ~60-100 ms
//     of BLOCKING cpu and each one stalled the 10 Hz world broadcast for every
//     player in the game (AUDIT F-5).
//   * Tokens embed `tokenV`, so bumping a record's tokenV invalidates every
//     token ever issued for it. That is how ban, role change, rename, password
//     change and "log out everywhere" all work, with one integer.
//   * The TTL drops 30d -> 14d, with a silent refresh once a session is more
//     than 7 days old (`maybeRefreshToken`).
//   * `login()` refuses a banned account with copy that names the date.
//   * Signup mints 8 one-time recovery codes, returned ONCE in the signup
//     response and stored only as scrypt hashes.
//
// TOKEN FORMAT CHANGE: tokens are now four dot-separated parts, not three.
// Every token issued before this wave fails `verifyToken` and every player logs
// in once more. That is the intended cost and it is why this lands pre-launch.

const SECRET = getSecret();
const NAME_RE = new RegExp(`^[a-zA-Z0-9_]{${NAME_MIN_LEN},${NAME_MAX_LEN}}$`);

/** 14 days (was 30). Same convenience as before, half the exposure window. */
export const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14;
/** Under this much life left, hello should hand back a fresh token. */
export const TOKEN_REFRESH_MS = 1000 * 60 * 60 * 24 * 7;
/** Shortest password we accept, unchanged. */
export const PASSWORD_MIN_LEN = 6;

// One message for "no such account", "wrong password" and "wrong recovery
// code": an attacker must not learn which of the three it was.
const WRONG_LOGIN = 'Unknown name or wrong password';
const WRONG_CODE = 'That recovery code is not valid';

// ---------------------------------------------------------------------------
// scrypt (async everywhere)
// ---------------------------------------------------------------------------

const scryptAsync = promisify(crypto.scrypt);
/** EXACTLY Node's defaults, which is what every existing hash was made with.
 *  Changing any of these silently locks every current account out. */
const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
/** Burned on failure paths so a miss costs the same wall time as a hit. */
const DUMMY_SALT = 'cove00000000000000000000000000d0';

/** @returns {Promise<string>} hex digest, same shape scryptSync produced. */
async function scryptHash(password, salt) {
  const buf = await scryptAsync(String(password), String(salt), SCRYPT_KEYLEN, SCRYPT_OPTS);
  return buf.toString('hex');
}

/** Constant-time compare of two hex digests, with the byte-length guard the
 *  codebase already knows timingSafeEqual needs (it throws on a mismatch). */
function sameDigest(a, b) {
  const got = Buffer.from(String(a || ''));
  const want = Buffer.from(String(b || ''));
  if (got.length !== want.length || got.length === 0) return false;
  return crypto.timingSafeEqual(got, want);
}

/** Spend the same cpu a real check would, so "no such account" is not faster. */
async function burnTime(password) {
  try { await scryptHash(String(password || ''), DUMMY_SALT); } catch { /* nothing to do */ }
}

async function passwordMatches(rec, password) {
  if (!rec || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') {
    await burnTime(password);
    return false;
  }
  return sameDigest(await scryptHash(String(password || ''), rec.salt), rec.hash);
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');

/**
 * `username.tokenV.exp.sig`. The username can never contain a dot (NAME_RE is
 * [a-zA-Z0-9_]) so splitting on it is unambiguous.
 * @param {string} username display-cased username
 * @param {object} [rec] the record, if the caller already has it
 */
export function makeToken(username, rec = null) {
  const who = String(username || '');
  const r = rec || users.get(who.toLowerCase());
  const v = Math.max(1, Math.floor(Number(r?.tokenV)) || 1);
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = `${who}.${v}.${exp}`;
  return `${body}.${sign(body)}`;
}

/**
 * The full token check, for callers that want more than the username.
 * @returns {{username:string, rec:object, tokenV:number, exp:number}|null}
 */
export function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null; // pre-wave-9 three-part tokens die here
  const [username, ver, exp, sig] = parts;
  // Compare BYTE lengths of the buffers we hand to timingSafeEqual: a string
  // length check passes for multi-byte UTF-8 signatures and timingSafeEqual
  // then throws RangeError, which would kill the process from the ws handler.
  if (!sameDigest(sig, sign(`${username}.${ver}.${exp}`))) return null;
  const expAt = Number(exp);
  if (!Number.isFinite(expAt) || expAt < Date.now()) return null;
  const rec = users.get(username.toLowerCase());
  if (!rec) return null;
  // The revocation check. A bumped tokenV kills every token in the wild.
  const want = Math.max(1, Math.floor(Number(rec.tokenV)) || 1);
  if (Math.floor(Number(ver)) !== want) return null;
  return { username, rec, tokenV: want, exp: expAt };
}

/** Unchanged contract: the display username, or null. */
export function verifyToken(token) {
  const info = readToken(token);
  return info ? info.username : null;
}

/**
 * A fresh token when this one is inside its last 7 days, else null. Call it at
 * hello and send the result to the client if it is non-null; a session that
 * stays connected for a fortnight then never has to see the title screen.
 */
export function maybeRefreshToken(token) {
  const info = readToken(token);
  if (!info) return null;
  if (info.exp - Date.now() > TOKEN_REFRESH_MS) return null;
  return makeToken(info.username, info.rec);
}

// ---------------------------------------------------------------------------
// bans
// ---------------------------------------------------------------------------

/** The whole live-ops stack is America/New_York; a ban notice must not print
 *  a UTC timestamp to a player who reads the clock in the plaza. */
const BAN_TZ = 'America/New_York';
let banFmt = null;
function banWhen(ms) {
  try {
    banFmt = banFmt || new Intl.DateTimeFormat('en-US', {
      timeZone: BAN_TZ, month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    return `${banFmt.format(new Date(ms))} ET`;
  } catch {
    return new Date(ms).toISOString(); // ICU-less build: still readable
  }
}

/**
 * The player-facing sentence for an active ban, or '' when there is none.
 * Exported so the hello token path in index.js says exactly what login() says.
 */
export function banMessage(rec) {
  const b = banActive(rec);
  if (!b) return '';
  const why = b.reason ? ` Reason: ${b.reason}.` : '';
  if (b.until === 'forever') return `This account is banned permanently.${why}`;
  return `This account is banned until ${banWhen(b.until)}.${why}`;
}

// ---------------------------------------------------------------------------
// recovery codes
// ---------------------------------------------------------------------------

/** How many one-time codes a player gets. Shown once, at signup. */
export const RECOVERY_CODE_COUNT = 8;
/** Per-account throttle on the consume path (the only guessable surface). */
export const RECOVERY_MAX_TRIES = 5;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;

/**
 * 256 cove-flavoured words: exactly one byte of entropy per pick, so
 * crypto.randomInt(256) is unbiased and the wordlist needs no rejection loop.
 * Words beat base32 for a secret somebody writes on paper — people transcribe
 * `otter-lantern-742` correctly and `7QF3-K2M9-XR4P` incorrectly.
 */
const WORDS = [
  'otter', 'lantern', 'cocoa', 'drift', 'pebble', 'willow', 'meadow', 'harbor',
  'mitten', 'cider', 'bramble', 'thicket', 'glimmer', 'hollow', 'marsh', 'cinder',
  'acorn', 'alder', 'amber', 'anchor', 'apple', 'arbor', 'aspen', 'autumn',
  'bagel', 'ballad', 'bamboo', 'banjo', 'barley', 'basket', 'beacon', 'bellow',
  'berry', 'birch', 'biscuit', 'blanket', 'blossom', 'blizzard', 'bonfire', 'boulder',
  'breeze', 'bridge', 'brook', 'bubble', 'bucket', 'buckle', 'bundle', 'burrow',
  'butter', 'cabin', 'cactus', 'canoe', 'canvas', 'canyon', 'caper', 'capy',
  'caramel', 'cardigan', 'carrot', 'cascade', 'cedar', 'cellar', 'chalet', 'charm',
  'cherry', 'chestnut', 'chimney', 'chowder', 'cinnamon', 'citrus', 'clover', 'cobble',
  'compass', 'conch', 'coral', 'cottage', 'crayon', 'cricket', 'crimson', 'crocus',
  'crumpet', 'crystal', 'cuddle', 'cupcake', 'current', 'cushion', 'custard', 'cygnet',
  'daisy', 'dapple', 'dawn', 'delta', 'dewdrop', 'dinghy', 'dolphin', 'donut',
  'dragon', 'driftwood', 'dumpling', 'dune', 'dusk', 'eagle', 'ember', 'evergreen',
  'fable', 'falcon', 'fathom', 'feather', 'fennel', 'fern', 'ferry', 'fiddle',
  'finch', 'fjord', 'flannel', 'flicker', 'flotsam', 'flower', 'flute', 'foghorn',
  'forest', 'fountain', 'foxglove', 'frost', 'galley', 'garland', 'gazebo', 'geode',
  'ginger', 'glacier', 'glade', 'gondola', 'gosling', 'granite', 'grotto', 'guava',
  'gully', 'hammock', 'harvest', 'hazel', 'heather', 'heron', 'hickory', 'honey',
  'hoodie', 'horizon', 'hummock', 'iceberg', 'igloo', 'indigo', 'inlet', 'ivory',
  'jasmine', 'jetty', 'jigsaw', 'juniper', 'kelp', 'kettle', 'kindling', 'kitten',
  'lagoon', 'lakeside', 'lamplight', 'larch', 'lattice', 'lavender', 'ledger', 'lichen',
  'lighthouse', 'lilac', 'linen', 'lobster', 'locket', 'lodge', 'lotus', 'lullaby',
  'lumber', 'lupine', 'mackerel', 'magnolia', 'mallard', 'mango', 'maple', 'marble',
  'marigold', 'marmalade', 'mast', 'mayfly', 'melon', 'mermaid', 'mesa', 'minnow',
  'mint', 'mirror', 'mistletoe', 'moonlight', 'moraine', 'mosaic', 'moss', 'muffin',
  'mulberry', 'mushroom', 'nectar', 'nestle', 'nettle', 'nightfall', 'noodle', 'nutmeg',
  'oakwood', 'oasis', 'oatmeal', 'ocean', 'olive', 'opal', 'orchard', 'oriole',
  'paddle', 'pancake', 'pantry', 'papaya', 'parasol', 'parsnip', 'pastel', 'peach',
  'pennant', 'peony', 'pepper', 'periwinkle', 'pewter', 'pier', 'pigment', 'pinecone',
  'pistachio', 'plateau', 'plover', 'plum', 'pocket', 'pollen', 'pond', 'poppy',
  'porch', 'pottery', 'prairie', 'pretzel', 'puddle', 'pumpkin', 'quartz', 'quilt',
  'radish', 'rafter', 'rainbow', 'raindrop', 'rapids', 'raspberry', 'reef', 'ribbon',
];
// A wordlist that is not exactly 256 unique words silently biases every code,
// and it is a constant: this either always throws at import or never does.
if (WORDS.length !== 256 || new Set(WORDS).size !== 256) {
  throw new Error(`[auth] recovery wordlist must be 256 unique words, got ${new Set(WORDS).size}/${WORDS.length}`);
}

/** `word-word-nnn`: 8 + 8 + log2(900) ~= 25.8 bits, and the consume path is
 *  throttled to 5 tries / 15 min / account, so guessing is not a threat. */
function newRecoveryCode() {
  const a = WORDS[crypto.randomInt(WORDS.length)];
  const b = WORDS[crypto.randomInt(WORDS.length)];
  return `${a}-${b}-${crypto.randomInt(100, 1000)}`;
}

/**
 * Accept what a human actually types back: any case, spaces or underscores
 * instead of hyphens, stray whitespace, and the `CAPY-` prefix people copy off
 * the card. Anything else is rejected before it costs a scrypt call.
 */
export function normalizeRecoveryCode(code) {
  const s = String(code || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^capy-/, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return /^[a-z]{2,16}-[a-z]{2,16}-\d{3}$/.test(s) ? s : '';
}

/**
 * Mint a fresh set. ONE salt per account rather than one per code, on purpose:
 * it means the consume path costs a single scrypt (hash the input once, compare
 * against 8 stored digests) instead of eight. The salt is still per-account, so
 * no precomputation carries between accounts.
 * @returns {Promise<{codes:string[], recovery:object}>} `codes` is plaintext and
 *          must be returned to the player exactly once, never stored, never logged.
 */
export async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const n = Math.max(1, Math.min(32, Math.floor(count) || RECOVERY_CODE_COUNT));
  const salt = crypto.randomBytes(16).toString('hex');
  const codes = [];
  while (codes.length < n) {
    const c = newRecoveryCode();
    if (!codes.includes(c)) codes.push(c);
  }
  // Parallel: these go to the libuv threadpool, so 8 hashes cost ~2 rounds of
  // wall time and zero event-loop time.
  const hashes = await Promise.all(codes.map((c) => scryptHash(c, salt)));
  return {
    codes,
    recovery: {
      salt,
      issuedAt: Date.now(),
      codes: hashes.map((hash) => ({ hash, usedAt: 0 })),
    },
  };
}

/**
 * True when this account has at least one unused code. Accounts created before
 * wave 9B have none at all, and there is no way to backfill them (a code has to
 * be SHOWN to be worth anything), so login flags them and the title screen's
 * "get your recovery codes" prompt calls `issueRecoveryCodes` with the password
 * the player just typed.
 */
export function hasRecoveryCodes(rec) {
  return recoveryStatus(rec).remaining > 0;
}

/** What is safe to show a player (or an operator): counts only, never codes. */
export function recoveryStatus(rec) {
  const r = rec?.recovery;
  const list = Array.isArray(r?.codes) ? r.codes : [];
  return {
    issuedAt: Math.floor(Number(r?.issuedAt) || 0),
    total: list.length,
    remaining: list.filter((c) => c && !c.usedAt).length,
  };
}

const recoveryHits = new Map(); // accountKey -> number[] of attempt timestamps
function recoveryThrottled(key) {
  const now = Date.now();
  const hits = (recoveryHits.get(key) || []).filter((t) => now - t < RECOVERY_WINDOW_MS);
  hits.push(now);
  recoveryHits.set(key, hits);
  if (recoveryHits.size > 5000) { // never let a probe grow this map without bound
    for (const [k, v] of recoveryHits) {
      if (!v.length || now - v[v.length - 1] > RECOVERY_WINDOW_MS) recoveryHits.delete(k);
    }
  }
  return hits.length > RECOVERY_MAX_TRIES;
}

// ---------------------------------------------------------------------------
// the public profile
// ---------------------------------------------------------------------------

/**
 * Everything a client is told about ITSELF. Used by signup, login, /api/me and
 * hello — all three are "this is you". `inspect` builds its own object, so
 * nothing added here leaks anyone's role to anyone else.
 */
export function publicProfile(rec) {
  return {
    name: rec.username,
    coins: rec.coins,
    color: rec.color,
    hat: rec.hat,
    // copies, never the live record arrays/objects: two sessions on one account
    // used to share a single ownedHats reference (free hats + coin rollback).
    ownedHats: [...(rec.ownedHats || ['none'])],
    bests: { ...(rec.bests || {}) },
    // wave 7 milestone rewards (server/progress.js writes both onto the record):
    // the "Legend of the Cove" title that rides under the name tag, and the
    // dye colours the stamp track has unlocked. Without them here the 12- and
    // 40-stamp milestones were granted but never visible to any client.
    title: typeof rec.title === 'string' ? rec.title : '',
    unlockedColors: [...(rec.unlockedColors || [])],
    // wave 9: identity and discipline. `caps` comes from server/admin.js's
    // profileBits spread below (auth -> admin -> db is acyclic), so the
    // capability matrix still lives in exactly one file while every call site
    // gets it for free: a site that forgot the merge handed the operator a
    // panel with no buttons (the client fails closed).
    role: roleOf(rec),
    // ms epoch, 0 = not muted. The HUD greys the chat box and shows the expiry;
    // a player who does not know they are muted files a bug report instead of
    // changing behaviour.
    muteUntil: muteRemaining(rec) > 0 ? rec.mute.until : 0,
    // true after a recovery code was spent: the client must send the player
    // through "choose a new password" before it lets them do anything else.
    mustReset: !!rec.mustReset,
    ...profileBits(rec), // { role, caps, muteUntil } from admin.js, always fresh
    ...charmBits(rec), // { charms, charmCount } - the weekly hunt trophies
  };
}

// ---------------------------------------------------------------------------
// signup / login
// ---------------------------------------------------------------------------

/** Names claimed by a signup that is still awaiting its scrypt. Without this,
 *  two concurrent signups for the same name both pass the `users.has` check. */
const pendingSignups = new Set();

/**
 * ASYNC as of wave 9B (AUDIT F-5). Callers must await.
 * @returns {Promise<{ok:true, token:string, profile:object, recoveryCodes:string[]}
 *                   |{ok:false, msg:string}>}
 *   `recoveryCodes` is the ONLY time these strings exist outside the player's
 *   hands. Show them once, behind an "I've written it down" gate; never log them.
 */
export async function signup({ username, password, color, hat }) {
  if (!NAME_RE.test(username || '')) return { ok: false, msg: `Name: ${NAME_MIN_LEN}-${NAME_MAX_LEN} letters, numbers or _` };
  {
    // wave 10A: the name filter, with a clean one-click alternative on refusal
    const nf = filterCheckName(username);
    if (!nf.ok) return { ok: false, msg: nf.msg, suggestion: nf.suggestion };
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LEN) {
    return { ok: false, msg: `Password too short (${PASSWORD_MIN_LEN}+)` };
  }
  const key = username.toLowerCase();
  if (users.has(key) || pendingSignups.has(key)) return { ok: false, msg: 'That name is taken' };

  pendingSignups.add(key);
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const [hash, recovery] = await Promise.all([
      scryptHash(password, salt),
      generateRecoveryCodes(),
    ]);
    // Re-check after the awaits: the map can have moved under us.
    if (users.has(key)) return { ok: false, msg: 'That name is taken' };

    const rec = {
      username,
      salt,
      hash,
      coins: 100, // welcome gift
      color: Number(color) || 0xb08a5a,
      hat: 'none',
      ownedHats: ['none'],
      bests: {},
      created: Date.now(),
      recovery: recovery.recovery,
    };
    if (typeof hat === 'string' && hat === 'none') rec.hat = hat;
    // The store normalises on insert: uid, role, tokenV, lastSeen, mute and ban
    // are all stamped by db.js's ensureAccount here, and COVE_ADMIN is applied
    // if this is that account. So read the record back rather than trusting the
    // literal above.
    users.set(key, rec);
    const stored = users.get(key) || rec;
    saveSoon();
    return {
      ok: true,
      token: makeToken(stored.username, stored),
      profile: publicProfile(stored),
      recoveryCodes: recovery.codes,
    };
  } finally {
    pendingSignups.delete(key);
  }
}

/**
 * ASYNC as of wave 9B (AUDIT F-5). Callers must await.
 * Password first, ban second: an unauthenticated prober must not be able to
 * discover which accounts are banned, but a banned player who cannot tell they
 * are banned just makes another account.
 * @returns {Promise<{ok:true, token:string, profile:object, mustReset?:true, noRecovery?:true}
 *                   |{ok:false, msg:string, banned?:true}>}
 */
export async function login({ username, password }) {
  const rec = users.get(String(username || '').toLowerCase());
  if (!(await passwordMatches(rec, password))) return { ok: false, msg: WRONG_LOGIN };

  const ban = banActive(rec);
  if (ban) return { ok: false, msg: banMessage(rec), banned: true };

  markSeen(rec);
  const out = { ok: true, token: makeToken(rec.username, rec), profile: publicProfile(rec) };
  if (rec.mustReset) out.mustReset = true;
  // Pre-wave-9B accounts, and anyone who has spent all eight. The client offers
  // "get new recovery codes" and calls issueRecoveryCodes() with this password.
  if (!hasRecoveryCodes(rec)) out.noRecovery = true;
  return out;
}

// ---------------------------------------------------------------------------
// recovery / password flows
// ---------------------------------------------------------------------------

/**
 * Spend one recovery code. This is a LOGIN: it hands back a live session, and
 * it sets `mustReset` so the client is obliged to walk the player through
 * picking a new password before anything else happens.
 *
 * Spending a code bumps `tokenV`, which is the point — whoever stole the
 * account is logged out of it the instant the real owner recovers.
 *
 * @returns {Promise<{ok:true, token:string, profile:object, mustReset:true, remaining:number}
 *                   |{ok:false, msg:string, banned?:true}>}
 */
export async function consumeRecoveryCode(username, code) {
  const key = String(username || '').toLowerCase();
  if (recoveryThrottled(key)) return { ok: false, msg: 'Too many attempts. Try again in 15 minutes.' };

  const rec = users.get(key);
  const norm = normalizeRecoveryCode(code);
  const salt = rec?.recovery?.salt;
  const list = Array.isArray(rec?.recovery?.codes) ? rec.recovery.codes : [];
  if (!rec || !norm || typeof salt !== 'string' || !list.length) {
    await burnTime(norm || 'x'); // same wall time whether or not the name exists
    return { ok: false, msg: WRONG_CODE };
  }

  const hash = await scryptHash(norm, salt);
  let hit = null;
  for (const entry of list) {
    // Compare every entry, used ones included: bailing early on the first match
    // would make "already used" measurably faster than "never valid".
    if (entry && sameDigest(hash, entry.hash) && !entry.usedAt && !hit) hit = entry;
  }
  if (!hit) return { ok: false, msg: WRONG_CODE };

  // Found a good code but the account is banned: say so and do NOT burn it.
  const ban = banActive(rec);
  if (ban) return { ok: false, msg: banMessage(rec), banned: true };

  hit.usedAt = Date.now();
  rec.mustReset = true;
  bumpTokenV(rec); // revokes every outstanding session, and saves
  markSeen(rec);
  return {
    ok: true,
    token: makeToken(rec.username, rec),
    profile: publicProfile(rec),
    mustReset: true,
    remaining: recoveryStatus(rec).remaining,
  };
}

/**
 * Finish the forced reset. Authorised by the token `consumeRecoveryCode`
 * returned, and ONLY while `mustReset` is set: a plain valid session token must
 * never be enough to change a password without the current one, or a stolen
 * session becomes a stolen account.
 * @returns {Promise<{ok:true, token:string, profile:object}|{ok:false, msg:string}>}
 */
export async function completePasswordReset({ token, newPassword }) {
  const info = readToken(token);
  if (!info) return { ok: false, msg: 'Session expired, start again' };
  if (!info.rec.mustReset) return { ok: false, msg: 'No password reset is pending' };
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LEN) {
    return { ok: false, msg: `Password too short (${PASSWORD_MIN_LEN}+)` };
  }
  return applyNewPassword(info.rec, newPassword);
}

/**
 * The whole "forgot my password" round trip in one call, which is what
 * `POST /api/recover {username, code, newPassword}` wants.
 * @returns {Promise<{ok:true, token:string, profile:object, remaining:number}
 *                   |{ok:false, msg:string}>}
 */
export async function recover({ username, code, newPassword }) {
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LEN) {
    return { ok: false, msg: `Password too short (${PASSWORD_MIN_LEN}+)` };
  }
  const step = await consumeRecoveryCode(username, code);
  if (!step.ok) return step;
  const done = await completePasswordReset({ token: step.token, newPassword });
  if (!done.ok) return done;
  return { ...done, remaining: step.remaining };
}

/** Change a password the normal way: prove you know the old one. */
export async function changePassword({ username, password, newPassword }) {
  const rec = users.get(String(username || '').toLowerCase());
  if (!(await passwordMatches(rec, password))) return { ok: false, msg: WRONG_LOGIN };
  if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN_LEN) {
    return { ok: false, msg: `Password too short (${PASSWORD_MIN_LEN}+)` };
  }
  return applyNewPassword(rec, newPassword);
}

/** New salt, new hash, tokenV bumped (every other session dies), flag cleared. */
async function applyNewPassword(rec, newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  rec.salt = salt;
  rec.hash = await scryptHash(newPassword, salt);
  delete rec.mustReset;
  bumpTokenV(rec); // saves
  return { ok: true, token: makeToken(rec.username, rec), profile: publicProfile(rec) };
}

/**
 * Re-issue the whole set of 8 (the "show me new codes" action, and the admin
 * panel's future equivalent). Requires the current password; the old codes all
 * stop working the moment this returns.
 * @returns {Promise<{ok:true, codes:string[]}|{ok:false, msg:string}>}
 */
export async function issueRecoveryCodes({ username, password }) {
  const rec = users.get(String(username || '').toLowerCase());
  if (!(await passwordMatches(rec, password))) return { ok: false, msg: WRONG_LOGIN };
  const { codes, recovery } = await generateRecoveryCodes();
  rec.recovery = recovery;
  saveSoon();
  return { ok: true, codes };
}

/** Force a fresh set with no password check: for `a-reset` in server/admin.js,
 *  where an operator has already verified identity out of band. The codes are
 *  returned to the ACTOR, never transmitted to the player. Always audit it. */
export async function adminIssueRecoveryCodes(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, msg: 'No such account' };
  const { codes, recovery } = await generateRecoveryCodes();
  rec.recovery = recovery;
  rec.mustReset = true; // whoever redeems it must pick a new password
  bumpTokenV(rec); // and every session the thief is holding dies now
  return { ok: true, codes, uid: rec.uid };
}
