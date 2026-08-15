# Capy Cove level editor v2: specification

Status: research spec, nothing implemented. Written against the tree at
2026-08-14. Every claim about current behaviour cites a file and line; every
recommendation is either evidence-grounded or tagged **[judgment]**.

Scope: the owner art-directs rooms in-game and wants a real editor, not a
preview. This spec covers the prop palette, server-side persistence applied for
everyone, undo/redo, multi-select, snapping, collider and hotspot editing with
live walkability preview, camera bookmarks, and an admin-gated draft to publish
flow. It is deliberately concrete: data format, wire frames, file-by-file plan,
migration order.

Not in scope: moderation of layouts (nobody but an admin can ever write one),
the trust and safety work in `docs/AUDIT.md` F-21..24, and any change to the
minigames.

---

## 0. Verdict up front

The current editor is better engineering than its reputation. Handles mode is
already the correct architecture: it edits **numbers**, rebuilds through the
real build path, and therefore moves the sign, the chairs, the prompt zones and
the obstacle circles derived from those numbers (`src/ui/editor.js:500-518`,
`src/core/engine.js:304-331`, `src/world/rooms/lounge.js:254-267`). Free mode is
the opposite: it drags meshes, and it can never be more than a preview.

So v2 is not a rewrite of the editor. It is four additions around the part that
already works:

1. **A place for the numbers to live that is not a JS file** (`data/layouts/`
   server-side, fetched over HTTP, applied at build for everyone).
2. **A catalog of spawnable props** so the editor can add, not only move.
3. **A stable identity scheme for code-authored props** (`room.tag(id, obj)`)
   so a saved edit can find its target next build.
4. **A command stack** so undo, multi-select and group ops are one mechanism
   instead of three.

The single most important design decision, and the one I would defend hardest:
**free mode never becomes persistent.** Its identity key is a child-index path
(`src/ui/editor.js:87-92`) into rooms that name essentially nothing: a grep for
`\.name\s*=` across the eleven room files returns exactly two hits, and one of
them is a room title, not an object name (`drift.js:839`, `house.js:553`),
and its finest edits rewrite vertex slices of merged geometry in place
(`src/ui/editor.js:342-364`). Persisting that produces a layout file that
silently aims at the wrong prop the next time anyone reorders a builder. Free
mode stays as an inspector that prints numbers you paste into code. Everything
persistent goes through tags, handles, or catalog props.

---

## 1. What exists today

### 1.1 Handles mode (authored, exact)

- A room publishes layout numbers via `editorHandles(id)`; each becomes a
  draggable pin (`src/ui/editor.js:485-498`).
- Dropping a pin calls `editorPatch(id, key, value)` or, on Shift-drag of the
  gold prop pin, `editorPatchAll(id, dx, dz)`; the result is stored in the
  in-memory override map and `engine.rebuildRoom()` runs
  (`src/ui/editor.js:500-518`).
- `src/world/layout.js` is a `Map(roomId -> Map(propId -> patch))`, 40 lines,
  documented as session-only (`src/world/layout.js:1-15`).
- The room folds overrides in at the top of `build()`:
  `applyStationOverrides()` copies from a pristine `STATIONS_BASE` and applies
  the patch (`src/world/rooms/lounge.js:249-267`). This is the pattern to
  generalise, and it is good: no call site in the room needs to know the editor
  exists.
- Only the lounge opts in. `editorHandles` publishes six handles per station
  (`at`, `sign`, `hs`, `aiAt`, two `seats`) plus `yaw` on `[`/`]`
  (`src/world/rooms/lounge.js:2726-2772`).
- `reg(id, fn)` registers a station's props by diffing `scene.children` before
  and after the builder runs (`src/world/rooms/lounge.js:2058-2065`). Clever,
  and it is also the reason those props have no durable identity.

### 1.2 Free mode (every room, no opt-in)

- Raycast pick with a pickability filter that excludes ground meshes, points,
  lines, sprites, depth-write-less glow overlays, and anything with a bounding
  radius over `HUGE = 15` (`src/ui/editor.js:84-85, 243-253`).
- Tab drills: whole prop, part, one `InstancedMesh` instance, or one welded
  piece of a merged mesh found by union-find over the geometry with positional
  welding for unindexed buffers (`src/ui/editor.js:256-298`). This is genuinely
  impressive and worth keeping as an inspector.
- Moving a welded piece rewrites its slice of the position attribute about the
  piece centroid (`src/ui/editor.js:342-364`).
- Marquee select iterates only `engine.scene.children`, i.e. top-level objects
  (`src/ui/editor.js:744-760`), so box-select cannot pick parts or instances,
  and in rooms where most geometry is inside a handful of `InstancedMesh`
  batches it selects almost nothing useful.
- Export is a read-only textarea plus clipboard copy
  (`src/ui/editor.js:561-581, 840-847`).

### 1.3 Known limits, and two bugs worth fixing regardless

Documented limits (CLAUDE.md "Dev layout editor"): visual-preview-only free
mode, exports pasted back into code by hand, no prop spawning, no persistence.
All confirmed. Add these, found while reading:

**B-1. Every pin drag resets the editor camera.** The editor drives
`engine._staticCam` directly and forces `cameraMode = 'static'`
(`src/ui/editor.js:173-185`). `commitPin` calls `engine.rebuildRoom()`
(`src/ui/editor.js:513`), and `rebuildRoom` ends with `_resolveStaticCam(false)`
(`src/core/engine.js:329`), which overwrites `_staticCam` from
`room.staticCamera`. Every one of the eleven rooms authors `staticCamera`
(verified: `beach.js:594`, `cafe.js:756`, `club.js:236`, `drift.js:728`,
`house.js:597`, `jungle.js:895`, `loft.js:1045`, `lounge.js:1193`,
`mine.js:737`, `peak.js:1308`, `plaza.js:652`). So: line up a shot, drag a
pin, and the camera jumps to the room-wide vantage. Fix: an
`engine.camLock = true` flag that `_resolveStaticCam` respects.

**B-2. Resizing the window does the same thing.** `_resize()` calls
`_resolveStaticCam(false)` whenever a room exists (`src/core/engine.js:121`).
Same fix.

**B-3. Undo is scoped to one rebuild.** `sync(true)` clears `edits` and
`undoStack` (`src/ui/editor.js:583-591`), and every pin commit calls it
(`src/ui/editor.js:514`). So handle edits and free edits cannot coexist, and
free-mode work is destroyed by touching a pin. The command stack in section 6
is the structural fix.

**B-4. Room-change detection is a 400ms poll** (`src/ui/editor.js:857`) even
though `game.events.emit('room', id)` already exists
(`src/core/game.js:91`).

**B-5. `HUGE = 15` is a hard-coded proxy for "this is scenery".** It is why
large-but-movable props (a rowboat, a chairlift pylon, a ruin block) cannot be
picked. With a tag registry this becomes explicit instead of dimensional.

### 1.4 The one thing this codebase already does right, twice

Player dens are a working, shipped, server-persisted, validated placement
system:

- Client editor drives the room through a narrow API: `getLayout` / `setLayout`
  / `addItem` / `removeItem` / `poseItem` / `makeGhost` / `pickFloor` /
  `pickItem` / `setEditing` (`src/world/rooms/house.js:1291-1450`), with zero
  `three` import in the UI file (`src/ui/houseEditor.js:1-22`).
- Grid snap 0.5, rotation step 45 degrees (`src/ui/houseEditor.js:24-26, 261`).
- Wire frame `{f, x, z, rot}` sent as `house-save`
  (`src/ui/houseEditor.js:616-640`).
- Server validates all-or-nothing, clamps bounds, rounds to 2dp / 3dp, checks
  ownership counts, then broadcasts to everyone who could be affected
  (`server/index.js:589-611, 2498-2509`; `broadcastHouse` at
  `server/index.js:577-586`).
- Disk normalisation on load rejects anything a client could never have sent
  (`server/db.js:70-99`).

The plaza mural is the second precedent: a server-owned grid, debounced
persistence to `data/mural.json`, RLE on the wire, and a palette lock enforced
by construction ("an op carries an index, never a colour", `server/index.js:
1901-1906`).

**v2 should look like these two systems, not like a new subsystem.** Same
validate-clamp-round-broadcast shape, same "server owns the data" posture, same
palette lock.

---

## 2. The load-bearing constraint: rooms are code, props are batches

A room is not a scene file. `Batch` collects rows and builds one
`InstancedMesh` per primitive at the end of `build()`
(`src/world/rooms/lounge.js:302-332`; the same class is copied into
`house.js:96-118`). Chairs, sign posts, festoon bulbs and rocks do not exist as
individual objects at all; they are rows in a matrix buffer. That is why the
current editor edits numbers and rebuilds.

This gives three tiers of editability, and every design decision below follows
from which tier a thing is in.

| Tier | What | Editable how | Persistable |
| --- | --- | --- | --- |
| **A. Batched scenery** | Rows in a `Batch`, welded pieces of merged geometry, particles | Free mode preview only; the real fix is editing the room file | No |
| **B. Handles** | Named numbers a room publishes (`STATIONS`-style tables), spawn points, static camera | Drag a pin, rebuild | Yes, keyed by `room/prop.key` |
| **C. Data props** | Catalog instances the layout owns outright | Full transform, collider, hotspot, delete | Yes, keyed by generated id |

A fourth, half-tier, is what makes v2 feel like a real editor in the existing
rooms:

| **B2. Tagged objects** | A code-authored `Object3D` the room registers with `room.tag('fountain', obj)` | Transform patch, hide | Yes, keyed by the tag |

Tagging costs a room owner one line per prop worth moving and gives that prop a
durable name. It is the migration path from "the plaza is 2049 lines of code"
to "the plaza is 2049 lines of code with 30 named landmarks the editor can
move".

**[judgment]** Do not attempt to make Tier A data. Extracting every prop in
every room into catalog entries is a rewrite of ~92 `_build*` methods (counted
across `src/world/rooms/*.js`), it would multiply draw calls, and it would
throw away the room-specific composition notes that are the best documentation
in this codebase (see the STATIONS comment block, `lounge.js:180-241`).

---

## 3. Prop palette: what is actually reusable

### 3.1 Reusable today, with zero new geometry work: `src/world/furniture.js`

21 builders, and the module already satisfies a prop-catalog contract
(`src/world/furniture.js:5-17`):

- `buildFurniture(id)` returns a self-contained `THREE.Group`
  (`furniture.js:1099-1112`), y = 0 at the floor, authored facing +Z.
- `userData.footprint = {w, d}`, `userData.furnId`, optional
  `userData.update(t)` for animated pieces.
- Parts are painted into vertex colours and merged, so a piece costs ~2 draw
  calls (`furniture.js:88-130`).
- `furnitureFootprint(id)` gives the footprint without building
  (`furniture.js:1114-1117`), with a `FOOTPRINTS` table asserted against the
  builders (`furniture.js:1119-1139`).
- Only imports are `three`, `core/materials.js` and `shared/constants.js`. No
  room coupling.

Catalog ids available on day one: `sofa, armchair, beanbag, rug_round,
rug_stripe, low_table, dining_set, bed, bookshelf, floor_lamp, string_lights,
plant_palm, plant_flower, fireplace, aquarium, arcade_cab, trophy_case,
wall_surfboard, capy_portrait, cocoa_station, gramophone`
(`furniture.js:1069-1090`).

Several of those are den-flavoured, but `plant_palm`, `plant_flower`,
`string_lights`, `floor_lamp`, `rug_*`, `low_table`, `bookshelf` and
`cocoa_station` are perfectly at home in the cafe, the lounge, the loft and the
plaza. **The palette ships useful on day one without extracting a single room
prop.**

The house room also already contains the placement maths a palette needs:
`fpBox` tolerates three footprint shapes (`house.js:121-134`), `metricsFor`
derives two radii, a turning circle and a smaller collider, with a flat-item
exemption (`house.js:155-168`), and `makeGhost` builds a translucent
pointer-following preview with cloned materials marked `shared` so
`disposeObject` does not free the originals' textures
(`house.js:1355-1410`). All three move to shared code.

### 3.2 Not reusable as-is: the room builders

The eleven room files expose 331 private methods, 92 of them `_build*`. They
are not extractable without work, for three consistent reasons:

1. They take the room's shared batch bag `B` and push rows into instanced
   meshes built later (`lounge.js:2072`, `_chair(B, x, z, yaw, cushion)` at
   `lounge.js:2144`), so they return nothing.
2. They write straight into `this.obstacles` / `this.hotspots` (134 push sites
   across the room files; e.g. `plaza.js:818, 850, 973, 1012, 1057, 1110-1111`).
3. They close over room-scoped palettes and canvas painters.

**[judgment]** The right extraction unit is "the geometry of ONE item, pulled
out of the loop that batches many". `furniture.js` is the template: build parts
into a list, `mergeParts`, return a `Group` with a footprint.

### 3.3 Extraction tranches (candidate sources, verified method names)

Tranche 1 is furniture.js, free. Tranche 2 onward, ranked by how often the
owner will want them and how self-contained the source looks:

| Group | Candidate props | Source methods |
| --- | --- | --- |
| `cove` (plaza) | bench, lamp post, planter, topiary, flower bed, gate arch, notice board | `plaza.js` `_buildBenches`, `_buildLamps`, `_buildFlowerBeds`, `_buildTopiary`, `_buildGates`, `_buildQuestBoard` |
| `snow` (peak) | pine (3 sizes), boulder, drift, fence post, trail sign, sled rack, cocoa stand, snow capy | `peak.js` `_trees`, `_rocks`, `_trailFence`, `_trailSign`, `_sledRack`, `_cocoaStand`, `_snowCapybara` |
| `shore` (beach) | palm, driftwood, crate, deck chair, dock post, bonfire ring | `beach.js` `_buildPalms`, `_buildBeachStuff`, `_buildDock`, `_buildBonfire` |
| `green` (jungle) | broadleaf tree, fern, vine, flower cluster, ruin block | `jungle.js` `_trees`, `_undergrowth`, `_vines`, `_flowers`, `_ruin` |
| `deep` (mine) | timber frame, rail section, ore rubble, crystal cluster | `mine.js` `_timbers`, `_rails`, `_rubble`, `_crystals` |
| `indoor` (cafe / den) | stool, bar table, wall lamp, prompt ring, station chair | `cafe.js` `_stool`, `_fruitPile`; `lounge.js` `_chair`, `_stool`, `_ring`; `loft.js` `_wallLamp` |

Cost estimate **[judgment]**: 4 to 8 props per room-day of work once the
contract exists, because `mergeParts`/`solid`/`glow` in `furniture.js:88-145`
do the heavy lifting and the geometry already exists in a readable form. Six
tranches is roughly a wave.

### 3.4 Draw-call budget

DESIGN.md sets ~120 draw calls solo per room. A merged catalog prop is 1 to 2
draw calls. 40 data props placed one by one would be 40 to 80, which blows the
budget in a dressed room.

**Fix: `PropPool`.** At build time, group the layout's `prop` ops by catalog id;
build the geometry once per id; if a room uses an id 4 or more times, render
them as a single `InstancedMesh` (matching what `Batch` already does,
`lounge.js:302-332`); otherwise plain meshes. Draw calls then scale with
*distinct ids used*, not props placed. Animated props (`userData.update`) are
excluded from pooling and get a hard cap (see caps in section 5.4).

---

## 4. The layout document (data format)

One document per room, versioned, server-owned. Format id `rlo/1` ("room layout
overrides").

```jsonc
{
  "v": 1,
  "room": "plaza",
  "rev": 37,                      // published revision, server-assigned, monotonic
  "base": "plaza@3",              // room-file layout signature at authoring time
  "updated": 1755100000000,
  "by": "david",
  "ops": [ /* see below */ ]
}
```

### 4.1 Ops

Every op is `{ op, id, ... }`. `opKey = op + ':' + id`; within one document the
last op with a given key wins, so a naive append-only draft still normalises
cleanly. Application order is fixed by kind (section 4.3), never by array
order, so two admins' merges are deterministic.

**`prop`** spawn a catalog item (Tier C)

```jsonc
{ "op":"prop", "id":"p_7f3a91", "cat":"plant_palm",
  "p":[4.25,0,-2.5], "ry":0.785, "s":1.0,
  "tint":3,                       // OPTIONAL, index into shared palette. never a hex
  "col":0.9,                      // OPTIONAL collider radius override; 0 = walkable
  "lock":true }                   // OPTIONAL, editor-only: not selectable by marquee
```

**`xform`** move/turn/resize a tagged code-authored object (Tier B2)

```jsonc
{ "op":"xform", "id":"plaza/fountain", "p":[0,0,0.4], "ry":0.12, "s":1.05 }
```

**`hide`** suppress a tagged object

```jsonc
{ "op":"hide", "id":"plaza/bench.3" }
```

**`handle`** patch a room's published layout numbers (Tier B, today's override)

```jsonc
{ "op":"handle", "id":"lounge/pong",
  "set": { "at":[-6.98,-0.93], "sign":[-8.55,0.24], "yaw":0.95 } }
```

**`collider`** add, move or disable an obstacle circle

```jsonc
{ "op":"collider", "id":"c_04", "x":3.2, "z":-1.4, "r":1.1 }
{ "op":"collider", "id":"plaza/fountain", "r":0 }   // r:0 disables a tagged code collider
```

**`hotspot`** add or adjust a prompt zone. **`action` is never data.**

```jsonc
{ "op":"hotspot", "id":"h_02", "kind":"exit", "to":"beach",
  "x":-11.5, "z":0.2, "r":2.6, "label":"Driftwood Beach" }
{ "op":"hotspot", "id":"h_03", "kind":"game", "to":"fishing", "x":2,"z":6,"r":2.2,
  "label":"Play Reel Rush" }
{ "op":"hotspot", "id":"beach/fish-1", "r":3.0 }    // adjust an existing tagged hotspot
```

`kind` is one of `exit` | `game` | `sign`. The client resolves `kind` + `to` to
a function from a fixed table (`exit` -> `g.goToRoom(to, roomId)`, `game` ->
`g.startMinigame(to)`, `sign` -> `g.toast(label)`), and the server validates
`to` against `ROOM_IDS` / `Object.keys(MINIGAMES)` from `shared/constants.js`.
No string is ever evaluated, no callback is ever transported. This is the same
reasoning that palette-locks the mural (`server/index.js:1903-1906`).

**`spawn`** move a spawn point

```jsonc
{ "op":"spawn", "id":"default", "p":[1.4,0,4.4] }
{ "op":"spawn", "id":"from_beach", "p":[-9.5,0,0] }
```

**`cam`** static camera and editor bookmarks

```jsonc
{ "op":"cam", "id":"static", "p":[0,19,25.7], "look":[0,1.2,0.6] }
{ "op":"cam", "id":"bm_1", "name":"north gate", "target":[0,0,-9], "dist":12,
  "yaw":0.3, "pitch":0.8 }
```

`cam:static` writes `room.staticCamera`, which the framing pass (task #14)
would have loved to have as data. `bm_*` are editor-only and are stripped from
what non-admin clients are served.

**`group`** an editor-only convenience: a named set of op ids that move
together.

```jsonc
{ "op":"group", "id":"g_1", "name":"picnic corner", "members":["p_7f3a91","p_18cc02"] }
```

### 4.2 Conventions

- Positions `[x, y, z]` in room world units, 2dp. `y` is usually 0 and is
  resolved to the ground by raycast unless `yLock: true` is set (props on
  tables, wall pieces).
- Rotation is yaw only (`ry`, 3dp radians). **[judgment]** Everything in this
  world stands on the floor; a full quaternion is complexity for the two props a
  year that need a tilt, and those can stay code.
- Scale is a single uniform `s`, 3dp, clamped 0.25 to 4.
- Ids: tagged objects use `roomId/tagName` (dot-suffixed for indexed sets,
  `bench.3`); data props use `p_` + 6 hex chars minted client-side and checked
  for uniqueness server-side; colliders `c_`, hotspots `h_`, bookmarks `bm_`,
  groups `g_`.
- `base`: each room module exports `LAYOUT_BASE` (e.g. `'plaza@3'`), bumped by
  hand when a refactor invalidates tags. Mismatch does not invalidate anything;
  it raises a banner in the editor and force-runs the walk-check.

### 4.3 Merge semantics: code plus data

Room code stays the source of truth for everything it builds. The layout is a
patch applied over it, in this order:

```
1. layout.setHandles(roomId, handleOps)      // BEFORE build: rooms read these at the top of build()
2. room.build(scene, game)                   // unchanged, plus room.tag() calls
3. applyLayout(room, scene, doc, game):
     a. spawn    -> room.spawnPoints
     b. xform    -> tagged Object3D transforms
     c. hide     -> tagged Object3D .visible = false
     d. prop     -> PropPool spawns catalog items, appends obstacles
     e. collider -> add / move / disable circles in room.obstacles
     f. hotspot  -> add / adjust entries in room.hotspots
     g. cam      -> room.staticCamera, then engine._resolveStaticCam
4. engine finishes as it does today
```

Step 1 is exactly what `applyStationOverrides()` already does
(`lounge.js:254-267`), generalised: rooms call
`getHandles('lounge')` instead of `getOverrides('lounge')` and everything else
is unchanged. That is the whole change to lounge.js.

**Orphans.** If an `xform`/`hide`/`collider`/`hotspot` op names a tag the room
no longer publishes, the op is **kept in the document, skipped at apply time,
and reported to the editor** as an orphan with a one-click purge.
**[judgment]** Silently dropping orphans is how data editors rot: a room owner
refactors for an hour, ships, and a month of layout work has quietly evaporated
with no diff to point at.

**Conflicts with code changes.** Code always wins on existence: if the room
stops building the fountain, the fountain is gone whatever the layout says.
Data wins on the properties it names. There is no three-way merge and there
should not be.

---

## 5. Persistence, protocol, and the publish flow

### 5.1 Storage

`data/layouts/<roomId>.json`, one file per room:

```jsonc
{
  "v": 1, "room": "plaza",
  "published": { "rev": 37, "base":"plaza@3", "by":"david",
                 "updated": 1755100000000, "ops": [ ... ] },
  "history": [ /* last 10 published docs, newest first */ ],
  "drafts": { "david": { "rev": 41, "updated": ..., "ops": [ ... ] } }
}
```

- Written with the **atomic write helper from AUDIT F-1** (temp file, fsync,
  rename). Do not ship a second non-atomic `writeFileSync` next to
  `server/db.js:113-122`; if F-1 has not landed yet, this work brings the helper
  with it and `db.js` adopts it.
- `history` capped at 10 documents is the entire rollback story and it is worth
  more than any confirmation dialog **[judgment]**.
- Drafts are per admin username so two admins do not clobber each other; a soft
  editing lock (section 5.3) stops them fighting over one room in real time.

### 5.2 Read path: HTTP, not the welcome frame

```
GET /api/layout/:room   ->  200 {room, rev, base, ops}   ETag: W/"37"
                            304 on revalidate
```

**[judgment]** Reasons to use HTTP rather than shipping layouts in `welcome`
(`server/index.js:2235`):

- Guests get them with no auth path and no ws dependency.
- ETag revalidation makes a warm reload free; 10 rooms x ~200 ops x ~70 bytes
  is ~140KB if you ship it all at once, which is real money on the boot budget
  the loading screen is so carefully instrumented against
  (`src/main.js:14-72`).
- A room's layout is only needed when that room is entered, and the entry
  already has a natural async window.

Client caching: `layoutStore.ensure(roomId)` returns a promise, memoised per
room for the session. `Engine.switchRoom` already starts the room module import
before the 220ms fade and awaits it inside the timer
(`src/core/engine.js:150-168`); add the layout fetch to the same `Promise.all`.
Boot preloads the spawn room's layout beside the existing chunk warm
(`src/main.js:94-101`).

Failure policy: if the fetch rejects or takes over 250ms, build without the
layout and retry in the background; if it lands while the player is still in
that room, call `engine.rebuildRoom()`. A missing layout must never block
entering a room. `rebuildRoom` already preserves player position and rotation
(`src/core/engine.js:304-331`), which is exactly the "live reload" primitive
this needs.

### 5.3 Write path: ws frames, admin only

All of these require `p.admin === true` on the server-side player record. Never
trust a client claim. All are wrapped in the existing per-message try/catch and
counted by `socialLimited` (`server/index.js:438-441`) unless noted.

Client to server:

| Frame | Payload | Notes |
| --- | --- | --- |
| `layout-open` | `{room}` | Takes a 5-minute soft lock. Replies `layout-doc`. |
| `layout-close` | `{room}` | Releases the lock. |
| `layout-draft` | `{room, base, ops}` | Saves my draft. Own limiter: 1/sec, 64KB, 400 ops. |
| `layout-publish` | `{room, draftRev}` | Copies draft to published, bumps `rev`, pushes old published onto `history`. |
| `layout-revert` | `{room, toRev}` | Publishes a document out of `history`. |
| `layout-reset` | `{room}` | Publishes an empty op list (back to pure code). Confirm-gated client-side. |

Server to client:

| Frame | Payload | Notes |
| --- | --- | --- |
| `layout-doc` | `{room, rev, base, published:[ops], draft:{rev,updated,ops}\|null, lock:{by,until}\|null, orphans:[ids]}` | Admin only. |
| `layout-ack` | `{room, ok, what:'draft'\|'publish'\|'revert', rev?, msg?}` | Mirrors the `furn` ok/msg shape (`server/index.js:2534-2537`). |
| `layout-rev` | `{room, rev}` | Broadcast to everyone. Evict cache; if you are in that room, refetch and `rebuildRoom()`, then toast. |

`layout-rev` goes to **all** connected clients, not just the room, because a
client caches layouts for rooms it has visited.

### 5.4 Validation (shared, both sides)

`shared/layout.js` is dependency-free like `shared/constants.js` and is imported
by client and server both, so a rejection can be shown in the editor before the
round trip.

```js
validateLayout(doc, { roomIds, minigameIds, propIds, maxOps }) -> {ok, clean, msg}
```

Rules, modelled directly on `validatePlacements`
(`server/index.js:589-611`):

- All-or-nothing: one bad op rejects the whole document. Never store a partially
  cleaned layout, or the editor shows something the server did not keep.
- `room` in `ROOM_IDS` (`shared/constants.js:5`). Dens (`house:*`) are excluded:
  they have their own system.
- `op` in the fixed kind list; unknown kinds rejected, not skipped.
- `cat` in `PROP_IDS` (shared, section 7).
- Numbers finite; `|x|,|z| <= 200`, `|y| <= 40`, `s` in [0.25, 4], `r` in
  [0, 8]; rounded to 2dp / 3dp on the way in.
- `to` validated against `ROOM_IDS` or `MINIGAMES` keys by `kind`.
- `label` string, <= 40 chars, trimmed. `name` <= 24.
- `tint` an integer index into a shared `PALETTE` array, never a colour. Same
  shape as the mural's 14-entry index (`server/index.js:150, 2011`), which is
  the DESIGN.md anchor colours plus cream and ink.
- Caps: 400 ops per document, 120 `prop` ops, 24 animated props
  (`userData.update`), 60 colliders, 24 hotspots, 64KB serialised.
- Ids match `/^[a-z0-9_./-]{1,48}$/i` and are unique per `opKey`.

### 5.5 Publish gates (the part that stops a bad layout shipping)

Publish runs the walk-check (section 6.6) and **soft-blocks**, with an explicit
override confirm, on any of:

1. The room's `BOT_ZONES` circle (`shared/constants.js:70-85`) is no longer
   plain open walkable ground. Server bots wander it blindly; a collider dropped
   in there wedges them.
2. A spawn point is inside a collider or off the ground meshes.
3. A hotspot that exists in the clean build is missing after apply, or is
   unreachable from `spawnPoints.default`. `applyLayout` can compute this
   automatically by diffing hotspot ids before and after, so no room needs to
   declare a `required` list.
4. An `exit-*` hotspot has no reciprocal spawn in the destination room (this one
   is a warning only, since it needs cross-room data).

**[judgment]** Soft-block, not hard-block. The owner knows the room better than
the checker, and a hard gate on a heuristic gets routed around by disabling the
heuristic.

### 5.6 Admin flag (prerequisite, and it closes AUDIT F-15)

Nothing in this spec may land before this does:

- `rec.admin === true` on the user record, set by hand in `data/users.json` or
  a one-off CLI. No self-service path, ever.
- Surfaced through `publicProfile()` (`server/auth.js:37-50`) as
  `admin: rec.admin === true`, so `game.state.admin` exists client-side.
- `src/main.js:183-185` `isAdmin()` becomes `game.state.admin === true`; the
  `/^david/i` display-name regex is deleted. This is AUDIT F-15
  (`docs/AUDIT.md:182-185`) and task #13.
- Guests can never be admin: the flag comes off the stored record, and guest
  profiles are minted, not loaded.
- The server checks `p.admin` on every `layout-*` write frame independently. The
  client gate is UX; the server gate is the security boundary. This matters far
  more in v2 than it did before, because for the first time the editor writes
  data everybody else renders.

---

## 6. Editor v2: features and interaction spec

### 6.1 Shell

Three tabs, replacing today's two:

- **Build** (new): the palette, the data props, the gizmo. The default.
- **Numbers**: today's handles mode, unchanged behaviour, now persistent.
- **Inspect**: today's free mode, kept read-only, still with Tab drill-down and
  the welded-piece finder, still exporting text to paste into a room file.

Header shows: room name, `published rev N`, `draft +M changes`, lock state, and
an orphan count when non-zero.

### 6.2 Palette

- Grouped catalog browser (`den`, `cove`, `snow`, `shore`, `green`, `deep`,
  `indoor`), search box, recently-used row.
- Card icons: reuse the canvas icon technique from the house editor
  (`src/ui/houseEditor.js:81-241`) for the furniture ids that already have
  drawings; new groups get a render-to-thumbnail pass at first open
  (build the prop offscreen once, render 96x96, cache in a `Map`).
- Click a card to arm, then move the pointer over the floor: a translucent ghost
  plus a footprint ring follows, exactly like `room.makeGhost`
  (`house.js:1355-1410`), which moves into shared code as
  `makePropGhost(scene, catId)`.
- Click to place, Escape or right-click to disarm, Shift-click to place several
  without disarming.
- Ghost turns coral when the placement is invalid (off the ground meshes, inside
  the BOT_ZONE, overlapping a locked collider), matching `setValid`
  (`house.js:1394-1399`).

### 6.3 Selection and multi-select

Selection is a `Set` of **op ids** (plus tag ids for Tier B2), not of
`Object3D`s. This is what makes it survive a rebuild, which is the single
biggest quality-of-life change over today.

- Click selects, Shift-click adds, Ctrl-click toggles, Alt-click cycles through
  what is behind (today's `lastPick` logic, `src/ui/editor.js:684-690`).
- Marquee drag on empty floor selects data props and tagged objects whose
  **screen-projected origin** falls in the band. Fix the top-level-only walk
  (`src/ui/editor.js:747`) by iterating the layout's own prop and tag registries
  instead of `scene.children`.
- Selection list in the panel: name, catalog id, xz, with click to isolate and a
  visibility eye.
- `L` locks a selection out of picking (`lock: true` on the op).

### 6.4 Group ops

- Move: drag (XZ plane) or arrow keys. Shift for the coarse step. PgUp/PgDn for
  Y. Reuse the existing key map (`src/ui/editor.js:789-808`), which is good.
- Rotate: `[` / `]` rotates each item about **its own centre**; `Shift+[` / `]`
  rotates the whole selection about the **group pivot** (bbox centre, shown as a
  ring). Today only the first behaviour exists.
- Scale: `-` / `=`, about the same pivot rule.
- `Ctrl+D` duplicate with a small offset. `Delete` removes (data props only;
  tagged objects get `hide` instead).
- Align (`Shift+A` menu): left/right/top/bottom edges of the bbox, centre X,
  centre Z, distribute evenly along X or Z. **[judgment]** This is the thing
  that makes a row of six benches take 20 seconds instead of five minutes, and
  it is 40 lines.
- `Ctrl+G` groups the selection into a named `group` op; a grouped member drags
  the whole group unless Alt is held.

### 6.5 Snapping

- Grid: off / 0.25 / 0.5 / 1.0, cycled with `G`. Default 0.5, matching the den
  editor (`src/ui/houseEditor.js:24`). Hold Alt to bypass for one drag.
- Angle: 15 degrees by default, `Shift` for 5, Alt to bypass. The den editor's
  45 (`houseEditor.js:25`) is too coarse for room dressing **[judgment]**: the
  lounge's authored yaws are 0.95 and 1.15 radians, i.e. 54 and 66 degrees
  (`lounge.js:201, 237`).
- Ground: after any XZ move, raycast down onto `room.groundMeshes` and set y,
  unless `yLock`. This makes props follow ramps and hills for free, using the
  same call the walker uses (`src/player/controller.js:47-65`).
- Sibling snap **[judgment, defer to 2.1]**: edge-align against the nearest
  prop's bbox within 0.3 units. Lovely, not load-bearing.

### 6.6 Colliders, hotspots, and the walkability preview

This is the feature that pays for the whole spec, because it is the one thing
the current workflow cannot do at all and the one DESIGN.md explicitly demands
("After placing obstacles, trace the paths between every exit/hotspot pair: a
bench must never pinch a route shut", DESIGN.md section on environment
composition).

**Collider gizmo.** Every entry in `room.obstacles` draws as a floor ring.
Data-owned circles are gold and draggable (centre to move, rim to resize);
code-authored circles are grey and read-only until their prop is tagged, at
which point they can be resized or disabled with `collider r:0`. `A` adds a
free-standing collider at the cursor.

**Hotspot gizmo.** Every `room.hotspots` entry draws as a coloured disc with its
label. Exits are blue, minigames gold, signs green. Drag to move, rim to resize.
Adding one opens a small form: kind, destination (a dropdown built from
`ROOM_IDS` / `MINIGAMES`), label.

**Walkability preview (`V`).** The reason this can be exact rather than
approximate: the walker is a *point*, not a capsule
(`src/player/controller.js:67-125`), obstacles are circles
(`controller.js:85-101`), and footing is a downward raycast with an optional
`room.minWalkY` floor (`controller.js:47-65`). So:

1. Rasterise a 0.25 unit grid over the union bbox of `room.groundMeshes`.
2. Per cell: raycast down; unwalkable if no hit, or `y < room.minWalkY`, or the
   centre lies inside any `obstacle` circle. Chunk the work over frames with a
   4ms budget; a 40x40 room is ~25k raycasts, roughly 150ms of work spread over
   half a second.
3. Flood fill 8-connected from `spawnPoints.default`. Paint reachable cells
   translucent green, **open-but-unreachable cells coral** (the pinch detector),
   blocked cells nothing.
4. Route check: for every (spawn, hotspot) and (hotspot, hotspot) pair, run the
   real `WalkController` headlessly against a stub avatar for up to 30 simulated
   seconds at fixed dt. Report any pair that fails to arrive, and draw the
   failing path in coral. **Reusing the actual controller is the whole point**:
   a bespoke pathfinder would pass rooms the walker gets stuck in, which is
   precisely the class of bug the lounge's comments record fighting
   (`lounge.js:221-231`).
5. Render the grid as one `InstancedMesh` of quads at cell centres, y+0.03,
   vertex-coloured. One draw call.
6. Cache; invalidate on any collider, prop, spawn or hide change.

Also overlay the room's `BOT_ZONES` circle permanently while the collider tab
is open, in a colour that shouts. It is a contract with the server
(`shared/constants.js:66-69`) and it is invisible today.

### 6.7 Undo / redo

A command stack over **ops**, not over objects.

```js
// commands.js
const cmd = {
  label: 'move 3 props',
  do(doc)   { /* mutate the draft op list */ },
  undo(doc) { /* inverse */ },
};
```

- 200 entries, `Ctrl+Z` / `Ctrl+Shift+Z` (and `Ctrl+Y`).
- Continuous drags coalesce: one `pointerdown` to `pointerup` is one command.
- Applying a command marks the draft dirty; a 1.5s debounce sends
  `layout-draft`. A browser crash loses at most one edit.
- Rebuilding the room does **not** clear the stack, because the stack refers to
  op ids that survive the rebuild. This is the direct fix for B-3.

### 6.8 Camera bookmarks

- `Shift+1..9` sets a bookmark from the current editor camera, `1..9` flies to
  it (0.4s smoothstep, reusing `_beginCamEase`'s easing shape,
  `src/core/engine.js:638-642`).
- Stored as `cam:bm_N` ops in the draft, so they travel with the room and
  survive a reload. Stripped before serving to non-admins.
- Two built-ins that are not bookmarks but belong on the same shelf:
  - `Shift+S` writes the current editor camera into `cam:static`, i.e. authors
    `room.staticCamera` from the shot you are looking at. The whole of task #14
    (static camera framing pass) was this operation done by hand in code.
  - `Shift+P` cycles the **spawn views**: for each entry in `room.spawnPoints`,
    place the camera exactly where the play camera would be on arrival
    (`spawn + camCfg.offset`, `src/core/engine.js:189-195`) and hold. DESIGN.md
    requires this check before shipping a room; today it means editing a file
    and reloading.

### 6.9 Draft, preview, publish

The owner's actual loop:

1. Walk into the room, `Ctrl+E`. The editor opens on the **draft** layer, forked
   from published on first edit. Nobody else sees anything.
2. Edit. Autosave 1.5s after the last command. Header shows unpublished count.
3. `P` toggles **preview**: panel hides, all gizmos off, colliders and hotspots
   live, camera returns to the player's normal mode. This is exactly what
   players will get, because it is the same build path. `P` again returns.
4. `V` runs the walk-check. Publish is soft-blocked on the gates in 5.5.
5. **Publish** opens a diff summary ("+6 props, 3 moved, 1 collider added, 1
   hotspot widened") and a confirm. On accept: server bumps `rev`, pushes the
   old published onto `history`, writes atomically, broadcasts `layout-rev`.
6. Everyone currently in the room rebuilds in place (`rebuildRoom` keeps their
   position) and gets a small toast. Everyone else evicts their cache.
7. **Revert**: the history list, one click, republishes an old rev.

**[judgment]** No approval workflow, no staged environments, no per-op review.
There is one admin. The safety net is history plus the walk-check, and that is
proportionate.

---

## 7. File-by-file plan

### New

| File | Contents | Size |
| --- | --- | --- |
| `shared/layout.js` | `LAYOUT_V`, op kinds, caps, `validateLayout`, `normalizeOps`, `mergeOps`, `opKey`. Dependency-free, imported by client and server. | ~220 lines |
| `shared/props.js` | `PROPS = { id: {name, group, animated?, footprint} }` plus `PROP_IDS`. The server-validatable half of the catalog, mirroring how `FURNITURE` lives in `shared/constants.js` while builders live in `src/world/furniture.js`. | ~120 lines |
| `src/world/props/index.js` | `buildProp(id)` registry, lazy per-group chunks, re-exports `furniture.js` as group `den`. | ~80 lines |
| `src/world/props/cove.js`, `snow.js`, `shore.js`, `green.js`, `deep.js`, `indoor.js` | Extracted builders, one per tranche, following the `furniture.js` contract exactly. | 200-500 each |
| `src/world/propPool.js` | Groups `prop` ops by catalog id, instances repeats, owns disposal. | ~140 lines |
| `src/world/applyLayout.js` | The step-3 pipeline of section 4.3, plus orphan collection and the clean-vs-applied hotspot diff. | ~260 lines |
| `src/ui/editor/index.js` | Shell, tabs, teardown, camera. Lifts the working parts of today's `editor.js`. | ~320 lines |
| `src/ui/editor/state.js` | Draft doc, selection set, dirty flag, autosave. | ~180 lines |
| `src/ui/editor/commands.js` | Every mutation as `{label, do, undo}`; the history stack. | ~240 lines |
| `src/ui/editor/palette.js` | Catalog browser, icons, ghost placement. | ~260 lines |
| `src/ui/editor/gizmo.js` | Drag plane, group pivot, snapping, key map. | ~280 lines |
| `src/ui/editor/pick.js` | Raycast, Alt-cycle, marquee, Tab drill (from today's file). | ~220 lines |
| `src/ui/editor/zones.js` | Collider and hotspot gizmos and forms. | ~240 lines |
| `src/ui/editor/walkcheck.js` | Grid raster, flood fill, headless route sim, instanced overlay. | ~260 lines |
| `src/ui/editor/publish.js` | Draft/preview/publish/revert UI, the `layout-*` frames, diff summary. | ~200 lines |
| `src/ui/editor/inspect.js` | Today's free mode, read-only, welded-piece finder intact. | ~300 lines |
| `server/layouts.js` | Load, validate, draft, publish, revert, history, atomic write, lock table. | ~280 lines |
| `data/layouts/*.json` | One per room, created on first publish. | data |

### Changed

| File | Change |
| --- | --- |
| `src/world/layout.js` | Grows from a session Map into the client layout store: `ensure(roomId)` HTTP fetch + cache, `getHandles(roomId)` (keeping `getOverrides` as an alias for one wave so `lounge.js:256` does not break), `setDraft`, `evict(roomId)`, `docFor(roomId)`. |
| `src/world/room.js` | Add `this.tagged = new Map()`, `tag(id, obj)`, `this.layoutOps = []`, `this.dataProps = []`. Promote `editorHandles/editorPatch/editorPatchAll/editorExport` to base-class no-ops so `editor.js` stops using `?.` everywhere. Keep `editable()` for the Inspect tab. |
| `src/core/engine.js` | `switchRoom`: `Promise.all([moduleLoad, layout.ensure(id)])` inside the existing 220ms timer (`:150-168`). After `room.build`, call `applyLayout`. `rebuildRoom`: same. Add `camLock` respected by `_resolveStaticCam` (fixes B-1, B-2). Emit a `room-built` event so the editor stops polling (fixes B-4). |
| `src/main.js` | Delete the `/^david/i` regex (`:183-185`); gate `Ctrl+E` on `game.state.admin`. Preload the spawn room's layout beside the chunk warm (`:94-101`). |
| `src/net/client.js` | Handle `layout-doc`, `layout-ack`, `layout-rev`; re-emit through `game.events` like every other frame family. |
| `server/index.js` | `GET /api/layout/:room` with ETag beside the other routes (`:179-230`). Six `layout-*` cases in the message switch, admin-gated, inside the existing try/catch, rate-limited. `layout-rev` broadcast. |
| `server/auth.js` | `admin: rec.admin === true` in `publicProfile` (`:37-50`). |
| `server/db.js` | Adopt the atomic write helper (AUDIT F-1); export it for `layouts.js`. |
| `shared/constants.js` | `LAYOUT_MAX_OPS`, `LAYOUT_MAX_BYTES`, `LAYOUT_PROP_CAP`, `PALETTE` (the DESIGN.md anchor colours as an indexed array, for `tint`). |
| `src/world/rooms/lounge.js` | `getOverrides` -> `getHandles` (one line, `:256`). Add `room.tag()` calls for the props `reg()` already tracks. |
| `src/world/rooms/*.js` | Per-room tagging pass (phase 4). One line per prop worth moving. Optional `LAYOUT_BASE` export. |
| `CONTRACT.md` | New room-contract section: `tag()`, `editorHandles` family, `LAYOUT_BASE`, and the rule that layout ops never carry callables. |
| `CLAUDE.md` | Protocol registry entry for the `layout-*` family; replace the "DEPLOYMENT BLOCKER: admin backdoor" section with the real admin flag; rewrite the "Dev layout editor" section. |

### Deleted

- `src/ui/editor.js` (881 lines) after phase 5; its useful halves live on in
  `pick.js` and `inspect.js`.

---

## 8. Migration order

Each phase is independently shippable and independently useful. Sizes are
S/M/L in the AUDIT.md sense.

**Phase 0. Admin flag (S).** `rec.admin`, `publicProfile`, `main.js` gate.
Closes AUDIT F-15 and task #13. Nothing else may land first, because from phase
1 onward the editor writes data every player renders.

**Phase 1. Persistence spine (M).** `shared/layout.js`, `server/layouts.js`,
the HTTP route, the six ws frames, `layout.js` store, engine plumbing,
`applyLayout` supporting only `handle`, `spawn` and `cam` ops. No new editor UI
beyond a publish button on the existing handles tab. **Value delivered:
today's handles mode becomes permanent for everyone.** The lounge is the test
room because it is the only one with handles. Also lands B-1, B-2 and B-4,
which make the existing editor materially nicer to use for free.

**Phase 2. Palette (M).** `shared/props.js`, `src/world/props/index.js`
re-exporting `furniture.js`, `propPool.js`, the `prop` op, `palette.js`,
placement ghost. **Value: 21 spawnable props with no new geometry work.**

**Phase 3. Editing quality (M).** `commands.js` (undo/redo), multi-select,
group ops, snapping, align/distribute. This is the phase that turns it from a
toy into a tool.

**Phase 4. Tags and code props (M, spread across room owners).** `room.tag()`,
`xform` and `hide` ops, orphan reporting, `LAYOUT_BASE`. Then one tagging pass
per room; a room owner tags their landmarks and their moveable dressing. Rooms
can land independently.

**Phase 5. Zones (M).** Collider and hotspot editing, the walk-check, publish
gates. Delete `src/ui/editor.js`; the Inspect tab takes over.

**Phase 6. Polish (S).** Camera bookmarks, `cam:static` authoring, spawn-view
cycling, publish diff summary, history UI, drift banner.

**Phase 7. Prop tranches (L, ongoing).** One extraction tranche per room per
session, forever. This is the long tail and it never blocks anything.

---

## 9. Risks and things I would refuse to build

**Risk: layout data outliving the code it patches.** Mitigations: orphans kept
and reported rather than dropped, `LAYOUT_BASE` banner, `history` rollback, and
a `layout-reset` that returns a room to pure code in one frame. **[judgment]**
Accept that a big room refactor costs some layout work; make that cost visible
rather than silent.

**Risk: the editor becomes the way rooms are built.** The composition notes in
the room files (the STATIONS comment block, `lounge.js:160-241`, is the best
design documentation in the repo) exist because rooms are code. A layout
document cannot hold that reasoning. **Mitigation:** keep `editorExport()`
working and encourage promoting settled layout ops back into the room file,
then clearing them. The editor is for iteration; code is for the record.

**Risk: draw-call creep.** `PropPool` instancing plus the 120-prop / 24-animated
caps. Add a live draw-call readout in the editor header; the number is one line
from `renderer.info.render.calls`.

**Risk: a bad publish breaks a room for everyone.** Walk-check gates, history
rollback, and the fact that `applyLayout` is wrapped so a throwing op is skipped
with a console error rather than taking the room build down with it. Same
posture as `makeFurniture`'s tolerant build (`house.js:137-152`).

**Things I would not build:**

- **A 3-axis translate gizmo.** The camera is a fixed 3/4 view and everything
  sits on the floor. XZ drag plus PgUp/PgDn covers it, and that is what today's
  editor already does correctly.
- **Free-form colour editing.** `tint` is a palette index or it does not exist.
  The mural's palette lock is the precedent and DESIGN.md's cohesion rule is the
  reason.
- **Arbitrary scripting on hotspots.** `kind` + validated `to`, resolved
  client-side from a fixed table. A layout document must never be able to
  express a function.
- **Multi-user live co-editing.** One admin, a soft lock, and per-admin drafts.
  Operational transforms for a two-person team is a year of someone's life.
- **Editing dens through this system.** They already have `houseEditor.js`, a
  different trust model, and per-player data. Keep them separate; share only the
  ghost/footprint helpers.
- **Persisting free-mode transforms.** Section 0. This is the one I would argue
  about.

---

## 10. Open questions for the owner

1. **How much do you want to move existing props versus add new ones?** If the
   answer is mostly "move what is there", phase 4 (tags) matters more than phase
   2 (palette) and they should swap. My read of the workflow so far, which is
   dragging station handles in the lounge, says tags first is closer to what you
   actually do **[judgment]**, but the palette is the more visible win.
2. **Should published layouts be visible to guests?** The HTTP route says yes by
   default. The alternative is admin-only preview until you are confident, which
   costs nothing to add (`?draft=1` with a token) but delays "the cove got
   tidied up" moments.
3. **Should the walk-check run on every publish or on demand?** On-demand plus a
   soft gate is specified. Always-on adds ~0.5s to a publish and would catch
   more.
4. **Do you want the editor to author `BOT_ZONES`?** It is currently a shared
   client/server constant (`shared/constants.js:66-85`). Making it a layout op
   is easy and would let you move the bots' wander circle when you move the
   furniture; it also means a layout op the *server* reads, which is a bigger
   trust surface. My default is no **[judgment]**.
