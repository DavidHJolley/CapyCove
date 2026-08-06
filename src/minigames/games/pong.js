import { Minigame } from '../minigame.js';
import { clampCoinsForGame } from '../../../shared/constants.js';

/**
 * Paddle Panic : the Game Den's arcade cabinet, one-on-one against Blip, the
 * house champ capybara.
 *
 * The whole minigame is a cabinet: marquee, side art with Blip's portrait, a
 * phosphor CRT (2D canvas + scanline/vignette overlays) and a control deck.
 * Everything is drawn procedurally; no WebGL, no assets.
 *
 * Difficulty escalates three ways during a match: the ball gains speed on every
 * return, each new serve starts faster than the last, and Blip's reaction time /
 * paddle speed / aim error rubber-band around the score (he sharpens up when you
 * lead, eases off when he does, and is never perfect either way).
 *
 * Score = points won * 100 + rally bonus (1 per return you make, capped at 99),
 * so a score always reads as "points.rallies" and a win is always >= 500.
 */

// ---------------------------------------------------------------------------
// field + rules (logical units; the canvas letterboxes these into the bezel)
// ---------------------------------------------------------------------------
const FW = 560;
const FH = 360;
const WALL = 9;                 // glowing frame bars, top and bottom
const TOP = WALL;
const BOT = FH - WALL;

const PW = 13;                  // paddle width
const PH = 64;                  // paddle height
const BALL_R = 7;
const AI_X = 34;                // Blip is on the left
const P_X = FW - 34;            // you are on the right

const WIN_POINTS = 5;
const SERVE_SPEED = 268;
const MAX_SPEED = 660;
const RALLY_MAX_SPEED = 820;    // long rallies push the ceiling past the cap
const SPEEDUP = 1.042;          // per return
const MAX_ANG = 0.95;           // paddle-edge english, radians off the axis
const KEY_SPEED = 470;          // px/s for W/S and the arrows
const MOUSE_TRACK = 24;         // lerp rate for pointer steering
const RALLY_BONUS_CAP = 99;

// payout: a clean 5-0 sweep is exactly the server cap for 'pong' (60)
const WIN_BASE = 40;
const WIN_STEP = 4;
const LOSS_COINS = 5;

// ---------------------------------------------------------------------------
// palette (cove colors, pushed to phosphor brightness on the dark screen)
// ---------------------------------------------------------------------------
const INK = '#2d2417';
const C = {
  screenTop: '#1a1230',
  screenBot: '#0e0a1c',
  grid: 'rgba(126,180,255,0.055)',
  cream: '#fff6e3',
  coral: '#e8657a',
  sky: '#4fb3e8',
  gold: '#f2b64a',
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];

// ---------------------------------------------------------------------------
// Blip: portrait art, same grammar as the smoothie customers (200x200 grid)
// ---------------------------------------------------------------------------
const FUR = '#bb8f5e';
const FUR_DARK = '#8d6841';
const MUZZLE = '#dcb586';
const CUP = '#4fb3e8';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ink(ctx, w = 5) {
  ctx.lineWidth = w;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

/**
 * expr: idle | thinking | smug | worried | beaten
 * gaze: -1..1, shifts the eyes as Blip follows the ball
 */
function drawBlip(ctx, size, expr, gaze, blink) {
  const s = size / 200;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const droop = expr === 'beaten' ? 1 : 0;
  const gx = clamp(gaze, -1, 1) * 3.4;

  // shoulders
  rr(ctx, 48, 150, 104, 60, 30);
  ctx.fillStyle = FUR_DARK; ctx.fill(); ink(ctx, 5);

  // ears (they flop when he is beaten)
  for (const side of [-1, 1]) {
    const ex = 100 + side * 54;
    const ey = 48 + droop * 16;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(side * (-0.3 - droop * 0.5));
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 17, 0, 0, Math.PI * 2);
    ctx.fillStyle = FUR_DARK; ctx.fill(); ink(ctx, 5);
    ctx.beginPath(); ctx.ellipse(0, 2, 9, 7, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a3a8'; ctx.fill();
    ctx.restore();
  }

  // head
  rr(ctx, 38, 36, 124, 104, 42);
  const g = ctx.createLinearGradient(38, 36, 162, 140);
  g.addColorStop(0, '#d3aa78'); g.addColorStop(1, FUR);
  ctx.fillStyle = g; ctx.fill(); ink(ctx, 5.5);

  // muzzle
  rr(ctx, 58, 96, 84, 58, 26);
  ctx.fillStyle = MUZZLE; ctx.fill(); ink(ctx, 4.5);

  // nostrils
  ctx.fillStyle = INK;
  for (const nx of [86, 114]) {
    ctx.save(); ctx.translate(nx, 116); ctx.rotate(nx < 100 ? 0.5 : -0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 3.2, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // mouth
  ctx.lineWidth = 4.5; ctx.strokeStyle = INK;
  if (expr === 'smug') {
    ctx.beginPath();
    ctx.moveTo(84, 132); ctx.quadraticCurveTo(100, 142, 118, 126); ctx.stroke();
  } else if (expr === 'thinking') {
    ctx.beginPath(); ctx.ellipse(100, 133, 8, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
  } else if (expr === 'worried') {
    ctx.beginPath();
    ctx.moveTo(86, 132); ctx.quadraticCurveTo(93, 138, 100, 132);
    ctx.quadraticCurveTo(107, 126, 114, 132); ctx.stroke();
  } else if (expr === 'beaten') {
    ctx.beginPath();
    ctx.moveTo(84, 140); ctx.quadraticCurveTo(100, 118, 116, 140);
    ctx.quadraticCurveTo(100, 132, 84, 140); ctx.closePath();
    ctx.fillStyle = '#5c3327'; ctx.fill(); ink(ctx, 4);
  } else {
    ctx.beginPath(); ctx.moveTo(88, 130); ctx.quadraticCurveTo(100, 140, 112, 130); ctx.stroke();
  }

  // eyes
  const eyes = [70, 130];
  for (let i = 0; i < 2; i++) {
    const ex = eyes[i];
    ctx.lineWidth = 5; ctx.strokeStyle = INK;
    if (blink || expr === 'beaten') {
      ctx.beginPath();
      ctx.moveTo(ex - 11, 78);
      ctx.quadraticCurveTo(ex, expr === 'beaten' ? 66 : 88, ex + 11, 78);
      ctx.stroke();
    } else if (expr === 'smug') {
      // half-lidded: a flat lid over a small bead
      ctx.beginPath(); ctx.ellipse(ex + gx, 79, 8, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = INK; ctx.fill();
      ctx.beginPath(); ctx.moveTo(ex - 12, 72); ctx.lineTo(ex + 12, 74); ctx.stroke();
    } else {
      const r = expr === 'worried' ? 8 : expr === 'thinking' ? 9 : 10;
      ctx.beginPath(); ctx.ellipse(ex + gx, 76, r, r + 1.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = INK; ctx.fill();
      ctx.beginPath(); ctx.arc(ex + gx - 3.4, 72, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    // brows
    ctx.lineWidth = 4.6; ctx.strokeStyle = INK;
    if (expr === 'worried') {
      ctx.beginPath();
      ctx.moveTo(ex + (i ? 12 : -12), 60); ctx.lineTo(ex + (i ? -5 : 5), 55); ctx.stroke();
    } else if (expr === 'thinking') {
      ctx.beginPath();
      ctx.moveTo(ex - 11, i ? 54 : 60); ctx.lineTo(ex + 11, i ? 60 : 58); ctx.stroke();
    } else if (expr === 'smug' && i === 1) {
      ctx.beginPath();
      ctx.moveTo(ex - 12, 58); ctx.quadraticCurveTo(ex, 50, ex + 12, 57); ctx.stroke();
    }
  }

  // blush / sweat / sparkle
  if (expr === 'idle' || expr === 'smug') {
    ctx.fillStyle = 'rgba(232,101,122,0.3)';
    ctx.beginPath(); ctx.ellipse(52, 104, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(148, 104, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (expr === 'worried' || expr === 'beaten') {
    ctx.beginPath();
    ctx.moveTo(170, 62); ctx.quadraticCurveTo(180, 76, 170, 82);
    ctx.quadraticCurveTo(160, 76, 170, 62); ctx.closePath();
    ctx.fillStyle = '#9ed9f2'; ctx.fill(); ink(ctx, 3.5);
  }
  if (expr === 'smug') {
    ctx.fillStyle = C.gold;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 ? 3.5 : 9;
      ctx.lineTo(172 + Math.cos(a) * r, 44 + Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
  }
  if (expr === 'thinking') {
    ctx.fillStyle = 'rgba(255,246,227,0.85)';
    for (const [dx, dy, r] of [[168, 34, 4], [180, 24, 5.5], [193, 13, 7]]) {
      ctx.beginPath(); ctx.arc(dx, dy, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // arcade headset: cream band + sky-blue cups
  ctx.beginPath();
  ctx.moveTo(40, 52);
  ctx.quadraticCurveTo(100, -2, 160, 52);
  ctx.lineWidth = 11; ctx.strokeStyle = C.cream; ctx.lineCap = 'round'; ctx.stroke();
  ctx.lineWidth = 3.2; ctx.strokeStyle = INK; ctx.stroke();
  for (const cx of [36, 164]) {
    rr(ctx, cx - 13, 56, 26, 34, 12);
    ctx.fillStyle = CUP; ctx.fill(); ink(ctx, 4.5);
    ctx.beginPath(); ctx.ellipse(cx, 73, 6, 9, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,246,227,0.45)'; ctx.fill();
  }
  // mic boom
  ctx.beginPath();
  ctx.moveTo(164, 86); ctx.quadraticCurveTo(168, 112, 146, 120);
  ctx.lineWidth = 5; ctx.strokeStyle = C.cream; ctx.stroke();
  ctx.lineWidth = 2.4; ctx.strokeStyle = INK; ctx.stroke();
  ctx.beginPath(); ctx.arc(144, 121, 6, 0, Math.PI * 2);
  ctx.fillStyle = C.coral; ctx.fill(); ink(ctx, 3.4);

  // paws on the control deck, right one on a little joystick
  for (const px of [46, 120]) {
    rr(ctx, px, 168, 34, 24, 12);
    ctx.fillStyle = MUZZLE; ctx.fill(); ink(ctx, 4.5);
    ctx.lineWidth = 3; ctx.strokeStyle = '#8a6642';
    for (let k = 1; k < 3; k++) {
      ctx.beginPath(); ctx.moveTo(px + k * 11, 172); ctx.lineTo(px + k * 11, 182); ctx.stroke();
    }
  }
  ctx.beginPath(); ctx.moveTo(137, 190); ctx.lineTo(137, 166);
  ctx.lineWidth = 7; ctx.strokeStyle = C.cream; ctx.stroke();
  ctx.beginPath(); ctx.arc(137, 162, 10, 0, Math.PI * 2);
  ctx.fillStyle = C.coral; ctx.fill(); ink(ctx, 4);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// seven-segment scoreboard digits (no fonts: this is a cabinet)
// ---------------------------------------------------------------------------
const SEGS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgcde', 'abc', 'abcdefg', 'abcdfg'];

function drawDigit(ctx, d, x, y, w, h, t, color) {
  const on = SEGS[d] || '';
  const x0 = x;
  const x1 = x + w;
  const y0 = y;
  const y1 = y + h;
  const ym = y + h / 2;
  const i = t * 0.62; // pull segment ends in so the corners do not blob
  const lines = {
    a: [x0 + i, y0, x1 - i, y0],
    b: [x1, y0 + i, x1, ym - i],
    c: [x1, ym + i, x1, y1 - i],
    d: [x0 + i, y1, x1 - i, y1],
    e: [x0, ym + i, x0, y1 - i],
    f: [x0, y0 + i, x0, ym - i],
    g: [x0 + i, ym, x1 - i, ym],
  };
  ctx.lineWidth = t;
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  for (const k of 'abcdefg') {
    const lit = on.includes(k);
    ctx.globalAlpha = lit ? 1 : 0.075;
    ctx.shadowBlur = lit ? 16 : 0;
    ctx.shadowColor = color;
    const [ax, ay, bx, by] = lines[k];
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

// ---------------------------------------------------------------------------
// Blip's chatter (lowercase, warm, a little smug)
// ---------------------------------------------------------------------------
const TAUNTS = {
  start: ['first to five. loser buys smoothies', 'i have been practising, fair warning', 'lets keep it friendly'],
  ai: ['too slow, friend', 'ooh, that one curved', 'the paddle knows things', 'still just warming up'],
  you: ['hey! lucky bounce', 'okay okay, my turn', 'nice angle, honestly', 'i let you have that one'],
  rally: ['this is the good stuff', 'we could do this all day', 'my paws are sweating'],
  matchYou: ['match point? on my cabinet?'],
  matchAi: ['match point. no pressure'],
  win: ['still the house champ. barely.'],
  lose: ['good game! rematch whenever'],
};

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------
const STYLE = `
.mg-pong-root{position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;justify-content:center;
  font-family:"Trebuchet MS","Segoe UI",system-ui,sans-serif;color:#fff6e3;user-select:none;
  -webkit-user-select:none;padding:clamp(6px,1.5vh,18px);
  background:radial-gradient(ellipse 85% 65% at 50% 4%,#40305e 0%,#261b3a 46%,#140e22 100%);}
.mg-pong-root *{box-sizing:border-box;}

/* ---- arcade hall behind the cabinet ---- */
.mg-pong-hall{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.mg-pong-neon{position:absolute;border-radius:999px;filter:blur(40px);opacity:.42;
  animation:mg-pong-breathe 6s ease-in-out infinite;}
@keyframes mg-pong-breathe{0%,100%{opacity:.32;transform:scale(1)}50%{opacity:.5;transform:scale(1.08)}}
.mg-pong-carpet{position:absolute;left:-4%;right:-4%;bottom:0;height:32%;
  background:
    repeating-linear-gradient(74deg,rgba(232,101,122,.14) 0 12px,rgba(0,0,0,0) 12px 46px),
    repeating-linear-gradient(-74deg,rgba(79,179,232,.12) 0 12px,rgba(0,0,0,0) 12px 46px),
    linear-gradient(180deg,#22183a,#2e2049);
  transform:perspective(300px) rotateX(46deg);transform-origin:bottom center;opacity:.85;}

/* ---- the cabinet ---- */
.mg-pong-cab{position:relative;z-index:2;display:flex;flex-direction:column;gap:clamp(7px,1.2vh,13px);
  width:min(1120px,96vw);max-height:100%;padding:clamp(9px,1.5vh,16px);border-radius:26px;
  background:linear-gradient(180deg,#412f5d 0%,#2b1f42 55%,#1d142c 100%);
  border:3px solid rgba(255,246,227,.16);
  box-shadow:0 26px 60px rgba(0,0,0,.6),inset 0 2px 0 rgba(255,255,255,.13);}

.mg-pong-marquee{display:flex;align-items:center;justify-content:center;gap:clamp(8px,1.4vw,16px);
  padding:clamp(5px,1vh,10px) 18px;border-radius:15px;flex:none;
  background:linear-gradient(180deg,#fff6e3,#ffe4bd);
  box-shadow:0 5px 0 rgba(0,0,0,.3),inset 0 -4px 0 rgba(232,101,122,.16);}
.mg-pong-marquee h1{font-size:clamp(15px,2.4vw,28px);letter-spacing:.16em;color:#e8657a;line-height:1.1;
  text-shadow:0 2px 0 rgba(232,101,122,.22);}
.mg-pong-lamp{width:9px;height:9px;border-radius:50%;background:#f2b64a;flex:none;
  box-shadow:0 0 9px #f2b64a;animation:mg-pong-lamp 1.5s ease-in-out infinite;}
@keyframes mg-pong-lamp{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}

.mg-pong-mid{display:flex;gap:clamp(8px,1.2vw,16px);align-items:stretch;justify-content:center;min-height:0;}

/* ---- side art: Blip ---- */
.mg-pong-side{flex:none;width:clamp(146px,16vw,196px);display:flex;flex-direction:column;align-items:center;
  gap:7px;padding:10px 9px;border-radius:18px;
  background:linear-gradient(180deg,rgba(232,101,122,.24),rgba(79,179,232,.14));
  border:2px solid rgba(255,246,227,.14);text-align:center;}
.mg-pong-face{display:block;width:140px;height:140px;animation:mg-pong-bob 2.7s ease-in-out infinite;}
@keyframes mg-pong-bob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-6px) rotate(1.5deg)}}
.mg-pong-plate{background:#fff6e3;color:#2d2417;border-radius:999px;padding:3px 14px;font-weight:900;
  font-size:13px;letter-spacing:.06em;box-shadow:0 4px 0 rgba(0,0,0,.28);}
.mg-pong-title{font-size:9.5px;letter-spacing:.16em;font-weight:900;color:rgba(255,246,227,.62);}
.mg-pong-bubble{position:relative;background:#fff6e3;color:#2d2417;border-radius:14px;padding:7px 11px;
  font-size:11.5px;font-weight:800;line-height:1.3;box-shadow:0 5px 12px rgba(0,0,0,.35);
  opacity:0;transform:scale(.6);transition:opacity .18s ease,transform .22s cubic-bezier(.2,1.5,.4,1);}
.mg-pong-bubble.mg-pong-on{opacity:1;transform:none;}
.mg-pong-bubble::after{content:"";position:absolute;top:-9px;left:50%;margin-left:-8px;
  border:8px solid transparent;border-bottom-color:#fff6e3;border-top:0;}

/* ---- the screen ---- */
.mg-pong-screenwrap{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;}
/* the screen keeps the field's 14:9 no matter which axis runs out first, so the
   phosphor art never letterboxes inside its own bezel */
.mg-pong-bezel{--mg-pong-sh:min(58vh,540px);position:relative;margin:auto;
  width:min(100%,calc(var(--mg-pong-sh) * 14 / 9));aspect-ratio:14/9;max-height:var(--mg-pong-sh);
  border-radius:22px;background:#07050f;border:clamp(6px,.9vw,12px) solid #150f24;overflow:hidden;
  touch-action:none;cursor:crosshair;
  box-shadow:inset 0 0 48px rgba(0,0,0,.95),0 0 0 3px rgba(255,246,227,.09),0 16px 34px rgba(0,0,0,.55);}
.mg-pong-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}
.mg-pong-scan{position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(180deg,rgba(0,0,0,.36) 0 1px,rgba(0,0,0,0) 1px 3px);}
.mg-pong-vig{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(ellipse 76% 72% at 50% 50%,rgba(0,0,0,0) 44%,rgba(0,0,0,.66) 100%);}
.mg-pong-sweep{position:absolute;left:0;right:0;height:34%;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,0),rgba(255,255,255,.05),rgba(255,255,255,0));
  animation:mg-pong-sweep 7.5s linear infinite;}
@keyframes mg-pong-sweep{from{transform:translateY(-120%)}to{transform:translateY(320%)}}
.mg-pong-glare{position:absolute;left:-12%;top:-34%;width:72%;height:74%;pointer-events:none;
  transform:rotate(-14deg);
  background:radial-gradient(ellipse at 34% 34%,rgba(255,255,255,.11),rgba(255,255,255,0) 62%);}

/* ---- control deck ---- */
.mg-pong-deck{flex:none;display:flex;align-items:center;justify-content:center;gap:clamp(6px,1vw,12px);
  flex-wrap:wrap;padding:clamp(6px,1vh,11px) 14px;border-radius:16px;
  background:linear-gradient(180deg,#513a70,#33244d);border:2px solid rgba(255,246,227,.13);
  box-shadow:inset 0 3px 0 rgba(255,255,255,.09);}
.mg-pong-chip{display:flex;align-items:center;gap:7px;background:rgba(13,9,22,.55);border-radius:999px;
  padding:5px 13px;font-size:11px;font-weight:900;letter-spacing:.1em;color:rgba(255,246,227,.6);}
.mg-pong-chip b{color:#fff6e3;font-size:14px;letter-spacing:.04em;}
.mg-pong-bars{display:flex;gap:3px;align-items:center;}
.mg-pong-bars i{width:7px;height:13px;border-radius:2px;background:rgba(255,246,227,.16);transition:.18s;}
.mg-pong-bars i.mg-pong-on{background:#f2b64a;box-shadow:0 0 8px rgba(242,182,74,.8);}
.mg-pong-hint{font-size:11px;font-weight:800;letter-spacing:.08em;color:rgba(255,246,227,.5);}
.mg-pong-quit{margin-left:auto;border:0;background:rgba(13,9,22,.6);color:#fff6e3;font-family:inherit;
  font-weight:900;font-size:12px;letter-spacing:.12em;padding:8px 18px;border-radius:999px;cursor:pointer;
  transition:.14s;}
.mg-pong-quit:hover{background:#c94a3e;transform:scale(1.06);}

/* ---- on-screen overlays (attract mode / countdown / results) ---- */
/* align-items:flex-start + margin:auto centres the card when it fits and keeps
   the top reachable when it does not (centred flex items clip their overflow) */
.mg-pong-over{position:absolute;inset:0;z-index:5;display:flex;align-items:flex-start;justify-content:center;
  padding:clamp(8px,2.2vh,24px);text-align:center;overflow:auto;
  background:radial-gradient(ellipse 92% 92% at 50% 45%,rgba(21,15,38,.88),rgba(7,5,15,.96));}
.mg-pong-over.mg-pong-gone{display:none;}
.mg-pong-card{width:min(560px,100%);margin:auto;animation:mg-pong-card .32s cubic-bezier(.2,1.35,.4,1);}
@keyframes mg-pong-card{from{transform:scale(.86) translateY(14px);opacity:0}}
.mg-pong-card h2{font-size:clamp(19px,3.2vw,32px);color:#f2b64a;letter-spacing:.1em;line-height:1.1;
  text-shadow:0 0 20px rgba(242,182,74,.45);}
.mg-pong-sub{font-size:clamp(10px,1.3vw,12.5px);letter-spacing:.16em;font-weight:900;
  color:rgba(255,246,227,.6);margin:5px 0 11px;}
.mg-pong-legend{display:flex;justify-content:center;gap:clamp(8px,1.6vw,18px);flex-wrap:wrap;margin-bottom:11px;}
.mg-pong-legend span{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:900;
  letter-spacing:.1em;color:rgba(255,246,227,.72);}
.mg-pong-sw{width:8px;height:22px;border-radius:4px;display:block;}
.mg-pong-sw.mg-pong-you{background:#e8657a;box-shadow:0 0 12px rgba(232,101,122,.9);}
.mg-pong-sw.mg-pong-them{background:#4fb3e8;box-shadow:0 0 12px rgba(79,179,232,.9);}
.mg-pong-sw.mg-pong-ball{width:14px;height:14px;border-radius:50%;background:#f2b64a;
  box-shadow:0 0 14px rgba(242,182,74,.95);}
.mg-pong-rules{display:grid;gap:5px;text-align:left;margin-bottom:11px;}
.mg-pong-rules div{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:12px;
  background:rgba(255,246,227,.07);border:1px solid rgba(255,246,227,.11);
  font-size:clamp(10.5px,1.25vw,13px);font-weight:700;line-height:1.32;}
.mg-pong-rules i{flex:none;width:24px;height:24px;border-radius:8px;background:#e8657a;color:#fff6e3;
  font-style:normal;font-weight:900;font-size:12px;display:flex;align-items:center;justify-content:center;}
.mg-pong-rules b{color:#f2b64a;}
.mg-pong-stats{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:9px 0 13px;}
.mg-pong-stat{background:rgba(255,246,227,.08);border-radius:14px;padding:7px 15px;min-width:84px;}
.mg-pong-stat b{display:block;font-size:clamp(17px,2.5vw,25px);color:#fff6e3;line-height:1.15;}
.mg-pong-stat span{font-size:9.5px;letter-spacing:.14em;font-weight:900;color:rgba(255,246,227,.5);}
.mg-pong-stat.mg-pong-gold b{color:#f2b64a;}
.mg-pong-ribbon{display:inline-block;background:#f2b64a;color:#2d2417;font-weight:900;letter-spacing:.14em;
  font-size:10.5px;padding:5px 15px;border-radius:999px;margin-bottom:7px;
  animation:mg-pong-pulse .9s ease-in-out infinite;}
@keyframes mg-pong-pulse{50%{transform:scale(1.07)}}
/* sticky: on a short cabinet the rules scroll, PRESS START never does */
.mg-pong-btns{position:sticky;bottom:-2px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;
  padding:9px 0 3px;background:rgba(9,6,18,.97);box-shadow:0 -12px 14px rgba(9,6,18,.97);}
.mg-pong-btn{border:3px solid #fff6e3;border-radius:999px;background:#e8657a;color:#fff6e3;font-family:inherit;
  font-weight:900;font-size:clamp(12px,1.5vw,16px);letter-spacing:.06em;padding:10px 24px;cursor:pointer;
  box-shadow:0 6px 0 rgba(0,0,0,.36);transition:transform .12s cubic-bezier(.2,1.35,.4,1),filter .15s;}
.mg-pong-btn:hover{transform:translateY(-2px) scale(1.04);filter:brightness(1.07);}
.mg-pong-btn:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(0,0,0,.36);}
.mg-pong-btn:focus-visible{outline:3px solid #f2b64a;outline-offset:3px;}
.mg-pong-btn.mg-pong-alt{background:#4fb3e8;}
.mg-pong-btn.mg-pong-ghost{background:transparent;border-color:rgba(255,246,227,.36);box-shadow:none;
  color:rgba(255,246,227,.85);}
.mg-pong-count{font-size:clamp(56px,13vw,132px);font-weight:900;color:#fff6e3;line-height:1;
  text-shadow:0 0 34px rgba(79,179,232,.75);animation:mg-pong-count .6s ease-out;}
@keyframes mg-pong-count{from{transform:scale(2.1);opacity:0}40%{opacity:1}to{transform:scale(1)}}

/* ---- narrow / short cabinets ---- */
@media (max-width:900px){
  .mg-pong-mid{flex-direction:column;gap:8px;}
  .mg-pong-side{width:100%;flex-direction:row;align-items:center;justify-content:center;gap:12px;padding:7px 12px;}
  .mg-pong-title{display:none;}
  .mg-pong-bubble{max-width:230px;}
  .mg-pong-bubble::after{top:50%;left:-9px;margin:-8px 0 0 0;border:8px solid transparent;
    border-right-color:#fff6e3;border-left:0;}
}
@media (max-height:640px){
  .mg-pong-marquee h1{font-size:15px;letter-spacing:.1em;}
  .mg-pong-hint{display:none;}
  .mg-pong-bezel{--mg-pong-sh:56vh;}
  /* a short cabinet gets the compact attract screen */
  .mg-pong-legend{display:none;}
  .mg-pong-card h2{font-size:17px;}
  .mg-pong-sub{font-size:9.5px;margin:3px 0 7px;}
  .mg-pong-rules{gap:4px;margin-bottom:7px;}
  .mg-pong-rules div{padding:4px 8px;font-size:10.5px;}
  .mg-pong-rules i{width:20px;height:20px;font-size:10px;}
  .mg-pong-over{padding:6px;}
  .mg-pong-stats{margin:5px 0 6px;gap:6px;}
  .mg-pong-stat{padding:4px 10px;min-width:66px;}
  .mg-pong-stat b{font-size:16px;}
  .mg-pong-ribbon{font-size:9.5px;padding:3px 12px;margin-bottom:4px;}
  .mg-pong-btns{padding:6px 0 2px;}
  .mg-pong-btn{padding:7px 16px;font-size:12px;}
}
@media (prefers-reduced-motion:reduce){
  .mg-pong-face,.mg-pong-lamp,.mg-pong-sweep,.mg-pong-neon,.mg-pong-ribbon{animation:none;}
  .mg-pong-card,.mg-pong-count{animation-duration:.01ms;}
}
`;

// ---------------------------------------------------------------------------
// the game
// ---------------------------------------------------------------------------
export class PongGame extends Minigame {
  static id = 'pong';
  static name = 'Paddle Panic';

  constructor(game) {
    super(game);
    this._raf = 0;
    this._timers = new Set();
    this._dead = false;
    this.el = {};

    this.phase = 'splash';
    this.phaseT = 0;
    this.serveDir = -1;

    this.ball = { x: FW / 2, y: FH / 2, vx: 0, vy: 0 };
    this.player = { y: FH / 2, vy: 0 };
    this.ai = { y: FH / 2, vy: 0, target: FH / 2, nextThink: 0, strain: 0 };

    this.pScore = 0;
    this.aScore = 0;
    this.rally = 0;
    this.playerHits = 0;
    this.bestRally = 0;

    this.trail = [];
    this.parts = [];
    this.shake = 0;
    this.flash = 0;
    this.now = 0;

    this.mouseY = null;
    this.useMouse = false;
    this.keyUp = false;
    this.keyDown = false;

    this.faceExpr = 'idle';
    this.faceGaze = 0;
    this.faceBlink = false;
    this.faceLock = 0;      // expression hold, seconds
    this.blinkAt = 1.8;
    this.faceSize = 140;
    this._faceKey = '';

    // what the last finished match was, so coinsForScore stays honest
    this._lastWin = null;
    this._lastOpp = 0;

    this._chipRally = -1;
    this._chipSpeed = -1;
  }

  // ---- lifecycle ----------------------------------------------------------
  mount(root) {
    super.mount(root);

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'mg-pong-root';
    wrap.innerHTML = this._html();
    root.appendChild(wrap);

    const q = (sel) => wrap.querySelector(sel);
    this.el = {
      wrap,
      bezel: q('[data-el="bezel"]'),
      canvas: q('[data-el="canvas"]'),
      over: q('[data-el="over"]'),
      face: q('[data-el="face"]'),
      bubble: q('[data-el="bubble"]'),
      rally: q('[data-el="rally"]'),
      best: q('[data-el="best"]'),
      bars: [...wrap.querySelectorAll('[data-el="bar"]')],
    };
    this.ctx = this.el.canvas.getContext('2d');

    this._buildHall();
    this.el.best.textContent = String(this.game.state?.bests?.pong || 0);

    q('[data-el="quit"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });

    this._onMove = (e) => this._pointer(e);
    this._onDown = (e) => this._pointer(e);
    this._onKey = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    this._onBlur = () => { this.keyUp = false; this.keyDown = false; };
    this._onResize = () => this._resize();
    window.addEventListener('pointermove', this._onMove, { passive: true });
    this.el.bezel.addEventListener('pointerdown', this._onDown, { passive: true });
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);

    this._resize();
    this._showSplash();
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  dispose() {
    this._dead = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    window.removeEventListener('pointermove', this._onMove);
    this.el.bezel?.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    this.trail.length = 0;
    this.parts.length = 0;
    this.ctx = null;
    this.el = {};
  }

  /** Coins are earned by WINNING; a loss still pays a small consolation. */
  coinsForScore(score) {
    const s = Math.max(0, Math.floor(Number(score) || 0));
    // the rally bonus is capped below 100, so score >= 500 means five points won
    const won = this._lastWin === null ? s >= WIN_POINTS * 100 : this._lastWin;
    if (!won) return LOSS_COINS;
    const opp = clamp(Math.floor(this._lastOpp || 0), 0, WIN_POINTS - 1);
    return WIN_BASE + WIN_STEP * (WIN_POINTS - opp);
  }

  /** What the purse actually receives, i.e. what the results screen may claim. */
  _payout(score) {
    return clampCoinsForGame('pong', this.coinsForScore(score));
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
      <div class="mg-pong-hall" data-el="hall"><div class="mg-pong-carpet"></div></div>

      <div class="mg-pong-cab">
        <div class="mg-pong-marquee">
          <i class="mg-pong-lamp"></i><i class="mg-pong-lamp" style="animation-delay:.3s"></i>
          <h1>PADDLE PANIC</h1>
          <i class="mg-pong-lamp" style="animation-delay:.6s"></i><i class="mg-pong-lamp" style="animation-delay:.9s"></i>
        </div>

        <div class="mg-pong-mid">
          <div class="mg-pong-side">
            <canvas class="mg-pong-face" data-el="face"></canvas>
            <div>
              <div class="mg-pong-plate">BLIP</div>
              <div class="mg-pong-title">HOUSE CHAMP</div>
            </div>
            <div class="mg-pong-bubble" data-el="bubble"></div>
          </div>

          <div class="mg-pong-screenwrap">
            <div class="mg-pong-bezel" data-el="bezel">
              <canvas class="mg-pong-canvas" data-el="canvas"></canvas>
              <div class="mg-pong-scan"></div>
              <div class="mg-pong-sweep"></div>
              <div class="mg-pong-vig"></div>
              <div class="mg-pong-glare"></div>
              <div class="mg-pong-over" data-el="over"></div>
            </div>
          </div>
        </div>

        <div class="mg-pong-deck">
          <div class="mg-pong-chip">RALLY <b data-el="rally">00</b></div>
          <div class="mg-pong-chip">SPEED
            <span class="mg-pong-bars">
              <i data-el="bar"></i><i data-el="bar"></i><i data-el="bar"></i><i data-el="bar"></i><i data-el="bar"></i>
            </span>
          </div>
          <div class="mg-pong-chip">BEST <b data-el="best">0</b></div>
          <div class="mg-pong-hint">MOUSE or W / S</div>
          <button class="mg-pong-quit" data-el="quit">QUIT</button>
        </div>
      </div>`;
  }

  _buildHall() {
    const hall = this.el.wrap.querySelector('[data-el="hall"]');
    const blobs = [
      ['#e8657a', '6%', '12%', '30%', '26%', '0s'],
      ['#4fb3e8', '68%', '6%', '34%', '30%', '1.6s'],
      ['#7ac74f', '38%', '62%', '28%', '24%', '3.1s'],
    ];
    for (const [color, left, top, w, h, delay] of blobs) {
      const b = document.createElement('div');
      b.className = 'mg-pong-neon';
      b.style.background = color;
      b.style.left = left;
      b.style.top = top;
      b.style.width = w;
      b.style.height = h;
      b.style.animationDelay = delay;
      hall.appendChild(b);
    }
  }

  // ---- input --------------------------------------------------------------
  _pointer(e) {
    const bez = this.el.bezel;
    if (!bez) return;
    const r = bez.getBoundingClientRect();
    if (!r.height || !r.width) return;
    const s = Math.min(r.width / FW, r.height / FH);
    const oy = (r.height - FH * s) / 2;
    const y = (e.clientY - r.top - oy) / s;
    this.mouseY = clamp(y, TOP + PH / 2, BOT - PH / 2);
    this.useMouse = true;
  }

  _key(e, down) {
    if (this._dead) return;
    const k = e.key;
    const mine = k === 'ArrowUp' || k === 'ArrowDown' || k === 'w' || k === 'W'
      || k === 's' || k === 'S' || k === ' ' || k === 'Enter' || k === 'Escape';
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
      // the world chat box sits behind the cabinet and cannot be reached: if it
      // still holds focus, take the keyboard back instead of eating the paddle
      if (!mine) return;
      if (down) t.blur();
    }
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      this.keyUp = down;
      if (down) this.useMouse = false;
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      this.keyDown = down;
      if (down) this.useMouse = false;
      e.preventDefault();
    } else if (down && (k === ' ' || k === 'Enter')) {
      if (this.phase === 'splash' || this.phase === 'over') {
        e.preventDefault();
        this._countdown();
      }
    } else if (down && k === 'Escape') {
      // never yanks you out mid-rally; the deck button is there for that
      if (this.phase === 'splash' || this.phase === 'over') {
        e.preventDefault();
        this.game.audio?.play?.('click');
        if (this.phase === 'over') this.exitToRoom(); else this.quit();
      }
    }
  }

  // ---- sizing -------------------------------------------------------------
  _resize() {
    const bez = this.el.bezel;
    const c = this.el.canvas;
    if (!bez || !c) return;
    const w = bez.clientWidth;
    const h = bez.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = w;
    this.ch = h;
    this.dpr = dpr;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }

    const fs = (window.innerWidth < 900 || window.innerHeight < 640) ? 88 : 140;
    if (fs !== this.faceSize) {
      this.faceSize = fs;
      this.el.face.style.width = `${fs}px`;
      this.el.face.style.height = `${fs}px`;
      this._faceKey = '';
    }
    this._paintFace();
  }

  // ---- screens ------------------------------------------------------------
  _showSplash() {
    this.phase = 'splash';
    const best = this.game.state?.bests?.pong || 0;
    const sweep = clampCoinsForGame('pong', WIN_BASE + WIN_STEP * WIN_POINTS);
    const over = this.el.over;
    over.classList.remove('mg-pong-gone');
    over.innerHTML = `
      <div class="mg-pong-card">
        <h2>PADDLE PANIC</h2>
        <div class="mg-pong-sub">BLIP HAS HELD THIS CABINET ALL WEEK</div>
        <div class="mg-pong-legend">
          <span><i class="mg-pong-sw mg-pong-them"></i>BLIP</span>
          <span><i class="mg-pong-sw mg-pong-ball"></i>BALL</span>
          <span><i class="mg-pong-sw mg-pong-you"></i>YOU</span>
        </div>
        <div class="mg-pong-rules">
          <div><i>1</i><span>Slide your paddle with the <b>mouse</b>, or <b>W</b>/<b>S</b> (arrows work too). You are the coral paddle on the right.</span></div>
          <div><i>2</i><span>First to <b>5</b> points takes the cabinet. Every return makes the ball faster.</span></div>
          <div><i>3</i><span>Hit with the <b>edge</b> of the paddle to bend the ball. Blip hates the corners.</span></div>
          <div><i>4</i><span>He sharpens up the further ahead you get. Win big and the payout is bigger.</span></div>
        </div>
        <div class="mg-pong-stats">
          <div class="mg-pong-stat"><b>${best}</b><span>YOUR BEST</span></div>
          <div class="mg-pong-stat mg-pong-gold"><b>${sweep}</b><span>COINS FOR A 5-0</span></div>
        </div>
        <div class="mg-pong-btns">
          <button class="mg-pong-btn" data-a="play">PRESS START</button>
          <button class="mg-pong-btn mg-pong-ghost" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    over.querySelector('[data-a="play"]').addEventListener('click', () => this._countdown());
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.quit();
    });
    this._setFace('idle', 0);
    this._say(pick(TAUNTS.start), 4200);
  }

  _countdown() {
    if (this.phase !== 'splash' && this.phase !== 'over') return;
    this.game.audio?.play?.('click');
    this._resetMatch();
    this.phase = 'countdown';
    const over = this.el.over;
    const steps = ['3', '2', '1', 'GO!'];
    const show = (i) => {
      if (i >= steps.length) {
        over.classList.add('mg-pong-gone');
        over.innerHTML = '';
        this.phase = 'serve';
        this.phaseT = 0.7;
        this.serveDir = Math.random() < 0.5 ? -1 : 1;
        return;
      }
      over.classList.remove('mg-pong-gone');
      over.innerHTML = `<div class="mg-pong-count">${steps[i]}</div>`;
      this.game.audio?.play?.(i === steps.length - 1 ? 'success' : 'ding');
      this._after(i === steps.length - 1 ? 420 : 620, () => show(i + 1));
    };
    show(0);
  }

  _resetMatch() {
    this.pScore = 0;
    this.aScore = 0;
    this.rally = 0;
    this.playerHits = 0;
    this.bestRally = 0;
    this.player.y = FH / 2;
    this.player.vy = 0;
    this.ai.y = FH / 2;
    this.ai.vy = 0;
    this.ai.target = FH / 2;
    this.ai.nextThink = 0;
    this.ball.x = FW / 2;
    this.ball.y = FH / 2;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.trail.length = 0;
    this.parts.length = 0;
    this.shake = 0;
    this.flash = 0;
    this._done = false; // every replay reports its own run
    this._lastWin = null;
    this._lastOpp = 0;
    this._setFace('idle', 0);
    this._syncChips(true);
  }

  _results() {
    this.phase = 'over';
    const won = this.pScore >= WIN_POINTS;
    const score = this.pScore * 100 + Math.min(RALLY_BONUS_CAP, this.playerHits);
    this._lastWin = won;
    this._lastOpp = this.aScore;

    const prevBest = this.game.state?.bests?.pong || 0;
    const isBest = score > prevBest;
    const coins = this._payout(score);
    this.finish(score);
    const shown = Math.max(prevBest, score);
    this.el.best.textContent = String(shown);
    this.game.audio?.play?.(won ? 'levelup' : 'fail');
    this._setFace(won ? 'beaten' : 'smug', 6);
    this._say(won ? pick(TAUNTS.lose) : pick(TAUNTS.win), 5200);

    const over = this.el.over;
    over.classList.remove('mg-pong-gone');
    over.innerHTML = `
      <div class="mg-pong-card">
        ${isBest ? '<div class="mg-pong-ribbon">NEW CABINET RECORD</div>' : ''}
        <h2>${won ? 'YOU WIN!' : 'BLIP HOLDS THE CABINET'}</h2>
        <div class="mg-pong-sub">${this._verdict(won)}</div>
        <div class="mg-pong-stats">
          <div class="mg-pong-stat"><b>${this.pScore} - ${this.aScore}</b><span>FINAL</span></div>
          <div class="mg-pong-stat"><b>${score}</b><span>SCORE</span></div>
          <div class="mg-pong-stat mg-pong-gold"><b>${coins}</b><span>COINS</span></div>
        </div>
        <div class="mg-pong-stats">
          <div class="mg-pong-stat"><b>${shown}</b><span>BEST</span></div>
          <div class="mg-pong-stat"><b>${this.bestRally}</b><span>LONGEST RALLY</span></div>
          <div class="mg-pong-stat"><b>${Math.min(RALLY_BONUS_CAP, this.playerHits)}</b><span>RALLY BONUS</span></div>
        </div>
        <div class="mg-pong-btns">
          <button class="mg-pong-btn" data-a="again">Play again</button>
          <button class="mg-pong-btn mg-pong-alt" data-a="leave">Back to the den</button>
        </div>
      </div>`;
    over.querySelector('[data-a="again"]').addEventListener('click', () => this._countdown());
    over.querySelector('[data-a="leave"]').addEventListener('click', () => {
      this.game.audio?.play?.('click');
      this.exitToRoom();
    });
  }

  _verdict(won) {
    if (won && this.aScore === 0) return 'A CLEAN SWEEP. THE DEN IS STILL TALKING ABOUT IT.';
    if (won && this.aScore >= 4) return 'BY ONE POINT. YOUR PAWS ARE SHAKING.';
    if (won) return 'THE CHAMP HAS BEEN DETHRONED. FOR NOW.';
    if (this.pScore >= 4) return 'SO CLOSE. ONE MORE RETURN AND THAT WAS YOURS.';
    if (this.pScore >= 2) return 'YOU FOUND HIS CORNERS. NOW FIND THEM FASTER.';
    return 'HE BARELY MOVED. GO AGAIN.';
  }

  // ---- loop ---------------------------------------------------------------
  _loop(t) {
    if (this._dead) return;
    this._raf = requestAnimationFrame((n) => this._loop(n));
    const sec = t / 1000;
    const dt = clamp(sec - (this._last || sec), 0, 0.05);
    this._last = sec;
    this.now += dt;

    // the bezel resizes with the window and with the room layout around it
    this._sizeTick = (this._sizeTick || 0) + 1;
    if (this._sizeTick % 12 === 0 && this.el.bezel
      && (this.el.bezel.clientWidth !== this.cw || this.el.bezel.clientHeight !== this.ch)) {
      this._resize();
    }

    this._update(dt);
    this._draw();
  }

  _update(dt) {
    const live = this.phase === 'rally' || this.phase === 'serve'
      || this.phase === 'point' || this.phase === 'countdown';

    if (live) {
      this._movePlayer(dt);
      this._moveAI(dt);
    }

    if (this.phase === 'rally') {
      this._stepBall(dt);
      this.trail.push({ x: this.ball.x, y: this.ball.y });
      if (this.trail.length > 15) this.trail.shift();
    } else if (this.phase === 'point') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.phase = 'serve'; this.phaseT = 0.85; }
    } else if (this.phase === 'serve') {
      this.phaseT -= dt;
      this.ball.x = FW / 2;
      this.ball.y = FH / 2;
      if (this.phaseT <= 0) this._launch();
    }

    // particles
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) { this.parts.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - Math.min(1, dt * 2.2);
      p.vy *= 1 - Math.min(1, dt * 2.2);
    }

    this.shake = Math.max(0, this.shake - dt * 34);
    this.flash = Math.max(0, this.flash - dt * 3.4);

    this._faceTick(dt);
    this._syncChips(false);
  }

  _movePlayer(dt) {
    const prev = this.player.y;
    const lo = TOP + PH / 2;
    const hi = BOT - PH / 2;
    const dir = (this.keyDown ? 1 : 0) - (this.keyUp ? 1 : 0);
    if (dir) {
      this.player.y = clamp(this.player.y + dir * KEY_SPEED * dt, lo, hi);
    } else if (this.useMouse && this.mouseY !== null) {
      const k = Math.min(1, dt * MOUSE_TRACK);
      this.player.y = clamp(this.player.y + (this.mouseY - this.player.y) * k, lo, hi);
    }
    this.player.vy = dt > 0 ? (this.player.y - prev) / dt : 0;
  }

  /**
   * Blip: capped paddle speed, a reaction delay and a wobbly read, all
   * rubber-banded around the score AND the ball's heat. He only reads the ball
   * while it is coming at him, sometimes lazily chases where it is instead of
   * where it is going, and drifts back to the middle otherwise. He is never
   * perfect in either direction: the fastest he ever gets still misses corners.
   */
  _tune() {
    const d = this.pScore - this.aScore; // positive: you are ahead
    const played = this.pScore + this.aScore;
    const spd = Math.hypot(this.ball.vx, this.ball.vy);
    const heat = clamp((spd - SERVE_SPEED) / (MAX_SPEED - SERVE_SPEED), 0, 1);
    return {
      reaction: clamp(0.26 - d * 0.032, 0.09, 0.42),
      speed: clamp(232 + d * 26 + played * 4, 158, 372),
      // the catch window is PH/2 + BALL_R, so a read this wide is a real miss
      // chance: near zero on a slow opening rally, one in four when it is hot
      err: clamp((34 - d * 2.2) * (0.62 + heat * 0.95), 12, 72),
      lazy: clamp(0.13 + heat * 0.2 - d * 0.03, 0.03, 0.4),
    };
  }

  _moveAI(dt) {
    const a = this.ai;
    const tune = this._tune();
    const chasing = this.phase === 'rally' && this.ball.vx < 0;
    if (this.now >= a.nextThink) {
      if (chasing) {
        // a lazy read chases where the ball IS, not where it is going: that is
        // what a fast diagonal shot into the corner punishes
        const seen = Math.random() < tune.lazy ? this.ball.y : this._predictY();
        a.target = seen + rnd(-tune.err, tune.err);
        a.nextThink = this.now + tune.reaction * rnd(0.8, 1.25);
      } else {
        a.target = FH / 2 + rnd(-46, 46);
        a.nextThink = this.now + rnd(0.4, 0.8);
      }
    }
    const lo = TOP + PH / 2;
    const hi = BOT - PH / 2;
    const target = clamp(a.target, lo, hi);
    const diff = target - a.y;
    const step = tune.speed * dt * (chasing ? 1 : 0.55);
    const prev = a.y;
    a.y = Math.abs(diff) <= step ? target : a.y + Math.sign(diff) * step;
    a.y = clamp(a.y, lo, hi);
    a.vy = dt > 0 ? (a.y - prev) / dt : 0;
    a.strain = Math.abs(diff);
  }

  /** Where the ball will cross Blip's paddle line, folded off the walls. */
  _predictY() {
    const b = this.ball;
    if (b.vx >= 0) return FH / 2;
    const face = AI_X + PW / 2 + BALL_R;
    const t = (b.x - face) / -b.vx;
    if (!Number.isFinite(t) || t < 0) return b.y;
    const lo = TOP + BALL_R;
    const hi = BOT - BALL_R;
    const span = hi - lo;
    let k = (b.y + b.vy * t - lo) % (2 * span);
    if (k < 0) k += 2 * span;
    return lo + (k > span ? 2 * span - k : k);
  }

  _launch() {
    const spd = SERVE_SPEED + Math.min(120, (this.pScore + this.aScore) * 16);
    const ang = rnd(-0.4, 0.4);
    this.ball.vx = this.serveDir * Math.cos(ang) * spd;
    this.ball.vy = Math.sin(ang) * spd;
    this.trail.length = 0;
    this.rally = 0;
    this.phase = 'rally';
    this.game.audio?.play?.('whoosh');
  }

  _stepBall(dt) {
    const b = this.ball;
    const dist = Math.hypot(b.vx, b.vy) * dt;
    const steps = Math.max(1, Math.min(12, Math.ceil(dist / 5)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      b.x += b.vx * h;
      b.y += b.vy * h;

      if (b.y < TOP + BALL_R && b.vy < 0) {
        b.y = TOP + BALL_R; b.vy = -b.vy; this._wallHit();
      } else if (b.y > BOT - BALL_R && b.vy > 0) {
        b.y = BOT - BALL_R; b.vy = -b.vy; this._wallHit();
      }

      if (b.vx < 0 && b.x - BALL_R <= AI_X + PW / 2 && b.x + BALL_R >= AI_X - PW / 2
        && Math.abs(b.y - this.ai.y) <= PH / 2 + BALL_R) {
        this._paddleHit(-1);
      } else if (b.vx > 0 && b.x + BALL_R >= P_X - PW / 2 && b.x - BALL_R <= P_X + PW / 2
        && Math.abs(b.y - this.player.y) <= PH / 2 + BALL_R) {
        this._paddleHit(1);
      }

      if (b.x < -BALL_R * 3) { this._point('player'); return; }
      if (b.x > FW + BALL_R * 3) { this._point('ai'); return; }
    }
  }

  _wallHit() {
    this.game.audio?.play?.('tick');
    this._spark(this.ball.x, this.ball.y, C.cream, 4, 0);
    this.shake = Math.max(this.shake, 2.2);
  }

  /** side -1: Blip's paddle. side +1: yours. */
  _paddleHit(side) {
    const b = this.ball;
    const pad = side < 0 ? this.ai : this.player;
    const padX = side < 0 ? AI_X : P_X;
    const rel = clamp((b.y - pad.y) / (PH / 2 + BALL_R), -1, 1);
    const ang = rel * MAX_ANG;
    // a marathon rally keeps raising the ceiling: nobody gets to settle in
    const cap = Math.min(MAX_SPEED + Math.max(0, this.rally - 12) * 12, RALLY_MAX_SPEED);
    const spd = Math.min(cap, Math.hypot(b.vx, b.vy) * SPEEDUP + 9);
    const dir = side < 0 ? 1 : -1;

    let vx = dir * Math.cos(ang) * spd;
    let vy = Math.sin(ang) * spd + pad.vy * 0.14; // a moving paddle adds english
    const m = Math.hypot(vx, vy) || 1;
    vx = (vx / m) * spd;
    vy = (vy / m) * spd;
    const minVx = spd * 0.42;
    if (Math.abs(vx) < minVx) {
      const sx = vx === 0 ? dir : Math.sign(vx);
      const sy = vy === 0 ? 1 : Math.sign(vy);
      vx = sx * minVx;
      vy = sy * Math.sqrt(Math.max(1, spd * spd - minVx * minVx));
    }
    b.vx = vx;
    b.vy = vy;
    b.x = padX + dir * (PW / 2 + BALL_R + 0.6);

    this.rally++;
    this.bestRally = Math.max(this.bestRally, this.rally);
    if (side > 0) this.playerHits++;
    this.shake = Math.max(this.shake, 3 + Math.min(6, this.rally * 0.35));
    this._spark(b.x, b.y, side > 0 ? C.coral : C.sky, 9, dir);
    this.game.audio?.play?.('pop');

    if (side < 0) {
      this._setFace(this.ai.strain > 62 ? 'worried' : 'thinking', 0.5);
    }
    if (this.rally === 9) this._say(pick(TAUNTS.rally), 2600);
  }

  _point(who) {
    const b = this.ball;
    const edgeX = who === 'player' ? 0 : FW;
    if (who === 'player') this.pScore++; else this.aScore++;
    this.rally = 0;
    this.flash = 1;
    this.shake = 13;
    this.trail.length = 0;
    b.vx = 0;
    b.vy = 0;
    b.x = FW / 2;
    b.y = FH / 2;
    this._burst(edgeX, clamp(b.y, TOP, BOT), who === 'player' ? C.coral : C.sky, 22);

    if (who === 'player') {
      this.game.audio?.play?.('coin');
      this._setFace('worried', 1.7);
      this._say(pick(TAUNTS.you), 2400);
    } else {
      this.game.audio?.play?.('fail');
      this._setFace('smug', 1.7);
      this._say(pick(TAUNTS.ai), 2400);
    }

    if (this.pScore >= WIN_POINTS || this.aScore >= WIN_POINTS) {
      this.phase = 'end';
      this._after(950, () => this._results());
      return;
    }
    if (this.pScore === WIN_POINTS - 1 && this.aScore < WIN_POINTS - 1) {
      this._say(pick(TAUNTS.matchYou), 2600);
    } else if (this.aScore === WIN_POINTS - 1 && this.pScore < WIN_POINTS - 1) {
      this._say(pick(TAUNTS.matchAi), 2600);
    }
    this.serveDir = who === 'player' ? -1 : 1; // the ball goes to whoever lost it
    this.phase = 'point';
    this.phaseT = 0.55;
  }

  // ---- particles ----------------------------------------------------------
  _spark(x, y, color, n, dirx) {
    for (let i = 0; i < n; i++) {
      if (this.parts.length > 150) break;
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(40, 170);
      this.parts.push({
        x, y,
        vx: Math.cos(a) * sp + dirx * 90,
        vy: Math.sin(a) * sp,
        life: rnd(0.22, 0.42),
        max: 0.42,
        r: rnd(1.6, 3.6),
        c: color,
      });
    }
  }

  _burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      if (this.parts.length > 170) break;
      const a = rnd(-Math.PI / 2.2, Math.PI / 2.2) + (x < FW / 2 ? 0 : Math.PI);
      const sp = rnd(90, 320);
      this.parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + rnd(-90, 90),
        life: rnd(0.4, 0.85),
        max: 0.85,
        r: rnd(2, 5),
        c: i % 3 === 0 ? C.gold : color,
      });
    }
  }

  // ---- Blip's face + chatter ---------------------------------------------
  _setFace(expr, hold) {
    if (this.faceLock > 0 && hold <= 0) return;
    this.faceExpr = expr;
    this.faceLock = hold;
  }

  _faceTick(dt) {
    this.faceLock = Math.max(0, this.faceLock - dt);
    if (this.faceLock === 0) {
      if (this.phase === 'rally') {
        const chasing = this.ball.vx < 0;
        this.faceExpr = chasing ? (this.ai.strain > 62 ? 'worried' : 'thinking') : 'idle';
      } else if (this.phase === 'over' || this.phase === 'end') {
        // whatever the result set stays put
      } else {
        this.faceExpr = this.aScore - this.pScore >= 2 ? 'smug' : 'idle';
      }
    }
    // blink
    this.blinkAt -= dt;
    if (this.blinkAt <= 0) {
      this.faceBlink = !this.faceBlink;
      this.blinkAt = this.faceBlink ? 0.12 : rnd(2.2, 5);
    }
    // eyes follow the ball across the cabinet
    const target = this.phase === 'rally' ? clamp((this.ball.x - FW / 2) / (FW / 2), -1, 1) : 0;
    this.faceGaze += (target - this.faceGaze) * Math.min(1, dt * 7);
    this._paintFace();
  }

  _paintFace() {
    const c = this.el.face;
    if (!c) return;
    const gz = Math.round(this.faceGaze * 4) / 4;
    const key = `${this.faceExpr}|${this.faceBlink ? 1 : 0}|${gz}|${this.faceSize}`;
    if (key === this._faceKey) return;
    this._faceKey = key;
    const s = this.faceSize;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(s * dpr);
    if (c.width !== px) { c.width = px; c.height = px; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    drawBlip(ctx, s, this.faceExpr, gz, this.faceBlink);
  }

  _say(text, ms) {
    const b = this.el.bubble;
    if (!b) return;
    b.textContent = text;
    b.classList.add('mg-pong-on');
    if (this._sayTimer) { clearTimeout(this._sayTimer); this._timers.delete(this._sayTimer); }
    this._sayTimer = this._after(ms, () => {
      this._sayTimer = 0;
      this.el.bubble?.classList.remove('mg-pong-on');
    });
  }

  // ---- deck chips ---------------------------------------------------------
  _syncChips(force) {
    if (!this.el.rally) return;
    if (force || this.rally !== this._chipRally) {
      this._chipRally = this.rally;
      this.el.rally.textContent = String(Math.min(99, this.rally)).padStart(2, '0');
    }
    const spd = Math.hypot(this.ball.vx, this.ball.vy);
    const lvl = spd <= 0 ? 0 : clamp(Math.ceil(((spd - SERVE_SPEED) / (MAX_SPEED - SERVE_SPEED)) * 4) + 1, 1, 5);
    if (force || lvl !== this._chipSpeed) {
      this._chipSpeed = lvl;
      this.el.bars.forEach((bar, i) => bar.classList.toggle('mg-pong-on', i < lvl));
    }
  }

  // ---- render -------------------------------------------------------------
  _draw() {
    const ctx = this.ctx;
    if (!ctx || !this.cw) return;
    const W = this.cw;
    const H = this.ch;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const s = Math.min(W / FW, H / FH);
    const ox = (W - FW * s) / 2;
    const oy = (H - FH * s) / 2;
    const sh = this.shake;
    ctx.save();
    ctx.translate(ox + rnd(-sh, sh) * 0.6, oy + rnd(-sh, sh) * 0.6);
    ctx.scale(s, s);

    this._drawField(ctx);
    this._drawScores(ctx);
    this._drawBall(ctx);
    this._drawPaddles(ctx);
    this._drawParts(ctx);
    this._drawBanner(ctx);

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,246,227,${(this.flash * 0.16).toFixed(3)})`;
      ctx.fillRect(0, 0, FW, FH);
    }
    ctx.restore();
  }

  _drawField(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, FH);
    g.addColorStop(0, C.screenTop);
    g.addColorStop(1, C.screenBot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, FW, FH);

    // faint phosphor grid
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 40; x < FW; x += 40) { ctx.moveTo(x, WALL); ctx.lineTo(x, FH - WALL); }
    for (let y = 40; y < FH; y += 40) { ctx.moveTo(WALL, y); ctx.lineTo(FW - WALL, y); }
    ctx.stroke();

    // frame bars
    ctx.fillStyle = 'rgba(255,246,227,0.62)';
    ctx.shadowColor = C.cream;
    ctx.shadowBlur = 14;
    ctx.fillRect(0, 0, FW, WALL - 3);
    ctx.fillRect(0, FH - WALL + 3, FW, WALL - 3);
    ctx.shadowBlur = 0;

    // centre net
    ctx.strokeStyle = 'rgba(255,246,227,0.34)';
    ctx.lineWidth = 4;
    ctx.setLineDash([11, 13]);
    ctx.beginPath();
    ctx.moveTo(FW / 2, WALL + 4);
    ctx.lineTo(FW / 2, FH - WALL - 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawScores(ctx) {
    const w = 30;
    const h = 58;
    const t = 9;
    drawDigit(ctx, clamp(this.aScore, 0, 9), FW / 2 - 46 - w, 40, w, h, t, C.sky);
    drawDigit(ctx, clamp(this.pScore, 0, 9), FW / 2 + 46, 40, w, h, t, C.coral);

    ctx.font = '900 12px "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(79,179,232,0.75)';
    ctx.fillText('BLIP', FW / 2 - 46 - w / 2, 116);
    ctx.fillStyle = 'rgba(232,101,122,0.8)';
    ctx.fillText('YOU', FW / 2 + 46 + w / 2, 116);
    ctx.textAlign = 'left';
  }

  _drawPaddles(ctx) {
    const bar = (x, y, color) => {
      ctx.shadowColor = color;
      ctx.shadowBlur = 22;
      ctx.fillStyle = color;
      rr(ctx, x - PW / 2, y - PH / 2, PW, PH, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,246,227,0.55)';
      rr(ctx, x - PW / 2 + 3, y - PH / 2 + 5, 3.4, PH - 10, 2);
      ctx.fill();
    };
    bar(AI_X, this.ai.y, C.sky);
    bar(P_X, this.player.y, C.coral);
  }

  _drawBall(ctx) {
    const b = this.ball;
    // trail
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.trail[i];
      const k = (i + 1) / this.trail.length;
      ctx.globalAlpha = k * 0.42;
      ctx.fillStyle = C.gold;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BALL_R * (0.35 + k * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // the parked ball blinks while a serve is being set up, and is gone whenever
    // the match is not actually running
    if ((this.phase === 'serve' || this.phase === 'point') && Math.floor(this.now * 6) % 2 === 0) return;
    if (this.phase !== 'rally' && this.phase !== 'serve' && this.phase !== 'point') return;

    ctx.shadowColor = C.gold;
    ctx.shadowBlur = 26;
    ctx.fillStyle = C.gold;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,246,227,0.85)';
    ctx.beginPath();
    ctx.arc(b.x - 2, b.y - 2.4, BALL_R * 0.38, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawParts(ctx) {
    for (const p of this.parts) {
      const k = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = k;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.4 + k * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawBanner(ctx) {
    if (this.phase !== 'serve' && this.phase !== 'point') return;
    const matchP = this.pScore === WIN_POINTS - 1 || this.aScore === WIN_POINTS - 1;
    if (!matchP) return;
    const pulse = 0.6 + 0.4 * Math.sin(this.now * 6);
    ctx.globalAlpha = pulse;
    ctx.font = '900 20px "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = C.gold;
    ctx.shadowColor = C.gold;
    ctx.shadowBlur = 18;
    ctx.fillText('MATCH POINT', FW / 2, FH - 44);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
}
