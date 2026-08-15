import * as THREE from 'three';
import { Minigame } from '../minigame.js';
import { makeToon, makeGlow, canvasTexture, disposeObject } from '../../core/materials.js';
import { buildHat } from '../../player/hats.js';
import { buildCritter } from './critters.js';
import { clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Capy Clash : the Game Den's flagship 1v1 card duel (docs/CARDGAME.md).
 *
 * v2 SPECTACLE (docs/CARDGAME.md section 10). The rules, the AI, the coins and
 * the PvP wire protocol are EXACTLY what shipped in v1: everything added here
 * is a presentation layer that reads the rules core's own `S.fx` event log and
 * puts on a show. The hand stays 2D DOM (readability first); the board is a 3D
 * battle diorama rendered by one WebGLRenderer behind the DOM.
 *
 * How the show is wired (the rules for the rules of the show):
 *  - `_consumeFx()` is the ONLY bridge. It splices the rules core's event log
 *    and turns it into stage beats. The stage never writes to `S`.
 *  - An action event (summon / swing / cast) claims the events that follow it
 *    in the same batch and replays their juice at the dramatic moment (the slam,
 *    the impact, the spell payload). State is already applied by then: only the
 *    pixels are late.
 *  - Nothing in here touches `_sendMove`, `_onMatchMove` or the `busy` windows
 *    that pace remote intents, so a den match runs at exactly the timings it
 *    ran at before. Animations are local; the queue plays over the authoritative
 *    state and is reconciled against the board every render (`_syncStage`).
 *  - Input is blocked only during hit-stop (<=90ms) and the finish cam (<=1.5s).
 *    A 'fast mode' toggle on the splash halves every duration constant, and
 *    prefers-reduced-motion collapses shakes and flashes into fades.
 *
 * The 3D critter models come from ./critters.js. Contract consumed here:
 *    buildCritter(cardId) -> { group, update(dtSeconds), play(name)->seconds,
 *                              dispose(), id, name, el, height, tris, speed }
 *    play(name): 'attack' | 'hurt' | 'ko' | 'cheer'; overlays pose the rig
 *    around its own origin and the STAGE moves the group across the board.
 *    `speed` is a rate (2 = twice as fast), so fast mode sets 1 / this.speed.
 * That module also exports `buildElementBurst` and `CRITTER_IDS`; neither is
 * used here on purpose. Section 10 asks for ONE pooled instanced particle
 * system for the whole diorama, and this file already owns it, so every burst,
 * mote and shatter comes out of that pool instead. The rig's own contact-shadow
 * blob is hidden for the same reason (the stage draws the slot's shadow).
 * If a build ever throws, `buildFallbackCritter` in this file covers all 14 from
 * the same `look` data the 2D card art uses, so the duel always has a cast.
 *
 * DOM geometry drives the diorama, never the other way round: the slot divs,
 * the two capy chips and the table area are measured and unprojected onto the
 * arena plane, so every 3D critter stands exactly under its own hit zone at any
 * window size. That keeps clicking, highlights and `_slotPoint` untouched.
 *
 * The rules live in a DOM-free core near the top of this file so the AI can be
 * played against itself headlessly for balance work:
 *
 *   node --input-type=module -e "const m = await import('file:///D:/projects/ClubNotPenguin/src/minigames/games/cards.js'); console.log(m.simulateDuels(200));"
 *
 * Two ways to play:
 *  - Solo: the full tutorial + Grandmaster Pebble, exactly as before.
 *  - Den PvP: the lounge sets `game.__matchCtx = {game, players, youAre, seed}`
 *    before startMinigame('cards'). Both clients build the SAME duel from the
 *    shared seed (seat 0's deck from `seed`, seat 1's from `seed + 1`) and then
 *    only exchange intents over 'match-move':
 *      {a:'play',   hand:<index in the actor's hand>, slot:<0-3>|null,
 *                   target:{side:<seat>, slot:<0-3>}|null}   // target: spells
 *      {a:'attack', from:<my slot>, target:'face'|<enemy slot>}
 *      {a:'end'} | {a:'resign'} | {a:'desync'}
 *    Every remote intent goes through the same rules core as a local one and is
 *    rejected the same way; a rejection freezes the duel (see _desync) instead
 *    of letting the two boards quietly tell different stories.
 *    The seat mirror is deliberate: the opponent's HAND is never rendered or
 *    inspected from it, only its count. Their cards become visible when played.
 *
 * Deviations from the spec (all noted where they happen):
 *  - The card table in docs/CARDGAME.md sums to 24 cards, not the 20 quoted in
 *    the prose. The per-card x1/x2 counts are the authoritative content, so the
 *    starter deck is those 24 cards.
 *  - The spec never says what an empty deck does. A duel that cannot end is
 *    unplayable, so drawing from an empty deck costs 1, 2, 3... HP ("Sleepy
 *    Time"). It only ever triggers in freak stall-outs.
 *  - The triangle bonus is an *attacker* bonus: the critter that swings gets
 *    +2 into a disadvantaged element, the one being hit back does not. That is
 *    what makes "which critter trades into which" a decision.
 *  - Splashproof blocks *targeted* spells; Flurry, which targets nothing, still
 *    hits it (standard for this kind of keyword).
 *  - Healing never exceeds the 25 HP a capy starts with.
 *  - Damage spells cannot hit face at all (the cards say "to any critter"), so
 *    the AI's "spell for lethal" branch can never fire.
 *  - A den win by walkout pays 25 + damage dealt (never more than the normal
 *    win). The spec's HP formula would hand a full purse to someone whose
 *    opponent left on turn one, which is a coin farm, not a duel.
 */

// ---------------------------------------------------------------------------
// tiny helpers (color + canvas)
// ---------------------------------------------------------------------------
const OUTLINE = '#3a2a1c';

function hexOf(n) { return `#${(n >>> 0).toString(16).padStart(6, '0')}`; }
function rgbOf(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexFrom(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mixHex(a, b, t) {
  const A = rgbOf(a), B = rgbOf(b);
  return hexFrom(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
/** amt > 0 lightens toward cream, amt < 0 darkens toward the outline ink. */
function shade(h, amt) {
  return amt >= 0 ? mixHex(h, '#fff3dc', amt) : mixHex(h, OUTLINE, -amt);
}
/** Player names come off the wire; they never go into innerHTML raw. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
/** A wire colour (0xrrggbb or '#rrggbb') as a css hex, with a cosy fallback. */
function bodyHex(c) {
  if (typeof c === 'number' && Number.isFinite(c)) return hexOf(c & 0xffffff);
  if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  return '#b08a5a';
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function grad(ctx, x0, y0, x1, y1, a, b) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, a); g.addColorStop(1, b);
  return g;
}
function ink(ctx, w = 4.5, color = OUTLINE) {
  ctx.lineWidth = w; ctx.strokeStyle = color; ctx.stroke();
}

// ===========================================================================
// RULES CORE - no DOM, no timers, no randomness beyond the injected rng.
// Everything below this banner is safe to run in node.
// ===========================================================================

export const ELEMENTS = {
  sun: { name: 'Sun', c1: '#ffd070', c2: '#ef942a', deep: '#c96f16', pale: '#fff1d6' },
  sea: { name: 'Sea', c1: '#7fd0f0', c2: '#2f95d6', deep: '#166ba3', pale: '#ddf3ff' },
  snow: { name: 'Snow', c1: '#f2fbff', c2: '#a6c9e6', deep: '#5d7f9e', pale: '#f4fbff' },
  neutral: { name: 'Cozy', c1: '#e6cfa4', c2: '#b28a58', deep: '#7c5a32', pale: '#fdf1dc' },
};

/** Sun > Snow > Sea > Sun. Neutral neither gives nor suffers a bonus. */
const BEATS = { sun: 'snow', snow: 'sea', sea: 'sun' };
export function beats(a, b) { return !!a && !!b && BEATS[a] === b; }

export const MAX_HP = 25;
export const MAX_ENERGY = 8;
export const HAND_CAP = 8;
export const BOARD_SLOTS = 4;
export const START_HAND = 4;
export const AI_NAME = 'Grandmaster Pebble';

/**
 * The v1 pool, exactly as docs/CARDGAME.md section 6 lists it. `look` only
 * drives the drawn portrait, never the rules.
 */
export const CARDS = {
  pebble_pal: {
    name: 'Pebble Pal', type: 'critter', cost: 0, el: 'neutral', atk: 0, hp: 2,
    kw: ['guard'], copies: 1, look: { fur: '#a9a79c', prop: 'pebble' },
    flavor: 'It is a rock. It is doing its best.',
  },
  sunny_pup: {
    name: 'Sunny Pup', type: 'critter', cost: 1, el: 'sun', atk: 2, hp: 1,
    kw: [], copies: 2, look: { fur: '#e9a94f', prop: 'shades' },
    flavor: 'Warm from the top of its head to its toes.',
  },
  puddle_sitter: {
    name: 'Puddle Sitter', type: 'critter', cost: 1, el: 'sea', atk: 1, hp: 3,
    kw: ['guard'], copies: 2, look: { fur: '#79b0cc', prop: 'ring' },
    flavor: 'Has not moved since Tuesday. Will not move for you.',
  },
  snow_nibbler: {
    name: 'Snow Nibbler', type: 'critter', cost: 1, el: 'snow', atk: 2, hp: 1,
    kw: ['swift'], copies: 1, look: { fur: '#d7e3ef', prop: 'scarf' },
    flavor: 'Eats the snow. Complains it is cold.',
  },
  beach_bum: {
    name: 'Beach Bum', type: 'critter', cost: 2, el: 'sun', atk: 2, hp: 3,
    kw: [], soak: 2, copies: 2, look: { fur: '#dc9d55', prop: 'shades', towel: true },
    flavor: 'Brought snacks. Shared exactly none of them.',
  },
  surf_scout: {
    name: 'Surf Scout', type: 'critter', cost: 2, el: 'sea', atk: 3, hp: 2,
    kw: [], copies: 2, look: { fur: '#63a3c6', prop: 'board' },
    flavor: 'Paddles out before the sun is properly up.',
  },
  frost_friend: {
    name: 'Frost Friend', type: 'critter', cost: 2, el: 'snow', atk: 1, hp: 4,
    kw: ['guard'], copies: 1, look: { fur: '#c2d6e6', prop: 'earmuffs' },
    flavor: 'Gives the warmest hugs on the whole mountain.',
  },
  ray_ray: {
    name: 'Ray Ray', type: 'critter', cost: 3, el: 'sun', atk: 4, hp: 2,
    kw: [], copies: 1, look: { fur: '#f0b45c', prop: 'shades', spiky: true },
    flavor: 'Two settings: nap, and absolutely blinding.',
  },
  wave_rider: {
    name: 'Wave Rider', type: 'critter', cost: 3, el: 'sea', atk: 3, hp: 3,
    kw: ['swift'], copies: 1, look: { fur: '#5195bd', prop: 'board' },
    flavor: 'Already halfway down the wave. Catch up.',
  },
  cocoa_courier: {
    name: 'Cocoa Courier', type: 'critter', cost: 3, el: 'snow', atk: 2, hp: 4,
    kw: [], lastSplash: 'draw1', copies: 1, look: { fur: '#c8b8a2', prop: 'mug' },
    flavor: 'Never spills. Not once. Ask anybody.',
  },
  tide_elder: {
    name: 'Tide Elder', type: 'critter', cost: 4, el: 'sea', atk: 3, hp: 6,
    kw: ['guard'], copies: 1, look: { fur: '#4a86ac', prop: 'kelp', big: true },
    flavor: 'Remembers when the cove was just a puddle.',
  },
  blizzard_buddy: {
    name: 'Blizzard Buddy', type: 'critter', cost: 4, el: 'snow', atk: 5, hp: 4,
    kw: [], copies: 1, look: { fur: '#e6eff8', prop: 'scarf', big: true },
    flavor: 'Arrives sideways, at speed, with snacks.',
  },
  solar_elder: {
    name: 'Solar Elder', type: 'critter', cost: 5, el: 'sun', atk: 5, hp: 6,
    kw: ['guard'], copies: 1, look: { fur: '#e79b3a', prop: 'crown', big: true },
    flavor: 'Naps facing the sunrise. Wakes up glowing.',
  },
  great_ancient: {
    name: 'Great Ancient Capy', type: 'critter', cost: 7, el: 'neutral', atk: 8, hp: 8,
    kw: ['splashproof'], copies: 1, look: { fur: '#8f8369', prop: 'moss', big: true },
    flavor: 'Older than the cove. Softer than it looks.',
  },
  splash: {
    name: 'Splash!', type: 'spell', cost: 1, el: 'sea', dmg: 2, target: 'critter', copies: 1,
    text: 'Deal 2 damage to a critter.', flavor: 'Right in the ear. Every time.',
  },
  zoomies: {
    name: 'Zoomies', type: 'spell', cost: 1, el: 'neutral', target: 'friendly', copies: 1,
    text: 'A friendly critter gets +2 attack this turn.', flavor: 'Nobody knows why. It just happens.',
  },
  sunburst: {
    name: 'Sunburst', type: 'spell', cost: 2, el: 'sun', dmg: 3, target: 'critter', copies: 1,
    text: 'Deal 3 damage to a critter.', flavor: 'Forgot the sunscreen, did we?',
  },
  cozy_cocoa: {
    name: 'Cozy Cocoa', type: 'spell', cost: 2, el: 'snow', heal: 5, target: null, copies: 1,
    text: 'Heal your capy 5 HP.', flavor: 'Marshmallows are not optional.',
  },
  snack_cart: {
    name: 'Snack Cart', type: 'spell', cost: 3, el: 'neutral', draw: 2, target: null, copies: 1,
    text: 'Draw 2 cards.', flavor: 'Wheels squeak. Nobody minds.',
  },
  flurry: {
    name: 'Flurry', type: 'spell', cost: 4, el: 'snow', dmg: 1, aoe: true, target: null, copies: 1,
    text: 'Deal 1 damage to every enemy critter.', flavor: 'A polite little blizzard.',
  },
};
for (const [id, d] of Object.entries(CARDS)) {
  d.id = id;
  if (d.type === 'critter') d.text = critterText(d);
}

function has(d, kw) { return !!d.kw && d.kw.indexOf(kw) >= 0; }

function critterText(d) {
  const parts = [];
  if (has(d, 'guard')) parts.push('Guard');
  if (has(d, 'swift')) parts.push('Swift');
  if (d.soak) parts.push(`Soak ${d.soak}`);
  if (has(d, 'splashproof')) parts.push('Splashproof');
  if (d.lastSplash === 'draw1') parts.push('Last Splash: draw 1');
  return parts.join('  \u00b7  ');
}

export const KEYWORD_HELP = {
  Guard: 'Enemies must attack your Guards before your capy.',
  Swift: 'Can attack the turn it arrives.',
  Soak: 'When played, your capy heals that much.',
  Splashproof: 'Cannot be targeted by spells, yours or theirs.',
  'Last Splash': 'Triggers when this critter washes away.',
};

/** The 24 cards each side shuffles (see the deviation note at the top). */
export function starterDeck() {
  const ids = [];
  for (const d of Object.values(CARDS)) for (let i = 0; i < d.copies; i++) ids.push(d.id);
  return ids;
}

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function mkSide(deck) {
  return {
    hp: MAX_HP, maxHp: MAX_HP, energy: 0, maxEnergy: 0,
    deck, hand: [], board: [null, null, null, null],
    fatigue: 0, dealt: 0, burned: 0, played: 0,
  };
}

/**
 * Seat 0 always moves first; seat 1 draws the compensation card. Solo puts the
 * human in seat 0 and Pebble in seat 1; a den match seats whoever the server
 * says (`youAre`), so nothing below may assume "0 is me".
 *
 * `opts.decks` supplies both draw piles already shuffled (PvP: identical on
 * both clients); otherwise they are shuffled from `rng` in seat order.
 */
export function newDuel(rng = Math.random, opts = {}) {
  const decks = Array.isArray(opts.decks) && opts.decks.length === 2
    ? opts.decks
    : [shuffle(starterDeck(), rng), shuffle(starterDeck(), rng)];
  const S = {
    rng, uid: 1, turn: 0, active: 0, winner: null, fx: [],
    sides: [mkSide(decks[0]), mkSide(decks[1])],
  };
  for (let i = 0; i < START_HAND; i++) { drawCards(S, 0, 1); drawCards(S, 1, 1); }
  drawCards(S, 1, 1); // second-player compensation
  S.fx.length = 0;
  beginTurn(S, 0);
  return S;
}

/** The two draw piles a den match uses: seat 0 from `seed`, seat 1 from seed+1. */
export function pvpDecks(seed) {
  const s = seed >>> 0;
  return [
    shuffle(starterDeck(), makeRng(s)),
    shuffle(starterDeck(), makeRng((s + 1) >>> 0)),
  ];
}

/** Same seed in, same duel out, on both sides of the table. */
export function newPvpDuel(seed) {
  const s = seed >>> 0;
  return newDuel(makeRng((s ^ 0x9e3779b9) >>> 0), { decks: pvpDecks(s) });
}

export function unitsOf(side) {
  const out = [];
  for (let i = 0; i < BOARD_SLOTS; i++) if (side.board[i]) out.push({ c: side.board[i], i });
  return out;
}
function dmgOf(c) { return c.atk + (c.tempAtk || 0); }

function drawCards(S, side, n = 1) {
  const s = S.sides[side];
  for (let i = 0; i < n; i++) {
    if (!s.deck.length) {
      // Sleepy Time: an empty deck is exhaustion, not a stalemate.
      s.fatigue += 1;
      hurtFace(S, side, s.fatigue, -1, 'fatigue');
      continue;
    }
    const id = s.deck.pop();
    if (s.hand.length >= HAND_CAP) {
      s.burned += 1;
      S.fx.push({ k: 'burn', side, id });
      continue;
    }
    s.hand.push({ uid: S.uid++, id });
    S.fx.push({ k: 'draw', side, id });
  }
}

function beginTurn(S, side) {
  if (S.winner !== null) return;
  S.active = side;
  S.turn += 1;
  if (S.turn > 200) { S.winner = 'draw'; return; } // defensive: duels always end
  const s = S.sides[side];
  drawCards(S, side, 1);
  if (S.winner !== null) return;
  s.maxEnergy = Math.min(MAX_ENERGY, s.maxEnergy + 1);
  s.energy = s.maxEnergy;
  for (const c of s.board) if (c) { c.ready = true; c.tempAtk = 0; }
  S.fx.push({ k: 'turn', side });
}

export function endTurn(S) {
  if (S.winner !== null) return;
  const s = S.sides[S.active];
  for (const c of s.board) if (c) c.tempAtk = 0;
  beginTurn(S, 1 - S.active);
}

function checkWin(S) {
  const a = S.sides[0].hp <= 0, b = S.sides[1].hp <= 0;
  if (!a && !b) return;
  if (a && b) S.winner = S.sides[0].hp === S.sides[1].hp ? 'draw' : (S.sides[0].hp > S.sides[1].hp ? 0 : 1);
  else S.winner = a ? 1 : 0;
}

function hurtFace(S, side, amount, by, src) {
  if (amount <= 0) return;
  const s = S.sides[side];
  s.hp -= amount;
  if (by >= 0) S.sides[by].dealt += amount;
  S.fx.push({ k: 'face', side, amount, src: src || 'attack' });
  checkWin(S);
}

function healFace(S, side, amount) {
  const s = S.sides[side];
  const real = Math.min(amount, s.maxHp - s.hp);
  if (real <= 0) { S.fx.push({ k: 'heal', side, amount: 0 }); return; }
  s.hp += real;
  S.fx.push({ k: 'heal', side, amount: real });
}

function hurtCritter(S, side, slot, amount, by, tri) {
  const c = S.sides[side].board[slot];
  if (!c || amount <= 0) return;
  c.hp -= amount;
  if (by >= 0) S.sides[by].dealt += amount;
  S.fx.push({ k: 'dmg', side, slot, uid: c.uid, amount, tri: !!tri });
}

/** Clear the knocked-out critters (both sides at once: combat is simultaneous). */
function reap(S) {
  for (let side = 0; side < 2; side++) {
    const s = S.sides[side];
    for (let i = 0; i < BOARD_SLOTS; i++) {
      const c = s.board[i];
      if (!c || c.hp > 0) continue;
      s.board[i] = null;
      S.fx.push({ k: 'die', side, slot: i, uid: c.uid, id: c.id });
      if (c.lastSplash === 'draw1') {
        S.fx.push({ k: 'lastsplash', side, slot: i, id: c.id });
        drawCards(S, side, 1);
      }
    }
  }
  checkWin(S);
}

function mkCritter(S, card) {
  const d = CARDS[card.id];
  return {
    uid: card.uid, id: card.id, el: d.el, cost: d.cost,
    atk: d.atk, hp: d.hp, maxHp: d.hp, tempAtk: 0,
    ready: has(d, 'swift'), guard: has(d, 'guard'), splashproof: has(d, 'splashproof'),
    lastSplash: d.lastSplash || null,
  };
}

export function spellTargetOk(S, side, d, t) {
  if (!d.target) return !t;
  if (!t || t.side === undefined || !(t.slot >= 0 && t.slot < BOARD_SLOTS)) return false;
  const c = S.sides[t.side].board[t.slot];
  if (!c || c.splashproof) return false;
  if (d.target === 'friendly' && t.side !== side) return false;
  return true;
}

/** Every legal target for a spell in hand, as {side, slot} pairs. */
export function spellTargets(S, side, d) {
  const out = [];
  if (!d.target) return out;
  for (const sd of d.target === 'friendly' ? [side] : [0, 1]) {
    for (const u of unitsOf(S.sides[sd])) if (!u.c.splashproof) out.push({ side: sd, slot: u.i });
  }
  return out;
}

export function canAfford(S, side, uid) {
  const s = S.sides[side];
  const card = s.hand.find((c) => c.uid === uid);
  return !!card && CARDS[card.id].cost <= s.energy;
}

export function playCard(S, side, uid, opts = {}) {
  if (S.winner !== null || S.active !== side) return false;
  const s = S.sides[side];
  const i = s.hand.findIndex((c) => c.uid === uid);
  if (i < 0) return false;
  const card = s.hand[i];
  const d = CARDS[card.id];
  if (d.cost > s.energy) return false;

  if (d.type === 'critter') {
    const slot = opts.slot;
    if (!(slot >= 0 && slot < BOARD_SLOTS) || s.board[slot]) return false;
    s.hand.splice(i, 1);
    s.energy -= d.cost;
    s.played += 1;
    const c = mkCritter(S, card);
    s.board[slot] = c;
    S.fx.push({ k: 'summon', side, slot, uid: c.uid, id: card.id });
    if (d.soak) healFace(S, side, d.soak);
    return true;
  }

  const t = opts.target || null;
  if (!spellTargetOk(S, side, d, t)) return false;
  s.hand.splice(i, 1);
  s.energy -= d.cost;
  s.played += 1;
  S.fx.push({ k: 'cast', side, uid: card.uid, id: card.id, target: t });
  castSpell(S, side, d, t);
  reap(S);
  return true;
}

function castSpell(S, side, d, t) {
  if (d.id === 'zoomies') {
    const c = S.sides[t.side].board[t.slot];
    if (c) { c.tempAtk += 2; S.fx.push({ k: 'buff', side: t.side, slot: t.slot, amount: 2 }); }
    return;
  }
  if (d.heal) { healFace(S, side, d.heal); return; }
  if (d.draw) { drawCards(S, side, d.draw); return; }
  if (d.aoe) {
    // untargeted, so Splashproof does not stop it
    const foe = 1 - side;
    for (const u of unitsOf(S.sides[foe])) {
      const tri = beats(d.el, u.c.el);
      if (tri) S.fx.push({ k: 'tri', from: d.el, to: u.c.el, side: foe, slot: u.i });
      hurtCritter(S, foe, u.i, d.dmg + (tri ? 2 : 0), side, tri);
    }
    return;
  }
  if (d.dmg) {
    const c = S.sides[t.side].board[t.slot];
    if (!c) return;
    const tri = beats(d.el, c.el);
    if (tri) S.fx.push({ k: 'tri', from: d.el, to: c.el, side: t.side, slot: t.slot });
    hurtCritter(S, t.side, t.slot, d.dmg + (tri ? 2 : 0), side, tri);
  }
}

export function guardsUp(S, side) {
  return unitsOf(S.sides[side]).some((u) => u.c.guard);
}

export function canAttack(S, side, slot, target) {
  if (S.winner !== null || S.active !== side) return false;
  const a = S.sides[side].board[slot];
  if (!a || !a.ready || dmgOf(a) <= 0) return false;
  const foe = 1 - side;
  if (target === 'face') return !guardsUp(S, foe);
  if (!target || !(target.slot >= 0 && target.slot < BOARD_SLOTS)) return false;
  return !!S.sides[foe].board[target.slot];
}

export function attack(S, side, slot, target) {
  if (!canAttack(S, side, slot, target)) return false;
  const foe = 1 - side;
  const a = S.sides[side].board[slot];
  a.ready = false;
  const power = dmgOf(a);

  if (target === 'face') {
    S.fx.push({ k: 'swing', side, slot, target: 'face' });
    hurtFace(S, foe, power, side);
    return true;
  }

  const d = S.sides[foe].board[target.slot];
  const tri = beats(a.el, d.el);
  S.fx.push({ k: 'swing', side, slot, target: { side: foe, slot: target.slot } });
  if (tri) S.fx.push({ k: 'tri', from: a.el, to: d.el, side: foe, slot: target.slot });
  // simultaneous: both hits land before anybody washes away
  hurtCritter(S, foe, target.slot, power + (tri ? 2 : 0), side, tri);
  hurtCritter(S, side, slot, dmgOf(d), foe, false);
  reap(S);
  return true;
}

// ---------------------------------------------------------------------------
// AI : the strict priority order from docs/CARDGAME.md section 7. One action
// per call so the UI can pace it; the caller loops until it gets {t:'end'}.
// ---------------------------------------------------------------------------
export function aiAction(S, side = 1) {
  if (S.winner !== null || S.active !== side) return { t: 'end' };
  return planLethal(S, side)
    || planRemoval(S, side)
    || planCurve(S, side)
    || planAttack(S, side)
    || { t: 'end' };
}

function affordable(S, side, id) {
  const s = S.sides[side];
  const card = s.hand.find((c) => c.id === id);
  return card && CARDS[id].cost <= s.energy ? card : null;
}

// 1. lethal: can this turn's swings finish them?
function planLethal(S, side) {
  const me = S.sides[side], foe = S.sides[1 - side];
  const atkers = unitsOf(me).filter((u) => u.c.ready && dmgOf(u.c) > 0);
  if (!atkers.length) return null;
  const guards = unitsOf(foe).filter((u) => u.c.guard);
  const zoom = affordable(S, side, 'zoomies');

  if (!guards.length) {
    const total = atkers.reduce((n, u) => n + dmgOf(u.c), 0);
    if (total >= foe.hp) return { t: 'attack', slot: atkers[0].i, target: 'face' };
    if (zoom && total + 2 >= foe.hp) {
      return { t: 'play', uid: zoom.uid, target: { side, slot: atkers[0].i } };
    }
    return null;
  }

  // guards in the way: spend the least damage that still clears each one
  const pool = atkers.slice();
  const order = guards.slice().sort((a, b) => a.c.hp - b.c.hp);
  let first = null;
  for (const g of order) {
    let pick = -1, waste = Infinity;
    for (let k = 0; k < pool.length; k++) {
      const d = dmgOf(pool[k].c) + (beats(pool[k].c.el, g.c.el) ? 2 : 0);
      if (d >= g.c.hp && d - g.c.hp < waste) { waste = d - g.c.hp; pick = k; }
    }
    if (pick < 0) return null;
    if (!first) first = { t: 'attack', slot: pool[pick].i, target: { slot: g.i } };
    pool.splice(pick, 1);
  }
  const rest = pool.reduce((n, u) => n + dmgOf(u.c), 0);
  return rest >= foe.hp ? first : null;
}

// 2. removal: damage spells only when they actually knock something out
function planRemoval(S, side) {
  const me = S.sides[side], foe = S.sides[1 - side];
  let best = null;
  for (const card of me.hand) {
    const d = CARDS[card.id];
    if (d.type !== 'spell' || !d.dmg || d.cost > me.energy) continue;
    if (d.aoe) {
      let kills = 0, hits = 0;
      for (const u of unitsOf(foe)) {
        hits += 1;
        if (d.dmg + (beats(d.el, u.c.el) ? 2 : 0) >= u.c.hp) kills += 1;
      }
      if (kills >= 1) {
        const v = kills * 4 + hits - d.cost * 0.4;
        if (!best || v > best.v) best = { v, a: { t: 'play', uid: card.uid } };
      }
      continue;
    }
    for (const u of unitsOf(foe)) {
      if (u.c.splashproof) continue;
      const tri = beats(d.el, u.c.el);
      if (d.dmg + (tri ? 2 : 0) < u.c.hp) continue;
      const v = 4 + u.c.cost + u.c.atk * 0.4 + (tri ? 1.5 : 0) - d.cost * 0.4;
      if (!best || v > best.v) {
        best = { v, a: { t: 'play', uid: card.uid, target: { side: 1 - side, slot: u.i } } };
      }
    }
  }
  return best ? best.a : null;
}

// 4. curve: heal when low, otherwise the fattest critter that fits
function planCurve(S, side) {
  const me = S.sides[side];
  if (me.hp < 12 && me.hp <= me.maxHp - 3) {
    const cocoa = affordable(S, side, 'cozy_cocoa');
    if (cocoa) return { t: 'play', uid: cocoa.uid };
  }
  const slot = me.board.indexOf(null);
  if (slot >= 0) {
    let best = null;
    for (const card of me.hand) {
      const d = CARDS[card.id];
      if (d.type !== 'critter' || d.cost > me.energy) continue;
      let v = d.cost * 10 + d.atk * 1.2 + d.hp;
      if (me.hp < 12 && d.soak) v += 14;
      if (me.hp < 15 && has(d, 'guard')) v += 5;
      if (has(d, 'swift')) v += 2;
      if (!best || v > best.v) best = { v, card };
    }
    if (best) return { t: 'play', uid: best.card.uid, slot };
  }
  const cart = affordable(S, side, 'snack_cart');
  if (cart && me.hand.length <= HAND_CAP - 1) return { t: 'play', uid: cart.uid };
  return null;
}

// 3. trades: swing where the exchange pays, otherwise face when it is open
function planAttack(S, side) {
  const me = S.sides[side], foe = S.sides[1 - side];
  const guards = unitsOf(foe).filter((u) => u.c.guard);
  const mine = unitsOf(me).filter((u) => u.c.ready && dmgOf(u.c) > 0);
  if (!mine.length) return null;
  const targets = unitsOf(foe);
  let best = null;

  for (const a of mine) {
    const power = dmgOf(a.c);
    if (!guards.length) {
      const v = power * 0.85 + (foe.hp <= power ? 20 : foe.hp <= power * 2 ? 4 : 0);
      if (!best || v > best.v) best = { v, act: { t: 'attack', slot: a.i, target: 'face' } };
    }
    for (const t of targets) {
      const tri = beats(a.c.el, t.c.el) ? 2 : 0;
      const dm = power + tri;
      const kills = dm >= t.c.hp;
      const dies = dmgOf(t.c) >= a.c.hp;
      let v;
      if (kills && !dies) v = 6 + t.c.cost + t.c.atk * 0.5;
      else if (kills && dies) v = 2 + (t.c.cost - a.c.cost) * 1.2 + (t.c.atk - a.c.atk) * 0.5;
      else if (!kills && !dies) v = 0.4 + (t.c.guard ? 1.2 : 0) + dm * 0.15;
      else v = -8;
      if (!best || v > best.v) best = { v, act: { t: 'attack', slot: a.i, target: { slot: t.i } } };
    }
  }

  // Zoomies is held back until +2 turns a shove into a knockout
  const zoom = affordable(S, side, 'zoomies');
  if (zoom) {
    for (const a of mine) {
      for (const t of targets) {
        const tri = beats(a.c.el, t.c.el) ? 2 : 0;
        const now = dmgOf(a.c) + tri;
        if (now >= t.c.hp || now + 2 < t.c.hp) continue;
        const dies = dmgOf(t.c) >= a.c.hp;
        const v = (dies ? 3 : 8) + t.c.cost;
        if (!best || v > best.v + 0.5) return { t: 'play', uid: zoom.uid, target: { side, slot: a.i } };
      }
    }
  }
  return best && best.v > 0 ? best.act : null;
}

/** Apply one AI action; returns false if it turned out to be illegal. */
export function applyAction(S, side, a) {
  if (!a || a.t === 'end') { endTurn(S); return true; }
  if (a.t === 'play') return playCard(S, side, a.uid, { slot: a.slot, target: a.target });
  if (a.t === 'attack') return attack(S, side, a.slot, a.target);
  return false;
}

/**
 * Headless balance harness: the heuristic plays both seats. Reports the
 * first-player win rate (the seat the human always takes) and duel length.
 */
export function simulateDuels(n = 200, seed = 20260806) {
  let first = 0, second = 0, draws = 0, turns = 0, hp = 0, stalls = 0, fatigue = 0;
  for (let i = 0; i < n; i++) {
    const S = newDuel(makeRng(seed + i * 7919));
    let steps = 0;
    while (S.winner === null && steps++ < 4000) {
      const a = aiAction(S, S.active);
      if (!applyAction(S, S.active, a)) endTurn(S);
      S.fx.length = 0;
    }
    if (steps >= 4000) stalls += 1;
    if (S.winner === 0) first += 1;
    else if (S.winner === 1) second += 1;
    else draws += 1;
    turns += S.turn;
    hp += Math.max(0, S.sides[S.winner === 1 ? 1 : 0].hp);
    if (S.sides[0].fatigue || S.sides[1].fatigue) fatigue += 1;
  }
  return {
    games: n,
    firstPlayerWins: first,
    secondPlayerWins: second,
    draws,
    firstPlayerWinRate: +(first / n).toFixed(4),
    avgTurns: +(turns / n).toFixed(2),
    avgWinnerHp: +(hp / n).toFixed(2),
    duelsReachingFatigue: fatigue,
    stalls,
  };
}

// ===========================================================================
// ART - everything drawn on canvas, nothing loaded.
// ===========================================================================
const DPR = () => Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

function fitCanvas(cv, w, h) {
  const dpr = DPR();
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return ctx;
}

/** Element badge, designed on a 40x40 grid. */
function drawElemIcon(ctx, el, size) {
  const s = size / 40;
  const E = ELEMENTS[el] || ELEMENTS.neutral;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (el === 'sun') {
    ctx.strokeStyle = E.deep; ctx.lineWidth = 3.4;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(20 + Math.cos(a) * 11, 20 + Math.sin(a) * 11);
      ctx.lineTo(20 + Math.cos(a) * 17, 20 + Math.sin(a) * 17);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(20, 20, 9.5, 0, Math.PI * 2);
    ctx.fillStyle = E.c1; ctx.fill(); ink(ctx, 3, E.deep);
  } else if (el === 'sea') {
    ctx.beginPath(); ctx.arc(20, 20, 15, 0, Math.PI * 2);
    ctx.fillStyle = E.c1; ctx.fill(); ink(ctx, 3, E.deep);
    ctx.strokeStyle = E.deep; ctx.lineWidth = 3.2;
    for (let i = 0; i < 2; i++) {
      const y = 17 + i * 8;
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.quadraticCurveTo(14, y - 4.5, 20, y);
      ctx.quadraticCurveTo(26, y + 4.5, 32, y);
      ctx.stroke();
    }
  } else if (el === 'snow') {
    ctx.beginPath(); ctx.arc(20, 20, 15, 0, Math.PI * 2);
    ctx.fillStyle = E.c1; ctx.fill(); ink(ctx, 3, E.deep);
    ctx.strokeStyle = E.deep; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      ctx.beginPath();
      ctx.moveTo(20 - Math.cos(a) * 11, 20 - Math.sin(a) * 11);
      ctx.lineTo(20 + Math.cos(a) * 11, 20 + Math.sin(a) * 11);
      ctx.stroke();
      for (const d of [-1, 1]) {
        const px = 20 + Math.cos(a) * 7 * d, py = 20 + Math.sin(a) * 7 * d;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(a + 1.1) * 5 * d, py + Math.sin(a + 1.1) * 5 * d);
        ctx.stroke();
      }
    }
  } else {
    ctx.beginPath(); ctx.arc(20, 20, 15, 0, Math.PI * 2);
    ctx.fillStyle = E.c1; ctx.fill(); ink(ctx, 3, E.deep);
    ctx.fillStyle = E.deep;
    ctx.beginPath(); ctx.ellipse(20, 24, 7.5, 6, 0, 0, Math.PI * 2); ctx.fill();
    for (const [px, py, r] of [[12.5, 15, 3.2], [20, 12, 3.4], [27.5, 15, 3.2]]) {
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function elemIconCanvas(el, size) {
  const cv = document.createElement('canvas');
  const ctx = fitCanvas(cv, size, size);
  drawElemIcon(ctx, el, size);
  return cv;
}

/**
 * A card critter, drawn on a 100x100 box centred on (0,0). Same language as
 * the avatar: egg body, boxy muzzle, bead eyes, chunky props.
 */
function drawCritterArt(ctx, def) {
  const look = def.look || {};
  const fur = look.fur || '#b08a5a';
  const dark = shade(fur, -0.26);
  const muzzle = shade(fur, 0.24);
  const E = ELEMENTS[def.el] || ELEMENTS.neutral;
  const scale = look.big ? 1.1 : 1;
  ctx.save();
  ctx.scale(scale, scale);

  if (look.prop === 'board') { // surfboard tucked behind
    ctx.save(); ctx.translate(2, 4); ctx.rotate(-0.62);
    ctx.beginPath(); ctx.ellipse(0, 0, 15, 46, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#fff2d6'; ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.moveTo(0, -40); ctx.lineTo(0, 40);
    ink(ctx, 4, '#e8657a');
    ctx.restore();
  }
  if (look.prop === 'kelp') {
    ctx.strokeStyle = '#4e8f4a'; ctx.lineWidth = 6;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(d * 30, 40);
      ctx.quadraticCurveTo(d * 44, 6, d * 30, -26);
      ctx.stroke();
    }
  }
  if (look.towel) {
    ctx.save(); ctx.translate(0, 34); ctx.rotate(0.04);
    rrect(ctx, -46, -8, 92, 20, 8);
    ctx.fillStyle = '#e8657a'; ctx.fill(); ink(ctx, 4);
    ctx.fillStyle = '#fff6e3';
    for (let i = -1; i <= 1; i++) { rrect(ctx, i * 26 - 5, -8, 10, 20, 4); ctx.fill(); }
    ctx.restore();
  }

  // body
  ctx.beginPath(); ctx.ellipse(0, 26, 36, 25, 0, 0, Math.PI * 2);
  ctx.fillStyle = grad(ctx, -36, 2, 30, 50, fur, dark); ctx.fill(); ink(ctx, 4.6);
  // paws
  for (const px of [-19, 19]) {
    rrect(ctx, px - 10, 38, 20, 13, 6);
    ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 3.8);
  }
  // ears
  for (const ex of [-25, 25]) {
    ctx.beginPath(); ctx.ellipse(ex, -34, 11, 9.5, ex < 0 ? 0.35 : -0.35, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 4);
  }
  // head
  rrect(ctx, -32, -40, 64, 52, 21);
  ctx.fillStyle = grad(ctx, -32, -40, 32, 12, shade(fur, 0.12), fur); ctx.fill(); ink(ctx, 4.8);
  // muzzle
  rrect(ctx, -21, -14, 42, 28, 13);
  ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4);
  ctx.fillStyle = OUTLINE;
  for (const nx of [-7, 7]) {
    ctx.save(); ctx.translate(nx, -4); ctx.rotate(nx < 0 ? 0.5 : -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 1.9, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.beginPath(); ctx.moveTo(-7, 4); ctx.quadraticCurveTo(0, 10, 7, 4);
  ink(ctx, 3.4);

  if (look.prop === 'shades') {
    rrect(ctx, -26, -32, 52, 15, 7);
    ctx.fillStyle = '#2f2a3a'; ctx.fill(); ink(ctx, 3.6);
    ctx.beginPath(); ctx.moveTo(-20, -29); ctx.lineTo(-12, -22);
    ink(ctx, 3, 'rgba(255,255,255,.55)');
  } else {
    for (const ex of [-13, 13]) {
      ctx.beginPath(); ctx.ellipse(ex, -25, 5, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.beginPath(); ctx.arc(ex - 1.8, -27, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
  }

  if (look.prop === 'scarf') {
    rrect(ctx, -30, 8, 60, 14, 7);
    ctx.fillStyle = '#e8657a'; ctx.fill(); ink(ctx, 4);
    ctx.save(); ctx.translate(24, 14); ctx.rotate(0.5);
    rrect(ctx, 0, 0, 13, 26, 6);
    ctx.fillStyle = '#d4536a'; ctx.fill(); ink(ctx, 3.6);
    ctx.restore();
  } else if (look.prop === 'earmuffs') {
    ctx.beginPath(); ctx.arc(0, -36, 30, Math.PI * 1.08, Math.PI * 1.92);
    ink(ctx, 6, '#8a6642');
    for (const ex of [-28, 28]) {
      ctx.beginPath(); ctx.arc(ex, -32, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#fff6e3'; ctx.fill(); ink(ctx, 4);
    }
  } else if (look.prop === 'ring') {
    ctx.beginPath(); ctx.ellipse(0, 30, 46, 20, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#4fb3e8'; ctx.fill(); ink(ctx, 4.4);
    ctx.beginPath(); ctx.ellipse(0, 30, 26, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = E.pale; ctx.fill(); ink(ctx, 3.6);
    ctx.fillStyle = '#fff6e3';
    for (const a of [-2.3, -0.85, 0.85, 2.3]) {
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 36, 30 + Math.sin(a) * 15, 8, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (look.prop === 'mug') {
    ctx.save(); ctx.translate(27, 30);
    rrect(ctx, -11, -12, 22, 22, 5);
    ctx.fillStyle = '#fff6e3'; ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.arc(13, 0, 7, -1.2, 1.2);
    ink(ctx, 4);
    rrect(ctx, -8, -10, 16, 6, 3);
    ctx.fillStyle = '#8a5a34'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-4, -18); ctx.quadraticCurveTo(2, -24, -3, -30);
    ctx.stroke();
    ctx.restore();
  } else if (look.prop === 'crown') {
    ctx.beginPath();
    ctx.moveTo(-26, -42);
    for (let i = 0; i < 3; i++) {
      ctx.lineTo(-26 + i * 26 + 13, -60);
      ctx.lineTo(-26 + (i + 1) * 26, -42);
    }
    ctx.closePath();
    ctx.fillStyle = '#f2b64a'; ctx.fill(); ink(ctx, 4);
  } else if (look.prop === 'moss') {
    ctx.fillStyle = '#7ac74f';
    for (const [px, py, r] of [[-24, -40, 9], [-6, -46, 7], [24, 20, 8]]) {
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    rrect(ctx, -30, -46, 60, 12, 6);
    ctx.fillStyle = '#9c8f76'; ctx.fill(); ink(ctx, 4);
  } else if (look.prop === 'pebble') {
    ctx.fillStyle = 'rgba(58,42,28,.18)';
    ctx.beginPath(); ctx.ellipse(-18, 30, 8, 5, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(20, 34, 6, 4, -0.2, 0, Math.PI * 2); ctx.fill();
  }

  if (look.spiky) { // Ray Ray gets an actual sunbeam crown
    ctx.strokeStyle = '#f7c860'; ctx.lineWidth = 4.5;
    for (let i = -2; i <= 2; i++) {
      const a = -Math.PI / 2 + i * 0.42;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 36, -6 + Math.sin(a) * 36);
      ctx.lineTo(Math.cos(a) * 48, -6 + Math.sin(a) * 48);
      ctx.stroke();
    }
  }
  // element sparkle over the shoulder
  ctx.save();
  ctx.translate(34 - 13, -34 - 13);
  ctx.globalAlpha = 0.95;
  drawElemIcon(ctx, def.el, 26);
  ctx.restore();
  ctx.restore();
}

/** Spell glyphs, same 100x100 box centred on (0,0). */
function drawSpellArt(ctx, def) {
  const E = ELEMENTS[def.el] || ELEMENTS.neutral;
  ctx.save();
  if (def.id === 'splash') {
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.bezierCurveTo(24, -8, 30, 6, 30, 14);
    ctx.arc(0, 14, 30, 0, Math.PI);
    ctx.bezierCurveTo(-30, 6, -24, -8, 0, -40);
    ctx.closePath();
    ctx.fillStyle = grad(ctx, -30, -40, 30, 44, E.c1, E.c2); ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(-10, 8, 7, 11, -0.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fill();
    ctx.fillStyle = E.c2;
    for (const [px, py, r] of [[-40, 22, 7], [42, 16, 6], [-30, -18, 5]]) {
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (def.id === 'sunburst') {
    ctx.strokeStyle = E.c2; ctx.lineWidth = 6;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 26, Math.sin(a) * 26);
      ctx.lineTo(Math.cos(a) * (i % 2 ? 38 : 46), Math.sin(a) * (i % 2 ? 38 : 46));
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fillStyle = grad(ctx, -24, -24, 24, 24, '#fff0b0', E.c2); ctx.fill(); ink(ctx, 5);
    ctx.fillStyle = OUTLINE;
    for (const ex of [-9, 9]) { ctx.beginPath(); ctx.arc(ex, -4, 3.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.arc(0, 4, 8, 0.2, Math.PI - 0.2);
    ink(ctx, 3.4);
  } else if (def.id === 'cozy_cocoa') {
    rrect(ctx, -26, -14, 52, 46, 10);
    ctx.fillStyle = '#fff6e3'; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.arc(30, 8, 15, -1.25, 1.25);
    ink(ctx, 5);
    rrect(ctx, -21, -10, 42, 12, 5);
    ctx.fillStyle = '#8a5a34'; ctx.fill();
    ctx.fillStyle = '#fffdf6';
    for (const px of [-9, 4]) { rrect(ctx, px, -14, 10, 8, 3); ctx.fill(); ink(ctx, 2.6); }
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 5;
    for (const px of [-10, 8]) {
      ctx.beginPath();
      ctx.moveTo(px, -22); ctx.quadraticCurveTo(px + 10, -32, px, -44);
      ctx.stroke();
    }
  } else if (def.id === 'snack_cart') {
    rrect(ctx, -34, -6, 68, 30, 8);
    ctx.fillStyle = '#e0c69a'; ctx.fill(); ink(ctx, 5);
    for (const px of [-18, 18]) {
      ctx.beginPath(); ctx.arc(px, 30, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#6b4f35'; ctx.fill(); ink(ctx, 4.5);
    }
    ctx.beginPath();
    ctx.moveTo(-40, -10);
    for (let i = 0; i < 4; i++) ctx.quadraticCurveTo(-40 + i * 20 + 10, -22, -40 + (i + 1) * 20, -10);
    ctx.lineTo(40, -18); ctx.lineTo(-40, -18); ctx.closePath();
    ctx.fillStyle = '#e8657a'; ctx.fill(); ink(ctx, 4.5);
    ctx.fillStyle = '#f2b64a';
    for (const px of [-20, 0, 20]) { ctx.beginPath(); ctx.arc(px, 6, 7, 0, Math.PI * 2); ctx.fill(); ink(ctx, 3.4); }
  } else if (def.id === 'flurry') {
    for (const [px, py, s2] of [[-26, -22, 26], [16, -6, 34], [-10, 26, 22], [34, 28, 18]]) {
      ctx.save(); ctx.translate(px - s2 / 2, py - s2 / 2); drawElemIcon(ctx, 'snow', s2);
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 4;
    for (const px of [-38, 40]) {
      ctx.beginPath(); ctx.moveTo(px, -34); ctx.lineTo(px - 6, 4); ctx.stroke();
    }
  } else { // zoomies
    ctx.strokeStyle = E.c2; ctx.lineWidth = 6;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-46, -18 + i * 18);
      ctx.lineTo(-12 - i * 6, -18 + i * 18);
      ctx.stroke();
    }
    ctx.save(); ctx.translate(14, 4); ctx.rotate(-0.12); ctx.scale(0.62, 0.62);
    drawCritterArt(ctx, { el: 'neutral', look: { fur: '#c9a06b', prop: 'none' } });
    ctx.restore();
    ctx.fillStyle = '#f2b64a';
    for (const [px, py] of [[-4, -44], [30, -38]]) {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const r = i % 2 ? 4 : 9;
        ctx.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill(); ink(ctx, 2.6);
    }
  }
  ctx.restore();
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines = 3) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const top = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, top + i * lineH));
  return lines.length;
}

function fitText(ctx, text, maxW, startPx, weight = 900) {
  let px = startPx;
  do {
    ctx.font = `${weight} ${px}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
    px -= 1;
  } while (px > 8);
  return px;
}

/**
 * One card face on a 200x276 grid. `live` carries board stats so a damaged or
 * buffed critter reads differently from the printed card.
 */
function drawCardFace(ctx, def, live) {
  const E = ELEMENTS[def.el] || ELEMENTS.neutral;
  const atk = live ? live.atk : def.atk;
  const hp = live ? live.hp : def.hp;
  const buffed = !!(live && live.atk > def.atk);
  const hurt = !!(live && live.hp < def.hp);

  // frame
  rrect(ctx, 3, 3, 194, 270, 20);
  ctx.fillStyle = grad(ctx, 0, 0, 200, 276, E.c1, E.c2); ctx.fill(); ink(ctx, 5.5);
  rrect(ctx, 13, 13, 174, 250, 14);
  ctx.fillStyle = '#fffaee'; ctx.fill(); ink(ctx, 3.6, shade(E.deep, 0.2));

  // art window
  rrect(ctx, 32, 32, 136, 120, 12);
  ctx.fillStyle = grad(ctx, 32, 32, 168, 152, E.pale, shade(E.c1, 0.45)); ctx.fill();
  ctx.save();
  rrect(ctx, 32, 32, 136, 120, 12);
  ctx.clip();
  ctx.save();
  ctx.translate(100, 96);
  ctx.scale(1.06, 1.06);
  if (def.type === 'critter') drawCritterArt(ctx, def); else drawSpellArt(ctx, def);
  ctx.restore();
  ctx.restore();
  rrect(ctx, 32, 32, 136, 120, 12);
  ink(ctx, 3.4, shade(E.deep, 0.15));

  // name plate
  rrect(ctx, 18, 158, 164, 26, 11);
  ctx.fillStyle = E.c2; ctx.fill(); ink(ctx, 3.4, shade(E.deep, -0.1));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const npx = fitText(ctx, def.name, 148, 17);
  ctx.fillStyle = '#fffaee';
  ctx.fillText(def.name, 100, 172 + (npx > 15 ? 0.5 : 0));

  // rules text
  ctx.fillStyle = '#5b452c';
  const body = def.text && def.text.length ? def.text : def.flavor;
  const isRules = !!(def.text && def.text.length);
  ctx.font = `${isRules ? 800 : 600} ${isRules ? 13 : 12}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
  if (!isRules) ctx.fillStyle = '#9a8461';
  wrapText(ctx, body, 100, def.type === 'spell' ? 208 : 202, 150, 15, 3);

  // spells say so, plainly
  if (def.type === 'spell') {
    rrect(ctx, 62, 232, 76, 22, 11);
    ctx.fillStyle = shade(E.c2, 0.18); ctx.fill(); ink(ctx, 3, shade(E.deep, 0));
    ctx.font = '900 12px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#4a3720';
    ctx.fillText('SPELL', 100, 244);
  } else {
    const statCircle = (x, fill, value, glow) => {
      if (glow) {
        ctx.beginPath(); ctx.arc(x, 244, 27, 0, Math.PI * 2);
        ctx.fillStyle = glow; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(x, 244, 21, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ink(ctx, 4.4);
      ctx.font = '900 25px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#fffaee';
      ctx.fillText(String(value), x, 245);
    };
    statCircle(36, buffed ? '#7ac74f' : '#f2b64a', atk, buffed ? 'rgba(122,199,79,.45)' : null);
    statCircle(164, hurt ? '#e04a4a' : '#e8657a', hp, hurt ? 'rgba(224,74,74,.35)' : null);
  }

  // cost gem + element badge
  ctx.beginPath(); ctx.arc(29, 29, 20, 0, Math.PI * 2);
  ctx.fillStyle = grad(ctx, 9, 9, 49, 49, '#fff3d2', E.c2); ctx.fill(); ink(ctx, 4.6);
  ctx.font = '900 24px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = OUTLINE;
  ctx.fillText(String(def.cost), 29, 30);
  ctx.save();
  ctx.translate(153, 12);
  drawElemIcon(ctx, def.el, 34);
  ctx.restore();

  // board-only badges
  if (live && live.guard) {
    ctx.save();
    ctx.translate(24, 152);
    ctx.beginPath();
    ctx.moveTo(0, -15); ctx.lineTo(14, -9); ctx.lineTo(14, 5);
    ctx.quadraticCurveTo(14, 15, 0, 20);
    ctx.quadraticCurveTo(-14, 15, -14, 5);
    ctx.lineTo(-14, -9); ctx.closePath();
    ctx.fillStyle = '#f2b64a'; ctx.fill(); ink(ctx, 4);
    ctx.restore();
  }
  if (live && live.resting) {
    ctx.fillStyle = 'rgba(24,40,60,.34)';
    rrect(ctx, 3, 3, 194, 270, 20); ctx.fill();
    ctx.font = '900 30px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,250,238,.92)';
    ctx.fillText('z z z', 100, 96);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** The back of a card: a cove crest, used for the AI hand and both decks. */
function drawCardBack(ctx) {
  rrect(ctx, 3, 3, 194, 270, 20);
  ctx.fillStyle = grad(ctx, 0, 0, 200, 276, '#c9744f', '#8a4a2c'); ctx.fill(); ink(ctx, 5.5);
  rrect(ctx, 16, 16, 168, 244, 14);
  ctx.fillStyle = '#a85c38'; ctx.fill(); ink(ctx, 3.4, '#6d3a20');
  ctx.save();
  rrect(ctx, 16, 16, 168, 244, 14); ctx.clip();
  ctx.strokeStyle = 'rgba(255,246,227,.14)'; ctx.lineWidth = 6;
  for (let i = -6; i < 12; i++) {
    ctx.beginPath(); ctx.moveTo(i * 26, 0); ctx.lineTo(i * 26 + 120, 276); ctx.stroke();
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(100, 138, 52, 0, Math.PI * 2);
  ctx.fillStyle = '#f0dca0'; ctx.fill(); ink(ctx, 5);
  ctx.save();
  ctx.translate(100, 142);
  ctx.scale(0.72, 0.72);
  drawCritterArt(ctx, { el: 'neutral', look: { fur: '#b08a5a', prop: 'none' } });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// duelist portraits (the five-face system, plus hats for the player's capy)
// ---------------------------------------------------------------------------
function drawPortraitHat(ctx, hat, color) {
  if (!hat || hat === 'none') return;
  ctx.lineJoin = 'round';
  if (hat === 'beanie') {
    ctx.beginPath(); ctx.arc(100, 42, 54, Math.PI, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    rrect(ctx, 44, 32, 112, 20, 9);
    ctx.fillStyle = shade(color, 0.28); ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.arc(100, -14, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#fff6e3'; ctx.fill(); ink(ctx, 5);
  } else if (hat === 'cap') {
    ctx.beginPath(); ctx.arc(100, 42, 52, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(148, 42, 44, 12, -0.06, Math.PI, Math.PI * 2); ctx.closePath();
    ctx.fillStyle = shade(color, -0.2); ctx.fill(); ink(ctx, 5);
  } else if (hat === 'flower') {
    const cx = 150, cy = 26;
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, 11, 11, 0, 0, Math.PI * 2);
      ctx.fill(); ink(ctx, 4);
    }
    ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#f7d94c'; ctx.fill(); ink(ctx, 4);
  } else if (hat === 'tophat') {
    rrect(ctx, 46, 30, 108, 16, 7);
    ctx.fillStyle = '#3b3546'; ctx.fill(); ink(ctx, 5);
    rrect(ctx, 66, -28, 68, 60, 8);
    ctx.fillStyle = '#4a4358'; ctx.fill(); ink(ctx, 5);
    rrect(ctx, 66, 8, 68, 14, 4);
    ctx.fillStyle = color; ctx.fill();
  } else if (hat === 'chef') {
    rrect(ctx, 58, 22, 84, 22, 8);
    ctx.fillStyle = '#f6efe0'; ctx.fill(); ink(ctx, 5);
    ctx.beginPath();
    ctx.arc(74, 6, 21, 0, Math.PI * 2);
    ctx.arc(100, -6, 25, 0, Math.PI * 2);
    ctx.arc(126, 6, 21, 0, Math.PI * 2);
    ctx.fillStyle = '#fffaf0'; ctx.fill(); ink(ctx, 5);
  } else if (hat === 'crown') {
    ctx.beginPath();
    ctx.moveTo(56, 34);
    for (let i = 0; i < 3; i++) {
      ctx.lineTo(56 + i * 30 + 15, -6);
      ctx.lineTo(56 + (i + 1) * 30, 34);
    }
    ctx.closePath();
    ctx.fillStyle = '#f2b64a'; ctx.fill(); ink(ctx, 5);
    ctx.fillStyle = '#e8657a';
    for (const px of [71, 101, 131]) { ctx.beginPath(); ctx.arc(px, 4, 6, 0, Math.PI * 2); ctx.fill(); }
  } else if (hat === 'viking') {
    ctx.beginPath(); ctx.arc(100, 40, 48, Math.PI, Math.PI * 2);
    ctx.fillStyle = '#b8bcc4'; ctx.fill(); ink(ctx, 5);
    for (const d of [-1, 1]) {
      ctx.save(); ctx.translate(100 + d * 48, 18); ctx.scale(d, 1);
      ctx.beginPath();
      ctx.moveTo(0, 8); ctx.quadraticCurveTo(30, 6, 30, -26);
      ctx.quadraticCurveTo(16, -6, 0, -8); ctx.closePath();
      ctx.fillStyle = '#fff2d6'; ctx.fill(); ink(ctx, 4.5);
      ctx.restore();
    }
  } else if (hat === 'propeller') {
    ctx.beginPath(); ctx.arc(100, 40, 44, Math.PI, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    rrect(ctx, 46, 28, 108, 12, 6);
    ctx.fillStyle = shade(color, -0.2); ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.moveTo(100, -4); ctx.lineTo(100, -22); ink(ctx, 5);
    for (const d of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(100 + d * 22, -24, 22, 7, d * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#e8657a'; ctx.fill(); ink(ctx, 4);
    }
  } else if (hat === 'pirate') {
    ctx.beginPath();
    ctx.moveTo(42, 40);
    ctx.quadraticCurveTo(100, -18, 158, 40);
    ctx.quadraticCurveTo(100, 22, 42, 40);
    ctx.closePath();
    ctx.fillStyle = '#3b3546'; ctx.fill(); ink(ctx, 5);
    ctx.fillStyle = '#fff6e3';
    ctx.beginPath(); ctx.arc(100, 16, 8, 0, Math.PI * 2); ctx.fill();
  }
}

/** expr: idle | blink | thinking | smug | worried | hurt | beaten | beam */
function drawDuelistFace(ctx, size, cfg, expr) {
  const s = size / 200;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const body = cfg.color;
  const dark = shade(body, -0.24);
  const muzzle = shade(body, 0.22);

  rrect(ctx, 52, 150, 96, 60, 28);
  ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);
  for (const ex of [46, 154]) {
    ctx.beginPath(); ctx.ellipse(ex, 50, 19, 16, ex < 100 ? 0.3 : -0.3, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(ex, 52, 8, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a3a8'; ctx.fill();
  }
  rrect(ctx, 38, 38, 124, 102, 42);
  ctx.fillStyle = grad(ctx, 38, 38, 162, 140, shade(body, 0.1), body);
  ctx.fill(); ink(ctx, 5.5);
  rrect(ctx, 58, 96, 84, 56, 26);
  ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4.5);
  ctx.fillStyle = OUTLINE;
  for (const nx of [86, 114]) {
    ctx.save(); ctx.translate(nx, 116); ctx.rotate(nx < 100 ? 0.5 : -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 5.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
  if (expr === 'beam') {
    ctx.beginPath();
    ctx.moveTo(84, 130); ctx.quadraticCurveTo(100, 148, 116, 130); ctx.closePath();
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
  } else if (expr === 'smug') {
    ctx.beginPath();
    ctx.moveTo(84, 132); ctx.quadraticCurveTo(98, 142, 116, 126); ctx.stroke();
  } else if (expr === 'worried' || expr === 'thinking') {
    ctx.beginPath();
    ctx.moveTo(86, 132); ctx.quadraticCurveTo(93, 138, 100, 132);
    ctx.quadraticCurveTo(107, 126, 114, 132); ctx.stroke();
  } else if (expr === 'hurt') {
    rrect(ctx, 84, 124, 32, 14, 5);
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
    ctx.strokeStyle = '#fffaee'; ctx.lineWidth = 3;
    for (const px of [92, 100, 108]) { ctx.beginPath(); ctx.moveTo(px, 124); ctx.lineTo(px, 138); ctx.stroke(); }
  } else if (expr === 'beaten') {
    ctx.beginPath(); ctx.arc(100, 134, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.ellipse(100, 146, 8, 9, 0, 0, Math.PI);
    ctx.fillStyle = '#f08fa0'; ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(88, 130); ctx.quadraticCurveTo(100, 140, 112, 130); ctx.stroke();
  }

  const eyes = [70, 130];
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i];
    ctx.lineWidth = 5; ctx.strokeStyle = OUTLINE;
    if (expr === 'beaten') {
      ctx.beginPath();
      for (let k = 0; k < 22; k++) {
        const a = k * 0.55, r = 1.4 + k * 0.5;
        const px = ex + Math.cos(a) * r, py = 78 + Math.sin(a) * r * 0.85;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.lineWidth = 4; ctx.stroke();
    } else if (expr === 'blink' || expr === 'beam' || expr === 'hurt') {
      ctx.beginPath();
      ctx.moveTo(ex - 11, 78);
      ctx.quadraticCurveTo(ex, expr === 'blink' ? 88 : 62, ex + 11, 78);
      ctx.stroke();
    } else if (expr === 'smug') {
      ctx.beginPath(); ctx.moveTo(ex - 11, 76); ctx.lineTo(ex + 11, 76); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(ex, 82, 7, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
    } else {
      const r = expr === 'worried' || expr === 'thinking' ? 8 : 10;
      ctx.beginPath(); ctx.ellipse(ex, 76, r, r + 1.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.beginPath(); ctx.arc(ex - 3.4, 72, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      if (expr === 'worried' || expr === 'thinking') {
        ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
        ctx.beginPath();
        ctx.moveTo(ex + (i ? 12 : -12), 60); ctx.lineTo(ex + (i ? -5 : 5), 56);
        ctx.stroke();
      }
    }
  }

  if (expr === 'idle' || expr === 'beam' || expr === 'smug') {
    ctx.fillStyle = 'rgba(232,101,122,0.3)';
    ctx.beginPath(); ctx.ellipse(52, 104, 12, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(148, 104, 12, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (expr === 'worried' || expr === 'hurt' || expr === 'thinking') {
    ctx.beginPath();
    ctx.moveTo(170, 60); ctx.quadraticCurveTo(180, 74, 170, 80);
    ctx.quadraticCurveTo(160, 74, 170, 60); ctx.closePath();
    ctx.fillStyle = '#9ed9f2'; ctx.fill(); ink(ctx, 3.5);
  }
  if (cfg.monocle) {
    ctx.beginPath(); ctx.arc(130, 76, 22, 0, Math.PI * 2);
    ink(ctx, 5, '#f2b64a');
    ctx.beginPath(); ctx.moveTo(146, 92); ctx.quadraticCurveTo(158, 118, 150, 138);
    ink(ctx, 3.4, '#f2b64a');
  }
  drawPortraitHat(ctx, cfg.hat, cfg.hatColor || '#e8657a');
  ctx.restore();
}

function paintFace(cv, size, cfg, expr) {
  const ctx = fitCanvas(cv, size, size);
  drawDuelistFace(ctx, size, cfg, expr);
}

/**
 * The board no longer shows a whole card: the critter itself is standing there
 * in 3D, so the slot only carries what a spectator has to read at a glance -
 * attack, health, and whether it is guarding or still napping. The name and the
 * rules text live on the card in hand and in the hover panel.
 */
function drawPlaque(ctx, def, live) {
  const E = ELEMENTS[def.el] || ELEMENTS.neutral;
  const atk = live ? live.atk : def.atk;
  const hp = live ? live.hp : def.hp;
  const buffed = live && live.atk > def.atk;
  const hurt = live && live.hp < def.hp;
  const guard = live ? live.guard : has(def, 'guard');
  const resting = !!(live && live.resting);

  ctx.save();
  // a soft plate behind the pips so they read against any colour of moss
  rrect(ctx, 26, 14, 148, 40, 20);
  ctx.fillStyle = 'rgba(20,13,7,.62)';
  ctx.fill();

  const pip = (x, fill, value, glow) => {
    if (glow) {
      ctx.beginPath();
      ctx.arc(x, 34, 32, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, 34, 25, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ink(ctx, 5);
    ctx.fillStyle = '#fffdf6';
    ctx.font = '900 32px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x, 36);
  };
  pip(32, buffed ? '#7ac74f' : '#f2b64a', atk, buffed ? 'rgba(122,199,79,.5)' : null);
  pip(168, hurt ? '#e04a4a' : '#e8657a', hp, hurt ? 'rgba(224,74,74,.45)' : null);

  // element dot in the middle, with the state badge stacked under it
  ctx.beginPath();
  ctx.arc(100, 30, 13, 0, Math.PI * 2);
  ctx.fillStyle = E.c1;
  ctx.fill();
  ink(ctx, 4, shade(E.deep, -0.1));
  if (guard) {
    ctx.beginPath();
    ctx.moveTo(100, 22);
    ctx.lineTo(108, 26);
    ctx.lineTo(108, 33);
    ctx.quadraticCurveTo(108, 39, 100, 42);
    ctx.quadraticCurveTo(92, 39, 92, 33);
    ctx.lineTo(92, 26);
    ctx.closePath();
    ctx.fillStyle = '#dff3ff';
    ctx.fill();
    ink(ctx, 3.4);
  }
  if (resting) {
    ctx.fillStyle = '#ffeec9';
    ctx.font = '900 17px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('z z', 100, 60);
  }
  ctx.restore();
}

function paintPlaque(cv, W, def, live) {
  const H = Math.round(W * 0.34);
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  const k = W / 200;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, 200, 68);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawPlaque(ctx, def, live);
}

// ===========================================================================
// THE BATTLE DIORAMA : one WebGLRenderer, procedural everything.
//
// Layout rule: the DOM is the source of truth. Every anchor (slot, capy bust,
// table footprint) is measured off its DOM box and unprojected onto the arena
// plane, so the 3D show always lines up with the hit zones and highlight rings
// that the v1 board already had. Nothing in here reads or writes duel state.
// ===========================================================================

/** Element palette in 3D. `mote` is what a thing shatters into. */
const EL3 = {
  sun: { light: 0xffd070, deep: 0xe07f16, mote: 0xffe6a8, rim: 0xffc46a },
  sea: { light: 0x7fd0f0, deep: 0x2478b8, mote: 0xd8f2ff, rim: 0x5fc6f0 },
  snow: { light: 0xeaf6ff, deep: 0x8fb6d8, mote: 0xffffff, rim: 0xbfe2ff },
  neutral: { light: 0xe6cfa4, deep: 0x9c7c4e, mote: 0xf7e6c4, rim: 0xdcc094 },
};
const TRI_CALL = { sun: 'MELTED!', snow: 'FROSTED!', sea: 'SOAKED!' };

/** Every timing the show runs on, in ms. Fast mode halves the lot (see `d()`). */
const DUR = {
  fly: 300, slam: 110, beam: 190, grow: 250,
  crouch: 150, leap: 240, hitstop: 90, hop: 200,
  koCrack: 200, koPause: 90, koShatter: 340,
  spell: 1100, banner: 900, finish: 950, white: 340,
};

function numOf(cssHex) { return parseInt(String(cssHex).slice(1), 16) || 0; }
/** shade() for 0xrrggbb numbers: >0 lifts toward cream, <0 sinks toward ink. */
function shadeNum(n, amt) { return numOf(shade(hexOf(n), amt)); }
/** The cove's ink, as a 3D colour (never pure black: see DESIGN.md). */
const INK3 = 0x2d2417;

// --- geometry merging: one critter = one draw call ---------------------------
const _mQ = new THREE.Quaternion();
const _mE = new THREE.Euler();
const _mV = new THREE.Vector3();
const _mS = new THREE.Vector3();

/** Push a primitive into a parts list with a local transform + flat colour. */
function part(list, geo, color, pos, rot, scale) {
  const m = new THREE.Matrix4();
  _mE.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  _mQ.setFromEuler(_mE);
  _mV.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
  if (typeof scale === 'number') _mS.setScalar(scale);
  else _mS.set(scale ? scale[0] : 1, scale ? scale[1] : 1, scale ? scale[2] : 1);
  m.compose(_mV, _mQ, _mS);
  list.push({ geo, color, m });
}

/**
 * Bake a parts list into one vertex-coloured BufferGeometry and dispose the
 * sources. Handles indexed and non-indexed primitives (polyhedra are the
 * non-indexed ones), so a whole critter renders in a single draw call.
 */
function mergeParts(parts) {
  if (!parts.length) return null;
  let vTotal = 0, iTotal = 0;
  for (const p of parts) {
    const pos = p.geo.attributes.position;
    vTotal += pos.count;
    iTotal += p.geo.index ? p.geo.index.count : pos.count;
  }
  const position = new Float32Array(vTotal * 3);
  const normal = new Float32Array(vTotal * 3);
  const color = new Float32Array(vTotal * 3);
  const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  let vo = 0, io = 0;
  for (const p of parts) {
    const g = p.geo;
    const gp = g.attributes.position;
    const gn = g.attributes.normal;
    nm.getNormalMatrix(p.m);
    c.set(p.color);
    for (let i = 0; i < gp.count; i++) {
      v.fromBufferAttribute(gp, i).applyMatrix4(p.m);
      position[(vo + i) * 3] = v.x;
      position[(vo + i) * 3 + 1] = v.y;
      position[(vo + i) * 3 + 2] = v.z;
      if (gn) v.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      else v.set(0, 1, 0);
      normal[(vo + i) * 3] = v.x;
      normal[(vo + i) * 3 + 1] = v.y;
      normal[(vo + i) * 3 + 2] = v.z;
      color[(vo + i) * 3] = c.r;
      color[(vo + i) * 3 + 1] = c.g;
      color[(vo + i) * 3 + 2] = c.b;
    }
    const gi = g.index;
    const n = gi ? gi.count : gp.count;
    for (let i = 0; i < n; i++) index[io + i] = (gi ? gi.getX(i) : i) + vo;
    vo += gp.count;
    io += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/** Wrap a parts list into a Group: one toon mesh + one unlit glow mesh. */
function bakeModel(solid, glow) {
  const g = new THREE.Group();
  const owned = { geos: [], mats: [] };
  const sg = mergeParts(solid);
  if (sg) {
    const mat = makeToon(0xffffff, { unique: true, vertexColors: true });
    const mesh = new THREE.Mesh(sg, mat);
    g.add(mesh);
    owned.geos.push(sg);
    owned.mats.push(mat);
    g.userData.solid = mesh;
  }
  const gg = mergeParts(glow);
  if (gg) {
    const mat = makeGlow(0xffffff, { unique: true });
    mat.vertexColors = true;
    mat.transparent = true;
    const mesh = new THREE.Mesh(gg, mat);
    g.add(mesh);
    owned.geos.push(gg);
    owned.mats.push(mat);
    g.userData.glow = mesh;
  }
  g.userData.owned = owned;
  return g;
}

function freeModel(g) {
  if (!g) return;
  const owned = g.userData && g.userData.owned;
  if (owned) {
    for (const geo of owned.geos) geo.dispose();
    for (const m of owned.mats) m.dispose();
  } else {
    disposeObject(g);
  }
  g.clear();
}

// --- the fallback cast -------------------------------------------------------
// Used until (or instead of) ./critters.js resolves. One chibi capy rig driven
// by the same `look` data the 2D card art uses, so all 14 read differently.

function buildFallbackCritter(cardId) {
  const def = CARDS[cardId] || CARDS.pebble_pal;
  const look = def.look || {};
  const el = EL3[def.el] || EL3.neutral;
  const fur = numOf(look.fur || '#b08a5a');
  const furDark = numOf(shade(look.fur || '#b08a5a', -0.3));
  const solid = [];
  const glow = [];

  // feet
  for (const sx of [-1, 1]) {
    part(solid, new THREE.BoxGeometry(0.16, 0.1, 0.24), furDark, [sx * 0.15, 0.05, 0.1]);
  }
  // body: Pebble Pal is literally a rock doing its best
  if (look.prop === 'pebble') {
    part(solid, new THREE.IcosahedronGeometry(0.3, 0), 0xa9a79c, [0, 0.3, 0], [0.3, 0.6, 0.1], [1, 0.92, 0.9]);
  } else {
    part(solid, new THREE.SphereGeometry(0.26, 8, 6), fur, [0, 0.32, 0], null, [1.06, 0.98, 0.92]);
  }
  // head + face
  part(solid, new THREE.SphereGeometry(0.24, 8, 6), fur, [0, 0.72, 0.02], null, [1.12, 1, 1]);
  part(solid, new THREE.SphereGeometry(0.13, 7, 5), numOf(shade(look.fur || '#b08a5a', 0.18)), [0, 0.665, 0.19], null, [0.95, 0.62, 0.62]);
  part(solid, new THREE.BoxGeometry(0.09, 0.055, 0.05), INK3, [0, 0.71, 0.27]);
  for (const sx of [-1, 1]) {
    part(solid, new THREE.SphereGeometry(0.075, 6, 5), furDark, [sx * 0.2, 0.89, -0.02], null, [1, 1, 0.6]);
    part(solid, new THREE.SphereGeometry(0.04, 6, 5), INK3, [sx * 0.1, 0.785, 0.19]);
  }
  part(solid, new THREE.SphereGeometry(0.06, 6, 5), furDark, [0, 0.3, -0.26]);

  switch (look.prop) {
    case 'shades':
      part(solid, new THREE.BoxGeometry(0.34, 0.085, 0.05), 0x2a2a33, [0, 0.795, 0.2]);
      for (const sx of [-1, 1]) {
        part(glow, new THREE.BoxGeometry(0.13, 0.07, 0.02), 0x8fd8ff, [sx * 0.09, 0.795, 0.235]);
      }
      break;
    case 'board':
      part(solid, new THREE.SphereGeometry(0.3, 7, 5), 0xfff6e3, [-0.3, 0.44, -0.06], [0, 0, 0.55], [0.36, 0.11, 1]);
      part(solid, new THREE.SphereGeometry(0.3, 6, 4), 0xe8657a, [-0.3, 0.46, -0.06], [0, 0, 0.55], [0.1, 0.1, 0.98]);
      break;
    case 'scarf':
      part(solid, new THREE.TorusGeometry(0.2, 0.06, 6, 12), 0xe8657a, [0, 0.55, 0.02], [Math.PI / 2, 0, 0]);
      part(solid, new THREE.BoxGeometry(0.1, 0.24, 0.06), 0xd44f66, [0.16, 0.42, 0.14], [0, 0, 0.35]);
      break;
    case 'ring':
      part(solid, new THREE.TorusGeometry(0.3, 0.085, 6, 14), 0xfff6e3, [0, 0.3, 0], [Math.PI / 2, 0, 0]);
      part(solid, new THREE.TorusGeometry(0.3, 0.088, 4, 6), 0x4fb3e8, [0, 0.3, 0], [Math.PI / 2, 0.4, 0]);
      break;
    case 'earmuffs':
      part(solid, new THREE.TorusGeometry(0.24, 0.035, 5, 10, Math.PI), 0x6b4f35, [0, 0.9, 0], [0, 0, 0]);
      for (const sx of [-1, 1]) {
        part(solid, new THREE.SphereGeometry(0.1, 7, 5), 0xfff6e3, [sx * 0.24, 0.87, 0], null, [0.8, 1, 1]);
      }
      break;
    case 'mug':
      part(solid, new THREE.CylinderGeometry(0.1, 0.09, 0.15, 8), 0xfff6e3, [0.3, 0.44, 0.14]);
      part(solid, new THREE.TorusGeometry(0.06, 0.02, 4, 8), 0xfff6e3, [0.39, 0.44, 0.14], [0, Math.PI / 2, 0]);
      part(glow, new THREE.CylinderGeometry(0.085, 0.085, 0.02, 8), 0x8a5a2a, [0.3, 0.52, 0.14]);
      break;
    case 'crown':
      part(solid, new THREE.CylinderGeometry(0.17, 0.19, 0.09, 8, 1, true), 0xf2c744, [0, 0.95, 0]);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        part(solid, new THREE.ConeGeometry(0.04, 0.11, 4), 0xf2c744, [Math.cos(a) * 0.18, 1.02, Math.sin(a) * 0.18]);
      }
      break;
    case 'moss':
      for (const [px, py, pz] of [[-0.18, 0.48, -0.16], [0.14, 0.52, -0.2], [0.02, 0.36, -0.26]]) {
        part(solid, new THREE.SphereGeometry(0.11, 6, 4), 0x6f9c4a, [px, py, pz], null, [1, 0.6, 1]);
      }
      break;
    case 'kelp':
      for (const sx of [-1, 1]) {
        part(solid, new THREE.ConeGeometry(0.07, 0.34, 5), 0x4a8f5c, [sx * 0.24, 0.5, -0.1], [0.2, 0, sx * -0.35]);
      }
      break;
    default:
      break;
  }
  if (look.towel) {
    part(solid, new THREE.BoxGeometry(0.62, 0.05, 0.42), 0xe8657a, [0, 0.025, 0.02]);
    for (const i of [-1, 0, 1]) {
      part(solid, new THREE.BoxGeometry(0.09, 0.06, 0.42), 0xfff6e3, [i * 0.19, 0.028, 0.02]);
    }
  }
  if (look.spiky) {
    for (let i = -2; i <= 2; i++) {
      part(glow, new THREE.ConeGeometry(0.045, 0.24, 4), 0xffd070, [i * 0.11, 1.0, -0.02], [0, 0, i * 0.34]);
    }
  }

  // element accents: sun halo, snow breath puffs, sea drips
  if (def.el === 'sun') {
    part(glow, new THREE.TorusGeometry(0.25, 0.022, 4, 14), el.light, [0, 1.06, -0.02], [Math.PI / 2 - 0.35, 0, 0]);
  } else if (def.el === 'snow') {
    for (const [px, py, pz] of [[0.12, 0.62, 0.34], [0.2, 0.7, 0.42], [0.28, 0.6, 0.5]]) {
      part(glow, new THREE.SphereGeometry(0.045, 5, 4), 0xffffff, [px, py, pz]);
    }
  } else if (def.el === 'sea') {
    for (const [px, py] of [[-0.3, 0.5], [0.31, 0.42], [-0.24, 0.24]]) {
      part(glow, new THREE.SphereGeometry(0.04, 5, 4), el.light, [px, py, 0.08]);
    }
  } else {
    part(glow, new THREE.SphereGeometry(0.045, 5, 4), el.light, [0, 1.0, 0.06]);
  }

  const model = bakeModel(solid, glow);
  if (look.big) model.scale.setScalar(1.2);
  return model;
}

/** A duellist bust: shoulders + a head that can tilt, blink and glare. */
function buildBust(cfg) {
  const fur = numOf(bodyHex(cfg.color));
  const furDark = numOf(shade(bodyHex(cfg.color), -0.3));
  const furLit = numOf(shade(bodyHex(cfg.color), 0.18));
  const g = new THREE.Group();

  const bodyParts = [];
  part(bodyParts, new THREE.CylinderGeometry(0.5, 0.58, 0.16, 12), 0x8a8578, [0, 0.08, 0]);
  part(bodyParts, new THREE.CylinderGeometry(0.42, 0.48, 0.1, 12), 0x6f6a5e, [0, 0.19, 0]);
  part(bodyParts, new THREE.SphereGeometry(0.46, 9, 6), fur, [0, 0.42, 0.02], null, [1.2, 0.62, 0.86]);
  part(bodyParts, new THREE.CylinderGeometry(0.18, 0.22, 0.2, 8), fur, [0, 0.64, 0.03]);
  const body = bakeModel(bodyParts, []);
  g.add(body);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.78, 0);
  // the play camera looks down at ~50 degrees: without this the faces are all
  // forehead, so the whole bust leans back and the head tips up to meet it
  headPivot.rotation.x = 0.42;
  g.add(headPivot);

  const headParts = [];
  part(headParts, new THREE.SphereGeometry(0.36, 10, 7), fur, [0, 0.02, 0], null, [1.12, 1, 1]);
  part(headParts, new THREE.SphereGeometry(0.2, 8, 6), furLit, [0, -0.07, 0.29], null, [0.98, 0.62, 0.6]);
  part(headParts, new THREE.BoxGeometry(0.13, 0.08, 0.06), INK3, [0, -0.02, 0.42]);
  for (const sx of [-1, 1]) {
    part(headParts, new THREE.SphereGeometry(0.11, 7, 5), furDark, [sx * 0.3, 0.24, -0.03], null, [1, 1, 0.6]);
  }
  const head = bakeModel(headParts, []);
  headPivot.add(head);

  const eyeParts = [];
  for (const sx of [-1, 1]) part(eyeParts, new THREE.SphereGeometry(0.058, 7, 5), INK3, [sx * 0.16, 0.07, 0.3]);
  const eyes = bakeModel(eyeParts, []);
  headPivot.add(eyes);

  const browParts = [];
  for (const sx of [-1, 1]) {
    part(browParts, new THREE.BoxGeometry(0.15, 0.035, 0.04), INK3, [sx * 0.17, 0.2, 0.3], [0, 0, sx * 0.2]);
  }
  const brows = bakeModel(browParts, []);
  headPivot.add(brows);

  const hatAnchor = new THREE.Group();
  hatAnchor.position.set(0, 0.36, 0);
  hatAnchor.scale.setScalar(1.16);
  headPivot.add(hatAnchor);

  g.userData = { body, head, headPivot, eyes, brows, hatAnchor, height: 1.5 };
  return g;
}

function freeBust(g) {
  const u = g.userData || {};
  for (const m of [u.body, u.head, u.eyes, u.brows]) freeModel(m);
  if (u.hatAnchor) disposeObject(u.hatAnchor);
  g.clear();
}

/** Bust poses. Everything is lerped, so these are targets, not snapshots. */
const BUST_POSE = {
  idle: { brow: 0, browY: 0, eye: 1, tilt: 0, nod: 0 },
  blink: { brow: 0, browY: 0, eye: 0.12, tilt: 0, nod: 0 },
  thinking: { brow: 0.3, browY: 0.01, eye: 0.8, tilt: 0.16, nod: -0.06 },
  worried: { brow: -0.42, browY: 0.05, eye: 1.15, tilt: -0.05, nod: -0.16 },
  hurt: { brow: -0.5, browY: 0.02, eye: 0.35, tilt: 0.1, nod: -0.24 },
  smug: { brow: 0.45, browY: -0.03, eye: 0.55, tilt: -0.1, nod: 0.16 },
  beam: { brow: 0.1, browY: 0.06, eye: 0.22, tilt: 0, nod: 0.2 },
  beaten: { brow: -0.6, browY: -0.02, eye: 0.16, tilt: 0.24, nod: -0.42 },
};

// ---------------------------------------------------------------------------
// Diorama: the 3D stage. Owns exactly one WebGLRenderer, one instanced particle
// pool, a handful of pooled effect meshes and the two duellist busts.
// ---------------------------------------------------------------------------
const PMAX = 340;
const UP_AXIS = new THREE.Vector3(0, 1, 0);

class Diorama {
  constructor(host, opts = {}) {
    this.host = host;
    this.sfx = opts.sfx || (() => {});
    this.reduced = !!opts.reduced;
    this.speed = 1;
    this.ok = false;
    this.now = 0; // stage clock: stops dead during hit-stop
    this.hitStopUntil = 0;
    this.slowUntil = 0;
    this.shakeMag = 0;
    this.shakeT = 0;
    this.crit = new Map();
    this.anchors = new Map(); // 's0_2' | 'b1' -> {p:Vector3, px:number, scale:number}
    this.busts = { 0: null, 1: null };
    this.rings = [];
    this.beams = [];
    this.fx = [];
    this.mood = new THREE.Color(0x9fd0f5);
    this.moodWant = new THREE.Color(0x9fd0f5);
    this.finishRun = null;
    this.pinBusts = true;
    this._geos = [];
    this._mats = [];
    this._texs = [];
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._m4 = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scl = new THREE.Vector3();
    this._col = new THREE.Color();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._build();
  }

  /** Fast mode halves every duration constant; `d()` is the only reader. */
  setSpeed(mult) {
    this.speed = mult;
    for (const e of this.crit.values()) if (e.rig) e.rig.speed = 1 / (mult || 1);
  }
  d(ms) { return ms * this.speed; }

  // ---- construction -------------------------------------------------------
  _build() {
    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      // no WebGL: the duel still plays, it just plays on the flat board
      console.warn('[cards] no WebGL context, falling back to the flat board', e);
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min((typeof devicePixelRatio === 'number' ? devicePixelRatio : 1), 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const cv = renderer.domElement;
    cv.className = 'mg-cards-stage';
    this.host.appendChild(cv);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 1, 240);
    this.camHome = new THREE.Vector3(0, 19, 14.5);
    this.lookHome = new THREE.Vector3(0, 0, -1);
    this.camera.position.copy(this.camHome);
    this.camera.lookAt(this.lookHome);

    this.scene.add(new THREE.HemisphereLight(0xfff1d4, 0x22301f, 0.72));
    const key = new THREE.DirectionalLight(0xfff4de, 1.55);
    key.position.set(7, 14, 9);
    this.scene.add(key);
    this.rim = new THREE.DirectionalLight(0x9fd0f5, 0.95);
    this.rim.position.set(-8, 7, -12);
    this.scene.add(this.rim);
    this.lamp = new THREE.PointLight(0xffe2a0, 0.55, 46, 1.6);
    this.lamp.position.set(0, 9, 2);
    this.scene.add(this.lamp);

    this._buildTable();
    this._buildSlotMarks();
    this._buildParticles();
    this._buildPools();
    this.ok = true;
  }

  _tex(w, h, draw) {
    const t = canvasTexture(w, h, draw);
    this._texs.push(t);
    return t;
  }

  _keep(geo, mat) {
    if (geo) this._geos.push(geo);
    if (mat) this._mats.push(mat);
  }

  _buildTable() {
    this.tableMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeToon(0xffffff, { unique: true, vertexColors: true }));
    this.tableMesh.frustumCulled = false;
    this.scene.add(this.tableMesh);
    this._mats.push(this.tableMesh.material);
  }

  /** Rebuild the arena slab so it covers the board rows with a rim to spare. */
  _fitTable(rect) {
    if (!this.tableMesh || !this.vw) return;
    const r = rect || this.board || { x: 0, y: 0, w: this.vw, h: this.vh };
    this.board = r;
    const x0 = r.x - r.w * 0.06, x1 = r.x + r.w * 1.06;
    const y0 = r.y - r.h * 0.06, y1 = r.y + r.h * 1.04;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y1]]) {
      const p = this.worldAt(px, py, this._tmpA);
      if (!p) continue;
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    if (!Number.isFinite(minX)) return;
    const pad = 0.9;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const sw = Math.max(6, (maxX - minX) + pad * 2);
    const sd = Math.max(6, (maxZ - minZ) + pad * 2);
    this.tableSize = { cx, cz, w: sw, d: sd };

    const parts = [];
    const stone = 0x8e8878, stoneDark = 0x625d51, moss = 0x3d5c36, mossLit = 0x4a6d40;
    part(parts, new THREE.BoxGeometry(sw, 1.4, sd), stoneDark, [cx, -0.78, cz]);
    part(parts, new THREE.BoxGeometry(sw - 0.5, 0.4, sd - 0.5), stone, [cx, -0.26, cz]);
    // the felt: two mossy layers with a hair of clearance so they never z-fight
    part(parts, new THREE.BoxGeometry(sw - 2.2, 0.12, sd - 2.2), moss, [cx, -0.075, cz]);
    part(parts, new THREE.BoxGeometry(sw - 4.4, 0.08, sd - 3.4), mossLit, [cx, -0.04, cz]);
    // a carved centre line so the two halves of the arena read apart
    part(parts, new THREE.BoxGeometry(sw - 5.6, 0.05, 0.2), stone, [cx, -0.005, cz]);
    // rim stones: chunky blocks around the lip, so the table reads as carved
    const nx = Math.max(4, Math.round(sw / 2.6));
    for (let i = 0; i < nx; i++) {
      const x = cx - sw / 2 + (i + 0.5) * (sw / nx);
      for (const zs of [-1, 1]) {
        part(parts, new THREE.BoxGeometry(sw / nx - 0.18, 0.26, 0.9), i % 2 ? stone : stoneDark,
          [x, 0.06, cz + zs * (sd / 2 - 0.55)]);
      }
    }
    const nz = Math.max(3, Math.round(sd / 2.6));
    for (let i = 0; i < nz; i++) {
      const z = cz - sd / 2 + (i + 0.5) * (sd / nz);
      for (const xs of [-1, 1]) {
        part(parts, new THREE.BoxGeometry(0.9, 0.26, sd / nz - 0.18), i % 2 ? stoneDark : stone,
          [cx + xs * (sw / 2 - 0.55), 0.06, z]);
      }
    }
    // moss tufts on the rim
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.4;
      part(parts, new THREE.SphereGeometry(0.3, 6, 4), i % 2 ? moss : mossLit,
        [cx + Math.cos(a) * (sw / 2 - 0.6), 0.2, cz + Math.sin(a) * (sd / 2 - 0.6)], null, [1, 0.42, 1]);
    }
    // the element triangle inlaid into the flanks, so the table teaches it too
    const SIGILS = [0xe8b24a, 0xcfe3f2, 0x4f9ac8];
    const flank = Math.min(sw / 2 - 1.9, sw * 0.27);
    for (const xs of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const col = SIGILS[i];
        const z = cz + (i - 1) * Math.min(2.4, sd * 0.22);
        part(parts, new THREE.CylinderGeometry(0.46, 0.46, 0.05, 16), col, [cx + xs * flank, -0.01, z]);
        part(parts, new THREE.CylinderGeometry(0.34, 0.34, 0.06, 16), shadeNum(col, -0.25), [cx + xs * flank, -0.005, z]);
      }
    }
    // corner lanterns: warm anchors in the four corners of the arena
    for (const xs of [-1, 1]) {
      for (const zs of [-1, 1]) {
        const lx = cx + xs * Math.min(sw / 2 - 1.4, sw * 0.33), lz = cz + zs * (sd / 2 - 1.2);
        part(parts, new THREE.CylinderGeometry(0.26, 0.34, 0.5, 8), stoneDark, [lx, 0.25, lz]);
        part(parts, new THREE.SphereGeometry(0.28, 8, 6), 0xffe2a0, [lx, 0.68, lz]);
        part(parts, new THREE.CylinderGeometry(0.16, 0.2, 0.12, 8), stone, [lx, 0.9, lz]);
      }
    }
    // a scatter of pebbles so the felt is never a blank sheet
    for (let i = 0; i < 9; i++) {
      const a = i * 2.399;
      const rr = 0.32 + ((i * 37) % 100) / 100 * 0.4;
      part(parts, new THREE.IcosahedronGeometry(0.16 + (i % 3) * 0.05, 0), stone,
        [cx + Math.cos(a) * (sw / 2 - 1.1) * rr * 1.6, 0.04, cz + Math.sin(a) * (sd / 2 - 1) * rr],
        [0.4, a, 0.2], [1, 0.6, 1]);
    }
    const geo = mergeParts(parts);
    this.tableMesh.geometry.dispose();
    this.tableMesh.geometry = geo;
  }

  _buildSlotMarks() {
    const shadowTex = this._tex(96, 96, (c, w2, h2) => {
      const g = c.createRadialGradient(w2 / 2, h2 / 2, 2, w2 / 2, h2 / 2, w2 / 2);
      g.addColorStop(0, 'rgba(10,18,10,.55)');
      g.addColorStop(0.6, 'rgba(10,18,10,.22)');
      g.addColorStop(1, 'rgba(10,18,10,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w2, h2);
    });
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    const disc = new THREE.PlaneGeometry(1, 1);
    disc.rotateX(-Math.PI / 2);
    this.shadowIM = new THREE.InstancedMesh(disc, shadowMat, 8);
    this.shadowIM.frustumCulled = false;
    this.shadowIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.shadowIM);
    this._keep(disc, shadowMat);

    const ringGeo = new THREE.RingGeometry(0.62, 0.82, 26);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.ringIM = new THREE.InstancedMesh(ringGeo, ringMat, 8);
    this.ringIM.frustumCulled = false;
    this.ringIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.ringIM);
    this._keep(ringGeo, ringMat);
    this.ringGlow = new Float32Array(8); // 0..1 highlight, driven from the DOM
    this.ringFlash = new Float32Array(8);
    this.ringFlashCol = new Array(8).fill(0xffffff);
    for (let i = 0; i < 8; i++) {
      this.ringIM.setColorAt(i, this._col.setHex(0x6a5a38));
      this.shadowIM.setColorAt(i, this._col.setHex(0xffffff));
    }
  }

  _buildParticles() {
    this.pPos = new Float32Array(PMAX * 3);
    this.pVel = new Float32Array(PMAX * 3);
    this.pLife = new Float32Array(PMAX);
    this.pTtl = new Float32Array(PMAX);
    this.pSize = new Float32Array(PMAX);
    this.pStretch = new Float32Array(PMAX);
    this.pGrav = new Float32Array(PMAX);
    this.pNext = 0;
    this.pLive = 0;
    const geo = new THREE.IcosahedronGeometry(0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.parts = new THREE.InstancedMesh(geo, mat, PMAX);
    this.parts.frustumCulled = false;
    this.parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.parts.visible = false;
    this.scene.add(this.parts);
    this._keep(geo, mat);
    for (let i = 0; i < PMAX; i++) {
      this._m4.makeScale(0, 0, 0);
      this.parts.setMatrixAt(i, this._m4);
      this.parts.setColorAt(i, this._col.setHex(0xffffff));
    }
  }

  _buildPools() {
    // dust / shock rings
    const ringTex = this._tex(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, w * 0.28, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.55, 'rgba(255,255,255,.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this._keep(ringGeo, null);
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
      });
      const m = new THREE.Mesh(ringGeo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this._mats.push(mat);
      this.rings.push({ m, t: 0, ttl: 0, r0: 1, r1: 4 });
    }

    // summon beams
    const beamGeo = new THREE.CylinderGeometry(1, 0.34, 1, 16, 1, true);
    this._keep(beamGeo, null);
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(beamGeo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.scene.add(m);
      this._mats.push(mat);
      this.beams.push({ m, t: 0, ttl: 0, h: 6, r: 1 });
    }

    // spell silhouettes: one mesh per shape, hidden until a spell needs it
    const flareTex = this._tex(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h * 0.72, 4, w / 2, h * 0.72, w * 0.62);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,240,200,.6)');
      g.addColorStop(1, 'rgba(255,220,150,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
    const bandTex = this._tex(128, 64, (c, w, h) => {
      c.fillStyle = 'rgba(255,255,255,0)';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 26; i++) {
        const x = (i / 26) * w;
        c.globalAlpha = 0.25 + Math.random() * 0.55;
        c.fillStyle = '#ffffff';
        c.fillRect(x, Math.random() * h * 0.7, 2 + Math.random() * 5, h * 0.3);
      }
      c.globalAlpha = 0.55;
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(230,246,255,.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    this._keep(quad, null);
    this.fxFlare = this._fxMesh(quad, flareTex, THREE.AdditiveBlending);
    this.fxBand = this._fxMesh(quad, bandTex, THREE.AdditiveBlending);

    // tidal wave: a plane with a baked crest, so it reads as a wall of water
    const waveGeo = new THREE.PlaneGeometry(1, 1, 18, 4);
    const wp = waveGeo.attributes.position;
    for (let i = 0; i < wp.count; i++) {
      const u = wp.getX(i) + 0.5, v = wp.getY(i) + 0.5;
      wp.setZ(i, Math.sin(u * Math.PI) * 0.22 + v * 0.06);
    }
    waveGeo.computeVertexNormals();
    this._keep(waveGeo, null);
    const waveMat = new THREE.MeshBasicMaterial({
      color: 0x7fd0f0, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.fxWave = new THREE.Mesh(waveGeo, waveMat);
    this.fxWave.visible = false;
    this.fxWave.frustumCulled = false;
    this.scene.add(this.fxWave);
    this._mats.push(waveMat);

    const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
    this._keep(pillarGeo, null);
    const pillarMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.fxPillar = new THREE.Mesh(pillarGeo, pillarMat);
    this.fxPillar.visible = false;
    this.fxPillar.frustumCulled = false;
    this.scene.add(this.fxPillar);
    this._mats.push(pillarMat);
  }

  _fxMesh(geo, tex, blending) {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.frustumCulled = false;
    this.scene.add(m);
    this._mats.push(mat);
    return m;
  }

  // ---- layout -------------------------------------------------------------
  resize(w, h) {
    if (!this.ok || w < 4 || h < 4) return;
    this.vw = w;
    this.vh = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this._homeCamera();
    this._fitTable();
  }

  /** Park the camera at its resting pose: every anchor is measured from there,
   *  so shake and the finish cam never drag the layout around with them. */
  _homeCamera() {
    this.camera.position.copy(this.camHome);
    this.camera.lookAt(this.lookHome);
    this.camera.updateMatrixWorld(true);
  }

  /** Screen pixel -> the point on the arena plane under it. */
  worldAt(x, y, out) {
    if (!this.vw || !this.vh) return null;
    this._ndc.set((x / this.vw) * 2 - 1, -(y / this.vh) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    return this._ray.ray.intersectPlane(this._plane, out || new THREE.Vector3());
  }

  /** World units per screen pixel at a point (for pixel-exact model sizing). */
  pxScale(p) {
    this.camera.getWorldDirection(this._tmpC);
    const dist = Math.max(1, this._tmpB.copy(p).sub(this.camera.position).dot(this._tmpC));
    return (2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist) / this.vh;
  }

  /**
   * Re-measure every anchor off its DOM box. The bottom edge of a box is where
   * the model's feet go, and the box height is how tall it should look, so the
   * diorama tracks the responsive board instead of guessing at it.
   */
  measure(refs, wrapRect) {
    if (!this.ok || !this.vw || this.finishRun) return;
    this._homeCamera();
    const put = (key, el, fill, foot = 1) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cx = r.left - wrapRect.left + r.width / 2;
      const by = r.top - wrapRect.top + r.height * foot;
      const p = this.worldAt(cx, by, new THREE.Vector3());
      if (!p) return;
      const prev = this.anchors.get(key);
      const px = r.height * fill;
      if (prev) { prev.p.copy(p); prev.px = px; prev.scale = this.pxScale(p) * px; prev.w = r.width; }
      else this.anchors.set(key, { p, px, scale: this.pxScale(p) * px, w: r.width });
    };
    for (const side of [0, 1]) {
      const list = refs.slotEls[side] || [];
      for (let i = 0; i < BOARD_SLOTS; i++) put(`s${side}_${i}`, list[i], 1.02);
      put(`b${side}`, refs.bustEls[side], 1.15, 0.66);
    }
  }

  /** The board region the arena slab has to cover (CSS px, wrap-relative). */
  setBoard(rect) {
    const b = this.board;
    if (b && Math.abs(b.y - rect.y) < 2 && Math.abs(b.h - rect.h) < 2
      && Math.abs(b.w - rect.w) < 2) return;
    this._homeCamera();
    this._fitTable(rect);
  }

  anchor(key) { return this.anchors.get(key); }
  slotAnchor(side, slot) { return this.anchors.get(`s${side}_${slot}`); }
  bustAnchor(side) { return this.anchors.get(`b${side}`); }

  // ---- busts --------------------------------------------------------------
  addBust(side, cfg) {
    if (!this.ok) return;
    const g = buildBust(cfg);
    const hat = buildHat(cfg && cfg.hat);
    if (hat) g.userData.hatAnchor.add(hat);
    g.userData.pose = { ...BUST_POSE.idle };
    g.userData.want = { ...BUST_POSE.idle };
    g.userData.flinch = 0;
    g.userData.cheer = 0;
    g.userData.hpFrac = 1;
    g.userData.seed = Math.random() * 9;
    this.scene.add(g);
    if (this.busts[side]) { this.scene.remove(this.busts[side]); freeBust(this.busts[side]); }
    this.busts[side] = g;
  }

  setBustExpr(side, expr) {
    const b = this.busts[side];
    if (!b) return;
    const pose = BUST_POSE[expr] || BUST_POSE.idle;
    b.userData.want = pose;
  }

  setBustHp(side, frac) {
    const b = this.busts[side];
    if (b) b.userData.hpFrac = Math.max(0, Math.min(1, frac));
  }

  flinchBust(side, power) {
    const b = this.busts[side];
    if (!b) return;
    b.userData.flinch = Math.min(1, 0.35 + power * 0.09);
  }

  cheerBust(side) {
    const b = this.busts[side];
    if (b) b.userData.cheer = 2600;
  }

  // ---- critters -----------------------------------------------------------
  spawn(uid, cardId, side, slot, instant) {
    if (!this.ok || this.crit.has(uid)) return null;
    const def = CARDS[cardId] || CARDS.pebble_pal;
    let rig = null;
    try {
      const c = buildCritter(cardId);
      if (c && c.group && c.group.isObject3D && typeof c.update === 'function') rig = c;
    } catch (err) {
      console.warn('[cards] critter build failed, using the local cast for', cardId, err);
    }
    const model = rig ? rig.group : buildFallbackCritter(cardId);
    if (rig) {
      rig.speed = 1 / (this.speed || 1);
      // the stage already draws a shadow under every slot: two would just smudge
      const blob = model.getObjectByName('blob');
      if (blob) blob.visible = false;
    }
    const group = new THREE.Group();
    group.add(model);
    this.scene.add(group);
    const e = {
      uid, id: cardId, side, slot, el: def.el, group, model, rig,
      // rigged models keep their authored size relative to a 1.3-unit reference,
      // so the Great Ancient really does tower over a Sunny Pup
      ref: rig ? 1.16 : 0.95,
      phase: instant ? 'idle' : 'spawn', t: 0, bob: Math.random() * 7,
      hurtT: 0, tint: 0, atk: null, cheer: 0, scale: 1, koMs: 0,
    };
    this.crit.set(uid, e);
    this._placeCritter(e, true);
    if (!instant) {
      const a = this.slotAnchor(side, slot);
      if (a) {
        this.beam(a.p, EL3[def.el].light, a.scale * 2.6);
        this.ring(a.p, EL3[def.el].light, this.d(420), 0.6, 3.2);
        this.emit(a.p, EL3[def.el].mote, 22, { speed: 3.4, up: 3.4, ttl: 620, size: 0.16, gravity: 5 });
      }
      group.scale.setScalar(0.001);
    }
    return e;
  }

  slam(side, slot) {
    const a = this.slotAnchor(side, slot);
    if (!a) return;
    this.ring(a.p, 0xd9c9a4, this.d(340), 0.4, 2.6);
    this.emit(a.p, 0xd9c9a4, 14, { speed: 4.2, up: 1.2, ttl: 460, size: 0.14, gravity: 7, flat: true });
    this.kick(0.5);
  }

  moveTo(uid, side, slot) {
    const e = this.crit.get(uid);
    if (e) { e.side = side; e.slot = slot; }
  }

  crouch(uid) {
    const e = this.crit.get(uid);
    if (!e || e.phase === 'ko') return;
    if (e.phase === 'spawn') return;
    e.phase = 'crouch';
    e.t = 0;
  }

  /** Leap at a target. `onImpact` fires on the frame the blow lands. */
  strike(uid, targetPos, onImpact, onDone) {
    const e = this.crit.get(uid);
    if (!e) { if (onImpact) onImpact(); if (onDone) onDone(); return 0; }
    const home = this._homeOf(e);
    const to = this._tmpA.copy(targetPos).sub(home);
    const len = to.length() || 1;
    // stop a full body-width short: 0.9 landed the attacker ON the victim
    to.multiplyScalar(Math.max(0, (len - e.scale * 1.35)) / len);
    e.atk = {
      from: home.clone(),
      to: home.clone().add(to),
      arc: Math.max(1, len * 0.22) + e.scale * 0.5,
      yaw: Math.atan2(to.x, to.z),
      onImpact, onDone, fired: false,
    };
    e.phase = 'leap';
    e.t = 0;
    if (e.rig) { try { e.rig.play('attack'); } catch { /* the rig can sit this one out */ } }
    return this.d(DUR.crouch + DUR.leap);
  }

  hurtCritter(uid, power) {
    const e = this.crit.get(uid);
    if (!e || e.phase === 'ko') return;
    e.hurtT = 1;
    // the rig's fur material is shared across every critter, so only the local
    // fallback (which owns its material) gets the red flush
    if (!e.rig) e.tint = Math.min(1, 0.5 + power * 0.08);
    else { try { e.rig.play('hurt'); } catch { /* pose optional */ } }
    const a = this.slotAnchor(e.side, e.slot);
    if (a) this.emit(this._tmpA.copy(a.p).setY(a.p.y + e.scale * 0.5), 0xff9a7a, 8, { speed: 3, up: 2.4, ttl: 380, size: 0.13, gravity: 6 });
  }

  koCritter(uid) {
    const e = this.crit.get(uid);
    if (!e || e.phase === 'ko') return 0;
    e.phase = 'ko';
    e.t = 0;
    e.atk = null;
    let ms = this.d(DUR.koCrack + DUR.koPause + DUR.koShatter);
    if (e.rig) {
      try {
        const secs = e.rig.play('ko');
        if (secs > 0) ms = secs * 1000;
      } catch { /* fall back to the stage's own collapse */ }
    }
    e.koMs = ms;
    return ms;
  }

  removeCritter(uid) {
    const e = this.crit.get(uid);
    if (!e) return;
    this.crit.delete(uid);
    this.scene.remove(e.group);
    if (e.rig) { try { e.rig.dispose(); } catch { /* the factory refcounts its own bundles */ } }
    else if (e.model) freeModel(e.model);
    e.group.clear();
  }

  has(uid) { return this.crit.has(uid); }

  cheerAll(side) {
    for (const e of this.crit.values()) {
      if (e.side !== side || e.phase === 'ko') continue;
      e.cheer = 2600;
      if (e.rig) { try { e.rig.play('cheer'); } catch { /* optional */ } }
    }
  }

  // ---- effects ------------------------------------------------------------
  ring(p, color, ttl, r0, r1) {
    if (!this.ok) return;
    const slot = this.rings.find((r) => !r.m.visible) || this.rings[0];
    slot.m.visible = true;
    slot.m.position.copy(p);
    slot.m.position.y += 0.06;
    slot.m.material.color.setHex(color);
    slot.t = 0;
    slot.ttl = ttl;
    slot.r0 = r0;
    slot.r1 = r1;
  }

  beam(p, color, height) {
    if (!this.ok) return;
    const slot = this.beams.find((b) => !b.m.visible) || this.beams[0];
    slot.m.visible = true;
    slot.m.material.color.setHex(color);
    slot.m.position.copy(p);
    slot.h = height;
    slot.t = 0;
    slot.ttl = this.d(DUR.beam + DUR.grow);
  }

  kick(mag) {
    if (this.reduced) return;
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeT = 0;
  }

  hitStop(ms) {
    if (this.reduced) return;
    this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + ms);
  }

  setMood(el) {
    const c = EL3[el] || EL3.neutral;
    this.moodWant.setHex(c.rim);
  }

  flashSlot(side, slot, color) {
    const i = side * 4 + slot;
    if (i < 0 || i > 7 || !this.ringFlash) return;
    this.ringFlash[i] = 1;
    this.ringFlashCol[i] = color;
  }

  setSlotGlow(side, slot, on) {
    const i = side * 4 + slot;
    if (i >= 0 && i < 8 && this.ringGlow) this.ringGlow[i] = on ? 1 : 0;
  }

  emit(p, color, n, opts = {}) {
    if (!this.ok) return;
    const speed = opts.speed ?? 3;
    const up = opts.up ?? 2;
    const ttl = this.d(opts.ttl ?? 600);
    const size = opts.size ?? 0.14;
    const grav = opts.gravity ?? 6;
    this._col.setHex(color);
    for (let k = 0; k < n; k++) {
      const i = this.pNext;
      this.pNext = (this.pNext + 1) % PMAX;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      this.pPos[i * 3] = p.x + Math.cos(a) * r * (opts.spread ?? 0.3);
      this.pPos[i * 3 + 1] = p.y + (opts.y0 ?? 0.2) + (opts.flat ? 0 : Math.random() * 0.4);
      this.pPos[i * 3 + 2] = p.z + Math.sin(a) * r * (opts.spread ?? 0.3);
      this.pVel[i * 3] = Math.cos(a) * speed * (0.4 + Math.random() * 0.8);
      this.pVel[i * 3 + 1] = up * (0.35 + Math.random());
      this.pVel[i * 3 + 2] = Math.sin(a) * speed * (0.4 + Math.random() * 0.8);
      this.pLife[i] = 0;
      this.pTtl[i] = ttl * (0.7 + Math.random() * 0.6);
      this.pSize[i] = size * (0.7 + Math.random() * 0.7);
      this.pStretch[i] = opts.stretch ?? 1;
      this.pGrav[i] = grav;
      this.parts.setColorAt(i, this._col);
    }
    if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
    this.pLive = Math.min(PMAX, this.pLive + n);
    this.parts.visible = true;
  }

  /**
   * One readable silhouette per spell shape. Everything here is <= 1.2s and
   * lives entirely on pooled meshes, so a spell costs no allocations.
   */
  spell(kind, el, at) {
    if (!this.ok) return this.d(DUR.spell);
    const c = EL3[el] || EL3.neutral;
    const T = this.tableSize || { cx: 0, cz: 0, w: 20, d: 16 };
    this.setMood(el);
    if (kind === 'flare') {
      this.fx.push({ m: this.fxFlare, kind, t: 0, ttl: this.d(DUR.spell), T });
      this.fxFlare.visible = true;
      this.fxFlare.material.color.setHex(c.light);
      this.fxFlare.scale.set(T.w * 0.75, 1, T.d * 1.15);
      this.emit(new THREE.Vector3(T.cx, 0.2, T.cz), c.mote, 26, { speed: 5, up: 3.6, ttl: 900, size: 0.16, gravity: 2, spread: 6 });
    } else if (kind === 'blizzard') {
      this.fx.push({ m: this.fxBand, kind, t: 0, ttl: this.d(DUR.spell), T });
      this.fxBand.visible = true;
      this.fxBand.material.color.setHex(c.light);
      this.fxBand.scale.set(T.w * 1.05, 1, T.d * 0.34);
    } else if (kind === 'wave') {
      this.fx.push({ m: this.fxWave, kind, t: 0, ttl: this.d(DUR.spell), T });
      this.fxWave.visible = true;
      this.fxWave.material.color.setHex(c.light);
      this.fxWave.scale.set(T.w * 1.05, 3.2, 1);
      this.fxWave.rotation.set(-0.35, 0, 0);
    } else {
      const p = at || new THREE.Vector3(T.cx, 0, T.cz);
      this.fx.push({ m: this.fxPillar, kind: 'pillar', t: 0, ttl: this.d(DUR.spell * 0.8), T, p: p.clone() });
      this.fxPillar.visible = true;
      this.fxPillar.material.color.setHex(c.light);
      this.emit(p, c.mote, 20, { speed: 1.1, up: 5.2, ttl: 820, size: 0.15, gravity: -1.2, spread: 0.7 });
    }
    return this.d(DUR.spell);
  }

  /** Snow spells drop icicles into the slots they are about to hit. */
  icicles(points) {
    for (const p of points) {
      this.emit(this._tmpA.copy(p).setY(p.y + 3.4), 0xdff3ff, 5,
        { speed: 0.3, up: -7, ttl: 420, size: 0.2, gravity: 12, stretch: 3.2, spread: 0.35, y0: 0 });
    }
  }

  finishCam(loserSide, ms) {
    if (!this.ok) return;
    const b = this.busts[loserSide];
    this.pinBusts = false;
    const to = new THREE.Vector3();
    if (b) to.copy(b.position);
    else to.set(0, 1, 0);
    const eye = to.clone();
    eye.y += 1.8;
    eye.z += 4.6;
    eye.x += 1.2;
    this.finishRun = {
      t: 0, ttl: ms,
      from: this.camera.position.clone(), to: eye,
      lookFrom: this.lookHome.clone(), lookTo: to.clone().setY(to.y + 0.9),
    };
    this.kick(1);
  }

  // ---- per-frame ----------------------------------------------------------
  _homeOf(e) {
    const a = this.slotAnchor(e.side, e.slot);
    return a ? a.p : this._tmpB.set(0, 0, 0);
  }

  _placeCritter(e, snap) {
    const a = this.slotAnchor(e.side, e.slot);
    if (!a) return;
    e.scale = a.scale / e.ref;
    if (snap) {
      e.group.position.copy(a.p);
      e.group.scale.setScalar(e.scale);
    }
  }

  update(dtReal) {
    if (!this.ok) return;
    const nowReal = performance.now();
    const frozen = nowReal < this.hitStopUntil;
    const slow = this.finishRun ? 0.38 : 1;
    const dt = frozen ? 0 : Math.min(64, dtReal) * slow;
    this.now += dt;
    const s = dt / 1000;

    this.mood.lerp(this.moodWant, Math.min(1, s * 3));
    if (this.rim) this.rim.color.copy(this.mood);

    this._updateCritters(dt, s);
    this._updateBusts(dt, s);
    this._updateRings(dt);
    this._updateBeams(dt);
    this._updateSpells(dt);
    this._updateParticles(s);
    this._updateSlots(dt);
    this._updateCamera(dtReal, s);
  }

  _updateCritters(dt, s) {
    for (const e of [...this.crit.values()]) {
      const a = this.slotAnchor(e.side, e.slot);
      if (a) e.scale = a.scale / e.ref;
      const home = a ? a.p : e.group.position;
      e.t += dt;
      // the factory's rig animates itself every frame, overlay or not
      if (e.rig) { try { e.rig.update(s); } catch { e.rig = null; } }
      if (e.phase !== 'ko') {
        e.tint = Math.max(0, e.tint - dt / 240);
        this._tintModel(e);
      }
      let sc = e.scale;
      let y = 0;
      const bobT = this.now / 1000 + e.bob;

      if (e.phase === 'spawn') {
        const wait = this.d(DUR.beam);
        const gr = this.d(DUR.grow);
        if (e.t < wait) {
          sc = 0.001;
        } else {
          const p = Math.min(1, (e.t - wait) / gr);
          const k = p < 0.7 ? (p / 0.7) * 1.18 : 1.18 - ((p - 0.7) / 0.3) * 0.18;
          sc = e.scale * k;
          e.group.rotation.y = (1 - p) * 1.4;
          if (p >= 1) { e.phase = 'idle'; e.t = 0; e.group.rotation.y = 0; }
        }
        e.group.position.copy(home);
      } else if (e.phase === 'crouch') {
        e.group.position.copy(home);
        const p = Math.min(1, e.t / this.d(DUR.crouch));
        y = -0.06 * e.scale * p;
        if (e.rig) e.group.scale.setScalar(e.scale);
        else e.group.scale.set(e.scale * (1 + 0.12 * p), e.scale * (1 - 0.14 * p), e.scale * (1 + 0.12 * p));
        e.group.position.y = home.y + y;
        continue;
      } else if (e.phase === 'leap' && e.atk) {
        const cd = this.d(DUR.crouch), ld = this.d(DUR.leap);
        if (e.t < cd) {
          const p = e.t / cd;
          e.group.position.copy(e.atk.from);
          e.group.position.y += -0.08 * e.scale * p;
          if (e.rig) e.group.scale.setScalar(e.scale);
          else e.group.scale.set(e.scale * (1 + 0.14 * p), e.scale * (1 - 0.16 * p), e.scale * (1 + 0.14 * p));
          e.group.rotation.y = e.atk.yaw * p * 0.5;
          continue;
        }
        const p = Math.min(1, (e.t - cd) / ld);
        e.group.position.lerpVectors(e.atk.from, e.atk.to, p);
        e.group.position.y += Math.sin(p * Math.PI) * e.atk.arc;
        e.group.rotation.y = e.atk.yaw;
        e.group.scale.setScalar(e.scale * (1 + 0.1 * Math.sin(p * Math.PI)));
        if (p >= 1) {
          if (!e.atk.fired) {
            e.atk.fired = true;
            if (e.atk.onImpact) { const f = e.atk.onImpact; e.atk.onImpact = null; f(); }
          }
          e.phase = 'return';
          e.t = 0;
        }
        continue;
      } else if (e.phase === 'return' && e.atk) {
        const p = Math.min(1, e.t / this.d(DUR.hop));
        e.group.position.lerpVectors(e.atk.to, home, p);
        e.group.position.y += Math.sin(p * Math.PI) * e.atk.arc * 0.35;
        e.group.rotation.y = e.atk.yaw * (1 - p);
        e.group.scale.setScalar(e.scale);
        if (p >= 1) {
          const done = e.atk.onDone;
          e.atk = null;
          e.phase = 'idle';
          e.t = 0;
          if (done) done();
        }
        continue;
      } else if (e.phase === 'ko') {
        const total = e.koMs || this.d(DUR.koCrack + DUR.koPause + DUR.koShatter);
        const p = Math.min(1, e.t / total);
        e.group.position.copy(home);
        e.group.rotation.y = 0;
        if (e.rig) {
          // the rig cracks, trembles and collapses on its own clock
          e.group.scale.setScalar(e.scale);
        } else {
          const c1 = this.d(DUR.koCrack), c2 = this.d(DUR.koPause);
          if (e.t < c1) {
            e.tint = 1;
            const j = this.reduced ? 0 : (1 - e.t / c1) * 0.09 * e.scale;
            e.group.position.set(home.x + (Math.random() - 0.5) * j * 4, home.y, home.z + (Math.random() - 0.5) * j * 4);
            e.group.scale.setScalar(e.scale * (1 - (e.t / c1) * 0.06));
          } else if (e.t < c1 + c2) {
            e.group.scale.setScalar(e.scale * 0.94);
          } else {
            const q = Math.min(1, (e.t - c1 - c2) / this.d(DUR.koShatter));
            e.group.position.y += q * e.scale * 0.5;
            e.group.scale.setScalar(e.scale * (1 - q) * (1 - q));
            e.group.rotation.y = q * 2.4;
          }
          this._tintModel(e);
        }
        // the shatter is the stage's: one pooled particle system, element motes
        if (!e.burst && p >= (e.rig ? 0.62 : 0.42)) {
          e.burst = true;
          const col = EL3[e.el] || EL3.neutral;
          this.emit(this._tmpA.copy(home).setY(home.y + e.scale * 0.5), col.mote, 26,
            { speed: 2.6, up: 4.2, ttl: 900, size: 0.17, gravity: -0.8, spread: 0.5 });
          this.ring(home, col.light, this.d(420), 0.5, 3);
          this.sfx('splash');
        }
        if (p >= 1) { this.removeCritter(e.uid); }
        continue;
      }

      // idle life: breathe, bob, shuffle, and cheer when the duel is won
      if (e.phase === 'idle' || e.phase === 'spawn') {
        e.group.position.copy(home);
        if (e.cheer > 0) {
          e.cheer -= dt;
          const hop = Math.abs(Math.sin(bobT * 7));
          y = hop * e.scale * 0.34;
          e.group.rotation.y = Math.sin(bobT * 5) * 0.35;
          sc = e.scale * (1 + 0.06 * Math.sin(bobT * 14));
        } else if (e.phase === 'idle') {
          y = Math.sin(bobT * 1.9) * e.scale * 0.03;
          e.group.rotation.y = Math.sin(bobT * 0.7) * 0.14;
          sc = e.scale * (1 + 0.014 * Math.sin(bobT * 3.1));
        }
        if (e.hurtT > 0) {
          e.hurtT = Math.max(0, e.hurtT - dt / 260);
          const k = e.hurtT;
          e.group.position.z += (e.side === 0 ? 1 : -1) * k * e.scale * 0.22;
          if (!this.reduced) e.group.position.x += Math.sin(this.now * 0.08) * k * e.scale * 0.1;
        }
      }
      e.group.position.y = home.y + y;
      if (typeof sc === 'number') e.group.scale.setScalar(sc);
    }
  }

  _tintModel(e) {
    const mesh = e.model && e.model.userData && e.model.userData.solid;
    if (!mesh || !mesh.material || !mesh.material.color) return;
    const k = Math.min(1, e.tint);
    // a knockout blows out to white (it cracks); a hit flushes red
    if (e.phase === 'ko') mesh.material.color.setRGB(1 + k * 0.9, 1 + k * 0.8, 1 + k * 0.7);
    else mesh.material.color.setRGB(1 + k * 0.7, 1 - k * 0.45, 1 - k * 0.5);
  }

  _updateBusts(dt, s) {
    for (const side of [0, 1]) {
      const b = this.busts[side];
      if (!b) continue;
      const a = this.bustAnchor(side);
      if (a && this.pinBusts) {
        b.position.copy(a.p);
        b.scale.setScalar(a.scale / (b.userData.height || 1.5));
      }
      const u = b.userData;
      const k = Math.min(1, s * 9);
      for (const key of ['brow', 'browY', 'eye', 'tilt', 'nod']) {
        u.pose[key] += ((u.want[key] ?? 0) - u.pose[key]) * k;
      }
      u.flinch = Math.max(0, u.flinch - dt / 320);
      const droop = (1 - u.hpFrac) * 0.34;
      const t = this.now / 1000 + u.seed;
      let bounce = 0;
      if (u.cheer > 0) {
        u.cheer -= dt;
        bounce = Math.abs(Math.sin(t * 6.5)) * 0.16;
      }
      const breathe = Math.sin(t * 1.6) * 0.012;
      b.userData.headPivot.rotation.set(
        0.42 + u.pose.nod - droop + (this.reduced ? 0 : -u.flinch * 0.4) + bounce * 0.5,
        u.pose.tilt * 0.6,
        u.pose.tilt * 0.5,
      );
      b.userData.headPivot.position.y = 0.78 + breathe + bounce - droop * 0.1;
      b.userData.eyes.scale.set(1, Math.max(0.08, u.pose.eye), 1);
      b.userData.brows.rotation.z = u.pose.brow;
      b.userData.brows.position.y = u.pose.browY;
      b.userData.body.scale.set(1 + u.flinch * 0.05, 1 - u.flinch * 0.07 - droop * 0.08, 1 + u.flinch * 0.05);
      if (!this.reduced && this.pinBusts) {
        b.position.z += u.flinch * 0.24 * (side === 0 ? 1 : -1) * (a ? a.scale * 0.12 : 0.1);
      }
    }
  }

  _updateRings(dt) {
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.t += dt;
      const p = Math.min(1, r.t / r.ttl);
      const sc = r.r0 + (r.r1 - r.r0) * p;
      r.m.scale.set(sc, 1, sc);
      r.m.material.opacity = (1 - p) * 0.9;
      if (p >= 1) { r.m.visible = false; r.m.material.opacity = 0; }
    }
  }

  _updateBeams(dt) {
    for (const b of this.beams) {
      if (!b.m.visible) continue;
      b.t += dt;
      const p = Math.min(1, b.t / b.ttl);
      const grow = Math.min(1, p / 0.35);
      b.m.scale.set(0.5 + 0.3 * (1 - grow), b.h * grow, 0.5 + 0.3 * (1 - grow));
      b.m.position.y = (b.h * grow) / 2;
      b.m.material.opacity = p < 0.35 ? 0.85 * grow : 0.85 * (1 - (p - 0.35) / 0.65);
      if (p >= 1) { b.m.visible = false; b.m.material.opacity = 0; }
    }
  }

  _updateSpells(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      const p = Math.min(1, f.t / f.ttl);
      const fade = p < 0.18 ? p / 0.18 : (p > 0.72 ? (1 - p) / 0.28 : 1);
      const T = f.T;
      if (f.kind === 'flare') {
        f.m.position.set(T.cx, 0.12, T.cz + T.d * (0.55 - p * 1.3));
        f.m.material.opacity = fade * 0.9;
      } else if (f.kind === 'blizzard') {
        f.m.position.set(T.cx, 0.16, T.cz + T.d * (0.6 - p * 1.35));
        f.m.material.opacity = fade * 0.95;
      } else if (f.kind === 'wave') {
        const z = T.cz + T.d * (0.62 - p * 1.32);
        f.m.position.set(T.cx, 0.9, z);
        f.m.material.opacity = fade * 0.72;
      } else {
        const h = 7 * Math.min(1, p / 0.3);
        f.m.position.copy(f.p);
        f.m.position.y += h / 2;
        f.m.scale.set(1.1, h, 1.1);
        f.m.material.opacity = fade * 0.7;
      }
      if (p >= 1) {
        f.m.visible = false;
        f.m.material.opacity = 0;
        this.fx.splice(i, 1);
      }
    }
  }

  _updateParticles(s) {
    if (!this.pLive) { if (this.parts.visible) this.parts.visible = false; return; }
    let live = 0;
    for (let i = 0; i < PMAX; i++) {
      if (this.pTtl[i] <= 0) continue;
      this.pLife[i] += s * 1000;
      const p = this.pLife[i] / this.pTtl[i];
      if (p >= 1) {
        this.pTtl[i] = 0;
        this._m4.makeScale(0, 0, 0);
        this.parts.setMatrixAt(i, this._m4);
        continue;
      }
      live += 1;
      this.pVel[i * 3 + 1] -= this.pGrav[i] * s;
      this.pPos[i * 3] += this.pVel[i * 3] * s;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * s;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * s;
      const sc = this.pSize[i] * (1 - p * p);
      this._tmpA.set(this.pPos[i * 3], this.pPos[i * 3 + 1], this.pPos[i * 3 + 2]);
      this._scl.set(sc, sc * this.pStretch[i], sc);
      this._quat.setFromAxisAngle(UP_AXIS, this.pLife[i] * 0.004);
      this._m4.compose(this._tmpA, this._quat, this._scl);
      this.parts.setMatrixAt(i, this._m4);
    }
    this.pLive = live;
    this.parts.instanceMatrix.needsUpdate = true;
    this.parts.visible = live > 0;
  }

  _updateSlots(dt) {
    if (!this.ringIM) return;
    for (let i = 0; i < 8; i++) {
      const side = i >> 2, slot = i & 3;
      const a = this.slotAnchor(side, slot);
      if (!a) {
        this._m4.makeScale(0, 0, 0);
        this.ringIM.setMatrixAt(i, this._m4);
        this.shadowIM.setMatrixAt(i, this._m4);
        continue;
      }
      this.ringFlash[i] = Math.max(0, this.ringFlash[i] - dt / 320);
      const base = a.scale * 0.44;
      const pulse = this.ringGlow[i] ? 1 + Math.sin(this.now / 190) * 0.05 : 1;
      this._tmpA.copy(a.p).setY(a.p.y + 0.035);
      this._quat.identity();
      this._scl.set(base * pulse, 1, base * pulse);
      this._m4.compose(this._tmpA, this._quat, this._scl);
      this.ringIM.setMatrixAt(i, this._m4);
      this._tmpA.setY(a.p.y + 0.02);
      this._scl.set(base * 1.9, 1, base * 1.9);
      this._m4.compose(this._tmpA, this._quat, this._scl);
      this.shadowIM.setMatrixAt(i, this._m4);
      const f = this.ringFlash[i];
      if (f > 0) this._col.setHex(this.ringFlashCol[i]).multiplyScalar(0.4 + f);
      else if (this.ringGlow[i]) this._col.setHex(0xf2b64a).multiplyScalar(0.95);
      else this._col.setHex(0x6a5a38);
      this.ringIM.setColorAt(i, this._col);
    }
    this.ringIM.instanceMatrix.needsUpdate = true;
    this.shadowIM.instanceMatrix.needsUpdate = true;
    if (this.ringIM.instanceColor) this.ringIM.instanceColor.needsUpdate = true;
  }

  _updateCamera(dtReal, s) {
    if (this.finishRun) {
      const f = this.finishRun;
      f.t += dtReal;
      const p = Math.min(1, f.t / f.ttl);
      const k = 1 - Math.pow(1 - p, 3);
      this.camera.position.lerpVectors(f.from, f.to, k);
      this._tmpA.lerpVectors(f.lookFrom, f.lookTo, k);
      this.camera.lookAt(this._tmpA);
      return;
    }
    this.camera.position.copy(this.camHome);
    if (this.shakeMag > 0.001 && !this.reduced) {
      this.shakeT += dtReal;
      const decay = Math.max(0, 1 - this.shakeT / 320);
      this.shakeMag *= Math.max(0, 1 - s * 3.6);
      const m = this.shakeMag * decay * 0.55;
      this.camera.position.x += Math.sin(this.shakeT * 0.09) * m;
      this.camera.position.y += Math.sin(this.shakeT * 0.14 + 1.2) * m * 0.7;
      if (decay <= 0) this.shakeMag = 0;
    }
    this.camera.lookAt(this.lookHome);
  }

  render() {
    if (!this.ok) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Debug/verification helper: draw calls in the last frame. */
  drawCalls() { return this.ok ? this.renderer.info.render.calls : 0; }

  dispose() {
    if (!this.renderer) return;
    for (const uid of [...this.crit.keys()]) this.removeCritter(uid);
    for (const side of [0, 1]) {
      if (this.busts[side]) { this.scene.remove(this.busts[side]); freeBust(this.busts[side]); this.busts[side] = null; }
    }
    if (this.tableMesh) this.tableMesh.geometry.dispose();
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    for (const t of this._texs) t.dispose();
    this._geos.length = 0;
    this._mats.length = 0;
    this._texs.length = 0;
    this.scene.clear();
    this.renderer.dispose();
    try { this.renderer.forceContextLoss(); } catch { /* not every context supports it */ }
    this.renderer.domElement?.remove();
    this.renderer = null;
    this.ok = false;
    this.crit.clear();
    this.anchors.clear();
    this.rings.length = 0;
    this.beams.length = 0;
    this.fx.length = 0;
  }
}

/**
 * The show's own little synth. The shared sfx bank (src/core/audio.js) covers
 * clicks, thuds and sparkles; what a Yu-Gi-Oh moment needs on top of that is a
 * summon stinger, an element-tinted impact and a finish sting, so those are
 * built here from a handful of oscillators. Created lazily on the first sound
 * (i.e. after a click, so no autoplay warning) and closed on unmount.
 */
class Stinger {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.master = null;
    this.live = new Set();
  }

  _ctx() {
    if (this.ctx) return this.ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { this.ctx = new AC(); } catch { return null; }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.16;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  _tone({ type = 'sine', f0, f1, dur = 0.2, vol = 0.2, delay = 0, attack = 0.008 }) {
    const ctx = this._ctx();
    if (!ctx || !this.master) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* it will wake on the next gesture */ } }
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0004, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    this.live.add(osc);
    osc.onended = () => {
      this.live.delete(osc);
      try { osc.disconnect(); g.disconnect(); } catch { /* already torn down */ }
    };
  }

  /** Sun is bright and major, snow is glassy and high, sea is round and low. */
  _root(el) {
    return el === 'sun' ? 392 : el === 'snow' ? 587 : el === 'sea' ? 261 : 330;
  }

  play(kind, el, power = 1) {
    if (this.game?.audio?.muted) return;
    const r = this._root(el);
    if (kind === 'summon') {
      this._tone({ type: 'triangle', f0: r * 0.5, f1: r, dur: 0.16, vol: 0.16 });
      this._tone({ type: 'triangle', f0: r, f1: r * 1.5, dur: 0.2, vol: 0.14, delay: 0.09 });
      this._tone({ type: 'sine', f0: r * 2, f1: r * 3, dur: 0.34, vol: 0.09, delay: 0.17 });
    } else if (kind === 'slam') {
      this._tone({ type: 'sine', f0: 150, f1: 42, dur: 0.19, vol: 0.34, attack: 0.004 });
      this._tone({ type: 'square', f0: 90, f1: 38, dur: 0.09, vol: 0.09, attack: 0.003 });
    } else if (kind === 'impact') {
      const punch = Math.min(1.6, 0.7 + power * 0.11);
      this._tone({ type: 'square', f0: r * 1.5, f1: r * 0.55, dur: 0.075, vol: 0.11 * punch, attack: 0.002 });
      this._tone({ type: 'sine', f0: 190, f1: 46, dur: 0.16 * punch, vol: 0.3, attack: 0.003 });
    } else if (kind === 'tri') {
      this._tone({ type: 'triangle', f0: r, dur: 0.1, vol: 0.16 });
      this._tone({ type: 'triangle', f0: r * 1.26, dur: 0.1, vol: 0.15, delay: 0.07 });
      this._tone({ type: 'triangle', f0: r * 1.5, f1: r * 2, dur: 0.3, vol: 0.15, delay: 0.14 });
    } else if (kind === 'spell') {
      if (el === 'sea') {
        this._tone({ type: 'sine', f0: r * 2.2, f1: r * 0.7, dur: 0.6, vol: 0.14, attack: 0.09 });
      } else if (el === 'snow') {
        this._tone({ type: 'sine', f0: r * 2, f1: r * 2.6, dur: 0.45, vol: 0.08, attack: 0.05 });
        this._tone({ type: 'triangle', f0: r * 3, f1: r * 3.9, dur: 0.4, vol: 0.05, delay: 0.08 });
      } else {
        this._tone({ type: 'triangle', f0: r * 0.75, f1: r * 2, dur: 0.42, vol: 0.13, attack: 0.02 });
      }
    } else if (kind === 'finish') {
      const win = el === 'sun';
      const base = win ? 262 : 220;
      const steps = win ? [1, 1.26, 1.5, 2] : [1, 0.84, 0.75, 0.5];
      steps.forEach((k, i) => this._tone({
        type: 'triangle', f0: base * k, dur: i === steps.length - 1 ? 0.75 : 0.19,
        vol: 0.17, delay: i * 0.13,
      }));
    }
  }

  dispose() {
    for (const osc of this.live) { try { osc.stop(); osc.disconnect(); } catch { /* already stopped */ } }
    this.live.clear();
    try { this.master?.disconnect(); } catch { /* already gone */ }
    this.master = null;
    if (this.ctx) { try { this.ctx.close(); } catch { /* closing twice is fine */ } }
    this.ctx = null;
  }
}

// ===========================================================================
// STYLE
// ===========================================================================
const STYLE = `
.mg-cards-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#3a2a1c;user-select:none;
  -webkit-user-select:none;cursor:default;
  --bw:clamp(66px,12.4vh,142px);--bh:calc(var(--bw)*1.34);
  --hw:clamp(70px,12.2vh,138px);--hh:calc(var(--hw)*1.38);}
.mg-cards-root *{box-sizing:border-box;}
.mg-cards-root.mg-cards-quake{animation:mg-cards-quake .4s ease;}
.mg-cards-root.mg-cards-calm .mg-cards-card,.mg-cards-root.mg-cards-calm .mg-cards-capy{animation:none !important;}
/* the diorama sits under every piece of board furniture and over the backdrop */
.mg-cards-stage{position:absolute;inset:0;z-index:2;display:block;pointer-events:none;}
@keyframes mg-cards-quake{0%,100%{transform:translate(0,0)}20%{transform:translate(-8px,4px)}
  40%{transform:translate(7px,-5px)}60%{transform:translate(-5px,-3px)}80%{transform:translate(4px,3px)}}

/* ---- den backdrop ---- */
.mg-cards-bg{position:absolute;inset:0;
  background:
    radial-gradient(ellipse 55% 40% at 50% 8%, rgba(255,232,178,.34), rgba(255,232,178,0) 72%),
    repeating-linear-gradient(90deg, rgba(60,34,10,.16) 0 4px, rgba(0,0,0,0) 4px 96px),
    linear-gradient(180deg,#7d5233 0%,#5d3b23 60%,#452b19 100%);}
.mg-cards-felt{position:absolute;inset:0;z-index:3;pointer-events:none;
  background:radial-gradient(ellipse 78% 66% at 50% 52%, rgba(0,0,0,0) 42%, rgba(12,8,4,.5) 100%);}
/* No WebGL context: the diorama cannot run, so the v1 felt board comes back and
   the duel plays on exactly as it always did, minus the show. */
.mg-cards-root.mg-cards-flat .mg-cards-felt{inset:clamp(6px,1.3vh,16px);z-index:1;border-radius:26px;
  border:clamp(6px,1vh,11px) solid #7a4a29;
  background:radial-gradient(ellipse 70% 55% at 50% 46%, #4b7c57 0%, #3a6144 58%, #2c4a35 100%);
  box-shadow:inset 0 0 70px rgba(12,26,16,.55),0 12px 30px rgba(0,0,0,.4);}
.mg-cards-root.mg-cards-flat .mg-cards-bust{display:none;}
.mg-cards-root.mg-cards-flat .mg-cards-slot{background:rgba(16,32,22,.34);border-radius:12px;
  box-shadow:inset 0 0 0 2px rgba(255,246,227,.14);}
.mg-cards-root.mg-cards-flat .mg-cards-slot.mg-cards-can{background:rgba(242,182,74,.22);
  box-shadow:inset 0 0 0 3px #f2b64a,0 0 16px rgba(242,182,74,.45);}
.mg-cards-root.mg-cards-flat .mg-cards-slot::before{display:none;}
.mg-cards-lamp{position:absolute;top:-6%;left:50%;width:46%;height:34%;transform:translateX(-50%);
  background:radial-gradient(ellipse 50% 60% at 50% 0%, rgba(255,226,150,.35), rgba(255,226,150,0) 70%);
  pointer-events:none;}

/* ---- hud ---- */
.mg-cards-hud{position:relative;z-index:8;display:flex;align-items:center;gap:8px;
  padding:8px clamp(10px,2vw,22px);flex-wrap:wrap;}
.mg-cards-chip{background:#fffdf6;border-radius:999px;padding:5px 14px;font-weight:900;font-size:14px;
  box-shadow:0 4px 0 rgba(40,24,10,.35),0 8px 16px rgba(0,0,0,.24);display:flex;align-items:center;gap:7px;}
.mg-cards-chip small{font-size:10px;letter-spacing:.14em;opacity:.55;font-weight:800;}
.mg-cards-title{background:#e8657a;color:#fffdf6;letter-spacing:.12em;}
.mg-cards-tri{gap:4px;padding:4px 12px;}
.mg-cards-tri canvas{display:block;}
.mg-cards-arrow{font-size:15px;font-weight:900;color:#c0ab86;transition:.18s;display:inline-block;}
.mg-cards-arrow.mg-cards-flash{color:#e8657a;transform:scale(1.7);text-shadow:0 0 12px rgba(232,101,122,.8);}
.mg-cards-spacer{flex:1;}
.mg-cards-quit{border:0;background:rgba(28,18,10,.65);color:#fff6e3;font-family:inherit;font-weight:900;
  font-size:12px;letter-spacing:.1em;padding:8px 16px;border-radius:999px;cursor:pointer;transition:.14s;}
.mg-cards-quit:hover{background:#c94a3e;transform:scale(1.06);}
.mg-cards-quit.mg-cards-armed{background:#c94a3e;animation:mg-cards-pulse .9s ease-in-out infinite;}
.mg-cards-hide{display:none !important;}
.mg-cards-clock b{font-variant-numeric:tabular-nums;min-width:34px;text-align:center;}
.mg-cards-clock.mg-cards-low{background:#c94a3e;color:#fff6e3;animation:mg-cards-pulse .9s ease-in-out infinite;}
.mg-cards-clock.mg-cards-low small{opacity:.85;}
.mg-cards-live{background:#4fb3e8;color:#fffdf6;letter-spacing:.12em;}
.mg-cards-live::before{content:"";width:8px;height:8px;border-radius:50%;background:#fffdf6;
  animation:mg-cards-blip 1.4s ease-in-out infinite;}
/* The two match chips must never push the HUD onto a second row: that row is
   stolen from the hand, which is the one thing a duellist cannot play without. */
@media (max-width:820px){
  /* the title and the DEN TABLE badge are decoration; the turn, the clock and
     the way out are not. Drop the decoration before the HUD takes a second row */
  .mg-cards-title,.mg-cards-live,.mg-cards-clock small{display:none;}
  .mg-cards-chip{padding:5px 10px;}
  .mg-cards-tri{padding:4px 8px;gap:3px;}
  .mg-cards-tri canvas{width:16px;height:16px;}
  .mg-cards-arrow{font-size:12px;}
  .mg-cards-quit{padding:7px 12px;}
}
@media (max-height:560px){
  .mg-cards-hud{padding:5px 10px;gap:6px;}
  .mg-cards-chip{padding:4px 11px;font-size:13px;}
}
@keyframes mg-cards-blip{50%{opacity:.25;transform:scale(.7)}}

/* ---- table ---- */
.mg-cards-table{position:relative;z-index:5;flex:1;min-height:0;display:flex;flex-direction:column;
  align-items:center;justify-content:space-between;padding:0 clamp(8px,2vw,26px) clamp(6px,1.4vh,14px);gap:clamp(2px,.7vh,8px);}
.mg-cards-bar{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;}
.mg-cards-capy{display:flex;align-items:flex-end;gap:4px;transition:.16s;}
@keyframes mg-cards-breathe{50%{transform:translateY(-3px) scale(1.02)}}
/* the bust itself is drawn in the diorama: this box only reserves its footprint
   and is what the stage measures to place and size it */
.mg-cards-bust{position:relative;flex:none;}
.mg-cards-bustfoe{width:clamp(64px,11vh,120px);height:clamp(72px,12.5vh,134px);}
.mg-cards-bustme{width:clamp(64px,11vh,120px);height:clamp(72px,12.5vh,134px);}
.mg-cards-bust::after{content:"";position:absolute;inset:-14% -6% -6%;border-radius:50%;
  background:radial-gradient(ellipse at 50% 72%, rgba(242,182,74,.42), rgba(242,182,74,0) 70%);
  opacity:0;transition:opacity .18s;}
.mg-cards-plate{padding:5px 13px;border-radius:999px;background:rgba(30,20,12,.55);
  box-shadow:inset 0 0 0 2px rgba(255,246,227,.16);transition:.16s;}
.mg-cards-capy b{display:block;font-size:13px;color:#fff6e3;letter-spacing:.03em;white-space:nowrap;}
.mg-cards-hp{margin-top:4px;width:clamp(90px,13vw,150px);height:15px;border-radius:999px;
  background:rgba(10,20,14,.55);box-shadow:inset 0 2px 4px rgba(0,0,0,.4);position:relative;overflow:hidden;}
.mg-cards-hp i{position:absolute;inset:0;width:100%;border-radius:999px;background:#7ac74f;
  transition:width .45s cubic-bezier(.2,1.35,.4,1),background .3s;}
.mg-cards-hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:900;color:#fffdf6;text-shadow:0 1px 2px rgba(0,0,0,.55);letter-spacing:.04em;}
.mg-cards-capy.mg-cards-can{cursor:pointer;}
.mg-cards-capy.mg-cards-can .mg-cards-plate{box-shadow:inset 0 0 0 3px #f2b64a,0 0 0 6px rgba(242,182,74,.28);
  animation:mg-cards-pulse 1s ease-in-out infinite;}
.mg-cards-capy.mg-cards-can .mg-cards-bust::after{opacity:1;animation:mg-cards-pulse 1s ease-in-out infinite;}
.mg-cards-capy.mg-cards-hit .mg-cards-plate{animation:mg-cards-shake .4s ease;}
@keyframes mg-cards-shake{0%,100%{transform:translate(0,0)}25%{transform:translate(-7px,2px)}
  55%{transform:translate(6px,-2px)}80%{transform:translate(-3px,1px)}}
@keyframes mg-cards-pulse{50%{transform:scale(1.04)}}

.mg-cards-meta{display:flex;align-items:center;gap:10px;}
.mg-cards-pips{display:flex;gap:4px;flex-wrap:wrap;max-width:152px;}
.mg-cards-pip{width:13px;height:13px;border-radius:50%;background:rgba(12,24,16,.5);
  box-shadow:inset 0 0 0 2px rgba(255,246,227,.24);transition:.2s;}
.mg-cards-pip.mg-cards-full{background:radial-gradient(circle at 35% 30%,#bff0ff,#3aa8e8);
  box-shadow:0 0 8px rgba(79,179,232,.85),inset 0 0 0 2px rgba(255,255,255,.5);}
.mg-cards-deck{position:relative;width:30px;height:40px;border-radius:6px;flex:none;
  background:linear-gradient(150deg,#c9744f,#8a4a2c);box-shadow:2px 2px 0 rgba(0,0,0,.3),inset 0 0 0 2px #6d3a20;
  display:flex;align-items:center;justify-content:center;color:#fff6e3;font-weight:900;font-size:13px;}
.mg-cards-deck.mg-cards-drawpop{animation:mg-cards-bump .3s ease;}
@keyframes mg-cards-bump{50%{transform:scale(1.18) rotate(-4deg)}}
.mg-cards-grave{position:relative;width:30px;height:40px;border-radius:6px;flex:none;
  background:linear-gradient(150deg,#5e5a52,#3c3a32);
  box-shadow:2px 2px 0 rgba(0,0,0,.3),inset 0 0 0 2px #2c2a24;
  display:flex;align-items:center;justify-content:center;color:#cdc6b6;font-weight:900;font-size:13px;
  opacity:.55;transition:.2s;}
.mg-cards-grave.mg-cards-any{opacity:1;}
.mg-cards-grave.mg-cards-drawpop{animation:mg-cards-bump .3s ease;}

.mg-cards-backs{display:flex;gap:2px;height:44px;align-items:center;}
.mg-cards-backs i{display:block;width:24px;height:34px;border-radius:4px;margin-left:-8px;
  background:linear-gradient(150deg,#c9744f,#8a4a2c);box-shadow:inset 0 0 0 2px #6d3a20,0 2px 4px rgba(0,0,0,.35);}
.mg-cards-backs i:first-child{margin-left:0;}

/* ---- rows of slots ---- */
.mg-cards-row{display:flex;gap:clamp(8px,1.7vw,26px);justify-content:center;}
/* A slot is now a hit zone over the diorama: the critter standing in it is 3D,
   so all the DOM keeps is the click target and a compact stat plaque. */
.mg-cards-slot{position:relative;width:var(--bw);height:var(--bh);border-radius:12px;transition:.18s;}
.mg-cards-slot::before{content:"";position:absolute;left:8%;right:8%;bottom:22%;height:16%;
  border-radius:50%;background:rgba(255,246,227,.07);transition:.18s;}
.mg-cards-slot.mg-cards-can{cursor:pointer;}
.mg-cards-slot.mg-cards-can::before{background:rgba(242,182,74,.34);
  box-shadow:0 0 22px rgba(242,182,74,.6);animation:mg-cards-pulse 1s ease-in-out infinite;}
/* the stand is what the diorama measures: the critter's feet land on its bottom
   edge and its height is how tall the model should read */
.mg-cards-stand{position:absolute;left:0;right:0;top:0;bottom:25%;display:block;pointer-events:none;}
.mg-cards-card{position:absolute;inset:0;cursor:pointer;
  transition:transform .16s cubic-bezier(.2,1.35,.4,1),filter .16s;}
.mg-cards-card canvas{display:block;width:100%;height:100%;border-radius:11px;
  filter:drop-shadow(0 4px 6px rgba(0,0,0,.4));}
.mg-cards-slot .mg-cards-card canvas{position:absolute;left:-16%;bottom:-4%;width:132%;height:auto;
  border-radius:0;filter:drop-shadow(0 5px 7px rgba(0,0,0,.55));}
.mg-cards-card.mg-cards-land canvas{animation:mg-cards-land .42s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-cards-land{from{transform:translateY(16px) scale(.7);opacity:0}
  70%{transform:translateY(-3px) scale(1.05)}}
.mg-cards-card.mg-cards-ready::after{content:"";position:absolute;left:-4%;right:-4%;bottom:2%;height:26%;
  border-radius:999px;box-shadow:0 0 0 3px rgba(122,199,79,.9);pointer-events:none;}
.mg-cards-slot .mg-cards-card.mg-cards-ready:hover canvas{transform:translateY(-4px);}
.mg-cards-slot .mg-cards-card.mg-cards-sel canvas{transform:translateY(-6px) scale(1.06);
  filter:drop-shadow(0 0 12px rgba(242,182,74,.9));animation:mg-cards-pulse .9s ease-in-out infinite;}
.mg-cards-card.mg-cards-poof{animation:mg-cards-poof .42s ease-in forwards;pointer-events:none;}
@keyframes mg-cards-poof{40%{transform:scale(1.06)}
  to{transform:scale(.4) translateY(16px);opacity:0}}
/* a knocked-out critter's card greys out and slides onto the graveyard stack */
.mg-cards-card.mg-cards-tomb{pointer-events:none;z-index:9;
  animation:mg-cards-tomb .62s cubic-bezier(.4,.1,.5,1) forwards;}
.mg-cards-card.mg-cards-tomb canvas{filter:grayscale(1) brightness(.62);}
@keyframes mg-cards-tomb{0%{transform:translate(0,0) scale(1);opacity:1}
  22%{transform:translate(0,-10px) scale(1.04)}
  100%{transform:translate(var(--tx),var(--ty)) scale(.2) rotate(-12deg);opacity:0}}
.mg-cards-card.mg-cards-hit canvas{animation:mg-cards-shake .34s ease;}
.mg-cards-card.mg-cards-away canvas{opacity:.45;}

/* ---- prompt strip ---- */
.mg-cards-prompt{display:flex;align-items:center;gap:10px;min-height:30px;
  background:rgba(22,14,8,.6);border-radius:999px;padding:6px 18px;color:#ffeec9;font-weight:800;
  font-size:clamp(11.5px,1.35vw,15px);letter-spacing:.02em;text-align:center;
  box-shadow:inset 0 0 0 2px rgba(255,246,227,.14);max-width:min(92vw,780px);}
.mg-cards-prompt.mg-cards-warn{background:rgba(201,74,62,.75);}
.mg-cards-prompt em{font-style:normal;color:#ffd98a;}

/* ---- my bar + hand ---- */
.mg-cards-end{border:4px solid #fff;border-radius:999px;background:#7ac74f;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(12px,1.5vw,16px);letter-spacing:.08em;padding:9px 22px;cursor:pointer;
  box-shadow:0 6px 0 rgba(30,50,20,.45);transition:.12s;}
.mg-cards-end:hover{transform:translateY(-2px);}
.mg-cards-end:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(30,50,20,.45);}
.mg-cards-end:disabled{background:#9aa694;box-shadow:0 6px 0 rgba(30,50,20,.3);cursor:default;
  transform:none;opacity:.7;}
.mg-cards-end.mg-cards-nudge{animation:mg-cards-pulse .9s ease-in-out infinite;}
.mg-cards-hand{display:flex;justify-content:center;align-items:flex-end;height:calc(var(--hh) + 14px);
  padding-top:12px;}
.mg-cards-hand .mg-cards-card{position:relative;inset:auto;width:var(--hw);height:var(--hh);
  margin:0 clamp(-14px,-.8vw,-4px);transition:transform .18s cubic-bezier(.2,1.35,.4,1);}
.mg-cards-hand .mg-cards-card canvas{position:static;width:100%;height:100%;border-radius:11px;}
.mg-cards-hand .mg-cards-card:hover{transform:translateY(-16px) scale(1.06);z-index:7;}
.mg-cards-hand .mg-cards-card.mg-cards-sel{transform:translateY(-22px) scale(1.1);z-index:8;}
.mg-cards-hand .mg-cards-card.mg-cards-poor canvas{filter:grayscale(.55) brightness(.78)
  drop-shadow(0 4px 6px rgba(0,0,0,.4));}
.mg-cards-hand .mg-cards-card.mg-cards-nope{animation:mg-cards-shake .34s ease;}
.mg-cards-flycard{position:absolute;pointer-events:none;z-index:11;perspective:800px;
  animation:mg-cards-fly var(--fd,.3s) cubic-bezier(.45,0,.35,1) forwards;}
.mg-cards-flycard canvas{width:100%;height:100%;display:block;border-radius:11px;
  filter:drop-shadow(0 8px 14px rgba(0,0,0,.5));}
@keyframes mg-cards-fly{
  0%{transform:translate(0,0) scale(1) rotateX(0deg);opacity:1}
  62%{transform:translate(calc(var(--tx) * .78),calc(var(--ty) * .78 - 26px)) scale(calc(var(--ts) * 1.12)) rotateX(300deg);opacity:1}
  100%{transform:translate(var(--tx),var(--ty)) scale(var(--ts)) rotateX(360deg);opacity:0}}

/* ---- spectacle: triangle banner, finish whiteout, fast-mode switch ---- */
.mg-cards-banner{position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);z-index:12;
  font-weight:900;font-size:clamp(28px,6.2vw,76px);letter-spacing:.05em;color:#fff6e3;white-space:nowrap;
  text-shadow:0 6px 0 rgba(30,18,6,.5),0 0 34px var(--bc,#ffd070);pointer-events:none;
  animation:mg-cards-banner .86s cubic-bezier(.2,1.4,.4,1) forwards;}
@keyframes mg-cards-banner{0%{opacity:0;transform:translate(-50%,-50%) scale(.45) skewX(-13deg)}
  16%{opacity:1;transform:translate(-50%,-50%) scale(1.16) skewX(-13deg)}
  32%{transform:translate(-50%,-50%) scale(1) skewX(-13deg)}
  74%{opacity:1;transform:translate(-50%,-50%) scale(1) skewX(-13deg)}
  100%{opacity:0;transform:translate(-50%,-52%) scale(1.06) skewX(-13deg)}}
.mg-cards-bannerbg{position:absolute;left:0;right:0;top:40%;height:clamp(50px,11vh,116px);z-index:11;
  transform:translateY(-50%);pointer-events:none;
  background:linear-gradient(90deg,rgba(0,0,0,0),var(--bc,#ffd070) 22%,var(--bc,#ffd070) 78%,rgba(0,0,0,0));
  animation:mg-cards-bannerbg .86s ease forwards;mix-blend-mode:screen;}
@keyframes mg-cards-bannerbg{0%{opacity:0;transform:translateY(-50%) scaleY(.12)}
  18%{opacity:.6;transform:translateY(-50%) scaleY(1)}
  100%{opacity:0;transform:translateY(-50%) scaleY(.8)}}
.mg-cards-white{position:absolute;inset:0;z-index:13;background:#fffdf6;opacity:0;pointer-events:none;
  transition:opacity .34s ease;}
.mg-cards-root.mg-cards-cam .mg-cards-slot .mg-cards-card{opacity:0;transition:opacity .22s ease;}
.mg-cards-root.mg-cards-cam .mg-cards-hand,.mg-cards-root.mg-cards-cam .mg-cards-prompt,
.mg-cards-root.mg-cards-cam .mg-cards-bar{opacity:.18;transition:opacity .3s ease;}
.mg-cards-white.mg-cards-on{opacity:1;}
.mg-cards-toggle{display:inline-flex;align-items:center;gap:9px;background:#fff6e3;border:0;
  border-radius:999px;padding:9px 17px;font-family:inherit;font-weight:900;font-size:12px;
  letter-spacing:.1em;color:#9a8461;cursor:pointer;transition:.14s;box-shadow:0 4px 0 rgba(60,34,10,.18);}
.mg-cards-toggle:hover{transform:translateY(-2px);}
.mg-cards-toggle i{width:34px;height:18px;border-radius:999px;background:rgba(58,42,28,.22);
  position:relative;transition:.16s;flex:none;}
.mg-cards-toggle i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;
  border-radius:50%;background:#fffdf6;transition:.16s;}
.mg-cards-toggle.mg-cards-on{color:#3a2a1c;}
.mg-cards-toggle.mg-cards-on i{background:#7ac74f;}
.mg-cards-toggle.mg-cards-on i::after{transform:translateX(16px);}
.mg-cards-float.mg-cards-big{font-size:clamp(30px,4.6vw,60px);
  text-shadow:0 4px 0 rgba(30,18,6,.55),0 0 26px rgba(255,140,110,.75);}
/* prefers-reduced-motion: everything that shook or flashed becomes a fade */
.mg-cards-root.mg-cards-calm .mg-cards-banner{animation:mg-cards-calmfade .86s ease forwards;}
.mg-cards-root.mg-cards-calm .mg-cards-bannerbg{animation:mg-cards-calmfade .86s ease forwards;}
.mg-cards-root.mg-cards-calm .mg-cards-flycard{animation:mg-cards-calmfly var(--fd,.3s) ease forwards;}
.mg-cards-root.mg-cards-calm .mg-cards-float{animation:mg-cards-calmfloat 1.05s ease-out forwards;}
.mg-cards-root.mg-cards-calm .mg-cards-slot.mg-cards-can::before,
.mg-cards-root.mg-cards-calm .mg-cards-capy.mg-cards-can .mg-cards-plate,
.mg-cards-root.mg-cards-calm .mg-cards-capy.mg-cards-can .mg-cards-bust::after,
.mg-cards-root.mg-cards-calm .mg-cards-end.mg-cards-nudge,
.mg-cards-root.mg-cards-calm .mg-cards-quit.mg-cards-armed{animation:none;}
.mg-cards-root.mg-cards-calm.mg-cards-quake{animation:none;}
@keyframes mg-cards-calmfade{0%{opacity:0}18%{opacity:1}74%{opacity:1}100%{opacity:0}}
@keyframes mg-cards-calmfly{0%{opacity:1}100%{transform:translate(var(--tx),var(--ty)) scale(var(--ts));opacity:0}}
@keyframes mg-cards-calmfloat{0%{opacity:0;transform:translate(-50%,-50%)}
  20%{opacity:1;transform:translate(-50%,-70%)}80%{opacity:1;transform:translate(-50%,-90%)}
  100%{opacity:0;transform:translate(-50%,-110%)}}

/* ---- inspect panel ---- */
.mg-cards-inspect{position:absolute;right:clamp(10px,2vw,26px);top:50%;transform:translateY(-50%) scale(.9);
  z-index:9;width:clamp(150px,17vw,214px);pointer-events:none;opacity:0;transition:opacity .16s,transform .16s;
  background:rgba(24,16,9,.9);border-radius:20px;padding:12px;box-shadow:0 14px 34px rgba(0,0,0,.5);
  text-align:center;}
.mg-cards-inspect.mg-cards-on{opacity:1;transform:translateY(-50%) scale(1);}
.mg-cards-inspect canvas{width:100%;height:auto;display:block;border-radius:12px;}
.mg-cards-inspect p{margin-top:9px;font-size:11.5px;line-height:1.5;font-weight:700;color:#ffeec9;}
.mg-cards-inspect p b{color:#f2b64a;display:block;font-size:12px;letter-spacing:.06em;margin-bottom:2px;}
@media (max-width:900px){.mg-cards-inspect{display:none;}}

/* ---- fx ---- */
.mg-cards-fx{position:absolute;inset:0;z-index:10;pointer-events:none;overflow:hidden;}
.mg-cards-float{position:absolute;transform:translate(-50%,-50%);font-weight:900;white-space:nowrap;
  animation:mg-cards-float 1.05s ease-out forwards;text-shadow:0 3px 0 rgba(30,18,6,.5);}
@keyframes mg-cards-float{0%{opacity:0;transform:translate(-50%,-20%) scale(.5)}
  22%{opacity:1;transform:translate(-50%,-60%) scale(1.2)}
  50%{transform:translate(-50%,-72%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-150%) scale(.95)}}
.mg-cards-float.mg-cards-dmg{color:#ff8f80;font-size:clamp(22px,2.8vw,36px);}
.mg-cards-float.mg-cards-heal{color:#a8e87a;font-size:clamp(20px,2.4vw,30px);}
.mg-cards-float.mg-cards-tri{color:#ffe08a;font-size:clamp(16px,1.9vw,24px);letter-spacing:.06em;}
.mg-cards-float.mg-cards-note{color:#fff6e3;font-size:clamp(14px,1.7vw,20px);letter-spacing:.06em;}
.mg-cards-poofdot{position:absolute;border-radius:50%;transform:translate(-50%,-50%);
  animation:mg-cards-poofdot .55s ease-out forwards;}
@keyframes mg-cards-poofdot{to{opacity:0;transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) scale(.3)}}
.mg-cards-reveal{position:absolute;left:50%;top:20%;width:clamp(90px,12vh,132px);
  transform:translate(-50%,-50%);z-index:11;pointer-events:none;
  animation:mg-cards-reveal 1.05s ease-out forwards;}
.mg-cards-reveal canvas{width:100%;height:auto;display:block;border-radius:12px;
  filter:drop-shadow(0 10px 18px rgba(0,0,0,.55));}
@keyframes mg-cards-reveal{0%{opacity:0;transform:translate(-50%,-90%) scale(.5) rotate(-10deg)}
  20%{opacity:1;transform:translate(-50%,-50%) scale(1.06)}
  75%{opacity:1;transform:translate(-50%,-50%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-20%) scale(.86)}}

/* ---- overlays ---- */
.mg-cards-over{position:absolute;inset:0;z-index:14;display:flex;align-items:center;justify-content:center;
  background:rgba(24,16,8,.76);backdrop-filter:blur(3px);padding:18px;text-align:center;}
.mg-cards-over.mg-cards-gone{display:none;}
.mg-cards-modal{background:linear-gradient(180deg,#fffdf6,#ffeed2);border-radius:26px;padding:22px 26px;
  width:min(620px,95vw);max-height:94vh;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.5);
  animation:mg-cards-modal .32s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-cards-modal{from{transform:scale(.84) translateY(18px);opacity:0}}
.mg-cards-modal h1{font-size:clamp(26px,4.2vw,42px);color:#e8657a;line-height:1.05;}
.mg-cards-modal h2{font-size:clamp(22px,3.2vw,32px);color:#e8657a;}
.mg-cards-sub{font-weight:800;color:#9a8461;font-size:13px;margin:4px 0 14px;letter-spacing:.05em;}
.mg-cards-panel{display:flex;align-items:center;gap:16px;background:#fff6e3;border-radius:18px;
  padding:14px;text-align:left;min-height:clamp(150px,24vh,210px);}
.mg-cards-panel .mg-cards-panelart{flex:none;display:flex;align-items:center;gap:8px;}
.mg-cards-panel canvas{display:block;filter:drop-shadow(0 5px 8px rgba(60,34,10,.3));}
.mg-cards-panel h3{font-size:clamp(16px,2.2vw,21px);color:#3a2a1c;margin-bottom:6px;}
.mg-cards-panel p{font-size:clamp(12px,1.5vw,14px);line-height:1.55;font-weight:700;color:#5b452c;}
.mg-cards-panel p + p{margin-top:7px;}
.mg-cards-arrowbig{font-size:26px;font-weight:900;color:#e8657a;}
.mg-cards-dots{display:flex;gap:7px;justify-content:center;margin:12px 0;}
.mg-cards-dots i{width:9px;height:9px;border-radius:50%;background:rgba(58,42,28,.24);transition:.2s;}
.mg-cards-dots i.mg-cards-on{background:#e8657a;transform:scale(1.35);}
.mg-cards-stats{display:flex;justify-content:center;gap:9px;margin:14px 0;flex-wrap:wrap;}
.mg-cards-stat{background:#fff6e3;border-radius:16px;padding:10px 18px;min-width:104px;}
.mg-cards-stat b{display:block;font-size:clamp(20px,2.8vw,30px);color:#3a2a1c;line-height:1.15;}
.mg-cards-stat span{font-size:10.5px;font-weight:900;letter-spacing:.13em;color:#9a8461;}
.mg-cards-stat.mg-cards-gold b{color:#e0982a;}
.mg-cards-ribbon{display:inline-block;background:#f2b64a;color:#fff;font-weight:900;letter-spacing:.14em;
  font-size:12px;padding:6px 18px;border-radius:999px;margin-bottom:6px;
  animation:mg-cards-pulse .8s ease-in-out infinite;}
.mg-cards-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;}
.mg-cards-btn{border:4px solid #fff;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(13px,1.6vw,17px);padding:11px 24px;cursor:pointer;
  box-shadow:0 6px 0 rgba(60,34,10,.28);transition:.12s;}
.mg-cards-btn:hover{transform:translateY(-2px);}
.mg-cards-btn:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(60,34,10,.28);}
.mg-cards-btn.mg-cards-alt{background:#4fb3e8;}
.mg-cards-btn.mg-cards-ghost{background:transparent;border-color:rgba(58,42,28,.28);color:#7a6748;
  box-shadow:none;}
.mg-cards-count{font-size:clamp(70px,15vw,160px);font-weight:900;color:#fff6e3;
  text-shadow:0 8px 0 rgba(30,18,6,.4);animation:mg-cards-count .58s ease-out;}
@keyframes mg-cards-count{from{transform:scale(2.2);opacity:0}40%{opacity:1}to{transform:scale(1)}}
.mg-cards-trirink{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;}
.mg-cards-trirink canvas{display:block;}
.mg-cards-winner{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:6px;}
.mg-cards-vs{display:flex;align-items:center;justify-content:center;gap:clamp(10px,2.6vw,26px);
  margin:12px 0 8px;}
.mg-cards-vscap{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;}
.mg-cards-vscap canvas{display:block;filter:drop-shadow(0 6px 9px rgba(60,34,10,.32));
  animation:mg-cards-breathe 3.2s ease-in-out infinite;}
.mg-cards-vscap b{font-size:clamp(13px,1.9vw,18px);color:#3a2a1c;max-width:38vw;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.mg-cards-vscap span{font-size:10px;font-weight:900;letter-spacing:.13em;color:#9a8461;}
.mg-cards-vsx{font-size:clamp(22px,3.4vw,34px);font-weight:900;color:#e8657a;letter-spacing:.05em;
  animation:mg-cards-pulse 1.1s ease-in-out infinite;}
.mg-cards-endcap{flex:1;display:flex;align-items:center;gap:10px;min-width:0;}
.mg-cards-endcap.mg-cards-right{justify-content:flex-end;}
@media (max-height:640px){
  .mg-cards-panel{min-height:0;}
  .mg-cards-modal{padding:16px 18px;}
}
/* Short windows: the tutorial modal still ran ~60px past its own max-height, so
   Next / Skip / Back sat in the scrolled-off tail. Compact the card instead of
   asking the player to scroll an overlay that shows no scrollbar affordance. */
@media (max-height:560px){
  .mg-cards-over{padding:6px;}
  .mg-cards-modal{padding:11px 16px;max-height:98vh;border-radius:20px;}
  .mg-cards-modal h1{font-size:21px;}
  .mg-cards-modal h2{font-size:23px;}
  .mg-cards-sub{font-size:11px;margin:2px 0 8px;}
  .mg-cards-panel{padding:9px;gap:11px;border-radius:14px;}
  .mg-cards-panel h3{font-size:15px;margin-bottom:4px;}
  .mg-cards-panel p{font-size:11.5px;line-height:1.4;}
  .mg-cards-panel p + p{margin-top:5px;}
  .mg-cards-dots{margin:6px 0;}
  .mg-cards-stats{margin:8px 0;gap:7px;}
  .mg-cards-stat{padding:5px 13px;min-width:80px;border-radius:13px;}
  .mg-cards-stat b{font-size:17px;}
  .mg-cards-stat span{font-size:9px;}
  .mg-cards-ribbon{font-size:10.5px;padding:4px 14px;margin-bottom:4px;}
  .mg-cards-winner{margin-bottom:4px;}
  .mg-cards-vs{margin:6px 0 4px;gap:12px;}
  .mg-cards-vscap b{font-size:12.5px;}
  .mg-cards-btns{margin-top:2px;gap:8px;}
  .mg-cards-btn{padding:7px 17px;font-size:12.5px;border-width:3px;}
}
`;

// ===========================================================================
// THE GAME
// ===========================================================================
const HAND_PAINT = 260;
/** Board critters are 3D now; the slot only carries a compact stat plaque. */
const PLAQUE_PAINT = 260;
/** PvP only: how long a duelist gets before their own client passes the turn. */
const TURN_MS = 90000;
/** PvP only: how long past the clock a silent opponent earns a gentle hint. */
const STALL_MS = 20000;
const HAT_COLORS = ['#e8657a', '#4fb3e8', '#7ac74f', '#f2b64a', '#9b6bd4', '#42d6c8'];

function paintCard(cv, W, def, live) {
  const H = Math.round(W * 1.38);
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  const k = W / 200;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, 200, 276);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  drawCardFace(ctx, def, live);
}

/** A hat that never disappears into the fur it sits on. */
function pickHatColor(body, seed) {
  const B = rgbOf(body);
  const far = HAT_COLORS.filter((h) => {
    const C = rgbOf(h);
    return Math.abs(C[0] - B[0]) + Math.abs(C[1] - B[1]) + Math.abs(C[2] - B[2]) > 150;
  });
  const pool = far.length ? far : HAT_COLORS;
  return pool[seed % pool.length];
}

function cardCanvas(def, W, live) {
  const cv = document.createElement('canvas');
  paintCard(cv, W, def, live);
  return cv;
}

export class CardsGame extends Minigame {
  static id = 'cards';
  static name = 'Capy Clash';

  constructor(game) {
    super(game);
    this._timers = new Set();
    this._dead = false;
    this._onKey = null;
    this._nodes = new Map();
    this._hoverAt = 0;
    this.phase = 'splash';
    this.busy = false;
    this.sel = null;
    this.S = null;
    this._result = null;
    this.el = {};
    this.foeExpr = 'idle';
    this.myExpr = 'idle';
    this._warnUntil = 0;
    this._foeHold = 0;
    this._myHold = 0;
    // ---- den PvP (all null/solo defaults for a run against Pebble) ----------
    this.mp = null; // {players, seed, myId, oppId} once seated at a den table
    this.me = 0; // my seat in the rules core
    this.foe = 1; // the other seat
    this.foeName = AI_NAME;
    this.foeTag = 'PEBBLE';
    this._offs = []; // event unsubscribers
    this._rq = []; // opponent intents waiting their turn on screen
    this._frozen = false; // desync/offline: stop rather than diverge quietly
    this._matchDoneSent = false;
    this._matchEnd = null; // the server's shared verdict
    this._forfeitBy = null; // 'them' | 'me'
    this._clockTurn = -1;
    this._clockUntil = 0;
    this._stallNoted = false;
    this._quitArmed = 0;
    // ---- the spectacle layer (docs/CARDGAME.md section 10) -------------------
    this.stage = null;
    this._raf = 0;
    this._lastT = 0;
    this._measureAt = 0;
    this._onResize = null;
    this._blockUntil = 0; // hit-stop + finish cam: the ONLY input blockers
    this._finishing = false;
    this._graves = [0, 0];
    this._staged = new Map(); // uids whose entrance/exit the show still owns
    this._flyFrom = null;     // the rect a played card is flying out of
    this.fast = false;
    this.reduced = false;
    this._stinger = null;
  }

  /** Every duration in the show funnels through here, so fast mode is one flag. */
  D(ms) { return this.fast ? Math.round(ms * 0.5) : ms; }

  /** True only during hit-stop and the finish cam; nothing else takes input away. */
  _blocked() { return this._finishing || performance.now() < this._blockUntil; }

  // ---- lifecycle ----------------------------------------------------------
  mount(root) {
    super.mount(root);
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-cards-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (s) => wrap.querySelector(s);
    this.el = {
      wrap,
      turnNo: q('[data-el="turnNo"]'),
      turnWho: q('[data-el="turnWho"]'),
      tri: q('[data-el="tri"]'),
      foeCapy: q('[data-el="foeCapy"]'),
      foeFace: q('[data-el="foeFace"]'),
      foeHpFill: q('[data-el="foeHpFill"]'),
      foeHpText: q('[data-el="foeHpText"]'),
      foePips: q('[data-el="foePips"]'),
      foeDeck: q('[data-el="foeDeck"]'),
      foeHand: q('[data-el="foeHand"]'),
      foeBoard: q('[data-el="foeBoard"]'),
      prompt: q('[data-el="prompt"]'),
      myBoard: q('[data-el="myBoard"]'),
      myCapy: q('[data-el="myCapy"]'),
      myFace: q('[data-el="myFace"]'),
      myName: q('[data-el="myName"]'),
      myHpFill: q('[data-el="myHpFill"]'),
      myHpText: q('[data-el="myHpText"]'),
      myPips: q('[data-el="myPips"]'),
      myDeck: q('[data-el="myDeck"]'),
      myHand: q('[data-el="myHand"]'),
      end: q('[data-el="end"]'),
      inspect: q('[data-el="inspect"]'),
      fx: q('[data-el="fx"]'),
      over: q('[data-el="over"]'),
      foeName: q('[data-el="foeName"]'),
      clock: q('[data-el="clock"]'),
      clockWho: q('[data-el="clockWho"]'),
      clockNum: q('[data-el="clockNum"]'),
      live: q('[data-el="live"]'),
      quit: q('[data-el="quit"]'),
      white: q('[data-el="white"]'),
      myGrave: q('[data-el="myGrave"]'),
      foeGrave: q('[data-el="foeGrave"]'),
    };

    try {
      this.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch { this.reduced = false; }
    if (this.reduced) wrap.classList.add('mg-cards-calm');

    // seats first: every row, click and highlight below is addressed by seat
    const ctx = this.game.__matchCtx;
    if (ctx && ctx.game === 'cards') this._readMatchCtx(ctx);

    this._buildTriangleBadge();
    this.el.foeSlots = this._buildSlots(this.el.foeBoard, this.foe);
    this.el.mySlots = this._buildSlots(this.el.myBoard, this.me);

    const opp = this.mp ? this.mp.players[this.foe] : null;
    if (opp) {
      const oppBody = bodyHex(opp.color);
      this.foeCfg = {
        color: oppBody,
        hat: typeof opp.hat === 'string' ? opp.hat : 'none',
        hatColor: pickHatColor(oppBody, this.foeName.length),
      };
    } else {
      this.foeCfg = { color: '#8a6642', hat: 'tophat', hatColor: '#4fb3e8', monocle: true };
    }
    const body = hexOf(this.game.state?.color ?? 0xb08a5a);
    this.myCfg = {
      color: body,
      hat: this.game.state?.hat || 'none',
      hatColor: pickHatColor(body, (this.game.state?.name || 'capy').length),
    };
    this.el.myName.textContent = (this.game.state?.name || 'You').slice(0, 14);
    this.el.foeName.textContent = this.foeName;
    if (this.mp) {
      this.el.live.classList.remove('mg-cards-hide');
      this.el.quit.textContent = 'FORFEIT';
    }
    // ---- the battle diorama --------------------------------------------------
    this.stage = new Diorama(wrap, {
      reduced: this.reduced,
      sfx: (n) => this.game.audio?.play?.(n),
    });
    if (this.stage.ok) {
      this.stage.addBust(this.foe, this.foeCfg);
      this.stage.addBust(this.me, this.myCfg);
      this._resizeStage();
      this._onResize = () => this._resizeStage();
      window.addEventListener('resize', this._onResize);
      this._loop();
      // debug handle, like window.__game: lets a playtest harness step and
      // photograph the diorama without reaching through the module graph
      // dev-only debug handle; the import.meta.env.DEV form is load-bearing -
      // esbuild folds it out of the prod bundle (see foot of src/core/game.js)
      if (import.meta.env && import.meta.env.DEV) window.__cards = this;
    } else {
      // no WebGL: keep the v1 flat board readable rather than showing nothing
      wrap.classList.add('mg-cards-flat');
    }

    this.el.end.addEventListener('click', () => this._endTurnClick());
    this.el.foeCapy.addEventListener('click', () => this._clickFace());
    this.el.quit.addEventListener('click', () => this._quitClick());
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.classList?.contains('mg-cards-table')) this._deselect();
    });

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey);

    this._blinkLoop();
    if (this.mp) {
      // a real capy is sitting opposite: no tutorial, straight to the table
      this._clockLoop();
      this._showVersus();
    } else {
      this._showSplash();
    }
  }

  dispose() {
    // walking away from a live duel is a concession, not a vanishing act: tell
    // the opponent's board and the server before the wiring comes down
    if (this.mp && this.S && this.S.winner === null && !this._matchDoneSent && !this._frozen) {
      this._sendMove({ a: 'resign' }, true);
      this._reportMatch(this.mp.oppId);
    }
    this._dead = true;
    for (const off of this._offs) { try { off(); } catch { /* emitter already dropped it */ } }
    this._offs.length = 0;
    this._rq.length = 0;
    if (this.game.__matchCtx) this.game.__matchCtx = null;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._onResize = null;
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    this._onKey = null;
    if (this.stage) { try { this.stage.dispose(); } catch (e) { console.warn('[cards] stage dispose', e); } }
    this.stage = null;
    if (import.meta.env && import.meta.env.DEV && window.__cards === this) window.__cards = null;
    if (this._stinger) { this._stinger.dispose(); this._stinger = null; }
    this._nodes.clear();
    this.el = {};
    this.S = null;
  }

  // ---- the show's frame loop ----------------------------------------------
  _resizeStage() {
    if (!this.stage || !this.el.wrap) return;
    const r = this.el.wrap.getBoundingClientRect();
    this.stage.resize(Math.round(r.width), Math.round(r.height));
    this._measureAt = 0; // anchors are stale the instant the box moves
  }

  _loop() {
    this._raf = requestAnimationFrame((t) => {
      this._raf = 0;
      if (this._dead || !this.stage) return;
      const dt = this._lastT ? Math.min(80, t - this._lastT) : 16;
      this._lastT = t;
      // the board's boxes only move on resize and on prompt rewraps, so a
      // quarter-second cadence is plenty and keeps layout thrash off the frame
      if (t - this._measureAt > 250) {
        this._measureAt = t;
        this._measureStage();
      }
      this.stage.update(dt);
      this.stage.render();
      this._loop();
    });
  }

  _measureStage() {
    if (!this.stage || !this.el.wrap || !this.el.mySlots) return;
    const wrapRect = this.el.wrap.getBoundingClientRect();
    if (!wrapRect.width) return;
    const stands = (slots) => slots.map((sl) => sl._stand || sl);
    this.stage.measure({
      slotEls: { [this.me]: stands(this.el.mySlots), [this.foe]: stands(this.el.foeSlots) },
      bustEls: { [this.me]: this.el.myFace, [this.foe]: this.el.foeFace },
    }, wrapRect);
    // the slab spans the two bars: HUD above and hand below stay off the table
    const bars = this.el.bars || (this.el.bars = [...this.el.wrap.querySelectorAll('.mg-cards-bar')]);
    if (bars.length >= 2) {
      const a = bars[0].getBoundingClientRect();
      const b = bars[bars.length - 1].getBoundingClientRect();
      this.stage.setBoard({
        x: 0, y: a.top - wrapRect.top,
        w: wrapRect.width, h: Math.max(40, b.bottom - a.top),
      });
    }
  }

  _after(ms, fn) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._dead) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  coinsForScore() {
    const r = this._result;
    if (!r) return 0;
    if (r.win) {
      const full = 70 + Math.floor(r.myHp / 2);
      // A duel nobody fought is not worth a duel's pay: a win by walkout pays
      // for the cards that actually hit the table (and a near-finished duel
      // still pays like the win it was about to be).
      return r.forfeit ? Math.min(full, 25 + Math.round(r.dealt || 0)) : full;
    }
    if (r.draw) return 20; // draws are all but unreachable; never leave a run unpaid
    return r.foeHp < 10 ? 10 : 5;
  }

  /** What the purse actually receives, i.e. what the results card must show. */
  _payout() { return clampCoinsForGame('cards', this.coinsForScore()); }

  // ---- markup -------------------------------------------------------------
  _html() {
    return `
      <div class="mg-cards-bg"></div>
      <div class="mg-cards-felt"></div>
      <div class="mg-cards-lamp"></div>
      <div class="mg-cards-white" data-el="white"></div>

      <div class="mg-cards-hud">
        <div class="mg-cards-chip mg-cards-title">CAPY CLASH</div>
        <div class="mg-cards-chip mg-cards-live mg-cards-hide" data-el="live">DEN TABLE</div>
        <div class="mg-cards-chip"><small>TURN</small><b data-el="turnNo">1</b>
          <small data-el="turnWho">YOU</small></div>
        <div class="mg-cards-chip mg-cards-clock mg-cards-hide" data-el="clock">
          <small data-el="clockWho">YOUR TURN</small><b data-el="clockNum">1:30</b></div>
        <div class="mg-cards-chip mg-cards-tri" data-el="tri"></div>
        <div class="mg-cards-spacer"></div>
        <button class="mg-cards-quit" data-el="quit">QUIT</button>
      </div>

      <div class="mg-cards-table">
        <div class="mg-cards-bar">
          <div class="mg-cards-endcap">
            <div class="mg-cards-deck" data-el="foeDeck">24</div>
            <div class="mg-cards-grave" data-el="foeGrave">0</div>
            <div class="mg-cards-pips" data-el="foePips"></div>
          </div>
          <div class="mg-cards-capy" data-el="foeCapy">
            <div class="mg-cards-bust mg-cards-bustfoe" data-el="foeFace"></div>
            <div class="mg-cards-plate">
              <b data-el="foeName">${AI_NAME}</b>
              <div class="mg-cards-hp"><i data-el="foeHpFill"></i><span data-el="foeHpText">25</span></div>
            </div>
          </div>
          <div class="mg-cards-endcap mg-cards-right">
            <div class="mg-cards-backs" data-el="foeHand"></div>
          </div>
        </div>

        <div class="mg-cards-row" data-el="foeBoard"></div>
        <div class="mg-cards-prompt" data-el="prompt">Your move.</div>
        <div class="mg-cards-row" data-el="myBoard"></div>

        <div class="mg-cards-bar">
          <div class="mg-cards-endcap">
            <div class="mg-cards-deck" data-el="myDeck">24</div>
            <div class="mg-cards-grave" data-el="myGrave">0</div>
            <div class="mg-cards-pips" data-el="myPips"></div>
          </div>
          <div class="mg-cards-capy" data-el="myCapy">
            <div class="mg-cards-bust mg-cards-bustme" data-el="myFace"></div>
            <div class="mg-cards-plate">
              <b data-el="myName">You</b>
              <div class="mg-cards-hp"><i data-el="myHpFill"></i><span data-el="myHpText">25</span></div>
            </div>
          </div>
          <div class="mg-cards-endcap mg-cards-right">
            <button class="mg-cards-end" data-el="end">END TURN</button>
          </div>
        </div>

        <div class="mg-cards-hand" data-el="myHand"></div>
      </div>

      <div class="mg-cards-inspect" data-el="inspect"></div>
      <div class="mg-cards-fx" data-el="fx"></div>
      <div class="mg-cards-over" data-el="over"></div>`;
  }

  _buildTriangleBadge() {
    const tri = this.el.tri;
    tri.innerHTML = '';
    const chain = [['sun', 'snow'], ['snow', 'sea'], ['sea', 'sun']];
    tri.appendChild(elemIconCanvas('sun', 20));
    for (const [from, to] of chain) {
      const a = document.createElement('span');
      a.className = 'mg-cards-arrow';
      a.dataset.from = from;
      a.textContent = '▸';
      tri.appendChild(a);
      tri.appendChild(elemIconCanvas(to, 20));
    }
  }

  _buildSlots(row, side) {
    row.innerHTML = '';
    const slots = [];
    for (let i = 0; i < BOARD_SLOTS; i++) {
      const d = document.createElement('div');
      d.className = 'mg-cards-slot';
      d.dataset.side = String(side);
      d.dataset.slot = String(i);
      const stand = document.createElement('i');
      stand.className = 'mg-cards-stand';
      d.appendChild(stand);
      d._stand = stand;
      d.addEventListener('click', () => this._clickSlot(side, i));
      row.appendChild(d);
      slots.push(d);
    }
    return slots;
  }

  // ---- card nodes ---------------------------------------------------------
  _cardNode(uid, def, live, kind) {
    let n = this._nodes.get(uid);
    if (!n) {
      n = document.createElement('div');
      n.className = 'mg-cards-card';
      n.dataset.uid = String(uid);
      const cv = document.createElement('canvas');
      n.appendChild(cv);
      n._cv = cv;
      n.addEventListener('click', (e) => { e.stopPropagation(); this._clickCard(uid); });
      n.addEventListener('pointerenter', () => this._hover(uid));
      n.addEventListener('pointerleave', () => this._unhover());
      this._nodes.set(uid, n);
    }
    const sig = live
      ? `${def.id}|${live.atk}/${live.hp}|${live.resting ? 'z' : ''}${live.guard ? 'g' : ''}|b`
      : `${def.id}|h`;
    if (n.dataset.sig !== sig) {
      n.dataset.sig = sig;
      if (kind === 'hand') paintCard(n._cv, HAND_PAINT, def, null);
      else paintPlaque(n._cv, PLAQUE_PAINT, def, live);
    }
    return n;
  }

  _liveOf(c, side) {
    return {
      atk: dmgOf(c),
      hp: c.hp,
      guard: c.guard,
      resting: this.S.active === side && !c.ready,
    };
  }

  // ---- render -------------------------------------------------------------
  _render() {
    if (this._dead || !this.S) return;
    this._renderRow(this.el.foeSlots, this.foe);
    this._renderRow(this.el.mySlots, this.me);
    this._renderHand();
    this._renderBacks();
    this._renderStatus();
    this._renderHighlights();
    this._syncStage();
  }

  _renderRow(slots, side) {
    const board = this.S.sides[side].board;
    for (let i = 0; i < BOARD_SLOTS; i++) {
      const slot = slots[i];
      const c = board[i];
      const want = c ? this._cardNode(c.uid, CARDS[c.id], this._liveOf(c, side), 'board') : null;
      for (const child of [...slot.children]) {
        if (child === want || child.classList.contains('mg-cards-stand')) continue;
        if (child.classList.contains('mg-cards-poof') || child.classList.contains('mg-cards-tomb')
          || child.classList.contains('mg-cards-away')) continue;
        child.remove();
      }
      if (want) {
        if (want.parentNode !== slot) slot.appendChild(want);
        const canSwing = side === this.me && this.S.active === this.me && c.ready && dmgOf(c) > 0
          && this.S.winner === null && this.phase === 'play';
        want.classList.toggle('mg-cards-ready', !!canSwing);
      }
    }
  }

  _renderHand() {
    const hand = this.S.sides[this.me].hand;
    const host = this.el.myHand;
    const wanted = [];
    for (const card of hand) {
      const n = this._cardNode(card.uid, CARDS[card.id], null, 'hand');
      n.classList.toggle('mg-cards-poor', CARDS[card.id].cost > this.S.sides[this.me].energy);
      wanted.push(n);
    }
    for (const child of [...host.children]) {
      if (!wanted.includes(child)) child.remove();
    }
    wanted.forEach((n, i) => {
      if (host.children[i] !== n) host.insertBefore(n, host.children[i] || null);
    });
    // uids that left play must not leak nodes
    const alive = new Set(hand.map((c) => c.uid));
    for (const side of [0, 1]) for (const u of unitsOf(this.S.sides[side])) alive.add(u.c.uid);
    for (const uid of [...this._nodes.keys()]) {
      if (!alive.has(uid)) {
        const n = this._nodes.get(uid);
        if (!n.isConnected) this._nodes.delete(uid);
      }
    }
  }

  /** Their hand is a count and nothing else: backs only, never a peek. */
  _renderBacks() {
    const n = this.S.sides[this.foe].hand.length;
    const host = this.el.foeHand;
    while (host.children.length > n) host.lastChild.remove();
    while (host.children.length < n) host.appendChild(document.createElement('i'));
  }

  _pips(host, side) {
    const s = this.S.sides[side];
    while (host.children.length > s.maxEnergy) host.lastChild.remove();
    while (host.children.length < s.maxEnergy) {
      const p = document.createElement('span');
      p.className = 'mg-cards-pip';
      host.appendChild(p);
    }
    [...host.children].forEach((p, i) => p.classList.toggle('mg-cards-full', i < s.energy));
  }

  _renderStatus() {
    const S = this.S;
    const setHp = (fill, text, side) => {
      const s = S.sides[side];
      const p = Math.max(0, s.hp) / s.maxHp;
      fill.style.width = `${(p * 100).toFixed(1)}%`;
      fill.style.background = p > 0.55 ? '#7ac74f' : p > 0.28 ? '#f2b64a' : '#e04a4a';
      text.textContent = `${Math.max(0, s.hp)} / ${s.maxHp}`;
    };
    setHp(this.el.foeHpFill, this.el.foeHpText, this.foe);
    setHp(this.el.myHpFill, this.el.myHpText, this.me);
    this._pips(this.el.foePips, this.foe);
    this._pips(this.el.myPips, this.me);
    this.el.foeDeck.textContent = String(S.sides[this.foe].deck.length);
    this.el.myDeck.textContent = String(S.sides[this.me].deck.length);
    this.el.turnNo.textContent = String(Math.ceil(S.turn / 2));
    this.el.turnWho.textContent = S.active === this.me ? 'YOU' : this.foeTag;
    const mine = this._myTurn();
    this.el.end.disabled = !mine;
    this.el.end.classList.toggle('mg-cards-nudge', mine && !this._anythingToDo());
    this._prompt();
  }

  _renderHighlights() {
    const all = [...this.el.foeSlots, ...this.el.mySlots];
    for (const s of all) s.classList.remove('mg-cards-can');
    this.el.foeCapy.classList.remove('mg-cards-can');
    for (const n of this._nodes.values()) n.classList.remove('mg-cards-sel');
    const sel = this.sel;
    if (!sel || !this._myTurn()) { this._syncSlotGlow(); return; }
    const node = this._nodes.get(sel.uid);
    if (node) node.classList.add('mg-cards-sel');

    if (sel.kind === 'hand') {
      const card = this.S.sides[this.me].hand.find((c) => c.uid === sel.uid);
      if (!card) { this._syncSlotGlow(); return; }
      const d = CARDS[card.id];
      if (d.type === 'critter') {
        this.S.sides[this.me].board.forEach((c, i) => {
          if (!c) this.el.mySlots[i].classList.add('mg-cards-can');
        });
      } else if (d.target) {
        for (const t of spellTargets(this.S, this.me, d)) {
          (t.side === this.me ? this.el.mySlots : this.el.foeSlots)[t.slot].classList.add('mg-cards-can');
        }
      }
      this._syncSlotGlow();
      return;
    }
    // an attacker is picked: every legal victim lights up
    for (const u of unitsOf(this.S.sides[this.foe])) this.el.foeSlots[u.i].classList.add('mg-cards-can');
    if (!guardsUp(this.S, this.foe)) this.el.foeCapy.classList.add('mg-cards-can');
    this._syncSlotGlow();
  }

  /** The slot rings on the table glow with the DOM hit zones above them. */
  _syncSlotGlow() {
    if (!this.stage || !this.el.mySlots) return;
    for (let i = 0; i < BOARD_SLOTS; i++) {
      this.stage.setSlotGlow(this.me, i, this.el.mySlots[i].classList.contains('mg-cards-can'));
      this.stage.setSlotGlow(this.foe, i, this.el.foeSlots[i].classList.contains('mg-cards-can'));
    }
  }

  // ---- prompt line --------------------------------------------------------
  _myTurn() {
    return !!this.S && this.phase === 'play' && this.S.active === this.me
      && this.S.winner === null && !this.busy && !this._frozen;
  }

  _anythingToDo() {
    const S = this.S, s = S.sides[this.me];
    for (const card of s.hand) {
      const d = CARDS[card.id];
      if (d.cost > s.energy) continue;
      if (d.type === 'critter') { if (s.board.indexOf(null) >= 0) return true; }
      else if (!d.target) return true;
      else if (spellTargets(S, this.me, d).length) return true;
    }
    for (const u of unitsOf(s)) if (u.c.ready && dmgOf(u.c) > 0) return true;
    return false;
  }

  _prompt() {
    const p = this.el.prompt;
    if (!p) return;
    if (this._warnUntil && performance.now() < this._warnUntil) return;
    p.classList.remove('mg-cards-warn');
    const S = this.S;
    let msg;
    if (!S) msg = '';
    else if (S.winner !== null) {
      msg = S.winner === this.me ? 'The duel is yours!'
        : S.winner === this.foe ? `${esc(this.foeName)} takes the duel.` : 'A perfectly even duel.';
    } else if (S.active === this.foe) {
      msg = this.mp
        ? `<em>${esc(this.foeName)}</em> is taking their turn...`
        : `<em>${AI_NAME}</em> is thinking it over...`;
    } else if (this.busy) msg = '...';
    else if (!this.sel) {
      msg = this._anythingToDo()
        ? 'Play cards, swing with rested critters, then <em>End Turn</em>.'
        : 'Nothing left to do this turn: hit <em>End Turn</em>.';
    } else if (this.sel.kind === 'hand') {
      const card = S.sides[this.me].hand.find((c) => c.uid === this.sel.uid);
      const d = card ? CARDS[card.id] : null;
      const dot = d && /[!?.]$/.test(d.name) ? '' : '.'; // "Splash!." reads badly
      if (!d) msg = '';
      else if (d.type === 'critter') msg = `Pick an empty slot for <em>${d.name}</em>${dot}`;
      else if (d.target) msg = `Pick a target for <em>${d.name}</em>${dot}`;
      else msg = `Click <em>${d.name}</em> again to cast it.`;
    } else {
      const u = unitsOf(S.sides[this.me]).find((x) => x.c.uid === this.sel.uid);
      const nm = u ? CARDS[u.c.id].name : 'that critter';
      msg = `Pick who <em>${nm}</em> swings at.`;
      if (guardsUp(S, this.foe)) msg += ' Guards block the way to the capy.';
    }
    p.innerHTML = msg;
  }

  _warn(msg) {
    const p = this.el.prompt;
    if (!p) return;
    p.innerHTML = msg;
    p.classList.add('mg-cards-warn');
    this._warnUntil = performance.now() + 1500;
    this._after(1550, () => { this._warnUntil = 0; this._prompt(); });
  }

  _nope(uid, msg) {
    const n = this._nodes.get(uid);
    if (n) {
      n.classList.remove('mg-cards-nope');
      void n.offsetWidth;
      n.classList.add('mg-cards-nope');
      this._after(360, () => n.classList.remove('mg-cards-nope'));
    }
    this.game.audio?.play?.('fail');
    this._warn(msg);
  }

  // ---- input --------------------------------------------------------------
  _deselect() {
    if (!this.sel) return;
    this.sel = null;
    this._renderHighlights();
    this._prompt();
  }

  _hover(uid) {
    const S = this.S;
    if (!S) return;
    const t = performance.now();
    if (t - this._hoverAt > 90) { this._hoverAt = t; this.game.audio?.play?.('hover'); }
    let def = null, live = null;
    const card = S.sides[this.me].hand.find((c) => c.uid === uid);
    if (card) def = CARDS[card.id];
    else {
      for (const side of [0, 1]) {
        const u = unitsOf(S.sides[side]).find((x) => x.c.uid === uid);
        if (u) { def = CARDS[u.c.id]; live = this._liveOf(u.c, side); break; }
      }
    }
    if (!def) return;
    const ins = this.el.inspect;
    ins.innerHTML = '';
    ins.appendChild(cardCanvas(def, 300, live));
    const p = document.createElement('p');
    const bits = [];
    if (def.type === 'critter') {
      for (const kw of ['Guard', 'Swift', 'Splashproof']) {
        if (def.text.includes(kw)) bits.push(`${kw}: ${KEYWORD_HELP[kw]}`);
      }
      if (def.soak) bits.push(`Soak ${def.soak}: ${KEYWORD_HELP.Soak}`);
      if (def.lastSplash) bits.push(`Last Splash: ${KEYWORD_HELP['Last Splash']} This one draws you a card.`);
      if (!bits.length) bits.push(def.flavor);
    } else {
      bits.push(def.text);
      bits.push(def.flavor);
    }
    p.innerHTML = `<b>${def.name} &middot; ${ELEMENTS[def.el].name}</b>${bits.join('<br>')}`;
    ins.appendChild(p);
    ins.classList.add('mg-cards-on');
  }

  _unhover() { this.el.inspect?.classList.remove('mg-cards-on'); }

  _clickCard(uid) {
    if (!this.S || this._blocked()) return;
    if (!this._myTurn()) {
      // mid-animation clicks are just early, not wrong: only nag on their turn
      if (this.S.active !== this.me && this.S.winner === null && !this._frozen) {
        this._warn(this.mp ? `Hold on: it is ${esc(this.foeName)}'s turn.` : 'Wait for your turn.');
      }
      return;
    }
    const S = this.S;
    const card = S.sides[this.me].hand.find((c) => c.uid === uid);
    if (card) return this._clickHandCard(card);
    const mine = unitsOf(S.sides[this.me]).find((u) => u.c.uid === uid);
    if (mine) return this._clickMyUnit(mine);
    const foe = unitsOf(S.sides[this.foe]).find((u) => u.c.uid === uid);
    if (foe) return this._clickFoeUnit(foe);
  }

  _clickHandCard(card) {
    const d = CARDS[card.id];
    const s = this.S.sides[this.me];
    if (this.sel && this.sel.kind === 'hand' && this.sel.uid === card.uid) {
      if (d.type === 'spell' && !d.target) return this._play(card.uid, {});
      return this._deselect();
    }
    if (d.cost > s.energy) return this._nope(card.uid, `${d.name} costs ${d.cost} energy. You have ${s.energy}.`);
    if (d.type === 'critter' && s.board.indexOf(null) < 0) {
      return this._nope(card.uid, 'All four of your slots are busy.');
    }
    if (d.type === 'spell' && d.target && !spellTargets(this.S, this.me, d).length) {
      return this._nope(card.uid, 'There is nothing to aim that at.');
    }
    this.sel = { kind: 'hand', uid: card.uid };
    this.game.audio?.play?.('click');
    this._renderHighlights();
    this._prompt();
  }

  _clickMyUnit(u) {
    const sel = this.sel;
    if (sel && sel.kind === 'hand') {
      const card = this.S.sides[this.me].hand.find((c) => c.uid === sel.uid);
      const d = card ? CARDS[card.id] : null;
      if (d && d.type === 'spell' && d.target
        && spellTargetOk(this.S, this.me, d, { side: this.me, slot: u.i })) {
        return this._play(sel.uid, { target: { side: this.me, slot: u.i } });
      }
      if (d && d.type === 'spell' && d.target) {
        return this._nope(sel.uid, 'That critter cannot be targeted.');
      }
    }
    if (sel && sel.kind === 'unit' && sel.uid === u.c.uid) return this._deselect();
    if (!u.c.ready) return this._nope(u.c.uid, 'That one only just arrived: it swings next turn.');
    if (dmgOf(u.c) <= 0) return this._nope(u.c.uid, 'Pebble Pal has no attack. It only blocks.');
    this.sel = { kind: 'unit', uid: u.c.uid, slot: u.i };
    this.game.audio?.play?.('click');
    this._renderHighlights();
    this._prompt();
  }

  _clickFoeUnit(u) {
    const sel = this.sel;
    if (!sel) { this.game.audio?.play?.('hover'); return; }
    if (sel.kind === 'hand') {
      const card = this.S.sides[this.me].hand.find((c) => c.uid === sel.uid);
      const d = card ? CARDS[card.id] : null;
      if (d && d.type === 'spell' && d.target
        && spellTargetOk(this.S, this.me, d, { side: this.foe, slot: u.i })) {
        return this._play(sel.uid, { target: { side: this.foe, slot: u.i } });
      }
      return this._nope(sel.uid, d && d.type === 'critter' ? 'Critters go in your own empty slots.' : 'Not a legal target.');
    }
    const from = unitsOf(this.S.sides[this.me]).find((x) => x.c.uid === sel.uid);
    if (!from) return this._deselect();
    this._doAttack(from.i, { slot: u.i });
  }

  _clickSlot(side, i) {
    if (this._blocked() || !this._myTurn()) return;
    const sel = this.sel;
    if (!sel) return;
    if (sel.kind === 'hand' && side === this.me && !this.S.sides[this.me].board[i]) {
      const card = this.S.sides[this.me].hand.find((c) => c.uid === sel.uid);
      const d = card ? CARDS[card.id] : null;
      if (d && d.type === 'critter') return this._play(sel.uid, { slot: i });
    }
    this._deselect();
  }

  _clickFace() {
    if (this._blocked() || !this._myTurn() || !this.sel || this.sel.kind !== 'unit') return;
    const from = unitsOf(this.S.sides[this.me]).find((x) => x.c.uid === this.sel.uid);
    if (!from) return this._deselect();
    if (guardsUp(this.S, this.foe)) {
      this.game.audio?.play?.('fail');
      this._warn('Guards first! Knock the Guard critters out before the capy.');
      return;
    }
    this._doAttack(from.i, 'face');
  }

  _key(e) {
    if (this._dead) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key;
    if (this.phase === 'splash' || this.phase === 'over' || this.phase === 'frozen') {
      if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        this.el.over?.querySelector('[data-a="go"],[data-a="again"],[data-a="leave"]')?.click();
      }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); this._deselect(); return; }
    if (this._blocked() || !this._myTurn()) return;
    if (k === 'Enter') { e.preventDefault(); this._endTurnClick(); return; }
    const idx = '12345678'.indexOf(k);
    if (idx >= 0) {
      const card = this.S.sides[this.me].hand[idx];
      if (card) { e.preventDefault(); this._clickHandCard(card); }
    }
  }

  // ---- acting -------------------------------------------------------------
  _play(uid, opts) {
    const hand = this.S.sides[this.me].hand;
    // the wire carries the hand INDEX, so read it before the card leaves
    const hi = hand.findIndex((c) => c.uid === uid);
    const d = hi >= 0 ? CARDS[hand[hi].id] : null;
    if (!d) return;
    // lift the card out of the fan first: the show flies a ghost of it from
    // exactly where it was sitting
    this._flyFrom = this._takeHandNode(uid);
    if (!playCard(this.S, this.me, uid, opts)) { this._warn('That play is not legal.'); return; }
    this._sendMove({
      a: 'play',
      hand: hi,
      slot: Number.isInteger(opts?.slot) ? opts.slot : null,
      target: opts?.target || null,
    });
    this.sel = null;
    this._afterAction();
  }

  /** Take the played card out of the fan and report where it was, so the show
   *  can launch its ghost from the same spot. */
  _takeHandNode(uid) {
    const node = this._nodes.get(uid);
    if (!node) return null;
    let from = null;
    if (this.el.wrap) {
      const r = node.getBoundingClientRect();
      const w = this.el.wrap.getBoundingClientRect();
      if (r.width) {
        from = { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2, w: r.width, h: r.height };
      }
    }
    node.remove();
    this._nodes.delete(uid);
    return from;
  }

  _doAttack(slot, target) {
    if (!canAttack(this.S, this.me, slot, target)) { this._warn('That swing is not legal.'); return; }
    const a = this.S.sides[this.me].board[slot];
    // a swing they never hear about would put the two boards in different
    // duels, so a dead socket stops the swing before it lands
    if (!this._sendMove({ a: 'attack', from: slot, target: target === 'face' ? 'face' : target.slot })) return;
    this.busy = true;
    this.sel = null;
    this._renderHighlights();
    this.stage?.crouch(a.uid); // anticipation now, the leap when the rules agree
    this.game.audio?.play?.('whoosh');
    this._after(170, () => {
      if (this._dead || !this.S || this._frozen) return;
      attack(this.S, this.me, slot, target);
      this.busy = false;
      this._afterAction();
    });
  }

  _endTurnClick() {
    if (this._blocked() || !this._myTurn()) return;
    this.game.audio?.play?.('click');
    this.sel = null;
    if (this.mp) { this._passTurn(); return; }
    this.busy = true;
    endTurn(this.S);
    this._afterAction();
    if (this.S && this.S.winner === null && this.phase === 'play') this._aiTurn();
  }

  _afterAction() {
    if (this._dead || !this.S) return;
    const post = this._consumeFx();
    this._render();
    for (const fn of post) fn();
    this._syncExpr();
    this._checkEnd();
    if (this.mp) {
      this._syncClock();
      // whatever just finished animating may have been holding the queue back;
      // let their moves land at a readable pace rather than all at once
      if (this._rq.length) this._pumpLater(300);
    }
  }

  // ---- AI turn (solo only; a den match drives the other seat over the wire) -
  _aiTurn() {
    if (this.mp) return;
    this.busy = true;
    this._syncExpr();
    this._render();
    this._after(700, () => this._aiStep());
  }

  _aiStep() {
    if (this._dead || !this.S) return;
    if (this.S.winner !== null || this.phase !== 'play') return;
    if (this.S.active !== 1) { this.busy = false; this._render(); return; }
    const a = aiAction(this.S, 1);
    if (!a || a.t === 'end') {
      this._after(420, () => {
        if (this._dead || !this.S) return;
        endTurn(this.S);
        this._afterAction();
        if (this.S && this.S.winner === null && this.phase === 'play') {
          this.busy = false;
          this.game.audio?.play?.('ding');
          this._render();
        }
      });
      return;
    }
    this._performAi(a);
  }

  _nextAiStep(ms) { this._after(ms, () => this._aiStep()); }

  _performAi(a) {
    const S = this.S;
    if (a.t === 'play') {
      const card = S.sides[1].hand.find((c) => c.uid === a.uid);
      const def = card ? CARDS[card.id] : null;
      if (def) this._reveal(def);
      this.game.audio?.play?.('slide');
      this._after(560, () => {
        if (this._dead || !this.S) return;
        if (!applyAction(this.S, 1, a)) endTurn(this.S);
        this.game.audio?.play?.(def && def.type === 'critter' ? 'pop' : 'sparkle');
        this._afterAction();
        this._nextAiStep(620 + Math.floor(Math.random() * 480));
      });
      return;
    }
    const c = S.sides[1].board[a.slot];
    if (c) this.stage?.crouch(c.uid);
    this.game.audio?.play?.('whoosh');
    this._after(190, () => {
      if (this._dead || !this.S) return;
      if (!applyAction(this.S, 1, a)) endTurn(this.S);
      this._afterAction();
      this._nextAiStep(600 + Math.floor(Math.random() * 480));
    });
  }

  _reveal(def) {
    if (!this.el.fx) return;
    const d = document.createElement('div');
    d.className = 'mg-cards-reveal';
    d.appendChild(cardCanvas(def, 260, null));
    this.el.fx.appendChild(d);
    this._after(1100, () => d.remove());
  }

  // ---- den PvP ------------------------------------------------------------
  /**
   * Take our seat at a den table. Anything malformed in the context is not
   * worth guessing about: fall back to a normal solo duel against Pebble.
   */
  _readMatchCtx(ctx) {
    const ps = Array.isArray(ctx.players) ? ctx.players : null;
    const seat = ctx.youAre;
    if (!ps || ps.length !== 2 || (seat !== 0 && seat !== 1) || !Number.isFinite(ctx.seed)) {
      console.warn('[cards] match context looks wrong, dealing a solo duel instead');
      return;
    }
    this.me = seat;
    this.foe = 1 - seat;
    this.mp = {
      players: ps,
      seed: ctx.seed >>> 0,
      myId: ps[seat] ? ps[seat].id : null,
      oppId: ps[1 - seat] ? ps[1 - seat].id : null,
    };
    this.foeName = String((ps[this.foe] && ps[this.foe].name) || 'Rival').slice(0, 14);
    this.foeTag = this.foeName.toUpperCase().slice(0, 9);
    this._bindMatch();
  }

  _bindMatch() {
    const ev = this.game.events;
    this._offs.push(ev.on('match-move', (m) => this._onMatchMove(m)));
    this._offs.push(ev.on('match-end', (m) => this._onMatchEnd(m)));
    this._offs.push(ev.on('net', (s) => {
      if (s === 'offline') {
        this._freeze('The cove went quiet',
          'The connection dropped mid-duel, so the board stops here rather than drifting.');
      }
    }));
  }

  /** Post one intent to the opponent's board. Returns false if it never left. */
  _sendMove(data, quiet = false) {
    if (!this.mp) return true;
    const net = this.game.net;
    if (!net || !net.connected) {
      if (!quiet) {
        this._freeze('The cove went quiet',
          'That move never made it across the table, so the duel stops here.');
      }
      return false;
    }
    net.send({ t: 'match-move', data });
    return true;
  }

  /** Damage dealt, plus the win bonus, exactly like the solo score. */
  _matchScore() {
    if (!this.S) return 0;
    return Math.round(this.S.sides[this.me].dealt) + (this.S.winner === this.me ? 50 : 0);
  }

  /** One verdict per player per match; the server pays if both agree. */
  _reportMatch(winnerId) {
    if (!this.mp || this._matchDoneSent) return;
    this._matchDoneSent = true;
    this.game.net?.send({
      t: 'match-done',
      result: { winner: winnerId || 'draw', score: this._matchScore() },
    });
  }

  _onMatchMove(m) {
    if (!this.mp || this._dead || this._frozen) return;
    if (this.mp.oppId && m && m.from && m.from !== this.mp.oppId) return; // not our table
    const a = m && m.data;
    if (!a || typeof a !== 'object') return;
    if (this._rq.length > 64) { this._desync('their moves piled up'); return; }
    this._rq.push(a);
    this._pump();
  }

  /** One opponent intent at a time, so their turn reads like Pebble's does. */
  _pump() {
    if (this._dead || this._frozen || !this.mp) return;
    if (!this.S || this.phase !== 'play' || this.S.winner !== null) return;
    if (this.busy || !this._rq.length) return;
    this._applyRemote(this._rq.shift());
  }

  _pumpLater(ms) { this._after(ms, () => this._pump()); }

  /** Their intent, replayed through the same rules that judge my own clicks. */
  _applyRemote(a) {
    const S = this.S;
    const foe = this.foe;
    if (a.a === 'resign') { this._oppResigned(); return; }
    if (a.a === 'desync') {
      this._freeze('The boards drifted apart',
        `${this.foeName}'s table stopped agreeing with yours, so the duel is called here.`);
      return;
    }
    if (S.active !== foe) { this._desync('a move out of turn'); return; }

    if (a.a === 'end') {
      endTurn(S);
      this.busy = false;
      this.game.audio?.play?.('ding');
      this._afterAction();
      return;
    }

    if (a.a === 'play') {
      const hand = S.sides[foe].hand;
      const card = Number.isInteger(a.hand) && a.hand >= 0 && a.hand < hand.length ? hand[a.hand] : null;
      const def = card ? CARDS[card.id] : null;
      if (!def) { this._desync('a card that is not in their hand'); return; }
      const opts = {
        slot: Number.isInteger(a.slot) ? a.slot : undefined,
        target: this._remoteTarget(a.target),
      };
      this.busy = true;
      this._reveal(def); // played cards are public: this is the only reveal
      this.game.audio?.play?.('slide');
      this._after(560, () => {
        if (this._dead || !this.S || this._frozen) return;
        this.busy = false;
        if (!playCard(this.S, foe, card.uid, opts)) { this._desync('a play the rules refused'); return; }
        this.game.audio?.play?.(def.type === 'critter' ? 'pop' : 'sparkle');
        this._afterAction();
      });
      return;
    }

    if (a.a === 'attack') {
      const target = a.target === 'face' ? 'face'
        : (Number.isInteger(a.target) ? { slot: a.target } : null);
      if (!Number.isInteger(a.from) || !target || !canAttack(S, foe, a.from, target)) {
        this._desync('a swing the rules refused');
        return;
      }
      const c = S.sides[foe].board[a.from];
      if (c) this.stage?.crouch(c.uid);
      this.busy = true;
      this.game.audio?.play?.('whoosh');
      this._after(190, () => {
        if (this._dead || !this.S || this._frozen) return;
        this.busy = false;
        if (!attack(this.S, foe, a.from, target)) { this._desync('a swing the rules refused'); return; }
        this._afterAction();
      });
      return;
    }
    this._desync('a move nobody recognises');
  }

  /** Spell targets travel as absolute seats so both boards read them alike. */
  _remoteTarget(t) {
    if (!t || typeof t !== 'object') return undefined;
    const { side, slot } = t;
    if ((side !== 0 && side !== 1) || !Number.isInteger(slot) || slot < 0 || slot >= BOARD_SLOTS) {
      return undefined;
    }
    return { side, slot };
  }

  /** PvP end-of-turn: tell them first, then let our own board move on. */
  _passTurn() {
    if (!this.S || this.S.active !== this.me || this.S.winner !== null || this.phase !== 'play') return;
    this.sel = null;
    if (!this._sendMove({ a: 'end' })) return;
    endTurn(this.S);
    this._afterAction();
  }

  _oppResigned() {
    if (!this.S || this.S.winner !== null || this.phase !== 'play') return;
    this._forfeitBy = 'them';
    this._rq.length = 0;
    this.busy = false;
    this.S.winner = this.me;
    this.game.toast?.(`${this.foeName} left the table`);
    this._afterAction();
  }

  /** The server's shared verdict: a forfeit can also arrive mid-board. */
  _onMatchEnd(m) {
    if (!this.mp || this._dead) return;
    if (m && m.game && m.game !== 'cards') return;
    this._matchEnd = m || null;
    this._matchDoneSent = true; // the match is closed; nothing left to report
    if (!this._frozen && m && m.reason === 'forfeit'
      && this.S && this.S.winner === null && this.phase === 'play') {
      const iWon = !!this.mp.myId && m.winner === this.mp.myId;
      this._forfeitBy = iWon ? 'them' : 'me';
      this._rq.length = 0;
      this.busy = false;
      this.S.winner = iWon ? this.me : this.foe;
      this.game.toast?.(iWon ? `${this.foeName} left the table` : 'You left the table');
      this._afterAction();
      return;
    }
    // a forfeit before the first card: there is no duel to award, just a card
    if (!this._frozen && m && m.reason === 'forfeit'
      && this.phase !== 'over' && this.phase !== 'end'
      && (!this.S || this.S.winner === null)) {
      this._frozen = true;
      this.phase = 'frozen';
      this.busy = true;
      this._rq.length = 0;
      this.game.audio?.play?.('fail');
      this.game.toast?.(`${this.foeName} left the table`);
      this._endCard('The table emptied',
        `${this.foeName} stepped away before the first card. Sit down again and the den will find you another duel.`);
      return;
    }
    this._paintMatchBadge();
  }

  /** The den's +30 for a match both boards agreed on, once the server says so. */
  _paintMatchBadge() {
    if (!this.mp || this.phase !== 'over' || !this._matchEnd) return;
    if (!this.mp.myId || this._matchEnd.winner !== this.mp.myId) return;
    const row = this.el.over?.querySelector('[data-el="payrow"]');
    if (!row || row.querySelector('[data-el="bonus"]')) return;
    const d = document.createElement('div');
    d.className = 'mg-cards-stat mg-cards-gold';
    d.dataset.el = 'bonus';
    d.innerHTML = '<b>+30</b><span>DEN MATCH BONUS</span>';
    row.appendChild(d);
    this.game.audio?.play?.('coin');
  }

  /** Never diverge silently: stop the board and say so, on both screens. */
  _desync(why) {
    console.warn('[cards] match desync:', why);
    this._sendMove({ a: 'desync' }, true);
    this._freeze('The boards drifted apart',
      `Your table and ${this.foeName}'s stopped telling the same story, so the duel is called here. No hard feelings.`);
  }

  _freeze(title, sub) {
    if (this._frozen || this._dead || !this.mp) return;
    // a finished duel has already told its story; leave the results card alone
    if (this.phase === 'over' || this.phase === 'end') return;
    if (this.S && this.S.winner !== null) return;
    this._frozen = true;
    this.phase = 'frozen';
    this.busy = true;
    this.sel = null;
    this._rq.length = 0;
    if (this.S) this._render(); // the board stops offering moves it will not take
    this.game.audio?.play?.('fail');
    this.game.toast?.('The duel was called off');
    // pay the half-played run out honestly and call it a draw, so neither
    // board is left waiting on a verdict that is never coming
    if (this.S) {
      this._result = {
        win: false, draw: true,
        myHp: Math.max(0, this.S.sides[this.me].hp),
        foeHp: Math.max(0, this.S.sides[this.foe].hp),
      };
      this.finish(Math.round(this.S.sides[this.me].dealt));
    }
    this._reportMatch('draw');
    this._endCard(title, sub);
  }

  /** A plain "the duel stopped" card: no score theatre, one way out. */
  _endCard(title, sub) {
    const over = this.el.over;
    if (!over) return;
    over.classList.remove('mg-cards-gone');
    over.innerHTML = `
      <div class="mg-cards-modal">
        <h2>${esc(title)}</h2>
        <div class="mg-cards-sub">${esc(sub)}</div>
        <div class="mg-cards-btns">
          <button class="mg-cards-btn mg-cards-alt" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  // ---- turn clock (PvP only) ----------------------------------------------
  _syncClock() {
    if (!this.mp || !this.S) return;
    if (this.S.turn !== this._clockTurn) {
      this._clockTurn = this.S.turn;
      this._clockUntil = performance.now() + TURN_MS;
      this._stallNoted = false;
    }
  }

  _clockLoop() {
    if (this._dead) return;
    this._after(250, () => {
      this._tickClock();
      this._clockLoop();
    });
  }

  _tickClock() {
    const el = this.el.clock;
    if (!el || !this.mp) return;
    const live = !!this.S && this.phase === 'play' && this.S.winner === null && !this._frozen;
    el.classList.toggle('mg-cards-hide', !live);
    if (!live) return;
    const mine = this.S.active === this.me;
    const left = Math.max(0, this._clockUntil - performance.now());
    const secs = Math.ceil(left / 1000);
    this.el.clockNum.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    this.el.clockWho.textContent = mine ? 'YOUR TURN' : 'THEIR TURN';
    el.classList.toggle('mg-cards-low', secs <= 15);
    if (left > 0) return;
    if (mine) {
      if (this.busy || this._rq.length) return; // let the board settle first
      this.game.audio?.play?.('fail');
      this._float('TIME!', this._facePoint(this.me), 'mg-cards-note');
      this.game.toast?.('Time! Your turn passes.');
      this._passTurn();
    } else if (!this._stallNoted && performance.now() - this._clockUntil > STALL_MS) {
      this._stallNoted = true;
      this._warn(`${esc(this.foeName)} has gone very quiet. FORFEIT hands them the duel if you need to go.`);
    }
  }

  _quitClick() {
    this.game.audio?.play?.('click');
    const live = !!this.mp && this.phase === 'play' && !!this.S && this.S.winner === null;
    if (!live) { this.quit(); return; }
    // one click away from handing someone the duel is one click too few
    if (performance.now() < this._quitArmed) { this.quit(); return; }
    this._quitArmed = performance.now() + 3200;
    const btn = this.el.quit;
    btn.textContent = 'SURE?';
    btn.classList.add('mg-cards-armed');
    this._after(3200, () => {
      if (this._dead || !this.el.quit) return;
      this.el.quit.textContent = 'FORFEIT';
      this.el.quit.classList.remove('mg-cards-armed');
    });
  }

  /** PvP opening: who you drew, who moves first, then straight into 3-2-1. */
  _showVersus() {
    this.phase = 'splash';
    const over = this.el.over;
    over.classList.remove('mg-cards-gone');
    const first = this.me === 0;
    const meName = esc((this.game.state?.name || 'You').slice(0, 14));
    const foeName = esc(this.foeName);
    over.innerHTML = `
      <div class="mg-cards-modal">
        <h1>Capy Clash</h1>
        <div class="mg-cards-sub">DEN TABLE &middot; 25 HP EACH &middot; WINNER TAKES THE POT</div>
        <div class="mg-cards-vs">
          <div class="mg-cards-vscap" data-el="vsMe">
            <b>${meName}</b><span>${first ? 'MOVES FIRST' : 'BONUS CARD'}</span>
          </div>
          <div class="mg-cards-vsx">VS</div>
          <div class="mg-cards-vscap" data-el="vsFoe">
            <b>${foeName}</b><span>${first ? 'BONUS CARD' : 'MOVES FIRST'}</span>
          </div>
        </div>
        <div class="mg-cards-sub">${first
          ? 'You have the opening move, so they draw an extra card.'
          : `${foeName} opens, so you start with an extra card.`}</div>
        <div class="mg-cards-btns">${this._fastToggleHtml()}</div>
      </div>`;
    const mine = document.createElement('canvas');
    paintFace(mine, 96, this.myCfg, 'idle');
    over.querySelector('[data-el="vsMe"]').prepend(mine);
    const theirs = document.createElement('canvas');
    paintFace(theirs, 96, this.foeCfg, 'smug');
    over.querySelector('[data-el="vsFoe"]').prepend(theirs);
    this._wireFastToggle(over);
    this.game.audio?.play?.('open');
    this._after(2000, () => this._countdown());
  }

  // ---- fx -----------------------------------------------------------------
  _pointOf(el) {
    const r = el.getBoundingClientRect();
    const w = this.el.wrap.getBoundingClientRect();
    return { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2 };
  }

  _slotPoint(side, slot) {
    const slots = side === this.me ? this.el.mySlots : this.el.foeSlots;
    return this._pointOf(slots[slot]);
  }

  _facePoint(side) { return this._pointOf(side === this.me ? this.el.myCapy : this.el.foeCapy); }

  _float(text, p, cls) {
    if (!this.el.fx) return;
    const d = document.createElement('div');
    d.className = `mg-cards-float ${cls}`;
    d.textContent = text;
    d.style.left = `${p.x}px`;
    d.style.top = `${p.y}px`;
    this.el.fx.appendChild(d);
    this._after(1100, () => d.remove());
  }

  _poofDots(p, color) {
    if (!this.el.fx) return;
    for (let i = 0; i < 10; i++) {
      const d = document.createElement('div');
      d.className = 'mg-cards-poofdot';
      const a = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * 60;
      d.style.setProperty('--dx', `${Math.cos(a) * dist}px`);
      d.style.setProperty('--dy', `${Math.sin(a) * dist - 14}px`);
      d.style.background = color;
      d.style.left = `${p.x}px`;
      d.style.top = `${p.y}px`;
      const s = 7 + Math.random() * 13;
      d.style.width = `${s}px`;
      d.style.height = `${s}px`;
      this.el.fx.appendChild(d);
      this._after(600, () => d.remove());
    }
  }

  _shake(el, cls = 'mg-cards-hit') {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    this._after(420, () => el.classList.remove(cls));
  }

  _flashArrow(from) {
    const a = this.el.tri?.querySelector(`.mg-cards-arrow[data-from="${from}"]`);
    if (!a) return;
    a.classList.remove('mg-cards-flash');
    void a.offsetWidth;
    a.classList.add('mg-cards-flash');
    this._after(700, () => a.classList.remove('mg-cards-flash'));
  }

  /**
   * The one bridge between the rules core and the show.
   *
   * A batch of events almost always starts with an ACTION (summon / swing /
   * cast). That action owns the dramatic beat, so everything after it in the
   * batch (the triangle callout, the damage, the knockouts, the draws) is held
   * back and replayed at the moment the blow actually lands. The duel state is
   * already applied by then: only the pixels are late, which is why PvP timing
   * is untouched.
   */
  _consumeFx() {
    const post = [];
    if (!this.S) return post;
    const fx = this.S.fx.splice(0, this.S.fx.length);
    if (!fx.length) return post;

    let leadIdx = -1;
    for (let i = 0; i < fx.length; i++) {
      const k = fx[i].k;
      if (k === 'summon' || k === 'swing' || k === 'cast') { leadIdx = i; break; }
    }
    if (leadIdx < 0) { this._playFx(fx); return post; }

    const lead = fx[leadIdx];
    const head = fx.slice(0, leadIdx);
    const tail = fx.slice(leadIdx + 1);
    if (head.length) this._playFx(head);

    // hold the tail's death notices out of the DOM sweep that is about to run
    for (const e of tail) {
      if (e.k !== 'die') continue;
      const n = this._nodes.get(e.uid);
      if (n) { n.classList.add('mg-cards-away'); this._nodes.delete(e.uid); }
      // staged either way: reconciliation must not knock it out before the blow
      this._staged.set(e.uid, n || null);
    }
    const fire = this._once(() => this._playFx(tail));
    this._playLead(lead, fx, fire, post);
    return post;
  }

  /** Run `fn` at most once, whoever gets there first (animation or backstop). */
  _once(fn) {
    let spent = false;
    return () => { if (spent || this._dead) return; spent = true; fn(); };
  }

  /** Stage the action itself and arrange for `fire` to run on the payload beat. */
  _playLead(lead, fx, fire, post) {
    const st = this.stage && this.stage.ok ? this.stage : null;

    if (lead.k === 'summon') {
      const def = CARDS[lead.id];
      this._setMood(def.el);
      const uid = lead.uid;
      post.push(() => {
        const n = this._nodes.get(uid);
        if (n) n.style.visibility = 'hidden'; // the plaque arrives with the critter
      });
      this._flyCard(def, lead.side, lead.slot, 'slot');
      const flyMs = this.D(DUR.fly);
      this._staged.set(uid, null); // reconciliation must not spawn it early
      this._after(flyMs, () => {
        st?.slam(lead.side, lead.slot);
        this.game.audio?.play?.('thud');
        this._stingerFor('slam');
        this._quake(0.5);
      });
      const beatMs = flyMs + this.D(DUR.slam);
      this._after(beatMs, () => {
        this._staged.delete(uid);
        st?.spawn(uid, lead.id, lead.side, lead.slot, false);
        this.game.audio?.play?.('sparkle');
        this._stingerFor('summon', def.el);
        const n = this._nodes.get(uid);
        if (n) {
          n.style.visibility = '';
          n.classList.remove('mg-cards-land');
          void n.offsetWidth;
          n.classList.add('mg-cards-land');
        }
      });
      this._after(beatMs + this.D(DUR.beam), fire);
      return;
    }

    if (lead.k === 'swing') {
      const uid = this._attackerUid(lead, fx);
      const foe = 1 - lead.side;
      const face = lead.target === 'face';
      const tSide = face ? foe : lead.target.side;
      const tSlot = face ? -1 : lead.target.slot;
      let dealt = 0;
      for (const e of fx) {
        if (e.k === 'dmg' && e.side === tSide && e.slot === tSlot) dealt += e.amount;
        else if (e.k === 'face' && face && e.side === tSide) dealt += e.amount;
      }
      const attacker = this.S.sides[lead.side].board[lead.slot];
      let el = 'neutral';
      if (attacker) el = attacker.el;
      else {
        const gone = fx.find((e) => e.k === 'die' && e.side === lead.side && e.slot === lead.slot);
        if (gone && CARDS[gone.id]) el = CARDS[gone.id].el;
      }
      const to = new THREE.Vector3();
      if (st) {
        const a = face ? st.bustAnchor(tSide) : st.slotAnchor(tSide, tSlot);
        if (a) { to.copy(a.p); if (face) to.y += a.scale * 0.5; }
      }
      this.game.audio?.play?.('jump');
      const est = st && uid != null
        ? st.strike(uid, to, () => { this._impact(el, tSide, tSlot, dealt, face); fire(); })
        : 0;
      this._after(est + 280, fire);
      return;
    }

    // a spell: the card flies to the middle, then the arena wears the effect
    const def = CARDS[lead.id];
    this._setMood(def.el);
    this._flyCard(def, lead.side, null, 'centre');
    const flyMs = this.D(DUR.fly);
    this._after(flyMs, () => this._castFx(def, lead.side, lead.target));
    this._after(flyMs + Math.round(this.D(DUR.spell) * 0.34), fire);
  }

  /** Whose swing is this? The board may already have reaped them. */
  _attackerUid(lead, fx) {
    const cur = this.S.sides[lead.side].board[lead.slot];
    if (cur) return cur.uid;
    for (const e of fx) {
      if ((e.k === 'dmg' || e.k === 'die') && e.side === lead.side && e.slot === lead.slot) return e.uid;
    }
    return null;
  }

  /** The 90ms freeze, the damage-scaled shake and the element burst. */
  _impact(el, tSide, tSlot, dealt, face) {
    const st = this.stage && this.stage.ok ? this.stage : null;
    const power = Math.max(1, dealt);
    if (!this.reduced) {
      this._blockUntil = performance.now() + this.D(DUR.hitstop);
      st?.hitStop(this.D(DUR.hitstop));
    }
    st?.kick(Math.min(1.6, 0.4 + power * 0.16));
    this._quake(Math.min(1, 0.3 + power * 0.1));
    if (st) {
      const a = face ? st.bustAnchor(tSide) : st.slotAnchor(tSide, tSlot);
      if (a) {
        const c = EL3[el] || EL3.neutral;
        st.emit(a.p, c.mote, 16, { speed: 4.6, up: 3.4, ttl: 520, size: 0.17, gravity: 6, y0: a.scale * 0.4 });
        st.ring(a.p, c.light, this.D(320), 0.5, 2.6);
      }
      if (!face) st.flashSlot(tSide, tSlot, (EL3[el] || EL3.neutral).light);
    }
    this.game.audio?.play?.('thud');
    this._stingerFor('impact', el, power);
  }

  /** Full-board spell silhouettes. Everything here is <= 1.2s. */
  _castFx(def, side, target) {
    const st = this.stage && this.stage.ok ? this.stage : null;
    this.game.audio?.play?.('sparkle');
    this._stingerFor('spell', def.el);
    if (!st) return;
    let at = null;
    if (target && Number.isInteger(target.slot)) {
      const a = st.slotAnchor(target.side, target.slot);
      if (a) at = a.p;
    }
    if (!at) {
      const b = st.bustAnchor(side);
      if (b) at = b.p;
    }
    if (def.id === 'sunburst') st.spell('flare', 'sun', at);
    else if (def.id === 'splash') st.spell('wave', 'sea', at);
    else if (def.id === 'flurry') {
      st.spell('blizzard', 'snow', at);
      const pts = [];
      for (const u of unitsOf(this.S.sides[1 - side])) {
        const a = st.slotAnchor(1 - side, u.i);
        if (a) pts.push(a.p.clone());
      }
      this._after(this.D(280), () => st.icicles(pts));
    } else if (def.id === 'cozy_cocoa') st.spell('blizzard', 'snow', at);
    else st.spell('pillar', def.el, at);
  }

  /** A card leaving a hand: it tumbles across the table and lands face-up. */
  _flyCard(def, side, slot, mode) {
    if (!this.el.fx || !this.el.wrap) return;
    const w = this.el.wrap.getBoundingClientRect();
    let from = this._flyFrom;
    this._flyFrom = null;
    if (!from) {
      const src = this.el.fx.querySelector('.mg-cards-reveal')
        || (side === this.me ? this.el.myHand : this.el.foeHand);
      const r = src ? src.getBoundingClientRect() : null;
      const hw = Math.max(56, w.width * 0.075);
      from = r && r.width
        ? { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2, w: Math.min(r.width, hw * 1.4) }
        : { x: w.width / 2, y: w.height * 0.28, w: hw };
      from.h = from.w * 1.38;
    }
    let tx = w.width / 2, ty = w.height * 0.44, ts = 0.42;
    if (mode === 'slot' && Number.isInteger(slot)) {
      const el = (side === this.me ? this.el.mySlots : this.el.foeSlots)[slot];
      if (el) {
        const r = el.getBoundingClientRect();
        tx = r.left - w.left + r.width / 2;
        ty = r.top - w.top + r.height * 0.78;
        ts = Math.max(0.22, (r.width * 1.1) / Math.max(1, from.w));
      }
    }
    const ghost = document.createElement('div');
    ghost.className = 'mg-cards-flycard';
    ghost.style.left = `${from.x - from.w / 2}px`;
    ghost.style.top = `${from.y - from.h / 2}px`;
    ghost.style.width = `${from.w}px`;
    ghost.style.height = `${from.h}px`;
    ghost.style.setProperty('--tx', `${Math.round(tx - from.x)}px`);
    ghost.style.setProperty('--ty', `${Math.round(ty - from.y)}px`);
    ghost.style.setProperty('--ts', String(ts.toFixed(3)));
    ghost.style.setProperty('--fd', `${this.D(DUR.fly) + this.D(DUR.slam)}ms`);
    ghost.appendChild(cardCanvas(def, HAND_PAINT, null));
    this.el.fx.appendChild(ghost);
    this.game.audio?.play?.('slide');
    this._after(this.D(DUR.fly) + this.D(DUR.slam) + 80, () => ghost.remove());
  }

  _setMood(el) { this.stage?.setMood(el); }

  _stingerFor(kind, el, power) {
    if (this._dead) return;
    if (!this._stinger) this._stinger = new Stinger(this.game);
    try { this._stinger.play(kind, el, power); } catch { /* a dropped sting never breaks a duel */ }
  }

  _quake(mag) {
    if (this.reduced || !this.el.wrap || mag < 0.45) return;
    this._shake(this.el.wrap, 'mg-cards-quake');
  }

  /** The banner-flash callout that teaches the triangle without a tooltip. */
  _banner(text, el) {
    if (!this.el.fx) return;
    const c = ELEMENTS[el] || ELEMENTS.neutral;
    const bg = document.createElement('div');
    bg.className = 'mg-cards-bannerbg';
    bg.style.setProperty('--bc', c.c1);
    const b = document.createElement('div');
    b.className = 'mg-cards-banner';
    b.style.setProperty('--bc', c.c1);
    b.style.color = c.pale;
    b.textContent = text;
    this.el.fx.appendChild(bg);
    this.el.fx.appendChild(b);
    this._after(DUR.banner + 80, () => { bg.remove(); b.remove(); });
  }

  /** Every non-action event, played either at once or on the payload beat. */
  _playFx(list) {
    if (!this.S || !this.el.wrap) return;
    const st = this.stage && this.stage.ok ? this.stage : null;
    let drewFor = -1;
    const sfx = new Set();
    for (const e of list) {
      if (e.k === 'dmg') {
        const p = this._slotPoint(e.side, e.slot);
        this._float(`-${e.amount}`, p, `mg-cards-dmg${e.amount >= 4 ? ' mg-cards-big' : ''}`);
        this._shake(this._nodes.get(e.uid));
        st?.hurtCritter(e.uid, e.amount);
        sfx.add('thud');
      } else if (e.k === 'face') {
        const p = this._facePoint(e.side);
        this._float(`-${e.amount}`, p, `mg-cards-dmg${e.amount >= 4 ? ' mg-cards-big' : ''}`);
        this._shake(e.side === this.me ? this.el.myCapy : this.el.foeCapy);
        this._quake(Math.min(1, 0.3 + e.amount * 0.1));
        st?.flinchBust(e.side, e.amount);
        st?.kick(Math.min(1.4, 0.3 + e.amount * 0.14));
        if (e.src === 'fatigue') this._float('SLEEPY!', { x: p.x, y: p.y - 34 }, 'mg-cards-note');
        this._setExpr(e.side, 'hurt', 900);
        sfx.add('thud');
      } else if (e.k === 'heal') {
        if (e.amount > 0) {
          this._float(`+${e.amount}`, this._facePoint(e.side), 'mg-cards-heal');
          const b = st ? st.bustAnchor(e.side) : null;
          if (b) st.emit(b.p, 0xa8e87a, 14, { speed: 1.1, up: 4.4, ttl: 780, size: 0.14, gravity: -1, spread: 0.6 });
          sfx.add('sparkle');
        }
      } else if (e.k === 'die') {
        this._entomb(e);
        sfx.add('splash');
      } else if (e.k === 'tri') {
        this._flashArrow(e.from);
        this._banner(TRI_CALL[e.from] || 'SUPER!', e.from);
        this._setMood(e.from);
        const p = this._slotPoint(e.side, e.slot);
        this._float(`${ELEMENTS[e.from].name.toUpperCase()} +2`, { x: p.x, y: p.y - 26 }, 'mg-cards-tri');
        st?.flashSlot(e.side, e.slot, (EL3[e.from] || EL3.neutral).light);
        this._stingerFor('tri', e.from);
        sfx.add('ding');
      } else if (e.k === 'buff') {
        this._float('+2 ATK', this._slotPoint(e.side, e.slot), 'mg-cards-heal');
        const a = st ? st.slotAnchor(e.side, e.slot) : null;
        if (a) {
          st.emit(a.p, 0x9be86a, 16, { speed: 0.9, up: 5, ttl: 760, size: 0.14, gravity: -1.4, spread: 0.5 });
          st.ring(a.p, 0x9be86a, this.D(400), 0.5, 2.2);
        }
      } else if (e.k === 'lastsplash') {
        this._float('LAST SPLASH', this._slotPoint(e.side, e.slot), 'mg-cards-note');
      } else if (e.k === 'burn') {
        this._float('HAND FULL', this._pointOf(e.side === this.me ? this.el.myDeck : this.el.foeDeck), 'mg-cards-note');
      } else if (e.k === 'draw') {
        drewFor = e.side;
      }
    }
    if (drewFor >= 0) {
      const deck = drewFor === this.me ? this.el.myDeck : this.el.foeDeck;
      this._shake(deck, 'mg-cards-drawpop');
      this.game.audio?.play?.('tick');
    }
    // one action can fire several events (triangle, damage, a knockout): let
    // them land in a quick stagger instead of collapsing into a single blip
    [...sfx].slice(0, 3).forEach((name, i) => {
      if (i === 0) this.game.audio?.play?.(name);
      else this._after(70 * i, () => this.game.audio?.play?.(name));
    });
  }

  /** Crack, shatter, and slide the greyed card onto the graveyard stack. */
  _entomb(e) {
    const st = this.stage && this.stage.ok ? this.stage : null;
    const koMs = st ? st.koCritter(e.uid) : this.D(DUR.koCrack + DUR.koPause + DUR.koShatter);
    const node = this._staged.get(e.uid) || this._nodes.get(e.uid);
    this._staged.delete(e.uid);
    this._nodes.delete(e.uid);
    const p = this._slotPoint(e.side, e.slot);
    this._poofDots(p, ELEMENTS[CARDS[e.id].el].c1);
    if (!node) return;
    node.classList.remove('mg-cards-away');
    const mine = e.side === this.me;
    // the plaque waits for the crack, then falls onto the stack
    this._after(Math.max(80, Math.round(koMs * 0.55)), () => {
      if (!node.isConnected) return;
      const grave = mine ? this.el.myGrave : this.el.foeGrave;
      const w = this.el.wrap ? this.el.wrap.getBoundingClientRect() : null;
      if (grave && w) {
        const a = node.getBoundingClientRect();
        const b = grave.getBoundingClientRect();
        node.style.setProperty('--tx', `${Math.round(b.left + b.width / 2 - (a.left + a.width / 2))}px`);
        node.style.setProperty('--ty', `${Math.round(b.top + b.height / 2 - (a.top + a.height / 2))}px`);
      }
      node.classList.add('mg-cards-tomb');
      this._after(660, () => {
        node.remove();
        const i = mine ? 0 : 1;
        this._graves[i] += 1;
        const g = mine ? this.el.myGrave : this.el.foeGrave;
        if (g) {
          g.textContent = String(this._graves[i]);
          g.classList.add('mg-cards-any');
          this._shake(g, 'mg-cards-drawpop');
        }
      });
    });
  }

  /**
   * The stage is a view of the board, never a second copy of it: anything the
   * rules say is standing there gets a model, anything that left gets removed.
   * Cards mid-entrance (`_staged`) are exempt so their arrival still plays.
   */
  _syncStage() {
    const st = this.stage;
    if (!st || !st.ok || !this.S) return;
    const seen = new Set();
    for (const side of [0, 1]) {
      const board = this.S.sides[side].board;
      for (let i = 0; i < BOARD_SLOTS; i++) {
        const c = board[i];
        if (!c) continue;
        seen.add(c.uid);
        if (this._staged.has(c.uid)) continue;
        if (st.has(c.uid)) st.moveTo(c.uid, side, i);
        else st.spawn(c.uid, c.id, side, i, true);
      }
    }
    for (const [uid, e] of st.crit) {
      if (seen.has(uid) || e.phase === 'ko' || this._staged.has(uid)) continue;
      st.koCritter(uid);
    }
  }

  // ---- expressions --------------------------------------------------------
  /** `side` is a rules seat; the top portrait is whichever seat is not mine. */
  _setExpr(side, expr, holdMs) {
    if (side === this.foe) {
      if (this.foeExpr !== expr) {
        this.foeExpr = expr;
        this.stage?.setBustExpr(this.foe, expr);
      }
      if (holdMs) {
        this._foeHold = performance.now() + holdMs;
        this._after(holdMs + 20, () => this._syncExpr());
      }
      return;
    }
    if (this.myExpr !== expr) {
      this.myExpr = expr;
      this.stage?.setBustExpr(this.me, expr);
    }
    if (holdMs) {
      this._myHold = performance.now() + holdMs;
      this._after(holdMs + 20, () => this._syncExpr());
    }
  }

  _syncExpr() {
    if (this._dead || !this.S || !this.el.foeFace) return;
    // low HP droops the whole bust, not just the face
    this.stage?.setBustHp(this.me, Math.max(0, this.S.sides[this.me].hp) / this.S.sides[this.me].maxHp);
    this.stage?.setBustHp(this.foe, Math.max(0, this.S.sides[this.foe].hp) / this.S.sides[this.foe].maxHp);
    const S = this.S;
    const now = performance.now();
    if (!(this._foeHold > now)) {
      let e = 'idle';
      if (S.winner === this.foe) e = 'smug';
      else if (S.winner === this.me) e = 'beaten';
      else if (S.sides[this.foe].hp <= 8) e = 'worried';
      else if (S.sides[this.me].hp <= 9 && S.sides[this.foe].hp >= 16) e = 'smug';
      else if (S.active === this.foe) e = 'thinking';
      this._setExpr(this.foe, e);
    }
    if (!(this._myHold > now)) {
      let m = 'idle';
      if (S.winner === this.me) m = 'beam';
      else if (S.winner === this.foe) m = 'beaten';
      else if (S.sides[this.me].hp <= 8) m = 'worried';
      this._setExpr(this.me, m);
    }
  }

  _blinkLoop() {
    if (this._dead) return;
    this._after(2200 + Math.random() * 3400, () => {
      const calm = (x) => x === 'idle' || x === 'thinking';
      const foeWas = this.foeExpr, myWas = this.myExpr;
      if (calm(foeWas)) {
        this._setExpr(this.foe, 'blink');
        this._after(140, () => this._setExpr(this.foe, foeWas));
      }
      if (calm(myWas) && Math.random() < 0.7) {
        this._setExpr(this.me, 'blink');
        this._after(150, () => this._setExpr(this.me, myWas));
      }
      this._blinkLoop();
    });
  }

  // ---- screens ------------------------------------------------------------
  _showSplash(panel = 0) {
    this.phase = 'splash';
    const over = this.el.over;
    over.classList.remove('mg-cards-gone');
    const best = this.game.state?.bests?.cards || 0;
    const last = panel >= 2;
    over.innerHTML = `
      <div class="mg-cards-modal">
        <h1>Capy Clash</h1>
        <div class="mg-cards-sub">${AI_NAME.toUpperCase()} HAS THE TABLE IN THE BACK. 25 HP EACH. LAST CAPY STANDING.</div>
        <div class="mg-cards-panel" data-el="panel"></div>
        <div class="mg-cards-dots">
          <i class="${panel === 0 ? 'mg-cards-on' : ''}"></i>
          <i class="${panel === 1 ? 'mg-cards-on' : ''}"></i>
          <i class="${panel === 2 ? 'mg-cards-on' : ''}"></i>
        </div>
        <div class="mg-cards-stats">
          <div class="mg-cards-stat"><b>${best}</b><span>YOUR BEST</span></div>
          <div class="mg-cards-stat mg-cards-gold"><b>70+</b><span>COINS ON A WIN</span></div>
        </div>
        <div class="mg-cards-btns" style="margin-bottom:8px">${this._fastToggleHtml()}</div>
        <div class="mg-cards-btns">
          ${panel > 0 ? '<button class="mg-cards-btn mg-cards-ghost" data-a="back">Back</button>' : ''}
          <button class="mg-cards-btn" data-a="go">${last ? 'Start the duel' : 'Next'}</button>
          ${last ? '' : '<button class="mg-cards-btn mg-cards-alt" data-a="skip">Skip, I know cards</button>'}
          <button class="mg-cards-btn mg-cards-ghost" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    this._fillPanel(over.querySelector('[data-el="panel"]'), panel);
    this._wireFastToggle(over);
    over.querySelector('[data-a="go"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      if (last) this._countdown(); else this._showSplash(panel + 1);
    });
    over.querySelector('[data-a="back"]')?.addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this._showSplash(panel - 1);
    });
    over.querySelector('[data-a="skip"]')?.addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this._countdown();
    });
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
  }

  /** Fast mode halves every duration constant in the show; the rules never move. */
  _fastToggleHtml() {
    return `<button class="mg-cards-toggle${this.fast ? ' mg-cards-on' : ''}" data-a="fast" type="button">
      <i></i>FAST MODE</button>`;
  }

  _wireFastToggle(over) {
    const b = over.querySelector('[data-a="fast"]');
    if (!b) return;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.fast = !this.fast;
      b.classList.toggle('mg-cards-on', this.fast);
      this.stage?.setSpeed(this.fast ? 0.5 : 1);
      this.game.audio?.play?.('click');
    });
  }

  _fillPanel(host, i) {
    const art = document.createElement('div');
    art.className = 'mg-cards-panelart';
    const words = document.createElement('div');
    if (i === 0) {
      const pips = document.createElement('div');
      pips.className = 'mg-cards-pips';
      pips.style.maxWidth = '60px';
      for (let k = 0; k < 4; k++) {
        const s = document.createElement('span');
        s.className = `mg-cards-pip${k < 3 ? ' mg-cards-full' : ''}`;
        pips.appendChild(s);
      }
      const cv = cardCanvas(CARDS.sunny_pup, 260, null);
      cv.style.width = '104px';
      cv.style.height = 'auto';
      art.appendChild(cv);
      art.appendChild(pips);
      words.innerHTML = `<h3>1. Energy and critters</h3>
        <p>Your energy gem grows every turn (1, 2, 3... up to 8) and refills at the
        start of your turn. The number in a card's corner is what it costs.</p>
        <p>Click a critter in hand, then click one of your four empty slots.
        It naps the turn it arrives, unless it has <b>Swift</b>.</p>`;
    } else if (i === 1) {
      const a = cardCanvas(CARDS.surf_scout, 260, { atk: 3, hp: 2, guard: false, resting: false });
      const b = cardCanvas(CARDS.puddle_sitter, 260, { atk: 1, hp: 3, guard: true, resting: false });
      for (const cv of [a, b]) { cv.style.width = '92px'; cv.style.height = 'auto'; }
      const arrow = document.createElement('div');
      arrow.className = 'mg-cards-arrowbig';
      arrow.textContent = '▸';
      art.appendChild(a); art.appendChild(arrow); art.appendChild(b);
      words.innerHTML = `<h3>2. Swinging and Guard</h3>
        <p>Click a rested critter, then click what it hits. Both critters deal
        their attack at the same time, so pick your trades.</p>
        <p>Aim at the enemy capy to burn HP. A critter with <b>Guard</b> has to be
        knocked out before the capy can be touched.</p>`;
    } else {
      const rink = document.createElement('div');
      rink.className = 'mg-cards-trirink';
      rink.style.flexDirection = 'column';
      const chain = [['sun', 'snow'], ['snow', 'sea'], ['sea', 'sun']];
      for (const [from, to] of chain) {
        const row = document.createElement('div');
        row.className = 'mg-cards-trirink';
        row.appendChild(elemIconCanvas(from, 34));
        const ar = document.createElement('span');
        ar.className = 'mg-cards-arrowbig';
        ar.textContent = '▸';
        row.appendChild(ar);
        row.appendChild(elemIconCanvas(to, 34));
        const plus = document.createElement('span');
        plus.style.cssText = 'font-weight:900;color:#e0982a;font-size:15px';
        plus.textContent = '+2';
        row.appendChild(plus);
        rink.appendChild(row);
      }
      art.appendChild(rink);
      words.innerHTML = `<h3>3. The element triangle</h3>
        <p><b>Sun</b> beats <b>Snow</b>, <b>Snow</b> beats <b>Sea</b>, <b>Sea</b>
        beats <b>Sun</b>. Swing (or aim a spell) into the element you beat and it
        lands for <b>+2 damage</b>.</p>
        <p>Cozy brown critters are neutral: no bonus either way. Hover any card to
        read it up close.</p>`;
    }
    host.innerHTML = '';
    host.appendChild(art);
    host.appendChild(words);
  }

  _countdown() {
    if (this._dead || this._frozen) return;
    this.phase = 'countdown';
    const over = this.el.over;
    over.classList.remove('mg-cards-gone');
    const steps = ['3', '2', '1', 'DUEL!'];
    const show = (i) => {
      if (this._dead || this._frozen) return;
      if (i >= steps.length) {
        over.classList.add('mg-cards-gone');
        over.innerHTML = '';
        this._startDuel();
        return;
      }
      over.innerHTML = `<div class="mg-cards-count">${steps[i]}</div>`;
      this.game.audio?.play?.(i === steps.length - 1 ? 'success' : 'ding');
      this._after(i === steps.length - 1 ? 460 : 560, () => show(i + 1));
    };
    show(0);
  }

  _startDuel() {
    this._nodes.clear();
    this._staged.clear();
    this._flyFrom = null;
    this._blockUntil = 0;
    this._finishing = false;
    this.el.wrap?.classList.remove('mg-cards-cam');
    this.el.white?.classList.remove('mg-cards-on');
    this.el.myHand.innerHTML = '';
    for (const s of [...this.el.foeSlots, ...this.el.mySlots]) {
      for (const child of [...s.children]) {
        if (!child.classList.contains('mg-cards-stand')) child.remove();
      }
    }
    this.el.fx.innerHTML = '';
    this._graves = [0, 0];
    for (const g of [this.el.myGrave, this.el.foeGrave]) {
      if (!g) continue;
      g.textContent = '0';
      g.classList.remove('mg-cards-any');
    }
    if (this.stage) {
      for (const uid of [...this.stage.crit.keys()]) this.stage.removeCritter(uid);
      this.stage.pinBusts = true;
      this.stage.finishRun = null;
      this.stage.setSpeed(this.fast ? 0.5 : 1);
      this._measureStage();
    }
    this.sel = null;
    this.busy = false;
    this._warnUntil = 0;
    this._foeHold = 0;
    this._myHold = 0;
    this._result = null;
    this.phase = 'play';
    // PvP: same seed, same shuffle, same duel on both sides of the table
    this.S = this.mp ? newPvpDuel(this.mp.seed) : newDuel();
    this._consumeFx();
    this._render();
    this._syncExpr();
    this.game.audio?.play?.('open');
    if (this.mp) {
      this._clockTurn = -1;
      this._syncClock();
      this._pump(); // their opening move may already be waiting on us
    }
  }

  _checkEnd() {
    if (!this.S || this.S.winner === null || this.phase !== 'play') return;
    this.phase = 'end';
    this.busy = true;
    this.sel = null;
    this._rq.length = 0;
    this._renderHighlights();
    this.game.audio?.play?.(this.S.winner === this.me ? 'success' : 'fail');
    this._finishCam();
  }

  /**
   * The lethal blow: a brief slow-mo push onto the losing bust, a whiteout, and
   * only then the results card. The winner's survivors cheer through it.
   */
  _finishCam() {
    const S = this.S;
    const draw = S.winner === 'draw';
    const winner = draw ? null : S.winner;
    const loser = draw ? this.foe : 1 - winner;
    this._finishing = true;
    this.el.wrap?.classList.add('mg-cards-cam');
    const camMs = this.D(DUR.finish);
    if (this.stage) {
      this.stage.finishCam(loser, camMs);
      if (winner !== null) {
        this.stage.cheerAll(winner);
        this.stage.cheerBust(winner);
      }
    }
    this._stingerFor('finish', winner === this.me ? 'sun' : 'sea');
    this._after(camMs, () => {
      this.el.white?.classList.add('mg-cards-on');
      this._after(this.D(DUR.white), () => {
        this._finishing = false;
        this.el.wrap?.classList.remove('mg-cards-cam');
        this._results();
        this._after(60, () => this.el.white?.classList.remove('mg-cards-on'));
      });
    });
  }

  _results() {
    if (this._dead || !this.S) return;
    this.phase = 'over';
    const S = this.S;
    const win = S.winner === this.me;
    const draw = S.winner === 'draw';
    const dealt = Math.round(S.sides[this.me].dealt);
    const score = dealt + (win ? 50 : 0);
    this._result = {
      win, draw, dealt,
      forfeit: this._forfeitBy === 'them',
      myHp: Math.max(0, S.sides[this.me].hp),
      foeHp: Math.max(0, S.sides[this.foe].hp),
    };
    // the den only pays the match bonus when both boards name the same winner
    if (this.mp) this._reportMatch(draw ? 'draw' : (win ? this.mp.myId : this.mp.oppId));
    const prevBest = this.game.state?.bests?.cards || 0;
    const isBest = score > prevBest;
    const coins = this._payout();
    this.finish(score);
    const shown = Math.max(prevBest, score);
    this.game.audio?.play?.(win ? 'levelup' : 'ding');
    if (coins > 0) this._after(320, () => this.game.audio?.play?.('coin'));

    const face = document.createElement('canvas');
    paintFace(face, 84, win ? this.myCfg : this.foeCfg, win ? 'beam' : 'smug');

    const over = this.el.over;
    over.classList.remove('mg-cards-gone');
    over.innerHTML = `
      <div class="mg-cards-modal">
        ${isBest ? '<div class="mg-cards-ribbon">NEW PERSONAL BEST</div>' : ''}
        <div class="mg-cards-winner" data-el="winface"></div>
        <h2>${win ? 'You win the duel!' : draw ? 'A dead heat!' : `${esc(this.foeName)} wins`}</h2>
        <div class="mg-cards-sub">${this._verdict(win, draw)}</div>
        <div class="mg-cards-stats" data-el="payrow">
          <div class="mg-cards-stat"><b>${score}</b><span>SCORE</span></div>
          <div class="mg-cards-stat mg-cards-gold"><b>${coins}</b><span>COINS</span></div>
          <div class="mg-cards-stat"><b>${shown}</b><span>BEST</span></div>
        </div>
        <div class="mg-cards-stats">
          <div class="mg-cards-stat"><b>${dealt}</b><span>DAMAGE DEALT</span></div>
          <div class="mg-cards-stat"><b>${this._result.myHp}</b><span>HP LEFT</span></div>
          <div class="mg-cards-stat"><b>${Math.ceil(S.turn / 2)}</b><span>TURNS</span></div>
        </div>
        <div class="mg-cards-btns">
          ${this.mp ? '' : '<button class="mg-cards-btn" data-a="again">Play again</button>'}
          <button class="mg-cards-btn mg-cards-alt" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    over.querySelector('[data-el="winface"]').appendChild(face);
    over.querySelector('[data-a="again"]')?.addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this._done = false; // let the next duel report its own score
      this._countdown();
    });
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
    this._paintMatchBadge();
  }

  _verdict(win, draw) {
    const r = this._result;
    if (this.mp) {
      const who = esc(this.foeName.toUpperCase());
      if (this._forfeitBy === 'them') return `${who} LEFT THE TABLE. THE DEN AWARDS YOU THE DUEL.`;
      if (this._forfeitBy === 'me') return 'YOU STEPPED AWAY FROM THE TABLE.';
      if (draw) return 'BOTH CAPYS FLOPPED OVER AT ONCE. THE DEN IS BAFFLED.';
      if (win && r.myHp >= 20) return `${who} NEVER GOT COMFORTABLE. MASTERFUL.`;
      if (win && r.myHp >= 10) return 'A PROPER DUEL. THE WHOLE DEN IS TALKING ABOUT IT.';
      if (win) return 'ONE HP FROM DISASTER, AND YOU TOOK IT ANYWAY.';
      if (r.foeHp < 6) return `SO CLOSE. ${who} WAS ONE SWING FROM THE FLOOR.`;
      if (r.foeHp < 16) return 'A REAL SCRAP. SIT BACK DOWN AND RUN IT AGAIN.';
      return `${who} HAD AN ANSWER FOR EVERYTHING TODAY. REMATCH?`;
    }
    if (draw) return 'BOTH CAPYS FLOPPED OVER AT ONCE. THE DEN IS BAFFLED.';
    if (win && r.myHp >= 20) return 'PEBBLE BARELY GOT A CARD DOWN. MASTERFUL.';
    if (win && r.myHp >= 10) return 'A PROPER DUEL. THE DEN IS TALKING ABOUT IT.';
    if (win) return 'ONE HP FROM DISASTER, AND YOU TOOK IT ANYWAY.';
    if (r.foeHp < 10) return 'SO CLOSE. PEBBLE ADJUSTS THE MONOCLE, POLITELY.';
    if (r.foeHp < 18) return 'A REAL SCRAP. THE TRIANGLE IS THE TRICK: SWING INTO WHAT YOU BEAT.';
    return 'PEBBLE HAS BEEN PLAYING SINCE BEFORE THE COVE HAD A NAME. AGAIN?';
  }
}
