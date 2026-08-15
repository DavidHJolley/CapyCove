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

---
---

# GRAND PRIX AMENDMENT (wave GP)

Owner: **GP0**. **FROZEN.** Sections 1-9 above are SHIPPED and are not rewritten;
where a number here disagrees with one above, this section wins and says so out
loud. GP1-GP4 code against this file, never against each other. Disagree with a
number? Build it as written and say so in `concerns`. Cozy capybara originals
ONLY — never another racing game's names, items, characters or track likenesses.

- **GP1** owns `src/minigames/games/kart-tracks.js` (NEW): the four track tables,
  the mesh/hazard/theme builders and the elevation sampler.
- **GP2** owns `src/minigames/games/kart.js`: physics (slopes, airtime, grip
  zones), the kart roster, hazard dodging, the speed-line fix, wrong-way
  detection, and integration of both new modules.
- **GP3** owns `src/minigames/games/kart-hud.js` (NEW): every race UI element,
  imported by kart.js through the frozen interface in §A7.
- **GP4** owns `server/kart.js` + `test/kart.test.js`: track metadata, the vote,
  per-track validation, AI on any track, the `kart` field, hazard arbitration.
- Nobody here edits `server/index.js`, `shared/constants.js`, `src/net/client.js`,
  `src/world/rooms/speedway.js`, `src/ui/hud.js` or `src/core/audio.js`. §A10
  lists the (very short) orchestrator list; report it verbatim.

**THE WIRE DOES NOT CHANGE SHAPE.** No new frame names, no new dispatch line, no
`shared/constants.js` edit. Everything below rides fields added to frames that
already exist. `q`/`lat`/`yaw` stay the only position values on the wire;
**elevation is CLIENT geometry derived from the track table** and never travels.

**DUPLICATION IS THE PATTERN, NOT A BUG.** `BOXES` already lives in both
`kart.js` and `server/kart.js` because both sides must agree without shipping a
spline. Every number frozen below (LAP_UNITS, boxes, hazards, checkpoints) is
copied from THIS DOCUMENT into both. Neither file imports the other.

---

## A1. The track registry

One row per track. GP1 exports `TRACKS` (full rows) from `kart-tracks.js` and is
the AUTHOR of every number in them; GP4 copies the **metadata subset**
(`id, LAP_UNITS, checkpoints, floors, minRunMs, itemBoxes, hazards, gridSlots,
aiSectors`) into `server/kart.js` and nothing else. **No mesh, no spline, no
theme, no `points` row ever reaches the server.**

```js
{
  id:        'sunny',                 // wire value; the vote and kart-grid use it
  name:      'Sunny Shores',          // display only
  theme:     'beach',                 // GP1's palette/decor/sky/weather bundle
  points:    [[x, y, z, width], ...], // 18-24 rows, CLOSED loop, y IS elevation
  LAP_UNITS: 545,                     // 3D arc length after the scale lock
  sFin:      30.0,                    // finish line, units from points[0]
  checkpoints: 6,                     // bits; crossing q = k/checkpoints sets k
  floors:    1,                       // road levels that cross over each other
  gridSlots: 'standard',              // §A1.3 — the same for all four tracks
  itemBoxes: [[q, lat], ...],         // exactly 11, frozen per track (§A1.2)
  hazards:   [ /* §A2 rows */ ],
  grip:      [ /* §A3 rows, CLIENT ONLY */ ],
  jumps:     [ /* §A3 rows, CLIENT ONLY */ ],
  minRunMs:  40_000,                  // this track's own honest floor (§A9)
  aiSectors: [ 24 numbers ],          // §3.5's table, re-authored per track
}
```

`aiSectors` is authored by GP1 next to the geometry that justifies it (a corner
is a corner in both files) and copied by GP4. Every entry sits in `[12, 22]` u/s
and at least four entries per track sit below 17, so the AI still lifts for the
corners the player lifts for. `sunny`'s table is the shipped one, unchanged.

**Scale lock, unchanged in spirit (§2), extended to 3D:** measure the arc length
of the authored points **including y**, then multiply x, y, z and width by
`LAP_UNITS / Lraw`. The LUT gains one column: `posAt(s) -> {x, y, z, tangent,
pitch, halfWidth}`, where `pitch = atan2(dy, ds_horizontal)`. `q = (s - sFin +
LAP_UNITS) mod LAP_UNITS / LAP_UNITS` exactly as before.

### A1.1 The four tracks

```
id        name            theme    LAP_UNITS  cps  floors  minRunMs  y range   skill focus
sunny     Sunny Shores    beach       545      6     1      36_000   0         (SHIPPED, unchanged)
summit    Frosty Peak     snow        600      8     1      39_000   -6..+22   grip + gradient
tangle    Tangle Ruins    jungle      575      8     2      37_500   -2..+14   dodging + nerve
glimmer   Glimmer Deep    mine        620      8     2      40_500  -10..+8    banking + airtime
```

`minRunMs` here is **0.9 x the arithmetic minimum** (`3 * LAP_UNITS / 40.9` s), a
sanity floor that can never bite a real run, not the minimum itself. Owner's law:
nothing is capped for honest play, so the floor sits below what is physically
possible rather than at it.

- **`sunny`** is the shipped beachside circuit. **Its id, its 18 control points,
  its `LAP_UNITS = 545`, its `sFin = 30.0`, its 6 checkpoints and its 11 box
  coordinates are unchanged, to the digit.** GP1 moves the existing table into
  `kart-tracks.js` verbatim with `y = 0` inserted; GP2 deletes its local copy.
  A run of `sunny` after this wave must feel identical to a run before it.
- **`summit` — Frosty Peak.** A sustained +6 % climb from q 0.05 to q 0.35
  (**AS-BUILT ~11 %, see §A1.4**), a
  hairpin at q 0.42 hanging over a drop behind a low ice wall, then a long
  descent with two compressions. Ice patches (§A3) are the hazard: nothing to
  hit, just grip to respect. Falling snow, blue-white palette (`0xdfeaf5` snow,
  `0x9fc4e0` shadow, lodge-window gold), pine rows, the cove's peak on the skyline.
- **`tangle` — Tangle Ruins.** Rolling elevation, never flat for 40 units. Two
  swinging vine gates, two rolling boulders (§A2). A ruin shortcut from q 0.61 to
  q 0.66, **narrow (halfWidth 3.2), unlit, ending in a blind step down**: it
  saves ~14 units of arc but costs speed on entry, so it is a nerve play, not
  free time. (**AS-BUILT: no shortcut and halfWidth 2.75, see §A1.4**: the
  nerve play is real, the saved arc is not representable.)
  Leaf green, wet stone, gold light shafts, parrot-bright accents.
- **`glimmer` — Glimmer Deep.** Banked curves (GP1 rolls the road ribbon up to
  0.30 rad at q 0.20 and q 0.75; banking is geometry + camera roll, never a
  physics term), three mine-cart crossings (§A2), and ONE big jump at q 0.51 with
  real airtime (§A3). Glow crystals (`makeGlow(0x42d6c8)` / `0x9b6bd4`), dark
  rock, lantern strings, no gloom: cozy cave, not a dungeon.

GP1 authors the control points; the scale lock makes them free as long as the
**final** `LAP_UNITS` matches the table. Every track is >= 545 units, so three
laps at the 40.9 u/s clamp still cost >= 40 s and the shipped
`minRunMs: 40_000` never truncates an honest run. (**AS-BUILT: sunny's three
laps work out at 39.976 s, 24 ms UNDER that 40 s claim, see §A1.4.** Nothing
honest is affected; the arithmetic is simply not exact.)

### A1.2 Item boxes, frozen per track

Eleven per track, always, in `(q, lat)`. `sunny` is unchanged.

```
sunny    A q 0.220 lat -0.62 -0.21 +0.21 +0.62 | B q 0.550 lat -0.45 0.00 +0.45 | C q 0.790 lat -0.62 -0.21 +0.21 +0.62
summit   A q 0.185 lat -0.60 -0.20 +0.20 +0.60 | B q 0.500 lat -0.44 0.00 +0.44 | C q 0.760 lat -0.60 -0.20 +0.20 +0.60
tangle   A q 0.140 lat -0.58 -0.19 +0.19 +0.58 | B q 0.430 lat -0.42 0.00 +0.42 | C q 0.820 lat -0.58 -0.19 +0.19 +0.58
glimmer  A q 0.230 lat -0.60 -0.20 +0.20 +0.60 | B q 0.580 lat -0.45 0.00 +0.45 | C q 0.860 lat -0.60 -0.20 +0.20 +0.60
```

Ids are 0..10 in the order written (row A first). `BOX_Q_TOL`, `BOX_Q_STALE` and
`BOX_LAT_TOL` are unchanged (§4.5).

### A1.3 Grid, checkpoints, clamps

- `gridSlots: 'standard'` for all four: rows at `u = LAP_UNITS - 6`,
  `LAP_UNITS - 13`, `LAP_UNITS - 20`; `lat = -0.47` for slots 0/2/4, `+0.47` for
  1/3/5. Slot 0 is pole. (§2, generalised off 545.)
- Checkpoints are `q = k / checkpoints` for `k = 0..checkpoints-1`. The anti-cut
  rule of §4.4 is otherwise untouched: all bits set at the wrap, or no lap.
- **`KART_MAX_Q_PER_S` becomes per-track:** `40.9 / LAP_UNITS`
  (`sunny` 0.0750, `summit` 0.0682, `tangle` 0.0711, `glimmer` 0.0660). The
  physical ceiling it defends is unchanged at 40.9 u/s, comfortably above the
  32 u/s boost ceiling and the 36.8 u/s downhill ceiling of §A3 (**AS-BUILT: the
  downhill ceiling is 25.3, see §A1.4**).
  `KART_MAX_BACK_Q` stays 0.02 on every track.

### A1.4 AS-BUILT corrections

Written by the wave GP fix pass, after the verifiers measured what shipped. The
rest of this amendment is the contract as frozen; the entries below are places
where a printed number could not be built as printed, and what is in the tree
instead. **These entries win over the prose above them.** Nothing here changes a
frozen table: `LAP_UNITS`, checkpoints, boxes, hazards, `minRunMs` and the y
ranges all shipped to the digit.

1. **`tangle`'s ruin is a narrow section, not a shortcut.** §A1.1 prints "saves
   ~14 units of arc". A shortcut cannot exist in the frozen wire model: `q` is
   single-valued progress along ONE spline, so an alternate line would need a
   second spline and a branch in the checkpoint rule, i.e. a wire change. GP1
   built the ruin's other four adjectives on the main line and that is correct:
   q 0.61-0.66, unlit, wet stone (`grip` 0.70), a step down at the exit. It
   costs speed and rewards commitment; it does not shorten the lap. A real
   shortcut needs a contract change, not a builder change.
2. **`tangle`'s ruin half-width is 2.75, not 3.2.** The authored full width is
   6.4 and the 3D scale lock multiplies it by `LAP_UNITS / Lraw` = 0.859 like
   every other width. Narrower than the printed number, in the direction the
   adjective wanted.
3. **`summit`'s climb is ~11 % average / 14.5 % peak, not +6 %.** The frozen
   y range (-6..+22) cannot be reached at 6 % over q 0.05-0.35: y climbs 19.7
   units over 180 units of road. The table wins over the prose and GP1 built the
   table. Its descent is about -20.8 %, `tangle`'s steepest about -27 %; both
   are inside §A3's `DOWNHILL_CEIL`, so nothing can warp. Related: the "hairpin
   at q 0.42" is a radius-30.7 bend at 0.42 whose real apex (radius 10.5) sits
   at q 0.437.
4. **`sunny`'s three laps cost 39.976 s, not ">= 40 s".** `3 * 545 / 40.9` =
   39.9756 s, 24 ms under the shipped `MINIGAMES.kart.minRunMs` of 40_000 in
   `shared/constants.js`. It could only bite a run that held the 40.9 u/s wire
   clamp for three unbroken laps, which no player can do (the boost ceiling is
   32 u/s), so no honest run is affected and the constant is left alone. The
   three NEW tracks all clear 40 s outright (44.0 / 42.2 / 45.5 s). GP1's test
   documents this arithmetic rather than asserting the false claim.
5. **§A1.3's "36.8 u/s downhill ceiling" is stale prose.** §A3 defines
   `DOWNHILL_CEIL = V_MAX * 1.15` = 25.3 and both `kart.js` and the tests
   implement 25.3. 25.3 is the authoritative number. (Gravity is added before
   the ceiling test, so v can overshoot by one frame's slope term, measured at
   25.31; harmless, and 15 u/s under the wire clamp.)
6. **§A4's vmax range floor of 22.00 is unreachable.** No kart in the frozen
   roster carries a vmax stat of 1, so the true shipped range is 22.44 (biscuit,
   fern) .. 23.76 (dart), and the DEFAULT kart `coco` is 22.88. Every value is
   still above the AI's 21.8, so §3.5's hard law holds with room to spare. Note
   the consequence for §A1.1's "a run of `sunny` must feel identical": the
   GEOMETRY is bit-identical (verified against `git HEAD`), but the default
   kart's top speed is 4 % above the shipped 22.0, because §A4 is also frozen
   and a kart has to be worth choosing. §A4 wins; §A1.1's "identical" means the
   circuit, not the roster.
7. **`aiSectors` is now enforced, not just asserted.** §A1 makes `kart-tracks.js`
   the author and `server/kart.js` a hand copy. The wave shipped 56 of 96
   entries diverged on summit/tangle/glimmer because each side only tested its
   own invariants. The server's three tables are now GP1's, byte for byte, and
   `tests/kart-tracks.test.mjs` diffs `trackMeta(id)` against the server row for
   all four tracks (id, LAP_UNITS, checkpoints, floors, laps, minRunMs,
   gridSlots, itemBoxes, hazards, aiSectors), so this class of drift cannot ship
   silently again. Copy direction: `kart-tracks.js` first, `server/kart.js`
   second.
8. **§A9's sanity floor zeroes the WHOLE race, not just the impossible time.**
   "a race whose winner's elapsed time falls below it parks a ZERO payout" is
   ambiguous; `server/kart.js` reads it as the race, so a clean 4th place is
   zeroed too when someone else's clock trips the floor. Unreachable in practice
   (every floor sits under its own arithmetic minimum: 36 s vs 39.98, 39 vs
   44.01, 37.5 vs 42.18, 40.5 vs 45.48), so it costs nothing today. If the floor
   is ever moved up toward the real minimum, decide this sentence first.
9. **The two `hazardHits` signatures differ in argument ORDER.** Client
   `hazardHits(h, q, lat, T, qSlack, latSlack)`, server
   `hazardHits(h, T, q, lat, slackQ, slackLat)`. Behaviour is identical (verified
   bit for bit over ~1M samples), but code moved between the two files must
   re-order the arguments or it will silently swap race time for lap progress.

---

## A2. Hazards you have to dodge — deterministic, no new wire traffic

Every moving hazard is a **pure function of race time**, so the client, the
server and every other client agree without a single extra byte. Frozen, and both
GP1/GP2 and GP4 implement exactly this:

```js
// T = race time in ms (client: raceMs; server: now - race.startAt). Never Date.now().
ph  = frac((T + h.off) / h.period)               // frac(v) = v - Math.floor(v)
w   = h.wave === 'saw' ? (1 - 2 * ph)            // +1 -> -1, then snaps
                       : Math.sin(2 * Math.PI * ph)
qAt   = frac(h.q   + h.dqAmp  * w)
latAt =      h.lat + h.latAmp * (h.psi ? Math.sin(2*Math.PI*ph + h.psi) : w)
```

A hazard row is `{ i, kind, q, lat, dqAmp, latAmp, psi, wave, period, off, hq, hl }`.
`kind` is cosmetic to the physics and decides only what GP1 builds:
`'vine'` (a swinging vine gate), `'boulder'` (a rolling stone), `'cart'` (a mine
cart on a crossing rail). Hit test, identical on both sides:

```
|dq(kart.q, qAt)| <= h.hq   AND   |kart.lat - latAt| <= h.hl
```

```
track    i  kind     q      lat    dqAmp  latAmp  psi   wave  period  off    hq     hl
tangle   0  vine    0.180   0.00   0      0.85    0     sin   3000    0      0.006  0.34
tangle   1  vine    0.205   0.00   0      0.85    PI    sin   3000    0      0.006  0.34
tangle   2  boulder 0.470  -0.35   0.055  0       0     saw   5200    0      0.006  0.40
tangle   3  boulder 0.470  +0.40   0.055  0       0     saw   5200    2600   0.006  0.40
tangle   4  vine    0.720   0.00   0      0.70    0     sin   2400    1200   0.006  0.30
glimmer  0  cart    0.310   0.00   0      1.30    0     sin   4000    0      0.007  0.42
glimmer  1  cart    0.315   0.00   0      1.30    PI    sin   4000    2000   0.007  0.42
glimmer  2  cart    0.660   0.00   0      1.10    0     sin   3200    800    0.007  0.42
sunny    -- no hazard rows --      summit  -- no hazard rows: its hazard is the ice (§A3) --
```

**Arbitration — how a static hazard hurts (the frozen decision):**
`kart-in` gains **one optional field**, `hz: <hazard index>`, sent on the extra
frame the client already fires after an event (§4.4). It is a *claim*, not a
verdict. The server recomputes `qAt`/`latAt` at its own `T`, re-runs the hit test
against the racer's last relayed `q`/`lat` with `hq * 2` / `hl * 1.3` of slack
for relay staleness, and only then declares the existing frame:

```js
{ t:'kart-hit', s:<victim slot>, kind:'haz', by:null, ms:900, i:<hazard index> }
```

- `by: null` — nobody threw it, so nobody is credited.
- The client may play a cosmetic bonk the instant it clips a vine and **must not**
  apply any speed or control penalty until `kart-hit` lands (§4 decision 1).
- A hazard is **not** one-shot (it keeps swinging), so the server also runs the
  test unprompted for every AI kart, and grants a victim `HAZ_IMMUNE_MS = 1200`
  of immunity from *all* static hazards so a boulder cannot chain-bonk one capy.
- Effect: `HAZ_HIT_MS = 900`, speed `x0.45`, a half-turn wobble, screen shake
  0.35s / amp 0.5, `play('fail')`. **Steering is NOT locked** — a hazard bonk
  must read differently from a peel spin (§3.3's "at a glance" rule).
- An unknown, out-of-range or repeated `hz` is ignored silently: never a refusal,
  never an audit line. Practice mode (§5) runs the same formula as its own arbiter.

---

## A3. Elevation, grip and airtime — client physics only

The wire is unchanged: `q`, `lat`, `yaw`, and the `air` flag that `kart-in`
already carries. Every number here is GP2's, applied on top of §3.1.

```
G_SLOPE        9.0 u/s^2      along-track acceleration = -G_SLOPE * sin(pitch)
DOWNHILL_CEIL  V_MAX * 1.15   (25.3) the fastest gravity alone may carry you
GRAVITY_AIR    18.0 u/s^2     vertical, while airborne
AIR_STEER      0.5 rad/s      the only yaw authority in the air; no accel, no drift
AIR_MIN_MS     450            shorter hops are not "airtime" and earn nothing
LAND_BOOST_MS  400            clean landing (|yaw - tangent| < 0.35 rad) -> target 25
LAND_HARD      |yaw| >= 0.9   -> speed x0.7, one wobble, no boost
```

Uphill costs speed, downhill gains it, both through `G_SLOPE`, and a descent
never exceeds `DOWNHILL_CEIL` — so 25.3 u/s is the ceiling gravity can reach,
far under the 40.9 u/s wire clamp, and a hill can never fake a warp.

**Grip zones (`grip` rows, client only, never a hit, never on the wire):**
`{ q0, q1, mul }` multiplies `GRIP` and `STEER_MAX` (never top speed) inside the
zone. Ice is a *feel*, so a cheat-proofing pass is not needed.

```
summit  {0.12,0.20,0.45} {0.38,0.44,0.40} {0.63,0.72,0.45} {0.86,0.91,0.50}
tangle  {0.61,0.66,0.70}   // the ruin shortcut is wet stone
glimmer {0.44,0.49,0.60}   // the run-up to the jump is dusted with grit
```

**Jump zones (`jumps` rows, client only):** `{ q0, q1, launch }` imparts `launch`
u/s of upward velocity at the lip. `glimmer: [{ q0:0.505, q1:0.520, launch:7.5 }]`
— about 0.85 s of air, which is the track's signature moment.

---

## A4. The kart roster — five sidegrades, equal totals, all free

Kart choice is **cosmetic-plus-feel and never power**: four stats, 1..5 each,
**every kart sums to 12**.

```
id        name              body style                 acc vmax han wgt  sum  availability
coco      Coconut Cruiser   round tub, husk fenders      3   3   3   3    12  free (default)
reef      Reef Racer        low wedge, coral fin         4   4   3   1    12  free
biscuit   Biscuit Barrel    stout barrel, crumb trim     2   2   3   5    12  free
dart      Dune Dart         needle nose, sand skis       3   5   3   1    12  10 races run
fern      Fernback          leafy buggy, frond spoiler   4   2   5   1    12  25 races run
```

Stat -> number, frozen (`s` is the 1..5 stat):

```
vmax  V_MAX  * (0.98 + 0.02*s)   22.00 .. 23.76   (AS-BUILT 22.44 .. 23.76, §A1.4)
acc   ACCEL  * (0.90 + 0.05*s)   24.7  .. 29.9
han   STEER_MAX and GRIP * (0.92 + 0.04*s)        0.96x .. 1.12x
wgt   off-road multiplier OFF_MUL + 0.03*(w-3); spin/bonk duration * (1 - 0.04*(w-3));
      landing tolerance LAND_HARD threshold + 0.05*(w-3) rad
```

**The hard law of §3.5 survives**: the *slowest* kart's `V_MAX` is 22.0, still
above the AI's absolute ceiling of 21.8. No kart choice can put a player below
the AI band.

**Unlocks are a ceremony, never a gate.** `dart` and `fern` unlock at 10 and 25
**races run** — finished, DNF or quit, any track, practice included. Placement
never matters and no coin ever buys a kart. The count is kept **client-side**
(`localStorage`, key `cove.kart.runs`, incremented once per `mount()`); the
server accepts any of the five ids from anybody, because five equal-total
sidegrades are not worth forging and a server-side unlock would need persistence
nobody owns this wave. Say it in the UI: "unlocks by playing, never by paying."

**On the wire:** `kart-join` gains `kart:'<id>'`; `kart-grid`'s slot rows gain
`kart:'<id>'`; `kart-lobby`'s player rows gain `kart:'<id>'`, so every client
renders everyone's kart on the grid and in the paddock. An unknown or missing id
is coerced to `'coco'` server-side. AI karts are assigned round-robin from the
five ids by grid slot, so the field is never five identical shells.

---

## A5. Track selection — a lobby vote on the frames that already exist

`kart-join` gains `track:'<id>'` alongside `kart`. Both are optional; missing
means `track:'sunny'`, `kart:'coco'`.

**A `kart-join` from a player already on the sheet is no longer refused**: it
UPDATES that player's `kart`/`track` preference in place, keeps their sign-on
order (pole is still first-to-sign-on), and rebroadcasts the lobby. It still
counts against `KART_SOCIAL_LIMIT`.

`kart-lobby` gains three fields:

```js
{ t:'kart-lobby',
  players:[{ id, name, color, hat, kart:'reef', track:'summit' }],
  votes:{ sunny:2, summit:1, tangle:0, glimmer:0 },   // ALL FOUR keys, always
  track:'sunny',                                       // what the race will use, live
  starting, startsAt, max }
```

**Plurality, ties by rotation.** `TRACK_ORDER = ['sunny','summit','tangle','glimmer']`.
The winner is the id with the most votes; on a tie, take the first tied id at or
after `S.rotate` in `TRACK_ORDER` (wrapping), then set
`S.rotate = (TRACK_ORDER.indexOf(winner) + 1) % 4` **when the race starts**, never
on a preference change. An empty lobby resolves to `TRACK_ORDER[S.rotate]`.

`kart-grid` gains `track:'<id>'` and `trackName:'<display name>'`, and its
existing `track:'cove-speedway/1'` opaque string is **replaced** by the registry
id (nothing read it as anything but a label). It also gains `laps` per track —
still 3 everywhere, but read it, do not assume it.

---

## A6. Wrong way

Client-side, in `kart.js`, no wire traffic. Detection: project the kart's world
velocity onto the track tangent at its current `s`.

```
WRONGWAY_MS       1200   ms of continuous negative projection before it fires
WRONGWAY_MIN_V     5.0   u/s — below walking pace it is a spin, not a mistake
WRONGWAY_CLEAR_MS  400   ms of positive projection before it clears (hysteresis)
WRONGWAY_LP_HZ     400   engine bus lowpass while it is on; music ducks -6 dB
```

Fires when `dot(velocity, tangent) < 0` **and** `speed >= WRONGWAY_MIN_V`
continuously for `WRONGWAY_MS`. Clears on `WRONGWAY_CLEAR_MS` of positive
projection, on `speed < 2.0`, or on any phase change. While on: a big readable
banner ("WRONG WAY"), a chunky arrow pointing along the track tangent (world-space
anchored, so it reads as "that way"), a slow red pulse on the vignette, and the
muffled audio sting. It is never a penalty — no speed loss, no lap effect. The
existing lap validation already makes driving backwards worthless.

---

## A7. The race UI — the AAA pass (`kart-hud.js`, GP3)

GP3 owns the craft; this freezes **what exists** and **the interface**. Every
class is prefixed `mg-kart-`; the module injects its own `<style>` and touches no
other file's DOM.

**Nine elements, all required:**

1. **Position tower** — the six-name order down the left with live gaps in
   seconds (`+1.4s`, `-0.8s`), your row highlighted, ghosts at 40 % with "away".
2. **Lap panel** — `2/3`, the running lap split, all completed splits stacked,
   and a **best-lap flash** (gold sweep + "NEW BEST") when one lands.
3. **Item slot** — the roulette spin (0.6 s, §3.3) then the lock, with the item's
   name and the use key.
4. **Speedometer arc** — a 220° sweep, needle plus numeric u/s, the needle tinting
   to the active drift tier's colour and overshooting into a boost band.
5. **Minimap with per-track elevation shading** — the centreline polyline painted
   once into an offscreen canvas, each segment shaded
   `0.35 + 0.65 * (y - yMin)/(yMax - yMin)` of the theme's road colour (a flat
   track shades flat), plus live dots (yours ringed white) at 20 Hz.
6. **Countdown lights** — five bulbs matching the gantry's five lamps, 3 red beats
   at 800 ms then green (`KART_LIGHTS_MS = 3200`, §3.4).
7. **Wrong-way banner + arrow** (§A6).
8. **Podium sequence** — top three capys hopping on tiered blocks, confetti, and
   the coin payout counting up digit by digit with a `coin` tick per step.
9. **Spectator/results cam furniture** — the results board, the Play Again and
   Quit buttons, and the track name + kart name of every finisher.

**The frozen interface (10 methods). GP2 calls only these:**

```js
import { KartHud } from './kart-hud.js';

const hud = new KartHud(rootEl, {
  laps, you,                                   // your grid slot
  track:  { id, name, theme, road: 0x5b5568, yMin, yMax, points:[{x,z,y}] },
  roster: [{ slot, name, color, kart, ai, ghost }],
});
hud.mount();                    // build DOM + <style>; idempotent
hud.setPhase(phase);            // 'splash'|'count'|'race'|'done'|'results'
hud.countdown(n, go);           // n = 3..1; go = true on the green
hud.update(view, dt);           // the view model below; called every frame, must be cheap
hud.item({ item, spinning, ms });
hud.lap({ lap, laps, splitMs, bestMs, best, final });   // final = the FINAL LAP banner
hud.wrongWay(on);
hud.toast(kind, text);          // 'coin'|'hit'|'boost'|'box'|'plain'
hud.results(payload);           // { rows, you, coins, score, best, newBest, trackName } -> podium + count-up
hud.dispose();                  // remove DOM, <style>, timers, listeners
```

```js
// view — reused object, never reallocated per frame
{ place, of, raceMs, lapMs, bestMs, v, vmax, boost, drift,     // drift 0|1|2|3
  order:   [{ slot, name, color, lap, gapMs, ghost, me }],
  karts:   [{ slot, q, lat, color, me, ghost }],
  boxes:   [{ q, lat, live }],
  hazards: [{ q, lat, kind }],
  wrong, wrongDir }        // wrongDir: screen-space radians for the arrow, 0 = up
```

`kart.js` keeps ownership of the 3D scene, the camera, the audio nodes and the
`Minigame` lifecycle; `kart-hud.js` owns **every DOM node inside the HUD** and
must leave `root` clean after `dispose()`. GP3 adds no `requestAnimationFrame`
loop of its own: `update()` is driven by GP2's existing loop.

**AS-BUILT clarifications (wave GP fix pass), so the seam is not read twice:**

- `countdown(n, go)` draws the five bulbs **and the numeral on them**, and the
  GO! callout on the green beat. `lap({final:true})` draws the **FINAL LAP**
  banner. The wave shipped with `kart.js` drawing all three as well, 3 % of
  viewport height apart. One owner per element: the HUD. `kart.js` keeps only
  the sounds (a `ding` per red beat, `success` on the green, `whoosh` on the
  final lap) and the finish-place shout, which the interface has no method for.
- `lap.lap` is the lap **just COMPLETED**, exactly as `kart-lap` means it on the
  wire (§4.6); the HUD steps the counter on itself. Do not pass the next lap.
- A best lap chimes ONCE, from the HUD's `onPlay('ding')` beside NEW BEST LAP;
  `kart.js` dings only on the ordinary laps.
- The interface has no way to feed the splash card its legend and its
  kart/track pickers, so `kart.js` keeps that ONE card in its own `mg-kk-*` DOM
  and hands the HUD a dedicated child element as its root. That is deliberate
  and is the only race-time DOM outside `kart-hud.js`.
- `kart.js` may extend the constructor options with `onAgain`/`onQuit`/`onPlay`
  and the `track` payload with `posOf`/`sFin`/`LAP_UNITS` (the minimap needs the
  finish-line origin); GP3 accepts and documents all six. Coordinated extension,
  not divergence.

---

## A8. The speed-line bug (GP2, `kart.js` FX layer)

**Streaks must stream OPPOSITE the kart's velocity in screen space.** The shipped
implementation places 24 camera-space planes on a ring around the lens centre at
a random angle `s.a` and slides them toward the camera, so they scatter radially
in every direction — which is what the owner reported and it is wrong at any
speed, worst when turning or looking behind.

The fix: project the kart's world velocity through the camera to a 2D screen
direction `d`, then lay every streak **along `-d`**, spawned across a band
perpendicular to it, with at most `±0.18 rad` of spread for life. When `|d|` is
near zero (dead ahead) fall back to "down the screen", never a random angle.
Look-behind (`Q`) flips the sign with the camera automatically. Opacity, count
and the boost bonus stay as shipped.

---

## A9. Payouts, validation, and the owner's law (GP4)

- The §4.8 payout table, `scoreFor`, `coinsFor` and the honest maximum of 152 are
  **unchanged on every track**. No track pays more; no kart pays more. Nothing
  here caps an honest run.
- `minRunMs` in the registry is the server's own per-race sanity floor (0.9x the
  arithmetic minimum, §A1.1): a race whose winner's elapsed time falls below it
  parks a ZERO payout and audits once under a new GP4-owned
  `OPS.FAST = 'kart.anomaly.fast'`. It sits below what is physically reachable,
  so it can only ever fire on something that did not happen. The global
  `MINIGAMES.kart.minRunMs = 40_000` in `shared/constants.js` is untouched.
- AI runs on every track: `aiSectors` is per-track, and `AI_SPEED_MIN 16.0`,
  `AI_SPEED_MAX 21.8`, `AI_BOOST_MAX 24.0`, `AI_BOOST_MS 1000` are **unchanged
  and still the hard law on all four tracks**. An AI is never faster than a
  player driving well, anywhere.

**GP4's new tests (added to the eight in §7, same style, no new deps):**

9.  Each of the four registry rows has 11 boxes, a `checkpoints` count that
    divides its lap cleanly, and `LAP_UNITS >= 545`.
10. A lap on `glimmer` needs all EIGHT checkpoints; a stream skipping one does
    not advance the lap.
11. `40.9 / LAP_UNITS` clamping holds per track: on every track, three laps
    cannot complete faster than `3 * LAP_UNITS / 40.9` seconds, which is strictly
    above that track's `minRunMs`.
12. The vote resolves plurality; a 2-2 tie resolves by rotation and the rotation
    advances only on race start.
13. A `kart-join` from a player already on the sheet updates `kart`/`track`
    without changing sign-on order or duplicating the row.
14. A `kart-in` carrying an `hz` the server's own recomputation rejects declares
    NO hit; a valid one declares exactly one, with `by: null`, and a second claim
    inside `HAZ_IMMUNE_MS` declares nothing.
15. An unknown `kart` id is coerced to `'coco'` and never reaches `kart-grid` raw.

---

## A10. Orchestrator insertions (report verbatim; do not make them yourselves)

Deliberately almost empty — the amendment was designed to need no shared-file
edits. **No `shared/constants.js` change. No `server/index.js` change. No
`src/net/client.js` change. No registry change** (`kart-tracks.js` and
`kart-hud.js` are imported by `kart.js`, not by the minigame registry).

1. **`CLAUDE.md`**, appended to the shipped Capy Karts paragraph:
   "Wave GP (grand prix): FOUR tracks (`sunny`, `summit`, `tangle`, `glimmer`,
   docs/KARTS.md GRAND PRIX AMENDMENT); elevation is CLIENT geometry from the
   track table and never rides the wire (still q/lat/yaw). No new frames: the
   track vote and the kart choice ride `kart-join` {kart, track} and echo on
   `kart-lobby` {players[].kart, players[].track, votes, track} and `kart-grid`
   {track, trackName, slots[].kart}; a repeat `kart-join` from a lobby member
   updates the preference instead of being refused. Static hazards are
   deterministic functions of race time (frozen phase formula); a client claims
   one through an optional `hz` field on `kart-in` and the server arbitrates,
   answering on the existing `kart-hit` with `kind:'haz'`, `by:null`. Five karts
   are equal-total sidegrades, all free, two unlocked by races run (client-side
   ceremony, never an economy gate)."
2. **`docs/KARTS.md`** §8's insertion list stays true as shipped; this amendment
   adds nothing to it.
