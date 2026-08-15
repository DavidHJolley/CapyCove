/**
 * The cadence engine, as the player sees it (wave 13; docs/NEXT-AAA.md
 * "Wave 13 - The cadence engine", docs/research/liveops.md section 2).
 *
 * Four things live here and nothing else:
 *   1. the event pill next to the room chip (what is on, how long is left)
 *   2. one lead-in toast, ten minutes before an event starts
 *   3. one fanfare toast the moment it starts
 *   4. the charm-found celebration (13E's weekly hidden object)
 *
 * House rules for all four, from the owner's declared defaults: the cove is
 * QUIET when nothing is on (no pill at all, not an empty one), nothing blinks,
 * nothing repeats itself, nothing scolds you for missing a week, and no line of
 * copy ever implies a deadline you have to beat. An event is an invitation.
 *
 * Public API is exactly:
 *   mountEvents(game)   -> unmount()      called once, from initHud
 * plus the pure helpers below, which exist so the wire-shape tolerance and the
 * countdown wording can be tested without a DOM (tests/events.test.mjs).
 *
 * Wire protocol (server -> client, on hello, on every room join, on change):
 *
 *   {t:'event', active:{id,name,until,effects}|null, next:{name,at}|null}
 *
 * That is the shape the wave froze and this file is written against. The frame
 * server/events.js actually ships is the same content under the plural name
 * ({t:'events', now, active:[...], next:{...}, flags}), so BOTH names are
 * listened for and both spellings of every field are read:
 *   ends   `until` | `endsAt` | `endsIn` (seconds)
 *   starts `at`    | `startsAt` | `startsIn` (seconds)
 * Absolute stamps are epoch ms. `now` (the server's clock) is used to take the
 * client's skew out of them. `active` may be an object or an array; when it is
 * an array the first entry is the one the pill shows. `blurb` rides the pill's
 * hover, `effects` becomes the little badge ("double coins"). Everything is
 * optional: a thinner frame is a quieter pill, never a crash.
 *
 *   {t:'charm-found', ...}   13E (server/charms.js), broadcast island-wide
 * Read loosely, and see parseCharm: in the shipped frame `name` is the FINDER
 * and `charmName` is the charm, so only the finder gets the celebration and
 * everyone else gets one quiet line.
 *
 * Nothing here touches the DOM, the network or the clock at import time.
 */

const STYLE_ID = 'capy-event-styles';

/** How early the pill starts looking forward to the next event. */
const PILL_LEAD_MS = 60 * 60 * 1000;
/** And how late it keeps saying "starting now" if the start frame is slow. */
const PILL_LATE_MS = 2 * 60 * 1000;
/** The one lead-in toast. Ten minutes is enough to finish a run and walk over. */
const TOAST_LEAD_MS = 10 * 60 * 1000;
/**
 * Below this the lead-in stays quiet: a toast that says "starts in a minute"
 * seconds before the fanfare is the same news told twice, and the pill is
 * already saying "starting now".
 */
const TOAST_MIN_MS = 30 * 1000;
const TICK_MS = 1000;
/** A charm card owns the screen for this long, or until it is clicked. */
const CHARM_MS = 5200;

const CSS = `
/* ---- the event pill (sits beside the room chip in .hud-top-left) ---- */
.ev-pill {
  display: none; align-items: center; gap: 8px; max-width: 40vw;
  background: var(--card); color: var(--ink);
  font-weight: 800; font-size: 13px; white-space: nowrap;
  padding: 7px 13px 7px 11px; border-radius: 999px;
  box-shadow: var(--lift), var(--shadow);
}
.ev-pill.is-on { display: inline-flex; }
/* the arrival is a one-shot: the pill NEVER animates while it just sits there */
.ev-pill.is-new { animation: ev-drop 0.5s var(--spring) backwards; }
.ev-pill.is-live {
  background: linear-gradient(180deg, #fff3d8 0%, #ffe6b4 100%);
  box-shadow: var(--lift), var(--shadow), inset 0 0 0 2px rgba(242, 182, 74, 0.45);
}
.ev-dot {
  width: 9px; height: 9px; border-radius: 50%; flex: none;
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%);
  box-shadow: 0 0 0 3px rgba(242, 182, 74, 0.22);
}
.ev-pill.is-soon .ev-dot {
  background: rgba(45, 36, 23, 0.2); box-shadow: none;
}
.ev-name { overflow: hidden; text-overflow: ellipsis; }
.ev-time {
  font-size: 11.5px; font-weight: 900; color: #8a6a1f;
  padding-left: 8px; border-left: 1.5px dotted rgba(45, 36, 23, 0.22);
}
.ev-pill.is-soon .ev-time { color: var(--muted); }
.ev-tag {
  font-size: 10px; font-weight: 900; letter-spacing: 0.06em; text-transform: uppercase;
  color: #8a6a1f; background: rgba(242, 182, 74, 0.3);
  padding: 3px 8px; border-radius: 999px;
}
@keyframes ev-drop { from { opacity: 0; translate: 0 -12px; scale: 0.9; } }
/* Narrow screens: the top-left row is already three chips wide, so the pill
   steps onto its own line under them rather than shoving the net dot off the
   edge (.hud-top-left is absolutely positioned, so this anchors to it). */
@media (max-width: 620px) {
  .ev-pill { position: absolute; top: calc(100% + 8px); left: 0; max-width: 70vw; }
  .ev-tag { display: none; }
}

/* ---- the charm celebration ---- */
.ev-charm {
  position: absolute; inset: 0; z-index: 57; display: flex;
  align-items: center; justify-content: center; cursor: pointer;
  background: radial-gradient(ellipse 70% 60% at 50% 48%, rgba(45, 36, 23, 0.34) 0%, rgba(20, 32, 44, 0.72) 100%);
  animation: ev-fade 0.25s ease;
}
.ev-charm.is-out { opacity: 0; transition: opacity 0.4s ease; pointer-events: none; }
.ev-charm-rays {
  position: absolute; width: 140vmax; height: 140vmax; pointer-events: none; opacity: 0.4;
  background: repeating-conic-gradient(from 0deg,
    rgba(255, 236, 190, 0.22) 0deg 8deg, rgba(255, 236, 190, 0) 8deg 16deg);
  animation: ev-spin 26s linear infinite;
}
.ev-charm-card {
  position: relative; width: min(400px, 90vw); padding: 26px 24px 18px;
  background: var(--cream); border: 4px solid #fff; border-radius: 28px; text-align: center;
  box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  animation: ev-rise 0.5s cubic-bezier(0.18, 1.2, 0.4, 1);
}
.ev-gem {
  width: 68px; height: 68px; margin: 0 auto 12px; position: relative;
  border-radius: 20px 6px 20px 6px; rotate: 45deg;
  background: linear-gradient(150deg, #fff3d8 0%, var(--gold) 55%, #d99a2c 100%);
  box-shadow: 0 10px 22px rgba(150, 110, 30, 0.35), inset 0 0 0 3px rgba(255, 255, 255, 0.6);
  animation: ev-gem 0.7s cubic-bezier(0.2, 1.5, 0.35, 1);
}
.ev-gem::after {
  content: ''; position: absolute; left: 13px; top: 11px; width: 16px; height: 11px;
  border-radius: 50%; background: rgba(255, 255, 255, 0.75); rotate: -35deg;
}
.ev-charm-kicker {
  font-size: 11px; font-weight: 900; letter-spacing: 0.26em; text-transform: uppercase;
  color: #b98c2c;
}
.ev-charm-name {
  font-size: clamp(21px, 5vw, 27px); font-weight: 900; color: var(--accent);
  line-height: 1.15; margin-top: 2px; overflow-wrap: anywhere;
}
.ev-charm-sub {
  font-size: 13px; font-weight: 800; color: #a3906c; margin-top: 6px; line-height: 1.4;
}
.ev-charm-tap {
  font-size: 10.5px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
  color: #c2b191; margin-top: 14px;
}
.ev-spark {
  position: absolute; width: 11px; height: 11px; border-radius: 50%; pointer-events: none;
  animation: ev-spark 1.1s ease-out backwards;
}
@keyframes ev-fade { from { opacity: 0; } }
@keyframes ev-spin { to { rotate: 360deg; } }
@keyframes ev-rise { from { opacity: 0; translate: 0 22px; scale: 0.92; } }
@keyframes ev-gem {
  0% { opacity: 0; scale: 0.3; rotate: 200deg; }
  70% { opacity: 1; scale: 1.08; rotate: 38deg; }
  100% { opacity: 1; scale: 1; rotate: 45deg; }
}
@keyframes ev-spark {
  0% { opacity: 1; scale: 0.3; }
  100% { opacity: 0; scale: 1; translate: var(--dx) var(--dy); }
}
@media (prefers-reduced-motion: reduce) {
  .ev-pill.is-new, .ev-charm-rays, .ev-charm-card, .ev-gem, .ev-spark { animation: none; }
}
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// reading the wire (pure: no DOM, no clock of its own)
// ---------------------------------------------------------------------------

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** An absolute stamp wins; a relative one (seconds) is measured off `now`. */
function stampOf(abs, rel, now, skew) {
  const a = num(abs);
  if (a !== null && a > 0) return a - skew;
  const r = num(rel);
  if (r !== null) return now + r * 1000;
  return null;
}

/** "2x coins" and friends: the one-word reason this event is worth walking to. */
function badgeFor(effects) {
  if (!effects || typeof effects !== 'object') return '';
  const coins = hasOwn(effects, 'coins') ? effects.coins : null;
  const mult = num(coins) ?? num(coins && coins.mult);
  // coinMult multiplies UP only (owner's law), so anything at or under 1 is not
  // news and never gets a badge
  if (mult !== null && mult > 1) {
    const m = Math.round(mult * 100) / 100;
    return `${m === 2 ? 'double' : `${m}x`} coins`;
  }
  const off = num(effects.shop && effects.shop.discount);
  if (off !== null && off > 0) return `${Math.round(off * 100)}% off`;
  if (effects.sky && effects.sky.aurora) return 'aurora';
  const mural = num(effects.mural && effects.mural.cooldownMs);
  if (mural !== null && mural > 0) return 'fast brush';
  return '';
}

function readActive(a, now, skew) {
  if (!a || typeof a !== 'object') return null;
  const name = str(a.name) || str(a.title) || str(a.id);
  if (!name) return null;
  const effects = a.effects && typeof a.effects === 'object' ? a.effects : null;
  return {
    id: str(a.id) || name.toLowerCase(),
    name,
    blurb: str(a.blurb) || str(a.desc) || '',
    until: stampOf(a.until ?? a.endsAt ?? a.ends, a.endsIn ?? a.secondsLeft, now, skew),
    effects,
    badge: badgeFor(effects),
  };
}

function readNext(n, now, skew) {
  if (!n || typeof n !== 'object') return null;
  const name = str(n.name) || str(n.title) || str(n.id);
  if (!name) return null;
  const at = stampOf(n.at ?? n.startsAt ?? n.start, n.startsIn ?? n.secondsUntil, now, skew);
  if (at === null) return null;
  return { id: str(n.id) || name.toLowerCase(), name, at, blurb: str(n.blurb) };
}

/**
 * The 'event' frame -> {active, next}, with every time already converted to
 * THIS machine's clock. If the frame carries the server's `now`, the offset is
 * taken out here so nothing downstream has to think about skew again.
 */
export function parseEventFrame(m, now = Date.now()) {
  const raw = m && typeof m === 'object' ? m : {};
  const serverNow = num(raw.now);
  // a wildly wrong clock on either side would otherwise hide events entirely;
  // past ten minutes it is likelier a bad field than a real offset
  let skew = serverNow === null ? 0 : serverNow - now;
  if (!Number.isFinite(skew) || Math.abs(skew) > 10 * 60 * 1000) skew = 0;
  const one = Array.isArray(raw.active) ? raw.active[0] : raw.active;
  return { active: readActive(one, now, skew), next: readNext(raw.next, now, skew) };
}

/**
 * "24m", "1h 5m", "under a minute". Rounds to the nearest minute rather than
 * flooring: a 24-minute event whose frame arrived a heartbeat ago has 23m59s
 * left, and a pill that says "23m left" against a calendar that says 24 reads
 * as a bug. The last minute is a word, not a number, so nothing ever counts
 * down in seconds at anyone.
 */
export function fmtLeft(ms) {
  const s = Math.max(0, Math.round((num(ms) ?? 0) / 1000));
  if (s < 60) return 'under a minute';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * What the pill should say right now, or {show:false} for the quiet cove.
 * kind is 'live' (something is on) or 'soon' (something is within the hour).
 */
export function pillView(state, now = Date.now()) {
  const a = state && state.active;
  if (a) {
    const left = a.until === null ? null : a.until - now;
    if (left === null || left > 0) {
      return {
        show: true,
        kind: 'live',
        name: a.name,
        time: left === null ? 'on now' : (left < 60 * 1000 ? 'wrapping up' : `${fmtLeft(left)} left`),
        badge: a.badge,
        blurb: a.blurb || '',
        key: `a:${a.id}`,
      };
    }
    // it has run out locally and the end frame has not landed yet: say nothing
    // rather than counting into the negative
  }
  const n = state && state.next;
  if (n) {
    const until = n.at - now;
    if (until <= PILL_LEAD_MS && until > -PILL_LATE_MS) {
      return {
        show: true,
        kind: 'soon',
        name: n.name,
        time: until <= 30 * 1000 ? 'starting now' : `in ${fmtLeft(until)}`,
        badge: '',
        blurb: n.blurb || '',
        key: `n:${n.id}`,
      };
    }
  }
  return { show: false, kind: '', name: '', time: '', badge: '', blurb: '', key: '' };
}

/** The lead-in line. Rounds, because "starts in 10 min" is a human sentence. */
export function leadInLine(name, ms) {
  const mins = Math.round((num(ms) ?? 0) / 60000);
  if (mins <= 1) return `${name} starts in a minute`;
  return `${name} starts in ${mins} min`;
}

/**
 * The charm frame -> what the celebration needs.
 *
 * server/charms.js broadcasts the find to the WHOLE island, and in that frame
 * `name` is the finder and `charmName` is the charm. So `charmName` is the
 * disambiguator: when it is there, `name` is a player; when it is not, `name`
 * is the charm and the finder (if any) rides `by`. Getting this backwards puts
 * a stranger's name on your own celebration card, so it is tested both ways.
 */
export function parseCharm(m, myName = '') {
  const raw = m && typeof m === 'object' ? m : {};
  const charmName = str(raw.charmName);
  const by = str(raw.by) || str(raw.who) || str(raw.player) || str(raw.finder)
    || (charmName ? str(raw.name) : '');
  const me = String(myName || '').trim().toLowerCase();
  const mine = raw.you === true || raw.mine === true
    || !by || (!!me && by.toLowerCase() === me);
  return {
    id: str(raw.charm) || str(raw.id),
    name: charmName || str(raw.name) || str(raw.charm) || "this week's charm",
    where: str(raw.roomName) || str(raw.where),
    coins: num(raw.coins) ?? num(raw.reward) ?? null,
    // charms.js counts the WEEK's finders, so `n` is "the nth capy to find it"
    n: num(raw.n) ?? num(raw.found) ?? null,
    first: raw.first === true,
    by,
    mine,
  };
}

/**
 * The line under the charm's name. Never a leaderboard and never a scold: being
 * the ninth capy to find it is exactly as good as being the first.
 */
export function charmLine(c) {
  const bits = [];
  if (c.coins !== null && c.coins > 0) bits.push(`+${c.coins} coins`);
  if (c.first) bits.push('First to find it this week!');
  else if (c.n !== null && c.n > 1) bits.push(`The ${ordinal(c.n)} capy to find it this week.`);
  else if (c.where) bits.push(`It was tucked away in ${c.where}.`);
  if (!bits.length) return 'One a week, and this one was yours.';
  return bits.join(' ');
}

/** 1 -> "1st". Only ever used on a number the server counted. */
function ordinal(n) {
  const v = Math.abs(Math.round(n));
  const tens = v % 100;
  if (tens >= 11 && tens <= 13) return `${v}th`;
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
}

// ---------------------------------------------------------------------------
// the mount
// ---------------------------------------------------------------------------

let live = null; // the one mounted instance, so a double mount cannot stack

/**
 * Build the pill, wire the four moments, return an unmount.
 * Safe to call twice: the previous mount is torn down first.
 */
export function mountEvents(game) {
  if (live) { try { live(); } catch { /* already gone */ } live = null; }
  ensureStyles();

  const hud = document.getElementById('hud-root');
  const chip = hud && hud.querySelector('.room-chip');
  const row = (chip && chip.parentElement) || (hud && hud.querySelector('.hud-top-left')) || hud;
  if (!row) return () => {};

  const pill = document.createElement('div');
  pill.className = 'ev-pill';
  pill.innerHTML = '<i class="ev-dot"></i><span class="ev-name"></span>'
    + '<span class="ev-tag"></span><span class="ev-time"></span>';
  const elName = pill.querySelector('.ev-name');
  const elTag = pill.querySelector('.ev-tag');
  const elTime = pill.querySelector('.ev-time');
  if (chip && chip.parentElement) chip.insertAdjacentElement('afterend', pill);
  else row.appendChild(pill);

  let state = { active: null, next: null };
  let seen = false;        // have we ever held a frame this session?
  let liveKey = null;      // the running event, for start/end transitions
  let liveName = '';
  let toldLead = null;     // the upcoming event we have already toasted about
  let shownKey = '';       // what the pill currently says, so we only write on change
  let shownText = '';
  let askedAt = 0;

  const offs = [];
  const on = (name, fn) => {
    const off = game.events.on(name, fn);
    if (typeof off === 'function') offs.push(off);
  };

  // ---- the pill ------------------------------------------------------------
  function paint() {
    const now = Date.now();
    const v = pillView(state, now);
    if (!v.show) {
      if (shownKey) { pill.className = 'ev-pill'; shownKey = ''; shownText = ''; }
      return;
    }
    const text = `${v.name}|${v.time}|${v.badge}|${v.blurb}`;
    const fill = () => {
      elName.textContent = v.name;
      elTag.textContent = v.badge;
      elTag.style.display = v.badge ? '' : 'none';
      elTime.textContent = v.time;
      // the blurb is the whole sentence, kept off the pill and on the hover:
      // the top-left corner is chrome, not a place to read a paragraph
      pill.title = v.blurb ? `${v.name}: ${v.blurb}` : v.name;
    };
    if (v.key !== shownKey) {
      fill();
      pill.className = `ev-pill is-on is-new ${v.kind === 'live' ? 'is-live' : 'is-soon'}`;
      shownKey = v.key;
      shownText = text;
      return;
    }
    if (text === shownText) return;
    fill();
    // same event, new number: no re-entrance, the pill just quietly updates
    pill.className = `ev-pill is-on ${v.kind === 'live' ? 'is-live' : 'is-soon'}`;
    shownText = text;
  }

  // ---- the two toasts ------------------------------------------------------
  function fanfare(a) {
    game.audio?.play?.('levelup');
    const chime = setTimeout(() => game.audio?.play?.('sparkle'), 380);
    timers.add(chime);
    const bits = [`${a.name} is on!`];
    if (a.blurb) bits.push(a.blurb);
    else if (a.badge) bits.push(`${a.badge[0].toUpperCase()}${a.badge.slice(1)} while it lasts.`);
    else bits.push('Come and join in.');
    game.toast(bits.join(' '), 5200);
  }

  function wound(name) {
    // never a scold, never a "you missed it": the cove just goes quiet again
    game.toast(`${name} has wound down. Thanks for coming by.`, 3000);
  }

  function checkLeadIn() {
    const n = state.next;
    if (!n) return;
    // the board still lists the event that is already running: not news
    if (state.active && state.active.id === n.id) return;
    const until = n.at - Date.now();
    if (until > TOAST_LEAD_MS || until <= TOAST_MIN_MS) return;
    // one key per scheduled start (rounded, so a second of server drift between
    // frames cannot make this fire twice)
    const key = `${n.id}@${Math.round(n.at / (5 * 60000))}`;
    if (toldLead === key) return;
    // never over the top of a minigame: the tick will bring it back the moment
    // the run is over, and if the event has started by then it simply never fires
    if (game.activeMinigame) return;
    toldLead = key;
    game.audio?.play?.('ding');
    game.toast(leadInLine(n.name, until), 4600);
  }

  function apply(m) {
    const next = parseEventFrame(m);
    state = next;
    const a = state.active;
    // keyed on the id ALONE: a server that recomputes `until` between frames
    // (an extended event, a re-read of the calendar) must not read as a second
    // start and fanfare twice into the same hour
    const key = a ? a.id : null;
    if (key !== liveKey) {
      // A fanfare is for a start we WITNESSED. Walking in twenty minutes into
      // Golden Hour is not a start, it is a room you joined late, so the first
      // frame of a session is adopted in silence and the pill says the rest.
      if (seen && a) fanfare(a);
      else if (seen && !a && liveName) wound(liveName);
      liveKey = key;
      liveName = a ? a.name : '';
    }
    seen = true;
    paint();
    checkLeadIn();
  }

  // ---- the charm celebration ----------------------------------------------
  const timers = new Set();
  const charmQueue = [];
  let charmBusy = false;
  let charmWaiting = false;

  function queueCharm(m) {
    const c = parseCharm(m, game.state && game.state.name);
    if (!c.mine) {
      // Someone else's find is a postcard, not a party: one quiet line, no
      // sound, and never the room it was hiding in (the island frame carries
      // that, and printing it would hand every reader the answer).
      game.toast(`${c.by} found this week's charm.`, 2600);
      return;
    }
    if (charmQueue.length >= 3) return;
    charmQueue.push(c);
    if (!charmBusy) nextCharm();
  }

  function nextCharm() {
    if (!charmQueue.length) { charmBusy = false; return; }
    if (game.activeMinigame) {
      // same rule as the stamp slam: never take the screen off a running game
      charmBusy = false;
      if (!charmWaiting) {
        charmWaiting = true;
        // tracked in `offs` too: an unmount while a card is waiting on a
        // minigame must not leave a listener behind that revives it later
        const off = game.events.on('minigame', (id) => {
          if (id) return;
          try { off(); } catch { /* already gone */ }
          charmWaiting = false;
          if (!charmBusy) nextCharm();
        });
        if (typeof off === 'function') offs.push(off);
      }
      return;
    }
    charmBusy = true;
    showCharm(charmQueue.shift(), () => nextCharm());
  }

  function showCharm(c, done) {
    const host = document.getElementById('hud-root') || document.body;
    const root = document.createElement('div');
    root.className = 'ev-charm';
    root.setAttribute('role', 'status');
    root.innerHTML = `
      <div class="ev-charm-rays"></div>
      <div class="ev-charm-card">
        <div class="ev-gem"></div>
        <div class="ev-charm-kicker">Charm found</div>
        <div class="ev-charm-name"></div>
        <div class="ev-charm-sub"></div>
        <div class="ev-charm-tap">Click to carry on</div>
      </div>`;
    root.querySelector('.ev-charm-name').textContent = c.name;
    root.querySelector('.ev-charm-sub').textContent = charmLine(c);

    for (let i = 0; i < 12; i++) {
      const s = document.createElement('i');
      s.className = 'ev-spark';
      const ang = (i / 12) * Math.PI * 2 + Math.random() * 0.5;
      const d = 90 + Math.random() * 110;
      s.style.setProperty('--dx', `${Math.cos(ang) * d}px`);
      s.style.setProperty('--dy', `${Math.sin(ang) * d}px`);
      s.style.background = ['#f2b64a', '#fff6e3', '#e8657a', '#4fb3e8'][i % 4];
      s.style.animationDelay = `${0.2 + (i % 4) * 0.04}s`;
      root.appendChild(s);
    }
    host.appendChild(root);
    cards.add(root);

    game.audio?.play?.('levelup');
    const chime = setTimeout(() => game.audio?.play?.('sparkle'), 400);
    timers.add(chime);

    let gone = false;
    const bye = () => {
      if (gone) return;
      gone = true;
      clearTimeout(chime);
      clearTimeout(timer);
      timers.delete(chime);
      timers.delete(timer);
      root.removeEventListener('click', bye);
      root.classList.add('is-out');
      const off = setTimeout(() => { root.remove(); cards.delete(root); done(); }, 420);
      timers.add(off);
    };
    const timer = setTimeout(bye, CHARM_MS);
    timers.add(timer);
    root.addEventListener('click', bye);
  }

  const cards = new Set();

  // ---- wiring --------------------------------------------------------------
  // 'events' is the name server/events.js ships; 'event' is the singular the
  // brief froze. Both land here so neither side has to move for the other.
  on('events', apply);
  on('event', apply);
  on('charm-found', queueCharm);

  // A frame that landed before this module finished loading: the net client
  // caches the last one for exactly this reason (same trick as its table cache).
  const cached = game.__eventsLast || game.__eventLast;
  if (cached) apply(cached);

  /**
   * Ask for the board. The server pushes it on hello and on every room join,
   * so this only covers the mount race. server/events.js answers {t:'events'}
   * as a rate-limited read; it is debounced here as well, and it is harmless
   * against a server that does not answer reads at all.
   */
  function ask() {
    const now = Date.now();
    if (now - askedAt < 10000) return;
    askedAt = now;
    game.net?.send?.({ t: 'events' });
  }
  ask();
  on('net', (s) => { if (s === 'online') ask(); });

  const tick = setInterval(() => { paint(); checkLeadIn(); }, TICK_MS);

  live = () => {
    live = null;
    clearInterval(tick);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const el of cards) el.remove();
    cards.clear();
    charmQueue.length = 0;
    for (const off of offs) { try { off(); } catch { /* already gone */ } }
    offs.length = 0;
    pill.remove();
  };
  return live;
}
