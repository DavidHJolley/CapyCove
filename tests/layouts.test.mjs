/**
 * Headless test for server/layouts.js: the whole persistence spine driven
 * through its real entry points — the capability gate, the validator, the
 * draft/publish/discard/revert lifecycle, the atomic write, the HTTP read path
 * with its ETag, a restart, and a corrupt file.
 *
 *   node --test tests/layouts.test.mjs
 *
 * Everything runs inside a throwaway `COVE_DATA_DIR`, so this never touches the
 * real data directory, never starts a server and never opens a socket. The only
 * fakes are the four ctx hooks index.js supplies (sendTo, broadcastAll,
 * recordFor, audit); admin.js, db.js and store.js are the real modules, so the
 * capability check being exercised here is the one that ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-layouts-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });
const LAYOUT_DIR = path.join(SANDBOX, 'layouts');

const L = await import('../server/layouts.js');
const admin = await import('../server/admin.js');
const db = await import('../server/db.js');

// --- a fake island ---------------------------------------------------------
const sent = [];
const broadcast = [];
const audited = [];

function mkRec(username, role) {
  const rec = { uid: `u_${username}`, username, role, coins: 0, created: Date.now() };
  db.users.set(username.toLowerCase(), rec);
  return rec;
}
const adminRec = mkRec('DavidEdge', 'admin');
const modRec = mkRec('Modsy', 'mod');
const playerRec = mkRec('Norm', 'player');

let connSeq = 0;
/** A live ws connection, in the shape index.js builds on `hello`. */
const conn = (name, rec) => ({
  id: `p${++connSeq}`, ws: { readyState: 1 }, bot: false,
  registered: !!rec, username: rec ? rec.username : null, name,
});
const pAdmin = conn('DavidEdge', adminRec);
const pMod = conn('Modsy', modRec);
const pPlayer = conn('Norm', playerRec);
const pGuest = conn('Guesty', null);
/** Cooldowns are per CONNECTION and drafts are per ACCOUNT: a second tab of the
 *  same admin is how a synchronous test steps past the 750ms/2s floors. */
const tab = () => conn('DavidEdge', adminRec);

admin.install({
  sendTo: (p, msg) => sent.push({ to: p.id, msg }),
  broadcastAll: (msg) => broadcast.push(msg),
  sessionsFor: () => [],
  recordFor: (p) => (p.username ? db.users.get(p.username.toLowerCase()) || null : null),
  findEntity: () => null,
  world: { players: new Map(), rooms: new Map() },
  audit: (e) => audited.push(e),
});
L.install({
  sendTo: (p, msg) => sent.push({ to: p.id, msg }),
  broadcastAll: (msg) => broadcast.push(msg),
  recordFor: (p) => (p.username ? db.users.get(p.username.toLowerCase()) || null : null),
  audit: (e) => audited.push(e),
});

const send = (p, m) => L.handleMessage(p, m);
const last = (p) => [...sent].reverse().find((s) => s.to === p.id)?.msg;
const ask = (p, m) => { send(p, m); return last(p); };

/** One of everything the op vocabulary can express. */
const FULL = [
  { op: 'handle', id: 'lounge/pong', set: { at: [-6.98, -0.93], sign: [-8.55, 0.24], yaw: 0.95, seats: [[1, 2], [3, 4]] } },
  { op: 'spawn', id: 'default', p: [1.4, 0, 4.4] },
  { op: 'cam', id: 'static', p: [0, 19, 25.7], look: [0, 1.2, 0.6] },
  { op: 'cam', id: 'bm_1', name: 'north gate', target: [0, 0, -9], dist: 12, yaw: 0.3, pitch: 0.8 },
  { op: 'prop', id: 'p_7f3a91', cat: 'plant_palm', p: [4.25, 0, -2.5], ry: 0.785, s: 1, tint: 3, lock: true },
  { op: 'hotspot', id: 'h_02', kind: 'exit', to: 'beach', x: -11.5, z: 0.2, r: 2.6, label: 'Driftwood Beach' },
  { op: 'hotspot', id: 'h_03', kind: 'game', to: 'fishing', x: 2, z: 6, r: 2.2, label: 'Play Reel Rush' },
  { op: 'collider', id: 'c_04', x: 3.2, z: -1.4, r: 1.1 },
  { op: 'group', id: 'g_1', name: 'picnic corner', members: ['p_7f3a91'] },
  { op: 'xform', id: 'plaza/fountain', p: [0, 0, 0.4], ry: 0.12, s: 1.05 },
  { op: 'hide', id: 'plaza/bench.3' },
];

// ---------------------------------------------------------------------------

test('the capability gate is the security boundary', () => {
  sent.length = 0;
  assert.equal(send(pGuest, { t: 'layout-save', room: 'plaza', ops: [] }), true, 'consumed');
  assert.equal(sent.length, 0, 'a guest gets nothing back');

  sent.length = 0;
  assert.equal(send(pPlayer, { t: 'layout-publish', room: 'plaza', ops: [] }), true);
  assert.equal(sent.length, 0, 'a player with no caps gets SILENCE, not an error');
  assert.ok(audited.some((e) => e.op === 'layout.probe' && e.ok === false), 'the probe is logged');

  const refusal = ask(pMod, { t: 'layout-save', room: 'plaza', ops: [] });
  assert.equal(refusal.t, 'layout-ack');
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'cap', 'staff without the editor cap get a real refusal');

  assert.equal(send(pAdmin, { t: 'chat', text: 'hi' }), false, 'a non-layout frame falls through');
});

test('validation accepts the whole op vocabulary', () => {
  const v = L.validateOps(FULL, { room: 'lounge' });
  assert.ok(v.ok, v.msg);
  assert.equal(v.ops.length, FULL.length);
  assert.ok(v.bytes > 0);
});

test('validation is all-or-nothing and rejects anything dangerous', () => {
  const cases = {
    'unknown op kind': [{ op: 'script', id: 'x' }],
    'hotspot to a non-room': [{ op: 'hotspot', id: 'h_1', kind: 'exit', to: 'nowhere', x: 0, z: 0, r: 2 }],
    'hotspot to a non-minigame': [{ op: 'hotspot', id: 'h_1', kind: 'game', to: 'roulette', x: 0, z: 0, r: 2 }],
    'a prototype key as a destination': [{ op: 'hotspot', id: 'h_1', kind: 'game', to: 'constructor', x: 0, z: 0, r: 2 }],
    'NaN in a position': [{ op: 'spawn', id: 'default', p: [NaN, 0, 0] }],
    'Infinity in a position': [{ op: 'spawn', id: 'default', p: [Infinity, 0, 0] }],
    'null in a position': [{ op: 'spawn', id: 'default', p: [null, 0, 0] }],
    'a string in a position': [{ op: 'spawn', id: 'default', p: ['x', 0, 0] }],
    'a two-long position': [{ op: 'spawn', id: 'default', p: [1, 2] }],
    'a traversal-shaped id': [{ op: 'hide', id: '../../users' }],
    'an id with a space': [{ op: 'hide', id: 'a b' }],
    'a handle value that is not a number': [{ op: 'handle', id: 'x', set: { at: ['a', 2] } }],
    'a handle value that is an object': [{ op: 'handle', id: 'x', set: { at: [{}, 2] } }],
    'ops that are not a list': { nope: true },
    'an op that is an array': [[1, 2]],
    'a camera id that is not static or bm_*': [{ op: 'cam', id: 'evil', p: [0, 0, 0] }],
    'an empty group': [{ op: 'group', id: 'g_1', members: [] }],
    'an xform with nothing to change': [{ op: 'xform', id: 'a/b' }],
  };
  for (const [why, ops] of Object.entries(cases)) {
    assert.equal(L.validateOps(ops, { room: 'plaza' }).ok, false, `should reject ${why}`);
  }
  assert.equal(L.validateOps([], { room: 'house:dave' }).ok, false, 'dens have their own system');
  assert.equal(L.validateOps([], { room: 'atlantis' }).ok, false, 'unknown room');
});

test('validation clamps, rounds, and rebuilds every op from a whitelist', () => {
  const v = L.validateOps([{
    op: 'prop', id: 'p_1', cat: 'sofa',
    p: [999, 999, -999], s: 99, ry: 0.123456, tint: 999, col: 99,
    evil: 'DROP TABLE', action: 'alert(1)',
  }], { room: 'plaza' });
  assert.ok(v.ok, v.msg);
  const op = v.ops[0];
  assert.deepEqual(op.p, [200, 40, -200], 'position clamped');
  assert.equal(op.s, 4, 'scale clamped');
  assert.equal(op.ry, 0.123, 'rotation to 3dp');
  assert.equal(op.tint, 15, 'tint clamped into the palette');
  assert.equal(op.col, 8, 'collider radius clamped');
  assert.equal(op.evil, undefined, 'unknown keys never reach the disk');
  assert.equal(op.action, undefined, 'a layout can never express a callable');

  const dup = L.validateOps([
    { op: 'spawn', id: 'default', p: [1, 0, 1] },
    { op: 'spawn', id: 'default', p: [2, 0, 2] },
  ], { room: 'plaza' });
  assert.equal(dup.ops.length, 1, 'duplicate opKeys normalise');
  assert.equal(dup.ops[0].p[0], 2, 'last op with a key wins');

  const many = Array.from({ length: 130 }, (_, i) => ({ op: 'prop', id: `p_${i}`, cat: 'sofa', p: [0, 0, 0] }));
  assert.equal(L.validateOps(many, { room: 'plaza' }).ok, false, 'the prop cap holds');

  const long = L.validateOps([{ op: 'hotspot', id: 'h_1', kind: 'sign', x: 0, z: 0, r: 2, label: 'x'.repeat(400) }], { room: 'plaza' });
  assert.equal(long.ops[0].label.length, 40, 'labels are trimmed, not rejected');
});

test('draft: saved per admin, invisible to everyone else', () => {
  let doc = ask(pAdmin, { t: 'layout-get', room: 'lounge' });
  assert.equal(doc.t, 'layout-doc');
  assert.equal(doc.rev, 0);
  assert.equal(doc.ops.length, 0);
  assert.equal(doc.draft, null);
  assert.equal(doc.limits.ops, 400, 'the caps ride the doc frame');

  const a = ask(pAdmin, { t: 'layout-save', room: 'lounge', base: 'lounge@1', ops: FULL });
  assert.equal(a.ok, true);
  assert.equal(a.what, 'save');
  assert.equal(a.rev, 1, 'a draft carries the rev it would become');
  assert.ok(audited.some((e) => e.op === 'layout.save'));

  doc = ask(pAdmin, { t: 'layout-get', room: 'lounge' });
  assert.equal(doc.draft.ops.length, FULL.length);
  assert.equal(doc.ops.length, 0, 'nobody else sees a draft: published is still empty');

  const second = conn('Second', mkRec('Second', 'admin'));
  const doc2 = ask(second, { t: 'layout-get', room: 'lounge' });
  assert.equal(doc2.draft, null, 'drafts do not leak between admins');
  assert.deepEqual(doc2.others.map((o) => o.by), ['davidedge'], 'but you can see someone else is in here');
});

test('publish: rev bump, atomic write, island-wide broadcast', () => {
  broadcast.length = 0;
  const stale = ask(pAdmin, { t: 'layout-publish', room: 'lounge', rev: 7 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale', 'the optimistic-concurrency guard bites');

  const a = ask(pAdmin, { t: 'layout-publish', room: 'lounge', rev: 0 });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.rev, 1);
  assert.equal(broadcast.length, 1);
  assert.deepEqual(
    { t: broadcast[0].t, room: broadcast[0].room, rev: broadcast[0].rev },
    { t: 'layout-rev', room: 'lounge', rev: 1 },
  );
  assert.ok(audited.some((e) => e.op === 'layout.publish' && e.after?.rev === 1), 'publishes are audited');

  const file = path.join(LAYOUT_DIR, 'lounge.json');
  assert.ok(fs.existsSync(file), 'written to disk');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.fmt, 'rlo/1');
  assert.equal(disk.v, 1);
  assert.equal(disk.published.rev, 1);
  assert.equal(disk.published.by, 'DavidEdge');
  assert.deepEqual(Object.keys(disk.drafts), [], 'the publish consumed the draft');
  assert.ok(fs.readdirSync(LAYOUT_DIR).every((f) => !f.includes('.tmp-')), 'no temp file left behind');
});

test('HTTP read path: ETag, 304, and no editor furniture in public ops', () => {
  let r = L.serve('lounge');
  assert.equal(r.status, 200);
  assert.equal(r.etag, 'W/"1"');
  assert.equal(r.body.v, 1);
  assert.equal(r.body.rev, 1);
  assert.ok(r.body.ops.length > 0);
  assert.ok(r.body.ops.every((o) => o.op !== 'group'), 'groups are editor-only');
  assert.ok(r.body.ops.every((o) => !(o.op === 'cam' && o.id !== 'static')), 'bookmarks are editor-only');
  assert.ok(r.body.ops.some((o) => o.op === 'cam' && o.id === 'static'), 'the authored camera survives');
  assert.ok(r.body.ops.every((o) => o.lock === undefined), 'the lock flag is editor-only');

  assert.equal(L.serve('lounge', 'W/"1"').status, 304, 'revalidation is free');
  assert.equal(L.serve('lounge', 'W/"0"').status, 200, 'a stale ETag gets the body');

  r = L.serve('plaza');
  assert.equal(r.status, 200, 'a never-published room is a real, cacheable rev-0 document');
  assert.equal(r.body.rev, 0);
  assert.deepEqual(r.body.ops, []);

  assert.equal(L.serve('house:dave').status, 404, 'dens are not editable here');
  assert.equal(L.serve('../../etc/passwd').status, 404);

  // express shim
  const mk = () => ({
    code: 0, headers: {}, payload: null, ended: false,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; },
    end() { this.ended = true; return this; },
  });
  const res = mk();
  L.httpGet({ params: { room: 'lounge' }, headers: {} }, res);
  assert.equal(res.headers.ETag, 'W/"1"');
  assert.equal(res.headers['Cache-Control'], 'no-cache');
  assert.equal(res.code, 200);
  assert.equal(res.payload.room, 'lounge');

  const res2 = mk();
  L.httpGet({ params: { room: 'lounge' }, headers: { 'if-none-match': 'W/"1"' } }, res2);
  assert.equal(res2.code, 304);
  assert.equal(res2.ended, true);
  assert.equal(res2.payload, null);
});

test('history, revert and discard', () => {
  broadcast.length = 0;
  // the per-connection cooldowns are real; a second tab has its own budget
  assert.equal(ask(pAdmin, { t: 'layout-save', room: 'lounge', ops: [{ op: 'spawn', id: 'x', p: [1, 0, 1] }] }).code, 'slow');

  const t1 = tab();
  assert.equal(ask(t1, { t: 'layout-save', room: 'lounge', ops: [{ op: 'spawn', id: 'default', p: [9, 0, 9] }] }).ok, true);
  assert.equal(ask(pAdmin, { t: 'layout-publish', room: 'lounge' }).code, 'slow');

  const t2 = tab();
  const a = ask(t2, { t: 'layout-publish', room: 'lounge' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.rev, 2);

  let doc = ask(t2, { t: 'layout-get', room: 'lounge' });
  assert.equal(doc.history.length, 1);
  assert.equal(doc.history[0].rev, 1);
  assert.equal(typeof doc.history[0].ops, 'number', 'history travels as a summary');
  assert.equal(doc.ops.length, 1, 'rev 2 replaced the ops wholesale');

  const t3 = tab();
  const rev = ask(t3, { t: 'layout-revert', room: 'lounge', toRev: 1 });
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(rev.rev, 3, 'a revert is itself a publish, so nothing is ever lost');
  assert.equal(rev.from, 1);
  assert.equal(broadcast[broadcast.length - 1].rev, 3);

  doc = ask(t3, { t: 'layout-get', room: 'lounge' });
  assert.equal(doc.ops.length, FULL.length, 'the reverted content is back');
  assert.equal(doc.history.length, 2);

  const t4 = tab();
  assert.equal(ask(t4, { t: 'layout-revert', room: 'lounge', toRev: 99 }).code, 'norev');

  const t5 = tab();
  ask(t5, { t: 'layout-save', room: 'lounge', ops: [{ op: 'hide', id: 'lounge/x' }] });
  assert.equal(ask(t5, { t: 'layout-discard', room: 'lounge' }).ok, true);
  assert.equal(ask(t5, { t: 'layout-get', room: 'lounge' }).draft, null);
  assert.equal(ask(t5, { t: 'layout-discard', room: 'lounge' }).code, 'nodraft', 'discarding nothing refuses, never throws');
});

test('a restart re-reads what was published', () => {
  L.flush();
  L._reset();
  const r = L.serve('lounge');
  assert.equal(r.body.rev, 3);
  assert.ok(r.body.ops.length > 0);
});

test('a corrupt or hand-edited file never takes a room down', () => {
  fs.writeFileSync(path.join(LAYOUT_DIR, 'plaza.json'), '{ this is not json');
  L._reset();
  const r = L.serve('plaza');
  assert.equal(r.status, 200);
  assert.equal(r.body.rev, 0, 'the room builds from pure code');
  assert.ok(fs.readdirSync(LAYOUT_DIR).some((f) => f.startsWith('plaza.json.corrupt-')), 'the bad file is kept as evidence');
  assert.ok(audited.some((e) => e.op === 'layout.load.fail'));

  // a file edited by hand (or restored) is INPUT, not truth
  fs.writeFileSync(path.join(LAYOUT_DIR, 'beach.json'), JSON.stringify({
    v: 1, room: 'beach',
    published: { rev: 9, by: 'x', updated: 1, ops: [{ op: 'hotspot', id: 'h', kind: 'exit', to: '__proto__', x: 0, z: 0, r: 1 }] },
    history: [], drafts: {},
  }));
  L._reset();
  const b = L.serve('beach');
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.ops, [], 'an illegal op on disk is dropped on load, not trusted');
});

test('the burst limiter holds', () => {
  sent.length = 0;
  const p = tab();
  for (let i = 0; i < 14; i++) send(p, { t: 'layout-get', room: 'cafe' });
  assert.ok(sent.some((s) => s.msg.t === 'layout-ack' && s.msg.code === 'slow'));
});

test.after(() => {
  L.flush();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* windows holds handles sometimes */ }
});
