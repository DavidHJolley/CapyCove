import * as THREE from 'three';
import { disposeObject } from '../core/materials.js';
import { WalkController } from '../player/controller.js';
import { BOT_ZONES, ROOM_IDS, MINIGAMES } from '../../shared/constants.js';
import {
  PROPS, PROP_IDS, PROP_GROUPS, LAYOUT_CAPS,
  buildProp, propCollider, groundY,
  activeOps, setDraft, clearDraft, setDoc, docFor, revOf, evict, ensure,
  validateOps, normalizeOps, diffOps, describeDiff, opKey, isLayoutRoom, lastReport,
} from '../world/layout.js';

/**
 * The level editor (Ctrl+E), v2. Gated on the `editor` capability
 * (server/admin.js CAPS); the server re-authorises every write frame, so this
 * gate is UX, not security.
 *
 * Three tabs, because a room is built three ways:
 *
 *  BUILD    the layout DOCUMENT. A palette spawns catalog props, a gizmo moves
 *           them, colliders and hotspots are drawn and dragged, and the walk
 *           check raycasts the room's real groundMeshes and walks the real
 *           WalkController between every spawn and hotspot. Everything here is
 *           an OP in a draft that publishes to every player.
 *  NUMBERS  the old handles mode: a room publishes its layout numbers, each
 *           becomes a pin, dropping one rebuilds the room through the real
 *           build path so the sign, chairs, prompt zones and obstacle circles
 *           derived from that number all follow. Now PERSISTENT: a dropped pin
 *           writes a `handle` op.
 *  INSPECT  the old free mode. Raycast-pick anything, Tab drills to a part, an
 *           InstancedMesh instance, or one welded piece of a merged mesh found
 *           by union-find over the geometry. Session-only by design: its
 *           identity key is a child-index path into rooms that name nothing, so
 *           persisting it would silently aim at the wrong prop after any
 *           refactor. It prints numbers you paste into the room file.
 *
 * Selection in BUILD is a set of OP IDS, not of Object3Ds, which is why it
 * survives a rebuild. Undo is a stack over the whole draft document, so a
 * rebuild never clears it (the old editor threw the undo stack away on every
 * pin commit).
 *
 * Wire frames. These are `server/layouts.js`'s vocabulary, which is the one
 * that shipped (it renamed the spec's open/draft/reset):
 *   out {t:'layout-get',     room}                 open a room, get everything
 *       {t:'layout-save',    room, ops, base}      save MY draft (1.5s debounce)
 *       {t:'layout-publish', room, ops, base, rev} publish; `rev` is the
 *                                                  published revision I last
 *                                                  saw, so a second admin's
 *                                                  publish cannot be clobbered
 *       {t:'layout-discard', room}                 drop my draft
 *       {t:'layout-revert',  room, toRev}          republish out of history
 *   in  {t:'layout-doc', room, rev, base, ops, draft, history, others, limits}
 *       {t:'layout-ack', room, ok, what, rev?, msg?, code?}
 *       {t:'layout-rev', room, rev, by}            island-wide
 * All three arrive as game.events, re-emitted by src/net/client.js.
 *
 * Applying a document is `src/world/overlay.js`'s job (attachOverlay, wired by
 * the engine). This file prefers it when it is present and falls back to
 * src/world/layout.js's own apply pass when it is not, so the editor works
 * either side of that wiring.
 */

const STYLE_ID = 'cove-ed-styles';
const CSS = `
.cove-ed {
  position: absolute; top: 56px; left: 14px; width: 356px; z-index: 55;
  background: rgba(28, 24, 18, 0.95); color: #fff6e3; border-radius: 16px;
  padding: 12px 14px; font-family: var(--font); font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto;
  max-height: calc(100vh - 96px); display: flex; flex-direction: column;
}
.cove-ed h3 { font-size: 14px; margin: 0 0 2px; color: #f2b64a; letter-spacing: .03em;
  display: flex; align-items: baseline; gap: 6px; }
.cove-ed h3 .ed-rev { margin-left: auto; font-size: 10.5px; color: #b8a888; font-weight: 600; }
.cove-ed .ed-sub { color: #b8a888; font-size: 11.5px; margin-bottom: 8px; }
.cove-ed .ed-sub b { color: #f2b64a; }
.cove-ed .ed-warn { color: #ffb4a0; }
.cove-ed .ed-tabs { display: flex; gap: 4px; background: rgba(255,255,255,.07); padding: 4px; border-radius: 999px; margin-bottom: 8px; }
.cove-ed .ed-tab { flex: 1; border: 0; background: transparent; color: #b8a888; font-family: var(--font);
  font-weight: 800; font-size: 12px; padding: 6px 8px; border-radius: 999px; cursor: pointer; }
.cove-ed .ed-tab.on { background: #f2b64a; color: #2d2417; }
.cove-ed .ed-body { overflow-y: auto; flex: 1; min-height: 60px; }
.cove-ed .ed-keys { color: #b8a888; font-size: 10.5px; line-height: 1.5; margin-bottom: 8px; }
.cove-ed .ed-keys b { color: #fff6e3; font-weight: 700; }
.cove-ed .ed-list { max-height: 128px; overflow-y: auto; margin-bottom: 8px;
  border-radius: 10px; background: rgba(255,255,255,.05); padding: 4px; }
.cove-ed .ed-row { display: flex; align-items: center; gap: 7px; padding: 4px 7px; border-radius: 8px;
  cursor: pointer; font-size: 11.5px; white-space: nowrap; }
.cove-ed .ed-row:hover { background: rgba(255,255,255,.09); }
.cove-ed .ed-row.on { background: rgba(242,182,74,.22); font-weight: 700; }
.cove-ed .ed-row .ed-x { opacity: .5; padding: 0 3px; }
.cove-ed .ed-row .ed-x:hover { opacity: 1; color: #ffb4a0; }
.cove-ed .ed-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.cove-ed .ed-xz { margin-left: auto; color: #b8a888; font-family: ui-monospace, Consolas, monospace; }
.cove-ed .ed-sel { background: rgba(255,255,255,.07); border-radius: 10px; padding: 7px 10px;
  margin-bottom: 8px; font-weight: 700; min-height: 28px; font-size: 11.5px; }
.cove-ed .ed-sel span { color: #7ee0ff; font-weight: 400; font-family: ui-monospace, Consolas, monospace; }
.cove-ed .ed-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; max-height: 214px;
  overflow-y: auto; margin-bottom: 8px; }
.cove-ed .ed-card { display: flex; align-items: center; gap: 6px; padding: 5px 7px; border-radius: 9px;
  background: rgba(255,255,255,.06); cursor: pointer; font-size: 11px; text-align: left;
  border: 1px solid transparent; color: #fff6e3; font-family: var(--font); overflow: hidden; }
.cove-ed .ed-card:hover { background: rgba(255,255,255,.12); }
.cove-ed .ed-card.on { border-color: #f2b64a; background: rgba(242,182,74,.2); font-weight: 700; }
.cove-ed .ed-card img, .cove-ed .ed-card .ed-chip { width: 30px; height: 30px; border-radius: 7px; flex: none;
  background: rgba(0,0,0,.25); object-fit: contain; }
.cove-ed .ed-card b { display: block; font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
.cove-ed .ed-card i { font-style: normal; color: #9c8f76; font-size: 10px; }
.cove-ed input.ed-in, .cove-ed select.ed-in { width: 100%; border: 0; border-radius: 9px; padding: 6px 9px;
  font-family: var(--font); font-size: 11.5px; background: rgba(255,255,255,.1); color: #fff6e3;
  margin-bottom: 7px; }
.cove-ed .ed-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.cove-ed .ed-pill { border: 0; border-radius: 999px; padding: 4px 9px; cursor: pointer; font-size: 10.5px;
  font-family: var(--font); font-weight: 700; background: rgba(255,255,255,.1); color: #cbbb9c; }
.cove-ed .ed-pill.on { background: #7ee0ff; color: #16303a; }
.cove-ed textarea { width: 100%; height: 74px; resize: vertical; border: 0; border-radius: 10px;
  padding: 8px 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  background: #12100c; color: #cfe8b0; line-height: 1.45; }
.cove-ed .ed-btns { display: flex; gap: 6px; margin-top: 8px; flex: none; }
.cove-ed button.ed-b { flex: 1; border: 0; border-radius: 999px; padding: 7px 8px; cursor: pointer;
  font-family: var(--font); font-weight: 800; font-size: 12px; background: #f2b64a; color: #2d2417; }
.cove-ed button.ghost { background: rgba(255,255,255,.14); color: #fff6e3; }
.cove-ed button.ed-b:hover { filter: brightness(1.08); }
.cove-ed button.ed-b:disabled { opacity: .4; cursor: default; filter: none; }
.cove-ed-marquee { position: absolute; z-index: 54; border: 2px dashed #f2b64a;
  background: rgba(242,182,74,.12); pointer-events: none; }
.cove-ed-hint { position: absolute; left: 50%; bottom: 88px; transform: translateX(-50%); z-index: 55;
  background: rgba(28,24,18,.92); color: #fff6e3; padding: 7px 14px; border-radius: 999px;
  font-family: var(--font); font-size: 12px; pointer-events: none; }
`;

let open = false;
let teardown = null;
/** Catalog thumbnails survive a close/open cycle; rendering 28 costs a frame. */
const thumbs = new Map();

const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(1)}deg`;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _yaw = (rad) => new THREE.Quaternion().setFromAxisAngle(_up, rad);

/** Room-sized geometry is scenery, not furniture: never pick it (Inspect tab). */
const HUGE = 15;
const GRIDS = [0, 0.25, 0.5, 1];
const ZONE_COLOR = { exit: 0x7ee0ff, game: 0xf2b64a, sign: 0x7ac74f };

const hex6 = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
/** src/world/overlay.js stamps `layoutId`; the layout.js fallback stamps `opId`. */
const propIdOf = (o) => o?.userData?.opId || o?.userData?.layoutId || '';
/** Same story for the circle a prop or a collider op contributes. */
const obsIdOf = (c) => c?.opId || c?.id || '';
const mint = (prefix) => `${prefix}_${Math.random().toString(16).slice(2, 8)}`;

function pathOf(obj, scene) {
  const parts = [];
  let o = obj;
  while (o && o !== scene) { parts.unshift(o.parent ? o.parent.children.indexOf(o) : 0); o = o.parent; }
  return parts.join('/');
}

const labelOf = (obj, instanceId) => {
  const base = obj.name || (obj.isInstancedMesh ? 'instances' : obj.type);
  return instanceId == null ? base : `${base} #${instanceId}`;
};

export function toggleEditor(game) {
  if (open) { teardown?.(); return false; }
  if (!game.can('editor')) { game.toast('The layout editor is staff only'); return false; }
  openEditor(game);
  return true;
}

// ---------------------------------------------------------------------------

/**
 * The read/apply side, which has two implementations in this wave:
 * src/world/overlay.js (the engine's attachOverlay pass) and the fallback in
 * src/world/layout.js. Loaded dynamically so a missing or renamed overlay is a
 * degraded editor, never a broken import.
 */
let OV = null;
let ovTried = false;

async function loadOverlay() {
  if (ovTried) return OV;
  ovTried = true;
  try {
    const m = await import('../world/overlay.js');
    if (typeof m.primeLayout === 'function' && typeof m.evictLayout === 'function') {
      OV = m;
      m.registerPropBuilder?.(buildProp);   // the catalog lives on this side
    }
  } catch { /* not in this build: the layout.js fallback covers it */ }
  return OV;
}

function openEditor(game) {
  const engine = game.engine;
  if (!engine?.scene) { game.toast('Nothing to edit yet'); return; }
  let alive = true;

  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const root = document.getElementById('overlay-root');
  const el = document.createElement('div');
  el.className = 'cove-ed';
  el.innerHTML = `
    <h3>Level editor <span class="ed-rev" id="ed-rev"></span></h3>
    <div class="ed-sub" id="ed-room"></div>
    <div class="ed-tabs">
      <button class="ed-tab on" id="ed-t-build">Build</button>
      <button class="ed-tab" id="ed-t-numbers">Numbers</button>
      <button class="ed-tab" id="ed-t-inspect">Inspect</button>
    </div>
    <div class="ed-body" id="ed-body"></div>
    <div class="ed-btns">
      <button class="ed-b" id="ed-publish">Publish</button>
      <button class="ed-b ghost" id="ed-preview" title="P">Preview</button>
      <button class="ed-b ghost" id="ed-walk" title="V">Walk</button>
      <button class="ed-b ghost" id="ed-close">Close</button>
    </div>`;
  root.appendChild(el);

  const $ = (id) => el.querySelector(`#${id}`);
  const body = $('ed-body');

  // ---- state ---------------------------------------------------------------
  let tab = 'build';
  let room = null;
  let ops = [];                     // THE DRAFT: the document being edited
  let published = [];               // last known published ops, for the diff
  let history = [];                 // published revisions available to revert to
  let lock = null;                  // {by, until} from the server
  let draftRev = 0;                 // the server's rev for MY saved draft
  let orphans = [];
  let baseSig = '';
  let dirty = false;
  let saveTimer = null;

  const undoStack = [];
  const redoStack = [];
  let pending = null;               // an open command (a drag in progress)

  const sel = new Set();            // op ids (and 'tag:<id>' for tagged objects)
  let armed = null;                 // catalog id being placed
  let ghost = null;
  let zonesOn = false;
  let preview = false;
  let snapGrid = 2;                 // index into GRIDS
  let snapAngle = Math.PI / 12;     // 15 degrees
  let search = '';
  let group = PROP_GROUPS[0].id;

  let gizmos = [];                  // selection boxes + zone rings (scene objects)
  let walkMesh = null;
  let walkPending = false;

  // Numbers tab
  let pins = [];
  let pin = null;
  let pinDragStart = null;
  let pinShift = false;

  // Inspect tab
  let selection = [];
  let boxes = [];
  const edits = new Map();
  const inspectUndo = [];

  let dragging = false;
  let dragKind = null;              // 'props' | 'zone-move' | 'zone-size' | 'pin' | 'inspect'
  let dragOp = null;
  let dragStart = null;
  let marquee = null;
  let lastPick = null;
  let hint = null;

  const pinGeo = new THREE.ConeGeometry(0.16, 0.5, 10);
  const knobGeo = new THREE.SphereGeometry(0.1, 10, 8);

  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const grab = new THREE.Vector3();
  const canvas = engine.canvas;
  const ndc = (e) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  const KEYS = {
    build: '<b>Click a card</b> then click the floor to place - <b>drag</b> to move, <b>[ ]</b> turn, <b>- =</b> size<br>'
      + '<b>Shift-click</b> adds, <b>Alt-click</b> cycles behind, <b>drag empty floor</b> box-selects, <b>Ctrl+D</b> copies, <b>Del</b> removes<br>'
      + '<b>G</b> grid snap - <b>Z</b> zones - <b>A</b> collider here - <b>V</b> walk check - <b>P</b> preview - <b>Ctrl+Z/Y</b> undo<br>'
      + '<b>1-9</b> camera bookmarks (<b>Shift</b> to set) - <b>Shift+S</b> save this shot as the room camera - <b>Shift+P</b> spawn views',
    numbers: '<b>Drag a pin</b> to move that number - <b>Shift-drag</b> the gold prop pin moves a whole station<br><b>Arrows</b> nudge (Shift = 0.5), <b>[ ]</b> turn the prop, <b>Ctrl+Z</b> undo. These are saved with the layout.',
    inspect: '<b>Click</b> a prop, <b>drag</b> it - <b>drag empty space</b> box-selects - <b>Alt+click</b> for what is behind<br><b>Tab</b> drills in (part, instance, welded piece) - <b>arrows</b> nudge, <b>PgUp/Dn</b> height, <b>[ ]</b> rotate, <b>- =</b> resize, <b>H</b> hide<br>Session-only: read the numbers out and paste them into the room file.',
  };

  // ---- editor camera -------------------------------------------------------
  const cam = { target: new THREE.Vector3(), dist: 18, yaw: 0, pitch: 0.9 };
  const savedMode = engine.cameraMode;
  let camDrag = null;
  let camFly = null;

  function camInit() {
    cam.target.copy(engine.playerAvatar?.group.position || new THREE.Vector3());
    const off = engine.camera.position.clone().sub(cam.target);
    cam.dist = Math.max(3, off.length());
    cam.yaw = Math.atan2(off.x, off.z);
    cam.pitch = Math.asin(THREE.MathUtils.clamp(off.y / (off.length() || 1), -0.99, 0.99));
    camApply();
  }

  function camPos(c = cam) {
    const cp = Math.cos(c.pitch);
    return new THREE.Vector3(
      c.target.x + Math.sin(c.yaw) * cp * c.dist,
      c.target.y + Math.sin(c.pitch) * c.dist,
      c.target.z + Math.cos(c.yaw) * cp * c.dist,
    );
  }

  function camApply() {
    if (preview) return;
    engine._staticCam = { position: camPos(), lookAt: cam.target.clone() };
    engine.cameraMode = 'static';
    engine._camEase = 0;
    // engine._resolveStaticCam overwrites _staticCam from room.staticCamera on
    // every rebuild and every window resize; camLock is the engine's opt-out
    // (the editor re-applies below regardless, so this works either way)
    engine.camLock = true;
  }

  function camSet(to, ms = 400) {
    const from = { target: cam.target.clone(), dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch };
    const t0 = performance.now();
    const dy = ((to.yaw - from.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    camFly = requestAnimationFrame(function step() {
      const u = Math.min(1, (performance.now() - t0) / ms);
      const k = u * u * (3 - 2 * u);
      cam.target.lerpVectors(from.target, to.target, k);
      cam.dist = from.dist + (to.dist - from.dist) * k;
      cam.yaw = from.yaw + dy * k;
      cam.pitch = from.pitch + (to.pitch - from.pitch) * k;
      camApply();
      if (u < 1) camFly = requestAnimationFrame(step); else camFly = null;
    });
  }

  function camFrame() {
    let p = null;
    if (tab === 'inspect') p = selection[0] && entryPos(selection[0]);
    else if (tab === 'numbers') p = pin?.mesh.position;
    else {
      const b = selectionBox();
      if (b) p = b.getCenter(new THREE.Vector3());
    }
    if (!p) return;
    cam.target.copy(p);
    cam.dist = Math.max(3, Math.min(cam.dist, 12));
    camApply();
  }

  function onWheel(e) {
    if (preview) return;
    e.preventDefault();
    cam.dist = THREE.MathUtils.clamp(cam.dist * (e.deltaY > 0 ? 1.12 : 0.89), 1.5, 140);
    camApply();
  }

  function onCamDown(e) {
    if (e.button !== 2 && e.button !== 1) return false;
    e.preventDefault(); e.stopPropagation();
    if (armed) { disarm(); return true; }
    camDrag = { mode: e.button === 1 || e.shiftKey ? 'pan' : 'orbit', x: e.clientX, y: e.clientY };
    return true;
  }

  function onCamMove(e) {
    if (!camDrag) return false;
    const dx = e.clientX - camDrag.x;
    const dy = e.clientY - camDrag.y;
    camDrag.x = e.clientX; camDrag.y = e.clientY;
    if (camDrag.mode === 'orbit') {
      cam.yaw -= dx * 0.006;
      cam.pitch = THREE.MathUtils.clamp(cam.pitch + dy * 0.005, -0.2, 1.45);
    } else {
      const right = new THREE.Vector3().setFromMatrixColumn(engine.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(engine.camera.matrix, 1);
      const k = cam.dist * 0.0016;
      cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
    camApply();
    return true;
  }

  // ---- the document --------------------------------------------------------

  // ---- the read side, whichever module owns it -----------------------------
  const curRev = () => (OV?.layoutRev ? OV.layoutRev(room?.id) : revOf(room?.id)) || 0;

  /** Always in WIRE shape: overlay.js keeps its normalised copy with {x,y,z}
   *  vectors, and everything below indexes p[0]/p[2]. */
  const peekPublished = () => {
    const doc = OV?.peekLayout ? OV.peekLayout(room?.id) : docFor(room?.id);
    return normalizeOps(doc?.ops || []);
  };

  /** Make the draft the thing the next build applies. Nobody else sees it. */
  function pushDraft() {
    if (!room || !isLayoutRoom(room.id)) return;
    setDraft(room.id, ops);
    try { OV?.primeLayout(room.id, { v: 1, room: room.id, rev: curRev(), base: baseSig, ops }); }
    catch (e) { console.error('[editor] primeLayout:', e); }
  }

  /** After a publish: drop the draft, refetch the real document, rebuild. */
  function refetch() {
    if (!room) return;
    const id = room.id;
    clearDraft(id);
    let p;
    if (OV) { OV.evictLayout(id); p = Promise.resolve(OV.ensureLayout?.(id)); }
    else { evict(id); p = ensure(id, { timeout: 0 }); }
    p.then(() => {
      published = peekPublished();
      ops = published.map((o) => ({ ...o }));
      pushDraft();
      refresh(true);
    });
  }

  /**
   * `room.dataProps` is an Object3D list under src/world/layout.js's apply pass
   * and a `{id, cat, obj, op}` record list under src/world/overlay.js's. One
   * shape here so nothing below has to care which one built the room.
   */
  function dataProps() {
    const out = [];
    for (const d of room?.dataProps || []) {
      if (!d) continue;
      if (d.isObject3D) out.push({ id: propIdOf(d), obj: d });
      else if (d.obj) out.push({ id: d.id || propIdOf(d.obj), obj: d.obj });
    }
    return out;
  }

  const opAt = (id) => ops.find((o) => o.id === id) || null;
  const propOps = () => ops.filter((o) => o.op === 'prop');
  const colliderOps = () => ops.filter((o) => o.op === 'collider');
  const hotspotOps = () => ops.filter((o) => o.op === 'hotspot');
  const camOps = () => ops.filter((o) => o.op === 'cam' && o.id.startsWith('bm_'));
  const groupOps = () => ops.filter((o) => o.op === 'group');

  function putOp(o) {
    const k = opKey(o);
    const i = ops.findIndex((x) => opKey(x) === k);
    if (i >= 0) ops[i] = o; else ops.push(o);
    return o;
  }

  function dropOp(o) {
    const k = typeof o === 'string' ? o : opKey(o);
    const i = ops.findIndex((x) => (typeof o === 'string' ? x.id === o : opKey(x) === k));
    if (i >= 0) ops.splice(i, 1);
  }

  /**
   * One command = one snapshot pair. Continuous drags coalesce because begin()
   * is a no-op while a command is already open, so pointerdown..pointerup is
   * one entry however many frames it took.
   */
  function begin(label) {
    if (pending) return;
    pending = { label, before: JSON.stringify(ops) };
  }

  function commit({ rebuild = false } = {}) {
    if (!pending) return;
    const after = JSON.stringify(ops);
    if (after !== pending.before) {
      undoStack.push({ label: pending.label, before: pending.before, after });
      if (undoStack.length > 200) undoStack.shift();
      redoStack.length = 0;
      markDirty();
    }
    pending = null;
    refresh(rebuild);
  }

  const edit = (label, fn, opts) => { begin(label); fn(); commit(opts); };

  function undo() {
    if (tab === 'inspect') { inspectUndoOne(); return; }
    const a = undoStack.pop();
    if (!a) { game.toast('Nothing to undo'); return; }
    redoStack.push(a);
    ops = JSON.parse(a.before);
    markDirty();
    refresh(true);
    game.toast(`Undone: ${a.label}`);
  }

  function redo() {
    const a = redoStack.pop();
    if (!a) { game.toast('Nothing to redo'); return; }
    undoStack.push(a);
    ops = JSON.parse(a.after);
    markDirty();
    refresh(true);
    game.toast(`Redone: ${a.label}`);
  }

  function markDirty() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 1500);
  }

  function saveDraft() {
    saveTimer = null;
    if (!room || !isLayoutRoom(room.id)) return;
    const v = validateOps(ops, { room: room.id });
    if (!v.ok) { game.toast(`Not saved: ${v.msg}`); return; }
    ops = v.clean;
    if (!game.net?.connected) return;   // offline: the draft still lives in memory
    game.net.send({ t: 'layout-save', room: room.id, base: baseSig, ops: v.clean });
  }

  // ---- applying the draft --------------------------------------------------

  /**
   * `rebuild` runs the real build path (so handles, spawns, cameras and hidden
   * props all land exactly where a normal visit puts them). Prop transforms
   * skip it and pose the live objects instead, which is what makes dragging
   * feel like an editor rather than a slideshow.
   */
  function refresh(rebuild = false) {
    if (!room) return;
    pushDraft();
    if (rebuild) {
      engine.rebuildRoom();
      room = engine.room;
      camApply();
      buildPins();
      if (ghost && engine.scene) engine.scene.add(ghost); // the old scene took it with it
    } else {
      poseProps();
    }
    drawGizmos();
    clearWalk();
    paint();
  }

  function poseProps() {
    const byId = new Map(dataProps().map((d) => [d.id, d.obj]));
    for (const o of propOps()) {
      const g = byId.get(o.id);
      // adds and removes always pass rebuild:true, so a miss here is a prop
      // whose builder failed: skip it rather than rebuilding forever
      if (!g) continue;
      g.position.set(o.p[0], o.p[1], o.p[2]);
      if (!o.yLock) {
        const y = groundY(room, o.p[0], o.p[2]);
        if (y !== null) g.position.y = y + (o.p[1] || 0);
      }
      g.rotation.y = o.ry || 0;
      g.scale.setScalar(o.s || 1);
      const c = propCollider(o);
      const ob = (room.obstacles || []).find((x) => obsIdOf(x) === o.id);
      if (ob && c) { ob.x = c.x; ob.z = c.z; ob.r = c.r; }
    }
  }

  // ---- gizmos --------------------------------------------------------------

  function clearGizmos() {
    for (const g of gizmos) { g.parent?.remove(g); disposeObject(g); }
    gizmos = [];
  }

  function ring(x, z, r, color, { fill = false, y = 0.04 } = {}) {
    const g = new THREE.Mesh(
      fill ? new THREE.CircleGeometry(r, 36) : new THREE.RingGeometry(Math.max(0.02, r - 0.09), r, 36),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fill ? 0.16 : 0.85, depthTest: false, side: THREE.DoubleSide }),
    );
    const gy = groundY(room, x, z);
    g.position.set(x, (gy === null ? 0 : gy) + y, z);
    g.rotation.x = -Math.PI / 2;
    g.renderOrder = 996;
    return g;
  }

  function selectionBox() {
    const b = new THREE.Box3();
    let any = false;
    for (const id of sel) {
      const obj = objectFor(id);
      if (!obj) continue;
      b.union(new THREE.Box3().setFromObject(obj));
      any = true;
    }
    return any ? b : null;
  }

  function objectFor(id) {
    if (id.startsWith('tag:')) return room?.tagged?.get(id.slice(4)) || null;
    return dataProps().find((d) => d.id === id)?.obj || null;
  }

  function drawGizmos() {
    clearGizmos();
    if (preview || tab !== 'build' || !room) return;

    // selection
    for (const id of sel) {
      const obj = objectFor(id);
      if (!obj) continue;
      const b = new THREE.Box3().setFromObject(obj);
      if (b.isEmpty()) continue;
      const h = new THREE.Box3Helper(b, sel.size > 1 ? 0x7ee0ff : 0xf2b64a);
      h.material.depthTest = false;
      h.renderOrder = 998;
      engine.scene.add(h);
      gizmos.push(h);
    }
    if (sel.size > 1) {
      const b = selectionBox();
      if (b) {
        const c = b.getCenter(new THREE.Vector3());
        const g = ring(c.x, c.z, 0.4, 0xffffff, { y: 0.06 });
        engine.scene.add(g);
        gizmos.push(g);
      }
    }

    if (!zonesOn) return;

    // the contract with the server: bots wander this circle blindly
    const bz = BOT_ZONES[room.id];
    if (bz) {
      const g = ring(bz.x, bz.z, bz.r, 0xff6bd0, { fill: true, y: 0.02 });
      engine.scene.add(g);
      gizmos.push(g);
      const o = ring(bz.x, bz.z, bz.r, 0xff6bd0, { y: 0.03 });
      engine.scene.add(o);
      gizmos.push(o);
    }

    for (const c of room.obstacles || []) {
      const mine = !!opAt(obsIdOf(c));
      const g = ring(c.x, c.z, c.r, mine ? 0xf2b64a : 0x8d8578, { y: 0.05 });
      g.userData.zone = mine ? { kind: 'collider', id: obsIdOf(c) } : null;
      engine.scene.add(g);
      gizmos.push(g);
    }

    for (const h of room.hotspots || []) {
      const kind = h.id?.startsWith('exit-') ? 'exit' : h.opId && opAt(h.opId)?.kind === 'game' ? 'game' : 'sign';
      const col = h.opId && opAt(h.opId) ? ZONE_COLOR[opAt(h.opId).kind] || 0xf2b64a : (kind === 'exit' ? 0x7ee0ff : 0x8d8578);
      const g = ring(h.position.x, h.position.z, h.radius || 2.5, col, { fill: true, y: 0.03 });
      engine.scene.add(g);
      gizmos.push(g);
      const o = ring(h.position.x, h.position.z, h.radius || 2.5, col, { y: 0.045 });
      o.userData.zone = h.opId && opAt(h.opId) ? { kind: 'hotspot', id: h.opId } : null;
      engine.scene.add(o);
      gizmos.push(o);
    }
  }

  // ---- placement ghost -----------------------------------------------------

  function disarm() {
    armed = null;
    if (ghost) { ghost.parent?.remove(ghost); disposeObject(ghost); ghost = null; }
    setHint('');
    paint();
  }

  function arm(catId) {
    if (armed === catId) { disarm(); return; }
    disarm();
    armed = catId;
    ghost = buildProp(catId);
    if (!ghost) { armed = null; return; }
    // clone every material: the originals are the shared toon cache, and a
    // ghost that dimmed them would dim the whole world
    ghost.traverse((m) => {
      if (!m.isMesh || !m.material) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => {
        const c = mat.clone();
        c.userData = { ...(c.userData || {}), shared: false, vc: !!mat.vertexColors };
        c.transparent = true;
        c.opacity = 0.55;
        c.depthWrite = false;
        return c;
      });
      m.material = mats.length === 1 ? mats[0] : mats;
      m.castShadow = false;
    });
    ghost.visible = false;
    engine.scene.add(ghost);
    setHint(`Placing ${PROPS[catId].name}. Click the floor, Shift-click to keep placing, Esc to stop.`);
    paint();
  }

  function ghostValid(x, z) {
    if (groundY(room, x, z) === null) return false;
    const bz = BOT_ZONES[room.id];
    if (bz && Math.hypot(x - bz.x, z - bz.z) < bz.r) return false;
    return true;
  }

  function moveGhost(e) {
    if (!ghost) return;
    const p = pickFloor(e);
    if (!p) { ghost.visible = false; return; }
    const g = GRIDS[snapGrid];
    const x = g ? Math.round(p.x / g) * g : p.x;
    const z = g ? Math.round(p.z / g) * g : p.z;
    const y = groundY(room, x, z);
    ghost.visible = true;
    ghost.position.set(x, y === null ? p.y : y, z);
    const ok = ghostValid(x, z);
    if (ghost.userData.ok !== ok) {
      ghost.traverse((m) => {
        if (!m.isMesh || !m.material || Array.isArray(m.material)) return;
        const mat = m.material;
        mat.color.setHex(ok ? 0xffffff : 0xe8657a);
        const vc = ok && mat.userData.vc;
        if (mat.vertexColors !== vc) { mat.vertexColors = vc; mat.needsUpdate = true; }
      });
    }
    ghost.userData.ok = ok;
  }

  function placeGhost(e) {
    if (!ghost?.visible) return;
    if (!ghost.userData.ok && !e.altKey) { game.toast('Not walkable ground (Alt to place anyway)'); return; }
    const cat = armed;
    const p = ghost.position;
    edit(`place ${PROPS[cat].name}`, () => {
      const o = {
        op: 'prop', id: mint('p'), cat,
        p: [+p.x.toFixed(2), 0, +p.z.toFixed(2)],
        ry: +snapYaw(cam.yaw + Math.PI).toFixed(3), s: 1,
      };
      putOp(o);
      sel.clear();
      sel.add(o.id);
    }, { rebuild: true });
    if (!e.shiftKey) disarm();
  }

  const snapYaw = (v) => (snapAngle ? Math.round(v / snapAngle) * snapAngle : v);

  // ---- picking -------------------------------------------------------------

  function pickFloor(e) {
    if (!room?.groundMeshes?.length) return null;
    ray.setFromCamera(ndc(e), engine.camera);
    const hits = ray.intersectObjects(room.groundMeshes, false);
    return hits.length ? hits[0].point.clone() : null;
  }

  /** Data props and tagged objects under the cursor, front to back. */
  function pickLayout(e) {
    ray.setFromCamera(ndc(e), engine.camera);
    const known = new Map();                       // Object3D -> op id
    for (const d of dataProps()) known.set(d.obj, d.id);
    const tags = room.tagged instanceof Map ? [...room.tagged.entries()] : [];
    for (const [id, obj] of tags) if (obj) known.set(obj, `tag:${id}`);
    const hits = ray.intersectObjects([...known.keys()], true);
    const out = [];
    for (const h of hits) {
      let o = h.object;
      while (o && !known.has(o)) o = o.parent;
      if (!o) continue;
      const id = known.get(o);
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /** A zone ring under the cursor: centre grabs, rim resizes. */
  function pickZone(e) {
    if (!zonesOn) return null;
    ray.setFromCamera(ndc(e), engine.camera);
    let best = null;
    for (const g of gizmos) {
      const z = g.userData.zone;
      if (!z) continue;
      plane.constant = -g.position.y;
      if (!ray.ray.intersectPlane(plane, hit)) continue;
      const o = opAt(z.id);
      if (!o) continue;
      const centre = zoneCentre(z);
      if (!centre) continue;
      const d = Math.hypot(hit.x - centre.x, hit.z - centre.z);
      const r = zoneRadius(z);
      const kind = Math.abs(d - r) < Math.max(0.35, r * 0.18) ? 'zone-size' : d < r ? 'zone-move' : null;
      if (!kind) continue;
      if (!best || d < best.d) best = { d, kind, zone: z };
    }
    return best;
  }

  function zoneCentre(z) {
    const o = opAt(z.id);
    if (!o) return null;
    if (z.kind === 'collider') {
      const c = (room.obstacles || []).find((x) => obsIdOf(x) === z.id);
      return c ? { x: c.x, z: c.z } : (o.x !== undefined ? { x: o.x, z: o.z } : null);
    }
    const h = (room.hotspots || []).find((x) => x.opId === z.id);
    return h ? { x: h.position.x, z: h.position.z } : (o.x !== undefined ? { x: o.x, z: o.z } : null);
  }

  function zoneRadius(z) {
    if (z.kind === 'collider') {
      const c = (room.obstacles || []).find((x) => obsIdOf(x) === z.id);
      return c ? c.r : opAt(z.id)?.r ?? 1;
    }
    const h = (room.hotspots || []).find((x) => x.opId === z.id);
    return h ? (h.radius || 2.5) : opAt(z.id)?.r ?? 2.5;
  }

  // ---- group ops -----------------------------------------------------------

  /** Selection plus every member of a group any of them belongs to. */
  function expandSelection(alt) {
    const out = new Set(sel);
    if (alt) return out;
    for (const g of groupOps()) {
      if (g.members.some((m) => out.has(m))) for (const m of g.members) out.add(m);
    }
    return out;
  }

  function selectedPropOps(alt = false) {
    const ids = expandSelection(alt);
    return propOps().filter((o) => ids.has(o.id));
  }

  function moveSel(dx, dz, dy = 0, alt = false) {
    const list = selectedPropOps(alt);
    if (!list.length) return;
    const g = GRIDS[snapGrid];
    for (const o of list) {
      let x = o.p[0] + dx;
      let z = o.p[2] + dz;
      if (g && !alt) { x = Math.round(x / g) * g; z = Math.round(z / g) * g; }
      o.p = [+x.toFixed(2), +(o.p[1] + dy).toFixed(2), +z.toFixed(2)];
    }
  }

  function rotateSel(d, aboutPivot) {
    const list = selectedPropOps();
    if (!list.length) return;
    const b = selectionBox();
    const c = aboutPivot && b ? b.getCenter(new THREE.Vector3()) : null;
    for (const o of list) {
      o.ry = +((o.ry || 0) + d).toFixed(3);
      if (c) {
        const dx = o.p[0] - c.x;
        const dz = o.p[2] - c.z;
        o.p = [
          +(c.x + dx * Math.cos(d) + dz * Math.sin(d)).toFixed(2),
          o.p[1],
          +(c.z - dx * Math.sin(d) + dz * Math.cos(d)).toFixed(2),
        ];
      }
    }
  }

  function scaleSel(k, aboutPivot) {
    const list = selectedPropOps();
    if (!list.length) return;
    const b = selectionBox();
    const c = aboutPivot && b ? b.getCenter(new THREE.Vector3()) : null;
    for (const o of list) {
      o.s = +THREE.MathUtils.clamp((o.s || 1) * k, 0.25, 4).toFixed(3);
      if (c) o.p = [+(c.x + (o.p[0] - c.x) * k).toFixed(2), o.p[1], +(c.z + (o.p[2] - c.z) * k).toFixed(2)];
    }
  }

  function alignSel(how) {
    const list = selectedPropOps();
    if (list.length < 2) { game.toast('Select two or more props'); return; }
    edit(`align ${how}`, () => {
      const xs = list.map((o) => o.p[0]);
      const zs = list.map((o) => o.p[2]);
      if (how === 'x-') for (const o of list) o.p[0] = Math.min(...xs);
      if (how === 'x+') for (const o of list) o.p[0] = Math.max(...xs);
      if (how === 'z-') for (const o of list) o.p[2] = Math.min(...zs);
      if (how === 'z+') for (const o of list) o.p[2] = Math.max(...zs);
      if (how === 'cx') { const m = (Math.min(...xs) + Math.max(...xs)) / 2; for (const o of list) o.p[0] = +m.toFixed(2); }
      if (how === 'cz') { const m = (Math.min(...zs) + Math.max(...zs)) / 2; for (const o of list) o.p[2] = +m.toFixed(2); }
      if (how === 'dx' || how === 'dz') {
        const i = how === 'dx' ? 0 : 2;
        const sorted = [...list].sort((a, b) => a.p[i] - b.p[i]);
        const lo = sorted[0].p[i];
        const hi = sorted[sorted.length - 1].p[i];
        const step = (hi - lo) / (sorted.length - 1);
        sorted.forEach((o, n) => { o.p[i] = +(lo + step * n).toFixed(2); });
      }
    }, { rebuild: true });
  }

  function duplicateSel() {
    const list = selectedPropOps();
    if (!list.length) return;
    edit(`duplicate ${list.length} prop${list.length === 1 ? '' : 's'}`, () => {
      const made = [];
      for (const o of list) {
        const copy = { ...o, id: mint('p'), p: [+(o.p[0] + 0.6).toFixed(2), o.p[1], +(o.p[2] + 0.6).toFixed(2)] };
        putOp(copy);
        made.push(copy.id);
      }
      sel.clear();
      for (const id of made) sel.add(id);
    }, { rebuild: true });
  }

  function deleteSel() {
    const ids = [...expandSelection(true)];
    if (!ids.length) return;
    edit(`remove ${ids.length} item${ids.length === 1 ? '' : 's'}`, () => {
      for (const id of ids) {
        if (id.startsWith('tag:')) { putOp({ op: 'hide', id: id.slice(4) }); continue; }
        const o = opAt(id);
        if (o?.op === 'prop' || o?.op === 'collider' || o?.op === 'hotspot') dropOp(o);
      }
      sel.clear();
    }, { rebuild: true });
  }

  // ---- colliders and hotspots ---------------------------------------------

  function addCollider(at) {
    edit('add collider', () => {
      const o = { op: 'collider', id: mint('c'), x: +at.x.toFixed(2), z: +at.z.toFixed(2), r: 1 };
      putOp(o);
      sel.clear();
      zonesOn = true;
    }, { rebuild: true });
  }

  function addHotspot(kind, to, label, at) {
    edit('add hotspot', () => {
      putOp({
        op: 'hotspot', id: mint('h'), kind, to,
        x: +at.x.toFixed(2), z: +at.z.toFixed(2), r: 2.5, label,
      });
      zonesOn = true;
    }, { rebuild: true });
  }

  // ---- walkability preview -------------------------------------------------

  function clearWalk() {
    if (walkMesh) { walkMesh.parent?.remove(walkMesh); disposeObject(walkMesh); walkMesh = null; }
  }

  /**
   * The walker is a POINT, obstacles are circles and footing is one downward
   * raycast, so this can be exact rather than approximate: it raycasts the
   * room's real groundMeshes and, for the route check, walks the real
   * WalkController. A bespoke pathfinder would pass rooms the walker gets
   * stuck in, which is the entire class of bug this is for.
   */
  function walkCheck() {
    if (walkPending || !room?.groundMeshes?.length) return;
    clearWalk();
    walkPending = true;
    setHint('Walk check: rasterising...');

    const box = new THREE.Box3();
    for (const m of room.groundMeshes) {
      m.updateWorldMatrix(true, false);
      const b = new THREE.Box3().setFromObject(m);
      if (!b.isEmpty()) box.union(b);
    }
    if (box.isEmpty()) { walkPending = false; setHint(''); return; }

    const CELL = 0.25;
    const x0 = Math.floor(box.min.x / CELL) * CELL;
    const z0 = Math.floor(box.min.z / CELL) * CELL;
    const nx = Math.min(240, Math.ceil((box.max.x - x0) / CELL) + 1);
    const nz = Math.min(240, Math.ceil((box.max.z - z0) / CELL) + 1);
    const open = new Uint8Array(nx * nz);
    const ys = new Float32Array(nx * nz);
    const obstacles = room.obstacles || [];
    let i = 0;

    const stepRaster = () => {
      const t0 = performance.now();
      while (i < nx * nz && performance.now() - t0 < 4) {
        const cx = i % nx;
        const cz = (i / nx) | 0;
        const x = x0 + cx * CELL;
        const z = z0 + cz * CELL;
        const y = groundY(room, x, z);
        let ok = y !== null && (room.minWalkY === undefined || y >= room.minWalkY);
        if (ok) {
          for (const o of obstacles) {
            if (Math.hypot(x - o.x, z - o.z) < o.r) { ok = false; break; }
          }
        }
        open[i] = ok ? 1 : 0;
        ys[i] = y === null ? 0 : y;
        i++;
      }
      if (i < nx * nz) { requestAnimationFrame(stepRaster); return; }
      finishWalk({ open, ys, nx, nz, x0, z0, CELL });
    };
    requestAnimationFrame(stepRaster);
  }

  function finishWalk(g) {
    const { open, ys, nx, nz, x0, z0, CELL } = g;
    const reach = new Uint8Array(nx * nz);
    const spawn = room.spawnPoints?.default;
    const idx = (cx, cz) => cz * nx + cx;
    if (spawn) {
      const sx = THREE.MathUtils.clamp(Math.round((spawn.x - x0) / CELL), 0, nx - 1);
      const sz = THREE.MathUtils.clamp(Math.round((spawn.z - z0) / CELL), 0, nz - 1);
      const q = [idx(sx, sz)];
      if (open[q[0]]) {
        reach[q[0]] = 1;
        while (q.length) {
          const n = q.pop();
          const cx = n % nx;
          const cz = (n / nx) | 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const ax = cx + dx;
              const az = cz + dz;
              if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
              const k = idx(ax, az);
              if (!open[k] || reach[k]) continue;
              reach[k] = 1;
              q.push(k);
            }
          }
        }
      }
    }

    // one InstancedMesh of quads: the whole overlay is one draw call
    let count = 0;
    for (let k = 0; k < open.length; k++) if (open[k]) count++;
    const geo = new THREE.PlaneGeometry(CELL * 0.92, CELL * 0.92).rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.42, depthWrite: false, depthTest: false }),
      Math.max(1, count),
    );
    mesh.renderOrder = 995;
    const col = new THREE.Color();
    let n = 0;
    let stranded = 0;
    for (let k = 0; k < open.length; k++) {
      if (!open[k]) continue;
      const cx = k % nx;
      const cz = (k / nx) | 0;
      _m.makeTranslation(x0 + cx * CELL, ys[k] + 0.035, z0 + cz * CELL);
      mesh.setMatrixAt(n, _m);
      if (reach[k]) col.setHex(0x7ac74f); else { col.setHex(0xe8657a); stranded++; }
      mesh.setColorAt(n, col);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    engine.scene.add(mesh);
    walkMesh = mesh;
    walkPending = false;

    const routes = routeCheck();
    const bits = [`${n} open cells`, stranded ? `${stranded} cut off` : 'all reachable'];
    if (routes.failed.length) bits.push(`${routes.failed.length} route${routes.failed.length === 1 ? '' : 's'} blocked: ${routes.failed.slice(0, 3).join(', ')}`);
    lastWalk = { stranded, failed: routes.failed, botZone: botZoneClear() };
    if (!lastWalk.botZone) bits.push('BOT_ZONE blocked');
    setHint(bits.join(' - '), 7000);
    paint();
  }

  /**
   * Every (spawn, hotspot) and (hotspot, hotspot) pair, walked with the REAL
   * controller against a stub avatar at a fixed dt. If the walker cannot get
   * there, neither can a player.
   */
  function routeCheck() {
    const points = [];
    const spawn = room.spawnPoints?.default;
    if (spawn) points.push({ name: 'spawn', p: spawn.clone() });
    for (const h of room.hotspots || []) points.push({ name: h.id || h.label || 'zone', p: h.position.clone() });
    const failed = [];
    if (points.length < 2) return { failed };

    const stub = {
      group: new THREE.Object3D(),
      setAnim() {},
      state: { anim: 'idle' },
    };
    const ctrl = new WalkController(stub);
    const pairs = [];
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        if (a > 0 && b > 6) continue;             // spawn-to-all, plus a sample
        pairs.push([points[a], points[b]]);
      }
    }
    for (const [from, to] of pairs.slice(0, 40)) {
      stub.group.position.copy(from.p);
      ctrl.setTarget(to.p);
      let t = 0;
      while (ctrl.target && t < 30) { ctrl.update(1 / 30, room); t += 1 / 30; }
      const d = Math.hypot(stub.group.position.x - to.p.x, stub.group.position.z - to.p.z);
      if (d > 1.2) failed.push(`${from.name}->${to.name}`);
    }
    return { failed };
  }

  function botZoneClear() {
    const bz = BOT_ZONES[room.id];
    if (!bz) return true;
    for (const o of room.obstacles || []) {
      if (Math.hypot(o.x - bz.x, o.z - bz.z) < bz.r + o.r) return false;
    }
    return groundY(room, bz.x, bz.z) !== null;
  }

  let lastWalk = null;

  // ---- publish flow --------------------------------------------------------

  function requestDoc() {
    if (!room || !isLayoutRoom(room.id)) return;
    published = peekPublished();
    if (game.net?.connected) game.net.send({ t: 'layout-get', room: room.id });
  }

  function onDoc(m) {
    if (!room || m.room !== room.id) return;
    // `ops` is the published list (server/layouts.js docFrame); the spec called
    // it `published`, so accept both and stop caring which one landed
    const pub = Array.isArray(m.ops) ? m.ops : (m.published || []);
    setDoc(m.room, { rev: m.rev, base: m.base, ops: pub });
    published = normalizeOps(pub);
    baseSig = m.base || baseSig;
    // `others` is the soft "someone else has a draft here" signal, not a lock
    const others = Array.isArray(m.others) ? m.others : [];
    lock = m.lock || (others.length ? { by: others[0].by } : null);
    orphans = Array.isArray(m.orphans) ? m.orphans : [];
    history = Array.isArray(m.history) ? m.history : [];
    draftRev = Number(m.draft?.rev) || 0;
    if (!dirty && !undoStack.length) {
      ops = normalizeOps(m.draft?.ops || published);
      refresh(true);
    } else {
      paint();
    }
  }

  function onAck(m) {
    if (!room || m.room !== room.id) return;
    if (!m.ok) { game.toast(m.msg || 'The server refused that'); paint(); return; }
    if (m.what === 'save') { dirty = false; draftRev = Number(m.rev) || draftRev; paint(); return; }
    if (m.what === 'publish' || m.what === 'revert' || m.what === 'discard') {
      dirty = false;
      undoStack.length = 0;
      redoStack.length = 0;
      refetch();
      game.toast(m.msg || (m.what === 'discard' ? 'Draft discarded' : `Published rev ${m.rev}`));
    }
  }

  function onRev(m) {
    if (!room || m.room !== room.id) return;
    if (!dirty && !undoStack.length) refetch();
    else game.toast(`${m.by || 'Someone'} published rev ${m.rev}: your draft is still yours`);
    paintHeader();
  }

  function publish() {
    if (!game.net?.connected) { game.toast('Not connected: the draft is only in this browser'); return; }
    const v = validateOps(ops, { room: room.id });
    if (!v.ok) { game.toast(`Cannot publish: ${v.msg}`); return; }
    const gates = [];
    if (lastWalk) {
      if (!lastWalk.botZone) gates.push('the BOT_ZONE circle is blocked');
      if (lastWalk.stranded > 40) gates.push(`${lastWalk.stranded} cells are cut off`);
      if (lastWalk.failed.length) gates.push(`${lastWalk.failed.length} routes are blocked`);
    } else {
      gates.push('the walk check has not been run (V)');
    }
    const d = describeDiff(diffOps(published, v.clean));
    const warn = gates.length ? `\n\nWARNINGS:\n- ${gates.join('\n- ')}` : '';
    // eslint-disable-next-line no-alert
    if (!confirm(`Publish ${room.name} to everyone?\n\n${d}${warn}`)) return;
    saveDraft();
    // `rev` is the published revision this editor last saw: the server refuses
    // the publish if someone else moved it on, instead of silently winning
    game.net.send({ t: 'layout-publish', room: room.id, ops: v.clean, base: baseSig, rev: curRev() });
  }

  function revert(toRev) {
    if (!game.net?.connected) { game.toast('Not connected'); return; }
    // eslint-disable-next-line no-alert
    if (!confirm(`Republish revision ${toRev} of ${room.name}?`)) return;
    game.net.send({ t: 'layout-revert', room: room.id, toRev });
  }

  /** Back to pure code: publish an EMPTY document (history keeps the old one). */
  function resetRoom() {
    // eslint-disable-next-line no-alert
    if (!confirm(`Clear every layout op for ${room.name} and go back to pure code?\n\nThe current revision stays in the history.`)) return;
    edit('reset layout', () => { ops = []; sel.clear(); }, { rebuild: true });
    if (game.net?.connected) game.net.send({ t: 'layout-publish', room: room.id, ops: [], base: baseSig, rev: curRev() });
  }

  /** Throw my unpublished draft away and go back to what everyone else sees. */
  function discardDraft() {
    // eslint-disable-next-line no-alert
    if (!confirm('Throw away your unpublished changes?')) return;
    if (game.net?.connected) game.net.send({ t: 'layout-discard', room: room.id });
    dirty = false;
    undoStack.length = 0;
    redoStack.length = 0;
    refetch();
  }

  function setPreview(on) {
    preview = on;
    el.style.display = on ? 'none' : '';
    clearGizmos();
    clearWalk();
    disarm();
    if (on) {
      engine.camLock = false;
      engine.setCameraMode ? engine.setCameraMode(savedMode) : (engine.cameraMode = savedMode);
      setHint('Preview: this is exactly what players will see. P to go back.', 4000);
    } else {
      camApply();
      drawGizmos();
      paint();
    }
  }

  // ---- camera bookmarks ----------------------------------------------------

  function setBookmark(n) {
    edit(`camera bookmark ${n}`, () => {
      putOp({
        op: 'cam', id: `bm_${n}`, name: `view ${n}`,
        target: [+cam.target.x.toFixed(2), +cam.target.y.toFixed(2), +cam.target.z.toFixed(2)],
        dist: +cam.dist.toFixed(2), yaw: +cam.yaw.toFixed(3), pitch: +cam.pitch.toFixed(3),
      });
    });
    game.toast(`Bookmark ${n} set`);
  }

  function goBookmark(n) {
    const o = opAt(`bm_${n}`);
    if (!o) return;
    camSet({ target: new THREE.Vector3(o.target[0], o.target[1], o.target[2]), dist: o.dist, yaw: o.yaw, pitch: o.pitch });
  }

  function saveStaticCam() {
    const p = camPos();
    edit('room camera', () => {
      putOp({
        op: 'cam', id: 'static',
        p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
        look: [+cam.target.x.toFixed(2), +cam.target.y.toFixed(2), +cam.target.z.toFixed(2)],
      });
    }, { rebuild: true });
    game.toast('This shot is now the room camera');
  }

  let spawnView = -1;
  function cycleSpawnViews() {
    const names = Object.keys(room.spawnPoints || {});
    if (!names.length) return;
    spawnView = (spawnView + 1) % names.length;
    const sp = room.spawnPoints[names[spawnView]];
    const off = engine.camCfg?.offset || new THREE.Vector3(0, 14, 19);
    cam.target.copy(sp);
    cam.dist = off.length();
    cam.yaw = Math.atan2(off.x, off.z);
    cam.pitch = Math.asin(THREE.MathUtils.clamp(off.y / (off.length() || 1), -0.99, 0.99));
    camApply();
    setHint(`Spawn view: ${names[spawnView]} (this is the first thing an arriving player sees)`, 4000);
  }

  // =========================================================================
  // NUMBERS tab (handles): unchanged interaction, now writing `handle` ops
  // =========================================================================

  function clearPins() {
    for (const p of pins) { p.mesh.parent?.remove(p.mesh); p.mesh.traverse((o) => o.material?.dispose?.()); }
    pins = [];
  }

  function makePin(color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const cone = new THREE.Mesh(pinGeo, mat);
    cone.rotation.x = Math.PI; cone.position.y = 0.25;
    const knob = new THREE.Mesh(knobGeo, mat);
    knob.position.y = 0.56;
    g.add(cone, knob);
    g.traverse((o) => { o.renderOrder = 999; });
    return g;
  }

  function buildPins() {
    clearPins();
    if (tab !== 'numbers' || preview) return;
    for (const e of room?.editables || []) {
      const handles = room.editorHandles?.(e.id);
      if (!handles?.length) continue;
      for (const h of handles) {
        const mesh = makePin(h.color ?? 0xf2b64a);
        mesh.position.set(h.xz[0], (h.y || 0) + 0.05, h.xz[1]);
        engine.scene.add(mesh);
        pins.push({ entryId: e.id, key: h.key, label: h.label, color: h.color ?? 0xf2b64a, y: h.y || 0, yaw: h.yaw ?? null, mesh });
      }
    }
    pin = pin ? pins.find((p) => p.entryId === pin.entryId && p.key === pin.key) || null : null;
  }

  function commitPin(p, x, z, yawStep = 0) {
    let patch;
    if (yawStep) patch = room.editorPatch?.(p.entryId, 'yaw', +(p.yaw + yawStep).toFixed(3));
    else {
      const g = GRIDS[snapGrid];
      const sx = g ? Math.round(x / g) * g : x;
      const sz = g ? Math.round(z / g) * g : z;
      const xz = [+sx.toFixed(2), +sz.toFixed(2)];
      patch = pinShift && p.key === 'at'
        ? room.editorPatchAll?.(p.entryId, xz[0] - pinDragStart[0], xz[1] - pinDragStart[1])
        : room.editorPatch?.(p.entryId, p.key, xz);
    }
    if (!patch) return;
    edit(`${p.label}`, () => {
      const id = `${room.id}/${p.entryId}`;
      const prev = ops.find((o) => o.op === 'handle' && o.id === id);
      putOp({ op: 'handle', id, set: { ...(prev?.set || {}), ...patch } });
    }, { rebuild: true });
  }

  // =========================================================================
  // INSPECT tab (free mode): read the numbers, paste them into the room file
  // =========================================================================

  function piecesOf(geo) {
    if ('__pieces' in geo.userData) return geo.userData.__pieces;
    const pos = geo.attributes.position;
    const idx = geo.index?.array;
    if (pos.count > 200000) { geo.userData.__pieces = null; return null; }
    const parent = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
    if (!idx) {
      // unindexed (icosahedrons and anything merged from them) repeats a shared
      // corner per triangle: weld by position or every triangle is an island
      const weld = new Map();
      for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
        const seen = weld.get(k);
        if (seen === undefined) weld.set(k, i); else union(i, seen);
      }
      for (let t = 0; t + 2 < pos.count; t += 3) { union(t, t + 1); union(t, t + 2); }
    } else {
      for (let t = 0; t < idx.length; t += 3) { union(idx[t], idx[t + 1]); union(idx[t], idx[t + 2]); }
    }
    const byRoot = new Map();
    for (let v = 0; v < pos.count; v++) {
      const r = find(v);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(v);
    }
    if (byRoot.size < 2) { geo.userData.__pieces = null; return null; }
    const pieces = [...byRoot.values()].map((verts) => {
      const c = new THREE.Vector3();
      for (const v of verts) { c.x += pos.getX(v); c.y += pos.getY(v); c.z += pos.getZ(v); }
      c.multiplyScalar(1 / verts.length);
      return { verts: Uint32Array.from(verts), center: c };
    });
    const rootOf = new Map();
    pieces.forEach((p, i) => rootOf.set(find(p.verts[0]), i));
    geo.userData.__pieces = {
      pieces,
      faceToPiece: (faceIndex) => rootOf.get(find(idx ? idx[faceIndex * 3] : faceIndex * 3)) ?? 0,
    };
    return geo.userData.__pieces;
  }

  function pieceBox(mesh, piece) {
    const pos = mesh.geometry.attributes.position;
    const b = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const i of piece.verts) b.expandByPoint(v.set(pos.getX(i), pos.getY(i), pos.getZ(i)));
    return b.applyMatrix4(mesh.matrixWorld);
  }

  function isGround(obj) {
    const gm = room?.groundMeshes || [];
    let o = obj;
    while (o) { if (gm.includes(o)) return true; o = o.parent; }
    return false;
  }

  function underGizmo(obj) {
    const list = [engine.remoteGroup, engine.playerAvatar?.group, engine._marker, walkMesh, ghost,
      ...boxes, ...gizmos, ...pins.map((p) => p.mesh)].filter(Boolean);
    let o = obj;
    while (o) { if (list.includes(o)) return true; o = o.parent; }
    return false;
  }

  function isPickable(obj) {
    if (!obj.visible) return false;
    if (obj.isPoints || obj.isLine || obj.isLineSegments || obj.isSprite) return false;
    if (underGizmo(obj) || isGround(obj)) return false;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (mats.some((m) => m && m.transparent && m.depthWrite === false)) return false;
    const g = obj.geometry;
    if (g && !g.boundingSphere) g.computeBoundingSphere();
    const r = (g?.boundingSphere?.radius || 0) * Math.max(obj.scale.x, obj.scale.y, obj.scale.z);
    return r <= HUGE; // walls, shells, sky domes and floors stay put
  }

  function makeEntry(obj, instanceId = null, piece = null, pieceIndex = null, pieceCount = 0, depth = 0, nav = null) {
    const kids = obj.children?.length || 0;
    const what = instanceId != null ? 'one instance'
      : piece ? `1 of ${pieceCount} welded pieces`
        : depth > 0 ? 'part'
          : kids ? `whole prop, ${kids} part${kids === 1 ? '' : 's'}` : 'prop';
    const path = pathOf(obj, engine.scene)
      + (instanceId != null ? `#${instanceId}` : '')
      + (piece ? `:piece${pieceIndex}` : '');
    const e = { obj, instanceId, piece, path, label: `${labelOf(obj, instanceId)} (${what})`, nav };
    if (piece) e.pieceState = { pos: piece.center.clone().applyMatrix4(obj.matrixWorld), rot: 0, scale: 1 };
    return e;
  }

  function entryPos(e, out = new THREE.Vector3()) {
    if (e.piece) return out.copy(e.pieceState.pos);
    if (e.instanceId != null) { e.obj.getMatrixAt(e.instanceId, _m); return out.setFromMatrixPosition(_m); }
    return out.copy(e.obj.position);
  }

  function entryState(e) {
    if (e.piece) return { rot: e.pieceState.rot, scale: e.pieceState.scale };
    if (e.instanceId != null) {
      e.obj.getMatrixAt(e.instanceId, _m); _m.decompose(_p, _q, _s);
      return { rot: new THREE.Euler().setFromQuaternion(_q, 'YXZ').y, scale: _s.x };
    }
    return { rot: e.obj.rotation.y, scale: e.obj.scale.x };
  }

  function entryDelta(e, d) {
    const dx = d.dx || 0, dy = d.dy || 0, dz = d.dz || 0;
    const dyaw = d.dyaw || 0, ds = d.ds || 1;
    if (e.piece) {
      const st = e.pieceState;
      const inv = new THREE.Matrix4().copy(e.obj.matrixWorld).invert();
      const origin = new THREE.Vector3().applyMatrix4(inv);
      const local = new THREE.Vector3(dx, dy, dz).applyMatrix4(inv).sub(origin);
      const pos = e.obj.geometry.attributes.position;
      const c = e.piece.center;
      const m = new THREE.Matrix4().makeRotationY(dyaw);
      m.scale(new THREE.Vector3(ds, ds, ds));
      m.setPosition(local);
      const v = new THREE.Vector3();
      for (const i of e.piece.verts) {
        v.set(pos.getX(i) - c.x, pos.getY(i) - c.y, pos.getZ(i) - c.z).applyMatrix4(m);
        pos.setXYZ(i, v.x + c.x, v.y + c.y, v.z + c.z);
      }
      pos.needsUpdate = true;
      e.obj.geometry.computeBoundingSphere();
      e.obj.geometry.computeBoundingBox();
      c.add(local);
      st.pos.add(new THREE.Vector3(dx, dy, dz));
      st.rot += dyaw;
      st.scale *= ds;
      return;
    }
    if (e.instanceId != null) {
      e.obj.getMatrixAt(e.instanceId, _m);
      _m.decompose(_p, _q, _s);
      _p.add(new THREE.Vector3(dx, dy, dz));
      _q.multiply(_yaw(dyaw));
      _s.multiplyScalar(ds);
      _m.compose(_p, _q, _s);
      e.obj.setMatrixAt(e.instanceId, _m);
      e.obj.instanceMatrix.needsUpdate = true;
      e.obj.computeBoundingSphere?.();
      return;
    }
    e.obj.position.add(new THREE.Vector3(dx, dy, dz));
    e.obj.quaternion.multiply(_yaw(dyaw));
    e.obj.scale.multiplyScalar(ds);
  }

  function applyDelta(d, record = true) {
    if (!selection.length) return;
    for (const e of selection) {
      entryDelta(e, d);
      const cur = entryPos(e);
      const st = entryState(e);
      const rec = edits.get(e.path);
      if (rec) { rec.to = [cur.x, cur.y, cur.z]; rec.toRot = st.rot; rec.toScale = st.scale; } else {
        edits.set(e.path, {
          label: e.label, entry: e,
          from: [cur.x - (d.dx || 0), cur.y - (d.dy || 0), cur.z - (d.dz || 0)],
          to: [cur.x, cur.y, cur.z],
          fromRot: st.rot - (d.dyaw || 0), toRot: st.rot,
          fromScale: st.scale / (d.ds || 1), toScale: st.scale,
        });
      }
    }
    if (record) inspectUndo.push({ kind: 'delta', entries: selection.slice(), d });
    showBoxes();
    paint();
  }

  function inspectUndoOne() {
    const a = inspectUndo.pop();
    if (!a) { game.toast('Nothing to undo'); return; }
    if (a.kind === 'delta') {
      const keep = selection;
      selection = a.entries;
      applyDelta({ dx: -(a.d.dx || 0), dy: -(a.d.dy || 0), dz: -(a.d.dz || 0), dyaw: -(a.d.dyaw || 0), ds: 1 / (a.d.ds || 1) }, false);
      selection = keep;
    } else if (a.kind === 'vis') {
      a.obj.visible = a.prev;
    }
    showBoxes();
    paint();
    game.toast('Undone');
  }

  function clearBoxes() {
    for (const b of boxes) { b.parent?.remove(b); b.geometry?.dispose?.(); b.material?.dispose?.(); }
    boxes = [];
  }

  function showBoxes() {
    clearBoxes();
    for (const e of selection) {
      const b = new THREE.Box3();
      if (e.piece) b.copy(pieceBox(e.obj, e.piece));
      else if (e.instanceId != null && e.obj.isInstancedMesh) {
        e.obj.getMatrixAt(e.instanceId, _m);
        const g = e.obj.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        b.copy(g.boundingBox).applyMatrix4(_m).applyMatrix4(e.obj.matrixWorld);
      } else b.setFromObject(e.obj);
      if (b.isEmpty()) continue;
      const helper = new THREE.Box3Helper(b, selection.length > 1 ? 0x7ee0ff : 0xf2b64a);
      helper.material.depthTest = false;
      helper.renderOrder = 998;
      engine.scene.add(helper);
      boxes.push(helper);
    }
  }

  function selectEntries(list) {
    selection = list;
    showBoxes();
    paint();
  }

  function candidates(e) {
    ray.setFromCamera(ndc(e), engine.camera);
    return ray.intersectObjects(engine.scene.children, true).filter((h) => isPickable(h.object));
  }

  function topChain(obj) {
    const chain = [];
    let o = obj;
    while (o && o !== engine.scene) { chain.unshift(o); o = o.parent; }
    return chain;
  }

  function levelsFor(chain, instanceId, faceIndex) {
    const levels = chain.map((o) => ({ kind: 'obj', obj: o }));
    const leaf = chain[chain.length - 1];
    if (instanceId != null) levels.push({ kind: 'instance', obj: leaf, instanceId });
    else if (faceIndex != null && leaf.isMesh && leaf.geometry) {
      const pk = piecesOf(leaf.geometry);
      if (pk) levels.push({ kind: 'piece', obj: leaf, pieceIndex: pk.faceToPiece(faceIndex), pack: pk });
    }
    return levels;
  }

  function entryFromLevel(nav) {
    const lv = nav.levels[nav.depth];
    return makeEntry(
      lv.obj, lv.kind === 'instance' ? lv.instanceId : null,
      lv.kind === 'piece' ? lv.pack.pieces[lv.pieceIndex] : null,
      lv.kind === 'piece' ? lv.pieceIndex : null,
      lv.kind === 'piece' ? lv.pack.pieces.length : 0,
      nav.depth, nav,
    );
  }

  function hideSel() {
    for (const e of selection) {
      if (e.instanceId != null || e.piece) continue;
      inspectUndo.push({ kind: 'vis', obj: e.obj, prev: e.obj.visible });
      e.obj.visible = !e.obj.visible;
    }
    paint();
  }

  // =========================================================================
  // pointer + keyboard
  // =========================================================================

  function onDown(e) {
    if (preview) return;
    if (onCamDown(e)) return;
    if (e.button !== 0) return;

    if (tab === 'build') {
      if (armed) { e.stopPropagation(); e.preventDefault(); placeGhost(e); return; }
      const zone = pickZone(e);
      if (zone) {
        e.stopPropagation(); e.preventDefault();
        begin(zone.kind === 'zone-size' ? 'resize zone' : 'move zone');
        dragging = true;
        dragKind = zone.kind;
        dragOp = zone.zone;
        sel.clear();
        paint();
        return;
      }
      const ids = pickLayout(e);
      if (ids.length) {
        e.stopPropagation(); e.preventDefault();
        const same = lastPick && Math.hypot(e.clientX - lastPick.x, e.clientY - lastPick.y) < 6;
        const index = e.altKey ? ((same ? lastPick.index : 0) + 1) % ids.length : 0;
        lastPick = { x: e.clientX, y: e.clientY, index };
        const id = ids[index];
        if (e.shiftKey) sel.add(id);
        else if (e.ctrlKey || e.metaKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
        else if (!sel.has(id)) { sel.clear(); sel.add(id); }
        const o = opAt(id);
        if (o?.lock) { game.toast('That prop is locked (L unlocks)'); drawGizmos(); paint(); return; }
        begin(`move ${sel.size} item${sel.size === 1 ? '' : 's'}`);
        dragging = true;
        dragKind = 'props';
        const f = pickFloor(e);
        dragStart = f ? [f.x, f.z] : null;
        dragOp = { alt: e.altKey };
        drawGizmos();
        paint();
        return;
      }
      // empty floor: marquee
      e.stopPropagation(); e.preventDefault();
      marquee = { x0: e.clientX, y0: e.clientY, el: document.createElement('div') };
      marquee.el.className = 'cove-ed-marquee';
      root.appendChild(marquee.el);
      return;
    }

    if (tab === 'numbers') {
      if (!pins.length) return;
      ray.setFromCamera(ndc(e), engine.camera);
      const hits = ray.intersectObjects(pins.map((p) => p.mesh), true);
      if (!hits.length) return;
      e.stopPropagation(); e.preventDefault();
      let o = hits[0].object;
      while (o && !pins.some((p) => p.mesh === o)) o = o.parent;
      pin = pins.find((p) => p.mesh === o) || null;
      if (!pin) return;
      pinShift = e.shiftKey;
      pinDragStart = [pin.mesh.position.x, pin.mesh.position.z];
      plane.constant = -(pin.y + 0.05);
      if (ray.ray.intersectPlane(plane, hit)) grab.copy(pin.mesh.position).sub(hit);
      dragging = true;
      dragKind = 'pin';
      paint();
      return;
    }

    // inspect
    const list = candidates(e);
    const onSelection = list.find((h) => selection.some((s) => s.obj === h.object
      && (s.instanceId == null || s.instanceId === h.instanceId)));
    if (onSelection && !e.altKey) {
      e.stopPropagation(); e.preventDefault();
      startInspectDrag(e);
      return;
    }
    if (!list.length) {
      e.stopPropagation(); e.preventDefault();
      marquee = { x0: e.clientX, y0: e.clientY, el: document.createElement('div') };
      marquee.el.className = 'cove-ed-marquee';
      root.appendChild(marquee.el);
      return;
    }
    e.stopPropagation(); e.preventDefault();
    const same = lastPick && Math.hypot(e.clientX - lastPick.x, e.clientY - lastPick.y) < 6;
    const index = e.altKey ? ((same ? lastPick.index : 0) + 1) % list.length : 0;
    lastPick = { x: e.clientX, y: e.clientY, index };
    const h = list[index];
    const chain = topChain(h.object);
    const levels = levelsFor(chain, h.instanceId ?? null, h.faceIndex ?? null);
    // An InstancedMesh's "whole prop" is the room's ENTIRE batch (every bench
    // at once), so a click starts at the single instance that was hit; Tab
    // still wraps up to the batch. Authored groups and welded pieces keep the
    // whole-prop-first order, where depth 0 really is one prop.
    const depth = levels[levels.length - 1]?.kind === 'instance' ? levels.length - 1 : 0;
    selectEntries([entryFromLevel({ chain, levels, depth })]);
    startInspectDrag(e);
  }

  function startInspectDrag(e) {
    if (!selection.length) return;
    const cur = entryPos(selection[0]);
    plane.constant = -cur.y;
    ray.setFromCamera(ndc(e), engine.camera);
    if (ray.ray.intersectPlane(plane, hit)) grab.copy(cur).sub(hit);
    dragStart = [cur.x, cur.z];
    dragging = true;
    dragKind = 'inspect';
  }

  function onMove(e) {
    if (preview) return;
    if (onCamMove(e)) return;
    if (armed) { moveGhost(e); return; }
    if (marquee) {
      const x = Math.min(marquee.x0, e.clientX), y = Math.min(marquee.y0, e.clientY);
      const w = Math.abs(e.clientX - marquee.x0), h = Math.abs(e.clientY - marquee.y0);
      Object.assign(marquee.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      return;
    }
    if (!dragging) return;

    if (dragKind === 'props') {
      const f = pickFloor(e);
      if (!f || !dragStart) return;
      moveSel(f.x - dragStart[0], f.z - dragStart[1], 0, dragOp?.alt || e.altKey);
      dragStart = [f.x, f.z];
      refresh(false);
      return;
    }
    if (dragKind === 'zone-move' || dragKind === 'zone-size') {
      const f = pickFloor(e);
      if (!f) return;
      const o = opAt(dragOp.id);
      if (!o) return;
      if (dragKind === 'zone-move') {
        const g = GRIDS[snapGrid];
        o.x = +(g && !e.altKey ? Math.round(f.x / g) * g : f.x).toFixed(2);
        o.z = +(g && !e.altKey ? Math.round(f.z / g) * g : f.z).toFixed(2);
      } else {
        const c = zoneCentre(dragOp);
        o.r = +THREE.MathUtils.clamp(Math.hypot(f.x - (o.x ?? c.x), f.z - (o.z ?? c.z)), 0.2, 8).toFixed(2);
      }
      refresh(true);
      return;
    }

    ray.setFromCamera(ndc(e), engine.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    if (dragKind === 'pin' && pin) {
      pin.mesh.position.x = hit.x + grab.x;
      pin.mesh.position.z = hit.z + grab.z;
      paint();
    } else if (dragKind === 'inspect' && selection.length) {
      const cur = entryPos(selection[0]);
      applyDelta({ dx: hit.x + grab.x - cur.x, dz: hit.z + grab.z - cur.z }, false);
    }
  }

  function onUp() {
    camDrag = null;
    if (marquee) {
      const r = marquee.el.getBoundingClientRect();
      marquee.el.remove();
      marquee = null;
      if (r.width > 6 && r.height > 6) marqueeSelect(r);
      else if (tab === 'build') { sel.clear(); drawGizmos(); paint(); }
      return;
    }
    if (!dragging) return;
    dragging = false;
    const kind = dragKind;
    dragKind = null;
    if (kind === 'pin' && pin) { commitPin(pin, pin.mesh.position.x, pin.mesh.position.z); return; }
    if (kind === 'props') { commit({ rebuild: true }); return; }
    if (kind === 'zone-move' || kind === 'zone-size') { commit({ rebuild: true }); return; }
    if (kind === 'inspect' && selection.length && dragStart) {
      const cur = entryPos(selection[0]);
      const d = { dx: cur.x - dragStart[0], dz: cur.z - dragStart[1] };
      if (Math.abs(d.dx) > 0.001 || Math.abs(d.dz) > 0.001) inspectUndo.push({ kind: 'delta', entries: selection.slice(), d });
    }
  }

  function marqueeSelect(rect) {
    const v = new THREE.Vector3();
    const inBand = (p) => {
      const q = p.clone().project(engine.camera);
      if (q.z > 1) return false;
      const sx = (q.x * 0.5 + 0.5) * innerWidth;
      const sy = (-q.y * 0.5 + 0.5) * innerHeight;
      return sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom;
    };
    if (tab === 'build') {
      sel.clear();
      // the layout's own registries, not scene.children: a top-level-only walk
      // selects almost nothing in rooms whose geometry lives in batches
      for (const d of dataProps()) {
        if (opAt(d.id)?.lock) continue;
        if (inBand(d.obj.getWorldPosition(v))) sel.add(d.id);
      }
      if (room.tagged instanceof Map) {
        for (const [id, obj] of room.tagged) if (obj && inBand(obj.getWorldPosition(v))) sel.add(`tag:${id}`);
      }
      drawGizmos();
      paint();
      game.toast(sel.size ? `${sel.size} selected` : 'Nothing in the box');
      return;
    }
    // Never grab a batch whole from a marquee: rooms keep ALL their benches in
    // one InstancedMesh (or one merged mesh), usually with its origin at 0,0,
    // so the old whole-object origin test swept every bench in the room into
    // the selection and a drag moved all of them at once.
    const picked = [];
    const CAP = 400;
    for (const child of engine.scene.children) {
      if (!isPickable(child)) continue;
      if (child.isInstancedMesh) {
        for (let i = 0; i < child.count && picked.length <= CAP; i++) {
          child.getMatrixAt(i, _m);
          if (inBand(child.localToWorld(v.setFromMatrixPosition(_m)))) picked.push(makeEntry(child, i));
        }
        continue;
      }
      const pk = child.isMesh && child.geometry ? piecesOf(child.geometry) : null;
      if (pk && pk.pieces.length > 1) {
        for (let i = 0; i < pk.pieces.length && picked.length <= CAP; i++) {
          const p = pk.pieces[i];
          if (inBand(v.copy(p.center).applyMatrix4(child.matrixWorld))) picked.push(makeEntry(child, null, p, i, pk.pieces.length));
        }
        continue;
      }
      // plain prop: test the centre of its bounds, not its origin, so a group
      // authored about the room origin is only caught where it actually sits
      const b = new THREE.Box3().setFromObject(child);
      if (!b.isEmpty() && inBand(b.getCenter(v))) picked.push(makeEntry(child));
    }
    if (picked.length > CAP) { game.toast('Box too big, grabbed nothing'); return; }
    selectEntries(picked);
    game.toast(picked.length ? `${picked.length} selected` : 'Nothing in the box');
  }

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (armed) { disarm(); return; }
      if (preview) { setPreview(false); return; }
      teardown();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { e.preventDefault(); e.stopPropagation(); redo(); return; }
    if (k === 'p' || k === 'P') {
      if (e.shiftKey) { if (tab === 'build') { e.preventDefault(); cycleSpawnViews(); } return; }
      e.preventDefault(); setPreview(!preview); return;
    }
    if (preview) return;
    if (k === 'f' || k === 'F') { e.preventDefault(); camFrame(); return; }

    const step = e.shiftKey ? 0.5 : 0.05;

    if (tab === 'build') {
      if ((e.ctrlKey || e.metaKey) && (k === 'd' || k === 'D')) { e.preventDefault(); duplicateSel(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'g' || k === 'G')) {
        e.preventDefault();
        const ids = [...sel].filter((id) => !id.startsWith('tag:'));
        if (ids.length > 1) edit('group', () => putOp({ op: 'group', id: mint('g'), name: `group ${groupOps().length + 1}`, members: ids }));
        return;
      }
      if (k >= '1' && k <= '9') {
        e.preventDefault();
        if (e.shiftKey) setBookmark(k); else goBookmark(k);
        return;
      }
      if (k === 'S' && e.shiftKey) { e.preventDefault(); saveStaticCam(); return; }
      // With the grid on, a nudge is ONE CELL: a 0.05 nudge that snaps back to
      // the same cell is a dead key, which is what a naive step does here.
      const cell = GRIDS[snapGrid];
      const mv = e.altKey || !cell ? step : cell * (e.shiftKey ? 4 : 1);
      const acts = {
        ArrowUp: () => moveSel(0, -mv, 0, e.altKey), ArrowDown: () => moveSel(0, mv, 0, e.altKey),
        ArrowLeft: () => moveSel(-mv, 0, 0, e.altKey), ArrowRight: () => moveSel(mv, 0, 0, e.altKey),
        PageUp: () => moveSel(0, 0, step), PageDown: () => moveSel(0, 0, -step),
        // Shift turns the whole selection about its own pivot, not each item
        '[': () => rotateSel(-(snapAngle || Math.PI / 36), e.shiftKey),
        ']': () => rotateSel(snapAngle || Math.PI / 36, e.shiftKey),
        '-': () => scaleSel(e.shiftKey ? 0.8 : 0.95, e.shiftKey),
        '=': () => scaleSel(e.shiftKey ? 1.25 : 1.0526, e.shiftKey),
        Delete: () => deleteSel(),
        Backspace: () => deleteSel(),
      };
      if (acts[k]) {
        e.preventDefault(); e.stopPropagation();
        edit(`edit ${sel.size} item${sel.size === 1 ? '' : 's'}`, acts[k], { rebuild: k === 'Delete' || k === 'Backspace' });
        return;
      }
      if (k === 'g' || k === 'G') {
        e.preventDefault();
        snapGrid = (snapGrid + 1) % GRIDS.length;
        game.toast(GRIDS[snapGrid] ? `Grid ${GRIDS[snapGrid]}` : 'Grid off');
        paint();
        return;
      }
      if (k === 'z' || k === 'Z') { e.preventDefault(); zonesOn = !zonesOn; drawGizmos(); paint(); return; }
      if (k === 'v' || k === 'V') { e.preventDefault(); walkCheck(); return; }
      if (k === 'l' || k === 'L') {
        e.preventDefault();
        edit('lock', () => {
          for (const id of sel) { const o = opAt(id); if (o) { if (o.lock) delete o.lock; else o.lock = true; } }
        });
        return;
      }
      if (k === 'a' || k === 'A') {
        e.preventDefault();
        const c = cam.target;
        addCollider({ x: c.x, z: c.z });
        return;
      }
      return;
    }

    if (tab === 'numbers') {
      if (!pin) return;
      if (k === '[' || k === ']') {
        if (pin.key !== 'at' || pin.yaw == null) return;
        e.preventDefault(); e.stopPropagation();
        commitPin(pin, 0, 0, (k === '[' ? -1 : 1) * (e.shiftKey ? 4 : 1) * Math.PI / 36);
        return;
      }
      const d = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[k];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      pinDragStart = [pin.mesh.position.x, pin.mesh.position.z];
      pinShift = false;
      commitPin(pin, pin.mesh.position.x + d[0], pin.mesh.position.z + d[1]);
      return;
    }

    if (!selection.length) return;
    const acts = {
      ArrowUp: () => applyDelta({ dz: -step }), ArrowDown: () => applyDelta({ dz: step }),
      ArrowLeft: () => applyDelta({ dx: -step }), ArrowRight: () => applyDelta({ dx: step }),
      PageUp: () => applyDelta({ dy: step }), PageDown: () => applyDelta({ dy: -step }),
      '[': () => applyDelta({ dyaw: -(e.shiftKey ? 4 : 1) * Math.PI / 36 }),
      ']': () => applyDelta({ dyaw: (e.shiftKey ? 4 : 1) * Math.PI / 36 }),
      '-': () => applyDelta({ ds: e.shiftKey ? 0.8 : 0.95 }),
      '=': () => applyDelta({ ds: e.shiftKey ? 1.25 : 1.0526 }),
      Tab: () => {
        const nav = selection[0]?.nav;
        if (!nav || selection.length !== 1) return;
        const next = ((nav.depth + (e.shiftKey ? -1 : 1)) % nav.levels.length + nav.levels.length) % nav.levels.length;
        selectEntries([entryFromLevel({ ...nav, depth: next })]);
      },
      h: () => hideSel(), H: () => hideSel(),
    };
    const fn = acts[k];
    if (!fn) return;
    e.preventDefault(); e.stopPropagation();
    fn();
  }

  // =========================================================================
  // panel
  // =========================================================================

  function setHint(text, ms = 0) {
    if (hint) { hint.remove(); hint = null; }
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    if (!text) return;
    hint = document.createElement('div');
    hint.className = 'cove-ed-hint';
    hint.textContent = text;
    root.appendChild(hint);
    if (ms) hintTimer = setTimeout(() => setHint(''), ms);
  }
  let hintTimer = null;

  /**
   * A 96x96 render of the REAL prop, once per catalog id, cached for the
   * session. A GPU readback is not free, so they are rendered a couple per
   * frame behind a queue and the cards fill in as they land.
   */
  const thumbQ = [];
  let thumbPump = null;

  function thumb(id) {
    if (thumbs.has(id)) return thumbs.get(id);
    if (!thumbQ.includes(id)) thumbQ.push(id);
    if (!thumbPump) {
      thumbPump = requestAnimationFrame(function pump() {
        for (let n = 0; n < 2 && thumbQ.length; n++) renderThumb(thumbQ.shift());
        thumbPump = thumbQ.length ? requestAnimationFrame(pump) : null;
        if (!preview && tab === 'build') paint();
      });
    }
    return '';
  }

  function renderThumb(id) {
    let url = '';
    try {
      const obj = buildProp(id);
      if (obj) {
        const sc = new THREE.Scene();
        sc.add(new THREE.AmbientLight(0xffffff, 0.85));
        const dl = new THREE.DirectionalLight(0xffffff, 1.1);
        dl.position.set(3, 5, 4);
        sc.add(dl, obj);
        const b = new THREE.Box3().setFromObject(obj);
        const c = b.getCenter(new THREE.Vector3());
        const r = Math.max(0.6, b.getSize(new THREE.Vector3()).length() * 0.5);
        const cm = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
        cm.position.set(c.x + r * 2.1, c.y + r * 1.5, c.z + r * 2.4);
        cm.lookAt(c);
        const rt = new THREE.WebGLRenderTarget(96, 96);
        const prev = engine.renderer.getRenderTarget();
        const prevClear = engine.renderer.getClearColor(new THREE.Color());
        const prevAlpha = engine.renderer.getClearAlpha();
        engine.renderer.setRenderTarget(rt);
        engine.renderer.setClearColor(0x000000, 0);
        engine.renderer.clear();
        engine.renderer.render(sc, cm);
        const buf = new Uint8Array(96 * 96 * 4);
        engine.renderer.readRenderTargetPixels(rt, 0, 0, 96, 96, buf);
        engine.renderer.setRenderTarget(prev);
        engine.renderer.setClearColor(prevClear, prevAlpha); // never leave the main pass changed
        const cv = document.createElement('canvas');
        cv.width = 96; cv.height = 96;
        const img = cv.getContext('2d').createImageData(96, 96);
        for (let y = 0; y < 96; y++) {
          const src = (95 - y) * 96 * 4;
          img.data.set(buf.subarray(src, src + 96 * 4), y * 96 * 4);
        }
        cv.getContext('2d').putImageData(img, 0, 0);
        url = cv.toDataURL();
        rt.dispose();
        disposeObject(obj);
      }
    } catch (err) {
      console.warn('[editor] thumbnail failed', id, err?.message || err);
    }
    thumbs.set(id, url);
  }

  function row(cls, html, onclick) {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    if (onclick) d.onclick = onclick;
    return d;
  }

  function paintBuild() {
    body.innerHTML = '';
    body.appendChild(row('ed-keys', KEYS.build));

    // toggles
    const chips = document.createElement('div');
    chips.className = 'ed-chips';
    const chip = (label, on, fn) => {
      const b = document.createElement('button');
      b.className = `ed-pill${on ? ' on' : ''}`;
      b.textContent = label;
      b.onclick = fn;
      chips.appendChild(b);
    };
    chip(GRIDS[snapGrid] ? `grid ${GRIDS[snapGrid]}` : 'grid off', !!GRIDS[snapGrid], () => { snapGrid = (snapGrid + 1) % GRIDS.length; paint(); });
    chip(snapAngle ? `angle ${Math.round(snapAngle * 180 / Math.PI)}` : 'angle free', !!snapAngle,
      () => { snapAngle = snapAngle === Math.PI / 12 ? Math.PI / 36 : snapAngle === Math.PI / 36 ? 0 : Math.PI / 12; paint(); });
    chip('zones', zonesOn, () => { zonesOn = !zonesOn; drawGizmos(); paint(); });
    chip('undo', false, () => undo());
    chip('redo', false, () => redo());
    body.appendChild(chips);

    // palette
    const groups = document.createElement('div');
    groups.className = 'ed-chips';
    for (const g of PROP_GROUPS) {
      const b = document.createElement('button');
      b.className = `ed-pill${group === g.id ? ' on' : ''}`;
      b.textContent = g.name;
      b.onclick = () => { group = g.id; paint(); };
      groups.appendChild(b);
    }
    body.appendChild(groups);

    const q = document.createElement('input');
    q.className = 'ed-in';
    q.placeholder = 'Search props';
    q.value = search;
    q.oninput = () => { search = q.value.toLowerCase(); paintCards(); };
    body.appendChild(q);

    const cards = document.createElement('div');
    cards.className = 'ed-cards';
    body.appendChild(cards);
    const paintCards = () => {
      cards.innerHTML = '';
      const list = PROP_IDS.filter((id) => (search
        ? (PROPS[id].name.toLowerCase().includes(search) || id.includes(search))
        : PROPS[id].group === group));
      for (const id of list) {
        const meta = PROPS[id];
        const b = document.createElement('button');
        b.className = `ed-card${armed === id ? ' on' : ''}`;
        const src = thumb(id);
        b.innerHTML = `${src ? `<img alt="" src="${src}">` : '<span class="ed-chip"></span>'}`
          + `<span><b>${meta.name}</b><i>${meta.footprint.w}x${meta.footprint.d}${meta.animated ? ' - lively' : ''}</i></span>`;
        b.onclick = () => arm(id);
        cards.appendChild(b);
      }
      if (!list.length) cards.appendChild(row('ed-row', 'No prop by that name'));
    };
    paintCards();

    // placed things
    const list = document.createElement('div');
    list.className = 'ed-list';
    const items = [...propOps(), ...colliderOps(), ...hotspotOps()];
    for (const o of items) {
      const name = o.op === 'prop' ? PROPS[o.cat]?.name || o.cat
        : o.op === 'collider' ? `collider r${o.r}`
          : `${o.kind || 'zone'} ${o.to || ''}`;
      const at = o.op === 'prop' ? `${f2(o.p[0])}, ${f2(o.p[2])}` : `${f2(o.x ?? 0)}, ${f2(o.z ?? 0)}`;
      const r = row(`ed-row${sel.has(o.id) ? ' on' : ''}`,
        `<span class="ed-dot" style="background:${o.op === 'prop' ? '#f2b64a' : o.op === 'collider' ? '#e8657a' : '#7ee0ff'}"></span>`
        + `<span>${name}${o.lock ? ' (locked)' : ''}</span><span class="ed-xz">${at}</span><span class="ed-x">x</span>`,
        (ev) => {
          if (ev.target.classList.contains('ed-x')) {
            edit('remove', () => { dropOp(o); sel.delete(o.id); }, { rebuild: true });
            return;
          }
          if (!ev.shiftKey) sel.clear();
          sel.add(o.id);
          drawGizmos();
          paint();
        });
      list.appendChild(r);
    }
    if (!items.length) list.appendChild(row('ed-row', 'Nothing placed yet: pick a card above'));
    body.appendChild(list);

    // selection detail + align
    const info = document.createElement('div');
    info.className = 'ed-sel';
    if (!sel.size) info.textContent = 'Nothing selected';
    else if (sel.size === 1) {
      const o = opAt([...sel][0]);
      info.innerHTML = o
        ? `${o.op === 'prop' ? PROPS[o.cat]?.name : o.op}<br><span>${o.op === 'prop'
          ? `${f2(o.p[0])}, ${f2(o.p[2])} &nbsp; ${deg(o.ry || 0)} &nbsp; x${(o.s || 1).toFixed(2)}` : o.id}</span>`
        : `${[...sel][0]}`;
    } else info.innerHTML = `${sel.size} selected<br><span>[ ] turns each, Shift+[ ] turns the group</span>`;
    body.appendChild(info);

    if (sel.size > 1) {
      const al = document.createElement('div');
      al.className = 'ed-chips';
      for (const [label, how] of [['left', 'x-'], ['right', 'x+'], ['near', 'z+'], ['far', 'z-'],
        ['mid X', 'cx'], ['mid Z', 'cz'], ['space X', 'dx'], ['space Z', 'dz']]) {
        const b = document.createElement('button');
        b.className = 'ed-pill';
        b.textContent = label;
        b.onclick = () => alignSel(how);
        al.appendChild(b);
      }
      body.appendChild(al);
    }

    if (zonesOn) body.appendChild(zoneForm());

    // history
    if (history.length) {
      const h = document.createElement('div');
      h.className = 'ed-list';
      for (const rev of history.slice(0, 6)) {
        h.appendChild(row('ed-row', `<span class="ed-dot" style="background:#9c8f76"></span><span>rev ${rev.rev} by ${rev.by || '?'}</span>`
          + `<span class="ed-xz">${rev.ops ?? '?'} ops</span>`, () => revert(rev.rev)));
      }
      body.appendChild(h);
    }

    const foot = document.createElement('div');
    foot.className = 'ed-chips';
    for (const [label, fn] of [['discard my draft', discardDraft], ['reset room to code', resetRoom]]) {
      const b = document.createElement('button');
      b.className = 'ed-pill';
      b.textContent = label;
      b.onclick = fn;
      foot.appendChild(b);
    }
    body.appendChild(foot);
  }

  function zoneForm() {
    const wrap = document.createElement('div');
    const kind = document.createElement('select');
    kind.className = 'ed-in';
    kind.innerHTML = '<option value="exit">exit to a room</option><option value="game">start a minigame</option><option value="sign">a sign to read</option>';
    const to = document.createElement('select');
    to.className = 'ed-in';
    const label = document.createElement('input');
    label.className = 'ed-in';
    label.placeholder = 'Prompt label';
    const fillTo = () => {
      to.innerHTML = '';
      const opts = kind.value === 'exit' ? ROOM_IDS.filter((r) => r !== room.id)
        : kind.value === 'game' ? Object.keys(MINIGAMES) : [];
      to.style.display = opts.length ? '' : 'none';
      for (const o of opts) {
        const op = document.createElement('option');
        op.value = o;
        op.textContent = o;
        to.appendChild(op);
      }
    };
    kind.onchange = fillTo;
    fillTo();
    const add = document.createElement('button');
    add.className = 'ed-pill';
    add.textContent = 'add zone at the camera';
    add.onclick = () => addHotspot(kind.value, to.value || '', label.value || '', { x: cam.target.x, z: cam.target.z });
    const addC = document.createElement('button');
    addC.className = 'ed-pill';
    addC.textContent = 'add collider (A)';
    addC.onclick = () => addCollider({ x: cam.target.x, z: cam.target.z });
    wrap.appendChild(kind);
    wrap.appendChild(to);
    wrap.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'ed-chips';
    chips.appendChild(add);
    chips.appendChild(addC);
    wrap.appendChild(chips);
    return wrap;
  }

  function paintNumbers() {
    body.innerHTML = '';
    body.appendChild(row('ed-keys', KEYS.numbers));
    const list = document.createElement('div');
    list.className = 'ed-list';
    for (const p of pins) {
      list.appendChild(row(`ed-row${p === pin ? ' on' : ''}`,
        `<span class="ed-dot" style="background:${hex6(p.color)}"></span><span>${p.label}</span>`
        + `<span class="ed-xz">${f2(p.mesh.position.x)}, ${f2(p.mesh.position.z)}</span>`,
        () => { pin = p; paint(); }));
    }
    if (!pins.length) list.appendChild(row('ed-row', 'This room publishes no handles (see lounge.js STATIONS)'));
    body.appendChild(list);
    const info = document.createElement('div');
    info.className = 'ed-sel';
    info.textContent = pin ? pin.label : 'Nothing selected';
    body.appendChild(info);
    const out = document.createElement('textarea');
    out.readOnly = true;
    const rows = [];
    for (const o of ops) {
      if (o.op !== 'handle') continue;
      const bare = o.id.slice(o.id.indexOf('/') + 1);
      rows.push(room.editorExport?.(bare) || `${bare}: ${JSON.stringify(o.set)}`);
    }
    out.value = rows.length ? `// ${room.id}: paste into src/world/rooms/${room.id}.js\n${rows.join('\n')}` : '';
    body.appendChild(out);
    const copy = document.createElement('div');
    copy.className = 'ed-chips';
    const b = document.createElement('button');
    b.className = 'ed-pill';
    b.textContent = 'copy';
    b.onclick = () => copyText(out.value);
    copy.appendChild(b);
    body.appendChild(copy);
  }

  function paintInspect() {
    body.innerHTML = '';
    body.appendChild(row('ed-keys', KEYS.inspect));
    const list = document.createElement('div');
    list.className = 'ed-list';
    for (const [, rec] of edits) {
      list.appendChild(row(`ed-row${selection.includes(rec.entry) ? ' on' : ''}`,
        `<span class="ed-dot" style="background:#7ee0ff"></span><span>${rec.label}</span>`
        + `<span class="ed-xz">${f2(rec.to[0])}, ${f2(rec.to[2])}</span>`,
        () => selectEntries([rec.entry])));
    }
    if (!edits.size) list.appendChild(row('ed-row', 'Click a prop, or drag a box around several'));
    body.appendChild(list);

    const info = document.createElement('div');
    info.className = 'ed-sel';
    if (selection.length > 1) info.innerHTML = `${selection.length} objects selected<br><span>they move together; rotate and resize about their own centres</span>`;
    else if (selection.length === 1) {
      const e = selection[0];
      const c = entryPos(e);
      info.innerHTML = `${e.label}<br><span>${f2(c.x)}, ${f2(c.y)}, ${f2(c.z)} &nbsp; path ${e.path}</span>`;
    } else info.textContent = 'Nothing selected';
    body.appendChild(info);

    const out = document.createElement('textarea');
    out.readOnly = true;
    if (edits.size) {
      const lines = [`// ${room.id}: free edits (visual preview: find these in the room builder)`];
      for (const [path, r] of edits) {
        const d = [r.to[0] - r.from[0], r.to[1] - r.from[1], r.to[2] - r.from[2]];
        lines.push(`${r.label}  [${path}]`);
        lines.push(`  pos (${f2(r.to[0])}, ${f2(r.to[1])}, ${f2(r.to[2])})   moved (${f2(d[0])}, ${f2(d[1])}, ${f2(d[2])})`);
        if (Math.abs((r.toRot ?? 0) - (r.fromRot ?? 0)) > 0.001) lines.push(`  rotation.y ${deg(r.toRot)}  (turned ${deg(r.toRot - r.fromRot)})`);
        if (Math.abs((r.toScale ?? 1) - (r.fromScale ?? 1)) > 0.001) lines.push(`  scale ${f2(r.toScale)}`);
      }
      out.value = lines.join('\n');
    }
    body.appendChild(out);
    const chips = document.createElement('div');
    chips.className = 'ed-chips';
    const b = document.createElement('button');
    b.className = 'ed-pill';
    b.textContent = 'copy';
    b.onclick = () => copyText(out.value);
    chips.appendChild(b);
    body.appendChild(chips);
  }

  function copyText(text) {
    if (!text) { game.toast('Move something first'); return; }
    navigator.clipboard?.writeText(text).then(
      () => game.toast('Coordinates copied'),
      () => game.toast('Select and copy from the box'),
    );
  }

  /** Header only. The poll calls this: repainting the body would eat the
   *  search box's focus twice a second. */
  function paintHeader() {
    if (preview) return;
    const rev = curRev();
    const changes = room ? diffOps(published, ops) : { added: [], changed: [], removed: [] };
    const n = changes.added.length + changes.changed.length + changes.removed.length;
    $('ed-rev').textContent = `${room && isLayoutRoom(room.id) ? `rev ${rev}` : 'no layout'}${n ? ` - draft +${n}` : ''}${dirty ? '*' : ''}`;
    const calls = engine.renderer?.info?.render?.calls ?? 0;
    const rep = lastReport(room?.id);
    const bits = [];
    if (room) bits.push(`<b>${room.name}</b>`);
    bits.push(`${ops.length}/${LAYOUT_CAPS.ops} ops`);
    bits.push(`${calls} draws`);
    if (rep?.orphans?.length) bits.push(`<span class="ed-warn">${rep.orphans.length} orphaned</span>`);
    if (orphans.length) bits.push(`<span class="ed-warn">${orphans.length} server orphans</span>`);
    if (lock && lock.by) bits.push(`<span class="ed-warn">locked by ${lock.by}</span>`);
    if (!isLayoutRoom(room?.id)) bits.push('<span class="ed-warn">this room has no layout document</span>');
    $('ed-room').innerHTML = bits.join(' - ');
    $('ed-publish').disabled = !room || !isLayoutRoom(room.id) || !n;
    $('ed-preview').textContent = preview ? 'Edit' : 'Preview';
  }

  function paint() {
    if (preview) return;
    paintHeader();
    if (tab === 'build') paintBuild();
    else if (tab === 'numbers') paintNumbers();
    else paintInspect();
  }

  // ---- room sync -----------------------------------------------------------

  function sync(force = false) {
    if (!force && engine.room === room) return;
    room = engine.room;
    sel.clear();
    selection = [];
    pin = null;
    clearBoxes();
    clearGizmos();
    clearWalk();
    disarm();
    edits.clear();
    inspectUndo.length = 0;
    undoStack.length = 0;
    redoStack.length = 0;
    lastWalk = null;
    orphans = [];
    history = [];
    lock = null;
    dirty = false;
    if (room && isLayoutRoom(room.id)) {
      ops = normalizeOps(activeOps(room.id).map((o) => ({ ...o })));
      published = peekPublished();
      requestDoc();
    } else {
      ops = [];
      published = [];
    }
    buildPins();
    drawGizmos();
    paint();
  }

  function setTab(t) {
    tab = t;
    $('ed-t-build').classList.toggle('on', t === 'build');
    $('ed-t-numbers').classList.toggle('on', t === 'numbers');
    $('ed-t-inspect').classList.toggle('on', t === 'inspect');
    sel.clear();
    selection = [];
    clearBoxes();
    disarm();
    buildPins();
    drawGizmos();
    paint();
  }

  // ---- wiring --------------------------------------------------------------

  const noMenu = (e) => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
  canvas.addEventListener('contextmenu', noMenu);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('keydown', onKey, true);

  const offDoc = game.events.on('layout-doc', onDoc);
  const offAck = game.events.on('layout-ack', onAck);
  const offRev = game.events.on('layout-rev', onRev);
  const offMod = game.events.on('moderation', () => { if (!game.can('editor')) teardown(); });

  $('ed-t-build').onclick = () => setTab('build');
  $('ed-t-numbers').onclick = () => setTab('numbers');
  $('ed-t-inspect').onclick = () => setTab('inspect');
  $('ed-publish').onclick = publish;
  $('ed-preview').onclick = () => setPreview(!preview);
  $('ed-walk').onclick = () => walkCheck();
  $('ed-close').onclick = () => teardown();

  // B-4: room changes are polled because the engine emits no 'room-built'
  // event (game.events 'room' fires 220ms BEFORE the new room exists). One
  // cheap identity check twice a second; the body is not repainted.
  // The apply pass is loaded on a microtask, so an edit made in the first
  // instant would be primed nowhere. Re-push once it lands.
  loadOverlay().then((m) => {
    if (!alive || !m || !room) return;
    pushDraft();
    if (ops.length) refresh(true);
  });

  const poll = setInterval(() => { sync(); paintHeader(); }, 500);
  sync(true);
  camInit();
  game.toast('Level editor on. Ctrl+E to close.');

  open = true;
  teardown = () => {
    alive = false;
    clearInterval(poll);
    if (saveTimer) { clearTimeout(saveTimer); saveDraft(); }
    if (camFly) cancelAnimationFrame(camFly);
    canvas.removeEventListener('pointerdown', onDown, true);
    canvas.removeEventListener('wheel', onWheel, true);
    canvas.removeEventListener('contextmenu', noMenu);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('keydown', onKey, true);
    offDoc?.(); offAck?.(); offRev?.(); offMod?.();
    marquee?.el.remove();
    setHint('');
    engine.camLock = false;
    engine.setCameraMode ? engine.setCameraMode(savedMode) : (engine.cameraMode = savedMode);
    clearPins();
    clearBoxes();
    clearGizmos();
    clearWalk();
    disarm();
    pinGeo.dispose();
    knobGeo.dispose();
    el.remove();
    open = false;
    teardown = null;
  };
}
