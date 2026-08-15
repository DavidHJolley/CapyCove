# Capy Karts: the frozen design contract (wave K)

Owner: **K0**. **FROZEN.** K1/K2/K3 code against this file and never against each
other. Disagree with a number? Build it as written and say so in `concerns`.

Read CLAUDE.md, CONTRACT.md, DESIGN.md first; this only adds constraint.

- **K1** owns `src/world/rooms/speedway.js` — the walk-in room.
- **K2** owns `src/minigames/games/kart.js` — the race.
- **K3** owns `server/kart.js` + `test/kart.test.js`.
- Nobody here edits `server/index.js`, `shared/constants.js`, `src/net/client.js`,
  `src/ui/hud.js`, `src/world/rooms/plaza.js`, `src/core/audio.js` or the
  registries. Section 9 lists every insertion; report them verbatim.

Pitch: six capybaras, three laps, one beachside circuit. Nothing is named after
another racing game's characters, items or tracks.

---

## 1. The room `speedway`

**Capy Speedway** — a sun-bleached beachside circuit on the cove's south shore.
Beach palette (sand `0xf0dca0`, sea `0x4fb3e8`, cream) plus asphalt grey-violet
`0x5b5568`, coral/cream kerbs, gold `0xf2b64a` gantry. Bunting, deck chairs, a
snack cart, palm rows, gulls: a *village fete* that happens to own a racetrack.
No sponsors, no logos, no grit. The room is the **paddock only** — the circuit
lives in `kart.js` and is never built here; the room shows one decorative stretch
of the main straight along its north edge. Frozen (K1 dresses the rest):

```
id / class      'speedway' / export class SpeedwayRoom extends Room
track strip     decor, unwalkable: centred z=-13, 9 deep, x=-22..22
pit wall        obstacle line z=-10.6, tyre stacks every 3u from x=-18..18, r 0.9
walkable        x in [-17,17], z in [-10,16]; NOTHING walkable north of z=-10
spawn default   (0, 0, 3.5)      spawn from_plaza  (0, 0, 9.6)
BOT_ZONE        { x: 0, z: 3, r: 4.5 }  -- flat, empty, no props
cameraHint      { offset: (0, 12.5, 20), lookHeight: 1.6 }
staticCamera    { position: (0, 18.5, 25), lookAt: (0, 1.6, -1.5) }
```

Hotspots (exact ids):

```
race-join   (0,0,-7.2)   r 3.0  toggles kart-join / kart-leave; offline -> solo run
play-kart   (5.6,0,-6.2) r 2.6  'Take a practice lap'  -> __kartCtx=null; startMinigame('kart')
records     (-6.4,0,-6.2)r 2.2  'Read the lap records' -> toast game.state.bests.kart, play('ding')
exit-plaza  (0,0,13)     r 3.0  'Back to Sunny Plaza'  -> goToRoom('plaza','speedway')
```

`race-join`'s label is `Sign on for a race (n/6)` unqueued and `Leave the
sign-on sheet` queued — copy the peak's `_joinSpot` / `_onLobby` / `_joinLabel`
pattern wholesale, subscribed to `kart-lobby`.

**The jumbotron is the star attraction and the whole spectator experience.** A
9x5 canvas-textured board on the start gantry at `(0, 6.2, -12.4)` facing south
into the paddock (`rotation.y = 0`). K1 subscribes to `kart-board` (2 Hz, §4.9)
and repaints: race title, lap `n/3`, six rows `P1  Nibbles  L2` with AI rows
dimmed. Idle, it cycles "NEXT RACE — sign on at the pit wall" plus the roster.
That is the only race data the room touches.

**Racers stay in the room as ordinary avatars**, standing wherever they walked to,
exactly like a sled racer today. Do not hide, drive or park them on a grid: that
needs engine changes nobody owns this wave. The kart prop exists only inside
`kart.js`. Budget ~120 draw calls: instance tyre stacks, palms, crowd capys,
bunting, deck chairs; merge tarmac, kerbs, grandstand steps.

---

## 2. The circuit (K2 only — the server never sees it)

Closed **centripetal Catmull-Rom** loop, wrapping. `w` = FULL road width.

```
 i    x     z    w  |  i    x    z    w  |   i    x    z    w
 0  -60   -80   15  |  6   92    2   12  |  12  -30   50   11
 1  -20   -84   15  |  7   82   30   11  |  13  -56   40   12
 2   20   -84   15  |  8   62   48   10  |  14  -74   14   13
 3   56   -76   14  |  9   36   50   10  |  15  -80  -16   13
 4   84   -58   13  | 10   18   36    9  |  16  -76  -48   14
 5   95   -30   13  | 11   -4   44    9  |  17  -70  -68   15
```

Flat (`y = 0`); banking is faked with kerb geometry and camera roll. Width
interpolates with the same spline.

**Scale lock:** measure arc length `Lraw`, then multiply every control point by
`545 / Lraw` so the lap is exactly **`LAP_UNITS = 545`**. Both sides of the wire
assume that number. Build an arc-length LUT (~2u steps) giving
`posAt(s) -> {x, z, tangent, halfWidth}` and `sOf(x,z)`.

**Lap coordinates.** `S_FIN = 30.0` units along the spline from point 0 — the
finish line, with 90u of straight ahead of it and 31u behind.
- `u = (s - S_FIN + 545) mod 545`; **`q = u / 545` is the only lap value on the wire.**
- `lat` = lateral offset as a fraction of half-width. `0` centre, `±1` white
  line, `|lat| > 1.0` off-road, `±1.85` barrier. **Only lateral value on the wire.**
- `yaw` = kart heading MINUS track tangent at its `s`, wrapped to `−π..π`. Only
  rotation on the wire.

x/z are deliberately off the wire (they are `posAt` + `lat`), so `server/kart.js`
needs no track data at all.

**Grid**: rows at `u = 545-6`, `545-13`, `545-20`; `lat = -0.47` for slots
0/2/4 and `+0.47` for 1/3/5. Slot 0 is pole (§4.2 assigns them).

**Checkpoints**: `q = 0, 1/6, 2/6, 3/6, 4/6, 5/6`. K2 never sends these — the
server derives them from the `q` stream (§4.4).

**Item boxes**: eleven, frozen in `(q, lat)` so both sides agree without the
spline. Floating spinning cubes with a glowing capy-paw sigil, one InstancedMesh,
hidden individually while respawning.

```
row A  q 0.220  lat -0.62 -0.21 +0.21 +0.62   ids 0 1 2 3
row B  q 0.550  lat -0.45  0.00 +0.45         ids 4 5 6
row C  q 0.790  lat -0.62 -0.21 +0.21 +0.62   ids 7 8 9 10
```

Trackside decor, all instanced (one draw call per family): palms, tyre stacks,
hay bales, bunting arches, crowd capys at the hairpin and main straight, gulls,
a lighthouse on the coastal run, the start gantry. Road, kerbs and run-off
aprons are **three merged ribbons**, never per-segment meshes.

---

## 3. Feel numbers (K2 for the player, K3 for the AI). Frozen.

### 3.1 Driving
```
V_MAX 22.0 u/s        ACCEL 26 * (1 - v/V_MAX) u/s^2   (tau ~0.85s, 2.5s to 95%)
BRAKE 30 u/s^2        COAST_DRAG 6 u/s^2
REVERSE_MAX 6.0       REVERSE_ACCEL 12
off-road |lat|>1.0    V_MAX*0.55, +10 u/s^2 drag, 0.25-amp rumble
barrier |lat|>=1.85   clamp lat, speed *0.55, nudge back toward 0. NEVER a hard stop
STEER_MAX             2.6 * (1 - 0.55 * min(1, v/V_MAX)) rad/s  -> 2.6 at rest, 1.17 flat out
steer easing          lerp to key at 8/s (mouse: pointer x, 6% deadzone)
grip (vel -> facing)  k = 1 - exp(-9*dt); while drifting exp(-3.2*dt)
```

### 3.2 Drift and mini-turbo
Enter on the drift key going down while `v >= 8` and `|steer| >= 0.25`. Direction
locks to `sign(steer)` at entry and cannot flip. Yaw while drifting is
`(0.55 + 0.45*|steer|) * 2.0` rad/s in the locked direction: tighten or widen,
never reverse. Charge accrues 1.0/s while `v >= 8`, capped at 3.4 — no fourth tier.

```
tier  charge  spark colour            boost   target V
 1     0.9s   sky blue  0x4fb3e8      0.55s      26
 2     2.0s   gold      0xf2b64a      1.00s      29
 3     3.4s   coral     0xe8657a      1.60s      32
```

Boost = raise the speed target and multiply accel x2.2 for the duration, then
decay to `V_MAX` at `COAST_DRAG`. Drift cancels with **no** boost if `v < 6` for
0.35s, on any item hit, or after 0.5s continuously off-road. VFX: 60-instance
spark tetrahedra behind the inside rear wheel, `makeGlow(tier colour)`, 6 Hz
pulse, flash + `play('pop')` at each threshold; on release `play('whoosh')`, FOV
punch, 24 speed-line planes. Never name these tiers after another game's items.

### 3.3 Items — one held at a time; picking up while holding does nothing and does not consume the box
- **`peel` Melon Peel** — drops a hazard 3.5u behind you, lives 25s, hit at
  `Δq <= 0.004` and `|Δlat| <= 0.30`. Hit: 1.1s spin (two full turns), speed
  x0.35, steering locked, drift cancelled. Immune to your own for 0.8s.
- **`bubble` Splash Bubble** — fired forward at 34 u/s, mild homing (1.4 rad/s of
  `lat`) toward the nearest kart ahead within 60u, lives 4.0s, hits at
  `|Δlat| <= 0.34` as it passes. Hit: `V_MAX * 0.5` for 2.0s, soaked visual,
  **no spin** — the two hazards must read differently at a glance.
- **`berry` Zoom Berry** — instant self-boost, 1.3s at target 30. Combines with a
  drift boost by taking the *better* of the two: never additive, never above 34.

Roulette: 0.6s HUD spin, then lock. Weights by current place (gentle rubber band;
the leader still gets something useful):

```
place 1-2   peel 55%  bubble 30%  berry 15%
place 3-4   peel 35%  bubble 35%  berry 30%
place 5-6   peel 20%  bubble 35%  berry 45%
```
Box respawn: 5.0s after being taken.

### 3.4 Countdown, starts, laps
Lights: 3 red beats at 800ms then GO — `KART_LIGHTS_MS = 3200`. Controls dead
until `startAt`. Throttle held >200ms before `startAt` → **bog**: 1.2s of a
coughing, wobbling kart at `v <= 4` (silly, not punishing). Throttle first
pressed within 220ms after `startAt` → **rocket start**: 0.6s boost at target 26.
Three laps; the race clock starts at `startAt`.

### 3.5 Rubber-band AI (server-simulated, §4)
Base top speed by skill index `i = 0..4`: `19.0 + 0.55*i` → 19.0 … 21.2 u/s.
Additionally capped by a frozen 24-entry sector table indexed
`floor(q * 24)`, in u/s:

```
[22,22,22,22,18,19,20,20,19,16,12,13,15,14,17,16,18,20,21,21,21,19,21,22]
```

Rubber band against the leading **human** (fall back to the leading kart if every
human has dropped). `d` = that human's lap distance minus this AI's, in units,
positive when the AI is behind:
`behind -> mult = 1 + min(0.12, d/700)`; `ahead -> mult = 1 - min(0.10, -d/900)`.

**HARD LAW, and K3 must test it:** effective AI speed clamps to `[16.0, 21.8]`
u/s and AI "boosts" cap at 24.0 u/s for at most 1.0s. `21.8 < V_MAX 22.0` and
`24 < 32`, so an AI can never be faster than a player driving perfectly. There is
no catch-up that beats skill.

AI lateral bias in `[-0.45, +0.45]`, re-rolled every 60u, lerped at 0.6/s. An AI
never drops a peel within 20u ahead of a human, and never fires a bubble at a
kart more than 45u ahead. AI drift sparks on sectors capped below 17 are pure
flavour: no boost.

---

## 4. The `kart-*` protocol

Server-authoritative lifecycle, client-simulated driving, 10 Hz relay — the
sled's shape at higher fidelity. Every frame is `{ t: '<name>', ... }`. All of it
lives in `server/kart.js`; `server/index.js` only routes.

**Two decisions, frozen, do not revisit:**

1. **Hits are SERVER-ARBITRATED.** The server owns boxes, roulette results,
   hazard positions, projectile flight and every hit verdict, decided off the
   10 Hz `q`/`lat` stream. A client may play a *cosmetic* splash the instant it
   drives through a hazard it can see, but must not apply any speed or control
   penalty until `kart-hit` arrives, so a mispredicted hit never steals speed.
   Cost: a hit lands 50-150ms late for the victim. Accepted — the effect
   durations are long enough to hide it.
2. **AI is SERVER-SIMULATED, coarsely.** No lobby-leader delegation: a leader who
   rage-quits must not be able to freeze or warp five karts. The server advances
   each AI's `(q, lat, v)` at 10 Hz with the §3.5 model into the same
   `kart-state` frame; clients render them by evaluating the spline and
   interpolating between frames.

### 4.1 Lobby
`kart-join` / `kart-leave` (client→server, no payload), on the existing social
rate budget; refused unless `p.room === 'speedway'` and not already racing; max 6.
`kart-start-now` (client→server): any lobby member with >=1 signed on arms a 3s
pre-start. `kart-lobby` (server→**the whole speedway room**, on every change):
`{ players:[{id,name,color,hat}], starting:bool, startsAt:ms|null, max:6 }`.
Auto-start: full (6) → start in 3000ms; else the oldest sign-on waiting
`KART_WAIT_MS = 20000` → start with AI fill. Empty slots always fill with AI, so
every race is a six-kart race.

### 4.2 Grid
`kart-grid` (server→each racer, ~1200ms before the lights so clients can build):
```js
{ t:'kart-grid', race:'<id>', track:'cove-speedway/1', laps:3, sentAt:<Date.now()>,
  you:{ slot:2 },
  slots:[ { slot:0, id:'p_ab12'|null, ai:false, name:'Nibbles',
            color:0xb08a5a, hat:'beanie', skill:null }, ... 6 rows ] }
```
AI rows: `id:null, ai:true, skill:0..4`, name from a frozen cozy pool
(`Nibbles, Pebble, Marzipan, Waffles, Juniper, Tumble, Sprout, Biscuit, Clover,
Poppy`) that never collides with a human in the same race; colour from
`BODY_COLORS`, hat from `['none','beanie','cap','flower','chef']`. Order: humans
first in sign-on order (pole to the first to sign on), then AI by descending skill.

### 4.3 Go
`kart-go` (server→each racer): `{ race, startAt:<server ms>, now:<Date.now()> }`,
where `startAt = now + KART_LIGHTS_MS`. The client's skew estimate is
`now - <local receipt ms>`; it counts down to `startAt - skew`.

### 4.4 The 10 Hz relay
`kart-in` (client→server, 10 Hz, plus one extra right after a box or an item
use). Its own budget, **not** the social one: `KART_IN_LIMIT = 15/s`.
```js
{ t:'kart-in', q:0.41273, lat:-0.31, yaw:0.42, v:23.4, d:2, air:false }
```
`d` is drift state (`0` none, `1|2|3` charging at that tier). `v` drives engine
pitch and effects only; nothing is decided from it.

Server validation per frame, `dt` since that player's last accepted frame
(clamped to <= 1.5s):
- Forward `Δq` capped at `KART_MAX_Q_PER_S (0.075) * dt` (~40.9 u/s, safely above
  the 32 u/s boost ceiling). A larger jump is **clamped, not dropped**, and
  audited once per race per player. Backward `Δq` beyond `-0.02` (excluding the
  lap wrap) clamps to 0.
- `lat` clamped to `±1.9`, `yaw` wrapped, non-finite numbers reject the frame.
- Checkpoints derived here: crossing `q = k/6` forward sets bit `k`.
- A lap wrap (`q` falls from `>0.85` to `<0.15`) counts a lap **only if all six
  bits are set**, then resets them. That is the anti-cut rule, and the `Δq` clamp
  makes it unfakeable: a lap costs at least `1/0.075 = 13.3s` of continuous,
  in-sequence frames, so three laps cost at least ~40s.

`kart-state` (server→racers only, 10 Hz, one pre-serialised string):
```js
{ t:'kart-state', tick:412,
  k:[ { s:0, q:0.4127, lat:-0.31, yaw:0.42, v:23.4, d:2, l:1,
        it:'peel'|null, fx:'boost'|null, ghost:false }, ... ],
  pr:[ { i:7,  q:0.44, lat:0.10, by:2 } ],     // live bubbles (all of them)
  hz:[ { i:11, q:0.31, lat:-0.40, by:4 } ] }   // live peels within dq <= 0.25 ahead
```
`s` is the grid slot and is the in-race identity: **never put player ids in the
hot path.** `l` is laps completed.

### 4.5 Items
- `kart-box` (client→server) `{ box:0..10 }`. Accepted if the box is live, the
  player holds nothing, `|q - boxQ| <= 0.006` and `|lat - boxLat| <= 0.22`.
  → `kart-item` to that racer `{ item, box, at }`; → `kart-box` to all racers
  `{ box, taken:true, by:<slot>, respawnAt }`, and again at respawn
  `{ box, taken:false }`.
- `kart-use` (client→server) `{ }` — **no arguments**; the server decides from
  the item it knows they hold. Refused if they hold nothing.
  `peel` → `kart-haz { i, kind:'peel', q, lat, by:<slot>, ttl:25000 }`.
  `bubble` → a server-advanced projectile riding `pr` in `kart-state`; on expiry
  `kart-haz { i, gone:true }`. `berry` → `kart-fx { s, kind:'boost', ms:1300 }`.
- `kart-hit` (server→all racers)
  `{ s:<victim slot>, kind:'peel'|'bubble', by:<slot>, ms:1100|2000, i:<hazard id> }`.
  The victim applies the penalty on receipt; everyone else plays VFX. Hazards are
  one-shot: the server clears the hazard/projectile in the tick it declares the hit.

### 4.6 Laps and finish
`kart-lap` (→racers) `{ s, lap:1|2|3, ms:<since startAt>, best:bool }`.
`kart-fin` (→racers) `{ s, place:1..6, ms }` — placement is assigned by the
**server clock** the moment the third lap validates, first come first served;
tick order is the tiebreak, so ties are impossible.
`kart-end` (→racers) when everyone has finished, or `FINISH_GRACE_MS = 25000`
after the first finisher, or at `RACE_MAX_MS = 360000`:
```js
{ t:'kart-end', race,
  results:[ { s, id, name, ai, place, ms, laps, best:<best lap ms|null> } ] }
```
Unfinished karts are placed after every finisher, ordered by `laps + q` descending.

### 4.7 Reconnect and abandon
Disconnect, `kart-leave` mid-race, or leaving the room: the row flips to
`ai:true, ghost:true`, keeps the name and colours, and drives on at skill 2.
Clients grey a ghost to 40% opacity. **A ghost is never paid.** Reconnect: same
account within `KART_REJOIN_MS = 45000` while the race still runs →
`kart-resume { race, grid:<same kart-grid payload>, startAt, you:{slot}, lap, q,
laps }` and control returns; otherwise they are out and the ghost finishes for the
standings. A race with **zero** live humans ends immediately with no payouts.

### 4.8 Payouts
Coins ride the **normal minigame road**, not a server grant:
`game.startMinigame('kart')` arms the `mgstart` token (bound to
`MINIGAMES.kart.room === 'speedway'`, which is where racers already stand), and
the results screen calls `this.finish(score)` once.

```
score = 1000*(7 - place) + 40*laps + (fastestLapOfRace ? 200 : 0) + 10*boxes

coinsForScore -> PLACE[place] + 6*laps + (fastestLap ? 12 : 0) + 2*min(boxes, 6)
PLACE = { 1:110, 2:92, 3:78, 4:66, 5:56, 6:48 }
```
Honest maximum `110 + 18 + 12 + 12 = 152`, under the `maxCoinsPerRun: 160` the
orchestrator sets, so **the cap never truncates an honest run** (owner's law). A
ghost/DNF never calls `finish()` and is paid nothing. `server/kart.js` emits no
progression signal: the existing `score` signal covers the quest board, and a new
signal name would need `server/progress.js`, which nobody owns.

### 4.9 Spectators
`kart-board` (server→**the whole speedway room**, 2 Hz while a race runs, plus one
final frame with `over:true`):
```js
{ t:'kart-board', race, laps:3, over:false,
  rows:[ { s, n:'Nibbles', lap:2, q:0.41, ai:false, place:1 } ] }
```
The only race data a non-racer receives. K1 paints it on the jumbotron.

---

## 5. Practice / offline

`play-kart`, and `race-join` with no connection, run the **identical** game with
zero server frames: `kart.js` simulates all five AI locally with the §3.5 model
(same numbers, same sector table), owns its own boxes and hits, and still sends
`mgstart`/`best`/`score` when online. The handoff is `game.__kartCtx`: `null` =
practice, `{ race, grid, startAt, you }` = a real race, set by `speedway.js` on
`kart-grid` exactly the way the peak sets `__raceCtx`. K2 nulls it in `dispose()`
if it is still the same object.

---

## 6. Presentation checklist (K2 — this is the "AAA" bar)

Instructions splash with a visual legend → 3-2-1-GO lights → race → checkered
flag → a podium with the top three capys hopping on tiered blocks, confetti and
the coin payout counting up → best-lap "NEW BEST" badge → Play Again (re-arms
`mgstart`) → a quit button that always works.

**Camera**: kart position + `(0, 3.2, -7.0)` in kart space, lerp `1 - exp(-9*dt)`
(yaw `-6`, `-12` while drifting), looking at kart + `(0,1.3,0)` + forward*4.
FOV 62 → 72 on boost, lerp 6/s. Roll ±0.05 rad into a drift. Look-behind on `Q`.

**HUD**: place `1st…6th` big top-left with the six-name order beneath; lap `2/3`
top-right with lap timer and best lap; item card top-centre with the roulette
spin; **minimap bottom-right** — a 160x160 2D canvas with the centreline polyline
drawn once into an offscreen canvas plus six coloured dots (yours ringed white)
at 20 Hz.

**Juice**: speed lines, spark tiers, 0.35s / amp 0.5 screen shake on a hit, drift
smoke, a coin popup per box, a "FINAL LAP" banner, gulls scattering.

**Karts**: chassis 1.6 x 1.1 x 0.45, wheels r 0.32, body in the racer's avatar
colour, a numbered roundel on the nose, and `createAvatar({color, hat})` scaled
0.85 sitting in it with the legs tucked. One geometry set, six instances per part.

**Audio**: one sawtooth engine drone per kart (yours loudest), frequency
`80 + v*11` Hz through a lowpass; `pop` on a tier, `whoosh` on a boost, `splash`
on a bubble, `fail` on a spin, `ding` on a lap, `success` at the flag, `coin` on
the payout. K2 owns those nodes and **must** tear them down in `dispose()`
alongside `renderer.dispose()` + `forceContextLoss()`.

**Controls, keyboard and mouse**: throttle `W`/`↑`/hold left mouse; brake `S`/`↓`;
steer `A`/`D`/`←`/`→`/pointer x; drift hold `Shift` or `Space`; item `E`/right
mouse; look behind `Q`; `Esc` quits with a confirm.

**Performance**: one draw call per instanced family; road/kerb/run-off are three
merged ribbons; sparks, speed lines, confetti and crowd capys are instanced and
recycled, nothing allocated per frame; one `DirectionalLight` (1024 shadow map)
plus hemisphere fill, no other shadow casters. Same budget as the peak, which
carries a whole mountain.

---

## 7. K3's tests (`test/kart.test.js`, node:test, no new deps)

Each must fail if the rule breaks:
1. A lap counts only with all six checkpoints; a `q` stream skipping one does not
   advance the lap.
2. `Δq` above `0.075 * dt` is clamped, so three laps cannot complete faster than
   ~40s of wall clock.
3. AI effective speed never exceeds 21.8 u/s under any rubber-band input,
   including a human 500 units ahead.
4. `kart-box` is refused out of range, on a dead box, and while holding an item —
   and a refused pickup does not consume the box.
5. A hit is declared exactly once per hazard, and never on its own dropper within
   0.8s.
6. A mid-race disconnect produces a ghost that finishes and is not paid; a
   reconnect inside 45s restores control at the right slot.
7. `kart-join` from outside `speedway` is refused; the lobby caps at 6.
8. `kart.handleMessage` returns `false` for a `join` frame (observe, never
   consume) and `true` for every `kart-*` frame.

---

## 8. Orchestrator insertions (report these verbatim; do not make them yourselves)

**`shared/constants.js`**
1. `ROOM_IDS` — append `'speedway'`.
2. `ROOM_INFO` — `speedway: { name: 'Capy Speedway', desc: 'Six karts, three laps, one very smug capybara' },`
3. `MINIGAMES` — `kart: { name: 'Capy Karts', room: 'speedway', maxCoinsPerRun: 160, minRunMs: 40_000 },`
4. `BOT_ZONES` — `speedway: { x: 0, z: 3, r: 4.5 },`

**`server/index.js`** — four lines, all beside the `econ` ones
5. `import * as kart from './kart.js';` beside the `econ` import (~line 20).
6. `kart.install({ sendTo, broadcastToRoom, world, has, log, audit: audit.log });`
   beside `econ.install(...)` (~line 481).
7. `if (p && kart.handleMessage(p, m)) return;` **immediately after**
   `if (p && econ.handleMessage(p, m)) return;` (~line 2261). `kart.handleMessage`
   also *observes* `join` without consuming it, which is how a player leaving the
   speedway drops out of the lobby — no second insertion needed.
8. `kart.dropPlayer(p);` immediately after `econ.dropPlayer(p);` (~line 406).

**`src/world/index.js`**
9. `speedway: () => import('./rooms/speedway.js').then((m) => m.SpeedwayRoom),`

**`src/minigames/index.js`**
10. `kart: () => import('./games/kart.js').then((m) => m.KartGame),`

**`src/net/client.js`**
11. In the pass-through emit block: `case 'kart-lobby': case 'kart-grid':
    case 'kart-go': case 'kart-state': case 'kart-board': case 'kart-item':
    case 'kart-box': case 'kart-haz': case 'kart-hit': case 'kart-fx':
    case 'kart-lap': case 'kart-fin': case 'kart-end': case 'kart-resume':
    game.events.emit(m.t, m); break;`
12. In the socket-close handler beside the sled's lobby clear (~line 104):
    `this.game.events.emit('kart-lobby', { t: 'kart-lobby', players: [], starting: false });`

**`src/world/rooms/plaza.js`** — unowned this wave; this is the walk-in route
13. In `_buildGates`'s `gates` array:
    `{ to: 'speedway', x: -9.2, z: 9.2, name: 'Capy Speedway' },`
14. In `spawnPoints`: `from_speedway: new THREE.Vector3(-6.5, 0, 6.5),`

**`src/ui/hud.js`**
15. `MAP_SPOTS` — `{ id: 'speedway', bx: 30, by: 74, dir: 'up' },`. The pill needs
    the same pairwise-rect check that file's comment describes, and the painted
    island layer needs a speedway landmark blob: both are a verifier/orchestrator
    job, not a builder's.

**`src/core/audio.js`**
16. `TRACKS.speedway = TRACKS.beach;` — the speedway *is* beachside; a bespoke bed
    is out of scope this wave, and an unknown id would fade to silence.
17. `STEP_SURFACE` — `speedway: 'stone',` (tarmac).
18. `ROOM_CHORDS` — `speedway: [55, 59, 62, 67],` (Gadd, resolves into the beach bed).

**`CLAUDE.md`** — one registry paragraph for the `kart-*` family, per that file's
own "Adding a message" rule.
