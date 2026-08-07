import * as THREE from 'three';

/**
 * Dev layout editor (Ctrl+E). Drag registered props around a room to try a
 * new arrangement, then copy the coordinates back into the room file.
 *
 * WHY IT EXPORTS INSTEAD OF SAVING: a room is built from numbers, not from a
 * scene file. Chairs, sign posts, prompt rings, obstacle circles and hotspots
 * are all DERIVED from a station's coordinates at build time, and most of the
 * scenery is merged into shared instanced batches that have no individual
 * object to grab. Dragging the cabinet therefore moves the cabinet only: the
 * numbers are the source of truth, so the editor's job is to let you find the
 * spot by eye and hand you the exact table row to paste. Save the file, vite
 * hot-reloads, and everything derived lands in the right place.
 *
 * Rooms opt in with `this.editable(id, objs, meta)` (see src/world/room.js).
 * A room may also implement `editorExport(id, delta, entry)` returning the
 * pasteable text for that prop; otherwise a generic readout is used.
 */

const STYLE_ID = 'cove-ed-styles';
const CSS = `
.cove-ed {
  position: absolute; top: 64px; left: 14px; width: 320px; z-index: 55;
  background: rgba(28, 24, 18, 0.94); color: #fff6e3; border-radius: 16px;
  padding: 14px 16px; font-family: var(--font); font-size: 12.5px;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: auto;
}
.cove-ed h3 { font-size: 14px; margin: 0 0 2px; color: #f2b64a; letter-spacing: .03em; }
.cove-ed .cove-ed-sub { color: #b8a888; font-size: 11.5px; margin-bottom: 10px; }
.cove-ed .cove-ed-keys { color: #b8a888; font-size: 11px; line-height: 1.5; margin-bottom: 10px; }
.cove-ed .cove-ed-keys b { color: #fff6e3; font-weight: 700; }
.cove-ed .cove-ed-sel {
  background: rgba(255,255,255,.07); border-radius: 10px; padding: 8px 10px;
  margin-bottom: 9px; font-weight: 700; min-height: 34px;
}
.cove-ed .cove-ed-sel span { color: #7ee0ff; font-weight: 400; }
.cove-ed textarea {
  width: 100%; height: 104px; resize: vertical; border: 0; border-radius: 10px;
  padding: 8px 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  background: #12100c; color: #cfe8b0; line-height: 1.45;
}
.cove-ed .cove-ed-row { display: flex; gap: 6px; margin-top: 9px; }
.cove-ed button {
  flex: 1; border: 0; border-radius: 999px; padding: 7px 10px; cursor: pointer;
  font-family: var(--font); font-weight: 800; font-size: 12px;
  background: #f2b64a; color: #2d2417;
}
.cove-ed button.ghost { background: rgba(255,255,255,.14); color: #fff6e3; }
.cove-ed button:hover { filter: brightness(1.08); }
.cove-ed-hi { outline: 2px dashed #f2b64a; }
`;

let open = false;
let teardown = null;

export function toggleEditor(game) {
  if (open) { teardown?.(); return false; }
  openEditor(game);
  return true;
}

function fmt(n) { return (Math.round(n * 100) / 100).toFixed(2); }

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
    <div class="cove-ed-sub" id="ed-room"></div>
    <div class="cove-ed-keys">
      <b>Click</b> a prop to select - <b>drag</b> to move<br>
      <b>Arrows</b> nudge (hold Shift for 0.5) - <b>[ ]</b> rotate<br>
      <b>PgUp/PgDn</b> height - <b>H</b> hide/show - <b>Esc</b> close
    </div>
    <div class="cove-ed-sel" id="ed-sel">Nothing selected</div>
    <textarea id="ed-out" readonly placeholder="Move something and the numbers to paste appear here."></textarea>
    <div class="cove-ed-row">
      <button id="ed-copy">Copy</button>
      <button id="ed-reset" class="ghost">Reset</button>
      <button id="ed-close" class="ghost">Close</button>
    </div>`;
  document.getElementById('overlay-root').appendChild(el);

  const $ = (id) => el.querySelector(`#${id}`);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPt = new THREE.Vector3();
  const grabOff = new THREE.Vector3();

  let room = null;
  let entries = [];
  let sel = null;      // { id, objs, meta, origin: [{pos, rot}] }
  let dragging = false;

  /** Rebuild the pickable list for whatever room we are standing in. */
  function sync() {
    if (engine.room === room) return;
    room = engine.room;
    sel = null;
    entries = (room?.editables || []).map((e) => ({
      ...e,
      origin: e.objs.map((o) => ({ pos: o.position.clone(), rot: o.rotation.clone(), vis: o.visible })),
    }));
    $('ed-room').textContent = room
      ? `${room.name}: ${entries.length} draggable prop${entries.length === 1 ? '' : 's'}${entries.length ? '' : ' (this room has not opted in yet)'}`
      : 'no room';
    paint();
  }

  function pickables() {
    return entries.flatMap((e) => e.objs);
  }

  function entryFor(obj) {
    let o = obj;
    while (o) {
      const hit = entries.find((e) => e.objs.includes(o));
      if (hit) return hit;
      o = o.parent;
    }
    return null;
  }

  function select(entry) {
    if (sel) sel.objs.forEach((o) => o.traverse?.((c) => c.userData.__edHi && delete c.userData.__edHi));
    sel = entry;
    paint();
  }

  function delta(entry) {
    const a = entry.objs[0].position;
    const b = entry.origin[0].pos;
    return {
      dx: a.x - b.x,
      dy: a.y - b.y,
      dz: a.z - b.z,
      dyaw: entry.objs[0].rotation.y - entry.origin[0].rot.y,
    };
  }

  function moved(entry) {
    const d = delta(entry);
    return Math.abs(d.dx) > 0.001 || Math.abs(d.dy) > 0.001 || Math.abs(d.dz) > 0.001
      || Math.abs(d.dyaw) > 0.001 || entry.objs[0].visible !== entry.origin[0].vis;
  }

  function paint() {
    if (sel) {
      const p = sel.objs[0].position;
      const d = delta(sel);
      $('ed-sel').innerHTML = `${sel.id}<br><span>x ${fmt(p.x)} &nbsp; z ${fmt(p.z)} &nbsp; y ${fmt(p.y)} &nbsp; yaw ${fmt(sel.objs[0].rotation.y)}`
        + `<br>moved ${fmt(d.dx)}, ${fmt(d.dz)}</span>`;
    } else {
      $('ed-sel').textContent = 'Nothing selected';
    }
    const lines = [];
    for (const e of entries) {
      if (!moved(e)) continue;
      const d = delta(e);
      if (e.objs[0].visible === false) { lines.push(`${e.id}: HIDDEN (delete its entry to remove it)`); continue; }
      const custom = room?.editorExport?.(e.id, d, e);
      lines.push(custom || `${e.id}: moved [${fmt(d.dx)}, ${fmt(d.dz)}]`
        + (Math.abs(d.dyaw) > 0.001 ? ` yaw ${fmt(e.objs[0].rotation.y)}` : '')
        + `\n  now at [${fmt(e.objs[0].position.x)}, ${fmt(e.objs[0].position.z)}]`);
    }
    $('ed-out').value = lines.length
      ? `// ${room?.id}: paste into src/world/rooms/${room?.id}.js\n${lines.join('\n')}`
      : '';
  }

  // ---- picking + dragging (capture phase, so click-to-move never fires) ----
  const canvas = engine.canvas;

  function ndc(e) {
    return new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  }

  function onDown(e) {
    if (e.button !== 0) return;
    sync();
    const list = pickables();
    if (!list.length) return;
    ray.setFromCamera(ndc(e), engine.camera);
    const hits = ray.intersectObjects(list, true);
    if (!hits.length) return;
    e.stopPropagation();
    e.preventDefault();
    const entry = entryFor(hits[0].object);
    if (!entry) return;
    select(entry);
    plane.constant = -entry.objs[0].position.y;
    if (ray.ray.intersectPlane(plane, hitPt)) grabOff.copy(entry.objs[0].position).sub(hitPt);
    dragging = true;
  }

  function onMove(e) {
    if (!dragging || !sel) return;
    ray.setFromCamera(ndc(e), engine.camera);
    if (!ray.ray.intersectPlane(plane, hitPt)) return;
    const to = hitPt.clone().add(grabOff);
    const base = sel.objs[0].position.clone();
    for (const o of sel.objs) {
      o.position.x += to.x - base.x;
      o.position.z += to.z - base.z;
    }
    paint();
  }

  function onUp() { dragging = false; }

  function nudge(dx, dy, dz, dyaw) {
    if (!sel) return;
    for (const o of sel.objs) {
      o.position.x += dx; o.position.y += dy; o.position.z += dz;
      o.rotation.y += dyaw;
    }
    paint();
  }

  function onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const s = e.shiftKey ? 0.5 : 0.05;
    const map = {
      ArrowUp: () => nudge(0, 0, -s, 0), ArrowDown: () => nudge(0, 0, s, 0),
      ArrowLeft: () => nudge(-s, 0, 0, 0), ArrowRight: () => nudge(s, 0, 0, 0),
      PageUp: () => nudge(0, s, 0, 0), PageDown: () => nudge(0, -s, 0, 0),
      '[': () => nudge(0, 0, 0, -Math.PI / 36), ']': () => nudge(0, 0, 0, Math.PI / 36),
      h: () => { if (sel) { sel.objs.forEach((o) => { o.visible = !o.visible; }); paint(); } },
      H: () => { if (sel) { sel.objs.forEach((o) => { o.visible = !o.visible; }); paint(); } },
      Escape: () => teardown(),
    };
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
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
    for (const e of entries) {
      e.objs.forEach((o, i) => {
        o.position.copy(e.origin[i].pos);
        o.rotation.copy(e.origin[i].rot);
        o.visible = e.origin[i].vis;
      });
    }
    paint();
    game.toast('Layout reset');
  };
  $('ed-close').onclick = () => teardown();

  // rooms change under us (map travel, exits): re-arm on a light poll
  const poll = setInterval(sync, 400);
  sync();
  game.toast('Layout editor on. Ctrl+E to close.');

  open = true;
  teardown = () => {
    clearInterval(poll);
    canvas.removeEventListener('pointerdown', onDown, true);
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('keydown', onKey, true);
    el.remove();
    open = false;
    teardown = null;
  };
}
