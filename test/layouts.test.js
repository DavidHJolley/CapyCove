/**
 * server/layouts.js: the editor's happy path (draft -> publish -> everyone
 * rebuilds) and the security boundary underneath it — a layout frame from
 * anyone without the `editor` capability is dropped, silently.
 *
 *   node --test test/
 *
 * tests/layouts.test.mjs (editor v2) is the deep suite: the validator, the
 * ETag read path, restarts and corrupt files. This is the wave-11 baseline and
 * covers the two behaviours nothing else in the server can compensate for.
 *
 * Everything runs inside a throwaway COVE_DATA_DIR. admin.js and db.js are the
 * real modules, so the capability check exercised here is the one that ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-layouts11-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const L = await import('../server/layouts.js');
const admin = await import('../server/admin.js');
const db = await import('../server/db.js');

const sent = [];
const broadcast = [];

function mkRec(username, role) {
  db.users.set(username.toLowerCase(), { username, role, coins: 0, created: Date.now() });
  return db.users.get(username.toLowerCase());
}
const adminRec = mkRec('DavidEdge', 'admin');
const modRec = mkRec('Modsy', 'mod');
const playerRec = mkRec('Norm', 'player');

let seq = 0;
const conn = (name, rec) => ({
  id: `p${++seq}`, ws: { readyState: 1 }, bot: false,
  registered: !!rec, username: rec ? rec.username : null, name,
});
/** Cooldowns are per CONNECTION, drafts are per ACCOUNT: a second "tab" of the
 *  same admin is how a synchronous test steps past the 750ms/2s floors. */
const tab = () => conn('DavidEdge', adminRec);

const hooks = {
  sendTo: (p, msg) => sent.push({ to: p.id, msg }),
  broadcastAll: (msg) => broadcast.push(msg),
  recordFor: (p) => (p.username ? db.users.get(p.username.toLowerCase()) || null : null),
  audit: () => {},
};
admin.install({ ...hooks, sessionsFor: () => [], findEntity: () => null, world: { players: new Map(), rooms: new Map() } });
L.install({ ...hooks, dir: path.join(SANDBOX, 'layouts') });

const last = (p) => [...sent].reverse().find((s) => s.to === p.id)?.msg;
const countFor = (p) => sent.filter((s) => s.to === p.id).length;
const ask = (p, m) => { L.handleMessage(p, m); return last(p); };

/** One legal op of each of the three kinds a room actually uses. */
const OPS = [
  { op: 'hide', id: 'plaza/bench.3' },
  { op: 'xform', id: 'plaza/lamp.1', p: [2, 0, -3.5], ry: 1.2 },
  { op: 'handle', id: 'plaza/sign', set: { at: [4, -1.5], yaw: 0.5 } },
];

/* ── the happy path ─────────────────────────────────────────────────────── */

test('an admin saves a draft, and it is private to them', () => {
  const p = tab();
  const ack = ask(p, { t: 'layout-save', room: 'plaza', base: 'plaza@3', ops: OPS });
  assert.equal(ack.t, 'layout-ack');
  assert.equal(ack.ok, true, ack.msg);
  assert.equal(ack.what, 'save');
  assert.equal(ack.room, 'plaza');
  assert.equal(ack.rev, 1, 'a draft is numbered one past the published rev');
  assert.equal(ack.ops, OPS.length);
  assert.ok(ack.bytes > 0);

  // the owner sees their own draft on the doc frame; nothing is published yet
  const doc = ask(tab(), { t: 'layout-get', room: 'plaza' });
  assert.equal(doc.t, 'layout-doc');
  assert.equal(doc.rev, 0);
  assert.deepEqual(doc.ops, [], 'a draft must never render for players');
  assert.equal(doc.draft.ops.length, OPS.length);
  assert.equal(doc.base, '');
});

test('publishing bumps the rev, writes through, and tells the whole island', () => {
  const before = broadcast.length;
  const p = tab();
  const ack = ask(p, { t: 'layout-publish', room: 'plaza', rev: 0 });
  assert.equal(ack.ok, true, ack.msg);
  assert.equal(ack.what, 'publish');
  assert.equal(ack.rev, 1);
  assert.equal(ack.ops, OPS.length);

  assert.equal(broadcast.length, before + 1, 'a client caches every room it has visited');
  const out = broadcast[broadcast.length - 1];
  assert.equal(out.t, 'layout-rev');
  assert.equal(out.room, 'plaza');
  assert.equal(out.rev, 1);
  assert.equal(out.by, 'DavidEdge');

  // and it is on disk, immediately: a publish never waits on the write-behind
  const file = path.join(SANDBOX, 'layouts', 'plaza.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.fmt, L.LAYOUT_FMT);
  assert.equal(raw.published.rev, 1);
  assert.equal(raw.published.ops.length, OPS.length);
  assert.deepEqual(raw.drafts, {}, 'publishing consumes the draft');
});

test('the published ops are what every client reads back', () => {
  assert.equal(L.revOf('plaza'), 1);
  const ops = L.publicOps('plaza');
  assert.equal(ops.length, OPS.length);
  assert.deepEqual(ops[0], { op: 'hide', id: 'plaza/bench.3' });
  // untouched rooms are still at rev 0 with nothing on top of the room file
  assert.equal(L.revOf('beach'), 0);
  assert.deepEqual(L.publicOps('beach'), []);

  const doc = ask(tab(), { t: 'layout-get', room: 'plaza' });
  assert.equal(doc.rev, 1);
  assert.equal(doc.ops.length, OPS.length);
  assert.equal(doc.draft, null);
  assert.equal(doc.history.length, 0, 'rev 0 held nothing worth keeping');
});

test('a bad room and a bad op are refused with a reason, not a stack trace', () => {
  const noRoom = ask(tab(), { t: 'layout-get', room: 'atlantis' });
  assert.equal(noRoom.ok, false);
  assert.equal(noRoom.code, 'room');

  const badOp = ask(tab(), { t: 'layout-save', room: 'plaza', ops: [{ op: 'summon', id: 'plaza/x' }] });
  assert.equal(badOp.ok, false);
  assert.equal(badOp.code, 'kind');

  const badId = ask(tab(), { t: 'layout-save', room: 'plaza', ops: [{ op: 'hide', id: '../../users' }] });
  assert.equal(badId.ok, false);
  assert.equal(badId.code, 'id');

  const notAList = ask(tab(), { t: 'layout-save', room: 'plaza', ops: 'everything' });
  assert.equal(notAList.ok, false);
  assert.equal(notAList.code, 'shape');
});

test('a publish that would land on someone else\'s is refused', () => {
  const stale = ask(tab(), { t: 'layout-publish', room: 'plaza', rev: 0, ops: OPS });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale');
  assert.equal(stale.rev, 1, 'the refusal tells the editor where the room actually is');
  assert.equal(L.revOf('plaza'), 1);
});

/* ── the security boundary ──────────────────────────────────────────────── */

test('a player with no capabilities is dropped in silence', () => {
  // Not an error frame, not an ack: a probe learns nothing at all, and the
  // frame never reaches the main switch in index.js.
  for (const frame of ['layout-get', 'layout-save', 'layout-publish', 'layout-discard', 'layout-revert']) {
    const p = conn('Norm', playerRec);
    const consumed = L.handleMessage(p, { t: frame, room: 'plaza', ops: OPS });
    assert.equal(consumed, true, `${frame} must be consumed, never released`);
    assert.equal(countFor(p), 0, `${frame} answered a player with no editor cap`);
  }
  assert.equal(L.revOf('plaza'), 1, 'nothing a player sent changed the room');
});

test('a guest is dropped in silence too', () => {
  const p = conn('Guesty', null);
  assert.equal(L.handleMessage(p, { t: 'layout-publish', room: 'plaza', ops: [] }), true);
  assert.equal(countFor(p), 0);
});

test('staff without the editor cap get a real refusal (that is a UI bug)', () => {
  const p = conn('Modsy', modRec);
  const ack = ask(p, { t: 'layout-save', room: 'plaza', ops: OPS });
  assert.equal(ack.t, 'layout-ack');
  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'cap');
});

test('handleMessage never touches a frame that is not a layout frame', () => {
  const p = tab();
  for (const t of ['chat', 'move', 'join', 'layout', 'layoutget', 'a-who']) {
    assert.equal(L.handleMessage(p, { t }), false, t);
  }
  assert.equal(L.handleMessage(p, null), false);
  assert.equal(L.handleMessage(p, { t: 42 }), false);
});

test('losing the editor role revokes the editor, live', () => {
  // The cap is read off the record on every frame, so a demotion takes effect
  // on the next one — no reconnect, no cache to bust.
  const rec = mkRec('Temp', 'admin');
  const p = conn('Temp', rec);
  assert.equal(ask(p, { t: 'layout-get', room: 'beach' }).t, 'layout-doc');
  db.setRole(rec, 'player');
  const q = conn('Temp', rec);
  assert.equal(L.handleMessage(q, { t: 'layout-get', room: 'beach' }), true);
  assert.equal(countFor(q), 0);
});
