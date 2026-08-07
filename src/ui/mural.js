/**
 * The plaza mural: a 96x54 collaborative pixel canvas, one pixel per capybara
 * per 20 seconds (wave 7, docs/LIVING-COVE.md section A4). The island's guest
 * book: leave it running for a month and it becomes the community's self
 * portrait.
 *
 * Public API:
 *   openMural(game)     the overlay (a second call while it is up closes it)
 *   MURAL_W / MURAL_H   grid size, contract data
 *   MURAL_PALETTE       the paint box, index -> css hex (index 0 = blank wall)
 *   decodeMuralGrid(m)  parse a 'mural-grid' frame into a Uint8Array, or null
 *   muralImageData(g)   grid -> ImageData, for the in-world wall texture
 * The last three exist so the plaza's wall can paint the SAME pixels without a
 * second copy of the palette or the decoder living in the room file.
 *
 * Wire protocol (server owns the shapes; parsing here is deliberately loose):
 *   out {t:'mural-grid'}          ask for the whole wall
 *   out {t:'mural', x, y, c}      place one pixel
 *   out {t:'mural-report'}        snapshot request for the operator
 *   in  {t:'mural-grid', grid}    full grid: RLE string, char-per-cell string,
 *                                 flat array, or [count,colour] pairs
 *   in  {t:'mural', x, y, c}      one placed pixel, broadcast to everyone
 *   in  {t:'mural', ok:false, wait} refusal, with seconds left on the cooldown
 *
 * Nothing here touches the DOM until openMural runs, so the module is
 * import-safe.
 */

export const MURAL_W = 96;
export const MURAL_H = 54;

/**
 * Palette-locked on purpose: no freehand colour, no text tool, so the worst a
 * bad actor can do is a rude arrangement of cove colours. Twelve DESIGN.md
 * colours plus cream (index 0, the blank plaster) and ink.
 */
export const MURAL_PALETTE = [
  '#fff6e3', // cream: the unpainted wall
  '#2d2417', // ink
  '#f0dca0', // sand
  '#f2b64a', // gold
  '#f2a541', // amber
  '#e8657a', // coral
  '#f29ab0', // blush
  '#9b6bd4', // plum
  '#2a2038', // night
  '#4fb3e8', // sky
  '#42d6c8', // teal
  '#7ac74f', // leaf
  '#b08a5a', // capy
  '#6b4f35', // cocoa
];

const PALETTE_NAMES = ['Cream', 'Ink', 'Sand', 'Gold', 'Amber', 'Coral', 'Blush',
  'Plum', 'Night', 'Sky', 'Teal', 'Leaf', 'Capy', 'Cocoa'];

// the server owns the real number and ships it on the grid frame; this is the
// value the ring uses until it does
let COOLDOWN_MS = 20000;
const CELLS = MURAL_W * MURAL_H;
const ZOOM = 8; // backing-store pixels per cell; CSS scales the canvas from here

// ---------------------------------------------------------------------------
// grid decoding
// ---------------------------------------------------------------------------

const clampIdx = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n < MURAL_PALETTE.length ? n : 0;
};

function fromPairs(nums, colourFirst) {
  const out = new Uint8Array(CELLS);
  let o = 0;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const count = colourFirst ? nums[i + 1] : nums[i];
    const colour = clampIdx(colourFirst ? nums[i] : nums[i + 1]);
    if (!Number.isFinite(count) || count < 0) return null;
    const end = Math.min(CELLS, o + count);
    out.fill(colour, o, end);
    o = end;
    if (o >= CELLS) break;
  }
  return o === CELLS ? out : null;
}

/**
 * Turn whatever the server sent into a grid. Several encodings are accepted
 * because the wire format is the server's call: a flat array, [count, colour]
 * run pairs, an RLE string of numbers, or one base-36 character per cell.
 * Returns null when nothing fits, and the caller says so out loud.
 */
export function decodeMuralGrid(raw) {
  const body = raw && typeof raw === 'object' && !ArrayBuffer.isView(raw) && !Array.isArray(raw)
    ? (raw.grid ?? raw.rle ?? raw.pixels ?? raw.data) : raw;
  if (body == null) return null;

  if (ArrayBuffer.isView(body) || Array.isArray(body)) {
    if (body.length === CELLS) {
      const out = new Uint8Array(CELLS);
      for (let i = 0; i < CELLS; i++) out[i] = clampIdx(body[i]);
      return out;
    }
    if (body.length % 2 === 0) {
      const nums = Array.from(body, Number);
      return fromPairs(nums, false) || fromPairs(nums, true);
    }
    return null;
  }

  if (typeof body !== 'string' || !body) return null;

  if (body.length === CELLS) {
    const out = new Uint8Array(CELLS);
    for (let i = 0; i < CELLS; i++) out[i] = clampIdx(parseInt(body[i], 36));
    return out;
  }

  const nums = (body.match(/\d+/g) || []).map(Number);
  if (nums.length >= 2 && nums.length % 2 === 0) {
    return fromPairs(nums, false) || fromPairs(nums, true);
  }
  return null;
}

/** Grid -> ImageData at 1px per cell (the in-world wall texture's source). */
export function muralImageData(grid, ctx) {
  const img = ctx
    ? ctx.createImageData(MURAL_W, MURAL_H)
    : { width: MURAL_W, height: MURAL_H, data: new Uint8ClampedArray(CELLS * 4) };
  const rgb = MURAL_PALETTE.map((h) => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
  ]);
  for (let i = 0; i < CELLS; i++) {
    const c = rgb[grid[i]] || rgb[0];
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

// ---------------------------------------------------------------------------
// styles
// ---------------------------------------------------------------------------

const STYLE_ID = 'capy-mural-styles';

const CSS = `
.mu-overlay {
  position: absolute; inset: 0; padding: 16px; display: flex;
  align-items: center; justify-content: center; z-index: 44;
  background: rgba(20, 32, 44, 0.58); backdrop-filter: blur(7px) saturate(1.15);
  animation: mu-fade 0.18s ease;
}
.mu-overlay.is-closing { opacity: 0; transition: opacity 0.15s ease; pointer-events: none; }
.mu-card {
  position: relative; width: min(720px, 96vw); max-height: 94vh; overflow: auto;
  padding: 18px 20px 14px; background: var(--cream); border: 4px solid #fff;
  border-radius: 26px; box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  animation: mu-rise 0.3s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.mu-card:focus { outline: none; }
.mu-x { position: absolute; top: 13px; right: 13px; z-index: 2; }
.mu-head { padding-right: 46px; margin-bottom: 9px; }
.mu-head h2 { font-size: 24px; color: var(--accent); letter-spacing: 0.02em; margin: 0; }
.mu-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; margin-top: 2px; }

.mu-frame {
  position: relative; border-radius: 14px; overflow: hidden; background: #fff6e3;
  box-shadow: 0 0 0 6px #8a6642, 0 0 0 9px #6b4f35, 0 10px 22px rgba(45, 36, 23, 0.28);
  line-height: 0;
}
.mu-frame canvas {
  display: block; width: 100%; height: auto; image-rendering: pixelated;
  image-rendering: crisp-edges;
}
.mu-frame .mu-over { position: absolute; inset: 0; }
.mu-frame.is-live { cursor: crosshair; }
.mu-loading {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 20px; font-size: 13px; font-weight: 800; color: #a3906c;
  background: rgba(255, 246, 227, 0.9); line-height: 1.5;
}
/* the class sets display:flex, which would otherwise beat the [hidden] default */
.mu-loading[hidden] { display: none; }

.mu-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 11px; }
.mu-swatches { display: flex; gap: 5px; flex-wrap: wrap; flex: 1; min-width: 200px; }
.mu-sw {
  width: 27px; height: 27px; border-radius: 9px; border: 0; cursor: pointer; padding: 0;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.75), 0 3px 0 rgba(45, 36, 23, 0.16);
  transition: scale 0.12s var(--spring), box-shadow 0.16s ease;
}
.mu-sw:hover { scale: 1.12; }
.mu-sw.is-on {
  scale: 1.16;
  box-shadow: inset 0 0 0 2px #fff, 0 0 0 3px var(--ink), 0 4px 0 rgba(45, 36, 23, 0.2);
}
.mu-sw:disabled { cursor: default; opacity: 0.5; scale: 1; }
.mu-sw:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }

.mu-place-wrap { position: relative; width: 62px; height: 62px; flex: none; }
.mu-ring {
  position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  background: conic-gradient(var(--gold) var(--p, 0turn), rgba(45, 36, 23, 0.12) 0turn);
  padding: 4px;
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px));
}
.mu-place {
  position: absolute; inset: 6px; border-radius: 50%; border: 0; cursor: pointer;
  font-family: var(--font); font-weight: 900; font-size: 11px; line-height: 1.1; color: var(--ink);
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%);
  box-shadow: 0 4px 0 rgba(158, 111, 20, 0.32);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.mu-place:hover:not(:disabled) { scale: 1.07; filter: brightness(1.05); }
.mu-place:active:not(:disabled) { scale: 0.94; }
.mu-place:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.mu-place:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }

.mu-status {
  flex: 1; min-width: 170px; font-size: 12px; font-weight: 700; color: var(--muted);
  line-height: 1.4;
}
.mu-status b { color: var(--ink); }
.mu-guest {
  margin-top: 10px; padding: 11px 14px; border-radius: 16px; text-align: center;
  background: rgba(79, 179, 232, 0.14); box-shadow: inset 0 0 0 2px rgba(79, 179, 232, 0.24);
}
.mu-guest h3 { font-size: 14px; margin-bottom: 3px; color: #2f7fae; }
.mu-guest p { font-size: 12px; font-weight: 700; color: var(--muted); line-height: 1.45; }

.mu-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin-top: 11px; font-size: 11.5px; font-weight: 700; color: #b6a688;
}
.mu-report {
  border: 0; background: rgba(45, 36, 23, 0.06); cursor: pointer; font-family: var(--font);
  font-size: 11px; font-weight: 900; letter-spacing: 0.06em; color: #a3906c;
  padding: 6px 13px; border-radius: 999px; transition: background 0.16s ease, color 0.16s ease;
}
.mu-report:hover { background: rgba(45, 36, 23, 0.12); color: var(--ink); }
.mu-report.is-armed { background: rgba(232, 101, 122, 0.18); color: #c0455c; }
.mu-report:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }

@keyframes mu-fade { from { opacity: 0; } }
@keyframes mu-rise { from { opacity: 0; transform: translateY(16px) scale(0.95); } }
@media (prefers-reduced-motion: reduce) { .mu-card { animation: none; } }
`;

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

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

// ---------------------------------------------------------------------------
// shared wall state: cached between opens, and kept live by one subscription so
// the wall is already right the next time somebody walks up to it
// ---------------------------------------------------------------------------

let grid = null;
let listening = false;
let cooldownUntil = 0;
let lifetime = 0; // pixels we have placed this session, for the status line

function applyOp(m) {
  if (!grid) return false;
  const x = Math.floor(Number(m?.x));
  const y = Math.floor(Number(m?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (x < 0 || y < 0 || x >= MURAL_W || y >= MURAL_H) return false;
  grid[y * MURAL_W + x] = clampIdx(m.c ?? m.colour ?? m.color);
  return true;
}

function listen(game) {
  if (listening || !game?.events) return;
  listening = true;
  game.events.on('mural-grid', (m) => {
    const cd = Number(m?.cooldown);
    if (Number.isFinite(cd) && cd >= 1000 && cd <= 300000) COOLDOWN_MS = cd;
    const g = decodeMuralGrid(m);
    if (g) grid = g;
  });
  game.events.on('mural', (m) => {
    if (m?.ok === false) {
      const wait = Number(m.wait ?? m.retryIn);
      if (Number.isFinite(wait) && wait > 0) cooldownUntil = Date.now() + wait * 1000;
      return;
    }
    applyOp(m);
  });
}

// ---------------------------------------------------------------------------

let openInstance = null;

/** Open (or, if it is already up, close) the mural. */
export function openMural(game) {
  if (typeof document === 'undefined' || !game) return;
  if (openInstance) { openInstance.close(); return; }
  ensureStyles();
  listen(game);

  const guest = !game.state?.registered;
  let colour = 5; // coral: the cove's own accent, and a friendly first pick
  let sel = null; // {x, y}
  let hover = null;

  const root = elm('div', 'mu-overlay');
  root.innerHTML = `
    <div class="mu-card" role="dialog" aria-modal="true" aria-label="The plaza mural" tabindex="-1">
      <button class="hud-btn mu-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="mu-head">
        <h2>The Plaza Mural</h2>
        <div class="mu-sub">Everyone gets one pixel every twenty seconds. It has been going a while.</div>
      </div>
      <div class="mu-frame">
        <canvas class="mu-base"></canvas>
        <canvas class="mu-over"></canvas>
        <div class="mu-loading">Waiting for the wall to load...</div>
      </div>
      <div class="mu-tools">
        <div class="mu-swatches" role="group" aria-label="Paint colours"></div>
        <div class="mu-place-wrap">
          <button class="mu-place" type="button"></button>
          <div class="mu-ring"></div>
        </div>
        <div class="mu-status"></div>
      </div>
      <div class="mu-foot">
        <span>Palette locked: no freehand, no lettering.</span>
        <button class="mu-report" type="button">Report mural</button>
      </div>
    </div>`;
  mountPoint().appendChild(root);

  const q = (sel2) => root.querySelector(sel2);
  const card = q('.mu-card');
  const frame = q('.mu-frame');
  const base = q('.mu-base');
  const over = q('.mu-over');
  const loading = q('.mu-loading');
  const swatchRow = q('.mu-swatches');
  const placeBtn = q('.mu-place');
  const ring = q('.mu-ring');
  const statusEl = q('.mu-status');
  const reportBtn = q('.mu-report');

  base.width = MURAL_W * ZOOM;
  base.height = MURAL_H * ZOOM;
  over.width = base.width;
  over.height = base.height;
  const bctx = base.getContext && base.getContext('2d');
  const octx = over.getContext && over.getContext('2d');
  // one 1:1 buffer holds the pixels; the visible canvas is a scaled blit of it
  const cell = document.createElement('canvas');
  cell.width = MURAL_W;
  cell.height = MURAL_H;
  const cctx = cell.getContext && cell.getContext('2d');

  // ---- painting ------------------------------------------------------------
  function paintBase() {
    if (!bctx || !cctx || !grid) return;
    cctx.putImageData(muralImageData(grid, cctx), 0, 0);
    bctx.imageSmoothingEnabled = false;
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.drawImage(cell, 0, 0, base.width, base.height);
    loading.hidden = true;
    frame.classList.add('is-live');
  }

  function paintOver() {
    if (!octx) return;
    octx.clearRect(0, 0, over.width, over.height);
    // a faint grid at this zoom keeps single pixels findable
    octx.strokeStyle = 'rgba(45,36,23,0.07)';
    octx.lineWidth = 1;
    for (let x = 8; x < MURAL_W; x += 8) {
      octx.beginPath(); octx.moveTo(x * ZOOM, 0); octx.lineTo(x * ZOOM, over.height); octx.stroke();
    }
    for (let y = 6; y < MURAL_H; y += 6) {
      octx.beginPath(); octx.moveTo(0, y * ZOOM); octx.lineTo(over.width, y * ZOOM); octx.stroke();
    }
    if (hover && !sel) {
      octx.strokeStyle = 'rgba(45,36,23,0.5)';
      octx.lineWidth = 2;
      octx.strokeRect(hover.x * ZOOM + 1, hover.y * ZOOM + 1, ZOOM - 2, ZOOM - 2);
    }
    if (sel) {
      octx.fillStyle = MURAL_PALETTE[colour];
      octx.fillRect(sel.x * ZOOM, sel.y * ZOOM, ZOOM, ZOOM);
      octx.strokeStyle = '#2d2417';
      octx.lineWidth = 2;
      octx.strokeRect(sel.x * ZOOM - 1, sel.y * ZOOM - 1, ZOOM + 2, ZOOM + 2);
      octx.strokeStyle = '#fff';
      octx.lineWidth = 2;
      // crosshair arms so the chosen cell is findable at a glance
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        octx.beginPath();
        octx.moveTo((sel.x + 0.5 + dx * 1.6) * ZOOM, (sel.y + 0.5 + dy * 1.6) * ZOOM);
        octx.lineTo((sel.x + 0.5 + dx * 3.2) * ZOOM, (sel.y + 0.5 + dy * 3.2) * ZOOM);
        octx.stroke();
      }
    }
  }

  function cellAt(e) {
    const r = base.getBoundingClientRect();
    if (r.width < 4) return null;
    const x = Math.floor(((e.clientX - r.left) / r.width) * MURAL_W);
    const y = Math.floor(((e.clientY - r.top) / r.height) * MURAL_H);
    if (x < 0 || y < 0 || x >= MURAL_W || y >= MURAL_H) return null;
    return { x, y };
  }

  // ---- tools ---------------------------------------------------------------
  const swatches = MURAL_PALETTE.map((hex, i) => {
    const b = elm('button', `mu-sw${i === colour ? ' is-on' : ''}`);
    b.type = 'button';
    b.style.background = hex;
    b.title = PALETTE_NAMES[i] || hex;
    b.setAttribute('aria-label', PALETTE_NAMES[i] || hex);
    b.disabled = guest;
    b.addEventListener('click', () => {
      colour = i;
      for (const s of swatches) s.classList.toggle('is-on', s === b);
      game.audio?.play?.('tick');
      paintOver();
      refresh();
    });
    swatchRow.appendChild(b);
    return b;
  });

  function cooldownLeft() {
    return Math.max(0, cooldownUntil - Date.now());
  }

  function refresh() {
    const left = cooldownLeft();
    ring.style.setProperty('--p', `${(1 - left / COOLDOWN_MS).toFixed(3)}turn`);

    if (guest) {
      placeBtn.disabled = true;
      placeBtn.textContent = 'Look';
      statusEl.textContent = '';
      statusEl.appendChild(elm('b', null, 'Guests can look, not paint.'));
      statusEl.append(document.createTextNode(' The wall keeps a name against every pixel, '
        + 'and a guest has not got one yet.'));
      return;
    }
    if (!game.net?.connected) {
      placeBtn.disabled = true;
      placeBtn.textContent = 'Offline';
      statusEl.textContent = 'The cove is offline for a moment. The wall will be here when it comes back.';
      return;
    }
    if (!grid) {
      placeBtn.disabled = true;
      placeBtn.textContent = 'Wait';
      statusEl.textContent = 'Fetching the wall...';
      return;
    }
    if (left > 0) {
      placeBtn.disabled = true;
      placeBtn.textContent = `${Math.ceil(left / 1000)}s`;
      statusEl.textContent = 'Paint is drying. Pick your next pixel while you wait.';
      return;
    }
    placeBtn.disabled = !sel;
    placeBtn.textContent = sel ? 'Place' : 'Pick';
    statusEl.textContent = '';
    if (sel) {
      statusEl.appendChild(elm('b', null, `${PALETTE_NAMES[colour]} at ${sel.x}, ${sel.y}`));
      statusEl.append(document.createTextNode(lifetime
        ? ` : ${lifetime} placed this visit.` : ' : press Place and it is on the wall for good.'));
    } else {
      statusEl.textContent = 'Click a cell on the wall, then Place. One pixel every twenty seconds.';
    }
  }

  function place() {
    if (guest || !sel || cooldownLeft() > 0 || !game.net?.connected) return;
    const op = { t: 'mural', x: sel.x, y: sel.y, c: colour };
    game.net.send(op);
    // paint it straight away: the server echo confirms, and a 20s wait to see
    // your own pixel would make the wall feel broken
    applyOp(op);
    lifetime++;
    cooldownUntil = Date.now() + COOLDOWN_MS;
    sel = null;
    hover = null;
    game.audio?.play?.('pop');
    paintBase();
    paintOver();
    refresh();
  }

  // ---- events --------------------------------------------------------------
  base.addEventListener('pointermove', (e) => {
    const c = cellAt(e);
    if (!c || (hover && hover.x === c.x && hover.y === c.y)) return;
    hover = c;
    paintOver();
  });
  base.addEventListener('pointerleave', () => { hover = null; paintOver(); });
  base.addEventListener('pointerdown', (e) => {
    if (guest) { game.audio?.play?.('pop'); game.toast('Sign up and the wall is yours to paint too!'); return; }
    const c = cellAt(e);
    if (!c) return;
    sel = c;
    game.audio?.play?.('click');
    paintOver();
    refresh();
  });
  over.style.pointerEvents = 'none'; // the base canvas owns every pointer event
  placeBtn.addEventListener('click', place);

  // report: two taps, same as the menu's log out, so a stray click reports nothing
  let armed = false;
  let armTimer = 0;
  reportBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      reportBtn.textContent = 'Tap again to report';
      reportBtn.classList.add('is-armed');
      game.audio?.play?.('click');
      armTimer = setTimeout(() => {
        armed = false;
        reportBtn.textContent = 'Report mural';
        reportBtn.classList.remove('is-armed');
      }, 4200);
      return;
    }
    armed = false;
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    reportBtn.textContent = 'Reported';
    reportBtn.classList.remove('is-armed');
    reportBtn.disabled = true;
    game.net?.send?.({ t: 'mural-report' });
    game.audio?.play?.('ding');
    game.toast('Thanks. A snapshot went to the cove keepers.', 3200);
  });

  const unsubs = [
    game.events.on('mural-grid', () => { paintBase(); paintOver(); refresh(); }),
    game.events.on('mural', (m) => {
      if (m?.ok === false) {
        if (m.msg) game.toast(m.msg);
        refresh();
        return;
      }
      paintBase();
      refresh();
    }),
    game.events.on('net', () => refresh()),
  ];

  if (grid) { paintBase(); paintOver(); }
  refresh();
  // the plaza wall asks for the grid on build and we share the cache with it,
  // so only a cold open spends one of the player's rate-limited social slots
  if (!grid) game.net?.send?.({ t: 'mural-grid' });
  const timer = setInterval(refresh, 250); // drives the cooldown ring

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    clearInterval(timer);
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    game.audio?.play?.('click');
  }

  function onBackdrop(e) { if (e.target === root) close(); }
  function onKey(e) {
    e.stopPropagation(); // world hotkeys stay out of the overlay
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.mu-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('open');

  openInstance = { close };
}
