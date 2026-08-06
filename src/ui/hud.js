import { ROOM_INFO, GAME_NAME } from '../../shared/constants.js';

/** Chat lines kept for the scrollback card above the chat box. */
const HISTORY_MAX = 150;

/** In-world HUD: coins, room name, chat, emotes, map, mute, shop, menu. */
export function initHud(game) {
  const root = document.getElementById('hud-root');
  root.innerHTML = `
    <div class="hud-top-left">
      <button class="logo-chip" id="btn-menu" type="button" title="Menu, how to play, sound" aria-haspopup="dialog">${GAME_NAME}</button>
      <div class="room-chip"><span id="room-name">...</span><span id="pop-count"></span></div>
      <div class="net-dot" id="net-dot" role="img" aria-label="Connection status">
        <span class="net-tip" id="net-tip">Paddling out to the cove...</span>
      </div>
    </div>
    <div class="hud-top-right">
      <div class="coins-pill" id="coins-pill"><span class="coin-ico">&#9679;</span><span id="coin-count">0</span></div>
      <button class="hud-btn" id="btn-shop" title="Wardrobe & Shop">&#127913;</button>
      <button class="hud-btn" id="btn-mute" title="Sound">&#128266;</button>
    </div>
    <div class="hud-bottom">
      <div class="emotes">
        <button class="hud-btn" id="btn-wave" title="Wave">&#128075;</button>
        <button class="hud-btn" id="btn-dance" title="Dance">&#128378;</button>
      </div>
      <form id="chat-form" autocomplete="off">
        <input id="chat-input" maxlength="120" placeholder="Say something nice..." />
        <button type="submit" class="hud-btn">&#10148;</button>
      </form>
      <button class="hud-btn wide" id="btn-map">&#128506; Map</button>
    </div>
    <div class="chat-log" id="chat-log"></div>
    <div class="chat-history hidden" id="chat-history">
      <div class="chat-history-head">Chat history<span class="chat-history-hint">Esc to close</span></div>
      <div class="chat-history-scroll" id="chat-history-scroll"></div>
      <div class="chat-history-empty" id="chat-history-empty">The cove is quiet. Say hello!</div>
    </div>
    <div class="toasts" id="toasts"></div>
    <div class="map-overlay hidden" id="map-overlay"></div>
  `;

  const $ = (id) => document.getElementById(id);

  // coins
  game.events.on('coins', (total, delta, reason) => {
    $('coin-count').textContent = total;
    if (delta > 0) {
      game.toast(`+${delta} coins${reason && reason !== 'sync' ? ` (${reason})` : ''}`);
      popCoins($('coins-pill'), delta);
    }
  });
  $('coin-count').textContent = game.state.coins;

  // room
  game.events.on('room', (id) => {
    $('room-name').textContent = ROOM_INFO[id]?.name || id;
    game.toast(`${ROOM_INFO[id]?.name} : ${ROOM_INFO[id]?.desc || ''}`, 2200);
  });
  game.events.on('population', (n) => { $('pop-count').textContent = n > 1 ? ` * ${n} here` : ''; });

  // net status
  let lastNet = null;
  let deniedMsg = null;
  game.events.on('net', (s) => {
    $('net-dot').className = `net-dot ${s === 'online' ? 'on' : 'off'}`;
    const tip = $('net-tip');
    if (tip) {
      tip.textContent = s === 'online'
        ? 'Online : everyone can see you'
        : `Offline : ${deniedMsg || 'swimming solo, still fun'}`;
    }
    $('net-dot').setAttribute('aria-label', s === 'online' ? 'Online' : 'Offline');
    // only on the transition: the reconnect backoff would otherwise toast forever
    if (s === 'offline' && lastNet !== 'offline') {
      game.toast(deniedMsg || 'Connection lost, playing solo until it returns', 4200);
    }
    if (s === 'online') deniedMsg = null;
    lastNet = s;
  });
  // the server refused us outright (bad name, expired session): this is terminal,
  // there is no reconnect, so say so instead of sitting on "paddling out..."
  // (main.js already re-validates any saved token on load, so nothing to clear)
  game.events.on('net-denied', (msg) => { deniedMsg = msg || 'the cove would not let us in'; });

  // chat
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value;
    $('chat-input').value = '';
    if (!text.trim()) return;
    game.say(text);
    game.engine?.showBubble(game.engine.playerAvatar.group, text.trim().slice(0, 120));
  });

  // The log at the bottom left only ever shows the last few lines and fades
  // them out. The full history (last HISTORY_MAX lines) lives in a scrollable
  // card that takes its place while the chat box has focus.
  const chatInput = $('chat-input');
  const historyPanel = $('chat-history');
  const historyScroll = $('chat-history-scroll');
  const historyEmpty = $('chat-history-empty');
  let historyOpen = false;
  let overHistory = false; // scrolling/selecting inside the card must not close it

  const scrollHistoryDown = () => { historyScroll.scrollTop = historyScroll.scrollHeight; };

  function makeLine(name, text, self) {
    const line = document.createElement('div');
    line.className = `chat-line${self ? ' self' : ''}`;
    const who = document.createElement('b');
    who.textContent = name;
    line.appendChild(who);
    line.appendChild(document.createTextNode(` ${text}`));
    return line;
  }

  function openHistory() {
    if (historyOpen) return;
    historyOpen = true;
    historyPanel.classList.remove('hidden');
    $('chat-log').classList.add('is-tucked');
    scrollHistoryDown(); // reading scrollHeight flushes layout, so this lands
  }

  function closeHistory() {
    if (!historyOpen) return;
    historyOpen = false;
    historyPanel.classList.add('hidden');
    $('chat-log').classList.remove('is-tucked');
  }

  game.events.on('chat', ({ name, text, self }) => {
    const log = $('chat-log');
    const line = makeLine(name, text, self);
    log.appendChild(line);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => { line.classList.add('fade-out'); setTimeout(() => line.remove(), 900); }, 9000);

    // stay pinned to the newest line unless the player scrolled up to read
    const atBottom = historyScroll.scrollHeight - historyScroll.scrollTop
      - historyScroll.clientHeight < 56;
    const kept = makeLine(name, text, self);
    kept.classList.add('chat-history-line');
    historyScroll.appendChild(kept);
    while (historyScroll.children.length > HISTORY_MAX) historyScroll.firstChild.remove();
    historyEmpty.classList.add('hidden');
    if (historyOpen && atBottom) scrollHistoryDown();
  });

  chatInput.addEventListener('focus', openHistory);
  chatInput.addEventListener('blur', () => { if (!overHistory) closeHistory(); });
  historyPanel.addEventListener('pointerenter', () => { overHistory = true; });
  historyPanel.addEventListener('pointerleave', () => {
    overHistory = false;
    if (document.activeElement !== chatInput) closeHistory();
  });
  // don't let game hotkeys eat chat typing
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      overHistory = false;
      closeHistory();
      chatInput.blur();
    }
  });
  // Escape with the pointer parked on the card (input already blurred)
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyOpen && document.activeElement !== chatInput) {
      overHistory = false;
      closeHistory();
    }
  });
  // a minigame covers the HUD: never leave the card hanging underneath it
  game.events.on('minigame', (id) => { if (id) { overHistory = false; closeHistory(); } });

  // emotes
  $('btn-wave').onclick = () => game.emote('wave');
  $('btn-dance').onclick = () => game.emote('dance');

  // mute (the menu can flip this too, so the icon follows a 'mute' event)
  const setMuteIcon = (m) => {
    $('btn-mute').innerHTML = m ? '&#128263;' : '&#128266;';
    $('btn-mute').setAttribute('aria-pressed', m ? 'true' : 'false');
  };
  setMuteIcon(!!game.audio?.muted);
  $('btn-mute').onclick = () => {
    const m = game.audio.toggleMute();
    setMuteIcon(m);
    game.events.emit('mute', m);
  };
  game.events.on('mute', (m) => setMuteIcon(!!m));

  // shop (loaded on demand, like the plaza hotspot, so it stays out of the entry chunk)
  $('btn-shop').onclick = () => import('./shop.js')
    .then((m) => m.openShop(game))
    .catch((e) => { console.error('[hud] shop failed to load:', e); game.toast('The shop is not answering, try again'); });

  // menu (same on-demand load: pause card, how to play, sound, log out)
  $('btn-menu').onclick = () => import('./menu.js')
    .then((m) => m.openMenu(game))
    .catch((e) => { console.error('[hud] menu failed to load:', e); game.toast('The menu is stuck in the sand, try again'); });

  // toasts
  game.events.on('toast', (msg, ms = 2600) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 500); }, ms);
  });

  // map
  buildMap(game, $('map-overlay'));
  $('btn-map').onclick = () => { $('map-overlay').classList.toggle('hidden'); game.audio.play('click'); };
}

/** Coin pill scale bounce whenever the purse grows. */
function popCoins(pill, delta) {
  if (!pill) return;
  pill.classList.remove('pop', 'pop-big');
  void pill.offsetWidth; // restart the keyframes
  pill.classList.add(delta >= 40 ? 'pop-big' : 'pop');
}

// ---------------------------------------------------------------------------
// Map: a hand painted island. Everything below is drawn to a <canvas> in code,
// so the map costs no assets and scales to any card size.
// ---------------------------------------------------------------------------

// Painted landmark centres, in fractions of the island box.
const ART = {
  plaza: [0.500, 0.465],
  beach: [0.170, 0.570],
  peak: [0.500, 0.195],
  cafe: [0.795, 0.400],
  club: [0.690, 0.700],
};

// Label pills sit just under their landmark so the art stays readable.
const MAP_SPOTS = [
  { id: 'plaza', bx: 50, by: 60 },
  { id: 'beach', bx: 24, by: 68 },
  { id: 'peak', bx: 50, by: 32.5 },
  { id: 'cafe', bx: 78, by: 51 },
  { id: 'club', bx: 66, by: 81.5 },
];

const MAP_HINT = 'Pick a spot to waddle over. Press M to close the map.';

// Island silhouette: 16 radius factors, index 0 = east, going clockwise.
const ISLE = [1.02, 1.05, 1.06, 0.99, 0.94, 0.98, 1.00, 0.95, 0.86, 0.98, 1.03, 0.98, 1.05, 1.00, 1.05, 0.99];
const GRASS_K = [0.90, 0.90, 0.91, 0.90, 0.90, 0.90, 0.86, 0.78, 0.70, 0.80, 0.88, 0.90, 0.92, 0.92, 0.90, 0.90];
const GRASS = ISLE.map((v, i) => v * GRASS_K[i]);

const CX = 0.500; // island centre / radii, as fractions of the box
const CY = 0.485;
const RX = 0.400;
const RY = 0.395;

const C = {
  ink: '#3a2c1c',
  seaDeep: '#2a6ea6',
  seaMid: '#3f9bd0',
  seaShallow: '#7ed8dd',
  sand: '#f7e4b0',
  sandDark: '#e7cd92',
  grass: '#8ecb5d',
  grassLight: '#a9dd77',
  grassDark: '#63a13f',
  snow: '#f3faff',
  snowShade: '#d6e8f6',
  rock: '#8ba2ba',
  rockDark: '#6b83a0',
  cobble: '#ead7ae',
  cobbleStone: '#cdb27f',
  wood: '#ad7a4d',
  woodDark: '#8a5c37',
  cream: '#fff6e3',
  coral: '#e8657a',
  gold: '#f2b64a',
  purple: '#9b6bd4',
  purpleLight: '#c79cf0',
  water: '#63c3e8',
};

const SEA_SPARKS = [
  [0.06, 0.30], [0.10, 0.52], [0.07, 0.72], [0.20, 0.90], [0.38, 0.94], [0.55, 0.91],
  [0.72, 0.93], [0.88, 0.74], [0.94, 0.53], [0.91, 0.36], [0.80, 0.10], [0.62, 0.05],
  [0.44, 0.04], [0.26, 0.07], [0.13, 0.17], [0.95, 0.87],
];

const PINES = [
  [0.355, 0.290, 1.00], [0.310, 0.340, 0.88], [0.402, 0.348, 0.82], [0.615, 0.292, 1.00],
  [0.663, 0.338, 0.88], [0.575, 0.352, 0.78], [0.440, 0.248, 0.72], [0.560, 0.244, 0.68],
  [0.712, 0.400, 0.84], [0.292, 0.420, 0.80], [0.248, 0.318, 0.70], [0.742, 0.320, 0.72],
];

const TREES = [
  [0.330, 0.600, 1.00], [0.402, 0.662, 0.84], [0.600, 0.618, 0.94], [0.548, 0.702, 0.80],
  [0.752, 0.552, 0.90], [0.700, 0.470, 0.74], [0.262, 0.500, 0.80], [0.470, 0.722, 0.88],
  [0.800, 0.620, 0.78], [0.372, 0.512, 0.68], [0.320, 0.716, 0.86], [0.612, 0.762, 0.78],
  [0.532, 0.786, 0.70], [0.268, 0.652, 0.74],
];

const ROCKS = [
  [0.452, 0.812, 1.00], [0.366, 0.700, 0.7], [0.646, 0.586, 0.8], [0.214, 0.472, 0.75],
  [0.742, 0.700, 0.85],
];

const FLOWERS = [
  [0.430, 0.560, C.coral], [0.575, 0.552, C.gold], [0.628, 0.545, C.coral],
  [0.375, 0.560, C.gold], [0.520, 0.620, C.coral], [0.652, 0.610, C.gold],
  [0.290, 0.560, C.gold], [0.482, 0.352, C.coral],
];

// ---- tiny drawing helpers -------------------------------------------------

/** Smooth closed curve through points (midpoint quadratics: no cusps). */
function smoothClosed(c, pts) {
  const n = pts.length;
  c.beginPath();
  let mx = (pts[n - 1][0] + pts[0][0]) / 2;
  let my = (pts[n - 1][1] + pts[0][1]) / 2;
  c.moveTo(mx, my);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    mx = (p[0] + q[0]) / 2;
    my = (p[1] + q[1]) / 2;
    c.quadraticCurveTo(p[0], p[1], mx, my);
  }
  c.closePath();
}

function shapePath(c, w, h, factors, k = 1, dx = 0, dy = 0) {
  const pts = [];
  for (let i = 0; i < factors.length; i++) {
    const a = (i / factors.length) * Math.PI * 2;
    const r = factors[i] * k;
    pts.push([CX * w + Math.cos(a) * RX * w * r + dx, CY * h + Math.sin(a) * RY * h * r + dy]);
  }
  smoothClosed(c, pts);
}

function outline(c, color, width) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}

function blob(c, x, y, rx, ry, wob, seed) {
  const pts = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1 + Math.sin(a * 3 + seed) * wob + Math.sin(a * 5 + seed * 1.7) * wob * 0.6;
    pts.push([x + Math.cos(a) * rx * r, y + Math.sin(a) * ry * r]);
  }
  smoothClosed(c, pts);
}

function circle(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
}

function roundBox(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function poly(c, pts) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
}

function fillStroke(c, fill, stroke, lw) {
  c.fillStyle = fill;
  c.fill();
  if (stroke) outline(c, stroke, lw);
}

// ---- the painting ---------------------------------------------------------

function paintBase(c, w, h) {
  const S = Math.min(w, h);
  const R = (v) => v * S;
  const X = (u) => u * w;
  const Y = (v) => v * h;
  c.clearRect(0, 0, w, h);
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // --- open sea -----------------------------------------------------------
  const sea = c.createLinearGradient(0, 0, w * 0.4, h);
  sea.addColorStop(0, C.seaDeep);
  sea.addColorStop(0.5, C.seaMid);
  sea.addColorStop(1, '#25628f');
  c.fillStyle = sea;
  c.fillRect(0, 0, w, h);

  // shallow water hugging the island
  c.save();
  c.translate(X(CX), Y(CY));
  c.scale(1, h / w);
  const halo = c.createRadialGradient(0, 0, w * 0.30, 0, 0, w * 0.68);
  halo.addColorStop(0, 'rgba(126,216,221,0.92)');
  halo.addColorStop(0.55, 'rgba(110,200,214,0.34)');
  halo.addColorStop(1, 'rgba(110,200,214,0)');
  c.fillStyle = halo;
  c.fillRect(-w, -h, w * 2, h * 2);
  c.restore();

  // lazy horizontal swell
  c.save();
  c.globalAlpha = 0.13;
  c.strokeStyle = '#ffffff';
  c.lineWidth = R(0.006);
  for (let i = 0; i < 9; i++) {
    const y = h * (0.06 + i * 0.108);
    c.beginPath();
    for (let x = -20; x <= w + 20; x += w / 14) {
      const yy = y + Math.sin((x / w) * 7 + i) * R(0.008);
      if (x <= -20) c.moveTo(x, yy); else c.lineTo(x, yy);
    }
    c.stroke();
  }
  c.restore();

  // --- wave rings around the coast ---------------------------------------
  c.save();
  c.setLineDash([R(0.022), R(0.018)]);
  for (let i = 0; i < 3; i++) {
    shapePath(c, w, h, ISLE, 1.075 + i * 0.085);
    outline(c, `rgba(255,255,255,${0.36 - i * 0.1})`, R(0.0075));
  }
  c.restore();

  // --- island -------------------------------------------------------------
  // sunk shadow
  shapePath(c, w, h, ISLE, 1.005, 0, R(0.016));
  c.fillStyle = 'rgba(18,64,86,0.30)';
  c.fill();

  // surf foam
  shapePath(c, w, h, ISLE, 1.035);
  c.fillStyle = 'rgba(255,255,255,0.72)';
  c.fill();

  // sand
  shapePath(c, w, h, ISLE, 1);
  fillStroke(c, C.sand, C.ink, R(0.011));

  // sand speckle
  c.save();
  c.globalAlpha = 0.5;
  c.fillStyle = C.sandDark;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + 0.4;
    const k = 0.93 - (i % 3) * 0.03;
    circle(c, X(CX) + Math.cos(a) * RX * w * ISLE[i % 16] * k,
      Y(CY) + Math.sin(a) * RY * h * ISLE[i % 16] * k, R(0.005 + (i % 2) * 0.002));
    c.fill();
  }
  c.restore();

  // grass
  shapePath(c, w, h, GRASS, 1);
  fillStroke(c, C.grass, C.grassDark, R(0.008));
  c.save();
  c.clip();
  shapePath(c, w, h, GRASS, 0.82, -R(0.03), -R(0.04));
  c.fillStyle = C.grassLight;
  c.globalAlpha = 0.55;
  c.fill();
  c.restore();

  // --- snowfield under the peak -------------------------------------------
  blob(c, X(0.5), Y(0.245), w * 0.235, h * 0.105, 0.06, 1.2);
  fillStroke(c, C.snow, C.snowShade, R(0.007));

  // --- mountain stream ----------------------------------------------------
  c.save();
  c.beginPath();
  c.moveTo(X(0.452), Y(0.308));
  c.bezierCurveTo(X(0.40), Y(0.345), X(0.35), Y(0.352), X(0.30), Y(0.392));
  c.bezierCurveTo(X(0.275), Y(0.408), X(0.258), Y(0.404), X(0.228), Y(0.418));
  outline(c, C.ink, R(0.019));
  outline(c, C.water, R(0.013));
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = R(0.004);
  c.stroke();
  c.restore();

  // --- paths from the plaza ----------------------------------------------
  const P = [X(ART.plaza[0]), Y(ART.plaza[1])];
  const routes = [
    [[X(0.53), Y(0.36)], [X(0.500), Y(0.268)]],
    [[X(0.645), Y(0.402)], [X(0.772), Y(0.418)]],
    [[X(0.340), Y(0.492)], [X(0.208), Y(0.560)]],
    [[X(0.600), Y(0.582)], [X(0.664), Y(0.664)]],
  ];
  for (const [ctrl, end] of routes) {
    c.beginPath();
    c.moveTo(P[0], P[1]);
    c.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
    outline(c, 'rgba(58,44,28,0.18)', R(0.036));
    outline(c, C.cobble, R(0.026));
  }
  c.save();
  c.setLineDash([R(0.012), R(0.014)]);
  for (const [ctrl, end] of routes) {
    c.beginPath();
    c.moveTo(P[0], P[1]);
    c.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
    outline(c, 'rgba(160,127,80,0.65)', R(0.005));
  }
  c.restore();

  paintPlaza(c, R, X, Y);
  paintPeak(c, R, X, Y);
  for (const [u, v, s] of ROCKS) rock(c, X(u), Y(v), R(0.026) * s);
  for (const [u, v, s] of PINES) pine(c, X(u), Y(v), R(0.062) * s);
  for (const [u, v, s] of TREES) tree(c, X(u), Y(v), R(0.036) * s);
  paintCafe(c, R, X, Y);
  paintBeach(c, R, X, Y);
  paintCave(c, R, X, Y);
  lighthouse(c, X(0.398), Y(0.796), R(0.10));

  // flowers, last so they sit on top of the grass work
  for (const [u, v, col] of FLOWERS) {
    const r = R(0.0075);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      circle(c, X(u) + Math.cos(a) * r, Y(v) + Math.sin(a) * r, r * 0.85);
      c.fillStyle = col;
      c.fill();
    }
    circle(c, X(u), Y(v), r * 0.62);
    c.fillStyle = C.cream;
    c.fill();
  }

  paintCompass(c, R, X(0.888), Y(0.135));
}

function paintPlaza(c, R, X, Y) {
  const x = X(ART.plaza[0]);
  const y = Y(ART.plaza[1]);
  const r = R(0.108);

  circle(c, x, y + R(0.008), r);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();

  circle(c, x, y, r);
  fillStroke(c, C.cobble, C.ink, R(0.009));

  // cobbles: two rings of little stones
  c.fillStyle = C.cobbleStone;
  for (let ring = 0; ring < 2; ring++) {
    const rr = r * (0.62 + ring * 0.27);
    const n = 10 + ring * 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.3;
      circle(c, x + Math.cos(a) * rr, y + Math.sin(a) * rr, R(0.0095));
      c.fill();
    }
  }

  // benches
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    c.save();
    c.translate(x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78);
    c.rotate(a + Math.PI / 2);
    roundBox(c, -R(0.019), -R(0.006), R(0.038), R(0.012), R(0.005));
    fillStroke(c, C.wood, C.ink, R(0.005));
    c.restore();
  }

  // fountain
  circle(c, x, y, R(0.042));
  fillStroke(c, '#efe6cf', C.ink, R(0.008));
  circle(c, x, y, R(0.031));
  fillStroke(c, '#a8e0f2', '#6fb9d8', R(0.005));
  circle(c, x, y - R(0.004), R(0.011));
  fillStroke(c, '#efe6cf', C.ink, R(0.005));
  // spout arcs
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.lineWidth = R(0.005);
  for (const dir of [-1, 1]) {
    c.beginPath();
    c.moveTo(x, y - R(0.016));
    c.quadraticCurveTo(x + dir * R(0.02), y - R(0.03), x + dir * R(0.026), y + R(0.002));
    c.stroke();
  }
}

function paintPeak(c, R, X, Y) {
  const bx = X(0.5);
  const base = Y(0.305);
  const apex = Y(0.128);
  const left = X(0.372);
  const right = X(0.636);

  // shadow
  poly(c, [[left - R(0.01), base + R(0.012)], [right + R(0.01), base + R(0.012)], [bx, apex]]);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();

  // rock body with a second shoulder peak
  poly(c, [
    [left, base],
    [X(0.442), Y(0.196)],
    [bx, apex],
    [X(0.558), Y(0.200)],
    [X(0.592), Y(0.168)],
    [X(0.624), Y(0.226)],
    [right, base],
  ]);
  fillStroke(c, C.rock, C.ink, R(0.011));

  // shaded east face
  poly(c, [[bx, apex], [X(0.558), Y(0.200)], [X(0.592), Y(0.168)], [X(0.624), Y(0.226)], [right, base], [bx, base]]);
  c.fillStyle = C.rockDark;
  c.globalAlpha = 0.55;
  c.fill();
  c.globalAlpha = 1;

  // snow cap
  poly(c, [
    [X(0.442), Y(0.196)],
    [bx, apex],
    [X(0.558), Y(0.200)],
    [X(0.536), Y(0.216)],
    [X(0.514), Y(0.196)],
    [X(0.492), Y(0.222)],
    [X(0.466), Y(0.200)],
  ]);
  fillStroke(c, C.snow, C.ink, R(0.008));

  // shoulder cap
  poly(c, [[X(0.575), Y(0.186)], [X(0.592), Y(0.168)], [X(0.610), Y(0.200)], [X(0.594), Y(0.194)]]);
  fillStroke(c, C.snow, C.ink, R(0.006));

  // sled track down the face
  c.save();
  c.setLineDash([R(0.011), R(0.011)]);
  c.beginPath();
  c.moveTo(X(0.494), Y(0.170));
  c.bezierCurveTo(X(0.462), Y(0.220), X(0.520), Y(0.246), X(0.478), Y(0.298));
  outline(c, 'rgba(255,255,255,0.85)', R(0.006));
  c.restore();
}

function paintCafe(c, R, X, Y) {
  const x = X(ART.cafe[0]);
  const y = Y(ART.cafe[1]);
  const w = R(0.102);
  const hh = R(0.060);

  c.save();
  circle(c, x, y + hh * 0.66, w * 0.62);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();

  // hut body
  roundBox(c, x - w / 2, y - hh * 0.1, w, hh, R(0.008));
  fillStroke(c, C.cream, C.ink, R(0.009));

  // counter shade
  roundBox(c, x - w / 2 + R(0.006), y + hh * 0.42, w - R(0.012), hh * 0.36, R(0.005));
  c.fillStyle = '#f0dfba';
  c.fill();

  // straw roof
  poly(c, [
    [x - w * 0.66, y - hh * 0.06],
    [x, y - hh * 0.92],
    [x + w * 0.66, y - hh * 0.06],
  ]);
  fillStroke(c, C.gold, C.ink, R(0.009));
  c.strokeStyle = 'rgba(58,44,28,0.35)';
  c.lineWidth = R(0.004);
  for (let i = -1; i <= 1; i++) {
    c.beginPath();
    c.moveTo(x + i * w * 0.2, y - hh * 0.72 + Math.abs(i) * hh * 0.16);
    c.lineTo(x + i * w * 0.42, y - hh * 0.08);
    c.stroke();
  }

  // striped awning
  const aw = w * 0.94;
  for (let i = 0; i < 5; i++) {
    const sx = x - aw / 2 + (aw / 5) * i;
    c.beginPath();
    c.moveTo(sx, y + hh * 0.12);
    c.lineTo(sx + aw / 5, y + hh * 0.12);
    c.lineTo(sx + aw / 5, y + hh * 0.34);
    c.lineTo(sx, y + hh * 0.34);
    c.closePath();
    c.fillStyle = i % 2 ? C.cream : C.coral;
    c.fill();
  }
  roundBox(c, x - aw / 2, y + hh * 0.12, aw, hh * 0.22, R(0.004));
  outline(c, C.ink, R(0.007));

  // smoothie glass on the counter
  const gx = x + w * 0.3;
  const gy = y + hh * 0.62;
  poly(c, [[gx - R(0.009), gy - R(0.016)], [gx + R(0.009), gy - R(0.016)], [gx + R(0.006), gy + R(0.012)], [gx - R(0.006), gy + R(0.012)]]);
  fillStroke(c, '#ffd2dc', C.ink, R(0.005));
  c.beginPath();
  c.moveTo(gx + R(0.004), gy - R(0.014));
  c.lineTo(gx + R(0.014), gy - R(0.030));
  outline(c, C.coral, R(0.005));
  c.restore();
}

function paintBeach(c, R, X, Y) {
  const x = X(ART.beach[0]);
  const y = Y(ART.beach[1]);

  // dock reaching into the water
  c.save();
  c.translate(x, y);
  c.rotate(0.18);
  roundBox(c, -R(0.135), -R(0.014), R(0.185), R(0.028), R(0.006));
  fillStroke(c, C.wood, C.ink, R(0.008));
  c.strokeStyle = C.woodDark;
  c.lineWidth = R(0.005);
  for (let i = 0; i < 5; i++) {
    const px = -R(0.118) + i * R(0.036);
    c.beginPath();
    c.moveTo(px, -R(0.012));
    c.lineTo(px, R(0.012));
    c.stroke();
  }
  // posts at the far end
  for (const py of [-R(0.021), R(0.021)]) {
    roundBox(c, -R(0.142), py - R(0.006), R(0.016), R(0.014), R(0.004));
    fillStroke(c, C.woodDark, C.ink, R(0.005));
  }
  c.restore();

  // rowboat moored off the dock
  const bx = X(0.108);
  const by = Y(0.628);
  c.save();
  c.translate(bx, by);
  c.rotate(-0.12);
  c.beginPath();
  c.moveTo(-R(0.028), -R(0.010));
  c.quadraticCurveTo(0, R(0.020), R(0.028), -R(0.010));
  c.quadraticCurveTo(0, R(0.001), -R(0.028), -R(0.010));
  fillStroke(c, C.coral, C.ink, R(0.007));
  c.beginPath();
  c.moveTo(-R(0.006), -R(0.008));
  c.lineTo(R(0.026), -R(0.026));
  outline(c, C.woodDark, R(0.005));
  c.restore();

  // parasol on the sand
  const ux = X(0.222);
  const uy = Y(0.632);
  c.beginPath();
  c.moveTo(ux, uy);
  c.lineTo(ux + R(0.006), uy - R(0.042));
  outline(c, C.woodDark, R(0.006));
  c.beginPath();
  c.arc(ux + R(0.006), uy - R(0.040), R(0.030), Math.PI, 0);
  c.closePath();
  fillStroke(c, C.cream, C.ink, R(0.007));
  c.save();
  c.beginPath();
  c.arc(ux + R(0.006), uy - R(0.040), R(0.030), Math.PI, 0);
  c.closePath();
  c.clip();
  c.fillStyle = C.coral;
  for (let i = -3; i <= 3; i += 2) {
    poly(c, [
      [ux + R(0.006), uy - R(0.040)],
      [ux + R(0.006) + i * R(0.011), uy - R(0.076)],
      [ux + R(0.006) + (i + 1) * R(0.011), uy - R(0.076)],
    ]);
    c.fill();
  }
  c.restore();

  // beach ball
  circle(c, X(0.252), Y(0.664), R(0.013));
  fillStroke(c, C.cream, C.ink, R(0.006));
  c.save();
  circle(c, X(0.252), Y(0.664), R(0.013));
  c.clip();
  c.fillStyle = C.gold;
  poly(c, [[X(0.252), Y(0.664)], [X(0.252) + R(0.02), Y(0.664) - R(0.02)], [X(0.252) + R(0.02), Y(0.664) + R(0.004)]]);
  c.fill();
  c.fillStyle = C.coral;
  poly(c, [[X(0.252), Y(0.664)], [X(0.252) - R(0.02), Y(0.664) + R(0.014)], [X(0.252) + R(0.006), Y(0.664) + R(0.02)]]);
  c.fill();
  c.restore();
}

function paintCave(c, R, X, Y) {
  const x = X(ART.club[0]);
  const y = Y(ART.club[1]);

  // glow pool on the ground (static part; the pulse is drawn live)
  const g = c.createRadialGradient(x, y, R(0.01), x, y, R(0.13));
  g.addColorStop(0, 'rgba(155,107,212,0.55)');
  g.addColorStop(1, 'rgba(155,107,212,0)');
  c.fillStyle = g;
  circle(c, x, y, R(0.13));
  c.fill();

  // rock mound
  c.beginPath();
  c.moveTo(x - R(0.086), y + R(0.030));
  c.bezierCurveTo(x - R(0.080), y - R(0.058), x + R(0.080), y - R(0.058), x + R(0.086), y + R(0.030));
  c.closePath();
  fillStroke(c, C.rock, C.ink, R(0.010));

  // shaded right cheek
  c.save();
  c.beginPath();
  c.moveTo(x - R(0.086), y + R(0.030));
  c.bezierCurveTo(x - R(0.080), y - R(0.058), x + R(0.080), y - R(0.058), x + R(0.086), y + R(0.030));
  c.closePath();
  c.clip();
  c.fillStyle = C.rockDark;
  c.globalAlpha = 0.5;
  poly(c, [[x + R(0.028), y - R(0.06)], [x + R(0.10), y - R(0.06)], [x + R(0.10), y + R(0.04)], [x + R(0.046), y + R(0.04)]]);
  c.fill();
  c.restore();

  // mouth
  c.beginPath();
  c.moveTo(x - R(0.036), y + R(0.030));
  c.bezierCurveTo(x - R(0.034), y - R(0.026), x + R(0.034), y - R(0.026), x + R(0.036), y + R(0.030));
  c.closePath();
  fillStroke(c, '#2c2440', C.ink, R(0.008));
  const gm = c.createLinearGradient(x, y + R(0.03), x, y - R(0.02));
  gm.addColorStop(0, 'rgba(199,156,240,0.85)');
  gm.addColorStop(1, 'rgba(155,107,212,0)');
  c.fillStyle = gm;
  c.fill();

  // crystals
  for (const [dx, s] of [[-0.062, 1], [0.066, 0.8], [-0.03, 0.6]]) {
    poly(c, [
      [x + R(dx) - R(0.008 * s), y + R(0.030)],
      [x + R(dx), y + R(0.030) - R(0.034 * s)],
      [x + R(dx) + R(0.008 * s), y + R(0.030)],
    ]);
    fillStroke(c, C.purpleLight, C.ink, R(0.005));
  }
}

function pine(c, x, y, s) {
  circle(c, x, y + s * 0.06, s * 0.36);
  c.fillStyle = 'rgba(58,44,28,0.15)';
  c.fill();
  roundBox(c, x - s * 0.06, y - s * 0.06, s * 0.12, s * 0.22, s * 0.04);
  fillStroke(c, C.woodDark, C.ink, s * 0.06);
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    poly(c, [
      [x - s * (0.34 - t * 0.09), y + s * (0.02 - t * 0.28)],
      [x, y - s * (0.42 + t * 0.28)],
      [x + s * (0.34 - t * 0.09), y + s * (0.02 - t * 0.28)],
    ]);
    fillStroke(c, i === 2 ? '#5aa64a' : '#4a8f3d', C.ink, s * 0.07);
  }
}

function rock(c, x, y, s) {
  c.beginPath();
  c.moveTo(x - s, y + s * 0.34);
  c.bezierCurveTo(x - s * 0.9, y - s * 0.7, x + s * 0.4, y - s * 0.9, x + s, y + s * 0.34);
  c.closePath();
  fillStroke(c, C.rock, C.ink, s * 0.22);
  c.beginPath();
  c.moveTo(x - s * 0.34, y + s * 0.3);
  c.quadraticCurveTo(x - s * 0.1, y - s * 0.34, x + s * 0.42, y - s * 0.1);
  outline(c, 'rgba(255,255,255,0.4)', s * 0.16);
}

/** A little striped lighthouse on the south cape: pure set dressing. */
function lighthouse(c, x, y, s) {
  c.save();
  circle(c, x, y + s * 0.1, s * 0.4);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();
  // rocky base
  c.beginPath();
  c.moveTo(x - s * 0.42, y + s * 0.14);
  c.quadraticCurveTo(x, y - s * 0.06, x + s * 0.42, y + s * 0.14);
  c.closePath();
  fillStroke(c, C.rock, C.ink, s * 0.07);
  // tower
  poly(c, [
    [x - s * 0.24, y + s * 0.1],
    [x - s * 0.15, y - s * 0.66],
    [x + s * 0.15, y - s * 0.66],
    [x + s * 0.24, y + s * 0.1],
  ]);
  fillStroke(c, C.cream, C.ink, s * 0.075);
  // stripes
  c.save();
  poly(c, [
    [x - s * 0.24, y + s * 0.1],
    [x - s * 0.15, y - s * 0.66],
    [x + s * 0.15, y - s * 0.66],
    [x + s * 0.24, y + s * 0.1],
  ]);
  c.clip();
  c.fillStyle = C.coral;
  for (let i = 0; i < 2; i++) {
    const ty = y - s * (0.12 + i * 0.36);
    c.fillRect(x - s * 0.3, ty, s * 0.6, s * 0.16);
  }
  c.restore();
  // lamp room + light
  roundBox(c, x - s * 0.19, y - s * 0.86, s * 0.38, s * 0.22, s * 0.05);
  fillStroke(c, C.gold, C.ink, s * 0.07);
  poly(c, [[x - s * 0.26, y - s * 0.86], [x, y - s * 1.06], [x + s * 0.26, y - s * 0.86]]);
  fillStroke(c, C.coral, C.ink, s * 0.07);
  c.restore();
}

function tree(c, x, y, s) {
  circle(c, x, y + s * 0.5, s * 0.62);
  c.fillStyle = 'rgba(58,44,28,0.15)';
  c.fill();
  roundBox(c, x - s * 0.11, y, s * 0.22, s * 0.55, s * 0.07);
  fillStroke(c, C.wood, C.ink, s * 0.1);
  c.beginPath();
  c.arc(x - s * 0.42, y - s * 0.22, s * 0.46, 0, Math.PI * 2);
  c.arc(x + s * 0.40, y - s * 0.18, s * 0.42, 0, Math.PI * 2);
  c.arc(x, y - s * 0.60, s * 0.54, 0, Math.PI * 2);
  fillStroke(c, C.grassDark, C.ink, s * 0.12);
  c.beginPath();
  c.arc(x - s * 0.18, y - s * 0.58, s * 0.34, 0, Math.PI * 2);
  c.fillStyle = '#8fd25c';
  c.fill();
}

function paintCompass(c, R, x, y) {
  const r = R(0.072);
  circle(c, x, y, r);
  c.fillStyle = 'rgba(255,246,227,0.86)';
  c.fill();
  outline(c, C.ink, R(0.008));
  circle(c, x, y, r * 0.78);
  outline(c, 'rgba(58,44,28,0.35)', R(0.004));

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
    const b = a + Math.PI / 4;
    poly(c, [
      [x + Math.cos(a) * r * 0.86, y + Math.sin(a) * r * 0.86],
      [x + Math.cos(b) * r * 0.2, y + Math.sin(b) * r * 0.2],
      [x + Math.cos(a + Math.PI / 2) * r * 0.86, y + Math.sin(a + Math.PI / 2) * r * 0.86],
      [x + Math.cos(b + Math.PI / 2) * r * 0.2, y + Math.sin(b + Math.PI / 2) * r * 0.2],
    ]);
    fillStroke(c, i === 0 ? C.coral : C.cream, C.ink, R(0.005));
  }
  circle(c, x, y, r * 0.13);
  fillStroke(c, C.gold, C.ink, R(0.005));

  c.fillStyle = C.ink;
  c.font = `900 ${Math.round(r * 0.5)}px "Trebuchet MS", "Segoe UI", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('N', x, y - r * 1.28);
}

// ---- the animated layer ---------------------------------------------------

function paintLive(c, w, h, t) {
  const S = Math.min(w, h);
  const R = (v) => v * S;
  const X = (u) => u * w;
  const Y = (v) => v * h;
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // expanding wave ring
  const k = (t % 6) / 6;
  c.save();
  c.globalAlpha = 0.34 * (1 - k);
  shapePath(c, w, h, ISLE, 1.05 + k * 0.28);
  outline(c, '#ffffff', R(0.007));
  c.restore();

  // sea twinkles
  c.save();
  c.fillStyle = '#ffffff';
  for (let i = 0; i < SEA_SPARKS.length; i++) {
    const [u, v] = SEA_SPARKS[i];
    const p = Math.sin(t * 1.7 + i * 1.9);
    if (p <= 0) continue;
    const r = R(0.006) * p;
    c.globalAlpha = 0.75 * p;
    poly(c, [
      [X(u), Y(v) - r * 2.6], [X(u) + r, Y(v)], [X(u), Y(v) + r * 2.6], [X(u) - r, Y(v)],
    ]);
    c.fill();
  }
  c.restore();

  // drifting clouds, kept in the open-water lanes so they never hide a landmark
  for (const [bu, v, s, sp, lo, hi] of [
    [0.20, 0.050, 1.0, 0.006, -0.16, 1.16],
    [0.70, 0.945, 0.85, 0.0045, -0.16, 1.16],
    [0.02, 0.480, 0.7, 0.0032, -0.17, 0.10],
  ]) {
    const span = hi - lo;
    const u = lo + ((bu - lo + t * sp) % span + span) % span;
    cloud(c, X(u), Y(v), R(0.075) * s);
  }

  // sailboat
  const sx = X(0.118) + Math.sin(t * 0.31) * R(0.02);
  const sy = Y(0.858) + Math.sin(t * 1.5) * R(0.006);
  sailboat(c, sx, sy, R(0.062), Math.sin(t * 1.5) * 0.07);

  // gulls
  for (let i = 0; i < 3; i++) {
    const gx = X(0.24 + i * 0.055) + Math.sin(t * 0.5 + i) * R(0.05);
    const gy = Y(0.13 + (i % 2) * 0.035) + Math.sin(t * 1.1 + i * 2) * R(0.012);
    gull(c, gx, gy, R(0.018), t * 6 + i * 2);
  }

  // fountain sparkle
  const fx = X(ART.plaza[0]);
  const fy = Y(ART.plaza[1]);
  c.save();
  c.fillStyle = '#ffffff';
  for (let i = 0; i < 4; i++) {
    const p = (t * 0.9 + i * 0.25) % 1;
    const a = -Math.PI / 2 + (i - 1.5) * 0.5;
    const rr = R(0.03) * p;
    c.globalAlpha = 0.85 * (1 - p);
    circle(c, fx + Math.cos(a) * rr, fy - R(0.014) + Math.sin(a) * rr + R(0.05) * p * p, R(0.0055));
    c.fill();
  }
  c.restore();

  // cave pulse + rising sparks
  const cx = X(ART.club[0]);
  const cy = Y(ART.club[1]);
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  c.save();
  const g = c.createRadialGradient(cx, cy, R(0.005), cx, cy, R(0.075 + 0.03 * pulse));
  g.addColorStop(0, `rgba(199,156,240,${0.45 + 0.3 * pulse})`);
  g.addColorStop(1, 'rgba(155,107,212,0)');
  c.fillStyle = g;
  circle(c, cx, cy, R(0.105));
  c.fill();
  for (let i = 0; i < 4; i++) {
    const p = (t * 0.55 + i * 0.25) % 1;
    c.globalAlpha = 0.9 * (1 - p);
    c.fillStyle = i % 2 ? C.purpleLight : C.cream;
    circle(c, cx + Math.sin(t * 2 + i * 2.1) * R(0.022), cy - R(0.02) - R(0.075) * p, R(0.006) * (1 - p * 0.4));
    c.fill();
  }
  c.restore();
}

function cloud(c, x, y, s) {
  c.save();
  c.globalAlpha = 0.88;
  c.beginPath();
  c.arc(x - s * 0.5, y + s * 0.1, s * 0.42, 0, Math.PI * 2);
  c.arc(x, y - s * 0.12, s * 0.56, 0, Math.PI * 2);
  c.arc(x + s * 0.55, y + s * 0.08, s * 0.40, 0, Math.PI * 2);
  c.arc(x + s * 0.12, y + s * 0.22, s * 0.40, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.fill();
  outline(c, 'rgba(58,44,28,0.14)', s * 0.09);
  c.restore();
}

function sailboat(c, x, y, s, tilt) {
  c.save();
  c.translate(x, y);
  c.rotate(tilt);
  // wake
  c.strokeStyle = 'rgba(255,255,255,0.6)';
  c.lineWidth = s * 0.09;
  c.beginPath();
  c.moveTo(-s * 0.9, s * 0.42);
  c.lineTo(-s * 0.2, s * 0.42);
  c.moveTo(-s * 0.62, s * 0.62);
  c.lineTo(-s * 0.05, s * 0.62);
  c.stroke();
  // sails
  poly(c, [[0, -s * 1.1], [0, s * 0.06], [-s * 0.62, s * 0.06]]);
  fillStroke(c, C.cream, C.ink, s * 0.1);
  poly(c, [[s * 0.06, -s * 1.05], [s * 0.06, s * 0.06], [s * 0.52, s * 0.06]]);
  fillStroke(c, C.coral, C.ink, s * 0.1);
  // hull
  c.beginPath();
  c.moveTo(-s * 0.72, s * 0.08);
  c.quadraticCurveTo(0, s * 0.56, s * 0.72, s * 0.08);
  c.closePath();
  fillStroke(c, C.wood, C.ink, s * 0.11);
  c.restore();
}

function gull(c, x, y, s, phase) {
  const flap = Math.sin(phase) * 0.35;
  c.save();
  c.strokeStyle = 'rgba(255,255,255,0.95)';
  c.lineWidth = s * 0.22;
  c.beginPath();
  c.moveTo(x - s, y + s * flap);
  c.quadraticCurveTo(x - s * 0.4, y - s * 0.5, x, y);
  c.quadraticCurveTo(x + s * 0.4, y - s * 0.5, x + s, y + s * flap);
  c.stroke();
  c.restore();
}

// ---- canvas driver --------------------------------------------------------

function createIslandPainter(canvas) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return { refresh() {}, start() {}, stop() {} };

  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let t0 = 0;
  let last = 0;
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function measure() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const nw = Math.round(r.width);
    const nh = Math.round(r.height);
    const nd = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (nw === w && nh === h && nd === dpr) return true;
    w = nw; h = nh; dpr = nd;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    base.width = canvas.width;
    base.height = canvas.height;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBase(bctx, w, h);
    return true;
  }

  function blit(t) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.restore();
    paintLive(ctx, w, h, t);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!t0) t0 = now;
    if (now - last < 30) return; // ~32fps is plenty for a paper map
    last = now;
    blit((now - t0) / 1000);
  }

  return {
    refresh() {
      if (!measure()) return;
      blit(t0 ? (performance.now() - t0) / 1000 : 0);
    },
    start() {
      if (raf || reduced || !w) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

// Stylized island map. (Owned by the UI polish pass; keep the button wiring.)
function buildMap(game, el) {
  const spots = MAP_SPOTS.map((s) => [s.id, s.bx, s.by]);
  el.innerHTML = `
    <div class="map-card">
      <h2>${GAME_NAME}</h2>
      <div class="map-island" id="map-island">
        <canvas class="map-canvas" id="map-canvas"></canvas>
        <div class="map-here hidden" id="map-here"><i></i><i></i><b></b></div>
      </div>
      <div class="map-hint" id="map-hint">${MAP_HINT}</div>
      <button class="hud-btn map-close" id="map-close">&#10005;</button>
    </div>`;
  const island = el.querySelector('#map-island');
  const here = el.querySelector('#map-here');
  const hint = el.querySelector('#map-hint');
  const painter = createIslandPainter(el.querySelector('#map-canvas'));
  const buttons = [];

  const setHint = (msg) => { hint.textContent = msg || MAP_HINT; };

  for (const [id, x, y] of spots) {
    const b = document.createElement('button');
    b.className = 'map-spot';
    b.dataset.room = id;
    b.style.left = `${x}%`;
    b.style.top = `${y}%`;
    b.textContent = ROOM_INFO[id].name;
    b.title = ROOM_INFO[id].desc || '';
    b.onclick = () => {
      el.classList.add('hidden');
      if (game.roomId !== id) { game.audio?.play?.('whoosh'); game.goToRoom(id); }
      else game.audio?.play?.('click');
    };
    b.addEventListener('pointerenter', () => setHint(`${ROOM_INFO[id].name} : ${ROOM_INFO[id].desc || ''}`));
    b.addEventListener('pointerleave', () => setHint(null));
    island.appendChild(b);
    buttons.push(b);
  }

  function refreshHere() {
    const spot = ART[game.roomId];
    for (const b of buttons) b.classList.toggle('is-here', b.dataset.room === game.roomId);
    if (!spot) { here.classList.add('hidden'); return; }
    here.style.left = `${spot[0] * 100}%`;
    here.style.top = `${spot[1] * 100}%`;
    here.classList.remove('hidden');
  }

  // the map is toggled from the HUD button AND the M key (main.js), so watch
  // the class instead of hooking every caller
  let open = false;
  function sync() {
    const now = !el.classList.contains('hidden');
    if (now === open) return;
    open = now;
    if (open) {
      setHint(null);
      refreshHere();
      painter.refresh();
      painter.start();
    } else {
      painter.stop();
    }
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (open) painter.refresh(); }).observe(island);
  }
  game.events.on('room', () => { refreshHere(); });

  el.querySelector('#map-close').onclick = () => el.classList.add('hidden');
  el.addEventListener('click', (e) => { if (e.target === el) el.classList.add('hidden'); });
}
