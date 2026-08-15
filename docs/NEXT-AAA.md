# NEXT-AAA: the master plan

**Lead producer's synthesis, 2026-08-14.** Inputs: `docs/research/genre.md`,
`docs/research/gameplay-gaps.md`, `docs/research/level-editor.md`,
`docs/research/accounts-admin.md`, `docs/research/liveops.md`, `docs/AUDIT.md`
(§4 roadmap and §5 verdict), and the open roadmap items in `CLAUDE.md:121-153`
plus the session task list (#12 lobby start-now, #13 admin backdoor, #15-#20).

This document is the **execution plan**, not a sixth research paper. Where the
researchers disagree I pick a side and say why. Where a researcher's idea fails
the scope test in `CLAUDE.md:18-23`, duplicates work, or costs more than it
returns, it is rejected here by name — five good documents produce more ideas
than one person can build, and the value of a plan is what it refuses.

Every claim traces to a research doc, a file, or is marked **[judgment]**.

---

## 1. The thesis

Capy Cove has built the expensive half of this genre and skipped the cheap half:
ten dense 3D rooms, ten multiplayer minigames, houses, a live clock and weather,
48 authored stamps and seeded dailies (`shared/constants.js:5,23,198`), against
**zero** content cadence, **zero** re-engagement surface, and **zero** tools for
one player to find another (genre.md §0; gameplay-gaps.md §2; AUDIT F-28). One
campaign — an admin and moderation spine, an events bus, a rotating shop, a
weekly paper, and the four-day fix for co-presence — converts a beautiful
finished world into a *live service* that visibly changes every time someone logs
in, and does it at under two hours of operator time per week (genre.md §6;
liveops.md §7). The market is real and unusually undefended: Club Penguin
Rewritten and Club Penguin Legacy were both killed by Disney while Club Penguin
Journey passed one million registered accounts in July 2026, so an original-IP
capybara cove is not competing with Club Penguin, it is competing for the
refugees (genre.md §2.1).

**The single biggest risk is not moderation and it is not the economy — those are
known, tasked and tractable. It is that the multiplayer half of the codebase
launches dark.** All nine rendezvous points (3-capy sled race, 2 party lobbies,
5 duel tables) require humans to be standing in one specific room of ten at the
same moment, and the game provides no cross-room population display, no lobby
broadcast beyond the room itself, no friend presence push, and no bot that can
ever fill a seat (gameplay-gaps.md §2, citing `hud.js:260,328,2404-2424`,
`index.js:631,774,964`, `index.js:2394-2434`, `server/bots.js`). At a plausible
launch CCU of 5-20 across ten rooms, the expected number of populated rendezvous
points is approximately zero — which means the majority of the engineering in
waves 1, 4 and 6 is invisible on day one, the game reads as single-player, and
the honest reviews will say "empty". Everything else in this plan is worth less
if that is not fixed first, and the fix is XS-to-S sized (gameplay-gaps.md §8
tier 1). Secondary risk, stated once: the campaign below is large, and the
temptation will be to ship the systems and skip the *publishing habit* they
exist to serve. A calendar nobody edits is worse than no calendar.

---

## 2. The portfolio

Every recommendation from all five documents, deduplicated. Sizes use the audit's
scale: **XS** under a day, **S** ≤ 2 days, **M** ≤ 2 weeks, **L** > 2 weeks.
Verdicts: **NOW** = the launch campaign (§3), **SOON** = season one (§4),
**LATER** = after season one has proved the cadence, **REJECT** = not building it,
with the reason.

Standing rule for the whole portfolio: `server/index.js` and
`shared/constants.js` are contract-level and orchestrator-owned for the duration
(`CLAUDE.md:33-41`). Initiatives below describe the *feature*; the index.js diff
is always a handful of registered lines, never an agent's free hand.

### 2.1 NOW — the launch campaign (34 initiatives)

| # | Initiative | What it is | The loop it serves | Size | Depends on | Verdict note |
|---|---|---|---|---|---|---|
| N-01 | **Durability** | Atomic write (tmp → fsync → rename → fsync dir) for `users.json`/`mural.json`; hourly gzip backups keeping 24h+7d; SIGTERM/SIGINT flush; `uncaughtException` → flush/exit. A *tested* restore written into README. | None. It is the insurance on every other loop. | S | none | AUDIT F-1/F-2/F-3, task #15. accounts-admin.md §6.1 adds the fsync-the-directory step everybody skips. |
| N-02 | **Account identity (`uid`)** | Immutable `u_`+8 random bytes on every record, backfilled at load via `ensureAccount(rec)` following the `ensureFriends` idiom (`db.js:25,53`). Every NEW subsystem references accounts by uid only. Write the `server/store.js` interface now, implement it over the `Map`. | Nothing. It is the precondition for bans, audit, reports, rename and deletion meaning anything. | S | none | accounts-admin.md §1. The audit misses this entirely; it is the finding that constrains the rest. **Do not big-bang re-key the flat file.** |
| N-03 | **Roles + caps** | Ordered enum `rec.role` (`player`\|`mod`\|`admin`), `caps[]` derived from one function, carried on the existing welcome frame via `publicProfile()`. First admin seeded from `COVE_ADMIN` env, idempotent at boot. | Makes "trusted community member" a thing you can hand out without handing over the server. | S | N-02 | Closes AUDIT F-15 / task #13 / the `CLAUDE.md:141-153` deployment blocker. `publicProfile` is only ever "this is you" (accounts-admin.md §2.3), so no role leaks. |
| N-04 | **`server/admin.js` + the `a-*` family** | New module on the proven `progress.js` contract, inserted as ONE line *before* `index.js:2178`. Owns `a-who/inspect/warn/mute/kick/ban/say/tp/summon/coins/role/stealth`, and pre-empts muted players' `chat`/`whisper`/`mural`/`dd-guess`/`ph-msg`. | Operator can act in the moment, where they already clicked the player. | M | N-02, N-03 | The structural win: **mute needs zero edits to the ~60 handlers in the 2,877-line switch** (accounts-admin.md §3.1). Total `index.js` diff for the phase is four edits. |
| N-05 | **Audit log** | Append-only `data/audit/audit-YYYY-MM-DD.jsonl`, actor/op/target/args/before/after, `prev` = SHA-256 of the previous line, daily rotation, gzip after 7d, 90d retention. Plus `econ.grant.large` and `econ.hourly.capped` anomaly events. | Makes handing out `mod` safe, and answers "why does this account have 40,000 coins" in three weeks' time. | S | N-04 | accounts-admin.md §7. The hash chain is ~5 lines and the threat model is a rogue operator with disk access. The anomaly events are the F-11 farming detector the audit says does not exist. |
| N-06 | **Connection metadata** | `wss.on('connection', (ws, req))`, store `HMAC(secret, ip)` truncated — never the address. `app.set('trust proxy', 1)` first. | Alt correlation and kick/ban follow-up without holding PII. | XS | N-01 | accounts-admin.md §3.6: the server currently does not know any player's IP (`index.js:2154`). Every operational use of an IP is a comparison, so the hash serves them all and shortens the F-25 conversation. |
| N-07 | **Token revocation** | Sign `username.tokenV.exp`; bump `tokenV` on password change, recovery, ban, unban, rename, delete, role change, "log out everywhere". TTL 30d → 14d with silent refresh. | Turns "leaked token, nothing we can do for 30 days" into a button. | XS | N-02 | AUDIT F-16. **This invalidates every existing token — do it before there are users, not after** (`auth.js:22` hard-requires 3 parts). |
| N-08 | **Account recovery** | Four-word `CAPY-otter-lantern-cocoa-drift` code from a cove wordlist, scrypt-hashed, shown once behind an "I've written it down" gate. Fallback: admin-issued 30-minute single-use reset token delivered out-of-band, audited on issue and on use. | Stops a lost password from being a permanent churn event. | S | N-03, N-07 | accounts-admin.md §5.1-5.2. **No email infrastructure, ever** — it would import spam, deliverability, PII and COPPA problems to fix a support problem. |
| N-09 | **Chat / whisper / name filter** | Server-side wordlist filter over `chat`, `whisper` and names; maintainable list; forced-rename op for offensive names. | The floor under every social loop. | S | N-04 | AUDIT F-21/F-26, task #17. Names currently pass `^[a-zA-Z0-9_]{3,16}$` and render above the head in every room. |
| N-10 | **Reporting + the report queue** | Report-a-player on the profile card, report-a-drawing in the doodle round with a canvas snapshot; one `data/reports/YYYY-MM-DD.jsonl` store with `open → actioned\|dismissed`; absorb the bespoke `reportMural` writer. | Gives the moderation loop an inbox instead of a folder nobody runs `ls` on. | S | N-04, N-05 | AUDIT F-21/F-23. Record shape agreed in accounts-admin.md §4.3. The doodle canvas is the fast, freehand, unmoderated surface while the slow palette-locked mural got the full pipeline — the threat model was applied to the wrong feature. |
| N-11 | **Per-player mute/block + whisper gating** | Client-side block covering public chat and whispers; whispers gated to mutual friends and retained for review. | Lets a player solve their own problem at 2am without an operator. | S | N-09 | AUDIT F-22, the highest-risk single feature in the game and the newest. |
| N-12 | **Skip-the-drawer vote** | Majority vote in a doodle round to skip the drawer. | Fixes an abuse vector and an AFK-drawer boredom vector with one mechanic. | XS | N-10 | AUDIT F-23. Every game in this lineage ships it. |
| N-13 | **Mural clear + per-account revert** | `a-mural-clear{x,y,w,h}` and `a-mural-revert{uid,sinceMins}`; add `prev` and `byUid` to mural ops; one panel button that reverts **and** bans. | Turns a raid from an SSH session into a click. | S | N-04, N-05 | AUDIT F-24. `mural.ops` is already a 50k-entry log with no consumer (`index.js:1912,2020`); two data fixes make it usable — without `byUid`, revert-after-rename hits the wrong player. |
| N-14 | **Chat retention** | 30-line in-memory ring per connected player, plus `data/chatlog/chat-YYYY-MM-DD.jsonl` retained **7 days**. Reading a player's log is itself an audited op. | Makes the report queue answerable. Most reports arrive seconds after the offence, so the ring alone answers ~90%. | S | N-05 | accounts-admin.md §7.4. Deliberately separate from the 90-day admin log: different write pattern, different retention, and a corrupt user DB must not take the evidence with it. |
| N-15 | **Age gate + privacy + terms** | Neutral age screen at signup; under-13 defaults to restricted chat with whispers off; privacy policy and terms on the title screen; document what is stored and for how long (7-day chat, 90-day audit). | Legal survival. | M | N-14 | AUDIT F-25, task #18. "Play now" is the default tab (`title.js:16-20`) and an anonymous player is in global chat in five seconds. Data minimisation is a genuine asset here; have a lawyer read the pages. |
| N-16 | **Run-token economy anti-cheat** | Per-game `minRunMs` in `MINIGAMES`; bind `mgstart` to the player's current room and refuse a double-arm; rolling **daily** cap at 3-4x honest play; strip `window.__game`/`window.__cards` behind `import.meta.env.DEV`. | Protects every reward moment in the game. | S | none | AUDIT F-11, task #16. Measured live at 12,000 coins/hr with four pasted lines; sled is farmable from the café. |
| N-17 | **Guest profile clamps** | Filter `milestone` items out of guest `ownedHats`; validate `custom.color` against `BODY_COLORS` + unlocked colours; drop the `\|\| !p.registered` escape hatch; schema-validate `loadLocal`. | Protects prestige, which is the only part of the economy that is not exhausted. | S | none | AUDIT F-12. A guest can currently arrive wearing the Royal Crown and equip the 30-stamp Golden Pickaxe. |
| N-18 | **Duel payout guards** | Minimum match duration + minimum move count before a duel pays; cooldown on repeat pairings. Peer-validate pong's score deltas seat-1 side. | Stops the first organised bad actors, who in this genre organise as collusion rings before anything else. | S | none | AUDIT F-13 (accepted at prototype stage, wrong answer at launch) and F-17. |
| N-19 | **Bind `best` to a paid run** | Accept `best` only from a run `score` already paid, in the same handler. | Unblocks every leaderboard and the Courier's top-scores section forever. | S | N-16 | AUDIT F-14. Ship this in the campaign even though leaderboards are SOON: it is two days now and a data-integrity migration later. |
| N-20 | **Baseline tests + CI** | `node --test` over the coin road, caps, guest clamps, progression signals and the new admin gate. GitHub Action: build + test on push. | Lets six waves of agents land without a regression fleet each time. | S | none | AUDIT F-44, task #19. |
| N-21 | **Cross-room population** | One head count per room on the existing 10 Hz tick (or a 2 s `where` frame), painted onto the island-map pills that already exist. | **The single cheapest repair of the largest structural problem in the game.** A player can currently not find the other players. | XS | none | gameplay-gaps.md §8.1, citing `hud.js:2404-2424` which paints names, descriptions and a party hat and no counts. |
| N-22 | **Lobbies that can start** | Arm the sled countdown at **2** with a fill window exactly as the party lobbies already do (`index.js:986-992`); broadcast lobby head counts island-wide; "2/3 at the sled gate — go?" chip that travels. | The oldest and most visible multiplayer mode currently deadlocks at two players forever. | S | N-21 | gameplay-gaps.md §2, `index.js:650-656`. Session task #12 is half of this; the island-wide half is the part that matters. |
| N-23 | **Solo progression signals** | Emit `match-win {vs:'ai'}` and `doodle-correct` from solo runs, at reduced or zero coin value. | Unlocks 9 dead quests and up to 9 dead stamps for the population that will actually be online. | XS | none | gameplay-gaps.md §4: 15 of 48 stamps are unreachable solo, "Legend of the Cove" is **mathematically unreachable** solo, and ~64% of quest boards hand a lone player an impossible task. ~12 lines. |
| N-24 | **Friend presence push** | Push `friendsPayload` on friend connect/disconnect/room-change instead of only answering a request. | Makes the friends list a reason to log in rather than an address book with a stale dot. | XS | N-21 | gameplay-gaps.md §2.3 (`index.js:2394-2434`). |
| N-25 | **Dailies on the real calendar** | Key the quest board (and the bottle, and the bonfire cap) on the wall-clock date the way `touchDate` already does, keeping the 40-minute sky. Raise per-quest counts to suit a full day. | Restores the game's only intended daily ritual. | S | none | gameplay-gaps.md §1: the board rerolls **36 times per real day**; `devoted` ("five days") is a 3.3-hour achievement; the bottle pays 900 coins/day. liveops.md open question 3 concurs. |
| N-26 | **Login streak + daily gift** | A 7-day cycle paying escalating coins plus a cosmetic at day 7, on the `c.days`/`c.lastDate` counter that already exists and is already correct. | The cheapest possible "you came back" moment. | XS | N-25 | gameplay-gaps.md §8.5 (`progress.js:567-570`). |
| N-27 | **The events bus** | `server/events.js` + `data/calendar.json` (hot-reloaded, `America/New_York`), the `events` wire frame sent on hello **and** every room join, nine effect verbs (`coins`, `sky`, `decor`, `flag`, `notice`, `bots`, `shop`, `mural`, `quest`, `goal`), HUD event pill + lead-in toast. | **Build the bus and everything later becomes scheduling instead of engineering.** It is also the permanent fix for co-presence: it tells everyone *when* to be somewhere. | M | N-25 | liveops.md §2. Five wiring lines into index.js, every one copying an existing line. `coins.mult` is an **allowlist** — never `mining`, or the event teaches the AFK-dominant habit the audit already flags. |
| N-28 | **Stats + the weekly report** | ~120-line `server/stats.js` teed off the existing `signal()` wrapper and `grantCoins`, weekly rollup files plus `data/events/<week>.ndjson`; `npm run report` prints the twelve numbers to stdout. | You cannot steer what you cannot see, and the paper cannot exist without it. | S | none | liveops.md §5.3, §6. There are currently **zero** aggregate numbers anywhere; `/api/health` returns `{ok, online, rooms}`. One tap, two systems. |
| N-29 | **The Cove Consignment** | Split the shop into a staples rack and a **rotating stall** driven by `effects.shop`; 6-8 of a larger authored pool visible per fortnight; 2-3 unannounced secret items hidden in the existing 3D turntable diorama; **consumables** (cocoa, snowball crates, party poppers, mural dye); charge 20 coins to re-dye. | The only change that gives coins a permanent purpose. Rotation turns a finite catalog into an unbounded one without authoring unbounded content; secrets turn a shop UI into a conversation. | M | N-27 | genre.md §4.1 + AUDIT F-27 + gameplay-gaps.md §8.6, three documents converging. The visible economy is **75 minutes long** (2,500 coins of hats at ~2,000/hr). Guardrails: rotation never removes an owned item; prices stay on the 50/80/…/800 ladder. |
| N-30 | **The weekly charm hunt** | One small object hidden in one room's scenery, changing weekly, never returning. Click it, it joins a charm board on the profile card and can be worn. Data table of `{week, room, position, charmId}` + one claim per account. | The genre's proven weekly-return trigger *and* its proven world-tour driver: to find it you walk through rooms you had no other reason to enter. | S | N-27 | genre.md §4.4, a near-exact port of the Club Penguin pin. Placing next week's charm is a two-minute operator job because rooms are numbers with a live editor. |
| N-31 | **The Cove Courier** | Weekly paper on the plaza notice board as a **second hotspot** with an unread badge (not a tab in the quest overlay). Three-quarters templated from stats + calendar, one optional editorial field that is simply omitted if empty. Issues immutable once written. | The scheduling layer that makes every other weekly mechanic legible, and the only re-engagement surface that needs no email and no notifications. | M | N-28, N-09, N-19 | genre.md §4.2 + liveops.md §5. **Fix the print day and never move it** — the value is that Sunday means something. Names excluded at *render* time so an admin action retroactively cleans an unprinted issue; mural crop operator-picked from three server-suggested candidates, never automatic. |
| N-32 | **Client perf one-liners** | `if (o.isInstancedMesh) o.dispose()` in `disposeObject`; `applySavedSettings(game)` at boot; make "Low" actually disable bloom. Plus the editor's `engine.camLock` flag. | Free. A returning player on a weak device currently boots at full quality every session. | XS | none | AUDIT F-30/F-31/F-32; level-editor.md B-1/B-2 (every pin drag and every window resize resets the editor camera via `_resolveStaticCam`). |
| N-33 | **Input remap** | Right-click moves, left-click interacts, snowball on T. | Removes the most-reported friction in playtests. | S | none | Session task #20. |
| N-34 | **Operability** | Structured logging, extended `/api/health` (uptime, heap, CCU, tick p95, errors since boot, coins granted last hour), tick-overrun counter. | The live view that pairs with N-28's weekly view. | S | N-28 | AUDIT F-45; liveops.md §6.3. |

### 2.2 SOON — season one (weeks 1-8 post-launch)

| # | Initiative | What it is | The loop it serves | Size | Depends on | Verdict note |
|---|---|---|---|---|---|---|
| S-01 | **The Cove Almanac** | A collection journal: fish species in Reel Rush and The Drift, gems and oddities in the mine, critters and blooms in jungle and beach. Entry, silhouette until found, rarity, and **conditions** — some only at night, some only in rain, some only during a festival. Sits beside the stamp album on the profile card. | Turns a 90-second minigame into a months-long project, and converts the wave-7 clock and weather from set dressing into a **content generator**. | M | N-27 | genre.md §4.6. **The cheapest large win from content that already exists.** Webfishing ships ~100 creatures plus a journal and sits at 97% of ~57k Steam reviews. |
| S-02 | **The companion critter** | One adopted creature (duckling, snail, fat frog, otter, turtle) that follows you between rooms, visible to everyone over the existing `custom` message. Own several, walk one. Digs up small coin bags and consumables while walked. One care verb that is pure upside. | Expectation on return + a socially visible cosmetic slot + idle income that pays you for wandering the world *with other people*. | M | N-29 | genre.md §4.3 + gameplay-gaps.md §8.13 + AUDIT item 44. **Hard-reject care decay, sadness, runaway and the overfeeding penalty**: a cozy game aimed at adults with jobs must never punish a two-week absence. |
| S-03 | **Community goals** | One island-wide bar at a time, counted off the same `signal()` funnel (free anti-cheat), broadcast on the 10s tick at 0.5% boundaries. Goal 1 "The Big Picture" (mural coverage). Goal 2 "The Lantern Fund" (coin drive, per-account daily donation cap). | The only content category where a *low* population still feels like company, because everyone's contribution is on one bar. The Lantern Fund is the first real recurring coin sink. | M | N-27, N-28, N-01 | liveops.md §4. **The reward is a place, not an item** — a permanent plaza prop is a monument to a week the community shared; a coin payout is forgotten by Tuesday. Size targets from measured DAU, never ambition: an uncompleted goal demoralises a small population. |
| S-04 | **Seasonal decor pipeline + first festival** | Rooms publish an `anchors` table (entrance/landmark/lamps/facades/skyRing); `src/world/decor/<layer>.js` registered like rooms; `room.onEvent(active, flags)` plumbed beside `onClock`. Then one festival: 10-14 days, 2-3 rooms re-dressed, a free wearable for showing up, themed consignment stock. | Novelty without new geometry, deadline-bounded cosmetics as permanent wearable receipts, and synchronisation — everyone doing the same thing in the same fortnight. | M | N-27 | liveops.md §3 + genre.md §4.5. **The honest constraint:** `DESIGN.md:10-22` mandates procedural everything, so a reskin *is* code — but the schedule is data and the props live in a file the room's owner never opens. Hard rule: decor adds no colliders and moves no ground. **Rename the collision**: "party" already means a player-hosted gathering, so the seasonal thing is a Festival. |
| S-05 | **Featured Dens** | Four dens featured every fortnight, nominated by players plus operator pick, announced in the Courier, rewarded with a plaque prop obtainable no other way and a **one-click warp from the paper into the den**. | Converts a building tool into a performance. The players author the content; the prize is irrelevant and the visibility is the entire mechanic. | S | N-31, N-09, N-10 | genre.md §4.7. Houses shipped in wave 3 and are socially inert. Nominations and den names are new UGC surfaces — sequence after T&S, not before. |
| S-06 | **Dens worth visiting** | A guestbook, a first-visit reward, and interactive furniture: make 4-6 of the 21 pieces actually do something (the 600-coin Mini Arcade is currently scenery). | Gives the 12,000-coin furniture sink an audience, which is what makes people spend it. | S | S-05 | gameplay-gaps.md §3: **0 of 21 furniture pieces are interactive**, and the den has no guestbook, no visit reward and no den-side activity. |
| S-07 | **Expression breadth** | More cosmetic slots (scarf, glasses, held item, companion) and saved outfit combinations. | For an audience whose primary activity is standing around being looked at, this is the thinnest part of the game — and it makes every other cosmetic reward on this list worth more. | M | N-29 | genre.md §2.1. One hat slot plus a body colour, against Journey's layering-and-saved-outfits headline feature and Ice Penguin's entire pitch. |
| S-08 | **The visitor** | One named capybara with a strong silhouette who arrives by boat at Driftwood Beach on an announced *day* (never an hour), with a rare-stock crate tied to the consignment rotation, a handout item and a stamp. A bot with an authored line set and a schedule. | A stampede generator. The reward is small; the reward requires being in the right room at the right time, and the crowd that produces is the actual product. | S | N-27, N-29 | genre.md §4.8. Announce the day, not the hour: the waiting-around together is the content. |
| S-09 | **Leaderboards, solo games only** | Daily/weekly per-game boards with a friends filter, on the four solo games. | Ten minigames currently have zero scoreboards; a best is visible in exactly one place, your own profile card. | S | N-19 | AUDIT F-29 + gameplay-gaps.md §7. **Never on the den duels** — the server models none of them (F-18). |
| S-10 | **Trophy Loft ladder** | Cosmetic-only scarves ranked on **participation and variety**: N duels across M different den games against K distinct opponents, top tier requiring an opponent you have never played. Names on the Hall of Champions, refreshed weekly, reprinted in the Courier. Weekly-rotating "Den Champion" title on the name tag. | Turns three shallow games into a season-long argument, and the variety requirement makes the ladder a *mixing device* rather than a farming device. | S | N-18, N-31 | genre.md §4.10 + gameplay-gaps.md §8.7. Rides `match-win`, which already requires two-party agreement. **Do not attach coins or back it with `best`** until F-13/F-14/F-18 land. |
| S-11 | **AI difficulty pegs** | Three named strengths off the existing `depth`/`slack` parameters in chess and cards, three payout tiers. | Converts two one-and-done AI opponents into a progression, for one afternoon. | XS | none | gameplay-gaps.md §8.8 (`chess.js:2431` has exactly one difficulty). |
| S-12 | **Party activities + the bonfire ritual** | Three host buttons (confetti cannon, group dance-off, musical statues at the DJ booth); a shared story prompt and a group emote at the bonfire; a toast to everyone at the fire when the aurora starts. | A player who throws a party currently gets thirty minutes of people standing near them. | S | N-27 | gameplay-gaps.md §6. The play toys (snowballs, beach ball, Big Blue) are the zero-friction pattern the rest of the game should copy — not the lobby pattern. |
| S-13 | **Gifting** | Buy a hat or a consumable for a friend, handed over in person, with a hard server-side cap so it cannot launder coins. | First coin-mediated social act; gives the friends list a purpose beyond a green dot. | S | N-29, N-18 | AUDIT F-27 fix 4 + genre.md §4.9 + gameplay-gaps.md §8.9. Gifting with caps yes; a market no (see R-06). |
| S-14 | **Level editor v2, phases 1-3** | Persistence spine (`data/layouts/<room>.json`, `rlo/1` op documents, HTTP GET with ETag, six admin-gated ws frames, `layout-rev` broadcast); the 21-item prop palette off `furniture.js` with a `PropPool`; then undo/redo, multi-select, snapping, align/distribute. | Owner art-directs rooms in-game instead of editing numbers and reloading. Phase 1 alone makes today's handles mode **permanent for everyone**. | M×3 | N-03, N-01 | level-editor.md §8. Free mode stays an inspector and **never becomes persistent** — its identity key is a child-index scene path into rooms that name essentially nothing. |
| S-15 | **The web admin panel** | Self-contained inline HTML at `/admin` (registered *above* the SPA catch-all and added to its lookahead), server-side session Map, CSRF, per-IP limiter, kill switch env. Screens: overview, live players, account search, report queue, economy, audit, server. Every mutating endpoint funnels into the same `performOp()` as the ws frames. | Everything with a *time axis*: the report queue, account search, audit review, economy outliers, and acting on players who are offline. | M | N-04, N-05, N-10, N-28 | **Arbitration:** accounts-admin.md §4 wants it; liveops.md §8 says do not build it before launch. liveops wins for the campaign, accounts-admin wins for season one. The panel is a new session-management problem on hand-rolled auth, so it lands *after* N-07/N-08 have hardened that auth and after the audit log can describe everything it does. Ship with `COVE_ADMIN_PANEL=0` until reviewed. **No SQL console, no record editor, no script box.** |
| S-16 | **Event-routed citizens** | `bots.setEventRoute(roomId, share)` — while set, a share of citizens returns the event room from `schedule()`. | Stops the worst live-ops experience there is: an announced event in an empty room. | XS | N-27 | liveops.md §2.7. Gated on the owner's `COVE_BOTS` decision (§3.6). |
| S-17 | **Backup automation + restore drill** | Scheduled off-box copy of `data/`, and running the restore procedure once for real. | An untested restore is not a backup. | S | N-01 | AUDIT item 40; accounts-admin.md §6.1. |

### 2.3 LATER — after season one proves the cadence

| # | Initiative | What it is | The loop it serves | Size | Depends on | Verdict note |
|---|---|---|---|---|---|---|
| L-01 | **Level editor v2, phases 4-7** | `room.tag(id, obj)` + `xform`/`hide` ops with orphan reporting; collider and hotspot gizmos with the **exact** walkability preview (0.25 grid raster, 8-connected flood fill from spawn, headless `WalkController` route checks between every spawn/hotspot pair); camera bookmarks and `cam:static` authoring; then one prop-extraction tranche per room, forever. | The walk-check is the feature that pays for the spec: it is the bench-pinch detector `DESIGN.md` demands and the current workflow cannot do it at all. | M×3 + L | S-14 | level-editor.md §6.6, §8. Phase 7 is the long tail and never blocks anything. |
| L-02 | **SQLite via `node:sqlite`** | Second implementation behind `server/store.js`; WAL, prepared statements, importer, a week of parallel running with a nightly diff. | Removes the whole-file-rewrite ceiling and makes leaderboard/alt/faucet queries real queries. | M | N-02, Dockerfile → `node:24-alpine` | accounts-admin.md §6.3-6.5, verified on this machine (Node v24.18.0, SQLite 3.53.1, unflagged). **Trigger-gated: >2,000 accounts, or `users.json` >4MB, or `saveSoon` p95 >50ms, or the first feature that needs a query.** Every hour on the database now is an hour not spent on tooling that blocks launch. |
| L-03 | **Friendship that does something** | Shared cocoa at any bench, table or bonfire raises a private level between two capys; levels unlock paired emotes in escalating silliness — synchronised wave, paired dance, piggyback (the wave-7 `ride` flag already supports it), nap-pile. | Makes the friends list a progression system: investment in a *specific person* yields new verbs with that person. | M | S-13 | genre.md §4.9, modelled on Sky's friendship tree. **Keep levels private to the pair** — a public friendship ranking breeds exactly the exclusion dynamics this audience is nostalgic for escaping. |
| L-04 | **Photo booth + postcards** | A framed capy portrait with the current room behind it, sendable to a friend and hangable in a den as furniture. | The *growth* loop rather than the retention loop: Sky is marketed almost entirely by its players' screenshots. | M | N-10, S-06 | `DESIGN.md:152`, genre.md honourable mentions. An image-sharing surface — sequence well after moderation. |
| L-05 | **A performable instrument** | A strummable ukulele others can hear, room-scoped and rate-limited. | A player-driven instrument is a *broadcast*: it turns one player's action into everyone's experience, which is what turns co-presence into a scene. | M | N-09, N-11 | genre.md §2.2 — Webfishing's press coverage is mostly about its guitar, not its fishing. New audio-net surface with a griefing profile; needs T&S mature. |
| L-06 | **Groove Grotto rhythm game** | The parked club minigame on the existing 126bpm clock. | The most under-built room in the cove relative to its narrative importance: it is where parties happen and it has one button. | M | S-12 | `DESIGN.md:151`, gameplay-gaps.md §1. LATER because gameplay-gaps is right that nine rendezvous points is already more than the population can fill — build it once events prove people actually gather in the club. |
| L-07 | **Prop Hunt and Doodles upgrades** | 2-3 arena dressings picked off the seed plus a hider "taunt"; per-word best times for solo doodles. | Raises the two middling party games without adding an eleventh. | S | none | gameplay-gaps.md §5. |
| L-08 | **Tour Guide** | A hat, a short quiz, a special chat colour, and a job. | "Be the one who knows everything" is a strong motivator for returning adults and a free onboarding workforce. | S | S-07 | genre.md honourable mentions. |
| L-09 | **Seasons** | A repeatable 4-6 week cycle: fresh stamp sheet, rotating cosmetics, seasonal re-dress. | The real answer to "the album ends". | L | S-01, S-03, S-04, and metric 5 showing 3+ sessions/week | AUDIT F-28 fix 4. Build **after** the calendar, paper and goals prove the cadence machinery works — a season track's whole job is to *pace* content, and content is what a one-person team does not have. |
| L-10 | **Server-side rules for chess and connect4** | Real models server-side, if and only if ranked play is on the table. | The only thing that makes a *win* ladder honest. | M | S-10 proving demand | AUDIT item 48 / F-18. The scarves ladder (S-10) is deliberately designed so this can be layered on later without re-authoring the fiction. |
| L-11 | **Mobile pass** | Coarse-pointer detection, forced Low preset, thumbstick, touch emote bar, HUD breakpoints, a touch path for snowballs. | Audience reach. | M | N-32 | AUDIT F-41/item 42. |
| L-12 | **Netcode scaling** | Skip unchanged entities, shorten wire keys, interest management above ~40 in a room. | ~4x headroom for a week's work — but only worth spending when there is a crowd to spend it on. | M | measured CCU | AUDIT F-7/items 31, 43. |

### 2.4 REJECT — and why

| # | Idea | Source | Reason |
|---|---|---|---|
| R-01 | **Visible membership tiers** | genre.md §1.10 (rejects it) | The paid/free class divide is the one thing CP alumni remember with active resentment, and the private-server scene is partly a reaction to it. If Capy Cove ever monetises: cosmetic-only, supporters get *different* not *better*, and nothing that makes a non-payer's capybara read as unfinished. |
| R-02 | **Pet care decay, sadness, runaway, overfeeding penalty** | genre.md §1.4 (rejects it) | Punishing absence in a cozy game aimed at adults with jobs converts a pet from a reason to return into a source of guilt. S-02 ships the other three loops. |
| R-03 | **Authored solo missions (PSA/EPF)** | genre.md §1.8 (rejects it) | Expensive to write, single-player, one-and-done, tonally adventure-shaped. Every hour on one is an hour not spent on a system that generates content forever. |
| R-04 | **A weekly errand paying a second currency** | genre.md honourable mentions | Overlaps the charm hunt (N-30) almost exactly. Ship the charm; only revisit if the charm proves the appetite and the coin economy needs a prestige-only track. Two weekly errands is one too many for a two-hour operator week. |
| R-05 | **Armies, ranks, PvP combat** | genre.md §5 | Competitive, hierarchical and conflict-shaped. Fails the scope test on the first clause (`CLAUDE.md:20`). |
| R-06 | **Trading and player-to-player item markets** | genre.md §5 | Transferable items at scale create scam, coercion and account-theft vectors — the worst thing to bolt onto a game whose T&S layer is new. Gifting with hard caps (S-13) yes; a market no. |
| R-07 | **More rooms or more minigames** | gameplay-gaps.md §8, genre.md §1 | Breadth was CP's compensation for thin rooms (one static Flash backdrop each); a Capy Cove room is a lit 3D set. Nine rendezvous points across six rooms is already more than the population can fill. **Deepen the 10, do not build 11 to 63.** |
| R-08 | **An email re-engagement channel** | AUDIT F-28 fix 3 | Rejected outright. It imports spam, deliverability, PII and COPPA problems, lengthens the F-25 compliance path, and the Courier + charm + calendar are the in-world substitute that needs none of it (liveops.md §1.D, accounts-admin.md §5). |
| R-09 | **Battle pass / season track before the cadence exists** | liveops.md §8 | An L-sized system whose job is pacing content a one-person team does not have. See L-09 for the gate. |
| R-10 | **A web admin panel before launch** | accounts-admin.md §4 vs liveops.md §2.8 | Arbitrated: not in the campaign, yes in season one (S-15). Pre-launch the operator gets in-game `a-*` ops plus a hot-reloaded JSON calendar, which is correct at 1am from a phone over SSH. |
| R-11 | **IP bans, shadow-mutes, 2FA in v1** | accounts-admin.md §3.2, §3.5, §4.2 | IP bans punish households and are defeated by a hotspot; shadow-mutes produce players who think they are talking and operators who forget the state exists; half-built 2FA for one operator is worse than none. The hashed-IP correlation gives the signal without the collateral. |
| R-12 | **Big-bang re-key of the flat file to uids** | accounts-admin.md §1 | Not worth the risk. New subsystems use uid; legacy name references get swept on rename; SQLite normalises them for free later. |
| R-13 | **Persisting free-mode editor edits** | level-editor.md §0 | Its identity key is a child-index scene path into rooms where a grep for `.name =` returns two hits, and its finest edits rewrite vertex slices of merged geometry. Persisting it produces a layout file that silently aims at the wrong prop after any builder reorder. |
| R-14 | **3-axis gizmo, free-form colour, scriptable hotspots, multi-user co-editing, editing dens through the layout system, BOT_ZONES as a layout op** | level-editor.md §9, §10.4 | The camera is a fixed 3/4 view and everything stands on the floor; `tint` is a palette index or it does not exist (the mural's palette lock is the precedent); a layout document must never be able to express a function; operational transforms for a two-person team is a year of someone's life; dens have their own trust model; a layout op the *server* reads is a bigger trust surface. |
| R-15 | **Doubling AFK mining, ever** | liveops.md §2.3 | `mining`/`gem!` stay off every `coins` allowlist permanently. Doubling AFK income teaches the exact habit AUDIT §3.5 already flags as the dominant strategy for a disengaged player. |
| R-16 | **Per-contribution goal broadcasts; automatic mural crops in the paper; player-submitted paper content in v1; timezone localisation; any event that mints coins outside `grantCoins`** | liveops.md §8 | Bandwidth for an invisible bar; distributing imagery the report queue has not seen; a fresh abuse surface before F-21 matures; a bug farm for a population that is not yet global; and the one defended coin road stays the only road or the entire economy analysis stops being true. |
| R-17 | **Leaderboards or coins on the den duels** | AUDIT F-18 one-page verdict, gameplay-gaps.md §8 | The server models none of chess, connect4, cards, pong or shuffleboard and cannot distinguish a legitimate result from a fabricated one. S-10's participation ladder is the version that survives the constraint. |
| R-18 | **Anonymity rituals (Sky's unlit-silhouette meeting)** | genre.md §5 | Works because names are hidden. Capy Cove is name-first with an existing profile-card culture; retrofitting concealment breaks more than it creates. |
| R-19 | **Webfishing's tone** | genre.md §2.2 | Take the toys, not the tone. The scope test says wholesome and the T&S posture cannot afford to *invite* edge. |

---

## 3. The campaign

Six waves. Every wave honours the repo's working rules: **opus agents, one file
one owner (`CLAUDE.md:27`), contract-first (freeze the interface before the
parallel work), and visual verification from the actual room camera and spawn
points (`DESIGN.md:154-163`).**

**Two ownership rules that hold across the entire campaign, because six waves of
agents will otherwise collide on the same two files:**

- **`server/index.js` and `shared/constants.js` are orchestrator-owned, always.**
  Agents deliver their index.js requirement as a *contract request* (frame name,
  payload, insertion point, rate limit) and the orchestrator applies it. This is
  not bureaucracy: accounts-admin.md §8 shows the entire admin phase is four
  edits to index.js, and liveops.md §2.3 shows the events bus is five — those
  eleven lines are the integration surface of the whole campaign.
- **`src/net/client.js`, `src/core/*`, `src/player/*` are shared infrastructure
  (`CLAUDE.md:33-35`).** One designated agent per wave holds them, and
  `CONTRACT.md` records any API change. `DESIGN.md:156-158` is explicit that the
  only two integration bugs that ever shipped lived in shared code; put the best
  reviewer there.

Wave numbering continues from the shipped waves 1-8.

### Wave 9 — The Spine (identity, roles, durability, audit)

**5 agents + orchestrator + 1 verifier.** Nothing else in the campaign may land
first: from here on, features write data every player renders, and the tokenV
change must happen before there are users.

| Agent | Owns | Delivers |
|---|---|---|
| 9A | `server/db.js`, **new** `server/store.js` | N-01 atomic write + fsync-dir + hourly gzip backups + restore doc; `ensureAccount(rec)` (uid, role, tokenV, lastSeen, mute, ban); `renameAccount()` as one function; the `store.js` interface implemented over the `Map` (N-02) |
| 9B | `server/auth.js` | `role` in `publicProfile()`; `tokenV` in make/verifyToken + 14d TTL (N-07); ban check in `login()`; recovery-code scrypt helpers (N-08); async scrypt (AUDIT F-5) |
| 9C | **new** `server/admin.js` | `RANK`/`capsFor`/`requireCap`; mute+ban pre-empt; the full `a-*` op set; **one `performOp()`** that the future panel will share (N-03, N-04) |
| 9D | **new** `server/audit.js` | Append-only JSONL, hash chain, rotation, gzip, purge sweep, `readBack(filter, cursor)`; the two econ anomaly events (N-05) |
| 9E | `src/main.js`, `src/core/game.js`, **new** `src/ui/admin.js` | Delete `isAdmin()`; gate Ctrl+E on `caps.includes('editor')`; carry role/caps/muteUntil in state and **never** persist them via `saveLocal`; the in-game mod panel (Ctrl+Shift+A), lazy-imported only when caps is non-empty |
| Orch | `server/index.js`, `shared/constants.js`, `src/net/client.js`, `CLAUDE.md` | `admin.install()`; the one-line `admin.handleMessage` before `:2178`; `(ws, req)` + ipH (N-06); ban check in the hello token path; `mod` in `snapshotFor`; `prev`/`byUid` on mural ops; `ROLES`/`CAPS` constants; `moderated`/`announce`/`a-*` client re-emit; protocol registry entry |

**Sequencing:** 9A before all (uid and the store seam are everyone's
precondition). 9B/9C/9D parallel. 9E after 9C's caps shape is frozen.
**Verify:** boot with `COVE_ADMIN` set and unset; mute a second session and
confirm `chat`, `whisper`, `mural`, `dd-guess` and `ph-msg` all die at the hook
with zero handler edits; kill -9 mid-write and restore from backup; confirm the
audit chain validates.

**Owner must decide before wave 9:**
1. **Hosting account and region** — everything downstream (env secrets, volume
   layout for `data/audit|reports|chatlog|backups`, the `trust proxy` setting)
   depends on Fly vs Render vs a box.
2. **The admin username** for `COVE_ADMIN`, and whether that account is your
   *playing* account or a separate one. **[judgment]** Separate: you will want to
   walk the cove without a shield over your head.
3. **Does `mod` exist at launch?** If you will never hand it out, the role still
   costs nothing to carry, but the panel and caps UI get simpler if you say so now.
4. **Timezone**, confirmed once, for the whole live-ops stack: `America/New_York`
   (matching the shipped real-time clock work).

### Wave 10 — Trust & Safety (the long pole)

**5 agents + orchestrator + 1 verifier.** Task #17 and #18. This is the wave that
decides whether the doors open.

| Agent | Owns | Delivers |
|---|---|---|
| 10A | **new** `server/filter.js` | Wordlist filter over chat/whisper/names, maintainable list, leetspeak folding, forced-rename support (N-09) |
| 10B | **new** `server/reports.js`, **new** `server/chatlog.js` | Report store + queue states, absorbing `reportMural`; the 30-line per-player ring + 7-day JSONL + audited read (N-10, N-14) |
| 10C | `src/ui/profile.js` | Report-a-player and the Moderate section on the player card, beside the existing action row (N-10, and the ergonomic half of N-04) |
| 10D | `src/minigames/games/doodle.js` | Report-a-drawing with canvas snapshot; majority skip-drawer vote (N-10, N-12) |
| 10E | `src/ui/title.js`, **new** `src/ui/legal.js` | Age gate, restricted-chat tier for under-13, privacy policy and terms pages, the recovery-code reveal card with its "I've written it down" gate (N-15, N-08 client half) |
| Orch | `server/index.js`, `src/ui/hud.js` | Filter insertion on `chat`/`whisper`/name paths; whisper gated to mutual friends + retention (N-11); mural clear/revert ops (N-13); block list enforcement; muted-state chat box and the `announce` banner |

**Sequencing:** 10A before the orchestrator's insertion. 10B before 10C/10D
(they write into its store). 10E is independent and can start day one — it is
the longest lead time because a human has to read the policy text.
**Verify:** the audit's own "minimum viable T&S" list (`AUDIT.md:274-280`), item
by item, as a checklist with a named test each.

**Owner must decide before wave 10:**
1. **Can guests chat?** accounts-admin.md §9.1 argues no: nothing durable can be
   attached to a guest — no mute record, no ban, no report target that survives a
   refresh — and `whisper` does not check `p.registered` at all. Making chat an
   account feature converts every moderation problem from unsolvable to solvable
   and gives signup an obvious reason. **[judgment] I recommend yes, restrict
   guests to emotes and the phrase menu.** This is a product decision, not an
   engineering one, and it changes wave 10's scope materially.
2. **Age gate shape**: neutral date-of-birth screen (COPPA-safe, higher friction)
   vs 13+ self-attestation (lower friction, weaker). Have a lawyer read whatever
   you pick.
3. **Whispers: mutual friends only, or everyone?** The audit says mutual friends;
   that is also the version that survives a bad weekend.
4. **The out-of-band support channel** (Discord or otherwise) — N-08's
   admin-issued reset tokens are delivered there and nowhere else.
5. **Invite-list size for launch.** The ship gate is "small enough that a human
   can watch the chat log" (`AUDIT.md:521`).

### Wave 11 — Economy integrity and tests

**4 agents + orchestrator + 1 verifier.** Task #16 and #19. Small, mechanical,
and it unblocks leaderboards and the paper forever.

| Agent | Owns | Delivers |
|---|---|---|
| 11A | `server/index.js` economy region (orchestrator-supervised patch set) | Per-game `minRunMs`; `mgstart` bound to room + no double-arm; rolling daily cap; duel duration/move-count/pair-cooldown guards; `best` bound to a paid run (N-16, N-18, N-19) |
| 11B | `src/core/game.js`, `vite.config.js` | Strip `window.__game`/`window.__cards` behind `import.meta.env.DEV`; schema-validate `loadLocal`; stop `applyProfile` from `Math.max`-ing a guest's claim upward (N-16, N-17) |
| 11C | **new** `test/` | `node --test` over the coin road, caps, guest clamps, progression signals, admin gate, filter (N-20) |
| 11D | **new** `.github/workflows/ci.yml`, `server/log.js` | Build + test on push; structured logging; extended `/api/health` (N-20, N-34) |
| Orch | `shared/constants.js` | `minRunMs` per game; daily cap; the guest-clamp allowlists |

**Owner must decide before wave 11:** the **daily coin cap number** (the audit
suggests 3-4x honest play against ~1,500-2,000/hr, so 6,000-8,000/day), and
**whether solo AI wins pay coins at all** — N-23 needs the *signal*, and the
coins are optional. **[judgment] Pay half.** A zero payout reads as a bug to a
player who just won.

### Wave 12 — Co-presence and the daily ritual

**5 agents + orchestrator + 1 verifier.** This is the wave that decides whether
the game looks alive on day one, and it is the smallest wave in the campaign.

| Agent | Owns | Delivers |
|---|---|---|
| 12A | `src/ui/hud.js` (island map region) | Per-room population on the map pills; lobby chips ("2/3 at the sled gate — go?") that travel; friend-presence badge (N-21, N-22, N-24) |
| 12B | `server/progress.js` | Real-calendar quest day keyed like `touchDate`, raised counts; login streak + daily gift table (N-25, N-26) |
| 12C | `src/minigames/games/sled.js` | Lobby-of-2 race behaviour and the start-now path, client half (N-22) |
| 12D | `src/ui/friends.js` | Presence push consumption, "your friend is in the mine", join-them button (N-24) |
| Orch | `server/index.js` | Population broadcast on the existing tick; sled countdown armed at 2 with a fill window; lobby broadcast widened from `broadcastToRoom` to island-wide; solo `match-win{vs:'ai'}` + `doodle-correct` emission; bottle and bonfire caps moved to the real day |

**Sequencing:** 12B is independent. 12A depends on the orchestrator's population
frame landing first — freeze that frame's shape on day one of the wave.
**Verify:** two browser sessions, one in the plaza and one at the peak gate, and
a stopwatch. The success criterion is *a stranger can find a game in under 60
seconds from anywhere on the island.*

### Wave 13 — The cadence engine

**5 agents + orchestrator + 1 verifier.** The bus, the numbers, the shop and the
weekly hook.

| Agent | Owns | Delivers |
|---|---|---|
| 13A | **new** `server/events.js`, **new** `data/calendar.json` | The bus, hot reload with shadow-parse-and-swap, the nine effect verbs, `frame()` for hello+join parity, `coinMult` allowlist, one-off admin ops gated on wave 9's real admin flag (N-27) |
| 13B | **new** `server/stats.js`, **new** `scripts/report.js` | The tee off `signal()`/`grantCoins`/session open+close; weekly rollups; NDJSON; `npm run report` printing the twelve numbers (N-28) |
| 13C | `src/ui/shop.js` | The consignment stall: rotating rack, secret-item hotspots on the existing 3D turntable, consumables tab, re-dye charge (N-29) |
| 13D | **new** `src/ui/events.js` + `src/ui/hud.js` event-pill region | Event pill next to the room chip, lead-in toast, "starts in 10 min", charm-found celebration (N-27, N-30) |
| 13E | **new** `server/charms.js` + the charm data table | Weekly hidden object, one claim per account, charm board on the profile card (N-30) |
| Orch | `server/index.js`, `shared/constants.js` | `events.install()`, `events.tick()` in the existing clock interval, `sendTo(p, events.frame())` in `joinRoom` **and** hello, `coinMult` inside `grantCoins` after `clampCoinsForGame` and before the hourly backstop; consumable + rotating-stock catalog entries |

**Sequencing:** 13A and 13B are genuinely parallel (liveops.md §7 order 1 and 3).
13C and 13E consume 13A's effect vocabulary — freeze `data/calendar.json`'s
schema on day one and hand it to both.
**Verify:** run a Golden Hour against a test account and confirm the multiplier
rides a *clamped* number, that `mining` is untouched, and that a client joining
20 minutes in gets 40 minutes of countdown, not 60.

**Owner must decide before wave 13:**
1. **`COVE_BOTS` at launch: 0 or a small number?** liveops.md §9.1 is blunt —
   with bots off, events below ~15 CCU will sometimes look abandoned, and the
   only mitigation is *fewer events at fixed hours*. This decision changes the
   launch calendar, not the code.
2. **Your two weekly anchor times.** Everything else is texture. My default:
   Friday 8pm ET (Golden Hour) and Sunday 10am ET (the Courier).
3. **How large is the consignment pool?** 6-8 visible per fortnight out of how
   many authored? Below ~24 items the rotation repeats inside a quarter, which is
   fine (a re-run is a nostalgia event) but should be a choice.
4. **Consumable prices**, on the existing ladder, and whether the pet food slot
   is reserved now for S-02.

### Wave 14 — The Courier and launch polish

**5 agents + orchestrator + 1 verifier.** The capstone plus the free wins.

| Agent | Owns | Delivers |
|---|---|---|
| 14A | **new** `server/paper.js` | Issue generation on the wall clock, sections rendered from the frozen weekly bucket + calendar + `draft.json`, names excluded at render time, immutable once written, `paper-new` broadcast (N-31) |
| 14B | **new** `src/ui/paper.js` | The reading overlay, back-issue dropdown, unread badge, lifecycle copied from `src/ui/quests.js` (N-31) |
| 14C | `src/world/rooms/plaza.js` | Second notice-board hotspot ("Read the Courier") on the existing 2.42×1.5 face, with the folded-paper prompt and gold unread dot (N-31) |
| 14D | `src/core/materials.js`, `src/main.js`, `src/ui/settings.js`, `src/core/engine.js` | `InstancedMesh.dispose()`; `applySavedSettings` at boot; "Low" actually disables bloom; `engine.camLock` (N-32) |
| 14E | `src/player/controller.js` + input map | Right-click moves, left-click interacts, snowball on T (N-33) |
| Orch | `server/index.js` | Print-time check in the clock tick; `paper-new`; the mural-crop candidate suggester |

**Sequencing:** 14A needs wave 13's stats bucket and wave 10's name filter and
wave 11's `best` binding — it is genuinely last. 14D and 14E are independent and
can run any time; they are here because they are small and this is the wave with
slack.
**Cut line:** if the launch date bites, **N-31 is the one item in the campaign I
would move to SOON.** Everything else in NOW is either a blocker, a
co-presence repair, or the machinery the paper reports *on*. The paper without
two weeks of stats to print is a thin first issue anyway.

**Owner must decide before wave 14:**
1. **Print day and time**, then never move it. The value is the fixed point.
2. **How often will you write two sentences?** The editorial field is optional by
   design; the difference between a paper with a voice and one without is large.
   If the honest answer is "some weeks", the template must carry the issue alone
   — which is how it is specified, so answering honestly costs nothing.
3. **Mural crop approval**: three server-suggested candidates and you pick one,
   or no mural section in v1.

### Wave 15 — Deployment

Not an agent wave. `Dockerfile`, `render.yaml` and `fly.toml` are already in the
repo (`CLAUDE.md:138-139`); what is missing is the owner's account, the
persistent volume covering `data/{audit,reports,chatlog,backups}`, the
`COVE_ADMIN`/`COVE_ADMIN_PANEL`/`COVE_BOTS` secrets, `trust proxy`, and one
rehearsed restore. Then the invite list.

### Campaign shape at a glance

```
W9  Spine ─────────┬─> W10 T&S ────────┬─> W13 Cadence engine ─> W14 Courier ─> W15 Deploy
                   │                   │        ▲
                   └─> W11 Economy ────┘        │
                                                │
                       W12 Co-presence ─────────┘
```

W11 and W12 can run concurrently with W10 if agent budget allows; W12 has no
dependency on W9 at all and could start on day one if you want the co-presence
fix live in playtests early. W13 needs W12 (do not announce an event before
players can see each other) and W11 (do not multiply coins before the run token
is honest).

---

## 4. Season one: the eight weeks after launch

The operator calendar **is** the product (genre.md §6). Everything below runs on
the wave-13 machinery; the recurring column is what happens every week regardless
of what ships.

**The recurring week, from day one, ~1h45m of operator time:**

| Beat | When | Effort | Automated? |
|---|---|---|---|
| Charm moves | Mon | 2 min (one table row, schedulable ahead) | fully |
| Den Crawl | Tue 8pm | 0 | fully |
| Aurora Watch | Wed 9:30pm | 0 | fully |
| Snowball Tournament | Thu 8pm | 0 | fully |
| **Golden Hour** | **Fri 8pm** | 0 | fully |
| Whale Day | Sat 2pm | 0 | fully |
| **The Courier prints** | **Sun 10am** | ~20 min editorial | mostly |
| `npm run report`, read the twelve numbers | Sun 10:15am | ~15 min | n/a |
| Consignment rotation | alternate Sun | 0 | fully |
| Featured Dens pick | alternate Sun | ~15 min | partly |

Two anchors (Friday night, Sunday morning) and five smaller beats. Monday is
deliberately empty: a world with something on every night has nothing special on
any night.

**The eight-week ship schedule:**

| Week | Ships | Publishes | The decision it drives |
|---|---|---|---|
| **1** | Nothing. Watch. | First real Courier. Charm #1. | Metric 3 (D1/D7) and metric 9 (social participation rate) establish the baseline everything else is measured against. If metric 9 is low, the world is going single-player and no content fixes that. |
| **2** | S-11 AI difficulty pegs (XS), S-09 leaderboards on the four solo games (S) | Courier #2 prints the first top-of-the-board table — the first time a player's name appears in print. | Metric 8 (minigame funnel): if three of ten games are never played, that is worth knowing *before* anyone builds an eleventh. |
| **3** | S-01 Almanac, part one: fish in Reel Rush and The Drift, gems in the mine | Courier #3 announces the Almanac and prints the first rarity found. | Two weeks of DAU now exist → **size community goal 1 from measured numbers, not ambition.** |
| **4** | S-03 goal 1, "The Big Picture" (mural coverage) | Goal bar goes up in the plaza and in every Courier until it completes. Featured Dens nominations open. | Metric 5 (sessions per returning player per week). A community goal is the sharpest instrument for moving it; if it does not, events are texture and the anchors are doing all the work. |
| **5** | S-04 decor pipeline + anchors on plaza/peak/beach + **Festival #1** (10-14 days, free wearable) | The calendar is published a week ahead in Courier #4. First Featured Dens named. | Metric 12 (event lift): festival days vs baseline. This is the only number that says whether the calendar is worth its maintenance. **Kill any event that shows no lift after four runs.** |
| **6** | S-08 the visitor arrives with a rare-stock crate mid-festival; S-16 event-routed citizens | Arrival day (never the hour) announced in the paper. | Peak concurrency by hour (metric 6) — the visitor is the single densest crowd the world will have seen; the number it produces is your real ceiling. |
| **7** | S-02 the companion critter; S-07 first extra cosmetic slots | Courier runs a "name your companion" column. | Metric 11 (sink volume) against metric 10 (faucet by reason). The companion plus consumables is the first time coins have had a *recurring* purpose; if the sink line does not move, the consignment pool is too small. |
| **8** | S-03 goal 2, "The Lantern Fund" (the real coin sink); S-05/S-06 Featured Dens rewards, guestbook, first interactive furniture | Season review issue: the numbers, the monument, what is next. | **The season-one gate.** If metric 5 is at 3+ sessions/week and metric 2 (DAU/WAU) is above ~0.35, L-09 Seasons has something to pace and should be started. If not, the answer is more cadence and better anchors, not a season track. |

**Internal deliverables in the same eight weeks, not player-facing:** S-14 level
editor phases 1-3 (one phase per fortnight, entirely parallel to the above since
it touches no shipped gameplay), S-15 the web admin panel once the report queue
has real volume, S-17 the restore drill in week 1 while nothing is at stake.

**The three things most likely to go wrong, and the mitigation written down now:**

1. **A community goal that does not complete.** A public failure demoralises a
   small population far more than it motivates. Size from last week's real
   numbers; let a goal run until it completes rather than expiring; have the
   Courier report progress weekly so a slow goal reads as an ongoing story.
2. **The editorial slot stops in week five**, because the person writing it is
   also the person fixing the server. The template must carry the issue alone —
   it is specified that way, so the failure mode is a duller paper, not no paper.
3. **The calendar becomes a to-do list rather than a habit.** Schedule the whole
   quarter's charms and rotations in one sitting so the weekly cost is the paper
   and nothing else. Two hours a week is the budget; anything above it will be
   the first thing dropped, and dropping it undoes the entire campaign.
