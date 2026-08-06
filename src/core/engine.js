import * as THREE from 'three';
import { disposeObject } from './materials.js';
import { createAvatar } from '../player/avatar.js';
import { WalkController } from '../player/controller.js';

const DOWN = new THREE.Vector3(0, -1, 0);

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
    this.playerAvatar = null;
    this.controller = null;
    this.remoteGroup = new THREE.Group();
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
    this.camTarget = new THREE.Vector3();

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
    const RoomClass = this.rooms[id];
    if (!RoomClass) { console.error(`[engine] unknown room '${id}'`); return; }

    const fade = document.getElementById('fade');
    fade.classList.add('on');

    setTimeout(() => {
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

      this.game.audio?.setRoom?.(id);
      fade.classList.remove('on');
    }, 220);
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
    this.ray.set(new THREE.Vector3(pos.x, pos.y + 8, pos.z), DOWN);
    const hits = this.ray.intersectObjects(room.groundMeshes, false);
    if (hits.length) pos.y = hits[0].point.y;
    return !!hits.length;
  }

  // ---- input ---------------------------------------------------------------
  _onPointer(e) {
    if (this.paused || !this.room || e.button !== 0) return;
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
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
      const near = d <= (h.radius || 2.5);
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

  // ---- main loop -----------------------------------------------------------
  start() {
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!this.paused && this.room && this.scene) {
      this.controller.update(dt, this.room);
      this.playerAvatar.update(dt);
      this.room.update(dt, this.game);
      this.game.net?.update?.(dt);

      // camera: soft-follow the player
      const p = this.playerAvatar.group.position;
      this.camTarget.lerp(p, Math.min(1, dt * 3.5));
      const desired = this.camTarget.clone().add(this.camCfg.offset);
      this.camera.position.lerp(desired, Math.min(1, dt * 3.5));
      this.camera.lookAt(this.camTarget.x, this.camTarget.y + this.camCfg.lookHeight, this.camTarget.z);

      this.renderer.render(this.scene, this.camera);
      this._updateOverlays();
      this._updateHotspots();
    }
  }
}
