// src/core/audio.js: the module contract and the depth added in the AAA feel
// pass (sidechain, overlay recede, day/night, room-keyed whoosh + coin runs,
// master compressor). Everything is asserted through a stub WebAudio graph, so
// these are real automation schedules, not mocks of the module's own opinions.
import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------ stub WebAudio --

class Param {
  constructor(v = 0) { this.value = v; this.log = []; }
  #ev(kind, v, t) {
    assert.ok(Number.isFinite(v), `automation value must be finite, got ${v}`);
    assert.ok(Number.isFinite(t), `automation time must be finite, got ${t}`);
    this.log.push({ kind, v, t });
    this.value = v;
    return this;
  }
  setValueAtTime(v, t) { return this.#ev('set', v, t); }
  linearRampToValueAtTime(v, t) { return this.#ev('lin', v, t); }
  exponentialRampToValueAtTime(v, t) {
    assert.notEqual(v, 0, 'exponentialRamp to 0 throws in a real AudioContext');
    return this.#ev('exp', v, t);
  }
  setTargetAtTime(v, t) { return this.#ev('tgt', v, t); }
  cancelScheduledValues() { return this; }
}

class Node {
  constructor(kind) { this.kind = kind; this.gain = new Param(1); this.out = []; }
  connect(d) { this.out.push(d); return d; }
  disconnect() { return this; }
  start(t) { assert.ok(t == null || Number.isFinite(t)); }
  stop(t) { assert.ok(t == null || Number.isFinite(t)); }
}

class StubCtx {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = new Node('destination');
    this.nodes = [];
  }
  #mk(kind, extra) { const n = Object.assign(new Node(kind), extra); this.nodes.push(n); return n; }
  createGain() { return this.#mk('gain'); }
  createOscillator() {
    return this.#mk('osc', { type: 'sine', frequency: new Param(440), detune: new Param(0) });
  }
  createBiquadFilter() {
    return this.#mk('biquad', {
      type: 'lowpass', frequency: new Param(350), Q: new Param(1), gain: new Param(0),
    });
  }
  createBufferSource() { return this.#mk('src', { buffer: null, loop: false, playbackRate: new Param(1) }); }
  createStereoPanner() { return this.#mk('panner', { pan: new Param(0) }); }
  createConvolver() { return this.#mk('convolver', { buffer: null }); }
  createDelay() { return this.#mk('delay', { delayTime: new Param(0) }); }
  createDynamicsCompressor() {
    return this.#mk('compressor', {
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25),
    });
  }
  createWaveShaper() { return this.#mk('shaper', { curve: null, oversample: 'none' }); }
  createBuffer(channels, len, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(len));
    return { length: len, sampleRate: rate, numberOfChannels: channels, getChannelData: (i) => data[i] };
  }
  resume() { return Promise.resolve(); }
}

// ------------------------------------------------------------------ harness --

const MUSIC_LEVEL = 0.21; // the authored music bus level, at trim 1

/** Install the stub globals, import a FRESH audio module, and hand back both it
 *  and the pieces of the graph, found by walking the connections rather than by
 *  guessing at construction order. */
async function boot({ reducedMotion = false } = {}) {
  let ctx = null;
  const timers = [];
  globalThis.AudioContext = class extends StubCtx {
    constructor() { super(); ctx = this; }
  };
  globalThis.webkitAudioContext = undefined;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.matchMedia = () => ({ matches: reducedMotion });
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.document = { querySelector: () => null, getElementById: () => null };
  globalThis.setInterval = (fn) => timers.push(fn);
  globalThis.clearInterval = () => {};

  // cache-bust so each test gets its own module state. `game` deliberately is
  // NOT busted: audio.js imports the canonical singleton, and the clock frames
  // this harness emits have to land on that same one.
  const { audio } = await import(`../src/core/audio.js?t=${Math.random()}`);
  const { game } = await import('../src/core/game.js');
  audio.init();

  // the music bus is the one gain sitting at the authored music level
  const musicBus = ctx.nodes.find((n) => n.kind === 'gain' && Math.abs(n.gain.value - MUSIC_LEVEL) < 1e-9);
  assert.ok(musicBus, 'music bus not found');
  const tilt = musicBus.out[0];
  const lp = tilt.out[0];
  const focus = lp.out[0];
  const duck = focus.out[0];
  const master = duck.out[0];
  const glue = master.out[0];
  const shaper = ctx.nodes.find((n) => n.kind === 'shaper');

  return {
    audio,
    game,
    ctx,
    graph: { musicBus, tilt, lp, focus, duck, master, glue, shaper },
    tick: () => { for (const fn of timers.slice()) fn(); },
    advance: (s) => { ctx.currentTime += s; },
  };
}

// ------------------------------------------------------------------- tests --

test('importing the module touches nothing: no AudioContext, no DOM, no storage', async () => {
  for (const k of ['AudioContext', 'webkitAudioContext', 'document', 'localStorage', 'matchMedia']) {
    delete globalThis[k];
  }
  const { audio } = await import(`../src/core/audio.js?t=${Math.random()}`);
  assert.equal(typeof audio.init, 'function');
  for (const name of ['play', 'setRoom', 'toggleMute', 'setVolume', 'getVolume', 'setOverlay']) {
    assert.equal(typeof audio[name], 'function', `audio.${name} is part of the public API`);
  }
  // and every entry point is a no-op rather than a throw with no audio at all
  assert.doesNotThrow(() => { audio.play('coin'); audio.setRoom('plaza'); audio.setOverlay(true); });
});

test('the master chain ends in a compressor and a soft clip that cannot pass a sample over full scale', async () => {
  const { graph } = await boot();
  const { master, glue, shaper } = graph;
  assert.equal(glue.kind, 'compressor', 'the bus glue sits straight after the master trim');
  assert.ok(glue.ratio.value > 1 && glue.ratio.value < 4, 'glue is gentle, not a limiter');
  assert.ok(master.gain.value > 0, 'master is open at boot when unmuted');

  const c = shaper.curve;
  assert.ok(c && c.length % 2 === 1, 'an odd-length curve has a sample at exactly zero');
  assert.equal(c[(c.length - 1) / 2], 0, 'silence in, silence out');
  assert.ok(Math.abs(c[0] + 1) < 1e-6 && Math.abs(c[c.length - 1] - 1) < 1e-6, 'the curve reaches exactly +-1');
  for (let i = 1; i < c.length; i++) assert.ok(c[i] > c[i - 1], 'the curve is monotonic (no fold-back distortion)');
  for (const v of c) assert.ok(v >= -1 && v <= 1, 'nothing downstream of the shaper can clip');
  assert.equal(shaper.oversample, '2x');
});

test('a UI sound ducks the bed on its own node, never on the player volume trim', async () => {
  const { audio, graph, advance } = await boot();
  const { duck, musicBus } = graph;
  audio.setRoom('plaza');
  advance(5);
  duck.log = [];
  const busBefore = musicBus.gain.value;

  audio.play('ding');
  const ramps = duck.gain.log;
  assert.ok(ramps.length >= 4, 'the dip is scheduled as cancel/set/down/hold/up');
  const bottom = Math.min(...ramps.map((e) => e.v));
  assert.ok(bottom < 1 && bottom > 0.3, `a gentle dip, got ${bottom}`);
  assert.equal(ramps[ramps.length - 1].v, 1, 'and it always comes back to unity');
  assert.equal(musicBus.gain.value, busBefore, 'the trim is untouched: the two automations never share a param');
});

test('a light sound landing inside a big one does not cut its recovery short', async () => {
  const { audio, graph, advance } = await boot();
  const { duck } = graph;
  audio.setRoom('plaza');
  advance(5);

  audio.play('success');
  const deepEnd = duck.gain.log[duck.gain.log.length - 1].t;
  // a real AudioContext reports the value it is currently sitting at
  duck.gain.value = 0.55;
  advance(0.05);
  duck.gain.log = [];
  audio.play('click');
  assert.equal(duck.gain.log.length, 0, 'the shallower, shorter duck is skipped entirely');

  // ...but something deeper still takes the bed
  advance(0.05);
  audio.play('levelup');
  assert.ok(duck.gain.log.length > 0, 'a deeper duck is always allowed through');
  assert.ok(duck.gain.log[duck.gain.log.length - 1].t > deepEnd, 'and it extends the recovery');
});

test('an overlay makes the world recede, and releases it again', async () => {
  const { audio, graph } = await boot();
  const { lp, focus } = graph;
  audio.setRoom('plaza');
  assert.ok(lp.frequency.value > 15000, 'the focus lowpass is transparent while you are playing');
  assert.equal(focus.gain.value, 1);

  audio.setOverlay(true);
  assert.ok(lp.frequency.value < 1200, 'a menu rolls the bed off');
  assert.ok(focus.gain.value < 1 && focus.gain.value > 0.5, 'and takes a few dB, not the whole bed');

  audio.setOverlay(false);
  assert.ok(lp.frequency.value > 15000, 'closing it brings the world back');
  assert.equal(focus.gain.value, 1);
});

test('prefers-reduced-motion softens the recede and halves the sidechain', async () => {
  const loud = await boot({ reducedMotion: false });
  const soft = await boot({ reducedMotion: true });
  loud.audio.setOverlay(true);
  soft.audio.setOverlay(true);
  assert.ok(soft.graph.lp.frequency.value > loud.graph.lp.frequency.value, 'a gentler roll-off');
  assert.ok(soft.graph.focus.gain.value > loud.graph.focus.gain.value, 'and a gentler dip');

  for (const h of [loud, soft]) { h.audio.setOverlay(false); h.audio.setRoom('plaza'); h.advance(5); h.graph.duck.gain.log = []; }
  loud.audio.play('success');
  soft.audio.play('success');
  const depth = (h) => Math.min(...h.graph.duck.gain.log.map((e) => e.v));
  assert.ok(depth(soft) > depth(loud), 'the sidechain pumps half as hard');
});

test('the world clock tilts the bed after dusk and arms the crickets outdoors', async () => {
  const { audio, game, graph, ctx, tick, advance } = await boot();
  const { tilt } = graph;
  audio.setRoom('plaza');
  game.events.emit('clock', { dayT: 0.25 }); // noon
  const dayTilt = tilt.gain.log[tilt.gain.log.length - 1].v;
  assert.ok(Math.abs(dayTilt) < 0.01, 'full daylight is the mix as authored');

  game.events.emit('clock', { dayT: 0.75 }); // midnight
  const nightTilt = tilt.gain.log[tilt.gain.log.length - 1].v;
  assert.ok(nightTilt < -3, `night rolls the top end down, got ${nightTilt}`);
  const ramp = tilt.gain.log[tilt.gain.log.length - 1].t - ctx.currentTime;
  assert.ok(ramp > 3, 'over a long ramp: a crossfade, not a step');

  // The ambience layer hangs off the focus lowpass rather than off a track, so
  // every critter it spawns is a panner pointed at that one gain: counting them
  // says exactly what the room heard, with no reading of tea leaves in a total.
  const { lp } = graph;
  const ambOut = ctx.nodes.filter((n) => n.kind === 'gain' && n.out.includes(lp))[0];
  assert.ok(ambOut, 'the ambience bus is wired past the night shelf');
  // Windows are sized off the spawn odds so a run that sees none is a bug and
  // not bad luck: gulls are the rarest at ~1 in 30 slots, so they get six
  // cove minutes and every other check gets eighty seconds.
  const critters = (room, dayT, ticks = 900) => {
    audio.setRoom(room);
    game.events.emit('clock', { dayT });
    for (let i = 0; i < 20; i++) { advance(0.09); tick(); }
    const count = () => ctx.nodes.filter((n) => n.kind === 'panner' && n.out.includes(ambOut)).length;
    const before = count();
    for (let i = 0; i < ticks; i++) { advance(0.09); tick(); }
    return count() - before;
  };
  assert.ok(critters('plaza', 0.75) > 3, 'the plaza has crickets at midnight');
  assert.equal(critters('plaza', 0.25), 0, 'and none at all at noon');
  assert.ok(critters('beach', 0.25, 4000) > 0, 'the coast has gulls by day');
  assert.equal(critters('cafe', 0.75), 0, 'indoors hears neither, at any hour');
  assert.equal(critters('mine', 0.75), 0);
});

test('a garbage or missing clock frame leaves the bed exactly as it was', async () => {
  const { audio, game, graph } = await boot();
  audio.setRoom('plaza');
  const before = graph.tilt.gain.log.length;
  for (const bad of [null, undefined, {}, { dayT: 'noon' }, { dayT: NaN }, { dayT: Infinity }]) {
    assert.doesNotThrow(() => game.events.emit('clock', bad));
  }
  assert.equal(graph.tilt.gain.log.length, before, 'nothing was scheduled from nonsense');
});

test('each room keys its own doorway and its own coin run', async () => {
  const { audio, ctx, advance } = await boot();
  const midi = (f) => Math.round(69 + 12 * Math.log2(f / 440));
  const firstPitches = (room, name, n = 1) => {
    audio.setRoom(room);
    advance(5);
    const out = [];
    for (let i = 0; i < n; i++) {
      advance(0.1);
      const mark = ctx.nodes.length;
      audio.play(name);
      const osc = ctx.nodes.slice(mark).find((x) => x.kind === 'osc');
      out.push(midi(osc.frequency.log[0].v));
    }
    return out;
  };

  const plazaDoor = firstPitches('plaza', 'whoosh')[0];
  const mineDoor = firstPitches('mine', 'whoosh')[0];
  const clubDoor = firstPitches('club', 'whoosh')[0];
  assert.notEqual(plazaDoor, mineDoor, 'the plaza and the mine do not share a doorway');
  assert.notEqual(mineDoor, clubDoor);

  // a room with no bed of its own (a player den) still has a key to travel on
  assert.doesNotThrow(() => firstPitches('house:someone', 'whoosh'));
  assert.doesNotThrow(() => firstPitches('constructor', 'whoosh'), 'and an id off Object.prototype is not a key');

  const run = firstPitches('plaza', 'coin', 9);
  assert.equal(run[0], run[1], 'the first coins are the plain pickup');
  for (let i = 3; i < run.length; i++) assert.ok(run[i] > run[i - 1], 'from the third, the streak climbs');
  const steps = run.slice(3).map((n, i) => n - run[i + 2]);
  for (const s of steps) assert.ok(s === 2 || s === 3, `pentatonic steps only, got ${s}`);

  const mineRun = firstPitches('mine', 'coin', 3);
  assert.notEqual(mineRun[0], run[0], "and the run starts in the room's own key");
});

test('the coin streak resets after two quiet seconds', async () => {
  const { audio, ctx, advance } = await boot();
  const midi = (f) => Math.round(69 + 12 * Math.log2(f / 440));
  audio.setRoom('plaza');
  advance(5);
  const coin = () => {
    const mark = ctx.nodes.length;
    audio.play('coin');
    return midi(ctx.nodes.slice(mark).find((x) => x.kind === 'osc').frequency.log[0].v);
  };
  let last = 0;
  for (let i = 0; i < 6; i++) { advance(0.1); last = coin(); }
  assert.ok(last > 84, 'six quick coins have climbed');
  advance(2.5);
  assert.equal(coin(), 84, 'a pause drops it back to the bottom of the run');
});

test('mute still wins over everything the depth pass added', async () => {
  const { audio, graph, advance } = await boot();
  audio.setRoom('plaza');
  audio.setOverlay(true);
  assert.equal(audio.toggleMute(), true);
  assert.equal(graph.master.gain.value, 0, 'muted is silent no matter what the bed is doing');
  advance(1);
  graph.duck.gain.log = [];
  audio.play('ding');
  assert.equal(graph.duck.gain.log.length, 0, 'and a muted sound does not even duck');
  assert.equal(audio.toggleMute(), false);
  assert.ok(graph.master.gain.value > 0, 'unmuting restores the master trim');
});

test('the music trim scales the bed and survives a duck', async () => {
  const { audio, graph, advance } = await boot();
  audio.setRoom('plaza');
  assert.equal(audio.setVolume('music', 0.5), 0.5);
  advance(1);
  audio.play('ding');
  advance(1);
  assert.ok(Math.abs(graph.musicBus.gain.value - MUSIC_LEVEL * 0.5) < 1e-9, 'the trim is where the player left it');
  assert.equal(audio.setVolume('nonsense', 0.5), null);
  assert.equal(audio.getVolume('nonsense'), 1);
});
