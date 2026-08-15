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
 * Base styles live in profile.js (one injected <style> tag covers pf- and fr-).
 * The wave-12 additions (the action cluster and the JOIN THEM pill) inject a
 * SECOND tag from here, because profile.js belongs to another owner; it is
 * appended after the shared one so equal-specificity rules land on top.
 *
 * ---------------------------------------------------------------------------
 * WAVE 12: co-presence
 *
 * Two sources, one list:
 *   'friends-data'  {t:'friends', friends:[...]}   - the roster, on request
 *   'fpresence'     {t:'fpresence', friends:[{name, room|null}]}
 *                   - PUSHED on hello and whenever one of MY friends changes
 *                     room. `room: null` means offline. Re-emitted raw by
 *                     src/net/client.js; this module owns the shape.
 *
 * The roster decides WHO is on the list; presence decides WHERE they are, and
 * wins on every field it carries, because it is the fresher of the two. A
 * presence entry with no roster row still renders (the server only pushes
 * presence about actual friends) until the first roster answer arrives, after
 * which the roster prunes presence so an unfriended capy cannot linger.
 *
 * Arrivals get one gentle world toast, rate-limited to a handful per session
 * and coalesced inside a frame. A friend coming online is a nice thing that
 * happened, not a summons: there is no countdown, no badge that nags, and
 * missing the toast costs nothing because the row is still sitting there.
 */

// Cached across opens so the overlay paints instantly instead of flashing an
// empty state while the server answers.
let cachedFriends = [];
/** lowercased name -> {name, room, online}. The push frame's view of the world. */
const presence = new Map();
/** The first presence frame is the hello snapshot: it is a baseline, not news. */
let presenceSeeded = false;
/** Until the roster has answered once, presence may add rows of its own. */
let haveRoster = false;
let wired = false;
let openInstance = null;

// ---- arrival toasts -------------------------------------------------------
// "A few per session" per the brief. The cap is per page load and never resets
// on its own: the list, the green dots and the HUD badge carry the information
// afterwards, so the toast is the greeting, not the channel.
const ARRIVAL_MAX = 4;
const ARRIVAL_GAP_MS = 25_000;
let arrivalsShown = 0;
let lastArrivalAt = 0;
let arrivalPhrase = 0;

const ARRIVAL_PHRASES = [
  'paddled into the cove',
  'just splashed into the cove',
  'is back in the cove',
];

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
// styles owned by this module (profile.js owns the rest of the fr- sheet)
// ---------------------------------------------------------------------------

const PRESENCE_STYLE_ID = 'capy-friends-presence-styles';

const PRESENCE_CSS = `
/* the row's buttons live in one cluster now: a door, and the wave-12 JOIN pill */
.fr-acts {
  position: absolute; right: 10px; top: 50%; translate: 0 -50%;
  display: flex; align-items: center; gap: 6px;
  transition: translate 0.14s ease;
}
.fr-item:hover .fr-acts { translate: 0 calc(-50% - 2px); }
/* the door came with its own absolute placement; inside the cluster it flows */
.fr-item .fr-acts .fr-den { position: static; translate: none; }
.fr-item:hover .fr-acts .fr-den { translate: none; }
.fr-item.acts-1 .fr-row { padding-right: 54px; }
.fr-item.acts-2 .fr-row { padding-right: 122px; }

.fr-join {
  border: 0; cursor: pointer; font-family: var(--font); color: #fff;
  font-size: 10px; font-weight: 900; letter-spacing: 0.09em; text-transform: uppercase;
  padding: 0 11px; height: 34px; border-radius: 13px; white-space: nowrap;
  background: linear-gradient(180deg, #8fd0f2 0%, var(--accent2) 100%);
  box-shadow: 0 3px 0 rgba(38, 116, 160, 0.32), 0 6px 12px rgba(45, 36, 23, 0.14);
  transition: scale 0.12s ease, filter 0.16s ease;
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 45ms + 70ms);
}
.fr-join:hover { scale: 1.06; filter: brightness(1.05); }
.fr-join:active { scale: 0.94; }
.fr-join:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.fr-join.is-here {
  background: linear-gradient(180deg, #fffefa 0%, #f2e6cd 100%); color: #8a7a58;
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.09); cursor: default;
}
.fr-join.is-here:hover { scale: 1; filter: none; }

/* on a phone-width card the row's text has nowhere to go, so the pill drops
   its second word rather than squeezing "Online in The Smoothie Shack" into
   three lines. The title and aria-label keep the whole sentence. */
@media (max-width: 460px) {
  .fr-join-more { display: none; }
  .fr-item.acts-2 .fr-row { padding-right: 104px; }
}

@media (prefers-reduced-motion: reduce) {
  .fr-join, .fr-acts { animation: none; transition: none; }
}
`;

/** Injects this module's slice of the friends stylesheet once, after profile's. */
function ensurePresenceStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PRESENCE_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = PRESENCE_STYLE_ID;
  s.textContent = PRESENCE_CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

/**
 * Parse an 'fpresence' frame. Accepts [..] or {friends:[..]}; a row is
 * {name, room|null} where a null/absent room means offline, which is exactly
 * how the server states it, so `online` is derived unless it says otherwise.
 * Room ids are NOT filtered against ROOM_INFO here: a friend standing in a den
 * is in 'house:<owner>', which is a real room with no catalog entry.
 */
function normalizePresence(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.friends) ? raw.friends
      : Array.isArray(raw?.players) ? raw.players : [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name) continue;
    const room = typeof f.room === 'string' && f.room ? f.room : null;
    out.push({
      name,
      room,
      online: typeof f.online === 'boolean' ? f.online : room != null,
    });
  }
  return out;
}

/**
 * Fold a presence push into the map and hand back whoever just turned up.
 * The very first frame of a connection seeds the map in silence: on hello the
 * server tells us about everyone at once, and four friends who were already
 * playing are not four arrivals.
 */
function applyPresence(raw) {
  const list = normalizePresence(raw);
  const arrivals = [];
  for (const p of list) {
    const key = p.name.toLowerCase();
    const prev = presence.get(key);
    presence.set(key, p);
    if (!presenceSeeded) continue;
    const wasOn = prev ? prev.online : false;
    if (p.online && !wasOn) arrivals.push(p);
  }
  presenceSeeded = true;
  return arrivals;
}

/** An unfriended capy must not survive in the presence map as a ghost row. */
function prunePresence() {
  if (!haveRoster) return;
  const keep = new Set(cachedFriends.map((f) => f.name.toLowerCase()));
  for (const key of [...presence.keys()]) if (!keep.has(key)) presence.delete(key);
}

/** The roster says who; presence says where. One list, freshest field wins. */
function friendList() {
  const out = [];
  const seen = new Set();
  for (const f of cachedFriends) {
    const key = f.name.toLowerCase();
    seen.add(key);
    const p = presence.get(key);
    out.push(p ? { ...f, online: p.online, room: p.online ? p.room : null } : f);
  }
  if (!haveRoster) {
    for (const [key, p] of presence) {
      if (seen.has(key)) continue;
      out.push({ id: null, name: p.name, online: p.online, room: p.online ? p.room : null });
    }
  }
  return out;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * The human name of a room a friend might be standing in. Player dens are
 * dynamic rooms ('house:<owner>') and never appear in ROOM_INFO, so they name
 * themselves off the owner in the id (which is lowercased; when it is the
 * friend's own den their real capitalisation is right there on the row).
 */
function roomLabel(room, friendName = '') {
  if (typeof room !== 'string' || !room) return null;
  if (Object.prototype.hasOwnProperty.call(ROOM_INFO, room)) return ROOM_INFO[room].name;
  if (room.startsWith('house:')) {
    const owner = room.slice(6);
    if (!owner) return 'a den';
    if (friendName && owner === friendName.toLowerCase()) return `${friendName}'s den`;
    return `${capitalize(owner)}'s den`;
  }
  return null;
}

function roomLine(f) {
  if (!f.online) return 'Offline : probably napping';
  const label = roomLabel(f.room, f.name);
  return label ? `Online in ${label}` : 'Online somewhere in the cove';
}

/** Can we actually take the player there? Catalog rooms and dens, nothing else. */
function joinable(f) {
  return !!(f.online && typeof f.room === 'string' && f.room
    && (Object.prototype.hasOwnProperty.call(ROOM_INFO, f.room) || f.room.startsWith('house:')));
}

/**
 * Land where they are standing. A den goes through the normal knock (the same
 * flow the player card and the game menu use), so a door that is shut answers
 * with the DEN's own sentence rather than a second, vaguer one from here.
 */
function joinFriend(game, f) {
  const room = f.room;
  if (!room) return;
  if (game.roomId === room) {
    game.toast?.(`You are already here with ${f.name}. Say hi.`);
    return;
  }
  if (room.startsWith('house:')) {
    const owner = room.slice(6);
    visitHouse(game, owner === f.name.toLowerCase() ? f.name : owner);
    return;
  }
  game.audio?.play?.('whoosh');
  const label = roomLabel(room, f.name);
  game.goToRoom(room, game.roomId);
  game.toast?.(label ? `Off to find ${f.name} in ${label}.` : `Off to find ${f.name}.`);
}

/** "Nori paddled into the cove", and never more than a handful of them. */
function arrivalLine(names) {
  const phrase = ARRIVAL_PHRASES[arrivalPhrase % ARRIVAL_PHRASES.length];
  if (names.length === 1) return `${names[0]} ${phrase}`;
  if (names.length === 2) return `${names[0]} and ${names[1]} paddled into the cove`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more paddled into the cove`;
}

function announceArrivals(game, arrivals) {
  if (!arrivals.length) return;
  if (arrivalsShown >= ARRIVAL_MAX) return;
  const now = Date.now();
  if (now - lastArrivalAt < ARRIVAL_GAP_MS) return;
  lastArrivalAt = now;
  arrivalsShown++;
  const line = arrivalLine(arrivals.map((p) => p.name));
  arrivalPhrase++;
  game.toast?.(line, 3400);
  game.audio?.play?.('ding');
}

// ---------------------------------------------------------------------------
// the overlay
// ---------------------------------------------------------------------------

/** Open (or, if it is already up, close) the friends list. */
export function openFriends(game) {
  if (typeof document === 'undefined') return;
  if (openInstance) { openInstance.close(); return; }
  ensureSocialStyles();
  ensurePresenceStyles();
  ensureWired(game);

  const root = elm('div', 'fr-overlay');
  root.innerHTML = `
    <div class="fr-card" role="dialog" aria-label="Friends" tabindex="-1">
      <button class="hud-btn fr-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="fr-head"><h2>Friends</h2><span class="fr-count"></span></div>
      <div class="fr-sub"></div>
      <div class="fr-list"></div>
      <div class="fr-foot">Join them lands you in their room. The door knocks on their den.</div>
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
        'Click a capybara out in the world to open their card, then hit Add friend. They show up here with a green dot, and a button that drops you right next to them.'));
    }
    return wrap;
  }

  function render() {
    if (closed) return;
    const list = friendList();
    listEl.textContent = '';
    const online = list.filter((f) => f.online).length;
    countEl.textContent = list.length
      ? `${list.length} total${online ? `, ${online} online` : ''}`
      : '';
    subEl.textContent = list.length
      ? (online ? 'Green dot means they are in the cove right now. Join them and you land in their room.'
        : 'Nobody is around at the moment. They will be back.')
      : 'Your list of favourite capybaras.';

    if (!list.length) { listEl.appendChild(emptyState()); return; }

    const sorted = [...list].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    sorted.forEach((f, i) => {
      // a card is a live look at a player, so it needs them connected: an
      // offline friend still gets a row, it just does not pretend to open one
      const canOpen = f.id != null;
      // the buttons sit ON the row rather than inside it: a button inside a
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
        const acts = elm('div', 'fr-acts');
        let n = 1;

        if (joinable(f)) {
          n = 2;
          const here = game.roomId === f.room;
          const label = roomLabel(f.room, f.name);
          const join = elm('button', `fr-join${here ? ' is-here' : ''}`);
          join.type = 'button';
          join.style.setProperty('--i', String(i));
          if (here) join.textContent = 'HERE';
          else {
            join.appendChild(document.createTextNode('JOIN'));
            join.appendChild(elm('span', 'fr-join-more', ' THEM'));
          }
          join.title = here
            ? `You are already in the same room as ${f.name}`
            : (label ? `Join ${f.name} in ${label}` : `Join ${f.name}`);
          join.setAttribute('aria-label', join.title);
          join.addEventListener('click', (e) => {
            e.stopPropagation();
            if (here) { game.audio?.play?.('pop'); game.toast(`You are already here with ${f.name}. Say hi.`); return; }
            close(); // plays the click for us, and clears the screen for the trip
            joinFriend(game, f);
          });
          acts.appendChild(join);
        }

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
        acts.appendChild(den);

        item.classList.add('has-den', `acts-${n}`);
        item.appendChild(acts);
      }

      listEl.appendChild(item);
    });
  }

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
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

  render();
  game.net?.send?.({ t: 'friends' });

  root.addEventListener('pointerdown', onBackdrop);
  q('.fr-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  // the data listeners are global (they run with the overlay shut, for the HUD
  // badge and the arrival toast); they repaint through this handle
  openInstance = { close, render };
}

// ---------------------------------------------------------------------------
// the one set of listeners for the whole session
// ---------------------------------------------------------------------------

/**
 * Installs the world-wide social listeners exactly once. Called from both
 * entry points so the overlay works even if the HUD button never mounted.
 */
function ensureWired(game) {
  if (wired) return;
  wired = true;

  // single subscription for the whole session: the engine emits this for any
  // remote avatar the player clicks
  game.events.on('avatar-click', (id) => {
    if (id == null) return;
    openProfile(game, id);
  });

  // a fresh connection is the moment to refresh the badge; a lost one throws
  // away every presence fact, including the baseline, so the reconnect
  // snapshot is a baseline again and not a burst of "everyone just arrived"
  game.events.on('net', (s) => {
    if (s === 'online' && game.state.registered) game.net?.send?.({ t: 'friends' });
    if (s === 'offline') {
      cachedFriends = [];
      presence.clear();
      presenceSeeded = false;
      haveRoster = false;
      updateBadge();
      openInstance?.render?.();
    }
  });

  game.events.on('friends-data', (payload) => {
    cachedFriends = normalizeFriends(payload);
    haveRoster = true;
    prunePresence();
    updateBadge();
    openInstance?.render?.();
  });

  // wave 12: the presence push. Server -> {t:'fpresence', friends:[{name, room|null}]}
  game.events.on('fpresence', (m) => {
    const arrivals = applyPresence(m);
    updateBadge();
    openInstance?.render?.();
    if (game.state?.registered) announceArrivals(game, arrivals);
  });
}

/**
 * Adds the friends button to the HUD cluster and installs the world-wide
 * social listeners exactly once (clicking a capybara opens their card).
 * Safe to call more than once; returns the button element when there is one.
 */
export function initFriendsButton(game) {
  if (typeof document === 'undefined') return null;
  ensureSocialStyles();
  ensurePresenceStyles();
  ensureWired(game);
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
  const online = friendList().filter((f) => f.online).length;
  let badge = btn.querySelector('.fr-hud-badge');
  if (!online) { badge?.remove(); btn.title = 'Friends'; return; }
  if (!badge) {
    badge = elm('span', 'fr-hud-badge');
    btn.appendChild(badge);
  }
  badge.textContent = String(online);
  btn.title = `Friends : ${online} online`;
}
