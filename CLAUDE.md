# Capy Cove: agent onboarding (START HERE)

Capy Cove is a cozy multiplayer hangout world in the browser: chibi capybaras
explore themed rooms, chat, dance, play minigames for coins, buy hats, and
(soon) furnish their own dens. Three.js client + Node/ws server, everything
procedural (no external assets), one repo, one deployable process.

## Read these before writing code

1. **CONTRACT.md**: the module interfaces (Room, Minigame, game API, net
   protocol rules). Binding. If your change does not fit the contract, propose
   a contract change first; never silently diverge.
2. **DESIGN.md**: art style, palette, UX/juice standards, economy guardrails,
   minigame checklist, and process lessons. Binding for anything visible.
3. **docs/CARDGAME.md**: full spec for the Capy Clash card duel (if touching it).
4. **README.md**: run/deploy commands.

## Scope test (apply before adding ANYTHING)

Would it fit a cozy, wholesome, capybara-themed hangout for all ages, with
chunky toon graphics and social-first play? If it adds realism, grit, violence,
external assets, or a second art style: it does not belong. When in doubt,
check DESIGN.md's palette/principles or ask the orchestrator.

## File ownership map (who may edit what)

One file = one owner per work wave. Never edit outside your assignment.

- `src/world/rooms/<id>.js`: one room, one owner. Self-contained scene.
- `src/minigames/games/<id>.js`: one minigame, one owner. Self-contained.
- `src/ui/<feature>.js`: one UI overlay per file (hud.js is the shared shell
  and is high-traffic: coordinate before touching).
- `src/core/*`, `src/player/*`, `src/net/client.js`: SHARED INFRASTRUCTURE.
  Changes here affect everyone; only the orchestrator or a designated agent
  touches these, and CONTRACT.md documents any API change.
- `server/*.js`: game server. New ws messages must be registered in the
  message registry below and follow existing hardening patterns (flood guard,
  try/catch per message, own-property lookups, persist() flow).
- `shared/constants.js`: the client/server contract data (rooms, minigames,
  hats, zones, caps). Contract-level: coordinate changes, never duplicate its
  data elsewhere.
- Registries (`src/world/index.js`, `src/minigames/index.js`): tiny lazy-load
  maps; add one line per new module.

## WebSocket protocol registry

Source of truth is `server/index.js` (message handlers) + `src/net/client.js`
(client handling). Current families: hello/welcome/denied, join/room/pjoin/
pleave/state, move, chat, emote, custom, score/best, buy/shop, coins, toast.
Shipped wave 1: inspect/profile, friend-add/friend-remove/friends,
lobby-join/lobby-leave/lobby, race-start/race-progress/race-state/race-done/
race-end, plus mgstart run tokens for score (re-armed after each score for
Play-again runs). Shipped wave 3: house-info/house-config/house-invite/
house-uninvite/house-save/house-guests, buy-furn/furn; dynamic 'house:<owner>'
room sets, access enforced in houseGate() before any join side effect.
Known limitation: access changes do not evict players already inside.
Shipped wave 6 (party games): dig-tick (mine AFK prospecting: pays only
when the grant paid); ph-join/ph-leave/ph-msg->ph-state{from,id,m}/ph-done/
ph-lobby/ph-start/ph-end (Prop Hunt; {left:true} relay note on abandon);
dd-join/dd-leave/dd-pick/dd-stroke/dd-guess -> dd-lobby/dd-start/dd-words
(drawer only)/dd-mask/dd-stroke{from}/dd-correct/dd-state/dd-end (Capy
Doodles; server-authoritative words + validation; the private near-miss
ping rides dd-state as {close:true}: check m.close before m.phase).
Shipped wave 4 (den PvP): table-join/table-leave/table,
match-start/match-move/match-done/match-end (2-seat tables per den game,
agreed-winner +30 bonus, forfeit on leave/disconnect). The Game Den now lives
inside the Frosty Peak ski lodge (peak 'exit-lounge' <-> lounge 'exit-peak');
the plaza no longer references it. The den is TWO rooms: the loud floor
('lounge': pong, shuffle, connect4) and 'loft', The Trophy Loft above it
(fireplace, Hall of Champions, chess + Capy Clash), joined by a real walk up
the stair (lounge 'exit-loft' <-> loft 'exit-lounge', spawns from_loft /
from_lounge). Nothing server-side names either room: a table belongs to
whatever room `MINIGAMES[game].room` gives it, so the join requirement, the
board broadcast and the join-time snapshot all follow shared/constants.js and
moving a table between floors is a one-line change there. Known/accepted: two colluding accounts can
farm the 30-coin match bonus (hourly backstop bounds it); a match-move relayed
between match-start and the game chunk's mount is dropped (harmless for
current games).
Shipped wave 7 (the Social Cove, docs/LIVING-COVE.md):
`clock` (server->all every 10s, on hello and on every room join)
`{dayT, day, weather, snow, aurora, dayMs}`. `weather` is a WORD
('clear'|'breeze'|'rain'), never an envelope: engine.applyClock hands it
straight to `room.onClock(dayT, weather, aurora)`. `dayMs` is the authoritative
cove-day length; any client countdown must read it rather than assume 40 min.
`move` gained optional `y` (clamped -40..40) and `ride`; `ride` is STICKY, so a
frame that omits the key leaves the flag alone (the net client's own 10Hz move
frames carry neither, and only The Drift ever sets them). `snow` {to:[x,z] or
{x,y,z}} -> relayed as `{id, from:{x,y,z}, to:{x,y,z}}`, 1/s per capy.
`ball` {impulse:{x,y,z}} -> `{room,x,y,z,vx,vy,vz,by,r}` at 10Hz while it moves,
silent while it sleeps; reach- and magnitude-clamped. `party-start`
(refusal rides the same name as `{ok:false,msg,retryIn}`) / `party-end` /
`party` ({active,parties[]} + the newest party flattened). `mural` {x,y,c} ->
op `{x,y,c,by,id}`, refusal `{ok:false,msg,wait}`; `mural-grid` -> `{w,h,colors,
cooldown,rle}` ("count:index" runs); `mural-report`. `quests` -> board with BOTH
`n`/`count` and `progress`/`target`; `quest-done` {id,name,coins,all?};
`stamps` -> album (+`id` only when it answers about someone else); `stamp` ->
one earned stamp. `bottle` / `bottle-found` (The Drift's daily bottle).
Milestone rewards reuse the EXISTING `shop`/`furn`/`toast` frames; the title and
unlocked dye colours ride the welcome profile (publicProfile) and the world tag
snapshot. Milestone cosmetics are `milestone:true` in shared/constants.js with
price 0: the shop hides them AND the server refuses to sell them.
Shipped wave 9 (accounts/admin spine): the `a-*` operator family (a-who,
a-inspect, a-mute, a-kick, a-ban, a-unban, a-tp, a-announce...) is handled
ENTIRELY inside server/admin.js `performOp` (capability-checked, audited) and
answered with `a-ok`/`a-err`; `announce` broadcasts. Dispatch order in
server/index.js is LOAD-BEARING: admin.handleMessage (mute/ban pre-empt) ->
chatlog.observe (never consumes) -> reports.handleMessage -> layouts.handleMessage
-> progress.handleMessage -> main switch.
Shipped wave 10 (T&S): `report` (player/mural/drawing reports -> server/reports.js),
`dd-vote` {kind:'skip'} (majority of current guessers skips a dead doodle round);
chat/whisper/names pass server/filter.js and broadcast the CLEANED text.
Shipped editor v2 (rlo/1 layout docs at data/layouts/<room>.json, server/layouts.js):
`layout-get` {room} -> `layout-doc` {room,doc,rev}; `layout-save` {room,ops} (draft),
`layout-publish`, `layout-discard`, `layout-revert` -> `layout-ack` {ok,...};
publish broadcasts `layout-rev` {room,rev} to ALL (client evicts its cache and
rebuilds if standing in that room). All layout-* writes require the 'editor'
capability. Read side: `GET /api/layout/:room` with ETag; published ops applied
at room build by src/world/overlay.js `attachOverlay` (called from engine
switchRoom/rebuildRoom; do not call room.build without it).
Shipped wave 11 (economy integrity): 'mgstart' is consumed by server/econ.js
(econ.handleMessage runs after progress, before the main switch). A run token
is bound to MINIGAMES[game].room, is spent by the 'score' that pays it, and
carries the pending 'best' (the client sends best BEFORE score), so a personal
best is only written against a run the coin road accepted, and never above the
score that run claimed. Duels: econ.matchStarted/matchMove/duelPayout refuse
IMPOSSIBLE wins (too fast, winner never moved); a hot pair (many wins/hour,
same two accounts) is LOG-ONLY - the owner's law is NO caps on honest play,
ever. Refusals ride the existing 'toast' frame; anomalies go to server/audit.js
LOG-ONLY. No new wire frames. Telemetry: server/log.js JSON lines (install
first, COVE_LOG_LEVEL/COVE_LOG_PRETTY), /api/health carries econ + log + frame
counters. Tests: npm test runs test/**/*.test.js + tests/**/*.test.mjs; CI in
.github/workflows/ci.yml builds with COVE_STRICT_BUILD=1 (a surviving
window.__x debug handle fails the build; clearing `= null` writes are fine).
Shipped staff suite: `a-role` {target, role} / `a-staff` / `a-schat` {text} /
`a-reports` {state?,kind?,limit?,offset?} / `a-resolve` {id, state?, note?},
all handled inside server/admin.js performOp (NO index.js change: index.js
already routes every a-* frame to admin.handleMessage first). New caps:
'role' (ADMIN ONLY) and 'staffchat' (mod + admin). Role rules: admin only,
never your own role, never above your own rank (admin->admin allowed), never
the last admin; the change bumps tokenV, persists, and re-caps open sessions
live. Two new server->client frames: `a-role` {role, caps, muteUntil, by, at}
to the SUBJECT (profileBits verbatim -> game.applyModeration) and `a-schat`
{from, role, text, at} to every online session holding any capability. Staff
chat is EPHEMERAL, passes server/filter.js, ~1 line/s per sender, audited as
a COUNT never content, and 'a-schat' is in MUTED_FRAMES (a muted mod is muted
there too). a-reports/a-resolve ride server/reports.js's existing queue().
Shipped wave 12 server side (co-presence): `pop` {rooms:{roomId:count},
lobbies:[{game,room,n,need,countdownAt?}]} to ALL every 5s and on hello (bots
excluded); `fpresence` {friends:[{name,room|null}]} to a player on hello and
whenever one of THEIR friends connects/moves/disconnects; `lobby` gained
{game,n,need,countdownAt?} and a race now arms at TWO riders (20s fill window,
full board keeps the quick countdown); `lobby-start` (client->server) lets
anyone on the board start a pair race immediately. Client re-emits pop and
fpresence via game.events.
Shipped input remap (task #20): the RIGHT mouse button walks (click, or hold
and drag to steer); the LEFT button interacts only (player cards, room props,
prompts). Touch is unchanged (tap walks and interacts). Snowballs on Frosty
Peak throw with T at the cursor. Settings > Walking restores the classic
left-click scheme; the binding lives in engine._onPointer, not controller.js.
Shipped wave 12 client (daily ritual): quest day is the REAL America/New_York
calendar day (progress.dayKey(), exported); the quest board countdown trusts
the server's resetIn and shows hours; login streak + daily gift ride the
existing coins/toast/quests frames (m.streak on the quests frame); bottle and
bonfire daily caps follow the same real day. HUD: map pills carry live head
counts, an island lobby strip and a travelling "one seat short" chip (from
pop), friends get a coral ring/pin on the map and a join-them button in the
panel (from fpresence). Sled: the gate lobby shows n/need + countdownAt, a
Start Now button appears at 2+, and 'mgstart' for sled drops the sender from
the gate board server-side before econ consumes it.
Shipped Capy Karts (docs/KARTS.md is the FROZEN contract; read it before
touching anything kart): room 'speedway' (paddock only; the circuit lives in
the minigame), minigame 'kart' (MINIGAMES.kart, coins via the normal
mgstart/score road, honest max 152 under maxCoinsPerRun 160). Frame family
kart-join/leave/start-now/kart-in/kart-box/kart-use (client->server) and
kart-lobby/grid/go/state/item/box/haz/hit/fx/lap/fin/end/board/resume
(server->client), ALL handled in server/kart.js (index.js dispatch after
econ; kart also observes 'join' and 'score' without consuming). Wire carries
normalized lap progress q (=u/545), lat, yaw - never x/z. Hits are SERVER-
ARBITRATED; AI is server-simulated and hard-capped below a perfect player;
laps validate a checkpoint sequence with a forward-rate clamp (the cut-lap
and speed-hack guard in one rule); standings rank VALIDATED laps, never raw
line crossings. kart-resume restores a reconnecting racer (speedway.js parks
it on game.__kartCtx.resume; kart.js applies it on mount; `lap` = laps
COMPLETED, `laps` = race total).
Shipped wave 13 (the cadence engine): `events` (server->all on hello, on
EVERY room join and on any change) {now, tz, rev, active:[{id,name,blurb,
icon,badge,rooms,startedAt,endsAt,endsIn,effects}], next:{...}|null, flags};
active: [] is said out loud so a stale pill clears. Client->server: `events`
(budgeted board read), `event-start`/`event-stop` (capability 'events',
ADMIN only, answered on a-ok/a-err). All in server/events.js (dispatch after
kart); the calendar is data/calendar.json (TRACKED - the one file under
data/ in git and docker), hot-reloaded shadow-parse-and-swap; grantCoins
multiplies by events.coinMult(p, reason), which is >= 1 ALWAYS and never
touches the AFK earners (mine dig, bonfire, bottle). Consignment: `shop-rot`
(read -> {ids,pool,secret,dye:{price},until}) and `buy-dye` {color} ->
`dye` {ok,color,coins,delta,colors}; rec.dyes on the ACCOUNT is the paid-
colour authority (never localStorage). Charm hunt (server/charms.js):
`charm` (read; also pushed on hello), `charm-claim` (server validates room +
proximity + one per account per week), `charm-found` broadcast ({name} is
the FINDER, {charmName} the charm, {n} finds this week); `a-charm` admin op;
charms/charmCount ride publicProfile via charms.profileBits. The client
renders the glint via src/world/charm.js attachCharm (engine calls it beside
attachOverlay). Stats (server/stats.js) tee off signal/grantCoins/sessions/
buy sinks into data/stats/ NDJSON; npm run report prints the twelve numbers;
aggregates only, never content, never per-player rows.
Shipped wave 14 (the Cove Courier + launch polish): `courier` (client->server
read, rate-limited) -> `courier` {week, issueN, headline, printedAt,
nextPrintAt, articles:[{k,h,body}]}; `courier-new` broadcast once at print
time. The paper prints FRIDAY 10:00 America/New_York (server/courier.js,
dispatch after charms), is assembled once per week from charms/stats/events/
kart and cached immutably; every source is optional (a missing source drops
its article, never the issue); the only named credit is the week's fastest
kart lap, filtered and vetoable at render time, and an absent count prints NO
number, never zero. Reader UI src/ui/courier.js (cove-timezone dates), plaza
newsstand src/world/newsstand.js. Public GET /api/now (no auth, 60s cache) is
events.frame() for the title screen's "this week in the cove" line; the
first-run tour covers the remap, the map, the speedway and the quest board.
Adding a message: implement server handler (validated, rate-limited, inside
the try/catch), client handler that re-emits via `game.events`, and add it to
this list.

## Working rules

- No new npm dependencies, no TypeScript, no external assets. ES modules only.
- No import-time side effects (DOM/AudioContext/etc.). Verified with:
  `node --input-type=module -e "await import('file:///<abs path>')"`
- Dev servers usually already run (vite :5199, game :3001): do not start,
  stop, or restart them unless explicitly asked; never `git commit` unless
  you are the orchestrator.
- `npm run build` must stay green; the wave's verifier runs it, but do not
  hand off code you know does not parse.
- Dispose what you create (GL resources, listeners, intervals, RAF): the
  engine auto-disposes the scene graph; everything else is yours.
- Visual work is verified visually: capture screenshots from the actual room
  camera and spawn points (see DESIGN.md process lessons).

## Current roadmap state (2026-08-07)

Waves 1-7 are SHIPPED (see the registry above for the full protocol). Wave 7
(the Social Cove, docs/LIVING-COVE.md) landed last: world clock + weather +
aurora, snowballs/beach ball/bonfire, parties, the plaza mural, daily quests +
stamp album + milestone cosmetics, and The Drift (swimming, shaders, Big
Blue). A wave-7.5 playtest-polish pass followed (doodle word sync, prop hunt
arena rebuild + free prop movement + wall-clock timers, mine declutter,
music beds for mine/jungle/drift, snowballs, plaza tidy, Den
floor decongestion, Drift swim-cam overhaul, click-to-move marker, the den's
two-floor split into 'lounge' + 'loft' (the old in-room mezzanine and its
floor-hop hotspots are GONE: a balcony is opaque from a camera 9.5 up, and
one camera cannot frame two storeys), background-tab movement, beach minWalkY
shoreline clamp, citizens: no sleeping + hash-scattered spots). PENDING (see
the session task list): EST real-time world clock (America/New_York), lobby
"Start now" chips, lobby walk-away un-queue. Wave 8 (Capy Clash Spectacle,
docs/CARDGAME.md section 10) is PARKED pending an explicit user go-ahead.
Remaining after that: PUBLIC DEPLOYMENT (configs in repo: Dockerfile,
render.yaml, fly.toml; needs the user's hosting account).

### Admin backdoor: RESOLVED (wave 9)

The old `/^david/i` display-name gate is gone. Ctrl+E now requires the
server-granted `editor` capability (game.can('editor'), from the role on the
user record via publicProfile), and Ctrl+Shift+A (mod panel) requires any
capability. Roles are seeded by the COVE_ADMIN env var and granted with a-role.

## Layout editor (Ctrl+E)

Rooms are built from numbers, not scene files, so the editor edits numbers and
exports them; the room file stays the source of truth. Two modes:

**Handles** (authored, exact): a room publishes its layout numbers through
`editorHandles(id)` and each becomes a draggable pin. Dropping one calls
`editorPatch(id, key, value)` (or `editorPatchAll` for a Shift-drag of the
whole cluster), stores it in `src/world/layout.js`, and calls
`engine.rebuildRoom()`, so the sign posts, chairs, prompt zones, glow rings
and obstacle circles derived from that number all move with it. `[`/`]` turns
a station by patching its `yaw`. `editorExport(id)` returns the pasteable row.
Rooms opt in with `editable(id, objs)` + those four methods; only the lounge
has so far (see its STATIONS table for the pattern).

**Free** (works in every room, no opt-in): raycast-pick ANY object. Clicking
takes the whole prop; Tab drills down through its parts to the finest grain
available, which is one instance of an `InstancedMesh` OR one welded piece of
a merged mesh. Merged props keep no record of their parts, so the editor finds
the seams itself: union-find over the geometry (welding by position first,
since icosahedrons and friends come out unindexed) labels each connected
component, and a piece is moved/turned/resized by rewriting just its slice of
the position attribute about its own centroid. That is how a single rock comes
out of a 30-rock, one-draw-call batch.
Controls: drag to move, arrows nudge, PgUp/PgDn height, `[`/`]` rotate, `-`/`=`
scale, H hide, click the same spot again to cycle past the front-most object,
Shift for bigger steps. Camera: wheel zooms, right-drag orbits, middle-drag or
Shift+right-drag pans, F frames the selection (it drives `engine._staticCam`
while open and restores the player's camera mode on close). Particle systems,
lines, sprites and depth-writeless glow overlays are unpickable, and oversized
backdrops sort last. Free edits are a VISUAL preview: nothing derived from a
number follows, and they are session-only. The panel prints position, rotation
and scale plus a scene path so the value can be found in the room builder.

**Build (editor v2, persistent)**: the third tab edits a per-room layout
DOCUMENT (`rlo/1` op list: move/rot/scale/hide existing props, place new props
from a palette, spawn/cam overrides). Drafts autosave to the server
(`layout-save`, editor capability required) and are private to editors;
**Publish** bumps the room's rev, broadcasts `layout-rev`, and every player's
client applies it at room build via `src/world/overlay.js` (`attachOverlay`).
Discard drops the draft; Revert rolls back one published rev. Room files stay
the source of truth for geometry; the layout doc is a diff on top. Server side
lives in `server/layouts.js` (owner: editor wave), docs at data/layouts/.

## Historical roadmap notes (2026-08-06)

Shipped: 5 rooms, 3 minigames, accounts + guest play, chat/emotes/shop sync,
server bots, security hardening pass, wave 1 (3-player seeded sled racing with
gate lobby, friends + profile cards with medals, game menu, chat history,
walk-through exits, chairlift/bench/quit/ramp/fishing-lives fixes); wave 2
Game Den ('lounge': pong, shuffle, chess, connect4, cards per
docs/CARDGAME.md, all vs capybara AI with win payouts; chess and cards moved
upstairs to 'loft' in the 7.5 polish pass); wave 3 player houses
(dynamic 'house:<owner>' rooms, 20-item furniture catalog + placement editor
in src/ui/houseEditor.js, open/friends/invite access, Furniture shop tab,
visits via menu/profile/friends). Not yet done: public deployment.
