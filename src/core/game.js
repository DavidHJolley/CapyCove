import { Emitter } from './events.js';
import { clampCoinsForGame, DEFAULT_ROOM, HATS } from '../../shared/constants.js';

/**
 * Global game singleton: profile state, coins, room/minigame flow control.
 * Everything UI-visible flows through events so the HUD stays in sync:
 *   'coins' (total, delta, reason) | 'toast' (msg) | 'room' (roomId)
 *   'profile' (state) | 'chat' ({from, name, text, self}) | 'minigame' (id|null)
 *
 * Wired up in main.js: game.engine, game.net, game.audio are attached there.
 */
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
    this.events.emit('profile', this.state);
    this.events.emit('coins', this.state.coins, 0, 'sync');
    this.saveLocal();
  }

  saveLocal() {
    if (this.state.registered) return; // server is source of truth
    try { localStorage.setItem('capycove-guest', JSON.stringify(this.state)); } catch {}
  }

  loadLocal() {
    try {
      const raw = localStorage.getItem('capycove-guest');
      if (raw) Object.assign(this.state, JSON.parse(raw), { registered: false });
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
  say(text) {
    text = String(text).trim().slice(0, 120);
    if (!text) return;
    this.events.emit('chat', { from: 'me', name: this.state.name, text, self: true });
    this.net?.send({ t: 'chat', text });
  }

  emote(kind) {
    if (kind === 'wave') this.engine?.playerAvatar?.playWave();
    if (kind === 'dance') {
      const a = this.engine?.playerAvatar;
      if (a) a.setAnim(a.state.anim === 'dance' ? 'idle' : 'dance');
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
if (typeof window !== 'undefined') window.__game = game; // debug handle
