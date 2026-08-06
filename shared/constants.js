// Shared between client and server. Keep dependency-free (no three, no DOM, no node APIs).

export const GAME_NAME = 'Capy Cove';

export const ROOM_IDS = ['plaza', 'beach', 'peak', 'cafe', 'club'];
export const DEFAULT_ROOM = 'plaza';

export const ROOM_INFO = {
  plaza: { name: 'Sunny Plaza', desc: 'The heart of the cove' },
  beach: { name: 'Driftwood Beach', desc: 'Sand, surf and fishing' },
  peak: { name: 'Frosty Peak', desc: 'Snow, sleds and cocoa' },
  cafe: { name: 'The Smoothie Shack', desc: 'Blend it like you mean it' },
  club: { name: 'Groove Grotto', desc: 'Underground dance cave' },
};

// Minigames: id -> reward formula. Server clamps client-reported scores with these.
export const MINIGAMES = {
  fishing: { name: 'Reel Rush', room: 'beach', maxCoinsPerRun: 120 },
  sled: { name: 'Summit Sprint', room: 'peak', maxCoinsPerRun: 150 },
  smoothie: { name: 'Smoothie Scramble', room: 'cafe', maxCoinsPerRun: 130 },
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
};

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
