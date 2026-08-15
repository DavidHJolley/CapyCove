import { Emitter } from './events.js';
import { clampCoinsForGame, DEFAULT_ROOM, HATS } from '../../shared/constants.js';

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
      ownedFurniture: {},
      bests: {},
      // wave 9E: server-owned, never persisted (MOD_FIELDS above)
      role: 'player',
      caps: [],
      muteUntil: 0,
    };
  }

  // ---- profile -------------------------------------------------------------
  applyProfile(p) {
    if (p && p.registered === false) {
      // Guest progress is client-owned and saveLocal() writes whatever lands
      // here, so a server profile may only ever grow it. Belt and braces: the
      // hello frame already ships our coins/hats/bests up.
      const bests = { ...(this.state.bests || {}) };
      for (const [g, v] of Object.entries(p.bests || {})) if (v > (bests[g] || 0)) bests[g] = v;
      p = {
        ...p,
        coins: Math.max(this.state.coins || 0, Number(p.coins) || 0),
        ownedHats: [...new Set([...(this.state.ownedHats || ['none']), ...(p.ownedHats || [])])],
        bests,
      };
    }
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
      const safe = { ...this.state };
      for (const k of MOD_FIELDS) delete safe[k]; // a cached role is a granted role
      localStorage.setItem('capycove-guest', JSON.stringify(safe));
    } catch {}
  }

  loadLocal() {
    try {
      const raw = localStorage.getItem('capycove-guest');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      // belt to saveLocal's braces: a cache written by an older build, or by
      // hand, does not get to hand anyone a capability
      for (const k of MOD_FIELDS) delete saved[k];
      Object.assign(this.state, saved, { registered: false, role: 'player', caps: [], muteUntil: 0 });
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
  equipHat(id) {
    if (!this.state.ownedHats.includes(id)) return false;
    this.state.hat = id;
    this.engine?.playerAvatar?.setHat(id);
    this.net?.send({ t: 'custom', color: this.state.color, hat: id });
    this.events.emit('profile', this.state);
    this.saveLocal();
    return true;
  }

  setColor(hex) {
    this.state.color = hex;
    this.engine?.playerAvatar?.setColor(hex);
    this.net?.send({ t: 'custom', color: hex, hat: this.state.hat });
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
 */
if (import.meta.env && import.meta.env.DEV) window.__game = game;
