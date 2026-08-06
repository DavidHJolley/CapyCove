import { GAME_NAME } from '../../shared/constants.js';

/**
 * The pause / options menu behind the Capy Cove logo chip.
 *
 * Exported API is exactly: openMenu(game)  (the logo chip toggles it, and a
 * second call while it is open closes it, same as the shop).
 *
 * Styles live in src/styles.css under the .menu- prefix. Nothing here touches
 * the DOM until openMenu runs, so the module is import-safe.
 */

// How to play, in the order a new capybara needs it.
const HOW_TO = [
  ['Click', 'Click the ground to waddle over there.'],
  ['W', 'Wave at whoever is nearby.'],
  ['D', 'Dance. Press it again to stop (you will not want to).'],
  ['M', 'Open the island map and hop to any room.'],
  ['Enter', 'Start typing. Chat history opens while the box is focused.'],
  ['Go', 'Walk into an archway or signpost to travel between rooms.'],
  ['Sled', 'Gather 3 capybaras at Frosty Peak for a live sled race.'],
];

let openInstance = null;

function mountPoint() {
  return document.getElementById('hud-root')
    || document.getElementById('overlay-root')
    || document.body;
}

/**
 * Guests are the sessions with no saved account token: main.js only skips the
 * title screen when 'capycove-token' validates, and title.js only writes that
 * key after a login/signup. Checking the key as well as the profile flag keeps
 * "log out" honest even if the flag is out of date when the menu opens.
 */
function isGuest(game) {
  let token = null;
  try { token = localStorage.getItem('capycove-token'); } catch { /* private mode */ }
  return !token || !game?.state?.registered;
}

/** Open (or, if already open, close) the game menu. */
export function openMenu(game) {
  if (openInstance) { openInstance.close(); return; }

  const root = document.createElement('div');
  root.className = 'menu-overlay';
  root.id = 'menu-overlay';
  root.innerHTML = `
    <div class="menu-card" role="dialog" aria-modal="true" aria-label="Game menu" tabindex="-1">
      <button class="hud-btn map-close menu-x" type="button" title="Close" aria-label="Close menu">&#10005;</button>
      <h2>${GAME_NAME}</h2>
      <div class="menu-sub">Take a breath. The cove waits for no one, but it will wait for you.</div>
      <div class="menu-list">
        <button class="menu-item is-primary" type="button" data-act="resume">Resume</button>
      </div>
      <div class="menu-how">
        <h3>How to play</h3>
        <ul></ul>
      </div>
      <div class="menu-list">
        <button class="menu-item" type="button" data-act="sound"></button>
        <button class="menu-item" type="button" data-act="logout"></button>
        <button class="menu-item is-quiet" type="button" data-act="exit">Exit to title</button>
      </div>
      <div class="menu-foot">Esc closes this menu</div>
    </div>`;
  mountPoint().appendChild(root);

  const card = root.querySelector('.menu-card');
  const list = root.querySelector('.menu-how ul');
  const soundBtn = root.querySelector('[data-act="sound"]');
  const logoutBtn = root.querySelector('[data-act="logout"]');
  const exitBtn = root.querySelector('[data-act="exit"]');

  for (const [key, text] of HOW_TO) {
    const li = document.createElement('li');
    const k = document.createElement('span');
    k.className = 'menu-key';
    k.textContent = key;
    const t = document.createElement('span');
    t.textContent = text;
    li.append(k, t);
    list.appendChild(li);
  }

  // ---- sound ---------------------------------------------------------------
  function syncSound() {
    const muted = !!game.audio?.muted;
    soundBtn.innerHTML = `<span class="menu-ico">${muted ? '&#128263;' : '&#128266;'}</span>`;
    soundBtn.appendChild(document.createTextNode(muted ? 'Sound: off' : 'Sound: on'));
    soundBtn.classList.toggle('is-off', muted);
    soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
  }
  syncSound();
  soundBtn.addEventListener('click', () => {
    disarm();
    const muted = game.audio?.toggleMute?.() ?? false;
    syncSound();
    game.events?.emit?.('mute', muted); // keeps the HUD speaker button honest
    game.audio?.play?.('click'); // silent while muted, a nice confirm on the way back
  });

  // ---- log out (two taps: the guest branch wipes local progress) ------------
  let armed = false;
  let armTimer = 0;

  function labelLogout() {
    const guest = isGuest(game);
    logoutBtn.textContent = armed
      ? (guest ? 'Tap again: clears guest progress' : 'Tap again to log out')
      : 'Log out';
    logoutBtn.classList.toggle('is-danger', armed);
    logoutBtn.title = guest
      ? 'Guest progress lives on this device only, so logging out clears it.'
      : 'Sign out and return to the title screen.';
  }
  function disarm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    if (!armed) return;
    armed = false;
    labelLogout();
  }
  labelLogout();

  logoutBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      labelLogout();
      game.audio?.play?.('click');
      armTimer = setTimeout(disarm, 4200);
      return;
    }
    disarm();
    const guest = isGuest(game); // must be read BEFORE the token is dropped
    try { localStorage.removeItem('capycove-token'); } catch { /* private mode */ }
    if (guest) {
      // guest coins/hats/bests live only in this key, so leaving it behind
      // would log the player straight back into the same guest
      try { localStorage.removeItem('capycove-guest'); } catch { /* private mode */ }
    }
    location.reload();
  });

  // ---- exit ----------------------------------------------------------------
  exitBtn.title = isGuest(game)
    ? 'Back to the title screen.'
    : 'Reloads the cove. You are signed in, so you will waddle straight back.';
  exitBtn.addEventListener('click', () => {
    disarm();
    location.reload();
  });

  root.querySelector('[data-act="resume"]').addEventListener('click', () => close());

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    game.audio?.play?.('click');
  }

  function onBackdrop(e) {
    if (e.target === root) close();
  }
  function onKey(e) {
    // swallow the world hotkeys (w/d/m/Enter) while the menu owns the screen;
    // stopPropagation leaves Tab and Space-on-buttons working as usual.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  root.querySelector('.menu-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('open');

  openInstance = { close };
}
