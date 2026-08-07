import { createAvatar } from '../player/avatar.js';
import { NET_TICK_MS } from '../../shared/constants.js';

// Poses a remote avatar is allowed into. 'sit' rides sleds/benches; anything
// unknown (older server, rogue frame) falls back to idle so nobody gets wedged
// in a pose the rig never animates out of.
const REMOTE_ANIMS = new Set(['idle', 'walk', 'dance', 'sit']);
const safeAnim = (a) => (REMOTE_ANIMS.has(a) ? a : 'idle');

/**
 * Milestone titles ("Legend of the Cove", 40 stamps) ride under the name on the
 * tag. The engine's attachNameTag paints a single line, so the second one is
 * added here: it appends the tag element to overlayRoot synchronously, so the
 * element it just made is the last child. Styling lives with the HUD.
 */
function addTagTitle(engine, title) {
  const el = engine.overlayRoot?.lastElementChild;
  if (!el || !el.classList?.contains('name-tag')) return;
  el.classList.add('has-title');
  const line = document.createElement('span');
  line.className = 'name-title';
  line.textContent = title;
  el.appendChild(line);
}

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
    this.lastTables = new Map(); // game id -> latest 'table' frame (lounge chips)
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
      // hidden tabs: rAF is frozen and timers are throttled, but message
      // handlers always run: piggyback the engine's catch-up tick on traffic
      // (the server's 10Hz state stream makes this reliable)
      if (document.hidden) this.engine.backgroundTick?.();
    };
    this.ws.onclose = () => {
      this.connected = false;
      this._clearRemotes();
      // the server drops us from the sled lobby on disconnect, so clear the
      // lobby UI too rather than leaving a frozen roster of ghosts on the sign
      this.game.events.emit('lobby', { t: 'lobby', players: [], starting: false });
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
        if (game.roomId?.startsWith('house:')) {
          // the den's door may have closed while we were gone (access change,
          // uninvite); a refused rejoin would leave us rendering a room the
          // server thinks we are not in. Reconnect lands at the plaza instead.
          game.toast('Reconnected, waddling back to the plaza');
          game.goToRoom('plaza', null);
        } else if (game.roomId) {
          this.send({ t: 'join', room: game.roomId });
        }
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
        // the lounge builds ~220ms after this frame; replay the cached table
        // boards once it exists so the station chips start correct
        if (m.room === 'lounge' && this.lastTables.size) {
          setTimeout(() => {
            if (game.roomId !== 'lounge') return;
            for (const t of this.lastTables.values()) game.events.emit('table', t);
          }, 1200);
        }
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
          const anim = safeAnim(s.anim);
          if (anim !== r.anim) { r.anim = anim; r.avatar.setAnim(anim); }
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
        if (m.kind === 'groove') r.avatar.playGroove?.();
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
      // ---- player cards / friends ------------------------------------------
      // Re-emitted raw: the UI owns the shape (see server/index.js). Named
      // '*-data' so they never collide with the local 'profile' state event.
      case 'profile':
        game.events.emit('profile-data', m);
        break;
      case 'friends':
        game.events.emit('friends-data', m);
        break;
      // ---- sled race lobby + race relay ------------------------------------
      // The peak room owns the lobby UI and sets game.__raceCtx on 'race-start';
      // the sled minigame reads that ctx and listens for state/end itself.
      case 'lobby':
        game.events.emit('lobby', m);
        break;
      case 'race-start':
        game.events.emit('race-start', m);
        break;
      case 'race-state':
        game.events.emit('race-state', m);
        break;
      case 'race-end':
        game.events.emit('race-end', m);
        break;
      // ---- player houses ---------------------------------------------------
      // Re-emitted raw; the house UIs own the shapes (see server/index.js):
      // 'house-info'   {owner, name, access, allowed, isFriend, furniture}
      // 'house-guests' {invites:[names]}
      // 'furn'         {ok, coins, delta, ownedFurniture}
      case 'house-info':
        game.events.emit('house-info', m);
        break;
      case 'house-guests':
        game.events.emit('house-guests', m);
        break;
      // ---- den tables / PvP matches (wave 4) -------------------------------
      case 'table':
        // cache the latest board per game: the join-time snapshot lands ~200ms
        // before the lounge finishes building, so the room re-reads these
        this.lastTables.set(m.game, m);
        game.events.emit('table', m);
        break;
      // ---- party wave (wave 6): re-emitted raw; rooms/games own the shapes
      case 'dig-tick': case 'ph-lobby': case 'ph-start': case 'ph-state':
      case 'ph-end': case 'dd-lobby': case 'dd-start': case 'dd-words':
      case 'dd-mask': case 'dd-stroke': case 'dd-correct': case 'dd-state':
      case 'dd-end':
        game.events.emit(m.t, m);
        break;
      // ---- the social cove (wave 7) ---------------------------------------
      case 'clock':
        engine.applyClock(m);
        game.events.emit('clock', m);
        break;
      case 'snow': case 'ball': case 'party-start': case 'party-end':
      case 'party': case 'mural': case 'mural-grid': case 'quests':
      case 'quest-done': case 'stamp': case 'stamps': case 'bottle':
      case 'bottle-found':
        game.events.emit(m.t, m);
        break;
      case 'match-start':
        game.events.emit('match-start', m);
        break;
      case 'match-move':
        game.events.emit('match-move', m);
        break;
      case 'match-end':
        game.events.emit('match-end', m);
        break;
      case 'furn':
        // keep the purse and inventory authoritative before the UI reacts
        if (m.ok) {
          if (m.ownedFurniture) {
            game.state.ownedFurniture = m.ownedFurniture;
            game.events.emit('profile', game.state);
          }
          if (Number.isFinite(m.coins)) game.syncCoins(m.coins, m.delta ?? 0, 'furniture');
        }
        game.events.emit('furn', m);
        break;
    }
  }

  _addRemote(p) {
    if (this.remotes.has(p.id)) this._removeRemote(p.id);
    const avatar = createAvatar({ color: p.color, hat: p.hat });
    avatar.group.position.set(p.x, 0, p.z);
    avatar.group.rotation.y = p.rot || 0;
    // adopt the pose from the snapshot: someone already sitting or dancing when
    // we walk in should not pop from idle on their next state frame
    const anim = safeAnim(p.anim);
    avatar.setAnim(anim);
    this.engine.remoteGroup.add(avatar.group);
    const tag = this.engine.attachNameTag(avatar.group, p.name, p.bot);
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (title) addTagTitle(this.engine, title.slice(0, 24));
    this.remotes.set(p.id, {
      p, avatar, tag, target: { x: p.x, z: p.z, rot: p.rot || 0 }, anim,
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
      // rooms without ground (The Drift) sync y too; grounded rooms snap below
      if (!this.engine.room?.groundMeshes?.length && Number.isFinite(r.target.y)) {
        g.position.y += (r.target.y - g.position.y) * k;
      }
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
        const { x, y, z } = a.group.position;
        const rot = a.group.rotation.y;
        const anim = a.state.anim;
        const l = this.lastSent;
        if (Math.abs(x - l.x) > 0.01 || Math.abs(z - l.z) > 0.01 || Math.abs((y || 0) - (l.y || 0)) > 0.02
          || Math.abs(rot - l.rot) > 0.02 || anim !== l.anim) {
          this.lastSent = { x, y, z, rot, anim };
          this.send({ t: 'move', x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2), rot: +rot.toFixed(2), anim });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// visiting player dens
// ---------------------------------------------------------------------------

/** Why the door stayed shut, in a voice that does not blame the visitor. */
function doorClosedLine(m, name, viewerRegistered) {
  const access = typeof m?.access === 'string' ? m.access : '';
  if (access === 'friends') {
    return viewerRegistered
      ? `${name} keeps the den for friends right now. Add each other and knock again!`
      : `${name} keeps the den for friends, and friends need an account. Sign up and knock again!`;
  }
  if (access === 'invite') return `${name}'s den is invite-only right now. Ask for an invite!`;
  return `${name}'s den door is shut right now. Try again later.`;
}

// Only one knock is in the air at a time: a second click replaces the first
// rather than racing it into a room we already left.
let housePending = null;

/**
 * The one "knock on a den door" flow, shared by the game menu, the player card
 * and the friends list. Ask the server about the house and travel there only if
 * it says we may: the server is the authority, this just reflects its answer.
 *
 * Sets `game.__houseCtx = {owner, isOwner, furniture, access}` for the house
 * room to read on build, then hands over to `game.goToRoom`.
 * Never rejects; resolves true when we actually set off, false for a refusal.
 */
export function visitHouse(game, owner) {
  const name = String(owner ?? '').trim();
  if (!game?.events || !name) return Promise.resolve(false);

  const ownerLower = name.toLowerCase();
  const roomId = `house:${ownerLower}`;
  const viewerRegistered = !!game.state?.registered;
  const isOwner = viewerRegistered
    && String(game.state?.name ?? '').trim().toLowerCase() === ownerLower;

  if (game.roomId === roomId) {
    game.toast?.(isOwner ? 'You are already home. Cosy, isn\'t it?' : `You are already in ${name}'s den.`);
    return Promise.resolve(true);
  }
  if (!game.net?.connected) {
    game.audio?.play?.('pop');
    game.toast?.('The cove is offline for a moment, so no doors are opening yet.');
    return Promise.resolve(false);
  }

  housePending?.cancel();

  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    let off = null;

    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      try { off?.(); } catch { /* emitter already dropped it */ }
      if (housePending === handle) housePending = null;
      resolve(ok);
    };
    const handle = { cancel: () => finish(false) };

    off = game.events.on('house-info', (m) => {
      // the same message refreshes everyone standing in a den after a save, so
      // only the reply about the door we knocked on counts
      if (!m || String(m.owner ?? '').trim().toLowerCase() !== ownerLower) return;
      if (m.allowed === false) {
        game.audio?.play?.('pop');
        game.toast?.(doorClosedLine(m, name, viewerRegistered));
        finish(false);
        return;
      }
      game.__houseCtx = {
        owner: typeof m.owner === 'string' && m.owner.trim() ? m.owner.trim() : name,
        // the server says whose den this is; our own guess is only the fallback
        isOwner: typeof m.isOwner === 'boolean' ? m.isOwner : isOwner,
        furniture: Array.isArray(m.furniture) ? m.furniture : [],
        access: typeof m.access === 'string' ? m.access : 'open',
      };
      game.goToRoom(roomId, game.roomId);
      finish(true);
    });

    timer = setTimeout(() => {
      game.toast?.('Nobody is answering that door right now. Try again in a moment.');
      finish(false);
    }, 4000);

    housePending = handle;
    game.net.send({ t: 'house-info', owner: name });
  });
}
