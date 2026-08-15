/**
 * server/chatlog.js — chat retention: the 30-line ring, the 7-day journal, and
 * the one audited way to read either (wave 10B, N-14, spec
 * docs/research/accounts-admin.md §7.4).
 *
 * WHY THIS FILE EXISTS. The report queue is useless without context. Today a
 * whisper leaves no trace anywhere (AUDIT F-22), so an operator handed a report
 * has literally nothing to look at and every decision is a coin flip. This file
 * is the evidence layer under `server/reports.js`, and nothing else.
 *
 * Contract with index.js — the same install(ctx) shape as progress.js:6-11,
 * admin.js and audit.js, so every wiring line in the server reads alike:
 *   - install(ctx)      once at boot, beside audit.install / admin.install.
 *   - observe(p, m)     ONE line in the ws message path. It NEVER consumes a
 *                       frame and always returns false: this module watches,
 *                       it does not moderate. Put it AFTER admin.handleMessage
 *                       (a muted player's line is eaten there and by design
 *                       never reaches the log — nothing was said to anyone) and
 *                       before the main switch.
 *   - record(entry)     the explicit writer, for lines observe() cannot see:
 *                       the whisper RECIPIENT's copy, a forced rename, anything
 *                       a future social surface produces.
 *   - drop(p)           on disconnect (optional: rings self-evict).
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 *
 * No mute, no filter, no refusal. `server/filter.js` (10A) decides what may be
 * said and `server/admin.js` decides who may say it; by the time a line reaches
 * this file the server has already accepted it. Keeping the recorder out of the
 * decision path means a bug in retention can never cost a player their message.
 *
 * SEPARATION FROM THE AUDIT LOG (§7.4, and this is load-bearing)
 *
 * The 90-day audit log and the 7-day chat log are different systems on purpose:
 * different write pattern, different retention, different privacy posture, and
 * a corrupt user database must not be able to take the evidence with it. They
 * share exactly one thing — `linesReverse`, a pure backwards file reader
 * imported from audit.js — and no write path, no directory and no fd. The audit
 * log's redactor strips `text`/`msg`/`lines` at any depth precisely so chat can
 * never leak into it sideways; nothing here ever calls audit.log directly, only
 * `ctx.audit` and only to record that a HUMAN READ the log.
 *
 * RETENTION, STATED SO THE PRIVACY PAGE (10E) CAN QUOTE IT
 *
 *   in memory : the last 30 lines per connected player, dropped on disconnect
 *   on disk   : data/chatlog/chat-YYYY-MM-DD.jsonl, deleted after 7 days
 *   read by   : role >= mod only, and every read is itself an audit line
 *               (`mod.chatlog.read`, audit.js OPS.CHATLOG_READ)
 *
 * The ring answers ~90% of reports on its own because reports arrive seconds
 * after the offence; the journal exists for the ones that arrive on Monday.
 *
 * WHAT A LINE LOOKS LIKE (§7.4 shape, plus the two fields a guest needs)
 *
 *   {at, uid, name, id, room, kind, to, toUid, text}
 *
 *   uid   the account's immutable id, '' for a guest. The join key.
 *   id    the live connection id — the only handle a guest has.
 *   kind  'chat' | 'whisper' | 'dd-guess' | 'ph-msg' | 'name' | 'other'
 *   to    display name of the whisper's other end, '' otherwise.
 *
 * A whisper is recorded TWICE, once against each participant, so reading one
 * player's log shows both halves of their conversation without a join. That is
 * the "both directions" in §7.4 and it is why `record()` is exported.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// The ONLY thing shared with the audit log: a pure, allocation-light backwards
// line reader. No write path, no directory, no file descriptor is shared.
import { linesReverse } from './audit.js';
import { requireCap as adminRequireCap } from './admin.js';
import { CHAT_MAX_LEN } from '../shared/constants.js';

// ---------------------------------------------------------------------------
// constants (all overridable through install(ctx))
// ---------------------------------------------------------------------------

/** Lines kept in memory per connected player (§7.4: ~4 KB/player). */
export const RING_LINES = 30;
/** Days the journal is kept. Disclose this number in the privacy policy. */
export const KEEP_DAYS = 7;
/** Batched fsync window. Evidence is worth 250 ms of exposure, not more. */
export const FSYNC_MS = 250;
/** Purge sweep cadence (also runs at boot and whenever the day rolls). */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Hard clip on a stored line. CHAT_MAX_LEN is 120; ph-msg strings can be odd. */
export const TEXT_MAX = Math.max(200, CHAT_MAX_LEN + 40);
/** Rings held for players who never disconnected cleanly. Bounds memory. */
export const MAX_RINGS = 600;
/** A ring untouched for this long is evictable when MAX_RINGS is reached. */
export const RING_IDLE_MS = 30 * 60 * 1000;
/** Cap on one readBack page, and on the scan behind it. */
export const READ_LIMIT_MAX = 200;
export const READ_SCAN_MAX = 60_000;
/** The capability a chat-log read requires. Mods hold it (admin.js CAPS). */
export const READ_CAP = 'inspect';
/** Audit op name. Identical to server/audit.js OPS.CHATLOG_READ. */
export const READ_OP = 'mod.chatlog.read';

/**
 * Frame name -> line kind. This is the whole capture surface: adding a social
 * surface later means adding one entry here (and one to admin.js MUTED_FRAMES,
 * which is the matching one-line change on the enforcement side).
 */
export const CAPTURED = Object.freeze({
  chat: 'chat',
  whisper: 'whisper',
  'dd-guess': 'dd-guess',
  'ph-msg': 'ph-msg',
});

export const KINDS = Object.freeze(['chat', 'whisper', 'dd-guess', 'ph-msg', 'name', 'other']);
const KIND_SET = new Set(KINDS);

const FILE_RE = /^chat-(\d{4}-\d{2}-\d{2})\.jsonl$/;

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const S = {
  installed: false,
  dir: '',
  day: '',
  file: '',
  fd: null,
  dirty: false,
  ringLines: RING_LINES,
  keepDays: KEEP_DAYS,
  fsyncMs: FSYNC_MS,
  textMax: TEXT_MAX,
  maxRings: MAX_RINGS,
  disk: true,
  now: Date.now,
  logFn: (msg, err) => console.error(err ? `[chatlog] ${msg}: ${err?.message || err}` : `[chatlog] ${msg}`),
  auditFn: null,
  requireCap: adminRequireCap,
  recordFor: null,
  fsyncTimer: null,
  sweepTimer: null,
  hooked: false,
  /** identity key -> { uid, name, id, room, at, lines: [] } */
  rings: new Map(),
  // counters
  observed: 0, written: 0, writeFails: 0, bytes: 0, dropped: 0, purged: 0,
  reads: 0, readsRefused: 0, evicted: 0,
};

const nowMs = () => {
  const t = Number(S.now());
  return Number.isFinite(t) ? t : Date.now();
};

/** UTC calendar day, exactly as the audit log rotates: one boundary, no DST. */
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
 * Control characters become spaces before anything is stored: an evidence log
 * is read by a human in a terminal and, later, in an HTML panel, and a line
 * carrying a raw CR or an ANSI escape can rewrite what the operator thinks
 * they are looking at. Nothing else about the text is altered - what may be
 * SAID is 10A filter.js business; this log records what the server actually
 * accepted, warts and all.
 */
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * The key a ring hangs on. An account is its uid, so two tabs share one ring
 * and a rename does not orphan the evidence; a guest is its connection id,
 * which is all the identity a guest has and is exactly why guests do not get
 * full chat (the owner's wave-10 decision).
 */
export function keyFor(who) {
  if (!who) return '';
  if (typeof who === 'string') return who.startsWith('u:') || who.startsWith('g:') ? who : `u:${who}`;
  if (who.uid) return `u:${who.uid}`;
  const rec = who.registered && typeof S.recordFor === 'function' ? S.recordFor(who) : null;
  if (rec?.uid) return `u:${rec.uid}`;
  if (who.id) return `g:${who.id}`;
  if (who.name) return `n:${String(who.name).toLowerCase()}`;
  return '';
}

/** uid / name / id / a live player, resolved to the ring that holds them. */
function findRing(who) {
  if (!who) return null;
  const direct = S.rings.get(keyFor(who));
  if (direct) return direct;
  const q = typeof who === 'string' ? { any: who } : who;
  const uid = q.uid ? String(q.uid) : '';
  const id = q.id ? String(q.id) : '';
  const name = q.name ? String(q.name).toLowerCase() : '';
  const any = q.any ? String(q.any).toLowerCase() : '';
  for (const r of S.rings.values()) {
    if (uid && r.uid === uid) return r;
    if (id && r.id === id) return r;
    if (name && r.name.toLowerCase() === name) return r;
    if (any && (r.uid.toLowerCase() === any || r.name.toLowerCase() === any || r.id.toLowerCase() === any)) return r;
  }
  return null;
}

function ringFor(meta) {
  const key = keyFor(meta);
  if (!key) return null;
  let r = S.rings.get(key);
  if (!r) {
    if (S.rings.size >= S.maxRings) evictRings();
    r = { key, uid: meta.uid || '', name: meta.name || '', id: meta.id || '', room: meta.room || '', at: nowMs(), lines: [] };
    S.rings.set(key, r);
  }
  if (meta.name) r.name = meta.name;
  if (meta.id) r.id = meta.id;
  if (meta.room) r.room = meta.room;
  if (meta.uid) r.uid = meta.uid;
  r.at = nowMs();
  return r;
}

/** Drop the idlest rings when the table is full. Evidence is not worth a leak. */
function evictRings() {
  const now = nowMs();
  const victims = [];
  for (const [k, r] of S.rings) if (now - r.at > RING_IDLE_MS) victims.push(k);
  if (!victims.length) {
    const all = [...S.rings.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < Math.ceil(all.length / 8); i++) victims.push(all[i][0]);
  }
  for (const k of victims) { S.rings.delete(k); S.evicted++; }
}

// ---------------------------------------------------------------------------
// file plumbing (its own fd, its own directory, shared with nothing)
// ---------------------------------------------------------------------------

function fileFor(dir, day) { return path.join(dir, `chat-${day}.jsonl`); }

/** Every journal file on disk, newest day first. */
export function listFiles(dir = S.dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    let bytes = 0;
    try { bytes = fs.statSync(full).size; } catch { continue; }
    out.push({ name, file: full, day: m[1], bytes });
  }
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return out;
}

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

function openDay(day) {
  if (S.fd !== null && S.day === day) return true;
  const rolled = S.fd !== null && S.day !== day;
  closeFd();
  try {
    fs.mkdirSync(S.dir, { recursive: true });
    S.fd = fs.openSync(fileFor(S.dir, day), 'a');
    S.day = day;
    S.file = fileFor(S.dir, day);
    if (rolled) queueMicrotask(() => { try { sweep(); } catch {} });
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

/** fsync the journal now. Never throws. */
export function flush() {
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.fd === null || !S.dirty) return true;
  try { fs.fsyncSync(S.fd); S.dirty = false; return true; } catch (e) {
    S.logFn('fsync failed', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * Record one line: ring first, journal second.
 *
 *   record({ at?, uid?, name?, id?, room?, kind, to?, toUid?, text, who? })
 *
 * `who` may be a live player object instead of uid/name/id/room — that is the
 * common call and it is what observe() uses. Returns the stored line, or null
 * if there was nothing to store.
 *
 * NEVER THROWS. A retention failure must not be able to cost a player their
 * chat message: the whole module is downstream of delivery.
 */
export function record(entry = {}) {
  try {
    if (!S.installed) install({});
    const e = entry && typeof entry === 'object' ? entry : {};
    const who = e.who && typeof e.who === 'object' ? e.who : null;
    const text = clean(e.text, S.textMax);
    if (!text) return null;

    const rec = who && who.registered && typeof S.recordFor === 'function' ? S.recordFor(who) : null;
    const at = clampInt(e.at, 0, 4102444800000, nowMs());
    const kind = KIND_SET.has(e.kind) ? e.kind : 'other';
    const line = {
      at,
      uid: clean(e.uid ?? rec?.uid ?? '', 64),
      name: clean(e.name ?? who?.name ?? rec?.username ?? '', 64),
      id: clean(e.id ?? who?.id ?? '', 32),
      room: clean(e.room ?? who?.room ?? '', 32),
      kind,
      to: clean(e.to ?? '', 64),
      toUid: clean(e.toUid ?? '', 64),
      text,
    };
    if (!line.uid && !line.name && !line.id) return null;

    // 1. the ring. This is what answers the report that arrives in ten seconds.
    const r = ringFor(line);
    if (r) {
      r.lines.push(line);
      if (r.lines.length > S.ringLines) r.lines.splice(0, r.lines.length - S.ringLines);
    }

    // 2. the journal. This is what answers the report that arrives on Monday.
    if (S.disk) {
      const day = utcDay(at);
      if (day !== S.day || S.fd === null) { if (!openDay(day)) return line; }
      const buf = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8');
      try {
        writeAll(S.fd, buf);
        S.written++;
        S.bytes += buf.length;
        S.dirty = true;
        scheduleFsync();
      } catch (err) {
        S.writeFails++;
        S.logFn('journal write failed', err);
      }
    }
    return line;
  } catch (err) {
    S.writeFails++;
    try { S.logFn('record() failed', err); } catch {}
    return null;
  }
}

/**
 * The one-line hook for index.js's ws message path.
 *
 * ALWAYS RETURNS FALSE — it can never consume a frame, so its insertion point
 * cannot change the behaviour of any handler. Insert it after
 * admin.handleMessage (so a muted player's swallowed line is never logged as
 * something they said) and before the main switch.
 *
 * What it captures, and the one judgment call: `ph-msg` is Prop Hunt's relay
 * and carries mostly game state, so only a STRING payload (or `{text}`) is
 * treated as speech. Structured props are not chat and do not belong in an
 * evidence log a human has to read.
 */
export function observe(p, m) {
  try {
    if (!p || !m || typeof m.t !== 'string') return false;
    const kind = Object.prototype.hasOwnProperty.call(CAPTURED, m.t) ? CAPTURED[m.t] : '';
    if (!kind) return false;
    let text = '';
    let to = '';
    if (kind === 'ph-msg') {
      const payload = m.m !== undefined ? m.m : m.data;
      if (typeof payload === 'string') text = payload;
      else if (payload && typeof payload === 'object' && typeof payload.text === 'string') text = payload.text;
      if (!text) return false;
    } else {
      text = typeof m.text === 'string' ? m.text : '';
      if (kind === 'whisper') to = typeof m.to === 'string' ? m.to : '';
    }
    if (!text.trim()) return false;
    S.observed++;
    record({ who: p, kind, text, to });
  } catch (e) {
    try { S.logFn('observe failed', e); } catch {}
  }
  return false; // never, ever consume
}

/**
 * The whisper's other half. index.js knows the resolved recipient (observe()
 * only sees the name the sender typed), so the orchestrator calls this beside
 * the existing `sendTo(target, …)` and both players' rings then show the whole
 * conversation.
 */
export function whisper(from, to, text, opts = {}) {
  const fromRec = from?.registered && typeof S.recordFor === 'function' ? S.recordFor(from) : null;
  const toRec = to?.registered && typeof S.recordFor === 'function' ? S.recordFor(to) : null;
  const at = clampInt(opts.at, 0, 4102444800000, nowMs());
  const body = clean(text, S.textMax);

  // observe() has already stored the SENDER's copy if it saw the frame, and it
  // sees every whisper. Writing it again here would double every whisper in the
  // journal and make one message read as two in the ring — which is how an
  // operator ends up warning somebody for "spamming". Detect the copy that just
  // landed rather than asking the orchestrator to wire exactly one of the two:
  // both wirings are reasonable, and only one of them can be wrong.
  const mine = findRing(from);
  const dupe = !!mine && mine.lines.some(
    (l) => l.kind === 'whisper' && l.text === body && at - l.at < 1500,
  );

  const a = dupe ? null : record({ at, who: from, kind: 'whisper', text, to: to?.name || '', toUid: toRec?.uid || '' });
  const b = record({ at, who: to, kind: 'whisper', text, to: from?.name || '', toUid: fromRec?.uid || '' });
  return a || b;
}

/** Forget a disconnected player's ring. The journal is untouched. */
export function drop(p) {
  const r = findRing(p);
  if (!r) return false;
  S.rings.delete(r.key);
  S.dropped++;
  return true;
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * The in-memory ring for one player, oldest first. NOT an operator read: this
 * is what `server/reports.js` calls to freeze context onto a report the instant
 * it is filed, which is a machine copying evidence, not a human reading chat.
 * The human read is read() below and it is audited.
 */
export function linesFor(who, opts = {}) {
  const limit = clampInt(opts.limit, 1, RING_LINES * 4, 20);
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? new Set(opts.kinds) : null;
  const r = findRing(who);
  if (!r) return [];
  const out = kinds ? r.lines.filter((l) => kinds.has(l.kind)) : r.lines;
  return out.slice(-limit).map((l) => ({ ...l }));
}

const encodeCursor = (day, at, n) => `c1:${day}:${at}:${n}`;
function parseCursor(c) {
  if (!c || typeof c !== 'string') return null;
  const m = /^c1:(\d{4}-\d{2}-\d{2}):(\d+):(\d+)$/.exec(c);
  return m ? { day: m[1], at: Number(m[2]), n: Number(m[3]) } : null;
}

function matchLine(f, rec) {
  if (f.uid && String(rec.uid || '') !== String(f.uid)) return false;
  if (f.name && String(rec.name || '').toLowerCase() !== String(f.name).toLowerCase()) return false;
  if (f.id && String(rec.id || '') !== String(f.id)) return false;
  if (f.room && String(rec.room || '') !== String(f.room)) return false;
  if (f.kind) {
    const list = Array.isArray(f.kind) ? f.kind : [f.kind];
    if (!list.includes(rec.kind)) return false;
  }
  // Time bounds are `since`/`until`, NOT from/to: a chat line's own `to` is the
  // whisper recipient, and one word meaning two things in one filter object is
  // how an operator ends up reading the wrong week.
  if (f.since != null && rec.at < Number(f.since)) return false;
  if (f.until != null && rec.at > Number(f.until)) return false;
  if (f.q && !String(rec.text || '').toLowerCase().includes(String(f.q).toLowerCase())) return false;
  // `who` is the convenience filter: uid OR name OR connection id, one field.
  if (f.who) {
    const w = String(f.who).toLowerCase();
    const hit = String(rec.uid || '').toLowerCase() === w
      || String(rec.name || '').toLowerCase() === w
      || String(rec.id || '').toLowerCase() === w
      || String(rec.to || '').toLowerCase() === w;
    if (!hit) return false;
  }
  return true;
}

/**
 * Newest-first, cursored read of the JOURNAL. Files are streamed backwards, so
 * a week of history costs one page of memory, not a week of it.
 *
 *   readBack({ uid, name, id, who, room, kind, q, since, until, day, limit },
 *            cursor)
 *   -> { lines, cursor, done, scanned }
 *
 * Unaudited and uncapped ON PURPOSE: it is the mechanism. Every human-facing
 * path goes through read(), which is where the capability check and the audit
 * line live. Nothing outside this module and reports.js may call it.
 */
export function readBack(filter = {}, cursor = null) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const limit = clampInt(f.limit, 1, READ_LIMIT_MAX, 50);
  const maxScan = clampInt(f.maxScan, 1, READ_SCAN_MAX, 20_000);
  const cur = parseCursor(cursor);
  const out = { lines: [], cursor: null, done: false, scanned: 0 };

  let files = listFiles();
  if (f.day) files = files.filter((x) => x.day === String(f.day));
  if (cur) {
    const i = files.findIndex((x) => x.day <= cur.day);
    files = i < 0 ? [] : files.slice(i);
  }
  if (!files.length) { out.done = true; return out; }

  for (const file of files) {
    let n = 0;
    let last = null;
    for (const raw of linesReverse(file.file)) {
      if (out.scanned >= maxScan) {
        out.cursor = last ? encodeCursor(file.day, last.at, n) : cursor;
        return out;
      }
      out.scanned++;
      n++;
      let rec = null;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      last = rec;
      // The cursor is (day, nth line from the end of that day): the journal is
      // append-only and never rewritten, so an offset from the tail is stable.
      if (cur && file.day === cur.day && n <= cur.n) continue;
      if (!matchLine(f, rec)) continue;
      out.lines.push(rec);
      if (out.lines.length >= limit) {
        out.cursor = encodeCursor(file.day, rec.at, n);
        return out;
      }
    }
  }
  out.done = true;
  return out;
}

/**
 * THE OPERATOR READ. Capability-checked, audited, and the only path any UI may
 * use. "Watching the watchers costs one line" (§7.4).
 *
 *   read(actor, { who|uid|name|id, kind, room, q, since, until, day, limit,
 *                 ring }, cursor)
 *   -> { ok, lines, cursor, done, source } | { ok:false, msg, code }
 *
 * `ring:true` (the default when a single subject is named and no cursor is
 * given) prepends the live in-memory ring, so the operator sees the last thirty
 * lines even before the fsync window has closed. The audit line records WHO was
 * read and WITH WHAT FILTER — never a single word of what was said, which is
 * what keeps this log a 7-day evidence store and not a surveillance product.
 */
export function read(actor, filter = {}, cursor = null) {
  const f = filter && typeof filter === 'object' ? { ...filter } : {};
  const capOk = typeof S.requireCap === 'function' ? S.requireCap(actor, READ_CAP) : false;
  if (!capOk) {
    S.readsRefused++;
    return { ok: false, msg: 'You do not have permission to read chat logs', code: 'cap' };
  }
  const subject = f.who || f.uid || f.name || f.id || '';
  if (!subject && !f.room && !f.q && !f.day) {
    // A bare "give me everything" is not a moderation question, it is a dump.
    return { ok: false, msg: 'Name a player, a room, a day or a search term', code: 'args' };
  }
  S.reads++;
  const wantRing = f.ring !== false && !!subject && !cursor;
  const page = readBack(f, cursor);
  let lines = page.lines;
  if (wantRing) {
    const ring = linesFor(subject, { limit: S.ringLines, kinds: Array.isArray(f.kind) ? f.kind : (f.kind ? [f.kind] : null) });
    // Newest-first to match the journal page, and de-duplicated: the ring and
    // the journal hold the same line, and an operator counting repeats would
    // read a duplicate as two offences.
    const seen = new Set(lines.map((l) => `${l.at}|${l.id}|${l.text}`));
    const extra = [];
    for (const l of ring.slice().reverse()) {
      const k = `${l.at}|${l.id}|${l.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      extra.push(l);
    }
    lines = [...extra, ...lines].sort((a, b) => b.at - a.at).slice(0, clampInt(f.limit, 1, READ_LIMIT_MAX, 50));
  }

  audit(READ_OP, actor, subject ? { name: String(f.name || f.who || ''), uid: String(f.uid || '') } : null, {
    // The FILTER, never the content. audit.js redacts `text`/`lines` anyway;
    // this is belt and braces, and it documents the intent at the call site.
    who: String(subject || ''),
    room: f.room || '',
    kind: f.kind || '',
    day: f.day || '',
    search: f.q ? true : false,
    limit: clampInt(f.limit, 1, READ_LIMIT_MAX, 50),
    returned: lines.length,
    ring: wantRing,
    paged: !!cursor,
  });

  return { ok: true, lines, cursor: page.cursor, done: page.done, scanned: page.scanned, source: wantRing ? 'ring+journal' : 'journal' };
}

/** One shape for every audit line this module writes, through ctx.audit. */
function audit(op, actor, target, args) {
  if (typeof S.auditFn !== 'function') return;
  try {
    S.auditFn({
      op,
      ts: nowMs(),
      via: actor?.via || 'ingame',
      actor: {
        uid: actor?.uid || null,
        name: actor?.name || '',
        role: actor?.role || 'player',
        id: actor?.p?.id || actor?.id || '',
      },
      target: target ? { uid: target.uid || null, name: target.name || '' } : null,
      args: args || {},
      ok: true,
    }, op);
  } catch (e) {
    S.logFn('audit hook threw', e);
  }
}

// ---------------------------------------------------------------------------
// retention sweep
// ---------------------------------------------------------------------------

/**
 * Delete journal files older than `keepDays`. Runs at boot, hourly, and when
 * the day rolls. The open day is never touched.
 *
 * There is no gzip tier here and that is deliberate: seven days of chat is a
 * few megabytes at any population this game will see, and a compressed file is
 * one more thing between an operator and an answer at 2am.
 */
export function sweep(opts = {}) {
  const res = { purged: [] };
  const today = utcDay(nowMs());
  const todayMs = dayToMs(today);
  const keepDays = clampInt(opts.keepDays, 1, 3650, S.keepDays);
  for (const f of listFiles()) {
    if (f.day === today || f.file === S.file) continue;
    const ageDays = Math.floor((todayMs - dayToMs(f.day)) / 86_400_000);
    if (!Number.isFinite(ageDays) || ageDays < keepDays) continue;
    try { fs.unlinkSync(f.file); res.purged.push(f.name); S.purged++; } catch (e) { S.logFn(`purge ${f.name}`, e); }
  }
  return res;
}

// ---------------------------------------------------------------------------
// install / stats / close
// ---------------------------------------------------------------------------

/**
 * Boot the chat log.
 *
 * ctx (every field optional):
 *   dataDir          data root; the journal lives in <dataDir>/chatlog
 *                    (default: COVE_DATA_DIR or <cwd>/data)
 *   dir              exact directory, overriding dataDir (tests, drills)
 *   audit(event, op) the audit sink — server/audit.js's log() verbatim
 *   recordFor(p)     live player -> stored record (for uid)
 *   requireCap(a, c) capability gate (defaults to admin.js requireCap)
 *   log(msg, err)    where this module's own failures are reported
 *   now()            clock injection for tests
 *   ringLines        default 30
 *   keepDays         default 7
 *   fsyncMs          default 250 (0 = fsync every line)
 *   sweepIntervalMs  default 1h; 0 disables the timer (sweep() still works)
 *   textMax          default 200 (CHAT_MAX_LEN + headroom)
 *   maxRings         default 600
 *   disk             false: ring only, nothing written (a drill switch)
 *   timers / hooks   false: install no timers / no exit flush (tests)
 *
 * Returns { dir, day, file, rings, purged }.
 */
export function install(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  close();

  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.resolve(process.cwd(), 'data'));
  S.dir = c.dir ? path.resolve(c.dir) : path.join(dataDir, 'chatlog');
  if (typeof c.log === 'function') S.logFn = c.log;
  if (typeof c.now === 'function') S.now = c.now;
  S.auditFn = typeof c.audit === 'function' ? c.audit : (typeof c.audit?.log === 'function' ? (e, op) => c.audit.log(e, op) : null);
  S.recordFor = typeof c.recordFor === 'function' ? c.recordFor : null;
  S.requireCap = typeof c.requireCap === 'function' ? c.requireCap : adminRequireCap;
  S.ringLines = clampInt(c.ringLines, 1, 500, RING_LINES);
  S.keepDays = clampInt(c.keepDays, 1, 3650, KEEP_DAYS);
  S.fsyncMs = clampInt(c.fsyncMs, 0, 60_000, FSYNC_MS);
  S.textMax = clampInt(c.textMax, 16, 4096, TEXT_MAX);
  S.maxRings = clampInt(c.maxRings, 8, 100_000, MAX_RINGS);
  S.disk = c.disk !== false;
  S.rings.clear();
  S.observed = 0; S.written = 0; S.writeFails = 0; S.bytes = 0; S.dropped = 0;
  S.purged = 0; S.reads = 0; S.readsRefused = 0; S.evicted = 0;

  if (S.disk) {
    try { fs.mkdirSync(S.dir, { recursive: true }); } catch (e) { S.logFn(`mkdir ${S.dir}`, e); }
    openDay(utcDay(nowMs()));
  }
  S.installed = true;
  const swept = S.disk ? sweep() : { purged: [] };

  if (c.timers !== false) {
    const every = clampInt(c.sweepIntervalMs, 0, 86_400_000, SWEEP_INTERVAL_MS);
    if (every > 0) {
      S.sweepTimer = setInterval(() => { try { sweep(); } catch (e) { S.logFn('sweep', e); } }, every);
      if (typeof S.sweepTimer?.unref === 'function') S.sweepTimer.unref();
    }
  }
  if (c.hooks !== false && !S.hooked) {
    process.on('exit', () => { try { flush(); } catch {} });
    S.hooked = true;
  }
  if (!S.auditFn) console.warn('[chatlog] no ctx.audit hook: chat-log READS will not be logged');
  console.log(`[chatlog] ready (ring ${S.ringLines}, keep ${S.keepDays}d, ${S.disk ? S.dir : 'memory only'})`);
  return { dir: S.dir, day: S.day, file: S.file, rings: S.rings.size, purged: swept.purged };
}

/** For /api/health and the future panel's server screen. */
export function stats() {
  return {
    installed: S.installed,
    dir: S.dir,
    day: S.day,
    disk: S.disk,
    ringLines: S.ringLines,
    keepDays: S.keepDays,
    rings: S.rings.size,
    lines: [...S.rings.values()].reduce((a, r) => a + r.lines.length, 0),
    observed: S.observed,
    written: S.written,
    writeFails: S.writeFails,
    bytes: S.bytes,
    dropped: S.dropped,
    evicted: S.evicted,
    purged: S.purged,
    reads: S.reads,
    readsRefused: S.readsRefused,
    files: S.disk ? listFiles().length : 0,
  };
}

/** Flush, close the fd, stop the timers, forget every ring. Idempotent. */
export function close() {
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
  flush();
  closeFd();
  S.rings.clear();
  S.installed = false;
  S.day = '';
  S.file = '';
  return true;
}

/** A fresh, unguessable id. Shared with reports.js through export, not copy. */
export function newId(prefix = 'c') {
  return `${prefix}_${nowMs().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

export default {
  install, observe, record, whisper, drop, linesFor, readBack, read,
  sweep, flush, stats, listFiles, close, keyFor, utcDay, newId,
  RING_LINES, KEEP_DAYS, KINDS, CAPTURED, READ_CAP, READ_OP,
};
