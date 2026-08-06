import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { users, saveSoon, ensureFriends, FRIEND_CAP } from './db.js';
import { signup, login, verifyToken, publicProfile } from './auth.js';
import { BotManager } from './bots.js';
import {
  ROOM_IDS, DEFAULT_ROOM, HATS, CHAT_MAX_LEN, NET_TICK_MS,
  NAME_MAX_LEN, NAME_MIN_LEN, clampCoinsForGame, MINIGAMES,
} from '../shared/constants.js';

// Client-supplied strings must never reach a catalog through the prototype
// chain: HATS['constructor'] is truthy and HATS['__proto__'] is an object.
const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

const MIN_RUN_MS = 5_000; // a minigame run shorter than this pays nothing
const MAX_COINS_PER_HOUR = 12_000; // rolling backstop, far above honest play
const JOIN_COOLDOWN_MS = 400;
const MSG_BURST_LIMIT = 80; // messages per second before we drop the socket
const HEARTBEAT_MS = 30_000;
const SOCIAL_BURST_LIMIT = 5; // per second, for profile/friends/lobby chatter

const SLED_ROOM = 'peak';
const SLED_LOBBY_MAX = 3;
const RACE_COUNTDOWN_MS = 1_500; // lobby fills -> everyone reads the roster -> go
const RACE_STATE_MS = 200; // ghost relay cadence (~5Hz)
const RACE_MAX_MS = 150_000; // hard stop, so one rage-quit cannot hang a race
const RACE_WIN_COINS = 30;

const USERNAME_RE = new RegExp(`^[a-zA-Z0-9_]{${NAME_MIN_LEN},${NAME_MAX_LEN}}$`);

const PORT = process.env.PORT || 3001;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '16kb' }));

// naive per-IP rate limit for auth endpoints
const authHits = new Map();
function authLimited(ip) {
  const now = Date.now();
  const hits = (authHits.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  authHits.set(ip, hits);
  return hits.length > 12;
}

app.post('/api/signup', (req, res) => {
  if (authLimited(req.ip)) return res.json({ ok: false, msg: 'Slow down a moment' });
  res.json(signup(req.body || {}));
});
app.post('/api/login', (req, res) => {
  if (authLimited(req.ip)) return res.json({ ok: false, msg: 'Slow down a moment' });
  res.json(login(req.body || {}));
});
app.get('/api/me', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const username = verifyToken(token);
  if (!username) return res.json({ ok: false });
  res.json({ ok: true, profile: publicProfile(users.get(username.toLowerCase())) });
});
app.get('/api/health', (_req, res) => res.json({ ok: true, online: world.players.size }));

// dev-only: lets automated playtests save canvas captures to disk
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/debug/shot/:name', express.text({ limit: '10mb', type: '*/*' }), (req, res) => {
    const name = String(req.params.name).replace(/[^\w-]/g, '');
    const b64 = String(req.body).replace(/^data:image\/\w+;base64,/, '');
    const dir = path.join(ROOT, 'data', 'shots');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.jpg`), Buffer.from(b64, 'base64'));
    res.json({ ok: true });
  });
}

// serve the built client in production
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

const server = http.createServer(app);

// ---------- world state ----------
const world = {
  players: new Map(), // id -> player
  rooms: new Map(ROOM_IDS.map((r) => [r, new Set()])),
};
let nextId = 1;

function snapshotFor(p) {
  return {
    id: p.id, name: p.name, bot: !!p.bot,
    x: +p.x.toFixed(2), z: +p.z.toFixed(2), rot: +p.rot.toFixed(2),
    anim: p.anim, color: p.color, hat: p.hat,
  };
}

function sendTo(p, msg) {
  if (p.ws?.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function broadcastToRoom(roomId, msg, exceptId = null) {
  const ids = world.rooms.get(roomId);
  if (!ids) return;
  const raw = JSON.stringify(msg);
  for (const id of ids) {
    const p = world.players.get(id);
    if (p && p.id !== exceptId && p.ws?.readyState === 1) p.ws.send(raw);
  }
}

const bots = new BotManager({ broadcastToRoom, snapshotFor }, { perRoom: 2 });

function roomSnapshot(roomId) {
  const players = [...(world.rooms.get(roomId) || [])]
    .map((id) => world.players.get(id))
    .filter(Boolean)
    .map(snapshotFor);
  for (const b of bots.inRoom(roomId)) players.push(snapshotFor(b));
  return players;
}

function joinRoom(p, roomId) {
  if (!world.rooms.has(roomId)) return;
  if (p.room === roomId) return; // already here: re-joining would churn pleave/pjoin on everyone
  // walking away from the mountain gives up your spot on the sled queue (and
  // forfeits a run in progress); the lobby must never list someone who left
  if (p.room === SLED_ROOM) exitSled(p);
  if (p.room) {
    world.rooms.get(p.room)?.delete(p.id);
    broadcastToRoom(p.room, { t: 'pleave', id: p.id });
  }
  p.room = roomId;
  world.rooms.get(roomId).add(p.id);
  sendTo(p, { t: 'room', room: roomId, players: roomSnapshot(roomId) });
  broadcastToRoom(roomId, { t: 'pjoin', p: snapshotFor(p) }, p.id);
  // the lobby only broadcasts on change, so a late arrival would stare at an
  // empty sign-up board until someone else joined or left
  if (roomId === SLED_ROOM) sendTo(p, lobbyPayload());
}

function leaveWorld(p) {
  exitSled(p);
  if (p.room) {
    world.rooms.get(p.room)?.delete(p.id);
    broadcastToRoom(p.room, { t: 'pleave', id: p.id });
  }
  world.players.delete(p.id);
}

/** The stored account behind a connection, or null for guests. */
function recordFor(p) {
  return p.username ? users.get(p.username.toLowerCase()) || null : null;
}

function persist(p) {
  const rec = recordFor(p);
  if (!rec) return;
  // Coins live on the RECORD, not on the connection: a second session holds its
  // own snapshot from when it connected, so writing p.coins here would let an
  // idle tab roll back a purchase made in the active one. Only buy/score move
  // the balance, and they read-modify-write rec.coins; everything else re-syncs.
  rec.color = p.color;
  rec.hat = p.hat;
  rec.ownedHats = [...new Set([...(rec.ownedHats || ['none']), ...p.ownedHats])];
  rec.bests = rec.bests || {};
  for (const [g, v] of Object.entries(p.bests)) if (v > (rec.bests[g] || 0)) rec.bests[g] = v;
  rec.coins = Number.isFinite(rec.coins) ? rec.coins : 0;
  p.coins = rec.coins;
  p.ownedHats = [...rec.ownedHats];
  saveSoon();
}

const cleanName = (s) => String(s || '').replace(/[^\w \-]/g, '').trim().slice(0, NAME_MAX_LEN);

/**
 * The one road coins travel: rolling hourly backstop, record-first balance
 * (a second session must not roll back the active one), persist, notify.
 * Returns the amount actually paid.
 */
function grantCoins(p, amount, reason) {
  const now = Date.now();
  const payout = Math.max(0, Math.floor(Number(amount) || 0));
  if (payout <= 0) return 0;
  p.earned = p.earned.filter((e) => now - e.t < 3_600_000);
  if (p.earned.reduce((a, e) => a + e.n, 0) + payout > MAX_COINS_PER_HOUR) return 0;
  p.earned.push({ t: now, n: payout });
  const rec = recordFor(p);
  const bal = rec ? rec.coins : p.coins;
  const next = Math.max(0, Math.min(9_999_999, (Number.isFinite(bal) ? bal : 0) + payout));
  if (rec) rec.coins = next;
  p.coins = next;
  persist(p);
  sendTo(p, { t: 'coins', coins: p.coins, delta: payout, reason });
  return payout;
}

/**
 * Budget for the social messages (cards, friends, lobby): each one either fans
 * out to other sockets or writes a stored record, so the 80/sec socket-wide
 * flood guard is far too generous for them. A human clicks about once a second.
 */
function socialLimited(p, now) {
  if (now - p.socialWindow > 1000) { p.socialWindow = now; p.socialCount = 0; }
  return ++p.socialCount > SOCIAL_BURST_LIMIT;
}

// ---------- player cards + friends ----------

/** A connected player or wandering bot, for 'inspect'. */
function findEntity(id) {
  if (typeof id !== 'string' || !id) return null;
  const p = world.players.get(id);
  if (p) return p;
  if (bots.bots instanceof Map) return bots.bots.get(id) || null;
  for (const roomId of ROOM_IDS) {
    const b = bots.inRoom(roomId).find((x) => x.id === id);
    if (b) return b;
  }
  return null;
}

/** Every live session for an account: one player may have several tabs open. */
function sessionsFor(usernameKey) {
  const out = [];
  for (const p of world.players.values()) {
    if (p.username && p.username.toLowerCase() === usernameKey) out.push(p);
  }
  return out;
}

/** Client-supplied name -> a users.js key, or null if it could never be one. */
function friendKey(name) {
  const s = String(name ?? '').trim();
  return USERNAME_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * friend-add/remove target. The player card sends the connection id of whoever
 * it is showing (that is all a client knows about a stranger); the friends list
 * and any scripted client send a username. Accept both, resolve to a users key.
 */
function friendTarget(m) {
  const byName = friendKey(m?.name);
  if (byName) return byName;
  const other = typeof m?.id === 'string' ? world.players.get(m.id) : null;
  return other?.username ? other.username.toLowerCase() : null;
}

function friendsPayload(rec) {
  const friends = ensureFriends(rec).map((key) => {
    const other = users.get(key);
    const online = sessionsFor(key)[0] || null;
    // the live connection id (when they are on) is what the player card is keyed
    // on, so the list can open a card; offline friends simply have none
    return { id: online?.id || null, name: other?.username || key, online: !!online, room: online?.room || null };
  });
  // online first, then alphabetical: the useful half of the list stays on top
  friends.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  return { t: 'friends', friends };
}

function sendFriends(p) {
  const rec = recordFor(p);
  sendTo(p, rec ? friendsPayload(rec) : { t: 'friends', friends: [] });
}

// ---------- sled race lobby ----------
// One global queue, tied to the peak room. Three capys sign the board, the
// server picks the seed so everyone rides the same mountain, and relays each
// rider's progress so the others see ghosts.

const sledLobby = []; // player ids, in sign-up order
let lobbyStartTimer = null;

function lobbyPayload(starting = false) {
  const players = [];
  for (const id of sledLobby) {
    const p = world.players.get(id);
    if (p) players.push({ id: p.id, name: p.name });
  }
  return { t: 'lobby', players, starting };
}

function broadcastLobby(starting = false) {
  broadcastToRoom(SLED_ROOM, lobbyPayload(starting));
}

function removeFromLobby(p) {
  const i = sledLobby.indexOf(p.id);
  if (i < 0) return false;
  sledLobby.splice(i, 1);
  // a rider who backs out during the countdown cancels it: the race only ever
  // starts with a full board, otherwise the last one in gets a solo run
  if (lobbyStartTimer) { clearTimeout(lobbyStartTimer); lobbyStartTimer = null; }
  broadcastLobby(false);
  return true;
}

function joinLobby(p) {
  if (p.room !== SLED_ROOM || p.race) return;
  if (sledLobby.includes(p.id) || sledLobby.length >= SLED_LOBBY_MAX) return;
  sledLobby.push(p.id);
  if (sledLobby.length >= SLED_LOBBY_MAX) {
    broadcastLobby(true);
    if (lobbyStartTimer) clearTimeout(lobbyStartTimer);
    lobbyStartTimer = setTimeout(() => { try { startRace(); } catch (e) { console.error('[race] start failed:', e?.message || e); } }, RACE_COUNTDOWN_MS);
  } else {
    broadcastLobby(false);
  }
}

function startRace() {
  lobbyStartTimer = null;
  const members = sledLobby
    .map((id) => world.players.get(id))
    .filter((p) => p && p.room === SLED_ROOM && !p.race);
  if (members.length < 2) {
    // everyone bailed; drop ids that no longer resolve so a stale entry can
    // never wedge the board at "full" and lock the queue for good
    for (let i = sledLobby.length - 1; i >= 0; i--) {
      const p = world.players.get(sledLobby[i]);
      if (!p || p.room !== SLED_ROOM || p.race) sledLobby.splice(i, 1);
    }
    broadcastLobby(false);
    return;
  }
  sledLobby.length = 0;

  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const race = { seed, ended: false, racers: new Map(), tick: null, timer: null };
  const roster = members.map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat }));
  for (const p of members) {
    p.race = race;
    race.racers.set(p.id, { id: p.id, name: p.name, d: 0, x: 0, done: false, score: 0 });
  }
  for (const p of members) sendTo(p, { t: 'race-start', seed, players: roster });
  broadcastLobby(false); // the board is empty again for everyone still in the room

  race.tick = setInterval(() => {
    try { broadcastRaceState(race); } catch (e) { console.error('[race] relay failed:', e?.message || e); }
  }, RACE_STATE_MS);
  race.timer = setTimeout(() => {
    try { endRace(race); } catch (e) { console.error('[race] end failed:', e?.message || e); }
  }, RACE_MAX_MS);
}

function broadcastRaceState(race) {
  if (race.ended) return;
  const players = [...race.racers.values()].map(({ id, d, x, done }) => ({ id, d, x, done }));
  const raw = JSON.stringify({ t: 'race-state', players });
  for (const id of race.racers.keys()) {
    const p = world.players.get(id);
    if (p && p.race === race && p.ws?.readyState === 1) p.ws.send(raw);
  }
}

function endRace(race) {
  if (race.ended) return;
  race.ended = true;
  clearInterval(race.tick);
  clearTimeout(race.timer);

  const standings = [...race.racers.values()]
    .map(({ id, name, score }) => ({ id, name, score }))
    .sort((a, b) => b.score - a.score);
  const finalists = [];
  for (const id of race.racers.keys()) {
    const p = world.players.get(id);
    if (p && p.race === race) { p.race = null; finalists.push(p); }
  }
  for (const p of finalists) sendTo(p, { t: 'race-end', standings });
  // a real head-to-head pays out; a race that emptied out does not. Paid after
  // the standings so the coin pop lands on top of the results screen.
  const champ = standings[0];
  if (race.racers.size >= 2 && champ && champ.score > 0) {
    const winner = finalists.find((p) => p.id === champ.id);
    if (winner) grantCoins(winner, RACE_WIN_COINS, 'race win');
  }
}

/** Give up a lobby spot and/or a run in progress (leaving the peak, or the world). */
function exitSled(p) {
  removeFromLobby(p);
  const race = p.race;
  if (!race) return;
  p.race = null;
  const r = race.racers.get(p.id);
  if (r && !r.done) { r.done = true; } // keeps whatever they last reported (0 if nothing)
  if ([...race.racers.values()].every((x) => x.done)) endRace(race);
}

// ---------- websocket ----------
// maxPayload: nothing the protocol carries comes close; the ws default is 100MiB.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let p = null;
  let msgWindow = 0;
  let msgCount = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // flood guard: an honest client sends ~10-15 messages a second
    const t0 = Date.now();
    if (t0 - msgWindow > 1000) { msgWindow = t0; msgCount = 0; }
    if (++msgCount > MSG_BURST_LIMIT) { try { ws.close(1008, 'Slow down'); } catch {} return; }

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // "null", "5" and "[]" all parse fine; reading m.t off them throws outside
    // the try below, which would surface as an uncaughtException per bad frame
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (!p && m.t !== 'hello') return;

    // One bad frame must never take the process down with it.
    try {
      switch (m.t) {
        case 'hello': {
          if (p) return;
          let profile = null;
          let username = null;
          if (m.token) {
            username = verifyToken(m.token);
            if (!username) return sendTo({ ws }, { t: 'denied', msg: 'Session expired, log in again' });
            profile = publicProfile(users.get(username.toLowerCase()));
          } else {
            const name = cleanName(m.guestName);
            if (name.length < NAME_MIN_LEN) return sendTo({ ws }, { t: 'denied', msg: 'Invalid name' });
            // Guest progress lives only on the client (nothing is stored here), so
            // we take what it remembers and clamp it. Minting a blank profile on
            // every hello wiped coins/hats/bests on each reconnect and reload.
            const ownedHats = Array.isArray(m.ownedHats)
              ? [...new Set(['none', ...m.ownedHats.filter((h) => has(HATS, h))])].slice(0, 64)
              : ['none'];
            const bests = {};
            if (m.bests && typeof m.bests === 'object') {
              for (const [g, v] of Object.entries(m.bests)) {
                const s = Math.floor(Number(v) || 0);
                if (has(MINIGAMES, g) && s > 0 && s < 10_000_000) bests[g] = s;
              }
            }
            profile = {
              name, coins: Math.max(0, Math.min(99999, Number(m.coins) || 0)),
              color: Number(m.color) || 0xb08a5a,
              hat: has(HATS, m.hat) && ownedHats.includes(m.hat) ? m.hat : 'none',
              ownedHats, bests,
            };
          }
          p = {
            ws, id: `p${nextId++}`, bot: false,
            name: profile.name, username, registered: !!username,
            room: null, x: 0, z: 4, rot: 0, anim: 'idle',
            coins: profile.coins, color: profile.color, hat: profile.hat,
            ownedHats: profile.ownedHats, bests: profile.bests,
            lastChat: 0, joinWindow: 0, joinCount: 0, run: null, earned: [],
            socialWindow: 0, socialCount: 0, race: null,
          };
          world.players.set(p.id, p);
          sendTo(p, { t: 'welcome', id: p.id, profile: { ...profile, registered: p.registered } });
          console.log(`[ws] ${p.name} connected (${p.registered ? 'account' : 'guest'}), online: ${world.players.size}`);
          break;
        }
        case 'join': {
          if (typeof m.room !== 'string') break;
          // room changes cost every other client in both rooms an avatar teardown
          // and rebuild, so cap them well above what a human can trigger
          if (t0 - p.joinWindow > 2000) { p.joinWindow = t0; p.joinCount = 0; }
          if (++p.joinCount > 6) break;
          joinRoom(p, m.room);
          break;
        }
        case 'move': {
          p.x = Math.max(-100, Math.min(100, Number(m.x) || 0));
          p.z = Math.max(-100, Math.min(100, Number(m.z) || 0));
          p.rot = Number(m.rot) || 0;
          if (['idle', 'walk', 'dance', 'sit'].includes(m.anim)) p.anim = m.anim;
          break;
        }
        case 'chat': {
          const now = Date.now();
          if (now - p.lastChat < 400) return;
          p.lastChat = now;
          const text = String(m.text || '').slice(0, CHAT_MAX_LEN).trim();
          if (!text) return;
          broadcastToRoom(p.room, { t: 'chat', id: p.id, name: p.name, text }, p.id);
          break;
        }
        case 'emote':
          if (['wave', 'dance'].includes(m.kind)) {
            if (m.kind === 'dance') p.anim = p.anim === 'dance' ? 'idle' : 'dance';
            broadcastToRoom(p.room, { t: 'emote', id: p.id, kind: m.kind }, p.id);
          }
          break;
        case 'custom': {
          p.color = Number(m.color) || p.color;
          if (has(HATS, m.hat) && (p.ownedHats.includes(m.hat) || !p.registered)) p.hat = m.hat;
          persist(p);
          broadcastToRoom(p.room, { t: 'custom', id: p.id, color: p.color, hat: p.hat }, p.id);
          break;
        }
        // A run must be announced before it can be paid out, so 'score' can no
        // longer be replayed: one payout per started run, and never instantly.
        case 'mgstart':
          if (has(MINIGAMES, m.game)) p.run = { game: m.game, startedAt: t0 };
          break;
        case 'score': {
          const run = p.run;
          p.run = null; // single use
          if (!run || run.game !== m.game) break;
          if (t0 - run.startedAt < MIN_RUN_MS) break;
          grantCoins(p, clampCoinsForGame(m.game, Number(m.coins) || 0), m.game);
          break;
        }
        case 'best': {
          if (!has(MINIGAMES, m.game)) break; // arbitrary keys would bloat users.json forever
          const s = Math.max(0, Math.floor(Number(m.score) || 0));
          if (s > (p.bests[m.game] || 0) && s < 10_000_000) {
            p.bests[m.game] = s;
            persist(p);
          }
          break;
        }
        case 'buy': {
          const hat = has(HATS, m.hat) ? HATS[m.hat] : null;
          if (!hat || !Number.isFinite(hat.price)) return sendTo(p, { t: 'shop', ok: false, msg: 'Unknown hat' });
          // read the live record, not this connection's snapshot, so a second
          // session cannot buy against a balance another one already spent
          const rec = recordFor(p);
          const owned = rec ? rec.ownedHats || ['none'] : p.ownedHats;
          if (owned.includes(m.hat)) return sendTo(p, { t: 'shop', ok: false, msg: 'Already owned' });
          const stored = rec ? rec.coins : p.coins;
          const bal = Number.isFinite(stored) ? stored : 0;
          if (bal < hat.price) return sendTo(p, { t: 'shop', ok: false, msg: 'Not enough coins' });
          if (rec) rec.coins = bal - hat.price;
          p.coins = bal - hat.price;
          p.ownedHats.push(m.hat);
          persist(p);
          sendTo(p, { t: 'shop', ok: true, coins: p.coins, delta: -hat.price, ownedHats: p.ownedHats, bought: m.hat });
          break;
        }

        // ---- player cards + friends ----------------------------------------
        // These fan out to other sockets and touch stored records, so they get
        // a tighter budget than the movement stream: a human clicks, it does not
        // stream. Everything past the guard treats bad input as a no-op.
        case 'inspect': {
          if (socialLimited(p, t0)) break;
          const target = findEntity(m.id);
          if (!target) break;
          const rec = target.bot ? null : recordFor(target);
          sendTo(p, {
            t: 'profile',
            id: target.id,
            name: target.name,
            bot: !!target.bot,
            color: target.color,
            hat: target.hat,
            bests: target.bot ? {} : { ...(rec?.bests || target.bests || {}) },
            registered: !target.bot && !!target.registered,
          });
          break;
        }
        case 'friends': {
          if (socialLimited(p, t0)) break;
          sendFriends(p);
          break;
        }
        case 'friend-add':
        case 'friend-remove': {
          if (socialLimited(p, t0)) break;
          const rec = recordFor(p);
          if (!rec) { sendTo(p, { t: 'toast', msg: 'Make an account to keep friends' }); break; }
          const key = friendTarget(m);
          if (!key) break; // could never be a username: say nothing
          const meKey = p.username.toLowerCase();
          if (key === meKey) { sendTo(p, { t: 'toast', msg: 'You are already your own best friend' }); break; }
          const other = users.get(key);
          // guests have no record to write to, so friendship is accounts-only
          if (!other) { sendTo(p, { t: 'toast', msg: 'No capy signed up under that name' }); sendFriends(p); break; }
          const mine = ensureFriends(rec);
          const theirs = ensureFriends(other);

          if (m.t === 'friend-add') {
            if (!mine.includes(key) && (mine.length >= FRIEND_CAP || theirs.length >= FRIEND_CAP)) {
              sendTo(p, { t: 'toast', msg: 'That friends list is full' });
              sendFriends(p);
              break;
            }
            // both sides always move together: a one-way entry would show up as
            // a friend who never sees you online
            if (!mine.includes(key)) mine.push(key);
            if (!theirs.includes(meKey)) theirs.push(meKey);
          } else {
            const i = mine.indexOf(key);
            if (i >= 0) mine.splice(i, 1);
            const j = theirs.indexOf(meKey);
            if (j >= 0) theirs.splice(j, 1);
          }
          saveSoon();
          // every open tab on both accounts, or the second one keeps showing a
          // list that no longer exists
          const minePayload = friendsPayload(rec);
          sendTo(p, minePayload);
          for (const session of sessionsFor(meKey)) if (session !== p) sendTo(session, minePayload);
          const theirPayload = friendsPayload(other);
          for (const session of sessionsFor(key)) {
            sendTo(session, theirPayload);
            if (m.t === 'friend-add') sendTo(session, { t: 'toast', msg: `${p.name} added you as a friend!` });
          }
          break;
        }

        // ---- sled race lobby -----------------------------------------------
        case 'lobby-join':
          if (socialLimited(p, t0)) break;
          joinLobby(p);
          break;
        case 'lobby-leave':
          if (socialLimited(p, t0)) break;
          removeFromLobby(p);
          break;
        case 'race-progress': {
          // hot path: no broadcast here, the relay tick reads the latest values
          const r = p.race?.racers.get(p.id);
          if (!r || r.done) break;
          r.d = Math.max(0, Math.min(100_000, Number(m.d) || 0));
          r.x = Math.max(-20, Math.min(20, Number(m.x) || 0));
          break;
        }
        case 'race-done': {
          const race = p.race;
          const r = race?.racers.get(p.id);
          if (!r || r.done) break; // one score per racer, no re-reporting
          r.score = Math.max(0, Math.min(10_000_000, Math.floor(Number(m.score) || 0)));
          r.done = true;
          broadcastRaceState(race); // the others see them cross immediately
          if ([...race.racers.values()].every((x) => x.done)) endRace(race);
          break;
        }
      }
    } catch (e) {
      console.error(`[ws] handler error on '${m.t}':`, e?.message || e);
    }
  });

  ws.on('close', () => {
    if (p) {
      persist(p);
      leaveWorld(p);
      console.log(`[ws] ${p.name} left, online: ${world.players.size}`);
    }
  });
  ws.on('error', () => {});
});

// half-open sockets otherwise keep their player entry (and its broadcasts) alive
// until TCP eventually gives up, which can be many minutes.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

// last resort: the game should never die from one unexpected throw
process.on('uncaughtException', (e) => console.error('[fatal]', e));
process.on('unhandledRejection', (e) => console.error('[fatal] unhandled rejection:', e));

// ---------- tick: broadcast positions + run bots ----------
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  bots.update(dt);
  for (const roomId of ROOM_IDS) {
    const players = roomSnapshot(roomId).map(({ id, x, z, rot, anim }) => ({ id, x, z, rot, anim }));
    if (players.length) broadcastToRoom(roomId, { t: 'state', players });
  }
}, NET_TICK_MS);

server.listen(PORT, () => {
  console.log(`Capy Cove server on http://localhost:${PORT} (rooms: ${ROOM_IDS.join(', ')}, default: ${DEFAULT_ROOM})`);
});
