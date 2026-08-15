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
import { maybeStartTour } from './ui/firstrun.js';
import { DEFAULT_ROOM } from '../shared/constants.js';

/**
 * BOOT LOADING SCREEN (the #boot panel + its critical CSS are inlined in
 * index.html; the exit animation is the "loading screen handoff" section of
 * styles.css).
 *
 * Reaching this line already means the whole entry bundle (three.js, the
 * engine, the UI) has been fetched, parsed and evaluated, which is the long
 * pole of a cold start: that is milestone one. The rest are real events, not a
 * timed fake:
 *   30%  this file started running (bundle parsed)
 *   55%  the spawn room's code-split chunk resolved (warmed below)
 *   85%  the first room is built and the player avatar is standing in it,
 *        OR the title screen is up (guest path: nothing else is loading)
 *   100% the server said welcome ('net' -> online), or 3s after the room
 *        built, whichever lands first
 * Then the panel lifts, minimum 0.8s after navigation so a warm reload never
 * flashes it, and both the element and its <style> are deleted: no leftover
 * DOM, no leftover listeners, no leftover timers.
 */
const bootCleanups = [];
const boot = (() => {
  const el = document.getElementById('boot');
  if (!el) return { set() {}, finish() {} }; // nothing to drive (embedded/test host)
  const fill = document.getElementById('boot-fill');
  const track = document.getElementById('boot-track');
  const note = document.getElementById('boot-note');
  const MIN_MS = 800;    // no flash
  const HARD_MS = 12000; // ...but never hold the screen hostage either
  let pct = 0;
  let done = false;
  const release = () => {
    for (const fn of bootCleanups.splice(0)) { try { fn(); } catch (e) { console.error('[boot] cleanup:', e); } }
  };
  const set = (p, label) => {
    if (done) return;
    if (label && note) note.textContent = label;
    if (p <= pct) return;
    pct = p;
    if (fill) fill.style.width = `${p}%`;
    track?.setAttribute('aria-valuenow', String(Math.round(p)));
  };
  const finish = () => {
    if (done) return;
    set(100, 'here we go');
    done = true;
    release();
    // hold the full bar for a beat, and honour the 0.8s floor measured from
    // navigation start (performance.now() is exactly that clock)
    const wait = Math.max(140, MIN_MS - performance.now());
    setTimeout(() => {
      el.classList.add('is-out');
      // outlast the 0.6s lift, then take the panel AND its inline styles out
      setTimeout(() => { el.remove(); document.getElementById('boot-css')?.remove(); }, 700);
    }, wait);
  };
  const hardStop = setTimeout(finish, HARD_MS);
  bootCleanups.push(() => clearTimeout(hardStop));
  return { set, finish };
})();
boot.set(30, 'unpacking the cove');

game.loadLocal();
game.audio = audio;

const engine = new Engine(game, {
  canvas: document.getElementById('game-canvas'),
  roomRegistry: ROOMS,
});
game.engine = engine;

const net = new NetClient(game, engine);
game.net = net;

/* Boot milestones 55 -> 100. All of these are observations of work that is
   really happening; none of them make the boot any slower. */

// 55%: pull the spawn room's chunk now instead of waiting for switchRoom to ask
// for it behind the 220ms fade. Room modules have no import-time side effects
// (CLAUDE.md), so this only warms the module cache: the build below reuses it.
{
  const warm = Object.prototype.hasOwnProperty.call(ROOMS, DEFAULT_ROOM) ? ROOMS[DEFAULT_ROOM] : null;
  const at55 = () => boot.set(55, 'unrolling the plaza');
  if (warm) Promise.resolve().then(warm).then(at55, at55);
  else at55();
}

// 85% + 100%: one timer watches for whichever destination this boot is headed
// to. Registered before the entry paths below run, and torn down by boot.finish.
{
  let roomBuilt = false;
  let greeted = false; // ws welcome landed, or we gave up waiting for it
  let welcomeWait = 0;
  // BOTH have to be true on the world path: the welcome frame can beat the
  // room build on a warm reload, and lifting then would show an empty canvas
  const tryFinish = () => { if (roomBuilt && greeted) boot.finish(); };
  const poll = setInterval(() => {
    // guest path: the title screen IS the destination, so it is fully loaded
    if (document.querySelector('.title-screen')) {
      boot.set(85, 'opening the gate');
      boot.finish();
      return;
    }
    // returning-player path: wait for the first room to actually stand up
    if (!roomBuilt && engine.room && engine.playerAvatar) {
      roomBuilt = true;
      boot.set(85, 'waking the neighbours');
      // the ws welcome normally beats this; if the server is slow or down, the
      // world is playable anyway, so hand it over
      if (!welcomeWait) welcomeWait = setTimeout(() => { greeted = true; tryFinish(); }, 3000);
      tryFinish();
    }
  }, 80);
  bootCleanups.push(() => { clearInterval(poll); if (welcomeWait) clearTimeout(welcomeWait); });
  bootCleanups.push(game.events.on('net', (s) => { if (s === 'online') { greeted = true; tryFinish(); } }));
}

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
 * OPERATOR HOTKEYS (wave 9E). The name-prefix backdoor that used to live here
 * is gone: access is now the server's `caps` list, minted from `rec.role` in
 * server/admin.js, carried on the welcome profile and re-derived on every
 * applyProfile (src/core/game.js). A guest is rank 0 and holds nothing, so
 * `caps` is empty and neither hotkey exists for them.
 *
 * Both gates are cosmetic, and deliberately so:
 *   Ctrl+E       the layout editor is client-side only (it drags local meshes
 *                and prints coordinates; it writes nothing to the server), so
 *                'editor' is a UX gate on a tool, not a privilege.
 *   Ctrl+Shift+A the mod panel only ever SENDS `a-*` frames, and every one of
 *                them is re-authorised by server/admin.js's performOp. The
 *                chunk existing on the CDN is harmless: a player who loads it
 *                by hand gets a panel whose every button is answered with
 *                silence, and a log line.
 * The panel module is imported ONLY when caps is non-empty, so an ordinary
 * player never fetches, parses or pays for a byte of it.
 */

// keyboard shortcuts (skipped while typing in inputs, and while a minigame owns
// the screen: Enter used to focus the chat box hidden underneath it, which left
// the running game with no keyboard at all)
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  // Ctrl+E: dev layout editor. Allowed before the minigame guard so it can be
  // closed from anywhere.
  if (e.key === 'e' && (e.ctrlKey || e.metaKey) && game.can('editor')) {
    e.preventDefault();
    import('./ui/editor.js').then((m) => m.toggleEditor(game));
    return;
  }
  // Ctrl+Shift+A: the mod/admin panel. Any capability at all opens it; the
  // panel itself shows only the buttons this role holds. Also before the
  // minigame guard, so it can be closed from anywhere.
  if ((e.key === 'a' || e.key === 'A') && e.shiftKey && (e.ctrlKey || e.metaKey)
    && game.state.caps?.length) {
    e.preventDefault();
    import('./ui/admin.js')
      .then((m) => m.toggleAdmin(game))
      .catch((err) => { console.error('[main] admin panel failed to load:', err); game.toast('The mod panel is not answering, try again'); });
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
  maybeStartTour(game); // first visit only; it waits for the swoop to land
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
