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
import { signup, login, verifyToken, publicProfile, recover, issueRecoveryCodes } from './auth.js';
import { BotManager } from './bots.js';
import * as progress from './progress.js';
import * as admin from './admin.js';
import * as audit from './audit.js';
import * as layouts from './layouts.js';
import * as filter from './filter.js';
import * as chatlog from './chatlog.js';
import * as reports from './reports.js';
import * as econ from './econ.js';
import * as log from './log.js';
import { flush, markSeen, adminSeed, renameAccount, banActive } from './db.js';
import { writeJsonAtomic } from './store.js';
import {
  ROOM_IDS, ROOM_INFO, DEFAULT_ROOM, HATS, CHAT_MAX_LEN, NET_TICK_MS,
  NAME_MAX_LEN, NAME_MIN_LEN, clampCoinsForGame, MINIGAMES,
  FURNITURE, HOUSE_MAX_ITEMS, HOUSE_ACCESS_MODES,
} from '../shared/constants.js';

// Client-supplied strings must never reach a catalog through the prototype
// chain: HATS['constructor'] is truthy and HATS['__proto__'] is an object.
const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

// (the one-size MIN_RUN_MS is gone: server/econ.js holds per-game floors)
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

// The den is two rooms now: the loud floor ('lounge') and the Trophy Loft
// upstairs ('loft', chess + Capy Clash). Nothing here hard-codes which is
// which: a game's table belongs to whatever room shared/constants.js gives it,
// and DEN_ROOMS is only the set of rooms that own at least one table.
const TABLE_SEATS = 2; // every den game is a duel
const MATCH_START_MS = 1_000; // table fills -> both seats read the roster -> go
const MATCH_MOVE_LIMIT = 25; // relayed moves per second, per player
const MATCH_MOVE_MAX = 2_048; // bytes of JSON in one relayed move
const MATCH_WIN_COINS = 30;

const MINE_ROOM = 'mine';
const JUNGLE_ROOM = 'jungle';
const DIG_TICK_MS = 30_000; // passive prospecting cadence
const DIG_COINS = 2;
const GEM_COINS = 25;
const GEM_CHANCE = 0.02; // share of ticks that strike a gem instead

const PARTY_READY_MS = 1_500; // full board -> everyone reads the roster -> go
const PARTY_FILL_MS = 20_000; // viable board -> wait for stragglers -> go

const PH_MSG_LIMIT = 15; // relayed prop-hunt frames per second, per player
const PH_MSG_MAX = 4_096; // bytes of JSON in one relayed frame
const PH_MAX_MS = 240_000; // hard stop, so one AFK hider cannot hang a round

const DD_MOUNT_MS = 1_200; // 'dd-start' -> the doodle chunk is up -> round one
const DD_PICK_MS = 15_000; // drawer picks a word, or the server picks for them
const DD_DRAW_MS = 80_000;
const DD_REVEAL_MS = [40_000, 60_000]; // letters fall out of the mask here
const DD_GAP_MS = 6_000; // reveal screen between rounds
const DD_MAX_ROUNDS = 5;
const DD_STROKE_LIMIT = 20; // relayed stroke frames per second, per player
const DD_STROKE_MAX = 4_096; // bytes of JSON in one stroke frame
const DD_GUESS_LIMIT = 4; // guesses per second, per player
const DD_DRAWER_POINTS = 15; // per capy who guesses your doodle
const DD_GUESS_POINTS = [100, 85, 75, 65, 55, 45, 40]; // by finishing order
const DD_PODIUM_COINS = [20, 10, 5];

// ---- wave 7: the Social Cove (docs/LIVING-COVE.md) -------------------------
// Test hooks: every duration below that a test would otherwise have to WAIT
// for is read from the environment first. Unset (production, dev) they are the
// spec values; the headless ws suite runs a 40-minute cove day in two seconds.
const envMs = (name, spec) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : spec;
};

const COVE_DAY_MS = envMs('COVE_DAY_MS', 40 * 60 * 1000); // one cove day
const CLOCK_MS = envMs('COVE_CLOCK_MS', 10_000); // broadcast cadence
// shifts the phase without touching the wall clock, so a test can stand the
// island at midnight; production never sets it
const CLOCK_OFFSET_MS = Number(process.env.COVE_CLOCK_OFFSET_MS) || 0;
const WEATHER_MIN_MS = envMs('COVE_WEATHER_MIN_MS', 3 * 60 * 1000);
const WEATHER_MAX_MS = envMs('COVE_WEATHER_MAX_MS', 8 * 60 * 1000);
const AURORA_FROM_T = 0.65; // night only
const AURORA_TO_T = 0.90;
const AURORA_CHANCE = Number.isFinite(Number(process.env.COVE_AURORA_CHANCE))
  ? Math.max(0, Math.min(1, Number(process.env.COVE_AURORA_CHANCE)))
  : 0.15; // ~15% of nights
const AURORA_MIN_MS = 180_000;
const AURORA_MAX_MS = 300_000;

const SNOW_ROOM = 'peak';
const SNOW_THROW_MS = 1_000; // one snowball a second, per capy (spec A2)

// The beach ball. Every constant here mirrors src/world/rooms/beach.js so the
// client's local prediction and the server's authority describe the same toy:
// the room eases onto each frame, and matching physics keeps that ease down to
// a nudge instead of a rubber band.
const BALL_ROOM = 'beach';
const BALL_TICK_MS = 100; // 10Hz integration, so every client agrees
const BALL_R = 0.42; // the room's mesh radius
const BALL_GRAVITY = -15;
const BALL_AIR_DRAG = 0.16; // per second, horizontal
const BALL_GROUND_DRAG = 1.7; // per second, once it is rolling on the sand
const BALL_WATER_DRAG = 2.4; // per second, while it is bobbing in the surf
const BALL_BOUNCE = 0.62;
const BALL_MAX_SPEED = 18;
const BALL_IMPULSE_MAX = 9; // one clamped bop; a bigger ask is trimmed, not dropped
// The room lets you click the ball from 6.5 units away and bops it on contact;
// this is that gate plus a pace of slack for the move frame in flight. It is
// still a gate: nobody volleys the ball from the end of the dock.
const BALL_REACH = 7.5;
const BALL_BOP_MS = 300; // just under the room's own 0.35s bop cooldown
// Where the toy lives: the cove centre (beach.js CX/CZ) is the middle of the
// bowl, the shore is roughly 9.5 out, and past that it is in the surf, where
// the water drags it and the swell walks it back to the sand. Nothing is
// clamped until 16, which is well out to sea and only there so a pathological
// frame cannot lose the ball forever.
const BALL_HOME = { x: 1.2, z: 3.4 }; // beach.js BALL_HOME: open sand
const BALL_COVE = { x: 1, z: 1 }; // beach.js CX/CZ
const BALL_SHORE = 9.5;
const BALL_LOST = 16;

// The beach bonfire, mirroring src/world/rooms/beach.js's FIRE (the log pile)
// and COZY_R (the reach of its glow). The room draws the ember halo on anyone
// inside that circle, so the coin has to be paid for exactly the same circle or
// the two would tell different stories about who is warm.
const BONFIRE = { room: 'beach', x: 3.6, z: -5.0, r: 3.0 };
const BONFIRE_MINUTE_MS = envMs('COVE_BONFIRE_MS', 60_000);
const BONFIRE_COIN = 1;
const BONFIRE_CAP = 15; // coins per capy per cove night: a magnet, not an economy

const PARTY_MS = envMs('COVE_PARTY_MS', 30 * 60 * 1000);
const PARTY_COOLDOWN_MS = envMs('COVE_PARTY_COOLDOWN_MS', 90 * 60 * 1000);
const PARTY_ABSENCE_MS = envMs('COVE_PARTY_ABSENCE_MS', 5 * 60 * 1000);
// src/ui/menu.js offers 'den' and 'club'; 'house' is accepted as a synonym so a
// scripted client using the spec's word ("their den or the club") still works.
const PARTY_VENUES = ['club', 'den', 'house'];
const CLUB_ROOM = 'club';

const MURAL_W = 96;
const MURAL_H = 54;
const MURAL_COLORS = 14; // the 12 DESIGN.md colours + cream + ink; 0 is the blank cream
const MURAL_COOLDOWN_MS = envMs('COVE_MURAL_MS', 20_000);
const MURAL_OPS_CAP = 50_000; // rolling op log, for the operator's report snapshots
const MURAL_SAVE_MS = envMs('COVE_MURAL_SAVE_MS', 4_000); // debounce: a busy wall writes at most this often
const MURAL_REPORT_MS = 60_000; // per player: reporting is a disk write
const MURAL_ROOM = 'plaza';

const DRIFT_ROOM = 'drift';
const BOTTLE_COINS = 25;
const BOTTLE_REACH = 4; // how close you have to swim to pick it up
// The bottle's spawn volume. The Drift renders it wherever the server says, so
// this only has to sit inside the room's swimmable box (src/world/rooms/
// drift.js BOUND_MIN/BOUND_MAX: +-30 wide, y 1.3 to 16.5) and clear of the
// seabed dunes, which crest a little over y=1.
const BOTTLE_FIELD = { r: 22, yMin: 2.2, yMax: 7 };

// Poses a move frame may claim. Deliberately unchanged for wave 7: The Drift
// plays 'swim'/'ride' locally but puts 'sit' on the wire (see the header note
// in src/world/rooms/drift.js), because every other client renders remotes from
// this list and would fall back to idle on a pose it has never heard of. What
// travels for swimming is height and the ride flag, not a new anim name.
const MOVE_ANIMS = ['idle', 'walk', 'dance', 'sit'];

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

// signup/login went async in wave 9 (async scrypt): Express 4 does not catch a
// rejected promise from an async handler, so the try/catch is load-bearing
app.post('/api/signup', async (req, res) => {
  if (authLimited(req.ip)) return res.json({ ok: false, msg: 'Slow down a moment' });
  try { res.json(await signup(req.body || {})); }
  catch (e) { console.error('[auth] signup failed:', e.message); res.json({ ok: false, msg: 'Something went wrong, try again' }); }
});
app.post('/api/login', async (req, res) => {
  if (authLimited(req.ip)) return res.json({ ok: false, msg: 'Slow down a moment' });
  try { res.json(await login(req.body || {})); }
  catch (e) { console.error('[auth] login failed:', e.message); res.json({ ok: false, msg: 'Something went wrong, try again' }); }
});
// wave 10E: redeem a recovery code / re-issue after admin reset. Same shape
// and rate limit as login; without these the reveal card would promise a way
// back into the account that does not exist.
app.post('/api/recover', async (req, res) => {
  if (authLimited(req.ip)) return res.json({ ok: false, msg: 'Slow down a moment' });
  try {
    const r = await recover(req.body || {});
    if (r.ok) audit.log({ actor: null, via: 'api', op: 'account.reset.used', target: { name: String(req.body?.username || '').slice(0, 24) } });
    res.json(r);
  } catch (e) { console.error('[auth] recover failed:', e.message); res.json({ ok: false, msg: 'Something went wrong, try again' }); }
});
app.post('/api/recovery', async (req, res) => {
  if (authLimited(req.ip)) return res.json({ ok: false, msg: 'Slow down a moment' });
  try {
    const r = await issueRecoveryCodes(req.body || {});
    if (r.ok) audit.log({ actor: null, via: 'api', op: 'account.password.change', target: { name: String(req.body?.username || '').slice(0, 24) } });
    res.json(r);
  } catch (e) { console.error('[auth] recovery reissue failed:', e.message); res.json({ ok: false, msg: 'Something went wrong, try again' }); }
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
app.get('/api/health', (_req, res) => res.json({ ok: true, online: world.players.size, rooms: world.rooms.size, sockets: wss.clients.size, audit: audit.stats(), econ: econ.stats(), ...log.health() }));
app.get('/api/layout/:room', (req, res) => layouts.httpGet(req, res));

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
  // clean /privacy and /terms URLs (must sit before the SPA catch-all)
  for (const pg of ['privacy', 'terms']) {
    app.get(`/${pg}`, (_req, res) => res.sendFile(path.join(DIST, `${pg}.html`)));
  }
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
  const snap = {
    id: p.id, name: p.name, bot: !!p.bot,
    x: +p.x.toFixed(2), z: +p.z.toFixed(2), rot: +p.rot.toFixed(2),
    anim: p.anim, color: p.color, hat: p.hat,
  };
  // Swimming rooms (The Drift) have no ground to raycast onto, so height and
  // the whale-riding flag have to travel. Both are omitted everywhere else:
  // this snapshot is on the hot path and bots never have either.
  if (p.room === DRIFT_ROOM || p.y) snap.y = +(p.y || 0).toFixed(2);
  if (p.ride) snap.ride = 1;
  // The 40-stamp milestone title, for the second line on the world name tag
  // (src/net/client.js addTagTitle reads exactly this field). Only ever present
  // on the handful of accounts that earned it, so the hot path pays nothing.
  if (p.title) snap.title = p.title;
  return snap;
}

function sendTo(p, msg) {
  if (p.ws?.readyState === 1) { log.frameOut(); p.ws.send(JSON.stringify(msg)); }
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

/** Island-wide: the clock, party toasts and beacons reach everyone, everywhere. */
function broadcastAll(msg) {
  const raw = JSON.stringify(msg);
  for (const p of world.players.values()) {
    if (p.ws?.readyState === 1) p.ws.send(raw);
  }
}

// The bonfire spot travels with the citizens so section B's fire-keepers and
// section A2's coin validation cannot drift apart: one constant, two readers.
// COVE_BOTS is the release kill-switch: the citizens exist to keep a small
// world from feeling dead, and the user's launch plan is no AI at all once
// real players fill the rooms. COVE_BOTS=0 disables every bot (spawning,
// schedules, chatter: the manager just holds an empty map); unset keeps the
// dev default of 2 per room.
const BOTS_PER_ROOM = Math.max(0, Number(process.env.COVE_BOTS ?? 2) || 0);
const bots = new BotManager({ broadcastToRoom, snapshotFor }, { perRoom: BOTS_PER_ROOM, bonfire: BONFIRE });

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
  // walking out mid-duel hands the win (and the coins) to whoever stayed.
  // Both den rooms count, so walking up the stairs from the floor gives up a
  // shuffleboard seat exactly like walking out of the door does
  if (DEN_ROOMS.includes(p.room)) exitTable(p);
  // and for the party games: the mine's hunt and the jungle's doodle are both
  // tied to their room, so walking out drops you from the board and the round
  if (p.room === MINE_ROOM) exitPropHunt(p);
  if (p.room === JUNGLE_ROOM) exitDoodle(p);
  if (p.room) leaveRoomSet(p);
  p.room = roomId;
  // whatever you were riding, you are not riding it in the next room: the flag
  // would otherwise ride along in this join's snapshot
  p.ride = false;
  world.rooms.get(roomId).add(p.id);
  sendTo(p, { t: 'room', room: roomId, players: roomSnapshot(roomId) });
  broadcastToRoom(roomId, { t: 'pjoin', p: snapshotFor(p) }, p.id);
  // the lobby only broadcasts on change, so a late arrival would stare at an
  // empty sign-up board until someone else joined or left
  if (roomId === SLED_ROOM) sendTo(p, lobbyPayload());
  // and the den boards standing in THIS room, for the same reason
  if (DEN_ROOMS.includes(roomId)) sendTables(p, roomId);
  // ...and the party boards in the mine and the jungle
  for (const lob of Object.values(partyLobbies)) if (roomId === lob.room) sendTo(p, partyPayload(lob));
  // wave 7: the room you just walked into has to arrive already running. The
  // clock frame first (the room rebuild reads it for sky/lamps), then whatever
  // this particular room owns.
  sendTo(p, clockFrame());
  // always, even with nothing running: it is also how a stale beacon clears
  sendTo(p, partiesFrame());
  if (roomId === BALL_ROOM) sendBall(p);
  if (roomId === MURAL_ROOM) sendMuralGrid(p);
  if (roomId === DRIFT_ROOM) sendBottle(p);
  markPartyAttendance(p);
  signal('room', p, { room: roomId });
  // wave 12: friends watching this capy see the move at once
  pushPresenceAbout(p);
}

function leaveWorld(p) {
  exitSled(p);
  exitTable(p);
  exitPropHunt(p);
  exitDoodle(p);
  if (p.room) leaveRoomSet(p);
  chatlog.drop(p); // covers every disconnect path, not just ws 'close'
  econ.dropPlayer(p);
  world.players.delete(p.id);
  pushPresenceAbout(p); // runs after the delete, so friends see room: null
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
  if (p.earned.reduce((a, e) => a + e.n, 0) + payout > MAX_COINS_PER_HOUR) {
    // under the owner's law this should almost never fire for an honest
    // player, so every occurrence is worth a look in the log
    log.warn('econ.backstop', { name: p.name, delta: payout, reason, limit: MAX_COINS_PER_HOUR });
    return 0;
  }
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

// progression module boot (quests/stamps/milestones live in server/progress.js)
progress.install({ users, saveSoon, grantCoins, sendTo, broadcastToRoom, has });
// wave 9, the spine: audit first (so admin ops log from the start), then the
// operator module: it takes first refusal on every frame (see :2178 area)
// telemetry first (wave 11D): JSON lines to stdout, COVE_LOG_LEVEL tunes it,
// COVE_LOG_PRETTY=1 gives the human-readable form for a dev terminal
log.install({ base: { pid: process.pid, svc: 'cove' } });
audit.install({ meta: { pid: process.pid } });
if (adminSeed.name) {
  audit.log({ actor: null, via: 'system', op: audit.OPS.ROLE_SEED, target: { uid: adminSeed.uid, name: adminSeed.name }, args: { role: 'admin', applied: adminSeed.applied, missing: adminSeed.missing } });
  if (adminSeed.missing) console.warn(`[admin] COVE_ADMIN=${adminSeed.name} has no account yet`);
}
admin.install({
  users, saveSoon, sendTo, broadcastToRoom, broadcastAll, sessionsFor, recordFor,
  findEntity, world, grantCoins, joinRoom, has, audit: audit.log, auditOps: audit.OPS,
});
chatlog.install({ audit: audit.log, recordFor });
reports.install({ audit: audit.log, sendTo, recordFor, findEntity, chatlog });
layouts.install({ sendTo, broadcastAll, recordFor, audit: audit.log });
econ.install({ sendTo, audit: audit.log, recordFor });

/**
 * Every scoring moment the island produces, handed to the progression module.
 * Wrapped because the quest board must never be able to take down a chat
 * message, a coin payout or the world tick with it: see the name list in
 * server/progress.js's header comment.
 */
function signal(name, p, data) {
  if (!p || p.bot) return;
  try { progress.signal(name, p, data); } catch (e) {
    console.error(`[progress] signal '${name}' failed:`, e?.message || e);
  }
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

// ---------- co-presence (wave 12) ----------
// The island must look alive: room populations for the map pills, and a push
// when one of YOUR friends moves, so "join them" is always one click old, not
// one panel-open old. Bots are deliberately absent from every count.

function popFrame() {
  const rooms = {};
  for (const p of world.players.values()) if (p.room) rooms[p.room] = (rooms[p.room] || 0) + 1;
  return {
    t: 'pop', rooms,
    lobbies: [{ game: 'sled', room: SLED_ROOM, n: sledLobby.length, need: SLED_LOBBY_MAX, ...(lobbyStartAt ? { countdownAt: lobbyStartAt } : {}) }],
  };
}

function fpresenceFrame(rec) {
  return {
    t: 'fpresence',
    friends: ensureFriends(rec).map((key) => {
      const online = sessionsFor(key)[0] || null;
      const other = users.get(key);
      return { name: other?.username || key, room: online?.room || null };
    }),
  };
}

/**
 * q's room just changed (connect, move, disconnect): refresh the presence view
 * of every online player whose friends list names q. Guests are never on a
 * friends list, so they cost nothing here.
 */
function pushPresenceAbout(q) {
  const qKey = q?.username ? q.username.toLowerCase() : null;
  if (!qKey) return;
  for (const p of world.players.values()) {
    if (p === q || !p.username) continue;
    const rec = recordFor(p);
    if (rec && ensureFriends(rec).includes(qKey)) sendTo(p, fpresenceFrame(rec));
  }
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
let lobbyStartAt = 0; // epoch the pending countdown fires; 0 = none

// wave 12: two riders ARE a race. A pair arms a generous fill window (the third
// seat stays open and joining shortens it to the real countdown); a full board
// keeps the original quick countdown. Anyone in the lobby can also Start Now.
const LOBBY_FILL_MS = 20_000;

function lobbyPayload(starting = false) {
  const players = [];
  for (const id of sledLobby) {
    const p = world.players.get(id);
    if (p) players.push({ id: p.id, name: p.name });
  }
  return {
    t: 'lobby', players, starting,
    game: 'sled', n: players.length, need: SLED_LOBBY_MAX,
    ...(lobbyStartAt ? { countdownAt: lobbyStartAt } : {}),
  };
}

function broadcastLobby(starting = false) {
  broadcastToRoom(SLED_ROOM, lobbyPayload(starting));
}

function armLobbyStart(ms, starting) {
  if (lobbyStartTimer) clearTimeout(lobbyStartTimer);
  lobbyStartAt = Date.now() + ms;
  lobbyStartTimer = setTimeout(() => {
    lobbyStartTimer = null;
    lobbyStartAt = 0;
    try { startRace(); } catch (e) { console.error('[race] start failed:', e?.message || e); }
  }, ms);
  broadcastLobby(starting);
}

function removeFromLobby(p) {
  const i = sledLobby.indexOf(p.id);
  if (i < 0) return false;
  sledLobby.splice(i, 1);
  // the countdown survives while a pair remains; below two there is no race
  if (lobbyStartTimer && sledLobby.length < 2) {
    clearTimeout(lobbyStartTimer);
    lobbyStartTimer = null;
    lobbyStartAt = 0;
  }
  broadcastLobby(false);
  return true;
}

function joinLobby(p) {
  if (p.room !== SLED_ROOM || p.race) return;
  if (sledLobby.includes(p.id) || sledLobby.length >= SLED_LOBBY_MAX) return;
  sledLobby.push(p.id);
  if (sledLobby.length >= SLED_LOBBY_MAX) armLobbyStart(RACE_COUNTDOWN_MS, true);
  else if (sledLobby.length >= 2) armLobbyStart(LOBBY_FILL_MS, false);
  else broadcastLobby(false);
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
    lobbyStartAt = 0;
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
  // every finisher's placing, for the quest board ("finish a 3-capy race")
  standings.forEach((row, i) => {
    const racer = finalists.find((x) => x.id === row.id);
    if (racer) signal('race-done', racer, { placed: i + 1, of: standings.length, score: row.score });
  });
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

// Which games are duels at a two-seat table, and which room each one stands in.
// Both come from shared/constants.js: the den games are the ones whose room is
// part of the den (the floor and the loft over it), so moving a table upstairs
// is a one-line change there and nothing here needs to know.
const DEN_ROOMS = ['lounge', 'loft'];
const TABLE_GAMES = Object.keys(MINIGAMES).filter((g) => DEN_ROOMS.includes(MINIGAMES[g].room));
const tables = new Map(TABLE_GAMES.map((g) => [g, { game: g, seats: [], timer: null }]));

/** The room a game's table physically stands in: you must be in it to sit down. */
function tableRoom(game) {
  return Object.prototype.hasOwnProperty.call(MINIGAMES, game) ? MINIGAMES[game].room : null;
}

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
  const room = tableRoom(game);
  if (room) broadcastToRoom(room, tablePayload(game));
}

/** Every board in THIS room, for someone who just walked into it. */
function sendTables(p, roomId = p.room) {
  for (const game of TABLE_GAMES) {
    if (tableRoom(game) === roomId) sendTo(p, tablePayload(game));
  }
}

/** The player id in the other seat, or null once they are gone. */
function otherSeat(match, id) {
  return match.seats.find((x) => x !== id) || null;
}

function joinTable(p, game) {
  if (typeof game !== 'string' || !tables.has(game)) return;
  // the tables are furniture in the den: you cannot sign up for one from the
  // beach, from the floor below the loft it stands on, mid-sled-race, or while
  // you are already playing a match
  if (p.room !== tableRoom(game) || p.race || p.match || p.table) return;
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
    .filter((p) => p && p.room === tableRoom(table.game) && p.table === table.game && !p.match && !p.race);
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
  // wave 11: econ times the duel and counts the moves (N-18)
  econ.matchStarted(match, members);
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
    if (champ) {
      // N-18: an impossible duel (shorter than the game takes to play, or a
      // winner who never moved) pays nothing and signals nothing. A pair
      // trading many wins an hour is LOG-ONLY (owner's law: two friends
      // playing all evening look exactly like that): the win pays in full and
      // the pattern goes to the audit trail for a person to judge.
      const verdict = econ.duelPayout(match, winner, reason);
      if (verdict.pay) grantCoins(champ, MATCH_WIN_COINS, 'match win');
      // an agreed win (or a forfeit): the only den result the server ever sees.
      // `sweep` is the loser's own reported score being zero, which is the
      // closest thing to "without dropping a point" that both sides signed off.
      const beaten = match.reports.get(otherSeat(match, winner));
      const sweep = reason === 'done' && !!beaten && beaten.score === 0;
      if (verdict.signal) signal('match-win', champ, { game: match.game, reason, sweep });
    }
  }
}

/** Give up a seat and/or a match in progress (leaving the den, or the world). */
function exitTable(p) {
  const match = p.match;
  if (match && !match.ended) endMatch(match, 'forfeit', otherSeat(match, p.id));
  leaveTable(p);
}

// ---------- the Glimmer Mine: passive prospecting ----------
// Standing in the mine pays, no clicking required: every 30s each capy in the
// room chips +2 coins out of the wall (~240/hour, a fraction of active play),
// and now and then the pickaxe finds a 25-coin gem instead. The payout rides
// the normal grantCoins road, so the hourly backstop still bounds it.

function digTick() {
  for (const id of world.rooms.get(MINE_ROOM) || []) {
    const p = world.players.get(id);
    if (!p || p.bot) continue;
    const gem = Math.random() < GEM_CHANCE;
    // 'dig-tick' is only the cue for the pickaxe swing and the "+2" mote, so it
    // must not fire when the backstop paid nothing: the animation would lie
    if (grantCoins(p, gem ? GEM_COINS : DIG_COINS, gem ? 'gem!' : 'mining') > 0) {
      sendTo(p, { t: 'dig-tick', gem });
      signal('dig', p, { gem });
    }
  }
}

// ---------- party lobbies (Prop Hunt, Capy Doodles) ----------
// The sled board's shape, twice over: a room-wide sign-up list, a fill window
// so latecomers can pile in, and an instant start once it is full. Unlike the
// sled (which needs exactly three riders) these run at any size in range, so a
// capy backing out only cancels the countdown when the round stops being
// viable. Everything is keyed off the room, so leaving it leaves the board.

const partyLobbies = {
  prophunt: {
    room: MINE_ROOM, min: 2, max: 6, type: 'ph-lobby',
    ids: [], timer: null, starting: false, start: (members) => startPropHunt(members),
  },
  doodle: {
    room: JUNGLE_ROOM, min: 2, max: 8, type: 'dd-lobby',
    ids: [], timer: null, starting: false, start: (members) => startDoodle(members),
  },
};

function partyPayload(lob) {
  const players = [];
  for (const id of lob.ids) {
    const p = world.players.get(id);
    if (p) players.push({ id: p.id, name: p.name });
  }
  return { t: lob.type, players, starting: !!lob.starting };
}

function broadcastParty(lob) {
  broadcastToRoom(lob.room, partyPayload(lob));
}

function armParty(lob, ms) {
  if (lob.timer) clearTimeout(lob.timer);
  lob.timer = setTimeout(() => {
    lob.timer = null;
    try { startParty(lob); } catch (e) { console.error(`[${lob.type}] start failed:`, e?.message || e); }
  }, ms);
}

function joinParty(p, lob) {
  if (!lob || p.room !== lob.room) return;
  if (p.race || p.match || p.ph || p.dd) return; // already busy elsewhere
  if (lob.ids.includes(p.id) || lob.ids.length >= lob.max) return;
  lob.ids.push(p.id);
  if (lob.ids.length >= lob.max) {
    // spec says a full board starts "instantly"; it gets the same 1.5s beat the
    // sled race takes, so the last capy in still sees who they are playing with
    lob.starting = true;
    armParty(lob, PARTY_READY_MS);
  } else if (lob.ids.length >= lob.min && !lob.timer) {
    // the fill window opens when the board first becomes playable, not on the
    // first signature: one capy alone would otherwise start a 20s countdown to
    // nothing, over and over
    lob.starting = true;
    armParty(lob, PARTY_FILL_MS);
  }
  broadcastParty(lob);
}

/** Give up a spot on a party board. True if they were on it. */
function leaveParty(p, lob) {
  const i = lob.ids.indexOf(p.id);
  if (i < 0) return false;
  lob.ids.splice(i, 1);
  // dropping below the minimum cancels the countdown; 4-of-6 walking back to
  // 3-of-6 does not, because three is still a perfectly good round
  if (lob.ids.length < lob.min && lob.timer) {
    clearTimeout(lob.timer);
    lob.timer = null;
    lob.starting = false;
  }
  broadcastParty(lob);
  return true;
}

function startParty(lob) {
  lob.timer = null;
  const members = lob.ids
    .map((id) => world.players.get(id))
    .filter((p) => p && p.room === lob.room && !p.ph && !p.dd && !p.race && !p.match);
  if (members.length < lob.min) {
    // everyone bailed; drop ids that no longer resolve so a stale entry can
    // never wedge the board at "full" and lock the game for good
    for (let i = lob.ids.length - 1; i >= 0; i--) {
      if (!members.includes(world.players.get(lob.ids[i]))) lob.ids.splice(i, 1);
    }
    lob.starting = false;
    broadcastParty(lob);
    return;
  }
  lob.ids.length = 0;
  lob.starting = false;
  lob.start(members.slice(0, lob.max));
  broadcastParty(lob); // the board is empty again for everyone still in the room
}

// ---------- Prop Hunt ----------
// The server owns the roster, the seed and the seeker; everything else (props,
// possession, clicks) is client simulation relayed blind through 'ph-state',
// exactly like the den's match-move. Scores are client-reported, so they buy
// nothing here beyond the standings: coins come from the mgstart/score road,
// which the per-run cap already bounds. That is also why there is no podium
// bonus on this side (the doodle has one): the server refereed none of it.

function startPropHunt(members) {
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const roster = members.map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat }));
  // the seed picks the first seeker too, so a client replaying the round from
  // the seed alone lands on the same capy the server named
  const seekerId = roster[seed % roster.length].id;
  const round = { seed, seekerId, ended: false, players: new Map(), timer: null };
  for (const p of members) {
    p.ph = round;
    round.players.set(p.id, { id: p.id, name: p.name, score: 0, done: false });
  }
  for (const p of members) sendTo(p, { t: 'ph-start', seed, players: roster, seekerId });
  round.timer = setTimeout(() => {
    try { endPropHunt(round); } catch (e) { console.error('[ph] end failed:', e?.message || e); }
  }, PH_MAX_MS);
}

/**
 * Blind relay to the rest of the round: nothing in `data` is read here.
 * The payload rides in `m` (the field prophunt.js reads) and the sender id is
 * stamped as both `id` and `from`; an anonymous relay would silently break
 * every catch and every clock sync, so it is never sent without one.
 */
function relayPropHunt(round, fromId, data) {
  const raw = JSON.stringify({ t: 'ph-state', from: fromId, id: fromId, m: data });
  for (const id of round.players.keys()) {
    if (id === fromId) continue;
    const other = world.players.get(id);
    if (other && other.ph === round && other.ws?.readyState === 1) other.ws.send(raw);
  }
}

function endPropHunt(round) {
  if (round.ended) return;
  round.ended = true;
  clearTimeout(round.timer);
  const scores = [...round.players.values()]
    .map(({ id, name, score }) => ({ id, name, score }))
    .sort((a, b) => b.score - a.score);
  for (const id of round.players.keys()) {
    const p = world.players.get(id);
    if (p && p.ph === round) { p.ph = null; sendTo(p, { t: 'ph-end', scores }); }
  }
}

/** Leave the board and/or a round in progress (leaving the mine, or the world). */
function exitPropHunt(p) {
  leaveParty(p, partyLobbies.prophunt);
  const round = p.ph;
  if (!round) return;
  p.ph = null;
  const r = round.players.get(p.id);
  if (r && !r.done) r.done = true; // whatever they last reported stands (0 if nothing)
  // the leave note: the others must be able to un-possess an abandoned prop
  relayPropHunt(round, p.id, { left: true });
  if (!round.ended && [...round.players.values()].every((x) => x.done)) endPropHunt(round);
}

// ---------- Capy Doodles ----------
// The one game the server actually referees: it owns the word list, hands the
// three choices to the drawer alone, masks the answer for everyone else, and
// scores guesses itself. Guessers' clients never receive the word before they
// earn it, so there is nothing to read out of the DOM.

// ~130 all-ages nouns, all of them things a capy could point at in the cove.
const DOODLE_WORDS = [
  'smoothie', 'chairlift', 'top hat', 'shark', 'pickaxe', 'minecart',
  'lantern', 'crystal', 'mushroom', 'barrel', 'crate', 'sled',
  'snowman', 'fountain', 'palm tree', 'seashell', 'crab', 'surfboard',
  'beach ball', 'sandcastle', 'fishing rod', 'jellyfish', 'starfish', 'dolphin',
  'iceberg', 'snowball', 'mitten', 'scarf', 'cocoa', 'marshmallow',
  'blender', 'banana', 'mango', 'strawberry', 'pineapple', 'waffle',
  'pancake', 'cupcake', 'cookie', 'donut', 'ice cream', 'popcorn',
  'teapot', 'mug', 'apron', 'chef hat', 'disco ball', 'speaker',
  'headphones', 'drum', 'guitar', 'piano', 'trumpet', 'microphone',
  'neon sign', 'campfire', 'tent', 'lamp post', 'bridge', 'ladder',
  'bucket', 'shovel', 'wheelbarrow', 'rope', 'anchor', 'sailboat',
  'canoe', 'paddle', 'lighthouse', 'treasure chest', 'compass', 'telescope',
  'balloon', 'kite', 'umbrella', 'sunglasses', 'backpack', 'wagon',
  'bicycle', 'skateboard', 'rocket', 'robot', 'teddy bear', 'beanbag',
  'sofa', 'bookshelf', 'aquarium', 'fireplace', 'pillow', 'blanket',
  'alarm clock', 'mailbox', 'postcard', 'present', 'ribbon', 'birthday cake',
  'candle', 'party hat', 'confetti', 'trophy', 'medal', 'crown',
  'viking helm', 'pirate hat', 'propeller cap', 'flower pot', 'cactus', 'sunflower',
  'acorn', 'pinecone', 'vine', 'waterfall', 'rainbow', 'snowflake',
  'moon', 'star', 'butterfly', 'toucan', 'frog', 'turtle',
  'snail', 'duckling', 'otter', 'bumblebee', 'firefly', 'owl',
  'parrot', 'monkey', 'hammock', 'torch', 'statue', 'gemstone',
];

/** Case, spacing and punctuation all forgiven: "Top  Hat!" matches "top hat". */
const normalizeWord = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Edit distance, abandoned once it passes `max`: near-misses only, cheaply. */
function editDistance(a, b, max = 1) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length > 64 || b.length > 64) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1; // no later row can come back under it
    prev = row;
  }
  return prev[b.length];
}

/** Three fresh choices; a word already drawn this game never comes back. */
function pickWords(used) {
  const out = [];
  for (let guard = 0; out.length < 3 && guard < 400; guard++) {
    const w = DOODLE_WORDS[Math.floor(Math.random() * DOODLE_WORDS.length)];
    if (!out.includes(w) && !used.has(w)) out.push(w);
  }
  // 130 words against 5 rounds means this never runs, but a repeat still beats
  // a round that never starts
  for (let i = 0; out.length < 3 && i < DOODLE_WORDS.length; i++) {
    if (!out.includes(DOODLE_WORDS[i])) out.push(DOODLE_WORDS[i]);
  }
  return out;
}

const maskOf = (word) => word.replace(/[a-z0-9]/gi, '_');

const doodleStandings = (g) => [...g.players.values()]
  .map(({ id, name, score }) => ({ id, name, score }))
  .sort((a, b) => b.score - a.score);

/** Everyone still connected, still in this game. */
function doodleMembers(g) {
  const out = [];
  for (const id of g.players.keys()) {
    const p = world.players.get(id);
    if (p && p.dd === g) out.push(p);
  }
  return out;
}

function broadcastDoodle(g, msg) {
  const raw = JSON.stringify(msg);
  for (const p of doodleMembers(g)) if (p.ws?.readyState === 1) p.ws.send(raw);
}

function sendDoodleState(g, extra = {}) {
  const base = {
    t: 'dd-state', phase: g.phase, round: g.round, rounds: g.rounds,
    drawerId: g.drawerId, mask: g.mask, len: g.word ? g.word.length : 0,
    ms: Math.max(0, g.phaseEndsAt - Date.now()),
    scores: doodleStandings(g), guessed: [...g.guessed],
    ...extra,
  };
  for (const p of doodleMembers(g)) {
    // the word IS the game: nobody but the drawer sees it before the reveal
    const mine = (g.word && (p.id === g.drawerId || g.phase === 'reveal'))
      ? { ...base, word: g.word }
      : base;
    sendTo(p, mine);
  }
}

function clearDoodleTimers(g) {
  clearTimeout(g.timer);
  for (const h of g.reveals) clearTimeout(h);
  g.timer = null;
  g.reveals = [];
}

function addDoodleScore(g, id, points) {
  const row = g.players.get(id);
  if (row) row.score += points;
}

function startDoodle(members) {
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const g = {
    seed, ended: false, phase: 'pick', phaseEndsAt: 0,
    order: members.map((p) => p.id), turn: 0,
    players: new Map(), // id -> { id, name, score }; a capy who walks out is dropped
    rounds: Math.min(members.length, DD_MAX_ROUNDS),
    round: 0, drawerId: null, word: null, norm: '', mask: null, choices: [],
    used: new Set(), guessed: new Set(), skips: new Set(), correct: 0, drawStartedAt: 0,
    timer: null, reveals: [],
  };
  for (const p of members) {
    p.dd = g;
    g.players.set(p.id, { id: p.id, name: p.name, score: 0 });
  }
  const roster = members.map((p) => ({ id: p.id, name: p.name, color: p.color, hat: p.hat }));
  for (const p of members) sendTo(p, { t: 'dd-start', seed, players: roster, rounds: g.rounds });
  // 'dd-start' sends the jungle off to lazy-load the doodle chunk; round one's
  // 'dd-words' and 'dd-state' would land before it mounts and be lost, leaving
  // the drawer staring at an easel with no word choices. Give it a beat first.
  g.timer = setTimeout(() => {
    try { nextDoodleRound(g); } catch (e) { console.error('[dd] first round failed:', e?.message || e); }
  }, DD_MOUNT_MS);
}

/** Next capy in sign-up order who is still here, or null if nobody is. */
function nextDrawer(g) {
  for (let n = 0; n < g.order.length; n++) {
    const id = g.order[(g.turn + n) % g.order.length];
    const p = world.players.get(id);
    if (p && p.dd === g) { g.turn = (g.turn + n + 1) % g.order.length; return id; }
  }
  return null;
}

function nextDoodleRound(g) {
  clearDoodleTimers(g);
  if (g.ended) return;
  if (g.round >= g.rounds || doodleMembers(g).length < partyLobbies.doodle.min) { endDoodle(g); return; }
  const drawerId = nextDrawer(g);
  if (!drawerId) { endDoodle(g); return; }
  g.round++;
  g.drawerId = drawerId;
  g.phase = 'pick';
  g.word = null;
  g.norm = '';
  g.mask = null;
  g.guessed.clear();
  g.skips.clear(); // every round starts unvoted
  g.correct = 0;
  g.choices = pickWords(g.used);
  g.phaseEndsAt = Date.now() + DD_PICK_MS;
  const drawer = world.players.get(drawerId);
  if (drawer) sendTo(drawer, { t: 'dd-words', words: [...g.choices], round: g.round });
  sendDoodleState(g);
  // a drawer who wanders off to make cocoa must not stall the whole jungle
  g.timer = setTimeout(() => {
    try { beginDoodleDrawing(g, 0); } catch (e) { console.error('[dd] auto-pick failed:', e?.message || e); }
  }, DD_PICK_MS);
}

function beginDoodleDrawing(g, choice) {
  clearDoodleTimers(g);
  if (g.ended || g.phase !== 'pick') return;
  const drawer = world.players.get(g.drawerId);
  if (!drawer || drawer.dd !== g) { revealDoodle(g, 'left'); return; }
  const i = Number.isInteger(choice) && choice >= 0 && choice < g.choices.length ? choice : 0;
  g.word = g.choices[i];
  g.norm = normalizeWord(g.word);
  g.mask = maskOf(g.word);
  g.used.add(g.word);
  g.phase = 'draw';
  g.drawStartedAt = Date.now();
  g.phaseEndsAt = g.drawStartedAt + DD_DRAW_MS;
  sendDoodleState(g);
  for (const ms of DD_REVEAL_MS) {
    g.reveals.push(setTimeout(() => {
      try { revealLetter(g); } catch (e) { console.error('[dd] reveal failed:', e?.message || e); }
    }, ms));
  }
  g.timer = setTimeout(() => {
    try { revealDoodle(g, 'time'); } catch (e) { console.error('[dd] round end failed:', e?.message || e); }
  }, DD_DRAW_MS);
}

/** Drop one letter out of the mask, never past half the word. */
function revealLetter(g) {
  if (g.ended || g.phase !== 'draw' || !g.word) return;
  const hidden = [];
  for (let i = 0; i < g.mask.length; i++) if (g.mask[i] === '_') hidden.push(i);
  const letters = g.word.replace(/[^a-z0-9]/gi, '').length;
  if (hidden.length <= Math.ceil(letters / 2)) return;
  const i = hidden[Math.floor(Math.random() * hidden.length)];
  g.mask = g.mask.slice(0, i) + g.word[i] + g.mask.slice(i + 1);
  broadcastDoodle(g, { t: 'dd-mask', mask: g.mask, round: g.round });
}

/** First in gets the most, and every second of dithering costs a little. */
function guessPoints(order, fracLeft) {
  const base = DD_GUESS_POINTS[Math.min(order, DD_GUESS_POINTS.length - 1)];
  return Math.max(40, Math.round(base * (0.6 + 0.4 * Math.max(0, Math.min(1, fracLeft)))));
}

/** True once every capy who could guess has. */
function allGuessed(g) {
  const guessers = doodleMembers(g).filter((p) => p.id !== g.drawerId);
  return guessers.length > 0 && guessers.every((p) => g.guessed.has(p.id));
}

function scoreDoodleGuess(g, p) {
  const fracLeft = 1 - (Date.now() - g.drawStartedAt) / DD_DRAW_MS;
  const points = guessPoints(g.correct, fracLeft);
  g.correct++;
  g.guessed.add(p.id);
  addDoodleScore(g, p.id, points);
  addDoodleScore(g, g.drawerId, DD_DRAWER_POINTS);
  const base = {
    t: 'dd-correct', id: p.id, name: p.name, points,
    drawerId: g.drawerId, drawerPoints: DD_DRAWER_POINTS,
    scores: doodleStandings(g),
  };
  for (const other of doodleMembers(g)) {
    // the answer is the reward: only the capy who earned it gets it early
    sendTo(other, other.id === p.id ? { ...base, word: g.word, you: true } : base);
  }
  // the server refereed this one itself, so it is worth something to the board
  signal('doodle-correct', p, { points, order: g.correct - 1, round: g.round });
  if (allGuessed(g)) revealDoodle(g, 'solved');
}

function revealDoodle(g, reason) {
  clearDoodleTimers(g);
  if (g.ended) return;
  g.phase = 'reveal';
  g.phaseEndsAt = Date.now() + DD_GAP_MS;
  sendDoodleState(g, { reason });
  g.timer = setTimeout(() => {
    try { nextDoodleRound(g); } catch (e) { console.error('[dd] next round failed:', e?.message || e); }
  }, DD_GAP_MS);
}

function endDoodle(g) {
  if (g.ended) return;
  g.ended = true;
  clearDoodleTimers(g);
  const scores = doodleStandings(g);
  const podium = scores.slice(0, 3);
  const members = doodleMembers(g);
  for (const p of members) { p.dd = null; sendTo(p, { t: 'dd-end', podium, scores }); }
  // Unlike the client-reported minigame score, this podium is the server's own
  // bookkeeping: it validated every guess that made it. A game that emptied out
  // pays nobody, so nobody can farm it by having their second capy walk away.
  // (Two accounts playing it out honestly still earns 30 between them; the
  // hourly backstop bounds that, same as the den's match bonus.)
  if (members.length < partyLobbies.doodle.min) return;
  podium.forEach((row, i) => {
    if (row.score <= 0) return;
    const winner = members.find((p) => p.id === row.id);
    if (winner) grantCoins(winner, DD_PODIUM_COINS[i], 'doodle podium');
  });
}

/** Leave the board and/or a game in progress (leaving the jungle, or the world). */
function exitDoodle(p) {
  leaveParty(p, partyLobbies.doodle);
  const g = p.dd;
  if (!g) return;
  p.dd = null;
  g.players.delete(p.id); // dropped from the round: their points go with them
  g.guessed.delete(p.id);
  if (g.ended) return;
  if (doodleMembers(g).length < partyLobbies.doodle.min) { endDoodle(g); return; }
  // nobody can guess a doodle nobody is drawing: cut the round short and rotate
  if (p.id === g.drawerId) { revealDoodle(g, 'left'); return; }
  sendDoodleState(g); // the scoreboard loses a row for everyone else
  if (g.phase === 'draw' && allGuessed(g)) revealDoodle(g, 'solved');
}

// ===========================================================================
// The Social Cove (wave 7, docs/LIVING-COVE.md). Everything below is server
// authority for things several capys share: the sky, a ball, a bonfire, a
// party, a wall of pixels and one bottle a day.
// ===========================================================================

// ---------- A. the world clock, weather and aurora ----------
// One cove day is 40 real minutes of continuous phase `dayT` in [0,1): 0.0
// dawn, 0.25 noon, 0.5 dusk, 0.75 midnight. Derived from the wall clock rather
// than counted up, so a server restart does not teleport the island to dawn and
// two processes would agree. Clients interpolate between frames and never read
// their own Date for game time.
//
// The frame: { t:'clock', dayT, day, weather, snow, aurora, dayMs }
//   weather 'clear' | 'breeze' | 'rain' : the island's sky, as a plain word.
//           A WORD, not an envelope: engine.applyClock hands this straight to
//           room.onClock(dayT, weather, aurora), and all three outdoor rooms
//           read it as a string (the plaza compares it directly; the peak maps
//           the word onto snowfall through its own vocabulary). An object here
//           would silently read as 'clear' in the plaza forever.
//   snow    0..2 : the peak's own snowfall walk, for any reader that wants a
//           number independent of the sky word (the room derives one already)
//   day     integer cove-day index : what "daily" means here (quests, bottle)
//   dayMs   one cove day in ms : lets a client tween between frames
const clock = {
  day: -1, dayT: 0, aurora: false,
  weather: { sky: 'clear', snow: 0 },
  weatherAt: 0, auroraDay: -1, auroraFromT: -1, auroraToT: -1,
};

/** Wall clock, phase-shifted (the shift is a test hook; production leaves it 0). */
const coveNow = () => Date.now() + CLOCK_OFFSET_MS;

// Gentle Markov walk: most rolls keep the weather it already had, and rain
// never arrives out of a clear sky without a breeze in between.
const SKY_WALK = {
  clear: [['clear', 0.60], ['breeze', 0.40], ['rain', 0]],
  breeze: [['breeze', 0.45], ['clear', 0.35], ['rain', 0.20]],
  rain: [['rain', 0.40], ['breeze', 0.45], ['clear', 0.15]],
};

function walkWeighted(rows, fallback) {
  let roll = Math.random();
  for (const [value, weight] of rows) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return fallback;
}

/** Snowfall drifts one step at a time; it never jumps from still to blizzard. */
function walkSnow(cur) {
  const rows = cur === 0 ? [[0, 0.55], [1, 0.45]]
    : cur === 1 ? [[1, 0.45], [0, 0.3], [2, 0.25]]
      : [[2, 0.5], [1, 0.5]];
  return walkWeighted(rows, cur);
}

/** Recompute the whole sky. Called every CLOCK_MS and before any clock frame. */
function updateClock() {
  const now = coveNow();
  clock.day = Math.floor(now / COVE_DAY_MS);
  clock.dayT = (now % COVE_DAY_MS) / COVE_DAY_MS;

  if (now >= clock.weatherAt) {
    clock.weatherAt = now + WEATHER_MIN_MS + Math.random() * (WEATHER_MAX_MS - WEATHER_MIN_MS);
    clock.weather = {
      sky: walkWeighted(SKY_WALK[clock.weather.sky] || SKY_WALK.clear, clock.weather.sky),
      snow: walkSnow(clock.weather.snow),
    };
  }

  // The aurora is rolled ONCE per cove day, at the day boundary, so everyone
  // who looks up during that night sees the same sky: a per-frame roll would
  // flicker and a per-join roll would disagree between clients.
  if (clock.auroraDay !== clock.day) {
    clock.auroraDay = clock.day;
    clock.auroraFromT = clock.auroraToT = -1;
    if (Math.random() < AURORA_CHANCE) {
      const durT = (AURORA_MIN_MS + Math.random() * (AURORA_MAX_MS - AURORA_MIN_MS)) / COVE_DAY_MS;
      const room = Math.max(0, (AURORA_TO_T - AURORA_FROM_T) - durT);
      clock.auroraFromT = AURORA_FROM_T + Math.random() * room;
      clock.auroraToT = clock.auroraFromT + durT;
    }
  }
  clock.aurora = clock.dayT >= clock.auroraFromT && clock.dayT < clock.auroraToT;
  return clock;
}

function clockFrame() {
  // recomputed on the way out: a join frame ten seconds after the last tick
  // would otherwise hand that client a stale sky to interpolate away from
  updateClock();
  return {
    t: 'clock',
    dayT: +clock.dayT.toFixed(5),
    day: clock.day,
    weather: clock.weather.sky,
    snow: clock.weather.snow,
    aurora: clock.aurora,
    dayMs: COVE_DAY_MS,
  };
}

/**
 * Dusk to dawn: when the lamps are on and the bonfire is burning. The window
 * mirrors the rooms' own lamp test (beach.js lights everything while the sun
 * sits below `elev < 0.1`, which is this phase range), so the fire is never
 * visibly lit while the server quietly refuses to pay for sitting at it.
 */
const isCoveNight = () => clock.dayT >= 0.484 || clock.dayT < 0.016;

// ---------- A2. snowballs (Frosty Peak) ----------
// Pure relay: the server owns nothing but the rate limit. Everyone simulates
// the same arc from the same two points, and a hit is a puff and a wobble, so
// there is no state worth defending here.

function throwSnowball(p, m, now) {
  if (p.room !== SNOW_ROOM) return; // snow is where the snow is
  if (now - (p.snowAt || 0) < SNOW_THROW_MS) return; // 1/s, per spec A2
  const to = readPoint(m.to);
  if (!to) return;
  p.snowAt = now;
  // `from` is optional: a client that does not send it gets its own capy's last
  // known position, which is where the throw came from anyway
  const from = readPoint(m.from) || { x: +p.x.toFixed(2), y: +(p.y || 0).toFixed(2), z: +p.z.toFixed(2) };
  broadcastToRoom(p.room, { t: 'snow', id: p.id, from, to }, p.id);
  // The quest board's "land N snowballs" counts THROWS: the arc is simulated on
  // every client and the hit is decided there, so a landed snowball is not a
  // thing the server ever sees. Counting the rate-limited throw is the only
  // measure here that cannot be claimed by a client.
  signal('snow', p, { room: p.room });
}

/**
 * A client-supplied point, clamped to the world box, or null if it was junk.
 * Both dialects are read: `{x,y,z}` and the peak's compact `[x,z]` / `[x,y,z]`
 * (src/world/rooms/peak.js sends the array, and reads either on the way back).
 */
function readPoint(v, span = 100) {
  if (Array.isArray(v)) {
    if (v.length < 2) return null;
    const [ax, ay, az] = v.length > 2 ? v : [v[0], 0, v[1]];
    return readPoint({ x: ax, y: ay, z: az }, span);
  }
  if (!v || typeof v !== 'object') return null;
  const x = Number(v.x), y = Number(v.y), z = Number(v.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return {
    x: +Math.max(-span, Math.min(span, x)).toFixed(2),
    y: +Math.max(-40, Math.min(40, Number.isFinite(y) ? y : 0)).toFixed(2),
    z: +Math.max(-span, Math.min(span, z)).toFixed(2),
  };
}

// ---------- A2. the beach ball ----------
// ONE ball, owned by the server, integrated at 10Hz so every client agrees
// about where it is without anyone being the authority. Clients send bops
// (clamped impulses, and only from arm's length), the server sends state.
// The ball sleeps when it stops: an idle beach costs no bandwidth at all.
//
// The sea is modelled as one soft radius rather than the beach's real
// shoreline function: past BALL_SHORE the water drags the ball and walks it
// back toward the middle, which is the spec's "splashes, floats back" without
// the server having to carry a copy of the room's coastline (the two would
// drift apart the first time the beach is re-dressed). The splash itself, the
// foam and the bobbing are the room's, played off the state it receives.

const ball = {
  x: BALL_HOME.x, y: BALL_R, z: BALL_HOME.z,
  vx: 0, vy: 0, vz: 0, sleeping: true, settled: true, by: null,
};

function ballFrame() {
  return {
    t: 'ball', room: BALL_ROOM,
    x: +ball.x.toFixed(2), y: +ball.y.toFixed(2), z: +ball.z.toFixed(2),
    vx: +ball.vx.toFixed(2), vy: +ball.vy.toFixed(2), vz: +ball.vz.toFixed(2),
    by: ball.by, r: BALL_R,
  };
}

const sendBall = (p) => sendTo(p, ballFrame());

/** Somebody bopped it: clamp the ask, wake the ball, tell the beach at once. */
function bopBall(p, m, now) {
  if (p.room !== BALL_ROOM) return;
  if (now - (p.ballAt || 0) < BALL_BOP_MS) return;
  const imp = m.impulse;
  if (!imp || typeof imp !== 'object' || Array.isArray(imp)) return;
  let ix = Number(imp.x) || 0, iy = Number(imp.y) || 0, iz = Number(imp.z) || 0;
  if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz)) return;
  // you have to be next to the ball to hit it: a client cannot reach across the
  // cove and volley it into the sea from the dock
  if (Math.hypot(p.x - ball.x, p.z - ball.z) > BALL_REACH + BALL_R) return;
  const mag = Math.hypot(ix, iy, iz);
  if (mag < 0.01) return;
  if (mag > BALL_IMPULSE_MAX) {
    const k = BALL_IMPULSE_MAX / mag;
    ix *= k; iy *= k; iz *= k;
  }
  p.ballAt = now;
  ball.vx += ix;
  ball.vy += Math.max(0, iy); // a bop always sends it up, never through the sand
  ball.vz += iz;
  ball.sleeping = false;
  ball.by = p.id;
  broadcastToRoom(BALL_ROOM, ballFrame()); // instant, so the bop feels like yours
  signal('ball', p, {});
}

/** One 10Hz step of the shared physics. Returns true while it is still moving. */
function stepBall(dt) {
  if (ball.sleeping) return false;
  const dx = ball.x - BALL_COVE.x, dz = ball.z - BALL_COVE.z;
  const r = Math.hypot(dx, dz);
  const inSurf = r > BALL_SHORE;

  ball.vy += BALL_GRAVITY * dt;
  const grounded = ball.y <= BALL_R + 0.01;
  const perSec = inSurf ? BALL_WATER_DRAG : grounded ? BALL_GROUND_DRAG : BALL_AIR_DRAG;
  const drag = Math.max(0, 1 - perSec * dt);
  ball.vx *= drag;
  ball.vz *= drag;
  if (inSurf) {
    // the swell walks it back to where the people are: gentle at the waterline,
    // firmer the further out some show-off belted it
    const push = 1.6 + Math.min(6, r - BALL_SHORE) * 0.4;
    ball.vx -= (dx / (r || 1)) * push * dt;
    ball.vz -= (dz / (r || 1)) * push * dt;
  }
  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  if (speed > BALL_MAX_SPEED) {
    const k = BALL_MAX_SPEED / speed;
    ball.vx *= k; ball.vy *= k; ball.vz *= k;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  if (ball.y < BALL_R) {
    ball.y = BALL_R;
    if (inSurf) {
      ball.vy = Math.max(ball.vy * 0.2, -0.4); // buoyancy, not a bounce
    } else {
      ball.vy = Math.abs(ball.vy) * BALL_BOUNCE;
      if (ball.vy < 1.1) ball.vy = 0; // done bouncing: it is rolling now
    }
  }

  // last resort: a ball somehow out past the horizon comes home rather than
  // becoming a rumour
  if (r > BALL_LOST) {
    ball.x = BALL_HOME.x; ball.z = BALL_HOME.z; ball.y = BALL_R;
    ball.vx = ball.vy = ball.vz = 0;
    ball.sleeping = true;
    return false;
  }

  // it only ever falls asleep on the sand: a ball bobbing home through the surf
  // is still moving, however slowly
  if (!inSurf && grounded && Math.hypot(ball.vx, ball.vz) < 0.12 && Math.abs(ball.vy) < 0.2) {
    ball.vx = ball.vy = ball.vz = 0;
    ball.sleeping = true;
    return false;
  }
  return true;
}

/** The 10Hz tick. Silent while the ball rests or the beach is empty. */
function ballTick() {
  const watchers = world.rooms.get(BALL_ROOM);
  if (!watchers || watchers.size === 0) {
    // nobody is there to see it: park the ball rather than simulate to an
    // empty room, and it is where they left it when they come back
    if (!ball.sleeping) {
      ball.sleeping = true;
      ball.vx = ball.vy = ball.vz = 0;
      ball.y = BALL_R;
      // a ball abandoned mid-splash would be parked out at sea forever
      if (Math.hypot(ball.x - BALL_COVE.x, ball.z - BALL_COVE.z) > BALL_SHORE) {
        ball.x = BALL_HOME.x;
        ball.z = BALL_HOME.z;
      }
    }
    return;
  }
  const moving = stepBall(BALL_TICK_MS / 1000);
  // one last frame on the way to sleep, so clients land it where the server did
  if (moving || !ball.settled) broadcastToRoom(BALL_ROOM, ballFrame());
  ball.settled = !moving;
}

// ---------- A2. the bonfire (Driftwood Beach, dusk to dawn) ----------
// Sitting in the firelight pays a coin a minute, capped per night. Validated
// entirely from the position and pose the player is already broadcasting, so
// there is no "I am at the fire" message to lie in. Accrual only counts time
// the server actually observed: a tab that reconnects starts its minute again.

function bonfireTick(dtMs) {
  if (!isCoveNight()) return;
  for (const id of world.rooms.get(BONFIRE.room) || []) {
    const p = world.players.get(id);
    if (!p || p.bot) continue;
    const near = Math.hypot(p.x - BONFIRE.x, p.z - BONFIRE.z) <= BONFIRE.r;
    // sitting, or simply standing still by the fire (the spec's "idle 5s": the
    // 10s clock tick is the dwell test, since a walker is never idle across one)
    if (!near || (p.anim !== 'sit' && p.anim !== 'idle')) { p.bonfireMs = 0; continue; }
    // wave 12: the bonfire cap follows the REAL day, like the quest board
    const day = progress.dayKey();
    if (p.bonfireDay !== day) { p.bonfireDay = day; p.bonfireCoins = 0; }
    if (p.bonfireCoins >= BONFIRE_CAP) continue;
    p.bonfireMs = (p.bonfireMs || 0) + dtMs;
    while (p.bonfireMs >= BONFIRE_MINUTE_MS && p.bonfireCoins < BONFIRE_CAP) {
      p.bonfireMs -= BONFIRE_MINUTE_MS;
      p.bonfireCoins++;
      grantCoins(p, BONFIRE_COIN, 'bonfire');
      // one signal per minute observed at the fire, which is what the album's
      // "ten minutes at the bonfire" stamp counts
      signal('bonfire', p, { minutes: p.bonfireCoins });
    }
  }
}

// ---------- A3. parties ----------
// A party is a 30-minute flag on a room: an island-wide toast, a beacon on the
// map, and a doubled dose of juice for whoever shows up. It mints no coins at
// all (the host's reward is the head count), so there is nothing to farm here.

const parties = new Map(); // partyId -> party
let nextPartyId = 1;

/** Who this connection is, for one-party-per-player: an account, or a guest. */
const partyKey = (p) => (p.username ? p.username.toLowerCase() : p.id);

function partyRoomName(roomId) {
  if (isHouseRoom(roomId)) {
    const owner = users.get(houseOwnerKey(roomId) || '');
    return owner ? houseName(owner) : 'a den';
  }
  return has(ROOM_INFO, roomId) ? ROOM_INFO[roomId].name : roomId;
}

/**
 * The beacon payload. `endsIn` (seconds) is what the HUD reads to size the
 * countdown, so a capy who arrives twenty minutes in gets ten minutes of
 * beacon, not another thirty; `endsAt`/`startedAt` ride along for anything that
 * would rather have absolute times.
 */
function partyPublic(party) {
  return {
    id: party.id, host: party.hostName, hostId: party.hostId,
    room: party.room, roomName: party.roomName, venue: party.venue,
    startedAt: party.startedAt, endsAt: party.endsAt,
    endsIn: Math.max(0, Math.round((party.endsAt - Date.now()) / 1000)),
    count: party.guests.size,
  };
}

/**
 * The party state frame. The HUD reads ONE party (it draws one beacon and one
 * map pill), so the flat fields describe the newest one and `parties` carries
 * the full list for anything that wants it. With nothing running the frame says
 * so out loud rather than going silent, so a stale beacon always clears.
 */
function partiesFrame() {
  const all = [...parties.values()];
  const newest = all[all.length - 1];
  const list = all.map(partyPublic);
  return newest
    ? { t: 'party', active: true, ...partyPublic(newest), parties: list }
    : { t: 'party', active: false, parties: [] };
}

/** The parties running in a room right now (usually none, at most one). */
function partiesInRoom(roomId) {
  const out = [];
  for (const party of parties.values()) if (party.room === roomId) out.push(party);
  return out;
}

/**
 * Count a capy as having been at the party. One head per account however many
 * tabs it has open, and the host is never their own guest.
 */
function markPartyAttendance(p) {
  if (p.bot) return;
  const key = partyKey(p);
  for (const party of partiesInRoom(p.room)) {
    if (key === party.hostKey || party.guests.has(key)) continue;
    party.guests.add(key);
    signal('party-attend', p, { id: party.id, room: party.room, host: party.hostName });
  }
}

/**
 * Every refusal answers on the same frame the request came in on, carrying the
 * line to show and the seconds left. The HUD toasts `msg` itself, so nothing
 * here sends a separate toast: it would arrive twice.
 */
function refusePartyEvent(p, msg, retryIn = 0) {
  sendTo(p, { t: 'party-start', ok: false, msg, retryIn: Math.max(0, Math.round(retryIn)) });
}

function startPartyEvent(p, m) {
  const rec = p.registered ? recordFor(p) : null;
  if (!rec) { refusePartyEvent(p, 'Parties come with a (free) account: sign up and the island is yours.'); return; }
  const key = p.username.toLowerCase();
  for (const party of parties.values()) {
    if (party.hostKey === key) {
      refusePartyEvent(p, 'Your party is already going: go and be a host!', (party.endsAt - Date.now()) / 1000);
      return;
    }
  }
  const now = Date.now();
  const last = Number(rec.partyAt) || 0;
  if (now - last < PARTY_COOLDOWN_MS) {
    const left = PARTY_COOLDOWN_MS - (now - last);
    refusePartyEvent(p, `You threw one recently: ready again in about ${Math.ceil(left / 60_000)} min.`, left / 1000);
    return;
  }
  const venue = PARTY_VENUES.includes(m.venue) ? (m.venue === 'house' ? 'den' : m.venue) : 'club';
  const room = venue === 'den' ? houseRoomId(key) : CLUB_ROOM;
  let prevAccess = null;
  if (venue === 'den') {
    // A den party is a door left open for half an hour: the client asks first
    // (menu.js's confirmVenue) and sends the answer, and the server refuses to
    // assume it. 'force' is the menu's word for that yes; 'confirm' is the
    // spec's, and both are accepted.
    if (m.force !== true && m.confirm !== true) {
      refusePartyEvent(p, 'A den party opens your door to everyone: confirm to start.');
      return;
    }
    const house = ensureHouse(rec);
    prevAccess = house.access;
    house.access = 'open';
    saveSoon();
    broadcastHouse(key);
  }
  const party = {
    id: `party-${nextPartyId++}`,
    hostKey: key, hostName: p.name, hostId: p.id,
    venue, room, roomName: partyRoomName(room),
    startedAt: now, endsAt: now + PARTY_MS,
    guests: new Set(), awayAt: null, prevAccess,
  };
  parties.set(party.id, party);
  rec.partyAt = now;
  saveSoon();

  // The island-wide toast is the HUD's (it has a warmer line for the host than
  // for everyone else, and it owns the beacon and the map pill): this frame
  // carries everything it needs and no toast of its own, or it would say the
  // same thing twice.
  broadcastAll({
    t: 'party-start',
    ...partyPublic(party),
    msg: `${p.name} is throwing a party at ${party.roomName}!`,
    cooldown: Math.round(PARTY_COOLDOWN_MS / 1000),
  });
  // everyone already standing in the venue is at the party
  for (const id of world.rooms.get(room) || []) {
    const guest = world.players.get(id);
    if (guest) markPartyAttendance(guest);
  }
}

function endPartyEvent(party, reason) {
  if (!parties.has(party.id)) return;
  parties.delete(party.id);
  const count = party.guests.size;
  // The den goes back to whatever door it had, unless the owner changed it
  // themselves while the party ran (their choice wins over ours). Keyed off
  // prevAccess, which only a den party ever sets: the venue word is the
  // client's, and this must not depend on which spelling of it arrived.
  if (party.prevAccess) {
    const owner = users.get(party.hostKey);
    if (owner) {
      const house = ensureHouse(owner);
      if (house.access === 'open') {
        house.access = party.prevAccess;
        saveSoon();
        broadcastHouse(party.hostKey);
      }
    }
  }
  // the head count rides the frame; the HUD writes the host's bragging-rights
  // toast off it (and a quieter line for everyone else)
  broadcastAll({
    t: 'party-end', id: party.id, host: party.hostName, hostId: party.hostId,
    room: party.room, roomName: party.roomName, count, reason,
  });
  const hostSessions = sessionsFor(party.hostKey);
  if (hostSessions[0]) signal('party-host', hostSessions[0], { count, venue: party.venue });
}

/** The host wandering off ends it early; so does the half hour running out. */
function partyTick(now) {
  for (const party of [...parties.values()]) {
    if (now >= party.endsAt) { endPartyEvent(party, 'time'); continue; }
    const hostHere = sessionsFor(party.hostKey).some((s) => s.room === party.room);
    if (hostHere) { party.awayAt = null; continue; }
    if (!party.awayAt) party.awayAt = now;
    else if (now - party.awayAt >= PARTY_ABSENCE_MS) endPartyEvent(party, 'host-away');
  }
}

// ---------- A4. the plaza mural ----------
// A 96x54 grid of palette indices, one pixel per player per 20 seconds. The
// server owns the grid, persists it debounced, and hands newcomers the whole
// thing RLE-compressed (about 2KB while it is mostly cream). Palette-locked by
// construction: an op carries an index, never a colour, so there is no way to
// draw anything the cove's own palette cannot say.

const MURAL_FILE = path.join(ROOT, 'data', 'mural.json');
const MURAL_REPORT_DIR = path.join(ROOT, 'data', 'mural-reports');
const mural = {
  grid: new Uint8Array(MURAL_W * MURAL_H),
  ops: [], // rolling log, capped: what a report snapshot carries as context
  painters: new Map(), // account key -> last paint ms (pruned in the clock tick)
  reports: new Map(), // account key -> last report ms
  saveTimer: null,
  dirty: false,
};

/** Row-major runs as `count:index`, joined by commas. Decoded by the overlay. */
function muralRLE() {
  const g = mural.grid;
  let out = '';
  let run = 0;
  let cur = g[0];
  for (let i = 0; i < g.length; i++) {
    if (g[i] === cur) { run++; continue; }
    out += `${out ? ',' : ''}${run}:${cur}`;
    cur = g[i];
    run = 1;
  }
  return `${out}${out ? ',' : ''}${run}:${cur}`;
}

function muralFromRLE(rle) {
  const g = new Uint8Array(MURAL_W * MURAL_H);
  let at = 0;
  for (const token of String(rle || '').split(',')) {
    if (!token) continue;
    const [countRaw, idxRaw] = token.split(':');
    const count = Math.floor(Number(countRaw));
    const idx = Math.floor(Number(idxRaw));
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(idx) || idx < 0 || idx >= MURAL_COLORS) continue;
    const end = Math.min(g.length, at + count);
    if (idx) g.fill(idx, at, end);
    at = end;
    if (at >= g.length) break;
  }
  return g;
}

function loadMural() {
  try {
    if (!fs.existsSync(MURAL_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(MURAL_FILE, 'utf8'));
    if (saved && saved.w === MURAL_W && saved.h === MURAL_H && typeof saved.rle === 'string') {
      mural.grid = muralFromRLE(saved.rle);
    }
  } catch (e) {
    console.error('[mural] load failed:', e?.message || e);
  }
}
loadMural();

function saveMuralSoon() {
  mural.dirty = true;
  if (mural.saveTimer) return;
  mural.saveTimer = setTimeout(() => {
    mural.saveTimer = null;
    mural.dirty = false;
    try {
      fs.mkdirSync(path.dirname(MURAL_FILE), { recursive: true });
      fs.writeFileSync(MURAL_FILE, JSON.stringify({ w: MURAL_W, h: MURAL_H, saved: Date.now(), rle: muralRLE() }));
    } catch (e) {
      console.error('[mural] save failed:', e?.message || e);
    }
  }, MURAL_SAVE_MS);
}

const muralGridFrame = () => ({
  t: 'mural-grid', w: MURAL_W, h: MURAL_H, colors: MURAL_COLORS,
  cooldown: MURAL_COOLDOWN_MS, rle: muralRLE(),
});

const sendMuralGrid = (p) => sendTo(p, muralGridFrame());

/**
 * One pixel. Registered players only (the mural is the island's guest book and
 * a guest book wants signatures), one per 20s per account however many tabs
 * they have open, and the colour is an index into the cove palette or nothing.
 */
/**
 * A refusal rides the same frame the op did: {ok:false, wait} is what the
 * overlay reads to put its own cooldown back in step (src/ui/mural.js), and
 * the toast is for the case the overlay is not even open.
 */
function refuseMural(p, msg, waitMs = 0) {
  sendTo(p, { t: 'mural', ok: false, msg, wait: Math.ceil(waitMs / 1000) });
}

function paintMural(p, m, now) {
  if (!p.registered) {
    refuseMural(p, 'Sign up to paint on the mural!');
    sendTo(p, { t: 'toast', msg: 'Sign up to paint on the mural!' });
    return;
  }
  const x = Math.floor(Number(m.x));
  const y = Math.floor(Number(m.y));
  const c = Math.floor(Number(m.c));
  if (!Number.isFinite(x) || x < 0 || x >= MURAL_W) return;
  if (!Number.isFinite(y) || y < 0 || y >= MURAL_H) return;
  if (!Number.isFinite(c) || c < 0 || c >= MURAL_COLORS) return;
  const key = p.username.toLowerCase();
  const last = mural.painters.get(key) || 0;
  if (now - last < MURAL_COOLDOWN_MS) {
    refuseMural(p, 'That paint is still drying', MURAL_COOLDOWN_MS - (now - last));
    return;
  }
  mural.painters.set(key, now);
  mural.grid[y * MURAL_W + x] = c;
  mural.ops.push({ x, y, c, by: p.name, at: now });
  if (mural.ops.length > MURAL_OPS_CAP) mural.ops.splice(0, mural.ops.length - MURAL_OPS_CAP);
  saveMuralSoon();
  const op = { t: 'mural', x, y, c, by: p.name, id: p.id };
  // The wall and the overlay both live in the plaza, so that is where the op
  // goes; the painter gets their own copy directly, because an overlay left
  // open on the way out of the room still deserves to see its pixel land.
  broadcastToRoom(MURAL_ROOM, op, p.id);
  sendTo(p, op);
  signal('mural-pixel', p, { x, y, c });
}

/** The notice board's "report mural": a snapshot on disk for the operator. */
function reportMural(p, now) {
  const key = p.registered ? p.username.toLowerCase() : p.id;
  const last = mural.reports.get(key) || 0;
  if (now - last < MURAL_REPORT_MS) return;
  mural.reports.set(key, now);
  try {
    fs.mkdirSync(MURAL_REPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(MURAL_REPORT_DIR, `${stamp}-${String(p.name).replace(/[^\w-]/g, '')}.json`);
    fs.writeFileSync(file, JSON.stringify({
      at: Date.now(), by: p.name, w: MURAL_W, h: MURAL_H,
      rle: muralRLE(), recent: mural.ops.slice(-400),
    }, null, 1));
  } catch (e) {
    console.error('[mural] report failed:', e?.message || e);
  }
  sendTo(p, { t: 'toast', msg: 'Thanks: a caretaker will take a look' });
}

// ---------- C. the Drift's daily bottle ----------
// One message in a bottle a day, in the same spot for everybody (the position
// is derived from the cove-day index, so every client agrees without the server
// having to remember anything), 25 coins to whoever swims into it.
//
// DEVIATION from LIVING-COVE C ("first finder gets ... 25 coins"): every
// account may find the day's bottle once, rather than one lucky capy a day.
// A once-per-island prize is a race nobody but the first diver can enter, and
// the spec's own validation line ("once per day per account") reads that way
// too. A cove day is 40 minutes, so the ceiling is 37 coins an hour: less than
// a quarter of what standing in the mine pays, and the hourly backstop still
// bounds it.

const BOTTLE_NOTES = [
  'the tide always brings something back',
  'if you are reading this, say hi to Big Blue for me',
  'day 412: still no idea how the dive bell works',
  'the best smoothie is the one somebody else made you',
  'i buried a snack near the third palm. good luck',
  'sing to the whale. she sings back, eventually',
  'whoever keeps painting the mural pink: thank you',
  'the cove looks best from underneath',
  'lost my hat down here in 2019. it is yours now',
  'nothing to report. the water is lovely',
];

/** Deterministic little PRNG, so one integer picks the whole day's bottle. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bottleFor(day) {
  const rand = mulberry32(day * 2654435761);
  const th = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * BOTTLE_FIELD.r; // sqrt: spread evenly over the disc
  return {
    day,
    x: +(Math.cos(th) * r).toFixed(2),
    y: +(BOTTLE_FIELD.yMin + rand() * (BOTTLE_FIELD.yMax - BOTTLE_FIELD.yMin)).toFixed(2),
    z: +(Math.sin(th) * r).toFixed(2),
    note: BOTTLE_NOTES[Math.floor(rand() * BOTTLE_NOTES.length)],
  };
}

/** Have they already found today's? Guests have no account to remember it on. */
function bottleFound(p) {
  const rec = recordFor(p);
  return !!rec && rec.bottleDay === progress.dayKey();
}

function sendBottle(p) {
  const b = bottleFor(clock.day);
  sendTo(p, { t: 'bottle', day: b.day, x: b.x, y: b.y, z: b.z, found: bottleFound(p), reach: BOTTLE_REACH });
}

function findBottle(p) {
  if (p.room !== DRIFT_ROOM) return;
  const b = bottleFor(clock.day);
  // Validated against the position they are already broadcasting: no "I got it"
  // from the surface. A refused claim is answered with the bottle's state, or
  // the room would leave a bottle nobody is allowed to open floating there.
  if (Math.hypot(p.x - b.x, (p.y || 0) - b.y, p.z - b.z) > BOTTLE_REACH) { sendBottle(p); return; }
  if (!p.registered) {
    sendTo(p, { t: 'toast', msg: 'Sign up to keep what you find down here!' });
    sendBottle(p);
    return;
  }
  const rec = recordFor(p);
  if (!rec || rec.bottleDay === progress.dayKey()) { sendBottle(p); return; }
  rec.bottleDay = progress.dayKey();
  saveSoon();
  const paid = grantCoins(p, BOTTLE_COINS, 'message in a bottle');
  // The finder alone: the note is theirs, and the bottle is per account, so
  // telling the room would clear a bottle their neighbours can still open.
  sendTo(p, { t: 'bottle-found', ok: true, id: p.id, by: p.name, note: b.note, coins: paid, day: b.day });
  signal('bottle', p, { day: b.day, coins: paid });
}

// ---------- C. riding Big Blue ----------
// The ride flag rides along in the move frame (the client sets it when it
// parents its capy to the whale). The server passes it through so remotes can
// parent too, and counts the pod for the progression module.

function ridersIn(roomId) {
  let n = 0;
  for (const id of world.rooms.get(roomId) || []) {
    const other = world.players.get(id);
    if (other && other.ride) n++;
  }
  return n;
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
    log.frameIn();
    if (t0 - msgWindow > 1000) { msgWindow = t0; msgCount = 0; }
    if (++msgCount > MSG_BURST_LIMIT) { log.frameDrop(); try { ws.close(1008, 'Slow down'); } catch {} return; }

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // "null", "5" and "[]" all parse fine; reading m.t off them throws outside
    // the try below, which would surface as an uncaughtException per bad frame
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (!p && m.t !== 'hello') return;

    // One bad frame must never take the process down with it.
    try {
      // progression module (server/progress.js) gets first refusal on frames
      // it owns (quest-*, stamp-* etc.); everything else falls through
      // admin gets FIRST refusal: mute/ban pre-emption and every a-* op happen
      // here, before any feature handler can see the frame
      if (p && admin.handleMessage(p, m)) return;
      // order is load-bearing: a muted player's line died above and must never
      // be logged as something they said; observe never consumes
      if (p) chatlog.observe(p, m);
      if (p && reports.handleMessage(p, m)) return;
      if (p && layouts.handleMessage(p, m)) return;
      if (p && progress.handleMessage(p, m)) return;
      // wave 12 (verifier-required): opening the sled game takes you off the
      // gate board BEFORE econ consumes the frame, so a pair countdown can
      // never deal a race to a rider already halfway down the mountain.
      if (p && m.t === 'mgstart' && m.game === 'sled') removeFromLobby(p);
      // wave 11: econ owns the run token. It consumes 'mgstart' and nothing else.
      if (p && econ.handleMessage(p, m)) return;
      switch (m.t) {
        case 'hello': {
          if (p) return;
          let profile = null;
          let username = null;
          if (m.token) {
            username = verifyToken(m.token);
            if (!username) return sendTo({ ws }, { t: 'denied', msg: 'Session expired, log in again' });
            const rec = users.get(username.toLowerCase());
            if (rec) {
              markSeen(rec);
              // banMessage always returns a line (even "not banned"); gate on
              // banActive FIRST or every clean login is denied
              const banned = banActive(rec) ? (admin.banMessage?.(rec) || 'This account is banned') : null;
              if (banned) return sendTo({ ws }, { t: 'denied', msg: banned });
            }
            profile = publicProfile(rec);
            // the den editor needs the inventory from the first frame; a copy,
            // never the live record object (two tabs would share one map)
            profile.ownedFurniture = { ...ensureOwnedFurniture(rec) };
          } else {
            const name = cleanName(m.guestName);
            if (name.length < NAME_MIN_LEN) return sendTo({ ws }, { t: 'denied', msg: 'Invalid name' });
            // AUDIT F-26: a guest could be called anything. shape:false because
            // cleanName permits spaces/hyphens; the suggestion is offered back.
            const gn = filter.checkName(name, { shape: false, suggest: true });
            if (!gn.ok) return sendTo({ ws }, { t: 'denied', msg: gn.msg, suggestion: gn.suggestion });
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
              // absurdity bound on the client's remembered purse, NOT an
              // earning cap: a guest who really ground past the old 99,999
              // was losing honest coins on every reconnect (owner's law)
              name, coins: Math.max(0, Math.min(9_999_999, Number(m.coins) || 0)),
              color: Number(m.color) || 0xb08a5a,
              hat: has(HATS, m.hat) && ownedHats.includes(m.hat) ? m.hat : 'none',
              ownedHats, bests,
            };
          }
          p = {
            ws, id: `p${nextId++}`, bot: false,
            name: profile.name, username, registered: !!username,
            room: null, x: 0, y: 0, z: 4, rot: 0, anim: 'idle',
            coins: profile.coins, color: profile.color, hat: profile.hat,
            ownedHats: profile.ownedHats, bests: profile.bests,
            lastChat: 0, joinWindow: 0, joinCount: 0, run: null, earned: [],
            socialWindow: 0, socialCount: 0, race: null,
            table: null, match: null, matchWindow: 0, matchCount: 0,
            ph: null, phWindow: 0, phCount: 0,
            dd: null, ddWindow: 0, ddCount: 0, ddGuessWindow: 0, ddGuessCount: 0,
            // wave 7: the shared world (snowball + ball throttles, the bonfire's
            // observed dwell and nightly cap, the whale-ride flag)
            ride: false, snowAt: 0, ballAt: 0,
            bonfireMs: 0, bonfireDay: -1, bonfireCoins: 0,
            // the milestone title, cached on the connection so snapshotFor
            // never has to reach into the user record on the movement tick
            title: typeof profile.title === 'string' ? profile.title : '',
          };
          world.players.set(p.id, p);
          sendTo(p, { t: 'welcome', id: p.id, profile: { ...profile, registered: p.registered } });
          // the sky and any party in progress travel with the welcome: a client
          // that joins mid-evening must not open at noon and snap
          sendTo(p, clockFrame());
          sendTo(p, partiesFrame());
          // wave 12: the island's pulse and your friends' whereabouts arrive
          // with the welcome, and your friends hear that you are on
          sendTo(p, popFrame());
          {
            const rec0 = recordFor(p);
            if (rec0) sendTo(p, fpresenceFrame(rec0));
          }
          pushPresenceAbout(p);
          log.info('ws.connect', { id: p.id, name: p.name, account: p.registered, online: world.players.size });
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
          // height only matters where there is no ground to raycast onto (The
          // Drift), but it costs nothing to carry and older clients omit it
          p.y = Math.max(-40, Math.min(40, Number(m.y) || 0));
          p.rot = Number(m.rot) || 0;
          if (MOVE_ANIMS.includes(m.anim)) p.anim = m.anim;
          // riding Big Blue: relayed so remotes can parent to her back too, and
          // signalled on the way up only (this frame arrives ten times a second).
          // VERIFIER FIX (wave 7): the flag is STICKY. src/world/rooms/drift.js
          // pushes one flagged frame on mount ({ride:1}) and one on dismount
          // ({ride:0}), but the net client's own 10Hz move frames carry no
          // `ride` key at all. Reading a missing key as false cleared the flag
          // ~100ms after every mount, so ridersIn() could never see more than
          // the one capy who had just climbed on and the "Pod" stamp (four
          // riders at once) was unreachable. A frame that does not mention the
          // flag now leaves it alone; joinRoom() still clears it on every move
          // between rooms, so it can never leak out of The Drift.
          const ride = (has(m, 'ride') ? !!m.ride : !!p.ride) && p.room === DRIFT_ROOM;
          if (ride !== !!p.ride) {
            p.ride = ride;
            if (ride) signal('whale-ride', p, { riders: ridersIn(p.room) });
          }
          break;
        }
        case 'chat': {
          const now = Date.now();
          if (now - p.lastChat < 400) return;
          p.lastChat = now;
          const text = String(m.text || '').slice(0, CHAT_MAX_LEN).trim();
          if (!text) return;
          const f = filter.check(text);
          if (!f.ok) return sendTo(p, { t: 'toast', msg: f.msg });
          if (f.changed) chatlog.context?.(p, { severity: f.severity, hits: f.hits });
          broadcastToRoom(p.room, { t: 'chat', id: p.id, name: p.name, text: f.cleaned }, p.id);
          signal('chat', p, { room: p.room });
          break;
        }
        case 'whisper': {
          // private line to one online player, any room. Same throttle as chat.
          const now = Date.now();
          if (now - p.lastChat < 400) return;
          p.lastChat = now;
          let text = String(m.text || '').slice(0, CHAT_MAX_LEN).trim();
          const toName = String(m.to || '').trim().toLowerCase();
          if (!text || !toName) return;
          const fw = filter.check(text);
          if (!fw.ok) return sendTo(p, { t: 'toast', msg: fw.msg });
          // echo the cleaned text to the sender too, or they cannot tell they
          // were masked
          text = fw.cleaned;
          const target = [...world.players.values()].find((q) => !q.bot && q.name.toLowerCase() === toName);
          if (!target) return sendTo(p, { t: 'toast', msg: 'Nobody by that name is in the cove right now' });
          if (target.id === p.id) return sendTo(p, { t: 'toast', msg: 'Whispering to yourself is free, out loud' });
          sendTo(target, { t: 'whisper', from: p.name, text });
          sendTo(p, { t: 'whisper', to: target.name, text }); // sender echo
          chatlog.whisper(p, target, text); // recipient's ring holds it too
          break;
        }
        case 'emote':
          if (['wave', 'dance', 'groove'].includes(m.kind)) {
            if (m.kind === 'dance') p.anim = p.anim === 'dance' ? 'idle' : 'dance';
            broadcastToRoom(p.room, { t: 'emote', id: p.id, kind: m.kind }, p.id);
            if (m.kind === 'wave') signal('wave', p, { room: p.room });
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
        // wave 11: 'mgstart' never reaches this switch (econ.handleMessage
        // consumed it above; the run token now lives in server/econ.js).
        case 'score': {
          // econ owns the run token: it toasts and audits its own refusals, so
          // there is exactly one thing to check here.
          const claim = econ.claimRun(p, m);
          if (!claim.ok) break;
          const paid = grantCoins(p, clampCoinsForGame(m.game, Number(m.coins) || 0), m.game);
          // N-19: the personal best rode the token and is written only now,
          // against a run the coin road actually accepted - and never above
          // the score that run itself claimed (a best IS a score this run hit)
          const runScore = Math.floor(Number(m.score) || 0);
          if (claim.best > (p.bests[m.game] || 0) && claim.best < 10_000_000
            && (runScore <= 0 || claim.best <= runScore)) {
            p.bests[m.game] = claim.best;
            persist(p);
          }
          // the quest board only ever sees a run the coin road already accepted
          signal('score', p, { game: m.game, coins: paid, score: runScore });
          break;
        }
        case 'best': {
          // econ validates the game, the range and the run behind it; a best
          // sent mid-run is PARKED and written by 'score' once the run is paid.
          const noted = econ.noteBest(p, m);
          if (!noted.ok) break;
          if (noted.score > (p.bests[m.game] || 0)) {
            p.bests[m.game] = noted.score;
            persist(p);
          }
          break;
        }
        case 'buy': {
          const hat = has(HATS, m.hat) ? HATS[m.hat] : null;
          if (!hat || !Number.isFinite(hat.price)) return sendTo(p, { t: 'shop', ok: false, msg: 'Unknown hat' });
          // VERIFIER FIX (wave 7): stamp-album cosmetics carry price 0 so the
          // catalogue can list them, and src/ui/shop.js hides them until owned.
          // Nothing on the WIRE was stopping a scripted client from buying one
          // for nothing, which is the whole exclusivity of the milestone track
          // (docs/LIVING-COVE.md section D: "cosmetics that coins cannot buy").
          if (hat.milestone) {
            return sendTo(p, { t: 'shop', ok: false, msg: 'That one is earned, not bought. Fill your stamp album!' });
          }
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
            // the 40-stamp milestone title, so the card shows what the name tag
            // shows (src/ui/profile.js prefers it over its own flavour line)
            title: (!target.bot && typeof rec?.title === 'string' && rec.title) || '',
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
          // same rule as the milestone hats above: the gramophone is a 20-stamp
          // reward, and a 0-coin price tag must not become a 0-coin purchase
          if (item.milestone) {
            return sendTo(p, { t: 'furn', ok: false, msg: 'That one is earned, not bought. Fill your stamp album!' });
          }
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
        case 'lobby-start':
          // wave 12: anyone signed on the board can start a pair race now
          if (socialLimited(p, t0)) break;
          if (sledLobby.includes(p.id) && sledLobby.length >= 2) {
            if (lobbyStartTimer) { clearTimeout(lobbyStartTimer); lobbyStartTimer = null; }
            lobbyStartAt = 0;
            broadcastLobby(true);
            try { startRace(); } catch (e) { console.error('[race] start failed:', e?.message || e); }
          }
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
          econ.matchMove(p); // a winner who never touched the board is not one
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

        // ---- Prop Hunt (the mine) -------------------------------------------
        case 'ph-join':
          if (socialLimited(p, t0)) break;
          joinParty(p, partyLobbies.prophunt);
          break;
        case 'ph-leave':
          if (socialLimited(p, t0)) break;
          exitPropHunt(p); // the board, and a round in progress if there is one
          break;
        case 'ph-msg': {
          // hot path: a seeker sends one of these most frames, so it gets its
          // own budget rather than the social one, and nothing it carries is
          // read here or seen by anyone outside the round
          const round = p.ph;
          if (!round || round.ended) break;
          if (t0 - p.phWindow > 1000) { p.phWindow = t0; p.phCount = 0; }
          if (++p.phCount > PH_MSG_LIMIT) break;
          // the client's envelope field is 'm' (see the contract block at the
          // top of src/minigames/games/prophunt.js); 'data' stays accepted so
          // an older client is not cut off mid-round
          const payload = m.m !== undefined ? m.m : m.data;
          if (payload === undefined) break;
          let size = 0;
          try { size = JSON.stringify(payload).length; } catch { break; }
          if (!size || size > PH_MSG_MAX) break;
          relayPropHunt(round, p.id, payload);
          break;
        }
        case 'ph-done': {
          const round = p.ph;
          const r = round?.players.get(p.id);
          if (!round || round.ended || !r || r.done) break; // one score per capy
          r.score = Math.max(0, Math.min(10_000_000, Math.floor(Number(m.score) || 0)));
          r.done = true;
          if ([...round.players.values()].every((x) => x.done)) endPropHunt(round);
          break;
        }

        // ---- Capy Doodles (the jungle) --------------------------------------
        case 'dd-join':
          if (socialLimited(p, t0)) break;
          joinParty(p, partyLobbies.doodle);
          break;
        case 'dd-leave':
          if (socialLimited(p, t0)) break;
          exitDoodle(p);
          break;
        case 'dd-pick': {
          const g = p.dd;
          if (!g || g.ended || g.phase !== 'pick' || g.drawerId !== p.id) break;
          // The index is the contract, but a drawer's screen and this list
          // disagreeing is the one failure this game cannot survive: they draw
          // one word while every guess is scored against another. If the frame
          // also NAMES a word and we offered it, the name wins over the index.
          // (Belt and braces: the client no longer shows a word it invented,
          // and it renders the word from the state frame this call produces.)
          let i = Math.floor(Number(m.i) || 0);
          const named = typeof m.word === 'string' ? normalizeWord(m.word.slice(0, 40)) : '';
          if (named) {
            const j = g.choices.findIndex((w) => normalizeWord(w) === named);
            if (j >= 0) i = j;
          }
          beginDoodleDrawing(g, i);
          break;
        }
        case 'dd-stroke': {
          // hot path, like ph-msg: batched brush segments, relayed unread
          const g = p.dd;
          if (!g || g.ended || g.phase !== 'draw' || g.drawerId !== p.id) break;
          if (t0 - p.ddWindow > 1000) { p.ddWindow = t0; p.ddCount = 0; }
          if (++p.ddCount > DD_STROKE_LIMIT) break;
          // undo and clear are strokes too: they carry no points, and dropping
          // them leaves every guesser looking at a drawing the drawer erased
          const op = m.op === 'undo' || m.op === 'clear' ? m.op : null;
          if (!op && m.pts === undefined) break;
          let raw;
          if (op) {
            raw = JSON.stringify({ t: 'dd-stroke', from: p.id, op });
          } else {
            let size = 0;
            try { size = JSON.stringify(m.pts).length; } catch { break; }
            if (!size || size > DD_STROKE_MAX) break;
            // colour, width, stroke id and the end flag all have to survive the
            // hop or the relayed drawing is one black hairline with no breaks
            raw = JSON.stringify({
              t: 'dd-stroke', from: p.id, pts: m.pts,
              s: Math.floor(Number(m.s) || 0),
              c: Math.floor(Number(m.c) || 0),
              w: Math.floor(Number(m.w) || 0),
              e: m.e ? 1 : 0,
            });
          }
          for (const other of doodleMembers(g)) {
            if (other.id !== p.id && other.ws?.readyState === 1) other.ws.send(raw);
          }
          break;
        }
        case 'dd-guess': {
          const g = p.dd;
          if (!g || g.ended || g.phase !== 'draw' || !g.word) break;
          if (p.id === g.drawerId || g.guessed.has(p.id)) break; // no second bite
          if (t0 - p.ddGuessWindow > 1000) { p.ddGuessWindow = t0; p.ddGuessCount = 0; }
          if (++p.ddGuessCount > DD_GUESS_LIMIT) break;
          // dropped silently, no toast: a doodle guess is timed and a refusal
          // toast would leak that the guess was even sent
          if (!filter.check(String(m.text || '')).ok) break;
          const guess = normalizeWord(String(m.text || '').slice(0, CHAT_MAX_LEN));
          if (!guess) break;
          if (guess === g.norm) {
            scoreDoodleGuess(g, p);
          } else if (editDistance(guess, g.norm, 1) <= 1) {
            // One letter out. The nudge goes to the guesser and nobody else, or
            // the room would triangulate the word off someone else's near miss.
            // It rides a 'close' dd-state rather than a frame of its own: the
            // protocol registry has no dd-close, and a raw-re-emitted dd-state
            // is exactly what the round UI is already listening to.
            sendTo(p, { t: 'dd-state', close: true, round: g.round });
          }
          // A wrong guess is answered with silence: the round's guess box is not
          // a second chat channel, so nothing unmoderated fans out from here.
          break;
        }
        case 'dd-vote': {
          // majority skip-drawer vote (wave 10D): guessers only, one vote each,
          // strict majority of CURRENT guessers so a walkout does not wedge it
          const g = p.dd;
          if (!g || g.ended || g.phase !== 'draw' || p.id === g.drawerId) break;
          if (socialLimited(p, t0)) break;
          if (!m.skip) break;
          if (g.skips.has(p.id)) break;
          g.skips.add(p.id);
          const guessers = doodleMembers(g).filter((q) => q.id !== g.drawerId);
          const of = guessers.length;
          const need = Math.floor(of / 2) + 1;
          let votes = 0;
          for (const q of guessers) if (g.skips.has(q.id)) votes++;
          const passed = votes >= need;
          broadcastDoodle(g, { t: 'dd-vote', round: g.round, votes, need, of, id: p.id, name: p.name, passed });
          if (passed) revealDoodle(g, 'skipped');
          break;
        }

        // ---- the Social Cove (wave 7) ---------------------------------------
        // Play toys carry their own throttles (a snowball is one a second, a bop
        // is a swing not a stream); everything that writes a record or fans out
        // island-wide takes the social budget.
        case 'snow':
          throwSnowball(p, m, t0);
          break;
        case 'ball':
          bopBall(p, m, t0);
          break;
        case 'party-start':
          if (socialLimited(p, t0)) break;
          startPartyEvent(p, m);
          break;
        case 'party-end': {
          if (socialLimited(p, t0)) break;
          // only your own party is yours to call off
          const key = p.username ? p.username.toLowerCase() : null;
          if (!key) break;
          for (const party of [...parties.values()]) {
            if (party.hostKey === key) endPartyEvent(party, 'host-ended');
          }
          break;
        }
        case 'party':
          if (socialLimited(p, t0)) break;
          sendTo(p, partiesFrame());
          break;
        case 'mural':
          if (socialLimited(p, t0)) break;
          paintMural(p, m, t0);
          break;
        case 'mural-grid':
          if (socialLimited(p, t0)) break;
          sendMuralGrid(p);
          break;
        case 'mural-report':
          if (socialLimited(p, t0)) break;
          // absorbed into the wave-10 report queue (old reportMural retired)
          reports.mural(p, { w: MURAL_W, h: MURAL_H, rle: muralRLE(), recent: mural.ops.slice(-400) }, t0);
          break;
        case 'bottle':
          if (socialLimited(p, t0)) break;
          sendBottle(p);
          break;
        case 'bottle-found':
          if (socialLimited(p, t0)) break;
          findBottle(p);
          break;
      }
    } catch (e) {
      console.error(`[ws] handler error on '${m.t}':`, e?.message || e);
    }
  });

  ws.on('close', () => {
    if (p) {
      persist(p);
      leaveWorld(p);
      log.info('ws.disconnect', { id: p.id, name: p.name, room: p.room, online: world.players.size });
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
process.on('uncaughtException', (e) => {
  log.error('fatal.uncaught', e);
  try {
    audit.log({ actor: null, via: 'system', op: audit.OPS.SERVER_UNCAUGHT, args: { name: e?.name || 'Error', at: String(e?.stack || e).slice(0, 800) }, ok: false });
    audit.flush();
    layouts.flush();
    flush();
  } catch {}
});
process.on('unhandledRejection', (e) => log.error('fatal.rejection', e));

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
    // y and ride only ride along where they exist (The Drift): everywhere else
    // the client raycasts the ground itself and these would be dead weight
    const players = roomSnapshot(roomId).map(({ id, x, y, z, rot, anim, ride }) => (
      y === undefined && ride === undefined
        ? { id, x, z, rot, anim }
        : { id, x, y, z, rot, anim, ride }
    ));
    if (players.length) broadcastToRoom(roomId, { t: 'state', players });
  }
}, NET_TICK_MS);

// ---------- tick: the mine pays its miners ----------
setInterval(() => {
  try { digTick(); } catch (e) { console.error('[mine] dig tick failed:', e?.message || e); }
}, DIG_TICK_MS);

// ---------- tick: the world clock (wave 7) ----------
// One interval for everything that moves on cove time: the sky goes out to the
// island, the bonfire pays whoever is sitting at it, parties expire, the
// citizens get the hour, and the progression module gets its rollover beat.
updateClock();
bots.setClock(clock); // the citizens' schedules run on cove time from boot
// ...and so does the quest board. VERIFIER FIX (wave 7): server/progress.js
// derives the cove-day index from the epoch until a clock frame reaches it, and
// only tick() carries one. Without this priming call, every board handed out in
// the first CLOCK_MS of uptime is seeded against that fallback day and then
// silently rerolls (losing any progress on it) on the first tick. The two agree
// on production settings, so the window was invisible until a test moved the
// day length; priming closes it for good, on any settings.
try { progress.tick(0, clockFrame()); } catch (e) {
  console.error('[progress] clock priming failed:', e?.message || e);
}
setInterval(() => {
  try {
    updateClock();
    broadcastAll(clockFrame());
    bots.setClock(clock);
    bonfireTick(CLOCK_MS);
    partyTick(Date.now());
    // a painter half an hour past their cooldown is not waiting on anything any
    // more, and their entry would otherwise sit in the map forever
    const stale = Date.now() - 30 * 60_000;
    for (const [key, at] of mural.painters) if (at < stale) mural.painters.delete(key);
    for (const [key, at] of mural.reports) if (at < stale) mural.reports.delete(key);
  } catch (e) {
    console.error('[clock] tick failed:', e?.message || e);
  }
  try { progress.tick(CLOCK_MS / 1000, clockFrame()); } catch (e) {
    console.error('[progress] tick failed:', e?.message || e);
  }
}, CLOCK_MS);

// ---------- tick: co-presence pulse (wave 12) ----------
// Room populations + lobby fill to everyone every 5s. Cheap: one small frame,
// counts only humans, and the map/HUD simply repaint what arrives.
setInterval(() => {
  try { if (world.players.size) broadcastAll(popFrame()); } catch (e) {
    console.error('[pop] tick failed:', e?.message || e);
  }
}, 5_000);

// ---------- tick: the beach ball (wave 7) ----------
setInterval(() => {
  try { ballTick(); } catch (e) { console.error('[ball] tick failed:', e?.message || e); }
}, BALL_TICK_MS);

server.listen(PORT, () => {
  console.log(`Capy Cove server on http://localhost:${PORT} (rooms: ${ROOM_IDS.join(', ')}, default: ${DEFAULT_ROOM})`);
});
