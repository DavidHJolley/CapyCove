/**
 * Capy Karts: the race UI (docs/KARTS.md GRAND PRIX AMENDMENT §A7).
 *
 * Every DOM node the racer reads during a race lives in this file and nowhere
 * else. `kart.js` owns the 3D scene, the camera, the audio nodes and the
 * `Minigame` lifecycle; this module owns the overlay and must leave `root`
 * exactly as it found it after `dispose()`.
 *
 * THE FROZEN INTERFACE (§A7). Ten methods, and kart.js calls only these:
 *   mount() setPhase(p) countdown(n, go) update(view, dt) item(o) lap(o)
 *   wrongWay(on) toast(kind, text) results(payload) dispose()
 *
 * HOUSE RULES this module keeps to the letter:
 *   - No requestAnimationFrame of its own: `update(view, dt)` is driven by
 *     kart.js's existing loop, so there is exactly one clock in the game.
 *   - No document- or window-level listeners, ever. The only listeners are on
 *     buttons this file created, and they leave with the button.
 *   - `update()` is on the hot path: it writes to the DOM only when a value
 *     actually changed (every field is cached and quantised), allocates nothing
 *     per frame, and repaints the minimap at 20 Hz rather than 60.
 *   - Every class name is prefixed `mg-kart-h` and no rule selects a bare
 *     element, so the overlay cannot collide with kart.js's own `.mg-kk-*`
 *     styles or with anything in styles.css. The isolation is that PREFIX:
 *     only the two root rules are literally scoped under `.mg-kart-hudroot`.
 *
 * CALLBACKS. The frozen interface has no place for "the player pressed Race
 * again", so the results furniture reports both ways and kart.js may use
 * whichever it likes: the optional `onAgain` / `onQuit` / `onPlay` handlers on
 * the constructor options (or on the `results()` payload, which wins), and a
 * bubbling CustomEvent on the root element (`kart-hud:again`, `kart-hud:quit`).
 * `onPlay(name)` is how the HUD asks for a sound (the coin count-up ticks, the
 * best-lap chime); with no handler it simply stays quiet.
 */

import { audio } from '../../core/audio.js';

// =============================================================== constants ==
/** Display names for §A4's roster. Duplicated from the contract by design. */
const KART_NAMES = {
  coco: 'Coconut Cruiser',
  reef: 'Reef Racer',
  biscuit: 'Biscuit Barrel',
  dart: 'Dune Dart',
  fern: 'Fernback',
};

/** §3.3 items, for the slot's name line. */
const ITEM_NAMES = { peel: 'Melon Peel', bubble: 'Splash Bubble', berry: 'Zoom Berry' };
const ITEM_ORDER = ['peel', 'bubble', 'berry'];

/**
 * The dial's needle colour by drift tier. Index 0 is "not drifting" and is
 * deliberately a neutral ink rather than a palette accent: the three charge
 * colours (§3.2 sky, gold, coral) have to be the only saturated states, or a
 * coral needle at rest reads as a tier-3 charge.
 */
const TIER_COLORS = ['#4a4032', '#4fb3e8', '#f2b64a', '#e8657a'];

const SPEED_FULL = 36;      // the dial's top of scale; the 34 u/s boost ceiling fits
const SPIN_HZ = 14;         // roulette icon swaps per second
const MAP_HZ = 20;          // §A7.5 — live dots at 20 Hz, not 60
const MAP_SIZE = 168;       // CSS px of the minimap square
const CONFETTI = 84;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const frac1 = (v) => v - Math.floor(v);

const ORD = ['th', 'st', 'nd', 'rd'];
function ordinal(n) {
  const v = n % 100;
  return `${n}${ORD[(v - 20) % 10] || ORD[v] || ORD[0]}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const hex6 = (c) => `#${((Number(c) || 0) >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;

/** Multiply a packed 0xRRGGBB by `k`, clamped. Used for shading and ear tones. */
function shade(c, k) {
  const n = (Number(c) || 0) >>> 0;
  const r = clamp(Math.round(((n >> 16) & 255) * k), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 255) * k), 0, 255);
  const b = clamp(Math.round((n & 255) * k), 0, 255);
  return `rgb(${r},${g},${b})`;
}

/** 74210 -> "1:14.21", and anything unusable -> "--:--". */
function lapTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const t = Math.max(0, Math.round(ms / 10) / 100);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** A live gap, signed and readable at a glance: "+1.4s", "-12s", "+1:04". */
function gapText(ms) {
  if (!Number.isFinite(ms)) return '--';
  const sign = ms < 0 ? '-' : '+';
  const a = Math.abs(ms);
  if (a >= 60000) {
    const m = Math.floor(a / 60000);
    const s = Math.floor((a % 60000) / 1000);
    return `${sign}${m}:${s < 10 ? '0' : ''}${s}`;
  }
  if (a >= 10000) return `${sign}${Math.round(a / 1000)}s`;
  return `${sign}${(a / 1000).toFixed(1)}s`;
}

const COIN_SVG = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="10" fill="#e0952f"/><circle cx="12" cy="12" r="7.4" fill="#f2b64a"/>'
  + '<circle cx="12" cy="12" r="3.6" fill="#ffd77a"/></svg>';

/** Item art as inline SVG so the overlay never needs a texture or an asset. */
const ITEM_SVG = {
  peel: '<svg viewBox="0 0 64 64"><path d="M8 44a26 26 0 0 0 48 0z" fill="#4f8f3a"/>'
    + '<path d="M13 44a21 21 0 0 0 38 0z" fill="#f58a9c"/><circle cx="26" cy="38" r="2.2" fill="#3b2a1c"/>'
    + '<circle cx="38" cy="38" r="2.2" fill="#3b2a1c"/><circle cx="32" cy="30" r="2.2" fill="#3b2a1c"/></svg>',
  bubble: '<svg viewBox="0 0 64 64"><circle cx="32" cy="34" r="22" fill="#bfe9ff"/>'
    + '<circle cx="32" cy="34" r="22" fill="none" stroke="#4fb3e8" stroke-width="3"/>'
    + '<circle cx="24" cy="26" r="6" fill="#fff"/><circle cx="41" cy="42" r="3" fill="#fff"/></svg>',
  berry: '<svg viewBox="0 0 64 64"><circle cx="32" cy="38" r="18" fill="#e8657a"/>'
    + '<circle cx="25" cy="32" r="5" fill="#ff9bab"/><path d="M32 20c0-6 5-9 9-9-1 6-4 9-9 9z" fill="#7ac74f"/>'
    + '<rect x="30.5" y="12" width="3" height="10" rx="1.5" fill="#7a5a3a"/></svg>',
};

/** A chibi capy face in the racer's own colour: podium heads and the wrong-way sign. */
function capyFace(color, w) {
  const body = hex6(color);
  const ear = shade(color, 0.78);
  const muzzle = shade(color, 1.16);
  return `<svg viewBox="0 0 40 36" width="${w}" height="${Math.round(w * 0.9)}" aria-hidden="true">
    <ellipse cx="8.5" cy="9" rx="5.2" ry="5" fill="${ear}"/>
    <ellipse cx="31.5" cy="9" rx="5.2" ry="5" fill="${ear}"/>
    <rect x="4" y="6" width="32" height="27" rx="13" fill="${body}"/>
    <ellipse cx="20" cy="27" rx="9" ry="6.4" fill="${muzzle}"/>
    <circle cx="14" cy="18" r="2.3" fill="#2d2417"/><circle cx="26" cy="18" r="2.3" fill="#2d2417"/>
    <ellipse cx="20" cy="24" rx="3.1" ry="2.1" fill="#2d2417"/>
  </svg>`;
}

// ===================================================================== CSS ==
const CSS = `
.mg-kart-hudroot{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;
  font-family:var(--font,"Trebuchet MS","Segoe UI",system-ui,sans-serif);
  color:var(--ink,#2d2417);
  --kh-cream:rgba(255,253,246,.93);--kh-mut:#9b8a6c;--kh-ink:#2d2417;
  --kh-coral:var(--accent,#e8657a);--kh-sky:var(--accent2,#4fb3e8);--kh-gold:var(--gold,#f2b64a);
  --kh-lift:0 5px 0 rgba(45,36,23,.14),0 10px 22px rgba(16,52,78,.26);}
.mg-kart-hudroot *{box-sizing:border-box;}

/* the whole race furniture fades as one, so a phase change is a single write */
.mg-kart-hface{position:absolute;inset:0;opacity:0;transition:opacity .32s ease;}
.mg-kart-hface.on{opacity:1;}
.mg-kart-hpanel{position:absolute;background:var(--kh-cream);border-radius:18px;
  box-shadow:var(--kh-lift);padding:10px 14px;font-weight:900;
  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}
.mg-kart-hlbl{font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--kh-mut);
  font-weight:900;}

/* --- 1. position tower ------------------------------------------------- */
.mg-kart-htower{top:16px;left:16px;width:212px;padding:9px 12px 10px;}
.mg-kart-hpos{display:flex;align-items:baseline;gap:6px;line-height:.92;}
.mg-kart-hplace{font-size:46px;color:var(--kh-coral);letter-spacing:-.02em;
  transition:scale .18s var(--spring,cubic-bezier(.2,1.35,.4,1));}
.mg-kart-hplace.bump{scale:1.16;}
.mg-kart-hof{font-size:14px;color:var(--kh-mut);}
.mg-kart-hlist{margin-top:7px;display:flex;flex-direction:column;gap:3px;}
.mg-kart-hrow{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;
  color:#5c5140;background:rgba(45,36,23,.05);border-radius:9px;padding:3px 7px;
  transition:background .2s ease,opacity .2s ease;}
.mg-kart-hrow.me{background:rgba(232,101,122,.18);box-shadow:inset 0 0 0 2px rgba(232,101,122,.4);}
.mg-kart-hrow.gh{opacity:.42;}
.mg-kart-hrow u{text-decoration:none;color:var(--kh-mut);font-size:10px;width:14px;flex:none;}
.mg-kart-hrow i{width:10px;height:10px;border-radius:99px;flex:none;
  box-shadow:inset 0 -2px 0 rgba(0,0,0,.22);}
.mg-kart-hrow s{text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.mg-kart-hgap{font-size:10.5px;color:#a2937a;font-variant-numeric:tabular-nums;flex:none;}
.mg-kart-hrow.me .mg-kart-hgap{color:var(--kh-coral);}

/* --- 2. lap panel ------------------------------------------------------ */
.mg-kart-hlap{top:16px;right:16px;width:176px;text-align:right;overflow:hidden;}
.mg-kart-hlapn{font-size:34px;line-height:1;}
.mg-kart-hlapn span{font-size:15px;color:var(--kh-mut);}
.mg-kart-hnow{font-size:19px;margin-top:2px;font-variant-numeric:tabular-nums;color:#4a4032;}
.mg-kart-hbestl{font-size:11.5px;color:var(--kh-mut);font-variant-numeric:tabular-nums;margin-top:1px;}
.mg-kart-hsplits{display:flex;flex-direction:column;gap:2px;margin-top:6px;
  border-top:2px dotted rgba(45,36,23,.14);padding-top:5px;}
.mg-kart-hsplit{display:flex;justify-content:space-between;font-size:11px;color:#7d6f58;
  font-variant-numeric:tabular-nums;}
.mg-kart-hsplit b{color:#4a4032;}
.mg-kart-hsplit.best b{color:var(--kh-gold);}
.mg-kart-hsheen{position:absolute;inset:0;pointer-events:none;opacity:0;
  background:linear-gradient(105deg,rgba(242,182,74,0) 30%,rgba(255,231,168,.95) 50%,rgba(242,182,74,0) 70%);}
.mg-kart-hsheen.go{animation:mg-kart-hsheen .85s ease-out;}
@keyframes mg-kart-hsheen{0%{opacity:1;translate:-120% 0}100%{opacity:0;translate:120% 0}}

/* --- 3. item slot ------------------------------------------------------ */
.mg-kart-hslot{position:absolute;top:14px;left:50%;translate:-50% 0;width:102px;height:102px;
  border-radius:26px;background:var(--kh-cream);box-shadow:var(--kh-lift);
  display:flex;align-items:center;justify-content:center;
  transition:scale .2s var(--spring,cubic-bezier(.2,1.35,.4,1)),box-shadow .25s ease,opacity .3s ease;}
.mg-kart-hslot::before{content:'';position:absolute;inset:6px;border-radius:20px;
  border:3px dashed rgba(45,36,23,.13);}
.mg-kart-hslot.ready{scale:1.06;
  box-shadow:var(--kh-lift),0 0 0 4px rgba(242,182,74,.55),0 0 26px 6px rgba(242,182,74,.5);}
.mg-kart-hslot.ready::before{border-color:rgba(242,182,74,.5);border-style:solid;}
.mg-kart-hslot.spin{animation:mg-kart-hspin .3s linear infinite;}
@keyframes mg-kart-hspin{0%{rotate:-4deg}50%{rotate:4deg}100%{rotate:-4deg}}
.mg-kart-hslot.pop{animation:mg-kart-hpop .42s var(--spring,cubic-bezier(.2,1.35,.4,1));}
@keyframes mg-kart-hpop{0%{scale:1.34}60%{scale:.96}100%{scale:1.06}}
.mg-kart-hicon{width:66px;height:66px;display:block;}
.mg-kart-hicon svg{width:100%;height:100%;display:block;}
.mg-kart-hitname{position:absolute;bottom:-11px;left:50%;translate:-50% 0;white-space:nowrap;
  background:var(--kh-ink);color:#fff6e3;font-size:10.5px;font-weight:900;letter-spacing:.04em;
  padding:3px 11px;border-radius:99px;opacity:0;transition:opacity .18s ease;}
.mg-kart-hitname.on{opacity:1;}
.mg-kart-hitname b{color:var(--kh-gold);margin-left:6px;}

/* --- 4. speedometer ---------------------------------------------------- */
.mg-kart-hspeedo{position:absolute;left:16px;bottom:14px;width:168px;height:132px;
  pointer-events:none;}
.mg-kart-hspeedo svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
.mg-kart-hdial{position:absolute;left:50%;bottom:2px;translate:-50% 0;text-align:center;}
.mg-kart-hspd{font-size:38px;font-weight:900;line-height:.9;color:#fff6e3;
  text-shadow:0 3px 0 rgba(45,36,23,.5),0 0 18px rgba(16,52,78,.5);
  font-variant-numeric:tabular-nums;transition:color .18s ease;}
.mg-kart-hunit{font-size:10px;font-weight:900;letter-spacing:.22em;color:rgba(255,246,227,.75);
  text-transform:uppercase;text-shadow:0 2px 0 rgba(45,36,23,.4);}
/* The needle's pivot is the rotate(deg 60 66) attribute on the element and
   NOTHING else. An SVG element's initial transform-origin is 0 0, so adding
   transform-box/transform-origin here composed a SECOND pivot on top of that
   rotate and threw the needle clean off the dial. Do not put one back. */

/* --- 5. minimap -------------------------------------------------------- */
.mg-kart-hmini{position:absolute;right:16px;bottom:14px;width:${MAP_SIZE + 16}px;
  padding:8px 8px 6px;border-radius:22px;background:var(--kh-cream);box-shadow:var(--kh-lift);}
.mg-kart-hmini canvas{display:block;width:${MAP_SIZE}px;height:${MAP_SIZE}px;border-radius:16px;
  background:rgba(45,36,23,.06);}
.mg-kart-hminilbl{display:flex;justify-content:space-between;align-items:center;gap:8px;
  margin-top:4px;font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;
  color:var(--kh-mut);}
.mg-kart-hminilbl b{color:#5c5140;letter-spacing:.02em;text-transform:none;font-size:11.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

/* --- 6. countdown lights ----------------------------------------------- */
/* the lamps stand exactly where the item slot will be, and the slot is hidden
   until the flag drops: one focal point at the top of frame, never two */
.mg-kart-hface.pre .mg-kart-hslot{opacity:0;}
.mg-kart-hlamps{position:absolute;top:36px;left:50%;translate:-50% 0;display:none;gap:13px;
  padding:12px 18px;border-radius:99px;background:rgba(45,36,23,.55);
  box-shadow:0 8px 24px rgba(16,52,78,.4);}
.mg-kart-hlamps.on{display:flex;}
.mg-kart-hlamp{width:28px;height:28px;border-radius:99px;background:#493d3d;
  box-shadow:inset 0 -4px 0 rgba(0,0,0,.3),inset 0 3px 0 rgba(255,255,255,.09);
  transition:background .12s ease,box-shadow .12s ease,scale .2s var(--spring,cubic-bezier(.2,1.35,.4,1));}
.mg-kart-hlamp.lit{background:#e8657a;scale:1.08;
  box-shadow:0 0 18px rgba(232,101,122,.95),inset 0 -4px 0 rgba(0,0,0,.2);}
.mg-kart-hlamp.go{background:#7ac74f;scale:1.16;
  box-shadow:0 0 22px rgba(122,199,79,1),inset 0 -4px 0 rgba(0,0,0,.2);}

/* --- 7. wrong way ------------------------------------------------------ */
.mg-kart-hwrong{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  flex-direction:column;gap:10px;}
.mg-kart-hwrong.on{display:flex;}
.mg-kart-hpulse{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(ellipse 74% 66% at 50% 50%,rgba(232,101,122,0) 46%,rgba(232,101,122,.5) 100%);
  animation:mg-kart-hpulse 1.15s ease-in-out infinite;}
@keyframes mg-kart-hpulse{0%,100%{opacity:.35}50%{opacity:.9}}
.mg-kart-hwsign{position:relative;display:flex;align-items:center;gap:14px;
  background:var(--kh-cream);border:4px solid var(--kh-coral);border-radius:26px;
  padding:12px 22px 12px 16px;box-shadow:0 10px 0 rgba(150,55,72,.28),0 16px 34px rgba(16,52,78,.4);
  animation:mg-kart-hwake .5s var(--spring,cubic-bezier(.2,1.35,.4,1));}
@keyframes mg-kart-hwake{from{opacity:0;scale:.8;translate:0 -14px}}
.mg-kart-hwcapy{animation:mg-kart-hwnod 1.1s ease-in-out infinite;flex:none;}
@keyframes mg-kart-hwnod{0%,100%{rotate:-7deg}50%{rotate:7deg}}
.mg-kart-hwtxt{text-align:left;}
.mg-kart-hwbig{font-size:clamp(26px,4.6vw,42px);font-weight:900;color:var(--kh-coral);
  line-height:.95;letter-spacing:.01em;}
.mg-kart-hwsub{font-size:13px;font-weight:800;color:#8a7a5a;margin-top:2px;}
.mg-kart-hwarrow{position:relative;width:74px;height:74px;color:var(--kh-gold);
  filter:drop-shadow(0 5px 0 rgba(45,36,23,.3));animation:mg-kart-hwbob 1s ease-in-out infinite;}
@keyframes mg-kart-hwbob{0%,100%{scale:1}50%{scale:1.12}}
.mg-kart-hwarrow svg{width:100%;height:100%;display:block;}

/* --- toasts + banners --------------------------------------------------- */
.mg-kart-htoasts{position:absolute;left:50%;top:58%;translate:-50% 0;width:0;}
.mg-kart-htoast{position:absolute;left:0;top:0;translate:-50% 0;white-space:nowrap;
  font-weight:900;font-size:25px;color:#fff6e3;text-shadow:0 3px 0 rgba(45,36,23,.4);
  display:flex;align-items:center;gap:6px;animation:mg-kart-htoast 1.05s ease-out forwards;}
.mg-kart-htoast.coin{color:var(--kh-gold);}
.mg-kart-htoast.box{color:#bfe9ff;}
.mg-kart-htoast.boost{color:#ffd77a;}
.mg-kart-htoast.hit{color:#ff9bab;}
@keyframes mg-kart-htoast{from{opacity:0;translate:-50% 18px;scale:.6}
  22%{opacity:1;translate:-50% 0;scale:1}to{opacity:0;translate:-50% -46px;scale:1}}
.mg-kart-hbanner{position:absolute;left:0;right:0;top:31%;text-align:center;pointer-events:none;
  font-size:clamp(34px,6.4vw,60px);font-weight:900;color:#fff6e3;letter-spacing:.02em;
  text-shadow:0 6px 0 rgba(45,36,23,.35),0 0 30px rgba(242,182,74,.55);
  animation:mg-kart-hban 1.9s ease-out forwards;}
.mg-kart-hbanner.gold{color:var(--kh-gold);}
@keyframes mg-kart-hban{0%{opacity:0;translate:-46px 0;scale:.9}
  14%{opacity:1;translate:0 0;scale:1}72%{opacity:1}100%{opacity:0;translate:46px 0}}

/* --- 8/9. podium, confetti, results ------------------------------------- */
.mg-kart-hconf{position:absolute;inset:0;overflow:hidden;pointer-events:none;}
.mg-kart-hbit{position:absolute;top:-6%;width:10px;height:14px;border-radius:3px;
  animation:mg-kart-hfall linear forwards;}
@keyframes mg-kart-hfall{from{opacity:1;translate:0 0;rotate:0deg}
  to{opacity:.15;translate:var(--dx) 118vh;rotate:var(--rot)}}
.mg-kart-hsheet{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  padding:16px;pointer-events:auto;overflow:auto;
  background:radial-gradient(ellipse 70% 62% at 50% 44%,rgba(45,36,23,.24) 0%,rgba(20,32,44,.62) 100%);}
.mg-kart-hsheet.on{display:flex;animation:mg-kart-hfade .3s ease;}
@keyframes mg-kart-hfade{from{opacity:0}}
.mg-kart-hcard{width:min(560px,96vw);background:var(--cream,#fff6e3);border-radius:30px;
  padding:18px 22px 20px;box-shadow:0 18px 46px rgba(16,52,78,.45);text-align:center;
  animation:mg-kart-hrise .34s var(--spring,cubic-bezier(.2,1.35,.4,1));margin:auto;}
@keyframes mg-kart-hrise{from{opacity:0;translate:0 26px;scale:.95}}
.mg-kart-htitle{font-size:38px;font-weight:900;color:var(--kh-coral);line-height:1;}
.mg-kart-hsub{font-size:13px;font-weight:800;color:#8a7a5a;margin-top:5px;}
.mg-kart-hpodium{display:flex;align-items:flex-end;justify-content:center;gap:8px;margin:12px 0 2px;}
.mg-kart-hplinth{width:92px;display:flex;flex-direction:column;align-items:center;}
.mg-kart-hcapy{animation:mg-kart-hhop 1.05s ease-in-out infinite;}
@keyframes mg-kart-hhop{0%,100%{translate:0 0}45%{translate:0 -11px}}
.mg-kart-hpname{font-size:11.5px;font-weight:900;color:#5c5140;margin:3px 0 4px;max-width:96px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mg-kart-hblock{width:100%;border-radius:12px 12px 4px 4px;display:flex;align-items:center;
  justify-content:center;font-size:22px;font-weight:900;color:rgba(45,36,23,.55);
  box-shadow:inset 0 -6px 0 rgba(45,36,23,.14);}
.mg-kart-hboard{display:flex;flex-direction:column;gap:5px;margin:12px 0 2px;}
.mg-kart-hbrow{display:flex;align-items:center;gap:9px;background:var(--card,#fffdf6);
  border-radius:12px;padding:6px 11px;font-size:12.5px;font-weight:800;color:#5c5140;}
.mg-kart-hbrow.me{outline:3px solid var(--kh-coral);outline-offset:-3px;}
.mg-kart-hbrow i{width:13px;height:13px;border-radius:99px;flex:none;
  box-shadow:inset 0 -3px 0 rgba(0,0,0,.22);}
.mg-kart-hbrow .p{width:28px;color:var(--kh-mut);font-size:11px;flex:none;text-align:left;}
.mg-kart-hbrow .nm{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.mg-kart-hbrow .kt{font-size:10.5px;color:#a2937a;font-weight:800;flex:none;}
.mg-kart-hbrow b{font-size:11.5px;color:#4a4032;font-variant-numeric:tabular-nums;flex:none;}
.mg-kart-hstats{display:flex;flex-direction:column;gap:6px;margin:12px 0 2px;}
.mg-kart-hstat{display:flex;justify-content:space-between;align-items:center;
  background:var(--card,#fffdf6);border-radius:13px;padding:7px 13px;font-size:13.5px;font-weight:800;}
.mg-kart-hstat.total{background:#2d2417;color:#fff6e3;}
.mg-kart-hstat.pay{background:var(--kh-gold);font-size:17px;}
.mg-kart-hstat.pay b{display:flex;align-items:center;gap:7px;font-variant-numeric:tabular-nums;}
.mg-kart-htag{display:inline-block;background:var(--kh-coral);color:#fff;font-size:10.5px;
  font-weight:900;letter-spacing:.08em;padding:2px 9px;border-radius:99px;margin-left:8px;
  animation:mg-kart-htag .85s ease-in-out infinite;}
@keyframes mg-kart-htag{50%{scale:1.13}}
.mg-kart-hbtns{display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap;}
.mg-kart-hbtn{background:var(--kh-coral);color:#fff;border:3px solid #fff;cursor:pointer;
  font-family:inherit;font-weight:900;font-size:16px;padding:11px 24px;border-radius:999px;
  box-shadow:0 5px 0 rgba(150,55,72,.32);transition:scale .12s ease,filter .16s ease;}
.mg-kart-hbtn:hover{scale:1.06;filter:brightness(1.05);}
.mg-kart-hbtn:active{scale:.96;}
.mg-kart-hbtn:focus-visible{outline:3px solid var(--kh-sky);outline-offset:3px;}
.mg-kart-hbtn.alt{background:var(--kh-sky);box-shadow:0 5px 0 rgba(37,110,155,.32);}
.mg-kart-hwaiting{font-size:12.5px;font-weight:800;color:#8a7a5a;margin:10px 0 2px;
  animation:mg-kart-hblink 1.5s ease-in-out infinite;}
@keyframes mg-kart-hblink{50%{opacity:.35}}

@media (max-width:720px){
  .mg-kart-htower{width:170px;}
  .mg-kart-hmini{width:${Math.round(MAP_SIZE * 0.72) + 16}px;}
  .mg-kart-hmini canvas{width:${Math.round(MAP_SIZE * 0.72)}px;height:${Math.round(MAP_SIZE * 0.72)}px;}
  .mg-kart-hspeedo{width:132px;height:104px;}
  .mg-kart-hspd{font-size:30px;}
}
@media (prefers-reduced-motion:reduce){
  .mg-kart-hudroot *{animation-duration:.001s !important;animation-iteration-count:1 !important;}
  .mg-kart-hbit{display:none;}
}
`;

// =================================================================== class ==
export class KartHud {
  /**
   * @param {HTMLElement} root  the minigame's own wrapper; nothing outside it is touched
   * @param {object} opts  { laps, you, track:{id,name,theme,road,yMin,yMax,points:[{x,z,y}]},
   *                         roster:[{slot,name,color,kart,ai,ghost}],
   *                         onAgain?, onQuit?, onPlay? }
   *
   * `track` may also carry `posOf(q, lat, out)` (kart.js's own `worldOf` is
   * exactly that shape), or `sFin` + `LAP_UNITS`: either one puts the minimap
   * dots on the finish-line origin `q` is measured from. Without them the map
   * assumes the finish line sits at `points[0]`. See `_mapAt`.
   */
  constructor(root, opts = {}) {
    this.root = root || null;
    this.opts = opts || {};
    this.laps = Math.max(1, Math.round(Number(opts.laps) || 3));
    this.you = Number.isFinite(opts.you) ? Math.round(opts.you) : 0;
    this.track = opts.track || {};
    this.roster = Array.isArray(opts.roster) ? opts.roster.slice(0, 8) : [];
    this.onAgain = typeof opts.onAgain === 'function' ? opts.onAgain : null;
    this.onQuit = typeof opts.onQuit === 'function' ? opts.onQuit : null;
    this.play = typeof opts.onPlay === 'function' ? opts.onPlay : null;

    this.mounted = false;
    this.disposed = false;
    this.phase = 'splash';
    this.el = {};                 // every node we own, by short key
    this.rows = new Map();        // slot -> { el, gap, lap, cache }
    this.timers = new Set();
    this.listeners = [];
    this.splits = [];             // completed lap splits, newest last

    // roulette state, driven by update()'s dt rather than a timer of our own
    this._it = { item: null, spinning: false, left: 0, shownIcon: null, ready: false };
    this._spinAcc = 0;
    this._mapAcc = 1;             // paint the first frame immediately
    this._wrong = false;
    this._wrongDeg = 9999;
    this._lapNo = 1;              // the view model carries no lap number: lap() owns it
    this._resCoins = null;        // guards the results screen against a second payout dance
    this.map = null;

    // every value the hot path writes, cached so a frame that changed nothing
    // touches no DOM at all
    this.c = {
      place: -1, of: -1, lap: -1, now: -1, best: -1, spd: -1, arc: -1,
      needle: -9999, tier: -1, boost: -1,
    };
  }

  // ------------------------------------------------------------- lifecycle --
  /** Build the overlay. Idempotent: a second call is a no-op (§A7). */
  mount() {
    if (this.mounted || this.disposed || !this.root) return;
    this.mounted = true;

    const style = document.createElement('style');
    style.id = 'mg-kart-hud-css';
    style.textContent = CSS;
    this.styleEl = style;

    const host = document.createElement('div');
    host.className = 'mg-kart-hudroot';
    host.appendChild(style);
    this.host = host;

    host.appendChild(this._buildFace());
    host.appendChild(this._buildLamps());
    host.appendChild(this._buildWrong());

    const toasts = document.createElement('div');
    toasts.className = 'mg-kart-htoasts';
    host.appendChild(toasts);
    this.el.toasts = toasts;

    const banners = document.createElement('div');
    banners.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    host.appendChild(banners);
    this.el.banners = banners;

    const conf = document.createElement('div');
    conf.className = 'mg-kart-hconf';
    host.appendChild(conf);
    this.el.conf = conf;

    const sheet = document.createElement('div');
    sheet.className = 'mg-kart-hsheet';
    host.appendChild(sheet);
    this.el.sheet = sheet;

    this.root.appendChild(host);
    this._buildMinimapBase();
    this.setPhase(this.phase);
  }

  /** 'splash' | 'count' | 'race' | 'done' | 'results'. */
  setPhase(phase) {
    // the bed steps back for the two moments that have their own voice (the
    // lights and the podium) and comes straight back up for the race. The `ms`
    // is a self-release, so a HUD torn down mid-countdown cannot leave the cove
    // playing under a duck forever.
    audio.duck('kart-moment', phase === 'count' || phase === 'results' ? -6 : 0, 20000);
    this.phase = String(phase || 'splash');
    if (!this.mounted) return;
    const racing = this.phase === 'count' || this.phase === 'race' || this.phase === 'done';
    this.el.face.classList.toggle('on', racing);
    this.el.face.classList.toggle('pre', this.phase === 'count');
    if (this.phase !== 'count') this.el.lamps.classList.remove('on');
    if (this.phase !== 'results') {
      this.el.sheet.classList.remove('on');
      this.el.sheet.textContent = '';
      this.el.conf.textContent = '';
      this._resCoins = null;
    }
    if (!racing) this.wrongWay(false);
    if (this.phase === 'splash' || this.phase === 'count') this._resetRun();
  }

  /** §A7.6 — n = 3..1 on each red beat, `go` on the green. */
  countdown(n, go) {
    if (!this.mounted) return;
    const lamps = this.el.lampEls;
    this.el.lamps.classList.add('on');
    if (go) {
      for (const b of lamps) { b.classList.remove('lit'); b.classList.add('go'); }
      this._banner('GO!', true);
      this._timer(() => this.el.lamps.classList.remove('on'), 700);
      return;
    }
    // fill from the outside in, so the five bulbs read as three beats
    const step = clamp(4 - Math.round(Number(n) || 3), 1, 3);
    const litSets = [[0, 4], [1, 3], [2]];
    for (let i = 0; i < step; i++) {
      for (const idx of litSets[i]) lamps[idx]?.classList.add('lit');
    }
    this._banner(String(clamp(Math.round(Number(n) || 3), 1, 9)), false);
  }

  /**
   * The hot path. Called every frame by kart.js with a REUSED view object, so
   * nothing here may hold on to it: read, compare against the cache, write only
   * what moved.
   */
  update(view, dt) {
    if (!this.mounted || !view) return;
    const c = this.c;
    const d = Number(dt) || 0;

    // ---- 1. position tower
    const place = clamp(Math.round(Number(view.place) || 1), 1, 12);
    const of = clamp(Math.round(Number(view.of) || this.roster.length || 6), 1, 12);
    if (place !== c.place) {
      c.place = place;
      this.el.place.textContent = ordinal(place);
      this.el.place.classList.add('bump');
      this._timer(() => this.el.place?.classList.remove('bump'), 190);
    }
    if (of !== c.of) { c.of = of; this.el.of.textContent = `of ${of}`; }
    this._order(view.order);

    // ---- 2. lap panel. The frozen view model carries no lap number, so lap()
    // owns it; a `view.lap` is honoured when kart.js chooses to send one anyway.
    const lap = clamp(Math.round(Number.isFinite(view.lap) ? view.lap : this._lapNo), 1, this.laps);
    if (lap !== c.lap) { c.lap = lap; this.el.lapn.textContent = String(lap); }
    const now = Math.floor(Math.max(0, Number(view.lapMs) || 0) / 10);
    if (now !== c.now) { c.now = now; this.el.now.textContent = lapTime(now * 10); }
    // a best lap only ever improves inside a run, so a frame that omits the
    // field, sends 0, or lags a tick behind the lap() that just landed can never
    // walk the badge backwards. A Play Again clears it through _resetRun().
    const best = Math.round(Number(view.bestMs) || 0);
    if (best > 0 && (c.best <= 0 || best < c.best)) {
      c.best = best;
      this.el.bestl.textContent = `best ${lapTime(best)}`;
    }

    // ---- 3. item slot (the roulette runs on dt, never on a timer)
    this._spin(d);

    // ---- 4. speedometer
    const v = Math.max(0, Number(view.v) || 0);
    const vmax = Math.max(1, Number(view.vmax) || 22);
    const tier = clamp(Math.round(Number(view.drift) || 0), 0, 3);
    const boosting = !!view.boost;
    const spd = Math.round(v);
    if (spd !== c.spd) { c.spd = spd; this.el.spd.textContent = String(spd); }
    const t = clamp(v / SPEED_FULL, 0, 1);
    const arc = Math.round(t * 200) / 2;                       // quantised to 0.5%
    if (arc !== c.arc) {
      c.arc = arc;
      this.el.arcVal.style.strokeDashoffset = String(100 - arc);
    }
    const deg = Math.round((-110 + t * 220) * 2) / 2;
    if (deg !== c.needle) {
      c.needle = deg;
      this.el.needle.setAttribute('transform', `rotate(${deg} 60 66)`);
    }
    const key = tier * 2 + (boosting ? 1 : 0);
    if (key !== c.tier) {
      c.tier = key;
      const col = boosting ? '#ffd77a' : TIER_COLORS[tier];
      this.el.arcVal.setAttribute('stroke', col);
      this.el.needle.setAttribute('fill', col);
      this.el.spd.style.color = boosting ? '#ffe9b0' : '#fff6e3';
      this.el.band.style.opacity = boosting ? '1' : '0.22';
    }
    // the band is where the dial stops being honest speed and starts being boost
    const bandStart = clamp(vmax / SPEED_FULL, 0, 1);
    if (bandStart !== c.boost) {
      c.boost = bandStart;
      this.el.band.setAttribute('stroke-dasharray', `${(1 - bandStart) * 100} 100`);
      this.el.band.setAttribute('stroke-dashoffset', String(-bandStart * 100));
    }

    // ---- 5. minimap at 20 Hz
    this._mapAcc += d;
    if (this._mapAcc >= 1 / MAP_HZ) { this._mapAcc = 0; this._drawMap(view); }

    // ---- 7. wrong way. The banner is normally driven by wrongWay(), but the
    // view model carries the flag too, so either road works and both agree.
    if (view.wrong !== undefined) this.wrongWay(view.wrong);
    if (this._wrong) {
      const wd = Math.round((Number(view.wrongDir) || 0) * 180 / Math.PI);
      if (wd !== this._wrongDeg) {
        this._wrongDeg = wd;
        this.el.warrow.style.rotate = `${wd}deg`;
      }
    }
  }

  /** §A7.3 — { item, spinning, ms }. A spin ends on its own after `ms`. */
  item(o = {}) {
    if (!this.mounted) return;
    const it = this._it;
    const next = typeof o.item === 'string' && ITEM_NAMES[o.item] ? o.item : null;
    const spinning = !!o.spinning;
    const wasHolding = !!it.item;
    it.item = next;
    it.spinning = spinning;
    it.left = spinning ? Math.max(0.05, (Number(o.ms) || 600) / 1000) : 0;
    this.el.slot.classList.toggle('spin', spinning);
    if (spinning) {
      it.ready = false;
      this.el.slot.classList.remove('ready');
      this.el.itname.classList.remove('on');
    } else {
      this._lockItem(!wasHolding && !!next);
    }
  }

  /** §A7.2 — a completed lap: split stack, best-lap flash, FINAL LAP banner. */
  lap(o = {}) {
    if (!this.mounted) return;
    const laps = Math.max(1, Math.round(Number(o.laps) || this.laps));
    this.laps = laps;
    this.el.lapof.textContent = `/${laps}`;
    // `lap` is the lap just COMPLETED (kart-lap §4.6), so the counter moves on
    // to the next one and parks on the last lap when the flag falls.
    const n = clamp(Math.round(Number(o.lap) || 1), 1, laps);
    this._lapNo = clamp(n + 1, 1, laps);
    const split = Math.max(0, Number(o.splitMs) || 0);
    if (split > 0) {
      this.splits.push({ n, ms: split, best: !!o.best });
      if (this.splits.length > 4) this.splits.shift();
      this._paintSplits();
    }
    if (o.best && split > 0) {
      this.el.sheen.classList.remove('go');
      void this.el.sheen.offsetWidth;      // restart the sweep
      this.el.sheen.classList.add('go');
      this._banner('NEW BEST LAP', true);
      this.play?.('ding');
    }
    const bestMs = Math.max(0, Number(o.bestMs) || 0);
    if (bestMs > 0) {
      this.c.best = Math.round(bestMs);
      this.el.bestl.textContent = `best ${lapTime(bestMs)}`;
    }
    this.c.lap = -1;                        // let the next update() repaint it
    if (o.final) this._banner('FINAL LAP', true);
  }

  /** §A6 — cozy, never punishing: a capy pointing the way you should be going. */
  wrongWay(on) {
    const want = !!on;
    if (!this.mounted || want === this._wrong) return;
    this._wrong = want;
    this.el.wrong.classList.toggle('on', want);
    this._wrongDeg = 9999;
  }

  /** A floating shout: 'coin' | 'hit' | 'boost' | 'box' | 'plain'. */
  toast(kind, text) {
    if (!this.mounted || !text) return;
    const k = ['coin', 'hit', 'boost', 'box'].includes(kind) ? kind : 'plain';
    const el = document.createElement('div');
    el.className = `mg-kart-htoast ${k}`;
    el.innerHTML = (k === 'coin' ? COIN_SVG : '') + `<span>${esc(text)}</span>`;
    el.style.left = `${Math.round((Math.random() - 0.5) * 150)}px`;
    el.style.top = `${Math.round((Math.random() - 0.5) * 44)}px`;
    this.el.toasts.appendChild(el);
    this._sweep(el, 1400);
  }

  /**
   * §A7.8/9 — the podium, the confetti, the board and the coin count-up.
   * @param {object} p { rows, you, coins, score, best, newBest, trackName,
   *                     laps?, boxes?, bestLap?, fastest?, paid?, onAgain?, onQuit? }
   */
  results(p = {}) {
    if (!this.mounted) return;
    this.phase = 'results';
    this.el.face.classList.remove('on');
    this.el.lamps.classList.remove('on');
    this.wrongWay(false);

    const rows = (Array.isArray(p.rows) ? p.rows : []).slice(0, 8);
    const you = Number.isFinite(p.you) ? Math.round(p.you) : this.you;
    const mine = rows.find((r) => Number(r.slot) === you) || null;
    const place = clamp(Math.round(Number(p.place ?? mine?.place) || 0) || 6, 1, 8);
    const coins = Math.max(0, Math.round(Number(p.coins) || 0));
    const paid = p.paid !== undefined ? !!p.paid : coins > 0;
    const trackName = String(p.trackName || this.track.name || 'the cove');
    const title = !paid ? 'Race over'
      : place === 1 ? 'Chequered flag!'
        : place <= 3 ? 'On the podium!' : 'Good scrap out there';

    const sheet = this.el.sheet;
    // A second results() for the same run is the late `kart-end` filling in the
    // field: refresh the board and the podium in place, and do NOT replay the
    // confetti or count the coins up a second time.
    if (sheet.classList.contains('on') && this._resCoins === coins) {
      const board = sheet.querySelector('.mg-kart-hboard');
      if (board) board.innerHTML = this._boardHtml(rows, you);
      const pod = sheet.querySelector('.mg-kart-hpodwrap');
      if (pod) pod.innerHTML = this._podiumHtml(rows);
      return;
    }
    this._resCoins = coins;
    sheet.textContent = '';
    const card = document.createElement('div');
    card.className = 'mg-kart-hcard';
    card.innerHTML = `
      <div class="mg-kart-htitle">${esc(title)}</div>
      <div class="mg-kart-hsub">${paid
    ? `You finished ${ordinal(place)} of ${rows.length || 6} at ${esc(trackName)}.`
    : `You did not take the flag at ${esc(trackName)}, so no coins this time.`}</div>
      <div class="mg-kart-hpodwrap">${this._podiumHtml(rows)}</div>
      <div class="mg-kart-hboard">${this._boardHtml(rows, you)}</div>
      <div class="mg-kart-hstats">
        <div class="mg-kart-hstat"><span>Finishing place</span><b>${ordinal(place)}</b></div>
        <div class="mg-kart-hstat"><span>Laps completed</span><b>${
  clamp(Math.round(Number(p.laps ?? mine?.laps) || 0), 0, this.laps)} / ${this.laps}</b></div>
        <div class="mg-kart-hstat"><span>Paw boxes</span><b>${
  Math.max(0, Math.round(Number(p.boxes) || 0))}</b></div>
        <div class="mg-kart-hstat"><span>Best lap</span><b>${lapTime(Number(p.bestLap ?? mine?.best) || 0)}${
  p.fastest ? '<span class="mg-kart-htag">FASTEST</span>' : ''}</b></div>
        <div class="mg-kart-hstat total"><span>Score</span><b>${
  Math.max(0, Math.round(Number(p.score) || 0)).toLocaleString()}</b></div>
        <div class="mg-kart-hstat pay"><span>Coins earned</span><b>${COIN_SVG}<span data-a="coins">0</span></b></div>
      </div>
      <div class="mg-kart-hsub">Best race score: <b>${
  Math.max(0, Math.round(Number(p.best) || 0)).toLocaleString()}</b>${
  p.newBest ? '<span class="mg-kart-htag">NEW BEST</span>' : ''}</div>
      <div class="mg-kart-hbtns">
        <button type="button" class="mg-kart-hbtn" data-a="again">Race again</button>
        <button type="button" class="mg-kart-hbtn alt" data-a="quit">Back to the paddock</button>
      </div>`;
    sheet.appendChild(card);
    sheet.classList.add('on');

    const again = typeof p.onAgain === 'function' ? p.onAgain : this.onAgain;
    const quit = typeof p.onQuit === 'function' ? p.onQuit : this.onQuit;
    this._click(card.querySelector('[data-a="again"]'), 'kart-hud:again', again);
    this._click(card.querySelector('[data-a="quit"]'), 'kart-hud:quit', quit);

    this._confetti(place <= 3 ? CONFETTI : Math.round(CONFETTI * 0.45));
    this._countUp(card.querySelector('[data-a="coins"]'), coins);
  }

  /** Leave `root` exactly as we found it: nodes, styles, timers, listeners. */
  dispose() {
    audio.duck('kart-moment', 0); // whatever the phase was, the bed comes back
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const [target, type, fn] of this.listeners) {
      try { target.removeEventListener(type, fn); } catch { /* already gone */ }
    }
    this.listeners.length = 0;
    this.rows.clear();
    this.host?.remove();
    this.styleEl?.remove();
    this.host = null;
    this.styleEl = null;
    this.el = {};
    this.map = null;
    this.mapBase = null;
    this.mapCtx = null;
    this.mounted = false;
  }

  // ============================================================== internals ==
  /** setTimeout that always dies with the HUD. */
  _timer(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  /** Remove on animationend OR on a timer, whichever lands first: a backgrounded
   *  tab swallows animationend, and a stuck overlay node is a bug you can see. */
  _sweep(el, ms) {
    let gone = false;
    const kill = () => {
      if (gone) return;
      gone = true;
      el.remove();
    };
    el.addEventListener('animationend', kill, { once: true });
    this._timer(kill, ms);
  }

  _click(btn, evName, fn) {
    if (!btn) return;
    const handler = (e) => {
      e.preventDefault();
      this.play?.('click');
      this.host?.dispatchEvent(new CustomEvent(evName, { bubbles: true }));
      fn?.();
    };
    btn.addEventListener('click', handler);
    this.listeners.push([btn, 'click', handler]);
  }

  _banner(text, gold) {
    const el = document.createElement('div');
    el.className = `mg-kart-hbanner${gold ? ' gold' : ''}`;
    el.textContent = text;
    this.el.banners.appendChild(el);
    this._sweep(el, 2200);
  }

  /** Clear anything that belongs to one run, so Play Again starts clean. */
  _resetRun() {
    this.splits.length = 0;
    this._lapNo = 1;
    this._paintSplits();
    this.item({ item: null, spinning: false });
    for (const b of this.el.lampEls || []) b.className = 'mg-kart-hlamp';
    this.c.place = -1; this.c.lap = -1; this.c.now = -1; this.c.best = 0;
    for (const row of this.rows.values()) row.cache.gap = '';
    if (this.el.bestl) this.el.bestl.textContent = 'best --:--';
  }

  // ------------------------------------------------------------------- DOM --
  _buildFace() {
    const face = document.createElement('div');
    face.className = 'mg-kart-hface';
    const road = hex6(this.track.road ?? 0x5b5568);
    face.innerHTML = `
      <div class="mg-kart-hpanel mg-kart-htower">
        <div class="mg-kart-hlbl">Position</div>
        <div class="mg-kart-hpos">
          <span class="mg-kart-hplace" data-f="place">1st</span>
          <span class="mg-kart-hof" data-f="of">of 6</span>
        </div>
        <div class="mg-kart-hlist" data-f="list"></div>
      </div>

      <div class="mg-kart-hpanel mg-kart-hlap">
        <div class="mg-kart-hsheen" data-f="sheen"></div>
        <div class="mg-kart-hlbl">Lap</div>
        <div class="mg-kart-hlapn"><span data-f="lapn">1</span><span data-f="lapof">/${this.laps}</span></div>
        <div class="mg-kart-hnow" data-f="now">0:00.00</div>
        <div class="mg-kart-hbestl" data-f="bestl">best --:--</div>
        <div class="mg-kart-hsplits" data-f="splits"></div>
      </div>

      <div class="mg-kart-hslot" data-f="slot">
        <div class="mg-kart-hicon" data-f="icon"></div>
        <div class="mg-kart-hitname" data-f="itname">Melon Peel<b>E</b></div>
      </div>

      <div class="mg-kart-hspeedo">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <path d="M18.6 80.9A44 44 0 1 1 101.4 80.9" fill="none" stroke="rgba(45,36,23,.42)"
            stroke-width="15" stroke-linecap="round" pathLength="100"/>
          <path d="M18.6 80.9A44 44 0 1 1 101.4 80.9" fill="none" stroke="rgba(255,246,227,.5)"
            stroke-width="11" stroke-linecap="round" pathLength="100"/>
          <path data-f="band" d="M18.6 80.9A44 44 0 1 1 101.4 80.9" fill="none" stroke="#ffd77a"
            stroke-width="11" stroke-linecap="butt" pathLength="100" opacity=".22"
            stroke-dasharray="39 100" stroke-dashoffset="-61"/>
          <path data-f="arc" d="M18.6 80.9A44 44 0 1 1 101.4 80.9" fill="none" stroke="#4a4032"
            stroke-width="11" stroke-linecap="round" pathLength="100"
            stroke-dasharray="100" stroke-dashoffset="100"/>
          <!-- (60, 66) is the arc's true centre: the 44-radius sweep from
               (18.6, 80.9) to (101.4, 80.9) is centred 14.9 above its chord.
               The hub, the needle and the rotate() in update() all pivot there,
               so the needle points exactly at the arc it is reading. -->
          <circle cx="60" cy="66" r="7.5" fill="rgba(45,36,23,.55)"/>
          <path data-f="needle" class="mg-kart-hneedle" fill="#4a4032"
            d="M60 24 L64.4 64 L55.6 64 Z" transform="rotate(-110 60 66)"/>
          <circle cx="60" cy="66" r="3.4" fill="#fff6e3"/>
        </svg>
        <div class="mg-kart-hdial">
          <div class="mg-kart-hspd" data-f="spd">0</div>
          <div class="mg-kart-hunit">u / s</div>
        </div>
      </div>

      <div class="mg-kart-hmini">
        <canvas data-f="map" width="${MAP_SIZE}" height="${MAP_SIZE}"></canvas>
        <div class="mg-kart-hminilbl"><b>${esc(this.track.name || 'Capy Speedway')}</b>
          <span data-f="elev" style="color:${road}">flat</span></div>
      </div>`;
    face.querySelectorAll('[data-f]').forEach((el) => { this.el[el.dataset.f] = el; });
    this.el.face = face;
    this.el.arcVal = this.el.arc;
    this.mapCtx = this.el.map.getContext('2d');
    this._buildRows();
    return face;
  }

  /** One row per roster slot, built once. Reordering is a flex `order` write. */
  _buildRows() {
    const list = this.el.list;
    for (const r of this.roster) {
      const slot = Number(r.slot) || 0;
      const el = document.createElement('div');
      el.className = 'mg-kart-hrow';
      el.innerHTML = `<u>${slot + 1}</u><i style="background:${hex6(r.color)}"></i>`
        + `<s>${esc(r.name || 'capy')}</s><span class="mg-kart-hgap">--</span>`;
      list.appendChild(el);
      this.rows.set(slot, {
        el, pos: el.querySelector('u'), gap: el.querySelector('.mg-kart-hgap'),
        cache: { i: -1, gap: '', ghost: null, me: null },
      });
    }
  }

  _buildLamps() {
    const lamps = document.createElement('div');
    lamps.className = 'mg-kart-hlamps';
    this.el.lampEls = [];
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('div');
      b.className = 'mg-kart-hlamp';
      lamps.appendChild(b);
      this.el.lampEls.push(b);
    }
    this.el.lamps = lamps;
    return lamps;
  }

  _buildWrong() {
    const me = this.roster.find((r) => Number(r.slot) === this.you);
    const wrong = document.createElement('div');
    wrong.className = 'mg-kart-hwrong';
    wrong.innerHTML = `
      <div class="mg-kart-hpulse"></div>
      <div class="mg-kart-hwarrow" data-f="warrow"><svg viewBox="0 0 64 64">
        <path d="M32 4 L52 30 H41 V58 H23 V30 H12 Z" fill="currentColor"
          stroke="#fff6e3" stroke-width="3.5" stroke-linejoin="round"/></svg></div>
      <div class="mg-kart-hwsign">
        <div class="mg-kart-hwcapy">${capyFace(me?.color ?? 0xb08a5a, 62)}</div>
        <div class="mg-kart-hwtxt">
          <div class="mg-kart-hwbig">WRONG WAY</div>
          <div class="mg-kart-hwsub">Spin it round, the flag is that way!</div>
        </div>
      </div>`;
    wrong.querySelectorAll('[data-f]').forEach((el) => { this.el[el.dataset.f] = el; });
    this.el.wrong = wrong;
    return wrong;
  }

  // -------------------------------------------------------- tower / splits --
  _order(order) {
    if (!Array.isArray(order) || !order.length) return;
    for (let i = 0; i < order.length; i++) {
      const o = order[i];
      const row = this.rows.get(Number(o.slot));
      if (!row) continue;
      const cc = row.cache;
      if (cc.i !== i) {
        cc.i = i;
        row.el.style.order = String(i);
        row.pos.textContent = String(i + 1);
      }
      const ghost = !!o.ghost;
      if (cc.ghost !== ghost) { cc.ghost = ghost; row.el.classList.toggle('gh', ghost); }
      const me = !!o.me || Number(o.slot) === this.you;
      if (cc.me !== me) { cc.me = me; row.el.classList.toggle('me', me); }
      // the leader is the reference every other gap is measured against, so it
      // says so rather than printing a meaningless "+0.0s"
      const txt = ghost ? 'away' : me ? 'YOU' : i === 0 ? 'LEAD' : gapText(Number(o.gapMs));
      if (cc.gap !== txt) { cc.gap = txt; row.gap.textContent = txt; }
    }
  }

  _paintSplits() {
    const el = this.el.splits;
    if (!el) return;
    if (!this.splits.length) { el.textContent = ''; return; }
    let html = '';
    for (const s of this.splits) {
      html += `<div class="mg-kart-hsplit${s.best ? ' best' : ''}">`
        + `<span>lap ${s.n}</span><b>${lapTime(s.ms)}</b></div>`;
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- item ----
  _spin(dt) {
    const it = this._it;
    if (!it.spinning) return;
    it.left -= dt;
    this._spinAcc += dt;
    if (this._spinAcc >= 1 / SPIN_HZ) {
      this._spinAcc = 0;
      const next = ITEM_ORDER[(ITEM_ORDER.indexOf(it.shownIcon) + 1) % ITEM_ORDER.length];
      it.shownIcon = next;
      this.el.icon.innerHTML = ITEM_SVG[next];
    }
    if (it.left <= 0) {
      it.spinning = false;
      this.el.slot.classList.remove('spin');
      this._lockItem(true);
    }
  }

  /** The satisfying part: the roulette stops, the card lands, the slot glows. */
  _lockItem(pop) {
    const it = this._it;
    it.shownIcon = it.item;
    this.el.icon.innerHTML = it.item ? ITEM_SVG[it.item] : '';
    const ready = !!it.item;
    it.ready = ready;
    this.el.slot.classList.toggle('ready', ready);
    this.el.itname.classList.toggle('on', ready);
    if (ready) this.el.itname.innerHTML = `${esc(ITEM_NAMES[it.item])}<b>E</b>`;
    if (ready && pop) {
      this.el.slot.classList.remove('pop');
      void this.el.slot.offsetWidth;
      this.el.slot.classList.add('pop');
      this.play?.('pop');
    }
  }

  // -------------------------------------------------------------- minimap ---
  /**
   * §A7.5 — the centreline is painted ONCE into an offscreen canvas, shaded per
   * segment by elevation (`0.35 + 0.65*(y-yMin)/(yMax-yMin)` of the theme's road
   * colour, so a flat track shades flat); only the dots move afterwards.
   *
   * `points` is the track's centreline in world space, in spline order, as a
   * CLOSED loop (the last point joins the first). `q` is measured from the
   * finish line, so the lookup walks cumulative arc length and offsets by
   * `sFin / LAP_UNITS`. A sparse table (the registry's 18-24 control points) is
   * subdivided here, so a corner is a corner on the map too; a dense centreline
   * is used as given. Optional `w`/`hw` per point puts a kart on the right side
   * of the road rather than on the centreline.
   */
  _buildMinimapBase() {
    const src = this._resample(Array.isArray(this.track.points) ? this.track.points : []);
    const size = MAP_SIZE;
    const pad = 13;
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    this.mapBase = off;
    if (src.length < 3) { this.map = null; return; }

    // cumulative 2D length, so a fraction of the lap is a fraction of the line
    const n = src.length;
    const pts = new Array(n);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let len = 0;
    for (let i = 0; i < n; i++) {
      const p = src[i];
      const x = p.x;
      const z = p.z;
      const y = p.y;
      const hw = p.hw;
      if (i > 0) len += Math.hypot(x - pts[i - 1].x, z - pts[i - 1].z);
      pts[i] = { x, z, y, hw, s: len };
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const total = len + Math.hypot(pts[0].x - pts[n - 1].x, pts[0].z - pts[n - 1].z);
    const spanX = Math.max(1e-3, maxX - minX);
    const spanZ = Math.max(1e-3, maxZ - minZ);
    const sc = Math.min((size - pad * 2) / spanX, (size - pad * 2) / spanZ);
    const ox = (size - spanX * sc) / 2 - minX * sc;
    const oz = (size - spanZ * sc) / 2 - minZ * sc;

    // fraction of the lap for each point, with the finish line at q = 0
    const lapU = Number(this.track.LAP_UNITS ?? this.track.lapUnits) || total;
    const sFinF = frac1((Number(this.track.sFin) || 0) / (lapU || 1));
    const fs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) fs[i] = pts[i].s / (total || 1);
    fs[n] = 1;

    const yMin = Number.isFinite(this.track.yMin) ? this.track.yMin : minY;
    const yMax = Number.isFinite(this.track.yMax) ? this.track.yMax : maxY;
    const range = yMax - yMin;
    this.map = { pts, fs, sc, ox, oz, size, total, sFinF, n, yMin, yMax, range };

    const g = off.getContext('2d');
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // the casing first, as one closed path, so the road reads as a ribbon
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const p = pts[i % n];
      const x = p.x * sc + ox;
      const y = p.z * sc + oz;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokeStyle = 'rgba(45,36,23,.22)';
    g.lineWidth = 10;
    g.stroke();

    const road = Number(this.track.road) || 0x5b5568;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const t = range > 1e-6 ? clamp(((a.y + b.y) * 0.5 - yMin) / range, 0, 1) : 1;
      g.beginPath();
      g.moveTo(a.x * sc + ox, a.z * sc + oz);
      g.lineTo(b.x * sc + ox, b.z * sc + oz);
      g.strokeStyle = shade(road, 0.35 + 0.65 * t);
      g.lineWidth = 6.5;
      g.stroke();
    }

    // the finish line, drawn across the road at q = 0 (_mapAt returns a scratch
    // object, so the first point is copied out before the second call)
    const fin = this._mapAt(0, 0);
    const fx = fin ? fin.x : 0;
    const fy = fin ? fin.y : 0;
    const fin2 = this._mapAt(0.004, 0);
    if (fin && fin2) {
      const ax = fin2.x - fx;
      const az = fin2.y - fy;
      const m = Math.hypot(ax, az) || 1;
      g.beginPath();
      g.moveTo(fx - (az / m) * 5.5, fy + (ax / m) * 5.5);
      g.lineTo(fx + (az / m) * 5.5, fy - (ax / m) * 5.5);
      g.strokeStyle = '#fff6e3';
      g.lineWidth = 3.5;
      g.stroke();
    }

    if (this.el.elev && range > 0.5) {
      this.el.elev.textContent = `${Math.round(range)}u climb`;
    }
  }

  /**
   * Normalise whatever kart.js handed us into a closed list of
   * `{x, z, y, hw}`, and smooth a sparse control table with a uniform
   * Catmull-Rom so the painted lap is a lap and not a polygon of chords. A
   * table that is already dense (>= 48 rows) is trusted as given.
   */
  _resample(src) {
    const raw = [];
    for (const p of src) {
      if (!p) continue;
      const x = Number(Array.isArray(p) ? p[0] : p.x);
      const y = Number(Array.isArray(p) ? p[1] : p.y) || 0;
      const z = Number(Array.isArray(p) ? p[2] : p.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const w = Number(Array.isArray(p) ? p[3] : p.w);
      const hw = Number.isFinite(p.hw) ? Number(p.hw) : Number.isFinite(w) ? w * 0.5 : 5;
      raw.push({ x, y, z, hw });
    }
    const n = raw.length;
    if (n < 3 || n >= 48) return raw;
    const SUB = 8;
    const out = [];
    const cr = (a, b, c, d, t) => {
      const t2 = t * t;
      const t3 = t2 * t;
      return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2
        + (-a + 3 * b - 3 * c + d) * t3);
    };
    for (let i = 0; i < n; i++) {
      const p0 = raw[(i - 1 + n) % n];
      const p1 = raw[i];
      const p2 = raw[(i + 1) % n];
      const p3 = raw[(i + 2) % n];
      for (let j = 0; j < SUB; j++) {
        const t = j / SUB;
        out.push({
          x: cr(p0.x, p1.x, p2.x, p3.x, t),
          y: cr(p0.y, p1.y, p2.y, p3.y, t),
          z: cr(p0.z, p1.z, p2.z, p3.z, t),
          hw: cr(p0.hw, p1.hw, p2.hw, p3.hw, t),
        });
      }
    }
    return out;
  }

  /**
   * (q, lat) -> minimap canvas pixels, into a scratch object the caller must
   * read before the next call. Null when there is no path data.
   *
   * `points` is measured from the spline origin and `q` from the finish line,
   * so the two differ by `sFin / LAP_UNITS`. Three ways to be exact, in order of
   * preference: kart.js hands over its own `posOf(q, lat, out)` (or `worldOf`,
   * which is the same shape), or it puts `sFin` + `LAP_UNITS` on the track
   * object, or the finish line is assumed to be points[0].
   */
  _mapAt(q, lat) {
    const m = this.map;
    if (!m) return null;
    const out = this._mp || (this._mp = { x: 0, y: 0 });
    const fn = this.track.posOf || this.track.worldOf;
    if (typeof fn === 'function') {
      const w = fn(q, lat, this._wp || (this._wp = {}));
      if (w && Number.isFinite(w.x) && Number.isFinite(w.z)) {
        out.x = w.x * m.sc + m.ox;
        out.y = w.z * m.sc + m.oz;
        return out;
      }
    }
    // q is measured from the finish line; the table is measured from points[0]
    const want = frac1((Number(q) || 0) + m.sFinF);
    let lo = 0;
    let hi = m.n;                    // fs[n] === 1, so the wrap segment is included
    while (lo + 1 < hi) {            // binary search: the map is 250+ points long
      const mid = (lo + hi) >> 1;
      if (m.fs[mid] <= want) lo = mid; else hi = mid;
    }
    const i = lo;
    const a = m.pts[i];
    const b = m.pts[(i + 1) % m.n];
    const f0 = m.fs[i];
    const f1 = m.fs[i + 1];
    const t = f1 > f0 ? clamp((want - f0) / (f1 - f0), 0, 1) : 0;
    const wx = a.x + (b.x - a.x) * t;
    const wz = a.z + (b.z - a.z) * t;
    out.x = wx * m.sc + m.ox;
    out.y = wz * m.sc + m.oz;
    const l = Number(lat) || 0;
    if (l) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      const hw = a.hw + (b.hw - a.hw) * t;
      out.x += (-dz / d) * l * hw * m.sc;
      out.y += (dx / d) * l * hw * m.sc;
    }
    return out;
  }

  _drawMap(view) {
    const g = this.mapCtx;
    const m = this.map;
    if (!g) return;
    g.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    if (this.mapBase) g.drawImage(this.mapBase, 0, 0);
    if (!m) return;

    if (Array.isArray(view.boxes)) {
      for (const b of view.boxes) {
        if (b.live === false) continue;
        const p = this._mapAt(b.q, b.lat);
        if (!p) continue;
        g.fillStyle = 'rgba(255,236,186,.95)';
        g.fillRect(p.x - 1.7, p.y - 1.7, 3.4, 3.4);
      }
    }
    if (Array.isArray(view.hazards)) {
      for (const h of view.hazards) {
        const p = this._mapAt(h.q, h.lat);
        if (!p) continue;
        g.beginPath();
        g.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        g.fillStyle = 'rgba(232,101,122,.9)';
        g.fill();
      }
    }
    if (Array.isArray(view.karts)) {
      for (const k of view.karts) {
        const p = this._mapAt(k.q, k.lat);
        if (!p) continue;
        const me = !!k.me || Number(k.slot) === this.you;
        g.globalAlpha = k.ghost ? 0.4 : 1;
        g.beginPath();
        g.arc(p.x, p.y, me ? 5.2 : 4, 0, Math.PI * 2);
        g.fillStyle = hex6(k.color);
        g.fill();
        if (me) {
          g.lineWidth = 2.2;
          g.strokeStyle = '#fff6e3';
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }
  }

  // ---------------------------------------------------------- results bits --
  _podiumHtml(rows) {
    const top = rows.filter((r) => Number(r.place) >= 1 && Number(r.place) <= 3)
      .sort((a, b) => a.place - b.place);
    if (top.length < 2) return '';
    const order = [1, 0, 2];                 // 2nd, 1st, 3rd, left to right
    const h = [74, 52, 38];
    const tone = ['#f2b64a', '#dfe4ea', '#d39a6a'];
    let html = '<div class="mg-kart-hpodium">';
    for (const slotIdx of order) {
      const r = top[slotIdx];
      if (!r) continue;
      const who = this.roster.find((x) => Number(x.slot) === Number(r.slot));
      const color = Number.isFinite(r.color) ? r.color : (who?.color ?? 0xb08a5a);
      html += `<div class="mg-kart-hplinth">
        <div class="mg-kart-hcapy" style="animation-delay:${(slotIdx * 0.17).toFixed(2)}s">${
  capyFace(color, slotIdx === 0 ? 58 : 48)}</div>
        <div class="mg-kart-hpname">${esc(r.name || who?.name || 'capy')}</div>
        <div class="mg-kart-hblock" style="height:${h[slotIdx]}px;background:${tone[slotIdx]}">${
  slotIdx + 1}</div>
      </div>`;
    }
    return `${html}</div>`;
  }

  _boardHtml(rows, you) {
    // the results screen can open before `kart-end` lands (§4.6): say so, then
    // fill in when the field is known
    if (!rows.length) return '<div class="mg-kart-hwaiting">waiting for the rest of the field...</div>';
    let html = '';
    // the board always reads 1st down to last, whatever order the frame arrived in
    for (const r of rows.slice().sort((a, b) => (Number(a.place) || 9) - (Number(b.place) || 9))) {
      const who = this.roster.find((x) => Number(x.slot) === Number(r.slot));
      const me = Number(r.slot) === you;
      const color = Number.isFinite(r.color) ? r.color : (who?.color ?? 0xb08a5a);
      const kart = KART_NAMES[r.kart || who?.kart] || '';
      const laps = Math.round(Number(r.laps) || 0);
      const time = laps >= this.laps ? lapTime(Number(r.ms) || 0) : `${laps} laps`;
      html += `<div class="mg-kart-hbrow${me ? ' me' : ''}">
        <span class="p">${ordinal(clamp(Math.round(Number(r.place) || 1), 1, 8))}</span>
        <i style="background:${hex6(color)}"></i>
        <span class="nm">${esc(r.name || who?.name || 'capy')}${me ? ' (you)' : ''}</span>
        <span class="kt">${esc(kart)}</span><b>${time}</b></div>`;
    }
    return html;
  }

  /** Digit by digit, with a coin tick as it climbs (§A7.8). */
  _countUp(el, total) {
    if (!el) return;
    if (total <= 0) { el.textContent = '0'; return; }
    let shown = 0;
    let ticks = 0;
    const step = Math.max(1, Math.round(total / 26));
    const tick = () => {
      if (this.disposed || !el.isConnected) return;
      shown = Math.min(total, shown + step);
      el.textContent = String(shown);
      if (++ticks % 4 === 0) this.play?.('coin');
      if (shown < total) this._timer(tick, 34);
      else this.play?.('coin');
    };
    this._timer(tick, 340);
  }

  _confetti(n) {
    const host = this.el.conf;
    if (!host) return;
    const cols = ['#e8657a', '#f2b64a', '#4fb3e8', '#7ac74f', '#fff6e3'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const b = document.createElement('span');
      b.className = 'mg-kart-hbit';
      b.style.left = `${(Math.random() * 104 - 2).toFixed(1)}%`;
      b.style.background = cols[i % cols.length];
      b.style.setProperty('--dx', `${(Math.random() * 90 - 45).toFixed(0)}px`);
      b.style.setProperty('--rot', `${(Math.random() * 1080 - 540).toFixed(0)}deg`);
      b.style.animationDuration = `${(2 + Math.random() * 1.8).toFixed(2)}s`;
      b.style.animationDelay = `${(Math.random() * 0.9).toFixed(2)}s`;
      frag.appendChild(b);
    }
    host.appendChild(frag);
    this._timer(() => { if (host.isConnected) host.textContent = ''; }, 5200);
  }
}

export default KartHud;
