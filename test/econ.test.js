/**
 * test/econ.test.js — the economy guards (wave 11, N-16/N-18/N-19).
 *
 *   node --test test/econ.test.js
 *
 * server/econ.js is imported DIRECTLY with a fake ctx: a fake clock, a toast
 * sink and an audit sink. Nothing here boots a server or opens a socket.
 *
 * Half of these tests exist to prove a refusal. The other half exist to prove
 * the module does NOT refuse: the law of this wave is that honest grinding
 * always pays, so "two hundred honest runs in a row, every one paid" is as
 * load-bearing a test as any of the anti-cheat ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import econ from '../server/econ.js';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let clock = 1_700_000_000_000;
let toasts = [];
let lines = [];

function boot(opts = {}) {
  clock = 1_700_000_000_000;
  toasts = [];
  lines = [];
  econ.install({
    now: () => clock,
    sendTo: (p, m) => { toasts.push({ to: p.id, ...m }); },
    audit: (e) => { lines.push(e); },
    ...opts,
  });
}

const tick = (ms) => { clock += ms; };

let seq = 0;
function player(room = 'beach', extra = {}) {
  return { id: `p${++seq}`, name: `Capy${seq}`, username: null, room, match: null, ...extra };
}

const ops = (op) => lines.filter((l) => l.op === op);

/** One honest run of `game` in its own room, start to paid. */
function honestRun(p, game, score = 100) {
  econ.arm(p, game);
  tick(econ.minRunMs(game) + 250);
  return econ.claimRun(p, { game, score });
}

// ---------------------------------------------------------------------------
// run tokens
// ---------------------------------------------------------------------------

test('an honest run pays, and the token is bound to the game room', () => {
  boot();
  const p = player('beach');
  const claim = honestRun(p, 'fishing');
  assert.equal(claim.ok, true);
  assert.equal(claim.game, 'fishing');
  assert.equal(toasts.length, 0, 'an honest run says nothing');
  assert.equal(lines.length, 0, 'an honest run writes no anomaly');
});

test('honest grinding is never capped: two hundred runs, two hundred payouts', () => {
  boot();
  const p = player('beach');
  let paid = 0;
  for (let i = 0; i < 200; i++) if (honestRun(p, 'fishing').ok) paid++;
  assert.equal(paid, 200, 'there is no daily cap, no rolling cap, no ceiling');
  assert.equal(lines.length, 0);
});

test('a score with no armed run is refused, toasted and audited', () => {
  boot();
  const p = player('beach');
  const claim = econ.claimRun(p, { game: 'fishing', score: 999 });
  assert.equal(claim.ok, false);
  assert.equal(claim.code, 'token');
  assert.equal(toasts.length, 1);
  assert.equal(ops(econ.OPS.TOKEN).length, 1);
});

test('a replayed token is refused with its own audit line', () => {
  boot();
  const p = player('beach');
  assert.equal(honestRun(p, 'fishing').ok, true);
  const again = econ.claimRun(p, { game: 'fishing', score: 100 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'replay');
  assert.equal(ops(econ.OPS.REPLAY).length, 1);
  assert.equal(ops(econ.OPS.TOKEN).length, 0, 'a spent token is a replay, not a missing one');
});

test('an impossible duration is refused and audited, and does NOT eat the run', () => {
  boot();
  const p = player('peak');
  econ.arm(p, 'sled');
  tick(2_000); // "a ninety-second sled run finishing in two seconds"
  const early = econ.claimRun(p, { game: 'sled', score: 4000 });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'fast');
  assert.equal(ops(econ.OPS.DURATION).length, 1);
  assert.equal(ops(econ.OPS.DURATION)[0].args.floor, econ.minRunMs('sled'));

  // the honest reading of an early frame is a lagged one: the same run, claimed
  // once the clock says it could have happened, still pays
  tick(econ.minRunMs('sled'));
  assert.equal(econ.claimRun(p, { game: 'sled', score: 4000 }).ok, true);
});

test('arming twice replaces the token and never stacks a second payout', () => {
  boot();
  const p = player('peak');
  econ.arm(p, 'sled');
  tick(4_000);
  econ.arm(p, 'sled'); // the clock restarts here
  tick(econ.minRunMs('sled') - 1_000);
  assert.equal(econ.claimRun(p, { game: 'sled', score: 10 }).ok, false, 'the replacement restarts the clock');
  tick(2_000);
  assert.equal(econ.claimRun(p, { game: 'sled', score: 10 }).ok, true);
  assert.equal(econ.claimRun(p, { game: 'sled', score: 10 }).ok, false, 'two arms are still one payout');
});

test('a run token is bound to the room the game lives in', () => {
  boot();
  const p = player('cafe');
  assert.equal(econ.arm(p, 'sled'), null, 'the sled does not run in the cafe');
  assert.equal(ops(econ.OPS.ROOM).length, 1);
  assert.equal(econ.peek(p).run, null);

  // and a capy who wanders off mid-run cannot claim from the new room
  const q = player('peak');
  econ.arm(q, 'sled');
  tick(econ.minRunMs('sled') + 100);
  q.room = 'cafe';
  const claim = econ.claimRun(q, { game: 'sled', score: 500 });
  assert.equal(claim.ok, false);
  assert.equal(claim.code, 'room');
});

test('an unset room at arm time is tolerated: the reconnect race is not a cheat', () => {
  boot();
  const p = player(null);
  assert.notEqual(econ.arm(p, 'sled'), null);
  assert.equal(ops(econ.OPS.ROOM).length, 0);
  p.room = 'peak'; // the join lands a beat later
  tick(econ.minRunMs('sled') + 100);
  assert.equal(econ.claimRun(p, { game: 'sled', score: 500 }).ok, true);
});

test('a run for a game in another room, claimed from the wrong game, is refused', () => {
  boot();
  const p = player('beach');
  econ.arm(p, 'fishing');
  tick(econ.minRunMs('fishing') + 100);
  const claim = econ.claimRun(p, { game: 'smoothie', score: 1 });
  assert.equal(claim.ok, false);
  assert.equal(claim.code, 'token');
});

test('handleMessage consumes mgstart and nothing else', () => {
  boot();
  const p = player('beach');
  assert.equal(econ.handleMessage(p, { t: 'mgstart', game: 'fishing' }), true);
  assert.equal(econ.peek(p).run.game, 'fishing');
  assert.equal(econ.handleMessage(p, { t: 'score', game: 'fishing' }), false);
  assert.equal(econ.handleMessage(p, { t: 'chat', text: 'hi' }), false);
  assert.equal(econ.handleMessage(p, { t: 'mgstart', game: 'not-a-game' }), true);
  assert.equal(econ.peek(p).run.game, 'fishing', 'an unknown game does not clear a live token');
});

test('anomaly lines coalesce so a script cannot flood the log that caught it', () => {
  boot();
  const p = player('beach');
  for (let i = 0; i < 50; i++) econ.claimRun(p, { game: 'fishing', score: 1 });
  assert.equal(ops(econ.OPS.TOKEN).length, 1);
  tick(econ.ANOMALY_COOLDOWN_MS + 1_000);
  econ.claimRun(p, { game: 'fishing', score: 1 });
  const written = ops(econ.OPS.TOKEN);
  assert.equal(written.length, 2);
  assert.equal(written[1].args.repeats, 49, 'the suppressed lines are counted, not lost');
});

// ---------------------------------------------------------------------------
// best, bound to a paid run
// ---------------------------------------------------------------------------

test('a best is parked on the live run and handed back once the run is paid', () => {
  boot();
  const p = player('beach');
  econ.arm(p, 'fishing');
  // the client sends best BEFORE score (src/core/game.js reportMinigame)
  const noted = econ.noteBest(p, { game: 'fishing', score: 820 });
  assert.equal(noted.ok, false);
  assert.equal(noted.parked, true);
  tick(econ.minRunMs('fishing') + 100);
  const claim = econ.claimRun(p, { game: 'fishing', score: 820 });
  assert.equal(claim.ok, true);
  assert.equal(claim.best, 820);
});

test('a best with no run behind it is refused, and one just after payout is honoured', () => {
  boot();
  const p = player('beach');
  assert.equal(econ.noteBest(p, { game: 'fishing', score: 9_000_000 }).ok, false);
  honestRun(p, 'fishing');
  assert.equal(econ.noteBest(p, { game: 'fishing', score: 500 }).ok, true, 'inside the grace window');
  tick(60_000);
  assert.equal(econ.noteBest(p, { game: 'fishing', score: 500 }).ok, false, 'long past it');
});

// ---------------------------------------------------------------------------
// den duels
// ---------------------------------------------------------------------------

function duel(game = 'chess', room = 'loft') {
  const a = player(room, { username: 'alice' });
  const b = player(room, { username: 'bob' });
  const match = { game, seats: [a.id, b.id], ended: false };
  a.match = match; b.match = match;
  econ.matchStarted(match, [a, b]);
  return { a, b, match };
}

function playOut({ a, b, match }, moves = 10) {
  for (let i = 0; i < moves; i++) { econ.matchMove(a); econ.matchMove(b); }
  tick(econ.duelFloors(match.game).ms + 1_000);
}

test('an honest duel pays the winner', () => {
  boot();
  const d = duel('chess');
  playOut(d);
  const v = econ.duelPayout(d.match, d.a.id, 'done');
  assert.equal(v.pay, true);
  assert.equal(v.signal, true);
  assert.equal(v.bonus, true);
  assert.equal(lines.length, 0);
});

test('a duel shorter than the game takes to play pays nothing and is audited', () => {
  boot();
  const d = duel('chess');
  for (let i = 0; i < 10; i++) { econ.matchMove(d.a); econ.matchMove(d.b); }
  tick(1_500);
  const v = econ.duelPayout(d.match, d.a.id, 'done');
  assert.equal(v.pay, false);
  assert.equal(v.signal, false, 'a match that could not have happened did not happen');
  assert.equal(v.why, 'too-fast');
  assert.equal(ops(econ.OPS.DUEL)[0].args.kind, 'too-fast');
});

test('a winner who never touched the board pays nothing, but a forfeit is exempt', () => {
  boot();
  const d = duel('connect4', 'lounge');
  tick(econ.duelFloors('connect4').ms + 1_000);
  const v = econ.duelPayout(d.match, d.a.id, 'done');
  assert.equal(v.pay, false);
  assert.equal(v.why, 'too-few-moves');

  const e = duel('connect4', 'lounge');
  tick(econ.duelFloors('connect4').ms + 1_000);
  const f = econ.duelPayout(e.match, e.a.id, 'forfeit');
  assert.equal(f.pay, true, 'the capy who stayed put may honestly not have moved yet');
});

test('a hot pair is LOG-ONLY: every win pays, the pattern goes to the audit trail', () => {
  boot();
  let paid = 0;
  let flagged = 0;
  for (let i = 0; i < 15; i++) {
    const a = player('loft', { username: 'alice' });
    const b = player('loft', { username: 'bob' });
    const match = { game: 'chess', seats: [a.id, b.id], ended: false };
    a.match = match; b.match = match;
    econ.matchStarted(match, [a, b]);
    for (let k = 0; k < 10; k++) { econ.matchMove(a); econ.matchMove(b); }
    tick(econ.duelFloors('chess').ms + 1_000);
    const v = econ.duelPayout(match, a.id, 'done');
    assert.equal(v.pay, true, 'two friends playing chess all evening is honest play; NEVER refuse the coins');
    assert.equal(v.signal, true, 'the match always counts for quests, stamps and the ladder');
    paid++;
    if (v.why === 'pair-hot') flagged++;
  }
  assert.equal(paid, 15, 'the owner\'s law: no cap on honest play, ever');
  assert.ok(flagged >= 1, 'the pattern is still surfaced to the audit trail for a person to judge');
});

test('a fresh opponent is never cooled by somebody else"s pair', () => {
  boot();
  for (let i = 0; i < 14; i++) {
    const a = player('loft', { username: 'alice' });
    const b = player('loft', { username: 'bob' });
    const match = { game: 'chess', seats: [a.id, b.id] };
    a.match = match; b.match = match;
    econ.matchStarted(match, [a, b]);
    for (let k = 0; k < 10; k++) { econ.matchMove(a); econ.matchMove(b); }
    tick(econ.duelFloors('chess').ms + 1_000);
    econ.duelPayout(match, a.id, 'done');
  }
  const a = player('loft', { username: 'alice' });
  const c = player('loft', { username: 'carol' });
  const match = { game: 'chess', seats: [a.id, c.id] };
  a.match = match; c.match = match;
  econ.matchStarted(match, [a, c]);
  for (let k = 0; k < 10; k++) { econ.matchMove(a); econ.matchMove(c); }
  tick(econ.duelFloors('chess').ms + 1_000);
  assert.equal(econ.duelPayout(match, a.id, 'done').pay, true);
});

test('a draw pays nobody and an untracked match pays anyway', () => {
  boot();
  const d = duel('pong', 'lounge');
  playOut(d, 20);
  assert.equal(econ.duelPayout(d.match, 'draw', 'done').pay, false);
  // a match that began before this module was wired: when econ does not know,
  // the player gets the coins
  const stray = { game: 'pong', seats: ['x', 'y'] };
  const v = econ.duelPayout(stray, 'x', 'done');
  assert.equal(v.pay, true);
  assert.equal(v.why, 'untracked');
});

// ---------------------------------------------------------------------------
// the tables themselves
// ---------------------------------------------------------------------------

test('every minigame has a run floor, and every den game has duel floors', () => {
  boot();
  for (const id of Object.keys(econ.MIN_RUN_MS)) {
    assert.ok(econ.minRunMs(id) > 0, `${id} has a run floor`);
  }
  for (const id of Object.keys(econ.DUEL_FLOORS)) {
    const f = econ.duelFloors(id);
    assert.ok(f.ms > 0 && f.moves > 0, `${id} has duel floors`);
  }
});

test('nothing in this module counts coins per day', () => {
  boot();
  const s = econ.stats();
  assert.equal(s.caps, 'none');
  assert.equal(Object.keys(s).some((k) => /daily|cap(?!s)/i.test(k)), false);
});
