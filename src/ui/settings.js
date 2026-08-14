import * as postfx from '../core/postfx.js';

/**
 * The settings panel, opened from the game menu (src/ui/menu.js).
 *
 * Public API:
 *   openSettings(game)          - open, or close if it is already open
 *   applySavedSettings(game)    - push every saved preference at the live game
 *                                 (graphics + motion; audio and camera restore
 *                                 themselves, see below). Idempotent and safe
 *                                 to call before the panel has ever opened, so
 *                                 it is the one line a boot hook needs.
 *   getGraphics() / setGraphics(game, preset)   - 'low' | 'nice'
 *   reducedMotion() / setMotion(mode)           - 'auto' | 'on'
 *
 * Where each preference lives, and who restores it after a reload:
 *   graphics  localStorage 'capycove-gfx'    -> applySavedSettings()
 *   audio     localStorage 'capycove-vol'    -> src/core/audio.js, in init()
 *   camera    localStorage 'capycove-cam'    -> src/core/engine.js, in its ctor
 *   motion    localStorage 'capycove-motion' -> applySavedSettings()
 *
 * Styles: the panel reuses the menu's cream card classes from styles.css
 * (.menu-overlay/.menu-card/.menu-item/.menu-sub) so it is the same object as
 * the menu it came from; only the pieces the menu has no vocabulary for (the
 * segmented pickers and the chunky sliders) are styled here, under .set-.
 *
 * Nothing in this module touches the DOM, localStorage or WebGL at import
 * time, so it stays import-safe like every other UI module.
 */

// ---------------------------------------------------------------- storage ---

const GFX_KEY = 'capycove-gfx';
const MOTION_KEY = 'capycove-motion';

/** Bloom as postfx authored it. postfx keeps its tunables private and exposes
 *  only tune(), so the "Nice" values are mirrored here; if postfx retunes its
 *  look, these three numbers follow it. */
const BLOOM_NICE = { strength: 0.35, radius: 0.4, threshold: 0.85 };

function readKey(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writeKey(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: session only */ }
}

/** 'low' | 'nice' (anything unrecognised reads as 'nice', the shipped look). */
export function getGraphics() {
  return readKey(GFX_KEY, 'nice') === 'low' ? 'low' : 'nice';
}

/** 'auto' (follow the OS) | 'on' (force calm animations). */
export function getMotionMode() {
  return readKey(MOTION_KEY, 'auto') === 'on' ? 'on' : 'auto';
}

// ----------------------------------------------------------------- motion ---

/**
 * globalThis.capyReducedMotion() -> boolean
 *
 * The one answer to "should this animation be calmed down". It is the OS
 * `prefers-reduced-motion` state OR the player's own override from this panel.
 * Anything in the game that used to write
 *
 *     matchMedia('(prefers-reduced-motion: reduce)').matches
 *
 * should read
 *
 *     globalThis.capyReducedMotion?.() ?? matchMedia('(prefers-reduced-motion: reduce)').matches
 *
 * instead: the `?.` keeps it honest before this module has been loaded (it is
 * lazy, so a session that never opens the menu never defines the helper) and
 * the fallback keeps the OS setting working in that case.
 *
 * For CSS, the same state is mirrored on the root element as
 * `data-capy-motion="reduce"`, and the stylesheet injected below damps
 * animations and transitions globally while it is set: that covers every
 * existing `@media (prefers-reduced-motion: reduce)` block's job for the
 * override case without needing to edit each one.
 */
export function reducedMotion() {
  if (getMotionMode() === 'on') return true;
  try {
    return typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

function installMotionHelper() {
  // last one wins, and every copy answers identically, so re-installing is fine
  globalThis.capyReducedMotion = reducedMotion;
}

function syncMotionAttr() {
  const root = document.documentElement;
  if (!root) return;
  if (reducedMotion()) root.setAttribute('data-capy-motion', 'reduce');
  else root.removeAttribute('data-capy-motion');
}

/** Set the override and apply it now. Returns the stored mode. */
export function setMotion(mode) {
  const next = mode === 'on' ? 'on' : 'auto';
  writeKey(MOTION_KEY, next);
  installMotionHelper();
  ensureStyles();
  syncMotionAttr();
  return next;
}

// --------------------------------------------------------------- graphics ---

/** renderer.getSize() wants a Vector2; this is one, without importing three
 *  into the settings chunk. */
function sizeTarget() {
  return { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } };
}

/**
 * Apply a graphics preset to the live renderer.
 *   nice: what the game has always shipped (bloom on, pixel ratio up to 2,
 *         shadow map on).
 *   low:  bloom strength 0 (postfx only exposes tune(), so this is how the
 *         chain is quietened without touching it), pixel ratio pinned to 1
 *         (a quarter of the fragments on a retina screen), shadow map off
 *         (that is a whole extra scene pass of draw calls, per shadow light).
 * Persists, and returns the preset actually applied.
 */
export function setGraphics(game, preset) {
  const next = preset === 'low' ? 'low' : 'nice';
  writeKey(GFX_KEY, next);
  applyGraphics(game, next);
  return next;
}

function applyGraphics(game, preset) {
  const low = preset === 'low';
  const r = game?.engine?.renderer;

  // bloom: strength 0 leaves the pass in the chain but stops it contributing
  try { postfx.tune(low ? { strength: 0 } : BLOOM_NICE); } catch { /* no chain on this GPU */ }

  if (!r) return;

  // pixel ratio. setSize is re-run at the SAME logical size so the drawing
  // buffer is reallocated; updateStyle:false because the canvas is laid out by
  // styles.css (inset 0, 100%/100%) and the engine's own inline px are already
  // correct, and because a debug harness may have forced its own size.
  const want = low ? 1 : Math.min(globalThis.devicePixelRatio || 1, 2);
  if (Math.abs(r.getPixelRatio() - want) > 0.001) {
    const s = r.getSize(sizeTarget());
    r.setPixelRatio(want);
    r.setSize(s.x, s.y, false);
    try { postfx.resize(s.x, s.y); } catch { /* no chain: nothing to resize */ }
  }

  // shadows. The shadow branch is compiled into every material's program, so
  // flipping the switch needs a one-off recompile of what is on screen: that
  // is the light-touch re-render, no room rebuild and no GL resources thrown
  // away. Rooms built after this point compile with the new state already.
  if (r.shadowMap && r.shadowMap.enabled === low) {
    r.shadowMap.enabled = !low;
    r.shadowMap.needsUpdate = true;
    const scene = game?.engine?.scene;
    scene?.traverse?.((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) m.forEach((x) => { if (x) x.needsUpdate = true; });
      else m.needsUpdate = true;
    });
  }
}

/** Push every saved preference at the running game. Cheap and idempotent. */
export function applySavedSettings(game) {
  installMotionHelper();
  ensureStyles();
  syncMotionAttr();
  applyGraphics(game, getGraphics());
}

// ----------------------------------------------------------------- styles ---

const STYLE_ID = 'capy-settings-css';

const CSS = `
.set-sec {
  text-align: left; background: var(--card); border-radius: 18px; padding: 11px 14px;
  margin: 9px 0; box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.05);
}
.set-sec h3 {
  font-size: 10.5px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 8px;
}
.set-note { font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.35; margin-top: 8px; }

/* segmented picker: two chunky pills in a cream trough */
.set-seg { display: flex; gap: 6px; background: var(--cream); border-radius: 999px; padding: 5px; }
.set-seg button {
  flex: 1; border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 13.5px;
  color: var(--muted); background: transparent; padding: 9px 10px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  transition: scale 0.12s ease, background 0.18s ease, color 0.18s ease;
}
.set-seg button:hover { color: var(--ink); background: rgba(45, 36, 23, 0.06); }
.set-seg button:active { scale: 0.96; }
.set-seg button:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.set-seg button[aria-pressed="true"] {
  color: #fff; background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  border: 3px solid #fff; box-shadow: 0 3px 0 rgba(150, 55, 72, 0.3), 0 6px 14px rgba(45, 36, 23, 0.16);
  animation: set-pick 0.32s var(--spring);
}
@keyframes set-pick { from { scale: 0.9; } to { scale: 1; } }

/* sliders. --p (0..100) is pushed from JS so the track fills in behind the
   thumb: a bare grey groove reads as "disabled" next to everything else here. */
.set-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.set-row-label { flex: none; width: 62px; font-size: 12.5px; font-weight: 900; }
.set-val {
  flex: none; min-width: 46px; text-align: center; font-size: 11px; font-weight: 900;
  padding: 5px 8px; border-radius: 999px; background: var(--cream); color: var(--muted);
  border: 2px solid #f0e2c4; font-variant-numeric: tabular-nums;
}
.set-slider {
  flex: 1; -webkit-appearance: none; appearance: none; background: transparent;
  height: 22px; cursor: pointer; margin: 0;
}
.set-slider::-webkit-slider-runnable-track {
  height: 10px; border-radius: 999px;
  background: linear-gradient(90deg, var(--gold) 0 calc(var(--p, 100) * 1%), var(--cream) calc(var(--p, 100) * 1%) 100%);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08);
}
.set-slider::-moz-range-track {
  height: 10px; border-radius: 999px;
  background: linear-gradient(90deg, var(--gold) 0 calc(var(--p, 100) * 1%), var(--cream) calc(var(--p, 100) * 1%) 100%);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08);
}
.set-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 22px; height: 22px; margin-top: -6px;
  border-radius: 999px; background: linear-gradient(180deg, #ffe6b4 0%, var(--gold) 100%);
  border: 3px solid #fff; box-shadow: 0 3px 0 rgba(45, 36, 23, 0.18);
  transition: scale 0.12s var(--spring);
}
.set-slider::-moz-range-thumb {
  width: 22px; height: 22px; border-radius: 999px;
  background: linear-gradient(180deg, #ffe6b4 0%, var(--gold) 100%);
  border: 3px solid #fff; box-shadow: 0 3px 0 rgba(45, 36, 23, 0.18);
}
.set-slider:hover::-webkit-slider-thumb { scale: 1.12; }
.set-slider:active::-webkit-slider-thumb { scale: 0.94; }
.set-slider:focus-visible::-webkit-slider-thumb { outline: 3px solid var(--accent2); outline-offset: 2px; }
.set-slider.is-off::-webkit-slider-thumb { filter: grayscale(0.7); }

/* the player's own reduced-motion override, mirrored from
   globalThis.capyReducedMotion() onto the root element */
html[data-capy-motion="reduce"] *,
html[data-capy-motion="reduce"] *::before,
html[data-capy-motion="reduce"] *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
  scroll-behavior: auto !important;
}
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ------------------------------------------------------------------ panel ---

let openInstance = null;

function mountPoint() {
  return document.getElementById('hud-root')
    || document.getElementById('overlay-root')
    || document.body;
}

/** Open (or, if it is already open, close) the settings panel. */
export function openSettings(game) {
  if (openInstance) {
    // a second call while it is on screen closes it, same as the menu. If the
    // card is gone from the document anyway (a minigame clearing its mount, a
    // debug harness, a hot reload), the stale instance is only cleaned up and
    // a fresh panel opens, so the entry can never end up dead.
    const wasVisible = openInstance.root?.isConnected;
    openInstance.close();
    if (wasVisible) return;
  }

  ensureStyles();
  installMotionHelper();

  const root = document.createElement('div');
  root.className = 'menu-overlay';
  root.id = 'settings-overlay';
  root.innerHTML = `
    <div class="menu-card" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1">
      <button class="hud-btn map-close menu-x" type="button" title="Close" aria-label="Close settings">&#10005;</button>
      <h2>Settings</h2>
      <div class="menu-sub">Everything here saves itself and is waiting for you next time.</div>

      <section class="set-sec">
        <h3>Graphics</h3>
        <div class="set-seg" data-seg="gfx" role="group" aria-label="Graphics preset">
          <button type="button" data-val="low"><span class="menu-ico">&#128261;</span>Low</button>
          <button type="button" data-val="nice"><span class="menu-ico">&#10024;</span>Nice</button>
        </div>
        <p class="set-note" data-note="gfx"></p>
      </section>

      <section class="set-sec">
        <h3>Sound</h3>
        <div class="set-row">
          <span class="set-row-label">Music</span>
          <input class="set-slider" type="range" min="0" max="100" step="1" data-vol="music"
                 aria-label="Music volume">
          <span class="set-val" data-val-for="music"></span>
        </div>
        <div class="set-row">
          <span class="set-row-label">Effects</span>
          <input class="set-slider" type="range" min="0" max="100" step="1" data-vol="sfx"
                 aria-label="Sound effects volume">
          <span class="set-val" data-val-for="sfx"></span>
        </div>
        <p class="set-note" data-note="snd"></p>
        <button class="menu-item is-quiet" type="button" data-act="mute" style="margin-top: 4px;"></button>
      </section>

      <section class="set-sec">
        <h3>Camera</h3>
        <div class="set-seg" data-seg="cam" role="group" aria-label="Camera mode">
          <button type="button" data-val="follow"><span class="menu-ico">&#128062;</span>Follow</button>
          <button type="button" data-val="static"><span class="menu-ico">&#127965;</span>Wide</button>
        </div>
        <p class="set-note" data-note="cam"></p>
      </section>

      <section class="set-sec">
        <h3>Motion</h3>
        <div class="set-seg" data-seg="motion" role="group" aria-label="Motion">
          <button type="button" data-val="auto"><span class="menu-ico">&#9881;</span>Auto</button>
          <button type="button" data-val="on"><span class="menu-ico">&#127807;</span>Calm</button>
        </div>
        <p class="set-note" data-note="motion"></p>
      </section>

      <div class="menu-list">
        <button class="menu-item is-primary" type="button" data-act="done">Back to the cove</button>
      </div>
      <div class="menu-foot">Esc closes this panel</div>
    </div>`;
  mountPoint().appendChild(root);

  const card = root.querySelector('.menu-card');
  const q = (sel) => root.querySelector(sel);
  const blip = (name) => { try { game.audio?.play?.(name); } catch { /* audio is optional */ } };

  // ---- a segmented picker, wired once --------------------------------------
  function seg(name, get, onPick) {
    const wrap = q(`[data-seg="${name}"]`);
    const btns = [...wrap.querySelectorAll('button')];
    const sync = () => {
      const cur = get();
      for (const b of btns) b.setAttribute('aria-pressed', b.dataset.val === cur ? 'true' : 'false');
    };
    for (const b of btns) {
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-pressed') === 'true') { blip('pop'); return; }
        blip('click');
        onPick(b.dataset.val);
        sync();
      });
    }
    sync();
    return sync;
  }

  // ---- graphics ------------------------------------------------------------
  const gfxNote = q('[data-note="gfx"]');
  function gfxCopy() {
    gfxNote.textContent = getGraphics() === 'low'
      ? 'Low: no bloom, no shadows, one pixel per pixel. Flatter, and much kinder to a laptop that has started to sound like a hairdryer.'
      : 'Nice: glowy lanterns, soft shadows, crisp on a sharp screen. How the cove is meant to look.';
  }
  const syncGfx = seg('gfx', getGraphics, (v) => { setGraphics(game, v); gfxCopy(); });
  gfxCopy();

  // ---- sound ---------------------------------------------------------------
  // Live while dragging, a confirming blip on release. The music slider's own
  // preview is the bed already playing: it moves under your hand.
  const sndNote = q('[data-note="snd"]');
  const muteBtn = q('[data-act="mute"]');
  let lastBlip = 0;

  function syncSnd() {
    for (const bus of ['music', 'sfx']) {
      const input = q(`[data-vol="${bus}"]`);
      const out = q(`[data-val-for="${bus}"]`);
      const pct = Math.round((game.audio?.getVolume?.(bus) ?? 1) * 100);
      if (document.activeElement !== input) input.value = String(pct);
      // the attribute as well as the property: it keeps the thumb honest for
      // anything that serialises the card (screenshot harnesses, a11y trees)
      input.setAttribute('value', String(pct));
      out.textContent = `${pct}%`;
      input.style.setProperty('--p', String(pct)); // fills the track behind the thumb
      input.classList.toggle('is-off', pct === 0);
    }
    const muted = !!game.audio?.muted;
    sndNote.textContent = muted
      ? 'Sound is muted right now, so these sliders are setting the mix for when it comes back.'
      : 'Music sits under the sound effects on purpose. Drag either one and listen.';
    muteBtn.textContent = muted ? 'Unmute the cove' : 'Mute everything';
  }

  for (const bus of ['music', 'sfx']) {
    const input = q(`[data-vol="${bus}"]`);
    input.addEventListener('input', () => {
      game.audio?.setVolume?.(bus, Number(input.value) / 100);
      syncSnd();
    });
    input.addEventListener('change', () => {
      game.audio?.setVolume?.(bus, Number(input.value) / 100);
      syncSnd();
      const now = Date.now();
      if (now - lastBlip < 140) return; // arrow-key repeat must not machine-gun
      lastBlip = now;
      // sfx previews itself; for music the bed IS the preview, so this is only
      // a small "got it" tick
      blip(bus === 'sfx' ? 'coin' : 'click');
    });
  }

  muteBtn.addEventListener('click', () => {
    const muted = game.audio?.toggleMute?.() ?? false;
    game.events?.emit?.('mute', muted); // keeps the HUD speaker button honest
    syncSnd();
    blip('click'); // silent while muting, a nice confirm on the way back
  });

  const offMute = game.events?.on?.('mute', () => syncSnd()) || null;
  syncSnd();

  // ---- camera --------------------------------------------------------------
  // The engine owns the mode and persists it; this mirrors the HUD button, and
  // the HUD button mirrors this, because both only ever read engine.cameraMode.
  const camNote = q('[data-note="cam"]');
  function camCopy() {
    camNote.textContent = (game.engine?.cameraMode || 'follow') === 'static'
      ? 'Wide: one fixed shot of the whole room. Nothing swings around while you walk. (C does this too.)'
      : 'Follow: the camera trails your capy at a gentle distance. (C does this too.)';
  }
  const syncCam = seg('cam', () => game.engine?.cameraMode || 'follow', (v) => {
    game.engine?.setCameraMode?.(v);
    camCopy();
  });
  camCopy();
  const offCam = game.events?.on?.('camera-mode', () => { syncCam(); camCopy(); }) || null;

  // ---- motion --------------------------------------------------------------
  const motionNote = q('[data-note="motion"]');
  function motionCopy() {
    const auto = getMotionMode() === 'auto';
    const os = reducedMotion() && auto;
    motionNote.textContent = auto
      ? `Auto: follow this device's own reduced-motion setting${os ? ', which is currently asking for calm.' : '.'}`
      : 'Calm: cards stop springing and the flashier bits settle down. Nothing is hidden, it just moves less.';
  }
  seg('motion', getMotionMode, (v) => { setMotion(v); motionCopy(); });
  motionCopy();
  syncMotionAttr();

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    offMute?.();
    offCam?.();
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    blip('click');
  }

  function onBackdrop(e) {
    if (e.target === root) close();
  }
  function onKey(e) {
    // the world hotkeys (w/d/m/c/Enter) must not fire while this owns the
    // screen; stopPropagation leaves Tab, Space and the arrow keys on the
    // sliders working exactly as a browser expects
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.menu-x').addEventListener('click', close);
  q('[data-act="done"]').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  blip('open');

  openInstance = { close, root, syncGfx };
}
