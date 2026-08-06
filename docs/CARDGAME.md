# Capy Clash: card duel design spec

The Game Den's flagship: a 1v1 capybara card duel. Element-triangle flavor in
the Card-Jitsu tradition, but with real resource, tempo and trading decisions
in the Magic/Yu-Gi-Oh direction. This is the authoritative rules + content
spec; the implementation must match it exactly unless a rule is unplayable in
practice (note deviations in code comments).

## 1. Overview

- Two capybaras duel: the player vs a named AI capybara (PvP later).
- Each starts at **25 HP**. Reduce the opponent to 0 to win.
- Same 20-card starter deck for both sides (shuffled independently) in v1;
  collectible cards and deck-building are future work.
- A duel lasts 5-10 minutes. Coins: **win 70 + (your remaining HP)/2, loss 10
  consolation if you got the opponent under 10 HP, else 5** (server cap via
  MINIGAMES 'cards', maxCoinsPerRun 100). Score reported = damage dealt +
  50 bonus on a win (bests ladder).

## 2. Board and zones

- Each side: **4 critter slots** in a row, a **deck** (face down, count shown),
  a **hand** (player's fan at the bottom, AI's shown as card backs), HP dial
  on a capy portrait (the player's own avatar colors; AI uses its bot look).
- Energy gems along each side's edge (filled/empty pips).

## 3. Resources and turn flow

- **Energy**: max energy starts at 1 and grows +1 each of your turns (cap 8);
  energy refills to max at your turn start. Cards cost energy.
- **Turn order**: player always goes first; the AI draws a bonus card at the
  duel start (second-player compensation).
- **Turn sequence**: draw 1 (start hand 4, hand cap 8, overdraw burns) ->
  energy refills -> play any number of affordable cards -> attack with ready
  critters (any order, each attacks once) -> End Turn button.
- **Summoning rest**: critters cannot attack the turn they arrive (exception:
  keyword Swift). They CAN block from the moment they land (Guard).

## 4. Combat

- An attacking critter chooses a target: an enemy critter, or the enemy capy
  ("face") IF no enemy critter has **Guard**.
- Critter vs critter: they deal their attack to each other simultaneously.
  Dead critters (health <= 0) wash away. Damage on survivors persists.
- **Element triangle**: Sun > Snow > Sea > Sun. An attacker (critter OR spell
  where noted) with the advantaged element deals **+2 damage** to a
  disadvantaged-element target. Show the bonus visually (arrow flash) every
  time so the triangle teaches itself. Neutral has no bonuses either way.

## 5. Keywords (exactly these five in v1)

- **Guard**: enemies must attack your Guard critters before your face.
- **Swift**: may attack the turn it is played.
- **Soak N**: when played, your capy heals N HP.
- **Splashproof**: cannot be targeted by spells (yours or theirs).
- **Last Splash: <effect>**: triggers when this critter dies.

## 6. Card pool v1 (starter deck = the 20 cards marked x1/x2)

Critters: "cost | element | atk/hp | keywords" (name flavor: cozy, silly).

| Card | Cost | El | Stats | Keywords | Deck |
| --- | --- | --- | --- | --- | --- |
| Pebble Pal | 0 | Neutral | 0/2 | Guard | x1 |
| Sunny Pup | 1 | Sun | 2/1 | - | x2 |
| Puddle Sitter | 1 | Sea | 1/3 | Guard | x2 |
| Snow Nibbler | 1 | Snow | 2/1 | Swift | x1 |
| Beach Bum | 2 | Sun | 2/3 | Soak 2 | x2 |
| Surf Scout | 2 | Sea | 3/2 | - | x2 |
| Frost Friend | 2 | Snow | 1/4 | Guard | x1 |
| Ray Ray | 3 | Sun | 4/2 | - | x1 |
| Wave Rider | 3 | Sea | 3/3 | Swift | x1 |
| Cocoa Courier | 3 | Snow | 2/4 | Last Splash: draw 1 | x1 |
| Tide Elder | 4 | Sea | 3/6 | Guard | x1 |
| Blizzard Buddy | 4 | Snow | 5/4 | - | x1 |
| Solar Elder | 5 | Sun | 5/6 | Guard | x1 |
| Great Ancient Capy | 7 | Neutral | 8/8 | Splashproof | x1 |

Spells (element matters for the triangle bonus vs critter targets):

| Card | Cost | El | Effect | Deck |
| --- | --- | --- | --- | --- |
| Splash! | 1 | Sea | 2 damage to any critter (triangle applies) | x1 |
| Zoomies | 1 | Neutral | A friendly critter gets +2 atk this turn | x1 |
| Sunburst | 2 | Sun | 3 damage to any critter (triangle applies) | x1 |
| Cozy Cocoa | 2 | Snow | Heal your capy 5 | x1 |
| Snack Cart | 3 | Neutral | Draw 2 | x1 |
| Flurry | 4 | Snow | 1 damage to ALL enemy critters (triangle applies) | x1 |

Balance intent: curve peaks at 2, Guards gate aggression, the triangle makes
"which critter trades into which" the core skill, Great Ancient Capy is the
finisher you build toward. Keep numbers EXACT; balance patches happen in this
file first.

## 7. AI opponent

Named bot capybara (pick from the server bot name pool style: "Grandmaster
Pebble"), five expression states like the smoothie customers (thinking, smug,
worried, hurt, beaten). Heuristic AI, in strict order:

1. Lethal check: if any attack + spell sequence kills the player this turn,
   do it.
2. Removal value: use damage spells only when they kill a critter (or hit
   face for lethal), preferring triangle-boosted casts.
3. Trades: attack enemy critters when the exchange is favorable (they die,
   yours survives, or trading up in cost); otherwise hit face when safe
   (no Guard).
4. Curve: play the highest-cost affordable critter(s); play Soak/heal when
   under 12 HP; hold Zoomies for a trade that needs it.
5. Small deliberate pause (600-1200ms) between AI actions with the card
   visibly played so the player can follow; never instant multi-actions.

## 8. Presentation (match DESIGN.md)

- 2D DOM/canvas scene like Smoothie Scramble: wooden den table, felt board,
  cards are canvas-drawn (element color frame, chunky capy critter portrait
  drawn procedurally from the avatar art language: round body, boxy muzzle,
  element props: sunglasses/surfboard/scarf, stats in fat circles).
- Play a card: click in hand then click a slot (or drag); attack: click your
  critter then the target; targets pulse when a selection is pending. All
  interactive elements have hover states and the standard sfx.
- Damage numbers float, triangle bonus flashes the element arrow, death is a
  soft splash-poof. End: results card (win/loss, damage dealt, coins, best)
  with Play again / Back to the den.
- Teach in the splash screen with three panels: 1 energy & playing critters,
  2 attacking & Guard, 3 the element triangle. Skippable.

## 9. Future (do not build yet)

PvP duels over the race-lobby pattern; card collection + shop packs; ranked
ladder; a fourth element. Design space is reserved: keep element/keyword enums
extensible.
