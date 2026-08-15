/**
 * Headless test for src/world/overlay.js: apply a fixture rlo/1 layout on top
 * of a REAL room build (the plaza, built by its own builder into a real
 * THREE.Scene) and check every op kind, the ETag cache, the no-layout fast
 * path, and teardown.
 *
 *   node --test tests/overlay.test.mjs
 *
 * No DOM here, so the two things a room build touches are stubbed before any
 * room module is imported: `document.createElement('canvas')` (every room
 * paints its textures onto one) and `performance`. Nothing else is faked: the
 * plaza's own build() runs, and the overlay patches what it produced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- DOM stub (must exist before the room modules load) --------------------
function makeCtx() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const real = {
    canvas: null,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => null,
    measureText: (s) => ({ width: String(s).length * 6 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    putImageData: noop,
    getContextAttributes: () => ({}),
  };
  return new Proxy(real, {
    get(t, k) {
      if (k in t) return t[k];
      return noop; // fillRect, arc, save, restore, setTransform, ...
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeCanvas(w = 1, h = 1) {
  const c = {
    width: w, height: h, style: {},
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,',
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const ctx = makeCtx();
  ctx.canvas = c;
  return c;
}

globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild() {}, remove() {} }),
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;

const THREE = await import('three');
const overlay = await import('../src/world/overlay.js');
const layoutStore = await import('../src/world/layout.js');
const { PlazaRoom } = await import('../src/world/rooms/plaza.js');

const {
  attachOverlay, primeLayout, normalizeDoc, ensureLayout, preloadLayout,
  evictLayout, peekLayout, layoutRev, configureOverlay, resetOverlayState,
  registerPropBuilder, LAYOUT_CAPS,
} = overlay;

// --- helpers ---------------------------------------------------------------
function makeGame() {
  const calls = [];
  return {
    calls,
    engine: null,
    state: { name: 'DavidEdge', coins: 0, color: 0xb08a5a, hat: 'none', ownedHats: ['none'], ownedFurniture: {}, bests: {} },
    events: { emit: (...a) => calls.push(['emit', ...a]), on: () => {}, off: () => {} },
    goToRoom: (...a) => calls.push(['goToRoom', ...a]),
    startMinigame: (...a) => calls.push(['startMinigame', ...a]),
    toast: (...a) => calls.push(['toast', ...a]),
    audio: null,
    net: null,
  };
}

/** A real plaza, built by its own builder into a real scene. */
function buildPlaza(game) {
  const room = new PlazaRoom();
  const scene = new THREE.Scene();
  room.build(scene, game);
  return { room, scene };
}

function fixture(ops, extra = {}) {
  return { v: 1, room: 'plaza', rev: 7, base: 'plaza@1', updated: 1755100000000, ops, ...extra };
}

const countProps = (scene) => scene.getObjectByName('layout-props')?.children.length ?? 0;

test.beforeEach(() => {
  resetOverlayState();
  configureOverlay({ enabled: true, budgetMs: 250, retryMs: 30_000 });
});

// --------------------------------------------------------------------------
test('the plaza still builds headlessly (control)', () => {
  const { room, scene } = buildPlaza(makeGame());
  assert.ok(room.groundMeshes.length > 0, 'ground meshes');
  assert.ok(room.hotspots.length > 0, 'hotspots');
  assert.ok(room.obstacles.length > 0, 'obstacles');
  assert.ok(scene.children.length > 10, 'scene populated');
});

test('no layout: attach is a no-op and costs nothing', () => {
  primeLayout('plaza', null); // "the server says this room has none"
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  const dispose = room.dispose;
  const update = room.update;
  const hotspots = room.hotspots.length;

  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.equal(ov, null);
  assert.equal(room.dispose, dispose, 'dispose not wrapped');
  assert.equal(room.update, update, 'update not wrapped');
  assert.equal(room.hotspots.length, hotspots);
  assert.equal(scene.getObjectByName('layout-props'), undefined);
});

test('dens and junk room ids never reach the layout service', () => {
  let hits = 0;
  configureOverlay({ fetchImpl: async () => { hits++; return { status: 404, ok: false, headers: { get: () => null } }; } });
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  assert.equal(attachOverlay(room, scene, game, 'house:david'), null);
  assert.equal(attachOverlay(room, scene, game, 'house'), null, 'HouseRoom.id on a rebuild');
  assert.equal(attachOverlay(room, scene, game, '../../etc/passwd'), null);
  assert.equal(attachOverlay(room, scene, game, 'room'), null, 'the Room base-class default');
  assert.equal(hits, 0);
});

// --------------------------------------------------------------------------
test('applies a full fixture layout over a real plaza build', async () => {
  registerPropBuilder((await import('../src/world/furniture.js')).buildFurniture);
  const game = makeGame();
  const { room, scene } = buildPlaza(game);

  // simulate the phase-4 tagging pass two ways: the room.tag() registry, and a
  // bare userData tag on a prop the builder made
  const lamp = scene.children.find((o) => o.isMesh || o.isGroup);
  room.tagged = new Map([['landmark', lamp]]);
  const other = scene.children.find((o) => o !== lamp && o.isObject3D);
  other.userData.tagId = 'plaza/second';

  const spawn0 = room.spawnPoints.default.clone();
  const shop = room.hotspots.find((h) => h.id === 'shop');
  const hotspots0 = room.hotspots.length;
  const obstacles0 = room.obstacles.length;

  primeLayout('plaza', fixture([
    { op: 'spawn', id: 'default', p: [3.5, 0, 4.25] },
    { op: 'spawn', id: 'from_drift', p: [-2, 0, 8] },
    { op: 'cam', id: 'static', p: [0, 21, 28], look: [0, 1.2, 0.5] },
    { op: 'cam', id: 'bm_1', name: 'north gate', target: [0, 0, -9], dist: 12 },
    { op: 'xform', id: 'plaza/landmark', p: [1, 0, 2], ry: 0.5, s: 1.25 },
    { op: 'hide', id: 'second' },
    { op: 'xform', id: 'plaza/ghost-of-a-refactor', p: [0, 0, 0] },
    { op: 'prop', id: 'p_aaa111', cat: 'plant_palm', p: [6, 0, 6], ry: 0.78 },
    { op: 'prop', id: 'p_bbb222', cat: 'plant_palm', p: [-6, 0, 6], s: 1.4 },
    { op: 'prop', id: 'p_ccc333', cat: 'rug_round', p: [0, 0, 5], col: 0 },
    { op: 'collider', id: 'c_01', x: 2.5, z: -3.5, r: 1.2 },
    { op: 'hotspot', id: 'h_01', kind: 'exit', to: 'beach', x: -12, z: 0.5, r: 2.6, label: 'Driftwood Beach' },
    { op: 'hotspot', id: 'h_02', kind: 'game', to: 'fishing', x: 4, z: 7, r: 2.2, label: 'Play Reel Rush' },
    { op: 'hotspot', id: 'h_03', kind: 'sign', x: -4, z: 7, r: 2, label: 'Mind the ducks' },
    { op: 'hotspot', id: 'shop', r: 3.4 },
    { op: 'handle', id: 'plaza/whatever', set: { at: [1, 2] } },
  ]));

  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.ok(ov, 'overlay attached');
  assert.equal(ov.rev, 7);

  // spawn
  assert.notDeepEqual(room.spawnPoints.default.toArray(), spawn0.toArray());
  assert.deepEqual(room.spawnPoints.default.toArray(), [3.5, 0, 4.25]);
  assert.ok(room.spawnPoints.from_drift, 'a brand new spawn point');

  // camera
  assert.deepEqual(room.staticCamera.position.toArray(), [0, 21, 28]);
  assert.deepEqual(room.staticCamera.lookAt.toArray(), [0, 1.2, 0.5]);

  // tagged transforms
  assert.deepEqual(lamp.position.toArray(), [1, 0, 2]);
  assert.equal(Math.round(lamp.rotation.y * 100) / 100, 0.5);
  assert.equal(lamp.scale.x, 1.25);
  assert.equal(other.visible, false);
  assert.deepEqual(ov.orphans, ['plaza/ghost-of-a-refactor'], 'orphan kept + reported, not silently dropped');

  // data props
  assert.equal(countProps(scene), 3);
  assert.equal(ov.props.length, 3);
  const palm = scene.getObjectByName('layout-props').children[0];
  assert.equal(palm.position.x, 6);
  assert.equal(palm.rotation.y, 0.78);
  // props follow the ground rather than floating at y=0
  assert.ok(Number.isFinite(palm.position.y));
  // one palm collider, one bigger palm collider, no collider for the rug (col:0)
  const propCircles = room.obstacles.filter((c) => String(c.id || '').startsWith('p_'));
  assert.equal(propCircles.length, 2);
  assert.ok(propCircles[0].r > 0.25);

  // colliders + hotspots
  assert.ok(room.obstacles.some((c) => c.id === 'c_01' && c.r === 1.2));
  assert.equal(room.obstacles.length, obstacles0 + 3);
  assert.equal(room.hotspots.length, hotspots0 + 3);
  assert.equal(shop.radius, 3.4, 'existing hotspot adjusted in place');

  const exit = room.hotspots.find((h) => h.opId === 'h_01');
  assert.equal(exit.id, 'exit-beach', 'a data exit is a real archway, cue and all');
  exit.action(game);
  assert.deepEqual(game.calls.at(-1), ['goToRoom', 'beach', 'plaza']);
  room.hotspots.find((h) => h.opId === 'h_02').action(game);
  assert.deepEqual(game.calls.at(-1), ['startMinigame', 'fishing']);
  room.hotspots.find((h) => h.opId === 'h_03').action(game);
  assert.deepEqual(game.calls.at(-1), ['toast', 'Mind the ducks']);

  // handle ops land in the pre-build store the rooms read
  assert.deepEqual(layoutStore.getOverride('plaza', 'whatever'), { at: [1, 2] });

  // teardown: the room's own dispose still runs, ours runs after it
  let roomDisposed = 0;
  const inner = ov._prevDispose;
  ov._prevDispose = () => { roomDisposed++; inner?.(); };
  room.dispose();
  assert.equal(roomDisposed, 1);
  assert.equal(ov.active, false);
  assert.equal(scene.getObjectByName('layout-props'), undefined, 'prop group detached');
  assert.equal(typeof room.update, 'function');
  assert.equal(Object.prototype.hasOwnProperty.call(room, 'update'), false, 'hooks left no trace on the instance');
  assert.equal(Object.prototype.hasOwnProperty.call(room, 'dispose'), false);
});

test('a bad op is skipped, never the room', async () => {
  registerPropBuilder((await import('../src/world/furniture.js')).buildFurniture);
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  const hotspots0 = room.hotspots.length;

  const doc = primeLayout('plaza', fixture([
    { op: 'nuke', id: 'x' },                                   // unknown kind
    { op: 'prop', id: 'p_1', cat: 'not_a_prop', p: [1, 0, 1] },// unknown catalog id
    { op: 'prop', id: 'p_2', cat: 'plant_palm', p: [NaN, 0, 1] },
    { op: 'prop', id: 'p_3', cat: 'plant_palm', p: [9999, 0, -9999] }, // clamped
    { op: 'hotspot', id: 'h_x', kind: 'exit', to: 'mordor', x: 1, z: 1 },
    { op: 'hotspot', id: 'h_y', kind: 'exit', to: 'plaza', x: 1, z: 1 },
    { op: 'hotspot', id: 'h_z', kind: 'game', to: 'chess; drop database', x: 1, z: 1 },
    { op: 'spawn', id: 'default', p: 'over there' },
    { op: 'cam', id: 'static', p: [0, 1, 2] },                  // no lookAt
    { op: 'collider', id: 'c_9', x: 1, z: 1, r: 999 },          // clamped to 8
    { op: 'prop', id: 'p_4', cat: 'plant_flower', p: [2, 0, 2], action: 'alert(1)' },
  ]));

  // normalisation dropped the malformed ones before anything was applied.
  // 'not_a_prop' is well-formed, so it survives the shape check and is caught
  // at build time instead, as an orphan.
  assert.equal(doc.ops.filter((o) => o.op === 'prop').length, 3);
  // a `to` with a space or a semicolon in it is not an id and never gets as far
  // as the destination table; 'mordor' and the self-exit are shaped right and
  // are refused against ROOM_IDS at apply time instead
  assert.equal(doc.ops.filter((o) => o.op === 'hotspot').length, 2);
  assert.equal(doc.ops.filter((o) => o.op === 'spawn').length, 0);
  assert.equal(doc.ops.filter((o) => o.op === 'cam').length, 0);
  assert.equal(doc.ops.find((o) => o.op === 'collider').r, 8);
  assert.equal(doc.ops.find((o) => o.id === 'p_3').p.x, 200, 'coordinates clamped to the world box');
  assert.equal(doc.ops.find((o) => o.id === 'p_4').action, undefined, 'no callable ever survives the wire');

  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.equal(countProps(scene), 2);
  assert.equal(room.hotspots.length, hotspots0, 'an exit to a room that does not exist is an orphan, not a crash');
  assert.ok(ov.orphans.includes('h_x') && ov.orphans.includes('h_y'));
  assert.ok(ov.orphans.includes('p_1'), 'a catalog id this build cannot make is an orphan');
  room.dispose();
});

test('a tagged prop owns the code collider standing under it', () => {
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  // a code-authored circle has no id, so a tagged object claims the circle it
  // is standing in (the fountain's, here) and nothing further than a metre off
  const circle = room.obstacles.find((c) => c.r > 2);
  const marker = new THREE.Object3D();
  marker.position.set(circle.x, 0, circle.z);
  scene.add(marker);
  const far = new THREE.Object3D();
  far.position.set(circle.x + 40, 0, circle.z + 40);
  scene.add(far);
  room.tagged = { fountain: marker, faraway: far };
  const before = room.obstacles.length;

  primeLayout('plaza', fixture([
    { op: 'collider', id: 'plaza/fountain', r: 0 },
    { op: 'collider', id: 'plaza/faraway', r: 2 },
  ]));
  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.equal(room.obstacles.includes(circle), false, 'r:0 disables a code collider');
  assert.equal(room.obstacles.length, before - 1);
  assert.deepEqual(ov.orphans, ['plaza/faraway'], 'no circle within reach: reported, never guessed at');
  room.dispose();
});

test('animated props tick with the room and stop with it', async () => {
  registerPropBuilder((await import('../src/world/furniture.js')).buildFurniture);
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  primeLayout('plaza', fixture([
    { op: 'prop', id: 'p_fire', cat: 'fireplace', p: [0, 0, 3] },
  ]));
  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.equal(ov.anim.length, 1, 'fireplace has userData.update');
  let ticks = 0;
  const fn = ov.anim[0].userData.update;
  ov.anim[0].userData.update = (t, dt) => { ticks++; fn(t, dt); };
  room.update(0.016, game);
  room.update(0.016, game);
  assert.equal(ticks, 2);
  assert.ok(ov.t > 0.03);
  room.dispose();
  room.update(0.016, game); // the restored update must not tick a dead overlay
  assert.equal(ticks, 2);
});

// 'bookshelf' is a still prop: an ANIMATED one (a palm, a fireplace) is built
// fresh every time on purpose, because Object3D.clone() JSON-copies userData
// and would drop its update() on the floor.
test('repeat placements of one catalog id share their geometry', async () => {
  registerPropBuilder((await import('../src/world/furniture.js')).buildFurniture);
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  primeLayout('plaza', fixture([
    { op: 'prop', id: 'p_a', cat: 'bookshelf', p: [4, 0, 4] },
    { op: 'prop', id: 'p_b', cat: 'bookshelf', p: [5, 0, 4] },
    { op: 'prop', id: 'p_c', cat: 'bookshelf', p: [6, 0, 4] },
  ]));
  attachOverlay(room, scene, game, 'plaza');
  const kids = scene.getObjectByName('layout-props').children;
  const geo = (g) => { const out = []; g.traverse((o) => { if (o.isMesh) out.push(o.geometry); }); return out; };
  const a = geo(kids[0]); const b = geo(kids[1]);
  assert.equal(a.length, b.length);
  assert.ok(a.length > 0);
  assert.equal(a[0], b[0], 'clone() shares the buffer, one build per catalog id');
  room.dispose();
});

// --------------------------------------------------------------------------
test('HTTP: fetch, ETag revalidation, 304 reuse, 404 caching', async () => {
  let requests = [];
  const body = fixture([{ op: 'prop', id: 'p_x', cat: 'plant_palm', p: [1, 0, 1] }], { rev: 12 });
  configureOverlay({
    fetchImpl: async (url, init) => {
      requests.push({ url, inm: init?.headers?.['If-None-Match'] || null });
      if (url.endsWith('/beach')) return { status: 404, ok: false, headers: { get: () => null } };
      if (init?.headers?.['If-None-Match'] === 'W/"12"') {
        return { status: 304, ok: false, headers: { get: () => 'W/"12"' } };
      }
      return {
        status: 200, ok: true,
        headers: { get: (k) => (k.toLowerCase() === 'etag' ? 'W/"12"' : 'application/json') },
        json: async () => body,
      };
    },
  });

  const doc = await ensureLayout('plaza');
  assert.equal(doc.rev, 12);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/layout/plaza');

  await ensureLayout('plaza');           // memoised: no second request
  assert.equal(requests.length, 1);
  assert.equal(layoutRev('plaza'), 12);

  evictLayout('plaza');                   // what a `layout-rev` broadcast does
  const again = await ensureLayout('plaza');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].inm, 'W/"12"', 'revalidated with the ETag');
  assert.equal(again.rev, 12, '304 keeps the document we already had');

  assert.equal(await ensureLayout('beach'), null);
  assert.equal(peekLayout('beach'), null);
  await ensureLayout('beach');
  assert.equal(requests.length, 3, '404 is remembered: rooms with no layout ask once a session');
});

test('a layout that arrives late is applied to the room already standing', async () => {
  registerPropBuilder((await import('../src/world/furniture.js')).buildFurniture);
  let release;
  const gate = new Promise((r) => { release = r; });
  configureOverlay({
    budgetMs: 5,
    fetchImpl: async () => {
      await gate;
      return {
        status: 200, ok: true,
        headers: { get: () => 'application/json' },
        json: async () => fixture([{ op: 'prop', id: 'p_late', cat: 'plant_flower', p: [2, 0, 2] }]),
      };
    },
  });

  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  game.engine = { room, rebuildRoom: () => { throw new Error('must not rebuild for prop-only ops'); } };

  const warm = await preloadLayout('plaza');
  assert.equal(warm, null, 'the 250ms budget is a deadline, not a block');

  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.equal(countProps(scene), 0);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(countProps(scene), 1, 'applied in place, no rebuild needed');
  assert.equal(ov.applied, true);
  room.dispose();
});

test('handle ops arriving late ask the engine for one rebuild', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  configureOverlay({
    fetchImpl: async () => {
      await gate;
      return {
        status: 200, ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ v: 1, room: 'lounge', rev: 3, ops: [{ op: 'handle', id: 'lounge/pong', set: { at: [-6.98, -0.93], yaw: 0.95 } }] }),
      };
    },
  });
  const game = makeGame();
  const { room, scene } = buildPlaza(game); // stand-in body; only the wiring is under test
  room.id = 'lounge';
  let rebuilds = 0;
  game.engine = { room, rebuildRoom: () => { rebuilds++; } };

  attachOverlay(room, scene, game, 'lounge');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rebuilds, 1, 'handles only bite at the top of build()');
  assert.deepEqual(layoutStore.getOverride('lounge', 'pong'), { at: [-6.98, -0.93], yaw: 0.95 });
  room.dispose();
});

test('a dead layout service never keeps a room shut', async () => {
  configureOverlay({ quiet: true, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  const hotspots = room.hotspots.length;
  const ov = attachOverlay(room, scene, game, 'plaza');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(room.hotspots.length, hotspots);
  assert.equal(await ensureLayout('plaza'), null);
  ov?.dispose();
});

test('caps hold: 400 ops, 120 props, 24 animated', async () => {
  registerPropBuilder((await import('../src/world/furniture.js')).buildFurniture);
  const many = [];
  for (let i = 0; i < 600; i++) many.push({ op: 'prop', id: `p_${i}`, cat: 'plant_flower', p: [i % 40, 0, 1] });
  const doc = normalizeDoc(fixture(many), 'plaza');
  assert.equal(doc.ops.length, LAYOUT_CAPS.props, 'prop cap bites before the op cap');

  const anim = [];
  for (let i = 0; i < 40; i++) anim.push({ op: 'prop', id: `p_f${i}`, cat: 'fireplace', p: [i % 20, 0, 2] });
  const game = makeGame();
  const { room, scene } = buildPlaza(game);
  primeLayout('plaza', fixture(anim));
  const ov = attachOverlay(room, scene, game, 'plaza');
  assert.equal(ov.anim.length, LAYOUT_CAPS.animated);
  assert.equal(countProps(scene), 40);
  room.dispose();
});

test('the last op with a key wins', () => {
  const doc = normalizeDoc(fixture([
    { op: 'prop', id: 'p_1', cat: 'plant_palm', p: [1, 0, 1] },
    { op: 'prop', id: 'p_1', cat: 'plant_palm', p: [2, 0, 2] },
    { op: 'hide', id: 'p_1' },
  ]), 'plaza');
  assert.equal(doc.ops.length, 3 - 1);
  assert.equal(doc.ops.find((o) => o.op === 'prop').p.x, 2);
});

test('a document about another room, or another format, is refused', () => {
  assert.equal(normalizeDoc({ v: 1, room: 'beach', ops: [] }, 'plaza'), null);
  assert.equal(normalizeDoc({ v: 2, room: 'plaza', ops: [] }, 'plaza'), null);
  assert.equal(normalizeDoc(null, 'plaza'), null);
  assert.equal(normalizeDoc('nope', 'plaza'), null);
  assert.equal(normalizeDoc({ v: 1, room: 'plaza', ops: 'lots' }, 'plaza').ops.length, 0);
  // the on-disk envelope reads too
  assert.equal(normalizeDoc({ room: 'plaza', published: { v: 1, rev: 4, ops: [] } }, 'plaza').rev, 4);
});
