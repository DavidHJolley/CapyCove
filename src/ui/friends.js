import { ROOM_INFO } from '../../shared/constants.js';
import { openProfile, ensureSocialStyles, normalizeFriends } from './profile.js';
import { visitHouse } from '../net/client.js';

/**
 * Friends list overlay + the HUD button that opens it.
 *
 * Public API:
 *   openFriends(game)        - the overlay (also reachable from the HUD button)
 *   initFriendsButton(game)  - drops a .hud-btn into .hud-top-right, wires it,
 *                              and installs the single 'avatar-click' listener
 *                              that opens player cards. Called from main.js.
 *
 * Styles live in profile.js (one injected <style> tag covers pf- and fr-).
 * Data: we send {t:'friends'} and render whatever comes back on 'friends-data'.
 */

// Cached across opens so the overlay paints instantly instead of flashing an
// empty state while the server answers.
let cachedFriends = [];
let wired = false;
let openInstance = null;

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

function roomLine(f) {
  if (!f.online) return 'Offline : probably napping';
  const info = f.room && Object.prototype.hasOwnProperty.call(ROOM_INFO, f.room) ? ROOM_INFO[f.room] : null;
  return info ? `Online in ${info.name}` : 'Online somewhere in the cove';
}

/** Open (or, if it is already up, close) the friends list. */
export function openFriends(game) {
  if (typeof document === 'undefined') return;
  if (openInstance) { openInstance.close(); return; }
  ensureSocialStyles();

  const root = elm('div', 'fr-overlay');
  root.innerHTML = `
    <div class="fr-card" role="dialog" aria-label="Friends" tabindex="-1">
      <button class="hud-btn fr-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="fr-head"><h2>Friends</h2><span class="fr-count"></span></div>
      <div class="fr-sub"></div>
      <div class="fr-list"></div>
      <div class="fr-foot">Click any capybara in the world to see their card. The door visits their den.</div>
    </div>
  `;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.fr-card');
  const listEl = q('.fr-list');
  const countEl = q('.fr-count');
  const subEl = q('.fr-sub');

  function emptyState() {
    const wrap = elm('div', 'fr-empty');
    wrap.appendChild(elm('div', 'fr-empty-art'));
    if (!game.state.registered) {
      wrap.appendChild(elm('h3', null, 'Friends need an account'));
      wrap.appendChild(elm('p', null,
        'Guests can play everything, but a friends list only sticks around with an account. Make one from the title screen and your list travels with you.'));
    } else if (!game.net?.connected) {
      wrap.appendChild(elm('h3', null, 'Offline for a moment'));
      wrap.appendChild(elm('p', null,
        'The cove will reconnect on its own. Your friends will be here when it does.'));
    } else {
      wrap.appendChild(elm('h3', null, 'No friends yet, but the cove is full of them'));
      wrap.appendChild(elm('p', null,
        'Click a capybara out in the world to open their card, then hit Add friend. They show up here with a green dot when they are around.'));
    }
    return wrap;
  }

  function render() {
    const list = cachedFriends;
    listEl.textContent = '';
    const online = list.filter((f) => f.online).length;
    countEl.textContent = list.length
      ? `${list.length} total${online ? `, ${online} online` : ''}`
      : '';
    subEl.textContent = list.length
      ? (online ? 'Green dot means they are in the cove right now.' : 'Nobody is around at the moment. They will be back.')
      : 'Your list of favourite capybaras.';

    if (!list.length) { listEl.appendChild(emptyState()); return; }

    const sorted = [...list].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    sorted.forEach((f, i) => {
      // a card is a live look at a player, so it needs them connected: an
      // offline friend still gets a row, it just does not pretend to open one
      const canOpen = f.id != null;
      // the door sits ON the row rather than inside it: a button inside a
      // button swallows its own clicks and confuses every screen reader
      const item = elm('div', 'fr-item');
      const row = elm('button', 'fr-row');
      row.type = 'button';
      row.style.setProperty('--i', String(i));
      row.title = canOpen ? `Open ${f.name}'s card` : `${f.name} is not in the cove right now`;
      row.appendChild(elm('span', `fr-dot${f.online ? ' is-on' : ''}`));
      const txt = elm('div', 'fr-txt');
      txt.appendChild(elm('div', 'fr-name', f.name));
      txt.appendChild(elm('div', 'fr-where', roomLine(f)));
      row.appendChild(txt);
      row.appendChild(elm('span', 'fr-go', canOpen ? 'CARD' : ''));
      row.addEventListener('click', () => {
        game.audio?.play?.(canOpen ? 'click' : 'pop');
        if (canOpen) openProfile(game, f.id);
        else game.toast(`${f.name} is off exploring. Their card opens when they are back.`);
      });
      item.appendChild(row);

      if (f.online) {
        item.classList.add('has-den');
        const den = elm('button', 'fr-den');
        den.type = 'button';
        den.style.setProperty('--i', String(i));
        den.innerHTML = '&#128682;'; // a little door
        den.title = `Visit ${f.name}'s den`;
        den.setAttribute('aria-label', `Visit ${f.name}'s den`);
        den.addEventListener('click', (e) => {
          e.stopPropagation();
          close(); // plays the click for us, and clears the screen for the trip
          visitHouse(game, f.name);
        });
        item.appendChild(den);
      }

      listEl.appendChild(item);
    });
  }

  render();

  const unsubs = [
    game.events.on('friends-data', (payload) => {
      cachedFriends = normalizeFriends(payload);
      render();
    }),
    game.events.on('net', () => render()),
  ];

  game.net?.send?.({ t: 'friends' });

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    game.audio?.play?.('click');
  }

  function onBackdrop(e) { if (e.target === root) close(); }
  function onKey(e) {
    // a player card opened from this list sits on top and owns the keyboard,
    // otherwise one Escape would close both overlays at once
    if (document.querySelector('.pf-overlay:not(.is-closing)')) return;
    e.stopPropagation(); // world hotkeys stay out of the overlay
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.fr-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  openInstance = { close };
}

/**
 * Adds the friends button to the HUD cluster and installs the world-wide
 * social listeners exactly once (clicking a capybara opens their card).
 * Safe to call more than once; returns the button element when there is one.
 */
export function initFriendsButton(game) {
  if (typeof document === 'undefined') return null;
  ensureSocialStyles();

  if (!wired) {
    wired = true;
    // single subscription for the whole session: the engine emits this for any
    // remote avatar the player clicks
    game.events.on('avatar-click', (id) => {
      if (id == null) return;
      openProfile(game, id);
    });
    // a fresh connection is the moment to refresh the badge
    game.events.on('net', (s) => {
      if (s === 'online' && game.state.registered) game.net?.send?.({ t: 'friends' });
      if (s === 'offline') { cachedFriends = []; updateBadge(); }
    });
    game.events.on('friends-data', (payload) => {
      cachedFriends = normalizeFriends(payload);
      updateBadge();
    });
  }

  return mountButton(game, 12);
}

/**
 * The HUD cluster is written by initHud(); if we are called first (or the HUD
 * is rebuilt) the button would land nowhere, so retry briefly instead of
 * silently going missing.
 */
function mountButton(game, tries) {
  const existing = document.getElementById('btn-friends');
  if (existing) { updateBadge(); return existing; }

  const host = document.querySelector('.hud-top-right');
  if (!host) {
    if (tries > 0) setTimeout(() => mountButton(game, tries - 1), 120);
    return null;
  }

  const btn = elm('button', 'hud-btn');
  btn.id = 'btn-friends';
  btn.type = 'button';
  btn.title = 'Friends';
  btn.setAttribute('aria-label', 'Friends');
  btn.innerHTML = '&#128101;';
  btn.addEventListener('click', () => openFriends(game));
  host.appendChild(btn);
  updateBadge();
  return btn;
}

/** Little coral count of who is online, sitting on the HUD button. */
function updateBadge() {
  const btn = document.getElementById('btn-friends');
  if (!btn) return;
  const online = cachedFriends.filter((f) => f.online).length;
  let badge = btn.querySelector('.fr-hud-badge');
  if (!online) { badge?.remove(); return; }
  if (!badge) {
    badge = elm('span', 'fr-hud-badge');
    btn.appendChild(badge);
  }
  badge.textContent = String(online);
  btn.title = `Friends : ${online} online`;
}
