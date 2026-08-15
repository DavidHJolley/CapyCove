/**
 * The guest hello clamps, and the one login regression that has to be proved
 * against the real server rather than a fake.
 *
 *   node --test test/
 *
 * Guest progress lives on the CLIENT — coins, hats and bests all arrive inside
 * the hello frame, from a machine the player controls. server/index.js clamps
 * them inline, so there is nothing importable to unit-test: this file boots the
 * actual server on a sandbox COVE_DATA_DIR and a free port, speaks ws to it
 * (Node's own WebSocket, no dependency), and reads the welcome frame back.
 *
 * Everything it writes lands in the sandbox and is deleted at the end. Bots are
 * off (COVE_BOTS=0) so the only capys in the cove are the ones we connect.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { HATS, MINIGAMES, NAME_MIN_LEN } from '../shared/constants.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(os.tmpdir(), `cove-srv-${process.pid}-${Date.now()}`);

let child = null;
let port = 0;
const stderr = [];

/** Ask the OS for a port nobody is using, then hand it straight to the server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(deadlineMs = 20_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${stderr.join('')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not listening yet */ }
    await sleep(120);
  }
  throw new Error(`server never became healthy on :${port}\n${stderr.join('')}`);
}

before(async () => {
  fs.mkdirSync(SANDBOX, { recursive: true });
  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      COVE_DATA_DIR: SANDBOX,
      PORT: String(port),
      COVE_BOTS: '0',
      COVE_ADMIN: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderr.push(d));
  child.stdout.resume();
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* windows file lock */ }
});

/**
 * Open a socket, say hello, and hand back the first frame that answers it.
 * The server follows a welcome with `clock` and `parties`; nothing here cares.
 */
function hello(frame, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => { done(new Error('no answer to hello')); }, timeoutMs);
    function done(err, msg) {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      if (err) reject(err); else resolve(msg);
    }
    ws.addEventListener('error', () => done(new Error('socket error')));
    ws.addEventListener('close', () => done(new Error('closed before answering')));
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'hello', ...frame })));
    ws.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome' || m.t === 'denied') done(null, m);
    });
  });
}

const guest = async (extra) => (await hello({ guestName: 'Sandy Paws', ...extra }));
const post = async (route, body) => (await fetch(`http://127.0.0.1:${port}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json();

/* ── it is alive ────────────────────────────────────────────────────────── */

test('the server boots clean on a sandbox data dir', async () => {
  const h = await waitForHealth(2000);
  assert.equal(h.ok, true);
  assert.equal(h.online, 0, 'COVE_BOTS=0 should leave the island empty');
  assert.equal(stderr.join(''), '', 'the server logged to stderr during boot');
});

/* ── guest hello: every field is the client's claim, and every claim is clamped ── */

test('a plain guest hello is welcomed', async () => {
  const w = await guest();
  assert.equal(w.t, 'welcome');
  assert.equal(w.profile.name, 'Sandy Paws');
  assert.equal(w.profile.registered, false);
  assert.equal(w.profile.coins, 0);
  assert.deepEqual(w.profile.ownedHats, ['none']);
  assert.deepEqual(w.profile.bests, {});
  assert.equal(w.profile.hat, 'none');
});

test('a guest coin claim is absurdity-bounded, and never below zero', async () => {
  // 9,999,999 is a tamper bound, not an earning cap (owner's law): the old
  // 99,999 wall was silently shaving a devoted guest's purse on reconnect
  assert.equal((await guest({ coins: 2_000_000_000 })).profile.coins, 9_999_999);
  assert.equal((await guest({ coins: 150_000 })).profile.coins, 150_000, 'a guest past the OLD wall keeps every coin');
  assert.equal((await guest({ coins: 250 })).profile.coins, 250, 'an honest guest keeps what they earned');
  assert.equal((await guest({ coins: -5000 })).profile.coins, 0);
  assert.equal((await guest({ coins: 'lots' })).profile.coins, 0);
  assert.equal((await guest({ coins: 1e308 })).profile.coins, 9_999_999);
  // Infinity and NaN cannot cross JSON: both arrive as null, which is 0 coins.
  assert.equal((await guest({ coins: Infinity })).profile.coins, 0);
  assert.equal((await guest({ coins: NaN })).profile.coins, 0);
  assert.equal((await guest({ coins: { n: 5 } })).profile.coins, 0);
  assert.equal((await guest({ coins: [5] })).profile.coins, 5, 'Number([5]) is 5; the clamp still holds');
});

test('hats come off an allowlist, not out of the frame', async () => {
  const w = await guest({ ownedHats: ['viking', 'crown_of_infinite_coins', 'none', 'beanie'] });
  assert.deepEqual(w.profile.ownedHats, ['none', 'viking', 'beanie'], 'an invented hat id must be dropped');
  for (const h of w.profile.ownedHats) assert.ok(Object.prototype.hasOwnProperty.call(HATS, h), h);

  // wearing one you own is fine; wearing one you do not is not
  assert.equal((await guest({ ownedHats: ['viking'], hat: 'viking' })).profile.hat, 'viking');
  assert.equal((await guest({ ownedHats: ['viking'], hat: 'tophat' })).profile.hat, 'none');
  assert.equal((await guest({ hat: 'crown_of_infinite_coins' })).profile.hat, 'none');

  // junk in the field itself must not crash the handler or leak through
  assert.deepEqual((await guest({ ownedHats: 'viking' })).profile.ownedHats, ['none']);
  assert.deepEqual((await guest({ ownedHats: [null, 7, {}, []] })).profile.ownedHats, ['none']);
  const many = await guest({ ownedHats: Array.from({ length: 500 }, (_, i) => `hat${i}`) });
  assert.deepEqual(many.profile.ownedHats, ['none']);
});

test('remembered bests must name a real game and sit inside real bounds', async () => {
  const w = await guest({
    bests: {
      fishing: 340,            // kept
      sled: 0,                 // a zero best is no best
      smoothie: -50,           // negative
      chess: 10_000_000,       // at the ceiling
      pong: 9_999_999,         // just under it: kept
      __proto__: 5,            // not an own game id
      dragonracing: 500,       // not a game at all
    },
  });
  assert.deepEqual(w.profile.bests, { fishing: 340, pong: 9999999 });
  for (const g of Object.keys(w.profile.bests)) {
    assert.ok(Object.prototype.hasOwnProperty.call(MINIGAMES, g), g);
  }
  assert.deepEqual((await guest({ bests: 'all of them' })).profile.bests, {});
  assert.deepEqual((await guest({ bests: [1, 2, 3] })).profile.bests, {});
  assert.deepEqual((await guest({ bests: { fishing: '250' } })).profile.bests, { fishing: 250 });
});

test('a guest cannot smuggle a role, caps or an account in through hello', async () => {
  const w = await guest({
    role: 'admin', caps: ['editor', 'ban'], registered: true, username: 'DavidEdge',
    token: undefined, title: 'Legend of the Cove', unlockedColors: ['#fff'],
  });
  assert.equal(w.profile.registered, false);
  assert.equal(w.profile.role, undefined, 'a guest profile carries no role at all');
  assert.equal(w.profile.caps, undefined);
  assert.equal(w.profile.username, undefined);
});

test('guest names go through the filter, with a suggestion on refusal', async () => {
  const short = await guest({ guestName: 'a'.repeat(NAME_MIN_LEN - 1) });
  assert.equal(short.t, 'denied');

  const nasty = await hello({ guestName: 'Kill Yourself' });
  assert.equal(nasty.t, 'denied');
  assert.ok(nasty.msg);
  assert.equal(typeof nasty.suggestion, 'string', 'a refused guest is offered a name they can click');

  // the guest path deliberately allows spaces, so this one must survive
  assert.equal((await hello({ guestName: 'Sandy Paws' })).t, 'welcome');
});

/* ── the account path ───────────────────────────────────────────────────── */

test('a signed-up account logs in over ws with the server\'s numbers', async () => {
  const made = await post('/api/signup', { username: 'WsCapy', password: 'cocoa-and-lanterns' });
  assert.equal(made.ok, true, made.msg);

  const w = await hello({ token: made.token, coins: 999999, ownedHats: ['viking'], bests: { fishing: 9999 } });
  assert.equal(w.t, 'welcome');
  assert.equal(w.profile.registered, true);
  assert.equal(w.profile.name, 'WsCapy');
  assert.equal(w.profile.coins, 100, 'an account reads its coins off the record, never off the frame');
  assert.deepEqual(w.profile.ownedHats, ['none']);
  assert.deepEqual(w.profile.bests, {});
  assert.deepEqual(w.profile.caps, []);
  assert.equal(w.profile.role, 'player');
});

test('a clean account is NOT denied at the hello ban gate', async () => {
  // The regression: admin.banMessage() returns a sentence even when there is
  // no ban, so a hello gate that tests its truthiness locks the whole island
  // out. The gate has to ask banActive() first. See test/admin.test.js for the
  // contract; this proves the shipped path obeys it.
  const made = await post('/api/signup', { username: 'NotBanned', password: 'cocoa-and-lanterns' });
  assert.equal(made.ok, true, made.msg);
  const w = await hello({ token: made.token });
  assert.equal(w.t, 'welcome', `a clean account was denied: ${w.msg}`);
});

test('a token that is not a token is refused', async () => {
  for (const token of ['nonsense', 'a.b.c.d', 'WsCapy.1.99999999999999.deadbeef']) {
    const r = await hello({ token });
    assert.equal(r.t, 'denied', token);
    assert.match(r.msg, /log in again/i, token);
  }
});
