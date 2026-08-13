import './styles.css';
import * as THREE from 'three';
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

/**
 * TEMPORARY DEV ACCESS: anyone whose name starts with "david" gets the layout
 * editor. This is a convenience gate, NOT security: the editor is entirely
 * client-side (it drags local meshes and prints coordinates, it cannot change
 * anyone else's world or touch the server), and any player could open devtools
 * and call the same module. It exists so the owner can art-direct rooms in
 * place during development.
 *
 * !!! REMOVE BEFORE THE GAME GOES PUBLIC !!!
 * Replace with a real check (an `admin: true` flag on the server record,
 * verified in the welcome profile) or delete the editor hotkey entirely.
 * Tracked in the session task list and in CLAUDE.md's roadmap.
 */
function isAdmin() {
  return /^david/i.test(game.state?.name || '');
}

// keyboard shortcuts (skipped while typing in inputs, and while a minigame owns
// the screen: Enter used to focus the chat box hidden underneath it, which left
// the running game with no keyboard at all)
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  // Ctrl+E: dev layout editor. Allowed before the minigame guard so it can be
  // closed from anywhere. See isAdmin() for the temporary access rule.
  if (e.key === 'e' && (e.ctrlKey || e.metaKey) && isAdmin()) {
    e.preventDefault();
    import('./ui/editor.js').then((m) => m.toggleEditor(game));
    return;
  }
  if (game.activeMinigame) return;
  if (e.repeat) return; // held keys must not spam emotes (and net sends)
  // D = groove pop, built for mashing (the HUD button still toggles the
  // dance loop); each press is one move, fast presses build combo
  if (e.key === 'd' || e.key === 'D') game.emote('groove');
  if (e.key === 'w' || e.key === 'W') game.emote('wave');
  if (e.key === 'm' || e.key === 'M') document.getElementById('map-overlay')?.classList.toggle('hidden');
  if (e.key === 'Enter') document.getElementById('chat-input')?.focus();
});

/**
 * Cinematic arrival: a ~2.5s establishing swoop from high above the room's
 * static vantage down into the normal follow camera behind the spawn. Driven
 * entirely from outside the engine: we flip `engine.cameraMode` to 'static',
 * zero `_camEase`, and rewrite `engine._staticCam` every frame along our own
 * path (the engine's static branch copies from it before each render), then
 * hand back the player's saved camera mode. Skippable with any click/keypress;
 * `onLanded` fires exactly once (land or bail) so held UI can be released.
 */
function startArrivalSwoop(onLanded) {
  const SWOOP_MS = 2500;
  const savedMode = engine.cameraMode; // restore after the swoop
  let phase = 'wait'; // wait (room still building) -> fly -> done
  let rafId = 0;
  let t0 = 0;
  const waitStart = performance.now();
  const startPos = new THREE.Vector3();
  const startLook = new THREE.Vector3();
  const endPos = new THREE.Vector3();
  const endLook = new THREE.Vector3();
  // the engine reads these two by reference every frame; we mutate in place
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();

  const onSkip = () => land();

  function land() {
    if (phase === 'done') return;
    phase = 'done';
    cancelAnimationFrame(rafId);
    removeEventListener('pointerdown', onSkip, true);
    removeEventListener('keydown', onSkip, true);
    engine.cameraMode = savedMode === 'static' ? 'static' : 'follow';
    const p = engine.playerAvatar?.group?.position;
    if (engine.cameraMode === 'static') {
      // recompute the room's real vantage and glide there from wherever we are
      if (engine.room) engine._resolveStaticCam(true);
    } else if (p) {
      // park exactly on the follow vantage so the takeover has no snap
      engine.camTarget.copy(p);
      engine.camera.position.copy(p).add(engine.camCfg.offset);
    }
    onLanded?.();
  }

  addEventListener('pointerdown', onSkip, true);
  addEventListener('keydown', onSkip, true);

  function frame() {
    if (phase === 'done') return;
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    if (phase === 'wait') {
      // switchRoom builds the scene behind a 220ms fade; poll until it lands
      if (engine.scene && engine.room && engine.playerAvatar && engine._staticCam) {
        // start: the room's static vantage pulled back 1.5x and lifted 15deg
        const base = engine._staticCam;
        startLook.copy(base.lookAt);
        const off = base.position.clone().sub(base.lookAt);
        const sph = new THREE.Spherical().setFromVector3(off);
        sph.radius *= 1.5;
        sph.phi = Math.max(0.12, sph.phi - THREE.MathUtils.degToRad(15));
        startPos.copy(startLook).add(off.setFromSpherical(sph));
        pos.copy(startPos);
        look.copy(startLook);
        engine.cameraMode = 'static';
        engine._camEase = 0; // the engine copies _staticCam verbatim at ease 0
        engine._staticCam = { position: pos, lookAt: look };
        t0 = now;
        phase = 'fly';
      } else if (now - waitStart > 6000) {
        land(); // the room never built (load error): give the camera back
      }
      return;
    }
    // a mid-swoop room change replaces _staticCam (switchRoom re-resolves it);
    // if ours is gone, stop driving and hand the camera back cleanly
    if (engine._staticCam?.position !== pos) { land(); return; }
    const u = Math.min(1, (now - t0) / SWOOP_MS);
    const k = u * u * (3 - 2 * u); // smoothstep
    // the destination tracks the LIVE player: walking during the swoop still
    // lands the camera exactly behind them, so control feels instant at touchdown
    const p = engine.playerAvatar.group.position;
    endPos.copy(p).add(engine.camCfg.offset);
    endLook.set(p.x, p.y + engine.camCfg.lookHeight, p.z);
    pos.lerpVectors(startPos, endPos, k);
    look.lerpVectors(startLook, endLook, k);
    if (u >= 1) land();
  }
  rafId = requestAnimationFrame(frame);
}

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
  // Hold every toast (the room-name banner rides the 'room' event via
  // game.toast) until the arrival swoop lands, so the UI beat syncs with the
  // camera touchdown instead of firing over the establishing shot.
  const held = [];
  const wrappedToast = (msg, ms) => { held.push([msg, ms]); };
  game.toast = wrappedToast;
  const releaseToasts = () => {
    if (game.toast === wrappedToast) delete game.toast; // back to the prototype method
    for (const [msg, ms] of held.splice(0)) game.toast(msg, ms);
  };
  game.goToRoom(DEFAULT_ROOM, null);
  startArrivalSwoop(releaseToasts);
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
