import { Minigame } from '../minigame.js';
import { clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Shuffle Showdown : top-down shuffleboard duel against Waxwell, the Game Den's
 * self-appointed table boss.
 *
 * 2 rounds x 4 pucks each, alternating shots. Pull back from your puck, watch
 * the aim curve bend with the wax, release and pray. Zones 1/2/3 with a 4-point
 * hanger right on the lip; only pucks past the near line count.
 *
 * Canvas 2D for the table (no WebGL), DOM for HUD/overlays, procedural art
 * everywhere. Waxwell is drawn on a 200x200 grid in the same ink-and-gradient
 * language as the smoothie customers.
 */

// ---------------------------------------------------------------------------
// tiny color + math helpers
// ---------------------------------------------------------------------------
const OUTLINE = '#3a2a1c';

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
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
/** Box-Muller, clipped so a freak sample cannot send a puck into orbit. */
function gauss() {
  const u = Math.random() || 1e-6;
  const v = Math.random();
  return clamp(Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * v), -2.4, 2.4);
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
function lgrad(ctx, x0, y0, x1, y1, a, b) {
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
// table geometry (one shared unit space; x runs down the table, y across it)
// ---------------------------------------------------------------------------
const TL = 420;        // table length
const TW = 170;        // table width
const PR = 11;         // puck radius
const MU = 150;        // friction deceleration, units/s^2
const FOUL = 214;      // near line: nothing short of this scores
const Z2 = 284;        // start of the 2 band
const Z3 = 344;        // start of the 3 band
const HANG = 404;      // start of the hanger band
const SPAWN_X = 52;
const SPAWN_Y = { you: 116, ai: 54 };
const SIDE_COL = { you: '#e8657a', ai: '#4fb3e8' };
const V_MIN = 180, V_SPAN = 180; // launch speed = V_MIN + power * V_SPAN
// Drag runs FORWARD from the puck (the shooting end is only 52 units from the
// left edge, so a pull-back slingshot would run off the canvas at full power).
const MAX_DRAG = 150;            // drag length (units) for a full meter
const AIM_LIMIT = 0.4;           // radians either side of straight

function zoneOf(x) {
  if (x >= HANG) return 4;
  if (x >= Z3) return 3;
  if (x >= Z2) return 2;
  if (x >= FOUL) return 1;
  return 0;
}
const ZONE_NAME = { 0: 'SHORT', 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'HANGER' };

// ---------------------------------------------------------------------------
// Waxwell, the opponent (200x200 grid)
// expr: idle | thinking | smug | worried | beaten
// ---------------------------------------------------------------------------
const FUR = '#a8814f';
const CAP_COL = '#4fb3e8';

function drawWaxwell(ctx, size, expr) {
  const s = size / 200;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const dark = shade(FUR, -0.24);
  const muzzle = shade(FUR, 0.22);
  const down = expr === 'beaten';

  // shoulders
  rrect(ctx, 48, 150, 104, 64, 30);
  ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);

  // bow tie
  ctx.beginPath();
  ctx.moveTo(100, 166); ctx.lineTo(70, 152); ctx.lineTo(70, 182); ctx.closePath();
  ctx.moveTo(100, 166); ctx.lineTo(130, 152); ctx.lineTo(130, 182); ctx.closePath();
  ctx.fillStyle = '#f2b64a'; ctx.fill(); ink(ctx, 4.5);
  ctx.beginPath(); ctx.arc(100, 166, 9, 0, Math.PI * 2);
  ctx.fillStyle = shade('#f2b64a', 0.3); ctx.fill(); ink(ctx, 4);

  // ears (they droop when he is beaten)
  for (const [ex, sgn] of [[46, -1], [154, 1]]) {
    ctx.save();
    ctx.translate(ex, 50 + (down ? 12 : 0));
    ctx.rotate(sgn * (0.3 + (down ? 0.55 : 0)));
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 17, 0, 0, Math.PI * 2);
    ctx.fillStyle = dark; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(0, 2, 9, 7, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a3a8'; ctx.fill();
    ctx.restore();
  }

  // head
  rrect(ctx, 38, 36, 124, 104, 42);
  ctx.fillStyle = lgrad(ctx, 38, 36, 162, 140, shade(FUR, 0.12), FUR);
  ctx.fill(); ink(ctx, 5.5);

  // muzzle + nostrils
  rrect(ctx, 58, 96, 84, 58, 26);
  ctx.fillStyle = muzzle; ctx.fill(); ink(ctx, 4.5);
  ctx.fillStyle = OUTLINE;
  for (const nx of [86, 114]) {
    ctx.save(); ctx.translate(nx, 116); ctx.rotate(nx < 100 ? 0.5 : -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // mouth
  ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
  if (expr === 'smug') {
    ctx.beginPath();
    ctx.moveTo(82, 134); ctx.quadraticCurveTo(102, 146, 122, 126); ctx.stroke();
    ctx.beginPath(); ctx.arc(122, 126, 3, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE; ctx.fill();
  } else if (expr === 'worried') {
    ctx.beginPath();
    ctx.moveTo(84, 134); ctx.quadraticCurveTo(92, 141, 100, 134);
    ctx.quadraticCurveTo(108, 127, 116, 134); ctx.stroke();
  } else if (expr === 'beaten') {
    ctx.beginPath();
    ctx.moveTo(84, 138); ctx.quadraticCurveTo(100, 126, 116, 138); ctx.stroke();
  } else if (expr === 'thinking') {
    ctx.beginPath();
    ctx.moveTo(88, 133); ctx.quadraticCurveTo(102, 136, 112, 130); ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(88, 130); ctx.quadraticCurveTo(100, 140, 112, 130); ctx.stroke();
  }

  // eyes
  const eyes = [70, 130];
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i];
    if (expr === 'beaten') {
      ctx.lineWidth = 5; ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(ex - 11, 72); ctx.quadraticCurveTo(ex, 88, ex + 11, 72); ctx.stroke();
      continue;
    }
    const r = expr === 'worried' ? 8 : 10;
    const look = expr === 'thinking' ? [2.5, -3.5] : [-3.4, -4];
    ctx.beginPath(); ctx.ellipse(ex, 76, r, r + 1.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE; ctx.fill();
    ctx.beginPath(); ctx.arc(ex + look[0], 76 + look[1], 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    if (expr === 'smug') {
      // heavy lids, outer corner low: instant "yeah, i meant that"
      ctx.lineWidth = 6.5; ctx.strokeStyle = OUTLINE; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ex - 12, 70 + (i ? 4 : 0)); ctx.lineTo(ex + 12, 70 + (i ? 0 : 4));
      ctx.stroke();
    } else if (expr === 'worried') {
      ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(ex + (i ? 12 : -12), 60); ctx.lineTo(ex + (i ? -5 : 5), 56); ctx.stroke();
    } else if (expr === 'thinking') {
      ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(ex - 11, i ? 54 : 60); ctx.lineTo(ex + 11, i ? 60 : 58); ctx.stroke();
    }
  }

  // blush when he is enjoying himself
  if (expr === 'smug' || expr === 'idle') {
    ctx.fillStyle = 'rgba(232,101,122,0.3)';
    ctx.beginPath(); ctx.ellipse(52, 106, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(148, 106, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  // sweat bead
  if (expr === 'worried' || expr === 'beaten') {
    ctx.beginPath();
    ctx.moveTo(170, 58); ctx.quadraticCurveTo(180, 72, 170, 78);
    ctx.quadraticCurveTo(160, 72, 170, 58); ctx.closePath();
    ctx.fillStyle = '#9ed9f2'; ctx.fill(); ink(ctx, 3.5);
  }

  // flat cap
  ctx.beginPath();
  ctx.moveTo(42, 48);
  ctx.bezierCurveTo(44, 2, 156, 2, 158, 46);
  ctx.closePath();
  ctx.fillStyle = lgrad(ctx, 42, 4, 158, 48, shade(CAP_COL, 0.16), CAP_COL);
  ctx.fill(); ink(ctx, 5);
  ctx.beginPath();
  ctx.moveTo(46, 44);
  ctx.quadraticCurveTo(12, 44, 4, 56);
  ctx.quadraticCurveTo(28, 62, 52, 54);
  ctx.closePath();
  ctx.fillStyle = shade(CAP_COL, -0.24); ctx.fill(); ink(ctx, 4.5);
  ctx.beginPath(); ctx.arc(100, 8, 8, 0, Math.PI * 2);
  ctx.fillStyle = shade(CAP_COL, 0.35); ctx.fill(); ink(ctx, 4);

  // thought bubbles
  if (expr === 'thinking') {
    ctx.fillStyle = '#fffdf6';
    for (const [bx, by, br] of [[172, 34, 6], [186, 20, 8.5]]) {
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill(); ink(ctx, 3.4);
    }
  }
  ctx.restore();
}

function paintFace(canvas, cssSize, expr) {
  const d = dpr();
  const px = Math.round(cssSize * d);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  drawWaxwell(ctx, cssSize, expr);
}

// ---------------------------------------------------------------------------
// splash legend: a miniature of the real table
// ---------------------------------------------------------------------------
function legendCanvas(w, h) {
  const c = document.createElement('canvas');
  const d = dpr();
  c.width = Math.round(w * d); c.height = Math.round(h * d);
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const sc = Math.min((w - 8) / TL, (h - 8) / TW);
  const ox = (w - TL * sc) / 2, oy = (h - TW * sc) / 2;
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(sc, sc);
  ctx.fillStyle = lgrad(ctx, 0, 0, 0, TW, '#d8a163', '#a56f34');
  rrect(ctx, 0, 0, TL, TW, 10); ctx.fill(); ink(ctx, 5 / sc);
  const bands = [[FOUL, Z2, '1'], [Z2, Z3, '2'], [Z3, HANG, '3'], [HANG, TL, '4']];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [a, b, label] of bands) {
    ctx.fillStyle = 'rgba(255,246,227,0.16)';
    ctx.fillRect(a, 0, b - a, TW);
    ctx.strokeStyle = 'rgba(255,246,227,0.85)'; ctx.lineWidth = 3.5 / sc;
    ctx.beginPath(); ctx.moveTo(a, 0); ctx.lineTo(a, TW); ctx.stroke();
    ctx.fillStyle = 'rgba(255,246,227,0.92)';
    ctx.font = `900 ${label === '4' ? 28 : 56}px "Trebuchet MS",sans-serif`;
    ctx.fillText(label, (a + b) / 2, TW / 2);
  }
  ctx.strokeStyle = '#e8657a'; ctx.lineWidth = 5 / sc;
  ctx.setLineDash([12, 9]);
  ctx.beginPath(); ctx.moveTo(FOUL, 0); ctx.lineTo(FOUL, TW); ctx.stroke();
  ctx.setLineDash([]);
  drawPuck(ctx, 96, 116, '#e8657a', 1);
  drawPuck(ctx, 372, 60, '#4fb3e8', 1);
  drawPuck(ctx, 412, 118, '#e8657a', 1);
  ctx.restore();
  return c;
}

/** A puck, drawn in table units centred on (x, y). */
function drawPuck(ctx, x, y, col, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.beginPath(); ctx.ellipse(2.5, 3.5, PR, PR * 0.94, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(52,30,10,0.35)'; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, PR, 0, Math.PI * 2);
  ctx.fillStyle = lgrad(ctx, -PR, -PR, PR, PR, shade(col, 0.25), shade(col, -0.3));
  ctx.fill();
  ctx.lineWidth = 2.2; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, PR * 0.68, 0, Math.PI * 2);
  ctx.fillStyle = lgrad(ctx, -PR, -PR, PR, PR, shade(col, 0.1), shade(col, -0.14));
  ctx.fill();
  // capy paw emblem
  ctx.fillStyle = shade(col, 0.45);
  ctx.beginPath(); ctx.ellipse(0, 1.6, 3.4, 2.8, 0, 0, Math.PI * 2); ctx.fill();
  for (const [px, py] of [[-3.4, -2.6], [0, -3.8], [3.4, -2.6]]) {
    ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, PR * 0.86, Math.PI * 1.05, Math.PI * 1.5);
  ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// chatter
// ---------------------------------------------------------------------------
const LINES = {
  think: [
    'hmm. the wax is being weird today.',
    'watch the wrist. this is the good part.',
    'i have played this table since i was a pup.',
    'just a little tap. just a little one.',
    'if i land this you owe me a smoothie.',
  ],
  smug: [
    'and THAT is called wax control.',
    'ooh. snug as a bug.',
    'the table likes me. sorry about it.',
    'you can clap. it is allowed.',
    'i barely even looked.',
  ],
  worried: [
    'that was NOT the plan.',
    'who waxed this thing?! honestly!',
    'okay okay okay. still fine. totally fine.',
    'my puck! that was a lovely puck!',
    'i am not sweating. capybaras do not sweat.',
  ],
  idle: [
    'your shot, friend. no pressure.',
    'take your time. i have got all afternoon.',
    'the near line is right there. mind it.',
    'nice and smooth. that is the whole secret.',
  ],
  beaten: [
    'well. i need a nap and a snack.',
    'rematch. tomorrow. bring biscuits.',
    'you are a natural. it is honestly upsetting.',
  ],
  won: [
    'the table boss remains the table boss.',
    'good game! genuinely. now go practise.',
    'do not feel bad. i am extremely good.',
  ],
  tie: [
    'a draw? on MY table? unheard of.',
    'dead even. that was tremendous fun.',
  ],
};

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------
const STYLE = `
.mg-shuffle-root{position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#fff6e3;user-select:none;
  -webkit-user-select:none;touch-action:none;
  background:
    radial-gradient(ellipse 70% 60% at 50% 42%, rgba(255,214,140,.24), rgba(255,214,140,0) 70%),
    linear-gradient(180deg,#33221a 0%,#241811 60%,#1b120d 100%);}
.mg-shuffle-root *{box-sizing:border-box;}
.mg-shuffle-root.mg-shuffle-quake{animation:mg-shuffle-quake .34s ease;}
@keyframes mg-shuffle-quake{0%,100%{transform:translate(0,0)}
  22%{transform:translate(-7px,3px)}45%{transform:translate(6px,-4px)}72%{transform:translate(-4px,-2px)}}

.mg-shuffle-walls{position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(90deg, rgba(0,0,0,.16) 0 4px, rgba(0,0,0,0) 4px 96px);
  opacity:.5;}
.mg-shuffle-walls::after{content:"";position:absolute;inset:0;
  background:radial-gradient(ellipse 85% 75% at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,.55) 100%);}

/* ---- hud ---- */
.mg-shuffle-hud{position:relative;z-index:6;display:flex;align-items:center;gap:9px;
  padding:11px 14px;flex-wrap:wrap;}
.mg-shuffle-chip{background:#fffdf6;color:#3a2a1c;border-radius:999px;padding:6px 15px;font-weight:900;
  font-size:15px;box-shadow:0 5px 0 rgba(0,0,0,.3),0 8px 16px rgba(0,0,0,.28);
  display:flex;align-items:center;gap:8px;}
.mg-shuffle-chip small{font-size:10.5px;letter-spacing:.13em;opacity:.55;font-weight:800;}
.mg-shuffle-chip b{font-size:19px;min-width:20px;text-align:right;}
.mg-shuffle-you b{color:#d5405c;}
.mg-shuffle-ai b{color:#2b86bd;}
.mg-shuffle-chip.mg-shuffle-bump{animation:mg-shuffle-bump .32s ease;}
@keyframes mg-shuffle-bump{50%{transform:scale(1.18) rotate(-2deg)}}
.mg-shuffle-chip.mg-shuffle-active{background:#f2b64a;box-shadow:0 5px 0 rgba(0,0,0,.3),0 0 0 3px rgba(242,182,74,.35);}
.mg-shuffle-dots{display:flex;gap:5px;align-items:center;}
.mg-shuffle-dot{width:13px;height:13px;border-radius:50%;background:#d5405c;
  box-shadow:inset 0 -3px 0 rgba(0,0,0,.22);transition:.2s;}
.mg-shuffle-dot.mg-shuffle-ai{background:#2b86bd;}
.mg-shuffle-dot.mg-shuffle-spent{background:#c9bba6;transform:scale(.62);opacity:.6;}
.mg-shuffle-spacer{flex:1;}
.mg-shuffle-quit{border:0;background:rgba(255,246,227,.16);color:#fff6e3;font-family:inherit;font-weight:900;
  font-size:13px;letter-spacing:.1em;padding:9px 18px;border-radius:999px;cursor:pointer;transition:.14s;}
.mg-shuffle-quit:hover{background:#c94a3e;transform:scale(1.06);}

/* ---- layout ---- */
.mg-shuffle-body{position:relative;z-index:4;flex:1;min-height:0;display:flex;gap:10px;padding:0 12px 12px;}
.mg-shuffle-table{position:relative;flex:1;min-width:0;}
.mg-shuffle-table canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;}
.mg-shuffle-table canvas.mg-shuffle-drag{cursor:grabbing;}
.mg-shuffle-fx{position:absolute;inset:0;pointer-events:none;overflow:hidden;}

.mg-shuffle-side{width:min(230px,26vw);flex:none;display:flex;flex-direction:column;align-items:center;
  gap:8px;padding-top:4px;}
.mg-shuffle-bubble{position:relative;background:#fffdf6;color:#3a2a1c;border-radius:18px;padding:9px 13px;
  font-size:12.5px;font-weight:700;line-height:1.35;text-align:center;box-shadow:0 8px 18px rgba(0,0,0,.4);
  min-height:46px;display:flex;align-items:center;justify-content:center;width:100%;}
.mg-shuffle-bubble::after{content:"";position:absolute;bottom:-12px;left:50%;margin-left:-10px;
  border:10px solid transparent;border-top-color:#fffdf6;border-bottom:0;}
.mg-shuffle-bubble.mg-shuffle-pop{animation:mg-shuffle-bpop .3s cubic-bezier(.2,1.6,.4,1);}
@keyframes mg-shuffle-bpop{from{transform:scale(.5);opacity:0}}
.mg-shuffle-face{display:block;animation:mg-shuffle-idle 2.8s ease-in-out infinite;}
@keyframes mg-shuffle-idle{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-6px) rotate(1.2deg)}}
.mg-shuffle-name{background:#fffdf6;color:#3a2a1c;border-radius:999px;padding:3px 15px;font-size:12.5px;
  font-weight:900;letter-spacing:.06em;margin-top:-12px;box-shadow:0 4px 10px rgba(0,0,0,.4);}
.mg-shuffle-turn{background:rgba(255,246,227,.12);border-radius:14px;padding:8px 12px;font-size:12px;
  font-weight:900;letter-spacing:.1em;text-align:center;width:100%;transition:.2s;}
.mg-shuffle-turn.mg-shuffle-yours{background:#e8657a;box-shadow:0 5px 0 rgba(0,0,0,.3);}
.mg-shuffle-tip{font-size:11.5px;font-weight:700;line-height:1.5;opacity:.72;text-align:center;}
.mg-shuffle-tip b{color:#f2b64a;}
@media (max-width:820px){.mg-shuffle-side{width:150px}.mg-shuffle-tip{display:none}}
@media (max-width:620px){.mg-shuffle-side{display:none}}

/* ---- floating feedback ---- */
.mg-shuffle-float{position:absolute;transform:translate(-50%,-50%);font-weight:900;white-space:nowrap;
  animation:mg-shuffle-float 1.1s ease-out forwards;text-shadow:0 3px 0 rgba(0,0,0,.4);
  font-size:clamp(19px,2.6vw,32px);color:#fff6e3;}
@keyframes mg-shuffle-float{0%{opacity:0;transform:translate(-50%,-20%) scale(.5)}
  22%{opacity:1;transform:translate(-50%,-60%) scale(1.18)}
  48%{transform:translate(-50%,-72%) scale(1)}
  100%{opacity:0;transform:translate(-50%,-150%) scale(.95)}}
.mg-shuffle-float.mg-shuffle-good{color:#ffe08a;}
.mg-shuffle-float.mg-shuffle-hang{color:#8ef0a0;font-size:clamp(22px,3.2vw,40px);letter-spacing:.04em;}
.mg-shuffle-float.mg-shuffle-bad{color:#ff9c8c;}
.mg-shuffle-float.mg-shuffle-knock{color:#9be0ff;}

.mg-shuffle-banner{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);z-index:7;
  pointer-events:none;text-align:center;}
.mg-shuffle-banner.mg-shuffle-gone{display:none;}
.mg-shuffle-banner div{background:rgba(28,18,12,.88);border-radius:22px;padding:16px 30px;
  box-shadow:0 14px 34px rgba(0,0,0,.5);animation:mg-shuffle-bin .4s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-shuffle-bin{from{transform:scale(.7) translateY(14px);opacity:0}}
.mg-shuffle-banner h3{font-size:clamp(22px,3.4vw,34px);color:#f2b64a;letter-spacing:.03em;}
.mg-shuffle-banner p{font-size:clamp(13px,1.7vw,17px);font-weight:800;opacity:.9;margin-top:5px;}

/* ---- overlays ---- */
.mg-shuffle-over{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;
  background:rgba(20,12,7,.76);backdrop-filter:blur(3px);padding:18px;text-align:center;overflow-y:auto;}
.mg-shuffle-over.mg-shuffle-gone{display:none;}
.mg-shuffle-card{background:linear-gradient(180deg,#fffdf6,#ffeed2);color:#3a2a1c;border-radius:28px;
  padding:24px 28px;width:min(620px,95vw);box-shadow:0 18px 50px rgba(0,0,0,.5);
  animation:mg-shuffle-card .34s cubic-bezier(.2,1.5,.4,1);}
@keyframes mg-shuffle-card{from{transform:scale(.84) translateY(20px);opacity:0}}
.mg-shuffle-card h1{font-size:clamp(28px,4.4vw,44px);color:#e8657a;line-height:1.04;}
.mg-shuffle-card h2{font-size:clamp(24px,3.6vw,36px);color:#e8657a;}
.mg-shuffle-sub{font-weight:800;color:#9a8461;font-size:13.5px;margin:5px 0 14px;letter-spacing:.05em;}
.mg-shuffle-hero{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:10px;}
.mg-shuffle-hero .mg-shuffle-vs{font-size:clamp(20px,3vw,30px);font-weight:900;color:#c9b28a;}
.mg-shuffle-hero canvas{filter:drop-shadow(0 6px 10px rgba(60,34,10,.3));}
.mg-shuffle-legend{border-radius:16px;overflow:hidden;margin:0 auto 12px;width:fit-content;
  box-shadow:0 8px 18px rgba(60,34,10,.28);}
.mg-shuffle-how{display:flex;flex-direction:column;gap:8px;text-align:left;margin-bottom:14px;}
.mg-shuffle-how div{display:flex;align-items:center;gap:11px;background:#fff6e3;border-radius:14px;
  padding:8px 13px;font-size:13px;font-weight:700;line-height:1.35;}
.mg-shuffle-how i{flex:none;width:28px;height:28px;border-radius:50%;background:#e8657a;color:#fff;
  font-style:normal;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;}
.mg-shuffle-stats{display:flex;justify-content:center;gap:9px;margin:12px 0 14px;flex-wrap:wrap;}
.mg-shuffle-stat{background:#fff6e3;border-radius:18px;padding:10px 18px;min-width:98px;}
.mg-shuffle-stat b{display:block;font-size:clamp(21px,3vw,30px);color:#3a2a1c;line-height:1.1;}
.mg-shuffle-stat span{font-size:10.5px;font-weight:900;letter-spacing:.13em;color:#9a8461;}
.mg-shuffle-stat.mg-shuffle-gold b{color:#e0982a;}
.mg-shuffle-ribbon{display:inline-block;background:#f2b64a;color:#fff;font-weight:900;letter-spacing:.14em;
  font-size:12px;padding:6px 18px;border-radius:999px;margin-bottom:6px;
  animation:mg-shuffle-pulse .8s ease-in-out infinite;}
@keyframes mg-shuffle-pulse{50%{transform:scale(1.07)}}
.mg-shuffle-rounds{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;
  font-size:12px;font-weight:900;letter-spacing:.06em;color:#7a6748;}
.mg-shuffle-rounds span{background:#fff6e3;border-radius:999px;padding:5px 14px;}
.mg-shuffle-pay{font-size:11.5px;font-weight:800;letter-spacing:.06em;color:#9a8461;margin-bottom:12px;}
.mg-shuffle-btns{display:flex;gap:11px;justify-content:center;flex-wrap:wrap;}
.mg-shuffle-btn{border:4px solid #fff;border-radius:999px;background:#e8657a;color:#fff;font-family:inherit;
  font-weight:900;font-size:clamp(14px,1.7vw,18px);padding:11px 26px;cursor:pointer;
  box-shadow:0 7px 0 rgba(60,34,10,.28);transition:.12s;}
.mg-shuffle-btn:hover{transform:translateY(-2px);}
.mg-shuffle-btn:active{transform:translateY(5px);box-shadow:0 2px 0 rgba(60,34,10,.28);}
.mg-shuffle-btn.mg-shuffle-alt{background:#4fb3e8;}
.mg-shuffle-btn.mg-shuffle-ghost{background:transparent;border-color:rgba(58,42,28,.28);color:#7a6748;
  box-shadow:none;}
.mg-shuffle-count{font-size:clamp(74px,16vw,168px);font-weight:900;color:#fff6e3;
  text-shadow:0 8px 0 rgba(0,0,0,.35);animation:mg-shuffle-count .6s ease-out;}
@keyframes mg-shuffle-count{from{transform:scale(2.2);opacity:0}40%{opacity:1}to{transform:scale(1)}}
@media (max-height:640px){.mg-shuffle-how div{padding:6px 11px;font-size:12px}.mg-shuffle-legend{display:none}}
/* Short windows: without this the splash card runs ~505px and both buttons sit
   below the fold on an overlay that does not look scrollable, so the run can
   only be started by scrolling blind. Squeezes the card, never the table. */
@media (max-height:560px){
  .mg-shuffle-over{padding:4px;}
  .mg-shuffle-card{padding:10px 18px;border-radius:22px;}
  .mg-shuffle-card h1{font-size:22px;}
  .mg-shuffle-card h2{font-size:24px;}
  .mg-shuffle-hero{gap:10px;margin-bottom:5px;}
  .mg-shuffle-hero canvas{width:64px;height:64px;}
  .mg-shuffle-sub{margin:3px 0 7px;font-size:12px;}
  .mg-shuffle-how{gap:4px;margin-bottom:8px;}
  .mg-shuffle-how div{padding:4px 9px;font-size:10.5px;gap:8px;line-height:1.25;}
  .mg-shuffle-how i{width:20px;height:20px;font-size:11px;}
  .mg-shuffle-stats{margin:7px 0 8px;gap:7px;}
  .mg-shuffle-stat{padding:5px 13px;min-width:78px;border-radius:14px;}
  .mg-shuffle-stat b{font-size:17px;}
  .mg-shuffle-stat span{font-size:9px;}
  .mg-shuffle-rounds{margin-bottom:7px;font-size:10.5px;}
  .mg-shuffle-rounds span{padding:3px 10px;}
  .mg-shuffle-pay{font-size:10px;margin-bottom:7px;}
  .mg-shuffle-ribbon{font-size:10.5px;padding:4px 14px;margin-bottom:4px;}
  .mg-shuffle-btn{padding:7px 18px;font-size:13px;border-width:3px;}
}
`;

// ---------------------------------------------------------------------------
// the game
// ---------------------------------------------------------------------------
export class ShuffleGame extends Minigame {
  static id = 'shuffle';
  static name = 'Shuffle Showdown';

  constructor(game) {
    super(game);
    this._timers = new Set();
    this._raf = 0;
    this._dead = false;
    this._onKey = null;
    this._onUp = null;
    this.phase = 'splash';
    this.el = {};
    this.view = { sc: 1, ox: 0, oy: 0 };
    this.pucks = [];
    this.dust = [];
    this.sparks = [];
    this.aim = { angle: 0, power: 0.55 };
    this.dragging = false;
    this.expr = 'idle';
    this._result = null;
    this.wax = { amp: 12, phase: 0, waves: 0.9 };
    this.banked = { you: 0, ai: 0 };
    this.roundLog = [];
    this.round = 1;
    this.shot = 0;
    this.flash = null;
    this.clock = 0;
  }

  // ---- lifecycle ----------------------------------------------------------
  mount(root) {
    super.mount(root);
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-shuffle-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (s) => wrap.querySelector(s);
    this.el = {
      wrap,
      round: q('[data-el="round"]'),
      you: q('[data-el="you"]'),
      ai: q('[data-el="ai"]'),
      youChip: q('[data-el="youChip"]'),
      aiChip: q('[data-el="aiChip"]'),
      dots: q('[data-el="dots"]'),
      table: q('[data-el="table"]'),
      canvas: q('[data-el="canvas"]'),
      fx: q('[data-el="fx"]'),
      banner: q('[data-el="banner"]'),
      face: q('[data-el="face"]'),
      bubble: q('[data-el="bubble"]'),
      turn: q('[data-el="turn"]'),
      over: q('[data-el="over"]'),
    };
    this.canvas = this.el.canvas;
    this.ctx = this.canvas.getContext('2d');

    this.canvas.addEventListener('pointerdown', (e) => this._down(e));
    this.canvas.addEventListener('pointermove', (e) => this._move(e));
    // released off the canvas (or capture refused): the drag must still end
    this._onUp = () => this._up();
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    wrap.querySelector('[data-el="quit"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });

    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey);

    this._rollWax();
    this._seedSparks();
    this._say('idle', 'welcome to my table. mind the wax.');
    this._showSplash();
    this._last = 0;
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  dispose() {
    this._dead = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
    if (this._onUp) {
      window.removeEventListener('pointerup', this._onUp);
      window.removeEventListener('pointercancel', this._onUp);
    }
    this._onKey = null;
    this._onUp = null;
    this.pucks = [];
    this.dust = [];
    this.sparks = [];
    this.el = {};
    this.canvas = null;
    this.ctx = null;
  }

  /** Coins follow the duel result, not the raw score: win big, draw small. */
  coinsForScore(score) {
    const r = this._result;
    if (r) {
      if (r.margin > 0) return clampCoinsForGame('shuffle', 45 + r.margin * 5);
      if (r.margin === 0) return 15;
      return 5;
    }
    // no duel on record (a run can only reach finish() through _results)
    return score > 0 ? 5 : 0;
  }

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
      <div class="mg-shuffle-walls"></div>
      <div class="mg-shuffle-hud">
        <div class="mg-shuffle-chip"><small>ROUND</small><b data-el="round">1</b></div>
        <div class="mg-shuffle-chip mg-shuffle-you" data-el="youChip"><small>YOU</small><b data-el="you">0</b></div>
        <div class="mg-shuffle-chip mg-shuffle-ai" data-el="aiChip"><small>WAXWELL</small><b data-el="ai">0</b></div>
        <div class="mg-shuffle-chip"><small>PUCKS</small><span class="mg-shuffle-dots" data-el="dots"></span></div>
        <div class="mg-shuffle-spacer"></div>
        <button class="mg-shuffle-quit" data-el="quit">QUIT</button>
      </div>

      <div class="mg-shuffle-body">
        <div class="mg-shuffle-table" data-el="table">
          <canvas data-el="canvas"></canvas>
          <div class="mg-shuffle-fx" data-el="fx"></div>
          <div class="mg-shuffle-banner mg-shuffle-gone" data-el="banner"></div>
        </div>
        <aside class="mg-shuffle-side">
          <div class="mg-shuffle-bubble" data-el="bubble">...</div>
          <canvas class="mg-shuffle-face" data-el="face"></canvas>
          <div class="mg-shuffle-name">WAXWELL</div>
          <div class="mg-shuffle-turn" data-el="turn">WARMING UP</div>
          <div class="mg-shuffle-tip">Drag out from your puck, then let go.<br>
            <b>&larr; &rarr;</b> aim &middot; <b>&uarr; &darr;</b> power &middot; <b>SPACE</b> slide</div>
        </aside>
      </div>

      <div class="mg-shuffle-over" data-el="over"></div>`;
  }

  // ---- screens ------------------------------------------------------------
  _showSplash() {
    this.phase = 'splash';
    const best = this.game.state?.bests?.shuffle || 0;
    const over = this.el.over;
    over.classList.remove('mg-shuffle-gone');
    over.innerHTML = `
      <div class="mg-shuffle-card">
        <div class="mg-shuffle-hero">
          <canvas data-el="splashFace"></canvas>
          <div>
            <h1>Shuffle Showdown</h1>
            <div class="mg-shuffle-sub">WAXWELL HAS NEVER LOST. HE SAYS. LOUDLY.</div>
          </div>
        </div>
        <div class="mg-shuffle-legend" data-el="legend"></div>
        <div class="mg-shuffle-how">
          <div><i>1</i><span>Press your coral puck and <b>drag out down the table</b>: the direction aims it, the length loads the meter. Let go to slide. Arrow keys and <b>Space</b> work too.</span></div>
          <div><i>2</i><span>Past the near line scores <b>1</b>, <b>2</b>, <b>3</b> &mdash; and a puck hanging over the far lip is a <b>4</b>. Short pucks are worth nothing.</span></div>
          <div><i>3</i><span>Pucks knock pucks. Bump Waxwell off the end, or shove your own puck deeper. Anything that leaves the table is gone.</span></div>
          <div><i>4</i><span>The wax pulls the lane sideways &mdash; the sparkles show you which way. Two rounds, four pucks each, highest total wins.</span></div>
        </div>
        <div class="mg-shuffle-stats">
          <div class="mg-shuffle-stat"><b>${best}</b><span>YOUR BEST</span></div>
        </div>
        <div class="mg-shuffle-pay">WIN: 45 COINS + 5 PER POINT OF MARGIN &middot; DRAW: 15 &middot; LOSS: 5</div>
        <div class="mg-shuffle-btns">
          <button class="mg-shuffle-btn" data-a="play">RACK 'EM UP</button>
          <button class="mg-shuffle-btn mg-shuffle-ghost" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    paintFace(over.querySelector('[data-el="splashFace"]'), 118, 'smug');
    over.querySelector('[data-el="legend"]').appendChild(legendCanvas(Math.min(430, 0.8 * (this.el.wrap.clientWidth || 600)), 170));
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
    const steps = ['3', '2', '1', 'SLIDE!'];
    const show = (i) => {
      if (i >= steps.length) {
        over.classList.add('mg-shuffle-gone');
        over.innerHTML = '';
        this._startRound(1);
        return;
      }
      over.innerHTML = `<div class="mg-shuffle-count">${steps[i]}</div>`;
      this.game.audio?.play?.(i === steps.length - 1 ? 'success' : 'ding');
      this._after(i === steps.length - 1 ? 460 : 600, () => show(i + 1));
    };
    show(0);
  }

  _results() {
    this.phase = 'over';
    const you = this.banked.you, ai = this.banked.ai;
    const margin = you - ai;
    this._result = { you, ai, margin };
    const score = Math.max(0, you * 50 + Math.max(0, margin) * 30);
    const prevBest = this.game.state?.bests?.shuffle || 0;
    const isBest = score > prevBest;
    const coins = this.coinsForScore(score);
    this.finish(score);
    const shown = Math.max(prevBest, score);

    const win = margin > 0, tie = margin === 0;
    const expr = win ? 'beaten' : tie ? 'worried' : 'smug';
    this._say(expr, pick(win ? LINES.beaten : tie ? LINES.tie : LINES.won));
    this.game.audio?.play?.(win ? 'levelup' : tie ? 'ding' : 'fail');

    const head = win ? 'You take the table!' : tie ? 'Dead heat!' : 'Waxwell holds the table';
    const sub = win
      ? 'HE IS PRETENDING HE LET YOU WIN. HE DID NOT.'
      : tie
        ? 'NOBODY BLINKED. THE WAX WON.'
        : 'HE IS ALREADY TELLING EVERYONE IN THE DEN.';

    const over = this.el.over;
    over.classList.remove('mg-shuffle-gone');
    over.innerHTML = `
      <div class="mg-shuffle-card">
        ${isBest ? '<div class="mg-shuffle-ribbon">NEW BEST</div>' : ''}
        <div class="mg-shuffle-hero">
          <canvas data-el="endFace"></canvas>
          <div>
            <h2>${head}</h2>
            <div class="mg-shuffle-sub">${sub}</div>
          </div>
        </div>
        <div class="mg-shuffle-stats">
          <div class="mg-shuffle-stat"><b>${you} &ndash; ${ai}</b><span>FINAL</span></div>
          <div class="mg-shuffle-stat"><b>${score}</b><span>SCORE</span></div>
          <div class="mg-shuffle-stat mg-shuffle-gold"><b>${coins}</b><span>COINS</span></div>
          <div class="mg-shuffle-stat"><b>${shown}</b><span>BEST</span></div>
        </div>
        <div class="mg-shuffle-rounds">
          ${this.roundLog.map((r, i) => `<span>ROUND ${i + 1} &middot; ${r.you} &ndash; ${r.ai}</span>`).join('')}
        </div>
        <div class="mg-shuffle-btns">
          <button class="mg-shuffle-btn" data-a="again">Play again</button>
          <button class="mg-shuffle-btn mg-shuffle-alt" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    paintFace(over.querySelector('[data-el="endFace"]'), 112, expr);
    over.querySelector('[data-a="again"]').addEventListener('click', () => {
      this._done = false; // let the next duel report its own result
      this._result = null;
      this._countdown();
    });
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  // ---- run flow -----------------------------------------------------------
  _resetRun() {
    this.banked = { you: 0, ai: 0 };
    this.roundLog = [];
    this.pucks = [];
    this.dust = [];
    this.flash = null;
    this._result = null;
    this._live = null;
    this.round = 1;
    this.shot = 0;
    this.aim = { angle: 0, power: 0.55 };
    this.dragging = false;
    this.el.banner?.classList.add('mg-shuffle-gone');
    if (this.el.fx) this.el.fx.innerHTML = '';
    this._syncHud();
  }

  _rollWax() {
    this.wax = {
      amp: (8 + Math.random() * 10) * (Math.random() < 0.5 ? -1 : 1),
      phase: Math.random() * 6.283,
      waves: 0.6 + Math.random() * 0.6,
    };
  }

  _bias(x) {
    const w = this.wax;
    return w.amp * Math.sin(w.phase + (x / TL) * 6.283185 * w.waves);
  }

  _seedSparks() {
    this.sparks = [];
    for (let i = 0; i < 52; i++) {
      this.sparks.push({
        x: Math.random() * TL,
        y: Math.random() * TW,
        p: Math.random() * 6.283,
        s: 0.7 + Math.random() * 0.9,
      });
    }
  }

  _startRound(n) {
    this.round = n;
    this.shot = 0;
    this.pucks = [];
    this._live = null;
    this._rollWax();
    // round two: he stops being polite about it. Tuned from 3600 simulated
    // matches: a player who reads the aim guide wins about 6 duels in 10.
    this.aiSigA = n === 1 ? 0.11 : 0.07;
    this.aiSigP = n === 1 ? 0.115 : 0.072;
    this.aiComp = n === 1 ? 0.4 : 0.75;
    this._syncHud();
    if (n === 1) {
      this._nextShot();
    } else {
      this._banner('ROUND 2', 'fresh wax, sharper capybara');
      this._say('smug', 'fresh wax! and i get the first slide. delightful.');
      this._after(1700, () => {
        this._hideBanner();
        this._nextShot();
      });
    }
  }

  /** Round 1 the player leads; round 2 Waxwell leads so you get the last shot. */
  _shooterAt(i) {
    const playerFirst = this.round === 1;
    return (i % 2 === 0) === playerFirst ? 'you' : 'ai';
  }

  _nextShot() {
    if (this.phase === 'over' || this.phase === 'splash') return;
    if (this.shot >= 8) { this._endRound(); return; }
    const side = this._shooterAt(this.shot);
    if (side === 'you') this._beginPlayerTurn();
    else this._beginAiTurn();
  }

  _makePuck(side) {
    return {
      side,
      x: SPAWN_X,
      y: SPAWN_Y[side],
      vx: 0,
      vy: 0,
      mu: MU,
      pending: true,
      moving: false,
      off: false,
      offT: 0,
      spin: 0,
      trail: [],
    };
  }

  _beginPlayerTurn() {
    this.phase = 'aim';
    this._live = this._makePuck('you');
    this.pucks.push(this._live);
    this.aim = { angle: 0, power: 0.55 };
    this.dragging = false;
    this.el.turn.textContent = 'YOUR SHOT';
    this.el.turn.classList.add('mg-shuffle-yours');
    this._syncHud();
    if (Math.random() < 0.5) this._say('idle', pick(LINES.idle));
  }

  _beginAiTurn() {
    this.phase = 'think';
    this._live = this._makePuck('ai');
    this.pucks.push(this._live);
    this.el.turn.textContent = 'WAXWELL IS THINKING';
    this.el.turn.classList.remove('mg-shuffle-yours');
    this._syncHud();
    this._say('thinking', pick(LINES.think));
    this._after(1150, () => {
      if (this.phase !== 'think' || !this._live) return;
      const plan = this._aiPlan();
      this._launch(plan.angle, plan.power);
    });
  }

  _launch(angle, power) {
    const p = this._live;
    if (!p || !p.pending) return;
    const a = clamp(angle, -AIM_LIMIT, AIM_LIMIT);
    const pw = clamp(power, 0, 1);
    const v = V_MIN + pw * V_SPAN;
    p.vx = Math.cos(a) * v;
    p.vy = Math.sin(a) * v;
    // a pinch of loose wax: nobody, not even Waxwell, gets a perfect table
    p.mu = MU * clamp(1 + gauss() * 0.03, 0.92, 1.08);
    p.pending = false;
    p.moving = true;
    this.phase = 'slide';
    this._slideT = 0;
    this._shotOff = [];
    this.el.turn.textContent = p.side === 'you' ? 'SLIDING...' : 'WAXWELL SLIDES';
    this.el.turn.classList.remove('mg-shuffle-yours');
    this.game.audio?.play?.('slide');
  }

  // ---- Waxwell's brain ----------------------------------------------------
  /** Forward-simulate one shot on an empty table (bias included). */
  _simShot(sy, angle, power) {
    let x = SPAWN_X, y = sy;
    const v = V_MIN + power * V_SPAN;
    let vx = Math.cos(angle) * v, vy = Math.sin(angle) * v;
    const dt = 1 / 120;
    for (let i = 0; i < 900; i++) {
      const sp = Math.hypot(vx, vy);
      if (sp < 4) break;
      vy += this._bias(x) * Math.min(1, sp / 200) * dt;
      const k = Math.max(0, sp - MU * dt) / sp;
      vx *= k; vy *= k;
      x += vx * dt; y += vy * dt;
      if (x > TL || x < 0 || y < 0 || y > TW) break;
    }
    return { x, y };
  }

  /** Solve for the (angle, power) that lands on a target, then blunt it. */
  _aiSolve(tx, ty) {
    const sy = SPAWN_Y.ai;
    const dx = tx - SPAWN_X, dy = ty - sy;
    const dTarget = Math.max(30, Math.hypot(dx, dy));
    const aTarget = Math.atan2(dy, dx);
    const naive = {
      angle: aTarget,
      power: clamp((Math.sqrt(2 * MU * dTarget) - V_MIN) / V_SPAN, 0, 1),
    };
    let angle = naive.angle, power = naive.power;
    for (let it = 0; it < 3; it++) {
      const s = this._simShot(sy, angle, power);
      const ds = Math.max(20, Math.hypot(s.x - SPAWN_X, s.y - sy));
      const as = Math.atan2(s.y - sy, s.x - SPAWN_X);
      angle = clamp(angle + (aTarget - as), -AIM_LIMIT, AIM_LIMIT);
      const v = clamp((V_MIN + power * V_SPAN) * Math.sqrt(dTarget / ds), V_MIN, V_MIN + V_SPAN);
      power = clamp((v - V_MIN) / V_SPAN, 0, 1);
    }
    // he only half-reads the wax in round one
    const c = this.aiComp;
    return {
      angle: naive.angle + c * (angle - naive.angle),
      power: naive.power + c * (power - naive.power),
    };
  }

  _aiPlan() {
    const live = this._live;
    const others = this.pucks.filter((p) => p !== live && !p.off && !p.pending);
    const mine = others.filter((p) => p.side === 'ai');
    const theirs = others.filter((p) => p.side === 'you');
    const t = this._tableScore();
    const behind = (this.banked.ai + t.ai) < (this.banked.you + t.you);
    const shotsLeft = 8 - this.shot;

    // is there a player puck worth removing?
    let target = null;
    let best = 0;
    for (const p of theirs) {
      const v = zoneOf(p.x);
      if (v > best) { best = v; target = p; }
    }
    // round one he mostly minds his own pucks; round two he comes for yours
    let knockChance = this.round === 1 ? (behind ? 0.4 : 0.18) : (behind ? 0.82 : 0.5);
    if (shotsLeft <= 2 && behind) knockChance += 0.15;
    const wantKnock = target && best >= 2 && (best >= 3 || behind) && Math.random() < knockChance;

    if (wantKnock) {
      // aim through the puck so it arrives with something to give
      const dx = target.x - SPAWN_X, dy = target.y - SPAWN_Y.ai;
      const len = Math.max(1, Math.hypot(dx, dy));
      const over = 96;
      const sol = this._aiSolve(target.x + (dx / len) * over, target.y + (dy / len) * over);
      return this._fuzz(sol, 'knock');
    }

    // otherwise park it somewhere valuable and empty. Round one he plays it
    // safe around the 2/3 line; round two he pushes for threes and hangers.
    const lanes = [30, 58, 85, 112, 140];
    const bands = this.round === 1
      ? [
        { x: 332, w: 1.0 },   // just over the two line
        { x: 358, w: 0.8 },   // toe into the threes
        { x: 302, w: 0.6 },   // a comfortable two
      ]
      : [
        { x: 386, w: 1.0 },   // deep three
        { x: 364, w: 0.85 },  // safe three
        { x: 408, w: 0.5 },   // greedy hanger
        { x: 316, w: 0.3 },   // two, when he is feeling shy
      ];
    let bestSpot = null, bestVal = -1e9;
    for (const b of bands) {
      for (const ly of lanes) {
        let clearance = 1e9;
        for (const p of others) clearance = Math.min(clearance, Math.hypot(p.x - b.x, p.y - ly));
        // hugging his own pucks is fine, crowding the player's is not
        const crowd = clearance < PR * 2.4 ? -60 : Math.min(clearance, 70) * 0.35;
        const edge = Math.min(ly, TW - ly) < PR * 2 ? -40 : 0;
        const val = b.w * 60 + crowd + edge + Math.random() * 14;
        if (val > bestVal) { bestVal = val; bestSpot = { x: b.x, y: ly }; }
      }
    }
    if (mine.length === 0 && this.round === 2 && Math.random() < 0.4) bestSpot.x = 372;
    return this._fuzz(this._aiSolve(bestSpot.x, bestSpot.y), 'place');
  }

  _fuzz(sol, kind) {
    const wobble = kind === 'knock' ? 1.15 : 1;
    return {
      angle: clamp(sol.angle + gauss() * this.aiSigA * wobble, -AIM_LIMIT, AIM_LIMIT),
      power: clamp(sol.power + gauss() * this.aiSigP * wobble, 0, 1),
    };
  }

  // ---- physics ------------------------------------------------------------
  _step(dt) {
    if (this.phase !== 'slide') return;
    this._slideT += dt;

    for (const p of this.pucks) {
      if (p.off || p.pending || !p.moving) continue;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp < 3.2 || this._slideT > 9) { p.vx = 0; p.vy = 0; p.moving = false; continue; }
      p.vy += this._bias(p.x) * Math.min(1, sp / 200) * dt;
      const sp2 = Math.max(1e-5, Math.hypot(p.vx, p.vy));
      const k = Math.max(0, sp2 - p.mu * dt) / sp2;
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.spin += sp * dt * 0.01;
      if (this.dust.length < 150 && Math.random() < sp * dt * 0.09) {
        this.dust.push({ x: p.x - p.vx * dt * 2, y: p.y - p.vy * dt * 2, t: 0, c: SIDE_COL[p.side] });
      }
      p.trail.push(p.x, p.y);
      if (p.trail.length > 8) p.trail.splice(0, 2);
    }

    // puck on puck
    const live = this.pucks.filter((p) => !p.off && !p.pending);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= PR * 2 || d === 0) continue;
        const nx = dx / d, ny = dy / d;
        const overlap = PR * 2 - d;
        a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel >= 0) continue;
        const imp = -(1.94) * rel * 0.5; // equal mass, restitution 0.94
        a.vx -= imp * nx; a.vy -= imp * ny;
        b.vx += imp * nx; b.vy += imp * ny;
        a.moving = true; b.moving = true;
        const hit = Math.abs(rel);
        if (hit > 26) {
          this.game.audio?.play?.(hit > 150 ? 'thud' : 'pop');
          if (hit > 170) this._shake();
        }
      }
    }

    // over the edge
    for (const p of this.pucks) {
      if (p.off || p.pending) continue;
      if (p.x > TL || p.x < -PR || p.y < 0 || p.y > TW) {
        p.off = true;
        p.offT = 0;
        p.moving = false;
        this._shotOff.push(p.side);
        this.game.audio?.play?.('fail');
        const fx = p.x > TL ? 'OFF THE END' : 'GUTTER!';
        this._float(fx, clamp(p.x, 20, TL - 20), clamp(p.y, 20, TW - 20), 'mg-shuffle-bad');
      }
    }

    // checked after the collision pass: a knock can wake a resting puck
    const busy = this.pucks.some((p) => p.moving && !p.off && !p.pending);
    if (!busy) this._resolveShot();
  }

  _shake() {
    const w = this.el.wrap;
    if (!w) return;
    w.classList.remove('mg-shuffle-quake');
    void w.offsetWidth;
    w.classList.add('mg-shuffle-quake');
  }

  _resolveShot() {
    if (this.phase !== 'slide') return;
    this.phase = 'settle';
    const shooter = this._live;
    const side = shooter ? shooter.side : 'you';
    const knockedYours = this._shotOff.filter((s) => s === 'you').length;
    const knockedTheirs = this._shotOff.filter((s) => s === 'ai').length;

    if (shooter && !shooter.off) {
      const z = zoneOf(shooter.x);
      if (z === 4) {
        this._float('HANGER! +4', shooter.x - 26, shooter.y, 'mg-shuffle-hang');
        this.game.audio?.play?.('sparkle');
        this.flash = { zone: 4, t: 0 };
      } else if (z > 0) {
        this._float(`+${z}`, shooter.x, shooter.y, z >= 3 ? 'mg-shuffle-good' : '');
        this.game.audio?.play?.(z >= 3 ? 'ding' : 'pop');
        this.flash = { zone: z, t: 0 };
      } else {
        this._float('SHORT', shooter.x, shooter.y, 'mg-shuffle-bad');
        this.game.audio?.play?.('thud');
      }
    }
    if (side === 'you' && knockedTheirs) {
      this._float('KNOCKED OUT!', TL * 0.62, 26, 'mg-shuffle-knock');
      this.game.audio?.play?.('combo');
    }
    if (side === 'ai' && knockedYours) {
      this.game.audio?.play?.('combo');
    }

    // Waxwell has opinions about all of this
    const z = shooter && !shooter.off ? zoneOf(shooter.x) : 0;
    if (side === 'you') {
      if (knockedTheirs) this._say('worried', pick(LINES.worried));
      else if (z >= 3) this._say('worried', z === 4 ? 'a HANGER? on my table? rude.' : 'oof. that is a good puck.');
      else if (z === 0 || (shooter && shooter.off)) this._say('smug', pick(LINES.smug));
      else this._say('idle', pick(LINES.idle));
    } else {
      if (shooter && shooter.off) this._say('worried', pick(LINES.worried));
      else if (knockedYours) this._say('smug', 'whoops. was that yours? terrible shame.');
      else if (z >= 3) this._say('smug', pick(LINES.smug));
      else if (z === 0) this._say('worried', 'i meant to do that. warming up.');
      else this._say('idle', 'steady does it.');
    }

    this.shot++;
    this._syncHud();
    this._live = null;
    this._after(760, () => {
      if (this.phase === 'settle') this._nextShot();
    });
  }

  // ---- scoring ------------------------------------------------------------
  _tableScore() {
    const t = { you: 0, ai: 0 };
    for (const p of this.pucks) {
      if (p.off || p.pending || p.banked) continue;
      t[p.side] += zoneOf(p.x);
    }
    return t;
  }

  _endRound() {
    this.phase = 'between';
    const t = this._tableScore();
    this.banked.you += t.you;
    this.banked.ai += t.ai;
    // the round is in the bank now: stop the live table counting it twice
    for (const p of this.pucks) p.banked = true;
    this.roundLog.push({ you: t.you, ai: t.ai });
    this._syncHud();
    const lead = this.banked.you - this.banked.ai;
    const note = lead > 0 ? 'you are ahead. he has noticed.'
      : lead < 0 ? 'he is ahead. he will not shut up about it.'
        : 'all square. tense!';
    this._banner(`ROUND ${this.round}: ${t.you} - ${t.ai}`, note);
    this.game.audio?.play?.(t.you >= t.ai ? 'success' : 'ding');
    this._after(2000, () => {
      this._hideBanner();
      for (const p of this.pucks) {
        if (p.off) continue; // already gone: leave it gone
        p.off = true; p.offT = 0; p.sweep = true;
      }
      this.game.audio?.play?.('whoosh');
      this._after(700, () => {
        if (this.round >= 2) this._results();
        else this._startRound(2);
      });
    });
  }

  // ---- ui plumbing --------------------------------------------------------
  _syncHud() {
    if (!this.el.round) return;
    const t = this._tableScore();
    const you = this.banked.you + t.you;
    const ai = this.banked.ai + t.ai;
    if (this.el.you.textContent !== String(you)) this._bumpChip(this.el.youChip);
    if (this.el.ai.textContent !== String(ai)) this._bumpChip(this.el.aiChip);
    this.el.round.textContent = String(this.round);
    this.el.you.textContent = String(you);
    this.el.ai.textContent = String(ai);

    const dots = this.el.dots;
    dots.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('span');
      const side = this._shooterAt(i);
      d.className = `mg-shuffle-dot${side === 'ai' ? ' mg-shuffle-ai' : ''}${i < this.shot ? ' mg-shuffle-spent' : ''}`;
      dots.appendChild(d);
    }
  }

  _bumpChip(chip) {
    if (!chip) return;
    chip.classList.remove('mg-shuffle-bump');
    void chip.offsetWidth;
    chip.classList.add('mg-shuffle-bump');
  }

  _say(expr, line) {
    this.expr = expr;
    if (this.el.face) paintFace(this.el.face, this._faceSize(), expr);
    const b = this.el.bubble;
    if (!b) return;
    b.textContent = line;
    b.classList.remove('mg-shuffle-pop');
    void b.offsetWidth;
    b.classList.add('mg-shuffle-pop');
  }

  _faceSize() {
    const w = this.el.wrap?.clientWidth || 900;
    return w < 900 ? 104 : 132;
  }

  _float(text, tx, ty, cls) {
    const v = this.view;
    if (!this.el.fx) return;
    const d = document.createElement('div');
    d.className = `mg-shuffle-float ${cls || ''}`;
    d.textContent = text;
    d.style.left = `${v.ox + tx * v.sc}px`;
    d.style.top = `${v.oy + ty * v.sc}px`;
    this.el.fx.appendChild(d);
    this._after(1150, () => d.remove());
  }

  _banner(title, note) {
    const b = this.el.banner;
    if (!b) return;
    b.innerHTML = `<div><h3>${title}</h3><p>${note}</p></div>`;
    b.classList.remove('mg-shuffle-gone');
  }

  _hideBanner() { this.el.banner?.classList.add('mg-shuffle-gone'); }

  // ---- input --------------------------------------------------------------
  _toTable(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - this.view.ox) / this.view.sc,
      y: (e.clientY - r.top - this.view.oy) / this.view.sc,
    };
  }

  _down(e) {
    if (this.phase !== 'aim' || !this._live) return;
    const p = this._toTable(e);
    const d = Math.hypot(p.x - this._live.x, p.y - this._live.y);
    if (d > 120) return; // must actually grab the puck
    this.dragging = true;
    this.canvas.classList.add('mg-shuffle-drag');
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* no capture, no problem */ }
    this._drag(p);
    this.game.audio?.play?.('hover');
  }

  _move(e) {
    if (!this.dragging || this.phase !== 'aim') return;
    this._drag(this._toTable(e));
  }

  _drag(p) {
    const dx = p.x - this._live.x;
    const dy = p.y - this._live.y;
    const len = Math.hypot(dx, dy);
    if (len < 4) { this.aim.power = 0; return; }
    this.aim.angle = clamp(Math.atan2(dy, dx), -AIM_LIMIT, AIM_LIMIT);
    this.aim.power = clamp(len / MAX_DRAG, 0, 1);
  }

  _up() {
    if (!this.dragging) return;
    this.dragging = false;
    this.canvas?.classList.remove('mg-shuffle-drag');
    if (this.phase !== 'aim') return;
    if (this.aim.power < 0.06) { this.aim.power = 0.55; return; }
    this._launch(this.aim.angle, this.aim.power);
  }

  _key(e) {
    if (e.key === 'Escape') { this.game.audio?.play?.('click'); this.quit(); return; }
    if (this.phase === 'splash' || this.phase === 'over') {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this._countdown(); }
      return;
    }
    if (this.phase !== 'aim') return;
    const fine = e.shiftKey ? 0.35 : 1;
    if (e.key === 'ArrowLeft') { this.aim.angle = clamp(this.aim.angle - 0.022 * fine, -AIM_LIMIT, AIM_LIMIT); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { this.aim.angle = clamp(this.aim.angle + 0.022 * fine, -AIM_LIMIT, AIM_LIMIT); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.aim.power = clamp(this.aim.power + 0.02 * fine, 0, 1); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { this.aim.power = clamp(this.aim.power - 0.02 * fine, 0, 1); e.preventDefault(); }
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (this.aim.power > 0.04) this._launch(this.aim.angle, this.aim.power);
    }
  }

  // ---- loop + draw --------------------------------------------------------
  _loop(t) {
    if (this._dead) return;
    this._raf = requestAnimationFrame((n) => this._loop(n));
    const dt = this._last ? Math.min(0.05, (t - this._last) / 1000) : 0;
    this._last = t;
    this.clock += dt;

    if (dt > 0) {
      // fixed-step physics so a hitchy frame cannot tunnel a puck off the table
      let acc = dt;
      while (acc > 0) {
        const s = Math.min(1 / 120, acc);
        this._step(s);
        acc -= s;
      }
      for (const p of this.pucks) if (p.off) p.offT += dt;
      for (let i = this.dust.length - 1; i >= 0; i--) {
        this.dust[i].t += dt;
        if (this.dust[i].t > 0.55) this.dust.splice(i, 1);
      }
      for (const s of this.sparks) {
        s.x += 4 * dt;
        s.y += this._bias(s.x) * 0.85 * dt;
        if (s.x > TL) s.x -= TL;
        if (s.y < -4) s.y += TW + 8;
        if (s.y > TW + 4) s.y -= TW + 8;
      }
      if (this.flash) {
        this.flash.t += dt;
        if (this.flash.t > 0.7) this.flash = null;
      }
    }
    this._draw();
  }

  _draw() {
    const cv = this.canvas, ctx = this.ctx;
    if (!cv || !ctx) return;
    const cw = cv.clientWidth || 1, ch = cv.clientHeight || 1;
    const d = dpr();
    if (cv.width !== Math.round(cw * d) || cv.height !== Math.round(ch * d)) {
      cv.width = Math.round(cw * d);
      cv.height = Math.round(ch * d);
      if (this.el.face) paintFace(this.el.face, this._faceSize(), this.expr);
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const sc = Math.min((cw - 26) / TL, (ch - 66) / TW);
    const ox = (cw - TL * sc) / 2;
    const oy = (ch - 52 - TW * sc) / 2 + 6;
    this.view = { sc, ox, oy };

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    this._drawTable(ctx, sc);
    this._drawSparks(ctx);
    this._drawDust(ctx);
    if (this.phase === 'aim' && this._live) this._drawAim(ctx, sc);
    this._drawPucks(ctx);
    ctx.restore();

    this._drawMeter(ctx, cw, ch, sc);
  }

  _drawTable(ctx, sc) {
    const px = 1 / sc;
    // frame + apron
    ctx.save();
    rrect(ctx, -13, -13, TL + 26, TW + 26, 16);
    ctx.fillStyle = lgrad(ctx, 0, -13, 0, TW + 13, '#5a3a1d', '#38230f');
    ctx.fill();
    ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
    ctx.restore();

    // playing surface
    rrect(ctx, 0, 0, TL, TW, 8);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = lgrad(ctx, 0, 0, 0, TW, '#e0aa6a', '#a56f34');
    ctx.fillRect(0, 0, TL, TW);
    // planks running the length of the table
    ctx.strokeStyle = 'rgba(90,52,20,.28)';
    ctx.lineWidth = 2 * px;
    for (let i = 1; i < 7; i++) {
      const y = (TW / 7) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(TL, y); ctx.stroke();
    }
    // grain
    ctx.strokeStyle = 'rgba(120,74,32,.16)';
    ctx.lineWidth = 1.4 * px;
    for (let i = 0; i < 26; i++) {
      const y = ((i * 53) % TW);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(TL * 0.3, y + 6, TL * 0.7, y - 6, TL, y + 2);
      ctx.stroke();
    }
    // polish sheen
    const sheen = ctx.createLinearGradient(0, 0, 0, TW);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.24, 'rgba(255,255,255,.26)');
    sheen.addColorStop(0.42, 'rgba(255,255,255,.05)');
    sheen.addColorStop(1, 'rgba(60,32,10,.22)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, TL, TW);

    // scoring bands
    const bands = [[FOUL, Z2, '1', 0.1], [Z2, Z3, '2', 0.15], [Z3, HANG, '3', 0.2], [HANG, TL, '4', 0.3]];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [a, b, label, alpha] of bands) {
      const lit = this.flash && this.flash.zone === Number(label)
        ? Math.max(0, 1 - this.flash.t / 0.7) : 0;
      ctx.fillStyle = `rgba(255,246,227,${alpha * 0.55 + lit * 0.4})`;
      ctx.fillRect(a, 0, b - a, TW);
      ctx.strokeStyle = 'rgba(255,246,227,.8)';
      ctx.lineWidth = 2.6 * px;
      ctx.beginPath(); ctx.moveTo(a, 0); ctx.lineTo(a, TW); ctx.stroke();
      ctx.fillStyle = `rgba(255,246,227,${0.5 + lit * 0.5})`;
      // the hanger band is only 16 units wide: a full-size glyph gets clipped
      const fs = label === '4' ? 26 : 74;
      ctx.font = `900 ${fs}px "Trebuchet MS","Segoe UI",sans-serif`;
      ctx.fillText(label, (a + b) / 2, TW / 2);
    }
    // near line
    ctx.strokeStyle = '#e8657a';
    ctx.lineWidth = 3.4 * px;
    ctx.setLineDash([13, 9]);
    ctx.beginPath(); ctx.moveTo(FOUL, 0); ctx.lineTo(FOUL, TW); ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate(FOUL - 9, TW / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(232,101,122,.9)';
    ctx.font = '900 15px "Trebuchet MS",sans-serif';
    ctx.fillText('NEAR LINE', 0, 0);
    ctx.restore();
    // shooting area
    ctx.strokeStyle = 'rgba(255,246,227,.45)';
    ctx.lineWidth = 2.2 * px;
    ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(96, 0); ctx.lineTo(96, TW); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // lip highlight at the hanging edge
    ctx.strokeStyle = 'rgba(255,240,200,.9)';
    ctx.lineWidth = 3 * px;
    ctx.beginPath(); ctx.moveTo(TL, 2); ctx.lineTo(TL, TW - 2); ctx.stroke();
  }

  _drawSparks(ctx) {
    for (const s of this.sparks) {
      const a = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(this.clock * 3 + s.p));
      ctx.fillStyle = `rgba(255,250,220,${a})`;
      const r = 1.5 * s.s;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r * 2.2);
      ctx.lineTo(s.x + r, s.y);
      ctx.lineTo(s.x, s.y + r * 2.2);
      ctx.lineTo(s.x - r, s.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawDust(ctx) {
    for (const d of this.dust) {
      const a = Math.max(0, 1 - d.t / 0.55) * 0.4;
      ctx.fillStyle = `rgba(255,246,227,${a})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, 2.4 + d.t * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawAim(ctx, sc) {
    const p = this._live;
    const px = 1 / sc;
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 4);

    // grab ring
    ctx.strokeStyle = `rgba(255,246,227,${0.25 + pulse * 0.3})`;
    ctx.lineWidth = 2.4 * px;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PR + 6 + pulse * 4, 0, Math.PI * 2);
    ctx.stroke();

    if (this.aim.power <= 0.02) return;

    // predicted path, wax and all
    const path = [];
    let x = p.x, y = p.y;
    const v = V_MIN + this.aim.power * V_SPAN;
    let vx = Math.cos(this.aim.angle) * v, vy = Math.sin(this.aim.angle) * v;
    const dt = 1 / 90;
    for (let i = 0; i < 700; i++) {
      const sp = Math.hypot(vx, vy);
      if (sp < 4) break;
      vy += this._bias(x) * Math.min(1, sp / 200) * dt;
      const k = Math.max(0, sp - MU * dt) / sp;
      vx *= k; vy *= k;
      x += vx * dt; y += vy * dt;
      if (i % 4 === 0) path.push(x, y);
      if (x > TL + 6 || x < 0 || y < -6 || y > TW + 6) break;
    }
    ctx.setLineDash([9, 8]);
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(255,246,227,.6)';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    for (let i = 0; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
    ctx.stroke();
    ctx.setLineDash([]);

    // ghost landing spot
    const gx = path.length ? path[path.length - 2] : p.x;
    const gy = path.length ? path[path.length - 1] : p.y;
    const offTable = gx > TL || gy < 0 || gy > TW;
    const z = offTable ? 0 : zoneOf(gx);
    ctx.strokeStyle = offTable ? 'rgba(255,150,130,.9)' : z >= 3 ? 'rgba(150,240,170,.95)' : 'rgba(255,246,227,.8)';
    ctx.lineWidth = 3 * px;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.arc(clamp(gx, 0, TL), clamp(gy, 0, TW), PR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = offTable ? 'OFF!' : ZONE_NAME[z];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 13px "Trebuchet MS",sans-serif';
    // a dark pill so the call-out reads over the big band numerals, kept fully
    // on the table by its own measured width
    const tw = ctx.measureText(label).width;
    const lx = clamp(gx, tw / 2 + 10, TL - tw / 2 - 10);
    const ly = clamp(gy, 6, TW) - PR - 14;
    ctx.fillStyle = 'rgba(30,18,10,.72)';
    rrect(ctx, lx - tw / 2 - 6, ly - 9, tw + 12, 18, 9);
    ctx.fill();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(label, lx, ly);

    // the push: a wedge along the aim line as long as the power you loaded
    const reach = this.aim.power * MAX_DRAG;
    const bx = p.x + Math.cos(this.aim.angle) * reach;
    const by = p.y + Math.sin(this.aim.angle) * reach;
    const wedge = ctx.createLinearGradient(p.x, p.y, bx, by);
    wedge.addColorStop(0, 'rgba(242,182,74,.15)');
    wedge.addColorStop(1, 'rgba(242,182,74,.85)');
    ctx.strokeStyle = wedge;
    ctx.lineWidth = 7 * px;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y); ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.fillStyle = '#f2b64a';
    ctx.beginPath(); ctx.arc(bx, by, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2 * px; ctx.strokeStyle = 'rgba(58,42,28,.8)'; ctx.stroke();
  }

  _drawPucks(ctx) {
    for (const p of this.pucks) {
      if (p.off) {
        const k = clamp(p.offT / (p.sweep ? 0.7 : 0.55), 0, 1);
        if (k >= 1) continue;
        ctx.save();
        const dx = p.sweep ? k * 90 : k * 26;
        ctx.translate(p.x + dx, p.y + k * 14);
        ctx.rotate(k * 1.6);
        ctx.scale(1 - k * 0.5, 1 - k * 0.5);
        // drawPuck owns globalAlpha, so the fade has to go through it
        drawPuck(ctx, 0, 0, SIDE_COL[p.side], 1 - k);
        ctx.restore();
        continue;
      }
      // motion ghosts
      if (p.moving) {
        for (let i = 0; i < p.trail.length; i += 2) {
          const a = 0.05 + (i / Math.max(2, p.trail.length)) * 0.16;
          drawPuck(ctx, p.trail[i], p.trail[i + 1], SIDE_COL[p.side], a);
        }
      }
      drawPuck(ctx, p.x, p.y, SIDE_COL[p.side], p.pending ? 0.92 : 1);
    }
  }

  /** Power meter + zone key, drawn in the strip under the table. */
  _drawMeter(ctx, cw, ch, sc) {
    const y = this.view.oy + TW * sc + 22;
    const w = Math.min(360, cw * 0.5);
    const x = (cw - w) / 2;
    const showing = this.phase === 'aim' || this.phase === 'slide' || this.phase === 'think';
    if (!showing) return;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 11px "Trebuchet MS",sans-serif';

    if (this.phase === 'aim') {
      const h = 15;
      ctx.fillStyle = 'rgba(0,0,0,.42)';
      const r = h / 2;
      rrect(ctx, x, y, w, h, r); ctx.fill();
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, '#7ac74f'); g.addColorStop(0.55, '#f2b64a'); g.addColorStop(1, '#e8657a');
      ctx.save();
      rrect(ctx, x, y, w, h, r); ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w * this.aim.power, h);
      ctx.restore();
      // marks solved from the real friction curve: where each band begins
      ctx.strokeStyle = 'rgba(255,246,227,.55)';
      ctx.lineWidth = 2;
      for (const [frac, label] of [[0.228, '1'], [0.469, '2'], [0.648, '3'], [0.809, '4']]) {
        const mx = x + w * frac;
        ctx.beginPath(); ctx.moveTo(mx, y - 3); ctx.lineTo(mx, y + h + 3); ctx.stroke();
        ctx.fillStyle = 'rgba(255,246,227,.75)';
        ctx.fillText(label, mx, y + h + 12);
      }
      // past here the puck leaves the building
      ctx.fillStyle = 'rgba(255,140,120,.75)';
      ctx.fillRect(x + w * 0.849, y - 4, Math.max(2, w * 0.151), 3);
      ctx.fillStyle = '#fff6e3';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(this.aim.power * 100)}%`, x - 10, y + h / 2);
      ctx.textAlign = 'left';
      ctx.fillText('POWER', x + w + 10, y + h / 2);
    } else {
      ctx.fillStyle = 'rgba(255,246,227,.6)';
      ctx.fillText(this.phase === 'think' ? 'WAXWELL IS LINING IT UP...' : 'SLIDING...', cw / 2, y + 8);
    }
    ctx.restore();
  }
}
