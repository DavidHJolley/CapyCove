import * as THREE from 'three';
import { setOverride, clearOverrides, getOverrides } from '../world/layout.js';

/**
 * Dev layout editor (Ctrl+E). Two modes, because rooms are built two ways.
 *
 * HANDLES mode (authored, exact): a room can publish its layout numbers via
 * `editorHandles(id)`. Each number is a pin; dropping one rewrites the number
 * and REBUILDS the room, so the sign post, chairs, prompt zones, glow rings
 * and colliders derived from it all land where a normal visit would put them.
 * This is the mode to use when a room offers it (currently the Game Den).
 *
 * FREE mode (works in every room, on every object): pick anything the camera
 * can see and move it. This drags the actual Object3D, including a single
 * instance inside an InstancedMesh (one tree out of a forest batch). It is a
 * VISUAL preview: nothing derived from a number follows, and the change lives
 * only in this session. Use it to find a position by eye, then read the
 * numbers out of the panel and put them in the room file.
 *
 * The irreducible limit: props merged into one BufferGeometry at build time
 * are a single object and can only move as a whole. Splitting them would cost
 * the draw calls the merge was buying.
 */

const STYLE_ID = 'cove-ed-styles';
const CSS = `
.cove-ed {
  position: absolute; top: 64px; left: 14px; width: 336px; z-index: 55;
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
.cove-ed .ed-list { max-height: 118px; overflow-y: auto; margin-bottom: 9px;
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
.cove-ed textarea { width: 100%; height: 86px; resize: vertical; border: 0; border-radius: 10px;
  padding: 8px 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  background: #12100c; color: #cfe8b0; line-height: 1.45; }
.cove-ed .ed-btns { display: flex; gap: 6px; margin-top: 9px; }
.cove-ed button.ed-b { flex: 1; border: 0; border-radius: 999px; padding: 7px 10px; cursor: pointer;
  font-family: var(--font); font-weight: 800; font-size: 12px; background: #f2b64a; color: #2d2417; }
.cove-ed button.ghost { background: rgba(255,255,255,.14); color: #fff6e3; }
.cove-ed button.ed-b:hover { filter: brightness(1.08); }
`;

let open = false;
let teardown = null;

export function toggleEditor(game) {
  if (open) { teardown?.(); return false; }
  openEditor(game);
  return true;
}

const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _yaw = (rad) => new THREE.Quaternion().setFromAxisAngle(_up, rad);
const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(1)}deg`;

/** Stable-ish address of an object inside the scene, for labels and re-apply. */
function pathOf(obj, scene) {
  const parts = [];
  let o = obj;
  while (o && o !== scene) {
    parts.unshift(o.parent ? o.parent.children.indexOf(o) : 0);
    o = o.parent;
  }
  return parts.join('/');
}

function labelOf(obj, instanceId) {
  const base = obj.name || (obj.isInstancedMesh ? 'instances' : obj.type);
  return instanceId == null ? base : `${base} #${instanceId}`;
}

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
  let sel = null;          // handles mode: a pin
  let free = null;         // free mode: { obj, instanceId, path, label, start }
  let box = null;          // selection outline
  let dragging = false;
  let dragStart = null;
  let shiftDrag = false;
  const freeMoves = new Map(); // path -> { label, from:[x,y,z], to:[x,y,z], obj, instanceId }

  const pinGeo = new THREE.ConeGeometry(0.16, 0.5, 10);
  const knobGeo = new THREE.SphereGeometry(0.1, 10, 8);

  const KEYS = {
    handles: '<b>Drag a pin</b> to move that number - <b>Shift-drag</b> the gold prop pin moves a whole station<br><b>Arrows</b> nudge (Shift = 0.5), <b>[ ]</b> turn the prop - <b>Esc</b> closes. Walking still works.',
    free: '<b>Click any object</b> to grab it - <b>drag</b> to move - <b>Tab</b> selects its parent<br><b>Arrows</b> nudge, <b>PgUp/Dn</b> height, <b>[ ]</b> rotate, <b>- =</b> resize, <b>H</b> hide<br>Hold <b>Shift</b> for bigger steps. Visual preview only.',
  };

  // ---- shared helpers ------------------------------------------------------
  function clearPins() {
    for (const p of pins) {
      p.mesh.parent?.remove(p.mesh);
      p.mesh.traverse((o) => o.material?.dispose?.());
    }
    pins = [];
  }

  function clearBox() {
    if (box) { box.parent?.remove(box); box.geometry?.dispose?.(); box.material?.dispose?.(); box = null; }
  }

  function showBox(obj, instanceId) {
    clearBox();
    if (!obj) return;
    const b = new THREE.Box3();
    if (instanceId != null && obj.isInstancedMesh) {
      obj.getMatrixAt(instanceId, _m);
      const g = obj.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      b.copy(g.boundingBox).applyMatrix4(_m).applyMatrix4(obj.matrixWorld);
    } else {
      b.setFromObject(obj);
    }
    if (b.isEmpty()) return;
    box = new THREE.Box3Helper(b, 0xf2b64a);
    box.material.depthTest = false;
    box.renderOrder = 998;
    engine.scene.add(box);
  }

  const excluded = () => [engine.remoteGroup, engine.playerAvatar?.group, engine._marker, box, ...pins.map((p) => p.mesh)].filter(Boolean);

  function isExcluded(obj) {
    const ex = excluded();
    let o = obj;
    while (o) { if (ex.includes(o)) return true; o = o.parent; }
    return false;
  }

  // ---- handles mode --------------------------------------------------------
  function makePin(color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const cone = new THREE.Mesh(pinGeo, mat);
    cone.rotation.x = Math.PI;
    cone.position.y = 0.25;
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
      if (handles?.length) {
        for (const h of handles) {
          const mesh = makePin(h.color ?? 0xf2b64a);
          mesh.position.set(h.xz[0], (h.y || 0) + 0.05, h.xz[1]);
          engine.scene.add(mesh);
          pins.push({
            entryId: e.id, key: h.key, label: h.label, color: h.color ?? 0xf2b64a,
            y: h.y || 0, yaw: h.yaw ?? null, mesh,
          });
        }
      } else {
        const o = e.objs[0];
        const mesh = makePin(0xf2b64a);
        mesh.position.set(o.position.x, o.position.y + 0.05, o.position.z);
        engine.scene.add(mesh);
        pins.push({ entryId: e.id, key: '__obj', label: e.id, color: 0xf2b64a, y: o.position.y, mesh, legacyObjs: e.objs });
      }
    }
  }

  function commitPin(pin, x, z) {
    if (pin.key === '__obj') {
      const o = pin.legacyObjs[0];
      const dx = x - o.position.x;
      const dz = z - o.position.z;
      pin.legacyObjs.forEach((q) => { q.position.x += dx; q.position.z += dz; });
      paint();
      return;
    }
    const xz = [+x.toFixed(2), +z.toFixed(2)];
    const patch = shiftDrag && pin.key === 'at'
      ? room.editorPatchAll?.(pin.entryId, xz[0] - dragStart[0], xz[1] - dragStart[1])
      : room.editorPatch?.(pin.entryId, pin.key, xz);
    if (!patch) return;
    setOverride(room.id, pin.entryId, patch);
    const keep = [pin.entryId, pin.key];
    engine.rebuildRoom();
    sync(true);
    sel = pins.find((p) => p.entryId === keep[0] && p.key === keep[1]) || null;
    paint();
  }

  // ---- free mode -----------------------------------------------------------
  function freePos(target = new THREE.Vector3()) {
    if (!free) return target;
    if (free.instanceId != null) {
      free.obj.getMatrixAt(free.instanceId, _m);
      return target.setFromMatrixPosition(_m);
    }
    return target.copy(free.obj.position);
  }

  function freeApply(fn) {
    if (!free) return;
    if (free.instanceId != null) {
      free.obj.getMatrixAt(free.instanceId, _m);
      _m.decompose(_p, _q, _s);
      fn(_p, _q, _s);
      _m.compose(_p, _q, _s);
      free.obj.setMatrixAt(free.instanceId, _m);
      free.obj.instanceMatrix.needsUpdate = true;
      if (free.obj.computeBoundingSphere) free.obj.computeBoundingSphere();
    } else {
      _p.copy(free.obj.position);
      _q.copy(free.obj.quaternion);
      _s.copy(free.obj.scale);
      fn(_p, _q, _s);
      free.obj.position.copy(_p);
      free.obj.quaternion.copy(_q);
      free.obj.scale.copy(_s);
    }
    const cur = freePos();
    const st = freeState();
    const rec = freeMoves.get(free.path);
    if (rec) { rec.to = [cur.x, cur.y, cur.z]; rec.toRot = st.rot; rec.toScale = st.scale; }
    else {
      freeMoves.set(free.path, {
        label: free.label, obj: free.obj, instanceId: free.instanceId,
        from: free.start.slice(), to: [cur.x, cur.y, cur.z],
        fromRot: free.startRot, toRot: st.rot,
        fromScale: free.startScale, toScale: st.scale,
      });
    }
    showBox(free.obj, free.instanceId);
    paint();
  }

  /** Current yaw (radians) and uniform scale of the free selection. */
  function freeState() {
    if (!free) return { rot: 0, scale: 1 };
    if (free.instanceId != null) {
      free.obj.getMatrixAt(free.instanceId, _m);
      _m.decompose(_p, _q, _s);
      return { rot: new THREE.Euler().setFromQuaternion(_q, 'YXZ').y, scale: _s.x };
    }
    return { rot: free.obj.rotation.y, scale: free.obj.scale.x };
  }

  function selectFree(obj, instanceId) {
    const path = pathOf(obj, engine.scene) + (instanceId != null ? `#${instanceId}` : '');
    free = { obj, instanceId, path, label: labelOf(obj, instanceId), start: [0, 0, 0] };
    const cur = freePos();
    const st = freeState();
    const known = freeMoves.get(path);
    free.start = known ? known.from.slice() : [cur.x, cur.y, cur.z];
    free.startRot = known ? known.fromRot : st.rot;
    free.startScale = known ? known.fromScale : st.scale;
    showBox(obj, instanceId);
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
      for (const [path, rec] of freeMoves) {
        const row = document.createElement('div');
        row.className = `ed-row${free?.path === path ? ' on' : ''}`;
        row.innerHTML = `<span class="ed-dot" style="background:#7ee0ff"></span><span>${rec.label}</span>`
          + `<span class="ed-xz">${f2(rec.to[0])}, ${f2(rec.to[2])}</span>`;
        row.onclick = () => { selectFree(rec.obj, rec.instanceId); };
        list.appendChild(row);
      }
      if (!freeMoves.size) {
        const row = document.createElement('div');
        row.className = 'ed-row';
        row.textContent = 'Click something in the world to grab it';
        list.appendChild(row);
      }
      if (free) {
        const c = freePos();
        $('ed-selinfo').innerHTML = `${free.label}<br><span>${f2(c.x)}, ${f2(c.y)}, ${f2(c.z)} &nbsp; path ${free.path}</span>`;
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
    if (!freeMoves.size) { $('ed-out').value = ''; return; }
    const lines = [`// ${room.id}: free edits (visual preview: find these in the room builder)`];
    for (const [path, r] of freeMoves) {
      const d = [r.to[0] - r.from[0], r.to[1] - r.from[1], r.to[2] - r.from[2]];
      lines.push(`${r.label}  [${path}]`);
      lines.push(`  pos (${f2(r.to[0])}, ${f2(r.to[1])}, ${f2(r.to[2])})   moved (${f2(d[0])}, ${f2(d[1])}, ${f2(d[2])})`);
      if (Math.abs((r.toRot ?? 0) - (r.fromRot ?? 0)) > 0.001) {
        lines.push(`  rotation.y ${deg(r.toRot)}  (turned ${deg(r.toRot - r.fromRot)})`);
      }
      if (Math.abs((r.toScale ?? 1) - (r.fromScale ?? 1)) > 0.001) {
        lines.push(`  scale ${f2(r.toScale)}  (x${f2(r.toScale / (r.fromScale || 1))})`);
      }
    }
    $('ed-out').value = lines.join('\n');
  }

  /** Rebuild for whatever room we are standing in. */
  function sync(force = false) {
    if (!force && engine.room === room) return;
    room = engine.room;
    sel = null;
    free = null;
    clearBox();
    if (engine.room !== room || force) freeMoves.clear();
    buildPins();
    $('ed-room').textContent = room
      ? `${room.name}: ${mode === 'handles'
        ? `${pins.length} handle${pins.length === 1 ? '' : 's'}${pins.length ? '' : ' (no handle table: use Free)'}`
        : 'free mode, every object'}`
      : 'no room';
    paint();
  }

  // ---- input ---------------------------------------------------------------
  const canvas = engine.canvas;
  const ndc = (e) => new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  function onDown(e) {
    if (e.button !== 0) return;
    ray.setFromCamera(ndc(e), engine.camera);

    if (mode === 'handles') {
      if (!pins.length) return;
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

    // free mode: pick anything except the players and the editor's own gizmos
    const hits = ray.intersectObjects(engine.scene.children, true)
      .filter((h) => h.object.visible !== false && !isExcluded(h.object));
    if (!hits.length) return;
    e.stopPropagation(); e.preventDefault();
    const h = hits[0];
    selectFree(h.object, h.instanceId ?? null);
    const cur = freePos();
    plane.constant = -cur.y;
    if (ray.ray.intersectPlane(plane, hit)) grab.copy(cur).sub(hit);
    dragging = true;
  }

  function onMove(e) {
    if (!dragging) return;
    ray.setFromCamera(ndc(e), engine.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    if (mode === 'handles' && sel) {
      sel.mesh.position.x = hit.x + grab.x;
      sel.mesh.position.z = hit.z + grab.z;
      paint();
    } else if (mode === 'free' && free) {
      const tx = hit.x + grab.x;
      const tz = hit.z + grab.z;
      freeApply((p) => { p.x = tx; p.z = tz; });
    }
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    if (mode === 'handles' && sel) commitPin(sel, sel.mesh.position.x, sel.mesh.position.z);
  }

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') { e.preventDefault(); teardown(); return; }
    const s = e.shiftKey ? 0.5 : 0.05;

    if (mode === 'handles') {
      if (!sel) return;
      // [ ] turn the whole station: yaw is one of its numbers, so it survives
      // the rebuild and the sign, chairs and zones keep their relationship
      if (e.key === '[' || e.key === ']') {
        if (sel.key !== 'at' || sel.yaw == null) return;
        e.preventDefault(); e.stopPropagation();
        const step = (e.key === '[' ? -1 : 1) * (e.shiftKey ? 4 : 1) * Math.PI / 36;
        const patch = room.editorPatch?.(sel.entryId, 'yaw', +(sel.yaw + step).toFixed(3));
        if (!patch) return;
        setOverride(room.id, sel.entryId, patch);
        const keep = [sel.entryId, sel.key];
        engine.rebuildRoom();
        sync(true);
        sel = pins.find((p) => p.entryId === keep[0] && p.key === keep[1]) || null;
        paint();
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

    if (!free) return;
    const acts = {
      ArrowUp: () => freeApply((p) => { p.z -= s; }),
      ArrowDown: () => freeApply((p) => { p.z += s; }),
      ArrowLeft: () => freeApply((p) => { p.x -= s; }),
      ArrowRight: () => freeApply((p) => { p.x += s; }),
      PageUp: () => freeApply((p) => { p.y += s; }),
      PageDown: () => freeApply((p) => { p.y -= s; }),
      '[': () => freeApply((p, q) => q.multiply(_yaw(-(e.shiftKey ? 4 : 1) * Math.PI / 36))),
      ']': () => freeApply((p, q) => q.multiply(_yaw((e.shiftKey ? 4 : 1) * Math.PI / 36))),
      '-': () => freeApply((p, q, sc) => sc.multiplyScalar(e.shiftKey ? 0.8 : 0.95)),
      _: () => freeApply((p, q, sc) => sc.multiplyScalar(0.8)),
      '=': () => freeApply((p, q, sc) => sc.multiplyScalar(e.shiftKey ? 1.25 : 1.0526)),
      '+': () => freeApply((p, q, sc) => sc.multiplyScalar(1.25)),
      Tab: () => { if (free.obj.parent && free.obj.parent !== engine.scene) selectFree(free.obj.parent, null); },
      h: () => { if (free.instanceId == null) { free.obj.visible = !free.obj.visible; paint(); } },
      H: () => { if (free.instanceId == null) { free.obj.visible = !free.obj.visible; paint(); } },
    };
    const fn = acts[e.key];
    if (!fn) return;
    e.preventDefault(); e.stopPropagation();
    fn();
  }

  canvas.addEventListener('pointerdown', onDown, true);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('keydown', onKey, true);

  function setMode(m) {
    mode = m;
    $('ed-t-handles').classList.toggle('on', m === 'handles');
    $('ed-t-free').classList.toggle('on', m === 'free');
    sel = null; free = null;
    clearBox();
    buildPins();
    sync(true);
  }
  $('ed-t-handles').onclick = () => setMode('handles');
  $('ed-t-free').onclick = () => setMode('free');

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
    freeMoves.clear();
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
    clearBox();
    pinGeo.dispose();
    knobGeo.dispose();
    el.remove();
    open = false;
    teardown = null;
  };
}
