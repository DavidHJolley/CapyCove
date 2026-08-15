/**
 * COVE WATCH: the in-game mod/admin panel (wave 9E, Ctrl+Shift+A).
 *
 * The live half of moderation — someone is being awful right now, in this
 * room. Everything with a time axis (the report queue, offline accounts, the
 * audit trail) is the season-one web panel's job (docs/research/accounts-admin
 * .md section 4); this is the thing you open while you are standing next to the
 * problem.
 *
 * Public API, all of it:
 *   toggleAdmin(game)   open, or close if it is already up (the hotkey's verb)
 *   openAdmin(game)     open; returns null if this player holds no capability
 *   closeAdmin()        close if open
 *   isAdminOpen()       is it up?
 *
 * ACCESS. This module is lazy-imported by src/main.js ONLY when
 * `game.state.caps` is non-empty, so an ordinary player never fetches a byte of
 * it. That is a cost decision, not a security one: every button here sends an
 * `a-*` frame and server/admin.js's performOp re-authorises all of them
 * against the record, so a player who loads this chunk by hand gets a panel
 * whose every action is answered with silence and an audit line.
 *
 * WIRE. Out, exactly the frames in server/admin.js's contract:
 *   {t:'a-who', room?, q?} {t:'a-inspect', uid|name|id}
 *   {t:'a-mute', uid|name|id, mins, reason}  {t:'a-unmute', ...}
 *   {t:'a-ban',  uid|name|id, mins, reason}  {t:'a-unban',  ...}
 *   {t:'a-kick', uid|name|id, reason?}  {t:'a-tp', uid|name|id}
 *   {t:'a-announce', text}
 * In, two frames and no more:
 *   {t:'a-ok',  op, msg, ...data}    {t:'a-err', op, msg, code}
 * re-emitted onto game.events under their own names by src/net/client.js
 * (orchestrator-owned; see the report's insertion lines). `op` is the full
 * frame name it answers, e.g. 'a-mute'.
 *
 * DELIBERATELY NOT DUPLICATED HERE: the per-role duration ceilings (a mod may
 * mute for 24h, an admin for a year). The chips are all offered and the server
 * refuses what it will not do, in a sentence it has already written
 * ("Your role may mute for at most 24 hours"), which arrives as a toast. A
 * number copied out of the server is a number that goes stale in silence.
 *
 * Nothing here touches the DOM until openAdmin runs, so the module is
 * import-safe (CLAUDE.md working rules).
 */

const STYLE_ID = 'capy-admin-styles';

/** The rank ladder, for hiding buttons the server would refuse with 'rank'.
 *  server/admin.js's RANK is the authority; this only paints. */
const RANK = { player: 0, mod: 1, admin: 2 };
const rankOf = (role) => RANK[role] ?? 0;

const MUTE_CHIPS = [['10m', 10], ['1h', 60], ['6h', 360], ['24h', 1440], ['7d', 10080]];
const BAN_CHIPS = [['1h', 60], ['24h', 1440], ['7d', 10080], ['30d', 43200]];

const WHO_MIN_GAP_MS = 2200; // the server gives a-who its own 1-per-2s budget
const WHO_POLL_MS = 6000;
const ANNOUNCE_MAX = 200; // the server clamps to its own ANNOUNCE_MAX_LEN too

const CSS = `
.adm-panel {
  position: absolute; top: 64px; right: 14px; width: min(392px, calc(100vw - 28px));
  max-height: calc(100vh - 92px); z-index: 56; display: flex; flex-direction: column;
  background: var(--cream); border: 4px solid #fff; border-radius: 22px;
  box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  font-family: var(--font); color: var(--ink); font-size: 12.5px;
  animation: adm-in 0.28s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.adm-panel.is-closing { opacity: 0; transition: opacity 0.14s ease; pointer-events: none; }
@keyframes adm-in { from { opacity: 0; transform: translateY(-10px) scale(0.97); } }

.adm-head {
  display: flex; align-items: center; gap: 8px; padding: 13px 14px 9px;
  border-bottom: 2px solid rgba(45, 36, 23, 0.07);
}
.adm-head h2 { font-size: 17px; margin: 0; color: var(--accent); letter-spacing: 0.02em; }
.adm-role {
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.09em; text-transform: uppercase;
  color: #fff; background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  padding: 3px 9px; border-radius: 999px;
}
.adm-x { margin-left: auto; }

.adm-body { overflow: auto; padding: 10px 14px 4px; flex: 1; min-height: 90px; }
.adm-body::-webkit-scrollbar { width: 9px; }
.adm-body::-webkit-scrollbar-thumb { background: rgba(45, 36, 23, 0.18); border-radius: 999px; }

.adm-tools { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.adm-seg { display: flex; gap: 3px; background: rgba(45, 36, 23, 0.07); padding: 3px; border-radius: 999px; }
.adm-seg button {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 800; font-size: 11px;
  padding: 5px 10px; border-radius: 999px; background: transparent; color: #9c8963;
  transition: background 0.16s ease, color 0.16s ease;
}
.adm-seg button.on { background: #fff; color: var(--ink); box-shadow: 0 2px 0 rgba(45, 36, 23, 0.08); }
.adm-q {
  flex: 1; min-width: 0; border: 0; border-radius: 999px; padding: 7px 12px;
  background: var(--card); font-family: var(--font); font-weight: 700; font-size: 12px;
  color: var(--ink); box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08);
}
.adm-q:focus { outline: none; box-shadow: inset 0 0 0 2px var(--accent2); }
.adm-mini {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 13px;
  width: 30px; height: 30px; flex: none; border-radius: 50%; color: var(--ink);
  background: var(--card); box-shadow: 0 2px 0 rgba(45, 36, 23, 0.12);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.adm-mini:hover { scale: 1.09; filter: brightness(1.04); }
.adm-mini:active { scale: 0.93; }

.adm-count {
  font-size: 10.5px; font-weight: 900; letter-spacing: 0.07em; text-transform: uppercase;
  color: #a3906c; margin: 0 2px 7px;
}
.adm-list { display: flex; flex-direction: column; gap: 6px; }

.adm-row {
  background: var(--card); border-radius: 15px; padding: 8px 10px;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: adm-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 26ms);
}
.adm-row.is-self { box-shadow: 0 3px 0 rgba(79, 179, 232, 0.3), inset 0 0 0 2px rgba(79, 179, 232, 0.25); }
.adm-row.is-muted { background: #fff7ea; }
.adm-row.is-banned { background: #fdeef0; }
@keyframes adm-pop { from { opacity: 0; transform: translateY(6px); } }

.adm-r1 { display: flex; align-items: center; gap: 6px; }
.adm-name { font-weight: 900; font-size: 13px; overflow-wrap: anywhere; }
.adm-where { font-size: 11px; font-weight: 700; color: #a3906c; margin-left: auto; flex: none; }
.adm-chip {
  font-size: 8.5px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; flex: none;
}
.adm-chip.role { background: rgba(232, 101, 122, 0.16); color: #b34156; }
.adm-chip.guest { background: rgba(45, 36, 23, 0.08); color: #8a7a5a; }
.adm-chip.mute { background: rgba(242, 182, 74, 0.3); color: #8a6a1f; }
.adm-chip.ban { background: rgba(232, 101, 122, 0.28); color: #a32f47; }
.adm-r2 { display: flex; align-items: center; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
.adm-meta { font-size: 10.5px; font-weight: 700; color: #b6a688; margin-right: auto; }

.adm-b {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 10.5px;
  letter-spacing: 0.03em; padding: 5px 10px; border-radius: 999px; color: var(--ink);
  background: linear-gradient(180deg, #fffefa 0%, #fdf1da 100%);
  box-shadow: 0 2px 0 rgba(45, 36, 23, 0.14);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.adm-b:hover:not(:disabled) { scale: 1.06; filter: brightness(1.04); }
.adm-b:active:not(:disabled) { scale: 0.94; }
.adm-b:disabled { opacity: 0.45; cursor: default; box-shadow: none; }
.adm-b:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.adm-b.warm { background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%); box-shadow: 0 2px 0 rgba(158, 111, 20, 0.32); }
.adm-b.hot { background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%); color: #fff; box-shadow: 0 2px 0 rgba(150, 55, 72, 0.35); }
.adm-b.calm { background: linear-gradient(180deg, #8fd0f2 0%, var(--accent2) 100%); color: #fff; box-shadow: 0 2px 0 rgba(38, 116, 160, 0.32); }

.adm-drawer {
  margin: 8px 0 2px; padding: 10px 12px; border-radius: 15px;
  background: rgba(232, 101, 122, 0.09); box-shadow: inset 0 0 0 2px rgba(232, 101, 122, 0.2);
  animation: adm-pop 0.26s var(--spring);
}
.adm-drawer[hidden], .adm-inspect[hidden], .adm-note[hidden] { display: none; }
.adm-dr-h { font-weight: 900; font-size: 12.5px; margin-bottom: 6px; }
.adm-dr-h b { color: var(--accent); }
.adm-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 7px; }
.adm-chips button.on { background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%); color: #fff; }
.adm-why {
  width: 100%; border: 0; border-radius: 12px; padding: 7px 11px; margin-bottom: 7px;
  background: #fff; font-family: var(--font); font-weight: 700; font-size: 12px; color: var(--ink);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08);
}
.adm-why:focus { outline: none; box-shadow: inset 0 0 0 2px var(--accent2); }
.adm-dr-btns { display: flex; gap: 6px; }
.adm-dr-btns .adm-b { flex: 1; font-size: 11.5px; padding: 7px 10px; }

.adm-inspect {
  margin: 8px 0 2px; padding: 10px 12px; border-radius: 15px; background: var(--card);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08); animation: adm-pop 0.26s var(--spring);
}
.adm-insp-h { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.adm-insp-h b { font-size: 13px; }
.adm-kv { display: grid; grid-template-columns: 92px 1fr; gap: 2px 8px; font-size: 11.5px; }
.adm-kv dt { font-weight: 700; color: #a3906c; }
.adm-kv dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; font-family: ui-monospace, Consolas, monospace; }
.adm-fields { margin-top: 6px; font-size: 10px; color: #b6a688; font-weight: 700; line-height: 1.45; overflow-wrap: anywhere; }

.adm-note { text-align: center; padding: 16px 10px; }
.adm-note h3 { font-size: 14px; margin-bottom: 4px; }
.adm-note p { font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.45; }

.adm-foot { padding: 9px 14px 12px; border-top: 2px solid rgba(45, 36, 23, 0.07); }
.adm-field { display: flex; gap: 6px; margin-bottom: 6px; }
.adm-field:last-of-type { margin-bottom: 0; }
.adm-field .adm-q { font-size: 11.5px; }
.adm-field .adm-b { flex: none; }
.adm-tip { font-size: 10px; font-weight: 700; color: #b6a688; text-align: center; margin-top: 8px; line-height: 1.4; }

@media (prefers-reduced-motion: reduce) {
  .adm-panel, .adm-row, .adm-drawer, .adm-inspect { animation: none; }
}
`;

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

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

/** "4m", "2h", "3d" — durations in a panel are glanced at, not read. */
function shortMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

const stamp = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : 'never');

// ---------------------------------------------------------------------------
// the local warp (server/admin.js opTp: "the actor's own client warps itself")
// ---------------------------------------------------------------------------

/**
 * `a-tp` moves the actor's record on the server, but our own position is
 * client-owned — the next 10Hz move frame would drag us straight back. So the
 * answer's `{room, at}` is applied here, and a cross-room warp waits for the
 * room build (it happens behind the engine's 220ms iris fade) before placing
 * the capy, or the spawn point would overwrite us.
 */
function warpTo(game, room, at) {
  const engine = game.engine;
  if (!engine || !at) return;
  const place = () => {
    const a = engine.playerAvatar;
    if (!a) return;
    engine.controller?.stop?.(); // a click-to-move route in flight would walk us back
    a.group.position.set(Number(at.x) || 0, Number(at.y) || 0, Number(at.z) || 0);
    if (engine.room?.groundMeshes?.length) engine.snapY(a.group.position, engine.room);
    a.setAnim?.('idle');
  };
  if (!room || room === game.roomId) { place(); return; }

  const before = engine.room;
  game.goToRoom(room, game.roomId);
  // poll for the new room rather than guessing at the fade length; give up
  // after 5s so a failed room load never leaves a timer running
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (engine.room && engine.room !== before) { clearInterval(poll); place(); return; }
    if (Date.now() - t0 > 5000) clearInterval(poll);
  }, 70);
}

// ---------------------------------------------------------------------------

let openInstance = null;

export function isAdminOpen() { return !!openInstance; }
export function closeAdmin() { openInstance?.close(); }

/** The hotkey's verb: a second Ctrl+Shift+A puts it away. */
export function toggleAdmin(game) {
  if (openInstance) { closeAdmin(); return null; }
  return openAdmin(game);
}

/**
 * Open Cove Watch. Returns the instance, or null when this player holds no
 * capability at all (in which case there is nothing to show and nothing the
 * server would accept anyway).
 */
export function openAdmin(game) {
  if (typeof document === 'undefined' || !game) return null;
  if (openInstance) return openInstance;
  const caps = Array.isArray(game.state?.caps) ? game.state.caps : [];
  if (!caps.length) return null;

  ensureStyles();
  const can = (c) => caps.includes(c);
  const myRank = rankOf(game.state?.role);

  // ---- state ---------------------------------------------------------------
  let scope = 'room';        // 'room' | 'island'
  let query = '';
  let rows = [];             // the a-who player list
  let total = 0;
  let loaded = false;
  let note = 'Reading the room...';
  let drawer = null;         // {op:'mute'|'ban'|'kick', row, mins, reason}
  let account = null;        // the a-inspect readback
  let lastWho = 0;
  let whoTimer = 0;          // trailing send when the 2s budget said no
  let qTimer = 0;            // search debounce

  // ---- shell ---------------------------------------------------------------
  const root = elm('div', 'adm-panel');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Cove Watch');
  root.innerHTML = `
    <div class="adm-head">
      <h2>Cove Watch</h2>
      <span class="adm-role"></span>
      <button class="hud-btn adm-x" type="button" title="Close" aria-label="Close">&#10005;</button>
    </div>
    <div class="adm-body">
      <div class="adm-tools">
        <div class="adm-seg">
          <button type="button" data-scope="room" class="on">This room</button>
          <button type="button" data-scope="island">Island</button>
        </div>
        <input class="adm-q adm-search" type="text" placeholder="Find a name" maxlength="16"
               autocomplete="off" spellcheck="false" aria-label="Find a name">
        <button class="adm-mini adm-refresh" type="button" title="Refresh" aria-label="Refresh">&#8635;</button>
      </div>
      <div class="adm-count"></div>
      <div class="adm-drawer" hidden></div>
      <div class="adm-inspect" hidden></div>
      <div class="adm-list"></div>
      <div class="adm-note" hidden></div>
    </div>
    <div class="adm-foot">
      <div class="adm-field adm-tp-field" hidden>
        <input class="adm-q adm-tp" type="text" placeholder="Warp to a name" maxlength="16"
               autocomplete="off" spellcheck="false" aria-label="Warp to a name">
        <button class="adm-b calm adm-tp-go" type="button">Warp</button>
      </div>
      <div class="adm-field adm-say-field" hidden>
        <input class="adm-q adm-say" type="text" placeholder="Tell the whole island" maxlength="${ANNOUNCE_MAX}"
               autocomplete="off" aria-label="Announcement">
        <button class="adm-b hot adm-say-go" type="button">Announce</button>
      </div>
      <div class="adm-tip"></div>
    </div>`;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const listEl = q('.adm-list');
  const countEl = q('.adm-count');
  const noteEl = q('.adm-note');
  const drawerEl = q('.adm-drawer');
  const inspectEl = q('.adm-inspect');
  const searchEl = q('.adm-search');
  const tipEl = q('.adm-tip');

  q('.adm-role').textContent = game.state?.role || 'player';
  q('.adm-tp-field').hidden = !can('tp');
  q('.adm-say-field').hidden = !can('announce');
  tipEl.textContent = 'Every action here is logged with your name, the reason and the before-and-after.';

  // ---- sending -------------------------------------------------------------

  function send(frame) {
    if (!game.net?.connected) {
      game.toast('The cove is offline for a moment, so nothing is listening.');
      return false;
    }
    game.net.send(frame);
    return true;
  }

  /** a-who has its own 1-per-2s server budget; never spend it twice. */
  function requestWho(force = false) {
    const now = Date.now();
    if (!force && now - lastWho < WHO_MIN_GAP_MS) {
      if (!whoTimer) whoTimer = setTimeout(() => { whoTimer = 0; requestWho(true); }, WHO_MIN_GAP_MS - (now - lastWho));
      return;
    }
    if (whoTimer) { clearTimeout(whoTimer); whoTimer = 0; }
    lastWho = now;
    const frame = { t: 'a-who' };
    if (scope === 'room' && game.roomId) frame.room = game.roomId;
    if (query) frame.q = query;
    if (!send(frame) && !loaded) { note = 'The cove is offline. Nothing to watch from here.'; render(); }
  }

  /** Every mutating op goes out through here so the refresh is never forgotten. */
  function op(t, extra = {}) {
    if (!send({ t, ...extra })) return;
    game.audio?.play?.('click');
    setTimeout(() => requestWho(true), 450); // let the record settle, then re-read
  }

  /** uid first, then name, then the live connection id: server resolution order. */
  function targetOf(row) {
    if (row.uid) return { uid: row.uid };
    if (row.registered && row.name) return { name: row.name };
    return { id: row.id };
  }

  // ---- rendering -----------------------------------------------------------

  function selfId() { return game.net?.selfId || null; }

  function rowActions(r) {
    const wrap = elm('div', 'adm-r2');
    const idle = r.idleMs > 20_000 ? `idle ${shortMs(r.idleMs)}` : '';
    wrap.appendChild(elm('span', 'adm-meta',
      [`${r.coins | 0} coins`, idle].filter(Boolean).join('  ·  ')));

    const isSelf = r.id && r.id === selfId();
    // the server refuses an equal or higher rank with 'rank', and refuses
    // self with 'self'; do not paint a button that is going to be turned down
    const reachable = !isSelf && rankOf(r.role) < myRank;

    const add = (label, cls, fn, on = true) => {
      if (!on) return;
      const b = elm('button', `adm-b${cls ? ` ${cls}` : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    };

    add('Inspect', '', () => { op('a-inspect', targetOf(r)); }, can('inspect'));
    add('Warp', 'calm', () => { op('a-tp', targetOf(r)); }, can('tp') && !isSelf);
    if (reachable && r.registered) {
      if (r.muted > 0) add('Unmute', 'warm', () => op('a-unmute', targetOf(r)), can('mute'));
      else add('Mute', 'warm', () => openDrawer('mute', r), can('mute'));
    }
    if (reachable) add('Kick', '', () => openDrawer('kick', r), can('kick'));
    if (reachable && r.registered) {
      if (r.banned) add('Unban', 'hot', () => op('a-unban', targetOf(r)), can('unban'));
      else add('Ban', 'hot', () => openDrawer('ban', r), can('ban'));
    }
    return wrap;
  }

  function playerRow(r, i) {
    const isSelf = r.id && r.id === selfId();
    const cls = ['adm-row'];
    if (isSelf) cls.push('is-self');
    if (r.banned) cls.push('is-banned');
    else if (r.muted > 0) cls.push('is-muted');
    const el = elm('div', cls.join(' '));
    el.style.setProperty('--i', String(i));

    const r1 = elm('div', 'adm-r1');
    r1.appendChild(elm('span', 'adm-name', r.name || '???'));
    if (r.role && r.role !== 'player') r1.appendChild(elm('span', 'adm-chip role', r.role));
    if (!r.registered) r1.appendChild(elm('span', 'adm-chip guest', 'guest'));
    if (r.muted > 0) r1.appendChild(elm('span', 'adm-chip mute', `muted ${shortMs(r.muted)}`));
    if (r.banned) r1.appendChild(elm('span', 'adm-chip ban', 'banned'));
    r1.appendChild(elm('span', 'adm-where', isSelf ? 'you' : (r.room || '-')));
    el.appendChild(r1);
    el.appendChild(rowActions(r));
    return el;
  }

  function renderDrawer() {
    drawerEl.textContent = '';
    if (!drawer) { drawerEl.hidden = true; return; }
    drawerEl.hidden = false;
    const { op: kind, row } = drawer;
    const verb = kind === 'mute' ? 'Mute' : kind === 'ban' ? 'Ban' : 'Kick';

    const h = elm('div', 'adm-dr-h');
    h.append(`${verb} `, elm('b', null, row.name || '???'));
    drawerEl.appendChild(h);

    if (kind !== 'kick') {
      const chips = elm('div', 'adm-chips');
      const list = kind === 'mute' ? MUTE_CHIPS : BAN_CHIPS;
      const opts = kind === 'ban' && can('ban-perm') ? [...list, ['Forever', 0]] : list;
      for (const [label, mins] of opts) {
        const b = elm('button', `adm-b${drawer.mins === mins ? ' on' : ''}`, label);
        b.type = 'button';
        b.addEventListener('click', () => { drawer.mins = mins; renderDrawer(); });
        chips.appendChild(b);
      }
      drawerEl.appendChild(chips);
    }

    const why = elm('input', 'adm-why');
    why.type = 'text';
    why.maxLength = 140;
    why.value = drawer.reason;
    why.placeholder = kind === 'kick' ? 'Reason (optional)' : 'Reason (required, they will see it)';
    why.setAttribute('aria-label', 'Reason');
    why.addEventListener('input', () => { drawer.reason = why.value; go.disabled = !ready(); });
    why.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ready()) confirm(); });
    drawerEl.appendChild(why);

    const btns = elm('div', 'adm-dr-btns');
    const cancel = elm('button', 'adm-b', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { drawer = null; renderDrawer(); });
    const go = elm('button', `adm-b ${kind === 'ban' ? 'hot' : 'warm'}`, verb);
    go.type = 'button';
    go.addEventListener('click', confirm);
    btns.append(cancel, go);
    drawerEl.appendChild(btns);

    function ready() {
      if (kind === 'kick') return true;
      return drawer.reason.trim().length >= 3 && drawer.mins !== null;
    }
    go.disabled = !ready();

    function confirm() {
      if (!ready()) return;
      const target = targetOf(row);
      const reason = drawer.reason.trim();
      if (kind === 'kick') op('a-kick', { ...target, ...(reason ? { reason } : {}) });
      else if (kind === 'mute') op('a-mute', { ...target, mins: drawer.mins, reason });
      // mins 0 is the server's own spelling of permanent, and it needs 'ban-perm'
      else op('a-ban', { ...target, mins: drawer.mins, reason });
      drawer = null;
      renderDrawer();
    }

    setTimeout(() => why.focus({ preventScroll: true }), 0);
  }

  function openDrawer(kind, row) {
    drawer = {
      op: kind,
      row,
      mins: kind === 'kick' ? null : (kind === 'mute' ? 60 : 1440),
      reason: '',
    };
    account = null;
    renderInspect();
    renderDrawer();
  }

  function renderInspect() {
    inspectEl.textContent = '';
    if (!account) { inspectEl.hidden = true; return; }
    inspectEl.hidden = false;

    const h = elm('div', 'adm-insp-h');
    h.appendChild(elm('b', null, account.name || '???'));
    if (account.guest) h.appendChild(elm('span', 'adm-chip guest', 'guest'));
    else if (account.role && account.role !== 'player') h.appendChild(elm('span', 'adm-chip role', account.role));
    const x = elm('button', 'adm-b', 'Close');
    x.type = 'button';
    x.style.marginLeft = 'auto';
    x.addEventListener('click', () => { account = null; renderInspect(); });
    h.appendChild(x);
    inspectEl.appendChild(h);

    const kv = elm('dl', 'adm-kv');
    const put = (k, v) => {
      if (v === undefined || v === null || v === '') return;
      kv.appendChild(elm('dt', null, k));
      kv.appendChild(elm('dd', null, String(v)));
    };
    if (account.guest) {
      put('id', account.id);
      put('room', account.room);
      put('coins', account.coins);
      put('hat', account.hat);
      put('note', 'Guests keep nothing. Kick is the only lever.');
    } else {
      put('uid', account.uid);
      put('coins', account.coins);
      put('created', stamp(account.created));
      put('last seen', stamp(account.lastSeen));
      put('ip hash', account.lastIpH);
      put('token v', account.tokenV);
      put('title', account.title);
      put('hats', account.hats);
      put('stamps', account.stamps);
      put('friends', account.friends);
      put('furniture', account.furniture);
      if (account.house) put('den', `${account.house.access || '?'} · ${account.house.invites | 0} invited · ${account.house.items | 0} items`);
      const bests = Object.entries(account.bests || {});
      if (bests.length) put('bests', bests.map(([g, s]) => `${g} ${s}`).join(', '));
      if (account.mute) put('mute', `${shortMs(account.mute.remaining)} left, by ${account.mute.by || '?'} (${account.mute.reason || 'no reason'})`);
      if (account.ban) put('ban', `${account.ban.expired ? 'expired, ' : ''}by ${account.ban.by || '?'} (${account.ban.reason || 'no reason'})`);
      if (Array.isArray(account.sessions) && account.sessions.length) {
        put('sessions', account.sessions.map((s) => `${s.id} in ${s.room || '-'}`).join(', '));
      }
    }
    inspectEl.appendChild(kv);
    if (Array.isArray(account.fields) && account.fields.length) {
      inspectEl.appendChild(elm('div', 'adm-fields', `fields on the record: ${account.fields.join(', ')}`));
    }
  }

  function render() {
    listEl.textContent = '';
    const here = scope === 'room' ? (game.roomId || 'nowhere') : 'the island';
    countEl.textContent = loaded
      ? `${rows.length} ${rows.length === 1 ? 'capy' : 'capys'} in ${here} · ${total} online`
      : 'Reading the cove...';

    if (rows.length) {
      noteEl.hidden = true;
      rows.forEach((r, i) => listEl.appendChild(playerRow(r, i)));
    } else {
      noteEl.hidden = false;
      noteEl.textContent = '';
      noteEl.appendChild(elm('h3', null, loaded ? 'Nobody here' : 'Reading the cove...'));
      noteEl.appendChild(elm('p', null, loaded
        ? (query ? 'No name starts with that. Try the island, or clear the search.' : note)
        : 'Asking the server who is about.'));
    }
    renderDrawer();
    renderInspect();
  }

  // ---- answers -------------------------------------------------------------

  function onOk(m) {
    if (!m || typeof m.op !== 'string') return;
    switch (m.op) {
      case 'a-who':
        loaded = true;
        rows = Array.isArray(m.players) ? m.players : [];
        total = Number.isFinite(m.total) ? m.total : rows.length;
        note = 'Everyone else is somewhere else.';
        render();
        return;
      case 'a-inspect':
        account = m.account && typeof m.account === 'object' ? m.account : null;
        drawer = null;
        render();
        game.audio?.play?.('open');
        return;
      case 'a-tp':
        warpTo(game, m.room, m.at);
        break;
      default:
        break;
    }
    if (m.msg) game.toast(m.msg, 3200);
    game.audio?.play?.('pop');
  }

  function onErr(m) {
    if (!m) return;
    // a-who is polled: a rate-limit refusal is the panel's own fault and must
    // not become a toast every six seconds
    if (m.op === 'a-who') {
      loaded = true;
      note = m.msg || 'The cove would not answer that.';
      if (m.code !== 'slow') { rows = []; render(); }
      return;
    }
    game.toast(m.msg || 'That did not work', 3600);
    game.audio?.play?.('pop');
  }

  // ---- wiring --------------------------------------------------------------

  for (const b of root.querySelectorAll('.adm-seg button')) {
    b.addEventListener('click', () => {
      scope = b.dataset.scope;
      for (const o of root.querySelectorAll('.adm-seg button')) o.classList.toggle('on', o === b);
      loaded = false;
      render();
      requestWho(true);
    });
  }

  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim().toLowerCase();
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => { qTimer = 0; requestWho(); }, 320);
  });

  q('.adm-refresh').addEventListener('click', () => { requestWho(true); game.audio?.play?.('click'); });

  const tpEl = q('.adm-tp');
  const tpGo = () => {
    const name = tpEl.value.trim();
    if (!name) return;
    op('a-tp', { name });
    tpEl.value = '';
  };
  q('.adm-tp-go').addEventListener('click', tpGo);
  tpEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') tpGo(); });

  const sayEl = q('.adm-say');
  const sayGo = () => {
    const text = sayEl.value.trim();
    if (text.length < 2) return;
    op('a-announce', { text });
    sayEl.value = '';
  };
  q('.adm-say-go').addEventListener('click', sayGo);
  sayEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sayGo(); });

  const unsubs = [
    game.events.on('a-ok', onOk),
    game.events.on('a-err', onErr),
    // walking somewhere else while the panel is open should re-aim it
    game.events.on('room', () => { if (scope === 'room') requestWho(); }),
    game.events.on('net', (s) => { if (s === 'online') requestWho(true); }),
  ];

  const poll = setInterval(() => requestWho(), WHO_POLL_MS);

  render();
  requestWho(true);
  game.audio?.play?.('open');

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    clearInterval(poll);
    if (whoTimer) clearTimeout(whoTimer);
    if (qTimer) clearTimeout(qTimer);
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 150);
    game.audio?.play?.('click');
  }

  // The panel is docked, not modal: the world keeps its own keys. Escape is the
  // only one taken, and only while this is up.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (drawer) { drawer = null; renderDrawer(); return; }
    if (account) { account = null; renderInspect(); return; }
    close();
  }
  addEventListener('keydown', onKey, true);
  q('.adm-x').addEventListener('click', close);

  openInstance = { close, refresh: () => requestWho(true) };
  return openInstance;
}
