/**
 * test/stats.test.js — the liveops tee and the weekly report (wave 13B, N-28).
 *
 *   node --test test/stats.test.js
 *
 * Everything runs inside a throwaway COVE_DATA_DIR with a FAKE CLOCK, so a
 * whole fortnight (including a DST weekend and a year boundary) passes in a
 * millisecond and no test ever touches the real data directory.
 *
 * Three things are being pinned down, in order of how much damage getting them
 * wrong would do:
 *
 *  1. PRIVACY. No chat text reaches the disk, no username reaches the disk,
 *     and nothing the report prints contains an account handle. Those are not
 *     documentation, they are assertions over the actual bytes written.
 *  2. HARMLESSNESS. Every entry point survives garbage, survives an unwritable
 *     directory, and returns without throwing. A counter must never be the
 *     reason a player lost a frame — so the tests call each door with rubbish
 *     on purpose.
 *  3. The numbers themselves: ET day rollover, ISO week labelling, the median,
 *     the peak, the new-account count, and the retention proxy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-stats13-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const stats = (await import('../server/stats.js')).default;
const R = await import('../scripts/report.js');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;
// 2026-08-10 is a Monday; 16:00 UTC is noon ET (EDT), safely mid-afternoon.
const MON = Date.UTC(2026, 7, 10, 16, 0, 0);

let clock = MON;
let dirs = 0;
let recs;

/** A fresh stats dir + a fresh install, with timers and exit hooks off. */
function boot(opts = {}) {
  const dir = path.join(SANDBOX, `run${++dirs}`);
  clock = opts.at ?? MON;
  recs = new Map();
  stats.install({
    dir,
    now: () => clock,
    recordFor: (p) => (p && p.username ? recs.get(p.username.toLowerCase()) || null : null),
    salt: 'test-salt',
    timers: false,
    hooks: false,
    fsyncMs: 0,
    log: () => {},
    ...opts,
  });
  return dir;
}

const tick = (ms) => { clock += ms; };

let seq = 0;
/** A signed-in player whose account was created `createdAt`. */
function account(name, createdAt = MON - 30 * DAY) {
  recs.set(name.toLowerCase(), { username: name, uid: `u-${name}`, created: createdAt, coins: 0 });
  return { id: `p${++seq}`, name, username: name, bot: false, room: 'plaza' };
}
const guest = () => ({ id: `p${++seq}`, name: `Guest${seq}`, username: null, bot: false, room: 'plaza' });

/** Every record written to one day file. */
function lines(dir, dk) {
  const file = path.join(dir, `stats-${dk}.ndjson`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const rawDay = (dir, dk) => {
  const file = path.join(dir, `stats-${dk}.ndjson`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};
const kinds = (arr, k) => arr.filter((r) => r.k === k);

// ---------------------------------------------------------------------------
// 1. privacy
// ---------------------------------------------------------------------------

test('no username, no chat text, no room-mate ever reaches the disk', () => {
  const dir = boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  // the shape index.js actually calls with: signal('chat', p, {room})
  stats.signal('chat', p, { room: 'plaza', text: 'my email is nobody@example.com' });
  stats.signal('room', p, { room: 'beach' });
  stats.grant(p, 74, 'fishing');
  stats.observe(p, { t: 'report', target: 'Sunny', reason: 'said a bad word', text: 'the bad word' });
  stats.sessionClose(p);
  stats.flush();

  const text = rawDay(dir, '2026-08-10');
  assert.ok(text.length > 0, 'the day file exists');
  for (const secret of ['Mango', 'mango', 'Sunny', 'example.com', 'bad word', 'said a']) {
    assert.ok(!text.includes(secret), `the log must not contain ${JSON.stringify(secret)}`);
  }
  // the chat line is the NUMBER one
  assert.equal(kinds(lines(dir, '2026-08-10'), 'chat').length, 1);
  assert.deepEqual(Object.keys(kinds(lines(dir, '2026-08-10'), 'chat')[0]).sort(), ['k', 't', 'u']);
});

test('the account handle is a salted hash, stable within an install', () => {
  const dir = boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.sessionClose(p);
  stats.sessionOpen({ ...p, id: 'p-second-tab' });
  stats.flush();
  const opens = kinds(lines(dir, '2026-08-10'), 'open');
  assert.equal(opens.length, 2);
  assert.equal(opens[0].u, opens[1].u, 'same account, same handle');
  assert.match(opens[0].u, /^[0-9a-f]{8}$/);
});

test('a guest has no handle at all, and is not counted as an active account', () => {
  const dir = boot();
  stats.sessionOpen(guest());
  stats.flush();
  const open = kinds(lines(dir, '2026-08-10'), 'open')[0];
  assert.equal(open.u, undefined);
  assert.equal(open.gu, 1);
  const w = stats.week();
  assert.equal(w.players.sessions, 1);
  assert.equal(w.players.guestSessions, 1);
  assert.equal(w.players.dauByDay['2026-08-10'], undefined, 'guests are sessions, not accounts');
});

test('the rendered report contains no account handle anywhere', () => {
  const dir = boot();
  const a = account('Mango');
  const b = account('Sunny');
  stats.sessionOpen(a); stats.sessionOpen(b);
  stats.signal('chat', a, { room: 'plaza' });
  stats.grant(a, 50, 'fishing');
  stats.spend(a, 120, 'hat');
  tick(20 * 60_000);
  stats.sessionClose(a); stats.sessionClose(b);
  stats.flush();

  const handles = new Set(lines(dir, '2026-08-10').map((r) => r.u).filter(Boolean));
  assert.ok(handles.size >= 2);
  const { text } = R.report([`--dir=${dir}`, '2026-W33']);
  for (const h of handles) assert.ok(!text.includes(h), `report leaked the handle ${h}`);
  assert.ok(!text.includes('Mango') && !text.includes('Sunny'));
});

// ---------------------------------------------------------------------------
// 2. harmlessness
// ---------------------------------------------------------------------------

test('every entry point survives garbage without throwing', () => {
  boot();
  const junk = [null, undefined, 0, '', [], {}, { id: 1 }, { bot: true, id: 'b1' }];
  for (const p of junk) {
    assert.doesNotThrow(() => stats.sessionOpen(p));
    assert.doesNotThrow(() => stats.sessionClose(p));
    assert.doesNotThrow(() => stats.signal('score', p, null));
    assert.doesNotThrow(() => stats.signal(null, p, undefined));
    assert.doesNotThrow(() => stats.grant(p, NaN, undefined));
    assert.doesNotThrow(() => stats.grant(p, -5, { not: 'a string' }));
    assert.doesNotThrow(() => stats.spend(p, Infinity, null));
    assert.doesNotThrow(() => stats.observe(p, 'not a frame'));
    assert.doesNotThrow(() => stats.observe(p, { t: 'mgstart' }));
  }
  assert.doesNotThrow(() => stats.tick());
  assert.doesNotThrow(() => stats.week());
  assert.doesNotThrow(() => stats.flush());
});

test('observe never consumes a frame', () => {
  boot();
  const p = account('Mango');
  assert.equal(stats.observe(p, { t: 'mgstart', game: 'fishing' }), false);
  assert.equal(stats.observe(p, { t: 'report' }), false);
  assert.equal(stats.observe(p, { t: 'chat', text: 'hi' }), false);
});

test('a bot is never counted', () => {
  const dir = boot();
  const b = { id: 'bot1', name: 'Nibbles', username: null, bot: true, room: 'plaza' };
  stats.sessionOpen(b);
  stats.signal('chat', b, {});
  stats.grant(b, 100, 'fishing');
  stats.observe(b, { t: 'mgstart', game: 'fishing' });
  stats.flush();
  assert.equal(lines(dir, '2026-08-10').length, 0);
  assert.equal(stats.week().players.sessions, 0);
});

test('calls before install (and after shutdown) are silent no-ops', () => {
  const dir = boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.shutdown();
  assert.doesNotThrow(() => stats.sessionOpen(p));
  assert.doesNotThrow(() => stats.grant(p, 10, 'fishing'));
  assert.equal(stats.note('coin', { n: 1 }), false);
  // shutdown closed the open session rather than losing its length
  assert.equal(kinds(lines(dir, '2026-08-10'), 'sess').length, 1);
});

test('an unknown kind is refused by note()', () => {
  boot();
  assert.equal(stats.note('definitely-not-a-kind', { n: 1 }), false);
  assert.equal(stats.note('chat', {}), true);
});

// ---------------------------------------------------------------------------
// 3. the numbers
// ---------------------------------------------------------------------------

test('sessions, DAU and peak concurrency', () => {
  const dir = boot();
  const a = account('A'); const b = account('B'); const c = account('C');
  stats.sessionOpen(a); stats.sessionOpen(b); stats.sessionOpen(c); // peak 3
  stats.sessionClose(b);
  stats.sessionClose(c);
  stats.sessionOpen(b); // back to 2, no new peak
  stats.flush();

  const w = stats.week();
  assert.equal(w.players.sessions, 4);
  assert.equal(w.players.dauByDay['2026-08-10'], 3, 'three distinct accounts');
  assert.equal(w.players.peakCCU, 3);
  const ccu = kinds(lines(dir, '2026-08-10'), 'ccu').map((r) => r.n);
  assert.deepEqual(ccu, [1, 2, 3], 'a ccu line only when the peak actually rises');
});

test('the peak is a per-day high-water mark, so a big Monday cannot blank Tuesday', () => {
  const dir = boot();
  const a = account('A'); const b = account('B');
  stats.sessionOpen(a); stats.sessionOpen(b); // Monday peak 2
  stats.sessionClose(a); stats.sessionClose(b);
  tick(DAY);
  stats.sessionOpen({ ...a, id: 'a-tue' }); // Tuesday peak 1
  stats.flush();
  assert.deepEqual(kinds(lines(dir, '2026-08-10'), 'ccu').map((r) => r.n), [1, 2]);
  assert.deepEqual(kinds(lines(dir, '2026-08-11'), 'ccu').map((r) => r.n), [1]);
  assert.equal(stats.week().players.peakCCU, 2, 'the week still remembers the best day');
});

test('median session length comes from the closes, not the opens', () => {
  boot();
  const p = [account('A'), account('B'), account('C')];
  for (const x of p) stats.sessionOpen(x);
  tick(2 * 60_000); stats.sessionClose(p[0]);   //  2m
  tick(8 * 60_000); stats.sessionClose(p[1]);   // 10m
  tick(50 * 60_000); stats.sessionClose(p[2]);  // 60m
  const w = stats.week();
  assert.equal(w.players.sessionsClosed, 3);
  assert.equal(w.players.sessionMsMedian, 10 * 60_000);
});

test('new accounts count once per account per day, however many tabs', () => {
  const dir = boot();
  const fresh = account('Newbie', MON); // created today
  const old = account('Veteran', MON - 400 * DAY);
  stats.sessionOpen(fresh);
  stats.sessionClose(fresh);
  stats.sessionOpen({ ...fresh, id: 'tab2' });
  stats.sessionOpen(old);
  stats.flush();
  assert.equal(stats.week().players.new, 1);
  assert.equal(kinds(lines(dir, '2026-08-10'), 'open').filter((r) => r.n === 1).length, 1);
});

test('coins minted and spent, bucketed by reason and sink', () => {
  boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.grant(p, 74, 'fishing');
  stats.grant(p, 30, 'race win');       // spaces survive: it is a real reason
  stats.grant(p, 12, 'mining');
  stats.grant(p, 0, 'fishing');         // a refused grant mints nothing
  stats.spend(p, 120, 'hat');
  stats.spend(p, 400, 'furniture');
  const w = stats.week();
  assert.equal(w.economy.minted, 116);
  assert.equal(w.economy.granted['race win'], 30);
  assert.equal(w.economy.granted.fishing, 74);
  assert.equal(w.economy.spentTotal, 520);
  assert.deepEqual(w.economy.spent, { hat: 120, furniture: 400 });
});

test('minigame starts, paid runs and duels split by game', () => {
  boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.observe(p, { t: 'mgstart', game: 'fishing' });
  stats.observe(p, { t: 'mgstart', game: 'fishing' });
  stats.observe(p, { t: 'mgstart', game: 'kart' });
  stats.signal('score', p, { game: 'fishing', coins: 74 });
  stats.signal('match-win', p, { game: 'chess' });
  stats.signal('match-win', p, { game: 'cards' });
  const w = stats.week();
  assert.equal(w.games.fishing.starts, 2);
  assert.equal(w.games.fishing.runs, 1);
  assert.equal(w.games.fishing.coins, 74);
  assert.equal(w.games.kart.starts, 1);
  assert.equal(w.duels.total, 2);
  assert.equal(w.duels.byGame.chess, 1);
});

test('a mgstart line keeps BOTH the game id and the guest flag', () => {
  const dir = boot();
  stats.observe(guest(), { t: 'mgstart', game: 'fishing' });
  stats.flush();
  const mg = kinds(lines(dir, '2026-08-10'), 'mg')[0];
  assert.equal(mg.g, 'fishing', 'g is the game, never the guest flag');
  assert.equal(mg.gu, 1);
});

test('dens roll up as one room bucket instead of one per owner', () => {
  boot();
  const p = account('Mango');
  stats.signal('room', p, { room: 'house:mango' });
  stats.signal('room', p, { room: 'house:sunny' });
  stats.signal('room', p, { room: 'beach' });
  const w = stats.week();
  assert.equal(w.rooms.house, 2);
  assert.equal(w.rooms.beach, 1);
});

test('reports filed are counted, their contents are not', () => {
  const dir = boot();
  const p = account('Mango');
  stats.observe(p, { t: 'report', kind: 'player', target: 'Sunny', text: 'rude to me' });
  stats.flush();
  assert.equal(stats.week().safety.reports, 1);
  const rec = kinds(lines(dir, '2026-08-10'), 'report')[0];
  assert.deepEqual(Object.keys(rec).sort(), ['k', 't', 'u']);
});

// ---------------------------------------------------------------------------
// 4. the clock: ET days, ISO weeks, rollover
// ---------------------------------------------------------------------------

test('the day file follows the America/New_York calendar day, not UTC', () => {
  // 2026-08-11 02:00 UTC is still 2026-08-10 22:00 in the cove
  const dir = boot({ at: Date.UTC(2026, 7, 11, 2, 0, 0) });
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.flush();
  assert.ok(fs.existsSync(path.join(dir, 'stats-2026-08-10.ndjson')), 'ET day, not UTC day');
  assert.ok(!fs.existsSync(path.join(dir, 'stats-2026-08-11.ndjson')));
});

test('crossing ET midnight opens the next day file without a tick', () => {
  const dir = boot({ at: Date.UTC(2026, 7, 10, 23, 0, 0) }); // 19:00 ET Monday
  const p = account('Mango');
  stats.sessionOpen(p);
  tick(6 * HOUR); // 01:00 ET Tuesday
  stats.signal('chat', p, {});
  stats.flush();
  assert.equal(kinds(lines(dir, '2026-08-10'), 'open').length, 1);
  assert.equal(kinds(lines(dir, '2026-08-11'), 'chat').length, 1);
});

test('ISO week keys, and the two implementations agree over three years', () => {
  assert.equal(stats.weekKey('2026-08-10'), '2026-W33');
  assert.equal(stats.weekKey('2026-08-16'), '2026-W33', 'Sunday still belongs to its week');
  assert.equal(stats.weekKey('2026-08-17'), '2026-W34');
  assert.equal(stats.weekKey('2027-01-01'), '2026-W53', 'the year boundary follows ISO, not January');
  assert.deepEqual(stats.weekDays('2026-W33')[0], '2026-08-10');
  assert.deepEqual(stats.weekDays('2026-W33')[6], '2026-08-16');

  // scripts/report.js restates this math so it can stay free of server imports;
  // if the two ever disagree, this is where it shows up.
  for (let ms = Date.UTC(2025, 0, 1); ms <= Date.UTC(2028, 0, 1); ms += DAY) {
    const dk = R.msDay(ms);
    assert.equal(R.weekKey(dk), stats.weekKey(dk), `weekKey disagreed on ${dk}`);
  }
  for (const wk of ['2025-W01', '2026-W01', '2026-W33', '2026-W53', '2027-W52']) {
    assert.deepEqual(R.weekDays(wk), stats.weekDays(wk), `weekDays disagreed on ${wk}`);
  }
});

test('the ET hour survives the DST weekend', () => {
  // 2026-11-01 is the fall-back Sunday. 06:00 UTC is 01:00 ET on both sides.
  const h = stats.hourOf(Date.UTC(2026, 10, 1, 6, 0, 0));
  assert.ok(h >= 0 && h <= 23);
  // and a summer noon is noon
  assert.equal(stats.hourOf(Date.UTC(2026, 7, 10, 16, 0, 0)), 12);
});

// ---------------------------------------------------------------------------
// 5. rollups + retention + size cap
// ---------------------------------------------------------------------------

test('crossing into a new ISO week freezes the old one to disk', () => {
  const dir = boot({ at: Date.UTC(2026, 7, 16, 16, 0, 0) }); // Sunday of W33
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.grant(p, 100, 'fishing');
  tick(DAY); // Monday: a new ISO week
  stats.signal('chat', p, {});
  stats.flush();

  const frozen = path.join(dir, 'week-2026-W33.json');
  assert.ok(fs.existsSync(frozen), 'the finished week was written');
  const doc = JSON.parse(fs.readFileSync(frozen, 'utf8'));
  assert.equal(doc.week, '2026-W33');
  assert.equal(doc.economy.minted, 100);
  assert.equal(stats.week().week, '2026-W34', 'and a fresh bucket started');
});

test('close(weekId) writes the rollup atomically and starts a new bucket', () => {
  const dir = boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.grant(p, 60, 'fishing');
  const file = stats.close('2026-W33');
  assert.ok(file && fs.existsSync(file));
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no tmp file left behind');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).economy.minted, 60);
  assert.equal(stats.week().economy.minted, 0, 'the bucket was reset');
  assert.equal(stats.close('2020-W01'), null, 'a week that is not open cannot be closed');
});

test('the day file stops growing at the size cap but the counters do not', () => {
  const dir = boot({ maxDayBytes: 4096 });
  const p = account('Mango');
  stats.sessionOpen(p);
  for (let i = 0; i < 500; i++) stats.grant(p, 1, 'fishing');
  stats.flush();
  const size = fs.statSync(path.join(dir, 'stats-2026-08-10.ndjson')).size;
  assert.ok(size <= 4096 + 128, `day file stayed near the cap (${size})`);
  assert.equal(kinds(lines(dir, '2026-08-10'), 'cap').length, 1, 'and said so, once');
  assert.equal(stats.week().economy.minted, 500, 'every coin still counted');
  assert.ok(stats.stats().dropped > 0);
});

test('the sweep prunes day files past the retention window and keeps rollups', () => {
  const dir = boot();
  fs.writeFileSync(path.join(dir, 'stats-2020-01-01.ndjson'), '{"t":1,"k":"chat"}\n');
  fs.writeFileSync(path.join(dir, 'week-2020-W01.json'), '{}\n');
  const out = stats.sweep();
  assert.equal(out.purged, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'stats-2020-01-01.ndjson')));
  assert.ok(fs.existsSync(path.join(dir, 'week-2020-W01.json')), 'rollups are kept forever');
  assert.ok(fs.existsSync(path.join(dir, 'stats-2026-08-10.ndjson')), 'today is never swept');
});

// ---------------------------------------------------------------------------
// 6. the report
// ---------------------------------------------------------------------------

/** A week of play: 3 regulars, one newcomer a day, chats, runs, duels. */
function playAWeek(dir) {
  const regulars = ['Ana', 'Bo', 'Cy'].map((n) => account(n, MON - 200 * DAY));
  for (let d = 0; d < 7; d++) {
    for (const p of regulars) {
      stats.sessionOpen({ ...p, id: `${p.id}-d${d}` });
      stats.observe(p, { t: 'mgstart', game: d % 2 ? 'fishing' : 'kart' });
      stats.signal('score', p, { game: d % 2 ? 'fishing' : 'kart', coins: 40 });
      stats.grant(p, 40, d % 2 ? 'fishing' : 'kart');
      stats.signal('chat', p, { room: 'plaza' });
      stats.signal('room', p, { room: 'plaza' });
    }
    stats.signal('match-win', regulars[0], { game: 'chess' });
    stats.spend(regulars[0], 150, 'hat');
    // one newcomer a day; the first two come back tomorrow, the rest do not
    const n = account(`New${d}`, clock);
    stats.sessionOpen(n);
    tick(30 * 60_000);
    for (const p of regulars) stats.sessionClose({ ...p, id: `${p.id}-d${d}` });
    stats.sessionClose(n);
    if (d > 0 && d <= 2) {
      const back = recs.get(`new${d - 1}`);
      const bp = { id: `back${d}`, name: back.username, username: back.username, bot: false, room: 'plaza' };
      stats.sessionOpen(bp);
      tick(5 * 60_000);
      stats.sessionClose(bp);
    }
    tick(DAY - 35 * 60_000);
  }
  stats.flush();
  void dir;
}

test('npm run report prints the twelve numbers over a week of play', () => {
  const dir = boot();
  playAWeek(dir);

  const { model, text } = R.report([`--dir=${dir}`, '2026-W33']);
  // 1 DAU  2 new  3 sessions  4 median  5 minted  6 spent  7 starts
  // 8 duels  9 reports  10 peak  11 retention  12 chat
  assert.equal(model.dauAvg, 4, 'three regulars plus the day\'s newcomer');
  assert.equal(model.newTotal, 7);
  assert.equal(model.sessions, 7 * 4 + 2);
  assert.ok(model.medianSessionMs > 0);
  assert.equal(model.minted, 7 * 3 * 40);
  assert.equal(model.spent, 7 * 150);
  assert.equal(model.startsTotal, 21);
  assert.equal(model.duels, 7);
  assert.equal(model.chats, 21);
  assert.equal(model.peakCCU, 4);
  assert.equal(model.d1.cohort, 6, 'day 7\'s cohort has no follow-up day on disk');
  assert.equal(model.d1.back, 2);
  assert.equal(model.d1Rate, 33);

  for (const heading of [
    'DAILY ACTIVE ACCOUNTS', 'NEW ACCOUNTS', 'SESSIONS', 'SESSION LENGTH',
    'COINS MINTED', 'COINS SPENT', 'MINIGAME STARTS', 'DUELS', 'REPORTS FILED',
    'PEAK CONCURRENCY', 'RETENTION PROXY', 'CHAT LINES',
  ]) assert.ok(text.includes(heading), `the report is missing the ${heading} section`);
  assert.ok(text.includes('Aggregate counts only'));
});

test('the report reads day files, so a week that was never closed still prints', () => {
  const dir = boot();
  playAWeek(dir);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('week-')).length, 0, 'nothing frozen');
  const { model } = R.report([`--dir=${dir}`, '2026-W33']);
  assert.ok(model.lines > 0 && model.minted > 0);
});

test('report argument forms all resolve to a window', () => {
  const dir = boot();
  playAWeek(dir);
  const at = { today: '2026-08-16' };
  assert.equal(R.parseArgs([`--dir=${dir}`], at).days.length, 7);
  assert.equal(R.parseArgs([`--dir=${dir}`, '2026-W33'], at).days[0], '2026-08-10');
  assert.equal(R.parseArgs([`--dir=${dir}`, 'last'], at).days[0], '2026-08-03');
  assert.deepEqual(R.parseArgs([`--dir=${dir}`, '2026-08-11..2026-08-12'], at).days, ['2026-08-11', '2026-08-12']);
  assert.equal(R.parseArgs([`--dir=${dir}`, '--days=30'], at).days.length, 30);
  assert.equal(R.parseArgs([`--dir=${dir}`, '2026-08-11'], at).days.length, 1);
  assert.equal(R.parseArgs([`--dir=${dir}`, '--json'], at).json, true);
});

test('--json emits the same aggregates and no handles', () => {
  const dir = boot();
  playAWeek(dir);
  const { text } = R.report([`--dir=${dir}`, '2026-W33', '--json']);
  const doc = JSON.parse(text);
  assert.equal(doc.chatLines, 21);
  assert.equal(doc.coinsMinted, 840);
  assert.equal(typeof doc.retention.d1Rate, 'number');
  assert.ok(!('firstSeen' in doc) && !('seenOn' in doc));
});

test('an empty directory prints a helpful nothing rather than crashing', () => {
  const dir = path.join(SANDBOX, 'empty-dir');
  const { text, model } = R.report([`--dir=${dir}`]);
  assert.equal(model.lines, 0);
  assert.ok(text.includes('No stats recorded'));
});

test('a damaged NDJSON line costs its own line and nothing else', () => {
  const dir = boot();
  const p = account('Mango');
  stats.sessionOpen(p);
  stats.signal('chat', p, {});
  stats.flush();
  stats.shutdown({ rollup: false });
  const file = path.join(dir, 'stats-2026-08-10.ndjson');
  fs.appendFileSync(file, '{"t":1,"k":"chat"\n{"t":2,"k":"chat"}\n');
  const recsRead = R.readDay(dir, '2026-08-10');
  assert.equal(recsRead.filter((r) => r.k === 'chat').length, 2, 'the good lines survived');
});

test.after(() => {
  try { stats.shutdown({ rollup: false }); } catch { /* ignore */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});
