// Shared between client and server. Keep dependency-free (no three, no DOM, no node APIs).

export const GAME_NAME = 'Capy Cove';

export const ROOM_IDS = ['plaza', 'beach', 'peak', 'cafe', 'club', 'lounge', 'loft', 'mine', 'jungle', 'drift', 'speedway'];
export const DEFAULT_ROOM = 'plaza';

export const ROOM_INFO = {
  plaza: { name: 'Sunny Plaza', desc: 'The heart of the cove' },
  beach: { name: 'Driftwood Beach', desc: 'Sand, surf and fishing' },
  peak: { name: 'Frosty Peak', desc: 'Snow, sleds and cocoa' },
  cafe: { name: 'The Smoothie Shack', desc: 'Blend it like you mean it' },
  club: { name: 'Groove Grotto', desc: 'Underground dance cave' },
  lounge: { name: 'The Game Den', desc: 'Tables, tussles and hot cocoa' },
  loft: { name: 'The Trophy Loft', desc: 'Upstairs at the den: fireside, chess and cards' },
  mine: { name: 'The Glimmer Mine', desc: 'Coins in the walls, hiders in the props' },
  jungle: { name: 'The Tangle Jungle', desc: 'Vines, ruins and doodles' },
  drift: { name: 'The Drift', desc: 'Deep water, soft light, one very big friend' },
  speedway: { name: 'Capy Speedway', desc: 'Six karts, three laps, one very smug capybara' },
};
// NOTE: 'drift' deliberately has NO BOT_ZONES entry: citizens do not dive.

// Minigames: id -> reward formula. Server clamps client-reported scores with these.
// minRunMs / minMatchMs / minMoves are FLOORS, not typical play: the shortest a
// run or duel can possibly be, with margin under it (wave 11; a typical run is
// 5-15x longer). server/econ.js falls back to its own copy for any row that
// lacks them. They reject IMPOSSIBLE claims only - never cap honest play.
export const MINIGAMES = {
  fishing: { name: 'Reel Rush', room: 'beach', maxCoinsPerRun: 120, minRunMs: 6_000 },
  // 210: sled v2's trick/shortcut scoring lets an expert 115s run reach ~202
  // coins honestly (measured headlessly); the old 150 was truncating elite
  // honest play, which the owner's law forbids. Casual runs are unchanged.
  sled: { name: 'Summit Sprint', room: 'peak', maxCoinsPerRun: 210, minRunMs: 5_000 },
  smoothie: { name: 'Smoothie Scramble', room: 'cafe', maxCoinsPerRun: 130, minRunMs: 6_000 },
  pong: { name: 'Paddle Panic', room: 'lounge', maxCoinsPerRun: 60, minRunMs: 8_000, minMatchMs: 6_000, minMoves: 8 },
  shuffle: { name: 'Shuffle Showdown', room: 'lounge', maxCoinsPerRun: 70, minRunMs: 10_000, minMatchMs: 10_000, minMoves: 3 },
  // chess and cards are upstairs in the Trophy Loft; the server reads `room`
  // to decide which room a table may be joined from (see TABLE_GAMES), and
  // server/econ.js reads the same field to bind a run token to a room.
  // chess minMoves is 2: fool's mate is a real two-move win.
  chess: { name: 'Grand Capy Chess', room: 'loft', maxCoinsPerRun: 100, minRunMs: 6_000, minMatchMs: 6_000, minMoves: 2 },
  connect4: { name: 'Four in a Row', room: 'lounge', maxCoinsPerRun: 60, minRunMs: 5_000, minMatchMs: 5_000, minMoves: 3 },
  cards: { name: 'Capy Clash', room: 'loft', maxCoinsPerRun: 100, minRunMs: 12_000, minMatchMs: 12_000, minMoves: 4 },
  prophunt: { name: 'Prop Hunt', room: 'mine', maxCoinsPerRun: 90, minRunMs: 9_000 },
  // honest kart max is 152 (placement + laps + fastest lap + boxes), so 160
  // never truncates honest play; three validated laps cannot beat ~40s
  kart: { name: 'Capy Karts', room: 'speedway', maxCoinsPerRun: 160, minRunMs: 40_000 },
  doodle: { name: 'Capy Doodles', room: 'jungle', maxCoinsPerRun: 90, minRunMs: 10_000 },
};

// Hat catalog. Client renders these procedurally (src/player/hats.js must have a
// builder for every id here). Server uses ids + prices for the shop.
export const HATS = {
  none: { name: 'No Hat', price: 0 },
  beanie: { name: 'Cozy Beanie', price: 50 },
  cap: { name: 'Snapback Cap', price: 80 },
  flower: { name: 'Sun Flower', price: 120 },
  tophat: { name: 'Fancy Top Hat', price: 250 },
  viking: { name: 'Viking Helm', price: 400 },
  crown: { name: 'Royal Crown', price: 800 },
  propeller: { name: 'Propeller Cap', price: 300 },
  chef: { name: 'Chef Toque', price: 150 },
  pirate: { name: 'Pirate Tricorn', price: 350 },
  // Milestone rewards (see MILESTONES): earned from the stamp album, never
  // bought. price 0 is a placeholder, NOT a free hat: the shop must hide every
  // entry flagged `milestone: true` from the buy list, and server/progress.js is
  // the only thing that ever puts one in ownedHats.
  snorkel: { name: 'Diver Snorkel', price: 0, milestone: true },
  golden_pick: { name: 'Golden Pickaxe', price: 0, milestone: true },
};

// Walk trails and idle auras: the flourish slot. One worn at a time (a trail OR
// an aura), synced like hats so everyone sees everyone's. The RECIPES (what each
// one actually looks like) live in src/player/trails.js keyed by these same ids,
// exactly as HATS relates to the avatar: prices here, art there, and neither
// file imports the other.
export const TRAILS = {
  none: { name: 'No Trail', price: 0 },
  petals: { name: 'Petal Path', price: 200 },
  sparkles: { name: 'Paw Sparkles', price: 300 },
  glowring: { name: 'Soft Glow Ring', price: 350, aura: true },
  notes: { name: 'Tiny Tunes', price: 450 },
  bubbles: { name: 'Bubble Drift', price: 550 },
  snow: { name: 'Snow Glitter', price: 700 },
  stardrift: { name: 'Drifting Stars', price: 800, aura: true },
  fireflies: { name: 'Firefly Wisp', price: 950 },
  leaves: { name: 'Leaf Flurry', price: 1100 },
  embers: { name: 'Cocoa Embers', price: 1300 },
  butterflies: { name: 'Butterfly Friends', price: 1500, aura: true },
  stars: { name: 'Starfall', price: 1700 },
  rainbow: { name: 'Rainbow Ribbon', price: 2000 },
  // Milestone rewards (see MILESTONES): earned from the stamp album, never
  // bought. Same rule as the milestone hats: price 0 is a placeholder, the shop
  // hides every `milestone: true` entry and the server refuses to sell one.
  tidewake: { name: 'Tide Wake', price: 0, milestone: true },
  goldpaw: { name: 'Golden Pawprints', price: 0, milestone: true },
};

// Avatar body colors offered at signup / wardrobe.
export const BODY_COLORS = [
  0xb08a5a, 0x8a6642, 0xc9a06b, 0x6b4f35, // natural capy browns
  0xe8657a, 0xf2a541, 0x7ac74f, 0x4fb3e8, 0x9b6bd4, 0x42d6c8, // fun dyes
];

// Guaranteed-walkable flat zones per room (circle: x, z, r). Room builders MUST
// keep these areas as plain walkable ground: spawns and server bots rely on them.
export const BOT_ZONES = {
  plaza: { x: 0, z: 5, r: 5 },
  beach: { x: 0, z: 2, r: 5 },
  peak: { x: 0, z: 5, r: 4.5 },
  cafe: { x: 0, z: 2, r: 4 },
  club: { x: 0, z: 2, r: 4.5 },
  lounge: { x: 0, z: 2, r: 4 },
  // the loft's open middle, between the two duel tables and north of the
  // stairwell mouth (z 3.8): plain planks, no rug edge, no collider
  loft: { x: 0, z: 0.6, r: 2.6 },
  // south of the Prop Hunt lobby deck: the old (0, 3, 4) circle covered the
  // deck's northern half, so blind bots wandered onto the join pads and read
  // as capys who had signed up for a hunt they were not in
  mine: { x: 1, z: 5.8, r: 3 },
  jungle: { x: 0, z: 3, r: 4.5 },
  speedway: { x: 0, z: 3, r: 4.5 },
};

// Furniture catalog for player houses. Client builders live in
// src/world/furniture.js and must cover every id here.
export const FURNITURE = {
  sofa: { name: 'Squashy Sofa', price: 250 },
  armchair: { name: 'Snug Armchair', price: 150 },
  beanbag: { name: 'Nap Beanbag', price: 80 },
  rug_round: { name: 'Round Rug', price: 60 },
  rug_stripe: { name: 'Stripy Rug', price: 60 },
  low_table: { name: 'Low Table', price: 100 },
  dining_set: { name: 'Dining Set', price: 220 },
  bed: { name: 'Dreamy Bed', price: 300 },
  bookshelf: { name: 'Bookshelf', price: 180 },
  floor_lamp: { name: 'Floor Lamp', price: 90 },
  string_lights: { name: 'String Lights', price: 70 },
  plant_palm: { name: 'Potted Palm', price: 60 },
  plant_flower: { name: 'Flower Pot', price: 40 },
  fireplace: { name: 'Cozy Fireplace', price: 500 },
  aquarium: { name: 'Bubbly Aquarium', price: 400 },
  arcade_cab: { name: 'Mini Arcade', price: 600 },
  trophy_case: { name: 'Trophy Case', price: 350 },
  wall_surfboard: { name: 'Wall Surfboard', price: 120 },
  capy_portrait: { name: 'Capy Portrait', price: 100 },
  cocoa_station: { name: 'Cocoa Station', price: 280 },
  // Milestone reward (see MILESTONES): same rule as the milestone hats, the
  // Furniture tab must hide anything flagged `milestone: true`.
  gramophone: { name: 'Whale-Song Gramophone', price: 0, milestone: true },
};

export const HOUSE_MAX_ITEMS = 60;
export const HOUSE_ACCESS_MODES = ['open', 'friends', 'invite'];

export const CHAT_MAX_LEN = 120;
export const NAME_MIN_LEN = 3;
export const NAME_MAX_LEN = 16;

// Wave 9: the role ladder as contract data. server/db.js validates storage
// against it, server/admin.js maps roles to capabilities, the client only ever
// echoes what the wire said.
export const ROLES = ['player', 'mod', 'admin'];
export const CAPS = ['who', 'inspect', 'mute', 'kick', 'ban', 'ban-perm', 'unban', 'tp', 'announce', 'editor', 'events', 'role', 'staffchat'];
export const ANNOUNCE_MAX_LEN = 160;

export const NET_TICK_MS = 100; // server broadcast + send cadence
export const WALK_SPEED = 5.2; // units/sec, shared so server bots match players

// ---------------------------------------------------------------------------
// Progression: daily quests, stamp album, milestone track (wave 7, section D of
// docs/LIVING-COVE.md). Pure data: all of the logic lives in server/progress.js,
// which is the ONLY thing allowed to decide that a quest or stamp is earned.
// The client reads these tables for names/descriptions and nothing else.
// ---------------------------------------------------------------------------

/**
 * Daily quest pool. The server picks 3 per account per cove-day (seeded, so a
 * reconnect never rerolls the board), weighted to include at least one `social`
 * and at least one `minigame` quest.
 *
 * Fields:
 *  - id/name/desc : identity + board copy
 *  - signal       : the server-side progression signal that advances it (see the
 *                   contract at the top of server/progress.js). A quest can only
 *                   ever be advanced by a signal one of the hardened handlers in
 *                   server/index.js already accepted: nothing here is claimable
 *                   by the client.
 *  - count        : how many matching signals finish it
 *  - coins        : payout (30-60; all three in a day pays a further +50)
 *  - kind         : 'minigame' | 'social' | 'world' (drives the daily weighting)
 * Optional filters, all matched against the signal's data payload:
 *  - game         : data.game must equal this
 *  - minCoins     : data.coins must reach this (server-clamped payout, so a
 *                   "big run" quest cannot be faked by a client-reported score)
 *  - place        : data.placed must be this or better (1 = won it)
 *  - riders       : data.riders must reach this
 *  - room         : data.room must equal this
 *  - flag         : that field of the payload must be truthy (e.g. 'gem')
 *  - distinct     : count DIFFERENT payload values instead of repeats
 */
export const QUESTS = [
  // --- minigames -----------------------------------------------------------
  { id: 'q_fish', name: 'Gone Fishing', desc: 'Bank 40+ coins in one Reel Rush run.', signal: 'score', game: 'fishing', minCoins: 40, count: 1, coins: 45, kind: 'minigame' },
  { id: 'q_sled', name: 'Downhill Dash', desc: 'Take a run down Summit Sprint.', signal: 'score', game: 'sled', count: 1, coins: 35, kind: 'minigame' },
  { id: 'q_smoothie', name: 'Blend It Well', desc: 'Bank 50+ coins in one Smoothie Scramble shift.', signal: 'score', game: 'smoothie', minCoins: 50, count: 1, coins: 45, kind: 'minigame' },
  { id: 'q_three_runs', name: 'Triple Feature', desc: 'Play three minigame runs today.', signal: 'score', count: 3, coins: 50, kind: 'minigame' },
  { id: 'q_hunt', name: 'Prop Shop', desc: 'Play a round of Prop Hunt in the mine.', signal: 'score', game: 'prophunt', count: 1, coins: 40, kind: 'minigame' },
  { id: 'q_match', name: 'Take a Seat', desc: 'Win any duel at the Game Den.', signal: 'match-win', count: 1, coins: 50, kind: 'minigame' },
  { id: 'q_pong', name: 'Paddle Up', desc: 'Win a round of Paddle Panic.', signal: 'match-win', game: 'pong', count: 1, coins: 40, kind: 'minigame' },
  { id: 'q_chess', name: 'Mind Games', desc: 'Win a game of Grand Capy Chess.', signal: 'match-win', game: 'chess', count: 1, coins: 60, kind: 'minigame' },
  { id: 'q_cards', name: 'Clash Day', desc: 'Win a Capy Clash duel.', signal: 'match-win', game: 'cards', count: 1, coins: 55, kind: 'minigame' },
  { id: 'q_connect4', name: 'Four Up', desc: 'Win a game of Four in a Row.', signal: 'match-win', game: 'connect4', count: 1, coins: 40, kind: 'minigame' },
  { id: 'q_shuffle', name: 'Slide On', desc: 'Win a round of Shuffle Showdown.', signal: 'match-win', game: 'shuffle', count: 1, coins: 40, kind: 'minigame' },
  { id: 'q_race', name: 'Three Sleds', desc: 'Finish a three-capy sled race.', signal: 'race-done', count: 1, coins: 40, kind: 'minigame' },
  { id: 'q_race_win', name: 'First Down', desc: 'Come first in a sled race.', signal: 'race-done', place: 1, count: 1, coins: 60, kind: 'minigame' },
  { id: 'q_doodle', name: 'Good Guess', desc: 'Guess three doodles right in the jungle.', signal: 'doodle-correct', count: 3, coins: 45, kind: 'minigame' },
  // --- social --------------------------------------------------------------
  { id: 'q_party_go', name: 'Crash the Party', desc: "Turn up at somebody else's party.", signal: 'party-attend', count: 1, coins: 50, kind: 'social' },
  { id: 'q_party_host', name: 'Your Place', desc: 'Throw a party of your own.', signal: 'party-host', count: 1, coins: 60, kind: 'social' },
  { id: 'q_mural', name: 'Three Dabs', desc: 'Add three pixels to the plaza mural.', signal: 'mural-pixel', count: 3, coins: 40, kind: 'social' },
  { id: 'q_chat', name: 'Say Hello', desc: 'Chat five times with the cove.', signal: 'chat', count: 5, coins: 30, kind: 'social' },
  { id: 'q_wave', name: 'Friendly Paw', desc: 'Wave at the cove three times.', signal: 'wave', count: 3, coins: 30, kind: 'social' },
  { id: 'q_ball', name: 'Keep It Up', desc: 'Bop the beach ball ten times.', signal: 'ball', count: 10, coins: 40, kind: 'social' },
  { id: 'q_snow', name: 'Snowball Season', desc: 'Land five snowballs on the peak.', signal: 'snow', count: 5, coins: 40, kind: 'social' },
  { id: 'q_bonfire', name: 'Warm Circle', desc: 'Settle in by the beach bonfire after dusk.', signal: 'bonfire', count: 1, coins: 35, kind: 'social' },
  { id: 'q_pod', name: 'Buddy System', desc: 'Ride Big Blue with another capy aboard.', signal: 'whale-ride', riders: 2, count: 1, coins: 55, kind: 'social' },
  // --- world ---------------------------------------------------------------
  { id: 'q_tour', name: 'Grand Tour', desc: 'Visit five different corners of the cove.', signal: 'room', distinct: true, count: 5, coins: 40, kind: 'world' },
  { id: 'q_drift', name: 'Down the Bell', desc: 'Take the dive bell down to The Drift.', signal: 'room', room: 'drift', count: 1, coins: 30, kind: 'world' },
  { id: 'q_dig', name: 'Pick Away', desc: 'Prospect ten times in the Glimmer Mine.', signal: 'dig', count: 10, coins: 35, kind: 'world' },
  { id: 'q_gem', name: 'Glitter Strike', desc: 'Strike a gem in the mine.', signal: 'dig', flag: 'gem', count: 1, coins: 60, kind: 'world' },
  { id: 'q_bottle', name: 'Message Received', desc: 'Find the bottle drifting in the deep.', signal: 'bottle', count: 1, coins: 60, kind: 'world' },
];

/**
 * The stamp album: authored feats, not grind. `how` is the requirement line the
 * album prints under the (procedural) stamp art; `desc` is the flavour. The
 * award rules live in server/progress.js keyed by these ids, and every stamp is
 * idempotent: it can only ever be earned once, per account, from server signals.
 *
 * There are deliberately more than 40 of these so the 40-stamp "Legend of the
 * Cove" milestone does not require literally every single one (a few depend on
 * other players showing up, which no solo player can force).
 */
export const STAMPS = [
  // --- getting around ------------------------------------------------------
  { id: 'first_hello', name: 'First Hello', desc: 'Every friendship starts somewhere.', how: 'Say something in chat' },
  { id: 'explorer', name: 'Explorer', desc: 'You had a look around.', how: 'Visit five different rooms' },
  { id: 'globetrotter', name: 'Globetrotter', desc: 'No corner left unvisited.', how: 'Visit every room in the cove' },
  { id: 'regular', name: 'Regular', desc: 'The cove knows your face.', how: 'Play on seven different days' },
  { id: 'veteran', name: 'Cove Veteran', desc: 'Practically staff at this point.', how: 'Play on thirty different days' },
  { id: 'night_owl', name: 'Night Owl', desc: 'Green ribbons over Frosty Peak.', how: 'Watch the aurora from the peak' },
  // --- the drift -----------------------------------------------------------
  { id: 'deep_breath', name: 'Deep Breath', desc: 'You just kept swimming.', how: 'Spend ten minutes in The Drift' },
  { id: 'whale_rider', name: 'Whale Rider', desc: 'She did not seem to mind.', how: 'Ride Big Blue' },
  { id: 'pod', name: 'Pod', desc: 'Best group photo in the game.', how: 'Ride Big Blue with three others aboard' },
  { id: 'bottler', name: 'Bottled Note', desc: 'Somebody wrote to nobody.', how: 'Find a message in a bottle' },
  { id: 'beachcomber', name: 'Beachcomber', desc: 'You know where they wash up.', how: 'Find three messages in bottles' },
  // --- minigames -----------------------------------------------------------
  { id: 'angler', name: 'Angler', desc: 'The rod finally behaved.', how: 'Bank 40+ coins in one Reel Rush run' },
  { id: 'reel_master', name: 'Reel Master', desc: 'The fish have filed a complaint.', how: 'Bank 90+ coins in one Reel Rush run' },
  { id: 'downhill', name: 'Downhill', desc: 'Snow in the whiskers.', how: 'Finish a Summit Sprint run' },
  { id: 'speed_demon', name: 'Speed Demon', desc: 'Steering is optional.', how: 'Bank 100+ coins in one Summit Sprint run' },
  { id: 'barista', name: 'Barista', desc: 'Blend it like you mean it.', how: 'Bank 60+ coins in one Smoothie Scramble shift' },
  { id: 'shift_lead', name: 'Shift Lead', desc: 'The blender fears you.', how: 'Work ten Smoothie Scramble shifts' },
  { id: 'all_rounder', name: 'All Rounder', desc: 'A bit of everything.', how: 'Play fifty minigame runs' },
  { id: 'racer', name: 'On Your Marks', desc: 'Three sleds, one hill.', how: 'Finish a sled race' },
  { id: 'photo_finish', name: 'Photo Finish', desc: 'By a whisker.', how: 'Win a sled race' },
  { id: 'hat_trick', name: 'Hat Trick', desc: 'The hill belongs to you.', how: 'Win three sled races' },
  { id: 'hider', name: 'Sneaky Prop', desc: 'That barrel was not there before.', how: 'Play three rounds of Prop Hunt' },
  { id: 'doodler', name: 'Doodler', desc: 'You saw it before the last line.', how: 'Guess ten doodles right' },
  { id: 'prospector', name: 'Prospector', desc: 'Patience and a pickaxe.', how: 'Prospect twenty-five times in the mine' },
  { id: 'gem_hunter', name: 'Gem Hunter', desc: 'That glitter was real.', how: 'Strike a gem in the mine' },
  { id: 'motherlode', name: 'Motherlode', desc: 'The wall keeps giving.', how: 'Strike five gems in the mine' },
  // --- the game den --------------------------------------------------------
  { id: 'duelist', name: 'Duelist', desc: 'First blood, cosily.', how: 'Win a duel at the Game Den' },
  { id: 'sweep', name: 'Sweep', desc: 'Not a single point conceded.', how: 'Win a den duel without dropping a point' },
  { id: 'grandmaster', name: 'Grandmaster', desc: 'Four moves ahead.', how: 'Win a game of Grand Capy Chess' },
  { id: 'card_shark', name: 'Card Shark', desc: 'The deck likes you.', how: 'Win five Capy Clash duels' },
  { id: 'paddle_pro', name: 'Paddle Pro', desc: 'Reflexes of a very calm rodent.', how: 'Win five rounds of Paddle Panic' },
  { id: 'four_up', name: 'Four Up', desc: 'Diagonals count.', how: 'Win a game of Four in a Row' },
  { id: 'shuffler', name: 'Shuffler', desc: 'Just the right nudge.', how: 'Win a round of Shuffle Showdown' },
  { id: 'den_regular', name: 'Den Regular', desc: 'Your stool has a dent in it.', how: 'Win ten duels at the Game Den' },
  // --- the social cove -----------------------------------------------------
  { id: 'first_dab', name: 'First Dab', desc: 'One pixel, forever.', how: 'Paint your first mural pixel' },
  { id: 'muralist', name: 'Muralist', desc: 'You can see your bit from here.', how: 'Paint fifty mural pixels' },
  { id: 'cove_painter', name: 'Cove Painter', desc: 'The wall is basically yours.', how: 'Paint two hundred and fifty mural pixels' },
  { id: 'party_planner', name: 'Party Planner', desc: 'You sent the invite.', how: 'Throw a party' },
  { id: 'host_most', name: 'Host With the Most', desc: 'Standing room only.', how: 'Get five capys to your party' },
  { id: 'party_animal', name: 'Party Animal', desc: 'You heard the music.', how: 'Turn up at three parties' },
  { id: 'socialite', name: 'Socialite', desc: 'That paw never stops.', how: 'Wave twenty-five times' },
  { id: 'chatterbox', name: 'Chatterbox', desc: 'Never short of a word.', how: 'Send a hundred chat messages' },
  { id: 'snow_fight', name: 'Snow Fight', desc: 'Direct hit, no hard feelings.', how: 'Land twenty-five snowballs' },
  { id: 'volley', name: 'Volley', desc: 'Nobody agreed on the rules.', how: 'Bop the beach ball fifty times' },
  { id: 'toasty', name: 'Toasty', desc: 'Warm paws, quiet talk.', how: 'Spend ten minutes at the bonfire' },
  // --- the long game -------------------------------------------------------
  { id: 'quester', name: 'Quester', desc: 'The board had a job for you.', how: 'Finish a daily quest' },
  { id: 'clean_sweep', name: 'Clean Sweep', desc: 'All three, no leftovers.', how: 'Finish all three dailies in one day' },
  { id: 'devoted', name: 'Devoted', desc: 'A habit, at this point.', how: 'Finish all three dailies on five days' },
  { id: 'collector', name: 'Collector', desc: 'A hat for every mood.', how: 'Own five hats' },
  { id: 'decorator', name: 'Decorator', desc: 'The den is coming along.', how: 'Place ten pieces of furniture in your den' },
];

/**
 * Total-stamp milestones. These cosmetics are NOT buyable at any price: that is
 * the whole point, they are visible proof of play. server/progress.js grants
 * them (hats -> ownedHats, furniture -> ownedFurniture, color -> unlockedColors,
 * title -> rec.title) and pushes the album so the UI can celebrate.
 */
// `stamps` is the threshold and `reward` is the grant; `name`/`kind` are
// repeated at the top level because the album's milestone bar (src/ui/profile.js)
// reads them from there.
export const MILESTONES = [
  { stamps: 5, name: 'Diver Snorkel', kind: 'hat', reward: { type: 'hat', id: 'snorkel', name: 'Diver Snorkel' } },
  { stamps: 12, name: 'Aurora dye', kind: 'color', reward: { type: 'color', id: 0x7ff0d0, name: 'Aurora Dye' } },
  { stamps: 20, name: 'Whale-song gramophone', kind: 'furniture', reward: { type: 'furniture', id: 'gramophone', name: 'Whale-Song Gramophone' } },
  { stamps: 25, name: 'Tide Wake trail', kind: 'trail', reward: { type: 'trail', id: 'tidewake', name: 'Tide Wake' } },
  { stamps: 30, name: 'Golden pickaxe', kind: 'hat', reward: { type: 'hat', id: 'golden_pick', name: 'Golden Pickaxe' } },
  { stamps: 40, name: '"Legend of the Cove" title', kind: 'title', reward: { type: 'title', id: 'legend', name: 'Legend of the Cove' } },
  { stamps: 45, name: 'Golden Pawprints trail', kind: 'trail', reward: { type: 'trail', id: 'goldpaw', name: 'Golden Pawprints' } },
];

export function clampCoinsForGame(gameId, coins) {
  // own-property lookup: MINIGAMES['constructor'] is truthy and would yield NaN
  const g = Object.prototype.hasOwnProperty.call(MINIGAMES, gameId) ? MINIGAMES[gameId] : null;
  if (!g) return 0;
  return Math.max(0, Math.min(Math.floor(Number(coins) || 0), g.maxCoinsPerRun));
}
