import * as THREE from 'three';
import * as postfx from './postfx.js';
import { disposeObject } from './materials.js';
import { createAvatar } from '../player/avatar.js';
import { WalkController } from '../player/controller.js';
import { attachOverlay, preloadLayout } from '../world/overlay.js';
import { attachCharm } from '../world/charm.js';
import { attachAmbience } from '../world/ambience.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3(); // snapY runs per remote per frame; don't allocate

// Static ("whole room") camera: the vantage is fixed, so the only motion is a
// short ease when you switch into the mode or walk into a new room.
const CAM_EASE = 0.5;
// The fallback vantage keeps the game's 3/4 read: same elevation as the default
// follow offset (atan(14/19) ~= 36.4 degrees), looking north from the south.
const FALLBACK_DIR = new THREE.Vector3(0, 14, 19).normalize();
const FALLBACK_MARGIN = 1.14;
// the window shape rooms author their staticCamera against
const REF_ASPECT = 16 / 9;
const _box = new THREE.Box3();
const _sub = new THREE.Box3();
const _corner = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/*
 * INPUT MAP (session task #20, owner's call 2026-08-14)
 *
 *   RIGHT button  walk. A click sends you to the spot; holding it down and
 *                 dragging keeps re-aiming the walk, so you can steer.
 *   LEFT button   interact, and nothing else: another capybara's profile card,
 *                 a prop the room picks up itself (the beach ball, the whale),
 *                 the hotspot prompt buttons. It never moves you any more.
 *   Touch         unchanged: a finger has no second button, so a tap still
 *                 walks AND still interacts, exactly as before.
 *
 * Anyone whose pointer cannot comfortably right-click can put walking back on
 * the left button in Settings > Walking; that is the ONLY other configuration,
 * and it restores the old behaviour verbatim (left walks and interacts).
 */
const WALK_KEY = 'capycove-walkbtn';
const WALK_REPEAT_MS = 60; // how often a held walk button re-aims
// One nudge per session for the muscle memory the remap breaks. Module scope:
// a room change must not start the counting over.
let _walkHintShown = false;

/**
 * Engine: renderer, camera, main loop, room lifecycle, click-to-move,
 * hotspot prompts, and world-anchored DOM overlays (name tags, chat bubbles).
 */
export class Engine {
  constructor(game, { canvas, roomRegistry }) {
    this.game = game;
    this.rooms = roomRegistry;
    this.canvas = canvas;
    this.room = null;
    this.scene = null;
    this.paused = false;
    this._switchTimer = null; // pending switchRoom fade timer
    this._pendingRoom = null; // its destination, so re-entrant calls can collapse
    this._switchSeq = 0;
    this.playerAvatar = null;
    this.controller = null;
    this.remoteGroup = new THREE.Group();
    this.roomAge = 0; // seconds since the current room finished building
    this.overlays = new Set(); // {obj, el, yOff, until?}
    this.hotspotEls = new Map(); // hotspot -> button el
    this.ray = new THREE.Raycaster();
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
    // Post chain (bloom + grade). If it can't build (old GPU), _tick keeps the
    // plain renderer.render path: postfx.render() returns false forever.
    postfx.init(this.renderer, null, this.camera);
    this.camDefault = { offset: new THREE.Vector3(0, 14, 19), lookHeight: 1 };
    this.camCfg = { offset: this.camDefault.offset, lookHeight: this.camDefault.lookHeight };
    this.camTarget = new THREE.Vector3();
    // 'follow' = soft-follow the player; 'static' = fixed whole-room vantage
    // (per-room via room.staticCamera, engine fallback otherwise)
    this.cameraMode = (() => {
      try { return localStorage.getItem('capycove-cam') === 'static' ? 'static' : 'follow'; } catch { return 'follow'; }
    })();
    this._staticCam = null;
    // 'right' (the shipped remap) | 'left' (the classic scheme, Settings)
    this.walkButton = (() => {
      try { return localStorage.getItem(WALK_KEY) === 'left' ? 'left' : 'right'; } catch { return 'right'; }
    })();
    this._walkHold = 0;  // MouseEvent.buttons mask of the held walk button, 0 when idle
    this._walkNext = 0;  // performance.now() the held walk may re-aim again
    this._leftOnGround = 0; // left clicks that landed on the floor and did nothing
    this._camEase = 0; // seconds left in the entry/arrival ease
    this._camFrom = new THREE.Vector3();
    this._lookFrom = new THREE.Vector3();
    this._lookNow = new THREE.Vector3();

    this.overlayRoot = document.getElementById('overlay-root');

    addEventListener('resize', () => this._resize());
    this._resize();

    canvas.addEventListener('pointerdown', (e) => this._onPointer(e));
    // hold-to-walk: while the walk button is down, a drag keeps re-aiming
    canvas.addEventListener('pointermove', (e) => this._onPointerDrag(e));
    // the browser menu would pop on the very press that starts a walk. The
    // layout editor suppresses it too (right-drag orbits there), and the
    // classic left-walk setting hands it straight back.
    canvas.addEventListener('contextmenu', (e) => { if (this.walkButton !== 'left') e.preventDefault(); });
    // a release anywhere ends the hold, including off the canvas or over the HUD
    const endHold = () => { this._walkHold = 0; };
    addEventListener('pointerup', endHold);
    addEventListener('pointercancel', endHold);
    addEventListener('blur', endHold);

    // Background tabs freeze requestAnimationFrame, which used to freeze the
    // player mid-walk (locally AND for everyone else, since move frames stop).
    // While hidden, a fallback tick keeps the walker and the net client
    // simulating. Timers are throttled back there too, so the net client ALSO
    // calls backgroundTick on incoming traffic (ws handlers never throttle).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (!this._bgTimer) this._bgTimer = setInterval(() => this.backgroundTick(), 1000);
      } else if (this._bgTimer) {
        clearInterval(this._bgTimer);
        this._bgTimer = null;
      }
    });
  }

  /** Reduced simulation step while the tab is hidden: movement + networking
   *  only (no render, no camera, no overlays). Safe to call often; it
   *  rate-limits itself and consumes the shared clock delta in substeps. */
  backgroundTick() {
    if (!document.hidden || !this.room || !this.scene || this.paused) return;
    const now = performance.now();
    if (now - (this._bgLast || 0) < 200) return;
    this._bgLast = now;
    let dt = Math.min(this.clock.getDelta(), 2); // catch up at most 2s at once
    while (dt > 0) {
      const step = Math.min(dt, 0.05);
      if (this.controller.enabled !== false) this.controller.update(step, this.room);
      this.game.net?.update?.(step);
      dt -= step;
    }
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    postfx.resize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // whole-room framing depends on the aspect: a tall phone window has to pull
    // back further than a wide desktop one, authored vantage or computed
    if (this.room) this._resolveStaticCam(false);
  }

  // ---- player --------------------------------------------------------------
  createPlayer() {
    const { state } = this.game;
    this.playerAvatar = createAvatar({ color: state.color, hat: state.hat });
    this.controller = new WalkController(this.playerAvatar);
    this.playerTag = this.attachNameTag(this.playerAvatar.group, state.name, false, true);
  }

  // ---- room lifecycle ------------------------------------------------------
  switchRoom(id, fromId) {
    // 'house:<owner>' ids all resolve to the one house room class
    const key = id.startsWith('house:') ? 'house' : id;
    const loader = Object.prototype.hasOwnProperty.call(this.rooms, key) ? this.rooms[key] : null;
    if (!loader) { console.error(`[engine] unknown room '${id}'`); return; }

    // Collapse re-entrant calls (double-clicked exit prompt): the same
    // destination keeps its original arrival time, a different one wins and
    // cancels the queued build instead of running both.
    if (this._pendingRoom !== null) {
      if (this._pendingRoom === id) return;
      if (this._switchTimer !== null) { clearTimeout(this._switchTimer); this._switchTimer = null; }
    }
    this._pendingRoom = id;
    const seq = ++this._switchSeq;

    // start the room module download NOW so the fade covers it, not after
    const pending = (async () => loader())();
    pending.catch(() => {}); // handled in the timer; this only silences an orphaned reject

    const fade = document.getElementById('fade');
    this._irisClose(fade); // soft iris wipe closing on the player (adds .on)
    this.game.audio?.play?.('whoosh');

    this._switchTimer = setTimeout(async () => {
      this._switchTimer = null;
      let RoomClass;
      try {
        // preloadLayout resolves null after 250ms and never rejects, so the
        // published-layout fetch rides the fade without delaying the switch
        [RoomClass] = await Promise.all([pending, preloadLayout(id)]);
      } catch (e) {
        console.error(`[engine] failed to load room '${id}':`, e);
        if (seq === this._switchSeq) { this._pendingRoom = null; this._irisReset(fade); }
        return;
      }
      if (seq !== this._switchSeq) return; // superseded while loading
      this._pendingRoom = null;

      this._teardownRoom();
      this.room = new RoomClass();
      this.scene = new THREE.Scene();
      this.room.build(this.scene, this.game);
      attachOverlay(this.room, this.scene, this.game, id);
      attachCharm(this.room, this.scene, this.game, id);
      // living air, outermost wrap: it hooks the room instance's own
      // update/dispose/onClock, so the clock replay below must stay after it
      attachAmbience(this.room, this.scene, this.game, id);
      if (!this.room.groundMeshes?.length) console.warn(`[engine] room '${id}' has no groundMeshes`);
      this.scene.add(this.remoteGroup);
      // {arrive:true}: the player is walking into this room behind a closed
      // iris, so postfx stages the fade-up and tints the wipe. A rebuild says
      // false. postfx cannot tell the two apart by itself: we keep rendering
      // the old scene through the whole wipe, so there is no render gap.
      postfx.setScene(this.scene, this.camera, this.room, { arrive: true });

      const spawn = this.room.getSpawn(fromId);
      this.playerAvatar.group.position.copy(spawn);
      this.playerAvatar.setAnim('idle');
      this.controller.stop();
      this.snapY(this.playerAvatar.group.position, this.room);
      this.scene.add(this.playerAvatar.group);

      const hint = this.room.cameraHint;
      // clone: rooms may re-author camCfg.offset per frame (The Drift's swim
      // cam does); a shared reference would corrupt camDefault for every
      // later room
      this.camCfg = {
        offset: (hint?.offset || this.camDefault.offset).clone(),
        lookHeight: hint?.lookHeight ?? this.camDefault.lookHeight,
      };
      this.camera.position.copy(spawn).add(this.camCfg.offset);
      this.camTarget.copy(spawn);
      this._lookNow.set(spawn.x, spawn.y + this.camCfg.lookHeight, spawn.z);
      // arriving in a new room glides out to its vantage instead of cutting
      this._resolveStaticCam(true);

      this.roomAge = 0;
      this.game.audio?.setRoom?.(id);
      // world clock: rooms that react to time of day get the current state
      // immediately on build, then live updates via the same hook (wave 7)
      if (this.lastClock && this.room.onClock) {
        const c = this.lastClock;
        try { this.room.onClock(c.dayT, c.weather, c.aurora, c); }
        catch (e) { console.error('[engine] onClock:', e); }
      }
      this._irisOpen(fade); // iris opens from the arrival spawn, then clears .on
    }, 220);
  }

  // ---- iris wipe -----------------------------------------------------------
  /** Room switches wipe with a soft iris: a radial mask on the #fade div
   *  closes on the player's screen position, then opens from the arrival
   *  spawn (~0.45s total). Browsers without @property support (no registered
   *  --iris-r to transition) keep the old plain opacity fade: the CSS
   *  degrades to it under prefers-reduced-motion too. */
  _irisOk() {
    if (this._irisOkCache === undefined) {
      this._irisOkCache = typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function';
    }
    return this._irisOkCache;
  }

  /** World position -> CSS pixels, or null when it projects off-screen. */
  _screenXY(pos, yOff = 0) {
    const v = new THREE.Vector3(pos.x, pos.y + yOff, pos.z).project(this.camera);
    if (!(v.z > -1 && v.z < 1)) return null;
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  }

  /** Radius that covers the whole viewport from (x, y). */
  _coverR(x, y) {
    return Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))) + 2;
  }

  _irisClose(fade) {
    if (this._irisTimer) { clearTimeout(this._irisTimer); this._irisTimer = null; }
    fade.classList.add('on');
    if (!this._irisOk()) return; // plain opacity fade
    const p = this.playerAvatar?.group?.position;
    const at = (p && this.scene) ? this._screenXY(p, 1) : null;
    const x = at ? at.x : innerWidth / 2;
    const y = at ? at.y : innerHeight / 2;
    fade.classList.add('iris');
    // plant the start state (fully open at the player) without transitioning
    fade.style.transition = 'none';
    fade.style.setProperty('--iris-x', `${x}px`);
    fade.style.setProperty('--iris-y', `${y}px`);
    fade.style.setProperty('--iris-r', `${this._coverR(x, y)}px`);
    void fade.offsetWidth; // commit it
    fade.style.transition = '';
    fade.style.setProperty('--iris-r', '0px'); // ...then close on them
  }

  _irisOpen(fade) {
    if (!fade.classList.contains('iris')) { fade.classList.remove('on'); return; }
    // aim the camera the way the first visible frame will, so the spawn
    // projects where it will actually appear (both camera modes start here)
    this.camera.lookAt(this._lookNow);
    this.camera.updateMatrixWorld(true);
    const p = this.playerAvatar?.group?.position;
    const at = p ? this._screenXY(p, 1) : null;
    const x = at ? at.x : innerWidth / 2;
    const y = at ? at.y : innerHeight / 2;
    fade.style.setProperty('--iris-x', `${x}px`);
    fade.style.setProperty('--iris-y', `${y}px`);
    void fade.offsetWidth;
    fade.style.setProperty('--iris-r', `${this._coverR(x, y)}px`);
    this._irisTimer = setTimeout(() => { this._irisTimer = null; this._irisReset(fade); }, 260);
  }

  /** Back to the resting state with no flash: opacity snaps to 0 while .iris
   *  still zeroes the opacity transition, THEN the gradient class goes. */
  _irisReset(fade) {
    if (this._irisTimer) { clearTimeout(this._irisTimer); this._irisTimer = null; }
    fade.classList.remove('on');
    if (!fade.classList.contains('iris')) return;
    void fade.offsetWidth; // recalc at opacity 0 before restoring the 0.22s fade
    fade.classList.remove('iris');
    fade.style.removeProperty('--iris-x');
    fade.style.removeProperty('--iris-y');
    fade.style.removeProperty('--iris-r');
    fade.style.transition = '';
  }

  /** Called by the net client on every 'clock' frame. The full frame rides as
   *  the 4th arg so rooms can read extras (peak snowfall lives in m.snow). */
  applyClock(m) {
    this.lastClock = m;
    if (this.room?.onClock) {
      try { this.room.onClock(m.dayT, m.weather, m.aurora, m); }
      catch (e) { console.error('[engine] onClock:', e); }
    }
  }

  /**
   * Dev: rebuild the current room in place, keeping the player where they
   * stand and skipping the fade. The layout editor uses this after changing a
   * number, so signs, chairs, prompt zones and colliders all land exactly
   * where a normal visit would put them (most of them are merged into shared
   * instanced batches and cannot be moved any other way).
   */
  rebuildRoom() {
    if (!this.room || !this.scene || !this.playerAvatar) return null;
    const RoomClass = this.room.constructor;
    const pos = this.playerAvatar.group.position.clone();
    const rot = this.playerAvatar.group.rotation.y;

    this._teardownRoom();
    this.room = new RoomClass();
    this.scene = new THREE.Scene();
    this.room.build(this.scene, this.game);
    attachOverlay(this.room, this.scene, this.game, this.room.id);
    attachCharm(this.room, this.scene, this.game, this.room.id);
    attachAmbience(this.room, this.scene, this.game, this.room.id);
    this.scene.add(this.remoteGroup);
    // in-place rebuild (the layout editor, after every dragged handle): nothing
    // covered the screen, so no arrival staging and no tinted wipe
    postfx.setScene(this.scene, this.camera, this.room, { arrive: false });

    this.playerAvatar.group.position.copy(pos);
    this.playerAvatar.group.rotation.y = rot;
    this.snapY(this.playerAvatar.group.position, this.room);
    this.scene.add(this.playerAvatar.group);
    this.controller.stop();

    if (this.lastClock && this.room.onClock) {
      const c = this.lastClock;
      try { this.room.onClock(c.dayT, c.weather, c.aurora, c); }
      catch (e) { console.error('[engine] onClock:', e); }
    }
    this.roomAge = 0;
    this._resolveStaticCam(false);
    return this.room;
  }

  _teardownRoom() {
    for (const [, el] of this.hotspotEls) el.remove();
    this.hotspotEls.clear();
    this._marker = null; // scene dispose frees it; rebuilt lazily per room
    this._markerScene = null;
    if (this.scene) {
      this.scene.remove(this.remoteGroup);
      if (this.playerAvatar) this.scene.remove(this.playerAvatar.group);
      this.room?.dispose?.();
      disposeObject(this.scene);
      this.scene = null;
    }
    this.room = null;
  }

  // ---- ground helpers ------------------------------------------------------
  snapY(pos, room) {
    this.ray.set(_rayOrigin.set(pos.x, pos.y + 8, pos.z), DOWN);
    const hits = this.ray.intersectObjects(room.groundMeshes, false);
    if (!hits.length) return false;
    // highest surface within step range, else nearest: mirror of
    // WalkController.snapToGround (see the rationale there)
    let best = null;
    for (const h of hits) {
      if (h.point.y - pos.y <= 1.2 && (!best || h.point.y > best.point.y)) best = h;
    }
    if (!best) {
      for (const h of hits) {
        if (!best || Math.abs(h.point.y - pos.y) < Math.abs(best.point.y - pos.y)) best = h;
      }
    }
    pos.y = best.point.y;
    return true;
  }

  // ---- input ---------------------------------------------------------------
  /** 'right' | 'left'. Persisted; a no-op if already there. See WALK_KEY. */
  setWalkButton(mode) {
    const next = mode === 'left' ? 'left' : 'right';
    if (next === this.walkButton) return next;
    this.walkButton = next;
    this._walkHold = 0;
    try { localStorage.setItem(WALK_KEY, next); } catch { /* private mode: session only */ }
    this.game.events.emit('walk-button', next);
    return next;
  }

  /** Which mouse button walks for THIS event: 0 for touch/pen and for the
   *  classic setting, 2 otherwise. Rooms that drive their own movement (The
   *  Drift's swim) ask the same question, so it lives here. */
  walkButtonFor(e) {
    if (e?.pointerType && e.pointerType !== 'mouse') return 0; // a finger has one button
    return this.walkButton === 'left' ? 0 : 2;
  }

  _onPointer(e) {
    if (this.paused || !this.room) return;
    const walkBtn = this.walkButtonFor(e);
    const isWalk = e.button === walkBtn;
    const isInteract = e.button === 0; // left, or the one tap a finger has
    if (!isWalk && !isInteract) return;

    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);

    // Clicking ANOTHER capybara opens their profile. Your own capy is
    // deliberately not clickable (playtester call, 2026-08-07); your card is a
    // click away in the friends list instead. This is the LEFT button's job
    // now, so a right-click aimed past someone still walks you there.
    if (isInteract) {
      const avatarHits = this.ray.intersectObjects(this.remoteGroup.children, true);
      if (avatarHits.length) {
        let root = avatarHits[0].object;
        while (root.parent && root.parent !== this.remoteGroup && root.parent !== this.scene) root = root.parent;
        const remotes = this.game.net?.remotes;
        if (remotes) {
          for (const [id, r] of remotes) {
            if (r.avatar.group === root) {
              this.game.audio?.play?.('pop');
              this.game.events.emit('avatar-click', id);
              return;
            }
          }
        }
      }
    }

    if (!isWalk) { this._maybeWalkHint(); return; }
    // rooms that move the player themselves (The Drift's swim) own the walk
    if (this.controller?.enabled === false) return;
    this._walkHold = walkBtn === 2 ? 2 : 1; // MouseEvent.buttons: 1 = left, 2 = right
    this._walkNext = 0;
    const hits = this.ray.intersectObjects(this.room.groundMeshes, false);
    if (hits.length) this._walkTo(hits[0].point, true);
  }

  /** Held walk button: keep re-aiming while the pointer drags. Cheap enough at
   *  WALK_REPEAT_MS, and it stops the moment the button comes up (or the
   *  pointer comes back over the canvas without it). */
  _onPointerDrag(e) {
    if (!this._walkHold || this.paused || !this.room) return;
    if (e.buttons !== undefined && !(e.buttons & this._walkHold)) { this._walkHold = 0; return; }
    if (this.controller?.enabled === false) return;
    const now = performance.now();
    if (now < this._walkNext) return;
    this._walkNext = now + WALK_REPEAT_MS;
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hits = this.ray.intersectObjects(this.room.groundMeshes, false);
    if (hits.length) this._walkTo(hits[0].point, false);
  }

  /** Send the walker at a ground point. `announce` is the press itself (ring,
   *  step blip, drop out of a dance); a drag only moves the destination. */
  _walkTo(pt, announce) {
    // rooms with multiple storeys route the walk (stairs between floors):
    // routeTo returns the intermediate waypoints, or null for a direct walk
    const route = this.room.routeTo?.(this.playerAvatar.group.position, pt);
    if (Array.isArray(route) && route.length) this.controller.setPath([...route, pt]);
    else this.controller.setTarget(pt);
    if (!announce) {
      // a live drag drags the marker with it rather than re-blooming a new one
      if (this._marker?.visible && this._markerScene === this.scene) {
        this._marker.position.set(pt.x, pt.y + 0.05, pt.z);
      }
      return;
    }
    this._showClickMarker(pt);
    if (this.playerAvatar.state.anim === 'dance') this.playerAvatar.setAnim('idle');
    this.game.audio?.play?.('step');
  }

  /** A left click that landed on the floor and did nothing at all: say so, once
   *  per session, on the second one. Muscle memory deserves one sentence. */
  _maybeWalkHint() {
    if (_walkHintShown || this.walkButton === 'left') return;
    if (!this.ray.intersectObjects(this.room.groundMeshes, false).length) return;
    if (++this._leftOnGround < 2) return;
    _walkHintShown = true;
    this.game.toast?.('Right-click the ground to waddle over. Left click is for capybaras and props.', 5200);
  }

  /** Brief expanding ring where the player clicked, so the destination reads. */
  _showClickMarker(pt) {
    if (!this.scene) return;
    if (!this._marker || this._markerScene !== this.scene) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.26, 0.4, 24),
        new THREE.MeshBasicMaterial({
          color: 0xfff0b8, transparent: true, opacity: 0.9,
          depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 5;
      this._marker = mesh;
      this._markerScene = this.scene;
      this.scene.add(mesh);
    }
    this._marker.position.set(pt.x, pt.y + 0.05, pt.z);
    this._marker.scale.setScalar(1);
    this._marker.material.opacity = 0.9;
    this._marker.visible = true;
    this._markerT = 0;
  }

  // ---- world-anchored DOM overlays ----------------------------------------
  attachNameTag(obj, name, isBot = false, isSelf = false) {
    const el = document.createElement('div');
    el.className = `name-tag${isBot ? ' bot' : ''}${isSelf ? ' self' : ''}`;
    el.textContent = name;
    this.overlayRoot.appendChild(el);
    const entry = { obj, el, yOff: 2.35 };
    this.overlays.add(entry);
    return { remove: () => { this.overlays.delete(entry); el.remove(); } };
  }

  showBubble(obj, text, ms = 4200) {
    const el = document.createElement('div');
    el.className = 'chat-bubble';
    el.textContent = text;
    this.overlayRoot.appendChild(el);
    const entry = { obj, el, yOff: 2.75, until: performance.now() + ms };
    this.overlays.add(entry);
  }

  _updateOverlays() {
    const now = performance.now();
    const v = new THREE.Vector3();
    for (const o of [...this.overlays]) {
      if (o.until && now > o.until) { this.overlays.delete(o); o.el.remove(); continue; }
      if (!o.obj.parent) { o.el.style.display = 'none'; continue; }
      v.setFromMatrixPosition(o.obj.matrixWorld);
      v.y += o.yOff;
      v.project(this.camera);
      if (v.z > 1) { o.el.style.display = 'none'; continue; }
      o.el.style.display = '';
      o.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      o.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    }
  }

  // ---- hotspot prompts -----------------------------------------------------
  _updateHotspots() {
    if (!this.room || !this.playerAvatar) return;
    const p = this.playerAvatar.group.position;
    const v = new THREE.Vector3();
    // per-frame movement, for exit INTENT (see below)
    const mx = p.x - (this._hpx ?? p.x);
    const mz = p.z - (this._hpz ?? p.z);
    this._hpx = p.x;
    this._hpz = p.z;
    const mlen = Math.hypot(mx, mz);
    for (const h of this.room.hotspots) {
      const d = Math.hypot(p.x - h.position.x, p.z - h.position.z);
      const radius = h.radius || 2.5;
      const near = d <= radius;

      // Exits fire on INTENT: you are inside the band AND walking toward the
      // archway. This replaced the old "arm only after stepping clear" rule,
      // which blocked the one thing people actually do at an arrival spawn:
      // turn straight around and go back (playtester call, 2026-08-07).
      // Standing on the spawn does nothing; walking away does nothing; a few
      // frames of walking at the arch fires it, wherever you started.
      if (h.id?.startsWith('exit-') && !h.noAuto) {
        // proximity is 2D; a zone tagged with floorY only exists for players
        // at that height (the Den's floor-hop treads sit above/below lanes)
        if (h.floorY !== undefined && Math.abs(p.y - h.floorY) > 1.5) {
          const stale = this.hotspotEls.get(h);
          if (stale) { stale.remove(); this.hotspotEls.delete(h); }
          continue;
        }
        if (!h.__fired && this.roomAge > 0.8 && !this.game.activeMinigame) {
          let toward = false;
          if (mlen > 0.005 && d > 1e-3) {
            const dot = ((h.position.x - p.x) * mx + (h.position.z - p.z) * mz) / (d * mlen);
            toward = dot > 0.6;
          }
          h.__intent = near && toward ? (h.__intent || 0) + 1 : 0;
          if (h.__intent >= 6 || (near && toward && d <= radius * 0.45)) {
            h.__fired = true;
            // no whoosh here: switchRoom plays it with the iris wipe
            h.action(this.game);
            continue;
          }
        }
      }

      // Walk-through exits fire themselves, so they get no clickable button
      // (playtester call, 2026-08-07). Instead: a small non-interactive CUE
      // fades in while you approach, naming where the archway leads, so the
      // auto-travel never surprises anyone. Appears in an outer band before
      // the fire line, disappears if you veer off.
      if (h.id?.startsWith('exit-') && !h.noAuto) {
        const inBand = d <= radius + 2.2 && !h.__fired;
        let cue = this.hotspotEls.get(h);
        if (inBand && !cue) {
          cue = document.createElement('div');
          cue.className = 'exit-cue';
          cue.textContent = '→ ' + (h.label || '').replace(/^(go to|back to|back out to|down to|up to|take the)\s+/i, '');
          this.overlayRoot.appendChild(cue);
          this.hotspotEls.set(h, cue);
        } else if (!inBand && cue) {
          cue.remove();
          this.hotspotEls.delete(h);
        }
        if (cue) {
          v.copy(h.position); v.y += 2.1; v.project(this.camera);
          if (v.z > 1) { cue.style.display = 'none'; continue; }
          cue.style.display = '';
          cue.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
          cue.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
        }
        continue;
      }

      let el = this.hotspotEls.get(h);
      if (near && !el) {
        el = document.createElement('button');
        el.className = 'hotspot-prompt';
        el.textContent = h.label;
        el.onclick = (e) => { e.stopPropagation(); this.game.audio?.play?.('click'); h.action(this.game); };
        this.overlayRoot.appendChild(el);
        this.hotspotEls.set(h, el);
      } else if (!near && el) {
        el.remove();
        this.hotspotEls.delete(h);
      }
      if (el) {
        v.copy(h.position); v.y += 1.6; v.project(this.camera);
        // behind-the-camera projections mirror onto the screen: hide instead
        // (same guard _updateOverlays has always had)
        if (v.z > 1) { el.style.display = 'none'; continue; }
        el.style.display = '';
        el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
        el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
      }
    }
  }

  // ---- camera modes --------------------------------------------------------
  /**
   * Work out where the fixed "whole room" vantage sits. Rooms author their own
   * (`room.staticCamera = { position, lookAt }`); anything that does not gets a
   * computed fit of its walkable ground from the usual south-elevated 3/4 angle.
   */
  _resolveStaticCam(ease) {
    if (!this.room) return;
    // the editor pins the camera while dragging; rebuilds/resizes must not yank it
    if (this.camLock) return;
    const sc = this.room.staticCamera;
    if (sc?.position && sc?.lookAt) {
      const position = sc.position.clone();
      const lookAt = sc.lookAt.clone();
      // Rooms frame their vantage on a 16:9 window. A narrower one sees less
      // width at the same distance, so back off along the authored view line:
      // the angle and the centre of the shot survive, the sides stay in frame.
      const k = REF_ASPECT / Math.max(0.35, this.camera.aspect);
      if (k > 1.001) position.sub(lookAt).multiplyScalar(Math.min(k, 2.2)).add(lookAt);
      this._staticCam = { position, lookAt };
    } else {
      // no ground to fit (a room still building, or one with none): park on the
      // usual follow vantage rather than dumping the player inside the floor
      this._staticCam = this._fitGround() || {
        position: this.camTarget.clone().add(this.camCfg.offset),
        lookAt: this.camTarget.clone().setY(this.camTarget.y + this.camCfg.lookHeight),
      };
    }
    if (ease) this._beginCamEase();
  }

  /**
   * Pull the camera back along FALLBACK_DIR until every corner of the walkable
   * bounding box is inside the frustum. Exact per corner: with the camera at
   * `look + dir*d`, a corner q (relative to `look`) needs
   * d >= q.dir + |q.right| / tan(hfov/2) and the same for the vertical axis.
   */
  _fitGround() {
    _box.makeEmpty();
    for (const m of this.room.groundMeshes || []) {
      if (!m) continue;
      m.updateWorldMatrix(true, false);
      _sub.setFromObject(m);
      if (!_sub.isEmpty()) _box.union(_sub);
    }
    if (_box.isEmpty()) return null;

    const look = _box.getCenter(new THREE.Vector3());
    look.y = _box.min.y + Math.min(1.4, (_box.max.y - _box.min.y) * 0.5 + 0.6);

    const dir = FALLBACK_DIR;
    _right.set(0, 1, 0).cross(dir);                      // camera right = worldUp x dir
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.copy(dir).cross(_right).normalize();             // camera up = dir x right

    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanH = tanV * Math.max(0.35, this.camera.aspect);
    let d = 0;
    for (let i = 0; i < 8; i++) {
      _corner.set(
        i & 1 ? _box.max.x : _box.min.x,
        i & 2 ? _box.max.y : _box.min.y,
        i & 4 ? _box.max.z : _box.min.z,
      ).sub(look);
      const along = _corner.dot(dir);
      d = Math.max(d, along + Math.abs(_corner.dot(_right)) / tanH,
        along + Math.abs(_corner.dot(_up)) / tanV);
    }
    d = THREE.MathUtils.clamp(d * FALLBACK_MARGIN, 8, 240);
    return { position: look.clone().addScaledVector(dir, d), lookAt: look };
  }

  /** Remember where the camera is now so the next 0.5s glides from here. */
  _beginCamEase() {
    this._camFrom.copy(this.camera.position);
    this._lookFrom.copy(this._lookNow);
    this._camEase = CAM_EASE;
  }

  /** 'follow' | 'static'. Persisted; a no-op if already there. */
  setCameraMode(mode, { silent = false } = {}) {
    const next = mode === 'static' ? 'static' : 'follow';
    if (next === this.cameraMode) return this.cameraMode;
    this.cameraMode = next;
    try { localStorage.setItem('capycove-cam', next); } catch {}
    if (next === 'static') this._resolveStaticCam(true);
    else this._camEase = 0; // follow does its own soft lerp back to the player
    if (!silent) this.game.events.emit('camera-mode', next);
    return next;
  }

  /** Flip between follow and static camera; persisted. Returns the new mode. */
  toggleCameraMode() {
    const next = this.setCameraMode(this.cameraMode === 'static' ? 'follow' : 'static');
    this.game.audio?.play?.('click');
    return next;
  }

  // ---- main loop -----------------------------------------------------------
  start() {
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!this.paused && this.room && this.scene) {
      this.roomAge += dt;
      // rooms with their own movement (The Drift's swim) disable the walker
      if (this.controller.enabled !== false) this.controller.update(dt, this.room);

      // click marker: quick bloom-and-fade
      if (this._marker?.visible && this._markerScene === this.scene) {
        this._markerT += dt;
        const k = this._markerT / 0.55;
        if (k >= 1) {
          this._marker.visible = false;
        } else {
          this._marker.scale.setScalar(1 + k * 0.7);
          this._marker.material.opacity = 0.9 * (1 - k);
        }
      }
      this.playerAvatar.update(dt);
      this.room.update(dt, this.game);
      this.game.net?.update?.(dt);

      const p = this.playerAvatar.group.position;
      if (this.cameraMode === 'static' && this._staticCam) {
        // Fixed whole-room vantage. The only motion is the short arrival ease,
        // so nothing drifts while you walk around underneath it.
        const { position, lookAt } = this._staticCam;
        if (this._camEase > 0) {
          this._camEase = Math.max(0, this._camEase - dt);
          const u = 1 - this._camEase / CAM_EASE;
          const k = u * u * (3 - 2 * u); // smoothstep: no snap at either end
          this.camera.position.lerpVectors(this._camFrom, position, k);
          this._lookNow.lerpVectors(this._lookFrom, lookAt, k);
        } else {
          this.camera.position.copy(position);
          this._lookNow.copy(lookAt);
        }
        this.camera.lookAt(this._lookNow);
        this.camTarget.copy(p); // keep follow ready to take over from the player
      } else {
        // camera: soft-follow the player
        this.camTarget.lerp(p, Math.min(1, dt * 3.5));
        const desired = this.camTarget.clone().add(this.camCfg.offset);
        this.camera.position.lerp(desired, Math.min(1, dt * 3.5));
        this._lookNow.set(this.camTarget.x, this.camTarget.y + this.camCfg.lookHeight, this.camTarget.z);
        this.camera.lookAt(this._lookNow);
      }

      // post chain (bloom + grade); falls back to the plain render if the
      // chain could not build or a pass throws (postfx.render returns false)
      if (!postfx.render(dt)) this.renderer.render(this.scene, this.camera);
      this._updateOverlays();
      this._updateHotspots();
    }
  }
}
