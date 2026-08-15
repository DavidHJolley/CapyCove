/**
 * Administration module: roles, capabilities, and the `a-*` operator ops
 * (wave 9C, spec docs/research/accounts-admin.md sections 2 and 3).
 *
 * Contract with index.js — the SAME shape server/progress.js already proves:
 *  - install(ctx) is called once at boot with
 *      { world, sendTo, broadcastToRoom, broadcastAll, sessionsFor, recordFor,
 *        findEntity, joinRoom, audit, has }
 *  - handleMessage(p, m) gets FIRST REFUSAL on every ws frame from a live
 *    player and returns true to consume it. It must be called BEFORE
 *    progress.handleMessage and before the main switch.
 *
 * Why first, and why this is the whole point of the design: this hook does two
 * jobs, and the second one is structural.
 *
 *   1. It claims every `a-*` frame (the operator ops below).
 *   2. It ENFORCES MUTES AND BANS on frames it does not own. A muted player's
 *      chat / whisper / mural / dd-guess / ph-msg frame is eaten here and never
 *      reaches index.js's handler at all. That is why mute enforcement costs
 *      ZERO edits to any of the ~60 existing handlers in a 2,877-line switch,
 *      and why a new social surface added in wave 10 or 13 is muted the moment
 *      its frame name is added to MUTED_FRAMES on line ~120 of this file.
 *
 * ---------------------------------------------------------------------------
 * ONE ROAD IN: performOp(actor, op, args)
 *
 * Every op — from a ws frame today, from the S-15 web panel later — goes
 * through performOp. It resolves the target, checks the capability, checks the
 * rank guard, validates and clamps the arguments, rate-limits, mutates, emits
 * the side effects, and audits. The panel and the in-game panel therefore
 * CANNOT diverge in what they permit or in what they log, which is the only
 * way the audit trail stays worth reading (accounts-admin.md section 4.3).
 *
 * Frames this module owns (register in the CLAUDE.md protocol registry when
 * the wave ships):
 *   client -> server
 *     {t:'a-who', room?, q?}                    room populations + player list
 *     {t:'a-inspect', uid?|name?|id?}           full account readback
 *     {t:'a-mute',   <target>, mins, reason}
 *     {t:'a-unmute', <target>}
 *     {t:'a-ban',    <target>, mins, reason}    mins<=0 or 'forever' = permanent
 *     {t:'a-unban',  <target>}
 *     {t:'a-kick',   <target>, reason?}
 *     {t:'a-tp',     <target>}                  move ME to them
 *     {t:'a-announce', text}                    island-wide banner
 *   server -> the actor
 *     {t:'a-ok',  op, msg, ...data}
 *     {t:'a-err', op, msg, code}
 *   server -> the subject / the island: NO new subject frames. Side effects
 *     reuse what already ships — {t:'toast', msg} to the moderated player,
 *     {t:'denied', msg} + ws.close(4001) for a kick or ban, and
 *     {t:'announce', text, from, scope} for the island banner (the one frame
 *     the orchestrator adds to src/net/client.js; it must NOT be a `chat`,
 *     which would be filtered, rate-limited and impersonatable).
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (judgment calls are marked DECISION)
 *
 * DECISION - an unauthorised `a-*` frame gets SILENCE, not an error. A player
 * with no caps at all who sends `a-ban` is probing; probes deserve nothing back
 * and one audit line (`mod.probe`). Staff who hold *some* caps but not the one
 * this op needs get a real `a-err`, because that is a UI bug, not an attack.
 *
 * DECISION - the rank guard is strict-greater for every mutating op. A mod can
 * never mute, kick or ban another mod, an admin, or themselves. Without this,
 * one compromised mod account disables the whole staff in ten seconds.
 *
 * DECISION - mute and ban REQUIRE a reason (>= 3 chars). The reason is shown to
 * the player and written to the audit line; moderation nobody can explain three
 * weeks later is indistinguishable from abuse. Kick's reason is optional
 * because a kick changes no state and is often just "you're stuck, reconnect".
 *
 * DECISION - no shadow-mute, no IP ban, no `a-summon`, no coin adjustment in
 * this module. The first two are traps (accounts-admin.md section 9.2); the last
 * two are admin-only ops that belong with the audit log's econ events and the
 * panel, and shipping an op the client cannot yet show is dead code.
 *
 * DECISION - `a-tp` does NOT bypass a den's access list. It calls ctx.joinRoom,
 * so a closed den turns an operator away exactly as it turns anyone away, with
 * the den's own toast. Forced entry is an admin op with its own audit line and
 * it is not in this wave's scope.
 *
 * NO EARNING CAPS ANYWHERE. Nothing in this file touches grantCoins, the hourly
 * backstop, or any payout. The rate limits here bound OPERATOR actions only.
 *
 * Robustness: every entry point is wrapped. A throw inside moderation must
 * never cost a player their chat message, and must never take down the socket.
 */

import {
  store, ROLES, isRole, roleOf, setRole, bumpTokenV, saveSoon,
  muteActive, muteRemaining, banActive,
} from './db.js';
import { NAME_MAX_LEN } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// roles and capabilities
// ---------------------------------------------------------------------------

/**
 * The ordered role ladder. One comparison, not a pile of booleans whose
 * precedence every call site would have to re-learn (accounts-admin.md 2.1).
 */
export const RANK = Object.freeze({ player: 0, mod: 1, admin: 2 });

/**
 * The complete capability vocabulary. This list is the CONTRACT with 9E and
 * with the future web panel: the client never hard-codes the matrix, it reads
 * `caps` off the welcome profile and shows exactly the buttons it names.
 *
 * Adding an op later = add its cap here, add it to CAPS_BY_ROLE, add the op to
 * OPS. Three lines, one file, and the client picks it up with no redeploy.
 *
 *   who       a-who        live player list + room populations
 *   inspect   a-inspect    full account readback
 *   mute      a-mute / a-unmute
 *   kick      a-kick
 *   ban       a-ban (temporary, duration-capped by role) / nothing else
 *   ban-perm  a-ban with no expiry
 *   unban     a-unban      reversing a call is a supervisor act (spec 2.2)
 *   tp        a-tp
 *   announce  a-announce
 *   editor    NOT an op: the Ctrl+E layout editor gate in src/main.js. This is
 *             the cap that closes the CLAUDE.md:141 deployment blocker, which
 *             is today a /^david/i test on a DISPLAY NAME.
 */
export const CAPS = Object.freeze([
  'who', 'inspect', 'mute', 'kick', 'ban', 'ban-perm', 'unban', 'tp', 'announce', 'editor',
]);

const CAPS_BY_ROLE = {
  // A player holds nothing. Guests are permanently here and can never be
  // otherwise: there is no record to hold a role, so a stolen guest session can
  // never be privileged (accounts-admin.md 2.1).
  player: Object.freeze([]),
  // Destructive-but-reversible, plus time-boxed bans. This is what makes
  // "trusted community member" a thing you can hand out. The role may go
  // unused at launch; carrying it costs nothing.
  mod: Object.freeze(['who', 'inspect', 'mute', 'kick', 'ban', 'tp', 'announce']),
  // Everything, including the editor gate.
  admin: Object.freeze([...CAPS]),
};

/** Numeric rank of a stored record (or of a role string). Unknown => 0. */
export function rankOf(recOrRole) {
  const role = typeof recOrRole === 'string' ? recOrRole : roleOf(recOrRole);
  return RANK[role] ?? 0;
}

/**
 * The capability list for a role. Returns a FRESH array: this goes over the
 * wire on the welcome frame and nothing outside may mutate the cached one.
 */
export function capsFor(role) {
  return [...(CAPS_BY_ROLE[isRole(role) ? role : 'player'] || CAPS_BY_ROLE.player)];
}

/**
 * The single gate. `p` may be a live connection, a stored record, or an actor
 * descriptor; `cap` is one of CAPS. Everything else in this file asks this.
 */
export function requireCap(p, cap) {
  if (!cap) return false;
  const role = actorRole(p);
  return (CAPS_BY_ROLE[role] || CAPS_BY_ROLE.player).includes(cap);
}

/** `true` when the subject is at least `role`. Reads nicely at call sites. */
export const atLeast = (p, role) => rankOf(actorRole(p)) >= (RANK[role] ?? 99);

/**
 * The three fields the welcome profile carries (accounts-admin.md 2.3). 9B
 * calls this from publicProfile() so the caps shape lives in exactly one place.
 * `caps` costs ~60 bytes once per session and it is what stops the client from
 * ever offering a button the server will refuse.
 */
export function profileBits(rec) {
  const role = roleOf(rec);
  return { role, caps: capsFor(role), muteUntil: muteActive(rec) ? rec.mute.until : 0 };
}

function actorRole(x) {
  if (!x || typeof x !== 'object') return 'player';
  if (typeof x.role === 'string' && isRole(x.role)) return x.role; // record or actor
  if (x.rec) return roleOf(x.rec);
  // a live connection: guests have no record and are permanently rank 0
  if (x.username && ctx?.recordFor) return roleOf(ctx.recordFor(x));
  return 'player';
}

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/**
 * The frames a mute eats. Adding a social surface later? Add its frame name
 * here and it is muted everywhere, with no other edit anywhere in the server.
 * `emote` is deliberately absent: a muted player may still wave and dance.
 * They still play, still earn, still walk. Mute is not a jail.
 */
export const MUTED_FRAMES = Object.freeze(['chat', 'whisper', 'mural', 'dd-guess', 'ph-msg']);
const MUTED_SET = new Set(MUTED_FRAMES);

/** How long a mute may run, by the actor's role. Admin's ceiling is a year. */
const MUTE_MAX_MINS = { mod: 24 * 60, admin: 365 * 24 * 60 };
/** How long a *temporary* ban may run. Permanent needs the `ban-perm` cap. */
const BAN_MAX_MINS = { mod: 7 * 24 * 60, admin: 365 * 24 * 60 };

const REASON_MAX = 200;
const REASON_MIN = 3;
/** Island banners are read at a glance, not scrolled. */
const ANNOUNCE_MAX_LEN = 160;
/** Rows a single a-who may return. A scan, not a stream. */
const WHO_MAX_ROWS = 200;

/** Operator actions per second, per actor. A human clicks about once a second. */
const OP_BURST = 5;
const OP_WINDOW_MS = 1000;
/** a-who is a scan and gets its own, tighter budget (spec 3.3). */
const WHO_EVERY_MS = 2000;
/** A muted player is told once a minute, not once a keystroke. */
const MUTE_TOAST_EVERY_MS = 60_000;
/** How often a still-connected banned session is re-checked and closed. */
const BAN_RECHECK_MS = 2000;

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

let ctx = null;
/** Per-connection scratch: budgets, last-seen, toast throttles. */
const scratch = new WeakMap();
/** Per-uid budget for actors with no live connection (the web panel). */
const offlineBudget = new Map();

const stats = {
  ops: 0, refused: 0, probes: 0, mutedFrames: 0, bannedFrames: 0, errors: 0,
};

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

export function install(c) {
  ctx = c || null;
  const need = ['sendTo', 'broadcastAll', 'sessionsFor', 'recordFor', 'findEntity', 'world'];
  const missing = need.filter((k) => typeof ctx?.[k] !== 'function' && !(k === 'world' && ctx?.world));
  if (missing.length) console.warn('[admin] install() missing from ctx:', missing.join(', '));
  if (typeof ctx?.audit !== 'function') {
    // Not fatal: the module works without 9D wired. It is, however, exactly the
    // thing that makes handing out `mod` safe, so say so once, loudly.
    console.warn('[admin] no ctx.audit hook: operator actions will NOT be logged');
  }
  console.log(`[admin] ready (roles: ${ROLES.join(' < ')})`);
}

/** Counters for a future panel overview screen. */
export function adminStats() {
  return { ...stats, actors: offlineBudget.size };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const err = (msg, code = 'refused') => ({ ok: false, msg, code });

function cleanReason(v, { required = false } = {}) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
  if (required && s.length < REASON_MIN) return null;
  return s;
}

/** "45 minutes" / "2 hours" / "3 days" — read by a human in a toast. */
function humanMs(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

function sched(p) {
  let s = scratch.get(p);
  if (!s) { s = { w: 0, n: 0, whoAt: 0, muteToastAt: 0, banAt: 0, seen: Date.now() }; scratch.set(p, s); }
  return s;
}

/** One budget for live actors (WeakMap) and panel actors (pruned Map). */
function budget(actor, now) {
  if (actor.p) {
    const s = sched(actor.p);
    if (now - s.w > OP_WINDOW_MS) { s.w = now; s.n = 0; }
    return ++s.n > OP_BURST;
  }
  const key = actor.uid || actor.key || '?';
  let b = offlineBudget.get(key);
  if (!b) { b = { w: 0, n: 0, whoAt: 0 }; offlineBudget.set(key, b); }
  if (offlineBudget.size > 256) for (const [k, v] of offlineBudget) { if (now - v.w > 60_000) offlineBudget.delete(k); }
  if (now - b.w > OP_WINDOW_MS) { b.w = now; b.n = 0; }
  return ++b.n > OP_BURST;
}

function whoBudget(actor, now) {
  let b;
  if (actor.p) b = sched(actor.p);
  else {
    const key = actor.uid || actor.key || '?';
    b = offlineBudget.get(key);
    if (!b) { b = { w: 0, n: 0, whoAt: 0 }; offlineBudget.set(key, b); }
  }
  if (now - b.whoAt < WHO_EVERY_MS) return true;
  b.whoAt = now;
  return false;
}

function send(actor, msg) {
  if (actor.p && ctx?.sendTo) { try { ctx.sendTo(actor.p, msg); } catch { /* socket died */ } }
}

/** Politely disconnect one live session: tell it why, then close it. */
function closeSession(p, msg) {
  try { ctx.sendTo(p, { t: 'denied', msg }); } catch { /* already gone */ }
  try { p.ws?.close(4001, 'moderated'); } catch { /* already gone */ }
}

function toastAll(sessions, msg) {
  for (const s of sessions) { try { ctx.sendTo(s, { t: 'toast', msg }); } catch { /* gone */ } }
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/**
 * One shape, every op, through the hook the orchestrator wires to 9D.
 *
 * The event object is EXACTLY what `server/audit.js`'s `log(event)` consumes,
 * so the wiring is `audit: auditLog` with no adapter: `{op, ts, via, actor,
 * target, args, before?, after?, ok}`. `op` also rides the second positional
 * argument, which `log` ignores, so a different sink shape still gets it.
 *
 * Two things 9D's redactor makes load-bearing here:
 *  - it drops any `text` / `msg` / `lines` key at any depth inside args (chat
 *    contents belong to the 7-day chat log, not the 90-day admin log), so the
 *    announcement copy travels as `note`, which it deliberately keeps;
 *  - `log` builds its record from a fixed field list, so a refusal reason has
 *    to ride INSIDE args (`args.deny`) or it is silently dropped.
 *
 * Never sent from here: chat contents, passwords, tokens, raw IPs.
 */
function audit(op, actor, target, args, extra = {}) {
  if (typeof ctx?.audit !== 'function') return;
  const a = args && typeof args === 'object' ? { ...args } : {};
  if (extra.deny) a.deny = extra.deny;
  const entry = {
    op,
    ts: Date.now(),
    via: actor?.via || 'ingame',
    actor: {
      uid: actor?.uid || null,
      name: actor?.name || '',
      role: actor?.role || 'player',
      ipH: actor?.ipH || '',
      id: actor?.p?.id || '',
    },
    target: target ? { uid: target.uid || null, name: target.name || '', id: target.entity?.id || '' } : null,
    args: a,
    ok: extra.ok !== false,
  };
  if (extra.before) entry.before = extra.before;
  if (extra.after) entry.after = extra.after;
  // A logging failure must never cost an operator their op.
  try { ctx.audit(entry, op); } catch (e) { console.error('[admin] audit hook threw:', e?.message || e); }
}

// ---------------------------------------------------------------------------
// actors and targets
// ---------------------------------------------------------------------------

/**
 * Normalise whatever the caller has into one actor descriptor.
 *
 * Accepts: a live player object (the ws path), or `{uid}` / `{key}` / `{name}`
 * (the panel path, which has no socket). `via` is recorded on every audit line
 * so "who did this and from where" survives the session.
 */
export function actorFrom(x, via = 'ingame') {
  if (!x || typeof x !== 'object') return null;
  // A live connection: has an id and a socket-ish shape.
  if (x.id && (x.ws || own(x, 'registered'))) {
    const rec = ctx?.recordFor ? ctx.recordFor(x) : null;
    return {
      p: x, rec, key: x.username ? String(x.username).toLowerCase() : '',
      uid: rec?.uid || '', name: x.name || rec?.username || '', role: roleOf(rec),
      ipH: x.ipH || x.ws?._ipH || rec?.lastIpH || '', via,
    };
  }
  // A stored record straight from the store.
  if (typeof x.uid === 'string' && typeof x.username === 'string' && own(x, 'role')) {
    return { p: null, rec: x, key: x.username.toLowerCase(), uid: x.uid, name: x.username, role: roleOf(x), ipH: x.lastIpH || '', via };
  }
  // A descriptor: {uid} | {key} | {name}
  const rec = (x.uid && store.findByUid(x.uid))
    || (x.key && store.getUser(String(x.key).toLowerCase()))
    || (x.name && store.getUser(String(x.name).toLowerCase()))
    || null;
  if (!rec) return null;
  return { p: null, rec, key: rec.username.toLowerCase(), uid: rec.uid, name: rec.username, role: roleOf(rec), ipH: rec.lastIpH || '', via };
}

/**
 * Resolve `{uid} | {name} | {id}` to a target, in that priority order (spec
 * 3.3). Returns the record when there is one, every live session for it, and
 * a bot flag — bots resolve so `a-who` can list them, but every mutating op
 * refuses them.
 */
export function resolveTarget(m) {
  if (!m || typeof m !== 'object') return null;
  let rec = null;
  let entity = null;
  let bot = false;

  if (typeof m.uid === 'string' && m.uid) rec = store.findByUid(m.uid);
  if (!rec && typeof m.name === 'string' && m.name.trim()) {
    rec = store.getUser(m.name.trim().toLowerCase()) || null;
  }
  if (!rec && typeof m.id === 'string' && m.id && ctx?.findEntity) {
    entity = ctx.findEntity(m.id);
    if (entity) {
      bot = !!entity.bot;
      if (!bot && ctx.recordFor) rec = ctx.recordFor(entity) || null;
    }
  }
  if (!rec && !entity) return null;

  const key = rec ? rec.username.toLowerCase() : (entity?.username ? String(entity.username).toLowerCase() : '');
  const sessions = key && ctx?.sessionsFor ? ctx.sessionsFor(key) : (entity && !bot ? [entity] : []);
  return {
    rec,
    bot,
    key,
    uid: rec?.uid || '',
    name: rec?.username || entity?.name || '',
    entity: entity || sessions[0] || null,
    sessions: sessions.length ? sessions : (entity && !bot ? [entity] : []),
    // a guest connection: a real person with no durable identity to punish
    guest: !rec && !!entity && !bot,
  };
}

// ---------------------------------------------------------------------------
// the op table
// ---------------------------------------------------------------------------

/**
 * Each op declares its capability, whether it needs a target, whether it
 * mutates (which turns on the rank guard and the self guard), and its body.
 * performOp does everything around them, identically, every time.
 */
const OPS = {
  who: { cap: 'who', target: false, mutates: false, run: opWho },
  inspect: { cap: 'inspect', target: true, mutates: false, run: opInspect },
  mute: { cap: 'mute', target: true, mutates: true, run: opMute },
  unmute: { cap: 'mute', target: true, mutates: true, run: opUnmute },
  ban: { cap: 'ban', target: true, mutates: true, run: opBan },
  unban: { cap: 'unban', target: true, mutates: true, run: opUnban },
  kick: { cap: 'kick', target: true, mutates: true, run: opKick },
  tp: { cap: 'tp', target: true, mutates: false, run: opTp },
  announce: { cap: 'announce', target: false, mutates: false, run: opAnnounce },
};

/** Audit op names (accounts-admin.md 7.2 vocabulary). */
const AUDIT_NAME = {
  who: 'mod.who', inspect: 'mod.inspect', mute: 'mod.mute', unmute: 'mod.unmute',
  ban: 'mod.ban', unban: 'mod.unban', kick: 'mod.kick', tp: 'mod.tp', announce: 'mod.say',
};

// ---------- reads ----------

function opWho(actor, _t, args) {
  const world = ctx?.world;
  if (!world?.rooms || !world?.players) return err('World not available', 'unavailable');
  const roomFilter = typeof args.room === 'string' && args.room ? args.room : '';
  const q = typeof args.q === 'string' ? args.q.trim().toLowerCase().slice(0, NAME_MAX_LEN) : '';

  const rooms = {};
  for (const [id, set] of world.rooms) rooms[id] = set.size;

  const now = Date.now();
  const players = [];
  for (const p of world.players.values()) {
    if (roomFilter && p.room !== roomFilter) continue;
    if (q && !String(p.name || '').toLowerCase().startsWith(q)) continue;
    const rec = p.registered && ctx.recordFor ? ctx.recordFor(p) : null;
    const s = scratch.get(p);
    players.push({
      id: p.id,
      uid: rec?.uid || '',
      name: p.name,
      room: p.room || '',
      registered: !!p.registered,
      role: roleOf(rec),
      muted: rec ? muteRemaining(rec, now) : 0,
      banned: rec && banActive(rec, now) ? 1 : 0,
      coins: rec ? (rec.coins | 0) : (p.coins | 0),
      idleMs: s ? Math.max(0, now - s.seen) : 0,
      ipH: p.ipH || p.ws?._ipH || rec?.lastIpH || '',
    });
    if (players.length >= WHO_MAX_ROWS) break;
  }
  players.sort((a, b) => (a.room === b.room ? a.name.localeCompare(b.name) : a.room.localeCompare(b.room)));
  return {
    ok: true,
    msg: `${players.length} online${roomFilter ? ` in ${roomFilter}` : ''}`,
    total: world.players.size,
    rooms,
    players,
  };
}

/** Never leaves this file, never reaches the wire. */
const SECRET_FIELDS = new Set(['hash', 'salt', 'pass', 'password', 'recovery', 'resetToken', 'token']);

function opInspect(actor, t, _args) {
  if (t.bot) return err('That is one of the cove citizens, not a player', 'bot');
  if (!t.rec) {
    // a guest: everything there is to know lives on the connection
    const e = t.entity;
    return {
      ok: true, msg: `${t.name} is a guest (no account)`,
      account: {
        guest: true, name: t.name, id: e?.id || '', room: e?.room || '',
        coins: e?.coins | 0, hat: e?.hat || 'none', color: e?.color | 0,
      },
    };
  }
  const rec = t.rec;
  const now = Date.now();
  const house = rec.house && typeof rec.house === 'object' ? rec.house : {};
  const account = {
    uid: rec.uid,
    name: rec.username,
    key: t.key,
    role: roleOf(rec),
    tokenV: rec.tokenV | 0,
    created: rec.created || 0,
    lastSeen: rec.lastSeen || 0,
    renamedAt: rec.renamedAt || 0,
    lastIpH: rec.lastIpH || '',
    coins: rec.coins | 0,
    hat: rec.hat || 'none',
    color: rec.color | 0,
    title: rec.title || '',
    hats: Array.isArray(rec.ownedHats) ? rec.ownedHats.length : 0,
    furniture: rec.ownedFurniture && typeof rec.ownedFurniture === 'object' ? Object.keys(rec.ownedFurniture).length : 0,
    bests: { ...(rec.bests || {}) },
    stamps: rec.stamps && typeof rec.stamps === 'object' ? Object.keys(rec.stamps).length : 0,
    friends: Array.isArray(rec.friends) ? rec.friends.length : 0,
    house: {
      access: house.access || '',
      invites: Array.isArray(house.invites) ? house.invites.length : 0,
      items: Array.isArray(house.furniture) ? house.furniture.length : 0,
    },
    mute: rec.mute ? { ...rec.mute, remaining: muteRemaining(rec, now) } : null,
    ban: banActive(rec, now) ? { ...rec.ban } : (rec.ban ? { ...rec.ban, expired: true } : null),
    sessions: t.sessions.map((s) => ({ id: s.id, room: s.room || '', idleMs: scratch.get(s) ? Math.max(0, now - scratch.get(s).seen) : 0 })),
    // What ELSE is on this record. Names only: an operator should be able to
    // see that an unexpected field exists without the field's value ever
    // leaving the server. Secrets are not even named.
    fields: Object.keys(rec).filter((k) => !SECRET_FIELDS.has(k)).sort(),
  };
  return { ok: true, msg: `${rec.username} (${account.role})`, account };
}

// ---------- discipline ----------

function opMute(actor, t, args) {
  if (t.bot) return err('The cove citizens do not need moderating', 'bot');
  if (!t.rec) return err('Guests have no account to mute — kick them instead', 'guest');
  const reason = cleanReason(args.reason, { required: true });
  if (reason === null) return err('A mute needs a reason (3+ characters)', 'reason');

  const max = MUTE_MAX_MINS[actor.role] ?? MUTE_MAX_MINS.mod;
  const mins = Math.floor(Number(args.mins));
  if (!Number.isFinite(mins) || mins < 1) return err('Mute length must be 1 minute or more', 'args');
  if (mins > max) return err(`Your role may mute for at most ${humanMs(max * 60_000)}`, 'cap');

  const before = t.rec.mute ? { ...t.rec.mute } : null;
  const until = Date.now() + mins * 60_000;
  t.rec.mute = { until, by: actor.name, reason };
  saveSoon();

  toastAll(t.sessions, `You have been muted for ${humanMs(mins * 60_000)} (${reason}). You can still play, walk and earn.`);
  return {
    ok: true, msg: `${t.name} muted for ${humanMs(mins * 60_000)}`,
    uid: t.uid, until,
    _audit: { before: { mute: before }, after: { mute: { until, by: actor.name, reason } }, args: { mins, reason } },
  };
}

function opUnmute(actor, t, _args) {
  if (!t.rec) return err('No account to unmute', 'guest');
  if (!t.rec.mute) return err(`${t.name} is not muted`, 'noop');
  const before = { ...t.rec.mute };
  t.rec.mute = null;
  saveSoon();
  toastAll(t.sessions, 'Your mute has been lifted. Welcome back.');
  return { ok: true, msg: `${t.name} unmuted`, uid: t.uid, _audit: { before: { mute: before }, after: { mute: null } } };
}

function opBan(actor, t, args) {
  if (t.bot) return err('The cove citizens do not need moderating', 'bot');
  if (!t.rec) return err('Guests have no account to ban — kick them instead', 'guest');
  const reason = cleanReason(args.reason, { required: true });
  if (reason === null) return err('A ban needs a reason (3+ characters)', 'reason');

  // mins <= 0, 'forever' or absent = permanent, and permanent is its own cap.
  const raw = args.mins;
  const forever = raw === 'forever' || raw === undefined || raw === null || Math.floor(Number(raw)) <= 0;
  let until;
  let label;
  if (forever) {
    if (!requireCap(actor, 'ban-perm')) return err('Only an admin may ban permanently', 'cap');
    until = 'forever';
    label = 'permanently';
  } else {
    const mins = Math.floor(Number(raw));
    if (!Number.isFinite(mins)) return err('Ban length is not a number', 'args');
    const max = BAN_MAX_MINS[actor.role] ?? BAN_MAX_MINS.mod;
    if (mins > max) return err(`Your role may ban for at most ${humanMs(max * 60_000)}`, 'cap');
    until = Date.now() + mins * 60_000;
    label = `for ${humanMs(mins * 60_000)}`;
  }

  const before = t.rec.ban ? { ...t.rec.ban } : null;
  t.rec.ban = { until, by: actor.name, reason, at: Date.now() };
  // Every issued token dies with the ban, so a token minted five minutes ago
  // cannot walk back in. bumpTokenV persists.
  bumpTokenV(t.rec);

  // Without this the banned player stays in the world until they disconnect.
  const closed = t.sessions.length;
  for (const s of t.sessions) closeSession(s, banMessage(t.rec));

  return {
    ok: true, msg: `${t.name} banned ${label} (${closed} session${closed === 1 ? '' : 's'} closed)`,
    uid: t.uid, until, closed,
    _audit: { before: { ban: before }, after: { ban: { ...t.rec.ban } }, args: { mins: forever ? 0 : Math.floor(Number(raw)), reason } },
  };
}

function opUnban(actor, t, _args) {
  if (!t.rec) return err('No account to unban', 'guest');
  if (!t.rec.ban) return err(`${t.name} is not banned`, 'noop');
  const before = { ...t.rec.ban };
  t.rec.ban = null;
  bumpTokenV(t.rec); // an unban re-mints: the old tokens stay dead
  return { ok: true, msg: `${t.name} unbanned`, uid: t.uid, _audit: { before: { ban: before }, after: { ban: null } } };
}

function opKick(actor, t, args) {
  if (t.bot) return err('The cove citizens do not need moderating', 'bot');
  const reason = cleanReason(args.reason);
  if (!t.sessions.length) return err(`${t.name} is not connected`, 'offline');
  const msg = reason
    ? `You were disconnected by ${actor.name}: ${reason}`
    : `You were disconnected by ${actor.name}. You can reconnect right away.`;
  const closed = t.sessions.length;
  for (const s of t.sessions) closeSession(s, msg);
  // No record change at all: a kick is a disconnect, and reconnecting is fine.
  return { ok: true, msg: `${t.name} kicked (${closed} session${closed === 1 ? '' : 's'})`, uid: t.uid, closed, _audit: { args: { reason } } };
}

// ---------- movement and broadcast ----------

function opTp(actor, t, _args) {
  if (!actor.p) return err('Teleport needs a live session', 'nosession');
  const dest = t.sessions[0] || t.entity;
  if (!dest || !dest.room) return err(`${t.name} is not in a room right now`, 'offline');
  if (dest.id === actor.p.id) return err('You are already exactly there', 'self');

  const from = actor.p.room;
  if (from !== dest.room) {
    if (typeof ctx?.joinRoom !== 'function') return err('Room moves are not wired', 'unavailable');
    // Goes through the normal door: a closed den turns an operator away with
    // the den's own toast, exactly as it turns anyone away.
    ctx.joinRoom(actor.p, dest.room);
    if (actor.p.room !== dest.room) return err('That room would not let you in', 'denied');
  }
  // Land beside them, not on them. The 10Hz state tick carries this to
  // everyone else; the actor's own client warps itself using `at` (9E).
  actor.p.x = Number(dest.x || 0) + 1.2;
  actor.p.z = Number(dest.z || 0) + 1.2;
  actor.p.y = Number(dest.y || 0);
  return {
    ok: true, msg: `Warped to ${t.name} in ${dest.room}`,
    room: dest.room, at: { x: actor.p.x, y: actor.p.y, z: actor.p.z }, id: dest.id, uid: t.uid,
    _audit: { args: { from, to: dest.room } },
  };
}

function opAnnounce(actor, _t, args) {
  const text = String(args.text ?? '').replace(/\s+/g, ' ').trim().slice(0, ANNOUNCE_MAX_LEN);
  if (text.length < 2) return err('Nothing to announce', 'args');
  if (typeof ctx?.broadcastAll !== 'function') return err('Broadcast is not wired', 'unavailable');
  // Its OWN frame, never `chat`: a chat line would be filtered, rate-limited,
  // room-scoped and impersonatable by any player who types the same words.
  ctx.broadcastAll({ t: 'announce', text, from: actor.name, scope: 'world', at: Date.now() });
  // `note`, not `text`: 9D's redactor strips `text` at any depth (chat belongs
  // to the chat log) and deliberately keeps `note` for operator-authored copy.
  return { ok: true, msg: 'Announced to the whole island', text, _audit: { args: { note: text } } };
}

/** The line a banned player sees, everywhere a ban is enforced. */
export function banMessage(rec) {
  const b = banActive(rec);
  if (!b) return 'You are not banned.';
  const why = b.reason ? ` (${b.reason})` : '';
  if (b.until === 'forever') return `This account is banned${why}.`;
  const left = b.until - Date.now();
  return `This account is banned for another ${humanMs(left)}${why}.`;
}

// ---------------------------------------------------------------------------
// performOp: the one road in
// ---------------------------------------------------------------------------

/**
 * Run one operator op. THE shared entry point: the ws frames below call it, and
 * the S-15 web panel will call it with `via:'panel'`. Everything the op needs
 * to be safe happens here, once, for all of them.
 *
 * @param {object} actor  a live player, a record, or {uid|key|name} (+ via)
 * @param {string} op     'a-mute' or 'mute' — both accepted
 * @param {object} args   the frame body (target keys included)
 * @returns {{ok:true, msg:string}|{ok:false, msg:string, code:string}}
 */
export function performOp(actor, op, args = {}) {
  const a = actor && actor.role && own(actor, 'via') ? actor : actorFrom(actor, args?.via || 'ingame');
  const name = String(op || '').replace(/^a-/, '');
  const spec = own(OPS, name) ? OPS[name] : null;
  if (!spec) return err(`Unknown op '${op}'`, 'unknown');
  if (!a) return err('Unknown actor', 'noactor');

  try {
    // 1. capability. No caps at all = a probe: the caller decides whether to
    //    answer (handleMessage answers with silence).
    if (!requireCap(a, spec.cap)) {
      stats.refused++;
      const bare = rankOf(a.role) === 0;
      if (bare) { stats.probes++; audit('mod.probe', a, null, { op: name }, { ok: false }); }
      else audit(AUDIT_NAME[name] || `mod.${name}`, a, null, { op: name }, { ok: false, deny: 'no-capability' });
      return err('You do not have permission to do that', bare ? 'silent' : 'cap');
    }

    // 2. rate limit. Refusals here are NOT audited: a double-click must not be
    //    able to pump the audit log.
    const now = Date.now();
    if (name === 'who' ? whoBudget(a, now) : budget(a, now)) {
      stats.refused++;
      return err('Slow down a moment', 'slow');
    }

    // 3. target
    let target = null;
    if (spec.target) {
      target = resolveTarget(args);
      if (!target) { stats.refused++; return err('No such player', 'notarget'); }
      if (spec.mutates) {
        // self guard: nobody moderates themselves into a corner
        const isSelf = (target.rec && a.rec && target.rec === a.rec)
          || target.sessions.some((s) => a.p && s.id === a.p.id);
        if (isSelf) {
          stats.refused++;
          audit(AUDIT_NAME[name] || `mod.${name}`, a, target, { op: name }, { ok: false, deny: 'self' });
          return err('You cannot do that to yourself', 'self');
        }
        // rank guard: strictly greater, always. A mod can never touch a mod.
        if (target.rec && rankOf(roleOf(target.rec)) >= rankOf(a.role)) {
          stats.refused++;
          audit(AUDIT_NAME[name] || `mod.${name}`, a, target, { op: name }, { ok: false, deny: 'rank' });
          return err(`${target.name} outranks that action`, 'rank');
        }
      }
    }

    // 4. run
    const res = spec.run(a, target, args || {});
    const extra = res._audit || {};
    delete res._audit;
    stats.ops++;
    if (!res.ok) stats.refused++;
    audit(AUDIT_NAME[name] || `mod.${name}`, a, target, extra.args || pickArgs(name, args), {
      ok: res.ok !== false,
      ...(extra.before ? { before: extra.before } : {}),
      ...(extra.after ? { after: extra.after } : {}),
      ...(res.ok ? {} : { deny: res.code }),
    });
    return res;
  } catch (e) {
    stats.errors++;
    console.error(`[admin] op '${name}' failed:`, e?.message || e);
    audit(AUDIT_NAME[name] || `mod.${name}`, a, null, { op: name }, { ok: false, deny: 'threw' });
    return err('That did not work', 'error');
  }
}

/** What of the request is worth keeping in the log for a read-only op. */
function pickArgs(name, args) {
  if (name === 'who') return { room: args.room || '', q: args.q || '' };
  if (name === 'inspect') return { uid: args.uid || '', name: args.name || '', id: args.id || '' };
  return {};
}

// ---------------------------------------------------------------------------
// the first-refusal hook
// ---------------------------------------------------------------------------

/**
 * Called by index.js for every frame from a live player, BEFORE
 * progress.handleMessage and before the main switch. Return true to consume.
 *
 * Order matters and is deliberate:
 *   move frames   -> released instantly (10Hz hot path, nothing here owns it)
 *   banned actor  -> session closed, frame consumed
 *   muted actor   -> social frames consumed with a throttled toast
 *   a-* frames    -> claimed
 *   everything else -> released
 */
export function handleMessage(p, m) {
  if (!ctx || !p || !m || typeof m.t !== 'string') return false;
  try {
    const t = m.t;
    // The movement stream is ten frames a second per player and carries nothing
    // this module moderates. Stamp presence and get out of the way.
    if (t === 'move') { sched(p).seen = Date.now(); return false; }

    const now = Date.now();
    const s = sched(p);
    s.seen = now;

    const rec = p.registered && ctx.recordFor ? ctx.recordFor(p) : null;

    // --- ban pre-empt -------------------------------------------------------
    // a-ban already closes live sessions the moment it lands, so this is the
    // backstop for the other paths: a ban applied from the panel while the
    // player was mid-frame, or a record restored from a backup.
    if (rec && banActive(rec, now) && now - s.banAt > BAN_RECHECK_MS) {
      s.banAt = now;
      stats.bannedFrames++;
      closeSession(p, banMessage(rec));
      return true;
    }

    // --- mute pre-empt ------------------------------------------------------
    // THE structural win: five frame names here replace five edits scattered
    // through a 2,877-line switch, and wave 10's new social surfaces need one
    // more string, not one more patch.
    if (MUTED_SET.has(t) && rec && muteActive(rec, now)) {
      stats.mutedFrames++;
      if (now - s.muteToastAt > MUTE_TOAST_EVERY_MS) {
        s.muteToastAt = now;
        const why = rec.mute.reason ? ` (${rec.mute.reason})` : '';
        // Loud to the muted player, silent to the room. A player who does not
        // know they are muted files a bug report instead of changing behaviour.
        ctx.sendTo(p, { t: 'toast', msg: `You are muted for another ${humanMs(muteRemaining(rec, now))}${why}.` });
      }
      return true; // never reaches index.js's handler
    }

    // --- the a-* family -----------------------------------------------------
    if (t.length < 3 || t[0] !== 'a' || t[1] !== '-') return false;
    const name = t.slice(2);
    if (!own(OPS, name)) return false; // not ours; let index.js have it

    const actor = actorFrom(p, 'ingame');
    if (!actor) return true; // a guest sending a-*: consumed, answered with nothing

    const res = performOp(actor, name, m);
    if (res.ok) {
      const { ok, msg, ...rest } = res;
      ctx.sendTo(p, { t: 'a-ok', op: t, msg, ...rest });
    } else if (res.code !== 'silent') {
      ctx.sendTo(p, { t: 'a-err', op: t, msg: res.msg, code: res.code });
    }
    // 'silent': an unprivileged probe gets nothing back at all, only a log line.
    return true;
  } catch (e) {
    stats.errors++;
    console.error('[admin] handleMessage failed:', e?.message || e);
    return false; // never eat a player's frame because moderation threw
  }
}

// ---------------------------------------------------------------------------
// re-exports the rest of the wave asks for by name
// ---------------------------------------------------------------------------

export { muteActive, muteRemaining, banActive, roleOf, setRole, isRole, ROLES };
