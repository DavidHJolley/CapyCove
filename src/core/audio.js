// Procedural WebAudio: SFX + generative per-room music. No external assets.
//
// Public API (frozen, other modules call these):
//   audio.init()          - call once after a user gesture
//   audio.play(name)      - one-shot sfx: click, coin, step, splash, whoosh,
//                           success, fail, pop, ding (+ extras, see SFX below)
//                           play('step', surface?) picks a footstep voice for
//                           wood/sand/snow/stone/grass; with no surface given
//                           it is inferred from the current room id, so the
//                           existing play('step') call sites need no change.
//   audio.setRoom(roomId) - crossfade the generative music bed to that room
//                           (one bed per room id in TRACKS: plaza, beach, peak,
//                           cafe, club, lounge, mine, jungle, drift; any other
//                           id fades to silence and is otherwise ignored)
//   audio.toggleMute()    - returns new muted state
//   audio.muted
//
// Everything is synthesized. Music uses lookahead scheduling: a single interval
// wakes up every ~90ms and schedules notes ~280ms ahead on the AudioContext
// clock, so patterns stay sample-tight regardless of frame rate. There is only
// ever ONE interval for the whole module, so switching rooms can never orphan a
// scheduler. No DOM access and no AudioContext at import time.

// ---------------------------------------------------------------- levels ----

const MASTER_LEVEL = 0.75; // pre-limiter trim
const MUSIC_LEVEL = 0.21;  // music bus sits around -18dBFS
const SFX_LEVEL = 0.6;     // sfx ride above the music
const VERB_LEVEL = 0.42;

const TICK_MS = 90;        // scheduler wake-up
const LOOKAHEAD = 0.28;    // seconds of notes queued ahead of the clock
const CROSSFADE = 1.5;     // room-to-room music fade, seconds

// ------------------------------------------------------------ graph state ---

let ctx = null;
let master = null;      // trim -> limiter -> destination
let musicBus = null;
let sfxBus = null;
let convolver = null;   // shared tiny reverb
let verbReturn = null;
let noiseBuf = null;
let sfxDry = null;      // persistent sfx destinations (a little / a lot of verb)
let sfxWet = null;

let muted = false;
let currentRoom = null;
let tracks = [];        // live music tracks (usually 1, briefly 2 while fading)
let schedTimer = null;
let stepPans = null;    // [left, right] persistent footstep panners

// ------------------------------------------------------------- utilities ----

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const chance = (p) => Math.random() < p;

/** MIDI note number -> Hz. 60 = middle C. */
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function makeNoiseBuffer(seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02; // a touch of brown mixed in, less harsh
      d[i] = w * 0.7 + last * 3.2;
    }
  }
  return buf;
}

/** Generated impulse response: small warm room with a short pre-delay. */
function makeImpulse(seconds = 1.9, decay = 3.0, tone = 0.34) {
  const rate = ctx.sampleRate;
  const len = Math.max(8, Math.floor(seconds * rate));
  const pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      if (i < pre) { d[i] = 0; continue; }
      const t = (i - pre) / (len - pre);
      const n = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      lp += (n - lp) * tone;
      d[i] = lp * 1.6;
    }
  }
  return buf;
}

function ensure() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return false;
  try { ctx = new AC(); } catch { ctx = null; return false; }

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 14;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.22;
  limiter.connect(ctx.destination);

  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_LEVEL;
  master.connect(limiter);

  musicBus = ctx.createGain();
  musicBus.gain.value = MUSIC_LEVEL;
  musicBus.connect(master);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = SFX_LEVEL;
  sfxBus.connect(master);

  noiseBuf = makeNoiseBuffer(2);

  convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse();
  verbReturn = ctx.createGain();
  verbReturn.gain.value = VERB_LEVEL;
  convolver.connect(verbReturn);
  verbReturn.connect(master);

  // Two shared sfx destinations, built once, so one-shots allocate only the
  // nodes they actually sound with.
  sfxDry = ctx.createGain(); sfxDry.connect(sfxBus);
  const drySend = ctx.createGain(); drySend.gain.value = 0.14;
  sfxDry.connect(drySend); drySend.connect(convolver);
  sfxWet = ctx.createGain(); sfxWet.connect(sfxBus);
  const wetSend = ctx.createGain(); wetSend.gain.value = 0.34;
  sfxWet.connect(wetSend); wetSend.connect(convolver);

  // Persistent left/right footstep destinations: steps alternate between them
  // so a walk cycle sways gently instead of stacking dead centre.
  stepPans = [panNode(sfxDry, -0.16), panNode(sfxDry, 0.16)];

  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  // A room may have been requested before init(); start it now.
  if (currentRoom && !tracks.some((t) => !t.dying)) startTrack(currentRoom);
  return true;
}

// ------------------------------------------------------------ voice atoms ---

/** Simple oscillator voice with an exponential AD(H)SR-ish envelope. */
function tone(dest, t, {
  type = 'sine', f0 = 440, f1 = null, glide = null,
  dur = 0.2, hold = 0, a = 0.005, vol = 0.25, detune = 0,
} = {}) {
  const o = ctx.createOscillator();
  o.type = type;
  if (detune) o.detune.setValueAtTime(detune, t);
  o.frequency.setValueAtTime(Math.max(16, f0), t);
  if (f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(16, f1), t + (glide ?? dur));
  const g = ctx.createGain();
  const peak = Math.max(0.0004, vol);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  if (hold) g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + dur);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + a + hold + dur + 0.04);
  return g;
}

/** Filtered noise burst. `sweep` is a multiplier applied to the filter freq. */
function noise(dest, t, {
  dur = 0.2, vol = 0.25, type = 'bandpass', freq = 2000, q = 1,
  sweep = 1, a = 0.003, rate = 1,
} = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  src.playbackRate.value = rate;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(clamp(freq, 20, 20000), t);
  if (sweep !== 1) f.frequency.exponentialRampToValueAtTime(clamp(freq * sweep, 20, 20000), t + dur);
  const g = ctx.createGain();
  const peak = Math.max(0.0004, vol);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, Math.random() * 1.5);
  src.stop(t + a + dur + 0.05);
  return g;
}

function panNode(dest, amount) {
  if (!ctx.createStereoPanner) {
    const g = ctx.createGain();
    g.connect(dest);
    return g;
  }
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(amount, -1, 1);
  p.connect(dest);
  return p;
}

// ---------------------------------------------------------- instrument kit --

/** Wooden mallet bar: fundamental + the 4:1 partial marimbas are famous for. */
function marimba(dest, t, midi, { vol = 0.34, dur = 0.85 } = {}) {
  const f = mtof(midi);
  tone(dest, t, { type: 'sine', f0: f, dur, vol, a: 0.004 });
  tone(dest, t, { type: 'sine', f0: f * 3.99, dur: dur * 0.26, vol: vol * 0.2, a: 0.002 });
  tone(dest, t, { type: 'sine', f0: f * 9.2, dur: 0.06, vol: vol * 0.07, a: 0.001 });
  noise(dest, t, { dur: 0.018, vol: vol * 0.16, type: 'bandpass', freq: 2600, q: 1.4 });
}

/** Nylon-string pluck (ukulele / soft guitar): saw pair through a closing LP. */
function pluck(dest, t, midi, { vol = 0.22, dur = 0.9, bright = 7 } = {}) {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.1;
  lp.frequency.setValueAtTime(clamp(f * bright, 200, 12000), t);
  lp.frequency.exponentialRampToValueAtTime(clamp(f * 1.6, 120, 12000), t + Math.min(dur, 0.35));
  const g = ctx.createGain();
  const peak = Math.max(0.0004, vol);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g);
  g.connect(dest);

  for (const [wave, mul, det, amp] of [['sawtooth', 1, -4, 1], ['triangle', 2.001, 6, 0.42]]) {
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(f * mul, t);
    o.detune.setValueAtTime(det, t);
    const og = ctx.createGain();
    og.gain.value = amp;
    o.connect(og);
    og.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  noise(lp, t, { dur: 0.012, vol: 0.5, type: 'highpass', freq: 1800 });
}

/** Inharmonic music-box / glockenspiel bell. */
function bell(dest, t, midi, { vol = 0.2, dur = 2.4 } = {}) {
  const f = mtof(midi);
  const parts = [[1, 1, 1], [2.756, 0.42, 0.62], [5.404, 0.2, 0.34], [8.93, 0.1, 0.2]];
  for (const [mul, amp, len] of parts) {
    tone(dest, t, { type: 'sine', f0: f * mul, dur: dur * len, vol: vol * amp, a: 0.003 });
  }
  noise(dest, t, { dur: 0.02, vol: vol * 0.2, type: 'highpass', freq: 5000 });
}

/** Warm electric-piano-ish chord voice (two sines, bell decay). */
function rhodes(dest, t, midi, { vol = 0.16, dur = 1.6 } = {}) {
  const f = mtof(midi);
  tone(dest, t, { type: 'sine', f0: f, dur, vol, a: 0.008 });
  tone(dest, t, { type: 'sine', f0: f * 2, dur: dur * 0.4, vol: vol * 0.28, a: 0.004 });
  tone(dest, t, { type: 'triangle', f0: f * 4.02, dur: 0.09, vol: vol * 0.1, a: 0.002 });
}

function kick(dest, t, { vol = 0.95 } = {}) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(155, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.075);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + 0.4);
  noise(dest, t, { dur: 0.014, vol: vol * 0.22, type: 'highpass', freq: 1400 });
}

function hat(dest, t, { open = false, vol = 0.16 } = {}) {
  noise(dest, t, {
    dur: open ? 0.24 : 0.038, vol, type: 'highpass',
    freq: open ? 7200 : 8600, q: 0.9, sweep: open ? 0.8 : 1, rate: 1.4,
  });
}

function clap(dest, t, { vol = 0.34 } = {}) {
  for (let i = 0; i < 3; i++) {
    noise(dest, t + i * 0.011, { dur: 0.032, vol: vol * (0.6 + i * 0.2), type: 'bandpass', freq: 1500, q: 1.1 });
  }
  noise(dest, t + 0.03, { dur: 0.16, vol: vol * 0.5, type: 'bandpass', freq: 1150, q: 0.8, sweep: 0.8 });
}

/** Soft brush stroke on a snare head. */
function brush(dest, t, { vol = 0.07, dur = 0.13, freq = 4200 } = {}) {
  noise(dest, t, { dur, vol, type: 'bandpass', freq, q: 0.7, sweep: 0.55, rate: 0.9 });
}

function seagull(dest, t) {
  const base = rnd(760, 1050);
  const n = 2 + ((Math.random() * 2) | 0);
  for (let i = 0; i < n; i++) {
    const tt = t + i * rnd(0.16, 0.24);
    tone(dest, tt, {
      type: 'triangle', f0: base * rnd(0.92, 1.1), f1: base * 0.62,
      dur: 0.2, glide: 0.19, vol: 0.055, a: 0.02,
    });
  }
}

function birdChirp(dest, t) {
  const base = rnd(1900, 3400);
  const n = 2 + ((Math.random() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const tt = t + i * rnd(0.05, 0.095);
    const f0 = base * rnd(0.85, 1.2);
    const up = chance(0.65);
    tone(dest, tt, {
      type: 'sine', f0, f1: f0 * (up ? rnd(1.25, 1.7) : rnd(0.6, 0.82)),
      dur: 0.052, glide: 0.05, vol: 0.075, a: 0.005,
    });
    tone(dest, tt, {
      type: 'sine', f0: f0 * 2, f1: f0 * 2 * (up ? 1.4 : 0.7),
      dur: 0.045, glide: 0.045, vol: 0.02, a: 0.005,
    });
  }
}

/** A lower, slower two-note call sitting under the chirps. */
function birdWhoop(dest, t) {
  const base = rnd(620, 900);
  const n = 2 + ((Math.random() * 2) | 0);
  for (let i = 0; i < n; i++) {
    const tt = t + i * rnd(0.28, 0.42);
    tone(dest, tt, {
      type: 'sine', f0: base * rnd(0.94, 1.06), f1: base * rnd(1.3, 1.55),
      dur: 0.17, glide: 0.16, vol: 0.05, a: 0.03,
    });
    tone(dest, tt, {
      type: 'triangle', f0: base * 2, f1: base * 2.8, dur: 0.13, glide: 0.13, vol: 0.012, a: 0.03,
    });
  }
}

/** Cave water drip: a bright blip that falls away, built to be reverbed. */
function drip(dest, t, { vol = 0.13, f0 = 1650 } = {}) {
  const f = f0 * rnd(0.8, 1.28);
  tone(dest, t, { type: 'sine', f0: f, f1: f * 0.36, dur: 0.11, glide: 0.1, vol, a: 0.002 });
  tone(dest, t, { type: 'sine', f0: f * 2.02, f1: f * 0.82, dur: 0.05, glide: 0.05, vol: vol * 0.3, a: 0.001 });
  noise(dest, t, { dur: 0.012, vol: vol * 0.22, type: 'highpass', freq: 5200 });
}

/** A pickaxe on rock, heard from another tunnel: metal tink plus falling dust. */
function pickTink(dest, t, { vol = 0.09 } = {}) {
  const f = rnd(2100, 3000);
  tone(dest, t, { type: 'square', f0: f, f1: f * 0.78, dur: 0.035, glide: 0.03, vol: vol * 0.35, a: 0.001 });
  tone(dest, t, { type: 'sine', f0: f * 1.51, dur: 0.06, vol: vol * 0.22, a: 0.001 });
  noise(dest, t, { dur: 0.05, vol: vol * 0.5, type: 'bandpass', freq: 3600, q: 1.2, sweep: 0.45 });
  noise(dest, t, { dur: 0.14, vol: vol * 0.12, type: 'lowpass', freq: 700, sweep: 0.5 });
}

/** Skin-headed hand drum. `mode` is 'bass' (palm), 'tone' (edge) or 'slap'. */
function handDrum(dest, t, mode = 'tone', { vol = 0.2 } = {}) {
  if (mode === 'bass') {
    tone(dest, t, { type: 'sine', f0: 112, f1: 62, dur: 0.26, glide: 0.09, vol, a: 0.004 });
    noise(dest, t, { dur: 0.03, vol: vol * 0.18, type: 'lowpass', freq: 1200 });
  } else if (mode === 'slap') {
    tone(dest, t, { type: 'triangle', f0: 430, f1: 264, dur: 0.07, glide: 0.05, vol: vol * 0.5, a: 0.002 });
    noise(dest, t, { dur: 0.055, vol: vol * 0.72, type: 'bandpass', freq: 2600, q: 0.9, sweep: 0.5 });
  } else {
    tone(dest, t, { type: 'sine', f0: 232, f1: 150, dur: 0.14, glide: 0.07, vol: vol * 0.8, a: 0.003 });
    noise(dest, t, { dur: 0.035, vol: vol * 0.3, type: 'bandpass', freq: 1700, q: 1.1, sweep: 0.6 });
  }
}

/** One log pop in a fire: a tiny click with a puff of ember hiss behind it. */
function crackle(dest, t, { vol = 0.07 } = {}) {
  noise(dest, t, { dur: rnd(0.006, 0.016), vol, type: 'bandpass', freq: rnd(1400, 4200), q: 1.6, rate: 1.3 });
  if (chance(0.4)) noise(dest, t + 0.012, { dur: rnd(0.03, 0.08), vol: vol * 0.35, type: 'highpass', freq: 3600, sweep: 0.6 });
}

/** Whale song: a long moaning glide with vibrato, filtered soft and dark. */
function whaleCall(dest, t, { midi = 45, vol = 0.12, len = 2.8 } = {}) {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.6;
  lp.frequency.setValueAtTime(f * 6, t);
  lp.frequency.linearRampToValueAtTime(f * 2.6, t + len);
  const g = ctx.createGain();
  const peak = Math.max(0.0004, vol);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + len * 0.3);
  g.gain.setValueAtTime(peak, t + len * 0.62);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  lp.connect(g);
  g.connect(dest);

  const vib = ctx.createOscillator();
  vib.type = 'sine';
  vib.frequency.value = rnd(4.2, 6.4);
  const vibAmt = ctx.createGain();
  vibAmt.gain.value = f * 0.014;
  vib.connect(vibAmt);

  for (const [type, mul, amp] of [['sine', 1, 1], ['triangle', 2, 0.2], ['sine', 3.01, 0.07]]) {
    const o = ctx.createOscillator();
    o.type = type;
    const b = f * mul;
    o.frequency.setValueAtTime(b * 0.66, t);
    o.frequency.exponentialRampToValueAtTime(b * 1.16, t + len * 0.3);
    o.frequency.exponentialRampToValueAtTime(b * 0.92, t + len * 0.68);
    o.frequency.exponentialRampToValueAtTime(b * 0.58, t + len);
    vibAmt.connect(o.frequency);
    const og = ctx.createGain();
    og.gain.value = amp;
    o.connect(og); og.connect(lp);
    o.start(t); o.stop(t + len + 0.12);
  }
  vib.start(t);
  vib.stop(t + len + 0.12);
}

// --------------------------------------------------------------- harmony ----

// Chord qualities as semitone offsets from the root. Rhythm arrays below are
// always 16 entries long: one 4/4 bar of sixteenth notes.
const CH = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dom7: [0, 4, 7, 10] };

// -------------------------------------------------------- track scheduling --

function ensureScheduler() {
  if (schedTimer === null) schedTimer = setInterval(tickScheduler, TICK_MS);
}

function tickScheduler() {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i];
    if (tr.deadAt !== null && now >= tr.deadAt) {
      destroyTrack(tr);
      tracks.splice(i, 1);
      continue;
    }
    if (tr.dying) continue; // let queued notes ring out through the fade
    // Backgrounded tabs throttle timers while the audio clock keeps running:
    // skip forward instead of dumping a burst of late notes.
    if (tr.nextTime < now - 0.08) {
      const behind = Math.ceil((now + 0.04 - tr.nextTime) / tr.stepDur);
      tr.step += behind;
      tr.nextTime += behind * tr.stepDur;
    }
    let guard = 0;
    while (tr.nextTime < now + LOOKAHEAD && guard++ < 64) {
      try {
        tr.onStep(tr.nextTime, tr.step);
      } catch {
        tr.dying = true;
        tr.deadAt = now;
        break;
      }
      tr.step++;
      tr.nextTime += tr.stepDur;
    }
  }
  if (!tracks.length && schedTimer !== null) {
    clearInterval(schedTimer);
    schedTimer = null;
  }
}

function destroyTrack(tr) {
  for (const s of tr.sources) {
    try { s.stop(); } catch { /* already stopped */ }
    try { s.disconnect(); } catch { /* noop */ }
  }
  tr.sources.length = 0;
  try { tr.out.disconnect(); } catch { /* noop */ }
  try { tr.send.disconnect(); } catch { /* noop */ }
  try { tr.pan?.disconnect(); } catch { /* noop */ }
}

function startTrack(id) {
  const build = TRACKS[id];
  if (!build || !ctx) return null;
  const t0 = ctx.currentTime;

  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t0);

  const tr = {
    id, out, send: null, pan: null, sources: [], step: 0, nextTime: t0 + 0.14,
    dying: false, deadAt: null, stepDur: 0.125, onStep: () => {},
  };

  // Slow stereo drift so the bed breathes: an LFO wobbles the whole track
  // +-0.15 across ~30-50s. One panner + one oscillator per track, reaped with
  // the track in destroyTrack.
  if (ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0;
    pan.connect(musicBus);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rnd(0.02, 0.034);
    const amt = ctx.createGain();
    amt.gain.value = 0.15;
    lfo.connect(amt); amt.connect(pan.pan);
    lfo.start(t0);
    out.connect(pan);
    tr.pan = pan;
    tr.sources.push(lfo);
  } else {
    out.connect(musicBus);
  }

  const send = ctx.createGain();
  send.gain.value = 0.4;
  send.connect(convolver);
  tr.send = send;

  let spec;
  try {
    spec = build(tr);
  } catch {
    destroyTrack(tr); // a half-built track must not leave running oscillators
    return null;
  }

  tr.stepDur = 60 / spec.bpm / 4;
  tr.onStep = spec.onStep;
  const level = spec.level ?? 1;
  out.gain.linearRampToValueAtTime(level, t0 + CROSSFADE);

  tracks.push(tr);
  ensureScheduler();
  return tr;
}

function fadeOutAll() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const tr of tracks) {
    if (tr.dying) continue;
    tr.dying = true;
    tr.deadAt = t + CROSSFADE + 0.25;
    try {
      tr.out.gain.cancelScheduledValues(t);
      tr.out.gain.setValueAtTime(Math.max(0.0001, tr.out.gain.value), t);
      tr.out.gain.linearRampToValueAtTime(0.0001, t + CROSSFADE);
    } catch { /* noop */ }
  }
  ensureScheduler(); // the interval is what reaps the faded tracks
}

// ================================================================ TRACKS =====

// Null-prototype: a room id that happens to be an Object.prototype key (or a
// dynamic 'house:<owner>' id) must read as "no bed" and fade to silence, never
// as an inherited function that startTrack would try to call.
const TRACKS = Object.create(null);

// ---- Sunny Plaza: bright marimba ostinato, shaker, birdsong ----------------

TRACKS.plaza = (tr) => {
  const bpm = 104;
  const wide = ctx.createGain(); wide.gain.value = 1; wide.connect(tr.out);
  const mall = ctx.createGain(); mall.gain.value = 0.9; mall.connect(wide); mall.connect(tr.send);
  const low = ctx.createGain(); low.gain.value = 0.8; low.connect(tr.out);
  const air = ctx.createGain(); air.gain.value = 1; air.connect(tr.out); air.connect(tr.send);
  const birds = ctx.createGain(); birds.gain.value = 0.9; birds.connect(tr.out); birds.connect(tr.send);

  // I - vi - IV - V in C, one bar each.
  const prog = [
    { root: 60, tones: [60, 64, 67, 71, 72, 76] },
    { root: 57, tones: [57, 60, 64, 67, 72, 76] },
    { root: 53, tones: [53, 57, 60, 65, 69, 72] },
    { root: 55, tones: [55, 59, 62, 67, 71, 74] },
  ];
  const mask = [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1];
  let idx = 0;

  return {
    bpm, level: 1,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;
      const ch = prog[bar % prog.length];

      if (k === 0) idx = (bar % 2) ? 2 : 0;

      if (mask[k]) {
        const n = ch.tones[idx % ch.tones.length] + (chance(0.16) ? 12 : 0);
        idx += chance(0.28) ? 2 : 1;
        marimba(mall, t, n, { vol: k === 0 ? 0.4 : 0.27, dur: k === 0 ? 1.0 : 0.7 });
        if (k === 0 || k === 8) marimba(mall, t, n + 7, { vol: 0.12, dur: 0.5 });
      }

      // rounded sub-bass on the bar and the and-of-3
      if (k === 0) tone(low, t, { type: 'sine', f0: mtof(ch.root - 24), dur: 1.1, vol: 0.34, a: 0.02 });
      if (k === 10) tone(low, t, { type: 'sine', f0: mtof(ch.root - 12), dur: 0.5, vol: 0.16, a: 0.02 });

      // shaker on the offbeat eighths
      if (k % 4 === 2) noise(air, t, { dur: 0.05, vol: 0.05, type: 'highpass', freq: 6800, rate: 1.6 });

      // pad swell under the chord change
      if (k === 0) {
        for (const n of [ch.tones[0] + 12, ch.tones[2] + 12]) {
          tone(wide, t, { type: 'triangle', f0: mtof(n), dur: 2.0, vol: 0.035, a: 0.5 });
        }
      }

      // birdsong: a few chirps per phrase, panned around the plaza
      if (k === 0 && chance(0.5)) {
        birdChirp(panNode(birds, rnd(-0.8, 0.8)), t + rnd(0.1, 1.6));
      }
    },
  };
};

// ---- Driftwood Beach: rolling surf + lazy ukulele ---------------------------

TRACKS.beach = (tr) => {
  const bpm = 74;
  const uke = ctx.createGain(); uke.gain.value = 0.85; uke.connect(tr.out); uke.connect(tr.send);
  const low = ctx.createGain(); low.gain.value = 0.8; low.connect(tr.out);
  const gulls = ctx.createGain(); gulls.gain.value = 1; gulls.connect(tr.out); gulls.connect(tr.send);
  const perc = ctx.createGain(); perc.gain.value = 1; perc.connect(tr.out); perc.connect(tr.send);

  // Persistent surf bed: looping noise -> lowpass, swelled per wave.
  const surfSrc = ctx.createBufferSource();
  surfSrc.buffer = noiseBuf;
  surfSrc.loop = true;
  const surfLp = ctx.createBiquadFilter();
  surfLp.type = 'lowpass';
  surfLp.frequency.value = 480;
  surfLp.Q.value = 0.6;
  const surfHp = ctx.createBiquadFilter();
  surfHp.type = 'highpass';
  surfHp.frequency.value = 120;
  const surfGain = ctx.createGain();
  surfGain.gain.value = 0.05;
  surfSrc.connect(surfLp); surfLp.connect(surfHp); surfHp.connect(surfGain);
  surfGain.connect(tr.out); surfGain.connect(tr.send);
  surfSrc.start(ctx.currentTime, Math.random());
  tr.sources.push(surfSrc);

  const prog = [
    { root: 41, v: [65, 69, 72, 77] },  // F
    { root: 38, v: [62, 65, 69, 74] },  // Dm
    { root: 34, v: [58, 62, 65, 70] },  // Bb
    { root: 36, v: [60, 64, 67, 70] },  // C7
  ];
  const strums = [0, 4, 6, 10, 12, 14];

  function strum(t, voicing, down, vol) {
    const notes = down ? voicing : voicing.slice().reverse();
    notes.forEach((n, i) => {
      pluck(uke, t + i * 0.018, n, { vol: vol * (down ? 1 : 0.7), dur: down ? 1.1 : 0.55, bright: down ? 8 : 6 });
    });
  }

  function wave(t) {
    const len = rnd(3.4, 4.6);
    const peak = rnd(0.16, 0.26);
    surfGain.gain.cancelScheduledValues(t);
    surfGain.gain.setValueAtTime(Math.max(0.001, surfGain.gain.value), t);
    surfGain.gain.linearRampToValueAtTime(peak, t + len * 0.42);
    surfGain.gain.linearRampToValueAtTime(0.045, t + len);
    surfLp.frequency.cancelScheduledValues(t);
    surfLp.frequency.setValueAtTime(360, t);
    surfLp.frequency.linearRampToValueAtTime(rnd(1500, 2400), t + len * 0.45);
    surfLp.frequency.linearRampToValueAtTime(380, t + len);
  }

  return {
    bpm, level: 1,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;
      const ch = prog[bar % prog.length];

      if (k === 0 && bar % 2 === 0) wave(t + rnd(0, 0.4));

      if (strums.includes(k)) {
        const down = k % 4 === 0;
        if (down || chance(0.8)) strum(t, ch.v, down, k === 0 ? 0.2 : 0.13);
      }
      if (k === 0) tone(low, t, { type: 'sine', f0: mtof(ch.root), dur: 1.4, vol: 0.3, a: 0.03 });
      if (k === 8) tone(low, t, { type: 'sine', f0: mtof(ch.root + 7), dur: 0.7, vol: 0.14, a: 0.03 });
      if (k === 6 && chance(0.35)) noise(perc, t, { dur: 0.06, vol: 0.045, type: 'bandpass', freq: 3000, q: 1.2 });
      if (k === 12 && chance(0.25)) noise(perc, t, { dur: 0.09, vol: 0.03, type: 'highpass', freq: 6500, rate: 1.5 });
      if (k === 0 && bar % 4 === 3 && chance(0.45)) {
        seagull(panNode(gulls, rnd(-0.85, 0.85)), t + rnd(0, 1.2));
      }
    },
  };
};

// ---- Frosty Peak: airy pad, sparse music-box bells, wind -------------------

TRACKS.peak = (tr) => {
  const bpm = 60;
  const bells = ctx.createGain(); bells.gain.value = 0.9; bells.connect(tr.out); bells.connect(tr.send);
  const t0 = ctx.currentTime;

  // Wind: looping noise through a slowly wandering bandpass.
  const windSrc = ctx.createBufferSource();
  windSrc.buffer = noiseBuf; windSrc.loop = true;
  const windBp = ctx.createBiquadFilter();
  windBp.type = 'bandpass'; windBp.frequency.value = 620; windBp.Q.value = 1.4;
  const windGain = ctx.createGain(); windGain.gain.value = 0.14;
  windSrc.connect(windBp); windBp.connect(windGain);
  windGain.connect(tr.out); windGain.connect(tr.send);
  const windLfo = ctx.createOscillator();
  windLfo.type = 'sine'; windLfo.frequency.value = 0.055;
  const windLfoAmt = ctx.createGain(); windLfoAmt.gain.value = 380;
  windLfo.connect(windLfoAmt); windLfoAmt.connect(windBp.frequency);
  const gustLfo = ctx.createOscillator();
  gustLfo.type = 'sine'; gustLfo.frequency.value = 0.083;
  const gustAmt = ctx.createGain(); gustAmt.gain.value = 0.075;
  gustLfo.connect(gustAmt); gustAmt.connect(windGain.gain);
  windSrc.start(t0, Math.random());
  windLfo.start(t0); gustLfo.start(t0);
  tr.sources.push(windSrc, windLfo, gustLfo);

  // Pad: persistent detuned voices whose pitches glide between chords.
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass'; padFilter.frequency.value = 1100; padFilter.Q.value = 0.8;
  const padGain = ctx.createGain(); padGain.gain.value = 0.0001;
  padFilter.connect(padGain);
  padGain.connect(tr.out); padGain.connect(tr.send);
  padGain.gain.setValueAtTime(0.0001, t0);
  padGain.gain.linearRampToValueAtTime(0.2, t0 + 4);
  const padLfo = ctx.createOscillator();
  padLfo.type = 'sine'; padLfo.frequency.value = 0.07;
  const padLfoAmt = ctx.createGain(); padLfoAmt.gain.value = 380;
  padLfo.connect(padLfoAmt); padLfoAmt.connect(padFilter.frequency);
  padLfo.start(t0);
  tr.sources.push(padLfo);

  const VOICES = 4;
  const padOsc = [];
  for (let v = 0; v < VOICES; v++) {
    const p = panNode(padFilter, (v / (VOICES - 1)) * 1.4 - 0.7);
    const pair = [];
    for (let d = 0; d < 2; d++) {
      const o = ctx.createOscillator();
      o.type = d ? 'triangle' : 'sawtooth';
      o.detune.value = d ? 7 : -7;
      o.frequency.value = 220;
      const g = ctx.createGain();
      g.gain.value = d ? 0.09 : 0.045;
      o.connect(g); g.connect(p);
      o.start(t0);
      tr.sources.push(o);
      pair.push(o);
    }
    padOsc.push(pair);
  }

  const prog = [
    [57, 64, 71, 76], // Am9
    [53, 60, 69, 76], // Fmaj9
    [55, 64, 71, 76], // Cmaj7/G
    [55, 62, 69, 74], // G6/9
  ];
  const scale = [72, 74, 76, 79, 81, 84, 86, 88];
  let prev = -1;

  return {
    bpm, level: 0.98,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;

      if (k === 0 && bar % 4 === 0) {
        const ch = prog[((bar / 4) | 0) % prog.length];
        ch.forEach((n, i) => {
          const f = mtof(n);
          for (const o of padOsc[i]) o.frequency.setTargetAtTime(f, t, 0.55);
        });
        padGain.gain.cancelScheduledValues(t);
        padGain.gain.setValueAtTime(Math.max(0.001, padGain.gain.value), t);
        padGain.gain.linearRampToValueAtTime(0.24, t + 2.2);
        padGain.gain.linearRampToValueAtTime(0.16, t + 14);
      }

      // Sparse bells; avoid repeating the same note twice in a row.
      if (k % 4 === 0 && chance(k === 0 ? 0.55 : 0.24)) {
        let n = pick(scale);
        if (n === prev) n = pick(scale);
        prev = n;
        bell(panNode(bells, rnd(-0.65, 0.65)), t + rnd(0, 0.12), n, { vol: 0.17, dur: rnd(2.2, 3.4) });
        if (chance(0.3)) bell(bells, t + 0.28, n + pick([3, 4, 5, 7]), { vol: 0.09, dur: 2.0 });
      }
      // distant snow-crunch tick
      if (k === 8 && chance(0.15)) noise(tr.out, t, { dur: 0.07, vol: 0.035, type: 'highpass', freq: 5200, rate: 0.7 });
    },
  };
};

// ---- The Smoothie Shack: swung walking-bass jazz ---------------------------

TRACKS.cafe = (tr) => {
  const bpm = 96;
  const stepDur = 60 / bpm / 4;
  const swing = stepDur * 0.34; // pushes the offbeat eighths late

  const keys = ctx.createGain(); keys.gain.value = 0.9; keys.connect(tr.out); keys.connect(tr.send);
  const bassBus = ctx.createGain(); bassBus.gain.value = 1; bassBus.connect(tr.out);
  const kit = panNode(tr.out, 0.12);
  const kitSend = ctx.createGain(); kitSend.gain.value = 0.5; kitSend.connect(tr.send);

  const prog = [
    { root: 41, q: CH.maj7, v: [57, 60, 64, 65] }, // Fmaj7
    { root: 38, q: CH.m7, v: [57, 60, 62, 65] },   // Dm7
    { root: 43, q: CH.m7, v: [58, 62, 65, 67] },   // Gm7
    { root: 36, q: CH.dom7, v: [58, 60, 64, 67] }, // C7
  ];
  const compMask = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let walk = 41;

  function bassNote(t, midi, dur) {
    const f = mtof(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 6, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(90, f * 2.2), t + 0.14);
    lp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(bassBus);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t);
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.setValueAtTime(f, t);
    const o2g = ctx.createGain(); o2g.gain.value = 0.22;
    o.connect(lp); o2.connect(o2g); o2g.connect(lp);
    o.start(t); o.stop(t + dur + 0.05);
    o2.start(t); o2.stop(t + dur + 0.05);
    noise(bassBus, t, { dur: 0.02, vol: 0.03, type: 'bandpass', freq: 900, q: 1.5 });
  }

  return {
    bpm, level: 1,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;
      const ch = prog[bar % prog.length];
      const next = prog[(bar + 1) % prog.length];
      const st = k % 4 === 2 ? t + swing : t;

      // walking bass, one note per beat, chromatic approach into the next bar
      if (k % 4 === 0) {
        const beat = k / 4;
        let n;
        if (beat === 0) n = ch.root;
        else if (beat === 3) n = next.root + (chance(0.5) ? 1 : -1);
        else n = ch.root + pick(ch.q.slice(1));
        while (n - walk > 8) n -= 12;
        while (walk - n > 8) n += 12;
        n = clamp(n, 28, 50);
        walk = n;
        bassNote(t, n, 0.42);
      }

      // comping: rootless voicings on the pushed offbeats
      if (compMask[k] && chance(0.82)) {
        const spread = chance(0.3);
        ch.v.forEach((n, i) => {
          rhodes(keys, st + i * (spread ? 0.022 : 0.004), n + (i === 3 && chance(0.2) ? 12 : 0), {
            vol: 0.12 - i * 0.012, dur: rnd(1.1, 1.7),
          });
        });
      }
      if (k === 0) {
        ch.v.forEach((n, i) => rhodes(keys, t + i * 0.006, n, { vol: 0.075, dur: 1.9 }));
      }

      // brushed kit: ride pattern on eighths, swirl on the backbeat
      if (k % 4 === 0 || k % 4 === 2) {
        const accent = k === 4 || k === 12;
        brush(kit, st, { vol: accent ? 0.085 : 0.05, dur: accent ? 0.17 : 0.1, freq: accent ? 3400 : 4800 });
        if (accent) brush(kitSend, st, { vol: 0.04, dur: 0.2, freq: 3000 });
      }
      if (k === 8) noise(kit, t, { dur: 0.3, vol: 0.028, type: 'bandpass', freq: 2200, q: 0.5, sweep: 0.5, rate: 0.6 });
      if (k === 0) tone(kit, t, { type: 'sine', f0: 62, dur: 0.22, vol: 0.16, a: 0.004 });
    },
  };
};

// ---- Groove Grotto: 126bpm four-on-the-floor that actually slaps -----------

TRACKS.club = (tr) => {
  const bpm = 126;
  const stepDur = 60 / bpm / 4;

  // Everything melodic runs through the sidechain duck.
  const duck = ctx.createGain();
  duck.gain.value = 1;
  duck.connect(tr.out);

  const drums = ctx.createGain(); drums.gain.value = 1; drums.connect(tr.out);
  const drumVerb = ctx.createGain(); drumVerb.gain.value = 0.28; drumVerb.connect(tr.send);
  const hatsL = panNode(drums, -0.35);
  const hatsR = panNode(drums, 0.32);

  const bassBus = ctx.createGain(); bassBus.gain.value = 1; bassBus.connect(duck);

  const chordFilter = ctx.createBiquadFilter();
  chordFilter.type = 'lowpass';
  chordFilter.Q.value = 7.5;
  chordFilter.frequency.value = 700;
  const chordGain = ctx.createGain(); chordGain.gain.value = 0.55;
  chordFilter.connect(chordGain);
  chordGain.connect(duck);
  const chordSend = ctx.createGain(); chordSend.gain.value = 0.4;
  chordGain.connect(chordSend); chordSend.connect(tr.send);

  // 3/16 ping-pong-ish delay for the lead
  const leadIn = ctx.createGain(); leadIn.gain.value = 1;
  const dly = ctx.createDelay(1.5);
  dly.delayTime.value = stepDur * 3;
  const fb = ctx.createGain(); fb.gain.value = 0.36;
  const dlyLp = ctx.createBiquadFilter();
  dlyLp.type = 'lowpass'; dlyLp.frequency.value = 3200;
  leadIn.connect(dly); dly.connect(dlyLp); dlyLp.connect(fb); fb.connect(dly);
  const dlyOut = ctx.createGain(); dlyOut.gain.value = 0.5;
  dlyLp.connect(dlyOut);
  leadIn.connect(duck); dlyOut.connect(duck); dlyOut.connect(tr.send);

  const prog = [
    { root: 33, tones: [57, 60, 64, 69] }, // Am
    { root: 29, tones: [57, 60, 65, 69] }, // F
    { root: 36, tones: [55, 60, 64, 67] }, // C
    { root: 31, tones: [55, 59, 62, 67] }, // G
  ];
  const bassMask = [1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1];
  const arpSeq = [0, 2, 1, 3, 2, 3, 1, 2];
  let cut = 700;

  function duckHit(t) {
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(0.22, t);
    duck.gain.linearRampToValueAtTime(0.55, t + 0.06);
    duck.gain.linearRampToValueAtTime(1, t + stepDur * 2.6);
  }

  function bassNote(t, midi, dur) {
    const f = mtof(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(1400, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(80, f * 3), t + dur * 0.8);
    lp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.006);
    g.gain.setValueAtTime(0.55, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(bassBus);
    for (const [type, det, amp] of [['sawtooth', 0, 0.6], ['square', -8, 0.3], ['sine', 0, 0.9]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.setValueAtTime(det, t);
      o.frequency.setValueAtTime(type === 'sine' ? f / 2 : f, t);
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  function stab(t, tones, dur) {
    for (const n of tones) {
      for (const det of [-9, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.setValueAtTime(det, t);
        o.frequency.setValueAtTime(mtof(n), t);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.075, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(chordFilter);
        o.start(t); o.stop(t + dur + 0.04);
      }
    }
  }

  function riser(t, dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 4;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    src.connect(bp); bp.connect(g); g.connect(tr.out); g.connect(tr.send);
    src.start(t); src.stop(t + dur + 0.2);
  }

  return {
    bpm, level: 1.3,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;
      const inPhrase = bar % 8;
      const phrase = (bar / 8) | 0;
      const ch = prog[(((bar / 2) | 0) % prog.length)];
      const building = inPhrase === 7;
      const bigPhrase = phrase % 2 === 1;

      // --- filter sweep across a 16-bar cycle
      if (k === 0) {
        const ph = (bar % 16) / 16;
        const nextCut = 380 + 3400 * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
        chordFilter.frequency.cancelScheduledValues(t);
        chordFilter.frequency.setValueAtTime(cut, t);
        chordFilter.frequency.linearRampToValueAtTime(nextCut, t + stepDur * 16);
        cut = nextCut;
        if (building) riser(t, stepDur * 16 * 0.95);
      }

      // --- kick: four on the floor, dropped for the last half-bar of a build
      const kickOn = k % 4 === 0 && !(building && k >= 8);
      if (kickOn) {
        kick(drums, t, { vol: 0.95 });
        duckHit(t);
      }
      if (building && k >= 8 && k % 2 === 0) {
        kick(drums, t, { vol: 0.5 });
        duckHit(t);
      }

      // --- claps / snare on 2 and 4
      if (k === 4 || k === 12) {
        clap(drums, t, { vol: 0.3 });
        clap(drumVerb, t, { vol: 0.12 });
      }
      if (building && k % 2 === 0 && k >= 8) {
        noise(drums, t, { dur: 0.05, vol: 0.14 + (k - 8) * 0.012, type: 'bandpass', freq: 1800, q: 0.9 });
      }

      // --- hats
      if (k % 2 === 0) hat(k % 4 === 2 ? hatsR : hatsL, t, { open: false, vol: k % 4 === 2 ? 0.15 : 0.09 });
      else if (chance(0.45)) hat(hatsR, t, { open: false, vol: 0.045 });
      if (k % 4 === 2 && bigPhrase) hat(hatsL, t, { open: true, vol: 0.075 });
      if (k === 14 && chance(0.3)) hat(hatsR, t, { open: true, vol: 0.06 });

      // --- sidechained bass
      if (bassMask[k] && !(building && k >= 12)) {
        const oct = k % 8 === 0 ? 0 : (chance(0.12) ? 12 : 0);
        bassNote(t, ch.root + oct, stepDur * (k % 4 === 3 ? 0.9 : 1.4));
      }

      // --- chord stabs on the offbeats
      if (k % 4 === 2) stab(t, ch.tones, stepDur * 2.6);
      if (k === 0 && bar % 2 === 0) stab(t, ch.tones.map((n) => n + 12), stepDur * 1.6);

      // --- arp lead through the delay, on the big phrases
      if (bigPhrase && !building && k % 2 === 0) {
        const n = ch.tones[arpSeq[(s / 2) % arpSeq.length]] + 12;
        tone(leadIn, t, { type: 'square', f0: mtof(n), dur: 0.075, vol: 0.075, a: 0.003 });
      }

      // --- crash on phrase downbeats
      if (k === 0 && inPhrase === 0) {
        noise(drums, t, { dur: 1.1, vol: 0.13, type: 'highpass', freq: 5200, sweep: 0.7, rate: 1.2 });
        noise(drumVerb, t, { dur: 1.4, vol: 0.1, type: 'highpass', freq: 4200, sweep: 0.7 });
      }
    },
  };
};

// ---- The Game Den: fireside rhodes, soft nylon pluck, a burning log --------

TRACKS.lounge = (tr) => {
  const bpm = 72;
  const t0 = ctx.currentTime;

  const keys = ctx.createGain(); keys.gain.value = 0.85; keys.connect(tr.out); keys.connect(tr.send);
  const nylon = ctx.createGain(); nylon.gain.value = 0.8; nylon.connect(tr.out); nylon.connect(tr.send);
  const low = ctx.createGain(); low.gain.value = 0.85; low.connect(tr.out);
  const kit = panNode(tr.out, -0.1);
  const fire = ctx.createGain(); fire.gain.value = 1; fire.connect(tr.out);
  const fireSend = ctx.createGain(); fireSend.gain.value = 0.18; fire.connect(fireSend); fireSend.connect(tr.send);

  // The hearth: a low roaring bed under everything, gusting slowly.
  const fireSrc = ctx.createBufferSource();
  fireSrc.buffer = noiseBuf;
  fireSrc.loop = true;
  fireSrc.playbackRate.value = 0.6;
  const fireLp = ctx.createBiquadFilter();
  fireLp.type = 'lowpass'; fireLp.frequency.value = 300; fireLp.Q.value = 0.6;
  const fireGain = ctx.createGain(); fireGain.gain.value = 0.055;
  fireSrc.connect(fireLp); fireLp.connect(fireGain); fireGain.connect(fire);
  const gust = ctx.createOscillator();
  gust.type = 'sine'; gust.frequency.value = 0.071;
  const gustAmt = ctx.createGain(); gustAmt.gain.value = 0.022;
  gust.connect(gustAmt); gustAmt.connect(fireGain.gain);
  fireSrc.start(t0, Math.random());
  gust.start(t0);
  tr.sources.push(fireSrc, gust);

  // Gmaj7 - Em7 - Cmaj7 - D7, one bar each: the slow warm one.
  const prog = [
    { root: 43, v: [59, 62, 66, 71], arp: [55, 62, 66, 71] },
    { root: 40, v: [59, 62, 67, 71], arp: [52, 59, 67, 71] },
    { root: 36, v: [59, 64, 67, 71], arp: [48, 55, 64, 67] },
    { root: 38, v: [57, 62, 66, 69], arp: [50, 57, 62, 66] },
  ];
  const arpMask = [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1];
  let ai = 0;

  return {
    // sparse, slow and mostly decaying: measured on the music bus this bed came
    // out ~12dB under the plaza, so it gets a lift here rather than per voice
    bpm, level: 1.55,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;
      const ch = prog[bar % prog.length];

      // chords: a full one on the bar, a lighter answer half way through
      if (k === 0) {
        ch.v.forEach((n, i) => rhodes(keys, t + i * 0.014, n, { vol: 0.14 - i * 0.014, dur: rnd(1.9, 2.4) }));
      }
      if (k === 8 && chance(0.7)) {
        ch.v.slice(1).forEach((n, i) => rhodes(keys, t + i * 0.02, n, { vol: 0.07, dur: 1.3 }));
      }

      // nylon pluck wandering up and down the voicing
      if (arpMask[k] && chance(0.85)) {
        const n = ch.arp[ai % ch.arp.length] + (chance(0.12) ? 12 : 0);
        ai += chance(0.3) ? 2 : 1;
        pluck(nylon, t, n, { vol: k === 0 ? 0.15 : 0.1, dur: rnd(0.9, 1.4), bright: 6 });
      }

      // the bass is written for the level lift above: 0.19 here lands about
      // where the plaza's sub sits once the track gain is applied
      if (k === 0) tone(low, t, { type: 'sine', f0: mtof(ch.root - 12), dur: 1.5, vol: 0.19, a: 0.03 });
      if (k === 10) tone(low, t, { type: 'sine', f0: mtof(ch.root - 5), dur: 0.6, vol: 0.075, a: 0.03 });

      // the softest possible pulse: a brush on 2 and 4
      if (k === 4 || k === 12) brush(kit, t, { vol: 0.045, dur: 0.14, freq: 3800 });

      // logs popping, in ones and twos
      if (chance(0.14)) {
        const p = panNode(fire, rnd(-0.55, 0.55));
        crackle(p, t + rnd(0, 0.2), { vol: rnd(0.035, 0.085) });
        if (chance(0.35)) crackle(p, t + rnd(0.06, 0.3), { vol: rnd(0.02, 0.05) });
      }
      // a log settling in the grate
      if (k === 0 && bar % 8 === 5 && chance(0.4)) {
        tone(fire, t, { type: 'sine', f0: 96, f1: 58, dur: 0.3, glide: 0.2, vol: 0.07, a: 0.01 });
        for (let i = 0; i < 5; i++) crackle(fire, t + 0.05 + i * rnd(0.03, 0.09), { vol: rnd(0.03, 0.07) });
      }
    },
  };
};

// ---- The Glimmer Mine: tunnel drips, deep music box, a very low drone ------

TRACKS.mine = (tr) => {
  const bpm = 52;
  const t0 = ctx.currentTime;

  // Anything that happens down here answers itself: a long filtered delay
  // feeding the shared reverb is the whole character of the room.
  const cave = ctx.createGain(); cave.gain.value = 1;
  const dly = ctx.createDelay(2);
  dly.delayTime.value = 0.47;
  const fb = ctx.createGain(); fb.gain.value = 0.4;
  const dlyLp = ctx.createBiquadFilter();
  dlyLp.type = 'lowpass'; dlyLp.frequency.value = 2100;
  cave.connect(dly); dly.connect(dlyLp); dlyLp.connect(fb); fb.connect(dly);
  const echo = ctx.createGain(); echo.gain.value = 0.5;
  dlyLp.connect(echo);
  cave.connect(tr.out); cave.connect(tr.send);
  echo.connect(tr.out); echo.connect(tr.send);

  const boxes = ctx.createGain(); boxes.gain.value = 0.9; boxes.connect(tr.out); boxes.connect(tr.send);
  const low = ctx.createGain(); low.gain.value = 1; low.connect(tr.out);

  // Cave air: a lowpassed hiss so the silence is never digital silence.
  const airSrc = ctx.createBufferSource();
  airSrc.buffer = noiseBuf; airSrc.loop = true; airSrc.playbackRate.value = 0.5;
  const airLp = ctx.createBiquadFilter();
  airLp.type = 'lowpass'; airLp.frequency.value = 270; airLp.Q.value = 0.5;
  const airGain = ctx.createGain(); airGain.gain.value = 0.035;
  airSrc.connect(airLp); airLp.connect(airGain); airGain.connect(tr.out);
  airSrc.start(t0, Math.random());
  tr.sources.push(airSrc);

  // The drone: sub sine plus two quiet partials, breathing on a slow LFO.
  // Level checked against the plaza bed on the real music bus: a continuous
  // 35-40Hz tone reads quiet but measures LOUD, so this stays deliberately
  // low (0.085 puts the settled mine bed just under the plaza's RMS).
  const droneGain = ctx.createGain(); droneGain.gain.value = 0.0001;
  droneGain.connect(low);
  droneGain.gain.setValueAtTime(0.0001, t0);
  droneGain.gain.linearRampToValueAtTime(0.085, t0 + 5);
  const droneOsc = [];
  for (const [type, mul, amp] of [['sine', 1, 1], ['sine', 2, 0.3], ['triangle', 3.01, 0.07]]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = mtof(26) * mul;
    const g = ctx.createGain(); g.gain.value = amp;
    o.connect(g); g.connect(droneGain);
    o.start(t0);
    tr.sources.push(o);
    droneOsc.push({ o, mul });
  }
  const breath = ctx.createOscillator();
  breath.type = 'sine'; breath.frequency.value = 0.043;
  const breathAmt = ctx.createGain(); breathAmt.gain.value = 0.028;
  breath.connect(breathAmt); breathAmt.connect(droneGain.gain);
  breath.start(t0);
  tr.sources.push(breath);

  const ROOTS = [26, 26, 24, 22];       // D, D, C, Bb: eight bars each
  const scale = [50, 53, 55, 57, 60, 62, 65]; // D minor pentatonic + the 4th
  let prev = -1;

  return {
    bpm, level: 0.92,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;

      if (k === 0 && bar % 8 === 0) {
        const root = ROOTS[((bar / 8) | 0) % ROOTS.length];
        for (const d of droneOsc) d.o.frequency.setTargetAtTime(mtof(root) * d.mul, t, 1.7);
      }

      // deep music-box notes, never the same note twice in a row
      if (k % 8 === 0 && chance(k === 0 ? 0.5 : 0.22)) {
        let n = pick(scale);
        if (n === prev) n = pick(scale);
        prev = n;
        bell(panNode(boxes, rnd(-0.5, 0.5)), t, n, { vol: 0.15, dur: rnd(2.6, 3.8) });
        if (chance(0.4)) bell(boxes, t + rnd(0.5, 0.95), n + pick([-5, 3, 7]), { vol: 0.075, dur: 2.3 });
      }

      // drips, wide and rare, each one answered by the tunnel
      if (chance(0.06)) drip(panNode(cave, rnd(-0.9, 0.9)), t + rnd(0, 0.2), { vol: rnd(0.08, 0.15) });

      // somebody working two galleries over: a short run of tinks
      if (k === 4 && chance(0.26)) {
        const p = panNode(cave, rnd(-0.85, 0.85));
        const n = 2 + ((Math.random() * 3) | 0);
        for (let i = 0; i < n; i++) pickTink(p, t + i * rnd(0.34, 0.5), { vol: rnd(0.045, 0.085) });
      }

      // a cart rolling somewhere below
      if (k === 8 && bar % 4 === 2 && chance(0.35)) {
        noise(low, t, { dur: 1.5, vol: 0.04, type: 'lowpass', freq: 230, q: 0.7, sweep: 1.7, rate: 0.5, a: 0.4 });
      }
    },
  };
};

// ---- The Tangle Jungle: birdsong layers, hand drums, marimba phrases -------

TRACKS.jungle = (tr) => {
  const bpm = 92;
  const t0 = ctx.currentTime;

  const mall = ctx.createGain(); mall.gain.value = 0.85; mall.connect(tr.out); mall.connect(tr.send);
  const drums = ctx.createGain(); drums.gain.value = 1; drums.connect(tr.out);
  const drumSend = ctx.createGain(); drumSend.gain.value = 0.26; drums.connect(drumSend); drumSend.connect(tr.send);
  const low = ctx.createGain(); low.gain.value = 0.85; low.connect(tr.out);
  const birds = ctx.createGain(); birds.gain.value = 1; birds.connect(tr.out); birds.connect(tr.send);
  const air = ctx.createGain(); air.gain.value = 1; air.connect(tr.out); air.connect(tr.send);

  // Canopy: leaves and the far side of the waterfall, wandering slowly.
  const leafSrc = ctx.createBufferSource();
  leafSrc.buffer = noiseBuf; leafSrc.loop = true; leafSrc.playbackRate.value = 1.15;
  const leafBp = ctx.createBiquadFilter();
  leafBp.type = 'bandpass'; leafBp.frequency.value = 1500; leafBp.Q.value = 0.8;
  const leafGain = ctx.createGain(); leafGain.gain.value = 0.03;
  leafSrc.connect(leafBp); leafBp.connect(leafGain); leafGain.connect(tr.out);
  const leafLfo = ctx.createOscillator();
  leafLfo.type = 'sine'; leafLfo.frequency.value = 0.061;
  const leafAmt = ctx.createGain(); leafAmt.gain.value = 700;
  leafLfo.connect(leafAmt); leafAmt.connect(leafBp.frequency);
  const swayLfo = ctx.createOscillator();
  swayLfo.type = 'sine'; swayLfo.frequency.value = 0.037;
  const swayAmt = ctx.createGain(); swayAmt.gain.value = 0.014;
  swayLfo.connect(swayAmt); swayAmt.connect(leafGain.gain);
  leafSrc.start(t0, Math.random());
  leafLfo.start(t0); swayLfo.start(t0);
  tr.sources.push(leafSrc, leafLfo, swayLfo);

  // E dorian vamp: Em7 - Em7 - A7 - G6, one bar each.
  const prog = [
    { root: 40, tones: [64, 67, 71, 74, 76, 79] },
    { root: 40, tones: [64, 66, 71, 74, 76, 81] },
    { root: 45, tones: [64, 69, 73, 76, 81, 85] },
    { root: 43, tones: [62, 67, 71, 74, 79, 83] },
  ];
  const mask = [1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0];
  const dBass = [0, 6, 10];
  const dTone = [4, 12];
  const dSlap = [3, 7, 11, 14];
  let idx = 0;

  return {
    bpm, level: 1,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;
      const ch = prog[bar % prog.length];

      if (k === 0) idx = (bar % 2) ? 1 : 0;

      // marimba phrases, walking through the voicing
      if (mask[k]) {
        const n = ch.tones[idx % ch.tones.length];
        idx += chance(0.3) ? 2 : 1;
        marimba(mall, t, n, { vol: k === 0 ? 0.34 : 0.22, dur: k === 0 ? 0.9 : 0.6 });
        if (k === 0) marimba(mall, t, n - 12, { vol: 0.11, dur: 0.7 });
      }

      // hand drums: palm on the pulse, edge on the backbeat, ghost slaps
      if (dBass.includes(k)) handDrum(drums, t, 'bass', { vol: k === 0 ? 0.22 : 0.15 });
      if (dTone.includes(k)) handDrum(drums, t, 'tone', { vol: 0.17 });
      if (dSlap.includes(k) && chance(0.55)) handDrum(drums, t, 'slap', { vol: rnd(0.05, 0.1) });
      // seed-pod shaker on the offbeat sixteenths
      if (k % 4 === 1 || k % 4 === 3) {
        noise(air, t, { dur: 0.04, vol: k % 4 === 3 ? 0.045 : 0.026, type: 'highpass', freq: 6200, rate: 1.7 });
      }

      if (k === 0) tone(low, t, { type: 'sine', f0: mtof(ch.root - 12), dur: 1.1, vol: 0.3, a: 0.02 });
      if (k === 11) tone(low, t, { type: 'sine', f0: mtof(ch.root - 5), dur: 0.4, vol: 0.12, a: 0.02 });

      // birdsong in layers: near chirps, far chirps, the occasional low call
      if (k === 0 && chance(0.6)) birdChirp(panNode(birds, rnd(-0.85, 0.85)), t + rnd(0.05, 1.2));
      if (k === 8 && chance(0.4)) birdChirp(panNode(birds, rnd(-0.9, 0.9)), t + rnd(0, 0.9));
      if (k === 0 && bar % 4 === 3 && chance(0.45)) birdWhoop(panNode(birds, rnd(-0.7, 0.7)), t + rnd(0, 1.4));
      // insects, way up in the leaves
      if (k === 6 && bar % 2 === 1 && chance(0.3)) {
        const p = panNode(air, rnd(-0.9, 0.9));
        const n = 6 + ((Math.random() * 5) | 0);
        for (let i = 0; i < n; i++) {
          noise(p, t + i * 0.035, { dur: 0.02, vol: 0.02, type: 'bandpass', freq: rnd(6400, 7800), q: 5, rate: 1.8 });
        }
      }
    },
  };
};

// ---- The Drift: whale song over sub-bass pads and watery shimmer -----------

TRACKS.drift = (tr) => {
  const bpm = 44;
  const t0 = ctx.currentTime;

  const song = ctx.createGain(); song.gain.value = 0.9; song.connect(tr.out); song.connect(tr.send);
  const spark = ctx.createGain(); spark.gain.value = 0.8; spark.connect(tr.out); spark.connect(tr.send);

  // Shimmer: light on water, a bandpassed hiss drifting over a slow LFO.
  const shSrc = ctx.createBufferSource();
  shSrc.buffer = noiseBuf; shSrc.loop = true; shSrc.playbackRate.value = 1.3;
  const shBp = ctx.createBiquadFilter();
  shBp.type = 'bandpass'; shBp.frequency.value = 1700; shBp.Q.value = 1.3;
  const shGain = ctx.createGain(); shGain.gain.value = 0.032;
  shSrc.connect(shBp); shBp.connect(shGain);
  shGain.connect(tr.out); shGain.connect(tr.send);
  const shLfo = ctx.createOscillator();
  shLfo.type = 'sine'; shLfo.frequency.value = 0.048;
  const shAmt = ctx.createGain(); shAmt.gain.value = 900;
  shLfo.connect(shAmt); shAmt.connect(shBp.frequency);
  const tideLfo = ctx.createOscillator();
  tideLfo.type = 'sine'; tideLfo.frequency.value = 0.029;
  const tideAmt = ctx.createGain(); tideAmt.gain.value = 0.016;
  tideLfo.connect(tideAmt); tideAmt.connect(shGain.gain);
  shSrc.start(t0, Math.random());
  shLfo.start(t0); tideLfo.start(t0);
  tr.sources.push(shSrc, shLfo, tideLfo);

  // Pad: four detuned voices gliding between chords, plus a sub under the root.
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass'; padFilter.frequency.value = 620; padFilter.Q.value = 0.9;
  const padGain = ctx.createGain(); padGain.gain.value = 0.0001;
  padFilter.connect(padGain);
  padGain.connect(tr.out); padGain.connect(tr.send);
  padGain.gain.setValueAtTime(0.0001, t0);
  padGain.gain.linearRampToValueAtTime(0.22, t0 + 6);
  const padLfo = ctx.createOscillator();
  padLfo.type = 'sine'; padLfo.frequency.value = 0.041;
  const padLfoAmt = ctx.createGain(); padLfoAmt.gain.value = 240;
  padLfo.connect(padLfoAmt); padLfoAmt.connect(padFilter.frequency);
  padLfo.start(t0);
  tr.sources.push(padLfo);

  const VOICES = 4;
  const padOsc = [];
  for (let v = 0; v < VOICES; v++) {
    const p = panNode(padFilter, (v / (VOICES - 1)) * 1.3 - 0.65);
    const pair = [];
    for (let d = 0; d < 2; d++) {
      const o = ctx.createOscillator();
      o.type = d ? 'sine' : 'triangle';
      o.detune.value = d ? 9 : -9;
      o.frequency.value = 110;
      const g = ctx.createGain();
      g.gain.value = d ? 0.075 : 0.05;
      o.connect(g); g.connect(p);
      o.start(t0);
      tr.sources.push(o);
      pair.push(o);
    }
    padOsc.push(pair);
  }

  // same rule as the mine drone: sub energy measures far louder than it sounds
  const subGain = ctx.createGain(); subGain.gain.value = 0.08; subGain.connect(tr.out);
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = mtof(26);
  sub.connect(subGain);
  sub.start(t0);
  tr.sources.push(sub);

  // Dm - Bb - F - C, very slow: two bars each (about 22 seconds a chord).
  const prog = [
    [38, 45, 50, 57],
    [34, 41, 46, 53],
    [41, 48, 53, 60],
    [36, 43, 48, 55],
  ];
  const glints = [84, 86, 89, 91, 93];

  return {
    bpm, level: 0.86,
    onStep(t, s) {
      const bar = (s / 16) | 0;
      const k = s % 16;

      if (k === 0 && bar % 2 === 0) {
        const ch = prog[(((bar / 2) | 0) % prog.length)];
        ch.forEach((n, i) => {
          const f = mtof(n);
          for (const o of padOsc[i]) o.frequency.setTargetAtTime(f, t, 2.2);
        });
        sub.frequency.setTargetAtTime(mtof(ch[0] - 12), t, 2.4);
        padGain.gain.cancelScheduledValues(t);
        padGain.gain.setValueAtTime(Math.max(0.001, padGain.gain.value), t);
        padGain.gain.linearRampToValueAtTime(0.26, t + 4.5);
        padGain.gain.linearRampToValueAtTime(0.18, t + 16);
      }

      // Big Blue, somewhere out in the blue
      if (k === 0 && bar % 4 === 1 && chance(0.6)) {
        const ch = prog[(((bar / 2) | 0) % prog.length)];
        whaleCall(panNode(song, rnd(-0.5, 0.5)), t + rnd(0.2, 2.4), {
          midi: ch[0] + pick([0, 7, 12]),
          vol: rnd(0.075, 0.12), len: rnd(2.6, 4.2),
        });
      }
      if (k === 8 && bar % 8 === 6 && chance(0.35)) {
        whaleCall(panNode(song, rnd(-0.8, 0.8)), t + rnd(0, 1.5), { midi: 33, vol: 0.06, len: rnd(3.4, 5) });
      }

      // glints of light, high and quiet
      if (k % 4 === 0 && chance(0.16)) {
        bell(panNode(spark, rnd(-0.85, 0.85)), t + rnd(0, 0.6), pick(glints), { vol: 0.04, dur: rnd(2.4, 4) });
      }
      // a string of bubbles rising past you
      if (chance(0.035)) {
        const p = panNode(spark, rnd(-0.9, 0.9));
        const n = 2 + ((Math.random() * 3) | 0);
        for (let i = 0; i < n; i++) {
          const f = rnd(420, 760);
          tone(p, t + i * rnd(0.07, 0.16), { type: 'sine', f0: f, f1: f * 2.3, dur: 0.075, vol: 0.035, a: 0.004 });
        }
      }
    },
  };
};

// ==================================================================== SFX ====

let comboN = 0;
let comboAt = -99;
let coinStreak = 0;
let coinAt = -99;
// Semitone offsets up the major scale for coin streaks (3rd coin onward).
const COIN_LADDER = [2, 4, 5, 7, 9, 11, 12, 14, 16, 17];
const lastPlayed = Object.create(null);
const MIN_GAP = { step: 0.075, click: 0.022, tick: 0.018, hover: 0.05, coin: 0.028, pop: 0.028 };

// Sounds that want to ring out in the room rather than sit in the player's face.
const WET_SFX = new Set(['ding', 'chime', 'success', 'levelup', 'unlock', 'sparkle', 'buy']);

// Chat-adjacent notifications duck the music bed -6dB for a beat so the ping
// reads clearly over whatever the room is playing.
const DUCK_SFX = new Set(['pop', 'ding', 'chime']);

// ------------------------------------------------------------- footsteps ----

// Which ground a room puts underfoot. Dynamic 'house:<owner>' rooms are wood
// (handled in roomSurfaceKey); anything unknown falls back to stone.
const STEP_SURFACE = {
  cafe: 'wood', lounge: 'wood', house: 'wood',
  beach: 'sand',
  peak: 'snow',
  mine: 'stone', club: 'stone', drift: 'stone',
  plaza: 'grass', jungle: 'grass',
};

function roomSurfaceKey() {
  if (!currentRoom) return 'plaza';
  return currentRoom.startsWith('house:') ? 'house' : currentRoom;
}

let stepSide = 0; // alternates L/R per step

// One short voice per surface: a body tone plus a filtered noise burst,
// everything scaled by the per-step pitch factor `p`.
const STEP_VOICES = {
  wood(d, t, p) {
    tone(d, t, { type: 'sine', f0: 155 * p, f1: 82 * p, dur: 0.07, vol: 0.13, a: 0.003 });
    noise(d, t, { dur: 0.045, vol: 0.055, type: 'bandpass', freq: 1150 * p, q: 1.3, sweep: 0.55, rate: 0.85 });
  },
  sand(d, t, p) {
    tone(d, t, { type: 'sine', f0: 108 * p, f1: 66 * p, dur: 0.06, vol: 0.075, a: 0.004 });
    noise(d, t, { dur: 0.095, vol: 0.07, type: 'lowpass', freq: 1600 * p, q: 0.7, sweep: 0.4, rate: 0.72 });
    noise(d, t + 0.035, { dur: 0.045, vol: 0.03, type: 'bandpass', freq: 2400 * p, q: 1, sweep: 0.6, rate: 0.8 });
  },
  snow(d, t, p) {
    tone(d, t, { type: 'sine', f0: 125 * p, f1: 72 * p, dur: 0.06, vol: 0.085, a: 0.004 });
    noise(d, t, { dur: 0.08, vol: 0.08, type: 'bandpass', freq: 2300 * p, q: 0.8, sweep: 0.5, rate: 1.05 });
    noise(d, t + 0.022, { dur: 0.035, vol: 0.045, type: 'bandpass', freq: 3100 * p, q: 1.2, sweep: 0.55, rate: 1.2 });
  },
  stone(d, t, p) {
    tone(d, t, { type: 'sine', f0: 165 * p, f1: 84 * p, dur: 0.055, vol: 0.11, a: 0.002 });
    noise(d, t, { dur: 0.032, vol: 0.06, type: 'bandpass', freq: 2500 * p, q: 1.4, sweep: 0.6 });
    noise(d, t, { dur: 0.012, vol: 0.025, type: 'highpass', freq: 5200 });
  },
  grass(d, t, p) {
    tone(d, t, { type: 'sine', f0: 118 * p, f1: 70 * p, dur: 0.06, vol: 0.095, a: 0.004 });
    noise(d, t, { dur: 0.065, vol: 0.05, type: 'bandpass', freq: 1900 * p, q: 0.9, sweep: 0.6, rate: 1.15 });
  },
};

const SFX = {
  click(d, t) {
    tone(d, t, { type: 'triangle', f0: rnd(880, 940), f1: 660, dur: 0.045, vol: 0.22, a: 0.002 });
    tone(d, t, { type: 'sine', f0: 1760, dur: 0.03, vol: 0.09, a: 0.001 });
    noise(d, t, { dur: 0.014, vol: 0.06, type: 'highpass', freq: 3800 });
  },
  hover(d, t) {
    tone(d, t, { type: 'sine', f0: 1500, f1: 1900, dur: 0.045, vol: 0.06, a: 0.003 });
  },
  tick(d, t) {
    noise(d, t, { dur: 0.012, vol: 0.09, type: 'highpass', freq: 5200 });
    tone(d, t, { type: 'square', f0: 2400, dur: 0.015, vol: 0.04, a: 0.001 });
  },
  step(d, t, surface) {
    // Alternate the persistent L/R panners so a walk cycle sways; fall back to
    // the plain dry bus if StereoPannerNode is unavailable.
    stepSide ^= 1;
    const out = stepPans ? stepPans[stepSide] : d;
    const p = rnd(0.92, 1.1); // subtle per-step pitch variance
    const fn = STEP_VOICES[surface] || STEP_VOICES[STEP_SURFACE[roomSurfaceKey()] || 'stone'];
    fn(out, t, p);
  },
  jump(d, t) {
    tone(d, t, { type: 'triangle', f0: 320, f1: 780, dur: 0.13, vol: 0.16, a: 0.004 });
    noise(d, t, { dur: 0.08, vol: 0.05, type: 'highpass', freq: 1800, sweep: 2.2 });
  },
  land(d, t) {
    tone(d, t, { type: 'sine', f0: 190, f1: 62, dur: 0.16, vol: 0.24, a: 0.003 });
    noise(d, t, { dur: 0.09, vol: 0.09, type: 'lowpass', freq: 1400, sweep: 0.35 });
  },
  thud(d, t) {
    tone(d, t, { type: 'sine', f0: 150, f1: 44, dur: 0.26, vol: 0.3, a: 0.003 });
    noise(d, t, { dur: 0.1, vol: 0.08, type: 'lowpass', freq: 700, sweep: 0.4 });
  },
  coin(d, t) {
    // Streak stinger: 3+ coins within 2s of each other walk the pickup up the
    // major scale, so a run of coins turns into a little ascending melody.
    if (t - coinAt > 2) coinStreak = 0;
    coinAt = t;
    coinStreak++;
    const up = coinStreak >= 3 ? COIN_LADDER[Math.min(coinStreak - 3, COIN_LADDER.length - 1)] : 0;
    const base = 1046.5 * Math.pow(2, up / 12);
    tone(d, t, { type: 'square', f0: base, dur: 0.06, vol: 0.09, a: 0.002 });
    tone(d, t + 0.058, { type: 'square', f0: base * 1.5, dur: 0.16, vol: 0.085, a: 0.002 });
    tone(d, t + 0.058, { type: 'sine', f0: base * 3, dur: 0.2, vol: 0.045, a: 0.002 });
    noise(d, t, { dur: 0.03, vol: 0.045, type: 'highpass', freq: 6000 });
    if (up >= 12) bell(sfxWet, t + 0.06, 96 + (up - 12), { vol: 0.07, dur: 1.2 }); // topped out: a glint
  },
  buy(d, t) {
    SFX.coin(d, t);
    bell(d, t + 0.14, 88, { vol: 0.11, dur: 1.4 });
  },
  unlock(d, t) {
    noise(d, t, { dur: 0.3, vol: 0.07, type: 'bandpass', freq: 900, q: 3, sweep: 7 });
    [76, 81, 88].forEach((n, i) => bell(d, t + 0.16 + i * 0.075, n, { vol: 0.12, dur: 1.5 }));
  },
  splash(d, t) {
    noise(d, t, { dur: 0.34, vol: 0.22, type: 'lowpass', freq: 2600, q: 0.7, sweep: 0.16 });
    noise(d, t, { dur: 0.12, vol: 0.13, type: 'highpass', freq: 2200, sweep: 2.4 });
    tone(d, t + 0.02, { type: 'sine', f0: 520, f1: 190, dur: 0.22, vol: 0.1, a: 0.004 });
    for (let i = 0; i < 3; i++) {
      const tt = t + 0.09 + i * rnd(0.05, 0.1);
      tone(d, tt, { type: 'sine', f0: rnd(500, 900), f1: rnd(1100, 1700), dur: 0.06, vol: 0.05, a: 0.004 });
    }
  },
  bubble(d, t) {
    const f = rnd(380, 680);
    tone(d, t, { type: 'sine', f0: f, f1: f * 2.6, dur: 0.09, vol: 0.14, a: 0.004 });
    noise(d, t + 0.08, { dur: 0.02, vol: 0.04, type: 'highpass', freq: 4000 });
  },
  whoosh(d, t) {
    noise(d, t, { dur: 0.34, vol: 0.16, type: 'bandpass', freq: 380, q: 1.1, sweep: 7, a: 0.09 });
    noise(d, t + 0.16, { dur: 0.26, vol: 0.1, type: 'bandpass', freq: 2600, q: 1.4, sweep: 0.24 });
    tone(d, t, { type: 'sine', f0: 150, f1: 420, dur: 0.3, vol: 0.05, a: 0.06 });
  },
  slide(d, t) {
    noise(d, t, { dur: 0.5, vol: 0.09, type: 'bandpass', freq: 1800, q: 1.6, sweep: 0.5, a: 0.12, rate: 0.7 });
  },
  open(d, t) {
    noise(d, t, { dur: 0.18, vol: 0.07, type: 'bandpass', freq: 700, q: 1.2, sweep: 4 });
    tone(d, t, { type: 'triangle', f0: 520, f1: 880, dur: 0.13, vol: 0.11, a: 0.004 });
  },
  close(d, t) {
    noise(d, t, { dur: 0.16, vol: 0.06, type: 'bandpass', freq: 2600, q: 1.2, sweep: 0.25 });
    tone(d, t, { type: 'triangle', f0: 720, f1: 380, dur: 0.11, vol: 0.1, a: 0.004 });
  },
  pop(d, t) {
    tone(d, t, { type: 'sine', f0: 380, f1: 1500, dur: 0.055, vol: 0.24, a: 0.002 });
    noise(d, t, { dur: 0.02, vol: 0.07, type: 'highpass', freq: 3200 });
  },
  ding(d, t) {
    bell(d, t, 88, { vol: 0.2, dur: 1.9 });
  },
  sparkle(d, t) {
    const notes = [84, 88, 91, 96, 100];
    for (let i = 0; i < 5; i++) {
      tone(d, t + i * rnd(0.035, 0.07), {
        type: 'sine', f0: mtof(pick(notes)), dur: rnd(0.12, 0.26), vol: 0.06, a: 0.004,
      });
    }
  },
  combo(d, t) {
    if (t - comboAt > 1.7) comboN = 0;
    comboAt = t;
    const n = 72 + Math.min(comboN, 14) * 2;
    comboN++;
    tone(d, t, { type: 'triangle', f0: mtof(n), dur: 0.12, vol: 0.16, a: 0.003 });
    tone(d, t, { type: 'sine', f0: mtof(n + 12), dur: 0.16, vol: 0.07, a: 0.003 });
    noise(d, t, { dur: 0.03, vol: 0.05, type: 'highpass', freq: 5000 });
  },
  success(d, t) {
    const arp = [72, 76, 79, 84];
    arp.forEach((n, i) => {
      const tt = t + i * 0.075;
      tone(d, tt, { type: 'triangle', f0: mtof(n), dur: 0.26, vol: 0.16, a: 0.004 });
      tone(d, tt, { type: 'sine', f0: mtof(n + 12), dur: 0.2, vol: 0.05, a: 0.004 });
    });
    bell(d, t + 0.3, 91, { vol: 0.13, dur: 1.9 });
    noise(d, t + 0.3, { dur: 0.4, vol: 0.035, type: 'highpass', freq: 6000, sweep: 0.6 });
  },
  levelup(d, t) {
    const arp = [60, 64, 67, 72, 76, 79, 84];
    arp.forEach((n, i) => {
      tone(d, t + i * 0.06, { type: 'square', f0: mtof(n), dur: 0.14, vol: 0.08, a: 0.003 });
    });
    [84, 88, 91].forEach((n, i) => bell(d, t + 0.42 + i * 0.02, n, { vol: 0.13, dur: 2.4 }));
  },
  fail(d, t) {
    [64, 60, 55].forEach((n, i) => {
      const tt = t + i * 0.12;
      const f = mtof(n);
      tone(d, tt, { type: 'sawtooth', f0: f, dur: 0.22, vol: 0.09, a: 0.006, detune: -12 });
      tone(d, tt, { type: 'sawtooth', f0: f * 0.997, dur: 0.22, vol: 0.07, a: 0.006, detune: 10 });
    });
    tone(d, t + 0.34, { type: 'sine', f0: 130, f1: 62, dur: 0.4, vol: 0.16, a: 0.01 });
    noise(d, t + 0.34, { dur: 0.2, vol: 0.05, type: 'lowpass', freq: 900, sweep: 0.3 });
  },
};

SFX.error = SFX.fail;
SFX.select = SFX.click;
SFX.chime = SFX.ding;
SFX.catch = SFX.pop;

/** Pull the music bed down ~6dB for a beat, then ease it back. Reuses the one
 *  musicBus gain param: no nodes are created. */
function duckMusic(t) {
  if (!musicBus) return;
  const g = musicBus.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(Math.max(0.0001, g.value), t);
  g.linearRampToValueAtTime(MUSIC_LEVEL * 0.5, t + 0.05);
  g.setValueAtTime(MUSIC_LEVEL * 0.5, t + 0.35);
  g.linearRampToValueAtTime(MUSIC_LEVEL, t + 0.9);
}

// -------------------------------------------------------- room-enter chord --

// A gentle ~0.8s arrival chord per room, voiced in that bed's own key so it
// resolves straight into the music that is fading up underneath it.
const ROOM_CHORDS = {
  plaza: [60, 64, 67, 72],  // C
  beach: [53, 60, 65, 69],  // F
  peak: [57, 64, 71, 76],   // Am9
  cafe: [53, 60, 64, 69],   // Fmaj7
  club: [57, 60, 64, 67],   // Am7
  lounge: [55, 62, 66, 71], // Gmaj7
  mine: [50, 57, 62, 65],   // Dm
  jungle: [52, 59, 64, 67], // Em7
  drift: [50, 57, 62, 66],  // Dmadd9-ish, watery
};

function roomChord(id) {
  if (muted || !ctx) return;
  const chord = ROOM_CHORDS[id];
  if (!chord) return;
  const t = ctx.currentTime + 0.06;
  try {
    chord.forEach((n, i) => {
      rhodes(sfxWet, t + i * 0.035, n, { vol: 0.085 - i * 0.012, dur: 0.8 });
    });
    bell(sfxWet, t + 0.12, chord[chord.length - 1] + 12, { vol: 0.045, dur: 1.1 });
  } catch { /* an arrival flourish must never block the room switch */ }
}

// ================================================================= PUBLIC ====

export const audio = {
  get muted() { return muted; },

  /** Create the audio graph. Safe to call more than once. */
  init() {
    ensure();
  },

  /** Fire a one-shot sound effect. Unknown names are ignored. The optional
   *  second argument is sfx-specific ('step' takes a surface name). */
  play(name, arg) {
    if (muted) return;
    if (!ensure()) return;
    const fn = SFX[name];
    if (!fn) return;
    const t = ctx.currentTime;
    const gap = MIN_GAP[name] ?? 0.012;
    if (t - (lastPlayed[name] ?? -99) < gap) return;
    lastPlayed[name] = t;
    try {
      fn(WET_SFX.has(name) ? sfxWet : sfxDry, t + 0.001, arg);
      if (DUCK_SFX.has(name)) duckMusic(t);
    } catch { /* a dropped sfx must never break gameplay */ }
  },

  /** Crossfade the generative music bed to the given room's mood. An id with
   *  no bed (a dynamic 'house:<owner>' room, a typo, anything at all) just
   *  fades the current one out and plays nothing: never throws, never warns. */
  setRoom(roomId) {
    const id = roomId || null;
    if (id === currentRoom && tracks.some((t) => !t.dying && t.id === id)) return;
    const changed = id !== currentRoom;
    currentRoom = id;
    if (!ctx) return; // init() will start it
    fadeOutAll();
    if (id && TRACKS[id]) startTrack(id);
    if (changed) roomChord(id);
  },

  /** Instant kill / restore of all output. Returns the new muted state. */
  toggleMute() {
    muted = !muted;
    if (master && ctx) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(muted ? 0 : MASTER_LEVEL, t);
    }
    return muted;
  },
};
