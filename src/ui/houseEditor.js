import { FURNITURE, HOUSE_ACCESS_MODES, HOUSE_MAX_ITEMS } from '../../shared/constants.js';

/**
 * The decorating drawer for a player's own den.
 *
 * Public API:
 *   openHouseEditor(game, room, opts?) -> { close(), showAccess() } | null
 *     opts.tab === 'access' opens straight onto the visitor rules panel.
 *
 * The room (src/world/rooms/house.js) owns everything 3D; this file only
 * drives it:
 *   room.getLayout() / setLayout(list) / addItem(rec) / removeItem(item)
 *   room.poseItem(item, x, z, rot) / room.items / room.bounds / room.keepClear
 *   room.makeGhost(id) / room.pickFloor(cx, cy) / room.pickItem(cx, cy)
 *   room.highlight(item, ok) / room.setEditing(on)
 * That is why there is no `three` import here.
 *
 * Wire messages: house-save, house-config, house-invite, house-uninvite,
 * house-info. Replies arrive as game.events 'house-info' / 'house-guests' /
 * 'furn' (re-emitted by src/net/client.js).
 */

const STYLE_ID = 'house-editor-styles';
const GRID = 0.5;                  // placement snap, in world units
const ROT_STEP = Math.PI / 4;      // 45 degrees a nudge
const INVITE_CAP = 50;

const MODE_COPY = {
  open: ['Open house', 'Any capybara in the cove can waddle in.'],
  friends: ['Friends only', 'Everyone on your friends list is welcome.'],
  invite: ['Invited only', 'Just you and the names on your list below.'],
};

let openInstance = null;

// ---------------------------------------------------------------------------
// card icons: small canvas drawings, cached per catalog id
// ---------------------------------------------------------------------------

const iconCache = new Map();

function bx(g, x, y, w, h, col, r = 4) {
  g.fillStyle = col;
  g.beginPath();
  const rr = Math.min(r, w / 2, h / 2);
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
  g.fill();
}

function ci(g, x, y, r, col) {
  g.fillStyle = col;
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.fill();
}

function tri(g, x, y, w, h, col) {
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w / 2, y + h);
  g.lineTo(x - w / 2, y + h);
  g.closePath();
  g.fill();
}

const INK = '#6b4f35';
const WOOD = '#8a6642';
const WOOD_L = '#b08a5a';
const CREAM = '#fdf0d5';
const CORAL = '#e8657a';
const GOLD = '#f2b64a';
const SKY = '#4fb3e8';
const LEAF = '#7ac74f';

const ICONS = {
  sofa: (g) => {
    bx(g, 6, 22, 52, 16, WOOD, 7);
    bx(g, 4, 30, 12, 20, INK, 6); bx(g, 48, 30, 12, 20, INK, 6);
    bx(g, 12, 32, 40, 14, WOOD_L, 5);
    bx(g, 14, 46, 6, 6, INK, 2); bx(g, 44, 46, 6, 6, INK, 2);
  },
  armchair: (g) => {
    bx(g, 18, 18, 28, 18, WOOD, 7);
    bx(g, 14, 28, 10, 20, INK, 5); bx(g, 40, 28, 10, 20, INK, 5);
    bx(g, 20, 32, 24, 14, WOOD_L, 5);
    bx(g, 21, 46, 5, 6, INK, 2); bx(g, 38, 46, 5, 6, INK, 2);
  },
  beanbag: (g) => {
    bx(g, 12, 26, 40, 26, CORAL, 16);
    bx(g, 18, 22, 26, 14, '#f2879a', 11);
    ci(g, 32, 40, 5, '#c94f64');
  },
  rug_round: (g) => {
    ci(g, 32, 34, 22, GOLD); ci(g, 32, 34, 15, CORAL); ci(g, 32, 34, 7, CREAM);
  },
  rug_stripe: (g) => {
    bx(g, 8, 20, 48, 28, '#f0dca0', 4);
    for (let i = 0; i < 3; i++) bx(g, 10, 24 + i * 8, 44, 5, [CORAL, SKY, LEAF][i], 2);
  },
  low_table: (g) => {
    bx(g, 8, 26, 48, 8, WOOD_L, 4);
    bx(g, 13, 34, 6, 18, WOOD, 3); bx(g, 45, 34, 6, 18, WOOD, 3);
    bx(g, 24, 18, 16, 8, CREAM, 3);
  },
  dining_set: (g) => {
    bx(g, 12, 24, 40, 7, WOOD_L, 3);
    bx(g, 16, 31, 5, 18, WOOD, 2); bx(g, 43, 31, 5, 18, WOOD, 2);
    bx(g, 4, 16, 7, 22, WOOD, 3); bx(g, 53, 16, 7, 22, WOOD, 3);
    ci(g, 32, 20, 5, CORAL);
  },
  bed: (g) => {
    bx(g, 4, 14, 9, 34, WOOD, 4);
    bx(g, 11, 28, 50, 20, CREAM, 5);
    bx(g, 30, 28, 31, 20, SKY, 5);
    bx(g, 14, 30, 14, 11, '#ffffff', 4);
    bx(g, 12, 46, 5, 6, WOOD, 2); bx(g, 54, 46, 5, 6, WOOD, 2);
  },
  bookshelf: (g) => {
    bx(g, 12, 8, 40, 48, WOOD, 4);
    bx(g, 16, 12, 32, 40, '#c9a06b', 2);
    for (let s = 0; s < 3; s++) {
      bx(g, 16, 24 + s * 13, 32, 3, WOOD, 1);
      for (let i = 0; i < 5; i++) {
        bx(g, 18 + i * 6, 13 + s * 13, 5, 11, [CORAL, GOLD, SKY, LEAF, CREAM][(i + s) % 5], 1);
      }
    }
  },
  floor_lamp: (g) => {
    bx(g, 30, 22, 4, 30, WOOD, 2);
    bx(g, 22, 50, 20, 6, INK, 3);
    tri(g, 32, 8, 32, 16, GOLD);
    bx(g, 16, 22, 32, 4, '#d99b2f', 2);
  },
  string_lights: (g) => {
    g.strokeStyle = INK; g.lineWidth = 3;
    g.beginPath(); g.moveTo(4, 20); g.quadraticCurveTo(32, 44, 60, 20); g.stroke();
    const cols = [CORAL, GOLD, SKY, LEAF, CORAL];
    for (let i = 0; i < 5; i++) {
      const t = (i + 0.5) / 5;
      const x = 4 + t * 56;
      const y = 20 + 24 * (1 - (2 * t - 1) ** 2) * 0.5 + 6;
      ci(g, x, y, 5, cols[i]);
    }
  },
  plant_palm: (g) => {
    bx(g, 24, 40, 16, 16, '#cf7649', 3);
    g.strokeStyle = '#5c4a2e'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(32, 40); g.lineTo(32, 22); g.stroke();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI + (i / 4) * Math.PI;
      g.fillStyle = i % 2 ? LEAF : '#4d8c39';
      g.beginPath();
      g.ellipse(32 + Math.cos(a) * 13, 20 + Math.sin(a) * 7, 12, 5, a * 0.5, 0, 7);
      g.fill();
    }
  },
  plant_flower: (g) => {
    bx(g, 24, 40, 16, 15, '#cf7649', 3);
    g.strokeStyle = '#4d8c39'; g.lineWidth = 3;
    for (const dx of [-6, 0, 6]) {
      g.beginPath(); g.moveTo(32, 42); g.quadraticCurveTo(32 + dx, 32, 32 + dx * 1.6, 24); g.stroke();
    }
    ci(g, 21, 22, 6, CORAL); ci(g, 32, 18, 6, GOLD); ci(g, 43, 22, 6, CREAM);
    ci(g, 32, 18, 2.5, '#c94f64');
  },
  fireplace: (g) => {
    bx(g, 6, 16, 52, 40, '#cdb89b', 4);
    bx(g, 4, 12, 56, 8, WOOD, 3);
    bx(g, 18, 28, 28, 28, '#3a2c1e', 3);
    tri(g, 32, 52, 18, -18, '#ff8a3c');
    tri(g, 32, 50, 9, -11, GOLD);
  },
  aquarium: (g) => {
    bx(g, 6, 14, 52, 38, '#bfe6f5', 4);
    bx(g, 4, 10, 56, 7, WOOD, 3);
    bx(g, 6, 44, 52, 8, '#e0c08a', 2);
    ci(g, 26, 30, 6, GOLD); tri(g, 20, 30, 10, -6, GOLD);
    ci(g, 24, 28, 1.6, INK);
    ci(g, 42, 22, 3, '#ffffff'); ci(g, 46, 32, 2, '#ffffff');
  },
  arcade_cab: (g) => {
    bx(g, 16, 8, 32, 48, '#9b6bd4', 5);
    bx(g, 20, 14, 24, 18, '#2d2417', 3);
    bx(g, 23, 18, 6, 6, LEAF, 1); bx(g, 34, 22, 6, 6, CORAL, 1);
    bx(g, 20, 36, 24, 8, '#7a4fb0', 2);
    ci(g, 26, 40, 3, CORAL); ci(g, 36, 40, 3, GOLD);
  },
  trophy_case: (g) => {
    bx(g, 12, 8, 40, 48, WOOD, 4);
    bx(g, 16, 12, 32, 40, '#dff0f7', 2);
    bx(g, 16, 32, 32, 3, WOOD, 1);
    ci(g, 32, 22, 7, GOLD); bx(g, 29, 22, 6, 8, GOLD, 1); bx(g, 25, 30, 14, 4, '#d99b2f', 1);
    ci(g, 23, 42, 4, '#c0c8cf'); ci(g, 41, 42, 4, '#c98f52');
  },
  wall_surfboard: (g) => {
    g.fillStyle = CORAL;
    g.beginPath(); g.ellipse(32, 32, 11, 26, 0, 0, 7); g.fill();
    g.fillStyle = CREAM;
    g.fillRect(30, 8, 4, 48);
    ci(g, 32, 18, 5, GOLD);
  },
  capy_portrait: (g) => {
    bx(g, 10, 12, 44, 40, GOLD, 4);
    bx(g, 16, 18, 32, 28, '#dff0cf', 2);
    ci(g, 32, 36, 11, WOOD_L);
    ci(g, 24, 27, 4, WOOD_L); ci(g, 40, 27, 4, WOOD_L);
    ci(g, 28, 34, 1.8, INK); ci(g, 36, 34, 1.8, INK);
    bx(g, 27, 38, 10, 6, '#8a6642', 3);
  },
  cocoa_station: (g) => {
    bx(g, 8, 30, 48, 22, WOOD_L, 4);
    bx(g, 8, 28, 48, 5, WOOD, 2);
    bx(g, 34, 14, 16, 15, CORAL, 3);
    bx(g, 48, 18, 5, 7, CORAL, 2);
    ci(g, 20, 24, 7, CREAM); bx(g, 26, 21, 5, 5, CREAM, 2);
    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2.5;
    for (const x of [18, 23]) {
      g.beginPath(); g.moveTo(x, 14); g.quadraticCurveTo(x + 4, 10, x, 5); g.stroke();
    }
  },
};

function iconURL(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const draw = Object.prototype.hasOwnProperty.call(ICONS, id) ? ICONS[id] : null;
  if (draw) draw(g);
  else { bx(g, 12, 18, 40, 34, WOOD_L, 5); bx(g, 12, 18, 40, 8, WOOD, 3); }
  const url = c.toDataURL('image/png');
  iconCache.set(id, url);
  return url;
}

// ---------------------------------------------------------------------------
function elm(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function mountPoint() {
  return document.getElementById('hud-root')
    || document.getElementById('overlay-root')
    || document.body;
}

function furnName(id) {
  const f = Object.prototype.hasOwnProperty.call(FURNITURE, id) ? FURNITURE[id] : null;
  return f?.name || id;
}

const snap = (v) => Math.round(v / GRID) * GRID;

// ---------------------------------------------------------------------------
export function openHouseEditor(game, room, opts = {}) {
  if (typeof document === 'undefined') return null;
  if (!game || !room || !room.isOwner) return null;
  if (openInstance) {
    if (opts.tab === 'access') openInstance.showAccess();
    return openInstance;
  }
  ensureStyles();

  const canvas = game.engine?.canvas || null;
  const bounds = room.bounds || { hx: 9, hz: 7 };
  const maxItems = room.maxItems || HOUSE_MAX_ITEMS;

  // ---- state ---------------------------------------------------------------
  let savedLayout = room.getLayout();   // what the server last acknowledged
  let ownedOverride = null;             // freshest {id: count} straight off a 'furn' reply
  let ownedSnapshot = readOwned();
  let armed = null;                     // { f, ghost, rot, pos }
  let selected = null;
  let drag = null;
  let dirty = false;
  let pendingSave = false;
  let saveTimer = 0;
  let escArmed = false;
  let escTimer = 0;
  let invites = [];
  let closed = false;

  function readOwned() {
    const src = ownedOverride || game.state?.ownedFurniture;
    const out = {};
    if (src && typeof src === 'object') {
      for (const id of Object.keys(FURNITURE)) {
        if (!Object.prototype.hasOwnProperty.call(src, id)) continue;
        const n = Math.floor(Number(src[id]));
        if (Number.isFinite(n) && n > 0) out[id] = n;
      }
    }
    return out;
  }

  const placedCount = (id) => room.items.reduce((n, it) => n + (it.f === id ? 1 : 0), 0);
  const leftOf = (id) => (ownedSnapshot[id] || 0) - placedCount(id);

  /** Would a piece of this size sit legally at (x, z)? */
  function fits(x, z, r, solid, ignore) {
    if (Math.abs(x) > bounds.hx - r + 0.02) return false;
    if (Math.abs(z) > bounds.hz - r + 0.02) return false;
    for (const kc of room.keepClear || []) {
      if (Math.hypot(x - kc.x, z - kc.z) < kc.r + solid * 0.55) return false;
    }
    if (solid <= 0) return true; // rugs and wall pieces layer under everything
    for (const it of room.items) {
      if (it === ignore || it.solid <= 0) continue;
      if (Math.hypot(x - it.x, z - it.z) < (solid + it.solid) * 0.82) return false;
    }
    return true;
  }

  // ---- DOM -----------------------------------------------------------------
  const root = elm('div', 'he-root');
  root.innerHTML = `
    <div class="he-drawer" role="region" aria-label="Decorate your den">
      <div class="he-hint" role="status"></div>
      <div class="he-bar">
        <div class="he-head">
          <div class="he-title"></div>
          <div class="he-count"></div>
        </div>
        <div class="he-actions">
          <button class="he-btn he-quiet" type="button" data-act="access">Who can visit</button>
          <button class="he-btn he-quiet" type="button" data-act="cancel">Cancel</button>
          <button class="he-btn he-go" type="button" data-act="save">Save den</button>
        </div>
      </div>
      <div class="he-sel" hidden>
        <span class="he-sel-dot"></span>
        <span class="he-sel-name"></span>
        <button class="he-chip" type="button" data-act="rotate">Turn <b>R</b></button>
        <button class="he-chip he-warn" type="button" data-act="remove">Put away <b>X</b></button>
        <button class="he-chip" type="button" data-act="deselect">Done</button>
      </div>
      <div class="he-tray"></div>
    </div>`;
  mountPoint().appendChild(root);
  document.body.classList.add('he-editing');

  const q = (sel) => root.querySelector(sel);
  const hintEl = q('.he-hint');
  const titleEl = q('.he-title');
  const countEl = q('.he-count');
  const trayEl = q('.he-tray');
  const selEl = q('.he-sel');
  const selNameEl = q('.he-sel-name');
  const saveBtn = q('[data-act="save"]');

  titleEl.textContent = `Decorating ${room.owner}'s Den`;

  // ---- tray ----------------------------------------------------------------
  const cards = new Map();
  let traySig = '';

  function buildTray() {
    const ids = Object.keys(ownedSnapshot).filter((id) => ownedSnapshot[id] > 0);
    ids.sort((a, b) => furnName(a).localeCompare(furnName(b)));
    traySig = ids.map((id) => `${id}:${ownedSnapshot[id]}`).join(',');
    trayEl.textContent = '';
    cards.clear();

    if (!ids.length) {
      const empty = elm('div', 'he-empty');
      empty.appendChild(elm('strong', null, 'No furniture in your crate yet'));
      empty.appendChild(elm('span', null,
        'Everything from the furniture aisle lands here. Pick up a rug and the place is halfway home already.'));
      trayEl.appendChild(empty);
      return;
    }

    ids.forEach((id, i) => {
      const card = elm('button', 'he-card');
      card.type = 'button';
      card.dataset.f = id;
      card.style.setProperty('--i', String(i));
      const ico = elm('span', 'he-ico');
      ico.style.backgroundImage = `url(${iconURL(id)})`;
      card.appendChild(ico);
      card.appendChild(elm('span', 'he-nm', furnName(id)));
      card.appendChild(elm('span', 'he-left'));
      card.addEventListener('click', () => arm(id));
      trayEl.appendChild(card);
      cards.set(id, card);
    });
  }

  function refreshTray() {
    const ids = Object.keys(ownedSnapshot).filter((id) => ownedSnapshot[id] > 0)
      .sort((a, b) => furnName(a).localeCompare(furnName(b)));
    if (ids.map((id) => `${id}:${ownedSnapshot[id]}`).join(',') !== traySig) buildTray();
    for (const [id, card] of cards) {
      const left = leftOf(id);
      card.classList.toggle('is-out', left <= 0);
      card.classList.toggle('is-armed', !!armed && armed.f === id);
      card.disabled = left <= 0 && !(armed && armed.f === id);
      const label = card.querySelector('.he-left');
      label.textContent = left > 0 ? `${left} left` : 'all placed';
    }
    const n = room.items.length;
    countEl.textContent = `${n} of ${maxItems} pieces${dirty ? ' : unsaved' : ''}`;
    countEl.classList.toggle('is-dirty', dirty);
  }

  function setHint(text) {
    hintEl.textContent = text;
  }

  function idleHint() {
    setHint(room.items.length
      ? 'Pick a piece, or click something you placed to move it.'
      : 'Pick a piece below, then click the floor to put it down.');
  }

  // ---- arming / placing ----------------------------------------------------
  function arm(id) {
    if (leftOf(id) <= 0) {
      game.audio?.play?.('fail');
      game.toast(`Every ${furnName(id)} you own is already out.`);
      return;
    }
    if (room.items.length >= maxItems) {
      game.audio?.play?.('fail');
      game.toast(`A den holds ${maxItems} pieces. Put something away first.`);
      return;
    }
    const wasSame = armed && armed.f === id;
    disarm();
    if (wasSame) { idleHint(); refreshTray(); return; } // clicking again puts it back
    select(null);
    const ghost = room.makeGhost(id);
    if (!ghost) { game.toast('That piece would not come out of the crate.'); return; }
    ghost.group.visible = false;
    armed = { f: id, ghost, rot: 0, pos: null };
    game.audio?.play?.('click');
    setHint(`Click the floor to set down your ${furnName(id)}. R turns it.`);
    refreshTray();
  }

  function disarm() {
    if (!armed) return;
    armed.ghost.dispose();
    armed = null;
  }

  function moveGhost(cx, cy) {
    if (!armed) return;
    const p = room.pickFloor(cx, cy);
    if (!p) { armed.ghost.group.visible = false; armed.pos = null; return; }
    const x = snap(p.x);
    const z = snap(p.z);
    armed.pos = { x, z };
    armed.ghost.group.visible = true;
    armed.ghost.setPose(x, z, armed.rot);
    armed.ghost.setValid(fits(x, z, armed.ghost.r, armed.ghost.solid, null));
  }

  function place() {
    if (!armed) return;
    if (!armed.pos || !armed.ghost.valid) {
      game.audio?.play?.('fail');
      setHint('Not there: that spot is taken, out of the room, or in the doorway.');
      return;
    }
    if (room.items.length >= maxItems) {
      game.audio?.play?.('fail');
      game.toast(`A den holds ${maxItems} pieces.`);
      disarm();
      refreshTray();
      return;
    }
    const id = armed.f;
    const item = room.addItem({ f: id, x: armed.pos.x, z: armed.pos.z, rot: armed.rot });
    if (!item) { game.toast('That piece would not come out of the crate.'); disarm(); return; }
    dirty = true;
    game.audio?.play?.('pop');
    if (leftOf(id) <= 0) {
      disarm();
      idleHint();
    } else if (armed.pos) {
      // the piece we just set down is now in the way of the next one
      armed.ghost.setValid(fits(armed.pos.x, armed.pos.z, armed.ghost.r, armed.ghost.solid, null));
    }
    refreshTray();
  }

  // ---- selection -----------------------------------------------------------
  function select(item) {
    selected = item || null;
    room.highlight?.(selected, true);
    if (!selected) {
      selEl.hidden = true;
      selNameEl.textContent = '';
      return;
    }
    selEl.hidden = false;
    selNameEl.textContent = furnName(selected.f);
    setHint('Drag to slide it around. R turns, X puts it away.');
  }

  function rotateSelected() {
    if (armed) {
      armed.rot = (armed.rot + ROT_STEP) % (Math.PI * 2);
      if (armed.pos) armed.ghost.setPose(armed.pos.x, armed.pos.z, armed.rot);
      game.audio?.play?.('click');
      return;
    }
    if (!selected) return;
    room.poseItem(selected, selected.x, selected.z, (selected.rot + ROT_STEP) % (Math.PI * 2));
    dirty = true;
    game.audio?.play?.('click');
    refreshTray();
  }

  function removeSelected() {
    if (!selected) return;
    const name = furnName(selected.f);
    room.removeItem(selected);
    select(null);
    dirty = true;
    game.audio?.play?.('whoosh');
    setHint(`${name} is back in your crate.`);
    refreshTray();
  }

  // ---- pointer -------------------------------------------------------------
  // Capture on window so the engine's own canvas listener never sees these:
  // while the drawer is open a click means "place / pick up", not "walk there".
  function onDown(e) {
    if (closed || !canvas || e.target !== canvas || e.button !== 0) return;
    e.stopPropagation();
    if (armed) {
      moveGhost(e.clientX, e.clientY);
      place();
      return;
    }
    const hit = room.pickItem(e.clientX, e.clientY);
    if (!hit) { select(null); idleHint(); return; }
    select(hit);
    const p = room.pickFloor(e.clientX, e.clientY);
    drag = {
      item: hit,
      dx: p ? hit.x - p.x : 0,
      dz: p ? hit.z - p.z : 0,
      fromX: hit.x, fromZ: hit.z,
      ok: true, moved: false,
    };
    game.audio?.play?.('click');
  }

  function onMove(e) {
    if (closed) return;
    if (drag) {
      const p = room.pickFloor(e.clientX, e.clientY);
      if (!p) return;
      const x = snap(p.x + drag.dx);
      const z = snap(p.z + drag.dz);
      if (x === drag.item.x && z === drag.item.z) return;
      drag.moved = true;
      drag.ok = fits(x, z, drag.item.r, drag.item.solid, drag.item);
      room.poseItem(drag.item, x, z, drag.item.rot);
      room.highlight?.(drag.item, drag.ok);
      return;
    }
    if (armed) {
      if (!canvas || e.target !== canvas) { armed.ghost.group.visible = false; return; }
      moveGhost(e.clientX, e.clientY);
    }
  }

  function onUp() {
    if (closed || !drag) return;
    if (!drag.ok) {
      room.poseItem(drag.item, drag.fromX, drag.fromZ, drag.item.rot);
      game.audio?.play?.('fail');
      setHint('It would not fit there, so it hopped back.');
    } else if (drag.moved) {
      dirty = true;
      game.audio?.play?.('pop');
    }
    room.highlight?.(drag.item, true);
    drag = null;
    refreshTray();
  }

  function onKey(e) {
    if (closed) return;
    e.stopPropagation(); // the world hotkeys (w/d/m) stay out of the drawer
    const typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName || '');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!accessEl.hidden) { hideAccess(); return; }
      requestClose();
      return;
    }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); rotateSelected(); }
    if ((k === 'x' || e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      removeSelected();
    }
  }

  // ---- save / cancel -------------------------------------------------------
  function wireFrame(list) {
    return list.map((it) => ({
      f: it.f,
      x: +Number(it.x).toFixed(2),
      z: +Number(it.z).toFixed(2),
      rot: +Number(it.rot).toFixed(3),
    }));
  }

  function save() {
    if (pendingSave) return;
    if (!game.net?.connected) {
      game.audio?.play?.('fail');
      game.toast('The cove is offline right now, so nothing can be saved yet.');
      return;
    }
    pendingSave = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    game.audio?.play?.('click');
    game.net.send({ t: 'house-save', furniture: wireFrame(room.getLayout()) });
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      pendingSave = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save den';
      game.toast('The cove did not answer. Give Save another tap.');
    }, 8000);
  }

  function cancel() {
    room.setLayout(savedLayout);
    dirty = false;
    game.audio?.play?.('whoosh');
    close();
  }

  function requestClose() {
    if (!dirty) { close(); return; }
    if (!escArmed) {
      escArmed = true;
      game.toast('Escape again to leave without saving.');
      game.audio?.play?.('click');
      if (escTimer) clearTimeout(escTimer);
      escTimer = setTimeout(() => { escArmed = false; escTimer = 0; }, 3500);
      return;
    }
    cancel();
  }

  // ---- access panel --------------------------------------------------------
  const accessEl = elm('div', 'he-modal');
  accessEl.hidden = true;
  accessEl.innerHTML = `
    <div class="he-modal-card" role="dialog" aria-label="Who can visit" tabindex="-1">
      <button class="he-x" type="button" aria-label="Close">&#10005;</button>
      <h3>Who can visit?</h3>
      <p class="he-modal-sub">You can always get in. This is about everyone else.</p>
      <div class="he-modes"></div>
      <div class="he-inv">
        <div class="he-inv-head">
          <strong>Your guest list</strong>
          <span class="he-inv-count"></span>
        </div>
        <form class="he-inv-add">
          <input type="text" maxlength="16" placeholder="A capybara's name" aria-label="Name to invite" autocomplete="off">
          <button class="he-btn he-go" type="submit">Invite</button>
        </form>
        <div class="he-inv-list"></div>
      </div>
    </div>`;
  root.appendChild(accessEl);

  const modesEl = accessEl.querySelector('.he-modes');
  const invListEl = accessEl.querySelector('.he-inv-list');
  const invCountEl = accessEl.querySelector('.he-inv-count');
  const invForm = accessEl.querySelector('.he-inv-add');
  const invInput = invForm.querySelector('input');

  for (const mode of HOUSE_ACCESS_MODES) {
    const [title, blurb] = MODE_COPY[mode] || [mode, ''];
    const row = elm('label', 'he-mode');
    row.dataset.mode = mode;
    const radio = elm('input');
    radio.type = 'radio';
    radio.name = 'he-access';
    radio.value = mode;
    row.appendChild(radio);
    const txt = elm('span', 'he-mode-txt');
    txt.appendChild(elm('strong', null, title));
    txt.appendChild(elm('span', null, blurb));
    row.appendChild(txt);
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      room.setAccess(mode);
      syncModes();
      game.audio?.play?.('click');
      game.net?.send?.({ t: 'house-config', access: mode });
    });
    modesEl.appendChild(row);
  }

  function syncModes() {
    for (const row of modesEl.querySelectorAll('.he-mode')) {
      const on = row.dataset.mode === room.access;
      row.classList.toggle('is-on', on);
      const radio = row.querySelector('input');
      if (radio.checked !== on) radio.checked = on;
    }
    accessEl.classList.toggle('is-invite', room.access === 'invite');
  }

  function renderInvites() {
    invListEl.textContent = '';
    invCountEl.textContent = invites.length ? `${invites.length} / ${INVITE_CAP}` : 'nobody yet';
    if (!invites.length) {
      invListEl.appendChild(elm('div', 'he-inv-empty',
        'Nobody on the list. Add a name and they can walk in whenever they like.'));
    }
    for (const name of invites) {
      const row = elm('div', 'he-inv-row');
      row.appendChild(elm('span', 'he-inv-name', name));
      const del = elm('button', 'he-chip he-warn', 'Remove');
      del.type = 'button';
      del.addEventListener('click', () => {
        game.audio?.play?.('click');
        game.net?.send?.({ t: 'house-uninvite', name });
        invites = invites.filter((n) => n.toLowerCase() !== name.toLowerCase());
        renderInvites();
      });
      row.appendChild(del);
      invListEl.appendChild(row);
    }
    const full = invites.length >= INVITE_CAP;
    invInput.disabled = full;
    invForm.querySelector('button').disabled = full;
    invInput.placeholder = full ? 'The list is full' : "A capybara's name";
  }

  invForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = invInput.value.trim();
    if (name.length < 3) {
      game.audio?.play?.('fail');
      game.toast('Names are at least three letters long.');
      return;
    }
    if (invites.some((n) => n.toLowerCase() === name.toLowerCase())) {
      game.toast(`${name} is already on the list.`);
      invInput.value = '';
      return;
    }
    game.audio?.play?.('click');
    game.net?.send?.({ t: 'house-invite', name });
    invInput.value = '';
  });

  accessEl.querySelector('.he-x').addEventListener('click', hideAccess);
  accessEl.addEventListener('pointerdown', (e) => { if (e.target === accessEl) hideAccess(); });

  function showAccess() {
    syncModes();
    renderInvites();
    accessEl.hidden = false;
    game.audio?.play?.('whoosh');
    game.net?.send?.({ t: 'house-info', owner: room.owner });
    accessEl.querySelector('.he-modal-card').focus({ preventScroll: true });
  }

  function hideAccess() {
    accessEl.hidden = true;
    game.audio?.play?.('click');
  }

  // ---- server events -------------------------------------------------------
  const unsubs = [
    game.events.on('house-info', (m) => {
      if (!m || String(m.owner || '').toLowerCase() !== String(room.owner).toLowerCase()) return;
      // the guest list rides along on the owner's own house-info (`invites`);
      // `allowed` is the boolean "may this viewer walk in", not a list
      if (Array.isArray(m.invites)) { invites = m.invites.slice(0, INVITE_CAP); renderInvites(); }
      syncModes();
      if (!pendingSave) return;
      // the save landed: the server's copy is the truth from here on
      pendingSave = false;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
      dirty = false;
      const serverList = Array.isArray(m.furniture) ? m.furniture : null;
      savedLayout = serverList || room.getLayout();
      game.audio?.play?.('success');
      game.toast('Den saved. Looking cosy in here.');
      close();
      if (serverList) room.setLayout(serverList);
    }),
    game.events.on('house-guests', (m) => {
      if (!m || !Array.isArray(m.invites)) return;
      invites = m.invites.slice(0, INVITE_CAP);
      renderInvites();
    }),
    game.events.on('furn', (m) => {
      // a purchase made while the drawer is open shows up as a new card
      if (m && m.ok && m.ownedFurniture && typeof m.ownedFurniture === 'object') {
        ownedOverride = m.ownedFurniture;
      }
      ownedSnapshot = readOwned();
      refreshTray();
    }),
    game.events.on('profile', () => {
      ownedOverride = null; // game.state is fresh again
      ownedSnapshot = readOwned();
      refreshTray();
    }),
    // leaving the den (or the map, or a reconnect kicking us home) closes up
    game.events.on('room', () => close()),
  ];

  // ---- wire the buttons ----------------------------------------------------
  q('[data-act="access"]').addEventListener('click', () => (accessEl.hidden ? showAccess() : hideAccess()));
  q('[data-act="cancel"]').addEventListener('click', cancel);
  saveBtn.addEventListener('click', save);
  q('[data-act="rotate"]').addEventListener('click', rotateSelected);
  q('[data-act="remove"]').addEventListener('click', removeSelected);
  q('[data-act="deselect"]').addEventListener('click', () => { select(null); idleHint(); });

  addEventListener('pointerdown', onDown, true);
  addEventListener('pointermove', onMove, true);
  addEventListener('pointerup', onUp, true);
  addEventListener('pointercancel', onUp, true);
  addEventListener('keydown', onKey, true);

  // ---- go ------------------------------------------------------------------
  const openApi = { close, showAccess };
  openInstance = openApi;
  room._editor = openApi;

  room.setEditing(true);
  // lift the camera a touch so the whole floor clears the drawer
  const camHome = game.engine?.camCfg || null;
  if (camHome) {
    game.engine.camCfg = {
      offset: camHome.offset.clone().set(0, 15.5, 15.5),
      lookHeight: 0.2,
    };
  }
  buildTray();
  refreshTray();
  idleHint();
  syncModes();
  renderInvites();
  if (opts.tab === 'access') showAccess();
  game.audio?.play?.('whoosh');

  // ---- teardown ------------------------------------------------------------
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (escTimer) { clearTimeout(escTimer); escTimer = 0; }
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('pointermove', onMove, true);
    removeEventListener('pointerup', onUp, true);
    removeEventListener('pointercancel', onUp, true);
    removeEventListener('keydown', onKey, true);
    disarm();
    drag = null;
    try {
      room.highlight?.(null);
      room.setEditing(false);
    } catch { /* the room is already gone */ }
    if (camHome && game.engine) game.engine.camCfg = camHome;
    document.body.classList.remove('he-editing');
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 200);
    if (room._editor === openApi) room._editor = null;
  }

  return openApi;
}

// ---------------------------------------------------------------------------
const CSS = `
.he-root {
  position: absolute; inset: 0; z-index: 38; pointer-events: none;
  font-family: var(--font);
}
.he-root > * { pointer-events: auto; }
.he-root.is-closing .he-drawer { translate: 0 130%; opacity: 0; }
.he-root.is-closing .he-hint { opacity: 0; }
body.he-editing .hud-bottom { opacity: 0; pointer-events: none; transition: opacity 0.2s ease; }

/* anchored to the drawer, not the viewport: the drawer's height changes with
   the selection strip and a fixed offset would hide the chip behind it */
.he-hint {
  position: absolute; left: 50%; top: -42px; translate: -50% 0; pointer-events: none;
  background: rgba(45, 36, 23, 0.82); color: var(--cream);
  font-size: 14px; font-weight: 700; padding: 8px 18px; border-radius: 999px;
  box-shadow: var(--shadow); white-space: nowrap; max-width: 92vw; overflow: hidden;
  text-overflow: ellipsis; transition: opacity 0.2s ease;
  animation: he-pop 0.35s var(--spring) backwards;
}
@keyframes he-pop { from { opacity: 0; translate: -50% 12px; } }

.he-drawer {
  position: absolute; left: 0; right: 0; bottom: 0;
  background: linear-gradient(180deg, #fffdf6 0%, #fdf1da 100%);
  border-top: 3px solid rgba(45, 36, 23, 0.12);
  border-radius: 26px 26px 0 0; padding: 12px 18px 14px;
  box-shadow: 0 -10px 34px rgba(45, 36, 23, 0.3);
  transition: translate 0.28s var(--spring), opacity 0.2s ease;
  animation: he-rise 0.4s var(--spring) backwards;
}
@keyframes he-rise { from { translate: 0 130%; } }

.he-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.he-head { flex: 1 1 220px; min-width: 0; }
.he-title { font-weight: 900; font-size: 18px; color: var(--ink); }
.he-count { font-size: 13px; font-weight: 700; color: var(--muted); }
.he-count.is-dirty { color: var(--accent); }
.he-actions { display: flex; gap: 8px; align-items: center; }

.he-btn {
  border: 0; font-family: var(--font); font-weight: 800; font-size: 14px;
  padding: 10px 18px; border-radius: 999px; cursor: pointer; color: var(--ink);
  background: linear-gradient(180deg, #fffefa 0%, #fdf1da 100%);
  box-shadow: var(--lift), 0 4px 14px rgba(45, 36, 23, 0.18);
  transition: scale 0.12s ease, translate 0.12s ease, filter 0.18s ease;
}
.he-btn:hover { scale: 1.05; translate: 0 -2px; }
.he-btn:active { scale: 0.96; translate: 0 2px; }
.he-btn:disabled { filter: grayscale(0.6) opacity(0.6); cursor: default; scale: 1; translate: 0; }
.he-btn.he-go {
  background: linear-gradient(180deg, #f6cf72 0%, var(--gold) 100%);
  border: 3px solid #fff; color: #4a3312;
}
.he-btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }

.he-sel[hidden] { display: none; }
.he-sel {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 10px 0 0; padding: 8px 12px; border-radius: 14px;
  background: rgba(242, 182, 74, 0.18); border: 2px dashed rgba(242, 182, 74, 0.7);
  animation: he-fade 0.25s ease backwards;
}
@keyframes he-fade { from { opacity: 0; } }
.he-sel-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--gold); }
.he-sel-name { font-weight: 900; color: var(--ink); margin-right: 4px; }
.he-chip {
  border: 0; font-family: var(--font); font-weight: 800; font-size: 12px;
  padding: 6px 12px; border-radius: 999px; cursor: pointer; color: var(--ink);
  background: #fffdf6; box-shadow: 0 2px 0 rgba(45, 36, 23, 0.15);
}
.he-chip b { background: rgba(45, 36, 23, 0.12); border-radius: 5px; padding: 0 5px; margin-left: 5px; }
.he-chip:hover { background: #fff; scale: 1.04; }
.he-chip.he-warn { background: #ffe3e8; color: #8f2a3d; }

.he-tray {
  display: flex; gap: 10px; overflow-x: auto; overflow-y: hidden;
  padding: 12px 2px 4px; scrollbar-width: thin;
}
.he-card {
  flex: 0 0 auto; width: 92px; border: 0; cursor: pointer; font-family: var(--font);
  background: #fffdf6; border-radius: 16px; padding: 8px 6px 7px;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.14), 0 6px 16px rgba(45, 36, 23, 0.14);
  transition: scale 0.14s var(--spring), translate 0.14s ease, box-shadow 0.18s ease;
  animation: he-card-in 0.36s var(--spring) backwards;
  animation-delay: calc(var(--i) * 24ms);
}
@keyframes he-card-in { from { opacity: 0; translate: 0 18px; } }
.he-card:hover { scale: 1.06; translate: 0 -3px; }
.he-ico {
  width: 54px; height: 54px; background-size: contain; background-repeat: no-repeat;
  background-position: center;
}
.he-nm {
  font-size: 11px; font-weight: 800; color: var(--ink); text-align: center;
  line-height: 1.15; height: 26px; overflow: hidden;
}
.he-left { font-size: 10px; font-weight: 800; color: var(--muted); }
.he-card.is-out { filter: grayscale(0.75); opacity: 0.55; cursor: default; }
.he-card.is-out:hover { scale: 1; translate: 0; }
.he-card.is-armed {
  background: linear-gradient(180deg, #fff3d4 0%, #ffe4ab 100%);
  box-shadow: 0 0 0 3px var(--gold), 0 8px 20px rgba(242, 182, 74, 0.5);
  scale: 1.06;
}
.he-card.is-armed .he-left { color: #8a6a1a; }

.he-empty {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 4px 14px;
  color: var(--muted); font-size: 13px; font-weight: 600; max-width: 640px;
}
.he-empty strong { color: var(--ink); font-size: 15px; }

.he-modal {
  position: absolute; inset: 0; background: rgba(20, 32, 44, 0.5);
  display: flex; align-items: center; justify-content: center; z-index: 2;
  animation: he-fade 0.2s ease backwards;
}
.he-modal[hidden] { display: none; }
.he-modal-card {
  position: relative; width: min(460px, 92vw); max-height: 78vh; overflow-y: auto;
  background: var(--card); border-radius: 24px; padding: 22px 22px 20px;
  box-shadow: var(--shadow); animation: he-modal-in 0.32s var(--spring) backwards;
}
@keyframes he-modal-in { from { opacity: 0; scale: 0.9; translate: 0 16px; } }
.he-modal-card h3 { margin: 0; font-size: 21px; color: var(--ink); }
.he-modal-sub { margin: 4px 0 14px; font-size: 13px; color: var(--muted); font-weight: 600; }
.he-x {
  position: absolute; top: 12px; right: 12px; border: 0; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%; background: #f3e6cd;
  font-size: 14px; color: var(--ink); font-weight: 900;
}
.he-x:hover { background: var(--accent); color: #fff; }

.he-mode {
  display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
  padding: 10px 12px; border-radius: 16px; margin-bottom: 8px;
  border: 2px solid rgba(45, 36, 23, 0.1); background: #fffdf6;
  transition: border-color 0.18s ease, background 0.18s ease;
}
.he-mode:hover { border-color: rgba(232, 101, 122, 0.5); }
.he-mode.is-on { border-color: var(--accent); background: #fff4f2; }
.he-mode input { margin-top: 3px; accent-color: var(--accent); width: 17px; height: 17px; }
.he-mode-txt { display: flex; flex-direction: column; }
.he-mode-txt strong { font-size: 15px; color: var(--ink); }
.he-mode-txt span { font-size: 12.5px; color: var(--muted); font-weight: 600; }

.he-inv { margin-top: 14px; border-top: 2px dashed rgba(45, 36, 23, 0.15); padding-top: 12px; }
.he-inv-head { display: flex; justify-content: space-between; align-items: baseline; }
.he-inv-head strong { font-size: 14px; color: var(--ink); }
.he-inv-count { font-size: 12px; font-weight: 700; color: var(--muted); }
.he-inv-add { display: flex; gap: 8px; margin: 10px 0; }
.he-inv-add input {
  flex: 1; border: 2px solid rgba(45, 36, 23, 0.14); border-radius: 999px;
  padding: 9px 16px; font-family: var(--font); font-size: 14px; font-weight: 600;
  color: var(--ink); background: #fffdf6;
}
.he-inv-add input:focus { outline: 0; border-color: var(--accent); }
.he-inv-list { display: flex; flex-direction: column; gap: 6px; }
.he-inv-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: #fffdf6; border-radius: 12px; padding: 7px 8px 7px 14px;
  box-shadow: 0 2px 0 rgba(45, 36, 23, 0.08);
}
.he-inv-name { font-weight: 800; color: var(--ink); font-size: 14px; }
.he-inv-empty { font-size: 12.5px; color: var(--muted); font-weight: 600; padding: 4px 2px; }
.he-modal:not(.is-invite) .he-inv { opacity: 0.72; }

@media (max-width: 720px) {
  .he-title { font-size: 16px; }
  .he-hint { bottom: 234px; font-size: 12.5px; }
  .he-actions { width: 100%; justify-content: flex-end; }
}
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}
