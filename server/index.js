import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  users, saveSoon, ensureFriends, FRIEND_CAP,
  ensureHouse, ensureOwnedFurniture, HOUSE_INVITE_CAP, HOUSE_BOUNDS,
} from './db.js';
import { signup, login, verifyToken, publicProfile } from './auth.js';
import { BotManager } from './bots.js';
import {
  ROOM_IDS, DEFAULT_ROOM, HATS, CHAT_MAX_LEN, NET_TICK_MS,
  NAME_MAX_LEN, NAME_MIN_LEN, clampCoinsForGame, MINIGAMES,
  FURNITURE, HOUSE_MAX_ITEMS, HOUSE_ACCESS_MODES,
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

const LOUNGE_ROOM = 'lounge';
const TABLE_SEATS = 2; // every den game is a duel
const MATCH_START_MS = 1_000; // table fills -> both seats read the roster -> go
const MATCH_MOVE_LIMIT = 25; // relayed moves per second, per player
const MATCH_MOVE_MAX = 2_048; // bytes of JSON in one relayed move
const MATCH_WIN_COINS = 30;

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
// `rooms` counts the live room sets: the fixed ROOM_IDS plus however many dens
// currently have someone standing in them. Handy for spotting a den that failed
// to get reaped when its last visitor left.
app.get('/api/health', (_req, res) => res.json({ ok: true, online: world.players.size, rooms: world.rooms.size }));

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

/** Drop p from its current room set, tell the room, and reap the den if empty. */
function leaveRoomSet(p) {
  const set = world.rooms.get(p.room);
  set?.delete(p.id);
  broadcastToRoom(p.room, { t: 'pleave', id: p.id });
  // dens exist only while somebody is standing in one; the fixed ROOM_IDS sets
  // are permanent (bots live in them even when no player does)
  if (set && set.size === 0 && isHouseRoom(p.room)) world.rooms.delete(p.room);
}

function joinRoom(p, roomId) {
  if (isHouseRoom(roomId)) {
    const key = houseOwnerKey(roomId);
    const gate = houseGate(p, key);
    // The door is checked BEFORE any side effect: someone turned away must not
    // have already left their old room, blinked out for everyone in it, or
    // spawned a room set for a den they never entered.
    if (!gate.ok) { sendTo(p, { t: 'toast', msg: gate.msg || 'That den is closed right now' }); return; }
    roomId = houseRoomId(key); // canonical lowercase id, whatever case was typed
    if (!world.rooms.has(roomId)) world.rooms.set(roomId, new Set());
  }
  if (!world.rooms.has(roomId)) return;
  if (p.room === roomId) return; // already here: re-joining would churn pleave/pjoin on everyone
  // walking away from the mountain gives up your spot on the sled queue (and
  // forfeits a run in progress); the lobby must never list someone who left
  if (p.room === SLED_ROOM) exitSled(p);
  // same deal for the den: leaving the room stands you up from your table, and
  // walking out mid-duel hands the win (and the coins) to whoever stayed
  if (p.room === LOUNGE_ROOM) exitTable(p);
  if (p.room) leaveRoomSet(p);
  p.room = roomId;
  world.rooms.get(roomId).add(p.id);
  sendTo(p, { t: 'room', room: roomId, players: roomSnapshot(roomId) });
  broadcastToRoom(roomId, { t: 'pjoin', p: snapshotFor(p) }, p.id);
  // the lobby only broadcasts on change, so a late arrival would stare at an
  // empty sign-up board until someone else joined or left
  if (roomId === SLED_ROOM) sendTo(p, lobbyPayload());
  // and the den's five boards, for the same reason
  if (roomId === LOUNGE_ROOM) sendTables(p);
}

function leaveWorld(p) {
  exitSled(p);
  exitTable(p);
  if (p.room) leaveRoomSet(p);
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

// ---------- player dens ----------
// Every registered capy owns exactly one den, addressed as 'house:<ownerLower>'.
// Guests own none but may visit the open ones. The room set is created when the
// first visitor is let in and dropped when the last one leaves, so an idle
// server carries nothing for the thousands of dens nobody is standing in.
// Bots never reach them: BotManager only ever picks rooms out of ROOM_IDS.

const HOUSE_PREFIX = 'house:';
const isHouseRoom = (id) => typeof id === 'string' && id.startsWith(HOUSE_PREFIX);
const houseRoomId = (ownerKey) => HOUSE_PREFIX + ownerKey;

/** 'house:Mango' -> 'mango'; null for anything that could never name a den. */
function houseOwnerKey(roomId) {
  return isHouseRoom(roomId) ? friendKey(roomId.slice(HOUSE_PREFIX.length)) : null;
}

const houseName = (rec) => `${rec.username}'s Den`;

/** Display-case names for the guest list (falls back to the key if deleted). */
const inviteNames = (house) => house.invites.map((k) => users.get(k)?.username || k);

/**
 * The door. One place decides who gets in, used by both the join path (which
 * enforces) and house-info (which lets the UI reflect it). Owner always passes.
 */
function houseGate(p, ownerKey) {
  const owner = ownerKey ? users.get(ownerKey) : null;
  if (!owner) return { ok: false, owner: null, msg: 'No capy signed up under that name' };
  const house = ensureHouse(owner);
  const meKey = p.username ? p.username.toLowerCase() : null;
  const isOwner = !!meKey && meKey === ownerKey;
  const isFriend = !!meKey && ensureFriends(owner).includes(meKey);
  const ok = isOwner
    || house.access === 'open'
    || (house.access === 'friends' && isFriend)
    || (house.access === 'invite' && !!meKey && house.invites.includes(meKey));
  let msg = null;
  if (!ok) {
    const gate = house.access === 'friends' ? 'friends-only' : 'invite-only';
    msg = p.registered
      ? `${owner.username}'s den is ${gate}`
      : `${owner.username}'s den is ${gate}: sign up and ask for a spot!`;
  }
  return { ok, owner, house, isOwner, isFriend, msg };
}

/** The house-info reply, told from `p`'s point of view. Null if no such den. */
function housePayload(p, ownerKey) {
  const gate = houseGate(p, ownerKey);
  if (!gate.owner) return null;
  const msg = {
    t: 'house-info',
    owner: gate.owner.username,
    name: houseName(gate.owner),
    access: gate.house.access,
    allowed: gate.ok,
    isOwner: gate.isOwner,
    isFriend: gate.isFriend,
    // a den you cannot walk into does not get to leak its layout either
    furniture: gate.ok ? gate.house.furniture.map((it) => ({ ...it })) : [],
  };
  if (gate.isOwner) {
    // the editor needs both halves and would otherwise need two more round trips
    msg.invites = inviteNames(gate.house);
    msg.ownedFurniture = { ...ensureOwnedFurniture(gate.owner) };
  }
  return msg;
}

/**
 * Re-send house-info to everyone it could have changed for: the owner's tabs
 * (a second one must not keep editing a stale layout) and whoever is currently
 * standing in the den watching the furniture move.
 */
function broadcastHouse(ownerKey) {
  const seen = new Set();
  const inside = [...(world.rooms.get(houseRoomId(ownerKey)) || [])].map((id) => world.players.get(id));
  for (const other of [...sessionsFor(ownerKey), ...inside]) {
    if (!other || seen.has(other.id)) continue;
    seen.add(other.id);
    const payload = housePayload(other, ownerKey);
    if (payload) sendTo(other, payload);
  }
}

/**
 * house-save is all-or-nothing: one bad item rejects the whole layout rather
 * than quietly dropping it, so the client never renders something the server
 * did not store. Placement is capped by what the account actually bought.
 */
function validatePlacements(list, owned) {
  if (!Array.isArray(list)) return { ok: false, msg: 'That layout made no sense' };
  if (list.length > HOUSE_MAX_ITEMS) return { ok: false, msg: `A den fits ${HOUSE_MAX_ITEMS} things, no more` };
  const used = Object.create(null);
  const clean = [];
  for (const it of list) {
    if (!it || typeof it !== 'object' || !has(FURNITURE, it.f)) return { ok: false, msg: 'That is not furniture from the catalog' };
    const x = Number(it.x), z = Number(it.z), rot = Number(it.rot);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(rot)) return { ok: false, msg: 'Could not place that one' };
    if (Math.abs(x) > HOUSE_BOUNDS.x || Math.abs(z) > HOUSE_BOUNDS.z) return { ok: false, msg: 'Keep the furniture inside the den!' };
    used[it.f] = (used[it.f] || 0) + 1;
    const have = has(owned, it.f) ? Math.floor(Number(owned[it.f]) || 0) : 0;
    if (used[it.f] > have) {
      const what = FURNITURE[it.f].name;
      return { ok: false, msg: have ? `You only own ${have} x ${what}` : `You do not own a ${what} yet` };
    }
    clean.push({ f: it.f, x: +x.toFixed(2), z: +z.toFixed(2), rot: +rot.toFixed(3) });
  }
  return { ok: true, clean };
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

// ---------- den tables + PvP matches ----------
// One two-seat table per den game, global like the sled board and tied to the
// lounge. Two capys sit down, the server picks the seed so both sides deal the
// same cards and bounce the same ball, and every move is relayed to the
// opponent and nobody else. A table stays occupied for the whole match, so the
// third capy in the queue waits for a seat that is really free.

const TABLE_GAMES = Object.keys(MINIGAMES).filter((g) => MINIGAMES[g].room === LOUNGE_ROOM);
const tables = new Map(TABLE_GAMES.map((g) => [g, { game: g, seats: [], timer: null }]));

function tablePayload(game) {
  const table = tables.get(game);
  const players = [];
  for (const id of table ? table.seats : []) {
    const seated = world.players.get(id);
    if (seated) players.push({ id: seated.id, name: seated.name });
  }
  return { t: 'table', game, players };
}

function broadcastTable(game) {
  broadcastToRoom(LOUNGE_ROOM, tablePayload(game));
}

/** Every board at once, for someone who just walked into the den. */
function sendTables(p) {
  for (const game of TABLE_GAMES) sendTo(p, tablePayload(game));
}

/** The player id in the other seat, or null once they are gone. */
function otherSeat(match, id) {
  return match.seats.find((x) => x !== id) || null;
}

function joinTable(p, game) {
  if (typeof game !== 'string' || !tables.has(game)) return;
  // the tables are furniture in the den: you cannot sign up for one from the
  // beach, mid-sled-race, or while you are already playing a match
  if (p.room !== LOUNGE_ROOM || p.race || p.match || p.table) return;
  const table = tables.get(game);
  if (table.seats.length >= TABLE_SEATS || table.seats.includes(p.id)) return;
  table.seats.push(p.id);
  p.table = game;
  broadcastTable(game);
  if (table.seats.length >= TABLE_SEATS) {
    if (table.timer) clearTimeout(table.timer);
    table.timer = setTimeout(() => {
      try { startMatch(table); } catch (e) { console.error('[table] start failed:', e?.message || e); }
    }, MATCH_START_MS);
  }
}

/** Stand up from whatever table p is sitting at. True if they were sitting. */
function leaveTable(p) {
  const game = p.table;
  p.table = null;
  const table = game ? tables.get(game) : null;
  if (!table) return false;
  const i = table.seats.indexOf(p.id);
  if (i < 0) return false;
  table.seats.splice(i, 1);
  // a match only ever starts at a full table: a seat opening during the
  // countdown cancels it rather than dealing a hand to one lonely capy
  if (table.timer) { clearTimeout(table.timer); table.timer = null; }
  broadcastTable(game);
  return true;
}

/** Free both seats once a match is over, so the next pair can sit down. */
function clearTable(game, ids) {
  const table = tables.get(game);
  if (!table) return;
  let changed = false;
  for (const id of ids) {
    const i = table.seats.indexOf(id);
    if (i >= 0) { table.seats.splice(i, 1); changed = true; }
    const seated = world.players.get(id);
    if (seated && seated.table === game) seated.table = null;
  }
  if (table.timer) { clearTimeout(table.timer); table.timer = null; }
  if (changed) broadcastTable(game);
}

function startMatch(table) {
  table.timer = null;
  const members = table.seats
    .map((id) => world.players.get(id))
    .filter((p) => p && p.room === LOUNGE_ROOM && p.table === table.game && !p.match && !p.race);
  if (members.length < TABLE_SEATS) {
    // somebody blinked out between sitting down and the deal; drop every seat
    // that no longer resolves so a ghost cannot wedge a table at "full" for good
    for (let i = table.seats.length - 1; i >= 0; i--) {
      const seated = world.players.get(table.seats[i]);
      if (members.includes(seated)) continue;
      table.seats.splice(i, 1);
      if (seated && seated.table === table.game) seated.table = null;
    }
    broadcastTable(table.game);
    return;
  }
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const roster = members.map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat }));
  const match = {
    game: table.game, seed, ended: false,
    seats: members.map((p) => p.id),
    reports: new Map(), // playerId -> { winner, score }
  };
  for (const p of members) p.match = match;
  // youAre is the index into the roster both sides received: player 0 is the
  // authority wherever a den game needs one (ball physics, who moves first)
  members.forEach((p, i) => sendTo(p, { t: 'match-start', game: match.game, players: roster, youAre: i, seed }));
}

/**
 * The one way out of a match. 'done' pays only when both sides name the same
 * winner, so a client that lies about winning simply disagrees with its
 * opponent and nobody is paid; a forfeit pays whoever stayed at the table.
 */
function endMatch(match, reason, forfeitWinner = null) {
  if (match.ended) return;
  match.ended = true;
  let winner = null;
  if (reason === 'forfeit') {
    winner = forfeitWinner;
  } else {
    const ra = match.reports.get(match.seats[0]);
    const rb = match.reports.get(match.seats[1]);
    if (ra && rb && ra.winner && ra.winner === rb.winner) winner = ra.winner;
  }
  const seated = [];
  for (const id of match.seats) {
    const p = world.players.get(id);
    if (p && p.match === match) { p.match = null; seated.push(p); }
  }
  clearTable(match.game, match.seats);
  for (const p of seated) sendTo(p, { t: 'match-end', game: match.game, reason, winner });
  // 'draw' is an agreement, not a capy: it ends the match and pays nobody.
  // Paid after the results so the coin pop lands on top of the win screen.
  if (winner && winner !== 'draw') {
    const champ = world.players.get(winner);
    if (champ) grantCoins(champ, MATCH_WIN_COINS, 'match win');
  }
}

/** Give up a seat and/or a match in progress (leaving the den, or the world). */
function exitTable(p) {
  const match = p.match;
  if (match && !match.ended) endMatch(match, 'forfeit', otherSeat(match, p.id));
  leaveTable(p);
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
            const rec = users.get(username.toLowerCase());
            profile = publicProfile(rec);
            // the den editor needs the inventory from the first frame; a copy,
            // never the live record object (two tabs would share one map)
            profile.ownedFurniture = { ...ensureOwnedFurniture(rec) };
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
            table: null, match: null, matchWindow: 0, matchCount: 0,
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

        // ---- player dens ---------------------------------------------------
        // Same budget as the other social messages: every one of these either
        // fans out to other sockets or writes the stored record.
        case 'house-info': {
          if (socialLimited(p, t0)) break;
          const payload = housePayload(p, friendKey(m.owner));
          if (!payload) { sendTo(p, { t: 'toast', msg: 'No capy signed up under that name' }); break; }
          sendTo(p, payload);
          break;
        }
        case 'house-config': {
          if (socialLimited(p, t0)) break;
          const rec = recordFor(p);
          if (!rec) { sendTo(p, { t: 'toast', msg: 'Sign up to get your own den!' }); break; }
          if (!HOUSE_ACCESS_MODES.includes(m.access)) break;
          ensureHouse(rec).access = m.access;
          saveSoon();
          // owner-only message, so the owner key is the connection's own name:
          // there is no way to ask for a door that is not yours
          broadcastHouse(p.username.toLowerCase());
          break;
        }
        case 'house-invite':
        case 'house-uninvite': {
          if (socialLimited(p, t0)) break;
          const rec = recordFor(p);
          if (!rec) { sendTo(p, { t: 'toast', msg: 'Sign up to get your own den!' }); break; }
          const key = friendKey(m.name);
          if (!key) break; // could never be a username: say nothing
          const meKey = p.username.toLowerCase();
          if (key === meKey) { sendTo(p, { t: 'toast', msg: 'You always have a key to your own den' }); break; }
          // guests have no record to be looked up by, so the list is accounts-only
          const target = users.get(key);
          if (!target) { sendTo(p, { t: 'toast', msg: 'No capy signed up under that name' }); break; }
          const house = ensureHouse(rec);
          if (m.t === 'house-invite') {
            if (!house.invites.includes(key)) {
              if (house.invites.length >= HOUSE_INVITE_CAP) {
                sendTo(p, { t: 'toast', msg: 'Your guest list is full' });
                break;
              }
              house.invites.push(key);
              for (const session of sessionsFor(key)) {
                sendTo(session, { t: 'toast', msg: `${p.name} invited you over to their den!` });
              }
            }
          } else {
            const i = house.invites.indexOf(key);
            if (i >= 0) house.invites.splice(i, 1);
          }
          saveSoon();
          // every tab the owner has open, or the second one edits a stale list
          const guests = { t: 'house-guests', invites: inviteNames(house) };
          for (const session of sessionsFor(meKey)) sendTo(session, guests);
          break;
        }
        case 'house-save': {
          if (socialLimited(p, t0)) break;
          const rec = recordFor(p);
          if (!rec) { sendTo(p, { t: 'toast', msg: 'Sign up to get your own den!' }); break; }
          // the inventory is read off the record, so two tabs saving the same
          // sofa twice cannot conjure a second one
          const check = validatePlacements(m.furniture, ensureOwnedFurniture(rec));
          if (!check.ok) { sendTo(p, { t: 'toast', msg: check.msg }); break; }
          ensureHouse(rec).furniture = check.clean;
          saveSoon();
          broadcastHouse(p.username.toLowerCase());
          break;
        }
        case 'buy-furn': {
          if (socialLimited(p, t0)) break;
          const item = has(FURNITURE, m.id) ? FURNITURE[m.id] : null;
          if (!item || !Number.isFinite(item.price)) return sendTo(p, { t: 'furn', ok: false, msg: 'Unknown furniture' });
          const rec = recordFor(p);
          if (!rec) return sendTo(p, { t: 'furn', ok: false, msg: 'Sign up to get your own den!' });
          // unlike hats, furniture stacks: buying again adds another copy, and
          // the count is what house-save checks placements against
          const owned = ensureOwnedFurniture(rec);
          const have = has(owned, m.id) ? Math.floor(Number(owned[m.id]) || 0) : 0;
          if (have >= HOUSE_MAX_ITEMS) return sendTo(p, { t: 'furn', ok: false, msg: 'You have plenty of those already' });
          // read the live record, not this connection's snapshot, so a second
          // session cannot buy against a balance another one already spent
          const bal = Number.isFinite(rec.coins) ? rec.coins : 0;
          if (bal < item.price) return sendTo(p, { t: 'furn', ok: false, msg: 'Not enough coins' });
          rec.coins = bal - item.price;
          owned[m.id] = have + 1;
          persist(p); // syncs p.coins back off the record
          sendTo(p, {
            t: 'furn', ok: true, coins: p.coins, delta: -item.price,
            ownedFurniture: { ...owned }, bought: m.id,
          });
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

        // ---- den tables + PvP matches ---------------------------------------
        case 'table-join':
          if (socialLimited(p, t0)) break;
          joinTable(p, m.game);
          break;
        case 'table-leave':
          if (socialLimited(p, t0)) break;
          exitTable(p);
          break;
        case 'match-move': {
          // hot path: a paddle sends one of these most frames, so it gets its
          // own budget rather than the social one, and nothing it carries is
          // read here or seen by anyone but the opponent
          const match = p.match;
          if (!match || match.ended) break;
          if (t0 - p.matchWindow > 1000) { p.matchWindow = t0; p.matchCount = 0; }
          if (++p.matchCount > MATCH_MOVE_LIMIT) break;
          if (m.data === undefined) break;
          let size = 0;
          try { size = JSON.stringify(m.data).length; } catch { break; }
          if (!size || size > MATCH_MOVE_MAX) break;
          const other = world.players.get(otherSeat(match, p.id));
          if (other && other.match === match) sendTo(other, { t: 'match-move', from: p.id, data: m.data });
          break;
        }
        case 'match-done': {
          const match = p.match;
          if (!match || match.ended) break;
          if (match.reports.has(p.id)) break; // one report per capy per match
          const result = m.result;
          if (!result || typeof result !== 'object' || Array.isArray(result)) break;
          // a winner who is not sitting at this table is nobody: the report
          // still lands, so the match can end, but it agrees with no one
          const claimed = result.winner;
          const winner = claimed === 'draw' || match.seats.includes(claimed) ? claimed : null;
          const score = Math.max(0, Math.min(10_000_000, Math.floor(Number(result.score) || 0)));
          match.reports.set(p.id, { winner, score });
          if (match.seats.every((id) => match.reports.has(id))) endMatch(match, 'done');
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
  // world.rooms, not ROOM_IDS: occupied dens are room sets too, and their
  // visitors would otherwise never see each other move
  for (const roomId of world.rooms.keys()) {
    const players = roomSnapshot(roomId).map(({ id, x, z, rot, anim }) => ({ id, x, z, rot, anim }));
    if (players.length) broadcastToRoom(roomId, { t: 'state', players });
  }
}, NET_TICK_MS);

server.listen(PORT, () => {
  console.log(`Capy Cove server on http://localhost:${PORT} (rooms: ${ROOM_IDS.join(', ')}, default: ${DEFAULT_ROOM})`);
});
