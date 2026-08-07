// Shared between client and server. Keep dependency-free (no three, no DOM, no node APIs).

export const GAME_NAME = 'Capy Cove';

export const ROOM_IDS = ['plaza', 'beach', 'peak', 'cafe', 'club', 'lounge', 'mine', 'jungle'];
export const DEFAULT_ROOM = 'plaza';

export const ROOM_INFO = {
  plaza: { name: 'Sunny Plaza', desc: 'The heart of the cove' },
  beach: { name: 'Driftwood Beach', desc: 'Sand, surf and fishing' },
  peak: { name: 'Frosty Peak', desc: 'Snow, sleds and cocoa' },
  cafe: { name: 'The Smoothie Shack', desc: 'Blend it like you mean it' },
  club: { name: 'Groove Grotto', desc: 'Underground dance cave' },
  lounge: { name: 'The Game Den', desc: 'Tables, trophies and tussles' },
  mine: { name: 'The Glimmer Mine', desc: 'Coins in the walls, hiders in the props' },
  jungle: { name: 'The Tangle Jungle', desc: 'Vines, ruins and doodles' },
};

// Minigames: id -> reward formula. Server clamps client-reported scores with these.
export const MINIGAMES = {
  fishing: { name: 'Reel Rush', room: 'beach', maxCoinsPerRun: 120 },
  sled: { name: 'Summit Sprint', room: 'peak', maxCoinsPerRun: 150 },
  smoothie: { name: 'Smoothie Scramble', room: 'cafe', maxCoinsPerRun: 130 },
  pong: { name: 'Paddle Panic', room: 'lounge', maxCoinsPerRun: 60 },
  shuffle: { name: 'Shuffle Showdown', room: 'lounge', maxCoinsPerRun: 70 },
  chess: { name: 'Grand Capy Chess', room: 'lounge', maxCoinsPerRun: 100 },
  connect4: { name: 'Four in a Row', room: 'lounge', maxCoinsPerRun: 60 },
  cards: { name: 'Capy Clash', room: 'lounge', maxCoinsPerRun: 100 },
  prophunt: { name: 'Prop Hunt', room: 'mine', maxCoinsPerRun: 90 },
  doodle: { name: 'Capy Doodles', room: 'jungle', maxCoinsPerRun: 90 },
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
  mine: { x: 0, z: 3, r: 4 },
  jungle: { x: 0, z: 3, r: 4.5 },
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
};

export const HOUSE_MAX_ITEMS = 60;
export const HOUSE_ACCESS_MODES = ['open', 'friends', 'invite'];

export const CHAT_MAX_LEN = 120;
export const NAME_MIN_LEN = 3;
export const NAME_MAX_LEN = 16;

export const NET_TICK_MS = 100; // server broadcast + client send cadence
export const WALK_SPEED = 5.2; // units/sec, shared so server bots match players

export function clampCoinsForGame(gameId, coins) {
  // own-property lookup: MINIGAMES['constructor'] is truthy and would yield NaN
  const g = Object.prototype.hasOwnProperty.call(MINIGAMES, gameId) ? MINIGAMES[gameId] : null;
  if (!g) return 0;
  return Math.max(0, Math.min(Math.floor(Number(coins) || 0), g.maxCoinsPerRun));
}
