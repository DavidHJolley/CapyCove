// Room registry. Every room in shared/constants.js ROOM_IDS maps to a loader
// here. Rooms are code-split: a cold start only needs the one room you spawn
// in, and Engine.switchRoom starts the import while the 220ms fade covers it.
export const ROOMS = {
  plaza: () => import('./rooms/plaza.js').then((m) => m.PlazaRoom),
  beach: () => import('./rooms/beach.js').then((m) => m.BeachRoom),
  peak: () => import('./rooms/peak.js').then((m) => m.PeakRoom),
  cafe: () => import('./rooms/cafe.js').then((m) => m.CafeRoom),
  club: () => import('./rooms/club.js').then((m) => m.ClubRoom),
  lounge: () => import('./rooms/lounge.js').then((m) => m.LoungeRoom),
  mine: () => import('./rooms/mine.js').then((m) => m.MineRoom),
  jungle: () => import('./rooms/jungle.js').then((m) => m.JungleRoom),
  drift: () => import('./rooms/drift.js').then((m) => m.DriftRoom),
  // dynamic per-player houses: any 'house:<owner>' id resolves to this loader
  // (see Engine.switchRoom), parameterized via game.__houseCtx
  house: () => import('./rooms/house.js').then((m) => m.HouseRoom),
};
