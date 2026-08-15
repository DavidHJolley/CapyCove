/**
 * Headless tests for src/ui/events.js (wave 13, agent 13D): the wire-shape
 * tolerance and the countdown wording, which are the two parts of the event
 * pill that can be wrong without anyone noticing on screen.
 *
 *   node --test tests/events.test.mjs
 *
 * No DOM stub here on purpose: the module must be import-safe (nothing touches
 * document/window/clock at import time), and this file failing to import at all
 * is itself the regression test for that rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseEventFrame, pillView, fmtLeft, leadInLine, parseCharm, charmLine,
} = await import('../src/ui/events.js');

const MIN = 60 * 1000;

test('parses the frozen 13A frame shape', () => {
  const now = 1_800_000_000_000;
  const m = {
    t: 'event',
    active: { id: 'golden', name: 'Golden Hour', until: now + 24 * MIN, effects: { coins: { mult: 2, reasons: ['sled'] } } },
    next: { name: 'Friday Fete', at: now + 90 * MIN },
  };
  const s = parseEventFrame(m, now);
  assert.equal(s.active.id, 'golden');
  assert.equal(s.active.name, 'Golden Hour');
  assert.equal(s.active.until, now + 24 * MIN);
  assert.equal(s.active.badge, 'double coins');
  assert.equal(s.next.name, 'Friday Fete');
  assert.equal(s.next.at, now + 90 * MIN);
  // next has no id of its own in the frozen shape: one is derived, not demanded
  assert.equal(s.next.id, 'friday fete');
});

test('says nothing is on, out loud', () => {
  const s = parseEventFrame({ t: 'event', active: null, next: null }, 1000);
  assert.equal(s.active, null);
  assert.equal(s.next, null);
  assert.equal(pillView(s, 1000).show, false);
  // and a junk frame is the same quiet, never a throw
  assert.equal(pillView(parseEventFrame(undefined), Date.now()).show, false);
  assert.equal(pillView(null, Date.now()).show, false);
});

test('tolerates the array form and the relative twins', () => {
  const now = 5_000_000_000;
  const s = parseEventFrame({
    active: [{ id: 'aurora', name: 'Aurora Watch', endsIn: 600, effects: { sky: { aurora: true } } }],
    next: { name: 'Whale Day', startsIn: 3600 },
  }, now);
  assert.equal(s.active.until, now + 600_000);
  assert.equal(s.active.badge, 'aurora');
  assert.equal(s.next.at, now + 3_600_000);
});

test('takes the server clock out of the stamps when it is offered', () => {
  const now = 1_700_000_000_000;
  const skew = 45 * 1000; // server thinks it is 45s later than we do
  const s = parseEventFrame({
    now: now + skew,
    active: { id: 'g', name: 'Golden Hour', until: now + skew + 30 * MIN },
  }, now);
  assert.equal(s.active.until, now + 30 * MIN);
  // a nonsense clock is ignored rather than hiding every event
  const wild = parseEventFrame({
    now: now + 5 * 24 * 3600 * 1000,
    active: { id: 'g', name: 'Golden Hour', until: now + 30 * MIN },
  }, now);
  assert.equal(wild.active.until, now + 30 * MIN);
});

test('a multiplier at or below 1 never becomes a badge', () => {
  // the owner's law: coinMult multiplies UP only, so 1.0 is not news
  const flat = parseEventFrame({ active: { id: 'q', name: 'Quiet Sunday', effects: { coins: { mult: 1 } } } }, 0);
  assert.equal(flat.active.badge, '');
  const half = parseEventFrame({ active: { id: 'x', name: 'X', effects: { coins: { mult: 0.5 } } } }, 0);
  assert.equal(half.active.badge, '');
  const one5 = parseEventFrame({ active: { id: 'x', name: 'X', effects: { coins: { mult: 1.5 } } } }, 0);
  assert.equal(one5.active.badge, '1.5x coins');
});

test('fmtLeft rounds to the minute and words the last one', () => {
  assert.equal(fmtLeft(0), 'under a minute');
  assert.equal(fmtLeft(59_400), 'under a minute');
  assert.equal(fmtLeft(60_000), '1m');
  assert.equal(fmtLeft(24 * MIN), '24m');
  // the frame landed a heartbeat ago: still a 24-minute event, not a 23 one
  assert.equal(fmtLeft(24 * MIN - 120), '24m');
  assert.equal(fmtLeft(60 * MIN), '1h');
  assert.equal(fmtLeft(65 * MIN), '1h 5m');
  assert.equal(fmtLeft(-5), 'under a minute');
});

test('the pill counts down the running event', () => {
  const now = 2_000_000_000;
  const s = { active: { id: 'g', name: 'Golden Hour', until: now + 24 * MIN, badge: 'double coins' }, next: null };
  const v = pillView(s, now);
  assert.equal(v.show, true);
  assert.equal(v.kind, 'live');
  assert.equal(v.time, '24m left');
  assert.equal(pillView(s, now + 23.5 * MIN).time, 'wrapping up');
});

test('a client joining 20 minutes in gets 40 minutes, not 60', () => {
  // the verifier's criterion, straight off docs/NEXT-AAA.md wave 13
  const now = 3_000_000_000;
  const startedAt = now - 20 * MIN;
  const s = parseEventFrame({ active: { id: 'g', name: 'Golden Hour', until: startedAt + 60 * MIN } }, now);
  assert.equal(pillView(s, now).time, '40m left');
});

test('an event that ran out locally stops counting and yields to the next', () => {
  const now = 4_000_000_000;
  const s = {
    active: { id: 'g', name: 'Golden Hour', until: now - 1000, badge: '' },
    next: { id: 'fete', name: 'Friday Fete', at: now + 20 * MIN },
  };
  const v = pillView(s, now);
  assert.equal(v.kind, 'soon');
  assert.equal(v.time, 'in 20m');
});

test('the pill looks forward one hour and no further', () => {
  const now = 5_000_000_000;
  const soon = { active: null, next: { id: 'f', name: 'Friday Fete', at: now + 59 * MIN } };
  assert.equal(pillView(soon, now).show, true);
  const far = { active: null, next: { id: 'f', name: 'Friday Fete', at: now + 3 * 60 * MIN } };
  assert.equal(pillView(far, now).show, false, 'a quiet cove shows no pill at all');
  const due = { active: null, next: { id: 'f', name: 'Friday Fete', at: now + 10 * 1000 } };
  assert.equal(pillView(due, now).time, 'starting now');
  const stale = { active: null, next: { id: 'f', name: 'Friday Fete', at: now - 10 * MIN } };
  assert.equal(pillView(stale, now).show, false, 'a start frame that never came stops nagging');
});

test('the lead-in line is a human sentence', () => {
  assert.equal(leadInLine('Friday Fete', 10 * MIN), 'Friday Fete starts in 10 min');
  assert.equal(leadInLine('Friday Fete', 9 * MIN + 40_000), 'Friday Fete starts in 10 min');
  assert.equal(leadInLine('Friday Fete', 70_000), 'Friday Fete starts in a minute');
});

test('a charm is mine unless the frame names someone else', () => {
  const mine = parseCharm({ t: 'charm-found', id: 'shell', name: 'Sunset Shell', coins: 120 }, 'Nutmeg');
  assert.equal(mine.mine, true);
  assert.equal(mine.name, 'Sunset Shell');
  assert.equal(mine.coins, 120);
  assert.equal(parseCharm({ by: 'nutmeg' }, 'Nutmeg').mine, true, 'case-insensitive on my own name');
  const theirs = parseCharm({ by: 'Biscuit', name: 'Sunset Shell' }, 'Nutmeg');
  assert.equal(theirs.mine, false);
  assert.equal(theirs.by, 'Biscuit');
  // a bare frame still names something sayable
  assert.equal(parseCharm({}, '').name, "this week's charm");
});

test("server/charms.js's island broadcast: `name` is the finder, not the charm", () => {
  // the frame charms.js actually sends, to EVERY socket
  const wire = {
    t: 'charm-found',
    name: 'Biscuit',        // the finder
    id: 'p_17',
    charm: 'shell',
    charmName: 'The Sunset Shell',
    room: 'beach',
    roomName: 'Sandy Shores',
    week: '2026-08-10',
    n: 3,
    first: false,
  };
  const seenByOthers = parseCharm(wire, 'Nutmeg');
  assert.equal(seenByOthers.mine, false, 'a stranger must not get the celebration');
  assert.equal(seenByOthers.by, 'Biscuit');
  assert.equal(seenByOthers.name, 'The Sunset Shell', 'the CHARM is named, never the finder');

  const seenByFinder = parseCharm(wire, 'biscuit');
  assert.equal(seenByFinder.mine, true);
  assert.equal(seenByFinder.name, 'The Sunset Shell');
  assert.equal(seenByFinder.id, 'shell');
  assert.equal(seenByFinder.where, 'Sandy Shores');
  assert.equal(seenByFinder.n, 3);
});

test('the charm line congratulates without ranking anyone', () => {
  assert.equal(charmLine(parseCharm({ charmName: 'X', name: 'Me', first: true }, 'Me')),
    'First to find it this week!');
  assert.equal(charmLine(parseCharm({ charmName: 'X', name: 'Me', n: 3 }, 'Me')),
    'The 3rd capy to find it this week.');
  assert.equal(charmLine(parseCharm({ charmName: 'X', name: 'Me', roomName: 'Sandy Shores' }, 'Me')),
    'It was tucked away in Sandy Shores.');
  assert.equal(charmLine(parseCharm({ name: 'X' }, 'Me')), 'One a week, and this one was yours.');
});

test("reads server/events.js's shipped frame() shape", () => {
  // exactly what server/events.js frame() emits, plural name and all
  const at = 1_900_000_000_000;
  const wire = {
    t: 'events',
    now: at,
    tz: 'America/New_York',
    rev: 4,
    active: [{
      id: 'golden-hour',
      name: 'Golden Hour',
      blurb: 'Coins are doubled at every game on the island.',
      icon: 'coins',
      badge: 'coins',
      rooms: [],
      oneoff: false,
      startedAt: at - 20 * MIN,
      endsAt: at + 40 * MIN,
      endsIn: 2400,
      effects: { coins: { mult: 2, reasons: ['sled', 'fishing'] } },
    }],
    next: {
      id: 'courier',
      name: 'The Courier',
      blurb: 'A new issue on the notice board.',
      icon: 'none',
      startsAt: at + 26 * 3600 * 1000,
      startsIn: 93600,
      endsAt: at + 27 * 3600 * 1000,
    },
    flags: {},
  };
  const s = parseEventFrame(wire, at);
  assert.equal(s.active.name, 'Golden Hour');
  assert.equal(s.active.until, at + 40 * MIN);
  assert.equal(s.active.badge, 'double coins', 'the badge is read off effects, not the icon word');
  assert.equal(s.next.name, 'The Courier');
  const v = pillView(s, at);
  assert.equal(v.time, '40m left');
  assert.equal(v.blurb, 'Coins are doubled at every game on the island.');
});
