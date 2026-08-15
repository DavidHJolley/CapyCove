/**
 * server/courier.js - The Cove Courier, the island's weekly paper (wave 14A, N-31).
 *
 * One issue a week, printed on FRIDAY in America/New_York, assembled entirely
 * from things the island actually did. Nobody has to write it: the templates
 * carry the whole issue, and the evergreen filler table below means even a week
 * where every source module is missing still prints a warm, readable paper.
 *
 * THE RULE THIS MODULE BENDS AROUND (liveops.md 5.8): the print day is a fixed
 * point and never moves. A paper that prints "when there is enough news" trains
 * nothing. A quiet week gets a quiet issue, which is charming, and honest.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT WITH index.js (the install(ctx) shape charms.js/econ.js use)
 *
 *   courier.install({ sendTo, charms, stats, events, kart, now?, ... })
 *   courier.handleMessage(p, m)  first refusal; consumes 'courier' ONLY.
 *   courier.frameFor(p)          the current issue as a {t:'courier'} frame.
 *   courier.tick(ms?)            optional; assembles the issue promptly at
 *                                print time and returns {printed, week,
 *                                issueN, headline} the first time it does, so
 *                                the orchestrator may broadcast a 'courier-new'
 *                                if it wants one. Nothing here needs it.
 *
 * EVERY SOURCE IS OPTIONAL. A missing (or throwing, or nonsense-returning)
 * source drops exactly its own article and nothing else. There is no ctx field
 * whose absence can throw, and no article whose absence can empty an issue:
 * the filler count rises to cover the gap.
 *
 * FRAMES (add to the CLAUDE.md registry when the wave ships)
 *   client -> server
 *     {t:'courier'}                     read the current issue
 *   server -> client
 *     {t:'courier', week, issueN, headline, printedAt, nextPrintAt,
 *                   articles:[{k, h, body}]}
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (judgment calls marked DECISION)
 *
 * DECISION - the week is a REAL week in America/New_York and the arithmetic is
 * BORROWED, never reinvented: server/progress.js's dayKey()/dayStartMs() decide
 * where a day begins (DST, small-icu builds, the quest board's midnight), and
 * server/charms.js's weekKey()/weekIndex() decide which Monday-to-Monday week a
 * moment sits in. Those two are pure functions of their argument, which is why
 * they may be imported statically while every DATA source is injected.
 *
 * DECISION - print time is Friday 10:00 ET (PRINT_HOUR). The owner fixed the
 * DAY; the hour is this module's declared default, chosen so the paper is on
 * the board before anyone is home from school and hours before Friday's Golden
 * Hour. Override with install({printHour}) if the operator wants otherwise, but
 * change it ONCE and then never again.
 *
 * DECISION - an issue is assembled LAZILY, once, and cached in memory for as
 * long as the process lives. Read it on Friday and read it again on Sunday and
 * you get the same words. A regenerated issue that says something different is
 * worse than no issue at all (liveops.md 5.4). Nothing here touches disk: an
 * issue is cheap to rebuild from the same sources and a restart mid-week is
 * allowed to lose only the exact wording of a number, never a player's record.
 *
 * DECISION - NAMED CREDITS ARE FOR PRIDE ONLY. The only place a player's name
 * can reach print is the fastest kart lap of the week, which is a thing done
 * proudly in public. There is no worst-of anything, no shame list, no "least
 * active" and no "nobody found the charm" naming. Aggregates never name anyone.
 * Every name that does print is filtered and vetoable at RENDER time (ctx.clean
 * and ctx.nameOk), so a moderator action between the lap and the print cleans
 * an issue that has not been read yet (liveops.md 5.7).
 *
 * DECISION - the week's aggregate numbers are printed ONLY when the stats
 * module's live bucket is the same week the issue is about. The alternative is
 * an issue read on the following Tuesday quietly printing the new week's
 * three-day numbers as if they were last week's, which is not a rounding error,
 * it is a lie in print. When they do not match, the article is dropped and a
 * filler takes its place.
 *
 * KNOWN GAP, FLAGGED LOUDLY: server/charms.js has no exported per-week finder
 * count (its S.found tally is private and per-boot, and charms.stats() is a
 * lifetime counter). server/charms.js is not this agent's file, so nothing was
 * added there. The charm article therefore prints the charm and where it hid,
 * and prints the finder count only when somebody hands one over: install()
 * accepts `charmFinders(weekKey) -> number|null`, and a future
 * `charms.foundCount(weekKey)` export is picked up automatically.
 */

import { dayKey, dayStartMs } from './progress.js';
import { weekKey as charmWeekKey } from './charms.js';
import { MINIGAMES, ROOM_INFO } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** Print day: 5 = Friday (0 = Sunday, JS getUTCDay order). The owner's call. */
export const PRINT_DOW = 5;
/** Print hour, ET, on that day. See the DECISION note above. */
export const PRINT_HOUR = 10;
/** Issue 1: Friday 2026-08-14, the first Friday of the campaign. Issue numbers
 *  count Fridays from here and never restart. A server whose clock predates it
 *  prints issue 1 rather than issue -3. */
export const EPOCH_FRIDAY = '2026-08-14';
/** Reads per second, per player. A read is one cached object; this is a flood
 *  guard, not a rationing of the news. */
const READ_BURST = 3;
/** Issues kept in memory. Ten weeks of back numbers costs a few kilobytes and
 *  means a long-lived process never re-renders one it has already published. */
const CACHE_CAP = 10;
/** Filler pieces per issue: two on a full week, up to four when sections are
 *  missing. A quiet week gets a quiet issue, never a thin one. */
const FILLER_MIN = 2;
const FILLER_MAX = 4;
/** Articles the filler aims to bring an issue up to. Only ever an aim: with no
 *  sources at all an issue is FILLER_MAX pieces and reads perfectly well. */
const TARGET_ARTICLES = 6;
/** Longest body this module will emit. Nothing here approaches it; it is the
 *  wall between a source module's surprise and somebody's chat overlay. */
const BODY_MAX = 420;
const HEAD_MAX = 90;
/** Names are already length-limited by shared/constants.js NAME_MAX_LEN; this
 *  is the belt to that braces. */
const NAME_MAX = 24;

const DAY_MS = 86_400_000;

const own = (obj, key) => !!obj && typeof key === 'string'
  && Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------------------
// the evergreen table: 30 cozy filler pieces
// ---------------------------------------------------------------------------

/**
 * Tips, capybara facts and silly classifieds. Three per issue at most and the
 * walk through the table is a coprime stride (FILLER_STRIDE), so the whole
 * table is used before anything repeats: at three a week that is ten weeks of
 * paper with no piece printed twice.
 *
 * House style (DESIGN.md 91-93): warm, a little silly, takes shuffleboard
 * results extremely seriously. Nothing here is a chore, a deadline or a nudge
 * to play more. Adding a piece: append it, keep FILLER_STRIDE coprime with the
 * new length, and keep it all-ages.
 */
export const FILLERS = Object.freeze([
  { id: 'tip-float', h: 'Tip of the week', body: 'A capybara at rest floats. A capybara in a hurry also floats, just less gracefully. Either way you get there.' },
  { id: 'fact-teeth', h: 'Did you know', body: 'Capybara teeth never stop growing, which is why we are all so enthusiastic about crunchy things. The Smoothie Shack would like it noted that straws do not count.' },
  { id: 'ad-mitten', h: 'Classifieds', body: 'FOUND: one red mitten, up the mountain. The owner may collect it from the lodge, where it is currently employed as a very small draught excluder.' },
  { id: 'tip-bench', h: 'Tip of the week', body: 'Sitting on a bench beside somebody you have never met is a perfectly good conversation. You may both simply sit. This is allowed.' },
  { id: 'fact-swim', h: 'Did you know', body: 'A capybara can hold its breath for about five minutes. The Drift will not test you on this, and Big Blue has never once been in a rush.' },
  { id: 'ad-cocoa', h: 'Classifieds', body: 'WANTED: someone to share the second armchair by the fire in the Trophy Loft. Must tolerate chess commentary. Cocoa provided, opinions optional.' },
  { id: 'tip-doodle', h: 'Tip of the week', body: 'In Capy Doodles, a wobbly circle drawn with great confidence beats a perfect drawing every time. The guessers can feel your conviction.' },
  { id: 'fact-friends', h: 'Did you know', body: 'Capybaras get on with almost everybody. Birds, turtles, ducks, that one gull on the dock. The cove considers this our finest quality.' },
  { id: 'ad-sled', h: 'Classifieds', body: 'FOR SWAP: a sled with a slight leftward personality. Steers beautifully if you also want to go left. Enquire at the sled rack.' },
  { id: 'tip-mural', h: 'Tip of the week', body: 'On the plaza mural, one pixel is a contribution. Nobody has ever painted the whole thing alone and nobody is meant to.' },
  { id: 'fact-nap', h: 'Did you know', body: 'A capybara nap is not idleness, it is scheduled maintenance. The cove supports this fully and has provided benches accordingly.' },
  { id: 'ad-hat', h: 'Classifieds', body: 'LOST: a hat, described only as "the good one". If you are wearing a hat and feel unusually pleased about it, please check.' },
  { id: 'tip-lobby', h: 'Tip of the week', body: 'A race lobby with one capy in it is a lonely thing. Standing in it anyway is how it stops being one.' },
  { id: 'fact-voice', h: 'Did you know', body: 'Capybaras make purrs, clicks, whistles and one noise best described as a small squeaky door. All of them mean roughly "hello, this is nice".' },
  { id: 'ad-bottle', h: 'Classifieds', body: 'NOTICE: the tide keeps returning the same bottle to the same stretch of sand. The Courier considers this a friendship and has stopped asking questions.' },
  { id: 'tip-emote', h: 'Tip of the week', body: 'The wave emote works from surprisingly far away. Use it on somebody across the plaza and watch the cove get one notch friendlier.' },
  { id: 'fact-groom', h: 'Did you know', body: 'Capybaras groom each other, which is the origin of the traditional cove greeting: standing slightly too close and looking pleased about it.' },
  { id: 'ad-shuffle', h: 'Classifieds', body: 'SEEKING: a shuffleboard rival of roughly equal ability. Applicants who turn out to be secretly excellent will be found out by the second round and welcomed anyway.' },
  { id: 'tip-peak', h: 'Tip of the week', body: 'Cocoa at the top of Frosty Peak tastes better than cocoa at the bottom. This has been tested. The test was very enjoyable.' },
  { id: 'fact-toes', h: 'Did you know', body: 'Capybaras have webbed toes, four in front and three behind, which explains both the swimming and the distinctive sound of a capy running along a dock.' },
  { id: 'ad-den', h: 'Classifieds', body: 'OPEN HOUSE: several dens on the island are set to open, and their owners are quietly hoping somebody wanders in. Consider wandering in.' },
  { id: 'tip-snow', h: 'Tip of the week', body: 'A snowball thrown at a friend is a greeting. A snowball thrown at a friend who is holding cocoa is a declaration. Choose your moment.' },
  { id: 'fact-still', h: 'Did you know', body: 'A capybara can sit so still that other animals sit on it. The cove asks that you check before sitting down anywhere soft and warm.' },
  { id: 'ad-mine', h: 'Classifieds', body: 'MISSING FROM THE MINE: one lunch. Last seen in a lunch tin, in a tunnel, in the dark. Suspects: everyone. Investigation: not happening.' },
  { id: 'tip-fish', h: 'Tip of the week', body: 'In Reel Rush the small fish are worth taking. A steady stream of small ones beats waiting all afternoon for a big one, in fishing and in general.' },
  { id: 'fact-name', h: 'Did you know', body: 'The word capybara comes from a phrase meaning "one who eats slender leaves", which is a very polite way to describe our relationship with the salad garnish.' },
  { id: 'ad-chess', h: 'Classifieds', body: 'THE TROPHY LOFT reports that a chess game has been paused mid-move for some time. Both players insist they are thinking. The Courier believes them.' },
  { id: 'tip-jungle', h: 'Tip of the week', body: 'In the Tangle Jungle the best hiding place is usually the one everybody walks past. Be a very convincing pot. Do not blink.' },
  { id: 'fact-herd', h: 'Did you know', body: 'A group of capybaras is properly called a herd, though around here the preferred term is "everyone who happened to be at the fountain".' },
  { id: 'ad-kart', h: 'Classifieds', body: 'PADDOCK NOTICE: a spare spark plug has turned up again. It fits nothing at the Speedway. It is now a paperweight and, frankly, thriving.' },
]);

/** Coprime with FILLERS.length (30): the walk is a permutation, not a loop. */
const FILLER_STRIDE = 7;

/** Rotating masthead lines, used when nothing newsworthy earns the headline. */
const QUIET_HEADLINES = Object.freeze([
  'A quiet week, pleasantly spent',
  'Nothing much happened, beautifully',
  'The cove carries on, as it does',
  'Slow news week, excellent naps',
  'All calm on the island',
]);

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const S = {
  installed: false,
  now: () => Date.now(),
  printHour: PRINT_HOUR,
  sendTo: () => {},
  logFn: (msg, err) => console.warn(`[courier] ${msg}`, err?.message || err || ''),
  // sources, all optional, all duck-typed at call time
  src: { charms: null, stats: null, events: null, kart: null },
  charmFinders: null,
  editorial: null,
  clean: null,
  nameOk: null,
  /** issue key ('YYYY-MM-DD' of the printing Friday) -> frozen issue */
  cache: new Map(),
  /** the last issue key tick() has seen, so a print is announced once */
  lastPrinted: '',
  /** player -> { n, at } */
  rate: new WeakMap(),
  stats: null,
};

function blankStats() {
  return { reads: 0, refusedRate: 0, issues: 0, errors: 0, dropped: 0 };
}
S.stats = blankStats();

/**
 * Boot. Safe to call twice (the tests do). Every field is optional.
 *
 *   sendTo(p, frame)          how a frame reaches one player
 *   charms / stats / events / kart
 *                             the source MODULES (namespace objects are fine).
 *                             Only pure reads are ever called on them.
 *   charmFinders(weekKey)     how many capys found that week's charm, or null.
 *                             See the KNOWN GAP note in the header.
 *   editorial(ctx)            optional {h, body} pinned to the top of an issue.
 *   clean(text)               server/filter.js, applied to every printed name
 *   nameOk(name)              false vetoes a named credit at RENDER time
 *   now() / printHour / log(msg, err)
 */
export function install(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  S.installed = true;
  S.now = typeof c.now === 'function' ? c.now : () => Date.now();
  S.sendTo = typeof c.sendTo === 'function' ? c.sendTo : () => {};
  if (typeof c.log === 'function') S.logFn = c.log;
  S.printHour = clampInt(c.printHour, 0, 23, PRINT_HOUR);
  S.src = {
    charms: c.charms && typeof c.charms === 'object' ? c.charms : null,
    stats: c.stats && typeof c.stats === 'object' ? c.stats : null,
    events: c.events && typeof c.events === 'object' ? c.events : null,
    kart: c.kart && typeof c.kart === 'object' ? c.kart : null,
  };
  S.charmFinders = typeof c.charmFinders === 'function' ? c.charmFinders : null;
  S.editorial = typeof c.editorial === 'function' ? c.editorial : null;
  S.clean = typeof c.clean === 'function' ? c.clean : null;
  S.nameOk = typeof c.nameOk === 'function' ? c.nameOk : null;
  S.cache = new Map();
  S.lastPrinted = '';
  S.rate = new WeakMap();
  S.stats = blankStats();
  return S;
}

/** Counters for /api/health and the tests. */
export function stats() {
  return { ...S.stats, installed: S.installed, cached: S.cache.size, issue: S.lastPrinted };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/**
 * Any source value that claims to be a count, made safe to print. ABSENT is
 * null, never 0: Number(null) is 0, and an issue with no finder data was
 * printing "Nobody turned it up" as fact on the default production path.
 */
function count(v) {
  if (v == null || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
}

/** One line of printable text: control characters out, whitespace collapsed. */
function text(v, max = BODY_MAX) {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}...` : s;
}

/** 1204 -> '1,204'. No Intl: small-icu builds are a supported target. */
function num(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/** 'YYYY-MM-DD' -> whole days since the epoch. Timezone-free by this point. */
function dayIndexOf(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}

/** 'YYYY-MM-DD' -> 0 (Sunday) .. 6 (Saturday). */
function dowOf(key) {
  const idx = dayIndexOf(key);
  return idx === null ? null : ((idx + 4) % 7 + 7) % 7; // 1970-01-01 was a Thursday
}

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/** 'Friday at 8pm' for an instant, in cove time. Never guesses an offset: the
 *  day it belongs to is asked for, and the hour is measured from that day's
 *  own start, so a DST Sunday cannot shift it. */
function whenWords(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at)) return '';
  const dk = dayKey(at);
  const dow = dowOf(dk);
  const start = dayStartMs(at);
  const mins = Math.max(0, Math.round((at - start) / 60_000));
  const h24 = Math.min(23, Math.floor(mins / 60));
  const mi = mins % 60;
  const ampm = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const clock = mi === 0 ? `${h12}${ampm}` : `${h12}.${String(mi).padStart(2, '0')}${ampm}`;
  const day = dow === null ? '' : WEEKDAYS[dow];
  return day ? `${day} at ${clock}` : `at ${clock}`;
}

/** A name is only ever printed if it survives BOTH the filter and the veto. */
function printableName(raw) {
  let n = text(raw, NAME_MAX);
  if (!n) return '';
  if (S.clean) {
    try { n = text(S.clean(n), NAME_MAX); } catch (e) { S.logFn('clean', e); return ''; }
  }
  if (!n) return '';
  if (S.nameOk) {
    try { if (!S.nameOk(n)) return ''; } catch (e) { S.logFn('nameOk', e); return ''; }
  }
  return n;
}

/** Every source call goes through here: a throw costs one article, never an
 *  issue, and never a frame. */
function ask(what, fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch (e) {
    S.stats.errors++;
    S.logFn(`source ${what}`, e);
    return dflt;
  }
}

/** A duck-typed method on an optional source module. */
function call(mod, name, ...args) {
  if (!mod || typeof mod[name] !== 'function') return null;
  return ask(name, () => mod[name](...args));
}

// ---------------------------------------------------------------------------
// the print calendar
// ---------------------------------------------------------------------------

/** Step back one whole cove day from the start of a day. DST-safe: midnight
 *  minus six hours is always yesterday, whichever way the clocks went. */
const prevDay = (dayStart) => dayStartMs(dayStart - 6 * 3_600_000);
/** ...and forward. 26 hours always lands inside the next day. */
const nextDay = (dayStart) => dayStartMs(dayStart + 26 * 3_600_000);

/** The instant the paper prints on the cove day that starts at `dayStart`. */
const printInstant = (dayStart) => dayStart + S.printHour * 3_600_000;

/**
 * The issue on the board at `ms`: the most recent Friday print instant at or
 * before it. Returns { key, at } where key is that Friday's ET day key.
 */
export function currentIssueAt(ms = S.now()) {
  let t = dayStartMs(ms);
  for (let i = 0; i < 9; i++) {
    const dk = dayKey(t);
    if (dowOf(dk) === PRINT_DOW) {
      const at = printInstant(t);
      if (at <= ms) return { key: dk, at };
    }
    t = prevDay(t);
  }
  // Unreachable: nine backward days always contain a Friday. Never throw here.
  const dk = dayKey(ms);
  return { key: dk, at: dayStartMs(ms) };
}

/** The next print instant strictly after `ms`. Starts the scan on the
 *  CURRENT day: between Friday midnight and the print hour, the next print
 *  is later today, not next week (the at > ms guard handles a passed one). */
export function nextPrintAt(ms = S.now()) {
  let t = dayStartMs(ms);
  for (let i = 0; i < 9; i++) {
    if (dowOf(dayKey(t)) === PRINT_DOW) {
      const at = printInstant(t);
      if (at > ms) return at;
    }
    t = nextDay(t);
  }
  return ms + 7 * DAY_MS; // never return something absurd
}

/** Issue number for a printing Friday's day key. Counts Fridays from the
 *  epoch and never restarts; a clock before the epoch prints issue 1. */
export function issueNumber(key) {
  const a = dayIndexOf(key);
  const b = dayIndexOf(EPOCH_FRIDAY);
  if (a === null || b === null) return 1;
  return Math.max(1, Math.floor((a - b) / 7) + 1);
}

// ---------------------------------------------------------------------------
// the articles
// ---------------------------------------------------------------------------

/**
 * Last week's charm. The charm the paper reports on is the one that was hiding
 * during the week that just closed, which is the week BEFORE the printing
 * Friday's week (charms move on Monday).
 */
function charmArticle(at, weekOfIssue) {
  const charms = S.src.charms;
  if (!charms) return null;
  const cur = call(charms, 'currentCharm', at - 7 * DAY_MS);
  if (!cur || typeof cur !== 'object') return null;
  const name = text(cur.name, 60);
  if (!name) return null;
  const where = text(cur.roomName, 40);
  const desc = text(cur.desc, 160);
  const week = text(cur.week, 12) || weekOfIssue;

  let finders = null;
  if (S.charmFinders) finders = count(ask('charmFinders', () => S.charmFinders(week)));
  if (finders === null) finders = count(call(charms, 'foundCount', week));

  const bits = [];
  bits.push(where
    ? `Last week's charm was the ${name}, and it spent the whole week over at ${where}.`
    : `Last week's charm was the ${name}.`);
  if (desc) bits.push(desc);
  if (finders !== null) {
    bits.push(finders === 0
      ? 'Nobody turned it up, which means it kept its own company all week and is now safely in the Courier archive.'
      : `${plural(finders, 'capy', 'capys')} found it. Every one of them is entitled to feel smug about it for a further seven days.`);
  }
  bits.push('A new charm is already hiding somewhere.');
  return { k: 'charm', h: `Last week's charm: the ${name}`, body: bits.join(' ') };
}

/**
 * The week in play: most-played minigame, busiest room, races run. Aggregates
 * ONLY. See the DECISION note about why a week mismatch drops this article.
 */
function playArticle(at) {
  const stats = S.src.stats;
  if (!stats) return null;
  const w = call(stats, 'week');
  if (!w || typeof w !== 'object') return null;

  // Is the live bucket the week this issue is about? stats.weekKey() takes an
  // ET day key and answers with its ISO week id, which is exactly the id the
  // bucket carries, so the two are compared in the module's own vocabulary.
  const wantWeek = call(stats, 'weekKey', dayKey(at));
  if (wantWeek && text(w.week, 16) && text(w.week, 16) !== text(wantWeek, 16)) {
    S.stats.dropped++;
    return null;
  }

  const bits = [];

  const games = w.games && typeof w.games === 'object' ? w.games : {};
  let topGame = '';
  let topRuns = 0;
  for (const id of Object.keys(games)) {
    if (!own(games, id)) continue;
    const runs = count(games[id]?.runs) || 0;
    if (runs > topRuns) { topRuns = runs; topGame = id; }
  }
  if (topGame && topRuns > 0) {
    const nice = own(MINIGAMES, topGame) ? MINIGAMES[topGame].name : topGame;
    bits.push(`${text(nice, 40)} was the island's favourite this week, with ${plural(topRuns, 'run', 'runs')} on the board.`);
  }

  const rooms = w.rooms && typeof w.rooms === 'object' ? w.rooms : {};
  let topRoom = '';
  let topJoins = 0;
  for (const id of Object.keys(rooms)) {
    if (!own(rooms, id)) continue;
    const n = count(rooms[id]) || 0;
    if (n > topJoins) { topJoins = n; topRoom = id; }
  }
  if (topRoom && topJoins > 0) {
    const nice = own(ROOM_INFO, topRoom) ? ROOM_INFO[topRoom].name : topRoom;
    bits.push(`${text(nice, 40)} was the busiest corner of the cove, with ${plural(topJoins, 'visit', 'visits')} through the door.`);
  }

  const races = (count(games.kart?.runs) || 0) + (count(games.sled?.runs) || 0);
  if (races > 0) {
    bits.push(`${plural(races, 'race', 'races')} were run down the mountain and around the Speedway. No capybara was hurried into anything.`);
  }

  if (!bits.length) return null;
  return { k: 'play', h: 'The week in play', body: bits.join(' ') };
}

/** The coming week, straight off the calendar. Cannot be wrong: it is a render
 *  of what the events module is already telling every client. */
function calendarArticle() {
  const events = S.src.events;
  if (!events) return null;
  const f = call(events, 'frame');
  if (!f || typeof f !== 'object') return null;

  const bits = [];
  const active = Array.isArray(f.active) ? f.active : [];
  const running = active
    .map((a) => text(a?.name, 40))
    .filter(Boolean)
    .slice(0, 3);
  if (running.length === 1) bits.push(`${running[0]} is on right now.`);
  else if (running.length > 1) bits.push(`On right now: ${running.join(', ')}.`);

  const next = f.next && typeof f.next === 'object' ? f.next : null;
  const nextName = next ? text(next.name, 40) : '';
  if (nextName) {
    const when = whenWords(next.startsAt);
    bits.push(when ? `Next up is ${nextName}, ${when}.` : `Next up is ${nextName}.`);
    const blurb = text(next.blurb, 140);
    if (blurb) bits.push(blurb);
  }

  if (!bits.length) return null;
  return { k: 'whatson', h: 'What is on', body: bits.join(' ') };
}

/**
 * The only named credit in the paper: the fastest kart lap of the week.
 *
 * FLAGGED: server/kart.js exposes no lap-record reader today (its bestLap lives
 * inside a live race and dies with it). This asks for one by duck typing, so
 * the day kart.js grows `weekRecord()` or `records()` returning
 * {name, ms|lapMs} the article lights up on its own, and until then the section
 * is simply absent. Nothing here was added to kart.js: it is not this file's.
 */
function lapArticle() {
  const kart = S.src.kart;
  if (!kart) return null;
  const rec = call(kart, 'weekRecord') || call(kart, 'records');
  const row = Array.isArray(rec) ? rec[0] : rec;
  if (!row || typeof row !== 'object') return null;

  const name = printableName(row.name);
  const ms = count(row.ms ?? row.lapMs ?? row.best);
  if (!name || !ms) return null;

  const secs = (ms / 1000).toFixed(2);
  return {
    k: 'lap',
    h: 'Fastest lap of the week',
    body: `${name} went round the Capy Speedway in ${secs} seconds, which is the quickest anybody managed all week. The Courier has no notes and one round of applause.`,
  };
}

/** The optional human sentence. Absent by default, and absent is fine. */
function editorialArticle(at, issueN) {
  if (!S.editorial) return null;
  const e = ask('editorial', () => S.editorial({ at, issueN }));
  if (!e || typeof e !== 'object') return null;
  const body = text(e.body);
  if (!body) return null;
  return { k: 'editorial', h: text(e.h, HEAD_MAX) || 'From the desk', body };
}

/** `n` evergreen pieces, walked by a coprime stride so the table is exhausted
 *  before anything repeats. Deterministic in the issue number. */
function fillerArticles(issueN, n) {
  const out = [];
  const len = FILLERS.length;
  const take = Math.max(0, Math.min(n, len));
  for (let k = 0; k < take; k++) {
    // Sequential slots are OPTIMAL here, not lazy: with 30 pieces at up to 4
    // per issue, the pigeonhole principle forces a repeat somewhere inside any
    // 8 consecutive issues, and plain sequence achieves the best possible
    // guarantee (no repeat within any 7 consecutive issues). The old coprime
    // stride only shuffled the collisions closer together.
    const g = (issueN - 1) * FILLER_MAX + k; // a stable global slot per issue
    const f = FILLERS[((g % len) + len) % len];
    out.push({ k: `filler:${f.id}`, h: f.h, body: f.body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the issue
// ---------------------------------------------------------------------------

function headlineFor(articles, issueN) {
  const play = articles.find((a) => a.k === 'play');
  const editorial = articles.find((a) => a.k === 'editorial');
  const charm = articles.find((a) => a.k === 'charm');
  const lap = articles.find((a) => a.k === 'lap');
  // Only an editorial earns the masthead verbatim; borrowing an article's own
  // headline printed the same line twice on the front page (the default path,
  // since no editorial ships by default). A warm rotating line reads better.
  if (editorial) return text(editorial.h, HEAD_MAX);
  void play; void charm; void lap;
  return QUIET_HEADLINES[(issueN - 1) % QUIET_HEADLINES.length];
}

/**
 * Assemble one issue. Pure with respect to the sources: called once per issue
 * key and then cached, so this is the only place the sources are read.
 */
function assemble(key, at) {
  const issueN = issueNumber(key);
  const week = charmWeekKey(at);
  const articles = [];

  const push = (a) => {
    if (!a) return;
    const body = text(a.body);
    const h = text(a.h, HEAD_MAX);
    if (!body || !h) return;
    articles.push({ k: String(a.k), h, body });
  };

  push(editorialArticle(at, issueN));
  push(charmArticle(at, week));
  push(playArticle(at));
  push(lapArticle());
  push(calendarArticle());

  const auto = articles.length;
  const fillers = Math.max(FILLER_MIN, Math.min(FILLER_MAX, TARGET_ARTICLES - auto));
  for (const f of fillerArticles(issueN, fillers)) push(f);

  const issue = Object.freeze({
    week,
    issueN,
    headline: headlineFor(articles, issueN),
    printedAt: at,
    nextPrintAt: nextPrintAt(at),
    articles: Object.freeze(articles.map((a) => Object.freeze(a))),
  });

  S.stats.issues++;
  return issue;
}

/**
 * The issue on the board right now. Assembled on first ask and then handed back
 * unchanged for as long as the process lives: the words a player read on Friday
 * are the words their friend reads on Sunday.
 */
export function issue(ms = S.now()) {
  const { key, at } = currentIssueAt(ms);
  const hit = S.cache.get(key);
  if (hit) return hit;
  let built;
  try {
    built = assemble(key, at);
  } catch (e) {
    // Belt and braces: every article already guards itself, so reaching here
    // means something structural. An empty-but-warm issue still prints.
    S.stats.errors++;
    S.logFn('assemble', e);
    built = Object.freeze({
      week: '', issueN: issueNumber(key), headline: QUIET_HEADLINES[0],
      printedAt: at, nextPrintAt: at + 7 * DAY_MS,
      articles: Object.freeze(fillerArticles(issueNumber(key), FILLER_MIN)
        .map((a) => Object.freeze({ k: String(a.k), h: a.h, body: a.body }))),
    });
  }
  S.cache.set(key, built);
  while (S.cache.size > CACHE_CAP) S.cache.delete(S.cache.keys().next().value);
  // Only ever forwards: reading a back issue must not make tick() announce an
  // old paper as new. Issue keys are ISO dates, so this compares correctly.
  if (key > S.lastPrinted) S.lastPrinted = key;
  return built;
}

/** The read frame. Same object every time within an issue. */
export function frameFor(_p, ms = S.now()) {
  try {
    return { t: 'courier', ...issue(ms) };
  } catch (e) {
    S.stats.errors++;
    S.logFn('frameFor', e);
    return null;
  }
}

/**
 * Optional heartbeat. Assembles the issue at print time rather than on the
 * first curious reader, and reports the first time it sees a new one so the
 * orchestrator may announce it. Returns null on every other call.
 */
export function tick(ms = S.now()) {
  if (!S.installed) return null;
  try {
    const before = S.lastPrinted;
    const iss = issue(ms);
    const key = currentIssueAt(ms).key;
    if (!before || before === key) return null;
    return { printed: true, key, week: iss.week, issueN: iss.issueN, headline: iss.headline };
  } catch (e) {
    S.stats.errors++;
    S.logFn('tick', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

function limited(p) {
  let r = S.rate.get(p);
  if (!r) { r = { n: 0, at: 0 }; S.rate.set(p, r); }
  const now = S.now();
  if (now - r.at > 1000) { r.at = now; r.n = 0; }
  return ++r.n > READ_BURST;
}

/**
 * First refusal, in the shape index.js already dispatches. Consumes exactly one
 * frame name and never anything else, and nothing on the frame is read beyond
 * its `t`: the issue is the same for everybody.
 */
export function handleMessage(p, m) {
  if (!S.installed || !p || !m || typeof m.t !== 'string') return false;
  if (m.t !== 'courier') return false;
  try {
    if (limited(p)) { S.stats.refusedRate++; return true; }
    S.stats.reads++;
    const frame = frameFor(p);
    if (frame) S.sendTo(p, frame);
    return true;
  } catch (e) {
    S.stats.errors++;
    console.error('[courier] handleMessage failed:', e?.message || e);
    return true; // consumed: a throw must never fall through into the main switch
  }
}

/** Test-only handles. Nothing in the game reads these. */
export const _internals = { S, assemble, fillerArticles, whenWords, dowOf, printableName };

export default {
  install, handleMessage, frameFor, issue, tick, stats,
  currentIssueAt, nextPrintAt, issueNumber,
  FILLERS, PRINT_DOW, PRINT_HOUR, EPOCH_FRIDAY, _internals,
};
