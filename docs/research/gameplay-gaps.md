# Capy Cove: gameplay gap analysis

**Analyst role:** gameplay gap analyst (loops, content depth, missing modes).
**Date:** 2026-08-14.
**Evidence base:** the codebase, read end to end for the systems below.
`shared/constants.js`, all of `server/` (index, progress, bots, db, auth), the
eleven files in `src/minigames/games/`, the ten room files, `src/ui/*`,
`docs/AUDIT.md`, `docs/LIVING-COVE.md`, `docs/PARTY-GAMES.md`, `DESIGN.md`,
`CLAUDE.md`.
**Live game:** the dev servers were **not running** at analysis time
(`127.0.0.1:3001` and `:5199` both refuse connections) and `CLAUDE.md:110-112`
forbids starting them unasked, so nothing here rests on a live session. Every
claim below is traceable to a file and line. Where I am giving an opinion
rather than reporting code, it says **JUDGEMENT**.

Not re-litigated: security, trust and safety, durability, netcode, performance.
`docs/AUDIT.md` covers those and they are already tasked. Two of its numbers I
correct below (the size of the economy, section 3) and one of its conclusions I
sharpen (the retention problem is not the shop, section 2).

---

## 0. The one-paragraph verdict

Capy Cove has built a great deal of *content* and almost no *cadence*. Every
system in it is a one-shot: the shop empties in about seventy-five minutes of
play, the quest board calls itself "daily" but rerolls every forty minutes, the
stamp album ends, and nothing in the game is ever scheduled, seasonal, ranked or
shared. Worse, the half of the game that is genuinely excellent (five live
multiplayer modes, five duel tables, a race, two party games) is gated behind a
**co-presence requirement that the game gives players no tools to satisfy**:
you must be standing in the correct one of ten rooms, at the same moment as a
stranger, with no way to see where anybody is, no cross-room queue, no ping, and
no bot that can ever fill a seat. At the launch population this project will
actually have, the multiplayer game is unreachable and the solo game is
finished in a weekend. Fixing the cadence is a week. Fixing the co-presence
problem is about four days and is the single highest-leverage change available
in the whole codebase.

---

## 1. The loops as they actually are

### Minute 0 to 1: arrival

Title screen defaults to the **Play now** guest tab (`src/ui/title.js:16-20`),
so two clicks and a name put a player in Sunny Plaza. A guest starts on
whatever `hello` declared, which for a new browser is **0 coins**
(`server/index.js:2196-2199`); a registered account gets a 100-coin signup gift
(`server/auth.js:65`). The inlined boot screen and arrival swoop land, then
`src/ui/firstrun.js` opens a five-beat tour that advances on player *action*,
never on a timer, and never eats a click (`firstrun.js:6-20`).

This part is good and I would not touch it. The onboarding is better than the
genre norm.

### Minute 1 to 15: the whole first-session arc, compressed

The tour points at walking, travelling, the map, a minigame and the wardrobe.
The plaza carries three hotspots and nothing else: Quest Board
(`plaza.js:1118`), Cove Mural (`plaza.js:1214`), Wardrobe & Hat Shop
(`plaza.js:1419`), plus the room gates.

First minigame run pays real money immediately. Reel Rush is a 90-second run
(`fishing.js:18`) paying `score * 0.8` capped at 120
(`fishing.js:683`, `shared/constants.js:24`), so a mediocre first run buys the
50-coin Cozy Beanie and a good one buys the 80-coin Snapback too. The
"cheapest real hat in 1-2 runs" promise in `DESIGN.md:105-107` is honoured
exactly. This is the strongest ten minutes in the product.

The quest board fires here too: three quests plus a +50 all-three bonus
(`server/progress.js:63-64`), pushed unprompted on the first frame
(`progress.js:752-768`).

### Minute 15 to 60: breadth, then the wall

A player who tours the island finds ten rooms, but the *interaction* surface is
thinner than the room count suggests. Complete list of everything a player can
do that is not walking, chatting or emoting, taken from the hotspot tables:

| Room | Activities |
|---|---|
| Sunny Plaza | quest board, mural, shop. **No game.** |
| Driftwood Beach | Reel Rush, bonfire (night only), beach ball, dive bell |
| Frosty Peak | Summit Sprint (solo or 3-capy race), snowballs, cocoa, aurora |
| The Smoothie Shack | Smoothie Scramble. Nothing else. |
| Groove Grotto | "Request a track" (`club.js:267-272`) and dancing. **No game, no shared mechanic, and this is one of the two party venues.** |
| The Game Den | pong / shuffle / connect4, vs a bot or a seated human |
| The Trophy Loft | chess / Capy Clash, vs a bot or a seated human |
| The Glimmer Mine | AFK prospecting, Prop Hunt (party or "Seek alone") |
| The Tangle Jungle | Capy Doodles (party or "Guess the bot's doodles"), waterfall |
| The Drift | swimming, Big Blue, daily bottle. **No game, by design.** |

Three of ten rooms have no game at all, and one of those three is a party
venue. **JUDGEMENT:** the Groove Grotto is the most under-built room in the
cove relative to its narrative importance. It is where parties happen and it
has one button.

Coin rates, computed from the constants:

| Faucet | Rate | Source |
|---|---|---|
| Active minigame play | ~1,800-2,500/hr | per-game `coinsForScore` + run lengths |
| Quest board | **272/hr** | 3 quests (mean 43.1 coins across the 29-quest pool) + 50 bonus, per 40-min cove day |
| Mine, AFK | 295/hr | `index.js:50-53` (2 coins/30s, 2% gem at 25) |
| Bottle | 37.5/hr | 25 coins per cove day, `index.js:158` |
| Bonfire | 22.5/hr | 15 per cove night, `index.js:138` |
| Duel/race win bonus | 30 per match, unbounded rate | `index.js:36,46` |

Fastest honest grind is Paddle Panic against Blip: a 5-0 win pays
`WIN_BASE 40 + WIN_STEP 4 x 5 = 60`, which *is* the game's cap
(`pong.js:65-67`, `shared/constants.js:27`), in about two minutes.
Grand Capy Chess pays 85 for a win against a depth-3 alpha-beta bot
(`chess.js:640,2431`, `chess.js:1485-1489`).

### Day 2: there is no day 2 hook

This is the finding I care most about.

**"Daily" quests are not daily. They reroll every forty minutes.**
`server/progress.js:61` sets `COVE_DAY_MS = 40 * 60 * 1000`, matching
`server/index.js:84`, and the board is keyed on `Math.floor(Date.now()/dayMs)`
(`progress.js:139-141`). `ensureBoard` reseeds whenever that index changes
(`progress.js:296-302`) and `tick` pushes fresh dailies unprompted on rollover
(`progress.js:810-814`). A player sees **36 quest boards per real day**.

The consequences compound:

- The board cannot be a return-tomorrow hook, because it was already replaced
  35 times while you were asleep. The one mechanic in the game explicitly built
  to "give players a reason to return tomorrow" (`LIVING-COVE.md:155-157`)
  cannot do that.
- The `devoted` stamp, "finish all three dailies on **five days**"
  (`shared/constants.js:252`), counts `questDays`, which increments per cove day
  (`progress.js:699-702`). It is a **3.3-hour** achievement wearing a five-day
  costume.
- The daily bottle (`index.js:2089` keyed on the same day index) spawns 36 times
  a real day, at 25 coins each: 900 coins/day from a "one hidden delight"
  feature (`LIVING-COVE.md:148-151`).
- The bonfire cap resets 36 times a day (`index.js:1704`).

The module knows and says so: `progress.js:58-60` flags the deviation and
argues it is safe because 345 coins/hour is under the backstop. That is the
correct *economic* answer and the wrong *retention* answer. The cost is not
inflation, it is that the game has thrown away its only daily ritual.

The **only** real-calendar mechanic in the entire codebase is `touchDate`
(`progress.js:567-570`), which uses `new Date().toISOString().slice(0,10)` and
feeds exactly two stamps: `regular` (7 days) and `veteran` (30 days). No login
streak, no daily gift, no returning-player moment, no notification of any kind.

### Week 2: the album ends and nothing replaces it

48 stamps (`shared/constants.js:198-255`), 5 milestones capped at 40 stamps
(`shared/constants.js:266-272`). Once filled, the progression layer stops dead,
and per section 3 the economy stopped days earlier. There is no season, no
repeatable sheet, no ladder, no rotating anything. `AUDIT.md` F-28 says this;
I am adding the arithmetic in section 4 that says a *solo* player cannot even
finish the album, so for most of the population week 2 ends in a wall they
cannot climb rather than one they have climbed.

---

## 2. The co-presence tax: the structural gap

This is the biggest gameplay problem in the project and it is not in the audit.

Every one of the game's multiplayer modes requires N humans to be **in one
specific room at one specific moment**, and the game provides no mechanism for
that to happen other than luck.

| Mode | Needs | Where | Server |
|---|---|---|---|
| Sled race | **3** at the peak gate | `peak` only | `index.js:32,646-657` |
| Prop Hunt party | 2-6 in the mine | `mine` only | `index.js:945-948` |
| Capy Doodles party | 2-8 in the jungle | `jungle` only | `index.js:949-952` |
| Paddle Panic duel | 2 at that table | `lounge` | `index.js:755-757` |
| Shuffle duel | 2 at that table | `lounge` | same |
| Four in a Row duel | 2 at that table | `lounge` | same |
| Chess duel | 2 at that table | `loft` | same |
| Capy Clash duel | 2 at that table | `loft` | same |
| Party (the event) | host + walk-ins | `club` or a den | `index.js:1798-1859` |

That is **nine separate rendezvous points across six rooms**. Against that, the
discovery tools the game gives a player are:

1. **Nothing.** There is no cross-room population display anywhere. The HUD
   shows only the current room's head count (`hud.js:260,328`, fed by
   `client.js:171` off the room's own state frame). The island map paints room
   names and descriptions and a party hat, and no counts at all
   (`hud.js:2404-2424`). A player in the plaza has no way to learn that two
   capys are waiting at the sled gate.
2. **Lobby state is broadcast to the room only.** `broadcastLobby` is
   `broadcastToRoom(SLED_ROOM, ...)` (`index.js:631-633`); `broadcastParty` is
   `broadcastToRoom(lob.room, ...)` (`index.js:964-966`); `broadcastTable`
   likewise (`index.js:774-778`). A filling lobby is invisible one room away.
3. **Friends give no presence signal.** `friendsPayload` is only ever sent in
   reply to a `{t:'friends'}` request or a friend-add
   (`index.js:2394,2408,2415,2431,2434`). Nothing pushes when a friend comes
   online, changes room, or throws a party. The friends button badge only
   updates when the client asks (`src/ui/friends.js:206-213`). There is no
   "your friend is in the mine" and no way to be told anything.
4. **Bots cannot fill a seat.** `BotManager` entities live in their own map and
   never enter `world.players` (`server/bots.js`, and `joinLobby`/`joinTable`
   resolve ids through `world.players` at `index.js:625,662,842`). They wander,
   chat and dance, and `bots.js:31` has them say *"hunters on the board, who is
   in?"* and *"best of three at pong??"*, which is a promise the code cannot
   keep. The stated launch plan is `COVE_BOTS=0` (`AUDIT.md` F-9), so at launch
   even the illusion of company is off.

**A concrete bug-shaped consequence.** The sled countdown only arms when the
board reaches three:

```js
// server/index.js:650-656
if (sledLobby.length >= SLED_LOBBY_MAX) {   // SLED_LOBBY_MAX = 3
  broadcastLobby(true);
  lobbyStartTimer = setTimeout(startRace, RACE_COUNTDOWN_MS);
} else {
  broadcastLobby(false);
}
```

Two players who sign the board wait **forever**. `startRace` will happily run a
2-capy race (`index.js:664`), but nothing ever calls it. The party lobbies got
this right with a 20-second fill window (`index.js:986-992`); the sled, which is
the oldest and most visible multiplayer mode, did not. Task #12 in the session
list ("Lobby Start now buttons") is aimed at this and should be treated as a
launch item, not a polish item.

**Why this dominates everything else:** at a plausible launch CCU of 5-20 spread
across ten rooms plus dens, the expected number of populated rendezvous points
is approximately zero. Every multiplayer investment in waves 1, 4 and 6, which
is the majority of the engineering in this repo, is dark. The rooms that get
played will be beach, peak, cafe and mine, because those are the four with solo
loops.

---

## 3. Where the content runs out (corrected arithmetic)

`AUDIT.md` §3.5 says 6,510 coins buys everything and gives 4.3 hours. Two
corrections, one in each direction.

**Furniture stacks.** `src/ui/shop.js:14` and the server's inventory counter
(`index.js:2510-2547`, `ensureOwnedFurniture`) mean every copy is a separate
purchase, and a den holds 60 items (`shared/constants.js:112`). The furniture
sink is therefore not 4,010 but "60 slots at whatever you choose": 2,400 for 60
flower pots, ~12,000 for a nicely furnished den, 36,000 if you bought 60 Mini
Arcades. The audit understates the sink.

**Hats are the only sink that matters.** Nine buyable hats, ladder
50/80/120/150/250/300/350/400/800 = **2,500 coins total**
(`shared/constants.js:40-57`). At ~2,000 coins/hour of honest play that is
**about seventy-five minutes** to own every socially visible cosmetic in the
game. Body colour is free and unlimited: `p.color = Number(m.color) || p.color`
with no price and no validation (`index.js:2311`).

So the real shape of the wall is worse than the audit's, not better:

| Layer | Total cost | Time at 2,000/hr | Who can see it |
|---|---|---|---|
| Hats (the flex) | 2,500 | **75 min** | everyone, every room |
| A furnished den | ~12,000 | ~6 hr | you, and anyone who walks in |
| Colours | 0 | 0 | everyone |

**JUDGEMENT:** the visible economy is 75 minutes long. Everything after that is
decorating a room with no reason to be visited, using furniture that does
nothing: `src/world/furniture.js` has builders and footprints only, no `action`,
no hotspot, no `update` behaviour worth the name. The Mini Arcade costs 600
coins and is scenery.

And the den has no reason to receive guests. There is no guestbook, no rating,
no visit reward, no den-side activity, no leaderboard of dens, nothing to do in
someone's house except stand in it. `HOUSE_ACCESS_MODES` and the invite system
(`index.js:2470-2497`) are a well-built door onto an empty room.

---

## 4. The progression spine locks solo players out

The stamp album is the best-designed system in the game and it has a
distribution bug that nobody has costed.

**Signals that only ever fire in multiplayer.** Every `signal()` call site is at
`index.js:358,722,905,932,1344,1527,1604,1713,1785,1887,2029,2133,2274,2285,2307,2329`.
Three of them are structurally gated:

- `match-win` (`:905`) fires only from `endMatch`, which only exists via
  `startMatch(table)`, which requires two seated humans (`index.js:841-846`).
  **Beating the AI never emits it.** A solo win goes down the `score` road
  instead (`game.js:99,108-115`).
- `race-done` (`:722`) requires the 3-capy lobby.
- `doodle-correct` (`:1344`) fires only from the server's multiplayer
  `scoreDoodleGuess`. The solo mode "Guess the bot's doodles"
  (`doodle.js:1593-1810`) is entirely client-side and emits nothing.

**Result, counted against `shared/constants.js`:**

*Stamps unreachable without other humans (15 of 48, 31%):*
`duelist`, `sweep`, `grandmaster`, `card_shark`, `paddle_pro`, `four_up`,
`shuffler`, `den_regular` (8, all den duels); `racer`, `photo_finish`,
`hat_trick` (3, races); `doodler` (1); `pod` (1, four riders on Big Blue);
`host_most`, `party_animal` (2, parties).

A solo player therefore caps at **33 of 48 stamps**. The milestone track is
5/12/20/30/40 (`shared/constants.js:266-272`), so:

- **"Legend of the Cove" (40 stamps) is mathematically unreachable solo.**
- The 30-stamp Golden Pickaxe survives on three stamps of slack, which
  evaporates if the player skips any of `cove_painter` (250 mural pixels at one
  per 20 s = 83 minutes of clicking), `chatterbox` (100 chats), `veteran` (30
  real days) or `night_owl` (aurora is 15% of nights, and you must be standing
  on the peak: `index.js:1471-1481`, `progress.js:809`).

*Quests unreachable without other humans (11 of 29):* `q_match`, `q_pong`,
`q_chess`, `q_cards`, `q_connect4`, `q_shuffle`, `q_race`, `q_race_win`,
`q_doodle`, `q_party_go`, `q_pod`.

This one is sharper than it looks, because the draw **guarantees** one minigame
quest (`progress.js:199-202`) and only **5 of the 14** minigame quests are
solo-completable (`q_fish`, `q_sled`, `q_smoothie`, `q_three_runs`, `q_hunt`).
So on roughly **64% of boards a solo player cannot clear the minigame slot**,
and therefore can never collect the +50 all-three bonus or advance `clean_sweep`
and `devoted`. The board will regularly hand a lone player a task the empty
world makes impossible, with no reroll and no substitute.

**Smallest fix with the largest effect:** emit `match-win` (with a
`{vs:'ai'}` marker) and `doodle-correct` from solo runs, at reduced or zero
coin value if that worries the economy. Roughly a dozen lines across
`server/index.js` and `src/core/game.js`. It converts 9 dead quests and up to 9
dead stamps into live ones for the population that will actually be online.

---

## 5. The ten minigames, ranked

Criteria: mechanical depth, run-to-run variance (replayability), and quality as
a *multiplayer* experience. "MP" describes what happens when two humans meet.

### Strong (leave alone)

**Summit Sprint** (`sled.js`, 2,217 lines). Endless downhill, seeded track
(`sled.js:16-27`) so all three riders ride byte-identical terrain, difficulty
ramps on *track distance* not wall-clock (`DIFF_RAMP = 2400`), boosts, ramps,
gaps, ghost rivals placed by distance delta, shared leaderboard. This is the
best multiplayer minigame in the cove and the only one where the multiplayer
version is meaningfully better than the solo one. Its only problem is that it
needs three people (section 2).

**Reel Rush** (`fishing.js`). 90 s, 3 hearts, i-frames, hit stun, a combo
system (`COMBO_NEEDED 5 / COMBO_TIME 10`), four fish tiers with a 10-point
golden rare, three hazard types with distinct fail flavour, an escalating
spawn table and a periodic shark sweep. Textbook arcade design; the highest
skill ceiling of the solo three. Solo only, and that is fine.

**Smoothie Scramble** (`smoothie.js`). Order matching, seven ingredients on
number keys, patience-bar customers, three storm-offs. Solid and legible.

**Capy Clash** (`cards.js`, 5,830 lines, `docs/CARDGAME.md`). By far the
deepest thing in the project and the only game with real long-tail strategy.
Payout scales with remaining HP (`70 + myHp/2`, `cards.js:3902-3915`).

### Middling (cheap upgrades available)

**Prop Hunt** (`prophunt.js`). Genuinely good party design: possession, prop
nudging, seeker rotation, survival ticks, a clean-sweep double. Two rounds,
2-6 players, and a solo mode against 5 AI hiders (`prophunt.js:93,855`).
Weakness: the solo mode is a strictly worse version of the party mode and does
not feed `match-win`; the arena is one chamber; there is no map or prop-set
variety across rounds. **Raise it:** two or three arena dressings picked off
the seed, and a "taunt" button for hiders (a sound cue that reveals a rough
direction) to give the seek phase pressure.

**Capy Doodles** (`doodle.js`). Server-refereed word list, masked answers,
private near-miss pings, five rounds, 2-8 players. The audit calls it the
model the other games should follow and that is right for its *server* design.
As a *game* it is stock skribbl. **Raise it:** the solo mode currently replays
canned bot drawings and awards nothing to progression; wire it to
`doodle-correct` and give it a per-word best time so it becomes a real practice
loop.

**Grand Capy Chess** (`chess.js`). Real engine: alpha-beta, quiescence,
`perft` for verification, threefold and dead positions (`chess.js:316,540-660`).
The problem is presentation of *choice*: there is exactly one AI, at one
strength (`depth: 3, slack`, `chess.js:2431`), with one name. **Raise it:**
three difficulty pegs off the existing `depth`/`slack` parameters (Pebble the
Cub / Pebble / Grandmaster Pebble), paying 40/85/130. One afternoon, and it
converts a one-and-done into a ladder.

### Weak (the den's small three)

**Paddle Panic** (`pong.js`), **Shuffle Showdown** (`shuffle.js`), **Four in a
Row** (`connect4.js`). All three are competent, juicy implementations of games
with essentially zero depth curve, and all three carry the lowest caps in the
table (60/70/60, `shared/constants.js:27-32`). Pong is additionally the one
game with a real anti-cheat hole (`AUDIT.md` F-17) and its AI has a single
fixed skill. Connect 4 against a bot is solved by any adult in three matches.

**JUDGEMENT:** these three do not need more depth, they need a *reason to
replay*, and the reason should be social rather than mechanical. Concretely:
give the den a **house ladder**, a per-game W/L record and a "Den Champion"
title that rotates weekly and shows on the name tag. That is the same
engineering as one stamp and it makes three shallow games into a season-long
argument. Explicit constraint from the audit that I agree with: do **not** back
a ranked ladder with coins or with `best` until F-14 and F-18 are fixed, since
the server models none of these games. A cosmetic-only, per-account,
server-counted W/L record is safe today because `match-win` already requires
two-party agreement (`index.js:876-889`).

### Not games, and correctly so

**The Drift.** No minigame by design (`LIVING-COVE.md:148`). Pure wonder plus a
daily bottle. Big Blue seats six and the `pod` stamp wants four riders at once,
which is the best group moment in the game and, per section 2, one almost
nobody will ever assemble.

---

## 6. Social systems that exist but are underpowered

Ranked by how much is already built versus how little it does.

**Parties are a flag, not an event.** `startPartyEvent` (`index.js:1798-1859`)
sets a 30-minute window, toasts the island, adds a map hat, forces a den open,
and counts heads. That is all it does. There is no activity, no host controls,
no music change, no confetti trigger, no group emote, no party-only game, no
scoreboard, no reward beyond a head count. Attendance grants "doubled emote
juice, visual only" per spec (`LIVING-COVE.md:39-42`). The most likely venue,
the Groove Grotto, has one interactive object in the entire room
(`club.js:267`). **A player who throws a party gets thirty minutes of people
standing near them.**

**The bonfire pays but has no ritual.** `bonfireTick` (`index.js:1695-1716`)
validates position and pose off frames the player already broadcasts, which is
lovely engineering, and pays 1 coin/minute capped at 15. There is nothing to
*do* at the fire: no shared story prompt, no marshmallow, no group emote, no
"everyone at the fire gets a toast when the aurora starts". The bots have
fireside lines (`bots.js:37-41`) and players have none.

**Whispers exist and presence does not.** Whisper delivers anywhere in the
world (`index.js:2269-2283`) but there is no way to know anyone is there to
whisper to. See section 2, point 3. The friends system is a list, a green dot
that only refreshes when you open the overlay, and a door button.

**The mural is the one genuinely successful social system** and is exactly
right: slow, permanent, palette-locked, one pixel per 20 s, RLE-shipped,
persisted. Leave it alone; it is the community's self-portrait and it is
working. (Its moderation gap is F-24 and already tasked.)

**The play toys are right too.** Snowballs, the beach ball and the whale need
no lobby, no menu and no score, which makes them the only multiplayer content
in the cove with a zero-friction entry. That is the pattern the rest of the
game should copy, not the lobby pattern.

---

## 7. Modes missing entirely

Nothing in the following categories exists. I grepped for the vocabulary across
`src/`, `server/` and `shared/`: `tournament`, `double-coin`, `featured`,
`co-op` return **zero** hits; `leaderboard` appears only inside `sled.js` (the
post-race standings); the only `season` hit is a quest *name* ("Snowball
Season", `shared/constants.js:177`); the only `gift` hits are the 100-coin
signup bonus (`auth.js:65`) and a line of party copy (`hud.js:2444`).

**No event calendar / no scheduled world events.** The world clock produces
weather, aurora and day phase (`index.js:1455-1498`) and that is the entire set
of things that ever happens on a schedule. There is no server-driven calendar,
no double-coin hour, no announced aurora party, no timed tournament, no
seasonal re-dress (parked at `DESIGN.md:150`), no "the shop restocks Friday".
Every appointment in the game is player-initiated and capped at one party per
90 minutes per account.

**No competitive ladder of any kind.** Per-game `best` is persisted server-side
(`index.js:2313-2321`) and is visible in exactly one place: your own profile
card, as a medal tier (`src/ui/profile.js:32-48`). No room board, no daily high
score, no friends comparison, no den champion, no race record. Ten minigames,
zero scoreboards.

**No co-op goals.** Nothing in the game is ever accomplished *together*. The
mural is collaborative but has no target, no milestone, no completion, no
reveal. There is no island-wide quest, no community coin pool, no "the cove
lands 10,000 snowballs and the lighthouse turns on", no shared unlock.

**No re-engagement channel and no daily ritual.** No email (which is a
deliberate and correct privacy choice, `AUDIT.md` F-25), and therefore no
notification, but also no login streak, no daily gift, no calendar-day quest,
and no persistent "you were away, here is what happened" moment. The only
calendar-day mechanics in the codebase are the `regular` and `veteran` stamps.

**No pet.** Parked at `DESIGN.md:148-149`. In every game in this lineage the
puffle-equivalent is a top-three retention driver.

---

## 8. Ranked backlog: retention leverage per engineering cost

Sizes: **XS** under a day, **S** 1-3 days, **M** about a week, **L** longer.
Ranked by leverage divided by cost, not by leverage alone.

### Tier 1: do these before anything else in this document

1. **Broadcast per-room population and paint it on the island map.** (**XS**)
   One number per room in the existing 10 Hz tick, or a 2 s `where` frame; the
   map pills already exist (`hud.js:2404-2424`) and have room for a count.
   This is the cheapest change in this document and it repairs the single
   largest structural problem: right now a player cannot find the other
   players. Everything multiplayer in the game gets better the moment this
   ships.

2. **Fix the sled lobby and surface lobby state island-wide.** (**S**)
   Arm the countdown at 2 with a fill window, exactly as the party lobbies
   already do (`index.js:986-992`), and broadcast lobby head counts to *all*
   rooms so the HUD can show "2/3 at the sled gate: go?" with a click that
   travels. Session task #12 is half of this; the island-wide half is the part
   that matters.

3. **Emit `match-win` and `doodle-correct` from solo runs.** (**XS**)
   ~12 lines. Unlocks 9 dead quests and up to 9 dead stamps for solo players
   (section 4) and stops the quest board handing lone players impossible tasks.
   Pay reduced coins for AI wins if the economy worries you; the progression
   signal is the valuable half, not the coins.

4. **Make "daily" mean a calendar day.** (**S**)
   Decouple the quest-board day index from `COVE_DAY_MS`
   (`progress.js:61,139-141`) and key it on the real date, the way `touchDate`
   already does (`progress.js:567-570`). Keep the 40-minute sky. Raise the
   per-quest counts to suit a full day. This turns 36 boards a day back into
   one, restores the intended anti-churn ritual, fixes `devoted`, and removes
   ~900 coins/day of accidental bottle faucet at the same time. Do the same for
   the bottle and the bonfire cap.

5. **Login streak + daily gift, on top of the streak counter that already
   exists.** (**XS-S**) `c.days` and `c.lastDate` are already tracked and
   already correct (`progress.js:567-570`). A 7-day cycle paying escalating
   coins plus a cosmetic at day 7 is a UI and a table.

### Tier 2: the recurring sink and the reason to log in

6. **Rotating shop stock.** (**S**) A weekly featured hat that leaves the
   catalogue, driven off the same real-day index as item 4. Parked already at
   `DESIGN.md:152`. This is the only change that gives coins a permanent
   purpose, and it converts the 75-minute cosmetic economy into an
   indefinite one. Highest economic leverage per hour of work in the project.

7. **The den ladder + Den Champion title.** (**S**) Server-counted per-game W/L
   off the existing `match-win` signal (already two-party-agreed, so it is safe
   today), a board on the Trophy Loft wall, a weekly-rotating title that renders
   on the name tag using the milestone-title plumbing that already exists
   (`progress.js:553-559`). Converts the den's three shallow games into a
   season. Do **not** attach coins to it (`AUDIT.md` F-18).

8. **Chess/Cards difficulty pegs.** (**XS**) Three named strengths off the
   existing `depth`/`slack` parameters, three payout tiers. Turns two one-and-
   done AI opponents into a progression.

9. **Consumables and gifting.** (**M**) `AUDIT.md` F-27 items 2 and 4. Party
   poppers, fireworks that everyone in the room sees, mural paint that places a
   2x2, and buying a hat for a friend. First repeatable sink, first coin-
   mediated social act, and it gives the friends list a purpose beyond a green
   dot.

### Tier 3: the modes that are missing

10. **A server-driven event calendar.** (**M**) One table of scheduled events
    with a start time, a duration and an effect, a `event` frame reusing the
    party beacon plumbing, and three initial event types: **Double Coin Hour**
    (multiplier inside `grantCoins`, one line), **Aurora Party** (force
    `AURORA_CHANCE` to 1 at an announced time and put a temporary hotspot on
    the peak), and **Game Night** (announced 20-minute window where the den and
    the two party lobbies are advertised island-wide, which is really item 2
    with a schedule). Everything here reuses existing systems; the new work is
    the scheduler and the announcement UI. This is the mechanism that solves
    co-presence permanently: it tells everyone *when* to be somewhere.

11. **Community goals on the mural and the world.** (**S-M**) The mural already
    logs every op with a `by` field (`index.js:1893,2001`) and has no consumer.
    Add island targets ("the cove paints 5,000 pixels this week", "the cove
    lands 10,000 snowballs") with a plaza progress board and a shared unlock at
    100%. The counters mostly exist; the signals all exist. This is the only
    category of content in the game where *low* population still feels like
    company, because everyone's contribution is visible on one bar.

12. **Party activities.** (**M**) Give a host three buttons: a confetti cannon,
    a group dance-off (everyone who dances for 30 s straight gets a stamp tick),
    and a "musical statues" round the DJ booth can run. Then build the Groove
    Grotto's missing minigame: the rhythm game parked at `DESIGN.md:150`, on the
    existing 126 bpm club clock. Parties currently have nothing to do and the
    party venue currently has nothing in it; these are the same problem.

13. **A pet.** (**M**) `DESIGN.md:148-149`. One extra synced cosmetic slot, a
    daily care action, a name. In this genre it is a top-three daily-return
    driver and it costs one avatar attachment plus one `custom` field.

14. **Seasons.** (**L**) A repeatable 4-6 week cycle: fresh stamp sheet,
    rotating cosmetics, seasonal room re-dress off the palette system. This is
    the real answer to "the album ends", and it should be built *after* items 4,
    6 and 10 prove the cadence machinery works.

### Explicitly not recommended

- **Do not build leaderboards on `best`** until `AUDIT.md` F-14 is fixed;
  `index.js:2313-2321` accepts any integer from any client.
- **Do not attach coins or rank to den duels** until F-13 and F-18 are fixed;
  two colluding accounts already farm 115 coins a match.
- **Do not add more rooms or more minigames.** The cove has ten of each and the
  problem is not breadth. Nine rendezvous points across six rooms is already
  more than the population can fill; an eleventh would make it worse.

---

## Appendix: quick-reference numbers

| Thing | Value | Where |
|---|---|---|
| Cove day | 40 real minutes | `index.js:84`, `progress.js:61` |
| Quest boards per real day | **36** | derived from the above |
| Bottles per real day | 36, 25 coins each | `index.js:158,2089` |
| All nine buyable hats | 2,500 coins | `shared/constants.js:40-50` |
| Den furniture slots | 60 | `shared/constants.js:112` |
| Colour changes | free, unlimited, unvalidated | `index.js:2311` |
| Stamps | 48; solo ceiling **33** | `shared/constants.js:198-255` |
| Milestones | 5/12/20/30/40 stamps | `shared/constants.js:266-272` |
| Quests | 29; 11 need other humans | `shared/constants.js:154-186` |
| Minigame quests solo-completable | **5 of 14** | signal analysis, section 4 |
| Rendezvous points | 9, across 6 rooms | section 2 |
| Rooms with no minigame | 3 (plaza, club, drift) | hotspot tables |
| Interactive furniture pieces | **0 of 21** | `src/world/furniture.js` |
| Cross-room population display | none | `hud.js:260,328,2404-2424` |
| Friend presence push | none | `index.js:2394-2434` |
| Scheduled world events | none | grep: 0 hits |
| Leaderboards | none outside one race screen | grep: `sled.js` only |
| Co-op goals | none | grep: 0 hits |
</content>
</invoke>
