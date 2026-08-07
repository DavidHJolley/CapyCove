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
the plaza no longer references it. Known/accepted: two colluding accounts can
farm the 30-coin match bonus (hourly backstop bounds it); a match-move relayed
between match-start and the game chunk's mount is dropped (harmless for
current games).
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

## Current roadmap state (2026-08-06)

Shipped: 5 rooms, 3 minigames, accounts + guest play, chat/emotes/shop sync,
server bots, security hardening pass, wave 1 (3-player seeded sled racing with
gate lobby, friends + profile cards with medals, game menu, chat history,
walk-through exits, chairlift/bench/quit/ramp/fishing-lives fixes); wave 2
Game Den ('lounge': pong, shuffle, chess, connect4, cards per
docs/CARDGAME.md, all vs capybara AI with win payouts); wave 3 player houses
(dynamic 'house:<owner>' rooms, 20-item furniture catalog + placement editor
in src/ui/houseEditor.js, open/friends/invite access, Furniture shop tab,
visits via menu/profile/friends). Not yet done: public deployment.
