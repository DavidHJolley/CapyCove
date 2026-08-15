/**
 * server/store.js — the persistence seam (wave 9A, N-01 + N-02).
 *
 * ONE job: be the only place in the server that touches the filesystem for
 * user data. `server/db.js` implements the account shape on top of this and
 * re-exports through it; nothing else imports it for reading or writing files.
 * When SQLite eventually arrives (accounts-admin.md §6.3-6.5) it becomes a
 * second implementation of the interface below and the diff is one file plus
 * an importer, instead of every handler in a 2,877-line server.
 *
 * The interface (accounts-admin.md §6.2), all synchronous:
 *   getUser(key) putUser(rec) createUser(rec) deleteUser(key) hasUser(key)
 *   allUsers() count() findByUid(uid) searchUsers(prefix, limit)
 *   rekey(oldKey, newKey) tx(fn) saveSoon() flush() stats()
 *   backup(opts) listBackups() rotateBackups() restoreFromBackup(name)
 *   startBackups() stopBackups() installShutdownHooks(opts)
 *
 * Durability rules this file exists to enforce:
 *  - every write is tmp -> write -> fsync(file) -> rename -> fsync(DIR). The
 *    last step is the one everybody skips; without it the rename itself can be
 *    lost on power failure (accounts-admin.md §6.1). Directory fsync is a
 *    no-op on Windows (EISDIR/EPERM) and is swallowed there on purpose.
 *  - saveSoon() stays a LEADING-EDGE, FIXED-WINDOW debounce: a busy server
 *    writes at most once per 500 ms and can never be starved. That property is
 *    deliberate and survives the migration.
 *  - a users.json that will not parse is NEVER overwritten. It is renamed
 *    aside as evidence and the newest backup is loaded instead.
 *  - hourly gzip backups, 24 hourly + 7 daily (daily buckets are
 *    America/New_York calendar days), plus one on every clean shutdown.
 *
 * Nothing here knows what an account looks like. Record shape, uid, roles,
 * bans and the rename sweep all live in db.js and arrive through the
 * `normalize` hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Hourly snapshots kept before rotation starts dropping them. */
export const HOURLY_KEEP = 24;
/** Distinct calendar days (America/New_York) kept beyond the hourly window. */
export const DAILY_KEEP = 7;
/** Backup cadence. */
export const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
/** saveSoon() window. Do not raise: it bounds worst-case data loss. */
export const SAVE_DEBOUNCE_MS = 500;
/** The whole live-ops stack agreed on one timezone; backups use it too. */
export const BACKUP_TZ = 'America/New_York';
/** Above this many accounts tx() stops taking a rollback snapshot (see tx). */
const TX_SNAPSHOT_LIMIT = 20_000;

// ---------------------------------------------------------------------------
// atomic file primitives
// ---------------------------------------------------------------------------

let tmpSeq = 0;

/** fsync the directory holding `file` so the rename itself is durable. */
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    // Windows cannot open a directory for reading; POSIX is where this matters.
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Write `data` to `file` atomically: a reader either sees the whole old file
 * or the whole new one, and a power cut cannot leave a truncated file behind.
 * Throws on failure (callers decide whether that is fatal).
 */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fsyncDir(dir);
    return buf.length;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** JSON.stringify + writeFileAtomic. `space` matches the shipped users.json. */
export function writeJsonAtomic(file, value, space = 1) {
  return writeFileAtomic(file, JSON.stringify(value, null, space));
}

/** Read + parse, never throwing: `{ ok, value, error }`. */
export function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return { ok: true, value: null, error: null };
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { ok: false, value: null, error: e };
  }
}

/** Read a small text file, never throwing. */
export function readTextSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Sweep `dir` for `<base>.tmp-*` leftovers older than an hour. */
function sweepTmp(dir, base) {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.tmp-`)) continue;
      const p = path.join(dir, name);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// backup file naming
// ---------------------------------------------------------------------------

const stampRe = /^([a-z0-9_-]+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)\.json\.gz$/i;

/** 2026-08-14T22:30:00.123Z -> 2026-08-14T22-30-00-123Z (filename safe). */
function stampOf(date) {
  return date.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

function parseStamp(stamp) {
  // 2026-08-14T22-30-00-123Z -> 2026-08-14T22:30:00.123Z
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/.exec(stamp);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] || '000'}Z`);
}

let dayFmt = null;
/** Calendar day (America/New_York) a backup belongs to, as YYYY-MM-DD. */
function localDay(ms) {
  try {
    if (!dayFmt) {
      dayFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: BACKUP_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      });
    }
    return dayFmt.format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10); // Intl without tz data: UTC days
  }
}

const RESTORE_DOC = `# Restoring Capy Cove player data

Backups in this directory are gzipped snapshots of \`data/users.json\`, written
hourly by \`server/store.js\` and once on every clean shutdown. Rotation keeps
the **${HOURLY_KEEP} most recent** plus the newest snapshot of each of the last
**${DAILY_KEEP} calendar days** (${BACKUP_TZ}). Identical back-to-back snapshots
are skipped, so a quiet night does not flush the history.

File name: \`users-<UTC ISO with : and . replaced by ->.json.gz\`.

## Restore (the whole file)

1. **Stop the server.** Restoring under a live server loses everything written
   since the snapshot the moment the next \`saveSoon()\` fires.
2. Pick the snapshot. Newest first:
   \`\`\`sh
   ls -t data/backups/users-*.json.gz | head
   \`\`\`
3. **Keep the current file as evidence** (never delete it — a corrupt file is
   the only record of what went wrong):
   \`\`\`sh
   mv data/users.json data/users.json.before-restore-$(date -u +%Y%m%dT%H%M%SZ)
   \`\`\`
4. Decompress into place:
   \`\`\`sh
   gunzip -c data/backups/users-2026-08-14T22-00-00Z.json.gz > data/users.json
   \`\`\`
   PowerShell, no gzip binary:
   \`\`\`powershell
   node -e "const z=require('zlib'),f=require('fs');f.writeFileSync('data/users.json',z.gunzipSync(f.readFileSync(process.argv[1])))" data/backups/users-2026-08-14T22-00-00Z.json.gz
   \`\`\`
5. Sanity-check before booting:
   \`\`\`sh
   node -e "const u=require('./data/users.json');console.log(Object.keys(u).length,'accounts')"
   \`\`\`
6. Start the server. The load path re-normalises every record, so a snapshot
   from before a schema change still loads: uid, role, tokenV, mute and ban are
   backfilled on the way in.

## If \`users.json\` is corrupt and nobody noticed

The server does this for you at boot: an unparseable \`users.json\` is renamed
to \`users.json.corrupt-<stamp>\` and the newest backup is loaded in its place.
The rename is logged as \`[store] users.json unreadable\`. Check the log after
any hard kill, and keep the \`.corrupt-\` file until you know what happened.

## Drill (do this once, for real, before launch)

1. Copy \`data/\` to a scratch directory and point the server at it with
   \`COVE_DATA_DIR=/tmp/covedrill\`.
2. Delete \`users.json\` there, restore it from a backup with the steps above,
   boot, and log in as an existing account.
3. Write the date you did it in \`README.md\`. An untested restore is not a
   backup.
`;

// ---------------------------------------------------------------------------
// the live map
// ---------------------------------------------------------------------------

/**
 * The `users` Map, with the invariants attached to it rather than to every
 * call site. Legacy code does `users.set(key, rec)` directly (auth.js signup);
 * routing that through here means a record can never enter the world without
 * being normalised, and the uid index can never drift out of sync.
 */
class RecordMap extends Map {
  constructor(store) {
    super();
    this._store = store;
  }
  set(key, rec) {
    const store = this._store;
    if (store && !store._loading) {
      const k = String(key);
      const prev = super.get(k);
      if (prev && prev !== rec) store._unindex(prev);
      const normalized = store._normalize(rec, k);
      super.set(k, normalized);
      store._index(normalized);
      store._dirty = true;
      return this;
    }
    return super.set(key, rec);
  }
  delete(key) {
    const store = this._store;
    const prev = super.get(key);
    if (store && prev) { store._unindex(prev); store._dirty = true; }
    return super.delete(key);
  }
  clear() {
    const store = this._store;
    if (store) { store._byUid.clear(); store._dirty = true; }
    return super.clear();
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class Store {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir            directory holding users.json
   * @param {string} [opts.fileName]         'users.json'
   * @param {string} [opts.backupDir]        'backups'
   * @param {(rec:object, key:string)=>object} [opts.normalize]
   *        called for every record on load and on every insert. Must be
   *        idempotent and must return the record (or a replacement).
   * @param {(rec:object)=>string} [opts.uidOf]  reads the stable id off a record
   * @param {(msg:string, err?:Error)=>void} [opts.log]
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir;
    this.fileName = opts.fileName || 'users.json';
    this.file = path.join(this.dataDir, this.fileName);
    this.backupDir = path.join(this.dataDir, opts.backupDir || 'backups');
    this.base = this.fileName.replace(/\.json$/i, '');
    this._normalizeHook = typeof opts.normalize === 'function' ? opts.normalize : (r) => r;
    this._uidOf = typeof opts.uidOf === 'function' ? opts.uidOf : (r) => (r && typeof r.uid === 'string' ? r.uid : '');
    this._log = typeof opts.log === 'function' ? opts.log : (msg, e) => console.error(msg, e ? e.message : '');

    this.map = new RecordMap(this);
    this._byUid = new Map(); // uid -> record
    this._loading = false;
    this._dirty = false;
    this._saveTimer = null;
    this._backupTimer = null;
    this._inTx = 0;
    this._txPending = false;
    this._hooksInstalled = false;
    this._lastBackupHash = '';
    this._stats = {
      loadedAt: 0, loadedFrom: '', accountsLoaded: 0,
      saves: 0, saveFails: 0, lastSaveMs: 0, lastSaveAt: 0, lastBytes: 0,
      backups: 0, backupFails: 0, lastBackupAt: 0, lastBackupFile: '',
      restored: 0,
    };

    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ---- indexing -----------------------------------------------------------

  _normalize(rec, key) {
    try {
      const out = this._normalizeHook(rec, key, this);
      return out === undefined ? rec : out;
    } catch (e) {
      this._log('[store] normalize failed:', e);
      return rec;
    }
  }

  _index(rec) {
    const uid = this._uidOf(rec);
    if (uid) this._byUid.set(uid, rec);
  }

  _unindex(rec) {
    const uid = this._uidOf(rec);
    if (uid && this._byUid.get(uid) === rec) this._byUid.delete(uid);
  }

  /** True if some OTHER record already owns this uid. Used by db.ensureAccount. */
  uidTaken(uid, self) {
    if (!uid) return false;
    const held = this._byUid.get(uid);
    return !!held && held !== self;
  }

  // ---- load ---------------------------------------------------------------

  /**
   * Read users.json into the map. An unparseable file is preserved as
   * `<file>.corrupt-<stamp>` and the newest backup is loaded instead, because
   * booting onto an empty map and then saving over the evidence is the single
   * worst thing this file could do.
   */
  load() {
    sweepTmp(this.dataDir, this.fileName);
    let source = this.file;
    let read = readJsonSafe(this.file);

    if (!read.ok) {
      const bad = `${this.file}.corrupt-${stampOf(new Date())}`;
      this._log(`[store] ${this.fileName} unreadable (${read.error.message}); kept as ${path.basename(bad)}`);
      try { fs.renameSync(this.file, bad); } catch (e) { this._log('[store] could not set aside corrupt file:', e); }
      const newest = this.listBackups()[0];
      if (newest) {
        const fallback = this._readBackup(newest.name);
        if (fallback.ok) {
          read = { ok: true, value: fallback.value, error: null };
          source = path.join(this.backupDir, newest.name);
          this._log(`[store] recovered from backup ${newest.name}`);
        } else {
          this._log('[store] newest backup is unreadable too:', fallback.error);
          read = { ok: true, value: null, error: null };
        }
      } else {
        this._log('[store] no backup to fall back to; starting empty');
        read = { ok: true, value: null, error: null };
      }
    }

    const obj = read.value && typeof read.value === 'object' && !Array.isArray(read.value) ? read.value : {};
    this._loading = true;
    this.map.clear();
    this._byUid.clear();
    this._loading = false;
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      this.map.set(k, v); // RecordMap.set normalises + indexes
      n++;
    }
    this._dirty = false;
    this._stats.loadedAt = Date.now();
    this._stats.loadedFrom = source;
    this._stats.accountsLoaded = n;
    return n;
  }

  // ---- interface ----------------------------------------------------------

  getUser(key) {
    return this.map.get(String(key || '').toLowerCase()) || null;
  }

  hasUser(key) {
    return this.map.has(String(key || '').toLowerCase());
  }

  /** Insert or replace. Key comes from `rec.username` unless given. */
  putUser(rec, key) {
    const k = String(key || rec?.username || '').toLowerCase();
    if (!k) return null;
    this.map.set(k, rec);
    this.saveSoon();
    return this.map.get(k);
  }

  /** Like putUser but refuses to clobber an existing key. */
  createUser(rec, key) {
    const k = String(key || rec?.username || '').toLowerCase();
    if (!k || this.map.has(k)) return null;
    return this.putUser(rec, k);
  }

  deleteUser(key) {
    const k = String(key || '').toLowerCase();
    const had = this.map.delete(k);
    if (had) this.saveSoon();
    return had;
  }

  /** `[key, record]` pairs. Iterating the live map: do not mutate while looping. */
  allUsers() {
    return this.map.entries();
  }

  count() {
    return this.map.size;
  }

  findByUid(uid) {
    if (typeof uid !== 'string' || !uid) return null;
    return this._byUid.get(uid) || null;
  }

  /** Prefix search over the account key, for the admin panel's search box. */
  searchUsers(prefix, limit = 25) {
    const q = String(prefix || '').toLowerCase();
    const cap = Math.max(1, Math.min(500, Math.floor(Number(limit) || 25)));
    const out = [];
    for (const [k, rec] of this.map) {
      if (q && !k.startsWith(q)) continue;
      out.push(rec);
      if (out.length >= cap) break;
    }
    return out;
  }

  /**
   * Move a record from one key to another, preserving identity (same object,
   * same uid). Returns false if the source is missing or the target is taken.
   * The account-level rename (display name, tokenV, friend sweep) is
   * db.renameAccount; this is just the rekey.
   */
  rekey(oldKey, newKey) {
    const from = String(oldKey || '').toLowerCase();
    const to = String(newKey || '').toLowerCase();
    if (!from || !to) return false;
    const rec = this.map.get(from);
    if (!rec) return false;
    if (from !== to && this.map.has(to)) return false;
    this.map.delete(from);
    this.map.set(to, rec);
    this.saveSoon();
    return true;
  }

  /**
   * Run `fn` with persistence coalesced into one save at the end. Rolls the
   * map back if `fn` throws (deep snapshot; skipped above TX_SNAPSHOT_LIMIT
   * accounts, where a rollback would cost more than it protects — the SQLite
   * implementation replaces this with a real transaction).
   */
  tx(fn) {
    const snap = this.map.size <= TX_SNAPSHOT_LIMIT
      ? JSON.stringify(Object.fromEntries(this.map))
      : null;
    this._inTx++;
    try {
      const out = fn(this);
      this._inTx--;
      if (this._inTx === 0 && this._txPending) { this._txPending = false; this.saveSoon(); }
      return out;
    } catch (e) {
      this._inTx--;
      if (snap !== null) {
        this._loading = true;
        this.map.clear();
        this._byUid.clear();
        this._loading = false;
        for (const [k, v] of Object.entries(JSON.parse(snap))) this.map.set(k, v);
      }
      this._txPending = false;
      throw e;
    }
  }

  /**
   * Leading-edge, fixed-window debounce (500 ms). A busy server writes at most
   * twice a second and can never be starved by a steady stream of edits.
   */
  saveSoon() {
    this._dirty = true;
    if (this._inTx > 0) { this._txPending = true; return; }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
  }

  /** Serialize exactly as the shipped file did: one-space indent, key order. */
  serialize() {
    return JSON.stringify(Object.fromEntries(this.map), null, 1);
  }

  /** Write now, atomically. Returns true on success; never throws. */
  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    const t0 = Date.now();
    try {
      const bytes = writeFileAtomic(this.file, this.serialize());
      this._dirty = false;
      this._stats.saves++;
      this._stats.lastSaveMs = Date.now() - t0;
      this._stats.lastSaveAt = Date.now();
      this._stats.lastBytes = bytes;
      return true;
    } catch (e) {
      this._stats.saveFails++;
      this._log('[store] save failed:', e);
      return false;
    }
  }

  stats() {
    return {
      accounts: this.map.size,
      dirty: this._dirty,
      file: this.file,
      backupDir: this.backupDir,
      ...this._stats,
    };
  }

  // ---- backups ------------------------------------------------------------

  /** Newest first. `[{ name, at, day, bytes }]`. */
  listBackups() {
    let names = [];
    try { names = fs.readdirSync(this.backupDir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = stampRe.exec(name);
      if (!m || m[1].toLowerCase() !== this.base.toLowerCase()) continue;
      const at = parseStamp(m[2]);
      if (!Number.isFinite(at)) continue;
      let bytes = 0;
      try { bytes = fs.statSync(path.join(this.backupDir, name)).size; } catch {}
      out.push({ name, at, day: localDay(at), bytes });
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  _readBackup(name) {
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(path.join(this.backupDir, name)));
      const value = JSON.parse(raw.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return { ok: true, value, error: null };
    } catch (e) {
      return { ok: false, value: null, error: e };
    }
  }

  /**
   * Snapshot the current map to `data/backups/users-<stamp>.json.gz`, then
   * rotate. Identical back-to-back snapshots are skipped unless `force`, so a
   * quiet night cannot rotate the useful history out of the window.
   */
  backup({ force = false, reason = 'hourly' } = {}) {
    try {
      const body = this.serialize();
      const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
      const hash = `${body.length}:${this.map.size}`;
      if (!force && hash === this._lastBackupHash) {
        return { ok: true, skipped: true, reason, file: this._stats.lastBackupFile };
      }
      fs.mkdirSync(this.backupDir, { recursive: true });
      this.writeRestoreDoc();
      const name = `${this.base}-${stampOf(new Date())}.json.gz`;
      writeFileAtomic(path.join(this.backupDir, name), gz);
      this._lastBackupHash = hash;
      this._stats.backups++;
      this._stats.lastBackupAt = Date.now();
      this._stats.lastBackupFile = name;
      const dropped = this.rotateBackups();
      return { ok: true, skipped: false, reason, file: name, bytes: gz.length, dropped };
    } catch (e) {
      this._stats.backupFails++;
      this._log('[store] backup failed:', e);
      return { ok: false, skipped: false, reason, error: e.message };
    }
  }

  /**
   * Snapshot the file EXACTLY AS IT IS ON DISK, before anything rewrites it.
   * This is the "one backup before every schema migration" step: by the time a
   * backfill has run, `serialize()` no longer describes what was there.
   */
  backupRaw({ reason = 'pre-migration' } = {}) {
    try {
      if (!fs.existsSync(this.file)) return { ok: true, skipped: true, reason };
      const gz = zlib.gzipSync(fs.readFileSync(this.file), { level: 9 });
      fs.mkdirSync(this.backupDir, { recursive: true });
      this.writeRestoreDoc();
      const name = `${this.base}-${stampOf(new Date())}.json.gz`;
      writeFileAtomic(path.join(this.backupDir, name), gz);
      this._stats.backups++;
      this._stats.lastBackupAt = Date.now();
      this._stats.lastBackupFile = name;
      const dropped = this.rotateBackups();
      return { ok: true, skipped: false, reason, file: name, bytes: gz.length, dropped };
    } catch (e) {
      this._stats.backupFails++;
      this._log('[store] pre-migration backup failed:', e);
      return { ok: false, reason, error: e.message };
    }
  }

  /** Keep the 24 newest plus the newest of each of the last 7 local days. */
  rotateBackups() {
    const all = this.listBackups(); // newest first
    if (!all.length) return [];
    const keep = new Set(all.slice(0, HOURLY_KEEP).map((b) => b.name));
    const perDay = new Map();
    for (const b of all) if (!perDay.has(b.day)) perDay.set(b.day, b.name);
    let days = 0;
    for (const name of perDay.values()) {
      if (days++ >= DAILY_KEEP) break;
      keep.add(name);
    }
    const dropped = [];
    for (const b of all) {
      if (keep.has(b.name)) continue;
      try { fs.unlinkSync(path.join(this.backupDir, b.name)); dropped.push(b.name); } catch {}
    }
    return dropped;
  }

  /** The doc that lives beside the backups. Rewritten whenever it goes missing. */
  writeRestoreDoc() {
    const file = path.join(this.backupDir, 'RESTORE.md');
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === RESTORE_DOC) return false;
      fs.mkdirSync(this.backupDir, { recursive: true });
      writeFileAtomic(file, RESTORE_DOC);
      return true;
    } catch (e) {
      this._log('[store] could not write RESTORE.md:', e);
      return false;
    }
  }

  /**
   * Replace the live map with a backup's contents and write it through.
   * `name` defaults to the newest backup. The server should not be serving
   * while this runs (see RESTORE.md); it exists for the drill and for the
   * eventual panel button.
   */
  restoreFromBackup(name) {
    const pick = name || this.listBackups()[0]?.name;
    if (!pick) return { ok: false, msg: 'no backups' };
    const read = this._readBackup(pick);
    if (!read.ok) return { ok: false, msg: `unreadable: ${read.error.message}` };
    this.backup({ force: true, reason: 'pre-restore' });
    this._loading = true;
    this.map.clear();
    this._byUid.clear();
    this._loading = false;
    let n = 0;
    for (const [k, v] of Object.entries(read.value)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      this.map.set(k, v);
      n++;
    }
    const ok = this.flush();
    this._stats.restored++;
    return { ok, file: pick, accounts: n };
  }

  /** Hourly timer. unref'd: a backup schedule must not hold the process open. */
  startBackups(everyMs = BACKUP_INTERVAL_MS) {
    if (this._backupTimer) return;
    this.writeRestoreDoc();
    this._backupTimer = setInterval(() => this.backup({ reason: 'hourly' }), everyMs);
    if (typeof this._backupTimer.unref === 'function') this._backupTimer.unref();
  }

  stopBackups() {
    if (this._backupTimer) { clearInterval(this._backupTimer); this._backupTimer = null; }
  }

  // ---- shutdown -----------------------------------------------------------

  /**
   * Flush (and snapshot) on the way out. SIGINT/SIGTERM flush, back up and
   * exit; beforeExit only flushes. Installing a SIGINT handler suppresses the
   * default kill, so this deliberately calls process.exit afterwards — pass
   * `{ exit: false }` if the host wants to own the exit.
   */
  installShutdownHooks({ exit = true, code = 0 } = {}) {
    if (this._hooksInstalled) return false;
    this._hooksInstalled = true;
    let going = false;
    const bye = (signal) => {
      if (going) return;
      going = true;
      try {
        this.flush();
        this.backup({ force: true, reason: `shutdown:${signal}` });
      } catch (e) { this._log('[store] shutdown flush failed:', e); }
      this.stopBackups();
      if (exit) process.exit(code);
    };
    process.on('SIGINT', () => bye('SIGINT'));
    process.on('SIGTERM', () => bye('SIGTERM'));
    process.on('beforeExit', () => { if (this._dirty) this.flush(); });
    return true;
  }
}

/** Factory, so tests can point a store at a sandbox directory. */
export function createStore(opts) {
  return new Store(opts);
}
