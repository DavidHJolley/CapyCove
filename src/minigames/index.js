// Minigame registry. Ids must match shared/constants.js MINIGAMES.
// Code-split: nothing here is downloaded until a player actually starts a run.
export const GAMES = {
  fishing: () => import('./games/fishing.js').then((m) => m.FishingGame),
  sled: () => import('./games/sled.js').then((m) => m.SledGame),
  smoothie: () => import('./games/smoothie.js').then((m) => m.SmoothieGame),
  pong: () => import('./games/pong.js').then((m) => m.PongGame),
  shuffle: () => import('./games/shuffle.js').then((m) => m.ShuffleGame),
  chess: () => import('./games/chess.js').then((m) => m.ChessGame),
  connect4: () => import('./games/connect4.js').then((m) => m.Connect4Game),
  cards: () => import('./games/cards.js').then((m) => m.CardsGame),
  prophunt: () => import('./games/prophunt.js').then((m) => m.PropHuntGame),
  doodle: () => import('./games/doodle.js').then((m) => m.DoodleGame),
  kart: () => import('./games/kart.js').then((m) => m.KartGame),
};
