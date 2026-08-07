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
 *    can roll over on the cove-day boundary.
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
 *   server -> client : {t:'quests', day, locked, ends, bonus, quests[]}
 *                      {t:'quest-done', id, name, coins, all?, fanfare}
 *                      {t:'stamp', id, name, desc, how, total, of, fanfare}
 *                      {t:'stamps', ...album, milestones[], title, colors}
 *   Milestone grants reuse the EXISTING inventory frames so the client stays in
 *   sync with no new plumbing: {t:'shop', ok:true, ownedHats} for hats (no
 *   `bought` field, so nothing is auto-equipped) and {t:'furn', ok:true,
 *   ownedFurniture} for furniture, plus a {t:'toast'}.
 *
 * Robustness: index.js may call tick()/signal() from a later wiring pass, or
 * never. Nothing here depends on tick running: the cove-day rollover is also
 * checked lazily whenever a board is touched, so a server whose tick is not
 * wired still hands out correct dailies (it just cannot push the new board
 * unprompted). Every entry point is wrapped: a throw in progression must never
 * cost a player their frame.
 */

import { QUESTS, STAMPS, MILESTONES, ROOM_IDS } from '../shared/constants.js';
import { ensureOwnedFurniture } from './db.js';

// One cove day = 40 real minutes (docs/LIVING-COVE.md section A). The clock
// module owns the broadcast clock; this module only needs the DAY INDEX, so it
// derives it from the epoch (the same boundary a wall-clock-derived cove clock
// lands on) and prefers `clock.day` if the clock ever starts sending one.
// DEVIATION-adjacent note: the spec says "per cove-day", so the board rerolls
// every 40 minutes rather than every calendar day. At 3 quests x 30-60 coins
// + 50 bonus that is at most ~345 coins/hour, far under the 12k/hour backstop.
const COVE_DAY_MS = 40 * 60 * 1000;

const DAILY_COUNT = 3;
const ALL_THREE_BONUS = 50;
const READ_BURST = 6; // {t:'quests'}/{t:'stamps'} reads per second, per player
const DRIFT_FLUSH_MS = 15_000; // how often a Drift stay is folded into the total
const MAX_ROOMS_TRACKED = 32; // keeps the persisted record small
const AURORA_ROOM = 'peak'; // the only room that renders the ribbons

const QUEST_BY_ID = new Map(QUESTS.map((q) => [q.id, q]));
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
const QUEST_SIGNALS = new Set(QUESTS.map((q) => q.signal));
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
let lastDay = -1;

export function install(c) {
  ctx = c || null;
  lastDay = today();
  // A stamp with no rule can never be earned: shout about it once at boot
  // rather than silently shipping dead album art.
  const missing = STAMPS.filter((s) => !own(RULES, s.id)).map((s) => s.id);
  if (missing.length) console.warn('[progress] stamps with no rule:', missing.join(', '));
}

// ---------------------------------------------------------------------------
// day + seeded selection
// ---------------------------------------------------------------------------

/**
 * The current cove-day index. Epoch-derived by default (index.js's world clock
 * derives its own the same way, so the two agree before a single tick lands);
 * once tick() sees a clock frame it latches that clock's day, day length and
 * phase, and EVERYTHING (board seeds, rollover, payloads) follows those. That
 * way a board can never be built against one day and sent stamped with another,
 * and the clock's test hooks (COVE_DAY_MS / COVE_CLOCK_OFFSET_MS) move the
 * quest board with the sky instead of leaving it on wall-clock time.
 */
let clockDay = null;
let clockDayMs = null;
let clockT = null;
let clockTAt = 0;

const dayMs = () => (clockDayMs || COVE_DAY_MS);

function today() {
  return Number.isFinite(clockDay) ? clockDay : Math.floor(Date.now() / dayMs());
}

/** When the current cove-day ends, for the board's countdown. */
function dayEnds() {
  const span = dayMs();
  if (Number.isFinite(clockT)) {
    // exact even under a phase offset: the last clock frame is at most one
    // broadcast (10s) old, which no countdown will notice
    const now = Date.now();
    return now + Math.max(0, (1 - clockT) * span - (now - clockTAt));
  }
  return (Math.floor(Date.now() / span) + 1) * span;
}

/** Latch whatever the world clock chose to tell us. */
function readClock(clock) {
  if (!clock || typeof clock !== 'object') return;
  if (Number.isFinite(clock.day)) clockDay = Math.floor(clock.day);
  if (Number.isFinite(clock.dayMs) && clock.dayMs > 0) clockDayMs = clock.dayMs;
  if (Number.isFinite(clock.dayT) && clock.dayT >= 0 && clock.dayT < 1) {
    clockT = clock.dayT;
    clockTAt = Date.now();
  }
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
  const pool = QUESTS.filter((q) => liveSignals.has(q.signal));
  const usable = pool.length ? pool : QUESTS;
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
  if (!Number.isFinite(pr.day)) pr.day = -1;
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

/** Refresh the board if the cove-day turned over (or it was never built). */
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
    resetIn: Math.max(0, Math.round((ends - Date.now()) / 1000)), // seconds, for the countdown
    locked,
    quests,
    bonus: { coins: ALL_THREE_BONUS, reward: ALL_THREE_BONUS, done: !locked && !!pr.bonus },
    done: quests.filter((q) => q.done).length,
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
    'questsDone', 'questDays'];
  for (const k of keys) if (!Number.isFinite(c[k])) c[k] = 0;
  return c;
}

/** Idempotent by construction: an id already in the record returns false. */
function award(p, rec, pr, id) {
  if (!STAMP_BY_ID.has(id) || own(pr.stamps, id)) return false;
  pr.stamps[id] = Date.now();
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

/** Real calendar days played (the "Regular"/"Veteran" stamps mean real days). */
function touchDate(c) {
  const today = new Date().toISOString().slice(0, 10);
  if (c.lastDate !== today) { c.lastDate = today; c.days += 1; }
}

/** Fold an in-progress Drift stay into the total; safe to call at any time. */
function accrueDrift(p, now) {
  const s = scratch(p);
  const inDrift = p.room === 'drift';
  if (inDrift && !s.driftAt) { s.driftAt = now; return 0; }
  if (!s.driftAt) return 0;
  const add = Math.max(0, Math.min(now - s.driftAt, 10 * 60_000));
  if (inDrift && add < DRIFT_FLUSH_MS) return 0;
  s.driftAt = inDrift ? now : 0;
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
    const now = Date.now();
    if (now - s.w > 1000) { s.w = now; s.n = 0; }
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
    if (push) sendBoard(p, rec);
    if (rec) {
      const pr = progFor(rec);
      touchDate(counters(pr));
      checkStamps(p, rec, pr);
      ctx.saveSoon();
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
    touchDate(c);
    ensureBoard(pr, seedKey(rec), today());
    if (canon === 'room') accrueDrift(p, Date.now());
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
    const now = Date.now();
    readClock(clock);
    const day = today();
    const rolled = day !== lastDay;
    lastDay = day;
    const auroraNow = !!(clock && clock.aurora);
    for (const p of live) {
      try {
        accrueDrift(p, now);
        // "Night owl: see the aurora": you have to actually be standing on the
        // peak while it is up, which is the only room that renders it
        if (auroraNow && p.room === AURORA_ROOM) awardTo(p, 'night_owl');
        if (rolled) {
          const rec = recFor(p);
          if (rec) ensureBoard(progFor(rec), seedKey(rec), day);
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
