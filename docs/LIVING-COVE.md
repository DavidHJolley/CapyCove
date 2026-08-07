# The Social Cove (wave 7): shared moments, play toys, parties, mural, The Drift

DESIGN PIVOT (playtester direction, 2026-08-06): "do I really care about NPCs
if I'm a player? I want human interaction." Correct: in a social game the
product is other humans. NPCs are demoted to an empty-room floor (schedules
only, section B); the wave's effort goes to systems that CREATE human-to-human
moments: synchronized world events people show up for, zero-menu physical play
between strangers, player-thrown parties, and a persistent collaborative
artwork. Authoritative spec: implement this or document why not. Read
CLAUDE.md + CONTRACT.md + DESIGN.md first, as always.

## A2. Ambient play toys (no lobby, no menus, no scores)

Instant physical play between people who have never spoken:
- SNOWBALLS (peak): click-hold anywhere on the snow aims from your capy, a
  short arc preview grows with hold time (cap 1s), release lofts a snowball
  {t:'snow', from, to} relayed to the room; everyone simulates the same arc.
  A hit is a puff + a wobble + a 'boop' sfx + a brief snowcap on the target's
  head: no damage, no score, pure mischief. 1/s rate limit server-side.
- BEACH BALL (beach): ONE persistent ball in the room, server-owned position
  with simple shared physics (bounce, drag, gravity): walk into it or click
  it to bop it {t:'ball', impulse}; it arcs over the sand, splashes, floats
  back. The fun is emergent volleyball between strangers. Server clamps
  impulse and tick-integrates at 10Hz so all clients agree.
- BONFIRE (beach, dusk-to-dawn via the clock): unlit log pile by day; at dusk
  it lights: sitting within its glow (sit emote or idle 5s) grants a cozy
  ember particle halo and +1 coin/min (capped 15/night): a gathering magnet,
  not an economy. Citizens' schedules route a couple of them there so the
  circle is never empty.

## A3. Parties

- Any registered player can "Throw a party" (menu + den decorate mode):
  choose venue (their den or the club), 30 minutes: island-wide toast
  ("DavidEdge is throwing a party at the Groove Grotto!"), a pulsing beacon
  on the island map, and the venue's map pill gains a party hat.
  {t:'party-start'/'party-end'/'party'} frames; one active party per player,
  90-min cooldown, party auto-ends if the host leaves for >5 min.
- Attending: being in the venue during the party gives a confetti burst on
  entry and doubles emote/bubble juice (visual only). The host gets
  "+N capys came" in their results toast: bragging rights, not coins (no
  farmable economy edge).
- House parties force access 'open' for the duration (with the owner's
  explicit confirmation dialog: it reverts at party end).

## A4. The plaza mural

A big framed wall near the notice board: a 96x54 pixel collaborative canvas.
- Click the mural hotspot: mural overlay opens: the live canvas, a
  cove-palette swatch row (the 12 DESIGN.md colors + cream + ink), pick a
  cell, place a pixel. One pixel per player per 20s (server-enforced),
  {t:'mural', x, y, c} ops broadcast live to everyone with the overlay open
  AND painted onto the in-world wall texture (CanvasTexture update).
- Server persists the grid (data/mural.json, debounced) and keeps a rolling
  op log capped at 50k; joining sends the full grid compressed (RLE string,
  ~2KB typical).
- Moderation: palette-locked (no freehand, no text tool), and the notice
  board gains a "report mural" hotspot that snapshots the grid to
  data/mural-reports/ for the operator. Guests can look, only registered
  players can paint.
- This is the island's guest book. Leave it running for a month and it
  becomes the community's self-portrait.

## A. World clock and weather

### Server (source of truth)
- One cove day = 40 real minutes, continuous phase `dayT` in [0,1): 0.0 dawn,
  0.25 noon, 0.5 dusk, 0.75 midnight. Server broadcasts
  `{t:'clock', dayT, weather, aurora}` to ALL players every 10s and on join
  (clients interpolate between frames; never trust local Date for game time).
- `weather` per outdoor room family, evolving via a gentle Markov walk every
  3-8 min: 'clear' | 'breeze' | 'rain' (beach/plaza/jungle) and snowfall
  intensity 0..2 for peak. Interiors ignore weather.
- `aurora`: boolean, rolled only while 0.65 < dayT < 0.9 (night), ~15% of
  nights, lasts 3-5 min. Broadcast so everyone sees the same sky.

### Client contract (per room)
- New optional room API: `onClock(dayT, weather, aurora)` called on every
  clock frame AND once right after build. Rooms that skip it stay as-is.
- Outdoor rooms (plaza, beach, peak, jungle, mine entrance porch) implement:
  - Sky/background + fog color from a per-room 4-stop gradient LUT
    (dawn/noon/dusk/night). Lerp continuously; never snap.
  - Sun/moon directional light: azimuth + intensity follow dayT; shadows stay
    on the one caster. Hemisphere fill dims at night (never fully dark:
    playability floor ~0.45 intensity).
  - Dusk-to-dawn: lamp posts / string lights / windows turn EMISSIVE ON with
    a little per-lamp stagger (0-2s random) + warm point light where one
    already exists. No new shadow casters.
  - Weather: rain = instanced streak particles + darker sky + puddle gloss
    decals (no audio agent work: reuse audio.setRoom ambience already there);
    peak snowfall scales the existing snow particle count/speed.
  - Aurora (peak only): additive ribbon mesh (vertex-waved bands, green/pink),
    only while aurora && night. Subtle, not a rave.
- Interiors (cafe, club, lounge, house): only their WINDOW canvases shift
  (dusk/night variants of the painted views) and window glow reverses (lit
  from inside at night as seen in exteriors; warm spill indoors at dusk).
- The clock frame also reaches minigames via `game.events.emit('clock', ...)`:
  The Drift (below) MUST react; others may.

## B. Citizens (DEMOTED by the design pivot: schedules only)

The wander-bots exist for one reason: an empty room at 2am kills a small
social game, because nobody stays where nobody is. They are set dressing
that keeps the world breathing at low population, nothing more. Scope kept:
fixed identities (stable name/color/hat across restarts) and daily schedules
from dayT: night (0.7-0.95) asleep in the lounge ('sit', chatter silenced);
breakfast (0.02-0.1) cafe bias; evening (0.55-0.7) club bias; one or two
routed to the dusk bonfire so the circle is never empty; otherwise the
existing wander. Schedule moves reuse migrate() with +-3 min jitter so they
never march in lockstep. The per-player memory, gossip and dialogue-grammar
system from the earlier draft is CUT per playtester direction: that effort
now belongs to the human-interaction systems in A2-A4. The existing light
room-flavored chatter stays exactly as it is.

## C. The Drift (underwater room, id 'drift')

Entry: a brass dive bell at the end of the Driftwood dock ("Take the dive
bell down"), exit back the same way. This room is the graphics showcase and
deliberately breaks two rules, SANCTIONED here:
1. Custom GLSL ShaderMaterials are allowed in this room only (everything
   else stays makeToon): animated caustics projected on the seabed
   (procedural Voronoi-ish caustic function, not textures), volumetric god
   rays (additive billboarded cones from the surface, depth-faded), and a
   depth-graded fog (deeper = darker teal, exponential).
2. Movement is SWIMMING: full 3D. `WalkController` is bypassed: the room
   sets `game.engine.controller.enabled = false` (add that flag, default
   true, engine skips update when false) and drives its own SwimController:
   click-to-swim toward the clicked point projected into the water volume,
   gentle buoyancy bob, drag, banked turns; avatar plays 'swim' (new anim in
   avatar.js: horizontal pose, paddling paws, trailing bubbles). Bounds: a
   soft AABB; pushing the edge eases you back (no walls: "the current").
- Multiplayer: `move` frames gain optional `y` (server clamps -40..40,
  passes through; older clients ignore it): remotes interpolate y and play
  'swim' in this room. BOT_ZONES.drift: none: citizens do not dive.
- Life: 3 instanced boid schools (separation/alignment/cohesion, 40-60 fish
  each, one draw call per school), drifting jellies (avoid: they sting
  nothing, just glow), seagrass swaying via vertex displacement, a sea
  turtle on a lazy spline. And BIG BLUE: a whale the size of the room
  circling slowly; swim onto her back and you ride (parent the avatar,
  'sit' pose) until you click elsewhere. Her back seats SIX: remote riders
  parent too (their y + a 'ride' flag travels in the move frame), because
  the whole point is riding her together: it is the best group photo spot
  in the game. She surfaces near the bell every few minutes and sings
  (audio: low filtered sine swells).
- Night (clock): the water darkens and bioluminescence takes over: plankton
  particles glow on movement (emission follows swim speed), jellies become
  lanterns, caustics fade. This is the postcard moment.
- No minigame, no coins: The Drift is pure wonder. One hidden delight: a
  message-in-a-bottle spawns daily at a random spot; first finder gets a
  one-line lore note and 25 coins (server-validated, once per day per
  account).

## D. The spine: dailies, stamps, milestones (what makes it a GAME)

Breadth without direction is a toybox. This system points players at the fun
and gives them a reason to return tomorrow. All server-validated: the server
already sees every signal it needs (score frames, match results, digs, party
attendance, mural ops, room presence, whale rides via the ride flag).

- DAILY QUESTS: the plaza notice board becomes the Quest Board (hotspot +
  overlay). Server picks 3 dailies per account per cove-day from a ~25 pool,
  weighted so at least one is social ("attend a party", "bop the beach ball
  10 times", "paint 3 mural pixels") and at least one is a minigame task
  ("win any den match", "score 40+ in Reel Rush", "finish a 3-capy race").
  Rewards: 30-60 coins each + a stamp-track tick; completing all 3 = +50
  bonus. {t:'quests'} on join/rollover, {t:'quest-done', id} pushed live
  with a satisfying toast + fanfare. Guests see the board with a "sign up to
  take on quests" nudge (conversion hook).
- STAMP ALBUM: ~40 authored stamps for real feats, not grind: "Sweep: win
  pong 5-0", "Night owl: see the aurora", "Pod: ride Big Blue with 3 others
  at once", "Muralist: 50 lifetime pixels", "Host with the most: 5 capys at
  your party", "Deep breath: 10 minutes in The Drift", "Regular: 7 distinct
  days played". Album tab in the player card (openProfile) with earned/
  unearned art (procedural stamp icons, DESIGN.md style); server persists
  per account; earning one fires a full-screen stamp-slam moment.
- MILESTONE TRACK: total stamps unlock EXCLUSIVE cosmetics that coins cannot
  buy (5: snorkel hat; 12: aurora-dyed body color; 20: whale-song gramophone
  furniture; 30: golden pickaxe hat; 40: "Legend of the Cove" title on the
  name tag). Exclusivity is the point: visible proof of play.
- Anti-farm: dailies validate against the same rate-limited server signals
  as coins (a quest can only consume a signal the hardened handlers already
  accepted); stamps are idempotent; nothing here mints coins beyond the
  existing hourly backstop.

## Protocol additions (CLAUDE.md registry when shipped)
- `clock` (server->all, 10s), `move.y` (optional), `bottle`/`bottle-found`
  (drift daily bottle), citizens reuse existing chat/emote/state frames.

## Budgets and safety
- Clock work must add zero per-frame allocations (lerp into preallocated
  colors) and no new shadow casters. Citizens are server-side only: no
  client cost. The Drift targets <= 130 draw calls, shaders must compile on
  WebGL2 without extensions, and everything disposes (shader materials are
  not in the toon cache: dispose them in room.dispose()).
