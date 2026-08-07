import * as THREE from 'three';
import { setOverride, clearOverrides, getOverrides } from '../world/layout.js';

/**
 * Dev layout editor (Ctrl+E).
 *
 * IT EDITS NUMBERS, NOT MESHES. A room is built from a table of coordinates,
 * and everything a prop owns (its sign post, chairs, prompt zones, obstacle
 * circles, glow rings) is DERIVED from those numbers at build time. Most of
 * that scenery is merged into shared instanced batches, so there is no
 * individual object to grab: dragging the cabinet mesh would leave its sign
 * and its zones behind, which is exactly the trap this design avoids.
 *
 * So: every movable number is drawn as a coloured pin. Drag a pin, drop it,
 * and the room REBUILDS from the new numbers, so what you see is exactly what
 * you would get after pasting them into the room file. Shift-drag the prop pin
 * to move a whole station (prop, sign, both zones, both chairs) together.
 *
 * Rooms opt in with `editable(id, objs)` plus, for full control,
 * `editorHandles(id)`, `editorPatch(id, key, xz)`, `editorPatchAll(id, dx, dz)`
 * and `editorExport(id)`. A room with only `editable()` falls back to dragging
 * the object itself (preview only, no rebuild).
 */

const STYLE_ID = 'cove-ed-styles';
const CSS = `
.cove-ed {
  position: absolute; top: 64px; left: 14px; width: 326px; z-index: 55;
  background: rgba(28, 24, 18, 0.94); color: #fff6e3; border-radius: 16px;
  padding: 14px 16px; font-family: var(--font); font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto;
}
.cove-ed h3 { font-size: 14px; margin: 0 0 2px; color: #f2b64a; letter-spacing: .03em; }
.cove-ed .ed-sub { color: #b8a888; font-size: 11.5px; margin-bottom: 9px; }
.cove-ed .ed-keys { color: #b8a888; font-size: 11px; line-height: 1.5; margin-bottom: 9px; }
.cove-ed .ed-keys b { color: #fff6e3; font-weight: 700; }
.cove-ed .ed-list {
  max-height: 132px; overflow-y: auto; margin-bottom: 9px;
  border-radius: 10px; background: rgba(255,255,255,.05); padding: 4px;
}
.cove-ed .ed-row {
  display: flex; align-items: center; gap: 7px; padding: 4px 7px; border-radius: 8px;
  cursor: pointer; font-size: 11.5px; white-space: nowrap;
}
.cove-ed .ed-row:hover { background: rgba(255,255,255,.09); }
.cove-ed .ed-row.on { background: rgba(242,182,74,.22); font-weight: 700; }
.cove-ed .ed-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.cove-ed .ed-xz { margin-left: auto; color: #b8a888; font-family: ui-monospace, Consolas, monospace; }
.cove-ed textarea {
  width: 100%; height: 92px; resize: vertical; border: 0; border-radius: 10px;
  padding: 8px 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  background: #12100c; color: #cfe8b0; line-height: 1.45;
}
.cove-ed .ed-btns { display: flex; gap: 6px; margin-top: 9px; }
.cove-ed button {
  flex: 1; border: 0; border-radius: 999px; padding: 7px 10px; cursor: pointer;
  font-family: var(--font); font-weight: 800; font-size: 12px;
  background: #f2b64a; color: #2d2417;
}
.cove-ed button.ghost { background: rgba(255,255,255,.14); color: #fff6e3; }
.cove-ed button:hover { filter: brightness(1.08); }
`;

let open = false;
let teardown = null;

export function toggleEditor(game) {
  if (open) { teardown?.(); return false; }
  openEditor(game);
  return true;
}

const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

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
    <div class="ed-keys">
      <b>Drag a pin</b> to move that number - <b>Shift-drag</b> the gold prop pin
      moves the whole station<br>
      <b>Arrows</b> nudge (Shift = 0.5) - <b>Esc</b> closes. Walking still works.
    </div>
    <div class="ed-list" id="ed-list"></div>
    <textarea id="ed-out" readonly placeholder="Move something and the table rows to paste appear here."></textarea>
    <div class="ed-btns">
      <button id="ed-copy">Copy</button>
      <button id="ed-reset" class="ghost">Reset</button>
      <button id="ed-close" class="ghost">Close</button>
    </div>`;
  document.getElementById('overlay-root').appendChild(el);

  const $ = (id) => el.querySelector(`#${id}`);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const grab = new THREE.Vector3();

  let room = null;
  let pins = [];          // { entryId, key, label, color, y, mesh, legacyObjs }
  let sel = null;
  let dragging = false;
  let dragStart = null;   // [x, z] of the handle when the drag began
  let shiftDrag = false;

  const pinGeo = new THREE.ConeGeometry(0.16, 0.5, 10);
  const knobGeo = new THREE.SphereGeometry(0.1, 10, 8);

  function clearPins() {
    for (const p of pins) {
      p.mesh.parent?.remove(p.mesh);
      p.mesh.traverse((o) => o.material?.dispose?.());
    }
    pins = [];
  }

  function makePin(color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const cone = new THREE.Mesh(pinGeo, mat);
    cone.rotation.x = Math.PI;      // point down at the spot
    cone.position.y = 0.25;
    const knob = new THREE.Mesh(knobGeo, mat);
    knob.position.y = 0.56;
    g.add(cone, knob);
    g.renderOrder = 999;
    g.traverse((o) => { o.renderOrder = 999; });
    return g;
  }

  /** Rebuild pins + the panel list for whatever room we are standing in. */
  function sync(force = false) {
    if (!force && engine.room === room) return;
    room = engine.room;
    sel = null;
    clearPins();
    const entries = room?.editables || [];
    for (const e of entries) {
      const handles = room.editorHandles?.(e.id);
      if (handles?.length) {
        for (const h of handles) {
          const mesh = makePin(h.color ?? 0xf2b64a);
          mesh.position.set(h.xz[0], (h.y || 0) + 0.05, h.xz[1]);
          engine.scene.add(mesh);
          pins.push({ entryId: e.id, key: h.key, label: h.label, color: h.color ?? 0xf2b64a, y: h.y || 0, mesh });
        }
      } else {
        // room registered props but no handle table: drag the object itself
        const o = e.objs[0];
        const mesh = makePin(0xf2b64a);
        mesh.position.set(o.position.x, o.position.y + 0.05, o.position.z);
        engine.scene.add(mesh);
        pins.push({ entryId: e.id, key: '__obj', label: e.id, color: 0xf2b64a, y: o.position.y, mesh, legacyObjs: e.objs });
      }
    }
    $('ed-room').textContent = room
      ? `${room.name}: ${pins.length} handle${pins.length === 1 ? '' : 's'}`
        + (pins.length ? '' : ' (this room has not opted in yet)')
      : 'no room';
    paintList();
    paintOut();
  }

  function paintList() {
    const list = $('ed-list');
    list.innerHTML = '';
    for (const p of pins) {
      const row = document.createElement('div');
      row.className = `ed-row${p === sel ? ' on' : ''}`;
      row.innerHTML = `<span class="ed-dot" style="background:#${p.color.toString(16).padStart(6, '0')}"></span>`
        + `<span>${p.label}</span>`
        + `<span class="ed-xz">${f2(p.mesh.position.x)}, ${f2(p.mesh.position.z)}</span>`;
      row.onclick = () => { sel = p; paintList(); };
      list.appendChild(row);
    }
  }

  function paintOut() {
    if (!room) return;
    const ov = getOverrides(room.id);
    if (!ov?.size) { $('ed-out').value = ''; return; }
    const rows = [];
    for (const id of ov.keys()) {
      rows.push(room.editorExport?.(id) || `${id}: ${JSON.stringify(ov.get(id))}`);
    }
    $('ed-out').value = `// ${room.id}: paste into src/world/rooms/${room.id}.js\n${rows.join('\n')}`;
  }

  /** Commit a handle's new spot and rebuild the room from the numbers. */
  function commit(pin, x, z) {
    if (pin.key === '__obj') {           // legacy path: preview only
      const o = pin.legacyObjs[0];
      const dx = x - o.position.x;
      const dz = z - o.position.z;
      pin.legacyObjs.forEach((q) => { q.position.x += dx; q.position.z += dz; });
      paintList();
      return;
    }
    const xz = [+x.toFixed(2), +z.toFixed(2)];
    const patch = shiftDrag && pin.key === 'at'
      ? room.editorPatchAll?.(pin.entryId, xz[0] - dragStart[0], xz[1] - dragStart[1])
      : room.editorPatch?.(pin.entryId, pin.key, xz);
    if (!patch) return;
    setOverride(room.id, pin.entryId, patch);
    const keepId = pin.entryId;
    const keepKey = pin.key;
    engine.rebuildRoom();
    sync(true);
    sel = pins.find((p) => p.entryId === keepId && p.key === keepKey) || null;
    paintList();
    paintOut();
  }

  // ---- picking + dragging --------------------------------------------------
  const canvas = engine.canvas;
  const ndc = (e) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  function onDown(e) {
    if (e.button !== 0 || !pins.length) return;
    ray.setFromCamera(ndc(e), engine.camera);
    const hits = ray.intersectObjects(pins.map((p) => p.mesh), true);
    if (!hits.length) return;            // not a pin: let the walk click through
    e.stopPropagation();
    e.preventDefault();
    let o = hits[0].object;
    while (o && !pins.some((p) => p.mesh === o)) o = o.parent;
    sel = pins.find((p) => p.mesh === o) || null;
    if (!sel) return;
    shiftDrag = e.shiftKey;
    dragStart = [sel.mesh.position.x, sel.mesh.position.z];
    plane.constant = -(sel.y + 0.05);
    if (ray.ray.intersectPlane(plane, hit)) grab.copy(sel.mesh.position).sub(hit);
    dragging = true;
    paintList();
  }

  function onMove(e) {
    if (!dragging || !sel) return;
    ray.setFromCamera(ndc(e), engine.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    sel.mesh.position.x = hit.x + grab.x;
    sel.mesh.position.z = hit.z + grab.z;
    paintList();
  }

  function onUp() {
    if (!dragging || !sel) { dragging = false; return; }
    dragging = false;
    commit(sel, sel.mesh.position.x, sel.mesh.position.z);
  }

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') { e.preventDefault(); teardown(); return; }
    if (!sel) return;
    const s = e.shiftKey ? 0.5 : 0.05;
    const d = { ArrowUp: [0, -s], ArrowDown: [0, s], ArrowLeft: [-s, 0], ArrowRight: [s, 0] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    dragStart = [sel.mesh.position.x, sel.mesh.position.z];
    shiftDrag = false;
    commit(sel, sel.mesh.position.x + d[0], sel.mesh.position.z + d[1]);
  }

  canvas.addEventListener('pointerdown', onDown, true);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('keydown', onKey, true);

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
    clearOverrides(room.id);
    engine.rebuildRoom();
    sync(true);
    game.toast('Layout reset');
  };
  $('ed-close').onclick = () => teardown();

  const poll = setInterval(() => sync(), 400);
  sync(true);
  game.toast('Layout editor on. Ctrl+E to close.');

  open = true;
  teardown = () => {
    clearInterval(poll);
    canvas.removeEventListener('pointerdown', onDown, true);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('keydown', onKey, true);
    clearPins();
    pinGeo.dispose();
    knobGeo.dispose();
    el.remove();
    open = false;
    teardown = null;
  };
}
