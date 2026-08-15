import { ROOM_INFO, GAME_NAME, MINIGAMES } from '../../shared/constants.js';
import { stampById, paintStampCanvas } from './profile.js';
import { visitHouse } from '../net/client.js';

/** Chat lines kept for the scrollback card above the chat box. */
const HISTORY_MAX = 150;

// ---------------------------------------------------------------------------
// wave 7 shell: live parties on the island map, and the stamp-slam moment.
// Styles live here rather than styles.css so the whole feature is one file.
// ---------------------------------------------------------------------------

const COVE_STYLE_ID = 'capy-cove7-styles';

const COVE_CSS = `
/* a milestone title rides under the name on the world tag (net/client.js) */
.name-tag.has-title { white-space: normal; text-align: center; line-height: 1.15; padding-bottom: 3px; }
.name-title {
  display: block; font-size: 9px; font-weight: 900; letter-spacing: 0.1em;
  text-transform: uppercase; color: #ffdf9a; margin-top: 1px;
}

/* the venue's map pill wears a party hat while a party is on */
.map-spot .map-hat { display: none; }
.map-spot.is-party {
  background: linear-gradient(180deg, #ffd3dd 0%, #f5879b 100%);
  box-shadow: 0 0 0 3px rgba(232, 101, 122, 0.45),
    0 3px 0 rgba(45, 36, 23, 0.25), 0 8px 18px rgba(16, 52, 78, 0.4);
  animation: party-bob 1.5s ease-in-out infinite;
}
/* sized against the smaller map pills (styles.css .map-spot) */
.map-spot.is-party .map-hat {
  display: block; position: absolute; right: -6px; top: -12px; width: 0; height: 0;
  border: 7px solid transparent; border-bottom: 14px solid var(--accent);
  rotate: 18deg; filter: drop-shadow(0 2px 2px rgba(16, 52, 78, 0.4));
}
.map-spot.is-party .map-hat::after {
  content: ''; position: absolute; left: -3px; top: -5px; width: 7px; height: 7px;
  border-radius: 50%; background: var(--cream);
}
@keyframes party-bob { 50% { translate: -50% calc(-50% - 3px); } }

.map-party {
  display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 9px 12px;
  border-radius: 16px; background: rgba(232, 101, 122, 0.13);
  box-shadow: inset 0 0 0 2px rgba(232, 101, 122, 0.26);
  animation: party-in 0.25s ease;
}
@keyframes party-in { from { opacity: 0; translate: 0 -5px; } }
/* the class sets display:flex, which would otherwise beat the [hidden] default */
.map-party[hidden] { display: none; }
.map-party-txt { flex: 1; min-width: 0; text-align: left; font-size: 12.5px; font-weight: 800; }
.map-party-txt small { display: block; font-size: 11px; font-weight: 700; color: var(--muted); }
.map-party-go {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 12px;
  padding: 7px 15px; border-radius: 999px; color: #fff; flex: none;
  background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  box-shadow: 0 4px 0 rgba(150, 55, 72, 0.32);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.map-party-go:hover { scale: 1.06; filter: brightness(1.05); }
.map-party-go:active { scale: 0.95; }
.map-party-go:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }

/* ---- stamp slam ---- */
.slam {
  position: absolute; inset: 0; z-index: 58; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 4px; cursor: pointer;
  background: radial-gradient(ellipse 70% 60% at 50% 46%, rgba(45, 36, 23, 0.42) 0%, rgba(20, 32, 44, 0.78) 100%);
  animation: slam-in 0.25s ease;
}
.slam.is-out { opacity: 0; transition: opacity 0.4s ease; pointer-events: none; }
.slam-rays {
  position: absolute; width: 150vmax; height: 150vmax; pointer-events: none; opacity: 0.5;
  background: repeating-conic-gradient(from 0deg,
    rgba(255, 236, 190, 0.24) 0deg 7deg, rgba(255, 236, 190, 0) 7deg 14deg);
  animation: slam-spin 22s linear infinite;
}
.slam-art {
  position: relative; filter: drop-shadow(0 16px 26px rgba(0, 0, 0, 0.45));
  animation: slam-stamp 0.62s cubic-bezier(0.2, 1.5, 0.35, 1);
}
.slam-art canvas { display: block; }
.slam-kicker {
  position: relative; margin-top: 16px; font-size: 12px; font-weight: 900;
  letter-spacing: 0.28em; text-transform: uppercase; color: var(--gold);
  animation: slam-rise 0.5s 0.16s backwards ease;
}
.slam-name {
  position: relative; font-size: clamp(26px, 6vw, 42px); font-weight: 900; color: #fff;
  text-align: center; padding: 0 20px; line-height: 1.1;
  text-shadow: 0 4px 0 rgba(45, 36, 23, 0.45);
  animation: slam-rise 0.5s 0.22s backwards ease;
}
.slam-desc {
  position: relative; margin-top: 6px; font-size: 13.5px; font-weight: 700; color: #ffe9c4;
  text-align: center; padding: 0 24px; max-width: 460px; line-height: 1.45;
  animation: slam-rise 0.5s 0.3s backwards ease;
}
.slam-tap {
  position: absolute; bottom: 8%; font-size: 11px; font-weight: 800; letter-spacing: 0.16em;
  text-transform: uppercase; color: rgba(255, 246, 227, 0.65);
}
.slam-spark {
  position: absolute; width: 12px; height: 12px; border-radius: 50%; pointer-events: none;
  animation: slam-spark 1.1s ease-out backwards;
}
@keyframes slam-in { from { opacity: 0; } }
@keyframes slam-spin { to { rotate: 360deg; } }
@keyframes slam-stamp {
  0% { opacity: 0; scale: 2.6; rotate: -14deg; }
  60% { opacity: 1; scale: 0.94; rotate: 3deg; }
  100% { opacity: 1; scale: 1; rotate: -2deg; }
}
@keyframes slam-rise { from { opacity: 0; translate: 0 12px; } }
@keyframes slam-spark {
  0% { opacity: 1; scale: 0.3; }
  100% { opacity: 0; scale: 1; translate: var(--dx) var(--dy); }
}
@media (prefers-reduced-motion: reduce) {
  .slam-rays, .slam-art, .slam-kicker, .slam-name, .slam-desc, .slam-spark,
  .map-spot.is-party { animation: none; }
}
`;

// ---------------------------------------------------------------------------
// wave 12 shell: co-presence. Who is where, painted where the player already
// looks: counts on the map pills, a lobby strip under the island, one travelling
// chip in the world, a live count on the room chip and a marker where a friend
// is standing. Same reasoning as the wave 7 block above: the whole feature is
// one file, so its styles live with it instead of in styles.css.
// ---------------------------------------------------------------------------

const COVE12_CSS = `
/* A capybara head is the unit the island counts in: a rounded blob with two
   ears, 8px wide, legible on the cream pills and on the dark chip alike. */
.pop-capy, .pip {
  display: block; width: 8px; height: 7px; border-radius: 46% 46% 52% 52%; flex: none;
}
.pip { background: rgba(45, 36, 23, 0.16); box-shadow: inset 0 0 0 1px rgba(45, 36, 23, 0.09); }
.pop-capy {
  position: relative; background: #a2743f;
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.3);
}
.pop-capy::before, .pop-capy::after {
  content: ''; position: absolute; top: -2px; width: 3.2px; height: 3.2px;
  border-radius: 50%; background: #a2743f;
}
.pop-capy::before { left: 0.4px; }
.pop-capy::after { right: 0.4px; }

/* ---- the map pills carry their room's head-count ---- */
/* inline-flex, so the count grows the pill's own box symmetrically about its
   anchor point and the measured pill spacing (see MAP_SPOTS) still holds */
.map-island .map-spot { display: inline-flex; align-items: center; gap: 5px; }
.map-spot .map-pop {
  display: inline-flex; align-items: center; gap: 2px;
  padding-left: 5px; border-left: 1.5px dotted rgba(45, 36, 23, 0.24);
}
.map-spot .map-pop b { font-size: 9.5px; font-weight: 900; color: #7a5a33; }
/* an empty count must not leave the flex gap behind */
.map-spot .map-pop:empty { display: none; }
/* a friend is standing there: a coral ring on the pill (costs no layout width,
   so it survives every card size) and a pin on its shoulder */
.map-spot.has-friend {
  box-shadow: 0 0 0 2.5px rgba(232, 101, 122, 0.55),
    0 3px 0 rgba(45, 36, 23, 0.2), 0 6px 14px rgba(16, 52, 78, 0.32);
}
.map-spot .map-friend { display: none; }
.map-spot.has-friend .map-friend {
  display: block; position: absolute; left: -7px; top: -9px; width: 13px; height: 13px;
  border-radius: 50%; border: 2px solid #fff;
  background: linear-gradient(180deg, #ffd3dd 0%, var(--accent) 100%);
  box-shadow: 0 2px 6px rgba(16, 52, 78, 0.45);
  animation: friend-bob 2.6s ease-in-out infinite;
}
.map-spot.has-friend .map-friend::after {
  content: ''; position: absolute; inset: 3px; border-radius: 50%;
  background: #fff6e3; opacity: 0.92;
}
@keyframes friend-bob { 50% { translate: 0 -2px; } }

/* Phone-width cards cannot spare the width. Measured pairwise (the same rect
   sweep styles.css .map-spot documents): with counts on, the closest pair is
   still loft/lounge (13.4px) at a 480px viewport and upward, but below that the
   card shrinks faster than the pills do and Smoothie Shack vs Glimmer Mine
   closes to 2px at 440 and overlaps by 12px at 400. So the counts step off
   there; the island total in the hint line and the lobby strip still say how
   busy the cove is, and the coral ring still says where a friend is.
   These rules must stay BELOW the ones they turn off: same specificity, so it
   is document order that decides, not the media query. */
@media (max-width: 500px) {
  .map-spot .map-pop { display: none; }
  /* the pin pokes 9px above the pill and would land on the Trophy Loft when a
     friend is in the Game Den under it (measured at 360x640) */
  .map-spot.has-friend .map-friend { display: none; }
}

/* ---- the lobby strip, moored at the bottom of the island ---- */
/* inside the island box on purpose: the map card's height is measured to the
   pixel (styles.css .map-card) and another row would push it past 94vh */
.map-lobby {
  position: absolute; left: 50%; bottom: 9px; translate: -50% 0; z-index: 6;
  display: flex; align-items: center; gap: 9px; max-width: 94%;
  padding: 6px 8px 6px 11px; border-radius: 999px;
  background: rgba(255, 246, 227, 0.95); color: var(--ink);
  box-shadow: 0 8px 20px rgba(16, 52, 78, 0.42), inset 0 0 0 2px rgba(255, 255, 255, 0.9);
  animation: lobby-in 0.28s var(--spring);
}
.map-lobby[hidden] { display: none; }
.map-lobby-txt { min-width: 0; text-align: left; font-size: 12px; font-weight: 800; }
.map-lobby-txt small {
  display: block; font-size: 10.5px; font-weight: 700; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pips { display: flex; align-items: center; gap: 3px; flex: none; }
@keyframes lobby-in { from { opacity: 0; translate: -50% 8px; } }
/* On a phone-width card the strip has to be one short line or it climbs into
   the Groove Grotto pill above it (measured: 18px of overlap at 360x640 once
   the text wrapped, 4px of daylight after this). The room name is already on
   the pill the strip is pointing at, and "2/3" says what the pips say. */
@media (max-width: 520px) {
  .map-lobby { bottom: 4px; padding: 4px 6px 4px 9px; gap: 7px; }
  .map-lobby .pips { display: none; }
  .map-lobby-txt {
    font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .map-lobby-txt small { display: none; }
  /* scoped, not bare .cove-go: the shared button's own rule is declared further
     down this sheet and would otherwise win on document order */
  .map-lobby .cove-go { padding: 5px 11px; }
}

/* ---- the same invitation, out in the world ---- */
.lobby-chip {
  position: absolute; right: 14px; bottom: 92px; z-index: 34;
  display: flex; align-items: center; gap: 10px; max-width: min(330px, 76vw);
  padding: 8px 9px 8px 13px; border-radius: 20px;
  background: rgba(255, 246, 227, 0.96); color: var(--ink);
  box-shadow: 0 10px 26px rgba(16, 52, 78, 0.42), inset 0 0 0 2px rgba(255, 255, 255, 0.9);
  animation: chip-in 0.42s var(--spring);
}
.lobby-chip[hidden] { display: none; }
.lobby-chip-txt { flex: 1; min-width: 0; text-align: left; font-size: 12.5px; font-weight: 800; }
.lobby-chip-txt small { display: block; font-size: 11px; font-weight: 700; color: var(--muted); }
.lobby-chip-x {
  border: 0; background: transparent; cursor: pointer; flex: none;
  font-family: var(--font); font-size: 13px; font-weight: 900; color: var(--muted);
  padding: 4px 6px; border-radius: 999px; line-height: 1;
}
.lobby-chip-x:hover { color: var(--ink); background: rgba(45, 36, 23, 0.08); }
.lobby-chip-x:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
@keyframes chip-in { from { opacity: 0; translate: 0 14px; scale: 0.92; } }
@media (max-width: 560px) {
  .lobby-chip { right: 10px; left: 10px; bottom: 80px; max-width: none; }
}

/* the go button, shared by the strip and the chip */
.cove-go {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 12px;
  padding: 7px 15px; border-radius: 999px; color: #fff; flex: none;
  background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  box-shadow: 0 4px 0 rgba(150, 55, 72, 0.32);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.cove-go:hover { scale: 1.06; filter: brightness(1.05); }
.cove-go:active { scale: 0.95; }
.cove-go:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }

/* ---- the room chip's live count ---- */
#pop-count.is-solo { color: var(--muted); font-weight: 700; }
#pop-count.bump { display: inline-block; animation: pop-bump 0.5s var(--spring); }
@keyframes pop-bump { 0%, 100% { scale: 1; } 40% { scale: 1.22; } }

@media (prefers-reduced-motion: reduce) {
  .map-lobby, .lobby-chip, .map-spot.has-friend .map-friend, #pop-count.bump { animation: none; }
}
`;

function ensureCoveStyles() {
  if (typeof document === 'undefined' || document.getElementById(COVE_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = COVE_STYLE_ID;
  s.textContent = COVE_CSS + COVE12_CSS;
  document.head.appendChild(s);
}

/**
 * The live party, if any: {host, room, label, endsAt, count}. Module level
 * because the island painter is a plain function with no game handle, and the
 * beacon has to pulse on the venue itself.
 */
let party = null;

/** Read a 'party' / 'party-start' frame. Returns null for "no party on". */
function parseParty(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'party-end' || m.active === false || m.over === true || m.ok === false) return null;
  const host = typeof m.host === 'string' && m.host.trim() ? m.host.trim() : null;
  if (!host) return null;
  const room = typeof m.room === 'string' && m.room
    ? m.room
    : (m.venue === 'club' ? 'club' : `house:${host.toLowerCase()}`);
  const secs = Number(m.endsIn ?? m.remaining ?? m.secondsLeft);
  // the server names the venue (dens have no ROOM_INFO entry); this is only the
  // fallback for a frame that leaves it out
  const label = (typeof m.roomName === 'string' && m.roomName.trim())
    || (Object.prototype.hasOwnProperty.call(ROOM_INFO, room) ? ROOM_INFO[room].name : `${host}'s Den`);
  const count = Number(m.count ?? m.guests);
  return {
    host,
    room,
    label,
    endsAt: Date.now() + (Number.isFinite(secs) && secs > 0 ? secs : 30 * 60) * 1000,
    count: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null,
  };
}

const partyLive = () => !!party && party.endsAt > Date.now();

// ---- co-presence: who is where (wave 12) ----------------------------------
// The server broadcasts, to EVERYONE, every 5s and once on hello:
//   {t:'pop', rooms:{<roomId>:count,...}, lobbies:[{game, room, n, need}]}
// (bots excluded from the counts; n = capys waiting in that game's lobby,
// need = seats to start), and pushes to one player, on hello and whenever one
// of THEIR friends changes room:
//   {t:'fpresence', friends:[{name, room|null}]}   (null = offline)
// Module level for the same reason `party` is: the map painter, the map pills
// and the HUD shell are separate functions with no shared handle.

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Latest head count per room, plus the island total and when it was taken. */
const POP = { rooms: Object.create(null), total: 0, seen: false, at: 0 };

/** Where WE are, so a count taken before we moved can be corrected on sight. */
const SELF = { room: null, prev: null, at: 0 };

/** Lobbies worth joining, nearest-to-starting first. */
let LOBBIES = [];

/** roomId -> friend names standing there (offline friends are simply absent). */
const FRIEND_AT = new Map();

/** Read a 'pop' frame's counts. Null-prototype: room ids come off the wire. */
function readPop(m) {
  const rooms = Object.create(null);
  let total = 0;
  const src = m && typeof m.rooms === 'object' && m.rooms ? m.rooms : null;
  if (src) {
    for (const key of Object.keys(src)) {
      const n = Math.floor(Number(src[key]));
      if (!Number.isFinite(n) || n <= 0) continue;
      rooms[key] = Math.min(n, 999);
      total += rooms[key];
    }
  }
  POP.rooms = rooms;
  POP.total = total;
  POP.seen = true;
  POP.at = Date.now();
}

/**
 * Read a 'pop' frame's lobbies. Only ones a capy can still join are kept (an
 * empty lobby is not an invitation and a full one is already leaving), sorted
 * by how close they are to going.
 */
function readLobbies(m) {
  const out = [];
  const arr = m && Array.isArray(m.lobbies) ? m.lobbies : [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const game = typeof row.game === 'string' ? row.game : '';
    const n = Math.floor(Number(row.n));
    const need = Math.floor(Number(row.need));
    if (!game || !Number.isFinite(n) || !Number.isFinite(need)) continue;
    if (n <= 0 || need <= 1 || n >= need) continue;
    const room = typeof row.room === 'string' && row.room
      ? row.room
      : (hasOwn(MINIGAMES, game) ? MINIGAMES[game].room : '');
    if (!room) continue;
    out.push({ game, room, n, need, seats: need - n });
  }
  out.sort((a, b) => a.seats - b.seats || b.n - a.n);
  LOBBIES = out;
}

/** Read an 'fpresence' frame into FRIEND_AT. */
function readPresence(m) {
  FRIEND_AT.clear();
  const arr = m && Array.isArray(m.friends) ? m.friends : [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const name = typeof f.name === 'string' ? f.name.trim().slice(0, 24) : '';
    const room = typeof f.room === 'string' ? f.room : '';
    if (!name || !room) continue; // no room = offline, and offline is not a marker
    const list = FRIEND_AT.get(room) || [];
    if (list.length < 6) list.push(name);
    FRIEND_AT.set(room, list);
  }
}

// The gate, not the game: a capy waiting for a race is standing at the sled
// gate, and that is where you are being asked to walk. Anything not named here
// falls back to the game's own name, so a new minigame still reads sensibly.
const GATE_NAME = {
  sled: 'the sled gate',
  fishing: 'the fishing dock',
  smoothie: 'the smoothie counter',
  prophunt: 'the prop hunt',
  doodle: 'the doodle circle',
  pong: 'the pong table',
  shuffle: 'the shuffle table',
  connect4: 'the four-in-a-row table',
  chess: 'the chess table',
  cards: 'the Capy Clash table',
};

const gateLabel = (game) => (hasOwn(GATE_NAME, game) ? GATE_NAME[game]
  : hasOwn(MINIGAMES, game) ? MINIGAMES[game].name : 'a game');

const roomLabel = (id) => (hasOwn(ROOM_INFO, id) ? ROOM_INFO[id].name
  : typeof id === 'string' && id.startsWith('house:') ? `${id.slice(6)}'s Den` : id);

/**
 * This room's head count, corrected for a move we made after the count was
 * taken: the frame still has us standing in the room we left, and a five second
 * old "0 here" in a room you are visibly standing in reads as broken.
 */
function roomPop(id) {
  if (!id || !POP.seen) return 0;
  const n = hasOwn(POP.rooms, id) ? POP.rooms[id] : 0;
  if (SELF.at <= POP.at) return n;
  if (SELF.room === id) return n + 1;
  if (SELF.prev === id) return Math.max(0, n - 1);
  return n;
}

/** Up to three capy heads, then one head and a count: the pills are 11px tall. */
function fillHeads(el, n) {
  el.textContent = '';
  if (!(n > 0)) return;
  for (let i = 0; i < (n <= 3 ? n : 1); i++) {
    const h = document.createElement('i');
    h.className = 'pop-capy';
    el.appendChild(h);
  }
  if (n > 3) {
    const b = document.createElement('b');
    b.textContent = `x${n}`;
    el.appendChild(b);
  }
}

/** Seats as heads: taken ones are capys, free ones are empty cushions. */
function fillPips(el, n, need) {
  el.textContent = '';
  const max = Math.min(Math.max(need, 0), 6);
  for (let i = 0; i < max; i++) {
    const d = document.createElement('i');
    d.className = i < n ? 'pip pop-capy' : 'pip';
    el.appendChild(d);
  }
}

/** "one more capy and they're off" / "2 seats left": never a countdown. */
const seatsLine = (l) => (l.seats <= 1
  ? "one more capy and they're off"
  : `${l.seats} seats still open`);

// ---- stamp slam -----------------------------------------------------------
// A stamp is the game saying "that thing you just did was worth doing", so it
// gets the whole screen for four seconds. Queued: two at once would stack.

const slamQueue = [];
let slamBusy = false;
let slamWaiting = false;

function queueSlam(game, m) {
  const id = typeof m?.id === 'string' ? m.id
    : typeof m?.stamp === 'string' ? m.stamp : null;
  if (!id) return;
  slamQueue.push(id);
  if (!slamBusy) nextSlam(game);
}

function nextSlam(game) {
  if (!slamQueue.length) { slamBusy = false; return; }
  // never land on top of a running minigame: it would eat the screen mid-run
  if (game.activeMinigame) {
    slamBusy = false;
    if (!slamWaiting) {
      slamWaiting = true;
      const off = game.events.on('minigame', (id) => {
        if (id) return;
        try { off(); } catch { /* already gone */ }
        slamWaiting = false;
        if (!slamBusy) nextSlam(game);
      });
    }
    return;
  }
  slamBusy = true;
  showStampSlam(game, slamQueue.shift(), () => nextSlam(game));
}

function showStampSlam(game, id, done) {
  ensureCoveStyles();
  const stamp = stampById(id);
  const host = document.getElementById('hud-root') || document.body;

  const root = document.createElement('div');
  root.className = 'slam';
  root.setAttribute('role', 'status');
  root.innerHTML = `
    <div class="slam-rays"></div>
    <div class="slam-art"><canvas></canvas></div>
    <div class="slam-kicker">Stamp earned</div>
    <div class="slam-name"></div>
    <div class="slam-desc"></div>
    <div class="slam-tap">Click to carry on</div>`;
  root.querySelector('.slam-name').textContent = stamp.name;
  root.querySelector('.slam-desc').textContent = stamp.desc;
  const size = Math.max(180, Math.min(300, Math.round(Math.min(innerWidth, innerHeight) * 0.36)));
  paintStampCanvas(root.querySelector('.slam-art canvas'), stamp, true, size);

  // sparks thrown off the moment the stamp lands
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('i');
    s.className = 'slam-spark';
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
    const d = size * (0.55 + Math.random() * 0.5);
    s.style.setProperty('--dx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--dy', `${Math.sin(a) * d}px`);
    s.style.background = ['#f2b64a', '#fff6e3', '#e8657a', '#4fb3e8'][i % 4];
    s.style.animationDelay = `${0.24 + (i % 5) * 0.03}s`;
    root.appendChild(s);
  }
  host.appendChild(root);

  game.audio?.play?.('levelup');
  const chime = setTimeout(() => game.audio?.play?.('sparkle'), 420);

  let gone = false;
  const bye = () => {
    if (gone) return;
    gone = true;
    clearTimeout(chime);
    clearTimeout(timer);
    root.removeEventListener('click', bye);
    root.classList.add('is-out');
    setTimeout(() => { root.remove(); done(); }, 420);
  };
  const timer = setTimeout(bye, 4600);
  root.addEventListener('click', bye);
}

/** In-world HUD: coins, room name, chat, emotes, map, mute, shop, menu. */
export function initHud(game) {
  const root = document.getElementById('hud-root');
  root.innerHTML = `
    <div class="hud-top-left">
      <button class="logo-chip" id="btn-menu" type="button" title="Menu, how to play, sound" aria-haspopup="dialog">${GAME_NAME}</button>
      <div class="room-chip"><span id="room-name">...</span><span id="pop-count"></span></div>
      <div class="net-dot" id="net-dot" role="img" aria-label="Connection status">
        <span class="net-tip" id="net-tip">Paddling out to the cove...</span>
      </div>
    </div>
    <div class="hud-top-right">
      <div class="coins-pill" id="coins-pill"><span class="coin-ico">&#9679;</span><span id="coin-count">0</span></div>
      <button class="hud-btn" id="btn-shop" title="Wardrobe & Shop">&#127913;</button>
      <button class="hud-btn" id="btn-cam" title="Camera view">&#127909;</button>
      <button class="hud-btn" id="btn-mute" title="Sound">&#128266;</button>
      <button class="hud-btn" id="btn-tour" title="Replay the welcome tour" aria-label="Replay the welcome tour">?</button>
    </div>
    <div class="hud-bottom">
      <div class="emotes">
        <button class="hud-btn" id="btn-wave" title="Wave">&#128075;</button>
        <button class="hud-btn" id="btn-dance" title="Dance">&#128378;</button>
      </div>
      <form id="chat-form" autocomplete="off">
        <input id="chat-input" maxlength="120" placeholder="Say something nice..." />
        <button type="submit" class="hud-btn">&#10148;</button>
      </form>
      <button class="hud-btn wide" id="btn-map">&#128506; Map</button>
    </div>
    <div class="chat-log" id="chat-log"></div>
    <div class="chat-history hidden" id="chat-history">
      <div class="chat-history-head">Chat history<span class="chat-history-hint">Esc to close</span></div>
      <div class="chat-history-scroll" id="chat-history-scroll"></div>
      <div class="chat-history-empty" id="chat-history-empty">The cove is quiet. Say hello!</div>
    </div>
    <div class="toasts" id="toasts"></div>
    <div class="lobby-chip" id="lobby-chip" role="status" hidden>
      <i class="pips" id="lobby-chip-pips"></i>
      <div class="lobby-chip-txt"></div>
      <button class="cove-go" id="lobby-chip-go" type="button">Go</button>
      <button class="lobby-chip-x" id="lobby-chip-x" type="button" title="Not right now" aria-label="Not right now">&#10005;</button>
    </div>
    <div class="map-overlay hidden" id="map-overlay"></div>
  `;

  const $ = (id) => document.getElementById(id);

  // coins
  game.events.on('coins', (total, delta, reason) => {
    $('coin-count').textContent = total;
    if (delta > 0) {
      game.toast(`+${delta} coins${reason && reason !== 'sync' ? ` (${reason})` : ''}`);
      popCoins($('coins-pill'), delta);
    }
  });
  $('coin-count').textContent = game.state.coins;

  // room. Player dens are dynamic rooms ('house:<owner>') and never appear in
  // ROOM_INFO, so they name themselves off the visit context the den flow parked
  // before travelling (see net/client.js visitHouse).
  game.events.on('room', (id) => {
    const info = Object.prototype.hasOwnProperty.call(ROOM_INFO, id) ? ROOM_INFO[id] : null;
    if (info) {
      // No arrival toast (playtester call, 2026-08-07): you walked through the
      // archway or clicked the map, you know where you are, and the room chip
      // top-left already says so.
      $('room-name').textContent = info.name;
      return;
    }
    const owner = typeof id === 'string' && id.startsWith('house:')
      ? (game.__houseCtx?.owner || id.slice(6))
      : null;
    if (!owner) { $('room-name').textContent = id; return; }
    // guests own no den, so a guest who happens to share the owner's nickname
    // is still a visitor
    const mine = !!game.state?.registered
      && String(game.state.name || '').toLowerCase() === String(owner).toLowerCase();
    $('room-name').textContent = `${owner}'s Den`;
    game.toast(`${owner}'s Den : ${mine ? 'home sweet home' : 'make yourself at home'}`, 2200);
  });
  // The room chip's live count. Until the first 'pop' frame lands this is the
  // room snapshot's own player list (bots included, which is what it always
  // was); after that it is the island's own count for this room, which excludes
  // bots, so the two are never mixed and the number never jumps for a bot.
  let roomPeers = 0;
  let lastShown = -1;
  function paintRoomChip() {
    const el = $('pop-count');
    if (!el) return;
    const n = POP.seen ? roomPop(game.roomId) : roomPeers;
    el.classList.toggle('is-solo', POP.seen && n === 1);
    el.textContent = n > 1 ? ` * ${n} here` : (POP.seen && n === 1 ? ' * just you' : '');
    // a bump when someone walks in, never when they leave: arrivals are the
    // news, and a chip that flinches at goodbyes is not a cozy chip
    if (n > lastShown && lastShown >= 0 && n > 1) {
      el.classList.remove('bump');
      void el.offsetWidth; // restart the keyframes
      el.classList.add('bump');
    }
    lastShown = n;
  }
  game.events.on('population', (n) => {
    roomPeers = Number.isFinite(n) ? n : 0;
    paintRoomChip();
  });

  // net status
  let lastNet = null;
  let deniedMsg = null;
  game.events.on('net', (s) => {
    $('net-dot').className = `net-dot ${s === 'online' ? 'on' : 'off'}`;
    const tip = $('net-tip');
    if (tip) {
      tip.textContent = s === 'online'
        ? 'Online : everyone can see you'
        : `Offline : ${deniedMsg || 'swimming solo, still fun'}`;
    }
    $('net-dot').setAttribute('aria-label', s === 'online' ? 'Online' : 'Offline');
    // only on the transition: the reconnect backoff would otherwise toast forever
    if (s === 'offline' && lastNet !== 'offline') {
      game.toast(deniedMsg || 'Connection lost, playing solo until it returns', 4200);
    }
    if (s === 'online') deniedMsg = null;
    lastNet = s;
  });
  // the server refused us outright (bad name, expired session): this is terminal,
  // there is no reconnect, so say so instead of sitting on "paddling out..."
  // (main.js already re-validates any saved token on load, so nothing to clear)
  game.events.on('net-denied', (msg) => { deniedMsg = msg || 'the cove would not let us in'; });

  // chat
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value;
    $('chat-input').value = '';
    if (!text.trim()) return;
    // /w Name message (or /msg): private whisper to one online player
    const w = text.trim().match(/^\/(?:w|msg|whisper)\s+(\S+)\s+(.+)$/i);
    if (w) { game.net?.send({ t: 'whisper', to: w[1], text: w[2].slice(0, 120) }); return; }
    game.say(text);
    game.engine?.showBubble(game.engine.playerAvatar.group, text.trim().slice(0, 120));
  });

  // The log at the bottom left only ever shows the last few lines and fades
  // them out. The full history (last HISTORY_MAX lines) lives in a scrollable
  // card that takes its place while the chat box has focus.
  const chatInput = $('chat-input');
  const historyPanel = $('chat-history');
  const historyScroll = $('chat-history-scroll');
  const historyEmpty = $('chat-history-empty');
  let historyOpen = false;
  let overHistory = false; // scrolling/selecting inside the card must not close it

  const scrollHistoryDown = () => { historyScroll.scrollTop = historyScroll.scrollHeight; };

  function makeLine(name, text, self) {
    const line = document.createElement('div');
    line.className = `chat-line${self ? ' self' : ''}`;
    const who = document.createElement('b');
    who.textContent = name;
    line.appendChild(who);
    line.appendChild(document.createTextNode(` ${text}`));
    return line;
  }

  function openHistory() {
    if (historyOpen) return;
    historyOpen = true;
    historyPanel.classList.remove('hidden');
    $('chat-log').classList.add('is-tucked');
    scrollHistoryDown(); // reading scrollHeight flushes layout, so this lands
  }

  function closeHistory() {
    if (!historyOpen) return;
    historyOpen = false;
    historyPanel.classList.add('hidden');
    $('chat-log').classList.remove('is-tucked');
  }

  game.events.on('chat', ({ name, text, self, whisper, replyTo }) => {
    const log = $('chat-log');
    const line = makeLine(name, text, self);
    if (whisper) {
      line.classList.add('whisper');
      // click a whisper to prefill the reply
      line.style.pointerEvents = 'auto';
      line.style.cursor = 'pointer';
      line.onclick = () => { const i = $('chat-input'); i.value = `/w ${replyTo} `; i.focus(); };
    }
    log.appendChild(line);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => { line.classList.add('fade-out'); setTimeout(() => line.remove(), 900); }, whisper ? 14000 : 9000);

    // stay pinned to the newest line unless the player scrolled up to read
    const atBottom = historyScroll.scrollHeight - historyScroll.scrollTop
      - historyScroll.clientHeight < 56;
    const kept = makeLine(name, text, self);
    if (whisper) kept.classList.add('whisper');
    kept.classList.add('chat-history-line');
    historyScroll.appendChild(kept);
    while (historyScroll.children.length > HISTORY_MAX) historyScroll.firstChild.remove();
    historyEmpty.classList.add('hidden');
    if (historyOpen && atBottom) scrollHistoryDown();
  });

  chatInput.addEventListener('focus', openHistory);
  chatInput.addEventListener('blur', () => { if (!overHistory) closeHistory(); });
  historyPanel.addEventListener('pointerenter', () => { overHistory = true; });
  historyPanel.addEventListener('pointerleave', () => {
    overHistory = false;
    if (document.activeElement !== chatInput) closeHistory();
  });
  // don't let game hotkeys eat chat typing
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      overHistory = false;
      closeHistory();
      chatInput.blur();
    }
  });
  // Escape with the pointer parked on the card (input already blurred)
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyOpen && document.activeElement !== chatInput) {
      overHistory = false;
      closeHistory();
    }
  });
  // a minigame covers the HUD: never leave the card hanging underneath it
  game.events.on('minigame', (id) => { if (id) { overHistory = false; closeHistory(); } });

  // emotes
  $('btn-wave').onclick = () => game.emote('wave');
  $('btn-dance').onclick = () => game.emote('dance');

  // mute (the menu can flip this too, so the icon follows a 'mute' event)
  const setMuteIcon = (m) => {
    $('btn-mute').innerHTML = m ? '&#128263;' : '&#128266;';
    $('btn-mute').setAttribute('aria-pressed', m ? 'true' : 'false');
  };
  setMuteIcon(!!game.audio?.muted);
  $('btn-mute').onclick = () => {
    const m = game.audio.toggleMute();
    setMuteIcon(m);
    game.events.emit('mute', m);
  };
  game.events.on('mute', (m) => setMuteIcon(!!m));

  // camera view: soft-follow your capy, or one fixed shot of the whole room.
  // The engine owns the mode (and persists it); the button just mirrors it.
  const camBtn = $('btn-cam');
  const CAM_COPY = {
    follow: 'Camera: following your capy. Press C for a fixed view of the whole room.',
    static: 'Camera: fixed view of the whole room. Press C to follow your capy.',
  };
  const setCamBtn = (mode) => {
    const wide = mode === 'static';
    camBtn.setAttribute('aria-pressed', wide ? 'true' : 'false');
    camBtn.title = wide ? CAM_COPY.static : CAM_COPY.follow;
    // styles.css has no pressed state for .hud-btn, so the "on" look is set
    // here: gold like the coins pill, matching the HUD's accent
    camBtn.style.background = wide ? 'linear-gradient(180deg, #ffe6b4 0%, #f2b64a 100%)' : '';
  };
  setCamBtn(game.engine?.cameraMode || 'follow');
  camBtn.onclick = () => game.engine?.toggleCameraMode();
  game.events.on('camera-mode', (mode) => {
    setCamBtn(mode);
    game.toast(mode === 'static' ? 'Camera: whole room' : 'Camera: follow your capy', 1800);
  });
  // C toggles it too. Same guard as the main.js hotkeys: not while typing in a
  // field, not while a minigame owns the screen, not on a held key.
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (game.activeMinigame || e.repeat) return;
    if (e.key === 'c' || e.key === 'C') game.engine?.toggleCameraMode();
  });

  // shop (loaded on demand, like the plaza hotspot, so it stays out of the entry chunk)
  $('btn-shop').onclick = () => import('./shop.js')
    .then((m) => m.openShop(game))
    .catch((e) => { console.error('[hud] shop failed to load:', e); game.toast('The shop is not answering, try again'); });

  // "?": replay the first-run tour (same on-demand load as the shop button;
  // the module clears the 'capycove-toured' flag and runs it from beat 1)
  $('btn-tour').onclick = () => import('./firstrun.js')
    .then((m) => m.replayTour(game))
    .catch((e) => { console.error('[hud] tour failed to load:', e); game.toast('The tour guide is having a nap, try again'); });

  // menu (same on-demand load: pause card, how to play, sound, log out)
  $('btn-menu').onclick = () => import('./menu.js')
    .then((m) => m.openMenu(game))
    .catch((e) => { console.error('[hud] menu failed to load:', e); game.toast('The menu is stuck in the sand, try again'); });

  // toasts
  game.events.on('toast', (msg, ms = 2600) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 500); }, ms);
  });

  // ---- the social cove (wave 7) --------------------------------------------
  ensureCoveStyles();

  // Parties: one island-wide at a time. These listeners are registered BEFORE
  // buildMap so the map's own party listener always sees fresh state.
  game.events.on('party', (m) => { party = parseParty(m); });
  game.events.on('party-start', (m) => {
    // a refusal carries the wait, which is what the menu's throw button reads
    if (m?.ok === false) {
      const wait = Number(m.retryIn ?? m.cooldown ?? m.wait);
      // The menu locks the button optimistically the moment it sends, so a
      // refusal that carries no wait (guest, missing den confirm) has to RELEASE
      // that lock: otherwise one refused request hid the button for 90 minutes.
      game.__partyCooldownUntil = Number.isFinite(wait) && wait > 0 ? Date.now() + wait * 1000 : 0;
      if (m.msg) game.toast(m.msg, 4200);
      return;
    }
    const p = parseParty(m);
    if (!p) return;
    party = p;
    if (String(game.state?.name || '').trim().toLowerCase() === p.host.toLowerCase()) {
      const cd = Number(m.cooldown);
      game.__partyCooldownUntil = Date.now() + (Number.isFinite(cd) && cd > 0 ? cd : 90 * 60) * 1000;
    }
    const mine = String(game.state?.name || '').trim().toLowerCase() === p.host.toLowerCase();
    game.audio?.play?.('sparkle');
    game.toast(mine
      ? `Your party is on at ${p.label}. Go and be a good host!`
      : `${p.host} is throwing a party at ${p.label}!`, 5200);
  });
  game.events.on('party-end', (m) => {
    const host = party?.host || (typeof m?.host === 'string' ? m.host : null);
    const label = party?.label;
    const mine = !!host && String(game.state?.name || '').trim().toLowerCase() === host.toLowerCase();
    party = null;
    const count = Number(m?.count ?? m?.guests);
    // the host's bragging rights: capys who came, never coins
    if (mine && Number.isFinite(count)) {
      game.toast(count > 0
        ? `Party over: ${count} cap${count === 1 ? 'y' : 'ys'} came by. Nicely hosted.`
        : 'Party over. A quiet one, but the cove noticed you tried.', 5200);
    } else if (label) {
      game.toast(`The party at ${label} has wound down.`, 3000);
    }
  });

  // Quest ticks and stamps happen wherever the player is, so the juice lives in
  // the shell rather than inside the board and album overlays.
  game.events.on('quest-done', (m) => {
    const name = typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : null;
    const coins = Number(m?.reward ?? m?.coins);
    game.audio?.play?.('levelup');
    game.toast(name
      ? `Quest done: ${name}${Number.isFinite(coins) && coins > 0 ? ` (+${coins} coins)` : ''}`
      : 'Daily quest done!', 3600);
  });
  game.events.on('stamp', (m) => queueSlam(game, m));

  // ---- co-presence (wave 12) -----------------------------------------------
  // 'pop' and 'fpresence' land HERE first and are read into module state, then
  // everything else (the room chip, the chip below, the map's pills, strip and
  // markers) repaints off that state. Registered before buildMap so the map's
  // own listeners can never run against a stale frame.

  const chip = $('lobby-chip');
  const chipTxt = chip.querySelector('.lobby-chip-txt');
  const chipPips = $('lobby-chip-pips');
  const CHIP_MS = 15000;      // how long one invitation sits on screen
  const CHIP_QUIET = 150000;  // and how long that game then keeps its peace
  let chipGame = null;
  let chipRoom = null;
  let chipTimer = 0;
  const chipQuiet = new Map(); // game -> "don't ask again before"

  function hideChip() {
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = 0; }
    chip.hidden = true;
    chipGame = null;
    chipRoom = null;
  }

  function fillChip(l) {
    chipRoom = l.room;
    fillPips(chipPips, l.n, l.need);
    chipTxt.textContent = '';
    const head = document.createElement('span');
    head.textContent = `${l.n}/${l.need} at ${gateLabel(l.game)}. Go?`;
    const sub = document.createElement('small');
    // the chip is narrow: the strip's longer line would wrap to three lines
    sub.textContent = `${roomLabel(l.room)} : one more capy!`;
    chipTxt.append(head, sub);
  }

  /**
   * One invitation at a time, and only when a lobby is one capy short of
   * going: that is the moment where walking over actually starts a game. It
   * never nags (one showing per game per CHIP_QUIET, dismissable), never talks
   * over a minigame, and never asks you to travel to the room you are in.
   */
  function refreshLobbyChip() {
    if (game.activeMinigame) { hideChip(); return; }
    const now = Date.now();
    const live = LOBBIES.filter((l) => l.seats <= 1 && l.room !== game.roomId);
    if (chipGame) {
      // keep the chip on its slot while its lobby is still short a capy, so the
      // count ticks up in place rather than the chip flickering out and back
      const same = live.find((l) => l.game === chipGame);
      if (same) { fillChip(same); return; }
      hideChip();
    }
    const pick = live.find((l) => (chipQuiet.get(l.game) || 0) <= now);
    if (!pick) return;
    chipQuiet.set(pick.game, now + CHIP_QUIET);
    chipGame = pick.game;
    fillChip(pick);
    chip.hidden = false;
    game.audio?.play?.('pop');
    chipTimer = setTimeout(hideChip, CHIP_MS);
  }

  $('lobby-chip-go').onclick = () => {
    const room = chipRoom;
    hideChip();
    game.audio?.play?.('whoosh');
    if (room && game.roomId !== room) game.goToRoom(room);
  };
  $('lobby-chip-x').onclick = () => {
    if (chipGame) chipQuiet.set(chipGame, Date.now() + CHIP_QUIET * 2);
    game.audio?.play?.('click');
    hideChip();
  };

  game.events.on('pop', (m) => {
    readPop(m);
    readLobbies(m);
    paintRoomChip();
    refreshLobbyChip();
  });
  game.events.on('fpresence', (m) => { readPresence(m); });
  game.events.on('room', (id) => {
    if (id !== SELF.room) { SELF.prev = SELF.room; SELF.room = id; SELF.at = Date.now(); }
    paintRoomChip();
    refreshLobbyChip();
  });
  game.events.on('minigame', (id) => { if (id) hideChip(); });

  // map
  buildMap(game, $('map-overlay'));
  $('btn-map').onclick = () => { $('map-overlay').classList.toggle('hidden'); game.audio.play('click'); };
}

/** Coin pill scale bounce whenever the purse grows. */
function popCoins(pill, delta) {
  if (!pill) return;
  pill.classList.remove('pop', 'pop-big');
  void pill.offsetWidth; // restart the keyframes
  pill.classList.add(delta >= 40 ? 'pop-big' : 'pop');
}

// ---------------------------------------------------------------------------
// Map: a hand painted island. Everything below is drawn to a <canvas> in code,
// so the map costs no assets and scales to any card size.
// ---------------------------------------------------------------------------

// Painted landmark centres, in fractions of the island box. The Game Den lives
// inside the ski lodge, so it sits up on the peak's snowfield, not on the grass.
// The mine mouth is cut into the peak's west flank; the jungle is the canopy
// the beach path disappears into, inland of the sand.
//
// Deviation from docs/PARTY-GAMES.md, on purpose: the spec puts the jungle
// "north of the beach", and the north-west headland is where it was first
// painted. Nothing could label it there: that stretch of west coast is spoken
// for by the lodge and the dock, and a pill over either buries them. Moving the
// canopy to the head of the beach path gave it open ground of its own, which is
// what a map has to do (its label now points in at it from the plaza side).
const ART = {
  plaza: [0.500, 0.465],
  beach: [0.170, 0.570],
  peak: [0.500, 0.195],
  cafe: [0.795, 0.400],
  lounge: [0.362, 0.284],
  // The Trophy Loft is the storey ABOVE the Game Den, so it has no landmark of
  // its own: it is the same painted lodge, and the "you are here" pin just
  // climbs to the upper window rather than the door.
  loft: [0.352, 0.262],
  club: [0.690, 0.700],
  mine: [0.458, 0.252],
  jungle: [0.334, 0.582],
  // The Drift is under the water off the west coast: painted buoy, "you are
  // here" pin, and (since the map card grew) a pill of its own at the buoy.
  drift: [0.062, 0.600],
};

// Label pills ring the island instead of tiling down it. The old cascade
// (eight labels in ~11% bands down the west coast) was written for a 680px
// card whose box went as flat as 628x270; the card now sizes itself off the
// island box (styles.css .map-card), so the box is 808x440 on a 1280x720
// screen and 619x335 on a 960x540 one, the pills are 11px instead of 13px,
// and a label can sit beside its own landmark instead of queueing for a band.
//
// Placement rules, in order: (1) open water or the sand ring wherever the
// landmark is near a coast, (2) the quietest patch of grass next to it
// otherwise, (3) never on top of a landmark, the compass rose, the sailboat or
// the dive buoy. `dir` is the edge the pointer nub sits on, and it always
// faces the landmark: the peak label hangs over the north water pointing down
// at the summit, the Glimmer Mine sits below the mountain pointing up at its
// mouth, and so on. Verified by pairwise getBoundingClientRect: zero overlaps
// at 1600x900, 1280x720, 960x540, and, with the phone font steps in
// styles.css, at 480x800 and 360x640. Since the Trophy Loft joined, the
// closest pair in the set is always it and the Game Den under it, because they
// label two floors of one building: 23px apart at 1600x900 and 1280x720, 12px
// at 960x540 and 480x800, 3.5px at 360x640 (where the card is 269x199 and the
// peak and beach labels already overhang the island into the card's padding).
const MAP_SPOTS = [
  { id: 'peak', bx: 50, by: 4.5, dir: 'down' },
  // The two den floors stack the way the building does: the Trophy Loft above
  // the Game Den, both nubs pointing right at the one lodge they share. 11.5%
  // of box height apart, and the den moved 1.5 down to buy it: at 9 apart the
  // pair measured 2.9px of daylight on the 960x540 card, which reads as
  // touching. Re-measured pairwise after the move (see the note above).
  { id: 'loft', bx: 22, by: 8, dir: 'right' },
  { id: 'lounge', bx: 22, by: 19.5, dir: 'right' },
  { id: 'cafe', bx: 81, by: 29.5, dir: 'down' },
  { id: 'mine', bx: 45, by: 32.5, dir: 'up' },
  { id: 'plaza', bx: 62, by: 46, dir: 'left' },
  { id: 'beach', bx: 13, by: 47, dir: 'down' },
  { id: 'jungle', bx: 48, by: 60, dir: 'left' },
  { id: 'drift', bx: 9, by: 68, dir: 'up' },
  { id: 'club', bx: 69, by: 80, dir: 'up' },
  { id: 'speedway', bx: 30, by: 74, dir: 'up' },
];

// The lodge window and chimney, as offsets from the lounge landmark centre in
// R() units: the painted layer and the live glow/smoke must agree on them.
const DEN_WINDOW = [0.018, 0.019];
const DEN_CHIMNEY = [-0.024, -0.040];

// Same deal for the mine's lantern (flicker) and the jungle's plunge pool
// (ripples + falling water), as offsets from their landmark centres.
const MINE_LAMP = [-0.0315, -0.006];
const JUNGLE_POOL = [-0.030, 0.030];
const JUNGLE_FALL = [-0.030, 0.004];

// ---- the world clock, as the map sees it ----------------------------------
// The server owns the clock and sends {t:'clock', dayT, weather, aurora} every
// 10s (docs/LIVING-COVE.md section A). Between frames the map advances dayT
// itself, one cove day = 40 real minutes, so the light never steps. dayT < 0
// means "no clock frame has landed yet": every painter below is then a no-op
// and the map paints exactly as it did before this wave.
// (the frame carries the real length as `dayMs`; the constant is only the value
// used until the first one lands, so a server on a different day length still
// interpolates at the right rate)
let COVE_DAY_MS = 40 * 60 * 1000;
const MAP_CLOCK = { dayT: -1, at: 0, weather: 'clear', aurora: false };

function mapDayT() {
  if (MAP_CLOCK.dayT < 0) return -1;
  const d = MAP_CLOCK.dayT + (performance.now() - MAP_CLOCK.at) / COVE_DAY_MS;
  return d - Math.floor(d);
}

/**
 * Dusk-to-dawn strength, 0..1, ramped at both ends so nothing snaps on.
 * The bonfire burns on it and the dive bell's lamp brightens on it.
 */
function nightK(dayT) {
  if (dayT < 0) return 0;
  const d = dayT < 0.5 ? dayT + 1 : dayT;      // 0.50 dusk .. 1.50 next dusk
  if (d <= 0.98) return 1;                     // dusk and all night
  if (d < 1.02) return 1 - (d - 0.98) / 0.04;  // dawn: it dies down
  if (d < 1.44) return 0;                      // day: cold logs, brass in sun
  return (d - 1.44) / 0.06;                    // dusk: it catches
}

// The sky wash, in dayT order: dawn, noon, dusk, midnight. Alphas stay low on
// purpose. This is the hour changing on a paper map, not a night filter: the
// pills are DOM above the canvas so labels never dim, and at 0.30 every
// landmark still reads at midnight.
const MAP_TINT = [
  [255, 170, 118, 0.17],
  [255, 246, 214, 0.00],
  [255, 132, 92, 0.20],
  [40, 54, 116, 0.30],
];

// The bonfire sits on the open sand north of the dock, as an R() offset from
// the beach landmark so it holds its distance from the dock at every card
// size: R is min(w, h), and the island box is 400px tall at every viewport
// that matters, so only the map's width moves under it.
const BEACH_FIRE = [-0.008, -0.070];

// The dive-bell buoy (see the ART comment). Same array, one source of truth,
// so the painted buoy and the "you are here" pin can never drift apart.
const DRIFT_BUOY = ART.drift;

const MAP_HINT = 'Pick a spot to waddle over. Press M to close the map.';

// Island silhouette: 16 radius factors, index 0 = east, going clockwise.
const ISLE = [1.02, 1.05, 1.06, 0.99, 0.94, 0.98, 1.00, 0.95, 0.86, 0.98, 1.03, 0.98, 1.05, 1.00, 1.05, 0.99];
const GRASS_K = [0.90, 0.90, 0.91, 0.90, 0.90, 0.90, 0.86, 0.78, 0.70, 0.80, 0.88, 0.90, 0.92, 0.92, 0.90, 0.90];
const GRASS = ISLE.map((v, i) => v * GRASS_K[i]);

const CX = 0.500; // island centre / radii, as fractions of the box
const CY = 0.485;
const RX = 0.400;
const RY = 0.395;

const C = {
  ink: '#3a2c1c',
  seaDeep: '#2a6ea6',
  seaMid: '#3f9bd0',
  seaShallow: '#7ed8dd',
  sand: '#f7e4b0',
  sandDark: '#e7cd92',
  grass: '#8ecb5d',
  grassLight: '#a9dd77',
  grassDark: '#63a13f',
  snow: '#f3faff',
  snowShade: '#d6e8f6',
  rock: '#8ba2ba',
  rockDark: '#6b83a0',
  cobble: '#ead7ae',
  cobbleStone: '#cdb27f',
  wood: '#ad7a4d',
  woodDark: '#8a5c37',
  cream: '#fff6e3',
  coral: '#e8657a',
  gold: '#f2b64a',
  purple: '#9b6bd4',
  purpleLight: '#c79cf0',
  water: '#63c3e8',
};

const SEA_SPARKS = [
  [0.06, 0.30], [0.10, 0.52], [0.07, 0.72], [0.20, 0.90], [0.38, 0.94], [0.55, 0.91],
  [0.72, 0.93], [0.88, 0.74], [0.94, 0.53], [0.91, 0.36], [0.80, 0.10], [0.62, 0.05],
  [0.44, 0.04], [0.26, 0.07], [0.13, 0.17], [0.95, 0.87],
];

// The two west-slope pines give the den lodge its clearing; the rest are the
// peak's usual treeline. Two of them moved for wave 6: one stood exactly where
// the mine mouth is now cut, one stood inside the jungle canopy, so both went
// back onto the west slope as a stand running down toward the jungle.
const PINES = [
  [0.412, 0.232, 0.86], [0.302, 0.348, 0.88], [0.402, 0.348, 0.82], [0.615, 0.292, 1.00],
  [0.663, 0.338, 0.88], [0.575, 0.352, 0.78], [0.262, 0.232, 0.68], [0.560, 0.244, 0.68],
  [0.712, 0.400, 0.84], [0.296, 0.262, 0.76], [0.248, 0.318, 0.70], [0.742, 0.320, 0.72],
];

// One tree used to stand at [0.330, 0.600]: the jungle canopy took its place
// (and brings far more foliage than it did).
const TREES = [
  [0.402, 0.662, 0.84], [0.600, 0.618, 0.94], [0.548, 0.702, 0.80],
  [0.752, 0.552, 0.90], [0.700, 0.470, 0.74], [0.262, 0.500, 0.80], [0.470, 0.722, 0.88],
  [0.800, 0.620, 0.78], [0.372, 0.512, 0.68], [0.320, 0.716, 0.86], [0.612, 0.762, 0.78],
  [0.532, 0.786, 0.70], [0.268, 0.652, 0.74], [0.678, 0.516, 0.90],
];

const ROCKS = [
  [0.452, 0.812, 1.00], [0.366, 0.700, 0.7], [0.646, 0.586, 0.8], [0.214, 0.472, 0.75],
  [0.742, 0.700, 0.85],
];

const FLOWERS = [
  [0.430, 0.560, C.coral], [0.575, 0.552, C.gold], [0.628, 0.545, C.coral],
  [0.375, 0.560, C.gold], [0.520, 0.620, C.coral], [0.652, 0.610, C.gold],
  [0.452, 0.664, C.gold], [0.482, 0.352, C.coral], [0.716, 0.520, C.gold],
];

// ---- tiny drawing helpers -------------------------------------------------

/** Smooth closed curve through points (midpoint quadratics: no cusps). */
function smoothClosed(c, pts) {
  const n = pts.length;
  c.beginPath();
  let mx = (pts[n - 1][0] + pts[0][0]) / 2;
  let my = (pts[n - 1][1] + pts[0][1]) / 2;
  c.moveTo(mx, my);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    mx = (p[0] + q[0]) / 2;
    my = (p[1] + q[1]) / 2;
    c.quadraticCurveTo(p[0], p[1], mx, my);
  }
  c.closePath();
}

function shapePath(c, w, h, factors, k = 1, dx = 0, dy = 0) {
  const pts = [];
  for (let i = 0; i < factors.length; i++) {
    const a = (i / factors.length) * Math.PI * 2;
    const r = factors[i] * k;
    pts.push([CX * w + Math.cos(a) * RX * w * r + dx, CY * h + Math.sin(a) * RY * h * r + dy]);
  }
  smoothClosed(c, pts);
}

function outline(c, color, width) {
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}

function blob(c, x, y, rx, ry, wob, seed) {
  const pts = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1 + Math.sin(a * 3 + seed) * wob + Math.sin(a * 5 + seed * 1.7) * wob * 0.6;
    pts.push([x + Math.cos(a) * rx * r, y + Math.sin(a) * ry * r]);
  }
  smoothClosed(c, pts);
}

function circle(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
}

function roundBox(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function poly(c, pts) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
}

/** Round-topped arch (the mine shaft's mouth and the bite of rock around it). */
function archPath(c, x, top, halfW, bottom) {
  c.beginPath();
  c.moveTo(x - halfW, bottom);
  c.lineTo(x - halfW, top + halfW);
  c.quadraticCurveTo(x - halfW, top, x, top);
  c.quadraticCurveTo(x + halfW, top, x + halfW, top + halfW);
  c.lineTo(x + halfW, bottom);
  c.closePath();
}

function fillStroke(c, fill, stroke, lw) {
  c.fillStyle = fill;
  c.fill();
  if (stroke) outline(c, stroke, lw);
}

// ---- the painting ---------------------------------------------------------

function paintBase(c, w, h) {
  const S = Math.min(w, h);
  const R = (v) => v * S;
  const X = (u) => u * w;
  const Y = (v) => v * h;
  c.clearRect(0, 0, w, h);
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // --- open sea -----------------------------------------------------------
  const sea = c.createLinearGradient(0, 0, w * 0.4, h);
  sea.addColorStop(0, C.seaDeep);
  sea.addColorStop(0.5, C.seaMid);
  sea.addColorStop(1, '#25628f');
  c.fillStyle = sea;
  c.fillRect(0, 0, w, h);

  // shallow water hugging the island
  c.save();
  c.translate(X(CX), Y(CY));
  c.scale(1, h / w);
  const halo = c.createRadialGradient(0, 0, w * 0.30, 0, 0, w * 0.68);
  halo.addColorStop(0, 'rgba(126,216,221,0.92)');
  halo.addColorStop(0.55, 'rgba(110,200,214,0.34)');
  halo.addColorStop(1, 'rgba(110,200,214,0)');
  c.fillStyle = halo;
  c.fillRect(-w, -h, w * 2, h * 2);
  c.restore();

  // lazy horizontal swell
  c.save();
  c.globalAlpha = 0.13;
  c.strokeStyle = '#ffffff';
  c.lineWidth = R(0.006);
  for (let i = 0; i < 9; i++) {
    const y = h * (0.06 + i * 0.108);
    c.beginPath();
    for (let x = -20; x <= w + 20; x += w / 14) {
      const yy = y + Math.sin((x / w) * 7 + i) * R(0.008);
      if (x <= -20) c.moveTo(x, yy); else c.lineTo(x, yy);
    }
    c.stroke();
  }
  c.restore();

  // --- wave rings around the coast ---------------------------------------
  c.save();
  c.setLineDash([R(0.022), R(0.018)]);
  for (let i = 0; i < 3; i++) {
    shapePath(c, w, h, ISLE, 1.075 + i * 0.085);
    outline(c, `rgba(255,255,255,${0.36 - i * 0.1})`, R(0.0075));
  }
  c.restore();

  // --- island -------------------------------------------------------------
  // sunk shadow
  shapePath(c, w, h, ISLE, 1.005, 0, R(0.016));
  c.fillStyle = 'rgba(18,64,86,0.30)';
  c.fill();

  // surf foam
  shapePath(c, w, h, ISLE, 1.035);
  c.fillStyle = 'rgba(255,255,255,0.72)';
  c.fill();

  // sand
  shapePath(c, w, h, ISLE, 1);
  fillStroke(c, C.sand, C.ink, R(0.011));

  // sand speckle
  c.save();
  c.globalAlpha = 0.5;
  c.fillStyle = C.sandDark;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + 0.4;
    const k = 0.93 - (i % 3) * 0.03;
    circle(c, X(CX) + Math.cos(a) * RX * w * ISLE[i % 16] * k,
      Y(CY) + Math.sin(a) * RY * h * ISLE[i % 16] * k, R(0.005 + (i % 2) * 0.002));
    c.fill();
  }
  c.restore();

  // grass
  shapePath(c, w, h, GRASS, 1);
  fillStroke(c, C.grass, C.grassDark, R(0.008));
  c.save();
  c.clip();
  shapePath(c, w, h, GRASS, 0.82, -R(0.03), -R(0.04));
  c.fillStyle = C.grassLight;
  c.globalAlpha = 0.55;
  c.fill();
  c.restore();

  // --- snowfield under the peak -------------------------------------------
  blob(c, X(0.5), Y(0.245), w * 0.235, h * 0.105, 0.06, 1.2);
  fillStroke(c, C.snow, C.snowShade, R(0.007));

  // --- mountain stream ----------------------------------------------------
  c.save();
  c.beginPath();
  c.moveTo(X(0.452), Y(0.308));
  c.bezierCurveTo(X(0.40), Y(0.345), X(0.35), Y(0.352), X(0.30), Y(0.392));
  c.bezierCurveTo(X(0.275), Y(0.408), X(0.258), Y(0.404), X(0.228), Y(0.418));
  outline(c, C.ink, R(0.019));
  outline(c, C.water, R(0.013));
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = R(0.004);
  c.stroke();
  c.restore();

  // --- paths from the plaza ----------------------------------------------
  // One per neighbour; the den has no path of its own now that it lives inside
  // the lodge at the top of the peak track.
  const P = [X(ART.plaza[0]), Y(ART.plaza[1])];
  const routes = [
    [[X(0.53), Y(0.36)], [X(0.500), Y(0.268)]],
    [[X(0.645), Y(0.402)], [X(0.772), Y(0.418)]],
    [[X(0.340), Y(0.492)], [X(0.208), Y(0.560)]],
    [[X(0.600), Y(0.582)], [X(0.664), Y(0.664)]],
  ];
  for (const [ctrl, end] of routes) {
    c.beginPath();
    c.moveTo(P[0], P[1]);
    c.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
    outline(c, 'rgba(58,44,28,0.18)', R(0.036));
    outline(c, C.cobble, R(0.026));
  }
  c.save();
  c.setLineDash([R(0.012), R(0.014)]);
  for (const [ctrl, end] of routes) {
    c.beginPath();
    c.moveTo(P[0], P[1]);
    c.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
    outline(c, 'rgba(160,127,80,0.65)', R(0.005));
  }
  c.restore();

  paintPlaza(c, R, X, Y);
  paintPeak(c, R, X, Y);
  for (const [u, v, s] of ROCKS) rock(c, X(u), Y(v), R(0.026) * s);
  for (const [u, v, s] of PINES) pine(c, X(u), Y(v), R(0.062) * s);
  for (const [u, v, s] of TREES) tree(c, X(u), Y(v), R(0.036) * s);
  paintMine(c, R, X, Y);
  paintJungle(c, R, X, Y);
  paintCafe(c, R, X, Y);
  paintLounge(c, R, X, Y);
  paintBeach(c, R, X, Y);
  paintCave(c, R, X, Y);
  lighthouse(c, X(0.398), Y(0.796), R(0.10));

  // flowers, last so they sit on top of the grass work
  for (const [u, v, col] of FLOWERS) {
    const r = R(0.0075);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      circle(c, X(u) + Math.cos(a) * r, Y(v) + Math.sin(a) * r, r * 0.85);
      c.fillStyle = col;
      c.fill();
    }
    circle(c, X(u), Y(v), r * 0.62);
    c.fillStyle = C.cream;
    c.fill();
  }

  paintCompass(c, R, X(0.888), Y(0.135));
}

function paintPlaza(c, R, X, Y) {
  const x = X(ART.plaza[0]);
  const y = Y(ART.plaza[1]);
  const r = R(0.108);

  circle(c, x, y + R(0.008), r);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();

  circle(c, x, y, r);
  fillStroke(c, C.cobble, C.ink, R(0.009));

  // cobbles: two rings of little stones
  c.fillStyle = C.cobbleStone;
  for (let ring = 0; ring < 2; ring++) {
    const rr = r * (0.62 + ring * 0.27);
    const n = 10 + ring * 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + ring * 0.3;
      circle(c, x + Math.cos(a) * rr, y + Math.sin(a) * rr, R(0.0095));
      c.fill();
    }
  }

  // benches
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
    c.save();
    c.translate(x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.78);
    c.rotate(a + Math.PI / 2);
    roundBox(c, -R(0.019), -R(0.006), R(0.038), R(0.012), R(0.005));
    fillStroke(c, C.wood, C.ink, R(0.005));
    c.restore();
  }

  // fountain
  circle(c, x, y, R(0.042));
  fillStroke(c, '#efe6cf', C.ink, R(0.008));
  circle(c, x, y, R(0.031));
  fillStroke(c, '#a8e0f2', '#6fb9d8', R(0.005));
  circle(c, x, y - R(0.004), R(0.011));
  fillStroke(c, '#efe6cf', C.ink, R(0.005));
  // spout arcs
  c.strokeStyle = 'rgba(255,255,255,0.9)';
  c.lineWidth = R(0.005);
  for (const dir of [-1, 1]) {
    c.beginPath();
    c.moveTo(x, y - R(0.016));
    c.quadraticCurveTo(x + dir * R(0.02), y - R(0.03), x + dir * R(0.026), y + R(0.002));
    c.stroke();
  }
}

function paintPeak(c, R, X, Y) {
  const bx = X(0.5);
  const base = Y(0.305);
  const apex = Y(0.128);
  const left = X(0.372);
  const right = X(0.636);

  // shadow
  poly(c, [[left - R(0.01), base + R(0.012)], [right + R(0.01), base + R(0.012)], [bx, apex]]);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();

  // rock body with a second shoulder peak
  poly(c, [
    [left, base],
    [X(0.442), Y(0.196)],
    [bx, apex],
    [X(0.558), Y(0.200)],
    [X(0.592), Y(0.168)],
    [X(0.624), Y(0.226)],
    [right, base],
  ]);
  fillStroke(c, C.rock, C.ink, R(0.011));

  // shaded east face
  poly(c, [[bx, apex], [X(0.558), Y(0.200)], [X(0.592), Y(0.168)], [X(0.624), Y(0.226)], [right, base], [bx, base]]);
  c.fillStyle = C.rockDark;
  c.globalAlpha = 0.55;
  c.fill();
  c.globalAlpha = 1;

  // snow cap
  poly(c, [
    [X(0.442), Y(0.196)],
    [bx, apex],
    [X(0.558), Y(0.200)],
    [X(0.536), Y(0.216)],
    [X(0.514), Y(0.196)],
    [X(0.492), Y(0.222)],
    [X(0.466), Y(0.200)],
  ]);
  fillStroke(c, C.snow, C.ink, R(0.008));

  // shoulder cap
  poly(c, [[X(0.575), Y(0.186)], [X(0.592), Y(0.168)], [X(0.610), Y(0.200)], [X(0.594), Y(0.194)]]);
  fillStroke(c, C.snow, C.ink, R(0.006));

  // sled track down the face
  c.save();
  c.setLineDash([R(0.011), R(0.011)]);
  c.beginPath();
  c.moveTo(X(0.494), Y(0.170));
  c.bezierCurveTo(X(0.462), Y(0.220), X(0.520), Y(0.246), X(0.478), Y(0.298));
  outline(c, 'rgba(255,255,255,0.85)', R(0.006));
  c.restore();
}

/**
 * The Glimmer Mine: a timbered shaft cut into the peak's west flank, one
 * lantern burning over the lintel and amber light welling up out of the dark.
 *
 * It has to thread a needle up there: the rock's west edge runs diagonally
 * (nothing may hang past it into the sky), the snow cap sits above, the sled
 * track dashes down at u ~0.49, and the lodge roof reaches u ~0.42. The mouth
 * spans u 0.432-0.484, v 0.214-0.269 and the pill bands are kept clear of it.
 */
function paintMine(c, R, X, Y) {
  const x = X(ART.mine[0]);
  const y = Y(ART.mine[1]);
  const ow = R(0.0165);     // half width of the opening
  const ft = R(0.005);      // timber thickness
  const cw = ow + ft * 2.2; // the bite taken out of the rock
  const top = y - R(0.020);
  const bot = y + R(0.019);
  const lx = x + R(MINE_LAMP[0]);
  const ly = y + R(MINE_LAMP[1]);

  c.save();

  // lantern light pooled on the rock (the flicker on top is drawn live)
  const spill = c.createRadialGradient(lx, ly, R(0.003), lx, ly, R(0.05));
  spill.addColorStop(0, 'rgba(242,182,74,0.40)');
  spill.addColorStop(1, 'rgba(242,182,74,0)');
  c.fillStyle = spill;
  circle(c, lx, ly, R(0.05));
  c.fill();

  // the bite out of the rock face: a recess in the mountain's own greys, no
  // heavy ink ring, so the mouth reads as a hole rather than a hut on the slope
  archPath(c, x, top - R(0.008), cw, bot + R(0.006));
  fillStroke(c, C.rockDark, 'rgba(58,44,28,0.45)', R(0.004));

  // the dark of the shaft, with amber glow rising from somewhere deeper
  archPath(c, x, top, ow, bot);
  fillStroke(c, '#241c14', C.ink, R(0.005));
  c.save();
  archPath(c, x, top, ow, bot);
  c.clip();
  const deep = c.createLinearGradient(x, bot, x, top - R(0.004));
  deep.addColorStop(0, 'rgba(242,182,74,0.85)');
  deep.addColorStop(1, 'rgba(242,182,74,0)');
  c.fillStyle = deep;
  c.fillRect(x - ow, top - R(0.006), ow * 2, bot - top + R(0.012));
  c.strokeStyle = 'rgba(58,44,28,0.7)'; // a rail running off into the dark
  c.lineWidth = R(0.0026);
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(x + s * ow * 0.62, bot);
    c.lineTo(x + s * ow * 0.3, bot - R(0.013));
    c.stroke();
  }
  // a seam of glimmer down there, amber and teal
  for (const [dx, s, col] of [[-0.006, 1, C.gold], [0.007, 0.75, C.seaShallow]]) {
    poly(c, [
      [x + R(dx) - R(0.0035 * s), bot - R(0.002)],
      [x + R(dx), bot - R(0.002) - R(0.012 * s)],
      [x + R(dx) + R(0.0035 * s), bot - R(0.002)],
    ]);
    c.fillStyle = col;
    c.fill();
  }
  c.restore();

  // timber frame: two posts under a lintel
  for (const s of [-1, 1]) {
    roundBox(c, x + s * (ow + ft * 0.5) - ft / 2, top, ft, bot - top + R(0.004), R(0.002));
    fillStroke(c, C.wood, C.ink, R(0.0042));
  }
  roundBox(c, x - ow - ft * 1.3, top - R(0.008), (ow + ft * 1.3) * 2, R(0.0085), R(0.003));
  fillStroke(c, C.woodDark, C.ink, R(0.0042));

  // the lantern, hung off the west post
  c.beginPath();
  c.moveTo(lx, top - R(0.001));
  c.lineTo(lx, ly - R(0.005));
  outline(c, C.ink, R(0.0026));
  circle(c, lx, ly, R(0.0055));
  fillStroke(c, C.gold, C.ink, R(0.0036));
  circle(c, lx - R(0.0015), ly - R(0.0015), R(0.0017));
  c.fillStyle = C.cream;
  c.fill();

  // spoil heap spilling out of the threshold
  c.beginPath();
  c.moveTo(x - ow - ft, bot + R(0.008));
  c.quadraticCurveTo(x - ow * 0.4, bot - R(0.002), x + ow * 0.9, bot + R(0.008));
  c.closePath();
  fillStroke(c, C.rockDark, C.ink, R(0.0045));

  c.restore();
}

/**
 * The Tangle Jungle: the canopy the beach path runs into, one bend inland from
 * Driftwood Beach. Layered lobes of leaf, a plunge pool under a thread of
 * waterfall, mossy ruin stones with capy glyphs pecked into them, and two
 * flowers far too big for their own good.
 */
function paintJungle(c, R, X, Y) {
  const x = X(ART.jungle[0]);
  const y = Y(ART.jungle[1]);
  const px = x + R(JUNGLE_POOL[0]);
  const py = y + R(JUNGLE_POOL[1]);
  const fx = x + R(JUNGLE_FALL[0]);
  const fy = y + R(JUNGLE_FALL[1]);
  const LEAF = '#3f8f3d';     // deeper than the island's round trees on purpose
  const LEAF_HI = '#6fc44f';
  const LEAF_TOP = '#9ade6a';

  c.save();

  // ground shadow under the canopy
  c.save();
  c.translate(x, y + R(0.034));
  c.scale(1, 0.34);
  circle(c, 0, 0, R(0.060));
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();
  c.restore();

  // canopy: five lobes plus three crown spikes in ONE path, stroked and then
  // filled so only the outer silhouette keeps its ink line (chained arcs would
  // otherwise draw seams across the middle of the cluster). The spikes are what
  // stop it reading as three more of the island's round trees.
  c.beginPath();
  for (const [dx, dy, r] of [
    [-0.034, -0.006, 0.027], [-0.006, -0.018, 0.029], [0.026, -0.010, 0.028],
    [-0.016, 0.014, 0.025], [0.016, 0.018, 0.023],
  ]) {
    c.arc(x + R(dx), y + R(dy), R(r), 0, Math.PI * 2);
  }
  for (const [dx, dy, w] of [[-0.030, -0.048, 0.011], [-0.004, -0.060, 0.012], [0.024, -0.046, 0.010]]) {
    c.moveTo(x + R(dx - w), y + R(dy) + R(0.016));
    c.lineTo(x + R(dx), y + R(dy));
    c.lineTo(x + R(dx + w), y + R(dy) + R(0.016));
    c.closePath();
  }
  outline(c, C.ink, R(0.018));
  c.fillStyle = LEAF;
  c.fill();
  c.fillStyle = LEAF_HI;
  for (const [dx, dy, r] of [[-0.030, -0.012, 0.018], [0.010, -0.022, 0.018], [0.026, 0.004, 0.014]]) {
    circle(c, x + R(dx), y + R(dy), R(r));
    c.fill();
  }
  c.fillStyle = LEAF_TOP;
  for (const [dx, dy, r] of [[-0.032, -0.018, 0.010], [0.006, -0.028, 0.011]]) {
    circle(c, x + R(dx), y + R(dy), R(r));
    c.fill();
  }

  // a mossy ruin stone leaning at the canopy's edge
  roundBox(c, x + R(0.030), y + R(0.010), R(0.016), R(0.028), R(0.004));
  fillStroke(c, '#ded5b7', C.ink, R(0.006));
  c.fillStyle = '#7ac74f'; // moss on its crown
  c.beginPath();
  c.moveTo(x + R(0.030), y + R(0.014));
  c.quadraticCurveTo(x + R(0.038), y + R(0.006), x + R(0.046), y + R(0.014));
  c.quadraticCurveTo(x + R(0.038), y + R(0.012), x + R(0.030), y + R(0.014));
  c.fill();

  // waterfall: white water dropping out from under the leaves into the pool
  poly(c, [
    [fx - R(0.005), fy],
    [fx + R(0.005), fy],
    [px + R(0.008), py - R(0.002)],
    [px - R(0.008), py - R(0.002)],
  ]);
  fillStroke(c, '#eef8ff', C.ink, R(0.006));
  c.strokeStyle = 'rgba(99,195,232,0.85)';
  c.lineWidth = R(0.0022);
  c.beginPath();
  c.moveTo(fx - R(0.001), fy + R(0.003));
  c.lineTo(px - R(0.002), py - R(0.004));
  c.stroke();

  // the plunge pool
  c.save();
  c.translate(px, py);
  c.scale(1, 0.46);
  circle(c, 0, 0, R(0.026));
  c.restore();
  fillStroke(c, C.water, C.ink, R(0.007));
  c.save();
  c.translate(px, py);
  c.scale(1, 0.46);
  circle(c, R(0.006), -R(0.004), R(0.015));
  c.restore();
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.fill();

  // two oversized jungle flowers on the fringe
  for (const [dx, dy, col] of [[-0.048, 0.010, C.coral], [0.046, -0.016, C.gold]]) {
    const r = R(0.0085);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      circle(c, x + R(dx) + Math.cos(a) * r, y + R(dy) + Math.sin(a) * r, r * 0.8);
      c.fillStyle = col;
      c.fill();
    }
    circle(c, x + R(dx), y + R(dy), r * 0.6);
    c.fillStyle = C.cream;
    c.fill();
  }

  // hanging vines off the canopy's south edge
  c.strokeStyle = '#3f7f39';
  c.lineWidth = R(0.0035);
  for (const [dx, dy, len] of [[-0.026, 0.016, 0.020], [0.010, 0.026, 0.016]]) {
    c.beginPath();
    c.moveTo(x + R(dx), y + R(dy));
    c.quadraticCurveTo(x + R(dx) - R(0.005), y + R(dy) + R(len) * 0.6, x + R(dx) + R(0.003), y + R(dy) + R(len));
    c.stroke();
    circle(c, x + R(dx) + R(0.003), y + R(dy) + R(len), R(0.0035));
    c.fillStyle = LEAF_HI;
    c.fill();
  }

  c.restore();
}

function paintCafe(c, R, X, Y) {
  const x = X(ART.cafe[0]);
  const y = Y(ART.cafe[1]);
  const w = R(0.102);
  const hh = R(0.060);

  c.save();
  circle(c, x, y + hh * 0.66, w * 0.62);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();

  // hut body
  roundBox(c, x - w / 2, y - hh * 0.1, w, hh, R(0.008));
  fillStroke(c, C.cream, C.ink, R(0.009));

  // counter shade
  roundBox(c, x - w / 2 + R(0.006), y + hh * 0.42, w - R(0.012), hh * 0.36, R(0.005));
  c.fillStyle = '#f0dfba';
  c.fill();

  // straw roof
  poly(c, [
    [x - w * 0.66, y - hh * 0.06],
    [x, y - hh * 0.92],
    [x + w * 0.66, y - hh * 0.06],
  ]);
  fillStroke(c, C.gold, C.ink, R(0.009));
  c.strokeStyle = 'rgba(58,44,28,0.35)';
  c.lineWidth = R(0.004);
  for (let i = -1; i <= 1; i++) {
    c.beginPath();
    c.moveTo(x + i * w * 0.2, y - hh * 0.72 + Math.abs(i) * hh * 0.16);
    c.lineTo(x + i * w * 0.42, y - hh * 0.08);
    c.stroke();
  }

  // striped awning
  const aw = w * 0.94;
  for (let i = 0; i < 5; i++) {
    const sx = x - aw / 2 + (aw / 5) * i;
    c.beginPath();
    c.moveTo(sx, y + hh * 0.12);
    c.lineTo(sx + aw / 5, y + hh * 0.12);
    c.lineTo(sx + aw / 5, y + hh * 0.34);
    c.lineTo(sx, y + hh * 0.34);
    c.closePath();
    c.fillStyle = i % 2 ? C.cream : C.coral;
    c.fill();
  }
  roundBox(c, x - aw / 2, y + hh * 0.12, aw, hh * 0.22, R(0.004));
  outline(c, C.ink, R(0.007));

  // smoothie glass on the counter
  const gx = x + w * 0.3;
  const gy = y + hh * 0.62;
  poly(c, [[gx - R(0.009), gy - R(0.016)], [gx + R(0.009), gy - R(0.016)], [gx + R(0.006), gy + R(0.012)], [gx - R(0.006), gy + R(0.012)]]);
  fillStroke(c, '#ffd2dc', C.ink, R(0.005));
  c.beginPath();
  c.moveTo(gx + R(0.004), gy - R(0.014));
  c.lineTo(gx + R(0.014), gy - R(0.030));
  outline(c, C.coral, R(0.005));
  c.restore();
}

/**
 * The Game Den: the annex of the ski lodge, tucked into the peak's snowfield
 * where the mountain foot meets the treeline. Snow-loaded roof, one warm
 * window spilling gold onto the drift, and a coral die up on the ridge where
 * a weather vane would go, so the mountain still reads as "games in here".
 */
function paintLounge(c, R, X, Y) {
  const x = X(ART.lounge[0]);
  const y = Y(ART.lounge[1]);
  const w = R(0.080);
  const hh = R(0.046);
  const wx = x + R(DEN_WINDOW[0]);
  const wy = y + R(DEN_WINDOW[1]);
  const apex = y - hh * 0.98;
  const eave = y - hh * 0.04;

  c.save();

  // the drift it is bedded into, banked up against the mountain foot
  blob(c, x + w * 0.05, y + hh * 0.46, w * 0.88, hh * 0.66, 0.07, 3.1);
  fillStroke(c, C.snow, C.snowShade, R(0.006));

  // squashed ground shadow: this is a slope, not a plinth
  c.save();
  c.translate(x, y + hh * 0.76);
  c.scale(1, 0.44);
  circle(c, 0, 0, w * 0.54);
  c.fillStyle = 'rgba(58,44,28,0.15)';
  c.fill();
  c.restore();

  // lamplight spilling onto the snow (the breathing part is drawn live)
  const spill = c.createRadialGradient(wx, wy, R(0.003), wx, wy, R(0.062));
  spill.addColorStop(0, 'rgba(242,182,74,0.42)');
  spill.addColorStop(1, 'rgba(242,182,74,0)');
  c.fillStyle = spill;
  circle(c, wx, wy, R(0.062));
  c.fill();

  // chimney first: the roof crops it, so only the stack above the slope shows
  roundBox(c, x + R(DEN_CHIMNEY[0]) - w * 0.13, y + R(DEN_CHIMNEY[1]), w * 0.26, hh * 1.3, R(0.004));
  fillStroke(c, C.rock, C.ink, R(0.006));
  roundBox(c, x + R(DEN_CHIMNEY[0]) - w * 0.18, y + R(DEN_CHIMNEY[1]) - R(0.006), w * 0.36, R(0.008), R(0.003));
  fillStroke(c, C.cream, C.ink, R(0.006));

  // timber walls
  roundBox(c, x - w / 2, y - hh * 0.10, w, hh, R(0.006));
  fillStroke(c, C.wood, C.ink, R(0.008));

  // stacked log courses and a shaded footing
  c.save();
  roundBox(c, x - w / 2, y - hh * 0.10, w, hh, R(0.006));
  c.clip();
  c.fillStyle = 'rgba(58,44,28,0.15)';
  c.fillRect(x - w / 2, y + hh * 0.72, w, hh * 0.2);
  c.strokeStyle = C.woodDark;
  c.lineWidth = R(0.003);
  for (let i = 1; i <= 2; i++) {
    const ly = y - hh * 0.10 + (hh / 3) * i;
    c.beginPath();
    c.moveTo(x - w / 2, ly);
    c.lineTo(x + w / 2, ly);
    c.stroke();
  }
  c.restore();

  // door with a gold knob
  roundBox(c, x - w * 0.40, y + hh * 0.12, w * 0.30, hh * 0.78, R(0.004));
  fillStroke(c, C.woodDark, C.ink, R(0.006));
  circle(c, x - w * 0.14, y + hh * 0.52, R(0.0032));
  c.fillStyle = C.gold;
  c.fill();

  // the glowing window
  const ww = w * 0.34;
  const wh = hh * 0.46;
  roundBox(c, wx - ww / 2, wy - wh / 2, ww, wh, R(0.003));
  fillStroke(c, '#ffdb90', C.ink, R(0.006));
  c.strokeStyle = 'rgba(58,44,28,0.55)';
  c.lineWidth = R(0.003);
  c.beginPath();
  c.moveTo(wx, wy - wh / 2);
  c.lineTo(wx, wy + wh / 2);
  c.moveTo(wx - ww / 2, wy);
  c.lineTo(wx + ww / 2, wy);
  c.stroke();

  // snow-loaded roof with a shaded east slope
  poly(c, [[x - w * 0.72, eave], [x, apex], [x + w * 0.72, eave]]);
  fillStroke(c, C.snow, C.ink, R(0.008));
  c.save();
  poly(c, [[x - w * 0.72, eave], [x, apex], [x + w * 0.72, eave]]);
  c.clip();
  c.fillStyle = 'rgba(122,170,208,0.22)'; // stays snow, not mountain
  poly(c, [[x, apex], [x + w * 0.72, eave], [x + w * 0.72, eave + hh], [x, eave + hh]]);
  c.fill();
  c.restore();

  // timber fascia under the eaves, so the roof still reads as a roof
  roundBox(c, x - w * 0.76, eave - R(0.001), w * 1.52, R(0.008), R(0.003));
  fillStroke(c, C.woodDark, C.ink, R(0.005));

  // the house die, up on the ridge on a stubby post
  c.beginPath();
  c.moveTo(x, apex);
  c.lineTo(x, apex - R(0.008));
  outline(c, C.woodDark, R(0.005));
  const ds = R(0.026);
  c.save();
  c.translate(x, apex - R(0.008) - ds * 0.48);
  c.rotate(0.10);
  roundBox(c, -ds / 2, -ds / 2, ds, ds, ds * 0.24);
  fillStroke(c, C.coral, C.ink, R(0.006));
  c.fillStyle = C.cream;
  for (const [px, py] of [[-0.26, -0.26], [0, 0], [0.26, 0.26]]) {
    circle(c, px * ds, py * ds, ds * 0.14);
    c.fill();
  }
  c.restore();

  c.restore();
}

function paintBeach(c, R, X, Y) {
  const x = X(ART.beach[0]);
  const y = Y(ART.beach[1]);

  // dock reaching into the water
  c.save();
  c.translate(x, y);
  c.rotate(0.18);
  roundBox(c, -R(0.135), -R(0.014), R(0.185), R(0.028), R(0.006));
  fillStroke(c, C.wood, C.ink, R(0.008));
  c.strokeStyle = C.woodDark;
  c.lineWidth = R(0.005);
  for (let i = 0; i < 5; i++) {
    const px = -R(0.118) + i * R(0.036);
    c.beginPath();
    c.moveTo(px, -R(0.012));
    c.lineTo(px, R(0.012));
    c.stroke();
  }
  // posts at the far end
  for (const py of [-R(0.021), R(0.021)]) {
    roundBox(c, -R(0.142), py - R(0.006), R(0.016), R(0.014), R(0.004));
    fillStroke(c, C.woodDark, C.ink, R(0.005));
  }
  c.restore();

  // rowboat moored off the dock
  const bx = X(0.108);
  const by = Y(0.628);
  c.save();
  c.translate(bx, by);
  c.rotate(-0.12);
  c.beginPath();
  c.moveTo(-R(0.028), -R(0.010));
  c.quadraticCurveTo(0, R(0.020), R(0.028), -R(0.010));
  c.quadraticCurveTo(0, R(0.001), -R(0.028), -R(0.010));
  fillStroke(c, C.coral, C.ink, R(0.007));
  c.beginPath();
  c.moveTo(-R(0.006), -R(0.008));
  c.lineTo(R(0.026), -R(0.026));
  outline(c, C.woodDark, R(0.005));
  c.restore();

  // parasol on the sand
  const ux = X(0.222);
  const uy = Y(0.632);
  c.beginPath();
  c.moveTo(ux, uy);
  c.lineTo(ux + R(0.006), uy - R(0.042));
  outline(c, C.woodDark, R(0.006));
  c.beginPath();
  c.arc(ux + R(0.006), uy - R(0.040), R(0.030), Math.PI, 0);
  c.closePath();
  fillStroke(c, C.cream, C.ink, R(0.007));
  c.save();
  c.beginPath();
  c.arc(ux + R(0.006), uy - R(0.040), R(0.030), Math.PI, 0);
  c.closePath();
  c.clip();
  c.fillStyle = C.coral;
  for (let i = -3; i <= 3; i += 2) {
    poly(c, [
      [ux + R(0.006), uy - R(0.040)],
      [ux + R(0.006) + i * R(0.011), uy - R(0.076)],
      [ux + R(0.006) + (i + 1) * R(0.011), uy - R(0.076)],
    ]);
    c.fill();
  }
  c.restore();

  // beach ball
  circle(c, X(0.252), Y(0.664), R(0.013));
  fillStroke(c, C.cream, C.ink, R(0.006));
  c.save();
  circle(c, X(0.252), Y(0.664), R(0.013));
  c.clip();
  c.fillStyle = C.gold;
  poly(c, [[X(0.252), Y(0.664)], [X(0.252) + R(0.02), Y(0.664) - R(0.02)], [X(0.252) + R(0.02), Y(0.664) + R(0.004)]]);
  c.fill();
  c.fillStyle = C.coral;
  poly(c, [[X(0.252), Y(0.664)], [X(0.252) - R(0.02), Y(0.664) + R(0.014)], [X(0.252) + R(0.006), Y(0.664) + R(0.02)]]);
  c.fill();
  c.restore();
}

function paintCave(c, R, X, Y) {
  const x = X(ART.club[0]);
  const y = Y(ART.club[1]);

  // glow pool on the ground (static part; the pulse is drawn live)
  const g = c.createRadialGradient(x, y, R(0.01), x, y, R(0.13));
  g.addColorStop(0, 'rgba(155,107,212,0.55)');
  g.addColorStop(1, 'rgba(155,107,212,0)');
  c.fillStyle = g;
  circle(c, x, y, R(0.13));
  c.fill();

  // rock mound
  c.beginPath();
  c.moveTo(x - R(0.086), y + R(0.030));
  c.bezierCurveTo(x - R(0.080), y - R(0.058), x + R(0.080), y - R(0.058), x + R(0.086), y + R(0.030));
  c.closePath();
  fillStroke(c, C.rock, C.ink, R(0.010));

  // shaded right cheek
  c.save();
  c.beginPath();
  c.moveTo(x - R(0.086), y + R(0.030));
  c.bezierCurveTo(x - R(0.080), y - R(0.058), x + R(0.080), y - R(0.058), x + R(0.086), y + R(0.030));
  c.closePath();
  c.clip();
  c.fillStyle = C.rockDark;
  c.globalAlpha = 0.5;
  poly(c, [[x + R(0.028), y - R(0.06)], [x + R(0.10), y - R(0.06)], [x + R(0.10), y + R(0.04)], [x + R(0.046), y + R(0.04)]]);
  c.fill();
  c.restore();

  // mouth
  c.beginPath();
  c.moveTo(x - R(0.036), y + R(0.030));
  c.bezierCurveTo(x - R(0.034), y - R(0.026), x + R(0.034), y - R(0.026), x + R(0.036), y + R(0.030));
  c.closePath();
  fillStroke(c, '#2c2440', C.ink, R(0.008));
  const gm = c.createLinearGradient(x, y + R(0.03), x, y - R(0.02));
  gm.addColorStop(0, 'rgba(199,156,240,0.85)');
  gm.addColorStop(1, 'rgba(155,107,212,0)');
  c.fillStyle = gm;
  c.fill();

  // crystals
  for (const [dx, s] of [[-0.062, 1], [0.066, 0.8], [-0.03, 0.6]]) {
    poly(c, [
      [x + R(dx) - R(0.008 * s), y + R(0.030)],
      [x + R(dx), y + R(0.030) - R(0.034 * s)],
      [x + R(dx) + R(0.008 * s), y + R(0.030)],
    ]);
    fillStroke(c, C.purpleLight, C.ink, R(0.005));
  }
}

function pine(c, x, y, s) {
  circle(c, x, y + s * 0.06, s * 0.36);
  c.fillStyle = 'rgba(58,44,28,0.15)';
  c.fill();
  roundBox(c, x - s * 0.06, y - s * 0.06, s * 0.12, s * 0.22, s * 0.04);
  fillStroke(c, C.woodDark, C.ink, s * 0.06);
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    poly(c, [
      [x - s * (0.34 - t * 0.09), y + s * (0.02 - t * 0.28)],
      [x, y - s * (0.42 + t * 0.28)],
      [x + s * (0.34 - t * 0.09), y + s * (0.02 - t * 0.28)],
    ]);
    fillStroke(c, i === 2 ? '#5aa64a' : '#4a8f3d', C.ink, s * 0.07);
  }
}

function rock(c, x, y, s) {
  c.beginPath();
  c.moveTo(x - s, y + s * 0.34);
  c.bezierCurveTo(x - s * 0.9, y - s * 0.7, x + s * 0.4, y - s * 0.9, x + s, y + s * 0.34);
  c.closePath();
  fillStroke(c, C.rock, C.ink, s * 0.22);
  c.beginPath();
  c.moveTo(x - s * 0.34, y + s * 0.3);
  c.quadraticCurveTo(x - s * 0.1, y - s * 0.34, x + s * 0.42, y - s * 0.1);
  outline(c, 'rgba(255,255,255,0.4)', s * 0.16);
}

/** A little striped lighthouse on the south cape: pure set dressing. */
function lighthouse(c, x, y, s) {
  c.save();
  circle(c, x, y + s * 0.1, s * 0.4);
  c.fillStyle = 'rgba(58,44,28,0.16)';
  c.fill();
  // rocky base
  c.beginPath();
  c.moveTo(x - s * 0.42, y + s * 0.14);
  c.quadraticCurveTo(x, y - s * 0.06, x + s * 0.42, y + s * 0.14);
  c.closePath();
  fillStroke(c, C.rock, C.ink, s * 0.07);
  // tower
  poly(c, [
    [x - s * 0.24, y + s * 0.1],
    [x - s * 0.15, y - s * 0.66],
    [x + s * 0.15, y - s * 0.66],
    [x + s * 0.24, y + s * 0.1],
  ]);
  fillStroke(c, C.cream, C.ink, s * 0.075);
  // stripes
  c.save();
  poly(c, [
    [x - s * 0.24, y + s * 0.1],
    [x - s * 0.15, y - s * 0.66],
    [x + s * 0.15, y - s * 0.66],
    [x + s * 0.24, y + s * 0.1],
  ]);
  c.clip();
  c.fillStyle = C.coral;
  for (let i = 0; i < 2; i++) {
    const ty = y - s * (0.12 + i * 0.36);
    c.fillRect(x - s * 0.3, ty, s * 0.6, s * 0.16);
  }
  c.restore();
  // lamp room + light
  roundBox(c, x - s * 0.19, y - s * 0.86, s * 0.38, s * 0.22, s * 0.05);
  fillStroke(c, C.gold, C.ink, s * 0.07);
  poly(c, [[x - s * 0.26, y - s * 0.86], [x, y - s * 1.06], [x + s * 0.26, y - s * 0.86]]);
  fillStroke(c, C.coral, C.ink, s * 0.07);
  c.restore();
}

function tree(c, x, y, s) {
  circle(c, x, y + s * 0.5, s * 0.62);
  c.fillStyle = 'rgba(58,44,28,0.15)';
  c.fill();
  roundBox(c, x - s * 0.11, y, s * 0.22, s * 0.55, s * 0.07);
  fillStroke(c, C.wood, C.ink, s * 0.1);
  c.beginPath();
  c.arc(x - s * 0.42, y - s * 0.22, s * 0.46, 0, Math.PI * 2);
  c.arc(x + s * 0.40, y - s * 0.18, s * 0.42, 0, Math.PI * 2);
  c.arc(x, y - s * 0.60, s * 0.54, 0, Math.PI * 2);
  fillStroke(c, C.grassDark, C.ink, s * 0.12);
  c.beginPath();
  c.arc(x - s * 0.18, y - s * 0.58, s * 0.34, 0, Math.PI * 2);
  c.fillStyle = '#8fd25c';
  c.fill();
}

function paintCompass(c, R, x, y) {
  const r = R(0.072);
  circle(c, x, y, r);
  c.fillStyle = 'rgba(255,246,227,0.86)';
  c.fill();
  outline(c, C.ink, R(0.008));
  circle(c, x, y, r * 0.78);
  outline(c, 'rgba(58,44,28,0.35)', R(0.004));

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
    const b = a + Math.PI / 4;
    poly(c, [
      [x + Math.cos(a) * r * 0.86, y + Math.sin(a) * r * 0.86],
      [x + Math.cos(b) * r * 0.2, y + Math.sin(b) * r * 0.2],
      [x + Math.cos(a + Math.PI / 2) * r * 0.86, y + Math.sin(a + Math.PI / 2) * r * 0.86],
      [x + Math.cos(b + Math.PI / 2) * r * 0.2, y + Math.sin(b + Math.PI / 2) * r * 0.2],
    ]);
    fillStroke(c, i === 0 ? C.coral : C.cream, C.ink, R(0.005));
  }
  circle(c, x, y, r * 0.13);
  fillStroke(c, C.gold, C.ink, R(0.005));

  c.fillStyle = C.ink;
  c.font = `900 ${Math.round(r * 0.5)}px "Trebuchet MS", "Segoe UI", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('N', x, y - r * 1.28);
}

// ---- the animated layer ---------------------------------------------------

function paintLive(c, w, h, t) {
  const S = Math.min(w, h);
  const R = (v) => v * S;
  const X = (u) => u * w;
  const Y = (v) => v * h;
  c.lineJoin = 'round';
  c.lineCap = 'round';

  // expanding wave ring
  const k = (t % 6) / 6;
  c.save();
  c.globalAlpha = 0.34 * (1 - k);
  shapePath(c, w, h, ISLE, 1.05 + k * 0.28);
  outline(c, '#ffffff', R(0.007));
  c.restore();

  // sea twinkles
  c.save();
  c.fillStyle = '#ffffff';
  for (let i = 0; i < SEA_SPARKS.length; i++) {
    const [u, v] = SEA_SPARKS[i];
    const p = Math.sin(t * 1.7 + i * 1.9);
    if (p <= 0) continue;
    const r = R(0.006) * p;
    c.globalAlpha = 0.75 * p;
    poly(c, [
      [X(u), Y(v) - r * 2.6], [X(u) + r, Y(v)], [X(u), Y(v) + r * 2.6], [X(u) - r, Y(v)],
    ]);
    c.fill();
  }
  c.restore();

  // drifting clouds, kept in the open-water lanes so they never hide a landmark
  for (const [bu, v, s, sp, lo, hi] of [
    [0.20, 0.050, 1.0, 0.006, -0.16, 1.16],
    [0.70, 0.945, 0.85, 0.0045, -0.16, 1.16],
    [0.02, 0.480, 0.7, 0.0032, -0.17, 0.10],
  ]) {
    const span = hi - lo;
    const u = lo + ((bu - lo + t * sp) % span + span) % span;
    cloud(c, X(u), Y(v), R(0.075) * s);
  }

  // sailboat
  const sx = X(0.118) + Math.sin(t * 0.31) * R(0.02);
  const sy = Y(0.858) + Math.sin(t * 1.5) * R(0.006);
  sailboat(c, sx, sy, R(0.062), Math.sin(t * 1.5) * 0.07);

  // gulls
  for (let i = 0; i < 3; i++) {
    const gx = X(0.24 + i * 0.055) + Math.sin(t * 0.5 + i) * R(0.05);
    const gy = Y(0.13 + (i % 2) * 0.035) + Math.sin(t * 1.1 + i * 2) * R(0.012);
    gull(c, gx, gy, R(0.018), t * 6 + i * 2);
  }

  // fountain sparkle
  const fx = X(ART.plaza[0]);
  const fy = Y(ART.plaza[1]);
  c.save();
  c.fillStyle = '#ffffff';
  for (let i = 0; i < 4; i++) {
    const p = (t * 0.9 + i * 0.25) % 1;
    const a = -Math.PI / 2 + (i - 1.5) * 0.5;
    const rr = R(0.03) * p;
    c.globalAlpha = 0.85 * (1 - p);
    circle(c, fx + Math.cos(a) * rr, fy - R(0.014) + Math.sin(a) * rr + R(0.05) * p * p, R(0.0055));
    c.fill();
  }
  c.restore();

  // game den, up at the peak: the window breathes and the chimney puffs
  const dx = X(ART.lounge[0]);
  const dy = Y(ART.lounge[1]);
  const warm = 0.5 + 0.5 * Math.sin(t * 1.6 + 1.1);
  c.save();
  const wg = c.createRadialGradient(
    dx + R(DEN_WINDOW[0]), dy + R(DEN_WINDOW[1]), R(0.003),
    dx + R(DEN_WINDOW[0]), dy + R(DEN_WINDOW[1]), R(0.044 + 0.012 * warm),
  );
  wg.addColorStop(0, `rgba(255,214,130,${0.28 + 0.22 * warm})`);
  wg.addColorStop(1, 'rgba(242,182,74,0)');
  c.fillStyle = wg;
  circle(c, dx + R(DEN_WINDOW[0]), dy + R(DEN_WINDOW[1]), R(0.058));
  c.fill();
  c.fillStyle = '#fff6e3';
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.32 + i / 3) % 1;
    c.globalAlpha = 0.7 * (1 - p * p);
    circle(c, dx + R(DEN_CHIMNEY[0]) + Math.sin(t * 1.1 + i * 2.1) * R(0.009),
      dy + R(DEN_CHIMNEY[1]) - R(0.012) - R(0.072) * p, R(0.006 + 0.008 * p));
    c.fill();
  }
  c.restore();

  // the mine: the lantern gutters, warm motes drift up out of the shaft
  const mx = X(ART.mine[0]);
  const my = Y(ART.mine[1]);
  const lamp = 0.62 + 0.38 * Math.sin(t * 2.7) * Math.sin(t * 1.13 + 0.7);
  c.save();
  const lg = c.createRadialGradient(
    mx + R(MINE_LAMP[0]), my + R(MINE_LAMP[1]), R(0.002),
    mx + R(MINE_LAMP[0]), my + R(MINE_LAMP[1]), R(0.030 + 0.010 * lamp),
  );
  lg.addColorStop(0, `rgba(255,214,130,${0.30 + 0.24 * lamp})`);
  lg.addColorStop(1, 'rgba(242,182,74,0)');
  c.fillStyle = lg;
  circle(c, mx + R(MINE_LAMP[0]), my + R(MINE_LAMP[1]), R(0.044));
  c.fill();
  c.fillStyle = C.gold;
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.42 + i / 3) % 1;
    c.globalAlpha = 0.75 * (1 - p);
    circle(c, mx + Math.sin(t * 1.4 + i * 2.3) * R(0.009),
      my + R(0.017) - R(0.058) * p, R(0.004) * (1 - p * 0.4));
    c.fill();
  }
  c.restore();

  // the jungle: water tumbling into the pool, ripples, two butterflies
  const jx = X(ART.jungle[0]);
  const jy = Y(ART.jungle[1]);
  const jpx = jx + R(JUNGLE_POOL[0]) + R(0.004);
  const jpy = jy + R(JUNGLE_POOL[1]);
  c.save();
  c.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.9 + i / 3) % 1;
    c.globalAlpha = 0.85 * (1 - p * 0.7);
    circle(c, jx + R(JUNGLE_FALL[0]) + Math.sin(p * 5 + i) * R(0.002),
      jy + R(JUNGLE_FALL[1]) + R(0.026) * p, R(0.0035));
    c.fill();
  }
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.5 + i * 0.5) % 1;
    c.globalAlpha = 0.5 * (1 - p);
    c.save();
    c.translate(jpx, jpy);
    c.scale(1, 0.44);
    circle(c, 0, 0, R(0.004) + R(0.013) * p);
    c.restore();
    outline(c, '#ffffff', R(0.0025));
  }
  for (let i = 0; i < 2; i++) {
    const a = t * (0.7 + i * 0.25) + i * 2.4;
    const bx = jx + R(0.014 + i * 0.010) + Math.cos(a) * R(0.032);
    const by = jy - R(0.046 + i * 0.012) + Math.sin(a * 1.6) * R(0.010);
    const flap = 0.3 + 0.7 * Math.abs(Math.sin(t * 9 + i * 2));
    c.globalAlpha = 0.95;
    c.fillStyle = i ? C.gold : C.coral;
    for (const s of [-1, 1]) {
      circle(c, bx + s * R(0.004) * flap, by - R(0.001) * flap, R(0.0032));
      c.fill();
    }
  }
  c.restore();

  // cave pulse + rising sparks
  const cx = X(ART.club[0]);
  const cy = Y(ART.club[1]);
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  c.save();
  const g = c.createRadialGradient(cx, cy, R(0.005), cx, cy, R(0.075 + 0.03 * pulse));
  g.addColorStop(0, `rgba(199,156,240,${0.45 + 0.3 * pulse})`);
  g.addColorStop(1, 'rgba(155,107,212,0)');
  c.fillStyle = g;
  circle(c, cx, cy, R(0.105));
  c.fill();
  for (let i = 0; i < 4; i++) {
    const p = (t * 0.55 + i * 0.25) % 1;
    c.globalAlpha = 0.9 * (1 - p);
    c.fillStyle = i % 2 ? C.purpleLight : C.cream;
    circle(c, cx + Math.sin(t * 2 + i * 2.1) * R(0.022), cy - R(0.02) - R(0.075) * p, R(0.006) * (1 - p * 0.4));
    c.fill();
  }
  c.restore();

  // --- the social cove ----------------------------------------------------
  // Order matters. The buoy and the cold logs are objects, so they take the
  // hour's light with the rest of the island; the flames and the bell's lamp
  // are drawn ON TOP of the wash so they read as the things making light after
  // dark. The party beacon below is painted after all of it, at full strength:
  // it is a "look here", not a thing the sun sets on. dayT is -1 until the
  // first clock frame and all five calls are then no-ops.
  const dayT = mapDayT();
  driftBell(c, R, X, Y, t);
  bonfirePile(c, R, X, Y, dayT);
  paintSkyTint(c, w, h, dayT);
  bonfireGlow(c, R, X, Y, t, dayT);
  driftGlint(c, R, X, Y, t, dayT);

  // a party is on somewhere: the venue gets a beacon nobody can miss (wave 7).
  // Dens are not painted on this island, so those parties live in the banner
  // under the map instead.
  const venue = partyLive() ? ART[party.room] : null;
  if (venue) {
    const px = X(venue[0]);
    // lifted off the landmark centre: the label pill sits right on top of some
    // of these, and a beacon nobody can see is not a beacon
    const py = Y(venue[1]) - R(0.03);
    c.save();
    for (let i = 0; i < 2; i++) {
      const p = (t * 0.85 + i * 0.5) % 1;
      c.globalAlpha = 0.6 * (1 - p);
      circle(c, px, py, R(0.018) + R(0.078) * p);
      outline(c, '#ffd0da', R(0.008) * (1 - p * 0.5));
    }
    const beat = 0.5 + 0.5 * Math.sin(t * 5.2);
    c.globalAlpha = 1;
    const pg = c.createRadialGradient(px, py, R(0.004), px, py, R(0.05 + 0.014 * beat));
    pg.addColorStop(0, 'rgba(255,214,225,0.95)');
    pg.addColorStop(1, 'rgba(232,101,122,0)');
    c.fillStyle = pg;
    circle(c, px, py, R(0.072));
    c.fill();
    circle(c, px, py, R(0.013 + 0.004 * beat));
    fillStroke(c, C.coral, C.cream, R(0.005));
    for (let i = 0; i < 5; i++) {
      const p = (t * 0.7 + i * 0.2) % 1;
      c.globalAlpha = 0.9 * (1 - p);
      c.fillStyle = [C.gold, C.cream, C.purpleLight, C.coral, C.water][i];
      const a = i * 1.3 + t * 0.6;
      circle(c, px + Math.cos(a) * R(0.055) * p, py - R(0.012) - R(0.085) * p, R(0.0048));
      c.fill();
    }
    c.restore();
  }
}

function cloud(c, x, y, s) {
  c.save();
  c.globalAlpha = 0.88;
  c.beginPath();
  c.arc(x - s * 0.5, y + s * 0.1, s * 0.42, 0, Math.PI * 2);
  c.arc(x, y - s * 0.12, s * 0.56, 0, Math.PI * 2);
  c.arc(x + s * 0.55, y + s * 0.08, s * 0.40, 0, Math.PI * 2);
  c.arc(x + s * 0.12, y + s * 0.22, s * 0.40, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.fill();
  outline(c, 'rgba(58,44,28,0.14)', s * 0.09);
  c.restore();
}

function sailboat(c, x, y, s, tilt) {
  c.save();
  c.translate(x, y);
  c.rotate(tilt);
  // wake
  c.strokeStyle = 'rgba(255,255,255,0.6)';
  c.lineWidth = s * 0.09;
  c.beginPath();
  c.moveTo(-s * 0.9, s * 0.42);
  c.lineTo(-s * 0.2, s * 0.42);
  c.moveTo(-s * 0.62, s * 0.62);
  c.lineTo(-s * 0.05, s * 0.62);
  c.stroke();
  // sails
  poly(c, [[0, -s * 1.1], [0, s * 0.06], [-s * 0.62, s * 0.06]]);
  fillStroke(c, C.cream, C.ink, s * 0.1);
  poly(c, [[s * 0.06, -s * 1.05], [s * 0.06, s * 0.06], [s * 0.52, s * 0.06]]);
  fillStroke(c, C.coral, C.ink, s * 0.1);
  // hull
  c.beginPath();
  c.moveTo(-s * 0.72, s * 0.08);
  c.quadraticCurveTo(0, s * 0.56, s * 0.72, s * 0.08);
  c.closePath();
  fillStroke(c, C.wood, C.ink, s * 0.11);
  c.restore();
}

function gull(c, x, y, s, phase) {
  const flap = Math.sin(phase) * 0.35;
  c.save();
  c.strokeStyle = 'rgba(255,255,255,0.95)';
  c.lineWidth = s * 0.22;
  c.beginPath();
  c.moveTo(x - s, y + s * flap);
  c.quadraticCurveTo(x - s * 0.4, y - s * 0.5, x, y);
  c.quadraticCurveTo(x + s * 0.4, y - s * 0.5, x + s, y + s * flap);
  c.stroke();
  c.restore();
}

// ---- the social cove: clock light, the bonfire, the dive-bell buoy --------
// docs/LIVING-COVE.md gives the world the clock (A), the beach its bonfire
// (A2) and the cove The Drift (C); how those read on the island map is this
// file's business, and this is that reading.

/** One flat wash over the whole card: the island takes the hour's light. */
function paintSkyTint(c, w, h, dayT) {
  if (dayT < 0) return;
  const f = dayT * 4;
  const i = Math.floor(f) % 4;
  const a = MAP_TINT[i];
  const b = MAP_TINT[(i + 1) % 4];
  const u = f - Math.floor(f);
  const k = u * u * (3 - 2 * u); // smoothstep: no seam at the stops
  const al = a[3] + (b[3] - a[3]) * k;
  if (al > 0.004) {
    c.fillStyle = `rgba(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)},${al.toFixed(3)})`;
    c.fillRect(0, 0, w, h);
  }
  // rain greys the card off a little: weather is per outdoor room family, and
  // the map shows the island's, which beach/plaza/jungle share.
  if (MAP_CLOCK.weather === 'rain') {
    c.fillStyle = 'rgba(122,144,166,0.15)';
    c.fillRect(0, 0, w, h);
  }
}

/**
 * Cold logs and a ring of stones on the sand: there whether it burns or not.
 * This lives in the live layer rather than paintBase because the pile changes
 * with the clock and the base canvas is only repainted on resize.
 */
function bonfirePile(c, R, X, Y, dayT) {
  const x = X(ART.beach[0]) + R(BEACH_FIRE[0]);
  const y = Y(ART.beach[1]) + R(BEACH_FIRE[1]);
  const k = nightK(dayT);
  c.save();
  // scorched sand
  c.save();
  c.translate(x, y);
  c.scale(1, 0.5);
  circle(c, 0, 0, R(0.026));
  c.restore();
  c.globalAlpha = 0.55;
  c.fillStyle = C.sandDark;
  c.fill();
  c.globalAlpha = 1;
  // the stone ring
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + 0.3;
    circle(c, x + Math.cos(ang) * R(0.022), y + Math.sin(ang) * R(0.011), R(0.0048));
    fillStroke(c, C.cobbleStone, C.ink, R(0.0022));
  }
  // three logs leaning together (charred once it is alight)
  for (const [ang, dx] of [[-0.55, -0.004], [0.42, 0.003], [1.5, 0.001]]) {
    c.save();
    c.translate(x + R(dx), y - R(0.002));
    c.rotate(ang);
    roundBox(c, -R(0.016), -R(0.0035), R(0.032), R(0.007), R(0.003));
    fillStroke(c, k > 0.02 ? C.woodDark : C.wood, C.ink, R(0.0026));
    c.restore();
  }
  c.restore();
}

/** Flames, a warm pool on the sand and embers, from dusk to dawn. */
function bonfireGlow(c, R, X, Y, t, dayT) {
  const k = nightK(dayT);
  if (k <= 0.02) return;
  const x = X(ART.beach[0]) + R(BEACH_FIRE[0]);
  const y = Y(ART.beach[1]) + R(BEACH_FIRE[1]);
  const fl = 0.72 + 0.28 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2);
  const s = 0.5 + 0.5 * k;
  c.save();
  const g = c.createRadialGradient(x, y, R(0.004), x, y, R(0.046 + 0.012 * fl) * s);
  g.addColorStop(0, `rgba(255,196,116,${(0.46 + 0.20 * fl) * k})`);
  g.addColorStop(1, 'rgba(232,101,122,0)');
  c.fillStyle = g;
  circle(c, x, y, R(0.058) * s);
  c.fill();
  const hh = R(0.030) * s * (0.82 + 0.18 * fl);
  for (const [dx, ww, col, ph] of [[-0.0035, 0.010, C.gold, 0], [0.0035, 0.008, '#ffd98a', 1.7]]) {
    const sway = Math.sin(t * 5.5 + ph) * R(0.004);
    c.beginPath();
    c.moveTo(x + R(dx) - R(ww), y - R(0.002));
    c.quadraticCurveTo(x + R(dx) - R(ww) * 0.4, y - hh * 0.6, x + R(dx) + sway, y - hh);
    c.quadraticCurveTo(x + R(dx) + R(ww) * 0.4, y - hh * 0.6, x + R(dx) + R(ww), y - R(0.002));
    c.closePath();
    c.fillStyle = col;
    c.globalAlpha = 0.92 * k;
    c.fill();
  }
  c.fillStyle = C.gold;
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.5 + i / 3) % 1;
    c.globalAlpha = 0.8 * k * (1 - p);
    circle(c, x + Math.sin(t * 1.6 + i * 2.1) * R(0.010), y - R(0.012) - R(0.062) * p, R(0.0038) * (1 - p * 0.4));
    c.fill();
  }
  c.restore();
}

/**
 * The Drift's marker: a brass dive bell in a coral float, riding the swell off
 * the end of the dock, with bubbles coming up from whatever is down there.
 * Drawn live (not in paintBase) so it can bob.
 */
function driftBell(c, R, X, Y, t) {
  const x = X(DRIFT_BUOY[0]);
  const y = Y(DRIFT_BUOY[1]) + Math.sin(t * 1.1) * R(0.005);
  c.save();
  // bubbles
  c.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.42 + i / 3) % 1;
    c.globalAlpha = 0.65 * (1 - p);
    circle(c, x - R(0.016) + Math.sin(p * 6 + i * 2) * R(0.004), y + R(0.030) - R(0.042) * p, R(0.0035) * (0.5 + p));
    c.fill();
  }
  c.globalAlpha = 1;
  // the swell it sits in
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.55 + i * 0.5) % 1;
    c.globalAlpha = 0.55 * (1 - p);
    c.save();
    c.translate(x, y + R(0.012));
    c.scale(1, 0.4);
    circle(c, 0, 0, R(0.012) + R(0.030) * p);
    c.restore();
    outline(c, '#ffffff', R(0.003));
  }
  c.globalAlpha = 1;
  c.translate(x, y + R(0.012));
  c.rotate(Math.sin(t * 0.9) * 0.08);
  // float: a coral drum with a cream waterline band
  roundBox(c, -R(0.017), -R(0.020), R(0.034), R(0.024), R(0.008));
  fillStroke(c, C.coral, C.ink, R(0.006));
  c.save();
  roundBox(c, -R(0.017), -R(0.020), R(0.034), R(0.024), R(0.008));
  c.clip();
  c.fillStyle = C.cream;
  c.fillRect(-R(0.02), -R(0.010), R(0.04), R(0.008));
  c.restore();
  // the bell itself, brass, sitting in the float's collar
  c.beginPath();
  c.moveTo(-R(0.013), -R(0.020));
  c.quadraticCurveTo(-R(0.013), -R(0.045), 0, -R(0.045));
  c.quadraticCurveTo(R(0.013), -R(0.045), R(0.013), -R(0.020));
  c.closePath();
  fillStroke(c, C.gold, C.ink, R(0.0055));
  circle(c, 0, -R(0.032), R(0.005));      // porthole
  fillStroke(c, '#a8e0f2', C.ink, R(0.0035));
  circle(c, 0, -R(0.050), R(0.006));      // lifting eye
  outline(c, C.ink, R(0.0045));
  c.restore();
}

/**
 * The brass catches the light: a slow flash by day, a lamp after dark. Drawn
 * after the sky wash so it reads as a thing MAKING light. The bob term has to
 * match driftBell's.
 */
function driftGlint(c, R, X, Y, t, dayT) {
  const x = X(DRIFT_BUOY[0]);
  const y = Y(DRIFT_BUOY[1]) + Math.sin(t * 1.1) * R(0.005) - R(0.038);
  const k = nightK(dayT);
  const s = Math.max(0, Math.sin(t * 1.6));
  const flash = s * s * s * s;
  c.save();
  const g = c.createRadialGradient(x, y, R(0.002), x, y, R(0.020 + 0.018 * flash));
  g.addColorStop(0, `rgba(255,226,150,${(0.22 + 0.42 * k) * (0.35 + 0.65 * flash)})`);
  g.addColorStop(1, 'rgba(242,182,74,0)');
  c.fillStyle = g;
  circle(c, x, y, R(0.040));
  c.fill();
  const r = R(0.005) * (0.55 + 0.75 * flash);
  c.globalAlpha = 0.55 + 0.45 * flash;
  c.fillStyle = '#ffffff';
  poly(c, [[x, y - r * 2.6], [x + r, y], [x, y + r * 2.6], [x - r, y]]);
  c.fill();
  c.restore();
}

// ---- canvas driver --------------------------------------------------------

function createIslandPainter(canvas) {
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return { refresh() {}, start() {}, stop() {} };

  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let t0 = 0;
  let last = 0;
  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function measure() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const nw = Math.round(r.width);
    const nh = Math.round(r.height);
    const nd = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (nw === w && nh === h && nd === dpr) return true;
    w = nw; h = nh; dpr = nd;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    base.width = canvas.width;
    base.height = canvas.height;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBase(bctx, w, h);
    return true;
  }

  function blit(t) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.restore();
    paintLive(ctx, w, h, t);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!t0) t0 = now;
    if (now - last < 30) return; // ~32fps is plenty for a paper map
    last = now;
    blit((now - t0) / 1000);
  }

  return {
    refresh() {
      if (!measure()) return;
      blit(t0 ? (performance.now() - t0) / 1000 : 0);
    },
    start() {
      if (raf || reduced || !w) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

// Stylized island map. (Owned by the UI polish pass; keep the button wiring.)
function buildMap(game, el) {
  el.innerHTML = `
    <div class="map-card">
      <h2>${GAME_NAME}</h2>
      <div class="map-island" id="map-island">
        <canvas class="map-canvas" id="map-canvas"></canvas>
        <div class="map-here hidden" id="map-here"><i></i><i></i><b></b></div>
        <div class="map-lobby" id="map-lobby" hidden>
          <i class="pips" id="map-lobby-pips"></i>
          <div class="map-lobby-txt"></div>
          <button class="cove-go" id="map-lobby-go" type="button">Go</button>
        </div>
      </div>
      <div class="map-hint" id="map-hint">${MAP_HINT}</div>
      <div class="map-party" id="map-party" hidden>
        <div class="map-party-txt"></div>
        <button class="map-party-go" type="button">Head over</button>
      </div>
      <button class="hud-btn map-close" id="map-close">&#10005;</button>
    </div>`;
  const island = el.querySelector('#map-island');
  const here = el.querySelector('#map-here');
  const hint = el.querySelector('#map-hint');
  const partyRow = el.querySelector('#map-party');
  const partyTxt = partyRow.querySelector('.map-party-txt');
  const partyGo = partyRow.querySelector('.map-party-go');
  const painter = createIslandPainter(el.querySelector('#map-canvas'));
  const buttons = [];
  const lobbyRow = el.querySelector('#map-lobby');
  const lobbyPips = el.querySelector('#map-lobby-pips');
  const lobbyTxt = lobbyRow.querySelector('.map-lobby-txt');
  const lobbyGo = el.querySelector('#map-lobby-go');
  // a pointer resting on a pill owns the hint line: a 'pop' repaint must not
  // yank the room's description out from under it
  let hoverPill = false;

  // the default line doubles as the island's own pulse: how many capys are out
  // there at all. It REPLACES the "press M" tail rather than adding to it, so
  // the hint stays one line on a phone-width card.
  const idleHint = () => (POP.total > 0
    ? `${POP.total} cap${POP.total === 1 ? 'y' : 'ys'} out and about. Pick a spot to waddle over.`
    : MAP_HINT);
  const setHint = (msg) => { hint.textContent = msg || idleHint(); };

  /** "Frosty Peak : Snow, sleds and cocoa" plus who is up there right now. */
  function spotHint(id) {
    const bits = [`${ROOM_INFO[id].name} : ${ROOM_INFO[id].desc || ''}`];
    const n = roomPop(id);
    if (n > 0) bits.push(`${n} cap${n === 1 ? 'y' : 'ys'} here`);
    const friends = FRIEND_AT.get(id);
    if (friends && friends.length) {
      bits.push(friends.length === 1 ? `${friends[0]} is here` : `${friends.slice(0, 3).join(', ')} are here`);
    }
    return bits.join(' : ');
  }

  for (const { id, bx, by, dir } of MAP_SPOTS) {
    const b = document.createElement('button');
    b.className = `map-spot nub-${dir || 'up'}`;
    b.dataset.room = id;
    b.style.left = `${bx}%`;
    b.style.top = `${by}%`;
    const label = document.createElement('span');
    label.textContent = ROOM_INFO[id].name;
    const pop = document.createElement('i'); // head count, empty when nobody is in
    pop.className = 'map-pop';
    const friend = document.createElement('i'); // friend pin, shown by .has-friend
    friend.className = 'map-friend';
    b.append(label, pop, friend);
    b.title = ROOM_INFO[id].desc || '';
    b.onclick = () => {
      el.classList.add('hidden');
      if (game.roomId !== id) { game.audio?.play?.('whoosh'); game.goToRoom(id); }
      else game.audio?.play?.('click');
    };
    b.addEventListener('pointerenter', () => { hoverPill = true; setHint(spotHint(id)); });
    b.addEventListener('pointerleave', () => { hoverPill = false; setHint(null); });
    const hat = document.createElement('i'); // party hat, shown only by .is-party
    hat.className = 'map-hat';
    b.appendChild(hat);
    island.appendChild(b);
    buttons.push(b);
  }

  /** Pill hat + banner for the live party (wave 7). */
  function refreshParty() {
    const live = partyLive();
    for (const b of buttons) {
      b.classList.toggle('is-party', live && b.dataset.room === party.room);
    }
    partyRow.hidden = !live;
    if (!live) return;
    const onMap = Object.prototype.hasOwnProperty.call(ROOM_INFO, party.room);
    partyTxt.textContent = '';
    const line = document.createElement('span');
    line.textContent = `${party.host} is throwing a party at ${party.label}`;
    const sub = document.createElement('small');
    const mins = Math.max(1, Math.round((party.endsAt - Date.now()) / 60000));
    sub.textContent = party.count
      ? `${party.count} already there : about ${mins} min left`
      : `About ${mins} min left. Turning up is the whole gift.`;
    partyTxt.append(line, sub);
    partyGo.textContent = onMap ? 'Head over' : 'Knock on the door';
    partyGo.onclick = () => {
      el.classList.add('hidden');
      game.audio?.play?.('whoosh');
      if (onMap) { if (game.roomId !== party.room) game.goToRoom(party.room); }
      else visitHouse(game, party.host);
    };
  }
  for (const ev of ['party', 'party-start', 'party-end']) game.events.on(ev, refreshParty);

  // ---- co-presence on the map (wave 12) ------------------------------------

  /** Head counts and friend pins on every pill, and the island's own total. */
  function refreshPop() {
    for (const b of buttons) {
      const id = b.dataset.room;
      const n = roomPop(id);
      fillHeads(b.querySelector('.map-pop'), n);
      const friends = FRIEND_AT.get(id);
      const hasFriend = !!(friends && friends.length);
      b.classList.toggle('has-friend', hasFriend);
      const desc = ROOM_INFO[id].desc || '';
      const who = n > 0 ? ` (${n} here${hasFriend ? `, including ${friends.slice(0, 3).join(', ')}` : ''})` : '';
      b.title = `${desc}${who}`;
    }
    if (!hoverPill) setHint(null); // the island total lives in the idle hint
  }

  /**
   * The nearest-to-starting lobby, moored under the island with a Go button.
   * Any joinable lobby shows here (the map is a place you came to on purpose);
   * only a near-full one is allowed to travel out to the world chip.
   */
  function refreshLobbyStrip() {
    const l = LOBBIES[0] || null;
    lobbyRow.hidden = !l;
    if (!l) return;
    const here = game.roomId === l.room;
    fillPips(lobbyPips, l.n, l.need);
    lobbyTxt.textContent = '';
    const head = document.createElement('span');
    head.textContent = `${l.n}/${l.need} at ${gateLabel(l.game)}`;
    const sub = document.createElement('small');
    sub.textContent = here
      ? `You are in ${roomLabel(l.room)} : ${seatsLine(l)}`
      : `${roomLabel(l.room)} : ${seatsLine(l)}`;
    lobbyTxt.append(head, sub);
    lobbyGo.textContent = here ? 'Right here' : 'Go';
    lobbyGo.onclick = () => {
      el.classList.add('hidden');
      game.audio?.play?.(here ? 'click' : 'whoosh');
      if (!here) game.goToRoom(l.room);
    };
  }

  // These land whether the map is open or not: repainting ten pills costs
  // nothing, and an open map then never shows a stale count.
  game.events.on('pop', () => { refreshPop(); refreshLobbyStrip(); });
  game.events.on('fpresence', () => { refreshPop(); });

  function refreshHere() {
    const spot = ART[game.roomId];
    for (const b of buttons) b.classList.toggle('is-here', b.dataset.room === game.roomId);
    if (!spot) { here.classList.add('hidden'); return; }
    here.style.left = `${spot[0] * 100}%`;
    here.style.top = `${spot[1] * 100}%`;
    here.classList.remove('hidden');
  }

  // the map is toggled from the HUD button AND the M key (main.js), so watch
  // the class instead of hooking every caller
  let open = false;
  function sync() {
    const now = !el.classList.contains('hidden');
    if (now === open) return;
    open = now;
    if (open) {
      hoverPill = false;
      setHint(null);
      refreshHere();
      refreshParty();
      refreshPop();
      refreshLobbyStrip();
      painter.refresh();
      painter.start();
    } else {
      painter.stop();
    }
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (open) painter.refresh(); }).observe(island);
  }
  game.events.on('room', () => { refreshHere(); refreshPop(); refreshLobbyStrip(); });
  // The clock lands every 10s; the painters advance dayT themselves in
  // between. Repaint on arrival so a reduced-motion map (which never runs the
  // rAF loop) still keeps up with the light.
  game.events.on('clock', (m) => {
    const span = Number(m && m.dayMs);
    if (Number.isFinite(span) && span > 1000) COVE_DAY_MS = span;
    const d = Number(m && m.dayT);
    if (!Number.isFinite(d)) return;
    MAP_CLOCK.dayT = d - Math.floor(d);
    MAP_CLOCK.at = performance.now();
    MAP_CLOCK.weather = (m && m.weather) || 'clear';
    MAP_CLOCK.aurora = !!(m && m.aurora);
    if (open) painter.refresh();
  });

  el.querySelector('#map-close').onclick = () => el.classList.add('hidden');
  el.addEventListener('click', (e) => { if (e.target === el) el.classList.add('hidden'); });
}
