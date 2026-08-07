import * as THREE from 'three';
import { setOverride, clearOverrides, getOverrides, getOverride } from '../world/layout.js';

/**
 * Dev layout editor (Ctrl+E). Two modes, because rooms are built two ways.
 *
 * HANDLES (authored, exact): a room publishes its layout numbers through
 * `editorHandles(id)`; each is a pin. Dropping one rewrites the number and
 * REBUILDS the room, so the sign, chairs, prompt zones and colliders derived
 * from it all follow. `editorExport(id)` returns the pasteable row.
 *
 * FREE (every room, no opt-in): pick anything worth moving. Click selects the
 * whole prop; Tab drills to its parts, then to one instance of an
 * InstancedMesh or one welded piece of a merged mesh (merged props keep no
 * record of their parts, so the seams are found with union-find over the
 * geometry). Left-drag on empty space marquee-selects; the set then moves
 * together. Ctrl+Z undoes. Free edits are a VISUAL preview: nothing derived
 * from a number follows, and they last only for this visit, so read the
 * numbers out of the panel and put them in the room file.
 *
 * Deliberately unpickable: floors and walls (a room's groundMeshes), anything
 * room-sized, particle systems, lines, sprites and glow overlays. Level-wide
 * geometry is scenery you tune in code, and it used to swallow every click.
 */

const STYLE_ID = 'cove-ed-styles';
const CSS = `
.cove-ed {
  position: absolute; top: 64px; left: 14px; width: 340px; z-index: 55;
  background: rgba(28, 24, 18, 0.94); color: #fff6e3; border-radius: 16px;
  padding: 14px 16px; font-family: var(--font); font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto;
}
.cove-ed h3 { font-size: 14px; margin: 0 0 2px; color: #f2b64a; letter-spacing: .03em; }
.cove-ed .ed-sub { color: #b8a888; font-size: 11.5px; margin-bottom: 9px; }
.cove-ed .ed-tabs { display: flex; gap: 4px; background: rgba(255,255,255,.07); padding: 4px; border-radius: 999px; margin-bottom: 9px; }
.cove-ed .ed-tab { flex: 1; border: 0; background: transparent; color: #b8a888; font-family: var(--font);
  font-weight: 800; font-size: 12px; padding: 6px 8px; border-radius: 999px; cursor: pointer; }
.cove-ed .ed-tab.on { background: #f2b64a; color: #2d2417; }
.cove-ed .ed-keys { color: #b8a888; font-size: 11px; line-height: 1.5; margin-bottom: 9px; }
.cove-ed .ed-keys b { color: #fff6e3; font-weight: 700; }
.cove-ed .ed-list { max-height: 112px; overflow-y: auto; margin-bottom: 9px;
  border-radius: 10px; background: rgba(255,255,255,.05); padding: 4px; }
.cove-ed .ed-row { display: flex; align-items: center; gap: 7px; padding: 4px 7px; border-radius: 8px;
  cursor: pointer; font-size: 11.5px; white-space: nowrap; }
.cove-ed .ed-row:hover { background: rgba(255,255,255,.09); }
.cove-ed .ed-row.on { background: rgba(242,182,74,.22); font-weight: 700; }
.cove-ed .ed-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.cove-ed .ed-xz { margin-left: auto; color: #b8a888; font-family: ui-monospace, Consolas, monospace; }
.cove-ed .ed-sel { background: rgba(255,255,255,.07); border-radius: 10px; padding: 7px 10px;
  margin-bottom: 9px; font-weight: 700; min-height: 30px; font-size: 11.5px; }
.cove-ed .ed-sel span { color: #7ee0ff; font-weight: 400; font-family: ui-monospace, Consolas, monospace; }
.cove-ed textarea { width: 100%; height: 84px; resize: vertical; border: 0; border-radius: 10px;
  padding: 8px 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  background: #12100c; color: #cfe8b0; line-height: 1.45; }
.cove-ed .ed-btns { display: flex; gap: 6px; margin-top: 9px; }
.cove-ed button.ed-b { flex: 1; border: 0; border-radius: 999px; padding: 7px 8px; cursor: pointer;
  font-family: var(--font); font-weight: 800; font-size: 12px; background: #f2b64a; color: #2d2417; }
.cove-ed button.ghost { background: rgba(255,255,255,.14); color: #fff6e3; }
.cove-ed button.ed-b:hover { filter: brightness(1.08); }
.cove-ed button.ed-b:disabled { opacity: .4; cursor: default; filter: none; }
.cove-ed-marquee { position: absolute; z-index: 54; border: 2px dashed #f2b64a;
  background: rgba(242,182,74,.12); pointer-events: none; }
`;

let open = false;
let teardown = null;

export function toggleEditor(game) {
  if (open) { teardown?.(); return false; }
  openEditor(game);
  return true;
}

const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(1)}deg`;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _yaw = (rad) => new THREE.Quaternion().setFromAxisAngle(_up, rad);

/** Room-sized geometry is scenery, not furniture: never pick it. */
const HUGE = 15;

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

function openEditor(game) {
  const engine = game.engine;
  if (!engine?.scene) { game.toast('Nothing to edit yet'); return; }

  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const el = document.createElement('div');
  el.className = 'cove-ed';
  el.innerHTML = `
    <h3>Layout editor</h3>
    <div class="ed-sub" id="ed-room"></div>
    <div class="ed-tabs">
      <button class="ed-tab on" id="ed-t-handles">Handles</button>
      <button class="ed-tab" id="ed-t-free">Free (anything)</button>
    </div>
    <div class="ed-keys" id="ed-keys"></div>
    <div class="ed-list" id="ed-list"></div>
    <div class="ed-sel" id="ed-selinfo">Nothing selected</div>
    <textarea id="ed-out" readonly placeholder="Move something and the numbers appear here."></textarea>
    <div class="ed-btns">
      <button class="ed-b" id="ed-copy">Copy</button>
      <button class="ed-b ghost" id="ed-undo" disabled>Undo</button>
      <button class="ed-b ghost" id="ed-reset">Reset</button>
      <button class="ed-b ghost" id="ed-close">Close</button>
    </div>`;
  document.getElementById('overlay-root').appendChild(el);

  const $ = (id) => el.querySelector(`#${id}`);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const grab = new THREE.Vector3();

  let mode = 'handles';
  let room = null;
  let pins = [];
  let sel = null;              // handles mode
  let selection = [];          // free mode: entries, [0] is primary
  let boxes = [];
  let dragging = false;
  let dragStart = null;
  let shiftDrag = false;
  let lastPick = null;         // { x, y, index } for click-through cycling
  const edits = new Map();     // path -> record for the export panel
  const undoStack = [];
  let marquee = null;          // { x0, y0, el }

  const pinGeo = new THREE.ConeGeometry(0.16, 0.5, 10);
  const knobGeo = new THREE.SphereGeometry(0.1, 10, 8);

  const KEYS = {
    handles: '<b>Drag a pin</b> to move that number - <b>Shift-drag</b> the gold prop pin moves a whole station<br><b>Arrows</b> nudge (Shift = 0.5), <b>[ ]</b> turn the prop, <b>Ctrl+Z</b> undo - <b>Esc</b> closes.',
    free: '<b>Click</b> a prop, <b>drag</b> it - <b>drag empty space</b> to box-select - <b>Alt+click</b> for what is behind<br><b>Tab</b> drills in (part, instance, welded piece) - <b>arrows</b> nudge, <b>PgUp/Dn</b> height, <b>[ ]</b> rotate, <b>- =</b> resize, <b>H</b> hide<br><b>Wheel</b> zoom, <b>right-drag</b> orbit, <b>middle/Shift-right</b> pan, <b>F</b> frame, <b>Ctrl+Z</b> undo',
  };

  // ---- editor camera -------------------------------------------------------
  const cam = { target: new THREE.Vector3(), dist: 18, yaw: 0, pitch: 0.9 };
  const savedMode = engine.cameraMode;
  let camDrag = null;

  function camInit() {
    cam.target.copy(engine.playerAvatar?.group.position || new THREE.Vector3());
    const off = engine.camera.position.clone().sub(cam.target);
    cam.dist = Math.max(3, off.length());
    cam.yaw = Math.atan2(off.x, off.z);
    cam.pitch = Math.asin(THREE.MathUtils.clamp(off.y / (off.length() || 1), -0.99, 0.99));
    camApply();
  }

  function camApply() {
    const cp = Math.cos(cam.pitch);
    engine._staticCam = {
      position: new THREE.Vector3(
        cam.target.x + Math.sin(cam.yaw) * cp * cam.dist,
        cam.target.y + Math.sin(cam.pitch) * cam.dist,
        cam.target.z + Math.cos(cam.yaw) * cp * cam.dist,
      ),
      lookAt: cam.target.clone(),
    };
    engine.cameraMode = 'static';
    engine._camEase = 0;
  }

  function camFrame() {
    const p = mode === 'free' ? (selection[0] && entryPos(selection[0])) : sel?.mesh.position;
    if (!p) return;
    cam.target.copy(p);
    cam.dist = Math.max(3, Math.min(cam.dist, 12));
    camApply();
  }

  function onWheel(e) {
    e.preventDefault();
    cam.dist = THREE.MathUtils.clamp(cam.dist * (e.deltaY > 0 ? 1.12 : 0.89), 1.5, 140);
    camApply();
  }

  function onCamDown(e) {
    if (e.button !== 2 && e.button !== 1) return false;
    e.preventDefault(); e.stopPropagation();
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

  // ---- what may be picked --------------------------------------------------
  const gizmos = () => [engine.remoteGroup, engine.playerAvatar?.group, engine._marker, ...boxes, ...pins.map((p) => p.mesh)].filter(Boolean);

  function underGizmo(obj) {
    const g = gizmos();
    let o = obj;
    while (o) { if (g.includes(o)) return true; o = o.parent; }
    return false;
  }

  function isGround(obj) {
    const gm = room?.groundMeshes || [];
    let o = obj;
    while (o) { if (gm.includes(o)) return true; o = o.parent; }
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

  // ---- welded pieces of a merged mesh --------------------------------------
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

  // ---- selection entries ---------------------------------------------------
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

  /** Move/turn/resize one entry by a delta, rotating and scaling about itself. */
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

  /** Apply to the whole selection and remember it for undo + the export. */
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
    if (record) pushUndo({ kind: 'delta', entries: selection.slice(), d });
    showBoxes();
    paint();
  }

  // ---- undo ----------------------------------------------------------------
  function pushUndo(a) {
    undoStack.push(a);
    if (undoStack.length > 100) undoStack.shift();
    $('ed-undo').disabled = false;
  }

  function undo() {
    const a = undoStack.pop();
    if (!a) return;
    if (a.kind === 'delta') {
      const keep = selection;
      selection = a.entries;
      applyDelta({ dx: -(a.d.dx || 0), dy: -(a.d.dy || 0), dz: -(a.d.dz || 0), dyaw: -(a.d.dyaw || 0), ds: 1 / (a.d.ds || 1) }, false);
      selection = keep;
    } else if (a.kind === 'vis') {
      a.obj.visible = a.prev;
    } else if (a.kind === 'override') {
      if (a.prev) setOverride(a.roomId, a.propId, a.prev);
      else { const ov = getOverrides(a.roomId); ov?.delete(a.propId); }
      engine.rebuildRoom();
      sync(true);
    }
    $('ed-undo').disabled = !undoStack.length;
    showBoxes();
    paint();
    game.toast('Undone');
  }

  // ---- selection boxes -----------------------------------------------------
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

  // ---- handles mode --------------------------------------------------------
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
    if (mode !== 'handles') return;
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
  }

  function commitPin(pin, x, z, yawStep = 0) {
    const prev = getOverride(room.id, pin.entryId);
    let patch;
    if (yawStep) patch = room.editorPatch?.(pin.entryId, 'yaw', +(pin.yaw + yawStep).toFixed(3));
    else {
      const xz = [+x.toFixed(2), +z.toFixed(2)];
      patch = shiftDrag && pin.key === 'at'
        ? room.editorPatchAll?.(pin.entryId, xz[0] - dragStart[0], xz[1] - dragStart[1])
        : room.editorPatch?.(pin.entryId, pin.key, xz);
    }
    if (!patch) return;
    pushUndo({ kind: 'override', roomId: room.id, propId: pin.entryId, prev: prev ? { ...prev } : null });
    setOverride(room.id, pin.entryId, patch);
    const keep = [pin.entryId, pin.key];
    engine.rebuildRoom();
    sync(true);
    sel = pins.find((p) => p.entryId === keep[0] && p.key === keep[1]) || null;
    paint();
  }

  // ---- panel ---------------------------------------------------------------
  function paint() {
    $('ed-keys').innerHTML = KEYS[mode];
    const list = $('ed-list');
    list.innerHTML = '';
    if (mode === 'handles') {
      for (const p of pins) {
        const row = document.createElement('div');
        row.className = `ed-row${p === sel ? ' on' : ''}`;
        row.innerHTML = `<span class="ed-dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>`
          + `<span>${p.label}</span><span class="ed-xz">${f2(p.mesh.position.x)}, ${f2(p.mesh.position.z)}</span>`;
        row.onclick = () => { sel = p; paint(); };
        list.appendChild(row);
      }
      $('ed-selinfo').textContent = sel ? sel.label : 'Nothing selected';
    } else {
      for (const [, rec] of edits) {
        const row = document.createElement('div');
        row.className = `ed-row${selection.includes(rec.entry) ? ' on' : ''}`;
        row.innerHTML = `<span class="ed-dot" style="background:#7ee0ff"></span><span>${rec.label}</span>`
          + `<span class="ed-xz">${f2(rec.to[0])}, ${f2(rec.to[2])}</span>`;
        row.onclick = () => selectEntries([rec.entry]);
        list.appendChild(row);
      }
      if (!edits.size) {
        const row = document.createElement('div');
        row.className = 'ed-row';
        row.textContent = 'Click a prop, or drag a box around several';
        list.appendChild(row);
      }
      if (selection.length > 1) {
        $('ed-selinfo').innerHTML = `${selection.length} objects selected<br><span>they move together; rotate and resize about their own centres</span>`;
      } else if (selection.length === 1) {
        const e = selection[0];
        const c = entryPos(e);
        $('ed-selinfo').innerHTML = `${e.label}<br><span>${f2(c.x)}, ${f2(c.y)}, ${f2(c.z)} &nbsp; path ${e.path}</span>`;
      } else $('ed-selinfo').textContent = 'Nothing selected';
    }
    paintOut();
  }

  function paintOut() {
    if (!room) return;
    if (mode === 'handles') {
      const ov = getOverrides(room.id);
      if (!ov?.size) { $('ed-out').value = ''; return; }
      const rows = [];
      for (const id of ov.keys()) rows.push(room.editorExport?.(id) || `${id}: ${JSON.stringify(ov.get(id))}`);
      $('ed-out').value = `// ${room.id}: paste into src/world/rooms/${room.id}.js\n${rows.join('\n')}`;
      return;
    }
    if (!edits.size) { $('ed-out').value = ''; return; }
    const lines = [`// ${room.id}: free edits (visual preview: find these in the room builder)`];
    for (const [path, r] of edits) {
      const d = [r.to[0] - r.from[0], r.to[1] - r.from[1], r.to[2] - r.from[2]];
      lines.push(`${r.label}  [${path}]`);
      lines.push(`  pos (${f2(r.to[0])}, ${f2(r.to[1])}, ${f2(r.to[2])})   moved (${f2(d[0])}, ${f2(d[1])}, ${f2(d[2])})`);
      if (Math.abs((r.toRot ?? 0) - (r.fromRot ?? 0)) > 0.001) lines.push(`  rotation.y ${deg(r.toRot)}  (turned ${deg(r.toRot - r.fromRot)})`);
      if (Math.abs((r.toScale ?? 1) - (r.fromScale ?? 1)) > 0.001) lines.push(`  scale ${f2(r.toScale)}`);
    }
    $('ed-out').value = lines.join('\n');
  }

  function sync(force = false) {
    if (!force && engine.room === room) return;
    room = engine.room;
    sel = null;
    selection = [];
    clearBoxes();
    edits.clear();
    undoStack.length = 0;
    $('ed-undo').disabled = true;
    buildPins();
    $('ed-room').textContent = room
      ? `${room.name}: ${mode === 'handles'
        ? `${pins.length} handle${pins.length === 1 ? '' : 's'}${pins.length ? '' : ' (no handle table: use Free)'}`
        : 'free mode, every prop'}`
      : 'no room';
    paint();
  }

  // ---- input ---------------------------------------------------------------
  const canvas = engine.canvas;
  const ndc = (e) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

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

  function onDown(e) {
    if (onCamDown(e)) return;
    if (e.button !== 0) return;

    if (mode === 'handles') {
      if (!pins.length) return;
      ray.setFromCamera(ndc(e), engine.camera);
      const hits = ray.intersectObjects(pins.map((p) => p.mesh), true);
      if (!hits.length) return;
      e.stopPropagation(); e.preventDefault();
      let o = hits[0].object;
      while (o && !pins.some((p) => p.mesh === o)) o = o.parent;
      sel = pins.find((p) => p.mesh === o) || null;
      if (!sel) return;
      shiftDrag = e.shiftKey;
      dragStart = [sel.mesh.position.x, sel.mesh.position.z];
      plane.constant = -(sel.y + 0.05);
      if (ray.ray.intersectPlane(plane, hit)) grab.copy(sel.mesh.position).sub(hit);
      dragging = true;
      paint();
      return;
    }

    const list = candidates(e);

    // already-selected object under the cursor: grab it, do not re-pick. This
    // is the fix for "clicking my selection kicks me to another layer".
    const onSelection = list.find((h) => selection.some((s) => s.obj === h.object
      && (s.instanceId == null || s.instanceId === h.instanceId)));
    if (onSelection && !e.altKey) {
      e.stopPropagation(); e.preventDefault();
      startDrag(e);
      return;
    }

    if (!list.length) {                       // empty space: marquee select
      e.stopPropagation(); e.preventDefault();
      marquee = { x0: e.clientX, y0: e.clientY, el: document.createElement('div') };
      marquee.el.className = 'cove-ed-marquee';
      document.getElementById('overlay-root').appendChild(marquee.el);
      return;
    }

    e.stopPropagation(); e.preventDefault();
    // Alt+click steps past the front-most object to whatever is behind it
    const same = lastPick && Math.hypot(e.clientX - lastPick.x, e.clientY - lastPick.y) < 6;
    const index = e.altKey ? ((same ? lastPick.index : 0) + 1) % list.length : 0;
    lastPick = { x: e.clientX, y: e.clientY, index };
    const h = list[index];
    const chain = topChain(h.object);
    selectEntries([entryFromLevel({ chain, levels: levelsFor(chain, h.instanceId ?? null, h.faceIndex ?? null), depth: 0 })]);
    startDrag(e);
  }

  function startDrag(e) {
    if (!selection.length) return;
    const cur = entryPos(selection[0]);
    plane.constant = -cur.y;
    ray.setFromCamera(ndc(e), engine.camera);
    if (ray.ray.intersectPlane(plane, hit)) grab.copy(cur).sub(hit);
    dragStart = [cur.x, cur.z];
    dragging = true;
  }

  function onMove(e) {
    if (onCamMove(e)) return;
    if (marquee) {
      const x = Math.min(marquee.x0, e.clientX), y = Math.min(marquee.y0, e.clientY);
      const w = Math.abs(e.clientX - marquee.x0), h = Math.abs(e.clientY - marquee.y0);
      Object.assign(marquee.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      return;
    }
    if (!dragging) return;
    ray.setFromCamera(ndc(e), engine.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    if (mode === 'handles' && sel) {
      sel.mesh.position.x = hit.x + grab.x;
      sel.mesh.position.z = hit.z + grab.z;
      paint();
    } else if (selection.length) {
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
      return;
    }
    if (!dragging) return;
    dragging = false;
    if (mode === 'handles' && sel) { commitPin(sel, sel.mesh.position.x, sel.mesh.position.z); return; }
    if (selection.length && dragStart) {
      const cur = entryPos(selection[0]);
      const d = { dx: cur.x - dragStart[0], dz: cur.z - dragStart[1] };
      if (Math.abs(d.dx) > 0.001 || Math.abs(d.dz) > 0.001) pushUndo({ kind: 'delta', entries: selection.slice(), d });
    }
  }

  /** Everything whose centre lands inside the rubber band. */
  function marqueeSelect(rect) {
    const picked = [];
    const v = new THREE.Vector3();
    for (const child of engine.scene.children) {
      if (!isPickable(child)) continue;
      child.getWorldPosition(v);
      const p = v.clone().project(engine.camera);
      if (p.z > 1) continue;
      const sx = (p.x * 0.5 + 0.5) * innerWidth;
      const sy = (-p.y * 0.5 + 0.5) * innerHeight;
      if (sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom) {
        picked.push(makeEntry(child));
      }
    }
    selectEntries(picked);
    game.toast(picked.length ? `${picked.length} selected` : 'Nothing in the box');
  }

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') { e.preventDefault(); teardown(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); e.stopPropagation(); undo(); return;
    }
    const s = e.shiftKey ? 0.5 : 0.05;

    if (mode === 'handles') {
      if (!sel) return;
      if (e.key === '[' || e.key === ']') {
        if (sel.key !== 'at' || sel.yaw == null) return;
        e.preventDefault(); e.stopPropagation();
        commitPin(sel, 0, 0, (e.key === '[' ? -1 : 1) * (e.shiftKey ? 4 : 1) * Math.PI / 36);
        return;
      }
      const d = { ArrowUp: [0, -s], ArrowDown: [0, s], ArrowLeft: [-s, 0], ArrowRight: [s, 0] }[e.key];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      dragStart = [sel.mesh.position.x, sel.mesh.position.z];
      shiftDrag = false;
      commitPin(sel, sel.mesh.position.x + d[0], sel.mesh.position.z + d[1]);
      return;
    }

    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); camFrame(); return; }
    if (!selection.length) return;
    const acts = {
      ArrowUp: () => applyDelta({ dz: -s }), ArrowDown: () => applyDelta({ dz: s }),
      ArrowLeft: () => applyDelta({ dx: -s }), ArrowRight: () => applyDelta({ dx: s }),
      PageUp: () => applyDelta({ dy: s }), PageDown: () => applyDelta({ dy: -s }),
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
    const fn = acts[e.key];
    if (!fn) return;
    e.preventDefault(); e.stopPropagation();
    fn();
  }

  function hideSel() {
    for (const e of selection) {
      if (e.instanceId != null || e.piece) continue;
      pushUndo({ kind: 'vis', obj: e.obj, prev: e.obj.visible });
      e.obj.visible = !e.obj.visible;
    }
    paint();
  }

  const noMenu = (e) => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
  canvas.addEventListener('contextmenu', noMenu);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('keydown', onKey, true);

  function setMode(m) {
    mode = m;
    $('ed-t-handles').classList.toggle('on', m === 'handles');
    $('ed-t-free').classList.toggle('on', m === 'free');
    sel = null; selection = [];
    clearBoxes();
    buildPins();
    sync(true);
  }
  $('ed-t-handles').onclick = () => setMode('handles');
  $('ed-t-free').onclick = () => setMode('free');
  $('ed-undo').onclick = () => undo();
  $('ed-copy').onclick = () => {
    const text = $('ed-out').value;
    if (!text) { game.toast('Move something first'); return; }
    navigator.clipboard?.writeText(text).then(
      () => game.toast('Coordinates copied'),
      () => { $('ed-out').select(); game.toast('Select and copy from the box'); },
    );
  };
  $('ed-reset').onclick = () => {
    if (!room) return;
    if (mode === 'handles') clearOverrides(room.id);
    engine.rebuildRoom();
    sync(true);
    game.toast('Layout reset');
  };
  $('ed-close').onclick = () => teardown();

  const poll = setInterval(() => sync(), 400);
  sync(true);
  camInit();
  game.toast('Layout editor on. Ctrl+E to close.');

  open = true;
  teardown = () => {
    clearInterval(poll);
    canvas.removeEventListener('pointerdown', onDown, true);
    canvas.removeEventListener('wheel', onWheel, true);
    canvas.removeEventListener('contextmenu', noMenu);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('keydown', onKey, true);
    marquee?.el.remove();
    engine.setCameraMode ? engine.setCameraMode(savedMode) : (engine.cameraMode = savedMode);
    clearPins();
    clearBoxes();
    pinGeo.dispose();
    knobGeo.dispose();
    el.remove();
    open = false;
    teardown = null;
  };
}
