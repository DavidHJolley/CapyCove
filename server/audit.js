/**
 * server/audit.js — the append-only, hash-chained audit log (wave 9D, N-05).
 *
 * The principle this file exists to enforce (accounts-admin.md §7.1): *if a
 * privileged action happened and the log does not describe it, the feature is
 * not finished.* This is the only thing that makes handing out `mod` safe, and
 * the only way to answer "why does this account have 40,000 coins" three weeks
 * from now.
 *
 * Contract with index.js / admin.js (same shape as server/progress.js:6-11 and
 * server/store.js, so the wiring reads the same everywhere):
 *   - install(ctx)  once at boot. ctx supplies the data dir, a console logger
 *     and the tuning knobs. NOTHING here imports another server module: the
 *     audit log must keep working when the user database is the thing that is
 *     broken, so it shares no code and no write path with it (§6.1, §7.3).
 *   - log(event)    one line. Never throws, never blocks a player's frame.
 *   - econGrant()/econShape()  the two economy anomaly events (N-05).
 *   - verifyChain(file) / verifyAll()   tamper detection.
 *   - readBack(filter, cursor)          the future panel's reader (§4.3 screen 6).
 *   - sweep() / flush() / stats() / listFiles() / close()
 *
 * ---------------------------------------------------------------------------
 * THE LINE
 *
 * `data/audit/audit-YYYY-MM-DD.jsonl`, one JSON object per line, UTC days.
 * The wave contract fixes seven keys; the spec (§7.3) also wants a sequence
 * number, an id, before/after and an ok flag, so the emitted order is:
 *
 *   {ts, seq, id, actor, op, target, args, before?, after?, ok, prevHash, hash}
 *    ^^^^      ^^^^^  ^^  ^^^^^^  ^^^^                     ^^^^^^^^  ^^^^
 *    the seven contract keys, in contract order, with the spec's extras
 *    tucked in beside the field each belongs to.
 *
 *   hash = sha256( prevHash + "\n" + canonical(line without `hash`) )
 *
 * `canonical()` is JSON with every object key sorted, so the digest does not
 * depend on emission order and a tool that rewrites the file with different
 * key order still verifies. The FIRST line of the log ever written chains to
 * GENESIS_HASH (64 zeros); the first line of each new day chains to the last
 * hash of the previous day, so the chain spans rotation and gzip. Changing,
 * reordering or deleting any line breaks every hash after it, which is the
 * whole point: the threat model is someone with disk access (§7.3).
 *
 * DEVIATION (deliberate, called out per house style): the spec writes the
 * previous hash as `prev`. The wave contract calls it `prevHash`, so this file
 * ships `prevHash`. Nothing else reads the field yet.
 *
 * WHAT THE CHAIN DOES NOT CATCH, stated plainly: someone with disk access can
 * rewrite the LAST line and recompute its hash, because nothing chains to it
 * yet. Every earlier line is nailed down by every line after it, and the moment
 * the running server writes the next line the forgery is exposed (the server
 * links to the hash it holds in memory, not the one on disk). Truncating the
 * file at the end is likewise visible only as a gap in `seq`. A chain makes
 * tampering *detectable*, not impossible; the off-box backup copy is what makes
 * it recoverable, which is why `data/audit/` belongs on the same backed-up
 * volume as `data/backups/` (S-17).
 *
 * NEVER LOGGED (§7.2): chat contents (those live in the separate 7-day chat
 * log the T&S wave owns), passwords, salts, hashes, recovery codes, reset
 * tokens, raw IP addresses. `redact()` strips those keys out of args/before/
 * after wherever they appear, at any depth, on every write — a caller that
 * forgets cannot leak them.
 *
 * DURABILITY: one fd opened 'a' (append is atomic for a short line on both
 * POSIX and Windows), a synchronous write per line so the chain order can
 * never race, and a batched fsync every 250 ms. Volume is tens of lines a day
 * and low thousands during a raid, so nothing is ever buffered longer than
 * that. A write that fails does NOT advance the chain: the next line links to
 * the last hash that actually reached the disk.
 *
 * ROTATION: a new file at UTC midnight; closed days older than 7 are gzipped
 * (node:zlib, built in); anything older than 90 days is deleted by the same
 * sweep, which runs at boot and hourly. The open day is never touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// constants (all overridable through install(ctx))
// ---------------------------------------------------------------------------

/** What the very first line in the log's history chains to. */
export const GENESIS_HASH = '0'.repeat(64);
/** Admin actions are kept this many days, then deleted by the sweep (§7.3). */
export const KEEP_DAYS = 90;
/** Closed days older than this are gzipped in place (§7.3). */
export const GZIP_AFTER_DAYS = 7;
/** How often the batched fsync lands. Bounds worst-case loss of evidence. */
export const FSYNC_MS = 250;
/** Rotation + gzip + purge sweep cadence. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A single line larger than this has its payload replaced by a marker. */
export const MAX_LINE_BYTES = 16 * 1024;
/** Honest play measured at ~1,500-2,000 coins/hr (AUDIT F-11 / §4.3 screen 5). */
export const ECON_HONEST_CEILING = 2_000;
/** "exceeds 3x the honest ceiling in an hour" -> 6,000/hr. LOG ONLY. */
export const ECON_MULTIPLIER = 3;
/** One rate line per account per hour: a farmer must not be able to spam it. */
export const ECON_RATE_COOLDOWN_MS = 60 * 60 * 1000;
/** Malformed-frame budget per account before shape lines start coalescing. */
export const ECON_SHAPE_BURST = 8;
export const ECON_SHAPE_WINDOW_MS = 60 * 1000;

/**
 * The op vocabulary (§7.2). Shared so admin.js and the panel spell the same
 * names — an op NOT in this table is still logged (evidence is never dropped),
 * it just does not get the shared spelling.
 */
export const OPS = Object.freeze({
  // moderation
  MUTE: 'mod.mute', UNMUTE: 'mod.unmute', KICK: 'mod.kick', BAN: 'mod.ban',
  UNBAN: 'mod.unban', WARN: 'mod.warn', SUMMON: 'mod.summon', SAY: 'mod.say',
  CHATLOG_READ: 'mod.chatlog.read',
  // mural
  MURAL_CLEAR: 'mural.clear', MURAL_REVERT: 'mural.revert',
  // economy
  COINS: 'econ.coins',
  GRANT_LARGE: 'econ.grant.large', HOURLY_CAPPED: 'econ.hourly.capped',
  ANOMALY_RATE: 'econ.anomaly.rate', ANOMALY_SHAPE: 'econ.anomaly.shape',
  // roles + accounts
  ROLE_GRANT: 'role.grant', ROLE_REVOKE: 'role.revoke', ROLE_SEED: 'role.seed',
  ACCOUNT_CREATE: 'account.create', ACCOUNT_RENAME: 'account.rename',
  ACCOUNT_PURGE: 'account.purge',
  ACCOUNT_DELETE_REQUEST: 'account.delete.request',
  ACCOUNT_DELETE_CANCEL: 'account.delete.cancel',
  ACCOUNT_PASSWORD: 'account.password.change',
  RESET_ISSUED: 'account.reset.issued', RESET_USED: 'account.reset.used',
  // panel
  PANEL_LOGIN: 'panel.login', PANEL_LOGIN_FAIL: 'panel.login.fail',
  PANEL_LOGOUT: 'panel.logout',
  // server lifecycle
  SERVER_START: 'server.start', SERVER_STOP: 'server.stop',
  SERVER_UNCAUGHT: 'server.uncaught',
  DB_SAVE_FAIL: 'db.save.fail', DB_RESTORE: 'db.restore',
  AUDIT_ROTATE: 'audit.rotate', AUDIT_REPAIR: 'audit.repair',
});

/** Key names whose VALUE never reaches the disk, at any depth (§7.2). */
const SECRET_KEYS = new Set([
  'password', 'pass', 'newpassword', 'oldpassword', 'pw',
  'hash', 'salt', 'secret', 'token', 'tokens', 'sessionid', 'sid',
  'recovery', 'recoverycode', 'code', 'resettoken', 'reset',
  'ip', 'ipaddr', 'ipaddress', 'remoteaddress', 'xforwardedfor',
  'cookie', 'authorization', 'text', 'msg', 'message', 'chat', 'lines',
]);
// `text`/`msg`/`chat`/`lines` are in the list because chat contents belong to
// the 7-day chat log, not the 90-day admin log. Ops that legitimately carry
// operator-authored copy (a warning card, an announcement) pass it as `note`,
// which is kept — the operator's own words are part of the record.

const FILE_RE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

// ---------------------------------------------------------------------------
// module state (one log per process; install() resets it, which is also how a
// test points the module at a sandbox dir)
// ---------------------------------------------------------------------------

const S = {
  installed: false,
  dir: '',
  day: '',
  file: '',
  fd: null,
  seq: 0,
  lastHash: GENESIS_HASH,
  keepDays: KEEP_DAYS,
  gzipAfterDays: GZIP_AFTER_DAYS,
  fsyncMs: FSYNC_MS,
  maxLine: MAX_LINE_BYTES,
  now: Date.now,
  logFn: (msg, err) => console.error(err ? `[audit] ${msg}: ${err?.message || err}` : `[audit] ${msg}`),
  fsyncTimer: null,
  sweepTimer: null,
  dirty: false,
  hooked: false,
  // counters, surfaced through stats()
  writes: 0, writeFails: 0, bytes: 0, lastAt: 0, gzipped: 0, purged: 0,
  truncated: 0, repaired: 0, rateFlags: 0, shapeFlags: 0, shapeSuppressed: 0, restoredFrom: '',
  // economy anomaly windows
  econ: {
    honestCeiling: ECON_HONEST_CEILING,
    multiplier: ECON_MULTIPLIER,
    limit: ECON_HONEST_CEILING * ECON_MULTIPLIER,
    cooldownMs: ECON_RATE_COOLDOWN_MS,
    shapeBurst: ECON_SHAPE_BURST,
    shapeWindowMs: ECON_SHAPE_WINDOW_MS,
    grants: new Map(), // key -> { hits:[{t,n}], flaggedAt }
    shapes: new Map(), // key -> { winStart, n, suppressed }
  },
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const nowMs = () => {
  const t = Number(S.now());
  return Number.isFinite(t) ? t : Date.now();
};

/** UTC calendar day for a timestamp. Rotation is UTC on purpose: it is the one
 *  boundary that never moves under a timezone change or a DST jump. */
export function utcDay(ts = nowMs()) {
  const d = new Date(Number(ts) || 0);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '1970-01-01';
}

const dayToMs = (day) => Date.parse(`${day}T00:00:00Z`);

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * JSON with every object key sorted, recursively. The hash input, and the only
 * reason two servers can agree on a digest for the same record.
 */
export function canonical(value) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      return Number.isFinite(v) || typeof v !== 'number' ? JSON.stringify(v) : 'null';
    }
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (typeof v === 'bigint') return JSON.stringify(String(v));
    if (seen.has(v)) return '"[circular]"';
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
      out = `[${v.map((x) => walk(x) ?? 'null').join(',')}]`;
    } else {
      const parts = [];
      for (const k of Object.keys(v).sort()) {
        const s = walk(v[k]);
        if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
      }
      out = `{${parts.join(',')}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(value) ?? 'null';
}

/** The chain step, exported so a verifier (or a test) can recompute a line. */
export function hashLine(prevHash, record) {
  const body = { ...record };
  delete body.hash;
  return crypto.createHash('sha256')
    .update(String(prevHash ?? GENESIS_HASH))
    .update('\n')
    .update(canonical(body))
    .digest('hex');
}

/**
 * Deep copy with the secret keys removed and everything oversized clipped.
 * Runs on every args/before/after payload: a caller that forgets what must not
 * be logged cannot leak it (§7.2).
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (t === 'function' || t === 'symbol') return null;
  if (depth >= 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.getTime();
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
 * Actors and targets are normalised to the same tiny shape so the panel's
 * filters have exactly one thing to match on. A bare string is read as a name;
 * null is the system actor (§7.3 `via`).
 */
function party(v, isActor) {
  if (v === null || v === undefined) {
    return isActor ? { uid: null, name: 'system', role: 'system' } : null;
  }
  if (typeof v === 'string') return { uid: null, name: v.slice(0, 64) };
  if (typeof v !== 'object') return null;
  const out = {};
  if (v.uid) out.uid = String(v.uid).slice(0, 64);
  else out.uid = null;
  out.name = v.name != null ? String(v.name).slice(0, 64) : (v.username != null ? String(v.username).slice(0, 64) : null);
  if (v.role) out.role = String(v.role).slice(0, 16);
  if (v.ipH) out.ipH = String(v.ipH).slice(0, 32); // the HASH only, never an address
  if (v.id) out.id = String(v.id).slice(0, 32);    // live connection id
  return out;
}

// ---------------------------------------------------------------------------
// file plumbing
// ---------------------------------------------------------------------------

function fsyncDir(dir) {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* Windows cannot; POSIX is where it matters */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

function fileFor(dir, day, gz = false) {
  return path.join(dir, `audit-${day}.jsonl${gz ? '.gz' : ''}`);
}

/** Every audit file on disk, newest day first. */
export function listFiles(dir = S.dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    let bytes = 0;
    let mtime = 0;
    try { const st = fs.statSync(full); bytes = st.size; mtime = st.mtimeMs; } catch { continue; }
    out.push({ name, file: full, day: m[1], gz: !!m[2], bytes, mtime });
  }
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (a.gz ? 1 : 0) - (b.gz ? 1 : 0)));
  // A crash between "write the .gz" and "unlink the plain file" leaves both
  // halves of one day on disk. The plain file is the authority (it is what the
  // gzip was made from and what the next sweep will re-make); reading both
  // would double every line of that day.
  const seen = new Set();
  return out.filter((f) => {
    if (!seen.has(f.day)) { seen.add(f.day); return true; }
    return false;
  });
}

/** Write a whole buffer, looping over short writes. Append mode ignores pos. */
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off, null);
    if (!(n > 0)) throw new Error('short write');
    off += n;
  }
}

function closeFd() {
  if (S.fd === null) return;
  try { if (S.dirty) fs.fsyncSync(S.fd); } catch {}
  try { fs.closeSync(S.fd); } catch {}
  S.fd = null;
  S.dirty = false;
}

/**
 * A process killed mid-write can leave a byte fragment with no newline at the
 * end of the file. That fragment is not a record — it never got a hash and
 * nothing chains to it — so it is dropped before the file is reopened for
 * append, exactly the way a WAL truncates a partial tail. Only bytes AFTER the
 * last newline are removed: a complete-but-corrupt line is evidence of tampering
 * and is never touched. Returns the number of bytes dropped.
 */
function repairTail(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (!size) return 0;
    fd = fs.openSync(file, 'r+');
    const chunk = 64 * 1024;
    let pos = size;
    const buf = Buffer.allocUnsafe(chunk);
    while (pos > 0) {
      const len = Math.min(chunk, pos);
      pos -= len;
      fs.readSync(fd, buf, 0, len, pos);
      const nl = buf.subarray(0, len).lastIndexOf(0x0a);
      if (nl !== -1) {
        const keep = pos + nl + 1;
        if (keep === size) return 0; // clean: the file ends on a line boundary
        fs.ftruncateSync(fd, keep);
        fs.fsyncSync(fd);
        return size - keep;
      }
    }
    fs.ftruncateSync(fd, 0); // not one complete line in the whole file
    fs.fsyncSync(fd);
    return size;
  } catch {
    return 0;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/** Open (or roll to) the file for `day`. Rolling is what "rotation" means. */
function openDay(day) {
  if (S.fd !== null && S.day === day) return true;
  const rolled = S.fd !== null && S.day !== day;
  closeFd();
  try {
    fs.mkdirSync(S.dir, { recursive: true });
    const file = fileFor(S.dir, day);
    const existed = fs.existsSync(file);
    const dropped = existed ? repairTail(file) : 0;
    S.fd = fs.openSync(file, 'a');
    S.day = day;
    S.file = file;
    if (!existed) fsyncDir(S.dir); // the new file's directory entry, made durable
    if (rolled) queueMicrotask(() => { try { sweep(); } catch {} });
    // Say so in the log itself: a crash that cost bytes is operational news.
    if (dropped > 0) {
      S.repaired += dropped;
      queueMicrotask(() => {
        log({ actor: null, via: 'system', op: OPS.AUDIT_REPAIR, args: { file: path.basename(file), droppedBytes: dropped, why: 'partial line, process killed mid-write' }, ok: false });
      });
    }
    return true;
  } catch (e) {
    S.fd = null;
    S.writeFails++;
    S.logFn(`cannot open ${fileFor(S.dir, day)}`, e);
    return false;
  }
}

function scheduleFsync() {
  if (S.fsyncTimer || S.fsyncMs <= 0) return;
  S.fsyncTimer = setTimeout(() => { S.fsyncTimer = null; flush(); }, S.fsyncMs);
  if (typeof S.fsyncTimer?.unref === 'function') S.fsyncTimer.unref();
}

/** fsync the open file now. Never throws. */
export function flush() {
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.fd === null || !S.dirty) return true;
  try { fs.fsyncSync(S.fd); S.dirty = false; return true; } catch (e) {
    S.logFn('fsync failed', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// the chain: recovery, writing, verification
// ---------------------------------------------------------------------------

/**
 * Read a file's lines NEWEST FIRST without holding the whole thing in memory
 * (§7.3: "never load a whole day into memory"). Plain files are read backwards
 * in 64 KB chunks with the line split done on BYTES, so a multi-byte character
 * straddling a chunk boundary can never be corrupted. A closed day is gzipped,
 * which has to be inflated whole — that is the price of compression, and a
 * gzipped day is by definition small.
 */
export function* linesReverse(file, { chunk = 64 * 1024 } = {}) {
  if (file.endsWith('.gz')) {
    let text = '';
    try { text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'); } catch { return; }
    const arr = text.split('\n');
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i].trim()) yield arr[i];
    return;
  }
  let fd = null;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    let pos = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(chunk);
    let leftover = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunk, pos);
      pos -= len;
      fs.readSync(fd, buf, 0, len, pos);
      const combined = Buffer.concat([buf.subarray(0, len), leftover]);
      const nl = combined.indexOf(0x0a);
      if (nl === -1) { leftover = combined; continue; }
      leftover = combined.subarray(0, nl);
      const arr = combined.subarray(nl + 1).toString('utf8').split('\n');
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].trim()) yield arr[i];
    }
    if (leftover.length) {
      const s = leftover.toString('utf8');
      if (s.trim()) yield s;
    }
  } catch { /* a log that will not read is reported by verifyChain, not here */ }
  finally { try { fs.closeSync(fd); } catch {} }
}

/**
 * Pick the chain back up after a restart: the newest parseable line anywhere in
 * the directory gives the next seq and the hash to link to. Without this a
 * restart would silently start a second, unlinked chain.
 */
function recoverChain() {
  S.seq = 0;
  S.lastHash = GENESIS_HASH;
  S.restoredFrom = '';
  for (const f of listFiles()) {
    for (const line of linesReverse(f.file)) {
      let rec = null;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec.hash !== 'string' || rec.hash.length !== 64) continue;
      S.seq = clampInt(rec.seq, 0, Number.MAX_SAFE_INTEGER, 0);
      S.lastHash = rec.hash;
      S.restoredFrom = f.name;
      return true;
    }
  }
  return false;
}

/**
 * Write one audit line. NEVER throws and never returns a value a caller has to
 * act on: an audit failure must not be able to cancel the action it describes.
 *
 * event: { ts?, actor, op, target?, args?, before?, after?, ok?, via? }
 *   actor  {uid,name,role,ipH,id} | 'name' | null (null = the system itself)
 *   target same shape, or null
 *   via    'ingame' | 'panel' | 'system' (folded into actor, §7.3)
 * Returns the written record, or null if it could not be written.
 */
export function log(event) {
  try {
    if (!S.installed) install({});
    const e = event && typeof event === 'object' ? event : {};
    const op = String(e.op || 'unknown').slice(0, 64).replace(/[^\w.:-]/g, '') || 'unknown';
    const ts = clampInt(e.ts, 0, 4102444800000, nowMs());
    const day = utcDay(ts);
    if (day !== S.day || S.fd === null) {
      if (!openDay(day)) return null;
    }

    const actor = party(e.actor, true);
    // 'via' says which surface the op came from: the in-game a-* frames, the
    // future web panel, or the server acting on its own (§7.3).
    if (e.via) actor.via = String(e.via).slice(0, 16);
    else actor.via = (actor.uid || (actor.name && actor.name !== 'system')) ? 'ingame' : 'system';

    const rec = {
      ts,
      seq: S.seq + 1,
      id: `a_${ts.toString(36)}${crypto.randomBytes(5).toString('hex')}`,
      actor,
      op,
      target: party(e.target, false),
      args: e.args === undefined ? null : redact(e.args),
      ...(e.before === undefined ? {} : { before: redact(e.before) }),
      ...(e.after === undefined ? {} : { after: redact(e.after) }),
      ok: e.ok === undefined ? true : !!e.ok,
      prevHash: S.lastHash,
      hash: '',
    };

    // A pathological payload must not be able to write a megabyte line: clip it
    // and say so, rather than dropping the evidence that the op happened.
    let line = JSON.stringify({ ...rec, hash: 'x'.repeat(64) });
    if (Buffer.byteLength(line) > S.maxLine) {
      rec.args = { truncated: true, was: Buffer.byteLength(line) };
      delete rec.before;
      delete rec.after;
      S.truncated++;
    }
    rec.hash = hashLine(rec.prevHash, rec);
    line = `${JSON.stringify(rec)}\n`;
    const buf = Buffer.from(line, 'utf8');

    try {
      writeAll(S.fd, buf);
    } catch (err) {
      // The chain does NOT advance on a failed write: the next line links to
      // the last hash that actually reached the disk.
      S.writeFails++;
      S.logFn(`write failed (${op})`, err);
      return null;
    }
    S.seq = rec.seq;
    S.lastHash = rec.hash;
    S.writes++;
    S.bytes += buf.length;
    S.lastAt = ts;
    S.dirty = true;
    scheduleFsync();
    return rec;
  } catch (err) {
    S.writeFails++;
    try { S.logFn('log() failed', err); } catch {}
    return null;
  }
}

/**
 * Verify one file's hash chain.
 * opts.expectPrev links it to the previous day's last hash (verifyAll does this
 * automatically); omit it to verify the file standing alone.
 * Returns { ok, file, day, lines, bad, reason, first, last }.
 */
export function verifyChain(file, opts = {}) {
  const out = {
    ok: false, file, day: null, lines: 0, bad: null, reason: null,
    first: null, last: null, seqOk: true,
  };
  const m = FILE_RE.exec(path.basename(String(file)));
  if (m) out.day = m[1];
  let text = '';
  try {
    const raw = fs.readFileSync(file);
    text = (String(file).endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  } catch (e) {
    out.reason = `unreadable: ${e?.message || e}`;
    return out;
  }
  let prev = opts.expectPrev === undefined ? null : String(opts.expectPrev);
  let lastSeq = null;
  const arr = text.split('\n');
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (!raw.trim()) continue;
    out.lines++;
    let rec = null;
    try { rec = JSON.parse(raw); } catch {
      out.bad = out.lines; out.reason = `line ${out.lines}: not JSON`; return out;
    }
    if (typeof rec?.hash !== 'string' || typeof rec?.prevHash !== 'string') {
      out.bad = out.lines; out.reason = `line ${out.lines}: missing hash/prevHash`; return out;
    }
    if (prev === null) prev = rec.prevHash;         // standalone: trust the first link
    if (rec.prevHash !== prev) {
      out.bad = out.lines;
      out.reason = `line ${out.lines}: prevHash does not match the previous line (chain broken — a line was altered, inserted or removed)`;
      return out;
    }
    const want = hashLine(rec.prevHash, rec);
    if (want !== rec.hash) {
      out.bad = out.lines;
      out.reason = `line ${out.lines}: hash mismatch (this line's contents were altered)`;
      return out;
    }
    if (lastSeq !== null && !(rec.seq > lastSeq)) out.seqOk = false;
    lastSeq = rec.seq;
    if (!out.first) out.first = { seq: rec.seq, ts: rec.ts, hash: rec.hash, prevHash: rec.prevHash };
    out.last = { seq: rec.seq, ts: rec.ts, hash: rec.hash };
    prev = rec.hash;
  }
  out.ok = true;
  if (!out.lines) out.reason = 'empty';
  return out;
}

/**
 * Verify the whole history, oldest day first, carrying each file's last hash
 * into the next so a deleted or reordered DAY is caught too.
 */
export function verifyAll(opts = {}) {
  const dir = opts.dir || S.dir;
  const files = listFiles(dir).slice().reverse(); // oldest first
  const out = { ok: true, dir, files: [], lines: 0, reason: null };
  let prev = opts.expectPrev === undefined ? GENESIS_HASH : opts.expectPrev;
  for (const f of files) {
    const r = verifyChain(f.file, { expectPrev: prev });
    out.files.push({ name: f.name, ok: r.ok, lines: r.lines, reason: r.reason });
    out.lines += r.lines;
    if (!r.ok) { out.ok = false; out.reason = `${f.name}: ${r.reason}`; return out; }
    if (r.last) prev = r.last.hash;
  }
  return out;
}

// ---------------------------------------------------------------------------
// reading back (the panel's screen 6, and the report queue's context)
// ---------------------------------------------------------------------------

function matchParty(want, got) {
  if (!want) return true;
  const w = typeof want === 'string' ? { any: want } : want;
  const uid = got?.uid ? String(got.uid) : '';
  const name = got?.name ? String(got.name).toLowerCase() : '';
  if (w.uid) return uid === String(w.uid);
  if (w.name) return name === String(w.name).toLowerCase();
  const q = String(w.any || '').toLowerCase();
  if (!q) return true;
  return uid.toLowerCase() === q || name === q;
}

function matchOp(want, op) {
  if (!want) return true;
  const list = Array.isArray(want) ? want : [want];
  return list.some((w) => {
    const s = String(w);
    if (s.endsWith('*')) return op.startsWith(s.slice(0, -1));
    if (s.endsWith('.')) return op.startsWith(s);
    return op === s;
  });
}

const encodeCursor = (day, seq) => `a1:${day}:${seq}`;
function parseCursor(c) {
  if (!c || typeof c !== 'string') return null;
  const m = /^a1:(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(c);
  return m ? { day: m[1], seq: Number(m[2]) } : null;
}

/**
 * Newest-first, cursored read.
 *
 *   readBack({ actor, target, op, day, from, to, ok, limit }, cursor)
 *     actor/target  'mango' | {uid} | {name}   (matches uid or name)
 *     op            'mod.ban' | 'mod.*' | ['mod.ban','mod.kick']
 *     day           'YYYY-MM-DD' — restrict to one file
 *     from/to       ms epoch range
 *     limit         1..500, default 50
 *   -> { lines, cursor, done, scanned }
 *
 * Pass the returned `cursor` back to get the next page; `done` is true when the
 * history is exhausted. Files are streamed backwards, so a 90-day history costs
 * one page of memory, not ninety days of it.
 */
export function readBack(filter = {}, cursor = null) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const limit = clampInt(f.limit, 1, 500, 50);
  const maxScan = clampInt(f.maxScan, 1, 200_000, 20_000);
  const from = Number.isFinite(Number(f.from)) ? Number(f.from) : null;
  const to = Number.isFinite(Number(f.to)) ? Number(f.to) : null;
  const cur = parseCursor(cursor);
  const out = { lines: [], cursor: null, done: false, scanned: 0 };

  let files = listFiles();
  if (f.day) files = files.filter((x) => x.day === String(f.day));
  if (cur) {
    const i = files.findIndex((x) => x.day <= cur.day);
    files = i < 0 ? [] : files.slice(i);
  }
  if (!files.length) { out.done = true; return out; }

  let lastSeen = null;
  for (const file of files) {
    for (const raw of linesReverse(file.file)) {
      if (out.scanned >= maxScan) {
        out.cursor = lastSeen ? encodeCursor(lastSeen.day, lastSeen.seq) : cursor;
        return out;
      }
      out.scanned++;
      let rec = null;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      const seq = Number(rec.seq) || 0;
      lastSeen = { day: file.day, seq };
      if (cur && seq >= cur.seq) continue;             // already delivered
      if (from !== null && rec.ts < from) continue;
      if (to !== null && rec.ts > to) continue;
      if (f.ok !== undefined && !!rec.ok !== !!f.ok) continue;
      if (!matchOp(f.op, String(rec.op || ''))) continue;
      if (!matchParty(f.actor, rec.actor)) continue;
      if (f.target !== undefined && !matchParty(f.target, rec.target)) continue;
      out.lines.push(rec);
      if (out.lines.length >= limit) {
        out.cursor = encodeCursor(file.day, seq);
        return out;
      }
    }
  }
  out.done = true;
  return out;
}

// ---------------------------------------------------------------------------
// rotation, gzip, purge
// ---------------------------------------------------------------------------

/**
 * Gzip closed days older than `gzipAfterDays`, delete anything older than
 * `keepDays`. Runs at boot, hourly, and right after a day rolls. The open day
 * is never touched, so this is safe to call at any moment.
 * Returns { gzipped:[], purged:[] }.
 */
export function sweep(opts = {}) {
  const res = { gzipped: [], purged: [] };
  const today = utcDay(nowMs());
  const todayMs = dayToMs(today);
  const keepDays = clampInt(opts.keepDays, 1, 3650, S.keepDays);
  const gzipAfter = clampInt(opts.gzipAfterDays, 0, 3650, S.gzipAfterDays);
  for (const f of listFiles()) {
    if (f.day === today || f.file === S.file) continue; // never the open day
    const ageDays = Math.floor((todayMs - dayToMs(f.day)) / 86_400_000);
    if (!Number.isFinite(ageDays)) continue;
    if (ageDays >= keepDays) {
      try { fs.unlinkSync(f.file); res.purged.push(f.name); S.purged++; } catch (e) { S.logFn(`purge ${f.name}`, e); }
      continue;
    }
    if (!f.gz && ageDays >= gzipAfter) {
      try {
        const gz = zlib.gzipSync(fs.readFileSync(f.file), { level: 9 });
        const dest = fileFor(S.dir, f.day, true);
        const tmp = `${dest}.tmp`;
        const fd = fs.openSync(tmp, 'w');
        try { writeAll(fd, gz); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, dest);
        fsyncDir(S.dir);
        fs.unlinkSync(f.file);       // only after the .gz is durable
        res.gzipped.push(path.basename(dest));
        S.gzipped++;
      } catch (e) { S.logFn(`gzip ${f.name}`, e); }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// the two economy anomaly events (N-05)
// ---------------------------------------------------------------------------

const econKey = (o) => String(o?.uid || o?.name || o?.id || 'anon').toLowerCase();

/**
 * Called from the coin road AFTER a grant is paid. LOG ONLY — it returns
 * information and never a refusal, and no caller may use it to block a payout.
 * The owner's rule is absolute: no earning cap that honest play can hit, ever.
 * This event exists so that an operator reading the log next week can SEE a
 * farming session; the response to it is a human decision, not an automatic one.
 *
 *   econGrant({ uid, name, amount, reason, room, at }) ->
 *     { total, limit, flagged, grants }
 *
 * `total` is the account's rolling 60-minute payout. Crossing 3x the honest
 * ceiling emits one `econ.anomaly.rate` line, then stays quiet for an hour so a
 * farmer cannot flood the log with their own detection.
 */
export function econGrant(info = {}) {
  const out = { total: 0, limit: S.econ.limit, flagged: false, grants: 0 };
  try {
    const amount = Math.max(0, Math.floor(Number(info.amount) || 0));
    const at = clampInt(info.at, 0, 4102444800000, nowMs());
    const key = econKey(info);
    let w = S.econ.grants.get(key);
    if (!w) { w = { hits: [], flaggedAt: 0 }; S.econ.grants.set(key, w); }
    if (amount > 0) w.hits.push({ t: at, n: amount });
    const cut = at - 3_600_000;
    w.hits = w.hits.filter((h) => h.t > cut);
    out.total = w.hits.reduce((a, h) => a + h.n, 0);
    out.grants = w.hits.length;
    if (S.econ.grants.size > 5_000) pruneEcon(at); // a long uptime must not leak
    if (out.total > S.econ.limit && at - w.flaggedAt >= S.econ.cooldownMs) {
      w.flaggedAt = at;
      S.rateFlags++;
      out.flagged = true;
      log({
        ts: at,
        actor: null,
        via: 'system',
        op: OPS.ANOMALY_RATE,
        target: { uid: info.uid || null, name: info.name || null },
        args: {
          hourCoins: out.total,
          grants: out.grants,
          limit: S.econ.limit,
          honestCeiling: S.econ.honestCeiling,
          multiplier: S.econ.multiplier,
          lastGrant: amount,
          reason: String(info.reason || '').slice(0, 48),
          room: info.room ? String(info.room).slice(0, 32) : null,
          action: 'none (log only: honest play is never blocked)',
        },
      });
    }
  } catch (e) { S.logFn('econGrant', e); }
  return out;
}

/**
 * A score/economy frame that validation REJECTED: an unarmed or replayed run
 * token, a run shorter than minRunMs, a coin claim above the game's clamp, a
 * non-finite or negative score, an unknown game id. The frame is already
 * refused by the handler; this only records the shape of the refusal, because
 * one player producing hundreds of them is the signature of a script and no
 * other surface in the game would ever show it.
 *
 *   econShape({ uid, name, frame, reason, detail, room, at }) ->
 *     { flagged, suppressed }
 *
 * Rate-limited per account (8 per minute) so a tight loop of bad frames cannot
 * turn the audit log into a denial-of-service on the disk; the next line that
 * gets through carries the suppressed count.
 */
export function econShape(info = {}) {
  const out = { flagged: false, suppressed: 0 };
  try {
    const at = clampInt(info.at, 0, 4102444800000, nowMs());
    const key = econKey(info);
    let w = S.econ.shapes.get(key);
    // A new window carries the suppressed count forward, so the next line that
    // gets through reports everything that was swallowed while over budget.
    if (!w) w = { winStart: at, n: 0, suppressed: 0 };
    else if (at - w.winStart >= S.econ.shapeWindowMs) w = { winStart: at, n: 0, suppressed: w.suppressed };
    S.econ.shapes.set(key, w);
    w.n++;
    if (w.n > S.econ.shapeBurst) {
      w.suppressed++;
      S.shapeSuppressed++;
      out.suppressed = w.suppressed;
      return out;
    }
    const suppressed = w.suppressed;
    w.suppressed = 0;
    if (S.econ.shapes.size > 5_000) pruneEcon(at);
    S.shapeFlags++;
    out.flagged = true;
    out.suppressed = suppressed;
    log({
      ts: at,
      actor: null,
      via: 'system',
      op: OPS.ANOMALY_SHAPE,
      target: { uid: info.uid || null, name: info.name || null },
      args: {
        frame: String(info.frame || 'score').slice(0, 32),
        reason: String(info.reason || 'rejected').slice(0, 64),
        detail: info.detail === undefined ? null : redact(info.detail),
        room: info.room ? String(info.room).slice(0, 32) : null,
        inWindow: w.n,
        suppressed,
        action: 'none (the frame was already refused by validation)',
      },
      ok: false,
    });
  } catch (e) { S.logFn('econShape', e); }
  return out;
}

/** Drop economy windows nobody has touched for an hour. */
function pruneEcon(at = nowMs()) {
  for (const [k, w] of S.econ.grants) {
    if (!w.hits.length || at - w.hits[w.hits.length - 1].t > 3_600_000) S.econ.grants.delete(k);
  }
  for (const [k, w] of S.econ.shapes) {
    if (at - w.winStart > S.econ.shapeWindowMs * 4) S.econ.shapes.delete(k);
  }
}

// ---------------------------------------------------------------------------
// install / stats / close
// ---------------------------------------------------------------------------

/**
 * Boot the log. Call once, before anything can be audited.
 *
 * ctx (every field optional):
 *   dataDir          data root; the log lives in <dataDir>/audit
 *                    (default: COVE_DATA_DIR or <repo>/data)
 *   dir              exact directory, overrides dataDir (tests, drills)
 *   log(msg, err)    where this module's own failures are reported
 *   now()            clock injection for tests
 *   keepDays         retention, default 90
 *   gzipAfterDays    default 7
 *   fsyncMs          batched fsync window, default 250 (0 = fsync every line)
 *   sweepIntervalMs  default 1h; 0 disables the timer (sweep() still works)
 *   maxLineBytes     default 16384
 *   econ             { honestCeiling, multiplier, cooldownMs, shapeBurst,
 *                      shapeWindowMs } — see econGrant/econShape
 *   timers           false: install no timers at all (tests)
 *   hooks            false: do not register the process exit flush
 *   startEvent       false: do not write the server.start line
 *   meta             extra fields for the server.start line
 *
 * Returns { dir, day, file, seq, lastHash, restoredFrom, gzipped, purged }.
 */
export function install(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  close();

  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR
      ? path.resolve(process.env.COVE_DATA_DIR)
      : path.resolve(process.cwd(), 'data'));
  S.dir = c.dir ? path.resolve(c.dir) : path.join(dataDir, 'audit');
  if (typeof c.log === 'function') S.logFn = c.log;
  if (typeof c.now === 'function') S.now = c.now;
  S.keepDays = clampInt(c.keepDays, 1, 3650, KEEP_DAYS);
  S.gzipAfterDays = clampInt(c.gzipAfterDays, 0, 3650, GZIP_AFTER_DAYS);
  S.fsyncMs = clampInt(c.fsyncMs, 0, 60_000, FSYNC_MS);
  S.maxLine = clampInt(c.maxLineBytes, 512, 1_048_576, MAX_LINE_BYTES);
  const ec = c.econ && typeof c.econ === 'object' ? c.econ : {};
  S.econ.honestCeiling = clampInt(ec.honestCeiling, 1, 10_000_000, ECON_HONEST_CEILING);
  S.econ.multiplier = Math.min(1000, Math.max(1, Number(ec.multiplier) || ECON_MULTIPLIER));
  S.econ.limit = clampInt(ec.limit, 1, 100_000_000, Math.round(S.econ.honestCeiling * S.econ.multiplier));
  S.econ.cooldownMs = clampInt(ec.cooldownMs, 0, 86_400_000, ECON_RATE_COOLDOWN_MS);
  S.econ.shapeBurst = clampInt(ec.shapeBurst, 1, 10_000, ECON_SHAPE_BURST);
  S.econ.shapeWindowMs = clampInt(ec.shapeWindowMs, 100, 3_600_000, ECON_SHAPE_WINDOW_MS);
  S.econ.grants.clear();
  S.econ.shapes.clear();
  S.writes = 0; S.writeFails = 0; S.bytes = 0; S.gzipped = 0; S.purged = 0;
  S.truncated = 0; S.repaired = 0; S.rateFlags = 0; S.shapeFlags = 0; S.shapeSuppressed = 0;

  try { fs.mkdirSync(S.dir, { recursive: true }); } catch (e) { S.logFn(`mkdir ${S.dir}`, e); }
  recoverChain();
  S.installed = true;
  openDay(utcDay(nowMs()));
  const swept = sweep();

  if (c.timers !== false) {
    const every = clampInt(c.sweepIntervalMs, 0, 86_400_000, SWEEP_INTERVAL_MS);
    if (every > 0) {
      S.sweepTimer = setInterval(() => { try { sweep(); } catch (e) { S.logFn('sweep', e); } }, every);
      if (typeof S.sweepTimer?.unref === 'function') S.sweepTimer.unref();
    }
  }
  if (c.hooks !== false && !S.hooked) {
    // 'exit' handlers must be synchronous, which is exactly what flush() is.
    process.on('exit', () => { try { flush(); } catch {} });
    S.hooked = true;
  }
  if (c.startEvent !== false) {
    log({
      actor: null,
      via: 'system',
      op: OPS.SERVER_START,
      args: {
        pid: process.pid,
        node: process.version,
        dir: S.dir,
        restoredFrom: S.restoredFrom || null,
        ...(c.meta && typeof c.meta === 'object' ? redact(c.meta) : {}),
      },
    });
  }
  return {
    dir: S.dir,
    day: S.day,
    file: S.file,
    seq: S.seq,
    lastHash: S.lastHash,
    restoredFrom: S.restoredFrom,
    gzipped: swept.gzipped,
    purged: swept.purged,
  };
}

/** Everything the panel's server screen and /api/health want to show. */
export function stats() {
  return {
    installed: S.installed,
    dir: S.dir,
    file: S.file,
    day: S.day,
    seq: S.seq,
    lastHash: S.lastHash,
    restoredFrom: S.restoredFrom || null,
    writes: S.writes,
    writeFails: S.writeFails,
    bytes: S.bytes,
    lastAt: S.lastAt,
    truncated: S.truncated,
    repaired: S.repaired,
    gzipped: S.gzipped,
    purged: S.purged,
    keepDays: S.keepDays,
    gzipAfterDays: S.gzipAfterDays,
    econ: {
      limit: S.econ.limit,
      honestCeiling: S.econ.honestCeiling,
      multiplier: S.econ.multiplier,
      tracked: S.econ.grants.size,
      rateFlags: S.rateFlags,
      shapeFlags: S.shapeFlags,
      shapeSuppressed: S.shapeSuppressed,
    },
    files: listFiles().length,
  };
}

/** Flush, close the fd, stop the timers. Idempotent; safe before install(). */
export function close() {
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
  flush();
  closeFd();
  S.installed = false;
  S.day = '';
  S.file = '';
  return true;
}

export default {
  install, log, econGrant, econShape, verifyChain, verifyAll, readBack,
  sweep, flush, stats, listFiles, close, linesReverse, canonical, hashLine,
  utcDay, OPS, GENESIS_HASH, KEEP_DAYS, GZIP_AFTER_DAYS,
};
