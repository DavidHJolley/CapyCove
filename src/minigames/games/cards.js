import { Minigame } from '../minigame.js';
import { clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Capy Clash : the Game Den's flagship 1v1 card duel (docs/CARDGAME.md).
 *
 * Pure DOM + 2D canvas (no WebGL). Every card face, capybara portrait and
 * element icon is drawn procedurally on a canvas; the table is CSS art.
 *
 * The rules live in a DOM-free core near the top of this file so the AI can be
 * played against itself headlessly for balance work:
 *
 *   node --input-type=module -e "const m = await import('file:///D:/projects/ClubNotPenguin/src/minigames/games/cards.js'); console.log(m.simulateDuels(200));"
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

/** side 0 is the human (always first), side 1 is the AI. */
export function newDuel(rng = Math.random) {
  const S = {
    rng, uid: 1, turn: 0, active: 0, winner: null, fx: [],
    sides: [mkSide(shuffle(starterDeck(), rng)), mkSide(shuffle(starterDeck(), rng))],
  };
  for (let i = 0; i < START_HAND; i++) { drawCards(S, 0, 1); drawCards(S, 1, 1); }
  drawCards(S, 1, 1); // second-player compensation
  S.fx.length = 0;
  beginTurn(S, 0);
  return S;
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

// ===========================================================================
// STYLE
// ===========================================================================
const STYLE = `
.mg-cards-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#3a2a1c;user-select:none;
  -webkit-user-select:none;cursor:default;
  --bw:clamp(60px,10.2vh,116px);--bh:calc(var(--bw)*1.38);
  --hw:clamp(70px,12.2vh,138px);--hh:calc(var(--hw)*1.38);}
.mg-cards-root *{box-sizing:border-box;}
.mg-cards-root.mg-cards-quake{animation:mg-cards-quake .4s ease;}
@keyframes mg-cards-quake{0%,100%{transform:translate(0,0)}20%{transform:translate(-8px,4px)}
  40%{transform:translate(7px,-5px)}60%{transform:translate(-5px,-3px)}80%{transform:translate(4px,3px)}}

/* ---- den backdrop ---- */
.mg-cards-bg{position:absolute;inset:0;
  background:
    radial-gradient(ellipse 55% 40% at 50% 8%, rgba(255,232,178,.34), rgba(255,232,178,0) 72%),
    repeating-linear-gradient(90deg, rgba(60,34,10,.16) 0 4px, rgba(0,0,0,0) 4px 96px),
    linear-gradient(180deg,#7d5233 0%,#5d3b23 60%,#452b19 100%);}
.mg-cards-felt{position:absolute;inset:clamp(6px,1.3vh,16px);border-radius:26px;
  border:clamp(6px,1vh,11px) solid #7a4a29;
  background:
    radial-gradient(ellipse 70% 55% at 50% 46%, #4b7c57 0%, #3a6144 58%, #2c4a35 100%);
  box-shadow:inset 0 0 70px rgba(12,26,16,.55),0 12px 30px rgba(0,0,0,.4);}
.mg-cards-felt::after{content:"";position:absolute;inset:10px;border-radius:18px;
  border:2px dashed rgba(255,246,227,.16);}
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

/* ---- table ---- */
.mg-cards-table{position:relative;z-index:5;flex:1;min-height:0;display:flex;flex-direction:column;
  align-items:center;justify-content:space-between;padding:0 clamp(8px,2vw,26px) clamp(6px,1.4vh,14px);gap:clamp(2px,.7vh,8px);}
.mg-cards-bar{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;}
.mg-cards-capy{display:flex;align-items:center;gap:9px;padding:5px 12px 5px 6px;border-radius:999px;
  background:rgba(30,20,12,.42);box-shadow:inset 0 0 0 2px rgba(255,246,227,.16);transition:.16s;}
.mg-cards-capy canvas{display:block;filter:drop-shadow(0 4px 6px rgba(0,0,0,.35));
  animation:mg-cards-breathe 3.2s ease-in-out infinite;}
@keyframes mg-cards-breathe{50%{transform:translateY(-3px) scale(1.02)}}
.mg-cards-capy b{display:block;font-size:13px;color:#fff6e3;letter-spacing:.03em;white-space:nowrap;}
.mg-cards-hp{margin-top:4px;width:clamp(90px,13vw,150px);height:15px;border-radius:999px;
  background:rgba(10,20,14,.55);box-shadow:inset 0 2px 4px rgba(0,0,0,.4);position:relative;overflow:hidden;}
.mg-cards-hp i{position:absolute;inset:0;width:100%;border-radius:999px;background:#7ac74f;
  transition:width .45s cubic-bezier(.2,1.35,.4,1),background .3s;}
.mg-cards-hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:900;color:#fffdf6;text-shadow:0 1px 2px rgba(0,0,0,.55);letter-spacing:.04em;}
.mg-cards-capy.mg-cards-can{box-shadow:inset 0 0 0 3px #f2b64a,0 0 0 6px rgba(242,182,74,.28);cursor:pointer;
  animation:mg-cards-pulse 1s ease-in-out infinite;}
.mg-cards-capy.mg-cards-hit{animation:mg-cards-shake .4s ease;}
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

.mg-cards-backs{display:flex;gap:2px;height:44px;align-items:center;}
.mg-cards-backs i{display:block;width:24px;height:34px;border-radius:4px;margin-left:-8px;
  background:linear-gradient(150deg,#c9744f,#8a4a2c);box-shadow:inset 0 0 0 2px #6d3a20,0 2px 4px rgba(0,0,0,.35);}
.mg-cards-backs i:first-child{margin-left:0;}

/* ---- rows of slots ---- */
.mg-cards-row{display:flex;gap:clamp(6px,1.2vw,16px);justify-content:center;}
.mg-cards-slot{position:relative;width:var(--bw);height:var(--bh);border-radius:12px;
  background:rgba(16,32,22,.34);box-shadow:inset 0 0 0 2px rgba(255,246,227,.14);transition:.18s;}
.mg-cards-slot.mg-cards-can{background:rgba(242,182,74,.22);
  box-shadow:inset 0 0 0 3px #f2b64a,0 0 16px rgba(242,182,74,.45);cursor:pointer;
  animation:mg-cards-pulse 1s ease-in-out infinite;}
.mg-cards-card{position:absolute;inset:0;border-radius:11px;cursor:pointer;
  transition:transform .16s cubic-bezier(.2,1.35,.4,1),filter .16s;}
.mg-cards-card canvas{display:block;width:100%;height:100%;border-radius:11px;
  filter:drop-shadow(0 4px 6px rgba(0,0,0,.4));}
.mg-cards-card.mg-cards-land{animation:mg-cards-land .4s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-cards-land{from{transform:translateY(-40px) scale(.6) rotate(-8deg);opacity:0}
  70%{transform:translateY(4px) scale(1.06)}}
.mg-cards-card.mg-cards-ready:hover{transform:translateY(-5px) scale(1.04);}
.mg-cards-card.mg-cards-ready::after{content:"";position:absolute;inset:-3px;border-radius:13px;
  box-shadow:0 0 0 3px rgba(122,199,79,.85);pointer-events:none;}
.mg-cards-card.mg-cards-sel{transform:translateY(-8px) scale(1.06);z-index:6;
  filter:drop-shadow(0 0 12px rgba(242,182,74,.9));animation:mg-cards-pulse .9s ease-in-out infinite;}
.mg-cards-card.mg-cards-poof{animation:mg-cards-poof .42s ease-in forwards;pointer-events:none;}
@keyframes mg-cards-poof{40%{transform:scale(1.12) rotate(3deg)}
  to{transform:scale(.35) rotate(-14deg) translateY(18px);opacity:0}}
.mg-cards-card.mg-cards-lungeUp{animation:mg-cards-lungeUp .34s ease-in-out;}
@keyframes mg-cards-lungeUp{50%{transform:translateY(-26px) scale(1.08)}}
.mg-cards-card.mg-cards-lungeDown{animation:mg-cards-lungeDown .34s ease-in-out;}
@keyframes mg-cards-lungeDown{50%{transform:translateY(26px) scale(1.08)}}
.mg-cards-card.mg-cards-hit{animation:mg-cards-shake .34s ease;}

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
.mg-cards-hand .mg-cards-card:hover{transform:translateY(-16px) scale(1.06);z-index:7;}
.mg-cards-hand .mg-cards-card.mg-cards-sel{transform:translateY(-22px) scale(1.1);z-index:8;}
.mg-cards-hand .mg-cards-card.mg-cards-poor canvas{filter:grayscale(.55) brightness(.78)
  drop-shadow(0 4px 6px rgba(0,0,0,.4));}
.mg-cards-hand .mg-cards-card.mg-cards-nope{animation:mg-cards-shake .34s ease;}
.mg-cards-flycard{position:absolute;pointer-events:none;z-index:11;
  animation:mg-cards-fly .34s ease-in forwards;}
.mg-cards-flycard canvas{width:100%;height:100%;display:block;border-radius:11px;
  filter:drop-shadow(0 6px 10px rgba(0,0,0,.45));}
@keyframes mg-cards-fly{to{transform:translateY(-80px) scale(.5) rotate(-6deg);opacity:0}}

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
  .mg-cards-btns{margin-top:2px;gap:8px;}
  .mg-cards-btn{padding:7px 17px;font-size:12.5px;border-width:3px;}
}
`;

// ===========================================================================
// THE GAME
// ===========================================================================
const BOARD_PAINT = 220;
const HAND_PAINT = 260;
const FOE_FACE = 92;
const MY_FACE = 66;
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
  }

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
    };

    this._buildTriangleBadge();
    this.el.foeSlots = this._buildSlots(this.el.foeBoard, 1);
    this.el.mySlots = this._buildSlots(this.el.myBoard, 0);

    this.foeCfg = { color: '#8a6642', hat: 'tophat', hatColor: '#4fb3e8', monocle: true };
    const body = hexOf(this.game.state?.color ?? 0xb08a5a);
    this.myCfg = {
      color: body,
      hat: this.game.state?.hat || 'none',
      hatColor: pickHatColor(body, (this.game.state?.name || 'capy').length),
    };
    this.el.myName.textContent = (this.game.state?.name || 'You').slice(0, 14);
    paintFace(this.el.foeFace, FOE_FACE, this.foeCfg, 'idle');
    paintFace(this.el.myFace, MY_FACE, this.myCfg, 'idle');

    this.el.end.addEventListener('click', () => this._endTurnClick());
    this.el.foeCapy.addEventListener('click', () => this._clickFace());
    wrap.querySelector('[data-el="quit"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.classList?.contains('mg-cards-table')) this._deselect();
    });

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey);

    this._blinkLoop();
    this._showSplash();
  }

  dispose() {
    this._dead = true;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    this._onKey = null;
    this._nodes.clear();
    this.el = {};
    this.S = null;
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
    if (r.win) return 70 + Math.floor(r.myHp / 2);
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

      <div class="mg-cards-hud">
        <div class="mg-cards-chip mg-cards-title">CAPY CLASH</div>
        <div class="mg-cards-chip"><small>TURN</small><b data-el="turnNo">1</b>
          <small data-el="turnWho">YOU</small></div>
        <div class="mg-cards-chip mg-cards-tri" data-el="tri"></div>
        <div class="mg-cards-spacer"></div>
        <button class="mg-cards-quit" data-el="quit">QUIT</button>
      </div>

      <div class="mg-cards-table">
        <div class="mg-cards-bar">
          <div class="mg-cards-endcap">
            <div class="mg-cards-deck" data-el="foeDeck">24</div>
            <div class="mg-cards-pips" data-el="foePips"></div>
          </div>
          <div class="mg-cards-capy" data-el="foeCapy">
            <canvas data-el="foeFace"></canvas>
            <div>
              <b>${AI_NAME}</b>
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
            <div class="mg-cards-capy" data-el="myCapy">
              <canvas data-el="myFace"></canvas>
              <div>
                <b data-el="myName">You</b>
                <div class="mg-cards-hp"><i data-el="myHpFill"></i><span data-el="myHpText">25</span></div>
              </div>
            </div>
          </div>
          <div class="mg-cards-endcap" style="justify-content:center;flex:none">
            <div class="mg-cards-pips" data-el="myPips"></div>
            <div class="mg-cards-deck" data-el="myDeck">24</div>
            <button class="mg-cards-end" data-el="end">END TURN</button>
          </div>
          <div class="mg-cards-endcap mg-cards-right"></div>
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
      paintCard(n._cv, kind === 'hand' ? HAND_PAINT : BOARD_PAINT, def, live);
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
    this._renderRow(this.el.foeSlots, 1);
    this._renderRow(this.el.mySlots, 0);
    this._renderHand();
    this._renderBacks();
    this._renderStatus();
    this._renderHighlights();
  }

  _renderRow(slots, side) {
    const board = this.S.sides[side].board;
    for (let i = 0; i < BOARD_SLOTS; i++) {
      const slot = slots[i];
      const c = board[i];
      const want = c ? this._cardNode(c.uid, CARDS[c.id], this._liveOf(c, side), 'board') : null;
      for (const child of [...slot.children]) {
        if (child !== want && !child.classList.contains('mg-cards-poof')) child.remove();
      }
      if (want) {
        if (want.parentNode !== slot) slot.appendChild(want);
        const canSwing = side === 0 && this.S.active === 0 && c.ready && dmgOf(c) > 0
          && this.S.winner === null && this.phase === 'play';
        want.classList.toggle('mg-cards-ready', !!canSwing);
      }
    }
  }

  _renderHand() {
    const hand = this.S.sides[0].hand;
    const host = this.el.myHand;
    const wanted = [];
    for (const card of hand) {
      const n = this._cardNode(card.uid, CARDS[card.id], null, 'hand');
      n.classList.toggle('mg-cards-poor', CARDS[card.id].cost > this.S.sides[0].energy);
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

  _renderBacks() {
    const n = this.S.sides[1].hand.length;
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
    setHp(this.el.foeHpFill, this.el.foeHpText, 1);
    setHp(this.el.myHpFill, this.el.myHpText, 0);
    this._pips(this.el.foePips, 1);
    this._pips(this.el.myPips, 0);
    this.el.foeDeck.textContent = String(S.sides[1].deck.length);
    this.el.myDeck.textContent = String(S.sides[0].deck.length);
    this.el.turnNo.textContent = String(Math.ceil(S.turn / 2));
    this.el.turnWho.textContent = S.active === 0 ? 'YOU' : 'PEBBLE';
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
    if (!sel || !this._myTurn()) return;
    const node = this._nodes.get(sel.uid);
    if (node) node.classList.add('mg-cards-sel');

    if (sel.kind === 'hand') {
      const card = this.S.sides[0].hand.find((c) => c.uid === sel.uid);
      if (!card) return;
      const d = CARDS[card.id];
      if (d.type === 'critter') {
        this.S.sides[0].board.forEach((c, i) => {
          if (!c) this.el.mySlots[i].classList.add('mg-cards-can');
        });
      } else if (d.target) {
        for (const t of spellTargets(this.S, 0, d)) {
          (t.side === 0 ? this.el.mySlots : this.el.foeSlots)[t.slot].classList.add('mg-cards-can');
        }
      }
      return;
    }
    // an attacker is picked: every legal victim lights up
    for (const u of unitsOf(this.S.sides[1])) this.el.foeSlots[u.i].classList.add('mg-cards-can');
    if (!guardsUp(this.S, 1)) this.el.foeCapy.classList.add('mg-cards-can');
  }

  // ---- prompt line --------------------------------------------------------
  _myTurn() {
    return !!this.S && this.phase === 'play' && this.S.active === 0
      && this.S.winner === null && !this.busy;
  }

  _anythingToDo() {
    const S = this.S, s = S.sides[0];
    for (const card of s.hand) {
      const d = CARDS[card.id];
      if (d.cost > s.energy) continue;
      if (d.type === 'critter') { if (s.board.indexOf(null) >= 0) return true; }
      else if (!d.target) return true;
      else if (spellTargets(S, 0, d).length) return true;
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
      msg = S.winner === 0 ? 'The duel is yours!' : S.winner === 1 ? `${AI_NAME} takes the duel.` : 'A perfectly even duel.';
    } else if (S.active === 1) msg = `<em>${AI_NAME}</em> is thinking it over...`;
    else if (this.busy) msg = '...';
    else if (!this.sel) {
      msg = this._anythingToDo()
        ? 'Play cards, swing with rested critters, then <em>End Turn</em>.'
        : 'Nothing left to do this turn: hit <em>End Turn</em>.';
    } else if (this.sel.kind === 'hand') {
      const card = S.sides[0].hand.find((c) => c.uid === this.sel.uid);
      const d = card ? CARDS[card.id] : null;
      const dot = d && /[!?.]$/.test(d.name) ? '' : '.'; // "Splash!." reads badly
      if (!d) msg = '';
      else if (d.type === 'critter') msg = `Pick an empty slot for <em>${d.name}</em>${dot}`;
      else if (d.target) msg = `Pick a target for <em>${d.name}</em>${dot}`;
      else msg = `Click <em>${d.name}</em> again to cast it.`;
    } else {
      const u = unitsOf(S.sides[0]).find((x) => x.c.uid === this.sel.uid);
      const nm = u ? CARDS[u.c.id].name : 'that critter';
      msg = `Pick who <em>${nm}</em> swings at.`;
      if (guardsUp(S, 1)) msg += ' Guards block the way to the capy.';
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
    const card = S.sides[0].hand.find((c) => c.uid === uid);
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
    if (!this.S) return;
    if (!this._myTurn()) {
      // mid-animation clicks are just early, not wrong: only nag on the AI's turn
      if (this.S.active !== 0 && this.S.winner === null) this._warn('Wait for your turn.');
      return;
    }
    const S = this.S;
    const card = S.sides[0].hand.find((c) => c.uid === uid);
    if (card) return this._clickHandCard(card);
    const mine = unitsOf(S.sides[0]).find((u) => u.c.uid === uid);
    if (mine) return this._clickMyUnit(mine);
    const foe = unitsOf(S.sides[1]).find((u) => u.c.uid === uid);
    if (foe) return this._clickFoeUnit(foe);
  }

  _clickHandCard(card) {
    const d = CARDS[card.id];
    const s = this.S.sides[0];
    if (this.sel && this.sel.kind === 'hand' && this.sel.uid === card.uid) {
      if (d.type === 'spell' && !d.target) return this._play(card.uid, {});
      return this._deselect();
    }
    if (d.cost > s.energy) return this._nope(card.uid, `${d.name} costs ${d.cost} energy. You have ${s.energy}.`);
    if (d.type === 'critter' && s.board.indexOf(null) < 0) {
      return this._nope(card.uid, 'All four of your slots are busy.');
    }
    if (d.type === 'spell' && d.target && !spellTargets(this.S, 0, d).length) {
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
      const card = this.S.sides[0].hand.find((c) => c.uid === sel.uid);
      const d = card ? CARDS[card.id] : null;
      if (d && d.type === 'spell' && d.target
        && spellTargetOk(this.S, 0, d, { side: 0, slot: u.i })) {
        return this._play(sel.uid, { target: { side: 0, slot: u.i } });
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
      const card = this.S.sides[0].hand.find((c) => c.uid === sel.uid);
      const d = card ? CARDS[card.id] : null;
      if (d && d.type === 'spell' && d.target
        && spellTargetOk(this.S, 0, d, { side: 1, slot: u.i })) {
        return this._play(sel.uid, { target: { side: 1, slot: u.i } });
      }
      return this._nope(sel.uid, d && d.type === 'critter' ? 'Critters go in your own empty slots.' : 'Not a legal target.');
    }
    const from = unitsOf(this.S.sides[0]).find((x) => x.c.uid === sel.uid);
    if (!from) return this._deselect();
    this._doAttack(from.i, { slot: u.i });
  }

  _clickSlot(side, i) {
    if (!this._myTurn()) return;
    const sel = this.sel;
    if (!sel) return;
    if (sel.kind === 'hand' && side === 0 && !this.S.sides[0].board[i]) {
      const card = this.S.sides[0].hand.find((c) => c.uid === sel.uid);
      const d = card ? CARDS[card.id] : null;
      if (d && d.type === 'critter') return this._play(sel.uid, { slot: i });
    }
    this._deselect();
  }

  _clickFace() {
    if (!this._myTurn() || !this.sel || this.sel.kind !== 'unit') return;
    const from = unitsOf(this.S.sides[0]).find((x) => x.c.uid === this.sel.uid);
    if (!from) return this._deselect();
    if (guardsUp(this.S, 1)) {
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
    if (this.phase === 'splash' || this.phase === 'over') {
      if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        this.el.over?.querySelector('[data-a="go"],[data-a="again"]')?.click();
      }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); this._deselect(); return; }
    if (!this._myTurn()) return;
    if (k === 'Enter') { e.preventDefault(); this._endTurnClick(); return; }
    const idx = '12345678'.indexOf(k);
    if (idx >= 0) {
      const card = this.S.sides[0].hand[idx];
      if (card) { e.preventDefault(); this._clickHandCard(card); }
    }
  }

  // ---- acting -------------------------------------------------------------
  _play(uid, opts) {
    const card = this.S.sides[0].hand.find((c) => c.uid === uid);
    const d = card ? CARDS[card.id] : null;
    if (!d) return;
    this._flyOut(uid, d);
    if (!playCard(this.S, 0, uid, opts)) { this._warn('That play is not legal.'); return; }
    this.sel = null;
    this.game.audio?.play?.(d.type === 'critter' ? 'pop' : 'sparkle');
    this._afterAction();
  }

  /** Lift the played card out of the hand into a ghost so the fan never jumps. */
  _flyOut(uid, def) {
    const node = this._nodes.get(uid);
    if (!node || !this.el.fx) return;
    const r = node.getBoundingClientRect();
    const w = this.el.wrap.getBoundingClientRect();
    if (r.width) {
      const ghost = document.createElement('div');
      ghost.className = 'mg-cards-flycard';
      ghost.style.left = `${r.left - w.left}px`;
      ghost.style.top = `${r.top - w.top}px`;
      ghost.style.width = `${r.width}px`;
      ghost.style.height = `${r.height}px`;
      ghost.appendChild(cardCanvas(def, HAND_PAINT, null));
      this.el.fx.appendChild(ghost);
      this._after(360, () => ghost.remove());
    }
    node.remove();
    this._nodes.delete(uid);
  }

  _doAttack(slot, target) {
    if (!canAttack(this.S, 0, slot, target)) { this._warn('That swing is not legal.'); return; }
    const a = this.S.sides[0].board[slot];
    this.busy = true;
    this.sel = null;
    this._renderHighlights();
    const node = this._nodes.get(a.uid);
    if (node) {
      node.classList.remove('mg-cards-lungeUp');
      void node.offsetWidth;
      node.classList.add('mg-cards-lungeUp');
    }
    this.game.audio?.play?.('whoosh');
    this._after(170, () => {
      if (this._dead || !this.S) return;
      attack(this.S, 0, slot, target);
      this.busy = false;
      this._afterAction();
      if (node) node.classList.remove('mg-cards-lungeUp');
    });
  }

  _endTurnClick() {
    if (!this._myTurn()) return;
    this.game.audio?.play?.('click');
    this.sel = null;
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
  }

  // ---- AI turn ------------------------------------------------------------
  _aiTurn() {
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
    const node = c ? this._nodes.get(c.uid) : null;
    if (node) {
      node.classList.remove('mg-cards-lungeDown');
      void node.offsetWidth;
      node.classList.add('mg-cards-lungeDown');
    }
    this.game.audio?.play?.('whoosh');
    this._after(190, () => {
      if (this._dead || !this.S) return;
      if (!applyAction(this.S, 1, a)) endTurn(this.S);
      this._afterAction();
      if (node) node.classList.remove('mg-cards-lungeDown');
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

  // ---- fx -----------------------------------------------------------------
  _pointOf(el) {
    const r = el.getBoundingClientRect();
    const w = this.el.wrap.getBoundingClientRect();
    return { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2 };
  }

  _slotPoint(side, slot) {
    const slots = side === 0 ? this.el.mySlots : this.el.foeSlots;
    return this._pointOf(slots[slot]);
  }

  _facePoint(side) { return this._pointOf(side === 0 ? this.el.myCapy : this.el.foeCapy); }

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

  /** Turn the rules-core event log into juice. Returns post-render callbacks. */
  _consumeFx() {
    const post = [];
    if (!this.S) return post;
    const fx = this.S.fx.splice(0, this.S.fx.length);
    let drewFor = -1;
    const sfx = new Set();
    for (const e of fx) {
      if (e.k === 'dmg') {
        const p = this._slotPoint(e.side, e.slot);
        this._float(`-${e.amount}`, p, 'mg-cards-dmg');
        this._shake(this._nodes.get(e.uid));
        sfx.add('thud');
      } else if (e.k === 'face') {
        const p = this._facePoint(e.side);
        this._float(`-${e.amount}`, p, 'mg-cards-dmg');
        this._shake(e.side === 0 ? this.el.myCapy : this.el.foeCapy);
        this._shake(this.el.wrap, 'mg-cards-quake');
        if (e.src === 'fatigue') this._float('SLEEPY!', { x: p.x, y: p.y - 34 }, 'mg-cards-note');
        if (e.side === 1) this._setExpr(1, 'hurt', 900);
        else this._setExpr(0, 'hurt', 900);
        sfx.add('thud');
      } else if (e.k === 'heal') {
        if (e.amount > 0) {
          this._float(`+${e.amount}`, this._facePoint(e.side), 'mg-cards-heal');
          sfx.add('sparkle');
        }
      } else if (e.k === 'die') {
        const p = this._slotPoint(e.side, e.slot);
        const node = this._nodes.get(e.uid);
        if (node) {
          this._nodes.delete(e.uid);
          node.classList.add('mg-cards-poof');
          this._after(460, () => node.remove());
        }
        this._poofDots(p, ELEMENTS[CARDS[e.id].el].c1);
        sfx.add('splash');
      } else if (e.k === 'tri') {
        this._flashArrow(e.from);
        const p = this._slotPoint(e.side, e.slot);
        this._float(`${ELEMENTS[e.from].name.toUpperCase()} +2`, { x: p.x, y: p.y - 26 }, 'mg-cards-tri');
        sfx.add('ding');
      } else if (e.k === 'buff') {
        this._float('+2 ATK', this._slotPoint(e.side, e.slot), 'mg-cards-heal');
      } else if (e.k === 'lastsplash') {
        this._float('LAST SPLASH', this._slotPoint(e.side, e.slot), 'mg-cards-note');
      } else if (e.k === 'burn') {
        this._float('HAND FULL', this._pointOf(e.side === 0 ? this.el.myDeck : this.el.foeDeck), 'mg-cards-note');
      } else if (e.k === 'draw') {
        drewFor = e.side;
      } else if (e.k === 'summon') {
        const uid = e.uid;
        post.push(() => {
          const n = this._nodes.get(uid);
          if (n) {
            n.classList.add('mg-cards-land');
            this._after(460, () => n.classList.remove('mg-cards-land'));
          }
        });
      }
    }
    if (drewFor >= 0) {
      const deck = drewFor === 0 ? this.el.myDeck : this.el.foeDeck;
      this._shake(deck, 'mg-cards-drawpop');
      this.game.audio?.play?.('tick');
    }
    // one action can fire several events (triangle, damage, a knockout): let
    // them land in a quick stagger instead of collapsing into a single blip
    [...sfx].slice(0, 3).forEach((name, i) => {
      if (i === 0) this.game.audio?.play?.(name);
      else this._after(70 * i, () => this.game.audio?.play?.(name));
    });
    return post;
  }

  // ---- expressions --------------------------------------------------------
  _setExpr(side, expr, holdMs) {
    if (side === 1) {
      if (this.foeExpr !== expr) {
        this.foeExpr = expr;
        paintFace(this.el.foeFace, FOE_FACE, this.foeCfg, expr);
      }
      if (holdMs) {
        this._foeHold = performance.now() + holdMs;
        this._after(holdMs + 20, () => this._syncExpr());
      }
      return;
    }
    if (this.myExpr !== expr) {
      this.myExpr = expr;
      paintFace(this.el.myFace, MY_FACE, this.myCfg, expr);
    }
    if (holdMs) {
      this._myHold = performance.now() + holdMs;
      this._after(holdMs + 20, () => this._syncExpr());
    }
  }

  _syncExpr() {
    if (this._dead || !this.S || !this.el.foeFace) return;
    const S = this.S;
    const now = performance.now();
    if (!(this._foeHold > now)) {
      let e = 'idle';
      if (S.winner === 1) e = 'smug';
      else if (S.winner === 0) e = 'beaten';
      else if (S.sides[1].hp <= 8) e = 'worried';
      else if (S.sides[0].hp <= 9 && S.sides[1].hp >= 16) e = 'smug';
      else if (S.active === 1) e = 'thinking';
      this._setExpr(1, e);
    }
    if (!(this._myHold > now)) {
      let m = 'idle';
      if (S.winner === 0) m = 'beam';
      else if (S.winner === 1) m = 'beaten';
      else if (S.sides[0].hp <= 8) m = 'worried';
      this._setExpr(0, m);
    }
  }

  _blinkLoop() {
    if (this._dead) return;
    this._after(2200 + Math.random() * 3400, () => {
      const calm = (x) => x === 'idle' || x === 'thinking';
      const foeWas = this.foeExpr, myWas = this.myExpr;
      if (calm(foeWas)) { this._setExpr(1, 'blink'); this._after(140, () => this._setExpr(1, foeWas)); }
      if (calm(myWas) && Math.random() < 0.7) {
        this._setExpr(0, 'blink');
        this._after(150, () => this._setExpr(0, myWas));
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
        <div class="mg-cards-btns">
          ${panel > 0 ? '<button class="mg-cards-btn mg-cards-ghost" data-a="back">Back</button>' : ''}
          <button class="mg-cards-btn" data-a="go">${last ? 'Start the duel' : 'Next'}</button>
          ${last ? '' : '<button class="mg-cards-btn mg-cards-alt" data-a="skip">Skip, I know cards</button>'}
          <button class="mg-cards-btn mg-cards-ghost" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    this._fillPanel(over.querySelector('[data-el="panel"]'), panel);
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
    this.phase = 'countdown';
    const over = this.el.over;
    over.classList.remove('mg-cards-gone');
    const steps = ['3', '2', '1', 'DUEL!'];
    const show = (i) => {
      if (this._dead) return;
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
    this.el.myHand.innerHTML = '';
    for (const s of [...this.el.foeSlots, ...this.el.mySlots]) s.innerHTML = '';
    this.el.fx.innerHTML = '';
    this.sel = null;
    this.busy = false;
    this._warnUntil = 0;
    this._foeHold = 0;
    this._myHold = 0;
    this._result = null;
    this.phase = 'play';
    this.S = newDuel();
    this._consumeFx();
    this._render();
    this._syncExpr();
    this.game.audio?.play?.('open');
  }

  _checkEnd() {
    if (!this.S || this.S.winner === null || this.phase !== 'play') return;
    this.phase = 'end';
    this.busy = true;
    this.sel = null;
    this._renderHighlights();
    this.game.audio?.play?.(this.S.winner === 0 ? 'success' : 'fail');
    this._after(1100, () => this._results());
  }

  _results() {
    if (this._dead || !this.S) return;
    this.phase = 'over';
    const S = this.S;
    const win = S.winner === 0;
    const draw = S.winner === 'draw';
    const dealt = Math.round(S.sides[0].dealt);
    const score = dealt + (win ? 50 : 0);
    this._result = {
      win, draw,
      myHp: Math.max(0, S.sides[0].hp),
      foeHp: Math.max(0, S.sides[1].hp),
    };
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
        <h2>${win ? 'You win the duel!' : draw ? 'A dead heat!' : `${AI_NAME} wins`}</h2>
        <div class="mg-cards-sub">${this._verdict(win, draw)}</div>
        <div class="mg-cards-stats">
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
          <button class="mg-cards-btn" data-a="again">Play again</button>
          <button class="mg-cards-btn mg-cards-alt" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    over.querySelector('[data-el="winface"]').appendChild(face);
    over.querySelector('[data-a="again"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this._done = false; // let the next duel report its own score
      this._countdown();
    });
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  _verdict(win, draw) {
    const r = this._result;
    if (draw) return 'BOTH CAPYS FLOPPED OVER AT ONCE. THE DEN IS BAFFLED.';
    if (win && r.myHp >= 20) return 'PEBBLE BARELY GOT A CARD DOWN. MASTERFUL.';
    if (win && r.myHp >= 10) return 'A PROPER DUEL. THE DEN IS TALKING ABOUT IT.';
    if (win) return 'ONE HP FROM DISASTER, AND YOU TOOK IT ANYWAY.';
    if (r.foeHp < 10) return 'SO CLOSE. PEBBLE ADJUSTS THE MONOCLE, POLITELY.';
    if (r.foeHp < 18) return 'A REAL SCRAP. THE TRIANGLE IS THE TRICK: SWING INTO WHAT YOU BEAT.';
    return 'PEBBLE HAS BEEN PLAYING SINCE BEFORE THE COVE HAD A NAME. AGAIN?';
  }
}
