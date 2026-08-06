// Room registry. Every room in shared/constants.js ROOM_IDS maps to a class here.
import { PlazaRoom } from './rooms/plaza.js';
import { BeachRoom } from './rooms/beach.js';
import { PeakRoom } from './rooms/peak.js';
import { CafeRoom } from './rooms/cafe.js';
import { ClubRoom } from './rooms/club.js';

export const ROOMS = {
  plaza: PlazaRoom,
  beach: BeachRoom,
  peak: PeakRoom,
  cafe: CafeRoom,
  club: ClubRoom,
};
