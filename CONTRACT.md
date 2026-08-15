# Capy Cove: module contract

> New here? Read CLAUDE.md first (project scope, file ownership, working
> rules), then this file for interfaces, then DESIGN.md for style.

Capy Cove is a cozy multiplayer hangout world (Three.js client, Node/ws server).
Players are chibi capybaras who explore rooms, chat, dance, play minigames for
coins, and buy hats. This document is the integration contract. Read it fully
before writing code. Do not change files outside the ones assigned to you, and
do not change any exported API described here.

## Stack and hard rules

- Plain ES modules, no TypeScript, no new npm dependencies.
- Three.js `0.17x` via `import * as THREE from 'three'`.
- NO external assets of any kind: no textures, models, fonts or sounds from
  URLs or files. Everything is procedural: geometry, canvas-drawn textures
  (`canvasTexture` helper), WebAudio synthesis.
- No import-time side effects (no DOM access, no singletons work at import).
- Windows dev box; paths in code must be forward-slash relative imports.
- Verify your file parses by running `node --input-type=module -e "await import('file:///D:/projects/ClubNotPenguin/src/<your file>.js')"`.
  (DOM access at import time will throw here; that's part of the check.)
- Art direction: chunky low-poly toon. Use `makeToon(color)` from
  `src/core/materials.js` for lit surfaces and `makeGlow(color)` for emissive
  accents; `canvasTexture(w, h, drawFn)` for signs/patterns. Palette: warm
  creams, sandy golds, coral pink `0xe8657a`, sky blue `0x4fb3e8`, leaf green
  `0x7ac74f`, gold `0xf2b64a`. Cohesion across rooms matters more than variety.
- Performance budget: a room stays under ~120 draw calls and ~150k triangles.
  Reuse geometries/materials, use `InstancedMesh` for repeated props
  (trees, rocks, fence posts). One `DirectionalLight` with shadows max
  (shadow map 1024), plus hemisphere/ambient/point fills.

## Key shared modules (read them before coding)

- `shared/constants.js` : room ids, minigame ids + payout caps, hats, BOT_ZONES.
- `src/core/game.js` : the `game` singleton API (coins, rooms, chat, shop).
- `src/core/engine.js` : renderer, camera, room lifecycle, hotspots, overlays.
- `src/core/materials.js` : `makeToon`, `makeGlow`, `canvasTexture`, `disposeObject`.
- `src/player/avatar.js` : `createAvatar({color, hat})`, anims: idle/walk/dance/wave.
- `src/world/room.js` : the `Room` base class contract.
- `src/minigames/minigame.js` : the `Minigame` base class contract.

## Room contract (`src/world/rooms/<id>.js`)

Export `class <Name>Room extends Room` with `id`, `name`, and:

- `build(scene, game)`:
  - Add ALL meshes and lights to `scene`. Set `scene.background` (Color) and
    optionally `scene.fog`.
  - MUST set `this.groundMeshes` (array of meshes): these are the walkable
    surfaces. Clicks raycast them; avatars raycast down onto them for foot
    height, so ramps/hills work. Anything NOT in this list is unwalkable.
  - MUST set `this.spawnPoints = { default: V3, from_<roomId>: V3, ... }`,
    one `from_` entry per connected room, placed just inside that exit.
  - The BOT_ZONES circle for your room (see `shared/constants.js`) MUST be
    plain flat walkable ground: server bots wander inside it blindly.
  - `this.hotspots`: `{ id, position: V3, radius, label, action(game) }`.
    Exits: `action: (g) => g.goToRoom('<dest>', '<myId>')`. Minigame entries:
    `action: (g) => g.startMinigame('<gameId>')`. Make hotspot props visually
    obvious (signposts, glowing markers, arches).
  - `this.obstacles`: `{ x, z, r }` circle colliders for props players should
    not walk through (fountains, trees, counters).
  - Optionally `this.cameraHint = { offset: V3, lookHeight: number }`
    (default offset is `(0, 14, 19)`).
- `update(dt, game)`: animate water, particles, props. Keep allocations out of
  the loop (reuse vectors).
- `dispose()`: free anything created OUTSIDE the scene graph (the engine
  auto-disposes the scene). Cancel any timers you started.
- Rooms are rebuilt from scratch on every visit; keep `build` under ~50ms.

## Minigame contract (`src/minigames/games/<id>.js`)

Export `class <Name>Game extends Minigame` with `static id`, `static name`.

- `mount(rootEl)`: build everything inside `rootEl` (fullscreen div, empty,
  z-above the world). Own canvas/renderer/UI. You may inject a `<style>` tag;
  prefix every class with `mg-<id>-`. Instructions splash first, run starts on
  click/keypress, quit button calls `this.quit()`.
- Run your own `requestAnimationFrame` loop; cancel it in `dispose()`.
- If you create a `THREE.WebGLRenderer`, call `renderer.dispose()` (and
  `forceContextLoss()`) in `dispose()`; dispose geometries/materials too.
- End of run: show a results screen (score, coins earned, best score), call
  `this.finish(score)` once, then a button calling `this.exitToRoom()`.
- `coinsForScore(score)`: honest conversion; the server clamps to
  `MINIGAMES[<id>].maxCoinsPerRun` (see shared/constants.js), so design a run
  to earn roughly 30-90 coins.
- Read `game.state.bests['<id>']` for the best score display; `finish()`
  already persists the new best.
- Difficulty must escalate during a run; sessions ~60-120s; keyboard AND mouse
  playable where sensible; juicy feedback (screen shake, particles, combo
  text) and `game.audio.play(...)` sfx: click, coin, splash, whoosh, success,
  fail, pop, ding.

## The audio API (`src/core/audio.js`)

One singleton, `import { audio } from '../core/audio.js'`, also reachable as
`game.audio`. Everything is synthesized; there is no asset to wait for and no
call here ever throws, before `init()` or after it.

- `audio.init()` : build the graph. Safe to call twice; needs a user gesture.
- `audio.play(name, arg)` : one-shot sfx. `click, hover, tick, step, jump, land,
  thud, coin, buy, unlock, splash, bubble, whoosh, slide, open, close, pop,
  ding, ping, sparkle, combo, success, levelup, fail`, plus the aliases
  `error` (= fail), `select` (= click) and `chime` (= ding). Unknown names are
  ignored.
  `play('step', surface)` picks a footstep voice; with no surface it is inferred
  from the current room. **`ping`** is the "look at this" sound: it rings wet,
  is rate-limited to one every 0.4s, and takes the deepest music dip of any sfx,
  so it reads over a bed. Use it for something that wants attention (a lap
  record, a charm glinting), not for a button.
- `audio.setRoom(roomId)` : crossfade the bed. An id with no bed of its own
  (`house:<owner>`, a typo) fades to silence and is otherwise fine.
- `audio.setOverlay(open)` : force the "world recedes" state (a ~3dB dip and a
  lowpass) on or off. Optional: the module watches the overlay mount points and
  the `minigame` event itself, and the three sources are OR'd. `false` releases
  only the one YOU took.
- `audio.duck(reason, db = -6, ms = 0)` : hold the bed down while a MOMENT
  lasts, which is what `setOverlay` is not (no panel) and what the sfx sidechain
  is not (that is a one-beat dip). `reason` names the hold, so two compose by
  multiplication instead of overwriting each other and a caller can only release
  its own. `db` is negative; `0` (or a positive or nonsense value) releases. Give
  `ms` and the hold releases itself after that long, which is what makes a HUD
  disposed mid-moment harmless. Returns the total attenuation now held, in dB.
  Level only, never the lowpass, and the depth is taken at face value. The kart
  contract's countdown and podium duck (docs/KARTS.md A6/A7, -6 dB) is this.
- `audio.toggleMute()`, `audio.muted`, `audio.setVolume(bus, v)` /
  `audio.getVolume(bus)` with `bus` of `'music'` or `'sfx'`.

**The audio -> game import is one-way and deliberate.** `audio.js` imports the
`game` singleton (`src/core/game.js`) to subscribe to `clock` and `minigame` on
`game.events`; `game.js` must never import `audio.js` back. The subscription is
taken inside `ensure()`, so it happens with the first gesture and never at
import time, and it is wrapped: a harness with no `game` still plays.

## Room grade + world attachments

- **`room.grade`** (optional, any room): `{ warmth, lift, dusk }`, each roughly
  `-1..1`, read by `src/core/postfx.js`. It is the room's own colour grade, not
  a per-frame effect: set it in `build()` (or rewrite it in `onClock()` and the
  grade eases to the new value). `warmth` skews the channels, `lift` opens or
  closes the shadows, `dusk` pins how much of the day/night response this room
  takes (the jungle pins `dusk: 0`). Omit it and you get today's look exactly.
  The engine hands it over with `postfx.setScene(scene, camera, room, {arrive})`
  where `arrive` is `true` for a room CHANGE and `false` for an in-place rebuild,
  which is what stages the iris and the arrival lift. Anything that builds a
  scene without a Room (a turntable, a preview) can put the same object on
  `scene.userData.grade` instead.
- **World attachments** wrap a built room without the room knowing. The engine
  calls them together, right after `room.build()` and before `postfx.setScene`,
  in both `switchRoom` and `rebuildRoom`. All share one shape:
  `attachX(room, scene, game, roomId)`, returning a view (or `null` when the
  room opts out), parking itself on `room.__x`, disposing any previous one so a
  rebuild can never wrap a wrap, and owning its own teardown.
  - `attachOverlay` (`src/world/overlay.js`) applies the published layout doc.
    Never call `room.build()` without it or an edited room comes out unedited.
  - `attachCharm` (`src/world/charm.js`) hangs the weekly charm's glint.
  - `attachAmbience` (`src/world/ambience.js`) hangs the room's living air
    (petals, spray, snow, dust, pollen, embers, haze) off the same seam,
    immediately after `attachCharm`. It keys off the ROOM ID, not off anything
    the room exports: `ambienceConfig(roomId)` answers `null` for a room with no
    air, and `AMBIENCE_ROOMS` lists the ones that have it, so a room file needs
    no ambience code at all. It hooks the room INSTANCE's `update`/`dispose`/
    `onClock` and restores them, which is why disposing a room disposes its air.

## The `game` API (what your code may call)

- `game.goToRoom(id, fromId)`, `game.startMinigame(id)`
- `game.toast(msg)`, `game.audio.play(name)`
- `game.state`: `{ name, coins, color, hat, ownedHats, bests }` (read-only;
  mutate only through game methods)
- `game.events.on/emit`: 'coins', 'room', 'chat', 'minigame', 'profile', 'toast'
- Coins ONLY via minigame `finish()` or server messages; never touch
  `state.coins` directly.

## Multiplayer notes

- Remote players/bots are rendered automatically in `engine.remoteGroup`;
  rooms need zero networking code. Just honor BOT_ZONES walkability.
- The room is rebuilt on join; nothing you build should depend on who is in it.

## Verification checklist before you finish

1. `node --input-type=module -e "await import('file:///D:/projects/ClubNotPenguin/src/<yourfile>')"` passes.
2. Every id you reference (rooms, minigames, hats) exists in `shared/constants.js`.
3. All spawn points and BOT_ZONES sit on your groundMeshes.
4. No `console.log` spam left; no TODOs for core features.
