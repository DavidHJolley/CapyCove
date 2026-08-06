# Capy Cove: module contract

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
