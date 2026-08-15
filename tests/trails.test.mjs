/**
 * Headless test for src/player/trails.js: the pooled walk-trail / idle-aura
 * field. No DOM and no renderer are needed - the module builds plain THREE
 * instanced meshes and never touches document, which is half of what this
 * checks.
 *
 *   node --test tests/trails.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  TRAIL_FX, TRAIL_IDS, hasTrail, updateTrails, trailField, disposeTrails,
  createTrailPreview,
} from '../src/player/trails.js';

// --- fakes -----------------------------------------------------------------

function fakeEngine(trail = 'none') {
  const scene = new THREE.Scene();
  return {
    scene,
    game: { state: { trail } },
    playerAvatar: { group: new THREE.Object3D(), state: { anim: 'idle' } },
  };
}

/** Walk the local player forward for `secs` at ~4 units/s, 60fps. */
function walk(engine, remotes, secs, dt = 1 / 60) {
  const g = engine.playerAvatar.group;
  engine.playerAvatar.state.anim = 'walk';
  for (let t = 0; t < secs; t += dt) {
    g.position.z += 4 * dt;
    updateTrails(dt, engine, remotes);
  }
}

function stand(engine, remotes, secs, dt = 1 / 60) {
  engine.playerAvatar.state.anim = 'idle';
  for (let t = 0; t < secs; t += dt) updateTrails(dt, engine, remotes);
}

const setCalm = (v) => { globalThis.capyReducedMotion = () => v; };

test.beforeEach(() => { setCalm(false); disposeTrails(); });
test.after(() => { disposeTrails(); delete globalThis.capyReducedMotion; });

// --- catalog ---------------------------------------------------------------

test('catalog: every id is either an emitter or an aura, never both', () => {
  for (const id of TRAIL_IDS) {
    const fx = TRAIL_FX[id];
    if (id === 'none') { assert.equal(fx, null); continue; }
    const emitter = !!fx.pool;
    const aura = !!fx.aura;
    assert.ok(emitter !== aura, `${id} must be exactly one of emitter/aura`);
    if (emitter) {
      assert.ok(fx.every || fx.everyD, `${id} needs an emission cadence`);
      assert.ok(fx.hue || (Array.isArray(fx.colors) && fx.colors.length), `${id} needs colours`);
    } else {
      assert.ok(['ring', 'orbit', 'wing'].includes(fx.aura.kind), `${id} aura kind`);
    }
  }
  assert.ok(hasTrail('petals') && hasTrail('none'));
  assert.equal(hasTrail('definitely-not-a-trail'), false);
  // ten coin trails, two milestone trails, three auras (and 'none')
  const auras = TRAIL_IDS.filter((id) => TRAIL_FX[id]?.aura).length;
  assert.equal(auras, 3);
  assert.equal(TRAIL_IDS.length, 16);
});

// --- the field -------------------------------------------------------------

test('walking emits, standing still does not, and the field lives in the scene', () => {
  const e = fakeEngine('petals');
  walk(e, null, 1.2);
  const f = trailField();
  assert.ok(f, 'field exists after the first frame');
  assert.ok(f.live > 3, `expected particles, got ${f.live}`);
  assert.equal(f.group.parent, e.scene, 'field attached to the live scene');
  assert.equal(f.flake.visible, true);
  assert.ok(f.flake.count > 0);

  // stand still long enough for everything in the air to land and fade
  stand(e, null, 4);
  assert.equal(f.live, 0, 'idle capybara leaves nothing behind');
  assert.equal(f.flake.visible, false);
});

test('no flourish, no particles', () => {
  const e = fakeEngine('none');
  walk(e, null, 1.5);
  assert.equal(trailField().live, 0);
});

test('an unknown id draws nothing rather than throwing', () => {
  const e = fakeEngine('sparkles-deluxe-2000');
  walk(e, null, 1);
  assert.equal(trailField().live, 0);
});

// --- remotes ---------------------------------------------------------------

test('remotes render each other off the join snapshot field', () => {
  const e = fakeEngine('none');
  const remotes = new Map();
  for (let i = 0; i < 3; i++) {
    const avatar = { group: new THREE.Object3D() };
    avatar.group.position.set(i * 1.5, 0, 0);
    remotes.set(`r${i}`, { p: { trail: 'sparkles' }, avatar, anim: 'walk' });
  }
  const dt = 1 / 60;
  for (let t = 0; t < 1; t += dt) {
    for (const r of remotes.values()) r.avatar.group.position.z += 4 * dt;
    updateTrails(dt, e, remotes);
  }
  const f = trailField();
  assert.ok(f.live > 5, `remotes emit too (${f.live})`);
  assert.equal(f.wearers.size, 3);

  // one walks off; their bookkeeping goes with them
  remotes.delete('r1');
  updateTrails(dt, e, remotes);
  assert.equal(f.wearers.size, 2);
});

// --- budget ----------------------------------------------------------------

test('a crowd never overruns the pools, and thins out instead', () => {
  const e = fakeEngine('none');
  const remotes = new Map();
  for (let i = 0; i < 24; i++) {
    const avatar = { group: new THREE.Object3D() };
    avatar.group.position.set((i % 6) * 1.2, 0, Math.floor(i / 6) * 1.2);
    remotes.set(`r${i}`, { p: { trail: 'rainbow' }, avatar, anim: 'walk' });
  }
  const dt = 1 / 60;
  for (let t = 0; t < 6; t += dt) {
    for (const r of remotes.values()) r.avatar.group.position.z += 4 * dt;
    updateTrails(dt, e, remotes);
  }
  const f = trailField();
  assert.ok(f.pools.flake.list.length <= f.pools.flake.max, 'flake pool respected');
  assert.ok(f.pools.mote.list.length <= f.pools.mote.max, 'mote pool respected');
  assert.ok(f.flake.count <= f.flake.instanceMatrix.count, 'never draws past the buffer');

  // twenty-four rainbow capybaras: the same three draw calls as one
  assert.equal(f.group.children.length, 3);
});

test('nothing is emitted for a capybara far from the camera subject', () => {
  const e = fakeEngine('none');
  const avatar = { group: new THREE.Object3D() };
  avatar.group.position.set(400, 0, 400); // another postcode
  const remotes = new Map([['far', { p: { trail: 'petals' }, avatar, anim: 'walk' }]]);
  const dt = 1 / 60;
  for (let t = 0; t < 1.5; t += dt) {
    avatar.group.position.z += 4 * dt;
    updateTrails(dt, e, remotes);
  }
  assert.equal(trailField().live, 0);
});

// --- auras -----------------------------------------------------------------

test('auras attach while standing still and are freed on a change of outfit', () => {
  const e = fakeEngine('butterflies');
  stand(e, null, 0.5);
  const f = trailField();
  const w = f.wearers.get('self');
  assert.ok(w.own.length >= 4, `butterflies present (${w.own.length})`);
  assert.equal(f.flake.visible, true);

  e.game.state.trail = 'glowring';
  stand(e, null, 0.3);
  assert.ok(f.wearers.get('self').ring, 'ring aura took over');
  assert.equal(f.ring.count, 1);
  assert.equal(f.wearers.get('self').own.length, 0, 'butterflies released');

  e.game.state.trail = 'none';
  stand(e, null, 0.3);
  assert.equal(f.ring.count, 0);
  assert.equal(f.live, 0);
});

test('drifting stars orbit their capybara, not the world origin', () => {
  const e = fakeEngine('stardrift');
  e.playerAvatar.group.position.set(9, 0, -4);
  stand(e, null, 0.4);
  const f = trailField();
  for (const p of f.pools.flake.list) {
    assert.ok(Math.hypot(p.x - 9, p.z + 4) < 2, 'star stays near its wearer');
    assert.ok(p.y > 1, 'stars drift overhead');
  }
});

// --- reduced motion --------------------------------------------------------

test('reduced motion: trails off, auras static', () => {
  setCalm(true);
  const e = fakeEngine('petals');
  walk(e, null, 2);
  assert.equal(trailField().live, 0, 'no walk trail under reduced motion');

  disposeTrails();
  const e2 = fakeEngine('stardrift');
  stand(e2, null, 0.4);
  const f = trailField();
  const before = f.pools.flake.list.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  assert.ok(before.length > 0, 'the aura is still THERE, just still');
  stand(e2, null, 1.5);
  f.pools.flake.list.forEach((p, i) => {
    assert.ok(Math.abs(p.x - before[i].x) < 1e-9, 'star held its position');
    assert.ok(Math.abs(p.y - before[i].y) < 1e-9, 'no bob');
  });
});

test('reduced motion switched on mid-walk clears the air quickly', () => {
  const e = fakeEngine('leaves');
  walk(e, null, 1.5);
  assert.ok(trailField().live > 0);
  setCalm(true);
  stand(e, null, 1.5);
  assert.equal(trailField().live, 0);
});

// --- lifecycle -------------------------------------------------------------

test('a room switch moves the field and drops the old room air', () => {
  const e = fakeEngine('snow');
  walk(e, null, 1.5);
  const f = trailField();
  assert.ok(f.live > 0);
  const older = e.scene;
  e.scene = new THREE.Scene(); // engine.switchRoom builds a brand new one
  updateTrails(1 / 60, e, null);
  assert.equal(f.group.parent, e.scene);
  assert.equal(older.children.includes(f.group), false);
  assert.equal(f.live, 0, 'particles from the old room do not follow you');
});

test('the engine room teardown sweep will not free our geometry', () => {
  const e = fakeEngine('petals');
  walk(e, null, 0.3);
  const f = trailField();
  for (const m of [f.flake, f.mote, f.ring]) {
    assert.equal(m.geometry.userData.shared, true, 'geometry marked shared');
    assert.equal(m.material.userData.shared, true, 'material marked shared');
  }
});

test('dispose is safe, repeatable, and detaches from the scene', () => {
  const e = fakeEngine('embers');
  walk(e, null, 0.5);
  const f = trailField();
  disposeTrails();
  assert.equal(trailField(), null);
  assert.equal(f.group.parent, null);
  disposeTrails(); // twice must not throw
});

// --- previews --------------------------------------------------------------

test('a shop preview runs on its own tiny budget', () => {
  const pv = createTrailPreview('petals');
  const scene = new THREE.Scene();
  scene.add(pv.group);
  for (let t = 0; t < 2; t += 1 / 60) pv.update(1 / 60);
  const mesh = pv.group.children.find((c) => c.isInstancedMesh && c.count > 0);
  assert.ok(mesh, 'the preview drew something');
  assert.ok(mesh.count <= 70, 'preview stays inside its own pool');
  assert.equal(trailField(), null, 'and never touches the world field');
  pv.dispose();
});

test('a preview of an aura, and of nothing at all, both behave', () => {
  const a = createTrailPreview('glowring');
  for (let t = 0; t < 1; t += 1 / 60) a.update(1 / 60);
  assert.ok(a.group.children.some((c) => c.isInstancedMesh && c.count === 1));
  a.dispose();

  const n = createTrailPreview('none');
  for (let t = 0; t < 1; t += 1 / 60) n.update(1 / 60);
  assert.ok(n.group.children.every((c) => c.count === 0));
  n.dispose();
});
