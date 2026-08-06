import { createAvatar } from '../player/avatar.js';
import { NET_TICK_MS } from '../../shared/constants.js';

/**
 * WebSocket client. Owns remote-player entities (avatar + interpolation +
 * name tag + chat bubbles). The engine renders whatever is in
 * engine.remoteGroup; we populate it.
 *
 * Server messages handled here; see server/index.js for the protocol.
 */
export class NetClient {
  constructor(game, engine) {
    this.game = game;
    this.engine = engine;
    this.ws = null;
    this.connected = false;
    this.selfId = null;
    this.remotes = new Map(); // id -> {p, avatar, tag, target:{x,z,rot}, anim}
    this.sendTimer = 0;
    this.lastSent = { x: NaN, z: NaN, rot: NaN, anim: '' };
    this.backoff = 1000;
    this.stopped = false;
    this._snapRoom = null; // room the remotes' ground-snap cache belongs to
  }

  connect({ token = null, guestName = null } = {}) {
    this.auth = { token, guestName };
    this._open();
  }

  _open() {
    if (this.stopped) return;
    // never stack sockets: a double "enter world" (or a stale socket whose
    // onclose scheduled another open) would otherwise leave the old one live,
    // giving the server two players for one browser.
    if (this.ws) {
      const old = this.ws;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch {}
      this.ws = null;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.game.events.emit('net', 'offline');
      this._scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.backoff = 1000;
      const { state } = this.game;
      this.send({
        t: 'hello',
        token: this.auth.token,
        guestName: this.auth.guestName,
        color: state.color,
        hat: state.hat,
        // guest progress lives only here; without it the server mints a blank
        // profile and the welcome wipes coins/hats/bests on every reconnect
        coins: state.coins,
        ownedHats: state.ownedHats,
        bests: state.bests,
      }, true);
    };
    this.ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this._handle(m);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this._clearRemotes();
      // emit even when we never got as far as 'welcome': a first connection that
      // simply fails must not leave the HUD saying "paddling out" forever
      this.game.events.emit('net', 'offline');
      this._scheduleReconnect();
    };
    this.ws.onerror = () => {};
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    setTimeout(() => this._open(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.7, 15000);
  }

  send(obj, force = false) {
    if (!force && !this.connected) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _handle(m) {
    const { game, engine } = this;
    switch (m.t) {
      case 'welcome': {
        this.connected = true;
        this.selfId = m.id;
        game.applyProfile(m.profile);
        game.events.emit('net', 'online');
        // the server just minted a fresh record parked at the room origin, so
        // push our real pose BEFORE rejoining: otherwise a player who is
        // standing still never trips the move gate and everyone else sees them
        // stuck in the middle of the room
        this.lastSent = { x: NaN, z: NaN, rot: NaN, anim: '' };
        const a = engine.playerAvatar;
        if (a) {
          const { x, z } = a.group.position;
          const rot = a.group.rotation.y;
          const anim = a.state.anim;
          this.lastSent = { x, z, rot, anim };
          this.send({ t: 'move', x: +x.toFixed(2), z: +z.toFixed(2), rot: +rot.toFixed(2), anim });
        }
        if (game.roomId) this.send({ t: 'join', room: game.roomId });
        // a run in progress survived the drop; re-announce it so it still pays
        if (game.activeMinigame) this.send({ t: 'mgstart', game: game.activeMinigame });
        break;
      }
      case 'denied': {
        this.stopped = true;
        game.events.emit('net-denied', m.msg);
        game.events.emit('net', 'offline');
        try { this.ws.close(); } catch {}
        break;
      }
      case 'room': {
        this._clearRemotes();
        for (const p of m.players) {
          if (p.id === this.selfId) continue;
          // one malformed record must not wipe the whole room
          try { this._addRemote(p); } catch (e) { console.warn('[net] bad player record', p?.id, e); }
        }
        game.events.emit('population', m.players.length);
        break;
      }
      case 'pjoin':
        if (m.p.id !== this.selfId) {
          try { this._addRemote(m.p); } catch (e) { console.warn('[net] bad player record', m.p?.id, e); }
        }
        break;
      case 'pleave':
        this._removeRemote(m.id);
        break;
      case 'state':
        for (const s of m.players) {
          const r = this.remotes.get(s.id);
          if (!r) continue;
          r.target = s;
          if (s.anim !== r.anim) { r.anim = s.anim; r.avatar.setAnim(s.anim); }
        }
        break;
      case 'chat': {
        const r = this.remotes.get(m.id);
        const name = r?.p.name || m.name || '???';
        if (r) engine.showBubble(r.avatar.group, m.text);
        game.events.emit('chat', { from: m.id, name, text: m.text, self: false });
        break;
      }
      case 'emote': {
        const r = this.remotes.get(m.id);
        if (!r) break;
        if (m.kind === 'wave') r.avatar.playWave();
        if (m.kind === 'dance') r.avatar.setAnim(r.avatar.state.anim === 'dance' ? 'idle' : 'dance');
        break;
      }
      case 'custom': {
        const r = this.remotes.get(m.id);
        if (!r) break;
        r.avatar.setColor(m.color);
        r.avatar.setHat(m.hat);
        break;
      }
      case 'coins':
        game.syncCoins(m.coins, m.delta, m.reason);
        break;
      case 'shop':
        if (m.ok) {
          game.state.ownedHats = m.ownedHats;
          game.syncCoins(m.coins, m.delta ?? 0, 'shop');
          game.events.emit('profile', game.state);
          if (m.bought) game.equipHat(m.bought);
        } else {
          game.toast(m.msg || 'Purchase failed');
        }
        break;
      case 'toast':
        game.toast(m.msg);
        break;
    }
  }

  _addRemote(p) {
    if (this.remotes.has(p.id)) this._removeRemote(p.id);
    const avatar = createAvatar({ color: p.color, hat: p.hat });
    avatar.group.position.set(p.x, 0, p.z);
    avatar.group.rotation.y = p.rot || 0;
    this.engine.remoteGroup.add(avatar.group);
    const tag = this.engine.attachNameTag(avatar.group, p.name, p.bot);
    this.remotes.set(p.id, {
      p, avatar, tag, target: { x: p.x, z: p.z, rot: p.rot || 0 }, anim: 'idle',
      // last position we raycast the ground for; Infinity so the first snap runs
      snapX: Infinity, snapZ: Infinity,
    });
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.tag?.remove();
    this.engine.remoteGroup.remove(r.avatar.group);
    r.avatar.dispose();
    this.remotes.delete(id);
  }

  _clearRemotes() {
    for (const id of [...this.remotes.keys()]) this._removeRemote(id);
  }

  /** Called by the engine every frame. */
  update(dt) {
    // a new room means new ground: force everyone's next ground snap
    if (this.engine.room !== this._snapRoom) {
      this._snapRoom = this.engine.room;
      for (const r of this.remotes.values()) { r.snapX = Infinity; r.snapZ = Infinity; }
    }

    // interpolate remotes toward their latest server state
    const k = Math.min(1, dt * 10);
    for (const r of this.remotes.values()) {
      const g = r.avatar.group;
      g.position.x += (r.target.x - g.position.x) * k;
      g.position.z += (r.target.z - g.position.z) * k;
      const dy = ((((r.target.rot - g.rotation.y) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      g.rotation.y += dy * k;
      // snap remote to ground height of current room. Only when it actually
      // moved: this is a full ground-mesh raycast (thousands of triangles in
      // peak/beach) and idle bots would otherwise pay it every single frame.
      const room = this.engine.room;
      if (room?.groundMeshes?.length
        && Math.abs(g.position.x - r.snapX) + Math.abs(g.position.z - r.snapZ) > 0.01) {
        this.engine.snapY(g.position, room);
        r.snapX = g.position.x;
        r.snapZ = g.position.z;
      }
      r.avatar.update(dt);
    }

    // throttled self position updates
    this.sendTimer += dt * 1000;
    if (this.sendTimer >= NET_TICK_MS && this.connected) {
      this.sendTimer = 0;
      const a = this.engine.playerAvatar;
      if (a) {
        const { x, z } = a.group.position;
        const rot = a.group.rotation.y;
        const anim = a.state.anim;
        const l = this.lastSent;
        if (Math.abs(x - l.x) > 0.01 || Math.abs(z - l.z) > 0.01 || Math.abs(rot - l.rot) > 0.02 || anim !== l.anim) {
          this.lastSent = { x, z, rot, anim };
          this.send({ t: 'move', x: +x.toFixed(2), z: +z.toFixed(2), rot: +rot.toFixed(2), anim });
        }
      }
    }
  }
}
