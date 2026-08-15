#!/usr/bin/env node
/**
 * scripts/report.js — `npm run report`, the owner's weekly twelve numbers
 * (wave 13B, liveops.md §6.2/§6.3).
 *
 *   npm run report                 the current ISO week, so far
 *   npm run report last            the previous ISO week
 *   npm run report 2026-W33        one named week
 *   npm run report 2026-08-10..2026-08-16   any range of ET days
 *   npm run report --days=30       the last 30 days ending today
 *   npm run report --json          the same model as JSON, for piping
 *   npm run report --dir=<path>    a stats directory other than the default
 *
 * WHAT THIS IS: a plain-text table in a terminal, read on Sunday morning with
 * a coffee. No dashboard, no web UI, no charting library, no dependency. A
 * one-person operator will actually read this; nobody logs into a dashboard.
 *
 * WHAT IT READS: the NDJSON day files server/stats.js appends
 * (<dataDir>/stats/stats-YYYY-MM-DD.ndjson). The day files are the authority —
 * the frozen week-*.json rollups are a cache, so a week the server never got
 * to close still reports correctly, and a report can be re-run over any range
 * at any time and give the same answer.
 *
 * STANDALONE ON PURPOSE: this file imports NOTHING from server/. Importing
 * server/progress.js would pull in server/db.js, which loads the account store
 * and starts backup timers at import time — a read-only report has no business
 * doing either. The only thing it would have gained is `weekKey`, which is
 * pure calendar math over an ET day-key STRING (the timezone question was
 * already answered when the filename was written), so it is restated here.
 * test/stats.test.js cross-checks the two implementations over three years of
 * days so they cannot drift apart in silence.
 *
 * PRIVACY: this file prints AGGREGATE COUNTS ONLY. It never prints a `u`, and
 * `u` is a salted hash of an account key in the first place, so even the file
 * it reads is not a directory of who plays this game. There is no per-player
 * section, no leaderboard of individuals, and no chat content anywhere in the
 * pipeline — server/stats.js never wrote any. test/stats.test.js asserts that
 * no rendered line contains an account handle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// calendar helpers (pure string math on ET day keys; see the header note)
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' -> the UTC ms of that calendar date at midnight UTC. */
export function dayMs(dk) {
  const m = DAY_RE.exec(String(dk || ''));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The UTC ms of a calendar date back to 'YYYY-MM-DD'. */
export function msDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `dk` shifted by n calendar days. */
export function addDays(dk, n) {
  const ms = dayMs(dk);
  return Number.isFinite(ms) ? msDay(ms + n * 86_400_000) : '';
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** 'Mon'..'Sun' for a day key. */
export function weekdayOf(dk) {
  const ms = dayMs(dk);
  return Number.isFinite(ms) ? WEEKDAYS[(new Date(ms).getUTCDay() + 6) % 7] : '???';
}

/** ISO-8601 week label ('2026-W33') for an ET day key. Mirrors stats.weekKey. */
export function weekKey(dk) {
  const ms = dayMs(dk);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow + 3); // the Thursday decides year + number
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Mon = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7));
  const n = 1 + Math.round((d.getTime() - week1Mon) / 604_800_000);
  return `${year}-W${pad2(n)}`;
}

/** The seven ET day keys of an ISO week, Monday first. Mirrors stats.weekDays. */
export function weekDays(wk) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(wk || ''));
  if (!m) return [];
  const year = Number(m[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mon = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7)) + (Number(m[2]) - 1) * 604_800_000;
  return Array.from({ length: 7 }, (_, i) => msDay(mon + i * 86_400_000));
}

/** Every day key from `a` to `b` inclusive. */
export function dayRange(a, b) {
  const out = [];
  const from = dayMs(a); const to = dayMs(b);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return out;
  for (let ms = from; ms <= to; ms += 86_400_000) out.push(msDay(ms));
  return out;
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** The default stats directory: COVE_DATA_DIR (or <repo>/data) + /stats. */
export function defaultDir() {
  const dataDir = process.env.COVE_DATA_DIR ? path.resolve(process.env.COVE_DATA_DIR) : path.join(ROOT, 'data');
  return path.join(dataDir, 'stats');
}

/** Every ET day key that has a file on disk, oldest first. */
export function daysOnDisk(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((n) => /^stats-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

/**
 * One day's records. A truncated or hand-mangled last line is skipped rather
 * than fatal: a report that refuses to print because of one bad byte is worse
 * than a report that is one line short, and NDJSON's whole appeal is that a
 * damaged line damages only itself.
 */
export function readDay(dir, dk) {
  const file = path.join(dir, `stats-${dk}.ndjson`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && typeof rec.k === 'string') out.push(rec);
    } catch { /* skip the damaged line, keep the day */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the model: twelve numbers
// ---------------------------------------------------------------------------

const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

const topN = (obj, n = 12) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

/**
 * Build the report model for `days`.
 *
 * `dir` is read twice over: once for the window itself, and once for the eight
 * days AFTER it, because the retention proxy needs to know whether a cohort
 * came back on X+1 and X+7 and those returns land in files the window does not
 * cover. Nothing else looks outside the window.
 */
export function collect(dir, days) {
  const m = {
    dir,
    days,
    from: days[0] || '',
    to: days[days.length - 1] || '',
    perDay: {},           // dk -> { dau, sessions, new, peak, coins, spent }
    dau: {},              // dk -> Set
    wau: new Set(),
    newBy: {},            // dk -> Set of accounts created that day
    firstSeen: new Map(), // u -> first day key seen (within the read range)
    seenOn: new Map(),    // u -> Set of day keys
    sessions: 0,
    guestSessions: 0,
    sessionMs: [],
    peakCCU: 0,
    peakDay: '',
    peakHour: -1,
    byHour: new Array(24).fill(0),
    byWeekdayHour: {},    // 'Mon' -> [24]
    minted: 0,
    mintedBy: {},
    spent: 0,
    spentBy: {},
    starts: {},           // game -> starts
    runs: {},             // game -> paid runs
    runCoins: {},         // game -> coins
    duels: 0,
    duelsBy: {},
    reports: 0,
    chats: 0,
    rooms: {},
    files: 0,
    lines: 0,
  };

  const inWindow = new Set(days);
  // the window, plus 8 days of look-ahead for the retention proxy
  const lookahead = [];
  for (let i = 1; i <= 8 && m.to; i++) lookahead.push(addDays(m.to, i));

  for (const dk of [...days, ...lookahead]) {
    const recs = readDay(dir, dk);
    if (!recs.length) continue;
    const here = inWindow.has(dk);
    if (here) m.files++;

    const day = m.perDay[dk] || (m.perDay[dk] = { dau: 0, sessions: 0, new: 0, peak: 0, coins: 0, spent: 0 });
    const dauSet = m.dau[dk] || (m.dau[dk] = new Set());

    for (const r of recs) {
      const u = typeof r.u === 'string' ? r.u : null;
      // presence bookkeeping spans the look-ahead: that is the whole point
      if (r.k === 'open' && u) {
        (m.seenOn.get(u) || m.seenOn.set(u, new Set()).get(u)).add(dk);
        if (!m.firstSeen.has(u)) m.firstSeen.set(u, dk);
        if (r.n === 1) (m.newBy[dk] || (m.newBy[dk] = new Set())).add(u);
      }
      if (!here) continue;

      m.lines++;
      switch (r.k) {
        case 'open': {
          m.sessions++;
          day.sessions++;
          if (u) { dauSet.add(u); m.wau.add(u); } else m.guestSessions++;
          if (r.n === 1) day.new++;
          const h = Number.isInteger(r.h) && r.h >= 0 && r.h <= 23 ? r.h : null;
          if (h !== null) {
            m.byHour[h]++;
            const wd = weekdayOf(dk);
            (m.byWeekdayHour[wd] || (m.byWeekdayHour[wd] = new Array(24).fill(0)))[h]++;
          }
          break;
        }
        case 'sess':
          if (Number.isFinite(r.ms)) m.sessionMs.push(Math.max(0, r.ms));
          break;
        case 'ccu': {
          const n = Number(r.n) || 0;
          if (n > day.peak) day.peak = n;
          if (n > m.peakCCU) {
            m.peakCCU = n; m.peakDay = dk;
            m.peakHour = Number.isInteger(r.h) ? r.h : -1;
          }
          break;
        }
        case 'coin': {
          const n = Math.max(0, Number(r.n) || 0);
          m.minted += n; day.coins += n;
          const key = typeof r.r === 'string' && r.r ? r.r : 'other';
          m.mintedBy[key] = (m.mintedBy[key] || 0) + n;
          break;
        }
        case 'spend': {
          const n = Math.max(0, Number(r.n) || 0);
          m.spent += n; day.spent += n;
          const key = typeof r.s === 'string' && r.s ? r.s : 'other';
          m.spentBy[key] = (m.spentBy[key] || 0) + n;
          break;
        }
        case 'mg': {
          const g = typeof r.g === 'string' && r.g ? r.g : 'other';
          m.starts[g] = (m.starts[g] || 0) + 1;
          break;
        }
        case 'score': {
          const g = typeof r.g === 'string' && r.g ? r.g : 'other';
          m.runs[g] = (m.runs[g] || 0) + 1;
          m.runCoins[g] = (m.runCoins[g] || 0) + Math.max(0, Number(r.c) || 0);
          break;
        }
        case 'duel': {
          const g = typeof r.g === 'string' && r.g ? r.g : 'other';
          m.duels++;
          m.duelsBy[g] = (m.duelsBy[g] || 0) + 1;
          break;
        }
        case 'chat': m.chats++; break;
        case 'report': m.reports++; break;
        case 'room': {
          const r2 = typeof r.r === 'string' && r.r ? r.r : 'other';
          m.rooms[r2] = (m.rooms[r2] || 0) + 1;
          break;
        }
        default: break;
      }
    }
    if (here) day.dau = dauSet.size;
  }

  // ---- derived ----
  const dauVals = days.map((d) => (m.dau[d] ? m.dau[d].size : 0));
  m.dauAvg = dauVals.length ? Math.round(dauVals.reduce((a, b) => a + b, 0) / dauVals.length) : 0;
  m.dauPeak = dauVals.length ? Math.max(...dauVals) : 0;
  m.wauCount = m.wau.size;
  m.stickiness = m.wauCount ? Number((m.dauAvg / m.wauCount).toFixed(2)) : 0;
  m.newTotal = days.reduce((a, d) => a + (m.newBy[d] ? m.newBy[d].size : 0), 0);
  m.medianSessionMs = median(m.sessionMs);
  m.sessionsClosed = m.sessionMs.length;
  m.startsTotal = Object.values(m.starts).reduce((a, b) => a + b, 0);
  m.runsTotal = Object.values(m.runs).reduce((a, b) => a + b, 0);
  m.sessionsPerAccount = m.wauCount ? Number((m.sessions / m.wauCount).toFixed(1)) : 0;

  // retention proxy: of the accounts whose FIRST session was on day X, the
  // share seen again on X+1 (D1) and on X+7 (D7). Only cohorts whose target
  // day actually has a file on disk are counted, so a report run on Tuesday
  // does not score Monday's D7 as zero.
  const onDisk = new Set(daysOnDisk(dir));
  const d1 = { cohort: 0, back: 0 };
  const d7 = { cohort: 0, back: 0 };
  for (const dk of days) {
    const cohort = m.newBy[dk];
    if (!cohort || !cohort.size) continue;
    for (const [span, acc] of [[1, d1], [7, d7]]) {
      const target = addDays(dk, span);
      if (!onDisk.has(target)) continue;
      acc.cohort += cohort.size;
      for (const u of cohort) if (m.seenOn.get(u)?.has(target)) acc.back++;
    }
  }
  m.d1 = d1; m.d7 = d7;
  m.d1Rate = d1.cohort ? Math.round((d1.back / d1.cohort) * 100) : null;
  m.d7Rate = d7.cohort ? Math.round((d7.back / d7.cohort) * 100) : null;

  // busiest hour, for scheduling the anchors against measurement, not guesswork
  let best = { wd: '', h: -1, n: 0 };
  for (const [wd, hours] of Object.entries(m.byWeekdayHour)) {
    hours.forEach((n, h) => { if (n > best.n) best = { wd, h, n }; });
  }
  m.busiest = best;
  return m;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const bar = (n, max, width = 24) => (max > 0 ? '#'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((n / max) * width))) : '');
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(7);
const mins = (ms) => `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
const pct = (v) => (v === null ? ' n/a' : `${String(v).padStart(3)}%`);
const capys = (n) => `${n} cap${n === 1 ? 'y' : 'ys'}`;

function table(rows, { max, unit = '' } = {}) {
  if (!rows.length) return ['    (nothing yet)'];
  const top = max ?? Math.max(...rows.map(([, v]) => v));
  const w = Math.max(...rows.map(([k]) => String(k).length));
  return rows.map(([k, v]) => `    ${pad(k, w)}  ${num(v)}${unit ? ` ${unit}` : ''}  ${bar(v, top)}`);
}

/** The whole report as lines of plain text. Aggregates only, by construction. */
export function render(m, { label } = {}) {
  const L = [];
  const rule = '='.repeat(72);
  const thin = '-'.repeat(72);
  L.push(rule);
  L.push(`  CAPY COVE — the weekly numbers`);
  L.push(`  ${label || `${m.from} .. ${m.to}`}   (${m.days.length} days, ${m.files} with data, ${m.lines} events)`);
  L.push(rule);
  if (!m.lines) {
    L.push('');
    L.push('  No stats recorded for this window.');
    L.push(`  Looked in: ${m.dir}`);
    L.push('');
    L.push('  If the server is running, the day file appears on the first');
    L.push('  session; if you moved COVE_DATA_DIR, pass --dir=<path>.');
    L.push(rule);
    return L;
  }

  L.push('');
  L.push(' 1. DAILY ACTIVE ACCOUNTS');
  L.push(thin);
  {
    const rows = m.days.map((d) => [`${d} ${weekdayOf(d)}`, m.dau[d] ? m.dau[d].size : 0]);
    L.push(...table(rows));
    L.push(`    average ${m.dauAvg}   best day ${m.dauPeak}   distinct over the window (WAU) ${m.wauCount}`);
    L.push(`    stickiness DAU/WAU ${m.stickiness}  ${m.stickiness ? (m.stickiness < 0.2 ? '(they visit weekly, not daily)' : m.stickiness > 0.35 ? '(a habit — protect the anchor times)' : '(healthy)') : ''}`);
  }

  L.push('');
  L.push(' 2. NEW ACCOUNTS');
  L.push(thin);
  {
    const rows = m.days.map((d) => [`${d} ${weekdayOf(d)}`, m.newBy[d] ? m.newBy[d].size : 0]);
    L.push(...table(rows));
    L.push(`    total ${m.newTotal}`);
  }

  L.push('');
  L.push(' 3. SESSIONS');
  L.push(thin);
  L.push(`    total ${m.sessions}   (${m.sessions - m.guestSessions} signed in, ${m.guestSessions} guest)`);
  L.push(`    per returning account ${m.sessionsPerAccount}   — this is the number a live-ops calendar moves`);

  L.push('');
  L.push(' 4. SESSION LENGTH');
  L.push(thin);
  L.push(`    median ${mins(m.medianSessionMs)}   over ${m.sessionsClosed} closed sessions`);
  if (m.medianSessionMs && m.medianSessionMs < 8 * 60_000) {
    L.push('    under 8 minutes: people are not finding the second thing to do');
  }

  L.push('');
  L.push(' 5. COINS MINTED (the faucet, by reason)');
  L.push(thin);
  L.push(...table(topN(m.mintedBy)));
  L.push(`    total ${m.minted}`);
  {
    const top = topN(m.mintedBy, 1)[0];
    if (top && m.minted && top[1] / m.minted > 0.5) {
      L.push(`    '${top[0]}' is ${Math.round((top[1] / m.minted) * 100)}% of all coins minted — check it is not the dominant strategy`);
    }
  }

  L.push('');
  L.push(' 6. COINS SPENT (the sinks)');
  L.push(thin);
  L.push(...table(topN(m.spentBy)));
  L.push(`    total ${m.spent}   sink/faucet ratio ${m.minted ? (m.spent / m.minted).toFixed(2) : '0.00'}`);

  L.push('');
  L.push(' 7. MINIGAME STARTS, BY GAME');
  L.push(thin);
  {
    const games = [...new Set([...Object.keys(m.starts), ...Object.keys(m.runs)])];
    const rows = games.map((g) => [g, m.starts[g] || 0]).sort((a, b) => b[1] - a[1]);
    L.push(...table(rows));
    L.push(`    total starts ${m.startsTotal}, paid runs ${m.runsTotal}`);
    const never = games.filter((g) => !(m.starts[g] || m.runs[g]));
    if (never.length) L.push(`    never played: ${never.join(', ')}`);
  }

  L.push('');
  L.push(' 8. DUELS');
  L.push(thin);
  L.push(...table(topN(m.duelsBy)));
  L.push(`    total ${m.duels}`);

  L.push('');
  L.push(' 9. REPORTS FILED');
  L.push(thin);
  L.push(`    ${m.reports}   (the T&S queue; content never reaches this log)`);

  L.push('');
  L.push('10. PEAK CONCURRENCY');
  L.push(thin);
  {
    const rows = m.days.map((d) => [`${d} ${weekdayOf(d)}`, m.perDay[d] ? m.perDay[d].peak : 0]);
    L.push(...table(rows));
    L.push(`    best ${capys(m.peakCCU)} at once${m.peakDay ? ` on ${m.peakDay}${m.peakHour >= 0 ? ` around ${pad2(m.peakHour)}:00 ET` : ''}` : ''}`);
    if (m.busiest.n) L.push(`    busiest hour of the week: ${m.busiest.wd} ${pad2(m.busiest.h)}:00 ET (${m.busiest.n} sessions opened)`);
  }

  L.push('');
  L.push('11. RETENTION PROXY');
  L.push(thin);
  L.push(`    D1  ${pct(m.d1Rate)}   ${m.d1.back}/${m.d1.cohort} of new accounts came back the next day`);
  L.push(`    D7  ${pct(m.d7Rate)}   ${m.d7.back}/${m.d7.cohort} came back a week later`);
  if (!m.d1.cohort && !m.d7.cohort) L.push('    (no cohort has a full follow-up day on disk yet)');

  L.push('');
  L.push('12. CHAT LINES');
  L.push(thin);
  L.push(`    ${m.chats} lines spoken   (a COUNT — no message text is stored anywhere)`);
  L.push(`    ${m.sessions ? (m.chats / m.sessions).toFixed(1) : '0.0'} per session — if this falls, the world is going single-player`);

  const roomRows = topN(m.rooms);
  if (roomRows.length) {
    L.push('');
    L.push('    room heat (joins), for context');
    L.push(...table(roomRows));
  }

  L.push('');
  L.push(rule);
  L.push('  Aggregate counts only. No names, no chat, no per-player rows.');
  L.push(rule);
  return L;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Turn argv into { dir, days, label, json }. Never throws. */
export function parseArgs(argv = [], { today = null, dir = null } = {}) {
  const opts = { dir: dir || defaultDir(), json: false, label: '' };
  let target = '';
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a.startsWith('--dir=')) opts.dir = path.resolve(a.slice(6));
    else if (a.startsWith('--days=')) opts.nDays = Math.max(1, Math.min(370, Number(a.slice(7)) || 7));
    else if (!a.startsWith('-')) target = a;
  }
  const disk = daysOnDisk(opts.dir);
  const now = today || (disk.length ? disk[disk.length - 1] : msDay(Date.now()));

  let days = [];
  if (opts.nDays) {
    days = dayRange(addDays(now, -(opts.nDays - 1)), now);
    opts.label = `last ${opts.nDays} days, ending ${now}`;
  } else if (/^\d{4}-W\d{2}$/.test(target)) {
    days = weekDays(target);
    opts.label = `week ${target}`;
  } else if (/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(target)) {
    const [a, b] = target.split('..');
    days = dayRange(a, b);
    opts.label = `${a} .. ${b}`;
  } else if (DAY_RE.test(target)) {
    days = [target];
    opts.label = `${target} ${weekdayOf(target)}`;
  } else if (target === 'last' || target === 'prev') {
    const wk = weekKey(addDays(weekDays(weekKey(now))[0], -1));
    days = weekDays(wk);
    opts.label = `week ${wk} (previous)`;
  } else {
    const wk = weekKey(now);
    days = weekDays(wk);
    opts.label = `week ${wk}`;
  }
  opts.days = days;
  return opts;
}

/** Build and render. Returns { model, lines, text }. */
export function report(argv = [], env = {}) {
  const opts = parseArgs(argv, env);
  const model = collect(opts.dir, opts.days);
  const lines = opts.json ? [JSON.stringify(jsonModel(model), null, 2)] : render(model, { label: opts.label });
  return { opts, model, lines, text: `${lines.join('\n')}\n` };
}

/** The model with the Sets collapsed, for --json. Still aggregate-only. */
export function jsonModel(m) {
  return {
    from: m.from,
    to: m.to,
    days: m.days,
    dau: Object.fromEntries(m.days.map((d) => [d, m.dau[d] ? m.dau[d].size : 0])),
    dauAvg: m.dauAvg,
    wau: m.wauCount,
    stickiness: m.stickiness,
    newAccounts: m.newTotal,
    newByDay: Object.fromEntries(m.days.map((d) => [d, m.newBy[d] ? m.newBy[d].size : 0])),
    sessions: m.sessions,
    guestSessions: m.guestSessions,
    sessionsPerAccount: m.sessionsPerAccount,
    medianSessionMs: m.medianSessionMs,
    coinsMinted: m.minted,
    coinsMintedBy: m.mintedBy,
    coinsSpent: m.spent,
    coinsSpentBy: m.spentBy,
    minigameStarts: m.starts,
    minigameRuns: m.runs,
    duels: m.duels,
    duelsByGame: m.duelsBy,
    reportsFiled: m.reports,
    peakCCU: m.peakCCU,
    peakDay: m.peakDay,
    peakByDay: Object.fromEntries(m.days.map((d) => [d, m.perDay[d] ? m.perDay[d].peak : 0])),
    busiestHour: m.busiest,
    retention: { d1: m.d1, d1Rate: m.d1Rate, d7: m.d7, d7Rate: m.d7Rate },
    chatLines: m.chats,
    roomJoins: m.rooms,
  };
}

// Run only when invoked directly, so the tests can import the pieces.
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.stdout.write(report(process.argv.slice(2)).text);
  } catch (e) {
    console.error('[report]', e?.message || e);
    process.exitCode = 1;
  }
}
