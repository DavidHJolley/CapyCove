/**
 * test/daily.test.js — the daily ritual (wave 12, N-25/N-26).
 *
 *   node --test test/daily.test.js
 *
 * server/progress.js is imported DIRECTLY with a fake ctx and, crucially, a
 * FAKE CLOCK: `install({ now })` lets a whole week — or a DST weekend — pass in
 * a millisecond. Nothing here boots a server or opens a socket.
 *
 * Two things are being pinned down:
 *
 *  1. The day key. The quest day is the real America/New_York calendar day, so
 *     the boundary is 05:00 UTC in winter and 04:00 UTC in summer, and the two
 *     days a year when the US moves its clocks are 23 and 25 hours long. Get
 *     this wrong and a player somewhere loses a day of their streak, which is
 *     exactly the kind of quiet punishment this game does not do.
 *
 *  2. The streak and its gift. The ramp goes up, it tops out at day 7, and a
 *     missed day starts it over WITHOUT taking anything back: not coins, not
 *     days played, not the best-streak high-water mark. Half the assertions in
 *     the streak section exist to prove a number did NOT go down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as progress from '../server/progress.js';

const { dayKey, dayStartMs, dayEndMs, prevDayKey, nextStreak, giftFor, STREAK_GIFTS, STREAK_CAP } = progress;

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let clock = Date.UTC(2026, 0, 15, 17, 0, 0); // 2026-01-15 12:00 ET
let users;
let out;      // every frame sent to any player, in order
let grants;   // every grantCoins call
let backstop; // when true, grantCoins refuses (the hourly ceiling)

function boot(at = Date.UTC(2026, 0, 15, 17, 0, 0)) {
  clock = at;
  users = new Map();
  out = [];
  grants = [];
  backstop = false;
  progress.install({
    now: () => clock,
    users,
    saveSoon: () => {},
    sendTo: (p, m) => { out.push({ to: p.id, ...m }); },
    broadcastToRoom: () => {},
    has: () => false,
    // a faithful stand-in for index.js's one coin road: it pays, it writes the
    // record, and it sends the {t:'coins'} frame itself
    grantCoins: (p, amount, reason) => {
      const pay = Math.max(0, Math.floor(Number(amount) || 0));
      if (backstop || pay <= 0) return 0;
      const rec = users.get(String(p.username).toLowerCase());
      if (rec) rec.coins = (rec.coins || 0) + pay;
      p.coins = rec ? rec.coins : (p.coins || 0) + pay;
      grants.push({ to: p.id, pay, reason });
      out.push({ to: p.id, t: 'coins', coins: p.coins, delta: pay, reason });
      return pay;
    },
  });
}

let seq = 0;
/** A registered account with an empty progress record. */
function account(name = `capy${++seq}`) {
  const rec = { username: name, coins: 0, ownedHats: ['none'] };
  users.set(name.toLowerCase(), rec);
  return rec;
}

/** A fresh CONNECTION for an account: a new socket, so greet() runs again. */
function connect(rec, room = 'plaza') {
  return {
    id: `sock${++seq}`, name: rec.username, username: rec.username,
    registered: true, room, coins: rec.coins, ws: { readyState: 1 },
  };
}

/** Log in, ask for the board, hand back the board frame. */
function login(rec, room = 'plaza') {
  const p = connect(rec, room);
  progress.handleMessage(p, { t: 'quests' });
  return { p, board: lastBoard(p.id) };
}

const lastBoard = (id) => [...out].reverse().find((m) => m.t === 'quests' && m.to === id);
const toasts = (id) => out.filter((m) => m.t === 'toast' && m.to === id);
const at = (y, mo, d, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi, 0);

// ---------------------------------------------------------------------------
// the day key: EST/EDT rollover
// ---------------------------------------------------------------------------

test('the day turns at midnight ET, which is 05:00 UTC in winter', () => {
  assert.equal(dayKey(at(2026, 1, 15, 4, 59)), '2026-01-14');
  assert.equal(dayKey(Date.UTC(2026, 0, 15, 4, 59, 59)), '2026-01-14');
  assert.equal(dayKey(Date.UTC(2026, 0, 15, 5, 0, 0)), '2026-01-15');
  assert.equal(dayKey(Date.UTC(2026, 0, 15, 5, 0, 1)), '2026-01-15');
});

test('...and 04:00 UTC in summer', () => {
  assert.equal(dayKey(Date.UTC(2026, 6, 15, 3, 59, 59)), '2026-07-14');
  assert.equal(dayKey(Date.UTC(2026, 6, 15, 4, 0, 0)), '2026-07-15');
});

test('a UTC-day rollover is NOT a quest-day rollover', () => {
  // 00:30 UTC on the 16th is still 19:30 on the 15th in the cove: prime time
  assert.equal(dayKey(Date.UTC(2026, 0, 16, 0, 30)), '2026-01-15');
  assert.equal(dayKey(Date.UTC(2026, 6, 16, 0, 30)), '2026-07-15');
});

test('dayStartMs/dayEndMs bracket the day exactly', () => {
  const noon = at(2026, 1, 15);
  assert.equal(dayStartMs(noon), Date.UTC(2026, 0, 15, 5, 0, 0));
  assert.equal(dayEndMs(noon), Date.UTC(2026, 0, 16, 5, 0, 0));
  // the boundary belongs to the NEW day, never to both
  assert.equal(dayKey(dayEndMs(noon)), '2026-01-16');
  assert.equal(dayKey(dayEndMs(noon) - 1), '2026-01-15');
  // and a start is its own start (idempotent), which the countdown relies on
  assert.equal(dayStartMs(dayStartMs(noon)), dayStartMs(noon));
});

test('prevDayKey steps back one calendar day, including across a month', () => {
  assert.equal(prevDayKey(at(2026, 1, 15)), '2026-01-14');
  assert.equal(prevDayKey(at(2026, 3, 1)), '2026-02-28');
  assert.equal(prevDayKey(at(2028, 3, 1)), '2028-02-29'); // leap year
  assert.equal(prevDayKey(at(2026, 1, 1)), '2025-12-31');
});

// ---------------------------------------------------------------------------
// the day key: DST boundaries
// ---------------------------------------------------------------------------

test('spring forward (2026-03-08) is a 23-hour day and still one quest day', () => {
  const start = dayStartMs(at(2026, 3, 8, 18));
  assert.equal(start, Date.UTC(2026, 2, 8, 5, 0, 0)); // midnight was still EST
  const end = dayEndMs(at(2026, 3, 8, 18));
  assert.equal(end, Date.UTC(2026, 2, 9, 4, 0, 0)); // midnight is now EDT
  assert.equal(end - start, 23 * HOUR);
  // 02:00-02:59 ET does not exist that morning; every instant either side is
  // still the 8th
  assert.equal(dayKey(Date.UTC(2026, 2, 8, 6, 59)), '2026-03-08'); // 01:59 EST
  assert.equal(dayKey(Date.UTC(2026, 2, 8, 7, 1)), '2026-03-08'); // 03:01 EDT
});

test('fall back (2026-11-01) is a 25-hour day and still one quest day', () => {
  const start = dayStartMs(at(2026, 11, 1, 18));
  assert.equal(start, Date.UTC(2026, 10, 1, 4, 0, 0)); // midnight was still EDT
  const end = dayEndMs(at(2026, 11, 1, 18));
  assert.equal(end, Date.UTC(2026, 10, 2, 5, 0, 0)); // midnight is now EST
  assert.equal(end - start, 25 * HOUR);
  // 01:30 ET happens twice; both are the 1st, and neither rolls the board
  assert.equal(dayKey(Date.UTC(2026, 10, 1, 5, 30)), '2026-11-01'); // 01:30 EDT
  assert.equal(dayKey(Date.UTC(2026, 10, 1, 6, 30)), '2026-11-01'); // 01:30 EST
});

test('an instant just inside a DST-shifted midnight lands on the right day', () => {
  // the classic naive-offset bug: computing the boundary with the offset at
  // NOON instead of at midnight puts these on the wrong side
  assert.equal(dayKey(Date.UTC(2026, 2, 8, 4, 59)), '2026-03-07');
  assert.equal(dayKey(Date.UTC(2026, 2, 8, 5, 1)), '2026-03-08');
  assert.equal(dayKey(Date.UTC(2026, 10, 1, 3, 59)), '2026-10-31');
  assert.equal(dayKey(Date.UTC(2026, 10, 1, 4, 1)), '2026-11-01');
});

test('every day of 2026 is exactly one key, 23-25 hours long, in order', () => {
  let cursor = dayStartMs(at(2026, 1, 1));
  let days = 0;
  let odd = 0;
  let prevKey = '';
  const stop = dayStartMs(at(2027, 1, 1));
  while (cursor < stop) {
    const key = dayKey(cursor);
    assert.equal(dayKey(cursor + 1), key, `start of ${key} belongs to itself`);
    assert.equal(dayStartMs(cursor + HOUR * 6), cursor, `midday of ${key} finds its start`);
    assert.ok(key > prevKey, `${key} follows ${prevKey}`);
    const end = dayEndMs(cursor);
    const span = end - cursor;
    assert.ok(span === 24 * HOUR || span === 23 * HOUR || span === 25 * HOUR, `${key} is ${span / HOUR}h`);
    if (span !== 24 * HOUR) odd++;
    assert.equal(prevDayKey(end), key, `${key} precedes ${dayKey(end)}`);
    prevKey = key;
    cursor = end;
    days++;
  }
  assert.equal(days, 365);
  assert.equal(odd, 2); // exactly two clock changes a year, no more, no fewer
});

// ---------------------------------------------------------------------------
// the streak, as pure arithmetic
// ---------------------------------------------------------------------------

test('a first-ever login is day 1', () => {
  assert.equal(nextStreak(0, '', at(2026, 1, 15)), 1);
  assert.equal(nextStreak(0, undefined, at(2026, 1, 15)), 1);
});

test('consecutive days climb, and the same day never double-counts', () => {
  assert.equal(nextStreak(1, '2026-01-14', at(2026, 1, 15)), 2);
  assert.equal(nextStreak(6, '2026-01-14', at(2026, 1, 15)), 7);
  assert.equal(nextStreak(30, '2026-01-14', at(2026, 1, 15)), 31); // no cap on the count
  assert.equal(nextStreak(4, '2026-01-15', at(2026, 1, 15, 23)), 4);
  assert.equal(nextStreak(4, '2026-01-15', at(2026, 1, 16, 4, 30)), 4); // 23:30 ET, same day
});

test('a gap starts the ramp over at 1, however long the gap', () => {
  assert.equal(nextStreak(6, '2026-01-13', at(2026, 1, 15)), 1);
  assert.equal(nextStreak(99, '2024-01-01', at(2026, 1, 15)), 1);
});

test('the streak survives both clock changes', () => {
  // 23-hour day: Mar 7 -> Mar 8
  assert.equal(nextStreak(3, '2026-03-07', at(2026, 3, 8, 18)), 4);
  // 25-hour day: Nov 1 -> Nov 2
  assert.equal(nextStreak(3, '2026-11-01', at(2026, 11, 2, 18)), 4);
  // and the short hop that a UTC-keyed streak would drop: 23:00 ET Oct 31,
  // then 00:30 ET Nov 1, ninety real minutes apart but two real days
  assert.equal(nextStreak(1, '2026-10-31', Date.UTC(2026, 10, 1, 4, 30)), 2);
});

test('garbage in the record cannot corrupt the streak', () => {
  assert.equal(nextStreak('3', '2026-01-14', at(2026, 1, 15)), 4); // numeric strings coerce
  assert.equal(nextStreak(NaN, '2026-01-13', at(2026, 1, 15)), 1); // gap: start over
  // a missing or nonsense streak WITH yesterday on the record rounds UP to
  // day 2: that is a record written before this wave, and the benefit of the
  // doubt always goes to the player
  assert.equal(nextStreak(NaN, '2026-01-14', at(2026, 1, 15)), 2);
  assert.equal(nextStreak(-5, '2026-01-14', at(2026, 1, 15)), 2);
  assert.equal(nextStreak(undefined, '2026-01-14', at(2026, 1, 15)), 2);
});

// ---------------------------------------------------------------------------
// the gift table
// ---------------------------------------------------------------------------

test('the gift ramps 25/35/50/65/80/100/120 and then stays there', () => {
  assert.deepEqual(STREAK_GIFTS, [25, 35, 50, 65, 80, 100, 120]);
  assert.equal(STREAK_CAP, 7);
  STREAK_GIFTS.forEach((coins, i) => assert.equal(giftFor(i + 1), coins));
  assert.equal(giftFor(7), 120);
  assert.equal(giftFor(8), 120);
  assert.equal(giftFor(365), 120); // a login is never a wage
});

test('the ramp only ever goes up, and never pays nothing', () => {
  for (let d = 1; d < 30; d++) {
    assert.ok(giftFor(d + 1) >= giftFor(d), `day ${d + 1} is not worth less than day ${d}`);
    assert.ok(giftFor(d) > 0);
  }
  assert.equal(giftFor(0), 25); // a nonsense streak still gets the warm hello
  assert.equal(giftFor(NaN), 25);
});

// ---------------------------------------------------------------------------
// the gift, end to end, on the existing frames
// ---------------------------------------------------------------------------

test('logging in pays the gift through coins + toast, with no new frame', () => {
  boot();
  const rec = account('pebble');
  const { p, board } = login(rec);

  const coinFrames = out.filter((m) => m.t === 'coins' && m.to === p.id);
  assert.equal(coinFrames.length, 1);
  assert.equal(coinFrames[0].delta, 25);
  assert.equal(rec.coins, 25);
  assert.equal(toasts(p.id).length, 1);
  assert.match(toasts(p.id)[0].msg, /25 coins/);
  // the whole conversation is frames the client already knew about
  assert.deepEqual([...new Set(out.map((m) => m.t))].sort(), ['coins', 'quests', 'toast']);
  assert.equal(board.streak.days, 1);
  assert.equal(board.streak.claimed, true);
});

test('the gift is once a real day, not once a connect', () => {
  boot();
  const rec = account('mossy');
  login(rec);
  login(rec); // reconnect an hour later
  clock += 6 * HOUR;
  login(rec); // and again that evening
  assert.equal(grants.length, 1);
  assert.equal(rec.coins, 25);
});

test('seven days running walks the whole ramp, then holds at 120', () => {
  boot();
  const rec = account('willow');
  const paid = [];
  for (let d = 0; d < 9; d++) {
    const { board } = login(rec);
    paid.push(grants[grants.length - 1].pay);
    assert.equal(board.streak.days, d + 1);
    assert.equal(board.streak.show, Math.min(d + 1, 7)); // display caps at 7+
    assert.equal(board.streak.plus, d + 1 > 7);
    clock += DAY;
  }
  assert.deepEqual(paid, [25, 35, 50, 65, 80, 100, 120, 120, 120]);
  assert.equal(rec.coins, 715);
});

test('a missed day starts the ramp over and takes NOTHING back', () => {
  boot();
  const rec = account('acorn');
  for (let d = 0; d < 5; d++) { login(rec); clock += DAY; }
  const coinsBefore = rec.coins;
  const daysBefore = rec.progress.c.days;
  assert.equal(rec.progress.c.streak, 5);
  assert.equal(rec.progress.c.bestStreak, 5);

  clock += 3 * DAY; // life happened

  const { p, board } = login(rec);
  assert.equal(board.streak.days, 1, 'the ramp restarts');
  assert.equal(grants[grants.length - 1].pay, 25);
  // the four assertions this whole feature exists to satisfy
  assert.ok(rec.coins > coinsBefore, 'coins only ever went up');
  assert.equal(rec.progress.c.days, daysBefore + 1, 'days played never resets');
  assert.equal(rec.progress.c.bestStreak, 5, 'the best streak is a high-water mark');
  assert.equal(board.streak.best, 5);
  // and the welcome does not scold
  const msg = toasts(p.id).slice(-1)[0]?.msg || '';
  assert.match(msg, /Welcome back/);
  assert.doesNotMatch(msg, /lost|broke|streak|missed|sorry/i);
});

test('a streak broken and rebuilt climbs again from 1', () => {
  boot();
  const rec = account('ripple');
  login(rec); clock += DAY;
  login(rec); clock += 4 * DAY;
  const a = login(rec).board;
  assert.equal(a.streak.days, 1);
  clock += DAY;
  const b = login(rec).board;
  assert.equal(b.streak.days, 2);
  assert.equal(grants[grants.length - 1].pay, 35);
  assert.equal(b.streak.best, 2);
});

test('a gift refused by the hourly backstop is still waiting next time', () => {
  boot();
  const rec = account('cedar');
  backstop = true;
  login(rec);
  assert.equal(grants.length, 0, 'nothing was paid');
  backstop = false;
  login(rec); // same day, later connect
  assert.equal(grants.length, 1);
  assert.equal(grants[0].pay, 25, 'day 1 was not skipped past');
  assert.equal(rec.progress.c.streak, 1);
});

test('a guest is never charged, never paid, and never crashes the board', () => {
  boot();
  const p = { id: 'guest1', name: 'Capy', registered: false, room: 'plaza', ws: { readyState: 1 } };
  progress.handleMessage(p, { t: 'quests' });
  const board = lastBoard('guest1');
  assert.equal(board.locked, true);
  assert.equal(board.quests.length, 3);
  assert.equal(board.streak.days, 0);
  assert.equal(grants.length, 0);
});

test('midnight ET rolls the board and pays the next day to a player still online', () => {
  boot(at(2026, 1, 15, 23)); // 18:00 ET
  const rec = account('lumen');
  const { p, board } = login(rec);
  assert.equal(grants.length, 1);

  clock = dayEndMs(clock) + 1000; // just past midnight ET, same session
  progress.tick(1, { aurora: false });

  assert.equal(grants.length, 2, 'the new day was gifted without a reconnect');
  assert.equal(grants[1].pay, 35);
  const fresh = lastBoard(p.id);
  assert.notEqual(fresh.day, board.day);
  assert.equal(fresh.streak.days, 2);
});

// ---------------------------------------------------------------------------
// the board on the real calendar
// ---------------------------------------------------------------------------

test('the board holds all day and rerolls exactly once, at ET midnight', () => {
  boot(at(2026, 1, 15, 10)); // 05:00 ET
  const rec = account('fern');
  const first = login(rec).board;
  const ids = first.quests.map((q) => q.id);

  for (let h = 1; h < 19; h++) { // through to 23:00 ET, same day
    clock += HOUR;
    const b = login(rec).board;
    assert.deepEqual(b.quests.map((q) => q.id), ids, `still the same jobs at hour ${h}`);
    assert.equal(b.day, first.day);
  }
  clock += 2 * HOUR; // over the boundary
  const next = login(rec).board;
  assert.notEqual(next.day, first.day);
  assert.equal(next.day, '2026-01-16');
});

test('quest progress survives the whole day and resets with the day', () => {
  boot(at(2026, 1, 15, 15));
  const rec = account('sprig');
  const { p } = login(rec);
  progress.signal('chat', p, {});
  progress.signal('chat', p, {});
  const mid = (id) => lastBoard(id).quests.find((q) => q.id === 'q_chat');
  clock += 8 * HOUR; // still the same ET day
  progress.handleMessage(p, { t: 'quests' });
  const chat = mid(p.id);
  if (chat) assert.equal(chat.progress, 2, 'a chat from this morning still counts tonight');

  clock += DAY; // now 18:00 ET on the 16th
  progress.handleMessage(p, { t: 'quests' });
  const after = lastBoard(p.id);
  assert.equal(after.day, '2026-01-16');
  assert.ok(after.quests.every((q) => q.progress === 0), 'a fresh day is a fresh board');
});

test('the countdown is seconds to ET midnight, not to the next cove sunrise', () => {
  boot(at(2026, 1, 15, 15)); // 10:00 ET, 14 hours to go
  const rec = account('juniper');
  const { board } = login(rec);
  assert.equal(board.resetIn, 14 * 3600);
  assert.ok(board.resetIn > 40 * 60, 'nowhere near a 40-minute cove day');
  assert.equal(board.ends, Date.UTC(2026, 0, 16, 5, 0, 0));
});

// ---------------------------------------------------------------------------
// day-sized quest counts
// ---------------------------------------------------------------------------

test('the board hands out day-sized asks, and says so in the same numbers', () => {
  boot();
  const rec = account('bramble');
  // walk a fortnight of boards so most of the pool has been seen at least once
  const seen = new Map();
  for (let d = 0; d < 40; d++) {
    const { board } = login(rec);
    for (const q of board.quests) seen.set(q.id, q);
    clock += DAY;
  }
  const expect = {
    q_chat: 20, q_wave: 10, q_mural: 12, q_dig: 30, q_doodle: 8,
    q_three_runs: 6, q_sled: 3, q_match: 3, q_race: 2, q_hunt: 2,
    q_tour: 5, q_gem: 1, q_race_win: 1, q_drift: 1,
  };
  let checked = 0;
  for (const [id, count] of Object.entries(expect)) {
    const q = seen.get(id);
    if (!q) continue;
    checked++;
    assert.equal(q.count, count, `${id} asks for ${count}`);
    assert.equal(q.target, count, `${id} target matches its count`);
    // the sentence on the card must agree with the number behind it
    if (count > 1 && /\b(one|a run|a round)\b/i.test(q.desc)) {
      assert.fail(`${id} still reads like a single-shot job: "${q.desc}"`);
    }
  }
  assert.ok(checked >= 6, `saw ${checked} of the scaled quests across 40 boards`);
});

test('a raised count actually has to be met before it pays', () => {
  boot();
  const rec = account('thistle');
  const { p } = login(rec);
  // force the chat quest onto the board by hand: the draw is seeded, the point
  // here is the threshold, not the shuffle. A short board would be reseeded by
  // ensureBoard, so it has to be a full three.
  rec.progress.q = [
    { id: 'q_chat', n: 0, done: 0 },
    { id: 'q_gem', n: 0, done: 0 },
    { id: 'q_drift', n: 0, done: 0 },
  ];
  rec.progress.day = dayKey(clock);
  const before = rec.coins;
  for (let i = 0; i < 19; i++) progress.signal('chat', p, {});
  assert.equal(rec.coins, before, 'nineteen is not twenty');
  assert.equal(rec.progress.q[0].done, 0);
  progress.signal('chat', p, {});
  assert.equal(rec.progress.q[0].done, 1);
  assert.ok(rec.coins > before, 'the twentieth pays');
});

test('clearing the whole board pays the daily bonus once', () => {
  boot();
  const rec = account('clover');
  const { p } = login(rec);
  rec.progress.q = [
    { id: 'q_wave', n: 0, done: 0 },
    { id: 'q_drift', n: 0, done: 0 },
    { id: 'q_gem', n: 0, done: 0 },
  ];
  rec.progress.day = dayKey(clock);
  rec.progress.bonus = 0;
  for (let i = 0; i < 10; i++) progress.signal('wave', p, {});
  p.room = 'drift';
  progress.signal('room', p, { room: 'drift' });
  progress.signal('dig', p, { gem: true });
  const all = out.filter((m) => m.t === 'quest-done' && m.all);
  assert.equal(all.length, 1);
  assert.equal(all[0].coins, 100);
  assert.equal(rec.progress.c.questDays, 1);
  // and it cannot be farmed twice in the same day
  progress.signal('wave', p, {});
  assert.equal(out.filter((m) => m.t === 'quest-done' && m.all).length, 1);
});

// ---------------------------------------------------------------------------
// durability
// ---------------------------------------------------------------------------

test('a record from before the wave upgrades without losing anything', () => {
  boot();
  const rec = account('elder');
  // the old shape: a numeric cove-day index and a UTC lastDate
  rec.coins = 4000;
  rec.progress = {
    day: 1234567,
    q: [{ id: 'q_chat', n: 3, done: 0 }],
    bonus: 0,
    stamps: { first_hello: 1, explorer: 2 },
    mile: 0,
    c: { chats: 40, days: 9, lastDate: '2026-01-14' },
  };
  const { board } = login(rec);
  assert.equal(board.day, '2026-01-15', 'the day key is now a calendar day');
  assert.equal(board.quests.length, 3);
  assert.equal(rec.progress.c.days, 10, 'days played carried over and counted today');
  assert.equal(rec.progress.c.streak, 2, 'yesterday in the old key still reads as yesterday');
  assert.equal(Object.keys(rec.progress.stamps).length >= 2, true, 'stamps are untouched');
  assert.ok(rec.coins >= 4000 + 35, 'the upgrade paid, it did not take');
});

test('a hand-mangled progress blob cannot crash the board', () => {
  boot();
  const rec = account('grit');
  rec.progress = { day: {}, q: 'nope', stamps: 7, c: { days: 'lots', streak: [], lastDate: 42 } };
  const { board } = login(rec);
  assert.equal(board.quests.length, 3);
  assert.equal(board.streak.days, 1);
  assert.ok(Number.isFinite(board.resetIn));
});
