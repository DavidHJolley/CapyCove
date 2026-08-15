/**
 * server/stats.js — the aggregate stats tee (wave 13B, liveops.md §5.3 + §6).
 *
 * THE ONE IDEA: the island already funnels every meaningful player action
 * through three functions in server/index.js — `signal()`, `grantCoins()` and
 * the hello/close pair that opens and shuts a session. Tee those, and
 * everything worth counting is counted, once, in one place. Nothing here ever
 * reaches into a feature module and nothing here is ever the reason a frame
 * did not send.
 *
 * Contract with index.js (same shape as server/progress.js and server/audit.js
 * so the wiring reads the same everywhere; index.js is orchestrator-owned, this
 * module never edits it):
 *   install(ctx)                once at boot
 *   sessionOpen(p)              a live connection joined the world (hello)
 *   sessionClose(p)             ws 'close'
 *   signal(name, p, data)       beside progress.signal, inside signal()
 *   grant(p, paid, reason)      inside grantCoins, on the paid path only
 *   spend(p, price, sink)       the two purchase sites ('hat', 'furniture')
 *   observe(p, m)               a read-only look at raw frames; NEVER consumes
 *   tick()                      optional; rollover + flush also happen lazily
 *   flush() / sweep() / stats() / close(weekId) / shutdown()
 *
 * EVERY entry point is wrapped and returns a harmless value on failure. A bug
 * in the counters must never cost a player their coins, their frame or their
 * session. That is not politeness, it is the reason this may be wired into the
 * hot path at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT LANDS ON DISK
 *
 *   <dataDir>/stats/stats-YYYY-MM-DD.ndjson    one JSON object per line
 *   <dataDir>/stats/week-YYYY-Www.json         frozen weekly rollup
 *   <dataDir>/stats/.salt                      per-install hashing salt
 *
 * Days are REAL America/New_York calendar days, from progress.dayKey(): the
 * quest board, the login streak, the backup rotation and this file all agree
 * about what "today" means, because there is exactly one implementation of it
 * (server/progress.js) and everything imports that one. Weeks are ISO weeks
 * (Monday start) over those ET day keys.
 *
 * A line is tiny and deliberately dull:
 *
 *   {"t":1786...,"k":"open","u":"3f0a91c2","h":20,"n":1}
 *   {"t":1786...,"k":"coin","u":"3f0a91c2","n":74,"r":"fishing"}
 *   {"t":1786...,"k":"mg","u":"3f0a91c2","g":"fishing"}
 *   {"t":1786...,"k":"sess","u":"3f0a91c2","ms":1840000}
 *
 * Field glossary (short on purpose; a week is millions of these):
 *   t  ms epoch    k  kind (KINDS below)      u  salted account handle
 *   gu 1 = guest, no account handle at all    h  ET hour 0-23
 *   n  a count or amount   r  grant reason    s  sink   g  game id
 *   c  coins paid for a run                   ms session length
 *
 * NDJSON because it appends without rewriting anything (users.json rewrites
 * whole; that is audit F-1's problem and this file refuses to inherit it), and
 * because a week is a few MB that `node --test`-era Node reads with nothing
 * installed. Appends go through one fd opened 'a' with a batched fsync, so a
 * crash costs at most the last couple of seconds of counters and can never
 * leave a half-written line in front of a good one.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY (liveops.md §6.4, and the position the whole server already takes)
 *
 *  - `u` is a SALTED hash of the account key, never the username. The log is
 *    not a directory of who plays this game. The salt is generated once per
 *    install and never leaves the disk, so the hashes are not a rainbow table
 *    over a list of names either.
 *  - Guests have no `u` at all: they are counted as a session and nothing else.
 *  - NO chat content. Not the text, not its length, not who it was aimed at.
 *    `signal('chat')` becomes the number 1.
 *  - No IPs, no user agents, no per-player behavioural history, no third party,
 *    nothing that leaves this disk.
 *  - `npm run report` prints AGGREGATE COUNTS ONLY. There is no code path in
 *    scripts/report.js that prints a `u`, and test/stats.test.js asserts it.
 *  - Retention: day files are pruned after 90 days; weekly rollups are pure
 *    aggregates and are kept forever.
 *
 * NO CAPS, EVER. This module counts. It does not gate, throttle, refuse or
 * multiply anything, and it has no return value that any caller acts on. The
 * owner's law (no earning cap on honest play) cannot be violated by a file
 * that cannot say no.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { dayKey, dayStartMs } from './progress.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// constants (all overridable through install(ctx))
// ---------------------------------------------------------------------------

/** Day files older than this are deleted by the sweep. Rollups are forever. */
export const KEEP_DAYS = 90;
/** Hard ceiling on one day's NDJSON. Past it the file stops growing and the
 *  in-memory rollup keeps counting: a runaway day loses detail, never numbers. */
export const MAX_DAY_BYTES = 32 * 1024 * 1024;
/** A single line larger than this is dropped (nothing here should approach it). */
export const MAX_LINE_BYTES = 1024;
/** Batched fsync window. Stats are not evidence; 2s of loss is a rounding error. */
export const FSYNC_MS = 2_000;
/** Rotation + prune cadence. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Distinct keys any one bucket map will hold before the rest fold into 'other'.
 *  Reasons and game ids are server-authored, but a future caller could pass a
 *  quest name, so the map is bounded rather than trusted. */
export const MAX_KEYS = 96;
/** How long a string field may be on the wire to disk. */
const STR_MAX = 48;

/** The kinds this module writes. Anything else is refused by note(). */
export const KINDS = Object.freeze({
  OPEN: 'open',     // session opened   {u?, h, n?:1 new account}
  SESS: 'sess',     // session closed   {u?, ms}
  CCU: 'ccu',       // a new peak       {n, h}
  COIN: 'coin',     // faucet           {u?, n, r}
  SPEND: 'spend',   // sink             {u?, n, s}
  MG: 'mg',         // minigame start   {u?, g}
  SCORE: 'score',   // paid run         {u?, g, c}
  DUEL: 'duel',     // duel won         {u?, g}
  CHAT: 'chat',     // one chat line    {u?}   (never the text)
  ROOM: 'room',     // room join        {u?, r}
  REPORT: 'report', // T&S report filed {u?}
  CAP: 'cap',       // the day file hit MAX_DAY_BYTES
});
const KIND_SET = new Set(Object.values(KINDS));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const S = {
  installed: false,
  dir: '',
  day: '',
  file: '',
  fd: null,
  bytes: 0,
  capped: false,
  dayPeak: 0,
  dirty: false,
  fsyncTimer: null,
  sweepTimer: null,
  hooked: false,
  fsyncMs: FSYNC_MS,
  keepDays: KEEP_DAYS,
  maxDayBytes: MAX_DAY_BYTES,
  maxLine: MAX_LINE_BYTES,
  salt: '',
  now: () => Date.now(),
  logFn: (msg, err) => console.warn(`[stats] ${msg}`, err?.message || err || ''),
  recordFor: () => null,
  // live sessions: p.id -> { u, at, guest }
  live: new Map(),
  // memoised account-key -> hash
  hashes: new Map(),
  // accounts already counted "new" today, so a reconnect cannot double-count
  newToday: new Set(),
  week: null,
  writes: 0,
  writeFails: 0,
  dropped: 0,
};

// ---------------------------------------------------------------------------
// day + week keys
// ---------------------------------------------------------------------------

/**
 * The ET hour (0-23) at `ms`, derived from progress.dayStartMs so the hour
 * buckets and the day buckets can never disagree across a DST weekend (one day
 * a year has 23 hours and one has 25; both are handled by asking the day where
 * it started rather than by subtracting a fixed offset).
 */
export function hourOf(ms) {
  const h = Math.floor((ms - dayStartMs(ms)) / 3_600_000);
  return h >= 0 && h <= 23 ? h : Math.min(23, Math.max(0, h));
}

/**
 * ISO-8601 week ('2026-W33') for an ET day key. PURE CALENDAR MATH on the
 * YYYY-MM-DD string — no timezone work happens here, because the string is
 * already the answer to "what day is it in the cove".
 *
 * DUPLICATED, deliberately, in scripts/report.js: the report is a standalone
 * CLI that must not import a server module (server/db.js loads the account
 * store and starts backup timers at import time, which a read-only report has
 * no business doing). test/stats.test.js cross-checks the two implementations
 * over three years of days, so they cannot drift apart in silence.
 */
export function weekKey(dk) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dk || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Thursday of this week decides the year and the number (ISO's rule).
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4dow = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(Date.UTC(year, 0, 4 - jan4dow));
  const n = 1 + Math.round((d - week1Mon) / 604_800_000);
  return `${year}-W${String(n).padStart(2, '0')}`;
}

/** The seven ET day keys of an ISO week, Monday first. */
export function weekDays(wk) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(wk || ''));
  if (!m) return [];
  const year = Number(m[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4dow = (jan4.getUTCDay() + 6) % 7;
  const mon = Date.UTC(year, 0, 4 - jan4dow) + (Number(m[2]) - 1) * 604_800_000;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon + i * 86_400_000);
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** A short, bounded, printable key. Everything that becomes a bucket name. */
function key(s) {
  // control characters only: 'race win' and 'message in a bottle' are real
  // grantCoins reasons and must survive intact, spaces and all.
  const v = [...String(s == null ? '' : s)]
    .filter((ch) => { const n = ch.charCodeAt(0); return n >= 32 && n !== 127; })
    .join('').trim().slice(0, STR_MAX);
  return v || 'other';
}

/** Bounded bump on a plain object used as a counter map. */
function bump(map, k, n = 1) {
  const name = Object.prototype.hasOwnProperty.call(map, k) || Object.keys(map).length < MAX_KEYS
    ? k
    : 'other';
  map[name] = (map[name] || 0) + n;
}

// ---------------------------------------------------------------------------
// the account hash
// ---------------------------------------------------------------------------

/**
 * The salt. Generated once and kept beside the logs: without it the hashes in
 * an old day file cannot be tied to the ones in a new file, which is the price
 * of not keeping a reversible identifier at all. Losing it costs retention
 * continuity across the gap and nothing else.
 */
function loadSalt(dir, override) {
  if (typeof override === 'string' && override) return override;
  const file = path.join(dir, '.salt');
  try {
    const cur = fs.readFileSync(file, 'utf8').trim();
    if (cur.length >= 16) return cur;
  } catch { /* first boot */ }
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${salt}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { S.logFn('salt write', e); }
  return salt;
}

/**
 * A stable, salted, 8-hex handle for one account, or null for a guest.
 * Prefers the record's `uid` so a rename does not look like a new player.
 */
function uidFor(p) {
  if (!p || p.bot) return null;
  let rec = null;
  try { rec = S.recordFor(p); } catch { rec = null; }
  const raw = rec?.uid || rec?.username || p.username || null;
  if (!raw) return null;
  const k = String(raw).toLowerCase();
  let h = S.hashes.get(k);
  if (!h) {
    h = crypto.createHash('sha256').update(`${S.salt}:${k}`).digest('hex').slice(0, 8);
    if (S.hashes.size > 5_000) S.hashes.clear();
    S.hashes.set(k, h);
  }
  return h;
}

// ---------------------------------------------------------------------------
// the weekly bucket
// ---------------------------------------------------------------------------

function freshWeek(wk) {
  return {
    week: wk,
    from: S.now(),
    to: S.now(),
    players: {
      dau: {},            // dayKey -> Set of u (collapsed to counts on read)
      wau: new Set(),
      new: 0,
      sessions: 0,
      guestSessions: 0,
      sessionMsTotal: 0,
      sessionCount: 0,
      sessionMs: [],      // sampled durations, for the median
      peakCCU: 0,
      peakAt: 0,
      byHour: new Array(24).fill(0),
    },
    rooms: {},
    games: {},            // id -> { starts, runs, coins }
    duels: { total: 0, byGame: {} },
    economy: { granted: {}, minted: 0, spent: {}, spentTotal: 0 },
    social: { chats: 0 },
    safety: { reports: 0 },
  };
}

/** Durations kept for the median. Bounded: a busy week is thousands, not millions. */
const SESSION_SAMPLE_CAP = 20_000;

function weekBucket(at) {
  const wk = weekKey(dayKey(at));
  if (!S.week || S.week.week !== wk) {
    if (S.week) { try { writeRollup(S.week); } catch (e) { S.logFn('rollup', e); } }
    S.week = freshWeek(wk);
  }
  S.week.to = at;
  return S.week;
}

function gameRow(w, id) {
  const g = key(id);
  if (!Object.prototype.hasOwnProperty.call(w.games, g)) {
    if (Object.keys(w.games).length >= MAX_KEYS) return w.games.other || (w.games.other = { starts: 0, runs: 0, coins: 0 });
    w.games[g] = { starts: 0, runs: 0, coins: 0 };
  }
  return w.games[g];
}

// ---------------------------------------------------------------------------
// the file
// ---------------------------------------------------------------------------

function fileFor(day) {
  return path.join(S.dir, `stats-${day}.ndjson`);
}

function openDay(day) {
  if (S.fd !== null && S.day === day) return;
  closeFd();
  S.day = day;
  S.file = fileFor(day);
  S.capped = false;
  S.newToday.clear();
  // the peak is a per-DAY high-water mark: yesterday's 40 must not silence
  // today's 12, or the report prints one number and six blanks.
  S.dayPeak = 0;
  try {
    fs.mkdirSync(S.dir, { recursive: true });
    S.fd = fs.openSync(S.file, 'a');
    S.bytes = fs.statSync(S.file).size;
    if (S.bytes >= S.maxDayBytes) S.capped = true;
  } catch (e) {
    S.fd = null;
    S.bytes = 0;
    S.logFn(`open ${S.file}`, e);
  }
}

function closeFd() {
  if (S.fd === null) return;
  try { if (S.dirty) fs.fsyncSync(S.fd); } catch { /* best effort */ }
  try { fs.closeSync(S.fd); } catch { /* best effort */ }
  S.fd = null;
  S.dirty = false;
}

/** Batched fsync. Never throws; a failed sync is retried by the next one. */
export function flush() {
  try {
    if (S.fd !== null && S.dirty) { fs.fsyncSync(S.fd); S.dirty = false; }
    return true;
  } catch (e) { S.logFn('fsync', e); return false; }
}

function armFsync() {
  if (S.fsyncTimer || S.fsyncMs <= 0) { if (S.fsyncMs <= 0) flush(); return; }
  S.fsyncTimer = setTimeout(() => { S.fsyncTimer = null; flush(); }, S.fsyncMs);
  if (typeof S.fsyncTimer.unref === 'function') S.fsyncTimer.unref();
}

/**
 * Append one record. The ONLY place this module writes a line.
 *
 * Rolls the day file lazily (so a server that never ticks still rotates), obeys
 * the size cap by degrading to memory-only rather than by dropping numbers, and
 * swallows every error: a full disk must not end a party.
 */
function append(rec) {
  if (!S.installed) return false;
  const day = dayKey(rec.t);
  if (day !== S.day) openDay(day);
  if (S.fd === null) return false;
  let line;
  try { line = `${JSON.stringify(rec)}\n`; } catch { S.dropped++; return false; }
  const size = Buffer.byteLength(line);
  if (size > S.maxLine) { S.dropped++; return false; }
  if (S.capped) { S.dropped++; return false; }
  if (S.bytes + size > S.maxDayBytes) {
    S.capped = true;
    const marker = `${JSON.stringify({ t: rec.t, k: KINDS.CAP, at: S.bytes })}\n`;
    try { fs.writeSync(S.fd, marker); S.bytes += Buffer.byteLength(marker); S.dirty = true; } catch { /* ignore */ }
    S.logFn(`day file hit the ${S.maxDayBytes} byte cap; counting continues in memory`);
    return false;
  }
  try {
    fs.writeSync(S.fd, line);
    S.bytes += size;
    S.writes++;
    S.dirty = true;
    armFsync();
    return true;
  } catch (e) {
    S.writeFails++;
    S.logFn('write', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// the tee: one public entry point per hook index.js owns
// ---------------------------------------------------------------------------

/**
 * The low-level door. Everything above it is a named convenience; a future
 * caller with a kind this file already knows can use this directly.
 * Returns true when the line reached the disk. Never throws.
 */
export function note(kind, data = {}) {
  try {
    if (!S.installed || !KIND_SET.has(kind)) return false;
    const t = S.now();
    return append({ t, k: kind, ...data });
  } catch (e) { S.logFn(`note ${kind}`, e); return false; }
}

/**
 * A connection entered the world (index.js `hello`, right after
 * world.players.set). Counts the session, the DAU set, the hour, whether this
 * is the account's first day, and — because concurrency can only rise when a
 * session opens — the new peak.
 */
export function sessionOpen(p) {
  try {
    if (!S.installed || !p || p.bot || S.live.has(p.id)) return;
    const at = S.now();
    const w = weekBucket(at);
    const u = uidFor(p);
    const dk = dayKey(at);
    const h = hourOf(at);
    S.live.set(p.id, { u, at, guest: !u });

    w.players.sessions++;
    if (!u) w.players.guestSessions++;
    w.players.byHour[h]++;
    if (u) {
      (w.players.dau[dk] || (w.players.dau[dk] = new Set())).add(u);
      w.players.wau.add(u);
    }

    // "new" = the stored account was created today (ET), counted once per
    // account per day so a reconnect or a second tab cannot inflate it.
    let isNew = false;
    if (u && !S.newToday.has(u)) {
      let rec = null;
      try { rec = S.recordFor(p); } catch { rec = null; }
      const created = Number(rec?.created);
      if (Number.isFinite(created) && created > 0 && dayKey(created) === dk) {
        isNew = true;
        S.newToday.add(u);
        w.players.new++;
      }
    }

    append({ t: at, k: KINDS.OPEN, ...(u ? { u } : { gu: 1 }), h, ...(isNew ? { n: 1 } : {}) });

    // Concurrency can only RISE when a session opens, so this is the whole
    // measurement: no sampling timer, no missed spike between two ticks.
    // The open line above has already rolled the day file, so S.dayPeak is
    // today's.
    const ccu = S.live.size;
    if (ccu > w.players.peakCCU) { w.players.peakCCU = ccu; w.players.peakAt = at; }
    if (ccu > S.dayPeak) {
      S.dayPeak = ccu;
      append({ t: at, k: KINDS.CCU, n: ccu, h });
    }
  } catch (e) { S.logFn('sessionOpen', e); }
}

/** ws 'close'. Writes the session length, which is metric 4's only source. */
export function sessionClose(p) {
  try {
    if (!S.installed || !p) return;
    const row = S.live.get(p.id);
    if (!row) return;
    S.live.delete(p.id);
    const at = S.now();
    const ms = Math.max(0, Math.min(86_400_000, at - row.at));
    const w = weekBucket(at);
    w.players.sessionCount++;
    w.players.sessionMsTotal += ms;
    if (w.players.sessionMs.length < SESSION_SAMPLE_CAP) w.players.sessionMs.push(ms);
    append({ t: at, k: KINDS.SESS, ...(row.u ? { u: row.u } : { gu: 1 }), ms });
  } catch (e) { S.logFn('sessionClose', e); }
}

/**
 * Beside progress.signal, inside index.js's `signal()` wrapper. Only the names
 * this file has a number for are written; the rest are ignored on purpose, so
 * a new signal never silently becomes a new disk cost.
 */
export function signal(name, p, data = {}) {
  try {
    if (!S.installed || !p || p.bot) return;
    const at = S.now();
    const w = weekBucket(at);
    const u = uidFor(p);
    const who = u ? { u } : { gu: 1 };
    switch (name) {
      case 'score': {
        const g = key(data?.game);
        const row = gameRow(w, g);
        row.runs++;
        const c = clampInt(data?.coins, 0, 1_000_000, 0);
        row.coins += c;
        append({ t: at, k: KINDS.SCORE, ...who, g, c });
        break;
      }
      case 'match-win': {
        const g = key(data?.game);
        w.duels.total++;
        bump(w.duels.byGame, g);
        append({ t: at, k: KINDS.DUEL, ...who, g });
        break;
      }
      case 'chat':
        // the NUMBER 1. Never the text, never its length, never its target.
        w.social.chats++;
        append({ t: at, k: KINDS.CHAT, ...who });
        break;
      case 'room': {
        const r = key(data?.room);
        // dens are dynamic ('house:<owner>') and would blow the key budget for
        // no insight: they roll up as one bucket.
        const bucketName = r.startsWith('house:') ? 'house' : r;
        bump(w.rooms, bucketName);
        append({ t: at, k: KINDS.ROOM, ...who, r: bucketName });
        break;
      }
      default:
        break;
    }
  } catch (e) { S.logFn(`signal ${name}`, e); }
}

/**
 * Inside grantCoins, on the paid path only (`payout` after the backstop, so a
 * refused grant is not counted as minted money). `reason` is the free string
 * grantCoins already carries: minigame id, 'race win', 'mining', a quest name.
 */
export function grant(p, amount, reason) {
  try {
    if (!S.installed || !p || p.bot) return;
    const n = clampInt(amount, 0, 10_000_000, 0);
    if (n <= 0) return;
    const at = S.now();
    const w = weekBucket(at);
    const r = key(reason);
    const u = uidFor(p);
    w.economy.minted += n;
    bump(w.economy.granted, r, n);
    append({ t: at, k: KINDS.COIN, ...(u ? { u } : { gu: 1 }), n, r });
  } catch (e) { S.logFn('grant', e); }
}

/** The two sinks: `stats.spend(p, hat.price, 'hat')` / `'furniture'`. */
export function spend(p, amount, sink) {
  try {
    if (!S.installed || !p || p.bot) return;
    const n = clampInt(amount, 0, 10_000_000, 0);
    if (n <= 0) return;
    const at = S.now();
    const w = weekBucket(at);
    const s = key(sink);
    const u = uidFor(p);
    w.economy.spentTotal += n;
    bump(w.economy.spent, s, n);
    append({ t: at, k: KINDS.SPEND, ...(u ? { u } : { gu: 1 }), n, s });
  } catch (e) { S.logFn('spend', e); }
}

/**
 * A read-only look at raw frames, wired the way chatlog.observe is: it takes no
 * decision, consumes nothing and always returns false.
 *
 * Two frames earn their line here because neither reaches signal():
 *  - 'mgstart' is the minigame FUNNEL (metric 7). It counts intent: a start
 *    econ later refuses is still a player who pressed play, and the gap between
 *    starts and paid runs is itself the interesting number.
 *  - 'report' is metric 9. A filed report, never its text, never its target.
 */
export function observe(p, m) {
  try {
    if (!S.installed || !p || p.bot || !m || typeof m !== 'object') return false;
    const at = S.now();
    if (m.t === 'mgstart') {
      const w = weekBucket(at);
      const g = key(m.game);
      const u = uidFor(p);
      gameRow(w, g).starts++;
      append({ t: at, k: KINDS.MG, ...(u ? { u } : { gu: 1 }), g });
    } else if (m.t === 'report') {
      const w = weekBucket(at);
      w.safety.reports++;
      const u = uidFor(p);
      append({ t: at, k: KINDS.REPORT, ...(u ? { u } : { gu: 1 }) });
    }
  } catch (e) { S.logFn('observe', e); }
  return false; // NEVER consumes
}

/**
 * Optional. Nothing depends on it — rollover happens lazily on every write —
 * but wiring it into the existing clock interval keeps the day/week boundary
 * crisp on a quiet server and lands the fsync.
 */
export function tick() {
  try {
    if (!S.installed) return;
    const at = S.now();
    const day = dayKey(at);
    if (day !== S.day) openDay(day);
    weekBucket(at);
    flush();
  } catch (e) { S.logFn('tick', e); }
}

// ---------------------------------------------------------------------------
// rollups
// ---------------------------------------------------------------------------

const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

/** The current week's rollup, as plain JSON (Sets collapsed to counts). */
export function week() {
  try {
    const w = S.week || freshWeek(weekKey(dayKey(S.now())));
    const dau = {};
    for (const [d, set] of Object.entries(w.players.dau)) dau[d] = set.size;
    const days = Object.values(dau);
    return {
      week: w.week,
      from: w.from,
      to: w.to,
      players: {
        dauByDay: dau,
        dauAvg: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : 0,
        wau: w.players.wau.size,
        new: w.players.new,
        sessions: w.players.sessions,
        guestSessions: w.players.guestSessions,
        sessionsClosed: w.players.sessionCount,
        sessionMsTotal: w.players.sessionMsTotal,
        sessionMsMedian: median(w.players.sessionMs),
        peakCCU: w.players.peakCCU,
        peakAt: w.players.peakAt,
        byHour: [...w.players.byHour],
        live: S.live.size,
      },
      rooms: { ...w.rooms },
      games: Object.fromEntries(Object.entries(w.games).map(([k, v]) => [k, { ...v }])),
      duels: { total: w.duels.total, byGame: { ...w.duels.byGame } },
      economy: {
        minted: w.economy.minted,
        granted: { ...w.economy.granted },
        spentTotal: w.economy.spentTotal,
        spent: { ...w.economy.spent },
      },
      social: { ...w.social },
      safety: { ...w.safety },
    };
  } catch (e) { S.logFn('week', e); return null; }
}

function writeRollup(bucket) {
  if (!bucket || !bucket.week || !S.dir) return null;
  const saved = S.week;
  S.week = bucket;
  const body = week();
  S.week = saved;
  if (!body) return null;
  const file = path.join(S.dir, `week-${bucket.week}.json`);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(S.dir, { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    S.logFn(`rollup ${file}`, e);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Freeze a week to `week-<weekId>.json` (atomic: tmp -> fsync -> rename) and,
 * when it is the open week, start a fresh bucket. Day files are untouched and
 * remain the authority: `npm run report` recomputes from them, so a close that
 * never happened costs nothing but the cached file.
 */
export function close(weekId) {
  try {
    if (!S.installed) return null;
    const wk = weekId || (S.week ? S.week.week : weekKey(dayKey(S.now())));
    if (!S.week || S.week.week !== wk) return null;
    const file = writeRollup(S.week);
    S.week = freshWeek(weekKey(dayKey(S.now())));
    return file;
  } catch (e) { S.logFn('close', e); return null; }
}

// ---------------------------------------------------------------------------
// sweep + install + shutdown
// ---------------------------------------------------------------------------

/** Delete day files past the retention window. Rollups are never touched. */
export function sweep(at = S.now()) {
  const out = { purged: 0 };
  try {
    const cutoff = dayKey(at - S.keepDays * 86_400_000);
    for (const name of fs.readdirSync(S.dir)) {
      const m = /^stats-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
      if (!m || m[1] >= cutoff || name === path.basename(S.file)) continue;
      try { fs.unlinkSync(path.join(S.dir, name)); out.purged++; } catch { /* ignore */ }
    }
  } catch (e) { S.logFn('sweep', e); }
  return out;
}

/** Everything /api/health and the future panel want to show. */
export function stats() {
  return {
    installed: S.installed,
    dir: S.dir,
    day: S.day,
    file: S.file,
    bytes: S.bytes,
    capped: S.capped,
    live: S.live.size,
    writes: S.writes,
    writeFails: S.writeFails,
    dropped: S.dropped,
    week: S.week ? S.week.week : '',
    peakCCU: S.week ? S.week.players.peakCCU : 0,
  };
}

/**
 * Boot the tee. Call once, near the other installs.
 *
 * ctx (every field optional):
 *   dataDir       data root; the logs live in <dataDir>/stats
 *                 (default: COVE_DATA_DIR or <repo>/data)
 *   dir           exact directory, overrides dataDir (tests)
 *   recordFor(p)  the stored account behind a connection (index.js has one)
 *   now()         clock injection for tests
 *   log(msg, err) where this module's own failures go
 *   keepDays / maxDayBytes / maxLineBytes / fsyncMs / sweepIntervalMs
 *   salt          override the on-disk hashing salt (tests)
 *   timers        false: install no timers at all
 *   hooks         false: do not register the process exit flush
 *
 * Returns { dir, day, file, week }.
 */
export function install(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  shutdown({ rollup: false });

  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.join(ROOT, 'data'));
  S.dir = c.dir ? path.resolve(c.dir) : path.join(dataDir, 'stats');
  if (typeof c.log === 'function') S.logFn = c.log;
  if (typeof c.now === 'function') S.now = c.now; else S.now = () => Date.now();
  S.recordFor = typeof c.recordFor === 'function' ? c.recordFor : () => null;
  S.keepDays = clampInt(c.keepDays, 1, 3650, KEEP_DAYS);
  S.maxDayBytes = clampInt(c.maxDayBytes, 4096, 4 * 1024 * 1024 * 1024, MAX_DAY_BYTES);
  S.maxLine = clampInt(c.maxLineBytes, 128, 1024 * 1024, MAX_LINE_BYTES);
  S.fsyncMs = clampInt(c.fsyncMs, 0, 60_000, FSYNC_MS);
  S.live.clear();
  S.hashes.clear();
  S.newToday.clear();
  S.writes = 0; S.writeFails = 0; S.dropped = 0; S.bytes = 0; S.capped = false; S.dayPeak = 0;

  try { fs.mkdirSync(S.dir, { recursive: true }); } catch (e) { S.logFn(`mkdir ${S.dir}`, e); }
  S.salt = loadSalt(S.dir, c.salt);
  S.installed = true;
  openDay(dayKey(S.now()));
  S.week = freshWeek(weekKey(S.day));

  if (c.timers !== false) {
    const every = clampInt(c.sweepIntervalMs, 0, 86_400_000, SWEEP_INTERVAL_MS);
    if (every > 0) {
      S.sweepTimer = setInterval(() => { try { sweep(); } catch (e) { S.logFn('sweep', e); } }, every);
      if (typeof S.sweepTimer.unref === 'function') S.sweepTimer.unref();
    }
    sweep();
  }
  if (c.hooks !== false && !S.hooked) {
    process.on('exit', () => { try { flush(); } catch { /* ignore */ } });
    S.hooked = true;
  }
  return { dir: S.dir, day: S.day, file: S.file, week: S.week.week };
}

/**
 * Stop cleanly: close every open session so its length is not lost, freeze the
 * week, fsync, drop the timers. Safe to call twice.
 */
export function shutdown({ rollup = true } = {}) {
  try {
    if (S.installed) {
      const at = S.now();
      for (const [id, row] of [...S.live]) {
        S.live.delete(id);
        const ms = Math.max(0, Math.min(86_400_000, at - row.at));
        const w = weekBucket(at);
        w.players.sessionCount++;
        w.players.sessionMsTotal += ms;
        if (w.players.sessionMs.length < SESSION_SAMPLE_CAP) w.players.sessionMs.push(ms);
        append({ t: at, k: KINDS.SESS, ...(row.u ? { u: row.u } : { gu: 1 }), ms });
      }
      if (rollup && S.week) writeRollup(S.week);
    }
  } catch (e) { S.logFn('shutdown', e); }
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
  closeFd();
  S.installed = false;
  S.live.clear();
}

export default {
  KINDS, KEEP_DAYS, MAX_DAY_BYTES, MAX_LINE_BYTES, MAX_KEYS,
  install, shutdown, note, sessionOpen, sessionClose, signal, grant, spend,
  observe, tick, week, close, flush, sweep, stats, weekKey, weekDays, hourOf,
};
