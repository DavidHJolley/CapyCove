import * as THREE from 'three';
import { disposeObject } from './materials.js';
import { createAvatar } from '../player/avatar.js';
import { WalkController } from '../player/controller.js';

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
    this.camDefault = { offset: new THREE.Vector3(0, 14, 19), lookHeight: 1 };
    this.camCfg = { offset: this.camDefault.offset, lookHeight: this.camDefault.lookHeight };
    this.camTarget = new THREE.Vector3();
    // 'follow' = soft-follow the player; 'static' = fixed whole-room vantage
    // (per-room via room.staticCamera, engine fallback otherwise)
    this.cameraMode = (() => {
      try { return localStorage.getItem('capycove-cam') === 'static' ? 'static' : 'follow'; } catch { return 'follow'; }
    })();
    this._staticCam = null;
    this._camEase = 0; // seconds left in the entry/arrival ease
    this._camFrom = new THREE.Vector3();
    this._lookFrom = new THREE.Vector3();
    this._lookNow = new THREE.Vector3();

    this.overlayRoot = document.getElementById('overlay-root');

    addEventListener('resize', () => this._resize());
    this._resize();

    canvas.addEventListener('pointerdown', (e) => this._onPointer(e));
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
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
    fade.classList.add('on');

    this._switchTimer = setTimeout(async () => {
      this._switchTimer = null;
      let RoomClass;
      try {
        RoomClass = await pending;
      } catch (e) {
        console.error(`[engine] failed to load room '${id}':`, e);
        if (seq === this._switchSeq) { this._pendingRoom = null; fade.classList.remove('on'); }
        return;
      }
      if (seq !== this._switchSeq) return; // superseded while loading
      this._pendingRoom = null;

      this._teardownRoom();
      this.room = new RoomClass();
      this.scene = new THREE.Scene();
      this.room.build(this.scene, this.game);
      if (!this.room.groundMeshes?.length) console.warn(`[engine] room '${id}' has no groundMeshes`);
      this.scene.add(this.remoteGroup);

      const spawn = this.room.getSpawn(fromId);
      this.playerAvatar.group.position.copy(spawn);
      this.playerAvatar.setAnim('idle');
      this.controller.stop();
      this.snapY(this.playerAvatar.group.position, this.room);
      this.scene.add(this.playerAvatar.group);

      const hint = this.room.cameraHint;
      this.camCfg = {
        offset: hint?.offset || this.camDefault.offset,
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
      fade.classList.remove('on');
    }, 220);
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

  _teardownRoom() {
    for (const [, el] of this.hotspotEls) el.remove();
    this.hotspotEls.clear();
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
  _onPointer(e) {
    if (this.paused || !this.room || e.button !== 0) return;
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);

    // clicking another capybara opens their profile instead of walking
    const avatarHits = this.ray.intersectObjects(this.remoteGroup.children, true);
    if (avatarHits.length) {
      let root = avatarHits[0].object;
      while (root.parent && root.parent !== this.remoteGroup) root = root.parent;
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

    const hits = this.ray.intersectObjects(this.room.groundMeshes, false);
    if (hits.length) {
      this.controller.setTarget(hits[0].point);
      if (this.playerAvatar.state.anim === 'dance') this.playerAvatar.setAnim('idle');
      this.game.audio?.play?.('step');
    }
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
    for (const h of this.room.hotspots) {
      const d = Math.hypot(p.x - h.position.x, p.z - h.position.z);
      const radius = h.radius || 2.5;
      const near = d <= radius;

      // exits fire by walking in, no click needed. Armed only once the player
      // has been clearly outside the radius (prevents an instant bounce-back
      // when arriving on a spawn near the return exit).
      if (h.id?.startsWith('exit-') && !h.noAuto) {
        if (!h.__armed) {
          if (this.roomAge > 0.4 && d > radius + 0.75) h.__armed = true;
        } else if (!h.__fired && d <= radius * 0.8 && this.roomAge > 1.2 && !this.game.activeMinigame) {
          h.__fired = true;
          this.game.audio?.play?.('whoosh');
          h.action(this.game);
          continue;
        }
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

      this.renderer.render(this.scene, this.camera);
      this._updateOverlays();
      this._updateHotspots();
    }
  }
}
