# Capy Cove: technical due-diligence audit

**Auditor:** external technical due diligence (kids/social MMO background)
**Date:** 2026-08-13
**Commit reviewed:** `29138bf` plus the uncommitted working tree (boot screen, first-run tour, settings panel)
**Scope:** full read of `CLAUDE.md`, `CONTRACT.md`, `DESIGN.md`, `docs/`, `shared/constants.js`, all of `server/`, `src/core`, `src/net`, `src/player`, `src/world` + 10 rooms, `src/minigames` + 11 games, `src/ui`. Live probing of the dev server on `:3001` (read-only; every write-path probe used guest sessions, which `recordFor()` deliberately never persists).

---

## 1. Executive summary

Capy Cove is a genuinely impressive piece of engineering for its size: ~28k lines of hand-written, dependency-light code delivering a nine-room 3D world, ten minigames, server-authoritative coins, a world clock, a shared mural and a 48-stamp progression spine — all procedural, no external assets, 232 KB gzipped to first playable frame — and its server hardening, teardown discipline and comment quality are meaningfully better than what I usually see at this stage.

But it is not a shippable all-ages social product: it has **zero moderation capability of any kind** — no chat filter, no mute, no block, no report-a-player, no ban, no kick, no admin surface, no age handling — while shipping free-text public chat, unlogged private whispers to any player anywhere, a freehand drawing game broadcast to eight children with no report path, and a permanent public mural with no removal tool; and its entire user database is a single non-atomically-written JSON file with no backups and no graceful shutdown.

**Overall grade: B− as a codebase, F on launch readiness.** The craft is real and the foundations are sound; the gap to "open to the public" is roughly one focused month of unglamorous safety, durability and operability work, none of which is architecturally hard.

---

## 2. What's genuinely good

I want to be specific, because the strengths are real and unusual.

**The coin road is a single, well-defended function.** Every payout in the game — minigames, races, duels, mining, bonfire, bottle, quests, doodle podium — goes through `grantCoins()` (`server/index.js:395-410`): rolling hourly backstop, balance read from the stored record rather than the connection snapshot, clamp, persist, notify. The comment at `server/index.js:372-376` explaining *why* the balance lives on the record (an idle second tab would otherwise roll back a purchase made in the active one) is someone who has been burned by multi-session accounting. Most projects this size mutate coins in six places.

**Replay protection on score submission is correctly designed.** `mgstart` arms a single-use run token (`server/index.js:2300-2302`); `score` consumes it and requires a matching game id and 5 s elapsed (`server/index.js:2303-2312`). I probed it: firing overlapping `mgstart` frames and then submitting scores yields **zero** payouts, because the second `mgstart` overwrites the pending run and the ids no longer agree. Correct, and clearly deliberate.

**Doodle is properly server-refereed — the model the other nine games should follow.** The server owns the word list, hands the three choices to the drawer alone, masks the answer for everyone else, scores guesses itself with edit-distance near-miss detection, and sends the near-miss ping *privately* so the room cannot triangulate the word off someone else's mistake (`server/index.js:2688-2708`). Wrong guesses are answered with silence, explicitly so the guess box does not become a second unmoderated chat channel (`server/index.js:2706-2707`). Podium coins are the server's own bookkeeping with an anti-farm guard for a round that emptied out (`server/index.js:1348-1358`).

**Progression genuinely cannot be forged.** `server/progress.js` advances quests only from `signal()` calls emitted by handlers that already validated and rate-limited the underlying action; `handleMessage()` only ever *reads*. Minigame stamp thresholds are measured against **server-paid coins**, not reported scores (`server/progress.js:412-416`), which closes the obvious hole. Stamps are idempotent by construction (`server/progress.js:472-485`).

**Peer-side move validation in the den duels is better than it first looks.** The server relays moves blind, but chess, connect4 and cards each re-run the opponent's move through their own rules engine and hard-stop on mismatch: `chess.js:1641-1660` bounds-checks the squares, rejects out-of-turn, and requires the move to appear in its own generated legal list, falling into `_desync()` at `chess.js:1663-1680`; `connect4.js:1376-1400` and `cards.js:4685` do the same. A *lone* cheater is therefore contained — the honest peer freezes and nobody is paid. That is a real defence, not a stub. (Its limits are F-17 and F-18.)

**XSS is clean, everywhere, across 31 `innerHTML` sites.** Every path where a remote-supplied string reaches the DOM uses `textContent` or `createTextNode`: chat lines (`src/ui/hud.js:379,383`), bubbles (`src/core/engine.js:451`), name tags (`src/core/engine.js:441`), milestone titles (`src/net/client.js:22`), toasts (`src/ui/hud.js:521`), friends, profile cards, den titles, invite lists. Every `innerHTML` in the client is a static author-written template; the only interpolations are `GAME_NAME`, HTML entities and editor-local scene values. There is no `insertAdjacentHTML`, `outerHTML`, `document.write`, `eval` or `new Function` anywhere in `src/`. Getting this right consistently across ten UI files by different authors is not an accident.

**Auth crypto is correct in the details that usually go wrong.** scrypt with per-user salts (`server/auth.js:9-11`), HMAC-signed tokens, and — notably — `timingSafeEqual` guarded by a **byte-length** check on both sides, with a comment explaining that a naive string-length check passes for multi-byte UTF-8 and then throws `RangeError` from the ws handler, killing the process (`server/auth.js:27-31`). Someone found that the hard way and wrote it down.

**Zero external assets is a strategic asset, not just a constraint.** `dist/` contains 29 `.js`, 1 `.css`, 1 `.html` and nothing else — no images, audio, models or fonts; even the favicon is an inline SVG data URI. Measured cold start: **~232 KB gzipped to first playable frame** (entry 207 KB + CSS 5.8 KB + spawn room 19 KB), with per-room and per-minigame code splitting keeping everything else off the critical path, and `src/core/engine.js:150` starting the room import *before* the 220 ms fade so the download hides under the transition. For a 3D multiplayer world with ten dressed rooms and twelve minigames, that is excellent.

**Teardown discipline in the minigames is the healthiest part of the codebase.** All eleven games extend `Minigame`; `setInterval` is used *nowhere* in `src/minigames/`; every RAF handle is cancelled in `dispose()`; every window/document listener is paired with a removal (`pong.js:897-902`→`920-925`, `chess.js:1447-1452`→`1469-1471`, `connect4.js:874-879`→`902-907`, and so on for all eleven). The 3D games run proper `disposeObject` + `scene.clear()` + `renderer.dispose()` + `forceContextLoss()` sequences (`sled.js:2175-2216`, `prophunt.js:3286-3345`, `cards.js:3068-3084`), and `critters.js:765-769` is a refcounted acquire/release pool. `disposeObject` even frees light shadow maps (`src/core/materials.js:63`), which most codebases miss.

**Rendering infrastructure is real, not decorative.** `src/core/materials.js:6-30` is a genuine keyed material cache with a `userData.shared` flag that the dispose sweep reads. There are 106 `InstancedMesh` sites across the rooms, six geometry-merge helpers, and accumulator `Batch` classes in three rooms. The plaza gate loop (`plaza.js:1357-1420`) builds three gates by pushing matrices into shared arrays and emitting ten instanced batches. Every room has exactly one shadow-casting directional light at 1024², exactly as `CONTRACT.md:29-31` requires.

**Audio is 100% procedural and rigorously scheduled.** 1,881 lines, no audio files, proper 90 ms/280 ms lookahead scheduling on the AudioContext clock (`src/core/audio.js:488-527`), nine generative per-room beds, and **exactly one interval for the whole module** which self-clears when no tracks remain — with the invariant documented at `src/core/audio.js:29-31`. Every oscillator is stopped; persistent sources are tracked and torn down; a half-built track is destroyed rather than left spinning (`src/core/audio.js:579-585`); throttled background tabs skip forward rather than dumping a burst of late notes (`src/core/audio.js:504-509`).

**Accessibility is above average for a game.** `role="dialog"`/`aria-modal` on every overlay, `aria-pressed` on toggles, `aria-label` on every icon-only button, `:focus-visible` outlines throughout, focus moved into overlays on open, and `prefers-reduced-motion` honoured in eight places — including the island map genuinely refusing to start its rAF loop (`src/ui/hud.js:2308-2309`).

**The documentation is unusually load-bearing and unusually honest.** `CLAUDE.md`'s protocol registry is a real, current spec of the wire format. More impressively, the docs *record their own failures*: the deployment blocker carries a `!!!` banner and a complete unpick list (`CLAUDE.md:132-144`); the den-match collusion vector is written down as known and accepted (`CLAUDE.md:69-71`); deliberate spec deviations are marked `DEVIATION` inline with reasoning (`server/index.js:2038-2044`); verifier fixes are annotated with what broke and why (`server/index.js:2243-2251`, `2325-2329`, `2821-2827`). `DESIGN.md:154-166` contains genuine post-mortem lessons. A codebase that argues with its own spec in writing is one you can trust the comments in.

---

## 3. Findings by area

Severity: **launch-blocker** / **important** / **nice-to-have**.

---

### 3.1 Architecture & scalability

One Node process, one event loop: HTTP static serving, WebSocket, the 10 Hz world tick, blocking scrypt and synchronous whole-database JSON writes all share it. State is in memory (`server/index.js:230-233`); durability is a flat file.

**F-1 — The user database is written non-atomically with no backup. LAUNCH-BLOCKER.**
`server/db.js:113-123` writes the entire users map straight over `data/users.json` with `fs.writeFileSync` — no temp-file-plus-rename, no `fsync`, no rotation, no backup. A crash, OOM kill, container eviction or full disk during that write truncates or corrupts **every account in the game**. `data/mural.json` (`server/index.js:1953`) is identical.
Suggestive evidence: `data/users.json` is currently **2 bytes** (`{}`), while `data/mural-reports/2026-08-07T13-40-41-259Z-DavidEdge.json` records a player who existed on Aug 7. Whatever caused that will happen again in production, and there will be no way back.
**Fix (S):** write to `.tmp`, `fsync`, `rename` (atomic on POSIX); keep the last N snapshots on a timer. Under an hour of work, and the highest-value change in this document.

**F-2 — No graceful shutdown; every deploy silently drops recent writes. LAUNCH-BLOCKER.**
The only process handlers are the two `console.error` hooks at `server/index.js:2786-2787`; there is no `SIGTERM`/`SIGINT` handler. All persistence is debounced — `saveSoon()` at 500 ms (`server/db.js:113-122`), the mural at 4 s (`server/index.js:1948-1957`). On a Fly or Render redeploy the process exits with those timers pending, so the most recent coin grants, purchases, friendships, den layouts and mural pixels are lost, silently, on every deploy.
**Fix (S):** on `SIGTERM`/`SIGINT`, stop accepting connections, flush both save paths synchronously, exit.

**F-3 — `uncaughtException` is swallowed and the process continues in unknown state. IMPORTANT.**
`server/index.js:2786` logs and carries on. Node's own guidance is that process state is undefined after an uncaught throw; here that means a half-mutated user record gets written to disk by the next `saveSoon()`. Since every ws handler is *already* individually wrapped (`server/index.js:2156-2762`), anything reaching this handler is genuinely unexpected.
**Fix (S):** log, flush, `process.exit(1)`, let the supervisor restart. With F-1/F-2 this turns a corruption event into a 3-second blip.

**F-4 — Auth rate limiting is global, not per-IP, behind any proxy. IMPORTANT.**
`authLimited(req.ip)` (`server/index.js:181-196`) with Express's default `trust proxy: false`. On Fly or Render, `req.ip` is the load balancer for every request, so the 12-per-minute budget is shared by the **entire internet**: one script locks out all signups and logins for everyone, and no attacker is ever individually limited. `authHits` is also never pruned.
**Fix (S):** `app.set('trust proxy', 1)`; prune `authHits` on a timer.

**F-5 — `scryptSync` blocks the world tick. IMPORTANT.**
`server/auth.js:9-11`, called from the HTTP handler on every signup and login. Node's default scrypt parameters cost ~50-100 ms of *blocking* CPU; each one stalls the 10 Hz broadcast for every player in the game. Bounded today only by the (broken, F-4) rate limit.
**Fix (S):** switch to async `crypto.scrypt`.

**F-6 — Single process, in-memory world: horizontal scaling is impossible without a rewrite. IMPORTANT (architectural).**
`fly.toml:14-16` pins one machine with a mounted volume; `render.yaml` likewise. Rooms and player state are process-local maps and persistence is a local file, so you cannot run two instances at all. Reasonable and cheap today, but it is a hard ceiling and should be a conscious one.

**Where each layer actually breaks (measured, not estimated):**

| Layer | Binding constraint | Breaks around |
|---|---|---|
| Client draw calls | Plaza ~135 static + 16 per capybara (§3.7) | **~20 players in one room** |
| Netcode egress | 59 B/player/frame at 9 Hz, O(N²) per room (§3.2) | **~50 CCU in one room** |
| Flat-file DB | Whole map re-serialised per debounced save, on the event loop | **~5-10k accounts** |
| `world.players` scans | `whisper` (`server/index.js:2277`) and `sessionsFor()` are O(all players) | **~1-2k CCU** |
| Single event loop | scrypt + JSON writes + 10 Hz tick | **~1k CCU**, sooner with signup traffic |

**Cheapest next step, in order:** atomic writes + backups (S) → SQLite via `node:sqlite` (M; removes the whole-file-rewrite class of problem and the ~5k-account ceiling in one move, one process, no new npm dependency) → interest-managed netcode (M, §3.2) → only then multi-process with a shared state store (L). Do not reach for the last one; nothing in the roadmap needs it.

---

### 3.2 Netcode

**Measured on the live server** (guest client, plaza, 12 s sample): 10 Hz state broadcast, **9.0 frames/sec observed**, **118 bytes for 2 entities = 59.0 bytes per player per frame**. Idle traffic with 2 bots present: ~1.2 KB/s.

The tick (`server/index.js:2791-2808`) sends every player in a room a full snapshot of every other player in that room, every frame, unconditionally.

| Players in one room | Per-client downstream | Server egress for that room |
|---|---|---|
| 10 | 5.3 KB/s | 53 KB/s |
| 25 | 13.3 KB/s | 332 KB/s |
| 50 | 26.6 KB/s | **1.33 MB/s (10.6 Mbps)** |
| 100 | 53.1 KB/s | **5.3 MB/s (42 Mbps)** |
| 200 | 106 KB/s | **21.2 MB/s (170 Mbps)** |

**F-7 — No dirty-flag, no delta, no interest management. IMPORTANT.**
A room of fifty players standing perfectly still costs exactly as much as fifty players sprinting. This is the biggest waste in the protocol and the reason a party in the plaza — the exact event the game is designed around — is the thing most likely to melt the server.
**Fix (M), increasing effort and payoff:**
1. **Skip unchanged entities.** Players already gate their *upstream* sends on movement (`src/net/client.js:408-412`); the server does not gate downstream. A room of idlers should cost near zero.
2. **Shorten the keys.** `{"id":"p2","x":0,"z":4,"rot":0,"anim":"idle"}` — ids and key names are 45 of the 59 bytes. Numeric ids and single-char keys roughly halve it for a day's work.
3. **Interest management.** Above ~40 in a room, full rate to the nearest N, quarter rate to the rest.

**F-8 — Double allocation per player per room per tick. NICE-TO-HAVE.**
`server/index.js:2801-2805` calls `roomSnapshot()` (building `snapshotFor()` objects) and then immediately `.map()`s them into *different* objects to strip `y`/`ride`. Two allocations per player per room per tick, discarded instantly. Build the wire object once.

**F-9 — Idle rooms still serialise. NICE-TO-HAVE.**
`if (players.length)` guards the broadcast, but `BOTS_PER_ROOM` defaults to 2 (`server/index.js:283`), so all nine rooms always have entities and always pay `roomSnapshot()` + `JSON.stringify()` at 10 Hz with zero humans online. `bots.inRoom()` (`server/bots.js:281-283`) also materialises and filters the whole bot map — nine full scans, ten times a second, forever. `COVE_BOTS=0` makes this free and is already the stated launch plan.

**F-10 — O(all players) scans on social paths. IMPORTANT above ~1k CCU.**
`whisper` materialises an array of every player in the game and linear-scans it, per whisper (`server/index.js:2277`). Worse, `friendsPayload()` calls `sessionsFor()` — itself an O(all players) scan (`server/index.js:454-460`) — **once per friend** (`server/index.js:481-489`). A 100-friend list at 1,000 CCU is 100,000 iterations, and one `friend-add` triggers it for every session on both accounts (`server/index.js:2412-2419`).
**Fix (S):** maintain a `usernameLower → Set<player>` index alongside `world.players`. Both collapse to O(1).

**Credit where due:** `broadcastToRoom` stringifies once and reuses the buffer (`server/index.js:258-266`); the ball sleeps and goes silent when it stops (`server/index.js:1646-1668`); mural state ships RLE-compressed (76 bytes for a blank wall, measured); `maxPayload` is 16 KB rather than the 100 MiB ws default (`server/index.js:2133`); per-message rate budgets are separated by hotness (social 5/s, match-move 25/s, ph-msg 15/s, dd-stroke 20/s) and each carries a JSON size cap. The doodle relay even re-serialises with a fixed field set (`server/index.js:2675-2681`), so no attacker-controlled extra fields survive the hop. This is thoughtful protocol work — it is the *volume* model, not the hardening, that needs revisiting.

---

### 3.3 Security & anti-cheat

**F-11 — Coins are farmable at 12,000/hour, and a production debug global makes it a console one-liner. LAUNCH-BLOCKER.**
Verified live against `:3001`. Sequence: `mgstart{game:'sled'}` → wait 5.05 s → `score{game:'sled', coins:99999}`:

```
run #1: asked 99999, PAID +150 -> 150 coins @5.1s
run #2: asked 99999, PAID +150 -> 300 coins @10.1s
run #3: asked 99999, PAID +150 -> 450 coins @15.2s
run #4: asked 99999, PAID +150 -> 600 coins @20.2s
```

The per-run cap (`shared/constants.js:22-33`, `268-273`) works exactly as designed — but the only floor on run *duration* is `MIN_RUN_MS = 5_000` (`server/index.js:24`), and no game is played. That is 108,000 coins/hour on `sled`, bound only by `MAX_COINS_PER_HOUR = 12_000` (`server/index.js:25`). Against a total game sink of 6,510 coins (§3.5), **a script owns every hat and one of every furniture item in 33 minutes.**

Three things make it worse than that:
- **`src/core/game.js:193` — `window.__game = game`** ships in the production build with no build flag. No client patching, no reverse engineering: open devtools, paste four lines. (`cards.js:3791` exposes `window.__cards` the same way.)
- **`mgstart` is unbound to room or state** (`server/index.js:2300-2302`): it does not check the player's room, that a minigame is mounted, or that a run is already pending — `p.run` is simply overwritten. Sled is farmable from the café.
- The wire format is documented in the header comments of each game file.

The design correctly identifies that it must not trust reported scores (`DESIGN.md:128-133`) and then trusts the *rate* instead. The cap is on the wrong axis.
**Fix (M), in order of value:** (1) per-game `minRunMs` in `MINIGAMES` — `DESIGN.md:117` specifies 60-120 s runs and `sled` cannot honestly finish in 5 s; this alone drops the ceiling ~12x. (2) A rolling **daily** cap at ~3-4x honest play instead of 12,000/hour, which is ~50x honest play (`docs/PARTY-GAMES.md:28` puts active play at ~1,500/hr). (3) Bind `mgstart` to the player's current room and refuse a second arm while one is pending. (4) Strip the debug globals behind `import.meta.env.DEV`.

**F-12 — Guests self-report their entire profile, including milestone-only cosmetics. LAUNCH-BLOCKER for the economy.**
Verified live. A guest `hello` declaring `coins: 999999`, `ownedHats:[...,'snorkel','golden_pick']`, `hat:'crown'`:

```
coins granted from client claim : 99999
ownedHats accepted              : ["none","crown","viking","pirate","snorkel","golden_pick"]
hat equipped on arrival         : crown
```

`server/index.js:2179-2194` clamps the *number* but filters hats only on `has(HATS, h)` — and `HATS` contains both milestone cosmetics. A guest arrives wearing the Royal Crown and can equip the Golden Pickaxe (30 stamps) and Diver Snorkel (5 stamps), visible to everyone in the room.

This is a straight inconsistency between hardened paths: `buy` explicitly refuses milestone items with a nice message (`server/index.js:2330-2332`), `buy-furn` likewise (`server/index.js:2498-2500`), and `server/bots.js:115` deliberately excludes them from the bot hat pool — but `hello` and `custom` do not. `custom` compounds it: `p.color = Number(m.color) || p.color` (`server/index.js:2292`) validates the colour against nothing, so the 12-stamp Aurora Dye is one frame away for anybody.

The client side is the same story by design: `game.loadLocal()` (`src/core/game.js:58-63`) does `Object.assign(this.state, JSON.parse(raw))` with no schema or clamping, and `applyProfile` (`src/core/game.js:33-46`) `Math.max`es local against server, so **a server profile can only ever grow a guest's balance, never shrink it**. 99,999 coins against a 6,510-coin catalogue is not a cap; it is "everything, free".
**Fix (S):** filter `milestone` items out of guest `ownedHats`; validate `custom.color` against `BODY_COLORS` + the record's `unlockedColors`; drop the `|| !p.registered` escape hatch at `server/index.js:2293`; schema-validate `loadLocal`.

**F-13 — Two accounts can farm duels indefinitely, at 115 coins a match. IMPORTANT (documented as accepted).**
`endMatch` pays 30 coins when both sides *name the same winner* (`server/index.js:857-889`); two colluding clients simply agree, with no code modification — just resign on cue. Per rigged chess match the winner takes **85** on the score road (`chess.js:1300`, clamped to 100) **+ 30** match bonus = **115**, the loser 5. Cycle time is bounded only by `MIN_RUN_MS` plus re-seating. Neither `endMatch` nor `grantCoins` tracks pair history, account age or win/loss ratio.
`CLAUDE.md:69-71` records this as known and accepted — the right instinct at prototype stage and the wrong answer at launch. Collusion rings are a *social* problem in this genre, not just an economic one; they are how the first wave of bad actors organises.
**Fix (S):** minimum match duration and minimum move count before a duel pays; a cooldown on repeat pairings.

**F-14 — `best` scores are unbound to gameplay. IMPORTANT — and it gates the leaderboard recommendation.**
`server/index.js:2313-2321` accepts any integer under 10 M for any known game, with no relation to a paid run, no `mgstart` token, and no duration check. The medal tiers on the player card (`src/ui/profile.js:32-48`) are therefore free to fake — and so is **any leaderboard built on this data**. See F-27.
**Fix (S):** accept `best` only from a run that `score` already paid, in the same handler.

**F-15 — The Ctrl+E admin gate is a display-name regex. LAUNCH-BLOCKER (already flagged by the team).**
`src/main.js:176-178`: `return /^david/i.test(game.state?.name || '')`, wired at `src/main.js:187`. Anyone registering as `davidsomething` gets the editor — and as a guest that name is entirely self-asserted via `localStorage['capycove-guest'].name`.
I verified the team's own assessment (`CLAUDE.md:132-144`, `src/main.js:163-175`) is accurate: `grep -E 'net|fetch|WebSocket|localStorage|send\(' src/ui/editor.js` returns **no matches**; its only imports are `three` and `src/world/layout.js`, whose overrides are an in-memory Map explicitly documented as session-only (`src/world/layout.js:12-14`). Outputs are `engine.rebuildRoom()`, a read-only textarea and `navigator.clipboard.writeText`. So this is a UX gate, not privilege escalation. It still must not ship: it teaches players that admin status is name-based, and the *next* feature added behind `isAdmin()` will be a real hole.
**Fix (S):** an `admin: true` flag on the record, surfaced through `publicProfile()`. The unpick list at `CLAUDE.md:141-144` is complete and correct.

**F-16 — Tokens cannot be revoked, and there is no password recovery. IMPORTANT.**
`makeToken` is `HMAC(username.expiry)` with a 30-day TTL (`server/auth.js:7,13-18`); `verifyToken` checks only signature, expiry and account existence (`server/auth.js:20-34`). No session id, no version counter, no logout, no password change — therefore **no way to invalidate a leaked token for 30 days**, and no reset flow at all. For a young audience that shares devices and forgets passwords, "no recovery, no revocation" is a support and safety problem, not just a security one.
**Fix (M):** add `tokenVersion` to the record, include it in the signed body, bump on password change; add a password-change endpoint. Note `data/secret.txt` (`server/db.js:125-132`) regenerates if missing — losing the volume logs everyone out at once, which is at least fail-safe.

**F-17 — Pong's seat-0 authority has no peer re-validation. IMPORTANT.**
Unlike chess, connect4 and cards (which re-run remote moves through their own rules engine, §2), pong designates seat 0 the sole ball and score authority (`pong.js:788,838`) and seat 1 accepts the wire scoreboard with only a range clamp (`pong.js:1681-1687`). **A patched seat-0 client owns pong outright** — declare 5-0 in one frame and the honest opponent agrees, so the two-party consensus check at `server/index.js:864-866` passes. Damage is capped at 60+30 per match by the 5-point ceiling, but it is a genuine one-sided hole in a paying game.
**Fix (S):** mirror the chess/connect4 pattern — seat 1 validates score deltas against the rally it observed.

**F-18 — No server-side rule validation for any den game. IMPORTANT (accepted design, with one hard constraint).**
`match-move` (`server/index.js:2559-2573`), `ph-msg` (`server/index.js:2600-2617`) and `dd-stroke` (`server/index.js:2656-2687`) are blind relays: rate-limited and size-capped, never inspected. The server does not model chess, connect4, cards, pong or shuffleboard at all. Peer validation (§2) contains a lone cheater; it does nothing against a colluding pair (F-13).
This is a defensible trade — the games are casual, the payout is bounded, and the alternative is five server-side rule engines. **It becomes indefensible the moment there is a leaderboard, a ranked mode or a tournament.**

**F-19 — No WebSocket origin check. NICE-TO-HAVE.**
`server/index.js:2133` has no `verifyClient` or origin validation. WebSockets bypass CORS, so any page can open a socket; exploitation needs a token the attacker does not have, which keeps this low, but an origin allowlist is one line.

**F-20 — XSS safety rests on convention with no backstop. NICE-TO-HAVE (latent).**
No finding today (§2), but there is no CSP meta tag in `index.html`, no Trusted Types policy, and no sanitiser. The discipline is one careless `innerHTML +=` away from regressing, in a file (`src/ui/hud.js`) that is 2,490 lines long and high-traffic.

**Input validation is otherwise good.** `has()` (`server/index.js:22`) is used consistently for every catalog lookup with the prototype-pollution reasoning spelled out at `server/index.js:20-21`; `readPoint` clamps and rejects (`server/index.js:1516-1530`); `validatePlacements` is all-or-nothing with ownership checks (`server/index.js:588-607`). The ball has a reach check so nobody volleys it from the dock (`server/index.js:1569-1571`), and the bottle and bonfire are validated against the position the player is already broadcasting rather than a claim (`server/index.js:2097-2100`, `1676-1697`). The doodle stroke receiver clamps coordinates client-side (`doodle.js:2352-2356`). Exactly the right instinct, applied nearly everywhere.

---

### 3.4 Trust & safety

This section decides whether the game can go live, and it is the weakest area in the codebase by a wide margin. I will be blunt, because this genre lives and dies here and because the rest of the work is good enough to deserve it.

I searched the entire repository for the vocabulary of moderation:

| Term | Files |
|---|---|
| `profanity`, `blocklist`, `blacklist`, `wordlist`, `badword` | **0** |
| `banned`, `abuse`, `safechat` | **0** |
| `coppa`, `gdpr`, `consent`, `privacy` | **0** |
| `ban`, `kick`, `mute` (player-directed) | **0** (all hits are `kick()` in the audio synth and audio mute) |
| `report` (player-directed) | **0** (the only report path is `mural-report`) |
| `admin` | 2 — both the temporary backdoor |

**F-21 — No chat filtering, muting, blocking, reporting, or moderation tooling of any kind. LAUNCH-BLOCKER.**
`chat` (`server/index.js:2259-2268`) applies a 400 ms rate limit and a 120-character clamp, then broadcasts verbatim. That is the entire pipeline. No filter, no logging, no per-player mute, no block, no report button, no moderator role, no way to remove a message, no way to remove a player. The player card (`src/ui/profile.js:1461-1516`) offers exactly *Message*, *Add/Remove friend*, *Visit their den* — nothing else.

For scale: Club Penguin ran Ultimate Safe Chat (menu-only) as the default for younger accounts, a filtered free-chat tier above it, a live human moderation team, continuously updated blocklists and automated ban tooling — and still had incidents. Habbo's 2012 crisis was triggered by exactly the surface Capy Cove ships today.

**F-22 — Whispers are private, unlogged, unfiltered, and cross-room. LAUNCH-BLOCKER.**
`whisper` (`server/index.js:2269-2283`) delivers arbitrary text from any player to any other online player, anywhere in the world, with no filtering, no logging, no rate limit beyond the shared 400 ms chat throttle, no block list, and no way to report. Nothing is retained, so even if a child tells a parent, there is no record for an operator to act on. Guests can whisper: `server/index.js:2269` does not check `p.registered`.

This is the highest-risk single feature in the game, and the newest (`5c6eacc`, three commits ago). In a kids' product, private messaging is the feature you build *last* — behind the moderation stack, gated to mutual friends, filtered and logged.
**Fix (M):** gate to mutual friends; run the public-chat filter; retain a rolling window for report review; add a per-player block covering both whispers and public chat.

**F-23 — The doodle canvas is the wrong feature to have left unmoderated, and the codebase proves it. LAUNCH-BLOCKER.**
`dd-stroke` (`server/index.js:2656-2687`) relays arbitrary brush-point arrays to up to eight players, unread. The drawer gets a blank canvas, eight crayons, three brush widths and an audience of children. The bounds are well engineered — 10 Hz batching, 45-point chunks, `MAX_PTS=700`, `MAX_STROKES=400` ring-buffered, a 4 KB server size cap, drawer-only enforcement — but they bound *bandwidth*, not content.

The contrast with the mural, in the same codebase, is stark:

| Capability | Plaza mural | Doodle |
|---|---|---|
| Report path | `server/index.js:2747-2749` → `reportMural()` | **none** |
| Snapshot to disk | `data/mural-reports/` | **none** |
| Attributed op log | 50,000 ops with a `by` field (`server/index.js:1893,2001`) | **none** |
| Persistence | `data/mural.json` | **none** |
| Palette | 14 colours, 1 pixel / 20 s | 8 colours, freehand, 10 Hz |

The slow, permanent, low-bandwidth, palette-locked surface got a full moderation pipeline. The fast, expressive, real-time drawing surface aimed at children got none. **The threat model was applied to the wrong feature.** Nothing is persisted, so after a complaint no operator can ever see what was drawn or by whom. Every drawing game aimed at a young audience — Draw Something, Skribbl, Gartic — ships a report button and a skip-the-drawer vote.
**Fix (S):** a report button that snapshots the canvas plus the drawer's identity, and a majority skip-drawer vote. Both are small; the vote also fixes the unrelated problem of an AFK drawer burning 80 seconds.

**F-24 — The mural is permanent, public, and has no removal path. LAUNCH-BLOCKER.**
96×54, 14 colours, one pixel per account per 20 s (`server/index.js:1981-2011`). The palette lock is a genuinely good mitigation, reasoned about explicitly (`docs/LIVING-COVE.md:57-59`, `src/ui/mural.js:33-36`), and it does prevent text and fine detail. It does not prevent a swastika, a phallus or a slur in blocks; ~40 pixels is plenty.

The economics favour the attacker badly: signup is free, instant and unlimited — no email, no verification, no captcha, and `authLimited` is globally shared (F-4) so it barely slows account creation. A hundred throwaway accounts is a hundred pixels immediately.

Against that, the only tool is `mural-report` (`server/index.js:2014-2031`), which writes a JSON snapshot to `data/mural-reports/`. The UX is nicely done — two-tap arming, 4.2 s auto-disarm, permanent disable, a warm confirmation (`src/ui/mural.js:543-564`) — but the user reports **the wall, not a person**: no reason field, no category, no per-author targeting, no case id, no follow-up. And there is **no un-paint, no region clear, no revert, no ban**. An operator who receives a report looks at a file on a disk (ephemeral on the Render config) and must then SSH in and hand-edit `data/mural.json` — assuming they ever run `ls`, because there is no notification path at all. Meanwhile the image is on the wall of the game's main hub, and `DESIGN.md`'s framing is that it "stays on the wall for good".
**Fix (S, and it is small):** an admin-only `mural-clear{x,y,w,h}` op, and a per-pixel `by` record so one account's contributions revert wholesale and the account is banned in one action. `mural.ops` already logs exactly the data needed (`server/index.js:1893,2001`) — it just has no consumer.

**F-25 — No age gate, no parental consent, no privacy policy, no terms. LAUNCH-BLOCKER (legal).**
Signup collects a username and password and nothing else (`server/auth.js:55-76`, `src/ui/title.js:92-96`). I read `index.html` and `src/ui/title.js` in full: there is no date-of-birth field, no age screen, no consent flow, no privacy policy, no terms, no rating meta. The only links in the document are the favicon data URI and the module script.

Worse, **"Play now" is the default tab** (`src/ui/title.js:16-20`). An anonymous child is in a live multiplayer session with global chat and private whispers within about five seconds and two clicks, having disclosed nothing and agreed to nothing. The only persistence disclosure anywhere is a single footnote at `src/ui/title.js:28`.

For a service whose own scope test is "a cozy, wholesome, capybara-themed hangout for **all ages**" (`CLAUDE.md:20`), with capybara mascots and a chibi art style, a US regulator will treat this as directed to children. COPPA then requires verifiable parental consent before collecting personal information from under-13s — and in the FTC's reading, persistent identifiers and free-text chat where a child can disclose personal information both count.

There is one genuine advantage: the game collects **no email, no real name, no analytics** — unusually good data minimisation that makes the compliance path much shorter than it would otherwise be. But "we collect very little" is not a defence for "we never asked how old you are".
**Fix (M):** a neutral age gate at signup; under-13 accounts default to restricted chat with whispers disabled; privacy policy and terms on the title screen; document what is stored and for how long. Have an actual lawyer read it — this is engineering judgement, not legal advice.

**F-26 — Names are unfiltered and appear world-wide. IMPORTANT.**
Registered names pass only `^[a-zA-Z0-9_]{3,16}$` (`server/auth.js:6`); guest names go through `cleanName` (`server/index.js:388`), which permits spaces and hyphens — so a guest can be `Kill Yourself` and it renders above their head in every room (`src/core/engine.js:441`) and permanently on mural ops (`server/index.js:2001`). Both filters are cosmetic: `s1ut`, `k1llyourself` pass unchanged. No wordlist, no rename tooling.

**The one thing that makes all of this fixable cheaply:** the game already has a menu-driven interaction vocabulary — emotes on single keys, hotspot prompts, and a doodle guess box that deliberately refuses to be a chat channel. A Club-Penguin-style two-tier chat (curated phrase menu by default, free text only for verified-older accounts) fits this design perfectly and is a week of work, not a quarter.

**Minimum viable T&S before any public launch:**
1. Server-side filter on `chat` + `whisper` + names, with a maintainable wordlist (S)
2. Report-a-player on the profile card, and report-a-drawing in the doodle round (S)
3. Per-player mute/block (S)
4. Admin flag + mute/kick/ban ops + mural region clear (M)
5. Rolling chat and whisper retention for report review (S)
6. Age gate + restricted-chat tier + privacy policy + terms (M)

---

### 3.5 Economy design

**Faucets** (coins/hour, computed from the constants):

| Source | Rate | Reference |
|---|---|---|
| AFK mining | **300/hr** (2 per 30 s + 2% gem at 25) | `server/index.js:47-50`, `904-916` |
| Active play (design intent) | ~1,500/hr | `docs/PARTY-GAMES.md:28` |
| Daily quests | ≤345/hr | `server/progress.js:60` |
| Duel / race wins | 30 per match, **unbounded rate** | `server/index.js:43`, `36` |
| Bottle | ~38/hr | `server/index.js:155` |
| Bonfire | ~23/hr (15 per cove night) | `server/index.js:135` |
| Signup gift | 100 once | `server/auth.js:66` |
| **Scripted (measured)** | **12,000/hr** | §3.3 F-11 |

**Sinks** — and this is the problem:

| Sink | Total |
|---|---|
| Every buyable hat (9 items, ladder 50/80/120/150/250/300/350/400/800) | **2,500** |
| One of every furniture item (20 items) | **4,010** |
| **Everything in the game** | **6,510 coins** |

**F-27 — The economy has no recurring sink and is exhausted in about four hours. IMPORTANT (design), and it is the main retention problem.**

| Playstyle | Time to own literally everything |
|---|---|
| AFK in the mine, nothing else | 21.7 hours |
| Design-intent active play (1,500/hr) | **4.3 hours** |
| Scripted (§3.3) | 0.5 hours |

Everything purchasable is a **one-time** purchase. Hats are unique; furniture stacks nominally but a den holds 60 items (`shared/constants.js:106`) across 20 types, so the practical ceiling is low. After roughly one long weekend a player's balance grows forever and buys nothing — and every faucet in the game becomes decorative simultaneously, taking every reward moment with it.

Hat prestige goes first and fastest. The Royal Crown at 800 coins is the designated multi-session status symbol (`DESIGN.md:105-107`); at intended earn rates it is **32 minutes of play**, and per F-12 any guest can simply declare they own it. No rarity, no scarcity, no time-limited stock, no achievement gate on any purchasable cosmetic.

Inflation is not the risk — there is no trading, no transfer, no marketplace, so coins cannot pool or price anything. The risk is the opposite and worse: **the currency becomes meaningless because there is nothing left to want.**

**Fix (M), the highest-leverage design work available:**
1. **Rotating stock.** A weekly featured hat that leaves the catalogue. Already parked at `DESIGN.md:152`. Cheapest possible fix; creates recurring demand and a weekly login reason.
2. **Consumables.** Party poppers, fireworks, a snack with a temporary effect, mural paint that places a 2×2. Anything bought repeatedly. The game has none.
3. **Charge for re-dyeing.** Colour changes are free and unlimited (`server/index.js:2292`); 20 coins makes expression a sink.
4. **Gifting.** Buy a hat for a friend — a sink, a social hook and a retention driver, on a friends system that already exists.
5. **Raise the ceiling.** The ladder stops at 800; one 5,000-coin prestige item gives the top of the curve somewhere to go.
6. **Decouple prestige from coins.** The stamp/milestone track already does this correctly (`shared/constants.js:260-266`) and is the best-designed part of the economy. Lean into it — after fixing F-12, or it means nothing.

Note also that the mine is the *dominant* strategy for anyone not enjoying the minigames: 300 coins/hour for standing still, no cap, no session limit (`docs/PARTY-GAMES.md:29` explicitly rules out a cutoff). Against *active* play it correctly isn't optimal; against *not playing* it is infinitely better, and it teaches players that the way to get rich is to leave the tab open. That is a habit worth not teaching.

---

### 3.6 Retention mechanics

**What is genuinely strong:**

The wave-7 progression spine is well above what I expect at this stage. Three seeded daily quests per account per cove day, drawn deterministically so a reconnect never rerolls the board (`server/progress.js:192-215`) — a detail that matters more than it sounds and is frequently got wrong. Weighting guarantees at least one social and one minigame quest (`server/progress.js:199-202`), pushing players toward the parts of the game that need other people. 48 authored stamps across seven categories (`shared/constants.js:192-249`), deliberately over-provisioned past the 40-stamp milestone so stamps requiring other players cannot lock a solo player out (`shared/constants.js:189-191`). Five milestone cosmetics coins cannot buy, which the server refuses to sell.

The world clock, weather, aurora and daily bottle give the world a reason to look different when you return. Parties with a 90-minute cooldown create scheduled social events. `regular` (7 days) and `veteran` (30 days) are real long-horizon hooks. The uncommitted first-run tour (`src/ui/firstrun.js`) advances on *player action* rather than timers, never takes input, and survives room changes — a genuinely good onboarding pattern.

**F-28 — Nothing is repeatable past the album, and there is no re-engagement channel. IMPORTANT.**
Every retention mechanic is finite. 48 stamps: one-and-done. 5 milestones: one-and-done. Once the album fills the entire progression layer stops, and per §3.5 the economy has already stopped. No season, no monthly reset, no repeatable ladder, no content cadence.

Worse, there is **no way to bring a player back**. No email is collected, so there is no notification, no "your friend threw a party", no "the shop has new hats". The only re-engagement mechanism is the player independently deciding to type the URL. In this genre day-7 retention is largely a function of *reminding people*, and the game has no channel at all.

**F-29 — No leaderboards, and the score data cannot currently support them. IMPORTANT.**
Ten minigames, per-game bests persisted server-side, and the only place a best is ever visible is your own profile card. No room leaderboard, no daily high score, no weekly champion, no friends comparison. For a game whose core loop is "play a minigame, show off in the social space", this is the largest missed retention hook.
**The hard constraint:** per F-14, `best` accepts any integer with no relation to a paid run, so a leaderboard shipped today would be topped by a one-line console paste within a day of launch. Fix F-14 first. Launch leaderboards on the single-player minigames only, where the run token and caps at least bound the lie — **not** on the den duels, where the server models nothing (F-18).

**What a live game would add in season one:**
1. **Leaderboards** — daily/weekly, per game, friends filter. Data exists; this is a query and a UI, *after* F-14. (S)
2. **Login streak** rewards, on top of `c.days` (`server/progress.js:567-570`) which already tracks real calendar days. (S)
3. **A re-engagement channel** — optional email purely for party and season notifications. Handle carefully given F-25. (M)
4. **Seasons.** A repeatable 4-6 week cycle with a fresh stamp sheet and rotating cosmetics. `DESIGN.md:150` already notes the palette system makes seasonal re-dressing cheap; this is the intended answer to F-28. (L)
5. **Friend-shaped hooks.** Gifting (§3.5), visit-a-friend's-den rewards, co-op quests. The friends system exists and does almost nothing. (M)
6. **A pet.** Parked at `DESIGN.md:148-149` as the puffle-equivalent. In every game in this lineage the pet is a top-three retention driver: a reason to come back daily that costs the player nothing to care about. (M)

---

### 3.7 Client performance & quality

**Load weight (measured, gzipped):** entry 207 KB, CSS 5.8 KB, spawn room 19 KB → **~232 KB to first playable frame**; largest lazy chunk `cards` at 53 KB; whole `dist/` 628 KB gzip / 2.1 MB raw across 29 chunks. Code splitting per room and per minigame works, nothing loads until entered, and there are no external assets. The new inlined boot screen (`index.html:14-160`) paints on the first frame before any JS, tracks real milestones rather than a fake timer (`src/main.js:12-70`), and removes both itself and its `<style>` at handoff. Well executed. (Note `dist/` is stale relative to the working tree and under-reports by the new settings + firstrun modules.)

**F-30 — Instanced meshes leak GPU buffers on every room change, in 8 of 10 rooms. IMPORTANT.**
`disposeObject` (`src/core/materials.js:55-70`) disposes geometry and materials but never calls `InstancedMesh.prototype.dispose()`. `instanceMatrix` and `instanceColor` are `InstancedBufferAttribute`s owned by the *mesh*, not the geometry — `geometry.dispose()` does not touch them, and only `InstancedMesh.dispose()` fires the event that makes three.js call `gl.deleteBuffer`.

Only two rooms track and free them: `club.js:218`/`1423` and `mine.js:2371`. The other eight leak on every visit — **plaza ~66 instanced meshes per visit**, beach 18, jungle 15, peak 12, drift 10, plus the `Batch` builds in cafe/lounge/house. Room-hopping accumulates orphaned GL buffers monotonically for the session.

This is the same class of bug as the shadow-map leak that `DESIGN.md:158` records as one of the two that actually shipped — and it lives in the same shared function, which is exactly the file the post-mortem says to put your best reviewer on.
**Fix (1 line):** `if (o.isInstancedMesh) o.dispose();` in `disposeObject`.

**F-31 — The saved graphics preset is never restored at boot. IMPORTANT.**
`applySavedSettings()` exists and is correct, but its only call site is `src/ui/menu.js:277-279`, and the menu is lazy-imported on button click (`src/ui/hud.js:513`). So a returning player on a weak device who set "Low" last session **boots at full quality every single session** — bloom on, pixel ratio 2, shadows on — until they manually reopen Settings. The code notes its own gap at `src/ui/menu.js:275-276`: *"A boot hook in main.js would be better; that file is not ours to edit."* That is the ownership model producing a real user-facing defect.
**Fix (S, ~5 lines):** call `applySavedSettings(game)` from `src/main.js` at boot.

**F-32 — "Low" does not actually turn off bloom. IMPORTANT.**
`src/ui/settings.js:143` implements low mode as `postfx.tune({ strength: 0 })`. `UnrealBloomPass` has no early-out for zero strength: it still renders its full five-level downsample/upsample pyramid — roughly 13 fullscreen draws — and then composites the result multiplied by zero. "Low" pays the entire bloom cost for no visual effect, on exactly the hardware that cannot afford it. The pixel-ratio and shadow-map halves of the preset (`src/ui/settings.js:151-173`) are implemented correctly.
**Fix (S):** expose `setEnabled(bool)` from `postfx` and set `_bloom.enabled = false`; `EffectComposer` skips disabled passes.

**F-33 — `antialias: true` allocates a multisampled framebuffer that postfx makes useless. NICE-TO-HAVE.**
`src/core/engine.js:49` requests MSAA, but when the chain is live the only thing drawn to the default framebuffer is the FXAA fullscreen quad (`src/core/postfx.js:136`). The header comment at `src/core/postfx.js:26-29` explains why FXAA replaces MSAA inside the chain; the renderer flag was simply never turned off. On a 1080p DPR-2 display that is on the order of 130 MB of dead VRAM.
**Fix (1 line).**

**F-34 — The shadow map re-renders every frame for a sun that moves every 10 seconds. IMPORTANT.**
`src/core/engine.js:53-54` enables `PCFSoftShadowMap`; `shadowMap.autoUpdate` is never set to `false` anywhere in `src/`. Every shadow caster in the room is re-submitted every frame even though the light only changes on server clock ticks. Disabling `autoUpdate` and setting `needsUpdate` in `onClock` roughly halves geometry submissions — the single highest-leverage rendering fix available.
**Fix (S).**

**F-35 — Undebounced resize reallocates ~88 MB of render targets. IMPORTANT on mobile.**
`src/core/engine.js:76` binds `resize` with no debounce; each event calls `postfx.resize` (`src/core/postfx.js:154-159`), reallocating the composer's ping-pong pair and all five bloom mip pairs. On mobile the URL bar showing/hiding fires this repeatedly, in bursts.

**F-36 — The spawn room exceeds its own draw-call budget before any players are in it. IMPORTANT.**
`CONTRACT.md:28` and `DESIGN.md:142` set ~120 draw calls per room. Counting call sites and loop multipliers, **plaza lands around 135** (66 `put()` + 63 `inst()` plus loops) — and plaza is the default spawn room (`src/main.js:314`), so it is every player's first frame. Every other room is comfortably inside budget (beach ~79, peak ~68, club ~64, down to drift ~26).

The paradox is that plaza is *architecturally* the best-optimised room; 63 separate instanced batches is itself the cost, and many share the same primitive and differ only in colour — collapsible into per-instance-colour batches the way `cafe.js`'s `Batch` class already does.

**Worse, the multiplayer cost is uncounted.** `src/player/avatar.js:417` documents **16 draw calls per capybara**, and there is no per-room player cap anywhere in `shared/constants.js` or `server/index.js`. So plaza + 2 bots + 1 player ≈ 183, and **plaza with 20 players ≈ 455 draw calls**. Only `drift.js:49` budgets for this explicitly ("~33 for the room + 16 per capybara"); plaza does not.
**Fix (M):** collapse plaza's instanced batches by primitive; add a soft per-room population cap with overflow rooms — which this genre needs anyway for social reasons.

**F-37 — Two live WebGL contexts during 3D minigames. IMPORTANT on mobile.**
`src/core/engine.js:36,625` — `paused` only skips the tick; the world renderer and its context stay alive. Meanwhile `sled.js:898`, `prophunt.js:1046` and `cards.js:1972` each create their own `WebGLRenderer`. Mobile Safari caps live contexts and evicts the oldest, so context loss on the *world* renderer while a minigame runs produces a black room on exit. `cards.js:1973-1977` degrades gracefully when the context cannot be created; **`sled.js:898` and `prophunt.js:1046` have no `try/catch` at all.**

**F-38 — Ground raycasts are brute-force with no BVH. NICE-TO-HAVE.**
`src/core/engine.js:349-366` `snapY()` does `intersectObjects(room.groundMeshes)` once per frame for the local player and once per *moving* remote (`src/net/client.js:392`). Peak's sole ground mesh is 6,728 triangles (`peak.js:1666`); beach's is 3,344. With ten moving players that is ~67k ray-triangle tests per frame on the main thread. The mitigation at `src/net/client.js:387-391` — skipping the raycast for remotes that have not moved ≥0.01 units, with the reasoning written down — is a real optimisation on a genuinely hot path, but moving crowds still pay full price.

**F-39 — Per-frame allocations and forced layout in the engine and HUD. NICE-TO-HAVE.**
The room `update()` methods are remarkably clean — rooms consistently pre-allocate module-scope scratch objects, and `peak.js:156` explicitly notes "the clock costs zero allocations per frame". The only room-level offender is `jungle.js:2263`, one `THREE.Color` per frame. The leaks are all in shared code, which *knows* better (`src/core/engine.js:8` declares a scratch vector with the comment "snapY runs per remote per frame; don't allocate"):
- `src/core/engine.js:459,477` — a `THREE.Vector3` per frame in `_updateOverlays` and `_updateHotspots`
- `src/core/engine.js:460` — `[...this.overlays]`, a full array copy of the overlay set every frame; `Set` iteration already tolerates in-loop `delete`
- `src/core/engine.js:665` — `camTarget.clone()` every frame in the default follow-camera branch (the static branch above it is allocation-free)
- `src/core/engine.js:468-469,515-516` — two template-literal CSS strings plus two style writes per overlay per frame; with 20 players that is 80 string allocations and 80 style mutations per frame. `transform: translate3d()` on one property would be cheaper and GPU-composited.
- `src/player/controller.js:48,70,78` — three heap allocations per walker per frame, while `avatar.js:66-70` and `swim.js:30-33` already use the scratch-vector pattern. This file was simply never converted.
- `src/ui/hud.js:417-418` — reads `scrollHeight`/`scrollTop`/`clientHeight` on **every incoming chat message**, forcing a synchronous layout flush even when the history panel is hidden, and only uses the result if it is open.
- `prophunt.js:3006-3016` and `sled.js:1338-1340` build a change-signature string (array + map + join, or copy + sort + concat) every frame purely to decide whether to repaint. Small N, so GC pressure rather than a stall, but the same pattern twice and both fixable with a dirty flag.

**F-40 — `toonCache` is never evicted and is keyed on per-avatar colour. NICE-TO-HAVE.**
`src/core/materials.js:6-7,23-30`. `sled.js:296` calls `makeToon()` with a colour derived from each rider's avatar colour, so every distinct rider colour a player races against mints a permanent `MeshToonMaterial` and GPU program for the tab's lifetime. It grows with *social exposure* rather than play time, which is the awkward direction.

**F-41 — No mobile viability. IMPORTANT.**
There is a correct viewport tag (`index.html:5`, and commendably no `user-scalable=no`), and the boot screen is fully responsive — genuinely the most mobile-friendly part of the product. Everything after it is not:
- **`src/styles.css` contains six `@media` blocks. Four are `prefers-reduced-motion`. The other two adjust the font size of map-pill labels.** The HUD, chat, shop, profile, settings, quests, mural, house editor and all eleven minigame overlays have no breakpoints at all.
- **Zero device detection.** No `ontouchstart`, `maxTouchPoints`, `pointerType`, coarse-pointer media query, or user-agent check anywhere in `src/`.
- Tap-to-move works incidentally (`src/core/engine.js:79,370`). Almost nothing else does: hotkeys W/D/M/C/Enter, all chat and whispers, and most minigames need a keyboard. Snowballs require right-mouse press-and-hold and are unreachable on touch — acknowledged in-code at `peak.js:182`: *"A right button is a mouse thing: there is no snowball on touch."*
- Hover-only affordances with no touch equivalent: map-pill descriptions, shop preview, and the chat-history panel's entire open/close state machine (`src/ui/hud.js:430-434`).
- `.hud-btn` is ~38 px tall, under the 44 px touch-target guideline, and its `:hover` transform sticks after tap.
- GPU: pixel ratio capped at 2 rather than 1, PCF soft shadows always on, ~16 postfx passes and ~88 MB of render targets, plus F-33's wasted MSAA. Expect either context loss on the first room build or single-digit frame rates on a mid-range Android device.

This matters commercially more than technically — the audience for this genre is overwhelmingly on tablets and phones. Shipping desktop-only is a legitimate scoping decision, but it should be a *decision*; right now it is an omission, and nothing in `DESIGN.md` or `CLAUDE.md` states a target platform.

**F-42 — Chat and toasts are silent to screen readers. NICE-TO-HAVE.**
`#chat-log` (`src/ui/hud.js:283`) and `#toasts` (`src/ui/hud.js:289`) have no `aria-live`, so incoming chat, whispers, quest completions, coin grants, party announcements and room banners are all announced to nobody. Given how much else in this codebase is done right (§2), this is the single highest-impact accessibility fix and it is one attribute each. Also missing: focus traps and focus restoration in overlays despite `aria-modal="true"`, and the whisper-reply `<div>` (`src/ui/hud.js:408-410`) is mouse-only with no `role`, `tabindex` or key handler.

**F-43 — Two rooms bypass the audio module entirely. NICE-TO-HAVE.**
`drift.js:1868-1880` creates a **second, room-local `AudioContext`** and connects the whale song straight to `destination`; `cards.js:3112` does the same. Consequences: the player's volume sliders do not apply (they only touch `musicBus`/`sfxBus`), mute is checked once at call time so muting mid-call does nothing, and each burns one of the browser's ~6 concurrent context slots. Both are closed correctly in `dispose()`, so they do not accumulate — but it is a contract violation against an otherwise rigorous audio module.
Related: the returning-registered-player path calls `audio.init()` from a `fetch().then()` callback (`src/main.js:322-328`), not a user gesture, so `ctx.resume()` rejects silently. It self-heals on the first `audio.play()`, but a player who only watches the arrival swoop hears nothing. A one-shot `pointerdown`/`keydown` unlock listener would close it.

---

### 3.8 Code health & operability

**The agent-wave development model held up better than I expected, and the evidence is in the artifacts.** `CONTRACT.md` froze the Room and Minigame interfaces before parallel work started, and conformance is real: all ten rooms extend `Room`, export a `<Name>Room` class, implement `build`/`update`/`dispose`, and set `groundMeshes`, `spawnPoints`, `hotspots`, `obstacles`, `cameraHint` and `staticCamera`; none override `getSpawn()`. All eleven minigames extend `Minigame`. The registries stayed one-line-per-module. Deviations are few and justified (mine has no `onClock` because it is underground; lounge alone has `routeTo()` because it has stairs; beach alone sets `minWalkY` for the shoreline; drift disables the walk controller because you swim).

The file-ownership map (`CLAUDE.md:25-43`) is the right rule for parallel agents, and `DESIGN.md:155-158` records the key finding — that the only two integration bugs lived in *shared* code, not in any owned file. F-30 is the third instance of exactly that prediction coming true, in exactly that file.

The docs-as-contracts system works: the protocol registry is accurate against `server/index.js`, deviations are argued inline, verifier fixes are annotated with what broke. Defensive coding is consistent (`hasOwnProperty.call` for registry lookups, `Object.create(null)` for maps, try/catch around every `localStorage` access, `src/core/events.js:12-16` wrapping every handler so one bad listener cannot kill an event). Re-entrancy is handled (`src/core/engine.js:142-147` collapses double-clicked exits with a sequence counter).

**F-44 — There is not a single test, and no CI. LAUNCH-BLOCKER for operability.**
Zero test files, no test framework, no `test` script, no `.github/`, no CI config. The only verification described anywhere is `npm run build` staying green plus a manual import-side-effect check (`CLAUDE.md:102-105`) and manual screenshot review.

For 28,000 lines with a hand-rolled 60-message wire protocol, a coin economy and 48 progression award rules, this is the largest structural risk to the project's *future*. Every change is a full manual regression. The economy especially: `clampCoinsForGame`, `grantCoins`'s backstop, the milestone-purchase refusals, the guest clamps and the doodle scoring are all pure, fast and trivially testable. `server/index.js:73-79` already builds environment-variable time hooks **specifically so a headless ws suite can run a 40-minute cove day in two seconds** — the affordance for testing was built and then never used.
**Fix (S for real value):** `node --test` (built in, honours the no-new-deps rule). Twenty tests over the coin road, the caps, the guest clamps and the progression rules would catch most of what an economy regression looks like, plus a GitHub Action running build + tests.

**F-45 — No observability. IMPORTANT.**
`console.log`/`console.error` with no levels, no structure, no player correlation (`server/index.js:2221,2761,2769`). `/api/health` returns `{ok, online, rooms}` and nothing else (`server/index.js:206`) — no uptime, memory, tick timing, error counts or coin volume. No error tracking, no metrics, no alerting.

When the server is slow at 200 CCU you will not know whether it is the tick, scrypt, the JSON write or GC. When the economy is being farmed you will not notice, because nothing counts payouts per account per hour except the in-memory backstop that silently drops them.
**Fix (S):** structured JSON log lines with a player id; extend `/api/health` with tick p95, heap and connection count; log every `grantCoins` above a threshold with its reason. That last one alone turns F-11 from invisible into a daily report line.

**F-46 — Substantial duplication, driven by the ownership model. NICE-TO-HAVE (velocity tax).**
"One room, one owner, self-contained" (`CLAUDE.md:31`) predictably caused the same helpers to be reinvented per file. `mergeParts` in `jungle.js:212-247` and `mine.js:191-226` is **byte-identical**; `peak.js:361-396` differs by one adjacent constant. `Batch` in `cafe.js:118-148` and `house.js:87-118` is identical bar a brace. The `club.js`/`mine.js` cave helpers differ only in four noise-frequency literals. Across the rooms: `part`/`link`/`paintGeo`/`solidMesh`/`glowMesh` ×3, `daylight` ×5, `rng` ×5, `mulberry32` ×4, `clockPhase`/`washPhase` ×3, `texMat` ×3 — roughly **600-900 duplicated lines**.

The minigames are worse: `_after(ms, fn)` appears **byte-identical seven times**, `esc()` eight times, `clamp()` seven, `mulberry32` five, plus five independent copies of the PvP handshake reader and the `match-done` sender, and three independent capybara face painters. The UI layer repeats it again: `elm()` ×6, `mountPoint()` ×8, `ensureStyles()` ×7, and **the entire overlay lifecycle** (singleton, unsubs array, guarded `close()`, backdrop handler, Escape key, `is-closing` + 160 ms remove, focus-on-open) copy-pasted five times.

This is not merely untidy: **a bug fixed in one copy stays broken in the others**, which is precisely what F-30 is. It is also the direct, predictable cost of the ownership model, and worth pricing explicitly against its benefits.
**Fix (M):** a shared `src/world/lib/` for the room helpers, promote the minigame shell (splash, countdown, results, play-again, quit) into `Minigame`, and one `overlay.js` for the UI lifecycle.

**F-47 — `src/ui/hud.js` is a god object, and 71% of it does not belong there. NICE-TO-HAVE.**
2,490 lines. `initHud` alone carries **18 distinct responsibilities** (coin pill, room chip, population, connection dot, chat submit + `/w` parser, fading log, scrollback state machine, emotes, mute, camera toggle, three lazy-loaders, toasts, party state machine, quest toasts, stamp-slam queue, map). But the bulk is unrelated: **~1,765 lines (71%) are a hand-coded canvas island-map illustration** — 36 painter functions with zero coupling to HUD concerns, and an obvious extraction to `src/ui/map/`. `CLAUDE.md:31-32` already flags the file as high-traffic and needing coordination, which is an accurate diagnosis and an admission that the ownership model has one file it cannot cleanly assign.

**F-48 — Observers and subscriptions in `hud.js` are never released. NICE-TO-HAVE.**
`src/ui/hud.js:2466-2471` creates a `MutationObserver` and a `ResizeObserver` that are **never disconnected**; ~20 `game.events.on()` return values are discarded (`:296,308,326,331,350,402,453,470,489,518,531,532,556,574,582,2438,2472,2476`); two global `keydown` listeners (`:446,495`) are never removed. All are session-lifetime so the leak is bounded, but nothing is releasable — and it sits in contrast to the rest of the codebase, where teardown is handled well (`mural.js:585`→`593-597`, `quests.js:440`→`462-466`, `editor.js:857`→`863-880`). Two idioms also coexist inconsistently, sometimes in one function: `.onclick =` (12 sites in `hud.js`) and `addEventListener` — `friends.js:117` uses the latter for a row while `hud.js:2398` uses the former for a structurally identical map pill.

**F-49 — The README is stale. NICE-TO-HAVE.** It advertises "five locations" and "three minigames"; there are nine rooms and ten minigames. Harmless internally, but it is the first file anyone evaluating this project reads.

**Deploy story.** Three host configs are committed and the Dockerfile is a correct multi-stage build. Two problems: `render.yaml` specifies `plan: free`, which does not support persistent disks and spins down on idle — with in-memory world state and F-2's missing shutdown flush, that combination loses data routinely, and it is also where `data/mural-reports/` would evaporate. And `fly.toml` is the only config that works as written, on exactly one machine. There is no backup strategy for the volume, no restore procedure, and no migration path documented for the flat file. Given F-1, that is what turns one bad day into an unrecoverable one.

---

## 4. The roadmap I'd pitch

Sizes: **S** ≤ 2 days, **M** ≤ 2 weeks, **L** > 2 weeks.

### Days 0-30 — everything that blocks a public launch

*Nothing here is optional and nothing here is architecturally hard.*

**Durability (this week)**
1. Atomic writes (temp + fsync + rename) for `users.json` and `mural.json` — **S** — F-1
2. `SIGTERM`/`SIGINT` flush-and-exit — **S** — F-2
3. Rotating on-disk backups + a written, *tested* restore procedure — **S** — F-1
4. `uncaughtException` → flush, log, exit(1) — **S** — F-3

**Trust & safety (the long pole; start day 1, in parallel)**
5. Server-side filter over `chat`, `whisper` and names — **S** — F-21, F-26
6. Report-a-player on the profile card + report-a-drawing in the doodle round — **S** — F-21, F-23
7. Per-player mute/block — **S** — F-21
8. Admin flag + mute/kick/ban ops + mural region clear + per-account mural revert — **M** — F-21, F-24
9. Skip-the-drawer vote — **S** — F-23
10. Gate whispers to mutual friends; filter and retain them — **M** — F-22
11. Age gate + restricted chat tier for under-13 + privacy policy + terms — **M** — F-25

**Economy & cheat**
12. Per-game `minRunMs`; bind `mgstart` to room + refuse double-arm — **S** — F-11
13. Rolling **daily** coin cap at ~3-4x honest play — **S** — F-11
14. Strip `window.__game` / `window.__cards` from production builds — **S** — F-11
15. Filter milestone items from guest `ownedHats`; validate `custom.color`; schema-validate `loadLocal` — **S** — F-12
16. Minimum duration + move count + repeat-pairing cooldown on duel payouts — **S** — F-13
17. Bind `best` to a paid run — **S** — F-14

**Security**
18. Remove `isAdmin()`; replace with a server `admin` flag — **S** — F-15
19. `app.set('trust proxy', 1)`; prune `authHits` — **S** — F-4
20. Async scrypt — **S** — F-5
21. `tokenVersion` + password change endpoint — **M** — F-16
22. Peer-validate pong's score deltas — **S** — F-17

**Operability**
23. `node --test` over the coin road, caps, guest clamps and progression — **S** — F-44
24. GitHub Action: build + test on push — **S** — F-44
25. Structured logging + extended `/api/health` + coin-grant audit line — **S** — F-45

**Ship gate:** 1-25 complete. Launch with `COVE_BOTS=0` as already planned, and an invite list small enough that a human can watch the chat log.

### Days 31-60 — make it survive its first real crowd

26. One-line `InstancedMesh.dispose()` fix — **S** — F-30 *(do this on day one; it is in the list here only because it is not a launch blocker)*
27. `applySavedSettings` at boot; make "Low" actually disable bloom; drop `antialias` — **S** — F-31, F-32, F-33
28. `shadowMap.autoUpdate = false` + `needsUpdate` on clock ticks — **S** — F-34
29. Debounce resize — **S** — F-35
30. SQLite via `node:sqlite` — **M** — F-6. Removes the whole-file-rewrite ceiling; no new dependency; still one process.
31. Netcode: skip unchanged entities + shorten wire keys — **M** — F-7. ~4x headroom for a week's work.
32. `usernameLower → sessions` index — **S** — F-10
33. Collapse plaza's instanced batches; add a soft per-room population cap — **M** — F-36
34. `try/catch` around the sled and prophunt renderer construction — **S** — F-37
35. Engine per-frame allocation cleanup + `translate3d` for overlays — **S** — F-39
36. `aria-live` on chat log and toasts; focus trap + restoration — **S** — F-42
37. Leaderboards, single-player games only, **after** item 17 — **S** — F-29
38. Login streak rewards — **S** — F-28
39. Rotating weekly featured hat; charge for re-dyeing — **S** — F-27
40. Volume backup automation + tested restore — **S**

### Days 61-90 — make it a game people come back to

41. Consumables and gifting — **M** — F-27. First recurring sink; first coin-mediated social act.
42. Mobile: coarse-pointer detection, forced Low preset, thumbstick, touch emote bar, HUD breakpoints, a touch path for snowballs — **M** — F-41
43. Interest management above ~40 in a room — **M** — F-7
44. A pet (the puffle-equivalent parked at `DESIGN.md:148`) — **M** — F-28
45. De-duplicate: shared room helper lib, minigame shell in the base class, one overlay lifecycle — **M** — F-46
46. Extract the island map out of `hud.js` — **S** — F-47
47. Season one: repeatable stamp sheet, rotating cosmetics, seasonal room re-dress — **L** — F-28
48. Server-side rule validation for chess and connect4, **if and only if** ranked play is on the table — **M** — F-18

---

## 5. The one-page verdict

**If this landed on my desk, here is what I would say to the studio head.**

**Greenlight — this is a real product with real craft in it.** The engineering instincts on display are good ones: a single defended coin road, single-use run tokens, prototype-safe catalog lookups, XSS discipline held across 31 `innerHTML` sites and ten UI files, peer-side move validation that actually contains a lone cheater, minigame teardown that is genuinely leak-free, an audio module with one interval and a documented invariant, a postfx fallback contract, a progression system that structurally cannot be forged, and 232 KB gzipped to a playable 3D world with zero external assets. The docs-as-contracts model produced a codebase that argues with itself in writing and records its own failures — rarer and more valuable than any individual feature here. I would keep this team and this architecture.

**Gate — do not open the doors until the safety and durability work is done.** Two things, and I would not negotiate on either.

*First, moderation.* This game ships free public chat, private cross-room whispers, a freehand drawing canvas broadcast to eight players, and a permanent public mural, to an audience its own design documents describe as "all ages", with **zero** filtering, muting, blocking, reporting, banning or admin tooling, and no age handling whatsoever. That is not a missing feature; it is the absence of the system this entire genre is built on. The clearest single illustration is internal: the mural — slow, permanent, palette-locked, one pixel per twenty seconds — got a full report-and-snapshot pipeline, while the doodle canvas next to it, which is fast, freehand, real-time and aimed at children, got nothing at all. The threat model was applied to the wrong feature. Every game in this lineage spent more engineering effort on moderation than on content, and every one still had an incident. Opening this to the public as it stands is a reputational and legal event waiting for its first bad weekend, and the whisper feature shipped three commits ago is the fuse.

*Second, durability.* The entire user database is one JSON file, rewritten non-atomically, with no backup, no fsync, no atomic rename, and no flush on shutdown — so every deploy silently drops the most recent writes and one badly-timed kill destroys every account permanently, with no restore path. It is currently 2 bytes. That is a day of work to fix and it is the cheapest insurance in this document.

**Rewrite — almost nothing, and that is the good news.** No subsystem needs throwing away. The flat file becomes SQLite behind `db.js`, not a rewrite. The netcode needs a dirty flag and shorter keys, not a new protocol. The single-process architecture is genuinely correct for the next two orders of magnitude of this game's ambitions and should not be touched. The one hard stop I would put in writing: **do not build any ranked, competitive or leaderboard-backed mode on the den duels**, because the server does not model those games at all and cannot distinguish a legitimate result from a fabricated one. And before shipping *any* leaderboard, fix the `best` handler — it currently accepts any number from any client, so a scoreboard launched today would be topped by a console paste within a day.

**The one thing nobody has costed yet:** the economy is exhausted in about four hours of intended play. Every hat, every piece of furniture, everything — 6,510 coins against a design-intent 1,500 per hour, and thirty-three minutes for a script. There is no recurring sink anywhere in the game. Whatever the day-3 churn number turns out to be, the day-14 number is already determined by that arithmetic, and no amount of new content fixes it until something is repeatably *worth buying*. Rotating stock and consumables are a week of work and they are the difference between a game people finish and a game people keep.

**Bottom line: B− codebase, F launch readiness, about one focused month between them.** The hard part — building a world worth moderating — is done. What remains is the unglamorous part, and all of it is tractable.

---

### Appendix: audit method

- Full read of all committed source under `server/`, `shared/`, `src/`, plus `CLAUDE.md`, `CONTRACT.md`, `DESIGN.md`, `README.md` and all three `docs/` specs; `git log` reviewed across all 41 commits.
- The working tree contained uncommitted work at time of audit (`src/ui/firstrun.js`, `src/ui/settings.js`, and modifications to `index.html`, `src/main.js`, `src/ui/hud.js`, `src/ui/menu.js`, `src/core/audio.js`, `src/styles.css`). Findings F-31, F-32 and the boot-screen and first-run-tour credits refer to that in-flight state; `dist/` predates it and its measurements under-report the current tree accordingly. All other line references are to committed code.
- Live measurements taken against the running dev server on `:3001`. Bandwidth figures are from a 12-second guest sample in the plaza. The score-farming and guest-profile figures are from guest sessions only, which `recordFor()` never persists — **no user record was written and no file was modified by this audit**.
- Bundle figures are `gzip -c` over the committed `dist/`. During the audit an untracked `public/` appeared containing a marketing `landing.html` and seven JPGs; Vite copies `public/` verbatim into `dist/`, so those will ship, but they are not loaded by the game and do not affect the critical-path or zero-external-assets figures above. The rooms' own art remains fully procedural.
- The working tree changed again mid-audit (static-camera reframing across nine room files, from a concurrent art-QA pass). Spot-checks confirmed every line reference in this document still resolves, but room-file line numbers in particular should be treated as approximate against a moving tree.
- Economy totals computed directly from `shared/constants.js`.
- Draw-call figures are static call-site counts (including loop multipliers) against the `~120` budget in `CONTRACT.md:28`, not GPU captures.
- **No source file was modified. This document is the only file created.**
