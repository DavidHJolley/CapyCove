/**
 * Progression module: daily quests, stamp album, milestone rewards (wave 7,
 * docs/LIVING-COVE.md section D). Owned separately from index.js so the live
 * systems and the progression systems can evolve independently.
 *
 * Contract with index.js (already wired there; do not edit index.js):
 *  - install(ctx) is called once at boot with
 *      { users, saveSoon, grantCoins, sendTo, broadcastToRoom, has }
 *  - handleMessage(p, m) gets first refusal on every ws frame from a live
 *    player; return true to consume it (quest board opens, album reads, etc.)
 *  - signal(name, p, data) is called by index.js's own handlers at scoring
 *    moments; names (stable, agreed): 'score' {game, coins}, 'match-win'
 *    {game}, 'race-done' {placed}, 'dig' {gem}, 'party-host' {count},
 *    'party-attend', 'mural-pixel', 'chat', 'wave', 'room' {room},
 *    'whale-ride' {riders}, 'doodle-correct', 'bottle'.
 *  - tick(dtSeconds, worldClock) is called from the main interval so dailies
 *    can roll over on the cove-day boundary.
 *
 * PLACEHOLDER: the wave-7 progress agent replaces this file wholesale.
 */

let ctx = null;

export function install(c) {
  ctx = c;
}

export function handleMessage(_p, _m) {
  return false; // consume nothing until the real module lands
}

export function signal(_name, _p, _data) {}

export function tick(_dt, _clock) {}
