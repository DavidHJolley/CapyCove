import { Minigame } from '../minigame.js';
import { MINIGAMES } from '../../../shared/constants.js';

/**
 * Capy Doodles: the jungle's draw-and-guess party game (wave 6,
 * docs/PARTY-GAMES.md).
 *
 * TWO MODES, ONE SCREEN
 *  - PARTY: the Tangle Jungle lobby parks `game.__partyCtx` =
 *    {game:'doodle', players:[{id,name,color,hat}], youAre} on 'dd-start' and
 *    starts this game. The SERVER owns the word, the clock, the mask and every
 *    guess verdict; this file renders what it is told and sends what the player
 *    does. Nothing here ever knows the word while someone is guessing it, so
 *    there is no DOM to peek at.
 *  - SOLO: "Guess the bot's doodles". Doodles the capybara replays one of the
 *    17 canned drawings authored at the bottom of this file (stroke data in a
 *    1000x700 logical space) and you race the clock to name it. Same guess box,
 *    same reveals, same scoring feel as a party round.
 *
 * WIRE SHAPES (server is authoritative; every reader below is defensive so a
 * differently-named field degrades instead of breaking the round)
 *   server -> us   dd-words   {words:[3]}                        (drawer only)
 *                  dd-mask    {mask:'_ _ _ _', word?}            (word on reveal)
 *                  dd-stroke  {s, c, w, pts:[x,y,...], e?, op?}  (relayed draw)
 *                  dd-correct {id, name, pts, near?}
 *                  dd-state   {phase, round, rounds, drawer, left, dur,
 *                              scores:[{id,name,score}], strokes?, word?}
 *                  dd-end     {standings:[{id,name,score}]}
 *   us -> server   dd-pick    {i, word}
 *                  dd-stroke  {s, c, w, pts, e}   (batched at ~10Hz, capped)
 *                  dd-stroke  {op:'undo'|'clear'}
 *                  dd-guess   {text}
 *                  dd-leave                        (walking out mid-round)
 *
 * DEVIATIONS from the spec, on purpose:
 *  - Near-miss ("so close!") is server-driven in party mode (dd-correct.near).
 *    Until a server near-miss frame is seen we also run a local fallback: a
 *    guess whose length matches the mask and whose revealed letters all line up
 *    is pinged as close. Levenshtein needs the word, which guessers must never
 *    have, so this is the honest client-side approximation.
 *  - If 'dd-words' never arrives (4s grace) the drawer is offered the three
 *    CARDS instead of three words. The server resolves the picked index against
 *    ITS OWN choices and answers with the word it holds, so the easel never
 *    shows a word the server did not pick. A round with a word beats a round
 *    stuck on "waiting"; a round with the WRONG word is worse than both, and
 *    that is exactly what a local word list produces.
 *  - Party clocks are anchored to a wall-clock deadline built from the server's
 *    remaining ms, never accumulated out of rAF deltas: browsers freeze
 *    requestAnimationFrame in a background tab and the round does not wait.
 */

// ------------------------------------------------------------------ tuning --
const W = 1000;            // logical canvas width  (network + stroke space)
const H = 700;             // logical canvas height
const PAPER = '#fffdf6';

// 8 chunky crayons, straight off the DESIGN.md palette
const PALETTE = [
  '#2d2417', // ink
  '#e8657a', // coral
  '#f2b64a', // gold
  '#7ac74f', // leaf
  '#4fb3e8', // sky
  '#9b6ee0', // grape
  '#b08a5a', // capy brown
  '#ff9a3c', // mango
];
const WIDTHS = [7, 15, 28];      // thin / chunky / fat
const SIZE_LABELS = ['S', 'M', 'L'];

const MAX_STROKES = 400;         // per drawing, ours and theirs
const MAX_PTS = 700;             // numbers per stroke (350 points)
const SEND_HZ = 10;              // stroke batches per second
const SEND_CHUNK = 90;           // numbers per batch
const MIN_STEP = 3.2;            // logical units between recorded points

const SOLO_ROUNDS = 6;
const SOLO_TIMES = [45, 42, 38, 34, 31, 28];   // escalation: the clock tightens
const SOLO_MAX = SOLO_ROUNDS * 120;            // 100 speed + 20 streak per round
const REPLAY_FRAC = 0.6;         // Doodles finishes her drawing this far in
const LIFT = 44;                 // "pen lift" cost between replayed strokes

const PI = Math.PI;
const TAU = PI * 2;

// --------------------------------------------------------------- helpers ----
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function num(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

function hexOf(n) {
  const v = Number.isFinite(n) ? (n >>> 0) & 0xffffff : 0xb08a5a;
  return `#${v.toString(16).padStart(6, '0')}`;
}

/** Mix a hex string toward white (t>0) or ink (t<0). */
function shade(hex, t) {
  const v = parseInt(hex.slice(1), 16);
  let r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const to = t >= 0 ? 255 : 40;
  const k = Math.abs(t);
  r = Math.round(lerp(r, to, k));
  g = Math.round(lerp(g, to, k));
  b = Math.round(lerp(b, to, k));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Guess normalisation: case, punctuation and double spaces never matter. */
function normWord(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Masks arrive either packed ("__p__") or pre-spaced for display ("_ _ p _ _"),
 * depending on how the server likes to write them. Detect the spaced form (a
 * space between every glyph) and unpack it, treating a double space as the word
 * break it always means. Anything else is passed through untouched.
 */
function normMask(mask) {
  const s = String(mask ?? '');
  if (!s.includes(' ')) return s;
  const words = s.split(/ {2,}/);
  // spaced form = every "word" is single glyphs separated by single spaces
  if (!words.every((w) => /^\S(?: \S)*$/.test(w))) return s;
  return words.map((w) => w.replace(/ /g, '')).join(' ');
}

/** Levenshtein, capped: we only ever care about "is this 1 edit away". */
function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 9;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function pathLen(p) {
  let t = 0;
  for (let i = 2; i < p.length; i += 2) t += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return t;
}

/** First `f` (0..1) of a path by arc length, with the tip interpolated. */
function partialPath(p, f) {
  if (f >= 1) return p;
  const total = pathLen(p);
  if (total <= 0 || f <= 0) return p.slice(0, 2);
  let want = total * f;
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const dx = p[i] - p[i - 2];
    const dy = p[i + 1] - p[i - 1];
    const d = Math.hypot(dx, dy);
    if (d >= want) {
      const k = d > 0 ? want / d : 0;
      out.push(p[i - 2] + dx * k, p[i - 1] + dy * k);
      return out;
    }
    want -= d;
    out.push(p[i], p[i + 1]);
  }
  return out;
}

/**
 * Round-capped, round-joined polyline smoothed through segment midpoints: the
 * "pressure-free crayon" look. One path, one stroke, no seams.
 */
function strokePath(ctx, p, color, width) {
  const n = p.length >> 1;
  if (!n) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (n === 1) {
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[0] + 0.01, p[1]);
  } else if (n === 2) {
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
  } else {
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      const x = p[i * 2], y = p[i * 2 + 1];
      ctx.quadraticCurveTo(x, y, (x + p[i * 2 + 2]) / 2, (y + p[i * 2 + 3]) / 2);
    }
    ctx.lineTo(p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
  }
  ctx.stroke();
}

/** A chibi capy head on a small canvas: scoreboard portraits and Doodles. */
function capyCanvas(size, color, gold = false) {
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const x = c.getContext('2d');
  if (!x) return c;
  const s = c.width / 100;
  x.scale(s, s);
  const fur = color;
  const dark = shade(fur, -0.22);
  const light = shade(fur, 0.3);
  const ell = (cx, cy, rx, ry, fill) => {
    x.beginPath();
    x.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    x.fillStyle = fill;
    x.fill();
  };
  ell(28, 30, 13, 13, dark);          // ears
  ell(72, 30, 13, 13, dark);
  ell(28, 30, 7, 7, shade(fur, -0.45));
  ell(72, 30, 7, 7, shade(fur, -0.45));
  ell(50, 54, 38, 34, fur);           // head
  ell(50, 70, 22, 15, light);         // muzzle
  ell(38, 48, 5.4, 6, '#2d2417');     // eyes
  ell(62, 48, 5.4, 6, '#2d2417');
  ell(39.6, 46, 1.8, 1.8, '#fffdf6');
  ell(63.6, 46, 1.8, 1.8, '#fffdf6');
  ell(50, 65, 6.5, 4.6, '#2d2417');   // nose
  if (gold) {                          // Doodles wears a crayon behind the ear
    x.save();
    x.translate(78, 22);
    x.rotate(-0.5);
    x.fillStyle = '#e8657a';
    x.fillRect(-5, -16, 10, 26);
    x.fillStyle = '#f2b64a';
    x.beginPath();
    x.moveTo(-5, -16);
    x.lineTo(5, -16);
    x.lineTo(0, -26);
    x.closePath();
    x.fill();
    x.restore();
  }
  return c;
}

// -------------------------------------------------- canned drawing authoring -
// Stroke data lives in the same 1000x700 logical space the live canvas uses.
// A(...) walks an ellipse, E(...) closes one, dot(...) is a single fat blob.
function A(cx, cy, rx, ry, a0 = 0, a1 = TAU, steps = 0) {
  const n = steps || Math.max(6, Math.round((Math.abs(a1 - a0) / TAU) * 26));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * (i / n);
    out.push(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry));
  }
  return out;
}
const E = (cx, cy, rx, ry) => A(cx, cy, rx, ry, 0, TAU);
const dot = (x, y) => [x, y, x + 0.6, y];

/**
 * Split long segments so the midpoint smoothing in strokePath cannot round a
 * sharp corner into a blob. A hand-drawn stroke arrives with points every few
 * units; authored polygons do not, and an un-densified gem outline renders as
 * a leaf. Corners keep a ~1 step chamfer, which reads as crayon, not error.
 */
function densify(p, step = 14) {
  if (p.length <= 4) return p;
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1];
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.min(40, Math.floor(d / step));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t));
    }
    out.push(bx, by);
  }
  return out;
}

/** S(colorIndex, widthIndex, ...points|arrays) -> one stroke record. */
function S(c, w, ...parts) {
  const p = [];
  for (const q of parts) {
    if (Array.isArray(q)) { for (let i = 0; i < q.length; i++) p.push(q[i]); } else p.push(q);
  }
  return { c, w, p: densify(p) };
}
const D = (word, hard, strokes) => ({ word, hard, strokes });

/**
 * Doodles' sketchbook: 17 all-ages, on-theme drawings. `hard` (1-3) drives the
 * solo escalation curve: easy shapes first, fiddly ones once you are warm.
 */
const DRAWINGS = [
  D('fish', 1, [
    S(4, 1, E(470, 350, 190, 120)),
    S(4, 1, 655, 300, 800, 218, 800, 472, 652, 400),
    S(4, 1, 480, 232, 545, 162, 602, 246),
    S(4, 1, 480, 468, 545, 538, 602, 454),
    S(0, 2, dot(348, 316)),
    S(0, 0, A(356, 372, 54, 38, 0.12 * PI, 0.86 * PI)),
    S(4, 0, A(438, 350, 66, 96, 0.56 * PI, 1.44 * PI)),
    S(4, 0, E(246, 244, 24, 24)),
    S(4, 0, E(196, 186, 15, 15)),
  ]),
  D('smoothie', 1, [
    S(0, 1, 402, 252, 446, 574, 590, 574, 634, 252),
    S(0, 1, E(518, 252, 118, 30)),
    S(1, 2, 586, 118, 560, 250),
    S(3, 1, 420, 352, 618, 352),
    S(1, 0, E(472, 428, 26, 26)),
    S(1, 0, E(546, 482, 18, 18)),
    S(2, 0, 660, 296, 722, 262),
    S(2, 0, 676, 348, 742, 348),
  ]),
  D('top hat', 1, [
    S(0, 1, E(500, 470, 226, 48)),
    S(0, 1, 392, 468, 392, 236),
    S(0, 1, 608, 468, 608, 236),
    S(0, 1, E(500, 236, 108, 32)),
    S(1, 2, 394, 404, 606, 404),
  ]),
  D('snowman', 1, [
    S(4, 1, E(500, 506, 154, 144)),
    S(4, 1, E(500, 306, 108, 102)),
    S(4, 1, E(500, 160, 74, 70)),
    S(0, 2, dot(476, 146)),
    S(0, 2, dot(524, 146)),
    S(7, 1, 502, 168, 576, 184, 502, 196),
    S(6, 1, 396, 300, 300, 232),
    S(6, 1, 300, 232, 262, 220),
    S(6, 1, 300, 232, 292, 190),
    S(6, 1, 604, 300, 700, 236),
    S(6, 1, 700, 236, 740, 226),
    S(6, 1, 700, 236, 708, 194),
    S(0, 2, dot(500, 272)),
    S(0, 2, dot(500, 334)),
    S(0, 0, A(500, 198, 38, 24, 0.15 * PI, 0.85 * PI)),
  ]),
  D('crab', 2, [
    S(1, 1, E(500, 386, 154, 108)),
    S(1, 1, 452, 292, 442, 234),
    S(1, 1, 548, 292, 558, 234),
    S(0, 2, dot(442, 224)),
    S(0, 2, dot(558, 224)),
    S(1, 1, 352, 346, 268, 300),
    S(1, 1, 268, 300, 204, 262),
    S(1, 1, 268, 300, 212, 332),
    S(1, 1, 648, 346, 732, 300),
    S(1, 1, 732, 300, 796, 262),
    S(1, 1, 732, 300, 788, 332),
    S(1, 1, 392, 460, 320, 528),
    S(1, 1, 448, 482, 410, 556),
    S(1, 1, 608, 460, 680, 528),
    S(1, 1, 552, 482, 590, 556),
    S(0, 0, A(500, 402, 46, 28, 0.1 * PI, 0.9 * PI)),
  ]),
  D('palm tree', 2, [
    S(6, 2, 430, 636, 452, 500, 466, 380, 498, 288),
    S(3, 1, 500, 284, 404, 208, 300, 214, 258, 270),
    S(3, 1, 500, 284, 436, 168, 330, 140, 256, 178),
    S(3, 1, 500, 284, 566, 160, 674, 148, 744, 192),
    S(3, 1, 500, 284, 622, 202, 726, 232, 766, 292),
    S(3, 1, 500, 284, 540, 186, 512, 128),
    S(6, 2, dot(468, 316)),
    S(6, 2, dot(530, 320)),
    S(2, 1, 300, 646, 700, 646),
  ]),
  D('sled', 2, [
    S(1, 2, A(330, 480, 52, 52, 0.5 * PI, 1.95 * PI)),
    S(1, 2, 330, 532, 730, 532),
    S(6, 1, 372, 462, 730, 462),
    S(6, 0, 420, 462, 420, 530),
    S(6, 0, 500, 462, 500, 530),
    S(6, 0, 580, 462, 580, 530),
    S(6, 0, 660, 462, 660, 530),
    S(6, 1, 730, 462, 730, 386),
    S(6, 1, 686, 386, 774, 386),
    S(2, 1, 372, 452, 268, 400, 196, 430),
  ]),
  D('mushroom', 1, [
    S(1, 1, A(500, 342, 194, 158, PI, TAU)),
    S(1, 1, 306, 342, 694, 342),
    S(7, 1, 424, 342, 432, 528),
    S(7, 1, 576, 342, 568, 528),
    S(7, 1, A(500, 528, 68, 30, 0, PI)),
    S(7, 0, E(432, 262, 34, 26)),
    S(7, 0, E(566, 244, 26, 20)),
    S(7, 0, E(612, 306, 20, 16)),
  ]),
  D('crystal', 2, [
    S(4, 1, 500, 132, 612, 262, 582, 536, 500, 586, 418, 536, 388, 262, 500, 132),
    S(4, 0, 388, 262, 612, 262),
    S(4, 0, 500, 132, 452, 262),
    S(4, 0, 500, 132, 548, 262),
    S(4, 0, 452, 262, 500, 586),
    S(4, 0, 548, 262, 500, 586),
    S(2, 0, 700, 210, 762, 210),
    S(2, 0, 731, 178, 731, 242),
    S(2, 0, 268, 452, 322, 452),
    S(2, 0, 295, 425, 295, 479),
  ]),
  D('pickaxe', 2, [
    S(6, 2, 330, 590, 620, 236),
    S(0, 1, A(620, 400, 200, 180, 1.22 * PI, 1.78 * PI)),
    S(0, 1, A(620, 400, 232, 214, 1.26 * PI, 1.74 * PI)),
    S(0, 1, 455, 247, 467, 282),
    S(0, 1, 785, 247, 773, 282),
    S(2, 1, 586, 246, 656, 292),
    S(2, 0, 268, 250, 322, 250),
    S(2, 0, 295, 223, 295, 277),
  ]),
  D('minecart', 3, [
    S(6, 1, 330, 300, 362, 470, 662, 470, 692, 300),
    S(6, 1, 318, 300, 704, 300),
    S(0, 1, E(412, 512, 46, 46)),
    S(0, 1, E(612, 512, 46, 46)),
    S(0, 2, dot(412, 512)),
    S(0, 2, dot(612, 512)),
    S(6, 1, 240, 568, 782, 568),
    S(6, 0, 300, 552, 300, 590),
    S(6, 0, 420, 552, 420, 590),
    S(6, 0, 540, 552, 540, 590),
    S(6, 0, 660, 552, 660, 590),
    S(6, 0, 762, 552, 762, 590),
    S(4, 1, 420, 300, 448, 234, 486, 300),
    S(4, 1, 520, 300, 566, 212, 612, 300),
  ]),
  D('campfire', 2, [
    S(6, 2, 320, 552, 686, 508),
    S(6, 2, 330, 508, 690, 556),
    S(1, 1, 500, 168, 548, 258, 534, 302, 596, 392, 588, 452, 500, 488,
      412, 452, 404, 392, 466, 302, 452, 258, 500, 168),
    S(2, 1, 500, 302, 534, 368, 500, 446, 466, 368, 500, 302),
    S(2, 0, dot(360, 250)),
    S(2, 0, dot(652, 214)),
    S(2, 0, dot(596, 140)),
  ]),
  D('cupcake', 1, [
    S(1, 1, 386, 402, 428, 578, 572, 578, 614, 402),
    S(1, 1, 378, 402, 622, 402),
    S(1, 0, 440, 408, 456, 574),
    S(1, 0, 500, 408, 500, 578),
    S(1, 0, 560, 408, 544, 574),
    S(3, 2, 386, 400, 404, 330, 470, 300, 540, 306, 600, 344, 614, 400),
    S(3, 1, 432, 330, 470, 268, 540, 272, 578, 332),
    S(1, 1, E(500, 232, 34, 32)),
    S(6, 0, 500, 202, 522, 164),
  ]),
  D('shark', 2, [
    S(4, 1, 232, 388, 392, 306, 620, 316, 726, 352, 830, 246, 792, 366,
      832, 470, 722, 386, 604, 424, 396, 442, 232, 388),
    S(4, 1, 512, 314, 556, 204, 622, 322),
    S(4, 1, 520, 428, 498, 516, 592, 444),
    S(0, 2, dot(318, 356)),
    S(0, 0, 236, 402, 330, 436, 430, 418),
    S(0, 0, 300, 424, 316, 402, 332, 428, 350, 404, 366, 430),
    S(4, 0, 452, 330, 442, 392),
    S(4, 0, 482, 328, 472, 396),
    S(4, 0, 512, 330, 502, 398),
  ]),
  D('boat', 1, [
    S(6, 1, 272, 470, 338, 566, 662, 566, 728, 470),
    S(6, 1, 262, 470, 738, 470),
    S(6, 2, 500, 466, 500, 168),
    S(7, 1, 514, 192, 660, 452, 514, 452, 514, 192),
    S(1, 1, 496, 168, 424, 196, 496, 224),
    S(4, 1, 180, 618, 260, 596, 340, 618, 420, 596, 500, 618, 580, 596,
      660, 618, 740, 596, 820, 618),
    S(4, 0, 220, 662, 300, 642, 380, 662, 460, 642, 540, 662, 620, 642, 700, 662),
  ]),
  D('chairlift', 3, [
    S(0, 1, 96, 118, 904, 152),
    S(0, 1, 470, 132, 466, 212, 424, 238),
    S(6, 2, 420, 236, 432, 348, 612, 354, 622, 314),
    S(6, 1, 616, 352, 644, 438),
    S(6, 1, 452, 430, 648, 438),
    S(6, 1, 436, 350, 448, 430),
    S(0, 1, 838, 150, 838, 606),
    S(0, 1, 794, 196, 838, 150),
    S(4, 1, 96, 630, 250, 606, 420, 638, 600, 608, 780, 636, 904, 612),
  ]),
  D('flower', 1, [
    S(1, 1, E(618, 300, 68, 62)),
    S(1, 1, E(559, 402, 68, 62)),
    S(1, 1, E(441, 402, 68, 62)),
    S(1, 1, E(382, 300, 68, 62)),
    S(1, 1, E(441, 198, 68, 62)),
    S(1, 1, E(559, 198, 68, 62)),
    S(2, 1, E(500, 300, 60, 56)),
    S(2, 2, dot(486, 288)),
    S(2, 2, dot(516, 296)),
    S(2, 2, dot(498, 320)),
    S(3, 2, 500, 360, 512, 620),
    S(3, 1, A(430, 496, 82, 46, 1.72 * PI, 2.62 * PI)),
    S(3, 1, A(596, 560, 82, 46, 1.02 * PI, 1.92 * PI)),
  ]),
];

// There is deliberately NO local word list for party rounds. The server owns
// the words, and any word this file invented for the drawer's card would be a
// word the server never chose: the drawer would draw one thing while every
// guesser was scored against another. See _showMysteryPicks.

const DOODLE_LINES = {
  start: [
    'watch this masterpiece happen',
    'crayon charged. stand back',
    'i have been practising this one',
    'no peeking at my technique',
  ],
  wrong: [
    'nope! keep looking',
    'not even a little bit',
    'bold guess. wrong, but bold',
    'my art is not THAT abstract',
    'try squinting at it',
  ],
  near: ['so close!', 'ooh, almost!', 'you are one crayon away'],
  right: [
    'how did you know!',
    'ok you are good at this',
    'fine. take the points',
    'my hardest drawing yet, guessed instantly',
  ],
  miss: [
    'it was obvious!',
    'i thought that was clear',
    'my critics are everywhere',
  ],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ------------------------------------------------------------------- style --
const STYLE = `
.mg-dd-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#33291c;user-select:none;
  -webkit-user-select:none;}
.mg-dd-root *{box-sizing:border-box;}
.mg-dd-bg{position:absolute;inset:0;z-index:0;
  background:
    radial-gradient(ellipse 80% 60% at 50% 8%, rgba(226,255,178,.55), rgba(226,255,178,0) 70%),
    radial-gradient(ellipse 60% 50% at 12% 92%, rgba(20,58,26,.55), rgba(20,58,26,0) 70%),
    linear-gradient(180deg,#3f6b34 0%,#2f5228 55%,#22401f 100%);}
.mg-dd-bg::after{content:"";position:absolute;inset:0;
  background:repeating-linear-gradient(112deg, rgba(255,255,255,.05) 0 6px, rgba(0,0,0,0) 6px 62px);}
.mg-dd-leaf{position:absolute;width:190px;height:96px;border-radius:0 100% 0 100%;
  background:linear-gradient(140deg,#7ac74f,#3f7a2c);opacity:.5;filter:blur(.4px);
  transform-origin:top left;animation:mg-dd-sway 7s ease-in-out infinite;}
@keyframes mg-dd-sway{0%,100%{transform:rotate(0deg)}50%{transform:rotate(5deg)}}

/* z-index 9: the top bar (and its QUIT) stays clickable above every overlay */
.mg-dd-top{position:relative;z-index:9;display:flex;align-items:center;gap:12px;
  padding:12px 16px 8px;flex-wrap:wrap;}
.mg-dd-chip{background:#fffdf6;border-radius:999px;padding:7px 15px;font-weight:900;font-size:14px;
  display:flex;align-items:center;gap:7px;box-shadow:0 5px 0 rgba(24,50,20,.35),0 10px 18px rgba(10,26,8,.28);}
.mg-dd-chip small{font-size:10.5px;letter-spacing:.14em;opacity:.55;font-weight:800;}
.mg-dd-chip b{font-size:17px;}
.mg-dd-score b{color:#e8657a;min-width:26px;text-align:right;}
.mg-dd-clock b{color:#3f7a2c;min-width:30px;text-align:right;}
.mg-dd-clock.mg-dd-panic{background:#e8657a;color:#fff;animation:mg-dd-pulse .6s ease-in-out infinite;}
.mg-dd-clock.mg-dd-panic b,.mg-dd-clock.mg-dd-panic small{color:#fff;opacity:.95;}
@keyframes mg-dd-pulse{50%{transform:scale(1.09)}}
.mg-dd-bump{animation:mg-dd-bump .34s ease;}
@keyframes mg-dd-bump{50%{transform:scale(1.18) rotate(-2deg)}}
.mg-dd-mid{flex:1;min-width:180px;display:flex;flex-direction:column;align-items:center;gap:3px;}
.mg-dd-role{font-size:11px;font-weight:900;letter-spacing:.16em;color:#e8ffcf;opacity:.85;
  text-shadow:0 2px 6px rgba(0,0,0,.4);text-align:center;}
.mg-dd-word{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;}
.mg-dd-l{width:23px;height:31px;border-radius:6px;background:rgba(255,253,246,.16);
  border-bottom:4px solid #fffdf6;display:flex;align-items:center;justify-content:center;
  font-weight:900;font-size:19px;color:#fffdf6;text-transform:uppercase;transition:.2s;}
.mg-dd-l.mg-dd-gap{background:none;border-bottom-color:transparent;width:12px;}
.mg-dd-l.mg-dd-shown{background:#f2b64a;color:#3a2a10;border-bottom-color:#c98e26;
  animation:mg-dd-flip .45s cubic-bezier(.2,1.5,.4,1);}
.mg-dd-word.mg-dd-full .mg-dd-l{background:#7ac74f;border-bottom-color:#4f9130;color:#123006;}
@keyframes mg-dd-flip{from{transform:rotateX(90deg) scale(.7)}}
.mg-dd-quit{border:0;background:rgba(20,40,16,.68);color:#fff6e3;font-family:inherit;font-weight:900;
  font-size:12px;letter-spacing:.1em;padding:9px 16px;border-radius:999px;cursor:pointer;transition:.14s;}
.mg-dd-quit:hover{background:#c94a3e;transform:scale(1.06);}
.mg-dd-tbar{position:relative;z-index:3;height:8px;margin:0 16px;border-radius:999px;
  background:rgba(12,30,10,.45);overflow:hidden;}
.mg-dd-tbar i{display:block;height:100%;width:100%;border-radius:999px;
  background:linear-gradient(90deg,#7ac74f,#f2b64a);transition:background .3s;}
.mg-dd-tbar.mg-dd-panic i{background:linear-gradient(90deg,#f2b64a,#e8657a);}

.mg-dd-body{position:relative;z-index:2;flex:1;min-height:0;display:flex;gap:14px;padding:10px 16px 14px;}
.mg-dd-side{width:clamp(158px,17vw,214px);display:flex;flex-direction:column;gap:8px;min-height:0;}
.mg-dd-side.mg-dd-hide{visibility:hidden;}
.mg-dd-sideh{font-size:10.5px;font-weight:900;letter-spacing:.16em;color:#e8ffcf;opacity:.8;padding-left:4px;}
.mg-dd-rows{display:flex;flex-direction:column;gap:6px;overflow:hidden;}
.mg-dd-row{display:flex;align-items:center;gap:8px;background:rgba(255,253,246,.9);border-radius:14px;
  padding:5px 10px 5px 6px;box-shadow:0 4px 0 rgba(24,50,20,.3);transition:.2s;}
.mg-dd-row canvas{border-radius:50%;background:rgba(0,0,0,.06);flex:none;}
.mg-dd-row span{flex:1;font-weight:900;font-size:12.5px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;}
.mg-dd-row b{font-size:14px;color:#e8657a;}
.mg-dd-row.mg-dd-drawing{background:#f2b64a;}
.mg-dd-row.mg-dd-got{background:#c9edb0;}
.mg-dd-row i{font-style:normal;font-size:11px;font-weight:900;opacity:.6;}
.mg-dd-dots{display:flex;gap:5px;padding:4px;flex-wrap:wrap;}
.mg-dd-dot{width:13px;height:13px;border-radius:50%;background:rgba(255,253,246,.28);}
.mg-dd-dot.mg-dd-hit{background:#7ac74f;}
.mg-dd-dot.mg-dd-miss{background:#c05a52;}
.mg-dd-dot.mg-dd-now{background:#f2b64a;animation:mg-dd-pulse .9s ease-in-out infinite;}

.mg-dd-stage{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:9px;}
.mg-dd-easel{position:relative;flex:1;min-height:0;width:100%;display:flex;align-items:center;
  justify-content:center;}
.mg-dd-paper{position:relative;border-radius:12px;background:${PAPER};
  box-shadow:0 0 0 10px #a5702f,0 0 0 15px #6f4718,0 22px 34px rgba(8,22,6,.5);overflow:hidden;}
.mg-dd-paper canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;}
.mg-dd-paper.mg-dd-draw canvas{cursor:crosshair;}
.mg-dd-shake{animation:mg-dd-shake .38s ease;}
@keyframes mg-dd-shake{0%,100%{transform:translate(0,0)}25%{transform:translate(-7px,3px)}
  55%{transform:translate(6px,-4px)}80%{transform:translate(-3px,2px)}}
.mg-dd-badge{position:absolute;left:50%;top:12px;transform:translateX(-50%);background:rgba(45,36,23,.82);
  color:#fff6e3;font-size:11px;font-weight:900;letter-spacing:.14em;padding:6px 14px;border-radius:999px;
  opacity:0;transition:.25s;pointer-events:none;white-space:nowrap;}
.mg-dd-badge.mg-dd-on{opacity:1;}
.mg-dd-bub{position:absolute;right:10px;bottom:10px;max-width:62%;background:#fffdf6;border-radius:18px;
  padding:9px 14px;font-size:13px;font-weight:800;box-shadow:0 8px 18px rgba(8,22,6,.3);
  opacity:0;transform:translateY(8px) scale(.9);transition:.24s cubic-bezier(.2,1.35,.4,1);}
.mg-dd-bub.mg-dd-on{opacity:1;transform:none;}
.mg-dd-bub::after{content:"";position:absolute;right:26px;bottom:-11px;border:10px solid transparent;
  border-top-color:#fffdf6;border-bottom:0;}
.mg-dd-pops{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.mg-dd-pop{position:absolute;font-weight:900;font-size:26px;color:#3f7a2c;
  text-shadow:0 2px 0 #fffdf6,0 6px 14px rgba(0,0,0,.25);animation:mg-dd-pop 1.1s ease-out forwards;
  transform:translate(-50%,-50%);white-space:nowrap;}
@keyframes mg-dd-pop{0%{opacity:0;transform:translate(-50%,-30%) scale(.5)}
  25%{opacity:1;transform:translate(-50%,-60%) scale(1.15)}
  100%{opacity:0;transform:translate(-50%,-170%) scale(1)}}

.mg-dd-tools{display:none;align-items:center;gap:7px;flex-wrap:wrap;justify-content:center;
  background:rgba(24,50,20,.5);border-radius:999px;padding:7px 12px;}
.mg-dd-tools.mg-dd-on{display:flex;}
.mg-dd-sw{width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,253,246,.75);cursor:pointer;
  padding:0;transition:.14s;}
.mg-dd-sw:hover{transform:translateY(-3px) scale(1.08);}
.mg-dd-sw.mg-dd-sel{border-color:#fffdf6;transform:scale(1.2);box-shadow:0 0 0 3px rgba(242,182,74,.8);}
.mg-dd-sz{width:34px;height:30px;border-radius:12px;border:0;background:rgba(255,253,246,.85);cursor:pointer;
  font-family:inherit;font-weight:900;font-size:12px;color:#33291c;transition:.14s;}
.mg-dd-sz.mg-dd-sel{background:#f2b64a;transform:scale(1.08);}
.mg-dd-tbtn{border:0;border-radius:999px;background:#fffdf6;font-family:inherit;font-weight:900;
  font-size:11.5px;letter-spacing:.08em;padding:8px 14px;cursor:pointer;transition:.14s;}
.mg-dd-tbtn:hover{transform:translateY(-2px);}
.mg-dd-tbtn.mg-dd-warn{background:#e8657a;color:#fff;}
.mg-dd-sep{width:2px;height:24px;background:rgba(255,253,246,.3);border-radius:2px;}

.mg-dd-guess{width:min(560px,100%);display:flex;gap:8px;}
.mg-dd-guess.mg-dd-off{display:none;}
.mg-dd-guess input{flex:1;min-width:0;border:0;border-radius:999px;padding:12px 20px;font-family:inherit;
  font-weight:800;font-size:15px;color:#33291c;background:#fffdf6;
  box-shadow:0 5px 0 rgba(24,50,20,.35),inset 0 2px 6px rgba(0,0,0,.08);outline:none;}
.mg-dd-guess input:focus{box-shadow:0 5px 0 rgba(24,50,20,.35),0 0 0 3px #f2b64a;}
.mg-dd-guess input:disabled{opacity:.65;}
.mg-dd-guess button{border:0;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:13px;letter-spacing:.1em;padding:12px 22px;cursor:pointer;
  box-shadow:0 5px 0 rgba(24,50,20,.35);transition:.14s;}
.mg-dd-guess button:hover{transform:translateY(-2px);}
.mg-dd-guess button:active{transform:translateY(3px);box-shadow:0 2px 0 rgba(24,50,20,.35);}
.mg-dd-feed{width:min(560px,100%);height:74px;overflow:hidden;display:flex;flex-direction:column-reverse;
  gap:4px;}
.mg-dd-fl{background:rgba(255,253,246,.86);border-radius:999px;padding:4px 14px;font-size:12.5px;
  font-weight:800;align-self:flex-start;max-width:100%;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;animation:mg-dd-slide .26s cubic-bezier(.2,1.4,.4,1);}
.mg-dd-fl b{color:#3f7a2c;}
.mg-dd-fl.mg-dd-good{background:#c9edb0;}
.mg-dd-fl.mg-dd-close{background:#f2b64a;}
@keyframes mg-dd-slide{from{opacity:0;transform:translateX(-18px)}}
.mg-dd-ping{position:absolute;left:50%;bottom:132px;transform:translateX(-50%) scale(.7);opacity:0;
  background:#f2b64a;color:#3a2a10;font-weight:900;font-size:15px;letter-spacing:.06em;padding:9px 22px;
  border-radius:999px;box-shadow:0 8px 20px rgba(8,22,6,.4);pointer-events:none;z-index:6;transition:.2s;}
.mg-dd-ping.mg-dd-on{opacity:1;transform:translateX(-50%) scale(1);animation:mg-dd-wob .5s ease;}
@keyframes mg-dd-wob{25%{transform:translateX(-50%) rotate(-4deg) scale(1.08)}
  60%{transform:translateX(-50%) rotate(3deg) scale(1.02)}}

.mg-dd-over{position:absolute;inset:0;z-index:8;display:none;align-items:center;justify-content:center;
  padding:20px;background:rgba(16,34,14,.62);backdrop-filter:blur(3px);overflow:auto;}
.mg-dd-over.mg-dd-on{display:flex;}
.mg-dd-card{width:min(660px,100%);background:linear-gradient(180deg,#fffdf6,#ffeecd);border-radius:26px;
  padding:26px 30px;text-align:center;box-shadow:0 18px 0 rgba(24,50,20,.4),0 30px 60px rgba(6,18,4,.5);
  animation:mg-dd-in .4s cubic-bezier(.2,1.35,.4,1);}
@keyframes mg-dd-in{from{opacity:0;transform:translateY(26px) scale(.94)}}
.mg-dd-card h1{font-size:clamp(28px,4.4vw,42px);color:#3f7a2c;letter-spacing:.01em;}
.mg-dd-card h2{font-size:clamp(22px,3.4vw,32px);color:#e8657a;}
.mg-dd-sub{font-size:12.5px;font-weight:900;letter-spacing:.12em;opacity:.62;margin:6px 0 14px;}
.mg-dd-how{text-align:left;display:flex;flex-direction:column;gap:9px;margin:14px 0 16px;}
.mg-dd-how div{display:flex;gap:11px;align-items:flex-start;font-size:13.5px;font-weight:700;line-height:1.45;}
.mg-dd-how i{flex:none;width:24px;height:24px;border-radius:50%;background:#7ac74f;color:#fff;font-style:normal;
  font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;}
.mg-dd-swatches{display:flex;gap:7px;justify-content:center;margin-bottom:6px;}
.mg-dd-swatches i{width:26px;height:26px;border-radius:50%;border:3px solid #fff;
  box-shadow:0 3px 6px rgba(0,0,0,.2);}
.mg-dd-stats{display:flex;gap:12px;justify-content:center;margin:12px 0;flex-wrap:wrap;}
.mg-dd-stat{background:rgba(122,199,79,.16);border-radius:16px;padding:9px 18px;min-width:92px;}
.mg-dd-stat b{display:block;font-size:26px;color:#3f7a2c;}
.mg-dd-stat span{font-size:10px;font-weight:900;letter-spacing:.14em;opacity:.6;}
.mg-dd-stat.mg-dd-gold{background:rgba(242,182,74,.24);}
.mg-dd-stat.mg-dd-gold b{color:#c98e26;}
.mg-dd-ribbon{display:inline-block;background:#e8657a;color:#fff;font-weight:900;font-size:12px;
  letter-spacing:.16em;padding:6px 20px;border-radius:999px;margin-bottom:8px;
  animation:mg-dd-pulse 1s ease-in-out infinite;}
.mg-dd-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:6px;}
.mg-dd-btn{border:4px solid #fff;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:15px;letter-spacing:.08em;padding:12px 26px;cursor:pointer;
  box-shadow:0 7px 0 rgba(24,50,20,.32);transition:.14s;}
.mg-dd-btn:hover{transform:translateY(-2px);}
.mg-dd-btn:active{transform:translateY(4px);box-shadow:0 3px 0 rgba(24,50,20,.32);}
.mg-dd-btn.mg-dd-alt{background:#7ac74f;}
.mg-dd-btn.mg-dd-ghost{background:rgba(45,36,23,.14);color:#33291c;border-color:rgba(255,255,255,.6);}
.mg-dd-count{font-size:clamp(70px,17vw,150px);font-weight:900;color:#fffdf6;
  text-shadow:0 8px 0 rgba(24,50,20,.4),0 18px 30px rgba(0,0,0,.4);
  animation:mg-dd-cnt .6s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-dd-cnt{from{opacity:0;transform:scale(2.2)}60%{opacity:1}}
.mg-dd-picks{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:16px 0 6px;}
.mg-dd-pick{border:4px solid #fff;border-radius:20px;background:#7ac74f;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(15px,2.2vw,21px);letter-spacing:.04em;padding:16px 24px;cursor:pointer;
  box-shadow:0 7px 0 rgba(24,50,20,.32);transition:.14s;text-transform:uppercase;}
.mg-dd-pick:hover{transform:translateY(-3px) rotate(-1deg);background:#e8657a;}
.mg-dd-podium{display:flex;align-items:flex-end;justify-content:center;gap:12px;margin:18px 0 10px;}
.mg-dd-pod{display:flex;flex-direction:column;align-items:center;gap:6px;width:104px;}
.mg-dd-pod canvas{border-radius:50%;}
.mg-dd-pod span{font-weight:900;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:100%;}
.mg-dd-pod u{text-decoration:none;font-weight:900;font-size:11px;color:#c98e26;}
.mg-dd-plinth{width:100%;border-radius:12px 12px 0 0;background:linear-gradient(180deg,#f2b64a,#c98e26);
  color:#fff;font-weight:900;font-size:22px;display:flex;align-items:flex-start;justify-content:center;
  padding-top:6px;box-shadow:inset 0 -6px 0 rgba(0,0,0,.12);}
.mg-dd-pod.mg-dd-p1 .mg-dd-plinth{height:96px;}
.mg-dd-pod.mg-dd-p2 .mg-dd-plinth{height:70px;background:linear-gradient(180deg,#cfd6da,#9aa6ae);}
.mg-dd-pod.mg-dd-p3 .mg-dd-plinth{height:52px;background:linear-gradient(180deg,#d8a072,#a9713f);}
.mg-dd-list{display:flex;flex-direction:column;gap:5px;margin:10px auto 4px;max-width:420px;}
.mg-dd-li{display:flex;align-items:center;gap:9px;background:rgba(45,36,23,.07);border-radius:12px;
  padding:6px 14px;font-weight:800;font-size:13px;}
.mg-dd-li b{margin-left:auto;color:#3f7a2c;}
.mg-dd-li.mg-dd-me{background:rgba(122,199,79,.26);}
@media (max-width:780px){.mg-dd-side{display:none;}.mg-dd-feed{height:52px;}}
`;

// -------------------------------------------------------------------- game --
export class DoodleGame extends Minigame {
  static id = 'doodle';
  static name = 'Capy Doodles';

  constructor(game) {
    super(game);
    this.dead = false;
    this.mode = 'solo';
    this.phase = 'splash';
    this.raf = 0;
    this.last = 0;
    this.timers = new Set();
    this.subs = [];
    this.el = {};
    this.strokes = [];
    this.live = null;
    this.parts = [];
    this.dirty = true;

    // paint targets
    this.cvs = null;
    this.ctx = null;
    this.buf = null;
    this.bctx = null;
    this.scale = 1;

    // brush
    this.color = 0;
    this.width = 1;
    this.drawing = false;
    this.strokeSeq = 0;
    this.pending = null;
    this.sendAcc = 0;
    this.hover = null;
    this.clearArmed = 0;

    // clock
    this.timeLeft = 0;
    this.timeTotal = 1;
    this.lastBeep = -1;
    // party only: Date.now() at which the server's phase runs out. The round
    // clock is read off this, never counted down with rAF deltas.
    this.endAt = 0;

    // scoring
    this.score = 0;
    this.streak = 0;
    this.maxScore = SOLO_MAX;

    // solo
    this.solo = null;
    this.replay = null;
    this.ro = null;

    // party
    this.party = null;
    this.ctxRef = null;
    this.serverNear = false;
  }

  // ---------------------------------------------------------- lifecycle ----
  mount(root) {
    super.mount(root);
    this._readParty();

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-dd-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (n) => wrap.querySelector(`[data-el="${n}"]`);
    this.el = {
      wrap,
      round: q('round'),
      role: q('role'),
      word: q('word'),
      score: q('score'),
      clock: q('clock'),
      tbar: q('tbar'),
      tbarWrap: q('tbarWrap'),
      side: q('side'),
      rows: q('rows'),
      sideh: q('sideh'),
      dots: q('dots'),
      easel: q('easel'),
      paper: q('paper'),
      canvas: q('canvas'),
      pops: q('pops'),
      badge: q('badge'),
      bub: q('bub'),
      tools: q('tools'),
      swatches: q('swatches'),
      sizes: q('sizes'),
      undo: q('undo'),
      clear: q('clear'),
      guessbar: q('guessbar'),
      input: q('input'),
      send: q('send'),
      feed: q('feed'),
      ping: q('ping'),
      over: q('over'),
    };
    this.cvs = this.el.canvas;
    this.ctx = this.cvs.getContext('2d');
    this.buf = document.createElement('canvas');
    this.bctx = this.buf.getContext('2d');

    this._buildTools();
    this._bind();
    this._resize();

    if (this.mode === 'party') this._partyIntro();
    else this._splash();

    this.last = performance.now();
    this.raf = requestAnimationFrame(this._tick);
  }

  dispose() {
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    removeEventListener('resize', this._onResize);
    removeEventListener('keydown', this._onKey);
    this.ro?.disconnect();
    this.ro = null;
    if (this.cvs) {
      this.cvs.removeEventListener('pointerdown', this._onDown);
      this.cvs.removeEventListener('pointermove', this._onMove);
      this.cvs.removeEventListener('pointerup', this._onUp);
      this.cvs.removeEventListener('pointercancel', this._onUp);
      this.cvs.removeEventListener('pointerleave', this._onLeave);
    }
    // Walking out of a live party round: tell the jungle so the round can
    // rotate past us instead of waiting on an empty easel.
    if (this.mode === 'party' && this.party && !this.party.over) {
      this.game?.net?.send?.({ t: 'dd-leave' });
    }
    if (this.ctxRef && this.game && this.game.__partyCtx === this.ctxRef) this.game.__partyCtx = null;
    this.ctxRef = null;
    this.strokes.length = 0;
    this.parts.length = 0;
    this.live = null;
    this.replay = null;
    this.ctx = null;
    this.bctx = null;
    this.buf = null;
    this.cvs = null;
    this.el = {};
  }

  /** Percentage of a perfect run, capped by shared/constants.js. */
  coinsForScore(score) {
    const cap = MINIGAMES?.doodle?.maxCoinsPerRun ?? 90;
    const s = Math.max(0, Math.round(Number(score) || 0));
    const max = this.maxScore > 0 ? this.maxScore : SOLO_MAX;
    return clamp(Math.round((s / max) * cap), 0, cap);
  }

  // -------------------------------------------------------------- markup ---
  _html() {
    return `
      <div class="mg-dd-bg">
        <div class="mg-dd-leaf" style="left:-40px;top:-24px"></div>
        <div class="mg-dd-leaf" style="right:-60px;top:-30px;transform:scaleX(-1);animation-delay:1.4s"></div>
        <div class="mg-dd-leaf" style="left:-70px;bottom:40px;transform:rotate(-38deg);animation-delay:2.6s"></div>
        <div class="mg-dd-leaf" style="right:-70px;bottom:10px;transform:scaleX(-1) rotate(28deg);animation-delay:.7s"></div>
      </div>
      <div class="mg-dd-top">
        <div class="mg-dd-chip" data-el="round">ROUND 1</div>
        <div class="mg-dd-mid">
          <div class="mg-dd-role" data-el="role">GUESS THE DOODLE</div>
          <div class="mg-dd-word" data-el="word"></div>
        </div>
        <div class="mg-dd-chip mg-dd-score"><small>SCORE</small><b data-el="score">0</b></div>
        <div class="mg-dd-chip mg-dd-clock" data-el="clock"><b>0</b><small>s</small></div>
        <button class="mg-dd-quit" data-el="quit">QUIT</button>
      </div>
      <div class="mg-dd-tbar" data-el="tbarWrap"><i data-el="tbar"></i></div>
      <div class="mg-dd-body">
        <aside class="mg-dd-side mg-dd-hide" data-el="side">
          <div class="mg-dd-sideh" data-el="sideh">DOODLERS</div>
          <div class="mg-dd-rows" data-el="rows"></div>
          <div class="mg-dd-dots" data-el="dots"></div>
        </aside>
        <div class="mg-dd-stage">
          <div class="mg-dd-easel" data-el="easel">
            <div class="mg-dd-paper" data-el="paper">
              <canvas data-el="canvas"></canvas>
              <div class="mg-dd-pops" data-el="pops"></div>
              <div class="mg-dd-badge" data-el="badge"></div>
              <div class="mg-dd-bub" data-el="bub"></div>
            </div>
          </div>
          <div class="mg-dd-tools" data-el="tools">
            <div data-el="swatches" style="display:flex;gap:6px"></div>
            <div class="mg-dd-sep"></div>
            <div data-el="sizes" style="display:flex;gap:6px"></div>
            <div class="mg-dd-sep"></div>
            <button class="mg-dd-tbtn" data-el="undo">UNDO</button>
            <button class="mg-dd-tbtn" data-el="clear">CLEAR</button>
          </div>
          <div class="mg-dd-guess" data-el="guessbar">
            <input data-el="input" type="text" maxlength="26" autocomplete="off" spellcheck="false"
              placeholder="Type your guess, hit Enter">
            <button data-el="send">GUESS</button>
          </div>
          <div class="mg-dd-feed" data-el="feed"></div>
        </div>
      </div>
      <div class="mg-dd-ping" data-el="ping">so close!</div>
      <div class="mg-dd-over" data-el="over"></div>`;
  }

  _buildTools() {
    const sw = this.el.swatches;
    this.swEls = [];
    PALETTE.forEach((col, i) => {
      const b = document.createElement('button');
      b.className = `mg-dd-sw${i === this.color ? ' mg-dd-sel' : ''}`;
      b.style.background = col;
      b.title = `Crayon ${i + 1}`;
      b.addEventListener('click', () => this._setColor(i));
      sw.appendChild(b);
      this.swEls.push(b);
    });
    const sz = this.el.sizes;
    this.szEls = [];
    WIDTHS.forEach((_, i) => {
      const b = document.createElement('button');
      b.className = `mg-dd-sz${i === this.width ? ' mg-dd-sel' : ''}`;
      b.textContent = SIZE_LABELS[i];
      b.addEventListener('click', () => this._setWidth(i));
      sz.appendChild(b);
      this.szEls.push(b);
    });
  }

  _bind() {
    const { wrap, canvas, input, send, undo, clear } = this.el;
    wrap.querySelector('[data-el="quit"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });

    this._onDown = (e) => this._penDown(e);
    this._onMove = (e) => this._penMove(e);
    this._onUp = (e) => this._penUp(e);
    this._onLeave = () => { this.hover = null; this.dirty = true; };
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('pointerleave', this._onLeave);

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the world HUD must never see round guesses
      if (e.key === 'Enter') { e.preventDefault(); this._submitGuess(); }
    });
    send.addEventListener('click', () => this._submitGuess());

    undo.addEventListener('click', () => this._undo());
    clear.addEventListener('click', () => this._clearPressed());

    this._onResize = () => { this._resize(); };
    addEventListener('resize', this._onResize);
    // The engine can un-hide #minigame-root a frame AFTER mount, so the easel
    // measures 0x0 while we are sizing the paper. Watch the box instead of
    // trusting one measurement (and keep the window listener for good measure).
    if (typeof ResizeObserver === 'function' && this.el.easel) {
      this.ro = new ResizeObserver(() => { if (!this.dead) this._resize(); });
      this.ro.observe(this.el.easel);
    }

    // drawer hotkeys: crayons on 1-8, Z undo. Never while typing a guess.
    this._onKey = (e) => {
      if (this.dead || !this._iAmDrawer()) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key >= '1' && e.key <= '8') this._setColor(Number(e.key) - 1);
      else if (e.key === 'z' || e.key === 'Z') this._undo();
      else if (e.key === '[') this._setWidth(Math.max(0, this.width - 1));
      else if (e.key === ']') this._setWidth(Math.min(WIDTHS.length - 1, this.width + 1));
    };
    addEventListener('keydown', this._onKey);

    if (this.mode === 'party') {
      const on = (evt, fn) => this.subs.push(this.game.events.on(evt, fn));
      on('dd-words', (m) => this._onWords(m));
      on('dd-mask', (m) => this._onMask(m));
      on('dd-stroke', (m) => this._onStroke(m));
      on('dd-correct', (m) => this._onCorrect(m));
      on('dd-state', (m) => this._onState(m));
      on('dd-end', (m) => this._onEnd(m));
    }
  }

  // -------------------------------------------------------------- canvas ---
  /**
   * Cheap size poll. ResizeObserver covers the normal case, but a background
   * or non-compositing tab can skip the rendering steps that deliver it, and a
   * paper stuck at its mount-time size is the worst possible failure here.
   */
  _checkSize() {
    const e = this.el.easel;
    if (!e) return;
    if (e.clientWidth !== this._ew || e.clientHeight !== this._eh) this._resize();
  }

  _resize() {
    if (!this.cvs || !this.el.easel) return;
    const box = this.el.easel.getBoundingClientRect();
    this._ew = this.el.easel.clientWidth;
    this._eh = this.el.easel.clientHeight;
    // leave room for the 15px wooden frame the paper wears as a box-shadow,
    // or it laps over the tool row and the guess box below
    const availW = Math.max(160, box.width - 34);
    const availH = Math.max(120, box.height - 34);
    let w = Math.min(availW, availH * (W / H));
    let h = w * (H / W);
    if (h > availH) { h = availH; w = h * (W / H); }
    this.el.paper.style.width = `${Math.round(w)}px`;
    this.el.paper.style.height = `${Math.round(h)}px`;
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));
    if (this.cvs.width !== pw || this.cvs.height !== ph) {
      this.cvs.width = pw;
      this.cvs.height = ph;
      this.buf.width = pw;
      this.buf.height = ph;
    }
    this.scale = pw / W;
    this._recommit();
  }

  _recommit() {
    const b = this.bctx;
    if (!b) return;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, this.buf.width, this.buf.height);
    b.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    for (const s of this.strokes) strokePath(b, s.p, PALETTE[s.c] || PALETTE[0], WIDTHS[s.w] ?? WIDTHS[1]);
    this.dirty = true;
  }

  _commit(stroke) {
    if (!stroke || stroke.p.length < 2) return;
    if (this.strokes.length >= MAX_STROKES) {
      this.strokes.shift();
      this.strokes.push(stroke);
      this._recommit(); // the dropped stroke is still painted into the buffer
      return;
    }
    this.strokes.push(stroke);
    if (this.bctx) {
      strokePath(this.bctx, stroke.p, PALETTE[stroke.c] || PALETTE[0], WIDTHS[stroke.w] ?? WIDTHS[1]);
    }
    this.dirty = true;
  }

  _paint() {
    const ctx = this.ctx;
    if (!ctx || !this.cvs) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cvs.width, this.cvs.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.drawImage(this.buf, 0, 0, W, H);
    if (this.live && this.live.p.length >= 2) {
      strokePath(ctx, this.live.p, PALETTE[this.live.c] || PALETTE[0], WIDTHS[this.live.w] ?? WIDTHS[1]);
    }
    // brush ghost so the drawer can feel the crayon before touching paper
    if (this.hover && this._iAmDrawer() && !this.drawing) {
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, Math.max(4, WIDTHS[this.width] / 2), 0, TAU);
      ctx.strokeStyle = 'rgba(45,36,23,.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = PALETTE[this.color];
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    for (const p of this.parts) {
      ctx.globalAlpha = clamp(p.life / 0.5, 0, 1);
      ctx.fillStyle = p.col;
      if (p.kind === 'confetti') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.s * 0.5, -p.s * 0.32, p.s, p.s * 0.64);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s * 0.5, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    this.dirty = false;
  }

  _burst(x, y, n = 26) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 120 + Math.random() * 340;
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120,
        life: 0.8 + Math.random() * 0.7, s: 10 + Math.random() * 16,
        rot: Math.random() * TAU, spin: (Math.random() - 0.5) * 12,
        col: PALETTE[1 + Math.floor(Math.random() * 7)], kind: 'confetti',
      });
    }
    if (this.parts.length > 240) this.parts.splice(0, this.parts.length - 240);
  }

  _puff(x, y) {
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU;
      this.parts.push({
        x, y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90 - 40,
        life: 0.4 + Math.random() * 0.3, s: 8 + Math.random() * 12,
        rot: 0, spin: 0, col: 'rgba(160,140,110,.7)', kind: 'puff',
      });
    }
  }

  // ------------------------------------------------------------ pen input --
  _iAmDrawer() {
    if (this.mode === 'party') return !!(this.party && this.party.drawerId === this.party.meId);
    return false;
  }

  _canDraw() {
    return this.mode === 'party' && this.phase === 'draw' && this._iAmDrawer();
  }

  _pos(e) {
    const r = this.cvs.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: clamp(((e.clientX - r.left) / r.width) * W, 0, W),
      y: clamp(((e.clientY - r.top) / r.height) * H, 0, H),
    };
  }

  _penDown(e) {
    if (!this._canDraw()) return;
    const p = this._pos(e);
    this.drawing = true;
    this.strokeSeq = (this.strokeSeq + 1) & 0xffff;
    this.live = { c: this.color, w: this.width, p: [Math.round(p.x), Math.round(p.y)] };
    this.pending = { s: this.strokeSeq, c: this.color, w: this.width, pts: [Math.round(p.x), Math.round(p.y)] };
    this.sendAcc = 0;
    this.hover = p;
    this.dirty = true;
    try { this.cvs.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    this.game.audio?.play?.('tick');
  }

  _penMove(e) {
    if (!this._canDraw()) return;
    const p = this._pos(e);
    this.hover = p;
    this.dirty = true;
    if (!this.drawing || !this.live) return;
    const pts = this.live.p;
    const lx = pts[pts.length - 2];
    const ly = pts[pts.length - 1];
    if (Math.hypot(p.x - lx, p.y - ly) < MIN_STEP) return;
    if (pts.length >= MAX_PTS) return;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    pts.push(x, y);
    if (this.pending) this.pending.pts.push(x, y);
  }

  _penUp(e) {
    if (!this.drawing) return;
    this.drawing = false;
    try { this.cvs.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    const s = this.live;
    this.live = null;
    if (s) this._commit(s);
    this._flushStroke(true);
  }

  _flushStroke(end = false) {
    const pend = this.pending;
    if (!pend || !this.game?.net?.send) { if (end) this.pending = null; return; }
    const pts = pend.pts;
    // stream in bounded chunks; the tail carries the end flag
    while (pts.length > SEND_CHUNK) {
      const chunk = pts.splice(0, SEND_CHUNK);
      this.game.net.send({ t: 'dd-stroke', s: pend.s, c: pend.c, w: pend.w, pts: chunk });
      // keep the last point so the receiver's polyline stays continuous
      pts.unshift(chunk[chunk.length - 2], chunk[chunk.length - 1]);
    }
    if (pts.length >= 2 && (end || pts.length > 2)) {
      this.game.net.send({ t: 'dd-stroke', s: pend.s, c: pend.c, w: pend.w, pts: pts.slice(), e: end ? 1 : 0 });
      const tailX = pts[pts.length - 2];
      const tailY = pts[pts.length - 1];
      pts.length = 0;
      if (!end) pts.push(tailX, tailY);
    } else if (end) {
      this.game.net.send({ t: 'dd-stroke', s: pend.s, c: pend.c, w: pend.w, pts: [], e: 1 });
    }
    if (end) this.pending = null;
  }

  _setColor(i) {
    if (!Number.isFinite(i) || i < 0 || i >= PALETTE.length) return;
    this.color = i;
    this.swEls?.forEach((b, k) => b.classList.toggle('mg-dd-sel', k === i));
    this.game.audio?.play?.('tick');
    this.dirty = true;
  }

  _setWidth(i) {
    if (!Number.isFinite(i) || i < 0 || i >= WIDTHS.length) return;
    this.width = i;
    this.szEls?.forEach((b, k) => b.classList.toggle('mg-dd-sel', k === i));
    this.game.audio?.play?.('tick');
    this.dirty = true;
  }

  _undo() {
    if (!this._canDraw() || !this.strokes.length) return;
    this.strokes.pop();
    this._recommit();
    this.game.audio?.play?.('whoosh');
    this.game.net?.send?.({ t: 'dd-stroke', op: 'undo' });
  }

  /** Two-tap clear: an accidental wipe 60s into a drawing is heartbreaking. */
  _clearPressed() {
    if (!this._canDraw()) return;
    const now = performance.now();
    if (this.clearArmed && now - this.clearArmed < 2600) {
      this.clearArmed = 0;
      this.el.clear.classList.remove('mg-dd-warn');
      this.el.clear.textContent = 'CLEAR';
      this.strokes.length = 0;
      this.live = null;
      this._recommit();
      this.game.audio?.play?.('whoosh');
      this.game.net?.send?.({ t: 'dd-stroke', op: 'clear' });
      return;
    }
    this.clearArmed = now;
    this.el.clear.classList.add('mg-dd-warn');
    this.el.clear.textContent = 'SURE?';
    this._after(2600, () => {
      if (!this.el.clear) return;
      this.clearArmed = 0;
      this.el.clear.classList.remove('mg-dd-warn');
      this.el.clear.textContent = 'CLEAR';
    });
  }

  // --------------------------------------------------------------- timers --
  _after(ms, fn) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.dead) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  _tick = (now) => {
    if (this.dead) return;
    this.raf = requestAnimationFrame(this._tick);
    const dt = clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;
    this._szAcc = (this._szAcc || 0) + 1;
    if (this._szAcc >= 12) { this._szAcc = 0; this._checkSize(); }

    if (this.phase === 'draw') {
      // Party: the deadline is the server's, held as wall-clock time. Solo: the
      // clock and Doodles' crayon advance together off the same rAF dt, so a
      // backgrounded solo run simply pauses, which is the honest outcome.
      if (this.mode === 'party' && this.endAt) this._syncClock();
      else this.timeLeft = Math.max(0, this.timeLeft - dt);
      this._paintClock();
      if (this.mode === 'solo') {
        this._advanceReplay(dt);
        this._soloReveals();
        if (this.timeLeft <= 0) this._soloMiss();
      }
    }

    // our own strokes leave in ~10Hz batches while the crayon is down
    if (this.drawing && this.pending) {
      this.sendAcc += dt;
      if (this.sendAcc >= 1 / SEND_HZ) {
        this.sendAcc = 0;
        this._flushStroke(false);
      }
    }

    // particles
    if (this.parts.length) {
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i];
        p.life -= dt;
        if (p.life <= 0) { this.parts.splice(i, 1); continue; }
        p.vy += 900 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
      }
      this.dirty = true;
    }
    if (this.dirty) this._paint();
  };

  /**
   * Re-read the party clock off the wall clock. `endAt` is set from the ms the
   * server puts on every dd-state, so this survives everything rAF does not: a
   * backgrounded tab, a throttled timer, a stalled frame. Come back from
   * another tab and the timer shows what the round actually has left, because
   * the server's round never paused.
   */
  _syncClock() {
    if (!this.endAt) return;
    this.timeLeft = Math.max(0, (this.endAt - Date.now()) / 1000);
  }

  _paintClock() {
    const left = Math.ceil(this.timeLeft);
    if (left !== this.lastBeep) {
      this.lastBeep = left;
      const b = this.el.clock?.querySelector('b');
      if (b) b.textContent = String(Math.max(0, left));
      const panic = left <= 10 && this.phase === 'draw';
      this.el.clock?.classList.toggle('mg-dd-panic', panic);
      this.el.tbarWrap?.classList.toggle('mg-dd-panic', panic);
      if (panic && left > 0) this.game.audio?.play?.('tick');
    }
    if (this.el.tbar) {
      this.el.tbar.style.width = `${clamp((this.timeLeft / Math.max(1, this.timeTotal)) * 100, 0, 100)}%`;
    }
  }

  // ---------------------------------------------------------------- HUD ----
  _setRole(text) { if (this.el.role) this.el.role.textContent = text; }

  _setRound(text) { if (this.el.round) this.el.round.textContent = text; }

  _setScore(v) {
    this.score = v;
    const el = this.el.score;
    if (!el) return;
    el.textContent = String(Math.round(v));
    const chip = el.parentElement;
    chip?.classList.remove('mg-dd-bump');
    void chip?.offsetWidth;
    chip?.classList.add('mg-dd-bump');
  }

  /**
   * Render the word rail. `mask` uses '_' for a hidden letter, ' ' for a word
   * break and any other character for a revealed one. `full` paints it green
   * (the reveal at the end of a round, or the drawer's own word).
   */
  _setMask(mask, full = false) {
    const el = this.el.word;
    if (!el) return;
    el.className = `mg-dd-word${full ? ' mg-dd-full' : ''}`;
    const chars = normMask(mask).split('');
    el.innerHTML = chars.map((c) => {
      if (c === ' ') return '<div class="mg-dd-l mg-dd-gap"></div>';
      if (c === '_') return '<div class="mg-dd-l"></div>';
      return `<div class="mg-dd-l mg-dd-shown">${esc(c)}</div>`;
    }).join('');
  }

  _badge(text) {
    const b = this.el.badge;
    if (!b) return;
    if (!text) { b.classList.remove('mg-dd-on'); return; }
    b.textContent = text;
    b.classList.add('mg-dd-on');
  }

  _say(text) {
    const b = this.el.bub;
    if (!b) return;
    b.textContent = text;
    b.classList.add('mg-dd-on');
    this._after(2600, () => b?.classList.remove('mg-dd-on'));
  }

  _pop(text, x = W / 2, y = H / 2, color = '#3f7a2c') {
    const host = this.el.pops;
    if (!host) return;
    const d = document.createElement('div');
    d.className = 'mg-dd-pop';
    d.textContent = text;
    d.style.left = `${(x / W) * 100}%`;
    d.style.top = `${(y / H) * 100}%`;
    d.style.color = color;
    host.appendChild(d);
    if (host.childElementCount > 8) host.firstElementChild?.remove();
    this._after(1200, () => d.remove());
  }

  _feed(html, cls = '') {
    const f = this.el.feed;
    if (!f) return;
    const d = document.createElement('div');
    d.className = `mg-dd-fl ${cls}`.trim();
    d.innerHTML = html;
    f.prepend(d);
    while (f.childElementCount > 14) f.lastElementChild?.remove();
  }

  _ping(text) {
    const p = this.el.ping;
    if (!p) return;
    p.textContent = text;
    p.classList.remove('mg-dd-on');
    void p.offsetWidth;
    p.classList.add('mg-dd-on');
    this.game.audio?.play?.('pop');
    this._after(1500, () => p?.classList.remove('mg-dd-on'));
  }

  _shake() {
    const p = this.el.paper;
    if (!p) return;
    p.classList.remove('mg-dd-shake');
    void p.offsetWidth;
    p.classList.add('mg-dd-shake');
  }

  _showTools(on) { this.el.tools?.classList.toggle('mg-dd-on', !!on); }

  _showGuess(on, placeholder) {
    this.el.guessbar?.classList.toggle('mg-dd-off', !on);
    if (this.el.input) {
      this.el.input.disabled = !on;
      if (placeholder) this.el.input.placeholder = placeholder;
      if (on) { this.el.input.value = ''; this._after(30, () => this.el.input?.focus()); }
    }
    this.el.paper?.classList.toggle('mg-dd-draw', this._canDraw());
  }

  _over(html) {
    const o = this.el.over;
    if (!o) return;
    o.innerHTML = html;
    o.classList.add('mg-dd-on');
  }

  _closeOver() {
    this.el.over?.classList.remove('mg-dd-on');
    if (this.el.over) this.el.over.innerHTML = '';
  }

  // ------------------------------------------------------------ scoreboard -
  _buildRows(list) {
    const host = this.el.rows;
    if (!host) return;
    host.innerHTML = '';
    this.rowEls = new Map();
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'mg-dd-row';
      const av = capyCanvas(28, hexOf(p.color), !!p.bot);
      row.appendChild(av);
      const name = document.createElement('span');
      name.textContent = p.name;
      row.appendChild(name);
      const tag = document.createElement('i');
      row.appendChild(tag);
      const sc = document.createElement('b');
      sc.textContent = '0';
      row.appendChild(sc);
      host.appendChild(row);
      this.rowEls.set(p.id, { row, sc, tag });
    }
  }

  _updateRows() {
    if (!this.rowEls) return;
    const P = this.party;
    for (const [id, r] of this.rowEls) {
      const score = P ? (P.scores.get(id) || 0) : (this.soloScores?.get(id) || 0);
      // Doodles keeps no score of her own: she is the easel, not a rival
      r.sc.textContent = !P && id === 'bot' ? '' : String(Math.round(score));
      const drawing = P ? P.drawerId === id : this.soloDrawer === id;
      const got = P ? P.correct.has(id) : false;
      r.row.classList.toggle('mg-dd-drawing', drawing);
      r.row.classList.toggle('mg-dd-got', got && !drawing);
      r.tag.textContent = drawing ? 'DRAWING' : got ? 'GOT IT' : '';
    }
  }

  _buildDots(n) {
    const host = this.el.dots;
    if (!host) return;
    host.innerHTML = '';
    this.dotEls = [];
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = 'mg-dd-dot';
      host.appendChild(d);
      this.dotEls.push(d);
    }
  }

  _setDot(i, state) {
    const d = this.dotEls?.[i];
    if (!d) return;
    d.className = `mg-dd-dot${state ? ` mg-dd-${state}` : ''}`;
  }

  // ================================================================ SOLO ====
  _splash() {
    this.phase = 'splash';
    this.el.side?.classList.add('mg-dd-hide'); // nothing to score yet
    this._showTools(false);
    this._showGuess(false);
    this._setRole('GUESS THE DOODLE');
    this._setMask('');
    this._setRound('SKETCHBOOK');
    this.timeLeft = 0;
    this.timeTotal = 1;
    this._paintClock();
    const best = this.game.state?.bests?.doodle || 0;
    this._over(`
      <div class="mg-dd-card">
        <h1>Capy Doodles</h1>
        <div class="mg-dd-sub">DOODLES THE CAPYBARA DRAWS. YOU NAME IT BEFORE THE CLOCK DOES.</div>
        <div class="mg-dd-swatches">${PALETTE.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
        <div class="mg-dd-how">
          <div><i>1</i><span>Doodles picks a word and starts scribbling. The blanks up top show how long it is.</span></div>
          <div><i>2</i><span>Type your guess and hit <b>Enter</b>. Guess early, score big: 100 points fading to 40.</span></div>
          <div><i>3</i><span>Letters flip open as the round runs on, and a near miss earns a cheeky "so close!".</span></div>
          <div><i>4</i><span>Six doodles, and each one gives you less time than the last. Streaks pay a bonus.</span></div>
        </div>
        <div class="mg-dd-stats">
          <div class="mg-dd-stat"><b>${best}</b><span>YOUR BEST</span></div>
          <div class="mg-dd-stat mg-dd-gold"><b>${this.coinsForScore(best)}</b><span>COINS THEN</span></div>
        </div>
        <div class="mg-dd-btns">
          <button class="mg-dd-btn" data-a="play">START GUESSING</button>
          <button class="mg-dd-btn mg-dd-ghost" data-a="leave">Back to the jungle</button>
        </div>
      </div>`);
    this.el.over.querySelector('[data-a="play"]').addEventListener('click', () => this._countdown());
    this.el.over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
  }

  _countdown() {
    this.game.audio?.play?.('click');
    this._soloReset();
    this.phase = 'count';
    const steps = ['3', '2', '1', 'DRAW!'];
    const show = (i) => {
      if (this.dead) return;
      if (i >= steps.length) { this._closeOver(); this._soloNext(); return; }
      this._over(`<div class="mg-dd-count">${steps[i]}</div>`);
      this.game.audio?.play?.(i === steps.length - 1 ? 'success' : 'ding');
      this._after(i === steps.length - 1 ? 460 : 600, () => show(i + 1));
    };
    show(0);
  }

  _soloReset() {
    this.mode = 'solo';
    this.endAt = 0;
    this.maxScore = SOLO_MAX;
    this._setScore(0);
    this.streak = 0;
    this.strokes.length = 0;
    this.live = null;
    this.replay = null;
    this.parts.length = 0;
    this._recommit();

    // pick six drawings, easy first: that is the escalation curve
    const byTier = [[], [], []];
    for (const d of DRAWINGS) byTier[clamp(d.hard, 1, 3) - 1].push(d);
    for (const t of byTier) t.sort(() => Math.random() - 0.5);
    const order = [];
    const take = (tier, n) => { while (n-- > 0 && byTier[tier].length) order.push(byTier[tier].pop()); };
    take(0, 2);   // warm up on the simple silhouettes
    take(1, 3);   // then the fiddlier ones
    take(2, 1);   // finish on a proper puzzle
    while (order.length < SOLO_ROUNDS) {
      const spare = byTier[0].pop() || byTier[1].pop() || byTier[2].pop();
      if (!spare) break;
      order.push(spare);
    }
    this.solo = { order, round: 0, results: [], word: '', shown: [] };
    this.soloDrawer = 'bot';
    this.soloScores = new Map([['bot', 0], ['me', 0]]);
    this._buildRows([
      { id: 'bot', name: 'Doodles', color: 0x8a6642, bot: true },
      { id: 'me', name: this.game.state?.name || 'You', color: this.game.state?.color ?? 0xb08a5a },
    ]);
    this._buildDots(order.length);
    this._updateRows();
    this.el.side?.classList.remove('mg-dd-hide');
    if (this.el.sideh) this.el.sideh.textContent = 'THE EASEL';
  }

  _soloNext() {
    const S0 = this.solo;
    if (!S0) return;
    if (S0.round >= S0.order.length) { this._soloResults(); return; }
    const idx = S0.round;
    const d = S0.order[idx];
    S0.word = normWord(d.word);
    S0.shown = [];
    S0.guesses = 0;
    this.phase = 'draw';
    this.strokes.length = 0;
    this.live = null;
    this._recommit();
    this.timeTotal = SOLO_TIMES[Math.min(idx, SOLO_TIMES.length - 1)];
    this.timeLeft = this.timeTotal;
    this.lastBeep = -1;
    this._setRound(`DOODLE ${idx + 1}/${S0.order.length}`);
    this._setRole('DOODLES IS DRAWING');
    this._setMask(this._soloMask());
    this._badge('DOODLES IS DRAWING');
    this._showGuess(true, 'Type your guess, hit Enter');
    this._setDot(idx, 'now');
    this._updateRows();
    this._startReplay(d, this.timeTotal * REPLAY_FRAC);
    this._say(pick(DOODLE_LINES.start));
    this.game.audio?.play?.('whoosh');
    this._paintClock();
  }

  /** Blanks, with whatever letters the clock has flipped open so far. */
  _soloMask() {
    const S0 = this.solo;
    if (!S0) return '';
    const w = S0.word;
    let out = '';
    for (let i = 0; i < w.length; i++) {
      if (w[i] === ' ') out += ' ';
      else out += S0.shown.includes(i) ? w[i] : '_';
    }
    return out;
  }

  /**
   * Letter reveals. Later rounds hold out longer, so the escalation is in the
   * clock AND in how much help you get.
   */
  _soloReveals() {
    const S0 = this.solo;
    if (!S0 || this.phase !== 'draw') return;
    const idx = S0.round;
    const gone = 1 - this.timeLeft / Math.max(1, this.timeTotal);
    const late = idx * 0.03;
    const letters = [];
    for (let i = 0; i < S0.word.length; i++) if (S0.word[i] !== ' ') letters.push(i);
    const want = (gone >= 0.46 + late ? 1 : 0)
      + (gone >= 0.68 + late ? 1 : 0)
      + (letters.length >= 7 && gone >= 0.84 + late ? 1 : 0);
    while (S0.shown.length < Math.min(want, Math.max(0, letters.length - 2))) {
      // first letter, then spread through the middle: never give away the tail
      const pool = letters.filter((i) => !S0.shown.includes(i));
      const nextI = S0.shown.length === 0 ? pool[0] : pool[Math.floor(pool.length / 2)];
      if (nextI === undefined) break;
      S0.shown.push(nextI);
      this._setMask(this._soloMask());
      this.game.audio?.play?.('ding');
    }
  }

  _startReplay(d, dur) {
    const strokes = d.strokes;
    const lens = strokes.map((s) => pathLen(s.p));
    const total = lens.reduce((a, b) => a + b, 0) + strokes.length * LIFT;
    this.replay = { strokes, lens, total: Math.max(1, total), dur: Math.max(1, dur), t: 0, i: 0, spent: 0 };
  }

  _advanceReplay(dt) {
    const R = this.replay;
    if (!R) return;
    R.t = Math.min(R.dur, R.t + dt);
    let budget = (R.t / R.dur) * R.total - R.spent;
    while (R.i < R.strokes.length && budget >= R.lens[R.i] + LIFT) {
      this._commit(R.strokes[R.i]);
      const cost = R.lens[R.i] + LIFT;
      R.spent += cost;
      budget -= cost;
      R.i++;
      this.live = null;
    }
    if (R.i < R.strokes.length) {
      const s = R.strokes[R.i];
      const f = clamp(budget / Math.max(1, R.lens[R.i]), 0, 1);
      this.live = { c: s.c, w: s.w, p: partialPath(s.p, f) };
      this.dirty = true;
    } else {
      this.live = null;
      this.replay = null;
      this._badge('DOODLES IS DONE. WELL?');
    }
  }

  _soloGuess(raw) {
    const S0 = this.solo;
    if (!S0 || this.phase !== 'draw') return;
    const g = normWord(raw);
    if (!g) return;
    S0.guesses++;
    if (g === S0.word) { this._soloCorrect(); return; }
    const d = lev(g, S0.word);
    if (d <= 1) {
      this._feed(`<b>you</b> ${esc(raw)} &middot; so close!`, 'mg-dd-close');
      this._ping('so close!');
      this._say(pick(DOODLE_LINES.near));
      return;
    }
    this._feed(`<b>you</b> ${esc(raw)}`);
    this.game.audio?.play?.('pop');
    if (S0.guesses % 3 === 0) this._say(pick(DOODLE_LINES.wrong));
  }

  _soloCorrect() {
    const S0 = this.solo;
    const idx = S0.round;
    const frac = clamp(this.timeLeft / Math.max(1, this.timeTotal), 0, 1);
    const speed = 40 + Math.round(60 * frac);
    const bonus = Math.min(20, this.streak * 5);
    const pts = speed + bonus;
    this.streak++;
    this._setScore(this.score + pts);
    this.soloScores.set('me', this.score);
    S0.results.push({ word: S0.word, pts, got: true });
    this._setDot(idx, 'hit');
    this._updateRows();
    this.phase = 'reveal';
    this._setMask(S0.word, true);
    this._setRole('GOT IT!');
    this._badge('');
    this._showGuess(false);
    this._burst(W / 2, H / 2, 30);
    this._pop(`+${pts}`, W / 2, H * 0.4);
    if (bonus) this._pop(`streak +${bonus}`, W * 0.7, H * 0.6, '#c98e26');
    this.game.audio?.play?.('success');
    this.game.audio?.play?.('sparkle');
    this._say(pick(DOODLE_LINES.right));
    this._feed(`<b>you</b> ${esc(S0.word)} &middot; +${pts}`, 'mg-dd-good');
    S0.round++;
    this._after(2200, () => this._soloNext());
  }

  _soloMiss() {
    const S0 = this.solo;
    if (!S0 || this.phase !== 'draw') return;
    const idx = S0.round;
    this.phase = 'reveal';
    this.streak = 0;
    S0.results.push({ word: S0.word, pts: 0, got: false });
    this._setDot(idx, 'miss');
    this._setMask(S0.word, true);
    this._setRole(`IT WAS "${S0.word.toUpperCase()}"`);
    this._badge('');
    this._showGuess(false);
    this._shake();
    this._puff(W / 2, H / 2);
    this.game.audio?.play?.('fail');
    this._say(pick(DOODLE_LINES.miss));
    S0.round++;
    this._after(2600, () => this._soloNext());
  }

  _soloResults() {
    this.phase = 'results';
    this._showGuess(false);
    this._showTools(false);
    this._badge('');
    this.soloDrawer = null;   // Doodles has downed crayons
    this._updateRows();
    this.timeLeft = 0;
    this.lastBeep = -1;
    this._paintClock();
    this.el.clock?.classList.remove('mg-dd-panic');
    this.el.tbarWrap?.classList.remove('mg-dd-panic');
    const score = Math.round(this.score);
    const prev = this.game.state?.bests?.doodle || 0;
    const isBest = score > prev;
    const coins = this.coinsForScore(score);
    this.finish(score);
    const got = this.solo.results.filter((r) => r.got).length;
    const shown = Math.max(prev, score);
    this.game.audio?.play?.(isBest ? 'levelup' : 'ding');
    if (isBest) this._burst(W / 2, H * 0.4, 40);
    const rows = this.solo.results.map((r) => `
      <div class="mg-dd-li${r.got ? ' mg-dd-me' : ''}">
        <span>${r.got ? '&#10003;' : '&#10007;'} ${esc(r.word)}</span><b>${r.got ? `+${r.pts}` : '0'}</b>
      </div>`).join('');
    this._over(`
      <div class="mg-dd-card">
        ${isBest ? '<div class="mg-dd-ribbon">NEW SKETCHBOOK RECORD</div>' : ''}
        <h2>Sketchbook closed</h2>
        <div class="mg-dd-sub">${esc(this._verdict(got))}</div>
        <div class="mg-dd-stats">
          <div class="mg-dd-stat"><b>${score}</b><span>SCORE</span></div>
          <div class="mg-dd-stat mg-dd-gold"><b>${coins}</b><span>COINS</span></div>
          <div class="mg-dd-stat"><b>${shown}</b><span>BEST</span></div>
          <div class="mg-dd-stat"><b>${got}/${this.solo.results.length}</b><span>NAMED</span></div>
        </div>
        <div class="mg-dd-list">${rows}</div>
        <div class="mg-dd-btns">
          <button class="mg-dd-btn" data-a="again">Play again</button>
          <button class="mg-dd-btn mg-dd-alt" data-a="leave">Back to the jungle</button>
        </div>
      </div>`);
    this.el.over.querySelector('[data-a="again"]').addEventListener('click', () => {
      this._done = false; // a fresh run reports its own score
      this._countdown();
    });
    this.el.over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  _verdict(got) {
    if (got >= 6) return 'DOODLES HAS NEVER BEEN READ SO EASILY.';
    if (got >= 4) return 'SHARP EYES. THE JUNGLE IS IMPRESSED.';
    if (got >= 2) return 'A COUPLE OF CLEAN CALLS IN THERE.';
    return 'MODERN ART IS HARD. TRY THE SQUINT TECHNIQUE.';
  }

  // =============================================================== PARTY ====
  /**
   * The jungle parks {game:'doodle', players, youAre} before starting us.
   * Anything malformed degrades to the solo sketchbook rather than a broken
   * round: playing with Doodles always beats staring at an empty easel.
   */
  _readParty() {
    const ctx = this.game?.__partyCtx;
    this.ctxRef = ctx || null;
    if (!ctx || ctx.game !== 'doodle' || !Array.isArray(ctx.players) || ctx.players.length < 2) return;
    const raw = ctx.players.filter((p) => p && typeof p === 'object').slice(0, 8);
    if (raw.length < 2) return;
    const players = raw.map((p, i) => ({
      id: p.id ?? `p${i}`,
      name: String(p.name || 'Capy').slice(0, 16),
      color: Number.isFinite(p.color) ? p.color : 0xb08a5a,
    }));
    let meId = null;
    const selfId = this.game.net?.selfId ?? null;
    if (typeof ctx.youAre === 'number' && players[ctx.youAre]) meId = players[ctx.youAre].id;
    else if (typeof ctx.youAre === 'string') meId = ctx.youAre;
    if (meId === null && selfId != null && players.some((p) => p.id === selfId)) meId = selfId;
    if (meId === null) {
      const mine = players.find((p) => p.name === this.game.state?.name);
      meId = mine ? mine.id : players[0].id;
    }
    this.mode = 'party';
    this.party = {
      players,
      meId,
      drawerId: null,
      round: 1,
      rounds: clamp(num(ctx.rounds) ?? players.length, 2, 5),
      scores: new Map(players.map((p) => [p.id, 0])),
      correct: new Set(),
      roundKey: '',
      word: '',
      mask: '',
      over: false,
      picked: false,
      remote: null,
      remoteSeq: -1,
    };
    this.maxScore = Math.max(120, (this.party.rounds - 1) * 100 + 15 * (players.length - 1));
  }

  _partyIntro() {
    const P = this.party;
    this.phase = 'wait';
    this._buildRows(P.players);
    this._updateRows();
    this.el.side?.classList.remove('mg-dd-hide');
    if (this.el.sideh) this.el.sideh.textContent = `DOODLERS ${P.players.length}/8`;
    this._buildDots(P.rounds);
    this._setDot(0, 'now');
    this._setRound(`ROUND 1/${P.rounds}`);
    this._setRole('GETTING THE CRAYONS OUT');
    this._showGuess(false);
    this._showTools(false);
    const names = P.players.map((p) => esc(p.name)).join(', ');
    this._over(`
      <div class="mg-dd-card">
        <h1>Capy Doodles</h1>
        <div class="mg-dd-sub">${P.players.length} CAPYS AT THE STONE EASEL</div>
        <div class="mg-dd-swatches">${PALETTE.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
        <div class="mg-dd-how">
          <div><i>1</i><span>Each round one capy draws a secret word. Everyone else types guesses down below.</span></div>
          <div><i>2</i><span>First correct guess takes 100, the next ones a little less: be quick, not careful.</span></div>
          <div><i>3</i><span>Drawing? Pick a word, then crayon away. You bank 15 for every capy who gets it.</span></div>
          <div><i>4</i><span>${names}</span></div>
        </div>
        <div class="mg-dd-btns"><button class="mg-dd-btn" data-a="go">TO THE EASEL</button></div>
      </div>`);
    this.el.over.querySelector('[data-a="go"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this._closeOver();
    });
    this._after(4200, () => { if (this.phase === 'wait') this._closeOver(); });
  }

  /** Server ids may arrive as an id string or a roster index. Accept both. */
  _idOf(v) {
    const P = this.party;
    if (!P) return null;
    if (typeof v === 'number' && P.players[v]) return P.players[v].id;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v);
      const hit = P.players.find((p) => String(p.id) === s);
      if (hit) return hit.id;
    }
    return null;
  }

  _nameOf(id) {
    const P = this.party;
    const hit = P?.players.find((p) => p.id === id);
    return hit ? hit.name : 'Someone';
  }

  _onState(m) {
    const P = this.party;
    if (!P || this.dead || P.over) return;
    // Two frames share this type. The private near-miss ping is a bare
    // {close:true, round} addressed to one guesser: it carries no phase, no
    // scores and no clock, so it must be answered and returned BEFORE any of
    // the round-state reading below treats its empty fields as a real update.
    if (m.close) {
      this.serverNear = true;
      this._ping('so close!');
      this._feed('<b>you</b> so close!', 'mg-dd-close');
      return;
    }
    const round = num(m.round, m.r);
    const rounds = num(m.rounds, m.of);
    if (round != null) {
      const r = Math.max(1, Math.round(round));
      if (r !== P.round) { P.picked = false; P.word = ''; P.correct.clear(); }
      P.round = r;
    }
    if (rounds != null && rounds > 0) {
      const r = clamp(Math.round(rounds), 1, 12);
      if (r !== P.rounds) {
        P.rounds = r;
        this._buildDots(r);
        this.maxScore = Math.max(120, (r - 1) * 100 + 15 * (P.players.length - 1));
      }
    }
    const drawer = this._idOf(m.drawer ?? m.drawerId ?? m.by);
    if (drawer) P.drawerId = drawer;
    if (Array.isArray(m.scores)) {
      for (const s of m.scores) {
        const id = this._idOf(s?.id ?? s?.i);
        const v = num(s?.score, s?.s, s?.pts);
        if (id && v != null) P.scores.set(id, v);
      }
      this._setScore(P.scores.get(P.meId) || 0);
    }
    const solved = Array.isArray(m.correct) ? m.correct : Array.isArray(m.guessed) ? m.guessed : null;
    if (solved) {
      P.correct = new Set(solved.map((c) => this._idOf(c?.id ?? c)).filter(Boolean));
    }
    // THE word. The server puts it on this frame for the drawer alone (and for
    // everyone at the reveal), and this is the only place a word is ever
    // believed: what the pick card said was a label on a button, not an
    // agreement. Adopting it here is what keeps the drawer's banner, the
    // guessers' mask and every scored guess talking about the same word.
    if (typeof m.word === 'string') {
      const w = normWord(m.word);
      if (w && w !== P.word) {
        P.word = w;
        if (this.phase === 'draw' && this._iAmDrawer()) this._drawerWord();
      }
    }
    // the server clocks its phases in milliseconds ('ms'); everything here is
    // seconds, so that is the one field that needs converting rather than aliasing
    const ms = num(m.ms);
    const left = num(m.left, m.remain, m.secs, m.time) ?? (ms != null ? ms / 1000 : null);
    const dur = num(m.dur, m.duration);
    if (dur != null && dur > 0) this.timeTotal = dur;
    if (left != null) {
      this.timeLeft = Math.max(0, left);
      // anchor, do not accumulate: see _syncClock
      this.endAt = Date.now() + this.timeLeft * 1000;
      if (this.timeLeft > this.timeTotal) this.timeTotal = this.timeLeft;
      this.lastBeep = -1;
      this._paintClock();
    }
    if (typeof m.mask === 'string') { P.mask = m.mask; if (!this._iAmDrawer()) this._setMask(m.mask); }
    if (Array.isArray(m.strokes)) this._loadStrokes(m.strokes);

    // Phase names are the server's to choose; map generously, default to
    // "someone is drawing" because that is the only phase with a live clock.
    const raw = String(m.phase ?? m.st ?? '').toLowerCase();
    let phase = 'draw';
    if (raw.startsWith('pick') || raw.startsWith('choos') || raw.startsWith('word')) phase = 'pick';
    else if (raw.startsWith('reveal') || raw.startsWith('between') || raw.startsWith('score')) phase = 'reveal';
    else if (raw.startsWith('over') || raw.startsWith('done') || raw.startsWith('end')) phase = 'results';

    // one transition per (round, drawer, phase): repeat state ticks are cheap
    const key = `${P.round}:${P.drawerId || '?'}:${phase}`;
    if (key !== P.roundKey) {
      P.roundKey = key;
      if (phase === 'pick') this._enterPick();
      else if (phase === 'draw') this._enterDraw();
      else if (phase === 'reveal') this._enterReveal(typeof m.word === 'string' ? m.word : P.word);
    }
    this._updateRows();
  }

  _enterPick() {
    const P = this.party;
    this.phase = 'pick';
    this.strokes.length = 0;
    this.live = null;
    P.remote = null;
    P.correct.clear();
    this._recommit();
    this._setRound(`ROUND ${P.round}/${P.rounds}`);
    this._setDot(P.round - 1, 'now');
    this._showGuess(false);
    this._showTools(false);
    this._setMask('');
    if (this._iAmDrawer()) {
      this._setRole('YOUR TURN: PICK A WORD');
      this._badge('CHOOSING A WORD');
      // Grace period: if dd-words never lands, offer the three CARDS so the
      // round still happens (documented deviation). Guarded on a card actually
      // being on screen, never on "have they clicked yet": a drawer who spends
      // six seconds deciding must not have the real choices swapped out from
      // under their cursor. That swap was the bug: the click then sent an index
      // into a list the server had never heard of.
      this._after(4000, () => {
        if (this.phase === 'pick' && this._iAmDrawer()
          && !this.party.picked && !this._picksOpen()) {
          this._showMysteryPicks();
        }
      });
    } else {
      this._setRole(`${this._nameOf(P.drawerId).toUpperCase()} IS PICKING A WORD`);
      this._badge('WAITING FOR A WORD');
    }
  }

  _enterDraw() {
    const P = this.party;
    this.phase = 'draw';
    this._closeOver();
    if (P.roundStrokesFresh !== P.round) {
      this.strokes.length = 0;
      this.live = null;
      P.remote = null;
      P.remoteSeq = -1;
      P.roundStrokesFresh = P.round;
      this._recommit();
    }
    this._setRound(`ROUND ${P.round}/${P.rounds}`);
    this._setDot(P.round - 1, 'now');
    this.lastBeep = -1;
    const mine = this._iAmDrawer();
    this._showTools(mine);
    this._showGuess(!mine && !P.correct.has(P.meId), 'Type your guess, hit Enter');
    this.el.paper?.classList.toggle('mg-dd-draw', mine);
    if (mine) {
      this._drawerWord();
      this._badge('EVERYONE IS WATCHING');
      this.game.audio?.play?.('whoosh');
    } else {
      this._setRole(`${this._nameOf(P.drawerId).toUpperCase()} IS DRAWING`);
      this._setMask(P.mask || '');
      this._badge('');
    }
    this._syncClock();
    this._paintClock();
  }

  /**
   * The drawer's banner. Painted from P.word, which only ever comes off a
   * server frame; until that lands there is nothing honest to show, so it says
   * so instead of guessing.
   */
  _drawerWord() {
    const P = this.party;
    if (!P) return;
    if (P.word) {
      this._setMask(P.word, true);
      this._setRole('YOU ARE DRAWING');
    } else {
      this._setMask(P.mask || '');
      this._setRole(P.picked ? 'GETTING YOUR WORD...' : 'YOU ARE DRAWING');
    }
  }

  _enterReveal(word) {
    const P = this.party;
    this.phase = 'reveal';
    this._showGuess(false);
    this._showTools(false);
    this._badge('');
    const w = normWord(word || P.word);
    if (w) {
      P.word = w;
      this._setMask(w, true);
      this._setRole(`THE WORD WAS "${w.toUpperCase()}"`);
    } else {
      this._setRole('ROUND OVER');
    }
    this._setDot(P.round - 1, P.correct.has(P.meId) ? 'hit' : 'miss');
    this.game.audio?.play?.('ding');
  }

  _onWords(m) {
    const P = this.party;
    if (!P || this.dead) return;
    let words = Array.isArray(m?.words) ? m.words : Array.isArray(m?.w) ? m.w : null;
    if (!words) return;
    words = words.map((s) => String(s || '').slice(0, 24)).filter(Boolean).slice(0, 3);
    if (!words.length) return;
    // a words frame for a later round is a fresh pick phase, whatever we did in
    // the last one (the state frame that resets this may still be in flight)
    const round = num(m?.round, m?.r);
    if (round != null && Math.round(round) > P.round) { P.picked = false; P.word = ''; }
    this._showPicks(words);
  }

  /** Is a word-choice card on screen right now? */
  _picksOpen() {
    return !!(this.el.over?.classList.contains('mg-dd-on')
      && this.el.over.querySelector('.mg-dd-pick'));
  }

  /**
   * The server's three words, in the server's order. The index that goes back
   * on dd-pick is an index into THIS array, so it is never reordered, filtered
   * or replaced with anything of our own invention.
   */
  _showPicks(words) {
    const P = this.party;
    if (!P || P.picked) return;
    this.game.audio?.play?.('open');
    this._over(`
      <div class="mg-dd-card">
        <h2>Your turn to draw</h2>
        <div class="mg-dd-sub">PICK A WORD. THE OTHERS ONLY SEE BLANKS.</div>
        <div class="mg-dd-picks">
          ${words.map((w, i) => `<button class="mg-dd-pick" data-i="${i}">${esc(w)}</button>`).join('')}
        </div>
        <div class="mg-dd-sub" style="margin:10px 0 0">CRAYONS ON KEYS 1-8 &middot; Z UNDOES</div>
      </div>`);
    this.el.over.querySelectorAll('.mg-dd-pick').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.i);
        const word = words[i];
        if (!word) return;
        this._sendPick(i, word);
      });
    });
  }

  /**
   * 'dd-words' never landed (lost frame, or we mounted after it). The three
   * choices still exist on the server, so offer the CARDS rather than invent
   * words: pick one and the easel fills in what the server was holding. Showing
   * a made-up word here is what made a drawer draw 'sandcastle' while everyone
   * else was being scored against something else entirely.
   */
  _showMysteryPicks() {
    const P = this.party;
    if (!P || P.picked) return;
    this.game.audio?.play?.('open');
    this._over(`
      <div class="mg-dd-card">
        <h2>Your turn to draw</h2>
        <div class="mg-dd-sub">THE WORD CARDS BLEW INTO THE FERNS. PICK ONE ANYWAY.</div>
        <div class="mg-dd-picks">
          ${[0, 1, 2].map((i) => `<button class="mg-dd-pick" data-i="${i}">CARD ${i + 1}</button>`).join('')}
        </div>
        <div class="mg-dd-sub" style="margin:10px 0 0">THE EASEL WILL TELL YOU WHAT IT SAYS</div>
      </div>`);
    this.el.over.querySelectorAll('.mg-dd-pick').forEach((b) => {
      b.addEventListener('click', () => this._sendPick(Number(b.dataset.i), ''));
    });
  }

  /**
   * Commit to a choice. The word on the button is NOT painted on the banner:
   * the server resolves the index against its own three choices and answers
   * with the word the round actually has, and that answer (dd-state, drawer
   * only) is the one thing this screen will show. One RTT of "getting your
   * word..." is worth never drawing a word nobody is being scored against.
   */
  _sendPick(i, word) {
    const P = this.party;
    if (!P || P.picked) return;
    P.picked = true;
    P.word = '';
    // only the drawer is ever offered words: trust that over a drawer id the
    // state frame may have labelled differently
    P.drawerId = P.meId;
    this.game.audio?.play?.('click');
    this.game.net?.send?.(word ? { t: 'dd-pick', i, word } : { t: 'dd-pick', i });
    this._closeOver();
    this._showTools(true);
    this.el.paper?.classList.add('mg-dd-draw');
    this._drawerWord();
    this._badge('CRAYONS UP');
  }

  _onMask(m) {
    const P = this.party;
    if (!P || this.dead) return;
    const mask = typeof m?.mask === 'string' ? m.mask : typeof m?.m === 'string' ? m.m : null;
    const word = typeof m?.word === 'string' ? m.word : null;
    if (word) {
      P.word = normWord(word);
      this._setMask(P.word, true);
      return;
    }
    if (mask == null) return;
    const before = P.mask;
    P.mask = mask;
    if (!this._iAmDrawer()) {
      this._setMask(mask);
      if (before && before !== mask) this.game.audio?.play?.('ding');
    }
  }

  /** Relayed stroke data from the drawer (or a state resync). */
  _onStroke(m) {
    const P = this.party;
    if (!P || this.dead || this._iAmDrawer()) return;
    const op = String(m?.op || '');
    if (op === 'clear') {
      this.strokes.length = 0;
      P.remote = null;
      this._recommit();
      this.game.audio?.play?.('whoosh');
      return;
    }
    if (op === 'undo') {
      if (P.remote) P.remote = null;
      else this.strokes.pop();
      this.live = null;
      this._recommit();
      return;
    }
    const pts = Array.isArray(m?.pts) ? m.pts : Array.isArray(m?.p) ? m.p : null;
    const seq = num(m?.s, m?.seq);
    const c = clamp(Math.round(num(m?.c) ?? 0), 0, PALETTE.length - 1);
    const w = clamp(Math.round(num(m?.w) ?? 1), 0, WIDTHS.length - 1);
    const fresh = seq == null || seq !== P.remoteSeq;
    if (fresh) {
      if (P.remote) this._commit(P.remote);
      P.remote = { c, w, p: [] };
      P.remoteSeq = seq == null ? P.remoteSeq : seq;
    }
    if (!P.remote) P.remote = { c, w, p: [] };
    if (pts) {
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const x = Number(pts[i]);
        const y = Number(pts[i + 1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (P.remote.p.length >= MAX_PTS) break;
        P.remote.p.push(clamp(x, -20, W + 20), clamp(y, -20, H + 20));
      }
    }
    this.live = P.remote.p.length >= 2 ? P.remote : null;
    if (m?.e) {
      if (P.remote.p.length >= 2) this._commit(P.remote);
      P.remote = null;
      this.live = null;
    }
    this.dirty = true;
  }

  /** Full-board resync (late join / phase change): [{c,w,p:[...]}, ...]. */
  _loadStrokes(list) {
    this.strokes.length = 0;
    for (const s of list.slice(0, MAX_STROKES)) {
      const pts = Array.isArray(s?.p) ? s.p : Array.isArray(s?.pts) ? s.pts : null;
      if (!pts || pts.length < 2) continue;
      const p = [];
      for (let i = 0; i + 1 < pts.length && p.length < MAX_PTS; i += 2) {
        const x = Number(pts[i]);
        const y = Number(pts[i + 1]);
        if (Number.isFinite(x) && Number.isFinite(y)) p.push(x, y);
      }
      if (p.length >= 2) {
        this.strokes.push({
          c: clamp(Math.round(num(s?.c) ?? 0), 0, PALETTE.length - 1),
          w: clamp(Math.round(num(s?.w) ?? 1), 0, WIDTHS.length - 1),
          p,
        });
      }
    }
    this.live = null;
    this._recommit();
  }

  _onCorrect(m) {
    const P = this.party;
    if (!P || this.dead) return;
    const id = this._idOf(m?.id ?? m?.who);
    const name = String(m?.name || (id ? this._nameOf(id) : 'Someone')).slice(0, 16);
    const pts = num(m?.pts, m?.points, m?.p, m?.gain) ?? 0;
    // near-miss ping for us, straight from the server's Levenshtein check
    if (m?.near || m?.close) {
      this.serverNear = true;
      if (!id || id === P.meId) {
        this._ping('so close!');
        this._feed(`<b>you</b> so close!`, 'mg-dd-close');
      }
      return;
    }
    // the server hands the answer to the capy who just earned it, and nobody
    // else: another server-sourced word, so it is safe to keep
    if (typeof m?.word === 'string') {
      const w = normWord(m.word);
      if (w) P.word = w;
    }
    if (id) {
      P.correct.add(id);
      P.scores.set(id, (P.scores.get(id) || 0) + pts);
    }
    const drawerPts = num(m?.drawerPts, m?.dpts, m?.drawerPoints);
    if (drawerPts != null && P.drawerId) {
      P.scores.set(P.drawerId, (P.scores.get(P.drawerId) || 0) + drawerPts);
    }
    if (id && id === P.meId) {
      this._setScore(P.scores.get(P.meId) || 0);
      this._burst(W / 2, H / 2, 30);
      this._pop(`+${Math.round(pts)}`, W / 2, H * 0.42);
      this.game.audio?.play?.('success');
      this.game.audio?.play?.('sparkle');
      this._showGuess(false);
      this._setRole('GOT IT! SIT TIGHT.');
      this._feed(`<b>you</b> got it &middot; +${Math.round(pts)}`, 'mg-dd-good');
    } else {
      if (this._iAmDrawer()) {
        this._setScore(P.scores.get(P.meId) || 0);
        this._pop(`+${Math.round(drawerPts ?? 15)}`, W * 0.5, H * 0.7, '#c98e26');
      }
      this.game.audio?.play?.('ding');
      this._feed(`<b>${esc(name)}</b> guessed it!`, 'mg-dd-good');
    }
    this._updateRows();
  }

  _onEnd(m) {
    const P = this.party;
    if (!P || this.dead || P.over) return;
    P.over = true;
    this.phase = 'results';
    this._showGuess(false);
    this._showTools(false);
    this._badge('');
    // the server's own bookkeeping wins over our running tally: it refereed
    // every guess, and its `scores` is the list the podium coins were paid from
    const raw = Array.isArray(m?.standings) ? m.standings
      : Array.isArray(m?.scores) ? m.scores
        : Array.isArray(m) ? m : [];
    let list = raw
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({
        id: this._idOf(s.id) ?? String(s.id ?? ''),
        name: String(s.name || (this._idOf(s.id) ? this._nameOf(this._idOf(s.id)) : 'Capy')).slice(0, 16),
        score: Math.max(0, Math.round(num(s.score, s.pts, s.s) ?? 0)),
        color: 0xb08a5a,
      }));
    if (!list.length) {
      list = P.players.map((p) => ({
        id: p.id, name: p.name, score: Math.round(P.scores.get(p.id) || 0), color: p.color,
      }));
    }
    for (const row of list) {
      const p = P.players.find((q) => q.id === row.id);
      if (p) row.color = p.color;
    }
    list.sort((a, b) => b.score - a.score);
    const meIdx = list.findIndex((r) => r.id === P.meId);
    const me = meIdx >= 0 ? list[meIdx] : null;
    const myScore = me ? me.score : Math.round(P.scores.get(P.meId) || 0);
    const place = meIdx >= 0 ? meIdx + 1 : list.length;
    const prev = this.game.state?.bests?.doodle || 0;
    const isBest = myScore > prev;
    const coins = this.coinsForScore(myScore);
    this._setScore(myScore); // the HUD chip and the podium must agree
    this.finish(myScore);
    this.game.audio?.play?.(place === 1 ? 'levelup' : 'ding');
    if (place === 1) this._burst(W / 2, H * 0.4, 46);

    const podOrder = [1, 0, 2];
    const podium = podOrder.map((i) => {
      const r = list[i];
      if (!r) return '';
      return `<div class="mg-dd-pod mg-dd-p${i + 1}" data-av="${i}">
          <span>${esc(r.name)}</span><u>${r.score}</u>
          <div class="mg-dd-plinth">${i + 1}</div>
        </div>`;
    }).join('');
    const rest = list.slice(3).map((r, i) => `
      <div class="mg-dd-li${r.id === P.meId ? ' mg-dd-me' : ''}">
        <span>${i + 4}. ${esc(r.name)}</span><b>${r.score}</b>
      </div>`).join('');
    this._over(`
      <div class="mg-dd-card">
        ${isBest ? '<div class="mg-dd-ribbon">NEW SKETCHBOOK RECORD</div>' : ''}
        <h2>${place === 1 ? 'You win the crayon crown!' : 'Doodles done'}</h2>
        <div class="mg-dd-sub">${place === 1 ? 'THE JUNGLE BOWS TO YOUR EYES' : `YOU FINISHED ${place}${place === 2 ? 'ND' : place === 3 ? 'RD' : 'TH'}`}</div>
        <div class="mg-dd-podium">${podium}</div>
        ${rest ? `<div class="mg-dd-list">${rest}</div>` : ''}
        <div class="mg-dd-stats">
          <div class="mg-dd-stat"><b>${myScore}</b><span>SCORE</span></div>
          <div class="mg-dd-stat mg-dd-gold"><b>${coins}</b><span>COINS</span></div>
          <div class="mg-dd-stat"><b>${Math.max(prev, myScore)}</b><span>BEST</span></div>
        </div>
        <div class="mg-dd-btns">
          <button class="mg-dd-btn" data-a="solo">Doodle solo</button>
          <button class="mg-dd-btn mg-dd-alt" data-a="leave">Back to the jungle</button>
        </div>
      </div>`);
    this.el.over.querySelectorAll('[data-av]').forEach((el) => {
      const r = list[Number(el.dataset.av)];
      if (r) el.prepend(capyCanvas(46, hexOf(r.color)));
    });
    this.el.over.querySelector('[data-a="solo"]').addEventListener('click', () => {
      this._done = false;
      this._leaveParty();
      this._countdown();
    });
    this.el.over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  /** Drop party wiring and fall back to the solo sketchbook. */
  _leaveParty() {
    for (const off of this.subs) { try { off(); } catch { /* already gone */ } }
    this.subs.length = 0;
    this.party = null;
    this.mode = 'solo';
    this.endAt = 0; // the solo clock counts itself down
    if (this.ctxRef && this.game.__partyCtx === this.ctxRef) this.game.__partyCtx = null;
    this.ctxRef = null;
  }

  // -------------------------------------------------------------- guessing -
  _submitGuess() {
    const input = this.el.input;
    if (!input || input.disabled) return;
    const raw = input.value.trim().slice(0, 26);
    input.value = '';
    input.focus();
    if (!raw) return;
    if (this.mode === 'solo') { this._soloGuess(raw); return; }

    const P = this.party;
    if (!P || this.phase !== 'draw' || this._iAmDrawer() || P.correct.has(P.meId)) return;
    this.game.net?.send?.({ t: 'dd-guess', text: raw });
    this._feed(`<b>you</b> ${esc(raw)}`);
    this.game.audio?.play?.('pop');
    // Local near-miss fallback while the server has never sent one: same length
    // as the mask and every revealed letter lines up. We never learn the word,
    // so this is as close to Levenshtein 1 as a guesser's client can honestly get.
    if (!this.serverNear && P.mask) this._maybeLocalNear(raw, P.mask);
  }

  _maybeLocalNear(raw, mask) {
    const g = normWord(raw);
    const m = normMask(mask);
    if (!g || g.length !== m.length) return;
    let shown = 0;
    for (let i = 0; i < m.length; i++) {
      const c = m[i];
      if (c === '_') continue;
      if (c === ' ') { if (g[i] !== ' ') return; continue; }
      shown++;
      if (g[i] !== c.toLowerCase()) return;
    }
    if (shown < 1) return;
    this._ping('so close!');
  }
}
