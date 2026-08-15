import { Minigame } from '../minigame.js';
import { MINIGAMES } from '../../../shared/constants.js';

/**
 * Reel Rush : side-view fishing minigame for Capy Cove.
 *
 * Rendering is a hand-drawn 2D canvas scene (no WebGL) because the whole look
 * is flat toon shapes with dark outlines, which reads far cleaner in 2D than as
 * low-poly meshes. Everything is procedural: fish, kelp, coral, boat, capybara.
 *
 * Run: 90 seconds OR three hearts, whichever runs out first. Mouse Y (or arrow
 * keys) sets the hook depth, touch a fish to reel it in. Hooking anything that
 * is NOT a fish (jellyfish, boot, shark) costs a heart and grants brief
 * invulnerability frames.
 *
 * ---- v2: the catch ladder -------------------------------------------------
 * The first minute is deliberately identical to v1: the same three common fish
 * at the same weights, the same three hazards at the same rates, the same
 * controls, the same legend. Everything below is layered ON TOP of that:
 *
 *  - THREE DEPTH ZONES (Shallows / Reef / Deep) over the same water column.
 *    How far you cast, i.e. how deep you hold the line, decides who bites.
 *  - WEATHER AND THE HOUR. The room already receives the world `clock` frame;
 *    the game reads it, repaints the sky and water for the time of day, and
 *    opens or closes the gated species (the Koi only bites in the rain, the
 *    Lantern Fish only after dark).
 *  - A HOOK-SET BEAT for anything above common: the fish takes the line, a
 *    needle sweeps a generous window, one press lands it. A miss loses the
 *    FISH, never a heart. Hearts and hazards behave exactly as they shipped.
 *  - OLD BARNACLE, the one legendary. Hold the line in the Deep long enough
 *    and he comes up out of the dark for a three-beat fight.
 *  - A FISH JOURNAL (best weight + count per species, localStorage so guests
 *    keep theirs) on the splash and on the results card.
 *
 * Rarity pays SCORE, not coins: coinsForScore is unchanged for every score a
 * v1 run could reach, and saturates below MINIGAMES.fishing.maxCoinsPerRun so
 * the server cap never truncates an honest run.
 */

const TAU = Math.PI * 2;
const RUN_SECONDS = 90;
const COMBO_NEEDED = 5;
const COMBO_TIME = 10;
const MAX_HEARTS = 3;
const INVULN_TIME = 1.5;   // i-frames after a hazard hit
const HIT_STUN = 0.5;      // short control lock inside those i-frames
const SET_GRACE = 1.2;     // i-frames after a hook-set beat: the hook was pinned
const SHARK_EVERY = 20;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const easeOut = (t) => 1 - (1 - t) * (1 - t);

// ---------------------------------------------------------------------------
// Depth zones. The water column between topLimit and botLimit is split in
// three; the band the hook is sitting in is the band you are fishing.
// ---------------------------------------------------------------------------
const ZONES = {
  shallow: { name: 'The Shallows', blurb: 'sunlit and busy', col: '#9fe4ff' },
  reef: { name: 'The Reef', blurb: 'where the colours live', col: '#68d8b0' },
  deep: { name: 'The Deep', blurb: 'cold, quiet, patient', col: '#9db0ff' },
};
const ZONE_IDS = ['shallow', 'reef', 'deep'];
const ZONE_CUTS = [0.34, 0.68];      // fractions of the column

const RARITY = {
  common: { label: 'Common', col: '#8fb3c9', rank: 0 },
  uncommon: { label: 'Uncommon', col: '#7ac74f', rank: 1 },
  rare: { label: 'Rare', col: '#4fb3e8', rank: 2 },
  legendary: { label: 'Legendary', col: '#f2b64a', rank: 3 },
};

// Seconds of hook time held in the Deep before Old Barnacle comes up.
const DEEP_FILL = 20;

/**
 * The species table.
 *
 * `base(p)` is the raw spawn weight at run progress p; `zones` scales it per
 * depth band (a missing band means that species is simply not there). `needs`
 * is a hard gate on the world clock, `likes` a soft bias. `beats` is how many
 * hook-set presses the fish costs (0 = lands on contact, exactly like v1).
 * `wt` is the kilo range rolled for the journal. `shape`/`mark` drive the art.
 */
const KINDS = {
  // ---- common: the backbone of the first minute, unchanged from v1 --------
  small: {
    points: 3, r: 12, speed: 0.30, body: '#ff8c5a', fin: '#e8657a', belly: '#ffdcbb', flap: 15,
    label: 'Sardine', hint: 'small + quick', rarity: 'common', shape: 'small', mark: 'blush',
    wt: [0.2, 0.9], beats: 0, zones: { shallow: 1.5, reef: 1, deep: 0.5 }, base: (p) => 30 + 12 * p,
    note: 'Everywhere, always. The bread and butter of the cove.',
  },
  medium: {
    points: 2, r: 18, speed: 0.205, body: '#4fb3e8', fin: '#2f86bd', belly: '#dcf3ff', flap: 10,
    label: 'Bluefin', hint: 'steady swimmer', rarity: 'common', shape: 'medium', mark: 'stripes',
    wt: [1.2, 4.5], beats: 0, zones: { shallow: 1, reef: 1.3, deep: 0.8 }, base: () => 26,
    note: 'Cruises the reef in a straight line and dares you to miss.',
  },
  big: {
    points: 1, r: 27, speed: 0.125, body: '#7ac74f', fin: '#4d9b39', belly: '#e6f8c8', flap: 6.5,
    label: 'Grouper', hint: 'big and lazy', rarity: 'common', shape: 'big', mark: 'blobs',
    wt: [5, 14], beats: 0, zones: { shallow: 0.5, reef: 1, deep: 1.5 }, base: (p) => 15 - 5 * p,
    note: 'Enormous, slow, and worth almost nothing. He knows.',
  },
  // ---- uncommon ----------------------------------------------------------
  perch: {
    points: 5, r: 15, speed: 0.245, body: '#c98fd8', fin: '#9a63b8', belly: '#f6e6ff', flap: 12,
    label: 'Pebble Perch', hint: 'shallows, likes a breeze', rarity: 'uncommon', shape: 'medium',
    mark: 'pebbles', wt: [0.6, 2.4], beats: 1, zones: { shallow: 1 }, base: () => 10,
    likes: { weather: 'breeze' },
    note: 'Speckled like the stones it hides against. Comes up when the wind does.',
  },
  snapper: {
    points: 7, r: 21, speed: 0.19, body: '#ff7a4d', fin: '#e8657a', belly: '#ffe2c6', flap: 9,
    label: 'Sunset Snapper', hint: 'the reef at dusk', rarity: 'uncommon', shape: 'big',
    mark: 'bands', wt: [2, 6.5], beats: 1, zones: { reef: 1, shallow: 0.5 }, base: () => 9,
    likes: { time: 'dusk' },
    note: 'Wears the last hour of daylight on its back.',
  },
  puffer: {
    points: 6, r: 20, speed: 0.10, body: '#ffd9e2', fin: '#f2a0b4', belly: '#fff7f3', flap: 5,
    label: 'Marshmallow Puffer', hint: 'deep, slow, extremely round', rarity: 'uncommon',
    shape: 'puff', mark: 'spikes', wt: [1, 3.2], beats: 1, zones: { deep: 1 }, base: () => 9,
    note: 'Drifts along the bottom like a dropped dessert.',
  },
  // ---- rare --------------------------------------------------------------
  golden: {
    points: 10, r: 10, speed: 0.5, body: '#f2b64a', fin: '#ffdd7a', belly: '#fff4cd', flap: 22,
    label: 'Golden Minnow', hint: 'rare! tiny + fast', rarity: 'rare', shape: 'golden',
    mark: 'sheen', wt: [0.1, 0.4], beats: 1, zones: { shallow: 1, reef: 1, deep: 1 },
    base: (p) => 2 + 3 * p, likes: { time: 'day' },
    note: 'A rumour with fins. Gone before you have finished seeing it.',
  },
  koi: {
    points: 14, r: 19, speed: 0.27, body: '#fff6e3', fin: '#e8657a', belly: '#ffeaf0', flap: 8,
    label: 'Cove Koi', hint: 'only when it rains', rarity: 'rare', shape: 'medium', mark: 'koi',
    wt: [3, 9], beats: 1, zones: { reef: 1, shallow: 0.6 }, base: () => 7,
    needs: { weather: ['rain'] },
    note: 'Rises to meet the raindrops. Nobody knows where it waits in between.',
  },
  lantern: {
    points: 16, r: 14, speed: 0.33, body: '#5b4fd8', fin: '#8f7bff', belly: '#cfc4ff', flap: 14,
    label: 'Lantern Fish', hint: 'deep water, after dark', rarity: 'rare', shape: 'lantern',
    mark: 'glow', wt: [0.4, 1.6], beats: 1, zones: { deep: 1 }, base: () => 8,
    needs: { time: ['night'] },
    note: 'Carries its own little porch light down where the sun gave up.',
  },
  // ---- legendary: one per table, and he does not queue with the others ----
  barnacle: {
    points: 60, r: 52, speed: 0.075, body: '#5f7a63', fin: '#3f5a48', belly: '#cdd9b6', flap: 3.2,
    label: 'Old Barnacle', hint: 'the one the cove talks about', rarity: 'legendary',
    shape: 'barnacle', mark: 'barnacles', wt: [38, 64], beats: 3, zones: { deep: 1 }, base: () => 0,
    note: 'Older than the pier. Hold the line in the Deep and he will come to you.',
  },
};

const KIND_IDS = Object.keys(KINDS);
const LADDER = ['common', 'uncommon', 'rare', 'legendary'];

// Everything in the water that is NOT a fish. All of them cost one heart.
const HAZARDS = {
  jelly: { label: 'Jellyfish', hint: 'zaps your line', hit: 'ZAP!' },
  boot: { label: 'Old Boot', hint: 'not dinner', hit: 'CLUNK!' },
  shark: { label: 'Shark', hint: 'sweeps the cove', hit: 'CHOMP!' },
};

// Flavour for the "ran out of hearts" results card, keyed by whatever got you.
const WIPEOUT = {
  jelly: 'The jellyfish are already writing a song about it.',
  boot: 'Beaten by footwear. Somewhere out there, a boot is gloating.',
  shark: 'The shark would like to thank you for the snack.',
};

const HEART = '♥';
const OUTLINE = 'rgba(8,34,56,0.55)';

/** Time-of-day band from the world clock phase (0 dawn, .25 noon, .5 dusk). */
function bandOf(dayT) {
  const t = ((dayT % 1) + 1) % 1;
  if (t < 0.08 || t >= 0.92) return 'dawn';
  if (t < 0.38) return 'day';
  if (t < 0.60) return 'dusk';
  return 'night';
}
const BAND_LABEL = { dawn: 'Dawn', day: 'Daylight', dusk: 'Dusk', night: 'Night' };
const WEATHER_LABEL = { clear: 'Clear', breeze: 'Breezy', rain: 'Rain' };

/** The v1 fish weight at progress p. Every zone table is normalised back to
 *  this so the fish:hazard ratio is bit-for-bit what shipped. */
const FISH_TOTAL = (p) => (30 + 12 * p) + 26 + (15 - 5 * p) + (2 + 3 * p);

/**
 * The spawn table for one roll: which fish live in this band right now, plus
 * the two ambient hazards at EXACTLY their shipped weights.
 */
function spawnTable(p, zone, band, weather) {
  const fish = [];
  let total = 0;
  for (const id of KIND_IDS) {
    const k = KINDS[id];
    if (k.rarity === 'legendary') continue;
    const zw = k.zones[zone];
    if (!zw) continue;
    if (k.needs?.time && !k.needs.time.includes(band)) continue;
    if (k.needs?.weather && !k.needs.weather.includes(weather)) continue;
    let w = k.base(p) * zw;
    if (k.likes?.time === band) w *= 1.8;
    if (k.likes?.weather === weather) w *= 1.8;
    if (k.needs) w *= 1.35;   // a gated fish bites well on the hour it owns
    if (w <= 0) continue;
    fish.push([id, w]);
    total += w;
  }
  const want = FISH_TOTAL(p);
  const scale = total > 0 ? want / total : 0;
  const rows = fish.map(([id, w]) => [id, w * scale]);
  rows.push(['jelly', 10 + 9 * p]);
  rows.push(['boot', 7 + 3 * p]);
  return rows;
}

/**
 * The name to put on the gauge for a band: the species that most belongs to
 * THIS water right now. Rarity decides, but a fish that lives in every band
 * (the Golden Minnow) never speaks for one, so each band has its own face.
 */
function headliner(zone, band, weather) {
  let best = null;
  let bestScore = -1;
  for (const id of KIND_IDS) {
    const k = KINDS[id];
    if (k.rarity === 'legendary' || !k.zones[zone]) continue;
    if (k.needs?.time && !k.needs.time.includes(band)) continue;
    if (k.needs?.weather && !k.needs.weather.includes(weather)) continue;
    const homes = Object.keys(k.zones).length;
    // exclusivity first, then rarity: the Deep's face is the Puffer, not a
    // minnow that happens to swim everywhere
    const score = (3 - homes) * 10 + RARITY[k.rarity].rank + (k.needs ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The fish journal. Local only (guests included): no new wire frames, and a
// hand-edited entry buys nothing but a number on the player's own card.
// ---------------------------------------------------------------------------
const JOURNAL_KEY = 'capycove-fishing-journal';

function loadJournal() {
  const out = {};
  let raw = null;
  try { raw = JSON.parse(globalThis.localStorage?.getItem(JOURNAL_KEY) || 'null'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return out;
  for (const id of KIND_IDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const r = raw[id];
    if (!r || typeof r !== 'object') continue;
    const n = Math.round(Number(r.n));
    const best = Number(r.best);
    if (!(n > 0)) continue;
    out[id] = {
      n: clamp(n, 1, 999999),
      best: Number.isFinite(best) ? clamp(best, 0, 999) : 0,
    };
  }
  return out;
}

function saveJournal(j) {
  try { globalThis.localStorage?.setItem(JOURNAL_KEY, JSON.stringify(j)); } catch { /* private mode: this run only */ }
}

const fmtKg = (w) => `${w >= 10 ? w.toFixed(0) : w.toFixed(1)} kg`;

// ---------------------------------------------------------------------------
// Sky and water palette, keyed to the same world clock the beach uses:
// dawn (0), noon (.25), dusk (.5), night (.75). The scene is repainted from
// these four, so a run at 2am genuinely happens at 2am.
// ---------------------------------------------------------------------------
const DAY_SECONDS = 40 * 60;

const hexRGB = (c) => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbStr = (a) => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const SKY_KEYS = [
  { // dawn
    top: '#6d86c6', mid: '#ffb6a8', low: '#ffe3b8', sun: '#fff0c8',
    water: ['#57b3c9', '#2e86a8', '#1a5a80', '#0d3050'], star: 0.3, ray: 0.75, foam: 0.62,
  },
  { // noon: the palette v1 shipped with
    top: '#8fd6f5', mid: '#c9ecfb', low: '#ffe7bd', sun: '#fff3c4',
    water: ['#3fb6d8', '#1f8ab5', '#12578a', '#0a2f55'], star: 0, ray: 1, foam: 0.75,
  },
  { // dusk
    top: '#42508f', mid: '#f2857a', low: '#ffc98a', sun: '#ffd08a',
    water: ['#2f86a8', '#1c6a90', '#0f4a72', '#07223f'], star: 0.34, ray: 0.6, foam: 0.6,
  },
  { // night
    top: '#0d1836', mid: '#1b2a52', low: '#2f3f68', sun: '#e9f0ff',
    water: ['#155275', '#0e3c5e', '#082a46', '#04152a'], star: 1, ray: 0.16, foam: 0.42,
  },
];
const SKY_RGB = SKY_KEYS.map((k) => ({
  top: hexRGB(k.top), mid: hexRGB(k.mid), low: hexRGB(k.low), sun: hexRGB(k.sun),
  water: k.water.map(hexRGB), star: k.star, ray: k.ray, foam: k.foam,
}));

function paletteAt(dayT) {
  const seg = ((((dayT % 1) + 1) % 1)) * 4;
  const i = Math.floor(seg) % 4;
  const j = (i + 1) % 4;
  const f = seg - Math.floor(seg);
  const A = SKY_RGB[i];
  const B = SKY_RGB[j];
  return {
    top: mixRGB(A.top, B.top, f),
    mid: mixRGB(A.mid, B.mid, f),
    low: mixRGB(A.low, B.low, f),
    sun: mixRGB(A.sun, B.sun, f),
    water: [0, 1, 2, 3].map((n) => mixRGB(A.water[n], B.water[n], f)),
    star: A.star + (B.star - A.star) * f,
    ray: A.ray + (B.ray - A.ray) * f,
    foam: A.foam + (B.foam - A.foam) * f,
  };
}

function weightedPick(table) {
  let total = 0;
  for (const row of table) total += row[1];
  let r = Math.random() * total;
  for (const row of table) {
    r -= row[1];
    if (r <= 0) return row[0];
  }
  return table[0][0];
}

function fmtTime(s) {
  const v = Math.max(0, Math.ceil(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function toonFill(ctx, color, lw) {
  ctx.fillStyle = color;
  ctx.fill();
  if (lw > 0) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = OUTLINE;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Creature art. All shapes are drawn centred on the origin, facing +x, so the
// same routines paint the swimming scene AND the little legend icons.
// ---------------------------------------------------------------------------

const SHAPE = {
  small: [2.1, 1.3], medium: [2.1, 1.3], big: [2.1, 1.3], golden: [2.1, 1.3],
  puff: [1.85, 1.72], lantern: [2.0, 1.28], barnacle: [2.25, 1.5],
};

function drawFishArt(ctx, kind, r, t, phase) {
  const k = KINDS[kind];
  const shape = k.shape || 'medium';
  const prop = SHAPE[shape] || SHAPE.medium;
  const bw = r * prop[0];
  const bh = r * prop[1];
  const flap = Math.sin(t * k.flap + phase);
  const lw = Math.max(1.2, r * 0.13);

  if (shape === 'golden' || shape === 'lantern') {
    const warm = shape === 'golden';
    ctx.save();
    ctx.globalAlpha = (warm ? 0.5 : 0.42) + 0.3 * Math.sin(t * 6 + phase);
    ctx.fillStyle = warm ? 'rgba(255,220,120,0.5)' : 'rgba(150,170,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(0, 0, bw * (warm ? 0.95 : 1.15), bh * (warm ? 1.15 : 1.45), 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // Old Barnacle drags the dark up with him
  if (shape === 'barnacle') {
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.12 * Math.sin(t * 1.6 + phase);
    ctx.fillStyle = 'rgba(8,20,44,0.9)';
    ctx.beginPath();
    ctx.ellipse(0, 0, bw * 0.86, bh * 1.1, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // the lantern's little porch light, drawn behind the head
  if (shape === 'lantern') {
    const lx = bw * 0.52 + Math.sin(t * 2.2 + phase) * r * 0.1;
    const ly = -bh * 0.95 - r * 0.15;
    ctx.strokeStyle = '#cfc4ff';
    ctx.lineWidth = lw * 0.7;
    ctx.beginPath();
    ctx.moveTo(bw * 0.24, -bh * 0.4);
    ctx.quadraticCurveTo(bw * 0.5, -bh * 1.05, lx, ly);
    ctx.stroke();
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t * 5 + phase);
    ctx.fillStyle = '#fff2b0';
    ctx.beginPath();
    ctx.arc(lx, ly, r * 0.45, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff6c8';
    ctx.beginPath();
    ctx.arc(lx, ly, r * 0.19, 0, TAU);
    ctx.fill();
  }

  // tail
  ctx.save();
  ctx.translate(-bw * 0.44, 0);
  ctx.rotate(flap * 0.34);
  ctx.beginPath();
  ctx.moveTo(r * 0.15, 0);
  ctx.lineTo(-r * 0.95, -r * 0.85);
  ctx.quadraticCurveTo(-r * 0.45, 0, -r * 0.95, r * 0.85);
  ctx.closePath();
  toonFill(ctx, k.fin, lw);
  ctx.restore();

  // dorsal fin
  ctx.beginPath();
  ctx.moveTo(-r * 0.35, -bh * 0.42);
  ctx.quadraticCurveTo(-r * 0.05, -bh * 1.25 - flap * r * 0.12, r * 0.5, -bh * 0.4);
  ctx.closePath();
  toonFill(ctx, k.fin, lw);

  // belly fin
  ctx.beginPath();
  ctx.moveTo(-r * 0.2, bh * 0.36);
  ctx.quadraticCurveTo(-r * 0.05, bh * 0.95, r * 0.35, bh * 0.38);
  ctx.closePath();
  toonFill(ctx, k.fin, lw * 0.8);

  // body
  ctx.beginPath();
  ctx.ellipse(0, 0, bw * 0.5, bh * 0.5, 0, 0, TAU);
  toonFill(ctx, k.body, lw);

  // belly patch
  ctx.beginPath();
  ctx.ellipse(r * 0.08, bh * 0.16, bw * 0.34, bh * 0.26, 0, 0, TAU);
  ctx.fillStyle = k.belly;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;

  // markings
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, bw * 0.5, bh * 0.5, 0, 0, TAU);
  ctx.clip();
  const mark = k.mark || 'stripes';
  if (mark === 'stripes') {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.ellipse(i * r * 0.5 - r * 0.1, 0, r * 0.13, bh, 0, 0, TAU);
      ctx.fill();
    }
  } else if (mark === 'blush') {
    ctx.fillStyle = 'rgba(232,101,122,0.5)';
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.ellipse(-r * 0.15 + i * r * 0.55, 0, r * 0.11, bh, 0, 0, TAU);
      ctx.fill();
    }
  } else if (mark === 'blobs') {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (let i = 0; i < 4; i++) {
      const a = phase + i * 1.7;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.35 - r * 0.15, r * 0.16, 0, TAU);
      ctx.fill();
    }
  } else if (mark === 'pebbles') {
    for (let i = 0; i < 7; i++) {
      const a = phase * 1.7 + i * 2.39;
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.45)' : 'rgba(70,40,90,0.28)';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * bw * 0.34, Math.sin(a * 1.4) * bh * 0.3, r * (0.1 + 0.05 * (i % 3)), 0, TAU);
      ctx.fill();
    }
  } else if (mark === 'bands') {
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,214,140,0.5)' : 'rgba(196,58,64,0.34)';
      ctx.beginPath();
      ctx.ellipse(-bw * 0.34 + i * bw * 0.23, 0, r * 0.16, bh, 0.22, 0, TAU);
      ctx.fill();
    }
  } else if (mark === 'spikes') {
    ctx.fillStyle = 'rgba(232,101,122,0.35)';
    for (let i = 0; i < 9; i++) {
      const a = i * 0.7 + phase;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * bw * 0.36, Math.sin(a * 1.7) * bh * 0.34, r * 0.09, 0, TAU);
      ctx.fill();
    }
  } else if (mark === 'koi') {
    ctx.fillStyle = 'rgba(232,101,122,0.85)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.45, -r * 0.18, r * 0.42, r * 0.3, 0.4, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(r * 0.35, r * 0.16, r * 0.34, r * 0.24, -0.3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(45,36,23,0.35)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.02, -r * 0.34, r * 0.22, r * 0.15, 0.1, 0, TAU);
    ctx.fill();
  } else if (mark === 'glow') {
    ctx.fillStyle = 'rgba(190,255,240,0.75)';
    for (let i = 0; i < 6; i++) {
      const f = i / 5;
      const s = 0.55 + 0.45 * Math.sin(t * 4 + i * 0.9 + phase);
      ctx.globalAlpha = 0.35 + 0.45 * s;
      ctx.beginPath();
      ctx.arc(lerp(-bw * 0.38, bw * 0.3, f), bh * 0.26, r * 0.08 * (0.7 + s * 0.5), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (mark === 'barnacles') {
    ctx.fillStyle = 'rgba(45,60,45,0.32)';
    for (let i = 0; i < 5; i++) {
      const a = i * 1.31 + 0.4;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * bw * 0.3, Math.sin(a * 1.6) * bh * 0.28, r * 0.24, r * 0.17, a, 0, TAU);
      ctx.fill();
    }
    // crusted shells, the reason for the name
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.2;
      const cx = Math.cos(a) * bw * 0.33;
      const cy = Math.sin(a * 1.3) * bh * 0.3;
      const rr = r * (0.1 + 0.05 * (i % 3));
      ctx.fillStyle = '#e6e0cc';
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#8f8a72';
      ctx.beginPath();
      ctx.arc(cx, cy, rr * 0.45, 0, TAU);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, -r * 0.2, r * 0.7, r * 0.16, -0.3, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // pectoral fin over body
  ctx.save();
  ctx.translate(r * 0.12, bh * 0.12);
  ctx.rotate(flap * 0.3 + 0.35);
  ctx.beginPath();
  ctx.ellipse(0, r * 0.2, r * 0.34, r * 0.17, 0.5, 0, TAU);
  toonFill(ctx, k.fin, lw * 0.7);
  ctx.restore();

  // eye
  const ex = bw * 0.3;
  const ey = -bh * 0.16;
  ctx.beginPath();
  ctx.arc(ex, ey, r * 0.27, 0, TAU);
  ctx.fillStyle = '#fffdf6';
  ctx.fill();
  ctx.lineWidth = lw * 0.7;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ex + r * 0.07, ey + r * 0.02, r * 0.14, 0, TAU);
  ctx.fillStyle = '#22303c';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex + r * 0.02, ey - r * 0.08, r * 0.05, 0, TAU);
  ctx.fillStyle = '#fff';
  ctx.fill();

  // mouth
  ctx.beginPath();
  ctx.moveTo(bw * 0.47, r * 0.16);
  ctx.quadraticCurveTo(bw * 0.4, r * 0.34, bw * 0.28, r * 0.26);
  ctx.lineWidth = lw * 0.8;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();

  // Old Barnacle wears his history: a scarred brow, a heavy jaw and a beard
  // of weed that drifts a beat behind the rest of him.
  if (shape === 'barnacle') {
    ctx.strokeStyle = 'rgba(30,50,36,0.75)';
    ctx.lineWidth = lw * 0.9;
    ctx.beginPath();
    ctx.moveTo(ex - r * 0.55, ey - r * 0.5);
    ctx.lineTo(ex + r * 0.35, ey - r * 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex - r * 0.2, ey - r * 0.62);
    ctx.lineTo(ex - r * 0.05, ey - r * 0.3);
    ctx.stroke();
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const sway = Math.sin(t * 1.6 + i * 0.8 + phase) * r * 0.22;
      ctx.strokeStyle = i % 2 ? '#3f7a4a' : '#2f6440';
      ctx.lineWidth = lw * 1.1;
      ctx.beginPath();
      ctx.moveTo(bw * (0.16 + i * 0.05), bh * 0.42);
      ctx.quadraticCurveTo(bw * 0.28 + sway, bh * 0.72, bw * (0.1 + i * 0.07) + sway * 1.6, bh * 0.95);
      ctx.stroke();
    }
    // one gold tooth, catching whatever light gets this deep
    ctx.fillStyle = '#f2b64a';
    ctx.beginPath();
    ctx.moveTo(bw * 0.42, r * 0.2);
    ctx.lineTo(bw * 0.47, r * 0.2);
    ctx.lineTo(bw * 0.445, r * 0.42);
    ctx.closePath();
    ctx.fill();
  }

  if (shape === 'puff') {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = lw * 0.6;
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i += 2) {
      ctx.beginPath();
      ctx.moveTo(bw * 0.42, r * 0.28);
      ctx.quadraticCurveTo(bw * 0.62, r * (0.34 + i * 0.2), bw * 0.74, r * (0.2 + i * 0.4));
      ctx.stroke();
    }
  }

  if (shape === 'golden') {
    ctx.fillStyle = '#fffbe8';
    for (let i = 0; i < 3; i++) {
      const a = t * 3 + i * 2.1 + phase;
      const sx = Math.cos(a) * bw * 0.75;
      const sy = Math.sin(a * 1.3) * bh * 0.9;
      const s = r * (0.16 + 0.08 * Math.sin(t * 9 + i));
      ctx.beginPath();
      ctx.moveTo(sx, sy - s);
      ctx.lineTo(sx + s * 0.35, sy);
      ctx.lineTo(sx, sy + s);
      ctx.lineTo(sx - s * 0.35, sy);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawJellyArt(ctx, r, t, phase) {
  const pulse = Math.sin(t * 2.2 + phase);
  const bw = r * 1.65 * (1 + pulse * 0.09);
  const bh = r * 1.25 * (1 - pulse * 0.12);
  const lw = Math.max(1.2, r * 0.1);

  // glow
  ctx.save();
  ctx.globalAlpha = 0.22 + 0.1 * Math.sin(t * 3 + phase);
  ctx.fillStyle = '#ff9ee0';
  ctx.beginPath();
  ctx.ellipse(0, 0, bw * 0.95, bh * 1.3, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // tentacles
  ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const f = i / 6 - 0.5;
    const x0 = f * bw * 0.85;
    const len = r * (1.5 + 1.4 * (1 - Math.abs(f) * 1.3)) * (1 + pulse * 0.12);
    const sway = Math.sin(t * 2.6 + phase + i * 0.7) * r * 0.4;
    ctx.beginPath();
    ctx.moveTo(x0, bh * 0.34);
    ctx.quadraticCurveTo(x0 + sway, bh * 0.34 + len * 0.6, x0 - sway * 0.7, bh * 0.34 + len);
    ctx.lineWidth = lw * (i % 2 ? 1.1 : 1.8);
    ctx.strokeStyle = i % 2 ? 'rgba(255,190,235,0.85)' : 'rgba(226,120,205,0.9)';
    ctx.stroke();
  }

  // bell
  ctx.beginPath();
  ctx.moveTo(-bw * 0.5, bh * 0.3);
  ctx.quadraticCurveTo(-bw * 0.55, -bh * 0.95, 0, -bh * 0.95);
  ctx.quadraticCurveTo(bw * 0.55, -bh * 0.95, bw * 0.5, bh * 0.3);
  ctx.quadraticCurveTo(bw * 0.25, bh * 0.06, 0, bh * 0.3);
  ctx.quadraticCurveTo(-bw * 0.25, bh * 0.55, -bw * 0.5, bh * 0.3);
  ctx.closePath();
  ctx.fillStyle = 'rgba(238,138,214,0.72)';
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(120,40,110,0.5)';
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(-bw * 0.14, -bh * 0.36, bw * 0.2, bh * 0.24, -0.3, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();

  // sparks (danger tell)
  ctx.strokeStyle = 'rgba(255,240,140,' + (0.35 + 0.35 * Math.sin(t * 8 + phase)) + ')';
  ctx.lineWidth = lw * 0.9;
  for (let i = 0; i < 3; i++) {
    const a = t * 2 + i * 2.2 + phase;
    const rx = Math.cos(a) * bw * 0.7;
    const ry = Math.sin(a) * bh * 0.5 - bh * 0.2;
    ctx.beginPath();
    ctx.moveTo(rx - r * 0.16, ry - r * 0.1);
    ctx.lineTo(rx + r * 0.04, ry);
    ctx.lineTo(rx - r * 0.06, ry + r * 0.06);
    ctx.lineTo(rx + r * 0.16, ry + r * 0.16);
    ctx.stroke();
  }

  // face
  ctx.fillStyle = '#4a1f45';
  ctx.beginPath();
  ctx.arc(-r * 0.3, -bh * 0.22, r * 0.1, 0, TAU);
  ctx.arc(r * 0.3, -bh * 0.22, r * 0.1, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -bh * 0.02, r * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.lineWidth = lw * 0.9;
  ctx.strokeStyle = '#4a1f45';
  ctx.stroke();
}

function drawBootArt(ctx, r, t) {
  const lw = Math.max(1.3, r * 0.12);
  ctx.save();
  ctx.rotate(Math.sin(t * 1.2) * 0.12);

  // sole
  rrect(ctx, -r * 0.62, r * 0.62, r * 1.95, r * 0.34, r * 0.16);
  toonFill(ctx, '#2f2a24', lw);
  // foot
  ctx.beginPath();
  ctx.moveTo(-r * 0.6, -r * 0.1);
  ctx.lineTo(r * 0.62, -r * 0.1);
  ctx.quadraticCurveTo(r * 1.3, -r * 0.05, r * 1.3, r * 0.42);
  ctx.quadraticCurveTo(r * 1.3, r * 0.66, r * 1.05, r * 0.66);
  ctx.lineTo(-r * 0.6, r * 0.66);
  ctx.closePath();
  toonFill(ctx, '#6b5138', lw);
  // leg
  rrect(ctx, -r * 0.62, -r * 1.25, r * 1.22, r * 1.3, r * 0.2);
  toonFill(ctx, '#7b5d40', lw);
  // cuff
  rrect(ctx, -r * 0.72, -r * 1.38, r * 1.42, r * 0.34, r * 0.14);
  toonFill(ctx, '#94714e', lw);
  // laces
  ctx.strokeStyle = '#e6d3ac';
  ctx.lineWidth = lw * 0.8;
  for (let i = 0; i < 3; i++) {
    const y = -r * 1.0 + i * r * 0.32;
    ctx.beginPath();
    ctx.moveTo(-r * 0.44, y);
    ctx.lineTo(r * 0.42, y + r * 0.16);
    ctx.stroke();
  }
  // patch + hole
  ctx.beginPath();
  ctx.ellipse(r * 0.55, r * 0.28, r * 0.2, r * 0.15, 0.4, 0, TAU);
  ctx.fillStyle = '#3b2c1e';
  ctx.fill();
  ctx.restore();

  // escaping bubbles
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.6 + i * 0.33) % 1;
    ctx.globalAlpha = 1 - p;
    ctx.beginPath();
    ctx.arc(-r * 0.2 + i * r * 0.25, -r * 1.5 - p * r * 1.6, r * 0.11, 0, TAU);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSharkArt(ctx, L, t) {
  const H = L * 0.34;
  const lw = Math.max(1.6, L * 0.035);
  const wag = Math.sin(t * 7) * 0.18;

  // tail
  ctx.save();
  ctx.translate(-L * 0.82, 0);
  ctx.rotate(wag);
  ctx.beginPath();
  ctx.moveTo(L * 0.16, 0);
  ctx.lineTo(-L * 0.2, -H * 1.5);
  ctx.quadraticCurveTo(-L * 0.02, -H * 0.1, -L * 0.16, H * 1.05);
  ctx.closePath();
  toonFill(ctx, '#5d7385', lw);
  ctx.restore();

  // dorsal
  ctx.beginPath();
  ctx.moveTo(-L * 0.18, -H * 0.72);
  ctx.lineTo(0.02 * L, -H * 1.75);
  ctx.lineTo(L * 0.22, -H * 0.66);
  ctx.closePath();
  toonFill(ctx, '#5d7385', lw);

  // pectoral
  ctx.beginPath();
  ctx.moveTo(L * 0.12, H * 0.5);
  ctx.lineTo(-L * 0.1, H * 1.5);
  ctx.lineTo(L * 0.3, H * 0.62);
  ctx.closePath();
  toonFill(ctx, '#4f6474', lw);

  // body
  ctx.beginPath();
  ctx.moveTo(L * 0.98, H * 0.04);
  ctx.quadraticCurveTo(L * 0.45, -H * 1.02, -L * 0.35, -H * 0.78);
  ctx.quadraticCurveTo(-L * 0.72, -H * 0.6, -L * 0.86, -H * 0.2);
  ctx.lineTo(-L * 0.86, H * 0.28);
  ctx.quadraticCurveTo(-L * 0.5, H * 0.86, L * 0.25, H * 0.8);
  ctx.quadraticCurveTo(L * 0.75, H * 0.72, L * 0.98, H * 0.04);
  ctx.closePath();
  toonFill(ctx, '#7089a0', lw);

  // belly
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(L * 0.98, H * 0.04);
  ctx.quadraticCurveTo(L * 0.25, H * 0.86, -L * 0.86, H * 0.28);
  ctx.lineTo(-L * 0.86, H * 0.9);
  ctx.lineTo(L * 1, H * 0.9);
  ctx.closePath();
  ctx.fillStyle = '#d6e4ee';
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.restore();

  // gills
  ctx.strokeStyle = 'rgba(28,54,74,0.5)';
  ctx.lineWidth = lw * 0.8;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(L * (0.2 - i * 0.075), -H * 0.42);
    ctx.quadraticCurveTo(L * (0.16 - i * 0.075), 0, L * (0.2 - i * 0.075), H * 0.3);
    ctx.stroke();
  }

  // mouth + teeth
  ctx.beginPath();
  ctx.moveTo(L * 0.94, H * 0.16);
  ctx.quadraticCurveTo(L * 0.6, H * 0.66, L * 0.24, H * 0.5);
  ctx.lineTo(L * 0.3, H * 0.24);
  ctx.quadraticCurveTo(L * 0.62, H * 0.4, L * 0.94, H * 0.16);
  ctx.closePath();
  toonFill(ctx, '#3a2632', lw * 0.7);
  ctx.fillStyle = '#fffdf6';
  for (let i = 0; i < 5; i++) {
    const f = i / 5;
    const x = lerp(L * 0.32, L * 0.88, f);
    const y = lerp(H * 0.42, H * 0.2, f);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + L * 0.05, y);
    ctx.lineTo(x + L * 0.025, y + H * 0.2);
    ctx.closePath();
    ctx.fill();
  }

  // eye
  ctx.beginPath();
  ctx.arc(L * 0.6, -H * 0.28, H * 0.16, 0, TAU);
  ctx.fillStyle = '#fffdf6';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(L * 0.62, -H * 0.27, H * 0.08, 0, TAU);
  ctx.fillStyle = '#1d2a34';
  ctx.fill();
}

function drawCapyArt(ctx, s, color, t) {
  const lw = Math.max(1.4, s * 0.09);
  // body
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.85, s * 0.72, 0, 0, TAU);
  toonFill(ctx, color, lw);
  // head
  ctx.save();
  ctx.translate(s * 0.42, -s * 0.85 + Math.sin(t * 2.4) * s * 0.05);
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.62, s * 0.52, 0, 0, TAU);
  toonFill(ctx, color, lw);
  // snout
  ctx.beginPath();
  ctx.ellipse(s * 0.34, s * 0.12, s * 0.3, s * 0.24, 0, 0, TAU);
  toonFill(ctx, color, lw * 0.8);
  // ears
  ctx.beginPath();
  ctx.ellipse(-s * 0.36, -s * 0.38, s * 0.16, s * 0.13, -0.5, 0, TAU);
  toonFill(ctx, color, lw * 0.8);
  ctx.beginPath();
  ctx.ellipse(s * 0.12, -s * 0.46, s * 0.15, s * 0.12, -0.3, 0, TAU);
  toonFill(ctx, color, lw * 0.8);
  // face
  ctx.fillStyle = '#2d2417';
  ctx.beginPath();
  ctx.arc(s * 0.16, -s * 0.1, s * 0.075, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(s * 0.56, s * 0.06, s * 0.09, s * 0.07, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------

const CSS = `
.mg-fishing-wrap { position:absolute; inset:0; overflow:hidden; background:#0b2f52;
  font-family: var(--font, "Trebuchet MS","Segoe UI",system-ui,sans-serif); }
.mg-fishing-canvas { position:absolute; inset:0; display:block; }
.mg-fishing-ui { position:absolute; inset:0; pointer-events:none; color:#fff6e3; }

.mg-fishing-hud { position:absolute; top:0; left:0; right:0; display:flex; align-items:center;
  flex-wrap:wrap; gap:10px 12px; padding:14px 16px; }
.mg-fishing-hud[hidden] { display:none; }
.mg-fishing-pill { display:flex; align-items:center; gap:9px; padding:7px 15px; border-radius:999px;
  background:rgba(9,36,58,0.6); border:2px solid rgba(255,255,255,0.32);
  box-shadow:0 5px 16px rgba(0,0,0,0.3); backdrop-filter:blur(4px); }
.mg-fishing-k { font-size:11px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase;
  color:rgba(255,246,227,0.72); }
.mg-fishing-v { font-size:22px; font-weight:900; color:#f2b64a; min-width:34px; text-align:right;
  font-variant-numeric:tabular-nums; }
.mg-fishing-v.mg-fishing-bump { animation:mg-fishing-bump 0.28s ease; }
@keyframes mg-fishing-bump { 0%{ transform:scale(1);} 40%{ transform:scale(1.35); color:#fff6e3;} 100%{ transform:scale(1);} }

.mg-fishing-lives { display:flex; align-items:center; gap:9px; padding:7px 15px; border-radius:999px;
  background:rgba(9,36,58,0.6); border:2px solid rgba(255,255,255,0.32);
  box-shadow:0 5px 16px rgba(0,0,0,0.3); backdrop-filter:blur(4px);
  transition:border-color 0.2s ease; }
.mg-fishing-hrow { display:flex; gap:5px; }
.mg-fishing-heart { display:block; font-size:20px; line-height:1; color:#e8657a;
  text-shadow:0 2px 0 rgba(9,36,58,0.45); transition:color 0.2s ease, transform 0.2s ease; }
.mg-fishing-heart.mg-fishing-gone { color:rgba(255,246,227,0.2); transform:scale(0.78); text-shadow:none; }
.mg-fishing-heart.mg-fishing-break { animation:mg-fishing-break 0.55s ease both; }
@keyframes mg-fishing-break { 0%{ transform:scale(1.6); color:#fff6e3; }
  35%{ transform:scale(1.12) rotate(-14deg); color:#e8657a; }
  100%{ transform:scale(0.78) rotate(0deg); color:rgba(255,246,227,0.2); } }
.mg-fishing-lives.mg-fishing-hurt .mg-fishing-hrow { animation:mg-fishing-hurt 0.45s ease; }
@keyframes mg-fishing-hurt { 0%,100%{ transform:translateX(0);} 18%{ transform:translateX(-6px);}
  42%{ transform:translateX(5px);} 68%{ transform:translateX(-3px);} }
.mg-fishing-lives.mg-fishing-danger { border-color:rgba(232,101,122,0.9);
  animation:mg-fishing-lastheart 0.9s ease-in-out infinite; }
@keyframes mg-fishing-lastheart { 50% { box-shadow:0 0 22px rgba(232,101,122,0.7); } }

.mg-fishing-timer { flex:1; max-width:340px; display:flex; flex-direction:column; gap:4px;
  padding:7px 14px 9px; border-radius:16px; background:rgba(9,36,58,0.6);
  border:2px solid rgba(255,255,255,0.32); box-shadow:0 5px 16px rgba(0,0,0,0.3); backdrop-filter:blur(4px); }
.mg-fishing-timer-row { display:flex; justify-content:space-between; align-items:baseline; }
.mg-fishing-clock { font-size:15px; font-weight:900; font-variant-numeric:tabular-nums; }
.mg-fishing-track { height:9px; border-radius:999px; background:rgba(0,0,0,0.35); overflow:hidden; }
.mg-fishing-fill { height:100%; width:100%; border-radius:999px;
  background:linear-gradient(90deg,#7ac74f,#4fb3e8); transition:width 0.12s linear; }
.mg-fishing-timer.mg-fishing-low .mg-fishing-fill { background:linear-gradient(90deg,#f2b64a,#e8657a); }
.mg-fishing-timer.mg-fishing-low { animation:mg-fishing-pulse 0.9s ease-in-out infinite; }
@keyframes mg-fishing-pulse { 50% { border-color:rgba(232,101,122,0.9); } }

.mg-fishing-combo { display:flex; align-items:center; gap:10px; padding:7px 14px; border-radius:999px;
  background:rgba(9,36,58,0.6); border:2px solid rgba(255,255,255,0.32); backdrop-filter:blur(4px);
  box-shadow:0 5px 16px rgba(0,0,0,0.3); }
.mg-fishing-dots { display:flex; gap:5px; }
.mg-fishing-dot { width:11px; height:11px; border-radius:50%; background:rgba(255,255,255,0.2);
  border:2px solid rgba(255,255,255,0.35); transition:background 0.15s ease, transform 0.15s ease; }
.mg-fishing-dot.mg-fishing-on { background:#f2b64a; border-color:#fff6e3; transform:scale(1.15); }
.mg-fishing-mult { font-size:15px; font-weight:900; color:#ffe6a0; opacity:0; transition:opacity 0.2s ease;
  font-variant-numeric:tabular-nums; }
.mg-fishing-combo.mg-fishing-hot { border-color:#f2b64a; box-shadow:0 0 22px rgba(242,182,74,0.6); }
.mg-fishing-combo.mg-fishing-hot .mg-fishing-mult { opacity:1; }

.mg-fishing-quit { pointer-events:auto; margin-left:auto; cursor:pointer; font-family:inherit;
  font-size:13px; font-weight:900; letter-spacing:0.04em; color:#fff6e3; padding:9px 18px;
  border-radius:999px; background:rgba(9,36,58,0.6); border:2px solid rgba(255,255,255,0.32);
  backdrop-filter:blur(4px); transition:background 0.15s ease, transform 0.12s ease; }
.mg-fishing-quit:hover { background:rgba(232,101,122,0.85); transform:scale(1.05); }

.mg-fishing-count { position:absolute; inset:0; display:grid; place-items:center; font-size:min(22vw,180px);
  font-weight:900; color:#fff6e3; text-shadow:0 8px 30px rgba(0,0,0,0.5), 0 0 60px rgba(79,179,232,0.7); }
.mg-fishing-count[hidden] { display:none; }
.mg-fishing-count span { animation:mg-fishing-count 0.85s cubic-bezier(.2,1.4,.4,1) both; display:block; }
@keyframes mg-fishing-count { 0%{ transform:scale(2.4); opacity:0; } 25%{ transform:scale(1); opacity:1; }
  75%{ transform:scale(1); opacity:1; } 100%{ transform:scale(0.7); opacity:0; } }

.mg-fishing-panel { position:absolute; inset:0; display:grid; place-items:center; padding:16px;
  pointer-events:auto; overflow:auto;
  background:radial-gradient(120% 90% at 50% 30%, rgba(6,32,54,0.35), rgba(4,20,36,0.86)); }
.mg-fishing-panel[hidden] { display:none; }
.mg-fishing-card { width:min(600px,100%); background:linear-gradient(180deg,#fffdf6,#ffeecd);
  color:#2d2417; border:5px solid #fff; border-radius:26px; padding:18px 24px 20px;
  box-shadow:0 24px 60px rgba(0,0,0,0.5); text-align:center; position:relative;
  animation:mg-fishing-card 0.32s cubic-bezier(.2,1.3,.4,1) both; }
@keyframes mg-fishing-card { from { transform:translateY(22px) scale(0.94); opacity:0; } }
.mg-fishing-title { font-size:clamp(30px,5.2vw,46px); font-weight:900; letter-spacing:0.02em; color:#e8657a;
  text-shadow:0 3px 0 #fff, 0 5px 0 rgba(45,36,23,0.12); line-height:1.05; }
.mg-fishing-sub { font-size:14px; font-weight:700; color:#8a7a5a; margin-top:2px; }
.mg-fishing-flavor { margin-top:7px; font-size:14.5px; font-weight:800; color:#b4525f; line-height:1.35; }
.mg-fishing-legend { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:5px 10px;
  margin:9px 0 8px; text-align:left; }
.mg-fishing-le { display:flex; align-items:center; gap:8px; background:rgba(79,179,232,0.14);
  border:2px solid rgba(45,36,23,0.08); border-radius:14px; padding:3px 8px; }
.mg-fishing-le canvas { width:58px; height:40px; flex:none; }
.mg-fishing-le b { display:block; font-size:13px; font-weight:900; line-height:1.15; }
.mg-fishing-le i { display:block; font-size:11px; font-style:normal; font-weight:700; color:#8a7a5a; }
.mg-fishing-pts { margin-left:auto; font-size:13px; font-weight:900; color:#2d7d46; white-space:nowrap; }
.mg-fishing-pts.mg-fishing-bad { color:#c0392b; }
.mg-fishing-tip { font-size:13px; font-weight:700; color:#5c5140; line-height:1.42; margin:0 0 4px; }
.mg-fishing-tip b { color:#2d2417; }
.mg-fishing-best { margin-top:10px; font-size:14px; font-weight:800; color:#8a7a5a; }
.mg-fishing-best b { color:#2d2417; }
.mg-fishing-row { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-top:16px; }
.mg-fishing-btn { pointer-events:auto; cursor:pointer; font-family:inherit; font-weight:900; font-size:17px;
  padding:12px 28px; border-radius:999px; border:3px solid #fff; background:#e8657a; color:#fff;
  box-shadow:0 6px 18px rgba(45,36,23,0.3); transition:transform 0.12s ease, filter 0.12s ease; }
.mg-fishing-btn:hover { transform:scale(1.06); filter:brightness(1.06); }
.mg-fishing-btn.mg-fishing-ghost { background:#fffdf6; color:#2d2417; border-color:#e0d2b4; box-shadow:none; }
.mg-fishing-hint { margin-top:11px; font-size:12px; font-weight:800; color:#a2917a; letter-spacing:0.04em;
  animation:mg-fishing-blink 1.6s ease-in-out infinite; }
@keyframes mg-fishing-blink { 50% { opacity:0.35; } }

.mg-fishing-score-big { font-size:clamp(50px,11vw,84px); font-weight:900; color:#f2b64a; line-height:1;
  text-shadow:0 4px 0 #fff, 0 7px 0 rgba(45,36,23,0.14); margin-top:6px; }
.mg-fishing-coins { display:inline-flex; align-items:center; gap:9px; margin-top:12px; padding:9px 20px;
  border-radius:999px; background:#f2b64a; color:#2d2417; font-weight:900; font-size:19px;
  border:3px solid #fff; box-shadow:0 6px 16px rgba(45,36,23,0.24); }
.mg-fishing-coins:before { content:""; width:18px; height:18px; border-radius:50%; background:#fff3c4;
  border:3px solid #c98f22; }
.mg-fishing-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(84px,1fr)); gap:7px;
  margin-top:15px; }
.mg-fishing-stat { background:rgba(45,36,23,0.06); border-radius:12px; padding:7px 4px; }
.mg-fishing-stat b { display:block; font-size:19px; font-weight:900; color:#2d2417; }
.mg-fishing-stat span { font-size:10.5px; font-weight:800; letter-spacing:0.06em; text-transform:uppercase;
  color:#8a7a5a; }
.mg-fishing-ribbon { display:inline-block; margin-bottom:8px; padding:5px 18px; border-radius:999px;
  background:#7ac74f; color:#fff; font-weight:900; font-size:13px; letter-spacing:0.08em;
  text-transform:uppercase; border:3px solid #fff; box-shadow:0 5px 14px rgba(45,36,23,0.25);
  animation:mg-fishing-ribbon 1.1s ease-in-out infinite; }
.mg-fishing-ribbon[hidden] { display:none; }
@keyframes mg-fishing-ribbon { 50% { transform:rotate(-2deg) scale(1.05); } }

/* ---- v2: conditions, journal, rare + legendary cards -------------------- */
.mg-fishing-cond { font-size:13px; font-weight:900; color:#cfe9ff; letter-spacing:0.03em; }
.mg-fishing-cond b { color:#ffe6a0; }

.mg-fishing-tabs { display:flex; gap:8px; justify-content:center; margin:9px 0 2px; }
.mg-fishing-tab { pointer-events:auto; cursor:pointer; font-family:inherit; font-size:13px; font-weight:900;
  letter-spacing:0.05em; text-transform:uppercase; padding:8px 18px; border-radius:999px;
  border:3px solid #e0d2b4; background:#fffdf6; color:#8a7a5a; transition:transform 0.12s ease; }
.mg-fishing-tab:hover { transform:scale(1.05); }
.mg-fishing-tab.mg-fishing-sel { background:#4fb3e8; border-color:#fff; color:#fff; }
.mg-fishing-page[hidden] { display:none; }

.mg-fishing-jrn { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:7px;
  margin:12px 0 4px; text-align:left; max-height:min(46vh,330px); overflow:auto; padding-right:2px; }
.mg-fishing-je { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:14px;
  background:rgba(79,179,232,0.12); border:2px solid rgba(45,36,23,0.08); }
.mg-fishing-je canvas { width:58px; height:40px; flex:none; }
.mg-fishing-je b { display:block; font-size:12.5px; font-weight:900; line-height:1.15; }
.mg-fishing-je i { display:block; font-style:normal; font-size:10.5px; font-weight:800; color:#8a7a5a; }
.mg-fishing-je.mg-fishing-locked canvas { filter:brightness(0.12) saturate(0); opacity:0.5; }
.mg-fishing-je.mg-fishing-locked b { color:#a2917a; }
.mg-fishing-je.mg-fishing-new { border-color:#f2b64a; background:rgba(242,182,74,0.22);
  box-shadow:0 0 0 3px rgba(242,182,74,0.25); }
.mg-fishing-tag { display:inline-block; font-size:9.5px; font-weight:900; letter-spacing:0.08em;
  text-transform:uppercase; padding:1px 7px; border-radius:999px; color:#fff; }
.mg-fishing-jnote { font-size:12px; font-weight:700; color:#8a7a5a; line-height:1.45; margin-top:6px; }

.mg-fishing-rare { position:absolute; top:78px; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:12px; padding:10px 20px 10px 12px; border-radius:22px;
  background:linear-gradient(180deg,#fffdf6,#ffeecd); border:4px solid #fff; color:#2d2417;
  box-shadow:0 16px 40px rgba(0,0,0,0.45); animation:mg-fishing-rare 0.42s cubic-bezier(.2,1.4,.4,1) both;
  max-width:min(420px,88vw); }
.mg-fishing-rare[hidden] { display:none; }
.mg-fishing-rare canvas { width:78px; height:56px; flex:none; }
.mg-fishing-rare > span { display:block; }
.mg-fishing-rare .mg-fishing-rn { display:block; font-size:19px; font-weight:900; line-height:1.1; margin-top:2px; }
.mg-fishing-rare .mg-fishing-rs { display:block; font-size:12px; font-weight:800; color:#8a7a5a; }
.mg-fishing-rare.mg-fishing-out { animation:mg-fishing-rareout 0.4s ease both; }
@keyframes mg-fishing-rare { from { transform:translate(-50%,-26px) scale(0.8); opacity:0; } }
@keyframes mg-fishing-rareout { to { transform:translate(-50%,-20px) scale(0.9); opacity:0; } }

/* NOTE: not .mg-fishing-legend - that class is the instructions legend grid. */
.mg-fishing-lgd { position:absolute; inset:0; display:grid; place-items:center; padding:16px;
  background:radial-gradient(120% 90% at 50% 45%, rgba(12,60,110,0.55), rgba(2,12,26,0.92)); }
.mg-fishing-lgd[hidden] { display:none; }
.mg-fishing-lcard { width:min(520px,100%); text-align:center; color:#fff6e3;
  animation:mg-fishing-lcard 0.6s cubic-bezier(.2,1.3,.4,1) both; }
@keyframes mg-fishing-lcard { from { transform:scale(0.7); opacity:0; } }
.mg-fishing-lkicker { font-size:13px; font-weight:900; letter-spacing:0.42em; text-transform:uppercase;
  color:#ffe6a0; text-indent:0.42em; }
.mg-fishing-lname { font-size:clamp(34px,7vw,62px); font-weight:900; line-height:1.02; color:#fff6e3;
  text-shadow:0 0 40px rgba(242,182,74,0.85), 0 5px 0 rgba(0,0,0,0.35); }
.mg-fishing-lcard canvas { width:min(340px,74vw); height:auto; display:block; margin:6px auto 0; }
.mg-fishing-lstat { display:inline-flex; gap:18px; margin-top:8px; padding:9px 22px; border-radius:999px;
  background:rgba(9,36,58,0.66); border:2px solid rgba(255,255,255,0.34); font-weight:900; font-size:16px; }
.mg-fishing-lstat span { color:#f2b64a; }
`;

export class FishingGame extends Minigame {
  static id = 'fishing';
  static name = 'Reel Rush';

  constructor(game) {
    super(game);
    this.raf = 0;
    this.phase = 'splash'; // splash | countdown | play | results
    this.t = 0;
    this.last = 0;
    this.score = 0;
    this.timeLeft = RUN_SECONDS;
    this.hearts = MAX_HEARTS;
    this.lastHazard = null;
    this.entities = [];
    this.particles = [];
    this.popups = [];
    this.catches = [];
    this.bubbles = [];
    this.shark = null;
    this.sharkWarn = null;
    this.shake = 0;
    this.flash = 0;
    this.danger = 0;
    this.el = {};
    this._hud = {};
    this._listeners = [];

    // ---- v2 state ----------------------------------------------------------
    this.journal = {};          // lifetime, from localStorage
    this.runLog = {};           // this run: kind -> { n, best, fresh }
    this.zone = 'reef';         // depth band the hook is holding
    this.deepT = 0;             // seconds of hook time in the Deep
    this.tension = null;        // the live hook-set beat, if any
    this.legendState = 'idle';  // idle | rising | here | landed | lost
    this.legendWarn = null;
    this.freeze = 0;            // celebration hold: the clock waits, nothing spawns
    this.slow = 0;              // slow-motion tail on the legendary landing
    this.dayT = 0.22;           // world clock phase (0 dawn, .25 noon, .5 dusk)
    this.band = 'day';
    this.weather = 'clear';
    this.aurora = false;
    this._offClock = null;
    this._pendingToast = null;
    this._tab = 'how';
  }

  /**
   * Rarity pays SCORE. Coins are unchanged for every score a v1 run could
   * reach (0.8/point up to 145, which is where the 120-coin server cap used to
   * start truncating), then taper to a ceiling of 119 so an honest run is never
   * silently cut by MINIGAMES.fishing.maxCoinsPerRun.
   */
  coinsForScore(score) {
    const s = Math.max(0, score);
    const base = Math.min(s, 145) * 0.8;                  // 116 at 145
    const tail = Math.min(3, Math.max(0, s - 145) * 0.01); // +3 by 445
    return Math.min(119, Math.round(base + tail));
  }

  // ---- setup ---------------------------------------------------------------

  mount(root) {
    super.mount(root);

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-fishing-wrap';
    wrap.innerHTML = `
      <canvas class="mg-fishing-canvas"></canvas>
      <div class="mg-fishing-ui">
        <header class="mg-fishing-hud" hidden>
          <div class="mg-fishing-pill">
            <span class="mg-fishing-k">Score</span>
            <span class="mg-fishing-v" data-el="score">0</span>
          </div>
          <div class="mg-fishing-lives" data-el="lives">
            <span class="mg-fishing-k">Lives</span>
            <div class="mg-fishing-hrow" data-el="hearts"></div>
          </div>
          <div class="mg-fishing-timer" data-el="timer">
            <div class="mg-fishing-timer-row">
              <span class="mg-fishing-k">Time left</span>
              <span class="mg-fishing-clock" data-el="clock">1:30</span>
            </div>
            <div class="mg-fishing-track"><div class="mg-fishing-fill" data-el="fill"></div></div>
          </div>
          <div class="mg-fishing-combo" data-el="combo">
            <span class="mg-fishing-k">Combo</span>
            <div class="mg-fishing-dots" data-el="dots"></div>
            <span class="mg-fishing-mult" data-el="mult">x2</span>
          </div>
          <div class="mg-fishing-pill">
            <span class="mg-fishing-k">Cove</span>
            <span class="mg-fishing-cond" data-el="cond">Daylight</span>
          </div>
          <button class="mg-fishing-quit" data-a="quit">Quit</button>
        </header>
        <div class="mg-fishing-rare" data-el="rare" hidden></div>
        <div class="mg-fishing-count" data-el="count" hidden></div>
        <div class="mg-fishing-lgd" data-el="legend" hidden></div>
        <div class="mg-fishing-panel" data-el="splash"></div>
        <div class="mg-fishing-panel" data-el="results" hidden></div>
      </div>`;
    root.appendChild(wrap);

    this.wrap = wrap;
    this.canvas = wrap.querySelector('.mg-fishing-canvas');
    this.ctx = this.canvas.getContext('2d');
    for (const n of wrap.querySelectorAll('[data-el]')) this.el[n.dataset.el] = n;

    const dots = this.el.dots;
    for (let i = 0; i < COMBO_NEEDED; i++) {
      const d = document.createElement('span');
      d.className = 'mg-fishing-dot';
      dots.appendChild(d);
    }
    this.dotEls = [...dots.children];

    for (let i = 0; i < MAX_HEARTS; i++) {
      const heart = document.createElement('span');
      heart.className = 'mg-fishing-heart';
      heart.innerHTML = '&#9829;';
      this.el.hearts.appendChild(heart);
    }
    this.heartEls = [...this.el.hearts.children];

    this.journal = loadJournal();
    // The world clock the room is already receiving: take the last frame the
    // engine saw so the cove looks right on frame one, then follow it live.
    const c0 = this.game?.engine?.lastClock;
    if (c0) this._applyClock(c0);
    this._offClock = this.game?.events?.on?.('clock', (m) => this._applyClock(m)) || null;

    this._buildSplash();
    this._layout();
    this._resetScene();
    this._bind();

    this.last = performance.now();
    this._tickBound = (now) => this._tick(now);
    this.raf = requestAnimationFrame(this._tickBound);
  }

  /** Paint one creature into a chip canvas with the live scene's own art. */
  _icon(c, kind, scale = 1.5) {
    const g = c.getContext?.('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.scale(scale, scale);
    if (kind === 'jelly') { g.translate(0, -5); drawJellyArt(g, 9, 0.35, 0); }
    else if (kind === 'boot') drawBootArt(g, 11, 0.2);
    else if (kind === 'shark') drawSharkArt(g, 27, 0.12);
    else drawFishArt(g, kind, clamp(KINDS[kind].r * 0.7, 7, 17), 0.07, 0.4);
    g.restore();
  }

  _paintIcons(scope) {
    for (const c of scope.querySelectorAll('canvas[data-icon]')) {
      this._icon(c, c.dataset.icon, Number(c.dataset.scale) || 1.5);
    }
  }

  _journalHtml(fresh) {
    const cells = KIND_IDS.map((id) => {
      const k = KINDS[id];
      const rec = this.journal[id];
      const rar = RARITY[k.rarity];
      const isNew = !!fresh?.[id];
      const line = rec
        ? `best <b>${fmtKg(rec.best)}</b> &middot; ${rec.n} caught`
        : 'not in the journal yet';
      return `<div class="mg-fishing-je${rec ? '' : ' mg-fishing-locked'}${isNew ? ' mg-fishing-new' : ''}">
        <canvas data-icon="${id}" data-scale="1.35" width="116" height="80"></canvas>
        <span>
          <b>${rec ? k.label : '???'}</b>
          <i><span class="mg-fishing-tag" style="background:${rar.col}">${rar.label}</span></i>
          <i>${line}</i>
        </span>
      </div>`;
    }).join('');
    return `<div class="mg-fishing-jrn">${cells}</div>`;
  }

  _logged() { return KIND_IDS.filter((id) => this.journal[id]).length; }

  /** The pre-run read on the water: what the hour and the sky are offering,
   *  band by band, so the depth choice is an informed one. */
  _condLine() {
    const w = (WEATHER_LABEL[this.weather] || 'Clear').toLowerCase();
    const picks = ZONE_IDS.map((z) => {
      const h = headliner(z, this.band, this.weather);
      return h && RARITY[h.rarity].rank > 0 ? `${ZONES[z].name}: <b>${h.label}</b>` : null;
    }).filter(Boolean);
    return `${BAND_LABEL[this.band]}, ${w}. ${picks.join(' &middot; ')}`;
  }

  _buildSplash() {
    const best = this.game.state?.bests?.[FishingGame.id] || 0;
    const legend = [
      ['small', `+${KINDS.small.points}`, false],
      ['medium', `+${KINDS.medium.points}`, false],
      ['big', `+${KINDS.big.points}`, false],
      ['golden', `+${KINDS.golden.points}`, false],
      ['jelly', '-1 &#9829;', true],
      ['boot', '-1 &#9829;', true],
      ['shark', '-1 &#9829;', true],
    ];
    const rows = legend.map(([kind, pts, bad]) => {
      const meta = KINDS[kind] || HAZARDS[kind];
      return `<div class="mg-fishing-le">
        <canvas data-icon="${kind}" width="128" height="88"></canvas>
        <span><b>${meta.label}</b><i>${meta.hint}</i></span>
        <span class="mg-fishing-pts${bad ? ' mg-fishing-bad' : ''}">${pts}</span>
      </div>`;
    }).join('');

    this.el.splash.innerHTML = `
      <div class="mg-fishing-card">
        <div class="mg-fishing-title">Reel Rush</div>
        <div class="mg-fishing-sub">Driftwood Beach &middot; 90 seconds &middot; 3 hearts</div>
        <div class="mg-fishing-flavor" data-el="splashCond">${this._condLine()}</div>
        <div class="mg-fishing-tabs">
          <button class="mg-fishing-tab mg-fishing-sel" data-tab="how">How to fish</button>
          <button class="mg-fishing-tab" data-tab="journal">Journal ${this._logged()}/${KIND_IDS.length}</button>
        </div>
        <div class="mg-fishing-page" data-el="pageHow">
          <div class="mg-fishing-legend">${rows}</div>
          <p class="mg-fishing-tip">
            Move the <b>mouse</b> (or <b>&uarr; &darr;</b>) to set your hook depth, <b>&larr; &rarr;</b> to lean.
            Touch a fish to reel it in.
            <b>Hook anything that is not a fish and it costs a heart</b>: three hearts gone and the run
            ends there, even with time on the clock.
            Land <b>5 catches</b> in a row without a hazard for <b>double points</b>.
          </p>
          <p class="mg-fishing-tip">
            <b>How deep you hold the line decides who bites.</b> Shallows, Reef and Deep each keep their
            own fish, and the hour and the weather open the rest. Anything rarer than a common takes the
            line first: <b>press Space when the marker hits the green</b> to set the hook. Missing loses
            the fish, never a heart.
          </p>
          <div class="mg-fishing-best">Your best catch: <b>${best}</b> points</div>
        </div>
        <div class="mg-fishing-page" data-el="pageJournal" hidden>
          ${this._journalHtml()}
          <p class="mg-fishing-jnote">Ten species live in the cove. Depth, weather and the hour decide
            which of them are out there right now &mdash; and one of them only comes up for anglers who
            hold the line in the Deep.</p>
        </div>
        <div class="mg-fishing-row">
          <button class="mg-fishing-btn" data-a="start">Cast off!</button>
          <button class="mg-fishing-btn mg-fishing-ghost" data-a="leave">Back to beach</button>
        </div>
        <div class="mg-fishing-hint">Click anywhere or press Space to start</div>
      </div>`;

    // legend + journal icons: the same art routines as the live scene
    this._paintIcons(this.el.splash);
    for (const n of this.el.splash.querySelectorAll('[data-el]')) this.el[n.dataset.el] = n;
    this._selectTab(this._tab);
  }

  _selectTab(tab) {
    this._tab = tab;
    for (const b of this.el.splash.querySelectorAll('[data-tab]')) {
      b.classList.toggle('mg-fishing-sel', b.dataset.tab === tab);
    }
    if (this.el.pageHow) this.el.pageHow.hidden = tab !== 'how';
    if (this.el.pageJournal) this.el.pageJournal.hidden = tab !== 'journal';
  }

  _bind() {
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this._listeners.push([target, type, fn, opts]);
    };

    on(this.wrap, 'pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.hook.targetY = this.pointer.y;
      this.hook.targetX = clamp((this.pointer.x - this.rodTip.x) * 0.45, -78 * this.S, 78 * this.S);
    }, { passive: true });

    on(this.el.splash, 'click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { this._sfx('click'); this._selectTab(tab.dataset.tab); return; }
      // the journal scrolls: a drag inside it must not launch the run
      if (this._tab === 'journal' && e.target.closest('.mg-fishing-jrn')) return;
      const a = e.target.closest('[data-a]');
      if (a?.dataset.a === 'leave') { this._sfx('click'); this.quit(); return; }
      this._sfx('click');
      this._startRun();
    });

    on(this.el.results, 'click', (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      this._sfx('click');
      if (a.dataset.a === 'again') this._startRun();
      else this.exitToRoom();
    });

    on(this.wrap.querySelector('[data-a="quit"]'), 'click', () => { this._sfx('click'); this.quit(); });

    // The hook-set beat takes a press from anywhere: click, tap, Space, Enter.
    on(this.wrap, 'pointerdown', (e) => {
      if (!this.tension || this.phase !== 'play') return;
      if (e.target.closest?.('[data-a],[data-tab]')) return;
      this._setHook();
    });

    on(window, 'keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key;
      if (this.tension && this.phase === 'play' && (k === ' ' || k === 'Enter')) {
        e.preventDefault();
        this._setHook();
        return;
      }
      if (this.phase === 'splash' && (k === ' ' || k === 'Enter')) { e.preventDefault(); this._sfx('click'); this._startRun(); return; }
      // arrows only: W/A/S/D are taken by the world's emote + chat shortcuts
      if (k === 'ArrowUp') { this.keys.up = 1; e.preventDefault(); }
      if (k === 'ArrowDown') { this.keys.down = 1; e.preventDefault(); }
      if (k === 'ArrowLeft') { this.keys.left = 1; e.preventDefault(); }
      if (k === 'ArrowRight') { this.keys.right = 1; e.preventDefault(); }
    });

    on(window, 'keyup', (e) => {
      const k = e.key;
      if (k === 'ArrowUp') this.keys.up = 0;
      if (k === 'ArrowDown') this.keys.down = 0;
      if (k === 'ArrowLeft') this.keys.left = 0;
      if (k === 'ArrowRight') this.keys.right = 0;
    });

    on(window, 'blur', () => { this.keys.up = this.keys.down = this.keys.left = this.keys.right = 0; });
    on(window, 'resize', () => this._layout());
  }

  _layout() {
    const w = Math.max(320, this.root.clientWidth || window.innerWidth);
    const h = Math.max(240, this.root.clientHeight || window.innerHeight);
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    this.S = clamp(Math.min(w / 1280, h / 760), 0.6, 1.45);
    this.waterY = clamp(h * 0.13, 58, 140);
    this.bedH = clamp(h * 0.14, 56, 140);
    this.topLimit = this.waterY + 52 * this.S;
    this.botLimit = h - this.bedH * 0.5;
    this.rodLocal = { x: 96 * this.S, y: -74 * this.S };
    this.boatX = w * 0.5 - this.rodLocal.x;
    this.rodTip = { x: w * 0.5, y: this.waterY + this.rodLocal.y };

    // depth bands: the same water column, cut in three
    const span = this.botLimit - this.topLimit;
    this.zoneY = [
      this.topLimit,
      this.topLimit + span * ZONE_CUTS[0],
      this.topLimit + span * ZONE_CUTS[1],
      this.botLimit,
    ];

    if (this.hook) {
      this.hook.y = clamp(this.hook.y, this.topLimit, this.botLimit);
      this.hook.targetY = clamp(this.hook.targetY, this.topLimit, this.botLimit);
    }
    this._buildDecor();
  }

  /** Which depth band a y sits in. */
  _zoneAt(y) {
    if (y < this.zoneY[1]) return 'shallow';
    if (y < this.zoneY[2]) return 'reef';
    return 'deep';
  }

  /** A y inside a band, with a little margin off each edge. */
  _yInZone(zone) {
    const i = ZONE_IDS.indexOf(zone);
    const a = this.zoneY[i] + 10 * this.S;
    const b = this.zoneY[i + 1] - 10 * this.S;
    return b > a ? rand(a, b) : (a + b) * 0.5;
  }

  _buildDecor() {
    const { w, h, S } = this;
    const bedTop = h - this.bedH;

    this.far = [];
    for (let i = 0; i < 6; i++) {
      this.far.push({
        x: rand(-0.05, 1.05) * w,
        y: bedTop + rand(-0.16, 0.1) * h,
        rx: rand(0.09, 0.2) * w,
        ry: rand(0.06, 0.16) * h,
      });
    }

    this.rays = [];
    for (let i = 0; i < 7; i++) {
      this.rays.push({
        x: (i + rand(0.1, 0.9)) * (w / 7),
        w: rand(26, 72) * S,
        dx: rand(60, 190) * S,
        a: rand(0.05, 0.13),
        spd: rand(0.16, 0.4),
        ph: rand(0, TAU),
      });
    }

    this.kelp = [];
    const kn = Math.round(clamp(w / 118, 8, 18));
    for (let i = 0; i < kn; i++) {
      this.kelp.push({
        x: (i + rand(0.1, 0.9)) * (w / kn),
        h: rand(0.26, 0.56) * h,
        amp: rand(9, 24) * S,
        spd: rand(0.5, 1.05),
        ph: rand(0, TAU),
        w: rand(4.5, 9) * S,
        col: pick(['#2f7d4a', '#3f9b52', '#57ad4f', '#26694a']),
        leaf: pick(['#63bd58', '#4d9b39', '#7ac74f']),
      });
    }

    this.frontKelp = [];
    for (let i = 0; i < 3; i++) {
      this.frontKelp.push({
        x: [w * 0.04, w * 0.96, w * (Math.random() < 0.5 ? 0.16 : 0.85)][i],
        h: rand(0.5, 0.78) * h,
        amp: rand(18, 34) * S,
        spd: rand(0.4, 0.75),
        ph: rand(0, TAU),
        w: rand(11, 17) * S,
        col: '#1d5a3d',
        leaf: '#245f38',
      });
    }

    this.rocks = [];
    for (let i = 0; i < 8; i++) {
      this.rocks.push({
        x: rand(0, w),
        y: bedTop + rand(0.05, 0.65) * this.bedH,
        rx: rand(22, 68) * S,
        ry: rand(12, 34) * S,
        col: pick(['#5d6f7d', '#6f8290', '#4e5f6c']),
      });
    }

    this.corals = [];
    for (let i = 0; i < 9; i++) {
      const arms = [];
      const n = 3 + ((Math.random() * 3) | 0);
      for (let j = 0; j < n; j++) {
        arms.push({ a: rand(-1.15, 1.15), len: rand(16, 44) * S, w: rand(4, 10) * S });
      }
      this.corals.push({
        x: rand(0, w),
        y: bedTop + rand(0.02, 0.4) * this.bedH,
        col: pick(['#e8657a', '#f2857a', '#c86fd4', '#f2b64a', '#ff9ec4']),
        arms,
        ph: rand(0, TAU),
      });
    }

    this.grit = [];
    for (let i = 0; i < 46; i++) {
      this.grit.push({ x: rand(0, w), y: bedTop + rand(6, this.bedH), r: rand(1, 3) * S });
    }

    this.bubbles = [];
    for (let i = 0; i < 52; i++) {
      this.bubbles.push({
        x: rand(0, w),
        y: rand(this.waterY, h),
        r: rand(1.6, 6) * S,
        spd: rand(18, 62) * S,
        wob: rand(6, 20) * S,
        ph: rand(0, TAU),
        a: rand(0.2, 0.5),
      });
    }

    this.clouds = [];
    for (let i = 0; i < 4; i++) {
      this.clouds.push({ x: rand(0, w), y: rand(10, this.waterY * 0.55), s: rand(0.7, 1.5) * S, spd: rand(3, 9) });
    }

    this.gulls = [];
    for (let i = 0; i < 3; i++) {
      this.gulls.push({ x: rand(0, w), y: rand(14, this.waterY * 0.5), s: rand(0.7, 1.2) * S, spd: rand(14, 30) * (Math.random() < 0.5 ? -1 : 1), ph: rand(0, TAU) });
    }

    this.schoolers = [];
    for (let i = 0; i < 16; i++) {
      this.schoolers.push({ x: rand(0, w), y: rand(this.waterY + 40, h - this.bedH), s: rand(2, 5) * S, spd: rand(10, 26) * (Math.random() < 0.5 ? -1 : 1), ph: rand(0, TAU) });
    }

    // night sky + rain, both driven by the world clock frame
    this.stars = [];
    for (let i = 0; i < 46; i++) {
      this.stars.push({ x: rand(0, w), y: rand(4, this.waterY * 0.9), r: rand(0.7, 1.9) * S, ph: rand(0, TAU) });
    }
    this.drops = [];
    for (let i = 0; i < 70; i++) {
      this.drops.push({ x: rand(-40, w), y: rand(-this.waterY, this.waterY), s: rand(0.6, 1.4), spd: rand(560, 900) * S });
    }
    this.ripples = [];
  }

  _resetScene() {
    this.entities.length = 0;
    this.particles.length = 0;
    this.popups.length = 0;
    this.catches.length = 0;
    this.shark = null;
    this.sharkWarn = null;
    this.shake = 0;
    this.flash = 0;
    this.danger = 0;
    this.keys = { up: 0, down: 0, left: 0, right: 0 };
    this.pointer = null;
    this.hook = {
      x: this.rodTip.x,
      y: this.h * 0.45,
      targetY: this.h * 0.45,
      targetX: 0,
      xOff: 0,
      vy: 0,
      stun: 0,
      inv: 0,
    };
    this.hearts = MAX_HEARTS;
    this.lastHazard = null;
    this.spawnIn = 0.6;
    this.bucket = 0;
    this.stats = { small: 0, medium: 0, big: 0, golden: 0, boot: 0, jelly: 0, shark: 0 };
    this.combo = 0;
    this.bestCombo = 0;
    this.multTimer = 0;
    this.nextShark = SHARK_EVERY;

    // v2 per-run state
    this.runLog = {};
    this.zone = this._zoneAt(this.hook.y);
    this.deepT = 0;
    this.tension = null;
    this.legendState = 'idle';
    this.legendWarn = null;
    this.legendMissed = 0;
    this.freeze = 0;
    this.slow = 0;
    this.escaped = 0;
    this.deepAura = 0;
    this._taughtSet = false;
    this.banner = null;
    this.ripples = this.ripples || [];
    this.ripples.length = 0;
    this._hideRare(true);
    if (this.el.legend) { this.el.legend.hidden = true; this.el.legend.innerHTML = ''; }
  }

  // ---- world clock ---------------------------------------------------------

  /**
   * The room's `clock` frame, read straight off the shared road: `dayT` is a
   * continuous phase (0 dawn, .25 noon, .5 dusk, .75 midnight) and `weather` is
   * a WORD, never an envelope.
   */
  _applyClock(m) {
    if (!m) return;
    if (Number.isFinite(m.dayT)) this.dayT = ((m.dayT % 1) + 1) % 1;
    const w = typeof m.weather === 'string' ? m.weather : 'clear';
    this.weather = w === 'rain' || w === 'breeze' ? w : 'clear';
    this.aurora = !!m.aurora;
    this.band = bandOf(this.dayT);
    this._hud.cond = null;   // repaint the pill on the next HUD pass
    if (this.phase === 'splash' && this.el.splashCond) this.el.splashCond.innerHTML = this._condLine();
  }

  // ---- run flow ------------------------------------------------------------

  _startRun() {
    this._resetScene();
    this.score = 0;
    this.timeLeft = RUN_SECONDS;
    this.countdown = 3.3;
    this._done = false; // allow "Play again" to report a fresh run
    this.phase = 'countdown';
    this.el.splash.hidden = true;
    this.el.results.hidden = true;
    this.el.count.hidden = false;
    this.wrap.querySelector('.mg-fishing-hud').hidden = false;
    this._hud = {};
    this._countLabel = '';
    this._updateHud(true);

    // the cove tells you what kind of day it is before the first cast
    const head = headliner(this.zone, this.band, this.weather);
    this._banner(
      `${BAND_LABEL[this.band]}, ${(WEATHER_LABEL[this.weather] || 'clear').toLowerCase()}`,
      head && RARITY[head.rarity].rank > 0
        ? `the ${head.label} is running`
        : 'good water, all the way down',
      3.4,
    );
  }

  /** A two-line headline across the middle of the scene. */
  _banner(title, sub, dur = 2.6, col = '#fff6e3') {
    this.banner = { title, sub, col, t: 0, dur };
  }

  _endRun(reason = 'time') {
    if (this.phase === 'results') return;
    const wiped = reason === 'hearts';
    this.phase = 'results';
    this.tension = null;
    this.freeze = 0;
    this.slow = 0;
    this.banner = null;
    this._hideRare(true);
    if (this.el.legend) this.el.legend.hidden = true;
    this.el.count.hidden = true;
    this.wrap.querySelector('.mg-fishing-hud').hidden = true;

    const score = Math.max(0, Math.round(this.score));
    const prevBest = this.game.state?.bests?.[FishingGame.id] || 0;
    const isBest = score > prevBest;
    const cap = MINIGAMES[FishingGame.id]?.maxCoinsPerRun ?? 120;
    const coins = Math.min(this.coinsForScore(score), cap);

    this.finish(score);
    this._sfx(score >= 60 ? 'success' : 'ding');

    const gotLegend = this.legendState === 'landed';
    const rank = wiped ? 'Out of hearts!'
      : gotLegend ? 'Old Barnacle is yours!'
      : score >= 200 ? 'Master angler!'
      : score >= 150 ? 'Legendary haul!'
      : score >= 105 ? 'Fine day out'
      : score >= 70 ? 'Nice haul!'
      : score >= 40 ? 'Solid catch'
      : 'Better luck next cast';

    const flavor = wiped
      ? `<div class="mg-fishing-flavor">${WIPEOUT[this.lastHazard] || 'The cove wins this round.'}</div>`
      : (this.legendMissed > 0 && !gotLegend)
        ? '<div class="mg-fishing-flavor">Old Barnacle got away. He remembers you now.</div>'
        : '';

    // journal: commit the run, and note which entries are brand new
    const fresh = this._commitJournal();
    const freshIds = Object.keys(fresh);
    const rareCount = KIND_IDS.reduce(
      (n, id) => n + (RARITY[KINDS[id].rarity].rank > 0 ? (this.stats[id] || 0) : 0), 0,
    );

    const journalRibbon = freshIds.length
      ? `<div class="mg-fishing-ribbon">New in the journal: ${freshIds.map((id) => KINDS[id].label).join(', ')}</div>`
      : '';

    const s = this.stats;
    this.el.results.innerHTML = `
      <div class="mg-fishing-card">
        <div class="mg-fishing-ribbon"${isBest ? '' : ' hidden'}>New personal best!</div>
        ${journalRibbon}
        <div class="mg-fishing-title">${rank}</div>
        ${flavor}
        <div class="mg-fishing-score-big">${score}</div>
        <div class="mg-fishing-sub">points</div>
        <div><span class="mg-fishing-coins">+${coins} coins</span></div>
        <div class="mg-fishing-stats">
          <div class="mg-fishing-stat"><b>${s.small}</b><span>Sardines</span></div>
          <div class="mg-fishing-stat"><b>${s.medium}</b><span>Bluefin</span></div>
          <div class="mg-fishing-stat"><b>${s.big}</b><span>Groupers</span></div>
          <div class="mg-fishing-stat"><b>${rareCount}</b><span>Rare+</span></div>
          <div class="mg-fishing-stat"><b>${this.bestCombo}</b><span>Best streak</span></div>
          <div class="mg-fishing-stat"><b>${MAX_HEARTS - this.hearts}</b><span>Hearts lost</span></div>
        </div>
        <div class="mg-fishing-best">Best catch: <b>${Math.max(prevBest, score)}</b> points
          &middot; journal <b>${this._logged()}/${KIND_IDS.length}</b>${
  this.escaped ? ` &middot; <b>${this.escaped}</b> slipped the hook` : ''}</div>
        ${this._journalHtml(fresh)}
        <div class="mg-fishing-row">
          <button class="mg-fishing-btn" data-a="again">Play again</button>
          <button class="mg-fishing-btn mg-fishing-ghost" data-a="leave">Back to beach</button>
        </div>
      </div>`;
    this._paintIcons(this.el.results);
    this.el.results.hidden = false;

    // the toast road: said out loud back on the beach, where it can be seen
    if (gotLegend) {
      this._pendingToast = 'Old Barnacle, landed at last. The whole cove heard that one.';
    } else if (freshIds.length) {
      this._pendingToast = `New in your fish journal: ${freshIds.map((id) => KINDS[id].label).join(', ')}.`;
    }
  }

  /** Fold this run's catches into the lifetime journal. Returns the new ones. */
  _commitJournal() {
    const fresh = {};
    let dirty = false;
    for (const id of KIND_IDS) {
      const r = this.runLog[id];
      if (!r) continue;
      const prev = this.journal[id];
      if (!prev) fresh[id] = true;
      this.journal[id] = {
        n: clamp((prev?.n || 0) + r.n, 1, 999999),
        best: clamp(Math.max(prev?.best || 0, r.best), 0, 999),
      };
      dirty = true;
    }
    if (dirty) saveJournal(this.journal);
    return fresh;
  }

  /** Say the run's headline back in the world, where the toast is visible. */
  exitToRoom() {
    const g = this.game;
    const msg = this._pendingToast;
    this._pendingToast = null;
    super.exitToRoom();
    if (msg) g?.toast?.(msg, 4600);
  }

  _sfx(name) { this.game?.audio?.play?.(name); }

  // ---- update --------------------------------------------------------------

  _tick(now) {
    this.raf = requestAnimationFrame(this._tickBound);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 0.016;
    dt = Math.min(dt, 0.05);
    this.t += dt;
    this._update(dt);
    this._draw();
  }

  _update(dt) {
    // The cove day keeps turning between server frames (one day = 40 min), so
    // a long session can watch the light change mid-run.
    this.dayT = (this.dayT + dt / DAY_SECONDS) % 1;
    const band = bandOf(this.dayT);
    if (band !== this.band) {
      this.band = band;
      this._hud.cond = null;
      if (this.phase === 'play') this._banner(BAND_LABEL[band], 'the light turns, and the water with it', 2.6);
    }
    this._updateWeather(dt);

    // A landing worth watching gets the clock held while it plays out.
    if (this.freeze > 0) {
      this.freeze -= dt;
      this._updateBoat(dt);
      this._updateFx(dt * 0.55);
      if (this.freeze <= 0) {
        this.freeze = 0;
        if (this.el.legend) { this.el.legend.hidden = true; this.el.legend.innerHTML = ''; }
      }
      return;
    }
    if (this.slow > 0) { this.slow = Math.max(0, this.slow - dt); dt *= 0.4; }

    const playing = this.phase === 'play';

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.3);
      const label = this.countdown <= 0.3 ? 'GO!' : String(Math.max(1, n));
      if (label !== this._countLabel) {
        this._countLabel = label;
        this.el.count.innerHTML = `<span>${label}</span>`;
        this._sfx(label === 'GO!' ? 'success' : 'ding');
      }
      if (this.countdown <= -0.35) {
        this.phase = 'play';
        this.el.count.hidden = true;
      }
    }

    if (playing) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this._endRun();
      }
    }

    this._updateBoat(dt);
    this._updateHook(dt);
    this._updateSpawns(dt, playing);
    this._updateEntities(dt, playing);
    this._updateShark(dt, playing);
    this._updateLegend(dt, playing);
    this._updateTension(dt);
    this._collide();
    this._updateFx(dt);

    // last heart: the cove closes in a little
    if (this.phase === 'play' && this.hearts === 1) {
      this.danger = Math.max(this.danger, 0.13 + 0.06 * Math.sin(this.t * 4));
    }

    if (this.multTimer > 0 && this.phase === 'play') {
      this.multTimer = Math.max(0, this.multTimer - dt);
      if (this.multTimer === 0) this._sfx('pop');
    }
    if (this.phase === 'play') this._updateHud(false);
  }

  _updateBoat(dt) {
    const bobY = this.waterY + Math.sin(this.t * 1.5) * 5 * this.S + Math.sin(this.t * 2.7) * 2 * this.S;
    const tilt = Math.sin(this.t * 1.15) * 0.055 + Math.sin(this.t * 2.3) * 0.018;
    this.boat = { x: this.boatX, y: bobY, tilt };
    const c = Math.cos(tilt), s = Math.sin(tilt);
    this.rodTip = {
      x: this.boatX + this.rodLocal.x * c - this.rodLocal.y * s,
      y: bobY + this.rodLocal.x * s + this.rodLocal.y * c,
    };
  }

  _updateHook(dt) {
    const hk = this.hook;
    const speed = 620 * this.S;

    if (hk.inv > 0) {
      hk.inv = Math.max(0, hk.inv - dt);
      if (hk.inv === 0 && this.phase === 'play') {
        // "you're safe again" flourish so the flicker ending is readable
        this._burst(hk.x, hk.y, 8, '#bfe8ff', 130);
        this._sfx('pop');
      }
    }

    if (this.tension) {
      // a fish has the line: the rod holds while you time the set
      hk.targetY = hk.y;
      hk.targetX = hk.xOff;
    } else if (hk.stun > 0) {
      hk.stun -= dt;
      hk.y = clamp(hk.y + 42 * this.S * dt, this.topLimit, this.botLimit);
      hk.targetY = hk.y;
      if (hk.stun <= 0) {
        hk.stun = 0;
        if (this.pointer) hk.targetY = this.pointer.y;
      }
    } else {
      if (this.keys.up) hk.targetY -= speed * dt;
      if (this.keys.down) hk.targetY += speed * dt;
      if (this.keys.left) hk.targetX -= 220 * this.S * dt;
      if (this.keys.right) hk.targetX += 220 * this.S * dt;
      hk.targetX = clamp(hk.targetX, -78 * this.S, 78 * this.S);
      hk.targetY = clamp(hk.targetY, this.topLimit, this.botLimit);
      const prev = hk.y;
      hk.y = lerp(hk.y, hk.targetY, Math.min(1, dt * 11));
      hk.vy = (hk.y - prev) / Math.max(dt, 0.001);
    }

    if (this.phase === 'results') {
      hk.y = lerp(hk.y, this.topLimit - 20 * this.S, Math.min(1, dt * 2.2));
    }

    hk.xOff = lerp(hk.xOff, hk.targetX, Math.min(1, dt * 5));
    hk.x = this.rodTip.x + hk.xOff + Math.sin(this.t * 1.35) * 6 * this.S - clamp(hk.vy, -600, 600) * 0.004;
    if (this.tension) hk.x += Math.sin(this.t * 26) * 3.5 * this.S;   // the fight
    hk.r = 15 * this.S;

    // ---- depth zones ------------------------------------------------------
    // How far you cast IS how deep you hold the line, so the band the hook is
    // sitting in is the water you are fishing. Nothing about the controls
    // changed; what changed is who is down there.
    const z = this._zoneAt(hk.y);
    if (z !== this.zone) {
      this.zone = z;
      this._hud.cond = null;
      if (this.phase === 'play' && (this._zoneSaid || 0) <= 0) {
        this._zoneSaid = 1.1;
        this._popup(hk.x, hk.y - 40 * this.S, ZONES[z].name.toUpperCase(), ZONES[z].col, 0.95);
      }
    }
    this._zoneSaid = Math.max(0, (this._zoneSaid || 0) - dt);

    // Hold the line in the Deep and something old starts paying attention.
    // Night and rain bring him up faster.
    if (this.phase === 'play' && z === 'deep' && this.legendState === 'idle' && !this.tension) {
      const rate = (this.band === 'night' || this.weather === 'rain') ? 1.45 : 1;
      const was = this.deepT;
      this.deepT += dt * rate;
      if (was < DEEP_FILL * 0.55 && this.deepT >= DEEP_FILL * 0.55) this._sfx('pop');
      if (this.deepT >= DEEP_FILL) this._raiseLegend();
    }
  }

  _progress() { return 1 - this.timeLeft / RUN_SECONDS; }

  _updateSpawns(dt, playing) {
    this.spawnIn -= dt;
    if (this.spawnIn > 0) return;

    if (!playing) {
      // attract mode: calm ambient fish while the splash/results card is up
      this.spawnIn = rand(0.8, 1.5);
      if (this.entities.length < 12) this._spawn(pick(['small', 'medium', 'big']));
      return;
    }

    const p = this._progress();
    this.spawnIn = lerp(1.05, 0.46, p) * rand(0.78, 1.24);
    if (this.entities.length > 26) return;

    // Most rolls happen in the water the player is actually fishing, so the
    // depth choice reads immediately; the rest keep the whole column alive.
    const zone = Math.random() < 0.62 ? this.zone : ZONE_IDS[(Math.random() * 3) | 0];
    const kind = weightedPick(spawnTable(p, zone, this.band, this.weather));
    // Hazards are untouched from v1: same weights, same free-range depth.
    const isFish = !!KINDS[kind];
    if (kind === 'small' && Math.random() < 0.34) {
      // a little school swims through together
      const dir = Math.random() < 0.5 ? 1 : -1;
      const y = this._yInZone(zone);
      const n = 3 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const e = this._spawn('small', dir, y + rand(-16, 16) * this.S);
        e.x -= dir * i * 62 * this.S;
      }
    } else {
      this._spawn(kind, 0, isFish ? this._yInZone(zone) : rand(this.topLimit + 12, this.botLimit - 12));
    }
  }

  _spawn(kind, forceDir, forceY) {
    const dir = forceDir || (Math.random() < 0.5 ? 1 : -1);
    const p = this.phase === 'play' ? this._progress() : 0;
    const y = forceY != null ? forceY : rand(this.topLimit + 12, this.botLimit - 12);
    const e = {
      kind,
      dir,
      y: clamp(y, this.topLimit + 8, this.botLimit - 8),
      ph: rand(0, TAU),
      rot: 0,
      dead: false,
      waved: false,       // set while it overlaps a hook that cannot dodge
    };
    e.baseY = e.y;

    if (KINDS[kind]) {
      const k = KINDS[kind];
      e.r = k.r * this.S;
      e.speed = k.speed * this.w * lerp(1, 1.55, p) * rand(0.88, 1.14);
      e.hitR = e.r * 1.25;
      e.bobAmp = rand(4, 14) * this.S;
      e.bobSpd = rand(0.8, 1.9);
    } else if (kind === 'jelly') {
      e.r = rand(15, 21) * this.S;
      e.speed = rand(0.03, 0.07) * this.w * lerp(1, 1.3, p);
      e.hitR = e.r * 1.3;
      e.bobAmp = rand(10, 24) * this.S;
      e.bobSpd = rand(0.5, 0.9);
    } else {
      e.r = rand(13, 18) * this.S;
      e.speed = rand(0.04, 0.09) * this.w;
      e.hitR = e.r * 1.25;
      e.sink = rand(6, 20) * this.S;
      e.spin = rand(-0.7, 0.7);
      e.bobAmp = 0;
      e.bobSpd = 1;
    }

    const margin = e.r * 3 + 30;
    e.x = dir > 0 ? -margin : this.w + margin;
    this.entities.push(e);
    return e;
  }

  _updateEntities(dt) {
    const out = this.w * 0.14 + 90;
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      e.x += e.dir * e.speed * dt;
      if (e.kind === 'boot') {
        e.baseY = Math.min(e.baseY + e.sink * dt, this.botLimit + 30);
        e.y = e.baseY;
        e.rot += e.spin * dt;
      } else {
        e.baseY += Math.sin(this.t * 0.6 + e.ph) * 6 * this.S * dt;
        e.baseY = clamp(e.baseY, this.topLimit, this.botLimit);
        e.y = e.baseY + Math.sin(this.t * e.bobSpd + e.ph) * e.bobAmp;
      }
      // rare fish trail a little sparkle so they read across a busy screen
      const rank = KINDS[e.kind] ? RARITY[KINDS[e.kind].rarity].rank : 0;
      if (rank >= 2 && Math.random() < dt * (e.legend ? 16 : 8)) {
        this.particles.push({
          x: e.x, y: e.y, vx: -e.dir * 20, vy: rand(-14, 14), life: 0.5, dur: 0.5,
          r: rand(1.4, 3) * this.S, col: e.legend ? '#bfe0ff' : '#ffe9a8', type: 'spark',
        });
      }
      const gone = e.x < -out || e.x > this.w + out || e.baseY > this.botLimit + 26;
      if (e.dead || gone) {
        if (e.legend && gone && !e.dead) this._legendLost();
        this.entities.splice(i, 1);
      }
    }
  }

  _updateShark(dt, playing) {
    if (playing) {
      const elapsed = RUN_SECONDS - this.timeLeft;
      if (!this.shark && !this.sharkWarn && elapsed >= this.nextShark - 1.5 && elapsed < this.nextShark + 4) {
        this.sharkWarn = {
          t: 1.5,
          dir: Math.random() < 0.5 ? 1 : -1,
          y: rand(this.topLimit + 30 * this.S, this.botLimit - 24 * this.S),
        };
      }
    }

    if (this.sharkWarn) {
      this.sharkWarn.t -= dt;
      this.danger = Math.max(this.danger, 0.35 + 0.25 * Math.sin(this.t * 14));
      if (this.sharkWarn.t <= 0) {
        const wn = this.sharkWarn;
        this.sharkWarn = null;
        this.nextShark += SHARK_EVERY;
        this.shark = {
          dir: wn.dir,
          y: wn.y,
          x: wn.dir > 0 ? -this.w * 0.22 : this.w * 1.22,
          L: 96 * this.S,
          speed: this.w * 0.72,
          ph: 0,
        };
        this._sfx('whoosh');
        this.shake = Math.max(this.shake, 6);
      }
    }

    const sh = this.shark;
    if (!sh) return;
    sh.x += sh.dir * sh.speed * dt;
    sh.ph += dt;
    sh.y += Math.sin(this.t * 1.6) * 12 * this.S * dt;
    this.danger = Math.max(this.danger, 0.28);

    // wake bubbles
    if (Math.random() < dt * 34) {
      this.particles.push({
        x: sh.x - sh.dir * sh.L * 0.8, y: sh.y + rand(-20, 20) * this.S,
        vx: -sh.dir * rand(30, 90), vy: rand(-30, -6), life: 0.7, dur: 0.7,
        r: rand(2, 5) * this.S, col: 'rgba(255,255,255,0.7)', type: 'bubble',
      });
    }

    // chomp anything fishy in the path
    const mouthX = sh.x + sh.dir * sh.L * 0.72;
    for (const e of this.entities) {
      if (e.dead || !KINDS[e.kind] || e.legend) continue;   // nothing eats Old Barnacle
      if (Math.abs(e.x - mouthX) < sh.L * 0.45 && Math.abs(e.y - sh.y) < sh.L * 0.34) {
        e.dead = true;
        this._burst(e.x, e.y, 9, KINDS[e.kind].body, 150);
        this._sfx('pop');
      }
    }

    // The hook cannot dodge while a fish has it, so a scripted beat is not a
    // place to lose a heart. Hazard rates, damage and i-frames are otherwise
    // exactly as they shipped.
    if (this.phase === 'play' && this.hook.inv <= 0 && !this.tension) {
      if (Math.abs(this.hook.x - sh.x) < sh.L * 0.85 && Math.abs(this.hook.y + 6 * this.S - sh.y) < sh.L * 0.38) {
        this.stats.shark++;
        this._burst(this.hook.x, this.hook.y, 12, '#d6e4ee', 200);
        this._damage('shark');
      }
    }

    if (sh.x < -this.w * 0.3 || sh.x > this.w * 1.3) this.shark = null;
  }

  _collide() {
    if (this.phase !== 'play') return;
    const hk = this.hook;
    const hx = hk.x;
    const hy = hk.y + 7 * this.S;
    // The hook cannot dodge while it is pinned (a hook-set beat, or the stun
    // after a hit), so a hazard that drifts onto it then is not merely
    // deferred to the frame the pin ends: it is WAVED THROUGH. The mark stays
    // on it until it has drifted clear again, which matters because a jelly
    // crawls at ~40px/s and can sit on the hook for well over a second.
    const pinned = hk.stun > 0 || !!this.tension;

    for (const e of this.entities) {
      if (e.dead) continue;
      const dx = e.x - hx;
      const dy = e.y - hy;
      const rr = e.hitR + hk.r;
      const touching = dx * dx + dy * dy <= rr * rr;

      if (!KINDS[e.kind]) {
        // hazards: i-frames and pins shrug them off, and one that overlapped
        // during either is harmless until it separates
        if (!touching) { e.waved = false; continue; }
        if (pinned || hk.inv > 0) { e.waved = true; continue; }
        if (e.waved) continue;
      } else {
        // fish are still catchable while flickering, but never while pinned
        if (pinned || !touching) continue;
      }

      if (KINDS[e.kind]) {
        e.dead = true;
        // Commons land on contact, exactly as they always have. Anything up the
        // ladder takes the line first and has to be set.
        if (KINDS[e.kind].beats > 0) { this._startTension(e); break; }
        this._land(e.kind, e.x, e.y, e.r, e.dir, e.ph, 0);
      } else if (e.kind === 'jelly') {
        e.dead = true;
        this.stats.jelly++;
        this._burst(e.x, e.y, 14, '#ff9ee0', 190);
        this._damage('jelly');
      } else {
        e.dead = true;
        this.stats.boot++;
        // the boot still gets reeled in, it just costs a heart instead of points
        this.catches.push({
          kind: 'boot', x0: e.x, y0: e.y, r: e.r, dir: e.dir, t: 0,
          dur: 0.4 + Math.abs(e.y - this.rodTip.y) / (this.h * 3.2), ph: e.ph, spin: rand(-8, 8),
        });
        this._damage('boot');
      }
      break; // one thing per frame keeps the feedback readable
    }
  }

  /**
   * A fish is landed. Every catch in the game goes through here: the contact
   * catch for commons and the won hook-set for everything above them.
   * Returns the rolled weight so the caller can show it off.
   */
  _land(kind, x, y, r, dir, ph, bonus = 0) {
    const k = KINDS[kind];
    const rank = RARITY[k.rarity].rank;
    const mult = this.multTimer > 0 ? 2 : 1;
    const pts = k.points * mult + bonus;
    this.score += pts;
    this.stats[kind] = (this.stats[kind] || 0) + 1;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);

    const w = rand(k.wt[0], k.wt[1]);
    const rec = this.runLog[kind] || (this.runLog[kind] = { n: 0, best: 0 });
    rec.n++;
    rec.best = Math.max(rec.best, w);

    this._popup(x, y, `+${pts}`, rank > 0 ? '#ffe27a' : '#fff6e3', rank > 0 ? 1.4 : 1);
    if (rank > 0) this._popup(x, y + 22 * this.S, fmtKg(w), '#cfe9ff', 0.85);
    this._burst(x, y, rank >= 2 ? 15 : 7, rank > 0 ? '#ffe9a8' : '#cfefff', rank >= 2 ? 220 : 140);
    this.catches.push({
      kind, x0: x, y0: y, r, dir, t: 0,
      dur: 0.32 + Math.abs(y - this.rodTip.y) / (this.h * 3.2), ph, spin: rand(-6, 6),
    });
    this._sfx('splash');
    this.shake = Math.max(this.shake, k.r > 22 ? 5 : 3);
    if (rank > 0) this.flash = Math.max(this.flash, 0.35 + 0.2 * rank);
    if (rank === 2) this._rareCard(kind, w, pts);

    if (this.combo > 0 && this.combo % COMBO_NEEDED === 0) {
      const fresh = this.multTimer <= 0;
      this.multTimer = COMBO_TIME;
      this._sfx('ding');
      this.flash = Math.max(this.flash, 0.75);
      this._popup(this.w * 0.5, this.h * 0.36, fresh ? 'COMBO x2!' : 'x2 EXTENDED!', '#ffdc7a', 1.9);
    }
    return w;
  }

  // ---- the hook-set beat ---------------------------------------------------
  /*
   * A fish above common does not simply arrive: it takes the line, and one
   * press at the right beat sets the hook. The window is deliberately wide
   * (the needle spends over 40% of its sweep inside it) and the only thing a
   * miss can ever cost is the fish. Hearts are hazards' business, exclusively.
   */

  _startTension(e) {
    const k = KINDS[e.kind];
    const legend = k.rarity === 'legendary';
    this.tension = {
      kind: e.kind, x: e.x, y: e.y, r: e.r, dir: e.dir, ph: e.ph,
      beats: k.beats, beat: 0,
      pos: 0, dirn: 1,
      speed: legend ? 0.6 : 0.72,       // full sweeps per second
      win: legend ? 0.46 : 0.42,        // fraction of the bar that lands it
      life: 0, limit: legend ? 3.6 : 3.2,
      perfect: 0, lock: 0.15,
    };
    this._sfx('whoosh');
    this.shake = Math.max(this.shake, legend ? 12 : 4);
    if (legend) this._banner('OLD BARNACLE HAS IT', 'set the hook. three times.', 2.2, '#f2b64a');
    else if (!this._taughtSet) {
      this._taughtSet = true;
      this._banner('ON THE LINE', 'press SPACE (or click) on the green', 2.2, '#cfe9ff');
    }
  }

  _updateTension(dt) {
    const T = this.tension;
    if (!T) return;
    if (this.phase !== 'play') { this.tension = null; return; }
    T.lock = Math.max(0, T.lock - dt);
    T.life += dt;
    T.pos += T.dirn * T.speed * dt * 2;
    if (T.pos >= 1) { T.pos = 1; T.dirn = -1; }
    else if (T.pos <= 0) { T.pos = 0; T.dirn = 1; }
    this.danger = Math.max(this.danger, 0.06);
    if (Math.random() < dt * 20) {
      this.particles.push({
        x: this.hook.x + rand(-14, 14) * this.S, y: this.hook.y + rand(-10, 10) * this.S,
        vx: rand(-40, 40), vy: rand(-70, -20), life: 0.5, dur: 0.5,
        r: rand(1.6, 3.4) * this.S, col: 'rgba(255,255,255,0.75)', type: 'bubble',
      });
    }
    if (T.life > T.limit) this._loseTension('SLIPPED!');
  }

  /** One press on the beat. */
  _setHook() {
    const T = this.tension;
    if (!T || T.lock > 0) return;
    const d = Math.abs(T.pos - 0.5);
    if (d > T.win * 0.5) { this._loseTension('SNAP!'); return; }

    const perfect = d < T.win * 0.16;
    if (perfect) T.perfect++;
    T.beat++;
    this._sfx(perfect ? 'success' : 'ding');
    this.shake = Math.max(this.shake, perfect ? 7 : 4);
    this._burst(this.hook.x, this.hook.y, perfect ? 13 : 6, perfect ? '#ffe27a' : '#cfefff', 180);
    // stagger the beats so a three-beat fight does not stack three shouts on
    // the same pixel
    const side = T.beats > 1 ? (T.beat % 2 ? -1 : 1) * 62 * this.S : 0;
    this._popup(
      this.hook.x + side, this.hook.y - (44 + (T.beat - 1) * 26) * this.S,
      perfect ? 'PERFECT!' : 'SET!', perfect ? '#ffe27a' : '#cfefff', perfect ? 1.5 : 1.15,
    );
    if (T.beat >= T.beats) { this._winTension(); return; }
    // the next beat is tighter and faster, and it starts from the far end
    T.pos = T.dirn > 0 ? 0 : 1;
    T.life = 0;
    T.lock = 0.12;
    T.win = Math.max(0.28, T.win - 0.07);
    T.speed += 0.16;
  }

  _winTension() {
    const T = this.tension;
    this.tension = null;
    this._setGrace();
    if (!T) return;
    const k = KINDS[T.kind];
    const legend = k.rarity === 'legendary';
    const bonus = T.perfect * (legend ? 5 : 2);
    const w = this._land(T.kind, this.hook.x, this.hook.y, T.r, T.dir, T.ph, bonus);
    if (legend) this._legendLanded(w, k.points * (this.multTimer > 0 ? 2 : 1) + bonus);
  }

  /**
   * The beat is over and the rod lets go. The player has been unable to move
   * for up to 3.6s, so the water around the hook is given away for a breath:
   * nothing that arrives in that moment could have been dodged.
   */
  _setGrace() {
    this.hook.inv = Math.max(this.hook.inv, SET_GRACE);
  }

  /** The fish goes. That is the whole price: no heart, no combo reset. */
  _loseTension(word) {
    const T = this.tension;
    this.tension = null;
    this._setGrace();
    if (!T) return;
    this.escaped = (this.escaped || 0) + 1;
    // NOT the 'fail' sting: that sound means a heart in this game and must
    // keep meaning exactly that.
    this._sfx('pop');
    this._popup(this.hook.x, this.hook.y - 34 * this.S, word, '#bfe8ff', 1.3);
    this._popup(this.hook.x, this.hook.y + 12 * this.S, 'the fish, not a heart', '#cfe9ff', 0.72);
    this.shake = Math.max(this.shake, 5);
    this._burst(this.hook.x, this.hook.y, 10, 'rgba(220,244,255,0.9)', 200);
    if (KINDS[T.kind].rarity === 'legendary') this._legendLost();
  }

  // ---- Old Barnacle --------------------------------------------------------

  _raiseLegend() {
    if (this.legendState !== 'idle') return;
    this.legendState = 'rising';
    this.deepT = 0;
    this.legendWarn = { t: 2.3, dir: Math.random() < 0.5 ? 1 : -1 };
    this._banner('THE DEEP STIRS', 'something old is coming up', 2.6, '#9db0ff');
    this._sfx('whoosh');
    this.shake = Math.max(this.shake, 9);
  }

  _updateLegend(dt, playing) {
    const wn = this.legendWarn;
    if (wn) {
      wn.t -= dt;
      this.deepAura = Math.max(this.deepAura || 0, 0.55 + 0.25 * Math.sin(this.t * 6));
      if (wn.t <= 0) {
        this.legendWarn = null;
        if (!playing) { this.legendState = 'idle'; return; }
        const e = this._spawn('barnacle', wn.dir, this._yInZone('deep'));
        e.legend = true;
        this.legendState = 'here';
        this._sfx('whoosh');
        this.shake = Math.max(this.shake, 10);
      }
    }
    if (this.legendState === 'here') this.deepAura = Math.max(this.deepAura || 0, 0.34);
    this.deepAura = Math.max(0, (this.deepAura || 0) - dt * 1.1);
  }

  _legendLost() {
    if (this.legendState !== 'here') return;
    this.legendState = 'idle';
    this.legendMissed = (this.legendMissed || 0) + 1;
    this.deepT = DEEP_FILL * 0.45;    // he can be called back up, if there is time
    this._banner('HE SINKS BACK', 'hold the Deep and he will come again', 2.4, '#9db0ff');
  }

  _legendLanded(weight, pts) {
    this.legendState = 'landed';
    this._hideRare(true);   // one card at a time: this moment is his
    this.freeze = 3.6;
    this.slow = 1.2;
    this.flash = 1;
    this.shake = 22;
    this.banner = null;
    this._sfx('success');
    this._splashAt(this.rodTip.x, this._waveY(this.rodTip.x, this.t));
    for (let i = 0; i < 3; i++) {
      this._burst(this.hook.x + rand(-40, 40) * this.S, this.hook.y + rand(-30, 30) * this.S, 16, '#ffe9a8', 260);
    }
    const el = this.el.legend;
    if (!el) return;
    el.innerHTML = `
      <div class="mg-fishing-lcard">
        <div class="mg-fishing-lkicker">Legendary catch</div>
        <div class="mg-fishing-lname">Old Barnacle</div>
        <canvas data-icon="barnacle" data-scale="3.4" width="520" height="300"></canvas>
        <div class="mg-fishing-lstat">
          <span>${fmtKg(weight)}</span><span>+${pts} points</span>
        </div>
      </div>`;
    this._paintIcons(el);
    el.hidden = false;
    this._pendingToast = 'Old Barnacle, landed at last. The whole cove heard that one.';
  }

  // ---- the rare-catch card -------------------------------------------------

  _rareCard(kind, weight, pts) {
    const el = this.el.rare;
    if (!el) return;
    const k = KINDS[kind];
    const rar = RARITY[k.rarity];
    el.innerHTML = `
      <canvas data-icon="${kind}" data-scale="2" width="156" height="112"></canvas>
      <span>
        <span class="mg-fishing-tag" style="background:${rar.col}">${rar.label} catch</span>
        <span class="mg-fishing-rn">${k.label}</span>
        <span class="mg-fishing-rs">${fmtKg(weight)} &middot; +${pts} points</span>
      </span>`;
    this._paintIcons(el);
    el.classList.remove('mg-fishing-out');
    el.hidden = false;
    void el.offsetWidth;
    this._rareT = 2.8;
    // the existing toast road, said the moment it happens
    this.game?.toast?.(`${rar.label} catch: ${k.label}, ${fmtKg(weight)}!`, 2600);
  }

  _hideRare(now) {
    const el = this.el.rare;
    if (now) this._rareT = 0;
    if (!el) return;
    if (now) { el.hidden = true; el.classList.remove('mg-fishing-out'); return; }
    el.classList.add('mg-fishing-out');
  }

  /** One heart gone. Every non-fish in the cove routes through here. */
  _damage(kind) {
    const hk = this.hook;
    if (this.phase !== 'play' || hk.inv > 0) return;

    this.hearts = Math.max(0, this.hearts - 1);
    this.lastHazard = kind;
    hk.inv = INVULN_TIME;
    hk.stun = HIT_STUN;
    this.combo = 0;
    this.multTimer = 0;
    this.shake = Math.max(this.shake, 13);
    this.danger = Math.max(this.danger, 0.85);
    this._popup(hk.x, hk.y - 18 * this.S, HAZARDS[kind]?.hit || 'OUCH!', '#ffe27a', 1.5);
    this._popup(hk.x, hk.y + 16 * this.S, `-1 ${HEART}`, '#ff9a9a', 1.15);
    this._sfx('fail');
    this._updateHud(false);

    if (this.hearts <= 0) {
      this.shake = Math.max(this.shake, 18);
      this._endRun('hearts');
    }
  }

  _popup(x, y, text, col, scale = 1) {
    this.popups.push({ x, y, text, col, scale, t: 0, dur: 1.05 });
  }

  _burst(x, y, n, col, spread) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const s = rand(0.35, 1) * spread * this.S;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40,
        life: rand(0.35, 0.7), dur: 0.7, r: rand(1.6, 4.2) * this.S, col, type: 'spark',
      });
    }
  }

  _splashAt(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = rand(-Math.PI * 0.86, -Math.PI * 0.14);
      const s = rand(80, 250) * this.S;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rand(0.4, 0.8), dur: 0.8, r: rand(2, 5) * this.S,
        col: 'rgba(226,246,255,0.95)', type: 'drop', g: 700 * this.S,
      });
    }
    this.particles.push({ x, y, life: 0.5, dur: 0.5, r: 8 * this.S, col: 'rgba(255,255,255,0.85)', type: 'ring', vx: 0, vy: 0 });
  }

  _updateFx(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.type === 'drop') p.vy += (p.g || 700) * dt;
      else if (p.type === 'bubble') p.vy -= 30 * dt;
      else { p.vx *= 1 - dt * 2.6; p.vy *= 1 - dt * 2.6; }
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      p.y -= 46 * this.S * dt;
      if (p.t >= p.dur) this.popups.splice(i, 1);
    }

    for (let i = this.catches.length - 1; i >= 0; i--) {
      const c = this.catches[i];
      c.t += dt;
      if (c.t >= c.dur) {
        this.catches.splice(i, 1);
        const wy = this._waveY(this.rodTip.x, this.t);
        this._splashAt(this.rodTip.x, wy);
        if (c.kind !== 'boot') {
          this._sfx('coin');
          this.bucket = Math.min(6, (this.bucket || 0) + 1);
        }
      }
    }

    // ambient bubbles
    for (const b of this.bubbles) {
      b.y -= b.spd * dt;
      if (b.y < this.waterY + 6) {
        b.y = this.h + rand(0, 40);
        b.x = rand(0, this.w);
      }
    }
    for (const c of this.clouds) {
      c.x += c.spd * dt;
      if (c.x - 90 * c.s > this.w) c.x = -90 * c.s;
    }
    for (const g of this.gulls) {
      g.x += g.spd * dt;
      if (g.x < -40) g.x = this.w + 40;
      if (g.x > this.w + 40) g.x = -40;
    }
    for (const s of this.schoolers) {
      s.x += s.spd * dt;
      if (s.x < -20) s.x = this.w + 20;
      if (s.x > this.w + 20) s.x = -20;
    }

    this.shake = Math.max(0, this.shake - dt * 26);
    this.flash = Math.max(0, this.flash - dt * 2.1);
    this.danger = Math.max(0, this.danger - dt * 1.4);

    if (this._rareT > 0) {
      this._rareT -= dt;
      if (this._rareT <= 0.4 && this.el.rare && !this.el.rare.classList.contains('mg-fishing-out')) {
        this._hideRare(false);
      }
      if (this._rareT <= 0) {
        this._rareT = 0;
        if (this.el.rare) this.el.rare.hidden = true;
      }
    }
    if (this.banner) {
      this.banner.t += dt;
      if (this.banner.t >= this.banner.dur) this.banner = null;
    }
  }

  /** Rain and wind, eased so the weather never snaps between frames. */
  _updateWeather(dt) {
    const k = Math.min(1, dt * 0.55);
    this.rainAmt = lerp(this.rainAmt || 0, this.weather === 'rain' ? 1 : 0, k);
    this.breeze = lerp(this.breeze || 0, this.weather === 'breeze' ? 1 : 0, k);
    if (!this.pal || Math.abs(this.dayT - (this._palT ?? -9)) > 0.0006) {
      this._palT = this.dayT;
      this.pal = paletteAt(this.dayT);
    }
    const ripples = this.ripples || (this.ripples = []);
    if (this.rainAmt > 0.02 && this.drops) {
      for (const d of this.drops) {
        d.y += d.spd * dt * (0.55 + this.rainAmt * 0.65);
        d.x += 120 * d.s * dt;
        if (d.y > this._waveY(d.x, this.t) || d.x > this.w + 30) {
          d.y = rand(-this.waterY, -6);
          d.x = rand(-60, this.w);
          if (ripples.length < 24 && Math.random() < 0.45) ripples.push({ x: d.x, t: 0 });
        }
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].t += dt;
      if (ripples[i].t > 0.8) ripples.splice(i, 1);
    }
  }

  _updateHud(force) {
    const h = this._hud;
    const score = Math.round(this.score);
    if (force || h.score !== score) {
      h.score = score;
      this.el.score.textContent = score;
      this.el.score.classList.remove('mg-fishing-bump');
      void this.el.score.offsetWidth;
      this.el.score.classList.add('mg-fishing-bump');
    }
    const hearts = this.hearts;
    if (force || h.hearts !== hearts) {
      const lost = h.hearts != null && hearts < h.hearts;
      h.hearts = hearts;
      for (let i = 0; i < this.heartEls.length; i++) {
        const el = this.heartEls[i];
        const gone = i >= hearts;
        el.classList.toggle('mg-fishing-gone', gone);
        if (lost && i === hearts) {
          el.classList.remove('mg-fishing-break');
          void el.offsetWidth;
          el.classList.add('mg-fishing-break');
        } else if (!gone) {
          el.classList.remove('mg-fishing-break');
        }
      }
      this.el.lives.classList.toggle('mg-fishing-danger', hearts === 1);
      if (lost) {
        this.el.lives.classList.remove('mg-fishing-hurt');
        void this.el.lives.offsetWidth;
        this.el.lives.classList.add('mg-fishing-hurt');
      }
    }
    const clock = fmtTime(this.timeLeft);
    if (force || h.clock !== clock) {
      h.clock = clock;
      this.el.clock.textContent = clock;
    }
    const pct = Math.round((this.timeLeft / RUN_SECONDS) * 1000) / 10;
    if (force || h.pct !== pct) {
      h.pct = pct;
      this.el.fill.style.width = `${pct}%`;
      this.el.timer.classList.toggle('mg-fishing-low', this.timeLeft <= 15);
    }
    const dots = this.combo % COMBO_NEEDED;
    if (force || h.dots !== dots) {
      h.dots = dots;
      for (let i = 0; i < this.dotEls.length; i++) this.dotEls[i].classList.toggle('mg-fishing-on', i < dots);
    }
    const cond = `${BAND_LABEL[this.band]}${this.weather === 'clear' ? '' : ` &middot; ${WEATHER_LABEL[this.weather]}`} &middot; <b>${ZONES[this.zone].name}</b>`;
    if (force || h.cond !== cond) {
      h.cond = cond;
      if (this.el.cond) this.el.cond.innerHTML = cond;
    }
    const hot = this.multTimer > 0;
    const mult = hot ? `x2 ${Math.ceil(this.multTimer)}s` : '';
    if (force || h.mult !== mult) {
      h.mult = mult;
      this.el.mult.textContent = mult;
      this.el.combo.classList.toggle('mg-fishing-hot', hot);
    }
  }

  // ---- draw ----------------------------------------------------------------

  _waveY(x, t) {
    const a = 1 + (this.breeze || 0) * 0.75;
    return this.waterY + Math.sin(x * 0.011 + t * 1.5) * 5 * this.S * a + Math.sin(x * 0.029 - t * 2.2) * 2.2 * this.S * a;
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.shake > 0.05) {
      ctx.translate(rand(-1, 1) * this.shake, rand(-1, 1) * this.shake);
    }
    ctx.clearRect(-20, -20, w + 40, h + 40);

    this._drawSky(ctx);
    this._drawWater(ctx);
    this._drawFar(ctx);
    this._drawRays(ctx);
    this._drawSchoolers(ctx);
    this._drawBed(ctx);
    this._drawKelp(ctx, this.kelp, 1);
    this._drawDepthWash(ctx);
    this._drawBubbles(ctx, 0.55);
    this._drawEntities(ctx);
    if (this.shark) this._drawShark(ctx);
    this._drawSharkWarning(ctx);
    this._drawCatches(ctx);
    this._drawLineAndHook(ctx);
    this._drawParticles(ctx);
    this._drawBubbles(ctx, 1.35);
    this._drawKelp(ctx, this.frontKelp, 0.62);
    this._drawSurface(ctx);
    this._drawBoat(ctx);
    this._drawRain(ctx);
    this._drawDepthGauge(ctx);
    this._drawTension(ctx);
    this._drawPopups(ctx);
    this._drawBanner(ctx);
    this._drawOverlays(ctx);
  }

  _drawSky(ctx) {
    const { w } = this;
    const P = this.pal || (this.pal = paletteAt(this.dayT));
    const skyH = this.waterY + 10;
    const g = ctx.createLinearGradient(0, 0, 0, skyH);
    g.addColorStop(0, rgbStr(P.top));
    g.addColorStop(0.62, rgbStr(P.mid));
    g.addColorStop(1, rgbStr(P.low));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, skyH);

    // stars, only once the sky is dark enough to hold them
    if (P.star > 0.03 && this.stars) {
      for (const s of this.stars) {
        ctx.globalAlpha = P.star * (0.45 + 0.55 * Math.abs(Math.sin(this.t * 1.4 + s.ph)));
        ctx.fillStyle = '#fff6e3';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // one light on an arc: the sun from dawn to dusk, the moon after
    const day = this.dayT < 0.5;
    const u = day ? this.dayT / 0.5 : (this.dayT - 0.5) / 0.5;
    const sx = w * (0.08 + 0.84 * u);
    const sy = skyH * (1.04 - 0.86 * Math.sin(clamp(u, 0, 1) * Math.PI));
    const sr = (day ? 19 : 15) * this.S;
    ctx.fillStyle = `rgba(${P.sun[0] | 0},${P.sun[1] | 0},${P.sun[2] | 0},0.42)`;
    ctx.beginPath();
    ctx.arc(sx, sy, sr * 1.85, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgbStr(P.sun);
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, TAU);
    ctx.fill();
    if (!day) {
      // bite a crescent out of the moon, filled with the sky colour AT that
      // height so the notch disappears into the gradient instead of blotting
      const f = clamp(sy / skyH, 0, 1);
      const band = f < 0.62 ? mixRGB(P.top, P.mid, f / 0.62) : mixRGB(P.mid, P.low, (f - 0.62) / 0.38);
      ctx.fillStyle = rgbStr(band);
      ctx.beginPath();
      ctx.arc(sx - sr * 0.42, sy - sr * 0.3, sr * 0.92, 0, TAU);
      ctx.fill();
    }

    const cloudA = 0.9 * (1 - P.star * 0.55) * (0.75 + (this.rainAmt || 0) * 0.25);
    for (const c of this.clouds) {
      ctx.fillStyle = `rgba(255,255,255,${cloudA})`;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 34 * c.s, 15 * c.s, 0, 0, TAU);
      ctx.ellipse(c.x + 24 * c.s, c.y + 4 * c.s, 22 * c.s, 11 * c.s, 0, 0, TAU);
      ctx.ellipse(c.x - 26 * c.s, c.y + 5 * c.s, 19 * c.s, 10 * c.s, 0, 0, TAU);
      ctx.fill();
    }

    for (const g2 of this.gulls) {
      const y = g2.y + Math.sin(this.t * 1.1 + g2.ph) * 6;
      const flap = Math.sin(this.t * 7 + g2.ph) * 0.5;
      ctx.strokeStyle = 'rgba(60,80,96,0.7)';
      ctx.lineWidth = 2 * g2.s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(g2.x - 9 * g2.s, y + flap * 4 * g2.s);
      ctx.quadraticCurveTo(g2.x - 4 * g2.s, y - 4 * g2.s, g2.x, y);
      ctx.quadraticCurveTo(g2.x + 4 * g2.s, y - 4 * g2.s, g2.x + 9 * g2.s, y + flap * 4 * g2.s);
      ctx.stroke();
    }
  }

  _drawWater(ctx) {
    const { w, h } = this;
    const P = this.pal || (this.pal = paletteAt(this.dayT));
    const g = ctx.createLinearGradient(0, this.waterY, 0, h);
    g.addColorStop(0, rgbStr(P.water[0]));
    g.addColorStop(0.28, rgbStr(P.water[1]));
    g.addColorStop(0.66, rgbStr(P.water[2]));
    g.addColorStop(1, rgbStr(P.water[3]));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, this._waveY(0, this.t));
    for (let x = 0; x <= w; x += 14) ctx.lineTo(x, this._waveY(x, this.t));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }

  _drawFar(ctx) {
    ctx.fillStyle = 'rgba(8,48,80,0.42)';
    for (const f of this.far) {
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, f.rx, f.ry, 0, 0, TAU);
      ctx.fill();
    }
  }

  _drawRays(ctx) {
    const h = this.h;
    const rayK = (this.pal?.ray ?? 1) * (1 - (this.rainAmt || 0) * 0.55);
    if (rayK < 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rays) {
      const sway = Math.sin(this.t * r.spd + r.ph) * 26 * this.S;
      const a = r.a * rayK * (0.65 + 0.35 * Math.sin(this.t * r.spd * 1.7 + r.ph));
      const g = ctx.createLinearGradient(0, this.waterY, 0, h * 0.94);
      g.addColorStop(0, `rgba(255,246,205,${a})`);
      g.addColorStop(1, 'rgba(255,246,205,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(r.x - r.w * 0.5 + sway, this.waterY);
      ctx.lineTo(r.x + r.w * 0.5 + sway, this.waterY);
      ctx.lineTo(r.x + r.w * 1.6 + r.dx + sway * 1.6, h * 0.94);
      ctx.lineTo(r.x - r.w * 1.2 + r.dx + sway * 1.6, h * 0.94);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  _drawSchoolers(ctx) {
    ctx.fillStyle = 'rgba(180,230,250,0.32)';
    for (const s of this.schoolers) {
      const y = s.y + Math.sin(this.t * 1.4 + s.ph) * 8;
      ctx.beginPath();
      ctx.ellipse(s.x, y, s.s * 1.7, s.s * 0.85, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s.x - Math.sign(s.spd) * s.s * 1.6, y);
      ctx.lineTo(s.x - Math.sign(s.spd) * s.s * 2.7, y - s.s * 0.8);
      ctx.lineTo(s.x - Math.sign(s.spd) * s.s * 2.7, y + s.s * 0.8);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawBed(ctx) {
    const { w, h } = this;
    const top = h - this.bedH;

    // rocks behind the sand line
    for (const r of this.rocks) {
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.rx, r.ry, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fillStyle = r.col;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r.x - r.rx * 0.3, r.y - r.ry * 0.45, r.rx * 0.3, r.ry * 0.22, -0.3, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fill();
    }

    // corals
    for (const c of this.corals) {
      const sway = Math.sin(this.t * 0.8 + c.ph) * 0.08;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.strokeStyle = c.col;
      ctx.lineCap = 'round';
      for (const arm of c.arms) {
        ctx.lineWidth = arm.w;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(
          Math.sin(arm.a + sway) * arm.len * 0.4, -arm.len * 0.6,
          Math.sin(arm.a + sway) * arm.len * 0.95, -arm.len,
        );
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      for (const arm of c.arms) {
        ctx.beginPath();
        ctx.arc(Math.sin(arm.a + sway) * arm.len * 0.95, -arm.len, arm.w * 0.45, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // sand
    const g = ctx.createLinearGradient(0, top - 10, 0, h);
    g.addColorStop(0, '#f0dca0');
    g.addColorStop(0.5, '#d9bd84');
    g.addColorStop(1, '#a98a5c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, top + Math.sin(this.t * 0.3) * 2);
    for (let x = 0; x <= w; x += 26) {
      ctx.lineTo(x, top + Math.sin(x * 0.011 + 1.4) * 9 * this.S + Math.sin(x * 0.035) * 4 * this.S);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(120,96,60,0.32)';
    for (const s of this.grit) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }
  }

  _drawKelp(ctx, list, alpha) {
    const { h } = this;
    const bedTop = h - this.bedH * 0.75;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const k of list) {
      const seg = 8;
      const pts = [];
      for (let i = 0; i <= seg; i++) {
        const f = i / seg;
        const y = bedTop - k.h * f;
        const x = k.x + Math.sin(this.t * k.spd + k.ph + f * 2.4) * k.amp * Math.pow(f, 1.4);
        pts.push([x, y]);
      }
      // tapered stalk
      ctx.beginPath();
      ctx.moveTo(pts[0][0] - k.w * 0.5, pts[0][1]);
      for (let i = 1; i <= seg; i++) {
        const t = i / seg;
        ctx.lineTo(pts[i][0] - k.w * 0.5 * (1 - t * 0.75), pts[i][1]);
      }
      for (let i = seg; i >= 0; i--) {
        const t = i / seg;
        ctx.lineTo(pts[i][0] + k.w * 0.5 * (1 - t * 0.75), pts[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = k.col;
      ctx.fill();
      // leaves
      ctx.fillStyle = k.leaf;
      for (let i = 1; i < seg; i++) {
        const [x, y] = pts[i];
        const side = i % 2 ? 1 : -1;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(side * (0.6 + Math.sin(this.t * k.spd + i) * 0.2));
        ctx.beginPath();
        ctx.ellipse(side * k.w * 1.5, 0, k.w * 1.7, k.w * 0.6, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** Night and weather reach the sea bed too: one wash over the scenery (sand,
   *  rocks, coral, kelp) so a midnight cove is not lit like noon. Drawn before
   *  the fish, which stay readable. */
  _drawDepthWash(ctx) {
    const a = (this.pal?.star ?? 0) * 0.46 + (this.rainAmt || 0) * 0.1;
    if (a < 0.02) return;
    ctx.fillStyle = `rgba(6,18,44,${Math.min(0.6, a)})`;
    ctx.fillRect(0, this.waterY, this.w, this.h - this.waterY);
  }

  _drawBubbles(ctx, scale) {
    ctx.lineWidth = 1.4;
    for (const b of this.bubbles) {
      const r = b.r * scale;
      if (scale > 1 && b.r < 4) continue;
      if (scale < 1 && b.r >= 4) continue;
      const x = b.x + Math.sin(this.t * 1.6 + b.ph) * b.wob;
      ctx.globalAlpha = b.a * (scale > 1 ? 0.55 : 1);
      ctx.strokeStyle = 'rgba(230,248,255,0.9)';
      ctx.beginPath();
      ctx.arc(x, b.y, r, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.arc(x - r * 0.3, b.y - r * 0.32, r * 0.3, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawEntities(ctx) {
    for (const e of this.entities) {
      if (e.dead) continue;
      ctx.save();
      ctx.translate(e.x, e.y);
      if (e.kind === 'boot') {
        ctx.rotate(e.rot);
        drawBootArt(ctx, e.r, this.t + e.ph);
      } else if (e.kind === 'jelly') {
        drawJellyArt(ctx, e.r, this.t, e.ph);
      } else {
        ctx.scale(e.dir, 1);
        ctx.rotate(Math.sin(this.t * e.bobSpd + e.ph) * 0.09 * e.dir);
        drawFishArt(ctx, e.kind, e.r, this.t, e.ph);
      }
      ctx.restore();
    }
  }

  _drawShark(ctx) {
    const sh = this.shark;
    ctx.save();
    ctx.translate(sh.x, sh.y);
    ctx.scale(sh.dir, 1);
    ctx.rotate(Math.sin(this.t * 3) * 0.03);
    drawSharkArt(ctx, sh.L, this.t);
    ctx.restore();
  }

  _drawSharkWarning(ctx) {
    const wn = this.sharkWarn;
    if (!wn) return;
    const blink = 0.35 + 0.45 * Math.abs(Math.sin(this.t * 9));
    const x = wn.dir > 0 ? 26 * this.S : this.w - 26 * this.S;
    ctx.save();
    ctx.globalAlpha = blink;
    // lane streak
    const g = ctx.createLinearGradient(wn.dir > 0 ? 0 : this.w, 0, wn.dir > 0 ? this.w : 0, 0);
    g.addColorStop(0, 'rgba(232,101,122,0.42)');
    g.addColorStop(1, 'rgba(232,101,122,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, wn.y - 34 * this.S, this.w, 68 * this.S);
    // chevrons
    ctx.fillStyle = '#ffe27a';
    for (let i = 0; i < 3; i++) {
      const ox = x + wn.dir * i * 17 * this.S;
      ctx.beginPath();
      ctx.moveTo(ox - wn.dir * 9 * this.S, wn.y - 15 * this.S);
      ctx.lineTo(ox + wn.dir * 8 * this.S, wn.y);
      ctx.lineTo(ox - wn.dir * 9 * this.S, wn.y + 15 * this.S);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  _drawCatches(ctx) {
    for (const c of this.catches) {
      const f = clamp(c.t / c.dur, 0, 1);
      const e = easeOut(f);
      const cx = lerp(c.x0, this.rodTip.x, e) + Math.sin(f * Math.PI) * c.dir * 40 * this.S;
      const cy = lerp(c.y0, this._waveY(this.rodTip.x, this.t), e) - Math.sin(f * Math.PI) * 26 * this.S;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(c.spin * f);
      ctx.scale(1 - f * 0.25, 1 - f * 0.25);
      if (c.kind === 'boot') drawBootArt(ctx, c.r, this.t);
      else drawFishArt(ctx, c.kind, c.r, this.t * 2.4, c.ph);
      ctx.restore();
      // taut line to the rod
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(this.rodTip.x, this.rodTip.y);
      ctx.stroke();
    }
  }

  _drawLineAndHook(ctx) {
    const hk = this.hook;
    const tip = this.rodTip;

    // invulnerability flicker: the whole rig blinks while the i-frames run
    ctx.save();
    if (hk.inv > 0) ctx.globalAlpha = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(this.t * 34));

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.quadraticCurveTo(
      (tip.x + hk.x) * 0.5 + Math.sin(this.t * 1.2) * 6 * this.S,
      (tip.y + hk.y) * 0.5 + 10 * this.S,
      hk.x, hk.y - 10 * this.S,
    );
    ctx.stroke();

    ctx.save();
    ctx.translate(hk.x, hk.y);
    const tilt = clamp(hk.vy * 0.0006, -0.35, 0.35);
    ctx.rotate(tilt);

    // aim halo
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3.4);
    ctx.beginPath();
    ctx.arc(0, 6 * this.S, hk.r * (1.25 + pulse * 0.18), 0, TAU);
    ctx.strokeStyle = hk.inv > 0
      ? `rgba(255,226,122,${0.5 + pulse * 0.4})`
      : `rgba(190,240,255,${0.22 + pulse * 0.16})`;
    ctx.lineWidth = 2 * this.S;
    ctx.stroke();

    // swivel + hook body
    const S = this.S;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -10 * S);
    ctx.lineTo(0, 4 * S);
    ctx.quadraticCurveTo(0, 15 * S, -7 * S, 15 * S);
    ctx.quadraticCurveTo(-13 * S, 15 * S, -12 * S, 7 * S);
    ctx.lineWidth = 6.5 * S;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.lineWidth = 3.6 * S;
    ctx.strokeStyle = hk.inv > 0 ? '#ffe27a' : '#e9f2f7';
    ctx.stroke();

    // lure bead
    ctx.beginPath();
    ctx.arc(0, -2 * S, 4.6 * S, 0, TAU);
    ctx.fillStyle = hk.inv > 0 ? '#ff9a5c' : '#e8657a';
    ctx.fill();
    ctx.lineWidth = 1.6 * S;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-1.5 * S, -3.6 * S, 1.5 * S, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fill();

    if (hk.stun > 0) {
      ctx.strokeStyle = `rgba(255,240,150,${0.55 + 0.4 * Math.sin(this.t * 26)})`;
      ctx.lineWidth = 2.2 * S;
      for (let i = 0; i < 4; i++) {
        const a = this.t * 9 + i * 1.6;
        const r0 = hk.r * 0.9, r1 = hk.r * 1.9;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 + 4 * S);
        ctx.lineTo(Math.cos(a + 0.4) * r1 * 0.7, Math.sin(a + 0.4) * r1 * 0.7 + 4 * S);
        ctx.lineTo(Math.cos(a + 0.1) * r1, Math.sin(a + 0.1) * r1 + 4 * S);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.restore();
  }

  _drawParticles(ctx) {
    for (const p of this.particles) {
      const f = clamp(p.life / p.dur, 0, 1);
      ctx.globalAlpha = f;
      if (p.type === 'ring') {
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 3 * this.S * f;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.r * (1 + (1 - f) * 5), p.r * (1 + (1 - f) * 5) * 0.34, 0, 0, TAU);
        ctx.stroke();
      } else if (p.type === 'bubble') {
        ctx.strokeStyle = p.col;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (p.type === 'drop' ? 1 : f + 0.35), 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawSurface(ctx) {
    const { w } = this;
    // foam line
    ctx.beginPath();
    ctx.moveTo(0, this._waveY(0, this.t));
    for (let x = 0; x <= w; x += 14) ctx.lineTo(x, this._waveY(x, this.t));
    ctx.strokeStyle = `rgba(255,255,255,${this.pal?.foam ?? 0.75})`;
    ctx.lineWidth = 3 * this.S;
    ctx.stroke();

    // raindrop rings walking along the surface
    if (this.ripples?.length) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.6 * this.S;
      for (const r of this.ripples) {
        const f = clamp(r.t / 0.8, 0, 1);
        ctx.globalAlpha = (1 - f) * 0.7;
        ctx.beginPath();
        ctx.ellipse(r.x, this._waveY(r.x, this.t) + 2, (4 + f * 20) * this.S, (1.4 + f * 6) * this.S, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // shimmer just under the surface
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${0.14 * (this.pal?.ray ?? 1)})`;
    for (let i = 0; i < 14; i++) {
      const x = ((i * 137.5 + this.t * 14) % (w + 120)) - 60;
      const y = this._waveY(x, this.t) + 10 * this.S + Math.sin(this.t * 2 + i) * 5 * this.S;
      ctx.beginPath();
      ctx.ellipse(x, y, 26 * this.S, 3 * this.S, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawBoat(ctx) {
    const b = this.boat;
    const S = this.S;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.tilt);

    // hull
    ctx.beginPath();
    ctx.moveTo(-78 * S, -20 * S);
    ctx.lineTo(80 * S, -20 * S);
    ctx.quadraticCurveTo(66 * S, 20 * S, 34 * S, 20 * S);
    ctx.lineTo(-42 * S, 20 * S);
    ctx.quadraticCurveTo(-74 * S, 20 * S, -78 * S, -20 * S);
    ctx.closePath();
    toonFill(ctx, '#a2643c', 3 * S);
    // stripe
    ctx.beginPath();
    ctx.moveTo(-74 * S, -8 * S);
    ctx.lineTo(76 * S, -8 * S);
    ctx.lineTo(72 * S, 1 * S);
    ctx.lineTo(-73 * S, 1 * S);
    ctx.closePath();
    ctx.fillStyle = '#e8657a';
    ctx.fill();
    // deck
    ctx.beginPath();
    ctx.ellipse(0, -20 * S, 79 * S, 8 * S, 0, 0, TAU);
    toonFill(ctx, '#c98f5c', 2.4 * S);

    // bucket of fish
    ctx.save();
    ctx.translate(-52 * S, -30 * S);
    rrect(ctx, -12 * S, -12 * S, 24 * S, 22 * S, 4 * S);
    toonFill(ctx, '#7fb6d4', 2.2 * S);
    const bucket = Math.min(5, this.bucket || 0);
    for (let i = 0; i < bucket; i++) {
      ctx.save();
      ctx.translate((-7 + i * 3.6) * S, -13 * S);
      ctx.rotate(-0.5 + i * 0.24);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-4 * S, -8 * S);
      ctx.quadraticCurveTo(0, -4 * S, 4 * S, -8 * S);
      ctx.closePath();
      ctx.fillStyle = ['#ff8c5a', '#4fb3e8', '#7ac74f', '#f2b64a', '#ff8c5a'][i];
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // capybara angler
    const color = `#${(this.game.state?.color ?? 0xb08a5a).toString(16).padStart(6, '0')}`;
    ctx.save();
    ctx.translate(6 * S, -34 * S);
    ctx.scale(0.92, 0.92);
    drawCapyArt(ctx, 20 * S, color, this.t);
    ctx.restore();

    // rod
    ctx.beginPath();
    ctx.moveTo(24 * S, -44 * S);
    ctx.quadraticCurveTo(66 * S, -58 * S, this.rodLocal.x, this.rodLocal.y);
    ctx.lineWidth = 4.4 * S;
    ctx.strokeStyle = '#6b4a2c';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(38 * S, -49 * S, 4.5 * S, 0, TAU);
    ctx.fillStyle = '#f2b64a';
    ctx.fill();

    // pennant
    ctx.beginPath();
    ctx.moveTo(-64 * S, -22 * S);
    ctx.lineTo(-64 * S, -64 * S);
    ctx.lineWidth = 3 * S;
    ctx.strokeStyle = '#6b4a2c';
    ctx.stroke();
    const fl = Math.sin(this.t * 4) * 4 * S;
    ctx.beginPath();
    ctx.moveTo(-64 * S, -64 * S);
    ctx.quadraticCurveTo(-46 * S, -60 * S + fl, -30 * S, -56 * S);
    ctx.lineTo(-64 * S, -48 * S);
    ctx.closePath();
    toonFill(ctx, '#f2b64a', 2 * S);

    ctx.restore();
  }

  _drawRain(ctx) {
    const a = this.rainAmt || 0;
    if (a < 0.03 || !this.drops) return;
    ctx.save();
    ctx.strokeStyle = `rgba(206,236,255,${0.45 * a})`;
    ctx.lineCap = 'round';
    for (const d of this.drops) {
      const len = 16 * d.s * this.S;
      ctx.lineWidth = 1.4 * d.s * this.S;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - len * 0.28, d.y - len);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The depth gauge: the water column in miniature down the left edge, with
   * the band the line is holding lit up and what is biting in it named. This
   * is the whole "cast shallow or cast deep" decision, on screen, always.
   */
  _drawDepthGauge(ctx) {
    if (this.phase === 'splash' || this.phase === 'results') return;
    const S = this.S;
    const x = 30 * S;
    const wgt = 22 * S;
    const top = this.zoneY[0];
    const bot = this.zoneY[3];

    ctx.save();
    ctx.globalAlpha = 0.92;
    rrect(ctx, x - wgt * 0.5, top, wgt, bot - top, wgt * 0.5);
    ctx.fillStyle = 'rgba(9,36,58,0.5)';
    ctx.fill();
    ctx.lineWidth = 2 * S;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.stroke();

    for (let i = 0; i < 3; i++) {
      const id = ZONE_IDS[i];
      const y0 = this.zoneY[i];
      const y1 = this.zoneY[i + 1];
      const here = id === this.zone;
      rrect(ctx, x - wgt * 0.5 + 3 * S, y0 + 3 * S, wgt - 6 * S, y1 - y0 - 6 * S, wgt * 0.3);
      ctx.fillStyle = here ? ZONES[id].col : 'rgba(255,255,255,0.13)';
      ctx.globalAlpha = here ? 0.85 : 0.5;
      ctx.fill();
      ctx.globalAlpha = 0.92;
      if (here) {
        // a pill, not floating text: it has to read over kelp and open water
        const head = headliner(id, this.band, this.weather);
        const line = `${ZONES[id].name.toUpperCase()}${head ? `  ·  ${head.label.toUpperCase()}` : ''}`;
        ctx.font = `900 ${14 * S}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(line).width;
        const ly = clamp((y0 + y1) * 0.5, top + 16 * S, bot - 16 * S);
        const px = x + wgt * 0.7;
        rrect(ctx, px, ly - 13 * S, tw + 22 * S, 26 * S, 13 * S);
        ctx.fillStyle = ZONES[id].col;
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.lineWidth = 2.4 * S;
        ctx.strokeStyle = 'rgba(10,34,54,0.55)';
        ctx.stroke();
        ctx.fillStyle = '#12324c';
        ctx.fillText(line, px + 11 * S, ly + 0.5 * S);
        ctx.globalAlpha = 0.92;
      }
    }

    // the Deep's own meter: how close Old Barnacle is to coming up
    if (this.legendState !== 'landed') {
      const f = clamp(this.deepT / DEEP_FILL, 0, 1);
      if (f > 0.02) {
        const y0 = this.zoneY[2] + 3 * S;
        const y1 = this.zoneY[3] - 3 * S;
        ctx.globalAlpha = 0.9;
        rrect(ctx, x - wgt * 0.5 + 3 * S, lerp(y1, y0, f), wgt - 6 * S, (y1 - y0) * f, wgt * 0.3);
        ctx.fillStyle = f >= 1 ? '#f2b64a' : `rgba(160,180,255,${0.55 + 0.35 * Math.sin(this.t * 5)})`;
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * The hook-set beat. A needle sweeps a bar pinned above the hook; the green
   * band is the set. Deliberately huge, deliberately slow, and a miss only
   * ever costs the fish.
   */
  _drawTension(ctx) {
    const T = this.tension;
    if (!T) return;
    const S = this.S;
    const k = KINDS[T.kind];
    const legend = k.rarity === 'legendary';
    const bw = clamp(this.w * 0.34, 200, 420);
    const bh = 20 * S;
    const cx = clamp(this.hook.x, bw * 0.5 + 20, this.w - bw * 0.5 - 20);
    const cy = clamp(this.hook.y - 92 * S, this.waterY + 34 * S, this.h - 60 * S);

    // the fish, hooked and fighting, drawn on the line
    ctx.save();
    ctx.translate(this.hook.x, this.hook.y + 14 * S);
    ctx.rotate(Math.sin(this.t * 19) * 0.28);
    ctx.scale(T.dir, 1);
    drawFishArt(ctx, T.kind, T.r, this.t * 1.8, T.ph);
    ctx.restore();

    ctx.save();
    // plate
    rrect(ctx, cx - bw * 0.5, cy - bh * 0.5, bw, bh, bh * 0.5);
    ctx.fillStyle = 'rgba(9,36,58,0.72)';
    ctx.fill();
    ctx.lineWidth = 2.5 * S;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.stroke();

    // the window
    const ww = bw * T.win;
    rrect(ctx, cx - ww * 0.5, cy - bh * 0.5 + 3 * S, ww, bh - 6 * S, bh * 0.3);
    ctx.fillStyle = legend ? 'rgba(242,182,74,0.85)' : 'rgba(122,199,79,0.85)';
    ctx.fill();
    // the sweet spot inside it
    rrect(ctx, cx - ww * 0.16, cy - bh * 0.5 + 3 * S, ww * 0.32, bh - 6 * S, bh * 0.3);
    ctx.fillStyle = 'rgba(255,246,227,0.55)';
    ctx.fill();

    // needle
    const nx = cx - bw * 0.5 + bw * T.pos;
    ctx.beginPath();
    ctx.moveTo(nx, cy - bh * 0.78);
    ctx.lineTo(nx, cy + bh * 0.78);
    ctx.lineWidth = 5 * S;
    ctx.strokeStyle = 'rgba(10,34,54,0.9)';
    ctx.stroke();
    ctx.lineWidth = 2.6 * S;
    ctx.strokeStyle = '#fff6e3';
    ctx.stroke();

    // beat pips for a multi-stage fight
    if (T.beats > 1) {
      for (let i = 0; i < T.beats; i++) {
        ctx.beginPath();
        ctx.arc(cx - (T.beats - 1) * 9 * S + i * 18 * S, cy + bh * 1.35, 5 * S, 0, TAU);
        ctx.fillStyle = i < T.beat ? '#f2b64a' : 'rgba(255,255,255,0.3)';
        ctx.fill();
      }
    }

    // the ask
    ctx.font = `900 ${(legend ? 21 : 17) * S}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = `${k.label.toUpperCase()}!  SET THE HOOK — SPACE`;
    ctx.lineWidth = 5 * S;
    ctx.strokeStyle = 'rgba(10,34,54,0.9)';
    ctx.lineJoin = 'round';
    ctx.strokeText(label, cx, cy - bh * 1.5);
    ctx.fillStyle = legend ? '#ffe27a' : '#fff6e3';
    ctx.fillText(label, cx, cy - bh * 1.5);
    ctx.restore();
  }

  /** The two-line headline used for the hour, the weather and the legend. */
  _drawBanner(ctx) {
    const b = this.banner;
    if (!b) return;
    const f = b.t / b.dur;
    const inA = clamp(f / 0.12, 0, 1);
    const outA = clamp((1 - f) / 0.22, 0, 1);
    const S = this.S;
    ctx.save();
    ctx.globalAlpha = Math.min(inA, outA);
    ctx.translate(this.w * 0.5, this.h * 0.27 - (1 - inA) * 26 * S);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = `900 ${34 * S}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
    ctx.lineWidth = 7 * S;
    ctx.strokeStyle = 'rgba(10,34,54,0.85)';
    ctx.strokeText(b.title, 0, 0);
    ctx.fillStyle = b.col;
    ctx.fillText(b.title, 0, 0);
    ctx.font = `800 ${15 * S}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
    ctx.lineWidth = 5 * S;
    ctx.strokeStyle = 'rgba(10,34,54,0.85)';
    ctx.strokeText(b.sub, 0, 26 * S);
    ctx.fillStyle = 'rgba(255,246,227,0.9)';
    ctx.fillText(b.sub, 0, 26 * S);
    ctx.restore();
  }

  _drawPopups(ctx) {
    for (const p of this.popups) {
      const f = p.t / p.dur;
      const pop = f < 0.2 ? lerp(0.5, 1.15, f / 0.2) : lerp(1.15, 1, Math.min(1, (f - 0.2) / 0.25));
      ctx.save();
      ctx.globalAlpha = f > 0.7 ? 1 - (f - 0.7) / 0.3 : 1;
      ctx.translate(p.x, p.y);
      ctx.scale(pop * p.scale, pop * p.scale);
      ctx.font = `900 ${22 * this.S}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 5 * this.S;
      ctx.strokeStyle = 'rgba(10,34,54,0.85)';
      ctx.lineJoin = 'round';
      ctx.strokeText(p.text, 0, 0);
      ctx.fillStyle = p.col;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }

  _drawOverlays(ctx) {
    const { w, h } = this;
    if ((this.rainAmt || 0) > 0.02) {
      ctx.fillStyle = `rgba(102,124,148,${this.rainAmt * 0.2})`;
      ctx.fillRect(0, 0, w, h);
    }
    // the dark rising out of the Deep while Old Barnacle comes up
    const aura = this.deepAura || 0;
    if (aura > 0.01) {
      const ag = ctx.createLinearGradient(0, h, 0, h * 0.3);
      ag.addColorStop(0, `rgba(16,30,84,${clamp(aura, 0, 1) * 0.72})`);
      ag.addColorStop(1, 'rgba(16,30,84,0)');
      ctx.fillStyle = ag;
      ctx.fillRect(0, 0, w, h);
    }
    if (this.flash > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
      g.addColorStop(0, `rgba(255,226,140,${this.flash * 0.35})`);
      g.addColorStop(1, 'rgba(255,226,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    if (this.danger > 0.01) {
      ctx.save();
      const g = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.25, w * 0.5, h * 0.5, Math.max(w, h) * 0.68);
      g.addColorStop(0, 'rgba(200,40,70,0)');
      g.addColorStop(1, `rgba(200,40,70,${clamp(this.danger, 0, 1) * 0.4})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    // vignette
    const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.35, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,20,40,0)');
    vg.addColorStop(1, 'rgba(0,18,38,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  // ---- teardown ------------------------------------------------------------

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this._offClock) { try { this._offClock(); } catch { /* already gone */ } }
    this._offClock = null;
    this.tension = null;
    this.legendWarn = null;
    for (const [target, type, fn, opts] of this._listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this._listeners.length = 0;
    this.entities.length = 0;
    this.particles.length = 0;
    this.popups.length = 0;
    this.catches.length = 0;
    this.bubbles.length = 0;
    this.shark = null;
    this.sharkWarn = null;
    if (this.canvas) {
      // drop the backing store so the 2D context frees its memory promptly
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.ctx = null;
    this.canvas = null;
    this.wrap = null;
    this.el = {};
  }
}
