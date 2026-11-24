// Accounts, sessions and each account's synced board data, kept in one JSON file (data/accounts.json).
// Passwords are stored as scrypt hashes. Session tokens are stored as SHA-256 hashes, so the file alone
// can't be used to sign in. Both survive a server restart.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const SESSION_DAYS = 30;
export const MAX_ACCOUNTS = 20;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
const MAX_KEYS = 500;
const MAX_VALUE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 900_000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function hashPassword(password, saltHex = randomBytes(16).toString('hex')) {
  const hash = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  return { salt: saltHex, hash: hash.toString('hex') };
}

export class AccountError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createAccounts({ dir, signupOpen = true } = {}) {
  const file = path.join(dir, 'accounts.json');
  let db = { users: {}, sessions: {} };
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      db = { users: raw.users || {}, sessions: raw.sessions || {} };
    } catch (err) {
      throw new Error(`Can't read ${file}: ${err.message}. Fix or move that file and start again.`);
    }
  }

  function persist() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    renameSync(tmp, file); // replaced in one step, so a crash can't leave half a file
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [id, s] of Object.entries(db.sessions)) if (s.expires < now || !db.users[s.user]) delete db.sessions[id];
  }

  function startSession(userKey) {
    pruneSessions();
    const token = randomBytes(32).toString('base64url');
    db.sessions[sha256(token)] = { user: userKey, expires: Date.now() + SESSION_DAYS * 86_400_000 };
    persist();
    return token;
  }

  // A hash to compare against when the username doesn't exist, so a wrong name and a wrong password take equally long.
  const dummy = hashPassword('not-a-real-password');

  return {
    signupOpen,

    async signup(username, password) {
      if (!signupOpen) throw new AccountError(403, 'Creating accounts is turned off on this server.');
      checkCredentialsShape(username, password);
      if (!USERNAME_RE.test(username)) throw new AccountError(400, 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
      if (password.length < PASSWORD_MIN) throw new AccountError(400, `Passwords need at least ${PASSWORD_MIN} characters.`);
      const key = username.toLowerCase();
      if (db.users[key]) throw new AccountError(409, 'That username is taken.');
      if (Object.keys(db.users).length >= MAX_ACCOUNTS) throw new AccountError(403, 'This server has reached its account limit.');
      const { salt, hash } = await hashPassword(password);
      if (db.users[key]) throw new AccountError(409, 'That username is taken.'); // another signup finished meanwhile
      db.users[key] = { name: username, salt, hash, createdAt: Date.now(), rev: 0, data: {}, updatedAt: 0 };
      return { user: username, token: startSession(key) };
    },

    async login(username, password) {
      checkCredentialsShape(username, password);
      const key = username.toLowerCase();
      const u = db.users[key];
      const { salt, hash } = u ? u : await dummy;
      const attempt = (await hashPassword(password.slice(0, PASSWORD_MAX), salt)).hash;
      const ok = timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex')) && !!u;
      if (!ok) throw new AccountError(401, 'Wrong username or password.');
      return { user: u.name, token: startSession(key) };
    },

    logout(token) {
      if (!token) return;
      delete db.sessions[sha256(token)];
      persist();
    },

    // The account a session token belongs to, or null.
    userFor(token) {
      if (!token) return null;
      const s = db.sessions[sha256(token)];
      if (!s || s.expires < Date.now()) return null;
      return db.users[s.user] ? s.user : null;
    },
    name: (userKey) => db.users[userKey]?.name ?? null,

    getData(userKey) {
      const u = db.users[userKey];
      return { rev: u.rev, data: u.data };
    },

    setData(userKey, data) {
      const clean = validateData(data);
      const u = db.users[userKey];
      u.data = clean;
      u.rev += 1;
      u.updatedAt = Date.now();
      persist();
      return { rev: u.rev };
    },
  };
}

function checkCredentialsShape(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') throw new AccountError(400, 'Enter a username and password.');
  if (username.length > 64 || password.length > PASSWORD_MAX) throw new AccountError(400, 'That username or password is too long.');
}

// What gets synced: the page's saved settings, as { "pd.tabs": "<json string>", ... }.
function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AccountError(400, 'Nothing to save.');
  const entries = Object.entries(data);
  if (entries.length > MAX_KEYS) throw new AccountError(413, 'Too many saved settings.');
  const clean = {};
  let total = 0;
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !k.startsWith('pd.') || k.length > 200) throw new AccountError(400, 'Unexpected data.');
    if (v.length > MAX_VALUE_CHARS) throw new AccountError(413, 'A saved setting is too large.');
    total += k.length + v.length;
    clean[k] = v;
  }
  if (total > MAX_TOTAL_CHARS) throw new AccountError(413, 'Your saved data is too large to sync.');
  return clean;
}
