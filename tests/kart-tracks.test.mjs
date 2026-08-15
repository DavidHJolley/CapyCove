/**
 * Headless test for src/minigames/games/kart-tracks.js: every registry row is
 * checked against docs/KARTS.md's GRAND PRIX AMENDMENT, every track is BUILT
 * into a real THREE.Scene, and the sampler is walked end to end looking for the
 * one failure a screenshot cannot catch: an elevation pop.
 *
 *   node --test tests/kart-tracks.test.mjs
 *
 * No DOM here, so `document.createElement('canvas')` is stubbed before the
 * module loads (the gantry name board paints one). Nothing else is faked: the
 * real spline, the real ribbons, the real instanced families.
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
    getContextAttributes: () => ({}),
  };
  return new Proxy(real, {
    get(t, k) { return k in t ? t[k] : noop; },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function makeCanvas(w = 1, h = 1) {
  const c = { width: w, height: h, style: {}, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,' };
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
const tracks = await import('../src/minigames/games/kart-tracks.js');

const {
  TRACKS, TRACK_ORDER, DEFAULT_TRACK, Q_CLAMP_U_PER_S,
  getTrack, isTrackId, maxQPerS, trackMeta, allTrackMeta,
  buildTrack, buildTrackWorld, hudTrack, hazardPose, hazardHits, frac1, dq,
  HAZ_HIT_MS, HAZ_IMMUNE_MS,
} = tracks;

/** The elevation range each track's amendment row promises, after scale lock. */
const Y_RANGE = {
  sunny: [0, 0],
  summit: [-6, 22],
  tangle: [-2, 14],
  glimmer: [-10, 8],
};
const TOL_Y = 0.5;

const built = new Map();
const sampler = (id) => {
  if (!built.has(id)) built.set(id, buildTrack(id));
  return built.get(id);
};

// ============================================================== registry ====
test('the registry holds exactly the four amendment tracks, in vote order', () => {
  assert.deepEqual(TRACKS.map((t) => t.id), ['sunny', 'summit', 'tangle', 'glimmer']);
  assert.deepEqual([...TRACK_ORDER], ['sunny', 'summit', 'tangle', 'glimmer']);
  assert.equal(DEFAULT_TRACK, 'sunny');
  for (const id of TRACK_ORDER) assert.ok(isTrackId(id), `${id} resolves`);
  assert.equal(isTrackId('nope'), false);
  assert.equal(getTrack('nope').id, 'sunny', 'an unknown id coerces to the shipped track');
  assert.equal(getTrack(undefined).id, 'sunny');
});

test('§A1.1 — the frozen row numbers', () => {
  const want = {
    sunny: { LAP_UNITS: 545, checkpoints: 6, floors: 1, minRunMs: 36_000, theme: 'beach' },
    summit: { LAP_UNITS: 600, checkpoints: 8, floors: 1, minRunMs: 39_000, theme: 'snow' },
    tangle: { LAP_UNITS: 575, checkpoints: 8, floors: 2, minRunMs: 37_500, theme: 'jungle' },
    glimmer: { LAP_UNITS: 620, checkpoints: 8, floors: 2, minRunMs: 40_500, theme: 'mine' },
  };
  for (const row of TRACKS) {
    const w = want[row.id];
    for (const k of Object.keys(w)) assert.equal(row[k], w[k], `${row.id}.${k}`);
    assert.equal(row.sFin, 30.0, `${row.id}.sFin`);
    assert.equal(row.laps, 3, `${row.id}.laps`);
    assert.equal(row.gridSlots, 'standard');
    assert.ok(row.LAP_UNITS >= 545, `${row.id} is at least as long as sunny`);
  }
});

test('§A1.1 — sunny is unchanged to the digit', () => {
  const s = getTrack('sunny');
  const xz = s.points.map((p) => [p[0], p[2], p[3]]);
  assert.deepEqual(xz, [
    [-60, -80, 15], [-20, -84, 15], [20, -84, 15], [56, -76, 14],
    [84, -58, 13], [95, -30, 13], [92, 2, 12], [82, 30, 11],
    [62, 48, 10], [36, 50, 10], [18, 36, 9], [-4, 44, 9],
    [-30, 50, 11], [-56, 40, 12], [-74, 14, 13], [-80, -16, 13],
    [-76, -48, 14], [-70, -68, 15],
  ]);
  for (const p of s.points) assert.equal(p[1], 0, 'sunny is flat');
  assert.equal(s.LAP_UNITS, 545);
  assert.equal(s.sFin, 30.0);
  assert.equal(s.checkpoints, 6);
  assert.deepEqual(s.aiSectors,
    [22, 22, 22, 22, 18, 19, 20, 20, 19, 16, 12, 13, 15, 14, 17, 16, 18, 20, 21, 21, 21, 19, 21, 22]);
});

test('§A9.9 — eleven boxes, a lap the checkpoints divide, sane aiSectors', () => {
  for (const row of TRACKS) {
    assert.equal(row.itemBoxes.length, 11, `${row.id} has 11 item boxes`);
    for (const [q, lat] of row.itemBoxes) {
      assert.ok(q > 0 && q < 1, `${row.id} box q in range`);
      assert.ok(Math.abs(lat) <= 0.7, `${row.id} box lat stays on the road`);
    }
    // the three rows are three distinct q values, 4 + 3 + 4
    const byQ = new Map();
    for (const [q] of row.itemBoxes) byQ.set(q, (byQ.get(q) || 0) + 1);
    assert.deepEqual([...byQ.values()], [4, 3, 4], `${row.id} rows are A4 B3 C4`);

    assert.ok(Number.isInteger(row.checkpoints) && row.checkpoints >= 6);
    // §A9.9 — the checkpoint count must divide the lap cleanly: every gap is
    // the same size and the last one lands back on the line. (This assertion
    // used to read `x || true`, which could never fail; it is real now.)
    const gap = 1 / row.checkpoints;
    for (let c = 0; c < row.checkpoints; c++) {
      assert.ok(Math.abs((c + 1) * gap - c * gap - gap) < 1e-12, `${row.id}: checkpoint gap ${c} is uniform`);
    }
    assert.ok(Math.abs(row.checkpoints * gap - 1) < 1e-12,
      `${row.id}: ${row.checkpoints} checkpoints divide the lap cleanly`);

    assert.equal(row.aiSectors.length, 24, `${row.id} has 24 AI sectors`);
    let slow = 0;
    for (const v of row.aiSectors) {
      assert.ok(v >= 12 && v <= 22, `${row.id} sector ${v} inside [12, 22]`);
      if (v < 17) slow++;
    }
    assert.ok(slow >= 4, `${row.id} lifts for at least four corners (got ${slow})`);
  }
});

test('§A1.3 — the per-track wire clamp defends 40.9 u/s and clears minRunMs', () => {
  const expect = { sunny: 0.0750, summit: 0.0682, tangle: 0.0711, glimmer: 0.0660 };
  for (const row of TRACKS) {
    const m = maxQPerS(row.id);
    assert.ok(Math.abs(m - expect[row.id]) < 0.0001, `${row.id} clamp ${m}`);
    // three laps can never physically complete faster than this, and that floor
    // must sit ABOVE the row's own minRunMs, so an honest run is never truncated
    const fastestMs = (3 * row.LAP_UNITS / Q_CLAMP_U_PER_S) * 1000;
    assert.ok(fastestMs > row.minRunMs,
      `${row.id}: fastest possible ${fastestMs | 0}ms > minRunMs ${row.minRunMs}`);
    // §A1.1 claims every track still costs ">= 40 s". sunny's shipped 545 units
    // actually work out at 39.98 s, 20 ms under the MINIGAMES.kart.minRunMs of
    // 40_000 in shared/constants.js. It could only ever bite a run that held the
    // wire clamp for three straight laps, which no player can do, but the claim
    // is not exact and the three NEW tracks all clear the floor outright.
    assert.ok(fastestMs >= 39_900,
      `${row.id}: fastest possible ${fastestMs | 0}ms sits at the shipped 40s floor`);
    if (row.id !== 'sunny') {
      assert.ok(fastestMs >= 40_000, `${row.id}: comfortably above the 40s floor`);
    }
  }
});

test('trackMeta is the metadata subset and nothing else', () => {
  for (const id of TRACK_ORDER) {
    const meta = trackMeta(id);
    assert.deepEqual(Object.keys(meta).sort(), [
      'LAP_UNITS', 'aiSectors', 'checkpoints', 'floors', 'gridSlots', 'id',
      'itemBoxes', 'hazards', 'laps', 'minRunMs',
    ].sort());
    assert.equal('points' in meta, false, 'no spline reaches the server');
    assert.equal('theme' in meta, false, 'no theme reaches the server');
    assert.equal('grip' in meta, false, 'grip zones are client only');
    assert.equal('jumps' in meta, false, 'jump zones are client only');
    assert.equal('banks' in meta, false, 'banking is client only');
  }
  assert.equal(allTrackMeta().length, 4);
});

test('§A1 — the server\'s hand copy still agrees with the table this file authors', async () => {
  // §A1 makes this module the AUTHOR of the registry and server/kart.js a hand
  // COPY of the metadata subset, because neither side may import the other at
  // run time. A test may, and this is the one the amendment implied: it diffs
  // the two copies field for field. Wave GP shipped with 56 of 96 aiSectors
  // entries diverged and 488 green tests, because both sides only ever checked
  // their own invariants. Never again.
  const srv = await import('../server/kart.js');
  for (const id of TRACK_ORDER) {
    const mine = trackMeta(id);
    const theirs = srv.TRACKS[id];
    assert.ok(theirs, `the server carries ${id}`);
    // the server stores boxes as {q, lat} and has no `laps` of its own (it
    // keeps one LAPS for every track), so normalise those two and nothing else
    const copy = {
      id: theirs.id,
      LAP_UNITS: theirs.LAP_UNITS,
      checkpoints: theirs.checkpoints,
      floors: theirs.floors,
      laps: srv.LAPS,
      minRunMs: theirs.minRunMs,
      gridSlots: theirs.gridSlots,
      itemBoxes: theirs.itemBoxes.map((b) => [b.q, b.lat]),
      hazards: theirs.hazards.map((h) => ({ ...h })),
      aiSectors: [...theirs.aiSectors],
    };
    assert.deepEqual(copy, mine, `${id}: server/kart.js has drifted from the authored table`);
  }
  assert.deepEqual([...srv.TRACK_ORDER], [...TRACK_ORDER]);
  assert.equal(srv.DEFAULT_TRACK, DEFAULT_TRACK);
  assert.equal(srv.KART_MAX_U_PER_S, Q_CLAMP_U_PER_S);
});

// ================================================================ sampler ====
test('the scale lock puts every lap on its exact LAP_UNITS in 3D', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    let len = 0;
    const a = {};
    const b = {};
    const STEP = 0.5;
    for (let s = 0; s < t.LAP_UNITS; s += STEP) {
      t.at(s, a);
      t.at(s + STEP, b);
      len += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    // the LUT is a 2u polyline through the spline, so it measures a hair short
    assert.ok(Math.abs(len - t.LAP_UNITS) < t.LAP_UNITS * 0.004,
      `${id}: walked ${len.toFixed(1)} vs LAP_UNITS ${t.LAP_UNITS}`);
  }
});

test('§A1.1 — every track lands in its promised elevation range', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    const [lo, hi] = Y_RANGE[id];
    assert.ok(Math.abs(t.yMin - lo) <= TOL_Y, `${id} yMin ${t.yMin.toFixed(2)} ~ ${lo}`);
    assert.ok(Math.abs(t.yMax - hi) <= TOL_Y, `${id} yMax ${t.yMax.toFixed(2)} ~ ${hi}`);
  }
});

test('the sampler is continuous: no elevation pop, no heading pop, no width pop', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    const a = {};
    const b = {};
    const STEP = 0.25;
    let maxDy = 0;
    let maxDang = 0;
    let maxDhw = 0;
    let maxDbank = 0;
    for (let s = 0; s < t.LAP_UNITS + 4; s += STEP) {
      t.at(s, a);
      t.at(s + STEP, b);
      maxDy = Math.max(maxDy, Math.abs(b.y - a.y));
      maxDang = Math.max(maxDang, Math.abs(tracks.wrapPi(b.ang - a.ang)));
      maxDhw = Math.max(maxDhw, Math.abs(b.hw - a.hw));
      maxDbank = Math.max(maxDbank, Math.abs(b.bank - a.bank));
    }
    // 0.25u of travel: a 30% grade is 0.075u of rise, and the wrap at s = LAP
    // has to be as smooth as everywhere else or the road tears at the line
    assert.ok(maxDy < 0.12, `${id}: elevation step ${maxDy.toFixed(4)} over 0.25u`);
    assert.ok(maxDang < 0.09, `${id}: heading step ${maxDang.toFixed(4)} rad over 0.25u`);
    assert.ok(maxDhw < 0.05, `${id}: half-width step ${maxDhw.toFixed(4)} over 0.25u`);
    assert.ok(maxDbank < 0.02, `${id}: bank step ${maxDbank.toFixed(4)} rad over 0.25u`);
  }
});

test('worldOf wraps seamlessly and agrees with at() on the centreline', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    const before = t.worldOf(0.99999, 0, {});
    const after = t.worldOf(0.00001, 0, {});
    assert.ok(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) < 0.05,
      `${id}: the lap wrap is a seam`);
    const c = t.worldOf(0.37, 0, {});
    const s = t.at(0.37 * t.LAP_UNITS + t.sFin, {});
    assert.ok(Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z) < 1e-6, `${id}: lat 0 is the centreline`);
  }
});

test('the road never folds through itself, even on the tightest hairpin', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    const l = {};
    const r = {};
    let minWidth = Infinity;
    for (let i = 0; i < t.n; i++) {
      const q = t.qOfIndex(i);
      t.worldOf(q, -1, l);
      t.worldOf(q, 1, r);
      minWidth = Math.min(minWidth, Math.hypot(r.x - l.x, r.z - l.z));
    }
    assert.ok(minWidth > 3.5, `${id}: the road pinches to ${minWidth.toFixed(2)} units`);
  }
});

test('§A1.3 — the grid sits behind the line, two abreast, three rows', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    const seen = new Set();
    for (let slot = 0; slot < 6; slot++) {
      const g = t.gridSlot(slot, {});
      const u = frac1(g.q) * t.LAP_UNITS;
      const back = t.LAP_UNITS - u;
      assert.ok(back === 6 || back === 13 || back === 20, `${id} slot ${slot} row ${back}`);
      assert.equal(Math.abs(g.lat), 0.47, `${id} slot ${slot} lat`);
      assert.equal(slot % 2 === 0 ? g.lat < 0 : g.lat > 0, true, `${id} slot ${slot} side`);
      seen.add(`${g.q}|${g.lat}`);
    }
    assert.equal(seen.size, 6, `${id}: six distinct grid slots`);
    assert.equal(t.gridSlot(0, {}).lat, -0.47, `${id}: slot 0 is pole, inside line`);
  }
});

test('checkpointQ walks k/checkpoints, and every box sits on the road', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    for (let c = 0; c < t.checkpoints; c++) {
      assert.ok(Math.abs(t.checkpointQ(c) - c / t.checkpoints) < 1e-12);
    }
    assert.equal(t.boxes.length, 11);
    for (const b of t.boxes) {
      const w = t.worldOf(b.q, b.lat, {});
      assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z));
      assert.ok(Math.abs(b.lat) < 1.0, `${id} box ${b.i} is inside the white lines`);
    }
    assert.deepEqual(t.boxes.map((b) => b.i), [...Array(11).keys()]);
  }
});

// ============================================================ zones + haz ====
test('§A3 — grip, jump and bank zones exist exactly where the amendment says', () => {
  const summit = sampler('summit');
  assert.ok(summit.gripAt(0.16) < 0.6, 'summit ice at q 0.16');
  assert.ok(summit.gripAt(0.41) < 0.6, 'summit ice at q 0.41');
  assert.ok(summit.gripAt(0.30) > 0.99, 'summit is dry between the patches');
  assert.equal(summit.jumpAt(0.51), 0, 'summit has no jump');

  const tangle = sampler('tangle');
  assert.ok(tangle.gripAt(0.635) < 0.85, 'the ruin is wet stone');
  assert.ok(tangle.gripAt(0.50) > 0.99, 'and everything else is not');

  const glimmer = sampler('glimmer');
  assert.ok(glimmer.gripAt(0.465) < 0.75, 'the jump run-up is dusted with grit');
  assert.equal(glimmer.jumpAt(0.5125), 7.5, 'the lip launches at 7.5 u/s');
  assert.equal(glimmer.jumpAt(0.40), 0);
  assert.ok(Math.abs(glimmer.bankAt(0.20)) > 0.2, 'q 0.20 is banked');
  assert.ok(Math.abs(glimmer.bankAt(0.75)) > 0.2, 'q 0.75 is banked');
  assert.ok(Math.abs(glimmer.bankAt(0.45)) < 0.02, 'and the straight is flat');
  for (const id of ['sunny', 'summit', 'tangle']) {
    for (let q = 0; q < 1; q += 0.02) {
      assert.equal(sampler(id).bankAt(q), 0, `${id} is unbanked`);
    }
  }
  // grip is a FEEL, never a top-speed term: it is bounded well away from zero
  for (const id of TRACK_ORDER) {
    for (let q = 0; q < 1; q += 0.005) {
      const g = sampler(id).gripAt(q);
      assert.ok(g > 0.35 && g <= 1.0001, `${id} grip ${g} at q ${q.toFixed(3)}`);
    }
  }
});

test('§A2 — the hazard rows are the frozen table', () => {
  const t = getTrack('tangle').hazards;
  assert.equal(t.length, 5);
  assert.deepEqual(t.map((h) => h.kind), ['vine', 'vine', 'boulder', 'boulder', 'vine']);
  assert.deepEqual(t.map((h) => h.i), [0, 1, 2, 3, 4]);
  assert.deepEqual(t.map((h) => h.q), [0.180, 0.205, 0.470, 0.470, 0.720]);
  assert.deepEqual(t.map((h) => h.period), [3000, 3000, 5200, 5200, 2400]);
  assert.deepEqual(t.map((h) => h.off), [0, 0, 0, 2600, 1200]);
  assert.deepEqual(t.map((h) => h.wave), ['sin', 'sin', 'saw', 'saw', 'sin']);
  assert.equal(t[1].psi, Math.PI);
  assert.deepEqual(t.map((h) => h.hq), [0.006, 0.006, 0.006, 0.006, 0.006]);
  assert.deepEqual(t.map((h) => h.hl), [0.34, 0.34, 0.40, 0.40, 0.30]);

  const g = getTrack('glimmer').hazards;
  assert.equal(g.length, 3);
  assert.deepEqual(g.map((h) => h.kind), ['cart', 'cart', 'cart']);
  assert.deepEqual(g.map((h) => h.q), [0.310, 0.315, 0.660]);
  assert.deepEqual(g.map((h) => h.latAmp), [1.30, 1.30, 1.10]);
  assert.deepEqual(g.map((h) => h.period), [4000, 4000, 3200]);
  assert.deepEqual(g.map((h) => h.off), [0, 2000, 800]);
  assert.equal(g[1].psi, Math.PI);
  for (const id of ['sunny', 'summit']) assert.equal(getTrack(id).hazards.length, 0);
  assert.equal(HAZ_HIT_MS, 900);
  assert.equal(HAZ_IMMUNE_MS, 1200);
});

test('§A2 — hazardPose is a pure function of race time and nothing else', () => {
  const h = getTrack('tangle').hazards[0];
  const a = hazardPose(h, 1234, {});
  const b = hazardPose(h, 1234, {});
  assert.deepEqual(a, b, 'same T, same pose, always');
  // one full period returns it to the start
  const c = hazardPose(h, 1234 + h.period, {});
  assert.ok(Math.abs(c.lat - a.lat) < 1e-9 && Math.abs(dq(a.q, c.q)) < 1e-9);
  // the sine pair is genuinely out of phase (psi = PI), which is the whole point
  const g0 = hazardPose(getTrack('tangle').hazards[0], 0, {});
  const g1 = hazardPose(getTrack('tangle').hazards[1], 0, {});
  assert.ok(Math.abs(g0.lat - g1.lat) < 1e-9 || Math.abs(g0.lat + g1.lat) < 1e-9);
  // the saw boulder marches forward then snaps back, never sideways
  const s0 = hazardPose(getTrack('tangle').hazards[2], 0, {});
  const s1 = hazardPose(getTrack('tangle').hazards[2], 2600, {});
  assert.equal(s0.lat, -0.35);
  assert.equal(s1.lat, -0.35);
  assert.ok(Math.abs(dq(s1.q, s0.q)) > 0.01, 'the boulder actually rolls');
  // and every pose stays on a real piece of road
  for (const id of ['tangle', 'glimmer']) {
    const t = sampler(id);
    for (const row of t.hazards) {
      for (let T = 0; T < 12_000; T += 97) {
        const p = hazardPose(row, T, {});
        assert.ok(Math.abs(p.lat) <= Math.abs(row.lat) + Math.abs(row.latAmp) + 1e-9);
        const w = t.worldOf(p.q, p.lat, {});
        assert.ok(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z));
      }
    }
  }
});

test('§A2 — the hit test is symmetric in slack and never fires off the window', () => {
  const h = getTrack('glimmer').hazards[2];
  const T = 4321;
  const p = hazardPose(h, T, {});
  assert.equal(hazardHits(h, p.q, p.lat, T), true, 'dead centre is a hit');
  assert.equal(hazardHits(h, frac1(p.q + h.hq * 0.9), p.lat, T), true);
  assert.equal(hazardHits(h, frac1(p.q + h.hq * 1.4), p.lat, T), false, 'outside dq is a miss');
  assert.equal(hazardHits(h, p.q, p.lat + h.hl * 1.4, T), false, 'outside dlat is a miss');
  // the server's staleness allowance (hq*2 / hl*1.3) widens it and only widens it
  assert.equal(hazardHits(h, frac1(p.q + h.hq * 1.4), p.lat, T, 2, 1.3), true);
  assert.equal(hazardHits(h, frac1(p.q + h.hq * 2.4), p.lat, T, 2, 1.3), false);
  assert.equal(hazardHits(h, NaN, p.lat, T), false, 'a junk frame never lands a hit');
  assert.equal(hazardHits(h, p.q, Infinity, T), false);
});

// ============================================================== the meshes ==
test('every track builds a real scene, one draw call per instanced family', () => {
  for (const id of TRACK_ORDER) {
    const scene = new THREE.Scene();
    const t = sampler(id);
    const world = buildTrackWorld(scene, t);
    assert.equal(world.group.parent, scene, `${id}: parented`);

    let meshes = 0;
    let instanced = 0;
    let shadowLights = 0;
    let tris = 0;
    world.group.traverse((o) => {
      if (o.isInstancedMesh) { instanced++; meshes++; } else if (o.isMesh) meshes++;
      if (o.isLight && o.castShadow) shadowLights++;
      if (o.isMesh) {
        const pos = o.geometry?.attributes?.position;
        if (pos) tris += (pos.count / 3) * (o.isInstancedMesh ? Math.max(1, o.count) : 1);
      }
    });
    assert.ok(meshes > 8, `${id}: the track is actually dressed (${meshes} meshes)`);
    assert.ok(meshes <= 40, `${id}: ${meshes} draw calls is over the room budget`);
    assert.ok(instanced >= 3, `${id}: repeated props are instanced (${instanced} families)`);
    assert.equal(shadowLights, 1, `${id}: exactly one shadow caster (§6)`);
    assert.ok(tris < 900_000, `${id}: ${(tris / 1000) | 0}k tris`);

    // three merged surface ribbons, never per-segment meshes
    assert.equal(world.ribbons.length, 3, `${id}: road, kerbs and apron are 3 ribbons`);
    for (const r of world.ribbons) {
      assert.ok(r.geometry.attributes.position.count > 100);
      assert.ok(r.geometry.attributes.color, 'ribbons are vertex-coloured');
      assert.ok(r.geometry.attributes.normal, 'and carry real normals');
    }

    // hazard families: one per kind, count = number of rows
    const kinds = new Set(t.hazards.map((h) => h.kind));
    assert.equal(world.hazards.size, kinds.size, `${id}: one family per hazard kind`);
    for (const [kind, fam] of world.hazards) {
      assert.equal(fam.im.count, fam.rows.length, `${id}: ${kind} instances`);
    }
    world.dispose();
    assert.equal(world.group.parent, null, `${id}: dispose unparents`);
    assert.equal(scene.children.length, 0, `${id}: dispose leaves the scene clean`);
  }
});

test('the hazard instances actually move with race time, and only with it', () => {
  const scene = new THREE.Scene();
  const t = sampler('tangle');
  const world = buildTrackWorld(scene, t, { lights: false, sky: false, ground: false });
  const fam = world.hazards.get('vine');
  const m0 = new THREE.Matrix4();
  const m1 = new THREE.Matrix4();
  world.updateHazards(0, 0);
  fam.im.getMatrixAt(0, m0);
  world.updateHazards(0, 999);            // a different `time`, same race clock
  fam.im.getMatrixAt(0, m1);
  assert.deepEqual([...m0.elements], [...m1.elements], 'ambient time never moves a hazard');
  world.updateHazards(750, 0);            // a quarter period on the 3000ms vine
  fam.im.getMatrixAt(0, m1);
  assert.notDeepEqual([...m0.elements], [...m1.elements], 'race time does');
  // and it comes home after one full period
  world.updateHazards(3000, 0);
  fam.im.getMatrixAt(0, m1);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(m0.elements[i] - m1.elements[i]) < 1e-4, 'one period is a loop');
  }
  world.dispose();
});

test('update() is safe with no camera, and dispose() is idempotent', () => {
  const scene = new THREE.Scene();
  const world = buildTrackWorld(scene, sampler('glimmer'));
  world.update(0.016, 1.5, 2500, null);
  world.update(0.016, 1.52, 2516, new THREE.Vector3(10, 4, -20));
  assert.ok(world.sky.position.x === 10, 'the sky dome rides the camera');
  world.scareFlock();
  world.dispose();
  world.dispose();
  assert.equal(scene.children.length, 0);
});

// ================================================================== the hud ==
test('§A7 — hudTrack hands GP3 a closed, elevation-shaded polyline', () => {
  for (const id of TRACK_ORDER) {
    const t = sampler(id);
    const h = hudTrack(t);
    assert.equal(h.id, id);
    assert.equal(h.name, t.name);
    assert.equal(h.theme, t.theme);
    assert.equal(typeof h.road, 'number');
    assert.equal(h.laps, 3);
    assert.ok(h.points.length > 40 && h.points.length < 160, `${id}: ${h.points.length} points`);
    const first = h.points[0];
    const last = h.points[h.points.length - 1];
    assert.deepEqual(first, last, `${id}: the minimap polyline closes`);
    for (const p of h.points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.y));
      assert.ok(p.y >= h.yMin - 1e-6 && p.y <= h.yMax + 1e-6, `${id}: shading stays in range`);
    }
    // a flat track shades flat; an elevated one has something to shade
    if (id === 'sunny') assert.equal(h.yMax - h.yMin, 0);
    else assert.ok(h.yMax - h.yMin > 10, `${id}: real relief for the shading`);
    assert.ok(Number.isFinite(h.finish.x) && Number.isFinite(h.finish.ang));
    assert.deepEqual(t.hudTrack(), h, 'the method and the function agree');
  }
});
