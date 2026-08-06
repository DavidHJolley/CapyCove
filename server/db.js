import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tiny flat-file persistence: data/users.json + data/secret.txt.
// Fine for a small community server; swap for a real DB if it grows.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const users = new Map(); // usernameLower -> record
try {
  if (fs.existsSync(USERS_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')))) users.set(k, v);
  }
} catch (e) {
  console.error('[db] failed to load users:', e.message);
}

let saveTimer = null;
export function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(Object.fromEntries(users), null, 1));
    } catch (e) {
      console.error('[db] save failed:', e.message);
    }
  }, 500);
}

export function getSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {}
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  try { fs.writeFileSync(SECRET_FILE, secret); } catch (e) { console.error('[db] secret save failed:', e.message); }
  return secret;
}
