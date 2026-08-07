import * as THREE from 'three';
import { HATS, MINIGAMES, ROOM_INFO } from '../../shared/constants.js';
// Namespace import on purpose: STAMPS / MILESTONES are wave-7 additions owned by
// the progression agent, and a named import of a binding that has not landed yet
// is a link-time error. Reading them off the namespace degrades to a fallback.
import * as SHARED from '../../shared/constants.js';
import { createAvatar } from '../player/avatar.js';
import { makeToon, makeGlow, disposeObject } from '../core/materials.js';
import { visitHouse } from '../net/client.js';

/**
 * Player card: click a capybara, meet the capybara.
 *
 * A live 3D turntable of THEIR avatar (their color + hat), their name, a
 * flavor title, their minigame bests rendered as medals, and the friend
 * button when both sides have real accounts.
 *
 * Public API:
 *   openProfile(game, playerId)   - the card (also opened from the friends list)
 *   ensureSocialStyles()          - injects the single <style> tag for pf-/fr-
 *   normalizeFriends(payload)     - shared parser for the 'friends-data' event
 *
 * Data flow: we paint instantly from whatever the net client already knows
 * about that remote (name/color/hat/bot), fire {t:'inspect', id} and enrich the
 * card when 'profile-data' arrives. 'friends-data' keeps the button honest.
 */

// ---------------------------------------------------------------------------
// achievements
// ---------------------------------------------------------------------------

// bronze / silver / gold cut-offs per minigame
const MEDAL_TIERS = {
  fishing: [30, 60, 100],
  sled: [800, 2000, 4000],
  smoothie: [150, 350, 600],
};

const TIER_CLASS = ['is-none', 'is-bronze', 'is-silver', 'is-gold'];
const TIER_LABEL = ['No medal yet', 'Bronze', 'Silver', 'Gold'];

const MEDAL_BLURB = {
  fishing: 'Reeled in off Driftwood Beach',
  sled: 'Screamed down Frosty Peak',
  smoothie: 'Blended under pressure',
};

/** One line of context under each minigame name: where they are on the ladder. */
function medalSub(best, tier, next) {
  if (best == null) return next != null ? `Not tried yet : ${next} earns bronze` : 'Not tried yet';
  if (tier === 0) return `${next} earns bronze`;
  if (tier === 1) return `Bronze : ${next} earns silver`;
  if (tier === 2) return `Silver : ${next} earns gold`;
  return 'Gold : nothing left to prove';
}

/** A best of 0 (or missing / junk) means "never played". */
function bestOf(bests, id) {
  const has = bests && Object.prototype.hasOwnProperty.call(bests, id);
  const v = has ? Number(bests[id]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function medalTier(id, best) {
  const cuts = Object.prototype.hasOwnProperty.call(MEDAL_TIERS, id) ? MEDAL_TIERS[id] : null;
  if (!cuts || best == null) return 0;
  if (best >= cuts[2]) return 3;
  if (best >= cuts[1]) return 2;
  if (best >= cuts[0]) return 1;
  return 0;
}

function nextCut(id, best) {
  const cuts = Object.prototype.hasOwnProperty.call(MEDAL_TIERS, id) ? MEDAL_TIERS[id] : null;
  if (!cuts) return null;
  for (const c of cuts) if (best == null || best < c) return c;
  return null;
}

function flavorTitle(bests, isBot, isSelf) {
  if (isBot) return 'Local legend';
  const ids = Object.keys(MEDAL_TIERS);
  let gold = 0; let silver = 0; let bronze = 0; let played = 0;
  for (const id of ids) {
    const best = bestOf(bests, id);
    if (best != null) played++;
    const t = medalTier(id, best);
    if (t === 3) gold++;
    else if (t === 2) silver++;
    else if (t === 1) bronze++;
  }
  if (gold >= 3) return 'Champion of the cove';
  if (gold >= 1) return 'Podium regular';
  if (silver >= 1) return 'Dangerously good';
  if (bronze >= 1) return 'Getting the hang of it';
  if (played >= 1) return 'Warming up';
  return isSelf ? 'Your story starts here' : 'Newly washed ashore';
}

// ---------------------------------------------------------------------------
// stamp album (wave 7, docs/LIVING-COVE.md section D)
//
// The catalog is contract data and belongs in shared/constants.js as STAMPS
// (and MILESTONES); this module owns the ART. Until the progression agent lands
// those exports, FALLBACK_STAMPS/MILESTONES keep the tab, the slam and the
// milestone bar honest instead of shipping an empty box. Shared always wins.
// ---------------------------------------------------------------------------

// id, name, what it is for, glyph, hue. Feats, not grind: every line here is a
// thing you did in front of other capybaras.
const FALLBACK_STAMPS = [
  ['first_splash', 'First Splash', 'Finish your very first minigame run.', 'splash', 0x4fb3e8],
  ['reel_it_in', 'Reel It In', 'Land 40 or more in Reel Rush.', 'fish', 0x42d6c8],
  ['deep_pockets', 'Deep Pockets', 'Have 1000 coins in your purse at once.', 'coin', 0xf2b64a],
  ['sweep', 'Sweep', 'Win a game of Paddle Panic 5-0.', 'paddle', 0xe8657a],
  ['checkmate', 'Checkmate', 'Beat another capybara at Grand Capy Chess.', 'pawn', 0x9b6bd4],
  ['four_up', 'Four Up', 'Win Four in a Row against a real opponent.', 'grid4', 0xf2a541],
  ['clash', 'Clash Champion', 'Take a Capy Clash duel off another player.', 'card', 0xe8657a],
  ['shuffler', 'Shuffle Master', 'Park every disc in the scoring zone.', 'disc', 0x7ac74f],
  ['downhill', 'Downhill', 'Finish a three capybara sled race.', 'sled', 0x4fb3e8],
  ['photo_finish', 'Photo Finish', 'Win a sled race by less than a second.', 'flag', 0xf2b64a],
  ['blend_master', 'Blend Master', 'Score 350 in Smoothie Scramble.', 'blender', 0xf29ab0],
  ['prop_star', 'Prop Star', 'Survive a whole Prop Hunt as a prop.', 'prop', 0x8a6642],
  ['seeker', 'Seeker', 'Find every hider in one Prop Hunt.', 'eye', 0x2f7fb0],
  ['quick_draw', 'Quick Draw', 'Have three capys guess your doodle.', 'brush', 0xe8657a],
  ['good_guess', 'Good Guess', 'Guess five doodles in a single round.', 'bulb', 0xf2b64a],
  ['glimmer', 'Glimmer', 'Dig a gem out of the Glimmer Mine.', 'gem', 0x42d6c8],
  ['first_pixel', 'First Pixel', 'Add your first pixel to the plaza mural.', 'pixel', 0x7ac74f],
  ['muralist', 'Muralist', 'Place fifty mural pixels, lifetime.', 'mural', 0xe8657a],
  ['host_with_most', 'Host With the Most', 'Get five capys to a party you threw.', 'party', 0xf2b64a],
  ['party_animal', 'Party Animal', 'Turn up to five parties.', 'confetti', 0x9b6bd4],
  ['night_owl', 'Night Owl', 'See the aurora over Frosty Peak.', 'aurora', 0x42d6c8],
  ['sunriser', 'Sunriser', 'Be in the plaza when the sun comes up.', 'sun', 0xf2a541],
  ['rain_dance', 'Rain Dance', 'Dance outdoors in the rain.', 'rain', 0x4fb3e8],
  ['snowballer', 'Snowballer', 'Land ten snowballs on willing victims.', 'snowball', 0xbfe6f5],
  ['volley', 'Volley', 'Bop the beach ball ten times.', 'ball', 0xe8657a],
  ['campfire', 'Campfire Capy', 'Sit out a whole night at the bonfire.', 'bonfire', 0xf2a541],
  ['deep_breath', 'Deep Breath', 'Spend ten minutes down in The Drift.', 'bubbles', 0x2f7fb0],
  ['pod', 'Pod', 'Ride Big Blue with three other capys aboard.', 'whale', 0x4fb3e8],
  ['lantern', 'Lantern Light', 'Drift with the jellies after dark.', 'jelly', 0x9b6bd4],
  ['message', 'Message in a Bottle', 'Be first to the day\'s bottle.', 'bottle', 0xf2b64a],
  ['slow_steady', 'Slow and Steady', 'Follow the sea turtle a full lap.', 'turtle', 0x7ac74f],
  ['decorator', 'Decorator', 'Place twenty things in your own den.', 'chair', 0x8a6642],
  ['open_house', 'Open House', 'Have five visitors in your den at once.', 'door', 0xf2b64a],
  ['social', 'Social Butterfly', 'Make five friends.', 'friends', 0xe8657a],
  ['chatterbox', 'Chatterbox', 'Say a hundred things out loud.', 'bubble', 0x4fb3e8],
  ['explorer', 'Explorer', 'Visit every room in a single cove day.', 'compass', 0xf2a541],
  ['clean_sweep', 'Clean Sweep', 'Finish all three dailies in one day.', 'check', 0x7ac74f],
  ['regular', 'Regular', 'Play on seven different days.', 'calendar', 0x9b6bd4],
  ['hat_trick', 'Hat Trick', 'Own ten different hats.', 'hat', 0xf29ab0],
  ['legend', 'Legend of the Cove', 'Earn every other stamp in the album.', 'crown', 0xf2c744],
].map(([id, name, desc, glyph, hue]) => ({ id, name, desc, glyph, hue }));

// total stamps -> exclusive reward coins cannot buy
const FALLBACK_MILESTONES = [
  { at: 5, name: 'Snorkel', kind: 'hat', glyph: 'bubbles', hue: 0xe8657a },
  { at: 12, name: 'Aurora coat', kind: 'color', glyph: 'aurora', hue: 0x42d6c8 },
  { at: 20, name: 'Whale-song gramophone', kind: 'furniture', glyph: 'gramo', hue: 0xf2b64a },
  { at: 30, name: 'Golden pickaxe', kind: 'hat', glyph: 'pick', hue: 0xf2c744 },
  { at: 40, name: '"Legend of the Cove" title', kind: 'title', glyph: 'ribbon', hue: 0x9b6bd4 },
];

const GLYPHS = ['splash', 'fish', 'coin', 'paddle', 'pawn', 'grid4', 'card', 'disc', 'sled',
  'flag', 'blender', 'prop', 'eye', 'brush', 'bulb', 'gem', 'pixel', 'mural', 'party',
  'confetti', 'aurora', 'sun', 'rain', 'snowball', 'ball', 'bonfire', 'bubbles', 'whale',
  'jelly', 'bottle', 'turtle', 'chair', 'door', 'friends', 'bubble', 'compass', 'check',
  'calendar', 'hat', 'crown'];

const HUES = [0xe8657a, 0x4fb3e8, 0x7ac74f, 0xf2b64a, 0x9b6bd4, 0x42d6c8, 0xf2a541, 0xf29ab0];

const FALLBACK_BY_ID = new Map(FALLBACK_STAMPS.map((s) => [s.id, s]));

/** Stable per-id pick so a server-only stamp still gets consistent art. */
function hashOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function decorate(id, raw) {
  const known = FALLBACK_BY_ID.get(id);
  const h = hashOf(id);
  const glyph = typeof raw?.glyph === 'string' && GLYPHS.includes(raw.glyph)
    ? raw.glyph : (known?.glyph || GLYPHS[h % GLYPHS.length]);
  const hue = Number.isFinite(Number(raw?.hue)) ? Number(raw.hue)
    : (known?.hue ?? HUES[(h >> 5) % HUES.length]);
  // shared STAMPS carry both a flavour line (desc) and the actual condition
  // (how); the album shows the flavour once earned and the condition until then
  const how = (typeof raw?.how === 'string' && raw.how.trim())
    || (typeof raw?.desc === 'string' && raw.desc.trim()) || known?.desc || 'A cove secret.';
  return {
    id,
    name: (typeof raw?.name === 'string' && raw.name.trim()) || known?.name || id,
    desc: (typeof raw?.desc === 'string' && raw.desc.trim()) || how,
    how,
    glyph,
    hue,
  };
}

let _catalog = null;

/** The stamp catalog: shared STAMPS when it exists, this module's list until then. */
export function stampCatalog() {
  if (_catalog) return _catalog;
  const shared = SHARED.STAMPS;
  if (Array.isArray(shared) && shared.length) {
    _catalog = shared
      .filter((s) => s && (typeof s.id === 'string'))
      .map((s) => decorate(s.id, s));
  } else if (shared && typeof shared === 'object') {
    _catalog = Object.keys(shared).map((id) => decorate(id, shared[id]));
  } else {
    _catalog = FALLBACK_STAMPS.slice();
  }
  if (!_catalog.length) _catalog = FALLBACK_STAMPS.slice();
  return _catalog;
}

export function stampById(id) {
  if (typeof id !== 'string' || !id) return null;
  for (const s of stampCatalog()) if (s.id === id) return s;
  return decorate(id, null); // an unknown id still deserves a stamp, not a hole
}

/** Milestone rewards keyed by total stamps: shared MILESTONES when it exists. */
export function milestoneTrack() {
  const shared = SHARED.MILESTONES;
  const list = Array.isArray(shared) ? shared : null;
  if (!list || !list.length) return FALLBACK_MILESTONES;
  return list
    .map((m, i) => {
      const at = Math.max(1, Math.floor(Number(m?.at ?? m?.stamps ?? 0)) || 0);
      const fb = FALLBACK_MILESTONES[Math.min(i, FALLBACK_MILESTONES.length - 1)];
      return {
        at: at || fb.at,
        name: (typeof m?.name === 'string' && m.name.trim()) || fb.name,
        kind: typeof m?.kind === 'string' ? m.kind : fb.kind,
        glyph: typeof m?.glyph === 'string' ? m.glyph : fb.glyph,
        hue: Number.isFinite(Number(m?.hue)) ? Number(m.hue) : fb.hue,
      };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * Parse a 'stamps' frame (or a stamps blob hanging off a profile).
 * Accepts [ids], {stamps:[ids]}, {earned:[ids]}, {stamps:{id:true}}.
 */
export function normalizeStamps(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw.stamps ?? raw.earned ?? raw.ids ?? raw.list) : raw;
  const ids = [];
  if (Array.isArray(body)) {
    for (const v of body) {
      if (typeof v === 'string' && v) ids.push(v);
      else if (v && typeof v === 'object' && typeof v.id === 'string') ids.push(v.id);
    }
  } else if (body && typeof body === 'object') {
    for (const k of Object.keys(body)) if (body[k]) ids.push(k);
  }
  const owner = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw.id ?? raw.playerId ?? null) : null;
  return { id: owner == null ? null : String(owner), ids: [...new Set(ids)] };
}

// ---- procedural stamp art -------------------------------------------------
// Everything is drawn into a 100x100 unit box and scaled by the caller, so one
// routine serves the 72px album tiles and the 260px slam without a second set
// of numbers. No assets, same rules as the rest of the world.

const INK = '#2d2417';
const PAPER = '#fffaf0';

const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

/** Mix toward white (k>0) or ink (k<0) so one hue makes a whole little scene. */
function shade(c, k) {
  const r = (c >> 16) & 255; const g = (c >> 8) & 255; const b = c & 255;
  const t = k > 0 ? 255 : 45;
  const a = Math.abs(k);
  const m = (v) => Math.round(v + (t - v) * a);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function makePen(c) {
  const pen = {
    c,
    dot(x, y, r, fill) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); return pen; },
    oval(x, y, rx, ry, fill, rot = 0) {
      c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); return pen;
    },
    box(x, y, w, h, r, fill) {
      const rr = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x - w / 2 + rr, y - h / 2);
      c.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, rr);
      c.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, rr);
      c.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, rr);
      c.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, rr);
      c.closePath(); c.fillStyle = fill; c.fill(); return pen;
    },
    poly(pts, fill) {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath(); c.fillStyle = fill; c.fill(); return pen;
    },
    line(x1, y1, x2, y2, w, col) {
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
      c.strokeStyle = col; c.lineWidth = w; c.stroke(); return pen;
    },
    arc(x, y, r, a0, a1, w, col) {
      c.beginPath(); c.arc(x, y, r, a0, a1);
      c.strokeStyle = col; c.lineWidth = w; c.stroke(); return pen;
    },
    star(x, y, r, points, fill) {
      c.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? r * 0.45 : r;
        const px = x + Math.cos(a) * rr; const py = y + Math.sin(a) * rr;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath(); c.fillStyle = fill; c.fill(); return pen;
    },
  };
  return pen;
}

/* eslint-disable no-unused-vars */
const GLYPH_ART = {
  splash: (p, h) => {
    p.oval(50, 66, 30, 13, shade(h, 0.15));
    p.poly([[34, 62], [50, 26], [66, 62]], shade(h, -0.1));
    for (const [x, y, r] of [[30, 40, 5], [70, 36, 6], [50, 22, 4]]) p.dot(x, y, r, shade(h, 0.5));
  },
  fish: (p, h) => {
    p.oval(46, 50, 26, 16, hex(h));
    p.poly([[70, 50], [88, 34], [88, 66]], shade(h, -0.15));
    p.dot(32, 45, 4, INK);
    p.arc(46, 56, 12, 0.25, Math.PI - 0.25, 3, shade(h, -0.25));
  },
  coin: (p, h) => {
    p.dot(50, 52, 28, shade(h, -0.1));
    p.dot(50, 48, 28, hex(h));
    p.dot(50, 48, 20, shade(h, 0.3));
    p.star(50, 48, 12, 5, shade(h, -0.2));
  },
  paddle: (p, h) => {
    p.box(34, 50, 12, 44, 6, hex(h));
    p.box(68, 56, 12, 34, 6, shade(h, -0.2));
    p.dot(52, 36, 8, PAPER);
    p.dot(52, 36, 8, shade(h, 0.55));
  },
  pawn: (p, h) => {
    p.dot(50, 32, 13, hex(h));
    p.poly([[38, 46], [62, 46], [68, 74], [32, 74]], hex(h));
    p.box(50, 78, 46, 10, 5, shade(h, -0.2));
  },
  grid4: (p, h) => {
    p.box(50, 52, 62, 62, 12, shade(h, -0.15));
    const cols = [shade(h, 0.6), hex(h), shade(h, 0.6), hex(h)];
    let i = 0;
    for (const y of [36, 68]) for (const x of [36, 68]) p.dot(x, y, 12, cols[i++]);
  },
  card: (p, h) => {
    p.box(40, 54, 44, 60, 8, shade(h, -0.3));
    p.box(56, 48, 44, 60, 8, PAPER);
    p.poly([[56, 34], [70, 50], [56, 64], [42, 50]], hex(h));
  },
  disc: (p, h) => {
    p.oval(50, 60, 34, 14, shade(h, -0.2));
    p.oval(50, 52, 34, 14, hex(h));
    p.oval(50, 52, 16, 6, shade(h, 0.5));
  },
  sled: (p, h) => {
    p.poly([[24, 58], [76, 58], [70, 44], [30, 44]], hex(h));
    p.arc(50, 62, 30, Math.PI * 0.15, Math.PI * 0.85, 6, shade(h, -0.3));
    for (const x of [36, 64]) p.line(x, 58, x, 68, 5, shade(h, -0.3));
    p.dot(50, 32, 9, shade(h, 0.4));
  },
  flag: (p, h) => {
    p.line(34, 78, 34, 22, 6, INK);
    p.poly([[34, 24], [78, 36], [34, 50]], hex(h));
    p.dot(34, 20, 6, shade(h, 0.4));
  },
  blender: (p, h) => {
    p.box(50, 72, 44, 20, 7, shade(h, -0.35));
    p.poly([[34, 62], [66, 62], [62, 24], [38, 24]], shade(h, 0.55));
    p.poly([[38, 62], [62, 62], [59, 40], [41, 40]], hex(h));
    p.dot(50, 20, 7, shade(h, -0.2));
  },
  prop: (p, h) => {
    p.box(50, 58, 46, 44, 8, hex(h));
    p.box(50, 34, 52, 12, 6, shade(h, -0.25));
    p.dot(40, 54, 4, INK);
    p.dot(60, 54, 4, INK);
    p.arc(50, 62, 9, 0.2, Math.PI - 0.2, 3, INK);
  },
  eye: (p, h) => {
    p.poly([[16, 50], [50, 24], [84, 50], [50, 76]], PAPER);
    p.dot(50, 50, 18, hex(h));
    p.dot(50, 50, 9, INK);
    p.dot(44, 44, 4, PAPER);
  },
  brush: (p, h) => {
    p.line(26, 76, 62, 32, 8, shade(h, -0.35));
    p.poly([[56, 26], [74, 40], [64, 52], [50, 38]], hex(h));
    p.dot(24, 78, 8, shade(h, 0.35));
  },
  bulb: (p, h) => {
    p.dot(50, 44, 22, hex(h));
    p.box(50, 70, 20, 16, 5, shade(h, -0.35));
    for (const a of [-1.1, -0.5, 0.5, 1.1]) {
      p.line(50 + Math.sin(a) * 30, 44 - Math.cos(a) * 30, 50 + Math.sin(a) * 40, 44 - Math.cos(a) * 40, 5, shade(h, 0.25));
    }
  },
  gem: (p, h) => {
    p.poly([[50, 18], [80, 44], [50, 82], [20, 44]], hex(h));
    p.poly([[50, 18], [80, 44], [50, 44]], shade(h, 0.45));
    p.poly([[50, 44], [80, 44], [50, 82]], shade(h, -0.2));
  },
  pixel: (p, h) => {
    p.box(50, 50, 66, 66, 8, shade(h, 0.65));
    p.box(38, 38, 22, 22, 2, hex(h));
    p.box(62, 62, 22, 22, 2, shade(h, -0.15));
  },
  mural: (p, h) => {
    p.box(50, 50, 74, 58, 6, shade(h, -0.35));
    const cols = [hex(h), shade(h, 0.5), '#7ac74f', '#4fb3e8', '#f2b64a', shade(h, 0.2)];
    let i = 0;
    for (const y of [36, 52, 68]) for (const x of [30, 50, 70]) p.box(x, y, 16, 12, 2, cols[i++ % cols.length]);
  },
  party: (p, h) => {
    p.poly([[50, 16], [72, 72], [28, 72]], hex(h));
    p.poly([[50, 16], [72, 72], [50, 72]], shade(h, -0.2));
    p.dot(50, 14, 7, shade(h, 0.5));
    for (const [x, y] of [[42, 44], [58, 56], [46, 62]]) p.dot(x, y, 5, PAPER);
  },
  confetti: (p, h) => {
    const cols = [hex(h), '#4fb3e8', '#7ac74f', '#f2b64a', '#e8657a'];
    let i = 0;
    for (const [x, y, r] of [[26, 30, 0.4], [50, 22, -0.6], [74, 34, 0.8], [34, 62, -0.3], [62, 68, 0.5], [50, 48, 0.1]]) {
      p.c.save(); p.c.translate(x, y); p.c.rotate(r);
      p.box(0, 0, 18, 9, 3, cols[i++ % cols.length]);
      p.c.restore();
    }
  },
  aurora: (p, h) => {
    p.box(50, 74, 84, 26, 6, shade(h, -0.45));
    for (let i = 0; i < 3; i++) {
      p.c.save();
      p.c.beginPath();
      p.c.moveTo(18, 60 - i * 6);
      p.c.bezierCurveTo(38, 24 - i * 8, 62, 62 - i * 6, 84, 22 - i * 7);
      p.c.strokeStyle = [hex(h), '#7ac74f', '#e8657a'][i];
      p.c.lineWidth = 8 - i * 2;
      p.c.lineCap = 'round';
      p.c.stroke();
      p.c.restore();
    }
    p.dot(24, 22, 3, PAPER); p.dot(76, 46, 3, PAPER);
  },
  sun: (p, h) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.line(50 + Math.cos(a) * 24, 50 + Math.sin(a) * 24, 50 + Math.cos(a) * 38, 50 + Math.sin(a) * 38, 6, shade(h, 0.3));
    }
    p.dot(50, 50, 22, hex(h));
    p.dot(43, 44, 6, shade(h, 0.5));
  },
  rain: (p, h) => {
    p.dot(38, 40, 16, shade(h, 0.5));
    p.dot(58, 36, 20, shade(h, 0.55));
    p.dot(68, 46, 13, shade(h, 0.45));
    for (const [x, y] of [[34, 66], [50, 72], [66, 64]]) {
      p.poly([[x, y], [x + 5, y + 12], [x - 5, y + 12]], hex(h));
    }
  },
  snowball: (p, h) => {
    p.dot(52, 52, 24, shade(h, 0.45));
    p.dot(44, 44, 8, PAPER);
    for (const [x, y, r] of [[20, 26, 5], [80, 30, 4], [24, 78, 4]]) p.dot(x, y, r, shade(h, 0.2));
  },
  ball: (p, h) => {
    p.dot(50, 50, 30, PAPER);
    p.c.save();
    p.c.beginPath(); p.c.arc(50, 50, 30, 0, Math.PI * 2); p.c.clip();
    p.poly([[50, 50], [92, 22], [92, 54]], hex(h));
    p.poly([[50, 50], [12, 62], [58, 88]], '#4fb3e8');
    p.poly([[50, 50], [22, 14], [58, 12]], '#f2b64a');
    p.c.restore();
    p.arc(50, 50, 30, 0, Math.PI * 2, 4, INK);
  },
  bonfire: (p, h) => {
    p.line(26, 74, 74, 62, 9, '#8a6642');
    p.line(26, 62, 74, 74, 9, '#6b4f35');
    p.poly([[50, 18], [66, 50], [50, 62], [34, 50]], hex(h));
    p.poly([[50, 30], [59, 52], [50, 60], [41, 52]], shade(h, 0.5));
  },
  bubbles: (p, h) => {
    p.dot(40, 62, 20, hex(h));
    p.dot(33, 55, 6, PAPER);
    p.dot(68, 38, 12, shade(h, 0.35));
    p.dot(74, 66, 8, shade(h, 0.5));
  },
  whale: (p, h) => {
    p.oval(46, 54, 32, 19, hex(h));
    p.poly([[74, 52], [92, 36], [88, 62]], shade(h, -0.2));
    p.oval(42, 64, 22, 9, shade(h, 0.5));
    p.dot(26, 50, 4, INK);
    p.line(40, 34, 40, 20, 5, shade(h, 0.5));
    p.dot(40, 18, 5, shade(h, 0.6));
  },
  jelly: (p, h) => {
    p.c.beginPath(); p.c.arc(50, 44, 24, Math.PI, 0); p.c.closePath();
    p.c.fillStyle = hex(h); p.c.fill();
    for (const x of [34, 44, 56, 66]) {
      p.c.beginPath(); p.c.moveTo(x, 44);
      p.c.quadraticCurveTo(x + 8, 60, x - 3, 78);
      p.c.strokeStyle = shade(h, 0.35); p.c.lineWidth = 5; p.c.lineCap = 'round'; p.c.stroke();
    }
    p.dot(42, 36, 5, PAPER);
  },
  bottle: (p, h) => {
    p.box(50, 60, 34, 44, 12, shade(h, 0.3));
    p.box(50, 28, 14, 24, 5, shade(h, 0.3));
    p.box(50, 16, 16, 8, 3, '#8a6642');
    p.box(50, 60, 20, 26, 3, PAPER);
    p.line(43, 54, 57, 54, 3, shade(h, -0.3));
    p.line(43, 62, 53, 62, 3, shade(h, -0.3));
  },
  turtle: (p, h) => {
    p.oval(50, 52, 30, 22, hex(h));
    p.oval(50, 52, 12, 9, shade(h, -0.25));
    for (const [x, y] of [[32, 38], [68, 38], [32, 66], [68, 66]]) p.oval(x, y, 9, 6, shade(h, 0.35));
    p.dot(80, 46, 9, shade(h, 0.35));
    p.dot(83, 44, 3, INK);
  },
  chair: (p, h) => {
    p.box(50, 58, 52, 20, 8, hex(h));
    p.box(28, 44, 12, 34, 6, shade(h, -0.2));
    p.box(72, 44, 12, 34, 6, shade(h, -0.2));
    p.box(50, 34, 40, 12, 6, shade(h, 0.3));
    for (const x of [32, 68]) p.box(x, 74, 8, 14, 3, shade(h, -0.35));
  },
  door: (p, h) => {
    p.box(50, 52, 50, 70, 10, shade(h, -0.3));
    p.box(50, 54, 38, 58, 8, hex(h));
    p.dot(64, 56, 5, shade(h, 0.55));
    p.box(50, 26, 26, 10, 4, shade(h, 0.5));
  },
  friends: (p, h) => {
    p.dot(36, 40, 14, hex(h));
    p.c.beginPath(); p.c.arc(36, 76, 20, Math.PI, 0); p.c.closePath(); p.c.fillStyle = hex(h); p.c.fill();
    p.dot(66, 44, 12, shade(h, 0.4));
    p.c.beginPath(); p.c.arc(66, 78, 17, Math.PI, 0); p.c.closePath(); p.c.fillStyle = shade(h, 0.4); p.c.fill();
  },
  bubble: (p, h) => {
    p.box(50, 44, 70, 46, 16, hex(h));
    p.poly([[36, 64], [52, 64], [34, 80]], hex(h));
    for (const x of [36, 50, 64]) p.dot(x, 44, 5, PAPER);
  },
  compass: (p, h) => {
    p.dot(50, 50, 32, shade(h, 0.55));
    p.arc(50, 50, 32, 0, Math.PI * 2, 5, INK);
    p.poly([[50, 20], [58, 50], [50, 50], [42, 50]], hex(h));
    p.poly([[50, 80], [42, 50], [50, 50], [58, 50]], shade(h, -0.25));
    p.dot(50, 50, 5, INK);
  },
  check: (p, h) => {
    p.dot(50, 50, 32, hex(h));
    p.c.beginPath();
    p.c.moveTo(32, 52); p.c.lineTo(45, 66); p.c.lineTo(70, 34);
    p.c.strokeStyle = PAPER; p.c.lineWidth = 10; p.c.lineCap = 'round'; p.c.lineJoin = 'round'; p.c.stroke();
  },
  calendar: (p, h) => {
    p.box(50, 54, 64, 60, 8, PAPER);
    p.box(50, 32, 64, 16, 8, hex(h));
    for (const x of [36, 64]) p.line(x, 20, x, 30, 6, shade(h, -0.3));
    let i = 0;
    for (const y of [50, 66]) for (const x of [32, 50, 68]) p.box(x, y, 12, 10, 2, i++ === 4 ? hex(h) : shade(h, 0.6));
  },
  hat: (p, h) => {
    p.box(50, 66, 72, 12, 6, shade(h, -0.25));
    p.c.beginPath(); p.c.arc(50, 60, 26, Math.PI, 0); p.c.closePath(); p.c.fillStyle = hex(h); p.c.fill();
    p.box(50, 52, 54, 10, 5, shade(h, 0.5));
  },
  crown: (p, h) => {
    p.poly([[22, 68], [28, 30], [40, 48], [50, 24], [60, 48], [72, 30], [78, 68]], hex(h));
    p.box(50, 72, 58, 12, 5, shade(h, -0.2));
    for (const [x, y] of [[28, 28], [50, 22], [72, 28]]) p.dot(x, y, 6, shade(h, 0.5));
    p.dot(50, 60, 7, '#e8657a');
  },
  // milestone-only glyphs
  gramo: (p, h) => {
    p.box(50, 74, 56, 18, 6, '#8a6642');
    p.oval(46, 64, 20, 7, shade(h, -0.3));
    p.c.save(); p.c.translate(62, 44); p.c.rotate(0.5);
    p.poly([[-6, 22], [6, 22], [24, -20], [-24, -20]], hex(h));
    p.c.restore();
    p.dot(46, 64, 4, PAPER);
  },
  pick: (p, h) => {
    p.line(28, 76, 72, 30, 8, '#8a6642');
    p.c.save(); p.c.translate(70, 28); p.c.rotate(-0.5);
    p.poly([[-30, 0], [0, -10], [30, 0], [0, 8]], hex(h));
    p.c.restore();
    p.dot(38, 62, 5, shade(h, 0.5));
  },
  ribbon: (p, h) => {
    p.dot(50, 40, 22, hex(h));
    p.dot(50, 40, 13, shade(h, 0.5));
    p.poly([[34, 56], [46, 56], [42, 86], [30, 76]], shade(h, -0.15));
    p.poly([[54, 56], [66, 56], [70, 76], [58, 86]], shade(h, -0.15));
  },
};
/* eslint-enable no-unused-vars */

/**
 * Draw one stamp into a 2D context that has already been scaled so the drawing
 * box is `size` across. `earned` false gives the ghost: paper turned to dust,
 * art reduced to a silhouette, a dashed edge where the perforation would be.
 */
export function drawStamp(ctx, size, stamp, earned) {
  const s = size / 100;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const hue = stamp?.hue ?? 0xe8657a;
  const art = stamp?.glyph && Object.prototype.hasOwnProperty.call(GLYPH_ART, stamp.glyph)
    ? GLYPH_ART[stamp.glyph] : null;

  // paper
  const pen = makePen(ctx);
  pen.box(50, 50, 92, 92, 10, earned ? PAPER : '#efe7d6');
  // a tinted field so each stamp reads as its own little poster
  ctx.save();
  pen.box(50, 50, 82, 82, 7, earned ? shade(hue, 0.6) : '#e6ddca');
  ctx.restore();

  if (earned) {
    ctx.save();
    ctx.translate(50, 50);
    // the glyph fills the field: these are read at 46px on a quest card
    ctx.scale(0.86, 0.86);
    ctx.translate(-50, -50);
    if (art) art(pen, hue);
    else pen.star(50, 50, 30, 5, hex(hue));
    ctx.restore();
    // postmark: two rings in the corner, like the cove's own franking
    ctx.save();
    ctx.globalAlpha = 0.17;
    pen.arc(79, 25, 12, 0, Math.PI * 2, 3, INK);
    pen.arc(79, 25, 7, 0, Math.PI * 2, 3, INK);
    ctx.restore();
  } else {
    ctx.save();
    ctx.globalAlpha = 0.3;
    pen.box(50, 50, 30, 44, 14, '#b9ae95');
    pen.dot(50, 40, 9, '#efe7d6');
    ctx.fillStyle = '#8f846c';
    ctx.font = '900 34px "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 50, 54);
    ctx.restore();
  }

  // ink edge inside the paper
  ctx.globalAlpha = earned ? 0.75 : 0.35;
  pen.box(50, 50, 84, 84, 8, 'rgba(0,0,0,0)');
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.setLineDash(earned ? [] : [5, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // punch the perforation last so it eats paper, not background: this is the
  // one thing that makes the shape read as a stamp rather than a rounded tile
  ctx.globalCompositeOperation = 'destination-out';
  const N = 8;
  for (let i = 0; i < N; i++) {
    const t = 6 + (i / (N - 1)) * 88;
    for (const [x, y] of [[t, 5], [t, 95], [5, t], [95, t]]) {
      ctx.beginPath();
      ctx.arc(x, y, 5.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

/** Size a canvas for the display and paint one stamp into it. */
export function paintStampCanvas(canvas, stamp, earned, px) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = Math.round(px * dpr);
  canvas.height = Math.round(px * dpr);
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, px, px);
  drawStamp(ctx, px, stamp, earned);
}

// ---------------------------------------------------------------------------
// payload parsing (server shapes are tolerated loosely on purpose)
// ---------------------------------------------------------------------------

function toRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.profile && typeof raw.profile === 'object' ? { ...raw, ...raw.profile } : raw;
}

function normalizeProfile(raw) {
  const p = toRecord(raw);
  if (!p) return null;
  const id = p.id ?? p.playerId;
  const color = Number(p.color);
  return {
    id: id == null ? null : String(id),
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
    color: Number.isFinite(color) && color > 0 ? color : null,
    hat: typeof p.hat === 'string' && Object.prototype.hasOwnProperty.call(HATS, p.hat) ? p.hat : null,
    bot: p.bot === true,
    // undefined means "the server did not say", which is not the same as guest
    registered: typeof p.registered === 'boolean' ? p.registered : null,
    room: typeof p.room === 'string' ? p.room : null,
    online: typeof p.online === 'boolean' ? p.online : null,
    bests: p.bests && typeof p.bests === 'object' ? p.bests : {},
    isFriend: typeof p.isFriend === 'boolean' ? p.isFriend
      : typeof p.friend === 'boolean' ? p.friend : null,
  };
}

/**
 * Shared with friends.js: accepts [..] or {friends:[..]} or {players:[..]}.
 * A friendship is stored by account, so the id is only the CONNECTION id of a
 * friend who happens to be online: entries keep their name and a null id when
 * they are not around, and callers gate "open their card" on the id.
 */
export function normalizeFriends(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.friends) ? raw.friends
      : Array.isArray(raw?.players) ? raw.players : [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const id = f.id ?? f.playerId;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name && (id == null || id === '')) continue; // nothing to show or click
    const room = typeof f.room === 'string' && Object.prototype.hasOwnProperty.call(ROOM_INFO, f.room)
      ? f.room : null;
    out.push({
      id: id == null || id === '' ? null : String(id),
      name: name || 'A quiet capybara',
      online: typeof f.online === 'boolean' ? f.online : !!room,
      room,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// styles: ONE tag for both social overlays (pf- = player card, fr- = friends)
// ---------------------------------------------------------------------------

const STYLE_ID = 'capy-social-styles';

const CSS = `
.pf-overlay, .fr-overlay {
  position: absolute; inset: 0; padding: 18px; display: flex;
  align-items: center; justify-content: center;
  background: rgba(20, 32, 44, 0.55); backdrop-filter: blur(7px) saturate(1.15);
  animation: pf-fade 0.18s ease;
}
/* above the map/shop (40) and the pause menu (42); the card sits on the list */
.pf-overlay { z-index: 44; }
.fr-overlay { z-index: 43; }
.pf-overlay.is-closing, .fr-overlay.is-closing {
  opacity: 0; transition: opacity 0.15s ease; pointer-events: none;
}

.pf-card, .fr-card {
  position: relative; background: var(--cream); border: 4px solid #fff;
  border-radius: 26px; box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  max-height: 92vh; overflow: auto;
  animation: pf-rise 0.3s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.pf-card:focus, .fr-card:focus { outline: none; }
/* wide enough that the 50-stamp album gets four columns next to the turntable */
.pf-card { width: min(608px, 94vw); padding: 22px 24px 18px; }
.fr-card { width: min(430px, 94vw); padding: 22px 22px 16px; }
.pf-x, .fr-x { position: absolute; top: 14px; right: 14px; z-index: 2; }

/* ---- player card ---- */
.pf-body { display: flex; gap: 18px; align-items: flex-start; margin-top: 2px; }
.pf-stage { width: 200px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.pf-stage-frame {
  position: relative; width: 200px; height: 232px; border-radius: 22px; overflow: hidden;
  background: radial-gradient(ellipse 72% 62% at 50% 36%, #fffaea 0%, #ffeec9 44%, #f6dda6 72%, #ecca86 100%);
  box-shadow: inset 0 -18px 30px rgba(178, 136, 64, 0.22),
    inset 0 0 0 3px rgba(255, 255, 255, 0.7), 0 6px 18px rgba(45, 36, 23, 0.14);
}
.pf-canvas { position: absolute; inset: 0; width: 200px; height: 232px; display: block; }
.pf-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(202deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 40%);
}
.pf-fallback {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 22px; font-weight: 800; font-size: 12.5px; color: #a3906c;
}
.pf-outfit {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  font-weight: 700; font-size: 12px; color: var(--muted); min-height: 16px;
}
.pf-dot-color {
  width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; flex: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

.pf-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
.pf-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-right: 40px; }
.pf-name {
  font-size: 24px; font-weight: 900; line-height: 1.1; letter-spacing: 0.01em;
  overflow-wrap: anywhere;
}
.pf-chip {
  font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; background: rgba(79, 179, 232, 0.2);
  color: #2f7fae; flex: none;
}
.pf-chip.is-friend { background: rgba(232, 101, 122, 0.18); color: #c0455c; }
.pf-chip.is-self { background: rgba(242, 182, 74, 0.28); color: #a4720f; }
.pf-title { font-weight: 800; font-size: 13.5px; color: var(--accent); margin-top: -4px; }
.pf-where { font-size: 12.5px; font-weight: 700; color: var(--muted); min-height: 16px; }
.pf-where b { color: var(--ink); }

.pf-section {
  font-size: 10px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase;
  color: #b6a688; margin-top: 4px;
}
.pf-medals { display: flex; flex-direction: column; gap: 7px; }
.pf-row {
  display: flex; align-items: center; gap: 11px; background: var(--card);
  border-radius: 15px; padding: 8px 13px; box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.32s backwards var(--spring); animation-delay: calc(var(--i) * 70ms);
}
.pf-medal {
  width: 30px; height: 30px; border-radius: 50%; flex: none;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.55), 0 2px 5px rgba(45, 36, 23, 0.2);
}
.pf-medal.is-gold { background: radial-gradient(circle at 34% 28%, #fff3bd 0%, var(--gold) 58%, #c98c1d 100%); }
.pf-medal.is-silver { background: radial-gradient(circle at 34% 28%, #ffffff 0%, #c3cedb 54%, #7d8b9b 100%); }
.pf-medal.is-bronze { background: radial-gradient(circle at 34% 28%, #ffdcb6 0%, #d18b4d 58%, #96592a 100%); }
.pf-medal.is-none {
  background: rgba(45, 36, 23, 0.05);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.12);
}
.pf-row-txt { flex: 1; min-width: 0; }
.pf-row-name { font-weight: 900; font-size: 13.5px; line-height: 1.2; }
.pf-row-sub { font-size: 11px; font-weight: 700; color: #a3906c; line-height: 1.3; }
.pf-row-score { font-weight: 900; font-size: 16px; text-align: right; flex: none; }
.pf-row-score.is-empty { color: #cbbb98; font-size: 20px; line-height: 1; }

.pf-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; min-height: 20px; }
.pf-fbtn {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 13.5px;
  padding: 9px 18px; border-radius: 999px; color: #fff;
  background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  box-shadow: 0 4px 0 rgba(150, 55, 72, 0.32), 0 8px 18px rgba(45, 36, 23, 0.18);
  transition: scale 0.12s ease, filter 0.16s ease, background 0.2s ease;
}
.pf-fbtn:hover:not(:disabled) { scale: 1.06; filter: brightness(1.05); }
.pf-fbtn:active:not(:disabled) { scale: 0.95; }
.pf-fbtn:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }
.pf-fbtn.is-remove {
  background: linear-gradient(180deg, #fffefa 0%, #f2e6cd 100%); color: var(--ink);
  box-shadow: 0 4px 0 rgba(45, 36, 23, 0.14), 0 8px 18px rgba(45, 36, 23, 0.14);
}
.pf-fbtn.is-den {
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%); color: var(--ink);
  box-shadow: 0 4px 0 rgba(158, 111, 20, 0.3), 0 8px 18px rgba(45, 36, 23, 0.16);
}
.pf-fbtn:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.pf-note {
  font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.4;
  background: rgba(45, 36, 23, 0.05); border-radius: 12px; padding: 8px 12px; flex: 1; min-width: 160px;
}
.pf-note b { color: var(--ink); }

/* ---- friends list ---- */
.fr-head { display: flex; align-items: baseline; gap: 9px; padding-right: 44px; }
.fr-head h2 { font-size: 24px; margin: 0; color: var(--accent); letter-spacing: 0.02em; }
.fr-count { font-size: 12px; font-weight: 800; color: var(--muted); }
.fr-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; margin: 2px 0 12px; }
.fr-list { display: flex; flex-direction: column; gap: 7px; max-height: 46vh; overflow-y: auto; padding: 2px; }
.fr-row {
  display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
  border: 0; font-family: var(--font); cursor: pointer; background: var(--card);
  border-radius: 15px; padding: 10px 13px; color: var(--ink);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  transition: transform 0.14s ease, box-shadow 0.16s ease, background 0.16s ease;
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 45ms);
}
.fr-row:hover { transform: translateY(-2px); background: #fffdf2; box-shadow: 0 7px 14px rgba(45, 36, 23, 0.14); }
.fr-row:active { transform: translateY(0); }
.fr-row:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.fr-dot {
  position: relative; width: 11px; height: 11px; border-radius: 50%; flex: none;
  background: #c8bda4; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6);
}
.fr-dot.is-on { background: #6fcf5f; }
.fr-dot.is-on::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 2px solid rgba(111, 207, 95, 0.7); animation: fr-ping 2.6s ease-out infinite;
}
/* a row is the card button plus, for anyone who is around, a den door on top */
.fr-item { position: relative; }
.fr-item.has-den .fr-row { padding-right: 54px; }
.fr-den {
  position: absolute; right: 10px; top: 50%; translate: 0 -50%;
  width: 34px; height: 34px; border: 0; border-radius: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font); font-size: 15px; line-height: 1; color: var(--ink);
  background: linear-gradient(180deg, #fffefa 0%, #f4e7cd 100%);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.14), 0 6px 12px rgba(45, 36, 23, 0.12);
  transition: scale 0.12s ease, translate 0.14s ease, filter 0.16s ease;
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 45ms + 70ms);
}
/* the row lifts on hover; the door rides along instead of peeling off it */
.fr-item:hover .fr-den { translate: 0 calc(-50% - 2px); }
.fr-den:hover { scale: 1.1; filter: brightness(1.05); }
.fr-den:active { scale: 0.93; }
.fr-den:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.fr-txt { flex: 1; min-width: 0; }
.fr-name { font-weight: 900; font-size: 14px; line-height: 1.2; overflow-wrap: anywhere; }
.fr-where { font-size: 11.5px; font-weight: 700; color: #a3906c; }
.fr-go { font-size: 11px; font-weight: 900; color: var(--accent2); letter-spacing: 0.06em; flex: none; }
.fr-empty { text-align: center; padding: 20px 14px 10px; }
/* a little capy face, drawn in gradients: nobody likes an empty box */
.fr-empty-art {
  position: relative; width: 72px; height: 72px; margin: 6px auto 16px; border-radius: 50%;
  background:
    radial-gradient(circle 3.5px at 37% 45%, #2d2417 98%, transparent 100%),
    radial-gradient(circle 3.5px at 63% 45%, #2d2417 98%, transparent 100%),
    radial-gradient(circle 3px at 50% 62%, #4a3524 98%, transparent 100%),
    radial-gradient(ellipse 17px 12px at 50% 68%, #c9a06b 98%, transparent 100%),
    radial-gradient(circle at 38% 30%, #ffeec9 0%, #e8c78e 62%, #cfa86d 100%);
  box-shadow: inset 0 -7px 13px rgba(150, 110, 55, 0.28), 0 5px 13px rgba(45, 36, 23, 0.16);
  animation: fr-bob 3.4s ease-in-out infinite;
}
.fr-empty-art::before, .fr-empty-art::after {
  content: ''; position: absolute; top: -5px; width: 17px; height: 15px; border-radius: 50%;
  background: #e0bd85; box-shadow: inset 0 -3px 5px rgba(150, 110, 55, 0.3);
}
.fr-empty-art::before { left: 3px; }
.fr-empty-art::after { right: 3px; }
.fr-empty h3 { font-size: 16px; margin-bottom: 6px; }
.fr-empty p { font-size: 12.5px; font-weight: 700; color: var(--muted); line-height: 1.5; }
.fr-foot { margin-top: 12px; font-size: 11.5px; font-weight: 700; color: #b6a688; text-align: center; }

/* friends HUD button badge */
.fr-hud-badge {
  position: absolute; top: -4px; right: -4px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; background: var(--accent); color: #fff; border: 2px solid var(--cream);
  font-size: 10px; font-weight: 900; line-height: 15px; text-align: center; pointer-events: none;
  animation: pf-pop 0.34s var(--spring);
}

/* ---- stamp album (wave 7) ---- */
.pf-tabs { display: flex; gap: 6px; margin-top: 6px; }
.pf-tab {
  flex: 1; border: 0; cursor: pointer; font-family: var(--font); color: #a3906c;
  font-size: 10px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase;
  padding: 7px 8px; border-radius: 999px; background: rgba(45, 36, 23, 0.06);
  transition: background 0.16s ease, color 0.16s ease, scale 0.12s ease;
}
.pf-tab:hover { background: rgba(45, 36, 23, 0.11); }
.pf-tab:active { scale: 0.96; }
.pf-tab.is-on { background: var(--gold); color: #6b4c0c; box-shadow: 0 3px 0 rgba(158, 111, 20, 0.28); }
.pf-tab:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.pf-pane[hidden] { display: none; }

.pf-album-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-size: 11.5px; font-weight: 800; color: #a3906c;
}
.pf-album-head b { font-size: 15px; color: var(--ink); }
.pf-mile {
  margin: 8px 0 10px; background: var(--card); border-radius: 15px; padding: 11px 13px 9px;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
}
.pf-mile-top { font-size: 11px; font-weight: 800; color: var(--muted); margin-bottom: 8px; }
.pf-mile-top b { color: var(--accent); }
.pf-mile-bar {
  position: relative; height: 9px; border-radius: 999px; background: rgba(45, 36, 23, 0.1);
  margin: 0 6px 4px;
}
.pf-mile-fill {
  position: absolute; inset: 0 auto 0 0; border-radius: 999px; width: 0;
  background: linear-gradient(90deg, var(--gold) 0%, var(--accent) 100%);
  transition: width 0.6s var(--spring);
}
.pf-mile-nodes { position: relative; height: 44px; margin: 0 6px; }
.pf-mile-node {
  position: absolute; top: -12px; translate: -50% 0; width: 30px; text-align: center;
}
.pf-mile-node canvas { display: block; margin: 0 auto; filter: grayscale(1) opacity(0.42); }
.pf-mile-node.is-hit canvas { filter: none; }
.pf-mile-node span {
  display: block; font-size: 9.5px; font-weight: 900; color: #b6a688; margin-top: 1px;
}
.pf-mile-node.is-hit span { color: var(--accent); }

.pf-album {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
  gap: 7px; max-height: 40vh; overflow-y: auto; padding: 3px;
}
.pf-stamp {
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 5px 3px 6px; border-radius: 13px; background: var(--card); border: 0;
  font-family: var(--font); cursor: default; color: var(--ink);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 18ms);
}
.pf-stamp.is-earned { cursor: help; }
.pf-stamp canvas { display: block; }
.pf-stamp-name {
  font-size: 9.5px; font-weight: 900; line-height: 1.15; text-align: center;
  color: #a3906c; overflow-wrap: anywhere;
}
.pf-stamp.is-earned .pf-stamp-name { color: var(--ink); }
.pf-album-empty {
  grid-column: 1 / -1; text-align: center; font-size: 12px; font-weight: 700;
  color: var(--muted); padding: 16px 10px; line-height: 1.5;
}

@keyframes pf-fade { from { opacity: 0; } }
@keyframes pf-rise { from { opacity: 0; transform: translateY(16px) scale(0.95); } }
@keyframes pf-pop { from { opacity: 0; transform: translateY(9px) scale(0.92); } }
@keyframes fr-ping { 0% { scale: 0.7; opacity: 0.9; } 70%, 100% { scale: 2.4; opacity: 0; } }
@keyframes fr-bob { 50% { transform: translateY(-5px) rotate(-3deg); } }

@media (max-width: 640px) {
  .pf-body { flex-direction: column; align-items: center; }
  .pf-info { width: 100%; }
  .pf-name-row { padding-right: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pf-card, .fr-card, .pf-row, .fr-row, .fr-den, .fr-dot.is-on::after,
  .fr-hud-badge, .fr-empty-art, .pf-stamp { animation: none; }
  .pf-mile-fill { transition: none; }
}
`;

/** Injects the shared pf-/fr- stylesheet once. Safe to call repeatedly. */
export function ensureSocialStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// 3D turntable (same recipe as the wardrobe mirror, smaller stage)
// ---------------------------------------------------------------------------

const PREVIEW_W = 200;
const PREVIEW_H = 232;

function buildTurntable(canvas, look) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(PREVIEW_W, PREVIEW_H, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, PREVIEW_W / PREVIEW_H, 0.1, 40);
  camera.position.set(0, 1.28, 3.6);
  camera.lookAt(0, 0.9, 0);

  scene.add(new THREE.HemisphereLight(0xfff3da, 0x8a6642, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2.4, 4.2, 3.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fd4ff, 0.45);
  rim.position.set(-3, 1.8, -2.6);
  scene.add(rim);

  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.92, 0.16, 20), makeToon(0xf0dca0));
  ped.position.y = -0.08;
  scene.add(ped);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.03, 8, 26), makeGlow(0xf2b64a));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  scene.add(ring);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const avatar = createAvatar({ color: look.color, hat: look.hat });
  turntable.add(avatar.group);
  avatar.playWave(); // say hello the moment the card opens

  let raf = 0;
  let last = 0;
  let punch = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    punch *= Math.exp(-dt * 5);
    turntable.rotation.y += dt * 0.5;
    avatar.update(dt);
    avatar.group.scale.setScalar(1 + punch * 0.12);
    ring.scale.setScalar(1 + punch * 0.1);
    renderer.render(scene, camera);
  }

  return {
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    setLook(color, hat) {
      if (color != null && color !== avatar.state.color) avatar.setColor(color);
      if (hat != null && hat !== avatar.state.hat) {
        const stale = avatar.hatAnchor.children.slice();
        avatar.setHat(hat);
        for (const o of stale) disposeObject(o);
      }
    },
    celebrate() { punch = 0.9; avatar.playWave(); },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      disposeObject(scene); // frees geometry; shared avatar/toon resources survive
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not every context supports it */ }
    },
  };
}

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

let openInstance = null;

function elm(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function mountPoint() {
  return document.getElementById('hud-root')
    || document.getElementById('overlay-root')
    || document.body;
}

/** Everything the net client already knows about this capybara, right now. */
function localLook(game, playerId) {
  const r = game.net?.remotes?.get?.(playerId);
  const p = r?.p;
  if (!p) return null;
  return {
    name: typeof p.name === 'string' ? p.name : null,
    color: Number.isFinite(Number(p.color)) ? Number(p.color) : null,
    hat: typeof p.hat === 'string' && Object.prototype.hasOwnProperty.call(HATS, p.hat) ? p.hat : null,
    bot: !!p.bot,
  };
}

/**
 * Open the player card for a remote player id.
 * Re-opening for the same player is a no-op; a different player swaps cards.
 */
export function openProfile(game, playerId) {
  if (typeof document === 'undefined' || playerId == null) return;
  const id = String(playerId);
  if (openInstance) {
    if (openInstance.id === id) return;
    openInstance.close(true);
  }
  ensureSocialStyles();

  const isSelf = game.net?.selfId != null && String(game.net.selfId) === id;
  const local = localLook(game, id);

  // what we believe about them; profile-data overwrites the parts it knows
  const who = {
    id,
    name: isSelf ? game.state.name : (local?.name || null),
    color: isSelf ? game.state.color : (local?.color ?? null),
    hat: isSelf ? game.state.hat : (local?.hat ?? null),
    bot: !isSelf && !!local?.bot,
    registered: isSelf ? !!game.state.registered : null,
    room: isSelf ? game.roomId : (local ? game.roomId : null),
    online: isSelf ? true : (local ? true : null),
    bests: isSelf ? game.state.bests || {} : {},
    isFriend: null,
    // null means "not answered yet", which is not the same as an empty album
    stamps: isSelf && game.state.stamps ? normalizeStamps(game.state.stamps).ids : null,
    // the 40-stamp milestone title, when the server has one for them: it beats
    // the flavour line below, because it was actually earned
    title: (isSelf && typeof game.state.title === 'string' && game.state.title) || '',
    loaded: isSelf,
  };

  const root = elm('div', 'pf-overlay');
  root.innerHTML = `
    <div class="pf-card" role="dialog" aria-label="Player card" tabindex="-1">
      <button class="hud-btn pf-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="pf-body">
        <div class="pf-stage">
          <div class="pf-stage-frame">
            <canvas class="pf-canvas"></canvas>
            <div class="pf-shine"></div>
          </div>
          <div class="pf-outfit"><span class="pf-dot-color"></span><span class="pf-outfit-txt"></span></div>
        </div>
        <div class="pf-info">
          <div>
            <div class="pf-name-row"><span class="pf-name"></span></div>
            <div class="pf-title"></div>
          </div>
          <div class="pf-where"></div>
          <div class="pf-tabs">
            <button class="pf-tab is-on" type="button" data-tab="medals">Achievements</button>
            <button class="pf-tab" type="button" data-tab="album">Stamp album</button>
          </div>
          <div class="pf-pane" data-pane="medals"><div class="pf-medals"></div></div>
          <div class="pf-pane" data-pane="album" hidden>
            <div class="pf-album-head"><span>Stamps in the album</span><b class="pf-album-count">-</b></div>
            <div class="pf-mile">
              <div class="pf-mile-top"></div>
              <div class="pf-mile-bar"><i class="pf-mile-fill"></i></div>
              <div class="pf-mile-nodes"></div>
            </div>
            <div class="pf-album"></div>
          </div>
          <div class="pf-actions"></div>
        </div>
      </div>
    </div>
  `;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.pf-card');
  const nameRow = q('.pf-name-row');
  const nameEl = q('.pf-name');
  const titleEl = q('.pf-title');
  const whereEl = q('.pf-where');
  const medalsEl = q('.pf-medals');
  const actionsEl = q('.pf-actions');
  const outfitDot = q('.pf-dot-color');
  const outfitTxt = q('.pf-outfit-txt');
  const canvas = q('.pf-canvas');
  const albumEl = q('.pf-album');
  const albumCount = q('.pf-album-count');
  const mileTop = q('.pf-mile-top');
  const mileFill = q('.pf-mile-fill');
  const mileNodes = q('.pf-mile-nodes');

  // ---- 3D stage ------------------------------------------------------------
  let stage = null;
  try {
    stage = buildTurntable(canvas, { color: who.color ?? 0xb08a5a, hat: who.hat ?? 'none' });
    stage.start();
  } catch {
    canvas.remove();
    q('.pf-stage-frame').appendChild(
      elm('div', 'pf-fallback', 'Their portrait is still drying, but the numbers below are real.'),
    );
  }

  // ---- render --------------------------------------------------------------
  function renderHead() {
    nameEl.textContent = who.name || 'Someone friendly';
    for (const chip of [...nameRow.querySelectorAll('.pf-chip')]) chip.remove();
    if (isSelf) nameRow.appendChild(elm('span', 'pf-chip is-self', 'You'));
    else if (who.bot) nameRow.appendChild(elm('span', 'pf-chip', 'Cove local'));
    else if (who.isFriend) nameRow.appendChild(elm('span', 'pf-chip is-friend', 'Friend'));
    titleEl.textContent = who.title || flavorTitle(who.bests, who.bot, isSelf);

    const roomName = who.room && Object.prototype.hasOwnProperty.call(ROOM_INFO, who.room)
      ? ROOM_INFO[who.room].name : null;
    whereEl.textContent = '';
    if (roomName) {
      whereEl.appendChild(elm('span', null, 'Hanging out in '));
      whereEl.appendChild(elm('b', null, roomName));
    } else if (who.online === false) {
      whereEl.textContent = 'Off exploring somewhere else right now.';
    } else if (who.loaded) {
      whereEl.textContent = 'Somewhere around the cove.';
    } else {
      whereEl.textContent = 'Looking them up...';
    }

    const c = who.color ?? 0xb08a5a;
    outfitDot.style.background = `#${(c >>> 0).toString(16).padStart(6, '0')}`;
    const hatName = who.hat && who.hat !== 'none' ? HATS[who.hat]?.name : null;
    outfitTxt.textContent = hatName ? `Wearing the ${hatName}` : 'No hat, all confidence';
  }

  function renderMedals() {
    medalsEl.textContent = '';
    Object.keys(MEDAL_TIERS).forEach((gid, i) => {
      const meta = Object.prototype.hasOwnProperty.call(MINIGAMES, gid) ? MINIGAMES[gid] : null;
      const best = bestOf(who.bests, gid);
      const tier = medalTier(gid, best);
      const next = nextCut(gid, best);

      const row = elm('div', 'pf-row');
      row.style.setProperty('--i', String(i));
      row.title = MEDAL_BLURB[gid] || meta?.name || gid;
      const medal = elm('div', `pf-medal ${TIER_CLASS[tier]}`);
      medal.title = `${TIER_LABEL[tier]}${next != null ? ` : ${next} for the next one` : ' : maxed out'}`;
      const txt = elm('div', 'pf-row-txt');
      txt.appendChild(elm('div', 'pf-row-name', meta?.name || gid));
      txt.appendChild(elm('div', 'pf-row-sub', medalSub(best, tier, next)));
      const score = elm('div', `pf-row-score${best == null ? ' is-empty' : ''}`, best == null ? '-' : String(best));
      row.append(medal, txt, score);
      medalsEl.appendChild(row);
    });
  }

  // ---- stamp album ---------------------------------------------------------
  // The milestone rail is built once (the thresholds never move); only the
  // "reached" state and the fill width change as stamps land.
  const track = milestoneTrack();
  const trackMax = track.length ? track[track.length - 1].at : 40;
  const mileRefs = track.map((m) => {
    const node = elm('div', 'pf-mile-node');
    node.style.left = `${Math.min(100, (m.at / trackMax) * 100)}%`;
    const c = document.createElement('canvas');
    paintStampCanvas(c, m, true, 26);
    node.append(c, elm('span', null, String(m.at)));
    node.title = `${m.at} stamps: ${m.name}`;
    mileNodes.appendChild(node);
    return { node, m };
  });

  function renderAlbum() {
    const cat = stampCatalog();
    const known = who.stamps != null;
    const earned = new Set(who.stamps || []);
    const count = earned.size;

    albumCount.textContent = known ? `${count} / ${cat.length}` : '-';

    const next = track.find((m) => m.at > count);
    mileTop.textContent = '';
    if (!known) {
      mileTop.textContent = 'Reading the album...';
    } else if (next) {
      mileTop.append(
        document.createTextNode(`${Math.max(0, next.at - count)} more for `),
        elm('b', null, next.name),
      );
    } else {
      mileTop.append(elm('b', null, 'Every milestone claimed.'));
      mileTop.append(document.createTextNode(' Nothing left to unlock, everything left to show off.'));
    }
    mileFill.style.width = `${Math.min(100, (count / trackMax) * 100)}%`;
    for (const r of mileRefs) r.node.classList.toggle('is-hit', known && count >= r.m.at);

    albumEl.textContent = '';
    if (!known) {
      albumEl.appendChild(elm('div', 'pf-album-empty',
        isSelf ? 'Fetching your album from the cove...' : 'Asking around about their album...'));
      return;
    }
    cat.forEach((s, i) => {
      const got = earned.has(s.id);
      const tile = elm('div', `pf-stamp${got ? ' is-earned' : ''}`);
      tile.style.setProperty('--i', String(i));
      const c = document.createElement('canvas');
      paintStampCanvas(c, s, got, 62);
      tile.appendChild(c);
      tile.appendChild(elm('div', 'pf-stamp-name', got ? s.name : 'Locked'));
      tile.title = got ? `${s.name} : ${s.desc}` : `Not yet : ${s.how || s.desc}`;
      albumEl.appendChild(tile);
    });
  }

  let askedStamps = false;
  let stampsTimer = 0;
  function askStamps() {
    if (askedStamps || who.stamps != null) return;
    askedStamps = true;
    game.net?.send?.({ t: 'stamps', id: isSelf ? undefined : who.id });
    // the server may not answer at all (older build, guest); an empty album
    // reads honestly, a spinner that never stops does not
    stampsTimer = setTimeout(() => {
      stampsTimer = 0;
      if (who.stamps == null) { who.stamps = []; renderAlbum(); }
    }, 4000);
  }

  for (const tab of root.querySelectorAll('.pf-tab')) {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      for (const t of root.querySelectorAll('.pf-tab')) t.classList.toggle('is-on', t === tab);
      for (const p of root.querySelectorAll('.pf-pane')) p.hidden = p.dataset.pane !== which;
      game.audio?.play?.('click');
      if (which === 'album') askStamps();
    });
  }

  function note(text) {
    const n = elm('div', 'pf-note', text);
    n.title = text;
    return n;
  }

  let busy = false;

  /**
   * A door for anyone with an account. Bots have no den, guests have no den,
   * and until the server answers we do not know which of those they are, so the
   * button simply is not there yet.
   */
  function denButton() {
    const hasDen = isSelf ? !!game.state.registered : who.registered === true;
    if (who.bot || !hasDen || !who.name) return null;
    const b = elm('button', 'pf-fbtn is-den', isSelf ? 'Visit your den' : 'Visit their den');
    b.type = 'button';
    b.disabled = !game.net?.connected;
    b.title = isSelf ? 'Waddle home to your own den' : `Knock on ${who.name}'s door`;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      game.audio?.play?.('click');
      close(true); // the world needs the screen back for the trip
      visitHouse(game, who.name);
    });
    return b;
  }

  function renderActions() {
    actionsEl.textContent = '';
    const den = denButton();
    if (isSelf) {
      if (den) actionsEl.appendChild(den);
      actionsEl.appendChild(note('This is you. Looking good out there.'));
      return;
    }
    if (who.bot) return; // bots keep no address book, and that is fine
    if (!who.loaded) {
      if (!game.net?.connected) {
        actionsEl.appendChild(note('Friends need a connection to the cove. Yours will come back on its own.'));
        return;
      }
      const b = elm('button', 'pf-fbtn', 'Checking...');
      b.type = 'button';
      b.disabled = true;
      actionsEl.appendChild(b);
      return;
    }
    if (!game.state.registered) {
      // a guest cannot make friends, but an open door is still an open door
      if (den) actionsEl.appendChild(den);
      actionsEl.appendChild(note('Friends stick around only with an account. Make one from the title screen and you can keep them.'));
      return;
    }
    if (who.registered === false) {
      actionsEl.appendChild(note(`${who.name || 'They'} is visiting as a guest, so there is nobody to add yet. Say hi instead.`));
      return;
    }

    const isFriend = who.isFriend === true;
    const b = elm('button', `pf-fbtn${isFriend ? ' is-remove' : ''}`, isFriend ? 'Remove friend' : 'Add friend');
    b.type = 'button';
    b.disabled = busy || !game.net?.connected;
    b.title = isFriend
      ? `Take ${who.name || 'them'} off your friends list`
      : `Add ${who.name || 'them'} to your friends list`;
    b.addEventListener('click', () => toggleFriend(isFriend));
    actionsEl.appendChild(b);
    if (den) actionsEl.appendChild(den);
    if (!game.net?.connected) actionsEl.appendChild(note('Offline right now, so the friend book is closed.'));
  }

  function toggleFriend(wasFriend) {
    if (busy || !game.net?.connected) return;
    busy = true;
    who.isFriend = !wasFriend;
    // both keys: the server resolves the connection id, and falls back to the
    // account name if that session has already gone (see friendTarget())
    game.net.send({ t: wasFriend ? 'friend-remove' : 'friend-add', id: who.id, name: who.name || undefined });
    game.net.send({ t: 'friends' });
    game.audio?.play?.(wasFriend ? 'click' : 'success');
    game.toast(wasFriend
      ? `${who.name || 'They'} left your friends list. No hard feelings.`
      : `${who.name || 'They'} is on your friends list now!`);
    if (!wasFriend) stage?.celebrate();
    renderHead();
    renderActions();
    // the server has the last word; unlock once it answers (or shortly after)
    setTimeout(() => { busy = false; renderActions(); }, 700);
  }

  function renderAll() {
    renderHead();
    renderMedals();
    renderAlbum();
    renderActions();
  }

  renderAll();

  // ---- live data -----------------------------------------------------------
  const unsubs = [
    game.events.on('profile-data', (payload, extra) => {
      // tolerate both emit(payload) and emit(id, payload)
      const keyed = extra && typeof extra === 'object'
        && (typeof payload === 'string' || typeof payload === 'number');
      const raw = keyed ? { id: payload, ...extra } : payload;
      const p = normalizeProfile(raw);
      if (!p) return;
      if (p.id != null && p.id !== who.id) return; // someone else's card
      if (p.name) who.name = p.name;
      if (p.color != null) who.color = p.color;
      if (p.hat != null) who.hat = p.hat;
      if (p.bot) who.bot = true;
      if (p.registered != null) who.registered = p.registered;
      if (p.room != null) who.room = p.room;
      if (p.online != null) who.online = p.online;
      if (p.isFriend != null) who.isFriend = p.isFriend;
      if (raw && typeof raw === 'object' && typeof raw.title === 'string') {
        who.title = raw.title.trim().slice(0, 32);
      }
      who.bests = { ...who.bests, ...p.bests };
      // the album can ride along on the profile frame; if it does, no second ask
      if (raw && typeof raw === 'object' && raw.stamps != null) {
        who.stamps = normalizeStamps(raw).ids;
      }
      who.loaded = true;
      stage?.setLook(who.color, who.hat);
      renderAll();
    }),
    game.events.on('stamps', (payload) => {
      const s = normalizeStamps(payload);
      // an unkeyed frame is the server answering about us
      if (s.id != null && s.id !== who.id) return;
      if (s.id == null && !isSelf) return;
      who.stamps = s.ids;
      // the album frame carries the milestone title; adopt it so the card (and
      // our own state, for the next card we open) is right straight away
      if (typeof payload?.title === 'string') {
        who.title = payload.title.trim().slice(0, 32);
        if (isSelf) game.state.title = who.title;
      }
      renderAlbum();
      renderHead();
    }),
    // a stamp earned while the card is open lands in the album straight away
    game.events.on('stamp', (m) => {
      if (!isSelf || !m || typeof m.id !== 'string') return;
      who.stamps = [...new Set([...(who.stamps || []), m.id])];
      renderAlbum();
    }),
    game.events.on('friends-data', (payload) => {
      if (isSelf || who.bot) return;
      const list = normalizeFriends(payload);
      // an offline friend has no connection id, so the name is the only key left
      who.isFriend = list.some((f) => (f.id != null && f.id === who.id)
        || (!!who.name && f.name === who.name));
      busy = false;
      renderHead();
      renderActions();
    }),
  ];

  // ask the server for the real record (bests, account status, friendship)
  if (!isSelf) {
    game.net?.send?.({ t: 'inspect', id: who.id });
    if (game.state.registered) game.net?.send?.({ t: 'friends' });
  }
  askStamps(); // the album tab should be warm the moment it is clicked
  // never leave the card stuck on "Checking..."
  const settle = setTimeout(() => {
    if (who.loaded) return;
    who.loaded = true;
    renderAll();
  }, 5000);

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close(silent = false) {
    if (closed) return;
    closed = true;
    if (openInstance?.id === id) openInstance = null;
    clearTimeout(settle);
    if (stampsTimer) { clearTimeout(stampsTimer); stampsTimer = 0; }
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    try { stage?.dispose(); } catch { /* context may already be lost */ }
    stage = null;
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    if (!silent) game.audio?.play?.('click');
  }

  function onBackdrop(e) { if (e.target === root) close(); }
  function onKey(e) {
    // the card owns the keyboard while it is up (no walking off mid-chat)
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.pf-x').addEventListener('click', () => close());
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  openInstance = { id, close };
}
