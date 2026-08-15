/**
 * server/log.js — structured logs and the cheap process counters (wave 11D, N-20 + N-34).
 *
 * The problem this file exists to solve: the server currently says things like
 * `[ws] Bo connected (guest), online: 3` to stdout. That is readable by a human
 * watching a terminal and useless to everything else — you cannot ask it "how
 * many guests connected in the last hour", you cannot ship it to a log service
 * without writing a regex per line shape, and the day the island is live nobody
 * is watching the terminal. One JSON object per line fixes all three at once.
 *
 * THE LINE
 *
 *   {"ts":"2026-08-15T04:12:03.114Z","lvl":"info","ev":"ws.connect",
 *    "pid":8123,"name":"Bo","account":false,"online":3}
 *
 *   ts   ISO-8601 UTC, always first, so `sort` on the raw file is chronological
 *   lvl  debug | info | warn | error
 *   ev   a dotted event name, NOT a sentence: `ws.connect`, `econ.grant`,
 *        `fatal.uncaught`. It is the thing you group by, so it must be a
 *        closed set of short strings rather than free prose.
 *   ...  whatever key/value pairs the call site passes, flattened alongside.
 *
 * Every line is a complete JSON object or it is not written: a line that grows
 * past `maxLine` is replaced by a short stub rather than truncated mid-string,
 * because half a JSON object poisons the whole file for every reader downstream.
 *
 * WHAT THIS IS NOT: it is not the audit log. server/audit.js is the hash-chained,
 * on-disk, 90-day record of privileged actions and it stays the answer to "why
 * does this account have 40,000 coins". This is stdout telemetry: lossy by
 * design, burst-suppressed, and safe to lose. When in doubt about which one a
 * new call belongs in, ask whether you would want it in a court record.
 *
 * NEVER LOGGED: the same key list audit.js refuses (passwords, salts, hashes,
 * tokens, recovery codes, raw IPs, chat text). `redact()` runs on every payload
 * at any depth, so a call site that forgets cannot leak. Error text rides `err`
 * or `note`, which are kept.
 *
 * BURST SUPPRESSION: a handler that throws once usually throws sixty times a
 * second. Past `burst` lines of one event inside `windowMs` the rest are
 * counted and dropped, and the next window opens with a single
 * `log.suppressed` line saying how many were swallowed. Signal survives; the
 * flood does not.
 *
 * THE COUNTERS (N-34): `frameIn()`/`frameOut()`/`frameDrop()` are integer
 * increments meant to sit on the ws hot path, and `count(name)` is the same
 * thing for anything else. `health()` folds them together with uptime and
 * memory for /api/health. Nothing here is sampled or timed: if it is not one
 * `++`, it does not belong on a frame path.
 *
 * ADOPTION: this file deliberately does NOT rewrite the ~30 existing
 * console.error call sites. Those are all `catch` arms that already read fine,
 * and churning them would be a 30-file-region diff with no behaviour change.
 * index.js adopts the four highest-value sites (connect, disconnect, coin
 * grant, uncaught throw); everything written after this wave should import
 * this instead of reaching for console.
 */

/** Level names to numbers, lowest first. Anything below the installed level is dropped. */
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_LEVEL = 'info';
const MAX_LINE_BYTES = 8_192; // one line; anything longer is a bug, not a log
const SUPPRESS_BURST = 40; // lines of ONE event per window before it is muted
const SUPPRESS_WINDOW_MS = 10_000;
const EVENT_CAP = 512; // distinct event names tracked for suppression

// Same list as server/audit.js:142. Kept as a copy on purpose: neither file
// imports the other, so the logger keeps working when the audit log is the
// thing that is broken.
const SECRET_KEYS = new Set([
  'password', 'pass', 'newpassword', 'oldpassword', 'pw',
  'hash', 'salt', 'secret', 'token', 'tokens', 'sessionid', 'sid',
  // NB: bare 'code' is NOT here (unlike audit.js): this logger's whole job is
  // diagnostics, and system-error codes (EADDRINUSE) arrive under that key.
  // Recovery codes ride 'recovery'/'recoverycode', which are.
  'recovery', 'recoverycode', 'resettoken', 'reset',
  'ip', 'ipaddr', 'ipaddress', 'remoteaddress', 'xforwardedfor',
  'cookie', 'authorization', 'text', 'msg', 'message', 'chat', 'lines',
]);

// Keys the record owns. A payload that sets one of these gets its value
// prefixed rather than silently winning, so `ev` always means the event name.
const RESERVED = new Set(['ts', 'lvl', 'ev']);

const S = {
  installed: false,
  level: LEVELS[DEFAULT_LEVEL],
  levelName: DEFAULT_LEVEL,
  out: null, // (line) => void; null means process.stdout
  pretty: false,
  now: () => Date.now(),
  base: {},
  maxLine: MAX_LINE_BYTES,
  burst: SUPPRESS_BURST,
  windowMs: SUPPRESS_WINDOW_MS,
  seen: new Map(), // ev -> {t, n, held}
  counts: Object.create(null),
  frames: { in: 0, out: 0, drop: 0 },
  written: 0,
  belowLevel: 0,
  suppressed: 0,
  trimmed: 0,
  failed: 0,
  bootAt: Date.now(),
};

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const levelOf = (name, dflt) => (Object.prototype.hasOwnProperty.call(LEVELS, name) ? name : dflt);

/** Env is read here and in install(); importing this file must do nothing else. */
function envLevel() {
  const raw = String(process.env.COVE_LOG_LEVEL || '').trim().toLowerCase();
  if (raw === 'silent' || raw === 'off' || raw === 'none') return 'silent';
  return levelOf(raw, DEFAULT_LEVEL);
}
applyLevel(envLevel());
S.pretty = process.env.COVE_LOG_PRETTY === '1';

function applyLevel(name) {
  if (name === 'silent') { S.levelName = 'silent'; S.level = LEVELS.error + 10; return; }
  S.levelName = levelOf(name, DEFAULT_LEVEL);
  S.level = LEVELS[S.levelName];
}

/**
 * The one place a line reaches the world. Swallows write failures (a closed
 * stdout must never take down the island) and counts them instead.
 */
function writeLine(line) {
  try {
    if (S.out) S.out(line);
    else process.stdout.write(`${line}\n`);
    S.written++;
  } catch { S.failed++; }
}

/**
 * Depth- and width-bounded copy with the secret keys stripped. Mirrors
 * audit.js:265 so a value logged in both places looks the same in both.
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (t === 'function' || t === 'symbol') return null;
  if (depth >= 6) return '[deep]';
  if (value instanceof Date) return value.getTime();
  if (value instanceof Error) return errShape(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => redact(v, depth + 1));
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n++ >= 48) { out['…'] = 'truncated'; break; }
    if (SECRET_KEYS.has(String(k).toLowerCase().replace(/[^a-z]/g, ''))) { out[k] = '[redacted]'; continue; }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/**
 * An Error logged whole is a stack the size of the screen. Keep the name, the
 * message and the first few frames: that is what identifies a throw.
 */
function errShape(e) {
  const stack = String(e.stack || '').split('\n').slice(0, 6).join(' | ');
  return { name: e.name || 'Error', err: String(e.message || e).slice(0, 512), at: stack.slice(0, 800) };
}

/**
 * True if this line gets through. Past `burst` of one event inside the window
 * the rest are held; rolling the window emits one summary of what was lost.
 */
function allow(ev) {
  if (S.burst <= 0) return true;
  const now = S.now();
  let e = S.seen.get(ev);
  if (!e || now - e.t >= S.windowMs) {
    const held = e ? e.held : 0;
    // an unbounded map keyed by caller-shaped strings is a slow leak, and the
    // suppression state is worth nothing once a window has rolled anyway
    if (S.seen.size >= EVENT_CAP) S.seen.clear();
    e = { t: now, n: 0, held: 0 };
    S.seen.set(ev, e);
    if (held > 0) {
      writeLine(JSON.stringify({ ts: new Date(now).toISOString(), lvl: 'warn', ev: 'log.suppressed', of: ev, dropped: held, windowMs: S.windowMs }));
    }
  }
  if (++e.n > S.burst) { e.held++; S.suppressed++; return false; }
  return true;
}

/** Dev-eyes rendering: `04:12:03 info  ws.connect name=Bo online=3`. */
function prettyLine(rec) {
  const t = String(rec.ts).slice(11, 23);
  const pad = `${rec.lvl}     `.slice(0, 5);
  const kv = Object.entries(rec)
    .filter(([k]) => !RESERVED.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
    .join(' ');
  return `${t} ${pad} ${rec.ev}${kv ? ` ${kv}` : ''}`;
}

/**
 * The whole logger. Never throws: a logging call that can fail a game frame is
 * worse than no logging at all.
 *
 * @param {string} levelName debug|info|warn|error
 * @param {string} event     dotted event name, e.g. 'ws.connect'
 * @param {object} [kv]      flat-ish payload; redacted, depth-bounded
 * @returns {boolean} whether a line was written
 */
export function log(levelName, event, kv) {
  const lvl = levelOf(levelName, 'info');
  if (LEVELS[lvl] < S.level) { S.belowLevel++; return false; }
  const ev = typeof event === 'string' && event ? event.slice(0, 64) : 'log';
  if (!allow(ev)) return false;
  const ts = new Date(S.now()).toISOString();
  try {
    const rec = { ts, lvl, ev, ...S.base };
    const payload = kv instanceof Error ? errShape(kv) : (kv && typeof kv === 'object' ? redact(kv) : null);
    if (payload) for (const [k, v] of Object.entries(payload)) rec[RESERVED.has(k) ? `_${k}` : k] = v;
    let line = S.pretty ? prettyLine(rec) : JSON.stringify(rec);
    if (line.length > S.maxLine) {
      // a stub, never a truncation: half a JSON object breaks every reader
      S.trimmed++;
      line = S.pretty ? `${prettyLine({ ts, lvl, ev }) } [cut ${line.length}b]` : JSON.stringify({ ts, lvl, ev, cut: line.length });
    }
    writeLine(line);
    return true;
  } catch (e) {
    S.failed++;
    try { writeLine(JSON.stringify({ ts, lvl: 'error', ev: 'log.failed', of: ev, err: String(e?.message || e).slice(0, 200) })); } catch {}
    return false;
  }
}

export const debug = (event, kv) => log('debug', event, kv);
export const info = (event, kv) => log('info', event, kv);
export const warn = (event, kv) => log('warn', event, kv);
export const error = (event, kv) => log('error', event, kv);

/**
 * A logger that stamps every line with the same keys. `const l = log.child({
 * mod: 'race' })` then `l.warn('start.failed', { err })`. Purely a convenience:
 * there is one underlying stream and one set of counters.
 */
export function child(base = {}) {
  const own = base && typeof base === 'object' ? redact(base) : {};
  // An Error's message/stack are non-enumerable, so a naive spread would
  // silently swallow them; hand it to redact()'s Error shape under `err`.
  const bind = (lvl) => (event, kv) => log(lvl, event,
    kv instanceof Error ? { ...own, err: kv } : kv ? { ...own, ...kv } : own);
  return {
    debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error'),
    child: (more) => child({ ...own, ...(more && typeof more === 'object' ? more : {}) }),
  };
}

/** Free-form counter, for anything that is not a ws frame. */
export function count(name, n = 1) {
  const key = typeof name === 'string' && name ? name.slice(0, 48) : 'other';
  const add = Number.isFinite(n) ? Math.floor(n) : 1;
  S.counts[key] = (S.counts[key] || 0) + add;
  return S.counts[key];
}

// The ws hot path. One integer increment each, no allocation, no branch worth
// measuring: cheap enough to sit inside the message handler and sendTo.
export function frameIn(n = 1) { S.frames.in += n; }
export function frameOut(n = 1) { S.frames.out += n; }
export function frameDrop(n = 1) { S.frames.drop += n; }

/**
 * The /api/health payload (N-34). Called by a health check, never on a frame,
 * so a full memoryUsage() read is fine here.
 */
export function health() {
  let mem = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0 };
  try { mem = process.memoryUsage(); } catch {}
  return {
    uptime: Math.round(process.uptime()),
    node: process.version,
    pid: process.pid,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external || 0,
      rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
    },
    frames: { in: S.frames.in, out: S.frames.out, dropped: S.frames.drop },
    log: {
      level: S.levelName,
      written: S.written,
      belowLevel: S.belowLevel,
      suppressed: S.suppressed,
      trimmed: S.trimmed,
      failed: S.failed,
    },
    counters: { ...S.counts },
  };
}

/** Everything health() reports plus the config, for tests and for a-* ops. */
export function stats() {
  return {
    installed: S.installed,
    level: S.levelName,
    pretty: S.pretty,
    maxLine: S.maxLine,
    burst: S.burst,
    windowMs: S.windowMs,
    events: S.seen.size,
    base: { ...S.base },
    bootAt: S.bootAt,
    ...health(),
  };
}

/**
 * Boot seam, same shape as progress/audit/admin so the wiring in index.js reads
 * the same everywhere. Resets the counters, so calling it twice in a test is
 * the way to get a clean slate.
 *
 *   ctx.level      'debug'|'info'|'warn'|'error'|'silent' (default COVE_LOG_LEVEL, then 'info')
 *   ctx.pretty     human-readable lines instead of JSON (default COVE_LOG_PRETTY=1)
 *   ctx.write      (line) => void sink, for tests; default process.stdout
 *   ctx.now        () => ms, for tests
 *   ctx.base       keys stamped on every line (pid, version, ...)
 *   ctx.maxLine / ctx.burst / ctx.windowMs
 */
export function install(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  applyLevel(c.level === undefined ? envLevel() : String(c.level).toLowerCase());
  S.pretty = c.pretty === undefined ? process.env.COVE_LOG_PRETTY === '1' : !!c.pretty;
  S.out = typeof c.write === 'function' ? c.write : null;
  S.now = typeof c.now === 'function' ? c.now : () => Date.now();
  S.base = c.base && typeof c.base === 'object' ? redact(c.base) : {};
  S.maxLine = clampInt(c.maxLine, 256, 1_048_576, MAX_LINE_BYTES);
  S.burst = clampInt(c.burst, 0, 100_000, SUPPRESS_BURST);
  S.windowMs = clampInt(c.windowMs, 100, 3_600_000, SUPPRESS_WINDOW_MS);
  S.seen.clear();
  S.counts = Object.create(null);
  S.frames.in = 0; S.frames.out = 0; S.frames.drop = 0;
  S.written = 0; S.belowLevel = 0; S.suppressed = 0; S.trimmed = 0; S.failed = 0;
  S.bootAt = S.now();
  S.installed = true;
  return stats();
}

export default { LEVELS, install, log, debug, info, warn, error, child, count, frameIn, frameOut, frameDrop, health, stats };
