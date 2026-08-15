# Live ops for Capy Cove: the machinery a one-person world needs

Research deliverable, 2026-08-14. Role: live-ops designer, the person who has to
keep this island interesting in week 6 with no content team.

**How to read this.** Everything marked *(evidence)* points at a file and line
in this repo or at the prior audit. Everything marked *(judgment)* is a design
call I am making and defending; disagree with it in writing. Nothing here is
implemented: this document is a spec plus a build order.

**Scope boundary.** `docs/AUDIT.md` already tasks the launch blockers (durability
F-1/F-2, trust and safety F-21..25, economy anti-cheat F-11..14, tests F-44).
I do not re-litigate them, but three of them are *hard prerequisites* for things
in here and I say so where they bite. In particular: the newspaper prints player
names, which is a moderation surface, and community goals aggregate coin faucets,
which is an anti-cheat surface.

---

## 0. The ranked answer

Retention-per-cost. "Cost" is one person's time; S is under two days, M is under
two weeks, L is longer. Ordered by what I would actually build first.

| # | Thing | Cost | Retention effect | Why this rank |
|---|---|---|---|---|
| 1 | **Events calendar** (`data/calendar.json` + `server/events.js` + one wire frame) | M | High, compounding | Every later system (seasons, goals, the paper, even the shop rotation) becomes *scheduling* instead of *engineering*. Build the bus first. |
| 2 | **Aggregate stats collector** (one tee off `signal()`/`grantCoins`) | S | Indirect but gates 3 and 5 | The newspaper cannot exist without it and neither can the weekly metrics. It is ~120 lines and unlocks two systems. |
| 3 | **The Cove Courier** (weekly paper on the notice board) | M | High, and it is the habit anchor | Club Penguin's most underrated tool for a reason: it makes "the world changed while you were gone" legible, and it names players. Cheap once 2 exists. |
| 4 | **Weekly owner report** (`npm run report` over the same log) | S | None directly, high leverage | You cannot steer what you cannot see. Currently there is nothing (F-45). |
| 5 | **Community goals** (island-wide bar, one at a time) | M | Medium-high, spiky | Best single generator of "log in tonight, we are close". Needs the events bus to schedule and the stats layer to count. |
| 6 | **Seasonal decor pipeline** (decor layers keyed off the calendar) | M | Medium, but it is the *visible* proof the world is alive | Highest perceived-effort-per-real-effort of anything here, once the anchor contract exists. |
| 7 | **Rotating shop stock driven by the calendar** | S | Medium (economy sink, F-27) | Nearly free once 1 exists, and it is the audit's own top economy fix. |
| 8 | **Event-routed citizens** (bots show up where the event is) | S | Low-medium | Stops the "event started and the room is empty" failure at low population. |

**Everything below assumes the events bus.** If only one thing gets built, build
item 1 and hand-schedule the rest.

---

## 1. What is already there

The good news is that this codebase is unusually ready for live ops. Seven hooks
exist and four of them are exactly the shapes I would have asked for.

**1. An island-wide broadcast.** `broadcastAll(msg)` at `server/index.js:272`
fans one frame to every connected socket regardless of room. Parties already use
it (`server/index.js:1848`). *(evidence)*

**2. A server heartbeat that already does live-ops work.** The clock interval at
`server/index.js:2850` runs every `CLOCK_MS` (10s default, env-overridable) and
already drives: `updateClock()`, `broadcastAll(clockFrame())`, bot schedules,
`bonfireTick`, `partyTick`, mural map pruning, and `progress.tick()`. An event
scheduler belongs in exactly this interval and needs no new timer. *(evidence)*

**3. The "arrive already running" pattern.** `joinRoom()` sends `clockFrame()`
then `partiesFrame()` on every room join (`server/index.js:351-353`), and `hello`
sends both again (`server/index.js:2234-2237`). This is the single most important
convention in the file for live ops: **any world-state frame must be sent on
join, not only on change**, or a player who arrives mid-event sees nothing. Copy
it verbatim. *(evidence)*

**4. A room-side time hook with the full frame attached.** `engine.applyClock(m)`
(`src/core/engine.js:289`) calls `room.onClock(dayT, weather, aurora, m)` and
passes the **whole frame** as a fourth argument, deliberately, so rooms can read
extras (`peak` reads `m.snow`). Rooms are also rebuilt from scratch on every
visit (`CONTRACT.md:69`) and can be rebuilt in place via `engine.rebuildRoom()`
(`src/core/engine.js:304`). Together those two facts are the entire seasonal
dressing story: a room can read event state at build time *and* react live.
*(evidence)*

**5. A single, defended coin road.** `grantCoins(p, amount, reason)`
(`server/index.js:400`) is the only function that mints coins, it applies the
rolling hourly backstop, and **every call site passes a distinctive `reason`
string**: `'race win'`, `'match win'`, `'mining'`, `'gem!'`, `'doodle podium'`,
`'bonfire'`, `'message in a bottle'`, the minigame id itself (`server/index.js:2327`),
and quest names from `server/progress.js:691`. A double-coin event is therefore
a *filtered multiplier on one function*, not a change to ten payout sites.
*(evidence)*

**6. A single funnel for every meaningful player action.** `signal(name, p, data)`
(`server/index.js:426`) is called at every scoring moment and forwards to
`progress.signal()`. The name list is stable and documented at the top of
`server/progress.js:13-15`. This is the tap for aggregate stats and for metrics:
one wrap, everything counted. *(evidence)*

**7. A proven module contract for bolting a subsystem onto the server.**
`server/progress.js` is installed with `install(ctx)`, gets first refusal on
frames via `handleMessage(p, m)` (`server/index.js:2178`), receives `signal()`
and `tick(dt, clockFrame)`, and is wrapped so a throw inside it can never cost a
player their frame (`server/index.js:426-431`). **Every new live-ops module in
this document uses that exact shape.** It is the only pattern here that an agent
wave has already proved. *(evidence)*

### And four things that are missing

**A. No aggregate anything.** Every counter in the game is per-account, stored in
`rec.progress.c` (`server/progress.js:461-469`): `runs`, `byGame`, `wins`,
`winsBy`, `races`, `raceWins`, `digs`, `gems`, `hosted`, `attended`, `mural`,
`chats`, `waves`, `doodles`, `bottles`, `snow`, `ball`, `bonfire`, `whale`,
`driftMs`, `days`. There is not one server-wide number anywhere, not even a
lifetime coin total. `/api/health` returns `{ok, online, rooms}` and nothing
else (`server/index.js:209`). *(evidence, and it is the root cause of both the
newspaper gap and F-45.)*

**B. No admin surface at all.** `isAdmin()` in `src/main.js:183` is a
`/^david/i` test on the *display name*, client-side, gating the layout editor.
It is a tasked launch blocker (`CLAUDE.md:141-153`, audit F-15, session task 13).
There is no server `admin` flag, no admin frame, no ops console. *(evidence)*

**C. Two clocks, and the live-ops one does not exist.** The world clock is a
40-minute cove day (`COVE_DAY_MS`, `server/index.js:84`); `clock.day` is a
40-minute index, not a calendar day. "Daily" quests therefore reroll every 40
minutes, which `server/progress.js:54-61` acknowledges in writing. Meanwhile
`touchDate()` (`server/progress.js:566-569`) counts *real* calendar dates for the
`regular`/`veteran` stamps. **Live ops must run on the wall clock, in one named
timezone, and must never read `clock.day`.** *(evidence for the split; the
recommendation is judgment.)*

**D. No re-engagement channel, and I am not going to invent one.** No email is
collected (audit §3.4, §3.6 F-28). That is a genuine privacy virtue and it makes
the F-25 compliance path shorter. It also means **nothing in this document can
pull a lapsed player back.** Everything here works on people who are already
returning: it makes their return worth more and makes the *rhythm* of returning
legible. Say that out loud when judging these systems. *(judgment)*

---

## 2. The events system

### 2.1 The principle: the calendar is data, the effects are a fixed vocabulary

The failure mode for one-person live ops is that every event is a code change,
which means every event is a deploy, a regression risk and an evening. The fix is
a **closed vocabulary of effects** that the server knows how to apply, and a JSON
file that composes them. If a proposed event cannot be expressed in the
vocabulary, it is not an event: it is a feature, and it goes through a normal
agent wave which then *adds a verb to the vocabulary*. *(judgment)*

Concretely: "double coin hour" is `{"coins": {"mult": 2, "reasons": [...]}}`.
"Aurora watch party" is a scheduled forced-aurora window plus a toast plus a
decor layer on `peak`. "Visiting whale day" is a spawn flag The Drift reads.
None of those need new code after the first pass.

### 2.2 `data/calendar.json`

One file, hand-editable, hot-reloaded. Schema:

```jsonc
{
  "version": 1,
  "tz": "America/New_York",          // ALL times below are in this zone
  "events": [
    {
      "id": "double-coins-fri",       // stable, unique; the wire key and the dedupe key
      "name": "Golden Hour",          // player-facing
      "blurb": "Every game pays double until 9pm.",
      "icon": "coin",                 // from a fixed client icon set, never a URL
      "when": { "rrule": "FRI", "start": "20:00", "durMin": 60 },
      "rooms": ["*"],                 // where the banner/decor applies
      "effects": {
        "coins": { "mult": 2, "reasons": ["fishing","sled","smoothie","pong","shuffle",
                                          "chess","connect4","cards","prophunt","doodle",
                                          "race win","match win","doodle podium"] }
      },
      "announce": { "leadMin": 10, "startMsg": "Golden Hour! Every game pays double for an hour.",
                    "endMsg": "Golden Hour is over. Nicely played." }
    },
    {
      "id": "aurora-watch",
      "name": "Aurora Watch",
      "when": { "rrule": "WED", "start": "21:30", "durMin": 45 },
      "rooms": ["peak"],
      "effects": {
        "sky":   { "aurora": true },            // forces the clock's aurora flag
        "decor": { "peak": "aurora-watch" },    // a decor layer id, see §3
        "bots":  { "route": "peak", "share": 0.6 }
      }
    },
    {
      "id": "mural-week-summer",
      "name": "Mural Theme Week: Summer",
      "when": { "start": "2026-06-01T00:00", "end": "2026-06-08T00:00" },
      "rooms": ["plaza"],
      "effects": {
        "notice": { "headline": "This week's mural theme: SUMMER.",
                    "body": "Paint the cove in sand and sea. The Courier prints the best corner on Friday." },
        "mural":  { "cooldownMs": 12000 }        // faster brush during a theme week
      }
    },
    {
      "id": "whale-day",
      "when": { "rrule": "SUN", "start": "14:00", "durMin": 240 },
      "rooms": ["drift"],
      "effects": { "flag": { "drift.bigblue.surface": "often" } }
    }
  ],
  "oneoffs": []                        // written by the admin path, §2.8
}
```

Notes on the schema, all deliberate:

- **`when` supports exactly three forms** and no more: `{rrule: "<DAY|DAILY>",
  start, durMin}` for weekly/daily recurrence, `{start, end}` ISO local for
  one-offs, and `{rrule: "MONTHLY", day: 1, ...}`. Do not build a cron parser.
  *(judgment: an rrule dialect is a week of work and a bug farm.)*
- **`rooms` is presentation, not enforcement.** Effects name their own targets.
  `rooms` decides who sees the banner and which rooms get decor.
- **`effects` keys are the vocabulary.** Unknown keys are ignored with one
  `console.warn` at load, never a throw. A calendar that is one version ahead of
  the server must still boot.
- **No effect may reference a file path, a URL, or arbitrary code.** The calendar
  is data the operator edits at 1am; it must not be able to break the process.

### 2.3 `server/events.js`

Mirror `server/progress.js` exactly, because that contract is proven
(`server/index.js:418, 426, 2178, 2847`):

```js
install(ctx)                 // { users, saveSoon, grantCoins, sendTo, broadcastAll,
                             //   broadcastToRoom, world, has, bots }
tick(nowMs)                  // called from the CLOCK_MS interval, index.js:2850
frame()                      // the {t:'events'} payload, for join + hello parity
handleMessage(p, m)          // {t:'events'} read; admin ops (§2.8); returns true if consumed
coinMult(p, reason)          // 1 by default; grantCoins multiplies by this
flag(name)                   // string|null: room-readable feature flags
isActive(id)                 // for anything that wants to ask
```

Wiring into `server/index.js` is five lines and every one of them copies an
existing line:

1. `import * as events from './events.js'` and `events.install({...})` next to
   `progress.install` (`server/index.js:418`).
2. In the clock interval (`:2850`), inside its own try/catch, `events.tick(Date.now())`.
3. In `joinRoom()` next to `sendTo(p, partiesFrame())` (`:353`), `sendTo(p, events.frame())`.
4. In the `hello` handler next to the same pair (`:2234-2237`), the same line.
5. In `grantCoins()` (`:400`), after the payout is computed and **before** the
   hourly backstop check: `const payout = base * events.coinMult(p, reason)`.

Point 5 is the whole economy safety story and it is worth being precise about.
`clampCoinsForGame()` has already run at the score handler (`server/index.js:2327`),
so the per-run cap is applied to the honest score and the multiplier rides on top
of a clamped number. `MAX_COINS_PER_HOUR` (12,000) still bounds the total, and
the audit's recommended *daily* cap (F-11 fix 13) still bounds the day. A
2x event therefore cannot widen the cheat surface: it moves honest players closer
to a ceiling that a cheater was already hitting. *(judgment, grounded in
`server/index.js:400-415`.)*

**`reasons` must be an allowlist, never a blanket multiplier.** `'mining'` and
`'gem!'` are AFK income (`server/index.js:930`) and the audit is already unhappy
that idling is the dominant strategy for a disengaged player (§3.5). Doubling AFK
income teaches exactly the wrong habit. Ship Golden Hour with the ten minigame
ids plus the three win bonuses, and leave `'mining'`, `'bonfire'` and
`'message in a bottle'` off the list permanently. *(judgment)*

### 2.4 The wire frame

```js
// server -> client, on hello, on every room join, and on any change
{
  t: 'events',
  now: 1786000000000,              // server clock, so clients stop guessing
  active: [
    { id, name, blurb, icon, rooms, endsAt, endsIn,   // endsIn seconds, like partyPublic
      badge: 'coins2x'|'aurora'|'goal'|null }
  ],
  next: { id, name, startsAt, startsIn } | null       // powers "starts in 10 min"
}
```

Two conventions lifted straight from the party frame (`server/index.js:1743-1766`):
carry **both** `endsAt` and `endsIn` so a client that arrives twenty minutes in
gets ten minutes of countdown rather than a fresh thirty; and **say "nothing is
on" out loud** (`active: []`) rather than going silent, so a stale banner always
clears. *(evidence for the pattern, applied here.)*

Client side, this is three touches:
- `src/net/client.js`: add `'events'` to the raw re-emit case list at `:308-312`.
  It is literally one word in an existing `case` chain.
- `src/ui/hud.js`: an event pill next to the room chip, and a lead-in toast. The
  party state machine at `hud.js:533-580` is the model; the map beacon painter at
  `hud.js:2035` is where a themed room pill would go.
- Rooms: `onEvent()`, §3.

### 2.5 The effect vocabulary (v1)

| Key | Shape | Applied by | Notes |
|---|---|---|---|
| `coins` | `{mult, reasons[]}` | `grantCoins` via `events.coinMult` | Allowlist only. Cap `mult` at 3 in the loader. |
| `sky` | `{aurora: true, weather: 'rain'}` | `updateClock()` override | Force-set after the Markov walk, so it survives the roll. Aurora is already broadcast to everyone (`server/index.js:1481`). |
| `decor` | `{roomId: layerId}` | client, §3 | The only client-side effect. |
| `flag` | `{"name": "value"}` | any room or module via `events.flag()` | The escape hatch. Keep it tiny and namespaced. |
| `notice` | `{headline, body}` | notice board / Courier | Also the "no-code event": a headline alone is a valid event. |
| `bots` | `{route: roomId, share: 0..1}` | `BotManager` | See §2.7. |
| `shop` | `{featured: hatId, discount: 0..0.5}` | `buy` handler (`server/index.js:2341`) | The audit's F-27 fix 1, for free. |
| `mural` | `{cooldownMs}` | `paintMural` (`server/index.js:2000`) | Theme weeks want a faster brush. Floor it at 5s. |
| `quest` | `{extra: questId}` | `progress.js` board build | A fourth, event-only daily. Needs one new field in `pickDaily` (`server/progress.js:192`). |
| `goal` | `{id}` | community goals, §4 | Events are how goals start and stop. |

That is nine verbs. Nine verbs cover, without new code: double coin hour, aurora
watch party, snowball tournament (a `notice` plus a `goal` counting `snow`
signals plus a `bots` route to `peak`), mural theme weeks, visiting whale day,
featured-hat weeks, den-crawl weekends, and a "quiet Sunday" where nothing
happens except a headline. *(judgment)*

### 2.6 Rooms react: `onEvent`

Add one optional room method, shaped exactly like `onClock`:

```js
// src/world/room.js, alongside onClock's implicit contract
onEvent(active, flags) {}   // active: [{id, badge, decor}], flags: {name: value}
```

Engine side, next to `applyClock` (`src/core/engine.js:289`):

```js
applyEvents(m) {
  this.lastEvents = m;
  if (this.room?.onEvent) { try { this.room.onEvent(m.active, m.flags); } catch (e) { ... } }
}
```

...and call it in the same three places `onClock` is called: after `build`
(`engine.js:203`), on every frame (`applyEvents`), and after `rebuildRoom`
(`engine.js:323`). The engine already caches `lastClock` for exactly this reason;
cache `lastEvents` the same way so a room built mid-event is *born* decorated
rather than snapping into it a frame later. *(evidence: the `lastClock` pattern
at `engine.js:203-207` exists because that snap was a real bug.)*

### 2.7 Bots as event dressing

`BotManager.schedule(bot)` (`server/bots.js:147`) already returns
`{room, post}` from `clock.dayT`, and `setClock()` is called every tick
(`server/index.js:2854`). Add `setEventRoute(roomId, share)`: while set, that
share of citizens returns the event room from `schedule()` and the rest keep
their normal schedule. The jitter machinery (`JITTER_T`, `server/bots.js:57-62`)
already staggers arrivals so they do not march in lockstep.

This matters more than it sounds. The single worst live-ops experience in a small
world is an announced event in an empty room, and the launch plan is
`COVE_BOTS=0` (`server/index.js:286`). **Recommendation:** run events with a
small bot presence even after launch, or accept that events below ~15 CCU will
sometimes look abandoned. If bots stay off, the mitigation is scheduling: fewer
events, at one fixed hour, so the population concentrates. *(judgment)*

### 2.8 Admin: the calendar file *is* the panel, until it is not

**v0 (ship this):** the operator edits `data/calendar.json` and the server
hot-reloads it. `fs.watch` with a 500ms debounce, parse into a shadow object,
validate, and swap only on success; on a parse error keep the running calendar
and log loudly. Zero UI, zero auth surface, zero new attack surface, and it is
correct at 1am from a phone over SSH. *(judgment)*

**v0.5 (one-offs, same day):** two admin ws frames, gated on a **real** server-side
`admin` flag on the user record, which the tasked F-15 fix has to add anyway
(session task 13, `CLAUDE.md:141-153`):

```
{t:'admin-event', op:'start', id, name, blurb, durMin, effects}   // ad-hoc, not persisted to the file
{t:'admin-event', op:'stop', id}
{t:'admin-say', msg}                                              // island-wide toast
```

Rules: reject unless `rec.admin === true`; every op is logged with the admin's
username and the payload; `effects` runs through the *same* validator as the file,
so an admin cannot ship an effect the calendar cannot express; one-offs live in
memory plus an append to `calendar.json.oneoffs` so a restart does not silently
cancel an event mid-flight. **Do not build an admin web panel before launch.** An
authenticated HTML admin surface is a new session-management problem on a server
whose auth is a hand-rolled token (audit F-16) and whose only current gate is a
name regex. Two ws ops and a JSON file are the whole requirement. *(judgment,
grounded in audit F-15/F-16.)*

### 2.9 The launch calendar I would actually ship

Twelve weeks, one file, roughly two hours of authoring. The point is **rhythm**,
not variety: players should be able to learn the week without reading anything.
*(judgment)*

| Day | Event | Effects used |
|---|---|---|
| Mon | *(nothing)* | The quiet day matters. A world with something on every night has nothing special on any night. |
| Tue | Den Crawl, 8pm | `notice` + an event quest ("visit three dens") |
| Wed | Aurora Watch, 9:30pm | `sky` + `decor` + `bots` |
| Thu | Snowball Tournament, 8pm | `goal` (island snowball count) + `bots` + `notice` |
| Fri | **Golden Hour**, 8pm | `coins` |
| Sat | Whale Day, 2pm (4h) | `flag` |
| Sun | **The Courier prints**, 10am | `notice` (§5) |
| Weekly | Featured hat rotates Sunday | `shop` |
| Monthly | Mural Theme Week | `mural` + `notice` |

Two anchors (Friday night, Sunday morning) and five smaller beats. Anchors are
what a habit attaches to; everything else is texture.

---

## 3. The seasonal content pipeline

### 3.1 The honest constraint

The brief asks for "a holiday reskin without touching room code". Given
`DESIGN.md:10-14` (everything is procedural: geometry from primitives, textures
drawn on canvas, no external assets, ever) a *reskin is code*. There is no asset
to swap. Anyone who promises a pure-data seasonal pipeline here is promising a
level editor, and that is an L-sized project that would then need its own art
tooling. *(judgment, grounded in `DESIGN.md:10-22` and `CONTRACT.md:16-18`.)*

What is achievable, and is genuinely most of the value:

> **The schedule is data; the props are code, but in a new file that the room's
> owner never opens and that a future agent wave can write in isolation.**

That preserves the one rule that made the agent-wave model work (`CLAUDE.md:27`,
one file one owner) and it means shipping a holiday is *adding files*, never
editing ten room files and re-verifying their spawn framing.

### 3.2 The decor layer contract

New directory `src/world/decor/`, one file per layer, registered exactly like
rooms are (`src/world/index.js` is a 17-line lazy-load map; copy it):

```js
// src/world/decor/index.js
export const DECOR = {
  'winter-lights': () => import('./winterLights.js').then((m) => m.build),
  'aurora-watch':  () => import('./auroraWatch.js').then((m) => m.build),
  'summer-mural':  () => import('./summerMural.js').then((m) => m.build),
};
```

Each layer exports one function:

```js
/**
 * @param scene   the live THREE.Scene (same one room.build got)
 * @param ctx     { roomId, anchors, palette, game, clock, event }
 * @returns       { update(dt), dispose() }   // engine owns the lifecycle
 */
export function build(scene, ctx) { ... }
```

Engine responsibilities, all of which mirror what it already does for rooms:
- Resolve layers after `room.build()` and before the iris opens
  (`src/core/engine.js:~200`), so a decorated room never pops.
- Re-resolve on `applyEvents` when the layer set changes: dispose the old layers,
  build the new ones. **Do not call `rebuildRoom()`**: it rebuilds the whole room
  and moves nothing the player can see except the decor, at the cost of a full
  scene teardown (`engine.js:304-330`).
- Call `layer.update(dt)` in the room update loop, and `layer.dispose()` in
  `_teardownRoom`. The engine auto-disposes the scene graph; the layer owns
  anything outside it (`CLAUDE.md:115-117`).

Hard rules for a layer, enforced by review:
- Adds no shadow casters (`docs/LIVING-COVE.md:190`, "no new shadow casters").
- Adds no colliders and moves no ground: **decor may never change where a player
  can walk**, or every room's spawn framing and BOT_ZONES verification
  (`DESIGN.md:66-73`) is invalidated per holiday.
- Stays under ~20 draw calls, against the room's ~120 budget (`CONTRACT.md:28`).
- Uses `makeToon`/`makeGlow`/`canvasTexture` only (`src/core/materials.js`).
- Is import-safe (`CLAUDE.md:109-110`).

### 3.3 What rooms must publish: anchors

The one thing rooms *do* have to add, once, is a table of named points where decor
may attach. This is the same idea as the layout editor's `editorHandles`
(`CLAUDE.md:158-166`) and about as much work:

```js
// in build(), after the props exist
this.anchors = {
  entrance:  new THREE.Vector3(0, 0, 12),
  landmark:  new THREE.Vector3(0, 0, -6),   // the room's one star attraction
  lamps:     [v3, v3, v3],                  // existing lamp posts (banner mounts)
  facades:   [{ pos, yaw, w, h }],          // flat wall faces a sign can hang on
  skyRing:   { y: 26, r: 60 },              // where a sky-wide effect lives
};
```

Six keys, optional individually, and a layer that finds a key missing simply
skips that piece. A layer written against anchors works in **every** room that
publishes them, which is how one "winter lights" layer dresses nine rooms without
nine authoring passes. *(judgment; the anchor idea is borrowed from the room
editor's existing handle system.)*

### 3.4 How a future agent wave ships a holiday

The whole point is that this is a checklist, not a project:

1. Add the event to `data/calendar.json` with `effects.decor` naming a layer id
   per room. No code.
2. One agent writes `src/world/decor/<layer>.js` against the anchor contract.
   One file, one owner, no shared infrastructure touched.
3. Add one line to `src/world/decor/index.js`.
4. Optionally add seasonal cosmetics to `HATS`/`FURNITURE` in
   `shared/constants.js` (contract-level, coordinate: `CLAUDE.md:39-41`) and
   gate them with `effects.shop.featured`.
5. Optionally add seasonal stamps to `STAMPS` (`shared/constants.js:198`) plus
   their rules in `server/progress.js`. Note `install()` already warns at boot
   about stamps with no rule (`server/progress.js:113-116`), which is a real
   safety net for this workflow.
6. Verify visually from the actual spawn points (`DESIGN.md:74-76, 160-163`).
   This is the step that always gets skipped and always should not be.

A holiday is then: one JSON edit, one new file, one registry line. That is a
Saturday, not a wave. *(judgment)*

### 3.5 The palette override

`makeToon` caches materials per color (`src/core/materials.js:23-30`), so a global
palette shift is not free (cached materials are shared and must not be mutated:
the comment says so). Do not attempt a global recolor. Instead, pass a `palette`
in the decor `ctx` and let layers use it for their *own* materials. A holiday
reads as a holiday because of added props and light color, not because the sand
changed hue. *(evidence for the constraint, judgment for the call.)*

### 3.6 Seasonal cosmetics and the "adult nostalgia" line

The audience is adults nostalgic for Club Penguin, not children
(project brief; `CLAUDE.md:18-23` for the cozy/all-ages scope test). That
audience has seen every FOMO pattern and dislikes them. My rule: **seasonal items
leave the shop and come back next year.** They do not expire from inventory, they
are never sold at a countdown-timer urgency, and the paper announces the rotation
a week ahead. Scarcity by calendar is charming; scarcity by pressure is not, and
this world's entire brand is "cozy". *(judgment)*

---

## 4. Community goals

### 4.1 Design rules

1. **One at a time, island-wide.** Two concurrent bars is two half-cared-about
   bars.
2. **The contribution must be something people already do.** A goal that asks for
   a new behaviour is a chore; a goal that counts mural pixels is a spotlight on
   the thing that was already fun.
3. **The reward is a *place*, not an item.** A prop that appears in the plaza and
   stays there is a permanent monument to a week the community shared. A pile of
   coins in everyone's purse is forgotten by Tuesday and inflates a currency the
   audit already says has nothing to buy (F-27). *(judgment, and this is the one
   I would fight for.)*
4. **Progress must be legible in the world, not only in a menu.** The plaza should
   physically change as the bar fills.
5. **No individual leaderboard on a community goal.** The moment you rank
   contributors you have built a grind, and the mine is already the wrong lesson.

### 4.2 Server shape

Goals live in `server/events.js` (they are started and stopped by the calendar)
with their own persisted blob, `data/goals.json`, written with the same debounced
pattern as the mural (`server/index.js:1964-1977`) and with the same durability
caveat: it needs the atomic-write fix from audit F-1 before it is trustworthy.

```js
// data/goals.json
{ "id": "lantern-fund", "startedAt": ..., "endsAt": ..., "target": 250000,
  "n": 118400, "contributors": 214, "done": false, "unlocked": [] }
```

Counting: `events.signal(name, p, data)` tees off the existing
`signal()` funnel (`server/index.js:426`), so a goal counts exactly the signals
the hardened handlers already accepted. **This is the whole anti-cheat story and
it is free**: `server/progress.js:20-29` argues the same point for quests, and
the argument transfers verbatim. Nothing client-sent ever advances a goal.

Broadcasting: **do not broadcast per contribution.** Piggyback the 10s clock tick
(`server/index.js:2850`) and send a goal delta only when the percentage crosses a
0.5% boundary or on a milestone (25/50/75/90/100). At 200 CCU a per-pixel
broadcast is 200 sockets times the mural's op rate, for a bar that moves
invisibly. *(judgment, grounded in the netcode scaling concern in audit §3.1/3.2.)*

Wire: fold it into the events frame rather than inventing another one.

```js
{ t: 'events', ..., goal: { id, name, blurb, n, target, pct, endsAt, done,
                            you: 37 } }   // `you` = this account's contribution, private
```

`you` is deliberately private and never broadcast: it is a warm "you helped"
number, not a rank.

### 4.3 Two goals I would ship, in order

**Goal 1: "The Big Picture" (mural coverage).** Target: get the 96x54 mural to
some coverage percentage of non-blank cells. The grid is already a `Uint8Array`
on the server (`server/index.js:1911`), so coverage is a single pass over 5,184
bytes, computed on the clock tick, not per paint. Reward: the plaza mural frame
gains a carved brass plaque with the completion date, permanently, and every
participant gets a stamp.

Why first: zero new counting infrastructure, the contribution is the single most
communal act in the game, and coverage is *self-evidently* visible in the world
(the wall fills up). The failure mode is people painting over each other, which
is a feature: it is the guest book being a guest book. *(judgment)*

**Goal 2: "The Lantern Fund" (collective coin drive).** A donation box hotspot in
the plaza; players donate coins; at target, a new permanent prop unlocks (lantern
posts along the plaza paths that light at dusk, wired into the existing lamp
cascade in `plaza.js` `onClock`).

Why this one specifically: **it is the first real coin sink in the game.** Audit
F-27 measures the entire game's purchasable content at 6,510 coins and time-to-own-everything
at ~4.3 hours of intended play. A recurring community sink absorbs
post-completion income, gives late-game coins a meaning, and does it without
inventing consumables. *(evidence: audit §3.5; the sink framing is judgment.)*

Design details that matter:
- Donation goes through a new `{t:'donate', n}` handler with the same guard shape
  as `buy` (`server/index.js:2341-2365`): read the live record, clamp, never trust
  the connection's snapshot.
- **Cap per account per day** at something modest. Otherwise one rich player
  finishes a community goal alone at 3am and the community goal was a solo goal.
- Target scales with the active population from the previous week (from the stats
  layer, §5.3), so the bar is achievable at 30 DAU and still meaningful at 300.
- Donations are non-refundable and the UI says so twice.

### 4.4 The failure mode to plan for

A community goal that does not complete is a public failure and it demoralises a
small population far more than it motivates them. **Mitigations:** target from
last week's real numbers, never from ambition; let a goal run until it completes
rather than expiring (the calendar starts it, the goal ends itself); and have the
Courier report progress weekly so a slow goal reads as an ongoing story rather
than a stalled bar. *(judgment)*

---

## 5. The Cove Courier

### 5.1 Why this is worth a whole system

Club Penguin's paper worked because it did three jobs at once, and only one of
them was news: it told you what changed while you were gone, it told you what is
coming so you would come back for it, and **it put player names in print**. For a
world with no notification channel (§1.D), a weekly paper is the only artefact
that can make the passage of time legible. *(judgment)*

It is also cheap here in a way it is not in most games, because the writing is
templated from numbers the server already produces, and because the notice board
already exists as a hotspot with an overlay
(`src/world/rooms/plaza.js:1112` hotspot `quest-board` opening `src/ui/quests.js`).

### 5.2 What writes it: templates plus one human slot

**Three-quarters templated, one-quarter editorial.** Fully automated papers read
like a stats dump and nobody opens the third issue. Fully hand-written papers stop
in week five, because the person writing them is also the person fixing the
server. The split:

- **Templated (server-generated, zero effort):** the week's numbers, the top
  scores, new stamp earners, the party count, the mural before/after, the goal
  bar, next week's calendar (which is literally a render of `data/calendar.json`,
  so it can never be wrong).
- **Editorial (one text field, `data/paper/draft.json`):** a headline and one
  short paragraph. If the operator writes nothing, the field is omitted and the
  issue still prints. **This is the single most important design decision in this
  section:** the paper must never block on a human. *(judgment)*
- **Player-sourced (later, and only after the F-21 moderation layer lands):**
  a "letter to the Courier" submission, hand-picked by the operator from a queue.
  Community papers live or die on this and it is also a fresh abuse surface. Not
  in v1.

### 5.3 The prerequisite: an aggregate stats layer

Nothing aggregates today (§1.A). The paper needs about 120 lines in a new
`server/stats.js`:

```js
install(ctx)
note(kind, data)        // called from the signal() wrapper + grantCoins + connect/disconnect
week()                  // the current week's rollup, in memory
close(weekId)           // freeze + write data/stats/<weekId>.json, start a new bucket
```

Wire it at exactly one place for player actions: inside the existing `signal()`
wrapper (`server/index.js:426-431`), which is already try/catch-wrapped so a stats
throw cannot cost a player their frame. Plus `grantCoins` for faucet volume and
the `hello`/close handlers for sessions. **One tap, everything counted.**

What the weekly bucket holds (all server-side, no client input):

```
players:   { seen:Set<accountKey>, new:n, sessions:n, sessionMsTotal, peakCCU, byHour[24] }
rooms:     { <roomId>: { joins, dwellMs } }
games:     { <gameId>: { runs, coins, best:{name, score} } }
social:    { chats, waves, parties, partyGuests, muralPixels, snowballs, ballBops, doodles }
economy:   { granted:{<reason>: n}, spent:{hats:n, furniture:n}, donated:n }
progress:  { stampsEarned:{<stampId>: n}, milestones:n, questsDone:n }
```

Note the deliberate absence: no per-player behavioural history, no IPs, no chat
contents. Accounts are keyed by the same lowercase username the rest of the server
uses, and the weekly file could store a hash instead if the operator prefers.
*(judgment, consistent with the audit's observation that data minimisation here is
a genuine asset, §3.4.)*

### 5.4 Issue generation

On the clock tick, `events.tick` asks: has the wall clock crossed the configured
print time (`calendar.json` → a `paper` block: `{day: "SUN", time: "10:00"}`)?
If so:

1. `stats.close(weekId)` freezes the bucket.
2. `paper.generate(weekId)` renders sections from the frozen bucket plus the
   calendar plus `draft.json`.
3. Write `data/paper/<weekId>.json`, **immutable once written**. An issue is a
   historical record; a regenerated issue that says something different is worse
   than no paper.
4. `broadcastAll({t:'paper-new', weekId, headline})` and set a badge on the notice
   board hotspot.

Issues are ~4KB of JSON. Keep them all: 52 issues a year is 200KB and a year of
back issues is one of the nicest things a small world can have.

### 5.5 Sections, and where every number comes from

| Section | Copy shape | Source |
|---|---|---|
| Masthead | "The Cove Courier, Issue 14" | issue counter |
| Editorial | headline + paragraph, or omitted | `data/paper/draft.json` |
| **This week in the cove** | "1,204 games played. 38 new capys. 11 parties." | `stats.games.*.runs`, `players.new`, `social.parties` |
| **Top of the board** | per minigame: name + score | `stats.games[g].best`, which needs the F-14 fix (`best` bound to a paid run) or it prints a cheater's name |
| **Newly stamped** | "Nine capys earned Whale Rider this week." | `stats.progress.stampsEarned`, joined to `STAMPS` names (`shared/constants.js:198`) |
| **Legends** | anyone crossing a milestone | `stats.progress.milestones` + `MILESTONES` (`shared/constants.js:266`) |
| **The wall** | a rendered crop of the mural, before and after | `muralRLE()` snapshots (`server/index.js:1920`), one at issue open and one at close |
| **The fund** | goal bar + "we are 62% there" | `data/goals.json` |
| **Busiest hour** | "Thursday at 9pm, 46 capys on the island" | `stats.players.byHour`, `peakCCU` |
| **What is on** | next week, rendered from the calendar | `data/calendar.json` |
| **Party page** | "Biggest party: 14 guests at Mango's Den" | `stats.social.partyGuests` + the party-end head count (`server/index.js:1882-1887`) |

Voice: `DESIGN.md:91-93`, warm, playful, a little silly, lowercase enthusiasm for
anything the citizens say. The Courier should read like a village newsletter that
takes the shuffleboard results extremely seriously. *(judgment)*

### 5.6 Where it lives

The plaza notice board. It is already the civic corner, already a hotspot, and
already carries the Quest Board overlay (`plaza.js:1061-1126`). Two options:

- **A tab in the existing quest overlay** (cheapest, and the overlay lifecycle is
  already written: `src/ui/quests.js`). Risk: the paper is the quieter thing and
  gets buried behind the board players open for coins.
- **A second hotspot on the same board prop** ("Read the Courier"), opening
  `src/ui/paper.js`. Slightly more work, much better discovery, and the board is
  physically large enough (`plaza.js:1095`, a 2.42x1.5 face). **I would do this.**

Either way: an unread-issue badge on the world prompt (a folded-paper icon with a
gold dot), cleared per account when the issue is opened, stored in
`rec.progress` next to everything else. The badge is what turns the paper from
"a thing that exists" into "a thing you check on Sunday". Back issues get a
dropdown; do not paginate.

### 5.7 The paper prints names, therefore it is a moderation surface

Non-negotiable, and it is the reason this waits on the tasked F-21 work:

- A player's name reaches print only from a server-side record, never from client
  text.
- Names that have been muted, banned or renamed by an admin between the event and
  the print are **excluded at render time**, not at collection time, so an
  admin action retroactively cleans an unprinted issue.
- Every name in an issue is a name the operator has effectively endorsed. With the
  name filter from audit F-26 in place that is fine; without it, the paper is a
  megaphone for whatever someone signed up as.
- The mural crop is a *picture*, and the mural is already understood to be an
  abuse surface (the report flow at `server/index.js:2033` exists for exactly this).
  Crop selection must be operator-approved before print, or the paper can
  distribute something the report queue has not seen yet. **Recommendation:** in
  v1 the mural crop is chosen by the operator from three server-suggested
  candidates (highest-activity regions), not automatically. *(judgment)*

### 5.8 The habit argument

Fix the print day and never move it. The value of a weekly paper is not the
content, it is that **Sunday means something**. A paper that prints "when there is
enough news" trains nothing. If a week is quiet, print a quiet issue and let the
editorial say so; a village newsletter admitting nothing much happened is
charming, and it is also honest, which this project's docs are consistently good
at. *(judgment)*

---

## 6. Metrics the owner needs weekly

### 6.1 The tap

Same hook as the paper: `signal()` (`server/index.js:426`), `grantCoins()`
(`:400`), and connection open/close. Two consumers off one tap: the in-memory
weekly bucket (§5.3) and an append-only log for anything you did not think to
count in advance.

```
data/events/2026-W33.ndjson       # one JSON object per line, rotated weekly
{"t":1786...,"k":"score","u":"a91f","g":"fishing","c":74}
{"t":1786...,"k":"coin","u":"a91f","n":74,"r":"fishing"}
{"t":1786...,"k":"join","u":"a91f","room":"beach"}
{"t":1786...,"k":"session","u":"a91f","ms":1840000}
```

NDJSON because it appends without rewriting (unlike `users.json`, which rewrites
whole at `server/db.js:113-123` and is audit F-1's problem), because a week is a
few MB, and because `node --test`-era Node can read it with nothing installed
(`CLAUDE.md:108`, no new dependencies). `u` is a short stable hash of the account
key, not the username: the log should not be a directory of who plays this game.

### 6.2 The twelve numbers, and the decision each one drives

A weekly report nobody acts on is a worse use of time than no report. Each number
below is paired with the decision it exists to inform. *(judgment)*

| # | Metric | Definition | The decision it drives |
|---|---|---|---|
| 1 | **DAU / WAU** | distinct accounts with a session | Is the world growing or leaking? Everything else is context for this one. |
| 2 | **DAU/WAU ratio** | stickiness | Below ~0.2 people visit weekly, not daily: dailies and the paper are doing the work. Above ~0.35 you have a habit and should protect the anchors. |
| 3 | **D1 / D7 return** | of accounts created day X, share seen on X+1 / X+7 | D1 diagnoses onboarding (`src/ui/firstrun.js`, which the audit praises); D7 diagnoses whether anything gives a reason to return. |
| 4 | **Median session length** | from session close events | Under ~8 min means people are not finding the second thing to do. |
| 5 | **Sessions per returning player per week** | | This is the number a live-ops calendar moves. If events do nothing, this stays flat. |
| 6 | **Peak concurrency, by hour and weekday** | | Where to schedule events. Scheduling against guesswork is the single most common one-person live-ops mistake. |
| 7 | **Room heat** | joins and dwell time per room | Ten rooms is a lot for a small population. A room in last place three weeks running should get an event, not a rebuild. |
| 8 | **Minigame funnel** | runs per game, and share of players who ever play each | The 10-minigame catalogue is the biggest content investment here; if three of them are never played that is worth knowing before building an eleventh. |
| 9 | **Social participation rate** | share of sessions with a chat, wave, party, mural pixel, ball bop or snowball | **The single most important health number in a social game.** If it drops, the world is becoming single-player and no amount of content fixes that. |
| 10 | **Faucet volume by reason** | sum of `grantCoins` per reason | Audit F-11's invisible-farming problem becomes a report line. If `'mining'` dominates, the AFK-dominant-strategy concern (§3.5) is confirmed, not theoretical. |
| 11 | **Sink volume** | hats + furniture + donations | Against 10, tells you when the economy has flattened. F-27 predicts ~4 hours; measure it. |
| 12 | **Event lift** | metric 5 and 9 on event days vs non-event days | The only way to know whether the calendar is worth its maintenance. Kill events that show no lift after four runs. |

Plus two operational tripwires, which are cheap and will save a weekend:
- **Any account granted more than N coins in an hour**, logged with the reason
  breakdown (audit F-45's own suggestion). This is the anti-cheat alarm.
- **Tick overrun count**: how often the `NET_TICK_MS` interval ran late. It is
  three lines in the existing tick (`server/index.js:2810`) and it is the first
  symptom of the netcode scaling limits in audit §3.1.

### 6.3 Delivery

`npm run report [week]`: reads the NDJSON plus the frozen weekly stats file,
prints a plain-text table to stdout. No dashboard, no web UI, no charting
library. A one-person operator reads this in a terminal on Sunday morning, right
after the Courier prints, and the two rituals reinforce each other. *(judgment)*

Extend `/api/health` (`server/index.js:209`) the way audit F-45 already suggests:
uptime, heap, CCU, tick p95, error count since boot, coins granted in the last
hour. That is the live view; the report is the weekly view.

### 6.4 Privacy stance

Keep the current position: no email, no real names, no third-party analytics, and
all of the above stays on the operator's own disk. Hash the account key in the log.
Set a retention window (I would keep 90 days of NDJSON and keep the weekly
rollups forever, since the rollups are aggregates) and write it in the privacy
page that audit F-25 already requires. Doing analytics without a vendor is
slightly more work and enormously easier to explain in a privacy policy.
*(judgment, grounded in audit §3.4.)*

---

## 7. Build order

Dependencies are real; this order respects them.

| Order | Item | Cost | Blocked by |
|---|---|---|---|
| 1 | `server/stats.js` + the `signal()`/`grantCoins` tap + NDJSON log | S | nothing |
| 2 | `npm run report` with the twelve numbers | S | 1 |
| 3 | `server/events.js` + `data/calendar.json` + the `events` frame + join/hello parity | M | nothing (do in parallel with 1) |
| 4 | `coins` and `notice` effects; ship Golden Hour and one headline event | S | 3, and audit F-11's daily cap |
| 5 | HUD event pill + lead-in toast | S | 3 |
| 6 | `shop.featured` effect (audit F-27 fix 1, nearly free) | S | 3 |
| 7 | The Cove Courier: `server/paper.js`, `src/ui/paper.js`, notice-board hotspot | M | 1, 3, and F-21 name filtering, and F-14 for the top-scores section |
| 8 | Community goals: donation handler, goal counting, in-frame bar | M | 1, 3, F-1 durability |
| 9 | `onEvent` room hook + engine plumbing + anchors on plaza/peak/beach | S | 3 |
| 10 | `src/world/decor/` registry + the first two layers | M | 9 |
| 11 | `bots.setEventRoute` | S | 3 |
| 12 | Admin ws ops for one-off events | S | 3, and F-15's real admin flag |

Items 1 through 6 are about a week and they are the ones I would want live on
launch day. Everything from 7 down can land in the first month while the world is
small enough that a quiet week does not hurt.

---

## 8. What I would not build

Naming the cuts is half the value of a live-ops plan. *(all judgment)*

- **A web admin panel.** §2.8. A JSON file and two ws ops, and the operator's time
  goes into the calendar's *contents* instead.
- **A battle pass / season track.** The audit floats seasons (F-28 fix 4) and it is
  right that repeatability is missing, but a season track is an L-sized system
  whose whole job is to *pace* content. Content is what a one-person team does not
  have. Do the paper, the calendar and the community goals first; if metric 5 says
  people are coming back three times a week, then a season has something to pace.
- **Per-contribution goal broadcasts.** §4.2. Bandwidth for an invisible bar.
- **Automatic mural crops in the paper.** §5.7.
- **Events that mint coins outside `grantCoins`.** Every event effect must ride the
  one defended road, or the audit's entire economy analysis stops being true.
- **Player-submitted paper content in v1.** After F-21, not before.
- **Timezone cleverness.** One timezone (`America/New_York`, matching the pending
  real-time clock task in `CLAUDE.md:135-136`), stated plainly in the paper and in
  the event pill ("8pm ET"). Localised event times are a bug farm and the
  population is not yet global enough to pay for it.
- **Doubling AFK mining, ever.** §2.3.

---

## 9. Open questions for the owner

1. **Do citizens stay on for events?** `COVE_BOTS=0` is the stated launch plan
   (`server/index.js:283-286`). If they are off, events at low population will
   sometimes look abandoned, and the answer is fewer events at fixed hours. This
   is a scheduling decision that depends on an answer.
2. **How often are you willing to write two sentences?** The Courier's editorial
   slot is optional by design, but the difference between a paper with a voice and
   a paper without one is large. If the honest answer is "some weeks", the
   template must carry the issue alone, which is how §5.2 is specified.
3. **Cove time or wall time for the quest board?** The board rerolls every 40
   minutes today (`server/progress.js:54-61`). If live ops runs on real days and
   the board runs on cove days, the paper's "dailies completed" number means
   something different from what a player thinks it means. I would move the board
   to real days and leave the sky on cove time, but that touches shipped
   progression and belongs to whoever owns `progress.js`.
4. **What is the target population you are designing goals against?** Community
   goal targets have to come from measured DAU (§4.3), which means goals cannot
   ship before the stats layer has run for two weeks. That is a scheduling
   constraint, not a blocker, but it should be planned rather than discovered.
