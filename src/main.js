import './styles.css';
import { game } from './core/game.js';
import { Engine } from './core/engine.js';
import { NetClient } from './net/client.js';
import { audio } from './core/audio.js';
import { ROOMS } from './world/index.js';
import { GAMES } from './minigames/index.js';
import { initHud } from './ui/hud.js';
import { initFriendsButton } from './ui/friends.js';
import { showTitle } from './ui/title.js';
import { DEFAULT_ROOM } from '../shared/constants.js';

game.loadLocal();
game.audio = audio;

const engine = new Engine(game, {
  canvas: document.getElementById('game-canvas'),
  roomRegistry: ROOMS,
});
game.engine = engine;

const net = new NetClient(game, engine);
game.net = net;

// minigame lifecycle
let activeGame = null;
const mgRoot = document.getElementById('minigame-root');
game.events.on('minigame', async (id) => {
  if (id) {
    if (activeGame) return;
    const loader = Object.prototype.hasOwnProperty.call(GAMES, id) ? GAMES[id] : null;
    if (!loader) { console.error(`[main] unknown minigame '${id}'`); return; }
    game.activeMinigame = id; // set before awaiting so startMinigame stays guarded
    let GameClass;
    try {
      GameClass = await loader();
    } catch (e) {
      console.error(`[main] failed to load minigame '${id}':`, e);
      game.activeMinigame = null;
      game.toast('That game could not load, try again');
      return;
    }
    if (game.activeMinigame !== id) return; // quit raced the load
    engine.paused = true;
    // the map lives under the minigame (z-index 30 vs 45); leaving it open would
    // run its canvas painter invisibly and reveal it again on the way out
    document.getElementById('map-overlay')?.classList.add('hidden');
    document.getElementById('chat-input')?.blur(); // it is under there too, and it eats keys
    mgRoot.classList.remove('hidden');
    mgRoot.innerHTML = '';
    activeGame = new GameClass(game);
    activeGame.mount(mgRoot);
    audio.play('whoosh');
  } else {
    game.activeMinigame = null;
    try { activeGame?.dispose?.(); } catch (e) { console.error('[main] minigame dispose:', e); }
    activeGame = null;
    mgRoot.classList.add('hidden');
    mgRoot.innerHTML = '';
    engine.paused = false;
  }
});

// keyboard shortcuts (skipped while typing in inputs, and while a minigame owns
// the screen: Enter used to focus the chat box hidden underneath it, which left
// the running game with no keyboard at all)
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (game.activeMinigame) return;
  if (e.repeat) return; // held keys must not spam emotes (and net sends)
  // D = groove pop, built for mashing (the HUD button still toggles the
  // dance loop); each press is one move, fast presses build combo
  if (e.key === 'd' || e.key === 'D') game.emote('groove');
  if (e.key === 'w' || e.key === 'W') game.emote('wave');
  if (e.key === 'm' || e.key === 'M') document.getElementById('map-overlay')?.classList.toggle('hidden');
  if (e.key === 'Enter') document.getElementById('chat-input')?.focus();
});

function enterWorld(auth) {
  audio.init();
  engine.createPlayer();
  initHud(game);
  // after initHud: the button docks into the HUD cluster the line above builds,
  // and this is also where the world-wide 'avatar-click' -> player card wiring
  // is installed (once per session)
  initFriendsButton(game);
  net.connect(auth);
  engine.start();
  game.goToRoom(DEFAULT_ROOM, null);
  audio.play('success');
}

// returning registered player: skip the title screen only if the token works
const savedToken = (() => { try { return localStorage.getItem('capycove-token'); } catch { return null; } })();
if (savedToken) {
  fetch('/api/me', { headers: { Authorization: `Bearer ${savedToken}` } })
    .then((r) => r.json())
    .then((d) => {
      if (d.ok) {
        game.applyProfile({ ...d.profile, registered: true });
        enterWorld({ token: savedToken });
      } else {
        try { localStorage.removeItem('capycove-token'); } catch {}
        showTitle(game, enterWorld);
      }
    })
    .catch(() => showTitle(game, enterWorld));
} else {
  showTitle(game, enterWorld);
}
