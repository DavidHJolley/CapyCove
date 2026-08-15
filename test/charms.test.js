/**
 * test/charms.test.js — the weekly charm hunt (wave 13E, N-30).
 *
 *   node --test test/charms.test.js
 *
 * server/charms.js is imported DIRECTLY with a fake ctx and a FAKE CLOCK, so a
 * whole year of weeks (including both DST weekends) passes in a millisecond.
 * Nothing here boots a server or opens a socket.
 *
 * Four things are being pinned down, in rough order of "how badly does this
 * hurt if it is wrong":
 *
 *  1. THE WEEK. It is a real Monday-to-Monday week in America/New_York, derived
 *     from server/progress.js's dayKey(), which means the two weeks a year that
 *     are 167 and 169 hours long have to come out right. A countdown that lies
 *     on a Sunday night lies at exactly the moment somebody is racing it.
 *
 *  2. THE CLAIM. Server-authoritative: right room, close enough, one per
 *     ACCOUNT per week, and a guest gets a warm invitation rather than a wall.
 *
 *  3. NOTHING IS EVER TAKEN AWAY. Missing a week costs nothing, the charm board
 *     only grows, and a charm survives an economy backstop that refuses the
 *     coins. Half the assertions here exist to prove a number did NOT go down.
 *
 *  4. THE TOUR. Seven weeks, seven rooms, never the same room twice running:
 *     the hunt's whole job as a world-tour driver is in that one property.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as charms from '../server/charms.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let clock = Date.UTC(2026, 7, 12, 16, 0, 0); // Wed 2026-08-12, noon ET
let users;
let out;       // every frame sent to any player, in order
let bcast;     // every island-wide broadcast
let rooms;     // every per-room broadcast: [roomId, frame]
let grants;    // every grantCoins call
let saves;
let backstop;  // when true, grantCoins pays nothing (the hourly ceiling)
let caps;      // player name (lower) -> capability list

function boot(at = Date.UTC(2026, 7, 12, 16, 0, 0), opts = {}) {
  clock = at;
  users = new Map();
  out = [];
  bcast = [];
  rooms = [];
  grants = [];
  saves = 0;
  backstop = false;
  caps = new Map();
  charms.install({
    now: () => clock,
    file: opts.file === undefined ? null : opts.file, // null = never touch disk
    users,
    saveSoon: () => { saves++; },
    sendTo: (p, m) => { out.push({ to: p.id, ...m }); },
    broadcastAll: (m) => { bcast.push(m); },
    broadcastToRoom: (room, m) => { rooms.push([room, m]); },
    recordFor: (p) => (p.username ? users.get(p.username.toLowerCase()) || null : null),
    grantCoins: (p, amount, reason) => {
      const pay = backstop ? 0 : Math.max(0, Math.floor(Number(amount) || 0));
      grants.push({ name: p.name, amount, reason, paid: pay });
      if (pay) {
        const rec = users.get(String(p.username || '').toLowerCase());
        if (rec) rec.coins = (rec.coins || 0) + pay;
        p.coins = (p.coins || 0) + pay;
      }
      return pay;
    },
    requireCap: (p, cap) => (caps.get(String(p.name || '').toLowerCase()) || []).includes(cap),
    audit: () => {},
  });
}

let nextId = 1;
/** A registered player standing wherever you put them. */
function account(name, room = 'plaza', x = 0, z = 0, y = 0) {
  const key = name.toLowerCase();
  if (!users.has(key)) users.set(key, { uid: `u_${key}`, username: name, coins: 0 });
  return {
    id: `p${nextId++}`, name, username: name, registered: true, room, x, y, z, coins: 0,
  };
}
/** A guest: same shape, no record. */
function guest(name, room = 'plaza', x = 0, z = 0) {
  return { id: `p${nextId++}`, name, registered: false, room, x, y: 0, z, coins: 0 };
}

/** Put a player exactly on this week's charm. */
function standOnIt(p, ms = clock) {
  const cur = charms.currentCharm(ms);
  p.room = cur.room;
  p.x = cur.x;
  p.z = cur.z;
  p.y = cur.y === null ? 0 : cur.y;
  return cur;
}

const last = (t) => [...out].reverse().find((m) => m.t === t) || null;

// ---------------------------------------------------------------------------
// 1. the week
// ---------------------------------------------------------------------------

test('the week is a real Monday-to-Monday week in America/New_York', () => {
  boot();
  // 2026-08-12 is a Wednesday; its week opened Monday 2026-08-10.
  assert.equal(charms.weekKey(Date.UTC(2026, 7, 12, 16)), '2026-08-10');
  // Sunday 23:59 ET is still the SAME week...
  assert.equal(charms.weekKey(Date.UTC(2026, 7, 17, 3, 59)), '2026-08-10');
  // ...and one minute later (Monday 00:01 ET) it is the next one.
  assert.equal(charms.weekKey(Date.UTC(2026, 7, 17, 4, 1)), '2026-08-17');
  // A Monday is the first day of its own week, not the last of the previous.
  assert.equal(charms.weekKey(Date.UTC(2026, 7, 17, 16)), '2026-08-17');
});

test('every day of a week reports the same week key, and the index moves by one', () => {
  boot();
  const start = Date.UTC(2026, 7, 10, 16); // Monday noon ET
  for (let d = 0; d < 7; d++) {
    assert.equal(charms.weekKey(start + d * DAY), '2026-08-10', `day ${d}`);
  }
  assert.equal(charms.weekIndex(start + 7 * DAY), charms.weekIndex(start) + 1);
});

test('the week end is the next ET Monday midnight, across both DST weekends', () => {
  boot();
  // Spring forward: 2026-03-08. The week 2026-03-02..03-08 is 167 hours long.
  const spring = Date.UTC(2026, 2, 4, 17); // Wed 2026-03-04, noon ET (EST)
  assert.equal(charms.weekKey(spring), '2026-03-02');
  const springEnd = charms.weekEndMs(spring);
  assert.equal(charms.weekKey(springEnd), '2026-03-09');       // the next week
  assert.equal(charms.weekKey(springEnd - 1), '2026-03-02');   // and not a ms sooner
  assert.equal(springEnd, Date.UTC(2026, 2, 9, 4));            // EDT midnight

  // Fall back: 2026-11-01. The week 2026-10-26..11-01 is 169 hours long.
  const fall = Date.UTC(2026, 9, 28, 16);
  assert.equal(charms.weekKey(fall), '2026-10-26');
  const fallEnd = charms.weekEndMs(fall);
  assert.equal(charms.weekKey(fallEnd), '2026-11-02');
  assert.equal(charms.weekKey(fallEnd - 1), '2026-10-26');
  assert.equal(fallEnd, Date.UTC(2026, 10, 2, 5));             // EST midnight
});

// ---------------------------------------------------------------------------
// 2. placement and the tour
// ---------------------------------------------------------------------------

test('placement is pure: same week, same answer, every time', () => {
  boot();
  const a = charms.currentCharm(Date.UTC(2026, 7, 10, 16));
  const b = charms.currentCharm(Date.UTC(2026, 7, 16, 3)); // Sunday night, same week
  assert.equal(a.week, b.week);
  assert.equal(a.room, b.room);
  assert.equal(a.spot, b.spot);
  assert.equal(a.charm, b.charm);
});

test('seven weeks tour seven different rooms and never repeat back to back', () => {
  boot();
  const seen = [];
  for (let w = 0; w < 7; w++) seen.push(charms.currentCharm(Date.UTC(2026, 7, 10, 16) + w * 7 * DAY).room);
  assert.equal(new Set(seen).size, 7, `all seven rooms in seven weeks: ${seen.join(', ')}`);
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  // and it keeps going: a whole year never repeats a room in consecutive weeks
  let prev = '';
  for (let w = 0; w < 52; w++) {
    const r = charms.currentCharm(Date.UTC(2026, 0, 5, 17) + w * 7 * DAY).room;
    assert.notEqual(r, prev, `week ${w}`);
    prev = r;
  }
});

test('the spot table ships at least three spots per room, all well formed', () => {
  boot();
  assert.ok(charms.ROOMS.length >= 6);
  const ids = new Set();
  for (const room of charms.ROOMS) {
    assert.ok(room.spots.length >= 3, `${room.id} has ${room.spots.length} spots`);
    assert.ok(typeof room.hint === 'string' && room.hint.length > 10, `${room.id} needs a rumour`);
    for (const s of room.spots) {
      const key = `${room.id}/${s.id}`;
      assert.ok(!ids.has(key), `duplicate spot ${key}`);
      ids.add(key);
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z), key);
      assert.ok(Math.hypot(s.x, s.z) < 30, `${key} is off the map`);
      if (s.y !== undefined) assert.ok(Number.isFinite(s.y), key);
    }
  }
  // every catalogue entry is usable by the renderer
  for (const c of charms.CATALOG) {
    assert.ok(c.id && c.name && c.desc, JSON.stringify(c));
    assert.equal(typeof c.color, 'number');
  }
});

// ---------------------------------------------------------------------------
// 3. the claim
// ---------------------------------------------------------------------------

test('a claim from the right spot pays coins, writes the charm and celebrates', () => {
  boot();
  const p = account('Pip');
  const cur = standOnIt(p);

  assert.equal(charms.handleMessage(p, { t: 'charm-claim' }), true);

  const rec = users.get('pip');
  assert.equal(rec.charms.length, 1);
  assert.equal(rec.charms[0].id, cur.charm);
  assert.equal(rec.charms[0].week, cur.week);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].paid, charms.CLAIM_COINS);
  assert.equal(rec.coins, charms.CLAIM_COINS);
  assert.ok(saves > 0, 'the find is persisted');

  const found = bcast.find((m) => m.t === 'charm-found');
  assert.ok(found, 'the island hears about it');
  assert.equal(found.name, 'Pip');
  assert.equal(found.charm, cur.charm);
  assert.equal(found.room, cur.room);
  assert.equal(found.first, true);

  const state = last('charm');
  assert.equal(state.ok, true);
  assert.equal(state.claimed, true);
  assert.equal(state.here, false, 'nothing left to draw once it is yours');
  assert.equal(state.charmCount, 1);
});

test('the wrong room and the right room from too far away are both refused, warmly', () => {
  boot();
  const cur = charms.currentCharm(clock);
  const elsewhere = charms.ROOMS.find((r) => r.id !== cur.room).id;

  const a = account('Nim', elsewhere, cur.x, cur.z);
  charms.handleMessage(a, { t: 'charm-claim' });
  assert.equal(users.get('nim').charms, undefined);

  const b = account('Bo', cur.room, cur.x + 9, cur.z + 9);
  charms.handleMessage(b, { t: 'charm-claim' });
  assert.ok(!users.get('bo').charms?.length);
  const toast = [...out].reverse().find((m) => m.t === 'toast' && m.to === b.id);
  assert.match(toast.msg, /closer/i);
  assert.equal(grants.length, 0, 'no coins for either');

  // and one step inside the radius works
  b.x = cur.x + 2;
  b.z = cur.z;
  charms.handleMessage(b, { t: 'charm-claim' });
  assert.equal(users.get('bo').charms.length, 1);
});

test('a guest is invited, not blocked: no claim, no penalty, charm still there', () => {
  boot();
  const g = guest('Wanderer');
  standOnIt(g);
  charms.handleMessage(g, { t: 'charm-claim' });

  const toast = last('toast');
  assert.match(toast.msg, /account/i);
  assert.doesNotMatch(toast.msg, /cannot|can't|not allowed|denied/i);
  assert.equal(grants.length, 0);
  assert.equal(bcast.length, 0, 'no celebration for a claim that did not happen');

  // the charm is still on offer to them
  out.length = 0;
  charms.handleMessage(g, { t: 'charm' });
  const state = last('charm');
  assert.equal(state.here, true);
  assert.equal(state.guest, true);
  assert.equal(state.claimed, false);
});

test('one claim per ACCOUNT per week, even from two sessions', () => {
  boot();
  const s1 = account('Twin');
  const s2 = { ...account('Twin'), id: 'p-second' }; // same record, second socket
  standOnIt(s1);
  standOnIt(s2);

  charms.handleMessage(s1, { t: 'charm-claim' });
  charms.handleMessage(s2, { t: 'charm-claim' });

  assert.equal(users.get('twin').charms.length, 1);
  assert.equal(grants.length, 1);
  assert.equal(bcast.filter((m) => m.t === 'charm-found').length, 1);
  const toast = [...out].reverse().find((m) => m.t === 'toast' && m.to === 'p-second');
  assert.match(toast.msg, /already found/i);
});

test('next week is a new charm, and last week is never taken back', () => {
  boot();
  const p = account('Ro');
  const first = standOnIt(p);
  charms.handleMessage(p, { t: 'charm-claim' });
  assert.equal(users.get('ro').charms.length, 1);

  // ...three quiet weeks go by with nobody logging in. Nothing is lost.
  clock += 21 * DAY;
  assert.equal(users.get('ro').charms.length, 1, 'a missed week takes nothing back');
  assert.equal(users.get('ro').coins, charms.CLAIM_COINS);

  const later = standOnIt(p);
  assert.notEqual(later.week, first.week);
  charms.handleMessage(p, { t: 'charm-claim' });
  const board = users.get('ro').charms;
  assert.equal(board.length, 2);
  assert.equal(board[0].week, first.week, 'the board only ever grows');
  assert.equal(board[1].week, later.week);
});

test('the charm survives the economy backstop refusing the coins', () => {
  boot();
  backstop = true;
  const p = account('Skint');
  standOnIt(p);
  charms.handleMessage(p, { t: 'charm-claim' });
  assert.equal(users.get('skint').charms.length, 1, 'the trinket is never lost to a ceiling');
  assert.equal(grants[0].paid, 0);
  const toast = last('toast');
  assert.doesNotMatch(toast.msg, /\+0 coins/);
});

test('claims are rate limited and nothing else is consumed', () => {
  boot();
  const p = account('Spammy');
  standOnIt(p);
  for (let i = 0; i < 30; i++) charms.handleMessage(p, { t: 'charm-claim' });
  assert.equal(users.get('spammy').charms.length, 1);
  assert.equal(grants.length, 1);

  out.length = 0;
  for (let i = 0; i < 30; i++) charms.handleMessage(p, { t: 'charm' });
  assert.ok(out.filter((m) => m.t === 'charm').length <= 5, 'reads are burst limited');

  // frames that are not ours fall straight through
  for (const t of ['move', 'chat', 'score', 'a-who', 'quests', 'kart-join']) {
    assert.equal(charms.handleMessage(p, { t }), false, t);
  }
});

// ---------------------------------------------------------------------------
// 4. the profile ride-along
// ---------------------------------------------------------------------------

test('profileBits hands out copies, and an empty record reads as an empty board', () => {
  boot();
  assert.deepEqual(charms.profileBits(null), { charms: [], charmCount: 0 });
  const p = account('Card');
  standOnIt(p);
  charms.handleMessage(p, { t: 'charm-claim' });

  const rec = users.get('card');
  const bits = charms.profileBits(rec);
  assert.equal(bits.charmCount, 1);
  assert.equal(bits.charms[0].name, charms.currentCharm(clock).name);
  bits.charms.push({ id: 'forged' });
  bits.charms[0].name = 'tampered';
  assert.equal(rec.charms.length, 1, 'the record is untouched by a mutated copy');
  assert.notEqual(rec.charms[0].name, 'tampered');
});

test('a long board rides a card newest-first, trimmed, with an exact count', () => {
  boot();
  const rec = { uid: 'u_old', username: 'Old', coins: 0, charms: [] };
  for (let i = 0; i < 60; i++) rec.charms.push({ id: `c${i}`, name: `Charm ${i}`, week: `w${i}`, at: i });
  const bits = charms.profileBits(rec);
  assert.equal(bits.charmCount, 60, 'the count is the whole history');
  assert.ok(bits.charms.length < 60 && bits.charms.length >= 12, 'the list is trimmed for the wire');
  assert.equal(bits.charms[0].id, 'c59', 'newest first');
  assert.equal(charms.profileBits(rec, { limit: 0 }).charms.length, 60, 'the full board is available on request');
});

test('the position is only ever sent to somebody standing in the room', () => {
  boot();
  const cur = charms.currentCharm(clock);
  const away = account('Far', charms.ROOMS.find((r) => r.id !== cur.room).id);
  charms.handleMessage(away, { t: 'charm' });
  const m = last('charm');
  assert.equal(m.here, false);
  assert.equal(m.x, undefined);
  assert.equal(m.room, undefined);
  assert.ok(m.hint.length > 10, 'but the rumour is always told');
  assert.equal(m.name, cur.name);

  out.length = 0;
  const near = account('Near', cur.room, 0, 0);
  charms.handleMessage(near, { t: 'charm' });
  const n = last('charm');
  assert.equal(n.here, true);
  assert.equal(n.x, cur.x);
  assert.equal(n.z, cur.z);
});

// ---------------------------------------------------------------------------
// 5. the operator surface
// ---------------------------------------------------------------------------

test('a-charm says nothing at all to a player with no capabilities', () => {
  boot();
  const p = account('Nosy');
  assert.equal(charms.handleMessage(p, { t: 'a-charm', op: 'where' }), true, 'consumed');
  assert.equal(out.length, 0, 'a probe gets silence, not a hint');
});

test('a mod may look; only an editor may move it', () => {
  boot();
  const mod = account('Mo');
  caps.set('mo', ['who', 'inspect', 'mute']);
  charms.handleMessage(mod, { t: 'a-charm', op: 'where' });
  const ok = last('a-ok');
  assert.equal(ok.room, charms.currentCharm(clock).room);

  charms.handleMessage(mod, { t: 'a-charm', op: 'place', room: 'beach', spot: 'dock-plank' });
  const err = last('a-err');
  assert.equal(err.code, 'cap');
  assert.equal(charms.currentCharm(clock).override, false);
});

test('an admin places the charm, and the claim follows it to the new spot', () => {
  boot();
  const admin = account('Dee');
  caps.set('dee', ['who', 'editor']);

  charms.handleMessage(admin, { t: 'a-charm', op: 'place', room: 'beach', spot: 'dock-plank', charm: 'pearl' });
  const cur = charms.currentCharm(clock);
  assert.equal(cur.room, 'beach');
  assert.equal(cur.spot, 'dock-plank');
  assert.equal(cur.charm, 'pearl');
  assert.equal(cur.override, true);
  assert.ok(rooms.some(([, m]) => m.t === 'charm' && m.refresh), 'live players are nudged');

  const p = account('Finder', 'beach', cur.x, cur.z);
  charms.handleMessage(p, { t: 'charm-claim' });
  assert.equal(users.get('finder').charms[0].id, 'pearl');

  // bad arguments are refused with a helpful sentence, not a stack trace
  charms.handleMessage(admin, { t: 'a-charm', op: 'place', room: 'atlantis', spot: 'x' });
  assert.match(last('a-err').msg, /No such room/);
  charms.handleMessage(admin, { t: 'a-charm', op: 'place', room: 'beach', spot: 'nowhere' });
  assert.match(last('a-err').msg, /No such spot/);
});

test('next rotates within the room, and clear puts the derived placement back', () => {
  boot();
  const admin = account('Dee');
  caps.set('dee', ['who', 'editor']);
  const derived = charms.currentCharm(clock);

  charms.handleMessage(admin, { t: 'a-charm', op: 'next' });
  const moved = charms.currentCharm(clock);
  assert.equal(moved.room, derived.room, 'same room');
  assert.notEqual(moved.spot, derived.spot, 'different spot');
  assert.equal(moved.charm, derived.charm, 'same charm');

  charms.handleMessage(admin, { t: 'a-charm', op: 'clear' });
  const back = charms.currentCharm(clock);
  assert.equal(back.spot, derived.spot);
  assert.equal(back.override, false);
});

test('an admin can schedule a future week without disturbing this one', () => {
  boot();
  const admin = account('Dee');
  caps.set('dee', ['who', 'editor']);
  const thisWeek = charms.currentCharm(clock);
  const nextWeek = charms.weekKey(clock + 7 * DAY);

  charms.handleMessage(admin, { t: 'a-charm', op: 'place', week: nextWeek, room: 'jungle', spot: 'drum-log' });
  assert.equal(charms.currentCharm(clock).spot, thisWeek.spot, 'today is untouched');
  const future = charms.currentCharm(clock + 7 * DAY);
  assert.equal(future.week, nextWeek);
  assert.equal(future.room, 'jungle');
  assert.equal(future.spot, 'drum-log');
});

test('placements survive a restart, and a corrupt file is ignored rather than fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-charms-'));
  const file = path.join(dir, 'charms.json');
  try {
    boot(Date.UTC(2026, 7, 12, 16), { file });
    const admin = account('Dee');
    caps.set('dee', ['who', 'editor']);
    charms.handleMessage(admin, { t: 'a-charm', op: 'place', room: 'peak', spot: 'sled-rack' });
    assert.ok(fs.existsSync(file));

    boot(Date.UTC(2026, 7, 12, 16), { file }); // "restart"
    assert.equal(charms.currentCharm(clock).spot, 'sled-rack');

    fs.writeFileSync(file, '{ this is not json');
    boot(Date.UTC(2026, 7, 12, 16), { file });
    assert.equal(charms.currentCharm(clock).override, false, 'falls back to the derived spot');

    fs.writeFileSync(file, JSON.stringify({ v: 1, weeks: { '2026-08-10': { room: 'atlantis', spot: 'nope' } } }));
    boot(Date.UTC(2026, 7, 12, 16), { file });
    assert.equal(charms.currentCharm(clock).override, false, 'a bogus room is dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throw inside a handler is contained, and the frame is still consumed', () => {
  boot();
  const p = account('Odd');
  standOnIt(p);
  charms.install({
    now: () => clock,
    file: null,
    users,
    recordFor: () => { throw new Error('boom'); },
    sendTo: (q, m) => { out.push({ to: q.id, ...m }); },
  });
  assert.equal(charms.handleMessage(p, { t: 'charm' }), true);
  assert.equal(charms.handleMessage(p, { t: 'charm-claim' }), true);
  assert.equal(charms.stats().errors > 0, true);
});
