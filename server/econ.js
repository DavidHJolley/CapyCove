/**
 * server/econ.js — economy integrity (wave 11: N-16, N-18, N-19).
 *
 * ONE job: decide whether a coin claim is POSSIBLE. Nothing here decides
 * whether a player has earned enough today, because there is no such thing:
 *
 *   THE LAW OF THIS MODULE
 *   No daily cap. No rolling cap. No earning ceiling of any kind. A capy who
 *   grinds minigames for six hours honestly keeps every single coin. Every
 *   refusal in this file is a refusal of an IMPOSSIBLE claim — a ninety-second
 *   sled run that finished in two seconds, a score frame for a run that was
 *   never started, a run token spent twice, a run claimed for a game that
 *   lives in another room — and never a refusal of a player who is simply
 *   good at this game and has been at it a while.
 *
 * Everything merely SUSPICIOUS (a pair of accounts duelling each other all
 * afternoon) is written to the audit trail and paid anyway, except for the one
 * narrow case the campaign asks for: the +30 agreed-winner bonus cools down for
 * a pair that has traded a dozen wins inside an hour. The audit trail is
 * LOG-ONLY by design (server/audit.js): a line in it has never blocked a payout
 * and must never start.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT WITH index.js (the same install(ctx) shape progress.js and
 * layouts.js already prove — this module wires NOTHING itself):
 *
 *   econ.install({ sendTo, audit, recordFor?, ... })   once at boot
 *   econ.handleMessage(p, m)  first refusal; consumes 'mgstart' and nothing else
 *   econ.claimRun(p, m)       the body of case 'score'  -> {ok, best, ...}
 *   econ.noteBest(p, m)       the body of case 'best'   -> {ok, score}
 *   econ.matchStarted(match, players)  in startMatch(), after the seats are set
 *   econ.matchMove(p)                  in case 'match-move', after the budget
 *   econ.duelPayout(match, winner, reason)  in endMatch(), before grantCoins
 *   econ.dropPlayer(p) / econ.prune()  housekeeping; both optional
 *
 * Refusals speak for themselves: claimRun sends its own toast and writes its
 * own audit line, so the caller only has to check `ok`.
 *
 * ---------------------------------------------------------------------------
 * THE RUN TOKEN (N-16)
 *
 * 'mgstart' arms exactly one token per connection. The token remembers the
 * game, the room that game lives in (MINIGAMES[game].room — nothing here names
 * a room, so moving a minigame is still a one-line change in constants), and
 * the wall clock. 'score' is paid only against a live token, which is then
 * SPENT. Arming while already armed REPLACES the token rather than stacking a
 * second one: replacing restarts the clock, so a client that spams 'mgstart'
 * makes the minimum duration harder to satisfy, never easier.
 *
 * DECISION: a duration failure does NOT spend the token. The honest reading of
 * an early 'score' is a clock skew or a lagged frame, and the punishing reading
 * costs a real player their run. Leaving the token armed means the claim simply
 * has to wait out the minimum — which is the whole guard — and one token is
 * still one payout.
 *
 * DECISION: the room is checked at BOTH ends, but an UNSET room at arm time is
 * tolerated. src/net/client.js re-sends 'mgstart' the moment a socket comes
 * back, which can land before the 'join' that follows it; refusing there would
 * eat an honest run for the crime of a flaky connection.
 *
 * ---------------------------------------------------------------------------
 * 'best' RIDES THE SAME TOKEN (N-19)
 *
 * The client sends best BEFORE score (src/core/game.js reportMinigame calls
 * setBest first), so "only accept a best from a run already paid" cannot be
 * read literally without throwing away every honest personal best. Instead the
 * best is PARKED on the live token and handed back by claimRun once the run has
 * actually been paid. A best with no run behind it is refused; a best that
 * arrives just after its own payout (a reordered or resent frame) is honoured
 * inside a short grace window. Same guarantee, no honest casualties.
 *
 * ---------------------------------------------------------------------------
 * DEN DUELS (N-18)
 *
 * A den duel already needs both capys to name the same winner, so the only way
 * to fabricate one is collusion. The guards are therefore about IMPOSSIBILITY:
 * a match shorter than the game's floor, or a winner who never moved. Both
 * suppress the coins AND the progression signal, because a match that did not
 * happen did not happen. The pair tracker is LOG-ONLY: a dozen wins an hour
 * between the same two accounts is also just two friends playing all evening,
 * so a hot pair is written to the audit trail (once a minute at most) and the
 * win pays in full. A real collusion ring is a person's call to make, with the
 * mod tools, on the pattern the log shows them.
 *
 * ---------------------------------------------------------------------------
 * ANOMALY LINES (audit, log-only)
 *   econ.anomaly.duration  a run claimed faster than the game can be played
 *   econ.anomaly.replay    a token spent twice
 *   econ.anomaly.room      a run claimed from the wrong room
 *   econ.anomaly.token     a score frame with no armed run behind it
 *   econ.anomaly.duel      an impossible den match, or a cooled pair
 * Each is coalesced per player per kind (one line a minute, carrying the count
 * of the ones it stands for) so a script cannot flood the log it is caught in.
 */

import { MINIGAMES } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** Used when MINIGAMES[game] carries no minRunMs of its own. */
export const DEFAULT_MIN_RUN_MS = 5_000;
/** Used when MINIGAMES[game] carries no duel floors of its own. */
export const DEFAULT_MIN_MATCH_MS = 6_000;
export const DEFAULT_MIN_MOVES = 2;

/**
 * Per-game floors, proposed from each minigame's real pace and kept here so the
 * module is correct BEFORE shared/constants.js grows the same numbers (the
 * table there is orchestrator-owned; see the wave report). MINIGAMES wins
 * whenever it has the field, so the day it lands this becomes dead weight and
 * can be deleted.
 *
 * Every number is a FLOOR, not a typical run: the fastest way a run can
 * possibly end — including the ugliest possible loss — with a comfortable
 * margin under it. A typical run of any of these is five to fifteen times
 * longer, which is the point: the floor is only ever meant to catch a claim
 * that could not have been played at all.
 *   fishing   90s or three hearts; three junk hooks back to back
 *   sled      ~3s gate countdown, then a crash into the first tree
 *   smoothie  ~2.3s BLEND! countdown, then three strikes in a row
 *   pong      first to five; a five-rally sweep on a 560px field
 *   shuffle   two rounds of four pucks, alternating: sixteen slides
 *   chess     the fastest loss on the board is four moves of animation
 *   connect4  seven drops with the chip fall and a 240ms AI budget
 *   cards     25 HP each, with hit-stop and a finish cam on every strike
 *   prophunt  TWO rounds, each 2.4s intro + 6s solo hide before the seek
 *   doodle    six solo rounds, even guessed on the first stroke each time
 */
export const MIN_RUN_MS = Object.freeze({
  fishing: 6_000,
  sled: 5_000,
  smoothie: 6_000,
  pong: 8_000,
  shuffle: 10_000,
  chess: 6_000,
  connect4: 5_000,
  cards: 12_000,
  prophunt: 9_000,
  doodle: 10_000,
});

/**
 * Den duel floors. `moves` counts the WINNER's relayed match-move frames, so it
 * is per-game: a paddle sends one most frames, a chess piece sends one per
 * move. Kept low on purpose — the duration floor does the heavy lifting and
 * this only has to make "match-start, match-done, paid" impossible.
 */
export const DUEL_FLOORS = Object.freeze({
  pong: { ms: 6_000, moves: 8 },
  shuffle: { ms: 10_000, moves: 3 },
  chess: { ms: 6_000, moves: 2 }, // fool's mate is a real 2-move win
  connect4: { ms: 5_000, moves: 3 },
  cards: { ms: 12_000, moves: 4 },
});

/** How long a best may arrive after its own payout and still be honoured. */
export const BEST_GRACE_MS = 20_000;
/** The +30 agreed-winner bonus: N per unordered pair per rolling window. */
export const PAIR_WINDOW_MS = 60 * 60 * 1000;
export const PAIR_BONUS_MAX = 12;
/** One audit line per player per anomaly kind per this long. */
export const ANOMALY_COOLDOWN_MS = 60 * 1000;
/** Hard ceiling on the pair table, so a long uptime cannot leak. */
const PAIR_MAX_KEYS = 5_000;

export const OPS = Object.freeze({
  DURATION: 'econ.anomaly.duration',
  REPLAY: 'econ.anomaly.replay',
  ROOM: 'econ.anomaly.room',
  TOKEN: 'econ.anomaly.token',
  DUEL: 'econ.anomaly.duel',
});

const TOASTS = Object.freeze({
  token: 'That run did not start on the server. Have another go and it will count.',
  replay: 'That run has already been paid out.',
  room: 'That run could not be counted from here.',
  fast: 'That run finished too fast to count. Give it a proper go!',
});

// ---------------------------------------------------------------------------
// module state (install() resets it, which is also how a test starts clean)
// ---------------------------------------------------------------------------

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const S = {
  installed: false,
  sendTo: () => {},
  auditFn: null,
  recordFor: null,
  now: () => Date.now(),
  keyFor: null,
  pairWindowMs: PAIR_WINDOW_MS,
  pairBonusMax: PAIR_BONUS_MAX,
  anomalyCooldownMs: ANOMALY_COOLDOWN_MS,
  runs: new WeakMap(), // player -> live token
  spent: new WeakMap(), // player -> the token it last spent
  noise: new WeakMap(), // player -> { kind: {n, at} }
  matches: new WeakMap(), // match object -> { at, game, seats: Map }
  pairs: new Map(), // pair key -> [timestamps of paid bonuses]
  stats: null,
};

function blankStats() {
  return {
    armed: 0, rearmed: 0, paid: 0,
    refusedToken: 0, refusedReplay: 0, refusedRoom: 0, refusedFast: 0,
    bestsParked: 0, bestsRefused: 0,
    duels: 0, duelsRefused: 0, duelsCooled: 0,
    anomalies: 0,
  };
}
S.stats = blankStats();

/** Boot. Every field is optional: a missing one degrades to a no-op, never a throw. */
export function install(ctx = {}) {
  S.installed = true;
  S.sendTo = typeof ctx.sendTo === 'function' ? ctx.sendTo : () => {};
  S.auditFn = typeof ctx.audit === 'function' ? ctx.audit : null;
  S.recordFor = typeof ctx.recordFor === 'function' ? ctx.recordFor : null;
  S.now = typeof ctx.now === 'function' ? ctx.now : () => Date.now();
  S.keyFor = typeof ctx.keyFor === 'function' ? ctx.keyFor : defaultKeyFor;
  S.pairWindowMs = clampInt(ctx.pairWindowMs, 0, 86_400_000, PAIR_WINDOW_MS);
  S.pairBonusMax = clampInt(ctx.pairBonusMax, 1, 100_000, PAIR_BONUS_MAX);
  S.anomalyCooldownMs = clampInt(ctx.anomalyCooldownMs, 0, 3_600_000, ANOMALY_COOLDOWN_MS);
  S.runs = new WeakMap();
  S.spent = new WeakMap();
  S.noise = new WeakMap();
  S.matches = new WeakMap();
  S.pairs.clear();
  S.stats = blankStats();
  return S;
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Accounts are one identity across tabs; a guest is only ever its socket. */
function defaultKeyFor(p) {
  if (!p) return null;
  if (p.username) return `u:${String(p.username).toLowerCase()}`;
  return p.id ? `g:${p.id}` : null;
}

// ---------------------------------------------------------------------------
// table lookups (MINIGAMES first, the local floors second)
// ---------------------------------------------------------------------------

/** The catalogue entry, or null. Own-property: MINIGAMES.constructor is truthy. */
function gameOf(id) {
  return typeof id === 'string' && has(MINIGAMES, id) ? MINIGAMES[id] : null;
}

export function minRunMs(id) {
  const g = gameOf(id);
  if (!g) return DEFAULT_MIN_RUN_MS;
  const fromTable = Math.floor(Number(g.minRunMs));
  if (Number.isFinite(fromTable) && fromTable >= 0) return fromTable;
  return has(MIN_RUN_MS, id) ? MIN_RUN_MS[id] : DEFAULT_MIN_RUN_MS;
}

export function duelFloors(id) {
  const g = gameOf(id) || {};
  const local = has(DUEL_FLOORS, id) ? DUEL_FLOORS[id] : null;
  const ms = Math.floor(Number(g.minMatchMs));
  const moves = Math.floor(Number(g.minMoves));
  return {
    ms: Number.isFinite(ms) && ms >= 0 ? ms : (local ? local.ms : DEFAULT_MIN_MATCH_MS),
    moves: Number.isFinite(moves) && moves >= 0 ? moves : (local ? local.moves : DEFAULT_MIN_MOVES),
  };
}

// ---------------------------------------------------------------------------
// audit (log-only, coalesced, and it can never throw into a payout)
// ---------------------------------------------------------------------------

function actorOf(p) {
  const out = { id: p?.id || null, name: p?.name || null };
  if (S.recordFor) {
    try {
      const rec = S.recordFor(p);
      if (rec?.uid) out.uid = rec.uid;
    } catch { /* an audit nicety is never worth a throw */ }
  }
  return out;
}

/**
 * One anomaly line, at most one per player per kind per cooldown. The
 * suppressed ones are not lost: the next line carries how many it stands for.
 */
function anomaly(op, kind, p, args = {}) {
  const at = S.now();
  let bucket = S.noise.get(p);
  if (!bucket) { bucket = Object.create(null); S.noise.set(p, bucket); }
  const seen = bucket[kind] || (bucket[kind] = { n: 0, at: 0 });
  seen.n++;
  if (seen.at && at - seen.at < S.anomalyCooldownMs) return false;
  const repeats = seen.n - 1;
  seen.at = at;
  seen.n = 0;
  S.stats.anomalies++;
  if (!S.auditFn) return true;
  try {
    S.auditFn({
      actor: actorOf(p), via: 'system', op, ok: false,
      target: null,
      args: repeats > 0 ? { ...args, repeats } : args,
    });
  } catch { /* the audit trail never blocks the game it describes */ }
  return true;
}

function toast(p, msg) {
  try { S.sendTo(p, { t: 'toast', msg }); } catch { /* a dead socket is not our problem */ }
}

// ---------------------------------------------------------------------------
// run tokens
// ---------------------------------------------------------------------------

let nextToken = 1;

/**
 * The body of case 'mgstart'. Returns the token, or null if it was refused.
 * Silent on refusal: the score that follows is where a player is told.
 */
export function arm(p, gameId) {
  if (!p) return null;
  const g = gameOf(gameId);
  if (!g) return null; // an unknown game is not worth a word
  const room = typeof g.room === 'string' ? g.room : null;

  // Arming from the wrong room is impossible for an honest client: a minigame
  // is launched from a hotspot inside its own room, and walking out tears it
  // down. An UNSET room is the reconnect race, not a claim (see the header).
  if (room && p.room && p.room !== room) {
    S.stats.refusedRoom++;
    anomaly(OPS.ROOM, 'room', p, { game: gameId, at: 'arm', room: p.room, want: room });
    return null;
  }

  const live = S.runs.get(p);
  if (live) S.stats.rearmed++; // replaces, never stacks: the clock restarts
  const token = {
    id: `r${nextToken++}`,
    game: gameId,
    room,
    at: S.now(),
    best: 0,
  };
  S.runs.set(p, token);
  S.stats.armed++;
  return token;
}

/** First refusal on the wire. Consumes 'mgstart' and nothing else. */
export function handleMessage(p, m) {
  if (!p || !m || typeof m.t !== 'string') return false;
  if (m.t !== 'mgstart') return false;
  try { arm(p, m.game); } catch { /* never take the socket down with us */ }
  return true;
}

/**
 * The body of case 'score'. Sends its own toast and writes its own audit line,
 * so the caller only checks `ok`.
 *
 * -> { ok: true,  game, elapsed, best }   best = the personal best parked on
 *                                         this run, 0 if there was none
 * -> { ok: false, code, msg }             code: 'game'|'token'|'replay'|'room'|'fast'
 */
export function claimRun(p, m) {
  if (!p || !m) return { ok: false, code: 'game' };
  const gameId = m.game;
  if (!gameOf(gameId)) return { ok: false, code: 'game' };
  const now = S.now();
  const token = S.runs.get(p);

  if (!token || token.game !== gameId) {
    // Was this the same run coming round twice? That is a replayed token, and
    // it is worth its own line: it is the shape a script makes, not a player.
    const last = S.spent.get(p);
    if (last && last.game === gameId) {
      S.stats.refusedReplay++;
      anomaly(OPS.REPLAY, 'replay', p, { game: gameId, token: last.id, spentAgo: now - last.at });
      toast(p, TOASTS.replay);
      return { ok: false, code: 'replay', msg: TOASTS.replay };
    }
    S.stats.refusedToken++;
    anomaly(OPS.TOKEN, 'token', p, { game: gameId, had: token ? token.game : null });
    toast(p, TOASTS.token);
    return { ok: false, code: 'token', msg: TOASTS.token };
  }

  if (token.room && p.room !== token.room) {
    S.stats.refusedRoom++;
    anomaly(OPS.ROOM, 'room', p, { game: gameId, at: 'score', room: p.room || null, want: token.room });
    toast(p, TOASTS.room);
    return { ok: false, code: 'room', msg: TOASTS.room };
  }

  const floor = minRunMs(gameId);
  const elapsed = now - token.at;
  if (elapsed < floor) {
    // The token stays ARMED on purpose (see the header): the claim has to wait
    // out the minimum, and an honest finish a moment later is still paid.
    S.stats.refusedFast++;
    anomaly(OPS.DURATION, 'duration', p, { game: gameId, elapsed, floor });
    toast(p, TOASTS.fast);
    return { ok: false, code: 'fast', msg: TOASTS.fast };
  }

  S.runs.delete(p); // one token, one payout
  S.spent.set(p, { id: token.id, game: gameId, at: now });
  S.stats.paid++;
  return { ok: true, game: gameId, elapsed, best: token.best || 0 };
}

/**
 * The body of case 'best'. A best is parked on the live run and handed back by
 * claimRun once the run has been PAID; only a best that arrives after its own
 * payout is written straight through.
 *
 * -> { ok: true,  score }    write it now
 * -> { ok: false, parked }   parked:true means "held, claimRun will hand it back"
 */
export function noteBest(p, m) {
  if (!p || !m) return { ok: false, parked: false };
  const gameId = m.game;
  if (!gameOf(gameId)) return { ok: false, parked: false };
  const score = Math.floor(Number(m.score) || 0);
  if (!(score > 0) || score >= 10_000_000) return { ok: false, parked: false };

  const token = S.runs.get(p);
  if (token && token.game === gameId) {
    if (score > token.best) token.best = score;
    S.stats.bestsParked++;
    return { ok: false, parked: true, score };
  }
  const last = S.spent.get(p);
  if (last && last.game === gameId && S.now() - last.at <= BEST_GRACE_MS) {
    return { ok: true, parked: false, score };
  }
  // No run behind it. Silent: a leaderboard claim is not worth a toast, and a
  // stale client resending an old best is a bug, not a cheat.
  S.stats.bestsRefused++;
  return { ok: false, parked: false, score };
}

/** Everything this module remembers about one connection. Tests read it too. */
export function peek(p) {
  return { run: S.runs.get(p) || null, spent: S.spent.get(p) || null };
}

/** Optional: called on disconnect. The WeakMaps free themselves; this is tidiness. */
export function dropPlayer(p) {
  if (!p) return;
  S.runs.delete(p);
  S.spent.delete(p);
  S.noise.delete(p);
}

// ---------------------------------------------------------------------------
// den duels
// ---------------------------------------------------------------------------

/** Called from startMatch once the seats are known. `players` are the seated capys. */
export function matchStarted(match, players = []) {
  if (!match || typeof match !== 'object') return null;
  const seats = new Map();
  for (const p of players) {
    if (!p || !p.id) continue;
    seats.set(p.id, { key: S.keyFor(p), moves: 0 });
  }
  const rec = { at: S.now(), game: match.game, seats };
  S.matches.set(match, rec);
  return rec;
}

/** Called from case 'match-move', after the frame has passed its own budget. */
export function matchMove(p) {
  const match = p?.match;
  if (!match) return 0;
  const rec = S.matches.get(match);
  const seat = rec?.seats.get(p.id);
  if (!seat) return 0;
  return ++seat.moves;
}

function pairKeyOf(rec, ids) {
  const keys = [];
  for (const id of ids) {
    const seat = rec.seats.get(id);
    if (!seat || !seat.key) return null;
    keys.push(seat.key);
  }
  if (keys.length !== 2) return null;
  return keys.sort().join('|'); // unordered: A beating B is the same pair as B beating A
}

/** Trim the pair table: a window that has rolled past is not evidence of anything. */
export function prune(at = S.now()) {
  for (const [key, hits] of S.pairs) {
    const live = hits.filter((t) => at - t < S.pairWindowMs);
    if (live.length) S.pairs.set(key, live);
    else S.pairs.delete(key);
  }
}

/**
 * Called from endMatch, before any coin moves.
 *
 * -> { pay, signal, bonus, why, elapsed, moves }
 *      pay     may the win be paid at all
 *      signal  did a real match happen (quests, stamps, the ladder)
 *      bonus   is the +30 agreed-winner bonus off cooldown for this pair
 *
 * An untracked match (module wired after the match began, or a bot table) pays:
 * when this file does not know, the player gets the coins.
 */
export function duelPayout(match, winnerId, reason = 'done') {
  const out = { pay: true, signal: true, bonus: true, why: 'ok', elapsed: 0, moves: 0 };
  if (!match || !winnerId || winnerId === 'draw') {
    out.pay = false; out.signal = false; out.bonus = false; out.why = 'no-winner';
    return out;
  }
  const rec = S.matches.get(match);
  if (!rec) { out.why = 'untracked'; return out; }

  const now = S.now();
  const seats = [...rec.seats.keys()];
  const seat = rec.seats.get(winnerId);
  out.elapsed = now - rec.at;
  out.moves = seat ? seat.moves : 0;
  S.stats.duels++;

  const floors = duelFloors(rec.game);

  // Impossible #1: a duel that did not last as long as the game takes to play.
  if (out.elapsed < floors.ms) {
    out.pay = false; out.signal = false; out.bonus = false; out.why = 'too-fast';
    S.stats.duelsRefused++;
    anomaly(OPS.DUEL, 'duel', winnerPlayerStub(rec, winnerId), {
      kind: 'too-fast', game: rec.game, reason, elapsed: out.elapsed, floor: floors.ms,
    });
    return out;
  }

  // Impossible #2: a winner who never touched the board. A forfeit is exempt —
  // the capy who stayed put may honestly not have moved before the other left.
  if (reason !== 'forfeit' && out.moves < floors.moves) {
    out.pay = false; out.signal = false; out.bonus = false; out.why = 'too-few-moves';
    S.stats.duelsRefused++;
    anomaly(OPS.DUEL, 'duel', winnerPlayerStub(rec, winnerId), {
      kind: 'too-few-moves', game: rec.game, reason, moves: out.moves, floor: floors.moves,
    });
    return out;
  }

  // Suspicious, never punished: the same two accounts trading wins all hour is
  // ALSO what two friends playing pong all evening looks like (a duel is a few
  // minutes; a dozen an hour is honest). So this is LOG-ONLY: the win pays in
  // full, the match counts for everything, and the audit trail carries the
  // pattern so a real collusion ring can be dealt with by a person.
  const key = pairKeyOf(rec, seats);
  if (key) {
    if (S.pairs.size > PAIR_MAX_KEYS) prune(now);
    const hits = (S.pairs.get(key) || []).filter((t) => now - t < S.pairWindowMs);
    if (hits.length >= S.pairBonusMax) {
      out.why = 'pair-hot';
      S.stats.duelsCooled++;
      anomaly(OPS.DUEL, 'duel', winnerPlayerStub(rec, winnerId), {
        kind: 'pair-hot', game: rec.game, wins: hits.length,
        windowMs: S.pairWindowMs, note: 'log-only; the win paid in full',
      });
    }
    hits.push(now);
    S.pairs.set(key, hits);
  }
  return out;
}

/**
 * The audit actor for a duel line: all we hold is the seat, so say the seat.
 * CACHED per winner so anomaly()'s per-player coalescing (a WeakMap keyed by
 * the actor object) actually coalesces; a fresh stub per call gave every duel
 * line a fresh bucket and let a script flood the very log that caught it.
 */
const _stubs = new Map();
function winnerPlayerStub(rec, winnerId) {
  const seat = rec.seats.get(winnerId);
  const key = String(seat?.key || winnerId);
  let stub = _stubs.get(key);
  if (!stub) {
    if (_stubs.size > 2_000) _stubs.clear();
    _stubs.set(key, stub = { id: winnerId, name: null, key: seat?.key || null });
  }
  return stub;
}

// ---------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------

export function stats() {
  return {
    ...S.stats,
    installed: S.installed,
    pairs: S.pairs.size,
    caps: 'none', // there are none, and /api/health should say so out loud
  };
}

export default {
  install, handleMessage, arm, claimRun, noteBest, peek, dropPlayer,
  matchStarted, matchMove, duelPayout, prune, stats,
  minRunMs, duelFloors, MIN_RUN_MS, DUEL_FLOORS, OPS,
  BEST_GRACE_MS, PAIR_WINDOW_MS, PAIR_BONUS_MAX, ANOMALY_COOLDOWN_MS,
};
