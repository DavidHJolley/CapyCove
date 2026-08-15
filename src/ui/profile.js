import * as THREE from 'three';
import { HATS, MINIGAMES, ROOM_INFO } from '../../shared/constants.js';
// Namespace import on purpose: STAMPS / MILESTONES are wave-7 additions owned by
// the progression agent, and a named import of a binding that has not landed yet
// is a link-time error. Reading them off the namespace degrades to a fallback.
import * as SHARED from '../../shared/constants.js';
import { createAvatar } from '../player/avatar.js';
import { makeToon, makeGlow, disposeObject } from '../core/materials.js';
import { visitHouse } from '../net/client.js';

/**
 * Player card: click a capybara, meet the capybara.
 *
 * A live 3D turntable of THEIR avatar (their color + hat), their name, a
 * flavor title, their minigame bests rendered as medals, and the friend
 * button when both sides have real accounts.
 *
 * Public API:
 *   openProfile(game, playerId)   - the card (also opened from the friends list)
 *   ensureSocialStyles()          - injects the single <style> tag for pf-/fr-
 *   normalizeFriends(payload)     - shared parser for the 'friends-data' event
 *   REPORT_REASONS                - the reason vocabulary (wave 10C)
 *
 * Data flow: we paint instantly from whatever the net client already knows
 * about that remote (name/color/hat/bot), fire {t:'inspect', id} and enrich the
 * card when 'profile-data' arrives. 'friends-data' keeps the button honest.
 *
 * ---------------------------------------------------------------------------
 * WAVE 10C: Report a player, and the Moderate section
 *
 * Both hang off the existing action row, because the card is where you already
 * clicked the capybara. A report that needs a menu, a console or a second
 * overlay is a report that does not get filed mid-incident, and a moderator
 * who has to alt-tab to a panel is a moderator who is slower than the problem
 * (accounts-admin.md section 2.4 item 3).
 *
 * WIRE. Out:
 *   {t:'report', kind:'chat'|'name'|'other', reason, uid?, name?, id, room?, note?}
 *     - reason is one of REPORT_REASONS' ids and `kind` is derived from it;
 *       both vocabularies are server/reports.js's (KINDS, REASONS), and an id
 *       off that list is filed as 'other' rather than refused
 *     - note is free text, <= 240 chars (the store takes 300)
 *     - uid / name / id are all sent when known: the server resolves in that
 *       order, so the report survives a rename or a reconnect
 *     - the client attaches NO evidence. The chat ring, the room and the
 *       timestamps are server-side facts (server/chatlog.js); a client-supplied
 *       transcript is a client-supplied lie.
 *   {t:'a-inspect'|'a-mute'|'a-unmute'|'a-kick'|'a-ban'|'a-unban', <target>, ...}
 *     - exactly server/admin.js's frames, exactly src/ui/admin.js's shapes
 * In:
 *   'report'  {ok:true, id} | {ok:false, msg, code}   (refusal rides the same
 *             name, as `mural` already does)
 *   'a-ok' / 'a-err'  matched to THIS card's target, because Cove Watch is
 *             listening to the same two events.
 *
 * GATING. The Moderate section is drawn from `game.can(cap)` — the caps list
 * the server put on the welcome profile — and never from a role name or a
 * client guess. Every button it draws is re-authorised by performOp anyway, so
 * this is ergonomics, not security: the rule it follows is simply never to
 * paint a button the server is going to refuse.
 */

// ---------------------------------------------------------------------------
// achievements
// ---------------------------------------------------------------------------

// bronze / silver / gold cut-offs per minigame
const MEDAL_TIERS = {
  fishing: [30, 60, 100],
  sled: [800, 2000, 4000],
  smoothie: [150, 350, 600],
};

const TIER_CLASS = ['is-none', 'is-bronze', 'is-silver', 'is-gold'];
const TIER_LABEL = ['No medal yet', 'Bronze', 'Silver', 'Gold'];

const MEDAL_BLURB = {
  fishing: 'Reeled in off Driftwood Beach',
  sled: 'Screamed down Frosty Peak',
  smoothie: 'Blended under pressure',
};

/** One line of context under each minigame name: where they are on the ladder. */
function medalSub(best, tier, next) {
  if (best == null) return next != null ? `Not tried yet : ${next} earns bronze` : 'Not tried yet';
  if (tier === 0) return `${next} earns bronze`;
  if (tier === 1) return `Bronze : ${next} earns silver`;
  if (tier === 2) return `Silver : ${next} earns gold`;
  return 'Gold : nothing left to prove';
}

/** A best of 0 (or missing / junk) means "never played". */
function bestOf(bests, id) {
  const has = bests && Object.prototype.hasOwnProperty.call(bests, id);
  const v = has ? Number(bests[id]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function medalTier(id, best) {
  const cuts = Object.prototype.hasOwnProperty.call(MEDAL_TIERS, id) ? MEDAL_TIERS[id] : null;
  if (!cuts || best == null) return 0;
  if (best >= cuts[2]) return 3;
  if (best >= cuts[1]) return 2;
  if (best >= cuts[0]) return 1;
  return 0;
}

function nextCut(id, best) {
  const cuts = Object.prototype.hasOwnProperty.call(MEDAL_TIERS, id) ? MEDAL_TIERS[id] : null;
  if (!cuts) return null;
  for (const c of cuts) if (best == null || best < c) return c;
  return null;
}

/**
 * "Their game", the one line of best-of that people actually want to read.
 *
 * `plays` (a {gameId: runs} map) is the honest answer and wins whenever the
 * server volunteers it. Until it does, the ladder answers instead: the game
 * they are furthest up is the game they have been playing. Both are labelled
 * differently in the card, because "most played" and "best at" are not the same
 * brag and pretending otherwise is how a stat line stops being trusted.
 *
 * @returns {{id:string, n:number|null, why:'plays'|'medal'}|null}
 */
export function favoriteGame(bests, plays) {
  if (plays && typeof plays === 'object') {
    let top = null;
    // every game can be someone's favourite; only three of them have a medal
    // ladder, so the fallback below is necessarily narrower than this
    for (const id of Object.keys(MINIGAMES)) {
      const n = Math.floor(Number(Object.prototype.hasOwnProperty.call(plays, id) ? plays[id] : 0));
      if (!Number.isFinite(n) || n <= 0) continue;
      if (!top || n > top.n) top = { id, n, why: 'plays' };
    }
    if (top) return top;
  }
  // No plays: rank by how far up its own ladder each best sits, so a 4000 sled
  // run and a 100 fish haul can be compared at all.
  let best = null;
  for (const id of Object.keys(MEDAL_TIERS)) {
    const v = bestOf(bests, id);
    if (v == null) continue;
    const cuts = MEDAL_TIERS[id];
    const rung = Math.min(1.6, v / cuts[2]);
    if (!best || rung > best.rung) best = { id, n: v, why: 'medal', rung };
  }
  return best ? { id: best.id, n: best.n, why: 'medal' } : null;
}

/** "Day 42 in the cove" from an ms epoch. null when the server did not say. */
export function daysInCove(since, now = Date.now()) {
  const t = Math.floor(Number(since));
  if (!Number.isFinite(t) || t <= 0 || t > now + 86_400_000) return null;
  const d = Math.floor((now - t) / 86_400_000) + 1;
  return d >= 1 && d < 40_000 ? d : null;
}

/** Staff badges. A role of 'player' draws nothing: the badge is for the few. */
const ROLE_BADGE = { mod: 'Cove keeper', admin: 'Cove admin' };

/** How many stamps the owner may pin above everything else. Three is a shelf. */
export const SHOWCASE_MAX = 3;

/**
 * The owner's pinned stamps: strings, deduped, capped, and (when we know their
 * album) never showing a stamp they have not earned. A pick that outlives the
 * catalog is dropped rather than drawn as a mystery tile.
 */
export function normalizeShowcase(raw, earnedIds) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.showcase) ? raw.showcase : null;
  if (!list) return null; // null = "the server did not say", not "empty"
  const earned = earnedIds instanceof Set ? earnedIds
    : Array.isArray(earnedIds) ? new Set(earnedIds) : null;
  const out = [];
  for (const v of list) {
    const id = typeof v === 'string' ? v : (v && typeof v.id === 'string' ? v.id : '');
    if (!id || out.includes(id)) continue;
    if (earned && !earned.has(id)) continue;
    out.push(id);
    if (out.length >= SHOWCASE_MAX) break;
  }
  return out;
}

/**
 * Local mirror of the pick, keyed by account name.
 *
 * The server is the authority the moment it carries `showcase` (see the
 * orchestrator line in this wave's report); until then the pick still has to
 * survive a refresh, and a guest has no record to write to at all. Storage
 * failures are silent: a browser with storage switched off loses the pin, not
 * the card.
 */
function showcaseKey(name) {
  return `capy.showcase.${String(name || 'guest').toLowerCase()}`;
}

function readLocalShowcase(name) {
  try {
    const raw = globalThis.localStorage?.getItem(showcaseKey(name));
    return raw ? normalizeShowcase(JSON.parse(raw)) : null;
  } catch { return null; }
}

function writeLocalShowcase(name, ids) {
  try { globalThis.localStorage?.setItem(showcaseKey(name), JSON.stringify(ids)); } catch { /* private mode */ }
}

/**
 * Stamps seen in the album, so a stamp earned since your last look can SHINE.
 * Per account, ids only, and it is a nicety: a browser that cannot store it
 * just never shines, which is exactly what happens today.
 */
function seenKey(name) {
  return `capy.album.seen.${String(name || 'guest').toLowerCase()}`;
}

function readSeen(name) {
  try {
    const raw = globalThis.localStorage?.getItem(seenKey(name));
    const list = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(list) ? list.filter((v) => typeof v === 'string') : []);
  } catch { return new Set(); }
}

function writeSeen(name, ids) {
  try { globalThis.localStorage?.setItem(seenKey(name), JSON.stringify([...ids].slice(-200))); } catch { /* private mode */ }
}

function flavorTitle(bests, isBot, isSelf) {
  if (isBot) return 'Local legend';
  const ids = Object.keys(MEDAL_TIERS);
  let gold = 0; let silver = 0; let bronze = 0; let played = 0;
  for (const id of ids) {
    const best = bestOf(bests, id);
    if (best != null) played++;
    const t = medalTier(id, best);
    if (t === 3) gold++;
    else if (t === 2) silver++;
    else if (t === 1) bronze++;
  }
  if (gold >= 3) return 'Champion of the cove';
  if (gold >= 1) return 'Podium regular';
  if (silver >= 1) return 'Dangerously good';
  if (bronze >= 1) return 'Getting the hang of it';
  if (played >= 1) return 'Warming up';
  return isSelf ? 'Your story starts here' : 'Newly washed ashore';
}

// ---------------------------------------------------------------------------
// stamp album (wave 7, docs/LIVING-COVE.md section D)
//
// The catalog is contract data and belongs in shared/constants.js as STAMPS
// (and MILESTONES); this module owns the ART. Until the progression agent lands
// those exports, FALLBACK_STAMPS/MILESTONES keep the tab, the slam and the
// milestone bar honest instead of shipping an empty box. Shared always wins.
// ---------------------------------------------------------------------------

/**
 * The album's shelves. Forty tiles in one grid is a wall; five headed shelves
 * with their own completion is something you browse, and there is always one
 * shelf sitting at "two to go" pulling you back.
 *
 * A shared STAMPS entry may name its own shelf (`section` / `group` / `sect`);
 * anything unrecognised lands on 'odds', which is only drawn if it has tiles.
 */
export const STAMP_SECTIONS = [
  { key: 'play', name: 'Games and glory', blurb: 'Runs, races and hauls, scored on your own.' },
  { key: 'den', name: 'Across the table', blurb: 'Won against another capybara who was really there.' },
  { key: 'cove', name: 'Out in the cove', blurb: 'Weather, water and being somewhere at the right hour.' },
  { key: 'make', name: 'Making things', blurb: 'Pixels, dens and other evidence you were here.' },
  { key: 'social', name: 'Good company', blurb: 'Nobody earns these on their own.' },
  { key: 'grind', name: 'The long haul', blurb: 'The ones that take a while.' },
  { key: 'odds', name: 'Odds and ends', blurb: 'Cove secrets.' },
];

const SECTION_KEYS = new Set(STAMP_SECTIONS.map((s) => s.key));

/**
 * Shelf for every stamp id this module knows by name.
 *
 * The live catalog is shared/constants.js STAMPS; the ids below cover it, and
 * the leftovers are this module's older FALLBACK ids, which only matter on a
 * build whose shared STAMPS has not landed. A shared entry may always overrule
 * this by naming its own `section` (see decorate), and anything unmapped lands
 * on 'odds', which is drawn only when it has tiles.
 */
const SECTION_OF = {
  // --- shared/constants.js STAMPS ---
  angler: 'play', reel_master: 'play', downhill: 'play', speed_demon: 'play',
  barista: 'play', shift_lead: 'play', all_rounder: 'play', racer: 'play',
  photo_finish: 'play', hat_trick: 'play', hider: 'play', doodler: 'play',
  prospector: 'play', gem_hunter: 'play', motherlode: 'play',
  duelist: 'den', sweep: 'den', grandmaster: 'den', card_shark: 'den',
  paddle_pro: 'den', four_up: 'den', shuffler: 'den', den_regular: 'den',
  explorer: 'cove', globetrotter: 'cove', night_owl: 'cove', deep_breath: 'cove',
  whale_rider: 'cove', pod: 'cove', bottler: 'cove', beachcomber: 'cove',
  snow_fight: 'cove', volley: 'cove', toasty: 'cove',
  first_dab: 'make', muralist: 'make', cove_painter: 'make', decorator: 'make',
  first_hello: 'social', party_planner: 'social', host_most: 'social',
  party_animal: 'social', socialite: 'social', chatterbox: 'social',
  regular: 'grind', veteran: 'grind', quester: 'grind', clean_sweep: 'grind',
  devoted: 'grind', collector: 'grind',
  // --- this module's fallback catalog, for a build without shared STAMPS ---
  first_splash: 'play', reel_it_in: 'play', blend_master: 'play', prop_star: 'play',
  seeker: 'play', quick_draw: 'play', good_guess: 'play', glimmer: 'play',
  checkmate: 'den', clash: 'den',
  sunriser: 'cove', rain_dance: 'cove', snowballer: 'cove', campfire: 'cove',
  lantern: 'cove', message: 'cove', slow_steady: 'cove',
  first_pixel: 'make', open_house: 'make',
  host_with_most: 'social', social: 'social',
  deep_pockets: 'grind', legend: 'grind',
};

// id, name, what it is for, glyph, hue. Feats, not grind: every line here is a
// thing you did in front of other capybaras.
const FALLBACK_STAMPS = [
  ['first_splash', 'First Splash', 'Finish your very first minigame run.', 'splash', 0x4fb3e8],
  ['reel_it_in', 'Reel It In', 'Land 40 or more in Reel Rush.', 'fish', 0x42d6c8],
  ['deep_pockets', 'Deep Pockets', 'Have 1000 coins in your purse at once.', 'coin', 0xf2b64a],
  ['sweep', 'Sweep', 'Win a game of Paddle Panic 5-0.', 'paddle', 0xe8657a],
  ['checkmate', 'Checkmate', 'Beat another capybara at Grand Capy Chess.', 'pawn', 0x9b6bd4],
  ['four_up', 'Four Up', 'Win Four in a Row against a real opponent.', 'grid4', 0xf2a541],
  ['clash', 'Clash Champion', 'Take a Capy Clash duel off another player.', 'card', 0xe8657a],
  ['shuffler', 'Shuffle Master', 'Park every disc in the scoring zone.', 'disc', 0x7ac74f],
  ['downhill', 'Downhill', 'Finish a three capybara sled race.', 'sled', 0x4fb3e8],
  ['photo_finish', 'Photo Finish', 'Win a sled race by less than a second.', 'flag', 0xf2b64a],
  ['blend_master', 'Blend Master', 'Score 350 in Smoothie Scramble.', 'blender', 0xf29ab0],
  ['prop_star', 'Prop Star', 'Survive a whole Prop Hunt as a prop.', 'prop', 0x8a6642],
  ['seeker', 'Seeker', 'Find every hider in one Prop Hunt.', 'eye', 0x2f7fb0],
  ['quick_draw', 'Quick Draw', 'Have three capys guess your doodle.', 'brush', 0xe8657a],
  ['good_guess', 'Good Guess', 'Guess five doodles in a single round.', 'bulb', 0xf2b64a],
  ['glimmer', 'Glimmer', 'Dig a gem out of the Glimmer Mine.', 'gem', 0x42d6c8],
  ['first_pixel', 'First Pixel', 'Add your first pixel to the plaza mural.', 'pixel', 0x7ac74f],
  ['muralist', 'Muralist', 'Place fifty mural pixels, lifetime.', 'mural', 0xe8657a],
  ['host_with_most', 'Host With the Most', 'Get five capys to a party you threw.', 'party', 0xf2b64a],
  ['party_animal', 'Party Animal', 'Turn up to five parties.', 'confetti', 0x9b6bd4],
  ['night_owl', 'Night Owl', 'See the aurora over Frosty Peak.', 'aurora', 0x42d6c8],
  ['sunriser', 'Sunriser', 'Be in the plaza when the sun comes up.', 'sun', 0xf2a541],
  ['rain_dance', 'Rain Dance', 'Dance outdoors in the rain.', 'rain', 0x4fb3e8],
  ['snowballer', 'Snowballer', 'Land ten snowballs on willing victims.', 'snowball', 0xbfe6f5],
  ['volley', 'Volley', 'Bop the beach ball ten times.', 'ball', 0xe8657a],
  ['campfire', 'Campfire Capy', 'Sit out a whole night at the bonfire.', 'bonfire', 0xf2a541],
  ['deep_breath', 'Deep Breath', 'Spend ten minutes down in The Drift.', 'bubbles', 0x2f7fb0],
  ['pod', 'Pod', 'Ride Big Blue with three other capys aboard.', 'whale', 0x4fb3e8],
  ['lantern', 'Lantern Light', 'Drift with the jellies after dark.', 'jelly', 0x9b6bd4],
  ['message', 'Message in a Bottle', 'Be first to the day\'s bottle.', 'bottle', 0xf2b64a],
  ['slow_steady', 'Slow and Steady', 'Follow the sea turtle a full lap.', 'turtle', 0x7ac74f],
  ['decorator', 'Decorator', 'Place twenty things in your own den.', 'chair', 0x8a6642],
  ['open_house', 'Open House', 'Have five visitors in your den at once.', 'door', 0xf2b64a],
  ['social', 'Social Butterfly', 'Make five friends.', 'friends', 0xe8657a],
  ['chatterbox', 'Chatterbox', 'Say a hundred things out loud.', 'bubble', 0x4fb3e8],
  ['explorer', 'Explorer', 'Visit every room in a single cove day.', 'compass', 0xf2a541],
  ['clean_sweep', 'Clean Sweep', 'Finish all three dailies in one day.', 'check', 0x7ac74f],
  ['regular', 'Regular', 'Play on seven different days.', 'calendar', 0x9b6bd4],
  ['hat_trick', 'Hat Trick', 'Own ten different hats.', 'hat', 0xf29ab0],
  ['legend', 'Legend of the Cove', 'Earn every other stamp in the album.', 'crown', 0xf2c744],
].map(([id, name, desc, glyph, hue]) => ({
  id, name, desc, how: desc, glyph, hue, sect: SECTION_OF[id] || 'odds',
}));

// total stamps -> exclusive reward coins cannot buy
const FALLBACK_MILESTONES = [
  { at: 5, name: 'Snorkel', kind: 'hat', glyph: 'bubbles', hue: 0xe8657a },
  { at: 12, name: 'Aurora coat', kind: 'color', glyph: 'aurora', hue: 0x42d6c8 },
  { at: 20, name: 'Whale-song gramophone', kind: 'furniture', glyph: 'gramo', hue: 0xf2b64a },
  { at: 30, name: 'Golden pickaxe', kind: 'hat', glyph: 'pick', hue: 0xf2c744 },
  { at: 40, name: '"Legend of the Cove" title', kind: 'title', glyph: 'ribbon', hue: 0x9b6bd4 },
];

const GLYPHS = ['splash', 'fish', 'coin', 'paddle', 'pawn', 'grid4', 'card', 'disc', 'sled',
  'flag', 'blender', 'prop', 'eye', 'brush', 'bulb', 'gem', 'pixel', 'mural', 'party',
  'confetti', 'aurora', 'sun', 'rain', 'snowball', 'ball', 'bonfire', 'bubbles', 'whale',
  'jelly', 'bottle', 'turtle', 'chair', 'door', 'friends', 'bubble', 'compass', 'check',
  'calendar', 'hat', 'crown'];

const HUES = [0xe8657a, 0x4fb3e8, 0x7ac74f, 0xf2b64a, 0x9b6bd4, 0x42d6c8, 0xf2a541, 0xf29ab0];

const FALLBACK_BY_ID = new Map(FALLBACK_STAMPS.map((s) => [s.id, s]));

/** Stable per-id pick so a server-only stamp still gets consistent art. */
function hashOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function decorate(id, raw) {
  const known = FALLBACK_BY_ID.get(id);
  const h = hashOf(id);
  const glyph = typeof raw?.glyph === 'string' && GLYPHS.includes(raw.glyph)
    ? raw.glyph : (known?.glyph || GLYPHS[h % GLYPHS.length]);
  const hue = Number.isFinite(Number(raw?.hue)) ? Number(raw.hue)
    : (known?.hue ?? HUES[(h >> 5) % HUES.length]);
  // shared STAMPS carry both a flavour line (desc) and the actual condition
  // (how); the album shows the flavour once earned and the condition until then
  const how = (typeof raw?.how === 'string' && raw.how.trim())
    || (typeof raw?.desc === 'string' && raw.desc.trim()) || known?.desc || 'A cove secret.';
  const claimed = [raw?.section, raw?.group, raw?.sect].find(
    (v) => typeof v === 'string' && SECTION_KEYS.has(v),
  );
  return {
    id,
    name: (typeof raw?.name === 'string' && raw.name.trim()) || known?.name || id,
    desc: (typeof raw?.desc === 'string' && raw.desc.trim()) || how,
    how,
    glyph,
    hue,
    sect: claimed || known?.sect || SECTION_OF[id] || 'odds',
  };
}

let _catalog = null;

/** The stamp catalog: shared STAMPS when it exists, this module's list until then. */
export function stampCatalog() {
  if (_catalog) return _catalog;
  const shared = SHARED.STAMPS;
  if (Array.isArray(shared) && shared.length) {
    _catalog = shared
      .filter((s) => s && (typeof s.id === 'string'))
      .map((s) => decorate(s.id, s));
  } else if (shared && typeof shared === 'object') {
    _catalog = Object.keys(shared).map((id) => decorate(id, shared[id]));
  } else {
    _catalog = FALLBACK_STAMPS.slice();
  }
  if (!_catalog.length) _catalog = FALLBACK_STAMPS.slice();
  return _catalog;
}

export function stampById(id) {
  if (typeof id !== 'string' || !id) return null;
  for (const s of stampCatalog()) if (s.id === id) return s;
  return decorate(id, null); // an unknown id still deserves a stamp, not a hole
}

/** Milestone rewards keyed by total stamps: shared MILESTONES when it exists. */
export function milestoneTrack() {
  const shared = SHARED.MILESTONES;
  const list = Array.isArray(shared) ? shared : null;
  if (!list || !list.length) return FALLBACK_MILESTONES;
  return list
    .map((m, i) => {
      const at = Math.max(1, Math.floor(Number(m?.at ?? m?.stamps ?? 0)) || 0);
      const fb = FALLBACK_MILESTONES[Math.min(i, FALLBACK_MILESTONES.length - 1)];
      return {
        at: at || fb.at,
        name: (typeof m?.name === 'string' && m.name.trim()) || fb.name,
        kind: typeof m?.kind === 'string' ? m.kind : fb.kind,
        glyph: typeof m?.glyph === 'string' ? m.glyph : fb.glyph,
        hue: Number.isFinite(Number(m?.hue)) ? Number(m.hue) : fb.hue,
      };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * The trail / aura slot.
 *
 * That cosmetic is another agent's (fleet C1) and lands on its own schedule, so
 * this card is deliberately incurious about it: the EQUIPPED ID is the whole
 * contract. A catalog (`SHARED.TRAILS` / `SHARED.AURAS`, array or id-keyed
 * object) upgrades the id to a name and a colour when it exists; without one
 * the id is title-cased and shown anyway, because "wearing something" is the
 * social fact and the pretty name is only decoration. Nothing equipped, or no
 * slot at all on this build, draws nothing.
 *
 * @returns {{kind:string, id:string, name:string, color:number|null}|null}
 */
export function equippedFlair(src) {
  if (!src || typeof src !== 'object') return null;
  const slots = [
    ['Trail', src.trail ?? src.equippedTrail, SHARED.TRAILS],
    ['Aura', src.aura ?? src.equippedAura, SHARED.AURAS],
  ];
  for (const [kind, raw, catalog] of slots) {
    const id = typeof raw === 'string' ? raw.trim()
      : (raw && typeof raw === 'object' && typeof raw.id === 'string') ? raw.id.trim() : '';
    if (!id || id === 'none') continue;
    let entry = null;
    if (Array.isArray(catalog)) entry = catalog.find((e) => e && e.id === id) || null;
    else if (catalog && typeof catalog === 'object'
      && Object.prototype.hasOwnProperty.call(catalog, id)) entry = catalog[id];
    const name = (typeof entry?.name === 'string' && entry.name.trim())
      || id.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const c = Number(entry?.color ?? entry?.hue ?? (raw && typeof raw === 'object' ? raw.color : NaN));
    return { kind, id, name, color: Number.isFinite(c) && c > 0 ? c : null };
  }
  return null;
}

/**
 * Parse a 'stamps' frame (or a stamps blob hanging off a profile).
 * Accepts [ids], {stamps:[ids]}, {earned:[ids]}, {stamps:{id:true}}.
 */
export function normalizeStamps(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw.stamps ?? raw.earned ?? raw.ids ?? raw.list) : raw;
  const ids = [];
  if (Array.isArray(body)) {
    for (const v of body) {
      if (typeof v === 'string' && v) ids.push(v);
      else if (v && typeof v === 'object' && typeof v.id === 'string') ids.push(v.id);
    }
  } else if (body && typeof body === 'object') {
    for (const k of Object.keys(body)) if (body[k]) ids.push(k);
  }
  const owner = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw.id ?? raw.playerId ?? null) : null;
  return { id: owner == null ? null : String(owner), ids: [...new Set(ids)] };
}

/**
 * Split a catalog onto its shelves and count each one.
 * Empty shelves are dropped, so a server whose STAMPS never mention 'odds'
 * simply never draws that heading.
 *
 * @returns {{key:string, name:string, blurb:string, stamps:object[],
 *            got:number, total:number, pct:number}[]}
 */
export function albumSections(catalog, earnedIds) {
  const earned = earnedIds instanceof Set ? earnedIds : new Set(earnedIds || []);
  const byKey = new Map(STAMP_SECTIONS.map((s) => [s.key, { ...s, stamps: [], got: 0 }]));
  for (const s of Array.isArray(catalog) ? catalog : []) {
    if (!s || typeof s.id !== 'string') continue;
    const bucket = byKey.get(s.sect) || byKey.get('odds');
    if (!bucket) continue;
    bucket.stamps.push(s);
    if (earned.has(s.id)) bucket.got++;
  }
  const out = [];
  for (const b of byKey.values()) {
    if (!b.stamps.length) continue;
    out.push({ ...b, total: b.stamps.length, pct: Math.round((b.got / b.stamps.length) * 100) });
  }
  return out;
}

/**
 * The charm board, from any of the three shapes that carry it: the `charm`
 * frame's `mine`, the profile ride-along's `charms`, or a bare array. Newest
 * first is the server's order and it is kept, because a card shows the top row.
 *
 * `count` is the LIFETIME total, which is not the length of the list: the
 * ride-along is capped (server/charms.js CARD_CHARMS) and the count is not.
 */
export function normalizeCharms(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.charms) ? raw.charms
      : Array.isArray(raw?.mine) ? raw.mine : [];
  const found = [];
  for (const c of list) {
    if (!c) continue;
    if (typeof c === 'string') { found.push({ id: c, name: c, week: null, at: 0 }); continue; }
    if (typeof c !== 'object' || typeof c.id !== 'string' || !c.id) continue;
    found.push({
      id: c.id,
      name: (typeof c.name === 'string' && c.name.trim()) || c.id,
      week: typeof c.week === 'string' && c.week ? c.week : null,
      at: Number.isFinite(Number(c.at)) ? Number(c.at) : 0,
    });
  }
  const n = Math.floor(Number(raw?.charmCount));
  return {
    found,
    count: Number.isFinite(n) && n >= found.length ? n : found.length,
  };
}

/** Did this board already collect the charm for `week`? null = we cannot tell. */
export function foundThisWeek(board, week) {
  if (!week || !board) return null;
  if (!Array.isArray(board.found)) return null;
  if (!board.found.some((c) => c.week)) return board.found.length ? null : false;
  return board.found.some((c) => c.week === week);
}

// ---- procedural stamp art -------------------------------------------------
// Everything is drawn into a 100x100 unit box and scaled by the caller, so one
// routine serves the 72px album tiles and the 260px slam without a second set
// of numbers. No assets, same rules as the rest of the world.

const INK = '#2d2417';
const PAPER = '#fffaf0';

const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;

/** Mix toward white (k>0) or ink (k<0) so one hue makes a whole little scene. */
function shade(c, k) {
  const r = (c >> 16) & 255; const g = (c >> 8) & 255; const b = c & 255;
  const t = k > 0 ? 255 : 45;
  const a = Math.abs(k);
  const m = (v) => Math.round(v + (t - v) * a);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function makePen(c) {
  const pen = {
    c,
    dot(x, y, r, fill) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); return pen; },
    oval(x, y, rx, ry, fill, rot = 0) {
      c.beginPath(); c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); return pen;
    },
    box(x, y, w, h, r, fill) {
      const rr = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x - w / 2 + rr, y - h / 2);
      c.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, rr);
      c.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, rr);
      c.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, rr);
      c.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, rr);
      c.closePath(); c.fillStyle = fill; c.fill(); return pen;
    },
    poly(pts, fill) {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath(); c.fillStyle = fill; c.fill(); return pen;
    },
    line(x1, y1, x2, y2, w, col) {
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
      c.strokeStyle = col; c.lineWidth = w; c.stroke(); return pen;
    },
    arc(x, y, r, a0, a1, w, col) {
      c.beginPath(); c.arc(x, y, r, a0, a1);
      c.strokeStyle = col; c.lineWidth = w; c.stroke(); return pen;
    },
    star(x, y, r, points, fill) {
      c.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 ? r * 0.45 : r;
        const px = x + Math.cos(a) * rr; const py = y + Math.sin(a) * rr;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath(); c.fillStyle = fill; c.fill(); return pen;
    },
  };
  return pen;
}

/* eslint-disable no-unused-vars */
const GLYPH_ART = {
  splash: (p, h) => {
    p.oval(50, 66, 30, 13, shade(h, 0.15));
    p.poly([[34, 62], [50, 26], [66, 62]], shade(h, -0.1));
    for (const [x, y, r] of [[30, 40, 5], [70, 36, 6], [50, 22, 4]]) p.dot(x, y, r, shade(h, 0.5));
  },
  fish: (p, h) => {
    p.oval(46, 50, 26, 16, hex(h));
    p.poly([[70, 50], [88, 34], [88, 66]], shade(h, -0.15));
    p.dot(32, 45, 4, INK);
    p.arc(46, 56, 12, 0.25, Math.PI - 0.25, 3, shade(h, -0.25));
  },
  coin: (p, h) => {
    p.dot(50, 52, 28, shade(h, -0.1));
    p.dot(50, 48, 28, hex(h));
    p.dot(50, 48, 20, shade(h, 0.3));
    p.star(50, 48, 12, 5, shade(h, -0.2));
  },
  paddle: (p, h) => {
    p.box(34, 50, 12, 44, 6, hex(h));
    p.box(68, 56, 12, 34, 6, shade(h, -0.2));
    p.dot(52, 36, 8, PAPER);
    p.dot(52, 36, 8, shade(h, 0.55));
  },
  pawn: (p, h) => {
    p.dot(50, 32, 13, hex(h));
    p.poly([[38, 46], [62, 46], [68, 74], [32, 74]], hex(h));
    p.box(50, 78, 46, 10, 5, shade(h, -0.2));
  },
  grid4: (p, h) => {
    p.box(50, 52, 62, 62, 12, shade(h, -0.15));
    const cols = [shade(h, 0.6), hex(h), shade(h, 0.6), hex(h)];
    let i = 0;
    for (const y of [36, 68]) for (const x of [36, 68]) p.dot(x, y, 12, cols[i++]);
  },
  card: (p, h) => {
    p.box(40, 54, 44, 60, 8, shade(h, -0.3));
    p.box(56, 48, 44, 60, 8, PAPER);
    p.poly([[56, 34], [70, 50], [56, 64], [42, 50]], hex(h));
  },
  disc: (p, h) => {
    p.oval(50, 60, 34, 14, shade(h, -0.2));
    p.oval(50, 52, 34, 14, hex(h));
    p.oval(50, 52, 16, 6, shade(h, 0.5));
  },
  sled: (p, h) => {
    p.poly([[24, 58], [76, 58], [70, 44], [30, 44]], hex(h));
    p.arc(50, 62, 30, Math.PI * 0.15, Math.PI * 0.85, 6, shade(h, -0.3));
    for (const x of [36, 64]) p.line(x, 58, x, 68, 5, shade(h, -0.3));
    p.dot(50, 32, 9, shade(h, 0.4));
  },
  flag: (p, h) => {
    p.line(34, 78, 34, 22, 6, INK);
    p.poly([[34, 24], [78, 36], [34, 50]], hex(h));
    p.dot(34, 20, 6, shade(h, 0.4));
  },
  blender: (p, h) => {
    p.box(50, 72, 44, 20, 7, shade(h, -0.35));
    p.poly([[34, 62], [66, 62], [62, 24], [38, 24]], shade(h, 0.55));
    p.poly([[38, 62], [62, 62], [59, 40], [41, 40]], hex(h));
    p.dot(50, 20, 7, shade(h, -0.2));
  },
  prop: (p, h) => {
    p.box(50, 58, 46, 44, 8, hex(h));
    p.box(50, 34, 52, 12, 6, shade(h, -0.25));
    p.dot(40, 54, 4, INK);
    p.dot(60, 54, 4, INK);
    p.arc(50, 62, 9, 0.2, Math.PI - 0.2, 3, INK);
  },
  eye: (p, h) => {
    p.poly([[16, 50], [50, 24], [84, 50], [50, 76]], PAPER);
    p.dot(50, 50, 18, hex(h));
    p.dot(50, 50, 9, INK);
    p.dot(44, 44, 4, PAPER);
  },
  brush: (p, h) => {
    p.line(26, 76, 62, 32, 8, shade(h, -0.35));
    p.poly([[56, 26], [74, 40], [64, 52], [50, 38]], hex(h));
    p.dot(24, 78, 8, shade(h, 0.35));
  },
  bulb: (p, h) => {
    p.dot(50, 44, 22, hex(h));
    p.box(50, 70, 20, 16, 5, shade(h, -0.35));
    for (const a of [-1.1, -0.5, 0.5, 1.1]) {
      p.line(50 + Math.sin(a) * 30, 44 - Math.cos(a) * 30, 50 + Math.sin(a) * 40, 44 - Math.cos(a) * 40, 5, shade(h, 0.25));
    }
  },
  gem: (p, h) => {
    p.poly([[50, 18], [80, 44], [50, 82], [20, 44]], hex(h));
    p.poly([[50, 18], [80, 44], [50, 44]], shade(h, 0.45));
    p.poly([[50, 44], [80, 44], [50, 82]], shade(h, -0.2));
  },
  pixel: (p, h) => {
    p.box(50, 50, 66, 66, 8, shade(h, 0.65));
    p.box(38, 38, 22, 22, 2, hex(h));
    p.box(62, 62, 22, 22, 2, shade(h, -0.15));
  },
  mural: (p, h) => {
    p.box(50, 50, 74, 58, 6, shade(h, -0.35));
    const cols = [hex(h), shade(h, 0.5), '#7ac74f', '#4fb3e8', '#f2b64a', shade(h, 0.2)];
    let i = 0;
    for (const y of [36, 52, 68]) for (const x of [30, 50, 70]) p.box(x, y, 16, 12, 2, cols[i++ % cols.length]);
  },
  party: (p, h) => {
    p.poly([[50, 16], [72, 72], [28, 72]], hex(h));
    p.poly([[50, 16], [72, 72], [50, 72]], shade(h, -0.2));
    p.dot(50, 14, 7, shade(h, 0.5));
    for (const [x, y] of [[42, 44], [58, 56], [46, 62]]) p.dot(x, y, 5, PAPER);
  },
  confetti: (p, h) => {
    const cols = [hex(h), '#4fb3e8', '#7ac74f', '#f2b64a', '#e8657a'];
    let i = 0;
    for (const [x, y, r] of [[26, 30, 0.4], [50, 22, -0.6], [74, 34, 0.8], [34, 62, -0.3], [62, 68, 0.5], [50, 48, 0.1]]) {
      p.c.save(); p.c.translate(x, y); p.c.rotate(r);
      p.box(0, 0, 18, 9, 3, cols[i++ % cols.length]);
      p.c.restore();
    }
  },
  aurora: (p, h) => {
    p.box(50, 74, 84, 26, 6, shade(h, -0.45));
    for (let i = 0; i < 3; i++) {
      p.c.save();
      p.c.beginPath();
      p.c.moveTo(18, 60 - i * 6);
      p.c.bezierCurveTo(38, 24 - i * 8, 62, 62 - i * 6, 84, 22 - i * 7);
      p.c.strokeStyle = [hex(h), '#7ac74f', '#e8657a'][i];
      p.c.lineWidth = 8 - i * 2;
      p.c.lineCap = 'round';
      p.c.stroke();
      p.c.restore();
    }
    p.dot(24, 22, 3, PAPER); p.dot(76, 46, 3, PAPER);
  },
  sun: (p, h) => {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      p.line(50 + Math.cos(a) * 24, 50 + Math.sin(a) * 24, 50 + Math.cos(a) * 38, 50 + Math.sin(a) * 38, 6, shade(h, 0.3));
    }
    p.dot(50, 50, 22, hex(h));
    p.dot(43, 44, 6, shade(h, 0.5));
  },
  rain: (p, h) => {
    p.dot(38, 40, 16, shade(h, 0.5));
    p.dot(58, 36, 20, shade(h, 0.55));
    p.dot(68, 46, 13, shade(h, 0.45));
    for (const [x, y] of [[34, 66], [50, 72], [66, 64]]) {
      p.poly([[x, y], [x + 5, y + 12], [x - 5, y + 12]], hex(h));
    }
  },
  snowball: (p, h) => {
    p.dot(52, 52, 24, shade(h, 0.45));
    p.dot(44, 44, 8, PAPER);
    for (const [x, y, r] of [[20, 26, 5], [80, 30, 4], [24, 78, 4]]) p.dot(x, y, r, shade(h, 0.2));
  },
  ball: (p, h) => {
    p.dot(50, 50, 30, PAPER);
    p.c.save();
    p.c.beginPath(); p.c.arc(50, 50, 30, 0, Math.PI * 2); p.c.clip();
    p.poly([[50, 50], [92, 22], [92, 54]], hex(h));
    p.poly([[50, 50], [12, 62], [58, 88]], '#4fb3e8');
    p.poly([[50, 50], [22, 14], [58, 12]], '#f2b64a');
    p.c.restore();
    p.arc(50, 50, 30, 0, Math.PI * 2, 4, INK);
  },
  bonfire: (p, h) => {
    p.line(26, 74, 74, 62, 9, '#8a6642');
    p.line(26, 62, 74, 74, 9, '#6b4f35');
    p.poly([[50, 18], [66, 50], [50, 62], [34, 50]], hex(h));
    p.poly([[50, 30], [59, 52], [50, 60], [41, 52]], shade(h, 0.5));
  },
  bubbles: (p, h) => {
    p.dot(40, 62, 20, hex(h));
    p.dot(33, 55, 6, PAPER);
    p.dot(68, 38, 12, shade(h, 0.35));
    p.dot(74, 66, 8, shade(h, 0.5));
  },
  whale: (p, h) => {
    p.oval(46, 54, 32, 19, hex(h));
    p.poly([[74, 52], [92, 36], [88, 62]], shade(h, -0.2));
    p.oval(42, 64, 22, 9, shade(h, 0.5));
    p.dot(26, 50, 4, INK);
    p.line(40, 34, 40, 20, 5, shade(h, 0.5));
    p.dot(40, 18, 5, shade(h, 0.6));
  },
  jelly: (p, h) => {
    p.c.beginPath(); p.c.arc(50, 44, 24, Math.PI, 0); p.c.closePath();
    p.c.fillStyle = hex(h); p.c.fill();
    for (const x of [34, 44, 56, 66]) {
      p.c.beginPath(); p.c.moveTo(x, 44);
      p.c.quadraticCurveTo(x + 8, 60, x - 3, 78);
      p.c.strokeStyle = shade(h, 0.35); p.c.lineWidth = 5; p.c.lineCap = 'round'; p.c.stroke();
    }
    p.dot(42, 36, 5, PAPER);
  },
  bottle: (p, h) => {
    p.box(50, 60, 34, 44, 12, shade(h, 0.3));
    p.box(50, 28, 14, 24, 5, shade(h, 0.3));
    p.box(50, 16, 16, 8, 3, '#8a6642');
    p.box(50, 60, 20, 26, 3, PAPER);
    p.line(43, 54, 57, 54, 3, shade(h, -0.3));
    p.line(43, 62, 53, 62, 3, shade(h, -0.3));
  },
  turtle: (p, h) => {
    p.oval(50, 52, 30, 22, hex(h));
    p.oval(50, 52, 12, 9, shade(h, -0.25));
    for (const [x, y] of [[32, 38], [68, 38], [32, 66], [68, 66]]) p.oval(x, y, 9, 6, shade(h, 0.35));
    p.dot(80, 46, 9, shade(h, 0.35));
    p.dot(83, 44, 3, INK);
  },
  chair: (p, h) => {
    p.box(50, 58, 52, 20, 8, hex(h));
    p.box(28, 44, 12, 34, 6, shade(h, -0.2));
    p.box(72, 44, 12, 34, 6, shade(h, -0.2));
    p.box(50, 34, 40, 12, 6, shade(h, 0.3));
    for (const x of [32, 68]) p.box(x, 74, 8, 14, 3, shade(h, -0.35));
  },
  door: (p, h) => {
    p.box(50, 52, 50, 70, 10, shade(h, -0.3));
    p.box(50, 54, 38, 58, 8, hex(h));
    p.dot(64, 56, 5, shade(h, 0.55));
    p.box(50, 26, 26, 10, 4, shade(h, 0.5));
  },
  friends: (p, h) => {
    p.dot(36, 40, 14, hex(h));
    p.c.beginPath(); p.c.arc(36, 76, 20, Math.PI, 0); p.c.closePath(); p.c.fillStyle = hex(h); p.c.fill();
    p.dot(66, 44, 12, shade(h, 0.4));
    p.c.beginPath(); p.c.arc(66, 78, 17, Math.PI, 0); p.c.closePath(); p.c.fillStyle = shade(h, 0.4); p.c.fill();
  },
  bubble: (p, h) => {
    p.box(50, 44, 70, 46, 16, hex(h));
    p.poly([[36, 64], [52, 64], [34, 80]], hex(h));
    for (const x of [36, 50, 64]) p.dot(x, 44, 5, PAPER);
  },
  compass: (p, h) => {
    p.dot(50, 50, 32, shade(h, 0.55));
    p.arc(50, 50, 32, 0, Math.PI * 2, 5, INK);
    p.poly([[50, 20], [58, 50], [50, 50], [42, 50]], hex(h));
    p.poly([[50, 80], [42, 50], [50, 50], [58, 50]], shade(h, -0.25));
    p.dot(50, 50, 5, INK);
  },
  check: (p, h) => {
    p.dot(50, 50, 32, hex(h));
    p.c.beginPath();
    p.c.moveTo(32, 52); p.c.lineTo(45, 66); p.c.lineTo(70, 34);
    p.c.strokeStyle = PAPER; p.c.lineWidth = 10; p.c.lineCap = 'round'; p.c.lineJoin = 'round'; p.c.stroke();
  },
  calendar: (p, h) => {
    p.box(50, 54, 64, 60, 8, PAPER);
    p.box(50, 32, 64, 16, 8, hex(h));
    for (const x of [36, 64]) p.line(x, 20, x, 30, 6, shade(h, -0.3));
    let i = 0;
    for (const y of [50, 66]) for (const x of [32, 50, 68]) p.box(x, y, 12, 10, 2, i++ === 4 ? hex(h) : shade(h, 0.6));
  },
  hat: (p, h) => {
    p.box(50, 66, 72, 12, 6, shade(h, -0.25));
    p.c.beginPath(); p.c.arc(50, 60, 26, Math.PI, 0); p.c.closePath(); p.c.fillStyle = hex(h); p.c.fill();
    p.box(50, 52, 54, 10, 5, shade(h, 0.5));
  },
  crown: (p, h) => {
    p.poly([[22, 68], [28, 30], [40, 48], [50, 24], [60, 48], [72, 30], [78, 68]], hex(h));
    p.box(50, 72, 58, 12, 5, shade(h, -0.2));
    for (const [x, y] of [[28, 28], [50, 22], [72, 28]]) p.dot(x, y, 6, shade(h, 0.5));
    p.dot(50, 60, 7, '#e8657a');
  },
  // milestone-only glyphs
  gramo: (p, h) => {
    p.box(50, 74, 56, 18, 6, '#8a6642');
    p.oval(46, 64, 20, 7, shade(h, -0.3));
    p.c.save(); p.c.translate(62, 44); p.c.rotate(0.5);
    p.poly([[-6, 22], [6, 22], [24, -20], [-24, -20]], hex(h));
    p.c.restore();
    p.dot(46, 64, 4, PAPER);
  },
  pick: (p, h) => {
    p.line(28, 76, 72, 30, 8, '#8a6642');
    p.c.save(); p.c.translate(70, 28); p.c.rotate(-0.5);
    p.poly([[-30, 0], [0, -10], [30, 0], [0, 8]], hex(h));
    p.c.restore();
    p.dot(38, 62, 5, shade(h, 0.5));
  },
  ribbon: (p, h) => {
    p.dot(50, 40, 22, hex(h));
    p.dot(50, 40, 13, shade(h, 0.5));
    p.poly([[34, 56], [46, 56], [42, 86], [30, 76]], shade(h, -0.15));
    p.poly([[54, 56], [66, 56], [70, 76], [58, 86]], shade(h, -0.15));
  },
};
/* eslint-enable no-unused-vars */

/**
 * Draw one stamp into a 2D context that has already been scaled so the drawing
 * box is `size` across. `earned` false gives the ghost: paper turned to dust,
 * art reduced to a silhouette, a dashed edge where the perforation would be.
 */
export function drawStamp(ctx, size, stamp, earned) {
  const s = size / 100;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const hue = stamp?.hue ?? 0xe8657a;
  const art = stamp?.glyph && Object.prototype.hasOwnProperty.call(GLYPH_ART, stamp.glyph)
    ? GLYPH_ART[stamp.glyph] : null;

  // paper
  const pen = makePen(ctx);
  pen.box(50, 50, 92, 92, 10, earned ? PAPER : '#efe7d6');
  // a tinted field so each stamp reads as its own little poster
  ctx.save();
  pen.box(50, 50, 82, 82, 7, earned ? shade(hue, 0.6) : '#e6ddca');
  ctx.restore();

  if (earned) {
    ctx.save();
    ctx.translate(50, 50);
    // the glyph fills the field: these are read at 46px on a quest card
    ctx.scale(0.86, 0.86);
    ctx.translate(-50, -50);
    if (art) art(pen, hue);
    else pen.star(50, 50, 30, 5, hex(hue));
    ctx.restore();
    // postmark: two rings in the corner, like the cove's own franking
    ctx.save();
    ctx.globalAlpha = 0.17;
    pen.arc(79, 25, 12, 0, Math.PI * 2, 3, INK);
    pen.arc(79, 25, 7, 0, Math.PI * 2, 3, INK);
    ctx.restore();
  } else {
    ctx.save();
    ctx.globalAlpha = 0.3;
    pen.box(50, 50, 30, 44, 14, '#b9ae95');
    pen.dot(50, 40, 9, '#efe7d6');
    ctx.fillStyle = '#8f846c';
    ctx.font = '900 34px "Trebuchet MS", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 50, 54);
    ctx.restore();
  }

  // ink edge inside the paper
  ctx.globalAlpha = earned ? 0.75 : 0.35;
  pen.box(50, 50, 84, 84, 8, 'rgba(0,0,0,0)');
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.setLineDash(earned ? [] : [5, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // punch the perforation last so it eats paper, not background: this is the
  // one thing that makes the shape read as a stamp rather than a rounded tile
  ctx.globalCompositeOperation = 'destination-out';
  const N = 8;
  for (let i = 0; i < N; i++) {
    const t = 6 + (i / (N - 1)) * 88;
    for (const [x, y] of [[t, 5], [t, 95], [5, t], [95, t]]) {
      ctx.beginPath();
      ctx.arc(x, y, 5.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

/** Size a canvas for the display and paint one stamp into it. */
export function paintStampCanvas(canvas, stamp, earned, px) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = Math.round(px * dpr);
  canvas.height = Math.round(px * dpr);
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, px, px);
  drawStamp(ctx, px, stamp, earned);
}

// ---------------------------------------------------------------------------
// reporting + moderation (wave 10C, N-10 + the ergonomic half of N-04)
//
// Both live on the card for the same reason: the operator, and the player, are
// ALREADY looking at the capybara they mean. A separate console is a console
// nobody opens mid-incident (accounts-admin.md section 2.4 item 3).
// ---------------------------------------------------------------------------

/**
 * The reason vocabulary. `id` is what travels; the label and the line under it
 * are the whole moderation policy as far as most players will ever read it, so
 * they are written for an adult audience that is here for the nostalgia:
 * slurs and harassment are named, "he swore" is deliberately not a category.
 *
 * THE IDS ARE PINNED TO server/reports.js's REASONS. An id that is not on that
 * list is not refused — the server files it as 'other' and keeps the original
 * in the note — but it also stops being countable, and a queue you cannot count
 * is a queue nobody triages. If that list changes, this one changes with it.
 * ('bullying' is the stored id; 'Harassment' is what an adult calls it.)
 */
export const REPORT_REASONS = [
  ['language', 'Slurs or hate speech', 'Aimed at who someone is.'],
  ['bullying', 'Harassment', 'Following, targeting, piling on.'],
  ['spam', 'Spam or ads', 'Flooding, links, selling things.'],
  ['name', 'Their name', 'The name itself is the problem.'],
  ['cheating', 'Cheating', 'Coin farming, exploits, rigged scores.'],
  ['other', 'Something else', 'Tell the keepers what happened.'],
].map(([id, name, desc]) => ({ id, name, desc }));

/**
 * reason -> the store's `kind`, which is what decides the evidence the SERVER
 * freezes onto the report (server/reports.js buildEvidence). 'chat', 'name'
 * and 'other' all attach the reported capy's recent lines, which is the whole
 * context a caretaker needs for a player-directed report; 'player' is not a
 * kind the store knows, so sending it would land every one of these in the
 * 'other' bucket and lose the sort.
 */
const REASON_KIND = { name: 'name', cheating: 'other', other: 'other' };

/** server/reports.js NOTE_MAX is 300; ask for less than the server will take. */
const NOTE_MAX = 240;

/** One report per capybara per quarter hour, and a breath between any two. */
const REPORT_REPEAT_MS = 15 * 60_000;
const REPORT_COOLDOWN_MS = 20_000;
/** The server may be older than this build; never leave the button spinning. */
const REPORT_ANSWER_MS = 5000;

/** Keyed by uid when we have one, else the connection id: survives re-opening. */
const reportedAt = new Map();
let lastReportAt = 0;

function reportKey(who) {
  return who.uid ? `u:${who.uid}` : `c:${who.id}`;
}

/** Have we already filed against THIS capy inside the repeat window? */
function reportedRecently(who, now = Date.now()) {
  return now - (reportedAt.get(reportKey(who)) || 0) < REPORT_REPEAT_MS;
}

/** '' when a report may go now, otherwise the sentence explaining why not. */
function reportBlocked(who, now = Date.now()) {
  if (reportedRecently(who, now)) {
    return 'You have already reported them. The keepers have it, and a second copy does not make it louder.';
  }
  if (now - lastReportAt < REPORT_COOLDOWN_MS) return 'Give the last report a moment to land.';
  return '';
}

/** Mute/ban lengths offered on the card. The SERVER owns the per-role ceiling:
 *  it refuses what it will not do, in a sentence it has already written, so a
 *  number copied out of server/admin.js here would go stale in silence. */
const MUTE_CHIPS = [['10m', 10], ['1h', 60], ['6h', 360], ['24h', 1440], ['7d', 10080]];
const BAN_CHIPS = [['1h', 60], ['24h', 1440], ['7d', 10080], ['30d', 43200]];

/** Ranks, for not painting a button the rank guard is going to turn down.
 *  server/admin.js's RANK is the authority; this only decides what is drawn. */
const RANK = { player: 0, mod: 1, admin: 2 };
const rankOf = (role) => RANK[role] ?? 0;

/** "4m", "2h", "3d": a duration in a moderation drawer is glanced at. */
function shortMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

// ---------------------------------------------------------------------------
// payload parsing (server shapes are tolerated loosely on purpose)
// ---------------------------------------------------------------------------

function toRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return raw.profile && typeof raw.profile === 'object' ? { ...raw, ...raw.profile } : raw;
}

function normalizeProfile(raw) {
  const p = toRecord(raw);
  if (!p) return null;
  const id = p.id ?? p.playerId;
  const color = Number(p.color);
  return {
    id: id == null ? null : String(id),
    // The account key, when the server volunteers it. A report and every a-*
    // op resolve uid -> name -> id, so having it makes the target survive a
    // rename and a reconnect; not having it costs nothing but precision.
    uid: typeof p.uid === 'string' && p.uid ? p.uid : null,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null,
    color: Number.isFinite(color) && color > 0 ? color : null,
    hat: typeof p.hat === 'string' && Object.prototype.hasOwnProperty.call(HATS, p.hat) ? p.hat : null,
    bot: p.bot === true,
    // undefined means "the server did not say", which is not the same as guest
    registered: typeof p.registered === 'boolean' ? p.registered : null,
    room: typeof p.room === 'string' ? p.room : null,
    online: typeof p.online === 'boolean' ? p.online : null,
    bests: p.bests && typeof p.bests === 'object' ? p.bests : {},
    isFriend: typeof p.isFriend === 'boolean' ? p.isFriend
      : typeof p.friend === 'boolean' ? p.friend : null,
    // ---- profile v2 ride-alongs ------------------------------------------
    // Every one of these is OPTIONAL and every one degrades to "not drawn".
    // `charms`/`charmCount` already ship (server/charms.js profileBits rides
    // both publicProfile and the inspect frame since wave 13E); the rest are
    // the additive fields this wave asks the orchestrator for, and the card is
    // written so that a server without them looks finished rather than broken.
    charms: normalizeCharms(p),
    // ms epoch of the account's first day, for the "Day 42 in the cove" pill
    since: Number.isFinite(Number(p.since ?? p.created)) ? Number(p.since ?? p.created) : null,
    // {gameId: runs}; without it the best-of line falls back to the ladder
    plays: p.plays && typeof p.plays === 'object' ? p.plays : null,
    showcase: normalizeShowcase(p),
    // staff only: the server sends a role for a keeper, and nothing for
    // everyone else, so a missing role is a player and never a downgrade
    role: typeof p.role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_BADGE, p.role)
      ? p.role : null,
    flair: equippedFlair(p),
  };
}

/**
 * Shared with friends.js: accepts [..] or {friends:[..]} or {players:[..]}.
 * A friendship is stored by account, so the id is only the CONNECTION id of a
 * friend who happens to be online: entries keep their name and a null id when
 * they are not around, and callers gate "open their card" on the id.
 */
export function normalizeFriends(raw) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.friends) ? raw.friends
      : Array.isArray(raw?.players) ? raw.players : [];
  const out = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const id = f.id ?? f.playerId;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name && (id == null || id === '')) continue; // nothing to show or click
    const room = typeof f.room === 'string' && Object.prototype.hasOwnProperty.call(ROOM_INFO, f.room)
      ? f.room : null;
    out.push({
      id: id == null || id === '' ? null : String(id),
      name: name || 'A quiet capybara',
      online: typeof f.online === 'boolean' ? f.online : !!room,
      room,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// styles: ONE tag for both social overlays (pf- = player card, fr- = friends)
// ---------------------------------------------------------------------------

const STYLE_ID = 'capy-social-styles';

const CSS = `
.pf-overlay, .fr-overlay {
  position: absolute; inset: 0; padding: 18px; display: flex;
  align-items: center; justify-content: center;
  background: rgba(20, 32, 44, 0.55); backdrop-filter: blur(7px) saturate(1.15);
  animation: pf-fade 0.18s ease;
}
/* above the map/shop (40) and the pause menu (42); the card sits on the list */
.pf-overlay { z-index: 44; }
.fr-overlay { z-index: 43; }
.pf-overlay.is-closing, .fr-overlay.is-closing {
  opacity: 0; transition: opacity 0.15s ease; pointer-events: none;
}

.pf-card, .fr-card {
  position: relative; background: var(--cream); border: 4px solid #fff;
  border-radius: 26px; box-shadow: var(--shadow), 0 0 0 3px rgba(45, 36, 23, 0.08);
  max-height: 92vh; overflow: auto;
  animation: pf-rise 0.3s cubic-bezier(0.18, 1.15, 0.4, 1);
}
.pf-card:focus, .fr-card:focus { outline: none; }
/* wide enough that the 50-stamp album gets four columns next to the turntable */
.pf-card { width: min(608px, 94vw); padding: 22px 24px 18px; }
.fr-card { width: min(430px, 94vw); padding: 22px 22px 16px; }
.pf-x, .fr-x { position: absolute; top: 14px; right: 14px; z-index: 2; }

/* ---- player card ---- */
.pf-body { display: flex; gap: 18px; align-items: flex-start; margin-top: 2px; }
.pf-stage { width: 200px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.pf-stage-frame {
  position: relative; width: 200px; height: 232px; border-radius: 22px; overflow: hidden;
  background: radial-gradient(ellipse 72% 62% at 50% 36%, #fffaea 0%, #ffeec9 44%, #f6dda6 72%, #ecca86 100%);
  box-shadow: inset 0 -18px 30px rgba(178, 136, 64, 0.22),
    inset 0 0 0 3px rgba(255, 255, 255, 0.7), 0 6px 18px rgba(45, 36, 23, 0.14);
}
.pf-canvas { position: absolute; inset: 0; width: 200px; height: 232px; display: block; }
.pf-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(202deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0) 40%);
}
.pf-fallback {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 22px; font-weight: 800; font-size: 12.5px; color: #a3906c;
}
.pf-outfit {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  font-weight: 700; font-size: 12px; color: var(--muted); min-height: 16px;
}
.pf-dot-color {
  width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; flex: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

.pf-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
.pf-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-right: 40px; }
.pf-name {
  font-size: 24px; font-weight: 900; line-height: 1.1; letter-spacing: 0.01em;
  overflow-wrap: anywhere;
}
.pf-chip {
  font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; background: rgba(79, 179, 232, 0.2);
  color: #2f7fae; flex: none;
}
.pf-chip.is-friend { background: rgba(232, 101, 122, 0.18); color: #c0455c; }
.pf-chip.is-self { background: rgba(242, 182, 74, 0.28); color: #a4720f; }
.pf-title { font-weight: 800; font-size: 13.5px; color: var(--accent); margin-top: -4px; }
.pf-where { font-size: 12.5px; font-weight: 700; color: var(--muted); min-height: 16px; }
.pf-where b { color: var(--ink); }

.pf-section {
  font-size: 10px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase;
  color: #b6a688; margin-top: 4px;
}
.pf-medals { display: flex; flex-direction: column; gap: 7px; }
.pf-row {
  display: flex; align-items: center; gap: 11px; background: var(--card);
  border-radius: 15px; padding: 8px 13px; box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.32s backwards var(--spring); animation-delay: calc(var(--i) * 70ms);
}
.pf-medal {
  width: 30px; height: 30px; border-radius: 50%; flex: none;
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.55), 0 2px 5px rgba(45, 36, 23, 0.2);
}
.pf-medal.is-gold { background: radial-gradient(circle at 34% 28%, #fff3bd 0%, var(--gold) 58%, #c98c1d 100%); }
.pf-medal.is-silver { background: radial-gradient(circle at 34% 28%, #ffffff 0%, #c3cedb 54%, #7d8b9b 100%); }
.pf-medal.is-bronze { background: radial-gradient(circle at 34% 28%, #ffdcb6 0%, #d18b4d 58%, #96592a 100%); }
.pf-medal.is-none {
  background: rgba(45, 36, 23, 0.05);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.12);
}
.pf-row-txt { flex: 1; min-width: 0; }
.pf-row-name { font-weight: 900; font-size: 13.5px; line-height: 1.2; }
.pf-row-sub { font-size: 11px; font-weight: 700; color: #a3906c; line-height: 1.3; }
.pf-row-score { font-weight: 900; font-size: 16px; text-align: right; flex: none; }
.pf-row-score.is-empty { color: #cbbb98; font-size: 20px; line-height: 1; }

.pf-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 6px; min-height: 20px; }
.pf-fbtn {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 13.5px;
  padding: 9px 18px; border-radius: 999px; color: #fff;
  background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%);
  box-shadow: 0 4px 0 rgba(150, 55, 72, 0.32), 0 8px 18px rgba(45, 36, 23, 0.18);
  transition: scale 0.12s ease, filter 0.16s ease, background 0.2s ease;
}
.pf-fbtn:hover:not(:disabled) { scale: 1.06; filter: brightness(1.05); }
.pf-fbtn:active:not(:disabled) { scale: 0.95; }
.pf-fbtn:focus-visible { outline: 3px solid var(--accent2); outline-offset: 3px; }
.pf-fbtn.is-msg {
  background: linear-gradient(180deg, #b48ae0 0%, #9b6bd4 100%);
  box-shadow: 0 4px 0 rgba(90, 55, 140, 0.32), 0 8px 18px rgba(45, 36, 23, 0.18);
}
.pf-fbtn.is-remove {
  background: linear-gradient(180deg, #fffefa 0%, #f2e6cd 100%); color: var(--ink);
  box-shadow: 0 4px 0 rgba(45, 36, 23, 0.14), 0 8px 18px rgba(45, 36, 23, 0.14);
}
.pf-fbtn.is-den {
  background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%); color: var(--ink);
  box-shadow: 0 4px 0 rgba(158, 111, 20, 0.3), 0 8px 18px rgba(45, 36, 23, 0.16);
}
.pf-fbtn:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.pf-note {
  font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.4;
  background: rgba(45, 36, 23, 0.05); border-radius: 12px; padding: 8px 12px; flex: 1; min-width: 160px;
}
.pf-note b { color: var(--ink); }

/* ---- report + moderate (wave 10C) ----------------------------------------
   Two drawers that open under the action row, never a second overlay: the
   whole point of doing this here is that you are already looking at the capy. */
.pf-fbtn.is-report {
  background: linear-gradient(180deg, #fffefa 0%, #f6e3e5 100%); color: #a3565f;
  box-shadow: 0 4px 0 rgba(150, 80, 90, 0.18), 0 8px 18px rgba(45, 36, 23, 0.12);
  font-size: 12.5px; padding: 8px 15px;
}
.pf-fbtn.is-mod {
  background: linear-gradient(180deg, #8fd0f2 0%, var(--accent2) 100%); color: #fff;
  box-shadow: 0 4px 0 rgba(38, 116, 160, 0.32), 0 8px 18px rgba(45, 36, 23, 0.16);
  font-size: 12.5px; padding: 8px 15px;
}

.pf-drawer[hidden] { display: none; }
.pf-drawer {
  margin-top: 9px; padding: 11px 13px 12px; border-radius: 16px;
  background: rgba(45, 36, 23, 0.05); box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.07);
  animation: pf-pop 0.26s backwards var(--spring);
}
.pf-drawer.is-report { background: rgba(232, 101, 122, 0.09); box-shadow: inset 0 0 0 2px rgba(232, 101, 122, 0.2); }
.pf-drawer.is-pick { background: rgba(242, 182, 74, 0.13); box-shadow: inset 0 0 0 2px rgba(242, 182, 74, 0.34); }
.pf-drawer.is-mod { background: rgba(79, 179, 232, 0.1); box-shadow: inset 0 0 0 2px rgba(79, 179, 232, 0.26); }
.pf-dr-h { display: flex; align-items: center; gap: 7px; font-weight: 900; font-size: 13px; margin-bottom: 8px; }
.pf-dr-h b { color: var(--accent); overflow-wrap: anywhere; }
.pf-dr-sub { font-size: 11.5px; font-weight: 700; color: var(--muted); line-height: 1.45; margin-bottom: 8px; }
.pf-dr-sub b { color: var(--ink); }

/* small chunky button, the drawer's workhorse */
.pf-sb {
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 900; font-size: 11px;
  letter-spacing: 0.03em; padding: 6px 11px; border-radius: 999px; color: var(--ink);
  background: linear-gradient(180deg, #fffefa 0%, #fdf1da 100%);
  box-shadow: 0 2px 0 rgba(45, 36, 23, 0.14);
  transition: scale 0.12s ease, filter 0.16s ease;
}
.pf-sb:hover:not(:disabled) { scale: 1.06; filter: brightness(1.04); }
.pf-sb:active:not(:disabled) { scale: 0.94; }
.pf-sb:disabled { opacity: 0.45; cursor: default; box-shadow: none; }
.pf-sb:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.pf-sb.on { background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%); color: #fff; }
.pf-sb.warm { background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%); box-shadow: 0 2px 0 rgba(158, 111, 20, 0.32); }
.pf-sb.hot { background: linear-gradient(180deg, #f07f90 0%, var(--accent) 100%); color: #fff; box-shadow: 0 2px 0 rgba(150, 55, 72, 0.35); }
.pf-sb.calm { background: linear-gradient(180deg, #8fd0f2 0%, var(--accent2) 100%); color: #fff; box-shadow: 0 2px 0 rgba(38, 116, 160, 0.32); }
.pf-dr-x { margin-left: auto; }

/* the reason picker: a grid of little cards, one tap each */
.pf-reasons { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 5px; }
.pf-reason {
  border: 0; cursor: pointer; font-family: var(--font); text-align: left; color: var(--ink);
  background: #fffdf6; border-radius: 12px; padding: 7px 10px;
  box-shadow: 0 2px 0 rgba(45, 36, 23, 0.1);
  transition: scale 0.12s ease, box-shadow 0.16s ease, background 0.16s ease;
}
.pf-reason:hover { scale: 1.02; background: #fff; }
.pf-reason:active { scale: 0.97; }
.pf-reason:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.pf-reason.on { background: var(--accent); box-shadow: 0 2px 0 rgba(150, 55, 72, 0.35); }
.pf-reason.on .pf-reason-n, .pf-reason.on .pf-reason-d { color: #fff; }
.pf-reason-n { display: block; font-weight: 900; font-size: 11.5px; line-height: 1.2; }
.pf-reason-d { display: block; font-weight: 700; font-size: 10px; color: #a3906c; line-height: 1.3; margin-top: 2px; }

.pf-why {
  width: 100%; border: 0; border-radius: 12px; padding: 8px 11px; margin-top: 8px;
  background: #fff; font-family: var(--font); font-weight: 700; font-size: 12px; color: var(--ink);
  box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.08);
}
.pf-why:focus { outline: none; box-shadow: inset 0 0 0 2px var(--accent2); }
.pf-dr-btns { display: flex; gap: 6px; margin-top: 8px; }
.pf-dr-btns .pf-sb { flex: 1; font-size: 12px; padding: 8px 10px; }
.pf-dr-foot { font-size: 10px; font-weight: 700; color: #b6a688; line-height: 1.45; margin-top: 8px; }

/* moderate */
.pf-mod-row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.pf-mod-facts { display: grid; grid-template-columns: 78px 1fr; gap: 1px 8px; font-size: 11px; margin-bottom: 8px; }
.pf-mod-facts dt { font-weight: 800; color: #a3906c; }
.pf-mod-facts dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; font-family: ui-monospace, Consolas, monospace; }
.pf-mod-chip {
  font-size: 8.5px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; flex: none;
}
.pf-mod-chip.role { background: rgba(232, 101, 122, 0.16); color: #b34156; }
.pf-mod-chip.guest { background: rgba(45, 36, 23, 0.08); color: #8a7a5a; }
.pf-mod-chip.mute { background: rgba(242, 182, 74, 0.3); color: #8a6a1f; }
.pf-mod-chip.ban { background: rgba(232, 101, 122, 0.28); color: #a32f47; }
.pf-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 2px; }

/* ---- friends list ---- */
.fr-head { display: flex; align-items: baseline; gap: 9px; padding-right: 44px; }
.fr-head h2 { font-size: 24px; margin: 0; color: var(--accent); letter-spacing: 0.02em; }
.fr-count { font-size: 12px; font-weight: 800; color: var(--muted); }
.fr-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; margin: 2px 0 12px; }
.fr-list { display: flex; flex-direction: column; gap: 7px; max-height: 46vh; overflow-y: auto; padding: 2px; }
.fr-row {
  display: flex; align-items: center; gap: 11px; width: 100%; text-align: left;
  border: 0; font-family: var(--font); cursor: pointer; background: var(--card);
  border-radius: 15px; padding: 10px 13px; color: var(--ink);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  transition: transform 0.14s ease, box-shadow 0.16s ease, background 0.16s ease;
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 45ms);
}
.fr-row:hover { transform: translateY(-2px); background: #fffdf2; box-shadow: 0 7px 14px rgba(45, 36, 23, 0.14); }
.fr-row:active { transform: translateY(0); }
.fr-row:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.fr-dot {
  position: relative; width: 11px; height: 11px; border-radius: 50%; flex: none;
  background: #c8bda4; box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6);
}
.fr-dot.is-on { background: #6fcf5f; }
.fr-dot.is-on::after {
  content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 2px solid rgba(111, 207, 95, 0.7); animation: fr-ping 2.6s ease-out infinite;
}
/* a row is the card button plus, for anyone who is around, a den door on top */
.fr-item { position: relative; }
.fr-item.has-den .fr-row { padding-right: 54px; }
.fr-den {
  position: absolute; right: 10px; top: 50%; translate: 0 -50%;
  width: 34px; height: 34px; border: 0; border-radius: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font); font-size: 15px; line-height: 1; color: var(--ink);
  background: linear-gradient(180deg, #fffefa 0%, #f4e7cd 100%);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.14), 0 6px 12px rgba(45, 36, 23, 0.12);
  transition: scale 0.12s ease, translate 0.14s ease, filter 0.16s ease;
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 45ms + 70ms);
}
/* the row lifts on hover; the door rides along instead of peeling off it */
.fr-item:hover .fr-den { translate: 0 calc(-50% - 2px); }
.fr-den:hover { scale: 1.1; filter: brightness(1.05); }
.fr-den:active { scale: 0.93; }
.fr-den:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.fr-txt { flex: 1; min-width: 0; }
.fr-name { font-weight: 900; font-size: 14px; line-height: 1.2; overflow-wrap: anywhere; }
.fr-where { font-size: 11.5px; font-weight: 700; color: #a3906c; }
.fr-go { font-size: 11px; font-weight: 900; color: var(--accent2); letter-spacing: 0.06em; flex: none; }
.fr-empty { text-align: center; padding: 20px 14px 10px; }
/* a little capy face, drawn in gradients: nobody likes an empty box */
.fr-empty-art {
  position: relative; width: 72px; height: 72px; margin: 6px auto 16px; border-radius: 50%;
  background:
    radial-gradient(circle 3.5px at 37% 45%, #2d2417 98%, transparent 100%),
    radial-gradient(circle 3.5px at 63% 45%, #2d2417 98%, transparent 100%),
    radial-gradient(circle 3px at 50% 62%, #4a3524 98%, transparent 100%),
    radial-gradient(ellipse 17px 12px at 50% 68%, #c9a06b 98%, transparent 100%),
    radial-gradient(circle at 38% 30%, #ffeec9 0%, #e8c78e 62%, #cfa86d 100%);
  box-shadow: inset 0 -7px 13px rgba(150, 110, 55, 0.28), 0 5px 13px rgba(45, 36, 23, 0.16);
  animation: fr-bob 3.4s ease-in-out infinite;
}
.fr-empty-art::before, .fr-empty-art::after {
  content: ''; position: absolute; top: -5px; width: 17px; height: 15px; border-radius: 50%;
  background: #e0bd85; box-shadow: inset 0 -3px 5px rgba(150, 110, 55, 0.3);
}
.fr-empty-art::before { left: 3px; }
.fr-empty-art::after { right: 3px; }
.fr-empty h3 { font-size: 16px; margin-bottom: 6px; }
.fr-empty p { font-size: 12.5px; font-weight: 700; color: var(--muted); line-height: 1.5; }
.fr-foot { margin-top: 12px; font-size: 11.5px; font-weight: 700; color: #b6a688; text-align: center; }

/* friends HUD button badge */
.fr-hud-badge {
  position: absolute; top: -4px; right: -4px; min-width: 19px; height: 19px; padding: 0 5px;
  border-radius: 999px; background: var(--accent); color: #fff; border: 2px solid var(--cream);
  font-size: 10px; font-weight: 900; line-height: 15px; text-align: center; pointer-events: none;
  animation: pf-pop 0.34s var(--spring);
}

/* ---- stamp album (wave 7) ---- */
.pf-tabs { display: flex; gap: 5px; margin-top: 6px; }
.pf-tab {
  flex: 1; border: 0; cursor: pointer; font-family: var(--font); color: #a3906c;
  font-size: 9.5px; font-weight: 900; letter-spacing: 0.04em; text-transform: uppercase;
  padding: 7px 4px; border-radius: 999px; background: rgba(45, 36, 23, 0.06);
  white-space: nowrap;
  transition: background 0.16s ease, color 0.16s ease, scale 0.12s ease;
}
.pf-tab:hover { background: rgba(45, 36, 23, 0.11); }
.pf-tab:active { scale: 0.96; }
.pf-tab.is-on { background: var(--gold); color: #6b4c0c; box-shadow: 0 3px 0 rgba(158, 111, 20, 0.28); }
.pf-tab:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.pf-pane[hidden] { display: none; }

.pf-album-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-size: 11.5px; font-weight: 800; color: #a3906c;
}
.pf-album-head b { font-size: 15px; color: var(--ink); }
.pf-mile {
  margin: 8px 0 10px; background: var(--card); border-radius: 15px; padding: 11px 13px 9px;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
}
.pf-mile-top { font-size: 11px; font-weight: 800; color: var(--muted); margin-bottom: 8px; }
.pf-mile-top b { color: var(--accent); }
.pf-mile-bar {
  position: relative; height: 9px; border-radius: 999px; background: rgba(45, 36, 23, 0.1);
  margin: 0 6px 4px;
}
.pf-mile-fill {
  position: absolute; inset: 0 auto 0 0; border-radius: 999px; width: 0;
  background: linear-gradient(90deg, var(--gold) 0%, var(--accent) 100%);
  transition: width 0.6s var(--spring);
}
.pf-mile-nodes { position: relative; height: 44px; margin: 0 6px; }
.pf-mile-node {
  position: absolute; top: -12px; translate: -50% 0; width: 30px; text-align: center;
}
.pf-mile-node canvas { display: block; margin: 0 auto; filter: grayscale(1) opacity(0.42); }
.pf-mile-node.is-hit canvas { filter: none; }
.pf-mile-node span {
  display: block; font-size: 9.5px; font-weight: 900; color: #b6a688; margin-top: 1px;
}
.pf-mile-node.is-hit span { color: var(--accent); }

.pf-album {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
  gap: 7px; max-height: 40vh; overflow-y: auto; padding: 3px;
}
.pf-stamp {
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 5px 3px 6px; border-radius: 13px; background: var(--card); border: 0;
  font-family: var(--font); cursor: default; color: var(--ink);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 18ms);
}
.pf-stamp.is-earned { cursor: help; }
.pf-stamp canvas { display: block; }
.pf-stamp-name {
  font-size: 9.5px; font-weight: 900; line-height: 1.15; text-align: center;
  color: #a3906c; overflow-wrap: anywhere;
}
.pf-stamp.is-earned .pf-stamp-name { color: var(--ink); }
.pf-album-empty {
  grid-column: 1 / -1; text-align: center; font-size: 12px; font-weight: 700;
  color: var(--muted); padding: 16px 10px; line-height: 1.5;
}

/* ---- profile v2: header, showcase, charm board, best-of ------------------ */

/* the staff badge. Ribbon-shaped and gold-on-ink so it reads as an office,
   not as a decoration somebody bought. */
.pf-badge {
  font-size: 9px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase;
  padding: 4px 10px; border-radius: 999px; flex: none; color: #fff5d8;
  background: linear-gradient(180deg, #6b4f35 0%, #4a3524 100%);
  box-shadow: inset 0 0 0 1.5px rgba(242, 182, 74, 0.7), 0 2px 5px rgba(45, 36, 23, 0.24);
}
.pf-badge.is-admin { background: linear-gradient(180deg, #b0567a 0%, #7d3252 100%); }

/* the fact strip under the title: three or four little pills of "who is this" */
.pf-facts { display: flex; gap: 5px; flex-wrap: wrap; }
.pf-fact {
  display: inline-flex; align-items: baseline; gap: 4px;
  font-size: 10.5px; font-weight: 800; color: #8f7d5c;
  background: rgba(45, 36, 23, 0.06); border-radius: 999px; padding: 4px 10px;
}
.pf-fact b { font-size: 12px; font-weight: 900; color: var(--ink); }
.pf-fact.is-flair { background: rgba(155, 107, 212, 0.16); color: #6b4796; }
.pf-fact.is-flair b { color: #4f3172; }
.pf-fact-swatch {
  width: 9px; height: 9px; border-radius: 50%; align-self: center;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.75), 0 0 7px currentColor;
}

/* ---- showcase: the three stamps they chose to be known for --------------- */
.pf-show { margin-top: 2px; }
.pf-show-row { display: flex; gap: 8px; align-items: stretch; }
.pf-slot {
  flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 8px 4px 7px; border-radius: 16px; background: var(--card); border: 0;
  font-family: var(--font); color: var(--ink); text-align: center;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.34s backwards var(--spring); animation-delay: calc(var(--i) * 80ms);
}
/* a filled slot is a little display case: warm light behind the paper */
.pf-slot.is-full {
  background: radial-gradient(ellipse 80% 70% at 50% 34%, #fffaea 0%, #ffeec9 62%, #f7e0ad 100%);
  box-shadow: 0 3px 0 rgba(158, 111, 20, 0.18), inset 0 0 0 2px rgba(255, 255, 255, 0.75);
}
.pf-slot.is-empty { background: rgba(45, 36, 23, 0.045); box-shadow: inset 0 0 0 2px rgba(45, 36, 23, 0.07); }
.pf-slot canvas { display: block; }
.pf-slot-name {
  font-size: 10px; font-weight: 900; line-height: 1.15; color: var(--ink); overflow-wrap: anywhere;
}
.pf-slot.is-empty .pf-slot-name { color: #b6a688; }
.pf-slot-hole {
  width: 58px; height: 58px; border-radius: 14px; display: flex; align-items: center;
  justify-content: center; font-size: 22px; font-weight: 900; color: #cbbb98;
  box-shadow: inset 0 0 0 2.5px rgba(45, 36, 23, 0.12);
}
button.pf-slot { cursor: pointer; transition: transform 0.14s ease, box-shadow 0.16s ease; }
button.pf-slot:hover { transform: translateY(-2px); box-shadow: 0 7px 14px rgba(45, 36, 23, 0.16); }
button.pf-slot:active { transform: translateY(0); }
button.pf-slot:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }

.pf-sub-head {
  display: flex; align-items: baseline; gap: 8px; margin-top: 6px;
}
.pf-sub-head .pf-section { margin-top: 0; }
.pf-sub-note { font-size: 10.5px; font-weight: 700; color: #b6a688; margin-left: auto; }

/* the picker drawer reuses the report drawer's shell */
.pf-pick-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
  gap: 6px; max-height: 30vh; overflow-y: auto; padding: 2px;
}
.pf-pick {
  border: 0; cursor: pointer; font-family: var(--font); color: var(--ink);
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 4px 2px 5px; border-radius: 12px; background: #fffdf6;
  box-shadow: 0 2px 0 rgba(45, 36, 23, 0.1);
  transition: scale 0.12s ease, box-shadow 0.16s ease;
}
.pf-pick:hover { scale: 1.04; }
.pf-pick:active { scale: 0.95; }
.pf-pick:focus-visible { outline: 3px solid var(--accent2); outline-offset: 2px; }
.pf-pick.on { background: linear-gradient(180deg, #ffd98a 0%, var(--gold) 100%); box-shadow: 0 2px 0 rgba(158, 111, 20, 0.34); }
.pf-pick span { font-size: 8.5px; font-weight: 900; line-height: 1.1; text-align: center; overflow-wrap: anywhere; }

/* ---- charm hunt board ---------------------------------------------------- */
.pf-charm-week {
  display: flex; align-items: center; gap: 11px; border-radius: 16px; padding: 10px 13px;
  background: linear-gradient(180deg, #fffdf4 0%, #f8ecd2 100%);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.07);
}
.pf-charm-week.is-found {
  background: linear-gradient(180deg, #fff7dd 0%, #ffe6ac 100%);
  box-shadow: 0 3px 0 rgba(158, 111, 20, 0.22);
}
.pf-charm-orb {
  position: relative; width: 34px; height: 34px; border-radius: 50%; flex: none;
  background: radial-gradient(circle at 34% 28%, #fffdf2 0%, #d9cbaa 62%, #b5a684 100%);
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6), 0 2px 5px rgba(45, 36, 23, 0.2);
}
.pf-charm-week.is-found .pf-charm-orb {
  background: radial-gradient(circle at 34% 28%, #fff6c9 0%, var(--gold) 58%, #c98c1d 100%);
}
.pf-charm-week.is-found .pf-charm-orb::after {
  content: ''; position: absolute; inset: -5px; border-radius: 50%;
  border: 2px solid rgba(242, 182, 74, 0.55); animation: fr-ping 3.2s ease-out infinite;
}
.pf-charm-txt { flex: 1; min-width: 0; }
.pf-charm-name { font-weight: 900; font-size: 13.5px; line-height: 1.2; overflow-wrap: anywhere; }
.pf-charm-sub { font-size: 11px; font-weight: 700; color: #a3906c; line-height: 1.35; }
.pf-charm-sub b { color: var(--ink); }
.pf-charm-tally { font-weight: 900; font-size: 20px; line-height: 1; flex: none; color: var(--accent); }
.pf-charm-tally small { display: block; font-size: 9px; letter-spacing: 0.08em; color: #b6a688; text-transform: uppercase; }

.pf-charm-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(74px, 1fr));
  gap: 6px; max-height: 32vh; overflow-y: auto; padding: 2px; margin-top: 2px;
}
.pf-charm-tile {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 8px 5px; border-radius: 14px; background: var(--card); text-align: center;
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
  animation: pf-pop 0.3s backwards var(--spring); animation-delay: calc(var(--i) * 24ms);
}
.pf-charm-bead {
  width: 26px; height: 26px; border-radius: 50%;
  background: radial-gradient(circle at 34% 28%, #fff6c9 0%, var(--gold) 56%, #b8801a 100%);
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.5), 0 2px 4px rgba(45, 36, 23, 0.18);
}
.pf-charm-tile b { font-size: 9.5px; font-weight: 900; line-height: 1.15; overflow-wrap: anywhere; }
.pf-charm-tile span { font-size: 9px; font-weight: 800; color: #b6a688; }

/* ---- best-of ------------------------------------------------------------- */
.pf-fav {
  display: flex; align-items: center; gap: 11px; border-radius: 16px; padding: 9px 13px;
  background: linear-gradient(180deg, #fffdf6 0%, #f3ecdc 100%);
  box-shadow: 0 3px 0 rgba(45, 36, 23, 0.06);
}
.pf-fav-txt { flex: 1; min-width: 0; }
.pf-fav-k { font-size: 9.5px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; color: #b6a688; }
.pf-fav-v { font-weight: 900; font-size: 14px; line-height: 1.2; overflow-wrap: anywhere; }
.pf-fav-sub { font-size: 10.5px; font-weight: 700; color: #a3906c; }

/* ---- album shelves + the shine on a new earn ----------------------------- */
.pf-shelf { margin-top: 9px; }
.pf-shelf:first-child { margin-top: 2px; }
.pf-shelf-h { display: flex; align-items: baseline; gap: 7px; margin-bottom: 5px; }
.pf-shelf-n { font-size: 11.5px; font-weight: 900; color: var(--ink); }
.pf-shelf-c { font-size: 10px; font-weight: 800; color: #b6a688; margin-left: auto; flex: none; }
.pf-shelf-bar {
  position: relative; height: 5px; border-radius: 999px; background: rgba(45, 36, 23, 0.09);
  margin-bottom: 7px; overflow: hidden;
}
.pf-shelf-fill {
  position: absolute; inset: 0 auto 0 0; border-radius: 999px; width: 0;
  background: linear-gradient(90deg, var(--gold) 0%, var(--accent) 100%);
  transition: width 0.6s var(--spring);
}
.pf-shelf.is-done .pf-shelf-c { color: var(--accent); }
.pf-shelf .pf-album { max-height: none; overflow: visible; }
/* the album pane scrolls once, not per shelf */
.pf-shelves { max-height: 44vh; overflow-y: auto; padding: 2px; }

/* a stamp earned since you last opened the album gets one sweep of light and a
   gold edge that stays until you have looked at it. */
.pf-stamp.is-new {
  box-shadow: 0 3px 0 rgba(158, 111, 20, 0.3), 0 0 0 2px var(--gold);
}
.pf-stamp.is-new::after {
  content: ''; position: absolute; inset: 0; border-radius: 13px; pointer-events: none;
  background: linear-gradient(100deg, rgba(255, 255, 255, 0) 38%, rgba(255, 255, 255, 0.85) 50%, rgba(255, 255, 255, 0) 62%);
  background-size: 260% 100%;
  animation: pf-shine 2.6s ease-in-out infinite;
}
.pf-stamp-new-pip {
  position: absolute; top: -4px; right: -3px; padding: 1px 6px; border-radius: 999px;
  background: var(--accent); color: #fff; font-size: 8px; font-weight: 900;
  letter-spacing: 0.06em; text-transform: uppercase; border: 2px solid var(--cream);
}

@keyframes pf-shine { 0% { background-position: 130% 0; } 55%, 100% { background-position: -30% 0; } }
@keyframes pf-fade { from { opacity: 0; } }
@keyframes pf-rise { from { opacity: 0; transform: translateY(16px) scale(0.95); } }
@keyframes pf-pop { from { opacity: 0; transform: translateY(9px) scale(0.92); } }
@keyframes fr-ping { 0% { scale: 0.7; opacity: 0.9; } 70%, 100% { scale: 2.4; opacity: 0; } }
@keyframes fr-bob { 50% { transform: translateY(-5px) rotate(-3deg); } }

@media (max-width: 640px) {
  .pf-body { flex-direction: column; align-items: center; }
  .pf-info { width: 100%; }
  .pf-name-row { padding-right: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pf-card, .fr-card, .pf-row, .fr-row, .fr-den, .fr-dot.is-on::after,
  .fr-hud-badge, .fr-empty-art, .pf-stamp, .pf-drawer, .pf-slot, .pf-charm-tile,
  .pf-stamp.is-new::after, .pf-charm-week.is-found .pf-charm-orb::after { animation: none; }
  .pf-mile-fill, .pf-shelf-fill { transition: none; }
  /* the shine is the whole point of the tile, so keep the light, lose the sweep */
  .pf-stamp.is-new::after { background: rgba(255, 255, 255, 0.28); }
}
`;

/** Injects the shared pf-/fr- stylesheet once. Safe to call repeatedly. */
export function ensureSocialStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// 3D turntable (same recipe as the wardrobe mirror, smaller stage)
// ---------------------------------------------------------------------------

const PREVIEW_W = 200;
const PREVIEW_H = 232;

function buildTurntable(canvas, look) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(PREVIEW_W, PREVIEW_H, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, PREVIEW_W / PREVIEW_H, 0.1, 40);
  camera.position.set(0, 1.28, 3.6);
  camera.lookAt(0, 0.9, 0);

  scene.add(new THREE.HemisphereLight(0xfff3da, 0x8a6642, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2.4, 4.2, 3.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fd4ff, 0.45);
  rim.position.set(-3, 1.8, -2.6);
  scene.add(rim);

  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.92, 0.16, 20), makeToon(0xf0dca0));
  ped.position.y = -0.08;
  scene.add(ped);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.03, 8, 26), makeGlow(0xf2b64a));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  scene.add(ring);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const avatar = createAvatar({ color: look.color, hat: look.hat });
  turntable.add(avatar.group);
  avatar.playWave(); // say hello the moment the card opens

  let raf = 0;
  let last = 0;
  let punch = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    punch *= Math.exp(-dt * 5);
    turntable.rotation.y += dt * 0.5;
    avatar.update(dt);
    avatar.group.scale.setScalar(1 + punch * 0.12);
    ring.scale.setScalar(1 + punch * 0.1);
    renderer.render(scene, camera);
  }

  return {
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    setLook(color, hat) {
      if (color != null && color !== avatar.state.color) avatar.setColor(color);
      if (hat != null && hat !== avatar.state.hat) {
        const stale = avatar.hatAnchor.children.slice();
        avatar.setHat(hat);
        for (const o of stale) disposeObject(o);
      }
    },
    celebrate() { punch = 0.9; avatar.playWave(); },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      disposeObject(scene); // frees geometry; shared avatar/toon resources survive
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not every context supports it */ }
    },
  };
}

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

let openInstance = null;

/**
 * The last {t:'charm'} frame anyone saw, cached across cards.
 *
 * src/world/charm.js asks for it on every room build, so by the time a card is
 * opened this is nearly always warm and the charm tab paints instantly. A card
 * asks for itself only when the cache is empty (that read is budgeted server
 * side), and a server with no hunt at all simply leaves this null forever,
 * which the tab draws as a calm sentence rather than a spinner.
 */
let lastCharm = null;

function elm(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function mountPoint() {
  return document.getElementById('hud-root')
    || document.getElementById('overlay-root')
    || document.body;
}

/** Everything the net client already knows about this capybara, right now. */
function localLook(game, playerId) {
  const r = game.net?.remotes?.get?.(playerId);
  const p = r?.p;
  if (!p) return null;
  return {
    name: typeof p.name === 'string' ? p.name : null,
    color: Number.isFinite(Number(p.color)) ? Number(p.color) : null,
    hat: typeof p.hat === 'string' && Object.prototype.hasOwnProperty.call(HATS, p.hat) ? p.hat : null,
    bot: !!p.bot,
    // The flourish slot rides the world-tag snapshot (src/player/trails.js reads
    // the very same `r.p.trail` to draw it behind them), so the card can name
    // what somebody is wearing without asking the server a second time. If the
    // slot does not exist on this build, this is undefined and nothing is drawn.
    flair: equippedFlair(p),
  };
}

/**
 * Open the player card for a remote player id.
 * Re-opening for the same player is a no-op; a different player swaps cards.
 */
export function openProfile(game, playerId) {
  if (typeof document === 'undefined' || playerId == null) return;
  const id = String(playerId);
  if (openInstance) {
    if (openInstance.id === id) return;
    openInstance.close(true);
  }
  ensureSocialStyles();

  const isSelf = game.net?.selfId != null && String(game.net.selfId) === id;
  const local = localLook(game, id);

  // what we believe about them; profile-data overwrites the parts it knows
  const who = {
    id,
    uid: null, // only the server knows it; `inspect` or a-inspect fills it in
    name: isSelf ? game.state.name : (local?.name || null),
    color: isSelf ? game.state.color : (local?.color ?? null),
    hat: isSelf ? game.state.hat : (local?.hat ?? null),
    bot: !isSelf && !!local?.bot,
    registered: isSelf ? !!game.state.registered : null,
    room: isSelf ? game.roomId : (local ? game.roomId : null),
    online: isSelf ? true : (local ? true : null),
    bests: isSelf ? game.state.bests || {} : {},
    isFriend: null,
    // null means "not answered yet", which is not the same as an empty album
    stamps: isSelf && game.state.stamps ? normalizeStamps(game.state.stamps).ids : null,
    // the 40-stamp milestone title, when the server has one for them: it beats
    // the flavour line below, because it was actually earned
    title: (isSelf && typeof game.state.title === 'string' && game.state.title) || '',
    // ---- profile v2 ------------------------------------------------------
    // The charm board rides publicProfile (and the inspect frame) already, so
    // for ourselves it is on game.state the moment we are welcomed.
    charms: isSelf ? normalizeCharms(game.state) : { found: [], count: 0 },
    charmsKnown: isSelf,
    since: isSelf && Number.isFinite(Number(game.state.since ?? game.state.created))
      ? Number(game.state.since ?? game.state.created) : null,
    plays: isSelf && game.state.plays && typeof game.state.plays === 'object' ? game.state.plays : null,
    // the pick: the server's when it carries one, this browser's until then
    showcase: isSelf
      ? (normalizeShowcase(game.state) || readLocalShowcase(game.state.name))
      : null,
    // our own role we always know; a staff badge on someone ELSE needs the
    // server to volunteer it, and a card that is never told draws no badge
    role: isSelf && Object.prototype.hasOwnProperty.call(ROLE_BADGE, game.state.role)
      ? game.state.role : null,
    flair: isSelf ? equippedFlair(game.state) : (local?.flair || null),
    loaded: isSelf,
  };

  const root = elm('div', 'pf-overlay');
  root.innerHTML = `
    <div class="pf-card" role="dialog" aria-label="Player card" tabindex="-1">
      <button class="hud-btn pf-x" type="button" title="Close" aria-label="Close">&#10005;</button>
      <div class="pf-body">
        <div class="pf-stage">
          <div class="pf-stage-frame">
            <canvas class="pf-canvas"></canvas>
            <div class="pf-shine"></div>
          </div>
          <div class="pf-outfit"><span class="pf-dot-color"></span><span class="pf-outfit-txt"></span></div>
        </div>
        <div class="pf-info">
          <div>
            <div class="pf-name-row"><span class="pf-name"></span></div>
            <div class="pf-title"></div>
          </div>
          <div class="pf-facts"></div>
          <div class="pf-where"></div>
          <div class="pf-tabs">
            <button class="pf-tab is-on" type="button" data-tab="best">Highlights</button>
            <button class="pf-tab" type="button" data-tab="charms">Charm hunt</button>
            <button class="pf-tab" type="button" data-tab="album">Stamp album</button>
          </div>
          <div class="pf-pane" data-pane="best">
            <div class="pf-show">
              <div class="pf-sub-head">
                <span class="pf-section">Showcase</span><span class="pf-sub-note pf-show-note"></span>
              </div>
              <div class="pf-show-row"></div>
            </div>
            <div class="pf-sub-head"><span class="pf-section">Best of</span></div>
            <div class="pf-fav-slot"></div>
            <div class="pf-medals"></div>
          </div>
          <div class="pf-pane" data-pane="charms" hidden>
            <div class="pf-charm-week"></div>
            <div class="pf-sub-head">
              <span class="pf-section">Charms found</span><span class="pf-sub-note pf-charm-note"></span>
            </div>
            <div class="pf-charm-grid"></div>
          </div>
          <div class="pf-pane" data-pane="album" hidden>
            <div class="pf-album-head"><span>Stamps in the album</span><b class="pf-album-count">-</b></div>
            <div class="pf-mile">
              <div class="pf-mile-top"></div>
              <div class="pf-mile-bar"><i class="pf-mile-fill"></i></div>
              <div class="pf-mile-nodes"></div>
            </div>
            <div class="pf-shelves"></div>
          </div>
          <div class="pf-actions"></div>
          <div class="pf-drawer is-report" hidden></div>
          <div class="pf-drawer is-mod" hidden></div>
          <div class="pf-drawer is-pick" hidden></div>
        </div>
      </div>
    </div>
  `;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.pf-card');
  const nameRow = q('.pf-name-row');
  const nameEl = q('.pf-name');
  const titleEl = q('.pf-title');
  const whereEl = q('.pf-where');
  const medalsEl = q('.pf-medals');
  const factsEl = q('.pf-facts');
  const showRow = q('.pf-show-row');
  const showNote = q('.pf-show-note');
  const favSlot = q('.pf-fav-slot');
  const charmWeekEl = q('.pf-charm-week');
  const charmGrid = q('.pf-charm-grid');
  const charmNote = q('.pf-charm-note');
  const shelvesEl = q('.pf-shelves');
  const pickEl = q('.pf-drawer.is-pick');
  const actionsEl = q('.pf-actions');
  const outfitDot = q('.pf-dot-color');
  const outfitTxt = q('.pf-outfit-txt');
  const canvas = q('.pf-canvas');
  const albumCount = q('.pf-album-count');
  const mileTop = q('.pf-mile-top');
  const mileFill = q('.pf-mile-fill');
  const mileNodes = q('.pf-mile-nodes');
  const reportEl = q('.pf-drawer.is-report');
  const modEl = q('.pf-drawer.is-mod');

  // ---- 3D stage ------------------------------------------------------------
  let stage = null;
  try {
    stage = buildTurntable(canvas, { color: who.color ?? 0xb08a5a, hat: who.hat ?? 'none' });
    stage.start();
  } catch {
    canvas.remove();
    q('.pf-stage-frame').appendChild(
      elm('div', 'pf-fallback', 'Their portrait is still drying, but the numbers below are real.'),
    );
  }

  // ---- render --------------------------------------------------------------
  function renderHead() {
    nameEl.textContent = who.name || 'Someone friendly';
    for (const chip of [...nameRow.querySelectorAll('.pf-chip, .pf-badge')]) chip.remove();
    if (isSelf) nameRow.appendChild(elm('span', 'pf-chip is-self', 'You'));
    else if (who.bot) nameRow.appendChild(elm('span', 'pf-chip', 'Cove local'));
    else if (who.isFriend) nameRow.appendChild(elm('span', 'pf-chip is-friend', 'Friend'));
    // The staff badge sits ON the name, because knowing who the keepers are is
    // the point of it. It is drawn from a role the SERVER stated, never guessed.
    if (who.role && !who.bot) {
      const badge = elm('span', `pf-badge${who.role === 'admin' ? ' is-admin' : ''}`, ROLE_BADGE[who.role]);
      badge.title = who.role === 'admin'
        ? 'Runs the cove. Can do anything a keeper can, and then some.'
        : 'A cove keeper: they answer reports and keep the place kind.';
      nameRow.appendChild(badge);
    }
    titleEl.textContent = who.title || flavorTitle(who.bests, who.bot, isSelf);
    renderFacts();

    const roomName = who.room && Object.prototype.hasOwnProperty.call(ROOM_INFO, who.room)
      ? ROOM_INFO[who.room].name : null;
    whereEl.textContent = '';
    if (roomName) {
      whereEl.appendChild(elm('span', null, 'Hanging out in '));
      whereEl.appendChild(elm('b', null, roomName));
    } else if (who.online === false) {
      whereEl.textContent = 'Off exploring somewhere else right now.';
    } else if (who.loaded) {
      whereEl.textContent = 'Somewhere around the cove.';
    } else {
      whereEl.textContent = 'Looking them up...';
    }

    const c = who.color ?? 0xb08a5a;
    outfitDot.style.background = `#${(c >>> 0).toString(16).padStart(6, '0')}`;
    const hatName = who.hat && who.hat !== 'none' ? HATS[who.hat]?.name : null;
    outfitTxt.textContent = hatName ? `Wearing the ${hatName}` : 'No hat, all confidence';
  }

  /**
   * The fact strip under the title. Every pill is drawn only when its number is
   * REAL: a card about a capybara the server has said little about comes out
   * short, not full of dashes and zeroes. A short honest header still looks
   * designed; a header of placeholders looks broken.
   */
  function renderFacts() {
    factsEl.textContent = '';
    if (who.bot) return; // a cove local has no record and never pretends to
    const add = (value, label, cls = '', title = '') => {
      const pill = elm('span', `pf-fact${cls ? ` ${cls}` : ''}`);
      pill.append(elm('b', null, String(value)), document.createTextNode(label));
      if (title) pill.title = title;
      factsEl.appendChild(pill);
      return pill;
    };

    const day = daysInCove(who.since);
    if (day != null) add(`Day ${day}`, 'in the cove', '', 'How long they have been washing up here.');

    if (who.stamps != null) {
      add(who.stamps.length, who.stamps.length === 1 ? 'stamp' : 'stamps', '',
        'Stamps in their album. The full shelf is on the album tab.');
    }
    if (who.charmsKnown && who.charms.count > 0) {
      add(who.charms.count, who.charms.count === 1 ? 'charm' : 'charms', '',
        'Weekly charms found. Each one happened exactly once and never comes back.');
    }
    if (who.flair) {
      // reads "Aurora wake trail": the name first, because the name is the brag
      const pill = add(who.flair.name, who.flair.kind.toLowerCase(), 'is-flair',
        `They are wearing the ${who.flair.name} ${who.flair.kind.toLowerCase()}.`);
      if (who.flair.color != null) {
        const dot = elm('i', 'pf-fact-swatch');
        dot.style.color = hex(who.flair.color);
        dot.style.background = hex(who.flair.color);
        pill.prepend(dot);
      }
    }
  }

  // ---- showcase ------------------------------------------------------------
  // Three stamps, pinned above everything else. This is the part of the card
  // people decorate, so the pick belongs to the owner and to nobody else: an
  // un-picked card auto-fills with their newest, and SAYS that it did.

  function showcasePick() {
    const earned = who.stamps || [];
    const chosen = Array.isArray(who.showcase)
      ? who.showcase.filter((id) => !earned.length || earned.includes(id))
      : null;
    if (chosen && chosen.length) return { ids: chosen.slice(0, SHOWCASE_MAX), auto: false };
    return { ids: earned.slice(-SHOWCASE_MAX).reverse(), auto: true };
  }

  function renderShowcase() {
    showRow.textContent = '';
    const { ids, auto } = showcasePick();
    const canEdit = isSelf && (who.stamps || []).length > 0;

    showNote.textContent = who.stamps == null ? ''
      : canEdit ? (auto ? 'Tap a slot to pin your own' : 'Tap to change')
        : auto ? (ids.length ? 'Their newest' : '') : 'Their pick';

    for (let i = 0; i < SHOWCASE_MAX; i++) {
      const id = ids[i] || null;
      const stamp = id ? stampById(id) : null;
      const slot = elm(canEdit ? 'button' : 'div',
        `pf-slot ${stamp ? 'is-full' : 'is-empty'}`);
      slot.style.setProperty('--i', String(i));
      if (canEdit) {
        slot.type = 'button';
        slot.title = stamp ? `${stamp.name} : tap to change your showcase` : 'Pin a stamp here';
        slot.addEventListener('click', () => openPicker());
      } else if (stamp) {
        slot.title = `${stamp.name} : ${stamp.desc}`;
      }

      if (stamp) {
        const c = document.createElement('canvas');
        paintStampCanvas(c, stamp, true, 58);
        slot.appendChild(c);
        slot.appendChild(elm('div', 'pf-slot-name', stamp.name));
      } else {
        slot.appendChild(elm('div', 'pf-slot-hole', canEdit ? '+' : '·'));
        slot.appendChild(elm('div', 'pf-slot-name',
          who.stamps == null ? 'Looking' : canEdit ? 'Pin one' : 'Empty'));
      }
      showRow.appendChild(slot);
    }
  }

  /** Commit a pick: the server first (when it takes one), this browser always. */
  function saveShowcase(ids) {
    who.showcase = ids.slice(0, SHOWCASE_MAX);
    if (isSelf) {
      game.state.showcase = [...who.showcase];
      writeLocalShowcase(game.state.name, who.showcase);
      // A server without the setting drops this frame on the floor (there is no
      // default case in the switch), which is exactly the degrade we want: the
      // pin still works, it just stops travelling to other people's cards.
      if (game.net?.connected) {
        try { game.net.send({ t: 'profile-set', showcase: [...who.showcase] }); } catch { /* closing socket */ }
      }
    }
    renderShowcase();
  }

  let picker = null; // {ids:[...]} while the drawer is open

  function closePicker(silent = false) {
    if (!picker) return;
    picker = null;
    renderPicker();
    if (!silent) game.audio?.play?.('click');
  }

  function openPicker() {
    if (!isSelf) return;
    closeReport(true);
    closeMod(true);
    picker = { ids: showcasePick().ids.slice() };
    renderPicker();
    game.audio?.play?.('open');
  }

  function renderPicker() {
    pickEl.textContent = '';
    if (!picker) { pickEl.hidden = true; return; }
    pickEl.hidden = false;

    const h = elm('div', 'pf-dr-h');
    h.append('Your showcase');
    const x = elm('button', 'pf-sb pf-dr-x', 'Close');
    x.type = 'button';
    x.addEventListener('click', () => closePicker());
    h.appendChild(x);
    pickEl.appendChild(h);

    pickEl.appendChild(elm('div', 'pf-dr-sub',
      `Pick up to ${SHOWCASE_MAX}. These sit at the top of your card, where people look first.`));

    const earned = new Set(who.stamps || []);
    const mine = stampCatalog().filter((s) => earned.has(s.id));
    const grid = elm('div', 'pf-pick-grid');
    for (const s of mine) {
      const on = picker.ids.includes(s.id);
      const b = elm('button', `pf-pick${on ? ' on' : ''}`);
      b.type = 'button';
      b.title = on ? `${s.name} : tap to unpin` : s.name;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const c = document.createElement('canvas');
      paintStampCanvas(c, s, true, 44);
      b.append(c, elm('span', null, s.name));
      b.addEventListener('click', () => {
        if (on) picker.ids = picker.ids.filter((v) => v !== s.id);
        else if (picker.ids.length < SHOWCASE_MAX) picker.ids.push(s.id);
        else { game.toast('Three at a time. Unpin one first.', 2600); return; }
        renderPicker();
        game.audio?.play?.('click');
      });
      grid.appendChild(b);
    }
    if (!mine.length) {
      grid.appendChild(elm('div', 'pf-album-empty',
        'Nothing to pin yet. Play a run, throw a snowball, add a pixel to the mural: the first one comes fast.'));
    }
    pickEl.appendChild(grid);

    const btns = elm('div', 'pf-dr-btns');
    const clear = elm('button', 'pf-sb', 'Clear');
    clear.type = 'button';
    clear.disabled = !picker.ids.length;
    clear.addEventListener('click', () => { picker.ids = []; renderPicker(); game.audio?.play?.('click'); });
    const save = elm('button', 'pf-sb warm', 'Pin them');
    save.type = 'button';
    save.addEventListener('click', () => {
      saveShowcase(picker.ids);
      closePicker(true);
      game.audio?.play?.('success');
      stage?.celebrate();
    });
    btns.append(clear, save);
    pickEl.appendChild(btns);
  }

  // ---- best of -------------------------------------------------------------

  function renderBestOf() {
    favSlot.textContent = '';
    const fav = favoriteGame(who.bests, who.plays);
    if (!fav) {
      const row = elm('div', 'pf-fav');
      row.appendChild(elm('div', 'pf-medal is-none'));
      const txt = elm('div', 'pf-fav-txt');
      txt.appendChild(elm('div', 'pf-fav-k', 'Their game'));
      txt.appendChild(elm('div', 'pf-fav-v', isSelf ? 'Still to be decided' : 'Nothing on the board yet'));
      txt.appendChild(elm('div', 'pf-fav-sub', isSelf
        ? 'One run of anything and this line fills in.'
        : 'They have not put a score up. Yet.'));
      row.appendChild(txt);
      favSlot.appendChild(row);
      return;
    }
    const meta = Object.prototype.hasOwnProperty.call(MINIGAMES, fav.id) ? MINIGAMES[fav.id] : null;
    const best = bestOf(who.bests, fav.id);
    const tier = medalTier(fav.id, best);
    const row = elm('div', 'pf-fav');
    row.appendChild(elm('div', `pf-medal ${TIER_CLASS[tier]}`));
    const txt = elm('div', 'pf-fav-txt');
    txt.appendChild(elm('div', 'pf-fav-k', fav.why === 'plays' ? 'Most played' : 'Strongest game'));
    txt.appendChild(elm('div', 'pf-fav-v', meta?.name || fav.id));
    txt.appendChild(elm('div', 'pf-fav-sub', fav.why === 'plays'
      ? `${fav.n} ${fav.n === 1 ? 'run' : 'runs'}${best != null ? `, best ${best}` : ''}`
      : `${TIER_LABEL[tier]}${best != null ? `, best ${best}` : ''}. ${MEDAL_BLURB[fav.id] || ''}`.trim()));
    row.appendChild(txt);
    favSlot.appendChild(row);
  }

  // ---- charm hunt ----------------------------------------------------------
  // The board that has ridden publicProfile since wave 13E and has never once
  // been drawn. Two facts, in this order: is this week's charm theirs, and how
  // many have they collected in their whole time here.

  function renderCharms() {
    const board = who.charms;
    const week = typeof lastCharm?.week === 'string' ? lastCharm.week : null;
    // for ourselves the live frame is the authority; for anyone else the board
    // is all we have, and a board with no weeks on it cannot answer at all
    const got = isSelf && lastCharm ? !!lastCharm.claimed : foundThisWeek(board, week);

    charmWeekEl.textContent = '';
    charmWeekEl.classList.toggle('is-found', got === true);
    charmWeekEl.appendChild(elm('div', 'pf-charm-orb'));
    const txt = elm('div', 'pf-charm-txt');
    if (!lastCharm) {
      txt.appendChild(elm('div', 'pf-charm-name', 'This week\'s charm'));
      txt.appendChild(elm('div', 'pf-charm-sub', 'The hunt has not spoken up yet. Walk into a room and it will.'));
    } else {
      txt.appendChild(elm('div', 'pf-charm-name',
        typeof lastCharm.name === 'string' && lastCharm.name ? lastCharm.name : 'This week\'s charm'));
      const sub = elm('div', 'pf-charm-sub');
      if (got === true) {
        sub.append('Found ');
        sub.appendChild(elm('b', null, isSelf ? 'by you' : 'by them'));
        sub.append('. It never comes back.');
      } else if (got === false) {
        sub.textContent = isSelf
          ? (typeof lastCharm.hint === 'string' && lastCharm.hint ? lastCharm.hint : 'Still out there. Go and look.')
          : 'Still out there for them.';
      } else {
        sub.textContent = 'Somewhere in the cove, glinting.';
      }
      txt.appendChild(sub);
    }
    charmWeekEl.appendChild(txt);

    const n = Math.floor(Number(lastCharm?.found));
    if (Number.isFinite(n) && n > 0) {
      const tally = elm('div', 'pf-charm-tally', String(n));
      tally.append(elm('small', null, n === 1 ? 'finder' : 'finders'));
      tally.title = 'How many capybaras have found this week\'s charm.';
      charmWeekEl.appendChild(tally);
    }

    charmNote.textContent = who.charmsKnown
      ? (board.count ? `${board.count} in total` : '')
      : '';

    charmGrid.textContent = '';
    if (!who.charmsKnown) {
      // A profile that has come back WITHOUT a board is a cove whose hunt has
      // not started (or a server older than wave 13E). Say that once, plainly,
      // rather than leaving "asking..." up for the rest of the session.
      charmGrid.appendChild(elm('div', 'pf-album-empty', who.loaded
        ? 'No charm board came back for them. The hunt may not have started here yet.'
        : 'Asking about their charms...'));
      return;
    }
    if (!board.found.length) {
      charmGrid.appendChild(elm('div', 'pf-album-empty', isSelf
        ? 'No charms yet. One small thing hides in one room each week, and it is worth going to look.'
        : 'No charms on their shelf yet.'));
      return;
    }
    board.found.forEach((c, i) => {
      const tile = elm('div', 'pf-charm-tile');
      tile.style.setProperty('--i', String(i));
      tile.appendChild(elm('div', 'pf-charm-bead'));
      tile.appendChild(elm('b', null, c.name));
      if (c.week) tile.appendChild(elm('span', null, c.week));
      tile.title = c.week ? `${c.name}, found in ${c.week}` : c.name;
      charmGrid.appendChild(tile);
    });
    // the ride-along is capped; say so rather than quietly showing a short shelf
    if (board.count > board.found.length) {
      charmGrid.appendChild(elm('div', 'pf-album-empty',
        `...and ${board.count - board.found.length} more further back.`));
    }
  }

  function renderMedals() {
    medalsEl.textContent = '';
    Object.keys(MEDAL_TIERS).forEach((gid, i) => {
      const meta = Object.prototype.hasOwnProperty.call(MINIGAMES, gid) ? MINIGAMES[gid] : null;
      const best = bestOf(who.bests, gid);
      const tier = medalTier(gid, best);
      const next = nextCut(gid, best);

      const row = elm('div', 'pf-row');
      row.style.setProperty('--i', String(i));
      row.title = MEDAL_BLURB[gid] || meta?.name || gid;
      const medal = elm('div', `pf-medal ${TIER_CLASS[tier]}`);
      medal.title = `${TIER_LABEL[tier]}${next != null ? ` : ${next} for the next one` : ' : maxed out'}`;
      const txt = elm('div', 'pf-row-txt');
      txt.appendChild(elm('div', 'pf-row-name', meta?.name || gid));
      txt.appendChild(elm('div', 'pf-row-sub', medalSub(best, tier, next)));
      const score = elm('div', `pf-row-score${best == null ? ' is-empty' : ''}`, best == null ? '-' : String(best));
      row.append(medal, txt, score);
      medalsEl.appendChild(row);
    });
  }

  // ---- stamp album ---------------------------------------------------------
  // The milestone rail is built once (the thresholds never move); only the
  // "reached" state and the fill width change as stamps land.
  const track = milestoneTrack();
  const trackMax = track.length ? track[track.length - 1].at : 40;
  const mileRefs = track.map((m) => {
    const node = elm('div', 'pf-mile-node');
    node.style.left = `${Math.min(100, (m.at / trackMax) * 100)}%`;
    const c = document.createElement('canvas');
    paintStampCanvas(c, m, true, 26);
    node.append(c, elm('span', null, String(m.at)));
    node.title = `${m.at} stamps: ${m.name}`;
    mileNodes.appendChild(node);
    return { node, m };
  });

  function renderAlbum() {
    const cat = stampCatalog();
    const known = who.stamps != null;
    const earned = new Set(who.stamps || []);
    const count = earned.size;

    const pct = cat.length ? Math.round((count / cat.length) * 100) : 0;
    albumCount.textContent = known ? `${count} / ${cat.length} : ${pct}%` : '-';
    albumCount.title = known
      ? `${pct}% of the album is filled in.`
      : 'Counting the album...';

    const next = track.find((m) => m.at > count);
    mileTop.textContent = '';
    if (!known) {
      mileTop.textContent = 'Reading the album...';
    } else if (next) {
      mileTop.append(
        document.createTextNode(`${Math.max(0, next.at - count)} more for `),
        elm('b', null, next.name),
      );
    } else {
      mileTop.append(elm('b', null, 'Every milestone claimed.'));
      mileTop.append(document.createTextNode(' Nothing left to unlock, everything left to show off.'));
    }
    mileFill.style.width = `${Math.min(100, (count / trackMax) * 100)}%`;
    for (const r of mileRefs) r.node.classList.toggle('is-hit', known && count >= r.m.at);

    shelvesEl.textContent = '';
    if (!known) {
      shelvesEl.appendChild(elm('div', 'pf-album-empty',
        isSelf ? 'Fetching your album from the cove...' : 'Asking around about their album...'));
      return;
    }

    // Shelves, each with its own completion, so there is always one sitting at
    // "two to go" rather than one bar that barely moves for a month.
    let n = 0;
    for (const sec of albumSections(cat, earned)) {
      const shelf = elm('div', `pf-shelf${sec.got === sec.total ? ' is-done' : ''}`);
      const head = elm('div', 'pf-shelf-h');
      head.appendChild(elm('span', 'pf-shelf-n', sec.name));
      head.appendChild(elm('span', 'pf-shelf-c',
        sec.got === sec.total ? `Full shelf : ${sec.total}` : `${sec.got} / ${sec.total} : ${sec.pct}%`));
      head.title = sec.blurb;
      shelf.appendChild(head);
      const bar = elm('div', 'pf-shelf-bar');
      const fill = elm('i', 'pf-shelf-fill');
      fill.style.width = `${sec.pct}%`;
      bar.appendChild(fill);
      shelf.appendChild(bar);

      const grid = elm('div', 'pf-album');
      for (const s of sec.stamps) {
        const got = earned.has(s.id);
        // "new" is only ever about your OWN album, and only about stamps that
        // landed since the last time you looked at this shelf.
        const isNew = got && isSelf && fresh.has(s.id);
        const tile = elm('div', `pf-stamp${got ? ' is-earned' : ''}${isNew ? ' is-new' : ''}`);
        tile.style.setProperty('--i', String(n++));
        const c = document.createElement('canvas');
        paintStampCanvas(c, s, got, 62);
        tile.appendChild(c);
        tile.appendChild(elm('div', 'pf-stamp-name', got ? s.name : 'Locked'));
        if (isNew) tile.appendChild(elm('span', 'pf-stamp-new-pip', 'New'));
        tile.title = got ? `${s.name} : ${s.desc}` : `Not yet : ${s.how || s.desc}`;
        grid.appendChild(tile);
      }
      shelf.appendChild(grid);
      shelvesEl.appendChild(shelf);
    }
  }

  /**
   * Stamps earned since this account last had the album open. The set is
   * computed ONCE per card (so the shine does not vanish while you are looking
   * at it) and cleared when the album tab has been seen for a beat.
   */
  const fresh = new Set();
  let seenTimer = 0;

  function markFresh() {
    if (!isSelf || who.stamps == null) return;
    const seen = readSeen(game.state.name);
    // A first-ever look is not forty new stamps: seed the store silently and
    // shine nothing. The shine means "since last time", and there was no last
    // time.
    if (!seen.size) { writeSeen(game.state.name, new Set(who.stamps)); return; }
    for (const id of who.stamps) if (!seen.has(id)) fresh.add(id);
  }

  /**
   * The album has been looked at: stop shining these next time.
   * Only a real look counts. Closing the card from the Highlights tab leaves
   * the shine armed, because a new stamp you were never shown is still new.
   */
  let albumViewed = false;
  function settleFresh() {
    if (!isSelf || who.stamps == null || seenTimer) return;
    albumViewed = true;
    seenTimer = setTimeout(() => {
      seenTimer = 0;
      writeSeen(game.state.name, new Set(who.stamps || []));
    }, 1200);
  }

  let askedStamps = false;
  let stampsTimer = 0;
  function askStamps() {
    if (askedStamps || who.stamps != null) return;
    askedStamps = true;
    game.net?.send?.({ t: 'stamps', id: isSelf ? undefined : who.id });
    // the server may not answer at all (older build, guest); an empty album
    // reads honestly, a spinner that never stops does not
    stampsTimer = setTimeout(() => {
      stampsTimer = 0;
      if (who.stamps == null) { who.stamps = []; renderAlbum(); }
    }, 4000);
  }

  /** The hunt, asked for once and only when nobody has heard from it yet. */
  function askCharm() {
    if (lastCharm || !game.net?.connected) return;
    try { game.net.send({ t: 'charm' }); } catch { /* a closing socket is fine */ }
  }

  for (const tab of root.querySelectorAll('.pf-tab')) {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      for (const t of root.querySelectorAll('.pf-tab')) t.classList.toggle('is-on', t === tab);
      for (const p of root.querySelectorAll('.pf-pane')) p.hidden = p.dataset.pane !== which;
      game.audio?.play?.('click');
      if (which === 'album') { askStamps(); settleFresh(); }
      if (which === 'charms') askCharm();
    });
  }

  function note(text) {
    const n = elm('div', 'pf-note', text);
    n.title = text;
    return n;
  }

  let busy = false;

  /**
   * A door for anyone with an account. Bots have no den, guests have no den,
   * and until the server answers we do not know which of those they are, so the
   * button simply is not there yet.
   */
  function denButton() {
    const hasDen = isSelf ? !!game.state.registered : who.registered === true;
    if (who.bot || !hasDen || !who.name) return null;
    const b = elm('button', 'pf-fbtn is-den', isSelf ? 'Visit your den' : 'Visit their den');
    b.type = 'button';
    b.disabled = !game.net?.connected;
    b.title = isSelf ? 'Waddle home to your own den' : `Knock on ${who.name}'s door`;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      game.audio?.play?.('click');
      close(true); // the world needs the screen back for the trip
      visitHouse(game, who.name);
    });
    return b;
  }

  // ---- report a player -----------------------------------------------------
  // Deliberately NOT a second overlay: a modal on top of a modal is how a
  // report gets abandoned. The drawer opens under the buttons you just used.

  let report = null;      // {reason, note, sending, done, err}
  let reportTimer = 0;

  function reportable() {
    // Bots have nobody to answer for them, and reporting yourself is a joke the
    // queue does not need. Everyone else is fair game, guests included: a guest
    // has no record to punish but very much has a session to end.
    return !isSelf && !who.bot && !!(who.name || who.id);
  }

  function closeReport(silent = false) {
    if (!report) return;
    report = null;
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = 0; }
    renderReport();
    renderActions();
    if (!silent) game.audio?.play?.('click');
  }

  function sendReport() {
    if (!report || report.sending || report.done || !report.reason) return;
    if (!game.net?.connected) {
      game.toast('The cove is offline for a moment, so nothing is listening.');
      return;
    }
    const blocked = reportBlocked(who);
    if (blocked) { game.toast(blocked, 4400); return; }

    const now = Date.now();
    lastReportAt = now;
    reportedAt.set(reportKey(who), now);

    const text = String(report.note || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
    // uid -> name -> id is the server's own resolution order (resolveTarget);
    // send every key we hold so the report still points at the right account
    // after they rename, reconnect, or log off before anyone reads it.
    const frame = {
      t: 'report',
      // 'name' is its own surface in the store: an offensive name needs a
      // forced rename, not a mute, and the queue sorts on it.
      kind: REASON_KIND[report.reason] || 'chat',
      reason: report.reason,
      id: who.id,
    };
    if (who.uid) frame.uid = who.uid;
    if (who.name) frame.name = who.name;
    if (text) frame.note = text;
    if (game.roomId) frame.room = game.roomId;
    game.net.send(frame);

    report.sending = true;
    report.err = '';
    renderReport();
    game.audio?.play?.('click');
    // An older server has no reports module and will never answer. Thanking
    // them anyway beats a button that spins forever; the server is still the
    // one that decides whether the report exists.
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      if (report?.sending) { report.sending = false; report.done = true; renderReport(); }
    }, REPORT_ANSWER_MS);
  }

  function renderReport() {
    reportEl.textContent = '';
    if (!report) { reportEl.hidden = true; return; }
    reportEl.hidden = false;

    const h = elm('div', 'pf-dr-h');
    h.append(report.done ? 'Reported ' : 'Report ', elm('b', null, who.name || 'this capybara'));
    const x = elm('button', 'pf-sb pf-dr-x', 'Close');
    x.type = 'button';
    x.addEventListener('click', () => closeReport());
    h.appendChild(x);
    reportEl.appendChild(h);

    if (report.done) {
      reportEl.appendChild(elm('div', 'pf-dr-sub',
        'Thank you. A cove keeper will look at this with the chat around it, and you will not hear back unless they need you.'));
      reportEl.appendChild(elm('div', 'pf-dr-foot',
        'If they are ruining your evening right now, you do not have to wait for us: walk to another room, and they cannot follow you into your own den.'));
      return;
    }

    reportEl.appendChild(elm('div', 'pf-dr-sub', 'What happened? Pick the closest one.'));

    const grid = elm('div', 'pf-reasons');
    for (const r of REPORT_REASONS) {
      const b = elm('button', `pf-reason${report.reason === r.id ? ' on' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', report.reason === r.id ? 'true' : 'false');
      b.appendChild(elm('span', 'pf-reason-n', r.name));
      b.appendChild(elm('span', 'pf-reason-d', r.desc));
      b.addEventListener('click', () => {
        report.reason = r.id;
        report.err = '';
        renderReport();
        game.audio?.play?.('click');
      });
      grid.appendChild(b);
    }
    reportEl.appendChild(grid);

    const why = elm('input', 'pf-why');
    why.type = 'text';
    why.maxLength = NOTE_MAX;
    why.value = report.note;
    why.placeholder = 'Anything else worth knowing (optional)';
    why.setAttribute('aria-label', 'What happened');
    why.disabled = !!report.sending;
    why.addEventListener('input', () => { report.note = why.value; });
    why.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the card owns the keyboard; typing is not walking
      if (e.key === 'Enter' && report.reason) sendReport();
    });
    reportEl.appendChild(why);

    const btns = elm('div', 'pf-dr-btns');
    const cancel = elm('button', 'pf-sb', 'Never mind');
    cancel.type = 'button';
    cancel.addEventListener('click', () => closeReport());
    const go = elm('button', 'pf-sb hot', report.sending ? 'Sending...' : 'Send report');
    go.type = 'button';
    go.disabled = !report.reason || !!report.sending || !game.net?.connected;
    go.addEventListener('click', sendReport);
    btns.append(cancel, go);
    reportEl.appendChild(btns);

    if (report.err) reportEl.appendChild(elm('div', 'pf-dr-sub', report.err));
    reportEl.appendChild(elm('div', 'pf-dr-foot',
      'Reports go to the cove keepers with the last few minutes of chat attached. False reports are themselves reportable, so please only use this when you mean it.'));
  }

  // ---- moderate ------------------------------------------------------------
  // The same `a-*` frames Cove Watch (src/ui/admin.js) sends, and the same
  // server-side performOp re-authorises every one of them. This is only the
  // ergonomics: acting where you already clicked the player.

  let mod = null;         // {account, asked, drawer:{kind,mins,reason}|null}
  // The frame names this card is still waiting on. A SET, not one slot: the
  // auto re-read fires 450ms after an op, and on a bad connection it would
  // otherwise overwrite the op we are still expecting an answer to — the toast
  // carrying the server's refusal sentence is exactly the one you cannot lose.
  const modAwait = new Set();

  function caps() {
    const can = (c) => (typeof game.can === 'function' ? !!game.can(c) : false);
    return {
      inspect: can('inspect'),
      mute: can('mute'),
      kick: can('kick'),
      ban: can('ban'),
      perm: can('ban-perm'),
      unban: can('unban'),
    };
  }

  function canModerate() {
    if (isSelf || who.bot) return false;
    const c = caps();
    return c.inspect || c.mute || c.kick || c.ban || c.unban;
  }

  /** uid -> name -> id, the server's resolution order, best key first. */
  function modTarget() {
    if (who.uid) return { uid: who.uid };
    if (who.registered !== false && who.name) return { name: who.name };
    return { id: who.id };
  }

  function askInspect() {
    if (!mod || !caps().inspect || !game.net?.connected) return;
    mod.asked = true;
    modAwait.add('a-inspect');
    game.net.send({ t: 'a-inspect', ...modTarget() });
  }

  function modOp(t, extra = {}) {
    if (!game.net?.connected) {
      game.toast('The cove is offline for a moment, so nothing is listening.');
      return;
    }
    modAwait.add(t);
    game.net.send({ t, ...modTarget(), ...extra });
    game.audio?.play?.('click');
    // let the record settle, then re-read it so the chips tell the truth
    setTimeout(() => { if (mod) askInspect(); }, 450);
  }

  function closeMod(silent = false) {
    if (!mod) return;
    mod = null;
    modAwait.clear();
    renderMod();
    renderActions();
    if (!silent) game.audio?.play?.('click');
  }

  function renderModDrawer(host) {
    const d = mod.drawer;
    if (!d) return;
    const verb = d.kind === 'mute' ? 'Mute' : d.kind === 'ban' ? 'Ban' : 'Kick';

    if (d.kind !== 'kick') {
      const chips = elm('div', 'pf-chips');
      const list = d.kind === 'mute' ? MUTE_CHIPS : BAN_CHIPS;
      const opts = d.kind === 'ban' && caps().perm ? [...list, ['Forever', 0]] : list;
      for (const [label, mins] of opts) {
        const b = elm('button', `pf-sb${d.mins === mins ? ' on' : ''}`, label);
        b.type = 'button';
        b.addEventListener('click', () => { d.mins = mins; renderMod(); });
        chips.appendChild(b);
      }
      host.appendChild(chips);
    }

    const why = elm('input', 'pf-why');
    why.type = 'text';
    why.maxLength = 140;
    why.value = d.reason;
    why.placeholder = d.kind === 'kick'
      ? 'Reason (optional, they will see it)'
      : 'Reason (required, they will see it)';
    why.setAttribute('aria-label', 'Reason');
    const ready = () => (d.kind === 'kick' ? true : d.reason.trim().length >= 3 && d.mins !== null);
    why.addEventListener('input', () => { d.reason = why.value; go.disabled = !ready(); });
    why.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && ready()) confirm();
    });
    host.appendChild(why);

    const btns = elm('div', 'pf-dr-btns');
    const cancel = elm('button', 'pf-sb', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { mod.drawer = null; renderMod(); });
    const go = elm('button', `pf-sb ${d.kind === 'ban' ? 'hot' : 'warm'}`, verb);
    go.type = 'button';
    go.disabled = !ready();
    go.addEventListener('click', confirm);
    btns.append(cancel, go);
    host.appendChild(btns);

    function confirm() {
      if (!ready()) return;
      const reason = d.reason.trim();
      if (d.kind === 'kick') modOp('a-kick', reason ? { reason } : {});
      else if (d.kind === 'mute') modOp('a-mute', { mins: d.mins, reason });
      // mins 0 is the server's own spelling of permanent, and it needs 'ban-perm'
      else modOp('a-ban', { mins: d.mins, reason });
      mod.drawer = null;
      renderMod();
    }

    setTimeout(() => why.focus({ preventScroll: true }), 0);
  }

  function renderMod() {
    modEl.textContent = '';
    if (!mod) { modEl.hidden = true; return; }
    modEl.hidden = false;
    const c = caps();
    const acc = mod.account;

    const h = elm('div', 'pf-dr-h');
    h.append('Moderate ', elm('b', null, who.name || 'this capybara'));
    if (acc?.guest || who.registered === false) h.appendChild(elm('span', 'pf-mod-chip guest', 'guest'));
    if (acc?.role && acc.role !== 'player') h.appendChild(elm('span', 'pf-mod-chip role', acc.role));
    if (acc?.mute?.remaining > 0) h.appendChild(elm('span', 'pf-mod-chip mute', `muted ${shortMs(acc.mute.remaining)}`));
    if (acc?.ban && !acc.ban.expired) h.appendChild(elm('span', 'pf-mod-chip ban', 'banned'));
    const x = elm('button', 'pf-sb pf-dr-x', 'Close');
    x.type = 'button';
    x.addEventListener('click', () => closeMod());
    h.appendChild(x);
    modEl.appendChild(h);

    if (acc && !acc.guest) {
      const kv = elm('dl', 'pf-mod-facts');
      const put = (k, v) => {
        if (v === undefined || v === null || v === '') return;
        kv.appendChild(elm('dt', null, k));
        kv.appendChild(elm('dd', null, String(v)));
      };
      put('uid', acc.uid);
      put('coins', acc.coins);
      put('ip hash', acc.lastIpH);
      if (acc.mute) put('mute', `${shortMs(acc.mute.remaining)} left, by ${acc.mute.by || '?'} (${acc.mute.reason || 'no reason given'})`);
      if (acc.ban) put('ban', `${acc.ban.expired ? 'expired, ' : ''}by ${acc.ban.by || '?'} (${acc.ban.reason || 'no reason given'})`);
      if (Array.isArray(acc.sessions) && acc.sessions.length > 1) put('sessions', acc.sessions.length);
      modEl.appendChild(kv);
    } else if (acc?.guest) {
      modEl.appendChild(elm('div', 'pf-dr-sub',
        'A guest: nothing to mute and nothing to ban, because there is no record to hold either. A kick is the whole toolbox.'));
    } else {
      modEl.appendChild(elm('div', 'pf-dr-sub',
        c.inspect ? 'Reading their record...' : 'Your role cannot read records, only act on them.'));
    }

    // The rank guard is the server's, and it is strictly greater: never paint a
    // button that is going to come back as 'rank'.
    const outranks = !!acc && !acc.guest && rankOf(acc.role) >= rankOf(game.state?.role);
    if (outranks) {
      modEl.appendChild(elm('div', 'pf-dr-sub', `${who.name || 'They'} outranks that action. Take it to an admin.`));
      return;
    }

    if (mod.drawer) { renderModDrawer(modEl); return; }

    const row = elm('div', 'pf-mod-row');
    const add = (label, cls, fn, on = true, why = '') => {
      if (!on) return;
      const b = elm('button', `pf-sb${cls ? ` ${cls}` : ''}`, label);
      b.type = 'button';
      if (why) b.title = why;
      b.addEventListener('click', fn);
      row.appendChild(b);
    };
    // A guest has no account: the server refuses mute and ban for them by name,
    // so the card does not offer them either.
    const hasRecord = acc ? !acc.guest : who.registered !== false;

    add(acc ? 'Re-read' : 'Inspect', '', () => { askInspect(); game.audio?.play?.('click'); }, c.inspect);
    if (hasRecord && acc?.mute?.remaining > 0) add('Unmute', 'warm', () => modOp('a-unmute'), c.mute);
    else add('Mute', 'warm', () => { mod.drawer = { kind: 'mute', mins: 60, reason: '' }; renderMod(); }, c.mute && hasRecord);
    add('Kick', '', () => { mod.drawer = { kind: 'kick', mins: null, reason: '' }; renderMod(); }, c.kick);
    if (hasRecord && acc?.ban && !acc.ban.expired) add('Unban', 'hot', () => modOp('a-unban'), c.unban);
    else add('Ban', 'hot', () => { mod.drawer = { kind: 'ban', mins: 1440, reason: '' }; renderMod(); }, c.ban && hasRecord);
    modEl.appendChild(row);

    modEl.appendChild(elm('div', 'pf-dr-foot',
      'Every action here is logged with your name, the reason and the before-and-after. Duration limits belong to your role; the server will say so if you ask for more.'));
  }

  /**
   * The action row is two rows of intent that share one strip: the social half
   * (message, friend, den) and the safety half (report, moderate). The social
   * half has five early returns in it, so the safety half is appended after it
   * rather than threaded through them — otherwise a guest, a bot-adjacent
   * "Checking..." state or an offline note would each quietly eat the report
   * button, and the one button you need during an incident would be missing
   * exactly when the card is in an unusual state.
   */
  function renderActions() {
    actionsEl.textContent = '';
    renderSocialActions();
    renderSafetyActions();
  }

  function renderSafetyActions() {
    if (reportable()) {
      // Only the per-target lock changes the button; the shorter global breath
      // between any two reports is a toast at send time, because "Reported" on
      // a capy you have never reported is a lie.
      const already = reportedRecently(who);
      const b = elm('button', 'pf-fbtn is-report', already ? 'Reported' : 'Report');
      b.type = 'button';
      b.disabled = already || !game.net?.connected;
      b.title = already
        ? reportBlocked(who)
        : (game.net?.connected
          ? `Tell the cove keepers about ${who.name || 'this capybara'}`
          : 'Reports need a connection to the cove.');
      b.setAttribute('aria-expanded', report ? 'true' : 'false');
      b.addEventListener('click', () => {
        if (b.disabled) return;
        if (report) { closeReport(); return; }
        closeMod(true);
        closePicker(true);
        report = { reason: '', note: '', sending: false, done: false, err: '' };
        renderReport();
        renderActions();
        game.audio?.play?.('click');
      });
      actionsEl.appendChild(b);
    }

    if (!canModerate()) return;
    const m = elm('button', 'pf-fbtn is-mod', 'Moderate');
    m.type = 'button';
    m.title = `Operator tools for ${who.name || 'this capybara'} (logged)`;
    m.setAttribute('aria-expanded', mod ? 'true' : 'false');
    m.addEventListener('click', () => {
      if (mod) { closeMod(); return; }
      closeReport(true);
      closePicker(true);
      mod = { account: null, asked: false, drawer: null };
      renderMod();
      renderActions();
      askInspect();
      game.audio?.play?.('open');
    });
    actionsEl.appendChild(m);
  }

  function renderSocialActions() {
    const den = denButton();
    if (isSelf) {
      if (den) actionsEl.appendChild(den);
      actionsEl.appendChild(note('This is you. Looking good out there.'));
      return;
    }
    if (who.bot) return; // bots keep no address book, and that is fine
    // Whispers need no account on either side: any online capy can be
    // messaged. Prefills "/w Name " in the chat box and closes the card.
    if (who.name && game.net?.connected) {
      const msg = elm('button', 'pf-fbtn is-msg', 'Message');
      msg.type = 'button';
      msg.title = `Whisper ${who.name} privately (/w in chat)`;
      msg.addEventListener('click', () => {
        close();
        const input = document.getElementById('chat-input');
        if (input) { input.value = `/w ${who.name} `; input.focus(); }
      });
      actionsEl.appendChild(msg);
    }
    if (!who.loaded) {
      if (!game.net?.connected) {
        actionsEl.appendChild(note('Friends need a connection to the cove. Yours will come back on its own.'));
        return;
      }
      const b = elm('button', 'pf-fbtn', 'Checking...');
      b.type = 'button';
      b.disabled = true;
      actionsEl.appendChild(b);
      return;
    }
    if (!game.state.registered) {
      // a guest cannot make friends, but an open door is still an open door
      if (den) actionsEl.appendChild(den);
      actionsEl.appendChild(note('Friends stick around only with an account. Make one from the title screen and you can keep them.'));
      return;
    }
    if (who.registered === false) {
      actionsEl.appendChild(note(`${who.name || 'They'} is visiting as a guest, so there is nobody to add yet. Say hi instead.`));
      return;
    }

    const isFriend = who.isFriend === true;
    const b = elm('button', `pf-fbtn${isFriend ? ' is-remove' : ''}`, isFriend ? 'Remove friend' : 'Add friend');
    b.type = 'button';
    b.disabled = busy || !game.net?.connected;
    b.title = isFriend
      ? `Take ${who.name || 'them'} off your friends list`
      : `Add ${who.name || 'them'} to your friends list`;
    b.addEventListener('click', () => toggleFriend(isFriend));
    actionsEl.appendChild(b);
    if (den) actionsEl.appendChild(den);
    if (!game.net?.connected) actionsEl.appendChild(note('Offline right now, so the friend book is closed.'));
  }

  function toggleFriend(wasFriend) {
    if (busy || !game.net?.connected) return;
    busy = true;
    who.isFriend = !wasFriend;
    // both keys: the server resolves the connection id, and falls back to the
    // account name if that session has already gone (see friendTarget())
    game.net.send({ t: wasFriend ? 'friend-remove' : 'friend-add', id: who.id, name: who.name || undefined });
    game.net.send({ t: 'friends' });
    game.audio?.play?.(wasFriend ? 'click' : 'success');
    game.toast(wasFriend
      ? `${who.name || 'They'} left your friends list. No hard feelings.`
      : `${who.name || 'They'} is on your friends list now!`);
    if (!wasFriend) stage?.celebrate();
    renderHead();
    renderActions();
    // the server has the last word; unlock once it answers (or shortly after)
    setTimeout(() => { busy = false; renderActions(); }, 700);
  }

  function renderAll() {
    renderHead();
    renderShowcase();
    renderBestOf();
    renderMedals();
    renderCharms();
    renderAlbum();
    renderActions();
  }

  markFresh();
  renderAll();

  // ---- live data -----------------------------------------------------------
  const unsubs = [
    game.events.on('profile-data', (payload, extra) => {
      // tolerate both emit(payload) and emit(id, payload)
      const keyed = extra && typeof extra === 'object'
        && (typeof payload === 'string' || typeof payload === 'number');
      const raw = keyed ? { id: payload, ...extra } : payload;
      const p = normalizeProfile(raw);
      if (!p) return;
      if (p.id != null && p.id !== who.id) return; // someone else's card
      if (p.uid) who.uid = p.uid;
      if (p.name) who.name = p.name;
      if (p.color != null) who.color = p.color;
      if (p.hat != null) who.hat = p.hat;
      if (p.bot) who.bot = true;
      if (p.registered != null) who.registered = p.registered;
      if (p.room != null) who.room = p.room;
      if (p.online != null) who.online = p.online;
      if (p.isFriend != null) who.isFriend = p.isFriend;
      if (raw && typeof raw === 'object' && typeof raw.title === 'string') {
        who.title = raw.title.trim().slice(0, 32);
      }
      who.bests = { ...who.bests, ...p.bests };
      // the album can ride along on the profile frame; if it does, no second ask
      if (raw && typeof raw === 'object' && raw.stamps != null) {
        who.stamps = normalizeStamps(raw).ids;
      }
      // ---- profile v2 ride-alongs, each additive and each optional --------
      // charms/charmCount have shipped since wave 13E and were never drawn;
      // the rest arrive with the orchestrator's inspect line and are simply
      // absent until then.
      if (raw && typeof raw === 'object'
        && (Array.isArray(raw.charms) || raw.charmCount != null)) {
        who.charms = normalizeCharms(raw);
        who.charmsKnown = true;
      }
      if (p.since != null) who.since = p.since;
      if (p.plays) who.plays = p.plays;
      if (p.role) who.role = p.role;
      if (p.flair) who.flair = p.flair;
      // Our OWN pick is ours: a profile frame about us never overwrites a pin we
      // just made locally with an older (or absent) server answer.
      if (p.showcase && !isSelf) who.showcase = p.showcase;
      who.loaded = true;
      stage?.setLook(who.color, who.hat);
      renderAll();
    }),
    game.events.on('stamps', (payload) => {
      const s = normalizeStamps(payload);
      // an unkeyed frame is the server answering about us
      if (s.id != null && s.id !== who.id) return;
      if (s.id == null && !isSelf) return;
      who.stamps = s.ids;
      // the album frame carries the milestone title; adopt it so the card (and
      // our own state, for the next card we open) is right straight away
      if (typeof payload?.title === 'string') {
        who.title = payload.title.trim().slice(0, 32);
        if (isSelf) game.state.title = who.title;
      }
      markFresh();
      renderAlbum();
      renderShowcase();
      renderHead();
    }),
    // a stamp earned while the card is open lands in the album straight away,
    // shining, whatever tab you happen to be on
    game.events.on('stamp', (m) => {
      if (!isSelf || !m || typeof m.id !== 'string') return;
      const already = (who.stamps || []).includes(m.id);
      who.stamps = [...new Set([...(who.stamps || []), m.id])];
      if (!already) {
        fresh.add(m.id);
        stage?.celebrate();
      }
      renderAlbum();
      renderShowcase();
      renderHead();
    }),
    // The hunt. Any card that hears it caches it for the next one, and a charm
    // claimed while the card is open flips this week's line to "found" without
    // a re-open.
    game.events.on('charm', (m) => {
      if (!m || typeof m !== 'object') return;
      lastCharm = m;
      if (isSelf && (Array.isArray(m.mine) || m.charmCount != null)) {
        who.charms = normalizeCharms(m);
        who.charmsKnown = true;
        renderHead();
      }
      renderCharms();
    }),
    // The report answer rides its OWN name, the same way `mural` answers a
    // mural op: {ok:true, id} or {ok:false, msg, code}. A refusal releases the
    // per-target lock, or a rate-limited report would look like a delivered one.
    game.events.on('report', (m) => {
      if (!report) return;
      if (reportTimer) { clearTimeout(reportTimer); reportTimer = 0; }
      report.sending = false;
      if (m && m.ok === false) {
        reportedAt.delete(reportKey(who));
        // A refusal that arrives AFTER the optimistic fallback has to be able
        // to take the thank-you back, or the one case where the report did not
        // land is the one case the player is told it did.
        report.done = false;
        report.err = m.msg || 'The keepers could not take that one. Try again in a moment.';
        game.audio?.play?.('pop');
      } else {
        report.done = true;
        game.audio?.play?.('ding');
      }
      renderReport();
      renderActions();
    }),
    // Operator answers. Cove Watch listens to these too, so everything here is
    // matched to THIS card's target (or to an op this card actually sent) —
    // otherwise a panel action would repaint a card about somebody else.
    game.events.on('a-ok', (m) => {
      if (!mod || !m || typeof m.op !== 'string') return;
      if (m.op === 'a-inspect') {
        const acc = m.account && typeof m.account === 'object' ? m.account : null;
        if (!acc) return;
        const mine = (who.uid && acc.uid === who.uid)
          || (!!who.name && String(acc.name || '').toLowerCase() === who.name.toLowerCase());
        if (!mine) return; // the panel asked about someone else
        if (acc.uid) who.uid = acc.uid;
        if (typeof acc.guest === 'boolean') who.registered = !acc.guest;
        mod.account = acc;
        modAwait.delete('a-inspect');
        renderMod();
        renderHead();
        return;
      }
      if (m.uid && who.uid && m.uid !== who.uid) return;
      if (!modAwait.has(m.op)) return; // the panel's op, not ours
      modAwait.delete(m.op);
      if (m.msg) game.toast(m.msg, 3200);
      game.audio?.play?.('pop');
    }),
    game.events.on('a-err', (m) => {
      if (!mod || !m || !modAwait.has(m.op)) return;
      modAwait.delete(m.op);
      game.toast(m.msg || 'That did not work', 3600);
      game.audio?.play?.('pop');
      // The refusal often IS the answer (rank, guest, role ceiling): show the
      // buttons again rather than leaving a drawer half-open over it.
      if (mod) { mod.drawer = null; renderMod(); }
    }),
    game.events.on('friends-data', (payload) => {
      if (isSelf || who.bot) return;
      const list = normalizeFriends(payload);
      // an offline friend has no connection id, so the name is the only key left
      who.isFriend = list.some((f) => (f.id != null && f.id === who.id)
        || (!!who.name && f.name === who.name));
      busy = false;
      renderHead();
      renderActions();
    }),
  ];

  // ask the server for the real record (bests, account status, friendship)
  if (!isSelf) {
    game.net?.send?.({ t: 'inspect', id: who.id });
    if (game.state.registered) game.net?.send?.({ t: 'friends' });
  }
  askStamps(); // the album tab should be warm the moment it is clicked
  askCharm();  // and so should the hunt, if nobody has heard from it yet
  // never leave the card stuck on "Checking..."
  const settle = setTimeout(() => {
    if (who.loaded) return;
    who.loaded = true;
    renderAll();
  }, 5000);

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close(silent = false) {
    if (closed) return;
    closed = true;
    if (openInstance?.id === id) openInstance = null;
    clearTimeout(settle);
    if (stampsTimer) { clearTimeout(stampsTimer); stampsTimer = 0; }
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = 0; }
    // the shine is spent the moment the card closes, whether or not the timer
    // got there first: re-opening to the same glow is a glow that means nothing
    if (seenTimer) { clearTimeout(seenTimer); seenTimer = 0; }
    if (isSelf && albumViewed && who.stamps) writeSeen(game.state.name, new Set(who.stamps));
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    try { stage?.dispose(); } catch { /* context may already be lost */ }
    stage = null;
    root.classList.add('is-closing');
    setTimeout(() => root.remove(), 160);
    if (!silent) game.audio?.play?.('click');
  }

  function onBackdrop(e) { if (e.target === root) close(); }
  function onKey(e) {
    // the card owns the keyboard while it is up (no walking off mid-chat)
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // Escape unwinds one layer at a time: a half-typed ban reason should not
    // take the whole card with it.
    if (mod?.drawer) { mod.drawer = null; renderMod(); return; }
    if (picker) { closePicker(); return; }
    if (report) { closeReport(); return; }
    if (mod) { closeMod(); return; }
    close();
  }

  root.addEventListener('pointerdown', onBackdrop);
  q('.pf-x').addEventListener('click', () => close());
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  openInstance = { id, close };
}
