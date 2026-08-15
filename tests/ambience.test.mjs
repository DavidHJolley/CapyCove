/**
 * Headless test for src/world/ambience.js.
 *
 *   node --test tests/ambience.test.mjs
 *
 * Ambience is pure client geometry, so this drives it exactly as the engine
 * does: attach to a room object, hand it dt, hand it clock frames, dispose it,
 * and check that the room it borrowed comes back unmarked. The only DOM the
 * module touches is `document.createElement('canvas')` for its sprite sheet,
 * stubbed below before the module is imported (same stub the overlay test uses).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- DOM stub (must exist before the module loads) -------------------------
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
  };
  return new Proxy(real, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function makeCanvas(w = 1, h = 1) {
  const c = { width: w, height: h, style: {}, getContext: () => ctx, toDataURL: () => 'data:,' };
  const ctx = makeCtx();
  ctx.canvas = c;
  return c;
}
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {} }),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;

const THREE = await import('three');
const { attachAmbience, ambienceConfig, AMBIENCE_ROOMS } =
  await import('../src/world/ambience.js');

// --- harness ---------------------------------------------------------------
function makeGame() {
  const camera = new THREE.PerspectiveCamera(42, 1.6, 0.1, 300);
  camera.position.set(0, 14, 19);
  return { engine: { camera } };
}

/** A room like the engine hands over: own update/dispose, optional onClock. */
function makeRoom(id, { clock = true } = {}) {
  const seen = { update: 0, dispose: 0, clock: [] };
  const room = {
    id,
    groundMeshes: [],
    hotspots: [],
    seen,
    update(dt) { seen.update++; seen.lastDt = dt; },
    dispose() { seen.dispose++; },
  };
  if (clock) room.onClock = (dayT, weather, aurora) => { seen.clock.push([dayT, weather, aurora]); };
  return room;
}

function run(view, room, frames = 60, dt = 1 / 60) {
  for (let i = 0; i < frames; i++) room.update(dt);
  return view;
}

function allParticles(view) {
  const out = [];
  for (const L of view.layers) {
    if (L.kind === 'drift') out.push(...L.posArr);
    else {
      const m = new THREE.Matrix4();
      for (let i = 0; i < L.pool; i++) {
        L.mesh.getMatrixAt(i, m);
        out.push(m.elements[12], m.elements[13], m.elements[14]);
      }
    }
  }
  return out;
}

// --- config ----------------------------------------------------------------
test('config: known rooms, dens, and everything else', () => {
  assert.ok(AMBIENCE_ROOMS.includes('plaza'));
  assert.ok(AMBIENCE_ROOMS.includes('drift'));
  for (const id of AMBIENCE_ROOMS) {
    const c = ambienceConfig(id);
    assert.ok(c, `${id} has a config`);
    assert.ok(c.motes || c.drift, `${id} has at least one layer`);
    for (const spec of [c.motes, c.drift]) {
      if (!spec) continue;
      assert.ok(spec.count > 0 && spec.count <= 220, `${id}: sane count`);
      assert.ok(spec.area && spec.area.r > 0, `${id}: has an area`);
    }
  }
  assert.equal(ambienceConfig('house:capy'), ambienceConfig('house:other'));
  assert.equal(ambienceConfig('speedway'), null);
  assert.equal(ambienceConfig(''), null);
  assert.equal(ambienceConfig(undefined), null);
});

// --- attach / tick ---------------------------------------------------------
test('attach builds capped layers and moves them', () => {
  const scene = new THREE.Scene();
  // peak, not plaza: the plaza deliberately runs ONE night-only layer (see the
  // note over its config), so it is the wrong room to check both layers with.
  const room = makeRoom('peak');
  const view = attachAmbience(room, scene, makeGame(), 'peak');
  assert.ok(view, 'attached');
  assert.equal(view.layers.length, 2, 'peak runs both layers');
  assert.equal(scene.children.length, 2, 'two draw calls, no more');

  for (const L of view.layers) {
    assert.ok(L.pool > 0 && L.pool <= 220);
    assert.equal(L.data.length, L.pool * 8);
    assert.equal(L.mesh.frustumCulled, false);
    assert.equal(L.mat.depthWrite, false);
  }

  view.onClock(0.25, 'clear', false); // noon
  const before = allParticles(view);
  run(view, room, 90);
  const after = allParticles(view);
  assert.ok(room.seen.update >= 90, 'the room\'s own update still ran');
  assert.ok(after.some((v, i) => v !== before[i]), 'the air actually moves');
  assert.ok(after.every(Number.isFinite), 'no NaN escaped a kernel');
  view.dispose();
});

test('every configured room attaches, ticks and tears down clean', () => {
  for (const id of [...AMBIENCE_ROOMS, 'house:someone']) {
    const scene = new THREE.Scene();
    const room = makeRoom(id, { clock: id !== 'mine' }); // the mine has no onClock
    const view = attachAmbience(room, scene, makeGame(), id);
    assert.ok(view, `${id} attached`);
    for (const t of [0.05, 0.25, 0.5, 0.78]) {
      view.onClock(t, 'breeze', false);
      run(view, room, 20);
    }
    assert.ok(allParticles(view).every(Number.isFinite), `${id}: finite`);
    room.dispose();
    assert.equal(scene.children.length, 0, `${id}: scene emptied`);
    assert.equal(view.active, false, `${id}: view retired`);
  }
});

test('no allocation churn: the pools are the same objects after a long run', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('peak');
  const view = attachAmbience(room, scene, makeGame(), 'peak');
  const ids = view.layers.map((L) => [L.data, L.mesh, L.mat]);
  run(view, room, 600);
  view.layers.forEach((L, i) => {
    assert.equal(L.data, ids[i][0], 'particle store is never reallocated');
    assert.equal(L.mesh, ids[i][1]);
    assert.equal(L.mat, ids[i][2]);
  });
  assert.equal(scene.children.length, 2, 'nothing was added mid-flight');
  view.dispose();
});

// --- clock -----------------------------------------------------------------
test('onClock is passed through, never swallowed, and drives the mode', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('plaza');
  const orig = room.onClock;
  const view = attachAmbience(room, scene, makeGame(), 'plaza');
  assert.notEqual(room.onClock, orig, 'ambience wrapped it');

  room.onClock(0.25, 'clear', false);
  assert.deepEqual(room.seen.clock.at(-1), [0.25, 'clear', false], 'the room still hears it');
  assert.equal(view.mode, 'day');
  run(view, room, 120);
  const dayGain = view.layers[0].gain;
  assert.ok(dayGain < 0.05, 'the plaza has no air of its own in daylight');

  room.onClock(0.78, 'clear', true); // deep night
  assert.equal(view.mode, 'night');
  run(view, room, 120);
  assert.ok(view.layers[0].gain > 0.9, 'the fireflies come out with the lanterns');
  assert.equal(view.layers[0].live.add, true, 'fireflies glow');

  room.onClock(0.25, 'clear', false);
  assert.equal(view.mode, 'day');
  view.dispose();
});

test('a room with no onClock gets one, and gives it back', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('mine', { clock: false });
  assert.equal(room.onClock, undefined);
  const view = attachAmbience(room, scene, makeGame(), 'mine');
  assert.equal(typeof room.onClock, 'function', 'the engine can now call it');
  room.onClock(0.5, 'clear', false); // must not throw with no previous handler
  view.dispose();
  assert.equal(room.onClock, undefined, 'handed back exactly as found');
});

// --- reduced motion --------------------------------------------------------
test('reduced motion halves densities and kills the shimmer layers', async () => {
  const scene = new THREE.Scene();
  const room = makeRoom('beach');
  const view = attachAmbience(room, scene, makeGame(), 'beach');
  view.onClock(0.25, 'clear', false); // noon: the heat shimmer is at full
  run(view, room, 120);
  const spray = view.layers.find((L) => L.kind === 'motes');
  const shimmer = view.layers.find((L) => L.kind === 'drift');
  const fullSpray = spray.n;
  assert.ok(fullSpray > 0);
  assert.ok(shimmer.n > 0, 'shimmer is on at noon');

  globalThis.capyReducedMotion = () => true;
  try {
    run(view, room, 120); // > CALM_EVERY, so the flag is re-read
    assert.equal(shimmer.n, 0, 'shimmer is off entirely');
    assert.equal(spray.n, Math.round(fullSpray / 2), 'everything else is halved');
    run(view, room, 240);
    assert.ok(allParticles(view).every(Number.isFinite));
  } finally {
    delete globalThis.capyReducedMotion;
  }
  view.dispose();
});

// --- teardown --------------------------------------------------------------
test('dispose restores the room and frees only what it owns', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('jungle');
  const update = room.update, dispose = room.dispose, clock = room.onClock;
  const view = attachAmbience(room, scene, makeGame(), 'jungle');
  const geos = view.layers.map((L) => L.mesh.geometry);
  run(view, room, 30);

  room.dispose();
  assert.equal(room.seen.dispose, 1, 'the room\'s own dispose ran');
  assert.equal(room.update, update, 'update handed back');
  assert.equal(room.dispose, dispose, 'dispose handed back');
  assert.equal(room.onClock, clock, 'onClock handed back');
  assert.equal(scene.children.length, 0);
  assert.equal(room.__ambience, null);

  // the unit quad is shared for the life of the page and must survive
  const quad = geos.find((g) => g.userData?.shared);
  assert.ok(quad, 'the mote quad is marked shared');
  assert.ok(quad.attributes.position, 'and was not disposed');

  // ticking a disposed view is inert, not a crash
  view.tick(0.016);
  assert.equal(view.layers.length, 0);
});

test('re-attaching after a dispose reuses the shared sprites', () => {
  const scene = new THREE.Scene();
  const a = makeRoom('club');
  const v1 = attachAmbience(a, scene, makeGame(), 'club');
  const tex = v1.layers[0].mat.map;
  a.dispose();

  const scene2 = new THREE.Scene();
  const b = makeRoom('club');
  const v2 = attachAmbience(b, scene2, makeGame(), 'club');
  assert.equal(v2.layers[0].mat.map, tex, 'same sprite, still alive');
  run(v2, b, 60);
  assert.ok(allParticles(v2).every(Number.isFinite));
  b.dispose();
});

test('attaching twice never double-wraps', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('cafe');
  const update = room.update;
  const v1 = attachAmbience(room, scene, makeGame(), 'cafe');
  const v2 = attachAmbience(room, scene, makeGame(), 'cafe');
  assert.equal(v1.active, false, 'the first view stood down');
  assert.equal(scene.children.length, v2.layers.length, 'only one set of layers');
  room.dispose();
  assert.equal(room.update, update);
  assert.equal(scene.children.length, 0);
});

test('a giant dt cannot teleport the air', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('drift');
  const view = attachAmbience(room, scene, makeGame(), 'drift');
  run(view, room, 30); // settle: the buffers start parked, not at their seeds
  const before = allParticles(view);
  room.update(1e6); // a tab that slept for a fortnight
  const after = allParticles(view);
  let max = 0;
  for (let i = 0; i < before.length; i++) max = Math.max(max, Math.abs(after[i] - before[i]));
  assert.ok(max < 60, `one frame moved a particle ${max.toFixed(1)}m`);
  assert.ok(after.every(Number.isFinite));
  view.dispose();
});

test('a layer whose hour is over leaves nothing behind', () => {
  const scene = new THREE.Scene();
  const room = makeRoom('beach');
  const view = attachAmbience(room, scene, makeGame(), 'beach');
  const shimmer = view.layers.find((L) => L.kind === 'drift'); // noon-only haze
  assert.equal(shimmer.live.at, 'noon');

  view.onClock(0.25, 'clear', false);      // noon
  run(view, room, 300);
  assert.ok(view.layers.every((L) => L.gain >= 0)); // sanity
  assert.ok(shimmer.gain > 0.8, 'haze is up at noon');

  view.onClock(0.78, 'clear', false);      // deep night
  run(view, room, 600);
  assert.ok(shimmer.gain < 0.02, `haze went away (gain ${shimmer.gain.toFixed(3)})`);

  view.dispose();
});

test('a normal-blended mote layer at zero gain shrinks to nothing, not to a floor', () => {
  // A normal-blended particle cannot fade through colour, so scale IS its
  // alpha. If that scale had a floor, a layer whose hour ended would leave
  // half-size quads hanging in the room. Beach spray is the normal-blended
  // mote layer; its hour is 'any', so the test gives it one.
  const scene = new THREE.Scene();
  const room = makeRoom('beach');
  const view = attachAmbience(room, scene, makeGame(), 'beach');
  const spray = view.layers.find((L) => L.kind === 'motes');
  assert.ok(!spray.live.add, 'spray is normal-blended');

  view.onClock(0.25, 'clear', false); // noon
  run(view, room, 120);
  const m = new THREE.Matrix4(), s = new THREE.Vector3();
  const q = new THREE.Quaternion(), p = new THREE.Vector3();
  const scaleOf = (i) => { spray.mesh.getMatrixAt(i, m); m.decompose(p, q, s); return s.x; };
  assert.ok(scaleOf(0) > 0.02, 'spray has size at noon');

  // Own copy, so the shared config table is not mutated for other tests.
  spray.live = { ...spray.live, at: 'night' };
  run(view, room, 600); // ten seconds at noon with a night-only hour
  assert.ok(view.layers.includes(spray));
  assert.ok(spray.gain < 0.02, `gain fell away (${spray.gain.toFixed(3)})`);
  let biggest = 0;
  for (let i = 0; i < spray.pool; i++) biggest = Math.max(biggest, scaleOf(i));
  assert.ok(biggest < 0.004, `nothing was left hanging (biggest quad ${biggest})`);
  view.dispose();
});
