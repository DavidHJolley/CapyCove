import * as THREE from 'three';
import { HATS, BODY_COLORS, MINIGAMES, FURNITURE, HOUSE_MAX_ITEMS, TRAILS } from '../../shared/constants.js';
import { createAvatar } from '../player/avatar.js';
import { createTrailPreview } from '../player/trails.js';
import { makeToon, makeGlow, disposeObject } from '../core/materials.js';

/**
 * Wardrobe & Shop modal.
 *
 * A live 3D capybara turntable on the left, Colors / Hats / Furniture (and,
 * when the stall has stock, Consignment) tabs on the right. Hovering a hat (or
 * a color) tries it on instantly without committing; clicking equips or buys.
 * Purchases that go to the server show a pending spinner and resolve on the
 * next 'profile' / 'coins' / 'furn' event.
 *
 * Furniture is bought for the player's den (see the house rooms). It stacks:
 * every copy you own can be placed, so the cards count instead of locking.
 *
 * ---------------------------------------------------------------------------
 * The Cove Consignment (wave 13, N-29)
 * ---------------------------------------------------------------------------
 * The catalog is split into a STAPLES RACK (always on sale, which is every
 * existing item) and a ROTATING STALL, driven entirely by one optional server
 * frame:
 *
 *   server -> client   {t:'shop-rot', ids:[…], pool:[…]?, secret:[…]?,
 *                       dye:{price}?, until:<epoch ms>, endsIn:<seconds>?}
 *   client -> server   {t:'shop-rot'}            // a read, like {t:'quests'}
 *
 * EVERY part of it degrades to today's behaviour when the frame never arrives:
 * no frame means no stall tab, the full catalog on the rack, and free dyes.
 * That is deliberate. This file must ship green whether or not the server side
 * lands in the same wave.
 *
 *  - `ids`    : what is on the stall this fortnight. Ids that are not in
 *               HATS/FURNITURE are ignored; milestone cosmetics are ignored
 *               too (hide-not-show stays: coins must never reach them).
 *  - `pool`   : the authored rotating pool. Anything in the pool that is NOT
 *               in `ids` is hidden from the rack until its turn comes round.
 *               Defaults to the items flagged `stall: true` in the catalogs,
 *               so an empty/absent pool hides nothing. GUARDRAIL: an item you
 *               already own is never hidden from you, whatever the pool says.
 *  - `secret` : unannounced stock, revealed one item per hidden find on the
 *               turntable diorama. Never listed, never counted, never hinted.
 *  - `dye`    : {price} for a coat colour you have not worn before. Colours
 *               you have already worn, the four natural browns, and every
 *               milestone dye are free forever. There is no charge at all
 *               until the server names a price.
 *
 * Prices always come from the shared catalogs, never from the frame: a shop
 * frame can decide WHAT is on sale, never what it costs.
 *
 * Exported API is exactly: openShop(game)  (the HUD button toggles it).
 */

// ---------------------------------------------------------------------------
// copy: flavor text so nothing in the UI reads like a placeholder
// ---------------------------------------------------------------------------

const COLOR_NAMES = {
  0xb08a5a: 'Toffee',
  0x8a6642: 'Cocoa',
  0xc9a06b: 'Biscuit',
  0x6b4f35: 'Driftwood',
  0xe8657a: 'Coral',
  0xf2a541: 'Mango',
  0x7ac74f: 'Meadow',
  0x4fb3e8: 'Sky',
  0x9b6bd4: 'Grape',
  0x42d6c8: 'Lagoon',
  // milestone dye (12 stamps, docs/LIVING-COVE.md section D). Not in
  // BODY_COLORS on purpose: coins must never reach it.
  0x7ff0d0: 'Aurora',
};

const HAT_BLURBS = {
  none: 'Just fur, sunshine and confidence.',
  beanie: 'Hand knit. Slightly too warm. Worth it.',
  cap: 'Brim forward, attitude sideways.',
  flower: 'Attracts bees. Mostly the friendly ones.',
  tophat: 'For capybaras of considerable standing.',
  viking: 'The horns are decorative. Probably.',
  crown: 'Heavy is the head, comfy is the fur.',
  propeller: 'Spins nonstop. Lift not included.',
  chef: 'Smells permanently of mango smoothie.',
  pirate: 'Yarr, and excellent sun protection.',
};

const TRAIL_BLURBS = {
  none: 'Just paws, and the ground you walked on.',
  petals: 'The plaza blossom follows you home.',
  sparkles: 'Every step lands with a little glint.',
  glowring: 'Stand still and the warm light finds you.',
  notes: 'A tune only your paws are playing.',
  bubbles: 'Somehow never pops. Nobody asks how.',
  snow: 'Peak weather, wherever you happen to be.',
  stardrift: 'Five small stars, doing slow laps overhead.',
  fireflies: 'They followed you back from the jungle.',
  leaves: 'Autumn, personally, one capybara wide.',
  embers: 'Cocoa warm, and it never once singes fur.',
  butterflies: 'Three friends who insist on coming along.',
  stars: 'Starfall, but gentle, and aimed at nobody.',
  rainbow: 'A ribbon of every colour, in order, always.',
  tidewake: 'The wake Big Blue leaves, in your size.',
  goldpaw: 'Gold pawprints. They fade, which is the charm.',
};

const FURN_BLURBS = {
  sofa: 'Seats four capys, or one very committed one.',
  armchair: 'Exactly the right shape for doing nothing.',
  beanbag: 'Sinks precisely as far as you hoped.',
  rug_round: 'Hides a truly heroic amount of sand.',
  rug_stripe: 'Stripes make the room go faster. Science.',
  low_table: 'For snacks, board games and propped up feet.',
  dining_set: 'Four chairs, endless snack negotiations.',
  bed: 'Naps taken here officially count double.',
  bookshelf: 'Mostly thrillers set entirely in ponds.',
  floor_lamp: 'Warm light, zero fire, all cozy.',
  string_lights: 'Turns any wall into a small festival.',
  plant_palm: 'Low maintenance, high vibes, gentle rustle.',
  plant_flower: 'Small, cheerful, faintly smug about it.',
  fireplace: 'Crackles politely. Never once smokes.',
  aquarium: 'The fish are neighbours, not a menu.',
  arcade_cab: 'One more go. Every single time.',
  trophy_case: 'Medals, shells, and one very lucky pebble.',
  wall_surfboard: 'Retired from waves, promoted to decor.',
  capy_portrait: 'The eyes follow you. Kindly, though.',
  cocoa_station: 'Marshmallows are strictly non negotiable.',
};

/**
 * A capybara's own coat is free. The four natural browns at the head of
 * BODY_COLORS (see the comment on it in shared/constants.js) are what a capy
 * grows, not what the dye tub sells, so going back to one never costs a coin.
 * Listed by value rather than by index so a reordered palette cannot silently
 * start charging for brown.
 */
const NATURAL_COLORS = [0xb08a5a, 0x8a6642, 0xc9a06b, 0x6b4f35];

/** Cozy lines for the hidden finds on the turntable. Nothing signposts these. */
const FIND_LINES = [
  'A smooth little pebble, warm from the lamp. The stallholder nods.',
  'A striped shell somebody left on the stand. Finders keepers.',
  'A stray brass key. It opens nothing, which is somehow better.',
];

const FINDS_KEY = 'cove.stall.finds';
const DYES_KEY = 'cove.dyes';

const TIERS = [
  { max: 0, label: 'Starter' },
  { max: 119, label: 'Common' },
  { max: 299, label: 'Snazzy' },
  { max: 499, label: 'Rare' },
  { max: Infinity, label: 'Legendary' },
];

function tierLabel(price) {
  for (const t of TIERS) if (price <= t.max) return t.label;
  return 'Common';
}

/**
 * Milestone cosmetics ({milestone: true} in the shared catalogs) are handed out
 * by the stamp album, never sold: coins must not be able to reach them or they
 * stop being proof of play (docs/LIVING-COVE.md section D). They stay listed
 * once you own one, because a reward you cannot wear or place is no reward.
 */
function shopEntries(catalog, owns) {
  return Object.entries(catalog)
    .filter(([id, item]) => !item.milestone || owns(id))
    .sort((a, b) => a[1].price - b[1].price);
}

function hexCss(c) {
  return `#${(c >>> 0).toString(16).padStart(6, '0')}`;
}

function colorName(c) {
  return COLOR_NAMES[c] || 'Custom';
}

// ---------------------------------------------------------------------------
// consignment rotation: normalising whatever the wire says
// ---------------------------------------------------------------------------

/** Own-property lookup for an id in one of the shared catalogs. */
function catalogItem(id) {
  if (typeof id !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(HATS, id)) return { kind: 'hat', item: HATS[id] };
  if (Object.prototype.hasOwnProperty.call(FURNITURE, id)) return { kind: 'furn', item: FURNITURE[id] };
  return null;
}

/** Ids the catalogs themselves mark as rotating stock, when nothing else says. */
function defaultPool() {
  const out = [];
  for (const [id, item] of Object.entries(HATS)) if (item.stall) out.push(id);
  for (const [id, item] of Object.entries(FURNITURE)) if (item.stall) out.push(id);
  return out;
}

/**
 * Turn a raw 'shop-rot' frame into the shape the UI trusts. Every field is
 * optional and every bad value falls back to "no stall at all", because a
 * malformed frame must leave the wardrobe exactly as it was rather than empty
 * the shelves. Sellable ids only: milestone cosmetics are dropped here so the
 * hide-not-show rule survives an operator typo in the calendar.
 */
function normalizeRotation(msg) {
  const m = msg && typeof msg === 'object' ? msg : null;
  if (!m) return null;
  const sellable = (id) => {
    const hit = catalogItem(id);
    return !!hit && !hit.item.milestone;
  };
  const list = (v) => (Array.isArray(v) ? [...new Set(v.filter(sellable))] : []);
  const ids = list(m.ids);
  const secret = list(m.secret).filter((id) => !ids.includes(id));
  const pool = Array.isArray(m.pool) ? list(m.pool) : defaultPool();
  // absolute first (it survives a paused tab), the countdown second
  let until = Number(m.until);
  if (!Number.isFinite(until) || until <= 0) until = 0;
  const endsIn = Number(m.endsIn);
  if (!until && Number.isFinite(endsIn) && endsIn > 0) until = Date.now() + endsIn * 1000;
  const dyePrice = Math.max(0, Math.min(500, Math.floor(Number(m.dye?.price) || 0)));
  return { ids, secret, pool: [...new Set([...pool, ...ids, ...secret])], until, dyePrice };
}

/**
 * The no-new-server-code path. Wave 13A's `events` frame already carries every
 * active event's `effects` verbatim (server/events.js publicEvent) plus the
 * merged `flags` map, so the stall can be driven straight from
 * data/calendar.json with nothing shop-specific on the server at all:
 *
 *   "effects": { "shop": { "featured": "pirate" } }      -> onto the stall
 *   "effects": { "flag": { "stall": "tophat,aquarium",   -> the fortnight's rack
 *                          "stall-pool": "…",            -> what waits its turn
 *                          "stall-secret": "…",          -> the hidden finds
 *                          "stall-dye": "20" } }         -> the re-dye charge
 *
 * `until` is the end of the active events that supplied the stock, which is
 * exactly when the stall changes. A real 'shop-rot' frame always outranks this.
 * DELIBERATELY IGNORED: `shop.discount`. The server is the price authority, so
 * a discount the buy handler does not apply must never be printed on a card.
 */
function rotationFromEvents(msg) {
  const m = msg && typeof msg === 'object' ? msg : null;
  if (!m) return null;
  const active = Array.isArray(m.active) ? m.active : [];
  const flags = m.flags && typeof m.flags === 'object' ? m.flags : {};
  const csv = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const featured = [];
  for (const a of active) {
    const id = a?.effects?.shop?.featured;
    if (typeof id === 'string') featured.push(id);
  }
  const listed = csv(flags.stall);
  const pool = csv(flags['stall-pool']);
  const secret = csv(flags['stall-secret']);
  const dye = Math.max(0, Math.floor(Number(flags['stall-dye']) || 0));
  if (!featured.length && !listed.length && !pool.length && !secret.length && dye <= 0) return null;
  let until = 0;
  for (const a of active) until = Math.max(until, Number(a?.endsAt) || 0);
  return { t: 'shop-rot', ids: [...featured, ...listed], pool, secret, dye: { price: dye }, until };
}

/**
 * "Rotates in about four days." Coarse on purpose: this is a calendar, not a
 * countdown timer. Scarcity by calendar is charming, scarcity by pressure is
 * not (docs/research/liveops.md section 3.6).
 */
function rotateLine(until) {
  if (!until) return 'Fresh crates come in when the boat comes in.';
  const ms = until - Date.now();
  if (ms <= 0) return 'A new crate is being unpacked right now.';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `New crates in about ${Math.max(1, mins)} minute${mins === 1 ? '' : 's'}.`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `New crates in about ${hours} hour${hours === 1 ? '' : 's'}.`;
  const days = Math.round(hours / 24);
  return `New crates in about ${days} day${days === 1 ? '' : 's'}.`;
}

/**
 * Which hidden finds this browser has already picked up, for the current
 * rotation window. Local only: a find reveals stock that the server has
 * already told us about, so it can never mint anything, and losing it to a
 * cleared cache costs one click.
 */
function loadFinds(until) {
  try {
    const raw = JSON.parse(localStorage.getItem(FINDS_KEY) || 'null');
    if (!raw || typeof raw !== 'object' || raw.u !== until) return [];
    return Array.isArray(raw.k) ? raw.k.filter((k) => typeof k === 'string').slice(0, 8) : [];
  } catch {
    return []; // private mode, quota, corrupt value: the finds are just fresh again
  }
}

function saveFinds(until, keys) {
  try { localStorage.setItem(FINDS_KEY, JSON.stringify({ u: until, k: keys.slice(0, 8) })); } catch { /* not worth a word to the player */ }
}

/**
 * Coat colours this player has already paid the dye charge for. The SERVER is
 * the authority the moment it starts echoing `colors` on the dye reply; this
 * local copy exists so that, until then, a player is never charged twice for a
 * shade they are visibly already wearing. It can only ever make a dye cheaper,
 * never dearer, and it grants nothing a player could not buy anyway.
 */
function loadDyes() {
  try {
    const raw = JSON.parse(localStorage.getItem(DYES_KEY) || 'null');
    return Array.isArray(raw) ? raw.map((v) => Math.floor(Number(v))).filter((v) => Number.isFinite(v)) : [];
  } catch {
    return [];
  }
}

function saveDyes(colors) {
  try { localStorage.setItem(DYES_KEY, JSON.stringify([...colors].slice(0, 64))); } catch { /* private mode: pay once more, one time */ }
}

// ---------------------------------------------------------------------------
// styles (injected once, every class prefixed shop-)
// ---------------------------------------------------------------------------

const STYLE_ID = 'shop-styles';

const CSS = `
#shop-overlay { animation: shop-fade .18s ease; backdrop-filter: blur(3px); }
#shop-overlay.shop-closing { opacity: 0; transition: opacity .15s ease; pointer-events: none; }

.shop-modal {
  width: min(780px, 94vw); padding: 22px 24px 18px;
  border: 4px solid #fff; outline: 3px solid rgba(45,36,23,.08);
  animation: shop-rise .28s cubic-bezier(.18,1.15,.4,1);
}
.shop-modal:focus { outline: 3px solid rgba(45,36,23,.08); }

.shop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding-right: 46px; }
.shop-head h2 { font-size: 26px; margin: 0 0 2px; letter-spacing: .02em; }
.shop-sub { font-size: 12.5px; font-weight: 700; color: #a3906c; }
.shop-purse {
  display: flex; align-items: center; gap: 8px; flex: none;
  background: var(--card); border: 3px solid #f4e7c9; border-radius: 999px;
  padding: 6px 15px 6px 11px; font-weight: 900; font-size: 17px;
  box-shadow: 0 3px 0 rgba(45,36,23,.07);
}
.shop-purse-n { transition: color .2s ease; }
.shop-purse.is-bump .shop-coin { animation: shop-bump .45s cubic-bezier(.2,1.4,.4,1); }

.shop-coin {
  width: 15px; height: 15px; border-radius: 50%; display: inline-block; flex: none;
  background: radial-gradient(circle at 34% 28%, #ffeeb0 0%, var(--gold) 58%, #d1912a 100%);
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.4);
}
.shop-coin-sm { width: 11px; height: 11px; }

.shop-body { display: flex; gap: 20px; margin-top: 16px; align-items: flex-start; }

/* ---- 3D stage ---- */
.shop-stage { width: 240px; flex: none; display: flex; flex-direction: column; gap: 9px; align-items: center; }
.shop-stage-frame {
  position: relative; width: 240px; height: 280px; border-radius: 22px; overflow: hidden;
  background: radial-gradient(ellipse 72% 62% at 50% 36%, #fffaea 0%, #ffeec9 44%, #f6ddA6 72%, #ecca86 100%);
  box-shadow: inset 0 -20px 34px rgba(178,136,64,.22), inset 0 0 0 3px rgba(255,255,255,.7), 0 6px 18px rgba(45,36,23,.14);
}
.shop-rays {
  position: absolute; left: 50%; top: 46%; width: 380px; height: 380px; margin: -190px 0 0 -190px;
  background: repeating-conic-gradient(from 0deg, rgba(255,255,255,.5) 0deg 8deg, rgba(255,255,255,0) 8deg 20deg);
  opacity: .45; animation: shop-rays 60s linear infinite; pointer-events: none;
}
.shop-canvas { position: absolute; inset: 0; width: 240px; height: 280px; display: block; }
.shop-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(202deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,0) 40%);
}
.shop-stage-fallback {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; padding: 24px; font-weight: 800; font-size: 13px; color: #a3906c;
}
.shop-stage-name { font-weight: 900; font-size: 16px; text-align: center; }
.shop-stage-outfit {
  display: flex; align-items: center; gap: 7px; justify-content: center;
  font-weight: 700; font-size: 12.5px; color: #8a7a5a; text-align: center; min-height: 17px;
}
.shop-stage-outfit.is-preview { color: var(--accent); }
.shop-swatch-dot { width: 13px; height: 13px; border-radius: 50%; border: 2px solid #fff; flex: none; box-shadow: 0 1px 4px rgba(0,0,0,.28); }

/* ---- right panel ---- */
.shop-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.shop-tabs { display: flex; gap: 4px; background: rgba(45,36,23,.07); padding: 5px; border-radius: 999px; align-self: flex-start; }
.shop-tab {
  border: 0; background: transparent; font-family: var(--font); font-weight: 900; font-size: 14px;
  padding: 8px 20px; border-radius: 999px; cursor: pointer; color: #8a7a5a;
  transition: background .16s ease, color .16s ease, scale .12s ease;
}
.shop-tab:hover { color: var(--ink); }
.shop-tab:active { scale: .96; }
.shop-tab.is-on { background: var(--accent); color: #fff; box-shadow: 0 3px 10px rgba(232,101,122,.38); }
.shop-pane { display: none; }
.shop-pane.is-on { display: block; animation: shop-fade .22s ease; }

.shop-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 10px; }
.shop-swatch {
  position: relative; height: 58px; border-radius: 16px; border: 3px solid #fff; cursor: pointer;
  background: var(--sw); box-shadow: 0 3px 10px rgba(45,36,23,.2);
  transition: scale .14s ease, box-shadow .14s ease, border-color .14s ease;
  animation: shop-pop .3s backwards cubic-bezier(.2,1.3,.5,1); animation-delay: calc(var(--i) * 26ms);
}
.shop-swatch:hover, .shop-swatch:focus-visible { scale: 1.09; outline: none; box-shadow: 0 6px 16px rgba(45,36,23,.28); }
.shop-swatch.is-on { border-color: var(--ink); }
.shop-swatch.is-on::after {
  content: '\\2713'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 24px; font-weight: 900; text-shadow: 0 2px 5px rgba(0,0,0,.5);
}
.shop-note { margin-top: 14px; font-size: 12.5px; font-weight: 700; color: #a3906c; }
.shop-note b { color: var(--ink); }

/* ---- hat grid ---- */
.shop-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(152px, 1fr)); gap: 10px;
  max-height: 44vh; overflow-y: auto; padding: 3px 6px 8px 3px;
  scrollbar-width: thin; scrollbar-color: #e2d5b6 transparent;
}
.shop-grid::-webkit-scrollbar { width: 9px; }
.shop-grid::-webkit-scrollbar-thumb { background: #e2d5b6; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
.shop-hat {
  position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 5px;
  background: var(--card); border-radius: 16px; padding: 11px 12px 11px; cursor: pointer;
  border: 3px solid transparent; box-shadow: 0 3px 0 rgba(45,36,23,.07);
  transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, opacity .2s ease;
  animation: shop-pop .34s backwards cubic-bezier(.2,1.3,.5,1); animation-delay: calc(var(--i) * 34ms);
}
.shop-hat:hover { transform: translateY(-3px); border-color: var(--accent2); box-shadow: 0 9px 18px rgba(45,36,23,.16); }
.shop-hat.is-equipped { border-color: var(--gold); background: #fff8e6; }
.shop-hat.is-locked { opacity: .68; filter: saturate(.55); }
.shop-hat.is-locked:hover { opacity: .85; }
.shop-hat.is-pending { cursor: progress; }
.shop-hat.shop-shake { animation: shop-shake .34s ease; }
.shop-hat-name { font-weight: 900; font-size: 14px; line-height: 1.15; padding-right: 4px; }
.shop-hat-blurb { font-size: 11px; font-weight: 600; color: #a3906c; line-height: 1.32; min-height: 29px; }
.shop-hat-foot {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 6px; row-gap: 7px; margin-top: auto; padding-top: 4px;
}
.shop-price { display: flex; align-items: center; gap: 5px; font-weight: 900; font-size: 13px; color: var(--ink); }
.shop-price.is-short { color: #cf3d2c; }
.shop-price.is-free { color: #a3906c; font-size: 12px; letter-spacing: .04em; }
.shop-hat-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 0; cursor: pointer;
  flex: 0 1 auto; white-space: nowrap;
  font-family: var(--font); font-weight: 900; font-size: 12.5px; padding: 7px 13px; border-radius: 999px;
  background: var(--accent); color: #fff; box-shadow: 0 3px 0 rgba(45,36,23,.12);
  transition: scale .12s ease, filter .12s ease;
}
.shop-hat-btn:hover:not(:disabled) { scale: 1.07; filter: brightness(1.06); }
.shop-hat-btn:active:not(:disabled) { scale: .95; }
.shop-hat.is-owned .shop-hat-btn { background: var(--accent2); }
.shop-hat-btn:disabled { background: #ece0c4; color: #93815f; cursor: default; box-shadow: none; }
.shop-tier {
  position: absolute; top: 9px; right: 9px; font-size: 8.5px; font-weight: 900; letter-spacing: .09em;
  text-transform: uppercase; padding: 3px 7px; border-radius: 999px; background: #f0e6cd; color: #a3906c;
}
.shop-tier.is-rare { background: #e4ecff; color: #4d6bb5; }
.shop-tier.is-legendary { background: #ffe9b0; color: #b07d16; }
.shop-ribbon {
  display: none; position: absolute; top: 13px; right: -32px; width: 116px; transform: rotate(45deg);
  background: var(--gold); color: var(--ink); font-size: 9.5px; font-weight: 900; letter-spacing: .1em;
  text-align: center; padding: 4px 0; box-shadow: 0 2px 7px rgba(45,36,23,.28);
}
.shop-hat.is-equipped .shop-ribbon { display: block; animation: shop-ribbon .32s ease backwards; }
.shop-hat.is-equipped .shop-tier { display: none; }
.shop-spinner {
  width: 11px; height: 11px; border-radius: 50%; display: inline-block;
  border: 2px solid rgba(147,129,95,.35); border-top-color: #93815f; animation: shop-spin .7s linear infinite;
}

.shop-foot { display: flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 700; color: #a3906c; }

@keyframes shop-fade { from { opacity: 0; } }
@keyframes shop-rise { from { opacity: 0; transform: translateY(16px) scale(.95); } }
@keyframes shop-pop { from { opacity: 0; transform: translateY(10px) scale(.9); } }
@keyframes shop-spin { to { transform: rotate(360deg); } }
@keyframes shop-bump { 45% { transform: scale(1.35); } }
@keyframes shop-ribbon { from { opacity: 0; transform: rotate(45deg) translateY(-14px); } }
@keyframes shop-rays { to { transform: rotate(360deg); } }
@keyframes shop-shake { 15%, 85% { transform: translateX(-3px); } 40%, 65% { transform: translateX(4px); } }

@media (max-width: 720px) {
  .shop-modal { padding: 18px 16px 14px; }
  .shop-body { flex-direction: column; align-items: center; }
  .shop-stage { width: 100%; }
  .shop-panel { width: 100%; }
  .shop-grid { max-height: 30vh; }
  .shop-head h2 { font-size: 22px; }
}
@media (prefers-reduced-motion: reduce) {
  .shop-modal, .shop-hat, .shop-swatch, .shop-rays, .shop-pane { animation: none; }
}

/* ---- furniture grid ---- */
.shop-furn-note {
  display: none; margin: 0 0 10px; padding: 9px 13px; border-radius: 14px;
  background: #fff3d6; border: 2px solid #f3e2b8; color: #8a7a5a;
  font-size: 12px; font-weight: 700; line-height: 1.36;
}
.shop-furn-note.is-on { display: block; }
.shop-furn-note b { color: var(--ink); }
.shop-fgrid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(146px, 1fr)); gap: 10px;
  max-height: 42vh; overflow-y: auto; padding: 3px 6px 8px 3px;
  scrollbar-width: thin; scrollbar-color: #e2d5b6 transparent;
}
.shop-fgrid::-webkit-scrollbar { width: 9px; }
.shop-fgrid::-webkit-scrollbar-thumb { background: #e2d5b6; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
.shop-furn {
  position: relative; display: flex; flex-direction: column; gap: 6px;
  background: var(--card); border-radius: 16px; padding: 9px 10px 10px;
  border: 3px solid transparent; box-shadow: 0 3px 0 rgba(45,36,23,.07);
  transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
  animation: shop-pop .34s backwards cubic-bezier(.2,1.3,.5,1); animation-delay: calc(var(--i) * 30ms);
}
.shop-furn:hover { transform: translateY(-3px); border-color: var(--accent2); box-shadow: 0 9px 18px rgba(45,36,23,.16); }
.shop-furn.is-owned { border-color: var(--gold); background: #fff8e6; }
.shop-furn.is-pending { cursor: progress; }
.shop-furn.shop-shake { animation: shop-shake .34s ease; }
.shop-furn-thumb {
  position: relative; border-radius: 12px; overflow: hidden; background: #fdf3dc;
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.7), 0 2px 6px rgba(45,36,23,.1);
}
.shop-furn-thumb canvas { display: block; width: 100%; height: auto; }
.shop-furn-count {
  display: none; position: absolute; right: 5px; top: 5px; padding: 2px 7px;
  border-radius: 999px; background: var(--gold); color: var(--ink); border: 2px solid #fff;
  font-size: 10px; font-weight: 900; letter-spacing: .03em; box-shadow: 0 2px 6px rgba(45,36,23,.24);
}
.shop-furn.is-owned .shop-furn-count { display: block; }
.shop-furn-name { font-weight: 900; font-size: 13px; line-height: 1.16; }
.shop-furn-blurb { font-size: 10.5px; font-weight: 600; color: #a3906c; line-height: 1.3; min-height: 27px; }
.shop-furn-foot {
  display: flex; align-items: center; justify-content: space-between;
  flex-wrap: wrap; gap: 6px; row-gap: 7px; margin-top: auto; padding-top: 2px;
}

@media (max-width: 720px) {
  .shop-fgrid { max-height: 30vh; }
}
@media (prefers-reduced-motion: reduce) {
  .shop-furn { animation: none; }
}

/* ---- trails grid: hat cards with a live little diorama on top ---- */
.shop-trail-thumb {
  position: relative; border-radius: 12px; overflow: hidden; margin-bottom: 3px;
  background: radial-gradient(ellipse 78% 70% at 50% 38%, #fffaea 0%, #fbeed0 58%, #f1dcab 100%);
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.7), 0 2px 6px rgba(45,36,23,.1);
}
.shop-trail-thumb canvas { display: block; width: 100%; height: auto; }
.shop-aura {
  display: inline-block; vertical-align: middle; margin-left: 6px;
  font-size: 8.5px; font-weight: 900; letter-spacing: .09em; text-transform: uppercase;
  padding: 3px 7px; border-radius: 999px; background: #d8f3ef; color: #2f8f83;
}

/* ---- consignment stall ---- */
.shop-tab.is-stall.is-on { background: #b58bd8; box-shadow: 0 3px 10px rgba(181,139,216,.4); }
.shop-stall-note {
  margin: 0 0 10px; padding: 9px 13px; border-radius: 14px;
  background: #f8f1ff; border: 2px solid #e8dbf6; color: #7c6b8f;
  font-size: 12px; font-weight: 700; line-height: 1.4;
}
.shop-stall-note b { color: var(--ink); }
.shop-stall-when { color: #9b8ab0; }
.shop-stall-empty {
  padding: 26px 18px; text-align: center; font-size: 12.5px; font-weight: 700;
  color: #a3906c; line-height: 1.5;
}
.shop-hat.is-secret, .shop-furn.is-secret { border-color: #b58bd8; background: #fbf6ff; }
.shop-found {
  position: absolute; top: 9px; right: 9px; font-size: 8.5px; font-weight: 900; letter-spacing: .09em;
  text-transform: uppercase; padding: 3px 7px; border-radius: 999px; background: #ecdcff; color: #7d5aa8;
}
.shop-hat.is-secret .shop-tier, .shop-furn.is-secret .shop-tier { display: none; }

/* ---- dye charge ---- */
.shop-swatch.is-pending { cursor: progress; }
.shop-swatch-cost {
  position: absolute; left: 50%; bottom: 4px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 999px;
  background: rgba(255,255,255,.92); color: #6b5a3a; font-size: 9.5px; font-weight: 900;
  box-shadow: 0 1px 3px rgba(45,36,23,.25); pointer-events: none;
}
.shop-swatch.is-on .shop-swatch-cost { display: none; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// 3D preview: turntable capybara on a little pedestal
// ---------------------------------------------------------------------------

const PREVIEW_W = 240;
const PREVIEW_H = 280;

function buildPreview(canvas, game) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setSize(PREVIEW_W, PREVIEW_H, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, PREVIEW_W / PREVIEW_H, 0.1, 40);
  camera.position.set(0, 1.3, 3.75);
  camera.lookAt(0, 0.92, 0);

  scene.add(new THREE.HemisphereLight(0xfff3da, 0x8a6642, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(2.6, 4.2, 3.2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fd4ff, 0.45);
  rim.position.set(-3, 1.8, -2.6);
  scene.add(rim);

  // pedestal + glow ring (static, so the turntable spin reads clearly)
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.84, 0.96, 0.18, 24), makeToon(0xf0dca0));
  ped.position.y = -0.09;
  scene.add(ped);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.032, 8, 30), makeGlow(0xf2b64a));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.014;
  scene.add(ring);

  const turntable = new THREE.Group();
  scene.add(turntable);

  const avatar = createAvatar({ color: game.state.color, hat: game.state.hat });
  turntable.add(avatar.group);

  // orbiting sparkles: one InstancedMesh, shared glow material
  const SPARKS = 14;
  const sparkGeo = new THREE.OctahedronGeometry(0.05);
  const sparks = new THREE.InstancedMesh(sparkGeo, makeGlow(0xf2c744), SPARKS);
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(sparks);
  const dummy = new THREE.Object3D();
  const seeds = [];
  for (let i = 0; i < SPARKS; i++) {
    seeds.push({
      a: (i / SPARKS) * Math.PI * 2,
      r: 0.78 + (i % 3) * 0.15,
      y: 0.12 + ((i * 37) % 100) / 100 * 1.55,
      s: 0.55 + ((i * 53) % 100) / 100 * 0.6,
      sp: 0.3 + (i % 5) * 0.07,
    });
  }

  // Hidden finds (N-29). Three small props tucked into the diorama, no glow, no
  // cursor change, no tooltip: a secret that announces itself is a button. Two
  // ride the turntable so they drift in and out of view, one sits still on the
  // pedestal rim where it reads as scenery.
  const hotMeshes = [];
  function addHot(key, mesh, parent) {
    mesh.userData.hotKey = key;
    parent.add(mesh);
    hotMeshes.push(mesh);
  }
  const pebble = new THREE.Mesh(new THREE.IcosahedronGeometry(0.078, 0), makeToon(0xa79273));
  pebble.position.set(0.66, 0.05, 0.46);
  pebble.rotation.set(0.6, 0.9, 0.2);
  addHot('pebble', pebble, scene);

  const shell = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.15, 7), makeToon(0xf2cfae));
  shell.position.set(-0.52, 0.08, 0.34);
  shell.rotation.set(Math.PI * 0.52, 0, 0.35);
  addHot('shell', shell, turntable);

  const keyProp = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.018, 6, 10), makeToon(0xd8a94b));
  keyProp.position.set(-0.18, 0.03, -0.66);
  keyProp.rotation.x = -Math.PI / 2;
  addHot('key', keyProp, turntable);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let raf = 0;
  let last = 0;
  let t = 0;
  let boost = 0;
  let punch = 0;
  let burst = 0;
  let curColor = game.state.color;
  let curHat = game.state.hat;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    boost *= Math.exp(-dt * 3.2);
    punch *= Math.exp(-dt * 5.5);
    burst *= Math.exp(-dt * 2.2);

    turntable.rotation.y += dt * (0.55 + boost);
    avatar.update(dt);
    avatar.group.scale.setScalar(1 + punch * 0.13);
    avatar.group.position.y = punch * 0.12;

    for (let i = 0; i < SPARKS; i++) {
      const s = seeds[i];
      const a = s.a + t * s.sp;
      const r = s.r + burst * 0.22;
      dummy.position.set(Math.cos(a) * r, s.y + Math.sin(t * 1.5 + s.a) * 0.09, Math.sin(a) * r);
      dummy.rotation.set(t * 1.1, a, t * 0.6);
      const pulse = 0.72 + 0.28 * Math.sin(t * 3 + s.a * 2);
      dummy.scale.setScalar(s.s * pulse * (1 + burst * 1.5));
      dummy.updateMatrix();
      sparks.setMatrixAt(i, dummy.matrix);
    }
    sparks.instanceMatrix.needsUpdate = true;

    ring.scale.setScalar(1 + burst * 0.12);
    renderer.render(scene, camera);
  }

  return {
    start() { if (!raf) raf = requestAnimationFrame(frame); },
    setColor(hex) {
      if (hex === curColor) return;
      curColor = hex;
      avatar.setColor(hex);
    },
    setHat(id) {
      if (id === curHat) return;
      curHat = id;
      const stale = avatar.hatAnchor.children.slice();
      avatar.setHat(id);
      for (const o of stale) disposeObject(o); // hats are rebuilt per swap, free the old geometry
    },
    celebrate(power = 1) {
      punch = Math.max(punch, 0.85 * power);
      boost = Math.max(boost, 7 * power);
      burst = Math.max(burst, power);
    },
    /** nx/ny are normalised device coords over the canvas. Returns a find key or null. */
    pick(nx, ny) {
      const live = hotMeshes.filter((m) => m.visible);
      if (!live.length) return null;
      ray.setFromCamera(ndc.set(nx, ny), camera);
      const hit = ray.intersectObjects(live, false)[0];
      return hit ? hit.object.userData.hotKey : null;
    },
    /** A find is picked up: the prop leaves the diorama for good. */
    takeFind(key) {
      for (const m of hotMeshes) if (m.userData.hotKey === key) m.visible = false;
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      sparks.dispose();
      disposeObject(scene); // frees geometries; shared makeToon/makeGlow materials are kept
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not all contexts support it */ }
    },
  };
}

// ---------------------------------------------------------------------------
// furniture thumbnails: one throwaway tiny renderer, one shot per catalog item,
// blitted into each card's 2D canvas. The GL context is disposed as soon as the
// queue drains, so the wardrobe never holds two live contexts for long.
// ---------------------------------------------------------------------------

const THUMB_W = 132;
const THUMB_H = 94;

function makeThumbShooter(pw, ph) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, powerPreference: 'low-power',
    preserveDrawingBuffer: true, // we drawImage() the buffer straight after render()
  });
  renderer.setPixelRatio(1);
  renderer.setSize(pw, ph, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff3da, 0x8a6642, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(2.4, 4.1, 3.1);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fd4ff, 0.5);
  rim.position.set(-3, 2, -2.6);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(32, pw / ph, 0.05, 60);
  const dir = new THREE.Vector3(0.6, 0.7, 1).normalize(); // same 3/4 read as the world camera
  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();

  return {
    canvas: renderer.domElement,
    /** Frame `obj` and render it. Returns false if it has no drawable bounds. */
    shoot(obj) {
      obj.rotation.y -= 0.55; // three-quarter turn so fronts and sides both read
      scene.add(obj);
      try {
        obj.updateMatrixWorld(true);
        box.setFromObject(obj);
        if (box.isEmpty()) return false;
        box.getBoundingSphere(sphere);
        const r = Math.max(0.35, sphere.radius);
        const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.03;
        camera.position.copy(dir).multiplyScalar(dist).add(sphere.center);
        camera.lookAt(sphere.center);
        camera.near = Math.max(0.05, dist - r * 2.2);
        camera.far = dist + r * 3;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
        return true;
      } finally {
        // never leave a half-shot prop in the scene: it is disposed right after
        scene.remove(obj);
      }
    },
    dispose() {
      disposeObject(scene);
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not all contexts support it */ }
    },
  };
}

// ---------------------------------------------------------------------------
// trail art: ONE renderer, one little scene per card
//
// A flourish only reads when it moves, so these cards animate rather than take
// a still. That is still exactly one GL context for the whole grid: each card
// owns a `createTrailPreview` (its own private pools, so a preview can never
// eat the world's particle budget), and every visible card is rendered into the
// shared buffer and blitted into its own 2D canvas. Cards scrolled out of the
// grid are skipped entirely, so the cost follows what the player can see.
// ---------------------------------------------------------------------------

const TRAIL_W = 132;
const TRAIL_H = 94;
const TRAIL_HZ = 24; // particles at 24fps read as film, and cost half of 60

function makeTrailStage(pw, ph) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, powerPreference: 'low-power',
    preserveDrawingBuffer: true, // we drawImage() the buffer straight after render()
  });
  renderer.setPixelRatio(1);
  renderer.setSize(pw, ph, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // frames the pretend capybara's circle (radius 0.85) and everything the
  // recipes throw, from ground pawprints to the drifting stars at y 1.95
  const camera = new THREE.PerspectiveCamera(38, pw / ph, 0.1, 30);
  camera.position.set(0, 1.5, 3.5);
  camera.lookAt(0, 0.85, 0);

  const cards = [];

  return {
    /** One card's art. `canvas` is the card's own 2D canvas. */
    add(id, canvas) {
      const pv = createTrailPreview(id);
      const scene = new THREE.Scene();
      scene.add(pv.group);
      const ctx = canvas.getContext('2d');
      if (!ctx) { pv.dispose(); return; }
      cards.push({ pv, scene, ctx, canvas });
    },
    /** Advance and blit every card `visible` says is on screen. */
    step(dt, visible) {
      for (const c of cards) {
        if (!visible(c.canvas)) continue;
        c.pv.update(dt);
        renderer.render(c.scene, camera);
        c.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
        c.ctx.drawImage(renderer.domElement, 0, 0, c.canvas.width, c.canvas.height);
      }
    },
    dispose() {
      for (const c of cards) {
        try { c.pv.dispose(); } catch { /* already gone */ }
      }
      cards.length = 0;
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* not all contexts support it */ }
    },
  };
}

function roundedPath(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/** Warm little stage behind every thumbnail, then whatever art we have. */
function paintThumb(canvas, drawArt) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w * 0.5, h * 0.36, h * 0.05, w * 0.5, h * 0.52, h * 0.98);
  g.addColorStop(0, '#fffaea');
  g.addColorStop(0.6, '#fbeed0');
  g.addColorStop(1, '#f1dcab');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#6b4f35';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.82, w * 0.27, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawArt(ctx, w, h);
}

/** Stand-in art for when WebGL (or a builder) is unavailable: a delivery crate. */
function paintCrate(ctx, w, h) {
  const cx = w * 0.5;
  const base = h * 0.79;
  const bw = w * 0.42;
  const bh = h * 0.4;
  ctx.fillStyle = '#d9b483';
  roundedPath(ctx, cx - bw / 2, base - bh, bw, bh, h * 0.06);
  ctx.fill();
  ctx.fillStyle = '#e8c99b';
  roundedPath(ctx, cx - bw * 0.57, base - bh - h * 0.1, bw * 1.14, h * 0.13, h * 0.05);
  ctx.fill();
  ctx.fillStyle = '#e8657a';
  ctx.fillRect(cx - bw * 0.07, base - bh, bw * 0.14, bh);
}

// ---------------------------------------------------------------------------
// modal
// ---------------------------------------------------------------------------

let openInstance = null;
let lastTab = 'colors';

/**
 * The last rotation the server sent, cached across opens. The frame arrives on
 * hello and on room joins, long before anybody walks into the shop, so without
 * this the stall would look empty until the read came back. Wired lazily on the
 * first openShop() call: this module must have no import-time side effects.
 */
let lastRot = null;
let lastRotWire = false; // a real 'shop-rot' frame outranks the calendar fallback
let rotWired = false;

function wireRotation(game) {
  if (rotWired || !game?.events?.on) return;
  rotWired = true;
  game.events.on('shop-rot', (m) => {
    const r = normalizeRotation(m);
    if (r) { lastRot = r; lastRotWire = true; }
  });
  game.events.on('events', (m) => {
    if (lastRotWire) return;
    lastRot = normalizeRotation(rotationFromEvents(m));
  });
}

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

/** Open (or, if already open, close) the wardrobe. */
export function openShop(game) {
  if (openInstance) { openInstance.close(); return; }
  ensureStyles();

  const root = elm('div', 'shop-overlay');
  root.id = 'shop-overlay';
  root.innerHTML = `
    <div class="shop-card shop-modal" role="dialog" aria-label="Wardrobe and shop" tabindex="-1">
      <button class="hud-btn map-close shop-x" title="Close" aria-label="Close">&#10005;</button>
      <div class="shop-head">
        <div>
          <h2>Wardrobe</h2>
          <div class="shop-sub">Try things on. Hats are yours forever once bought.</div>
        </div>
        <div class="shop-purse" title="Your coins"><span class="shop-coin"></span><span class="shop-purse-n">0</span></div>
      </div>
      <div class="shop-body">
        <div class="shop-stage">
          <div class="shop-stage-frame">
            <div class="shop-rays"></div>
            <canvas class="shop-canvas"></canvas>
            <div class="shop-shine"></div>
          </div>
          <div class="shop-stage-name"></div>
          <div class="shop-stage-outfit"><span class="shop-swatch-dot"></span><span class="shop-outfit-text"></span></div>
        </div>
        <div class="shop-panel">
          <div class="shop-tabs" role="tablist">
            <button class="shop-tab" role="tab" data-tab="colors">Colors</button>
            <button class="shop-tab" role="tab" data-tab="hats">Hats</button>
            <button class="shop-tab" role="tab" data-tab="trails">Trails</button>
            <button class="shop-tab" role="tab" data-tab="furniture">Furniture</button>
            <button class="shop-tab is-stall" role="tab" data-tab="stall" hidden>Consignment</button>
          </div>
          <div class="shop-pane" data-pane="colors">
            <div class="shop-swatches"></div>
            <div class="shop-note"><b class="shop-color-name"></b><span class="shop-color-hint"></span></div>
          </div>
          <div class="shop-pane" data-pane="hats">
            <div class="shop-grid"></div>
          </div>
          <div class="shop-pane" data-pane="trails">
            <div class="shop-grid shop-tgrid"></div>
          </div>
          <div class="shop-pane" data-pane="furniture">
            <div class="shop-furn-note"></div>
            <div class="shop-fgrid"></div>
          </div>
          <div class="shop-pane" data-pane="stall">
            <div class="shop-stall-note"></div>
            <div class="shop-grid shop-sgrid"></div>
          </div>
          <div class="shop-foot"><span class="shop-coin shop-coin-sm"></span><span class="shop-foot-text"></span></div>
        </div>
      </div>
    </div>
  `;
  mountPoint().appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const card = q('.shop-modal');
  const purse = q('.shop-purse');
  const purseN = q('.shop-purse-n');
  const stageFrame = q('.shop-stage-frame');
  const canvas = q('.shop-canvas');
  const stageName = q('.shop-stage-name');
  const outfitDot = q('.shop-swatch-dot');
  const outfitText = q('.shop-outfit-text');
  const swatchWrap = q('.shop-swatches');
  const colorNameEl = q('.shop-color-name');
  const colorHintEl = q('.shop-color-hint');
  // pane-scoped: the stall rack reuses .shop-grid for its scroll and layout
  const grid = q('[data-pane="hats"] .shop-grid');
  const tgrid = q('.shop-tgrid');
  const subEl = q('.shop-sub');
  const furnNote = q('.shop-furn-note');
  const fgrid = q('.shop-fgrid');
  const stallTab = q('.shop-tab.is-stall');
  const stallNote = q('.shop-stall-note');
  const sgrid = q('.shop-sgrid');

  const SUB_WEAR = subEl.textContent;
  const SUB_TRAIL = 'Walk trails and idle auras. Wear one and the whole cove sees it.';
  const SUB_FURN = 'Everything you buy is delivered to your den, ready to place.';
  const SUB_STALL = 'The consignment stall. Whatever came in on the boat this fortnight.';

  stageName.textContent = game.state.name || 'Capybara';
  q('.shop-foot-text').textContent =
    `Out of coins? ${Object.values(MINIGAMES).map((m) => m.name).join(', ')}.`;

  // ---- preview -------------------------------------------------------------
  let preview = null;
  try {
    preview = buildPreview(canvas, game);
    preview.start();
  } catch {
    canvas.remove();
    const fb = elm('div', 'shop-stage-fallback', 'The mirror is foggy today, but everything still works.');
    stageFrame.appendChild(fb);
  }

  // ---- consignment rotation state -----------------------------------------
  // `rot` is null until (and unless) the server says otherwise, and null means
  // "one rack, everything on it", which is exactly the pre-wave-13 shop.
  wireRotation(game);
  let rot = lastRot;
  let rotFromWire = lastRotWire;
  let finds = loadFinds(rot?.until || 0);

  function owns(id) {
    return Object.prototype.hasOwnProperty.call(HATS, id)
      ? game.state.ownedHats.includes(id)
      : ownedCount(id) > 0;
  }

  /** Secret stock is revealed one item per find, in the order the server sent. */
  function revealed() {
    if (!rot) return [];
    return rot.secret.slice(0, finds.length);
  }

  function stallList() {
    if (!rot) return [];
    return [...rot.ids, ...revealed().filter((id) => !rot.ids.includes(id))];
  }

  /** Pool stock waiting its turn. Never hides something you already own. */
  function hiddenSet() {
    if (!rot) return new Set();
    const onStall = new Set(stallList());
    return new Set(rot.pool.filter((id) => !onStall.has(id) && !owns(id)));
  }

  let hoverColor = null;
  let hoverHat = null;

  const outfitLine = q('.shop-stage-outfit');

  function syncPreview() {
    const c = hoverColor ?? game.state.color;
    const h = hoverHat ?? game.state.hat;
    preview?.setColor(c);
    preview?.setHat(h);
    outfitDot.style.background = hexCss(c);

    const tryColor = hoverColor !== null && hoverColor !== game.state.color;
    const tryHat = hoverHat !== null && hoverHat !== game.state.hat;
    if (tryHat) {
      outfitText.textContent = h === 'none' ? 'Trying the bare look' : `Trying on ${HATS[h]?.name || h}`;
    } else if (tryColor) {
      outfitText.textContent = `Trying on ${colorName(c)}`;
    } else {
      outfitText.textContent = `${colorName(c)} coat${h === 'none' ? ', no hat' : `, ${HATS[h]?.name || h}`}`;
    }
    outfitLine.classList.toggle('is-preview', tryColor || tryHat);
    colorNameEl.textContent = colorName(c);
    colorHintEl.textContent = tryColor ? ' looks good on you.' : ' is your color.';
  }

  // ---- colors --------------------------------------------------------------
  // The buyable ten, plus any dye the stamp album has unlocked for this account
  // (server/progress.js writes rec.unlockedColors; it rides the welcome profile
  // through publicProfile, so game.state carries it). Deduped and clamped: a
  // stray value from an old record must not paint a swatch of NaN.
  const bonusColors = (Array.isArray(game.state.unlockedColors) ? game.state.unlockedColors : [])
    .map((v) => Math.floor(Number(v)))
    .filter((v) => Number.isFinite(v) && v >= 0 && v <= 0xffffff && !BODY_COLORS.includes(v));
  const paletteColors = [...BODY_COLORS, ...new Set(bonusColors)];

  // The dye tub (N-29). A colour costs the stall's dye price the FIRST time you
  // wear it and is free for ever after, so the charge is a one-off sink and
  // never a tax on changing your mind. Trying colours on stays free: you pay
  // for the change, not for the look. Natural browns are your own coat and
  // milestone dyes are proof of play, so neither is ever charged. And there is
  // no charge at all until the server names a price, which means an unwired
  // server is the old free wardrobe, exactly.
  const paidColors = new Set([game.state.color, ...loadDyes()]);
  for (const v of (Array.isArray(game.state.paidColors) ? game.state.paidColors : [])) {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n)) paidColors.add(n);
  }
  let dyePendingColor = null;
  let dyeTimer = 0;

  function dyePrice(c) {
    if (!rot || !rot.dyePrice) return 0;
    if (c === game.state.color || paidColors.has(c)) return 0;
    if (NATURAL_COLORS.includes(c)) return 0;
    if (bonusColors.includes(c)) return 0;
    return rot.dyePrice;
  }

  const swatchRefs = [];
  paletteColors.forEach((c, i) => {
    const b = elm('button', 'shop-swatch');
    b.type = 'button';
    b.style.setProperty('--sw', hexCss(c));
    b.style.setProperty('--i', String(i));
    b.title = colorName(c);
    b.setAttribute('aria-label', `${colorName(c)} coat`);
    const cost = elm('span', 'shop-swatch-cost');
    const costN = elm('span', null, '0');
    cost.append(elm('span', 'shop-coin shop-coin-sm'), costN);
    cost.hidden = true;
    b.appendChild(cost);
    b.addEventListener('pointerenter', () => { hoverColor = c; syncPreview(); });
    b.addEventListener('pointerleave', () => { hoverColor = null; syncPreview(); });
    b.addEventListener('focus', () => { hoverColor = c; syncPreview(); });
    b.addEventListener('blur', () => { hoverColor = null; syncPreview(); });
    b.addEventListener('click', () => {
      hoverColor = null;
      if (game.state.color === c) { game.audio?.play?.('click'); return; }
      onDyePick(c, b);
    });
    swatchWrap.appendChild(b);
    swatchRefs.push({ el: b, color: c, cost, costN });
  });

  function applyColor(c) {
    paidColors.add(c);
    saveDyes(paidColors);
    game.setColor(c);
    game.audio?.play?.('pop');
    preview?.celebrate(0.55);
    syncPreview();
    refreshSwatches();
  }

  function clearDyePending() {
    dyePendingColor = null;
    if (dyeTimer) { clearTimeout(dyeTimer); dyeTimer = 0; }
  }

  function onDyePick(c, el) {
    if (dyePendingColor !== null) return;
    const price = dyePrice(c);
    if (price <= 0) { applyColor(c); return; }
    if (game.state.coins < price) {
      game.audio?.play?.('fail');
      game.toast(`${colorName(c)} dye costs ${price}. You need ${price - game.state.coins} more.`);
      shake(el);
      return;
    }
    if (!game.net?.connected) {
      // offline / guest: the purse is local anyway, same road as buyHat's offline path
      game.grantCoins(-price, 'shop');
      applyColor(c);
      return;
    }
    dyePendingColor = c;
    game.audio?.play?.('click');
    game.net.send({ t: 'buy-dye', color: c });
    refreshSwatches();
    dyeTimer = setTimeout(() => {
      if (dyePendingColor !== c) return;
      clearDyePending();
      refreshSwatches();
      game.toast('The dye tub is still swirling. Try again.');
    }, 8000);
  }

  // Server reply: {t:'dye', ok, color, coins, delta, colors?}. Same shape of
  // guard as onFurn: correct whether or not the net layer folded it into state.
  function onDye(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    if (m.ok === false) {
      clearDyePending();
      game.audio?.play?.('fail');
      game.toast(m.msg || 'That dye is not in the tub today.');
      refreshSwatches();
      return;
    }
    for (const v of (Array.isArray(m.colors) ? m.colors : [])) {
      const n = Math.floor(Number(v));
      if (Number.isFinite(n)) paidColors.add(n);
    }
    const echoed = Math.floor(Number(m.color));
    const c = Number.isFinite(echoed) ? echoed : dyePendingColor;
    clearDyePending();
    if (typeof m.coins === 'number' && m.coins !== game.state.coins) {
      game.syncCoins(m.coins, Number(m.delta) || 0, 'shop');
    }
    purseN.textContent = String(game.state.coins);
    if (c === null || c === undefined) { refreshSwatches(); return; }
    applyColor(c);
    game.toast(`A fresh coat of ${colorName(c)}. It suits you.`);
  }

  // one quiet line under the swatches, and only while a price is actually set
  const dyeNote = elm('div', 'shop-note shop-dye-note');
  dyeNote.hidden = true;
  swatchWrap.parentElement.appendChild(dyeNote);

  function refreshDyeNote() {
    const price = rot?.dyePrice || 0;
    dyeNote.hidden = price <= 0;
    if (price > 0) {
      dyeNote.textContent = `The dye tub charges ${price} coins for a shade you have not worn before. `
        + 'Your own browns, anything you have worn already, and every dye you earned are free. Trying colours on costs nothing.';
    }
  }

  function refreshSwatches() {
    for (const s of swatchRefs) {
      const on = s.color === game.state.color;
      const price = dyePrice(s.color);
      s.el.classList.toggle('is-on', on);
      s.el.classList.toggle('is-pending', dyePendingColor === s.color);
      s.cost.hidden = on || price <= 0;
      s.costN.textContent = String(price);
      s.el.setAttribute('aria-label', price > 0 && !on
        ? `${colorName(s.color)} coat, ${price} coins`
        : `${colorName(s.color)} coat`);
    }
  }

  // ---- hats ----------------------------------------------------------------
  const hatRefs = new Map();
  let pendingId = null;
  let pendingTimer = 0;

  /** One hat card, appended to whichever rack asked for it (staples or stall). */
  function makeHatCard(id, i, target, secret) {
    const hat = HATS[id];
    const cardEl = elm('div', 'shop-hat');
    cardEl.style.setProperty('--i', String(i));
    if (secret) cardEl.classList.add('is-secret');

    const ribbon = elm('div', 'shop-ribbon', 'EQUIPPED');
    const tier = elm('div', 'shop-tier', tierLabel(hat.price));
    if (hat.price >= 500) tier.classList.add('is-legendary');
    else if (hat.price >= 300) tier.classList.add('is-rare');

    const name = elm('div', 'shop-hat-name', hat.name);
    const blurb = elm('div', 'shop-hat-blurb', HAT_BLURBS[id] || 'A curious find from the driftwood market.');

    const foot = elm('div', 'shop-hat-foot');
    const price = elm('div', 'shop-price');
    if (hat.price > 0) {
      price.appendChild(elm('span', 'shop-coin shop-coin-sm'));
      price.appendChild(elm('span', null, String(hat.price)));
    } else {
      price.classList.add('is-free');
      price.appendChild(elm('span', null, 'FREE'));
    }
    const btn = elm('button', 'shop-hat-btn');
    btn.type = 'button';
    foot.append(price, btn);
    cardEl.append(ribbon, tier, name, blurb, foot);
    if (secret) cardEl.appendChild(elm('div', 'shop-found', 'Found'));
    target.appendChild(cardEl);

    const act = () => onHatAction(id, cardEl);
    btn.addEventListener('click', (e) => { e.stopPropagation(); act(); });
    cardEl.addEventListener('click', act);
    cardEl.addEventListener('pointerenter', () => { hoverHat = id; syncPreview(); });
    cardEl.addEventListener('pointerleave', () => { hoverHat = null; syncPreview(); });
    btn.addEventListener('focus', () => { hoverHat = id; syncPreview(); });
    btn.addEventListener('blur', () => { hoverHat = null; syncPreview(); });

    hatRefs.set(id, { el: cardEl, btn, price });
  }

  function refreshHats() {
    const { ownedHats, hat: worn, coins } = game.state;
    for (const [id, ref] of hatRefs) {
      const { price } = HATS[id];
      const owned = ownedHats.includes(id);
      const equipped = worn === id;
      const pending = pendingId === id;
      const short = !owned && coins < price;

      ref.el.classList.toggle('is-owned', owned);
      ref.el.classList.toggle('is-equipped', equipped);
      ref.el.classList.toggle('is-locked', short && !pending);
      ref.el.classList.toggle('is-pending', pending);
      ref.price.classList.toggle('is-short', short);

      ref.btn.disabled = equipped || pending || (pendingId !== null);
      ref.btn.textContent = '';
      if (pending) {
        ref.btn.appendChild(elm('span', 'shop-spinner'));
        ref.btn.appendChild(elm('span', null, 'Buying'));
      } else if (equipped) {
        ref.btn.textContent = 'Equipped';
      } else if (owned) {
        ref.btn.textContent = 'Equip';
      } else {
        ref.btn.appendChild(elm('span', null, 'Buy for'));
        ref.btn.appendChild(elm('span', 'shop-coin shop-coin-sm'));
        ref.btn.appendChild(elm('span', null, String(price)));
      }
    }
  }

  function clearPending() {
    pendingId = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = 0; }
  }

  function checkPending() {
    if (!pendingId) return;
    if (game.state.ownedHats.includes(pendingId)) {
      const bought = HATS[pendingId];
      clearPending();
      game.audio?.play?.('success');
      game.toast(`${bought.name} is yours!`);
      preview?.celebrate(1);
    }
  }

  function onHatAction(id, cardEl) {
    if (pendingId) return;
    const hat = HATS[id];
    if (!hat) return;

    if (game.state.ownedHats.includes(id)) {
      if (game.state.hat === id) { game.audio?.play?.('click'); return; }
      game.equipHat(id);
      game.audio?.play?.('pop');
      preview?.celebrate(0.7);
      hoverHat = null;
      syncPreview();
      refreshHats();
      return;
    }

    const res = game.buyHat(id);
    if (!res.ok) {
      game.audio?.play?.('fail');
      const missing = hat.price - game.state.coins;
      game.toast(missing > 0 ? `${hat.name} costs ${hat.price}. You need ${missing} more.` : res.msg);
      cardEl.classList.remove('shop-shake');
      void cardEl.offsetWidth; // restart the animation
      cardEl.classList.add('shop-shake');
      return;
    }

    if (res.pending) {
      pendingId = id;
      game.audio?.play?.('click');
      refreshHats();
      pendingTimer = setTimeout(() => {
        if (pendingId !== id) return;
        clearPending();
        refreshHats();
        game.toast('The shopkeeper is still counting. Try again.');
      }, 8000);
      return;
    }

    // offline / guest: purchase already applied locally
    game.equipHat(id);
    game.audio?.play?.('success');
    game.toast(`${hat.name} is yours!`);
    preview?.celebrate(1);
    hoverHat = null;
    syncPreview();
    refreshHats();
  }

  // ---- furniture -----------------------------------------------------------
  const furnRefs = new Map();
  const thumbJobs = [];
  let furnPendingId = null;
  let furnPendingTimer = 0;

  const thumbScale = Math.min(globalThis.devicePixelRatio || 1, 2);
  const thumbPW = Math.round(THUMB_W * thumbScale);
  const thumbPH = Math.round(THUMB_H * thumbScale);

  function shake(el) {
    el.classList.remove('shop-shake');
    void el.offsetWidth; // restart the animation
    el.classList.add('shop-shake');
  }

  /** One furniture card, appended to whichever rack asked for it. */
  function makeFurnCard(id, i, target, secret) {
    const item = FURNITURE[id];
    const cardEl = elm('div', 'shop-furn');
    cardEl.style.setProperty('--i', String(i));
    if (secret) cardEl.classList.add('is-secret');

    const thumb = elm('div', 'shop-furn-thumb');
    const tcanvas = document.createElement('canvas');
    tcanvas.width = thumbPW;
    tcanvas.height = thumbPH;
    tcanvas.setAttribute('aria-hidden', 'true');
    const count = elm('span', 'shop-furn-count');
    thumb.append(tcanvas, count);

    const name = elm('div', 'shop-furn-name', item.name);
    const blurb = elm('div', 'shop-furn-blurb', FURN_BLURBS[id] || 'A fine find from the driftwood market.');

    const foot = elm('div', 'shop-furn-foot');
    const price = elm('div', 'shop-price');
    price.appendChild(elm('span', 'shop-coin shop-coin-sm'));
    price.appendChild(elm('span', null, String(item.price)));
    const btn = elm('button', 'shop-hat-btn shop-furn-btn');
    btn.type = 'button';
    foot.append(price, btn);

    cardEl.append(thumb, name, blurb, foot);
    if (secret) cardEl.appendChild(elm('div', 'shop-found', 'Found'));
    target.appendChild(cardEl);

    // button-only: repeat buys are allowed, so a stray card click must not spend
    btn.addEventListener('click', (e) => { e.stopPropagation(); onFurnBuy(id, cardEl); });

    furnRefs.set(id, { el: cardEl, btn, price, count });
    thumbJobs.push({ id, canvas: tcanvas });
  }

  // ---- racks ---------------------------------------------------------------
  /**
   * Paint the three grids from the current rotation. Called on open and again
   * whenever a 'shop-rot' frame lands, so a rotation that changes mid-browse
   * redraws instead of going stale. Cheap: at most a few dozen small cards.
   */
  function buildRacks() {
    grid.textContent = '';
    fgrid.textContent = '';
    sgrid.textContent = '';
    hatRefs.clear();
    furnRefs.clear();
    thumbJobs.length = 0;

    const stall = stallList();
    const onStall = new Set(stall);
    const hidden = hiddenSet();
    const secretSet = new Set(revealed());

    let i = 0;
    for (const [id] of shopEntries(HATS, (id2) => game.state.ownedHats.includes(id2))) {
      if (onStall.has(id) || hidden.has(id)) continue;
      makeHatCard(id, i++, grid, false);
    }
    i = 0;
    for (const [id] of shopEntries(FURNITURE, (id2) => ownedCount(id2) > 0)) {
      if (onStall.has(id) || hidden.has(id)) continue;
      makeFurnCard(id, i++, fgrid, false);
    }
    i = 0;
    for (const id of stall) {
      const hit = catalogItem(id);
      if (!hit) continue;
      const secret = secretSet.has(id);
      if (hit.kind === 'hat') makeHatCard(id, i++, sgrid, secret);
      else makeFurnCard(id, i++, sgrid, secret);
    }

    refreshStall();
    refreshHats();
    refreshFurniture();
    startThumbs();
  }

  /** The stall's tab, its header line, and the empty case. */
  function refreshStall() {
    const stall = stallList();
    const show = !!rot && (stall.length > 0 || rot.pool.length > 0);
    stallTab.hidden = !show;
    if (!show && lastTab === 'stall') selectTab('hats');
    const found = revealed().length;
    stallNote.textContent = '';
    stallNote.append(
      elm('b', null, 'The Cove Consignment. '),
      elm('span', null, stall.length
        ? 'Whatever came in on the boat this fortnight. When a crate goes back, everything you already bought stays yours.'
        : 'The shelves are between crates just now. Nothing here is going away for good.'),
      elm('span', 'shop-stall-when', ` ${rotateLine(rot?.until || 0)}`),
    );
    if (found > 0) {
      stallNote.append(elm('span', 'shop-stall-when',
        found === 1 ? ' One tucked-away find is on the shelf.' : ` ${found} tucked-away finds are on the shelf.`));
    }
    if (!stall.length && show && !sgrid.firstChild) {
      sgrid.appendChild(elm('div', 'shop-stall-empty',
        'Empty shelves, swept floor, one very patient stallholder. Come back when the boat is in.'));
    }
  }

  /** Swap in a rotation that arrived while the wardrobe was open. */
  function applyRotation(msg) {
    const next = normalizeRotation(msg);
    if (!next) return;
    const windowChanged = (rot?.until || 0) !== next.until;
    rot = next;
    if (windowChanged) {
      // a prop already picked up cannot be put back on the stand, so what this
      // browser found this session is kept rather than quietly taken away
      finds = [...new Set([...loadFinds(next.until), ...finds])];
      saveFinds(next.until, finds);
    }
    for (const key of finds) preview?.takeFind(key);
    refreshDyeNote();
    buildRacks();
    refreshSwatches();
  }

  function ownedCount(id) {
    const owned = game.state.ownedFurniture;
    if (!owned || typeof owned !== 'object') return 0;
    // own-property lookup: ownedFurniture['constructor'] would otherwise be truthy
    if (!Object.prototype.hasOwnProperty.call(owned, id)) return 0;
    return Math.max(0, Math.floor(Number(owned[id]) || 0));
  }

  // Dens belong to registered players, and the server owns the ledger, so a
  // guest or a dropped socket browses instead of buying.
  function canBuyFurniture() {
    return !!(game.net?.connected && game.state.registered);
  }

  function refreshFurniture() {
    const buyable = canBuyFurniture();
    const registered = !!game.state.registered;
    furnNote.classList.toggle('is-on', !buyable);
    if (!buyable) {
      furnNote.textContent = registered
        ? 'The delivery boat is paddling back to shore. Your furniture will be here the moment you reconnect.'
        : 'Guests are welcome to visit any den. Sign up to furnish your own, and this lot is yours to buy.';
    }
    for (const [id, ref] of furnRefs) {
      const item = FURNITURE[id];
      const n = ownedCount(id);
      const pending = furnPendingId === id;
      const full = n >= HOUSE_MAX_ITEMS; // the server refuses past this, mirror it
      const short = buyable && !pending && !full && game.state.coins < item.price;

      ref.el.classList.toggle('is-owned', n > 0);
      ref.el.classList.toggle('is-pending', pending);
      ref.price.classList.toggle('is-short', short);
      ref.count.textContent = `x${n}`;
      ref.count.title = n === 1 ? `You own 1 ${item.name}` : `You own ${n} of these`;

      ref.btn.disabled = !buyable || full || furnPendingId !== null;
      ref.btn.textContent = '';
      ref.btn.setAttribute('aria-label', `${item.name}, ${item.price} coins${n > 0 ? `, you own ${n}` : ''}`);
      if (pending) {
        ref.btn.appendChild(elm('span', 'shop-spinner'));
        ref.btn.appendChild(elm('span', null, 'Buying'));
      } else if (!buyable) {
        ref.btn.textContent = registered ? 'Offline' : 'Sign up';
      } else if (full) {
        ref.btn.textContent = 'Plenty';
      } else {
        ref.btn.textContent = n > 0 ? 'Buy another' : 'Buy';
      }
    }
  }

  function clearFurnPending() {
    furnPendingId = null;
    if (furnPendingTimer) { clearTimeout(furnPendingTimer); furnPendingTimer = 0; }
  }

  function onFurnBuy(id, cardEl) {
    if (furnPendingId) return;
    const item = FURNITURE[id];
    if (!item) return;

    if (!canBuyFurniture()) {
      game.audio?.play?.('fail');
      game.toast(game.state.registered
        ? 'The delivery boat is offline right now. Try again in a moment.'
        : `Sign up to get your own den, and the ${item.name} is yours to buy.`);
      shake(cardEl);
      return;
    }
    if (ownedCount(id) >= HOUSE_MAX_ITEMS) {
      game.audio?.play?.('fail');
      game.toast(`You have plenty of those. Even the ${item.name} needs breathing room.`);
      shake(cardEl);
      return;
    }
    if (game.state.coins < item.price) {
      game.audio?.play?.('fail');
      game.toast(`${item.name} costs ${item.price}. You need ${item.price - game.state.coins} more.`);
      shake(cardEl);
      return;
    }

    furnPendingId = id;
    game.audio?.play?.('click');
    game.net.send({ t: 'buy-furn', id });
    refreshFurniture();
    furnPendingTimer = setTimeout(() => {
      if (furnPendingId !== id) return;
      clearFurnPending();
      refreshFurniture();
      game.toast('The delivery capys are still loading the cart. Try again.');
    }, 8000);
  }

  // Server reply: {t:'furn', ok, coins, delta, ownedFurniture}. The net layer
  // normally folds coins/ownedFurniture into game.state before re-emitting;
  // the guards below make this correct either way instead of assuming.
  function onFurn(msg) {
    const m = msg && typeof msg === 'object' ? msg : {};
    if (m.ok === false) {
      clearFurnPending();
      game.audio?.play?.('fail');
      game.toast(m.msg || 'That one is out of stock at the moment.');
      refreshFurniture();
      return;
    }
    if (m.ownedFurniture && typeof m.ownedFurniture === 'object'
      && game.state.ownedFurniture !== m.ownedFurniture) {
      game.state.ownedFurniture = m.ownedFurniture;
      // let the den editor (and anything else reading state) see the new stock
      game.events.emit('profile', game.state);
    }
    // trust the server's echo first: a reply that arrives after our 8s timeout
    // still gets to say what landed
    const boughtId = typeof m.bought === 'string' ? m.bought : furnPendingId;
    const bought = boughtId && Object.prototype.hasOwnProperty.call(FURNITURE, boughtId)
      ? FURNITURE[boughtId] : null;
    clearFurnPending();
    if (typeof m.coins === 'number' && m.coins !== game.state.coins) {
      game.syncCoins(m.coins, Number(m.delta) || 0, 'shop');
    }
    if (bought) {
      game.audio?.play?.('success');
      game.toast(`${bought.name} is on its way to your den!`);
      preview?.celebrate(0.8);
    }
    purseN.textContent = String(game.state.coins);
    refreshFurniture();
  }

  // Thumbnails: build each catalog mesh once, blit it, throw the mesh away.
  // A rotation can repaint the racks, so the queue is restartable: `furnBuild`
  // is null until the chunk lands, false if there is none, and the builder
  // after that. The shooter's GL context is created on demand and disposed the
  // moment the queue drains, so the wardrobe never sits on two live contexts.
  let thumbRaf = 0;
  let shooter = null;
  let furnBuild = null;
  let thumbLoading = false;

  function paintFallbacks() {
    for (const job of thumbJobs) paintThumb(job.canvas, paintCrate);
    thumbJobs.length = 0;
  }

  function stepThumbs() {
    thumbRaf = 0;
    if (closed) return;
    const t0 = performance.now();
    // a few per frame: 20 little renders in one go would hitch the modal
    while (thumbJobs.length && performance.now() - t0 < 7) {
      const job = thumbJobs.shift();
      let obj = null;
      try { obj = furnBuild(job.id); } catch { obj = null; }
      let shot = false;
      if (obj && obj.isObject3D) {
        try { shot = shooter.shoot(obj); } catch { shot = false; }
        disposeObject(obj);
      }
      paintThumb(job.canvas, shot
        ? (ctx, w, h) => ctx.drawImage(shooter.canvas, 0, 0, w, h)
        : paintCrate);
    }
    if (thumbJobs.length) { thumbRaf = requestAnimationFrame(stepThumbs); return; }
    try { shooter?.dispose(); } catch { /* context may already be lost */ }
    shooter = null;
  }

  function startThumbs() {
    if (closed || !thumbJobs.length || thumbRaf) return;
    if (thumbLoading) return; // the import will call back in here when it lands
    if (furnBuild === null) {
      thumbLoading = true;
      import('../world/furniture.js').then((mod) => {
        thumbLoading = false;
        furnBuild = typeof mod.buildFurniture === 'function' ? mod.buildFurniture
          : typeof mod.default === 'function' ? mod.default : false;
        if (!closed) startThumbs();
      }).catch(() => {
        thumbLoading = false;
        furnBuild = false;
        if (!closed) paintFallbacks();
      });
      return;
    }
    if (furnBuild === false) { paintFallbacks(); return; }
    if (!shooter) {
      try {
        shooter = makeThumbShooter(thumbPW, thumbPH);
      } catch {
        paintFallbacks(); // no WebGL context to spare: crates it is
        return;
      }
    }
    stepThumbs();
  }

  // ---- trails --------------------------------------------------------------
  // The flourish slot: one worn at a time, exactly like a hat, bought on the
  // same 'shop' frame family (server/index.js 'buy-trail' answers with
  // ownedTrails + boughtTrail). Milestone flourishes stay hidden until the
  // stamp album grants one, which is the hat rack's hide-not-show rule again:
  // coins must never be able to reach them.
  const trailRefs = new Map();
  let trailPendingId = null;
  let trailPendingTimer = 0;
  let trailStage = null; // null: not built yet. false: no WebGL, cards sit still.
  let trailRaf = 0;
  let trailLast = 0;
  let trailAcc = 0;
  let trailKey = '';

  const trailPW = Math.round(TRAIL_W * thumbScale);
  const trailPH = Math.round(TRAIL_H * thumbScale);

  function ownedTrails() {
    return Array.isArray(game.state.ownedTrails) ? game.state.ownedTrails : ['none'];
  }
  const ownsTrail = (id) => ownedTrails().includes(id);

  /** One flourish card. Same furniture as a hat card, plus its live diorama. */
  function makeTrailCard(id, i) {
    const tr = TRAILS[id];
    const cardEl = elm('div', 'shop-hat shop-trail');
    cardEl.style.setProperty('--i', String(i));

    const ribbon = elm('div', 'shop-ribbon', 'EQUIPPED');
    const tier = elm('div', 'shop-tier', tierLabel(tr.price));
    if (tr.price >= 500) tier.classList.add('is-legendary');
    else if (tr.price >= 300) tier.classList.add('is-rare');

    const thumb = elm('div', 'shop-trail-thumb');
    const tcanvas = document.createElement('canvas');
    tcanvas.width = trailPW;
    tcanvas.height = trailPH;
    tcanvas.setAttribute('aria-hidden', 'true');
    thumb.appendChild(tcanvas);

    const name = elm('div', 'shop-hat-name', tr.name);
    // an aura is worn standing still, not walking: it is a different promise
    // and the card says so rather than leaving the player to find out
    if (tr.aura) name.appendChild(elm('span', 'shop-aura', 'Aura'));
    const blurb = elm('div', 'shop-hat-blurb', TRAIL_BLURBS[id] || 'A flourish from the driftwood market.');

    const foot = elm('div', 'shop-hat-foot');
    const price = elm('div', 'shop-price');
    if (tr.price > 0) {
      price.appendChild(elm('span', 'shop-coin shop-coin-sm'));
      price.appendChild(elm('span', null, String(tr.price)));
    } else {
      price.classList.add('is-free');
      price.appendChild(elm('span', null, 'FREE'));
    }
    const btn = elm('button', 'shop-hat-btn');
    btn.type = 'button';
    foot.append(price, btn);
    cardEl.append(ribbon, tier, thumb, name, blurb, foot);
    tgrid.appendChild(cardEl);

    const act = () => onTrailAction(id, cardEl);
    btn.addEventListener('click', (e) => { e.stopPropagation(); act(); });
    cardEl.addEventListener('click', act);

    trailRefs.set(id, { el: cardEl, btn, price, canvas: tcanvas });
  }

  /** Rebuild the rack. Cheap, and the only thing that changes the card list is
   *  a milestone flourish arriving, which is worth a redraw. */
  function buildTrails() {
    stopTrailArt();
    try { trailStage?.dispose(); } catch { /* context may already be lost */ }
    if (trailStage) trailStage = null; // false (no WebGL) stays false, it will not improve
    tgrid.textContent = '';
    trailRefs.clear();
    const entries = shopEntries(TRAILS, ownsTrail);
    trailKey = entries.map(([id]) => id).join(',');
    let i = 0;
    for (const [id] of entries) makeTrailCard(id, i++);
    refreshTrails();
    startTrailArt();
  }

  function startTrailArt() {
    if (closed || trailRaf || !trailRefs.size || lastTab !== 'trails') return;
    if (trailStage === false) return; // WebGL refused once: the gradients stand in
    if (!trailStage) {
      try {
        trailStage = makeTrailStage(trailPW, trailPH);
      } catch {
        trailStage = false;
        return;
      }
      for (const [id, ref] of trailRefs) trailStage.add(id, ref.canvas);
    }
    trailLast = 0;
    trailAcc = 0;
    trailRaf = requestAnimationFrame(stepTrailArt);
  }

  function stopTrailArt() {
    if (trailRaf) { cancelAnimationFrame(trailRaf); trailRaf = 0; }
  }

  function stepTrailArt(now) {
    trailRaf = 0;
    if (closed || !trailStage || lastTab !== 'trails') return;
    if (!trailLast) trailLast = now;
    trailAcc += Math.min(0.1, (now - trailLast) / 1000);
    trailLast = now;
    if (trailAcc >= 1 / TRAIL_HZ) {
      const box = tgrid.getBoundingClientRect();
      const dt = trailAcc;
      trailAcc = 0;
      // only what the player can actually see: a rack scrolled past costs
      // nothing at all until it comes back into the window
      trailStage.step(dt, (canvas) => {
        const r = canvas.getBoundingClientRect();
        return r.width > 0 && r.bottom > box.top - 24 && r.top < box.bottom + 24;
      });
    }
    trailRaf = requestAnimationFrame(stepTrailArt);
  }

  function refreshTrails() {
    const worn = game.state.trail || 'none';
    const owned = ownedTrails();
    const { coins } = game.state;
    for (const [id, ref] of trailRefs) {
      const { price } = TRAILS[id];
      const held = owned.includes(id);
      const equipped = worn === id;
      const pending = trailPendingId === id;
      const short = !held && coins < price;

      ref.el.classList.toggle('is-owned', held);
      ref.el.classList.toggle('is-equipped', equipped);
      ref.el.classList.toggle('is-locked', short && !pending);
      ref.el.classList.toggle('is-pending', pending);
      ref.price.classList.toggle('is-short', short);

      ref.btn.disabled = equipped || pending || (trailPendingId !== null);
      ref.btn.textContent = '';
      if (pending) {
        ref.btn.appendChild(elm('span', 'shop-spinner'));
        ref.btn.appendChild(elm('span', null, 'Buying'));
      } else if (equipped) {
        ref.btn.textContent = 'Equipped';
      } else if (held) {
        ref.btn.textContent = id === 'none' ? 'Take off' : 'Equip';
      } else {
        ref.btn.appendChild(elm('span', null, 'Buy for'));
        ref.btn.appendChild(elm('span', 'shop-coin shop-coin-sm'));
        ref.btn.appendChild(elm('span', null, String(price)));
      }
    }
  }

  function clearTrailPending() {
    trailPendingId = null;
    if (trailPendingTimer) { clearTimeout(trailPendingTimer); trailPendingTimer = 0; }
  }

  /** The purchase landed when the server's ownedTrails says so, never before. */
  function checkTrailPending() {
    if (!trailPendingId) return;
    if (ownsTrail(trailPendingId)) {
      const bought = TRAILS[trailPendingId];
      clearTrailPending();
      game.audio?.play?.('success');
      game.toast(`${bought.name} is yours!`);
      preview?.celebrate(1);
    }
  }

  function onTrailAction(id, cardEl) {
    if (trailPendingId) return;
    const tr = TRAILS[id];
    if (!tr) return;

    if (ownsTrail(id)) {
      if ((game.state.trail || 'none') === id) { game.audio?.play?.('click'); return; }
      // 'none' is a real owned entry, so taking a flourish off is the same
      // road as putting one on and needs no special case
      game.equipTrail(id);
      game.audio?.play?.('pop');
      preview?.celebrate(0.7);
      refreshTrails();
      return;
    }

    // Unreachable while the rack hides them, and still refused here: a
    // milestone flourish is proof of play and coins never buy one.
    if (tr.milestone) {
      game.audio?.play?.('fail');
      game.toast('That one is earned, not bought. Fill your stamp album!');
      shake(cardEl);
      return;
    }
    // there is no offline road for a trail: the ledger is the server's, and a
    // local "purchase" would be a promise nobody else could see
    if (!game.net?.connected) {
      game.audio?.play?.('fail');
      game.toast('The stallholder is paddling back to shore. Try again in a moment.');
      shake(cardEl);
      return;
    }
    if (game.state.coins < tr.price) {
      game.audio?.play?.('fail');
      game.toast(`${tr.name} costs ${tr.price}. You need ${tr.price - game.state.coins} more.`);
      shake(cardEl);
      return;
    }

    trailPendingId = id;
    game.audio?.play?.('click');
    game.net.send({ t: 'buy-trail', trail: id });
    refreshTrails();
    trailPendingTimer = setTimeout(() => {
      if (trailPendingId !== id) return;
      clearTrailPending();
      refreshTrails();
      game.toast('The shopkeeper is still counting. Try again.');
    }, 8000);
  }

  // ---- tabs ----------------------------------------------------------------
  const tabs = [...root.querySelectorAll('.shop-tab')];
  const panes = [...root.querySelectorAll('.shop-pane')];
  function selectTab(name) {
    lastTab = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panes) p.classList.toggle('is-on', p.dataset.pane === name);
    subEl.textContent = name === 'furniture' ? SUB_FURN
      : name === 'stall' ? SUB_STALL
        : name === 'trails' ? SUB_TRAIL : SUB_WEAR;
    // The flourishes only animate while somebody is looking at them. The rack
    // is built at the very end of open(), so the first selectTab() lands here
    // with no cards yet and buildTrails() starts the loop itself.
    if (name === 'trails' && trailRefs.size) startTrailArt(); else stopTrailArt();
  }
  for (const t of tabs) {
    t.addEventListener('click', () => {
      if (t.dataset.tab === lastTab) return;
      selectTab(t.dataset.tab);
      game.audio?.play?.('click');
    });
  }
  selectTab(['hats', 'trails', 'furniture', 'stall'].includes(lastTab) ? lastTab : 'colors');

  // ---- live state ----------------------------------------------------------
  function setCoins(total) {
    purseN.textContent = String(total);
    purse.classList.remove('is-bump');
    void purse.offsetWidth;
    purse.classList.add('is-bump');
  }
  purseN.textContent = String(game.state.coins);

  const unsubs = [
    game.events.on('coins', (total) => {
      setCoins(total);
      checkPending();
      checkTrailPending();
      refreshHats();
      refreshTrails();
      refreshFurniture();
    }),
    game.events.on('profile', () => {
      purseN.textContent = String(game.state.coins);
      checkPending();
      checkTrailPending();
      stageName.textContent = game.state.name || 'Capybara';
      refreshSwatches();
      refreshHats();
      // a milestone flourish arriving changes WHICH cards exist, so the rack is
      // rebuilt only when the list itself moved and merely repainted otherwise
      if (shopEntries(TRAILS, ownsTrail).map(([id]) => id).join(',') !== trailKey) buildTrails();
      else refreshTrails();
      refreshFurniture();
      syncPreview();
    }),
    game.events.on('furn', onFurn),
    game.events.on('dye', onDye),
    // a rotation that lands mid-browse repaints the racks instead of going stale
    game.events.on('shop-rot', (m) => { rotFromWire = true; applyRotation(m); }),
    // and the calendar fallback, which also has to CLEAR the stall when the
    // event that stocked it ends while somebody is stood in front of it
    game.events.on('events', (m) => {
      if (rotFromWire) return;
      const synth = rotationFromEvents(m);
      if (synth) { applyRotation(synth); return; }
      if (!rot) return;
      rot = null;
      refreshDyeNote();
      buildRacks();
      refreshSwatches();
    }),
    // reconnecting mid-browse turns the furniture buttons back on, and is the
    // moment to ask the stall what is on the shelves today
    game.events.on('net', () => { refreshFurniture(); askRotation(); }),
  ];

  /** One read, answered with a 'shop-rot' frame. Silent when nothing answers. */
  function askRotation() {
    if (!game.net?.connected) return;
    try { game.net.send({ t: 'shop-rot' }); } catch { /* the cached rotation still stands */ }
  }

  // the countdown line is coarse (hours, days), so once a minute is plenty
  const rotTick = setInterval(() => { if (!closed && rot) refreshStall(); }, 60000);

  refreshSwatches();
  syncPreview();

  // ---- close ---------------------------------------------------------------
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openInstance = null;
    clearPending();
    clearFurnPending();
    clearTrailPending();
    clearDyePending();
    stopTrailArt();
    // the previews hold private particle pools and one GL context of their own
    try { trailStage?.dispose(); } catch { /* context may already be lost */ }
    trailStage = null;
    clearInterval(rotTick);
    for (const off of unsubs) { try { off(); } catch { /* already gone */ } }
    removeEventListener('keydown', onKey, true);
    root.removeEventListener('pointerdown', onBackdrop);
    canvas.removeEventListener('pointerdown', onStagePick);
    if (thumbRaf) { cancelAnimationFrame(thumbRaf); thumbRaf = 0; }
    thumbJobs.length = 0;
    try { shooter?.dispose(); } catch { /* context may already be lost */ }
    shooter = null;
    try { preview?.dispose(); } catch { /* context may already be lost */ }
    preview = null;
    root.classList.add('shop-closing');
    setTimeout(() => root.remove(), 160);
    game.audio?.play?.('click');
  }

  function onBackdrop(e) {
    if (e.target === root) close();
  }
  function onKey(e) {
    // swallow world hotkeys (w/d/m/Enter) while the modal owns the screen;
    // stopPropagation leaves default behaviour (Tab, Space on buttons) intact.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  // ---- the hidden finds ----------------------------------------------------
  /**
   * A click on the diorama, raycast against the three tucked-away props. There
   * is no cursor change and no tooltip on purpose: a secret that signposts
   * itself is just a button, and the point of these is that one player tells
   * another. Finding one reveals a piece of unannounced stall stock (the server
   * already sent the ids, so a find can never mint anything a player could not
   * otherwise buy); with no secret stock in this rotation it is a small warm
   * moment and nothing more.
   */
  function onStagePick(e) {
    if (!preview || closed) return;
    if (e.button > 0) return; // right-drag orbits the world camera, it does not rummage
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -((e.clientY - r.top) / r.height) * 2 + 1;
    let key = null;
    try { key = preview.pick(nx, ny); } catch { key = null; }
    if (!key || finds.includes(key)) return;
    const before = revealed().length;
    finds = [...finds, key];
    saveFinds(rot?.until || 0, finds);
    preview.takeFind(key);
    preview.celebrate(1);
    game.audio?.play?.('success');
    const gained = revealed().length > before;
    game.toast(FIND_LINES[(finds.length - 1) % FIND_LINES.length]
      + (gained ? ' Something new is on the consignment shelf.' : ''), gained ? 4200 : 3000);
    if (gained) { buildRacks(); selectTab('stall'); } else { refreshStall(); }
  }

  root.addEventListener('pointerdown', onBackdrop);
  canvas.addEventListener('pointerdown', onStagePick);
  q('.shop-x').addEventListener('click', close);
  addEventListener('keydown', onKey, true);
  card.focus({ preventScroll: true });
  game.audio?.play?.('whoosh');

  // after `closed` exists: buildRacks starts the thumbnail queue, which bails
  // if the modal is already gone
  for (const key of finds) preview?.takeFind(key);
  refreshDyeNote();
  buildRacks();
  buildTrails();
  askRotation();

  openInstance = { close };
}
