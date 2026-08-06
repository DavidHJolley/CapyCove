// Minigame registry. Ids must match shared/constants.js MINIGAMES.
// Code-split: nothing here is downloaded until a player actually starts a run.
export const GAMES = {
  fishing: () => import('./games/fishing.js').then((m) => m.FishingGame),
  sled: () => import('./games/sled.js').then((m) => m.SledGame),
  smoothie: () => import('./games/smoothie.js').then((m) => m.SmoothieGame),
};
