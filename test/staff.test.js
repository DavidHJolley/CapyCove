/**
 * server/admin.js, the STAFF half (wave 12): who may change a role, what a
 * role change does to a session that is already open, who hears the staff
 * channel, and the report queue seam.
 *
 *   node --test test/
 *
 * Same shape as test/admin.test.js: the real db.js, the real filter.js, a fake
 * island wired through the ctx hooks index.js supplies, and the ops driven
 * through their real entry points (handleMessage for the wire, performOp for
 * the guards). Nothing starts a server, nothing opens a socket. server/
 * reports.js is INJECTED as a fake through ctx.reports, so the round trip is
 * asserted without a single file hitting the disk.
 *
 * The one thing to know before editing: performOp gives every actor 5 ops a
 * second, keyed on the live connection when there is one. `opAs` therefore
 * mints a FRESH connection per call, so a test that runs twenty ops in a
 * millisecond is testing the guards rather than the rate limiter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-staff-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const admin = await import('../server/admin.js');
const db = await import('../server/db.js');

const {
  CAPS, capsFor, requireCap, handleMessage, performOp, actorFrom, MUTED_FRAMES,
} = admin;
const { users, roleOf } = db;

// --- a fake island ---------------------------------------------------------

/** Every frame the server wrote, in order: {to, msg}. */
const sent = [];
/** Every audit entry the ops produced. */
const logged = [];
/** id -> live connection, exactly the Map index.js keeps as world.players. */
const players = new Map();

function mkRec(username, role = 'player') {
  // users.set runs the store's normaliser: uid, tokenV, lastSeen, mute, ban.
  users.set(username.toLowerCase(), { username, role, coins: 0, created: Date.now() });
  return users.get(username.toLowerCase());
}

let seq = 0;
/** A live ws connection in the shape index.js builds on `hello`. */
function conn(name, rec, room = 'plaza') {
  return {
    id: `p${++seq}`,
    ws: { readyState: 1, close: () => {} },
    bot: false,
    registered: !!rec,
    username: rec ? rec.username : null,
    name,
    room,
  };
}

/** Put a connection on the island (and take it off again). */
function online(p) { players.set(p.id, p); return p; }
function offline(p) { players.delete(p.id); return p; }

// --- the fake report queue -------------------------------------------------

const fakeReports = {
  calls: [],
  rows: [
    { id: 'r_a1', kind: 'chat', reason: 'language', state: 'open', target: 'Rude', at: 1 },
    { id: 'r_a2', kind: 'mural', reason: 'inappropriate', state: 'open', target: '', at: 2 },
  ],
  queue(filter) {
    this.calls.push({ fn: 'queue', filter });
    const rows = filter.state && filter.state !== 'open' ? [] : this.rows;
    return { reports: rows, counts: { open: rows.length, reviewed: 0, actioned: 0, dismissed: 0, total: rows.length }, total: rows.length, offset: 0, done: true };
  },
  setState(actor, id, state, opts) {
    this.calls.push({ fn: 'setState', actor: actor?.name, id, state, note: opts?.note });
    if (!this.rows.some((r) => r.id === id)) return { ok: false, msg: 'No such report', code: 'notfound' };
    if (state === 'dismissed' && !opts?.note) return { ok: false, msg: 'Say why it was dismissed', code: 'reason' };
    for (const r of this.rows) if (r.id === id) r.state = state;
    return { ok: true, id, state, msg: `Report ${state}` };
  },
};

const ownerRec = mkRec('DavidEdge', 'admin');
const secondRec = mkRec('Deputy', 'admin');
const modRec = mkRec('Modsy', 'mod');
const normRec = mkRec('Norm', 'player');

admin.install({
  sendTo: (p, msg) => sent.push({ to: p.id, msg }),
  broadcastAll: () => {},
  sessionsFor: (key) => [...players.values()].filter((p) => (p.username || '').toLowerCase() === key),
  recordFor: (p) => (p.username ? users.get(p.username.toLowerCase()) || null : null),
  findEntity: (id) => players.get(id) || null,
  world: { players, rooms: new Map() },
  audit: (entry) => logged.push(entry),
  reports: fakeReports,
});

const framesFor = (p) => sent.filter((s) => s.to === p.id).map((s) => s.msg);
const last = (p) => framesFor(p).slice(-1)[0];
const lastLog = () => logged[logged.length - 1];

/**
 * Run an op as `rec` from a throwaway connection: a fresh actor every time, so
 * the 5-per-second operator budget never decides the outcome of a guard test.
 */
function opAs(rec, op, args = {}) {
  return performOp(actorFrom(conn(rec.username, rec)), op, args);
}

/* ── the two new capabilities ───────────────────────────────────────────── */

test('the staff caps: an admin holds both, a mod holds only staffchat', () => {
  assert.ok(CAPS.includes('role'));
  assert.ok(CAPS.includes('staffchat'));
  // Handing out capabilities is the one thing a mod may never do: a mod who
  // can make mods is an admin with extra steps.
  assert.equal(capsFor('mod').includes('role'), false);
  assert.equal(capsFor('mod').includes('staffchat'), true);
  assert.equal(capsFor('admin').includes('role'), true);
  assert.equal(capsFor('admin').includes('staffchat'), true);
  assert.deepEqual(capsFor('player'), []);
  assert.equal(requireCap(modRec, 'role'), false);
  assert.equal(requireCap(ownerRec, 'role'), true);
});

/* ── a-role: who may move a role, and to what ───────────────────────────── */

test('a player probing a-role learns nothing and changes nothing', () => {
  const p = online(conn('Norm', normRec));
  const before = framesFor(p).length;
  assert.equal(handleMessage(p, { t: 'a-role', name: 'Norm', role: 'admin' }), true, 'the frame must not reach the main switch');
  assert.equal(framesFor(p).length, before, 'a probe gets silence, not an error');
  assert.equal(roleOf(normRec), 'player');
  assert.equal(lastLog().op, 'mod.probe');
  offline(p);
});

test('a mod is refused in words: staff missing a cap is a UI bug, not an attack', () => {
  const p = online(conn('Modsy', modRec));
  assert.equal(handleMessage(p, { t: 'a-role', name: 'Norm', role: 'mod' }), true);
  const err = last(p);
  assert.equal(err.t, 'a-err');
  assert.equal(err.op, 'a-role');
  assert.equal(err.code, 'cap');
  assert.equal(roleOf(normRec), 'player');
  offline(p);
});

test('nobody changes their own role, at any rank', () => {
  const r = opAs(ownerRec, 'a-role', { name: 'DavidEdge', role: 'player' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'self');
  assert.equal(roleOf(ownerRec), 'admin');
  // and the refusal is on the record, with its own deny code
  assert.equal(lastLog().op, 'role.set');
  assert.equal(lastLog().ok, false);
  assert.equal(lastLog().args.deny, 'self');
});

test('a role has to be a role, and a no-op says so', () => {
  const junk = opAs(ownerRec, 'a-role', { name: 'Norm', role: 'wizard' });
  assert.equal(junk.ok, false);
  assert.equal(junk.code, 'args');
  const missing = opAs(ownerRec, 'a-role', { name: 'Norm' });
  assert.equal(missing.code, 'args');
  const noop = opAs(ownerRec, 'a-role', { name: 'Modsy', role: 'mod' });
  assert.equal(noop.ok, false);
  assert.equal(noop.code, 'noop');
  const nobody = opAs(ownerRec, 'a-role', { name: 'NoSuchCapyAtAll', role: 'mod' });
  assert.equal(nobody.code, 'notarget');
  assert.equal(roleOf(normRec), 'player');
});

test('an admin promotes a player, and the OPEN session gains the caps live', () => {
  const p = online(conn('Norm', normRec));
  const tokenV = normRec.tokenV | 0;
  // before: the panel would not open and the staff channel is a probe
  assert.equal(requireCap(p, 'staffchat'), false);

  const r = opAs(ownerRec, 'a-role', { name: 'Norm', role: 'mod' });
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.was, 'player');
  assert.equal(r.role, 'mod');
  assert.equal(r.sessions, 1);

  // persisted
  assert.equal(roleOf(normRec), 'mod');
  // every issued token dies with the change: a stale session cannot keep old
  // powers, and a token minted a minute ago cannot walk back in
  assert.ok((normRec.tokenV | 0) > tokenV, 'tokenV was not bumped');

  // live, with no relog: the server reads the record on every check
  assert.equal(requireCap(p, 'staffchat'), true);

  // the client is told, so the panel appears without a reload
  const frames = framesFor(p);
  const caps = frames.find((m) => m.t === 'a-role');
  assert.ok(caps, 'the subject was never sent its new caps');
  assert.deepEqual(caps.caps, capsFor('mod'));
  assert.equal(caps.role, 'mod');
  assert.equal(caps.by, 'DavidEdge');
  // the whole triple game.applyModeration re-derives, or a promotion would
  // silently clear the client's idea of an active mute
  assert.equal(caps.muteUntil, 0);
  assert.deepEqual(Object.keys(caps).sort(), ['at', 'by', 'caps', 'muteUntil', 'role', 't']);
  const toast = frames.find((m) => m.t === 'toast');
  assert.match(toast.msg, /mod/i);

  // audited as a GRANT, with before and after
  const line = lastLog();
  assert.equal(line.op, 'role.grant');
  assert.equal(line.ok, true);
  assert.deepEqual(line.before, { role: 'player' });
  assert.equal(line.after.role, 'mod');
  assert.equal(line.target.name, 'Norm');
  offline(p);
});

test('a revoke is a revoke: back to player, tokenV bumped again, told live', () => {
  const p = online(conn('Norm', normRec));
  const tokenV = normRec.tokenV | 0;
  const r = opAs(ownerRec, 'a-role', { name: 'Norm', role: 'player' });
  assert.equal(r.ok, true, r.msg);
  assert.equal(roleOf(normRec), 'player');
  assert.ok((normRec.tokenV | 0) > tokenV);
  assert.equal(requireCap(p, 'staffchat'), false, 'the caps did not go away with the role');
  assert.equal(last(p).t, 'toast');
  assert.equal(framesFor(p).find((m) => m.t === 'a-role').role, 'player');
  assert.equal(lastLog().op, 'role.revoke');
  offline(p);
});

test('an admin may demote a PEER admin (the shared rank guard would not allow it)', () => {
  // This is why `role` runs its own guards instead of the strictly-greater one
  // every other mutating op shares: two admins have to be able to correct each
  // other, or the second admin is unremovable forever.
  assert.equal(roleOf(secondRec), 'admin');
  const r = opAs(ownerRec, 'a-role', { name: 'Deputy', role: 'player' });
  assert.equal(r.ok, true, r.msg);
  assert.equal(roleOf(secondRec), 'player');
  assert.equal(lastLog().op, 'role.revoke');
});

test('the LAST admin cannot be demoted: the island must never be adminless', () => {
  // With the self guard and the admin-only cap in force, the in-game path can
  // never reach this: an admin demoting an admin is proof there are two. It is
  // the backstop for every OTHER caller (the web panel, a script, a service
  // actor) whose authority is not a stored admin record — so that is exactly
  // the actor shape it is tested with.
  const admins = [...users.values()].filter((r) => roleOf(r) === 'admin');
  assert.deepEqual(admins.map((r) => r.username), ['DavidEdge'], 'the fixture must leave exactly one admin');

  const ghost = { uid: 'u_0000000000000000', username: 'PanelBot', role: 'admin' };
  const r = performOp(ghost, 'a-role', { name: 'DavidEdge', role: 'player' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'lastadmin');
  assert.equal(roleOf(ownerRec), 'admin', 'the island lost its last admin');
  assert.equal(lastLog().args.deny, 'lastadmin');

  // ...and demoting is fine again the moment there is a second one.
  assert.equal(opAs(ownerRec, 'a-role', { name: 'Deputy', role: 'admin' }).ok, true);
  const back = performOp(ghost, 'a-role', { name: 'DavidEdge', role: 'mod' });
  assert.equal(back.ok, true, back.msg);
  // put the fixture back the way the rest of the file expects it
  assert.equal(opAs(secondRec, 'a-role', { name: 'DavidEdge', role: 'admin' }).ok, true);
  assert.equal(roleOf(ownerRec), 'admin');
  assert.equal(opAs(ownerRec, 'a-role', { name: 'Deputy', role: 'player' }).ok, true);
});

test('a guest and a citizen have no role to hold', () => {
  const guest = online(conn('Guesty', null));
  const bot = online({ ...conn('Wanderer', null), bot: true });
  const g = opAs(ownerRec, 'a-role', { id: guest.id, role: 'mod' });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'guest');
  const b = opAs(ownerRec, 'a-role', { id: bot.id, role: 'mod' });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'bot');
  offline(guest);
  offline(bot);
});

/* ── a-staff: the roster ────────────────────────────────────────────────── */

test('a-staff lists everyone with a role, on duty first, and no players', () => {
  const modConn = online(conn('Modsy', modRec, 'lounge'));
  const r = opAs(ownerRec, 'a-staff', {});
  assert.equal(r.ok, true);
  const names = r.staff.map((s) => s.name);
  assert.ok(names.includes('DavidEdge'));
  assert.ok(names.includes('Modsy'));
  assert.equal(names.includes('Norm'), false, 'a player is not staff');
  // the one who is actually online sorts to the top
  assert.equal(r.staff[0].name, 'Modsy');
  assert.equal(r.staff[0].online, true);
  assert.equal(r.staff[0].room, 'lounge');
  assert.equal(r.online, 1);
  const owner = r.staff.find((s) => s.name === 'DavidEdge');
  assert.equal(owner.online, false);
  assert.ok(owner.lastSeen > 0, 'an offline staff member carries lastSeen');
  assert.equal(owner.role, 'admin');
  // the panel builds its dropdown from the server's ladder, never its own
  assert.deepEqual(r.roles, ['player', 'mod', 'admin']);
  offline(modConn);
});

test('a mod may read the roster; a player may not, and is told nothing', () => {
  const m = online(conn('Modsy', modRec));
  assert.equal(handleMessage(m, { t: 'a-staff' }), true);
  assert.equal(last(m).t, 'a-ok');
  assert.equal(last(m).op, 'a-staff');
  offline(m);

  const p = online(conn('Norm', normRec));
  const before = framesFor(p).length;
  assert.equal(handleMessage(p, { t: 'a-staff' }), true);
  assert.equal(framesFor(p).length, before);
  offline(p);
});

/* ── a-schat: the staff channel ─────────────────────────────────────────── */

test('a staff line reaches every capped session and nobody else', () => {
  const ownerConn = online(conn('DavidEdge', ownerRec));
  const modConn = online(conn('Modsy', modRec));
  const playerConn = online(conn('Norm', normRec));
  const guestConn = online(conn('Guesty', null));
  const marks = new Map([[ownerConn, framesFor(ownerConn).length], [modConn, framesFor(modConn).length],
    [playerConn, framesFor(playerConn).length], [guestConn, framesFor(guestConn).length]]);

  assert.equal(handleMessage(modConn, { t: 'a-schat', text: 'raid in the plaza, three accounts' }), true);

  const heard = (p) => framesFor(p).slice(marks.get(p)).filter((m) => m.t === 'a-schat');
  assert.equal(heard(ownerConn).length, 1, 'the admin did not hear it');
  assert.equal(heard(modConn).length, 1, 'the sender does not get their own line back');
  assert.equal(heard(playerConn).length, 0, 'a PLAYER heard the staff channel');
  assert.equal(heard(guestConn).length, 0, 'a GUEST heard the staff channel');

  const line = heard(ownerConn)[0];
  assert.equal(line.from, 'Modsy');
  assert.equal(line.role, 'mod');
  assert.equal(line.text, 'raid in the plaza, three accounts');
  assert.ok(line.at > 0);
  // and the sender's own ack says how far it went
  assert.equal(last(modConn).t, 'a-ok');
  assert.equal(last(modConn).to, 2);

  offline(ownerConn); offline(modConn); offline(playerConn); offline(guestConn);
});

test('a freshly made mod is in the fan-out with no relog', () => {
  const ownerConn = online(conn('DavidEdge', ownerRec));
  const rookie = online(conn('Norm', normRec));
  assert.equal(handleMessage(rookie, { t: 'a-schat', text: 'hello?' }), true);
  assert.equal(framesFor(rookie).filter((m) => m.t === 'a-schat').length, 0, 'a player could send on the staff channel');

  assert.equal(opAs(ownerRec, 'a-role', { name: 'Norm', role: 'mod' }).ok, true);
  const mark = framesFor(rookie).length;
  assert.equal(handleMessage(rookie, { t: 'a-schat', text: 'reporting for duty' }), true);
  const own = framesFor(rookie).slice(mark).filter((m) => m.t === 'a-schat');
  assert.equal(own.length, 1, 'the new mod cannot use the channel they were just given');
  assert.equal(own[0].role, 'mod');
  assert.equal(framesFor(ownerConn).filter((m) => m.t === 'a-schat' && m.from === 'Norm').length, 1);

  assert.equal(opAs(ownerRec, 'a-role', { name: 'Norm', role: 'player' }).ok, true);
  offline(ownerConn); offline(rookie);
});

test('staff are not exempt from the filter', () => {
  const modConn = online(conn('Modsy', modRec));
  const ownerConn = online(conn('DavidEdge', ownerRec));

  // block tier: not delivered to anybody, and the sender is told why
  const mark = framesFor(ownerConn).length;
  assert.equal(handleMessage(modConn, { t: 'a-schat', text: 'kys' }), true);
  const refusal = last(modConn);
  assert.equal(refusal.t, 'a-err');
  assert.equal(refusal.code, 'filtered');
  assert.equal(framesFor(ownerConn).slice(mark).filter((m) => m.t === 'a-schat').length, 0);

  // mask tier: delivered, starred out, exactly as it would be in the plaza.
  // A fresh connection because a REFUSED line still spends the one-a-second
  // budget: the gap is checked before the filter, so a bad line cannot be
  // retried at speed to probe the wordlist.
  const mark2 = framesFor(ownerConn).length;
  const r = performOp(actorFrom(conn('Modsy', modRec)), 'a-schat', { text: 'porn spam in the den' });
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.masked, true);
  const heard = framesFor(ownerConn).slice(mark2).find((m) => m.t === 'a-schat');
  assert.ok(heard.text.includes('*'), 'the mask tier reached staff unmasked');
  assert.equal(heard.text.includes('porn'), false);

  offline(modConn); offline(ownerConn);
});

test('the staff channel is rate limited to about a line a second', () => {
  const modConn = online(conn('Modsy', modRec));
  const a = performOp(actorFrom(modConn), 'a-schat', { text: 'first' });
  assert.equal(a.ok, true);
  const b = performOp(actorFrom(modConn), 'a-schat', { text: 'second' });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'slow');
  // and an empty line is not a line
  const c = performOp(actorFrom(conn('Modsy', modRec)), 'a-schat', { text: '   ' });
  assert.equal(c.code, 'args');
  offline(modConn);
});

test('the audit line for a staff message counts it and never quotes it', () => {
  const modConn = online(conn('Modsy', modRec));
  const secret = 'the raider is capyzilla, watch the mural';
  performOp(actorFrom(modConn), 'a-schat', { text: secret });
  const line = lastLog();
  assert.equal(line.op, 'mod.staffchat');
  assert.equal(line.ok, true);
  assert.equal(typeof line.args.to, 'number');
  assert.equal(line.args.chars, secret.length);
  assert.equal(JSON.stringify(line).includes('capyzilla'), false, 'the staff channel leaked into the audit log');
  // a REFUSED line must not leak either
  performOp(actorFrom(conn('Modsy', modRec)), 'a-schat', { text: 'kys capyzilla' });
  assert.equal(JSON.stringify(lastLog()).includes('capyzilla'), false);
  assert.equal(lastLog().args.deny, 'filtered');
  offline(modConn);
});

test('a muted mod is muted in the staff channel too', () => {
  // An admin can mute a mod (the rank guard is strictly greater), and a mute
  // that only changes your audience is not a mute.
  assert.ok(MUTED_FRAMES.includes('a-schat'));
  const quiet = mkRec('Hushed', 'mod');
  quiet.mute = { until: Date.now() + 60_000, by: 'DavidEdge', reason: 'shouting' };
  const p = online(conn('Hushed', quiet));
  const ownerConn = online(conn('DavidEdge', ownerRec));
  const mark = framesFor(ownerConn).length;
  assert.equal(handleMessage(p, { t: 'a-schat', text: 'let me in' }), true);
  assert.equal(framesFor(ownerConn).slice(mark).filter((m) => m.t === 'a-schat').length, 0);
  assert.equal(last(p).t, 'toast');
  assert.match(last(p).msg, /muted/i);
  quiet.mute = null;
  offline(p); offline(ownerConn);
});

/* ── a-reports / a-resolve: the queue seam ──────────────────────────────── */

test('a-reports hands back the OPEN queue by default', () => {
  fakeReports.calls.length = 0;
  const r = opAs(modRec, 'a-reports', {});
  assert.equal(r.ok, true);
  assert.equal(r.state, 'open');
  assert.equal(fakeReports.calls[0].filter.state, 'open', 'the queue was not asked for the inbox');
  assert.equal(r.reports.length, 2);
  assert.equal(r.counts.open, 2);
  assert.equal(r.total, 2);
  // 'all' is how the panel asks past the inbox; the limit is clamped
  const all = opAs(modRec, 'a-reports', { state: 'all', limit: 9999 });
  assert.equal(all.state, '');
  assert.equal(fakeReports.calls[1].filter.state, '');
  assert.ok(fakeReports.calls[1].filter.limit <= 50);
  assert.equal(lastLog().op, 'mod.reports');
});

test('a player never sees the queue, and a forged frame dies on the server', () => {
  const p = online(conn('Norm', normRec));
  const before = framesFor(p).length;
  assert.equal(handleMessage(p, { t: 'a-reports' }), true);
  assert.equal(handleMessage(p, { t: 'a-resolve', id: 'r_a1' }), true);
  assert.equal(framesFor(p).length, before, 'the panel-less player was answered');
  assert.equal(fakeReports.rows.find((r) => r.id === 'r_a1').state, 'open');
  offline(p);
});

test('a-resolve closes one report, through reports.js, audited', () => {
  const m = online(conn('Modsy', modRec));
  assert.equal(handleMessage(m, { t: 'a-resolve', id: 'r_a1', state: 'actioned', note: 'muted for a day' }), true);
  const ack = last(m);
  assert.equal(ack.t, 'a-ok');
  assert.equal(ack.op, 'a-resolve');
  assert.equal(ack.id, 'r_a1');
  assert.equal(ack.state, 'actioned');
  assert.equal(fakeReports.rows.find((r) => r.id === 'r_a1').state, 'actioned');

  const call = fakeReports.calls.find((c) => c.fn === 'setState');
  assert.equal(call.actor, 'Modsy', 'reports.js was handed the actor, so it can run its own gate');
  assert.equal(call.note, 'muted for a day');

  const line = lastLog();
  assert.equal(line.op, 'mod.report.resolve');
  assert.equal(line.args.report, 'r_a1');
  assert.equal(line.args.state, 'actioned');
  offline(m);
});

test('a-resolve passes the queue refusals straight back', () => {
  const missing = opAs(modRec, 'a-resolve', { id: 'r_nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'notfound');
  const noNote = opAs(modRec, 'a-resolve', { id: 'r_a2', state: 'dismissed' });
  assert.equal(noNote.ok, false);
  assert.equal(noNote.code, 'reason');
  const junk = opAs(modRec, 'a-resolve', { id: 'r_a2', state: 'burned' });
  assert.equal(junk.code, 'args');
  const nothing = opAs(modRec, 'a-resolve', {});
  assert.equal(nothing.code, 'args');
  assert.equal(fakeReports.rows.find((r) => r.id === 'r_a2').state, 'open');
});
