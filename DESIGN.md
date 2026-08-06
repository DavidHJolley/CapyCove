# Capy Cove: art style and game design bible

For any agent or developer adding content to Capy Cove. CONTRACT.md tells you
the *interfaces*; this document tells you how to make things *look, feel and
play* like they belong here. When in doubt, match what exists; cohesion beats
novelty every time.

## 1. Art style: "chunky cozy toon"

### Core rules
- **Everything is procedural.** Geometry from three.js primitives, textures
  drawn on canvas (`canvasTexture` in `src/core/materials.js`), sound from
  WebAudio synthesis. No downloaded assets, ever. This is a feature: zero
  licensing, zero loading, one aesthetic.
- **Toon shading everywhere.** `makeToon(color)` (3-step gradient) for every
  lit surface, `makeGlow(color)` for emissive accents (lamps, neon, crystals,
  LED tiles). Standard/Phong materials are off-style; do not use them.
- **Chunky low-poly silhouettes.** Spheres at 14-20 segments, cylinders at
  8-16. Shapes read at a glance from the 3/4 camera: a tree is a cone stack,
  a boat is a wedge, a sandcastle is stacked cylinders. If a detail needs more
  than ~200 triangles to read, simplify the silhouette instead.
- **No hard black, no pure white.** Ink is `#2d2417`, cream is `#fff6e3`.
  Shadows come from the lighting, not from dark materials.

### Palette
Anchor colors (use these before inventing new ones):

| Role | Hex |
| --- | --- |
| Coral pink (brand, signs, accents) | `0xe8657a` |
| Sky blue (water, secondary accents) | `0x4fb3e8` |
| Leaf green (foliage) | `0x7ac74f` |
| Gold (coins, prompts, banners) | `0xf2b64a` |
| Warm cream (stone, sand, plaster) | `0xfff6e3` / `0xf0dca0` |
| Capy browns (fur, wood) | `0xb08a5a` `0x8a6642` `0x6b4f35` |
| Night purple (club, cave, mystery) | `0x2a2038` family |

Per-room mood = one dominant temperature + coral/gold accents: plaza is warm
green/cream, beach is sand/teal, peak is blue-white with warm lodge windows,
cafe is honey wood, club is near-black purple with saturated neon. Accents stay
consistent across rooms so it reads as one world.

### Characters
- Chibi proportions: big head (~40% of height), egg body, stub limbs, total
  height ~1.8 units, feet at y=0. `createAvatar` in `src/player/avatar.js` is
  the single source of truth; NPC/statue capybaras (DJ, snowman, topiary,
  minigame riders) echo its proportions but are built locally from primitives.
- Faces are minimal: bead eyes, boxy muzzle, dark nose. Expression comes from
  *animation* (bob, ear twitch, lean) and, in 2D, from a five-state face system
  (idle/blink/worried/cross/beam like the smoothie customers).
- Everything alive idles. Nothing organic should ever be perfectly still:
  breathe-scale (~1.2%), ear twitches, tail bobs.

### Environment composition (the room camera is the frame)
- The camera is a soft-follow 3/4 view (default offset `(0, 14, 19)`, fov 42).
  Compose FOR that view: signs face it, focal props sit north of the player's
  usual path, floors tilt interest toward the bottom of frame.
- **Signs must read from the play camera.** If a sign can be seen from behind,
  give it two faces (the grotto sign) or make the back a decorated slab.
  Test text legibility at 960px wide captures.
- Fill every edge the camera can reach: sky domes, sea rings, distant hills,
  cloud sprites. Flat void background = bug.
- Landmark rule: each room has ONE star attraction (fountain, dock, chairlift +
  gate, counter + blender, LED floor) placed opposite the entrance so players
  walk toward it, plus 15-25 supporting props, plus 2-4 ambient critters
  (crabs, gulls, drifting notes) on loops.
- Walkable space is generous and convex-ish: BOT_ZONES circles (shared/
  constants.js) must stay flat, open ground; hotspots sit at the zone's edge,
  never inside furniture clusters. After placing obstacles, trace the paths
  between every exit/hotspot pair: a bench must never pinch a route shut.
- Spawn views are first impressions: stand at every spawnPoint, capture the
  frame, and confirm the player is visible and the room's star attraction is
  in shot (this caught the beach spawn hiding behind palms).

### Motion and juice
- Ease everything; nothing linear, nothing instant. UI uses the springy cubic
  `cubic-bezier(0.2, 1.35, 0.4, 1)` (`--spring` in styles.css); world motion
  uses sine bobs and lerp-with-dt (`k = min(1, dt * rate)`).
- Reward feedback stacks: coin sfx + coins-pill scale pop + toast + (in games)
  score popup at the event location. A player should never earn something and
  feel nothing.
- Particles are cheap and everywhere: recycled Points or small instanced
  meshes: fountain spray, snowfall, bubbles, blender steam, dance-floor motes.
  Budget ~1000 particles per room, recycled, never allocated per frame.

### UI style
- Rounded everything (`border-radius: 999px` pills, 18-26px cards), cream
  surfaces, chunky 700-900 weight system fonts (`Trebuchet MS` stack), 3px
  white borders on interactive gold/coral elements, soft big shadows.
- World-anchored DOM (name tags, bubbles, hotspot prompts) over WebGL; never
  render text inside the 3D scene except on canvas-textured signs.
- Copy voice: warm, playful, a little silly, no lorem ipsum, no "TODO". Bots
  speak in lowercase enthusiasm ("the water is perfect today").

### Audio style
- All synthesized (src/core/audio.js): music bus quiet (~-18dBFS feel) under
  sfx, one generative bed per room matching its mood; club gets a real
  four-on-the-floor. SFX are short (<300ms) layered osc + noise blips.
  Every interactive click/hover/reward has a sound.

## 2. Game design principles

### The core loop
Hang out -> play a minigame (60-120s run) -> earn 30-90 coins -> buy hats
(50-800) -> show off in the social space -> repeat. The cheapest real hat is
reachable in ~1-2 runs (fast first win); the crown is a multi-session goal.
Server-side payout caps live in `shared/constants.js` MINIGAMES; keep client
`coinsForScore` honest so the cap never visibly truncates.

### Minigame design checklist
Every minigame ships with ALL of: instructions splash with visual legend ->
3-2-1 countdown -> escalating difficulty curve -> juicy moment-to-moment
feedback -> fail state that feels fair (hearts/strikes with invulnerability
frames, patience bars) -> results screen (score, coins, best, NEW BEST badge)
-> Play Again without leaving -> quit that always works (test it!). Mouse AND
keyboard where sensible. One-sentence pitch must be obvious in 5 seconds of
watching.

### Social-first world rules
- The world must never feel empty: server bots wander, chat room-flavored
  lines, migrate between rooms, and dance in the club.
- Everything cosmetic is visible to others (colors, hats, emotes): that is WHY
  players buy hats. Any new cosmetic must sync over the wire (see 'custom'
  message) or it does not exist socially.
- Low-friction interaction beats menus: walk into an exit to travel, click a
  player to see them, emotes on single keys (W wave, D dance, M map).

### Economy guardrails
- The server owns coins. Client requests, server clamps (per-run caps,
  rolling hourly backstop, minimum run duration). Never trust a reported
  score beyond what the caps allow.
- Prices form a ladder (50 / 80 / 120 / 150 / 250 / 300 / 350 / 400 / 800) so
  there is always a "next thing" 1-3 runs away.

### Adding a room (summary; full contract in CONTRACT.md)
1. Pick a mood + one star attraction + one minigame or social gimmick.
2. Block out ground (walkable = groundMeshes), keep the BOT_ZONE flat & open.
3. Dress: landmark, 15-25 props, critters, particles, sky/backdrop shell.
4. Wire exits (reciprocal spawns, `from_<room>` naming) + hotspots.
5. Lighting: hemisphere fill + ONE shadow directional (1024) + accent points.
6. Playtest: walk every path, read every sign from the camera, check spawn
   framing, check draw calls (~120 solo budget).

### Ideas parking lot (viable next features)
- Player cards on click (bests as achievements), friends list, party warp.
- Igloo-equivalent: personal decorated dens (rooms with placeable props).
- Seasonal re-dressing of rooms (the palette system makes this cheap).
- Puffle-equivalent pet: a snail/duckling that follows the player (one extra
  synced cosmetic slot).
- Fourth minigame slot: rhythm game in the club using the 126bpm clock.
- Daily login gift + rotating "featured hat" sale in the shop.
- Postcards: send a canvas-rendered postcard of your capy to another player.

## 3. Process lessons (how this was built)

- Contract-first parallelism works: freeze interfaces (CONTRACT.md), give one
  agent one file, integrate with a dedicated pass. The two integration bugs
  that existed lived in SHARED code (shadow-map dispose, avatar draw calls),
  not in any owned file: put your best reviewer on shared infrastructure.
- Numeric verification is not visual verification. Every layout bug that
  survived to playtest (upside-down-looking chairs, sign backs, spawn framing,
  bench pinch points) was invisible to code review and obvious in one
  screenshot. Capture every room from its actual spawns before shipping.
- Playtesting beats speculation for feel: balance numbers (patience timers,
  payout curves) were tuned from real runs, not design docs.
