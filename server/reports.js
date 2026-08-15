/**
 * server/reports.js — the report store and the moderation queue (wave 10B,
 * N-10, spec docs/research/accounts-admin.md §4.3).
 *
 * THE POINT, in one sentence: the game currently has exactly one report path —
 * `reportMural` in index.js, which writes a bespoke JSON blob into
 * `data/mural-reports/` that nothing on earth reads (AUDIT F-21) — and this
 * file replaces it with an inbox that has states, context and an audit trail.
 *
 * Contract with index.js — the same install(ctx) shape as progress.js:6-11,
 * admin.js, audit.js and chatlog.js:
 *   - install(ctx)        once at boot, AFTER audit.install and chatlog.install.
 *   - handleMessage(p, m) first refusal on the frames below; returns true to
 *     consume. Insert it AFTER admin.handleMessage (a banned player's frames
 *     die there; a muted player may still report, which is deliberate — being
 *     silenced must never stop you asking for help) and before the main switch.
 *   - mural(p, snapshot)  the drop-in replacement for reportMural().
 *
 * ---------------------------------------------------------------------------
 * FRAMES (register in the CLAUDE.md protocol registry when the wave ships)
 *
 *   client -> server
 *     {t:'report', kind, id?|uid?|name?, reason, note?, evidence?}
 *         file a report. `kind` is one of KINDS below. The target is a live
 *         connection id, an account uid, or a name, resolved in that order.
 *     {t:'r-queue', state?, kind?, limit?, cursor?}          mod: the inbox
 *     {t:'r-view', id}                                       mod: one report
 *     {t:'r-state', id, state, note?}                        mod: move it along
 *     {t:'r-chatlog', who?|uid?|name?|id?, kind?, room?, q?, day?, limit?,
 *      cursor?}                                              mod: the 10B log
 *   server -> client
 *     {t:'report', ok, id?, msg, wait?}                      the reporter's ack
 *     {t:'r-queue', reports[], counts, cursor, done}
 *     {t:'r-view', report}
 *     {t:'r-state', ok, id, state, msg}
 *     {t:'r-chatlog', ok, lines[], cursor, done, msg?}
 *
 * All five mod frames are capability-gated and every state change is audited.
 * An unprivileged player who sends one gets SILENCE, matching admin.js's rule
 * for probes: a probe deserves nothing back and one log line.
 *
 * ---------------------------------------------------------------------------
 * THE STORE: append-only JSONL, folded on read
 *
 * `data/reports/YYYY-MM-DD.jsonl`, one line per WRITE, not per report. A state
 * change appends a new line carrying the same `id` and a higher `rev`; the
 * current state of a report is its highest-rev line. That choice buys three
 * things a rewrite-in-place store cannot have:
 *
 *   - an append-only file cannot lose the other 200 reports because the process
 *     died mid-write on this one;
 *   - the queue keeps its own history for free (who reviewed it, when, why),
 *     which is exactly what you want the first time a moderation call is
 *     questioned;
 *   - it is the same shape, the same rotation and the same reasoning as the
 *     audit log next door, so there is one storage idea in the server, not two.
 *
 * The fold happens at boot over the last `INDEX_DAYS` days into a Map, so the
 * queue view is memory-speed and the disk is only touched to append or to look
 * further back than a fortnight.
 *
 * RETENTION. Reports are kept `KEEP_DAYS` (90) days — the same window as the
 * audit log, because a report and the action taken on it are one story and
 * splitting their retention makes both halves useless. The 7-day CHAT lines
 * frozen onto a report as evidence are a deliberate exception, called out in
 * the privacy page (10E): once a line is evidence in an open case it stops
 * being ambient chat, and dropping it on day 8 would gut the queue.
 *
 * ---------------------------------------------------------------------------
 * QUEUE STATES
 *
 *   open -> reviewed -> actioned | dismissed
 *
 *   open       nobody has looked
 *   reviewed   a mod has read it and is working it (the "claimed" state; it is
 *              what stops two mods acting on the same raid at once)
 *   actioned   something was done. The mute/kick/ban itself is an admin.js op
 *              with its own audit line; this only records that the queue entry
 *              led somewhere.
 *   dismissed  nothing to do. Dismissal is a real answer and needs a note.
 *
 * Reopening a resolved report needs the `unban` capability, on admin.js's own
 * principle that reversing a call is a supervisor act.
 *
 * ---------------------------------------------------------------------------
 * EVIDENCE IS SERVER-COLLECTED, NOT CLIENT-SUPPLIED
 *
 * A report's chat context is frozen from `chatlog.linesFor(target)` at filing
 * time, on the server, from lines the server itself accepted. The client never
 * gets to say what was said — otherwise the first thing a bad actor does is
 * report an innocent player with fabricated quotes, and the queue becomes a
 * weapon. The ONE thing a client may attach is the doodle canvas snapshot
 * (10D), because the server does not keep the strokes; it is validated as a
 * PNG, size-capped, written to a blob file, and NEVER echoed to anybody but a
 * capability-holding operator.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { linesReverse } from './audit.js';
import { requireCap as adminRequireCap, actorFrom as adminActorFrom } from './admin.js';
import * as chatlog from './chatlog.js';

// ---------------------------------------------------------------------------
// constants (all overridable through install(ctx))
// ---------------------------------------------------------------------------

/** What a report can be about. `mural` and `doodle` carry image evidence. */
export const KINDS = Object.freeze(['chat', 'whisper', 'name', 'mural', 'doodle', 'den', 'other']);
const KIND_SET = new Set(KINDS);

/** The queue states, in order. Index in this array is the progression. */
export const STATES = Object.freeze(['open', 'reviewed', 'actioned', 'dismissed']);
const STATE_SET = new Set(STATES);
/** Terminal states: reopening one is a supervisor act (REOPEN_CAP). */
const TERMINAL = new Set(['actioned', 'dismissed']);

/**
 * The reason vocabulary the client offers. Free text goes in `note`; the reason
 * is a closed list so the queue can be counted, sorted and (later) charted.
 * An unknown reason is not refused — it is stored as 'other' with the original
 * kept in the note, because a report is evidence and evidence is never dropped.
 */
export const REASONS = Object.freeze([
  'language',     // slurs, harassment, sexual content — the die-on-sight list
  'bullying',
  'spam',
  'cheating',
  'inappropriate', // drawings, murals, den layouts
  'name',
  'other',
]);
const REASON_SET = new Set(REASONS);

/**
 * Vocabulary the two client surfaces already ship, folded onto the canonical
 * list. 10C's player card speaks this list exactly; 10D's doodle overlay offers
 * its own four (`hate`, `sexual`, `harassment`, `other`), which are the right
 * words in front of a drawing and the wrong keys for a queue filter.
 *
 * Folding beats refusing and beats widening: an alias keeps the queue
 * countable, keeps the client free to word its buttons for the surface it is
 * on, and — because `file()` also preserves the original in the note — loses
 * nothing an operator might want to read.
 */
const REASON_ALIAS = Object.freeze({
  hate: 'language', slur: 'language', slurs: 'language', hateful: 'language',
  harassment: 'bullying', harass: 'bullying', targeting: 'bullying', bully: 'bullying',
  sexual: 'inappropriate', nsfw: 'inappropriate', drawing: 'inappropriate',
  gross: 'inappropriate', rude: 'inappropriate',
  ad: 'spam', ads: 'spam', advertising: 'spam', flood: 'spam',
  cheat: 'cheating', exploit: 'cheating', hacking: 'cheating',
  username: 'name',
});

/** Reports are kept as long as the audit lines that answer them. */
export const KEEP_DAYS = 90;
/** Days folded into memory at boot. Older reports are read from disk on ask. */
export const INDEX_DAYS = 14;
/** Reports held in the in-memory index. Oldest resolved entries fall out first. */
export const INDEX_MAX = 4_000;
/** Batched fsync window, matching the audit log. */
export const FSYNC_MS = 250;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** One report per reporter per this gap, and no more than BURST per window. */
export const REPORT_COOLDOWN_MS = 20_000;
export const REPORT_BURST = 6;
export const REPORT_WINDOW_MS = 10 * 60 * 1000;
/** The same reporter naming the same target twice inside this window is one. */
export const DEDUPE_MS = 10 * 60 * 1000;
/** Chat lines frozen onto a report as context. §4.3 asks for the last 20. */
export const CONTEXT_LINES = 20;
/** Free-text note, from a player or from a mod. */
export const NOTE_MAX = 300;
/** A canvas snapshot above this is refused outright. 10D should send ~40 KB. */
export const PNG_MAX_BYTES = 256 * 1024;
/** Evidence stored inline in the JSONL rather than as a blob file. */
export const INLINE_MAX_BYTES = 8 * 1024;

/** Reading the queue needs this cap; acting on it needs the other. */
export const READ_CAP = 'inspect';
export const ACT_CAP = 'mute';
export const REOPEN_CAP = 'unban';

/** Audit op names. Not in audit.js OPS (that table is 9D's); logged all the same. */
export const OPS = Object.freeze({
  FILE: 'report.file',
  STATE: 'report.state',
  READ: 'report.read',
});

const FILE_RE = /^reports-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const S = {
  installed: false,
  dir: '',
  blobDir: '',
  day: '',
  file: '',
  fd: null,
  dirty: false,
  keepDays: KEEP_DAYS,
  indexDays: INDEX_DAYS,
  indexMax: INDEX_MAX,
  fsyncMs: FSYNC_MS,
  cooldownMs: REPORT_COOLDOWN_MS,
  burst: REPORT_BURST,
  windowMs: REPORT_WINDOW_MS,
  contextLines: CONTEXT_LINES,
  now: Date.now,
  logFn: (msg, err) => console.error(err ? `[reports] ${msg}: ${err?.message || err}` : `[reports] ${msg}`),
  auditFn: null,
  sendTo: null,
  recordFor: null,
  findEntity: null,
  requireCap: adminRequireCap,
  actorFrom: adminActorFrom,
  chat: chatlog,
  fsyncTimer: null,
  sweepTimer: null,
  hooked: false,
  /** id -> the folded, current-state report */
  index: new Map(),
  /** reporter key -> { hits:[ms], last, recent: Map(dedupeKey -> {id, at}) } */
  budgets: new Map(),
  // counters
  filed: 0, deduped: 0, refused: 0, states: 0, writeFails: 0, purged: 0,
  blobs: 0, blobBytes: 0, reads: 0, readsRefused: 0, errors: 0,
};

const nowMs = () => {
  const t = Number(S.now());
  return Number.isFinite(t) ? t : Date.now();
};

export function utcDay(ts = nowMs()) {
  const d = new Date(Number(ts) || 0);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '1970-01-01';
}

const dayToMs = (day) => Date.parse(`${day}T00:00:00Z`);

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const clean = (v, max) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

function newReportId(at = nowMs()) {
  return `r_${at.toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// file plumbing (its own directory and fd; shares only the pure line reader)
// ---------------------------------------------------------------------------

function fileFor(dir, day) { return path.join(dir, `reports-${day}.jsonl`); }

/** Every report file on disk, newest day first. */
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

/** fsync the open day now. Never throws. */
export function flush() {
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.fd === null || !S.dirty) return true;
  try { fs.fsyncSync(S.fd); S.dirty = false; return true; } catch (e) {
    S.logFn('fsync failed', e);
    return false;
  }
}

/** Append one revision line. Returns true if it reached the disk. */
function append(rec) {
  const day = utcDay(rec.at);
  if (day !== S.day || S.fd === null) { if (!openDay(day)) return false; }
  try {
    writeAll(S.fd, Buffer.from(`${JSON.stringify(rec)}\n`, 'utf8'));
    S.dirty = true;
    scheduleFsync();
    return true;
  } catch (e) {
    S.writeFails++;
    S.logFn('append failed', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// the in-memory fold
// ---------------------------------------------------------------------------

/** Newer revision wins; equal revs keep the newer timestamp. */
function foldIn(rec) {
  if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') return;
  const cur = S.index.get(rec.id);
  if (cur && ((cur.rev | 0) > (rec.rev | 0) || ((cur.rev | 0) === (rec.rev | 0) && cur.at >= rec.at))) return;
  S.index.set(rec.id, rec);
}

/**
 * Keep the index bounded WITHOUT losing the inbox: resolved reports are dropped
 * first, oldest first, and `open` entries are only touched when there is
 * nothing else left. An operator's unread queue is the last thing to evict.
 */
function trimIndex() {
  if (S.index.size <= S.indexMax) return;
  const all = [...S.index.values()];
  const resolved = all.filter((r) => TERMINAL.has(r.state)).sort((a, b) => a.at - b.at);
  let over = S.index.size - S.indexMax;
  for (const r of resolved) { if (over <= 0) break; S.index.delete(r.id); over--; }
  if (over <= 0) return;
  const rest = all.filter((r) => !TERMINAL.has(r.state)).sort((a, b) => a.at - b.at);
  for (const r of rest) { if (over <= 0) break; S.index.delete(r.id); over--; }
}

/** Read the last `indexDays` days off disk and fold them into the index. */
function loadIndex() {
  S.index.clear();
  const files = listFiles().slice(0, Math.max(1, S.indexDays));
  // Oldest file first so higher revisions naturally land last.
  for (const f of files.slice().reverse()) {
    let text = '';
    try { text = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try { foldIn(JSON.parse(raw)); } catch { /* a torn line is not evidence */ }
    }
  }
  trimIndex();
  return S.index.size;
}

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

/**
 * Decode and validate a client-supplied PNG. This is the ONLY byte sequence in
 * the whole module that a player controls, so it is checked hard: base64 only,
 * PNG magic required, size-capped, written under a server-chosen name, and
 * never served anywhere except to a capability-holding operator.
 */
function storePng(id, dataUrl) {
  try {
    const s = String(dataUrl || '');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
    if (!m) return { ok: false, why: 'not a png data url' };
    const b64 = m[1].replace(/\s+/g, '');
    if (b64.length > Math.ceil(PNG_MAX_BYTES / 3) * 4 + 8) return { ok: false, why: 'too large' };
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 24 || buf.length > PNG_MAX_BYTES) return { ok: false, why: 'too large' };
    if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, why: 'not a png' };
    fs.mkdirSync(S.blobDir, { recursive: true });
    const name = `${id}.png`;
    const full = path.join(S.blobDir, name);
    const tmp = `${full}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { writeAll(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, full);
    S.blobs++;
    S.blobBytes += buf.length;
    return { ok: true, png: path.posix.join('blobs', name), bytes: buf.length };
  } catch (e) {
    S.logFn('png store failed', e);
    return { ok: false, why: 'could not store' };
  }
}

/** A big text payload (a mural RLE) goes to a blob rather than bloating a line. */
function storeText(id, suffix, text) {
  try {
    fs.mkdirSync(S.blobDir, { recursive: true });
    const name = `${id}.${suffix}`;
    const full = path.join(S.blobDir, name);
    const tmp = `${full}.tmp`;
    const buf = Buffer.from(String(text), 'utf8');
    const fd = fs.openSync(tmp, 'w');
    try { writeAll(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, full);
    S.blobs++;
    S.blobBytes += buf.length;
    return { ok: true, ref: path.posix.join('blobs', name), bytes: buf.length };
  } catch (e) {
    S.logFn('blob store failed', e);
    return { ok: false };
  }
}

/**
 * Build the evidence object for one report. Everything here is server-side
 * except the doodle PNG and the mural snapshot, and the mural snapshot comes
 * from index.js, not from a client frame.
 */
function buildEvidence(id, kind, target, supplied) {
  const ev = {};
  const src = supplied && typeof supplied === 'object' ? supplied : {};

  // 1. chat context: frozen from the server's own ring, never from the client.
  if (target && (kind === 'chat' || kind === 'whisper' || kind === 'name' || kind === 'other' || kind === 'den')) {
    const lines = S.chat?.linesFor ? S.chat.linesFor(target, { limit: S.contextLines }) : [];
    if (lines.length) ev.lines = lines;
  }

  // 2. the doodle canvas (10D). The one client-controlled byte sequence.
  if (kind === 'doodle' && typeof src.png === 'string') {
    const res = storePng(id, src.png);
    if (res.ok) { ev.png = res.png; ev.pngBytes = res.bytes; }
    else ev.pngError = res.why;
    if (typeof src.word === 'string') ev.claimedWord = clean(src.word, 40);
    if (typeof src.round === 'number') ev.round = clampInt(src.round, 0, 9999, 0);
  }

  // 3. the mural snapshot (index.js's reportMural, absorbed).
  if (kind === 'mural') {
    if (typeof src.rle === 'string' && src.rle) {
      if (Buffer.byteLength(src.rle) > INLINE_MAX_BYTES) {
        const res = storeText(id, 'mural.txt', src.rle);
        if (res.ok) ev.rleRef = res.ref;
      } else ev.rle = src.rle;
      ev.w = clampInt(src.w, 1, 4096, 0);
      ev.h = clampInt(src.h, 1, 4096, 0);
    }
    if (Array.isArray(src.recent) && src.recent.length) {
      // The painters are the point: who put what where, in the last N ops.
      ev.ops = src.recent.slice(-400).map((o) => ({
        x: clampInt(o?.x, 0, 4095, 0),
        y: clampInt(o?.y, 0, 4095, 0),
        c: clampInt(o?.c, 0, 255, 0),
        by: clean(o?.by, 32),
        byUid: clean(o?.byUid, 64),
        at: clampInt(o?.at, 0, 4102444800000, 0),
      }));
    }
  }
  return ev;
}

// ---------------------------------------------------------------------------
// identity helpers
// ---------------------------------------------------------------------------

/** The reporter, as a durable-as-possible descriptor. */
function reporterOf(p) {
  const rec = p?.registered && typeof S.recordFor === 'function' ? S.recordFor(p) : null;
  return {
    uid: rec?.uid || '',
    name: String(p?.name || rec?.username || '').slice(0, 64),
    id: String(p?.id || '').slice(0, 32),
    room: String(p?.room || '').slice(0, 32),
    guest: !rec,
  };
}

/**
 * Resolve the reported party from `{uid} | {name} | {id}`, in that order —
 * exactly admin.js's precedence, so the same frame body means the same player
 * in a report as it does in an `a-ban`.
 */
function targetOf(m) {
  const out = { uid: '', name: '', id: '', room: '', guest: false, found: false };
  if (!m || typeof m !== 'object') return out;
  const wantUid = typeof m.uid === 'string' ? m.uid.slice(0, 64) : '';
  const wantName = typeof m.name === 'string' ? clean(m.name, 64) : '';
  const wantId = typeof m.id === 'string' ? m.id.slice(0, 32) : '';

  let entity = null;
  if (wantId && typeof S.findEntity === 'function') entity = S.findEntity(wantId);
  if (entity?.bot) return out; // a citizen is not a person and cannot be reported
  const rec = entity && entity.registered && typeof S.recordFor === 'function' ? S.recordFor(entity) : null;

  out.uid = wantUid || rec?.uid || '';
  out.name = rec?.username || entity?.name || wantName;
  out.id = entity?.id || wantId;
  out.room = entity?.room || '';
  out.guest = !!entity && !rec;
  out.found = !!(out.uid || out.name || out.id);
  return out;
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

function budgetKey(rep) { return rep.uid ? `u:${rep.uid}` : `g:${rep.id}`; }

/**
 * Two limits and a de-duplicator. The de-duplicator matters more than either
 * limit: eight people reporting the same raider in the same minute is the queue
 * working exactly as intended, but ONE person filing the same report eight
 * times is noise that buries everyone else's.
 */
function limited(rep, dedupeKey, at) {
  const key = budgetKey(rep);
  let b = S.budgets.get(key);
  if (!b) { b = { hits: [], last: 0, recent: new Map() }; S.budgets.set(key, b); }
  if (S.budgets.size > 2_000) {
    for (const [k, v] of S.budgets) if (at - (v.last || 0) > S.windowMs * 2) S.budgets.delete(k);
  }
  const dupe = b.recent.get(dedupeKey);
  if (dupe && at - dupe.at < DEDUPE_MS) return { dupe: dupe.id };
  if (at - b.last < S.cooldownMs) return { wait: S.cooldownMs - (at - b.last) };
  b.hits = b.hits.filter((t) => at - t < S.windowMs);
  if (b.hits.length >= S.burst) return { wait: S.windowMs - (at - b.hits[0]) };
  return { ok: true, commit: (id) => {
    b.last = at;
    b.hits.push(at);
    b.recent.set(dedupeKey, { id, at });
    if (b.recent.size > 32) { const first = b.recent.keys().next().value; b.recent.delete(first); }
  } };
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

function audit(op, actor, target, args, extra = {}) {
  if (typeof S.auditFn !== 'function') return;
  try {
    const entry = {
      op,
      ts: nowMs(),
      via: actor?.via || 'ingame',
      actor: {
        uid: actor?.uid || null,
        name: actor?.name || '',
        role: actor?.role || 'player',
        id: actor?.p?.id || actor?.id || '',
      },
      target: target ? { uid: target.uid || null, name: target.name || '', id: target.id || '' } : null,
      args: args || {},
      ok: extra.ok !== false,
    };
    if (extra.before) entry.before = extra.before;
    if (extra.after) entry.after = extra.after;
    S.auditFn(entry, op);
  } catch (e) {
    S.logFn('audit hook threw', e);
  }
}

// ---------------------------------------------------------------------------
// filing
// ---------------------------------------------------------------------------

/**
 * File one report. THE road in: the ws frame, the mural helper and any future
 * surface all end up here, so validation, rate limiting, evidence capture,
 * persistence and audit happen once and identically.
 *
 *   file({ by, kind, target, reason, note, evidence, room, at })
 *     by        the live player object doing the reporting (or a descriptor)
 *     target    a frame body {uid|name|id}, or a resolved descriptor
 *     evidence  raw material (doodle png, mural snapshot) — see buildEvidence
 *
 *   -> { ok:true, id, state } | { ok:true, id, duplicate:true }
 *      | { ok:false, msg, code, wait? }
 *
 * NEVER THROWS.
 */
export function file(input = {}) {
  try {
    if (!S.installed) install({});
    const i = input && typeof input === 'object' ? input : {};
    const at = clampInt(i.at, 0, 4102444800000, nowMs());
    const rep = i.by && i.by.uid !== undefined && i.by.name !== undefined && !i.by.ws
      ? { uid: i.by.uid || '', name: String(i.by.name || ''), id: String(i.by.id || ''), room: String(i.by.room || ''), guest: !i.by.uid }
      : reporterOf(i.by);
    if (!rep.uid && !rep.id) return { ok: false, msg: 'Who is reporting?', code: 'noreporter' };

    const kind = KIND_SET.has(i.kind) ? i.kind : 'other';
    const tgt = i.target && (i.target.found !== undefined) ? i.target : targetOf(i.target || i);
    // A mural or doodle report is about a drawing, not necessarily a person: the
    // target may legitimately be empty and the evidence carries the case.
    const needsTarget = kind !== 'mural' && kind !== 'doodle';
    if (needsTarget && !tgt.found) return { ok: false, msg: 'No such player', code: 'notarget' };
    if (tgt.uid && rep.uid && tgt.uid === rep.uid) return { ok: false, msg: 'You cannot report yourself', code: 'self' };
    if (!tgt.uid && tgt.id && rep.id && tgt.id === rep.id) return { ok: false, msg: 'You cannot report yourself', code: 'self' };

    const rawReason = clean(i.reason, 32).toLowerCase();
    const aliased = own(REASON_ALIAS, rawReason) ? REASON_ALIAS[rawReason] : rawReason;
    const reason = REASON_SET.has(aliased) ? aliased : 'other';
    let note = clean(i.note, NOTE_MAX);
    // The player's own word is kept even when it folds onto another key: a
    // report saying "sexual" and a report saying "gross" are both filed as
    // `inappropriate`, and the operator should still see which one was clicked.
    if (rawReason && rawReason !== reason) note = clean(`[${rawReason}] ${note}`, NOTE_MAX);

    const dedupeKey = `${kind}:${tgt.uid || tgt.id || tgt.name || '-'}`;
    const gate = limited(rep, dedupeKey, at);
    if (gate.dupe) {
      S.deduped++;
      return { ok: true, id: gate.dupe, duplicate: true, msg: 'Thanks: that one is already with the caretakers' };
    }
    if (!gate.ok) {
      S.refused++;
      return { ok: false, code: 'slow', wait: Math.ceil((gate.wait || 0) / 1000), msg: 'You have reported a lot just now: give the caretakers a moment' };
    }

    const id = newReportId(at);
    const rec = {
      id,
      rev: 1,
      at,
      kind,
      reason,
      note,
      byUid: rep.uid || '',
      byName: rep.name || '',
      byId: rep.id || '',
      byGuest: !rep.uid,
      targetUid: tgt.uid || '',
      targetName: tgt.name || '',
      targetId: tgt.id || '',
      targetGuest: !!tgt.guest,
      room: clean(i.room || tgt.room || rep.room, 32),
      evidence: buildEvidence(id, kind, tgt.uid ? { uid: tgt.uid } : (tgt.id ? { id: tgt.id } : { name: tgt.name }), i.evidence),
      state: 'open',
      actorUid: null,
      actorName: '',
      resolvedAt: null,
      resolution: null,
      history: [{ at, state: 'open', by: rep.name || '', note: '' }],
    };

    append(rec);
    foldIn(rec);
    trimIndex();
    gate.commit(id);
    S.filed++;

    // The audit line records that a report EXISTS and who it names. The words
    // themselves stay in the report file and the chat log: 9D's redactor would
    // strip them anyway, and a 90-day admin log is the wrong home for chat.
    audit(OPS.FILE, { uid: rep.uid || null, name: rep.name, id: rep.id, via: 'ingame' },
      { uid: tgt.uid, name: tgt.name, id: tgt.id },
      { report: id, kind, reason, room: rec.room, guestReporter: rec.byGuest, evidence: Object.keys(rec.evidence) });

    return { ok: true, id, state: 'open', msg: 'Thanks: a caretaker will take a look' };
  } catch (e) {
    S.errors++;
    S.logFn('file() failed', e);
    return { ok: false, msg: 'That did not go through', code: 'error' };
  }
}

/**
 * The drop-in replacement for index.js's `reportMural(p, now)` (:2052-2072).
 * The orchestrator's whole edit is:
 *
 *   case 'mural-report':
 *     if (socialLimited(p, t0)) break;
 *     reports.mural(p, { w: MURAL_W, h: MURAL_H, rle: muralRLE(),
 *                        recent: mural.ops.slice(-400) }, t0);
 *     break;
 *
 * and `MURAL_REPORT_DIR`, `mural.reports`, the bespoke writer and its pruning
 * line in the clock tick all go away — this module owns the cooldown now. The
 * old `data/mural-reports/` directory is left alone: it is evidence from before
 * the queue existed and deleting other people's evidence is not this file's
 * business.
 *
 * Sends the reporter their own ack, so the call site stays one line.
 */
export function mural(p, snapshot = {}, at = nowMs()) {
  const res = file({
    by: p,
    kind: 'mural',
    at,
    reason: snapshot.reason || 'inappropriate',
    note: snapshot.note || '',
    room: p?.room || '',
    evidence: { rle: snapshot.rle, w: snapshot.w, h: snapshot.h, recent: snapshot.recent },
  });
  if (typeof S.sendTo === 'function' && p) {
    if (res.ok) S.sendTo(p, { t: 'toast', msg: res.msg || 'Thanks: a caretaker will take a look' });
    else if (res.code === 'slow') S.sendTo(p, { t: 'toast', msg: res.msg });
  }
  return res;
}

// ---------------------------------------------------------------------------
// the queue
// ---------------------------------------------------------------------------

/** A report as an operator sees it in the LIST: no evidence payload, no PII. */
function summarize(r) {
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    reason: r.reason,
    note: r.note,
    state: r.state,
    room: r.room,
    by: r.byName,
    byUid: r.byUid,
    target: r.targetName,
    targetUid: r.targetUid,
    targetId: r.targetId,
    lines: Array.isArray(r.evidence?.lines) ? r.evidence.lines.length : 0,
    hasImage: !!(r.evidence?.png || r.evidence?.rle || r.evidence?.rleRef),
    actor: r.actorName || '',
    resolvedAt: r.resolvedAt || null,
    resolution: r.resolution || null,
    rev: r.rev | 0,
  };
}

/**
 * The inbox. Newest first, `open` first when no state is named — an operator
 * opening the queue wants the unanswered ones, not the archive.
 *
 *   queue({ state, kind, targetUid, byUid, room, since, until, limit, offset })
 *   -> { reports:[summary], counts:{open,reviewed,actioned,dismissed,total},
 *        total, offset, done }
 */
export function queue(filter = {}) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const limit = clampInt(f.limit, 1, 200, 40);
  const offset = clampInt(f.offset, 0, 100_000, 0);
  const counts = { open: 0, reviewed: 0, actioned: 0, dismissed: 0, total: 0 };
  const hits = [];
  for (const r of S.index.values()) {
    counts.total++;
    if (own(counts, r.state)) counts[r.state]++;
    if (f.state && r.state !== f.state) continue;
    if (f.kind && r.kind !== f.kind) continue;
    if (f.reason && r.reason !== f.reason) continue;
    if (f.room && r.room !== f.room) continue;
    if (f.targetUid && r.targetUid !== f.targetUid) continue;
    if (f.byUid && r.byUid !== f.byUid) continue;
    if (f.since != null && r.at < Number(f.since)) continue;
    if (f.until != null && r.at > Number(f.until)) continue;
    if (f.q) {
      const q = String(f.q).toLowerCase();
      const hay = `${r.targetName} ${r.byName} ${r.note} ${r.reason} ${r.kind}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    hits.push(r);
  }
  const rank = (r) => (r.state === 'open' ? 0 : r.state === 'reviewed' ? 1 : 2);
  hits.sort((a, b) => (f.state ? 0 : rank(a) - rank(b)) || b.at - a.at);
  const page = hits.slice(offset, offset + limit);
  return {
    reports: page.map(summarize),
    counts,
    total: hits.length,
    offset,
    done: offset + page.length >= hits.length,
  };
}

/** One report, whole, including evidence. In-memory index first, then disk. */
export function get(id) {
  const key = String(id || '');
  if (!key) return null;
  const hit = S.index.get(key);
  if (hit) return hit;
  // Older than the fold window: walk the files backwards for its newest rev.
  for (const f of listFiles()) {
    let best = null;
    for (const raw of linesReverse(f.file)) {
      let rec = null;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec?.id !== key) continue;
      // Backwards through an append-only file, the FIRST match is the newest.
      best = rec;
      break;
    }
    if (best) return best;
  }
  return null;
}

/**
 * Move a report along the queue. Capability-gated and audited: this is the
 * record of a human decision, and a decision nobody can attribute three weeks
 * later is indistinguishable from nothing having happened.
 *
 *   setState(actor, id, state, { note, resolution })
 *   -> { ok:true, id, state } | { ok:false, msg, code }
 */
export function setState(actor, id, state, opts = {}) {
  try {
    const a = actor && actor.role !== undefined ? actor : (typeof S.actorFrom === 'function' ? S.actorFrom(actor, opts.via || 'ingame') : null);
    if (!a) return { ok: false, msg: 'Unknown actor', code: 'noactor' };
    if (!S.requireCap(a, ACT_CAP)) {
      S.readsRefused++;
      return { ok: false, msg: 'You do not have permission to work the report queue', code: 'cap' };
    }
    const want = String(state || '').toLowerCase();
    if (!STATE_SET.has(want)) return { ok: false, msg: `State must be one of ${STATES.join(', ')}`, code: 'args' };
    const cur = get(id);
    if (!cur) return { ok: false, msg: 'No such report', code: 'notfound' };
    if (cur.state === want) return { ok: false, msg: `That report is already ${want}`, code: 'noop' };
    if (TERMINAL.has(cur.state) && !TERMINAL.has(want) && !S.requireCap(a, REOPEN_CAP)) {
      return { ok: false, msg: 'Reopening a closed report is an admin call', code: 'cap' };
    }
    const note = clean(opts.note, NOTE_MAX);
    // A dismissal with no explanation is how a queue quietly becomes a bin.
    if (want === 'dismissed' && !note) return { ok: false, msg: 'Say why it was dismissed (a few words is plenty)', code: 'reason' };

    const at = nowMs();
    const next = {
      ...cur,
      rev: (cur.rev | 0) + 1,
      // The report's own timestamp never moves. That also decides WHICH FILE
      // the revision is appended to (append() picks the file from `at`), so
      // every revision of a report lives in the day file the report was filed
      // in: the whole story is folded together, read together by get(), and
      // eventually purged together. A revision dated "today" would strand a
      // report's history across two files and outlive its own evidence.
      at: cur.at,
      state: want,
      actorUid: a.uid || null,
      actorName: a.name || '',
      resolvedAt: TERMINAL.has(want) ? at : null,
      resolution: TERMINAL.has(want) ? (note || cur.resolution || '') : null,
      history: [...(Array.isArray(cur.history) ? cur.history : []).slice(-19), { at, state: want, by: a.name || '', note }],
    };
    append(next);
    foldIn(next);
    S.states++;

    audit(OPS.STATE, a, { uid: cur.targetUid, name: cur.targetName, id: cur.targetId },
      { report: cur.id, kind: cur.kind, reason: cur.reason, note },
      { before: { state: cur.state }, after: { state: want } });

    return { ok: true, id: cur.id, state: want, msg: `Report ${want}` };
  } catch (e) {
    S.errors++;
    S.logFn('setState failed', e);
    return { ok: false, msg: 'That did not work', code: 'error' };
  }
}

/** Capability-gated read of one report, audited as an operator read. */
export function view(actor, id) {
  const a = actor && actor.role !== undefined ? actor : (typeof S.actorFrom === 'function' ? S.actorFrom(actor, 'ingame') : null);
  if (!a || !S.requireCap(a, READ_CAP)) {
    S.readsRefused++;
    return { ok: false, msg: 'You do not have permission to read reports', code: 'cap' };
  }
  const r = get(id);
  if (!r) return { ok: false, msg: 'No such report', code: 'notfound' };
  S.reads++;
  // Opening a report shows the reported player's chat: that is a chat-log read
  // by any other name, so it is logged as one.
  audit(OPS.READ, a, { uid: r.targetUid, name: r.targetName, id: r.targetId },
    { report: r.id, kind: r.kind, state: r.state, lines: Array.isArray(r.evidence?.lines) ? r.evidence.lines.length : 0 });
  return { ok: true, report: r };
}

// ---------------------------------------------------------------------------
// the ws frames
// ---------------------------------------------------------------------------

/**
 * First refusal on `report` and the four `r-*` operator frames. Returns true to
 * consume. Everything else falls through untouched.
 *
 * Insert AFTER admin.handleMessage and BEFORE progress.handleMessage:
 *   if (p && reports.handleMessage(p, m)) return;
 */
export function handleMessage(p, m) {
  if (!S.installed || !p || !m || typeof m.t !== 'string') return false;
  const t = m.t;
  if (t !== 'report' && (t.length < 3 || t[0] !== 'r' || t[1] !== '-')) return false;
  if (t !== 'report' && !['r-queue', 'r-view', 'r-state', 'r-chatlog'].includes(t)) return false;

  try {
    // ---- a player filing a report ----------------------------------------
    if (t === 'report') {
      // The doodle overlay (10D) sends its canvas as a FLAT `png` beside a
      // `round`, because that is the frame it already shipped; the player card
      // (10C) sends no evidence at all. Accept both shapes rather than making
      // either client re-spell a frame that works — the validation underneath
      // is identical either way.
      const evidence = m.evidence && typeof m.evidence === 'object'
        ? m.evidence
        : (typeof m.png === 'string' ? { png: m.png, word: m.word, round: m.round } : null);
      const res = file({
        by: p,
        kind: m.kind,
        target: m,
        reason: m.reason,
        note: m.note,
        room: typeof m.room === 'string' ? m.room : p.room,
        evidence,
      });
      // `kind` and `round` ride the ack home: two overlays listen to this one
      // frame name, and each has to be able to tell whose answer it is.
      S.sendTo?.(p, {
        t: 'report',
        ok: !!res.ok,
        id: res.id || '',
        kind: KIND_SET.has(m.kind) ? m.kind : 'other',
        ...(m.round !== undefined ? { round: m.round } : {}),
        msg: res.msg || (res.ok ? 'Thanks: a caretaker will take a look' : 'That did not go through'),
        ...(res.wait ? { wait: res.wait } : {}),
        ...(res.duplicate ? { duplicate: true } : {}),
        ...(res.code ? { code: res.code } : {}),
      });
      return true;
    }

    // ---- the operator frames ---------------------------------------------
    const actor = typeof S.actorFrom === 'function' ? S.actorFrom(p, 'ingame') : null;
    // admin.js's rule, deliberately copied: a player with no capabilities at
    // all who pokes at a mod frame is probing, and a probe gets silence plus
    // one log line. Staff missing ONE cap get a real error, because that is a
    // UI bug rather than an attack.
    if (!actor || !S.requireCap(actor, READ_CAP)) {
      S.readsRefused++;
      audit('report.probe', actor || { name: p.name, id: p.id }, null, { frame: t }, { ok: false });
      return true;
    }

    if (t === 'r-queue') {
      S.reads++;
      const out = queue({
        state: STATE_SET.has(m.state) ? m.state : '',
        kind: KIND_SET.has(m.kind) ? m.kind : '',
        reason: REASON_SET.has(m.reason) ? m.reason : '',
        room: typeof m.room === 'string' ? m.room.slice(0, 32) : '',
        targetUid: typeof m.targetUid === 'string' ? m.targetUid.slice(0, 64) : '',
        byUid: typeof m.byUid === 'string' ? m.byUid.slice(0, 64) : '',
        q: typeof m.q === 'string' ? m.q.slice(0, 40) : '',
        limit: m.limit,
        offset: m.offset,
      });
      S.sendTo?.(p, { t: 'r-queue', ...out });
      return true;
    }

    if (t === 'r-view') {
      const res = view(actor, m.id);
      if (!res.ok) S.sendTo?.(p, { t: 'r-view', ok: false, msg: res.msg, code: res.code });
      else S.sendTo?.(p, { t: 'r-view', ok: true, report: res.report });
      return true;
    }

    if (t === 'r-state') {
      const res = setState(actor, m.id, m.state, { note: m.note });
      S.sendTo?.(p, {
        t: 'r-state', ok: !!res.ok, id: res.id || String(m.id || ''),
        state: res.state || '', msg: res.msg, ...(res.code ? { code: res.code } : {}),
      });
      return true;
    }

    if (t === 'r-chatlog') {
      // Delegated whole to chatlog.read, which does its own capability check
      // and writes its own `mod.chatlog.read` audit line. Two gates, one road.
      const res = S.chat.read(actor, {
        who: typeof m.who === 'string' ? m.who.slice(0, 64) : '',
        uid: typeof m.uid === 'string' ? m.uid.slice(0, 64) : '',
        name: typeof m.name === 'string' ? m.name.slice(0, 64) : '',
        id: typeof m.id === 'string' ? m.id.slice(0, 32) : '',
        room: typeof m.room === 'string' ? m.room.slice(0, 32) : '',
        kind: m.kind,
        q: typeof m.q === 'string' ? m.q.slice(0, 40) : '',
        day: typeof m.day === 'string' ? m.day.slice(0, 10) : '',
        limit: m.limit,
      }, typeof m.cursor === 'string' ? m.cursor : null);
      S.sendTo?.(p, { t: 'r-chatlog', ...res });
      return true;
    }
    return false;
  } catch (e) {
    S.errors++;
    S.logFn(`handleMessage '${t}' failed`, e);
    // Consumed: a throw in the queue must not fall through into the main switch
    // and be interpreted as some other frame.
    return true;
  }
}

// ---------------------------------------------------------------------------
// retention sweep
// ---------------------------------------------------------------------------

/**
 * Delete report files (and their blobs) older than `keepDays`. Runs at boot,
 * hourly, and when the day rolls. The open day is never touched.
 */
export function sweep(opts = {}) {
  const res = { purged: [], blobs: 0 };
  const today = utcDay(nowMs());
  const todayMs = dayToMs(today);
  const keepDays = clampInt(opts.keepDays, 1, 3650, S.keepDays);
  const cutoff = todayMs - keepDays * 86_400_000;
  for (const f of listFiles()) {
    if (f.day === today || f.file === S.file) continue;
    const ageDays = Math.floor((todayMs - dayToMs(f.day)) / 86_400_000);
    if (!Number.isFinite(ageDays) || ageDays < keepDays) continue;
    try { fs.unlinkSync(f.file); res.purged.push(f.name); S.purged++; } catch (e) { S.logFn(`purge ${f.name}`, e); }
  }
  // Blobs are named after their report id, whose timestamp is encoded in the
  // id itself, so they can be aged without reading a single JSONL line.
  try {
    for (const name of fs.readdirSync(S.blobDir)) {
      const m = /^r_([0-9a-z]+)[0-9a-f]{12}\./.exec(name);
      const at = m ? parseInt(m[1], 36) : NaN;
      if (!Number.isFinite(at) || at >= cutoff) continue;
      try { fs.unlinkSync(path.join(S.blobDir, name)); res.blobs++; } catch {}
    }
  } catch { /* no blob dir yet */ }
  return res;
}

// ---------------------------------------------------------------------------
// install / stats / close
// ---------------------------------------------------------------------------

/**
 * Boot the report queue.
 *
 * ctx (every field optional):
 *   dataDir          data root; reports live in <dataDir>/reports
 *                    (default: COVE_DATA_DIR or <cwd>/data)
 *   dir              exact directory, overriding dataDir (tests, drills)
 *   audit(event, op) the audit sink — server/audit.js's log() verbatim
 *   sendTo(p, msg)   the server's socket writer
 *   recordFor(p)     live player -> stored record (for uid)
 *   findEntity(id)   connection id -> live player (target resolution)
 *   requireCap(a, c) capability gate (defaults to admin.js requireCap)
 *   actorFrom(x,via) actor normaliser (defaults to admin.js actorFrom)
 *   chatlog          the chat module (defaults to ./chatlog.js)
 *   log(msg, err)    where this module's own failures are reported
 *   now()            clock injection for tests
 *   keepDays / indexDays / indexMax / fsyncMs / sweepIntervalMs
 *   cooldownMs / burst / windowMs / contextLines
 *   timers / hooks   false: no timers / no exit flush (tests)
 *
 * Returns { dir, day, indexed, purged }.
 */
export function install(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  close();

  const dataDir = c.dataDir
    ? path.resolve(c.dataDir)
    : (process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.resolve(process.cwd(), 'data'));
  S.dir = c.dir ? path.resolve(c.dir) : path.join(dataDir, 'reports');
  S.blobDir = path.join(S.dir, 'blobs');
  if (typeof c.log === 'function') S.logFn = c.log;
  if (typeof c.now === 'function') S.now = c.now;
  S.auditFn = typeof c.audit === 'function' ? c.audit : (typeof c.audit?.log === 'function' ? (e, op) => c.audit.log(e, op) : null);
  S.sendTo = typeof c.sendTo === 'function' ? c.sendTo : null;
  S.recordFor = typeof c.recordFor === 'function' ? c.recordFor : null;
  S.findEntity = typeof c.findEntity === 'function' ? c.findEntity : null;
  S.requireCap = typeof c.requireCap === 'function' ? c.requireCap : adminRequireCap;
  S.actorFrom = typeof c.actorFrom === 'function' ? c.actorFrom : adminActorFrom;
  S.chat = c.chatlog && typeof c.chatlog.linesFor === 'function' ? c.chatlog : chatlog;
  S.keepDays = clampInt(c.keepDays, 1, 3650, KEEP_DAYS);
  S.indexDays = clampInt(c.indexDays, 1, 365, INDEX_DAYS);
  S.indexMax = clampInt(c.indexMax, 16, 200_000, INDEX_MAX);
  S.fsyncMs = clampInt(c.fsyncMs, 0, 60_000, FSYNC_MS);
  S.cooldownMs = clampInt(c.cooldownMs, 0, 3_600_000, REPORT_COOLDOWN_MS);
  S.burst = clampInt(c.burst, 1, 1000, REPORT_BURST);
  S.windowMs = clampInt(c.windowMs, 1000, 86_400_000, REPORT_WINDOW_MS);
  S.contextLines = clampInt(c.contextLines, 0, 200, CONTEXT_LINES);
  S.budgets.clear();
  S.filed = 0; S.deduped = 0; S.refused = 0; S.states = 0; S.writeFails = 0;
  S.purged = 0; S.blobs = 0; S.blobBytes = 0; S.reads = 0; S.readsRefused = 0; S.errors = 0;

  try { fs.mkdirSync(S.dir, { recursive: true }); } catch (e) { S.logFn(`mkdir ${S.dir}`, e); }
  S.installed = true;
  openDay(utcDay(nowMs()));
  const indexed = loadIndex();
  const swept = sweep();

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
  if (!S.auditFn) console.warn('[reports] no ctx.audit hook: queue decisions will NOT be logged');
  const open = [...S.index.values()].filter((r) => r.state === 'open').length;
  console.log(`[reports] ready (${indexed} indexed, ${open} open, keep ${S.keepDays}d, ${S.dir})`);
  return { dir: S.dir, day: S.day, indexed, open, purged: swept.purged };
}

/** For /api/health, the HUD's unread badge, and the future panel. */
export function stats() {
  const counts = { open: 0, reviewed: 0, actioned: 0, dismissed: 0 };
  for (const r of S.index.values()) if (own(counts, r.state)) counts[r.state]++;
  return {
    installed: S.installed,
    dir: S.dir,
    day: S.day,
    indexed: S.index.size,
    counts,
    filed: S.filed,
    deduped: S.deduped,
    refused: S.refused,
    states: S.states,
    writeFails: S.writeFails,
    purged: S.purged,
    blobs: S.blobs,
    blobBytes: S.blobBytes,
    reads: S.reads,
    readsRefused: S.readsRefused,
    errors: S.errors,
    files: listFiles().length,
  };
}

/** Flush, close the fd, stop the timers, forget the index. Idempotent. */
export function close() {
  if (S.fsyncTimer) { clearTimeout(S.fsyncTimer); S.fsyncTimer = null; }
  if (S.sweepTimer) { clearInterval(S.sweepTimer); S.sweepTimer = null; }
  flush();
  closeFd();
  S.index.clear();
  S.budgets.clear();
  S.installed = false;
  S.day = '';
  S.file = '';
  return true;
}

export default {
  install, handleMessage, file, mural, queue, get, view, setState,
  sweep, flush, stats, listFiles, close, utcDay,
  KINDS, STATES, REASONS, OPS, READ_CAP, ACT_CAP, REOPEN_CAP,
};
