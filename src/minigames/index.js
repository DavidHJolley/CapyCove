// Minigame registry. Ids must match shared/constants.js MINIGAMES.
import { FishingGame } from './games/fishing.js';
import { SledGame } from './games/sled.js';
import { SmoothieGame } from './games/smoothie.js';

export const GAMES = {
  fishing: FishingGame,
  sled: SledGame,
  smoothie: SmoothieGame,
};
