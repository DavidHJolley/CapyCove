/**
 * server/charms.js — the weekly charm hunt (wave 13E, NEXT-AAA N-30).
 *
 * One small object is hidden in one room's scenery. It changes every real week,
 * it never comes back, and finding it is worth a handful of coins and a line on
 * your profile card. That is the whole feature. It is the genre's proven
 * weekly-return trigger (genre.md section 4.4, a near-exact port of the Club
 * Penguin pin) and its proven world-tour driver: the room rotation is a fixed
 * stride through the outdoor rooms, so over seven weeks the hunt walks you
 * through every one of them.
 *
 * THE RULE THIS MODULE BENDS AROUND: the hunt never gates progress. Missing a
 * week costs nothing, takes nothing back and closes no door. There is no
 * streak, no "you missed it" toast, no charm that another system requires. A
 * player who never looks up loses a trinket and 120 coins against ~1,500-2,000
 * an hour of honest play. It is a delight, not a chore.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT WITH index.js (same install(ctx) shape progress.js/econ.js use)
 *
 *   charms.install({ users, saveSoon, grantCoins, sendTo, broadcastAll,
 *                    broadcastToRoom, recordFor, audit, requireCap, dataDir?, now? })
 *   charms.handleMessage(p, m)   first refusal; consumes 'charm', 'charm-claim'
 *                                and 'a-charm', nothing else.
 *   charms.profileBits(rec)      { charms:[...], charmCount } for publicProfile
 *                                and for the 'profile' (inspect) frame.
 *
 * Every ctx field is optional: a missing one degrades to a no-op rather than a
 * throw, so a half-wired boot still serves a readable (if inert) hunt.
 *
 * FRAMES (add to the CLAUDE.md registry when the wave ships)
 *   client -> server
 *     {t:'charm'}                       ask about this week's charm
 *     {t:'charm-claim'}                 "I am standing on it"  (carries NOTHING:
 *                                       the position used is the server's own
 *                                       p.x/p.y/p.z from the move stream)
 *     {t:'a-charm', op, ...}            operator: where / list / place / next / clear
 *   server -> client
 *     {t:'charm', week, ends, id, name, desc, hint, coins, claimed, found,
 *                 mine:[{id,name,week,at}], here, room?, x?, y?, z?, ok?, msg?}
 *     {t:'charm-found', name, charm, charmName, room, week, n, first}  (island-wide)
 *     {t:'a-ok'|'a-err', ...}           the operator answers, same shape admin.js uses
 *
 * WHY THE POSITION IS CONDITIONAL: `room`, `x`, `y` and `z` are sent ONLY to a
 * player standing in the charm's room (`here:true`). Everyone else gets the
 * rumour line — the same hint the Courier prints (genre.md section 4.4). The
 * charm is plainly visible once you are in the room, so this hides nothing from
 * an honest player; it just means reading the wire does not replace the walk.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES (judgment calls marked DECISION)
 *
 * DECISION - the week is a REAL week in America/New_York, derived from
 * server/progress.js's exported dayKey(). Day maths is never reimplemented
 * here: one clock for the whole live-ops stack (quests, streaks, backups, ban
 * notices and now charms all answer to the same midnight). Weeks start MONDAY,
 * because the operator calendar in NEXT-AAA moves the charm on Monday.
 *
 * DECISION - placement is DERIVED, not stored. week -> room -> spot -> charm is
 * a pure function of the week key and the tables below, so a server that has
 * never been touched still runs the hunt forever, and a restart mid-week puts
 * the charm back exactly where it was. Operators override a single week with
 * `a-charm place`; the override is the only thing that ever hits disk.
 *
 * DECISION - the room stride is `weekIndex * 3` over seven rooms. 3 and 7 are
 * coprime, so the hunt visits all seven rooms in seven weeks and never picks
 * the same room twice running. A hash would have done neither.
 *
 * DECISION - a guest who clicks the charm is told warmly to make an account and
 * NOTHING else happens: the charm stays where it is, glinting, and they can
 * claim it the moment they sign up (as long as the week has not turned). No
 * cap, no cooldown, no penalty for having been a guest.
 *
 * DECISION - the claim pays through ctx.grantCoins, so the hourly backstop
 * still bounds the faucet, and the charm is written to the record FIRST. If the
 * backstop refuses the coins (it will not, for an honest player, at 120 a
 * week), the player still keeps the charm. Losing the trinket to a coin ceiling
 * would be exactly the kind of quiet punishment this game does not do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dayKey, dayStartMs } from './progress.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// tunables
// ---------------------------------------------------------------------------

/** The find. A warm weekly moment, never an income: ~4% of an honest hour. */
const CLAIM_COINS = 120;
/** How close you must stand, in metres. Generous on purpose: the charm is a
 *  delight, not a pixel-hunt, and hotspot prompts already arm at 2.5. */
const CLAIM_RADIUS = 3.2;
/** Vertical slack for the rooms that have a y (The Drift's water column). */
const CLAIM_Y = 4.0;
/** Reads and claim attempts per second, per player. */
const READ_BURST = 4;
const CLAIM_BURST = 3;
/** Charms kept on a record. 52 a year: five years before this ever bites, and
 *  a record is never trimmed silently below it. */
const BOARD_CAP = 260;
/** How many of them ride a profile card / the welcome frame. The count is
 *  always exact; the list is the newest few, because a five-year board on every
 *  hello is a kilobyte nobody reads. */
const CARD_CHARMS = 24;
/** Weeks of operator overrides kept on disk (a quarter of scheduling, twice). */
const OVERRIDE_CAP = 40;

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** 1970-01-01 was a Thursday, so day index 4 (1970-01-05) is the first Monday. */
const MONDAY_EPOCH = 4;
/** Stride through ROOMS. Coprime with ROOMS.length: full tour, no repeats. */
const ROOM_STRIDE = 3;

const own = (obj, key) => !!obj && typeof key === 'string'
  && Object.prototype.hasOwnProperty.call(obj, key);

// ---------------------------------------------------------------------------
// the data table: where a charm may hide
// ---------------------------------------------------------------------------

/**
 * Candidate spots, at least three per outdoor room (NEXT-AAA 13E). Coordinates
 * are room-space x/z; `y` is only given where a downward raycast onto the room
 * floor cannot answer the question (The Drift is a water column, not a floor).
 *
 * `hint` is the rumour the Courier prints and the only thing a player outside
 * the room is told. Spot ids are stable: an operator schedules a week by naming
 * one (`a-charm place room=beach spot=dock-plank`), so renaming one is a
 * breaking change to somebody's calendar.
 *
 * Adding a room: append it here. The stride is recomputed from the list length
 * at call time, so the tour simply gets longer. Keep ROOM_STRIDE coprime with
 * the new length (3 works for every length that is not a multiple of 3).
 */
export const ROOMS = Object.freeze([
  {
    id: 'plaza',
    name: 'the Plaza',
    hint: 'Rumour has it something bright is lying where the cove is busiest.',
    spots: [
      { id: 'fountain-step', x: 2.6, z: -1.2 },
      { id: 'cafe-gate-post', x: 8.2, z: 3.4 },
      { id: 'west-planter', x: -7.4, z: 3.2 },
      { id: 'south-cobbles', x: 2.2, z: 7.4 },
    ],
  },
  {
    id: 'beach',
    name: 'the Beach',
    hint: 'Rumour has it the tide left something behind on the sand.',
    spots: [
      { id: 'driftwood-log', x: 2.0, z: -8.2 },
      { id: 'bonfire-stones', x: 5.4, z: -4.2 },
      { id: 'dock-plank', x: -15.8, z: -2.4 },
      { id: 'tide-line', x: -6.0, z: 5.2 },
    ],
  },
  {
    id: 'peak',
    name: 'Frosty Peak',
    hint: 'Rumour has it something is half-buried in the snow up on the mountain.',
    spots: [
      { id: 'sled-rack', x: 3.4, z: -6.2 },
      { id: 'lodge-porch', x: 9.4, z: 4.2 },
      { id: 'snow-capy', x: -4.6, z: 6.4 },
      { id: 'adit-path', x: -7.2, z: 9.0 },
    ],
  },
  {
    id: 'jungle',
    name: 'the Jungle',
    hint: 'Rumour has it the ferns are hiding something small and shiny.',
    spots: [
      { id: 'pool-stones', x: -6.0, z: -2.0 },
      { id: 'drum-log', x: 4.6, z: -6.4 },
      { id: 'fern-gap', x: 1.6, z: 9.4 },
      { id: 'vine-arch', x: -5.0, z: 6.6 },
    ],
  },
  {
    id: 'mine',
    name: 'the Glimmer Mine',
    hint: 'Rumour has it a lamp is catching on something down in the workings.',
    spots: [
      { id: 'deck-rail', x: 5.2, z: -6.0 },
      { id: 'cart-track', x: -4.2, z: 1.8 },
      { id: 'lamp-post', x: 3.0, z: 3.6 },
      { id: 'ore-pile', x: -6.4, z: -3.4 },
    ],
  },
  {
    id: 'speedway',
    name: 'the Speedway',
    hint: 'Rumour has it something rolled loose in the paddock.',
    spots: [
      { id: 'pit-wall', x: -8.0, z: -2.0 },
      { id: 'trophy-shelf', x: 6.0, z: 1.0 },
      { id: 'paddock-gate', x: 0.0, z: 10.5 },
      { id: 'tyre-stack', x: -12.0, z: 4.0 },
    ],
  },
  {
    id: 'drift',
    name: 'The Drift',
    hint: 'Rumour has it something is turning slowly, somewhere in the blue.',
    spots: [
      // A water column: a floor raycast has nothing to hit, so these carry y.
      { id: 'bell-cable', x: 0, y: 5.6, z: 2.5 },
      { id: 'kelp-tips', x: -6.5, y: 3.2, z: -2.0 },
      { id: 'sand-shelf', x: 5.0, y: 1.6, z: -4.5 },
    ],
  },
]);

const ROOM_BY_ID = new Map(ROOMS.map((r) => [r.id, r]));

/**
 * The charms themselves. Small, findable, worthless-and-therefore-precious
 * things: the genre's whole trick (genre.md section 4.4). 26 of them is half a
 * year before the pool comes round again, and a re-run reads as nostalgia
 * rather than as a repeat — but the catalogue is meant to grow, and appending
 * to it never disturbs a week that already happened, because the index is taken
 * modulo the length at read time only.
 *
 * `color` is the client tint (src/world/charm.js). `shape` is a hint the
 * renderer may honour; unknown shapes fall back to the default bauble.
 */
export const CATALOG = Object.freeze([
  { id: 'seaglass', name: 'Sea Glass Bead', desc: 'Frosted green, worn smooth by about a thousand tides.', color: 0x8fd6c4, shape: 'bead' },
  { id: 'pinecone', name: 'Tiny Pinecone', desc: 'Small enough to sit in one paw. Smells faintly of the peak.', color: 0xa9793f, shape: 'cone' },
  { id: 'mitten', name: 'Lost Mitten', desc: 'One red mitten. Somebody up the mountain is down to one.', color: 0xd8595b, shape: 'soft' },
  { id: 'bottlecap', name: 'Old Bottle Cap', desc: 'Crimped tin, the paint mostly gone. It rattles nicely.', color: 0xd9c06a, shape: 'disc' },
  { id: 'pebble', name: 'River Pebble', desc: 'Grey with one perfect white stripe all the way round.', color: 0xb9bec7, shape: 'bead' },
  { id: 'feather', name: 'Gull Feather', desc: 'Still faintly salty. Very good for tickling.', color: 0xf1efe6, shape: 'soft' },
  { id: 'button', name: 'Brass Button', desc: 'Off a coat nobody remembers. Polishes up beautifully.', color: 0xd7a94b, shape: 'disc' },
  { id: 'acorn', name: 'Lucky Acorn', desc: 'Cap still on, which everyone agrees is the lucky part.', color: 0x9a6b3a, shape: 'cone' },
  { id: 'marble', name: 'Cloudy Marble', desc: 'A little weather system trapped in glass.', color: 0x7fa9e8, shape: 'bead' },
  { id: 'shell', name: 'Spiral Shell', desc: 'Hold it to your ear and you get the cove, which is right there.', color: 0xe9d5b8, shape: 'spiral' },
  { id: 'coin', name: 'Bent Coin', desc: 'Not legal tender anywhere. Worth keeping anyway.', color: 0xe0b654, shape: 'disc' },
  { id: 'key', name: 'Little Brass Key', desc: 'Opens nothing anyone has found yet.', color: 0xc9a04a, shape: 'key' },
  { id: 'ribbon', name: 'Frayed Ribbon', desc: 'Faded to a very soft pink. Ties in a passable bow.', color: 0xe6a3bd, shape: 'soft' },
  { id: 'quartz', name: 'Quartz Sliver', desc: 'From the mine, probably. Catches the lamps.', color: 0xdcecf5, shape: 'shard' },
  { id: 'pressedleaf', name: 'Pressed Leaf', desc: 'Flat as paper and twice as delicate.', color: 0x8fbf6a, shape: 'soft' },
  { id: 'clothespin', name: 'Wooden Clothespin', desc: 'Springy. Excellent on a nose, briefly.', color: 0xc9a878, shape: 'stick' },
  { id: 'seedpod', name: 'Rattly Seed Pod', desc: 'Shake it and the whole jungle answers.', color: 0x9c8a4e, shape: 'cone' },
  { id: 'sparkplug', name: 'Spare Spark Plug', desc: 'From the paddock. Somebody will want it back eventually.', color: 0xb8bcc4, shape: 'stick' },
  { id: 'snowglobe', name: 'Thumb-sized Snow Globe', desc: 'One tiny capybara, permanently in a blizzard.', color: 0xcfe8f7, shape: 'bead' },
  { id: 'fishhook', name: 'Bent Fish Hook', desc: 'Blunted on purpose, ages ago. Safe as anything.', color: 0xa9b2bb, shape: 'key' },
  { id: 'chalk', name: 'Nub of Chalk', desc: 'Plaza blue. Good for exactly four drawings.', color: 0x86b9e0, shape: 'stick' },
  { id: 'starfish', name: 'Small Starfish', desc: 'Dried, five-pointed, faintly orange.', color: 0xe89a5c, shape: 'star' },
  { id: 'cog', name: 'Little Cog', desc: 'Eleven teeth. Fits nothing in the cove.', color: 0xa08d6f, shape: 'disc' },
  { id: 'lantern', name: 'Toy Lantern', desc: 'No bigger than a berry, and it still glows a bit.', color: 0xf2c96b, shape: 'lantern' },
  { id: 'thimble', name: 'Dented Thimble', desc: 'Silver once. Now a very small cup.', color: 0xc6ccd4, shape: 'bead' },
  { id: 'pearl', name: 'Freshwater Pearl', desc: 'Not perfectly round, which is the good kind.', color: 0xf3ecdf, shape: 'bead' },
]);

const CHARM_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const S = {
  installed: false,
  users: null,
  saveSoon: () => {},
  grantCoins: null,
  sendTo: () => {},
  broadcastAll: null,
  broadcastToRoom: null,
  recordFor: null,
  auditFn: null,
  requireCap: null,
  now: () => Date.now(),
  file: '',
  /** week key -> { room, spot, charm }, the operator's word over the table. */
  overrides: new Map(),
  /** week key -> { n, first } finders this boot (the celebration counter). */
  found: new Map(),
  /** player -> { reads:{n,at}, claims:{n,at} } */
  rate: new WeakMap(),
  stats: null,
};

function blankStats() {
  return {
    reads: 0, claims: 0, paid: 0, coins: 0,
    refusedRoom: 0, refusedFar: 0, refusedDup: 0, refusedGuest: 0, refusedRate: 0,
    placed: 0, cleared: 0, errors: 0,
  };
}
S.stats = blankStats();

/** Boot. Safe to call twice (tests do); every field is optional. */
export function install(ctx = {}) {
  const c = ctx || {};
  S.installed = true;
  S.users = c.users instanceof Map ? c.users : null;
  S.saveSoon = typeof c.saveSoon === 'function' ? c.saveSoon : () => {};
  S.grantCoins = typeof c.grantCoins === 'function' ? c.grantCoins : null;
  S.sendTo = typeof c.sendTo === 'function' ? c.sendTo : () => {};
  S.broadcastAll = typeof c.broadcastAll === 'function' ? c.broadcastAll : null;
  S.broadcastToRoom = typeof c.broadcastToRoom === 'function' ? c.broadcastToRoom : null;
  S.recordFor = typeof c.recordFor === 'function' ? c.recordFor : null;
  S.auditFn = typeof c.audit === 'function' ? c.audit : null;
  S.requireCap = typeof c.requireCap === 'function' ? c.requireCap : null;
  S.now = typeof c.now === 'function' ? c.now : () => Date.now();
  S.rate = new WeakMap();
  S.found = new Map();
  S.overrides = new Map();
  S.stats = blankStats();

  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.join(ROOT, 'data'));
  S.file = c.file === null ? '' : (c.file ? path.resolve(c.file) : path.join(dataDir, 'charms.json'));
  loadOverrides();
  return S;
}

/** Counters for /api/health and the tests. */
export function stats() {
  return { ...S.stats, overrides: S.overrides.size, week: weekKey(S.now()) };
}

// ---------------------------------------------------------------------------
// the week
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' -> whole days since the unix epoch. Timezone-free by then. */
function dayIndexOf(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return 0;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}

/**
 * Which week (Monday-based, America/New_York) contains `ms`.
 *
 * Everything time-shaped here goes through server/progress.js's dayKey() rather
 * than doing its own arithmetic: that function already knows about DST, about
 * small-icu builds, and about agreeing with the quest board. A week is then
 * just seven of its days, and the two can never drift.
 */
export function weekIndex(ms = S.now()) {
  return Math.floor((dayIndexOf(dayKey(ms)) - MONDAY_EPOCH) / WEEK_DAYS);
}

/** The week's stable name: the ET Monday that opened it, 'YYYY-MM-DD'. */
export function weekKey(ms = S.now()) {
  const dt = new Date((weekIndex(ms) * WEEK_DAYS + MONDAY_EPOCH) * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * When this week ends: the instant ET midnight opens the next Monday.
 *
 * Walked one day at a time through dayStartMs() instead of adding 7*24h,
 * because two weeks a year are 167 or 169 hours long and a countdown that is an
 * hour out on a Sunday night is a countdown that lies at exactly the moment
 * somebody is racing it.
 */
export function weekEndMs(ms = S.now()) {
  const wk = weekIndex(ms);
  let t = dayStartMs(ms);
  for (let i = 0; i < WEEK_DAYS + 1; i++) {
    const next = dayStartMs(t + 26 * 3_600_000); // 26h always lands in the next day
    if (weekIndex(next) !== wk) return next;
    t = next;
  }
  return ms + WEEK_DAYS * DAY_MS; // unreachable; never return something absurd
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

/**
 * Where this week's charm is, and which charm it is.
 *
 * Pure: same week key in, same answer out, on any process, forever. An operator
 * override for that week wins, and is validated on the way out as well as on
 * the way in (a hand-edited charms.json can never place a charm in a room that
 * does not exist).
 *
 * @returns {{week, wk, room, roomName, hint, spot, x, y, z, charm, name, desc,
 *            color, shape, override, ends}}
 */
export function currentCharm(ms = S.now()) {
  const week = weekKey(ms);
  const wk = weekIndex(ms);
  const ov = S.overrides.get(week);

  let room = null;
  let spot = null;
  let charm = null;

  if (ov) {
    room = ROOM_BY_ID.get(ov.room) || null;
    spot = room ? room.spots.find((s) => s.id === ov.spot) || null : null;
    charm = CHARM_BY_ID.get(ov.charm) || null;
  }
  if (!room || !spot) {
    // The tour: a fixed coprime stride, so seven weeks visit seven rooms and
    // no two consecutive weeks share one.
    const idx = ((wk * ROOM_STRIDE) % ROOMS.length + ROOMS.length) % ROOMS.length;
    room = ROOMS[idx];
    spot = room.spots[hash32(`${week}:${room.id}`) % room.spots.length];
  }
  if (!charm) {
    const ci = ((wk % CATALOG.length) + CATALOG.length) % CATALOG.length;
    charm = CATALOG[ci];
  }

  return {
    week, wk,
    room: room.id, roomName: room.name, hint: room.hint,
    spot: spot.id,
    x: spot.x, y: typeof spot.y === 'number' ? spot.y : null, z: spot.z,
    charm: charm.id, name: charm.name, desc: charm.desc,
    color: charm.color, shape: charm.shape,
    override: !!ov,
    ends: weekEndMs(ms),
  };
}

// ---------------------------------------------------------------------------
// the record: a charm board that only ever grows
// ---------------------------------------------------------------------------

/** READ-ONLY view of a record's board. Deliberately does NOT create the array:
 *  merely looking at a card must never dirty a record (and must never make a
 *  test that asserts "nothing was written" pass for the wrong reason). */
function boardOf(rec) {
  return rec && Array.isArray(rec.charms) ? rec.charms : [];
}

/** The writable board, created on the first actual find. */
function ensureBoard(rec) {
  if (!Array.isArray(rec.charms)) rec.charms = [];
  return rec.charms;
}

/**
 * The profile ride-along, in the shape server/admin.js's profileBits() uses:
 * spread into publicProfile() (and into the 'profile' inspect frame) and the
 * charm board is visible everywhere a card is drawn, with no other plumbing.
 * Returns COPIES — two sessions on one account must never share an array.
 */
export function profileBits(rec, { limit = CARD_CHARMS } = {}) {
  const board = boardOf(rec);
  const shown = limit > 0 ? board.slice(-limit) : board.slice();
  return {
    // newest first: a card shows the top row and the count says how deep it goes
    charms: shown.reverse().map((c) => ({ id: c.id, name: c.name, week: c.week, at: c.at })),
    charmCount: board.length,
  };
}

/** Has this account already found the charm for `week`? */
export function hasClaimed(rec, week) {
  return boardOf(rec).some((c) => c && c.week === week);
}

// ---------------------------------------------------------------------------
// operator overrides (the only thing that touches disk)
// ---------------------------------------------------------------------------

function loadOverrides() {
  S.overrides.clear();
  if (!S.file) return;
  let raw;
  try { raw = fs.readFileSync(S.file, 'utf8'); } catch { return; } // absent is normal
  try {
    const doc = JSON.parse(raw);
    const weeks = doc && typeof doc.weeks === 'object' && !Array.isArray(doc.weeks) ? doc.weeks : {};
    for (const key of Object.keys(weeks)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const v = weeks[key];
      if (!v || typeof v !== 'object') continue;
      const room = ROOM_BY_ID.get(String(v.room || ''));
      if (!room) continue;
      const spot = room.spots.find((s) => s.id === String(v.spot || ''));
      if (!spot) continue;
      const charm = CHARM_BY_ID.get(String(v.charm || ''));
      S.overrides.set(key, { room: room.id, spot: spot.id, charm: charm ? charm.id : '' });
    }
  } catch (e) {
    console.warn('[charms] ignoring unreadable', S.file, e?.message || e);
  }
}

function saveOverrides() {
  if (!S.file) return;
  // Keep the file small and forward-looking: past weeks are history nobody can
  // replay, so only the newest OVERRIDE_CAP keys survive a write.
  const keys = [...S.overrides.keys()].sort().slice(-OVERRIDE_CAP);
  const weeks = {};
  for (const k of keys) weeks[k] = S.overrides.get(k);
  const body = JSON.stringify({ v: 1, weeks }, null, 2);
  const tmp = `${S.file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(S.file), { recursive: true });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, S.file); // atomic enough: the reader only ever sees one
  } catch (e) {
    console.warn('[charms] cannot write', S.file, e?.message || e);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/**
 * Place (or re-place) the charm for one week. Used by the a-charm op and
 * directly by the tests.
 * @returns {{ok:true, ...currentCharm}|{ok:false, msg:string}}
 */
export function place({ week, room, spot, charm } = {}) {
  const wkey = /^\d{4}-\d{2}-\d{2}$/.test(String(week || '')) ? String(week) : weekKey(S.now());
  const r = ROOM_BY_ID.get(String(room || ''));
  if (!r) return { ok: false, msg: `No such room. Try: ${ROOMS.map((x) => x.id).join(', ')}` };
  let s = r.spots.find((x) => x.id === String(spot || ''));
  if (!s && Number.isInteger(Number(spot))) s = r.spots[Number(spot)];
  if (!s) return { ok: false, msg: `No such spot in ${r.id}. Try: ${r.spots.map((x) => x.id).join(', ')}` };
  const c = charm ? CHARM_BY_ID.get(String(charm)) : null;
  if (charm && !c) return { ok: false, msg: 'No charm by that id (a-charm list shows them).' };

  S.overrides.set(wkey, { room: r.id, spot: s.id, charm: c ? c.id : '' });
  saveOverrides();
  S.stats.placed++;
  return { ok: true, ...currentCharmFor(wkey) };
}

/** Drop an override, restoring the derived placement for that week. */
export function clearPlacement(week) {
  const wkey = /^\d{4}-\d{2}-\d{2}$/.test(String(week || '')) ? String(week) : weekKey(S.now());
  const had = S.overrides.delete(wkey);
  if (had) { saveOverrides(); S.stats.cleared++; }
  return had;
}

/**
 * currentCharm() for a week that is not necessarily now. Only the operator
 * surface needs this (scheduling next Monday from this Thursday).
 */
function currentCharmFor(wkey) {
  const di = dayIndexOf(wkey);
  // noon ET-ish on that Monday: any instant inside the week gives the same answer
  return currentCharm(di * DAY_MS + 16 * 3_600_000);
}

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

function limited(p, kind, max) {
  let r = S.rate.get(p);
  if (!r) { r = { read: { n: 0, at: 0 }, claim: { n: 0, at: 0 } }; S.rate.set(p, r); }
  const b = r[kind];
  const now = S.now();
  if (now - b.at > 1000) { b.at = now; b.n = 0; }
  return ++b.n > max;
}

/** The state frame, tailored to who is asking and where they are standing. */
function stateFrame(p, extra = {}) {
  const now = S.now();
  const cur = currentCharm(now);
  const rec = p && S.recordFor ? S.recordFor(p) : null;
  const claimed = hasClaimed(rec, cur.week);
  const here = !!p && p.room === cur.room;
  const board = boardOf(rec);
  const tally = S.found.get(cur.week);

  const frame = {
    t: 'charm',
    week: cur.week,
    ends: cur.ends,
    id: cur.charm,
    name: cur.name,
    desc: cur.desc,
    color: cur.color,
    shape: cur.shape,
    hint: cur.hint,
    coins: CLAIM_COINS,
    claimed,
    guest: !rec,
    found: tally ? tally.n : 0,
    // The board for your own card, in exactly the shape the profile ride-along
    // uses, so the HUD has one renderer for both. Newest first.
    mine: profileBits(rec, { limit: 12 }).charms,
    charmCount: board.length,
    // Position ONLY for a player standing in the room, and only while it is
    // still there to find (see the header note).
    here: here && !claimed,
  };
  if (frame.here) {
    frame.room = cur.room;
    frame.x = cur.x;
    frame.y = cur.y;
    frame.z = cur.z;
    frame.spot = cur.spot;
  }
  return { ...frame, ...extra };
}

function send(p, extra) {
  try { S.sendTo(p, stateFrame(p, extra)); } catch { /* a dead socket is not our problem */ }
}

function toast(p, msg) {
  try { S.sendTo(p, { t: 'toast', msg }); } catch { /* ditto */ }
}

function audit(op, actor, target, args, ok = true) {
  if (!S.auditFn) return;
  try { S.auditFn({ actor, op, target, args, ok }); } catch { /* never fatal */ }
}

/**
 * The claim. Validated by ROOM and by PROXIMITY, using the server's own copy of
 * the player's position (the 'move' stream), never anything on this frame.
 */
export function claim(p) {
  if (!p) return { ok: false, code: 'none' };
  const now = S.now();
  const cur = currentCharm(now);
  S.stats.claims++;

  if (p.room !== cur.room) {
    S.stats.refusedRoom++;
    return { ok: false, code: 'room', msg: 'The charm is not in this room.' };
  }
  const dx = (Number(p.x) || 0) - cur.x;
  const dz = (Number(p.z) || 0) - cur.z;
  if (Math.hypot(dx, dz) > CLAIM_RADIUS) {
    S.stats.refusedFar++;
    return { ok: false, code: 'far', msg: 'Get a little closer to it first.' };
  }
  if (cur.y !== null && Math.abs((Number(p.y) || 0) - cur.y) > CLAIM_Y) {
    S.stats.refusedFar++;
    return { ok: false, code: 'far', msg: 'Swim a little nearer to it first.' };
  }

  const rec = S.recordFor ? S.recordFor(p) : null;
  if (!rec) {
    // The warm door, not a wall: the charm stays exactly where it is.
    S.stats.refusedGuest++;
    return {
      ok: false,
      code: 'guest',
      msg: 'What a find! Charms need a pocket to live in — make a free account and it is yours.',
    };
  }
  if (hasClaimed(rec, cur.week)) {
    S.stats.refusedDup++;
    return { ok: false, code: 'dup', msg: `You already found this week's charm: ${cur.name}.` };
  }

  // Record FIRST, coins second: the trinket is the reward that must never be
  // lost to an economy ceiling (see the header DECISION).
  const board = ensureBoard(rec);
  board.push({ id: cur.charm, name: cur.name, week: cur.week, at: now });
  if (board.length > BOARD_CAP) board.splice(0, board.length - BOARD_CAP);
  S.saveSoon();

  let paid = 0;
  if (S.grantCoins) {
    try { paid = Number(S.grantCoins(p, CLAIM_COINS, 'charm')) || 0; } catch { paid = 0; }
  }
  S.stats.paid++;
  S.stats.coins += paid;

  const tally = S.found.get(cur.week) || { n: 0, first: '' };
  tally.n++;
  if (!tally.first) tally.first = p.name || '';
  S.found.set(cur.week, tally);

  audit('charm.claim', { uid: rec.uid, name: rec.username }, { id: cur.charm },
    { week: cur.week, room: cur.room, spot: cur.spot, coins: paid, n: tally.n });

  return { ok: true, cur, coins: paid, n: tally.n, first: tally.n === 1 };
}

/** The island-wide celebration. 13D's HUD owns how it looks. */
function celebrate(p, res) {
  if (!S.broadcastAll) return;
  const cur = res.cur;
  try {
    S.broadcastAll({
      t: 'charm-found',
      name: p.name || '',
      id: p.id,
      charm: cur.charm,
      charmName: cur.name,
      room: cur.room,
      roomName: cur.roomName,
      week: cur.week,
      n: res.n,
      first: res.first,
    });
  } catch { /* never fatal */ }
}

// ---------------------------------------------------------------------------
// the operator surface: a-charm
// ---------------------------------------------------------------------------

/**
 * `a-charm` never reaches server/admin.js's op table (that module returns false
 * for an a-* name it does not own), so the whole op lives here — capability
 * checked against the SAME gate every other op uses, and audited the same way.
 *
 * Caps, deliberately reusing the existing vocabulary rather than inventing one
 * this module cannot register (server/admin.js is not ours to edit):
 *   read  ('where'|'list')  -> 'who'      : any mod may see where it is
 *   write ('place'|'next'|'clear') -> 'editor' : admin only, like every other
 *                                        act that moves something in a room
 * A follow-up may add a first-class 'charm' cap; nothing here has to change but
 * the two strings.
 */
function performOp(p, m) {
  const op = typeof m.op === 'string' ? m.op : 'where';
  const canRead = S.requireCap ? S.requireCap(p, 'who') : false;
  const canWrite = S.requireCap ? S.requireCap(p, 'editor') : false;
  if (!canRead && !canWrite) return { ok: false, code: 'silent' }; // a probe gets nothing

  switch (op) {
    case 'where': {
      const cur = m.week ? currentCharmFor(String(m.week)) : currentCharm(S.now());
      const tally = S.found.get(cur.week);
      return {
        ok: true,
        msg: `Week ${cur.week}: ${cur.name} at ${cur.room}/${cur.spot}${cur.override ? ' (placed)' : ''}`,
        ...cur,
        found: tally ? tally.n : 0,
      };
    }
    case 'list':
      return {
        ok: true,
        msg: 'Rooms, spots and charms.',
        rooms: ROOMS.map((r) => ({ id: r.id, name: r.name, spots: r.spots.map((s) => s.id) })),
        charms: CATALOG.map((c) => ({ id: c.id, name: c.name })),
        weeks: [...S.overrides.entries()].sort().map(([week, v]) => ({ week, ...v })),
      };
    case 'place': {
      if (!canWrite) return { ok: false, code: 'cap', msg: 'Placing the charm needs the editor capability.' };
      const res = place({ week: m.week, room: m.room, spot: m.spot, charm: m.charm });
      if (!res.ok) return { ok: false, code: 'args', msg: res.msg };
      audit('charm.place', actorOf(p), { id: res.charm }, { week: res.week, room: res.room, spot: res.spot });
      refresh(res);
      return { ok: true, msg: `Week ${res.week}: ${res.name} now at ${res.room}/${res.spot}`, ...res };
    }
    case 'next': {
      // "Rotate it" — the two-second version of place: same room, next spot.
      if (!canWrite) return { ok: false, code: 'cap', msg: 'Moving the charm needs the editor capability.' };
      const cur = m.week ? currentCharmFor(String(m.week)) : currentCharm(S.now());
      const room = ROOM_BY_ID.get(cur.room);
      const at = room.spots.findIndex((s) => s.id === cur.spot);
      const next = room.spots[(at + 1) % room.spots.length];
      const res = place({ week: cur.week, room: room.id, spot: next.id, charm: m.charm || cur.charm });
      if (!res.ok) return { ok: false, code: 'args', msg: res.msg };
      audit('charm.place', actorOf(p), { id: res.charm }, { week: res.week, room: res.room, spot: res.spot, via: 'next' });
      refresh(res);
      return { ok: true, msg: `Moved to ${res.room}/${res.spot}`, ...res };
    }
    case 'clear': {
      if (!canWrite) return { ok: false, code: 'cap', msg: 'Clearing a placement needs the editor capability.' };
      const week = m.week ? String(m.week) : weekKey(S.now());
      const had = clearPlacement(week);
      const cur = currentCharmFor(week);
      audit('charm.clear', actorOf(p), null, { week, had });
      refresh(cur);
      return { ok: true, msg: had ? `Placement cleared; back to ${cur.room}/${cur.spot}` : 'Nothing was placed for that week.', ...cur };
    }
    default:
      return { ok: false, code: 'args', msg: 'a-charm op: where | list | place | next | clear' };
  }
}

function actorOf(p) {
  const rec = S.recordFor ? S.recordFor(p) : null;
  return rec ? { uid: rec.uid, name: rec.username } : { name: p?.name || '' };
}

/**
 * A placement changed under live players: tell the room it left and the room it
 * arrived in, so a charm never lingers on somebody's screen after it moved.
 * Nothing is broadcast island-wide — an unasked-for frame in a room the charm
 * is not in would just be noise (and would leak the answer).
 */
function refresh(cur) {
  if (!S.broadcastToRoom) return;
  // A nudge, not the answer: {refresh:true} carries no position, so it can go
  // to every hunt room without leaking anything. The client re-asks and each
  // player gets exactly the frame they are owed — including the players in the
  // room the charm just LEFT, who need to be told to put it away.
  for (const r of ROOMS) {
    try { S.broadcastToRoom(r.id, { t: 'charm', refresh: true, week: cur.week }); } catch { /* ignore */ }
  }
}

/**
 * First refusal, in the shape index.js already dispatches. Consumes exactly
 * three frame names and never anything else.
 */
export function handleMessage(p, m) {
  if (!S.installed || !p || !m || typeof m.t !== 'string') return false;
  const t = m.t;
  if (t !== 'charm' && t !== 'charm-claim' && t !== 'a-charm') return false;

  try {
    if (t === 'charm') {
      if (limited(p, 'read', READ_BURST)) { S.stats.refusedRate++; return true; }
      S.stats.reads++;
      send(p);
      return true;
    }

    if (t === 'charm-claim') {
      if (limited(p, 'claim', CLAIM_BURST)) { S.stats.refusedRate++; return true; }
      const res = claim(p);
      if (res.ok) {
        celebrate(p, res);
        send(p, { ok: true, found: res.n, gained: res.coins });
        toast(p, res.coins > 0
          ? `You found the ${res.cur.name}! +${res.coins} coins`
          : `You found the ${res.cur.name}!`);
      } else {
        if (res.msg) toast(p, res.msg);
        send(p, { ok: false, code: res.code, msg: res.msg || '' });
      }
      return true;
    }

    // a-charm
    const res = performOp(p, m);
    if (res.ok) {
      const { ok, msg, ...rest } = res;
      S.sendTo(p, { t: 'a-ok', op: 'a-charm', msg, ...rest });
    } else if (res.code !== 'silent') {
      S.sendTo(p, { t: 'a-err', op: 'a-charm', msg: res.msg, code: res.code });
    }
    return true;
  } catch (e) {
    S.stats.errors++;
    console.error('[charms] handleMessage failed:', e?.message || e);
    return true; // consumed: a throw must never fall through into the main switch
  }
}

/** Push the current state at a player unprompted (hello / room join parity). */
export function frameFor(p) {
  try { return stateFrame(p); } catch { return null; }
}

export default {
  install, handleMessage, frameFor, profileBits, currentCharm, claim,
  place, clearPlacement, hasClaimed, weekKey, weekIndex, weekEndMs, stats,
  ROOMS, CATALOG, CLAIM_COINS, CLAIM_RADIUS,
};

export { CLAIM_COINS, CLAIM_RADIUS };
