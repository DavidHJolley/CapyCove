/**
 * server/admin.js: the capability matrix, the one gate every op asks, the
 * banMessage contract that has already cost this project one outage, and the
 * first-refusal hook that eats a muted player's chat before index.js can see it.
 *
 *   node --test test/
 *
 * Driven through the real entry points with the ctx hooks index.js supplies
 * (sendTo, broadcastAll, sessionsFor, recordFor, findEntity, world, audit).
 * db.js is the real module, so the roles being checked here are the ones that
 * ship. Nothing starts a server and nothing opens a socket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-admin-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const admin = await import('../server/admin.js');
const auth = await import('../server/auth.js');
const db = await import('../server/db.js');

const {
  CAPS, RANK, capsFor, requireCap, rankOf, atLeast, profileBits, banMessage,
  handleMessage, performOp, actorFrom, MUTED_FRAMES,
} = admin;
const { users, banActive } = db;

// --- a fake island ---------------------------------------------------------
const sent = [];
const broadcast = [];
const closed = [];

function mkRec(username, role = 'player') {
  users.set(username.toLowerCase(), { username, role, coins: 0, created: Date.now() });
  return users.get(username.toLowerCase());
}
const adminRec = mkRec('DavidEdge', 'admin');
const modRec = mkRec('Modsy', 'mod');
const playerRec = mkRec('Norm', 'player');

let seq = 0;
/** A live ws connection in the shape index.js builds on `hello`. */
const conn = (name, rec) => ({
  id: `p${++seq}`,
  ws: { readyState: 1, close: (code, why) => closed.push({ code, why }) },
  bot: false,
  registered: !!rec,
  username: rec ? rec.username : null,
  name,
});

/** Every connection the fake island currently holds. */
const live = [];

admin.install({
  sendTo: (p, msg) => sent.push({ to: p.id, msg }),
  broadcastAll: (msg) => broadcast.push(msg),
  sessionsFor: (key) => live.filter((p) => (p.username || '').toLowerCase() === key),
  recordFor: (p) => (p.username ? users.get(p.username.toLowerCase()) || null : null),
  findEntity: (id) => live.find((p) => p.id === id) || null,
  world: { players: new Map(), rooms: new Map() },
  audit: () => {},
});

const last = (p) => [...sent].reverse().find((s) => s.to === p.id)?.msg;
const countFor = (p) => sent.filter((s) => s.to === p.id).length;

const MIN = 60_000;

/* ── the capability matrix ──────────────────────────────────────────────── */

test('capsFor is the whole matrix, and hands back a fresh array every time', () => {
  assert.deepEqual(capsFor('player'), []);
  assert.deepEqual(capsFor('mod'), ['who', 'inspect', 'mute', 'kick', 'ban', 'tp', 'announce']);
  assert.deepEqual(capsFor('admin'), [...CAPS]);
  // an unknown or missing role is a player, never a crash and never an upgrade
  for (const junk of ['wizard', '', null, undefined, 42]) {
    assert.deepEqual(capsFor(junk), [], String(junk));
  }
  const a = capsFor('admin');
  a.push('root');
  assert.deepEqual(capsFor('admin'), [...CAPS], 'the cached cap list was mutated by a caller');
});

test('a mod holds neither ban-perm nor editor', () => {
  // Reversing a call is a supervisor act, and `editor` is the gate that
  // replaced the old display-name backdoor.
  assert.equal(capsFor('mod').includes('ban-perm'), false);
  assert.equal(capsFor('mod').includes('unban'), false);
  assert.equal(capsFor('mod').includes('editor'), false);
  assert.equal(capsFor('admin').includes('editor'), true);
});

test('requireCap accepts a record, an actor or a live connection', () => {
  assert.equal(requireCap(adminRec, 'editor'), true);
  assert.equal(requireCap(modRec, 'mute'), true);
  assert.equal(requireCap(modRec, 'editor'), false);
  assert.equal(requireCap(playerRec, 'who'), false);
  assert.equal(requireCap(actorFrom(conn('DavidEdge', adminRec)), 'ban-perm'), true);
  assert.equal(requireCap(conn('DavidEdge', adminRec), 'ban-perm'), true, 'a live connection resolves through recordFor');
  // a guest has no record and can never be privileged
  assert.equal(requireCap(conn('Guesty', null), 'who'), false);
  // junk in, false out
  for (const junk of [null, undefined, 'admin', 42, {}]) assert.equal(requireCap(junk, 'who'), false, String(junk));
  assert.equal(requireCap(adminRec, ''), false, 'an empty cap is not a cap');
  assert.equal(requireCap(adminRec, 'become-owner'), false, 'an unknown cap is never granted');
});

test('rank is an ordered ladder and atLeast reads it', () => {
  assert.deepEqual(RANK, { player: 0, mod: 1, admin: 2 });
  assert.equal(rankOf(adminRec), 2);
  assert.equal(rankOf('mod'), 1);
  assert.equal(rankOf({ role: 'wizard' }), 0);
  assert.equal(rankOf(null), 0);
  assert.equal(atLeast(modRec, 'mod'), true);
  assert.equal(atLeast(modRec, 'admin'), false);
  assert.equal(atLeast(playerRec, 'mod'), false);
});

test('profileBits is what rides the welcome frame', () => {
  const bits = profileBits(modRec);
  assert.equal(bits.role, 'mod');
  assert.deepEqual(bits.caps, capsFor('mod'));
  assert.equal(bits.muteUntil, 0);
  const muted = mkRec('Quiet');
  muted.mute = { until: Date.now() + MIN, by: 'Modsy', reason: 'spam' };
  assert.ok(profileBits(muted).muteUntil > Date.now());
  // publicProfile merges these in, so a call site that forgot cannot exist
  const p = auth.publicProfile(adminRec);
  assert.equal(p.role, 'admin');
  assert.deepEqual(p.caps, [...CAPS]);
});

/* ── banMessage: the contract that has to be read before it is used ─────── */

test('admin.banMessage returns a STRING even for a clean record', () => {
  // THE regression. `admin.banMessage(rec)` is never falsy, so a hello gate
  // written as `const banned = admin.banMessage(rec); if (banned) deny()`
  // denies every clean login on the island. The gate must ask banActive first
  // (server/index.js does exactly that), and this pins the trap in place.
  const clean = mkRec('Innocent');
  assert.equal(banActive(clean), null);
  const msg = banMessage(clean);
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 0, 'banMessage went falsy: the hello gate could now be written wrong safely');
  assert.match(msg, /not banned/i);

  // The two shapes of the gate, side by side.
  const wrongGate = (rec) => !!banMessage(rec);
  const rightGate = (rec) => (banActive(rec) ? banMessage(rec) : null);
  assert.equal(wrongGate(clean), true, 'the naive gate denies a clean account');
  assert.equal(rightGate(clean), null, 'the shipped gate lets it through');

  const banned = mkRec('Nope');
  banned.ban = { until: Date.now() + 2 * 60 * MIN, by: 'DavidEdge', reason: 'griefing', at: Date.now() };
  assert.ok(rightGate(banned));
  assert.match(banMessage(banned), /another 2 hours/);
  assert.match(banMessage(banned), /griefing/);

  const forever = mkRec('NopeForever');
  forever.ban = { until: 'forever', by: 'DavidEdge', reason: '', at: Date.now() };
  assert.equal(banMessage(forever), 'This account is banned.');
});

test('admin.banMessage and auth.banMessage do NOT agree on a clean record', () => {
  // Two exports, one name, two contracts. Anything that swaps one for the
  // other has to notice; that is what this assertion is for.
  const clean = mkRec('Twoface');
  assert.equal(auth.banMessage(clean), '');
  assert.notEqual(banMessage(clean), '');
});

/* ── the first-refusal hook ─────────────────────────────────────────────── */

test('handleMessage releases everything it does not own', () => {
  const p = conn('Norm', playerRec);
  live.push(p);
  for (const t of ['chat', 'move', 'join', 'score', 'emote', 'a-notanop']) {
    assert.equal(handleMessage(p, { t }), false, t);
  }
  assert.equal(handleMessage(p, null), false);
  assert.equal(handleMessage(p, { t: 42 }), false);
  assert.equal(handleMessage(null, { t: 'chat' }), false);
});

test('a mute eats exactly the social frames, and says so once a minute', () => {
  const rec = mkRec('Muted');
  rec.mute = { until: Date.now() + 30 * MIN, by: 'Modsy', reason: 'spamming' };
  const p = conn('Muted', rec);
  live.push(p);

  for (const t of MUTED_FRAMES) {
    assert.equal(handleMessage(p, { t }), true, `${t} must never reach index.js`);
  }
  const toast = last(p);
  assert.equal(toast.t, 'toast');
  assert.match(toast.msg, /muted/i);
  assert.match(toast.msg, /spamming/);
  assert.equal(countFor(p), 1, 'a muted player is told once, not once a keystroke');

  // mute is not a jail: they still walk, wave, play and earn
  for (const t of ['move', 'emote', 'join', 'score', 'buy']) {
    assert.equal(handleMessage(p, { t }), false, t);
  }
});

test('an expired mute is not a mute', () => {
  const rec = mkRec('Unmuted');
  rec.mute = { until: Date.now() - MIN, by: 'Modsy', reason: '' };
  const p = conn('Unmuted', rec);
  assert.equal(handleMessage(p, { t: 'chat' }), false);
});

test('a guest is never muted by a record they do not have', () => {
  const p = conn('Guesty', null);
  assert.equal(handleMessage(p, { t: 'chat' }), false);
});

test('a banned session is told why and closed, and move frames still escape', () => {
  const rec = mkRec('Bannedy');
  rec.ban = { until: Date.now() + 60 * MIN, by: 'DavidEdge', reason: 'cheating', at: Date.now() };
  const p = conn('Bannedy', rec);
  live.push(p);
  const before = closed.length;

  assert.equal(handleMessage(p, { t: 'move' }), false, 'the 10Hz hot path is never inspected');
  assert.equal(handleMessage(p, { t: 'chat' }), true);
  const msg = last(p);
  assert.equal(msg.t, 'denied');
  assert.match(msg.msg, /banned/i);
  assert.equal(closed.length, before + 1);
  assert.equal(closed[closed.length - 1].code, 4001);
});

test('an unprivileged a-* frame is consumed in silence', () => {
  const p = conn('Norm', playerRec);
  live.push(p);
  const before = countFor(p);
  assert.equal(handleMessage(p, { t: 'a-ban', name: 'DavidEdge' }), true, 'the frame must not reach the main switch');
  assert.equal(countFor(p), before, 'a probe learns nothing, not even that the op exists');
});

test('an admin op runs, answers a-ok and reaches the island', () => {
  const p = conn('DavidEdge', adminRec);
  live.push(p);
  const before = broadcast.length;
  assert.equal(handleMessage(p, { t: 'a-announce', text: 'The bonfire is lit!' }), true);
  const ack = last(p);
  assert.equal(ack.t, 'a-ok');
  assert.equal(ack.op, 'a-announce');
  assert.equal(broadcast.length, before + 1);
  const out = broadcast[broadcast.length - 1];
  assert.equal(out.t, 'announce');
  assert.equal(out.text, 'The bonfire is lit!');
  assert.equal(out.from, 'DavidEdge');
});

test('a staff member without the cap gets a real refusal, not silence', () => {
  const p = conn('Modsy', modRec);
  live.push(p);
  assert.equal(handleMessage(p, { t: 'a-unban', name: 'Bannedy' }), true);
  const err = last(p);
  assert.equal(err.t, 'a-err');
  assert.equal(err.code, 'cap');
});

/* ── performOp guards ───────────────────────────────────────────────────── */

test('performOp refuses an unknown op and an unknown actor', () => {
  const unknownOp = performOp(adminRec, 'a-explode');
  assert.equal(unknownOp.ok, false);
  assert.equal(unknownOp.code, 'unknown');
  const noActor = performOp({ name: 'NoSuchCapyAnywhere' }, 'a-announce', { text: 'hi' });
  assert.equal(noActor.ok, false);
  assert.equal(noActor.code, 'noactor');
});

test('nobody moderates themselves, and nobody moderates their equal', () => {
  const target = mkRec('Victim');
  live.push(conn('Victim', target));
  // self
  const self = performOp(adminRec, 'a-mute', { name: 'DavidEdge', mins: 10, reason: 'testing' });
  assert.equal(self.ok, false);
  assert.equal(self.code, 'self');
  // equal rank: a mod may never touch a mod
  const peer = mkRec('Modsy2', 'mod');
  const r = performOp(modRec, 'a-mute', { name: 'Modsy2', mins: 10, reason: 'testing' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rank');
  assert.equal(peer.mute, null);
  // strictly lower rank is fine
  const ok = performOp(modRec, 'a-mute', { name: 'Victim', mins: 10, reason: 'testing' });
  assert.equal(ok.ok, true, ok.msg);
  assert.ok(db.muteActive(target));
});

test('an op against nobody is refused before anything happens', () => {
  const r = performOp(adminRec, 'a-mute', { name: 'NoSuchCapyAtAll', mins: 10, reason: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'notarget');
});
