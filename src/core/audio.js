// Procedural WebAudio: SFX + per-room ambience. No external assets.
// Public API (keep stable, other modules call these):
//   audio.init()          - call once after a user gesture
//   audio.play(name)      - one-shot sfx: click, coin, step, splash, whoosh,
//                           success, fail, pop, ding
//   audio.setRoom(roomId) - switch ambient bed to the room's mood
//   audio.toggleMute()    - returns new muted state
//   audio.muted

let ctx = null;
let master = null;
let muted = false;
let currentRoom = null;

function ensure() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function blip({ freq = 600, dur = 0.08, type = 'sine', vol = 0.25, slide = 0 }) {
  if (muted || !ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), ctx.currentTime + dur);
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
  o.connect(g).connect(master);
  o.start();
  o.stop(ctx.currentTime + dur + 0.02);
}

const SFX = {
  click: () => blip({ freq: 800, dur: 0.05, type: 'triangle' }),
  step: () => blip({ freq: 240, dur: 0.05, type: 'sine', vol: 0.1 }),
  coin: () => { blip({ freq: 900, dur: 0.07, type: 'square', vol: 0.12 }); setTimeout(() => blip({ freq: 1350, dur: 0.12, type: 'square', vol: 0.12 }), 60); },
  splash: () => blip({ freq: 300, dur: 0.3, type: 'sine', slide: -200 }),
  whoosh: () => blip({ freq: 200, dur: 0.25, type: 'sawtooth', vol: 0.08, slide: 300 }),
  success: () => [523, 659, 784].forEach((f, i) => setTimeout(() => blip({ freq: f, dur: 0.15, type: 'triangle' }), i * 90)),
  fail: () => [400, 300, 200].forEach((f, i) => setTimeout(() => blip({ freq: f, dur: 0.2, type: 'sawtooth', vol: 0.1 }), i * 110)),
  pop: () => blip({ freq: 500, dur: 0.06, type: 'sine', slide: 300 }),
  ding: () => blip({ freq: 1200, dur: 0.25, type: 'sine', vol: 0.15 }),
};

export const audio = {
  get muted() { return muted; },
  init() { ensure(); },
  play(name) {
    if (!ctx || muted) return;
    SFX[name]?.();
  },
  setRoom(roomId) {
    currentRoom = roomId;
    // ambience upgraded by the audio module owner; stub keeps rooms silent
  },
  toggleMute() {
    muted = !muted;
    if (master) master.gain.value = muted ? 0 : 0.5;
    return muted;
  },
};
