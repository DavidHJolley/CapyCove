/**
 * The calendar bus (wave 13A, spec docs/research/liveops.md sections 2.1-2.8 and
 * docs/NEXT-AAA.md "Wave 13 - The cadence engine").
 *
 * ONE SENTENCE: the calendar is DATA, the effects are a CLOSED VOCABULARY, and a
 * broken edit to the data can never take the live calendar down.
 *
 * Contract with index.js - the SAME shape server/progress.js and server/admin.js
 * already prove, because that is the only module contract this codebase has
 * shipped three times:
 *
 *   install(ctx)          once at boot
 *   tick(nowMs)           from the existing CLOCK_MS interval (no new timer)
 *   frame()               the {t:'events'} payload, for hello + join parity
 *   handleMessage(p, m)   'events' read + the two admin ops; true = consumed
 *   coinMult(p, reason)   >= 1, ALWAYS; grantCoins multiplies by this
 *   flag(name)            string|null, the room-readable escape hatch
 *   isActive(id)          for anything that wants to ask
 *
 * ---------------------------------------------------------------------------
 * THE FOUR LAWS THIS FILE IS BUILT AROUND
 *
 * 1. NO EARNING CAPS ON HONEST PLAY, EVER (the owner's law). `coinMult`
 *    multiplies UP only. A calendar entry with `mult: 0.5` is REFUSED AT LOAD -
 *    not clamped, not ignored quietly: the verb is dropped and the loader says
 *    so, because a live-ops system that can quietly halve a payout is a live-ops
 *    system that will, one Tuesday, quietly halve a payout. Nothing in the
 *    vocabulary can make any number worse for a player: the mural verb can only
 *    shorten the brush cooldown, the shop verb can only discount, and there is
 *    no verb that takes anything away.
 *
 * 2. NOTHING PUNISHES A MISSED DAY OR A QUIET WEEK. An event that did not
 *    happen leaves no trace on any account. There is no streak here, no "you
 *    missed it" toast, no expiry of anything owned.
 *
 * 3. A BROKEN CALENDAR NEVER TAKES THE COVE DOWN. Every read of the file is a
 *    SHADOW parse: text -> parse -> validate -> and only a fully valid calendar
 *    is swapped in. A syntax error at 1am keeps serving the last good calendar
 *    and logs loudly (liveops.md 2.8 v0). Unknown effect verbs are warned about
 *    and ignored, so a calendar one version AHEAD of the server still boots.
 *
 * 4. ONE TIMEZONE, ONE DAY MATH. America/New_York, and the day math is
 *    server/progress.js's - `dayKey`, `dayStartMs`, `dayEndMs` are imported and
 *    never reimplemented, so the quest board and the calendar can never disagree
 *    about what day it is. The only thing this file adds is TIME-OF-DAY on an ET
 *    day, and it derives that from those same three exports (see anchorAt) so it
 *    is correct on the two days a year the US moves its clocks.
 *
 * ---------------------------------------------------------------------------
 * THE WIRE (register in the CLAUDE.md protocol registry when the wave ships)
 *
 *   client -> server
 *     {t:'events'}                                   read the board (budgeted)
 *     {t:'event-start', id?, name, durMin, effects}  admin one-off, cap 'events'
 *     {t:'event-stop',  id}                          admin one-off, cap 'events'
 *   server -> client
 *     {t:'events', now, tz, active:[...], next:{...}|null, flags:{...}}
 *       on hello, on EVERY room join, and on any change. `active: []` is said
 *       OUT LOUD rather than going silent, so a stale banner always clears.
 *       Every active entry carries BOTH `endsAt` and `endsIn`, and `next`
 *       carries both `startsAt` and `startsIn`, exactly like the party frame:
 *       a client arriving twenty minutes into an hour gets forty minutes of
 *       countdown, not a fresh sixty.
 *     {t:'a-ok'} / {t:'a-err'}                       admin op replies (existing
 *       frames, already re-emitted raw by src/net/client.js - the admin ops add
 *       NO new server->client frame)
 *     {t:'announce', text, from, scope, at}          lead-in / start / end copy
 *       (existing frame, already handled)
 *
 * ---------------------------------------------------------------------------
 * DECISIONS (judgment calls, marked so they can be argued with)
 *
 * DECISION - the coin allowlist is an ALLOWLIST, never a blanket multiplier, and
 * `mining`, `gem!`, `bonfire` and `message in a bottle` are on a permanent DENY
 * list that no calendar edit can override (liveops.md 2.3). Those are AFK income
 * or once-a-day gifts; doubling them teaches the wrong habit and is the one
 * place where a multiplier really would widen the cheat surface. Everything
 * else - every minigame id, every win bonus - is fair game. This is not a cap:
 * mining pays exactly what it always paid.
 *
 * DECISION - admin one-off events are NOT written back into data/calendar.json,
 * even though liveops.md 2.8 suggests appending to `oneoffs` there. Two reasons,
 * both operational: the server would be writing the same file the operator is
 * hand-editing (a lost edit is a matter of when), and it would trip its own
 * hot-reload watcher, so every one-off would reload the calendar. They persist
 * to a SIBLING file the operator never opens, `<dataDir>/events-oneoffs.json`,
 * and a `oneoffs` array IN calendar.json is still read and honoured. A restart
 * mid-event therefore does not silently cancel it, which was the actual point.
 *
 * DECISION - the admin ops are gated on the REAL role, through admin.js's
 * `requireCap`, and the capability they want is a NEW one: 'events'. Until the
 * orchestrator adds it to server/admin.js's CAPS/CAPS_BY_ROLE (see this wave's
 * orchestratorLines), `requireCap(actor,'events')` is false for everyone, so the
 * gate falls back to "must be a real admin" - never to "allow". A dark feature
 * is a bug; an open one is an incident.
 *
 * DECISION - one-offs may not out-live a day. `durMin` is capped at 24 hours, so
 * a fat-fingered `durMin: 6000` at 1am is over by morning rather than running
 * until someone notices in March.
 *
 * Robustness: every entry point is wrapped. A throw in here must never cost a
 * player their frame, their coins or their tick.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MINIGAMES, ROOM_IDS, HATS } from '../shared/constants.js';
// The day math. NEVER reimplemented here: one exported set of functions decides
// what "today" means for the quest board, the streak and the calendar alike.
import { dayKey, dayStartMs, dayEndMs } from './progress.js';
import { writeFileAtomic, readTextSafe } from './store.js';
// Hoisted function declarations only (same rule server/reports.js follows), so
// importing the admin module here can never be an evaluation-order hazard.
import { requireCap, actorFrom, atLeast, CAPS as ADMIN_CAPS } from './admin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** Stated plainly everywhere a time is shown. There is exactly one. */
export const TZ = 'America/New_York';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** The capability the two admin ops want. Proposed for admins in wave 13A. */
export const EVENTS_CAP = 'events';

/**
 * The ceiling on a coin multiplier, applied at LOAD. Three is already a very
 * loud evening; the number exists so a typo (`mult: 20`) is a warm Friday and
 * not an economy incident. It is NOT a cap on play: it caps the CALENDAR.
 */
const MAX_MULT = 3;

/** Reasons no calendar entry may ever multiply. See the header. */
const DENY_REASONS = Object.freeze(['mining', 'gem!', 'bonfire', 'message in a bottle']);

/**
 * Everything a `coins` verb may name. The ten minigame ids (which is the
 * `reason` grantCoins is handed at server/index.js's score handler) plus the
 * three win bonuses and the quest bonuses. `'*'` in the file expands to exactly
 * this list, which is why "double coins on everything" still cannot touch the
 * AFK faucets.
 */
const ALLOWED_REASONS = Object.freeze([
  ...Object.keys(MINIGAMES),
  'race win', 'match win', 'doodle podium',
  'all three dailies',
]);
const ALLOWED_SET = new Set(ALLOWED_REASONS);
const DENY_SET = new Set(DENY_REASONS);

/** Client icon ids. A fixed set: never a URL, never a path (liveops.md 2.2). */
const ICONS = new Set(['coin', 'star', 'wave', 'snow', 'aurora', 'brush', 'whale', 'party', 'kart', 'gift', 'none']);

const WEEKDAYS = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const WEEKDAY_INDEX = new Map(WEEKDAYS.map((d, i) => [d, i]));

/** Bounds. A calendar is a page of text, not a database. */
const MAX_EVENTS = 200;
const MAX_ACTIVE = 8;          // what one frame will carry
const MAX_ONEOFFS = 32;
const MAX_ONEOFF_MINS = 24 * 60;
const NAME_MAX = 48;
const BLURB_MAX = 160;
const MSG_MAX = 160;
const NOTICE_HEAD_MAX = 80;
const NOTICE_BODY_MAX = 300;
const SLUG_MAX = 48;
const LEAD_MAX_MIN = 120;
/** The floor on the mural brush cooldown a theme week may ask for. */
const MURAL_FLOOR_MS = 5_000;

/** How far ahead `next` looks. Two weeks covers every weekly and monthly rule. */
const LOOKAHEAD_DAYS = 16;
/** ...and how far back, so an event that started yesterday and runs long shows. */
const LOOKBACK_DAYS = 2;

/** Client reads of the board, per connection. A UI asks once; three is slack. */
const READ_BURST = 3;
const READ_WINDOW_MS = 1000;
/** Admin ops, per actor. Same shape as admin.js's own budget. */
const OP_BURST = 4;
const OP_WINDOW_MS = 1000;

/** Debounce on the file watcher: editors write in bursts (liveops.md 2.8). */
const RELOAD_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

let ctx = null;
/** Injectable clock: tests pass a fake and a whole DST weekend costs a ms. */
let now = () => Date.now();

let calFile = '';
let shippedFile = '';
let oneoffFile = '';

/** The LAST GOOD calendar. Never null after install(); law 3 lives here. */
let cal = emptyCalendar();
/** The last failure, for /api/health and for the operator staring at a log. */
let lastError = null;
let lastMtimeMs = 0;
let watcher = null;
let reloadTimer = null;

/** Ad-hoc events started by an admin: id -> occurrence. */
const oneoffs = new Map();

/** The last computed state, so tick() can tell what CHANGED. */
let lastState = { key: '', active: [], next: null, flags: {} };
/** Announcement keys already fired ("<id>@<startMs>#lead"), pruned by age. */
const announced = new Map();

const scratch = new WeakMap();
const opBudget = new Map();

const stats = {
  loads: 0, loadFails: 0, reloads: 0, dropped: 0, warnings: 0,
  starts: 0, ends: 0, announces: 0, reads: 0, refused: 0,
  adminStarts: 0, adminStops: 0, errors: 0,
};

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

function emptyCalendar() {
  return { version: 1, tz: TZ, rev: 0, loadedAt: 0, events: [], byId: new Map(), fileOneoffs: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// install / teardown
// ---------------------------------------------------------------------------

/**
 * @param {object} c
 *   sendTo(p, msg)        required for any reply
 *   broadcastAll(msg)     required for the events frame + announcements
 *   recordFor(p)          used by admin.actorFrom (index.js already has it)
 *   audit                 the audit module or its log function (either works)
 *   now?                  injectable clock (tests)
 *   dataDir?              data root (default: COVE_DATA_DIR or <repo>/data)
 *   file?                 exact calendar path, overriding dataDir (tests)
 *   oneoffFile?           exact one-off store path (tests)
 *   watch?                false turns the fs watcher off (tests, read-only FS)
 */
export function install(c = {}) {
  ctx = c || {};
  now = typeof c.now === 'function' ? c.now : () => Date.now();

  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.join(ROOT, 'data'));
  shippedFile = path.join(ROOT, 'data', 'calendar.json');
  calFile = c.file ? path.resolve(c.file) : path.join(dataDir, 'calendar.json');
  oneoffFile = c.oneoffFile ? path.resolve(c.oneoffFile) : path.join(dataDir, 'events-oneoffs.json');

  stop(); // a second install() (a test sandbox) inherits nothing
  cal = emptyCalendar();
  lastError = null;
  lastMtimeMs = 0;
  oneoffs.clear();
  announced.clear();
  opBudget.clear();
  lastState = { key: '', active: [], next: null, flags: {} };
  frameCache = null;

  const missing = ['sendTo', 'broadcastAll'].filter((k) => typeof ctx?.[k] !== 'function');
  if (missing.length) console.warn('[events] install() missing from ctx:', missing.join(', '));

  load('boot');
  loadOneoffs();
  if (c.watch !== false) watch();
  // Prime the state so the FIRST frame (which may go out on a hello before the
  // first tick) is already correct, and so tick() has something to diff against
  // instead of announcing every running event a second time at boot.
  lastState = computeState(now());
  console.log(`[events] ready (${calFile}${fs.existsSync(calFile) ? '' : ' [shipped default]'}, ${cal.events.length} event${cal.events.length === 1 ? '' : 's'}, tz ${TZ})`);
}

/** Release the watcher and the debounce. Tests call this; so does a shutdown. */
export function stop() {
  try { watcher?.close(); } catch { /* already gone */ }
  watcher = null;
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
}

/** Counters for /api/health and for a future panel overview. */
export function eventStats() {
  return {
    ...stats,
    events: cal.events.length,
    oneoffs: oneoffs.size,
    active: lastState.active.length,
    rev: cal.rev,
    file: calFile,
    error: lastError ? lastError.msg : null,
    warnings: cal.warnings.length,
  };
}

// ---------------------------------------------------------------------------
// anchor math: ET wall clock, from progress.js's day math only
// ---------------------------------------------------------------------------

/** The ET calendar parts of the day containing `ms`, straight off dayKey(). */
function partsOf(ms) {
  const [y, mo, d] = String(dayKey(ms)).split('-').map(Number);
  return { y, mo, d };
}

/**
 * The exact instant of an ET wall-clock time on the ET day that opens at `ds`.
 *
 * This is the one piece of clock arithmetic this file owns, and it is built
 * ENTIRELY out of progress.js's exports so it cannot drift from the quest day.
 *
 * How it stays right on the two days a year the clocks move: the UTC offset at
 * ET midnight is `Date.UTC(that date) - ds`, exactly, because `ds` IS ET
 * midnight. A day that is 23 hours long sprang forward, a day that is 25 hours
 * long fell back, and in the US both transitions happen at 02:00 local - so any
 * wall time from 02:00 onwards on such a day carries the OTHER offset, shifted
 * by exactly the amount the day is short or long. No Intl call, no tz table, no
 * second opinion about what day it is.
 *
 * (A wall time inside the hour that a spring-forward day skips does not exist;
 * it resolves to the same instant as the hour after it, which is the only sane
 * answer and is why anchors are authored at sensible hours.)
 */
function anchorAt(ds, hh, mi) {
  const { y, mo, d } = partsOf(ds);
  const offMid = Date.UTC(y, mo - 1, d) - ds;      // wall-epoch minus real epoch
  const shift = DAY_MS - (dayEndMs(ds) - ds);      // +1h spring, -1h fall, else 0
  const minutes = hh * 60 + mi;
  const off = (shift !== 0 && minutes >= 120) ? offMid + shift : offMid;
  return Date.UTC(y, mo - 1, d, hh, mi) - off;
}

/** ET weekday index (0 = Sunday) of the day that opens at `ds`. */
function weekdayOf(ds) {
  const { y, mo, d } = partsOf(ds);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/**
 * ET day starts, walked one real day at a time. Stepping by 86,400,000 ms would
 * skip or repeat a day twice a year; `dayEndMs` of a day IS the next day's
 * midnight, so this is exact.
 */
function* etDays(fromMs, count) {
  let ds = dayStartMs(fromMs);
  for (let i = 0; i < count; i++) {
    yield ds;
    ds = dayEndMs(ds);
  }
}

/** The ET midnight `n` days before the day containing `ms` (n small). */
function backDays(ms, n) {
  let ds = dayStartMs(ms);
  for (let i = 0; i < n; i++) ds = dayStartMs(ds - 1);
  return ds;
}

/** The instant of an ET calendar date at hh:mm, from the date alone. */
function dateAt(y, mo, d, hh, mi) {
  // Noon UTC is inside the ET day for every offset the US has ever used, so it
  // is a safe probe for "which ET day is this date".
  const ds = dayStartMs(Date.UTC(y, mo - 1, d, 12));
  return anchorAt(ds, hh, mi);
}

// ---------------------------------------------------------------------------
// validation: text, numbers, slugs
// ---------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function num(v) {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Control characters out, whitespace collapsed, then the length check. */
function text(v, max) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** An id/theme-key/flag-name shape. Never a path, never a URL (liveops 2.2). */
function slug(v, max = SLUG_MAX) {
  const s = String(v ?? '').trim().toLowerCase().slice(0, max);
  return /^[a-z0-9][a-z0-9._:-]*$/.test(s) ? s : '';
}

// ---------------------------------------------------------------------------
// validation: the effect vocabulary
// ---------------------------------------------------------------------------

/**
 * The verbs, in one table so the list in the docs and the list in the code
 * cannot drift. Every one of them is checked here and NOWHERE else: an admin
 * one-off runs through this same function, so an operator cannot ship an effect
 * over the wire that the calendar file could not express (liveops.md 2.8).
 *
 * Unknown keys are warned about and dropped. That is deliberate and it is what
 * lets a calendar written for a newer server still boot on this one.
 */
const VERBS = {
  coins: vCoins,
  decorate: vDecorate,
  decor: vDecorate,          // liveops.md spells it `decor`; both are accepted
  announce: vAnnounce,
  spotlight: vSpotlight,
  doubleStamps: vDoubleStamps,
  flag: vFlag,
  notice: vNotice,
  sky: vSky,
  shop: vShop,
  mural: vMural,
  bots: vBots,
  quest: vQuest,
  goal: vGoal,
};

/**
 * `coins` - THE verb the owner's law is about.
 *
 * `mult` below 1.0 is REFUSED (the whole verb is dropped, loudly). Above
 * MAX_MULT it is clamped. `reasons`/`games` is filtered against the allowlist,
 * `'*'` means "every allowed reason", and the AFK deny list is subtracted last
 * so no spelling of the input can reach it.
 */
function vCoins(v, warn) {
  if (!v || typeof v !== 'object') return null;
  const mult = num(v.mult);
  if (mult === null) { warn('coins.mult is not a number'); return null; }
  if (mult < 1) {
    // The no-punish law, enforced at the door. Not clamped to 1 silently:
    // somebody typed a number that would have taken coins away from honest
    // players, and they need to see that it did not happen.
    warn(`coins.mult ${mult} is below 1.0 and was REFUSED (no earning caps on honest play, ever)`);
    return null;
  }
  const capped = clamp(mult, 1, MAX_MULT);
  if (capped !== mult) warn(`coins.mult ${mult} clamped to ${MAX_MULT}`);

  const raw = v.reasons ?? v.games ?? '*';
  let list;
  if (raw === '*' || raw === 'all') list = [...ALLOWED_REASONS];
  else if (Array.isArray(raw)) list = raw.map((x) => text(x, 40));
  else { warn('coins.reasons must be an array or "*"'); return null; }

  const reasons = [];
  for (const r of list) {
    if (!r) continue;
    if (DENY_SET.has(r)) { warn(`coins.reasons: '${r}' is AFK or gift income and can never be multiplied`); continue; }
    if (!ALLOWED_SET.has(r)) { warn(`coins.reasons: unknown reason '${r}' ignored`); continue; }
    if (!reasons.includes(r)) reasons.push(r);
  }
  if (!reasons.length) { warn('coins verb names nothing that can be multiplied'); return null; }
  return { mult: capped, reasons };
}

/** `decorate: {<roomId>: '<theme-key>'}` - the client-side dressing layer. */
function vDecorate(v, warn) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { warn('decorate must be an object of room -> theme'); return null; }
  const out = {};
  let n = 0;
  for (const [room, theme] of Object.entries(v)) {
    if (!ROOM_IDS.includes(room)) { warn(`decorate: unknown room '${room}' ignored`); continue; }
    const key = slug(theme, 32);
    if (!key) { warn(`decorate.${room}: '${theme}' is not a theme key`); continue; }
    out[room] = key;
    n++;
  }
  return n ? out : null;
}

/** `announce: {leadMin, startMsg, endMsg}` - operator copy, sanitised. */
function vAnnounce(v, warn) {
  if (!v || typeof v !== 'object') { warn('announce must be an object'); return null; }
  const leadMin = clamp(Math.floor(num(v.leadMin) ?? 0), 0, LEAD_MAX_MIN);
  const out = { leadMin };
  const lead = text(v.leadMsg, MSG_MAX);
  const start = text(v.startMsg, MSG_MAX);
  const end = text(v.endMsg, MSG_MAX);
  if (lead) out.leadMsg = lead;
  if (start) out.startMsg = start;
  if (end) out.endMsg = end;
  return out;
}

/** `spotlight: '<game>'` - one minigame gets the island's attention. */
function vSpotlight(v, warn) {
  const id = slug(typeof v === 'object' && v ? v.game : v, 24);
  if (!id || !own(MINIGAMES, id)) { warn(`spotlight: '${v}' is not a minigame id`); return null; }
  return id;
}

/** `doubleStamps: true` - a stamp-linked reward pays twice while this runs. */
function vDoubleStamps(v, warn) {
  if (v === true || v === 1 || v === 'true') return true;
  if (v === false || v === 0) return null;
  warn('doubleStamps must be true');
  return null;
}

/** `flag: {'name.space': value}` - the escape hatch, kept tiny and namespaced. */
function vFlag(v, warn) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { warn('flag must be an object'); return null; }
  const out = {};
  let n = 0;
  for (const [k, raw] of Object.entries(v)) {
    const name = slug(k, SLUG_MAX);
    if (!name) { warn(`flag: '${k}' is not a flag name`); continue; }
    let val;
    if (typeof raw === 'boolean') val = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) val = raw;
    else val = text(raw, 64);
    if (val === '') { warn(`flag.${name}: empty value ignored`); continue; }
    out[name] = val;
    n++;
  }
  return n ? out : null;
}

/** `notice: {headline, body}` - the no-code event: a headline alone is valid. */
function vNotice(v, warn) {
  if (!v || typeof v !== 'object') { warn('notice must be an object'); return null; }
  const headline = text(v.headline, NOTICE_HEAD_MAX);
  const body = text(v.body, NOTICE_BODY_MAX);
  if (!headline && !body) return null;
  return { ...(headline ? { headline } : {}), ...(body ? { body } : {}) };
}

/** `sky: {aurora, weather}` - forced after the clock's own Markov walk. */
function vSky(v, warn) {
  if (!v || typeof v !== 'object') { warn('sky must be an object'); return null; }
  const out = {};
  if (v.aurora === true) out.aurora = true;
  if (v.weather !== undefined) {
    const w = slug(v.weather, 12);
    // The word list is the clock frame's, verbatim: 'weather' is a WORD on the
    // wire, never an envelope (CLAUDE.md, wave 7).
    if (['clear', 'breeze', 'rain'].includes(w)) out.weather = w;
    else warn(`sky.weather '${v.weather}' is not clear|breeze|rain`);
  }
  return Object.keys(out).length ? out : null;
}

/** `shop: {featured, discount}` - discount only ever makes a price smaller. */
function vShop(v, warn) {
  if (!v || typeof v !== 'object') { warn('shop must be an object'); return null; }
  const out = {};
  if (v.featured !== undefined) {
    const id = slug(v.featured, 32);
    if (id && own(HATS, id)) out.featured = id;
    else warn(`shop.featured '${v.featured}' is not a hat id`);
  }
  if (v.discount !== undefined) {
    const d = num(v.discount);
    if (d === null || d <= 0) warn('shop.discount must be a positive fraction');
    else out.discount = clamp(d, 0, 0.5);
  }
  return Object.keys(out).length ? out : null;
}

/** `mural: {cooldownMs}` - a theme week wants a FASTER brush, never a slower. */
function vMural(v, warn) {
  if (!v || typeof v !== 'object') { warn('mural must be an object'); return null; }
  const ms = num(v.cooldownMs);
  if (ms === null) { warn('mural.cooldownMs is not a number'); return null; }
  const out = Math.max(MURAL_FLOOR_MS, Math.floor(ms));
  if (out !== Math.floor(ms)) warn(`mural.cooldownMs raised to the ${MURAL_FLOOR_MS}ms floor`);
  return { cooldownMs: out };
}

/** `bots: {route, share}` - citizens show up where the event is. */
function vBots(v, warn) {
  if (!v || typeof v !== 'object') { warn('bots must be an object'); return null; }
  const route = slug(v.route, 32);
  if (!route || !ROOM_IDS.includes(route)) { warn(`bots.route '${v.route}' is not a room`); return null; }
  const share = clamp(num(v.share) ?? 0.5, 0, 1);
  return { route, share };
}

/** `quest: {extra}` - a fourth, event-only daily for progress.js to offer. */
function vQuest(v, warn) {
  const id = slug(typeof v === 'object' && v ? v.extra : v, 32);
  if (!id) { warn('quest.extra is not a quest id'); return null; }
  return { extra: id };
}

/** `goal: {id}` - events are how community goals start and stop. */
function vGoal(v, warn) {
  const id = slug(typeof v === 'object' && v ? v.id : v, 32);
  if (!id) { warn('goal.id is not a goal id'); return null; }
  return { id };
}

/**
 * The whole effects block. Returns a NEW object containing only verbs that
 * validated; never throws, never returns undefined.
 */
export function validateEffects(raw, warn = () => {}) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // operator notes
    if (!own(VERBS, key)) { warn(`unknown effect verb '${key}' ignored`); continue; }
    let got = null;
    try { got = VERBS[key](value, (m) => warn(`${key}: ${m}`)); } catch (e) {
      warn(`${key}: ${e?.message || e}`);
      got = null;
    }
    if (got === null || got === undefined) continue;
    // `decor` is an alias; it lands under the canonical name.
    out[key === 'decor' ? 'decorate' : key] = got;
  }
  return out;
}

// ---------------------------------------------------------------------------
// validation: `when`
// ---------------------------------------------------------------------------

/**
 * Exactly three forms, and no cron parser (liveops.md 2.2):
 *   {rrule:'FRI'|'FRI,SAT'|'DAILY', start:'20:00', durMin:60}
 *   {rrule:'MONTHLY', day:1, start:'20:00', durMin:60}
 *   {start:'2026-06-01T00:00', end:'2026-06-08T00:00'}   ET local, one-off
 */
function vWhen(v, warn) {
  if (!v || typeof v !== 'object') { warn('when is missing'); return null; }

  const rrule = String(v.rrule ?? '').trim().toUpperCase();
  if (!rrule) {
    // fixed window
    const a = parseLocal(v.start);
    const b = parseLocal(v.end);
    if (!a || !b) { warn('when needs an rrule, or a start and end like 2026-06-01T00:00'); return null; }
    if (b.ms <= a.ms) { warn('when.end is not after when.start'); return null; }
    return { kind: 'window', startMs: a.ms, endMs: b.ms };
  }

  const hm = parseHM(v.start);
  if (!hm) { warn(`when.start '${v.start}' is not HH:MM`); return null; }
  const durMin = Math.floor(num(v.durMin) ?? 0);
  if (!durMin || durMin < 1) { warn('when.durMin must be at least 1 minute'); return null; }
  if (durMin > 7 * 24 * 60) { warn('when.durMin longer than a week: use a fixed start/end window'); return null; }

  if (rrule === 'DAILY') return { kind: 'daily', h: hm.h, mi: hm.mi, durMin };
  if (rrule === 'MONTHLY') {
    const day = Math.floor(num(v.day) ?? 1);
    if (day < 1 || day > 28) { warn('when.day must be 1-28 (every month has those)'); return null; }
    return { kind: 'monthly', day, h: hm.h, mi: hm.mi, durMin };
  }
  const days = [];
  for (const part of rrule.split(',')) {
    const d = part.trim();
    if (!WEEKDAY_INDEX.has(d)) { warn(`when.rrule: '${d}' is not a weekday (SUN..SAT), DAILY or MONTHLY`); continue; }
    const i = WEEKDAY_INDEX.get(d);
    if (!days.includes(i)) days.push(i);
  }
  if (!days.length) return null;
  return { kind: 'weekly', days, h: hm.h, mi: hm.mi, durMin };
}

function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM', read as ET local (never UTC). */
function parseLocal(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const hh = h === undefined ? 0 : Number(h);
  const mm = mi === undefined ? 0 : Number(mi);
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || hh > 23 || mm > 59) return null;
  return { ms: dateAt(Number(y), Number(mo), Number(d), hh, mm) };
}

// ---------------------------------------------------------------------------
// validation: one event
// ---------------------------------------------------------------------------

function vEvent(raw, warn) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warn('not an object'); return null; }
  const id = slug(raw.id, 48);
  if (!id) { warn(`'${raw.id}' is not a usable event id`); return null; }
  const w = (m) => warn(`${id}: ${m}`);

  const when = vWhen(raw.when, w);
  if (!when) return null;

  const effects = validateEffects(raw.effects, w);
  const announce = raw.announce ? vAnnounce(raw.announce, w) : (effects.announce || null);
  delete effects.announce;

  let rooms = ['*'];
  if (Array.isArray(raw.rooms)) {
    const list = raw.rooms.map((r) => slug(r, 32) || (r === '*' ? '*' : '')).filter(Boolean);
    const good = list.filter((r) => r === '*' || ROOM_IDS.includes(r));
    for (const r of list) if (!good.includes(r)) w(`rooms: unknown room '${r}' ignored`);
    if (good.length) rooms = good.includes('*') ? ['*'] : good;
  }

  const icon = slug(raw.icon, 16);
  return {
    id,
    name: text(raw.name, NAME_MAX) || id,
    blurb: text(raw.blurb, BLURB_MAX),
    icon: ICONS.has(icon) ? icon : '',
    rooms,
    when,
    effects,
    announce,
  };
}

// ---------------------------------------------------------------------------
// the loader: shadow parse, validate, swap
// ---------------------------------------------------------------------------

/**
 * Parse and validate a calendar TEXT into a shadow object. Pure: it touches no
 * module state, which is exactly what makes the swap safe (law 3).
 */
export function parseCalendar(src) {
  const warnings = [];
  const warn = (m) => { if (warnings.length < 100) warnings.push(String(m)); };
  let doc;
  try {
    doc = JSON.parse(String(src));
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e?.message || e}`, warnings };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'the calendar must be a JSON object', warnings };
  }
  if (!Array.isArray(doc.events)) {
    return { ok: false, error: 'the calendar has no `events` array', warnings };
  }
  const tz = String(doc.tz || TZ);
  if (tz !== TZ) warn(`tz '${tz}' ignored: this cove runs on ${TZ} and only ${TZ}`);

  const events = [];
  const byId = new Map();
  for (const raw of doc.events.slice(0, MAX_EVENTS)) {
    const ev = vEvent(raw, warn);
    if (!ev) continue;
    if (byId.has(ev.id)) { warn(`duplicate event id '${ev.id}' ignored`); continue; }
    byId.set(ev.id, ev);
    events.push(ev);
  }
  if (doc.events.length > MAX_EVENTS) warn(`only the first ${MAX_EVENTS} events were read`);

  // `oneoffs` in the FILE is honoured (liveops.md 2.8) even though the server
  // writes its own to a sibling file: an operator may hand-write one.
  const fileOneoffs = [];
  if (Array.isArray(doc.oneoffs)) {
    for (const raw of doc.oneoffs.slice(0, MAX_ONEOFFS)) {
      const o = vOneoff(raw, warn);
      if (o) fileOneoffs.push(o);
    }
  }
  return {
    ok: true,
    warnings,
    cal: { version: Math.floor(num(doc.version) ?? 1), tz: TZ, rev: 0, loadedAt: 0, events, byId, fileOneoffs, warnings },
  };
}

/** A stored/hand-written one-off: an event with an explicit window. */
function vOneoff(raw, warn) {
  if (!raw || typeof raw !== 'object') return null;
  const id = slug(raw.id, 48);
  if (!id) { warn('one-off with no id ignored'); return null; }
  const startedAt = Math.floor(num(raw.startedAt) ?? 0);
  const endsAt = Math.floor(num(raw.endsAt) ?? 0);
  if (!endsAt || endsAt <= startedAt) { warn(`one-off '${id}' has no usable window`); return null; }
  const effects = validateEffects(raw.effects, (m) => warn(`${id}: ${m}`));
  const icon = slug(raw.icon, 16);
  const rooms = Array.isArray(raw.rooms) ? raw.rooms.filter((r) => r === '*' || ROOM_IDS.includes(r)) : ['*'];
  return {
    id,
    name: text(raw.name, NAME_MAX) || id,
    blurb: text(raw.blurb, BLURB_MAX),
    icon: ICONS.has(icon) ? icon : '',
    rooms: rooms.length ? rooms : ['*'],
    effects,
    announce: raw.announce ? vAnnounce(raw.announce, warn) : null,
    startedAt: startedAt || endsAt - 60_000,
    endsAt,
    by: text(raw.by, NAME_MAX),
    oneoff: true,
  };
}

/**
 * Read the calendar from disk and swap it in IF AND ONLY IF it validated.
 * Returns true on a swap. A failure keeps the running calendar, records the
 * error and shouts once: that is the whole of law 3.
 */
export function load(reason = 'reload') {
  let src = readTextSafe(calFile);
  let from = calFile;
  if (src === null && calFile !== shippedFile) {
    // A fresh persistent volume has no calendar yet. Fall back to the one that
    // ships in the repo so a first boot on a new host is a working Friday, not
    // an empty island.
    src = readTextSafe(shippedFile);
    from = shippedFile;
  }
  if (src === null) {
    lastError = { at: now(), msg: `no calendar at ${calFile}` };
    stats.loadFails++;
    console.warn(`[events] no calendar file at ${calFile}: nothing is scheduled`);
    return false;
  }

  const res = parseCalendar(src);
  if (!res.ok) {
    stats.loadFails++;
    lastError = { at: now(), msg: res.error };
    // LOUD, and with the file path, because the operator who just broke it is
    // looking at a terminal and needs to know the cove is still fine.
    console.error(`[events] ${from} is BROKEN (${res.error}); keeping the last good calendar (${cal.events.length} events). Fix the file and save again.`);
    return false;
  }

  const next = res.cal;
  next.rev = cal.rev + 1;
  next.loadedAt = now();
  cal = next;
  lastError = null;
  stats.loads++;
  if (reason !== 'boot') stats.reloads++;
  stats.warnings += next.warnings.length;
  try { lastMtimeMs = fs.statSync(from).mtimeMs; } catch { lastMtimeMs = 0; }
  for (const wmsg of next.warnings) console.warn(`[events] calendar: ${wmsg}`);
  if (reason !== 'boot') {
    console.log(`[events] calendar reloaded (rev ${next.rev}, ${next.events.length} events, ${next.warnings.length} warning${next.warnings.length === 1 ? '' : 's'})`);
  }
  return true;
}

/**
 * fs.watch on the DIRECTORY, not the file: an editor that saves by writing a
 * temp file and renaming over the target (which is most of them, and is also
 * exactly what store.js's own atomic write does) leaves a watch on the inode
 * pointing at a file nobody will ever write again.
 */
function watch() {
  const dir = path.dirname(calFile);
  const base = path.basename(calFile);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only FS: watch below just fails */ }
  try {
    watcher = fs.watch(dir, (_type, filename) => {
      if (filename && String(filename) !== base) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        try { if (load('watch')) onCalendarChanged(); } catch (e) {
          stats.errors++;
          console.error('[events] reload failed:', e?.message || e);
        }
      }, RELOAD_DEBOUNCE_MS);
    });
    watcher.unref?.();
  } catch (e) {
    // Not fatal: tick()'s mtime backstop still picks up an edit within 10s.
    console.warn('[events] cannot watch', dir, '-', e?.message || e, '(falling back to the tick mtime check)');
  }
}

/** The tick backstop: one statSync, and only when the file actually moved. */
function pollFile() {
  try {
    const st = fs.statSync(fs.existsSync(calFile) ? calFile : shippedFile);
    if (st.mtimeMs && st.mtimeMs !== lastMtimeMs) {
      // A failed load leaves lastMtimeMs alone, so a broken file is retried on
      // every tick until it parses. That is what an operator expects while they
      // are fixing it, and it costs one stat + one parse every ten seconds.
      lastMtimeMs = st.mtimeMs;
      if (load('poll')) onCalendarChanged();
    }
  } catch { /* the file is gone; the last good calendar keeps running */ }
}

function onCalendarChanged() {
  // A reload must not re-announce a running event, so the announcement memory
  // survives it; only the state diff is recomputed and pushed.
  pushIfChanged(now(), { force: true });
}

// ---------------------------------------------------------------------------
// one-off persistence
// ---------------------------------------------------------------------------

function loadOneoffs() {
  const src = readTextSafe(oneoffFile);
  if (src === null) return;
  let doc;
  try { doc = JSON.parse(src); } catch (e) {
    console.warn('[events] events-oneoffs.json is unreadable, ignoring it:', e?.message || e);
    return;
  }
  const list = Array.isArray(doc?.oneoffs) ? doc.oneoffs : (Array.isArray(doc) ? doc : []);
  const at = now();
  for (const raw of list.slice(0, MAX_ONEOFFS)) {
    const o = vOneoff(raw, (m) => console.warn('[events] one-off:', m));
    // Anything already over is simply not restored: a restart must not resurrect
    // last night's event, and must not cancel one still running.
    if (o && o.endsAt > at) oneoffs.set(o.id, o);
  }
  if (oneoffs.size) console.log(`[events] restored ${oneoffs.size} running one-off event${oneoffs.size === 1 ? '' : 's'}`);
}

function saveOneoffs() {
  try {
    const at = now();
    const list = [...oneoffs.values()].filter((o) => o.endsAt > at);
    writeFileAtomic(oneoffFile, `${JSON.stringify({ version: 1, oneoffs: list }, null, 2)}\n`);
  } catch (e) {
    // A one-off that cannot be persisted still RUNS. Losing it on a restart is
    // a smaller failure than refusing the operator's op.
    console.error('[events] could not persist one-offs:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// occurrences and state
// ---------------------------------------------------------------------------

/**
 * Every occurrence of one event that overlaps the window around `at`. Bounded
 * by construction: a handful of days, one occurrence each.
 */
function occurrences(ev, at) {
  const out = [];
  const w = ev.when;
  if (w.kind === 'window') {
    out.push({ startMs: w.startMs, endMs: w.endMs });
    return out;
  }
  const from = backDays(at, LOOKBACK_DAYS);
  const days = LOOKBACK_DAYS + LOOKAHEAD_DAYS;
  for (const ds of etDays(from, days)) {
    let hit = false;
    if (w.kind === 'daily') hit = true;
    else if (w.kind === 'weekly') hit = w.days.includes(weekdayOf(ds));
    else if (w.kind === 'monthly') hit = partsOf(ds).d === w.day;
    if (!hit) continue;
    const startMs = anchorAt(ds, w.h, w.mi);
    out.push({ startMs, endMs: startMs + w.durMin * MIN_MS });
  }
  return out;
}

/**
 * What is on right now, and what is next. This is the ONE place that decides,
 * and everything else (the frame, coinMult, the flags) reads its answer.
 */
function computeState(at) {
  const active = [];
  let next = null;

  const consider = (ev, occ) => {
    if (occ.startMs <= at && at < occ.endMs) {
      active.push({ ev, startedAt: occ.startMs, endsAt: occ.endMs });
    } else if (occ.startMs > at && (!next || occ.startMs < next.startsAt)) {
      next = { id: ev.id, name: ev.name, blurb: ev.blurb, icon: ev.icon, startsAt: occ.startMs, endsAt: occ.endMs };
    }
  };

  for (const ev of cal.events) {
    for (const occ of occurrences(ev, at)) consider(ev, occ);
  }
  // File-authored one-offs behave exactly like admin one-offs.
  for (const o of [...cal.fileOneoffs, ...oneoffs.values()]) {
    consider(o, { startMs: o.startedAt, endMs: o.endsAt });
  }

  // Soonest-started first, so the pill order is stable between frames.
  active.sort((a, b) => a.startedAt - b.startedAt || a.ev.id.localeCompare(b.ev.id));
  const capped = active.slice(0, MAX_ACTIVE);

  const flags = {};
  for (const a of capped) {
    if (a.ev.effects.flag) Object.assign(flags, a.ev.effects.flag);
  }
  const key = `${capped.map((a) => `${a.ev.id}@${a.startedAt}`).join(',')}|${next ? `${next.id}@${next.startsAt}` : ''}`;
  return { key, active: capped, next, flags };
}

/**
 * The state, recomputed at most once per millisecond of wall clock. Its memo
 * is DELIBERATELY separate from lastState: lastState is pushIfChanged's diff
 * base (the last state the island was TOLD about), and a frame read going out
 * on a hello must never advance it past a transition, or the start
 * announcement and the world-wide push are silently swallowed.
 */
let frameCache = null;
function state(at) {
  // keyed on the calendar revision AND the one-off count too: a hot reload or
  // an admin one-off at the same millisecond must never serve the old board
  if (frameCache && frameCache.at === at && frameCache.rev === cal.rev
    && frameCache.oneoffN === oneoffs.size) return frameCache;
  const s = computeState(at);
  s.at = at;
  s.rev = cal.rev;
  s.oneoffN = oneoffs.size;
  frameCache = s;
  return s;
}

// ---------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------

function publicEvent(entry, at) {
  const { ev, startedAt, endsAt } = entry;
  return {
    id: ev.id,
    name: ev.name,
    blurb: ev.blurb,
    icon: ev.icon || badgeFor(ev),
    badge: badgeFor(ev),
    rooms: ev.rooms,
    oneoff: ev.oneoff === true,
    startedAt,
    endsAt,
    // Both spellings, exactly like the party frame: a client that arrives
    // twenty minutes in must get the REMAINING time, not a fresh duration.
    endsIn: Math.max(0, Math.round((endsAt - at) / 1000)),
    effects: ev.effects,
  };
}

/** What the HUD pill shows when the event did not name an icon. */
function badgeFor(ev) {
  const e = ev.effects || {};
  if (e.coins) return 'coins';
  if (e.goal) return 'goal';
  if (e.spotlight) return 'spotlight';
  if (e.sky?.aurora) return 'aurora';
  if (e.decorate) return 'decor';
  if (e.doubleStamps) return 'stamps';
  return 'none';
}

/**
 * The {t:'events'} payload. Sent on hello, on EVERY room join, and on change -
 * the "arrive already running" convention (liveops.md 1.3), which is the single
 * most important rule in this file for a player who logs in mid-event.
 */
export function frame() {
  const at = now();
  let s;
  try { s = state(at); } catch (e) {
    stats.errors++;
    console.error('[events] frame failed:', e?.message || e);
    s = { active: [], next: null, flags: {} };
  }
  return {
    t: 'events',
    now: at,
    tz: TZ,
    rev: cal.rev,
    active: s.active.map((a) => publicEvent(a, at)),
    next: s.next
      ? {
        id: s.next.id,
        name: s.next.name,
        blurb: s.next.blurb,
        icon: s.next.icon || 'none',
        startsAt: s.next.startsAt,
        startsIn: Math.max(0, Math.round((s.next.startsAt - at) / 1000)),
        endsAt: s.next.endsAt,
      }
      : null,
    flags: s.flags,
  };
}

// ---------------------------------------------------------------------------
// the accessors: what the rest of the server asks
// ---------------------------------------------------------------------------

/**
 * The coin multiplier for one payout. ALWAYS >= 1: there is no input, no
 * calendar, no admin op and no arithmetic path in this file that can return
 * less. index.js multiplies the CLAMPED honest payout by this, so a 2x evening
 * rides on top of clampCoinsForGame and under the hourly backstop.
 *
 * Stacked events multiply, and the product is capped at MAX_MULT so two
 * overlapping calendar entries cannot compound into an accident.
 */
export function coinMult(_p, reason) {
  try {
    const r = String(reason ?? '');
    if (!r || DENY_SET.has(r) || !ALLOWED_SET.has(r)) return 1;
    let mult = 1;
    for (const a of state(now()).active) {
      const c = a.ev.effects.coins;
      if (c && c.reasons.includes(r)) mult *= c.mult;
    }
    return mult > 1 ? Math.min(MAX_MULT, mult) : 1;
  } catch (e) {
    stats.errors++;
    console.error('[events] coinMult failed:', e?.message || e);
    return 1; // a throw in live ops must never change what a player is paid
  }
}

/** A room-readable feature flag, or null. The escape hatch (liveops.md 2.5). */
export function flag(name) {
  try {
    const key = slug(name, SLUG_MAX);
    if (!key) return null;
    const flags = state(now()).flags;
    return own(flags, key) ? flags[key] : null;
  } catch { return null; }
}

/** Is this event id running right now? */
export function isActive(id) {
  try {
    const want = slug(id, 48);
    return !!want && state(now()).active.some((a) => a.ev.id === want);
  } catch { return false; }
}

/** The one active entry for `id`, or null (for anything that wants the window). */
export function activeEvent(id) {
  try {
    const want = slug(id, 48);
    const at = now();
    const hit = state(at).active.find((a) => a.ev.id === want);
    return hit ? publicEvent(hit, at) : null;
  } catch { return null; }
}

/** The theme key decorating `room` right now, or null. */
export function decorFor(room) {
  try {
    for (const a of state(now()).active) {
      const d = a.ev.effects.decorate;
      if (d && own(d, room)) return d[room];
    }
    return null;
  } catch { return null; }
}

/** The minigame in the spotlight right now, or null. */
export function spotlight() {
  try {
    for (const a of state(now()).active) if (a.ev.effects.spotlight) return a.ev.effects.spotlight;
    return null;
  } catch { return null; }
}

/** True while a doubleStamps event runs. */
export function doubleStamps() {
  try {
    return state(now()).active.some((a) => a.ev.effects.doubleStamps === true);
  } catch { return false; }
}

/** 2 while a doubleStamps event runs, 1 otherwise. Never below 1. */
export const stampMult = () => (doubleStamps() ? 2 : 1);

/**
 * The mural brush cooldown for right now. Takes the room's own base and can
 * only ever return something SMALLER: a theme week speeds the brush up, and no
 * calendar edit can slow it down (law 1).
 */
export function muralCooldownMs(base) {
  const b = Math.max(0, Math.floor(num(base) ?? 0));
  try {
    let out = b;
    for (const a of state(now()).active) {
      const m = a.ev.effects.mural;
      if (m && m.cooldownMs < out) out = Math.max(MURAL_FLOOR_MS, m.cooldownMs);
    }
    return out;
  } catch { return b; }
}

/** `{featured, discount}` merged across active events, or null. */
export function shopEffect() {
  try {
    const out = {};
    for (const a of state(now()).active) {
      const s = a.ev.effects.shop;
      if (!s) continue;
      if (s.featured) out.featured = s.featured;
      if (s.discount) out.discount = Math.max(out.discount || 0, s.discount);
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** `{aurora?, weather?}` the clock should force after its own roll, or null. */
export function skyOverride() {
  try {
    const out = {};
    for (const a of state(now()).active) Object.assign(out, a.ev.effects.sky || {});
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** `{route, share}` for the citizens, or null. */
export function botRoute() {
  try {
    for (const a of state(now()).active) if (a.ev.effects.bots) return a.ev.effects.bots;
    return null;
  } catch { return null; }
}

/** Every `notice` on right now: the notice board's and the Courier's copy. */
export function notices() {
  try {
    return state(now()).active
      .filter((a) => a.ev.effects.notice)
      .map((a) => ({ id: a.ev.id, name: a.ev.name, ...a.ev.effects.notice }));
  } catch { return []; }
}

/** The event-only extra daily quest id, or null (progress.js may read this). */
export function extraQuest() {
  try {
    for (const a of state(now()).active) if (a.ev.effects.quest) return a.ev.effects.quest.extra;
    return null;
  } catch { return null; }
}

/** The community goal id the calendar has running, or null. */
export function activeGoal() {
  try {
    for (const a of state(now()).active) if (a.ev.effects.goal) return a.ev.effects.goal.id;
    return null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// tick: announcements and the change broadcast
// ---------------------------------------------------------------------------

function say(textLine) {
  if (!textLine || typeof ctx?.broadcastAll !== 'function') return;
  try {
    // The EXISTING announce frame (server/admin.js's opAnnounce ships it and
    // src/net/client.js already re-emits it), never `chat`: a chat line would be
    // filtered, room-scoped, rate-limited and impersonatable.
    ctx.broadcastAll({ t: 'announce', text: textLine, from: 'The Cove', scope: 'world', at: now() });
    stats.announces++;
  } catch (e) {
    console.error('[events] announce failed:', e?.message || e);
  }
}

/** Fire once per occurrence per kind; the memory is pruned by age. */
function fireOnce(key, at, fn) {
  if (announced.has(key)) return;
  announced.set(key, at);
  if (announced.size > 256) {
    const cutoff = at - 2 * DAY_MS;
    for (const [k, ts] of announced) if (ts < cutoff) announced.delete(k);
  }
  fn();
}

function pushIfChanged(at, { force = false } = {}) {
  const s = computeState(at);
  s.at = at;
  const changed = force || s.key !== lastState.key;
  const before = lastState;
  lastState = s;
  if (!changed) return false;

  // start / end copy, from the diff
  const wasActive = new Set(before.active.map((a) => `${a.ev.id}@${a.startedAt}`));
  for (const a of s.active) {
    const k = `${a.ev.id}@${a.startedAt}`;
    if (wasActive.has(k)) continue;
    stats.starts++;
    const msg = a.ev.announce?.startMsg || (a.ev.blurb ? `${a.ev.name}: ${a.ev.blurb}` : `${a.ev.name} has begun.`);
    fireOnce(`${k}#start`, at, () => say(msg));
  }
  const nowActive = new Set(s.active.map((a) => `${a.ev.id}@${a.startedAt}`));
  for (const a of before.active) {
    const k = `${a.ev.id}@${a.startedAt}`;
    if (nowActive.has(k)) continue;
    stats.ends++;
    // No end message by default. "It is over" is not news, and a world that
    // shouts about things ending is a world that feels like it is closing.
    if (a.ev.announce?.endMsg) fireOnce(`${k}#end`, at, () => say(a.ev.announce.endMsg));
  }

  if (typeof ctx?.broadcastAll === 'function') {
    try { ctx.broadcastAll(frame()); } catch (e) {
      stats.errors++;
      console.error('[events] broadcast failed:', e?.message || e);
    }
  }
  return true;
}

/** The lead-in: "starts in ten minutes", once, for the next occurrence only. */
function leadIn(at) {
  const s = state(at);
  const n = s.next;
  if (!n) return;
  const ev = cal.byId.get(n.id);
  const lead = ev?.announce?.leadMin || 0;
  if (!lead) return;
  const due = n.startsAt - lead * MIN_MS;
  if (at < due || at >= n.startsAt) return;
  const mins = Math.max(1, Math.round((n.startsAt - at) / MIN_MS));
  const msg = ev.announce.leadMsg || `${ev.name} starts in ${mins} minute${mins === 1 ? '' : 's'}.`;
  fireOnce(`${n.id}@${n.startsAt}#lead`, at, () => say(msg));
}

/**
 * Called from index.js's existing CLOCK_MS interval. No new timer, by design
 * (liveops.md 1.2). Tolerates being handed either an epoch or a delta-seconds
 * argument, because the two live-ops modules in this codebase disagree about
 * that and neither spelling should be able to break the calendar.
 */
export function tick(arg) {
  if (!ctx) return;
  try {
    const n = Number(arg);
    const at = Number.isFinite(n) && n > 1e12 ? n : now();
    pollFile();
    // Expire one-offs before the diff, so their end is a normal state change.
    let dropped = false;
    for (const [id, o] of oneoffs) if (o.endsAt <= at) { oneoffs.delete(id); dropped = true; }
    if (dropped) saveOneoffs();
    pushIfChanged(at);
    leadIn(at);
  } catch (e) {
    stats.errors++;
    console.error('[events] tick failed:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// the ws surface
// ---------------------------------------------------------------------------

function budget(p, at, field, limit, windowMs) {
  let s = scratch.get(p);
  if (!s) { s = { rw: 0, rn: 0 }; scratch.set(p, s); }
  if (at - s[`${field}w`] > windowMs) { s[`${field}w`] = at; s[`${field}n`] = 0; }
  return ++s[`${field}n`] > limit;
}

function opTooFast(actor, at) {
  const key = actor.uid || actor.key || actor.name || '?';
  let b = opBudget.get(key);
  if (!b) { b = { w: 0, n: 0 }; opBudget.set(key, b); }
  if (opBudget.size > 128) for (const [k, v] of opBudget) if (at - v.w > 60_000) opBudget.delete(k);
  if (at - b.w > OP_WINDOW_MS) { b.w = at; b.n = 0; }
  return ++b.n > OP_BURST;
}

/**
 * The admin gate. The capability is REAL - admin.js's requireCap over the role
 * on the user record - and the cap it wants is 'events', proposed for admins in
 * this wave's orchestratorLines. Until that line lands, `CAPS` does not contain
 * 'events', so the fallback is "must be a real admin". It is never "allow".
 */
function mayOperate(actor) {
  if (!actor) return false;
  if (ADMIN_CAPS.includes(EVENTS_CAP)) return requireCap(actor, EVENTS_CAP);
  return atLeast(actor, 'admin');
}

function auditFn() {
  const a = ctx?.audit;
  if (typeof a === 'function') return a;
  if (a && typeof a.log === 'function') return a.log.bind(a);
  return null;
}

function audit(op, actor, args, ok = true) {
  const fn = auditFn();
  if (!fn) return;
  try {
    fn({
      op,
      ts: now(),
      via: actor?.via || 'ingame',
      actor: actor ? { uid: actor.uid || null, name: actor.name || '', role: actor.role || 'player', ipH: actor.ipH || '', id: actor.p?.id || '' } : null,
      target: null,
      args: args || {},
      ok,
    }, op);
  } catch (e) {
    console.error('[events] audit hook threw:', e?.message || e);
  }
}

const reply = (p, msg) => { try { ctx.sendTo(p, msg); } catch { /* socket died */ } };

/**
 * First refusal on three frames and nothing else. Returns true when consumed.
 * index.js dispatches this after progress/econ and before the main switch.
 */
export function handleMessage(p, m) {
  if (!ctx || !p || !m || typeof m.t !== 'string') return false;
  const t = m.t;
  if (t !== 'events' && t !== 'event-start' && t !== 'event-stop') return false;
  try {
    const at = now();

    if (t === 'events') {
      // Consumed either way: an over-eager UI must not turn one socket into a
      // calendar-rebuild pump.
      if (budget(p, at, 'r', READ_BURST, READ_WINDOW_MS)) { stats.refused++; return true; }
      stats.reads++;
      reply(p, frame());
      return true;
    }

    const actor = actorFrom(p, 'ingame');
    if (!mayOperate(actor)) {
      stats.refused++;
      // A player with no standing gets SILENCE and one audit line, the same deal
      // admin.js gives a probe. Staff who hold caps but not this one get told.
      if (actor && atLeast(actor, 'mod')) reply(p, { t: 'a-err', op: t, msg: 'You do not have permission to run events', code: 'cap' });
      else audit('event.probe', actor, { op: t }, false);
      return true;
    }
    if (opTooFast(actor, at)) {
      stats.refused++;
      reply(p, { t: 'a-err', op: t, msg: 'Slow down a moment', code: 'slow' });
      return true;
    }

    const res = t === 'event-start' ? opStart(actor, m, at) : opStop(actor, m, at);
    if (res.ok) {
      const { ok, msg, ...rest } = res;
      reply(p, { t: 'a-ok', op: t, msg, ...rest });
    } else {
      reply(p, { t: 'a-err', op: t, msg: res.msg, code: res.code || 'refused' });
    }
    return true;
  } catch (e) {
    stats.errors++;
    console.error('[events] handleMessage failed:', e?.message || e);
    return true; // it was ours; a throw must not fall through to the main switch
  }
}

/**
 * Start an ad-hoc event. The payload runs through the SAME validator the file
 * does, so an operator cannot ship an effect the calendar could not express.
 */
function opStart(actor, m, at) {
  if (oneoffs.size >= MAX_ONEOFFS) return { ok: false, msg: 'Too many one-off events are already running', code: 'full' };
  const warnings = [];
  const warn = (x) => { if (warnings.length < 20) warnings.push(String(x)); };

  const id = slug(m.id, 48) || `oneoff-${Math.floor(at / 1000).toString(36)}`;
  if (cal.byId.has(id)) return { ok: false, msg: `'${id}' is a calendar event: give the one-off its own id`, code: 'args' };
  const name = text(m.name, NAME_MAX) || id;
  const durMin = clamp(Math.floor(num(m.durMin) ?? 60), 1, MAX_ONEOFF_MINS);
  const effects = validateEffects(m.effects, warn);
  if (!Object.keys(effects).length && !text(m.blurb, BLURB_MAX)) {
    return { ok: false, msg: `Nothing to run: no usable effects${warnings.length ? ` (${warnings[0]})` : ''}`, code: 'args' };
  }

  const rooms = Array.isArray(m.rooms) ? m.rooms.filter((r) => r === '*' || ROOM_IDS.includes(r)) : ['*'];
  const icon = slug(m.icon, 16);
  const o = {
    id,
    name,
    blurb: text(m.blurb, BLURB_MAX),
    icon: ICONS.has(icon) ? icon : '',
    rooms: rooms.length ? rooms : ['*'],
    effects,
    announce: m.announce ? vAnnounce(m.announce, warn) : null,
    startedAt: at,
    endsAt: at + durMin * MIN_MS,
    by: actor.name || '',
    oneoff: true,
  };
  oneoffs.set(id, o);
  saveOneoffs();
  stats.adminStarts++;
  audit('event.start', actor, { id, name, durMin, effects: Object.keys(effects), warnings: warnings.length });
  pushIfChanged(at, { force: true });
  return {
    ok: true,
    msg: `'${name}' is running for ${durMin} minute${durMin === 1 ? '' : 's'}`,
    id, endsAt: o.endsAt, effects: Object.keys(effects), warnings,
  };
}

/** Stop an ad-hoc event early. Calendar entries are stopped by editing the file. */
function opStop(actor, m, at) {
  const id = slug(m.id, 48);
  if (!id) return { ok: false, msg: 'Which event?', code: 'args' };
  if (!oneoffs.has(id)) {
    if (cal.byId.has(id)) return { ok: false, msg: `'${id}' comes from the calendar file: edit data/calendar.json to change it`, code: 'file' };
    return { ok: false, msg: `Nothing called '${id}' is running`, code: 'notfound' };
  }
  const o = oneoffs.get(id);
  oneoffs.delete(id);
  saveOneoffs();
  stats.adminStops++;
  audit('event.stop', actor, { id, name: o.name, ranMs: at - o.startedAt });
  pushIfChanged(at, { force: true });
  return { ok: true, msg: `'${o.name}' stopped`, id };
}

// ---------------------------------------------------------------------------
// test seams (used by test/events.test.js; harmless in production)
// ---------------------------------------------------------------------------

/** The parsed, validated calendar as plain data. Read-only by convention. */
export function calendar() {
  return { version: cal.version, rev: cal.rev, tz: cal.tz, warnings: [...cal.warnings], events: cal.events.map((e) => ({ ...e })) };
}

/** Every occurrence of `id` in the window around `at`, for the anchor tests. */
export function occurrencesOf(id, at = now()) {
  const ev = cal.byId.get(slug(id, 48));
  return ev ? occurrences(ev, at) : [];
}

/** The ET instant of hh:mm on the ET day containing `ms`. For the DST tests. */
export const wallInstant = (ms, hh, mi) => anchorAt(dayStartMs(ms), hh, mi);
