import { stampById, paintStampCanvas } from './profile.js';

/**
 * The Quest Board: the plaza notice board's overlay (wave 7, docs/LIVING-COVE.md
 * section D). Three dailies per cove day, a progress bar each, and a bonus for
 * clearing all three.
 *
 * Public API is exactly: openQuests(game)  (a second call while it is up closes
 * it, same as the shop and the menu).
 *
 * Wire protocol, tolerated loosely because the server owns the shapes:
 *   out  {t:'quests'}              ask for today's board
 *   out  {t:'quest-claim', id}     only sent for quests the server marks claimable
 *   in   {t:'quests', quests:[...], bonus:{...}, resetIn, streak:{...}}  full board
 *   in   {t:'quest-done', id, ...}                         one quest ticked over
 * The login streak rides this frame rather than one of its own (wave 12B):
 *   streak {days, show, plus, best, gift, next, claimed}
 * See the chip below for what it is allowed to say about it.
 * A quest may arrive as {id, name|title, desc|blurb, progress|n, target|goal,
 * done, claimed, claimable, reward|coins}; anything missing gets a sane default
 * so a half-built server still paints a readable board.
 *
 * Nothing here touches the DOM until openQuests runs, so the module is
 * import-safe.
 */

const STYLE_ID = 'capy-quest-styles';

// A cove day is 40 real minutes (section A), so the board rolls over at dawn.
// The clock frame carries the real length as `dayMs`, and that wins the moment
// it arrives: hard-coding this was showing "new jobs in 19m" against a server
// running a ten-minute day.
let COVE_DAY_MS = 40 * 60 * 1000;

const CSS = `
.qb-overlay {
  position: absolute; inset: 0; padding: 18px; display: flex;
  align-items: center; justify-content: center; z-index: 44;
  background: rgba(20, 32, 44, 0.55); backdrop-filter: blur(7px) saturate(1.15);
  animation: qb-fade 0.18s ease;
}
.qb-overlay.is-closing { opacity: 0; transition: opacity 0.15s ease; pointer-events: none; }
.qb-card {
  position: relative; width: min(560px, 94vw); max-height: 92vh; overflow: auto;
  padding: 20px 22px 16px; background: var(--cream); border: 4px solid #fff;
  border-radius: 26px; box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  animation: qb-rise 0.3s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.qb-card:focus { outline: none; }
.qb-x { position: absolute; top: 14px; right: 14px; z-index: 2; }

.qb-head { padding-right: 46px; }
.qb-head h2 { font-size: 25px; color: var(--accent); letter-spacing: 0.02em; margin: 0; }
.qb-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; margin: 2px 0 4px; }
.qb-timer {
  display: inline-block; font-size: 10.5px; font-weight: 900; letter-spacing: 0.08em;
  text-transform: uppercase; color: #8a6a1f; background: rgba(242, 182, 74, 0.28);
  padding: 4px 11px; border-radius: 999px; margin-bottom: 10px;
}

.qb-streak {
  display: flex; align-items: center; gap: 12px; margin: 2px 0 11px; padding: 10px 14px;
  border-radius: 17px; background: rgba(242, 182, 74, 0.16);
  box-shadow: inset 0 0 0 2px rgba(242, 182, 74, 0.3);
  animation: qb-pop 0.36s backwards var(--spring);
}
.qb-streak[hidden] { display: none; }
.qb-streak-ico { flex: none; width: 40px; height: 40px; }
.qb-streak-ico canvas { display: block; }
.qb-streak-txt { flex: 1; min-width: 0; }
.qb-streak-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.qb-streak-days { font-weight: 900; font-size: 13.5px; }
.qb-streak-best {
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
  color: #a4720f;
}
.qb-streak-sub { font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.35; }
.qb-pips { display: flex; align-items: center; gap: 4px; margin-top: 5px; }
.qb-pip {
  width: 9px; height: 9px; border-radius: 50%; flex: none;
  background: radial-gradient(circle at 34% 28%, #fff3bd 0%, var(--gold) 60%, #c98c1d 100%);
}
.qb-pip.next { background: none; box-shadow: inset 0 0 0 2px rgba(164, 114, 15, 0.35); }
.qb-pip-more {
  font-size: 10px; font-weight: 900; color: #a4720f; letter-spacing: 0.04em; margin-left: 1px;
}

.qb-list { display: flex; flex-direction: column; gap: 8px; }
.qb-q {
  display: flex; align-items: center; gap: 12px; background: var(--card);
  border-radius: 17px; padding: 10px 13px; box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: qb-pop 0.34s backwards var(--spring); animation-delay: calc(var(--i) * 80ms);
  transition: background 0.25s ease, box-shadow 0.25s ease;
}
.qb-q.is-done { background: #f4fbe9; box-shadow: 0 3px 0 rgba(122, 199, 79, 0.28); }
.qb-q-ico { flex: none; width: 46px; height: 46px; position: relative; }
.qb-q-ico canvas { display: block; }
.qb-q.is-locked .qb-q-ico { filter: grayscale(0.85) opacity(0.55); }
.qb-q-tick {
  position: absolute; right: -4px; bottom: -3px; width: 20px; height: 20px; border-radius: 50%;
  background: #6fcf5f; border: 2px solid var(--card); color: #fff; font-size: 11px;
  font-weight: 900; line-height: 16px; text-align: center;
  animation: qb-pop 0.4s var(--spring);
}
.qb-q-body { flex: 1; min-width: 0; }
.qb-q-name { font-weight: 900; font-size: 14px; line-height: 1.2; overflow-wrap: anywhere; }
.qb-q-desc { font-size: 11.5px; font-weight: 700; color: #a3906c; line-height: 1.3; margin-bottom: 5px; }
.qb-bar {
  position: relative; height: 13px; border-radius: 999px; background: rgba(45, 36, 23, 0.09);
  overflow: hidden;
}
.qb-bar i {
  position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 999px;
  background: linear-gradient(90deg, var(--gold) 0%, #f39c5c 100%);
  transition: width 0.55s var(--spring);
}
.qb-q.is-done .qb-bar i { background: linear-gradient(90deg, #8fd964 0%, #5fbf4c 100%); }
.qb-bar b {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.06em; color: #6b5b3c;
}
.qb-q-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.qb-reward {
  display: flex; align-items: center; gap: 4px; font-weight: 900; font-size: 14px; color: #a4720f;
}
.qb-coin {
  width: 13px; height: 13px; border-radius: 50%; flex: none;
  background: radial-gradient(circle at 34% 28%, #fff3bd 0%, var(--gold) 58%, #c98c1d 100%);
  box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.5);
}
.qb-claimed {
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
  color: #5a9b3f;
}
.qb-btn {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 12.5px;
  padding: 7px 15px; border-radius: 999px; color: var(--ink);
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%);
  box-shadow: 0 4px 0 rgba(158, 111, 20, 0.3);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.qb-btn:hover:not(:disabled) { scale: 1.06; filter: brightness(1.05); }
.qb-btn:active:not(:disabled) { scale: 0.95; }
.qb-btn:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.qb-btn:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }

.qb-bonus {
  display: flex; align-items: center; gap: 12px; margin-top: 10px; padding: 11px 14px;
  border-radius: 17px; background: rgba(232, 101, 122, 0.1);
  box-shadow: inset 0 0 0 2px rgba(232, 101, 122, 0.18);
}
.qb-bonus.is-done { background: rgba(122, 199, 79, 0.16); box-shadow: inset 0 0 0 2px rgba(95, 191, 76, 0.35); }
/* the class sets display:flex, which would otherwise beat the [hidden] default */
.qb-bonus[hidden] { display: none; }
.qb-bonus-ico { flex: none; width: 40px; height: 40px; }
.qb-bonus-txt { flex: 1; min-width: 0; }
.qb-bonus-name { font-weight: 900; font-size: 13.5px; }
.qb-bonus-sub { font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.35; }

.qb-empty { text-align: center; padding: 22px 12px; }
.qb-empty h3 { font-size: 16px; margin-bottom: 6px; }
.qb-empty p { font-size: 12.5px; font-weight: 700; color: var(--muted); line-height: 1.5; }

.qb-guest {
  margin-top: 12px; padding: 12px 14px; border-radius: 17px; text-align: center;
  background: rgba(79, 179, 232, 0.14); box-shadow: inset 0 0 0 2px rgba(79, 179, 232, 0.24);
}
.qb-guest h3 { font-size: 14.5px; margin-bottom: 4px; color: #2f7fae; }
.qb-guest p { font-size: 12px; font-weight: 700; color: var(--muted); line-height: 1.45; }
.qb-foot { margin-top: 12px; font-size: 11.5px; font-weight: 700; color: #b6a688; text-align: center; }

@keyframes qb-fade { from { opacity: 0; } }
@keyframes qb-rise { from { opacity: 0; transform: translateY(16px) scale(0.95); } }
@keyframes qb-pop { from { opacity: 0; transform: translateY(9px) scale(0.93); } }
@media (prefers-reduced-motion: reduce) {
  .qb-card, .qb-q, .qb-q-tick, .qb-streak { animation: none; }
  .qb-bar i { transition: none; }
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

// ---------------------------------------------------------------------------
// board state (cached so a re-open paints instantly instead of flashing empty)
// ---------------------------------------------------------------------------

let board = { quests: [], bonus: null, streak: null, resetAt: 0, loaded: false };
let listening = false;
// wave 12: resetIn is a REAL-DAY number now; once the server has spoken the
// 40-minute cove clock must never overwrite it again.
let serverReset = false;

const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parseQuest(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id) || `daily${i}`;
  const target = Math.max(1, Math.floor(num(raw.target ?? raw.goal ?? raw.need, 1)));
  const progress = Math.max(0, Math.floor(num(raw.progress ?? raw.n ?? raw.count, 0)));
  const done = raw.done === true || raw.complete === true || progress >= target;
  return {
    id,
    name: str(raw.name) || str(raw.title) || str(raw.text) || 'A job for a capybara',
    desc: str(raw.desc) || str(raw.blurb) || str(raw.how) || '',
    target,
    progress: Math.min(progress, target),
    done,
    claimable: raw.claimable === true && raw.claimed !== true,
    // no explicit flag means the server paid on completion, which is the
    // shape section D asks for ("pushed live with a satisfying toast")
    claimed: raw.claimed === true || (done && raw.claimable !== true),
    reward: Math.max(0, Math.floor(num(raw.reward ?? raw.coins, 40))),
  };
}

/**
 * The login streak block (wave 12B). Nothing here is allowed to be a stick:
 * server-side a missed day simply starts the ramp again (see progress.js
 * nextStreak), so this chip only ever says how long you have been around, what
 * today's hello is worth and what tomorrow's would be. It never counts down, it
 * never says what a gap cost, and it never asks you to come back.
 *
 * Returns null for anyone without a streak (a guest, or a record whose day has
 * not been counted yet), which hides the chip entirely.
 *
 * The ladder's length is NOT hard-coded here: `plus` says you are past the top
 * of it and `next === gift` says you are standing on it, so the pips can be
 * drawn honestly against a server that lengthens the ramp later.
 */
function parseStreak(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = Math.max(0, Math.floor(num(raw.days, 0)));
  if (days < 1) return null;
  const show = Math.min(days, Math.max(1, Math.floor(num(raw.show, days))));
  const gift = Math.max(0, Math.floor(num(raw.gift, 0)));
  const next = Math.max(gift, Math.floor(num(raw.next, gift)));
  return {
    days,
    show,
    plus: raw.plus === true || days > show,
    best: Math.max(days, Math.floor(num(raw.best, days))),
    gift,
    next,
    claimed: raw.claimed === true,
  };
}

function parseBoard(m) {
  const list = Array.isArray(m?.quests) ? m.quests
    : Array.isArray(m?.dailies) ? m.dailies
      : Array.isArray(m) ? m : [];
  const quests = list.map(parseQuest).filter(Boolean).slice(0, 3);
  const allDone = quests.length > 0 && quests.every((q) => q.done);
  const b = m?.bonus && typeof m.bonus === 'object' ? m.bonus : null;
  const bonus = {
    reward: Math.max(0, Math.floor(num(b?.reward ?? b?.coins ?? m?.bonusReward, 50))),
    done: b?.done === true || b?.complete === true || allDone,
    claimable: b?.claimable === true && b?.claimed !== true,
    claimed: b?.claimed === true || (allDone && b?.claimable !== true),
  };
  // resetIn (seconds) beats our own clock maths; dayT is the fallback
  const resetIn = num(m?.resetIn ?? m?.resetsIn, NaN);
  let resetAt = board.resetAt;
  if (Number.isFinite(resetIn) && resetIn >= 0) {
    resetAt = Date.now() + resetIn * 1000;
    serverReset = true;
  }
  // a frame that carries no streak block (an older server) leaves the last one
  // standing rather than blinking the chip out from under the player
  const streak = parseStreak(m?.streak) || board.streak || null;
  return { quests, bonus, streak, resetAt, loaded: true };
}

/**
 * The cove clock says how far through the day we are; dawn is the rollover.
 * This is the FALLBACK: the board frame's own `resetIn` is the server's answer
 * and is more authoritative, so a clock frame only moves the countdown when it
 * disagrees by more than a broadcast interval. (Before that guard the 10s clock
 * quietly overwrote the server's number twice a minute.)
 */
function resetFromClock(m) {
  if (serverReset) return; // the sky's 40-minute day is not the quest day
  const dayMs = num(m?.dayMs, NaN);
  if (Number.isFinite(dayMs) && dayMs > 1000) COVE_DAY_MS = dayMs;
  const dayT = num(m?.dayT, NaN);
  if (!Number.isFinite(dayT)) return;
  const left = ((1 - (dayT % 1)) % 1) * COVE_DAY_MS;
  const guess = Date.now() + left;
  if (!board.resetAt || Math.abs(guess - board.resetAt) > 15000) board.resetAt = guess;
}

function countdown() {
  if (!board.resetAt) return 'New jobs at dawn';
  const ms = board.resetAt - Date.now();
  if (ms <= 0) return 'New jobs any moment';
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (hrs >= 1) return `New jobs in ${hrs}h ${String(mins).padStart(2, '0')}m`;
  if (mins >= 1) return `New jobs in ${mins}m ${String(secs).padStart(2, '0')}s`;
  return `New jobs in ${secs}s`;
}

/** One persistent subscription so the cache stays warm between opens. */
function listen(game) {
  if (listening || !game?.events) return;
  listening = true;
  game.events.on('quests', (m) => { board = parseBoard(m); });
  game.events.on('quest-done', (m) => {
    const id = str(m?.id);
    if (!id) return;
    for (const q of board.quests) {
      if (q.id !== id) continue;
      q.progress = q.target;
      q.done = true;
      if (m?.claimable !== true) q.claimed = true;
    }
    if (board.quests.length && board.quests.every((q) => q.done) && board.bonus) {
      board.bonus.done = true;
    }
  });
  game.events.on('clock', resetFromClock);
}

// ---------------------------------------------------------------------------

let openInstance = null;

/** Open (or, if it is already up, close) the Quest Board. */
export function openQuests(game) {
  if (typeof document === 'undefined' || !game) return;
  if (openInstance) { openInstance.close(); return; }
  ensureStyles();
  listen(game);

  const guest = !game.state?.registered;

  const root = elm('div', 'qb-overlay');
  root.innerHTML = `
    <div class="qb-card" role="dialog" aria-modal="true" aria-label="Quest board" tabindex="-1">
      <button class="hud-btn qb-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="qb-head">
        <h2>Quest Board</h2>
        <div class="qb-sub">Three jobs pinned up every day. Do them in any order.</div>
        <div class="qb-timer"></div>
      </div>
      <div class="qb-streak" hidden>
        <div class="qb-streak-ico"></div>
        <div class="qb-streak-txt">
          <div class="qb-streak-top">
            <span class="qb-streak-days"></span>
            <span class="qb-streak-best"></span>
          </div>
          <div class="qb-streak-sub"></div>
          <div class="qb-pips"></div>
        </div>
      </div>
      <div class="qb-list"></div>
      <div class="qb-bonus" hidden>
        <div class="qb-bonus-ico"></div>
        <div class="qb-bonus-txt">
          <div class="qb-bonus-name"></div>
          <div class="qb-bonus-sub"></div>
        </div>
        <div class="qb-q-side"></div>
      </div>
      <div class="qb-foot">Every job finished also ticks your stamp track.</div>
    </div>`;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.qb-card');
  const listEl = q('.qb-list');
  const timerEl = q('.qb-timer');
  const streakEl = q('.qb-streak');
  const bonusEl = q('.qb-bonus');
  const footEl = q('.qb-foot');

  const claiming = new Set();

  function questRow(quest, i) {
    // a guest sees the day's jobs, never anyone's progress: a green "done" row
    // would be claiming something about them that is not true
    const row = elm('div', `qb-q${quest.done && !guest ? ' is-done' : ''}${guest ? ' is-locked' : ''}`);
    row.style.setProperty('--i', String(i));

    const ico = elm('div', 'qb-q-ico');
    const c = document.createElement('canvas');
    // the cove draws its little awards one way; a daily borrows the same hand
    paintStampCanvas(c, stampById(quest.id), !guest, 46);
    ico.appendChild(c);
    if (quest.done && !guest) ico.appendChild(elm('span', 'qb-q-tick', '✓'));
    row.appendChild(ico);

    const body = elm('div', 'qb-q-body');
    body.appendChild(elm('div', 'qb-q-name', quest.name));
    if (quest.desc) body.appendChild(elm('div', 'qb-q-desc', quest.desc));
    const bar = elm('div', 'qb-bar');
    const fill = elm('i');
    const pct = guest ? 0 : Math.round((quest.progress / quest.target) * 100);
    // set after layout so the width animates in rather than appearing full
    requestAnimationFrame(() => { fill.style.width = `${pct}%`; });
    bar.append(fill, elm('b', null, guest ? 'Locked' : `${quest.progress} / ${quest.target}`));
    body.appendChild(bar);
    row.appendChild(body);

    const side = elm('div', 'qb-q-side');
    const reward = elm('div', 'qb-reward');
    reward.appendChild(elm('span', 'qb-coin'));
    reward.appendChild(elm('span', null, `+${quest.reward}`));
    side.appendChild(reward);
    if (!guest) {
      if (quest.claimable) side.appendChild(claimButton(quest.id));
      else if (quest.claimed) side.appendChild(elm('div', 'qb-claimed', 'Paid'));
    }
    row.appendChild(side);
    row.title = quest.done
      ? `${quest.name} : done, ${quest.reward} coins`
      : `${quest.name} : ${quest.progress} of ${quest.target}`;
    return row;
  }

  function claimButton(id) {
    const b = elm('button', 'qb-btn', claiming.has(id) ? 'Claiming' : 'Claim');
    b.type = 'button';
    b.disabled = claiming.has(id) || !game.net?.connected;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      claiming.add(id);
      game.audio?.play?.('coin');
      game.net?.send?.({ t: 'quest-claim', id });
      render();
      setTimeout(() => { claiming.delete(id); render(); }, 1200);
    });
    return b;
  }

  function emptyState() {
    const wrap = elm('div', 'qb-empty');
    if (!game.net?.connected) {
      wrap.appendChild(elm('h3', null, 'The board is out of reach'));
      wrap.appendChild(elm('p', null,
        'The cove will reconnect on its own, and today\'s jobs will be waiting when it does.'));
    } else if (!board.loaded) {
      wrap.appendChild(elm('h3', null, 'Reading the board...'));
      wrap.appendChild(elm('p', null, 'Somebody is still pinning today\'s jobs up.'));
    } else {
      wrap.appendChild(elm('h3', null, 'Nothing pinned up yet'));
      wrap.appendChild(elm('p', null,
        'Fresh jobs go up at dawn. Go and get into some trouble in the meantime.'));
    }
    return wrap;
  }

  /**
   * The login streak chip: how long you have been dropping in, what today's
   * hello gift was worth, and what tomorrow's would be. A guest has no streak
   * and gets no chip (the sign-up card below already makes that offer once).
   */
  function renderStreak() {
    const s = guest ? null : board.streak;
    if (!s) { streakEl.hidden = true; return; }
    streakEl.hidden = false;

    const ico = streakEl.querySelector('.qb-streak-ico');
    ico.textContent = '';
    const c = document.createElement('canvas');
    // a new day over the cove, drawn by the same hand as the stamps
    paintStampCanvas(c, { glyph: 'sun', hue: 0xf2b64a }, true, 40);
    ico.appendChild(c);

    streakEl.querySelector('.qb-streak-days').textContent = s.days === 1
      ? 'Day one'
      : `${s.days} days in a row`;
    streakEl.querySelector('.qb-streak-best').textContent = s.best > s.days ? `best ${s.best}` : '';

    // Every sentence here is good news. The gift is paid on the day's first
    // hello, so the usual reading is the first line. Each part is skipped
    // rather than printed empty, so a server that sends half a block says half
    // a thing instead of offering nobody nothing.
    const bits = [];
    if (s.gift > 0) {
      bits.push(s.claimed
        ? `Today's hello gift of ${s.gift} coins is already in your purse.`
        : `Today's hello gift is ${s.gift} coins.`);
    }
    if (s.next > s.gift) bits.push(`Tomorrow's is ${s.next}.`);
    else if (s.gift > 0) bits.push('That is the top of the ladder, and it stays there.');
    if (!bits.length) bits.push('Thank you for keeping the cove company.');
    streakEl.querySelector('.qb-streak-sub').textContent = bits.join(' ');

    // One filled pip per day of the ladder climbed, then either a hollow pip for
    // the rung above or a "+N" for the days past the top of it.
    const pips = streakEl.querySelector('.qb-pips');
    pips.textContent = '';
    for (let i = 0; i < s.show; i++) pips.appendChild(elm('span', 'qb-pip'));
    if (s.plus) pips.appendChild(elm('span', 'qb-pip-more', `+${s.days - s.show}`));
    else if (s.next > s.gift) pips.appendChild(elm('span', 'qb-pip next'));
  }

  function renderBonus() {
    const b = board.bonus;
    if (!b || !board.quests.length) { bonusEl.hidden = true; return; }
    bonusEl.hidden = false;
    const doneN = board.quests.filter((x) => x.done).length;
    bonusEl.classList.toggle('is-done', !guest && b.done);

    const ico = bonusEl.querySelector('.qb-bonus-ico');
    ico.textContent = '';
    const c = document.createElement('canvas');
    paintStampCanvas(c, { glyph: 'party', hue: 0xe8657a }, !guest && b.done, 40);
    ico.appendChild(c);

    bonusEl.querySelector('.qb-bonus-name').textContent = 'All three in a day';
    bonusEl.querySelector('.qb-bonus-sub').textContent = guest
      ? 'Clear the board and the cove throws in a bonus on top.'
      : b.done
        ? 'Board cleared. Take the rest of the day off.'
        : `${doneN} of ${board.quests.length} done. Clear the board for the bonus.`;

    const side = bonusEl.querySelector('.qb-q-side');
    side.textContent = '';
    const reward = elm('div', 'qb-reward');
    reward.appendChild(elm('span', 'qb-coin'));
    reward.appendChild(elm('span', null, `+${b.reward}`));
    side.appendChild(reward);
    if (!guest && b.claimable) side.appendChild(claimButton('bonus'));
    else if (!guest && b.done && b.claimed) side.appendChild(elm('div', 'qb-claimed', 'Paid'));
  }

  function render() {
    listEl.textContent = '';
    renderStreak();
    if (!board.quests.length) listEl.appendChild(emptyState());
    else board.quests.forEach((quest, i) => listEl.appendChild(questRow(quest, i)));
    renderBonus();

    if (guest && !root.querySelector('.qb-guest')) {
      const g = elm('div', 'qb-guest');
      g.appendChild(elm('h3', null, 'Sign up to take on quests'));
      g.appendChild(elm('p', null,
        'Guests can watch the board, but jobs and their coins need somewhere to live. '
        + 'An account is free, takes a nickname, and keeps your stamps forever.'));
      bonusEl.after(g);
      footEl.textContent = 'Everything else in the cove is open to guests. This bit just is not.';
    }
  }

  function tickTimer() { timerEl.textContent = countdown(); }

  render();
  tickTimer();
  const timer = setInterval(tickTimer, 1000);

  const unsubs = [
    // the module-level listener updates the cache; these repaint the open board
    game.events.on('quests', () => { render(); tickTimer(); }),
    game.events.on('quest-done', (m) => {
      render();
      const hit = board.quests.find((x) => x.id === str(m?.id));
      if (hit) game.audio?.play?.('levelup');
    }),
    game.events.on('clock', () => tickTimer()),
    game.events.on('net', () => render()),
  ];

  game.net?.send?.({ t: 'quests' });

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    clearInterval(timer);
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    game.audio?.play?.('click');
  }

  function onBackdrop(e) { if (e.target === root) close(); }
  function onKey(e) {
    e.stopPropagation(); // world hotkeys stay out of the overlay
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.qb-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('open');

  openInstance = { close };
}
