/**
 * server/db.js + server/store.js: the account SHAPE, the discipline windows
 * every gate reads, the rename that moves a record between four places at
 * once, and the atomic write that is the whole reason a power cut cannot cost
 * the island its players.
 *
 *   node --test test/
 *
 * Everything runs inside a throwaway COVE_DATA_DIR, set before db.js is
 * imported (it resolves DATA_DIR once, at import time). No server is started
 * and no socket is opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SANDBOX = path.join(os.tmpdir(), `cove-db-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const db = await import('../server/db.js');
const store = await import('../server/store.js');

const {
  ensureAccount, banActive, muteActive, muteRemaining, bumpTokenV, setRole,
  roleOf, isRole, ROLES, renameAccount, users, ensureFriends, ensureHouse,
} = db;

/** Put a record in the live map the way auth.signup does, so it goes through
 *  the store's normalize hook (uid, role, tokenV, mute, ban). */
function mkUser(username, extra = {}) {
  users.set(username.toLowerCase(), { username, coins: 0, created: Date.now(), ...extra });
  return users.get(username.toLowerCase());
}

const MIN = 60_000;

/* ── ensureAccount: the shape every other module assumes ─────────────────── */

test('ensureAccount backfills the whole wave-9 field set', () => {
  const rec = ensureAccount({ username: 'Bare' });
  assert.match(rec.uid, /^u_[0-9a-f]{16}$/);
  assert.equal(rec.role, 'player');
  assert.equal(rec.tokenV, 1);
  assert.ok(rec.lastSeen > 0);
  assert.equal(rec.mute, null);
  assert.equal(rec.ban, null);
});

test('ensureAccount is idempotent: the uid never moves', () => {
  const rec = ensureAccount({ username: 'Stable' });
  const uid = rec.uid;
  for (let i = 0; i < 3; i++) ensureAccount(rec);
  assert.equal(rec.uid, uid);
  assert.equal(rec.tokenV, 1);
});

test('ensureAccount repairs junk rather than trusting the file', () => {
  const rec = ensureAccount({
    username: 'Junk', uid: 'not-a-uid', role: 'superadmin', tokenV: -4,
    lastSeen: 'yesterday', mute: 'muted', ban: [], lastIpH: 12345,
    renamedAt: 'soon',
  });
  assert.match(rec.uid, /^u_[0-9a-f]{16}$/);
  assert.equal(rec.role, 'player', 'an invented role must not survive a load');
  assert.equal(rec.tokenV, 1);
  assert.ok(rec.lastSeen > 0);
  assert.equal(rec.mute, null);
  assert.equal(rec.ban, null);
  assert.equal(rec.lastIpH, undefined);
  assert.equal(rec.renamedAt, undefined);
});

test('ensureAccount lets the store veto a duplicate uid', () => {
  const dupe = 'u_0123456789abcdef';
  const rec = ensureAccount({ username: 'Copy', uid: dupe }, { uidTaken: (u) => u === dupe });
  assert.notEqual(rec.uid, dupe);
  assert.match(rec.uid, /^u_[0-9a-f]{16}$/);
});

test('ensureAccount reads a legacy permanent ban as permanent', () => {
  // The spec floated `until: 0` for "forever". A schema change must never
  // silently downgrade a permanent ban into no ban at all.
  for (const until of [0, '0', null, 'forever']) {
    const rec = ensureAccount({ username: 'Old', ban: { until, reason: 'x' } });
    assert.equal(rec.ban.until, 'forever', String(until));
    assert.ok(banActive(rec), String(until));
  }
  // ...but nonsense is not a ban
  assert.equal(ensureAccount({ username: 'Old2', ban: { until: 'tuesday' } }).ban, null);
  assert.equal(ensureAccount({ username: 'Old3', ban: [] }).ban, null);
});

test('a record on the way into the live map is normalised', () => {
  const rec = mkUser('Fresh');
  assert.match(rec.uid, /^u_[0-9a-f]{16}$/);
  assert.equal(rec.role, 'player');
  assert.equal(rec.tokenV, 1);
  assert.deepEqual(ensureFriends(rec), []);
  assert.equal(typeof ensureHouse(rec), 'object');
});

/* ── discipline windows ─────────────────────────────────────────────────── */

test('banActive is a window, not a flag', () => {
  const now = Date.now();
  assert.equal(banActive({}), null, 'no ban');
  assert.equal(banActive({ ban: null }), null);
  assert.equal(banActive({ ban: { until: now - MIN } }, now), null, 'expired');
  assert.equal(banActive({ ban: { until: now } }, now), null, 'expiring this instant');
  assert.ok(banActive({ ban: { until: now + MIN } }, now), 'live');
  assert.ok(banActive({ ban: { until: 'forever' } }, now), 'permanent');
  assert.equal(banActive(null), null);
  assert.equal(banActive(undefined), null);
});

test('muteRemaining counts down and muteActive follows it', () => {
  const now = Date.now();
  assert.equal(muteRemaining({}, now), 0);
  assert.equal(muteRemaining({ mute: { until: now - 1 } }, now), 0);
  assert.equal(muteRemaining({ mute: { until: now + 5000 } }, now), 5000);
  assert.equal(muteActive({ mute: { until: now + 5000 } }, now), true);
  assert.equal(muteActive({ mute: { until: now - 5000 } }, now), false);
  // 'forever' is legal for a ban and NOT for a mute: a mute always ends
  assert.equal(muteRemaining({ mute: { until: 'forever' } }, now), 0);
});

test('roles are validated on write and read', () => {
  const rec = mkUser('Roler');
  assert.equal(roleOf(rec), 'player');
  assert.equal(setRole(rec, 'wizard'), false, 'an unknown role must be refused');
  assert.equal(rec.role, 'player');
  const v = rec.tokenV;
  assert.equal(setRole(rec, 'mod'), true);
  assert.equal(rec.role, 'mod');
  assert.equal(rec.tokenV, v + 1, 'a role change logs you out everywhere');
  assert.equal(setRole(rec, 'mod'), true, 'idempotent');
  assert.equal(rec.tokenV, v + 1, 'a no-op role write must not churn tokens');
  assert.deepEqual(ROLES, ['player', 'mod', 'admin']);
  assert.equal(isRole('admin'), true);
  assert.equal(isRole('owner'), false);
  assert.equal(roleOf({ role: 'nope' }), 'player');
  assert.equal(roleOf(null), 'player');
});

test('bumpTokenV always moves forward', () => {
  const rec = mkUser('Bumper');
  assert.equal(bumpTokenV(rec), 2);
  assert.equal(bumpTokenV(rec), 3);
  rec.tokenV = 'garbage';
  assert.equal(bumpTokenV(rec), 1);
  assert.equal(bumpTokenV(null), 0);
});

/* ── renameAccount ──────────────────────────────────────────────────────── */

test('renameAccount moves the record and sweeps every reference to it', () => {
  const target = mkUser('OldName');
  const friend = mkUser('Palsy');
  const host = mkUser('Hosty');
  ensureFriends(friend).push('oldname');
  ensureHouse(host).invites.push('oldname');
  const uid = target.uid;
  const tokenV = target.tokenV;

  const r = renameAccount('OldName', 'NewName');
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.uid, uid, 'identity survives a rename: every audit line still points here');
  assert.equal(r.oldKey, 'oldname');
  assert.equal(r.newKey, 'newname');
  assert.equal(r.oldName, 'OldName');
  assert.equal(r.newName, 'NewName');
  assert.equal(r.friendsSwept, 1);
  assert.equal(r.invitesSwept, 1);
  assert.deepEqual(r.houseRoom, { from: 'house:oldname', to: 'house:newname' });

  assert.equal(users.has('oldname'), false);
  assert.equal(users.get('newname'), target, 'the same object, rekeyed');
  assert.equal(target.username, 'NewName');
  assert.equal(target.tokenV, tokenV + 1, 'the token embeds the username');
  assert.ok(target.renamedAt > 0);
  assert.deepEqual(friend.friends, ['newname']);
  assert.deepEqual(host.house.invites, ['newname']);
});

test('renameAccount refuses a taken name, a bad shape and a missing account', () => {
  mkUser('Keeper');
  mkUser('Squatter');
  assert.equal(renameAccount('Keeper', 'Squatter').ok, false);
  assert.equal(renameAccount('Keeper', 'no spaces').ok, false);
  assert.equal(renameAccount('Keeper', 'ab').ok, false);
  assert.equal(renameAccount('Ghost', 'Whatever').ok, false);
  assert.equal(users.get('keeper').username, 'Keeper', 'a refused rename changes nothing');
});

test('renameAccount handles a capitalisation-only change', () => {
  const rec = mkUser('lowercapy');
  const r = renameAccount('lowercapy', 'LowerCapy');
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.oldKey, r.newKey);
  assert.equal(users.get('lowercapy').username, 'LowerCapy');
  assert.equal(rec.username, 'LowerCapy');
});

/* ── the atomic write ───────────────────────────────────────────────────── */

test('writeFileAtomic replaces a file whole and leaves no temp behind', () => {
  const dir = path.join(SANDBOX, 'atomic');
  const file = path.join(dir, 'thing.json');
  store.writeJsonAtomic(file, { v: 1 });
  assert.deepEqual(store.readJsonSafe(file).value, { v: 1 });
  store.writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(store.readJsonSafe(file).value, { v: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['thing.json'], 'a .tmp- file survived a clean write');
});

test('a crash mid-write leaves the previous file completely intact', () => {
  // The atomicity lives entirely in the rename: everything before it writes to
  // a temp file nobody reads. Killing the process at exactly that point is the
  // worst case, and this simulates it by making the rename itself fail.
  const dir = path.join(SANDBOX, 'crash');
  const file = path.join(dir, 'users.json');
  store.writeJsonAtomic(file, { alice: { coins: 100 } });

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated power cut'); };
  let threw = null;
  try {
    store.writeJsonAtomic(file, { alice: { coins: 999 }, bob: { coins: 5 } });
  } catch (e) {
    threw = e;
  } finally {
    fs.renameSync = realRename;
  }

  assert.ok(threw, 'a failed write must throw, not report success');
  const after = store.readJsonSafe(file);
  assert.equal(after.ok, true, 'the old file is still parseable');
  assert.deepEqual(after.value, { alice: { coins: 100 } }, 'no half-written record');
  assert.deepEqual(fs.readdirSync(dir), ['users.json'], 'the temp file was cleaned up');
});

test('a leftover temp file from an older crash is not mistaken for data', () => {
  const dir = path.join(SANDBOX, 'leftover');
  const file = path.join(dir, 'users.json');
  store.writeJsonAtomic(file, { alice: { coins: 100 } });
  fs.writeFileSync(`${file}.tmp-1234-1`, '{"alice":{"coi');
  const read = store.readJsonSafe(file);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { alice: { coins: 100 } });
});

test('readJsonSafe reports corruption instead of throwing', () => {
  const file = path.join(SANDBOX, 'corrupt', 'users.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"alice": {"coins": 1');
  const read = store.readJsonSafe(file);
  assert.equal(read.ok, false);
  assert.equal(read.value, null);
  assert.ok(read.error);
  // a file that is not there at all is not an error
  assert.deepEqual(store.readJsonSafe(path.join(SANDBOX, 'nope.json')), { ok: true, value: null, error: null });
});

test('a corrupt users.json is set aside, never silently overwritten', () => {
  const dir = path.join(SANDBOX, 'store-corrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'users.json'), 'this is not json');
  const s = store.createStore({ dataDir: dir, fileName: 'users.json', log: () => {} });
  const n = s.load();
  assert.equal(n, 0, 'nothing to load from a corrupt file with no backup');
  const kept = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(kept.length, 1, 'the unreadable file must be kept as evidence');
});

test('a round trip through the store survives a restart', () => {
  const dir = path.join(SANDBOX, 'restart');
  const a = store.createStore({ dataDir: dir, fileName: 'users.json', log: () => {} });
  a.load();
  a.putUser({ username: 'Restarty', uid: 'u_00000000000000aa', coins: 42 }, 'restarty');
  assert.ok(a.flush());

  const b = store.createStore({ dataDir: dir, fileName: 'users.json', log: () => {} });
  assert.equal(b.load(), 1);
  const rec = b.getUser('RESTARTY');
  assert.equal(rec.coins, 42);
  assert.equal(rec.username, 'Restarty');
  assert.equal(b.findByUid('u_00000000000000aa'), rec);
  assert.equal(b.hasUser('nobody'), false);
});

test('rekey preserves identity and refuses to clobber', () => {
  const dir = path.join(SANDBOX, 'rekey');
  const s = store.createStore({ dataDir: dir, fileName: 'users.json', log: () => {} });
  s.load();
  const rec = s.putUser({ username: 'From', uid: 'u_00000000000000bb' }, 'from');
  s.putUser({ username: 'Blocker', uid: 'u_00000000000000cc' }, 'blocker');
  assert.equal(s.rekey('from', 'blocker'), false, 'must not clobber');
  assert.equal(s.rekey('nobody', 'to'), false);
  assert.equal(s.rekey('from', 'to'), true);
  assert.equal(s.getUser('to'), rec);
  assert.equal(s.getUser('from'), null);
  assert.equal(s.findByUid('u_00000000000000bb'), rec, 'the uid index followed the record');
});
