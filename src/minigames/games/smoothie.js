import { Minigame } from '../minigame.js';
import { BODY_COLORS, clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Smoothie Scramble : the Smoothie Shack's order-matching rush.
 *
 * Pure DOM + CSS scene (no WebGL). Capybara customers and the fruit icons are
 * drawn procedurally on small 2D canvases; everything else is CSS art.
 * Score = total payment collected. 3 storm-offs end the run.
 */

// ---------------------------------------------------------------------------
// palette + tiny color helpers
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
function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---------------------------------------------------------------------------
// ingredients
// ---------------------------------------------------------------------------
const ING_IDS = ['mango', 'strawberry', 'banana', 'kiwi', 'blueberry', 'coconut', 'ice'];
const ING = {
  mango: { name: 'Mango', c1: '#ffc14d', c2: '#e8622a', key: '1' },
  strawberry: { name: 'Strawberry', c1: '#ff6b7f', c2: '#c2274a', key: '2' },
  banana: { name: 'Banana', c1: '#ffe25c', c2: '#e0a92a', key: '3' },
  kiwi: { name: 'Kiwi', c1: '#a7de62', c2: '#4e8f2c', key: '4' },
  blueberry: { name: 'Blueberry', c1: '#8a92e8', c2: '#3a3d8f', key: '5' },
  coconut: { name: 'Coconut', c1: '#fdf3e2', c2: '#a97b4f', key: '6' },
  ice: { name: 'Ice', c1: '#e4f7ff', c2: '#79c4e8', key: '7' },
};

const CAPY_NAMES = [
  'Pip', 'Nubbin', 'Waffles', 'Muffin', 'Sprout', 'Tofu', 'Biscuit', 'Pebble',
  'Comet', 'Noodle', 'Barley', 'Juniper', 'Mochi', 'Peanut', 'Clover', 'Sunny',
  'Dumpling', 'Tuffet', 'Marzi', 'Bramble',
];
const HAT_IDS = ['none', 'none', 'beanie', 'cap', 'flower', 'toque', 'bow', 'bandana', 'visor'];
const HAT_COLORS = ['#e8657a', '#4fb3e8', '#7ac74f', '#f2b64a', '#9b6bd4', '#42d6c8', '#fff6e3'];

// ---------------------------------------------------------------------------
// fruit icon art (designed on a 100x100 grid, scaled to any size)
// ---------------------------------------------------------------------------
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
function ink(ctx, w = 4.5) {
  ctx.lineWidth = w; ctx.strokeStyle = OUTLINE; ctx.stroke();
}

function drawIngredient(ctx, id, size) {
  const s = size / 100;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const d = ING[id];

  if (id === 'mango') {
    ctx.save();
    ctx.translate(50, 56); ctx.rotate(-0.22);
    ctx.beginPath(); ctx.ellipse(0, 0, 31, 26, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad(ctx, -28, -24, 24, 26, d.c1, d.c2); ctx.fill(); ink(ctx);
    ctx.beginPath(); ctx.ellipse(-11, -10, 9, 5, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.moveTo(58, 30); ctx.quadraticCurveTo(60, 20, 56, 14);
    ctx.lineWidth = 5; ctx.strokeStyle = '#6f4a24'; ctx.stroke();
    ctx.save(); ctx.translate(70, 20); ctx.rotate(0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 15, 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#6db83e'; ctx.fill(); ink(ctx, 4);
    ctx.restore();
  } else if (id === 'strawberry') {
    ctx.beginPath();
    ctx.moveTo(50, 90);
    ctx.bezierCurveTo(16, 66, 14, 36, 34, 30);
    ctx.bezierCurveTo(44, 26, 56, 26, 66, 30);
    ctx.bezierCurveTo(86, 36, 84, 66, 50, 90);
    ctx.closePath();
    ctx.fillStyle = grad(ctx, 20, 26, 76, 88, d.c1, d.c2); ctx.fill(); ink(ctx);
    ctx.fillStyle = '#ffe9a8';
    for (const [x, y] of [[38, 48], [52, 42], [64, 52], [44, 62], [58, 66], [50, 76]]) {
      ctx.beginPath(); ctx.ellipse(x, y, 3.2, 4.4, 0.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(36, 44, 6, 9, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(50, 32);
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.62;
      ctx.lineTo(50 + Math.cos(a) * 22, 32 + Math.sin(a) * 16);
      ctx.lineTo(50 + Math.cos(a + 0.31) * 8, 32 + Math.sin(a + 0.31) * 6);
    }
    ctx.closePath();
    ctx.fillStyle = '#57a83a'; ctx.fill(); ink(ctx, 3.6);
    ctx.beginPath(); ctx.moveTo(50, 28); ctx.lineTo(50, 14);
    ctx.lineWidth = 5; ctx.strokeStyle = '#4a8c30'; ctx.stroke();
  } else if (id === 'banana') {
    ctx.beginPath();
    ctx.moveTo(22, 24);
    ctx.bezierCurveTo(14, 60, 40, 84, 78, 78);
    ctx.bezierCurveTo(88, 76, 89, 66, 81, 65);
    ctx.bezierCurveTo(48, 63, 36, 48, 34, 24);
    ctx.bezierCurveTo(33, 17, 23, 17, 22, 24);
    ctx.closePath();
    ctx.fillStyle = grad(ctx, 20, 20, 80, 80, d.c1, d.c2); ctx.fill(); ink(ctx);
    ctx.beginPath(); ctx.moveTo(30, 34); ctx.bezierCurveTo(28, 58, 44, 72, 68, 71);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke();
    ctx.fillStyle = '#6f4a24';
    ctx.beginPath(); ctx.ellipse(28, 20, 8, 6, 0, 0, Math.PI * 2); ctx.fill(); ink(ctx, 3.6);
    ctx.beginPath(); ctx.ellipse(84, 71, 6, 5, 0.3, 0, Math.PI * 2); ctx.fill(); ink(ctx, 3.6);
  } else if (id === 'kiwi') {
    ctx.beginPath(); ctx.arc(50, 52, 32, 0, Math.PI * 2);
    ctx.fillStyle = '#8a6134'; ctx.fill(); ink(ctx);
    ctx.beginPath(); ctx.arc(50, 52, 26, 0, Math.PI * 2);
    ctx.fillStyle = grad(ctx, 24, 26, 76, 78, d.c1, d.c2); ctx.fill();
    ctx.beginPath(); ctx.arc(50, 52, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f8e2'; ctx.fill();
    ctx.fillStyle = '#241a10';
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      ctx.save(); ctx.translate(50 + Math.cos(a) * 17, 52 + Math.sin(a) * 17); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 2.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(50, 52, 26, Math.PI * 1.05, Math.PI * 1.45);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.stroke();
  } else if (id === 'blueberry') {
    const berry = (x, y, r) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = grad(ctx, x - r, y - r, x + r, y + r, d.c1, d.c2); ctx.fill(); ink(ctx, 4);
      ctx.beginPath(); ctx.ellipse(x - r * 0.34, y - r * 0.4, r * 0.3, r * 0.18, -0.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fill();
    };
    berry(34, 64, 18); berry(68, 62, 17); berry(51, 38, 20);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      ctx.lineTo(51 + Math.cos(a) * 9, 24 + Math.sin(a) * 7);
      ctx.lineTo(51 + Math.cos(a + 0.52) * 3.5, 24 + Math.sin(a + 0.52) * 3);
    }
    ctx.closePath(); ctx.fillStyle = '#2b2f6b'; ctx.fill();
  } else if (id === 'coconut') {
    ctx.beginPath(); ctx.arc(50, 54, 32, 0, Math.PI * 2);
    ctx.fillStyle = grad(ctx, 22, 24, 78, 84, '#a97b4f', '#6d4526'); ctx.fill(); ink(ctx);
    ctx.beginPath(); ctx.arc(50, 54, 24, 0, Math.PI * 2);
    ctx.fillStyle = '#fdf6e8'; ctx.fill();
    ctx.beginPath(); ctx.arc(50, 54, 24, Math.PI * 0.15, Math.PI * 0.85);
    ctx.lineWidth = 4; ctx.strokeStyle = '#e7d6bb'; ctx.stroke();
    ctx.fillStyle = '#c9b190';
    ctx.beginPath(); ctx.ellipse(42, 46, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(58, 48, 3.4, 2.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3.4; ctx.strokeStyle = '#8a5c33';
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (1.15 + i * 0.14);
      ctx.beginPath();
      ctx.moveTo(50 + Math.cos(a) * 30, 54 + Math.sin(a) * 30);
      ctx.lineTo(50 + Math.cos(a) * 38, 54 + Math.sin(a) * 38);
      ctx.stroke();
    }
  } else if (id === 'ice') {
    ctx.beginPath();
    ctx.moveTo(24, 40); ctx.lineTo(44, 22); ctx.lineTo(80, 22); ctx.lineTo(60, 40);
    ctx.closePath();
    ctx.fillStyle = '#f2fbff'; ctx.fill(); ink(ctx, 4);
    ctx.beginPath();
    ctx.moveTo(60, 40); ctx.lineTo(80, 22); ctx.lineTo(80, 60); ctx.lineTo(60, 78);
    ctx.closePath();
    ctx.fillStyle = '#9ed5ee'; ctx.fill(); ink(ctx, 4);
    rrect(ctx, 24, 40, 36, 38, 6);
    ctx.fillStyle = grad(ctx, 24, 40, 60, 78, d.c1, d.c2); ctx.fill(); ink(ctx, 4);
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.moveTo(32, 52); ctx.lineTo(32, 68); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(40, 50); ctx.lineTo(40, 58); ctx.stroke();
  }
  ctx.restore();
}

function iconCanvas(id, size) {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  c.width = Math.round(size * dpr);
  c.height = Math.round(size * dpr);
  c.style.width = `${size}px`;
  c.style.height = `${size}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawIngredient(ctx, id, size);
  return c;
}

// ---------------------------------------------------------------------------
// capybara customer art (designed on a 200x200 grid)
// ---------------------------------------------------------------------------
function drawHat(ctx, hat, color) {
  if (hat === 'none') return;
  ctx.lineJoin = 'round';
  if (hat === 'beanie') {
    ctx.beginPath(); ctx.arc(100, 40, 56, Math.PI, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    rrect(ctx, 42, 30, 116, 22, 10);
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
    ctx.beginPath(); ctx.moveTo(cx - 6, cy + 18); ctx.quadraticCurveTo(cx - 20, cy + 30, cx - 26, cy + 42);
    ctx.lineWidth = 6; ctx.strokeStyle = '#57a83a'; ctx.stroke();
  } else if (hat === 'toque') {
    rrect(ctx, 56, 22, 88, 22, 8);
    ctx.fillStyle = '#f6efe0'; ctx.fill(); ink(ctx, 5);
    ctx.beginPath();
    ctx.arc(72, 6, 22, 0, Math.PI * 2);
    ctx.arc(100, -6, 26, 0, Math.PI * 2);
    ctx.arc(128, 6, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#fffaf0'; ctx.fill(); ink(ctx, 5);
  } else if (hat === 'bow') {
    const cx = 148, cy = 26;
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx - 30, cy - 16); ctx.lineTo(cx - 30, cy + 16); ctx.closePath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx + 30, cy - 16); ctx.lineTo(cx + 30, cy + 16); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fillStyle = shade(color, 0.3); ctx.fill(); ink(ctx, 4);
  } else if (hat === 'bandana') {
    ctx.beginPath();
    ctx.moveTo(44, 44); ctx.quadraticCurveTo(100, 8, 156, 44);
    ctx.quadraticCurveTo(100, 34, 44, 44); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ink(ctx, 5);
    ctx.beginPath();
    ctx.moveTo(152, 40); ctx.lineTo(178, 30); ctx.lineTo(174, 54); ctx.closePath();
    ctx.fillStyle = shade(color, -0.15); ctx.fill(); ink(ctx, 4);
  } else if (hat === 'visor') {
    ctx.beginPath(); ctx.arc(100, 46, 50, Math.PI * 1.12, Math.PI * 1.88);
    ctx.lineWidth = 16; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(100, 32, 62, 16, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = shade(color, 0.3); ctx.fill(); ink(ctx, 5);
  }
}

/** expr: idle | worried | cross | beam | blink */
function drawCapy(ctx, size, cfg, expr) {
  const s = size / 200;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const body = cfg.color;
  const dark = shade(body, -0.24);
  const muzzle = shade(body, 0.22);

  // shoulders
  rrect(ctx, 50, 148, 100, 62, 30);
  ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);

  // ears
  for (const ex of [46, 154]) {
    ctx.beginPath(); ctx.ellipse(ex, 48, 20, 17, ex < 100 ? 0.3 : -0.3, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(ex, 50, 9, 7, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a3a8'; ctx.fill();
  }

  // head
  rrect(ctx, 38, 36, 124, 104, 42);
  ctx.fillStyle = grad(ctx, 38, 36, 162, 140, shade(body, 0.1), body);
  ctx.fill(); ink(ctx, 5.5);

  // muzzle
  rrect(ctx, 58, 96, 84, 58, 26);
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
  if (expr === 'beam') {
    ctx.beginPath();
    ctx.moveTo(84, 130); ctx.quadraticCurveTo(100, 148, 116, 130); ctx.closePath();
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
    ctx.beginPath(); ctx.ellipse(100, 139, 8, 5, 0, 0, Math.PI); ctx.fillStyle = '#f08fa0'; ctx.fill();
  } else if (expr === 'cross') {
    ctx.beginPath(); ctx.moveTo(86, 136); ctx.quadraticCurveTo(100, 126, 114, 136); ctx.stroke();
  } else if (expr === 'worried') {
    ctx.beginPath();
    ctx.moveTo(86, 132); ctx.quadraticCurveTo(93, 138, 100, 132);
    ctx.quadraticCurveTo(107, 126, 114, 132); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(88, 130); ctx.quadraticCurveTo(100, 140, 112, 130); ctx.stroke();
  }

  // eyes
  const eyes = [70, 130];
  ctx.lineWidth = 5; ctx.strokeStyle = OUTLINE;
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i];
    if (expr === 'beam' || expr === 'blink') {
      ctx.beginPath();
      ctx.moveTo(ex - 11, 78);
      ctx.quadraticCurveTo(ex, expr === 'beam' ? 62 : 88, ex + 11, 78);
      ctx.stroke();
    } else {
      const r = expr === 'worried' ? 8 : 10;
      ctx.beginPath(); ctx.ellipse(ex, 76, r, r + 1.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE; ctx.fill();
      ctx.beginPath(); ctx.arc(ex - 3.4, 72, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      if (expr === 'cross') {
        ctx.lineWidth = 5.5; ctx.strokeStyle = OUTLINE;
        ctx.beginPath();
        ctx.moveTo(ex + (i ? 14 : -14), 54); ctx.lineTo(ex + (i ? -6 : 6), 62);
        ctx.stroke();
      } else if (expr === 'worried') {
        ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
        ctx.beginPath();
        ctx.moveTo(ex + (i ? 12 : -12), 60); ctx.lineTo(ex + (i ? -5 : 5), 56);
        ctx.stroke();
      }
    }
  }

  // blush
  if (expr === 'beam' || expr === 'idle') {
    ctx.fillStyle = 'rgba(232,101,122,0.32)';
    ctx.beginPath(); ctx.ellipse(52, 104, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(148, 104, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  // sweat bead when the patience is running out
  if (expr === 'worried' || expr === 'cross') {
    ctx.beginPath();
    ctx.moveTo(168, 62); ctx.quadraticCurveTo(178, 76, 168, 82);
    ctx.quadraticCurveTo(158, 76, 168, 62); ctx.closePath();
    ctx.fillStyle = '#9ed9f2'; ctx.fill(); ink(ctx, 3.5);
  }

  // paws on the counter
  for (const px of [46, 122]) {
    rrect(ctx, px, 168, 34, 24, 12);
    ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4.5);
    ctx.lineWidth = 3; ctx.strokeStyle = shade(body, -0.35);
    for (let k = 1; k < 3; k++) {
      ctx.beginPath(); ctx.moveTo(px + k * 11, 172); ctx.lineTo(px + k * 11, 182); ctx.stroke();
    }
  }

  drawHat(ctx, cfg.hat, cfg.hatColor);
  ctx.restore();
}

function paintCapy(canvas, cssSize, cfg, expr) {
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const px = Math.round(cssSize * dpr);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  drawCapy(ctx, cssSize, cfg, expr);
}

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------
const STYLE = `
.mg-smoothie-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#3a2a1c;user-select:none;
  -webkit-user-select:none;cursor:default;}
.mg-smoothie-root *{box-sizing:border-box;}
.mg-smoothie-root.mg-smoothie-quake{animation:mg-smoothie-quake .4s ease;}
@keyframes mg-smoothie-quake{
  0%,100%{transform:translate(0,0)}20%{transform:translate(-9px,4px)}
  40%{transform:translate(8px,-5px)}60%{transform:translate(-6px,-3px)}80%{transform:translate(5px,3px)}}

/* ---- backdrop ---- */
.mg-smoothie-wall{position:absolute;inset:0;
  background:
    radial-gradient(ellipse 70% 55% at 50% 30%, rgba(255,255,255,.35), rgba(255,255,255,0) 70%),
    repeating-linear-gradient(90deg, rgba(120,74,32,.10) 0 3px, rgba(0,0,0,0) 3px 104px),
    linear-gradient(180deg,#ffe9c6 0%,#ffd9a5 52%,#f3c188 100%);}
.mg-smoothie-wall::after{content:"";position:absolute;inset:0;
  background:radial-gradient(ellipse 90% 80% at 50% 55%, rgba(0,0,0,0) 55%, rgba(90,50,16,.28) 100%);}
.mg-smoothie-bunting{position:absolute;top:0;left:-2%;width:104%;height:56px;display:flex;
  justify-content:space-around;align-items:flex-start;}
.mg-smoothie-bunting::before{content:"";position:absolute;top:6px;left:0;right:0;height:4px;
  background:#a5702f;border-radius:4px;}
.mg-smoothie-flag{width:30px;height:38px;clip-path:polygon(0 0,100% 0,50% 100%);
  transform-origin:top center;animation:mg-smoothie-sway 3.4s ease-in-out infinite;}
@keyframes mg-smoothie-sway{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
.mg-smoothie-shelf{position:absolute;top:92px;left:5%;width:250px;}
.mg-smoothie-shelfjars{display:flex;align-items:flex-end;gap:14px;padding-left:16px;}
.mg-smoothie-jar{width:36px;border-radius:6px 6px 10px 10px;border:3px solid #8a5a2c;
  background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,.1));position:relative;}
.mg-smoothie-jar span{position:absolute;left:2px;right:2px;bottom:2px;border-radius:4px 4px 7px 7px;}
.mg-smoothie-shelfboard{height:12px;border-radius:4px;background:linear-gradient(180deg,#c98f52,#8a5a2c);
  box-shadow:0 5px 10px rgba(90,50,16,.3);}
.mg-smoothie-board{position:absolute;top:88px;right:5%;width:min(260px,24vw);padding:14px 16px;
  border-radius:12px;border:9px solid #a5702f;background:#2f4636;color:#fff6e3;transform:rotate(-2deg);
  box-shadow:0 10px 20px rgba(60,34,10,.32);}
.mg-smoothie-board h4{font-size:14px;letter-spacing:.14em;color:#ffd98a;margin-bottom:6px;}
.mg-smoothie-board p{font-size:12.5px;line-height:1.65;opacity:.92;font-weight:600;}
.mg-smoothie-bub{position:absolute;bottom:-40px;border-radius:50%;background:rgba(255,255,255,.4);
  animation:mg-smoothie-rise linear infinite;pointer-events:none;}
@keyframes mg-smoothie-rise{from{transform:translateY(0) scale(.6);opacity:0}
  20%{opacity:.7}to{transform:translateY(-92vh) scale(1.1);opacity:0}}

/* ---- hud ---- */
.mg-smoothie-hud{position:relative;z-index:6;display:flex;align-items:center;gap:10px;
  padding:12px 16px;flex-wrap:wrap;}
.mg-smoothie-chip{background:#fffdf6;border-radius:999px;padding:7px 16px;font-weight:900;font-size:15px;
  box-shadow:0 5px 0 rgba(120,74,32,.28),0 8px 16px rgba(60,34,10,.2);display:flex;align-items:center;gap:8px;}
.mg-smoothie-chip small{font-size:11px;letter-spacing:.12em;opacity:.55;font-weight:800;}
.mg-smoothie-score b{color:#e8657a;font-size:19px;min-width:34px;display:inline-block;text-align:right;}
.mg-smoothie-score.mg-smoothie-bump{animation:mg-smoothie-bump .3s ease;}
@keyframes mg-smoothie-bump{50%{transform:scale(1.16) rotate(-2deg)}}
.mg-smoothie-streak b{color:#f2b64a;}
.mg-smoothie-streak.mg-smoothie-hot{background:#f2b64a;color:#fff;}
.mg-smoothie-streak.mg-smoothie-hot b,.mg-smoothie-streak.mg-smoothie-hot small{color:#fff;opacity:.9;}
.mg-smoothie-lives{display:flex;gap:6px;align-items:center;}
.mg-smoothie-life{width:19px;height:23px;background:#e8657a;
  clip-path:polygon(14% 0,86% 0,72% 100%,28% 100%);transition:.25s;}
.mg-smoothie-life.mg-smoothie-out{background:#c9bba6;transform:rotate(24deg) scale(.8);opacity:.65;}
.mg-smoothie-rush{background:linear-gradient(90deg,#e8657a,#f2b64a);color:#fff;letter-spacing:.1em;
  opacity:0;transform:translateY(-8px) scale(.9);transition:.22s;}
.mg-smoothie-rush.mg-smoothie-on{opacity:1;transform:none;animation:mg-smoothie-pulse .7s ease-in-out infinite;}
@keyframes mg-smoothie-pulse{50%{transform:scale(1.07)}}
.mg-smoothie-spacer{flex:1;}
.mg-smoothie-quit{border:0;background:rgba(58,42,28,.72);color:#fff6e3;font-family:inherit;font-weight:900;
  font-size:13px;letter-spacing:.1em;padding:9px 18px;border-radius:999px;cursor:pointer;transition:.14s;}
.mg-smoothie-quit:hover{background:#c94a3e;transform:scale(1.06);}

/* ---- scene ---- */
.mg-smoothie-scene{position:relative;flex:1;min-height:0;z-index:4;}
.mg-smoothie-counter{position:absolute;left:0;right:0;bottom:0;height:clamp(70px,12vh,104px);z-index:3;
  background:linear-gradient(180deg,#d59a5c 0%,#c2833f 16%,#a76a31 60%,#8d5525 100%);
  border-top:7px solid #edc189;box-shadow:0 -8px 22px rgba(60,34,10,.3);}
.mg-smoothie-counter::before{content:"";position:absolute;inset:7px 0 auto 0;height:16px;
  background:linear-gradient(180deg,rgba(255,255,255,.4),rgba(255,255,255,0));}
.mg-smoothie-counter::after{content:"";position:absolute;left:0;right:0;bottom:0;height:44%;
  background:repeating-linear-gradient(90deg,rgba(60,34,10,.16) 0 3px,rgba(0,0,0,0) 3px 88px);}

.mg-smoothie-queue{position:absolute;left:2%;bottom:calc(clamp(70px,12vh,104px) - 14px);z-index:2;
  display:flex;align-items:flex-end;opacity:.92;}
.mg-smoothie-queue canvas + canvas{margin-left:-16px;}
.mg-smoothie-queue canvas{filter:brightness(.86) saturate(.9);animation:mg-smoothie-idle 2.6s ease-in-out infinite;}
.mg-smoothie-queue canvas:nth-child(2){animation-delay:.5s}
.mg-smoothie-queue canvas:nth-child(3){animation-delay:1s}

.mg-smoothie-cust{position:absolute;left:34%;bottom:calc(clamp(70px,12vh,104px) - 22px);z-index:4;
  transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;}
.mg-smoothie-face{animation:mg-smoothie-idle 2.4s ease-in-out infinite;display:block;}
@keyframes mg-smoothie-idle{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-6px) rotate(1deg)}}
.mg-smoothie-cust.mg-smoothie-arrive{animation:mg-smoothie-arrive .46s cubic-bezier(.2,1.5,.5,1);}
@keyframes mg-smoothie-arrive{from{transform:translateX(-260%) rotate(-8deg)}to{transform:translateX(-50%)}}
.mg-smoothie-cust.mg-smoothie-leave{animation:mg-smoothie-leave .5s ease-in forwards;}
@keyframes mg-smoothie-leave{to{transform:translateX(240%) rotate(10deg);opacity:0}}
.mg-smoothie-cust.mg-smoothie-storm{animation:mg-smoothie-storm .6s ease-in forwards;}
@keyframes mg-smoothie-storm{0%{transform:translateX(-50%)}
  18%{transform:translateX(-40%) rotate(6deg)}36%{transform:translateX(-62%) rotate(-6deg)}
  to{transform:translateX(-360%) rotate(-14deg);opacity:0}}
.mg-smoothie-nametag{margin-top:-14px;background:#fffdf6;border-radius:999px;padding:3px 14px;
  font-size:12.5px;font-weight:900;letter-spacing:.04em;box-shadow:0 4px 10px rgba(60,34,10,.28);
  position:relative;z-index:5;}

.mg-smoothie-bubble{position:relative;background:#fffdf6;border-radius:22px;padding:10px 14px 12px;
  box-shadow:0 8px 20px rgba(60,34,10,.28);margin-bottom:14px;}
.mg-smoothie-bubble::after{content:"";position:absolute;bottom:-13px;left:50%;margin-left:-11px;
  border:11px solid transparent;border-top-color:#fffdf6;border-bottom:0;}
.mg-smoothie-bubble.mg-smoothie-pop{animation:mg-smoothie-bpop .34s cubic-bezier(.2,1.6,.4,1);}
@keyframes mg-smoothie-bpop{from{transform:scale(.4);opacity:0}}
.mg-smoothie-order{display:flex;gap:7px;justify-content:center;}
.mg-smoothie-slot{position:relative;width:50px;height:50px;
  border-radius:14px;background:#fff2d8;display:flex;align-items:center;justify-content:center;
  box-shadow:inset 0 -3px 0 rgba(120,74,32,.16);transition:.18s;}
.mg-smoothie-slot.mg-smoothie-done{background:#c9edb0;}
.mg-smoothie-slot.mg-smoothie-done canvas{opacity:.4;}
.mg-smoothie-slot.mg-smoothie-done::after{content:"";position:absolute;left:20px;top:9px;
  width:11px;height:21px;
  border:5px solid #3f8f2c;border-top:0;border-left:0;transform:rotate(42deg);
  animation:mg-smoothie-tick .24s ease;}
@keyframes mg-smoothie-tick{from{transform:rotate(42deg) scale(0);opacity:0}}
.mg-smoothie-pat{width:78%;height:14px;border-radius:999px;background:rgba(58,42,28,.28);
  overflow:hidden;margin-bottom:8px;box-shadow:inset 0 2px 4px rgba(0,0,0,.2);}
.mg-smoothie-pat i{display:block;height:100%;width:100%;border-radius:999px;background:#7ac74f;
  transition:background .3s;}
.mg-smoothie-pat.mg-smoothie-panic{animation:mg-smoothie-panic .4s ease-in-out infinite;}
@keyframes mg-smoothie-panic{50%{transform:scale(1.06)}}

/* ---- blender ---- */
.mg-smoothie-station{position:absolute;right:12%;bottom:calc(clamp(70px,12vh,104px) - 10px);z-index:4;
  display:flex;flex-direction:column;align-items:center;gap:12px;}
.mg-smoothie-blender{position:relative;width:clamp(96px,11vw,132px);transform-origin:bottom center;}
.mg-smoothie-blender.mg-smoothie-rattle{animation:mg-smoothie-rattle .09s linear 5;}
@keyframes mg-smoothie-rattle{0%,100%{transform:translate(0,0) rotate(0)}
  25%{transform:translate(-4px,1px) rotate(-2deg)}75%{transform:translate(4px,-1px) rotate(2deg)}}
.mg-smoothie-blender.mg-smoothie-nope{animation:mg-smoothie-nope .4s ease;}
@keyframes mg-smoothie-nope{0%,100%{transform:translateX(0)}
  15%{transform:translateX(-12px) rotate(-3deg)}45%{transform:translateX(11px) rotate(3deg)}
  75%{transform:translateX(-6px)}}
.mg-smoothie-lid{height:14px;border-radius:8px 8px 4px 4px;border:4px solid #3a2a1c;
  background:linear-gradient(180deg,#fff,#d9e7ee);margin:0 6px;}
.mg-smoothie-lid::after{content:"";display:block;width:24px;height:8px;margin:-12px auto 0;
  border-radius:6px;background:#b9cdd8;border:3px solid #3a2a1c;}
.mg-smoothie-jarbody{position:relative;height:clamp(104px,15vh,146px);border:5px solid #3a2a1c;
  border-radius:10px 10px 22px 22px;overflow:hidden;
  background:linear-gradient(115deg,rgba(255,255,255,.62),rgba(206,232,244,.42) 45%,rgba(255,255,255,.28));
  box-shadow:inset 0 0 22px rgba(255,255,255,.7);}
.mg-smoothie-jarbody::after{content:"";position:absolute;top:8px;left:10px;width:12px;bottom:22px;
  border-radius:8px;background:rgba(255,255,255,.55);}
.mg-smoothie-fill{position:absolute;left:0;right:0;bottom:0;height:0;transition:height .3s ease,background .3s;
  background:#cfe6f2;}
.mg-smoothie-fill::before{content:"";position:absolute;top:-6px;left:0;right:0;height:12px;border-radius:50%;
  background:inherit;filter:brightness(1.12);}
.mg-smoothie-chunks{position:absolute;inset:auto 4px 6px 4px;display:flex;flex-wrap:wrap-reverse;
  justify-content:center;align-items:flex-end;gap:2px;}
.mg-smoothie-chunk{animation:mg-smoothie-drop .42s cubic-bezier(.3,1.6,.5,1);}
@keyframes mg-smoothie-drop{0%{transform:translateY(-130px) rotate(-140deg) scale(.6);opacity:0}
  60%{opacity:1}80%{transform:translateY(6px) scale(1.1,.86)}100%{transform:none}}
.mg-smoothie-base{height:clamp(26px,4vh,36px);border:5px solid #3a2a1c;border-top:0;
  border-radius:0 0 16px 16px;background:linear-gradient(180deg,#7fc0e0,#3f8fbb);
  display:flex;align-items:center;justify-content:center;gap:6px;}
.mg-smoothie-base i{width:9px;height:9px;border-radius:50%;background:#fff6e3;box-shadow:0 0 0 2px rgba(0,0,0,.25);}
.mg-smoothie-base i.mg-smoothie-lit{background:#f2b64a;animation:mg-smoothie-pulse .28s linear infinite;}
.mg-smoothie-blendbtn{border:5px solid #fff;border-radius:999px;background:#b9ae9c;color:#fff;
  font-family:inherit;font-weight:900;font-size:clamp(15px,1.8vw,21px);letter-spacing:.12em;
  padding:11px clamp(20px,3vw,38px);cursor:not-allowed;box-shadow:0 7px 0 rgba(60,34,10,.32);transition:.14s;}
.mg-smoothie-blendbtn.mg-smoothie-ready{background:#e8657a;cursor:pointer;
  animation:mg-smoothie-glow 1s ease-in-out infinite;}
@keyframes mg-smoothie-glow{0%,100%{box-shadow:0 7px 0 rgba(60,34,10,.32),0 0 0 0 rgba(232,101,122,.55)}
  60%{box-shadow:0 7px 0 rgba(60,34,10,.32),0 0 0 16px rgba(232,101,122,0)}}
.mg-smoothie-blendbtn.mg-smoothie-ready:active{transform:translateY(5px);box-shadow:0 2px 0 rgba(60,34,10,.32);}

/* ---- travelling cup ---- */
.mg-smoothie-cup{position:absolute;z-index:5;width:52px;bottom:calc(clamp(70px,12vh,104px) - 4px);
  opacity:0;pointer-events:none;transition:left .38s cubic-bezier(.4,0,.3,1),opacity .18s;}
.mg-smoothie-cup.mg-smoothie-show{opacity:1;}
.mg-smoothie-cupbody{position:relative;height:66px;border:4px solid #3a2a1c;border-radius:4px 4px 14px 14px;
  background:rgba(255,255,255,.72);overflow:hidden;clip-path:polygon(6% 0,94% 0,84% 100%,16% 100%);}
.mg-smoothie-cupfill{position:absolute;left:0;right:0;bottom:0;height:0;transition:height .3s ease;}
.mg-smoothie-straw{position:absolute;top:-22px;left:52%;width:9px;height:34px;border-radius:4px;
  background:#e8657a;transform:rotate(13deg);border:3px solid #3a2a1c;}
.mg-smoothie-cuplid{position:absolute;top:-8px;left:-4px;right:-4px;height:11px;border-radius:6px;
  border:4px solid #3a2a1c;background:#fff6e3;}

/* ---- rack ---- */
.mg-smoothie-rack{position:relative;z-index:6;display:flex;align-items:center;justify-content:center;
  gap:clamp(6px,1.1vw,16px);padding:clamp(10px,1.6vh,18px);
  height:clamp(126px,19vh,182px);border-top:7px solid #b8813e;
  background:linear-gradient(180deg,#8a5a2c,#5f3c1c);}
.mg-smoothie-rack::before{content:"";position:absolute;inset:0;
  background:repeating-linear-gradient(90deg,rgba(0,0,0,.14) 0 3px,rgba(0,0,0,0) 3px 74px);pointer-events:none;}
.mg-smoothie-ing{position:relative;border:0;border-radius:20px;cursor:pointer;font-family:inherit;
  width:clamp(72px,9.4vw,112px);height:clamp(84px,12.4vh,124px);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  background:linear-gradient(180deg,#fffdf6,#ffe9c4);
  box-shadow:0 7px 0 #a5702f,0 12px 18px rgba(30,16,4,.4);transition:transform .09s,box-shadow .09s;}
.mg-smoothie-ing canvas{pointer-events:none;}
.mg-smoothie-ing span{font-size:clamp(9px,1vw,12px);font-weight:900;letter-spacing:.05em;opacity:.75;
  pointer-events:none;}
.mg-smoothie-ing b{position:absolute;top:5px;left:7px;font-size:10px;opacity:.4;pointer-events:none;}
.mg-smoothie-ing:hover{transform:translateY(-3px);}
.mg-smoothie-ing.mg-smoothie-press{transform:translateY(7px);box-shadow:0 0 0 #a5702f,0 4px 8px rgba(30,16,4,.4);}
.mg-smoothie-ing:disabled{filter:grayscale(.6) brightness(.9);cursor:default;}

/* ---- fx ---- */
.mg-smoothie-fx{position:absolute;inset:0;z-index:8;pointer-events:none;overflow:hidden;}
.mg-smoothie-float{position:absolute;transform:translate(-50%,-50%);font-weight:900;white-space:nowrap;
  animation:mg-smoothie-float 1.05s ease-out forwards;text-shadow:0 3px 0 rgba(60,34,10,.35);}
@keyframes mg-smoothie-float{0%{opacity:0;transform:translate(-50%,-30%) scale(.5)}
  25%{opacity:1;transform:translate(-50%,-60%) scale(1.15)}
  50%{transform:translate(-50%,-70%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-155%) scale(.95)}}
.mg-smoothie-float.mg-smoothie-tip{color:#ffe08a;font-size:clamp(24px,3.2vw,40px);}
.mg-smoothie-float.mg-smoothie-combo{color:#fff;font-size:clamp(15px,1.8vw,22px);letter-spacing:.1em;}
.mg-smoothie-float.mg-smoothie-bad{color:#ff8f80;font-size:clamp(17px,2.2vw,26px);}
.mg-smoothie-splat{position:absolute;width:14px;height:14px;border-radius:50%;transform:translate(-50%,-50%);
  animation:mg-smoothie-splat .6s ease-out forwards;}
@keyframes mg-smoothie-splat{to{opacity:0;transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) scale(.3)}}
.mg-smoothie-tint{position:absolute;inset:0;z-index:7;pointer-events:none;opacity:0;transition:opacity .3s;
  background:radial-gradient(ellipse 80% 70% at 50% 60%,rgba(242,182,74,0) 40%,rgba(232,101,122,.42) 100%);}
.mg-smoothie-tint.mg-smoothie-on{opacity:1;}

/* ---- overlays ---- */
.mg-smoothie-over{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;
  background:rgba(38,24,12,.72);backdrop-filter:blur(3px);padding:20px;text-align:center;}
.mg-smoothie-over.mg-smoothie-gone{display:none;}
.mg-smoothie-card{background:linear-gradient(180deg,#fffdf6,#ffeed2);border-radius:28px;padding:26px 30px;
  width:min(560px,94vw);box-shadow:0 18px 50px rgba(0,0,0,.45);animation:mg-smoothie-card .32s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-smoothie-card{from{transform:scale(.82) translateY(20px);opacity:0}}
.mg-smoothie-card h1{font-size:clamp(30px,4.6vw,46px);color:#e8657a;letter-spacing:.02em;line-height:1.05;}
.mg-smoothie-card h2{font-size:clamp(24px,3.4vw,34px);color:#e8657a;}
.mg-smoothie-card .mg-smoothie-sub{font-weight:800;color:#9a8461;font-size:14px;margin:4px 0 16px;
  letter-spacing:.05em;}
.mg-smoothie-how{display:flex;flex-direction:column;gap:9px;text-align:left;margin-bottom:18px;}
.mg-smoothie-how div{display:flex;align-items:center;gap:12px;background:#fff6e3;border-radius:14px;
  padding:9px 14px;font-size:13.5px;font-weight:700;line-height:1.35;}
.mg-smoothie-how i{flex:none;width:30px;height:30px;border-radius:50%;background:#e8657a;color:#fff;
  font-style:normal;font-weight:900;font-size:14px;display:flex;align-items:center;justify-content:center;}
.mg-smoothie-icons{display:flex;justify-content:center;gap:6px;margin:2px 0 14px;flex-wrap:wrap;}
.mg-smoothie-icons canvas{animation:mg-smoothie-bobicon 2.2s ease-in-out infinite;}
.mg-smoothie-icons canvas:nth-child(2n){animation-delay:.3s}
.mg-smoothie-icons canvas:nth-child(3n){animation-delay:.6s}
@keyframes mg-smoothie-bobicon{50%{transform:translateY(-7px) rotate(6deg)}}
.mg-smoothie-stats{display:flex;justify-content:center;gap:10px;margin:16px 0 18px;flex-wrap:wrap;}
.mg-smoothie-stat{background:#fff6e3;border-radius:18px;padding:12px 20px;min-width:112px;}
.mg-smoothie-stat b{display:block;font-size:clamp(24px,3.2vw,34px);color:#3a2a1c;line-height:1.1;}
.mg-smoothie-stat span{font-size:11px;font-weight:900;letter-spacing:.14em;color:#9a8461;}
.mg-smoothie-stat.mg-smoothie-gold b{color:#e0982a;}
.mg-smoothie-ribbon{display:inline-block;background:#f2b64a;color:#fff;font-weight:900;letter-spacing:.14em;
  font-size:12px;padding:6px 18px;border-radius:999px;margin-bottom:6px;
  animation:mg-smoothie-pulse .8s ease-in-out infinite;}
.mg-smoothie-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.mg-smoothie-btn{border:4px solid #fff;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(14px,1.7vw,18px);padding:12px 28px;cursor:pointer;
  box-shadow:0 7px 0 rgba(60,34,10,.28);transition:.12s;}
.mg-smoothie-btn:hover{transform:translateY(-2px);}
.mg-smoothie-btn:active{transform:translateY(5px);box-shadow:0 2px 0 rgba(60,34,10,.28);}
.mg-smoothie-btn.mg-smoothie-alt{background:#4fb3e8;}
.mg-smoothie-btn.mg-smoothie-ghost{background:transparent;border-color:rgba(58,42,28,.3);color:#7a6748;
  box-shadow:none;}
.mg-smoothie-count{font-size:clamp(80px,17vw,180px);font-weight:900;color:#fff6e3;
  text-shadow:0 8px 0 rgba(60,34,10,.35);animation:mg-smoothie-count .62s ease-out;}
@keyframes mg-smoothie-count{from{transform:scale(2.2);opacity:0}40%{opacity:1}to{transform:scale(1)}}
@media (max-height:660px){
  .mg-smoothie-board,.mg-smoothie-shelf{display:none;}
  .mg-smoothie-how div{padding:7px 12px;font-size:12px;}
}
`;

// ---------------------------------------------------------------------------
// the game
// ---------------------------------------------------------------------------
export class SmoothieGame extends Minigame {
  static id = 'smoothie';
  static name = 'Smoothie Scramble';

  constructor(game) {
    super(game);
    this._timers = new Set();
    this._raf = 0;
    this._dead = false;
    this._onKey = null;
    this.phase = 'splash';
    this.el = {};
  }

  // ---- lifecycle ----------------------------------------------------------
  mount(root) {
    super.mount(root);
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-smoothie-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (sel) => wrap.querySelector(sel);
    this.el = {
      wrap,
      score: q('[data-el="score"]'),
      scoreChip: q('[data-el="scoreChip"]'),
      streak: q('[data-el="streak"]'),
      streakChip: q('[data-el="streakChip"]'),
      lives: [...wrap.querySelectorAll('[data-el="life"]')],
      rush: q('[data-el="rush"]'),
      tint: q('[data-el="tint"]'),
      scene: q('[data-el="scene"]'),
      queue: q('[data-el="queue"]'),
      cust: q('[data-el="cust"]'),
      face: q('[data-el="face"]'),
      name: q('[data-el="name"]'),
      bubble: q('[data-el="bubble"]'),
      order: q('[data-el="order"]'),
      pat: q('[data-el="pat"]'),
      patFill: q('[data-el="patFill"]'),
      blender: q('[data-el="blender"]'),
      fill: q('[data-el="fill"]'),
      chunks: q('[data-el="chunks"]'),
      lamps: [...wrap.querySelectorAll('[data-el="lamp"]')],
      blend: q('[data-el="blend"]'),
      cup: q('[data-el="cup"]'),
      cupFill: q('[data-el="cupFill"]'),
      rack: q('[data-el="rack"]'),
      fx: q('[data-el="fx"]'),
      over: q('[data-el="over"]'),
    };

    this._buildBackdrop();
    this._buildRack();
    this.el.blend.addEventListener('click', () => this._blend());
    wrap.querySelector('[data-el="quit"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey);

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
    this._onKey = null;
    this.el = {};
  }

  coinsForScore(score) { return Math.round(score / 3); }

  /** What the player will actually be paid, i.e. what the UI must show. */
  _payout(score) { return clampCoinsForGame('smoothie', this.coinsForScore(score)); }

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
      <div class="mg-smoothie-wall" data-el="wall"></div>
      <div class="mg-smoothie-tint" data-el="tint"></div>

      <div class="mg-smoothie-hud">
        <div class="mg-smoothie-chip mg-smoothie-score" data-el="scoreChip">
          <small>PAID</small><b data-el="score">0</b>
        </div>
        <div class="mg-smoothie-chip mg-smoothie-streak" data-el="streakChip">
          <small>STREAK</small><b data-el="streak">0</b>
        </div>
        <div class="mg-smoothie-chip mg-smoothie-lives">
          <small>PATIENCE</small>
          <span class="mg-smoothie-life" data-el="life"></span>
          <span class="mg-smoothie-life" data-el="life"></span>
          <span class="mg-smoothie-life" data-el="life"></span>
        </div>
        <div class="mg-smoothie-chip mg-smoothie-rush" data-el="rush">RUSH HOUR</div>
        <div class="mg-smoothie-spacer"></div>
        <button class="mg-smoothie-quit" data-el="quit">QUIT</button>
      </div>

      <div class="mg-smoothie-scene" data-el="scene">
        <div class="mg-smoothie-queue" data-el="queue"></div>

        <div class="mg-smoothie-cust" data-el="cust">
          <div class="mg-smoothie-bubble" data-el="bubble">
            <div class="mg-smoothie-order" data-el="order"></div>
          </div>
          <div class="mg-smoothie-pat" data-el="pat"><i data-el="patFill"></i></div>
          <canvas class="mg-smoothie-face" data-el="face"></canvas>
          <div class="mg-smoothie-nametag" data-el="name">Pip</div>
        </div>

        <div class="mg-smoothie-cup" data-el="cup">
          <div class="mg-smoothie-straw"></div>
          <div class="mg-smoothie-cupbody"><div class="mg-smoothie-cupfill" data-el="cupFill"></div></div>
          <div class="mg-smoothie-cuplid"></div>
        </div>

        <div class="mg-smoothie-station">
          <div class="mg-smoothie-blender" data-el="blender">
            <div class="mg-smoothie-lid"></div>
            <div class="mg-smoothie-jarbody">
              <div class="mg-smoothie-fill" data-el="fill"></div>
              <div class="mg-smoothie-chunks" data-el="chunks"></div>
            </div>
            <div class="mg-smoothie-base">
              <i data-el="lamp"></i><i data-el="lamp"></i><i data-el="lamp"></i>
            </div>
          </div>
          <button class="mg-smoothie-blendbtn" data-el="blend">BLEND</button>
        </div>

        <div class="mg-smoothie-counter"></div>
      </div>

      <div class="mg-smoothie-rack" data-el="rack"></div>
      <div class="mg-smoothie-fx" data-el="fx"></div>
      <div class="mg-smoothie-over" data-el="over"></div>`;
  }

  _buildBackdrop() {
    const wall = this.el.wrap.querySelector('[data-el="wall"]');

    const bunting = document.createElement('div');
    bunting.className = 'mg-smoothie-bunting';
    const flagCols = ['#e8657a', '#f2b64a', '#7ac74f', '#4fb3e8', '#fff6e3'];
    for (let i = 0; i < 14; i++) {
      const f = document.createElement('div');
      f.className = 'mg-smoothie-flag';
      f.style.background = flagCols[i % flagCols.length];
      f.style.animationDelay = `${(i * 0.13).toFixed(2)}s`;
      bunting.appendChild(f);
    }
    wall.appendChild(bunting);

    const shelf = document.createElement('div');
    shelf.className = 'mg-smoothie-shelf';
    const jars = document.createElement('div');
    jars.className = 'mg-smoothie-shelfjars';
    const jarCols = ['#f0566b', '#ffc14d', '#8ed14f', '#8a92e8', '#f6ead6'];
    for (let i = 0; i < 5; i++) {
      const j = document.createElement('div');
      j.className = 'mg-smoothie-jar';
      j.style.height = `${34 + ((i * 7) % 22)}px`;
      const fill = document.createElement('span');
      fill.style.background = jarCols[i];
      fill.style.height = `${40 + ((i * 13) % 40)}%`;
      j.appendChild(fill);
      jars.appendChild(j);
    }
    const board = document.createElement('div');
    board.className = 'mg-smoothie-shelfboard';
    shelf.appendChild(jars);
    shelf.appendChild(board);
    wall.appendChild(shelf);

    const chalk = document.createElement('div');
    chalk.className = 'mg-smoothie-board';
    chalk.innerHTML = `<h4>TODAY'S BLENDS</h4>
      <p>Sunrise Swirl &middot; 12<br>Coco Chill &middot; 14<br>Berry Bramble &middot; 15<br>
      Green Machine &middot; 16<br><em>free straw with every order</em></p>`;
    wall.appendChild(chalk);

    for (let i = 0; i < 7; i++) {
      const b = document.createElement('div');
      b.className = 'mg-smoothie-bub';
      const size = 10 + ((i * 7) % 22);
      b.style.width = `${size}px`;
      b.style.height = `${size}px`;
      b.style.left = `${6 + i * 13}%`;
      b.style.animationDuration = `${9 + (i % 4) * 2.5}s`;
      b.style.animationDelay = `${i * 1.6}s`;
      wall.appendChild(b);
    }
  }

  _buildRack() {
    this.el.btns = {};
    for (const id of ING_IDS) {
      const d = ING[id];
      const b = document.createElement('button');
      b.className = 'mg-smoothie-ing';
      b.type = 'button';
      b.style.background = `linear-gradient(180deg,#fffdf6 0%, ${mixHex(d.c1, '#fff6e3', 0.55)} 100%)`;
      const key = document.createElement('b');
      key.textContent = d.key;
      const label = document.createElement('span');
      label.textContent = d.name.toUpperCase();
      b.appendChild(key);
      b.appendChild(iconCanvas(id, 52));
      b.appendChild(label);
      b.addEventListener('click', () => this._add(id));
      this.el.rack.appendChild(b);
      this.el.btns[id] = b;
    }
  }

  // ---- screens ------------------------------------------------------------
  _showSplash() {
    this.phase = 'splash';
    const best = this.game.state?.bests?.smoothie || 0;
    const over = this.el.over;
    over.classList.remove('mg-smoothie-gone');
    over.innerHTML = `
      <div class="mg-smoothie-card">
        <h1>Smoothie Scramble</h1>
        <div class="mg-smoothie-sub">THE SMOOTHIE SHACK IS SLAMMED. BLEND LIKE YOU MEAN IT.</div>
        <div class="mg-smoothie-icons" data-el="splashIcons"></div>
        <div class="mg-smoothie-how">
          <div><i>1</i><span>Read the order bubble, then tap those fruits into the jar. Keys <b>1</b>&ndash;<b>7</b> work too.</span></div>
          <div><i>2</i><span>A wrong fruit ruins the batch: the jar dumps itself and your streak breaks.</span></div>
          <div><i>3</i><span>Order complete? Slam <b>BLEND</b> (or <b>Space</b>). The faster you serve, the fatter the tip.</span></div>
          <div><i>4</i><span>Three capybaras stomping off in a huff and the shack closes early.</span></div>
        </div>
        <div class="mg-smoothie-stats">
          <div class="mg-smoothie-stat"><b>${best}</b><span>YOUR BEST</span></div>
          <div class="mg-smoothie-stat mg-smoothie-gold"><b>${this._payout(best)}</b><span>COINS THEN</span></div>
        </div>
        <div class="mg-smoothie-btns">
          <button class="mg-smoothie-btn" data-a="play">START BLENDING</button>
          <button class="mg-smoothie-btn mg-smoothie-ghost" data-a="leave">Back to the shack</button>
        </div>
      </div>`;
    const icons = over.querySelector('[data-el="splashIcons"]');
    for (const id of ING_IDS) icons.appendChild(iconCanvas(id, 40));
    over.querySelector('[data-a="play"]').addEventListener('click', () => this._countdown());
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
  }

  _countdown() {
    if (this.phase !== 'splash' && this.phase !== 'over') return;
    this.game.audio?.play?.('click');
    this._resetRun();
    this.phase = 'countdown';
    const over = this.el.over;
    const steps = ['3', '2', '1', 'BLEND!'];
    const show = (i) => {
      if (i >= steps.length) {
        over.classList.add('mg-smoothie-gone');
        over.innerHTML = '';
        this.phase = 'play';
        this._nextCustomer(true);
        return;
      }
      over.innerHTML = `<div class="mg-smoothie-count">${steps[i]}</div>`;
      this.game.audio?.play?.(i === steps.length - 1 ? 'success' : 'ding');
      this._after(i === steps.length - 1 ? 480 : 620, () => show(i + 1));
    };
    show(0);
  }

  _results() {
    this.phase = 'over';
    const score = Math.round(this.score);
    const prevBest = this.game.state?.bests?.smoothie || 0;
    const isBest = score > prevBest;
    const coins = this._payout(score); // the cap is what the purse actually gets
    this.finish(score);
    const shown = Math.max(prevBest, score);
    this.game.audio?.play?.(isBest ? 'success' : 'ding');

    const over = this.el.over;
    over.classList.remove('mg-smoothie-gone');
    over.innerHTML = `
      <div class="mg-smoothie-card">
        ${isBest ? '<div class="mg-smoothie-ribbon">NEW SHACK RECORD</div>' : ''}
        <h2>Shift over!</h2>
        <div class="mg-smoothie-sub">${this._verdict(score)}</div>
        <div class="mg-smoothie-stats">
          <div class="mg-smoothie-stat"><b>${score}</b><span>PAID OUT</span></div>
          <div class="mg-smoothie-stat mg-smoothie-gold"><b>${coins}</b><span>COINS</span></div>
          <div class="mg-smoothie-stat"><b>${shown}</b><span>BEST</span></div>
        </div>
        <div class="mg-smoothie-stats">
          <div class="mg-smoothie-stat"><b>${this.served}</b><span>SERVED</span></div>
          <div class="mg-smoothie-stat"><b>${this.bestStreak}</b><span>TOP STREAK</span></div>
        </div>
        <div class="mg-smoothie-btns">
          <button class="mg-smoothie-btn" data-a="again">Play again</button>
          <button class="mg-smoothie-btn mg-smoothie-alt" data-a="leave">Back to the shack</button>
        </div>
      </div>`;
    over.querySelector('[data-a="again"]').addEventListener('click', () => {
      this._done = false; // allow the next run to report its own score
      this._countdown();
    });
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  _verdict(score) {
    if (score >= 260) return 'THE REGULARS ARE ALREADY TELLING THEIR FRIENDS.';
    if (score >= 170) return 'SMOOTH. THE TIP JAR IS RATTLING.';
    if (score >= 90) return 'SOLID SHIFT. A FEW GRUMPY CAPYS, BUT SOLID.';
    return 'ROUGH ONE. THE BLENDER FORGIVES YOU. THE CUSTOMERS DO NOT.';
  }

  // ---- run state ----------------------------------------------------------
  _resetRun() {
    this.score = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.served = 0;
    this.strikes = 0;
    this.rushUntil = 0;
    this.patience = 1;
    this.filled = [];
    this.cust = null;
    this.queue = [this._makeCapy(), this._makeCapy(), this._makeCapy()];
    this.blinkAt = 0;
    this.expr = 'idle';
    this.lastFrame = 0;

    this.el.score.textContent = '0';
    this.el.streak.textContent = '0';
    this.el.streakChip.classList.remove('mg-smoothie-hot');
    for (const l of this.el.lives) l.classList.remove('mg-smoothie-out');
    this.el.rush.classList.remove('mg-smoothie-on');
    this.el.tint.classList.remove('mg-smoothie-on');
    this.el.cust.classList.remove('mg-smoothie-leave', 'mg-smoothie-storm');
    this.el.cust.style.visibility = 'hidden';
    this.el.fx.innerHTML = '';
    this._clearJar();
  }

  _makeCapy() {
    return {
      color: hexOf(pick(BODY_COLORS)),
      hat: pick(HAT_IDS),
      hatColor: pick(HAT_COLORS),
      name: pick(CAPY_NAMES),
    };
  }

  _orderLength() {
    const cap = Math.min(5, 2 + Math.floor(this.served / 3));
    const floorLen = Math.min(cap, 2 + Math.floor(this.served / 6));
    return rint(floorLen, cap);
  }

  _patienceMs() {
    return Math.max(4000, 9800 - this.served * 420);
  }

  get _rushing() { return performance.now() < this.rushUntil; }

  // ---- customers ----------------------------------------------------------
  _nextCustomer(first = false) {
    if (this.phase !== 'play') return;
    this.cust = this.queue.shift();
    this.queue.push(this._makeCapy());
    const len = this._orderLength();
    this.cust.order = Array.from({ length: len }, () => pick(ING_IDS));
    this.cust.patMs = this._patienceMs();
    this.patience = 1;
    this.filled = [];
    this.expr = 'idle';

    this.el.name.textContent = this.cust.name;
    this.el.cust.style.visibility = 'visible';
    this.el.cust.classList.remove('mg-smoothie-leave', 'mg-smoothie-storm', 'mg-smoothie-arrive');
    void this.el.cust.offsetWidth;
    this.el.cust.classList.add('mg-smoothie-arrive');
    this.el.bubble.classList.remove('mg-smoothie-pop');
    void this.el.bubble.offsetWidth;
    this.el.bubble.classList.add('mg-smoothie-pop');

    this._paintCustomer();
    this._paintQueue();
    this._paintOrder();
    this._clearJar();
    this._updatePatience(true);
    if (!first) this.game.audio?.play?.('pop');
    this.blinkAt = performance.now() + 1500 + Math.random() * 2500;
  }

  _paintCustomer() {
    if (!this.cust) return;
    const size = Math.max(140, Math.min(250, Math.round(this.el.scene.clientHeight * 0.46)));
    this.el.face.style.width = `${size}px`;
    this.el.face.style.height = `${size}px`;
    paintCapy(this.el.face, size, this.cust, this.expr);
  }

  _paintQueue() {
    const q = this.el.queue;
    q.innerHTML = '';
    const size = Math.max(58, Math.min(92, Math.round(this.el.scene.clientHeight * 0.2)));
    for (const c of this.queue) {
      const cv = document.createElement('canvas');
      cv.style.width = `${size}px`;
      cv.style.height = `${size}px`;
      paintCapy(cv, size, c, 'idle');
      q.appendChild(cv);
    }
  }

  _paintOrder() {
    const o = this.el.order;
    o.innerHTML = '';
    this.cust.order.forEach((id) => {
      const slot = document.createElement('div');
      slot.className = 'mg-smoothie-slot';
      slot.appendChild(iconCanvas(id, 38));
      o.appendChild(slot);
    });
    this._syncOrderMarks();
  }

  /** Mark one slot per filled ingredient (multiset match, any order). */
  _syncOrderMarks() {
    const slots = [...this.el.order.children];
    for (const s of slots) s.classList.remove('mg-smoothie-done');
    const left = this.filled.slice();
    this.cust.order.forEach((id, i) => {
      const k = left.indexOf(id);
      if (k >= 0) { left.splice(k, 1); slots[i]?.classList.add('mg-smoothie-done'); }
    });
  }

  _remaining() {
    const left = this.cust.order.slice();
    for (const f of this.filled) {
      const k = left.indexOf(f);
      if (k >= 0) left.splice(k, 1);
    }
    return left;
  }

  // ---- jar ----------------------------------------------------------------
  _clearJar() {
    this.filled = [];
    if (!this.el.chunks) return;
    this.el.chunks.innerHTML = '';
    this.el.fill.style.height = '0px';
    this._syncBlendBtn();
  }

  _blendColor() {
    if (!this.filled.length) return '#cfe6f2';
    let c = ING[this.filled[0]].c1;
    for (let i = 1; i < this.filled.length; i++) c = mixHex(c, ING[this.filled[i]].c1, 1 / (i + 1));
    return c;
  }

  _syncBlendBtn() {
    const ready = this.phase === 'play' && this.cust && this.filled.length === this.cust.order.length;
    this.el.blend.classList.toggle('mg-smoothie-ready', !!ready);
    for (const l of this.el.lamps) l.classList.toggle('mg-smoothie-lit', !!ready);
  }

  _add(id) {
    if (this.phase !== 'play' || !this.cust) return;
    const btn = this.el.btns[id];
    btn.classList.remove('mg-smoothie-press');
    void btn.offsetWidth;
    btn.classList.add('mg-smoothie-press');
    this._after(120, () => btn.classList.remove('mg-smoothie-press'));

    if (!this._remaining().includes(id)) {
      this._wrong(id);
      return;
    }
    this.filled.push(id);
    const chunk = document.createElement('div');
    chunk.className = 'mg-smoothie-chunk';
    chunk.style.transform = `rotate(${rint(-16, 16)}deg)`;
    chunk.appendChild(iconCanvas(id, 26));
    this.el.chunks.appendChild(chunk);
    this.el.fill.style.background = this._blendColor();
    this.el.fill.style.height = `${10 + this.filled.length * 9}px`;
    this.game.audio?.play?.('pop');
    this._syncOrderMarks();
    this._syncBlendBtn();
  }

  _wrong(id) {
    this.game.audio?.play?.('fail');
    this.streak = 0;
    this._syncStreak();
    const b = this.el.blender;
    b.classList.remove('mg-smoothie-nope');
    void b.offsetWidth;
    b.classList.add('mg-smoothie-nope');
    const p = this._pointOf(this.el.blender);
    this._splatter(ING[id].c2, p);
    this._float('NOPE!', p.x, p.y - 40, 'mg-smoothie-bad');
    this._clearJar();
    this.patience = Math.max(0.02, this.patience - 0.06);
  }

  _dump() {
    if (this.phase !== 'play' || !this.filled.length) return;
    this.game.audio?.play?.('whoosh');
    this._clearJar();
    this._syncOrderMarks();
  }

  // ---- serving ------------------------------------------------------------
  _blend() {
    if (this.phase !== 'play' || !this.cust) return;
    if (this.filled.length !== this.cust.order.length) {
      this.game.audio?.play?.('click');
      const b = this.el.blender;
      b.classList.remove('mg-smoothie-nope');
      void b.offsetWidth;
      b.classList.add('mg-smoothie-nope');
      return;
    }
    this.phase = 'serve';
    this._syncBlendBtn();
    this.game.audio?.play?.('whoosh');

    const b = this.el.blender;
    b.classList.remove('mg-smoothie-rattle');
    void b.offsetWidth;
    b.classList.add('mg-smoothie-rattle');
    const smoothie = this.cust.color;
    this.el.fill.style.background = smoothie;
    this.el.fill.style.height = `${18 + this.filled.length * 9}px`;
    for (const c of this.el.chunks.children) c.style.transition = 'opacity .3s';
    this._after(180, () => { if (this.el.chunks) this.el.chunks.style.opacity = '0'; });

    this._after(430, () => this._pour(smoothie));
  }

  _pour(color) {
    this.game.audio?.play?.('splash');
    const sceneRect = this.el.scene.getBoundingClientRect();
    const bRect = this.el.blender.getBoundingClientRect();
    const cRect = this.el.cust.getBoundingClientRect();
    const cup = this.el.cup;
    cup.style.transition = 'none';
    cup.style.left = `${bRect.left - sceneRect.left + bRect.width / 2 - 26}px`;
    void cup.offsetWidth;
    cup.style.transition = 'left .38s cubic-bezier(.4,0,.3,1),opacity .18s';
    cup.classList.add('mg-smoothie-show');
    this.el.cupFill.style.background = color;
    this.el.cupFill.style.height = '0px';
    this.el.fill.style.height = '0px';
    this._after(40, () => { if (this.el.cupFill) this.el.cupFill.style.height = '54px'; });
    this._after(330, () => {
      if (!this.el.cup) return;
      cup.style.left = `${cRect.left - sceneRect.left + cRect.width / 2 - 26}px`;
    });
    this._after(760, () => this._paid());
  }

  _paid() {
    if (!this.cust) return;
    const rush = this._rushing;
    const base = this.cust.order.length * 3;
    const tip = Math.round(this.patience * 10);
    const bonus = Math.min(this.streak, 8);
    let pay = base + tip + bonus;
    if (rush) pay *= 2;

    this.score += pay;
    this.served += 1;
    this.streak += 1;
    this.bestStreak = Math.max(this.bestStreak, this.streak);

    this.expr = 'beam';
    this._paintCustomer();
    this.game.audio?.play?.('coin');

    const p = this._pointOf(this.el.cust);
    this._float(`+${pay}`, p.x, p.y - 30, 'mg-smoothie-tip');
    if (this.streak >= 3) {
      this._float(`STREAK x${this.streak}`, p.x, p.y - 86, 'mg-smoothie-combo');
    }
    if (rush) this._float('RUSH TIP x2', p.x + 90, p.y - 60, 'mg-smoothie-combo');
    this._splatter(this.cust.color, p);

    this.el.score.textContent = String(Math.round(this.score));
    this.el.scoreChip.classList.remove('mg-smoothie-bump');
    void this.el.scoreChip.offsetWidth;
    this.el.scoreChip.classList.add('mg-smoothie-bump');
    this._syncStreak();

    this.el.cup.classList.remove('mg-smoothie-show');
    if (this.el.chunks) { this.el.chunks.style.opacity = ''; this.el.chunks.innerHTML = ''; }
    this.filled = [];

    if (this.served % 5 === 0) this._startRush();

    this._after(520, () => {
      this.el.cust.classList.add('mg-smoothie-leave');
      this.game.audio?.play?.('whoosh');
      this._after(420, () => {
        if (this.strikes >= 3) return;
        this.phase = 'play';
        this._nextCustomer();
      });
    });
  }

  _startRush() {
    this.rushUntil = performance.now() + 11000;
    this.game.audio?.play?.('ding');
    this.el.rush.classList.add('mg-smoothie-on');
    this.el.tint.classList.add('mg-smoothie-on');
    const p = this._pointOf(this.el.scene);
    this._float('RUSH HOUR!', p.x, p.y - 40, 'mg-smoothie-tip');
  }

  _stormOff() {
    if (!this.cust || this.phase !== 'play') return;
    this.phase = 'serve';
    this.strikes += 1;
    this.streak = 0;
    this._syncStreak();
    this.game.audio?.play?.('fail');
    this.expr = 'cross';
    this._paintCustomer();

    const p = this._pointOf(this.el.cust);
    this._float('STOMPED OFF', p.x, p.y - 30, 'mg-smoothie-bad');
    this.el.lives[Math.min(2, this.strikes - 1)]?.classList.add('mg-smoothie-out');
    this.el.wrap.classList.remove('mg-smoothie-quake');
    void this.el.wrap.offsetWidth;
    this.el.wrap.classList.add('mg-smoothie-quake');
    this.el.cust.classList.add('mg-smoothie-storm');
    this._clearJar();

    this._after(620, () => {
      if (this.strikes >= 3) {
        this.el.cust.style.visibility = 'hidden';
        this._results();
      } else {
        this.phase = 'play';
        this._nextCustomer();
      }
    });
  }

  _syncStreak() {
    this.el.streak.textContent = String(this.streak);
    this.el.streakChip.classList.toggle('mg-smoothie-hot', this.streak >= 3);
  }

  // ---- fx -----------------------------------------------------------------
  _pointOf(el) {
    const r = el.getBoundingClientRect();
    const w = this.el.wrap.getBoundingClientRect();
    return { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2 };
  }

  _float(text, x, y, cls) {
    if (!this.el.fx) return;
    const d = document.createElement('div');
    d.className = `mg-smoothie-float ${cls}`;
    d.textContent = text;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    this.el.fx.appendChild(d);
    this._after(1100, () => d.remove());
  }

  _splatter(color, p) {
    if (!this.el.fx) return;
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('div');
      d.className = 'mg-smoothie-splat';
      const a = Math.random() * Math.PI * 2;
      const dist = 40 + Math.random() * 70;
      d.style.setProperty('--dx', `${Math.cos(a) * dist}px`);
      d.style.setProperty('--dy', `${Math.sin(a) * dist - 20}px`);
      d.style.background = color;
      d.style.left = `${p.x}px`;
      d.style.top = `${p.y}px`;
      const s = 6 + Math.random() * 12;
      d.style.width = `${s}px`;
      d.style.height = `${s}px`;
      this.el.fx.appendChild(d);
      this._after(650, () => d.remove());
    }
  }

  // ---- input --------------------------------------------------------------
  _key(e) {
    if (this._dead) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key;
    // the world HUD grabs Enter to focus its chat box; take the keyboard back
    if (k === 'Enter') this._defocus();
    if (this.phase === 'splash' || this.phase === 'over') {
      if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        this.el.over?.querySelector('[data-a="play"],[data-a="again"]')?.click();
      }
      return;
    }
    if (this.phase !== 'play') return;
    const idx = '1234567'.indexOf(k);
    if (idx >= 0) { e.preventDefault(); this._add(ING_IDS[idx]); return; }
    if (k === ' ' || k === 'Enter') { e.preventDefault(); this._blend(); return; }
    if (k === 'Backspace') { e.preventDefault(); this._dump(); }
  }

  _defocus() {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) a.blur();
  }

  // ---- loop ---------------------------------------------------------------
  _updatePatience(force = false) {
    const f = this.el.patFill;
    if (!f) return;
    const p = Math.max(0, Math.min(1, this.patience));
    f.style.width = `${(p * 100).toFixed(1)}%`;
    const col = p > 0.5 ? mixHex('#f2b64a', '#7ac74f', (p - 0.5) * 2)
      : mixHex('#e0483c', '#f2b64a', p * 2);
    f.style.background = col;
    this.el.pat.classList.toggle('mg-smoothie-panic', p < 0.3);
    if (force) return;
    const want = p > 0.55 ? 'idle' : p > 0.28 ? 'worried' : 'cross';
    if (want !== this.expr && this.expr !== 'beam' && this.expr !== 'blink') {
      this.expr = want;
      this._paintCustomer();
    }
  }

  _loop(t) {
    if (this._dead) return;
    this._raf = requestAnimationFrame((n) => this._loop(n));
    const dt = this.lastFrame ? Math.min(0.1, (t - this.lastFrame) / 1000) : 0;
    this.lastFrame = t;
    if (this.phase !== 'play' || !this.cust) return;

    const mult = this._rushing ? 1.7 : 1;
    this.patience -= (dt * 1000 / this.cust.patMs) * mult;
    this._updatePatience();

    if (this.rushUntil && !this._rushing && this.el.rush.classList.contains('mg-smoothie-on')) {
      this.el.rush.classList.remove('mg-smoothie-on');
      this.el.tint.classList.remove('mg-smoothie-on');
    }

    if (t > this.blinkAt && this.expr === 'idle') {
      this.blinkAt = t + 1800 + Math.random() * 2600;
      this.expr = 'blink';
      this._paintCustomer();
      this._after(130, () => {
        if (this.expr === 'blink') { this.expr = 'idle'; this._paintCustomer(); }
      });
    }

    if (this.patience <= 0) this._stormOff();
  }
}
