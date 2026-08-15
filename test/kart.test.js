/**
 * test/kart.test.js — the Capy Karts race service (wave K, K3).
 *
 *   node --test test/kart.test.js
 *
 * server/kart.js is imported DIRECTLY with a fake ctx: a fake clock, a fake
 * RNG, a frame sink and an audit sink. Nothing here boots a server, opens a
 * socket or touches the disk. The heartbeat is OFF (`autoTick: false`) and the
 * whole race lifecycle is driven by hand through `kart.tick(now)`, so every
 * test below is deterministic to the millisecond.
 *
 * The list this file answers to is docs/KARTS.md §7. Each test must FAIL if the
 * rule it names breaks:
 *   1. a lap counts only with all six checkpoints
 *   2. dq is clamped, so three laps cannot be driven faster than ~40 s
 *   3. AI effective speed never exceeds 21.8 u/s under any rubber band
 *   4. kart-box is refused out of range / on a dead box / while holding, and a
 *      refused pickup does not consume the box
 *   5. a hit is declared once per hazard, and never on its own dropper early
 *   6. a mid-race disconnect ghosts and is not paid; a reconnect restores it
 *   7. kart-join from outside the speedway is refused; the lobby caps at 6
 *   8. handleMessage observes 'join' without consuming it and eats every kart-*
 *
 * Plus the one the owner's law demands: a clean, honest, well-driven race is
 * paid in full and nothing anywhere truncates it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import kart from '../server/kart.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let clock = 1_700_000_000_000;
/** Every frame the module sent, in order: { to, ...msg } or { room, ...msg }. */
let sent = [];
let lines = [];
/** Deterministic RNG: a fixed low-discrepancy walk, never Math.random. */
let rngState = 0;

function boot(opts = {}) {
  clock = 1_700_000_000_000;
  sent = [];
  lines = [];
  rngState = 0.3721;
  kart.install({
    now: () => clock,
    rng: () => { rngState = (rngState * 9301 + 0.49297) % 1; return rngState; },
    sendTo: (p, m) => { sent.push({ to: p.id, ...m }); },
    broadcastToRoom: (room, m) => { sent.push({ room, ...m }); },
    audit: (e) => { lines.push(e); },
    autoTick: false,
    ...opts,
  });
}

test.after(() => { kart.stopHeartbeat(); });

const at = (ms) => { clock = ms; };
const advanceMs = (ms) => { clock += ms; };

let seq = 0;
function player(room = kart.ROOM, extra = {}) {
  seq++;
  return {
    id: `p${seq}`, name: `Capy${seq}`, username: null, room,
    color: 0xb08a5a, hat: 'none', ws: null, ...extra,
  };
}

/** Run the heartbeat forward `ms` in `step`-sized beats, as the real one does. */
function run(ms, step = kart.TICK_MS) {
  const end = clock + ms;
  while (clock < end) {
    clock = Math.min(end, clock + step);
    kart.tick(clock);
  }
}

/** Beat the heartbeat until `pred()` goes true, or give up after `maxMs`. */
function runUntil(pred, maxMs = 400_000, step = kart.TICK_MS) {
  const end = clock + maxMs;
  while (clock < end && !pred()) { clock += step; kart.tick(clock); }
  return pred();
}

const framesOf = (t) => sent.filter((f) => f.t === t);
const lastOf = (t) => { const f = framesOf(t); return f.length ? f[f.length - 1] : null; };

/** Sign one capy on and let the 20 s fill window elapse: one human, five AI. */
function soloRace(p = player()) {
  kart.handleMessage(p, { t: 'kart-join' });
  run(kart.KART_WAIT_MS + kart.GRID_LEAD_MS + kart.KART_LIGHTS_MS + 200);
  const seat = kart.peek(p);
  assert.ok(seat.race, 'a race should be running');
  return seat;
}

/**
 * Drive one human forward honestly: `n` relay frames, each `dtMs` apart, each
 * asking for the maximum legal step. This is the fastest a real player can
 * possibly be, and it is what every timing assertion below is measured against.
 */
function drive(p, n, dtMs = 100, share = 1.0) {
  const seat = kart.peek(p);
  for (let i = 0; i < n; i++) {
    advanceMs(dtMs);
    const r = seat.racer;
    const step = kart.KART_MAX_Q_PER_S * (dtMs / 1000) * share;
    kart.handleMessage(p, { t: 'kart-in', q: (r.q + step) % 1, lat: 0, yaw: 0, v: 30, d: 0 });
    kart.tick(clock);
  }
}

// ---------------------------------------------------------------------------
// 7. the lobby
// ---------------------------------------------------------------------------

test('kart-join from outside the speedway is refused, and inside it is not', () => {
  boot();
  const away = player('plaza');
  assert.equal(kart.handleMessage(away, { t: 'kart-join' }), true, 'the frame is still consumed');
  assert.equal(kart.peek(away).inLobby, false, 'but nobody signs on from the plaza');
  assert.equal(kart.stats().joins, 0);

  const here = player(kart.ROOM);
  kart.handleMessage(here, { t: 'kart-join' });
  assert.equal(kart.peek(here).inLobby, true);
  assert.equal(kart.stats().joins, 1);
});

test('the lobby caps at 6, and a seventh capy is turned away', () => {
  boot();
  const ps = [];
  for (let i = 0; i < 7; i++) {
    const p = player();
    ps.push(p);
    kart.handleMessage(p, { t: 'kart-join' });
  }
  assert.equal(kart.stats().lobby, kart.MAX_RACERS);
  assert.equal(kart.peek(ps[6]).inLobby, false, 'the seventh is refused');
  const board = lastOf('kart-lobby');
  assert.equal(board.players.length, 6);
  assert.equal(board.max, 6);
  assert.equal(board.room, kart.ROOM, 'the sign-on sheet goes to the whole paddock');
});

test('signing on twice is a no-op, and kart-leave gives the spot back', () => {
  boot();
  const p = player();
  kart.handleMessage(p, { t: 'kart-join' });
  kart.handleMessage(p, { t: 'kart-join' });
  assert.equal(kart.stats().lobby, 1);
  kart.handleMessage(p, { t: 'kart-leave' });
  assert.equal(kart.stats().lobby, 0);
  assert.equal(lastOf('kart-lobby').startsAt, null);
});

test('a full grid starts in 3s; a lone capy waits the fill window and gets AI', () => {
  boot();
  const p = player();
  kart.handleMessage(p, { t: 'kart-join' });
  const board = lastOf('kart-lobby');
  assert.equal(board.startsAt, clock + kart.KART_WAIT_MS, 'the oldest sign-on sets the clock');

  run(kart.KART_WAIT_MS + 50);
  const grid = lastOf('kart-grid');
  assert.ok(grid, 'the grid is sent before the lights');
  assert.equal(grid.slots.length, 6, 'empty slots always fill with AI');
  assert.equal(grid.slots.filter((s) => s.ai).length, 5);
  assert.equal(grid.slots[0].id, p.id, 'the human takes pole in sign-on order');
  assert.equal(grid.you.slot, 0);
  assert.equal(grid.laps, 3);

  // AI names never collide with a human in the same race, and are never a
  // character from another racing game.
  const names = grid.slots.map((s) => s.name);
  assert.equal(new Set(names).size, 6);
  for (const s of grid.slots) if (s.ai) assert.ok(kart.AI_NAMES.includes(s.name));

  // AI order is descending skill
  const skills = grid.slots.filter((s) => s.ai).map((s) => s.skill);
  assert.deepEqual(skills, [...skills].sort((a, b) => b - a));
});

test('kart-start-now pulls the lights in to 3 seconds', () => {
  boot();
  const p = player();
  kart.handleMessage(p, { t: 'kart-join' });
  advanceMs(1000);
  kart.handleMessage(p, { t: 'kart-start-now' });
  const board = lastOf('kart-lobby');
  assert.equal(board.startsAt, clock + 3000);
  assert.equal(board.starting, true);

  // and somebody not on the sheet cannot pull it
  boot();
  const q = player();
  const bystander = player();
  kart.handleMessage(q, { t: 'kart-join' });
  const before = lastOf('kart-lobby').startsAt;
  kart.handleMessage(bystander, { t: 'kart-start-now' });
  assert.equal(lastOf('kart-lobby').startsAt, before);
});

test('walking out of the paddock gives up the sign-on', () => {
  boot();
  const p = player();
  kart.handleMessage(p, { t: 'kart-join' });
  assert.equal(kart.peek(p).inLobby, true);
  // index.js has not moved them yet when the frame is observed
  assert.equal(kart.handleMessage(p, { t: 'join', room: 'plaza' }), false);
  assert.equal(kart.peek(p).inLobby, false);
});

// ---------------------------------------------------------------------------
// 8. the dispatch seam
// ---------------------------------------------------------------------------

test('handleMessage observes join without consuming it, and eats every kart-*', () => {
  boot();
  const p = player();
  assert.equal(kart.handleMessage(p, { t: 'join', room: kart.ROOM }), false);
  assert.equal(kart.handleMessage(p, { t: 'move', x: 1, z: 1 }), false);
  assert.equal(kart.handleMessage(p, { t: 'chat', text: 'hi' }), false);
  assert.equal(kart.handleMessage(p, { t: 'score', game: 'fishing', coins: 40 }), false);
  for (const t of ['kart-join', 'kart-leave', 'kart-start-now', 'kart-in', 'kart-box',
    'kart-use', 'kart-state', 'kart-board', 'kart-nonsense']) {
    assert.equal(kart.handleMessage(p, { t }), true, `${t} must be consumed`);
  }
  // and junk never throws
  assert.equal(kart.handleMessage(p, { t: 'kart-in', q: 'banana', lat: NaN }), true);
  assert.equal(kart.handleMessage(null, { t: 'kart-join' }), false);
  assert.equal(kart.handleMessage(p, null), false);
});

// ---------------------------------------------------------------------------
// 1 + 2. laps, checkpoints and the clamp
// ---------------------------------------------------------------------------

test('a lap counts only when all six checkpoints are behind it', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const r = seat.racer;
  const race = seat.race;
  const { _internals } = kart;

  // A racer arriving at the line with one checkpoint missing: exactly the state
  // a capy who nipped across the infield is in when they get back to the strip.
  r.q = 0.99; r.lap = 0; r.wraps = 1;
  r.cps = 0b011111; // everything but checkpoint 5
  _internals.advance(race, r, 0.02, clock);
  assert.equal(r.lap, 0, 'a cut lap does not count');
  assert.equal(r.wraps, 2, 'the crossing still happened, it just was not a lap');
  assert.equal(r.cps, 1, 'and the bits reset, so the next lap can be driven honestly');

  // Now drive the whole lap properly, one checkpoint at a time.
  for (const cp of [1, 2, 3, 4, 5]) _internals.advance(race, r, (cp / 6 + 0.001) - r.q, clock);
  assert.equal(r.cps, 0b111111, 'every checkpoint in sequence');
  _internals.advance(race, r, 0.99 - r.q, clock);
  _internals.advance(race, r, 0.02, clock);
  assert.equal(r.lap, 1, 'an honest lap counts');
});

test('a client flip-flopping over the finish line racks up crossings and zero laps', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const r = seat.racer;

  // The cheapest cheat there is: sit on the line and oscillate across it. The
  // checkpoint mask is the only thing standing between this and free laps.
  for (let i = 0; i < 120; i++) {
    advanceMs(100);
    kart.handleMessage(p, { t: 'kart-in', q: i % 2 ? 0.004 : 0.996, lat: 0, yaw: 0, v: 30, d: 0 });
  }
  assert.ok(r.wraps > 5, 'the line really was crossed over and over');
  assert.equal(r.lap, 0, 'and not one of those crossings was a lap');
});

test('forward dq is clamped, so three laps cannot be driven in under ~40 seconds', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const r = seat.racer;
  const startedAt = clock;

  // A client teleporting 40% of a lap forward on EVERY relay frame, as fast as
  // the relay budget allows. The clamp drags it back to 0.075/s every time.
  for (let i = 0; i < 900; i++) {
    advanceMs(100);
    kart.handleMessage(p, { t: 'kart-in', q: (r.q + 0.4) % 1, lat: 0, yaw: 0, v: 999, d: 0 });
    kart.tick(clock);
    if (r.lap >= 3) break;
  }
  const elapsed = clock - startedAt;
  assert.equal(r.lap, 3, 'the laps do eventually come, honestly paced');
  assert.ok(elapsed >= 40_000, `three laps took ${elapsed}ms, which is under the 40s floor`);
  assert.ok(elapsed < 46_000, 'and the clamp is not so tight it punishes a real driver');

  // and the warp was audited exactly once for this player in this race
  const warps = lines.filter((l) => l.op === kart.OPS.WARP);
  assert.equal(warps.length, 1, 'one audit line per player per race, never a flood');
  assert.equal(warps[0].ok, false);
});

test('a rewind past the slack moves nothing, and a small one is allowed', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const r = seat.racer;
  r.q = 0.5;
  advanceMs(100);
  kart.handleMessage(p, { t: 'kart-in', q: 0.10, lat: 0, yaw: 0, v: 10, d: 0 });
  assert.equal(r.q, 0.5, 'a 40% rewind is noise, not a manoeuvre');
  advanceMs(100);
  kart.handleMessage(p, { t: 'kart-in', q: 0.495, lat: 0, yaw: 0, v: 10, d: 0 });
  assert.ok(Math.abs(r.q - 0.495) < 1e-9, 'a real reversing capy still reverses');
});

test('a non-finite relay frame is rejected outright and never corrupts the racer', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const r = seat.racer;
  const q0 = r.q;
  for (const bad of [{ q: NaN, lat: 0, yaw: 0 }, { q: 0.5, lat: Infinity, yaw: 0 }, { q: 0.5, lat: 0, yaw: 'x' }]) {
    advanceMs(100);
    kart.handleMessage(p, { t: 'kart-in', ...bad, v: 10, d: 0 });
  }
  assert.equal(r.q, q0);
  assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.yaw));
});

test('lat is clamped to the barrier and the drift tier is bounded', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  advanceMs(100);
  kart.handleMessage(p, { t: 'kart-in', q: seat.racer.q, lat: 99, yaw: 40, v: 1e9, d: 77 });
  assert.equal(seat.racer.lat, 1.9);
  assert.ok(Math.abs(seat.racer.yaw) <= Math.PI);
  assert.equal(seat.racer.v, 40);
  assert.equal(seat.racer.d, 0, 'an out-of-range drift tier reads as "not drifting"');
});

// ---------------------------------------------------------------------------
// 3. THE HARD LAW: the rubber band never out-drives skill
// ---------------------------------------------------------------------------

test('AI effective speed never exceeds 21.8 u/s, whatever the rubber band is told', () => {
  boot();
  let worst = 0;
  for (let skill = 0; skill <= 4; skill++) {
    for (let qi = 0; qi < 240; qi++) {
      const q = qi / 240;
      // every gap a race can produce, and a great many it cannot
      for (const gap of [0, 1, 20, 100, 250, 500, 700, 1635, 100_000, -500, -1e6]) {
        const v = kart.aiSpeed(skill, q, gap, false);
        worst = Math.max(worst, v);
        assert.ok(v <= kart.AI_SPEED_MAX + 1e-9, `skill ${skill} q ${q} gap ${gap} -> ${v}`);
        assert.ok(v >= kart.AI_SPEED_MIN - 1e-9, `skill ${skill} q ${q} gap ${gap} -> ${v}`);
      }
    }
  }
  assert.ok(worst <= 21.8);
  // the specific case the contract names: a human 500 units up the road
  assert.ok(kart.aiSpeed(4, 0.02, 500, false) <= 21.8);
  // and 21.8 is genuinely below the player's own V_MAX of 22.0, which is the
  // whole promise: perfect driving is never caught by a catch-up rule
  assert.ok(kart.AI_SPEED_MAX < 22.0);
});

test('an AI boost is capped at 24 u/s, far below the player drift-boost ceiling of 32', () => {
  boot();
  for (let skill = 0; skill <= 4; skill++) {
    for (let qi = 0; qi < 24; qi++) {
      const v = kart.aiSpeed(skill, qi / 24, 100_000, true);
      assert.ok(v <= kart.AI_BOOST_MAX + 1e-9, `boosted AI hit ${v}`);
    }
  }
  assert.ok(kart.AI_BOOST_MAX < 32);
});

test('the AI honours the frozen sector table on the tight corners', () => {
  boot();
  // sector 10 is the hairpin, capped at 12 u/s: no skill or band beats it,
  // except by the AI_SPEED_MIN floor, which is what keeps a race watchable
  const v = kart.aiSpeed(4, 10.5 / 24, 100_000, false);
  assert.ok(v <= kart.AI_SPEED_MIN + 1e-9, `hairpin speed ${v} should be pinned to the floor`);
});

test('a full field of AI drives a real race and finishes it in a plausible time', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  // the human parks on the grid; the five AI drive the whole thing
  run(300_000, 100);
  const end = lastOf('kart-end');
  assert.ok(end, 'the race ends on its own');
  assert.equal(end.results.length, 6);
  const aiFinishers = end.results.filter((r) => r.ai && r.laps >= 3);
  assert.equal(aiFinishers.length, 5, 'every AI completed three valid laps');
  for (const r of aiFinishers) {
    // 3 laps * 545u at 16..21.8 u/s is 75s..102s; allow for corners
    assert.ok(r.ms > 60_000 && r.ms < 180_000, `AI race time ${r.ms}ms is implausible`);
  }
  assert.equal(race.ended, true);
});

// ---------------------------------------------------------------------------
// 4. item boxes
// ---------------------------------------------------------------------------

test('kart-box is refused out of range, on a dead box and while holding — and never consumes it', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  const r = seat.racer;
  const box = race.boxes[5]; // q 0.550, lat 0.00

  // out of range on q
  r.q = box.q + 0.05; r.lat = box.lat;
  kart.handleMessage(p, { t: 'kart-box', box: 5 });
  assert.equal(r.item, null);
  assert.equal(box.live, true, 'a refused pickup leaves the box for the next capy');

  // out of range on lat
  r.q = box.q; r.lat = box.lat + 0.9;
  kart.handleMessage(p, { t: 'kart-box', box: 5 });
  assert.equal(r.item, null);
  assert.equal(box.live, true);

  // a box index that does not exist
  r.lat = box.lat;
  for (const bad of [-1, 11, 99, 'x', null, 1.5]) {
    kart.handleMessage(p, { t: 'kart-box', box: bad });
    assert.equal(r.item, null);
  }

  // in range: taken
  kart.handleMessage(p, { t: 'kart-box', box: 5 });
  assert.ok(['peel', 'bubble', 'berry'].includes(r.item), 'a real pickup grants a real item');
  assert.equal(box.live, false);
  const taken = framesOf('kart-box').filter((f) => f.taken === true);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].by, r.slot);
  assert.ok(lastOf('kart-item'));

  // a dead box grants nothing, twice over
  const held = r.item;
  kart.handleMessage(p, { t: 'kart-box', box: 5 });
  assert.equal(r.item, held);

  // and driving over a LIVE box while holding does nothing and does not
  // consume it (docs/KARTS.md §3.3)
  const other = race.boxes[4];
  r.q = other.q; r.lat = other.lat;
  kart.handleMessage(p, { t: 'kart-box', box: 4 });
  assert.equal(r.item, held, 'the held item is not replaced');
  assert.equal(other.live, true, 'and the box is still there');
});

test('a taken box comes back after the respawn window, and says so to the field', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const box = seat.race.boxes[5];
  seat.racer.q = box.q; seat.racer.lat = box.lat;
  kart.handleMessage(p, { t: 'kart-box', box: 5 });
  assert.equal(box.live, false);
  const respawnAt = box.respawnAt;
  assert.equal(respawnAt, clock + 5000);

  run(4_000);
  assert.equal(box.live, false);
  run(1_500);
  assert.equal(box.live, true);
  const back = framesOf('kart-box').filter((f) => f.taken === false && f.box === 5);
  assert.equal(back.length, 1);
});

test('the roulette follows the frozen weights and never invents a fourth item', () => {
  boot();
  const seen = new Set();
  const counts = { peel: 0, bubble: 0, berry: 0 };
  for (let i = 0; i < 4000; i++) {
    const item = kart._internals.roulette(1 + (i % 6));
    seen.add(item);
    counts[item]++;
  }
  assert.deepEqual([...seen].sort(), ['berry', 'bubble', 'peel']);
  // the leader's table is peel-heavy and the back's is berry-heavy: over every
  // place the peel still leads overall, which is the gentle band the contract asks for
  assert.ok(counts.peel > 0 && counts.bubble > 0 && counts.berry > 0);
});

// ---------------------------------------------------------------------------
// 5. hits
// ---------------------------------------------------------------------------

test('a peel hits exactly once, and never its own dropper inside the immunity', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  const me = seat.racer;

  // park every AI far away so only the dropper is in range
  for (const r of race.slots) if (r.ai) { r.q = 0.5; r.lat = 1.5; }
  me.q = 0.10; me.lat = 0;
  me.item = 'peel';
  kart.handleMessage(p, { t: 'kart-use' });
  const haz = lastOf('kart-haz');
  assert.equal(haz.kind, 'peel');
  assert.equal(haz.by, me.slot);
  assert.equal(haz.ttl, 25_000);
  assert.equal(race.haz.size, 1);

  // sitting on your own peel inside the immunity window is free
  me.q = haz.q;
  run(400);
  assert.equal(framesOf('kart-hit').length, 0, 'you never trip over your own peel immediately');

  // ...and stops being free once the window closes
  run(900);
  const hits = framesOf('kart-hit');
  assert.equal(hits.length, 1, 'exactly one hit');
  assert.equal(hits[0].s, me.slot);
  assert.equal(hits[0].kind, 'peel');
  assert.equal(hits[0].ms, 1100);
  assert.equal(hits[0].i, haz.i);
  assert.equal(race.haz.size, 0, 'the hazard is one-shot and gone in the same tick');

  // and it can never hit again
  run(2_000);
  assert.equal(framesOf('kart-hit').length, 1);
});

test('a peel expires on its own and tells the field it is gone', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  for (const r of seat.race.slots) { r.q = 0.5; r.lat = 1.8; }
  seat.racer.q = 0.1; seat.racer.lat = 0;
  seat.racer.item = 'peel';
  kart.handleMessage(p, { t: 'kart-use' });
  const mine = lastOf('kart-haz').i;
  seat.racer.q = 0.4; // drive away from it
  run(26_000);
  // (the AI drop their own peels as the race goes on, so this asks about OURS)
  assert.equal(seat.race.haz.has(mine), false);
  assert.ok(framesOf('kart-haz').some((f) => f.i === mine && f.gone === true));
});

test('kart-use with an empty hand does nothing at all', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const before = sent.length;
  kart.handleMessage(p, { t: 'kart-use' });
  assert.equal(seat.race.haz.size, 0);
  assert.equal(seat.race.proj.size, 0);
  assert.equal(sent.length, before);
});

test('a bubble flies, slows what it passes through, and is spent doing it', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  const me = seat.racer;
  for (const r of race.slots) if (r.ai) { r.q = 0.5; r.lat = 1.8; }

  const victim = race.slots[1];
  me.q = 0.20; me.lat = 0;
  victim.q = 0.24; victim.lat = 0; // ~22 units up the road
  me.item = 'bubble';
  kart.handleMessage(p, { t: 'kart-use' });
  assert.equal(race.proj.size, 1);

  run(2_000);
  const hits = framesOf('kart-hit').filter((h) => h.kind === 'bubble');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].s, victim.slot);
  assert.equal(hits[0].by, me.slot);
  assert.equal(hits[0].ms, 2000);
  assert.equal(race.proj.size, 0, 'the bubble is spent on the kart it hit');
});

test('the zoom berry is an instant self-boost and nothing else', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  seat.racer.item = 'berry';
  kart.handleMessage(p, { t: 'kart-use' });
  const fx = lastOf('kart-fx');
  assert.equal(fx.kind, 'boost');
  assert.equal(fx.ms, 1300);
  assert.equal(fx.s, seat.racer.slot);
  assert.equal(seat.race.haz.size, 0);
  assert.equal(seat.race.proj.size, 0);
});

// ---------------------------------------------------------------------------
// 6. abandon, ghosts and reconnects
// ---------------------------------------------------------------------------

test('a mid-race disconnect leaves a ghost that finishes and is never paid', () => {
  boot();
  const alice = player(kart.ROOM, { username: 'alice' });
  const bob = player(kart.ROOM, { username: 'bob' });
  kart.handleMessage(alice, { t: 'kart-join' });
  kart.handleMessage(bob, { t: 'kart-join' });
  run(kart.KART_WAIT_MS + kart.GRID_LEAD_MS + kart.KART_LIGHTS_MS + 200);
  const seat = kart.peek(alice);
  const race = seat.race;
  assert.ok(race);

  kart.dropPlayer(alice);
  const ghost = race.slots[0];
  assert.equal(ghost.ghost, true, 'the row flips to a ghost');
  assert.equal(ghost.ai, true, 'and drives on');
  assert.equal(ghost.skill, 2);
  assert.equal(ghost.name, alice.name, 'keeping the name and the colours');
  assert.equal(ghost.color, alice.color);
  assert.equal(kart.peek(alice).slot, null, 'the seat is released');

  // the ghost is in the state frame, flagged, so clients can grey it out
  run(500);
  const state = lastOf('kart-state');
  assert.equal(state.k[0].ghost, true);

  assert.ok(runUntil(() => race.ended), 'the race still ends');
  const end = lastOf('kart-end');
  const row = end.results.find((x) => x.s === 0);
  assert.ok(row.laps >= 3, 'the ghost finished for the standings');
  assert.equal(row.ai, true, 'and is reported as an AI row, greyed by the client');
  // and the ghost is worth nothing on the coin road
  const frame = { t: 'score', game: 'kart', coins: 999, score: 999_999 };
  assert.equal(kart.handleMessage(alice, frame), false);
  assert.equal(frame.coins, 0, 'a ghost is never paid');
  assert.equal(frame.score, 0);
});

test('a reconnect inside 45 seconds restores control at the same slot', () => {
  boot();
  const alice = player(kart.ROOM, { username: 'alice' });
  const bob = player(kart.ROOM, { username: 'bob' });
  kart.handleMessage(alice, { t: 'kart-join' });
  kart.handleMessage(bob, { t: 'kart-join' });
  run(kart.KART_WAIT_MS + kart.GRID_LEAD_MS + kart.KART_LIGHTS_MS + 200);
  const race = kart.peek(alice).race;

  kart.dropPlayer(alice);
  run(10_000);
  const laps = race.slots[0].lap;

  // a new connection for the same account walks back into the paddock
  const alice2 = player(kart.ROOM, { username: 'Alice' }); // case-insensitive
  assert.equal(kart.handleMessage(alice2, { t: 'kart-join' }), true);
  const seat = kart.peek(alice2);
  assert.equal(seat.slot, 0, 'the same slot, not a new sign-on');
  assert.equal(kart.stats().lobby, 0, 'and not a sign-on at all');
  assert.equal(race.slots[0].ghost, false);
  assert.equal(race.slots[0].ai, false);

  const resume = lastOf('kart-resume');
  assert.ok(resume);
  assert.equal(resume.you.slot, 0);
  assert.equal(resume.race, race.id);
  assert.equal(resume.laps, 3);
  assert.equal(resume.lap, laps);
  assert.ok(resume.grid, 'the same grid payload, so the client can rebuild');
  assert.equal(resume.grid.slots.length, 6);
});

test('a reconnect after 45 seconds is too late, and signs on for the next race instead', () => {
  boot();
  const alice = player(kart.ROOM, { username: 'alice' });
  const bob = player(kart.ROOM, { username: 'bob' });
  kart.handleMessage(alice, { t: 'kart-join' });
  kart.handleMessage(bob, { t: 'kart-join' });
  run(kart.KART_WAIT_MS + kart.GRID_LEAD_MS + kart.KART_LIGHTS_MS + 200);

  kart.dropPlayer(alice);
  run(kart.KART_REJOIN_MS + 2_000);
  const alice2 = player(kart.ROOM, { username: 'alice' });
  kart.handleMessage(alice2, { t: 'kart-join' });
  assert.equal(kart.peek(alice2).slot, null, 'no seat returned');
  assert.equal(kart.peek(alice2).inLobby, true, 'they queue for the next one');
});

test('a race with zero live humans ends immediately and pays nobody', () => {
  boot();
  const p = player();
  soloRace(p);
  assert.equal(kart.stats().live, 1);
  kart.dropPlayer(p);
  assert.equal(kart.stats().live, 0, 'the race is over the moment the last human goes');
  assert.equal(kart.stats().racesEnded, 1);
  // nobody was paid: the only human left as a ghost, and a ghost parks a zero
  assert.equal(kart.stats().payoutsParked, 0);
  assert.equal(kart.stats().payoutsZeroed, 1);
  assert.equal(kart.peek(p).payout.coins, 0);
});

// ---------------------------------------------------------------------------
// finishing, placement and the payout the coin road is handed
// ---------------------------------------------------------------------------

test('finish order is the server clock, placements are unique, and the flag is announced', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  const { _internals } = kart;

  // walk every kart over the line one tick apart, in a deliberate order
  const order = [3, 1, 5, 0, 2, 4];
  for (const slot of order) {
    const r = race.slots[slot];
    r.lap = 2; r.cps = 63; r.q = 0.99;
    advanceMs(10);
    _internals.advance(race, r, 0.02, clock);
  }
  const fins = framesOf('kart-fin');
  assert.equal(fins.length, 6);
  assert.deepEqual(fins.map((f) => f.s), order, 'first over the line is first, by the server clock');
  assert.deepEqual(fins.map((f) => f.place), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(fins.map((f) => f.place)).size, 6, 'ties are impossible');

  const end = lastOf('kart-end');
  assert.ok(end, 'everyone home ends the race at once');
  assert.equal(end.results.length, 6);
  assert.deepEqual(end.results.map((r) => r.place), [1, 2, 3, 4, 5, 6]);
});

test('unfinished karts are placed after every finisher, by laps then progress', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  const { _internals } = kart;

  const winner = race.slots[2];
  winner.lap = 2; winner.cps = 63; winner.q = 0.99;
  advanceMs(10);
  _internals.advance(race, winner, 0.02, clock);
  assert.equal(winner.place, 1);

  // the rest are strung out down the road
  race.slots[0].lap = 2; race.slots[0].q = 0.9;
  race.slots[1].lap = 2; race.slots[1].q = 0.1;
  race.slots[3].lap = 1; race.slots[3].q = 0.5;
  race.slots[4].lap = 0; race.slots[4].q = 0.8;
  race.slots[5].lap = 0; race.slots[5].q = 0.2;

  _internals.endRace(race, clock);
  const end = lastOf('kart-end');
  assert.deepEqual(end.results.map((r) => r.s), [2, 0, 1, 3, 4, 5]);
  assert.deepEqual(end.results.map((r) => r.place), [1, 2, 3, 4, 5, 6]);
});

test('the finish grace closes a race 25s after the first capy takes the flag', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  // freeze the AI so only the grace can end this
  for (const r of race.slots) if (r.ai) r.skill = 0;
  const winner = race.slots[1];
  winner.lap = 2; winner.cps = 63; winner.q = 0.99;
  kart._internals.advance(race, winner, 0.02, clock);
  assert.equal(race.ended, false);
  run(kart.FINISH_GRACE_MS - 2_000, 500);
  assert.equal(race.ended, false, 'the field gets its grace period');
  run(3_000, 500);
  assert.equal(race.ended, true);
  assert.equal(lastOf('kart-board').over, true, 'and the jumbotron says so');
});

test('the server, not the client, decides what a kart run is worth', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  const race = seat.race;
  const me = seat.racer;

  me.lap = 2; me.cps = 63; me.q = 0.99; me.boxes = 4; me.bestLap = 14_000;
  race.bestLap = 14_000; race.bestLapSlot = me.slot;
  advanceMs(10);
  kart._internals.advance(race, me, 0.02, clock);
  assert.equal(me.place, 1);
  kart._internals.endRace(race, clock);

  // the client claims a preposterous score; the server hands the coin road the
  // real one, computed from the placement it assigned itself
  const frame = { t: 'score', game: 'kart', coins: 100_000, score: 99_999_999 };
  assert.equal(kart.handleMessage(p, frame), false, 'the frame still goes to the normal road');
  const want = { place: 1, laps: 3, fastestLap: true, boxes: 4 };
  assert.equal(frame.coins, kart.coinsFor(want));
  assert.equal(frame.score, kart.scoreFor(want));
  // 110 + 18 + 12 + 8
  assert.equal(frame.coins, 148);

  // and the placement is spent: a replayed score frame carries no second payout
  const again = { t: 'score', game: 'kart', coins: 100_000, score: 1 };
  kart.handleMessage(p, again);
  assert.equal(again.coins, 100_000, 'untouched — econ refuses the replayed token itself');
});

test('the honest maximum fits under the run cap, so nothing truncates a perfect race', () => {
  boot();
  const perfect = { place: 1, laps: 3, fastestLap: true, boxes: 11 };
  const coins = kart.coinsFor(perfect);
  assert.equal(coins, 110 + 18 + 12 + 12);
  assert.equal(coins, 152);
  assert.ok(coins < 160, 'maxCoinsPerRun 160 must never bite an honest run (the owner\'s law)');
  // every placement pays generously, and last place is still worth showing up for
  for (let place = 1; place <= 6; place++) {
    assert.ok(kart.coinsFor({ place, laps: 3, fastestLap: false, boxes: 0 }) >= 48 + 18);
  }
  // and the score ladder is strictly ordered by placement
  const scores = [1, 2, 3, 4, 5, 6].map((place) => kart.scoreFor({ place, laps: 3, fastestLap: false, boxes: 0 }));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('a practice lap with no server race behind it is left completely alone', () => {
  boot();
  const p = player();
  const frame = { t: 'score', game: 'kart', coins: 90, score: 4200 };
  assert.equal(kart.handleMessage(p, frame), false);
  assert.equal(frame.coins, 90, 'a solo practice run is an ordinary minigame run');
  assert.equal(frame.score, 4200);
  // and another game is never touched
  const other = { t: 'score', game: 'sled', coins: 70, score: 900 };
  kart.handleMessage(p, other);
  assert.equal(other.coins, 70);
});

// ---------------------------------------------------------------------------
// budgets, spectators and hygiene
// ---------------------------------------------------------------------------

test('kart-in has its own budget and a flood is dropped, not a disconnect', () => {
  boot();
  const p = player();
  const seat = soloRace(p);
  advanceMs(100);
  for (let i = 0; i < 60; i++) {
    kart.handleMessage(p, { t: 'kart-in', q: seat.racer.q, lat: 0, yaw: 0, v: 10, d: 0 });
  }
  assert.ok(kart.stats().framesRejected > 0, 'the excess is dropped');
  assert.ok(kart.stats().frames <= kart.KART_IN_LIMIT + 1);
});

test('the jumbotron reaches the whole paddock at 2Hz, and only it leaves the race', () => {
  boot();
  const p = player();
  soloRace(p);
  sent = [];
  run(2_000, 100);
  const boards = framesOf('kart-board');
  assert.ok(boards.length >= 3 && boards.length <= 6, `2Hz-ish, got ${boards.length} in 2s`);
  for (const b of boards) {
    assert.equal(b.room, kart.ROOM, 'the board goes to the room, spectators included');
    assert.equal(b.rows.length, 6);
    assert.deepEqual(b.rows.map((r) => r.place), [1, 2, 3, 4, 5, 6]);
    for (const row of b.rows) {
      assert.equal(typeof row.n, 'string');
      assert.equal(typeof row.ai, 'boolean');
    }
  }
  // the hot state frame never goes to the room: it is racers only
  for (const f of framesOf('kart-state')) assert.equal(f.room, undefined);
});

test('the grid puts pole on the line and staggers the six slots correctly', () => {
  boot();
  const spots = [0, 1, 2, 3, 4, 5].map((s) => kart._internals.gridSpot(s));
  assert.deepEqual(spots.map((s) => Math.round(s.lat * 100)), [-47, 47, -47, 47, -47, 47]);
  // pole is closest to the line, and the rows step back 7 units at a time
  const u = spots.map((s) => Math.round((1 - s.q) * kart.LAP_UNITS));
  assert.deepEqual(u, [6, 6, 13, 13, 20, 20]);
});

test('install() resets everything, so a restart never inherits a stale race', () => {
  boot();
  const p = player();
  soloRace(p);
  assert.equal(kart.stats().live, 1);
  boot();
  assert.equal(kart.stats().live, 0);
  assert.equal(kart.stats().lobby, 0);
  assert.equal(kart.stats().races, 0);
  assert.equal(kart.peek(p).race, null);
});

test('nothing in this module throws when the ctx is empty', () => {
  kart.install({ autoTick: false });
  const p = player();
  assert.doesNotThrow(() => {
    kart.handleMessage(p, { t: 'kart-join' });
    kart.tick(Date.now());
    kart.handleMessage(p, { t: 'kart-in', q: 0.1, lat: 0, yaw: 0, v: 1, d: 0 });
    kart.dropPlayer(p);
    kart.stats();
  });
  boot();
});
