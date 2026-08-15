/**
 * The Cove Courier: the cove's weekly paper, as the player reads it.
 * Wave 14B (N-31; docs/research/liveops.md section 5, docs/NEXT-AAA.md "Wave 14").
 *
 * PRINT DAY IS FRIDAY and never moves. The whole value of a weekly paper is
 * that Friday means something, so nothing in this file ever computes a print
 * day of its own: server/courier.js sends `nextPrintAt` and we render it, and
 * without one we say "every Friday" and stop talking. A client countdown that
 * disagrees with the press is how a paper stops being believed.
 *
 * Public API is exactly:
 *   openCourier(game)        open the reader (a second call closes it, like the
 *                            shop, the menu and the quest board)
 *   mountCourierButton(game) the Map-adjacent HUD button; idempotent, returns
 *                            an unmount
 *   onCourierUnread(fn)      subscribe to the unread flag (the newsstand's gold
 *                            marker rides this); returns an unsubscribe
 *   courierUnread()          the flag, right now
 * plus parseIssue / parseIndex, which are pure so the wire tolerance can be
 * tested without a DOM (test/courier-ui.test.js).
 *
 * ------------------------------------------------------------------ WIRE ---
 * server/courier.js (agent 14A) owns the shapes. This is what it ships:
 *
 *   out  {t:'courier'}   read the current issue (rate limited server side)
 *   in   {t:'courier', week, issueN, headline, printedAt, nextPrintAt,
 *                      articles:[{k, h, body}]}
 *   in   {t:'courier-new', ...}   optional print-time broadcast
 *
 * Article kinds (`k`) the server produces today: `editorial`, `charm`, `play`,
 * `lap`, `whatson`, `filler:<id>`. Three of them are placed rather than simply
 * stacked: `editorial` becomes the lead (drop cap, spanning both columns),
 * `charm` becomes the boxed charm-hunt teaser, and `whatson` becomes the
 * next-events gutter. Every other kind, known or invented later, flows into the
 * two-column body in the order the server sent it. An unknown kind is a normal
 * article, never a dropped one.
 *
 * Read loosely on purpose, so a server that grows richer shapes needs no client
 * change: a title is `h`|`title`|`name`|`headline`, a body is `body`|`text`,
 * and an article may additionally carry `lines:[string]` (bulleted) or
 * `items:[{name,value,note}]` (a little scores table). Back issues are not
 * served today; if an `issues:[...]` index ever arrives the dropdown appears on
 * its own, and until then it stays hidden.
 *
 * The charm teaser and the gutter fall back to the LIVE `charm` and `events`
 * frames (both already pushed on hello, wave 13), so those two corners of the
 * paper are right even before the first issue has ever printed.
 *
 * UNREAD: there is no per-account server flag, so the newest issue key is
 * compared against localStorage. Opening the issue clears it. If the server
 * ever sends `unread`, that wins.
 *
 * Nothing here touches the DOM, the network or storage at import time.
 */

const STYLE_ID = 'capy-courier-styles';
const READ_KEY = 'capy.courier.read';
const BTN_ID = 'btn-courier';

const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';

const CSS = `
.cc-overlay {
  position: absolute; inset: 0; padding: 16px; display: flex;
  align-items: center; justify-content: center; z-index: 44;
  background: rgba(20, 32, 44, 0.55); backdrop-filter: blur(7px) saturate(1.15);
  animation: cc-fade 0.18s ease;
}
.cc-overlay.is-closing { opacity: 0; transition: opacity 0.15s ease; pointer-events: none; }

/* The sheet: cream stock, a crease down the middle and one across the fold,
   and a shadow that says this was folded in half and left on the counter. */
.cc-sheet {
  position: relative; width: min(880px, 96vw); max-height: 93vh; overflow: auto;
  padding: 22px clamp(16px, 3.4vw, 34px) 18px;
  color: #3a2c1a; border-radius: 8px;
  background:
    linear-gradient(90deg, rgba(120, 92, 48, 0.11) 0%, rgba(120, 92, 48, 0) 2.4%,
      rgba(120, 92, 48, 0) 49%, rgba(120, 92, 48, 0.13) 50%,
      rgba(120, 92, 48, 0) 51%, rgba(120, 92, 48, 0) 97.6%, rgba(120, 92, 48, 0.11) 100%),
    repeating-linear-gradient(0deg, rgba(140, 110, 60, 0.035) 0 2px, rgba(0, 0, 0, 0) 2px 5px),
    linear-gradient(180deg, #fffaef 0%, #fdf3dd 100%);
  box-shadow: var(--shadow), 0 0 0 3px rgba(255, 255, 255, 0.75), inset 0 0 44px rgba(150, 118, 62, 0.11);
  animation: cc-unfold 0.42s cubic-bezier(0.18, 1.12, 0.4, 1);
  transform-origin: 50% 30%;
}
.cc-sheet:focus { outline: none; }
.cc-x { position: absolute; top: 13px; right: 13px; z-index: 3; }

/* ---- masthead ---- */
.cc-mast { text-align: center; padding: 2px 44px 0; }
.cc-mast h1 {
  font-family: ${SERIF}; font-weight: 700; font-size: clamp(30px, 5.6vw, 52px);
  letter-spacing: 0.015em; line-height: 1; margin: 0; color: #4a3417;
}
.cc-motto {
  font-size: 11px; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase;
  color: #a8875a; margin-top: 7px;
}
.cc-rule { border-top: 3px double #b8946a; margin: 10px 0 8px; }
.cc-meta {
  display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; justify-content: space-between;
  font-size: 11.5px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  color: #8d7146; padding-bottom: 8px; border-bottom: 1px solid rgba(150, 118, 62, 0.35);
}
.cc-issue { color: var(--accent); }
.cc-back { display: flex; align-items: center; gap: 6px; }
.cc-back[hidden] { display: none; }
.cc-sel {
  font-family: var(--font); font-weight: 800; font-size: 11.5px; color: #6b5432;
  background: rgba(255, 255, 255, 0.7); border: 2px solid rgba(150, 118, 62, 0.4);
  border-radius: 999px; padding: 4px 9px; cursor: pointer; text-transform: none; letter-spacing: 0;
}
.cc-sel:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }

/* ---- body: a wide reading column plus a narrow "what's on" gutter ---- */
.cc-grid { display: grid; grid-template-columns: 1fr 214px; gap: 20px; margin-top: 14px; }
.cc-cols { columns: 2; column-gap: 24px; column-rule: 1px solid rgba(150, 118, 62, 0.3); }
.cc-art { break-inside: avoid; margin: 0 0 15px; }
.cc-art h3 {
  font-family: ${SERIF}; font-weight: 700; font-size: 17.5px; line-height: 1.16;
  margin: 0 0 5px; color: #43301a;
}
.cc-art.is-lead { column-span: all; margin-bottom: 16px; }
.cc-art.is-lead h3 { font-size: clamp(21px, 3.2vw, 28px); text-align: center; }
.cc-kicker {
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 3px;
}
.cc-art.is-lead .cc-kicker { text-align: center; }
.cc-copy {
  font-family: ${SERIF}; font-size: 13.5px; line-height: 1.52; margin: 0 0 7px;
  text-align: justify; hyphens: auto; color: #443422;
}
.cc-art > .cc-copy:first-of-type::first-letter {
  float: left; font-family: ${SERIF}; font-weight: 700; font-size: 3.05em;
  line-height: 0.82; padding: 4px 7px 0 0; color: var(--accent);
}
.cc-art.is-lead > .cc-copy:first-of-type::first-letter { color: #8d5a20; }
.cc-list { list-style: none; margin: 2px 0 0; padding: 0; }
.cc-list li {
  font-family: ${SERIF}; font-size: 13px; line-height: 1.42; padding: 2px 0 2px 13px;
  position: relative; color: #443422;
}
.cc-list li::before {
  content: '\\2022'; position: absolute; left: 2px; top: 1px; color: var(--gold); font-weight: 900;
}
.cc-tab { width: 100%; border-collapse: collapse; margin-top: 3px; }
.cc-tab td {
  font-family: ${SERIF}; font-size: 13px; padding: 3px 0;
  border-bottom: 1px dotted rgba(150, 118, 62, 0.45); color: #443422;
}
.cc-tab td.cc-who { font-weight: 700; }
.cc-tab td.cc-val { text-align: right; font-weight: 700; color: #8d5a20; white-space: nowrap; }
.cc-note { font-size: 11px; color: #927a51; font-weight: 700; }

/* ---- the charm-hunt teaser ---- */
.cc-aside {
  break-inside: avoid; margin: 0 0 15px; padding: 11px 13px; border-radius: 10px;
  border: 2px dashed rgba(196, 146, 44, 0.65); background: rgba(242, 182, 74, 0.13);
}
.cc-aside h4 {
  font-size: 10px; font-weight: 900; letter-spacing: 0.16em; text-transform: uppercase;
  color: #9a6b12; margin: 0 0 4px;
}
.cc-charm-name { font-family: ${SERIF}; font-weight: 700; font-size: 16px; margin-bottom: 3px; }
.cc-aside p { font-family: ${SERIF}; font-size: 13px; line-height: 1.45; margin: 0 0 5px; color: #4a3a1e; }
.cc-aside p:last-child { margin-bottom: 0; }
.cc-found { margin-top: 6px; font-size: 11px; font-weight: 800; color: #9a6b12; }

/* ---- the gutter ---- */
.cc-side { align-self: start; }
.cc-box {
  padding: 11px 12px; border-radius: 10px; margin-bottom: 12px;
  background: rgba(255, 255, 255, 0.62); box-shadow: inset 0 0 0 2px rgba(150, 118, 62, 0.26);
}
.cc-box h4 {
  font-family: ${SERIF}; font-size: 15px; margin: 0 0 7px; color: #43301a;
  border-bottom: 1px solid rgba(150, 118, 62, 0.35); padding-bottom: 4px;
}
.cc-box p { font-family: ${SERIF}; font-size: 12.5px; line-height: 1.48; margin: 0 0 6px; color: #4a3a1e; }
.cc-box p:last-child { margin-bottom: 0; }
.cc-ev { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; }
.cc-ev + .cc-ev { border-top: 1px dotted rgba(150, 118, 62, 0.4); }
.cc-ev-when {
  flex: none; width: 54px; font-size: 10px; font-weight: 900; letter-spacing: 0.05em;
  text-transform: uppercase; color: #a8875a;
}
.cc-ev-name { font-family: ${SERIF}; font-size: 13px; font-weight: 700; line-height: 1.25; }
.cc-ev-blurb { font-size: 11px; font-weight: 600; color: #8d7146; line-height: 1.3; }
.cc-ev.is-live .cc-ev-when { color: var(--accent); }
.cc-quiet { font-family: ${SERIF}; font-size: 12.5px; color: #8d7146; line-height: 1.45; }

/* ---- states + footer ---- */
.cc-empty { text-align: center; padding: 26px 14px 30px; }
.cc-empty h3 { font-family: ${SERIF}; font-size: 20px; margin-bottom: 7px; color: #43301a; }
.cc-empty p { font-family: ${SERIF}; font-size: 13.5px; line-height: 1.55; color: #7d6742; max-width: 44ch; margin: 0 auto; }
.cc-foot {
  margin-top: 12px; padding-top: 8px; border-top: 3px double #b8946a; text-align: center;
  font-size: 10.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; color: #a8875a;
}

/* ---- the HUD button (sits beside Map) ---- */
#${BTN_ID} { position: relative; }
#${BTN_ID} .cc-dot {
  position: absolute; top: -3px; right: -3px; width: 11px; height: 11px; border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #fff3bd 0%, var(--gold) 60%, #c98c1d 100%);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
  animation: cc-dot 2.4s ease-in-out infinite;
}
#${BTN_ID}.cc-float { position: absolute; right: 14px; bottom: 74px; z-index: 20; }

@keyframes cc-fade { from { opacity: 0; } }
@keyframes cc-unfold { from { opacity: 0; transform: translateY(14px) scaleY(0.72) rotateX(24deg); } }
@keyframes cc-dot { 50% { transform: scale(1.22); } }
@media (max-width: 720px) {
  .cc-grid { grid-template-columns: 1fr; }
  .cc-cols { columns: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .cc-sheet { animation: none; }
  #${BTN_ID} .cc-dot { animation: none; }
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

// ---------------------------------------------------------------- parsing --

const num = (v, fb = NaN) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const clip = (v, n) => { const s = str(v); return s ? s.slice(0, n) : null; };

function firstStr(o, keys, max = 400) {
  if (!o) return null;
  for (const k of keys) { const s = clip(o[k], max); if (s) return s; }
  return null;
}

function strList(v, max = 12) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => clip(x, 240)).filter(Boolean).slice(0, max);
}

/** A scoreboard row: a name, a number, and what it was for. */
function parseItem(raw) {
  if (typeof raw === 'string') { const s = clip(raw, 120); return s ? { name: s, value: null, note: null } : null; }
  if (Array.isArray(raw)) {
    const name = clip(raw[0], 60);
    return name ? { name, value: clip(String(raw[1] ?? ''), 40), note: null } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = firstStr(raw, ['name', 'who', 'player', 'label', 'title'], 60);
  if (!name) return null;
  const rawVal = raw.value ?? raw.score ?? raw.n ?? raw.count ?? raw.coins;
  const value = rawVal === undefined || rawVal === null ? null
    : clip(typeof rawVal === 'number' ? String(Math.round(rawVal)) : String(rawVal), 40);
  return { name, value, note: firstStr(raw, ['note', 'game', 'desc', 'blurb'], 60) };
}

/** One article. `k`/`h`/`body` is the shipped shape; the rest is tolerance. */
function parseArticle(raw, i) {
  if (!raw || typeof raw !== 'object') return null;
  const title = firstStr(raw, ['h', 'title', 'name', 'head', 'headline'], 90);
  const body = firstStr(raw, ['body', 'text', 'copy', 'para'], 1400);
  const lines = strList(raw.lines || raw.bullets || raw.rows);
  const itemsRaw = Array.isArray(raw.items) ? raw.items
    : Array.isArray(raw.entries) ? raw.entries
      : Array.isArray(raw.top) ? raw.top
        : Array.isArray(raw.table) ? raw.table : [];
  const items = itemsRaw.map(parseItem).filter(Boolean).slice(0, 12);
  if (!title && !body && !lines.length && !items.length) return null;
  const k = firstStr(raw, ['k', 'id', 'kind'], 40) || `a${i}`;
  return {
    k,
    // `filler:sunset` is one family; the placement rules only care about the
    // part before the colon, and nothing downstream should have to know that
    kind: k.split(':')[0],
    kicker: firstStr(raw, ['kicker', 'tag', 'section'], 30),
    title: title || 'From the cove',
    body,
    lines,
    items,
  };
}

function parseCharm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hint = firstStr(raw, ['hint', 'rumour', 'rumor', 'clue', 'desc', 'body'], 400);
  const name = firstStr(raw, ['charmName', 'name', 'charm'], 60);
  if (!hint && !name) return null;
  const found = num(raw.found ?? raw.finds ?? raw.n, NaN);
  return { name, hint, found: Number.isFinite(found) ? Math.max(0, Math.floor(found)) : null };
}

/** "when" may be a stamp, a seconds-away number, or a word the server chose. */
function parseWhen(raw, now) {
  const when = firstStr(raw, ['when', 'day', 'label'], 24);
  if (when) return when;
  const at = num(raw.at ?? raw.startsAt ?? raw.startAt, NaN);
  if (Number.isFinite(at) && at > 1e11) return dayLabel(at);
  const inS = num(raw.in ?? raw.startsIn, NaN);
  if (Number.isFinite(inS)) return dayLabel((Number.isFinite(now) ? now : Date.now()) + inS * 1000);
  return '';
}

function parseNext(list, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = firstStr(raw, ['name', 'title', 'id'], 48);
    if (!name) continue;
    out.push({ name, when: parseWhen(raw, now), blurb: firstStr(raw, ['blurb', 'desc', 'note'], 90) });
  }
  return out;
}

/**
 * One issue, read as loosely as it can be read and still mean something.
 * Returns null for anything that is not an issue at all, so a stray frame can
 * never blank a paper that is already on screen.
 */
export function parseIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const listRaw = Array.isArray(raw.articles) ? raw.articles
    : Array.isArray(raw.sections) ? raw.sections
      : Array.isArray(raw.parts) ? raw.parts : [];
  const all = listRaw.map(parseArticle).filter(Boolean).slice(0, 16);

  // three kinds are PLACED rather than stacked; everything else flows
  const pick = (kind) => {
    const i = all.findIndex((a) => a.kind === kind);
    return i < 0 ? null : all.splice(i, 1)[0];
  };
  const lead = pick('editorial');
  const charmArt = pick('charm');
  const whatson = pick('whatson');

  // the {editorial:{headline, body}} shape, for a server that grows one
  const ed = raw.editorial && typeof raw.editorial === 'object' ? raw.editorial : null;
  const edLead = ed && (firstStr(ed, ['headline', 'title', 'h'], 120) || firstStr(ed, ['body', 'text'], 900))
    ? {
      k: 'editorial', kind: 'editorial', kicker: null,
      title: firstStr(ed, ['headline', 'title', 'h'], 120) || 'From the desk',
      body: firstStr(ed, ['body', 'text'], 900), lines: [], items: [],
    } : null;

  const n = num(raw.issueN ?? raw.n ?? raw.issue ?? raw.number, NaN);
  const week = firstStr(raw, ['week', 'weekId', 'id'], 32);
  const at = num(raw.printedAt ?? raw.at ?? raw.ts, NaN);
  const nextAt = num(raw.nextPrintAt ?? raw.nextAt, NaN);

  const issueN = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  const id = week || (issueN ? `i${issueN}` : null);
  if (!id && !all.length && !lead && !edLead) return null;

  return {
    id: id || 'latest',
    n: issueN,
    at: Number.isFinite(at) ? at : null,
    nextAt: Number.isFinite(nextAt) ? nextAt : null,
    date: firstStr(raw, ['date'], 40),
    headline: firstStr(raw, ['headline'], 140),
    lead: lead || edLead,
    articles: all,
    charm: charmArt ? { ...parseCharm(charmArt) || {}, title: charmArt.title, body: charmArt.body } : null,
    whatson,
    next: parseNext(raw.next || raw.upcoming || raw.calendar, at),
  };
}

/** The back-issue dropdown's contents, newest first. Empty today: the server
 *  keeps one issue in memory. It costs nothing to be ready for more. */
export function parseIndex(m) {
  const list = Array.isArray(m?.issues) ? m.issues
    : Array.isArray(m?.index) ? m.index
      : Array.isArray(m?.back) ? m.back : [];
  const out = [];
  for (const raw of list.slice(0, 120)) {
    if (typeof raw === 'string') { out.push({ id: raw, n: null, at: null, headline: null }); continue; }
    if (!raw || typeof raw !== 'object') continue;
    const id = firstStr(raw, ['week', 'id', 'weekId'], 32);
    if (!id) continue;
    const n = num(raw.issueN ?? raw.n ?? raw.issue, NaN);
    const at = num(raw.printedAt ?? raw.at, NaN);
    out.push({
      id,
      n: Number.isFinite(n) ? Math.floor(n) : null,
      at: Number.isFinite(at) ? at : null,
      headline: firstStr(raw, ['headline', 'title'], 70),
    });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0) || (b.n || 0) - (a.n || 0));
  return out;
}

// ------------------------------------------------------------- formatting --

// The paper is a COVE artifact: its dates are the cove's own (America/New_York,
// where the press runs), or a reader east of UTC sees "Saturday" under a
// masthead that says printed every Friday.
const COVE_TZ = { timeZone: 'America/New_York' };

function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined,
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...COVE_TZ });
  } catch { return ''; }
}

function fmtShort(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...COVE_TZ });
  } catch { return ''; }
}

function dayLabel(ms) {
  try {
    const d = new Date(ms);
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} `
      + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

function issueLabel(row) {
  const bits = [];
  if (row.n) bits.push(`Issue ${row.n}`);
  if (row.at) { const d = fmtShort(row.at); if (d) bits.push(d); }
  if (!bits.length) bits.push(row.id);
  return bits.join(' - ');
}

// ------------------------------------------------------------------ state --

let paper = {
  issue: null,        // the issue on screen (parsed)
  latestId: null,     // the newest issue key the server has mentioned
  latestN: null,      // and its number, so a back issue cannot outrank it
  issues: [],         // the back-issue index, when there is one
  serverUnread: null, // the server's own flag, if it ever sends one
  loaded: false,
};
let live = { events: null, charm: null };
let listening = false;
const unreadSubs = new Set();

function readStore() {
  try { return localStorage.getItem(READ_KEY); } catch { return null; }
}
function writeStore(id) {
  try { localStorage.setItem(READ_KEY, id); } catch { /* private mode: the dot comes back, and that is all */ }
}

/** Is there an issue this capy has not opened? */
export function courierUnread() {
  if (typeof paper.serverUnread === 'boolean') return paper.serverUnread;
  return !!(paper.latestId && readStore() !== paper.latestId);
}

/** Subscribe to the unread flag (the newsstand marker, the HUD dot). */
export function onCourierUnread(fn) {
  if (typeof fn !== 'function') return () => {};
  unreadSubs.add(fn);
  try { fn(courierUnread()); } catch { /* a subscriber's problem, not ours */ }
  return () => unreadSubs.delete(fn);
}

function announceUnread() {
  const on = courierUnread();
  for (const fn of unreadSubs) { try { fn(on); } catch { /* keep going */ } }
}

function markRead(id) {
  if (!id) return;
  const already = readStore() === id;
  if (!already) writeStore(id);
  if (paper.serverUnread === true && paper.latestId === id) paper.serverUnread = false;
  else if (already) return;
  announceUnread();
}

/** One persistent subscription so a re-open paints instantly. */
function listen(game) {
  if (listening || !game?.events) return;
  listening = true;
  game.events.on('courier', (m) => {
    if (!m || typeof m !== 'object') return;
    paper.loaded = true;
    const issue = parseIssue(m.issue && typeof m.issue === 'object' ? m.issue : m);
    if (issue) {
      paper.issue = issue;
      // Only a NEWER issue may claim the badge. Today the server keeps one
      // issue and this is always true; the day back issues arrive, reading
      // issue 3 must not mark issue 9 as read.
      const newer = paper.latestN === null || issue.n === null || issue.n >= paper.latestN;
      if (newer) { paper.latestId = issue.id; paper.latestN = issue.n; }
    }
    const idx = parseIndex(m);
    if (idx.length) paper.issues = idx;
    if (typeof m.unread === 'boolean') paper.serverUnread = m.unread;
    announceUnread();
  });
  // the print-time broadcast: the frame carries the news, not the issue, so ask
  game.events.on('courier-new', (m) => {
    const id = str(m?.week) || str(m?.id);
    if (id) paper.latestId = id;
    if (typeof m?.unread !== 'boolean') paper.serverUnread = null;
    request(game);
    announceUnread();
  });
  // wave 13's two live feeds keep the teaser and the gutter right even before
  // the first issue exists
  game.events.on('charm', (m) => { live.charm = m; });
  game.events.on('events', (m) => { live.events = m; });
}

function request(game) {
  game?.net?.send?.({ t: 'courier' });
}

// ------------------------------------------------------------ the reader --

let openInstance = null;

/** Open (or, if it is already up, close) the Courier. */
export function openCourier(game) {
  if (typeof document === 'undefined' || !game) return;
  if (openInstance) { openInstance.close(); return; }
  ensureStyles();
  listen(game);

  const root = elm('div', 'cc-overlay');
  root.innerHTML = `
    <div class="cc-sheet" role="dialog" aria-modal="true" aria-label="The Cove Courier" tabindex="-1">
      <button class="hud-btn cc-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="cc-mast">
        <h1>The Cove Courier</h1>
        <div class="cc-motto">printed every friday in sunny plaza</div>
      </div>
      <div class="cc-rule"></div>
      <div class="cc-meta">
        <span class="cc-issue"></span>
        <span class="cc-date"></span>
        <label class="cc-back" hidden>Back issues
          <select class="cc-sel"></select>
        </label>
      </div>
      <div class="cc-grid">
        <div class="cc-cols"></div>
        <aside class="cc-side"></aside>
      </div>
      <div class="cc-foot"></div>
    </div>`;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const sheet = q('.cc-sheet');
  const colsEl = q('.cc-cols');
  const sideEl = q('.cc-side');
  const issueEl = q('.cc-issue');
  const dateEl = q('.cc-date');
  const backEl = q('.cc-back');
  const selEl = q('.cc-sel');
  const footEl = q('.cc-foot');

  // ---- pieces --------------------------------------------------------------

  function paragraphs(into, body, max = 4) {
    if (!body) return;
    // the server sends one prose block; a long one breaks on blank lines, and
    // a very long one on sentence groups, so a column never becomes a wall
    const parts = body.includes('\n\n') ? body.split(/\n{2,}/) : [body];
    for (const part of parts.slice(0, max)) {
      const p = elm('p', 'cc-copy', part.trim());
      if (p.textContent) into.appendChild(p);
    }
  }

  function article(a, lead) {
    const art = elm('article', `cc-art${lead ? ' is-lead' : ''}`);
    if (a.kicker) art.appendChild(elm('div', 'cc-kicker', a.kicker));
    else if (lead) art.appendChild(elm('div', 'cc-kicker', 'From the desk'));
    art.appendChild(elm('h3', null, a.title));
    paragraphs(art, a.body);
    if (a.lines.length) {
      const ul = elm('ul', 'cc-list');
      for (const line of a.lines) ul.appendChild(elm('li', null, line));
      art.appendChild(ul);
    }
    if (a.items.length) {
      const tab = elm('table', 'cc-tab');
      for (const it of a.items) {
        const tr = elm('tr');
        const who = elm('td', 'cc-who');
        who.appendChild(document.createTextNode(it.name));
        if (it.note) {
          who.appendChild(document.createTextNode(' '));
          who.appendChild(elm('span', 'cc-note', it.note));
        }
        tr.appendChild(who);
        tr.appendChild(elm('td', 'cc-val', it.value || ''));
        tab.appendChild(tr);
      }
      art.appendChild(tab);
    }
    return art;
  }

  /** The charm hunt, boxed: the issue's own article if it has one, the live
   *  rumour line if it does not, and an invitation if neither has spoken. */
  function charmAside() {
    const fromIssue = paper.issue?.charm;
    const fromLive = parseCharm(live.charm);
    if (!fromIssue && !fromLive) return null;
    const box = elm('aside', 'cc-aside');
    box.appendChild(elm('h4', null, 'The charm hunt'));
    if (fromIssue) {
      if (fromIssue.title) box.appendChild(elm('div', 'cc-charm-name', fromIssue.title));
      paragraphs(box, fromIssue.body, 2);
      const p = box.querySelector('p');
      if (p) p.className = '';
    } else {
      if (fromLive.name) box.appendChild(elm('div', 'cc-charm-name', fromLive.name));
      box.appendChild(elm('p', null, fromLive.hint
        || 'Somewhere in the cove, something small is hiding. It moves every week.'));
      if (fromLive.found !== null) {
        box.appendChild(elm('div', 'cc-found', fromLive.found === 0
          ? 'Nobody has found it yet this week.'
          : fromLive.found === 1 ? 'One capy has found it this week.'
            : `${fromLive.found} capys have found it this week.`));
      }
    }
    return box;
  }

  /** The gutter: what is on next. The issue's own column first, then the live
   *  events bus, then a quiet line, which is a perfectly good thing to print. */
  function nextColumn() {
    const box = elm('div', 'cc-box');
    const ws = paper.issue?.whatson;
    box.appendChild(elm('h4', null, ws?.title || 'What is on'));
    if (ws?.body) { paragraphs(box, ws.body, 3); return box; }

    let rows = paper.issue?.next || [];
    if (!rows.length && live.events) {
      const now = num(live.events.now, Date.now());
      const act = Array.isArray(live.events.active) ? live.events.active
        : live.events.active ? [live.events.active] : [];
      rows = parseNext(act, now).map((r) => ({ ...r, live: true, when: r.when || 'now' }));
      const nx = live.events.next;
      rows = rows.concat(parseNext(Array.isArray(nx) ? nx : nx ? [nx] : [], now));
    }
    if (!rows.length) {
      box.appendChild(elm('p', 'cc-quiet',
        'A quiet week ahead, which is its own kind of good news. '
        + 'The fountain is warm and the shuffleboard is free.'));
      return box;
    }
    for (const r of rows.slice(0, 6)) {
      const row = elm('div', `cc-ev${r.live ? ' is-live' : ''}`);
      row.appendChild(elm('div', 'cc-ev-when', r.when || ''));
      const body = elm('div');
      body.appendChild(elm('div', 'cc-ev-name', r.name));
      if (r.blurb) body.appendChild(elm('div', 'cc-ev-blurb', r.blurb));
      row.appendChild(body);
      box.appendChild(row);
    }
    return box;
  }

  function emptyState() {
    const wrap = elm('div', 'cc-empty');
    if (!game.net?.connected) {
      wrap.appendChild(elm('h3', null, 'The paper has not been delivered'));
      wrap.appendChild(elm('p', null,
        'The cove will reconnect on its own, and the Courier will be waiting on the counter when it does.'));
    } else if (!paper.loaded) {
      wrap.appendChild(elm('h3', null, 'Still on the press'));
      wrap.appendChild(elm('p', null, 'Somebody is folding it right now. One moment.'));
    } else {
      wrap.appendChild(elm('h3', null, 'No issue yet'));
      wrap.appendChild(elm('p', null,
        'The Cove Courier prints on Friday. Until then the stand is just a stand, '
        + 'and whatever you get up to this week is what it will be about.'));
    }
    return wrap;
  }

  // ---- render --------------------------------------------------------------

  function render() {
    const iss = paper.issue;
    issueEl.textContent = iss?.n ? `Issue ${iss.n}` : iss ? 'This week' : '';
    dateEl.textContent = iss ? (iss.date || (iss.at ? fmtDate(iss.at) : '')) : '';

    colsEl.textContent = '';
    sideEl.textContent = '';

    if (!iss) {
      colsEl.appendChild(emptyState());
    } else {
      // the lead: the editorial when there is one, otherwise the issue's own
      // headline standing on its own above the columns
      if (iss.lead) colsEl.appendChild(article(iss.lead, true));
      else if (iss.headline) {
        colsEl.appendChild(article({
          kicker: 'This week', title: iss.headline, body: null, lines: [], items: [],
        }, true));
      }
      for (const a of iss.articles) colsEl.appendChild(article(a, false));
      const teaser = charmAside();
      if (teaser) colsEl.appendChild(teaser);
      if (!iss.articles.length && !iss.lead && !iss.headline) colsEl.appendChild(emptyState());
    }

    sideEl.appendChild(nextColumn());

    const idx = paper.issues;
    if (idx.length > 1) {
      backEl.hidden = false;
      selEl.textContent = '';
      for (const row of idx) {
        const opt = elm('option', null, issueLabel(row));
        opt.value = row.id;
        if (iss && row.id === iss.id) opt.selected = true;
        selEl.appendChild(opt);
      }
    } else backEl.hidden = true;

    const nextAt = iss?.nextAt;
    footEl.textContent = nextAt && nextAt > Date.now()
      ? `Next issue ${fmtShort(nextAt)}`
      : 'The Cove Courier prints every Friday';

    // opening the NEWEST issue is what clears the badge; a back issue does not
    if (iss?.id && (!paper.latestId || iss.id === paper.latestId)) markRead(iss.id);
  }

  render();
  request(game);

  const unsubs = [
    game.events.on('courier', () => render()),
    game.events.on('courier-new', () => render()),
    game.events.on('charm', () => render()),
    game.events.on('events', () => render()),
    game.events.on('net', () => render()),
  ];

  selEl.addEventListener('change', () => {
    if (!selEl.value) return;
    game.audio?.play?.('click');
    // back issues are a server capability, not a client one: ask, and if the
    // server has nothing to say the current issue simply stays up
    game.net?.send?.({ t: 'courier', week: selEl.value });
  });

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
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
  q('.cc-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  sheet.focus({ preventScroll: true });
  game.audio?.play?.('open');

  openInstance = { close };
}

// ------------------------------------------------------------- HUD button --

let buttonMounted = null;

/**
 * The Map-adjacent button. It slots itself in next to Map by DOM insertion, so
 * src/ui/hud.js does not have to know this feature exists; if that bar is
 * missing it falls back to a small floating button. Idempotent: the newsstand
 * calls it on every plaza build.
 */
export function mountCourierButton(game) {
  if (typeof document === 'undefined' || !game) return () => {};
  if (buttonMounted) return buttonMounted;
  ensureStyles();
  listen(game);

  const btn = elm('button', 'hud-btn wide');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.title = 'The Cove Courier';
  btn.appendChild(document.createTextNode('📰 Courier'));
  const dot = elm('span', 'cc-dot');
  dot.hidden = true;
  btn.appendChild(dot);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    game.audio?.play?.('click');
    openCourier(game);
  });

  const map = document.getElementById('btn-map');
  if (map?.parentElement) map.parentElement.insertBefore(btn, map);
  else { btn.classList.add('cc-float'); mountPoint().appendChild(btn); }

  const off = onCourierUnread((on) => {
    dot.hidden = !on;
    btn.setAttribute('aria-label', on ? 'The Cove Courier, new issue' : 'The Cove Courier');
  });
  // one read so the badge is honest on the first paint of a fresh session
  if (!paper.loaded) request(game);

  const unmount = () => {
    if (buttonMounted !== unmount) return;
    buttonMounted = null;
    off();
    btn.remove();
  };
  buttonMounted = unmount;
  return unmount;
}
