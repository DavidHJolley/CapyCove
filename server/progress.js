/**
 * Progression module: daily quests, stamp album, milestone rewards (wave 7,
 * docs/LIVING-COVE.md section D). Owned separately from index.js so the live
 * systems and the progression systems can evolve independently.
 *
 * Contract with index.js (already wired there; do not edit index.js):
 *  - install(ctx) is called once at boot with
 *      { users, saveSoon, grantCoins, sendTo, broadcastToRoom, has }
 *  - handleMessage(p, m) gets first refusal on every ws frame from a live
 *    player; return true to consume it (quest board opens, album reads, etc.)
 *  - signal(name, p, data) is called by index.js's own handlers at scoring
 *    moments; names (stable, agreed): 'score' {game, coins}, 'match-win'
 *    {game}, 'race-done' {placed}, 'dig' {gem}, 'party-host' {count},
 *    'party-attend', 'mural-pixel', 'chat', 'wave', 'room' {room},
 *    'whale-ride' {riders}, 'doodle-correct', 'bottle'.
 *  - tick(dtSeconds, worldClock) is called from the main interval so dailies
 *    can roll over on the day boundary (wave 12: the REAL America/New_York
 *    calendar day, not the 40-minute cove day; the clock argument is now only
 *    read for `aurora`).
 *  - install() also accepts an optional `now()` for tests; production does not
 *    pass one and gets Date.now.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (deviations and decisions are called out inline as DEVIATION)
 *
 * Anti-farm, the rule everything else bends around: progression NEVER trusts
 * the client. A quest advances only from signal(), i.e. from a moment one of
 * the hardened handlers in index.js already validated and rate-limited (a paid
 * score run, an agreed match win, an accepted mural op). handleMessage only
 * ever *reads* (board + album); there is no "I finished it" frame to forge, and
 * no client field is ever used as a threshold. Stamps are idempotent: an id in
 * the record is earned forever and can never pay twice. Quest coins go through
 * ctx.grantCoins, so the rolling hourly backstop still bounds the faucet.
 *
 * Frames this module owns (add to the CLAUDE.md registry when the wave ships):
 *   client -> server : {t:'quests'}  ask for the board
 *                      {t:'stamps'}  ask for the album
 *   server -> client : {t:'quests', day, locked, ends, resetIn, bonus, quests[],
 *                        streak:{days,show,plus,best,gift,next,claimed}}
 *                      {t:'quest-done', id, name, coins, all?, fanfare}
 *                      {t:'stamp', id, name, desc, how, total, of, fanfare}
 *                      {t:'stamps', ...album, milestones[], title, colors}
 *   Milestone grants reuse the EXISTING inventory frames so the client stays in
 *   sync with no new plumbing: {t:'shop', ok:true, ownedHats} for hats (no
 *   `bought` field, so nothing is auto-equipped) and {t:'furn', ok:true,
 *   ownedFurniture} for furniture, plus a {t:'toast'}.
 *   The wave-12 login gift does the same: ctx.grantCoins sends the {t:'coins'}
 *   frame, the warm line rides {t:'toast'}, and the streak itself is a block on
 *   the 'quests' board frame. NO new wire frame was added for any of it.
 *
 * Robustness: index.js may call tick()/signal() from a later wiring pass, or
 * never. Nothing here depends on tick running: the day rollover is also
 * checked lazily whenever a board is touched, so a server whose tick is not
 * wired still hands out correct dailies (it just cannot push the new board
 * unprompted). Every entry point is wrapped: a throw in progression must never
 * cost a player their frame.
 */

import { QUESTS, STAMPS, MILESTONES, ROOM_IDS } from '../shared/constants.js';
import { ensureOwnedFurniture } from './db.js';

/**
 * WAVE 12 (N-25/N-26): the quest day is the REAL CALENDAR DAY in
 * America/New_York, not the 40-minute cove day.
 *
 * The sky still turns every 40 minutes (docs/LIVING-COVE.md section A) and
 * nothing here touches it. What changed is the ritual: a board that rerolled 36
 * times a real day was not a daily anything, "finish all three on five days"
 * was a 3.3-hour achievement, and the whole point of a daily is that it waits
 * for you until tomorrow. Everything day-shaped in this module now keys off
 * `dayKey()`, the same YYYY-MM-DD America/New_York string `touchDate` has
 * always used for "days played" (and server/store.js for backup rotation, and
 * server/auth.js for ban notices: the whole live-ops stack reads one clock).
 */
const DAY_TZ = 'America/New_York';
const DAY_MS = 86_400_000;

const DAILY_COUNT = 3;
// The board is now a once-a-day event rather than a 40-minute treadmill, so the
// clear bonus is worth a real moment. A full board is ~250-300 coins a day
// against ~1,500-2,000/hour of honest play: a warm nudge, never the income.
const ALL_THREE_BONUS = 100;
const READ_BURST = 6; // {t:'quests'}/{t:'stamps'} reads per second, per player
const DRIFT_FLUSH_MS = 15_000; // how often a Drift stay is folded into the total
const MAX_ROOMS_TRACKED = 32; // keeps the persisted record small
const AURORA_ROOM = 'peak'; // the only room that renders the ribbons

/**
 * Day-sized quest asks (N-25, second half: "raise per-quest counts to suit a
 * full day"). shared/constants.js is contract data owned by the orchestrator,
 * so the numbers are re-stated HERE as a diff on top of the shared table rather
 * than edited in place; `QUEST_LIST` below is what the rest of this module
 * (board draw, payload, progress, payout) actually reads, so a raised count and
 * its sentence can never drift apart. Fold this table into QUESTS whenever the
 * orchestrator wants it there; deleting an entry simply restores the old ask.
 *
 * Sizing rule: a quest should be a good afternoon, not a second job. One-shot
 * feats (win a race, strike a gem, find the bottle, throw a party) stay at 1,
 * because doing it once is the whole story. Repeatable verbs move to roughly
 * 3x the old 40-minute ask, and their coins move with them so the trade never
 * gets worse than it was.
 */
const DAY_SCALE = {
  q_sled: { count: 3, coins: 60, desc: 'Take three runs down Summit Sprint.' },
  q_three_runs: { count: 6, coins: 80, desc: 'Play six minigame runs today.' },
  q_hunt: { count: 2, coins: 55, desc: 'Play two rounds of Prop Hunt in the mine.' },
  q_match: { count: 3, coins: 80, desc: 'Win three duels at the Game Den.' },
  q_pong: { count: 2, coins: 55, desc: 'Win two rounds of Paddle Panic.' },
  q_cards: { count: 2, coins: 75, desc: 'Win two Capy Clash duels.' },
  q_connect4: { count: 2, coins: 55, desc: 'Win two games of Four in a Row.' },
  q_shuffle: { count: 2, coins: 55, desc: 'Win two rounds of Shuffle Showdown.' },
  q_race: { count: 2, coins: 60, desc: 'Finish two three-capy sled races.' },
  q_doodle: { count: 8, coins: 70, desc: 'Guess eight doodles right in the jungle.' },
  q_mural: { count: 12, coins: 60, desc: 'Add twelve pixels to the plaza mural.' },
  q_chat: { count: 20, coins: 45, desc: 'Chat twenty times with the cove.' },
  q_wave: { count: 10, coins: 40, desc: 'Wave at the cove ten times.' },
  q_ball: { count: 30, coins: 60, desc: 'Bop the beach ball thirty times.' },
  q_snow: { count: 20, coins: 60, desc: 'Land twenty snowballs on the peak.' },
  q_bonfire: { count: 5, coins: 45, desc: 'Warm up by the beach bonfire for five minutes.' },
  q_dig: { count: 30, coins: 55, desc: 'Prospect thirty times in the Glimmer Mine.' },
  // deliberately unscaled: q_fish / q_smoothie (a scoring threshold, not a
  // count), q_race_win, q_gem, q_bottle, q_pod, q_drift, q_chess, q_party_*
  // (one-shot feats), q_tour (five DISTINCT rooms is already a real tour).
};

/** The shared quest table with the day-sized asks folded in. */
const QUEST_LIST = QUESTS.map((q) => (
  Object.prototype.hasOwnProperty.call(DAY_SCALE, q.id) ? { ...q, ...DAY_SCALE[q.id] } : q
));

const QUEST_BY_ID = new Map(QUEST_LIST.map((q) => [q.id, q]));
const STAMP_BY_ID = new Map(STAMPS.map((s) => [s.id, s]));
const FIXED_ROOMS = new Set(ROOM_IDS); // dens ('house:<owner>') never count

/**
 * Signals index.js has agreed to send (the contract above). Quests bound to one
 * of these are always eligible for the daily draw. Anything else (the wave's
 * play toys: 'ball', 'snow', 'bonfire') becomes eligible the first time this
 * boot actually sees it, so a quest can never be drawn for a system that is not
 * emitting yet, and starts appearing the moment that system lands.
 */
const CORE_SIGNALS = [
  'score', 'match-win', 'race-done', 'dig', 'party-host', 'party-attend',
  'mural-pixel', 'chat', 'wave', 'room', 'whale-ride', 'doodle-correct', 'bottle',
];
const QUEST_SIGNALS = new Set(QUEST_LIST.map((q) => q.signal));
const liveSignals = new Set(CORE_SIGNALS);

/** Names other agents might plausibly use for the same moment. */
const ALIASES = {
  'ball-bop': 'ball', 'beach-ball': 'ball', bop: 'ball',
  snowball: 'snow', 'snow-hit': 'snow', 'snowball-hit': 'snow',
  mural: 'mural-pixel', pixel: 'mural-pixel',
  'party-attended': 'party-attend', 'party-guest': 'party-attend',
  'party-thrown': 'party-host',
  race: 'race-done', match: 'match-win', 'match-won': 'match-win',
  doodle: 'doodle-correct', 'doodle-guess': 'doodle-correct',
  'bottle-found': 'bottle', bonfire_tick: 'bonfire', 'bonfire-tick': 'bonfire',
  whale: 'whale-ride', ride: 'whale-ride',
  // NOT aliased: a bare 'emote' would count dances as waves
  'room-enter': 'room', join: 'room',
};

const own = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

let ctx = null;
/** Players seen this boot; pruned as their sockets die (index.js owns the map). */
const live = new Set();
let lastDay = '';

/**
 * The clock. index.js does not pass one, so this is Date.now in production;
 * tests install a fake so a whole week (and a DST weekend) can pass in a
 * millisecond. Everything time-shaped in this module reads through it.
 */
let now = () => Date.now();

export function install(c) {
  ctx = c || null;
  now = typeof c?.now === 'function' ? c.now : () => Date.now();
  lastDay = today();
  // A stamp with no rule can never be earned: shout about it once at boot
  // rather than silently shipping dead album art.
  const missing = STAMPS.filter((s) => !own(RULES, s.id)).map((s) => s.id);
  if (missing.length) console.warn('[progress] stamps with no rule:', missing.join(', '));
}

// ---------------------------------------------------------------------------
// day + seeded selection
// ---------------------------------------------------------------------------

let partFmt = null;

/**
 * The America/New_York wall clock at `ms`, as plain numbers.
 *
 * Intl is the only thing in Node that knows when the US moved its clocks, so it
 * is the authority here; a build without ICU tz data (small-icu) falls back to
 * UTC, which keeps a stable 24-hour day rather than crashing a player's board.
 */
function wallParts(ms) {
  try {
    if (!partFmt) {
      partFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: DAY_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
      });
    }
    const o = {};
    for (const part of partFmt.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') o[part.type] = part.value;
    }
    const p = {
      y: Number(o.year), mo: Number(o.month), d: Number(o.day),
      // some ICU versions still say "24" for midnight under h23
      h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second),
    };
    if (!Object.values(p).every(Number.isFinite)) throw new Error('bad parts');
    return p;
  } catch {
    const dt = new Date(ms);
    return {
      y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
      h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(),
    };
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The quest day: 'YYYY-MM-DD' in America/New_York. Exported for the tests and
 * for anything else that ever needs to agree with the board about what "today"
 * means. Same shape and same timezone as `touchDate`'s "days played" key, so
 * the two can never disagree about whether a player showed up.
 */
export function dayKey(ms = now()) {
  const p = wallParts(ms);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

/** ET wall clock minus UTC at this instant, in ms (-5h EST, -4h EDT). */
function offsetMs(ms) {
  const p = wallParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant ET midnight opened the day containing `ms`.
 *
 * The naive "subtract the offset" answer is wrong twice a year, because the
 * offset at noon is not the offset at midnight, so the first answer is checked
 * against the offset AT that answer and redone if the clocks moved in between.
 * US transitions happen at 2am local, so ET midnight always exists and is never
 * ambiguous; one correction is always enough.
 */
export function dayStartMs(ms = now()) {
  const off = offsetMs(ms);
  const localMidnight = Math.floor((ms + off) / DAY_MS) * DAY_MS;
  const start = localMidnight - off;
  const off2 = offsetMs(start);
  return off2 === off ? start : localMidnight - off2;
}

/**
 * When the current quest day ends (= next ET midnight), for the countdown.
 * Stepping 26 hours lands inside the next day whether it is 23, 24 or 25 hours
 * long, and then that day's own start is the exact boundary.
 */
export function dayEndMs(ms = now()) {
  return dayStartMs(dayStartMs(ms) + 26 * 3_600_000);
}

/** The day key before the one containing `ms`. */
export function prevDayKey(ms = now()) {
  return dayKey(dayStartMs(ms) - 1);
}

function today() {
  return dayKey(now());
}

/** When the current quest day ends, for the board's countdown. */
function dayEnds() {
  return dayEndMs(now());
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Small deterministic PRNG: same account + same day = same board, forever. */
function mulberry32(a) {
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawOne(pool, rnd, taken) {
  const free = pool.filter((q) => !taken.has(q.id));
  if (!free.length) return null;
  return free[Math.floor(rnd() * free.length) % free.length];
}

/**
 * The day's three: one minigame, one social, one of anything else, drawn from
 * the eligible pool with a per-account per-day seed.
 */
function pickDaily(key, day) {
  const rnd = mulberry32(hash32(`${key}|${day}`));
  const pool = QUEST_LIST.filter((q) => liveSignals.has(q.signal));
  const usable = pool.length ? pool : QUEST_LIST;
  const taken = new Set();
  const out = [];
  const byKind = (k) => usable.filter((q) => q.kind === k);
  for (const kind of ['minigame', 'social']) {
    const q = drawOne(byKind(kind), rnd, taken) || drawOne(usable, rnd, taken);
    if (q) { taken.add(q.id); out.push(q); }
  }
  while (out.length < DAILY_COUNT) {
    const q = drawOne(usable, rnd, taken);
    if (!q) break;
    taken.add(q.id);
    out.push(q);
  }
  // shuffle so the minigame quest is not always first on the board
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.map((q) => ({ id: q.id, n: 0, done: 0, ...(q.distinct ? { seen: [] } : {}) }));
}

// ---------------------------------------------------------------------------
// record shape
// ---------------------------------------------------------------------------

/** The stored account behind a connection, or null for guests. */
function recFor(p) {
  if (!ctx || !p || !p.registered || typeof p.username !== 'string') return null;
  return ctx.users.get(p.username.toLowerCase()) || null;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * `rec.progress` = { day, q[], bonus, stamps{id:ts}, mile, c{counters} }.
 * Hand-edited or half-written JSON must not be able to crash a handler, so
 * everything is coerced on read.
 */
function progFor(rec) {
  let pr = rec.progress;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) pr = rec.progress = {};
  // wave 12: `day` is a 'YYYY-MM-DD' America/New_York key, not the old
  // 40-minute cove-day index. A record still carrying a number reads as "no
  // board yet" and gets one fresh board on first touch: a one-off reroll on the
  // deploy that lands this, and nothing already earned is touched.
  if (typeof pr.day !== 'string') pr.day = '';
  if (!Array.isArray(pr.q)) pr.q = [];
  // Entries for quests that no longer exist in the pool are dropped, which
  // leaves a short board; ensureBoard() then reseeds the day. That only happens
  // when the pool itself is edited (a deploy), and a fresh board beats a board
  // with a hole in it that can never pay its bonus.
  pr.q = pr.q.filter((e) => e && typeof e === 'object' && QUEST_BY_ID.has(e.id)).slice(0, DAILY_COUNT);
  for (const e of pr.q) {
    e.n = Math.max(0, Math.floor(num(e.n)));
    e.done = e.done ? 1 : 0;
    if (QUEST_BY_ID.get(e.id).distinct && !Array.isArray(e.seen)) e.seen = [];
  }
  pr.bonus = pr.bonus ? 1 : 0;
  if (!pr.stamps || typeof pr.stamps !== 'object' || Array.isArray(pr.stamps)) pr.stamps = {};
  pr.mile = Math.max(0, Math.min(MILESTONES.length, Math.floor(num(pr.mile))));
  if (!pr.c || typeof pr.c !== 'object' || Array.isArray(pr.c)) pr.c = {};
  const c = pr.c;
  if (!c.byGame || typeof c.byGame !== 'object' || Array.isArray(c.byGame)) c.byGame = {};
  if (!c.mc || typeof c.mc !== 'object' || Array.isArray(c.mc)) c.mc = {}; // best PAID coins per game
  if (!c.winsBy || typeof c.winsBy !== 'object' || Array.isArray(c.winsBy)) c.winsBy = {};
  if (!Array.isArray(c.rooms)) c.rooms = [];
  return pr;
}

/** Number of stamps this account has earned. */
function stampCount(pr) {
  let n = 0;
  for (const s of STAMPS) if (own(pr.stamps, s.id)) n++;
  return n;
}

/** Per-connection scratch (rate limit window, Drift stopwatch, first-push flag). */
function scratch(p) {
  if (!p.__prog || typeof p.__prog !== 'object') p.__prog = { w: 0, n: 0, driftAt: 0, greeted: 0 };
  return p.__prog;
}

function track(p) {
  if (!p || live.has(p)) return;
  live.add(p);
  if (live.size > 64) sweep();
}

/** Drop players whose socket has gone away; index.js owns their real lifetime. */
function sweep() {
  for (const p of live) {
    const state = p?.ws?.readyState;
    if (state !== undefined && state !== 0 && state !== 1) live.delete(p);
  }
}

// ---------------------------------------------------------------------------
// board + album payloads
// ---------------------------------------------------------------------------

/** The stable per-account seed key: the board must survive a reconnect. */
const seedKey = (rec) => String(rec?.username || 'capy').toLowerCase();

/** Refresh the board if the calendar day turned over (or it was never built). */
function ensureBoard(pr, key, day) {
  if (pr.day === day && pr.q.length === DAILY_COUNT) return false;
  pr.day = day;
  pr.q = pickDaily(key, day);
  pr.bonus = 0;
  return true;
}

function questPayload(rec, day) {
  // Guests: the board is real and visible (same one for everyone) but nothing
  // tracks, because there is no account to track it on. Conversion hook, per
  // section D: "sign up to take on quests".
  const locked = !rec;
  const pr = rec ? progFor(rec) : null;
  let entries;
  if (pr) {
    ensureBoard(pr, seedKey(rec), day);
    entries = pr.q;
  } else {
    entries = pickDaily('guest', day);
  }
  const quests = entries.map((e) => {
    const q = QUEST_BY_ID.get(e.id);
    const need = q.count || 1;
    return {
      id: q.id, name: q.name, desc: q.desc, kind: q.kind || 'world',
      // `count`/`n` are this module's names; `target`/`progress` are what the
      // board UI (src/ui/quests.js) reads first. Same numbers, both spellings,
      // so neither side has to guess.
      count: need, target: need, coins: q.coins || 0, reward: q.coins || 0,
      n: locked ? 0 : Math.min(e.n, need),
      progress: locked ? 0 : Math.min(e.n, need),
      done: locked ? 0 : e.done,
    };
  });
  const ends = dayEnds();
  return {
    t: 'quests',
    day,
    ends,
    // seconds to the next America/New_York midnight (up to a full day now that
    // the board is a real daily; the client's own cove-clock guess is a
    // 40-minute number and must not be allowed to win)
    resetIn: Math.max(0, Math.round((ends - now()) / 1000)),
    dayLength: DAY_MS,
    locked,
    quests,
    bonus: { coins: ALL_THREE_BONUS, reward: ALL_THREE_BONUS, done: !locked && !!pr.bonus },
    done: quests.filter((q) => q.done).length,
    // the login streak rides the board frame rather than a new one; guests see
    // the shape with zeros, exactly like their locked quest rows
    streak: pr ? streakPayload(pr) : { days: 0, show: 0, plus: false, best: 0, gift: STREAK_GIFTS[0], next: STREAK_GIFTS[0], claimed: false },
  };
}

/**
 * The album. `stamps` carries EARNED ids only, as {id: earnedAt}: the names and
 * requirement lines come from shared STAMPS, which both sides import, and the
 * card UI treats every id present in this frame as earned. `forId` keys the
 * frame when it answers a question about somebody else's card.
 */
function albumPayload(rec, forId = null) {
  const locked = !rec && !forId;
  const pr = rec ? progFor(rec) : null;
  const earned = {};
  if (pr) for (const s of STAMPS) if (own(pr.stamps, s.id)) earned[s.id] = num(pr.stamps[s.id]);
  const total = Object.keys(earned).length;
  const msg = {
    t: 'stamps',
    locked,
    total,
    of: STAMPS.length,
    stamps: earned,
    earned: Object.keys(earned),
    milestones: MILESTONES.map((m) => ({
      stamps: m.stamps, at: m.stamps, name: m.name, kind: m.kind,
      reward: m.reward, got: total >= m.stamps,
    })),
    title: rec && typeof rec.title === 'string' ? rec.title : '',
  };
  // the unlocked palette is only ever the viewer's own business
  if (forId) msg.id = forId;
  else msg.colors = rec && Array.isArray(rec.unlockedColors) ? [...rec.unlockedColors] : [];
  return msg;
}

function sendBoard(p, rec) {
  ctx.sendTo(p, questPayload(rec, today()));
}

function sendAlbum(p, rec, forId = null) {
  ctx.sendTo(p, albumPayload(rec, forId));
}

/** The account behind another live connection, for "show me their album". */
function recById(id) {
  for (const other of live) if (other && other.id === id) return recFor(other);
  return null;
}

// ---------------------------------------------------------------------------
// stamps
// ---------------------------------------------------------------------------

/**
 * One predicate per stamp id, over the persisted counters (`c`) and the record
 * itself. Keep these cheap: the whole table is evaluated after every signal.
 * `install()` warns at boot about any STAMPS entry missing from here.
 */
const RULES = {
  // getting around
  first_hello: (c) => c.chats >= 1,
  explorer: (c) => c.rooms.length >= 5,
  globetrotter: (c) => c.rooms.length >= FIXED_ROOMS.size,
  regular: (c) => c.days >= 7,
  veteran: (c) => c.days >= 30,
  night_owl: (c) => !!c.aurora,
  // the drift
  deep_breath: (c) => c.driftMs >= 600_000,
  whale_rider: (c) => c.whale >= 1,
  pod: (c) => c.whaleMax >= 4,
  bottler: (c) => c.bottles >= 1,
  beachcomber: (c) => c.bottles >= 3,
  // minigames (thresholds are on SERVER-PAID coins, never a reported score)
  angler: (c) => num(c.mc.fishing) >= 40,
  reel_master: (c) => num(c.mc.fishing) >= 90,
  downhill: (c) => num(c.byGame.sled) >= 1,
  speed_demon: (c) => num(c.mc.sled) >= 100,
  barista: (c) => num(c.mc.smoothie) >= 60,
  shift_lead: (c) => num(c.byGame.smoothie) >= 10,
  all_rounder: (c) => c.runs >= 50,
  racer: (c) => c.races >= 1,
  photo_finish: (c) => c.raceWins >= 1,
  hat_trick: (c) => c.raceWins >= 3,
  hider: (c) => num(c.byGame.prophunt) >= 3,
  doodler: (c) => c.doodles >= 10,
  prospector: (c) => c.digs >= 25,
  gem_hunter: (c) => c.gems >= 1,
  motherlode: (c) => c.gems >= 5,
  // the game den
  duelist: (c) => c.wins >= 1,
  // needs an optional {sweep:true} on the 'match-win' signal; until a den game
  // reports a shutout this one simply stays unearned (see the >40 stamps note
  // in shared/constants.js)
  sweep: (c) => c.sweeps >= 1,
  grandmaster: (c) => num(c.winsBy.chess) >= 1,
  card_shark: (c) => num(c.winsBy.cards) >= 5,
  paddle_pro: (c) => num(c.winsBy.pong) >= 5,
  four_up: (c) => num(c.winsBy.connect4) >= 1,
  shuffler: (c) => num(c.winsBy.shuffle) >= 1,
  den_regular: (c) => c.wins >= 10,
  // the social cove
  first_dab: (c) => c.mural >= 1,
  muralist: (c) => c.mural >= 50,
  cove_painter: (c) => c.mural >= 250,
  party_planner: (c) => c.hosted >= 1,
  host_most: (c) => c.maxGuests >= 5,
  party_animal: (c) => c.attended >= 3,
  socialite: (c) => c.waves >= 25,
  chatterbox: (c) => c.chats >= 100,
  snow_fight: (c) => c.snow >= 25,
  volley: (c) => c.ball >= 50,
  toasty: (c) => c.bonfire >= 10,
  // the long game
  quester: (c) => c.questsDone >= 1,
  clean_sweep: (c) => c.questDays >= 1,
  devoted: (c) => c.questDays >= 5,
  collector: (_c, rec) => (Array.isArray(rec.ownedHats) ? rec.ownedHats.filter((h) => h !== 'none').length : 0) >= 5,
  decorator: (_c, rec) => (Array.isArray(rec?.house?.furniture) ? rec.house.furniture.length : 0) >= 10,
};

/** Counters are sparse in the record; reading through this fills the blanks. */
function counters(pr) {
  const c = pr.c;
  const keys = ['chats', 'waves', 'mural', 'digs', 'gems', 'runs', 'wins', 'races',
    'raceWins', 'sweeps', 'doodles', 'hosted', 'attended', 'maxGuests', 'snow',
    'ball', 'bonfire', 'whale', 'whaleMax', 'bottles', 'driftMs', 'days',
    'questsDone', 'questDays',
    // wave 12: login streak. `streak` is the live run, `bestStreak` is the
    // high-water mark that never goes down, `gifted` is lifetime gift coins.
    'streak', 'bestStreak', 'gifted'];
  for (const k of keys) if (!Number.isFinite(c[k])) c[k] = 0;
  // day keys are strings ('YYYY-MM-DD', America/New_York); anything else in the
  // record is treated as "not today", which at worst gives one extra gift
  if (typeof c.lastDate !== 'string') c.lastDate = '';
  if (typeof c.giftDate !== 'string') c.giftDate = '';
  return c;
}

/** Idempotent by construction: an id already in the record returns false. */
function award(p, rec, pr, id) {
  if (!STAMP_BY_ID.has(id) || own(pr.stamps, id)) return false;
  pr.stamps[id] = now();
  const s = STAMP_BY_ID.get(id);
  const total = stampCount(pr);
  if (p) {
    ctx.sendTo(p, {
      t: 'stamp', id: s.id, name: s.name, desc: s.desc, how: s.how,
      total, of: STAMPS.length, fanfare: true,
    });
  }
  checkMilestones(p, rec, pr, total);
  return true;
}

function checkStamps(p, rec, pr) {
  const c = counters(pr);
  let earned = 0;
  for (const s of STAMPS) {
    if (own(pr.stamps, s.id)) continue;
    const rule = own(RULES, s.id) ? RULES[s.id] : null;
    if (!rule) continue;
    let hit = false;
    try { hit = !!rule(c, rec); } catch { hit = false; }
    if (hit && award(p, rec, pr, s.id)) earned++;
  }
  return earned;
}

/** Award a stamp to a live player by id (used by tick for the aurora). */
function awardTo(p, id) {
  const rec = recFor(p);
  if (!rec) return;
  const pr = progFor(rec);
  if (own(pr.stamps, id)) return;
  if (award(p, rec, pr, id)) ctx.saveSoon();
}

// ---------------------------------------------------------------------------
// milestones
// ---------------------------------------------------------------------------

function checkMilestones(p, rec, pr, total) {
  let granted = false;
  while (pr.mile < MILESTONES.length && total >= MILESTONES[pr.mile].stamps) {
    const m = MILESTONES[pr.mile++];
    grantReward(p, rec, m.reward);
    if (p) {
      ctx.sendTo(p, { t: 'toast', msg: `${m.stamps} stamps! ${m.reward?.name || 'Reward'} unlocked` });
    }
    granted = true;
  }
  if (granted && p) sendAlbum(p, rec); // full album + the new milestone flags
  if (granted) ctx.saveSoon();
}

/**
 * Milestone cosmetics are granted straight onto the record and mirrored to the
 * live connection through the frames the client already understands, so no
 * client change is needed for the item to appear in the wardrobe/den.
 */
function grantReward(p, rec, reward) {
  if (!reward || typeof reward !== 'object') return;
  const id = reward.id;
  if (reward.type === 'hat' && typeof id === 'string') {
    const hats = Array.isArray(rec.ownedHats) ? rec.ownedHats : (rec.ownedHats = ['none']);
    if (!hats.includes(id)) hats.push(id);
    if (p) {
      p.ownedHats = [...hats];
      // no `bought` field: the hat lands in the wardrobe without yanking the
      // player's current look off their head
      ctx.sendTo(p, { t: 'shop', ok: true, coins: num(rec.coins), delta: 0, ownedHats: [...hats] });
    }
  } else if (reward.type === 'trail' && typeof id === 'string') {
    // the flourish slot mirrors the hat arm exactly: into the wardrobe, never
    // auto-equipped, announced on the same 'shop' frame the client already has
    const trails = Array.isArray(rec.ownedTrails) ? rec.ownedTrails : (rec.ownedTrails = ['none']);
    if (!trails.includes(id)) trails.push(id);
    if (p) {
      p.ownedTrails = [...trails];
      ctx.sendTo(p, { t: 'shop', ok: true, coins: num(rec.coins), delta: 0, ownedTrails: [...trails] });
    }
  } else if (reward.type === 'furniture' && typeof id === 'string') {
    const inv = ensureOwnedFurniture(rec);
    inv[id] = Math.max(1, Math.floor(num(inv[id])) + 1);
    if (p) ctx.sendTo(p, { t: 'furn', ok: true, coins: num(rec.coins), delta: 0, ownedFurniture: { ...inv } });
  } else if (reward.type === 'color') {
    const col = Math.max(0, Math.min(0xffffff, Math.floor(num(id))));
    if (!Array.isArray(rec.unlockedColors)) rec.unlockedColors = [];
    if (!rec.unlockedColors.includes(col)) rec.unlockedColors.push(col);
  } else if (reward.type === 'title') {
    rec.title = String(reward.name || id || '').slice(0, 32);
    // index.js caches the title on the connection (snapshotFor puts it on the
    // world name tag), so the live session has to be told too or the tag would
    // not change until the next login
    if (p) p.title = rec.title;
  }
}

// ---------------------------------------------------------------------------
// counters + quest progress, driven by signals
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// login streak + the daily gift (N-26)
// ---------------------------------------------------------------------------

/**
 * The ramp. Day 1 pays before you have done anything, because the gift is a
 * hello, not a wage. Seven days is the top of the ladder and it STAYS there:
 * day 30 pays the same 120 as day 7, so nobody is ever farming a login.
 */
export const STREAK_GIFTS = [25, 35, 50, 65, 80, 100, 120];
/** Displayed streak tops out here ("day 7+"); the count itself keeps going. */
export const STREAK_CAP = STREAK_GIFTS.length;

/** What a given streak day is worth. Clamped both ends; never returns 0. */
export function giftFor(streak) {
  const n = Math.max(1, Math.floor(Number(streak) || 1));
  return STREAK_GIFTS[Math.min(n, STREAK_CAP) - 1];
}

/**
 * The streak after showing up at `ms`, given the previous streak and the last
 * day key seen.
 *
 * OWNER'S LAW, the whole reason this function is three lines and not thirty:
 * a missed day starts the ramp OVER, it does not take anything away. Coins
 * already granted are granted, `bestStreak` is a high-water mark that only ever
 * goes up, and `days` (the Regular/Veteran stamps) counts every day you ever
 * played and can never go down. Coming back after a month is a welcome, not a
 * penalty screen.
 */
export function nextStreak(prev, lastKey, ms = now()) {
  const p = Math.max(0, Math.floor(Number(prev) || 0));
  const key = dayKey(ms);
  if (lastKey === key) return Math.max(1, p); // already counted today
  // Yesterday: climb. `Math.max(1, p)` reads a missing or nonsense streak as
  // "they were here yesterday, so that was at least day 1", which is how a
  // record written before this wave (lastDate but no streak) lands on day 2
  // instead of being quietly knocked back to day 1. Round up, always.
  if (lastKey && lastKey === prevDayKey(ms)) return Math.max(1, p) + 1;
  return 1; // first day ever, or a gap: start the ramp again
}

/**
 * Real calendar days played, in America/New_York (the "Regular"/"Veteran"
 * stamps mean real days), plus the login streak that rides the same key.
 * Returns true when this is the first touch of a new day.
 */
function touchDate(c) {
  const at = now();
  const key = dayKey(at);
  if (c.lastDate === key) return false;
  const streak = nextStreak(c.streak, c.lastDate, at);
  c.lastDate = key;
  c.days += 1;
  c.streak = streak;
  c.bestStreak = Math.max(Math.floor(num(c.bestStreak)), streak); // never shrinks
  return true;
}

/** The streak block that rides the existing 'quests' frame. */
function streakPayload(pr) {
  const c = counters(pr);
  const n = Math.max(1, Math.floor(num(c.streak)) || 1);
  return {
    days: n,
    show: Math.min(n, STREAK_CAP),
    plus: n > STREAK_CAP,
    best: Math.max(Math.floor(num(c.bestStreak)), n),
    gift: giftFor(n),
    next: giftFor(n + 1),
    claimed: c.giftDate === dayKey(now()),
  };
}

/** The warm line. Never mentions what a gap cost, because it cost nothing. */
function giftMessage(streak, coins, firstEver) {
  if (firstEver) return `Welcome to the cove! Here are ${coins} coins to get you started.`;
  if (streak <= 1) return `Welcome back! Lovely to see you. Here are ${coins} coins.`;
  if (streak < STREAK_CAP) return `Day ${streak} in a row! Here are ${coins} coins.`;
  if (streak === STREAK_CAP) return `A whole week in a row! Here are ${coins} coins.`;
  return `${streak} days running! Here are ${coins} coins.`;
}

/**
 * Pay today's gift, once per real day, through the EXISTING frames: ctx.grantCoins
 * sends {t:'coins'} itself and the warm line rides {t:'toast'}. No new frame,
 * and no claim button to forget: showing up IS the claim.
 *
 * If the hourly backstop refuses the payout (a player already at the ceiling),
 * `giftDate` is deliberately left unset so the gift is still waiting on their
 * next connect. A gift is never lost to a rate limit.
 */
function dailyGift(p, rec, pr) {
  const c = counters(pr);
  const key = dayKey(now());
  if (c.giftDate === key) return 0;
  const streak = Math.max(1, Math.floor(num(c.streak)) || 1);
  const coins = giftFor(streak);
  const paid = ctx.grantCoins(p, coins, 'daily gift');
  if (paid <= 0) return 0;
  c.giftDate = key;
  c.gifted = Math.floor(num(c.gifted)) + paid; // lifetime total, only ever grows
  ctx.sendTo(p, { t: 'toast', msg: giftMessage(streak, paid, num(c.days) <= 1) });
  return paid;
}

/** Fold an in-progress Drift stay into the total; safe to call at any time. */
function accrueDrift(p, at) {
  const s = scratch(p);
  const inDrift = p.room === 'drift';
  if (inDrift && !s.driftAt) { s.driftAt = at; return 0; }
  if (!s.driftAt) return 0;
  const add = Math.max(0, Math.min(at - s.driftAt, 10 * 60_000));
  if (inDrift && add < DRIFT_FLUSH_MS) return 0;
  s.driftAt = inDrift ? at : 0;
  if (add <= 0) return 0;
  const rec = recFor(p);
  if (!rec) return 0;
  const pr = progFor(rec);
  counters(pr).driftMs += add;
  checkStamps(p, rec, pr);
  return add;
}

function bumpCounters(name, c, data, p) {
  const d = data && typeof data === 'object' ? data : {};
  switch (name) {
    case 'score': {
      c.runs += 1;
      const g = typeof d.game === 'string' ? d.game : '';
      if (g) {
        c.byGame[g] = Math.floor(num(c.byGame[g])) + 1;
        c.mc[g] = Math.max(num(c.mc[g]), Math.floor(num(d.coins)));
      }
      break;
    }
    case 'match-win': {
      c.wins += 1;
      const g = typeof d.game === 'string' ? d.game : '';
      if (g) c.winsBy[g] = Math.floor(num(c.winsBy[g])) + 1;
      if (d.sweep) c.sweeps += 1;
      break;
    }
    case 'race-done':
      c.races += 1;
      if (Math.floor(num(d.placed)) === 1) c.raceWins += 1;
      break;
    case 'dig':
      c.digs += 1;
      if (d.gem) c.gems += 1;
      break;
    case 'party-host':
      c.hosted += 1;
      c.maxGuests = Math.max(c.maxGuests, Math.floor(num(d.count)));
      break;
    case 'party-attend': c.attended += 1; break;
    case 'mural-pixel': c.mural += 1; break;
    case 'chat': c.chats += 1; break;
    case 'wave': c.waves += 1; break;
    case 'doodle-correct': c.doodles += 1; break;
    case 'bottle': c.bottles += 1; break;
    case 'snow': c.snow += 1; break;
    case 'ball': c.ball += 1; break;
    case 'bonfire': c.bonfire += 1; break;
    case 'whale-ride':
      c.whale += 1;
      c.whaleMax = Math.max(c.whaleMax, Math.max(1, Math.floor(num(d.riders))));
      break;
    case 'room': {
      const r = typeof d.room === 'string' ? d.room : p?.room;
      // dens are excluded on purpose: hopping between friends' houses is not a
      // tour of the cove, and it would be trivially farmable
      if (typeof r === 'string' && FIXED_ROOMS.has(r) && !c.rooms.includes(r) && c.rooms.length < MAX_ROOMS_TRACKED) {
        c.rooms.push(r);
      }
      break;
    }
    default: break;
  }
}

/** Does this signal payload satisfy the quest's optional filters? */
function matches(q, data) {
  const d = data && typeof data === 'object' ? data : {};
  if (q.game && d.game !== q.game) return false;
  if (Number.isFinite(q.minCoins) && !(num(d.coins) >= q.minCoins)) return false;
  if (Number.isFinite(q.place)) {
    const placed = Math.floor(num(d.placed));
    if (!(placed >= 1 && placed <= q.place)) return false;
  }
  if (Number.isFinite(q.riders) && !(num(d.riders) >= q.riders)) return false;
  if (q.room && d.room !== q.room) return false;
  if (q.flag && !(own(d, q.flag) && d[q.flag])) return false;
  return true;
}

/** The distinct-value key for a 'visit five rooms'-style quest. */
function distinctKey(q, data, p) {
  const d = data && typeof data === 'object' ? data : {};
  if (q.signal === 'room') {
    const r = typeof d.room === 'string' ? d.room : p?.room;
    return typeof r === 'string' && FIXED_ROOMS.has(r) ? r : '';
  }
  if (typeof d.game === 'string') return d.game;
  return '';
}

function advanceQuests(p, rec, pr, name, data) {
  let finished = 0;
  for (const e of pr.q) {
    const q = QUEST_BY_ID.get(e.id);
    if (!q || e.done || q.signal !== name || !matches(q, data)) continue;
    if (q.distinct) {
      const key = distinctKey(q, data, p);
      if (!key || e.seen.includes(key)) continue;
      e.seen.push(key);
      e.n = e.seen.length;
    } else {
      e.n += 1;
    }
    const need = Math.max(1, Math.floor(num(q.count)) || 1);
    if (e.n < need) continue;
    e.n = need;
    e.done = 1;
    finished++;
    const paid = ctx.grantCoins(p, q.coins, q.name);
    counters(pr).questsDone += 1;
    ctx.sendTo(p, {
      t: 'quest-done', id: q.id, name: q.name, desc: q.desc,
      coins: paid, of: pr.q.length, fanfare: true,
    });
  }
  if (!finished) return 0;
  if (!pr.bonus && pr.q.length === DAILY_COUNT && pr.q.every((e) => e.done)) {
    pr.bonus = 1;
    counters(pr).questDays += 1;
    const paid = ctx.grantCoins(p, ALL_THREE_BONUS, 'all three dailies');
    ctx.sendTo(p, {
      t: 'quest-done', id: 'all', name: 'All three dailies!',
      desc: 'The whole board, cleared.', coins: paid, all: true, fanfare: true,
    });
  }
  sendBoard(p, rec); // the board the player is staring at, freshly ticked
  return finished;
}

// ---------------------------------------------------------------------------
// contract entry points
// ---------------------------------------------------------------------------

export function handleMessage(p, m) {
  if (!ctx || !p || !m || typeof m.t !== 'string') return false;
  try {
    track(p);
    // a board read answers itself a line later: no need to push one first
    greet(p, m.t !== 'quests');
    if (m.t !== 'quests' && m.t !== 'stamps') return false;
    // consumed either way: an over-eager UI must not be able to turn one socket
    // into a board-rebuild pump
    const s = scratch(p);
    const at = now();
    if (at - s.w > 1000) { s.w = at; s.n = 0; }
    if (++s.n > READ_BURST) return true;
    const rec = recFor(p);
    if (m.t === 'quests') {
      sendBoard(p, rec);
    } else {
      // the player card asks about the capy it is showing: {t:'stamps', id}.
      // An album is public (that is the whole point of showing one off), but an
      // unknown or offline id gets an empty keyed frame, never someone else's.
      const who = typeof m.id === 'string' && m.id && m.id !== p.id ? m.id : null;
      sendAlbum(p, who ? recById(who) : rec, who);
    }
    if (rec) ctx.saveSoon(); // ensureBoard may have rolled the day over
    return true;
  } catch (e) {
    console.error('[progress] handleMessage failed:', e?.message || e);
    return false;
  }
}

/**
 * First frame from a connection: count the day played and hand over the board
 * unprompted, so a client that never asks still gets one (index.js sends
 * 'welcome' itself and this module may not edit it).
 */
function greet(p, push = true) {
  const s = scratch(p);
  if (s.greeted) return;
  s.greeted = 1;
  try {
    const rec = recFor(p);
    if (rec) {
      const pr = progFor(rec);
      // order matters: count the day (which rolls the streak) BEFORE paying the
      // gift, so a returning player is paid for the day they just started
      touchDate(counters(pr));
      // the gift rides ctx.grantCoins ({t:'coins'}) + {t:'toast'}, both frames
      // the client has always understood, and lands before the board so the
      // board's `streak.claimed` is already true when it arrives
      dailyGift(p, rec, pr);
      if (push) sendBoard(p, rec);
      checkStamps(p, rec, pr);
      ctx.saveSoon();
    } else if (push) {
      sendBoard(p, rec);
    }
  } catch (e) {
    console.error('[progress] greet failed:', e?.message || e);
  }
}

export function signal(name, p, data) {
  if (!ctx || !p || typeof name !== 'string') return;
  try {
    const canon = own(ALIASES, name) ? ALIASES[name] : name;
    if (QUEST_SIGNALS.has(canon)) liveSignals.add(canon);
    track(p);
    const rec = recFor(p);
    // Guests: nothing to persist and nothing to pay. The board they see is
    // already flagged locked, so this is simply a no-op for them.
    if (!rec) return;
    const pr = progFor(rec);
    const c = counters(pr);
    if (touchDate(c)) dailyGift(p, rec, pr); // belt and braces if tick is not wired
    ensureBoard(pr, seedKey(rec), today());
    if (canon === 'room') accrueDrift(p, now());
    bumpCounters(canon, c, data, p);
    advanceQuests(p, rec, pr, canon, data);
    checkStamps(p, rec, pr);
    ctx.saveSoon();
  } catch (e) {
    console.error(`[progress] signal '${name}' failed:`, e?.message || e);
  }
}

export function tick(_dt, clock) {
  if (!ctx) return;
  try {
    sweep();
    const at = now();
    // NOTE (wave 12): the world clock is no longer consulted for the day. The
    // sky still turns every 40 minutes; the quest day is the real ET calendar
    // day. `clock` is still read for the aurora, which is a sky fact.
    const day = today();
    const rolled = day !== lastDay;
    lastDay = day;
    const auroraNow = !!(clock && clock.aurora);
    for (const p of live) {
      try {
        accrueDrift(p, at);
        // "Night owl: see the aurora": you have to actually be standing on the
        // peak while it is up, which is the only room that renders it
        if (auroraNow && p.room === AURORA_ROOM) awardTo(p, 'night_owl');
        if (rolled) {
          const rec = recFor(p);
          if (rec) {
            const pr = progFor(rec);
            // somebody who was already standing in the plaza at ET midnight has
            // absolutely shown up today: count the day, roll the streak, pay
            // the gift, exactly as a fresh connect would
            touchDate(counters(pr));
            dailyGift(p, rec, pr);
            ensureBoard(pr, seedKey(rec), day);
            checkStamps(p, rec, pr);
          }
          sendBoard(p, rec); // fresh dailies, unprompted
        }
      } catch (e) {
        console.error('[progress] tick(player) failed:', e?.message || e);
      }
    }
    if (rolled) ctx.saveSoon();
  } catch (e) {
    console.error('[progress] tick failed:', e?.message || e);
  }
}
