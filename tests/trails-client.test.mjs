/**
 * The flourish slot's CLIENT plumbing, end to end and headless: the guest
 * profile schema, equipping, the 'shop' answer to a buy-trail, and a remote's
 * 'custom' frame turning into actual particles.
 *
 * Nothing is stubbed except the socket and the browser: the real NetClient
 * handler and the real pooled field do the work.
 *
 *   node --test tests/trails-client.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TRAILS } from '../shared/constants.js';
import { game } from '../src/core/game.js';
import { NetClient } from '../src/net/client.js';
import { updateTrails, trailField, disposeTrails } from '../src/player/trails.js';

// --- the browser, in the smallest useful amount -----------------------------

if (!globalThis.WebSocket) globalThis.WebSocket = { OPEN: 1 };
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

/** A game.net stand-in that records what the client tried to say. */
function fakeNet() {
  return { connected: true, sent: [], send(o) { this.sent.push(o); } };
}

function resetGame() {
  Object.assign(game.state, {
    name: 'Guest',
    registered: false,
    coins: 500,
    color: 0xb08a5a,
    hat: 'none',
    ownedHats: ['none'],
    trail: 'none',
    ownedTrails: ['none'],
    ownedFurniture: {},
    bests: {},
  });
  game.engine = null;
  game.net = fakeNet();
  return game.net;
}

const lastCustom = (net) => [...net.sent].reverse().find((m) => m.t === 'custom');

test.beforeEach(() => { resetGame(); disposeTrails(); });
test.after(() => { disposeTrails(); });

// --- state / guest schema ---------------------------------------------------

test('a fresh state starts with the flourish slot empty but present', () => {
  assert.equal(game.state.trail, 'none');
  assert.deepEqual(game.state.ownedTrails, ['none']);
});

test('the guest cache keeps bought flourishes and drops earned ones', () => {
  game.state.ownedTrails = ['none', 'petals', 'glowring'];
  game.state.trail = 'glowring';
  game.saveLocal();

  const saved = JSON.parse(localStorage.getItem('capycove-guest'));
  assert.deepEqual(saved.ownedTrails, ['none', 'petals', 'glowring']);
  assert.equal(saved.trail, 'glowring');

  // a hand-edited file: a milestone flourish, an invented one, and a worn id
  // that is not in the list it ships with
  localStorage.setItem('capycove-guest', JSON.stringify({
    ownedTrails: ['goldpaw', 'sparkles', 'not-a-trail', '__proto__'],
    trail: 'goldpaw',
  }));
  game.state.ownedTrails = ['none'];
  game.state.trail = 'none';
  game.loadLocal();
  assert.deepEqual(game.state.ownedTrails, ['none', 'sparkles']);
  assert.equal(game.state.trail, 'none', 'an unowned claim is simply not worn');
});

test('the owned list is capped and always contains none', () => {
  const many = Object.keys(TRAILS).filter((id) => !TRAILS[id].milestone);
  game.state.ownedTrails = many;
  game.saveLocal();
  const saved = JSON.parse(localStorage.getItem('capycove-guest'));
  assert.ok(saved.ownedTrails.length <= 32);
  assert.equal(saved.ownedTrails[0], 'none');
});

test('the welcome profile brings the slot with it', () => {
  game.applyProfile({
    registered: true, coins: 90, hat: 'cap', ownedHats: ['none', 'cap'],
    trail: 'petals', ownedTrails: ['none', 'petals'],
  });
  assert.equal(game.state.trail, 'petals');
  assert.deepEqual(game.state.ownedTrails, ['none', 'petals']);
});

// --- equipping --------------------------------------------------------------

test('equipTrail refuses what you do not own and sends the whole look', () => {
  const net = game.net;
  assert.equal(game.equipTrail('rainbow'), false);
  assert.equal(game.state.trail, 'none');
  assert.equal(net.sent.length, 0);

  game.state.ownedTrails = ['none', 'petals'];
  assert.equal(game.equipTrail('petals'), true);
  assert.equal(game.state.trail, 'petals');
  assert.deepEqual(lastCustom(net), {
    t: 'custom', color: game.state.color, hat: 'none', trail: 'petals',
  });
});

test('equipping a hat or a colour never strips the flourish', () => {
  const net = game.net;
  game.state.ownedTrails = ['none', 'petals'];
  game.state.ownedHats = ['none', 'cap'];
  game.equipTrail('petals');

  game.equipHat('cap');
  assert.equal(lastCustom(net).trail, 'petals');
  assert.equal(lastCustom(net).hat, 'cap');

  game.setColor(0x4fb3e8);
  assert.equal(lastCustom(net).trail, 'petals');
  assert.equal(game.state.trail, 'petals');
});

// --- the wire ---------------------------------------------------------------

/** A NetClient wired to the singleton game, with nothing but a fake socket. */
function fakeClient() {
  const engine = {
    scene: new THREE.Scene(),
    game,
    playerAvatar: { group: new THREE.Object3D(), state: { anim: 'idle' } },
    remoteGroup: new THREE.Group(),
  };
  const net = new NetClient(game, engine);
  net.connected = true;
  net.selfId = 'p1';
  return { net, engine };
}

test('a buy-trail answer lands on the shop frame and equips what it bought', () => {
  const sent = game.net;
  const { net } = fakeClient();
  game.state.ownedHats = ['none', 'cap'];
  game.state.coins = 500;

  net._handle({
    t: 'shop', ok: true, coins: 300, delta: -200,
    ownedTrails: ['none', 'petals'], boughtTrail: 'petals',
  });

  assert.deepEqual(game.state.ownedTrails, ['none', 'petals']);
  assert.equal(game.state.trail, 'petals', 'the purchase is worn straight away');
  assert.equal(game.state.coins, 300);
  assert.deepEqual(game.state.ownedHats, ['none', 'cap'], 'the hats are untouched');
  assert.equal(lastCustom(sent).trail, 'petals', 'and the cove is told');
});

test('a hat purchase on the same frame leaves the flourish alone', () => {
  const { net } = fakeClient();
  game.state.ownedTrails = ['none', 'petals'];
  game.state.trail = 'petals';

  net._handle({
    t: 'shop', ok: true, coins: 120, delta: -150,
    ownedHats: ['none', 'cap'], bought: 'cap',
  });
  assert.equal(game.state.hat, 'cap');
  assert.equal(game.state.trail, 'petals');
  assert.deepEqual(game.state.ownedTrails, ['none', 'petals']);
});

test("a remote's custom frame renders on the remote, not on us", () => {
  const { net, engine } = fakeClient();
  const avatar = {
    group: new THREE.Object3D(),
    setColor() {},
    setHat() {},
  };
  net.remotes.set('p7', { p: { id: 'p7', trail: 'none' }, avatar, anim: 'walk' });

  net._handle({ t: 'custom', id: 'p7', color: 0xb08a5a, hat: 'cap', trail: 'sparkles' });
  assert.equal(net.remotes.get('p7').p.trail, 'sparkles');

  const dt = 1 / 60;
  for (let t = 0; t < 1; t += dt) {
    avatar.group.position.z += 4 * dt;
    updateTrails(dt, engine, net.remotes);
  }
  const f = trailField();
  assert.ok(f.live > 3, `the remote's flourish is drawn (${f.live})`);
  assert.equal(f.wearers.size, 1, 'and only theirs: we are wearing nothing');

  // taking it off on their end stops the emission on ours
  net._handle({ t: 'custom', id: 'p7', color: 0xb08a5a, hat: 'cap', trail: 'none' });
  for (let t = 0; t < 4; t += dt) updateTrails(dt, engine, net.remotes);
  assert.equal(f.live, 0);
});
