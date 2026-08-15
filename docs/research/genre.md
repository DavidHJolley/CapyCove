# Genre research: what Club Penguin actually was, what its heirs do now, and the ten things Capy Cove is missing

Researcher: genre / outside-world agent. Date: 2026-08-14.
Scope: this document looks **outward**. It does not re-litigate the technical audit
(`docs/AUDIT.md`); where it touches the same ground it says so and builds on it.
Everything here is either (a) grounded in a cited outside source, (b) grounded in a
cited file in this repo, or (c) explicitly labelled **[judgment]**.

Style of claim used throughout:
- **Evidence**: a URL or a repo path.
- **The loop**: the psychological mechanism, stated plainly, because "it was fun" is
  not a design input.
- **Scope verdict**: pass / adapt / reject against `CLAUDE.md`'s scope test (cozy,
  wholesome, capybaras, social-first, chunky toon, all-ages but aimed at adults).

---

## 0. The one-paragraph thesis

Capy Cove has built the **hard half** of this genre and skipped the **cheap half**.
The hard half is a world worth being in: ten rooms, ten multiplayer minigames, houses,
a live clock and weather, a shared mural, parties, an authored 48-stamp album. Club
Penguin's own hard half took years and a Disney acquisition. The cheap half is the
part that made Club Penguin a *phenomenon* rather than a good virtual world, and
almost all of it is **content cadence and social theatre**: a weekly pin nobody
engineered, a catalog whose stock rotated, a newspaper that told you what was
happening, a pet that made you feel expected, a mascot who showed up and caused a
stampede. Those systems are small pieces of code wrapped around a *publishing habit*.
Capy Cove currently has zero recurring content and zero re-engagement surface
(`docs/AUDIT.md` F-28), which means it is a beautiful world that has no reason to be
re-entered on a Tuesday. Everything ranked in section 4 is an attempt to fix exactly
that, at the lowest engineering cost per unit of returning player.

---

## 1. Club Penguin at peak: an anatomy

Club Penguin ran roughly 2005 to 2017, peaked commercially around 2010 to 2013, and
accumulated about **63 main rooms** across its history (not counting party-only rooms)
and a minigame roster in the **forty-plus** range including Aqua Grabber, Cart Surfer,
Jet Pack Adventure, Thin Ice, Astro Barrier, Pizzatron 3000, Card-Jitsu and its three
sequels, and a dozen puffle-specific games
([room count](https://cprewrittencheats.blogspot.com/p/main-rooms.html),
[game list](https://clubpenguin.fandom.com/wiki/List_of_Games)).

Capy Cove has 10 rooms and 10 minigames (`shared/constants.js:5`, `:23`). **That gap is
not the problem and should not be chased.** Capy Cove's rooms are individually far
denser than a Club Penguin room (a CP room was one static Flash backdrop; a Capy Cove
room is a lit 3D set with particles, critters and ambient audio per `DESIGN.md` §1).
Breadth was Club Penguin's answer to a thin per-room experience. Copying the breadth
would cost years and dilute the density that is currently Capy Cove's actual advantage.
**[judgment]** Do not build rooms 11 to 63. Build reasons to re-enter rooms 1 to 10.

### 1.1 The weekly hidden pin

**What it was.** Every week a new pin was hidden somewhere on the island, in a room, as
part of the scenery. You clicked it, it went in your inventory, you could wear it. Once
the week passed the pin **never returned**
([Club Penguin Journey wiki: Pin](https://clubpenguinjourney.fandom.com/wiki/Pin)).

**The loop.** Three mechanisms stacked. (1) *Fear of missing out with a hard deadline*,
which is the single most reliable weekly-return driver ever built into this genre.
(2) *An excuse to tour the world*: to find the pin you had to walk through rooms you
had no other reason to visit, which re-exposed you to other players, which is the whole
point of a social game. (3) *Cheap social capital*: an old pin on your penguin was
legible proof you were there. Adults in this audience still read pin sets as a
seniority signal.

**Cost to Club Penguin.** Essentially zero. It is one clickable object moved once a
week. This is the highest return-per-line-of-code mechanic in the entire genre.

**Scope verdict: pass, unmodified in spirit.**

### 1.2 Catalogs with rotating stock and hidden secret items

**What it was.** The clothing catalog (Penguin Style), the furniture catalog, the
igloo catalog and Rockhopper's Rare Items all rotated on a monthly cadence. On top of
rotation, catalogs contained **secret items**: items not printed on the page that
appeared only if you clicked an unmarked hotspot, typically something visually
salient like the top of a tree, a mountain peak, a background penguin, or occasionally
just a word of body text. Between 2010 and 2013 a single catalog could hide
**20 to 30** secret items; the practice was wound down and mostly removed by July 2015
([Secret items](https://clubpenguin.fandom.com/wiki/Secret_items)). Modern private
servers still ship this: Club Penguin Journey advertises "clothing catalogs with hidden
items to discover" as a headline feature and the fan press writes a fresh
catalog-secrets guide every single month
([Journey features](https://www.cpjourney.net/features),
[August 2026 catalog secrets guide](https://cphelpforce.com/2026/08/cp-journey-august-2026-penguin-style-catalogue-guide/)).

**The loop.** Rotation converts a *finite* catalog into an *unbounded* one without
authoring unbounded content, because the same 40 items feel like new stock when 8 of
them are visible this month. Secret items add a second layer: a **discovery** reward
on top of a **purchase** reward, which turns a shop UI into a puzzle, and crucially it
turns the shop into a *conversation*. The reason there is a monthly catalog-secrets
blog post in 2026 is that finding the secrets is a communal act. Nobody writes a guide
to a grid of buttons.

**Why this matters to Capy Cove specifically.** `docs/AUDIT.md` §3.5 costs the entire
economy at 6,510 coins against a design intent of ~1,500 coins/hour, i.e. **the whole
game is bought out in about four hours**, and there is no recurring sink anywhere. A
rotating catalog is the standard genre answer and it is a week of work, not a redesign.

**Scope verdict: pass. Highest-leverage single change in this document.**

### 1.3 The Club Penguin Times (the newspaper)

**What it was.** A weekly in-world newspaper edited in fiction by Aunt Arctic
([Aunt Arctic](https://clubpenguin.fandom.com/wiki/Aunt_Arctic)). It carried the party
schedule, contest announcements and results, jokes and reader letters, job postings,
and the igloo showcase. Journey still ships a newspaper and still uses it for job
postings ([Journey features](https://www.cpjourney.net/features)).

**The loop.** The newspaper was the *scheduling layer*. It is what made a live-service
world legible: it told you that something was happening on Friday, that the contest
you entered had results, that the catalog had changed. Without it, weekly content is
invisible and therefore does not exist. It also did something subtler: it made the
island feel **authored by someone**, which is what separates a hangout from a chatroom.
An in-fiction editor with a voice is a cheap, durable personality for the whole world.

**The Capy Cove connection.** The cove already has a notice board in the plaza, but it
was redressed into the Quest Board (`src/world/rooms/plaza.js:1063`, `src/ui/quests.js`).
There is no publication surface at all. Per `docs/AUDIT.md` F-28 there is also no
re-engagement channel of any kind. A newspaper is the in-world half of that fix.

**Scope verdict: pass.**

### 1.4 Puffles

**What they were.** Pets adopted for **800 coins each**, originally 5 colours (blue,
green, pink, purple, black), 10 by 2011, eventually dozens; a player could own up to
**75**. Care ran on four tracked needs: health, hunger, rest and play. Neglect made a
puffle sad and eventually it **ran away**. Overfeeding or over-sleeping also *reduced*
health, which is a fiddly punishment mechanic. Puffles could be walked (one at a time,
following you between rooms, visible to everyone), and while walking they would
periodically dig: all players' puffles could dig up **coins**, but only members' puffles
dug up clothing, furniture and special food. Individual colours had abilities inside
specific minigames (red surfs in Catchin' Waves, black rides in Cart Surfer, pink makes
air bubbles in Aqua Grabber, yellow plays in DJ3K)
([puffle overview](https://www.clubpenguinwiki.info/wiki/Puffle),
[digging](https://www.clubpenguinwiki.info/wiki/Puffle_Digging)).

**The loop.** Four separate things, and it is worth separating them because only three
are worth copying.
1. **Expectation.** A creature that is glad you came back is the single most effective
   daily-return device in cozy games. This is the same mechanism the Animal Crossing
   retention literature identifies in villagers: the world *notices* your absence and
   your presence (ACM CHI PLAY,
   [Understanding Player Retention Strategies in Animal Crossing: New Horizons](https://dl.acm.org/doi/fullHtml/10.1145/3450337.3483483)).
2. **A visible companion is a social object.** A puffle walking beside you is a second
   cosmetic slot that other players can see, comment on, and covet. `DESIGN.md`'s
   social-first rule ("everything cosmetic is visible to others ... that is WHY players
   buy hats") applies directly.
3. **Digging is idle income that requires presence.** It pays you for *walking around
   the world with other people*, which is exactly the behaviour a social game wants,
   as opposed to grinding a minigame alone.
4. **Care decay and runaway.** This is the part to reject. Punishing absence in a cozy
   game converts a pet from a reason to return into a source of guilt, and the
   overfeeding penalty is actively hostile design.

**Scope verdict: adapt.** Take expectation, visibility and digging. Reject decay,
runaway, and the member/non-member split on dig rewards.

### 1.5 Igloos, igloo contests, and Featured Igloos

**What they were.** Personal decorated spaces plus, critically, a **curation layer** on
top. Igloo contests ran through the newspaper, were themed to the current party
(Halloween and Holiday most often), took one to four weeks to judge, and winners were
announced in the paper with a prize that always included coins
([Igloo Contests](https://clubpenguin.fandom.com/wiki/Igloo_Contests)). Journey runs the
lighter-weight version continuously: **four player igloos featured in the newspaper
every two weeks**, chosen by nomination or by staff discovery, rewarded with a special
postcard, a Newspaper Igloo Trophy and 10,000 coins
([Featured Igloos](https://clubpenguinjourney.fandom.com/wiki/Featured_Igloos)).

**The loop.** A decorated room with no audience is a screensaver. The contest is what
converts a building tool into a *performance*, and performance is what makes people
build. It is also the cheapest content in existence, because **the players make it**.
The prize matters less than the visibility; the Newspaper Igloo Trophy is a
positional good and costs one texture.

**The Capy Cove connection.** Houses shipped in wave 3 with a 20-item catalog, a
placement editor and open/friends/invite access (`CLAUDE.md` wave 3, `src/ui/houseEditor.js`).
There is a `decorator` stamp for placing ten items (`shared/constants.js`) and
essentially nothing else pulling anyone into anyone else's den. This is a built system
running at a fraction of its value.

**Scope verdict: pass.**

### 1.6 Parties and the seasonal calendar

**What they were.** Roughly monthly, sometimes overlapping, and by 2011 typically
running **10 to 14 days or longer**. A party re-skinned the island: building exteriors
and interiors were redecorated and the music changed
([Parties](https://clubpenguin.fandom.com/wiki/Parties)). The 2010 slate ran Cave
Expedition, Earth Day, Mountain Expedition, Celebration of Water, Puffle Party, Penguin
Play Awards, April Fools', Medieval, Island Adventure, Music Jam, The Fair and Showdown;
2011 was a comparable cadence
([2010](https://clubpenguin.fandom.com/wiki/List_of_Parties_and_Events_in_2010),
[2011](https://clubpenguin.fandom.com/wiki/List_of_Parties_and_Events_in_2011)).
Journey still leads with "monthly themed parties and events" plus "Party Quests where
players earn gems for exclusive rewards" ([Journey features](https://www.cpjourney.net/features)).

**The loop.** Three things at once. (1) *Deadline-bounded cosmetics*: a free party item
you can only get this month, which is a permanent, wearable receipt of having been
there. Old party items were the real seniority signal, more than pins. (2) *Novelty
without new geometry*: re-dressing an existing room is a fraction of the cost of a new
room and reads as "the game updated". (3) *Synchronisation*: everyone is doing the same
thing in the same fortnight, which is what makes a world feel populated even when
concurrency is flat.

**The Capy Cove connection.** `DESIGN.md:150` already parks "seasonal re-dressing of
rooms (the palette system makes this cheap)". The infrastructure is better placed for
this than Club Penguin's was, because Capy Cove rooms are built from *numbers* and
procedural materials, not from art files. Note the term collision to resolve: "party"
in Capy Cove currently means a player-hosted gathering with a 90-minute cooldown
(`CLAUDE.md` wave 7). The seasonal thing needs a different word (Festival, Fair).

**Scope verdict: pass.**

### 1.7 Mascot visits

**What they were.** Named characters (Rockhopper, Aunt Arctic, Cadence, Gary, Sensei,
Rookie, PH and others) who logged in as real avatars during events. Meeting one let you
add them to your friends list, receive an autographed background, and usually earn a
stamp ([List of Characters](https://clubpenguin.fandom.com/wiki/List_of_Characters_in_Club_Penguin)).
Rockhopper additionally arrived by ship and brought a rotating Rare Items catalog
([Rockhopper](https://clubpenguin.fandom.com/wiki/Rockhopper)). This is still a live
draw: Journey's one-million-player celebration in July 2026 fielded **15 mascots**
giving out new backgrounds, with the explicit instruction that they can appear at any
time so players should keep watching
([Journey 1M guide](https://thearmyofcp.com/2026/07/15/club-penguin-journey-1000000-penguins-celebration-guide/)).

**The loop.** A mascot visit is a **stampede generator**. The mechanic is scarcity of
presence: the reward is small, but the reward requires being *in the right room at the
right time*, which produces the densest, loudest, most memorable crowds the game ever
sees. Those crowds are the actual product. A secondary loop is parasocial: a character
with a consistent voice who occasionally shows up is a relationship, and the tracking
subculture around mascot sightings (fan trackers still exist for private servers,
[example](https://www.numuki.com/blog/club-penguin-rewritten-mascot-tracker/)) is free
community infrastructure that the game does not have to build.

**Scope verdict: pass.** With a caveat: Capy Cove has no staff. See 4.8 for the
scheduled-NPC version that needs no human on shift.

### 1.8 The secret agency: PSA missions, EPF, and Field-Ops

**What they were.** Two things wearing the same coat. **Missions** were authored
single-player point-and-click adventures (11 classic PSA missions, still shipped by
Journey today). **Field-Ops** were the repeatable version: released every Thursday, your
spy phone blinked, a clue told you which room to go to, you found the device and played
a short minigame, and you earned exactly **one medal per week**, redeemable for Elite
Gear ([Field-Ops](https://clubpenguin.fandom.com/wiki/Field-Op)). They later moved to
monthly and were eventually retired.

**The loop.** Missions gave the world *lore* and a reason for its rooms to have
histories, but they were expensive to author, solo, and strictly one-and-done.
Field-Ops were the opposite: near-zero authoring cost, infinitely repeatable in
structure, and they did the same thing the weekly pin did (send you into a specific
room on a specific week) while additionally handing out a **second currency** that
bought things coins could not. That second currency is the important trick: it lets you
sell prestige gear without inflating the coin economy.

**Scope verdict: reject the missions (expensive, solo, one-shot, and tonally
adventure-shaped rather than cozy). Adapt the Field-Op into a weekly errand.**

### 1.9 Card-Jitsu and the belt ladder

**What it was.** A rock-paper-scissors-with-elements card duel wrapped in a **nine-belt
ladder** (white, yellow, orange, green, blue, red, purple, brown, black). Each belt
required one more win than the last, and after black you challenged Sensei, who beat you
several times before letting you through, and only then did you get the Ninja Mask
([Card-Jitsu Belts](https://clubpenguin.fandom.com/wiki/Card-Jitsu_Belts)). Fire and
Water each added a four-piece suit assembled through play, then a gem
([Ninja Progress](https://clubpenguin.fandom.com/wiki/Ninja_Progress)).

**The loop.** This is the only mechanic in Club Penguin with a genuine **long-horizon
skill ladder**, and it is the one the community mythologised hardest. The escalating
win requirement is a deliberately punishing curve whose function is to make the black
belt *rare and visible*. The wearable belt made every player's rank legible on sight,
which turned the dojo into a place where you could size someone up before sitting down.
Losing to Sensei repeatedly before being allowed to win is a small piece of narrative
genius: it converts a grind into a rite of passage.

**Scope verdict: adapt, with a hard technical caveat.** `docs/AUDIT.md` F-18 and its
one-page verdict state plainly that the server models none of the den duel games and
cannot distinguish a legitimate result from a fabricated one, and that **no ranked or
leaderboard-backed mode should be built on den duels**. A win-counting ladder is exactly
that. See 4.10 for a version that survives the constraint.

### 1.10 Membership

**What it was.** $5.95/month, $29.95/6 months, $57.95/year. Free players could explore
and play games; members got igloo decorating, most clothing, party gear and more
([HowStuffWorks](https://computer.howstuffworks.com/internet/social-networking/networks/club-penguin.htm),
[Membership](https://clubpenguin.fandom.com/wiki/Membership)).

**The loop.** Brutally effective and worth naming honestly: the game made
non-membership **visible**. A free penguin looked free. The purchase driver was not
content access, it was social embarrassment.

**Scope verdict: reject the mechanism outright.** It is the one piece of Club Penguin
its adult alumni remember with active resentment, and the private-server scene is in
part a reaction to it: Ice Penguin's stated philosophy is "zero restrictions" with
unlimited coins granted at signup
([Ice Penguin](https://alternativeto.net/software/ice-penguin/about)). If Capy Cove ever
monetises, the genre-correct 2026 shape is cosmetic-only with **no visible have/have-not
tier**, i.e. supporters get *different*, not *better*, and nothing that makes a
non-payer's capybara read as unfinished. **[judgment]**

---

## 2. The heirs: what works now

### 2.1 Club Penguin private servers (the direct successors)

The scene is large and durable. Club Penguin Journey launched February 2023 and passed
**one million registered accounts by July 2026**, and is described as the most
consistently active server
([Journey wiki](https://clubpenguinjourney.fandom.com/wiki/Club_Penguin_Journey),
[Journey news](https://cpjourney.net/news/2026/07/one-million-penguins-one-incredible-journey-3101)).
Club Penguin Rewritten was shut down by Disney legal action in 2022
([Wikipedia](https://en.wikipedia.org/wiki/Club_Penguin_Rewritten)); Club Penguin Legacy
was likewise closed under Disney pressure to public outrage
([Sportskeeda](https://sportskeeda.com/pop-culture/news-short-life-sudden-demise-club-penguin-legacy-shuts-disney-s-demands-sparks-outrage-online)).
**That is Capy Cove's actual market opening**: an audience with a demonstrated appetite
of seven figures, repeatedly deprived of the product by an IP holder, with nowhere
legally durable to go. An original-IP capybara cove is not competing with Club Penguin,
it is competing for the refugees.

What these servers put at the top of their own feature lists (i.e. what they believe
sells), from Journey's features page verbatim: over 20 minigames, hundreds of furniture
items, **puffle adoption**, an **advanced outfit system** with layering of multiple items
of the same type and **saved outfit combinations**, **monthly themed parties** with party
quests paying a gem currency for exclusive rewards, **clothing catalogs with hidden
items**, stamps, all 11 PSA missions plus custom EPF operations, a newspaper, monthly
igloo/music store updates, and jobs at the Coffee Shop and Pizza Parlor
([features](https://www.cpjourney.net/features)). Their ongoing update blog leads with
**new pins on the island** and **community events in the welcome room**
([Monday Games Updates](https://cpjourney.net/news/2026/01/monday-games-updates-2386)).

Two signals worth extracting. First, **cadence beats catalogue**: the thing they ship
weekly is pins and events, not rooms. Second, **expression is under-served**: Journey
built a layering/outfit-saving system Club Penguin never had, and Ice Penguin's entire
pitch is custom items, custom name colours and adjustable penguin size. Capy Cove
currently offers one hat slot plus a body colour (`shared/constants.js` HATS,
BODY_COLORS). For an adult nostalgic audience whose primary activity is standing around
being looked at, **that is the thinnest part of the game** and it is not on any roadmap
I can see. **[judgment]**

### 2.2 WEBFISHING (chaotic-cozy multiplayer, 2024)

Released October 2024 at $6.49, sitting at roughly **57,000 reviews, 97% positive,
"Overwhelmingly Positive"**, from a solo developer
([Steam](https://store.steampowered.com/app/3146520/WEBFISHING/)). Up to **12 players
per lobby**; described repeatedly in press as a fishing *chatroom*
([PC Gamer](https://www.pcgamer.com/games/heres-an-adorable-cozy-little-multiplayer-chatroom-fishing-game/),
[MMORPG.com](https://www.mmorpg.com/editorials/perhaps-webfishing-the-bite-sized-lobby-based-cozy-fishing-game-is-peak-multiplayer-2000133319)).

Its four advertised pillars are worth reading as a design statement: **catch them all**
(nearly 100 creatures with a journal to complete), **upgrade and customize** (rods,
baits, lures, cosmetics), **play with friends**, and **play with toys** (a fully
functional guitar where you set chords and strum it yourself, chalk drawing, punching,
sandbox tools).

Three lessons, in order of importance to Capy Cove.

1. **The collection journal is the retention spine, not the fishing.** "Nearly 100
   creatures" with a checklist turns a 90-second activity into a months-long project.
   Capy Cove's Reel Rush is a score-and-coins game with no species, no journal, no
   rarity, no completion state. This is a large, cheap, entirely in-scope upgrade to
   content that already exists.
2. **Toys that make noise are the social engine.** Inverse and PC Gamer both dwell on
   the guitar rather than the fishing, because a player-driven instrument is a
   *broadcast*: it makes one player's action into everyone's experience, which is what
   turns co-presence into a scene
   ([Inverse](https://www.inverse.com/gaming/steam-webfishing-cozy-chatroom-game-animal-crossing)).
   Capy Cove has ambient toys (snowballs, beach ball, mural) but nothing a player
   *performs* with. The Groove Grotto has a 126bpm clock sitting unused for exactly this
   (`DESIGN.md:151`).
3. **The tonal caveat.** Part of Webfishing's appeal is its crude humour, off-colour
   fish jokes and light role-play latitude. **Do not copy this.** Capy Cove's scope test
   says wholesome, and the audit's trust-and-safety findings mean the game cannot afford
   to *invite* edge. Take the toys, not the tone. **[judgment]**

### 2.3 Sky: Children of the Light (social ritual as a designed system)

thatgamecompany's design talk is the best available articulation of deliberate social
design, and its definition is the useful part: social play is "any activity performed
near other players, which encourages simulating the thoughts and feelings of others,"
i.e. **empathy**
([Game Developer](https://www.gamedeveloper.com/design/using-emotion-to-drive-social-play-in-i-sky-children-of-the-light-i-)).
Mechanics worth stealing:

- **The candle ritual.** Other players appear as unlit silhouettes; you touch your candle
  flame to theirs to reveal them. The concealment exists *purely to create a meeting
  ceremony*. Friction was added on purpose, because a moment that costs something is
  remembered.
- **A friendship tree with unlocks.** Relationships level up through mutual investment,
  unlocking abilities including permanent text chat and hand-holding
  ([Making Friends](https://sky-children-of-the-light.fandom.com/wiki/Making_Friends)).
  Investment in a specific person yields new *verbs* with that person, so the friends
  list is a progression system, not an address book.
- **Hand-holding is literal transfer of control.** One player can hand navigation to
  another. Hughes: "A really attentive guide will create experience for other players."
- **You cannot hurt anyone.** The only interactions are helping, holding hands and
  sharing light. This is the same design position as Capy Cove's scope test, arrived at
  independently, and it is why Sky's moderation surface is smaller than its size would
  predict.
- **Deliberate slowness.** Hughes: "Anything in the world that slows players down can
  create the boredom necessary to inspire creative usage of the mechanics." Capy Cove's
  instincts here are already right (a mural pixel every twenty seconds, a whole room
  that is just swimming) and should be defended against pressure to make things snappier.
- **Seasons as expiring currency.** A season grants a capped daily currency (5/day free,
  6/day with the pass) spent at a season-specific vendor, and leftover seasonal candles
  convert to plain candles when the season ends
  ([help centre](https://thatgamecompany.helpshift.com/hc/en/17-sky-children-of-the-light/faq/519-what-are-seasonal-candles-and-how-do-i-obtain-them/),
  [PC Gamer](https://www.pcgamer.com/games/mmo/sky-children-of-the-light-seasonal-candles-locations/)).
  The **daily cap** is the key detail: it makes the season a *habit* rather than a
  weekend binge, and it means a player who logs in for ten minutes a day beats a player
  who logs in for six hours once.

### 2.4 Animal Crossing (the daily pull)

The CHI PLAY retention work identifies the mechanism as **temporal design**: repeated
short daily sessions generate affective attachment, driven by constant feedback and
small rewards for simple tasks, with villagers plus a steady drip of new collectibles as
the named retention factors
([ACM](https://dl.acm.org/doi/fullHtml/10.1145/3450337.3483483), and on temporal design
specifically [ACM SIGDOC](https://dl.acm.org/doi/10.1145/3641237.3691689)).

The transferable structure is a **daily chore set that is finished, not exhausted**:
the rock, the fossils, the shop's rotating stock, the message bottle. It ends. You are
released. Capy Cove already has the right shape here (three seeded dailies per cove day,
`server/progress.js`, and a daily bottle in The Drift), which is genuinely ahead of the
genre. What it lacks is the *world* half: things that regenerate in the rooms themselves
rather than in a quest UI.

---

## 3. Where Capy Cove actually stands

| Genre mechanic | Capy Cove today | Evidence |
| --- | --- | --- |
| Themed rooms | 10, high density | `shared/constants.js:5` |
| Minigame roster | 10, all multiplayer/PvP | `shared/constants.js:23` |
| Personal space | Houses + 20 furniture + editor | wave 3, `src/ui/houseEditor.js` |
| Achievement book | 48 stamps, 7 categories, 5 milestones | `shared/constants.js:198+` |
| Dailies | 3 seeded quests per cove-day | `server/progress.js` |
| Live world | Clock, weather, aurora, day/night | wave 7, `docs/LIVING-COVE.md` |
| Shared canvas | Plaza mural, moderated | wave 7 |
| Player-hosted events | Parties, 90 min cooldown | wave 7 |
| Friends | List, whispers, profile cards, visits | wave 1/3 |
| **Pet / companion** | **None** (parked, `DESIGN.md:148`) | grep: no pet system |
| **Rotating stock** | **None**, static catalog | `src/ui/shop.js`, no rotation |
| **Hidden/secret items** | **None** | grep |
| **Weekly collectible** | **None** | grep |
| **Newspaper / publication** | **None** (notice board is the Quest Board) | `src/world/rooms/plaza.js:1063` |
| **Seasonal festivals** | **None** (parked, `DESIGN.md:150`) | grep |
| **Collection journal** | **None** | grep |
| **Den contest / curation** | **None** | grep |
| **Mascot / named character** | **None** | grep |
| **Gifting** | **None** | grep |
| **Leaderboards** | **None**, and blocked on F-14 | `docs/AUDIT.md` §3.6 |
| **Photo / postcard sharing** | **None** (parked, `DESIGN.md:152`) | grep |
| Expression breadth | 1 hat slot + body colour | `shared/constants.js:40,60` |

Read that table as: the *systems* column is strong and the *cadence* column is empty.

---

## 4. Ranked: the ten highest-leverage missing mechanics

Ranked by (retention impact x scope fit) / build cost. Each sketch is
**[judgment]** unless it cites something.

### 1. Rotating stock with hidden items: the Cove Consignment

Split the shop into a permanent staples rack and a **rotating stall** that swaps on the
real-world calendar (a fortnight is the right interval; Club Penguin ran monthly and
that is a beat too slow for a small world). Only 6 to 8 of the rotating items are
visible at a time out of a much larger authored pool, so the same content reads as new
stock four times a quarter, and re-runs of old stock become a nostalgia event of their
own. On top of rotation, hide **secret items** in the catalog art exactly as Club Penguin
did: the shop already renders a 3D turntable diorama (`src/ui/shop.js:382-521`), which is
a far better hiding place than a Flash page ever was, because the hotspot can be *behind*
something you have to spin the turntable to reach. Two or three secrets per rotation,
never announced, always findable, and the community will build the guide for you the way
they still do for Journey monthly. Pair this with the one change that makes the whole
economy breathe again: **consumables**. Cocoa, snowball crates, party poppers, mural dye
refills, food for the companion (see #3). `docs/AUDIT.md` §3.5 puts the entire game's
purchasable content at 6,510 coins, i.e. about four hours; a rotating stall plus
consumables is the standard genre answer and it is roughly a week of work. Guardrail:
rotation must never remove an item a player already owns, and prices must stay on the
existing 50/80/120/150/250/300/350/400/800 ladder (`DESIGN.md` §2).

### 2. The Cove Times: a weekly paper and the reason to come back

Bring back the plaza notice board as an actual **publication** (the Quest Board keeps
its slot; the paper is a second, larger board, or the same board with two tabs). One
issue a week, in-fiction, edited by a named capybara with a consistent warm-and-slightly-
scattered voice, following Aunt Arctic's role at the Club Penguin Times
([Aunt Arctic](https://clubpenguin.fandom.com/wiki/Aunt_Arctic)). Contents, all of which
are generated from data the server already has plus one short authored blurb: what the
consignment stall is stocking this fortnight, which festival starts when, this week's
featured dens (#7), the results of the last contest, when the visitor is expected (#8),
a rumour hinting at where the charm is hidden (#4), and a "letters" column that reprints
one or two player chat lines the operator has approved. The paper is the layer that makes
every other item on this list **legible**; without it, weekly content ships into a void.
It is also the in-world half of the answer to `docs/AUDIT.md` F-28 ("no way to bring a
player back"), and the only half that requires no email address, no notification
infrastructure and no privacy exposure, which matters given F-25 is still open.
The archive of back issues is itself a retention object: it makes the world have a past.

### 3. A companion critter: the puffle-shaped hole

One adopted creature that follows you between rooms and is visible to everyone, in the
Capy Cove idiom: a duckling, a snail, a fat little frog, a river otter, a turtle
(`DESIGN.md:148` already parks "a snail/duckling"). Adopt for coins on the existing
price ladder, own several, walk **one** at a time so it stays a legible cosmetic slot,
and sync it over the existing `custom` message so it obeys `DESIGN.md`'s rule that
cosmetics must be visible or they do not socially exist. Take three of Club Penguin's
four loops and refuse the fourth: keep **expectation** (it does a delighted animation
when you log in, it has a name you chose, it reacts to weather and to other players'
companions), keep **visibility**, keep **digging** (while walked, it periodically finds
a small coin bag or a consumable, per
[Puffle Digging](https://www.clubpenguinwiki.info/wiki/Puffle_Digging), which pays you
for wandering the world socially rather than grinding alone), and **hard-reject decay,
sadness and runaway**. A cozy game aimed at adults must not punish a two-week absence:
the companion is asleep in your den when you return, and delighted, full stop. Give it
one care verb that is pure upside (feed it a treat, it plays an animation, it digs better
for an hour) so there is something to spend consumables on. Rough cost: a follower
entity, one instanced low-poly creature per species, a shop tab, one sync field.
This is `docs/AUDIT.md`'s own item 44 and it is right that it is high on the list.

### 4. The weekly charm hunt

One small object, hidden in the scenery of one room, changing every week, never
returning: a shell, a pinecone, a bottle cap, a lost mitten. Click it, it enters a charm
board on the profile card, and it can be worn as a tiny accessory (which also quietly
doubles the expression budget flagged in 2.1). This is a near-exact port of the Club
Penguin pin ([Pin](https://clubpenguinjourney.fandom.com/wiki/Pin)), and the reason it
is this high with essentially no build cost is that it is the genre's proven weekly
return trigger and its proven world-tour driver. Implementation is a data table of
`{week, room, position, charmId}` plus a one-per-account claim, and the rooms are built
from numbers with a live layout editor already (`CLAUDE.md`, Ctrl+E handles), so placing
next week's charm is a two-minute operator job, not an engineering task. The Cove Times
runs a rumour, never the location. Sequence it with #2 so there is somewhere to hint.
Note that this is precisely what Journey ships in its own weekly update posts
([Monday Games Updates](https://cpjourney.net/news/2026/01/monday-games-updates-2386)).

### 5. Festivals: the seasonal re-dress on a published calendar

Roughly one per month, running ten to fourteen days like late-period Club Penguin
([Parties](https://clubpenguin.fandom.com/wiki/Parties)), each re-dressing two or three
rooms rather than all ten, each with a **free wearable item** given for showing up and a
small themed stock in the consignment stall. Capy Cove is unusually well placed for this:
rooms are built from numbers and procedural canvas textures with a documented palette
system, and `DESIGN.md:150` already calls seasonal re-dressing cheap. Candidates that
write themselves from the existing world: a Lantern Drift in The Drift, a Melon Festival
in the plaza, a Snow Fair on Frosty Peak, a Glowworm Night in the Tangle Jungle, a Cocoa
Week at the Den, a Mural Day where the pixel cooldown drops. Two disciplines make or
break this. First, **rename the collision**: "party" already means a player-hosted
gathering (wave 7), so the seasonal thing is a Festival or a Fair. Second, **publish the
calendar in advance** in the Cove Times, because a party nobody knew was coming is just
a Tuesday with bunting. The free item is the mechanism that matters: it is a permanent,
wearable, dateable receipt, and in the long run those receipts are the strongest
seniority signal the game will have.

### 6. The Cove Almanac: turn minigames into collections

Webfishing's headline pillar is "nearly 100 creatures to collect and a journal to
complete" ([Steam](https://store.steampowered.com/app/3146520/WEBFISHING/)), and that
journal is why a 90-second loop sustains a 97%-positive, 57,000-review game. Capy Cove's
Reel Rush currently pays coins and a score and nothing else. Give the cove an Almanac:
**fish species** in Reel Rush and The Drift, **gems and oddities** in the Glimmer Mine
(which already has a gem flag in the quest data, `shared/constants.js` `q_gem`), **critters
and blooms** in the jungle and on the beach, each with an entry, a silhouette until
found, a rarity tier, and, crucially, **conditions**: some only at night, some only in
rain, some only during a festival. That last clause is the trick, because it makes the
existing world clock and weather system (wave 7, `docs/LIVING-COVE.md`) into a *content
generator* rather than set dressing, and it gives a player a reason to be in the cove at
2am or during a downpour. Display the Almanac beside the stamp album in the profile card
so it inherits the existing viewing-other-players plumbing, exactly as Club Penguin let
you click a penguin to read their stamp book
([Stamps](https://clubpenguinjourney.fandom.com/wiki/Stamps)). This is the single best
value extracted from content that is already built.

### 7. Featured Dens: give the house system an audience

Houses shipped in wave 3 with a placement editor and access modes and are, socially,
nearly inert. The genre's fix is curation. Run the light version continuously, Journey's
shape rather than Club Penguin's: **four dens featured every fortnight**, chosen by
player nomination plus operator pick, announced in the Cove Times, rewarded with a coin
prize, a plaque prop that can only be obtained this way, and, most importantly, a
**one-click warp from the paper straight into the featured den**
([Featured Igloos](https://clubpenguinjourney.fandom.com/wiki/Featured_Igloos)). Add a
themed contest attached to each festival (#5), judged one to two weeks later with results
in the paper, matching how Club Penguin ran igloo contests through the newspaper
([Igloo Contests](https://clubpenguin.fandom.com/wiki/Igloo_Contests)). The prize is
almost irrelevant; the visibility is the entire mechanic, and the plaque is a positional
good costing one canvas texture. Second-order benefit: featured dens create *destinations*
for a player who has nothing to do, which is the state in which players quit. Guardrail:
nominations and any player-authored den name are new user-generated-content surfaces and
must go through whatever moderation layer F-21..24 produces, so sequence this after that
work, not before.

### 8. A visitor: the scheduled mascot

Club Penguin's densest, loudest crowds were mascot visits, and the mechanic is scarcity
of presence, not the size of the reward: an autographed background, a friend-list entry
and usually a stamp
([List of Characters](https://clubpenguin.fandom.com/wiki/List_of_Characters_in_Club_Penguin)).
Capy Cove has no staff, so build the **scheduled NPC** version. One named capybara with
a strong silhouette and a reason to arrive: the obvious one is a Rockhopper analogue who
comes in by boat to Driftwood Beach with a **rare-stock crate**, tying the visit directly
to the consignment rotation (#1) the way Rockhopper's Rare Items tied to his ship
([Rockhopper](https://clubpenguin.fandom.com/wiki/Rockhopper)). The server already runs
bots that wander, chat room-flavoured lines and migrate between rooms (`DESIGN.md` §2
social-first rules), so a visitor is a bot with an authored line set, a schedule, an
arrival announcement in the paper, a handout item and a stamp. Announce the *day*, not the
hour, so the crowd has to wait together, which is the point: the waiting-around is the
content. One character is enough to start; Journey fielded fifteen at its million-player
event, but that is a decade of accumulated cast
([Journey 1M guide](https://thearmyofcp.com/2026/07/15/club-penguin-journey-1000000-penguins-celebration-guide/)).

### 9. Friendship that does something: levels, verbs and gifts

`docs/AUDIT.md` §3.6 notes the friends system "exists and does almost nothing". Sky's
answer is the model: relationships level through mutual investment and each level unlocks
new **verbs with that specific person**, including chat and hand-holding, so the friends
list becomes a progression system
([Making Friends](https://sky-children-of-the-light.fandom.com/wiki/Making_Friends),
[Game Developer](https://www.gamedeveloper.com/design/using-emotion-to-drive-social-play-in-i-sky-children-of-the-light-i-)).
The capy-native adaptation: a shared cocoa. Two capys sit at any bench, table or bonfire
in the cove and share a mug; each shared cocoa raises a private friendship level between
them, and levels unlock paired emotes, in escalating order of intimacy and silliness:
a synchronised wave, a paired dance, a piggyback (one capy rides the other, which the
`ride` movement flag from wave 7 already supports), and a nap-pile. Add **gifting** on
top, which the audit also asks for as the first coin-mediated social act (item 41):
a wrapped consumable or a duplicate charm handed over in person, with a server-side cap
so it cannot become a coin-laundering channel for the collusion vector the audit already
documents. Sky's non-negotiable principle applies and Capy Cove already agrees with it:
there is no way to hurt another player, only to help
([Game Developer](https://www.gamedeveloper.com/design/using-emotion-to-drive-social-play-in-i-sky-children-of-the-light-i-)).
Guardrail: keep friendship levels **private to the pair**. A public friendship ranking
would breed exactly the exclusion dynamics this audience is nostalgic for *escaping*.

### 10. The Trophy Loft made real: a participation ladder, not a win ladder

Card-Jitsu's belt system is the genre's best long-horizon hook: nine belts, each needing
one more win than the last, a visible wearable rank, and a rite of passage where Sensei
beats you several times before letting you through
([Card-Jitsu Belts](https://clubpenguin.fandom.com/wiki/Card-Jitsu_Belts),
[Ninja Progress](https://clubpenguin.fandom.com/wiki/Ninja_Progress)). Capy Cove has the
room for it already built and named, The Trophy Loft with its Hall of Champions
(`CLAUDE.md`, `src/world/rooms/loft.js`), and it is currently decoration. **The hard
constraint** is `docs/AUDIT.md` F-18 and its verdict line: the server models none of the
den duel games and cannot tell a real result from a fabricated one, so a win-counting
ladder would be forged on day one. The version that survives: rank on **participation
and variety**, not wins, because those signals ride on server-side facts (a match was
started with a real second seat, it ran for a plausible duration, it ended by agreement)
rather than on a client-reported outcome. Scarves rather than belts, one per tier,
earned for playing N duels across M different den games against K distinct opponents,
with the top tier requiring a duel against someone you have never played before, which
turns the ladder into a mixing device instead of a farming device. Name every tier holder
on the Hall of Champions board in the loft, refreshed weekly and reprinted in the paper.
If and when the server does model chess and connect4 (audit item 48), a true win ladder
can be layered on top of the same scarves without re-authoring the fiction.

### Honourable mentions (real, just not top ten)

- **A performable instrument.** Webfishing's guitar is what its press coverage actually
  talks about ([Inverse](https://www.inverse.com/gaming/steam-webfishing-cozy-chatroom-game-animal-crossing)).
  Capy Cove synthesises all its own audio and the Groove Grotto runs a 126bpm clock that
  `DESIGN.md:151` already earmarks. A strummable ukulele others can hear, room-scoped,
  rate-limited, would be a scene generator. It is out of the top ten only because it is a
  new audio-net surface with a griefing profile that needs the T&S work done first.
- **Photo booth and postcards.** Parked at `DESIGN.md:152`. This is the growth loop
  rather than the retention loop: Sky is marketed almost entirely by its players'
  screenshots. A framed capy portrait with the current room behind it, sendable to a
  friend and hangable in a den as furniture, would tie the house, friends and festival
  systems together. Sequence after moderation, since it is an image-sharing surface.
- **Tour Guide.** Club Penguin let veterans wear a tour guide hat and gave them a job.
  For an audience of returning adults, "be the one who knows everything" is a strong
  motivator and a free onboarding workforce. Cheap: a hat, a quiz, a special chat colour.
- **A weekly errand (the Field-Op).** A one-per-week task that sends you to a named room
  to do something small, paying a **second currency** redeemable only for prestige gear
  ([Field-Ops](https://clubpenguin.fandom.com/wiki/Field-Op)). The second currency is the
  clean way to sell status without inflating coins. Overlaps heavily with #4, so ship
  the charm first and only add this if the charm proves the appetite.
- **Expression breadth.** More cosmetic slots (scarf, glasses, held item, companion) and
  saved outfits, which is a headline feature on Journey and the whole pitch of Ice
  Penguin. Genuinely under-served relative to what this audience does all day, and it
  makes every other cosmetic reward on this list worth more.

---

## 5. What NOT to take from the genre

- **Membership tiers that are visible.** See 1.10. The class divide is the thing the
  alumni resent, and reproducing it would be a self-inflicted wound.
- **Pet care decay, sadness, and runaway pets.** See 1.4. Absence must never be punished
  in a cozy game aimed at adults with jobs.
- **Authored solo missions.** The PSA/EPF missions are expensive to write, single-player,
  one-and-done, and tonally adventure-shaped. Every hour spent on one is an hour not
  spent on a system that generates content forever.
- **Armies, ranks, PvP combat.** The Club Penguin army scene is a real and durable
  subculture, but it is competitive, hierarchical and conflict-shaped, and it fails the
  scope test on the first clause.
- **Trading and player-to-player item markets.** The moment items are transferable at
  scale you have created scam, coercion and account-theft vectors, which is the worst
  possible thing to bolt onto a game whose T&S layer is still an open finding
  (`docs/AUDIT.md` F-21..24). Gifting with hard caps, yes. A market, no.
- **Anonymity rituals.** Sky's silhouette-until-lit meeting works because names are
  hidden. Capy Cove is name-first and has an existing profile-card culture; retrofitting
  concealment would break more than it creates.
- **Sixty-three rooms.** Breadth was Club Penguin's compensation for thin rooms. Capy
  Cove's rooms are dense and expensive. Deepen, do not widen.
- **Webfishing's crude humour.** Take the toys, not the tone. See 2.2.

---

## 6. A proposed cadence (what a month should look like)

The point of this section is that **the operator's calendar is the product**. If nobody
can run this in an hour a week it will not happen.

| Beat | Frequency | Operator effort | Automatable? |
| --- | --- | --- | --- |
| Weekly charm moved | Weekly | ~2 min (one table row) | Fully, if scheduled ahead |
| Cove Times issue | Weekly | ~20 min (one blurb + auto sections) | Mostly |
| Featured Dens | Fortnightly | ~15 min (pick 4 from nominations) | Partly |
| Consignment rotation | Fortnightly | 0 (scheduled table) | Fully |
| Festival | Monthly, 10-14 days | ~1 day up front, reusable forever | After first build |
| Visitor appearance | Monthly, tied to festival | 0 (scheduled bot) | Fully |
| Den contest results | Monthly | ~20 min | Partly |

That is well under two hours a week after the first build, and it produces a world that
has visibly changed every single time a player logs in. That, and not any single feature
above, is what Club Penguin actually had that Capy Cove does not.

---

## 7. Sequencing note

Nothing here should jump the queue ahead of the open launch blockers in
`docs/AUDIT.md` (trust and safety, data durability, economy anti-cheat, the admin
backdoor in `src/main.js`). Several items above are themselves new user-generated-content
surfaces (den nominations, gifting, postcards, the paper's letters column) and **must**
land after the moderation layer, not before. The items that are clean of that constraint
and can be built in parallel with launch work are, in order: **the consignment rotation
and consumables (#1)**, **the weekly charm (#4)**, **the Almanac (#6)** and **the
companion (#3)**. Those four alone would move the day-14 retention arithmetic more than
anything else currently on the roadmap.

---

## Sources

- [Club Penguin: List of Games](https://clubpenguin.fandom.com/wiki/List_of_Games)
- [All rooms in the history of Club Penguin (63)](https://cprewrittencheats.blogspot.com/p/main-rooms.html)
- [Club Penguin Journey wiki: Pin](https://clubpenguinjourney.fandom.com/wiki/Pin)
- [Club Penguin: Secret items](https://clubpenguin.fandom.com/wiki/Secret_items)
- [The Help Force: CP Journey August 2026 Penguin Style catalogue guide](https://cphelpforce.com/2026/08/cp-journey-august-2026-penguin-style-catalogue-guide/)
- [Club Penguin: Aunt Arctic](https://clubpenguin.fandom.com/wiki/Aunt_Arctic)
- [Club Penguin Wiki (independent): Puffle](https://www.clubpenguinwiki.info/wiki/Puffle)
- [Club Penguin Wiki (independent): Puffle Digging](https://www.clubpenguinwiki.info/wiki/Puffle_Digging)
- [Club Penguin: Igloo Contests](https://clubpenguin.fandom.com/wiki/Igloo_Contests)
- [Club Penguin Journey: Featured Igloos](https://clubpenguinjourney.fandom.com/wiki/Featured_Igloos)
- [Club Penguin: Parties](https://clubpenguin.fandom.com/wiki/Parties)
- [List of Parties and Events in 2010](https://clubpenguin.fandom.com/wiki/List_of_Parties_and_Events_in_2010)
- [List of Parties and Events in 2011](https://clubpenguin.fandom.com/wiki/List_of_Parties_and_Events_in_2011)
- [Club Penguin: List of Characters](https://clubpenguin.fandom.com/wiki/List_of_Characters_in_Club_Penguin)
- [Club Penguin: Rockhopper](https://clubpenguin.fandom.com/wiki/Rockhopper)
- [Army of CP: Club Penguin Journey 1,000,000 Penguins Celebration Guide](https://thearmyofcp.com/2026/07/15/club-penguin-journey-1000000-penguins-celebration-guide/)
- [Club Penguin: Field-Op](https://clubpenguin.fandom.com/wiki/Field-Op)
- [Club Penguin: Card-Jitsu Belts](https://clubpenguin.fandom.com/wiki/Card-Jitsu_Belts)
- [Club Penguin: Ninja Progress](https://clubpenguin.fandom.com/wiki/Ninja_Progress)
- [Club Penguin Journey: Stamps](https://clubpenguinjourney.fandom.com/wiki/Stamps)
- [Club Penguin: Membership](https://clubpenguin.fandom.com/wiki/Membership)
- [HowStuffWorks: How Club Penguin Works](https://computer.howstuffworks.com/internet/social-networking/networks/club-penguin.htm)
- [Club Penguin Journey: features](https://www.cpjourney.net/features)
- [Club Penguin Journey wiki](https://clubpenguinjourney.fandom.com/wiki/Club_Penguin_Journey)
- [Club Penguin Journey: One Million Penguins](https://cpjourney.net/news/2026/07/one-million-penguins-one-incredible-journey-3101)
- [Club Penguin Journey: Monday Games Updates](https://cpjourney.net/news/2026/01/monday-games-updates-2386)
- [Wikipedia: Club Penguin Rewritten](https://en.wikipedia.org/wiki/Club_Penguin_Rewritten)
- [Sportskeeda: Club Penguin Legacy shuts down after Disney's demands](https://sportskeeda.com/pop-culture/news-short-life-sudden-demise-club-penguin-legacy-shuts-disney-s-demands-sparks-outrage-online)
- [AlternativeTo: Ice Penguin](https://alternativeto.net/software/ice-penguin/about)
- [Steam: WEBFISHING](https://store.steampowered.com/app/3146520/WEBFISHING/)
- [PC Gamer: an adorable, cozy little multiplayer chatroom fishing game](https://www.pcgamer.com/games/heres-an-adorable-cozy-little-multiplayer-chatroom-fishing-game/)
- [MMORPG.com: Webfishing is peak multiplayer](https://www.mmorpg.com/editorials/perhaps-webfishing-the-bite-sized-lobby-based-cozy-fishing-game-is-peak-multiplayer-2000133319)
- [Inverse: Steam quietly released the most bizarre cozy game of the year](https://www.inverse.com/gaming/steam-webfishing-cozy-chatroom-game-animal-crossing)
- [Game Developer: Using emotion to drive social play in Sky: Children of the Light](https://www.gamedeveloper.com/design/using-emotion-to-drive-social-play-in-i-sky-children-of-the-light-i-)
- [Sky wiki: Making Friends](https://sky-children-of-the-light.fandom.com/wiki/Making_Friends)
- [thatgamecompany help centre: Seasonal Candles](https://thatgamecompany.helpshift.com/hc/en/17-sky-children-of-the-light/faq/519-what-are-seasonal-candles-and-how-do-i-obtain-them/)
- [PC Gamer: Sky seasonal candle locations](https://www.pcgamer.com/games/mmo/sky-children-of-the-light-seasonal-candles-locations/)
- [ACM CHI PLAY: Understanding Player Retention Strategies in Animal Crossing: New Horizons](https://dl.acm.org/doi/fullHtml/10.1145/3450337.3483483)
- [ACM SIGDOC: Essential Escapism through Progress Simulation: ACNH's Temporal Design](https://dl.acm.org/doi/10.1145/3641237.3691689)
- [NuMuki: Club Penguin Rewritten Mascot Tracker](https://www.numuki.com/blog/club-penguin-rewritten-mascot-tracker/)
