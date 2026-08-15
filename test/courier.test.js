/**
 * test/courier.test.js - The Cove Courier (wave 14A, N-31).
 *
 *   node --test test/courier.test.js
 *
 * server/courier.js is imported DIRECTLY with FAKE SOURCES and a FAKE CLOCK.
 * Nothing here boots a server, opens a socket or touches disk. The fakes are
 * deliberately hostile in places: a source that throws, a source that returns
 * nonsense, a source that is simply not there.
 *
 * What is being pinned down, in order of "how badly does this hurt if it is
 * wrong":
 *
 *  1. THE PRINT DAY. Friday, America/New_York, forever. The value of a weekly
 *     paper is that Friday means something, so the two weekends a year that are
 *     23 and 25 hours long have to come out on Friday like every other week.
 *
 *  2. IT NEVER THROWS AND NEVER BLOCKS. Every source absent, every source
 *     throwing, every source lying: the paper still prints, still reads warmly,
 *     and still has articles in it.
 *
 *  3. NAMES. Exactly one named credit exists (the fastest lap, a thing done
 *     proudly in public), it is filtered and vetoable at render time, and no
 *     aggregate article can ever name anybody.
 *
 *  4. IT IS THE SAME PAPER ALL WEEK. An issue is assembled once and cached; a
 *     number that moves on Saturday does not rewrite Friday's front page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as courier from '../server/courier.js';
import { weekKey as statsWeekKey } from '../server/stats.js';
import { dayKey } from '../server/progress.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Any control or format character reaching print is a bug. */
const CTRL = /\p{C}/u;

// Friday 2026-08-14, 10:00 ET (EDT, UTC-4) = the epoch issue's print instant.
const PRINT_1 = Date.UTC(2026, 7, 14, 14, 0, 0);

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let clock;
let out;      // every frame sent to any player, in order
let calls;    // what each fake source was asked, and when
let logs;

function fakeCharms(opts = {}) {
  const mod = {
    currentCharm(ms) {
      calls.currentCharm++;
      calls.charmAskedAt = ms;
      if (opts.throws) throw new Error('charms exploded');
      if (opts.nonsense) return 42;
      return {
        week: '2026-08-03',
        name: 'Sea Glass Bead',
        desc: 'Frosted green, worn smooth by about a thousand tides.',
        roomName: 'the Beach',
      };
    },
  };
  if (opts.foundCount) {
    mod.foundCount = (wk) => { calls.foundCount++; return opts.foundCount(wk); };
  }
  return mod;
}

function fakeStats(opts = {}) {
  const week = opts.week || 'WK-NOW';
  return {
    weekKey() {
      calls.statsWeekKey++;
      return opts.weekKeyReturns === undefined ? 'WK-NOW' : opts.weekKeyReturns;
    },
    week() {
      calls.statsWeek++;
      if (opts.throws) throw new Error('stats exploded');
      if (opts.nonsense) return 'not an object';
      return {
        week,
        games: {
          fishing: { runs: 1204, coins: 9 },
          kart: { runs: 61 },
          sled: { runs: 35 },
          chess: { runs: 4 },
        },
        rooms: { plaza: 842, beach: 190, house: 12 },
        players: { new: 38 },
      };
    },
  };
}

function fakeEvents(opts = {}) {
  return {
    frame() {
      calls.eventsFrame++;
      if (opts.throws) throw new Error('events exploded');
      if (opts.empty) return { active: [], next: null };
      return {
        active: [{ name: 'Golden Hour', blurb: 'Double coins, all evening.' }],
        next: {
          name: 'Den Crawl',
          blurb: 'Every den on the island opens its door.',
          startsAt: Date.UTC(2026, 7, 19, 0, 0, 0), // Tuesday 2026-08-18, 8pm ET
        },
      };
    },
  };
}

function fakeKart(opts = {}) {
  return {
    weekRecord() {
      calls.kartRecord++;
      if (opts.throws) throw new Error('kart exploded');
      if (opts.none) return null;
      return { name: opts.name === undefined ? 'Mango' : opts.name, ms: 41_230 };
    },
  };
}

function boot(at = PRINT_1, ctx = {}) {
  clock = at;
  out = [];
  logs = [];
  calls = {
    currentCharm: 0, charmAskedAt: 0, foundCount: 0,
    statsWeek: 0, statsWeekKey: 0, eventsFrame: 0, kartRecord: 0,
  };
  courier.install({
    now: () => clock,
    sendTo: (p, m) => { out.push({ to: p.id, ...m }); },
    log: (msg, err) => { logs.push(`${msg}: ${err?.message || err || ''}`); },
    ...ctx,
  });
}

/** Everything with all four sources wired and agreeing. */
function bootFull(at = PRINT_1, extra = {}) {
  boot(at, {
    charms: fakeCharms(),
    stats: fakeStats(),
    events: fakeEvents(),
    kart: fakeKart(),
    charmFinders: () => 9,
    ...extra,
  });
}

const player = (id = 'p1') => ({ id, name: `capy-${id}` });
const kinds = (iss) => iss.articles.map((a) => a.k);
const bodyOf = (iss, k) => (iss.articles.find((a) => a.k === k) || {}).body || '';
const allText = (iss) => `${iss.headline} ${iss.articles.map((a) => `${a.h} ${a.body}`).join(' ')}`;
const fillerCount = (iss) => iss.articles.filter((a) => a.k.startsWith('filler:')).length;

// ---------------------------------------------------------------------------
// 1. the print calendar
// ---------------------------------------------------------------------------

test('the paper prints on Friday, at the print hour, in cove time', () => {
  boot();
  const iss = courier.currentIssueAt(PRINT_1);
  assert.equal(iss.key, '2026-08-14');
  assert.equal(iss.at, PRINT_1);
  assert.equal(dayKey(iss.at), '2026-08-14');
});

test('before Friday morning you are still reading last week', () => {
  boot();
  assert.equal(courier.currentIssueAt(PRINT_1 - 60_000).key, '2026-08-07');
  assert.equal(courier.currentIssueAt(PRINT_1 - 3 * DAY).key, '2026-08-07');
  // ...and the moment it prints, it prints.
  assert.equal(courier.currentIssueAt(PRINT_1).key, '2026-08-14');
});

test('the same issue stays on the board all week', () => {
  boot();
  for (let h = 0; h < 24 * 7; h++) {
    assert.equal(courier.currentIssueAt(PRINT_1 + h * HOUR).key, '2026-08-14', `hour ${h}`);
  }
  assert.equal(courier.currentIssueAt(PRINT_1 + 7 * DAY).key, '2026-08-21');
});

test('nextPrintAt is always the next Friday print instant', () => {
  boot();
  assert.equal(courier.nextPrintAt(PRINT_1), PRINT_1 + 7 * DAY);
  assert.equal(courier.nextPrintAt(PRINT_1 + 3 * DAY), PRINT_1 + 7 * DAY);
  assert.equal(dayKey(courier.nextPrintAt(PRINT_1 - 3 * DAY)), '2026-08-14');
});

test('DST never moves the print day: every issue of a year is a Friday', () => {
  boot();
  let prev = null;
  for (let d = 0; d < 400; d++) {
    const { key, at } = courier.currentIssueAt(PRINT_1 + d * DAY + 12 * HOUR);
    assert.equal(courier._internals.dowOf(key), 5, `${key} is not a Friday`);
    assert.equal(dayKey(at), key, 'the print instant belongs to its own day');
    if (prev && prev !== key) {
      const gap = Date.parse(`${key}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`);
      assert.equal(gap, 7 * DAY, `${prev} -> ${key} is not seven days`);
    }
    prev = key;
  }
});

test('the print day survives both DST weekends', () => {
  boot();
  // Spring forward is Sunday 2026-03-08; fall back is Sunday 2026-11-01.
  assert.equal(courier.currentIssueAt(Date.UTC(2026, 2, 4, 17)).key, '2026-02-27');
  assert.equal(courier.currentIssueAt(Date.UTC(2026, 2, 10, 16)).key, '2026-03-06');
  assert.equal(courier.currentIssueAt(Date.UTC(2026, 9, 29, 16)).key, '2026-10-23');
  assert.equal(courier.currentIssueAt(Date.UTC(2026, 10, 4, 17)).key, '2026-10-30');
});

test('issue numbers count Fridays from the epoch and never restart', () => {
  boot();
  assert.equal(courier.issueNumber('2026-08-14'), 1);
  assert.equal(courier.issueNumber('2026-08-21'), 2);
  assert.equal(courier.issueNumber('2027-08-13'), 53);
  // A clock before the epoch prints issue 1, never issue -3.
  assert.equal(courier.issueNumber('2026-07-17'), 1);
  assert.equal(courier.issueNumber('nonsense'), 1);
});

// ---------------------------------------------------------------------------
// 2. a full issue
// ---------------------------------------------------------------------------

test('a full week prints every automatic section', () => {
  bootFull();
  const iss = courier.issue();
  assert.equal(iss.issueN, 1);
  assert.equal(iss.week, '2026-08-10'); // the Monday that opened the print week
  assert.equal(iss.printedAt, PRINT_1);
  assert.equal(iss.nextPrintAt, PRINT_1 + 7 * DAY);
  assert.ok(iss.headline.length > 0);
  for (const k of ['charm', 'play', 'lap', 'whatson']) {
    assert.ok(kinds(iss).includes(k), `missing the ${k} article`);
  }
  assert.ok(iss.articles.length >= 6, `only ${iss.articles.length} articles`);
  for (const a of iss.articles) {
    assert.equal(typeof a.k, 'string');
    assert.ok(a.h.length > 0 && a.h.length <= 90);
    assert.ok(a.body.length > 0 && a.body.length <= 420);
    assert.doesNotMatch(a.body, CTRL, 'control characters reached print');
  }
});

test('the charm article reports LAST week, and counts finders when told', () => {
  bootFull();
  const iss = courier.issue();
  assert.ok(Math.abs(calls.charmAskedAt - (PRINT_1 - 7 * DAY)) < HOUR);
  const body = bodyOf(iss, 'charm');
  assert.match(body, /Sea Glass Bead/);
  assert.match(body, /the Beach/);
  assert.match(body, /9 capys found it/);
  // The headline is NOT the charm article's own h: borrowing it printed the
  // same line twice on the front page. Without an editorial the masthead runs
  // a warm rotating line instead (see headlineFor).
  assert.doesNotMatch(iss.headline, /Sea Glass Bead/);
  assert.ok(iss.headline.length > 0);
});

test('no finder count available: the charm still prints, with no number', () => {
  boot(PRINT_1, { charms: fakeCharms() }); // no charmFinders, no foundCount
  const body = bodyOf(courier.issue(), 'charm');
  assert.match(body, /Sea Glass Bead/);
  assert.doesNotMatch(body, /found it/);
  assert.equal(courier.stats().errors, 0);
});

test('a charms module that grows foundCount() lights the number up on its own', () => {
  boot(PRINT_1, { charms: fakeCharms({ foundCount: () => 1 }) });
  const body = bodyOf(courier.issue(), 'charm');
  assert.equal(calls.foundCount, 1);
  assert.match(body, /1 capy found it/); // singular, not "1 capys"
});

test('nobody found it is reported warmly and names nobody', () => {
  boot(PRINT_1, { charms: fakeCharms(), charmFinders: () => 0 });
  const body = bodyOf(courier.issue(), 'charm');
  assert.match(body, /Nobody turned it up/);
  assert.doesNotMatch(body, /0 capys/);
});

test('the play article is aggregates only: names, never', () => {
  bootFull();
  const body = bodyOf(courier.issue(), 'play');
  assert.match(body, /Reel Rush/);          // the MINIGAMES name, not the id
  assert.match(body, /1,204 runs/);
  assert.match(body, /Sunny Plaza/);        // the ROOM_INFO name, not the id
  assert.match(body, /842 visits/);
  assert.match(body, /96 races/);           // kart 61 + sled 35
  assert.doesNotMatch(body, /capy-/);
});

test('what is on renders the calendar in cove time', () => {
  bootFull();
  const body = bodyOf(courier.issue(), 'whatson');
  assert.match(body, /Golden Hour is on right now/);
  assert.match(body, /Den Crawl, Tuesday at 8pm/);
});

test('an empty calendar drops the section rather than printing an empty one', () => {
  boot(PRINT_1, { events: fakeEvents({ empty: true }) });
  assert.ok(!kinds(courier.issue()).includes('whatson'));
});

// ---------------------------------------------------------------------------
// 3. names
// ---------------------------------------------------------------------------

test('the fastest lap is the one named credit, and it is a proud one', () => {
  bootFull();
  const iss = courier.issue();
  const body = bodyOf(iss, 'lap');
  assert.match(body, /Mango/);
  assert.match(body, /41\.23 seconds/);
  for (const a of iss.articles) {
    if (a.k === 'lap') continue;
    assert.doesNotMatch(a.body, /Mango/, 'a name leaked into an aggregate article');
  }
});

test('a moderator veto at render time keeps a name out of the paper', () => {
  bootFull(PRINT_1, { nameOk: () => false });
  const iss = courier.issue();
  assert.ok(!kinds(iss).includes('lap'));
  assert.doesNotMatch(allText(iss), /Mango/);
  assert.ok(iss.articles.length >= 6, 'the issue got thinner instead of refilled');
});

test('every printed name goes through the filter', () => {
  const seen = [];
  bootFull(PRINT_1, { clean: (s) => { seen.push(s); return s.replace(/Mango/, 'Peach'); } });
  assert.match(bodyOf(courier.issue(), 'lap'), /Peach/);
  assert.deepEqual(seen, ['Mango']);
});

test('a name the filter empties drops the credit entirely', () => {
  bootFull(PRINT_1, { clean: () => '' });
  assert.ok(!kinds(courier.issue()).includes('lap'));
});

test('a hostile name is sanitised or dropped, never printed raw', () => {
  bootFull(PRINT_1, { kart: fakeKart({ name: 'ba\ndname   with  spaces and a length beyond any sane limit' }) });
  const body = bodyOf(courier.issue(), 'lap');
  assert.doesNotMatch(body, CTRL);
  assert.doesNotMatch(body, / {2}/);
  assert.equal(courier._internals.printableName('  hi\tthere  '), 'hi there');
  assert.equal(courier._internals.printableName(''), '');
  assert.equal(courier._internals.printableName(null), '');
});

test('a kart module with no record reader simply has no lap section', () => {
  bootFull(PRINT_1, { kart: {} });               // duck typing finds nothing
  assert.ok(!kinds(courier.issue()).includes('lap'));
  bootFull(PRINT_1, { kart: fakeKart({ none: true }) });
  assert.ok(!kinds(courier.issue()).includes('lap'));
});

// ---------------------------------------------------------------------------
// 4. absent, broken and lying sources
// ---------------------------------------------------------------------------

test('every source absent: the paper still prints, warmly', () => {
  boot();
  const iss = courier.issue();
  assert.equal(iss.issueN, 1);
  assert.equal(iss.articles.length, 4); // the thin-week filler top-up
  assert.ok(iss.headline.length > 0);
  for (const a of iss.articles) {
    assert.match(a.k, /^filler:/);
    assert.ok(a.body.length > 20);
  }
  assert.equal(courier.stats().errors, 0);
});

test('a source that throws costs its own article and nothing else', () => {
  boot(PRINT_1, {
    charms: fakeCharms({ throws: true }),
    stats: fakeStats({ throws: true }),
    events: fakeEvents({ throws: true }),
    kart: fakeKart({ throws: true }),
  });
  const iss = courier.issue();
  assert.equal(iss.articles.length, 4);
  assert.ok(courier.stats().errors >= 4);
  assert.ok(logs.length >= 4);
});

test('a source that returns nonsense is ignored, not printed', () => {
  boot(PRINT_1, {
    charms: fakeCharms({ nonsense: true }),
    stats: fakeStats({ nonsense: true }),
    events: { frame: () => ({ active: 'yes', next: 7 }) },
    kart: { weekRecord: () => ({ name: 'Mango', ms: -5 }) },
  });
  const iss = courier.issue();
  assert.deepEqual(kinds(iss).filter((k) => !k.startsWith('filler:')), []);
  assert.doesNotMatch(allText(iss), /Mango|undefined|NaN|\[object/);
});

test('a courier that was never installed refuses rather than throws', () => {
  boot();
  courier._internals.S.installed = false;
  try {
    assert.equal(courier.handleMessage(player(), { t: 'courier' }), false);
    assert.equal(courier.tick(PRINT_1), null);
  } finally {
    courier._internals.S.installed = true;
  }
});

// ---------------------------------------------------------------------------
// 5. the week's numbers belong to the week they are printed about
// ---------------------------------------------------------------------------

test('a stats bucket for a different week is dropped, not printed as this one', () => {
  boot(PRINT_1, { stats: fakeStats({ week: 'WK-OTHER', weekKeyReturns: 'WK-NOW' }) });
  const iss = courier.issue();
  assert.ok(!kinds(iss).includes('play'));
  assert.equal(courier.stats().dropped, 1);
  assert.equal(iss.articles.length, 4, 'the gap was not covered by filler');
});

test('the week id compared is the stats module own vocabulary', () => {
  // No fakery: the real stats.weekKey() over the print Friday's day key is the
  // exact string a live bucket carries, so the comparison cannot drift.
  const wk = statsWeekKey(dayKey(PRINT_1));
  assert.match(wk, /^\d{4}-W\d{2}$/);
  boot(PRINT_1, {
    stats: {
      weekKey: statsWeekKey,
      week: () => ({ week: wk, games: { fishing: { runs: 3 } }, rooms: {} }),
    },
  });
  assert.match(bodyOf(courier.issue(), 'play'), /3 runs/);
});

test('a stats module with no weekKey() is trusted rather than dropped', () => {
  boot(PRINT_1, { stats: { week: () => ({ week: 'whatever', games: { sled: { runs: 2 } }, rooms: {} }) } });
  assert.match(bodyOf(courier.issue(), 'play'), /2 races/);
});

// ---------------------------------------------------------------------------
// 6. one issue a week, assembled once
// ---------------------------------------------------------------------------

test('an issue is assembled once and then never changes', () => {
  bootFull();
  const a = courier.issue();
  assert.equal(calls.statsWeek, 1);
  const b = courier.issue(PRINT_1 + 2 * DAY);
  assert.equal(calls.statsWeek, 1, 'the sources were read again mid-week');
  assert.equal(a, b, 'the same object, not a re-render');
  assert.equal(courier.stats().issues, 1);
});

test('a number that moves on Saturday does not rewrite Fridays front page', () => {
  let runs = 10;
  boot(PRINT_1, {
    stats: { weekKey: () => 'WK', week: () => ({ week: 'WK', games: { fishing: { runs } }, rooms: {} }) },
  });
  const before = bodyOf(courier.issue(), 'play');
  runs = 999;
  const after = bodyOf(courier.issue(PRINT_1 + DAY), 'play');
  assert.equal(before, after);
  assert.match(after, /10 runs/);
});

test('an issue is frozen: a reader cannot edit the paper', () => {
  bootFull();
  const iss = courier.issue();
  assert.throws(() => { iss.articles.push({ k: 'x', h: 'x', body: 'x' }); });
  assert.throws(() => { iss.articles[0].body = 'nonsense'; });
});

test('the next Friday is a new issue, with a new number', () => {
  bootFull();
  const one = courier.issue();
  const two = courier.issue(PRINT_1 + 7 * DAY);
  assert.equal(one.issueN, 1);
  assert.equal(two.issueN, 2);
  assert.notEqual(one, two);
  assert.equal(courier.stats().issues, 2);
});

test('the cache is bounded: a long-lived process does not hoard issues', () => {
  bootFull();
  for (let w = 0; w < 25; w++) courier.issue(PRINT_1 + w * 7 * DAY);
  assert.ok(courier.stats().cached <= 10, `cached ${courier.stats().cached}`);
});

test('tick announces a new issue exactly once', () => {
  bootFull();
  assert.equal(courier.tick(PRINT_1), null, 'the first tick is not an announcement');
  assert.equal(courier.tick(PRINT_1 + DAY), null);
  const printed = courier.tick(PRINT_1 + 7 * DAY);
  assert.ok(printed && printed.printed === true);
  assert.equal(printed.issueN, 2);
  assert.equal(printed.key, '2026-08-21');
  assert.ok(printed.headline.length > 0);
  assert.equal(courier.tick(PRINT_1 + 8 * DAY), null, 'announced twice');
});

// ---------------------------------------------------------------------------
// 7. the filler table
// ---------------------------------------------------------------------------

test('the filler table is deep enough that repeats are rare', () => {
  assert.ok(courier.FILLERS.length >= 24, `only ${courier.FILLERS.length} pieces`);
  const ids = courier.FILLERS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate filler id');
  for (const f of courier.FILLERS) {
    assert.ok(f.h.length > 0 && f.h.length <= 90);
    assert.ok(f.body.length > 20 && f.body.length <= 420);
    assert.doesNotMatch(f.body, CTRL);
  }
});

test('no piece repeats inside an issue, or across the next seven issues', () => {
  boot(); // no sources: the widest filler run, four a week
  const seen = [];
  for (let n = 0; n < 7; n++) {
    const ks = kinds(courier.issue(PRINT_1 + n * 7 * DAY));
    assert.equal(new Set(ks).size, ks.length, `issue ${n + 1} repeats itself`);
    seen.push(...ks);
  }
  assert.equal(new Set(seen).size, seen.length, 'a piece came round again inside seven weeks');
});

test('a thin week gets more filler, a full week gets less', () => {
  boot();
  const thin = fillerCount(courier.issue());
  bootFull();
  const full = fillerCount(courier.issue());
  assert.equal(thin, 4);
  assert.equal(full, 2);
});

// ---------------------------------------------------------------------------
// 8. the wire
// ---------------------------------------------------------------------------

test('handleMessage consumes courier and nothing else', () => {
  bootFull();
  const p = player();
  assert.equal(courier.handleMessage(p, { t: 'chat', m: 'hi' }), false);
  assert.equal(courier.handleMessage(p, { t: 'charm' }), false);
  assert.equal(courier.handleMessage(p, {}), false);
  assert.equal(courier.handleMessage(p, null), false);
  assert.equal(courier.handleMessage(null, { t: 'courier' }), false);
  assert.equal(out.length, 0);

  assert.equal(courier.handleMessage(p, { t: 'courier' }), true);
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.t, 'courier');
  assert.equal(f.to, 'p1');
  assert.equal(f.issueN, 1);
  assert.equal(typeof f.headline, 'string');
  assert.ok(Array.isArray(f.articles) && f.articles.length >= 6);
  for (const a of f.articles) assert.deepEqual(Object.keys(a).sort(), ['body', 'h', 'k']);
});

test('nothing on the frame is trusted: the issue is the same for everybody', () => {
  bootFull();
  courier.handleMessage(player('a'), { t: 'courier', week: '1999-01-01', issueN: 9999, articles: [{ k: 'x' }] });
  courier.handleMessage(player('b'), { t: 'courier' });
  assert.equal(out[0].issueN, out[1].issueN);
  assert.deepEqual(out[0].articles, out[1].articles);
});

test('reads are rate limited per player, and the limit forgets after a second', () => {
  bootFull();
  const a = player('a');
  const b = player('b');
  for (let i = 0; i < 6; i++) courier.handleMessage(a, { t: 'courier' });
  assert.equal(out.filter((f) => f.to === 'a').length, 3);
  assert.ok(courier.stats().refusedRate >= 3);
  courier.handleMessage(b, { t: 'courier' });      // another player is unaffected
  assert.equal(out.filter((f) => f.to === 'b').length, 1);
  clock += 1100;                                    // ...and the door opens again
  courier.handleMessage(a, { t: 'courier' });
  assert.equal(out.filter((f) => f.to === 'a').length, 4);
});

test('a sendTo that throws is not fatal, and the read is still counted', () => {
  bootFull(PRINT_1, { sendTo: () => { throw new Error('dead socket'); } });
  assert.equal(courier.handleMessage(player(), { t: 'courier' }), true);
  assert.equal(courier.stats().reads, 1);
});

test('install twice is safe and starts from a clean desk', () => {
  bootFull();
  courier.handleMessage(player(), { t: 'courier' });
  assert.equal(courier.stats().reads, 1);
  bootFull();
  assert.equal(courier.stats().reads, 0);
  assert.equal(courier.stats().cached, 0);
  assert.equal(courier.stats().issues, 0);
});

// ---------------------------------------------------------------------------
// 9. the optional editorial
// ---------------------------------------------------------------------------

test('an editorial is pinned to the top when there is one', () => {
  bootFull(PRINT_1, { editorial: () => ({ h: 'A word from the desk', body: 'Not much happened. It was lovely.' }) });
  const iss = courier.issue();
  assert.equal(iss.articles[0].k, 'editorial');
  assert.equal(iss.headline, 'A word from the desk');
});

test('the paper never blocks on a human', () => {
  bootFull(PRINT_1, { editorial: () => null });
  assert.ok(!kinds(courier.issue()).includes('editorial'));

  bootFull(PRINT_1, { editorial: () => { throw new Error('no'); } });
  assert.ok(!kinds(courier.issue()).includes('editorial'));
  assert.ok(courier.stats().errors >= 1);
});
