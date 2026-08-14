import { GAME_NAME } from '../../shared/constants.js';
import { visitHouse } from '../net/client.js';

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
  ['Den', 'The Game Den is inside the ski lodge at Frosty Peak: take a seat at any table to face another player, or the house capybaras.'],
  ['Mine', 'The Glimmer Mine is through the timbered door on Frosty Peak: standing around down there earns coins on its own, and the round door starts a game of Prop Hunt.'],
  ['Jungle', 'The Tangle Jungle is up the fern path from Driftwood Beach: gather at the stone easel for Capy Doodles, drawing and guessing.'],
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
        <button class="menu-item" type="button" data-act="den"></button>
        <button class="menu-item" type="button" data-act="quests"></button>
        <button class="menu-item" type="button" data-act="party"></button>
      </div>
      <div class="menu-sub menu-den-note" hidden style="margin: 10px 4px 0;"></div>
      <div class="menu-party" hidden style="margin-top: 10px;"></div>
      <div class="menu-how">
        <h3>How to play</h3>
        <ul></ul>
      </div>
      <div class="menu-list">
        <button class="menu-item" type="button" data-act="settings"></button>
        <button class="menu-item" type="button" data-act="sound"></button>
        <button class="menu-item" type="button" data-act="logout"></button>
        <button class="menu-item is-quiet" type="button" data-act="exit">Exit to title</button>
      </div>
      <div class="menu-foot">Esc closes this menu</div>
    </div>`;
  mountPoint().appendChild(root);

  const card = root.querySelector('.menu-card');
  const list = root.querySelector('.menu-how ul');
  const denBtn = root.querySelector('[data-act="den"]');
  const denNote = root.querySelector('.menu-den-note');
  const questBtn = root.querySelector('[data-act="quests"]');
  const partyBtn = root.querySelector('[data-act="party"]');
  const partyPanel = root.querySelector('.menu-party');
  const settingsBtn = root.querySelector('[data-act="settings"]');
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

  // ---- my den --------------------------------------------------------------
  // Registered capybaras own exactly one den; guests get the sales pitch.
  denBtn.innerHTML = '<span class="menu-ico">&#127968;</span>';
  denBtn.appendChild(document.createTextNode('My Den'));
  denBtn.title = isGuest(game)
    ? 'Dens come with a (free) account.'
    : 'Waddle home to your own den.';
  denBtn.addEventListener('click', () => {
    disarm();
    if (isGuest(game)) {
      game.audio?.play?.('pop');
      denNote.textContent = 'Guests can visit any open den, but your own comes with an account. '
        + 'Sign up from the title screen and the keys are yours.';
      denNote.hidden = false;
      game.toast('Sign up to get your own den!');
      return;
    }
    close();
    visitHouse(game, game.state.name);
  });

  // ---- quest board ---------------------------------------------------------
  // The plaza notice board is the front door to this; the menu is the shortcut
  // for anyone who is nowhere near the plaza when they wonder about the dailies.
  questBtn.innerHTML = '<span class="menu-ico">&#128220;</span>';
  questBtn.appendChild(document.createTextNode('Quest Board'));
  questBtn.title = 'Today\'s three jobs and how far along you are.';
  questBtn.addEventListener('click', () => {
    disarm();
    close();
    import('./quests.js')
      .then((m) => m.openQuests(game))
      .catch((e) => {
        console.error('[menu] quest board failed to load:', e);
        game.toast('The notice board blew away in the wind, try again');
      });
  });

  // ---- throw a party -------------------------------------------------------
  // Two taps to start one: pick a venue, then confirm. A den party forces the
  // door open for the duration, which is a thing an owner must actually agree
  // to (docs/LIVING-COVE.md A3), so it gets its own line of small print.
  const PARTY_MIN = 30;
  const cooldownLeft = () => Math.max(0, (game.__partyCooldownUntil || 0) - Date.now());

  function labelParty() {
    const guest = isGuest(game);
    const wait = cooldownLeft();
    partyBtn.innerHTML = '<span class="menu-ico">&#127881;</span>';
    partyBtn.appendChild(document.createTextNode('Throw a party'));
    partyBtn.classList.toggle('is-off', guest || wait > 0 || !game.net?.connected);
    partyBtn.title = guest
      ? 'Parties come with a (free) account.'
      : !game.net?.connected
        ? 'The cove is offline for a moment.'
        : wait > 0
          ? `You threw one recently. Ready again in about ${Math.ceil(wait / 60000)} min.`
          : `Thirty minutes, island-wide invitation, your choice of venue.`;
  }
  labelParty();

  function partyNote(text) {
    partyPanel.hidden = false;
    partyPanel.textContent = '';
    const p = document.createElement('div');
    p.className = 'menu-sub';
    p.style.margin = '0 4px';
    p.textContent = text;
    partyPanel.appendChild(p);
  }

  function venuePicker() {
    partyPanel.hidden = false;
    partyPanel.textContent = '';

    const lead = document.createElement('div');
    lead.className = 'menu-sub';
    lead.style.margin = '0 4px 8px';
    lead.textContent = `Where is it? The whole island gets told, and it runs for ${PARTY_MIN} minutes.`;
    partyPanel.appendChild(lead);

    const row = document.createElement('div');
    row.className = 'menu-list';
    partyPanel.appendChild(row);

    for (const [venue, icon, name, blurb] of [
      ['den', '&#127968;', 'My den', 'Your place, your furniture, doors open to everyone.'],
      ['club', '&#127908;', 'The Groove Grotto', 'Neon, bass, and room for the whole cove.'],
    ]) {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.type = 'button';
      b.innerHTML = `<span class="menu-ico">${icon}</span>`;
      b.appendChild(document.createTextNode(name));
      b.title = blurb;
      b.addEventListener('click', () => { game.audio?.play?.('click'); confirmVenue(venue, name, blurb); });
      row.appendChild(b);
    }
  }

  function confirmVenue(venue, name, blurb) {
    partyPanel.textContent = '';

    const lead = document.createElement('div');
    lead.className = 'menu-sub';
    lead.style.margin = '0 4px 8px';
    lead.textContent = venue === 'den'
      // the confirmation dialog A3 asks for: say the consequence in plain words
      ? `Your den will be set to OPEN for the next ${PARTY_MIN} minutes so anyone can walk in, `
        + 'and it goes back to how you had it the moment the party ends. Still on?'
      : `${blurb} Everyone gets a toast, and the map lights up. Still on?`;
    partyPanel.appendChild(lead);

    const row = document.createElement('div');
    row.className = 'menu-list';
    partyPanel.appendChild(row);

    const go = document.createElement('button');
    go.className = 'menu-item is-primary';
    go.type = 'button';
    go.textContent = venue === 'den' ? `Open my den and start the party` : `Start the party at ${name}`;
    go.addEventListener('click', () => {
      go.disabled = true;
      // 'force' is the owner's explicit yes to the door being propped open
      game.net?.send?.({ t: 'party-start', venue, force: true });
      game.audio?.play?.('success');
      // optimistic: the server's own frame overwrites this the moment it lands
      game.__partyCooldownUntil = Date.now() + 90 * 60 * 1000;
      partyNote('Sent! Watch for the island-wide toast, then go and be a host.');
      setTimeout(() => close(), 1400);
    });
    row.appendChild(go);

    const back = document.createElement('button');
    back.className = 'menu-item is-quiet';
    back.type = 'button';
    back.textContent = 'Pick somewhere else';
    back.addEventListener('click', () => { game.audio?.play?.('click'); venuePicker(); });
    row.appendChild(back);
  }

  partyBtn.addEventListener('click', () => {
    disarm();
    if (isGuest(game)) {
      game.audio?.play?.('pop');
      partyNote('Parties need an account: the cove has to know whose name goes on the invitation. '
        + 'Sign up from the title screen and the Grotto is yours for half an hour.');
      game.toast('Sign up to throw parties!');
      return;
    }
    if (!game.net?.connected) {
      game.audio?.play?.('pop');
      partyNote('The cove is offline for a moment. Invitations will go out once it is back.');
      return;
    }
    const wait = cooldownLeft();
    if (wait > 0) {
      game.audio?.play?.('pop');
      partyNote(`You threw one not long ago. The cove needs about ${Math.ceil(wait / 60000)} more minutes `
        + 'to sweep up before the next one.');
      return;
    }
    game.audio?.play?.('click');
    venuePicker();
  });

  // ---- settings ------------------------------------------------------------
  // The panel is loaded on demand (it is nobody's business until asked for),
  // and opening the MENU is also the earliest hook this module has for putting
  // the saved graphics/motion preferences back on a freshly reloaded page:
  // applySavedSettings() is idempotent, so calling it here costs nothing.
  // A boot hook in main.js would be better; that file is not ours to edit.
  const settingsReady = import('./settings.js')
    .then((m) => { try { m.applySavedSettings(game); } catch (e) { console.error('[menu] settings restore:', e); } return m; })
    .catch((e) => { console.error('[menu] settings failed to load:', e); return null; });

  settingsBtn.innerHTML = '<span class="menu-ico">&#9881;</span>';
  settingsBtn.appendChild(document.createTextNode('Settings'));
  settingsBtn.title = 'Graphics, volume, camera and motion.';
  settingsBtn.addEventListener('click', () => {
    disarm();
    close();
    settingsReady.then((m) => {
      if (m) m.openSettings(game);
      else game.toast('The settings drawer is stuck, try again');
    });
  });

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
