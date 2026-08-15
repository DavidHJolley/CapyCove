import { Vector3 } from 'three';

/**
 * First-run guided tour: five cozy tooltip cards that teach the cove by doing.
 *
 * Rules this file lives by:
 *  - Nothing advances on a timer alone. Each beat waits for the player to
 *    actually walk, travel, open the map, wander up to a game, or dress up.
 *    (Two beats have an 8s mercy release so a player who ignores them is never
 *    stuck; the first three have none.)
 *  - The cards NEVER take input. `.tour-card` is pointer-events:none, and only
 *    the little "skip tour" button opts back in, so every click still reaches
 *    the world underneath.
 *  - It hides itself whenever a minigame or a menu owns the screen, and its
 *    timers freeze while it is away.
 *  - It survives room changes: anchors are recomputed from the LIVE room every
 *    frame, so beat 2 hands over to beat 3 in whatever room you walked into.
 *
 * The flag is `capycove-toured` in localStorage, set on the send-off AND on
 * skip. The HUD's "?" button clears it and replays from beat 1.
 */

const FLAG = 'capycove-toured';
const STYLE_ID = 'capy-tour-styles';

// --- style ------------------------------------------------------------------
// Cream card, 999px pills, --spring easing, coral title, gold aim arrow: the
// same kit the map pills and hotspot prompts are built from (styles.css).
const CSS = `
.tour-card {
  position: absolute; z-index: 6; width: min(274px, 74vw);
  background: var(--card); border: 4px solid #fff; border-radius: 20px;
  padding: 12px 14px 11px; text-align: left; color: var(--ink);
  font-family: var(--font); line-height: 1.35;
  box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  transition: opacity 0.22s ease;
}
/* beats "#hud-root > * { pointer-events: auto }": the world must stay clickable
   right through the card (id + class outranks id + universal) */
#hud-root > .tour-card { pointer-events: none; }
.tour-card.is-away { opacity: 0; }
.tour-card.tour-pop { animation: tour-in 0.42s var(--spring); }
.tour-card.is-done { animation: tour-done 0.4s var(--spring); }

/* nub: 9px triangle flush against the 4px white border, hence the -13px */
.tour-card::before {
  content: ''; position: absolute; left: var(--nub-x, 50%); translate: -50% 0;
  border: 9px solid transparent;
}
.tour-card.nub-down::before { bottom: -13px; border-bottom: 0; border-top-color: #fff; }
.tour-card.nub-up::before { top: -13px; border-top: 0; border-bottom-color: #fff; }

.tour-step {
  display: inline-block; font-size: 10px; font-weight: 900; letter-spacing: 0.15em;
  text-transform: uppercase; color: #94702c; background: rgba(242, 182, 74, 0.26);
  padding: 3px 9px; border-radius: 999px; margin-bottom: 6px;
}
.tour-title {
  font-size: 15.5px; font-weight: 900; color: var(--accent); line-height: 1.2;
  text-shadow: 0 2px 0 rgba(45, 36, 23, 0.07);
}
.tour-body { margin-top: 4px; font-size: 12.5px; font-weight: 700; color: var(--muted); }
.tour-foot { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.tour-dots { display: flex; gap: 5px; flex: 1; }
.tour-dot {
  width: 7px; height: 7px; border-radius: 50%; background: rgba(45, 36, 23, 0.16);
  transition: background 0.2s ease, scale 0.2s var(--spring);
}
.tour-dot.on { background: var(--gold); scale: 1.25; }
.tour-skip {
  pointer-events: auto; border: 0; cursor: pointer; font-family: var(--font);
  font-size: 11px; font-weight: 800; color: var(--muted); background: rgba(45, 36, 23, 0.07);
  padding: 5px 12px; border-radius: 999px;
  transition: scale 0.12s ease, background 0.18s ease, color 0.18s ease;
}
.tour-skip:hover { background: rgba(232, 101, 122, 0.16); color: var(--accent); scale: 1.06; }
.tour-skip:active { scale: 0.95; }
.tour-skip:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }

/* the gold "over here" disc: sits on the subject, chevron aimed at it */
.tour-aim {
  position: absolute; z-index: 5; width: 34px; height: 34px; margin: -17px 0 0 -17px;
  border-radius: 50%; border: 3px solid #fff; pointer-events: none;
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%);
  box-shadow: var(--shadow); display: flex; align-items: center; justify-content: center;
  animation: tour-aim-pulse 1.6s ease-in-out infinite;
  transition: opacity 0.22s ease;
}
.tour-aim.is-away { opacity: 0; }
.tour-aim i {
  width: 0; height: 0; border: 7px solid transparent;
  border-bottom: 11px solid var(--ink); rotate: var(--aim, 0deg); translate: 0 -2px;
}

@keyframes tour-in {
  0% { opacity: 0; translate: 0 10px; scale: 0.9; }
  60% { opacity: 1; scale: 1.03; }
  100% { opacity: 1; translate: 0 0; scale: 1; }
}
@keyframes tour-done { 0% { scale: 1; } 40% { scale: 1.07; } 100% { scale: 1; } }
@keyframes tour-aim-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(242, 182, 74, 0.5), var(--shadow); }
  55% { box-shadow: 0 0 0 10px rgba(242, 182, 74, 0), var(--shadow); }
}
@media (prefers-reduced-motion: reduce) {
  .tour-card.tour-pop, .tour-card.is-done, .tour-aim { animation: none; }
}
`;

function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// --- the flag ---------------------------------------------------------------

/** Has this browser already been shown the tour (finished or skipped)? */
export function tourSeen() {
  try { return localStorage.getItem(FLAG) === '1'; } catch { return false; }
}

function markSeen() {
  try { localStorage.setItem(FLAG, '1'); } catch { /* private mode: tour repeats, harmless */ }
}

/** Forget the tour so the next start() runs it again (the HUD's "?" button). */
export function clearTourFlag() {
  try { localStorage.removeItem(FLAG); } catch { /* nothing to clear */ }
}

// --- anchors ----------------------------------------------------------------

const _v = new Vector3();

/**
 * World point -> viewport pixels. `behind` marks a point behind the camera,
 * whose projection mirrors: we flip it so the DIRECTION still reads, and the
 * caller clamps it to the screen edge.
 */
function project(engine, pos, yOff) {
  const cam = engine?.camera;
  if (!cam || !pos) return null;
  _v.set(pos.x, (pos.y || 0) + yOff, pos.z).project(cam);
  const behind = _v.z > 1;
  const x = (_v.x * 0.5 + 0.5) * innerWidth;
  const y = (-_v.y * 0.5 + 0.5) * innerHeight;
  return behind
    ? { x: innerWidth - x, y: innerHeight - y, off: true }
    : { x, y, off: x < 0 || y < 0 || x > innerWidth || y > innerHeight };
}

function domAnchor(id, side) {
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: side === 'up' ? r.bottom + 6 : r.top - 6, side, off: false };
}

const isExit = (h) => typeof h?.id === 'string' && h.id.startsWith('exit-');

// Hotspots that open a game. Ids are stable per room (peak 'play-sled',
// beach 'play-fishing', lounge 'pong'...), so match the families rather than
// the labels, which are player-facing copy and change with the wind.
const GAME_ID = /^(play-|race-join|hunt-|doodle-|table-)|^(pong|shuffle|connect4|chess|cards)$/;
const isGame = (h) => typeof h?.id === 'string' && !isExit(h) && GAME_ID.test(h.id);

/** Nearest hotspot to the player that passes `pick`, or null. */
function nearestHotspot(engine, pick) {
  const room = engine?.room;
  const p = engine?.playerAvatar?.group?.position;
  if (!room?.hotspots?.length || !p) return null;
  let best = null;
  let bestD = Infinity;
  for (const h of room.hotspots) {
    if (!h?.position || !pick(h)) continue;
    const d = Math.hypot(p.x - h.position.x, p.z - h.position.z);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

// --- what counts as "a menu is open" ---------------------------------------
// Every overlay in the game mounts one root div with its own class (shop, menu,
// profile, quest board, mural, friends, house editor) plus the stamp slam.
const MODAL_SEL = '.shop-overlay, .menu-overlay, .pf-overlay, .qb-overlay, .mu-overlay,'
  + ' .fr-overlay, .he-root, .slam';

function mapOpen() {
  const m = document.getElementById('map-overlay');
  return !!m && !m.classList.contains('hidden');
}

function dressUpOpen() {
  return !!document.querySelector('.shop-overlay, .pf-overlay');
}

function menusOpen(game) {
  return !!game.activeMinigame || mapOpen() || !!document.querySelector(MODAL_SEL);
}

// --- the beats --------------------------------------------------------------
// Each beat: copy, an anchor resolved fresh every frame, and a `done` test.
// `mercy` (seconds) is the only way a beat can pass without the player acting,
// and only beats 4 and 5 have one.

const BEATS = [
  {
    id: 'walk',
    title: 'Right-click the cobbles to waddle',
    body: 'Aim at any patch of ground with the RIGHT mouse button and your capy ambles over. Hold it down to steer. (On a touch screen, just tap.)',
    anchor: (t) => {
      const s = project(t.engine, t.engine?.playerAvatar?.group?.position, 3.1);
      return s && { ...s, side: 'down' };
    },
    start(t) {
      t.walked = 0;
      t.lastPos = null;
      // Settings > Walking can put movement back on the left button, and the
      // very first thing we teach must not be the wrong button.
      if (t.engine?.walkButton === 'left') {
        t.say('Click the cobbles to waddle',
          'Tap any patch of ground and your capy ambles over. No arrow keys needed.');
      }
    },
    done(t) {
      const p = t.engine?.playerAvatar?.group?.position;
      // a room change behind an open menu is a teleport, not a waddle
      if (!p || t.away) { t.lastPos = null; return false; }
      if (t.lastPos) t.walked += Math.hypot(p.x - t.lastPos.x, p.z - t.lastPos.z);
      t.lastPos = { x: p.x, z: p.z };
      return t.walked >= 2;
    },
  },
  {
    id: 'travel',
    title: 'Walk through an archway to travel',
    body: 'No menus here: stroll into a gateway and you pop out in the next place.',
    aim: true,
    anchor: (t) => {
      const h = nearestHotspot(t.engine, isExit);
      const s = project(t.engine, h ? h.position : t.engine?.playerAvatar?.group?.position, h ? 1.9 : 3.1);
      return s && { ...s, side: 'down' };
    },
    start(t) { t.roomAt = t.game.roomId; },
    done(t) { return t.game.roomId !== t.roomAt; },
  },
  {
    id: 'map',
    title: 'Press M or the Map button',
    body: 'The island map shows every spot in the cove, and where you are on it.',
    anchor: () => domAnchor('btn-map', 'down'),
    done: () => mapOpen(),
  },
  {
    id: 'games',
    title: 'That glowing prompt is a game',
    body: 'Every location has one. Waddle up to it and it will ask you to play.',
    aim: true,
    mercy: 8,
    start(t) {
      // a room whose nearest prompt is NOT a game (the plaza's quest board, the
      // club's DJ booth) gets copy that does not lie about it
      if (!nearestHotspot(t.engine, isGame)) {
        t.say('That glowing prompt is a thing to do',
          'Every location has a few, and most of them are games. Waddle up and see.');
      }
    },
    anchor: (t) => {
      const h = nearestHotspot(t.engine, isGame) || nearestHotspot(t.engine, (x) => !isExit(x));
      t.spot = h;
      const s = project(t.engine, h ? h.position : t.engine?.playerAvatar?.group?.position, h ? 2.1 : 3.1);
      return s && { ...s, side: 'down' };
    },
    done(t) {
      const h = t.spot;
      const p = t.engine?.playerAvatar?.group?.position;
      if (!h || !p) return false;
      return Math.hypot(p.x - h.position.x, p.z - h.position.z) <= (h.radius || 2.5) + 1.2;
    },
  },
  {
    id: 'dressup',
    title: 'Tap the hat button to dress up',
    body: 'Colors and hats are yours forever, and everyone in the cove can see them.',
    mercy: 8,
    anchor: () => domAnchor('btn-shop', 'up'),
    done: () => dressUpOpen(),
  },
];

// --- the tour ---------------------------------------------------------------

let live = null; // one tour at a time; a replay disposes the running one

/**
 * Start the tour if this browser has not seen it. Called once from main.js
 * after enterWorld(). Returns the tour handle, or null when it is not wanted.
 */
export function maybeStartTour(game) {
  if (tourSeen()) return null;
  return startTour(game);
}

/** The HUD's "?" button: forget the flag and run the whole thing again. */
export function replayTour(game) {
  clearTourFlag();
  return startTour(game, { replay: true });
}

/** Run the tour now, flag or no flag. */
export function startTour(game, { replay = false } = {}) {
  if (typeof document === 'undefined') return null;
  live?.dispose();
  ensureStyles();

  const host = document.getElementById('hud-root') || document.body;
  const engine = game.engine;

  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Welcome tour');
  card.innerHTML = `
    <div class="tour-say" aria-live="polite">
      <span class="tour-step"></span>
      <div class="tour-title"></div>
      <div class="tour-body"></div>
    </div>
    <div class="tour-foot">
      <div class="tour-dots" aria-hidden="true">${BEATS.map(() => '<i class="tour-dot"></i>').join('')}</div>
      <button class="tour-skip" type="button">skip tour</button>
    </div>`;
  // parked off-screen until the first placement, so it never flashes at 0,0
  card.style.left = '-9999px';
  card.style.top = '-9999px';
  host.appendChild(card);

  const aim = document.createElement('div');
  aim.className = 'tour-aim is-away';
  aim.innerHTML = '<i></i>';
  aim.style.left = '-9999px';
  aim.style.top = '-9999px';
  host.appendChild(aim);

  const stepEl = card.querySelector('.tour-step');
  const titleEl = card.querySelector('.tour-title');
  const bodyEl = card.querySelector('.tour-body');
  const dots = [...card.querySelectorAll('.tour-dot')];
  const skipBtn = card.querySelector('.tour-skip');

  const t = {
    game,
    engine,
    i: -1,
    beat: null,
    age: 0,        // unpaused seconds on the current beat
    holding: 0,    // >0 while the completed card takes its bow
    started: false,
    gate: !replay, // a first run waits for the arrival swoop; a replay speaks up now
    walked: 0,
    lastPos: null,
    roomAt: game.roomId,
    spot: null,
    dead: false,
    // a beat may rewrite its own copy from start() once it can see the room
    say(title, body) {
      titleEl.textContent = title;
      bodyEl.textContent = body;
    },
  };

  let raf = 0;
  let last = performance.now();
  const offRoom = game.events.on('room', () => { t.lastPos = null; });

  function setBeat(n) {
    t.i = n;
    t.beat = BEATS[n];
    t.age = 0;
    t.spot = null;
    stepEl.textContent = `Step ${n + 1} of ${BEATS.length}`;
    titleEl.textContent = t.beat.title;
    bodyEl.textContent = t.beat.body;
    dots.forEach((d, k) => d.classList.toggle('on', k <= n));
    aim.classList.toggle('is-away', !t.beat.aim);
    card.classList.remove('tour-pop', 'is-done');
    void card.offsetWidth; // restart the entry keyframes
    card.classList.add('tour-pop');
    t.beat.start?.(t);
    game.audio?.play?.(n === 0 ? 'sparkle' : 'pop');
  }

  /** Card + aim disc positioning. `a` is {x, y, side, off}. */
  function place(a) {
    // a camera mid-resize can hand back NaN; leave the card where it was
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return;
    const pad = 12;
    // offsetWidth/Height, not getBoundingClientRect: the entry pop scales the
    // card, and measuring the transformed box mid-animation would walk it around
    const w = card.offsetWidth || 274;
    const h = card.offsetHeight || 130;
    // an off-screen subject drags the card to the nearest edge, still pointing
    const ax = Math.max(pad + 18, Math.min(innerWidth - pad - 18, a.x));
    const ay = Math.max(pad + 18, Math.min(innerHeight - pad - 18, a.y));

    // the aim disc sits ON the subject, so a beat that shows one needs the card
    // stood off far enough to clear it
    const gap = t.beat?.aim ? 32 : 16;
    let side = a.side === 'up' ? 'up' : 'down';
    if (side === 'down' && ay - h - gap < pad) side = 'up';
    else if (side === 'up' && ay + h + gap > innerHeight - pad) side = 'down';

    const left = Math.max(pad, Math.min(innerWidth - pad - w, ax - w / 2));
    const top = side === 'down'
      ? Math.max(pad, ay - h - gap)
      : Math.min(innerHeight - pad - h, ay + gap);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.classList.toggle('nub-down', side === 'down');
    card.classList.toggle('nub-up', side === 'up');
    card.style.setProperty('--nub-x', `${Math.round(Math.max(18, Math.min(w - 18, ax - left)))}px`);

    if (t.beat?.aim) {
      aim.style.left = `${Math.round(ax)}px`;
      aim.style.top = `${Math.round(ay)}px`;
      // chevron (drawn pointing up) turned to face the real subject, which for
      // an on-screen one is simply "down at the disc" from the card above it
      const ang = Math.atan2(a.y - (top + h / 2), a.x - (left + w / 2)) * 180 / Math.PI + 90;
      aim.querySelector('i').style.setProperty('--aim', `${Math.round(ang)}deg`);
    }
  }

  function finish(skipped) {
    if (t.dead) return;
    markSeen();
    if (skipped) {
      game.toast('Tour skipped. The "?" button up top brings it back any time.', 4200);
    } else {
      game.audio?.play?.('levelup');
      game.toast('The cove is yours. Waddle wherever you like, and say hello to everyone.', 6000);
    }
    dispose();
  }

  function dispose() {
    if (t.dead) return;
    t.dead = true;
    cancelAnimationFrame(raf);
    offRoom();
    removeEventListener('resize', onResize);
    card.remove();
    aim.remove();
    if (live === handle) live = null;
  }

  const onResize = () => { last = performance.now(); };
  addEventListener('resize', onResize);
  skipBtn.addEventListener('click', (e) => { e.stopPropagation(); game.audio?.play?.('click'); finish(true); });

  function frame() {
    if (t.dead) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;

    // completion is checked even while a menu covers us (beats 3 and 5 complete
    // BY opening one), but nothing else runs and no timer moves
    const away = menusOpen(game);
    t.away = away;

    if (!t.started) {
      // first run: let the arrival swoop land and the iris finish before we speak.
      // A replay (the HUD's "?") only waits for a room to stand in.
      const settled = engine?.room && engine?.playerAvatar
        && (!t.gate || (engine.roomAge > 2.2 && !document.getElementById('fade')?.classList.contains('on')));
      if (!settled || away) return;
      t.started = true;
      setBeat(0);
      return;
    }

    if (t.holding > 0) {
      if (!away) t.holding -= dt;
      if (t.holding <= 0) {
        if (t.i + 1 >= BEATS.length) { finish(false); return; }
        setBeat(t.i + 1);
      }
    } else if (t.beat) {
      let done = false;
      try { done = !!t.beat.done(t); } catch (e) { console.error('[tour] beat check:', e); }
      if (!away) t.age += dt;
      if (!away && !done && t.beat.mercy && t.age >= t.beat.mercy) done = true;
      if (done) {
        t.holding = 0.75;
        card.classList.add('is-done');
        aim.classList.add('is-away');
        game.audio?.play?.('sparkle');
      }
    }

    card.classList.toggle('is-away', away);
    aim.classList.toggle('is-away', away || !t.beat?.aim || t.holding > 0);
    if (away) { t.lastPos = null; return; } // a teleport behind a menu is not a waddle

    let a = null;
    try { a = t.beat?.anchor(t); } catch (e) { console.error('[tour] anchor:', e); }
    if (a) place(a);
  }
  raf = requestAnimationFrame(frame);

  const handle = { dispose, skip: () => finish(true), get beat() { return t.beat?.id || null; } };
  live = handle;
  return handle;
}
