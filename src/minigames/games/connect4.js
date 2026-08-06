import { Minigame } from '../minigame.js';
import { clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Four in a Row : the Game Den's disc-dropping duel against Dizzy, an
 * easily-excited capybara who narrates his own thinking.
 *
 * Pure DOM + 2D canvas (no WebGL). The board, discs and confetti live on one
 * canvas; portraits are canvases drawn in the smoothie-customer art language;
 * everything else is CSS art.
 *
 * Scoring (must stay in step with coinsForScore, which only sees the score):
 *   win   -> 300 + 10 * empty cells left   (300..650)
 *   draw  -> 120 exactly
 *   loss  -> 20 + empty cells left         (20..55)
 */

// ---------------------------------------------------------------------------
// palette + tiny helpers
// ---------------------------------------------------------------------------
const OUTLINE = '#3a2a1c';
const YOU_C1 = '#f5869a';
const YOU_C2 = '#c93d5c';
const DIZ_C1 = '#ffd06a';
const DIZ_C2 = '#d98d1c';

function hexOf(n) { return `#${((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`; }
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
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function grad(ctx, x0, y0, x1, y1, a, b) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, a); g.addColorStop(1, b);
  return g;
}
function ink(ctx, w = 4.5) {
  ctx.lineWidth = w; ctx.strokeStyle = OUTLINE; ctx.stroke();
}
function dpr() {
  return Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
}

// ---------------------------------------------------------------------------
// capybara portraits (designed on a 200x200 grid, same language as the
// Smoothie Shack customers: rounded head, bead eyes, boxy muzzle, blush)
// ---------------------------------------------------------------------------
function drawHat(ctx, hat, color) {
  if (!hat || hat === 'none') return;
  ctx.lineJoin = 'round';
  if (hat === 'beanie') {
    ctx.beginPath(); ctx.arc(100, 40, 56, Math.PI, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); rrect(ctx, 42, 30, 116, 22, 10);
    ctx.fillStyle = shade(color, 0.28); ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.arc(100, -18, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#fff6e3'; ctx.fill(); ink(ctx, 5);
  } else if (hat === 'cap') {
    ctx.beginPath(); ctx.arc(100, 40, 54, Math.PI * 1.02, Math.PI * 1.98);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(150, 40, 46, 13, -0.06, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = shade(color, -0.2); ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.arc(100, -14, 7, 0, Math.PI * 2);
    ctx.fillStyle = shade(color, 0.35); ctx.fill(); ink(ctx, 4);
  } else if (hat === 'capback') {
    // the same cap worn backwards: Dizzy's look
    ctx.beginPath(); ctx.arc(100, 40, 54, Math.PI * 1.02, Math.PI * 1.98);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(50, 40, 42, 12, 0.06, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = shade(color, -0.2); ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); rrect(ctx, 86, 30, 28, 14, 5);
    ctx.fillStyle = shade(color, -0.32); ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.arc(100, -14, 7, 0, Math.PI * 2);
    ctx.fillStyle = shade(color, 0.35); ctx.fill(); ink(ctx, 4);
  } else if (hat === 'flower') {
    const cx = 152, cy = 24;
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * 15, cy + Math.sin(a) * 15, 12, 12, 0, 0, Math.PI * 2);
      ctx.fill(); ink(ctx, 4);
    }
    ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#f7d94c'; ctx.fill(); ink(ctx, 4);
  } else if (hat === 'toque') {
    ctx.beginPath(); rrect(ctx, 56, 22, 88, 22, 8);
    ctx.fillStyle = '#f6efe0'; ctx.fill(); ink(ctx, 5);
    ctx.beginPath();
    ctx.arc(72, 6, 22, 0, Math.PI * 2);
    ctx.arc(100, -6, 26, 0, Math.PI * 2);
    ctx.arc(128, 6, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#fffaf0'; ctx.fill(); ink(ctx, 5);
  } else if (hat === 'tophat') {
    ctx.beginPath(); rrect(ctx, 44, 30, 112, 16, 8);
    ctx.fillStyle = shade(color, -0.1); ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); rrect(ctx, 62, -30, 76, 62, 10);
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); rrect(ctx, 62, 12, 76, 14, 4);
    ctx.fillStyle = '#e8657a'; ctx.fill();
  } else if (hat === 'crown') {
    ctx.beginPath();
    ctx.moveTo(52, 40); ctx.lineTo(60, -6); ctx.lineTo(78, 18); ctx.lineTo(100, -14);
    ctx.lineTo(122, 18); ctx.lineTo(140, -6); ctx.lineTo(148, 40);
    ctx.closePath();
    ctx.fillStyle = grad(ctx, 52, -14, 148, 40, '#ffdc82', '#e0982a'); ctx.fill(); ink(ctx, 5);
    ctx.fillStyle = '#e8657a';
    for (const gx of [72, 100, 128]) {
      ctx.beginPath(); ctx.arc(gx, 28, 6, 0, Math.PI * 2); ctx.fill(); ink(ctx, 3);
    }
  } else if (hat === 'visor') {
    ctx.beginPath(); ctx.arc(100, 46, 50, Math.PI * 1.12, Math.PI * 1.88);
    ctx.lineWidth = 16; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(100, 32, 62, 16, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = shade(color, 0.3); ctx.fill(); ink(ctx, 5);
  }
}

/** expr: idle | thinking | smug | worried | beaten | cheer | blink */
function drawCapy(ctx, size, cfg, expr, t = 0) {
  const s = size / 200;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const body = cfg.color;
  const dark = shade(body, -0.24);
  const muzzle = shade(body, 0.22);
  const droop = expr === 'beaten' ? 1 : 0;

  // shoulders
  ctx.beginPath(); rrect(ctx, 50, 148, 100, 62, 30);
  ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);

  // ears (they droop when Dizzy is beaten, perk up when he cheers)
  const perk = expr === 'cheer' ? -8 : droop * 12;
  for (const ex of [46, 154]) {
    ctx.save();
    ctx.translate(ex, 48 + perk);
    ctx.rotate((ex < 100 ? 0.3 : -0.3) + (ex < 100 ? droop * 0.5 : -droop * 0.5));
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 17, 0, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(0, 2, 9, 7, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a3a8'; ctx.fill();
    ctx.restore();
  }

  // head
  ctx.beginPath(); rrect(ctx, 38, 36, 124, 104, 42);
  ctx.fillStyle = grad(ctx, 38, 36, 162, 140, shade(body, 0.1), body);
  ctx.fill(); ink(ctx, 5.5);

  // muzzle
  ctx.beginPath(); rrect(ctx, 58, 96, 84, 58, 26);
  ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4.5);

  // nostrils
  ctx.fillStyle = OUTLINE;
  for (const nx of [86, 114]) {
    ctx.save(); ctx.translate(nx, 116); ctx.rotate(nx < 100 ? 0.5 : -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // mouth
  ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
  if (expr === 'cheer') {
    ctx.beginPath();
    ctx.moveTo(80, 128); ctx.quadraticCurveTo(100, 152, 120, 128); ctx.closePath();
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.ellipse(100, 141, 9, 5, 0, 0, Math.PI); ctx.fillStyle = '#f08fa0'; ctx.fill();
  } else if (expr === 'beaten') {
    ctx.beginPath(); ctx.ellipse(100, 136, 15, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
  } else if (expr === 'smug') {
    ctx.beginPath();
    ctx.moveTo(84, 134); ctx.quadraticCurveTo(98, 142, 118, 126); ctx.stroke();
  } else if (expr === 'thinking') {
    ctx.beginPath();
    ctx.moveTo(86, 134); ctx.quadraticCurveTo(100, 130, 114, 134); ctx.stroke();
  } else if (expr === 'worried') {
    ctx.beginPath();
    ctx.moveTo(86, 132); ctx.quadraticCurveTo(93, 138, 100, 132);
    ctx.quadraticCurveTo(107, 126, 114, 132); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(88, 130); ctx.quadraticCurveTo(100, 140, 112, 130); ctx.stroke();
  }

  // eyes
  const eyes = [70, 130];
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i];
    ctx.lineWidth = 5; ctx.strokeStyle = OUTLINE;
    if (expr === 'beaten') {
      // the trademark dizzy spiral
      ctx.beginPath();
      for (let k = 0; k <= 46; k++) {
        const a = (k / 46) * Math.PI * 3.4 + t * 2.4 * (i ? -1 : 1);
        const rr = 1.5 + (k / 46) * 11;
        const px = ex + Math.cos(a) * rr, py = 76 + Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.lineWidth = 4; ctx.stroke();
    } else if (expr === 'cheer' || expr === 'blink') {
      ctx.beginPath();
      ctx.moveTo(ex - 11, 78);
      ctx.quadraticCurveTo(ex, expr === 'cheer' ? 62 : 88, ex + 11, 78);
      ctx.stroke();
    } else if (expr === 'smug') {
      ctx.beginPath();
      ctx.moveTo(ex - 12, 74); ctx.lineTo(ex + 12, 74);
      ctx.stroke();
      ctx.beginPath(); ctx.ellipse(ex, 80, 8, 6, 0, Math.PI, Math.PI * 2, true);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(ex + (i ? 13 : -13), 60); ctx.lineTo(ex + (i ? -5 : 5), 56);
      ctx.stroke();
    } else {
      const r = expr === 'worried' ? 8 : expr === 'thinking' ? 9 : 10;
      const gaze = expr === 'thinking' ? 3.5 : 0;
      ctx.beginPath(); ctx.ellipse(ex, 76 - gaze, r, r + 1.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.beginPath(); ctx.arc(ex - 3.4 + gaze, 72 - gaze, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      if (expr === 'worried') {
        ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
        ctx.beginPath();
        ctx.moveTo(ex + (i ? 12 : -12), 60); ctx.lineTo(ex + (i ? -5 : 5), 56);
        ctx.stroke();
      } else if (expr === 'thinking') {
        ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
        ctx.beginPath();
        ctx.moveTo(ex - 12, 58); ctx.lineTo(ex + 12, 54);
        ctx.stroke();
      }
    }
  }

  // blush
  if (expr === 'cheer' || expr === 'idle' || expr === 'smug') {
    ctx.fillStyle = 'rgba(232,101,122,0.32)';
    ctx.beginPath(); ctx.ellipse(52, 104, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(148, 104, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  // sweat bead when it is going badly
  if (expr === 'worried' || expr === 'beaten') {
    ctx.beginPath();
    ctx.moveTo(168, 58 + Math.sin(t * 3) * 3); ctx.quadraticCurveTo(178, 72, 168, 78);
    ctx.quadraticCurveTo(158, 72, 168, 58 + Math.sin(t * 3) * 3); ctx.closePath();
    ctx.fillStyle = '#9ed9f2'; ctx.fill(); ink(ctx, 3.5);
  }

  // paws on the table
  for (const px of [46, 122]) {
    ctx.beginPath(); rrect(ctx, px, 168, 34, 24, 12);
    ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4.5);
    ctx.lineWidth = 3; ctx.strokeStyle = shade(body, -0.35);
    for (let k = 1; k < 3; k++) {
      ctx.beginPath(); ctx.moveTo(px + k * 11, 172); ctx.lineTo(px + k * 11, 182); ctx.stroke();
    }
  }

  drawHat(ctx, cfg.hat, cfg.hatColor);
  ctx.restore();
}

function paintCapy(canvas, cssSize, cfg, expr, t) {
  const d = dpr();
  const px = Math.round(cssSize * d);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  drawCapy(ctx, cssSize, cfg, expr, t);
}

// world hat ids -> the portrait hats this file can draw
const HAT_MAP = {
  beanie: ['beanie', '#e8657a'],
  cap: ['cap', '#4fb3e8'],
  flower: ['flower', '#e8657a'],
  chef: ['toque', '#fff6e3'],
  tophat: ['tophat', '#3b3350'],
  crown: ['crown', '#f2b64a'],
};

// ---------------------------------------------------------------------------
// board rules + the Dizzy brain
// ---------------------------------------------------------------------------
const COLS = 7;
const ROWS = 6;
const CELLS = COLS * ROWS;
const YOU = 1;
const DIZ = 2;
const WIN_V = 1_000_000;
// depth 5: beatable by a careful casual player. 7 was measured near-unbeatable
// and the den pays only on wins, so hard-capped fun beats hard-capped coins.
const AI_DEPTH = 5;
const AI_BUDGET_MS = 240; // iterative deepening bails out rather than hitching

// every 4-in-a-line window on the board, precomputed once (69 of them)
const WINDOWS = (() => {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 3 < COLS) out.push([r * COLS + c, r * COLS + c + 1, r * COLS + c + 2, r * COLS + c + 3]);
      if (r + 3 < ROWS) out.push([r * COLS + c, (r + 1) * COLS + c, (r + 2) * COLS + c, (r + 3) * COLS + c]);
      if (r + 3 < ROWS && c + 3 < COLS) {
        out.push([r * COLS + c, (r + 1) * COLS + c + 1, (r + 2) * COLS + c + 2, (r + 3) * COLS + c + 3]);
      }
      if (r + 3 < ROWS && c - 3 >= 0) {
        out.push([r * COLS + c, (r + 1) * COLS + c - 1, (r + 2) * COLS + c - 2, (r + 3) * COLS + c - 3]);
      }
    }
  }
  return out.map((w) => Int8Array.from(w));
})();

const DR = [0, 1, 1, 1];
const DC = [1, 0, 1, -1];

/** Does the disc at (r,c) complete a line for player p? */
function isWinAt(board, r, c, p) {
  for (let d = 0; d < 4; d++) {
    let n = 1;
    for (let s = -1; s <= 1; s += 2) {
      let rr = r + DR[d] * s, cc = c + DC[d] * s;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr * COLS + cc] === p) {
        n++; rr += DR[d] * s; cc += DC[d] * s;
      }
    }
    if (n >= 4) return true;
  }
  return false;
}

/**
 * The cells of the line through (r,c), for the win strobe. Sorted by index,
 * which for all four directions puts the two ends of the line first and last
 * (the strobe draws its beam between them; unsorted, the beam started at the
 * disc that was just dropped and covered only half the line).
 */
function winCellsAt(board, r, c, p) {
  for (let d = 0; d < 4; d++) {
    const cells = [r * COLS + c];
    for (let s = -1; s <= 1; s += 2) {
      let rr = r + DR[d] * s, cc = c + DC[d] * s;
      while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr * COLS + cc] === p) {
        cells.push(rr * COLS + cc); rr += DR[d] * s; cc += DC[d] * s;
      }
    }
    if (cells.length >= 4) return cells.sort((a, b) => a - b);
  }
  return [];
}

/** Static evaluation from `me`'s point of view, centre-weighted. */
function evalBoard(board, me, opp) {
  let s = 0;
  for (let r = 0; r < ROWS; r++) {
    const base = r * COLS;
    const mid = board[base + 3];
    if (mid === me) s += 7; else if (mid === opp) s -= 7;
    const l = board[base + 2], rt = board[base + 4];
    if (l === me) s += 3; else if (l === opp) s -= 3;
    if (rt === me) s += 3; else if (rt === opp) s -= 3;
  }
  for (let i = 0; i < WINDOWS.length; i++) {
    const w = WINDOWS[i];
    let m = 0, o = 0;
    for (let k = 0; k < 4; k++) {
      const v = board[w[k]];
      if (v === me) m++; else if (v === opp) o++;
    }
    if (m && o) continue;
    if (m === 3) s += 60;
    else if (m === 2) s += 12;
    else if (m === 1) s += 2;
    else if (o === 3) s -= 66; // blocking is worth a hair more than building
    else if (o === 2) s -= 14;
    else if (o === 1) s -= 2;
  }
  return s;
}

/**
 * Negamax with alpha-beta. `player` is to move; the score returned is from
 * `player`'s point of view. Wins are scaled by depth so Dizzy takes the fast
 * win and the slow loss.
 */
function negamax(board, heights, filled, depth, alpha, beta, player, other) {
  if (filled === CELLS) return 0;
  if (depth === 0) return evalBoard(board, player, other);
  let best = -Infinity;
  for (let i = 0; i < COLS; i++) {
    const c = SEARCH_ORDER[i];
    if (heights[c] >= ROWS) continue;
    const r = ROWS - 1 - heights[c];
    const idx = r * COLS + c;
    board[idx] = player; heights[c]++;
    let v;
    if (isWinAt(board, r, c, player)) v = WIN_V + depth;
    else v = -negamax(board, heights, filled + 1, depth - 1, -beta, -alpha, other, player);
    board[idx] = 0; heights[c]--;
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? 0 : best;
}

// centre-first move ordering; shuffled inside each ring so equal moves vary
const SEARCH_ORDER = [3, 2, 4, 1, 5, 0, 6];
function shuffleOrder() {
  const rings = [[3], [2, 4], [1, 5], [0, 6]];
  let i = 0;
  for (const ring of rings) {
    if (ring.length === 2 && Math.random() < 0.5) ring.reverse();
    for (const c of ring) SEARCH_ORDER[i++] = c;
  }
}

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------
const STYLE = `
.mg-c4-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#2d2417;user-select:none;
  -webkit-user-select:none;cursor:default;}
.mg-c4-root *{box-sizing:border-box;}

/* ---- den backdrop ---- */
.mg-c4-bg{position:absolute;inset:0;
  background:
    radial-gradient(ellipse 60% 44% at 50% 6%, rgba(255,214,140,.5), rgba(255,214,140,0) 70%),
    repeating-linear-gradient(90deg, rgba(45,26,10,.14) 0 3px, rgba(0,0,0,0) 3px 116px),
    linear-gradient(180deg,#7d5c3c 0%,#63472e 46%,#4a3324 100%);}
.mg-c4-bg::after{content:"";position:absolute;inset:0;
  background:radial-gradient(ellipse 88% 78% at 50% 46%, rgba(0,0,0,0) 52%, rgba(28,14,4,.5) 100%);}
.mg-c4-lamp{position:absolute;top:-58px;left:50%;width:120px;height:100px;margin-left:-60px;
  border-radius:0 0 60px 60px;background:linear-gradient(180deg,#3f5c4a,#2f4638);
  box-shadow:0 20px 60px rgba(255,214,140,.35);}
.mg-c4-lamp::after{content:"";position:absolute;left:50%;bottom:-7px;width:34px;height:14px;
  margin-left:-17px;border-radius:50%;background:#ffe6ad;filter:blur(2px);}
.mg-c4-trophy{position:absolute;top:64px;width:74px;height:96px;opacity:.85;}
.mg-c4-trophy i{position:absolute;left:50%;top:0;width:52px;height:40px;margin-left:-26px;
  border-radius:0 0 26px 26px;background:linear-gradient(180deg,#ffdc82,#d9992a);
  border:4px solid #3a2a1c;border-top-width:5px;}
.mg-c4-trophy b{position:absolute;left:50%;top:44px;width:12px;height:22px;margin-left:-6px;
  background:#d9992a;border:4px solid #3a2a1c;border-top:0;border-bottom:0;}
.mg-c4-trophy s{position:absolute;left:50%;top:66px;width:44px;height:16px;margin-left:-22px;
  border-radius:5px;background:#8a6642;border:4px solid #3a2a1c;}
.mg-c4-shelf{position:absolute;top:158px;height:12px;border-radius:5px;
  background:linear-gradient(180deg,#c98f52,#8a5a2c);box-shadow:0 6px 12px rgba(30,16,4,.4);}

/* ---- hud ---- */
.mg-c4-hud{position:relative;z-index:6;display:flex;align-items:center;gap:9px;
  padding:11px 14px;flex-wrap:wrap;}
.mg-c4-chip{background:#fffdf6;border-radius:999px;padding:6px 15px;font-weight:900;font-size:14px;
  box-shadow:0 5px 0 rgba(50,28,10,.32),0 8px 16px rgba(24,12,2,.25);display:flex;align-items:center;gap:8px;}
.mg-c4-chip small{font-size:10.5px;letter-spacing:.13em;opacity:.5;font-weight:900;}
.mg-c4-chip b{font-size:17px;}
.mg-c4-turn b{color:#c93d5c;}
.mg-c4-turn.mg-c4-them b{color:#c8871a;}
.mg-c4-turn.mg-c4-bump{animation:mg-c4-bump .34s ease;}
@keyframes mg-c4-bump{50%{transform:scale(1.14) rotate(-2deg)}}
.mg-c4-tally span{display:flex;align-items:center;gap:5px;}
.mg-c4-tally i{display:inline-block;width:13px;height:13px;border-radius:50%;
  border:2px solid rgba(58,42,28,.55);}
.mg-c4-tally i.mg-c4-you{background:#f5869a;}
.mg-c4-tally i.mg-c4-diz{background:#ffd06a;}
.mg-c4-reward b{color:#e0982a;}
.mg-c4-spacer{flex:1;}
.mg-c4-quit{border:0;background:rgba(40,24,12,.72);color:#fff6e3;font-family:inherit;font-weight:900;
  font-size:12.5px;letter-spacing:.1em;padding:9px 18px;border-radius:999px;cursor:pointer;transition:.14s;}
.mg-c4-quit:hover{background:#c94a3e;transform:scale(1.06);}

/* ---- stage ---- */
.mg-c4-stage{position:relative;z-index:4;flex:1;min-height:0;display:flex;align-items:center;
  justify-content:center;gap:clamp(4px,1.4vw,26px);padding:0 clamp(6px,1.5vw,22px) clamp(8px,2vh,20px);}
.mg-c4-side{width:clamp(120px,15vw,208px);display:flex;flex-direction:column;align-items:center;
  gap:6px;transition:.25s;opacity:.62;}
.mg-c4-side.mg-c4-active{opacity:1;transform:translateY(-4px);}
.mg-c4-portrait{display:block;animation:mg-c4-idle 2.7s ease-in-out infinite;}
.mg-c4-side.mg-c4-active .mg-c4-portrait{animation-duration:1.5s;}
@keyframes mg-c4-idle{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-6px) rotate(1.2deg)}}
.mg-c4-nametag{background:#fffdf6;border-radius:999px;padding:3px 15px;font-size:12.5px;font-weight:900;
  letter-spacing:.04em;box-shadow:0 4px 10px rgba(24,12,2,.34);margin-top:-10px;
  display:flex;align-items:center;gap:7px;}
.mg-c4-nametag u{width:13px;height:13px;border-radius:50%;border:2px solid rgba(58,42,28,.5);}
.mg-c4-bubble{position:relative;background:#fffdf6;border-radius:18px;padding:9px 13px;min-height:44px;
  display:flex;align-items:center;text-align:center;font-size:12.5px;font-weight:800;line-height:1.35;
  box-shadow:0 8px 18px rgba(24,12,2,.32);margin-bottom:10px;}
.mg-c4-bubble::after{content:"";position:absolute;bottom:-12px;left:50%;margin-left:-10px;
  border:10px solid transparent;border-top-color:#fffdf6;border-bottom:0;}
.mg-c4-bubble.mg-c4-pop{animation:mg-c4-bpop .34s cubic-bezier(.2,1.6,.4,1);}
@keyframes mg-c4-bpop{from{transform:scale(.4);opacity:0}}
.mg-c4-side.mg-c4-you-side .mg-c4-bubble{background:#ffeed2;}
.mg-c4-side.mg-c4-you-side .mg-c4-bubble::after{border-top-color:#ffeed2;}

.mg-c4-boardwrap{position:relative;flex:1;min-width:0;height:100%;display:flex;
  flex-direction:column;align-items:center;justify-content:center;}
.mg-c4-board{display:block;touch-action:manipulation;cursor:pointer;
  filter:drop-shadow(0 16px 22px rgba(20,10,2,.45));}
.mg-c4-board.mg-c4-locked{cursor:default;}
.mg-c4-stand{height:clamp(10px,1.6vh,18px);border-radius:0 0 9px 9px;
  background:linear-gradient(180deg,#a06a35,#6b4423);box-shadow:0 8px 16px rgba(20,10,2,.45);}
.mg-c4-legs{display:flex;justify-content:space-between;width:74%;}
.mg-c4-legs u{width:clamp(14px,2vw,22px);height:clamp(8px,1.4vh,16px);
  background:linear-gradient(180deg,#8a5a2c,#5b3a1b);border-radius:0 0 6px 6px;}

/* ---- fx ---- */
.mg-c4-fx{position:absolute;inset:0;z-index:8;pointer-events:none;overflow:hidden;}
.mg-c4-float{position:absolute;transform:translate(-50%,-50%);font-weight:900;white-space:nowrap;
  animation:mg-c4-float 1.15s ease-out forwards;text-shadow:0 3px 0 rgba(40,20,4,.4);}
@keyframes mg-c4-float{0%{opacity:0;transform:translate(-50%,-20%) scale(.4) rotate(-6deg)}
  25%{opacity:1;transform:translate(-50%,-58%) scale(1.18) rotate(2deg)}
  55%{transform:translate(-50%,-68%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-150%) scale(.94)}}
.mg-c4-float.mg-c4-big{color:#ffe08a;font-size:clamp(26px,4.4vw,54px);letter-spacing:.04em;}
.mg-c4-float.mg-c4-small{color:#fff6e3;font-size:clamp(15px,1.9vw,23px);letter-spacing:.1em;}
.mg-c4-float.mg-c4-bad{color:#ffb0a4;font-size:clamp(18px,2.4vw,30px);}

/* ---- overlays ---- */
.mg-c4-over{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;
  background:rgba(32,18,8,.74);backdrop-filter:blur(3px);padding:18px;text-align:center;}
.mg-c4-over.mg-c4-gone{display:none;}
.mg-c4-card{background:linear-gradient(180deg,#fffdf6,#ffeed2);border-radius:28px;padding:24px 28px;
  width:min(600px,94vw);max-height:94%;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.45);
  animation:mg-c4-card .32s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-c4-card{from{transform:scale(.84) translateY(18px);opacity:0}}
.mg-c4-card h1{font-size:clamp(28px,4.4vw,44px);color:#e8657a;line-height:1.04;}
.mg-c4-card h2{font-size:clamp(23px,3.4vw,34px);color:#e8657a;}
.mg-c4-sub{font-weight:800;color:#9a8461;font-size:13px;margin:5px 0 14px;letter-spacing:.05em;}
.mg-c4-legend{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:12px;
  flex-wrap:wrap;}
.mg-c4-legend div{display:flex;align-items:center;gap:8px;background:#fff6e3;border-radius:999px;
  padding:6px 14px;font-size:12.5px;font-weight:900;}
.mg-c4-legend u{width:22px;height:22px;border-radius:50%;border:3px solid #3a2a1c;}
.mg-c4-how{display:flex;flex-direction:column;gap:8px;text-align:left;margin-bottom:16px;}
.mg-c4-how div{display:flex;align-items:center;gap:12px;background:#fff6e3;border-radius:14px;
  padding:9px 14px;font-size:13px;font-weight:700;line-height:1.35;}
.mg-c4-how i{flex:none;width:29px;height:29px;border-radius:50%;background:#e8657a;color:#fff;
  font-style:normal;font-weight:900;font-size:13.5px;display:flex;align-items:center;justify-content:center;}
.mg-c4-stats{display:flex;justify-content:center;gap:10px;margin:14px 0;flex-wrap:wrap;}
.mg-c4-stat{background:#fff6e3;border-radius:18px;padding:11px 20px;min-width:106px;}
.mg-c4-stat b{display:block;font-size:clamp(22px,3.1vw,32px);color:#2d2417;line-height:1.1;}
.mg-c4-stat span{font-size:10.5px;font-weight:900;letter-spacing:.13em;color:#9a8461;}
.mg-c4-stat.mg-c4-gold b{color:#e0982a;}
.mg-c4-ribbon{display:inline-block;background:#f2b64a;color:#fff;font-weight:900;letter-spacing:.14em;
  font-size:12px;padding:6px 18px;border-radius:999px;margin-bottom:6px;
  animation:mg-c4-pulse .85s ease-in-out infinite;}
@keyframes mg-c4-pulse{50%{transform:scale(1.07)}}
.mg-c4-btns{display:flex;gap:11px;justify-content:center;flex-wrap:wrap;}
.mg-c4-btn{border:4px solid #fff;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(14px,1.7vw,18px);padding:12px 26px;cursor:pointer;
  box-shadow:0 7px 0 rgba(50,28,10,.3);transition:.12s;}
.mg-c4-btn:hover{transform:translateY(-2px);}
.mg-c4-btn:active{transform:translateY(5px);box-shadow:0 2px 0 rgba(50,28,10,.3);}
.mg-c4-btn.mg-c4-alt{background:#4fb3e8;}
.mg-c4-btn.mg-c4-ghost{background:transparent;border-color:rgba(58,42,28,.3);color:#7a6748;box-shadow:none;}
.mg-c4-count{font-size:clamp(64px,15vw,164px);font-weight:900;color:#fff6e3;
  text-shadow:0 8px 0 rgba(40,20,4,.4);animation:mg-c4-count .6s ease-out;}
.mg-c4-count.mg-c4-word{font-size:clamp(26px,5.6vw,64px);padding:0 16px;}
@keyframes mg-c4-count{from{transform:scale(2.1);opacity:0}40%{opacity:1}to{transform:scale(1)}}
.mg-c4-face{margin:0 auto 8px;display:block;}

@media (max-width:860px){
  .mg-c4-side.mg-c4-you-side{display:none;}
  .mg-c4-side{width:clamp(96px,22vw,140px);}
}
/* short windows: the card must never push its buttons below the fold */
@media (max-height:700px){
  .mg-c4-card{padding:14px 20px;border-radius:22px;}
  .mg-c4-face{display:none;}
  .mg-c4-sub{margin:2px 0 7px;font-size:11.5px;}
  .mg-c4-legend{gap:8px;margin-bottom:6px;}
  .mg-c4-legend div{padding:4px 11px;font-size:11.5px;}
  .mg-c4-legend u{width:16px;height:16px;border-width:2px;}
  .mg-c4-how{gap:4px;margin-bottom:8px;}
  .mg-c4-how div{padding:4px 10px;font-size:11px;line-height:1.3;}
  .mg-c4-how i{width:22px;height:22px;font-size:12px;}
  .mg-c4-stats{margin:6px 0;gap:7px;}
  .mg-c4-stat{padding:7px 14px;min-width:84px;}
  .mg-c4-stat b{font-size:20px;}
  .mg-c4-ribbon{margin-bottom:2px;padding:4px 14px;font-size:11px;}
  .mg-c4-btn{padding:9px 20px;}
}
@media (max-height:620px){
  .mg-c4-trophy,.mg-c4-shelf,.mg-c4-lamp{display:none;}
}
`;

// ---------------------------------------------------------------------------
// chatter
// ---------------------------------------------------------------------------
const LINES = {
  hello: ['drop one! drop one! i am so ready',
    'four in a row. that is the whole thing. i love it',
    'i have been practising on the wall'],
  think: ['hmmm hmm hmmmm...', 'okay okay okay okay', 'let me see let me SEE',
    'ooh! no. wait. hmm.', 'counting! i am counting!'],
  smug: ['heehee. no reason to look at that column.', 'this is going GREAT for me',
    'do not panic. i would panic.', 'i have a plan and it is a good one'],
  worry: ['eep!', 'that is a LOT of your discs in a row', 'no no no no no',
    'i am fine. everything is fine.'],
  chill: ['nice drop!', 'ooh, bold.', 'my turn my turn my turn', 'the board is filling up!!'],
  youWin: ['NOOO my beautiful row', 'rematch! rematch! rematch!', 'i saw it coming. i just fell over.'],
  dizWin: ['FOUR! i got FOUR! did you see it!!', 'i am the best at this. and also very humble.'],
  draw: ['a tie! we are exactly the same amount of good!'],
};

// ---------------------------------------------------------------------------
// the game
// ---------------------------------------------------------------------------
export class Connect4Game extends Minigame {
  static id = 'connect4';
  static name = 'Four in a Row';

  constructor(game) {
    super(game);
    this._timers = new Set();
    this._raf = 0;
    this._dead = false;
    this._onKey = null;
    this._onResize = null;
    this._ro = null;
    this.phase = 'splash';
    this.el = {};

    this.board = new Int8Array(CELLS);
    this.heights = new Int8Array(COLS);
    this.filled = 0;
    this.turn = YOU;
    this.gameIndex = 0; // rematch counter: decides who drops first
    this.tally = { you: 0, diz: 0 };

    this.anim = null;
    this.thinking = false;
    this.winLine = null;
    this.winner = 0;
    this.hoverCol = -1;
    this.cursor = 3;
    this.shake = 0;
    this.confetti = [];
    this.winT = 0;
    this.lastT = 0;
    this.clock = 0;

    this.dizzy = { color: '#c9a06b', hat: 'capback', hatColor: '#e8657a' };
    this.you = { color: '#b08a5a', hat: 'none', hatColor: '#e8657a' };
    this.dizExpr = 'idle';
    this.youExpr = 'idle';
    this._painted = { diz: '', you: '', size: 0 };
    this._portraitT = 0;

    this.geo = { cell: 48, pad: 9, dropH: 56, w: 360, h: 360 };
  }

  // ---- lifecycle ----------------------------------------------------------
  mount(root) {
    super.mount(root);
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-c4-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (sel) => wrap.querySelector(sel);
    this.el = {
      wrap,
      turn: q('[data-el="turn"]'),
      turnChip: q('[data-el="turnChip"]'),
      tally: q('[data-el="tally"]'),
      reward: q('[data-el="reward"]'),
      stage: q('[data-el="stage"]'),
      youSide: q('[data-el="youSide"]'),
      dizSide: q('[data-el="dizSide"]'),
      youFace: q('[data-el="youFace"]'),
      dizFace: q('[data-el="dizFace"]'),
      youName: q('[data-el="youName"]'),
      bubble: q('[data-el="bubble"]'),
      youBubble: q('[data-el="youBubble"]'),
      boardWrap: q('[data-el="boardWrap"]'),
      canvas: q('[data-el="canvas"]'),
      fx: q('[data-el="fx"]'),
      over: q('[data-el="over"]'),
    };
    this.ctx = this.el.canvas.getContext('2d');

    // the player's own capy sits opposite Dizzy
    const st = this.game.state || {};
    this.you.color = hexOf(typeof st.color === 'number' ? st.color : 0xb08a5a);
    const mapped = Object.prototype.hasOwnProperty.call(HAT_MAP, st.hat) ? HAT_MAP[st.hat] : null;
    this.you.hat = mapped ? mapped[0] : 'none';
    this.you.hatColor = mapped ? mapped[1] : '#e8657a';
    this.el.youName.textContent = (st.name || 'You').slice(0, 12);

    this._buildBackdrop();

    const cv = this.el.canvas;
    cv.addEventListener('pointermove', (e) => this._pointer(e, false));
    cv.addEventListener('pointerdown', (e) => this._pointer(e, true));
    cv.addEventListener('pointerleave', () => { this.hoverCol = -1; });
    wrap.querySelector('[data-el="quit"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey);
    this._onResize = () => this._layout();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._layout());
      this._ro.observe(this.el.boardWrap);
    }

    this._resetBoard();
    this._layout();
    this._showSplash();
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  dispose() {
    this._dead = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this._onKey = null;
    this._onResize = null;
    try { this._ro?.disconnect?.(); } catch { /* observer already gone */ }
    this._ro = null;
    this.confetti.length = 0;
    this.ctx = null;
    this.el = {};
  }

  /** win 40 + 2 per empty cell (cap 60), draw 12, loss 5. */
  coinsForScore(score) {
    const s = Math.max(0, Math.floor(Number(score) || 0));
    if (s >= 300) {
      const empty = clamp(Math.floor((s - 300) / 10), 0, 35);
      return Math.min(60, 40 + 2 * empty);
    }
    if (s === 120) return 12;
    return s > 0 ? 5 : 0;
  }

  /** What the purse actually receives, i.e. what the UI must show. */
  _payout(score) { return clampCoinsForGame('connect4', this.coinsForScore(score)); }

  _after(ms, fn) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (!this._dead) fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  // ---- markup -------------------------------------------------------------
  _html() {
    return `
      <div class="mg-c4-bg" data-el="bg"></div>

      <div class="mg-c4-hud">
        <div class="mg-c4-chip mg-c4-turn" data-el="turnChip"><small>TURN</small><b data-el="turn">YOU</b></div>
        <div class="mg-c4-chip mg-c4-tally"><small>MATCH</small><span data-el="tally"></span></div>
        <div class="mg-c4-chip mg-c4-reward"><small>WIN NOW</small><b data-el="reward">+60</b></div>
        <div class="mg-c4-spacer"></div>
        <button class="mg-c4-quit" data-el="quit">QUIT</button>
      </div>

      <div class="mg-c4-stage" data-el="stage">
        <div class="mg-c4-side mg-c4-you-side" data-el="youSide">
          <div class="mg-c4-bubble" data-el="youBubble">your turn: pick a column</div>
          <canvas class="mg-c4-portrait" data-el="youFace"></canvas>
          <div class="mg-c4-nametag"><u style="background:${YOU_C1}"></u><span data-el="youName">You</span></div>
        </div>

        <div class="mg-c4-boardwrap" data-el="boardWrap">
          <canvas class="mg-c4-board" data-el="canvas"></canvas>
          <div class="mg-c4-stand"></div>
          <div class="mg-c4-legs"><u></u><u></u></div>
        </div>

        <div class="mg-c4-side" data-el="dizSide">
          <div class="mg-c4-bubble" data-el="bubble">drop one! drop one!</div>
          <canvas class="mg-c4-portrait" data-el="dizFace"></canvas>
          <div class="mg-c4-nametag"><u style="background:${DIZ_C1}"></u><span>Dizzy</span></div>
        </div>
      </div>

      <div class="mg-c4-fx" data-el="fx"></div>
      <div class="mg-c4-over" data-el="over"></div>`;
  }

  _buildBackdrop() {
    const bg = this.el.wrap.querySelector('[data-el="bg"]');
    const lamp = document.createElement('div');
    lamp.className = 'mg-c4-lamp';
    bg.appendChild(lamp);
    for (const [left, delay] of [['7%', 0], ['84%', 0.6]]) {
      const shelf = document.createElement('div');
      shelf.className = 'mg-c4-shelf';
      shelf.style.left = left;
      shelf.style.width = '108px';
      bg.appendChild(shelf);
      const t = document.createElement('div');
      t.className = 'mg-c4-trophy';
      t.style.left = `calc(${left} + 18px)`;
      t.style.animation = `mg-c4-idle ${4 + delay}s ease-in-out infinite`;
      t.innerHTML = '<i></i><b></b><s></s>';
      bg.appendChild(t);
    }
  }

  // ---- layout -------------------------------------------------------------
  _layout() {
    if (this._dead || !this.el.canvas) return;
    const wrap = this.el.boardWrap;
    const availW = Math.max(160, wrap.clientWidth || this.el.wrap.clientWidth * 0.5);
    const availH = Math.max(160, (wrap.clientHeight || this.el.wrap.clientHeight * 0.7) - 26);
    const cell = clamp(Math.floor(Math.min(availW / 7.5, availH / 7.9)), 26, 96);
    const pad = Math.round(cell * 0.19);
    const dropH = Math.round(cell * 1.12);
    const w = COLS * cell + pad * 2;
    const h = ROWS * cell + pad * 2 + dropH;
    this.geo = { cell, pad, dropH, w, h };

    const cv = this.el.canvas;
    const d = dpr();
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const pw = Math.round(w * d), ph = Math.round(h * d);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const stand = this.el.wrap.querySelector('.mg-c4-stand');
    if (stand) stand.style.width = `${Math.round(w * 0.94)}px`;

    // portraits scale with the board so the table reads as one composition
    const size = clamp(Math.round(cell * 3.4), 96, 216);
    if (size !== this._painted.size) {
      this._painted.size = size;
      this._painted.diz = '';
      this._painted.you = '';
    }
    this._paintPortraits(true);
  }

  _cellX(c) { return this.geo.pad + c * this.geo.cell + this.geo.cell / 2; }
  _rowY(r) { return this.geo.dropH + this.geo.pad + r * this.geo.cell + this.geo.cell / 2; }

  // ---- board state --------------------------------------------------------
  _resetBoard() {
    this.board.fill(0);
    this.heights.fill(0);
    this.filled = 0;
    this.anim = null;
    this.thinking = false;
    this.winLine = null;
    this.winner = 0;
    this.winT = 0;
    this.hoverCol = -1;
    this.cursor = 3;
    this.confetti.length = 0;
    this.turn = this.gameIndex % 2 === 0 ? YOU : DIZ;
    this.dizExpr = 'idle';
    this.youExpr = 'idle';
    this._syncHud();
  }

  _emptyCells() { return CELLS - this.filled; }

  _syncHud() {
    if (!this.el.turn) return;
    const live = this.phase === 'play' || this.phase === 'count';
    const yours = this.turn === YOU;
    this.el.turn.textContent = live ? (yours ? 'YOU' : 'DIZZY') : '--';
    this.el.turnChip.classList.toggle('mg-c4-them', !yours);
    this.el.turnChip.classList.remove('mg-c4-bump');
    void this.el.turnChip.offsetWidth;
    this.el.turnChip.classList.add('mg-c4-bump');
    this.el.youSide.classList.toggle('mg-c4-active', yours && live);
    this.el.dizSide.classList.toggle('mg-c4-active', !yours && live);

    // counts, not a dot per win: a long rematch streak must not stretch the HUD
    this.el.tally.innerHTML =
      `<i class="mg-c4-you"></i>${this.tally.you}<i class="mg-c4-diz"></i>${this.tally.diz}`;

    // honest live payout: what a win with the very next disc would pay
    const empty = Math.max(0, this._emptyCells() - 1);
    this.el.reward.textContent = `+${Math.min(60, 40 + 2 * empty)}`;
  }

  _say(who, text) {
    const el = who === 'diz' ? this.el.bubble : this.el.youBubble;
    if (!el) return;
    el.textContent = text;
    el.classList.remove('mg-c4-pop');
    void el.offsetWidth;
    el.classList.add('mg-c4-pop');
  }

  // ---- input --------------------------------------------------------------
  _canDrop() {
    return this.phase === 'play' && this.turn === YOU && !this.anim && !this.thinking && !this.winner;
  }

  _colAt(clientX) {
    const r = this.el.canvas.getBoundingClientRect();
    if (!r.width) return -1;
    const x = ((clientX - r.left) / r.width) * this.geo.w;
    // clamped, not rejected: a click on the frame edge still means "that column"
    return clamp(Math.floor((x - this.geo.pad) / this.geo.cell), 0, COLS - 1);
  }

  _pointer(e, press) {
    if (!this._canDrop()) { this.hoverCol = -1; return; }
    const c = this._colAt(e.clientX);
    if (c !== this.hoverCol && c >= 0 && this.heights[c] < ROWS && !press) {
      this.game.audio?.play?.('hover');
    }
    this.hoverCol = c;
    if (press && c >= 0) {
      this.cursor = c;
      this._drop(c, YOU);
    }
  }

  _key(e) {
    if (this._dead) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      this.game.audio?.play?.('click');
      this.quit();
      return;
    }
    if (this.phase === 'splash' || this.phase === 'over') {
      if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        this.el.over?.querySelector('[data-a="play"],[data-a="again"]')?.click();
      }
      return;
    }
    if (!this._canDrop()) return;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      e.preventDefault();
      this.cursor = (this.cursor + COLS - 1) % COLS;
      this.hoverCol = this.cursor;
      this.game.audio?.play?.('hover');
    } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      e.preventDefault();
      this.cursor = (this.cursor + 1) % COLS;
      this.hoverCol = this.cursor;
      this.game.audio?.play?.('hover');
    } else if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 's' || k === 'S') {
      e.preventDefault();
      this.hoverCol = this.cursor;
      this._drop(this.cursor, YOU);
    } else if (k >= '1' && k <= '7') {
      e.preventDefault();
      const c = Number(k) - 1;
      this.cursor = c;
      this.hoverCol = c;
      this._drop(c, YOU);
    }
  }

  // ---- dropping -----------------------------------------------------------
  _drop(col, who) {
    if (this.phase !== 'play' || this.anim || this.winner) return;
    if (col < 0 || col >= COLS) return;
    if (this.heights[col] >= ROWS) {
      this.game.audio?.play?.('fail');
      this._float('FULL!', this._cellX(col), this.geo.dropH * 0.6, 'mg-c4-bad');
      return;
    }
    const row = ROWS - 1 - this.heights[col];
    const idx = row * COLS + col;
    this.board[idx] = who;
    this.heights[col]++;
    this.filled++;
    this.hoverCol = -1;
    this.game.audio?.play?.('whoosh');
    this.anim = { col, row, idx, who, y: -1.35, vy: 0, squash: 1, bounces: 0, settling: 0 };
  }

  _land() {
    const a = this.anim;
    this.anim = null;
    if (!a) return;
    this._syncHud(); // the "win now" payout ticks down with every disc

    if (isWinAt(this.board, a.row, a.col, a.who)) {
      this._endGame(a.who, winCellsAt(this.board, a.row, a.col, a.who));
      return;
    }
    if (this.filled >= CELLS) {
      this._endGame(0, null);
      return;
    }
    this.turn = a.who === YOU ? DIZ : YOU;
    this._syncHud();
    this._reactAfterMove(a.who);
    if (this.turn === DIZ) this._dizzyTurn();
  }

  /** Dizzy's face and chatter follow the position, not the dice. */
  _reactAfterMove(who) {
    const youThreat = this._threatCols(YOU).length > 0;
    const dizThreat = this._threatCols(DIZ).length > 0;
    if (youThreat) {
      this.dizExpr = 'worried';
      this.youExpr = 'idle';
      if (who === YOU) this._say('diz', pick(LINES.worry));
    } else if (dizThreat) {
      this.dizExpr = 'smug';
      this.youExpr = 'worried';
      if (who === DIZ) this._say('diz', pick(LINES.smug));
    } else {
      this.dizExpr = 'idle';
      this.youExpr = 'idle';
      if (who === YOU && Math.random() < 0.45) this._say('diz', pick(LINES.chill));
    }
    this._say('you', this.turn === YOU ? 'your turn: pick a column' : 'watching Dizzy...');
  }

  /** Columns where `p` wins on the spot. */
  _threatCols(p) {
    const out = [];
    for (let c = 0; c < COLS; c++) {
      if (this.heights[c] >= ROWS) continue;
      const r = ROWS - 1 - this.heights[c];
      const idx = r * COLS + c;
      this.board[idx] = p;
      const win = isWinAt(this.board, r, c, p);
      this.board[idx] = 0;
      if (win) out.push(c);
    }
    return out;
  }

  // ---- Dizzy's brain ------------------------------------------------------
  _dizzyTurn() {
    this.thinking = true;
    this.dizExpr = 'thinking';
    this._say('diz', pick(LINES.think));
    this._say('you', 'watching Dizzy...');
    // let the "thinking" frame paint before the search blocks the thread
    this._after(220 + Math.random() * 380, () => {
      if (this.phase !== 'play' || this.winner) { this.thinking = false; return; }
      let col = 3;
      try {
        col = this._chooseMove();
      } catch {
        col = this._threatCols(DIZ)[0] ?? this._firstOpenColumn();
      }
      this.thinking = false;
      if (this.heights[col] >= ROWS) col = this._firstOpenColumn();
      if (col < 0) return;
      this._drop(col, DIZ);
    });
  }

  _firstOpenColumn() {
    for (const c of [3, 2, 4, 1, 5, 0, 6]) if (this.heights[c] < ROWS) return c;
    return -1;
  }

  /**
   * Immediate win, then immediate block, then a randomised opening on Dizzy's
   * very first disc, then alpha-beta (iterative deepening up to AI_DEPTH so a
   * slow machine degrades instead of freezing).
   */
  _chooseMove() {
    const mine = this._threatCols(DIZ);
    if (mine.length) return pick(mine);
    const yours = this._threatCols(YOU);
    if (yours.length) return yours[0];

    if (this.filled <= 1) {
      // reasonable, centre-loving openings so no two games start the same
      return pick([3, 3, 3, 3, 2, 2, 4, 4, 1, 5]);
    }

    const board = Int8Array.from(this.board);
    const heights = Int8Array.from(this.heights);
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let best = this._firstOpenColumn();

    for (let depth = 2; depth <= AI_DEPTH; depth++) {
      shuffleOrder();
      // search the previous winner first: better ordering, better pruning
      const order = [best, ...SEARCH_ORDER.filter((c) => c !== best)];
      let bestVal = -Infinity;
      let bestCol = best;
      let alpha = -Infinity;
      for (const c of order) {
        if (heights[c] >= ROWS) continue;
        const r = ROWS - 1 - heights[c];
        const idx = r * COLS + c;
        board[idx] = DIZ; heights[c]++;
        let v;
        if (isWinAt(board, r, c, DIZ)) v = WIN_V + depth;
        else v = -negamax(board, heights, this.filled + 1, depth - 1, -Infinity, -alpha, YOU, DIZ);
        board[idx] = 0; heights[c]--;
        if (v > bestVal) { bestVal = v; bestCol = c; }
        if (v > alpha) alpha = v;
      }
      best = bestCol;
      if (bestVal >= WIN_V) break; // forced win found, no need to look deeper
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - t0 > AI_BUDGET_MS) break;
    }
    return best;
  }

  // ---- end of a game ------------------------------------------------------
  _endGame(winner, cells) {
    this.phase = 'end'; // locks input for the draw case too, where winner is 0
    this.winner = winner;
    this.winLine = cells;
    this.winT = 0;
    this.hoverCol = -1;
    this._syncHud();

    if (winner === YOU) {
      this.tally.you++;
      this.dizExpr = 'beaten';
      this.youExpr = 'cheer';
      this._say('diz', pick(LINES.youWin));
      this._say('you', 'FOUR IN A ROW!');
      this.game.audio?.play?.('success');
      this.shake = 13;
      this._burst(YOU);
      this._float('FOUR IN A ROW!', this.geo.w / 2, this.geo.dropH + this.geo.cell * 2, 'mg-c4-big');
    } else if (winner === DIZ) {
      this.tally.diz++;
      this.dizExpr = 'cheer';
      this.youExpr = 'worried';
      this._say('diz', pick(LINES.dizWin));
      this._say('you', 'ouch. rematch?');
      this.game.audio?.play?.('fail');
      this.shake = 10;
      this._burst(DIZ);
      this._float('DIZZY GETS FOUR', this.geo.w / 2, this.geo.dropH + this.geo.cell * 2, 'mg-c4-bad');
    } else {
      this.dizExpr = 'idle';
      this.youExpr = 'idle';
      this._say('diz', pick(LINES.draw));
      this._say('you', 'not one square left!');
      this.game.audio?.play?.('ding');
      this._float('BOARD FULL', this.geo.w / 2, this.geo.dropH + this.geo.cell * 2, 'mg-c4-small');
    }
    this._syncHud();
    this._after(winner ? 1650 : 1100, () => this._results());
  }

  _score() {
    const empty = this._emptyCells();
    if (this.winner === YOU) return 300 + 10 * empty;
    if (this.winner === DIZ) return 20 + empty;
    return 120;
  }

  // ---- screens ------------------------------------------------------------
  _showSplash() {
    this.phase = 'splash';
    const best = this.game.state?.bests?.connect4 || 0;
    const over = this.el.over;
    over.classList.remove('mg-c4-gone');
    over.innerHTML = `
      <div class="mg-c4-card">
        <canvas class="mg-c4-face" data-el="splashFace"></canvas>
        <h1>Four in a Row</h1>
        <div class="mg-c4-sub">DIZZY HAS BEEN PRACTISING. DIZZY WILL TELL YOU ABOUT IT.</div>
        <div class="mg-c4-legend">
          <div><u style="background:${YOU_C1}"></u>YOU</div>
          <div><u style="background:${DIZ_C1}"></u>DIZZY</div>
        </div>
        <div class="mg-c4-how">
          <div><i>1</i><span>Click a column (or <b>&larr; &rarr;</b> then <b>Space</b>, or keys <b>1</b>&ndash;<b>7</b>) to drop a disc.</span></div>
          <div><i>2</i><span>Four in a row wins: across, up, or slanted. Discs stack from the bottom.</span></div>
          <div><i>3</i><span>Coins are for the <b>win</b> only, and the fewer discs it takes, the fatter the payout.</span></div>
          <div><i>4</i><span>Rematch as often as you like: the first drop swaps sides each game.</span></div>
        </div>
        <div class="mg-c4-stats">
          <div class="mg-c4-stat"><b>${best}</b><span>YOUR BEST</span></div>
          <div class="mg-c4-stat mg-c4-gold"><b>${this._payout(best)}</b><span>COINS THEN</span></div>
        </div>
        <div class="mg-c4-btns">
          <button class="mg-c4-btn" data-a="play">CHALLENGE DIZZY</button>
          <button class="mg-c4-btn mg-c4-ghost" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    const face = over.querySelector('[data-el="splashFace"]');
    if (face) paintCapy(face, 128, this.dizzy, 'smug', 0);
    over.querySelector('[data-a="play"]').addEventListener('click', () => this._countdown());
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
  }

  _countdown() {
    if (this.phase !== 'splash' && this.phase !== 'over') return;
    this.game.audio?.play?.('click');
    this._resetBoard();
    this._layout();
    this.phase = 'count';
    this._say('diz', pick(LINES.hello));
    this._say('you', 'here we go');
    const first = this.turn === YOU ? 'YOU DROP FIRST!' : 'DIZZY DROPS FIRST!';
    const steps = ['3', '2', '1', first];
    const over = this.el.over;
    over.classList.remove('mg-c4-gone');
    const show = (i) => {
      if (i >= steps.length) {
        over.classList.add('mg-c4-gone');
        over.innerHTML = '';
        this.phase = 'play';
        this._syncHud();
        if (this.turn === DIZ) this._dizzyTurn();
        return;
      }
      const last = i === steps.length - 1;
      over.innerHTML = `<div class="mg-c4-count${last ? ' mg-c4-word' : ''}">${steps[i]}</div>`;
      this.game.audio?.play?.(last ? 'success' : 'ding');
      this._after(last ? 700 : 600, () => show(i + 1));
    };
    show(0);
  }

  _results() {
    this.phase = 'over';
    const score = this._score();
    const prevBest = this.game.state?.bests?.connect4 || 0;
    const isBest = score > prevBest;
    const coins = this._payout(score);
    this.finish(score);
    const shown = Math.max(prevBest, score);
    this.game.audio?.play?.(this.winner === YOU ? 'success' : 'ding');

    const won = this.winner === YOU;
    const drew = this.winner === 0;
    const title = won ? 'You got four!' : drew ? 'Dead heat!' : 'Dizzy got four.';
    const sub = won
      ? `DIZZY IS LYING ON THE FLOOR. DISCS LEFT IN THE BOX: ${this._emptyCells()}.`
      : drew
        ? 'NOT ONE EMPTY HOLE LEFT. NOBODY WINS, EVERYBODY SNACKS.'
        : 'HE IS ALREADY TELLING THE WHOLE DEN ABOUT IT.';

    const over = this.el.over;
    over.classList.remove('mg-c4-gone');
    over.innerHTML = `
      <div class="mg-c4-card">
        <canvas class="mg-c4-face" data-el="resFace"></canvas>
        ${isBest ? '<div class="mg-c4-ribbon">NEW BEST</div>' : ''}
        <h2>${title}</h2>
        <div class="mg-c4-sub">${sub}</div>
        <div class="mg-c4-stats">
          <div class="mg-c4-stat"><b>${score}</b><span>SCORE</span></div>
          <div class="mg-c4-stat mg-c4-gold"><b>${coins}</b><span>COINS</span></div>
          <div class="mg-c4-stat"><b>${shown}</b><span>BEST</span></div>
        </div>
        <div class="mg-c4-stats">
          <div class="mg-c4-stat"><b>${this.tally.you} - ${this.tally.diz}</b><span>YOU vs DIZZY</span></div>
          <div class="mg-c4-stat"><b>${this.filled}</b><span>DISCS DROPPED</span></div>
        </div>
        <div class="mg-c4-btns">
          <button class="mg-c4-btn" data-a="again">Play again</button>
          <button class="mg-c4-btn mg-c4-alt" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    const face = over.querySelector('[data-el="resFace"]');
    if (face) paintCapy(face, 122, this.dizzy, won ? 'beaten' : drew ? 'idle' : 'cheer', 0);
    over.querySelector('[data-a="again"]').addEventListener('click', () => {
      this._done = false; // each rematch reports its own run
      this.gameIndex++; // and the first drop alternates
      this._countdown();
    });
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  // ---- fx -----------------------------------------------------------------
  /** x,y are canvas-space; converted to the fx layer's box. */
  _float(text, x, y, cls) {
    const fx = this.el.fx;
    if (!fx) return;
    const cr = this.el.canvas.getBoundingClientRect();
    const fr = fx.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `mg-c4-float ${cls}`;
    el.textContent = text;
    el.style.left = `${cr.left - fr.left + (x / this.geo.w) * cr.width}px`;
    el.style.top = `${cr.top - fr.top + (y / this.geo.h) * cr.height}px`;
    fx.appendChild(el);
    this._after(1250, () => el.remove());
  }

  _burst(who) {
    const cols = who === YOU
      ? ['#f5869a', '#e8657a', '#ffd06a', '#fff6e3', '#7ac74f']
      : ['#ffd06a', '#f2b64a', '#fff6e3', '#c9a06b'];
    const cx = this.geo.w / 2, cy = this.geo.dropH + this.geo.cell * 2;
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 320;
      this.confetti.push({
        x: cx + (Math.random() - 0.5) * this.geo.cell * 4,
        y: cy + (Math.random() - 0.5) * this.geo.cell,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 160,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        size: this.geo.cell * (0.1 + Math.random() * 0.12),
        c: pick(cols),
        life: 1.6 + Math.random() * 1.2,
      });
    }
  }

  // ---- loop ---------------------------------------------------------------
  _loop(t) {
    if (this._dead) return;
    this._raf = requestAnimationFrame((n) => this._loop(n));
    const dt = this.lastT ? Math.min(0.05, (t - this.lastT) / 1000) : 0.016;
    this.lastT = t;
    this.clock += dt;
    this._step(dt);
    this._draw();
    this._paintPortraits(false);
  }

  _step(dt) {
    // falling disc
    const a = this.anim;
    if (a) {
      a.vy += 46 * dt;
      a.y += a.vy * dt;
      if (a.y >= a.row) {
        a.y = a.row;
        if (a.settling > 0) {
          // hold the disc one beat so the squash actually reads before the
          // turn resolves (resolving on contact ate the whole pop)
          a.settling -= dt;
          if (a.settling <= 0) this._land();
        } else if (a.vy > 6 && a.bounces < 2) {
          a.bounces++;
          a.vy = -a.vy * 0.3;
          a.squash = 0.68;
          this.game.audio?.play?.(a.bounces === 1 ? 'pop' : 'tick');
          this.shake = Math.max(this.shake, a.bounces === 1 ? 5 : 2);
        } else {
          a.vy = 0;
          a.squash = 0.7;
          a.settling = 0.17;
          this.game.audio?.play?.('pop');
          this.shake = Math.max(this.shake, 3.5);
        }
      }
      a.squash += (1 - a.squash) * Math.min(1, dt * 13);
    }

    this.shake *= Math.max(0, 1 - dt * 9);
    if (this.shake < 0.15) this.shake = 0;
    if (this.winLine) this.winT += dt;

    // confetti
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const p = this.confetti[i];
      p.vy += 520 * dt;
      p.vx *= 1 - dt * 0.7;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= dt;
      if (p.life <= 0 || p.y > this.geo.h + 60) this.confetti.splice(i, 1);
    }
  }

  // ---- painting -----------------------------------------------------------
  _paintPortraits(force) {
    if (!this.el.dizFace) return;
    this._portraitT += 1;
    // only the spinning spiral and the sweat bead actually move frame to frame
    const animated = this.dizExpr === 'beaten' || this.dizExpr === 'worried';
    if (!force && !animated && this._painted.diz === this.dizExpr && this._painted.you === this.youExpr) return;
    if (!force && animated && this._portraitT % 5 !== 0
      && this._painted.diz === this.dizExpr && this._painted.you === this.youExpr) return;
    const size = this._painted.size || 150;
    paintCapy(this.el.dizFace, size, this.dizzy, this.dizExpr, this.clock);
    if (force || this._painted.you !== this.youExpr) {
      paintCapy(this.el.youFace, size, this.you, this.youExpr, this.clock);
    }
    this._painted.diz = this.dizExpr;
    this._painted.you = this.youExpr;
  }

  _discColors(who) {
    return who === YOU ? [YOU_C1, YOU_C2] : [DIZ_C1, DIZ_C2];
  }

  _drawDisc(ctx, x, y, r, who, sq = 1, alpha = 1) {
    const [c1, c2] = this._discColors(who);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(1 + (1 - sq) * 0.55, sq);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grad(ctx, -r, -r, r, r, shade(c1, 0.18), c2);
    ctx.fill();
    ink(ctx, Math.max(2, r * 0.17));
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,246,227,0.55)';
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    ctx.stroke();
    if (who === YOU) {
      // a little capy nose
      ctx.fillStyle = 'rgba(58,42,28,0.75)';
      ctx.beginPath(); ctx.ellipse(-r * 0.2, r * 0.05, r * 0.09, r * 0.16, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.2, r * 0.05, r * 0.09, r * 0.16, -0.4, 0, Math.PI * 2); ctx.fill();
    } else {
      // Dizzy's swirl
      ctx.beginPath();
      for (let k = 0; k <= 40; k++) {
        const ang = (k / 40) * Math.PI * 3;
        const rr = (k / 40) * r * 0.5;
        const px = Math.cos(ang) * rr, py = Math.sin(ang) * rr;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(58,42,28,0.5)';
      ctx.lineWidth = Math.max(1.5, r * 0.1);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.ellipse(-r * 0.34, -r * 0.4, r * 0.26, r * 0.15, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fill();
    ctx.restore();
  }

  _draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const { cell, pad, dropH, w, h } = this.geo;
    const d = dpr();
    const holeR = cell * 0.425;
    const discR = cell * 0.4;

    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const plateY = dropH;
    const plateH = ROWS * cell + pad * 2;

    // dark sockets behind the holes
    ctx.save();
    ctx.beginPath(); rrect(ctx, 0, plateY, w, plateH, cell * 0.3);
    ctx.clip();
    ctx.fillStyle = '#1f3040';
    ctx.fillRect(0, plateY, w, plateH);
    ctx.restore();

    // settled discs (the falling one is drawn at its animated height instead)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        const v = this.board[idx];
        if (!v) continue;
        if (this.anim && this.anim.idx === idx) continue;
        this._drawDisc(ctx, this._cellX(c), this._rowY(r), discR, v);
      }
    }
    // the falling disc: above the plate it is in the open, below it shows
    // through the hole it is passing, which is exactly the real thing
    if (this.anim) {
      const a = this.anim;
      this._drawDisc(ctx, this._cellX(a.col), this._rowY(a.y), discR, a.who, a.squash);
    }

    // the blue plate, with the holes punched out
    ctx.save();
    ctx.beginPath();
    rrect(ctx, 0, plateY, w, plateH, cell * 0.3);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = this._cellX(c), y = this._rowY(r);
        ctx.moveTo(x + holeR, y);
        ctx.arc(x, y, holeR, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = grad(ctx, 0, plateY, w, plateY + plateH, '#63c4f0', '#2a86bd');
    ctx.fill('evenodd');
    ctx.lineWidth = Math.max(2.5, cell * 0.075);
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.restore();

    // plate shine + rails
    ctx.save();
    ctx.beginPath(); rrect(ctx, 0, plateY, w, plateH, cell * 0.3);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(0, plateY, w, pad * 0.55);
    ctx.fillStyle = 'rgba(20,50,70,0.2)';
    ctx.fillRect(0, plateY + plateH - pad * 0.6, w, pad * 0.6);
    ctx.restore();

    // hover column + ghost disc
    if (this._canDrop() && this.hoverCol >= 0) {
      const c = this.hoverCol;
      const full = this.heights[c] >= ROWS;
      const x = this._cellX(c);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = full ? 'rgba(200,60,50,0.16)' : 'rgba(255,246,227,0.17)';
      ctx.beginPath();
      rrect(ctx, x - cell / 2, plateY + pad * 0.4, cell, plateH - pad * 0.8, cell * 0.22);
      ctx.fill();
      ctx.restore();
      if (!full) {
        const bob = Math.sin(this.clock * 5) * cell * 0.05;
        this._drawDisc(ctx, x, dropH * 0.52 + bob, discR, YOU, 1, 0.62);
        // landing hint
        const r = ROWS - 1 - this.heights[c];
        ctx.save();
        ctx.globalAlpha = 0.34 + Math.sin(this.clock * 6) * 0.12;
        ctx.beginPath(); ctx.arc(x, this._rowY(r), holeR * 0.86, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff6e3';
        ctx.lineWidth = Math.max(2, cell * 0.07);
        ctx.stroke();
        ctx.restore();
      }
    }

    // winning line strobe
    if (this.winLine && this.winLine.length) {
      const pulse = 0.5 + 0.5 * Math.sin(this.winT * 11);
      const col = this.winner === YOU ? '#fff6e3' : '#ffe6ad';
      ctx.save();
      ctx.globalAlpha = 0.35 + pulse * 0.55;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(3, cell * 0.14);
      for (const idx of this.winLine) {
        const r = Math.floor(idx / COLS), c = idx % COLS;
        ctx.beginPath();
        ctx.arc(this._cellX(c), this._rowY(r), holeR * (0.92 + pulse * 0.14), 0, Math.PI * 2);
        ctx.stroke();
      }
      const a0 = this.winLine[0], a1 = this.winLine[this.winLine.length - 1];
      ctx.globalAlpha = 0.25 + pulse * 0.4;
      ctx.lineWidth = Math.max(4, cell * 0.2);
      ctx.beginPath();
      ctx.moveTo(this._cellX(a0 % COLS), this._rowY(Math.floor(a0 / COLS)));
      ctx.lineTo(this._cellX(a1 % COLS), this._rowY(Math.floor(a1 / COLS)));
      ctx.stroke();
      ctx.restore();
    }

    // confetti
    for (const p of this.confetti) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    }
  }
}
