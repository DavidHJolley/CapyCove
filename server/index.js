import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { users, saveSoon } from './db.js';
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
  if (p.room) {
    world.rooms.get(p.room)?.delete(p.id);
    broadcastToRoom(p.room, { t: 'pleave', id: p.id });
  }
  p.room = roomId;
  world.rooms.get(roomId).add(p.id);
  sendTo(p, { t: 'room', room: roomId, players: roomSnapshot(roomId) });
  broadcastToRoom(roomId, { t: 'pjoin', p: snapshotFor(p) }, p.id);
}

function leaveWorld(p) {
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
          if (['idle', 'walk', 'dance'].includes(m.anim)) p.anim = m.anim;
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
          const payout = clampCoinsForGame(m.game, Number(m.coins) || 0);
          if (payout <= 0) break;
          p.earned = p.earned.filter((e) => t0 - e.t < 3_600_000);
          if (p.earned.reduce((a, e) => a + e.n, 0) + payout > MAX_COINS_PER_HOUR) break;
          p.earned.push({ t: t0, n: payout });
          const rec = recordFor(p);
          const bal = rec ? rec.coins : p.coins;
          const next = Math.max(0, Math.min(9_999_999, (Number.isFinite(bal) ? bal : 0) + payout));
          if (rec) rec.coins = next;
          p.coins = next;
          persist(p);
          sendTo(p, { t: 'coins', coins: p.coins, delta: payout, reason: m.game });
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
