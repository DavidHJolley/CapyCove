import * as THREE from 'three';
import { makeToon, makeGlow, canvasTexture } from '../core/materials.js';

/**
 * The Cove Courier newsstand: a small kiosk with a stack of papers, a striped
 * canopy and a hanging masthead board. Wave 14 (N-31, docs/research/liveops.md
 * section 5.6): the paper needed a place to be *picked up* rather than a second
 * label on the quest board, so the plaza's civic corner gets a stand of its own.
 *
 * This module is owned by agent 14B along with src/ui/courier.js. It exists as
 * its own file so that the plaza costs exactly three lines to wire (import,
 * one build call, one update tick) and nobody has to merge a 90-line prop into
 * a 2000-line room file.
 *
 * Public API is exactly:
 *   buildNewsstand(scene, game, room, opts) -> { group, hotspot, update, setUnread, dispose }
 *
 * The returned object is what the room stores on `this.anim.newsstand`; the
 * room's own update(dt) ticks it. Collider and hotspot are pushed onto
 * `room.obstacles` / `room.hotspots` here, and every event subscription goes
 * into `room._off` so the room's existing dispose loop takes them down.
 *
 * ART: chunky cozy toon per DESIGN.md section 1 - toon materials only, canvas
 * textures for anything with lettering, silhouette first. The whole prop tops
 * out at 2.92 including the bob of its marker, which keeps it clear of the
 * plaza bunting (low point 3.2) and out of the follow camera's sight line to a
 * player standing at it. 20 meshes, 9 of them batched into 4 instanced draws.
 *
 * Nothing runs at import time.
 */

// Plaza palette, copied deliberately rather than imported: this module must not
// depend on a room file (the room depends on it), and these are DESIGN.md's
// anchor colours, not plaza-local inventions.
const C = {
  wood: 0xb07a4a,
  woodDark: 0x7d5230,
  stone: 0xded2ba,
  stoneDark: 0xab9c81,
  cream: 0xfff1da,
  coral: 0xe8657a,
  gold: 0xf2b64a,
  iron: 0x4d5f57,
  paper: 0xfdf7e6,
};

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';

/**
 * Where the stand goes in the plaza, and why (the plaza's desire-line pass of
 * 2026-08-13 is binding: every collider here was checked against it).
 *
 * (-9.9, 1.8) is the west lawn pocket between the cobble rim and the mural,
 * on the walk from the plaza out to the artwork and the beach gate. Measured
 * clearances, collider radius 1.0:
 *   quest board (-4.4, 1.0) r1.1 ......... 5.5 apart, 3.4 clear
 *   NW lamp (-7.0, 3.4) r0.5 ............. 3.31 apart, 1.81 clear
 *   W lamp (-5.99, -2.2) r0.5 ............ 5.6 apart
 *   mural east post (-9.77, 5.97) r1.0 ... 4.17 apart, 2.17 clear
 *   beach gate planter (-13, 2.5) r0.7 ... 3.2 apart, 1.5 clear
 *   citizens' wander disc (0,5) r5 ....... 9.9 apart, never walked through
 *   plaza -> beach traverse (the z~0 line)  0.8 south of the collider
 *   mural -> fountain desire line ........ 2.51 away, 1.51 clear
 * It sits 10.06 from the plaza centre, i.e. just off the cobbles (r 9.2) on
 * the grass, which is where a stall belongs anyway.
 */
export const STAND = Object.freeze({ x: -9.9, z: 1.8, yaw: 1.75, r: 1.0 });

const _o = new THREE.Object3D();
function T(p, r, s) {
  _o.position.set(p[0], p[1], p[2]);
  if (r) _o.rotation.set(r[0], r[1], r[2]); else _o.rotation.set(0, 0, 0);
  if (Array.isArray(s)) _o.scale.set(s[0], s[1], s[2]);
  else _o.scale.setScalar(s === undefined ? 1 : s);
  _o.updateMatrix();
  return _o.matrix.clone();
}

function put(parent, geo, mat, x, y, z, opt = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (opt.rot) m.rotation.set(opt.rot[0], opt.rot[1], opt.rot[2]);
  if (opt.scale !== undefined) {
    if (Array.isArray(opt.scale)) m.scale.set(opt.scale[0], opt.scale[1], opt.scale[2]);
    else m.scale.setScalar(opt.scale);
  }
  m.castShadow = opt.cast !== false;
  m.receiveShadow = !!opt.recv;
  parent.add(m);
  return m;
}

function inst(parent, geo, mat, mats, cast = true, recv = false) {
  if (!mats || !mats.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, mats.length);
  for (let i = 0; i < mats.length; i++) im.setMatrixAt(i, mats[i]);
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = cast;
  im.receiveShadow = recv;
  parent.add(im);
  return im;
}

/** Unique material carrying a canvas map (never attach a map to a cached one). */
function toonMap(color, tex) {
  const m = makeToon(color, { unique: true });
  m.map = tex;
  return m;
}

// --------------------------------------------------------- canvas signs --

/** The hanging board: masthead lettering on cream, coral rules above/below. */
function mastheadTex() {
  const w = 512, h = 160;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = '#fff3dd';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#e8657a';
    ctx.lineWidth = 9;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = '#5b3a1e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 26px ${SERIF}`;
    ctx.fillText('THE COVE', w / 2, 52);
    ctx.font = `bold 62px ${SERIF}`;
    ctx.fillText('COURIER', w / 2, 104);
    ctx.strokeStyle = 'rgba(91,58,30,0.45)';
    ctx.lineWidth = 3;
    for (const y of [70, 138]) {
      ctx.beginPath();
      ctx.moveTo(70, y);
      ctx.lineTo(w - 70, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#a37a3d';
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillText('prints every friday  ~  free to every capy', w / 2, 149);
  });
}

/** A front page, seen from three metres: a headline bar and grey column rules. */
function frontPageTex() {
  const w = 256, h = 340;
  return canvasTexture(w, h, (ctx) => {
    ctx.fillStyle = '#fdf7e6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#5b3a1e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold 27px ${SERIF}`;
    ctx.fillText('COURIER', w / 2, 30);
    ctx.strokeStyle = 'rgba(91,58,30,0.5)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(16, 46); ctx.lineTo(w - 16, 46);
    ctx.stroke();
    // a big soft picture block: the mural crop the paper always leads with
    ctx.fillStyle = '#cfe8f6';
    ctx.fillRect(18, 58, w - 36, 84);
    ctx.fillStyle = '#8ec95c';
    ctx.fillRect(18, 118, w - 36, 24);
    ctx.fillStyle = '#f2b64a';
    ctx.beginPath();
    ctx.arc(196, 82, 16, 0, Math.PI * 2);
    ctx.fill();
    // headline + column rules
    ctx.fillStyle = 'rgba(45,36,23,0.82)';
    ctx.fillRect(18, 154, w - 70, 13);
    ctx.fillRect(18, 173, w - 120, 13);
    ctx.strokeStyle = 'rgba(45,36,23,0.24)';
    ctx.lineWidth = 4;
    for (let col = 0; col < 3; col++) {
      const x0 = 20 + col * 76;
      for (let i = 0; i < 14; i++) {
        const y = 202 + i * 9.5;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + (i === 13 ? 38 : 66), y);
        ctx.stroke();
      }
    }
  });
}

// ----------------------------------------------------------------- build --

/**
 * Build the kiosk and wire its hotspot.
 *
 * @param {THREE.Scene} scene
 * @param {object} game        the game facade (events, net, toast, audio)
 * @param {object} room        the owning room: obstacles, hotspots and _off
 * @param {object} [opts]      { x, z, yaw } to override STAND
 */
export function buildNewsstand(scene, game, room, opts = {}) {
  const x = Number.isFinite(opts.x) ? opts.x : STAND.x;
  const z = Number.isFinite(opts.z) ? opts.z : STAND.z;
  const yaw = Number.isFinite(opts.yaw) ? opts.yaw : STAND.yaw;

  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  scene.add(g);

  const wood = makeToon(C.wood);
  const woodD = makeToon(C.woodDark);
  const cream = makeToon(C.cream);
  const coral = makeToon(C.coral);

  // plinth: a flagstone pad so the stall does not float on the grass
  put(g, new THREE.BoxGeometry(2.35, 0.16, 1.45), makeToon(C.stone), 0, 0.08, 0, { recv: true, cast: false });
  put(g, new THREE.BoxGeometry(2.5, 0.06, 1.6), makeToon(C.stoneDark), 0, 0.03, 0, { recv: true, cast: false });

  // counter body + a cream front panel to catch the light
  put(g, new THREE.BoxGeometry(1.98, 0.92, 0.92), wood, 0, 0.62, 0, { recv: true });
  put(g, new THREE.BoxGeometry(1.82, 0.5, 0.06), cream, 0, 0.62, 0.47, { cast: false });
  // counter top, a little proud of the body so it reads as a shelf
  put(g, new THREE.BoxGeometry(2.16, 0.12, 1.06), woodD, 0, 1.14, 0, { recv: true });

  // four corner posts holding the canopy
  const postGeo = new THREE.BoxGeometry(0.11, 1.0, 0.11);
  inst(g, postGeo, woodD, [
    T([-0.94, 1.62, 0.44]), T([0.94, 1.62, 0.44]),
    T([-0.94, 1.62, -0.44]), T([0.94, 1.62, -0.44]),
  ], true, false);

  // canopy: one tilted slab, a cream underside, and a scalloped coral valance
  put(g, new THREE.BoxGeometry(2.5, 0.11, 1.34), coral, 0, 2.16, 0.06, { rot: [-0.16, 0, 0] });
  put(g, new THREE.BoxGeometry(2.32, 0.04, 1.18), cream, 0, 2.09, 0.06, { rot: [-0.16, 0, 0], cast: false });
  const scallop = new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10, 1, false, 0, Math.PI);
  const scallops = [];
  for (let i = 0; i < 7; i++) {
    scallops.push(T([-0.9 + i * 0.3, 1.99, 0.72], [Math.PI / 2, 0, Math.PI / 2]));
  }
  inst(g, scallop, coral, scallops, false, false);

  // the hanging masthead board, under the canopy front edge
  const boardMat = toonMap(0xffffff, mastheadTex());
  put(g, new THREE.PlaneGeometry(1.7, 0.53), boardMat, 0, 1.72, 0.5, { cast: false });
  put(g, new THREE.PlaneGeometry(1.7, 0.53), boardMat, 0, 1.72, 0.49,
    { rot: [0, Math.PI, 0], cast: false });
  inst(g, new THREE.CylinderGeometry(0.02, 0.02, 0.28, 6), makeToon(C.iron),
    [T([-0.72, 1.98, 0.5]), T([0.72, 1.98, 0.5])], false, false);

  // the papers themselves: a fanned stack on the counter, plus one propped up
  const paper = makeToon(C.paper);
  const sheet = new THREE.BoxGeometry(0.56, 0.03, 0.4);
  const stack = [];
  for (let i = 0; i < 7; i++) {
    stack.push(T([-0.48 + (i % 2) * 0.02, 1.22 + i * 0.031, -0.02 + (i % 3) * 0.015],
      [0, 0.06 * i - 0.18, 0]));
  }
  inst(g, sheet, paper, stack, true, false);
  const flutter = put(g, sheet, paper, -0.48, 1.45, -0.02, { rot: [0, 0.24, 0] });

  const pageMat = toonMap(0xffffff, frontPageTex());
  put(g, new THREE.PlaneGeometry(0.52, 0.68), pageMat, 0.56, 1.5, 0.24,
    { rot: [-0.24, 0.1, 0.05], cast: false });
  // a wire rack of spares hanging off the near end
  inst(g, new THREE.BoxGeometry(0.5, 0.36, 0.05), paper,
    [T([1.16, 0.86, 0.16], [0.1, 0.35, 0]), T([1.16, 0.52, 0.2], [0.1, 0.28, 0])], true, false);
  put(g, new THREE.TorusGeometry(0.22, 0.02, 5, 10, Math.PI), makeToon(C.iron),
    1.14, 0.98, 0.1, { rot: [Math.PI / 2, 0, 0], cast: false });

  // an ink pot and a bell, because a stall wants somebody to have just left it
  put(g, new THREE.CylinderGeometry(0.07, 0.08, 0.12, 8), makeToon(C.iron), 0.86, 1.26, -0.28);
  put(g, new THREE.SphereGeometry(0.11, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2),
    makeGlow(C.gold), -0.86, 1.26, -0.3, { rot: [Math.PI, 0, 0], cast: false });

  // The unread marker: the gold "there is something for you here" language the
  // plaza already speaks at the quest board (a bobbing octahedron), lit only
  // when there is an issue this account has not opened. It starts hidden: an
  // always-on beacon is a nag, and the cove does not nag.
  const marker = put(g, new THREE.OctahedronGeometry(0.24, 0), makeGlow(C.gold), 0, 2.48, 0.1,
    { cast: false });
  marker.scale.set(1, 1.45, 1);
  marker.visible = false;

  // ---- collider + hotspot --------------------------------------------------
  room?.obstacles?.push({ x, z, r: STAND.r, id: 'newsstand' });

  const hotspot = {
    id: 'courier',
    // 2.0 out from the reading face, derived from the stand's own yaw so the
    // prompt follows if the stall is ever moved (the quest board's lesson).
    position: new THREE.Vector3(x + Math.sin(yaw) * 2.0, 0, z + Math.cos(yaw) * 2.0),
    radius: 2.2,
    label: 'Read The Cove Courier',
    action: (gm) => import('../ui/courier.js')
      .then((m) => m.openCourier(gm))
      .catch(() => gm.toast('The Courier is still at the printers. Try again in a moment.')),
  };
  room?.hotspots?.push(hotspot);

  // ---- unread wiring -------------------------------------------------------
  // The reader module owns the unread rule (it is the thing that clears it), so
  // the stand asks it rather than duplicating the localStorage key. Loading it
  // on an idle callback keeps the reader out of the boot path: the plaza is the
  // default room, so a static import here would put the whole overlay in the
  // first paint.
  let offUnread = null;
  let disposed = false;
  const idle = typeof requestIdleCallback === 'function'
    ? requestIdleCallback(loadReader, { timeout: 6000 })
    : setTimeout(loadReader, 2500);
  let loaded = false;

  function loadReader() {
    if (loaded) return;
    loaded = true;
    import('../ui/courier.js').then((m) => {
      if (disposed) return;
      // the Map-adjacent HUD button lives in the reader module and mounts once
      m.mountCourierButton?.(game);
      offUnread = m.onCourierUnread?.((on) => setUnread(on)) || null;
      setUnread(!!m.courierUnread?.());
    }).catch(() => { /* no paper today; the stall is still a stall */ });
  }

  function setUnread(on) {
    marker.visible = !!on;
    hotspot.label = on ? 'The Cove Courier: new issue' : 'Read The Cove Courier';
  }

  // ---- tick ----------------------------------------------------------------
  let t = 0;
  const stand = {
    group: g,
    hotspot,
    setUnread,
    update(dt) {
      t += dt;
      // the loose top sheet lifts in the breeze; the marker bobs and turns
      flutter.rotation.x = Math.sin(t * 1.7) * 0.09 - 0.05;
      flutter.position.y = 1.45 + Math.max(0, Math.sin(t * 1.7)) * 0.03;
      if (marker.visible) {
        marker.rotation.y = t * 1.1;
        marker.position.y = 2.48 + Math.sin(t * 1.9) * 0.09;
      }
    },
    dispose() {
      disposed = true;
      if (offUnread) { try { offUnread(); } catch { /* already gone */ } offUnread = null; }
      if (typeof cancelIdleCallback === 'function' && typeof requestIdleCallback === 'function') {
        cancelIdleCallback(idle);
      } else clearTimeout(idle);
    },
  };
  // the room's dispose loop runs these, so the stand needs no room-side cleanup
  room?._off?.push(() => stand.dispose());
  return stand;
}
