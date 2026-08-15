import * as THREE from 'three';
import { makeToon, makeGlow, disposeObject } from '../core/materials.js';

/**
 * src/world/charm.js — the weekly charm, glinting somewhere in the scenery.
 *
 * Server side is server/charms.js (wave 13E, NEXT-AAA N-30): one small object
 * per real week, one claim per account, and the position is only ever sent to a
 * player standing in the right room. This module is the other half: it asks,
 * renders the thing, offers the prompt, and gets out of the way.
 *
 * WIRING — one line in src/core/engine.js, immediately after attachOverlay, in
 * BOTH switchRoom() and rebuildRoom():
 *
 *     attachCharm(this.room, this.scene, this.game, id);
 *
 * That is the whole engine change. Everything else is this module's problem,
 * following the src/world/overlay.js pattern exactly: it hooks the room
 * INSTANCE's update/dispose (never the prototype) and restores both, so the
 * engine needs no lifecycle knowledge. When the engine disposes the room, the
 * charm goes with it.
 *
 * The prompt is a plain room hotspot pushed onto `room.hotspots`, which is the
 * contract every room already uses (src/world/room.js), so the button, its
 * placement and its click handling are the engine's existing code path and not
 * a second one.
 *
 * DESIGN
 *  - The charm is a DELIGHT, never a chore. It never blocks a doorway, never
 *    steals a click from a game station (its hotspot radius is small and its
 *    label is a plain "Pick it up"), and once it is claimed it fades out and
 *    stops asking for anything.
 *  - Nothing here decides anything. Where the charm is, whether you may claim
 *    it, and what you get are all the server's answers; this file draws them.
 *  - Offline (no net client) it renders nothing at all, which is correct: there
 *    is no week and no account to hang a find on.
 */

// Only the outdoor rooms host the hunt (server/charms.js ROOMS is the
// authority; this is a cheap early-out so a den or a card table never sends a
// frame). An unknown room simply asks and is told nothing.
const SKIP_PREFIX = 'house:';

const BOB = 0.085;     // metres, peak-to-peak of the float
const SPIN = 0.55;     // radians/second
const GLINT_EVERY = 2.6; // seconds between sparkles
const PICK_RADIUS = 2.6; // hotspot radius: comfortably inside the server's 3.2

/**
 * Attach the weekly charm to a freshly built room.
 * @returns {CharmView|null} null when there is nothing to do (no net, a den).
 */
export function attachCharm(room, scene, game, roomId = room?.id) {
  if (!room || !scene || !game) return null;
  const rid = typeof roomId === 'string' ? roomId : room?.id;
  if (!rid || rid.startsWith(SKIP_PREFIX)) return null;
  if (!game.net?.connected || !game.events?.on) return null;

  if (room.__charm?.active) room.__charm.dispose(); // never wrap a wrap
  const view = new CharmView(room, scene, game, rid);
  room.__charm = view;
  return view;
}

class CharmView {
  constructor(room, scene, game, roomId) {
    this.room = room;
    this.scene = scene;
    this.game = game;
    this.roomId = roomId;
    this.active = true;
    this.group = null;
    this.core = null;
    this.halo = null;
    this.ring = null;
    this.mats = [];        // materials we made unique: ours to free
    this.hotspot = null;
    this.t = 0;
    this.glint = 0;
    this.claiming = 0;     // >0 while the little claim burst plays out
    this.data = null;      // the last {t:'charm'} frame that had a position
    this._prevUpdate = null;
    this._prevDispose = null;
    this._ownUpdate = false;
    this._ownDispose = false;
    this._ray = null;

    this._onCharm = (m) => this._charm(m);
    this._onFound = (m) => this._found(m);
    this._offCharm = game.events.on('charm', this._onCharm);
    this._offFound = game.events.on('charm-found', this._onFound);

    this._hook();
    this._ask();
  }

  // -- lifecycle -----------------------------------------------------------
  /** Hook the room INSTANCE, exactly as src/world/overlay.js does. */
  _hook() {
    const room = this.room;
    this._ownDispose = Object.prototype.hasOwnProperty.call(room, 'dispose');
    this._prevDispose = room.dispose?.bind(room) || null;
    room.dispose = () => {
      try { this._prevDispose?.(); } finally { this.dispose(); }
    };
    this._ownUpdate = Object.prototype.hasOwnProperty.call(room, 'update');
    this._prevUpdate = room.update?.bind(room) || (() => {});
    room.update = (dt, g) => {
      this._prevUpdate(dt, g);
      this.tick(dt);
    };
  }

  _unhook(key, prev, wasOwn) {
    if (!prev) return;
    if (wasOwn) this.room[key] = prev;
    else delete this.room[key];
  }

  _ask() {
    try { this.game.net.send({ t: 'charm' }); } catch { /* a closing socket: fine */ }
  }

  // -- server frames -------------------------------------------------------
  _charm(m) {
    if (!this.active || !m) return;
    // A placement moved under us: drop what we have and ask again.
    if (m.refresh) { this._remove(); this._ask(); return; }
    // Not for this room, or already found: nothing should be glinting.
    if (!m.here || m.room !== this.roomId || m.claimed) {
      if (m.ok === true && this.group) this._celebrate(); // this player just got it
      else this._remove();
      return;
    }
    this.data = m;
    this._build(m);
  }

  _found(m) {
    if (!this.active || !m) return;
    // Somebody else found it: the charm stays for everyone who has not (one
    // claim per account, not one per week per world). Only OUR find clears it,
    // and that arrives on the 'charm' frame above. The HUD owns the party.
  }

  // -- the object ----------------------------------------------------------
  _build(m) {
    if (this.group) return; // already standing
    const color = Number.isFinite(m.color) ? m.color : 0xf2d06b;
    const g = new THREE.Group();
    const y = this._groundY(m);
    g.position.set(m.x, y + 0.42, m.z);

    // The charm itself. Shapes are hints from the catalogue; anything unknown
    // falls back to the bauble, so adding a charm server-side never needs a
    // client release.
    const geo = shapeFor(m.shape);
    const mat = makeToon(color, { unique: true, emissive: color, emissiveIntensity: 0.35 });
    this.mats.push(mat);
    const core = new THREE.Mesh(geo, mat);
    core.castShadow = false;
    g.add(core);
    this.core = core;

    // A soft halo. depthWrite off and unlit, like every other glow in the game,
    // so it reads at distance without ever z-fighting the scenery it sits on.
    const hMat = makeGlow(color, { unique: true });
    hMat.transparent = true;
    hMat.opacity = 0.22;
    hMat.depthWrite = false;
    this.mats.push(hMat);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), hMat);
    g.add(halo);
    this.halo = halo;

    // A faint ring on the ground so the eye catches it from across the room
    // even when the charm itself is behind a fern.
    const rMat = makeGlow(color, { unique: true });
    rMat.transparent = true;
    rMat.opacity = 0.16;
    rMat.depthWrite = false;
    this.mats.push(rMat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.78, 20), rMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.4;
    g.add(ring);
    this.ring = ring;

    this.scene.add(g);
    this.group = g;

    // The prompt: an ordinary room hotspot, so the engine draws and places the
    // button with the same code every door and game station uses.
    this.hotspot = {
      id: 'charm-pick',
      position: new THREE.Vector3(m.x, y, m.z),
      radius: PICK_RADIUS,
      label: 'Pick it up',
      action: () => this._claim(),
    };
    if (Array.isArray(this.room.hotspots)) this.room.hotspots.push(this.hotspot);
  }

  /** Where the floor is under the charm. A spot that carries its own y (The
   *  Drift's water column) is taken at its word. */
  _groundY(m) {
    if (Number.isFinite(m.y)) return m.y;
    const meshes = this.room?.groundMeshes;
    if (!Array.isArray(meshes) || !meshes.length) return 0;
    if (!this._ray) this._ray = new THREE.Raycaster();
    this._ray.set(new THREE.Vector3(m.x, 40, m.z), new THREE.Vector3(0, -1, 0));
    const hit = this._ray.intersectObjects(meshes, true)[0];
    return hit ? hit.point.y : 0;
  }

  _claim() {
    if (!this.active) return;
    try { this.game.net.send({ t: 'charm-claim' }); } catch { /* fine */ }
  }

  /** Our own find: a short burst, then it is gone. */
  _celebrate() {
    if (!this.group) return;
    this.claiming = 0.75;
    this._disarm();
  }

  /** Stop the hotspot asking for clicks without yanking it out of the array
   *  mid-iteration. NOT radius 0: the engine reads `h.radius || 2.5`, so a 0
   *  falls back to the default and the button stays live. -1 is truthy and no
   *  distance is ever below it, so the prompt dies on the very next frame. */
  _disarm() {
    if (this.hotspot) {
      this.hotspot.radius = -1;
      this.hotspot.label = '';
      this.hotspot.action = () => {};
    }
  }

  _remove() {
    this._disarm();
    if (this.hotspot && Array.isArray(this.room?.hotspots)) {
      const i = this.room.hotspots.indexOf(this.hotspot);
      if (i >= 0) this.room.hotspots.splice(i, 1);
    }
    this.hotspot = null;
    if (this.group) {
      this.scene.remove(this.group);
      disposeObject(this.group);
      this.group = null;
      this.core = null;
      this.halo = null;
      this.ring = null;
      this.mats.length = 0; // disposeObject freed them (all unique, none shared)
    }
    this.claiming = 0;
    this.data = null;
  }

  // -- per frame -----------------------------------------------------------
  tick(dt) {
    if (!this.active || !this.group) return;
    const d = Math.min(0.1, Math.max(0, dt || 0)); // a tab that slept must not jump
    this.t += d;

    if (this.claiming > 0) {
      // Up, out and away: 0.75s of "you got it" and then nothing.
      this.claiming -= d;
      const k = Math.max(0, this.claiming / 0.75);
      const s = 1 + (1 - k) * 1.6;
      this.group.position.y += d * 1.5;
      this.group.scale.setScalar(s);
      for (const m of this.mats) if (m.transparent) m.opacity = Math.max(0, m.opacity * (1 - d * 3.2));
      if (this.core) this.core.rotation.y += d * 6;
      if (this.claiming <= 0) this._remove();
      return;
    }

    if (this.core) {
      this.core.rotation.y += d * SPIN;
      this.core.position.y = Math.sin(this.t * 1.6) * BOB;
    }
    // The glint: a slow breath on the halo with a brief sparkle on top, so the
    // charm advertises itself without ever becoming a flashing light.
    this.glint += d;
    const breath = 0.18 + 0.08 * Math.sin(this.t * 1.9);
    let spark = 0;
    if (this.glint > GLINT_EVERY) {
      const into = this.glint - GLINT_EVERY;
      spark = Math.max(0, 1 - into / 0.45);
      if (into > 0.45) this.glint = 0;
    }
    if (this.halo) {
      this.halo.material.opacity = Math.min(0.75, breath + spark * 0.5);
      this.halo.scale.setScalar(1 + spark * 0.45);
    }
    if (this.ring) this.ring.material.opacity = 0.12 + spark * 0.2;
  }

  dispose() {
    if (!this.active) return;
    this.active = false;
    try { this._offCharm?.(); } catch { /* ignore */ }
    try { this._offFound?.(); } catch { /* ignore */ }
    this._offCharm = null;
    this._offFound = null;
    this._remove();
    this._unhook('update', this._prevUpdate, this._ownUpdate);
    this._unhook('dispose', this._prevDispose, this._ownDispose);
    this._prevUpdate = null;
    this._prevDispose = null;
    this._ray = null;
    if (this.room?.__charm === this) this.room.__charm = null;
  }
}

/**
 * Geometry per catalogue `shape`. Small on purpose: a charm is a trinket you
 * have to notice, not a landmark. Every one of these is a handful of triangles,
 * which is the right budget for something drawn once per room.
 */
function shapeFor(shape) {
  switch (shape) {
    case 'disc': return new THREE.CylinderGeometry(0.15, 0.15, 0.04, 14);
    case 'cone': return new THREE.ConeGeometry(0.11, 0.26, 8);
    case 'stick': return new THREE.CylinderGeometry(0.035, 0.035, 0.3, 7);
    case 'shard': return new THREE.OctahedronGeometry(0.16, 0);
    case 'star': return new THREE.DodecahedronGeometry(0.15, 0);
    case 'spiral': return new THREE.TorusKnotGeometry(0.11, 0.035, 42, 6);
    case 'key': return new THREE.TorusGeometry(0.11, 0.03, 6, 14);
    case 'soft': return new THREE.SphereGeometry(0.15, 10, 7);
    case 'lantern': return new THREE.CylinderGeometry(0.1, 0.12, 0.2, 8);
    case 'bead':
    default: return new THREE.IcosahedronGeometry(0.15, 0);
  }
}

export default { attachCharm };
