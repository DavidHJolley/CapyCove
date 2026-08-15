import { Emitter } from './events.js';
import {
  BODY_COLORS, clampCoinsForGame, DEFAULT_ROOM, FURNITURE, HATS, MINIGAMES, NAME_MAX_LEN, TRAILS,
} from '../../shared/constants.js';

/**
 * Global game singleton: profile state, coins, room/minigame flow control.
 * Everything UI-visible flows through events so the HUD stays in sync:
 *   'coins' (total, delta, reason) | 'toast' (msg) | 'room' (roomId)
 *   'profile' (state) | 'chat' ({from, name, text, self}) | 'minigame' (id|null)
 *   'moderation' ({role, caps, muteUntil})  <- wave 9E, see below
 *
 * Wired up in main.js: game.engine, game.net, game.audio are attached there.
 */

/**
 * MODERATION STATE (wave 9E).
 *
 * `role`, `caps` and `muteUntil` come from the server profile (`publicProfile`
 * + `server/admin.js`'s `profileBits`) and from nowhere else. They are the only
 * three fields in `state` that are deliberately NOT persisted:
 * `capycove-guest` is a file the player owns, so anything replayable out of it
 * is a role anyone can grant themselves. They are stripped on the way OUT
 * (saveLocal) and on the way IN (loadLocal), so a hand-edited cache from any
 * build cannot escalate, and they are re-derived from scratch on every
 * applyProfile so a profile that has lost its caps fails closed rather than
 * leaving the last set standing.
 *
 * None of this is security: the server re-authorises every single `a-*` op
 * (`server/admin.js` performOp). It is what stops the CLIENT from painting
 * buttons that lie.
 */
const MOD_FIELDS = ['role', 'caps', 'muteUntil'];
const MOD_ROLES = ['mod', 'admin']; // anything else, present or absent, is a player
const CAP_RE = /^[a-z][a-z-]{1,15}$/;
const CAPS_MAX = 24;

const cleanRole = (v) => (typeof v === 'string' && MOD_ROLES.includes(v) ? v : 'player');

function cleanCaps(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const c of v) {
    if (out.length >= CAPS_MAX) break;
    if (typeof c !== 'string') continue;
    const s = c.trim().toLowerCase();
    if (CAP_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** ms epoch, 0 = not muted. A number from the wire, treated as a number. */
function cleanMuteUntil(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * GUEST PROFILE SCHEMA (wave 11B).
 *
 * `capycove-guest` is a text file the player owns, so it is read exactly like a
 * frame from an untrusted peer: allowlist the keys, clamp the numbers, cap the
 * arrays, drop the rest on the floor. Before this, `loadLocal` did
 * `Object.assign(this.state, saved)` with whatever JSON.parse handed back, so a
 * hand-edited file could seed the hello frame with any coin total it liked — and
 * could set `__proto__` on the way through, since Object.assign uses [[Set]] and
 * the setter is real.
 *
 * The bounds are deliberately the SAME NUMBERS the server uses on the guest
 * hello (server/index.js: coins 0..99999, hats filtered against HATS, bests
 * 1..9,999,999 for known games). Two walls, one story, so the client never ships
 * a claim the server is only going to reject.
 *
 * This is anti-tamper, NOT an earning cap. Nothing here touches grantCoins or
 * syncCoins: a guest who plays for six hours keeps every coin he earned, online
 * or off. The ceiling only exists at the boundary where a number arrives from a
 * file instead of from play, and it is the ceiling the server already had.
 */
// An ABSURDITY bound, not an earning cap (owner's law: never cap honest play).
// It exists only to stop a hand-edited localStorage file smuggling a silly
// number in; it mirrors the server's guest-hello clamp, and both sit far above
// anything reachable by playing. A guest anywhere near it should make an
// account anyway - that is what accounts are for.
const GUEST_COINS_MAX = 9_999_999;
const GUEST_BEST_MAX = 9_999_999; // server keeps scores 0 < s < 10_000_000
const GUEST_HATS_MAX = 64; // mirrors the server's ownedHats .slice(0, 64)
const GUEST_TRAILS_MAX = 32; // the flourish catalog is half the size; same idea
const GUEST_FURN_MAX = 999; // per id; guests have no house, so this is pure paranoia
const DEFAULT_COLOR = BODY_COLORS[0];

/** Own-property lookup: `saved.bests.constructor` must not read as a score. */
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

/** Floor to an integer inside [lo, hi]; anything unparseable becomes `fallback`. */
function intIn(v, lo, hi, fallback = lo) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Catalog entries a guest can legitimately hold. Milestone cosmetics are earned
 * through server/progress.js, which only writes to account records, so a guest
 * claiming one is a guest who edited the file.
 */
const ownableHat = (id) => typeof id === 'string' && has(HATS, id) && !HATS[id].milestone;
const ownableTrail = (id) => typeof id === 'string' && has(TRAILS, id) && !TRAILS[id].milestone;
const ownableFurn = (id) => has(FURNITURE, id) && !FURNITURE[id].milestone;

/**
 * The whole guest profile, rebuilt field by field from an untrusted object.
 * Returns a fresh plain object containing only the keys below, so anything the
 * schema does not name (a stale field, a server-only field like `title`, a
 * smuggled `role`, `__proto__`) simply does not exist on the way out.
 */
function cleanGuestProfile(src) {
  const out = {
    registered: false, // a guest cache can only ever describe a guest
    coins: intIn(src.coins, 0, GUEST_COINS_MAX, 0),
    // A guest owns exactly the starting palette: the bonus dyes ride
    // `unlockedColors` on an account profile and are never his to claim.
    color: BODY_COLORS.includes(Number(src.color)) ? Number(src.color) : DEFAULT_COLOR,
  };
  if (typeof src.name === 'string') {
    const name = src.name.trim().slice(0, NAME_MAX_LEN);
    if (name) out.name = name; // else leave the constructor's 'Guest' standing
  }
  const hats = ['none'];
  if (Array.isArray(src.ownedHats)) {
    for (const id of src.ownedHats) {
      if (hats.length >= GUEST_HATS_MAX) break;
      if (ownableHat(id) && !hats.includes(id)) hats.push(id);
    }
  }
  out.ownedHats = hats;
  out.hat = typeof src.hat === 'string' && hats.includes(src.hat) ? src.hat : 'none';

  // the flourish slot, read exactly the way the hats above are: allowlisted
  // against the shared catalog, milestone flourishes dropped (they are written
  // by server/progress.js onto an ACCOUNT record and are never a guest's to
  // claim), capped, and 'none' always present so there is something to wear
  const trails = ['none'];
  if (Array.isArray(src.ownedTrails)) {
    for (const id of src.ownedTrails) {
      if (trails.length >= GUEST_TRAILS_MAX) break;
      if (ownableTrail(id) && !trails.includes(id)) trails.push(id);
    }
  }
  out.ownedTrails = trails;
  out.trail = typeof src.trail === 'string' && trails.includes(src.trail) ? src.trail : 'none';

  const bests = {};
  if (src.bests && typeof src.bests === 'object') {
    for (const g of Object.keys(src.bests)) {
      if (!has(MINIGAMES, g)) continue;
      const s = intIn(src.bests[g], 0, GUEST_BEST_MAX, 0);
      if (s > 0) bests[g] = s;
    }
  }
  out.bests = bests;

  const furn = {};
  if (src.ownedFurniture && typeof src.ownedFurniture === 'object') {
    for (const id of Object.keys(src.ownedFurniture)) {
      if (!ownableFurn(id)) continue;
      const n = intIn(src.ownedFurniture[id], 0, GUEST_FURN_MAX, 0);
      if (n > 0) furn[id] = n;
    }
  }
  out.ownedFurniture = furn;
  return out;
}

/** "3 minutes", "2 hours" — the same voice the server uses in its own notice. */
function humanLeft(ms) {
  if (ms >= 3600_000) {
    const h = Math.round(ms / 3600_000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

class Game {
  constructor() {
    this.events = new Emitter();
    this.engine = null; // Engine instance (attached in main.js)
    this.net = null; // NetClient instance
    this.audio = null; // audio module
    this.roomId = null;
    this.activeMinigame = null;
    this.state = {
      name: 'Guest',
      registered: false,
      coins: 0,
      color: 0xb08a5a,
      hat: 'none',
      ownedHats: ['none'],
      trail: 'none',
      ownedTrails: ['none'],
      ownedFurniture: {},
      bests: {},
      // wave 9E: server-owned, never persisted (MOD_FIELDS above)
      role: 'player',
      caps: [],
      muteUntil: 0,
    };
  }

  // ---- profile -------------------------------------------------------------
  /**
   * The server profile WINS, guest or not (wave 11B).
   *
   * This used to Math.max the client's remembered coins/bests over the server's
   * answer, on the reasoning that "a server profile may only ever grow" guest
   * progress. It made the server's correction unenforceable: claim 90,000 coins
   * in localStorage, let the server clamp the hello and send back the real
   * total, and the max put the claim straight back — where saveLocal wrote it
   * out again. The merge was never doing any work either, because the hello
   * frame ships our coins/hats/bests up and the welcome IS that claim, already
   * clamped. Taking the server's word loses a guest nothing he earned honestly
   * and costs a hand-edited file everything it invented.
   */
  applyProfile(p) {
    // one assign carries the whole welcome profile, so `trail`/`ownedTrails`
    // land here the same way `hat`/`ownedHats` do (server/auth.js
    // publicProfile sends copies of both arrays, never the live records)
    Object.assign(this.state, p);
    // AFTER the assign, and unconditionally: role/caps/muteUntil are re-derived
    // from this profile every time, so a frame that has lost them takes the
    // client back to 'player' instead of leaving the last set standing.
    this.applyModeration(p);
    this.events.emit('profile', this.state);
    this.events.emit('coins', this.state.coins, 0, 'sync');
    this.saveLocal();
  }

  /**
   * The one road in for role/caps/muteUntil. `applyProfile` calls it with the
   * welcome profile; it is also the seam for any later live frame (a
   * 'moderated' push, a role change mid-session) — the orchestrator can call
   * `game.applyModeration(bits)` from src/net/client.js with no other change.
   * Pass the whole triple: absent fields mean "not privileged", never "keep".
   */
  applyModeration(bits) {
    const registered = !!this.state.registered;
    // A guest is rank 0 and can never be otherwise: there is no server record to
    // hold the flag, so there is nothing for a stolen guest session to inherit.
    this.state.role = registered ? cleanRole(bits?.role) : 'player';
    this.state.caps = registered ? cleanCaps(bits?.caps) : [];
    this.state.muteUntil = registered ? cleanMuteUntil(bits?.muteUntil) : 0;
    this.events.emit('moderation', {
      role: this.state.role,
      caps: [...this.state.caps],
      muteUntil: this.state.muteUntil,
    });
    return this.state.role;
  }

  /** Does this player hold a capability? The server decides; this paints. */
  can(cap) {
    return Array.isArray(this.state.caps) && this.state.caps.includes(cap);
  }

  /** ms of mute left, 0 when free to speak. */
  mutedFor(now = Date.now()) {
    return Math.max(0, (this.state.muteUntil || 0) - now);
  }

  saveLocal() {
    if (this.state.registered) return; // server is source of truth
    try {
      // written through the same schema it will be read back through, so the
      // file only ever holds keys the reader will accept. MOD_FIELDS are not in
      // the schema, which is the whole point: a cached role is a granted role.
      localStorage.setItem('capycove-guest', JSON.stringify(cleanGuestProfile(this.state)));
    } catch {}
  }

  loadLocal() {
    try {
      const raw = localStorage.getItem('capycove-guest');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
      // belt to saveLocal's braces: a cache written by an older build, or by
      // hand, does not get to hand anyone a capability. cleanGuestProfile drops
      // them too (they are not in the schema); this is the line the file's
      // header promises, and it stays even so.
      for (const k of MOD_FIELDS) delete saved[k];
      Object.assign(this.state, cleanGuestProfile(saved), {
        registered: false, role: 'player', caps: [], muteUntil: 0,
      });
    } catch {}
  }

  // ---- coins ---------------------------------------------------------------
  /** Server-authoritative when online; local fallback offline/guest. */
  grantCoins(delta, reason = '') {
    this.state.coins = Math.max(0, this.state.coins + delta);
    this.events.emit('coins', this.state.coins, delta, reason);
    this.audio?.play?.(delta > 0 ? 'coin' : 'click');
    this.saveLocal();
  }

  /** Absolute value pushed from the server. */
  syncCoins(total, delta = 0, reason = '') {
    this.state.coins = total;
    this.events.emit('coins', total, delta, reason);
    if (delta > 0) this.audio?.play?.('coin');
    this.saveLocal(); // guests: otherwise online earnings only survive by accident
  }

  // ---- rooms ---------------------------------------------------------------
  goToRoom(id, fromId = this.roomId) {
    // a double-clicked exit prompt would otherwise queue a second full room
    // build and make everyone in the room see a spurious leave/join
    if (id === this.roomId && !this.activeMinigame) return;
    if (this.activeMinigame) this.endMinigame();
    this.engine?.switchRoom(id, fromId);
    this.roomId = id;
    this.net?.send({ t: 'join', room: id });
    this.events.emit('room', id);
  }

  // ---- minigames -----------------------------------------------------------
  startMinigame(id) {
    if (this.activeMinigame) return;
    // tell the server a run is starting: it pays out at most one 'score' per
    // announced run, so a flood of score messages can no longer mint coins
    this.net?.send({ t: 'mgstart', game: id });
    this.events.emit('minigame', id);
  }

  endMinigame() {
    this.events.emit('minigame', null);
  }

  /** Called by Minigame.finish(). Coins are clamped client-side AND server-side. */
  reportMinigame(id, score, coins) {
    const payout = clampCoinsForGame(id, coins);
    this.setBest(id, score);
    if (this.net?.connected) {
      this.net.send({ t: 'score', game: id, score, coins: payout });
      // the server pays one score per announced run; re-arm immediately so a
      // "Play again" run inside the same mount is paid too
      if (this.activeMinigame === id) this.net.send({ t: 'mgstart', game: id });
    } else {
      this.grantCoins(payout, id);
    }
  }

  setBest(id, score) {
    if (score > (this.state.bests[id] || 0)) {
      this.state.bests[id] = score;
      this.events.emit('best', id, score);
      this.net?.send({ t: 'best', game: id, score });
      this.saveLocal();
    }
  }

  // ---- social --------------------------------------------------------------
  /**
   * Muted players are told, immediately and locally. The server is still the
   * authority — `admin.handleMessage` eats the frame and sends its own notice
   * at most once a minute — but a line that vanishes with no explanation reads
   * as a broken game, and the round trip is a whole second of doubt. Loud to
   * the muted player, silent to the room: the line is never echoed locally
   * either, because seeing your own words in the log is exactly how a muted
   * player concludes everyone can hear them.
   */
  say(text) {
    text = String(text).trim().slice(0, 120);
    if (!text) return;
    const left = this.mutedFor();
    if (left > 0) {
      this.toast(`You are muted for another ${humanLeft(left)}. You can still play, walk and earn.`, 4200);
      this.audio?.play?.('pop');
      return;
    }
    this.events.emit('chat', { from: 'me', name: this.state.name, text, self: true });
    this.net?.send({ t: 'chat', text });
  }

  emote(kind) {
    if (kind === 'wave') this.engine?.playerAvatar?.playWave();
    if (kind === 'dance') {
      const a = this.engine?.playerAvatar;
      if (a) a.setAnim(a.state.anim === 'dance' ? 'idle' : 'dance');
    }
    if (kind === 'groove') {
      this.engine?.playerAvatar?.playGroove?.();
      this.audio?.play?.('combo'); // escalating mash pitch (falls back silent)
    }
    this.net?.send({ t: 'emote', kind });
  }

  // ---- wardrobe / shop -----------------------------------------------------
  /**
   * The 'custom' frame is the WHOLE look, never a delta: the server assigns
   * every field it is given and broadcasts the lot, so a frame that leaves the
   * trail out would have equipping a hat quietly take everyone else's copy of
   * your flourish off. Every sender below goes through here for that reason.
   */
  _sendCustom() {
    this.net?.send({
      t: 'custom', color: this.state.color, hat: this.state.hat, trail: this.state.trail,
    });
  }

  equipHat(id) {
    if (!this.state.ownedHats.includes(id)) return false;
    this.state.hat = id;
    this.engine?.playerAvatar?.setHat(id);
    this._sendCustom();
    this.events.emit('profile', this.state);
    this.saveLocal();
    return true;
  }

  /**
   * The flourish slot (walk trails and idle auras), equipped exactly the way a
   * hat is. Nothing is rendered from here: src/player/trails.js reads
   * `game.state.trail` every frame for the local capybara, and everyone else
   * sees it through the 'custom' broadcast and the join snapshot.
   */
  equipTrail(id) {
    if (!this.state.ownedTrails.includes(id)) return false;
    this.state.trail = id;
    this._sendCustom();
    this.events.emit('profile', this.state);
    this.saveLocal();
    return true;
  }

  setColor(hex) {
    this.state.color = hex;
    this.engine?.playerAvatar?.setColor(hex);
    this._sendCustom();
    this.events.emit('profile', this.state);
    this.saveLocal();
  }

  buyHat(id) {
    const hat = HATS[id];
    if (!hat) return { ok: false, msg: 'Unknown hat' };
    if (this.state.ownedHats.includes(id)) return { ok: false, msg: 'Already owned' };
    if (this.state.coins < hat.price) return { ok: false, msg: 'Not enough coins' };
    if (this.net?.connected) {
      this.net.send({ t: 'buy', hat: id });
      return { ok: true, pending: true };
    }
    this.grantCoins(-hat.price, 'shop');
    this.state.ownedHats.push(id);
    this.events.emit('profile', this.state);
    this.saveLocal();
    return { ok: true };
  }

  // ---- misc ----------------------------------------------------------------
  toast(msg, ms = 2600) {
    this.events.emit('toast', msg, ms);
  }
}

export const game = new Game();

/**
 * Debug handle, DEV ONLY (AUDIT F-11 / N-16). Both halves of this condition are
 * compile-time constants: Vite defines `import.meta.env` as an object literal
 * and `import.meta.env.DEV` as `false` for a production build, esbuild folds
 * `{…} && false` to `false`, and the whole statement is dropped. The shipped
 * bundle contains no `window.__game` at all, so the four pasted lines that
 * minted 12,000 coins an hour have nothing to grab.
 *
 * Written as `env && env.DEV` for two reasons, both load-bearing:
 *  - under plain Node (the wave's headless import check) `import.meta.env` does
 *    not exist, and the left side short-circuits instead of throwing;
 *  - it is the form that actually folds. `typeof import.meta.env !== 'undefined'
 *    && import.meta.env.DEV` does NOT: esbuild leaves `typeof <ident>` alone and
 *    the assignment survives into the bundle. Verified with the repo's own
 *    esbuild against Vite's real define set.
 *
 * The orchestrator's post-build check:   grep -rn "__game" dist/    -> no hits.
 *
 * Re-audited in wave 11B against a real `npm run build`: this statement is gone
 * from the bundle, the claim holds. What it did NOT hold for was every other
 * debug handle in the tree, so the check no longer relies on anyone remembering
 * to grep — vite.config.js's `debugGlobalGuard` reads the emitted chunks and
 * names any `window.__x = ` that survived.
 */
if (import.meta.env && import.meta.env.DEV) window.__game = game;
