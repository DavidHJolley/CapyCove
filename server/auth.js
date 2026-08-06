import crypto from 'node:crypto';
import { users, saveSoon, getSecret } from './db.js';
import { NAME_MAX_LEN, NAME_MIN_LEN } from '../shared/constants.js';

const SECRET = getSecret();
const NAME_RE = new RegExp(`^[a-zA-Z0-9_]{${NAME_MIN_LEN},${NAME_MAX_LEN}}$`);
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function makeToken(username) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = `${username}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [username, exp, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(`${username}.${exp}`).digest('hex');
  // Compare BYTE lengths of the buffers we hand to timingSafeEqual: a string
  // length check passes for multi-byte UTF-8 signatures and timingSafeEqual
  // then throws RangeError, which would kill the process from the ws handler.
  const got = Buffer.from(sig);
  const want = Buffer.from(expect);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  if (Number(exp) < Date.now()) return null;
  return users.has(username.toLowerCase()) ? username : null;
}

export function publicProfile(rec) {
  return {
    name: rec.username,
    coins: rec.coins,
    color: rec.color,
    hat: rec.hat,
    // copies, never the live record arrays/objects: two sessions on one account
    // used to share a single ownedHats reference (free hats + coin rollback).
    ownedHats: [...(rec.ownedHats || ['none'])],
    bests: { ...(rec.bests || {}) },
  };
}

export function signup({ username, password, color, hat }) {
  if (!NAME_RE.test(username || '')) return { ok: false, msg: 'Name: 3-16 letters, numbers or _' };
  if (typeof password !== 'string' || password.length < 6) return { ok: false, msg: 'Password too short (6+)' };
  const key = username.toLowerCase();
  if (users.has(key)) return { ok: false, msg: 'That name is taken' };
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = {
    username,
    salt,
    hash: scryptHash(password, salt),
    coins: 100, // welcome gift
    color: Number(color) || 0xb08a5a,
    hat: 'none',
    ownedHats: ['none'],
    bests: {},
    created: Date.now(),
  };
  if (typeof hat === 'string' && hat === 'none') rec.hat = hat;
  users.set(key, rec);
  saveSoon();
  return { ok: true, token: makeToken(username), profile: publicProfile(rec) };
}

export function login({ username, password }) {
  const rec = users.get(String(username || '').toLowerCase());
  if (!rec) return { ok: false, msg: 'Unknown name or wrong password' };
  const hash = Buffer.from(scryptHash(String(password || ''), rec.salt));
  const want = Buffer.from(String(rec.hash || ''));
  if (hash.length !== want.length || !crypto.timingSafeEqual(hash, want)) {
    return { ok: false, msg: 'Unknown name or wrong password' };
  }
  return { ok: true, token: makeToken(rec.username), profile: publicProfile(rec) };
}
