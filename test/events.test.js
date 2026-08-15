/**
 * server/events.js: the calendar bus (wave 13A).
 *
 *   node --test test/
 *
 * Four things are being pinned down, and every one of them is a thing that
 * would be discovered in production otherwise:
 *
 *  1. ANCHOR MATH ACROSS DST. The weekly anchors are Friday 8pm and Sunday 3pm
 *     America/New_York, and "8pm" has to mean 8pm on the two weekends a year
 *     the US moves its clocks. The naive "midnight plus twenty hours" answer is
 *     wrong by an hour on both of them, which is exactly the kind of quiet
 *     wrongness nobody notices until an event starts at seven.
 *
 *  2. SHADOW-PARSE-AND-SWAP. A broken calendar edit must NEVER take the live
 *     calendar down. The test corrupts the file mid-flight and asserts that the
 *     previous calendar is still running, still paying, still framed.
 *
 *  3. THE VERB CLAMPS, and one of them is the owner's law: a `coins.mult` below
 *     1.0 is REFUSED at load. There is no calendar edit, and no admin op, that
 *     can make an honest payout smaller. The mural verb is checked the same way
 *     (it may only ever shorten a cooldown).
 *
 *  4. The admin ops are gated on the REAL role through admin.js's requireCap,
 *     and a player probing them gets silence.
 *
 * Everything runs against a throwaway COVE_DATA_DIR with the fs watcher off and
 * an injected clock, so a year of Fridays costs a millisecond and nothing here
 * boots a server or opens a socket. db.js and admin.js are the real modules, so
 * the capability check exercised here is the one that ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-events-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const events = await import('../server/events.js');
const admin = await import('../server/admin.js');
const db = await import('../server/db.js');

const CAL = path.join(SANDBOX, 'calendar.json');
const ONEOFFS = path.join(SANDBOX, 'events-oneoffs.json');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let clock = Date.UTC(2026, 0, 14, 17, 0, 0); // Wed 2026-01-14, noon ET
let sent = [];       // every frame sent to one connection
let broadcast = [];  // every frame sent to the whole island
let audited = [];

function write(doc) {
  fs.writeFileSync(CAL, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

/** The starter calendar's two anchors, as a test fixture. */
function anchors(extra = []) {
  return {
    version: 1,
    tz: 'America/New_York',
    events: [
      {
        id: 'friday-fete',
        name: 'Friday Fete',
        blurb: 'Every game pays one and a half.',
        icon: 'coin',
        when: { rrule: 'FRI', start: '20:00', durMin: 60 },
        rooms: ['*'],
        effects: { coins: { mult: 1.5, games: '*' }, decorate: { plaza: 'bunting' } },
        announce: { leadMin: 10, startMsg: 'Friday Fete!', endMsg: 'The Fete is over.' },
      },
      {
        id: 'sunday-splash',
        name: 'Sunday Splash',
        when: { rrule: 'SUN', start: '15:00', durMin: 120 },
        rooms: ['drift', 'beach'],
        effects: {
          decorate: { drift: 'splash-buoys' },
          spotlight: 'fishing',
          doubleStamps: true,
          flag: { 'drift.bigblue.surface': 'often' },
        },
      },
      ...extra,
    ],
    oneoffs: [],
  };
}

function boot(doc = anchors(), at = clock) {
  clock = at;
  sent = [];
  broadcast = [];
  audited = [];
  write(doc);
  try { fs.unlinkSync(ONEOFFS); } catch { /* first run */ }
  events.install({
    now: () => clock,
    sendTo: (p, m) => sent.push({ to: p.id, ...m }),
    broadcastAll: (m) => broadcast.push(m),
    recordFor: (p) => (p.username ? db.users.get(String(p.username).toLowerCase()) || null : null),
    audit: (entry) => audited.push(entry),
    file: CAL,
    oneoffFile: ONEOFFS,
    watch: false, // the mtime backstop in tick() is what the reload tests drive
  });
}

let seq = 0;
function mkRec(username, role = 'player') {
  db.users.set(username.toLowerCase(), { username, role, coins: 0, created: Date.now() });
  return db.users.get(username.toLowerCase());
}
const conn = (name, rec) => ({
  id: `p${++seq}`,
  ws: { readyState: 1 },
  bot: false,
  registered: !!rec,
  username: rec ? rec.username : null,
  name,
});

// admin.js needs its own ctx for actorFrom's record lookup.
const adminRec = mkRec('DavidEdge', 'admin');
const modRec = mkRec('Modsy', 'mod');
const playerRec = mkRec('Norm', 'player');
const world = { players: new Map(), rooms: new Map() };
admin.install({
  users: db.users,
  saveSoon: () => {},
  sendTo: () => {},
  broadcastToRoom: () => {},
  broadcastAll: () => {},
  sessionsFor: () => [],
  recordFor: (p) => (p.username ? db.users.get(String(p.username).toLowerCase()) || null : null),
  findEntity: () => null,
  world,
  has: () => false,
  audit: () => {},
});

const HOUR = 3_600_000;
const MIN = 60_000;
const utc = (...a) => Date.UTC(...a);
/** A Wednesday lunchtime: nothing on the calendar is running. */
const QUIET = Date.UTC(2026, 0, 14, 17, 0, 0);

// ---------------------------------------------------------------------------
// 1. anchor math, including the two DST weekends
// ---------------------------------------------------------------------------

test('Friday 8pm ET is 8pm ET in January and in July', () => {
  boot();
  // 2026-01-16 is a Friday. 20:00 EST (UTC-5) = 2026-01-17 01:00 UTC.
  const winter = events.occurrencesOf('friday-fete', utc(2026, 0, 16, 12));
  assert.ok(winter.some((o) => o.startMs === utc(2026, 0, 17, 1, 0)), 'winter anchor is 01:00 UTC');
  // 2026-07-17 is a Friday. 20:00 EDT (UTC-4) = 2026-07-18 00:00 UTC.
  const summer = events.occurrencesOf('friday-fete', utc(2026, 6, 17, 12));
  assert.ok(summer.some((o) => o.startMs === utc(2026, 6, 18, 0, 0)), 'summer anchor is 00:00 UTC');
});

test('spring forward: the Sunday 3pm anchor is 3pm EDT, not 2pm', () => {
  boot();
  // 2026-03-08: the US springs forward at 02:00 local. The ET day is 23 hours
  // long, so "midnight + 15h" would land at 14:00 EDT. It must be 15:00 EDT,
  // which is 19:00 UTC.
  const occ = events.occurrencesOf('sunday-splash', utc(2026, 2, 8, 12));
  const hit = occ.find((o) => o.startMs >= utc(2026, 2, 8) && o.startMs < utc(2026, 2, 9));
  assert.ok(hit, 'the transition Sunday still has an occurrence');
  assert.equal(hit.startMs, utc(2026, 2, 8, 19, 0), '3pm EDT = 19:00 UTC');
  assert.equal(hit.endMs - hit.startMs, 120 * MIN, 'a two-hour event is still two hours');
});

test('fall back: the Sunday 3pm anchor is 3pm EST, not 4pm', () => {
  boot();
  // 2026-11-01: the clocks fall back at 02:00 local, the ET day is 25 hours
  // long, and 15:00 EST is 20:00 UTC.
  const occ = events.occurrencesOf('sunday-splash', utc(2026, 10, 1, 12));
  const hit = occ.find((o) => o.startMs >= utc(2026, 10, 1) && o.startMs < utc(2026, 10, 2, 6));
  assert.ok(hit, 'the transition Sunday still has an occurrence');
  assert.equal(hit.startMs, utc(2026, 10, 1, 20, 0), '3pm EST = 20:00 UTC');
});

test('a pre-2am anchor on a transition day keeps the OLD offset', () => {
  boot();
  // 01:00 on 2026-03-08 happens before the jump, so it is 01:00 EST = 06:00 UTC.
  assert.equal(events.wallInstant(utc(2026, 2, 8, 12), 1, 0), utc(2026, 2, 8, 6, 0));
  // ...and 03:00 the same morning is already EDT = 07:00 UTC.
  assert.equal(events.wallInstant(utc(2026, 2, 8, 12), 3, 0), utc(2026, 2, 8, 7, 0));
});

test('a weekly anchor happens once a week, on the right weekday, all year', () => {
  boot();
  // Walk fourteen months of Fridays through the DST boundaries in both
  // directions and assert every occurrence is a Friday at 20:00 ET.
  let checked = 0;
  for (let d = 0; d < 420; d += 7) {
    const at = utc(2026, 0, 16, 12) + d * 24 * HOUR;
    const occ = events.occurrencesOf('friday-fete', at);
    for (const o of occ) {
      // 20:00 ET is 00:00 or 01:00 UTC the following day, always.
      const hourUTC = new Date(o.startMs).getUTCHours();
      assert.ok(hourUTC === 0 || hourUTC === 1, `unexpected UTC hour ${hourUTC}`);
      assert.equal(new Date(o.startMs - 4 * HOUR).getUTCDay(), 5, 'still a Friday evening in ET');
      checked++;
    }
  }
  assert.ok(checked > 60, `expected a lot of Fridays, saw ${checked}`);
});

// ---------------------------------------------------------------------------
// 2. hot reload: shadow parse and swap
// ---------------------------------------------------------------------------

test('a corrupt calendar NEVER takes the live calendar down', () => {
  boot();
  const before = events.calendar();
  assert.equal(before.events.length, 2);

  // Truncated JSON: exactly what a save-mid-edit looks like.
  write('{ "version": 1, "events": [ { "id": "oops",');
  const ok = events.load('test');
  assert.equal(ok, false, 'the load is refused');

  const after = events.calendar();
  assert.equal(after.events.length, 2, 'the last good calendar is still running');
  assert.equal(after.rev, before.rev, 'no revision was published');
  assert.match(events.eventStats().error, /JSON/i, 'and the failure is recorded for the operator');
  assert.equal(events.eventStats().loadFails, 1);

  // The world still works while the file is broken.
  const f = events.frame();
  assert.equal(f.t, 'events');
  assert.ok(Array.isArray(f.active));

  // Fix the file: the swap happens on the next read, no restart.
  write(anchors());
  assert.equal(events.load('test'), true);
  assert.equal(events.calendar().rev, before.rev + 1, 'a good save publishes a revision');
});

test('a calendar that is not an object, or has no events array, is refused', () => {
  boot();
  for (const bad of ['[]', '"nope"', '{"version":1}', 'null', '']) {
    write(bad);
    assert.equal(events.load('test'), false, `refused: ${bad}`);
    assert.equal(events.calendar().events.length, 2, 'still serving the good one');
  }
});

test('one bad event does not cost the calendar its good ones', () => {
  boot(anchors([
    { id: 'broken', name: 'No when', effects: {} },
    { id: 'friday-fete', name: 'Duplicate id' },
    { name: 'no id at all', when: { rrule: 'MON', start: '10:00', durMin: 5 } },
  ]));
  const cal = events.calendar();
  assert.equal(cal.events.length, 2, 'the two anchors survived');
  assert.ok(cal.warnings.length >= 2, 'and the operator was told about each drop');
});

test('the tick mtime backstop reloads an edit even with no fs watcher', () => {
  boot();
  const rev = events.calendar().rev;
  const doc = anchors();
  doc.events[0].name = 'Friday Fete (renamed)';
  write(doc);
  // A fresh write inside the same millisecond can carry the same mtime on some
  // filesystems; nudge it so the backstop has something to see.
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(CAL, t, t);
  clock += 10_000;
  events.tick(clock);
  assert.equal(events.calendar().rev, rev + 1);
  assert.equal(events.calendar().events[0].name, 'Friday Fete (renamed)');
});

// ---------------------------------------------------------------------------
// 3. the verb clamps, and the no-punish law
// ---------------------------------------------------------------------------

/** Noon on Friday 2026-01-16, ET -> inside the Fete when +8h30m. */
const FETE_AT = utc(2026, 0, 17, 1, 30); // 20:30 ET Friday

test('coins.mult below 1.0 is REFUSED at load (the no-punish law)', () => {
  boot(anchors([{
    id: 'bad-friday',
    name: 'Half Pay',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: { coins: { mult: 0.5, games: '*' } },
  }]), FETE_AT);

  const cal = events.calendar();
  const bad = cal.events.find((e) => e.id === 'bad-friday');
  assert.ok(bad, 'the event still loads');
  assert.equal(bad.effects.coins, undefined, 'but its coins verb was dropped');
  assert.ok(cal.warnings.some((w) => /REFUSED/.test(w)), 'loudly');

  // And the live multiplier is the Fete's 1.5, never 0.75.
  assert.equal(events.coinMult(null, 'fishing'), 1.5);
});

test('coinMult never returns less than 1, whatever the calendar says', () => {
  boot(anchors([{
    id: 'nonsense',
    name: 'Nonsense',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: { coins: { mult: -4, reasons: ['fishing'] } },
  }]), FETE_AT);
  for (const reason of ['fishing', 'sled', 'mining', 'nothing-like-this', '', null, undefined]) {
    assert.ok(events.coinMult(null, reason) >= 1, `coinMult('${reason}') >= 1`);
  }
});

test('coins.mult is clamped at the ceiling, not refused', () => {
  boot(anchors([{
    id: 'huge',
    name: 'Typo Hour',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: { coins: { mult: 40, reasons: ['sled'] } },
  }]), FETE_AT);
  // 1.5 (Fete) * 3 (clamped) would compound past the ceiling; the product is
  // capped too, so two overlapping events cannot become an economy incident.
  assert.equal(events.coinMult(null, 'sled'), 3);
  assert.ok(events.calendar().warnings.some((w) => /clamped/.test(w)));
});

test('AFK income can never be multiplied, however it is spelled', () => {
  boot(anchors([{
    id: 'afk-friday',
    name: 'Idle Hour',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: { coins: { mult: 2, reasons: ['mining', 'gem!', 'bonfire', 'message in a bottle', 'fishing'] } },
  }]), FETE_AT);

  assert.equal(events.coinMult(null, 'mining'), 1, 'mining pays exactly what it always paid');
  assert.equal(events.coinMult(null, 'gem!'), 1);
  assert.equal(events.coinMult(null, 'bonfire'), 1);
  assert.equal(events.coinMult(null, 'message in a bottle'), 1);
  // ...and the legitimate half of the same list still works (1.5 * 2 = 3).
  assert.equal(events.coinMult(null, 'fishing'), 3);
});

test("'*' expands to the allowlist and stops at the deny list", () => {
  boot(anchors(), FETE_AT);
  assert.equal(events.coinMult(null, 'kart'), 1.5, 'every minigame id');
  assert.equal(events.coinMult(null, 'race win'), 1.5, 'and the win bonuses');
  assert.equal(events.coinMult(null, 'mining'), 1, 'but never the AFK faucet');
});

test('unknown verbs and unknown rooms are warned about, never thrown', () => {
  boot(anchors([{
    id: 'future',
    name: 'From a newer server',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: {
      teleportEveryone: { to: 'the moon' },
      decorate: { atlantis: 'kelp', plaza: 'lanterns' },
      spotlight: 'quidditch',
    },
  }]), FETE_AT);
  const ev = events.calendar().events.find((e) => e.id === 'future');
  assert.ok(ev, 'a calendar one version ahead still boots');
  assert.equal(ev.effects.teleportEveryone, undefined);
  assert.equal(ev.effects.spotlight, undefined, 'an unknown minigame is not a spotlight');
  assert.deepEqual(ev.effects.decorate, { plaza: 'lanterns' }, 'the unknown room was dropped, the real one kept');
});

test('the mural verb can only ever SHORTEN the brush cooldown', () => {
  boot(anchors([{
    id: 'theme-week',
    name: 'Theme Week',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: { mural: { cooldownMs: 100 } }, // below the floor
  }]), FETE_AT);
  assert.equal(events.muralCooldownMs(20_000), 5_000, 'floored at 5s, still faster than base');
  // A calendar asking for a SLOWER brush cannot get one: the accessor takes the
  // room's base and only ever returns something smaller.
  boot(anchors([{
    id: 'slow-week',
    name: 'Slow Week',
    when: { rrule: 'FRI', start: '20:00', durMin: 60 },
    effects: { mural: { cooldownMs: 90_000 } },
  }]), FETE_AT);
  assert.equal(events.muralCooldownMs(20_000), 20_000, 'the base wins');
});

test('the other verbs read back through their accessors', () => {
  const SPLASH_AT = utc(2026, 0, 18, 20, 30); // Sunday 2026-01-18, 15:30 ET
  boot(anchors(), SPLASH_AT);
  assert.equal(events.isActive('sunday-splash'), true);
  assert.equal(events.isActive('friday-fete'), false);
  assert.equal(events.decorFor('drift'), 'splash-buoys');
  assert.equal(events.decorFor('plaza'), null);
  assert.equal(events.spotlight(), 'fishing');
  assert.equal(events.doubleStamps(), true);
  assert.equal(events.stampMult(), 2);
  assert.equal(events.flag('drift.bigblue.surface'), 'often');
  assert.equal(events.flag('nothing.here'), null);
  assert.equal(events.flag('../../etc/passwd'), null, 'a flag name is a slug, never a path');
});

// ---------------------------------------------------------------------------
// 4. the frame: hello/join parity
// ---------------------------------------------------------------------------

test('the frame says "nothing is on" out loud', () => {
  boot(anchors(), utc(2026, 0, 14, 17)); // a Wednesday lunchtime
  const f = events.frame();
  assert.equal(f.t, 'events');
  assert.deepEqual(f.active, [], 'an empty array, never a missing key: a stale pill must clear');
  assert.ok(f.next, 'and the next thing is named');
  assert.equal(f.next.id, 'friday-fete');
  assert.equal(f.now, clock, 'the server clock rides along so clients stop guessing');
  assert.equal(f.tz, 'America/New_York');
});

test('a client arriving 20 minutes in gets 40 minutes of countdown', () => {
  boot(anchors(), utc(2026, 0, 17, 1, 20)); // 20:20 ET, twenty minutes into the Fete
  const f = events.frame();
  assert.equal(f.active.length, 1);
  const a = f.active[0];
  assert.equal(a.id, 'friday-fete');
  assert.equal(a.endsIn, 40 * 60, 'endsIn is what is LEFT');
  assert.equal(a.endsAt, utc(2026, 0, 17, 2, 0), 'and endsAt is absolute');
  assert.equal(a.badge, 'coins');
  assert.deepEqual(a.effects.coins, { mult: 1.5, reasons: a.effects.coins.reasons });
  assert.ok(a.effects.coins.reasons.includes('fishing'));
  assert.ok(!a.effects.coins.reasons.includes('mining'));

  // ...and ten minutes later it is ten minutes shorter, from the same frame call
  clock += 10 * MIN;
  assert.equal(events.frame().active[0].endsIn, 30 * 60);
});

test('next carries startsAt AND startsIn', () => {
  boot(anchors(), utc(2026, 0, 17, 0, 30)); // 19:30 ET Friday, half an hour out
  const f = events.frame();
  assert.equal(f.next.id, 'friday-fete');
  assert.equal(f.next.startsIn, 30 * 60);
  assert.equal(f.next.startsAt, utc(2026, 0, 17, 1, 0));
});

test('a frame with no calendar at all is still a valid frame', () => {
  boot();
  write('{ nope');
  events.load('test');
  const f = events.frame();
  assert.equal(f.t, 'events');
  assert.ok(Array.isArray(f.active));
});

// ---------------------------------------------------------------------------
// 5. tick: announcements and the change broadcast
// ---------------------------------------------------------------------------

test('an event announces itself once, and the frame goes out on the change', () => {
  boot(anchors(), utc(2026, 0, 17, 0, 45)); // 19:45 ET, fifteen out
  events.tick(clock);
  broadcast.length = 0;

  clock = utc(2026, 0, 17, 0, 52); // inside the 10-minute lead window
  events.tick(clock);
  const leads = broadcast.filter((m) => m.t === 'announce');
  assert.equal(leads.length, 1, 'the lead-in fires once');
  assert.match(leads[0].text, /starts in/i);
  assert.equal(leads[0].scope, 'world');

  clock += 60_000;
  events.tick(clock);
  assert.equal(broadcast.filter((m) => m.t === 'announce').length, 1, 'and only once');

  // ...it starts
  clock = utc(2026, 0, 17, 1, 0, 1);
  broadcast.length = 0;
  events.tick(clock);
  assert.ok(broadcast.some((m) => m.t === 'announce' && /Friday Fete!/.test(m.text)), 'start copy');
  const f = broadcast.find((m) => m.t === 'events');
  assert.ok(f, 'and the events frame goes out to the island on the change');
  assert.equal(f.active[0].id, 'friday-fete');

  // ...and it ends
  clock = utc(2026, 0, 17, 2, 0, 1);
  broadcast.length = 0;
  events.tick(clock);
  assert.ok(broadcast.some((m) => m.t === 'announce' && /over/i.test(m.text)), 'end copy');
  assert.deepEqual(broadcast.find((m) => m.t === 'events').active, [], 'and the pill clears');
});

test('a quiet tick broadcasts nothing at all', () => {
  boot(anchors(), utc(2026, 0, 14, 17));
  events.tick(clock);
  broadcast.length = 0;
  for (let i = 0; i < 5; i++) { clock += 10_000; events.tick(clock); }
  assert.equal(broadcast.length, 0, 'no change, no traffic');
});

test('tick tolerates being handed delta-seconds instead of an epoch', () => {
  boot(anchors(), utc(2026, 0, 17, 1, 30));
  events.tick(10); // the shape progress.tick() is called with
  assert.equal(events.frame().active[0].id, 'friday-fete');
});

// ---------------------------------------------------------------------------
// 6. the ws surface: reads and the admin ops
// ---------------------------------------------------------------------------

test("a client's board read is answered and budgeted", () => {
  boot(anchors(), utc(2026, 0, 17, 1, 30));
  const p = conn('Norm', playerRec);
  for (let i = 0; i < 10; i++) assert.equal(events.handleMessage(p, { t: 'events' }), true);
  assert.ok(sent.length >= 1 && sent.length <= 4, `answered ${sent.length} times, not ten`);
  assert.equal(sent[0].t, 'events');
  // anything else is not ours
  assert.equal(events.handleMessage(p, { t: 'chat', text: 'hi' }), false);
});

test('a player probing the admin ops gets silence, and one audit line', () => {
  boot(anchors(), QUIET);
  const p = conn('Norm', playerRec);
  assert.equal(events.handleMessage(p, { t: 'event-start', name: 'Free Coins', durMin: 60, effects: { coins: { mult: 3, games: '*' } } }), true);
  assert.equal(sent.length, 0, 'no reply at all');
  assert.equal(events.frame().active.length, 0, 'and nothing started');
  assert.ok(audited.some((a) => a.op === 'event.probe' && a.ok === false));
});

test('a mod is told no; an admin may start and stop a one-off', () => {
  boot(anchors(), QUIET);
  const mod = conn('Modsy', modRec);
  events.handleMessage(mod, { t: 'event-start', name: 'Nope', durMin: 10, effects: { notice: { headline: 'hi' } } });
  assert.equal(sent.filter((m) => m.t === 'a-err' && m.code === 'cap').length, 1, 'staff get a real error, not silence');
  assert.equal(events.frame().active.length, 0);

  sent = [];
  const boss = conn('DavidEdge', adminRec);
  events.handleMessage(boss, {
    t: 'event-start',
    id: 'surprise-hour',
    name: 'Surprise Hour',
    durMin: 30,
    effects: { coins: { mult: 2, reasons: ['sled'] }, decorate: { plaza: 'lanterns' } },
  });
  const ok = sent.find((m) => m.t === 'a-ok');
  assert.ok(ok, 'the admin op is accepted');
  assert.equal(ok.id, 'surprise-hour');
  assert.equal(events.isActive('surprise-hour'), true);
  assert.equal(events.coinMult(null, 'sled'), 2);
  assert.equal(events.decorFor('plaza'), 'lanterns');
  assert.ok(audited.some((a) => a.op === 'event.start'), 'and audited');
  assert.ok(fs.existsSync(ONEOFFS), 'and persisted, so a restart does not cancel it');

  sent = [];
  events.handleMessage(boss, { t: 'event-stop', id: 'surprise-hour' });
  assert.ok(sent.find((m) => m.t === 'a-ok'), 'stopped');
  assert.equal(events.isActive('surprise-hour'), false);
  assert.equal(events.coinMult(null, 'sled'), 1);
});

test('an admin one-off runs through the SAME validator as the file', () => {
  boot(anchors(), QUIET);
  const boss = conn('DavidEdge', adminRec);
  sent = [];
  events.handleMessage(boss, {
    t: 'event-start',
    id: 'sneaky',
    name: 'Sneaky',
    durMin: 30,
    effects: { coins: { mult: 0.25, games: '*' } },
  });
  const err = sent.find((m) => m.t === 'a-err');
  assert.ok(err, 'an effect the calendar could not express is refused over the wire too');
  assert.equal(events.isActive('sneaky'), false);

  sent = [];
  events.handleMessage(boss, {
    t: 'event-start', id: 'mining-party', name: 'Mining Party', durMin: 30,
    effects: { coins: { mult: 2, reasons: ['mining'] } },
  });
  assert.ok(sent.find((m) => m.t === 'a-err'), 'and the AFK deny list holds on the admin road');
  assert.equal(events.coinMult(null, 'mining'), 1);
});

test('a one-off cannot outlive a day, and cannot squat a calendar id', () => {
  boot(anchors(), QUIET);
  const boss = conn('DavidEdge', adminRec);
  sent = [];
  events.handleMessage(boss, { t: 'event-start', id: 'friday-fete', name: 'Impostor', durMin: 10, effects: { notice: { headline: 'x' } } });
  assert.ok(sent.find((m) => m.t === 'a-err' && m.code === 'args'), 'the calendar owns that id');

  sent = [];
  events.handleMessage(boss, { t: 'event-start', id: 'forever', name: 'Forever', durMin: 999_999, effects: { notice: { headline: 'x' } } });
  const ok = sent.find((m) => m.t === 'a-ok');
  assert.ok(ok);
  assert.equal(ok.endsAt - clock, 24 * HOUR, 'capped at a day');

  sent = [];
  events.handleMessage(boss, { t: 'event-stop', id: 'friday-fete' });
  assert.ok(sent.find((m) => m.t === 'a-err' && m.code === 'file'), 'calendar entries are stopped by editing the file');
});

test('a running one-off survives a restart; a finished one does not come back', () => {
  boot(anchors(), QUIET);
  const boss = conn('DavidEdge', adminRec);
  events.handleMessage(boss, { t: 'event-start', id: 'long-one', name: 'Long One', durMin: 120, effects: { notice: { headline: 'x' } } });
  events.handleMessage(boss, { t: 'event-start', id: 'short-one', name: 'Short One', durMin: 5, effects: { notice: { headline: 'y' } } });
  const at = clock;

  // the restart: an hour later, same data dir, same one-off file
  clock = at + HOUR;
  events.install({
    now: () => clock,
    sendTo: (p, m) => sent.push({ to: p.id, ...m }),
    broadcastAll: (m) => broadcast.push(m),
    recordFor: () => null,
    file: CAL,
    oneoffFile: ONEOFFS,
    watch: false,
  });
  assert.equal(events.isActive('long-one'), true, 'still running after a restart');
  assert.equal(events.isActive('short-one'), false, 'and last hour did not come back');
});

// ---------------------------------------------------------------------------
// 7. the fixed-window form, and the shipped starter calendar
// ---------------------------------------------------------------------------

test('a fixed start/end window is read as ET local time', () => {
  boot(anchors([{
    id: 'mural-week',
    name: 'Mural Theme Week',
    when: { start: '2026-06-01T00:00', end: '2026-06-08T00:00' },
    rooms: ['plaza'],
    effects: { mural: { cooldownMs: 12_000 }, notice: { headline: "This week's theme: SUMMER." } },
  }]), utc(2026, 5, 3, 16)); // noon ET, mid-week
  assert.equal(events.isActive('mural-week'), true);
  assert.equal(events.muralCooldownMs(20_000), 12_000);
  assert.equal(events.notices()[0].headline, "This week's theme: SUMMER.");
  // and it is over on the 8th
  clock = utc(2026, 5, 9, 16);
  assert.equal(events.isActive('mural-week'), false);
});

test('the SHIPPED data/calendar.json parses with no warnings', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'data', 'calendar.json'), 'utf8');
  const res = events.parseCalendar(src);
  assert.equal(res.ok, true, res.error || '');
  assert.deepEqual(res.warnings, [], 'the calendar we ship must be clean');
  const ids = res.cal.events.map((e) => e.id);
  assert.deepEqual(ids, ['friday-fete', 'sunday-splash'], 'the two anchors the owner picked');
  const fete = res.cal.events[0];
  assert.equal(fete.when.kind, 'weekly');
  assert.deepEqual(fete.when.days, [5], 'Friday');
  assert.equal(fete.when.h, 20);
  assert.equal(fete.effects.coins.mult, 1.5);
  assert.ok(!fete.effects.coins.reasons.includes('mining'));
  const splash = res.cal.events[1];
  assert.deepEqual(splash.when.days, [0], 'Sunday');
  assert.equal(splash.when.h, 15);
  assert.equal(splash.effects.spotlight, 'fishing');
});

test.after(() => {
  events.stop();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* windows */ }
});
