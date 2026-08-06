import * as THREE from 'three';
import { HATS, BODY_COLORS, MINIGAMES } from '../../shared/constants.js';
import { createAvatar } from '../player/avatar.js';
import { makeToon, makeGlow, disposeObject } from '../core/materials.js';

/**
 * Wardrobe & Shop modal.
 *
 * A live 3D capybara turntable on the left, Colors / Hats tabs on the right.
 * Hovering a hat (or a color) tries it on instantly without committing;
 * clicking equips or buys. Purchases that go to the server show a pending
 * spinner and resolve on the next 'profile' / 'coins' event.
 *
 * Exported API is exactly: openShop(game)  (the HUD button toggles it).
 */

// ---------------------------------------------------------------------------
// copy: flavor text so nothing in the UI reads like a placeholder
// ---------------------------------------------------------------------------

const COLOR_NAMES = {
  0xb08a5a: 'Toffee',
  0x8a6642: 'Cocoa',
  0xc9a06b: 'Biscuit',
  0x6b4f35: 'Driftwood',
  0xe8657a: 'Coral',
  0xf2a541: 'Mango',
  0x7ac74f: 'Meadow',
  0x4fb3e8: 'Sky',
  0x9b6bd4: 'Grape',
  0x42d6c8: 'Lagoon',
};

const HAT_BLURBS = {
  none: 'Just fur, sunshine and confidence.',
  beanie: 'Hand knit. Slightly too warm. Worth it.',
  cap: 'Brim forward, attitude sideways.',
  flower: 'Attracts bees. Mostly the friendly ones.',
  tophat: 'For capybaras of considerable standing.',
  viking: 'The horns are decorative. Probably.',
  crown: 'Heavy is the head, comfy is the fur.',
  propeller: 'Spins nonstop. Lift not included.',
  chef: 'Smells permanently of mango smoothie.',
  pirate: 'Yarr, and excellent sun protection.',
};

const TIERS = [
  { max: 0, label: 'Starter' },
  { max: 119, label: 'Common' },
  { max: 299, label: 'Snazzy' },
  { max: 499, label: 'Rare' },
  { max: Infinity, label: 'Legendary' },
];

function tierLabel(price) {
  for (const t of TIERS) if (price <= t.max) return t.label;
  return 'Common';
}

function hexCss(c) {
  return `#${(c >>> 0).toString(16).padStart(6, '0')}`;
}

function colorName(c) {
  return COLOR_NAMES[c] || 'Custom';
}

// ---------------------------------------------------------------------------
// styles (injected once, every class prefixed shop-)
// ---------------------------------------------------------------------------

const STYLE_ID = 'shop-styles';

const CSS = `
#shop-overlay { animation: shop-fade .18s ease; backdrop-filter: blur(3px); }
#shop-overlay.shop-closing { opacity: 0; transition: opacity .15s ease; pointer-events: none; }

.shop-modal {
  width: min(780px, 94vw); padding: 22px 24px 18px;
  border: 4px solid #fff; outline: 3px solid rgba(45,36,23,.08);
  animation: shop-rise .28s cubic-bezier(.18,1.15,.4,1);
}
.shop-modal:focus { outline: 3px solid rgba(45,36,23,.08); }

.shop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding-right: 46px; }
.shop-head h2 { font-size: 26px; margin: 0 0 2px; letter-spacing: .02em; }
.shop-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; }
.shop-purse {
  display: flex; align-items: center; gap: 8px; flex: none;
  background: var(--card); border: 3px solid #f4e7c9; border-radius: 999px;
  padding: 6px 15px 6px 11px; font-weight: 900; font-size: 17px;
  box-shadow: 0 3px 0 rgba(45,36,23,.07);
}
.shop-purse-n { transition: color .2s ease; }
.shop-purse.is-bump .shop-coin { animation: shop-bump .45s cubic-bezier(.2,1.4,.4,1); }

.shop-coin {
  width: 15px; height: 15px; border-radius: 50%; display: inline-block; flex: none;
  background: radial-gradient(circle at 34% 28%, #ffeeb0 0%, var(--gold) 58%, #d1912a 100%);
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.4);
}
.shop-coin-sm { width: 11px; height: 11px; }

.shop-body { display: flex; gap: 20px; margin-top: 16px; align-items: flex-start; }

/* ---- 3D stage ---- */
.shop-stage { width: 240px; flex: none; display: flex; flex-direction: column; gap: 9px; align-items: center; }
.shop-stage-frame {
  position: relative; width: 240px; height: 280px; border-radius: 22px; overflow: hidden;
  background: radial-gradient(ellipse 72% 62% at 50% 36%, #fffaea 0%, #ffeec9 44%, #f6ddA6 72%, #ecca86 100%);
  box-shadow: inset 0 -20px 34px rgba(178,136,64,.22), inset 0 0 0 3px rgba(255,255,255,.7), 0 6px 18px rgba(45,36,23,.14);
}
.shop-rays {
  position: absolute; left: 50%; top: 46%; width: 380px; height: 380px; margin: -190px 0 0 -190px;
  background: repeating-conic-gradient(from 0deg, rgba(255,255,255,.5) 0deg 8deg, rgba(255,255,255,0) 8deg 20deg);
  opacity: .45; animation: shop-rays 60s linear infinite; pointer-events: none;
}
.shop-canvas { position: absolute; inset: 0; width: 240px; height: 280px; display: block; }
.shop-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(202deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,0) 40%);
}
.shop-stage-fallback {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 24px; font-weight: 800; font-size: 13px; color: #a3906c;
}
.shop-stage-name { font-weight: 900; font-size: 16px; text-align: center; }
.shop-stage-outfit {
  display: flex; align-items: center; gap: 7px; justify-content: center;
  font-weight: 700; font-size: 12.5px; color: #8a7a5a; text-align: center; min-height: 17px;
}
.shop-stage-outfit.is-preview { color: var(--accent); }
.shop-swatch-dot { width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; flex: none; box-shadow: 0 1px 4px rgba(0,0,0,.28); }

/* ---- right panel ---- */
.shop-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.shop-tabs { display: flex; gap: 4px; background: rgba(45,36,23,.07); padding: 5px; border-radius: 999px; align-self: flex-start; }
.shop-tab {
  border: 0; background: transparent; font-family: var(--font); font-weight: 900; font-size: 14px;
  padding: 8px 20px; border-radius: 999px; cursor: pointer; color: #8a7a5a;
  transition: background .16s ease, color .16s ease, scale .12s ease;
}
.shop-tab:hover { color: var(--ink); }
.shop-tab:active { scale: .96; }
.shop-tab.is-on { background: var(--accent); color: #fff; box-shadow: 0 3px 10px rgba(232,101,122,.38); }
.shop-pane { display: none; }
.shop-pane.is-on { display: block; animation: shop-fade .22s ease; }

.shop-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 10px; }
.shop-swatch {
  position: relative; height: 58px; border-radius: 16px; border: 3px solid #fff; cursor: pointer;
  background: var(--sw); box-shadow: 0 3px 10px rgba(45,36,23,.2);
  transition: scale .14s ease, box-shadow .14s ease, border-color .14s ease;
  animation: shop-pop .3s backwards cubic-bezier(.2,1.3,.5,1); animation-delay: calc(var(--i) * 26ms);
}
.shop-swatch:hover, .shop-swatch:focus-visible { scale: 1.09; outline: none; box-shadow: 0 6px 16px rgba(45,36,23,.28); }
.shop-swatch.is-on { border-color: var(--ink); }
.shop-swatch.is-on::after {
  content: '\\2713'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 24px; font-weight: 900; text-shadow: 0 2px 5px rgba(0,0,0,.5);
}
.shop-note { margin-top: 14px; font-size: 12.5px; font-weight: 700; color: #a3906c; }
.shop-note b { color: var(--ink); }

/* ---- hat grid ---- */
.shop-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(152px, 1fr)); gap: 10px;
  max-height: 44vh; overflow-y: auto; padding: 3px 6px 8px 3px;
  scrollbar-width: thin; scrollbar-color: #e2d5b6 transparent;
}
.shop-grid::-webkit-scrollbar { width: 9px; }
.shop-grid::-webkit-scrollbar-thumb { background: #e2d5b6; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
.shop-hat {
  position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 5px;
  background: var(--card); border-radius: 16px; padding: 11px 12px 11px; cursor: pointer;
  border: 3px solid transparent; box-shadow: 0 3px 0 rgba(45,36,23,.07);
  transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, opacity .2s ease;
  animation: shop-pop .34s backwards cubic-bezier(.2,1.3,.5,1); animation-delay: calc(var(--i) * 34ms);
}
.shop-hat:hover { transform: translateY(-3px); border-color: var(--accent2); box-shadow: 0 9px 18px rgba(45,36,23,.16); }
.shop-hat.is-equipped { border-color: var(--gold); background: #fff8e6; }
.shop-hat.is-locked { opacity: .68; filter: saturate(.55); }
.shop-hat.is-locked:hover { opacity: .85; }
.shop-hat.is-pending { cursor: progress; }
.shop-hat.shop-shake { animation: shop-shake .34s ease; }
.shop-hat-name { font-weight: 900; font-size: 14px; line-height: 1.15; padding-right: 4px; }
.shop-hat-blurb { font-size: 11px; font-weight: 600; color: #a3906c; line-height: 1.32; min-height: 29px; }
.shop-hat-foot {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 6px; row-gap: 7px; margin-top: auto; padding-top: 4px;
}
.shop-price { display: flex; align-items: center; gap: 5px; font-weight: 900; font-size: 13px; color: var(--ink); }
.shop-price.is-short { color: #cf3d2c; }
.shop-price.is-free { color: #a3906c; font-size: 12px; letter-spacing: .04em; }
.shop-hat-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 0; cursor: pointer;
  flex: 0 1 auto; white-space: nowrap;
  font-family: var(--font); font-weight: 900; font-size: 12.5px; padding: 7px 13px; border-radius: 999px;
  background: var(--accent); color: #fff; box-shadow: 0 3px 0 rgba(45,36,23,.12);
  transition: scale .12s ease, filter .12s ease;
}
.shop-hat-btn:hover:not(:disabled) { scale: 1.07; filter: brightness(1.06); }
.shop-hat-btn:active:not(:disabled) { scale: .95; }
.shop-hat.is-owned .shop-hat-btn { background: var(--accent2); }
.shop-hat-btn:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.shop-tier {
  position: absolute; top: 9px; right: 9px; font-size: 8.5px; font-weight: 900; letter-spacing: .09em;
  text-transform: uppercase; padding: 3px 7px; border-radius: 999px; background: #f0e6cd; color: #a3906c;
}
.shop-tier.is-rare { background: #e4ecff; color: #4d6bb5; }
.shop-tier.is-legendary { background: #ffe9b0; color: #b07d16; }
.shop-ribbon {
  display: none; position: absolute; top: 13px; right: -32px; width: 116px; transform: rotate(45deg);
  background: var(--gold); color: var(--ink); font-size: 9.5px; font-weight: 900; letter-spacing: .1em;
  text-align: center; padding: 4px 0; box-shadow: 0 2px 7px rgba(45,36,23,.28);
}
.shop-hat.is-equipped .shop-ribbon { display: block; animation: shop-ribbon .32s ease backwards; }
.shop-hat.is-equipped .shop-tier { display: none; }
.shop-spinner {
  width: 11px; height: 11px; border-radius: 50%; display: inline-block;
  border: 2px solid rgba(147,129,95,.35); border-top-color: #93815f; animation: shop-spin .7s linear infinite;
}

.shop-foot { display: flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 700; color: #a3906c; }

@keyframes shop-fade { from { opacity: 0; } }
@keyframes shop-rise { from { opacity: 0; transform: translateY(16px) scale(.95); } }
@keyframes shop-pop { from { opacity: 0; transform: translateY(10px) scale(.9); } }
@keyframes shop-spin { to { transform: rotate(360deg); } }
@keyframes shop-bump { 45% { transform: scale(1.35); } }
@keyframes shop-ribbon { from { opacity: 0; transform: rotate(45deg) translateY(-14px); } }
@keyframes shop-rays { to { transform: rotate(360deg); } }
@keyframes shop-shake { 15%, 85% { transform: translateX(-3px); } 40%, 65% { transform: translateX(4px); } }

@media (max-width: 720px) {
  .shop-modal { padding: 18px 16px 14px; }
  .shop-body { flex-direction: column; align-items: center; }
  .shop-stage { width: 100%; }
  .shop-panel { width: 100%; }
  .shop-grid { max-height: 30vh; }
  .shop-head h2 { font-size: 22px; }
}
@media (prefers-reduced-motion: reduce) {
  .shop-modal, .shop-hat, .shop-swatch, .shop-rays, .shop-pane { animation: none; }
}
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// 3D preview: turntable capybara on a little pedestal
// ---------------------------------------------------------------------------

const PREVIEW_W = 240;
const PREVIEW_H = 280;

function buildPreview(canvas, game) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(PREVIEW_W, PREVIEW_H, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, PREVIEW_W / PREVIEW_H, 0.1, 40);
  camera.position.set(0, 1.3, 3.75);
  camera.lookAt(0, 0.92, 0);

  scene.add(new THREE.HemisphereLight(0xfff3da, 0x8a6642, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2.6, 4.2, 3.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fd4ff, 0.45);
  rim.position.set(-3, 1.8, -2.6);
  scene.add(rim);

  // pedestal + glow ring (static, so the turntable spin reads clearly)
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.84, 0.96, 0.18, 24), makeToon(0xf0dca0));
  ped.position.y = -0.09;
  scene.add(ped);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.032, 8, 30), makeGlow(0xf2b64a));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.014;
  scene.add(ring);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const avatar = createAvatar({ color: game.state.color, hat: game.state.hat });
  turntable.add(avatar.group);

  // orbiting sparkles: one InstancedMesh, shared glow material
  const SPARKS = 14;
  const sparkGeo = new THREE.OctahedronGeometry(0.05);
  const sparks = new THREE.InstancedMesh(sparkGeo, makeGlow(0xf2c744), SPARKS);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(sparks);
  const dummy = new THREE.Object3D();
  const seeds = [];
  for (let i = 0; i < SPARKS; i++) {
    seeds.push({
      a: (i / SPARKS) * Math.PI * 2,
      r: 0.78 + (i % 3) * 0.15,
      y: 0.12 + ((i * 37) % 100) / 100 * 1.55,
      s: 0.55 + ((i * 53) % 100) / 100 * 0.6,
      sp: 0.3 + (i % 5) * 0.07,
    });
  }

  let raf = 0;
  let last = 0;
  let t = 0;
  let boost = 0;
  let punch = 0;
  let burst = 0;
  let curColor = game.state.color;
  let curHat = game.state.hat;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    boost *= Math.exp(-dt * 3.2);
    punch *= Math.exp(-dt * 5.5);
    burst *= Math.exp(-dt * 2.2);

    turntable.rotation.y += dt * (0.55 + boost);
    avatar.update(dt);
    avatar.group.scale.setScalar(1 + punch * 0.13);
    avatar.group.position.y = punch * 0.12;

    for (let i = 0; i < SPARKS; i++) {
      const s = seeds[i];
      const a = s.a + t * s.sp;
      const r = s.r + burst * 0.22;
      dummy.position.set(Math.cos(a) * r, s.y + Math.sin(t * 1.5 + s.a) * 0.09, Math.sin(a) * r);
      dummy.rotation.set(t * 1.1, a, t * 0.6);
      const pulse = 0.72 + 0.28 * Math.sin(t * 3 + s.a * 2);
      dummy.scale.setScalar(s.s * pulse * (1 + burst * 1.5));
      dummy.updateMatrix();
      sparks.setMatrixAt(i, dummy.matrix);
    }
    sparks.instanceMatrix.needsUpdate = true;

    ring.scale.setScalar(1 + burst * 0.12);
    renderer.render(scene, camera);
  }

  return {
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    setColor(hex) {
      if (hex === curColor) return;
      curColor = hex;
      avatar.setColor(hex);
    },
    setHat(id) {
      if (id === curHat) return;
      curHat = id;
      const stale = avatar.hatAnchor.children.slice();
      avatar.setHat(id);
      for (const o of stale) disposeObject(o); // hats are rebuilt per swap, free the old geometry
    },
    celebrate(power = 1) {
      punch = Math.max(punch, 0.85 * power);
      boost = Math.max(boost, 7 * power);
      burst = Math.max(burst, power);
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      sparks.dispose();
      disposeObject(scene); // frees geometries; shared makeToon/makeGlow materials are kept
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not all contexts support it */ }
    },
  };
}

// ---------------------------------------------------------------------------
// modal
// ---------------------------------------------------------------------------

let openInstance = null;
let lastTab = 'colors';

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

/** Open (or, if already open, close) the wardrobe. */
export function openShop(game) {
  if (openInstance) { openInstance.close(); return; }
  ensureStyles();

  const root = elm('div', 'shop-overlay');
  root.id = 'shop-overlay';
  root.innerHTML = `
    <div class="shop-card shop-modal" role="dialog" aria-label="Wardrobe and shop" tabindex="-1">
      <button class="hud-btn map-close shop-x" title="Close" aria-label="Close">&#10005;</button>
      <div class="shop-head">
        <div>
          <h2>Wardrobe</h2>
          <div class="shop-sub">Try things on. Hats are yours forever once bought.</div>
        </div>
        <div class="shop-purse" title="Your coins"><span class="shop-coin"></span><span class="shop-purse-n">0</span></div>
      </div>
      <div class="shop-body">
        <div class="shop-stage">
          <div class="shop-stage-frame">
            <div class="shop-rays"></div>
            <canvas class="shop-canvas"></canvas>
            <div class="shop-shine"></div>
          </div>
          <div class="shop-stage-name"></div>
          <div class="shop-stage-outfit"><span class="shop-swatch-dot"></span><span class="shop-outfit-text"></span></div>
        </div>
        <div class="shop-panel">
          <div class="shop-tabs" role="tablist">
            <button class="shop-tab" role="tab" data-tab="colors">Colors</button>
            <button class="shop-tab" role="tab" data-tab="hats">Hats</button>
          </div>
          <div class="shop-pane" data-pane="colors">
            <div class="shop-swatches"></div>
            <div class="shop-note"><b class="shop-color-name"></b><span class="shop-color-hint"></span></div>
          </div>
          <div class="shop-pane" data-pane="hats">
            <div class="shop-grid"></div>
          </div>
          <div class="shop-foot"><span class="shop-coin shop-coin-sm"></span><span class="shop-foot-text"></span></div>
        </div>
      </div>
    </div>
  `;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.shop-modal');
  const purse = q('.shop-purse');
  const purseN = q('.shop-purse-n');
  const stageFrame = q('.shop-stage-frame');
  const canvas = q('.shop-canvas');
  const stageName = q('.shop-stage-name');
  const outfitDot = q('.shop-swatch-dot');
  const outfitText = q('.shop-outfit-text');
  const swatchWrap = q('.shop-swatches');
  const colorNameEl = q('.shop-color-name');
  const colorHintEl = q('.shop-color-hint');
  const grid = q('.shop-grid');

  stageName.textContent = game.state.name || 'Capybara';
  q('.shop-foot-text').textContent =
    `Out of coins? ${Object.values(MINIGAMES).map((m) => m.name).join(', ')}.`;

  // ---- preview -------------------------------------------------------------
  let preview = null;
  try {
    preview = buildPreview(canvas, game);
    preview.start();
  } catch {
    canvas.remove();
    const fb = elm('div', 'shop-stage-fallback', 'The mirror is foggy today, but everything still works.');
    stageFrame.appendChild(fb);
  }

  let hoverColor = null;
  let hoverHat = null;

  const outfitLine = q('.shop-stage-outfit');

  function syncPreview() {
    const c = hoverColor ?? game.state.color;
    const h = hoverHat ?? game.state.hat;
    preview?.setColor(c);
    preview?.setHat(h);
    outfitDot.style.background = hexCss(c);

    const tryColor = hoverColor !== null && hoverColor !== game.state.color;
    const tryHat = hoverHat !== null && hoverHat !== game.state.hat;
    if (tryHat) {
      outfitText.textContent = h === 'none' ? 'Trying the bare look' : `Trying on ${HATS[h]?.name || h}`;
    } else if (tryColor) {
      outfitText.textContent = `Trying on ${colorName(c)}`;
    } else {
      outfitText.textContent = `${colorName(c)} coat${h === 'none' ? ', no hat' : `, ${HATS[h]?.name || h}`}`;
    }
    outfitLine.classList.toggle('is-preview', tryColor || tryHat);
    colorNameEl.textContent = colorName(c);
    colorHintEl.textContent = tryColor ? ' looks good on you.' : ' is your color.';
  }

  // ---- colors --------------------------------------------------------------
  const swatchRefs = [];
  BODY_COLORS.forEach((c, i) => {
    const b = elm('button', 'shop-swatch');
    b.type = 'button';
    b.style.setProperty('--sw', hexCss(c));
    b.style.setProperty('--i', String(i));
    b.title = colorName(c);
    b.setAttribute('aria-label', `${colorName(c)} coat`);
    b.addEventListener('pointerenter', () => { hoverColor = c; syncPreview(); });
    b.addEventListener('pointerleave', () => { hoverColor = null; syncPreview(); });
    b.addEventListener('focus', () => { hoverColor = c; syncPreview(); });
    b.addEventListener('blur', () => { hoverColor = null; syncPreview(); });
    b.addEventListener('click', () => {
      hoverColor = null;
      if (game.state.color === c) { game.audio?.play?.('click'); return; }
      game.setColor(c);
      game.audio?.play?.('pop');
      preview?.celebrate(0.55);
      syncPreview();
      refreshSwatches();
    });
    swatchWrap.appendChild(b);
    swatchRefs.push({ el: b, color: c });
  });

  function refreshSwatches() {
    for (const s of swatchRefs) s.el.classList.toggle('is-on', s.color === game.state.color);
  }

  // ---- hats ----------------------------------------------------------------
  const hatEntries = Object.entries(HATS).sort((a, b) => a[1].price - b[1].price);
  const hatRefs = new Map();
  let pendingId = null;
  let pendingTimer = 0;

  hatEntries.forEach(([id, hat], i) => {
    const cardEl = elm('div', 'shop-hat');
    cardEl.style.setProperty('--i', String(i));

    const ribbon = elm('div', 'shop-ribbon', 'EQUIPPED');
    const tier = elm('div', 'shop-tier', tierLabel(hat.price));
    if (hat.price >= 500) tier.classList.add('is-legendary');
    else if (hat.price >= 300) tier.classList.add('is-rare');

    const name = elm('div', 'shop-hat-name', hat.name);
    const blurb = elm('div', 'shop-hat-blurb', HAT_BLURBS[id] || 'A curious find from the driftwood market.');

    const foot = elm('div', 'shop-hat-foot');
    const price = elm('div', 'shop-price');
    if (hat.price > 0) {
      price.appendChild(elm('span', 'shop-coin shop-coin-sm'));
      price.appendChild(elm('span', null, String(hat.price)));
    } else {
      price.classList.add('is-free');
      price.appendChild(elm('span', null, 'FREE'));
    }
    const btn = elm('button', 'shop-hat-btn');
    btn.type = 'button';
    foot.append(price, btn);
    cardEl.append(ribbon, tier, name, blurb, foot);
    grid.appendChild(cardEl);

    const act = () => onHatAction(id, cardEl);
    btn.addEventListener('click', (e) => { e.stopPropagation(); act(); });
    cardEl.addEventListener('click', act);
    cardEl.addEventListener('pointerenter', () => { hoverHat = id; syncPreview(); });
    cardEl.addEventListener('pointerleave', () => { hoverHat = null; syncPreview(); });
    btn.addEventListener('focus', () => { hoverHat = id; syncPreview(); });
    btn.addEventListener('blur', () => { hoverHat = null; syncPreview(); });

    hatRefs.set(id, { el: cardEl, btn, price });
  });

  function refreshHats() {
    const { ownedHats, hat: worn, coins } = game.state;
    for (const [id, ref] of hatRefs) {
      const { price } = HATS[id];
      const owned = ownedHats.includes(id);
      const equipped = worn === id;
      const pending = pendingId === id;
      const short = !owned && coins < price;

      ref.el.classList.toggle('is-owned', owned);
      ref.el.classList.toggle('is-equipped', equipped);
      ref.el.classList.toggle('is-locked', short && !pending);
      ref.el.classList.toggle('is-pending', pending);
      ref.price.classList.toggle('is-short', short);

      ref.btn.disabled = equipped || pending || (pendingId !== null);
      ref.btn.textContent = '';
      if (pending) {
        ref.btn.appendChild(elm('span', 'shop-spinner'));
        ref.btn.appendChild(elm('span', null, 'Buying'));
      } else if (equipped) {
        ref.btn.textContent = 'Equipped';
      } else if (owned) {
        ref.btn.textContent = 'Equip';
      } else {
        ref.btn.appendChild(elm('span', null, 'Buy for'));
        ref.btn.appendChild(elm('span', 'shop-coin shop-coin-sm'));
        ref.btn.appendChild(elm('span', null, String(price)));
      }
    }
  }

  function clearPending() {
    pendingId = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0; }
  }

  function checkPending() {
    if (!pendingId) return;
    if (game.state.ownedHats.includes(pendingId)) {
      const bought = HATS[pendingId];
      clearPending();
      game.audio?.play?.('success');
      game.toast(`${bought.name} is yours!`);
      preview?.celebrate(1);
    }
  }

  function onHatAction(id, cardEl) {
    if (pendingId) return;
    const hat = HATS[id];
    if (!hat) return;

    if (game.state.ownedHats.includes(id)) {
      if (game.state.hat === id) { game.audio?.play?.('click'); return; }
      game.equipHat(id);
      game.audio?.play?.('pop');
      preview?.celebrate(0.7);
      hoverHat = null;
      syncPreview();
      refreshHats();
      return;
    }

    const res = game.buyHat(id);
    if (!res.ok) {
      game.audio?.play?.('fail');
      const missing = hat.price - game.state.coins;
      game.toast(missing > 0 ? `${hat.name} costs ${hat.price}. You need ${missing} more.` : res.msg);
      cardEl.classList.remove('shop-shake');
      void cardEl.offsetWidth; // restart the animation
      cardEl.classList.add('shop-shake');
      return;
    }

    if (res.pending) {
      pendingId = id;
      game.audio?.play?.('click');
      refreshHats();
      pendingTimer = setTimeout(() => {
        if (pendingId !== id) return;
        clearPending();
        refreshHats();
        game.toast('The shopkeeper is still counting. Try again.');
      }, 8000);
      return;
    }

    // offline / guest: purchase already applied locally
    game.equipHat(id);
    game.audio?.play?.('success');
    game.toast(`${hat.name} is yours!`);
    preview?.celebrate(1);
    hoverHat = null;
    syncPreview();
    refreshHats();
  }

  // ---- tabs ----------------------------------------------------------------
  const tabs = [...root.querySelectorAll('.shop-tab')];
  const panes = [...root.querySelectorAll('.shop-pane')];
  function selectTab(name) {
    lastTab = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panes) p.classList.toggle('is-on', p.dataset.pane === name);
  }
  for (const t of tabs) {
    t.addEventListener('click', () => {
      if (t.dataset.tab === lastTab) return;
      selectTab(t.dataset.tab);
      game.audio?.play?.('click');
    });
  }
  selectTab(lastTab === 'hats' ? 'hats' : 'colors');

  // ---- live state ----------------------------------------------------------
  function setCoins(total) {
    purseN.textContent = String(total);
    purse.classList.remove('is-bump');
    void purse.offsetWidth;
    purse.classList.add('is-bump');
  }
  purseN.textContent = String(game.state.coins);

  const unsubs = [
    game.events.on('coins', (total) => { setCoins(total); checkPending(); refreshHats(); }),
    game.events.on('profile', () => {
      purseN.textContent = String(game.state.coins);
      checkPending();
      stageName.textContent = game.state.name || 'Capybara';
      refreshSwatches();
      refreshHats();
      syncPreview();
    }),
  ];

  refreshSwatches();
  refreshHats();
  syncPreview();

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    clearPending();
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    try { preview?.dispose(); } catch { /* context may already be lost */ }
    preview = null;
    root.classList.add('shop-closing');
    setTimeout(() => root.remove(), 160);
    game.audio?.play?.('click');
  }

  function onBackdrop(e) {
    if (e.target === root) close();
  }
  function onKey(e) {
    // swallow world hotkeys (w/d/m/Enter) while the modal owns the screen;
    // stopPropagation leaves default behaviour (Tab, Space on buttons) intact.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.shop-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  openInstance = { close };
}
