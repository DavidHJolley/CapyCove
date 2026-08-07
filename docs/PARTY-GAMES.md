# Party games spec: the Mine and the Jungle (wave 6)

Two new locations, each carrying a multiplayer party game plus an ambient
activity. Authoritative design; implementation matches this or documents why.

## 1. The Glimmer Mine (room id 'mine')

Entered through a timbered mineshaft door on Frosty Peak (the mountain hides
a mine; exit 'exit-peak' back out). Mood: cozy-dark underground: warm lantern
strings, wooden support frames, rails with a minecart or two, glowing crystal
seams (echo Groove Grotto's crystals but amber/teal), drips, dust motes, a
rickety elevator cage as decor. BOT_ZONE stays flat clear floor.

### Passive prospecting (AFK coin generator: NO clicking, by design)
- Simply BEING in the mine earns coins: the server ticks +2 coins every 30s
  to every player in the room (message reuse: the normal 'coins' frame,
  reason 'mining'). No interaction required; it is a place to park your capy
  and chat while the purse trickles up.
- Presentation sells it: your capybara periodically pulls out a tiny pickaxe
  and chips at the nearest wall seam (idle animation variant, ~every 30s
  synced to the payout), a "+2" mote floats up, crystal seams twinkle. Other
  players' capys do the same on their own ticks, so the room reads as a
  little colony of contented miners chatting.
- Rare delight: ~2% of ticks pay a 25-coin gem with a fanfare instead.
- Rate tuning: ~240 coins/hour AFK vs ~1500+/hour of active minigame play:
  generous enough to feel real, never the optimal strategy. The existing
  hourly backstop still applies. No per-session cutoff: AFK is the point.

### Prop Hunt (minigame id 'prophunt', 2-6 players, solo mode vs AI)
- Lobby at the mine's round door using the RACE LOBBY pattern (join spots,
  "HUNTERS n/6" board, starting at 2+ when the host-side 20s countdown ends
  or instantly at 6). Solo hotspot "Seek alone" plays vs AI hiders.
- Round: one SEEKER (rotates; first round random from seed), everyone else
  HIDERS. Arena is a dressed mine chamber (own scene inside the minigame,
  ~30 prop instances from a pool: crates, barrels, lanterns, rocks, mushrooms,
  pickaxes, minecarts, crystal clusters).
- Hide phase (25s): seeker's screen is covered (cave-in curtain + countdown);
  hiders fly a free cursor, click a prop to POSSESS it (their capy morphs into
  it with a puff), then may nudge it up to 3 units from its origin and rotate
  it. Their prop pulses faintly ONLY on their own screen.
- Seek phase (90s): seeker walks the chamber, clicks suspects: wrong click
  = -5 points and a dust puff; correct = the prop pops back into a capybara
  (confetti + 'success'), caught hider becomes a spectator ghost who can
  watch. Hiders score survival ticks (+1/5s alive); seeker scores +25 per
  find, and a clean sweep doubles their round score. Round ends at 0 hiders
  or timer; play 2 rounds with seeker rotation at 3+ players.
- Net: reuse race-style relay: {t:'ph-state'} etc. via the generic match
  relay if the server agent prefers: exact frames defined by the server
  agent within the existing hardening patterns; hider prop choices +
  positions sync at hide-phase end (one frame), seeker clicks relay live.
- Solo mode: 5 AI hiders pick props with plausible placement (near walls,
  in clusters, never in the open middle); you seek with the same rules.
- Coins: MINIGAMES cap 90: honest formula ~ survival + finds converted at
  the same feel as other games (30-90 per run).

## 2. The Tangle Jungle (room id 'jungle')

Entered by a fern-fringed path from Driftwood Beach ('exit-beach' back).
Mood: lush green canopy light, hanging vines, mossy ruin stones with faint
carvings (capy glyphs), a small waterfall into a pool (unwalkable water),
giant flowers, butterflies + a toucan-ish bird on a loop, drum-log seats
around a clearing. BOT_ZONE clear.

### Capy Doodles (minigame id 'doodle', 2-8 players, solo mode vs the bot)
- Lobby at the ruin's stone easel (race-lobby pattern, "DOODLERS n/8",
  starts at 2+ after countdown). Solo hotspot "Guess the bot's doodles".
- Round: one DRAWER gets three word choices (capy-cove-flavored word list,
  ~120 words: in-world nouns, minigames, props: 'smoothie', 'chairlift',
  'top hat', 'shark'...), picks one, draws on a shared canvas (80s) with
  chunky brush, 8 colors, undo, clear. Guessers type into a guess box (the
  round's own input, NOT world chat): correct guess hides that player's
  future guesses, scores by speed (first +100 descending to +40), drawer
  earns +15 per correct guesser. Near-miss hints ("so close!") on Levenshtein
  distance 1. Word masked as blanks with letters revealed at 40s/60s.
- Rotate drawer each round; rounds = players (cap 5 rounds); podium at end.
- Net: strokes relay as compact segments {t:'dd-stroke', pts:[...]} (batch
  ~10Hz, cap sizes); guesses go to the server which validates the word
  server-side (the word is chosen server-side from the seed so guessers'
  clients never receive it until reveal: no DOM peeking).
- Solo mode: "Doodles" the bot replays authored stroke recordings (ship
  12-20 canned drawings as compact point data authored by the implementing
  agent) and you guess against the clock.
- Coins: MINIGAMES cap 90.

## Shared rules
- Both games follow DESIGN.md's minigame checklist (splash, countdown,
  escalation, juicy feedback, results, play again, quit-that-works, dispose).
- Both rooms follow CONTRACT.md (groundMeshes, spawns, BOT_ZONES, budget).
- Server work follows server/index.js's existing hardening patterns; every
  new ws message lands in CLAUDE.md's registry.
- Word list and prop pool must stay all-ages and on-theme (scope test).
