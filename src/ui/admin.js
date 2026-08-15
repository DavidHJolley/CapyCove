/**
 * COVE WATCH: the staff menu (wave 12E, Ctrl+Shift+A).
 *
 * Wave 9 shipped a one-screen mod panel: the room's player list and a row of
 * buttons. This is the same idea grown a spine — four tabs, because staff work
 * is four different jobs and cramming them into one scroll made the panel a
 * place you visited to do exactly one thing:
 *
 *   ONLINE   who is here right now, and every lever you can pull on them
 *   REPORTS  the queue of things players asked you to look at
 *   STAFF    who your colleagues are, and (admins only) how one is made
 *   CHAT     the staff channel, so two mods working the same raid can say so
 *
 * Everything with a time axis that ISN'T the report queue — the audit trail,
 * offline account search, appeals — is still the season-one web panel's job
 * (docs/research/accounts-admin.md section 4). This is the thing you open while
 * you are standing next to the problem.
 *
 * Public API, all of it:
 *   toggleAdmin(game)      open, or close if it is already up (the hotkey's verb)
 *   openAdmin(game)        open; returns null if this player holds no capability
 *   closeAdmin()           close if open
 *   isAdminOpen()          is it up?
 *   installStaffChat(game) start buffering the staff channel without opening
 *                          anything (see THE STAFF CHANNEL AND THE LAZY LOAD)
 *
 * ACCESS. This module is lazy-imported by src/main.js ONLY when
 * `game.state.caps` is non-empty, so an ordinary player never fetches a byte of
 * it. That is a cost decision, not a security one: every button here sends an
 * `a-*` frame and server/admin.js's performOp re-authorises all of them against
 * the record, so a player who loads this chunk by hand gets a panel whose every
 * action is answered with silence and an audit line. The role-grant tab is the
 * loudest example: it paints exactly the buttons the RULES below allow, and the
 * server re-derives every one of those rules before it writes anything.
 *
 * WIRE. Out, exactly the frames in server/admin.js's contract:
 *   {t:'a-who', room?, q?}                   {t:'a-inspect', uid|name|id}
 *   {t:'a-mute', uid|name|id, mins, reason}  {t:'a-unmute', ...}
 *   {t:'a-ban',  uid|name|id, mins, reason}  {t:'a-unban',  ...}
 *   {t:'a-kick', uid|name|id, reason?}
 *   {t:'a-tp', uid|name|id}                  move ME to them
 *   {t:'a-announce', text}
 *   {t:'a-reports', state?, limit?}          the queue        cap 'inspect'
 *   {t:'a-resolve', id, state, note?}        move one along   cap 'mute'
 *   {t:'a-staff'}                            the roster       cap 'staffchat'
 *   {t:'a-schat', text}                      staff only       cap 'staffchat'
 *   {t:'a-role', uid|name, role}             grant / revoke   cap 'role'
 * In, three frames and no more:
 *   {t:'a-ok',  op, msg, ...data}    {t:'a-err', op, msg, code}
 *   {t:'a-schat', from, role, text, at}      the staff channel, server->staff
 * re-emitted onto game.events under their own names by src/net/client.js's
 * re-emit switch (orchestrator-owned; both names are already in its case list).
 * `op` is the full frame name it answers, e.g. 'a-mute'.
 *
 * `tp-here` (move THEM to me) has no frame: server/admin.js's OPS table carries
 * no `summon`, and this panel may not invent one. The button is written and
 * gated on a `summon` capability that is never granted, so it does not paint —
 * and the day that op lands server-side, the button appears with no client
 * change at all. That is the whole reason the cap list is read off the wire
 * instead of being a matrix copied into this file.
 *
 * The capability behind each tab is READ OFF THE WIRE, never decided here: the
 * `caps` array on the welcome profile is the same array server/admin.js's OPS
 * table gates on, so a tab that would be refused is a tab that is not drawn, and
 * a cap added over there lights up its button here with no client redeploy.
 * There is one exception and it is the server's own answer: a-staff carries
 * `canRole` and `roles`, and both override the local guess when they arrive.
 *
 * There is a fourth INBOUND frame this panel does not handle and must not:
 * `{t:'a-role', role, caps, by, at}`, which the server sends to the SUBJECT of a
 * role change. That one belongs to game.applyModeration (src/core/game.js:217
 * says so in as many words) — it rewrites `game.state.caps` for the whole
 * client, which is how a freshly-made mod is a mod without relogging. When it
 * lands, our `moderation` listener notices the caps changed under us and shuts
 * the panel rather than leave a screen whose every gate was computed from the
 * role we no longer have.
 *
 * DELIBERATELY NOT DUPLICATED HERE: the per-role duration ceilings (a mod may
 * mute for 24h, an admin for a year), and the exact wording of a role refusal.
 * The chips are all offered and the server refuses what it will not do, in a
 * sentence it has already written ("Your role may mute for at most 24 hours"),
 * which is shown verbatim — as a toast, and for role changes inline next to the
 * button that asked. A number copied out of the server is a number that goes
 * stale in silence, and a refusal paraphrased by the client is a support ticket.
 *
 * THE ROLE RULES, painted here and enforced there (server/admin.js opRole):
 *   - only an ADMIN may grant or revoke anything;
 *   - an admin may set anyone to player or mod, and may promote to admin;
 *   - you may never change your OWN role, at any rank, in either direction;
 *   - the last remaining admin may not be demoted or removed by anyone: an
 *     adminless island cannot make another admin, and that is unrecoverable
 *     without a redeploy of COVE_ADMIN.
 * A role change bumps the target's tokenV server-side, so stale sessions cannot
 * keep old powers, and reaches their live session, so a new mod is a mod
 * without relogging.
 *
 * THE STAFF CHANNEL AND THE LAZY LOAD. The panel is a chunk that does not exist
 * until someone presses the hotkey, so AS SHIPPED a staff message that arrives
 * before the first open is MISSED — nothing is listening yet, by construction.
 * From the first open onward a module-level bus (`bus` below) keeps listening
 * for the life of the page even while the panel is shut, holds the last
 * SCHAT_KEEP lines in memory only (never localStorage: staff chat is not the
 * sort of thing to leave lying about on a shared machine), and floats a small
 * unread chip so a closed panel still says "somebody is talking to you".
 *
 * That gap is closeable without spending a byte of an ordinary player's bundle,
 * and `installStaffChat(game)` is the seam for it: one caps-gated line in
 * src/main.js imports this chunk for staff only and starts the bus at login. It
 * is deliberately NOT a listener in main.js itself, which would put a
 * staff-shaped import in every player's bundle.
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
const REPORTS_POLL_MS = 20_000; // the queue moves in minutes, not seconds
const ANNOUNCE_MAX = 200; // the server clamps to its own ANNOUNCE_MAX_LEN too
const SCHAT_MAX_LEN = 200;
const SCHAT_KEEP = 100; // lines held in memory; the server owns the real history

/** The report queue's states, in the order server/reports.js moves through. */
const REPORT_STATES = [
  ['Open', 'open'],
  ['Working', 'reviewed'],
  ['Done', 'actioned'],
  ['Dismissed', 'dismissed'],
];

const CSS = `
.adm-panel {
  position: absolute; top: 64px; right: 14px; width: min(414px, calc(100vw - 28px));
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
}
.adm-head h2 { font-size: 17px; margin: 0; color: var(--accent); letter-spacing: 0.02em; }
.adm-role {
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.09em; text-transform: uppercase;
  color: #fff; background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  padding: 3px 9px; border-radius: 999px;
}
.adm-x { margin-left: auto; }

.adm-tabs {
  display: flex; gap: 3px; padding: 0 12px 9px;
  border-bottom: 2px solid rgba(45, 36, 23, 0.07);
}
.adm-tab {
  position: relative; flex: 1; border: 0; cursor: pointer; font-family: var(--font);
  font-weight: 900; font-size: 10.5px; letter-spacing: 0.07em; text-transform: uppercase;
  padding: 7px 4px; border-radius: 12px; background: transparent; color: #a3906c;
  transition: background 0.16s ease, color 0.16s ease;
}
.adm-tab:hover { background: rgba(45, 36, 23, 0.05); }
.adm-tab.on { background: #fff; color: var(--ink); box-shadow: 0 2px 0 rgba(45, 36, 23, 0.09); }
.adm-tab[hidden] { display: none; }
.adm-tab .adm-dot {
  position: absolute; top: 2px; right: 4px; min-width: 15px; height: 15px; padding: 0 3px;
  border-radius: 999px; background: var(--accent); color: #fff;
  font-size: 9px; line-height: 15px; letter-spacing: 0;
}

.adm-body { overflow: auto; padding: 10px 14px 4px; flex: 1; min-height: 90px; }
.adm-body::-webkit-scrollbar { width: 9px; }
.adm-body::-webkit-scrollbar-thumb { background: rgba(45, 36, 23, 0.18); border-radius: 999px; }

.adm-tools { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.adm-tools[hidden] { display: none; }
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
.adm-count[hidden] { display: none; }
.adm-list { display: flex; flex-direction: column; gap: 6px; }

.adm-row {
  background: var(--card); border-radius: 15px; padding: 8px 10px;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: adm-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 26ms);
}
.adm-row.is-self { box-shadow: 0 3px 0 rgba(79, 179, 232, 0.3), inset 0 0 0 2px rgba(79, 179, 232, 0.25); }
.adm-row.is-muted { background: #fff7ea; }
.adm-row.is-banned { background: #fdeef0; }
.adm-row.is-open { box-shadow: 0 3px 0 rgba(232, 101, 122, 0.22), inset 0 0 0 2px rgba(232, 101, 122, 0.18); }
.adm-row.is-done { opacity: 0.66; }
.adm-row.is-off { opacity: 0.72; }
@keyframes adm-pop { from { opacity: 0; transform: translateY(6px); } }

.adm-r1 { display: flex; align-items: center; gap: 6px; }
.adm-name { font-weight: 900; font-size: 13px; overflow-wrap: anywhere; }
.adm-where { font-size: 11px; font-weight: 700; color: #a3906c; margin-left: auto; flex: none; }
.adm-chip {
  font-size: 8.5px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; flex: none;
}
.adm-chip.role { background: rgba(232, 101, 122, 0.16); color: #b34156; }
.adm-chip.role.admin { background: rgba(232, 101, 122, 0.28); color: #a32f47; }
.adm-chip.guest { background: rgba(45, 36, 23, 0.08); color: #8a7a5a; }
.adm-chip.mute { background: rgba(242, 182, 74, 0.3); color: #8a6a1f; }
.adm-chip.ban { background: rgba(232, 101, 122, 0.28); color: #a32f47; }
.adm-chip.kind { background: rgba(79, 179, 232, 0.2); color: #2f7ba6; }
.adm-chip.state { background: rgba(45, 36, 23, 0.08); color: #8a7a5a; }
.adm-chip.state.open { background: rgba(232, 101, 122, 0.2); color: #a32f47; }
.adm-chip.on { background: rgba(126, 200, 122, 0.28); color: #2f7a3d; }
.adm-r2 { display: flex; align-items: center; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
.adm-meta { font-size: 10.5px; font-weight: 700; color: #b6a688; margin-right: auto; }
.adm-said {
  font-size: 11.5px; font-weight: 700; color: #7c6d51; margin-top: 5px; line-height: 1.4;
  overflow-wrap: anywhere;
}

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
.adm-b.good { background: linear-gradient(180deg, #a9e2a3 0%, #79c774 100%); color: #23461f; box-shadow: 0 2px 0 rgba(48, 110, 44, 0.3); }

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

/* the role-grant confirm: the loudest thing in the panel, on purpose */
.adm-confirm {
  margin: 8px 0 2px; padding: 11px 13px; border-radius: 15px;
  background: rgba(242, 182, 74, 0.16); box-shadow: inset 0 0 0 2px rgba(196, 142, 30, 0.32);
  animation: adm-pop 0.26s var(--spring);
}
.adm-confirm[hidden] { display: none; }
.adm-confirm h4 { font-size: 13px; margin: 0 0 5px; }
.adm-confirm p { font-size: 11.5px; font-weight: 700; line-height: 1.5; color: #6f5f42; margin: 0 0 8px; }

.adm-grant {
  margin-bottom: 9px; padding: 10px 12px; border-radius: 15px; background: var(--card);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08);
}
.adm-grant[hidden] { display: none; }
.adm-grant h4 { font-size: 12.5px; margin: 0 0 6px; }
.adm-grant-row { display: flex; gap: 6px; align-items: center; }
.adm-sel {
  border: 0; border-radius: 999px; padding: 7px 10px; flex: none;
  background: #fff; font-family: var(--font); font-weight: 800; font-size: 11.5px; color: var(--ink);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08); cursor: pointer;
}
.adm-err {
  margin-top: 7px; font-size: 11.5px; font-weight: 800; color: #a32f47; line-height: 1.4;
  overflow-wrap: anywhere;
}
.adm-err[hidden] { display: none; }

/* the staff channel */
.adm-chatlog {
  display: flex; flex-direction: column; gap: 5px; overflow: auto;
  max-height: min(46vh, 340px); padding-right: 3px;
}
.adm-chatlog[hidden] { display: none; }
.adm-chatlog::-webkit-scrollbar { width: 9px; }
.adm-chatlog::-webkit-scrollbar-thumb { background: rgba(45, 36, 23, 0.18); border-radius: 999px; }
.adm-msg {
  background: var(--card); border-radius: 13px; padding: 6px 10px;
  animation: adm-pop 0.24s var(--spring);
}
.adm-msg.is-me { background: #fff; box-shadow: inset 0 0 0 2px rgba(79, 179, 232, 0.22); }
.adm-msg-h { display: flex; align-items: center; gap: 5px; margin-bottom: 2px; }
.adm-msg-h b { font-size: 11.5px; }
.adm-msg-t { font-size: 10px; font-weight: 700; color: #b6a688; margin-left: auto; }
.adm-msg p { margin: 0; font-size: 12px; font-weight: 700; line-height: 1.42; overflow-wrap: anywhere; }

.adm-note { text-align: center; padding: 16px 10px; }
.adm-note h3 { font-size: 14px; margin-bottom: 4px; }
.adm-note p { font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.45; }

.adm-foot { padding: 9px 14px 12px; border-top: 2px solid rgba(45, 36, 23, 0.07); }
.adm-field { display: flex; gap: 6px; margin-bottom: 6px; }
.adm-field[hidden] { display: none; }
.adm-field:last-of-type { margin-bottom: 0; }
.adm-field .adm-q { font-size: 11.5px; }
.adm-field .adm-b { flex: none; }
.adm-tip { font-size: 10px; font-weight: 700; color: #b6a688; text-align: center; margin-top: 8px; line-height: 1.4; }

/* the unread chip: the panel's doorbell while it is shut */
.adm-bell {
  position: absolute; top: 64px; right: 14px; z-index: 55; pointer-events: auto;
  display: flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
  font-family: var(--font); font-weight: 900; font-size: 11.5px; color: #fff;
  padding: 7px 12px; border-radius: 999px;
  background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  box-shadow: 0 3px 0 rgba(150, 55, 72, 0.35), var(--shadow);
  animation: adm-pop 0.3s var(--spring);
}
.adm-bell:hover { scale: 1.05; }
.adm-bell:active { scale: 0.95; }
.adm-bell b {
  min-width: 17px; height: 17px; line-height: 17px; padding: 0 4px; border-radius: 999px;
  background: #fff; color: var(--accent); font-size: 10.5px;
}

@media (prefers-reduced-motion: reduce) {
  .adm-panel, .adm-row, .adm-drawer, .adm-inspect, .adm-confirm, .adm-msg, .adm-bell { animation: none; }
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

/** "just now" / "12m ago" — a report's age is the first thing you triage on. */
function ago(at) {
  const d = Date.now() - (Number(at) || 0);
  if (!Number.isFinite(d) || d < 45_000) return 'just now';
  return `${shortMs(d)} ago`;
}

const stamp = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : 'never');

/**
 * "an ordinary player" / "a mod" / "an admin". Built from the role STRING the
 * server sent, not from a table of the three we know about, so a fourth rung on
 * server/admin.js's ladder reads as English here without a client change.
 */
const roleWord = (role) => (role === 'player'
  ? 'an ordinary player'
  : `${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`);

const clock = (ms) => {
  const d = new Date(Number(ms) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** uid first, then name, then the live connection id: server resolution order. */
function targetOf(s) {
  if (!s) return {};
  if (s.uid) return { uid: s.uid };
  if (s.name && s.registered !== false) return { name: s.name };
  if (s.id) return { id: s.id };
  return s.name ? { name: s.name } : {};
}

// ---------------------------------------------------------------------------
// the local warp (server/admin.js opTp: "the actor's own client warps itself")
// ---------------------------------------------------------------------------

/**
 * `a-tp` moves the actor's record on the server, but our own position is
 * client-owned — the next 10Hz move frame would drag us straight back. So the
 * answer's `{room, at}` is applied here, and a cross-room warp waits for the
 * room build (it happens behind the engine's 220ms iris fade) before placing
 * the capy, or the spawn point would overwrite us.
 *
 * `a-summon` needs none of this: it moves SOMEONE ELSE, whose client does its
 * own half of the same dance when the answer reaches them.
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
// the staff channel bus: alive from the first open, for the life of the page
// ---------------------------------------------------------------------------

/**
 * The panel is a chunk that comes and goes; the staff channel is a conversation
 * that does not. This holds it: the last SCHAT_KEEP lines, the unread count, and
 * the little chip that says so while the panel is shut.
 *
 * It is installed on the FIRST openAdmin and never torn down. Messages sent
 * before that first open are gone — see the header for why that trade is the
 * right one. Nothing here is written to disk or storage.
 */
let bus = null;

function ensureBus(game) {
  if (bus) return bus;
  bus = {
    game,
    log: [],
    unread: 0,
    bell: null,
    onMessage: null, // the open panel's chat tab, when it is the visible one
    onUnread: null,  // the open panel's tab strip, so its pip keeps up
  };
  // deliberately never unsubscribed: the bus outlives every panel instance
  game.events.on('a-schat', (m) => acceptSchat(m));
  return bus;
}

/** Normalise one incoming staff line. The server owns `from`/`role`/`at`. */
function acceptSchat(m) {
  if (!bus || !m || typeof m.text !== 'string' || !m.text) return;
  const line = {
    from: typeof m.from === 'string' ? m.from : '???',
    role: RANK[m.role] !== undefined ? m.role : 'mod',
    text: m.text.slice(0, SCHAT_MAX_LEN * 2),
    at: Number.isFinite(m.at) ? m.at : Date.now(),
  };
  bus.log.push(line);
  if (bus.log.length > SCHAT_KEEP) bus.log.splice(0, bus.log.length - SCHAT_KEEP);
  if (bus.onMessage) { bus.onMessage(line); return; } // the reader is looking at it
  bus.unread++;
  bus.game.audio?.play?.('pop');
  bus.onUnread?.();
  paintBell();
}

/** Show, hide or re-count the doorbell. Only ever visible with the panel shut. */
function paintBell() {
  if (!bus || typeof document === 'undefined') return;
  const want = !openInstance && bus.unread > 0;
  if (!want) {
    bus.bell?.remove();
    bus.bell = null;
    return;
  }
  if (!bus.bell) {
    ensureStyles();
    const b = elm('button', 'adm-bell');
    b.type = 'button';
    b.title = 'Unread staff chat (Ctrl+Shift+A)';
    b.append('Staff', elm('b', null, '0'));
    b.addEventListener('click', () => {
      const panel = openAdmin(bus.game);
      // openAdmin says no when the caps went away between the message arriving
      // and the click (a demotion mid-conversation). Clear the count rather than
      // leave a chip that opens nothing.
      if (!panel) { bus.unread = 0; paintBell(); return; }
      panel.showChat();
    });
    mountPoint().appendChild(b);
    bus.bell = b;
  }
  bus.bell.lastElementChild.textContent = bus.unread > 99 ? '99+' : String(bus.unread);
}

// ---------------------------------------------------------------------------

let openInstance = null;

/**
 * Start buffering the staff channel WITHOUT opening anything.
 *
 * Exported for one caller that does not exist yet: a single caps-gated line in
 * src/main.js (orchestrator-owned) of the form
 *
 *   if (game.state.caps?.length) import('./ui/admin.js').then((m) => m.installStaffChat(game));
 *
 * With that line a staff member's chunk loads once, quietly, on the profile that
 * granted them a capability, and the channel is buffered from that moment; an
 * ordinary player still never fetches a byte, because the guard is the same
 * `caps` array the hotkey already tests. Without it the module is only imported
 * on the first Ctrl+Shift+A and lines sent before that are missed, which is the
 * behaviour that ships today. Calling this twice is free.
 */
export function installStaffChat(game) {
  if (!game?.events) return null;
  return ensureBus(game);
}

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
  ensureBus(game);
  const can = (c) => caps.includes(c);
  const capsKey = [...caps].join(',');
  const myRank = rankOf(game.state?.role);
  const myName = String(game.state?.name || '');
  const isMe = (name) => !!name && name.toLowerCase() === myName.toLowerCase();

  // ---- state ---------------------------------------------------------------
  let tab = 'online';        // 'online' | 'reports' | 'staff' | 'chat'
  let scope = 'room';        // 'room' | 'island'
  let query = '';
  let rows = [];             // the a-who player list
  let total = 0;
  let loaded = false;
  let note = 'Reading the room...';
  let drawer = null;         // {op:'mute'|'ban'|'kick'|'resolve', ...}
  let account = null;        // the a-inspect readback
  let lastWho = 0;
  let whoTimer = 0;          // trailing send when the 2s budget said no
  let qTimer = 0;            // search debounce

  let reports = [];
  let repCounts = null;
  let repState = 'open';
  let repLoaded = false;
  let repNote = 'Nothing is waiting.';

  let repRetry = 0;          // one-shot retry after a rate-limit refusal

  let staff = [];
  let staffLoaded = false;
  let staffRoles = ['player', 'mod', 'admin']; // replaced by a-staff's own list
  let grantName = '';
  let grantRole = 'mod';
  let confirmAsk = null;     // {name, uid, role, from, words}
  let roleErr = '';          // the server's own refusal, verbatim

  // The cap each tab needs, taken from server/admin.js's OPS table rather than
  // invented here: reports read with 'inspect', move with 'mute', the roster and
  // the channel are both 'staffchat', and only 'role' grants anything.
  const canReports = can('inspect');
  const canResolve = can('mute');
  const canStaff = can('staffchat');
  // a-staff answers with its own `canRole`, which is the server's opinion; until
  // it does, the local cap is a good enough guess to paint with.
  let canRole = can('role') && myRank >= RANK.admin;

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
    <div class="adm-tabs" role="tablist">
      <button class="adm-tab on" type="button" role="tab" data-tab="online">Online</button>
      <button class="adm-tab" type="button" role="tab" data-tab="reports">Reports</button>
      <button class="adm-tab" type="button" role="tab" data-tab="staff">Staff</button>
      <button class="adm-tab" type="button" role="tab" data-tab="chat">Chat</button>
    </div>
    <div class="adm-body">
      <div class="adm-tools adm-tools-online">
        <div class="adm-seg">
          <button type="button" data-scope="room" class="on">This room</button>
          <button type="button" data-scope="island">Island</button>
        </div>
        <input class="adm-q adm-search" type="text" placeholder="Find a name" maxlength="16"
               autocomplete="off" spellcheck="false" aria-label="Find a name">
        <button class="adm-mini adm-refresh" type="button" title="Refresh" aria-label="Refresh">&#8635;</button>
      </div>
      <div class="adm-tools adm-tools-reports" hidden>
        <div class="adm-seg adm-repseg"></div>
        <button class="adm-mini adm-refresh2" type="button" title="Refresh" aria-label="Refresh">&#8635;</button>
      </div>
      <div class="adm-count"></div>
      <div class="adm-drawer" hidden></div>
      <div class="adm-inspect" hidden></div>
      <div class="adm-confirm" hidden></div>
      <div class="adm-grant" hidden></div>
      <div class="adm-chatlog" hidden></div>
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
      <div class="adm-field adm-schat-field" hidden>
        <input class="adm-q adm-schat" type="text" placeholder="Say it to staff only" maxlength="${SCHAT_MAX_LEN}"
               autocomplete="off" aria-label="Staff message">
        <button class="adm-b good adm-schat-go" type="button">Send</button>
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
  const confirmEl = q('.adm-confirm');
  const grantEl = q('.adm-grant');
  const chatEl = q('.adm-chatlog');
  const searchEl = q('.adm-search');
  const tipEl = q('.adm-tip');
  const onlineTools = q('.adm-tools-online');
  const reportTools = q('.adm-tools-reports');

  q('.adm-role').textContent = game.state?.role || 'player';
  q('.adm-tab[data-tab="online"]').hidden = !can('who');
  q('.adm-tab[data-tab="reports"]').hidden = !canReports;
  q('.adm-tab[data-tab="staff"]').hidden = !canStaff;
  q('.adm-tab[data-tab="chat"]').hidden = !canStaff;
  // whatever this role can actually see, opened on the leftmost of them
  if (!can('who')) tab = canReports ? 'reports' : (canStaff ? 'staff' : 'online');

  for (const [label, state] of REPORT_STATES) {
    const b = elm('button', state === repState ? 'on' : '', label);
    b.type = 'button';
    b.dataset.state = state;
    b.addEventListener('click', () => {
      repState = state;
      for (const o of q('.adm-repseg').children) o.classList.toggle('on', o === b);
      repLoaded = false;
      render();
      requestReports();
    });
    q('.adm-repseg').appendChild(b);
  }

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
    if (!can('who')) return;
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

  function requestReports() {
    if (!canReports) return;
    if (repRetry) { clearTimeout(repRetry); repRetry = 0; }
    send({ t: 'a-reports', state: repState, limit: 40 });
  }

  function requestStaff() {
    if (!canStaff) return;
    send({ t: 'a-staff' });
  }

  /** Every mutating op goes out through here so the refresh is never forgotten. */
  function op(t, extra = {}) {
    if (!send({ t, ...extra })) return;
    game.audio?.play?.('click');
    setTimeout(() => { // let the record settle, then re-read whatever is showing
      if (tab === 'online') requestWho(true);
      else if (tab === 'reports') requestReports();
      else if (tab === 'staff') requestStaff();
    }, 450);
  }

  // ---- rendering: shared pieces --------------------------------------------

  function selfId() { return game.net?.selfId || null; }

  function roleChip(role) {
    const c = elm('span', `adm-chip role${role === 'admin' ? ' admin' : ''}`, role);
    return c;
  }

  function button(label, cls, fn) {
    const b = elm('button', `adm-b${cls ? ` ${cls}` : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  // ---- rendering: ONLINE ---------------------------------------------------

  function rowActions(r) {
    const wrap = elm('div', 'adm-r2');
    const idle = r.idleMs > 20_000 ? `idle ${shortMs(r.idleMs)}` : '';
    wrap.appendChild(elm('span', 'adm-meta',
      [`${r.coins | 0} coins`, idle].filter(Boolean).join('  ·  ')));

    const self = r.id && r.id === selfId();
    // the server refuses an equal or higher rank with 'rank', and refuses
    // self with 'self'; do not paint a button that is going to be turned down
    const reachable = !self && rankOf(r.role) < myRank;

    const add = (label, cls, fn, on = true) => { if (on) wrap.appendChild(button(label, cls, fn)); };

    add('Inspect', '', () => op('a-inspect', targetOf(r)), can('inspect'));
    add('Warp to', 'calm', () => op('a-tp', targetOf(r)), can('tp') && !self);
    // tp-here. server/admin.js's OPS does not carry `summon` yet, so this cap is
    // never granted and the button never paints; the day the op lands the panel
    // grows the button with no redeploy, which is the whole point of reading the
    // cap list off the wire instead of hard-coding the matrix.
    add('Bring here', 'calm', () => op('a-summon', targetOf(r)), can('summon') && !self);
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
    const self = r.id && r.id === selfId();
    const cls = ['adm-row'];
    if (self) cls.push('is-self');
    if (r.banned) cls.push('is-banned');
    else if (r.muted > 0) cls.push('is-muted');
    const el = elm('div', cls.join(' '));
    el.style.setProperty('--i', String(i));

    const r1 = elm('div', 'adm-r1');
    r1.appendChild(elm('span', 'adm-name', r.name || '???'));
    if (r.role && r.role !== 'player') r1.appendChild(roleChip(r.role));
    if (!r.registered) r1.appendChild(elm('span', 'adm-chip guest', 'guest'));
    if (r.muted > 0) r1.appendChild(elm('span', 'adm-chip mute', `muted ${shortMs(r.muted)}`));
    if (r.banned) r1.appendChild(elm('span', 'adm-chip ban', 'banned'));
    r1.appendChild(elm('span', 'adm-where', self ? 'you' : (r.room || '-')));
    el.appendChild(r1);
    el.appendChild(rowActions(r));
    return el;
  }

  function renderOnline() {
    const here = scope === 'room' ? (game.roomId || 'nowhere') : 'the island';
    countEl.hidden = false;
    countEl.textContent = loaded
      ? `${rows.length} ${rows.length === 1 ? 'capy' : 'capys'} in ${here} · ${total} online`
      : 'Reading the cove...';
    if (rows.length) {
      rows.forEach((r, i) => listEl.appendChild(playerRow(r, i)));
      return;
    }
    showNote(loaded ? 'Nobody here' : 'Reading the cove...', loaded
      ? (query ? 'No name starts with that. Try the island, or clear the search.' : note)
      : 'Asking the server who is about.');
  }

  // ---- rendering: REPORTS --------------------------------------------------

  /** The report's target, in the shape the drawer and a-inspect want. */
  function reportSubject(r) {
    return {
      uid: r.targetUid || '',
      name: r.target || '',
      id: r.targetId || '',
      registered: !!r.targetUid,
      role: 'player', // the queue never reports a colleague to you as staff
    };
  }

  function reportRow(r, i) {
    const cls = ['adm-row'];
    if (r.state === 'open') cls.push('is-open');
    else if (r.state === 'actioned' || r.state === 'dismissed') cls.push('is-done');
    const el = elm('div', cls.join(' '));
    el.style.setProperty('--i', String(i));

    const r1 = elm('div', 'adm-r1');
    r1.appendChild(elm('span', 'adm-name', r.target || 'no target'));
    if (r.kind) r1.appendChild(elm('span', 'adm-chip kind', r.kind));
    r1.appendChild(elm('span', `adm-chip state${r.state === 'open' ? ' open' : ''}`, r.state || '?'));
    r1.appendChild(elm('span', 'adm-where', ago(r.at)));
    el.appendChild(r1);

    const ctx = [
      `${r.reason || 'no reason'}`,
      `by ${r.by || 'someone'}`,
      r.room ? `in ${r.room}` : '',
      r.lines ? `${r.lines} chat lines` : '',
      r.hasImage ? 'has a picture' : '',
      r.actor ? `handled by ${r.actor}` : '',
    ].filter(Boolean).join('  ·  ');
    el.appendChild(elm('div', 'adm-said', ctx));
    if (r.note) el.appendChild(elm('div', 'adm-said', `"${r.note}"`));

    const subject = reportSubject(r);
    const wrap = elm('div', 'adm-r2');
    const add = (label, cls2, fn, on = true) => { if (on) wrap.appendChild(button(label, cls2, fn)); };
    const hasTarget = !!(subject.uid || subject.name || subject.id);
    add('Inspect', '', () => op('a-inspect', targetOf(subject)), can('inspect') && hasTarget);
    add('Mute', 'warm', () => openDrawer('mute', subject, r), can('mute') && hasTarget && !!subject.uid);
    add('Ban', 'hot', () => openDrawer('ban', subject, r), can('ban') && hasTarget && !!subject.uid);
    if (r.state === 'open') add('Claim', 'calm', () => op('a-resolve', { id: r.id, state: 'reviewed' }), canResolve);
    if (r.state !== 'actioned' && r.state !== 'dismissed') {
      add('Resolve', 'good', () => openResolve(r), canResolve);
    }
    el.appendChild(wrap);
    return el;
  }

  function renderReports() {
    countEl.hidden = false;
    const c = repCounts;
    countEl.textContent = c
      ? `${c.open | 0} open · ${c.reviewed | 0} being worked · ${c.total | 0} all time`
      : 'Reading the queue...';
    if (reports.length) {
      reports.forEach((r, i) => listEl.appendChild(reportRow(r, i)));
      return;
    }
    showNote(repLoaded ? 'A quiet inbox' : 'Reading the queue...', repLoaded
      ? repNote
      : 'Asking the server what is waiting.');
  }

  // ---- rendering: STAFF ----------------------------------------------------

  function adminCount() {
    return staff.filter((s) => s.role === 'admin').length;
  }

  /**
   * Would the server let me set `who` to `role`? Painted from the same four
   * rules the module header lists; the server checks all four again.
   * Returns '' when it is allowed, or the reason it is not.
   */
  function roleBlock(who, role) {
    if (!canRole) return 'Only an admin can change roles.';
    if (isMe(who.name)) return 'You cannot change your own role.';
    if (who.role === role) return `Already ${roleWord(role)}.`;
    if (who.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
      return 'This is the last admin. An island with no admin can never make another.';
    }
    return '';
  }

  /** The consequence, in the words you would use out loud. */
  function roleWords(name, role, from) {
    if (role === 'admin') {
      return `${name} becomes an ADMIN. Admins hold everything you hold, including this: `
        + `they will be able to change your role, or take it away. Only another admin can undo it, `
        + `and nobody at all can remove the last admin standing.`;
    }
    if (role === 'player') {
      return `${name} goes back to being an ordinary player. Every moderation power, the report queue `
        + `and the staff channel are taken away, and their open session loses them mid-sentence. `
        + `Nothing else about the account changes: coins, hats and dens are untouched.`;
    }
    // 'mod' today, and the honest wording for any rung added to the ladder
    // later: it names the role the server sent rather than assuming there are
    // only ever three.
    return `${name} becomes a ${role.toUpperCase()}${from === 'admin' ? ', stepping down from admin' : ''}. `
      + `They will be able to mute, kick and ban players, warp about, read the report queue and `
      + `read this staff channel. Their open session gains it straight away, without relogging.`;
  }

  function askRole(who, role) {
    const why = roleBlock(who, role);
    if (why) { roleErr = why; renderConfirm(); renderGrant(); return; }
    roleErr = '';
    confirmAsk = {
      name: who.name || '',
      uid: who.uid || '',
      role,
      from: who.role || 'player',
      words: roleWords(who.name || 'They', role, who.role || 'player'),
    };
    renderConfirm();
  }

  function renderConfirm() {
    confirmEl.textContent = '';
    if (!confirmAsk) { confirmEl.hidden = true; return; }
    confirmEl.hidden = false;
    const label = confirmAsk.role === 'player'
      ? `Remove ${confirmAsk.name}'s role`
      : `Make ${confirmAsk.name} ${roleWord(confirmAsk.role)}`;
    confirmEl.appendChild(elm('h4', null, `${label}?`));
    confirmEl.appendChild(elm('p', null, confirmAsk.words));
    const btns = elm('div', 'adm-dr-btns');
    btns.appendChild(button('Cancel', '', () => { confirmAsk = null; renderConfirm(); }));
    btns.appendChild(button('Yes, do it', confirmAsk.role === 'admin' ? 'hot' : 'warm', () => {
      const body = confirmAsk.uid ? { uid: confirmAsk.uid } : { name: confirmAsk.name };
      roleErr = '';
      op('a-role', { ...body, role: confirmAsk.role });
      confirmAsk = null;
      renderConfirm();
    }));
    confirmEl.appendChild(btns);
  }

  function renderGrant() {
    grantEl.textContent = '';
    if (!canRole) { grantEl.hidden = true; return; }
    grantEl.hidden = false;
    grantEl.appendChild(elm('h4', null, 'Give someone a role'));

    const row = elm('div', 'adm-grant-row');
    const name = elm('input', 'adm-q');
    name.type = 'text';
    name.maxLength = 16;
    name.placeholder = 'Their name';
    name.autocomplete = 'off';
    name.spellcheck = false;
    name.value = grantName;
    name.setAttribute('aria-label', 'Name to give a role to');
    name.addEventListener('input', () => { grantName = name.value; });

    const sel = elm('select', 'adm-sel');
    sel.setAttribute('aria-label', 'Role');
    // built from a-staff's `roles`, never from a list copied out of the server:
    // a fourth rung on the ladder stays a one-file change over there
    for (const value of staffRoles) {
      const o = elm('option', null, value.charAt(0).toUpperCase() + value.slice(1));
      o.value = value;
      if (value === grantRole) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { grantRole = sel.value; });

    const go = button('Grant', 'warm', () => {
      const n = name.value.trim();
      if (n.length < 2) { roleErr = 'Type the name first.'; renderGrant(); return; }
      const known = staff.find((s) => s.name && s.name.toLowerCase() === n.toLowerCase());
      askRole(known || { name: n, role: 'player' }, grantRole);
      renderGrant();
    });
    row.append(name, sel, go);
    grantEl.appendChild(row);

    const err = elm('div', 'adm-err', roleErr);
    err.hidden = !roleErr;
    grantEl.appendChild(err);
  }

  function staffRow(s, i) {
    const el = elm('div', `adm-row${s.online ? '' : ' is-off'}${isMe(s.name) ? ' is-self' : ''}`);
    el.style.setProperty('--i', String(i));
    const r1 = elm('div', 'adm-r1');
    r1.appendChild(elm('span', 'adm-name', s.name || '???'));
    r1.appendChild(roleChip(s.role || 'mod'));
    if (s.online) r1.appendChild(elm('span', 'adm-chip on', 'online'));
    r1.appendChild(elm('span', 'adm-where', isMe(s.name) ? 'you' : (s.online ? (s.room || '-') : `seen ${ago(s.lastSeen)}`)));
    el.appendChild(r1);

    if (s.muted) r1.insertBefore(elm('span', 'adm-chip mute', 'muted'), r1.lastElementChild);

    if (canRole && !isMe(s.name)) {
      const wrap = elm('div', 'adm-r2');
      wrap.appendChild(elm('span', 'adm-meta', s.uid ? s.uid : ''));
      for (const role of staffRoles) {
        if (s.role === role) continue;
        const why = roleBlock(s, role);
        const b = button(role === 'player' ? 'Remove role' : `Make ${role}`,
          role === 'admin' ? 'hot' : role === 'player' ? '' : 'warm',
          () => { askRole(s, role); });
        if (why) { b.disabled = true; b.title = why; }
        wrap.appendChild(b);
      }
      el.appendChild(wrap);
    }
    return el;
  }

  function renderStaff() {
    countEl.hidden = false;
    countEl.textContent = staffLoaded
      ? `${staff.length} on the staff · ${staff.filter((s) => s.online).length} online · ${adminCount()} admin`
      : 'Reading the roster...';
    renderGrant();
    if (staff.length) {
      staff.forEach((s, i) => listEl.appendChild(staffRow(s, i)));
      return;
    }
    showNote(staffLoaded ? 'Nobody but you' : 'Reading the roster...',
      staffLoaded ? 'You are holding this island up on your own.' : 'Asking the server who else is staff.');
  }

  // ---- rendering: CHAT -----------------------------------------------------

  function msgEl(line) {
    const el = elm('div', `adm-msg${isMe(line.from) ? ' is-me' : ''}`);
    const h = elm('div', 'adm-msg-h');
    h.appendChild(elm('b', null, line.from));
    h.appendChild(roleChip(line.role));
    h.appendChild(elm('span', 'adm-msg-t', clock(line.at)));
    el.appendChild(h);
    el.appendChild(elm('p', null, line.text));
    return el;
  }

  function renderChat() {
    countEl.hidden = true;
    chatEl.hidden = false;
    chatEl.textContent = '';
    if (!bus.log.length) {
      chatEl.appendChild(elm('div', 'adm-note',
        'Quiet in here. Anything you type is seen by staff only, and never by players.'));
      return;
    }
    for (const line of bus.log) chatEl.appendChild(msgEl(line));
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  /** One arriving line while the chat tab is the visible one: append, don't rebuild. */
  function appendChat(line) {
    if (tab !== 'chat') return;
    const stuck = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
    if (bus.log.length === 1) { renderChat(); return; } // clears the empty note
    chatEl.appendChild(msgEl(line));
    while (chatEl.childElementCount > SCHAT_KEEP) chatEl.firstElementChild.remove();
    if (stuck) chatEl.scrollTop = chatEl.scrollHeight;
  }

  // ---- rendering: the drawer, the inspector, the shell ---------------------

  function showNote(head, body) {
    noteEl.hidden = false;
    noteEl.textContent = '';
    noteEl.appendChild(elm('h3', null, head));
    noteEl.appendChild(elm('p', null, body));
  }

  function openDrawer(kind, subject, report = null) {
    drawer = {
      op: kind,
      subject,
      report,
      mins: kind === 'kick' ? null : (kind === 'mute' ? 60 : 1440),
      reason: report ? `report ${report.id}: ${report.reason || ''}`.trim().slice(0, 140) : '',
    };
    account = null;
    render();
  }

  function openResolve(report) {
    drawer = { op: 'resolve', report, state: 'actioned', reason: '' };
    account = null;
    render();
  }

  function renderDrawer() {
    drawerEl.textContent = '';
    if (!drawer) { drawerEl.hidden = true; return; }
    drawerEl.hidden = false;
    if (drawer.op === 'resolve') { renderResolveDrawer(); return; }

    const kind = drawer.op;
    const subject = drawer.subject;
    const verb = kind === 'mute' ? 'Mute' : kind === 'ban' ? 'Ban' : 'Kick';

    const h = elm('div', 'adm-dr-h');
    h.append(`${verb} `, elm('b', null, subject.name || '???'));
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
    const cancel = button('Cancel', '', () => { drawer = null; renderDrawer(); });
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
      const target = targetOf(subject);
      const reason = drawer.reason.trim();
      const report = drawer.report;
      if (kind === 'kick') op('a-kick', { ...target, ...(reason ? { reason } : {}) });
      else if (kind === 'mute') op('a-mute', { ...target, mins: drawer.mins, reason });
      // mins 0 is the server's own spelling of permanent, and it needs 'ban-perm'
      else op('a-ban', { ...target, mins: drawer.mins, reason });
      // acting FROM the queue answers the queue: the report moves with the call
      if (report && report.state !== 'actioned') {
        op('a-resolve', { id: report.id, state: 'actioned', note: `${kind}: ${reason}`.slice(0, 140) });
      }
      drawer = null;
      renderDrawer();
    }

    setTimeout(() => why.focus({ preventScroll: true }), 0);
  }

  function renderResolveDrawer() {
    const r = drawer.report;
    const h = elm('div', 'adm-dr-h');
    h.append('Resolve ', elm('b', null, `report ${r.id}`));
    drawerEl.appendChild(h);

    const chips = elm('div', 'adm-chips');
    for (const [label, state] of [['Something was done', 'actioned'], ['Nothing to do', 'dismissed']]) {
      const b = elm('button', `adm-b${drawer.state === state ? ' on' : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', () => { drawer.state = state; renderDrawer(); });
      chips.appendChild(b);
    }
    drawerEl.appendChild(chips);

    const why = elm('input', 'adm-why');
    why.type = 'text';
    why.maxLength = 140;
    why.value = drawer.reason;
    why.placeholder = drawer.state === 'dismissed'
      ? 'Why nothing was done (required)'
      : 'What you did (optional)';
    why.setAttribute('aria-label', 'Resolution note');
    why.addEventListener('input', () => { drawer.reason = why.value; go.disabled = !ready(); });
    why.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ready()) confirm(); });
    drawerEl.appendChild(why);

    const btns = elm('div', 'adm-dr-btns');
    const cancel = button('Cancel', '', () => { drawer = null; renderDrawer(); });
    const go = elm('button', 'adm-b good', 'Resolve');
    go.type = 'button';
    go.addEventListener('click', confirm);
    btns.append(cancel, go);
    drawerEl.appendChild(btns);

    // a dismissal is a real answer to a player who asked for help, so it needs
    // a sentence: server/reports.js asks for one too
    function ready() { return drawer.state !== 'dismissed' || drawer.reason.trim().length >= 3; }
    go.disabled = !ready();

    function confirm() {
      if (!ready()) return;
      const note2 = drawer.reason.trim();
      op('a-resolve', { id: r.id, state: drawer.state, ...(note2 ? { note: note2 } : {}) });
      drawer = null;
      renderDrawer();
    }

    setTimeout(() => why.focus({ preventScroll: true }), 0);
  }

  function renderInspect() {
    inspectEl.textContent = '';
    if (!account) { inspectEl.hidden = true; return; }
    inspectEl.hidden = false;

    const h = elm('div', 'adm-insp-h');
    h.appendChild(elm('b', null, account.name || '???'));
    if (account.guest) h.appendChild(elm('span', 'adm-chip guest', 'guest'));
    else if (account.role && account.role !== 'player') h.appendChild(roleChip(account.role));
    const x = button('Close', '', () => { account = null; renderInspect(); });
    x.style.marginLeft = 'auto';
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

  const TIPS = {
    online: 'Every action here is logged with your name, the reason and the before-and-after.',
    reports: 'Muting or banning from a report resolves it too. A dismissal needs a sentence.',
    staff: 'A role change takes effect at once and kills every token that account had.',
    chat: 'Staff only. Players never see this, and it is kept in memory for this session alone.',
  };

  function render() {
    listEl.textContent = '';
    noteEl.hidden = true;
    chatEl.hidden = true;
    countEl.hidden = true;
    grantEl.hidden = true;
    onlineTools.hidden = tab !== 'online';
    reportTools.hidden = tab !== 'reports';

    for (const b of root.querySelectorAll('.adm-tab')) b.classList.toggle('on', b.dataset.tab === tab);
    paintChatDot();

    renderDrawer();
    renderInspect();
    renderConfirm();

    if (tab === 'online') renderOnline();
    else if (tab === 'reports') renderReports();
    else if (tab === 'staff') renderStaff();
    else renderChat();

    q('.adm-tp-field').hidden = tab !== 'online' || !can('tp');
    q('.adm-say-field').hidden = tab !== 'online' || !can('announce');
    q('.adm-schat-field').hidden = tab !== 'chat';
    tipEl.textContent = TIPS[tab] || '';
  }

  /** The chat tab keeps its own unread pip while you are on another tab. */
  function paintChatDot() {
    const b = q('.adm-tab[data-tab="chat"]');
    const old = b.querySelector('.adm-dot');
    if (old) old.remove();
    if (tab === 'chat' || !bus.unread) return;
    b.appendChild(elm('span', 'adm-dot', bus.unread > 9 ? '9+' : String(bus.unread)));
  }

  function showTab(next) {
    if (next === tab) return;
    tab = next;
    // A half-answered question does not follow you to another tab, and neither
    // does an answered one: an open a-inspect card was staying pinned above the
    // list on every tab, so a mod reading the report queue had a stranger's
    // account record sitting over it. `roleErr` is NOT cleared here: onErr sets
    // it and THEN calls showTab('staff'), so the server's refusal has to survive
    // the trip it triggered.
    drawer = null;
    confirmAsk = null;
    account = null;
    if (tab === 'chat') {
      bus.unread = 0;
      bus.onMessage = appendChat;
      paintBell();
    } else {
      bus.onMessage = null;
    }
    render();
    if (tab === 'online') requestWho(true);
    else if (tab === 'reports' && !repLoaded) requestReports();
    else if (tab === 'staff' && !staffLoaded) requestStaff();
    if (tab === 'chat') setTimeout(() => q('.adm-schat').focus({ preventScroll: true }), 0);
    game.audio?.play?.('click');
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
      case 'a-reports':
        repLoaded = true;
        reports = Array.isArray(m.reports) ? m.reports : [];
        repCounts = m.counts && typeof m.counts === 'object' ? m.counts : repCounts;
        repNote = m.msg || 'Nothing is waiting in this pile.';
        render();
        return;
      case 'a-staff':
        // the server has already sorted (on duty, then seniority, then name)
        // and has its own opinion of whether we may grant: take both
        staffLoaded = true;
        staff = Array.isArray(m.staff) ? m.staff : [];
        if (Array.isArray(m.roles) && m.roles.length) staffRoles = m.roles.filter((r) => typeof r === 'string');
        if (typeof m.canRole === 'boolean') canRole = m.canRole;
        if (!staffRoles.includes(grantRole)) grantRole = staffRoles.includes('mod') ? 'mod' : staffRoles[0];
        render();
        return;
      case 'a-inspect':
        account = m.account && typeof m.account === 'object' ? m.account : null;
        drawer = null;
        render();
        game.audio?.play?.('open');
        return;
      case 'a-role':
        roleErr = '';
        staffLoaded = false;
        requestStaff();
        break;
      case 'a-resolve':
        repLoaded = false;
        requestReports();
        break;
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
    // a-who and a-reports are polled: a rate-limit refusal is the panel's own
    // fault and must not become a toast every six seconds
    if (m.op === 'a-who') {
      loaded = true;
      note = m.msg || 'The cove would not answer that.';
      if (m.code !== 'slow') { rows = []; render(); }
      return;
    }
    if (m.op === 'a-reports') {
      // 'slow' is the server's rate limiter, not an answer. Leaving repLoaded
      // true here was the bug: the queue's own poll is 20s, showTab only asks
      // again when !repLoaded, and renderReports reads repLoaded as "the server
      // spoke", so opening the panel and going straight to Reports could sit on
      // "A quiet inbox" for twenty seconds with a full queue behind it. Stay
      // unloaded, keep the reading-the-queue copy, keep any rows already on
      // screen, and ask again: on the next showTab, and once by ourselves a
      // beat later. The op budget is five a second, so a single retry is both
      // inside it and enough - the panel opens asking for who, staff AND
      // reports at once, which is the burst that trips this in the first place.
      if (m.code === 'slow') {
        repLoaded = false;
        if (!repRetry) repRetry = setTimeout(() => { repRetry = 0; if (!repLoaded) requestReports(); }, 1200);
        render();
        return;
      }
      repLoaded = true;
      repNote = m.msg || 'The cove would not open the queue.';
      reports = [];
      render();
      return;
    }
    // a role refusal is shown WHERE IT WAS ASKED, in the server's own words:
    // "you cannot demote the last admin" belongs next to the button, not in a
    // toast that has faded by the time you wonder what happened
    if (m.op === 'a-role') {
      roleErr = m.msg || 'The server refused that role change.';
      if (tab !== 'staff') showTab('staff');
      else render();
      game.audio?.play?.('pop');
      return;
    }
    game.toast(m.msg || 'That did not work', 3600);
    game.audio?.play?.('pop');
  }

  // ---- wiring --------------------------------------------------------------

  for (const b of root.querySelectorAll('.adm-tab')) {
    b.addEventListener('click', () => showTab(b.dataset.tab));
  }

  for (const b of root.querySelectorAll('.adm-seg button[data-scope]')) {
    b.addEventListener('click', () => {
      scope = b.dataset.scope;
      for (const o of root.querySelectorAll('.adm-seg button[data-scope]')) o.classList.toggle('on', o === b);
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
  q('.adm-refresh2').addEventListener('click', () => { requestReports(); game.audio?.play?.('click'); });

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

  const schatEl = q('.adm-schat');
  const schatGo = () => {
    const text = schatEl.value.trim();
    if (!text) return;
    // no local echo: the server sends the line back to every staff session,
    // this one included, so echoing here would double every message
    if (!send({ t: 'a-schat', text })) return;
    schatEl.value = '';
    game.audio?.play?.('click');
  };
  q('.adm-schat-go').addEventListener('click', schatGo);
  schatEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') schatGo(); });

  const unsubs = [
    game.events.on('a-ok', onOk),
    game.events.on('a-err', onErr),
    // walking somewhere else while the panel is open should re-aim it
    game.events.on('room', () => { if (tab === 'online' && scope === 'room') requestWho(); }),
    game.events.on('net', (s) => {
      if (s !== 'online') return;
      if (tab === 'online') requestWho(true);
      else if (tab === 'reports') requestReports();
      else if (tab === 'staff') requestStaff();
    }),
    // Somebody just changed OUR role. Every gate in this panel was computed
    // from the old caps, so the honest move is to shut it rather than repaint a
    // half-privileged screen. Only a real change counts: `moderation` also
    // fires on every reconnect's profile, and closing the panel under a mod
    // because the socket blinked would be its own bug.
    game.events.on('moderation', (bits) => {
      if ((Array.isArray(bits?.caps) ? bits.caps : []).join(',') === capsKey) return;
      game.toast('Your role just changed. Reopen the panel for the new one.', 4200);
      close();
    }),
  ];

  const poll = setInterval(() => { if (tab === 'online') requestWho(); }, WHO_POLL_MS);
  const reportsPoll = setInterval(() => { if (tab === 'reports') requestReports(); }, REPORTS_POLL_MS);

  // Published BEFORE the first paint, and that ordering is load-bearing:
  // paintBell() hides the doorbell by asking whether a panel is open, so a panel
  // that has not announced itself yet would leave the chip sitting on top of its
  // own header. `close`, `requestWho` and `showTab` are function declarations,
  // so they are already hoisted here.
  openInstance = {
    close,
    refresh: () => requestWho(true),
    showChat: () => showTab('chat'),
  };

  bus.onUnread = paintChatDot;
  render();
  requestWho(true);
  requestStaff();
  if (canReports) requestReports();
  paintBell(); // the panel is up, so the doorbell goes away
  game.audio?.play?.('open');

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    bus.onMessage = null;
    bus.onUnread = null;
    clearInterval(poll);
    clearInterval(reportsPoll);
    if (whoTimer) clearTimeout(whoTimer);
    if (qTimer) clearTimeout(qTimer);
    if (repRetry) clearTimeout(repRetry);
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 150);
    paintBell(); // anything that arrived while we were open and elsewhere
    game.audio?.play?.('click');
  }

  // The panel is docked, not modal: the world keeps its own keys. Escape is the
  // only one taken, and only while this is up.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (confirmAsk) { confirmAsk = null; renderConfirm(); return; }
    if (drawer) { drawer = null; renderDrawer(); return; }
    if (account) { account = null; renderInspect(); return; }
    close();
  }
  addEventListener('keydown', onKey, true);
  q('.adm-x').addEventListener('click', close);

  return openInstance;
}
