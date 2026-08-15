/**
 * server/auth.js: signup validation, the password floor, the four-part session
 * token and every way it can be refused, and the recovery codes that stand in
 * for an email subsystem this project deliberately does not have.
 *
 *   node --test test/
 *
 * Runs inside a throwaway COVE_DATA_DIR, set before db.js is imported. The only
 * thing forged here is a token: `makeToken` signs `username.tokenV.exp` with
 * the secret in the sandbox, so an expired or stale-version token can be built
 * honestly with db.getSecret() rather than by waiting fourteen days.
 *
 * scrypt is deliberately slow (~60-100ms a call), so accounts that do not need
 * a password are created straight in the map and only the paths under test pay
 * for hashing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SANDBOX = path.join(os.tmpdir(), `cove-auth-${process.pid}-${Date.now()}`);
process.env.COVE_DATA_DIR = SANDBOX;
fs.mkdirSync(SANDBOX, { recursive: true });

const auth = await import('../server/auth.js');
const db = await import('../server/db.js');

const {
  signup, login, verifyToken, readToken, makeToken, maybeRefreshToken,
  banMessage, publicProfile, changePassword, recover, consumeRecoveryCode,
  generateRecoveryCodes, normalizeRecoveryCode, recoveryStatus, hasRecoveryCodes,
  TOKEN_TTL_MS, TOKEN_REFRESH_MS, PASSWORD_MIN_LEN, RECOVERY_CODE_COUNT,
  RECOVERY_MAX_TRIES,
} = auth;
const { users, bumpTokenV } = db;

const SECRET = db.getSecret();
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');
/** A correctly signed token with any expiry and version we like. */
function forgeToken(username, tokenV, exp) {
  const body = `${username}.${tokenV}.${exp}`;
  return `${body}.${sign(body)}`;
}

const PW = 'cocoa-and-lanterns';
const DAY = 24 * 60 * 60 * 1000;

/** An account with no usable password, for the paths that never check one. */
function mkUser(username, extra = {}) {
  users.set(username.toLowerCase(), { username, coins: 0, created: Date.now(), ...extra });
  return users.get(username.toLowerCase());
}

/* ── signup validation ──────────────────────────────────────────────────── */

test('signup refuses a name that is the wrong shape', async () => {
  for (const bad of ['ab', 'a'.repeat(17), 'has space', 'punct!', '', null, 42]) {
    const r = await signup({ username: bad, password: PW });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.msg, /^Name:/, String(bad));
  }
});

test('signup refuses a name the filter refuses, and offers a clean one', async () => {
  const r = await signup({ username: 'AdminGuy', password: PW });
  assert.equal(r.ok, false);
  assert.ok(r.msg);
  assert.equal(typeof r.suggestion, 'string');
  assert.equal(users.has('adminguy'), false, 'a refused signup must not create a record');
  const ok = await signup({ username: r.suggestion, password: PW });
  assert.equal(ok.ok, true, `the suggestion ${r.suggestion} was itself refused`);
});

test('the password floor is enforced and it is the only password rule', async () => {
  for (const bad of ['', 'short', 'abcde', null, 12345678, { }]) {
    const r = await signup({ username: 'PwTest', password: bad });
    assert.equal(r.ok, false, String(bad));
    assert.match(r.msg, /Password too short/, String(bad));
  }
  // exactly at the floor is fine; complexity is not required (a passphrase
  // beats an alphabet-soup rule nobody can remember)
  const r = await signup({ username: 'PwTest', password: 'a'.repeat(PASSWORD_MIN_LEN) });
  assert.equal(r.ok, true, r.msg);
});

test('signup mints an account with the welcome gift and one-time codes', async () => {
  const r = await signup({ username: 'Mossy', password: PW });
  assert.equal(r.ok, true, r.msg);
  assert.equal(typeof r.token, 'string');
  assert.equal(r.profile.name, 'Mossy');
  assert.equal(r.profile.coins, 100);
  assert.equal(r.profile.hat, 'none');
  assert.deepEqual(r.profile.ownedHats, ['none']);
  assert.deepEqual(r.profile.bests, {});
  assert.equal(r.profile.role, 'player');
  assert.deepEqual(r.profile.caps, [], 'a fresh player holds no capabilities');
  assert.equal(r.profile.muteUntil, 0);
  assert.equal(r.recoveryCodes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(r.recoveryCodes).size, RECOVERY_CODE_COUNT, 'duplicate recovery codes');
  // the record is normalised on the way into the map
  const rec = users.get('mossy');
  assert.match(rec.uid, /^u_[0-9a-f]{16}$/);
  assert.equal(rec.tokenV, 1);
  assert.equal(rec.ban, null);
  // the plaintext codes exist exactly once, in the response
  assert.equal(rec.recovery.codes.every((c) => typeof c.hash === 'string' && !c.usedAt), true);
  assert.equal(JSON.stringify(rec).includes(r.recoveryCodes[0]), false, 'a code was stored in the clear');
});

test('names are taken case-insensitively', async () => {
  assert.equal((await signup({ username: 'Taken', password: PW })).ok, true);
  const r = await signup({ username: 'TAKEN', password: PW });
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'That name is taken');
});

test('publicProfile hands out copies, never the live record', () => {
  const rec = mkUser('Copycat', { coins: 5, ownedHats: ['none', 'beanie'], bests: { fishing: 9 } });
  const a = publicProfile(rec);
  const b = publicProfile(rec);
  a.ownedHats.push('viking');
  a.bests.fishing = 9999;
  assert.deepEqual(b.ownedHats, ['none', 'beanie'], 'two sessions shared one array');
  assert.deepEqual(b.bests, { fishing: 9 });
  assert.deepEqual(rec.ownedHats, ['none', 'beanie']);
});

/* ── login ──────────────────────────────────────────────────────────────── */

test('login accepts the right password and nothing else', async () => {
  await signup({ username: 'Loginy', password: PW });
  const good = await login({ username: 'LOGINY', password: PW });
  assert.equal(good.ok, true, good.msg);
  assert.equal(good.profile.name, 'Loginy');
  assert.equal(verifyToken(good.token), 'Loginy');

  const bad = await login({ username: 'Loginy', password: 'wrong-one-entirely' });
  assert.equal(bad.ok, false);
  const missing = await login({ username: 'NoSuchCapy', password: PW });
  assert.equal(missing.ok, false);
  assert.equal(bad.msg, missing.msg, 'a prober must not learn which accounts exist');
});

test('login refuses a banned account and names the ban', async () => {
  await signup({ username: 'Banned', password: PW });
  const rec = users.get('banned');
  rec.ban = { until: Date.now() + DAY, by: 'DavidEdge', reason: 'griefing', at: Date.now() };
  const r = await login({ username: 'Banned', password: PW });
  assert.equal(r.ok, false);
  assert.equal(r.banned, true);
  assert.match(r.msg, /banned/i);
  assert.match(r.msg, /griefing/);
});

/* ── banMessage: the contract the hello gate depends on ─────────────────── */

test('auth.banMessage is empty for a clean record and a sentence for a banned one', () => {
  // auth's version returns '' when there is no ban, so `if (banMessage(rec))`
  // is safe HERE. server/admin.js exports a differently-shaped banMessage that
  // returns "You are not banned." — see test/admin.test.js. Nothing may assume
  // the two behave alike.
  assert.equal(banMessage(mkUser('Clean')), '');
  assert.equal(banMessage(null), '');
  const rec = mkUser('Naughty', { ban: { until: 'forever', reason: 'slurs', at: Date.now() } });
  assert.match(banMessage(rec), /permanently/);
  assert.match(banMessage(rec), /slurs/);
  const temp = mkUser('Naughty2', { ban: { until: Date.now() + DAY, reason: '', at: Date.now() } });
  assert.match(banMessage(temp), /banned until/);
});

/* ── tokens ─────────────────────────────────────────────────────────────── */

test('a token round-trips and carries the display casing', () => {
  const rec = mkUser('CaseySensitive'.slice(0, 14));
  const token = makeToken(rec.username, rec);
  assert.equal(verifyToken(token), rec.username);
  const info = readToken(token);
  assert.equal(info.rec, rec);
  assert.equal(info.tokenV, 1);
  assert.ok(info.exp > Date.now() + TOKEN_TTL_MS - 60_000);
});

test('verifyToken refuses everything that is not a live token', () => {
  const rec = mkUser('Tokeny');
  const token = makeToken(rec.username, rec);
  const [user, ver, exp, sig] = token.split('.');

  assert.equal(verifyToken(undefined), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken(42), null);
  assert.equal(verifyToken(`${user}.${exp}.${sig}`), null, 'a pre-wave-9 three-part token');
  assert.equal(verifyToken(`${user}.${ver}.${exp}.${'f'.repeat(64)}`), null, 'forged signature');
  assert.equal(verifyToken(`${user}.${ver}.${exp}.${sig}x`), null, 'signature length');
  assert.equal(verifyToken(`${user}.${ver}.${exp}.${'é'.repeat(64)}`), null, 'multi-byte signature must not throw');
  assert.equal(verifyToken(forgeToken('Nobody', 1, Date.now() + DAY)), null, 'no such account');
  assert.equal(verifyToken(forgeToken(rec.username, 1, Date.now() - 1)), null, 'expired');
  assert.equal(verifyToken(forgeToken(rec.username, 99, Date.now() + DAY)), null, 'stale tokenV');
});

test('bumping tokenV kills every token in the wild', () => {
  const rec = mkUser('Revoked');
  const token = makeToken(rec.username, rec);
  assert.equal(verifyToken(token), 'Revoked');
  bumpTokenV(rec);
  assert.equal(verifyToken(token), null);
  assert.equal(verifyToken(makeToken(rec.username, rec)), 'Revoked', 'a fresh token still works');
});

test('maybeRefreshToken only fires inside the last week', () => {
  const rec = mkUser('Refreshy');
  assert.equal(maybeRefreshToken(makeToken(rec.username, rec)), null, 'a brand new token needs nothing');
  const old = forgeToken(rec.username, rec.tokenV, Date.now() + TOKEN_REFRESH_MS - DAY);
  const fresh = maybeRefreshToken(old);
  assert.equal(typeof fresh, 'string');
  assert.notEqual(fresh, old);
  assert.equal(verifyToken(fresh), 'Refreshy');
  assert.equal(maybeRefreshToken('nonsense'), null);
});

/* ── recovery codes ─────────────────────────────────────────────────────── */

test('normalizeRecoveryCode accepts what a human types back', () => {
  for (const typed of ['otter-lantern-742', 'OTTER-LANTERN-742', ' otter lantern 742 ',
    'otter_lantern_742', 'CAPY-otter-lantern-742', 'otter--lantern--742']) {
    assert.equal(normalizeRecoveryCode(typed), 'otter-lantern-742', typed);
  }
  for (const bad of ['otter-lantern', 'otter-lantern-7', 'otter-lantern-7421',
    '123-456-789', '', null, 'otter-lantern-742-extra']) {
    assert.equal(normalizeRecoveryCode(bad), '', String(bad));
  }
});

test('generateRecoveryCodes mints distinct word codes and stores only hashes', async () => {
  const { codes, recovery } = await generateRecoveryCodes(4);
  assert.equal(codes.length, 4);
  assert.equal(new Set(codes).size, 4);
  for (const c of codes) assert.match(c, /^[a-z]+-[a-z]+-\d{3}$/);
  assert.equal(recovery.codes.length, 4);
  assert.equal(typeof recovery.salt, 'string');
  for (const entry of recovery.codes) {
    assert.equal(entry.usedAt, 0);
    assert.equal(entry.hash.length, 64);
    assert.equal(codes.includes(entry.hash), false);
  }
});

test('a recovery code is a login, spends once, and logs the thief out', async () => {
  const made = await signup({ username: 'Recovery', password: PW });
  const code = made.recoveryCodes[0];
  const rec = users.get('recovery');
  const stolenToken = makeToken(rec.username, rec);
  assert.equal(hasRecoveryCodes(rec), true);
  assert.equal(recoveryStatus(rec).remaining, RECOVERY_CODE_COUNT);

  const r = await consumeRecoveryCode('RECOVERY', code.toUpperCase());
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.mustReset, true, 'the client must be forced through a new password');
  assert.equal(r.remaining, RECOVERY_CODE_COUNT - 1);
  assert.equal(verifyToken(r.token), 'Recovery');
  assert.equal(verifyToken(stolenToken), null, 'recovering must log every other session out');

  const again = await consumeRecoveryCode('Recovery', code);
  assert.equal(again.ok, false, 'a one-time code was accepted twice');
});

test('recover() is the whole round trip, and the new password works', async () => {
  const made = await signup({ username: 'Rounder', password: PW });
  const r = await recover({ username: 'Rounder', code: made.recoveryCodes[1], newPassword: 'brand-new-passphrase' });
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.remaining, RECOVERY_CODE_COUNT - 1);
  assert.equal(users.get('rounder').mustReset, undefined, 'the reset flag must be cleared');
  assert.equal((await login({ username: 'Rounder', password: 'brand-new-passphrase' })).ok, true);
  assert.equal((await login({ username: 'Rounder', password: PW })).ok, false, 'the old password still works');
  // a too-short new password is refused before the code is spent
  const short = await recover({ username: 'Rounder', code: made.recoveryCodes[2], newPassword: 'abc' });
  assert.equal(short.ok, false);
  assert.match(short.msg, /Password too short/);
  assert.equal(recoveryStatus(users.get('rounder')).remaining, RECOVERY_CODE_COUNT - 1, 'a refused reset burned a code');
});

test('a banned account cannot be recovered into, and keeps its code', async () => {
  const made = await signup({ username: 'BanRec', password: PW });
  const rec = users.get('banrec');
  rec.ban = { until: 'forever', by: 'DavidEdge', reason: 'slurs', at: Date.now() };
  const r = await consumeRecoveryCode('BanRec', made.recoveryCodes[0]);
  assert.equal(r.ok, false);
  assert.equal(r.banned, true);
  assert.equal(recoveryStatus(rec).remaining, RECOVERY_CODE_COUNT, 'a ban must not burn the code');
});

test('the consume path is throttled per account', async () => {
  mkUser('Probed', { recovery: { salt: 'abc', issuedAt: Date.now(), codes: [{ hash: 'x'.repeat(64), usedAt: 0 }] } });
  let throttled = false;
  for (let i = 0; i < RECOVERY_MAX_TRIES + 2 && !throttled; i++) {
    const r = await consumeRecoveryCode('Probed', 'otter-lantern-742');
    if (/Too many attempts/.test(r.msg)) throttled = true;
  }
  assert.equal(throttled, true, `guessing was never throttled inside ${RECOVERY_MAX_TRIES + 2} tries`);
});

/* ── changePassword ─────────────────────────────────────────────────────── */

test('changePassword needs the old password and revokes other sessions', async () => {
  await signup({ username: 'Changer', password: PW });
  const rec = users.get('changer');
  const oldToken = makeToken(rec.username, rec);

  const wrong = await changePassword({ username: 'Changer', password: 'not-it-at-all', newPassword: 'a-fresh-secret' });
  assert.equal(wrong.ok, false);

  const short = await changePassword({ username: 'Changer', password: PW, newPassword: 'abc' });
  assert.equal(short.ok, false);
  assert.match(short.msg, /Password too short/);

  const ok = await changePassword({ username: 'Changer', password: PW, newPassword: 'a-fresh-secret' });
  assert.equal(ok.ok, true, ok.msg);
  assert.equal(verifyToken(oldToken), null, 'a password change must log every other session out');
  assert.equal(verifyToken(ok.token), 'Changer');
  assert.equal((await login({ username: 'Changer', password: 'a-fresh-secret' })).ok, true);
});
