import { Minigame } from '../minigame.js';
import { MINIGAMES } from '../../../shared/constants.js';

/**
 * Reel Rush : side-view fishing minigame for Capy Cove.
 *
 * Rendering is a hand-drawn 2D canvas scene (no WebGL) because the whole look
 * is flat toon shapes with dark outlines, which reads far cleaner in 2D than as
 * low-poly meshes. Everything is procedural: fish, kelp, coral, boat, capybara.
 *
 * Run: 90 seconds. Mouse Y (or arrow keys) sets the hook depth, touch a fish to
 * reel it in. Jellyfish stun, boots cost points, sharks sweep the lanes.
 */

const TAU = Math.PI * 2;
const RUN_SECONDS = 90;
const COMBO_NEEDED = 5;
const COMBO_TIME = 10;
const STUN_TIME = 1.5;
const SHARK_EVERY = 20;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const easeOut = (t) => 1 - (1 - t) * (1 - t);

// Fish kinds. `speed` is fractions of screen width per second so the crossing
// time feels identical on any window size.
const KINDS = {
  small: { points: 3, r: 12, speed: 0.30, body: '#ff8c5a', fin: '#e8657a', belly: '#ffdcbb', flap: 15, label: 'Sardine', hint: 'small + quick' },
  medium: { points: 2, r: 18, speed: 0.205, body: '#4fb3e8', fin: '#2f86bd', belly: '#dcf3ff', flap: 10, label: 'Bluefin', hint: 'steady swimmer' },
  big: { points: 1, r: 27, speed: 0.125, body: '#7ac74f', fin: '#4d9b39', belly: '#e6f8c8', flap: 6.5, label: 'Grouper', hint: 'big and lazy' },
  golden: { points: 10, r: 10, speed: 0.5, body: '#f2b64a', fin: '#ffdd7a', belly: '#fff4cd', flap: 22, label: 'Golden Minnow', hint: 'rare! tiny + fast' },
};

const OUTLINE = 'rgba(8,34,56,0.55)';

function spawnTable(p) {
  return [
    ['small', 30 + 12 * p],
    ['medium', 26],
    ['big', 15 - 5 * p],
    ['golden', 2 + 3 * p],
    ['jelly', 10 + 9 * p],
    ['boot', 7 + 3 * p],
  ];
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

function drawFishArt(ctx, kind, r, t, phase) {
  const k = KINDS[kind];
  const bw = r * 2.1;
  const bh = r * 1.3;
  const flap = Math.sin(t * k.flap + phase);
  const lw = Math.max(1.2, r * 0.13);

  if (kind === 'golden') {
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.3 * Math.sin(t * 6 + phase);
    ctx.fillStyle = 'rgba(255,220,120,0.5)';
    ctx.beginPath();
    ctx.ellipse(0, 0, bw * 0.95, bh * 1.15, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
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
  if (kind === 'medium') {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.ellipse(i * r * 0.5 - r * 0.1, 0, r * 0.13, bh, 0, 0, TAU);
      ctx.fill();
    }
  } else if (kind === 'small') {
    ctx.fillStyle = 'rgba(232,101,122,0.5)';
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.ellipse(-r * 0.15 + i * r * 0.55, 0, r * 0.11, bh, 0, 0, TAU);
      ctx.fill();
    }
  } else if (kind === 'big') {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (let i = 0; i < 4; i++) {
      const a = phase + i * 1.7;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.35 - r * 0.15, r * 0.16, 0, TAU);
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

  if (kind === 'golden') {
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
  gap:12px; padding:14px 16px; }
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
  color:#2d2417; border:5px solid #fff; border-radius:26px; padding:22px 26px 24px;
  box-shadow:0 24px 60px rgba(0,0,0,0.5); text-align:center; position:relative;
  animation:mg-fishing-card 0.32s cubic-bezier(.2,1.3,.4,1) both; }
@keyframes mg-fishing-card { from { transform:translateY(22px) scale(0.94); opacity:0; } }
.mg-fishing-title { font-size:clamp(30px,5.2vw,46px); font-weight:900; letter-spacing:0.02em; color:#e8657a;
  text-shadow:0 3px 0 #fff, 0 5px 0 rgba(45,36,23,0.12); line-height:1.05; }
.mg-fishing-sub { font-size:14px; font-weight:700; color:#8a7a5a; margin-top:2px; }
.mg-fishing-legend { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:6px 12px;
  margin:14px 0 12px; text-align:left; }
.mg-fishing-le { display:flex; align-items:center; gap:9px; background:rgba(79,179,232,0.14);
  border:2px solid rgba(45,36,23,0.08); border-radius:14px; padding:5px 9px; }
.mg-fishing-le canvas { width:64px; height:44px; flex:none; }
.mg-fishing-le b { display:block; font-size:13px; font-weight:900; line-height:1.15; }
.mg-fishing-le i { display:block; font-size:11px; font-style:normal; font-weight:700; color:#8a7a5a; }
.mg-fishing-pts { margin-left:auto; font-size:13px; font-weight:900; color:#2d7d46; white-space:nowrap; }
.mg-fishing-pts.mg-fishing-bad { color:#c0392b; }
.mg-fishing-tip { font-size:13.5px; font-weight:700; color:#5c5140; line-height:1.5; }
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
.mg-fishing-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); gap:7px;
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
  }

  coinsForScore(score) { return Math.round(score * 0.8); }

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
          <button class="mg-fishing-quit" data-a="quit">Quit</button>
        </header>
        <div class="mg-fishing-count" data-el="count" hidden></div>
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

    this._buildSplash();
    this._layout();
    this._resetScene();
    this._bind();

    this.last = performance.now();
    this._tickBound = (now) => this._tick(now);
    this.raf = requestAnimationFrame(this._tickBound);
  }

  _buildSplash() {
    const best = this.game.state?.bests?.[FishingGame.id] || 0;
    const legend = [
      ['small', `+${KINDS.small.points}`, false],
      ['medium', `+${KINDS.medium.points}`, false],
      ['big', `+${KINDS.big.points}`, false],
      ['golden', `+${KINDS.golden.points}`, false],
      ['jelly', 'Stun!', true],
      ['boot', '-2', true],
    ];
    const rows = legend.map(([kind, pts, bad]) => {
      const meta = KINDS[kind] || (kind === 'jelly'
        ? { label: 'Jellyfish', hint: 'zaps your line' }
        : { label: 'Old Boot', hint: 'not dinner' });
      return `<div class="mg-fishing-le">
        <canvas data-icon="${kind}" width="128" height="88"></canvas>
        <span><b>${meta.label}</b><i>${meta.hint}</i></span>
        <span class="mg-fishing-pts${bad ? ' mg-fishing-bad' : ''}">${pts}</span>
      </div>`;
    }).join('');

    this.el.splash.innerHTML = `
      <div class="mg-fishing-card">
        <div class="mg-fishing-title">Reel Rush</div>
        <div class="mg-fishing-sub">Driftwood Beach &middot; 90 seconds of fishing</div>
        <div class="mg-fishing-legend">${rows}</div>
        <p class="mg-fishing-tip">
          Move the <b>mouse</b> (or <b>&uarr; &darr;</b>) to set your hook depth, <b>&larr; &rarr;</b> to lean.
          Touch a fish to reel it in. Land <b>5 catches</b> in a row without a hazard for <b>double points</b>.
          Watch out: a <b>shark</b> sweeps the cove every 20 seconds.
        </p>
        <div class="mg-fishing-best">Your best catch: <b>${best}</b> points</div>
        <div class="mg-fishing-row">
          <button class="mg-fishing-btn" data-a="start">Cast off!</button>
          <button class="mg-fishing-btn mg-fishing-ghost" data-a="leave">Back to beach</button>
        </div>
        <div class="mg-fishing-hint">Click anywhere or press Space to start</div>
      </div>`;

    // legend icons: same art routines as the live scene, sized to fit the chip
    for (const c of this.el.splash.querySelectorAll('canvas[data-icon]')) {
      const g = c.getContext('2d');
      const kind = c.dataset.icon;
      g.save();
      g.translate(c.width / 2, c.height / 2);
      g.scale(1.5, 1.5);
      if (kind === 'jelly') {
        g.translate(0, -5);
        drawJellyArt(g, 9, 0.35, 0);
      } else if (kind === 'boot') {
        drawBootArt(g, 11, 0.2);
      } else {
        drawFishArt(g, kind, clamp(KINDS[kind].r * 0.7, 7, 17), 0.07, 0.4);
      }
      g.restore();
    }
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

    on(window, 'keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key;
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

    if (this.hook) {
      this.hook.y = clamp(this.hook.y, this.topLimit, this.botLimit);
      this.hook.targetY = clamp(this.hook.targetY, this.topLimit, this.botLimit);
    }
    this._buildDecor();
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
    };
    this.spawnIn = 0.6;
    this.bucket = 0;
    this.stats = { small: 0, medium: 0, big: 0, golden: 0, boot: 0, jelly: 0 };
    this.combo = 0;
    this.bestCombo = 0;
    this.multTimer = 0;
    this.nextShark = SHARK_EVERY;
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
  }

  _endRun() {
    this.phase = 'results';
    this.el.count.hidden = true;
    this.wrap.querySelector('.mg-fishing-hud').hidden = true;

    const score = Math.max(0, Math.round(this.score));
    const prevBest = this.game.state?.bests?.[FishingGame.id] || 0;
    const isBest = score > prevBest;
    const cap = MINIGAMES[FishingGame.id]?.maxCoinsPerRun ?? 120;
    const coins = Math.min(this.coinsForScore(score), cap);

    this.finish(score);
    this._sfx(score >= 60 ? 'success' : 'ding');

    const rank = score >= 150 ? 'Legendary haul!'
      : score >= 105 ? 'Master angler!'
      : score >= 70 ? 'Nice haul!'
      : score >= 40 ? 'Solid catch'
      : 'Better luck next cast';

    const s = this.stats;
    this.el.results.innerHTML = `
      <div class="mg-fishing-card">
        <div class="mg-fishing-ribbon"${isBest ? '' : ' hidden'}>New personal best!</div>
        <div class="mg-fishing-title">${rank}</div>
        <div class="mg-fishing-score-big">${score}</div>
        <div class="mg-fishing-sub">points</div>
        <div><span class="mg-fishing-coins">+${coins} coins</span></div>
        <div class="mg-fishing-stats">
          <div class="mg-fishing-stat"><b>${s.small}</b><span>Sardines</span></div>
          <div class="mg-fishing-stat"><b>${s.medium}</b><span>Bluefin</span></div>
          <div class="mg-fishing-stat"><b>${s.big}</b><span>Groupers</span></div>
          <div class="mg-fishing-stat"><b>${s.golden}</b><span>Golden</span></div>
          <div class="mg-fishing-stat"><b>${this.bestCombo}</b><span>Best streak</span></div>
          <div class="mg-fishing-stat"><b>${s.boot + s.jelly}</b><span>Oopsies</span></div>
        </div>
        <div class="mg-fishing-best">Best catch: <b>${Math.max(prevBest, score)}</b> points</div>
        <div class="mg-fishing-row">
          <button class="mg-fishing-btn" data-a="again">Play again</button>
          <button class="mg-fishing-btn mg-fishing-ghost" data-a="leave">Back to beach</button>
        </div>
      </div>`;
    this.el.results.hidden = false;
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
    if (playing) this._collide();
    this._updateFx(dt);

    if (this.multTimer > 0 && playing) {
      this.multTimer = Math.max(0, this.multTimer - dt);
      if (this.multTimer === 0) this._sfx('pop');
    }
    if (playing) this._updateHud(false);
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

    if (hk.stun > 0) {
      hk.stun -= dt;
      hk.y = clamp(hk.y + 42 * this.S * dt, this.topLimit, this.botLimit);
      hk.targetY = hk.y;
      if (hk.stun <= 0) {
        hk.stun = 0;
        if (this.pointer) hk.targetY = this.pointer.y;
        this._burst(hk.x, hk.y, 8, '#bfe8ff', 130);
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
    hk.r = 15 * this.S;
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

    const kind = weightedPick(spawnTable(p));
    if (kind === 'small' && Math.random() < 0.34) {
      // a little school swims through together
      const dir = Math.random() < 0.5 ? 1 : -1;
      const y = rand(this.topLimit + 14, this.botLimit - 14);
      const n = 3 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) {
        const e = this._spawn('small', dir, y + rand(-16, 16) * this.S);
        e.x -= dir * i * 62 * this.S;
      }
    } else {
      this._spawn(kind);
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
      if (e.kind === 'golden' && Math.random() < dt * 8) {
        this.particles.push({ x: e.x, y: e.y, vx: -e.dir * 20, vy: rand(-14, 14), life: 0.5, dur: 0.5, r: rand(1.4, 3) * this.S, col: '#ffe9a8', type: 'spark' });
      }
      if (e.dead || e.x < -out || e.x > this.w + out || e.baseY > this.botLimit + 26) {
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
      if (e.dead || !KINDS[e.kind]) continue;
      if (Math.abs(e.x - mouthX) < sh.L * 0.45 && Math.abs(e.y - sh.y) < sh.L * 0.34) {
        e.dead = true;
        this._burst(e.x, e.y, 9, KINDS[e.kind].body, 150);
        this._sfx('pop');
      }
    }

    if (this.phase === 'play' && this.hook.stun <= 0) {
      if (Math.abs(this.hook.x - sh.x) < sh.L * 0.85 && Math.abs(this.hook.y + 6 * this.S - sh.y) < sh.L * 0.38) {
        this._zap(1.2, 'Shark scare!');
      }
    }

    if (sh.x < -this.w * 0.3 || sh.x > this.w * 1.3) this.shark = null;
  }

  _collide() {
    const hk = this.hook;
    if (hk.stun > 0) return;
    const hx = hk.x;
    const hy = hk.y + 7 * this.S;

    for (const e of this.entities) {
      if (e.dead) continue;
      const dx = e.x - hx;
      const dy = e.y - hy;
      const rr = e.hitR + hk.r;
      if (dx * dx + dy * dy > rr * rr) continue;

      if (KINDS[e.kind]) {
        e.dead = true;
        const mult = this.multTimer > 0 ? 2 : 1;
        const pts = KINDS[e.kind].points * mult;
        this.score += pts;
        this.stats[e.kind]++;
        this.combo++;
        this.bestCombo = Math.max(this.bestCombo, this.combo);
        this._popup(e.x, e.y, `+${pts}`, e.kind === 'golden' ? '#ffe27a' : '#fff6e3', e.kind === 'golden' ? 1.5 : 1);
        this._burst(e.x, e.y, 7, '#cfefff', 140);
        this.catches.push({
          kind: e.kind, x0: e.x, y0: e.y, r: e.r, dir: e.dir, t: 0,
          dur: 0.32 + Math.abs(e.y - this.rodTip.y) / (this.h * 3.2), ph: e.ph, spin: rand(-6, 6),
        });
        this._sfx('splash');
        this.shake = Math.max(this.shake, e.kind === 'big' ? 5 : 3);
        if (e.kind === 'golden') this.flash = Math.max(this.flash, 0.55);
        if (this.combo > 0 && this.combo % COMBO_NEEDED === 0) {
          const fresh = this.multTimer <= 0;
          this.multTimer = COMBO_TIME;
          this._sfx('ding');
          this.flash = Math.max(this.flash, 0.75);
          this._popup(this.w * 0.5, this.h * 0.36, fresh ? 'COMBO x2!' : 'x2 EXTENDED!', '#ffdc7a', 1.9);
        }
      } else if (e.kind === 'jelly') {
        e.dead = true;
        this.stats.jelly++;
        this._zap(STUN_TIME, 'ZAP!');
        this._burst(e.x, e.y, 14, '#ff9ee0', 190);
      } else {
        e.dead = true;
        this.stats.boot++;
        this.score = Math.max(0, this.score - 2);
        this.combo = 0;
        this.multTimer = 0;
        this._popup(e.x, e.y, '-2', '#ff9a9a', 1.2);
        this._sfx('pop');
        this.shake = Math.max(this.shake, 5);
        this.catches.push({
          kind: 'boot', x0: e.x, y0: e.y, r: e.r, dir: e.dir, t: 0,
          dur: 0.4 + Math.abs(e.y - this.rodTip.y) / (this.h * 3.2), ph: e.ph, spin: rand(-8, 8),
        });
      }
      break; // one thing per frame keeps the feedback readable
    }
  }

  _zap(time, text) {
    this.hook.stun = time;
    this.combo = 0;
    this.multTimer = 0;
    this.shake = Math.max(this.shake, 12);
    this.danger = Math.max(this.danger, 0.8);
    this._popup(this.hook.x, this.hook.y - 18 * this.S, text, '#ffe27a', 1.5);
    this._sfx('fail');
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
    return this.waterY + Math.sin(x * 0.011 + t * 1.5) * 5 * this.S + Math.sin(x * 0.029 - t * 2.2) * 2.2 * this.S;
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
    this._drawPopups(ctx);
    this._drawOverlays(ctx);
  }

  _drawSky(ctx) {
    const { w } = this;
    const skyH = this.waterY + 10;
    const g = ctx.createLinearGradient(0, 0, 0, skyH);
    g.addColorStop(0, '#8fd6f5');
    g.addColorStop(0.65, '#c9ecfb');
    g.addColorStop(1, '#ffe7bd');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, skyH);

    // sun
    const sx = w * 0.82, sy = skyH * 0.34;
    ctx.fillStyle = 'rgba(255,236,170,0.5)';
    ctx.beginPath();
    ctx.arc(sx, sy, 34 * this.S, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath();
    ctx.arc(sx, sy, 19 * this.S, 0, TAU);
    ctx.fill();

    for (const c of this.clouds) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
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
    const g = ctx.createLinearGradient(0, this.waterY, 0, h);
    g.addColorStop(0, '#3fb6d8');
    g.addColorStop(0.28, '#1f8ab5');
    g.addColorStop(0.66, '#12578a');
    g.addColorStop(1, '#0a2f55');
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
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const r of this.rays) {
      const sway = Math.sin(this.t * r.spd + r.ph) * 26 * this.S;
      const a = r.a * (0.65 + 0.35 * Math.sin(this.t * r.spd * 1.7 + r.ph));
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
    ctx.strokeStyle = hk.stun > 0
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
    ctx.strokeStyle = hk.stun > 0 ? '#ffe27a' : '#e9f2f7';
    ctx.stroke();

    // lure bead
    ctx.beginPath();
    ctx.arc(0, -2 * S, 4.6 * S, 0, TAU);
    ctx.fillStyle = hk.stun > 0 ? '#ff9a5c' : '#e8657a';
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
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3 * this.S;
    ctx.stroke();

    // shimmer just under the surface
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
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
