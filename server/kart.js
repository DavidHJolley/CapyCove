/**
 * server/kart.js — Capy Karts: the authoritative race service (wave K, K3).
 *
 * Six capybaras, three laps, one beachside circuit. This file is the ONLY
 * server-side home of the `kart-*` family; server/index.js merely routes to it
 * (four lines, listed in docs/KARTS.md §8) and never learns a thing about
 * karts. Everything here is written against docs/KARTS.md, which is FROZEN:
 * where a number appears below it came from that document, and a disagreement
 * belongs in the wave report, not in a different number.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SERVER OWNS, AND WHAT IT DOES NOT
 *
 * Owns: the lobby, the grid, the countdown epoch, lap validation, item boxes,
 * the roulette, hazard/projectile flight, every hit verdict, the AI karts,
 * finish order by the server clock, and the placement a payout is worth.
 *
 * Does NOT own: driving. Position is client-simulated and relayed at 10 Hz,
 * exactly like the sled, because a cozy kart wants 60 fps of steering feel and
 * a 10 Hz authority would feel like driving through syrup. What stops that
 * being a cheat surface is the shape of the wire (docs/KARTS.md §2): the only
 * lap value that travels is normalised progress `q`, so a warp is a number
 * this file can simply CLAMP. There is no track geometry in this file at all.
 *
 * ---------------------------------------------------------------------------
 * THE ANTI-CUT RULE (the one that matters)
 *
 * A lap counts only when all six checkpoint bits are set when the finish line
 * is crossed, and forward `q` moves at most KART_MAX_Q_PER_S (0.075) per
 * second. Those two together make a fake lap arithmetically impossible rather
 * than merely unlikely: a lap costs >= 1/0.075 = 13.3 s of continuous,
 * in-sequence frames, so three laps cost >= ~40 s of wall clock, which is
 * exactly the `minRunMs: 40_000` floor the coin road enforces on the other end.
 *
 * A too-large jump is CLAMPED, never dropped. Dropping the frame would punish
 * a lagged honest player by freezing their kart for everyone else; clamping
 * costs a cheater their teleport and costs an honest player nothing they can
 * feel. One audit line per player per race records that it happened.
 *
 * ---------------------------------------------------------------------------
 * PAYOUTS: the server knows the placement, the normal coin road pays it
 *
 * Coins ride the ordinary minigame road (mgstart -> best -> score, all in
 * server/econ.js + the 'score' case in index.js). This module never grants a
 * coin. What it does instead is OBSERVE the 'score' frame for game 'kart' on
 * its way past — kart.handleMessage sits directly after econ.handleMessage and
 * before the main switch — and, when the server ran the race the frame claims,
 * REWRITES `m.coins` and `m.score` to the authoritative numbers computed from
 * the placement this file assigned by its own clock. It returns false, so the
 * frame still falls through to the normal 'score' case and the normal token,
 * room and duration guards all still apply. A forged first place is therefore
 * not refused, it is CORRECTED, which is better: the honest part of the run is
 * still paid, and the lie is worth nothing.
 *
 * A practice lap (docs/KARTS.md §5, no server race behind it) is left entirely
 * alone: it is an ordinary solo minigame run, and `maxCoinsPerRun` + `minRunMs`
 * bound it exactly the way they bound fishing. A ghost or a DNF parks a ZERO,
 * so the frame it sends pays nothing — that is the contract's "a ghost is never
 * paid", enforced on the wire rather than trusted to the client.
 *
 * NOTHING HERE CAPS AN HONEST RUN. The owner's law holds: every number below
 * is either the contract's own payout table or a refusal of something that did
 * not happen.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT WITH index.js (the install(ctx) shape econ/progress/layouts prove)
 *
 *   kart.install({ sendTo, broadcastToRoom, world, has, log, audit })  at boot
 *   kart.handleMessage(p, m)  consumes every 'kart-*' frame, returns true;
 *                             OBSERVES 'join' and 'score' and returns false
 *   kart.dropPlayer(p)        on disconnect, beside econ.dropPlayer(p)
 *
 * Nothing in this module wires itself, reads a socket directly except to reuse
 * one pre-serialised hot-path string, or touches shared/constants.js beyond
 * reading BODY_COLORS for AI paintwork.
 *
 * ---------------------------------------------------------------------------
 * TIME AND TIMERS
 *
 * There is exactly ONE timer in this module: a 10 Hz heartbeat started by
 * install(). Every deadline (lobby countdown, grid lead-in, box respawn, hazard
 * expiry, finish grace, race timeout) is a timestamp checked by that heartbeat,
 * never its own setTimeout. That is what makes the whole lifecycle testable:
 * a test installs with `{ now, autoTick: false }` and drives `kart.tick()` by
 * hand, and a leaked race cannot leave a stray timer behind.
 */

import { BODY_COLORS } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// frozen constants (docs/KARTS.md §1, §3, §4)
// ---------------------------------------------------------------------------

/** The paddock. A racer signs on, races and is paid standing in this room. */
export const ROOM = 'speedway';
/** The MINIGAMES id the coin road binds a run token to. */
export const GAME = 'kart';
export const TRACK_ID = 'cove-speedway/1';

export const MAX_RACERS = 6;
export const LAPS = 3;
/** One lap of the circuit, in world units. Both sides of the wire assume it. */
export const LAP_UNITS = 545;
export const CHECKPOINTS = 6;
/** All six checkpoint bits set. */
const ALL_CPS = (1 << CHECKPOINTS) - 1;

/** 3 red beats at 800ms then GO. */
export const KART_LIGHTS_MS = 3200;
/** kart-grid lands this long before kart-go, so clients can build the track. */
export const GRID_LEAD_MS = 1200;
/** The oldest sign-on waits this long, then races whatever AI fill it needs. */
export const KART_WAIT_MS = 20_000;
/** A full grid (or a 'kart-start-now') arms this short a pre-start. */
export const START_SOON_MS = 3_000;

/** Relay rate, both directions. */
export const TICK_MS = 100;
/** The spectator jumbotron, at 2 Hz. */
export const BOARD_MS = 500;
/** Forward progress ceiling: ~40.9 u/s, safely above the 32 u/s boost ceiling. */
export const KART_MAX_Q_PER_S = 0.075;
/** Backward slack before a rewind is treated as noise and zeroed. */
export const KART_MAX_BACK_Q = 0.02;
/** kart-in gets its own budget, not the social one. */
export const KART_IN_LIMIT = 15;
/** kart-join / kart-leave / kart-start-now share the social budget's shape. */
export const KART_SOCIAL_LIMIT = 5;
/** A single relay frame may never account for more than this much elapsed time. */
export const MAX_FRAME_DT_MS = 1500;

export const FINISH_GRACE_MS = 25_000;
export const RACE_MAX_MS = 360_000;
export const KART_REJOIN_MS = 45_000;
/** How long an authoritative placement waits for the 'score' frame that claims it. */
export const PAYOUT_TTL_MS = 180_000;

// --- items (docs/KARTS.md §3.3) --------------------------------------------

export const BOX_RESPAWN_MS = 5_000;
/** kart-box tolerances: you must really have driven through it. */
export const BOX_Q_TOL = 0.006;
/**
 * The relayed q is up to a relay period (plus jitter) STALE when the claim
 * arrives, and the kart only ever moves forward through a box, so the claim
 * window is asymmetric: a little behind, a fair bit ahead. 0.015 is ~8 track
 * units = 250ms at the hardest boost (32 u/s), which keeps the box honest
 * (you still had to drive through it) without refusing real pickups.
 */
export const BOX_Q_STALE = 0.015;
export const BOX_LAT_TOL = 0.22;

export const PEEL_TTL_MS = 25_000;
export const PEEL_HIT_Q = 0.004;
export const PEEL_HIT_LAT = 0.30;
export const PEEL_SELF_IMMUNE_MS = 800;
export const PEEL_SPIN_MS = 1100;
export const PEEL_BEHIND_U = 3.5;

export const BUBBLE_SPEED_U = 34;
export const BUBBLE_TTL_MS = 4_000;
export const BUBBLE_HIT_LAT = 0.34;
export const BUBBLE_SLOW_MS = 2_000;
export const BUBBLE_HOMING_LAT_PER_S = 1.4;
export const BUBBLE_SEEK_U = 60;

export const BERRY_MS = 1300;

/** Eleven boxes, frozen in (q, lat) so both sides agree without the spline. */
export const BOXES = Object.freeze([
  { q: 0.220, lat: -0.62 }, { q: 0.220, lat: -0.21 },
  { q: 0.220, lat: +0.21 }, { q: 0.220, lat: +0.62 },
  { q: 0.550, lat: -0.45 }, { q: 0.550, lat: 0.00 }, { q: 0.550, lat: +0.45 },
  { q: 0.790, lat: -0.62 }, { q: 0.790, lat: -0.21 },
  { q: 0.790, lat: +0.21 }, { q: 0.790, lat: +0.62 },
].map(Object.freeze));

/**
 * Roulette weights by current place. A gentle rubber band: the leader still
 * gets something useful, and nobody at the back gets a race-winning miracle.
 */
const ITEM_ODDS = Object.freeze({
  front: Object.freeze([['peel', 55], ['bubble', 30], ['berry', 15]]),
  mid: Object.freeze([['peel', 35], ['bubble', 35], ['berry', 30]]),
  back: Object.freeze([['peel', 20], ['bubble', 35], ['berry', 45]]),
});

// --- AI (docs/KARTS.md §3.5) ------------------------------------------------

/** Base top speed by skill index 0..4: 19.0 … 21.2 u/s. */
const AI_BASE = (skill) => 19.0 + 0.55 * skill;
/** Per-sector ceiling, indexed floor(q * 24), in u/s. Corners live here. */
export const AI_SECTORS = Object.freeze([
  22, 22, 22, 22, 18, 19, 20, 20, 19, 16, 12, 13,
  15, 14, 17, 16, 18, 20, 21, 21, 21, 19, 21, 22,
]);
/**
 * THE HARD LAW. An AI's effective speed can never leave this band, and an AI
 * "boost" can never exceed AI_BOOST_MAX for longer than AI_BOOST_MS. 21.8 is
 * below the player's V_MAX of 22.0 and 24.0 is far below the player's 32.0
 * drift-boost ceiling, so a perfectly driven player is never out-driven by the
 * rubber band. There is no catch-up that beats skill. test/kart.test.js proves
 * this against a human 500 units up the road.
 */
export const AI_SPEED_MIN = 16.0;
export const AI_SPEED_MAX = 21.8;
export const AI_BOOST_MAX = 24.0;
export const AI_BOOST_MS = 1000;
const AI_BAND_BEHIND = 0.12;
const AI_BAND_AHEAD = 0.10;
const AI_LAT_BIAS = 0.45;
const AI_BIAS_EVERY_U = 60;
const AI_LAT_LERP_PER_S = 0.6;
/** An AI never drops a peel that would land within this far ahead of a human. */
const AI_PEEL_CLEAR_U = 20;
/** An AI never fires a bubble at a kart further ahead than this. */
const AI_BUBBLE_REACH_U = 45;
/** Sectors capped below this are corners: AI sparks there are pure flavour. */
const AI_DRIFT_SECTOR = 17;

/** Cozy names. Never a character from another racing game. */
export const AI_NAMES = Object.freeze([
  'Nibbles', 'Pebble', 'Marzipan', 'Waffles', 'Juniper',
  'Tumble', 'Sprout', 'Biscuit', 'Clover', 'Poppy',
]);
const AI_HATS = Object.freeze(['none', 'beanie', 'cap', 'flower', 'chef']);

// --- payout table (docs/KARTS.md §4.8) --------------------------------------

/**
 * Placement money. The honest maximum is 110 + 6*3 + 12 + 12 = 152, which sits
 * under the orchestrator's `maxCoinsPerRun: 160`, so the cap can never truncate
 * an honest run. That is deliberate and is the owner's law in arithmetic form.
 */
export const PLACE_COINS = Object.freeze({ 1: 110, 2: 92, 3: 78, 4: 66, 5: 56, 6: 48 });

export function scoreFor({ place, laps, fastestLap, boxes }) {
  return 1000 * (7 - place) + 40 * laps + (fastestLap ? 200 : 0) + 10 * boxes;
}
export function coinsFor({ place, laps, fastestLap, boxes }) {
  const base = Object.prototype.hasOwnProperty.call(PLACE_COINS, place) ? PLACE_COINS[place] : 0;
  return base + 6 * laps + (fastestLap ? 12 : 0) + 2 * Math.min(boxes, 6);
}

/** Audit ops. Log-only, always: an audit line has never blocked a payout here. */
export const OPS = Object.freeze({
  WARP: 'kart.anomaly.warp',
  BOX: 'kart.anomaly.box',
});

// ---------------------------------------------------------------------------
// module state (install() resets it, which is also how a test starts clean)
// ---------------------------------------------------------------------------

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const norm1 = (q) => q - Math.floor(q);
/** Signed shortest distance from a to b around the lap, in [-0.5, 0.5). */
const dq = (a, b) => { const d = b - a; return d - Math.round(d); };
const wrapPi = (a) => { const t = (a + Math.PI) % (2 * Math.PI); return (t < 0 ? t + 2 * Math.PI : t) - Math.PI; };
const num = (v) => (Number.isFinite(v) ? v : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r3 = (v) => Math.round(v * 1e3) / 1e3;
const r2 = (v) => Math.round(v * 100) / 100;

const S = {
  installed: false,
  sendTo: () => {},
  broadcastToRoom: () => {},
  world: null,
  log: null,
  auditFn: null,
  now: () => Date.now(),
  rng: Math.random,
  timer: null,
  lobby: [],            // [{ p, at }] in sign-on order
  startsAt: null,       // wall clock the lobby fires at, or null
  pinned: false,        // a 'kart-start-now' pinned that time
  races: new Set(),
  seatOf: new WeakMap(),   // player -> { race, slot }
  payouts: new WeakMap(),  // player -> { coins, score, at, race }
  budget: new WeakMap(),   // player -> rate windows
  nextRace: 1,
  stats: null,
};

function blankStats() {
  return {
    joins: 0, joinsRefused: 0, races: 0, racesEnded: 0,
    frames: 0, framesRejected: 0, warps: 0,
    boxesTaken: 0, boxesRefused: 0, hits: 0,
    finishes: 0, ghosts: 0, resumes: 0,
    payoutsParked: 0, payoutsClaimed: 0, payoutsZeroed: 0,
  };
}
S.stats = blankStats();

/**
 * Boot. Every field is optional and degrades to a no-op rather than a throw,
 * so a partially wired server still boots and a test can supply only what it
 * asserts on.
 *
 *   sendTo(p, msg)                 one socket
 *   broadcastToRoom(room, msg)     the whole speedway, spectators included
 *   world                          { players: Map, rooms: Map } (read-only here)
 *   has(obj, key)                  own-property helper (index.js's own)
 *   log                            server/log.js, for the odd warn
 *   audit(event)                   server/audit.js log(), LOG-ONLY
 *   now()                          injectable clock (tests)
 *   rng()                          injectable [0,1) (tests)
 *   autoTick                       false stops the heartbeat; drive tick() by hand
 */
export function install(ctx = {}) {
  stopHeartbeat();
  S.installed = true;
  S.sendTo = typeof ctx.sendTo === 'function' ? ctx.sendTo : () => {};
  S.broadcastToRoom = typeof ctx.broadcastToRoom === 'function' ? ctx.broadcastToRoom : () => {};
  S.world = ctx.world && typeof ctx.world === 'object' ? ctx.world : null;
  S.log = ctx.log && typeof ctx.log === 'object' ? ctx.log : null;
  S.auditFn = typeof ctx.audit === 'function' ? ctx.audit : null;
  S.now = typeof ctx.now === 'function' ? ctx.now : () => Date.now();
  S.rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
  S.lobby = [];
  S.startsAt = null;
  S.pinned = false;
  S.races = new Set();
  S.seatOf = new WeakMap();
  S.payouts = new WeakMap();
  S.budget = new WeakMap();
  S.stats = blankStats();
  if (ctx.autoTick !== false) startHeartbeat();
  return S;
}

function startHeartbeat() {
  if (S.timer) return;
  S.timer = setInterval(() => {
    try { tick(); } catch (e) { warn('kart.tick failed', e); }
  }, TICK_MS);
  // the cove's lifetime is the http server's, never this interval's
  S.timer.unref?.();
}

/** Exported for tests and for a clean shutdown; never called by index.js. */
export function stopHeartbeat() {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
}

function warn(msg, e) {
  try { S.log?.warn?.('kart.error', { msg, err: e?.message || String(e || '') }); } catch { /* never */ }
  if (!S.log) console.error(`[kart] ${msg}:`, e?.message || e);
}

/** LOG-ONLY, and it can never throw into a race. */
function audit(op, p, args) {
  if (!S.auditFn) return;
  try {
    S.auditFn({ actor: { id: p?.id || null, name: p?.name || null }, via: 'system', op, ok: false, target: null, args });
  } catch { /* the audit trail never blocks the race it describes */ }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** One identity per account across tabs; a guest is only ever its socket. */
function keyOf(p) {
  if (!p) return null;
  if (p.username) return `u:${String(p.username).toLowerCase()}`;
  return p.id ? `g:${p.id}` : null;
}

function budgetOf(p) {
  let b = S.budget.get(p);
  if (!b) { b = { sAt: 0, sN: 0, iAt: 0, iN: 0 }; S.budget.set(p, b); }
  return b;
}

function socialLimited(p, now) {
  const b = budgetOf(p);
  if (now - b.sAt > 1000) { b.sAt = now; b.sN = 0; }
  return ++b.sN > KART_SOCIAL_LIMIT;
}

function inLimited(p, now) {
  const b = budgetOf(p);
  if (now - b.iAt > 1000) { b.iAt = now; b.iN = 0; }
  return ++b.iN > KART_IN_LIMIT;
}

/**
 * The hot path reuses ONE serialised string for the whole race, the way
 * index.js's own broadcastRaceState does. A player object without a live
 * socket (every test, and a ghost) falls back to sendTo.
 */
function blast(race, msg) {
  let raw = null;
  for (const r of race.slots) {
    const p = r.p;
    if (!p || r.ghost) continue;
    if (p.ws?.readyState === 1) {
      if (raw === null) raw = JSON.stringify(msg);
      try { p.ws.send(raw); } catch { /* a dead socket is not our problem */ }
    } else {
      try { S.sendTo(p, msg); } catch { /* ditto */ }
    }
  }
}

function toRoom(msg) {
  try { S.broadcastToRoom(ROOM, msg); } catch (e) { warn('room broadcast failed', e); }
}

// ---------------------------------------------------------------------------
// the lobby (docs/KARTS.md §4.1)
// ---------------------------------------------------------------------------

/** In the lobby list, and still standing in the paddock with a live seat-free capy. */
function lobbyIndex(p) {
  return S.lobby.findIndex((e) => e.p === p);
}

export function lobbyPayload(now = S.now()) {
  const players = S.lobby.map(({ p }) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat }));
  const startsAt = S.startsAt;
  return {
    t: 'kart-lobby',
    players,
    // 'starting' is the imminent countdown, not the 20 s fill window: K1 lights
    // the sign-on post up only when the lights are actually about to come on.
    starting: startsAt !== null && startsAt - now <= START_SOON_MS + 250,
    startsAt: startsAt === null ? null : startsAt,
    max: MAX_RACERS,
  };
}

function broadcastLobby() {
  toRoom(lobbyPayload());
}

/** Recompute the fire time after any lobby change. A pin survives a new signer. */
function rearm(now) {
  if (!S.lobby.length) { S.startsAt = null; S.pinned = false; return; }
  if (S.pinned && S.startsAt !== null && S.startsAt > now - 50) return;
  S.pinned = false;
  S.startsAt = S.lobby.length >= MAX_RACERS
    ? Math.min(now + START_SOON_MS, S.startsAt ?? Infinity)
    : S.lobby[0].at + KART_WAIT_MS;
}

function joinLobby(p, now) {
  // Refused unless you are standing in the paddock, and never twice.
  if (!p || p.room !== ROOM) { S.stats.joinsRefused++; return false; }
  if (S.seatOf.has(p)) { S.stats.joinsRefused++; return false; }   // already racing
  if (lobbyIndex(p) >= 0) { S.stats.joinsRefused++; return false; }
  if (S.lobby.length >= MAX_RACERS) { S.stats.joinsRefused++; return false; }
  S.lobby.push({ p, at: now });
  S.stats.joins++;
  rearm(now);
  broadcastLobby();
  return true;
}

function leaveLobby(p, now = S.now()) {
  const i = lobbyIndex(p);
  if (i < 0) return false;
  S.lobby.splice(i, 1);
  rearm(now);
  broadcastLobby();
  return true;
}

/** Any signed-on capy may pull the 3 s pre-start in. */
function startNow(p, now) {
  if (lobbyIndex(p) < 0 || !S.lobby.length) return false;
  const at = now + START_SOON_MS;
  if (S.startsAt !== null && S.startsAt <= at) return false; // already sooner
  S.startsAt = at;
  S.pinned = true;
  broadcastLobby();
  return true;
}

/** Drop entries whose capy wandered off; the board must never list a ghost. */
function pruneLobby(now) {
  let changed = false;
  for (let i = S.lobby.length - 1; i >= 0; i--) {
    const p = S.lobby[i].p;
    const gone = !p || p.room !== ROOM || S.seatOf.has(p)
      || (S.world && p.id && !S.world.players.has(p.id));
    if (gone) { S.lobby.splice(i, 1); changed = true; }
  }
  if (changed) { rearm(now); broadcastLobby(); }
}

// ---------------------------------------------------------------------------
// the grid (docs/KARTS.md §4.2)
// ---------------------------------------------------------------------------

function pick(list) { return list[Math.floor(S.rng() * list.length) % list.length]; }

/** Skills spread across 0..4 for `n` AI, then handed out highest first. */
function aiSkills(n) {
  if (n <= 0) return [];
  if (n === 1) return [2];
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(4 * (i / (n - 1))));
  return out.sort((a, b) => b - a);
}

function aiRoster(n, taken) {
  const pool = AI_NAMES.filter((nm) => !taken.has(nm.toLowerCase()));
  // shuffle a copy (never the frozen source)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(S.rng() * (i + 1)) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const skills = aiSkills(n);
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      name: pool[i] || `Capy ${i + 1}`,
      skill: skills[i],
      color: pick(BODY_COLORS),
      hat: pick(AI_HATS),
    });
  }
  return rows;
}

/** Grid slot -> starting lap coordinate. Slot 0 is pole. */
function gridSpot(slot) {
  const row = Math.floor(slot / 2);
  const u = LAP_UNITS - (6 + 7 * row);
  return { q: norm1(u / LAP_UNITS), lat: slot % 2 === 0 ? -0.47 : 0.47 };
}

function newRacer(slot, src) {
  const spot = gridSpot(slot);
  return {
    slot,
    p: src.p || null,
    id: src.p ? src.p.id : null,
    key: src.p ? keyOf(src.p) : null,
    name: src.name,
    color: src.color,
    hat: src.hat,
    ai: !!src.ai,
    skill: src.ai ? src.skill : null,
    ghost: false,
    dropAt: 0,
    // lap state
    q: spot.q,
    lat: spot.lat,
    yaw: 0,
    v: 0,
    d: 0,
    lap: 0,
    // Every forward crossing of the line, VALID OR NOT. Laps are the validated
    // count and decide the result; wraps are the monotonic ruler the live
    // order, the AI band and the roulette read, because the grid starts BEHIND
    // the line (q ~= 0.989) and `lap + q` would rank pole last for one corner.
    wraps: 0,
    cps: 0,
    lapStart: 0,
    bestLap: null,
    // race outcome
    place: 0,
    finMs: 0,
    done: false,
    boxes: 0,
    // items and effects
    item: null,
    itemAt: 0,
    fx: null,
    fxUntil: 0,
    slowUntil: 0,
    spinUntil: 0,
    immuneUntil: 0,
    // wire hygiene
    lastAt: 0,
    warned: false,
    // AI only
    bias: 0,
    biasAt: 0,
    boostUntil: 0,
    livePlace: slot + 1,
  };
}

function startRace(now) {
  // Only capys still standing in the paddock ride. Everyone else quietly
  // stops being on the sheet, exactly like a sled rider who walked away.
  const members = S.lobby.map((e) => e.p).filter((p) => p && p.room === ROOM && !S.seatOf.has(p));
  S.lobby = [];
  S.startsAt = null;
  S.pinned = false;
  if (!members.length) { broadcastLobby(); return null; }

  const humans = members.slice(0, MAX_RACERS);
  const taken = new Set(humans.map((p) => String(p.name || '').toLowerCase()));
  const ai = aiRoster(MAX_RACERS - humans.length, taken);

  const race = {
    id: `k${S.nextRace++}`,
    createdAt: now,
    startAt: now + GRID_LEAD_MS + KART_LIGHTS_MS,
    goSentAt: 0,
    started: false,
    ended: false,
    laps: LAPS,
    slots: [],
    tickN: 0,
    lastTick: 0,
    boardAt: 0,
    finished: 0,
    firstFinAt: 0,
    deadline: 0,
    nextObj: 1,
    haz: new Map(),   // peels
    proj: new Map(),  // bubbles in flight
    boxes: BOXES.map((b, i) => ({ i, q: b.q, lat: b.lat, live: true, respawnAt: 0 })),
    bestLap: null,    // fastest lap of the whole race, ms
    bestLapSlot: -1,
    gridBase: null,
  };

  let slot = 0;
  for (const p of humans) race.slots.push(newRacer(slot++, { p, name: p.name, color: p.color, hat: p.hat }));
  for (const row of ai) race.slots.push(newRacer(slot++, { ai: true, ...row }));
  for (const r of race.slots) { r.lapStart = race.startAt; r.lastAt = race.startAt; }
  for (const r of race.slots) if (r.p) S.seatOf.set(r.p, { race, slot: r.slot });

  race.gridBase = {
    t: 'kart-grid',
    race: race.id,
    track: TRACK_ID,
    laps: LAPS,
    slots: race.slots.map((r) => ({
      slot: r.slot, id: r.id, ai: r.ai, name: r.name, color: r.color, hat: r.hat, skill: r.skill,
    })),
  };

  S.races.add(race);
  S.stats.races++;
  sendGrid(race, now);
  broadcastLobby();     // the sheet is blank again for everyone still in the room
  sendBoard(race, now);
  return race;
}

function gridFor(race, r, now) {
  return { ...race.gridBase, sentAt: now, you: { slot: r.slot } };
}

function sendGrid(race, now) {
  for (const r of race.slots) {
    if (!r.p || r.ghost) continue;
    try { S.sendTo(r.p, gridFor(race, r, now)); } catch { /* dead socket */ }
  }
}

function sendGo(race, now) {
  race.goSentAt = now;
  race.startAt = now + KART_LIGHTS_MS;
  for (const r of race.slots) { r.lapStart = race.startAt; r.lastAt = race.startAt; }
  race.deadline = race.startAt + RACE_MAX_MS;
  blast(race, { t: 'kart-go', race: race.id, startAt: race.startAt, now });
}

// ---------------------------------------------------------------------------
// lap validation (docs/KARTS.md §4.4) — the anti-cut rule
// ---------------------------------------------------------------------------

/**
 * Move a racer forward by `delta` (already clamped) and account for every
 * checkpoint and lap line it crosses on the way. `delta` is bounded by
 * KART_MAX_Q_PER_S * 1.5 s = 0.1125, comfortably under 1/6, so a single step
 * can never skip a checkpoint or wrap twice: that bound is what makes this
 * simple version correct.
 */
function advance(race, r, delta, now) {
  if (!(delta > 0)) { if (delta < 0) r.q = norm1(r.q + delta); return; }
  const prev = r.q;
  let q = prev + delta;
  const wrapped = q >= 1;
  if (wrapped) q -= 1;

  if (wrapped) {
    r.wraps++;
    // The finish line. A lap counts ONLY with every checkpoint behind it: a
    // capy who cut the infield arrives here with bits missing and gets nothing
    // but a fresh set of bits to go and collect properly.
    if (r.cps === ALL_CPS) lapDone(race, r, now);
    r.cps = 1; // checkpoint 0 IS the finish line, and it was just crossed
  }
  r.q = q;
  for (let k = wrapped ? 1 : 0; k < CHECKPOINTS; k++) {
    const at = k / CHECKPOINTS;
    if (wrapped ? at > 0 && at <= q : at > prev && at <= q) r.cps |= (1 << k);
  }
}

function lapDone(race, r, now) {
  r.lap++;
  const lapMs = Math.max(0, now - r.lapStart);
  r.lapStart = now;
  const personal = r.bestLap === null || lapMs < r.bestLap;
  if (personal) r.bestLap = lapMs;
  if (race.bestLap === null || lapMs < race.bestLap) { race.bestLap = lapMs; race.bestLapSlot = r.slot; }
  blast(race, { t: 'kart-lap', s: r.slot, lap: r.lap, ms: Math.max(0, now - race.startAt), best: personal });
  if (r.lap >= race.laps) finishRacer(race, r, now);
}

/**
 * Placement is assigned HERE, by the server clock, in the order the third lap
 * validates. Tick order breaks a same-millisecond tie, so two karts can never
 * share a place and a client can never argue about one.
 */
function finishRacer(race, r, now) {
  if (r.done) return;
  r.done = true;
  r.place = ++race.finished;
  r.finMs = Math.max(0, now - race.startAt);
  r.item = null;
  S.stats.finishes++;
  blast(race, { t: 'kart-fin', s: r.slot, place: r.place, ms: r.finMs });
  if (race.finished === 1) race.firstFinAt = now;
  if (race.slots.every((x) => x.done)) endRace(race, now);
}

// ---------------------------------------------------------------------------
// the 10 Hz relay in (docs/KARTS.md §4.4)
// ---------------------------------------------------------------------------

function onInput(p, m, now) {
  const seat = S.seatOf.get(p);
  if (!seat) return;
  const race = seat.race;
  if (!race || race.ended) return;
  const r = race.slots[seat.slot];
  if (!r || r.done || r.ghost) return;
  // Controls are dead until the lights go out. A frame sent during the
  // countdown is not an anomaly (an eager client streams from the grid), it
  // simply moves nothing.
  if (now < race.startAt) return;
  if (inLimited(p, now)) { S.stats.framesRejected++; return; }

  const q = num(Number(m.q));
  const lat = num(Number(m.lat));
  const yaw = num(Number(m.yaw));
  if (q === null || lat === null || yaw === null) { S.stats.framesRejected++; return; }
  S.stats.frames++;

  const dtMs = clamp(now - r.lastAt, 0, MAX_FRAME_DT_MS);
  r.lastAt = now;
  const dt = dtMs / 1000;

  // Forward progress is the only thing worth cheating, so it is the only thing
  // clamped hard. Clamped, never dropped (see the header).
  let delta = dq(r.q, norm1(q));
  const maxFwd = KART_MAX_Q_PER_S * dt;
  if (delta > maxFwd) {
    if (!r.warned) {
      r.warned = true;
      S.stats.warps++;
      audit(OPS.WARP, p, { race: race.id, slot: r.slot, dq: r5(delta), allowed: r5(maxFwd), dtMs });
    }
    delta = maxFwd;
  } else if (delta < -KART_MAX_BACK_Q) {
    delta = 0; // a rewind past the slack is noise, not a manoeuvre
  }

  advance(race, r, delta, now);
  r.lat = clamp(lat, -1.9, 1.9);
  r.yaw = wrapPi(yaw);
  r.v = clamp(Number(m.v) || 0, 0, 40);
  const d = Math.floor(Number(m.d) || 0);
  r.d = d >= 0 && d <= 3 ? d : 0;
}

// ---------------------------------------------------------------------------
// items (docs/KARTS.md §4.5)
// ---------------------------------------------------------------------------

function oddsFor(place) {
  if (place <= 2) return ITEM_ODDS.front;
  if (place <= 4) return ITEM_ODDS.mid;
  return ITEM_ODDS.back;
}

function roulette(place) {
  const table = oddsFor(place);
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = S.rng() * total;
  for (const [item, w] of table) { roll -= w; if (roll < 0) return item; }
  return table[table.length - 1][0];
}

/**
 * The one gate on a pickup. A refusal NEVER consumes the box: driving through
 * while already holding something has to leave it there for the next capy, and
 * a client that guesses wrong must not be able to delete a box for the field.
 */
function claimBox(race, r, boxIdx, now) {
  if (!Number.isInteger(boxIdx) || boxIdx < 0 || boxIdx >= race.boxes.length) return null;
  const box = race.boxes[boxIdx];
  if (!box.live) return null;
  if (r.item) return null;
  if (r.done || r.ghost) return null;
  // asymmetric on purpose: see BOX_Q_STALE. dq(r.q, box.q) is how far AHEAD
  // of the last relayed position the box sits; a claim from a kart that just
  // drove through it lands with the relay lagging BEHIND the box.
  {
    // A stale relay LAGS the kart, so at claim time the box sits AHEAD of the
    // last relayed q (positive dq) by up to the staleness budget; a fresh
    // relay may sit just past it (small negative dq).
    const ahead = dq(r.q, box.q);
    if (ahead > BOX_Q_TOL + BOX_Q_STALE || ahead < -BOX_Q_TOL) return null;
  }
  if (Math.abs(r.lat - box.lat) > BOX_LAT_TOL) return null;

  box.live = false;
  box.respawnAt = now + BOX_RESPAWN_MS;
  r.item = roulette(r.livePlace);
  r.itemAt = now;
  r.boxes++;
  S.stats.boxesTaken++;
  if (r.p && !r.ghost) {
    try { S.sendTo(r.p, { t: 'kart-item', item: r.item, box: box.i, at: now }); } catch { /* dead socket */ }
  }
  blast(race, { t: 'kart-box', box: box.i, taken: true, by: r.slot, respawnAt: box.respawnAt });
  return r.item;
}

function dropPeel(race, r, now) {
  const i = race.nextObj++;
  const q = norm1(r.q - PEEL_BEHIND_U / LAP_UNITS);
  const haz = { i, kind: 'peel', q, lat: r.lat, by: r.slot, until: now + PEEL_TTL_MS };
  race.haz.set(i, haz);
  r.immuneUntil = now + PEEL_SELF_IMMUNE_MS;
  blast(race, { t: 'kart-haz', i, kind: 'peel', q: r5(q), lat: r3(haz.lat), by: r.slot, ttl: PEEL_TTL_MS });
}

function fireBubble(race, r, now) {
  const i = race.nextObj++;
  race.proj.set(i, { i, kind: 'bubble', q: r.q, lat: r.lat, by: r.slot, until: now + BUBBLE_TTL_MS });
}

function useItem(race, r, now) {
  if (!r.item || r.done || r.ghost) return null;
  const item = r.item;
  r.item = null;
  if (item === 'peel') dropPeel(race, r, now);
  else if (item === 'bubble') fireBubble(race, r, now);
  else if (item === 'berry') {
    r.fx = 'boost';
    r.fxUntil = now + BERRY_MS;
    if (r.ai) r.boostUntil = now + Math.min(AI_BOOST_MS, BERRY_MS);
    blast(race, { t: 'kart-fx', s: r.slot, kind: 'boost', ms: BERRY_MS });
  }
  return item;
}

function killObject(race, i) {
  race.haz.delete(i);
  race.proj.delete(i);
  blast(race, { t: 'kart-haz', i, gone: true });
}

function declareHit(race, r, kind, by, ms, i, now) {
  S.stats.hits++;
  if (kind === 'peel') { r.spinUntil = now + ms; r.d = 0; }
  else r.slowUntil = now + ms;
  r.fx = null;
  r.fxUntil = 0;
  if (r.ai) r.boostUntil = 0;
  blast(race, { t: 'kart-hit', s: r.slot, kind, by, ms, i });
}

/**
 * Hazards are one-shot and arbitrated here, off the 10 Hz stream, so a
 * mispredicted client-side splash never steals a real player's speed: the
 * client may paint the water, but only this frame takes the momentum.
 */
function arbitrate(race, now, dt) {
  // peels: static, hit on proximity
  for (const haz of [...race.haz.values()]) {
    if (now >= haz.until) { killObject(race, haz.i); continue; }
    for (const r of race.slots) {
      if (r.done || r.slot === undefined) continue;
      if (r.slot === haz.by && now < r.immuneUntil) continue;
      if (now < r.spinUntil) continue;
      if (Math.abs(dq(r.q, haz.q)) > PEEL_HIT_Q) continue;
      if (Math.abs(r.lat - haz.lat) > PEEL_HIT_LAT) continue;
      declareHit(race, r, 'peel', haz.by, PEEL_SPIN_MS, haz.i, now);
      killObject(race, haz.i);
      break; // one-shot: the peel is gone, nobody else can hit it this tick
    }
  }

  // bubbles: advance, home gently, hit whatever they pass through
  for (const pr of [...race.proj.values()]) {
    if (now >= pr.until) { killObject(race, pr.i); continue; }
    const from = pr.q;
    pr.q = norm1(pr.q + (BUBBLE_SPEED_U / LAP_UNITS) * dt);

    // mild homing toward the nearest kart ahead, within 60u
    let target = null;
    let bestGap = Infinity;
    for (const r of race.slots) {
      if (r.slot === pr.by || r.done) continue;
      const gap = dq(pr.q, r.q) * LAP_UNITS;
      if (gap > 0 && gap < BUBBLE_SEEK_U && gap < bestGap) { bestGap = gap; target = r; }
    }
    if (target) {
      const step = BUBBLE_HOMING_LAT_PER_S * dt;
      pr.lat += clamp(target.lat - pr.lat, -step, step);
    }

    let hit = false;
    const swept = dq(from, pr.q); // how far the bubble travelled this tick
    for (const r of race.slots) {
      if (r.slot === pr.by || r.done) continue;
      if (now < r.slowUntil) continue;
      // "as it passes": the racer sits inside the arc the bubble just swept,
      // or close enough to it that a 10 Hz sample would otherwise skip them
      const at = dq(from, r.q);
      if (!(at >= 0 && at <= swept) && Math.abs(dq(pr.q, r.q)) > PEEL_HIT_Q) continue;
      if (Math.abs(r.lat - pr.lat) > BUBBLE_HIT_LAT) continue;
      declareHit(race, r, 'bubble', pr.by, BUBBLE_SLOW_MS, pr.i, now);
      hit = true;
      break;
    }
    if (hit) killObject(race, pr.i);
  }

  // boxes come back
  for (const box of race.boxes) {
    if (!box.live && now >= box.respawnAt) {
      box.live = true;
      blast(race, { t: 'kart-box', box: box.i, taken: false });
    }
  }
}

// ---------------------------------------------------------------------------
// the AI (docs/KARTS.md §3.5) — server-simulated, coarsely, and never faster
// than a player driving well
// ---------------------------------------------------------------------------

/**
 * Track distance covered, in units, measured off the monotonic wrap counter so
 * it never goes backwards at the start line. The grid sits BEHIND the line, so
 * a kart on pole starts at a small NEGATIVE distance and crosses zero at go.
 */
function distOf(r) { return (r.wraps - 1 + r.q) * LAP_UNITS; }

/** The OFFICIAL standing of an unfinished kart: validated laps, then progress. */
function officialOf(r) { return r.lap + r.q; }

/** The leading human, or the leading kart once every human has dropped. */
function pacemaker(race) {
  let best = null;
  for (const r of race.slots) {
    if (r.ai || r.ghost) continue;
    if (!best || distOf(r) > distOf(best)) best = r;
  }
  if (best) return best;
  for (const r of race.slots) if (!best || distOf(r) > distOf(best)) best = r;
  return best;
}

/**
 * THE HARD LAW lives in this function. Read the clamps before changing a
 * number: everything above them is flavour, and everything below them is a
 * promise to the player that no amount of rubber band out-drives good driving.
 */
export function aiSpeed(skill, q, gapUnits, boosting = false) {
  const base = AI_BASE(clamp(skill | 0, 0, 4));
  const sector = AI_SECTORS[clamp(Math.floor(norm1(q) * AI_SECTORS.length), 0, AI_SECTORS.length - 1)];
  let v = Math.min(base, sector);
  // gapUnits > 0: the pacemaker is AHEAD of this AI, so it may lean on it a bit
  const mult = gapUnits >= 0
    ? 1 + Math.min(AI_BAND_BEHIND, gapUnits / 700)
    : 1 - Math.min(AI_BAND_AHEAD, -gapUnits / 900);
  v = clamp(v * mult, AI_SPEED_MIN, AI_SPEED_MAX);
  if (boosting) v = Math.min(AI_BOOST_MAX, v + 2.2);
  return v;
}

function stepAI(race, r, now, dt) {
  if (r.done) return;
  const lead = pacemaker(race);
  const gap = lead && lead !== r ? distOf(lead) - distOf(r) : 0;
  if (r.boostUntil && now >= r.boostUntil) r.boostUntil = 0;
  let v = aiSpeed(r.skill ?? 2, r.q, gap, r.boostUntil > now);
  // The penalties are applied AFTER the band clamp on purpose: a spin has to be
  // able to take an AI below AI_SPEED_MIN, or a hit would be cosmetic for them
  // and real for the player, which is the one asymmetry this game must not have.
  if (now < r.spinUntil) v *= 0.35;
  else if (now < r.slowUntil) v *= 0.5;
  r.v = v;

  advance(race, r, (v * dt) / LAP_UNITS, now);

  // lateral drift toward a re-rolled racing-line bias
  if (!r.biasAt || distOf(r) - r.biasAt >= AI_BIAS_EVERY_U) {
    r.biasAt = distOf(r);
    r.bias = (S.rng() * 2 - 1) * AI_LAT_BIAS;
  }
  const lerp = Math.min(1, AI_LAT_LERP_PER_S * dt);
  r.lat += (r.bias - r.lat) * lerp;
  r.yaw = wrapPi((r.bias - r.lat) * 0.6 + (now < r.spinUntil ? Math.PI : 0));

  // drift sparks on the tight sectors: pure flavour, no boost (contract §3.5)
  const sector = AI_SECTORS[clamp(Math.floor(r.q * AI_SECTORS.length), 0, AI_SECTORS.length - 1)];
  r.d = sector < AI_DRIFT_SECTOR && now >= r.spinUntil ? 1 + (r.slot % 2) : 0;

  // boxes, and then the item, played with manners
  if (!r.item) {
    for (const box of race.boxes) {
      if (!box.live) continue;
      if (Math.abs(dq(r.q, box.q)) > BOX_Q_TOL * 1.5) continue;
      if (Math.abs(r.lat - box.lat) > BOX_LAT_TOL) continue;
      claimBox(race, r, box.i, now);
      break;
    }
  } else if (now - r.itemAt > 900 && now >= r.spinUntil) {
    if (aiMayUse(race, r)) useItem(race, r, now);
  }
}

/** The manners: an AI never ambushes a human it cannot see, or shoots the moon. */
function aiMayUse(race, r) {
  if (r.item === 'berry') return true;
  const mine = distOf(r);
  if (r.item === 'peel') {
    // the peel lands PEEL_BEHIND_U behind; refuse if that drops it right on
    // top of a human who is following closely
    for (const o of race.slots) {
      if (o.ai || o.done) continue;
      const behind = mine - distOf(o);
      if (behind >= 0 && behind <= AI_PEEL_CLEAR_U) return false;
    }
    return true;
  }
  if (r.item === 'bubble') {
    for (const o of race.slots) {
      if (o.slot === r.slot || o.done) continue;
      const ahead = distOf(o) - mine;
      if (ahead > 0 && ahead <= AI_BUBBLE_REACH_U) return true;
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// standings, state frames and the jumbotron
// ---------------------------------------------------------------------------

/**
 * Live order: finishers by their assigned place, then everyone by VALIDATED
 * progress (checkpoint-sequenced laps + current-lap q). Raw wrap counts are
 * deliberately not consulted: a kart oscillating across the line inflates its
 * wraps with legal-looking frames, and standings fed by wraps handed it P1 on
 * the jumbotron. distOf stays for AI pacing only, where the worst a forged
 * lead can do is make the field try slightly harder inside its hard speed cap.
 */
function standings(race) {
  const done = race.slots.filter((r) => r.done).sort((a, b) => a.place - b.place);
  const live = race.slots.filter((r) => !r.done)
    .sort((a, b) => (officialOf(b) - officialOf(a)) || (distOf(b) - distOf(a)));
  const order = [...done, ...live];
  order.forEach((r, i) => { r.livePlace = i + 1; });
  return order;
}

function sendState(race, now) {
  race.tickN++;
  const msg = {
    t: 'kart-state',
    tick: race.tickN,
    k: race.slots.map((r) => ({
      s: r.slot,
      q: r5(r.q),
      lat: r3(r.lat),
      yaw: r3(r.yaw),
      v: r2(r.v),
      d: r.d,
      l: r.lap,
      it: r.item,
      fx: r.fxUntil > now ? r.fx : null,
      ghost: !!r.ghost,
    })),
    pr: [...race.proj.values()].map((x) => ({ i: x.i, q: r5(x.q), lat: r3(x.lat), by: x.by })),
    // NOTE (reported as a concern): the contract asks for peels filtered to
    // dq <= 0.25 AHEAD of the recipient, which cannot share one pre-serialised
    // frame. With at most six peels alive the whole list costs a few dozen
    // bytes, so every racer gets every live peel and the client draws what it
    // can see. Nothing downstream depends on the filtering.
    hz: [...race.haz.values()].map((x) => ({ i: x.i, q: r5(x.q), lat: r3(x.lat), by: x.by })),
  };
  blast(race, msg);
}

function sendBoard(race, now, over = false) {
  race.boardAt = now;
  const order = standings(race);
  toRoom({
    t: 'kart-board',
    race: race.id,
    laps: race.laps,
    over,
    rows: order.map((r) => ({ s: r.slot, n: r.name, lap: r.lap, q: r5(r.q), ai: !!r.ai, place: r.livePlace })),
  });
}

// ---------------------------------------------------------------------------
// finishing, abandoning and the payout the coin road will be handed
// ---------------------------------------------------------------------------

function endRace(race, now) {
  if (race.ended) return;
  race.ended = true;

  // Unfinished karts are placed after every finisher, by validated laps + q.
  const dnf = race.slots.filter((r) => !r.done).sort((a, b) => officialOf(b) - officialOf(a));
  let place = race.finished;
  for (const r of dnf) { r.place = ++place; r.finMs = Math.max(0, now - race.startAt); }

  const results = race.slots
    .slice()
    .sort((a, b) => a.place - b.place)
    .map((r) => ({
      s: r.slot, id: r.id, name: r.name, ai: !!r.ai,
      place: r.place, ms: r.finMs, laps: r.lap, best: r.bestLap,
    }));

  blast(race, { t: 'kart-end', race: race.id, results });
  sendBoard(race, now, true);

  // Park the authoritative placement for every human who actually finished. A
  // ghost — and a human still circling when the grace ran out — parks a ZERO
  // rather than nothing at all: the frame they send is then rewritten to zero
  // coins instead of falling through as an unarbitrated practice lap. That is
  // the contract's "a ghost is never paid", made unforgeable.
  // The guard is `!r.p`, never `r.ai`: a ghost has ai:true and is still a person.
  for (const r of race.slots) {
    if (!r.p) continue;
    const fastest = race.bestLapSlot === r.slot;
    const paid = !r.ghost && r.done;
    const shape = { place: r.place, laps: r.lap, fastestLap: fastest, boxes: r.boxes };
    S.payouts.set(r.p, {
      race: race.id,
      at: now,
      coins: paid ? coinsFor(shape) : 0,
      score: paid ? scoreFor(shape) : 0,
    });
    if (paid) S.stats.payoutsParked++; else S.stats.payoutsZeroed++;
  }
  for (const r of race.slots) if (r.p) S.seatOf.delete(r.p);

  S.races.delete(race);
  S.stats.racesEnded++;
}

/**
 * A capy stops driving: disconnect, 'kart-leave' mid-race, or walking out of
 * the paddock. The row flips to a ghost that keeps their name and colours and
 * drives on at skill 2 so the standings still mean something — and a ghost is
 * never paid, so nobody profits by disconnecting on the last corner.
 */
function ghostRacer(race, r, now) {
  if (r.ghost || r.done) return;
  r.ghost = true;
  r.ai = true;
  r.skill = 2;
  r.dropAt = now;
  r.item = null;
  S.stats.ghosts++;
  if (r.p) S.seatOf.delete(r.p);
  // A race with ZERO live humans is nobody's race: end it now, pay nothing. A
  // human who has already taken the flag still counts as live — they earned the
  // right to watch the rest of the field come in.
  if (!race.slots.some((x) => x.p && !x.ghost && !x.ai)) endRace(race, now);
}

/** Same account, same live race, inside 45 s: take the wheel back. */
function tryResume(p, now) {
  const key = keyOf(p);
  if (!key || S.seatOf.has(p)) return false;
  for (const race of S.races) {
    if (race.ended) continue;
    for (const r of race.slots) {
      if (!r.ghost || r.done || r.key !== key) continue;
      if (now - r.dropAt > KART_REJOIN_MS) continue;
      r.ghost = false;
      r.ai = false;
      r.skill = null;
      r.p = p;
      r.id = p.id;
      r.lastAt = now;
      S.seatOf.set(p, { race, slot: r.slot });
      S.stats.resumes++;
      try {
        S.sendTo(p, {
          t: 'kart-resume',
          race: race.id,
          grid: gridFor(race, r, now),
          startAt: race.startAt,
          you: { slot: r.slot },
          lap: r.lap,
          q: r5(r.q),
          laps: race.laps,
        });
      } catch { /* dead socket */ }
      return true;
    }
  }
  return false;
}

/** Give up a sign-on and/or a run in progress. */
function partPlayer(p, now = S.now()) {
  leaveLobby(p, now);
  const seat = S.seatOf.get(p);
  if (!seat) return;
  const race = seat.race;
  const r = race?.slots?.[seat.slot];
  S.seatOf.delete(p);
  if (race && r && !race.ended) ghostRacer(race, r, now);
}

// ---------------------------------------------------------------------------
// the heartbeat
// ---------------------------------------------------------------------------

/**
 * The single clock this module owns. Exported so a test can drive the whole
 * lifecycle deterministically with `install({ now, autoTick: false })`.
 */
export function tick(now = S.now()) {
  if (!S.installed) return;
  pruneLobby(now);
  if (S.startsAt !== null && now >= S.startsAt) {
    try { startRace(now); } catch (e) { warn('race start failed', e); S.startsAt = null; }
  }
  for (const race of [...S.races]) {
    try { stepRace(race, now); } catch (e) { warn('race step failed', e); }
  }
}

function stepRace(race, now) {
  if (race.ended) return;

  if (!race.started) {
    if (!race.goSentAt && now >= race.createdAt + GRID_LEAD_MS) sendGo(race, now);
    if (race.goSentAt && now >= race.startAt) { race.started = true; race.lastTick = race.startAt; }
    if (now - race.boardAt >= BOARD_MS) sendBoard(race, now);
    return;
  }

  const dt = clamp((now - (race.lastTick || now)) / 1000, 0, MAX_FRAME_DT_MS / 1000);
  race.lastTick = now;

  // Order matters: places first (the roulette an AI spins mid-step reads its
  // CURRENT place), then the AI, then hits, then the frame.
  standings(race);
  for (const r of race.slots) {
    if (race.ended) return; // an AI took the flag and ended the race under us
    if (r.fxUntil && now >= r.fxUntil) { r.fx = null; r.fxUntil = 0; }
    if (r.ai) stepAI(race, r, now, dt);
  }
  if (race.ended) return;
  arbitrate(race, now, dt);
  standings(race);
  sendState(race, now);
  if (now - race.boardAt >= BOARD_MS) sendBoard(race, now);

  if (race.firstFinAt && now - race.firstFinAt >= FINISH_GRACE_MS) endRace(race, now);
  else if (race.deadline && now >= race.deadline) endRace(race, now);
}

// ---------------------------------------------------------------------------
// the wire (server/index.js routes here and learns nothing)
// ---------------------------------------------------------------------------

/**
 * First refusal on every `kart-*` frame; everything else falls through.
 *
 * Returns TRUE only for `kart-*`, so the main switch never sees one and an
 * unknown `kart-something` from a scripted client dies here instead of
 * wandering into a case it was never meant to reach.
 *
 * Returns FALSE — while still OBSERVING — for exactly two frames:
 *   'join'   walking out of the paddock gives up your sign-on and your seat
 *   'score'  for game 'kart', rewritten to the placement this file assigned
 */
export function handleMessage(p, m) {
  if (!p || !m || typeof m.t !== 'string') return false;
  const now = S.now();
  try {
    if (m.t === 'join') { observeJoin(p, m, now); return false; }
    if (m.t === 'score') { observeScore(p, m, now); return false; }
    if (!m.t.startsWith('kart-')) return false;

    switch (m.t) {
      case 'kart-join':
        if (socialLimited(p, now)) break;
        // a returning racer takes their own kart back before signing a new
        // sheet — but only from the paddock, same as any other sign-on
        if (p.room === ROOM && tryResume(p, now)) break;
        joinLobby(p, now);
        break;
      case 'kart-leave':
        if (socialLimited(p, now)) break;
        partPlayer(p, now);
        break;
      case 'kart-start-now':
        if (socialLimited(p, now)) break;
        startNow(p, now);
        break;
      case 'kart-in':
        onInput(p, m, now);
        break;
      case 'kart-box': {
        const seat = S.seatOf.get(p);
        const race = seat?.race;
        const r = race?.slots?.[seat.slot];
        if (!race || race.ended || !r) break;
        if (!claimBox(race, r, Math.floor(Number(m.box)), now)) S.stats.boxesRefused++;
        break;
      }
      case 'kart-use': {
        const seat = S.seatOf.get(p);
        const race = seat?.race;
        const r = race?.slots?.[seat.slot];
        if (!race || race.ended || !r) break;
        useItem(race, r, now); // no arguments: the server decides from what they hold
        break;
      }
      default:
        break; // consumed and ignored: a server->client name sent back at us
    }
  } catch (e) {
    warn(`frame '${m.t}' failed`, e);
  }
  return true;
}

/**
 * 'join' is observed, never consumed. index.js has not moved the player yet
 * when this runs, so the frame's own target is what we read.
 *
 * A den ('house:<owner>') join can still be refused by the house gate, so it is
 * left to pruneLobby()'s lazy re-validation rather than dropped here: being
 * turned away at a friend's door must not also cost you your place on the
 * sign-on sheet.
 */
function observeJoin(p, m, now) {
  const room = typeof m.room === 'string' ? m.room : null;
  if (!room) return;
  if (room === ROOM) {
    // A racer who walked out and back in gets their kart returned.
    if (!tryResume(p, now)) {
      // The lobby only broadcasts on change, so a late arrival would stare at a
      // blank sign-on sheet. index.js's joinRoom is not ours to edit, so the
      // board is posted to them once the join has actually happened, and again
      // shortly after in case their room chunk was still being fetched.
      const send = () => { try { if (p.room === ROOM) S.sendTo(p, lobbyPayload()); } catch { /* dead socket */ } };
      queueMicrotask(send);
      const late = setTimeout(send, 900);
      late.unref?.();
    }
    return;
  }
  if (room.startsWith('house:')) return;
  partPlayer(p, now);
}

/**
 * The 'score' frame for a kart run, on its way to the normal coin road.
 *
 * We do not consume it and we do not refuse it: we CORRECT it. If this server
 * ran the race, the coins and the score become the ones computed from the
 * placement assigned by the server clock, so a forged first place is worth
 * exactly what the run was actually worth. If there is no race behind it, it is
 * a practice lap (docs/KARTS.md §5) and is left completely alone — an ordinary
 * solo minigame run, bounded by maxCoinsPerRun and minRunMs like every other.
 */
function observeScore(p, m, now) {
  if (m.game !== GAME) return;
  const pay = S.payouts.get(p);
  if (!pay) return;
  S.payouts.delete(p);
  if (now - pay.at > PAYOUT_TTL_MS) return;
  m.coins = pay.coins;
  m.score = pay.score;
  S.stats.payoutsClaimed++;
}

/** Disconnect. Beside econ.dropPlayer(p) in index.js's leaveWorld. */
export function dropPlayer(p) {
  if (!p) return;
  try { partPlayer(p); } catch (e) { warn('dropPlayer failed', e); }
  S.budget.delete(p);
}

// ---------------------------------------------------------------------------
// introspection (tests and /api/health)
// ---------------------------------------------------------------------------

export function stats() {
  // `races` is the lifetime counter; `live` is how many are running right now
  return { ...S.stats, installed: S.installed, lobby: S.lobby.length, live: S.races.size };
}

/** Everything this module remembers about one connection. Tests read it. */
export function peek(p) {
  const seat = S.seatOf.get(p);
  return {
    inLobby: lobbyIndex(p) >= 0,
    slot: seat ? seat.slot : null,
    race: seat ? seat.race : null,
    racer: seat ? seat.race.slots[seat.slot] : null,
    payout: S.payouts.get(p) || null,
  };
}

/** Test-only handles. Nothing in the game reads these. */
export const _internals = { S, startRace, endRace, advance, standings, gridSpot, roulette, claimBox, useItem };

export default {
  install, handleMessage, dropPlayer, tick, stats, peek, stopHeartbeat,
  lobbyPayload, aiSpeed, scoreFor, coinsFor,
  ROOM, GAME, TRACK_ID, MAX_RACERS, LAPS, LAP_UNITS, CHECKPOINTS,
  BOXES, AI_SECTORS, AI_NAMES, AI_SPEED_MIN, AI_SPEED_MAX, AI_BOOST_MAX, PLACE_COINS,
  KART_LIGHTS_MS, GRID_LEAD_MS, KART_WAIT_MS, START_SOON_MS,
  KART_MAX_Q_PER_S, KART_MAX_BACK_Q, KART_IN_LIMIT, KART_SOCIAL_LIMIT,
  MAX_FRAME_DT_MS, TICK_MS, BOARD_MS,
  KART_REJOIN_MS, FINISH_GRACE_MS, RACE_MAX_MS, PAYOUT_TTL_MS,
  BOX_RESPAWN_MS, BOX_Q_TOL, BOX_LAT_TOL, PEEL_TTL_MS, PEEL_SPIN_MS,
  PEEL_SELF_IMMUNE_MS, BUBBLE_TTL_MS, BUBBLE_SLOW_MS, BERRY_MS,
  OPS, _internals,
};
