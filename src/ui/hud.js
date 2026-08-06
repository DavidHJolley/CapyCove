import { ROOM_INFO, GAME_NAME } from '../../shared/constants.js';
import { openShop } from './shop.js';

/** In-world HUD: coins, room name, chat, emotes, map, mute, shop. */
export function initHud(game) {
  const root = document.getElementById('hud-root');
  root.innerHTML = `
    <div class="hud-top-left">
      <div class="logo-chip">${GAME_NAME}</div>
      <div class="room-chip"><span id="room-name">...</span><span id="pop-count"></span></div>
      <div class="net-dot" id="net-dot" title="connection"></div>
    </div>
    <div class="hud-top-right">
      <div class="coins-pill"><span class="coin-ico">&#9679;</span><span id="coin-count">0</span></div>
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
    <div class="toasts" id="toasts"></div>
    <div class="map-overlay hidden" id="map-overlay"></div>
  `;

  const $ = (id) => document.getElementById(id);

  // coins
  game.events.on('coins', (total, delta, reason) => {
    $('coin-count').textContent = total;
    if (delta > 0) game.toast(`+${delta} coins${reason && reason !== 'sync' ? ` (${reason})` : ''}`);
  });
  $('coin-count').textContent = game.state.coins;

  // room
  game.events.on('room', (id) => {
    $('room-name').textContent = ROOM_INFO[id]?.name || id;
    game.toast(`${ROOM_INFO[id]?.name} : ${ROOM_INFO[id]?.desc || ''}`, 2200);
  });
  game.events.on('population', (n) => { $('pop-count').textContent = n > 1 ? ` * ${n} here` : ''; });

  // net status
  game.events.on('net', (s) => {
    $('net-dot').className = `net-dot ${s === 'online' ? 'on' : 'off'}`;
    if (s === 'offline') game.toast('Connection lost, playing solo until it returns');
  });

  // chat
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value;
    $('chat-input').value = '';
    if (!text.trim()) return;
    game.say(text);
    game.engine?.showBubble(game.engine.playerAvatar.group, text.trim().slice(0, 120));
  });
  game.events.on('chat', ({ name, text, self }) => {
    const log = $('chat-log');
    const line = document.createElement('div');
    line.className = `chat-line${self ? ' self' : ''}`;
    const who = document.createElement('b');
    who.textContent = name;
    line.appendChild(who);
    line.appendChild(document.createTextNode(` ${text}`));
    log.appendChild(line);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => { line.classList.add('fade-out'); setTimeout(() => line.remove(), 900); }, 9000);
  });
  // don't let game hotkeys eat chat typing
  $('chat-input').addEventListener('keydown', (e) => e.stopPropagation());

  // emotes
  $('btn-wave').onclick = () => game.emote('wave');
  $('btn-dance').onclick = () => game.emote('dance');

  // mute
  $('btn-mute').onclick = () => {
    const m = game.audio.toggleMute();
    $('btn-mute').innerHTML = m ? '&#128263;' : '&#128266;';
  };

  // shop
  $('btn-shop').onclick = () => openShop(game);

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

// Stylized island map. (Owned by the UI polish pass; keep the button wiring.)
function buildMap(game, el) {
  const spots = [
    ['plaza', 50, 46], ['beach', 22, 62], ['peak', 50, 16], ['cafe', 78, 50], ['club', 64, 78],
  ];
  el.innerHTML = `
    <div class="map-card">
      <h2>${GAME_NAME}</h2>
      <div class="map-island" id="map-island"></div>
      <button class="hud-btn map-close" id="map-close">&#10005;</button>
    </div>`;
  const island = el.querySelector('#map-island');
  for (const [id, x, y] of spots) {
    const b = document.createElement('button');
    b.className = 'map-spot';
    b.style.left = `${x}%`;
    b.style.top = `${y}%`;
    b.textContent = ROOM_INFO[id].name;
    b.onclick = () => { el.classList.add('hidden'); if (game.roomId !== id) game.goToRoom(id); };
    island.appendChild(b);
  }
  el.querySelector('#map-close').onclick = () => el.classList.add('hidden');
  el.addEventListener('click', (e) => { if (e.target === el) el.classList.add('hidden'); });
}
